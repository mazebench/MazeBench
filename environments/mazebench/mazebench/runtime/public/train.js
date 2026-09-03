(() => {
  const data = window.__TRAIN_DATA__ || {};
  const ACTION_NAMES = [
    "up",
    "down",
    "left",
    "right",
    "cam up",
    "cam down",
    "cam left",
    "cam right",
    "undo",
    "reset"
  ];
  const state = {
    worker: null,
    runId: "",
    running: false,
    bootstrap: null,
    episodes: [],
    episodeCount: 0,
    selected: -1,
    viewStep: 0,
    playing: false,
    playTimer: 0,
    playRaf: 0,
    scrubbing: false,
    history: { reward: [], fps: [], entropy: [] },
    plannedUpdates: 0,
    chartReset: false,
    chartView: null,
    savedRuns: [],
    liveRun: null
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeText(value) {
    const element = document.createElement("span");
    element.textContent = String(value ?? "");
    return element.innerHTML;
  }

  function setStatus(message, error = false) {
    $("train-status").textContent = message || "";
    $("train-status").classList.toggle("is-error", Boolean(error));
  }

  async function api(url, options) {
    const response = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...options
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
    return payload;
  }

  function numericValue(id, fallback) {
    const value = Number($(id)?.value);
    return Number.isFinite(value) ? value : fallback;
  }

  function applyDefaults(defaults) {
    $("train-reward-gems").value = defaults.gem_reward_weight;
    $("train-reward-rooms").value = defaults.room_reward_weight;
    $("train-reward-blocks").value = defaults.push_reward_weight;
    $("train-envs").value = defaults.n_envs;
    $("train-num-steps").value = defaults.num_steps;
    $("train-max-actions").value = defaults.max_actions;
    $("train-updates").value = defaults.updates;
    $("train-novelty").value = defaults.novelty_bonus;
    $("train-level").value = data.environment?.default_level_id || "level_HxI";
  }

  function setReadiness(ready, label) {
    const el = $("train-readiness");
    el.textContent = label;
    el.classList.toggle("is-ready", ready);
    el.classList.toggle("is-blocked", !ready);
  }

  function configFromForm() {
    return {
      levelId: $("train-level").value.trim() || "level_HxI",
      nEnvs: Math.max(1, numericValue("train-envs", 4)),
      numSteps: Math.max(8, numericValue("train-num-steps", 32)),
      maxActions: Math.max(8, numericValue("train-max-actions", 128)),
      updates: Math.max(1, numericValue("train-updates", 200)),
      gemWeight: numericValue("train-reward-gems", 1),
      roomWeight: numericValue("train-reward-rooms", 0.1),
      pushWeight: numericValue("train-reward-blocks", 0.05),
      noveltyBonus: numericValue("train-novelty", 0.01),
      algorithm: $("train-algorithm")?.value || "ppo",
      saloCoef: 0.08,
      learningRate: 3e-4,
      seed: Date.now() % 1_000_000
    };
  }

  function algorithmLabel(id) {
    return id === "saloppo" ? "SaloPPO · peer memory" : "WebGPU MLP policy";
  }

  function paintCharts() {
    const draw = window.TrainChart && window.TrainChart.drawSeriesChart;
    if (!draw) {
      console.warn("TrainChart failed to load; graphs cannot draw.");
      return;
    }
    const reset = state.chartReset;
    state.chartReset = false;
    draw($("train-chart-reward"), state.history.reward, { color: "#42e8ef", reset });
    draw($("train-chart-fps"), state.history.fps, { color: "#64f5c4", reset });
    draw($("train-chart-entropy"), state.history.entropy, { color: "#ffd15c", pinZero: true, reset });
  }

  function drawCharts() {
    if (state.chartView && state.chartView.schedule) {
      state.chartView.schedule();
      return;
    }
    paintCharts();
  }

  function drawGrid(grid) {
    const canvas = $("episode-grid");
    const ctx = canvas.getContext("2d");
    const size = 16;
    const cell = canvas.width / size;
    const colors = window.TrainEnv?.CELL_COLORS || [];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!grid) return;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        ctx.fillStyle = colors[grid[y * size + x]] || "#8892a8";
        ctx.fillRect(x * cell, y * cell, cell - 1, cell - 1);
      }
    }
  }

  function episodeReward(episode) {
    return Number(episode && episode.reward ? episode.reward : 0);
  }

  function keepBestEpisodes(episodes, candidate, limit = 6) {
    const reward = episodeReward(candidate);
    if (episodes.length < limit) {
      episodes.push(candidate);
      return { index: episodes.length - 1, changed: true };
    }
    let worst = 0;
    for (let i = 1; i < episodes.length; i += 1) {
      if (episodeReward(episodes[i]) < episodeReward(episodes[worst])) worst = i;
    }
    if (reward <= episodeReward(episodes[worst])) return { index: -1, changed: false };
    episodes[worst] = candidate;
    return { index: worst, changed: true };
  }

  function topEpisodes(limit = 6) {
    return state.episodes
      .map((episode, index) => ({ episode, index }))
      .sort((a, b) => {
        const reward = episodeReward(b.episode) - episodeReward(a.episode);
        if (reward) return reward;
        return a.index - b.index;
      })
      .slice(0, limit);
  }

  function renderEpisodeList() {
    const host = $("episode-list");
    const rows = topEpisodes(6);
    if (!rows.length) {
      host.innerHTML = '<div class="train-runs-empty">Top 6 episodes appear here.</div>';
      return;
    }
    host.innerHTML = rows
      .map((row, rank) => {
        const episode = row.episode;
        const selected = row.index === state.selected ? " is-selected" : "";
        const gems = Number(episode.gems || 0);
        const rooms = Number(episode.rooms || 1);
        const reason = String(episode.reason || "done").split("_").join(" ");
        return `<button type="button" class="episode-card${selected}" data-index="${row.index}">
          <span class="episode-card__rank">${rank + 1}</span>
          <span class="episode-card__copy"><strong>${escapeText(episode.levelId || "episode")}</strong><small>${episode.steps || 0} · ${gems}g · ${rooms}r · ${escapeText(reason)}</small></span>
          <span class="episode-card__score">${Number(episode.reward || 0).toFixed(2)}</span>
        </button>`;
      })
      .join("");
    host.querySelectorAll(".episode-card").forEach((card) => {
      card.addEventListener("click", () => selectEpisode(Number(card.dataset.index)));
    });
  }

  function selectEpisode(index) {
    state.selected = index;
    state.viewStep = 0;
    stopPlayback();
    renderEpisodeList();
    const episode = state.episodes[index];
    if (!episode) return;
    $("viewer-meta").textContent = `${episode.levelId} · ${episode.reason || ""} · reward ${Number(episode.reward || 0).toFixed(3)}`;
    const max = Math.max(0, (episode.grids?.length || 1) - 1);
    $("episode-step").disabled = max === 0;
    $("episode-step").max = String(max);
    $("episode-step").value = "0";
    $("episode-prev").disabled = false;
    $("episode-next").disabled = false;
    $("episode-play").disabled = false;
    showStep(0);
  }

  function stopPlayback() {
    state.playing = false;
    $("episode-play").textContent = "Play";
    window.clearInterval(state.playTimer);
    if (state.playRaf) {
      window.cancelAnimationFrame(state.playRaf);
      state.playRaf = 0;
    }
  }

  function showStep(step) {
    const episode = state.episodes[state.selected];
    if (!episode) return;
    const max = Math.max(0, (episode.grids?.length || 1) - 1);
    const next = Math.max(0, Math.min(max, Math.trunc(step)));
    if (next !== state.viewStep && Math.abs(next - state.viewStep) > 1 && !state.scrubbing) {
      state.viewStep += next > state.viewStep ? 1 : -1;
    } else {
      state.viewStep = next;
    }
    $("episode-step").value = String(state.viewStep);
    drawGrid(episode.grids?.[state.viewStep]);
    const action = ACTION_NAMES[episode.actions?.[Math.max(0, state.viewStep - 1)]] || "start";
    const reward = episode.rewards?.[Math.max(0, state.viewStep - 1)];
    const room = episode.levelIds?.[state.viewStep] || episode.levelId;
    $("episode-log").textContent = `step ${state.viewStep}/${max}\nroom ${room}\naction ${action}\nreward ${reward == null ? "—" : Number(reward).toFixed(4)}\ngems ${episode.gems}  rooms ${episode.rooms}`;
  }

  function runScore(run) {
    const reward = Number(run.bestReward);
    if (Number.isFinite(reward)) return reward;
    const episode = Number(run.bestEpisodeReward);
    return Number.isFinite(episode) ? episode : Number(run.lastReward) || 0;
  }

  function leaderboardRows(runs) {
    const rows = Array.isArray(runs) ? runs.slice() : [];
    if (state.liveRun) {
      const index = rows.findIndex((run) => run.id === state.liveRun.id);
      if (index >= 0) rows[index] = { ...rows[index], ...state.liveRun };
      else rows.push(state.liveRun);
    }
    return rows.sort((a, b) => runScore(b) - runScore(a)).slice(0, 5);
  }

  function renderRuns(runs) {
    if (runs) state.savedRuns = runs;
    const host = $("training-runs");
    const top = leaderboardRows(state.savedRuns);
    if (!top.length) {
      host.innerHTML = '<li class="train-leaderboard-empty">Top 5 agents appear here.</li>';
      return;
    }
    host.innerHTML = top
      .map((run, index) => {
        const live = run.live || run.id === state.runId ? " is-live" : "";
        const fps = Number(run.lastFps);
        const gems = Number(run.lastGems ?? run.bestGems);
        return `<li>
          <button type="button" class="train-leaderboard-row${live}" data-run="${escapeText(run.id || "")}">
            <span class="train-leaderboard-row__rank">${index + 1}</span>
            <span class="train-leaderboard-row__who"><strong>${escapeText(run.name || run.id || "agent")}</strong><small>${escapeText(run.adapter || "WebGPU")}${
          Number.isFinite(fps) ? ` · ${fps.toFixed(0)} fps` : ""
        }</small></span>
            <span class="train-leaderboard-row__score"><strong>${runScore(run).toFixed(3)}</strong><small>${
          Number.isFinite(gems) ? `${gems.toFixed(1)} gems` : "reward"
        }</small></span>
          </button>
        </li>`;
      })
      .join("");
    host.querySelectorAll("[data-run]").forEach((card) => {
      card.addEventListener("click", () => loadSavedRun(card.dataset.run));
    });
  }

  async function loadSavedRun(id) {
    try {
      const run = await api(`${data.runsUrl}/${encodeURIComponent(id)}`);
      const loaded = run.episodes || [];
      state.episodeCount = loaded.length;
      state.episodes = [];
      loaded.forEach((episode) => keepBestEpisodes(state.episodes, episode, 6));
      const metrics = run.metrics || [];
      state.history = {
        reward: metrics.map((item) => Number(item.rewardMean || 0)),
        fps: metrics.map((item) => Number(item.fps || 0)),
        entropy: metrics.map((item) => Number(item.entropy || 0))
      };
      state.plannedUpdates = Math.max(metrics.length, Number(run.config?.updates) || 0);
      state.chartReset = true;
      renderEpisodeList();
      drawCharts();
      if (state.episodes.length) {
        const best = topEpisodes(1)[0];
        selectEpisode(best ? best.index : 0);
      }
      setStatus(`Loaded ${run.id} (${state.episodeCount} episodes).`);
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  async function loadRuns() {
    try {
      const payload = await api(`${data.runsUrl}${data.runsUrl.includes("?") ? "&" : "?"}limit=50`);
      renderRuns(payload.runs || []);
    } catch (error) {
      $("training-runs").innerHTML = `<div class="train-runs-empty is-error">${escapeText(error.message)}</div>`;
    }
  }

  function setMetric(id, value, digits = 3) {
    $(id).textContent = Number(value || 0).toFixed(digits);
  }

  function handleWorkerMessage(event) {
    const message = event.data || {};
    if (message.type === "ready") {
      $("train-adapter").textContent = message.gpu?.adapter || "WebGPU";
      setReadiness(true, "WEBGPU READY");
      setStatus("Training on WebGPU…");
    }
    if (message.type === "update") {
      const metrics = message.metrics || {};
      state.history.reward.push(Number(metrics.rewardMean || 0));
      state.history.fps.push(Number(metrics.fps || 0));
      state.history.entropy.push(Number(metrics.entropy || 0));
      drawCharts();
      setMetric("metric-reward", metrics.rewardMean);
      setMetric("metric-gems", metrics.gemsMean);
      setMetric("metric-rooms", metrics.roomsMean, 2);
      setMetric("metric-fps", metrics.fps, 1);
      setMetric("metric-entropy", metrics.entropy);
      $("metric-episodes").textContent = String(state.episodeCount);
      state.liveRun = {
        id: state.runId || "live",
        name: "Live agent",
        status: "running",
        live: true,
        adapter: metrics.adapter || "WebGPU",
        lastReward: metrics.rewardMean,
        bestReward: Math.max(Number(state.liveRun?.bestReward) || -Infinity, Number(metrics.rewardMean) || 0),
        lastFps: metrics.fps,
        lastGems: metrics.gemsMean,
        episodes: state.episodeCount
      };
      renderRuns();
      $("train-live-update").textContent = `update ${metrics.update} · ${metrics.adapter || "WebGPU"}`;
      if (state.runId) {
        api(`${data.runsUrl}/${encodeURIComponent(state.runId)}/metrics`, {
          method: "POST",
          body: JSON.stringify(metrics)
        }).catch(() => {});
      }
    }
    if (message.type === "episode") {
      const episode = message.episode;
      state.episodeCount += 1;
      const placed = keepBestEpisodes(state.episodes, episode, 6);
      $("metric-episodes").textContent = String(state.episodeCount);
      if (state.selected < 0 && placed.changed) selectEpisode(placed.index);
      else if (placed.changed && placed.index === state.selected) selectEpisode(placed.index);
      else renderEpisodeList();
      if (state.runId) {
        const slim = {
          reward: episode.reward,
          gems: episode.gems,
          rooms: episode.rooms,
          steps: episode.steps,
          reason: episode.reason,
          levelId: episode.levelId,
          actions: episode.actions,
          rewards: episode.rewards,
          levelIds: episode.levelIds,
          grids: episode.grids
        };
        api(`${data.runsUrl}/${encodeURIComponent(state.runId)}/episodes`, {
          method: "POST",
          body: JSON.stringify(slim)
        }).catch(() => {});
      }
    }
    if (message.type === "error") {
      stopTraining();
      setReadiness(false, "WEBGPU ERROR");
      setStatus(message.error, true);
    }
    if (message.type === "done") {
      stopTraining(false);
      setStatus("Training finished.");
      loadRuns();
    }
  }

  async function startTraining() {
    if (state.running) return;
    if (!state.bootstrap?.playData) {
      setStatus("World data is not loaded yet.", true);
      return;
    }
    if (!("gpu" in navigator)) {
      setReadiness(false, "NO WEBGPU");
      setStatus("This browser has no WebGPU. Use a Chromium build with GPU enabled.", true);
      return;
    }
    const config = configFromForm();
    $("train-launch-model").textContent = algorithmLabel(config.algorithm);
    state.episodes = [];
    state.episodeCount = 0;
    state.selected = -1;
    state.history = { reward: [], fps: [], entropy: [] };
    state.plannedUpdates = config.updates;
    state.chartReset = true;
    state.liveRun = { id: "live", name: "Live agent", status: "running", live: true, bestReward: -Infinity };
    renderRuns();
    drawCharts();
    $("launch-training").disabled = true;
    $("stop-training").disabled = false;
    setStatus("Starting WebGPU worker…");
    try {
      const run = await api(data.runsUrl, {
        method: "POST",
        body: JSON.stringify({ name: `WebGPU PPO · ${config.levelId}`, config, adapter: "webgpu" })
      });
      state.runId = run.id;
    } catch (_error) {
      state.runId = "";
    }
    state.running = true;
    state.worker = new Worker(data.workerUrl || "/train-worker.js");
    state.worker.onmessage = handleWorkerMessage;
    state.worker.onerror = (error) => {
      setStatus(error.message || "Worker failed", true);
      stopTraining();
    };
    state.worker.postMessage({ type: "start", config, startPlayData: state.bootstrap.playData });
  }

  function stopTraining(terminate = true) {
    state.running = false;
    if (state.worker) {
      try {
        state.worker.postMessage({ type: "stop" });
      } catch (_error) {
        /* already gone */
      }
      if (terminate) state.worker.terminate();
      state.worker = null;
    }
    $("launch-training").disabled = false;
    $("stop-training").disabled = true;
    if (state.liveRun) {
      state.liveRun.live = false;
      state.liveRun.status = "finished";
      renderRuns();
    }
    if (state.runId) {
      api(`${data.runsUrl}/${encodeURIComponent(state.runId)}`, {
        method: "POST",
        body: JSON.stringify({ status: "finished" })
      }).catch(() => {});
    }
  }

  $("train-algorithm")?.addEventListener("change", () => {
    $("train-launch-model").textContent = algorithmLabel($("train-algorithm").value);
  });
  $("launch-training")?.addEventListener("click", startTraining);
  $("stop-training")?.addEventListener("click", () => {
    stopTraining();
    setStatus("Stopped.");
  });
  $("refresh-training-runs")?.addEventListener("click", loadRuns);
  $("episode-step")?.addEventListener("pointerdown", () => {
    state.scrubbing = true;
  });
  window.addEventListener("pointerup", () => {
    state.scrubbing = false;
  });
  $("episode-step")?.addEventListener("input", (event) => showStep(Number(event.target.value)));
  $("episode-prev")?.addEventListener("click", () => showStep(state.viewStep - 1));
  $("episode-next")?.addEventListener("click", () => showStep(state.viewStep + 1));
  $("episode-play")?.addEventListener("click", () => {
    if (state.playing) {
      stopPlayback();
      return;
    }
    state.playing = true;
    $("episode-play").textContent = "Pause";
    let lastTick = 0;
    const tick = (now) => {
      if (!state.playing) return;
      if (now - lastTick >= 160) {
        lastTick = now;
        const episode = state.episodes[state.selected];
        const max = Math.max(0, (episode?.grids?.length || 1) - 1);
        if (state.viewStep >= max) {
          stopPlayback();
          return;
        }
        showStep(state.viewStep + 1);
      }
      state.playRaf = window.requestAnimationFrame(tick);
    };
    state.playRaf = window.requestAnimationFrame(tick);
  });

  async function boot() {
    try {
      if (!("gpu" in navigator)) {
        setReadiness(false, "NO WEBGPU");
        setStatus("WebGPU is required for this train page.", true);
      } else {
        setReadiness(true, "WEBGPU AVAILABLE");
      }
      const payload = await api(data.bootstrapUrl);
      state.bootstrap = payload;
      applyDefaults(payload.defaults || {});
      $("train-launch-environment").textContent = `${payload.environment.title} · ${payload.environment.room_total} rooms · ${payload.environment.gem_total} gems`;
      await loadRuns();
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  if (window.TrainChart && window.TrainChart.watch) {
    state.chartView = window.TrainChart.watch(
      [$("train-chart-reward"), $("train-chart-fps"), $("train-chart-entropy")],
      paintCharts
    );
  } else {
    window.addEventListener("resize", () => drawCharts());
  }
  boot();
  drawCharts();
})();
