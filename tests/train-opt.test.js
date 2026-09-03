#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inspectLock, withGpuLock } = require("../scripts/train-opt-lock");
const store = require("../scripts/train-opt-store");
const { implementerPrompt, parseArgs } = require("../scripts/train-opt");
const { test } = require("./helpers/train-env-fixture");

function tempOptDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "maze-train-opt-"));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await test("CLI flags parse iterations/width/ideas", () => {
    const flags = parseArgs(["run", "--iterations", "5", "--width", "3", "--ideas", "a||b"]);
    assert.equal(flags._[0], "run");
    assert.equal(flags.iterations, "5");
    assert.equal(flags.width, "3");
    assert.equal(flags.ideas, "a||b");
  });

  await test("GPU lock serializes two benches so holds never overlap", async () => {
    const optDir = tempOptDir();
    const holds = [];
    const run = (label, delay) =>
      withGpuLock(optDir, async () => {
        const start = Date.now();
        await sleep(delay);
        const end = Date.now();
        holds.push({ label, start, end });
        return { label };
      }, { owner: { label }, pollMs: 10, staleMs: 2000 });

    const [a, b] = await Promise.all([run("a", 80), run("b", 80)]);
    assert.equal(a.exclusive, true);
    assert.equal(b.exclusive, true);
    holds.sort((x, y) => x.start - y.start);
    assert.ok(holds[0].end <= holds[1].start + 5, "holds overlapped under the lock");
    assert.ok(a.queueWaitMs === 0 || b.queueWaitMs > 0, "second waiter should queue");
    assert.equal(inspectLock(optDir).locked, false);
    fs.rmSync(optDir, { recursive: true, force: true });
  });

  await test("stale lock from a dead pid is stolen", async () => {
    const optDir = tempOptDir();
    const lockDir = path.join(optDir, ".gpu-lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: 99999999, startedAt: Date.now() - 60000, heartbeatAt: Date.now() - 60000, label: "dead" })
    );
    const result = await withGpuLock(optDir, async () => ({ ok: true }), { staleMs: 100, pollMs: 10 });
    assert.equal(result.ok, true);
    assert.equal(result.exclusive, true);
    fs.rmSync(optDir, { recursive: true, force: true });
  });

  await test("leaderboard ranks only exclusive passing fps", () => {
    const optDir = tempOptDir();
    store.appendEntry(optDir, {
      id: "base",
      label: "baseline",
      exclusive: true,
      testsOk: true,
      fps: 500,
      readF32PerFrame: 1,
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    store.appendEntry(optDir, {
      id: "fast-but-contended",
      label: "cheater",
      exclusive: false,
      testsOk: true,
      fps: 9000,
      readF32PerFrame: 1,
      createdAt: "2026-01-01T00:00:01.000Z"
    });
    store.appendEntry(optDir, {
      id: "broken",
      label: "broken",
      exclusive: true,
      testsOk: false,
      fps: 800,
      readF32PerFrame: 1,
      createdAt: "2026-01-01T00:00:02.000Z"
    });
    store.appendEntry(optDir, {
      id: "win",
      label: "pipeline",
      exclusive: true,
      testsOk: true,
      fps: 640,
      readF32PerFrame: 0.25,
      idea: "double buffer readF32",
      iteration: 1,
      createdAt: "2026-01-01T00:00:03.000Z"
    });
    const status = store.buildStatus(optDir, { updatedAt: "2026-01-01T00:00:04.000Z" });
    assert.equal(status.baselineFps, 500);
    assert.equal(status.bestLabel, "pipeline");
    assert.equal(status.bestFps, 640);
    assert.equal(status.ranking.length, 2);
    assert.equal(status.ranking[0].label, "pipeline");
    assert.ok(Math.abs(status.deltaPct - 28) < 0.01);
    const md = store.renderStatusMd(status);
    assert.match(md, /pipeline/);
    assert.match(md, /exclusive Dawn fps/);
    assert.doesNotMatch(md, /cheater/);
    fs.rmSync(optDir, { recursive: true, force: true });
  });

  await test("readF32/frame is a contention-invariant count", () => {
    const profile = [
      { path: "collect", count: 1 },
      { path: "collect/ppo.readF32", count: 50 },
      { path: "ppo.update/ppo.readF32", count: 2 }
    ];
    assert.equal(store.profileCount(profile, "readF32"), 52);
    assert.equal(52 / 50, 1.04);
  });

  await test("pickWinner only promotes exclusive fps that beat master", () => {
    const { pickWinner } = require("../scripts/train-opt-master");
    const entries = [
      { label: "slow", exclusive: true, testsOk: true, fps: 400, iteration: 1 },
      { label: "contended", exclusive: false, testsOk: true, fps: 900, iteration: 1 },
      { label: "fast", exclusive: true, testsOk: true, fps: 520, iteration: 1, cwd: "/slot/fast" }
    ];
    const miss = pickWinner(
      entries.filter((entry) => entry.label === "slow"),
      { iteration: 1, masterFps: 500, minDelta: 0.02 }
    );
    assert.equal(miss.ok, false);
    const hit = pickWinner(entries, { iteration: 1, masterFps: 500, minDelta: 0.02 });
    assert.equal(hit.ok, true);
    assert.equal(hit.best.label, "fast");
    const tooSmall = pickWinner(
      [{ label: "tiny", exclusive: true, testsOk: true, fps: 505, iteration: 1 }],
      { masterFps: 500, minDelta: 0.02 }
    );
    assert.equal(tooSmall.ok, false);
  });

  await test("copyTrainFiles integrates only changed train sources", () => {
    const { copyTrainFiles, changedTrainFiles, TRAIN_FILES } = require("../scripts/train-opt-master");
    const fromDir = tempOptDir();
    const toDir = tempOptDir();
    const rel = "public/train-ppo-webgpu.js";
    assert.ok(TRAIN_FILES.includes(rel));
    fs.mkdirSync(path.join(fromDir, "public"), { recursive: true });
    fs.mkdirSync(path.join(toDir, "public"), { recursive: true });
    fs.writeFileSync(path.join(fromDir, rel), "WINNER");
    fs.writeFileSync(path.join(toDir, rel), "MASTER");
    assert.deepEqual(changedTrainFiles(fromDir, toDir), [rel]);
    copyTrainFiles(fromDir, toDir, [rel]);
    assert.equal(fs.readFileSync(path.join(toDir, rel), "utf8"), "WINNER");
    fs.rmSync(fromDir, { recursive: true, force: true });
    fs.rmSync(toDir, { recursive: true, force: true });
  });

  await test("implementer prompt demands exclusive bench and frozen env rules", () => {
    const prompt = implementerPrompt({
      idea: "pipeline readF32",
      label: "i1s0",
      iteration: 1,
      slot: 0,
      envs: 1,
      steps: 50
    });
    assert.match(prompt, /train-opt\.js bench/);
    assert.match(prompt, /train-moves\.test\.js/);
    assert.match(prompt, /pipeline readF32/);
    assert.match(prompt, /Do not commit/);
    assert.match(prompt, /MASTER tree/);
  });

  console.log("train-opt tests passed");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
