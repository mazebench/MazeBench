const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { loadBrowserScript } = require("./helpers/browser-module-loader");

function createStubCanvasContext() {
  const noop = () => {};
  return {
    arc: noop,
    beginPath: noop,
    clearRect: noop,
    clip: noop,
    closePath: noop,
    drawImage: noop,
    ellipse: noop,
    fill: noop,
    fillRect: noop,
    lineTo: noop,
    moveTo: noop,
    quadraticCurveTo: noop,
    rect: noop,
    restore: noop,
    rotate: noop,
    save: noop,
    scale: noop,
    setTransform: noop,
    stroke: noop,
    strokeRect: noop,
    translate: noop
  };
}

function createStubCanvas() {
  return {
    width: 0,
    height: 0,
    style: {},
    getContext(type) {
      return type === "webgl" ? null : createStubCanvasContext();
    }
  };
}

const storage = new Map();
const checkpointEvents = [];
global.performance = performance;
global.document = {
  title: "",
  createElement(tag) {
    return tag === "canvas" ? createStubCanvas() : {};
  }
};
global.window = {
  PlayModules: {},
  CustomEvent: class CustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  },
  cancelAnimationFrame() {},
  devicePixelRatio: 1,
  dispatchEvent(event) {
    if (event.type === "mazebench:checkpoint-progress") checkpointEvents.push(event.detail);
  },
  history: { replaceState() {} },
  localStorage: {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    }
  },
  location: { hash: "", pathname: "/play/maze/level_AxA", search: "" },
  requestAnimationFrame(callback) {
    callback(performance.now() + 1000);
    return 1;
  },
  setTimeout(callback) {
    callback();
    return 1;
  }
};

loadBrowserScript("public/play-rules.js");
loadBrowserScript("public/maze-engine.js");
loadBrowserScript("public/play-core.js");
loadBrowserScript("public/play-movement.js");
loadBrowserScript("public/play-world-transitions.js");
loadBrowserScript("public/play-gameplay.js");

function floorTerrain(width = 5, height = 1) {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({
      type: "floor",
      layers: [{ type: "floor", elevation: 0 }]
    }))
  );
}

function checkpoint(kind, x, y = 0, elevation = 0) {
  return { kind, x, y, elevation };
}

function levelState(levelId, options = {}) {
  return {
    gameId: "maze",
    levelId,
    levelLabel: levelId,
    width: 5,
    height: 1,
    terrain: floorTerrain(),
    actors: options.actors || [
      { type: "player", x: options.playerX ?? 0, y: 0, elevation: 0, removed: false }
    ],
    checkpoints: options.checkpoints || [checkpoint("primary", options.primaryX ?? 0)]
  };
}

function createApp(playData) {
  storage.clear();
  checkpointEvents.length = 0;
  const app = window.PlayModules.createPlayCore({
    playData,
    canvas: createStubCanvas(),
    playShell: null,
    playHeader: null,
    playStage: null,
    mazeFrame: null,
    fuzzyToggle: null
  });
  app.render = () => {};
  window.PlayModules.registerGameplayFunctions(app);
  return app;
}

{
  const app = createApp(levelState("level_AxA", {
    checkpoints: [checkpoint("primary", 0), checkpoint("secondary", 2)]
  }));
  const primaryId = "level_AxA:checkpoint:primary";

  assert.deepEqual(app.exportCheckpointProgress(), {
    version: 1,
    activated: [primaryId],
    custom: [],
    selected: [{ levelId: "level_AxA", checkpointId: primaryId }],
    resume: { levelId: "level_AxA", checkpointId: primaryId }
  });
  assert.equal(app.isCheckpointLevelVisited("level_AxA"), true);
  assert.equal(app.state.checkpoints.find(({ id }) => id === primaryId).active, true);
  assert.equal(app.canPlaceUserCheckpointFlag().reason, "authored-checkpoint-overlap");
  assert.equal(app.selectNextCheckpointForLevel(), null, "an untouched secondary is not cycleable");
  assert.equal(checkpointEvents.at(-1).type, "activated");
}

{
  const app = createApp(levelState("level_AxA"));
  const destination = levelState("level_BxA", {
    playerX: 0,
    primaryX: 2,
    checkpoints: [checkpoint("secondary", 1), checkpoint("primary", 2)]
  });
  app.applyLevelState(destination, { resetHistory: true, resetLevelEntry: true });
  app.touchCheckpointsAtPlayer({ reason: "room-arrival" });
  assert.equal(app.isCheckpointLevelVisited("level_BxA"), false, "room entry alone must not visit");

  const player = app.state.actors.find((actor) => actor.type === "player");
  app.touchCheckpointsFromMoves([{
    actor: player,
    fromX: 0,
    fromY: 0,
    fromElevation: 0,
    toX: 2,
    toY: 0,
    toElevation: 0,
    path: [
      { x: 1, y: 0, elevation: 0 },
      { x: 2, y: 0, elevation: 0 }
    ]
  }]);
  assert.equal(app.isCheckpointLevelVisited("level_BxA"), true);
  assert.deepEqual(
    app.activatedCheckpointsForLevel("level_BxA").map(({ id }) => id),
    [
      "level_BxA:checkpoint:primary",
      "level_BxA:checkpoint:secondary:1:0:0"
    ],
    "forced movement must activate every checkpoint crossed"
  );
  assert.equal(
    app.selectedCheckpointForLevel("level_BxA").id,
    "level_BxA:checkpoint:primary",
    "the final checkpoint crossed becomes the reset spawn"
  );
}

{
  const app = createApp(levelState("level_CxA", {
    playerX: 1,
    primaryX: 0,
    actors: [
      { type: "player", x: 1, y: 0, elevation: 0, removed: false },
      { type: "box", x: 3, y: 0, elevation: 0, removed: false }
    ]
  }));
  assert.equal(app.isCheckpointLevelVisited("level_CxA"), false);
  assert.deepEqual(app.canPlaceUserCheckpointFlag(), { allowed: true, reason: null });
  const beforeRejectedPlacement = app.exportCheckpointProgress();
  app.canPersistCheckpointProgress = () => ({ allowed: false, reason: "host-capacity" });
  assert.equal(app.placeUserCheckpointFlag().reason, "host-capacity");
  assert.deepEqual(
    app.exportCheckpointProgress(),
    beforeRejectedPlacement,
    "host capacity rejection must happen before any checkpoint mutation"
  );
  app.canPersistCheckpointProgress = null;
  const placed = app.placeUserCheckpointFlag();
  const userId = "level_CxA:checkpoint:user:1:0:0";
  assert.equal(placed.changed, true);
  assert.equal(app.hasCheckpointSpawnForLevel("level_CxA"), true);

  app.state.actors[1].x = 4;
  app.state.actors[0].x = 2;
  assert.equal(app.canPlaceUserCheckpointFlag().reason, "room-state-changed");

  app.state.actors[0].x = 1;
  assert.equal(app.removeUserCheckpointFlag().removed, true);
  assert.equal(app.runtimeCheckpointsForLevel("level_CxA").some(({ id }) => id === userId), false);
  assert.equal(app.exportCheckpointProgress().activated.includes(userId), true, "deletion keeps history");
  assert.equal(app.isCheckpointLevelVisited("level_CxA"), true, "deleted custom flag keeps room count");
  assert.equal(app.hasCheckpointSpawnForLevel("level_CxA"), false, "deleted flag is never a spawn");
}

{
  const app = createApp(levelState("level_CxB", {
    playerX: 1,
    primaryX: 0,
    actors: [
      { type: "player", x: 1, y: 0, elevation: 0, removed: false },
      { type: "orange_button", x: 1, y: 0, elevation: 0, removed: false }
    ]
  }));
  assert.equal(
    app.canPlaceUserCheckpointFlag().reason,
    "actor-conflict",
    "any non-gem actor sharing the flag volume blocks placement"
  );
}

{
  const app = createApp(levelState("level_DxA", {
    checkpoints: [checkpoint("primary", 0), checkpoint("secondary", 2)],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "box", x: 3, y: 0, elevation: 0, removed: false }
    ]
  }));
  const player = app.state.actors[0];
  player.x = 2;
  app.touchCheckpointsAtPlayer({ reason: "test" });
  assert.equal(app.selectedCheckpointForLevel().kind, "secondary");
  assert.equal(app.selectNextCheckpointForLevel().kind, "primary");
  assert.equal(app.selectNextCheckpointForLevel().kind, "secondary");

  player.x = 4;
  app.state.actors[1].x = 4;
  checkpointEvents.length = 0;
  assert.equal(app.cycleCheckpointAndReset(), true);
  assert.equal(app.selectedCheckpointForLevel().kind, "primary");
  assert.equal(player.x, 0);
  app.undoMove();
  assert.equal(app.selectedCheckpointForLevel().kind, "secondary", "undo restores flag selection");
  assert.equal(player.x, 4, "undo restores the pre-cycle player position");
  assert.equal(app.state.actors[1].x, 4, "undo restores the pre-cycle room state");
  assert.equal(checkpointEvents.at(-1).reason, "undo");

  app.resetPositions();
  assert.equal(player.x, 2, "R resets the player at the selected checkpoint");
  assert.equal(app.state.actors[1].x, 3, "R restores the pristine room state");
}

{
  const app = createApp(levelState("level_ExA"));
  app.importCheckpointProgress({}, {
    legacyVisitedLevelIds: ["level_ZxZ"],
    save: false
  });
  assert.equal(app.isCheckpointLevelVisited("level_ZxZ"), true);
  assert.equal(app.hasCheckpointSpawnForLevel("level_ZxZ"), true, "legacy rooms are provisional spawns");
  app.registerAuthoredCheckpoints(levelState("level_ZxZ", { primaryX: 3 }));
  assert.equal(app.hasCheckpointSpawnForLevel("level_ZxZ"), true, "legacy migration is lazy");
  assert.equal(
    app.exportCheckpointProgress().activated.includes("level_ZxZ:checkpoint:primary"),
    true
  );
}

{
  const app = createApp(levelState("level_GxA"));
  app.importCheckpointProgress({
    version: 1,
    activated: ["level_YxY:checkpoint:secondary:4:5:0"],
    custom: [],
    selected: [],
    resume: null
  }, { save: false });
  assert.equal(
    app.hasCheckpointSpawnForLevel("level_YxY"),
    true,
    "imported authored ids stay teleportable before room metadata is loaded"
  );
  app.registerAuthoredCheckpoints(levelState("level_YxY", { primaryX: 3 }));
  assert.equal(
    app.hasCheckpointSpawnForLevel("level_YxY"),
    false,
    "a stale imported secondary id stops being spawnable after authoritative metadata loads"
  );
}

{
  const savedLevel = levelState("level_FxA", {
    checkpoints: [checkpoint("primary", 0), checkpoint("secondary", 3)]
  });
  const secondaryId = "level_FxA:checkpoint:secondary:3:0:0";
  savedLevel.checkpointProgress = {
    version: 1,
    activated: ["level_FxA:checkpoint:primary", secondaryId],
    custom: [],
    selected: [{ levelId: "level_FxA", checkpointId: secondaryId }],
    resume: { levelId: "level_FxA", checkpointId: secondaryId }
  };
  const app = createApp(savedLevel);
  assert.equal(
    app.state.actors.find((actor) => actor.type === "player").x,
    3,
    "boot restores the selected checkpoint before initial contact can overwrite it"
  );
}

{
  const staleSecondaryId = "level_HxA:checkpoint:secondary:3:0:0";
  const savedLevel = levelState("level_HxA", { primaryX: 0 });
  savedLevel.checkpointProgress = {
    version: 1,
    activated: [staleSecondaryId],
    custom: [],
    selected: [{ levelId: "level_HxA", checkpointId: staleSecondaryId }],
    resume: { levelId: "level_HxA", checkpointId: staleSecondaryId }
  };
  const app = createApp(savedLevel);
  const player = app.state.actors.find((actor) => actor.type === "player");
  assert.equal(player.removed, true, "an invalid persisted resume never leaves play at the raw primary");
  assert.equal(app.checkpointResumeBlocked, true);
  assert.equal(app.hasCheckpointSpawnForLevel("level_HxA"), false);
  assert.equal(
    app.exportCheckpointProgress().activated.includes("level_HxA:checkpoint:primary"),
    false,
    "boot must not convert a stale selected flag into a newly activated primary"
  );
}

{
  const primaryId = "level_IxA:checkpoint:primary";
  const staleSecondaryId = "level_IxA:checkpoint:secondary:3:0:0";
  const savedLevel = levelState("level_IxA", { primaryX: 0 });
  savedLevel.checkpointProgress = {
    version: 1,
    activated: [primaryId, staleSecondaryId],
    custom: [],
    selected: [{ levelId: "level_IxA", checkpointId: staleSecondaryId }],
    resume: { levelId: "level_IxA", checkpointId: staleSecondaryId }
  };
  const app = createApp(savedLevel);
  const player = app.state.actors.find((actor) => actor.type === "player");
  assert.equal(player.removed, false);
  assert.equal(player.x, 0, "boot safely falls back only to an already activated extant flag");
  assert.deepEqual(app.exportCheckpointProgress().resume, {
    levelId: "level_IxA",
    checkpointId: primaryId
  });
}

for (const invalidCustom of [
  {
    name: "off-board",
    checkpoint: { levelId: "level_JxA", x: 63, y: 63, elevation: 63 }
  },
  {
    name: "unsupported",
    checkpoint: { levelId: "level_JxA", x: 1, y: 0, elevation: 1 }
  },
  {
    name: "occupied",
    checkpoint: { levelId: "level_JxA", x: 1, y: 0, elevation: 0 },
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "box", x: 1, y: 0, elevation: 0, removed: false }
    ]
  }
]) {
  const checkpointId = [
    invalidCustom.checkpoint.levelId,
    "checkpoint",
    "user",
    invalidCustom.checkpoint.x,
    invalidCustom.checkpoint.y,
    invalidCustom.checkpoint.elevation
  ].join(":");
  const savedLevel = levelState("level_JxA", {
    actors: invalidCustom.actors,
    primaryX: 0
  });
  savedLevel.checkpointProgress = {
    version: 1,
    activated: [checkpointId],
    custom: [invalidCustom.checkpoint],
    selected: [{ levelId: "level_JxA", checkpointId }],
    resume: { levelId: "level_JxA", checkpointId }
  };
  const app = createApp(savedLevel);
  assert.equal(
    app.state.actors.find((actor) => actor.type === "player").removed,
    true,
    `${invalidCustom.name} custom resumes are blocked`
  );
  assert.equal(app.hasCheckpointSpawnForLevel("level_JxA"), false);
}

{
  const staleRemoteId = "level_LxA:checkpoint:secondary:3:0:0";
  const savedLevel = levelState("level_KxA", { primaryX: 0 });
  savedLevel.checkpointProgress = {
    version: 1,
    activated: [staleRemoteId],
    custom: [],
    selected: [{ levelId: "level_LxA", checkpointId: staleRemoteId }],
    resume: { levelId: "level_LxA", checkpointId: staleRemoteId }
  };
  const app = createApp(savedLevel);
  assert.equal(
    app.state.actors.find((actor) => actor.type === "player").removed,
    true,
    "a pending cross-room resume never exposes the route room's raw primary"
  );
  assert.equal(
    app.exportCheckpointProgress().activated.includes("level_KxA:checkpoint:primary"),
    false
  );
}

console.log("play-checkpoints: activation, persistence, reset, custom flags, and migration passed.");
