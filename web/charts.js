/**
 * 监测图表基类
 */
class MonitorChart {
  /**
   * @param {HTMLElement} container - 图表容器
   * @param {Array} data - 初始数据
   * @param {number} height - 图表高度
   * @param {number} dataMin - 数据最小值
   * @param {number} dataMax - 数据最大值
   * @param {number} dataSampleRate - 数据采样率
   * @param {string} unit - 单位
   * @param {string[]} lineColors - 线条颜色
   * @param {number} xScale - x轴缩放
   * @param {number} eraseWidth - 擦除宽度
   * @param {Function} extractValues - 提取数据值的函数
   */
  constructor(
    container,
    data,
    height,
    dataMin,
    dataMax,
    dataSampleRate,
    unit,
    lineColors,
    xScale,
    eraseWidth,
    extractValues
  ) {
    this.container = container;
    this.data = data;
    this.height = height;
    this.adjustedHeight = height + 1;
    this.dataMin = dataMin;
    this.dataMax = dataMax;
    this.dataSampleRate = dataSampleRate;
    this.unit = unit;
    this.lineColors = lineColors;
    this.xScale = xScale;
    this.eraseWidth = eraseWidth;
    this.extractValues = extractValues;

    // 引用
    this.drawPosition = 0;
    this.dataIndex = 0;
    this.lastPoints = null;
    this.width = 0;
    this.accumulatedPoints = 0;
    this.lastTimestamp = null;
    this.animationFrameId = null;

    // 创建Canvas元素
    this.createCanvases();

    // 初始化图表
    this.initialize();
  }

  /**
   * 创建Canvas元素
   */
  createCanvases() {
    // 创建背景Canvas
    this.backgroundCanvas = document.createElement("canvas");
    this.backgroundCanvas.style.position = "absolute";
    this.backgroundCanvas.style.top = "0";
    this.backgroundCanvas.style.left = "0";
    this.backgroundCanvas.style.zIndex = "0";
    this.backgroundCanvas.style.width = "100%";
    this.backgroundCanvas.style.height = `${this.adjustedHeight}px`;

    // 创建前景Canvas
    this.canvas = document.createElement("canvas");
    this.canvas.style.position = "absolute";
    this.canvas.style.top = "0";
    this.canvas.style.left = "0";
    this.canvas.style.zIndex = "1";
    this.canvas.style.width = "100%";
    this.canvas.style.height = `${this.adjustedHeight}px`;

    // 添加到容器中
    this.container.style.position = "relative";
    this.container.style.width = "100%";
    this.container.style.height = `${this.adjustedHeight}px`;
    this.container.appendChild(this.backgroundCanvas);
    this.container.appendChild(this.canvas);

    // 获取Canvas上下文
    this.ctx = this.canvas.getContext("2d");
    this.bgCtx = this.backgroundCanvas.getContext("2d");
  }

  /**
   * 重置引用
   */
  resetRefs() {
    this.drawPosition = 0;
    this.dataIndex = 0;
    this.lastPoints = null;
  }

  /**
   * 更新数据
   * @param {Array} newData - 新数据
   */
  updateData(newData) {
    this.data = newData;
    this.dataIndex = 0;
  }

  /**
   * 更新图表高度
   * @param {number} height - 新的图表高度
   */
  updateHeight(height) {
    this.height = height;
    this.adjustedHeight = height + 1;

    // 更新Canvas元素样式
    this.backgroundCanvas.style.height = `${this.adjustedHeight}px`;
    this.canvas.style.height = `${this.adjustedHeight}px`;
    this.container.style.height = `${this.adjustedHeight}px`;

    // 重新初始化图表
    this.initialize();
  }

  /**
   * 初始化图表
   */
  initialize() {
    // 获取canvas的显示尺寸
    this.width = this.canvas.clientWidth;
    const canvasHeight = this.canvas.clientHeight;

    // 初始化Canvas
    initializeCanvas(
      this.canvas,
      this.ctx,
      this.width,
      canvasHeight,
      false,
      undefined,
      () => this.resetRefs()
    );

    initializeCanvas(
      this.backgroundCanvas,
      this.bgCtx,
      this.width,
      canvasHeight,
      true,
      () =>
        drawBackground(
          this.bgCtx,
          this.width,
          canvasHeight,
          this.dataMin,
          this.dataMax,
          this.unit,
          500
        )
    );

    // 监听容器大小变化
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === this.container) {
          this.width = this.canvas.clientWidth;
          const newHeight = this.canvas.clientHeight;

          initializeCanvas(
            this.canvas,
            this.ctx,
            this.width,
            newHeight,
            false,
            undefined,
            () => this.resetRefs()
          );

          initializeCanvas(
            this.backgroundCanvas,
            this.bgCtx,
            this.width,
            newHeight,
            true,
            () =>
              drawBackground(
                this.bgCtx,
                this.width,
                newHeight,
                this.dataMin,
                this.dataMax,
                this.unit,
                500
              )
          );
        }
      }
    });

    this.resizeObserver.observe(this.container);

    // 启动绘制
    this.startDrawing();
  }

  /**
   * 开始绘制
   */
  startDrawing() {
    // 停止之前的动画
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }

    const draw = (timestamp) => {
      if (this.dataIndex >= this.data.length) {
        this.animationFrameId = requestAnimationFrame(draw);
        return;
      }

      if (this.lastTimestamp === null) {
        this.lastTimestamp = timestamp;
      }

      let deltaTime = timestamp - this.lastTimestamp;
      this.lastTimestamp = timestamp;

      if (deltaTime > 40) {
        deltaTime = 40; // 限制deltaTime，防止帧率过低时绘制过多点
      }

      const fps = 1000 / deltaTime;
      this.accumulatedPoints += this.dataSampleRate / fps;
      const pointsToDraw = Math.floor(this.accumulatedPoints);
      this.accumulatedPoints -= pointsToDraw;

      for (let i = 0; i < pointsToDraw; i++) {
        if (this.dataIndex >= this.data.length) {
          break;
        }

        const x = (this.drawPosition * this.xScale) % this.width;

        // 检测X坐标是否发生回绕
        const isWrapped = this.lastPoints && x < this.lastPoints[0].x;

        // 计算擦除区域的起始和结束位置
        const eraseStart = (x + 1) % this.width;
        const eraseEnd = (x + this.eraseWidth) % this.width;

        if (eraseEnd > eraseStart) {
          this.ctx.clearRect(
            eraseStart,
            0,
            eraseEnd - eraseStart,
            this.adjustedHeight
          );
        } else {
          this.ctx.clearRect(
            eraseStart,
            0,
            this.width - eraseStart,
            this.adjustedHeight
          );
          this.ctx.clearRect(0, 0, eraseEnd, this.adjustedHeight);
        }

        // 获取当前数据点的值数组
        const values = this.extractValues(this.data[this.dataIndex]);

        // 初始化上一点坐标
        if (!this.lastPoints) {
          this.lastPoints = values.map((value) => ({
            x,
            y: scaleY(value, this.adjustedHeight, this.dataMin, this.dataMax),
          }));
        }

        values.forEach((value, idx) => {
          // 限制value在dataMin和dataMax之间
          const clampedValue = Math.max(
            this.dataMin,
            Math.min(this.dataMax, value)
          );
          const y = scaleY(
            clampedValue,
            this.adjustedHeight,
            this.dataMin,
            this.dataMax
          );

          this.ctx.beginPath();
          if (this.lastPoints && !isWrapped) {
            this.ctx.moveTo(this.lastPoints[idx].x, this.lastPoints[idx].y);
          } else {
            this.ctx.moveTo(x, y);
          }
          this.ctx.lineTo(x, y);
          this.ctx.strokeStyle = this.lineColors[idx];
          this.ctx.lineWidth = 2;
          this.ctx.stroke();

          this.lastPoints[idx] = { x, y };
        });

        // 更新绘制位置和数据索引
        this.drawPosition += 1;
        this.dataIndex += 1;
      }

      // 请求下一帧
      this.animationFrameId = requestAnimationFrame(draw);
    };

    // 开始绘制
    this.animationFrameId = requestAnimationFrame(draw);
  }

  /**
   * 销毁图表
   */
  destroy() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
  }
}

/**
 * PPG Chart – 4 channels from Polar Verity Sense (raw)
 */
class PPGChart {
  /**
   * @param {HTMLElement} container
   * @param {{ ch0:number, ch1:number, ch2:number, ch3:number }[]} data
   * @param {number} height
   */
  constructor(container, data, height) {
    const extractValues = (dp) => [dp.ch0, dp.ch1, dp.ch2, dp.ch3];

    this.chart = new MonitorChart(
      container,
      data,
      height,
      -10000000,  // dataMin – 24-bit signed range (observed values ~5-8M)
       10000000,  // dataMax
      55,         // dataSampleRate (Verity Sense PPG @ 55 Hz)
      "",         // unit (raw ADC counts)
      ["#ff5252", "#69f0ae", "#40c4ff", "#ffab40"],  // 4 channel colours
      1.3,        // xScale
      15,         // eraseWidth
      extractValues
    );
  }

  updateData(data) { this.chart.updateData(data); }
  destroy()        { this.chart.destroy(); }
}

/**
 * Filtered PPG Chart – single channel (processed)
 * Clears and redraws on each complete window
 */
class FilteredPPGChart {
  /**
   * @param {HTMLElement} container
   * @param {{ v:number }[]} data
   * @param {number} height
   */
  constructor(container, data, height) {
    this.container = container;
    this.canvas = document.createElement("canvas");
    this.canvas.width = container.clientWidth;
    this.canvas.height = height;
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    
    this.data = data;
    this.height = height;
    this.dataMin = -3;
    this.dataMax = 3;
    this.fs = 55;
    this.peaks = [];
  }

  updateData(data, peaks = []) {
    this.data = data;
    this.peaks = peaks;
    this.redraw();
  }

  redraw() {
    // Clear canvas
    this.ctx.fillStyle = "#1a1a1a";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this.data || this.data.length === 0) return;

    const w = this.canvas.width;
    const h = this.canvas.height;
    const padding = 30;
    const graphWidth = w - 2 * padding;
    const graphHeight = h - 2 * padding;

    // Draw grid and axes
    this.ctx.strokeStyle = "#333";
    this.ctx.lineWidth = 1;
    this.ctx.fillStyle = "#999";
    this.ctx.font = "12px monospace";
    this.ctx.textAlign = "right";

    for (let i = 0; i <= 4; i++) {
      const y = padding + (graphHeight * i) / 4;
      this.ctx.beginPath();
      this.ctx.moveTo(padding, y);
      this.ctx.lineTo(w - padding, y);
      this.ctx.stroke();

      const val = this.dataMax - (i * (this.dataMax - this.dataMin)) / 4;
      this.ctx.fillText(val.toFixed(1), padding - 5, y + 4);
    }

    // Draw signal
    this.ctx.strokeStyle = "#ff5252";
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();

    for (let i = 0; i < this.data.length; i++) {
      const val = Math.max(this.dataMin, Math.min(this.dataMax, this.data[i].v));
      const x = padding + (i / this.data.length) * graphWidth;
      const y = h - padding - ((val - this.dataMin) / (this.dataMax - this.dataMin)) * graphHeight;

      if (i === 0) {
        this.ctx.moveTo(x, y);
      } else {
        this.ctx.lineTo(x, y);
      }
    }
    this.ctx.stroke();

    // Draw peaks
    this.ctx.fillStyle = "#ffeb3b";
    for (const peakIdx of this.peaks) {
      const x = padding + (peakIdx / this.data.length) * graphWidth;
      const val = this.data[peakIdx].v;
      const y = h - padding - ((val - this.dataMin) / (this.dataMax - this.dataMin)) * graphHeight;
      this.ctx.beginPath();
      this.ctx.arc(x, y, 4, 0, 2 * Math.PI);
      this.ctx.fill();
    }

    // Draw time axis labels
    this.ctx.textAlign = "center";
    this.ctx.fillStyle = "#999";
    const numLabels = 5;
    for (let i = 0; i <= numLabels; i++) {
      const x = padding + (i / numLabels) * graphWidth;
      const sec = (i / numLabels) * (this.data.length / this.fs);
      this.ctx.fillText(sec.toFixed(1) + "s", x, h - 10);
    }
  }

  updateHeight(newHeight) {
    this.height = newHeight;
    this.canvas.height = newHeight;
    this.redraw();
  }

  destroy() {
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }
}

/**
 * 加速度图表
 */
class ACCChart {
  /**
   * @param {HTMLElement} container - 图表容器
   * @param {{ x: number, y: number, z: number }[]} data - 初始数据
   * @param {number} height - 图表高度
   * @param {number} dataSampleRate - 数据采样率
   * @param {number} xScale - x轴缩放
   */
  constructor(container, data, height, dataSampleRate, xScale) {
    // 提取数据值的函数
    const extractValues = (dataPoint) => [
      dataPoint.x,
      dataPoint.y,
      dataPoint.z,
    ];

    // 创建监测图表 - 使用更好看的配色
    this.chart = new MonitorChart(
      container,
      data,
      height,
      -1500, // dataMin
      1500, // dataMax
      dataSampleRate,
      "mG", // unit
      ["#ff9e80", "#80d8ff", "#b388ff"], // 橙色、浅蓝色、紫色 - 更现代化的配色
      xScale,
      10, // eraseWidth
      extractValues
    );
  }

  /**
   * 更新数据
   * @param {{ x: number, y: number, z: number }[]} data - 新数据
   */
  updateData(data) {
    this.chart.updateData(data);
  }

  /**
   * 销毁图表
   */
  destroy() {
    this.chart.destroy();
  }
}

/**
 * Gyroscope chart – 3 axes (X, Y, Z) in deg/s
 */
class GyroChart {
  /**
   * @param {HTMLElement} container
   * @param {{ x: number, y: number, z: number }[]} data
   * @param {number} height
   */
  constructor(container, data, height) {
    const extractValues = (dp) => [dp.x, dp.y, dp.z];

    this.chart = new MonitorChart(
      container,
      data,
      height,
      -500,     // dataMin (±500 deg/s range for better visibility)
       500,     // dataMax
      52,       // dataSampleRate (52 Hz)
      "°/s",    // unit
      ["#ea80fc", "#84ffff", "#ccff90"],  // pink, cyan, lime
      2,        // xScale
      10,       // eraseWidth
      extractValues
    );
  }

  updateData(data) { this.chart.updateData(data); }
  destroy()        { this.chart.destroy(); }
}

/**
 * Motion Magnitude Chart – shows ACC, GYRO and MAG magnitude over time
 */
class MotionMagnitudeChart {
  constructor(container, data, height) {
    this.container = container;
    this.height = height;
    this.accHistory = [];   // magnitude values
    this.gyroHistory = [];  // magnitude values
    this.magHistory = [];   // magnitude values
    this.maxPoints = 200;
    this.maxAcc = 2000;     // mg
    this.maxGyro = 1000;    // deg/s
    this.maxMag = 100;      // µT (microtesla)

    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = `${height}px`;
    container.style.position = "relative";
    container.style.width = "100%";
    container.style.height = `${height}px`;
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    this._resize();
    this.resizeObserver = new ResizeObserver(() => this._resize());
    this.resizeObserver.observe(container);
    this.animationFrameId = requestAnimationFrame(() => this._draw());
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  addAccMagnitude(mag) {
    this.accHistory.push(mag);
    if (this.accHistory.length > this.maxPoints) {
      this.accHistory.shift();
    }
  }

  addGyroMagnitude(mag) {
    this.gyroHistory.push(mag);
    if (this.gyroHistory.length > this.maxPoints) {
      this.gyroHistory.shift();
    }
  }

  addMagMagnitude(mag) {
    this.magHistory.push(mag);
    if (this.magHistory.length > this.maxPoints) {
      this.magHistory.shift();
    }
  }

  _draw() {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;

    ctx.clearRect(0, 0, w, h);

    // Draw background grid
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 0.5;
    ctx.fillStyle = "#666";
    ctx.font = "11px Arial";
    ctx.textAlign = "right";

    // Horizontal grid lines with ACC values on left
    for (let i = 0; i <= 4; i++) {
      const y = (i / 4) * h;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();

      // ACC scale (left side)
      ctx.fillStyle = "#ea80fc";
      const accVal = Math.round(this.maxAcc * (4 - i) / 4);
      ctx.fillText(accVal + "mg", 35, y + 4);

      // GYRO scale (right side)
      ctx.fillStyle = "#84ffff";
      ctx.textAlign = "left";
      const gyroVal = Math.round(this.maxGyro * (4 - i) / 4);
      ctx.fillText(gyroVal + "°/s", w - 35, y + 4);
      ctx.textAlign = "right";
    }

    const step = w / (this.maxPoints - 1);

    // Draw ACC magnitude (pink)
    if (this.accHistory.length > 0) {
      ctx.beginPath();
      ctx.strokeStyle = "#ea80fc";
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";

      const startX = w - (this.accHistory.length - 1) * step;
      for (let i = 0; i < this.accHistory.length; i++) {
        const x = startX + i * step;
        const normalizedY = Math.min(1, this.accHistory[i] / this.maxAcc);
        const y = h - normalizedY * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Draw GYRO magnitude (cyan)
    if (this.gyroHistory.length > 0) {
      ctx.beginPath();
      ctx.strokeStyle = "#84ffff";
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";

      const startX = w - (this.gyroHistory.length - 1) * step;
      for (let i = 0; i < this.gyroHistory.length; i++) {
        const x = startX + i * step;
        const normalizedY = Math.min(1, this.gyroHistory[i] / this.maxGyro);
        const y = h - normalizedY * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Draw MAG magnitude (yellow/gold)
    if (this.magHistory.length > 0) {
      ctx.beginPath();
      ctx.strokeStyle = "#ffd740";
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";

      const startX = w - (this.magHistory.length - 1) * step;
      for (let i = 0; i < this.magHistory.length; i++) {
        const x = startX + i * step;
        const normalizedY = Math.min(1, this.magHistory[i] / this.maxMag);
        const y = h - normalizedY * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    this.animationFrameId = requestAnimationFrame(() => this._draw());
  }

  updateHeight(height) {
    this.height = height;
    this.canvas.style.height = `${height}px`;
    this.container.style.height = `${height}px`;
    this._resize();
  }

  destroy() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
  }
}

/**
 * HR Timeline – heart rate over time as a scrolling line chart
 * Unlike MonitorChart which sweeps, this uses a simple scrolling window.
 */
class HRTimelineChart {
  constructor(container, height) {
    this.container = container;
    this.height = height;
    this.hrHistory = [];       // {time: Date, bpm: number}
    this.maxPoints = 300;      // ~5 minutes at 1 sample/sec
    this.minBPM = 40;
    this.maxBPM = 200;

    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = `${height}px`;
    container.style.position = "relative";
    container.style.width = "100%";
    container.style.height = `${height}px`;
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    this._resize();
    this.resizeObserver = new ResizeObserver(() => this._resize());
    this.resizeObserver.observe(container);
    this._draw();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  addHR(bpm) {
    this.hrHistory.push({ time: Date.now(), bpm });
    if (this.hrHistory.length > this.maxPoints) {
      this.hrHistory.shift();
    }
  }

  _draw() {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    const range = this.maxBPM - this.minBPM;

    ctx.clearRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 0.5;
    ctx.fillStyle = "#666";
    ctx.font = "10px Arial";
    ctx.textAlign = "left";
    for (let bpm = 60; bpm <= 180; bpm += 30) {
      const y = h - ((bpm - this.minBPM) / range) * h;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillText(`${bpm}`, 4, y - 3);
    }

    // Draw HR line
    if (this.hrHistory.length < 2) {
      requestAnimationFrame(() => this._draw());
      return;
    }

    const pts = this.hrHistory;
    const step = w / (this.maxPoints - 1);

    ctx.beginPath();
    ctx.strokeStyle = "#ff5252";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";

    // Offset so latest point is at right edge
    const startX = w - (pts.length - 1) * step;

    for (let i = 0; i < pts.length; i++) {
      const x = startX + i * step;
      const y = h - ((pts[i].bpm - this.minBPM) / range) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Fill under curve
    ctx.lineTo(startX + (pts.length - 1) * step, h);
    ctx.lineTo(startX, h);
    ctx.closePath();
    ctx.fillStyle = "rgba(255, 82, 82, 0.08)";
    ctx.fill();

    requestAnimationFrame(() => this._draw());
  }

  updateHeight(height) {
    this.height = height;
    this.canvas.style.height = `${height}px`;
    this.container.style.height = `${height}px`;
    this._resize();
  }

  destroy() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
  }
}