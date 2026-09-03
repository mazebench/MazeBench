"use strict";

const { loadBrowserScript } = require("./browser-module-loader");

function loadCpuHarness() {
  globalThis.window = globalThis.window || globalThis;
  globalThis.self = globalThis.self || globalThis;
  if (!globalThis.MazeEngine) loadBrowserScript("public/maze-engine.js");
  if (!globalThis.TrainEnv) loadBrowserScript("public/train-env.js");
  if (!globalThis.TrainProfile) loadBrowserScript("public/train-profile.js");
  if (!globalThis.TrainPpo) loadBrowserScript("public/train-ppo-webgpu.js");
  return globalThis;
}

function playData() {
  const { defaultLevelIdForGame, getGame, getLevel, getLevelState } = require("../../server/app");
  const game = getGame("maze");
  const levelId = defaultLevelIdForGame(game);
  return { game, levelId, playData: getLevelState(game, getLevel(game, levelId)) };
}

async function makeEnv(overrides = {}) {
  const { TrainEnv } = loadCpuHarness();
  const start = playData();
  const env = new TrainEnv.MazeTrainEnv({
    playCache: new Map([[start.levelId, start.playData]]),
    fetchPlayData: async (levelId) => {
      const { getGame, getLevel, getLevelState } = require("../../server/app");
      const game = getGame("maze");
      const level = getLevel(game, levelId);
      if (!level) throw new Error(levelId);
      return getLevelState(game, level);
    },
    startLevelId: start.levelId,
    maxActions: 64,
    ...overrides
  });
  await env.reset();
  return env;
}

function floorCell() {
  return { type: "floor" };
}

function wallCell() {
  return { type: "wall", layers: [{ type: "wall", elevation: 0 }] };
}

function iceCell() {
  return { type: "ice", layers: [{ type: "ice", elevation: 0 }] };
}

function emptyCell() {
  return { type: "empty", layers: [] };
}

function holeCell() {
  return { type: "hole" };
}

function floorTerrain(width, height) {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => floorCell()));
}

function actor(type, x, y, extra = {}) {
  return { type, x, y, elevation: 0, removed: false, ...extra };
}

async function makeBoardEnv(spec, overrides = {}) {
  const { TrainEnv } = loadCpuHarness();
  const levelId = spec.levelId || "level_AxA";
  const playData = spec.playData || {
    width: spec.width,
    height: spec.height,
    terrain: spec.terrain,
    actors: spec.actors
  };
  const playCache = spec.playCache || new Map([[levelId, playData]]);
  const env = new TrainEnv.MazeTrainEnv({
    playCache,
    fetchPlayData: async (id) => {
      if (!playCache.has(id)) throw new Error(`missing ${id}`);
      return playCache.get(id);
    },
    startLevelId: levelId,
    maxActions: 64,
    ...overrides
  });
  await env.reset();
  return env;
}

function actorPos(env, type) {
  for (let index = 0; index < env.engine.actorCount; index += 1) {
    if (env.engine.actorTypes[index] !== type || env.state.actorRemoved[index]) continue;
    return {
      index,
      x: env.state.actorX[index],
      y: env.state.actorY[index],
      elevation: env.state.actorElevation[index]
    };
  }
  return null;
}

function actorsOf(env, type) {
  const found = [];
  for (let index = 0; index < env.engine.actorCount; index += 1) {
    if (env.engine.actorTypes[index] !== type || env.state.actorRemoved[index]) continue;
    found.push({
      index,
      x: env.state.actorX[index],
      y: env.state.actorY[index],
      elevation: env.state.actorElevation[index]
    });
  }
  return found;
}

function maxAbsDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let max = 0;
  for (let i = 0; i < n; i += 1) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}

function allFinite(values) {
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isFinite(values[i])) return false;
  }
  return true;
}

async function test(name, fn) {
  const started = performance.now();
  await fn();
  console.log(`  ok  ${name}  ${(performance.now() - started).toFixed(1)}ms`);
}

module.exports = {
  actor,
  actorPos,
  actorsOf,
  allFinite,
  emptyCell,
  floorCell,
  floorTerrain,
  holeCell,
  iceCell,
  loadCpuHarness,
  makeBoardEnv,
  makeEnv,
  maxAbsDiff,
  playData,
  test,
  wallCell
};
