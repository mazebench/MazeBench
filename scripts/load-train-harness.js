"use strict";

const { loadBrowserScript } = require("../tests/helpers/browser-module-loader");

let loaded = false;

function loadTrainHarness() {
  if (loaded) return globalThis;
  globalThis.window = globalThis.window || globalThis;
  globalThis.self = globalThis.self || globalThis;
  loadBrowserScript("public/maze-engine.js");
  loadBrowserScript("public/train-env.js");
  loadBrowserScript("public/train-profile.js");
  loadBrowserScript("public/train-ppo-webgpu.js");
  loaded = true;
  return globalThis;
}

module.exports = { loadTrainHarness };
