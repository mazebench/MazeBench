/* global importScripts, MazeEngine, TrainEnv, TrainPpo, TrainProfile */
self.window = self;
importScripts(
  "/maze-engine.js",
  "/train-env.js?v=20260901-gpu-rollout-19",
  "/train-ppo-webgpu.js?v=20260901-gpu-rollout-19",
  "/train-profile.js"
);

const playCache = new Map();
let running = false;
let ppo = null;
let profiler = null;
let carryCaptures = null;
let saloMemory = null;

async function fetchPlayData(levelId) {
  if (playCache.has(levelId)) return playCache.get(levelId);
  const response = await fetch(`/api/play/maze/${encodeURIComponent(levelId)}`);
  if (!response.ok) throw new Error(`Failed to load ${levelId}`);
  const playData = await response.json();
  playCache.set(levelId, playData);
  return playData;
}

async function createEnv(config, startPlayData) {
  playCache.set(config.levelId, startPlayData);
  const env = new TrainEnv.MazeTrainEnv({
    playCache,
    fetchPlayData,
    profiler,
    startLevelId: config.levelId,
    maxActions: config.maxActions,
    gemWeight: config.gemWeight,
    roomWeight: config.roomWeight,
    pushWeight: config.pushWeight,
    noveltyBonus: config.noveltyBonus,
    worldColumns: startPlayData.worldColumns,
    worldRows: startPlayData.worldRows,
    prefetchWorld: true
  });
  await env.reset();
  return env;
}

function createTrace(obs) {
  return {
    grids: [Array.from(obs.grid)],
    actions: [],
    rewards: [],
    levelIds: [obs.levelId]
  };
}

function liveMask() {
  return [true, true, true, true, true, true, true, true, true, true];
}

function deadMask() {
  return [false, false, false, false, false, false, false, false, true, true];
}

async function collect(envs, steps, traces, config) {
  const n = envs.length;
  const batchEnvs = envs;
  const captures =
    carryCaptures && carryCaptures.length === n
      ? carryCaptures
      : batchEnvs.map((env) => {
          const cap = env.gpuCapture();
          cap.episodeReward = 0;
          return cap;
        });
  const saloOn = config.algorithm === "saloppo";
  const rolled = await ppo.gpuRollout(captures, steps, {
    maxActions: config.maxActions || Math.max(steps + 32, 64),
    seed: (config.seed || 1) + (ppo.adamT || 0),
    gemWeight: config.gemWeight,
    roomWeight: config.roomWeight,
    pushWeight: config.pushWeight,
    noveltyBonus: config.noveltyBonus,
    deathPenalty: config.deathPenalty,
    saloCoef: saloOn ? config.saloCoef ?? 0.08 : 0,
    meanScore: saloMemory ? saloMemory.meanScore : 0,
    bestScore: saloMemory ? saloMemory.bestScore : 0,
    peerVisit: saloOn && saloMemory ? saloMemory.visit : null,
    peerScore: saloOn && saloMemory ? saloMemory.quality : null
  });
  const storage = {
    observations: [],
    actions: [],
    logp: [],
    rewards: [],
    dones: [],
    values: [],
    infos: []
  };
  const gemCount = captures.map((cap) => cap.gemCount || 0);
  const episodeReward = captures.map((cap) => Number(cap.episodeReward) || 0);
  traces.forEach((trace, i) => {
    if (i >= n) return;
    if (!trace) {
      traces[i] = {
        grids: [Array.from(captures[i].grid)],
        actions: [],
        rewards: [],
        levelIds: [batchEnvs[i].levelId]
      };
    }
  });

  for (let t = 0; t < steps; t += 1) {
    const observations = [];
    const infos = [];
    for (let b = 0; b < n; b += 1) {
      const reward = rolled.rewards[t][b];
      const done = rolled.dones[t][b];
      episodeReward[b] += reward;
      if (reward >= 0.99) gemCount[b] += 1;
      const grid = rolled.grids && rolled.grids[t] ? rolled.grids[t][b] : captures[b].grid;
      const aux = TrainEnv.encodeAux(
        {
          yaw: rolled.nextCaptures[b].yaw,
          pitch: rolled.nextCaptures[b].pitch,
          playerDead: rolled.nextCaptures[b].dead || done,
          gemCount: gemCount[b],
          visited: [batchEnvs[b].levelId],
          actionCount: captures[b].actionCount + t + 1,
          novelPushCount: 0,
          moved: true
        },
        config.maxActions || 128
      );
      observations.push({
        grid,
        aux,
        mask: done || captures[b].dead ? deadMask() : liveMask(),
        levelId: batchEnvs[b].levelId,
        peerVisit: saloOn && saloMemory ? saloMemory.visit : null,
        peerScore: saloOn && saloMemory ? saloMemory.quality : null,
        ownScore: Math.tanh(episodeReward[b] * 0.25),
        meanScore: Math.tanh(((saloMemory && saloMemory.meanScore) || 0) * 0.25),
        bestGap: Math.tanh((((saloMemory && saloMemory.bestScore) || 0) - episodeReward[b]) * 0.25)
      });
      infos.push({
        gemCount: gemCount[b],
        rooms: 1,
        episodeReward: episodeReward[b],
        reason: done ? "max_actions" : "",
        levelId: batchEnvs[b].levelId,
        action: rolled.actions[t][b]
      });
      traces[b].grids.push(Array.from(grid));
      traces[b].actions.push(rolled.actions[t][b]);
      traces[b].rewards.push(reward);
      traces[b].levelIds.push(batchEnvs[b].levelId);
    }
    storage.observations.push(observations);
    storage.actions.push(rolled.actions[t]);
    storage.logp.push(rolled.logp[t]);
    storage.values.push(rolled.values[t]);
    storage.rewards.push(rolled.rewards[t]);
    storage.dones.push(rolled.dones[t]);
    storage.infos.push(infos);
  }

  const next = rolled.nextCaptures.slice();
  for (let b = 0; b < n; b += 1) {
    const ended = rolled.dones[steps - 1][b] || next[b].actionCount >= (config.maxActions || 128);
    next[b].episodeReward = ended ? 0 : episodeReward[b];
    next[b].gemCount = gemCount[b];
    if (!ended) continue;
    self.postMessage({
      type: "episode",
      episode: {
        reward: episodeReward[b],
        gems: gemCount[b],
        rooms: 1,
        steps: traces[b].actions.length,
        reason: rolled.dones[steps - 1][b] ? "done" : "max_actions",
        levelId: batchEnvs[b].levelId,
        grids: traces[b].grids,
        actions: traces[b].actions,
        rewards: traces[b].rewards,
        levelIds: traces[b].levelIds
      }
    });
    await batchEnvs[b].reset();
    traces[b] = null;
    const fresh = batchEnvs[b].gpuCapture();
    fresh.episodeReward = 0;
    next[b] = fresh;
  }
  carryCaptures = next;
  if (saloOn && saloMemory && TrainPpo.updateSaloMemory) {
    TrainPpo.updateSaloMemory(saloMemory, storage);
  }

  const lastValues = rolled.values[rolled.values.length - 1].slice();
  return { storage, lastValues };
}

function flatten(storage, advantages, returns) {
  const observations = [];
  const actions = [];
  const logp = [];
  const adv = [];
  const ret = [];
  for (let t = 0; t < storage.observations.length; t += 1) {
    for (let n = 0; n < storage.observations[t].length; n += 1) {
      observations.push(storage.observations[t][n]);
      actions.push(storage.actions[t][n]);
      logp.push(storage.logp[t][n]);
      adv.push(advantages[t][n]);
      ret.push(returns[t][n]);
    }
  }
  const mean = adv.reduce((sum, value) => sum + value, 0) / Math.max(1, adv.length);
  const variance = adv.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, adv.length);
  const std = Math.sqrt(variance) + 1e-8;
  return {
    observations,
    actions,
    logp,
    advantages: adv.map((value) => (value - mean) / std),
    returns: ret
  };
}

function rolloutMetrics(storage) {
  const rewards = storage.rewards.flat();
  const finished = [];
  storage.infos.forEach((step, t) => {
    step.forEach((info, n) => {
      if (storage.dones[t][n]) finished.push(info);
    });
  });
  const latest = storage.infos[storage.infos.length - 1] || [];
  const source = finished.length ? finished : latest;
  const returns = latest.map((info) => Number(info.episodeReward) || 0);
  return {
    rewardMean:
      returns.length > 0
        ? returns.reduce((sum, value) => sum + value, 0) / returns.length
        : rewards.reduce((sum, value) => sum + value, 0) / Math.max(1, rewards.length),
    gemsMean: source.reduce((sum, info) => sum + (info.gemCount || 0), 0) / Math.max(1, source.length),
    roomsMean: source.reduce((sum, info) => sum + (info.rooms || 0), 0) / Math.max(1, source.length),
    episodes: finished.length
  };
}

async function runLoop(config, startPlayData, { once = false } = {}) {
  profiler = TrainProfile.createProfiler();
  running = true;
  ppo = new TrainPpo.WebGpuPpo({ profiler });
  const gpu = await profiler.span("ppo.init", () => ppo.init(config.seed || 1));
  self.postMessage({ type: "ready", gpu });
  const envs = [];
  await profiler.span("createEnvs", async () => {
    config.nEnvs = Math.max(1, config.nEnvs || 1);
    for (let i = 0; i < config.nEnvs; i += 1) {
      envs.push(await createEnv(config, startPlayData));
    }
  });
  const traces = new Array(config.nEnvs).fill(null);
  carryCaptures = null;
  saloMemory = TrainPpo.createSaloMemory ? TrainPpo.createSaloMemory() : null;
  let update = 0;
  while (running && update < config.updates) {
    update += 1;
    const started = Date.now();
    const { storage, lastValues } = await profiler.span("collect", () =>
      collect(envs, config.numSteps, traces, config)
    );
    const { advantages, returns } = await profiler.span("gae", () =>
      TrainPpo.computeGae(storage.rewards, storage.values, storage.dones, lastValues, 0.99, 0.95)
    );
    const batch = await profiler.span("flatten", () => flatten(storage, advantages, returns));
    const losses = await ppo.updateRollout(batch, {
      clip: 0.2,
      valueCoef: 0.5,
      entropyCoef: config.entropyCoef == null ? 0.01 : config.entropyCoef,
      lr: config.learningRate || 3e-4
    });
    const envMetrics = rolloutMetrics(storage);
    const seconds = (Date.now() - started) / 1000;
    const payload = {
      type: once ? "profile" : "update",
      metrics: {
        update,
        frames: config.nEnvs * config.numSteps,
        fps: (config.nEnvs * config.numSteps) / Math.max(seconds, 1e-6),
        seconds,
        adapter: gpu.adapter,
        ...envMetrics,
        ...losses
      },
      profile: profiler.report(),
      profileText: profiler.format()
    };
    self.postMessage(payload);
    if (once) break;
  }
  if (!once) self.postMessage({ type: "done", update });
}

self.onmessage = async (event) => {
  const message = event.data || {};
  try {
    if (message.type === "stop") {
      running = false;
      return;
    }
    if (message.type === "profile") {
      const config = {
        nEnvs: 1,
        numSteps: 1,
        updates: 1,
        maxActions: 8,
        ...message.config
      };
      config.nEnvs = Math.max(1, config.nEnvs || 1);
      config.numSteps = Math.max(1, config.numSteps || 1);
      config.updates = 1;
      await runLoop(config, message.startPlayData, { once: true });
      return;
    }
    if (message.type !== "start") return;
    await runLoop(message.config, message.startPlayData, { once: false });
  } catch (error) {
    running = false;
    self.postMessage({ type: "error", error: error.message || String(error) });
  }
};
