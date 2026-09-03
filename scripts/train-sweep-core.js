"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MB = 1024 * 1024;
const ENVS = 4;
const DEFAULT_MAX_ENVS = 16;
const DEFAULT_MAX_BATCH = 2048;
const MAX_TRIALS_PER_GENERATION = 64;
const DEFAULT_MAX_RSS_MB = Math.max(1024, Math.min(8192, Math.floor(os.totalmem() / MB / 4)));
const DEFAULT_MIN_FREE_MB = Math.max(512, Math.min(2048, Math.floor(os.totalmem() / MB / 10)));

const SPACE = Object.freeze({
  nEnvs: Object.freeze([1, 2, 4, 8, 16]),
  algorithm: Object.freeze(["ppo", "saloppo"]),
  numSteps: Object.freeze([16, 32, 48, 64, 96, 128, 256]),
  maxActions: Object.freeze([64, 96, 128, 192, 256]),
  learningRate: Object.freeze([1e-4, 2e-4, 3e-4, 6e-4, 1e-3, 2e-3]),
  entropyCoef: Object.freeze([0.001, 0.005, 0.01, 0.02, 0.05]),
  valueCoef: Object.freeze([0.25, 0.5, 0.75, 1]),
  gamma: Object.freeze([0.95, 0.98, 0.99, 0.995]),
  gaeLam: Object.freeze([0.9, 0.95, 0.97]),
  clip: Object.freeze([0.1, 0.2, 0.3]),
  saloCoef: Object.freeze([0.04, 0.08, 0.12, 0.16]),
  gemWeight: Object.freeze([0.5, 1, 1.5]),
  roomWeight: Object.freeze([0.05, 0.1, 0.2]),
  pushWeight: Object.freeze([0.02, 0.05, 0.1]),
  noveltyBonus: Object.freeze([0, 0.005, 0.01, 0.02]),
  deathPenalty: Object.freeze([-0.05, -0.1, 0])
});

const DEFAULT_CONFIG = Object.freeze({
  nEnvs: ENVS,
  algorithm: "ppo",
  numSteps: 32,
  maxActions: 128,
  learningRate: 3e-4,
  entropyCoef: 0.01,
  valueCoef: 0.5,
  gamma: 0.99,
  gaeLam: 0.95,
  clip: 0.2,
  saloCoef: 0.08,
  gemWeight: 1,
  roomWeight: 0.1,
  pushWeight: 0.05,
  noveltyBonus: 0.01,
  deathPenalty: -0.05
});

const KEYS = Object.freeze(Object.keys(SPACE));
const POPULATION = 24;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, values) {
  return values[Math.min(values.length - 1, Math.floor(rng() * values.length))];
}

function clampConfig(raw) {
  const config = {};
  for (const key of KEYS) {
    const allowed = SPACE[key];
    const value = raw && raw[key];
    config[key] = allowed.includes(value) ? value : DEFAULT_CONFIG[key];
  }
  if (config.algorithm !== "saloppo") config.saloCoef = 0;
  return config;
}

function allowedAtMost(values, ceiling) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] <= ceiling) return values[i];
  }
  return null;
}

function constrainConfig(raw, limits = {}) {
  const config = clampConfig(raw);
  const maxEnvs = Math.max(1, Number(limits.maxEnvs) || DEFAULT_MAX_ENVS);
  const maxBatch = Math.max(SPACE.numSteps[0], Number(limits.maxBatch) || DEFAULT_MAX_BATCH);
  if (config.nEnvs > maxEnvs) {
    config.nEnvs = allowedAtMost(SPACE.nEnvs, maxEnvs) || SPACE.nEnvs[0];
  }
  if (config.nEnvs * config.numSteps > maxBatch) {
    if (limits.pinEnvs) {
      config.numSteps = allowedAtMost(SPACE.numSteps, Math.floor(maxBatch / config.nEnvs));
    } else {
      config.nEnvs = allowedAtMost(SPACE.nEnvs, Math.floor(maxBatch / config.numSteps));
    }
  }
  if (!config.nEnvs || !config.numSteps || config.nEnvs * config.numSteps > maxBatch) {
    throw new Error(`resource envelope cannot fit a ${SPACE.nEnvs[0]} env x ${SPACE.numSteps[0]} step batch`);
  }
  return config;
}

function pinValue(config, pins, flag, key) {
  if (!pins || pins[flag] == null) return;
  if (pins[flag] === true) throw new Error(`--${flag} requires a value`);
  const allowed = SPACE[key];
  const raw = typeof allowed[0] === "number" ? Number(pins[flag]) : String(pins[flag]);
  if (!allowed.includes(raw)) {
    throw new Error(`--${flag} must be one of: ${allowed.join(", ")}`);
  }
  config[key] = raw;
}

function pinConfig(config, pins) {
  const next = clampConfig(config);
  pinValue(next, pins, "envs", "nEnvs");
  pinValue(next, pins, "steps", "numSteps");
  pinValue(next, pins, "maxActions", "maxActions");
  pinValue(next, pins, "algorithm", "algorithm");
  pinValue(next, pins, "learningRate", "learningRate");
  pinValue(next, pins, "entropyCoef", "entropyCoef");
  pinValue(next, pins, "valueCoef", "valueCoef");
  pinValue(next, pins, "gamma", "gamma");
  pinValue(next, pins, "gaeLam", "gaeLam");
  pinValue(next, pins, "clip", "clip");
  pinValue(next, pins, "saloCoef", "saloCoef");
  pinValue(next, pins, "gemWeight", "gemWeight");
  pinValue(next, pins, "roomWeight", "roomWeight");
  pinValue(next, pins, "pushWeight", "pushWeight");
  pinValue(next, pins, "noveltyBonus", "noveltyBonus");
  pinValue(next, pins, "deathPenalty", "deathPenalty");
  if (next.algorithm !== "saloppo") next.saloCoef = 0;
  const limits = resourceLimits(pins);
  if (pins && pins.envs != null && next.nEnvs > limits.maxEnvs) {
    throw new Error(`--envs ${next.nEnvs} exceeds --max-envs ${limits.maxEnvs}`);
  }
  if (pins && pins.envs != null && pins.steps != null && next.nEnvs * next.numSteps > limits.maxBatch) {
    throw new Error(`pinned batch ${next.nEnvs} x ${next.numSteps} exceeds --max-batch ${limits.maxBatch}`);
  }
  return constrainConfig(next, {
    ...limits,
    pinEnvs: pins && pins.envs != null
  });
}

function sampleRandom(rng) {
  const config = {};
  for (const key of KEYS) config[key] = pick(rng, SPACE[key]);
  if (config.algorithm !== "saloppo") config.saloCoef = 0;
  return config;
}

function mutate(parent, rng, nChanges = 0) {
  const next = clampConfig(parent);
  const count = nChanges || 1 + Math.floor(rng() * 3);
  for (let i = 0; i < count; i += 1) {
    const key = pick(rng, KEYS);
    next[key] = pick(rng, SPACE[key]);
  }
  if (next.algorithm !== "saloppo") next.saloCoef = 0;
  return next;
}

function crossover(a, b, rng) {
  const child = {};
  for (const key of KEYS) child[key] = rng() < 0.5 ? a[key] : b[key];
  return clampConfig(child);
}

function configKey(config) {
  const locked = clampConfig(config);
  return KEYS.map((key) => `${key}=${locked[key]}`).join("|");
}

function scoreMetrics(metrics) {
  if (!metrics || metrics.error) return -Infinity;
  const reward = Number(metrics.peakReward) || 0;
  const gems = Number(metrics.peakGems) || 0;
  const rooms = Number(metrics.peakRooms) || 0;
  const updates = Number(metrics.updates) || 0;
  return reward + 0.25 * gems + 0.05 * rooms + 1e-4 * updates;
}

function resourceLimits(options = {}) {
  return {
    maxEnvs: Math.max(1, Number(options.maxEnvs) || DEFAULT_MAX_ENVS),
    maxBatch: Math.max(SPACE.numSteps[0], Number(options.maxBatch) || DEFAULT_MAX_BATCH),
    maxRssMb: Math.max(256, Number(options.maxRssMb) || DEFAULT_MAX_RSS_MB),
    minFreeMb: Math.max(256, Number(options.minFreeMb) || DEFAULT_MIN_FREE_MB),
    maxCpuPercent: Math.min(100, Math.max(1, Number(options.maxCpuPercent) || 90)),
    resourcePollMs: Math.max(100, Number(options.resourcePollMs) || 1000),
    resourceGraceSeconds: Math.max(1, Number(options.resourceGraceSeconds) || 30)
  };
}

function cpuTotals(host = os) {
  let idle = 0;
  let total = 0;
  for (const cpu of host.cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

function createSystemResourceSampler(host = os, runtime = process) {
  let previous = cpuTotals(host);
  return function sampleSystemResources() {
    const current = cpuTotals(host);
    const totalDelta = current.total - previous.total;
    const idleDelta = current.idle - previous.idle;
    previous = current;
    return {
      rssMb: runtime.memoryUsage().rss / MB,
      freeMemMb: host.freemem() / MB,
      cpuPercent: totalDelta > 0 ? Math.min(100, (100 * Math.max(0, totalDelta - idleDelta)) / totalDelta) : 0
    };
  };
}

function pressureReasons(snapshot, limits) {
  const reasons = [];
  if (snapshot.rssMb > limits.maxRssMb) {
    reasons.push(`RSS ${snapshot.rssMb.toFixed(0)}MB > ${limits.maxRssMb.toFixed(0)}MB`);
  }
  if (snapshot.freeMemMb < limits.minFreeMb) {
    reasons.push(`free memory ${snapshot.freeMemMb.toFixed(0)}MB < ${limits.minFreeMb.toFixed(0)}MB`);
  }
  if (snapshot.cpuPercent > limits.maxCpuPercent) {
    reasons.push(`CPU ${snapshot.cpuPercent.toFixed(1)}% > ${limits.maxCpuPercent.toFixed(1)}%`);
  }
  return reasons;
}

class ResourceLimitError extends Error {
  constructor(reasons, snapshot) {
    super(`resource pressure persisted: ${reasons.join("; ")}`);
    this.name = "ResourceLimitError";
    this.code = "MAZEBENCH_RESOURCE_LIMIT";
    this.reasons = reasons;
    this.snapshot = snapshot;
  }
}

function isResourceFailure(error) {
  if (error && error.code === "MAZEBENCH_RESOURCE_LIMIT") return true;
  return /out of memory|resource exhausted|allocation failed|device.*lost/i.test(String(error && (error.message || error)));
}

function createResourceMonitor(options = {}, hooks = {}) {
  const limits = resourceLimits(options);
  const sample = hooks.sample || createSystemResourceSampler();
  const sleep = hooks.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const logger = hooks.logger || (() => {});
  const stats = {
    samples: 0,
    pauseCount: 0,
    pausedMs: 0,
    peakRssMb: 0,
    minFreeMemMb: Infinity,
    peakCpuPercent: 0
  };

  function observe(snapshot) {
    stats.samples += 1;
    stats.peakRssMb = Math.max(stats.peakRssMb, snapshot.rssMb);
    stats.minFreeMemMb = Math.min(stats.minFreeMemMb, snapshot.freeMemMb);
    stats.peakCpuPercent = Math.max(stats.peakCpuPercent, snapshot.cpuPercent);
  }

  async function checkpoint(label = "training") {
    let waitedMs = 0;
    let announced = false;
    while (true) {
      const snapshot = sample();
      observe(snapshot);
      const reasons = pressureReasons(snapshot, limits);
      if (!reasons.length) return snapshot;
      if (!announced) {
        stats.pauseCount += 1;
        logger(`${label}: ${reasons.join("; ")}; pausing`);
        announced = true;
      }
      if (waitedMs >= limits.resourceGraceSeconds * 1000) {
        throw new ResourceLimitError(reasons, snapshot);
      }
      const delay = Math.min(limits.resourcePollMs, limits.resourceGraceSeconds * 1000 - waitedMs);
      await sleep(delay);
      waitedMs += delay;
      stats.pausedMs += delay;
    }
  }

  function summary() {
    return {
      samples: stats.samples,
      pauseCount: stats.pauseCount,
      pausedMs: stats.pausedMs,
      peakRssMb: stats.peakRssMb,
      minFreeMemMb: Number.isFinite(stats.minFreeMemMb) ? stats.minFreeMemMb : 0,
      peakCpuPercent: stats.peakCpuPercent
    };
  }

  return { checkpoint, limits, summary };
}

function emptyState() {
  return {
    generation: 0,
    trials: 0,
    best: null,
    population: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function rank(population) {
  return population
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.metrics?.peakReward || 0) - (a.metrics?.peakReward || 0));
}

function recordTrial(state, trial) {
  const next = {
    ...state,
    trials: (state.trials || 0) + 1,
    updatedAt: new Date().toISOString()
  };
  const scored = {
    id: trial.id,
    config: clampConfig(trial.config),
    score: scoreMetrics(trial.metrics),
    metrics: trial.metrics,
    createdAt: trial.createdAt || new Date().toISOString()
  };
  const population = rank([...(state.population || []), scored]).slice(0, POPULATION);
  next.population = population;
  if (!next.best || scored.score > next.best.score) next.best = scored;
  return next;
}

function nextCandidates(state, width, rng) {
  const n = Math.max(1, width | 0);
  const population = state && state.population ? state.population : [];
  const out = [];
  const seen = new Set();
  function push(config, origin) {
    const locked = clampConfig(config);
    const key = configKey(locked);
    if (seen.has(key)) return false;
    seen.add(key);
    out.push({ config: locked, origin });
    return true;
  }
  if (!population.length) {
    while (out.length < n) push(sampleRandom(rng), "random");
    return out;
  }
  const best = population[0];
  push(mutate(best.config, rng), "mutate-best");
  let guard = 0;
  while (out.length < n && guard < 200) {
    guard += 1;
    const roll = rng();
    if (roll < 0.5) push(mutate(best.config, rng), "mutate-best");
    else if (roll < 0.75 && population.length > 1) {
      const other = population[1 + Math.floor(rng() * Math.max(1, Math.min(7, population.length - 1)))];
      push(crossover(best.config, other.config, rng), "crossover");
    } else if (roll < 0.9) {
      const parent = population[Math.floor(rng() * Math.min(8, population.length))];
      push(mutate(parent.config, rng), "mutate-pool");
    } else push(sampleRandom(rng), "random");
  }
  while (out.length < n) push(sampleRandom(rng), "random");
  return out;
}

function defaultDir() {
  return path.join(path.resolve(__dirname, ".."), "outputs", "train-sweep");
}

function statePath(dir) {
  return path.join(dir, "state.json");
}

function trialsPath(dir) {
  return path.join(dir, "trials.jsonl");
}

function loadState(dir) {
  const file = statePath(dir);
  if (!fs.existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const normalizeTrial = (trial) =>
      trial && {
        ...trial,
        config: clampConfig(trial.config)
      };
    return {
      ...emptyState(),
      ...parsed,
      best: normalizeTrial(parsed.best),
      population: Array.isArray(parsed.population) ? parsed.population.map(normalizeTrial).filter(Boolean) : []
    };
  } catch {
    return emptyState();
  }
}

function saveState(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  const payload = { ...state, updatedAt: new Date().toISOString() };
  fs.writeFileSync(statePath(dir), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

function appendTrial(dir, trial) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(trialsPath(dir), `${JSON.stringify(trial)}\n`);
}

function helpText() {
  return `Headless Dawn trainer. Each trial trains for a fixed wall-time budget, then
the next candidate searches every runtime training hyperparameter.

Search space:
  envs, algorithm, steps/update, actions/episode, learning rate, entropy/value
  coefficients, gamma, GAE lambda, PPO clip, Salo coefficient, and every reward
  or penalty weight. Any field can be pinned with its kebab-case flag, such as:
  --envs 4 --steps 32 --max-actions 128 --learning-rate 0.0003
  --entropy-coef 0.01 --value-coef 0.5 --gamma 0.99 --gae-lambda 0.95
  --clip 0.2 --salo-coef 0.08 --gem-weight 1 --room-weight 0.1
  --push-weight 0.05 --novelty-bonus 0.01 --death-penalty -0.05

Run control:
  --seconds 30        wall time per trial
  --hours 8           total search time (0 = until Ctrl+C)
  --trials 4          candidates per generation (maximum ${MAX_TRIALS_PER_GENERATION})
  --level level_HxI   start room
  --seed 1
  --dir outputs/train-sweep

Resource envelope (enabled by default):
  --max-envs ${DEFAULT_MAX_ENVS}         largest searched env count
  --max-batch ${DEFAULT_MAX_BATCH}      maximum envs x steps per update
  --max-rss-mb ${DEFAULT_MAX_RSS_MB}     stop after sustained process-memory pressure
  --min-free-mb ${DEFAULT_MIN_FREE_MB}    stop after sustained system-memory pressure
  --max-cpu-percent 90  pause while total CPU is above this percentage
  --resource-poll-ms 1000
  --resource-grace-seconds 30

  node scripts/train-sweep.js --seconds 30 --hours 8
  node scripts/train-sweep.js status
`;
}

function parseArgs(argv) {
  const out = {
    _: [],
    hours: 8,
    seed: 1,
    level: "level_HxI",
    dir: defaultDir()
  };
  const names = {
    "max-actions": "maxActions",
    "learning-rate": "learningRate",
    "entropy-coef": "entropyCoef",
    "value-coef": "valueCoef",
    "gae-lambda": "gaeLam",
    "salo-coef": "saloCoef",
    "gem-weight": "gemWeight",
    "room-weight": "roomWeight",
    "push-weight": "pushWeight",
    "novelty-bonus": "noveltyBonus",
    "death-penalty": "deathPenalty",
    "max-envs": "maxEnvs",
    "max-batch": "maxBatch",
    "max-rss-mb": "maxRssMb",
    "min-free-mb": "minFreeMb",
    "max-cpu-percent": "maxCpuPercent",
    "resource-poll-ms": "resourcePollMs",
    "resource-grace-seconds": "resourceGraceSeconds"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = names[arg.slice(2)] || arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  for (const key of [
    "envs",
    "steps",
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
  ]) {
    if (out[key] != null && out[key] !== true) out[key] = Number(out[key]);
  }
  out.seconds = Math.max(2, Number(out.seconds ?? out.budget) || 30);
  const hours = Number(out.hours);
  out.hours = Number.isFinite(hours) && hours >= 0 ? hours : 8;
  out.trials = Math.min(MAX_TRIALS_PER_GENERATION, Math.max(1, Number(out.trials ?? out.width) || 4));
  out.budget = out.seconds;
  out.width = out.trials;
  out.seed = Number(out.seed) || 1;
  out.dir = path.resolve(String(out.dir));
  out.level = String(out.level || "level_HxI");
  Object.assign(out, resourceLimits(out));
  return out;
}

module.exports = {
  DEFAULT_CONFIG,
  ENVS,
  KEYS,
  POPULATION,
  ResourceLimitError,
  SPACE,
  appendTrial,
  clampConfig,
  configKey,
  constrainConfig,
  createResourceMonitor,
  createSystemResourceSampler,
  crossover,
  defaultDir,
  emptyState,
  isResourceFailure,
  helpText,
  loadState,
  mulberry32,
  mutate,
  nextCandidates,
  parseArgs,
  pinConfig,
  pressureReasons,
  recordTrial,
  resourceLimits,
  sampleRandom,
  saveState,
  scoreMetrics
};
