"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function mainRepoRoot(fromDir = process.cwd()) {
  try {
    const common = git(["rev-parse", "--git-common-dir"], fromDir);
    return path.dirname(path.resolve(fromDir, common));
  } catch {
    return path.resolve(__dirname, "..");
  }
}

function worktreeRoot(fromDir = process.cwd()) {
  try {
    return git(["rev-parse", "--show-toplevel"], fromDir);
  } catch {
    return path.resolve(fromDir);
  }
}

function defaultOptDir(fromDir = process.cwd()) {
  if (process.env.MAZEBENCH_TRAIN_OPT_DIR) return path.resolve(process.env.MAZEBENCH_TRAIN_OPT_DIR);
  return path.join(mainRepoRoot(fromDir), "outputs", "train-opt");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function jsonlPath(optDir) {
  return path.join(optDir, "leaderboard.jsonl");
}

function statusJsonPath(optDir) {
  return path.join(optDir, "status.json");
}

function statusMdPath(optDir) {
  return path.join(optDir, "status.md");
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readMasterFile(optDir) {
  return readJsonFile(path.join(optDir, "master.json"));
}

function runStatePath(optDir) {
  return path.join(optDir, "run.json");
}

function readRunState(optDir) {
  return readJsonFile(runStatePath(optDir));
}

function writeRunState(optDir, run) {
  fs.mkdirSync(optDir, { recursive: true });
  fs.writeFileSync(runStatePath(optDir), `${JSON.stringify(run, null, 2)}\n`);
  return run;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function profileCount(profile, needle) {
  let count = 0;
  for (const row of profile || []) {
    if (String(row.path || "").includes(needle)) count += Number(row.count) || 0;
  }
  return count;
}

function hotspotRows(profile, limit = 5) {
  return (profile || []).slice(0, limit).map((row) => ({
    path: row.path,
    avgMs: row.avgMs,
    count: row.count,
    inclusiveMs: row.inclusiveMs
  }));
}

function comparable(entry) {
  return entry && entry.exclusive === true && entry.testsOk !== false && Number.isFinite(entry.fps);
}

function ranked(entries) {
  return entries.filter(comparable).sort((a, b) => b.fps - a.fps);
}

function baselineOf(entries) {
  const baselines = entries.filter((entry) => entry.label === "baseline" && comparable(entry));
  return baselines.length ? baselines[baselines.length - 1] : null;
}

function bestOf(entries) {
  const list = ranked(entries);
  return list[0] || null;
}

function deltaPct(fps, baselineFps) {
  if (!Number.isFinite(fps) || !Number.isFinite(baselineFps) || baselineFps <= 0) return null;
  return (100 * (fps - baselineFps)) / baselineFps;
}

function formatDelta(pct) {
  if (pct == null) return "n/a";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function buildStatus(optDir, extra = {}) {
  const entries = readJsonl(jsonlPath(optDir));
  const baseline = baselineOf(entries);
  const best = bestOf(entries);
  const baselineFps = baseline ? baseline.fps : null;
  const ranking = ranked(entries).map((entry, index) => ({
    rank: index + 1,
    id: entry.id,
    label: entry.label,
    fps: entry.fps,
    deltaPct: deltaPct(entry.fps, baselineFps),
    testsOk: entry.testsOk !== false,
    exclusive: entry.exclusive === true,
    readF32PerFrame: entry.readF32PerFrame,
    iteration: entry.iteration,
    slot: entry.slot,
    idea: entry.idea || ""
  }));
  return {
    updatedAt: extra.updatedAt || new Date().toISOString(),
    optDir,
    comparableValue: "exclusive Dawn fps (GPU lock; only one bench at a time)",
    invariantValue: "readF32PerFrame (count/frame; comparable even if the GPU is busy)",
    gpu: extra.gpu || { locked: false, owner: null },
    run: extra.run || readRunState(optDir),
    master: extra.master || readMasterFile(optDir),
    baselineFps,
    bestFps: best ? best.fps : null,
    bestLabel: best ? best.label : null,
    deltaPct: best ? deltaPct(best.fps, baselineFps) : null,
    entries: entries.length,
    ranking,
    latest: entries.slice(-8)
  };
}

function renderStatusMd(status) {
  const lines = [
    "# Train optimization arena",
    "",
    `- updated: ${status.updatedAt}`,
    `- comparable value: **${status.comparableValue}**`,
    `- contention-invariant: ${status.invariantValue}`,
    `- gpu: ${status.gpu?.locked ? `LOCKED pid ${status.gpu.owner?.pid || "?"} (${status.gpu.owner?.label || ""})` : "idle"}`,
    `- master: ${status.master ? `${status.master.label} ${Number(status.master.fps).toFixed(1)} fps (from ${status.master.from || "initial"})` : "none — next wave uses the working tree"}`,
    `- baseline: ${status.baselineFps != null ? `${status.baselineFps.toFixed(1)} fps` : "none"}`,
    `- best: ${status.bestLabel ? `${status.bestLabel} ${status.bestFps.toFixed(1)} fps (${formatDelta(status.deltaPct)})` : "none"}`,
    ""
  ];
  if (status.run) {
    lines.push(
      `- run: iteration ${status.run.iteration}/${status.run.iterations} width ${status.run.width} (${status.run.state || "running"})`,
      ""
    );
  }
  lines.push("| rank | fps | vs baseline | label | tests | readF32/frame | iter | idea |", "| --- | ---: | ---: | --- | --- | ---: | ---: | --- |");
  if (!status.ranking.length) {
    lines.push("|  |  |  | _empty_ |  |  |  |  |", "");
    return lines.join("\n");
  }
  for (const row of status.ranking.slice(0, 20)) {
    const idea = String(row.idea || "").replace(/\|/g, "/").slice(0, 80);
    lines.push(
      `| ${row.rank} | ${row.fps.toFixed(1)} | ${formatDelta(row.deltaPct)} | ${row.label} | ${row.testsOk ? "pass" : "fail"} | ${
        row.readF32PerFrame == null ? "" : Number(row.readF32PerFrame).toFixed(2)
      } | ${row.iteration ?? ""} | ${idea} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function writeStatus(optDir, extra = {}) {
  ensureDir(optDir);
  const status = buildStatus(optDir, extra);
  fs.writeFileSync(statusJsonPath(optDir), `${JSON.stringify(status, null, 2)}\n`);
  fs.writeFileSync(statusMdPath(optDir), renderStatusMd(status));
  return status;
}

function appendEntry(optDir, entry) {
  ensureDir(optDir);
  fs.appendFileSync(jsonlPath(optDir), `${JSON.stringify(entry)}\n`);
  return writeStatus(optDir, { updatedAt: entry.createdAt });
}

function gitIdentity(cwd = process.cwd()) {
  try {
    return {
      head: git(["rev-parse", "--short", "HEAD"], cwd),
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
      toplevel: worktreeRoot(cwd)
    };
  } catch {
    return { head: "", branch: "", toplevel: cwd };
  }
}

function newId(prefix = "opt") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  appendEntry,
  baselineOf,
  bestOf,
  buildStatus,
  comparable,
  defaultOptDir,
  deltaPct,
  formatDelta,
  gitIdentity,
  hotspotRows,
  jsonlPath,
  mainRepoRoot,
  newId,
  profileCount,
  ranked,
  readJsonl,
  readMasterFile,
  readRunState,
  renderStatusMd,
  runStatePath,
  statusJsonPath,
  statusMdPath,
  worktreeRoot,
  writeRunState,
  writeStatus
};
