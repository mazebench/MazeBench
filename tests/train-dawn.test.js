#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { allFinite, makeEnv, maxAbsDiff, test } = require("./helpers/train-env-fixture");

function skip(reason) {
  console.log(`SKIP GPU: ${reason}`);
  process.exit(0);
}

async function bootDawn() {
  const { installWebGpu } = require("../scripts/webgpu-node");
  const gpu = await installWebGpu();
  const { loadTrainHarness } = require("../scripts/load-train-harness");
  const harness = loadTrainHarness();
  return { gpu, ...harness };
}

async function makePpo(TrainPpo, seed = 1) {
  const ppo = new TrainPpo.WebGpuPpo();
  await ppo.init(seed);
  return ppo;
}

function cloneObs(obs) {
  return {
    grid: obs.grid.slice ? obs.grid.slice(0) : Uint8Array.from(obs.grid),
    aux: obs.aux.slice ? obs.aux.slice(0) : Float32Array.from(obs.aux),
    mask: obs.mask.slice()
  };
}

function logitsOf(out, row = 0) {
  return out.subarray(row * 11, row * 11 + 10);
}

function valueOf(out, row = 0) {
  return out[row * 11 + 10];
}

async function main() {
  let gpu;
  let TrainPpo;
  try {
    ({ gpu, TrainPpo } = await bootDawn());
  } catch (error) {
    skip(error.message);
    return;
  }

  const adapter = `${gpu.info.device || "unknown"} (${gpu.info.architecture || "?"}, ${gpu.info.vendor || "?"})`;
  console.log(`dawn adapter: ${adapter}`);

  await test("policy constants match the live architecture", () => {
    assert.equal(TrainPpo.GRID, 16);
    assert.equal(TrainPpo.EMBED, 8);
    assert.equal(TrainPpo.AUX_DIM, 8);
    assert.equal(TrainPpo.CELL_TYPES, 24);
    assert.equal(TrainPpo.H1, 256);
    assert.equal(TrainPpo.H2, 128);
    assert.equal(TrainPpo.N_ACTIONS, 10);
    assert.equal(TrainPpo.OUT, 11);
    assert.equal(TrainPpo.INPUT, 16 * 16 * 8 + 8);
  });

  const env = await makeEnv();
  const obs = cloneObs(env.snapshot());
  assert.equal(obs.grid.length, 256);
  assert.equal(obs.aux.length, 8);
  assert.equal(obs.mask.length, 10);

  const ppo = await makePpo(TrainPpo, 1);

  await test("forwardBatch returns finite [1, 11] logits+value", async () => {
    const { out } = await ppo.forwardBatch([obs]);
    assert.equal(out.length, 11);
    assert.ok(allFinite(out), "NaN/Inf in forward");
    assert.ok(Number.isFinite(valueOf(out)));
  });

  await test("same observation twice yields the same logits", async () => {
    const a = await ppo.forwardBatch([obs]);
    const b = await ppo.forwardBatch([obs]);
    assert.ok(maxAbsDiff(a.out, b.out) < 1e-5, `logits drifted ${maxAbsDiff(a.out, b.out)}`);
  });

  await test("scratch reuse across batch sizes does not change logits", async () => {
    const first = await ppo.forwardBatch([obs]);
    const batched = await ppo.forwardBatch([obs, obs, obs, obs]);
    const again = await ppo.forwardBatch([obs]);
    assert.equal(batched.out.length, 44);
    assert.ok(maxAbsDiff(first.out, batched.out.subarray(0, 11)) < 1e-4, "batching changed first-row logits");
    assert.ok(maxAbsDiff(first.out, again.out) < 1e-5, "scratch reuse corrupted logits");
    assert.ok(maxAbsDiff(batched.out.subarray(0, 11), batched.out.subarray(11, 22)) < 1e-5, "duplicate rows diverged");
  });

  await test("two PPOs with the same seed match on first act", async () => {
    const p1 = await makePpo(TrainPpo, 7);
    const p2 = await makePpo(TrainPpo, 7);
    const a = await p1.act(obs);
    const b = await p2.act(obs);
    assert.equal(a.action, b.action);
    assert.ok(a.action >= 0 && a.action < 10);
    assert.ok(maxAbsDiff(a.logits, b.logits) < 1e-4, "seed mismatch");
    assert.ok(Math.abs(a.logp - Math.log(Math.max(a.probs[a.action], 1e-8))) < 1e-5);
    assert.ok(Math.abs(a.probs.reduce((sum, p) => sum + p, 0) - 1) < 1e-5);
  });

  await test("actBatch matches decodeActions of one forward", async () => {
    const single = await ppo.forwardBatch([obs]);
    const decoded = ppo.decodeActions([obs], single.out);
    assert.equal(decoded.length, 1);
    assert.ok(decoded[0].action >= 0 && decoded[0].action < 10);
    assert.ok(maxAbsDiff(decoded[0].logits, logitsOf(single.out)) < 1e-5);
    const acts = await ppo.actBatch([obs, obs]);
    assert.equal(acts.length, 2);
    assert.ok(acts.every((item) => item.action >= 0 && item.action < 10));
    assert.ok(acts.every((item) => Number.isFinite(item.logp) && Number.isFinite(item.value)));
    assert.ok(maxAbsDiff(acts[0].logits, acts[1].logits) < 1e-4, "identical obs produced different logits");
  });

  await test("dead mask only samples undo or reset", async () => {
    const dead = cloneObs(obs);
    dead.mask = [false, false, false, false, false, false, false, false, true, true];
    for (let i = 0; i < 16; i += 1) {
      const act = await ppo.act(dead);
      assert.ok(act.action === 8 || act.action === 9, `sampled illegal action ${act.action}`);
      assert.ok(act.probs[8] + act.probs[9] > 0.999, "masked mass leaked to illegal actions");
    }
  });

  await test("env replay of a fixed action sequence is deterministic", async () => {
    const actions = [0, 3, 1, 6, 2, 7, 0];
    const envA = await makeEnv();
    const hashes = [];
    for (const action of actions) hashes.push((await envA.step(action)).hash);
    const envB = await makeEnv();
    for (let i = 0; i < actions.length; i += 1) {
      const next = await envB.step(actions[i]);
      assert.equal(next.hash, hashes[i], `mismatch at action ${i}`);
      assert.equal(next.actionCount, i + 1);
      assert.equal(next.grid.length, 256);
      assert.equal(next.aux.length, 8);
      assert.ok(Number.isFinite(next.reward));
    }
  });

  await test("undo restores the previous board hash", async () => {
    let restored = false;
    for (const action of [0, 1, 2, 3]) {
      const live = await makeEnv();
      const before = live.snapshot().hash;
      const moved = await live.step(action);
      if (moved.hash === before) continue;
      const undone = await live.step(8);
      assert.equal(undone.hash, before);
      restored = true;
      break;
    }
    assert.ok(restored, "no cardinal move changed the board hash");
  });

  await test("reset_level returns to the room entry hash", async () => {
    const live = await makeEnv();
    const entry = live.snapshot().hash;
    await live.step(0);
    await live.step(3);
    const reset = await live.step(9);
    assert.equal(reset.hash, entry);
  });

  await test("camera yaw wraps every four lefts", async () => {
    const live = await makeEnv();
    assert.equal(live.snapshot().yaw, 0);
    assert.equal((await live.step(6)).yaw, 3);
    assert.equal((await live.step(6)).yaw, 2);
    assert.equal((await live.step(6)).yaw, 1);
    assert.equal((await live.step(6)).yaw, 0);
  });

  await test("aux encodes yaw and action count", async () => {
    const live = await makeEnv({ maxActions: 64 });
    const start = live.snapshot();
    assert.equal(start.aux[0], 0);
    assert.equal(start.aux[1], 1 / 4);
    assert.equal(start.aux[5], 0);
    const rotated = await live.step(6);
    assert.ok(Math.abs(rotated.aux[0] - 1) < 1e-6);
    assert.ok(Math.abs(rotated.aux[5] - 1 / 64) < 1e-6);
    assert.equal(rotated.parts.novel, 0);
  });

  await test("maxActions marks the episode done", async () => {
    const live = await makeEnv({ maxActions: 2 });
    const first = await live.step(7);
    assert.equal(first.done, false);
    const second = await live.step(7);
    assert.equal(second.done, true);
    assert.equal(second.reason, "max_actions");
    assert.equal(second.actionCount, 2);
  });

  await test("PPO update changes logits and stays finite", async () => {
    const learner = await makePpo(TrainPpo, 5);
    const before = (await learner.forwardBatch([obs])).out.slice();
    const act = await learner.act(obs);
    const losses = await learner.update(
      {
        observations: [cloneObs(obs), cloneObs(obs)],
        actions: [act.action, (act.action + 1) % 10],
        logp: [act.logp, act.logp],
        advantages: [1.5, -1.5],
        returns: [1, 0]
      },
      { clip: 0.2, valueCoef: 0.5, lr: 3e-4 }
    );
    assert.ok(Number.isFinite(losses.policyLoss));
    assert.ok(Number.isFinite(losses.valueLoss));
    assert.ok(Number.isFinite(losses.entropy));
    const after = (await learner.forwardBatch([obs])).out;
    assert.ok(allFinite(after));
    assert.ok(maxAbsDiff(before, after) > 1e-8, "update did not change weights");
  });

  await test("8-step collect stays in range and advances the env", async () => {
    const live = await makeEnv({ maxActions: 32 });
    let current = live.snapshot();
    for (let step = 0; step < 8; step += 1) {
      const [act] = await ppo.actBatch([current]);
      current = await live.step(act.action);
      assert.ok(act.action >= 0 && act.action < 10);
      assert.ok(Number.isFinite(current.reward));
      assert.equal(current.actionCount, step + 1);
    }
    assert.equal(current.done, false);
  });

  const { runNodeHarness } = require("../scripts/train-harness-node");

  await test("1-step harness: one frame, finite losses, entropy near ln(10)", async () => {
    const one = await runNodeHarness({ envs: 1, steps: 1, seed: 1 });
    assert.equal(one.frames, 1);
    assert.ok(one.fps > 5);
    assert.ok(allFinite([one.losses.policyLoss, one.losses.valueLoss, one.losses.entropy]));
    assert.ok(Math.abs(one.losses.entropy - Math.log(10)) < 0.15);
    assert.ok(one.profile.some((row) => row.path === "collect"));
  });

  await test("2-env actBatch harness collects eight frames", async () => {
    const two = await runNodeHarness({ envs: 2, steps: 4, seed: 1 });
    assert.equal(two.frames, 8);
    assert.ok(allFinite([two.losses.policyLoss, two.losses.valueLoss, two.losses.entropy]));
    assert.ok(two.fps > 20, `2-env fps regression: ${two.fps.toFixed(1)}`);
  });

  await test("gpu mega-rollout returns in-range actions for 4 envs", async () => {
    const envA = await makeEnv();
    const envB = await makeEnv();
    const envC = await makeEnv();
    const envD = await makeEnv();
    const captures = [envA, envB, envC, envD].map((env) => env.gpuCapture());
    assert.equal(captures.length, 4);
    const rolled = await ppo.gpuRollout(captures, 32, { maxActions: 64, seed: 1 });
    assert.equal(rolled.actions.length, 32);
    assert.equal(rolled.actions[0].length, 4);
    for (const row of rolled.actions) {
      for (const action of row) {
        assert.equal(action, action | 0);
        assert.ok(action >= 0 && action < 10, `bad action ${action}`);
      }
    }
    assert.ok(rolled.logp.flat().every((value) => Number.isFinite(value)));
    assert.ok(rolled.values.flat().every((value) => Number.isFinite(value)));
    assert.ok(rolled.rewards.flat().every((value) => Number.isFinite(value)));
  });

  await test("4-env GPU collect sustains 100k tps", async () => {
    const envs = [await makeEnv(), await makeEnv(), await makeEnv(), await makeEnv()];
    assert.equal(envs.length, 4);
    const steps = 512;
    const warmCaptures = envs.map((env) => env.gpuCapture());
    assert.equal(warmCaptures.length, 4);
    await ppo.gpuRollout(warmCaptures, steps, { maxActions: steps + 32, seed: 1 });
    const captures = envs.map((env) => env.gpuCapture());
    const started = performance.now();
    const rolled = await ppo.gpuRollout(captures, steps, { maxActions: steps + 32, seed: 2 });
    const seconds = (performance.now() - started) / 1000;
    const frames = 4 * steps;
    const tps = frames / Math.max(seconds, 1e-6);
    assert.equal(rolled.actions.length, steps);
    assert.equal(rolled.actions[0].length, 4);
    for (const row of rolled.actions) {
      assert.equal(row.length, 4);
      for (const action of row) {
        assert.equal(action, action | 0);
        assert.ok(action >= 0 && action < 10, `bad action ${action}`);
      }
    }
    assert.ok(rolled.logp.flat().every((value) => Number.isFinite(value)));
    assert.ok(rolled.values.flat().every((value) => Number.isFinite(value)));
    assert.ok(rolled.rewards.flat().every((value) => Number.isFinite(value)));
    assert.ok(tps >= 100000, `4-env GPU collect ${tps.toFixed(0)} tps < 100000 (${frames} frames / ${seconds.toFixed(3)}s)`);
    console.log(`  speed  4-env GPU collect ${tps.toFixed(0)} tps (${frames} frames / ${seconds.toFixed(3)}s)`);
  });

  await test("GPU PPO mega kernel matches CPU compact update", async () => {
    const cfg = { clip: 0.2, valueCoef: 0.5, entropyCoef: 0.01, lr: 3e-4 };
    const cpu = TrainPpo.createRollPolicy(11);
    const gpuPpo = await makePpo(TrainPpo, 5);
    gpuPpo.device.queue.writeBuffer(gpuPpo.rollW, 0, cpu.weights);
    gpuPpo.rollAdam.t = 0;
    gpuPpo.zero(gpuPpo.rollParam.m, gpuPpo.rollParam.bytes);
    gpuPpo.zero(gpuPpo.rollParam.v, gpuPpo.rollParam.bytes);
    const live = cloneObs(obs);
    const batch = {
      observations: [live, live, live, live],
      actions: [0, 1, 2, 3],
      logp: [-2.3, -2.3, -2.3, -2.3],
      advantages: [0.5, -0.4, 1.1, -0.2],
      returns: [0.8, 0.1, 1.4, 0.0]
    };
    const cpuState = {
      weights: cpu.weights.slice(),
      adam: {
        m: new Float32Array(cpu.weights.length),
        v: new Float32Array(cpu.weights.length),
        t: 0
      }
    };
    const cpuLoss = TrainPpo.compactPpoUpdate(cpuState, batch, cfg);
    const gpuLoss = await gpuPpo.updateRollout(batch, cfg);
    assert.ok(allFinite([gpuLoss.policyLoss, gpuLoss.valueLoss, gpuLoss.entropy]));
    assert.ok(
      Math.abs(gpuLoss.entropy - cpuLoss.entropy) < 2e-4,
      `entropy gpu=${gpuLoss.entropy} cpu=${cpuLoss.entropy}`
    );
    assert.ok(
      Math.abs(gpuLoss.policyLoss - cpuLoss.policyLoss) < 2e-4,
      `policy gpu=${gpuLoss.policyLoss} cpu=${cpuLoss.policyLoss}`
    );
    const gpuW = await gpuPpo.readRollWeights();
    const delta = maxAbsDiff(gpuW, cpuState.weights);
    assert.ok(delta < 5e-4, `weight delta ${delta}`);
  });

  await test("10-step Dawn bench stays above 80 fps", async () => {
    const ten = await runNodeHarness({ envs: 1, steps: 10, seed: 1 });
    assert.equal(ten.frames, 10);
    const minFps = Number(process.env.MAZEBENCH_TRAIN_MIN_FPS || 80);
    assert.ok(ten.fps > minFps, `regression: 10-step fps ${ten.fps.toFixed(1)} (min ${minFps})`);
    assert.ok(allFinite([ten.losses.policyLoss, ten.losses.valueLoss, ten.losses.entropy]));
    console.log(`  speed  10-step ${ten.fps.toFixed(0)} fps on ${gpu.info.device || adapter}`);
  });

  console.log("train-dawn tests passed");
  process.exit(0);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
