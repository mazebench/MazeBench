"use strict";

const fs = require("node:fs");
const path = require("node:path");
const store = require("./train-opt-store");

const TRAIN_FILES = Object.freeze([
  "public/train-env.js",
  "public/train-ppo-webgpu.js",
  "public/train-profile.js",
  "public/train-worker.js",
  "public/train.js",
  "scripts/train-harness-node.js",
  "scripts/load-train-harness.js",
  "scripts/webgpu-node.js"
]);

function masterPath(optDir) {
  return path.join(optDir, "master.json");
}

function readMaster(optDir) {
  const file = masterPath(optDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeMaster(optDir, master) {
  fs.mkdirSync(optDir, { recursive: true });
  fs.writeFileSync(masterPath(optDir), `${JSON.stringify(master, null, 2)}\n`);
  return master;
}

function currentMasterFps(optDir) {
  const master = readMaster(optDir);
  if (master && Number.isFinite(master.fps)) return master.fps;
  const baseline = store.baselineOf(store.readJsonl(store.jsonlPath(optDir)));
  return baseline ? baseline.fps : null;
}

function filesEqual(a, b) {
  if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

function changedTrainFiles(fromDir, toDir) {
  const changed = [];
  for (const rel of TRAIN_FILES) {
    const src = path.join(fromDir, rel);
    const dest = path.join(toDir, rel);
    if (!fs.existsSync(src)) continue;
    if (!filesEqual(src, dest)) changed.push(rel);
  }
  return changed;
}

function backupTrainFiles(root, files) {
  const backup = {};
  for (const rel of files) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) backup[rel] = fs.readFileSync(full);
  }
  return backup;
}

function restoreTrainFiles(root, backup) {
  for (const [rel, buf] of Object.entries(backup)) {
    fs.writeFileSync(path.join(root, rel), buf);
  }
}

function copyTrainFiles(fromDir, toDir, files = TRAIN_FILES) {
  const copied = [];
  for (const rel of files) {
    const src = path.join(fromDir, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(toDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied.push(rel);
  }
  return copied;
}

function overlayMasterFiles(masterRoot, destRoot) {
  return copyTrainFiles(masterRoot, destRoot, TRAIN_FILES);
}

function pickWinner(entries, options = {}) {
  const minDelta = options.minDelta ?? 0.02;
  const pool = entries.filter((entry) => {
    if (!store.comparable(entry)) return false;
    if (options.iteration != null && entry.iteration !== options.iteration) return false;
    if (options.label && entry.label !== options.label) return false;
    return true;
  });
  const best = store.ranked(pool)[0] || null;
  if (!best) return { ok: false, reason: "no exclusive passing candidate", best: null };
  const masterFps = options.masterFps;
  if (Number.isFinite(masterFps) && best.fps < masterFps * (1 + minDelta)) {
    return {
      ok: false,
      reason: `${best.label} ${best.fps.toFixed(1)} fps does not beat master ${masterFps.toFixed(1)} by ${(minDelta * 100).toFixed(0)}%`,
      best
    };
  }
  return { ok: true, reason: "beats master", best, minDelta };
}

module.exports = {
  TRAIN_FILES,
  backupTrainFiles,
  changedTrainFiles,
  copyTrainFiles,
  currentMasterFps,
  masterPath,
  overlayMasterFiles,
  pickWinner,
  readMaster,
  restoreTrainFiles,
  writeMaster
};
