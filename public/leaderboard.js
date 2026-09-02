(() => {
  "use strict";

  const COLORS = ["#34e7f0", "#ff8dc8", "#9b8cff", "#ffd15c", "#65f3d4", "#ff936b", "#75a7ff", "#e4f06a"];
  const X_AXES = {
    move_count: { label: "Move count", short: "moves", format: formatInteger },
    api_cost_usd: { label: "Estimated API price", short: "price", format: formatUsd },
    input_tokens: { label: "Input tokens", short: "input tokens", format: formatCompact }
  };
  const Y_AXES = {
    gems: { label: "Gems collected", short: "gems", format: formatInteger },
    rooms: { label: "Rooms visited", short: "rooms", format: formatInteger }
  };
  const elements = {
    chart: document.querySelector("#leaderboard-chart"),
    note: document.querySelector("#leaderboard-chart-note"),
    legend: document.querySelector("#leaderboard-legend"),
    picker: document.querySelector("#leaderboard-run-picker"),
    status: document.querySelector("#leaderboard-status"),
    tooltip: document.querySelector("#leaderboard-tooltip"),
    defaults: document.querySelector("#leaderboard-select-defaults"),
    clear: document.querySelector("#leaderboard-clear")
  };
  const state = {
    runs: [],
    selected: new Set(),
    series: new Map(),
    loading: new Set(),
    xAxis: axisFromUrl("x", X_AXES, "move_count"),
    yAxis: axisFromUrl("y", Y_AXES, "gems"),
    renderVersion: 0
  };

  document.querySelectorAll("[data-x-axis]").forEach((button) => {
    button.addEventListener("click", () => {
      state.xAxis = button.dataset.xAxis;
      updateControls();
      updateUrl();
      renderChart();
    });
  });
  document.querySelectorAll("[data-y-axis]").forEach((button) => {
    button.addEventListener("click", () => {
      state.yAxis = button.dataset.yAxis;
      updateControls();
      updateUrl();
      renderChart();
    });
  });
  elements.defaults?.addEventListener("click", () => selectDefaults(true));
  elements.clear?.addEventListener("click", () => {
    state.selected.clear();
    selectionChanged();
  });

  boot();

  async function boot() {
    updateControls();
    try {
      const response = await fetch("/api/agent/runs?starred=1&page_size=100&sort=newest", {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error(`Could not load starred runs (${response.status}).`);
      const payload = await response.json();
      state.runs = Array.isArray(payload?.runs) ? payload.runs : [];
      const requested = new URLSearchParams(window.location.search).get("runs")
        ?.split(",")
        .map((id) => id.trim())
        .filter((id) => state.runs.some((run) => run.id === id)) || [];
      if (requested.length) requested.forEach((id) => state.selected.add(id));
      else selectDefaults(false);
      renderPicker();
      await loadSelectedSeries();
    } catch (error) {
      elements.status.textContent = error instanceof Error ? error.message : String(error);
      elements.status.classList.add("is-error");
      renderEmpty("Leaderboard data could not be loaded.");
    }
  }

  function selectDefaults(update = true) {
    state.selected.clear();
    const fable51 = state.runs.find((run) => /(?:^|-)fable-5-1(?:-|$)/i.test(String(run.model_name || "")));
    const fable5 = state.runs.find((run) =>
      /(?:^|-)fable-5(?:-|$)/i.test(String(run.model_name || "")) &&
      !/(?:^|-)fable-5-1(?:-|$)/i.test(String(run.model_name || "")) &&
      (!fable51 || run.mode === fable51.mode && run.tool_use === fable51.tool_use)
    ) || state.runs.find((run) =>
      /(?:^|-)fable-5(?:-|$)/i.test(String(run.model_name || "")) &&
      !/(?:^|-)fable-5-1(?:-|$)/i.test(String(run.model_name || ""))
    );
    [fable51, fable5].filter(Boolean).forEach((run) => state.selected.add(run.id));
    if (!state.selected.size) state.runs.slice(0, 2).forEach((run) => state.selected.add(run.id));
    if (update) selectionChanged();
  }

  function selectionChanged() {
    renderPicker();
    updateUrl();
    loadSelectedSeries();
  }

  async function loadSelectedSeries() {
    const version = ++state.renderVersion;
    const missing = [...state.selected].filter((id) => !state.series.has(id) && !state.loading.has(id));
    missing.forEach((id) => state.loading.add(id));
    renderChart();
    await Promise.all(missing.map(async (id) => {
      try {
        const response = await fetch(`/api/leaderboard/runs/${encodeURIComponent(id)}`, {
          headers: { Accept: "application/json" }
        });
        if (!response.ok) throw new Error(`Could not load run ${id}.`);
        state.series.set(id, await response.json());
      } catch (error) {
        state.series.set(id, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        state.loading.delete(id);
      }
    }));
    if (version <= state.renderVersion) {
      renderPicker();
      renderChart();
    }
  }

  function renderPicker() {
    if (!elements.picker) return;
    if (!state.runs.length) {
      elements.picker.innerHTML = `<div class="leaderboard-empty"><strong>No starred runs yet.</strong><span>Star runs on the Agent page to add them here.</span></div>`;
      elements.status.textContent = "No starred runs";
      return;
    }
    const grouped = [...state.runs]
      .sort((left, right) =>
        companyForRun(left).localeCompare(companyForRun(right)) ||
        (Number(right.gem_count) || 0) - (Number(left.gem_count) || 0) ||
        String(right.created_at || "").localeCompare(String(left.created_at || ""))
      )
      .reduce((groups, run) => {
        const company = companyForRun(run);
        if (!groups.has(company)) groups.set(company, []);
        groups.get(company).push(run);
        return groups;
      }, new Map());
    elements.picker.innerHTML = [...grouped].map(([company, runs]) => {
      const topGems = Math.max(0, ...runs.map((run) => Number(run.gem_count) || 0));
      const options = runs.map((run) => {
      const index = state.runs.findIndex((candidate) => candidate.id === run.id);
      const selected = state.selected.has(run.id);
      const loading = state.loading.has(run.id);
      const color = colorForRun(run.id, index);
      return `<button class="leaderboard-run-option" type="button" data-run-id="${escapeText(run.id)}" aria-pressed="${selected ? "true" : "false"}" style="--run-color:${color}">
        <span class="leaderboard-run-option__mark" aria-hidden="true"></span>
        <span class="leaderboard-run-option__copy">
          <strong>${escapeText(displayModel(run))}</strong>
          <small>${escapeText(runSubtitle(run))}</small>
        </span>
        <span class="leaderboard-run-option__score">${formatInteger(run.gem_count)} <small>gems</small></span>
        ${loading ? '<span class="leaderboard-run-option__loading" aria-label="Loading"></span>' : ""}
      </button>`;
      }).join("");
      return `<section class="leaderboard-company" aria-labelledby="leaderboard-company-${slug(company)}">
        <header class="leaderboard-company__head">
          <h3 id="leaderboard-company-${slug(company)}">${escapeText(company)}</h3>
          <span>${runs.length} starred run${runs.length === 1 ? "" : "s"} · top score ${formatInteger(topGems)} gems</span>
        </header>
        <div class="leaderboard-company__runs">${options}</div>
      </section>`;
    }).join("");
    elements.picker.querySelectorAll("[data-run-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.runId;
        if (state.selected.has(id)) state.selected.delete(id);
        else state.selected.add(id);
        selectionChanged();
      });
    });
  }

  function renderChart() {
    if (!elements.chart) return;
    hideTooltip();
    const selected = [...state.selected]
      .map((id) => state.series.get(id))
      .filter((entry) => entry && !entry.error && Array.isArray(entry.points));
    const pending = [...state.selected].some((id) => state.loading.has(id) || !state.series.has(id));
    if (!state.selected.size) {
      elements.status.textContent = "Select at least one run";
      renderEmpty("Select models below to draw their starred runs.");
      renderLegend([]);
      return;
    }
    if (!selected.length && pending) {
      elements.status.textContent = `Loading ${state.selected.size} selected run${state.selected.size === 1 ? "" : "s"}…`;
      renderEmpty("Loading run timelines…", true);
      renderLegend([]);
      return;
    }

    const xKey = state.xAxis;
    const yKey = state.yAxis;
    const plotted = selected.map((entry) => ({
      entry,
      color: colorForRun(entry.run.id, state.runs.findIndex((run) => run.id === entry.run.id)),
      points: entry.points
        .map((point) => ({ x: finiteMetric(point[xKey]), y: finiteMetric(point[yKey]), raw: point }))
        .filter((point) => point.x !== null && point.y !== null)
    })).filter((series) => series.points.length > 1);
    if (!plotted.length) {
      elements.status.textContent = `No ${X_AXES[xKey].short} timeline`;
      renderEmpty(`The selected runs do not contain a ${X_AXES[xKey].short} timeline.`);
      renderLegend(selected);
      return;
    }

    const width = 1180;
    const height = 510;
    const pad = { top: 28, right: 36, bottom: 64, left: 74 };
    const xMax = niceMaximum(Math.max(...plotted.flatMap((series) => series.points.map((point) => point.x)), 1));
    const yMax = niceMaximum(Math.max(...plotted.flatMap((series) => series.points.map((point) => point.y)), 1), true);
    const x = (value) => pad.left + value / xMax * (width - pad.left - pad.right);
    const y = (value) => height - pad.bottom - value / yMax * (height - pad.top - pad.bottom);
    const chart = svg("svg", {
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: "xMidYMid meet",
      role: "img",
      "aria-label": `${Y_AXES[yKey].label} by ${X_AXES[xKey].label} for ${plotted.length} selected starred run${plotted.length === 1 ? "" : "s"}`
    });

    axisTicks(yMax, 5).forEach((value) => {
      const lineY = y(value);
      chart.append(
        svg("line", { x1: pad.left, y1: lineY, x2: width - pad.right, y2: lineY, class: "leaderboard-chart__grid" }),
        svgText(pad.left - 12, lineY + 4, Y_AXES[yKey].format(value), "end", "leaderboard-chart__tick")
      );
    });
    axisTicks(xMax, 5).forEach((value) => {
      const lineX = x(value);
      chart.append(
        svg("line", { x1: lineX, y1: pad.top, x2: lineX, y2: height - pad.bottom, class: "leaderboard-chart__grid is-vertical" }),
        svgText(lineX, height - pad.bottom + 24, X_AXES[xKey].format(value), "middle", "leaderboard-chart__tick")
      );
    });
    chart.append(
      svg("line", { x1: pad.left, y1: height - pad.bottom, x2: width - pad.right, y2: height - pad.bottom, class: "leaderboard-chart__axis" }),
      svg("line", { x1: pad.left, y1: pad.top, x2: pad.left, y2: height - pad.bottom, class: "leaderboard-chart__axis" }),
      svgText((pad.left + width - pad.right) / 2, height - 13, X_AXES[xKey].label, "middle", "leaderboard-chart__axis-label"),
      svgText(19, (pad.top + height - pad.bottom) / 2, Y_AXES[yKey].label, "middle", "leaderboard-chart__axis-label", `rotate(-90 19 ${(pad.top + height - pad.bottom) / 2})`)
    );

    plotted.forEach((series) => {
      const points = compactStepSeries(series.points);
      const path = points.map((point, index) => {
        const px = x(point.x);
        const py = y(point.y);
        if (!index) return `M ${px.toFixed(2)} ${py.toFixed(2)}`;
        return `H ${px.toFixed(2)} V ${py.toFixed(2)}`;
      }).join(" ");
      const group = svg("g", { class: "leaderboard-chart__series", style: `--run-color:${series.color}` });
      group.append(
        svg("path", { d: path, class: "leaderboard-chart__line-shadow" }),
        svg("path", { d: path, class: "leaderboard-chart__line" })
      );
      const last = points[points.length - 1];
      group.append(svg("circle", { cx: x(last.x), cy: y(last.y), r: 4.5, class: "leaderboard-chart__endpoint" }));
      chart.append(group);
    });

    const guide = svg("line", { x1: 0, y1: pad.top, x2: 0, y2: height - pad.bottom, class: "leaderboard-chart__guide", hidden: "" });
    const hit = svg("rect", {
      x: pad.left,
      y: pad.top,
      width: width - pad.left - pad.right,
      height: height - pad.top - pad.bottom,
      class: "leaderboard-chart__hit",
      tabindex: "0"
    });
    chart.append(guide, hit);
    attachTooltip(hit, guide, plotted, { width, height, pad, xMax, x });
    elements.chart.replaceChildren(chart);
    elements.status.textContent = `${plotted.length} run${plotted.length === 1 ? "" : "s"} · ${X_AXES[xKey].short} → ${Y_AXES[yKey].short}`;
    elements.status.classList.remove("is-error");
    const approximated = plotted.filter((series) => series.entry.usage?.approximate_timeline);
    const unavailable = selected.length - plotted.length;
    const notes = [];
    if (approximated.length) notes.push(`${approximated.length} historical run${approximated.length === 1 ? " uses" : "s use"} exact final usage with interpolated checkpoints.`);
    if (unavailable) notes.push(`${unavailable} selected run${unavailable === 1 ? " has" : "s have"} no ${X_AXES[xKey].short} timeline.`);
    elements.note.hidden = !notes.length;
    elements.note.textContent = notes.join(" ");
    renderLegend(selected);
  }

  function renderEmpty(message, loading = false) {
    elements.chart.innerHTML = `<div class="leaderboard-empty${loading ? " is-loading" : ""}"><span class="leaderboard-empty__glyph" aria-hidden="true">${loading ? "◌" : "◇"}</span><strong>${escapeText(message)}</strong></div>`;
    elements.note.hidden = true;
  }

  function renderLegend(entries) {
    if (!elements.legend) return;
    elements.legend.innerHTML = entries.map((entry) => {
      const run = entry.run;
      const color = colorForRun(run.id, state.runs.findIndex((candidate) => candidate.id === run.id));
      const cost = entry.usage?.api_cost_usd;
      return `<a class="leaderboard-legend-item" href="${escapeText(run.url)}" style="--run-color:${color}">
        <span class="leaderboard-legend-item__line" aria-hidden="true"></span>
        <span class="leaderboard-legend-item__copy"><strong>${escapeText(displayModel(run))}</strong><small>${escapeText(runSubtitle(run))}</small></span>
        <span class="leaderboard-legend-item__stats"><b>${formatInteger(run.gem_count)}</b> gems · <b>${formatInteger(run.room_count)}</b> rooms · <b>${formatInteger(run.turns)}</b> moves${cost == null ? "" : ` · <b>${formatUsd(cost)}</b>`}</span>
      </a>`;
    }).join("");
  }

  function attachTooltip(hit, guide, plotted, chartState) {
    const showAt = (clientX, offsetX = null) => {
      const bounds = hit.ownerSVGElement.getBoundingClientRect();
      const localX = offsetX === null
        ? (clientX - bounds.left) / bounds.width * chartState.width
        : offsetX;
      const clampedX = Math.max(chartState.pad.left, Math.min(chartState.width - chartState.pad.right, localX));
      const value = (clampedX - chartState.pad.left) /
        (chartState.width - chartState.pad.left - chartState.pad.right) * chartState.xMax;
      guide.removeAttribute("hidden");
      guide.setAttribute("x1", String(clampedX));
      guide.setAttribute("x2", String(clampedX));
      const rows = plotted.map((series) => ({ series, point: nearestPoint(series.points, value) }));
      elements.tooltip.innerHTML = `<strong>${escapeText(X_AXES[state.xAxis].label)} · ${escapeText(X_AXES[state.xAxis].format(value, true))}</strong>${rows.map(({ series, point }) =>
        `<span><i style="--run-color:${series.color}"></i><b>${escapeText(displayModel(series.entry.run))}</b><em>${escapeText(Y_AXES[state.yAxis].format(point.y))} ${escapeText(Y_AXES[state.yAxis].short)}</em></span>`
      ).join("")}`;
      elements.tooltip.hidden = false;
      const chartBounds = elements.chart.getBoundingClientRect();
      const pointerLeft = (clampedX / chartState.width) * chartBounds.width;
      elements.tooltip.style.left = `${elements.chart.offsetLeft + Math.max(8, Math.min(chartBounds.width - elements.tooltip.offsetWidth - 8, pointerLeft + 14))}px`;
      elements.tooltip.style.top = `${elements.chart.offsetTop + 18}px`;
    };
    hit.addEventListener("pointermove", (event) => showAt(event.clientX));
    hit.addEventListener("pointerleave", () => {
      guide.setAttribute("hidden", "");
      hideTooltip();
    });
    hit.addEventListener("focus", () => showAt(0, chartState.pad.left + (chartState.width - chartState.pad.left - chartState.pad.right) / 2));
    hit.addEventListener("blur", () => {
      guide.setAttribute("hidden", "");
      hideTooltip();
    });
  }

  function hideTooltip() {
    if (elements.tooltip) elements.tooltip.hidden = true;
  }

  function compactStepSeries(points) {
    if (points.length < 3) return points;
    const kept = [points[0]];
    for (let index = 1; index < points.length - 1; index += 1) {
      const previous = points[index - 1];
      const point = points[index];
      const next = points[index + 1];
      if (point.y !== previous.y || point.y !== next.y) kept.push(point);
    }
    kept.push(points[points.length - 1]);
    return kept;
  }

  function nearestPoint(points, target) {
    let low = 0;
    let high = points.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (points[middle].x < target) low = middle + 1;
      else high = middle;
    }
    const left = points[Math.max(0, low - 1)];
    const right = points[low];
    return Math.abs((left?.x ?? Infinity) - target) <= Math.abs((right?.x ?? Infinity) - target) ? left : right;
  }

  function updateControls() {
    document.querySelectorAll("[data-x-axis]").forEach((button) =>
      button.setAttribute("aria-pressed", button.dataset.xAxis === state.xAxis ? "true" : "false")
    );
    document.querySelectorAll("[data-y-axis]").forEach((button) =>
      button.setAttribute("aria-pressed", button.dataset.yAxis === state.yAxis ? "true" : "false")
    );
  }

  function updateUrl() {
    const url = new URL(window.location.href);
    if (state.xAxis === "move_count") url.searchParams.delete("x");
    else url.searchParams.set("x", state.xAxis);
    if (state.yAxis === "gems") url.searchParams.delete("y");
    else url.searchParams.set("y", state.yAxis);
    if (state.selected.size) url.searchParams.set("runs", [...state.selected].join(","));
    else url.searchParams.delete("runs");
    window.history.replaceState(null, "", url);
  }

  function displayModel(run) {
    return String(run?.model_name || run?.provider || "Unnamed model");
  }

  function runSubtitle(run) {
    const mode = run?.mode === "vision" ? "Vision" : run?.mode === "json" ? "JSON" : "ASCII";
    const tools = run?.tool_use === "offline" ? "Python off" : run?.tool_use === "read-only" ? "Python read only" : run?.tool_use ? `Python ${run.tool_use}` : "";
    const date = run?.created_at ? new Date(run.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
    return [mode, tools, date].filter(Boolean).join(" · ");
  }

  function companyForRun(run) {
    const model = String(run?.model_name || "").toLowerCase();
    const prefix = model.split("/")[0];
    if (model.startsWith("claude-") || prefix === "anthropic") return "Anthropic";
    if (model.startsWith("gpt-") || prefix === "openai") return "OpenAI";
    if (model.startsWith("gemini-") || prefix === "google") return "Google";
    if (model.startsWith("kimi/") || prefix === "moonshotai") return "Moonshot AI";
    if (model.startsWith("grok-") || prefix === "x-ai") return "xAI";
    const companies = {
      deepseek: "DeepSeek",
      meta: "Meta",
      "meta-llama": "Meta",
      minimax: "MiniMax",
      nvidia: "NVIDIA",
      qwen: "Alibaba",
      stealth: "Stealth",
      xiaomi: "Xiaomi",
      "z-ai": "Z.ai"
    };
    if (companies[prefix]) return companies[prefix];
    if (run?.provider === "claude") return "Anthropic";
    if (run?.provider === "codex") return "OpenAI";
    if (run?.provider === "kimi") return "Moonshot AI";
    if (run?.provider === "prime") return "Prime Intellect";
    return prefix ? prefix.replace(/(^|[-_])\w/g, (match) => match.replace(/[-_]/, " ").toUpperCase()) : "Other";
  }

  function slug(value) {
    return String(value || "company").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "company";
  }

  function colorForRun(id, fallbackIndex = 0) {
    let hash = 0;
    for (const character of String(id || "")) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    return COLORS[(hash + Math.max(0, fallbackIndex)) % COLORS.length];
  }

  function axisFromUrl(name, axes, fallback) {
    const value = new URLSearchParams(window.location.search).get(name);
    return value && Object.hasOwn(axes, value) ? value : fallback;
  }

  function finiteMetric(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function axisTicks(maximum, divisions) {
    return Array.from({ length: divisions + 1 }, (_, index) => maximum * index / divisions);
  }

  function niceMaximum(value, integer = false) {
    const raw = Math.max(1, Number(value) || 1);
    if (integer && raw <= 10) return Math.ceil(raw);
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const normalized = raw / magnitude;
    const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return nice * magnitude;
  }

  function formatInteger(value) {
    return Math.round(Number(value) || 0).toLocaleString();
  }

  function formatCompact(value) {
    const number = Math.max(0, Number(value) || 0);
    return Intl.NumberFormat(undefined, { notation: number >= 1000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(number);
  }

  function formatUsd(value, precise = false) {
    const number = Math.max(0, Number(value) || 0);
    return number.toLocaleString(undefined, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: precise || number < 1 ? 2 : 0,
      maximumFractionDigits: precise || number < 1 ? 4 : 1
    });
  }

  function escapeText(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function svg(name, attributes = {}) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
  }

  function svgText(x, y, text, anchor, className, transform = "") {
    const element = svg("text", { x, y, "text-anchor": anchor, class: className });
    if (transform) element.setAttribute("transform", transform);
    element.textContent = text;
    return element;
  }
})();
