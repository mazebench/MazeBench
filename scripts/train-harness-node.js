#!/usr/bin/env node
"use strict";

const { adapterLabel, installWebGpu } = require("./webgpu-node");
const { loadTrainHarness } = require("./load-train-harness");
const { defaultLevelIdForGame, getGame, getLevel, getLevelState } = require("../server/app");

function parseArgs(argv) {
  const options = { envs: 1, steps: 50, seed: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--envs") options.envs = Math.max(1, Number(next()) || 1);
    else if (arg === "--steps") options.steps = Math.max(1, Number(next()) || 1);
    else if (arg === "--seed") options.seed = Number(next()) || 1;
  }
  return options;
}

function startPlayData() {
  const game = getGame("maze");
  const levelId = defaultLevelIdForGame(game);
  return { levelId, playData: getLevelState(game, getLevel(game, levelId)) };
}

async function createEnv(config, playData, profiler) {
  const { TrainEnv } = loadTrainHarness();
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

async function runNodeHarness(options) {
  const gpu = await installWebGpu();
  const { TrainEnv, TrainPpo, TrainProfile } = loadTrainHarness();
  const profiler = TrainProfile.createProfiler();
  const ppo = new TrainPpo.WebGpuPpo({ profiler });
  await profiler.span("ppo.init", () => ppo.init(options.seed));
  const { levelId, playData } = startPlayData();
  const config = {
    levelId,
    maxActions: Math.max(options.steps + 32, 64)
  };
  const envs = [];
  for (let i = 0; i < options.envs; i += 1) {
    envs.push(await createEnv(config, playData, profiler));
  }
  const current = envs.map((env) => env.snapshot({ moved: false }));
  const storage = { observations: [], actions: [], logp: [], values: [], rewards: [], dones: [] };
  const started = performance.now();
  await profiler.span("collect", async () => {
    for (let step = 0; step < options.steps; step += 1) {
      const acts = await profiler.span("collect.act", () => ppo.actBatch(current));
      const observations = [];
      const rewards = [];
      const dones = [];
      for (let i = 0; i < envs.length; i += 1) {
        observations.push({
          grid: current[i].grid,
          aux: current[i].aux,
          mask: current[i].mask
        });
        const result = await profiler.span("collect.envStep", () => envs[i].step(acts[i].action));
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
  });
  const last = await ppo.forwardBatch(current);
  const lastValues = [];
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
  const frames = options.envs * options.steps;
  return {
    backend: "dawn-node",
    adapter: adapterLabel(gpu.info),
    info: gpu.info,
    frames,
    seconds,
    fps: frames / Math.max(seconds, 1e-6),
    losses,
    profile: profiler.report(),
    profileText: profiler.format()
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runNodeHarness(options);
  console.log(`backend: ${result.backend}`);
  console.log(`adapter: ${result.adapter}`);
  console.log(`frames: ${result.frames}  seconds: ${result.seconds.toFixed(3)}  fps: ${result.fps.toFixed(1)}`);
  console.log(`policyLoss=${result.losses.policyLoss.toFixed(4)} entropy=${result.losses.entropy.toFixed(3)}`);
  console.log("");
  console.log(result.profileText);
  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
  });
}

module.exports = { runNodeHarness, startPlayData };
