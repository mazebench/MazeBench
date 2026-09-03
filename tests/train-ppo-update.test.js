#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { loadBrowserScript } = require("./helpers/browser-module-loader");

globalThis.window = globalThis.window || globalThis;
globalThis.self = globalThis.self || globalThis;
loadBrowserScript("public/train-ppo-webgpu.js");
const ppo = globalThis.TrainPpo;
assert.ok(ppo.compactPpoUpdate, "compactPpoUpdate should export");

const MASK = Array(10).fill(true);

function dummyObs() {
  const grid = new Uint8Array(16 * 16);
  grid[0] = 16;
  grid[1] = 1;
  grid[2] = 1;
  grid[18] = 18;
  const aux = new Float32Array(8);
  aux[5] = 0.1;
  return { grid, aux, mask: MASK };
}

function makeBatch(action, advantage, size, logp) {
  const observations = [];
  const actions = [];
  const logps = [];
  const advantages = [];
  const returns = [];
  for (let i = 0; i < size; i += 1) {
    observations.push(dummyObs());
    actions.push(action);
    logps.push(logp);
    advantages.push(advantage);
    returns.push(advantage);
  }
  return { observations, actions, logp: logps, advantages, returns };
}

{
  const policy = ppo.createRollPolicy(1);
  const x = ppo.packRollFeatures(dummyObs().grid, dummyObs().aux);
  const fwd = ppo.compactForward(policy.weights, x, MASK);
  const sum = Array.from(fwd.probs).reduce((acc, value) => acc + value, 0);
  assert.ok(Math.abs(sum - 1) < 1e-5, `probs sum ${sum}`);
  assert.ok(Math.abs(fwd.entropy - Math.log(10)) < 0.2, `init entropy ${fwd.entropy}`);
}

{
  const policy = ppo.createRollPolicy(3);
  const obs = dummyObs();
  const x = ppo.packRollFeatures(obs.grid, obs.aux);
  const before = ppo.compactForward(policy.weights, x, MASK);
  const batch = makeBatch(0, 1, 32, Math.log(Math.max(before.probs[0], 1e-8)));
  ppo.compactPpoUpdate(policy, batch, { entropyCoef: 0.01, lr: 3e-3, clip: 0.2 });
  const after = ppo.compactForward(policy.weights, x, MASK);
  assert.ok(after.probs[0] > before.probs[0], `rewarded action should gain mass (${before.probs[0]} -> ${after.probs[0]})`);
}

{
  const policy = ppo.createRollPolicy(7);
  const obs = dummyObs();
  const x = ppo.packRollFeatures(obs.grid, obs.aux);
  let entropy = 0;
  for (let i = 0; i < 80; i += 1) {
    const current = ppo.compactForward(policy.weights, x, MASK);
    const batch = makeBatch(0, 1, 32, Math.log(Math.max(current.probs[0], 1e-8)));
    ppo.compactPpoUpdate(policy, batch, { entropyCoef: 0.01, lr: 3e-4, clip: 0.2 });
    entropy = ppo.compactForward(policy.weights, x, MASK).entropy;
  }
  assert.ok(entropy > 1.5, `entropy collapsed to ${entropy}`);
}

{
  const policy = ppo.createRollPolicy(3);
  const before = policy.weights.slice();
  const batch = makeBatch(0, 4, 16, -8);
  ppo.compactPpoUpdate(policy, batch, { entropyCoef: 0, lr: 3e-4, clip: 0.2, valueCoef: 0 });
  let maxDelta = 0;
  for (let i = 0; i < before.length; i += 1) maxDelta = Math.max(maxDelta, Math.abs(policy.weights[i] - before[i]));
  assert.ok(maxDelta < 1e-6, `clipped samples must not move the policy, delta ${maxDelta}`);
}

console.log("train-ppo-update tests passed");
