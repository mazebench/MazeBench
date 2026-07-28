const assert = require("node:assert/strict");
const { loadBrowserScript } = require("./helpers/browser-module-loader");

const callbacks = new Map();
let nextFrameId = 1;

global.performance = { now: () => 0 };
global.document = {
  createElement() {
    return {
      getContext() {
        return null;
      },
      height: 0,
      width: 0
    };
  }
};
global.window = {
  PlayModules: {},
  requestAnimationFrame(callback) {
    const id = nextFrameId;
    nextFrameId += 1;
    callbacks.set(id, callback);
    return id;
  }
};

loadBrowserScript("public/play-render-compositor.js");

const renderedChannels = new Set();
let renderedTimestamp = -1;
let renderCount = 0;
const noop = () => {};
const context = {
  clearRect: noop,
  drawImage: noop,
  fillRect: noop,
  imageSmoothingEnabled: false
};
const canvas = { height: 16, width: 16 };
const app = {
  TILE_SIZE: 1,
  actorRenderElevation: () => 0,
  boardRect: { height: 16, width: 16 },
  cameraX: 0,
  cameraY: 0,
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
  easeInOutQuad: (value) => value,
  isCollectibleActor: () => false,
  isMainPlayerActor: () => false,
  isPlayerActor: () => false,
  levelTransitionFrameId: null,
  renderActors: {
    actorDepthRow: () => 0,
    paintDepthSortedScene: noop,
    paintRaisedPlayer: noop
  },
  renderTerrain: { paintGround: noop },
  sceneCanvas: canvas,
  sceneCtx: context,
  state: { actors: [] },
  viewCanvas: canvas,
  viewCtx: context,
  viewportRect: { height: 16, width: 16 }
};

app.renderOncePerFrame = function renderOncePerFrame(now, channel = "scene") {
  if (now !== renderedTimestamp) {
    renderedTimestamp = now;
    renderedChannels.clear();
  }
  if (renderedChannels.has(channel)) {
    return;
  }
  renderedChannels.add(channel);
  app.render(now);
};
app.render = function render() {
  renderCount += 1;
  app.renderCompositor.startLevelTransitionLoop();
};

window.PlayModules.registerRenderCompositorFunctions(app);
app.renderCompositor.startLevelTransitionLoop();
const transitionFrameId = app.levelTransitionFrameId;
const transitionFrame = callbacks.get(transitionFrameId);

assert.equal(typeof transitionFrame, "function");

// Reproduce the browser race: another renderer callback consumes the normal
// scene channel at the same display timestamp while the transition callback
// is already queued.
app.renderOncePerFrame(100, "scene");
assert.equal(app.levelTransitionFrameId, transitionFrameId);

callbacks.delete(transitionFrameId);
transitionFrame(100);

assert.equal(renderCount, 2, "the transition callback must render despite scene deduplication");
assert.notEqual(
  app.levelTransitionFrameId,
  null,
  "the transition render must leave its next animation frame scheduled"
);
assert.notEqual(app.levelTransitionFrameId, transitionFrameId);

console.log("level-transition-loop: transition RAF survives a same-frame scene render.");
