import asyncio
import websockets
import threading
import signal
import json
import os
import time
import webbrowser
from collections import deque
from typing import Union
from aiohttp import web
from bleak import BleakScanner
from rich.console import Console
from rich import inspect
import numpy as np
from scipy import signal as sp_signal
import pypg.filters as ppg_filters
from polar_python.constants import (
    PPIData,
    TIMESTAMP_OFFSET,
    MeasurementSettings,
    SettingType,
    ACCData,
    HRData,
)
from dataclasses import dataclass, asdict


# ---------------------------------------------------------------------------
#  PPG data class & parser  (missing from polar_python)
# ---------------------------------------------------------------------------
@dataclass
class PPGData:
    """Parsed PPG frame – 4 channels per sample, 22-bit resolution."""

    timestamp: int
    channels: int  # number of channels (typically 4)
    samples: list  # list of tuples, one per sample  (ch0, ch1, ch2, ch3)


@dataclass
class GYROData:
    """Parsed GYRO frame – 3 axes (x, y, z) in deg/s."""

    timestamp: int
    data: list  # list of (x, y, z) tuples


@dataclass
class MAGData:
    """Parsed MAG frame – 3 axes (x, y, z) in nT (nanotesla)."""

    timestamp: int
    data: list  # list of (x, y, z) tuples


def parse_ppg_data(data: bytearray) -> PPGData:
    """Parse a raw PMD PPG frame from the Polar Verity Sense.

    Frame layout (uncompressed, frame_type 0x00):
        data[0]       – measurement type index (0x01 = PPG)
        data[1:9]     – timestamp (uint64 LE, nanoseconds since 2000-01-01)
        data[9]       – frame type  (0x00 = raw)
        data[10:]     – sample data: N channels × 3 bytes each (signed 22-bit LE)

    With 4 channels and 22-bit resolution → 4 × 3 = 12 bytes per sample.
    """
    if len(data) < 10:
        return None

    raw_ts = int.from_bytes(data[1:9], byteorder="little", signed=False)
    timestamp = raw_ts + TIMESTAMP_OFFSET
    frame_type = data[9]
    channels = 4  # Verity Sense PPG always 4 channels
    bytes_per_value = 3  # 22-bit resolution → 3 bytes
    bytes_per_sample = channels * bytes_per_value  # 12

    payload = data[10:]
    samples = []

    for offset in range(0, len(payload) - bytes_per_sample + 1, bytes_per_sample):
        values = []
        for ch in range(channels):
            b = offset + ch * bytes_per_value
            # 3-byte signed little-endian → sign-extend from 24-bit
            raw = int.from_bytes(payload[b : b + 3], byteorder="little", signed=True)
            values.append(raw)
        samples.append(tuple(values))

    return PPGData(timestamp=timestamp, channels=channels, samples=samples)


def parse_gyro_data(data: bytearray) -> GYROData:
    """Parse a raw PMD GYRO frame.  Same layout as ACC (3 axes, LE signed)."""
    if len(data) < 10:
        return None

    raw_ts = int.from_bytes(data[1:9], byteorder="little", signed=False)
    timestamp = raw_ts + TIMESTAMP_OFFSET
    frame_type = data[9]
    axes = 3

    # Determine bytes-per-value from frame_type (same convention as ACC)
    actual_type = frame_type & 0x7F
    if actual_type == 0x00:
        step = 1
    elif actual_type == 0x01:
        step = 2
    elif actual_type == 0x02:
        step = 3
    else:
        step = 2  # default

    bytes_per_sample = axes * step
    payload = data[10:]
    samples = []

    for offset in range(0, len(payload) - bytes_per_sample + 1, bytes_per_sample):
        values = []
        for axis in range(axes):
            b = offset + axis * step
            raw = int.from_bytes(payload[b : b + step], byteorder="little", signed=True)
            values.append(raw)
        samples.append(tuple(values))

    return GYROData(timestamp=timestamp, data=samples)


def parse_mag_data(data: bytearray) -> MAGData:
    """Parse a raw PMD MAG frame. Same layout as GYRO (3 axes, LE signed)."""
    if len(data) < 10:
        return None

    raw_ts = int.from_bytes(data[1:9], byteorder="little", signed=False)
    timestamp = raw_ts + TIMESTAMP_OFFSET
    frame_type = data[9]
    axes = 3

    # Determine bytes-per-value from frame_type
    actual_type = frame_type & 0x7F
    if actual_type == 0x00:
        step = 1
    elif actual_type == 0x01:
        step = 2
    elif actual_type == 0x02:
        step = 3
    else:
        step = 2  # default

    bytes_per_sample = axes * step
    payload = data[10:]
    samples = []

    for offset in range(0, len(payload) - bytes_per_sample + 1, bytes_per_sample):
        values = []
        for axis in range(axes):
            b = offset + axis * step
            raw = int.from_bytes(payload[b : b + step], byteorder="little", signed=True)
            values.append(raw)
        samples.append(tuple(values))

    return MAGData(timestamp=timestamp, data=samples)


# ---------------------------------------------------------------------------
#  Monkey-patch polar_python to support PPG, GYRO & MAG (BEFORE importing PolarDevice)
# ---------------------------------------------------------------------------
import polar_python.parsers.bluetooth as _bt

_original_parse = _bt.parse_bluetooth_data


def _patched_parse_bluetooth_data(data):
    """Extended parser that handles PPG, GYRO and MAG in addition to the original types."""
    if len(data) > 0:
        type_idx = data[0]
        if type_idx == 0x01:  # PPG
            return parse_ppg_data(data)
        elif type_idx == 0x05:  # GYRO
            return parse_gyro_data(data)
        elif type_idx == 0x06:  # MAG
            return parse_mag_data(data)
    return _original_parse(data)


_bt.parse_bluetooth_data = _patched_parse_bluetooth_data

# Also patch in utils and parsers modules to ensure all references are updated
import polar_python.utils as _utils
import polar_python.parsers as _parsers

_utils.parse_bluetooth_data = _patched_parse_bluetooth_data
_parsers.parse_bluetooth_data = _patched_parse_bluetooth_data

# NOW import PolarDevice after patching
from polar_python import PolarDevice

connected_clients = set()
console = Console()
exit_event = threading.Event()

# ---------------------------------------------------------------------------
#  PPG processing state
# ---------------------------------------------------------------------------
PPG_FS = 55
PPG_WINDOW_SEC = 10
PPG_MIN_SEC = 4
PPG_PROCESS_EVERY_SEC = 1.0
ppg_buffer = deque(maxlen=PPG_FS * PPG_WINDOW_SEC)
last_ppg_process = 0.0


async def handle(request):
    filename = request.match_info.get("filename", "index.html")
    if filename == "" or filename == "favicon.ico":
        filename = "index.html"
    file_path = os.path.join("./web", filename)
    if os.path.exists(file_path) and os.path.isfile(file_path):
        return web.FileResponse(file_path)
    else:
        raise web.HTTPNotFound()


async def web_main():
    app = web.Application()
    app.router.add_get("/{filename:.*}", handle)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", 8766)
    await site.start()
    webbrowser.open("http://localhost:8766")


def handle_exit(signum, frame):
    console.print("[bold red]Received exit signal[/bold red]")
    exit_event.set()


async def handle_client(websocket):
    connected_clients.add(websocket)
    try:
        async for message in websocket:
            print(f"Received message from client: {message}")
    except websockets.exceptions.ConnectionClosed as e:
        print(f"Client disconnected: {e}")
    finally:
        connected_clients.remove(websocket)


async def broadcast_message(message):
    if connected_clients:
        await asyncio.gather(*[client.send(message) for client in connected_clients])


async def socket_main():
    async with websockets.serve(handle_client, "localhost", 8765):
        while not exit_event.is_set():
            await asyncio.sleep(1)


async def polar_main():
    device = await BleakScanner.find_device_by_filter(
        lambda bd, ad: bd.name and "Polar Sense" in bd.name, timeout=5
    )
    if device is None:
        console.print("[bold red]Device not found[/bold red]")
        return

    inspect(device)

    def serialize_data(data):
        if isinstance(data, dict):
            return data
        try:
            return asdict(data)
        except Exception:
            return getattr(data, "__dict__", {"value": str(data)})

    def heartrate_callback(data: HRData):
        console.print(f"[bold green]Received Data:[/bold green] {data}")
        loop = asyncio.get_event_loop()
        loop.create_task(
            broadcast_message(
                json.dumps({"type": "heartrate", "data": serialize_data(data)})
            )
        )

    def _add_ppg_samples(samples):
        for s in samples:
            ppg_buffer.append(s[0])

    def _process_ppg_and_broadcast(loop):
        global last_ppg_process
        now = time.monotonic()
        if now - last_ppg_process < PPG_PROCESS_EVERY_SEC:
            return
        if len(ppg_buffer) < PPG_FS * PPG_WINDOW_SEC:
            return

        last_ppg_process = now
        try:
            # Process exactly one window of data
            raw = np.asarray(list(ppg_buffer)[-PPG_FS * PPG_WINDOW_SEC :], dtype=float)
            raw = raw - np.mean(raw)

            filtered = ppg_filters.chebyfy(
                raw,
                cutoff_frequencies=[0.5, 8],
                sampling_frequency=PPG_FS,
                filter_type="bandpass",
                filter_order=2,
                band_attenuation=20,
            )

            std = np.std(filtered)
            if std > 0:
                filtered = (filtered - np.mean(filtered)) / std

            peaks, _ = sp_signal.find_peaks(
                filtered,
                distance=int(0.4 * PPG_FS),
                prominence=0.5,
                height=0.0,
            )

            bpm = None
            rr_intervals = []
            if len(peaks) >= 2:
                duration = len(filtered) / PPG_FS
                bpm = round((len(peaks) / duration) * 60, 1)

                # Calculate RR intervals from peak-to-peak intervals
                for i in range(1, len(peaks)):
                    interval_samples = peaks[i] - peaks[i - 1]
                    interval_ms = int((interval_samples / PPG_FS) * 1000)
                    rr_intervals.append(interval_ms)

            payload = {
                "fs": PPG_FS,
                "values": filtered.tolist(),
                "peaks": peaks.tolist(),
                "bpm": bpm,
                "rr_intervals": rr_intervals,
            }

            loop.create_task(
                broadcast_message(
                    json.dumps({"type": "ppg_processed", "data": payload})
                )
            )
        except Exception as exc:
            console.print(f"[bold red]PPG processing error:[/bold red] {exc}")

    def _compute_magnitude(samples):
        """Compute magnitude sqrt(x² + y² + z²) for 3-axis data."""
        if not samples:
            return None
        # Take last sample for real-time magnitude
        last = samples[-1]
        if isinstance(last, (list, tuple)) and len(last) >= 3:
            x, y, z = last[0], last[1], last[2]
            return round(np.sqrt(x**2 + y**2 + z**2), 2)
        return None

    def data_callback(data: Union[ACCData, PPIData, PPGData, GYROData]):
        if data is None:
            return
        if isinstance(data, PPGData):
            data_type = "ppg"
        elif isinstance(data, GYROData):
            data_type = "gyro"
        elif isinstance(data, MAGData):
            data_type = "mag"
        elif isinstance(data, PPIData):
            data_type = "ppi"
        elif isinstance(data, ACCData):
            data_type = "acc"
        elif isinstance(data, dict):
            # polar_python ACC parser returns a plain dict (library bug)
            data_type = "acc"
        else:
            data_type = "unknown"
        console.print(
            f"[bold green]{data_type.upper()}:[/bold green] "
            f"{len(data.get('data', data.get('samples', [])) if isinstance(data, dict) else getattr(data, 'samples', getattr(data, 'data', [])))!s} samples"
        )

        # Serialize data and add magnitude for ACC/GYRO/MAG
        payload = serialize_data(data)
        if data_type in ["acc", "gyro", "mag"]:
            samples = (
                data.get("data", data.get("samples", []))
                if isinstance(data, dict)
                else getattr(data, "data", getattr(data, "samples", []))
            )
            magnitude = _compute_magnitude(samples)
            if magnitude is not None:
                payload["magnitude"] = magnitude

        loop = asyncio.get_event_loop()
        loop.create_task(
            broadcast_message(
                json.dumps(
                    {
                        "type": data_type,
                        "data": payload,
                    }
                )
            )
        )

        if isinstance(data, PPGData):
            _add_ppg_samples(data.samples)
            _process_ppg_and_broadcast(loop)

    async with PolarDevice(device, data_callback, heartrate_callback) as polar_device:
        acc_settings = MeasurementSettings(
            measurement_type="ACC",
            settings=[
                SettingType(type="SAMPLE_RATE", values=[52]),
                SettingType(type="RESOLUTION", values=[16]),
                SettingType(type="RANGE", values=[8]),
                SettingType(type="CHANNELS", values=[3]),
            ],
        )

        ppi_settings = MeasurementSettings(measurement_type="PPI", settings=[])

        ppg_settings = MeasurementSettings(
            measurement_type="PPG",
            settings=[
                SettingType(type="SAMPLE_RATE", values=[55]),
                SettingType(type="RESOLUTION", values=[22]),
                SettingType(type="CHANNELS", values=[4]),
            ],
        )

        gyro_settings = MeasurementSettings(
            measurement_type="GYRO",
            settings=[
                SettingType(type="SAMPLE_RATE", values=[52]),
                SettingType(type="RESOLUTION", values=[16]),
                SettingType(type="RANGE", values=[2000]),
                SettingType(type="CHANNELS", values=[3]),
            ],
        )

        # Query MAG settings supported by device
        # try:
        #     mag_supported = await polar_device.request_stream_settings("MAG")
        #     console.print(
        #         f"[bold cyan]MAG settings supported:[/bold cyan] {mag_supported}"
        #     )
        # except Exception as e:
        #     console.print(f"[bold red]MAG not supported or error:[/bold red] {e}")

        mag_settings = MeasurementSettings(
            measurement_type="MAG",
            settings=[
                SettingType(type="SAMPLE_RATE", values=[50]),
                SettingType(type="RESOLUTION", values=[16]),
                SettingType(type="RANGE", values=[50]),
                SettingType(type="CHANNELS", values=[3]),
            ],
        )

        await polar_device.start_stream(acc_settings)
        await polar_device.start_stream(ppi_settings)
        await polar_device.start_stream(ppg_settings)
        await polar_device.start_stream(gyro_settings)
        await polar_device.start_stream(mag_settings)
        await polar_device.start_heartrate_stream()

        while not exit_event.is_set():
            await asyncio.sleep(1)

        if not os.path.exists("logs"):
            os.makedirs("logs")


async def run():
    signal.signal(signal.SIGINT, handle_exit)
    signal.signal(signal.SIGTERM, handle_exit)
    await asyncio.gather(socket_main(), polar_main(), web_main())


if __name__ == "__main__":
    asyncio.run(run())
