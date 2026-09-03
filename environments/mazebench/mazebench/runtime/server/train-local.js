const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// The whole runs folder is capped at 100 KB. Everything lives in one deflated
// blob so the budget is exact (no per-file cluster slack, no stat guessing):
// serialize -> compress -> shrink until it fits -> write once.
const BUDGET_BYTES = 100 * 1024;
const STORE_FILE = "store";
const TMP_FILE = "store.tmp";
// Points kept per series before shape-preserving decimation kicks in.
const MAX_POINTS = 512;
const MIN_POINTS = 16;
// Every append would otherwise re-deflate the whole store, so writes are
// batched: at most one disk write per FLUSH_EVERY appends or FLUSH_MS.
const FLUSH_EVERY = 128;
const FLUSH_MS = 1000;
const SERIES_FILES = ["metrics.jsonl", "episodes.jsonl"];

// Records in a series share a key set, so store the keys once and the values in
// per-key columns: deflate then sees runs of similar numbers instead of a
// repeated JSON skeleton. Records with a different key set get their own shape;
// the run-length encoded shape order restores the original interleaving.
function packRecords(records) {
  const shapes = [];
  const columns = [];
  const byKeys = new Map();
  const order = [];
  for (const record of records) {
    const keys = Object.keys(record);
    const signature = JSON.stringify(keys);
    let shape = byKeys.get(signature);
    if (shape === undefined) {
      shape = shapes.length;
      shapes.push(keys);
      columns.push(keys.map(() => []));
      byKeys.set(signature, shape);
    }
    const last = order[order.length - 1];
    if (last && last[0] === shape) last[1] += 1;
    else order.push([shape, 1]);
    keys.forEach((key, index) => columns[shape][index].push(record[key]));
  }
  return { s: shapes, o: order, c: columns };
}

function unpackRecords(packed) {
  if (!packed || !Array.isArray(packed.s)) return [];
  const cursors = packed.s.map(() => 0);
  const records = [];
  for (const [shape, count] of packed.o || []) {
    const keys = packed.s[shape] || [];
    const columns = packed.c[shape] || [];
    for (let n = 0; n < count; n += 1) {
      const at = cursors[shape];
      cursors[shape] += 1;
      const record = {};
      keys.forEach((key, index) => {
        record[key] = columns[index][at];
      });
      records.push(record);
    }
  }
  return records;
}

// Halve a series while keeping the first and last points, so a long run still
// renders with the same shape and the same endpoints after shrinking.
function decimate(records) {
  if (records.length <= 2) return records;
  const kept = [];
  for (let index = 0; index < records.length; index += 2) kept.push(records[index]);
  const last = records[records.length - 1];
  if (kept[kept.length - 1] !== last) kept.push(last);
  return kept;
}

function createLocalTrainStore(rootDir) {
  const runsDir = path.join(rootDir, "outputs", "webgpu-train", "runs");
  const storePath = path.join(runsDir, STORE_FILE);
  let state = null;
  let dirty = 0;
  let flushTimer = null;

  function load() {
    if (state) return state;
    try {
      const raw = zlib.inflateRawSync(fs.readFileSync(storePath));
      const parsed = JSON.parse(raw.toString("utf8"));
      state = {
        runs: (parsed.r || []).map((entry) => ({
          meta: entry.m,
          series: Object.fromEntries(
            SERIES_FILES.map((name, index) => [name, unpackRecords((entry.s || [])[index])])
          )
        }))
      };
    } catch (_error) {
      state = { runs: [] };
    }
    return state;
  }

  function serialize(runs) {
    const payload = {
      r: runs.map((run) => ({
        m: run.meta,
        s: SERIES_FILES.map((name) => packRecords(run.series[name] || []))
      }))
    };
    return zlib.deflateRawSync(Buffer.from(JSON.stringify(payload), "utf8"), { level: 9 });
  }

  function largestSeries(runs) {
    let best = null;
    for (const run of runs) {
      for (const name of SERIES_FILES) {
        const series = run.series[name] || [];
        if (series.length > MIN_POINTS && (!best || series.length > best.length)) {
          best = { run, name, length: series.length };
        }
      }
    }
    return best;
  }

  // Drop resolution before history: decimate the fattest series repeatedly, and
  // only once every series sits at the floor start evicting the oldest runs.
  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!dirty || !state) return;
    dirty = 0;
    fs.mkdirSync(runsDir, { recursive: true });
    const runs = state.runs;
    let buffer = serialize(runs);
    while (buffer.length > BUDGET_BYTES) {
      const target = largestSeries(runs);
      if (target) {
        target.run.series[target.name] = decimate(target.run.series[target.name]);
      } else if (runs.length > 1) {
        runs.shift();
      } else if (runs.length === 1) {
        const run = runs[0];
        const trimmable = SERIES_FILES.filter((name) => (run.series[name] || []).length > 1);
        if (!trimmable.length) break;
        for (const name of trimmable) run.series[name] = decimate(run.series[name]);
      } else {
        break;
      }
      buffer = serialize(runs);
    }
    const tmpPath = path.join(runsDir, TMP_FILE);
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, storePath);
  }

  function persist(immediate = false) {
    dirty += 1;
    if (immediate || dirty >= FLUSH_EVERY) {
      flush();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(flush, FLUSH_MS);
      if (typeof flushTimer.unref === "function") flushTimer.unref();
    }
  }

  function findRun(id) {
    return load().runs.find((run) => run.meta.id === id) || null;
  }

  function listRuns(limit = 20) {
    const runs = load()
      .runs.map((run) => run.meta)
      .slice()
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return runs.slice(0, Math.max(limit, 20));
  }

  function getRun(id) {
    const run = findRun(id);
    if (!run) return null;
    return {
      ...run.meta,
      metrics: run.series["metrics.jsonl"].slice(),
      episodes: run.series["episodes.jsonl"].slice()
    };
  }

  function createRun(payload = {}) {
    load();
    const id = `webgpu-${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const meta = {
      id,
      name: payload.name || "WebGPU PPO",
      status: "running",
      createdAt: now,
      updatedAt: now,
      config: payload.config || {},
      adapter: payload.adapter || "",
      updates: 0,
      episodes: 0
    };
    state.runs.push({
      meta,
      series: Object.fromEntries(SERIES_FILES.map((name) => [name, []]))
    });
    persist(true);
    return meta;
  }

  function appendJsonl(id, fileName, record) {
    const run = findRun(id);
    if (!run || !SERIES_FILES.includes(fileName)) return null;
    const series = run.series[fileName];
    series.push(record);
    if (series.length > MAX_POINTS) run.series[fileName] = decimate(series);

    const meta = run.meta;
    meta.updatedAt = new Date().toISOString();
    if (fileName === "metrics.jsonl") {
      meta.updates = (meta.updates || 0) + 1;
      const reward = Number(record.rewardMean);
      const fps = Number(record.fps);
      const gems = Number(record.gemsMean);
      const entropy = Number(record.entropy);
      if (Number.isFinite(reward)) {
        meta.lastReward = reward;
        meta.bestReward = Math.max(Number(meta.bestReward) || -Infinity, reward);
      }
      if (Number.isFinite(fps)) meta.lastFps = fps;
      if (Number.isFinite(gems)) {
        meta.lastGems = gems;
        meta.bestGems = Math.max(Number(meta.bestGems) || 0, gems);
      }
      if (Number.isFinite(entropy)) meta.lastEntropy = entropy;
      if (record.adapter) meta.adapter = record.adapter;
    }
    if (fileName === "episodes.jsonl") {
      meta.episodes = (meta.episodes || 0) + 1;
      const episodeReward = Number(record.reward);
      if (Number.isFinite(episodeReward)) {
        meta.bestEpisodeReward = Math.max(Number(meta.bestEpisodeReward) || -Infinity, episodeReward);
      }
    }
    if (record.status) meta.status = record.status;
    persist();
    return meta;
  }

  function finishRun(id, status = "finished") {
    const run = findRun(id);
    if (!run) return null;
    run.meta.status = status;
    run.meta.updatedAt = new Date().toISOString();
    persist(true);
    return run.meta;
  }

  for (const signal of ["exit", "SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      try {
        flush();
      } catch (_error) {
        /* best effort on shutdown */
      }
    });
  }

  return { listRuns, getRun, createRun, appendJsonl, finishRun, flush };
}

module.exports = { createLocalTrainStore, BUDGET_BYTES };
