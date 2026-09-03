#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { loadBrowserScript } = require("./helpers/browser-module-loader");
const { actor, makeBoardEnv, test } = require("./helpers/train-env-fixture");

globalThis.window = globalThis.window || globalThis;
globalThis.self = globalThis.self || globalThis;
if (!globalThis.TrainPpo) loadBrowserScript("public/train-ppo-webgpu.js");
const ppoLib = globalThis.TrainPpo;
assert.ok(ppoLib.updateSaloMemory);
assert.equal(ppoLib.ROLL_IN, 16 * 16 + 8);
assert.equal(ppoLib.SALO_IN, 16 * 16 + 8 + 16 * 16 + 16 * 16);

{
  const memory = ppoLib.createSaloMemory();
  const winGrid = new Uint8Array(256);
  const loseGrid = new Uint8Array(256);
  winGrid[3] = 16;
  loseGrid[9] = 16;
  const storage = {
    rewards: [
      [1.0, -0.5],
      [1.0, -0.5]
    ],
    observations: [
      [{ grid: winGrid }, { grid: loseGrid }],
      [{ grid: winGrid }, { grid: loseGrid }]
    ]
  };
  ppoLib.updateSaloMemory(memory, storage, 0);
  assert.ok(memory.visit[3] > 0, "winner cell should be visited");
  assert.ok(memory.visit[9] > 0, "loser cell should be visited");
  assert.ok(memory.quality[3] > 0, `winner quality ${memory.quality[3]}`);
  assert.ok(memory.quality[9] < 0, `loser quality ${memory.quality[9]}`);
}

{
  const visit = new Float32Array(256);
  const quality = new Float32Array(256);
  visit[4] = 0.8;
  quality[4] = -0.6;
  const packed = ppoLib.packRollFeatures(new Uint8Array(256), new Float32Array(8), new Float32Array(ppoLib.SALO_IN), {
    peerVisit: visit,
    peerScore: quality,
    ownScore: 0.2,
    meanScore: 0.1,
    bestGap: 0.4
  });
  assert.equal(packed.length, ppoLib.SALO_IN);
  assert.ok(Math.abs(packed[256 + 8 + 4] - 0.8) < 1e-6);
  assert.ok(Math.abs(packed[256 + 8 + 256 + 4] + 0.6) < 1e-6);
  assert.ok(Math.abs(packed[256 + 4] - 0.2) < 1e-6);
}

async function main() {
  let gpuPpo;
  try {
    const { installWebGpu } = require("../scripts/webgpu-node");
    await installWebGpu();
    gpuPpo = new ppoLib.WebGpuPpo();
    await gpuPpo.init(1);
  } catch (error) {
    console.log(`SKIP GPU SaloPPO: ${error.message}`);
    console.log("train-saloppo tests passed (CPU only)");
    return;
  }

  const R = 3;
  await test("SaloPPO kernel pays extra for winner cells and penalizes loser cells", async () => {
    async function walk(quality) {
      const env = await makeBoardEnv({
        width: 5,
        height: 1,
        terrain: [Array.from({ length: 5 }, () => ({ type: "floor" }))],
        actors: [actor("player", 1, 0)]
      });
      const cap = env.gpuCapture();
      const peerScore = new Float32Array(256);
      peerScore[2] = quality;
      const rolled = await gpuPpo.gpuRollout([cap], 1, {
        actions: [R],
        maxActions: 64,
        seed: 1,
        noveltyBonus: 0,
        gemWeight: 0,
        pushWeight: 0,
        deathPenalty: 0,
        saloCoef: 0.2,
        peerScore
      });
      return rolled.rewards[0][0];
    }
    const good = await walk(1);
    const bad = await walk(-1);
    assert.ok(good > bad + 0.3, `winner ${good} should beat loser ${bad}`);
    assert.ok(Math.abs(good - 0.2) < 0.05, `expected ~0.2 salo bonus, got ${good}`);
    assert.ok(Math.abs(bad + 0.2) < 0.05, `expected ~-0.2 salo penalty, got ${bad}`);
  });

  console.log("train-saloppo tests passed");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
