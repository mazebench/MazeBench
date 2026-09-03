#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { adapterLabel, installWebGpu } = require("./webgpu-node");
const { loadTrainHarness } = require("./load-train-harness");
const { withGpuLock } = require("./train-opt-lock");
const store = require("./train-opt-store");
const core = require("./train-sweep-core");

function liveMask() {
  return [true, true, true, true, true, true, true, true, true, true];
}

function deadMask() {
  return [false, false, false, false, false, false, false, false, true, true];
}

function installSignalExits(proc = process) {
  const onInterrupt = () => proc.exit(130);
  const onTerminate = () => proc.exit(143);
  proc.once("SIGINT", onInterrupt);
  proc.once("SIGTERM", onTerminate);
  return () => {
    proc.off("SIGINT", onInterrupt);
    proc.off("SIGTERM", onTerminate);
  };
}

function destroyCachedBuffers(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (typeof value.destroy === "function") {
    value.destroy();
    return;
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
  if (value instanceof Map) {
    for (const item of value.values()) destroyCachedBuffers(item, seen);
    return;
  }
  for (const item of Object.values(value)) destroyCachedBuffers(item, seen);
}

function releaseTrialBuffers(ppo) {
  for (const name of ["scratch", "staging", "uniformCache"]) {
    const cache = ppo && ppo[name];
    if (!(cache instanceof Map)) continue;
    destroyCachedBuffers(cache);
    cache.clear();
  }
  if (ppo && ppo.zeroHost instanceof Map) ppo.zeroHost.clear();
}

function startPlayData(levelId) {
  const { getGame, getLevel, getLevelState, defaultLevelIdForGame } = require("../server/app");
  const game = getGame("maze");
  const id = levelId || defaultLevelIdForGame(game);
  const level = getLevel(game, id);
  if (!level) throw new Error(`missing level ${id}`);
  return { levelId: id, playData: getLevelState(game, level) };
}

async function createEnv(TrainEnv, config, play) {
  const { getGame, getLevel, getLevelState } = require("../server/app");
  const env = new TrainEnv.MazeTrainEnv({
    playCache: new Map([[play.levelId, play.playData]]),
    fetchPlayData: async (id) => {
      const game = getGame("maze");
      const level = getLevel(game, id);
      if (!level) throw new Error(`missing ${id}`);
      return getLevelState(game, level);
    },
    startLevelId: play.levelId,
    maxActions: config.maxActions,
    gemWeight: config.gemWeight,
    roomWeight: config.roomWeight,
    pushWeight: config.pushWeight,
    noveltyBonus: config.noveltyBonus,
    deathPenalty: config.deathPenalty,
    prefetchWorld: false
  });
  await env.reset();
  return env;
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
  const latest = storage.infos[storage.infos.length - 1] || [];
  const finished = [];
  storage.infos.forEach((step, t) => {
    step.forEach((info, n) => {
      if (storage.dones[t][n]) finished.push(info);
    });
  });
  const source = finished.length ? finished : latest;
  const returns = latest.map((info) => Number(info.episodeReward) || 0);
  return {
    rewardMean:
      returns.length > 0 ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0,
    gemsMean: source.reduce((sum, info) => sum + (info.gemCount || 0), 0) / Math.max(1, source.length),
    roomsMean: source.reduce((sum, info) => sum + (info.rooms || 0), 0) / Math.max(1, source.length)
  };
}

async function collect(ppo, TrainEnv, TrainPpo, envs, captures, steps, config, saloMemory) {
  const n = envs.length;
  const saloOn = config.algorithm === "saloppo";
  const rolled = await ppo.gpuRollout(captures, steps, {
    maxActions: config.maxActions,
    seed: (config.seed || 1) + (ppo.adamT || 0),
    gemWeight: config.gemWeight,
    roomWeight: config.roomWeight,
    pushWeight: config.pushWeight,
    noveltyBonus: config.noveltyBonus,
    deathPenalty: config.deathPenalty,
    saloCoef: saloOn ? config.saloCoef || 0 : 0,
    meanScore: saloMemory ? saloMemory.meanScore : 0,
    bestScore: saloMemory ? saloMemory.bestScore : 0,
    peerVisit: saloOn && saloMemory ? saloMemory.visit : null,
    peerScore: saloOn && saloMemory ? saloMemory.quality : null
  });
  const storage = {
    observations: [],
    actions: [],
    logp: [],
    values: [],
    rewards: [],
    dones: [],
    infos: []
  };
  const gemCount = captures.map((cap) => cap.gemCount || 0);
  const episodeReward = captures.map((cap) => Number(cap.episodeReward) || 0);
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
          visited: [envs[b].levelId],
          actionCount: (captures[b].actionCount || 0) + t + 1,
          novelPushCount: 0,
          moved: true
        },
        config.maxActions
      );
      observations.push({
        grid,
        aux,
        mask: done || captures[b].dead ? deadMask() : liveMask(),
        peerVisit: saloOn && saloMemory ? saloMemory.visit : null,
        peerScore: saloOn && saloMemory ? saloMemory.quality : null,
        ownScore: Math.tanh(episodeReward[b] * 0.25),
        meanScore: Math.tanh(((saloMemory && saloMemory.meanScore) || 0) * 0.25),
        bestGap: Math.tanh((((saloMemory && saloMemory.bestScore) || 0) - episodeReward[b]) * 0.25)
      });
      infos.push({
        gemCount: gemCount[b],
        rooms: rolled.nextCaptures[b].visited
          ? rolled.nextCaptures[b].visited.reduce((sum, word) => {
              let bits = word | 0;
              let count = 0;
              while (bits) {
                bits &= bits - 1;
                count += 1;
              }
              return sum + count;
            }, 0)
          : 1,
        episodeReward: episodeReward[b]
      });
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
    const ended = rolled.dones[steps - 1][b] || next[b].actionCount >= config.maxActions;
    next[b].episodeReward = ended ? 0 : episodeReward[b];
    next[b].gemCount = gemCount[b];
    if (!ended) continue;
    await envs[b].reset();
    const fresh = envs[b].gpuCapture();
    fresh.episodeReward = 0;
    next[b] = fresh;
  }
  if (saloOn && saloMemory && TrainPpo.updateSaloMemory) TrainPpo.updateSaloMemory(saloMemory, storage);
  return { storage, lastValues: rolled.values[rolled.values.length - 1].slice(), next };
}

function zeroBuffer(ppo, buffer, floats) {
  if (!buffer || !ppo.device) return;
  const bytes = Math.max(4, floats * 4);
  ppo.zero(buffer, bytes);
}

function reseedPpo(ppo, TrainPpo, seed) {
  const vanilla = TrainPpo.createRollPolicy(seed + 17, TrainPpo.ROLL_IN);
  const salo = TrainPpo.createRollPolicy(seed + 19, TrainPpo.SALO_IN);
  ppo.device.queue.writeBuffer(ppo.rollW, 0, vanilla.weights);
  ppo.device.queue.writeBuffer(ppo.rollWSalo, 0, salo.weights);
  ppo.rollWHost = vanilla.weights;
  if (ppo.rollParam) {
    zeroBuffer(ppo, ppo.rollParam.m, ppo.rollParam.length);
    zeroBuffer(ppo, ppo.rollParam.v, ppo.rollParam.length);
    zeroBuffer(ppo, ppo.rollParam.grad, ppo.rollParam.length);
  }
  if (ppo.rollParamSalo) {
    zeroBuffer(ppo, ppo.rollParamSalo.m, ppo.rollParamSalo.length);
    zeroBuffer(ppo, ppo.rollParamSalo.v, ppo.rollParamSalo.length);
    zeroBuffer(ppo, ppo.rollParamSalo.grad, ppo.rollParamSalo.length);
  }
  ppo.adamT = 0;
  ppo.rollAdam = { t: 0 };
}

async function runTrial(ctx, candidate, budgetSec, trialSeed) {
  const { ppo, TrainEnv, TrainPpo, play, resourceMonitor } = ctx;
  const config = { ...core.clampConfig(candidate.config), seed: trialSeed };
  const nEnvs = config.nEnvs;
  if (resourceMonitor) await resourceMonitor.checkpoint(`trial ${ctx.trialIndex} allocation`);
  reseedPpo(ppo, TrainPpo, trialSeed);
  const envs = [];
  for (let i = 0; i < nEnvs; i += 1) envs.push(await createEnv(TrainEnv, config, play));
  let captures = envs.map((env) => {
    const cap = env.gpuCapture();
    cap.episodeReward = 0;
    return cap;
  });
  const saloMemory = TrainPpo.createSaloMemory();
  const resourceStart = resourceMonitor ? resourceMonitor.summary() : { pauseCount: 0, pausedMs: 0 };
  const started = performance.now();
  let deadline = started + budgetSec * 1000;
  let updates = 0;
  let frames = 0;
  let peakReward = -Infinity;
  let peakGems = 0;
  let peakRooms = 0;
  let last = { rewardMean: 0, gemsMean: 0, roomsMean: 0 };
  try {
    while (performance.now() < deadline) {
      if (resourceMonitor) {
        const pausedBefore = resourceMonitor.summary().pausedMs;
        await resourceMonitor.checkpoint(`trial ${ctx.trialIndex}`);
        deadline += resourceMonitor.summary().pausedMs - pausedBefore;
      }
      if (performance.now() >= deadline) break;
      const { storage, lastValues, next } = await collect(
        ppo,
        TrainEnv,
        TrainPpo,
        envs,
        captures,
        config.numSteps,
        config,
        saloMemory
      );
      captures = next;
      const { advantages, returns } = TrainPpo.computeGae(
        storage.rewards,
        storage.values,
        storage.dones,
        lastValues,
        config.gamma,
        config.gaeLam
      );
      const batch = flatten(storage, advantages, returns);
      await ppo.updateRollout(batch, {
        clip: config.clip,
        valueCoef: config.valueCoef,
        entropyCoef: config.entropyCoef,
        lr: config.learningRate
      });
      last = rolloutMetrics(storage);
      if (last.rewardMean > peakReward) peakReward = last.rewardMean;
      if (last.gemsMean > peakGems) peakGems = last.gemsMean;
      if (last.roomsMean > peakRooms) peakRooms = last.roomsMean;
      updates += 1;
      frames += nEnvs * config.numSteps;
    }
  } finally {
    releaseTrialBuffers(ppo);
  }
  const resourceEnd = resourceMonitor ? resourceMonitor.summary() : null;
  const trialPausedMs = resourceEnd ? resourceEnd.pausedMs - resourceStart.pausedMs : 0;
  const seconds = Math.max(0, performance.now() - started - trialPausedMs) / 1000;
  const metrics = {
    peakReward: Number.isFinite(peakReward) ? peakReward : last.rewardMean,
    peakGems,
    peakRooms,
    lastReward: last.rewardMean,
    lastGems: last.gemsMean,
    lastRooms: last.roomsMean,
    updates,
    frames,
    seconds,
    fps: frames / Math.max(seconds, 1e-6),
    resources: resourceEnd
      ? {
          ...resourceEnd,
          pauseCount: resourceEnd.pauseCount - resourceStart.pauseCount,
          pausedMs: trialPausedMs
        }
      : null
  };
  return {
    id: `g${ctx.generation}-t${ctx.trialIndex}`,
    config,
    origin: candidate.origin,
    metrics,
    score: core.scoreMetrics(metrics),
    createdAt: new Date().toISOString()
  };
}

function printTrial(trial, best) {
  const c = trial.config;
  const score = Number.isFinite(trial.score) ? trial.score : -Infinity;
  const delta = best && trial.id !== best.id ? score - best.score : 0;
  const mark = !best || score >= best.score ? "BEST" : delta.toFixed(3);
  const metrics = trial.metrics || {};
  const resources = metrics.resources || {};
  console.log(
    [
      trial.id,
      mark,
      `score=${Number.isFinite(score) ? score.toFixed(3) : "fail"}`,
      `rew=${Number(metrics.peakReward || 0).toFixed(3)}`,
      `gem=${Number(metrics.peakGems || 0).toFixed(2)}`,
      `upd=${metrics.updates || 0}`,
      `fps=${Number(metrics.fps || 0).toFixed(0)}`,
      `${c.algorithm}`,
      `envs=${c.nEnvs}`,
      `steps=${c.numSteps}`,
      `lr=${c.learningRate}`,
      `entropy=${c.entropyCoef}`,
      `value=${c.valueCoef}`,
      resources.peakRssMb ? `rss=${resources.peakRssMb.toFixed(0)}MB` : null,
      resources.peakCpuPercent != null ? `cpu=${resources.peakCpuPercent.toFixed(1)}%` : null
    ]
      .filter(Boolean)
      .join("  ")
  );
}

function printStatus(state, dir) {
  console.log(`sweep dir ${dir}`);
  console.log(`generation ${state.generation}  trials ${state.trials}`);
  if (state.resources) {
    console.log(
      `resources peak-rss=${Number(state.resources.peakRssMb || 0).toFixed(0)}MB min-free=${Number(state.resources.minFreeMemMb || 0).toFixed(0)}MB peak-cpu=${Number(state.resources.peakCpuPercent || 0).toFixed(1)}% pauses=${state.resources.pauseCount || 0}`
    );
  }
  if (state.stopReason) console.log(`last stop: ${state.stopReason}`);
  if (!state.best) {
    console.log("no trials yet");
    return;
  }
  console.log(
    `best score=${state.best.score.toFixed(3)} reward=${(state.best.metrics.peakReward || 0).toFixed(3)}`
  );
  console.log(`best config ${core.KEYS.map((key) => `${key}=${state.best.config[key]}`).join(" ")}`);
}

async function runSweep(flags) {
  core.pinConfig(core.DEFAULT_CONFIG, flags);
  const dir = flags.dir;
  let state = core.loadState(dir);
  delete state.stopReason;
  const rng = core.mulberry32((flags.seed + state.trials * 997) >>> 0);
  const resourceMonitor = core.createResourceMonitor(flags, {
    logger: (message) => console.log(`resource guard: ${message}`)
  });
  await resourceMonitor.checkpoint("startup");
  const gpu = await installWebGpu();
  const { TrainEnv, TrainPpo } = loadTrainHarness();
  const ppo = new TrainPpo.WebGpuPpo();
  const ready = await ppo.init(flags.seed);
  const play = startPlayData(flags.level);
  const ctx = {
    ppo,
    TrainEnv,
    TrainPpo,
    play,
    resourceMonitor,
    generation: state.generation,
    trialIndex: 0
  };
  const until = flags.hours > 0 ? Date.now() + flags.hours * 3600 * 1000 : 0;
  const envLabel =
    flags.envs != null
      ? `${flags.envs} envs pinned`
      : `envs=${core.SPACE.nEnvs.filter((value) => value <= flags.maxEnvs).join(",")} searched`;
  let stop = false;
  let stopReason = "";
  const removeSignalExits = installSignalExits();
  console.log(
    `Dawn ${ready.adapter || adapterLabel(gpu)}  ${envLabel}  ${flags.seconds}s per trial  ${flags.trials} settings per round`
  );
  console.log(
    `resource guard batch<=${flags.maxBatch} rss<=${flags.maxRssMb}MB free>=${flags.minFreeMb}MB cpu<=${flags.maxCpuPercent}%`
  );
  printStatus(state, dir);
  try {
    while (!stop) {
      state.generation += 1;
      ctx.generation = state.generation;
      const batch = core.nextCandidates(state, flags.trials, rng).map((item) => ({
        ...item,
        config: core.pinConfig(item.config, flags)
      }));
      for (const candidate of batch) {
        if (stop) break;
        if (until && Date.now() >= until) {
          stop = true;
          stopReason = "wall-time budget complete";
          break;
        }
        ctx.trialIndex += 1;
        let trial;
        const trialSeconds = until
          ? Math.min(flags.seconds, Math.max(0.1, (until - Date.now()) / 1000))
          : flags.seconds;
        try {
          trial = await runTrial(ctx, candidate, trialSeconds, flags.seed + ctx.trialIndex * 13);
        } catch (error) {
          if (core.isResourceFailure(error)) {
            stop = true;
            stopReason = String(error.message || error);
            console.error(`sweep stopped: ${stopReason}`);
            break;
          }
          trial = {
            id: `g${ctx.generation}-t${ctx.trialIndex}`,
            config: core.pinConfig(candidate.config, flags),
            origin: candidate.origin,
            metrics: {
              error: String(error.message || error),
              peakReward: 0,
              peakGems: 0,
              peakRooms: 0,
              updates: 0,
              resources: resourceMonitor.summary()
            },
            score: -Infinity,
            createdAt: new Date().toISOString()
          };
          console.error(`trial failed: ${trial.metrics.error}`);
        }
        core.appendTrial(dir, trial);
        state = core.recordTrial(state, trial);
        state.resources = resourceMonitor.summary();
        state = core.saveState(dir, state);
        printTrial(trial, state.best);
      }
      if (flags.once || flags._[0] === "once") break;
      if (until && Date.now() >= until) {
        stop = true;
        stopReason = "wall-time budget complete";
      }
    }
  } finally {
    removeSignalExits();
    state.resources = resourceMonitor.summary();
    if (stopReason) state.stopReason = stopReason;
    state = core.saveState(dir, state);
    if (ppo.device && typeof ppo.device.destroy === "function") ppo.device.destroy();
  }
  printStatus(state, dir);
  return state;
}

async function main() {
  const flags = core.parseArgs(process.argv.slice(2));
  const cmd = flags._[0] || "run";
  if (flags.help || cmd === "help") {
    process.stdout.write(core.helpText());
    return;
  }
  if (cmd === "status") {
    printStatus(core.loadState(flags.dir), flags.dir);
    return;
  }
  const optDir = store.defaultOptDir();
  const result = await withGpuLock(optDir, () => runSweep(flags), {
    owner: { label: "train-sweep", dir: flags.dir },
    pollMs: 250,
    staleMs: 120000
  });
  if (!result.exclusive) console.log("warning: GPU lock was not exclusive");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}

module.exports = {
  collect,
  flatten,
  installSignalExits,
  releaseTrialBuffers,
  reseedPpo,
  runTrial,
  startPlayData
};
