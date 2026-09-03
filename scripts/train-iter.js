#!/usr/bin/env node
"use strict";

const { adapterLabel, installWebGpu } = require("./webgpu-node");
const { loadTrainHarness } = require("./load-train-harness");
const { startPlayData } = require("./train-harness-node");
const { withGpuLock } = require("./train-opt-lock");
const store = require("./train-opt-store");

function parseArgs(argv) {
  const options = { envs: 1, steps: 400, trials: 5, seed: 1, warmup: 20, packedRead: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--envs") options.envs = Math.max(1, Number(next()) || 1);
    else if (arg === "--steps") options.steps = Math.max(1, Number(next()) || 1);
    else if (arg === "--trials") options.trials = Math.max(1, Number(next()) || 1);
    else if (arg === "--seed") options.seed = Number(next()) || 1;
    else if (arg === "--warmup") options.warmup = Math.max(0, Number(next()) || 0);
    else if (arg === "--packed-read") options.packedRead = Math.max(0, Number(next()) || 0);
    else if (arg === "--salo") options.salo = Number(next() ?? 0.08) || 0.08;
    else if (arg === "--gpu") options.gpu = true;
  }
  return options;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function createEnv(TrainEnv, config, playData, profiler) {
  const { getGame, getLevel, getLevelState } = require("../server/app");
  const env = new TrainEnv.MazeTrainEnv({
    playCache: new Map([[config.levelId, playData]]),
    fetchPlayData: async (levelId) => {
      const game = getGame("maze");
      const level = getLevel(game, levelId);
      if (!level) throw new Error(`missing ${levelId}`);
      return getLevelState(game, level);
    },
    profiler,
    startLevelId: config.levelId,
    maxActions: config.maxActions,
    gemWeight: 1,
    roomWeight: 0.1,
    pushWeight: 0.05,
    noveltyBonus: 0.01
  });
  await env.reset();
  return env;
}

async function collectUpdate(ppo, TrainPpo, envs, steps, profiler, gpuRollout, salo) {
  for (const env of envs) await env.reset();
  const current = envs.map((env) => env.snapshot({ moved: false }));
  const storage = { observations: [], actions: [], logp: [], values: [], rewards: [], dones: [] };
  if (profiler) profiler.reset();
  const started = performance.now();
  async function runGpu() {
    const captures = envs.map((env) => env.gpuCapture());
    const rollOpts = { maxActions: Math.max(steps + 32, 64), seed: 1 };
    if (salo) {
      rollOpts.saloCoef = salo.coef;
      rollOpts.meanScore = salo.memory.meanScore;
      rollOpts.bestScore = salo.memory.bestScore;
      rollOpts.peerVisit = salo.memory.visit;
      rollOpts.peerScore = salo.memory.quality;
    }
    const rolled = await ppo.gpuRollout(captures, steps, rollOpts);
    const seedObs = captures.map((cap) => ({
      grid: cap.grid,
      aux: current[0].aux,
      mask: current[0].mask
    }));
    for (let t = 0; t < steps; t += 1) {
      storage.observations.push(seedObs.map((obs) => obs));
      storage.actions.push(rolled.actions[t]);
      storage.logp.push(rolled.logp[t]);
      storage.values.push(rolled.values[t]);
      storage.rewards.push(rolled.rewards[t]);
      storage.dones.push(rolled.dones[t]);
    }
  }
  async function runCpu() {
    for (let step = 0; step < steps; step += 1) {
      const acts = await ppo.actBatch(current);
      const observations = [];
      const rewards = [];
      const dones = [];
      for (let i = 0; i < envs.length; i += 1) {
        observations.push({
          grid: current[i].grid,
          aux: current[i].aux,
          mask: current[i].mask
        });
        const result = await envs[i].step(acts[i].action);
        rewards.push(result.reward);
        dones.push(result.done);
        current[i] = result.done ? await envs[i].reset() : result;
      }
      storage.observations.push(observations);
      storage.actions.push(acts.map((item) => item.action));
      storage.logp.push(acts.map((item) => item.logp));
      storage.values.push(acts.map((item) => item.value));
      storage.rewards.push(rewards);
      storage.dones.push(dones);
    }
  }
  await (profiler ? profiler.span("collect", gpuRollout ? runGpu : runCpu) : gpuRollout ? runGpu() : runCpu());
  const frames = envs.length * steps;
  if (gpuRollout) {
    const seconds = (performance.now() - started) / 1000;
    const logps = storage.logp.flat();
    const entropy = logps.reduce((sum, value) => sum - value, 0) / Math.max(1, logps.length);
    return {
      frames,
      seconds,
      fps: frames / Math.max(seconds, 1e-6),
      losses: { policyLoss: 0, valueLoss: 0, entropy },
      profile: profiler ? profiler.report() : []
    };
  }
  let lastValues;
  const last = await ppo.forwardBatch(current);
  lastValues = [];
  for (let i = 0; i < current.length; i += 1) {
    lastValues.push(last.out[i * TrainPpo.OUT + TrainPpo.N_ACTIONS]);
  }
  const { advantages, returns } = TrainPpo.computeGae(
    storage.rewards,
    storage.values,
    storage.dones,
    lastValues,
    0.99,
    0.95
  );
  const batch = {
    observations: storage.observations.flat(),
    actions: storage.actions.flat(),
    logp: storage.logp.flat(),
    advantages: advantages.flatMap((row) => Array.from(row)),
    returns: returns.flatMap((row) => Array.from(row))
  };
  const mean = batch.advantages.reduce((sum, value) => sum + value, 0) / Math.max(1, batch.advantages.length);
  const variance =
    batch.advantages.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, batch.advantages.length);
  const std = Math.sqrt(variance) + 1e-8;
  batch.advantages = batch.advantages.map((value) => (value - mean) / std);
  const losses = await ppo.update(batch, { clip: 0.2, valueCoef: 0.5, lr: 3e-4 });
  const seconds = (performance.now() - started) / 1000;
  return { frames, seconds, fps: frames / Math.max(seconds, 1e-6), losses, profile: profiler ? profiler.report() : [] };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.envs = Math.max(1, Math.min(4, options.envs));
  const gpu = await installWebGpu();
  const { TrainEnv, TrainPpo, TrainProfile } = loadTrainHarness();
  const profiler = TrainProfile.createProfiler();
  const ppoOpts = { profiler };
  if (options.packedRead) ppoOpts.packedRead = options.packedRead;
  const ppo = new TrainPpo.WebGpuPpo(ppoOpts);
  await ppo.init(options.seed);
  const { levelId, playData } = startPlayData();
  const config = { levelId, maxActions: Math.max(options.steps + 32, 64) };
  const envs = [];
  for (let i = 0; i < options.envs; i += 1) {
    envs.push(await createEnv(TrainEnv, config, playData, profiler));
  }

  const salo = options.salo
    ? { coef: options.salo, memory: TrainPpo.createSaloMemory() }
    : null;

  await withGpuLock(store.defaultOptDir(), async () => {
    if (options.warmup) {
      await collectUpdate(ppo, TrainPpo, envs, options.warmup, null, options.gpu, salo);
    }
    const samples = [];
    for (let trial = 1; trial <= options.trials; trial += 1) {
      const result = await collectUpdate(ppo, TrainPpo, envs, options.steps, profiler, options.gpu, salo);
      samples.push(result.fps);
      console.log(
        `trial ${trial}/${options.trials}  ${result.fps.toFixed(1)} fps  ${result.seconds.toFixed(3)}s  entropy=${result.losses.entropy.toFixed(3)}`
      );
    }
    samples.sort((a, b) => a - b);
    console.log(`adapter: ${adapterLabel(gpu.info)}`);
    console.log(
      `median ${median(samples).toFixed(1)}  min ${samples[0].toFixed(1)}  max ${samples[samples.length - 1].toFixed(1)}  n=${samples.length}  steps=${options.steps}`
    );
    console.log(profiler.format());
  });
  process.exit(0);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
