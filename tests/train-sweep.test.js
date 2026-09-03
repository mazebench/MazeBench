#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../scripts/train-sweep-core");
const { releaseTrialBuffers } = require("../scripts/train-sweep");
const { test } = require("./helpers/train-env-fixture");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "maze-train-sweep-"));
}

async function main() {
  await test("search covers every runtime training hyperparameter including env count", () => {
    assert.deepEqual(core.KEYS, [
      "nEnvs",
      "algorithm",
      "numSteps",
      "maxActions",
      "learningRate",
      "entropyCoef",
      "valueCoef",
      "gamma",
      "gaeLam",
      "clip",
      "saloCoef",
      "gemWeight",
      "roomWeight",
      "pushWeight",
      "noveltyBonus",
      "deathPenalty"
    ]);
    const rng = core.mulberry32(7);
    const envCounts = new Set();
    for (let i = 0; i < 200; i += 1) {
      const config = core.sampleRandom(rng);
      envCounts.add(config.nEnvs);
      assert.equal(core.pinConfig(config, { envs: 4 }).nEnvs, 4);
    }
    assert.deepEqual([...envCounts].sort((a, b) => a - b), core.SPACE.nEnvs);
  });

  await test("mutate and crossover stay inside the search space", () => {
    const rng = core.mulberry32(11);
    const a = core.sampleRandom(rng);
    const b = core.sampleRandom(rng);
    for (let i = 0; i < 30; i += 1) {
      const m = core.mutate(a, rng);
      const c = core.crossover(a, b, rng);
      for (const key of core.KEYS) {
        if (key === "saloCoef" && m.algorithm !== "saloppo") {
          assert.equal(m.saloCoef, 0);
          continue;
        }
        if (key === "saloCoef" && c.algorithm !== "saloppo") {
          assert.equal(c.saloCoef, 0);
          continue;
        }
        assert.ok(core.SPACE[key].includes(m[key]), `mutate ${key}=${m[key]}`);
        assert.ok(core.SPACE[key].includes(c[key]) || (key === "saloCoef" && c.saloCoef === 0), `cross ${key}=${c[key]}`);
      }
    }
  });

  await test("score ranks peak reward in a wall-time budget, then gems", () => {
    const low = core.scoreMetrics({ peakReward: 0.2, peakGems: 4, peakRooms: 2, updates: 50 });
    const high = core.scoreMetrics({ peakReward: 1.5, peakGems: 0, peakRooms: 1, updates: 10 });
    assert.ok(high > low, `reward should dominate gems: ${high} vs ${low}`);
    assert.equal(core.scoreMetrics({ error: true }), -Infinity);
  });

  await test("population keeps the best trial and mutates around it", () => {
    const rng = core.mulberry32(3);
    let state = core.emptyState();
    state = core.recordTrial(state, {
      id: "a",
      config: core.sampleRandom(rng),
      metrics: { peakReward: 0.4, peakGems: 0, peakRooms: 1, updates: 8 }
    });
    state = core.recordTrial(state, {
      id: "b",
      config: core.sampleRandom(rng),
      metrics: { peakReward: 1.2, peakGems: 1, peakRooms: 1, updates: 8 }
    });
    assert.equal(state.best.id, "b");
    assert.equal(state.trials, 2);
    const batch = core.nextCandidates(state, 4, rng);
    assert.equal(batch.length, 4);
    assert.ok(batch.some((item) => item.origin.startsWith("mutate")));
    batch.forEach((item) => assert.ok(core.SPACE.nEnvs.includes(item.config.nEnvs)));
  });

  await test("state resumes and migrates hyperparameters added to the search", () => {
    const dir = tempDir();
    const rng = core.mulberry32(5);
    let state = core.emptyState();
    state = core.recordTrial(state, {
      id: "keep",
      config: core.sampleRandom(rng),
      metrics: { peakReward: 0.8, peakGems: 1, peakRooms: 1, updates: 12 }
    });
    core.saveState(dir, state);
    core.appendTrial(dir, { id: "keep", score: state.best.score });
    const stateFile = path.join(dir, "state.json");
    const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    delete persisted.best.config.nEnvs;
    delete persisted.best.config.valueCoef;
    delete persisted.population[0].config.nEnvs;
    delete persisted.population[0].config.valueCoef;
    fs.writeFileSync(stateFile, JSON.stringify(persisted));
    const loaded = core.loadState(dir);
    assert.equal(loaded.best.id, "keep");
    assert.equal(loaded.population.length, 1);
    assert.equal(loaded.best.config.nEnvs, core.DEFAULT_CONFIG.nEnvs);
    assert.equal(loaded.best.config.valueCoef, core.DEFAULT_CONFIG.valueCoef);
    assert.ok(fs.existsSync(path.join(dir, "trials.jsonl")));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("CLI searches by default and can pin every hyperparameter", () => {
    const flags = core.parseArgs([
      "run",
      "--envs",
      "4",
      "--steps",
      "32",
      "--max-actions",
      "128",
      "--algorithm",
      "saloppo",
      "--learning-rate",
      "0.0003",
      "--entropy-coef",
      "0.01",
      "--value-coef",
      "0.5",
      "--gamma",
      "0.99",
      "--gae-lambda",
      "0.95",
      "--clip",
      "0.2",
      "--salo-coef",
      "0.08",
      "--gem-weight",
      "1",
      "--room-weight",
      "0.1",
      "--push-weight",
      "0.05",
      "--novelty-bonus",
      "0.01",
      "--death-penalty",
      "-0.05",
      "--seconds",
      "12",
      "--hours",
      "2",
      "--trials",
      "3"
    ]);
    const pinned = core.pinConfig(core.DEFAULT_CONFIG, flags);
    const pinFlags = { nEnvs: "envs", numSteps: "steps" };
    for (const key of core.KEYS) {
      assert.equal(pinned[key], flags[pinFlags[key] || key], key);
    }
    assert.equal(flags.seconds, 12);
    assert.equal(flags.hours, 2);
    assert.equal(flags.trials, 3);
    const aliases = core.parseArgs(["run", "--budget", "9", "--width", "2"]);
    assert.equal(aliases.seconds, 9);
    assert.equal(aliases.trials, 2);
    const defaults = core.parseArgs([]);
    assert.equal(defaults.envs, undefined);
    assert.equal(defaults.seconds, 30);
    assert.equal(defaults.hours, 8);
    assert.equal(defaults.trials, 4);
    assert.equal(defaults.maxBatch, 2048);
    assert.equal(core.parseArgs(["--trials", "1000"]).trials, 64);
    assert.match(core.helpText(), /searches every runtime training hyperparameter/);
    assert.match(core.helpText(), /Resource envelope \(enabled by default\)/);
  });

  await test("resource envelope bounds searched and pinned GPU batches", () => {
    const oversized = { ...core.DEFAULT_CONFIG, algorithm: "saloppo", nEnvs: 16, numSteps: 256 };
    assert.deepEqual(
      core.pinConfig(oversized, { maxBatch: 2048 }),
      { ...oversized, nEnvs: 8 }
    );
    assert.deepEqual(
      core.pinConfig(oversized, { envs: 16, maxBatch: 2048 }),
      { ...oversized, numSteps: 128 }
    );
    assert.equal(core.pinConfig(oversized, { maxEnvs: 4 }).nEnvs, 4);
    assert.throws(
      () => core.pinConfig(oversized, { envs: 16, steps: 256, maxBatch: 2048 }),
      /pinned batch 16 x 256 exceeds/
    );
  });

  await test("resource monitor cools down and fails closed under sustained pressure", async () => {
    const samples = [
      { rssMb: 100, freeMemMb: 10_000, cpuPercent: 95 },
      { rssMb: 100, freeMemMb: 10_000, cpuPercent: 20 }
    ];
    const monitor = core.createResourceMonitor(
      { maxRssMb: 256, minFreeMb: 256, maxCpuPercent: 50, resourcePollMs: 100, resourceGraceSeconds: 1 },
      {
        sample: () => samples.shift() || { rssMb: 100, freeMemMb: 10_000, cpuPercent: 20 },
        sleep: async () => {}
      }
    );
    await monitor.checkpoint("test");
    assert.equal(monitor.summary().pauseCount, 1);
    assert.equal(monitor.summary().pausedMs, 100);

    const blocked = core.createResourceMonitor(
      { maxRssMb: 256, minFreeMb: 256, maxCpuPercent: 90, resourcePollMs: 100, resourceGraceSeconds: 1 },
      {
        sample: () => ({ rssMb: 300, freeMemMb: 10_000, cpuPercent: 20 }),
        sleep: async () => {}
      }
    );
    await assert.rejects(blocked.checkpoint("test"), (error) => error.code === "MAZEBENCH_RESOURCE_LIMIT");
    assert.equal(blocked.summary().pausedMs, 1000);
    assert.equal(core.isResourceFailure(new Error("WebGPU device was lost")), true);
    assert.equal(core.isResourceFailure(new Error("bad level")), false);
  });

  await test("trial cleanup destroys cached GPU buffers between shapes", () => {
    let destroyed = 0;
    const buffer = () => ({ destroy: () => { destroyed += 1; } });
    const ppo = {
      scratch: new Map([["shape", { gpu: buffer(), host: new Float32Array(4) }]]),
      staging: new Map([["read", buffer()]]),
      uniformCache: new Map([["dims", buffer()]]),
      zeroHost: new Map([["4", new Uint8Array(4)]])
    };
    releaseTrialBuffers(ppo);
    assert.equal(destroyed, 3);
    assert.equal(ppo.scratch.size, 0);
    assert.equal(ppo.staging.size, 0);
    assert.equal(ppo.uniformCache.size, 0);
    assert.equal(ppo.zeroHost.size, 0);
  });

  console.log("train-sweep tests passed");
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
