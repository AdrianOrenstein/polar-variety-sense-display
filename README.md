# polar-display

Real-time biometric dashboard for **Polar Verity Sense** optical heart rate sensor. Streams PPG (photoplethysmography), accelerometer, gyroscope, and heart rate data via WebSocket to an interactive web interface with live signal processing and BPM estimation.

![Dashboard](https://img.shields.io/badge/Python-3.14-blue.svg) ![License](https://img.shields.io/badge/license-MIT-green.svg)

## Demo

https://github.com/user-attachments/assets/bf3000d3-d294-4421-9aee-70d0376f0888

## Installation

```bash
# Clone repository
git clone https://github.com/adrianorenstein/polar-web.git
cd polar-web

# Setup Python environment and install dependencies
make venv

# Run server (auto-opens browser)
make run
```

## Usage

1. **Power on** your Polar Verity Sense device
2. **Run server**: `make run` or `python server.py`
3. **Browser**: Dashboard auto-opens at `http://localhost:8766`
4. **Connect**: Server scans and automatically connects to the Polar device

The server will:
- Scan for Bluetooth devices matching "Polar Sense"
- Establish connection and subscribe to PPG, HR, ACC, GYRO streams
- Process PPG data every 1 second (requires ≥4 sec buffer)

**Stop server**: `Ctrl+C`

## Architecture

```
Polar Verity Sense (BLE, 55 Hz PPG)
    ↓
server.py (Python asyncio)
    ├─ Bleak (BLE client)
    ├─ pypg (signal processing)
    │   └─ Chebyshev II bandpass → peak detection → BPM
    ├─ WebSocket server (port 8765)
    └─ HTTP server (port 8766)
        ↓
web/index.html + charts.js
    └─ Real-time Canvas rendering
```

## Acknowledgements

- [Polar Verity Sense](https://www.polar.com/us-en/sensors/verity-sense) - Optical HR sensor
- [polar-python](https://github.com/zHElEARN/polar-python) - Polar device BLE library
- [pypg](https://github.com/hpi-dhc/pypg) - PPG signal processing toolkit
