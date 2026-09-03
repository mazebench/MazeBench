(() => {
  function rootObject() {
    if (typeof window !== "undefined") return window;
    if (typeof self !== "undefined") return self;
    return globalThis;
  }

  function finiteSeries(values) {
    return (values || []).map(Number).filter((value) => Number.isFinite(value));
  }

  function niceNum(range, round) {
    if (!(range > 0) || !Number.isFinite(range)) return 1;
    const exponent = Math.floor(Math.log10(range));
    const fraction = range / 10 ** exponent;
    let niceFraction;
    if (round) {
      if (fraction < 1.5) niceFraction = 1;
      else if (fraction < 3) niceFraction = 2;
      else if (fraction < 7) niceFraction = 5;
      else niceFraction = 10;
    } else if (fraction <= 1) niceFraction = 1;
    else if (fraction <= 2) niceFraction = 2;
    else if (fraction <= 5) niceFraction = 5;
    else niceFraction = 10;
    return niceFraction * 10 ** exponent;
  }

  function snap(value) {
    if (!Number.isFinite(value) || value === 0) return 0;
    const digits = Math.max(0, 12 - Math.floor(Math.log10(Math.abs(value))));
    return Number(value.toFixed(Math.min(12, digits)));
  }

  function niceScale(values, options = {}) {
    const series = finiteSeries(values);
    const target = Math.max(2, options.tickCount || 4);
    let lo = series.length ? Math.min(...series) : 0;
    let hi = series.length ? Math.max(...series) : 1;
    if (Number.isFinite(options.min)) lo = Math.min(lo, options.min);
    if (Number.isFinite(options.max)) hi = Math.max(hi, options.max);
    if (hi < lo) {
      const swap = lo;
      lo = hi;
      hi = swap;
    }
    const dataMin = lo;
    let span = hi - lo;
    if (!(span > 0)) {
      const mag = Math.max(Math.abs(lo), 0.1);
      lo -= mag * 0.12;
      hi += mag * 0.12;
      span = hi - lo;
    } else {
      const grace = span * (options.grace == null ? 0.1 : options.grace);
      lo -= grace;
      hi += grace;
      span = hi - lo;
    }
    const allNonNegative = series.length === 0 || series.every((value) => value >= 0);
    if (options.pinZero && allNonNegative && dataMin >= 0) lo = 0;
    const step = niceNum((hi - lo) / target, true);
    const niceMin = snap(Math.floor(lo / step) * step);
    const niceMax = snap(Math.ceil(hi / step) * step);
    const ticks = [];
    const count = Math.max(1, Math.round((niceMax - niceMin) / step));
    for (let i = 0; i <= count; i += 1) ticks.push(snap(niceMin + i * step));
    if (ticks[ticks.length - 1] !== niceMax) ticks.push(niceMax);
    return { min: ticks[0], max: ticks[ticks.length - 1], step, ticks };
  }

  function formatTick(value, step) {
    if (!Number.isFinite(value)) return "";
    const abs = Math.abs(value);
    const increment = Number.isFinite(step) && step > 0 ? step : abs || 1;
    if (abs >= 10000) {
      const thousands = value / 1000;
      const digits = Math.abs(thousands) >= 100 ? 0 : 1;
      return `${thousands.toFixed(digits)}k`;
    }
    if (increment >= 1) return String(Math.round(value));
    const decimals = Math.min(6, Math.max(0, Math.ceil(-Math.log10(increment) + 1e-9)));
    let text = value.toFixed(decimals);
    if (text.includes(".")) text = text.replace(/\.?0+$/, "");
    return text === "-0" ? "0" : text;
  }

  function bucketStride(length, maxPoints) {
    const n = Math.max(0, Math.floor(length) || 0);
    const limit = Math.max(2, Math.floor(maxPoints) || 2);
    let stride = 1;
    while (stride * limit < n) stride *= 2;
    return stride;
  }

  function downsampleStable(values, maxPoints) {
    const n = values ? values.length : 0;
    if (!n) return [];
    const read = (index) => {
      const value = Number(values[index]);
      return Number.isFinite(value) ? value : null;
    };
    const stride = bucketStride(n, maxPoints);
    if (stride === 1) {
      const points = [];
      for (let x = 0; x < n; x += 1) {
        const y = read(x);
        if (y != null) points.push({ x, y });
      }
      return points;
    }
    const points = [];
    const first = read(0);
    if (first != null) points.push({ x: 0, y: first });
    for (let start = 0; start < n; start += stride) {
      const end = Math.min(n, start + stride);
      let sum = 0;
      let count = 0;
      for (let i = start; i < end; i += 1) {
        const y = read(i);
        if (y == null) continue;
        sum += y;
        count += 1;
      }
      if (!count) continue;
      const complete = end - start === stride;
      if (!complete) break;
      const x = (start + end - 1) / 2;
      if (points.length && points[points.length - 1].x === x) points.pop();
      points.push({ x, y: sum / count });
    }
    const last = read(n - 1);
    if (last != null && (!points.length || points[points.length - 1].x !== n - 1)) {
      points.push({ x: n - 1, y: last });
    }
    return points;
  }

  function downsampleAverage(values, maxPoints) {
    return downsampleStable(values, maxPoints);
  }

  function chooseXMax(lastIndex) {
    return Math.max(0, Math.floor(Number(lastIndex) || 0));
  }

  function chooseXTicks(maxIndex, plotWidth) {
    const last = Math.max(0, Math.floor(maxIndex));
    if (last <= 0) return [0];
    const sample = last >= 10000 ? `${Math.round(last / 1000)}k` : String(last);
    const labelWidth = Math.max(18, sample.length * 7 + 8);
    const maxTicks = Math.max(2, Math.floor(plotWidth / labelWidth));
    const step = Math.max(1, Math.round(niceNum(last / (maxTicks - 1), true)));
    const ticks = [0];
    for (let value = step; value < last; value += step) ticks.push(value);
    if (ticks[ticks.length - 1] !== last) {
      if (last - ticks[ticks.length - 1] < step * 0.55 && ticks.length > 1) ticks.pop();
      ticks.push(last);
    }
    return ticks;
  }

  function advanceScale(values, options = {}, previous = null) {
    const series = finiteSeries(values);
    const sample = series.length ? series : [0];
    const lo = Math.min(...sample);
    const hi = Math.max(...sample);
    if (previous && previous.scale && series.length) {
      const span = previous.scale.max - previous.scale.min;
      const inset = Math.max(span * 0.02, Number(previous.scale.step) * 0.05 || 0);
      if (lo >= previous.scale.min + inset && hi <= previous.scale.max - inset) {
        return {
          dataMin: Math.min(previous.dataMin, lo),
          dataMax: Math.max(previous.dataMax, hi),
          scale: previous.scale,
          padL: previous.padL
        };
      }
    }
    const dataMin = previous && Number.isFinite(previous.dataMin) ? Math.min(previous.dataMin, lo) : lo;
    const dataMax = previous && Number.isFinite(previous.dataMax) ? Math.max(previous.dataMax, hi) : hi;
    return {
      dataMin,
      dataMax,
      scale: niceScale([dataMin, dataMax], options),
      padL: previous && previous.padL ? previous.padL : 0
    };
  }

  function canvasContext(canvas) {
    if (canvas._trainCtx) return canvas._trainCtx;
    const ctx = canvas.getContext("2d", { alpha: false }) || canvas.getContext("2d");
    canvas._trainCtx = ctx;
    return ctx;
  }

  function drawSeriesChart(canvas, values, options = {}) {
    if (!canvas) return;
    const cssW = Math.max(0, Math.floor(canvas.clientWidth || 0));
    const cssH = Math.max(0, Math.floor(canvas.clientHeight || 0));
    if (cssW < 8 || cssH < 8) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelW = Math.max(1, Math.round(cssW * dpr));
    const pixelH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }
    const ctx = canvasContext(canvas);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#040712";
    ctx.fillRect(0, 0, cssW, cssH);

    const raw = Array.isArray(values) ? values : [];
    const prev = options.reset ? null : canvas._trainChart;
    const advanced = advanceScale(raw, {
      tickCount: options.tickCount || 4,
      pinZero: options.pinZero,
      grace: options.grace,
      min: options.min,
      max: options.max
    }, prev);
    const scale = advanced.scale;
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    const yLabels = scale.ticks.map((tick) => formatTick(tick, scale.step));
    const yLabelWidth = yLabels.reduce((max, label) => Math.max(max, ctx.measureText(label).width), 12);
    const padL = Math.max(36, Math.ceil(yLabelWidth + 12), advanced.padL || 0);
    canvas._trainChart = { ...advanced, padL };
    const pad = { l: padL, r: 10, t: 8, b: 22 };
    const plotW = Math.max(8, cssW - pad.l - pad.r);
    const plotH = Math.max(8, cssH - pad.t - pad.b);
    const lastIndex = Math.max(0, raw.length - 1);
    const xMax = chooseXMax(lastIndex);
    const points = downsampleStable(raw, Math.max(2, Math.floor(plotW)));
    const yAt = (value) => pad.t + (1 - (value - scale.min) / (scale.max - scale.min)) * plotH;
    const xAt = (index) => (xMax <= 0 ? pad.l + plotW / 2 : pad.l + (index / xMax) * plotW);

    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(124, 143, 255, 0.18)";
    ctx.fillStyle = "#8b93b8";
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    scale.ticks.forEach((tick, index) => {
      const y = yAt(tick);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(cssW - pad.r, y);
      ctx.stroke();
      ctx.fillText(yLabels[index], pad.l - 6, y);
    });

    ctx.strokeStyle = "rgba(184, 196, 230, 0.55)";
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, cssH - pad.b);
    ctx.lineTo(cssW - pad.r, cssH - pad.b);
    ctx.stroke();

    const xTicks = chooseXTicks(xMax, plotW);
    ctx.textBaseline = "top";
    ctx.fillStyle = "#8b93b8";
    xTicks.forEach((tick) => {
      const x = xAt(tick);
      ctx.strokeStyle = "rgba(124, 143, 255, 0.12)";
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, cssH - pad.b);
      ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = "rgba(184, 196, 230, 0.55)";
      ctx.moveTo(x, cssH - pad.b);
      ctx.lineTo(x, cssH - pad.b + 4);
      ctx.stroke();
      ctx.textAlign = tick === 0 ? "left" : tick === xMax ? "right" : "center";
      ctx.fillText(formatTick(tick, xTicks.length > 1 ? xTicks[1] - xTicks[0] : 1), x, cssH - pad.b + 6);
    });

    if (points.length) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(pad.l, pad.t, plotW, plotH);
      ctx.clip();
      ctx.beginPath();
      ctx.strokeStyle = options.color || "#42e8ef";
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      points.forEach((point, index) => {
        const x = xAt(point.x);
        const y = yAt(point.y);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      const last = points[points.length - 1];
      ctx.beginPath();
      ctx.fillStyle = options.color || "#42e8ef";
      ctx.arc(xAt(last.x), yAt(last.y), 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function watch(canvases, redraw) {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
      frame = raf(() => {
        frame = 0;
        redraw();
      });
    };
    const disconnectFns = [];
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(schedule);
      canvases.forEach((canvas) => {
        if (canvas) observer.observe(canvas);
      });
      disconnectFns.push(() => observer.disconnect());
    }
    if (typeof window !== "undefined") {
      window.addEventListener("resize", schedule);
      disconnectFns.push(() => window.removeEventListener("resize", schedule));
    }
    return {
      schedule,
      disconnect() {
        disconnectFns.forEach((fn) => fn());
        if (frame) {
          if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
          else clearTimeout(frame);
          frame = 0;
        }
      }
    };
  }

  rootObject().TrainChart = {
    advanceScale,
    bucketStride,
    chooseXMax,
    chooseXTicks,
    downsampleAverage,
    downsampleStable,
    drawSeriesChart,
    finiteSeries,
    formatTick,
    niceNum,
    niceScale,
    watch
  };
})();
