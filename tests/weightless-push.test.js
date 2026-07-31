const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { loadBrowserScript } = require("./helpers/browser-module-loader");

global.performance = performance;
global.window = {
  PlayModules: {},
  requestAnimationFrame(callback) {
    callback(performance.now() + 1000);
    return 1;
  },
  cancelAnimationFrame: () => {}
};
loadBrowserScript("public/play-rules.js");
loadBrowserScript("public/maze-engine.js");
loadBrowserScript("public/play-movement.js");
loadBrowserScript("public/play-world-transitions.js");
loadBrowserScript("public/play-gameplay.js");

const { registerGameplayFunctions } = window.PlayModules;
const asyncTests = [];

function posKey(x, y) {
  return `${x},${y}`;
}

function createTerrain(width, height, type = "floor") {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ type }))
  );
}

async function flushAsyncTurns(count = 8) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function iceBlockCell(elevation = 0) {
  return {
    type: "ice_block",
    layers: [{ type: "ice_block", elevation }]
  };
}

function blockAssetCell(elevation = 0) {
  return {
    type: "block_asset",
    layers: [{ type: "block_asset", elevation }]
  };
}

function iceSlopeCell(direction = "right", elevation = 0) {
  return {
    type: "ice_slope",
    layers: [{ type: "ice_slope", direction, elevation }]
  };
}

function iceWallCell() {
  return {
    type: "wall",
    layers: [
      { type: "ice", elevation: 0 },
      { type: "wall", elevation: 0 }
    ]
  };
}

function stackedWall(height) {
  return {
    type: "wall",
    layers: Array.from({ length: height }, (_, elevation) => ({
      type: "wall",
      elevation
    }))
  };
}

function createGameplayApp(actors, options = {}) {
  const defaultTerrain = Array.from({ length: options.height || 8 }, () =>
    Array.from({ length: options.width || 8 }, () => ({ type: "floor" }))
  );
  const app = {
    currentGameId: "maze",
    currentLevelId: options.currentLevelId || "level_AxA",
    currentLevelLabel: options.currentLevelLabel || "level_AxA",
    worldColumns: options.worldColumns || Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    worldRows: options.worldRows || Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    state: {
      width: options.width || 8,
      height: options.height || 8,
      terrain: options.terrain || defaultTerrain,
      actors
    },
    moveHistory: [],
    MOVE_DURATION_MS: options.moveDurationMs ?? 0,
    PLAYER_LIFT_RISE_DURATION_MS: options.playerLiftRiseDurationMs ?? 0,
    PLAYER_LIFT_FALL_DURATION_MS: options.playerLiftFallDurationMs ?? 0,
    HOLE_FALL_DURATION_MS: options.holeFallDurationMs ?? 0,
    PLAYER_REVIVE_BLINK_DURATION_MS: 0,
    HOLE_SINK_DISTANCE: 0,
    cameraX: 0,
    cameraY: 0,
    TILE_SIZE: 64,
    viewportRect: { width: 512, height: 512 },
    isAnimating: false,
    isTransitioningLevel: false,
    queuedAction: null,
    animationFrameId: null,
    liveRaisedPlayerGates: new Set(),
    liveRaisedOrangeWalls: new Set(),
    posKey,
    cloneActorPositions() {
      return app.state.actors.map((actor) => ({
        x: actor.x,
        y: actor.y,
        removed: Boolean(actor.removed),
        elevation: actor.elevation ?? 0
      }));
    },
    cloneTerrainState(terrain = app.state.terrain) {
      return terrain.map((row) => row.map((cell) => ({ ...cell })));
    },
    restoreTerrainState(terrain) {
      app.state.terrain = app.cloneTerrainState(terrain);
    },
    restoreActorPositions(positions) {
      app.state.actors.forEach((actor, index) => {
        const position = positions[index];

        if (!position) {
          return;
        }

        actor.x = position.x;
        actor.y = position.y;
        actor.removed = Boolean(position.removed);
        actor.elevation = position.elevation ?? 0;
      });
    },
    buildOccupiedSet(excludedActor = null) {
      const occupied = new Set(
        app.state.actors
          .filter((actor) => actor !== excludedActor && !actor.removed && !app.isCollectibleActor(actor))
          .map((actor) => posKey(actor.x, actor.y))
      );

      return occupied;
    },
    actorsAt(x, y, predicate = null) {
      return app.state.actors.filter(
        (actor) =>
          !actor.removed &&
          actor.x === x &&
          actor.y === y &&
          (typeof predicate !== "function" || predicate(actor))
      );
    },
    actorAt(x, y, predicate = null) {
      return (
        app.state.actors.find(
          (actor) =>
            !actor.removed &&
            actor.x === x &&
            actor.y === y &&
            (typeof predicate !== "function" || predicate(actor))
        ) || null
      );
    },
    pushEntityKey(actor) {
      return actor.type === "weightless_box" ? `weightless:${actor.groupId}` : actor;
    },
    isPlayerActor(actor) {
      return actor?.type === "player" || actor?.type === "circle_player";
    },
    actorElevation(actor) {
      return actor?.type === "player" || actor?.type === "circle_player" || actor?.type === "weightless_box"
        ? actor?.elevation ?? 0
        : 0;
    },
    isCollectibleActor(actor) {
      return actor?.type === "gem";
    },
    pushWeight(actor) {
      return actor.type === "box" || actor.type === "floating_floor" ? 1 : 0;
    },
    isPushableActor(actor) {
      return actor?.type === "box" || actor?.type === "floating_floor" || actor?.type === "weightless_box";
    },
    pushActorMembers(actor) {
      return actor.type === "weightless_box"
        ? app.state.actors.filter(
            (member) => member.type === "weightless_box" && member.groupId === actor.groupId && !member.removed
          )
        : [actor];
    },
    weightlessGroupMembers(groupId) {
      return app.state.actors.filter(
        (actor) => actor.type === "weightless_box" && actor.groupId === groupId && !actor.removed
      );
    },
    isInsideBoard(x, y) {
      return x >= 0 && x < app.state.width && y >= 0 && y < app.state.height;
    },
    terrainAt(x, y) {
      return app.state.terrain[y]?.[x] || { type: "empty" };
    },
    isWall: () => false,
    terrainSurfaceHeightAt: () => 0,
    playerSurfaceHeightAt: () => 0,
    isPlayerLift: () => false,
    isRaisedPlayerLift: () => false,
    setPlayerLiftRaised: () => {},
    computeRaisedPlayerGateSet: () => new Set(),
    computeRaisedOrangeWallSet: () => new Set(),
    setRaisedOrangeWallState(keys) {
      app.orangeWallRaisedState = new Set(keys || []);
      app.liveRaisedOrangeWalls = new Set(app.orangeWallRaisedState);
    },
    isIce: options.isIce || (() => false),
    isHole: options.isHole || (() => false),
    isIceOrHole: () => false,
    easeOutBack: (value) => value,
    easeInOutQuad: (value) => value,
    syncFloatingFloorTicker: () => {},
    cloneLevelSnapshot() {
      return {
        gameId: app.currentGameId,
        levelId: app.currentLevelId,
        levelLabel: app.currentLevelLabel,
        width: app.state.width,
        height: app.state.height,
        terrain: app.cloneTerrainState(),
        actors: app.state.actors.map((actor) => ({ ...actor }))
      };
    },
    applyLevelState(levelState, applyOptions = {}) {
      if (app.animationFrameId !== null && applyOptions.preserveAnimation !== true) {
        window.cancelAnimationFrame(app.animationFrameId);
        app.animationFrameId = null;
      }

      if (applyOptions.preserveAnimation !== true) {
        app.isAnimating = false;
      }

      app.isTransitioningLevel = false;
      app.levelTransition = null;
      if (typeof options.onApplyLevelState === "function") {
        options.onApplyLevelState(applyOptions);
      }
      app.currentLevelId = levelState.levelId || app.currentLevelId;
      app.currentLevelLabel = levelState.levelLabel || app.currentLevelId;
      app.state.width = levelState.width;
      app.state.height = levelState.height;
      app.state.terrain = app.cloneTerrainState(levelState.terrain || []);
      app.state.actors = (levelState.actors || []).map((actor) => ({
        ...actor,
        renderX: actor.x,
        renderY: actor.y,
        renderElevation: actor.elevation ?? 0,
        renderScale: actor.removed ? 0 : 1,
        renderAlpha: actor.removed ? 0 : 1,
        renderSink: actor.removed ? app.HOLE_SINK_DISTANCE : 0,
        renderInHole: false
      }));

      if (applyOptions.resetLevelEntry) {
        app.initialPositions = app.cloneActorPositions();
        app.initialTerrain = app.cloneTerrainState();
        app.levelEntrySnapshot = app.cloneLevelSnapshot();
      }
    },
    loadLevelState: options.loadLevelState || (async () => ({})),
    captureSceneSnapshot: () => null,
    captureForegroundOccluderSnapshot: () => null,
    captureViewportSnapshot: () => null,
    viewportPositionForActor: (actor) => ({ left: actor.x * 64, top: actor.y * 64 }),
    startLevelTransition(...args) {
      if (typeof options.startLevelTransition === "function") {
        return options.startLevelTransition.call(app, ...args);
      }

      const transitionOptions = args[7] || {};
      app.isTransitioningLevel = false;
      if (typeof transitionOptions.onComplete === "function") {
        transitionOptions.onComplete();
      }
    },
    render: () => {}
  };

  registerGameplayFunctions(app);
  return app;
}

function createUShapeActors(extraActors = []) {
  return [
    { type: "player", x: 2, y: 0, elevation: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 1, y: 1, removed: false },
    { type: "weightless_box", groupId: "M0", x: 1, y: 2, removed: false },
    { type: "weightless_box", groupId: "M0", x: 2, y: 2, removed: false },
    { type: "weightless_box", groupId: "M0", x: 3, y: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 3, y: 1, removed: false },
    { type: "weightless_box", groupId: "M0", x: 3, y: 2, removed: false },
    ...extraActors
  ];
}

{
  const terrain = createTerrain(7, 1);
  terrain[0][0] = stackedWall(1);
  terrain[0][1] = {
    type: "wall",
    layers: [
      { type: "floor", elevation: 0 },
      { type: "orange_wall", elevation: 0 },
      { type: "orange_wall", elevation: 1 },
      { type: "wall", elevation: 2 }
    ]
  };
  terrain[0][2] = {
    type: "wall",
    layers: [
      { type: "floor", elevation: 0 },
      { type: "wall", elevation: 1 }
    ]
  };
  terrain[0][3] = {
    type: "orange_wall",
    layers: [
      { type: "floor", elevation: 0 },
      { type: "orange_wall", elevation: 0 }
    ]
  };
  const actors = [
    { type: "player", x: 1, y: 0, elevation: 1, removed: false },
    { type: "player", x: 4, y: 0, elevation: 0, removed: false },
    { type: "box", x: 5, y: 0, elevation: 0, removed: false },
    { type: "orange_button", x: 4, y: 0, elevation: 0, removed: false }
  ];
  const app = createGameplayApp(actors, { height: 1, terrain, width: 7 });

  app.movePlayers(1, 0);

  assert.deepEqual(
    Array.from(app.liveRaisedOrangeWalls),
    ["3,0"],
    "play rendering keeps the engine's component-scoped orange-wall result"
  );
  assert.deepEqual(
    [actors[0].x, actors[0].elevation],
    [1, 1],
    "the ceiling-blocked player remains supported by the lowered component"
  );

  app.undoMove({ instantRestore: true });
  assert.deepEqual(
    Array.from(app.liveRaisedOrangeWalls),
    [],
    "undo restores the component state from before the button was released"
  );
}

{
  const passThroughGem = { type: "gem", x: 2, y: 0, removed: false };
  const landingGem = { type: "gem", x: 3, y: 0, removed: false };
  const terrain = createTerrain(8, 8);
  terrain[0][1] = { type: "ice" };
  terrain[0][2] = { type: "ice" };
  const actors = [
    { type: "player", x: 0, y: 0, elevation: 0, removed: false },
    passThroughGem,
    landingGem
  ];
  const app = createGameplayApp(actors, {
    terrain
  });

  app.movePlayers(1, 0);

  assert.deepEqual([actors[0].x, actors[0].y], [3, 0]);
  assert.equal(passThroughGem.removed, false);
  assert.equal(landingGem.removed, true);
}

{
  const landingGem = { type: "gem", x: 1, y: 0, removed: false };
  const actors = [
    { type: "player", x: 0, y: 0, elevation: 0, removed: false },
    landingGem
  ];
  const app = createGameplayApp(actors);
  const result = app.tryMovePlayersInstant(1, 0);

  assert.equal(result.moved, true);
  assert.equal(app.moveHistory.length, 0);
  assert.deepEqual([actors[0].x, actors[0].y], [1, 0]);
  assert.equal(landingGem.removed, true);
}

{
  const player = { type: "player", x: 0, y: 0, elevation: 0, removed: false };
  const app = createGameplayApp([player]);
  let finished = false;
  const result = app.movement.performPlayerMove(1, 0, {
    animate: true,
    onFinish: () => {
      finished = true;
    },
    recordHistory: false
  });

  assert.equal(result.moved, true);
  assert.equal(finished, true);
  assert.deepEqual([player.x, player.y], [1, 0]);
}

{
  const player = { type: "player", x: 0, y: 0, elevation: 0, removed: false };
  const terrain = createTerrain(4, 1);
  terrain[0][1] = iceSlopeCell("right", 0);
  terrain[0][2] = stackedWall(1);
  const app = createGameplayApp([player], { height: 1, terrain, width: 4 });

  app.movePlayers(1, 0);

  assert.deepEqual([player.x, player.y], [2, 0]);
  assert.equal(player.elevation, 1);
  const previousState = app.moveHistory.at(-1);
  assert.deepEqual(previousState.iceSlideMoves[0].path, [
    { x: 0, y: 0, elevation: 0 },
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 1 }
  ]);

  const undoMoves = app.buildMovesToPositions(previousState.actors);
  app.movement.applyUndoIceSlideMetadata(undoMoves, previousState);
  const playerUndoMove = undoMoves.find((move) => move.actor === player);

  assert.equal(playerUndoMove.iceSlide, true);
  assert.equal(playerUndoMove.reverseIceSlide, true);
  assert.equal(playerUndoMove.pathControlsElevation, true);
  assert.deepEqual(playerUndoMove.path, [
    { x: 2, y: 0, elevation: 1 },
    { x: 1, y: 0, elevation: 1 },
    { x: 0, y: 0, elevation: 0 }
  ]);
}

{
  const player = { type: "player", x: 0, y: 0, elevation: 0, removed: false };
  const terrain = createTerrain(6, 1);
  terrain[0][1] = iceSlopeCell("right", 0);
  terrain[0][2] = iceSlopeCell("left", 0);
  terrain[0][3] = iceSlopeCell("right", 0);
  terrain[0][4] = iceSlopeCell("left", 0);
  const app = createGameplayApp([player], { height: 1, terrain, width: 6 });

  app.movePlayers(1, 0);

  assert.deepEqual([player.x, player.y], [5, 0]);
  assert.equal(player.elevation, 0);

  const previousState = app.moveHistory.at(-1);
  assert.deepEqual(previousState.iceSlideMoves[0].path, [
    { x: 0, y: 0, elevation: 0 },
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 1 },
    { x: 2.5, y: 0, elevation: 0.08 },
    { x: 3, y: 0, elevation: 1 },
    { x: 4, y: 0, elevation: 1 },
    { x: 5, y: 0, elevation: 0 }
  ]);
}

{
  const player = { type: "player", x: 1, y: 0, elevation: 0, removed: false };
  const terrain = createTerrain(16, 1, "ice");
  terrain[0][15] = iceWallCell();
  const app = createGameplayApp([player], {
    currentLevelId: "level_IxG",
    height: 1,
    terrain,
    width: 16,
    worldColumns: Array.from("ABCDEFGHIJKLMNOP"),
    worldRows: Array.from("ABCDEFGHIJKLMNOP")
  });
  const performCalls = [];
  const originalPerformPlayerMove = app.movement.performPlayerMove;

  app.movement.performPlayerMove = function trackedPerformPlayerMove(dx, dy, options = {}) {
    performCalls.push({
      animate: options.animate,
      dx,
      dy,
      recordHistory: options.recordHistory
    });
    return originalPerformPlayerMove.apply(this, arguments);
  };

  app.movePlayers(1, 0);

  assert.deepEqual([player.x, player.y], [14, 0]);
  assert.equal(performCalls.length, 1);
  assert.deepEqual(performCalls[0], {
    animate: true,
    dx: 1,
    dy: 0,
    recordHistory: true
  });
}

{
  const gem = { type: "gem", x: 1, y: 0, removed: false };
  const player = { type: "player", x: 0, y: 0, elevation: 0, removed: false };
  const terrain = createTerrain(8, 8);
  terrain[0][1] = { type: "hole" };
  const app = createGameplayApp([player, gem], {
    terrain
  });

  app.movePlayers(1, 0);

  assert.deepEqual([player.x, player.y], [1, 0]);
  assert.equal(player.removed, true);
  assert.equal(gem.removed, false);
}

{
  const box = { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false };
  const app = createGameplayApp([box], { height: 1, width: 4 });
  const renderElevations = [];

  app.render = () => {
    renderElevations.push(box.renderElevation);
  };

  app.animateMoves([
    {
      actor: box,
      actorIndex: 0,
      actorType: "weightless_box",
      fromElevation: 0,
      fromRemoved: false,
      fromX: 1,
      fromY: 0,
      iceSlide: true,
      path: [
        { x: 1, y: 0, elevation: 0 },
        { x: 2, y: 0, elevation: 1 },
        { x: 3, y: 0, elevation: 1 }
      ],
      pathControlsElevation: true,
      toElevation: 0,
      toRemoved: true,
      toX: 3,
      toY: 0
    }
  ]);

  assert.deepEqual(renderElevations, [1, 1, 0]);
}

{
  const box = { type: "box", x: 0, y: 0, elevation: 0, removed: false };
  const app = createGameplayApp([box], { height: 1, moveDurationMs: 100, width: 5 });
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const renderSamples = [];

  window.requestAnimationFrame = (callback) => {
    const elapsedMs = renderSamples.length === 0 ? 60 : 1000;

    callback(performance.now() + elapsedMs);
    return 1;
  };

  app.render = () => {
    renderSamples.push({
      elevation: box.renderElevation,
      x: box.renderX
    });
  };

  app.animateMoves([
    {
      actor: box,
      actorIndex: 0,
      actorType: "box",
      fromElevation: 0,
      fromX: 0,
      fromY: 0,
      iceSlide: true,
      path: [
        { x: 0, y: 0, elevation: 0 },
        { x: 1, y: 0, elevation: 1 },
        { x: 2, y: 0, elevation: 1 }
      ],
      pathControlsElevation: true,
      pathEndElevation: 1,
      punchSlide: true,
      punchStartElevation: 1,
      punchStartIceSlide: true,
      punchStartX: 2,
      punchStartY: 0,
      toElevation: 1,
      toX: 4,
      toY: 0
    }
  ]);

  window.requestAnimationFrame = originalRequestAnimationFrame;

  assert.ok(renderSamples[0].x > 0 && renderSamples[0].x < 2);
  assert.ok(renderSamples[0].elevation > 0 && renderSamples[0].elevation < 1);
}

{
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const queuedFrames = [];
  const distance = 4;
  const slideDuration = Math.max(100, (distance * 1.5 * 100) / 2.67);
  const box = { type: "box", x: 0, y: 0, elevation: 0, removed: false };
  const app = createGameplayApp([box], { height: 1, moveDurationMs: 100, width: 6 });
  const renderSamples = [];

  window.requestAnimationFrame = (callback) => {
    queuedFrames.push(callback);
    return queuedFrames.length;
  };
  app.replayAnimationFrameStepMs = slideDuration / 4;
  app.render = () => {
    renderSamples.push(box.renderX);
  };

  try {
    app.animateMoves([
      {
        actor: box,
        actorIndex: 0,
        actorType: "box",
        fromElevation: 0,
        fromX: 0,
        fromY: 0,
        iceSlide: true,
        toElevation: 0,
        toX: distance,
        toY: 0
      }
    ]);

    queuedFrames.shift()(performance.now());
  } finally {
    window.requestAnimationFrame = originalRequestAnimationFrame;
  }

  assert.ok(Math.abs(renderSamples[0] - 1) < 0.0001);
}

{
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const queuedFrames = [];
  const distance = 4;
  const slideDuration = Math.max(100, (distance * 1.5 * 100) / 2.67);
  const punchWindupDuration = 100;
  const box = { type: "box", x: 0, y: 0, elevation: 0, removed: false };
  const app = createGameplayApp([box], { height: 1, moveDurationMs: 100, width: 6 });
  const renderSamples = [];

  window.requestAnimationFrame = (callback) => {
    queuedFrames.push(callback);
    return queuedFrames.length;
  };
  app.replayAnimationFrameStepMs = punchWindupDuration + slideDuration / 4;
  app.render = () => {
    renderSamples.push(box.renderX);
  };

  try {
    app.animateMoves([
      {
        actor: box,
        actorIndex: 0,
        actorType: "box",
        fromElevation: 0,
        fromX: 0,
        fromY: 0,
        punchSlide: true,
        punchStartElevation: 0,
        punchStartX: 0,
        punchStartY: 0,
        toElevation: 0,
        toX: distance,
        toY: 0
      }
    ]);

    queuedFrames.shift()(performance.now());
  } finally {
    window.requestAnimationFrame = originalRequestAnimationFrame;
  }

  assert.ok(Math.abs(renderSamples[0] - 1) < 0.0001);
}

{
  const player = { type: "player", x: 0, y: 0, elevation: 1, removed: false };
  const box = { type: "box", x: 1, y: 0, elevation: 1, removed: false };
  const terrain = [[
    iceBlockCell(0),
    iceBlockCell(0),
    iceBlockCell(0),
    iceSlopeCell("right", 1),
    iceBlockCell(1)
  ]];
  const app = createGameplayApp([player, box], {
    height: 1,
    moveDurationMs: 100,
    terrain,
    width: 5
  });
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const renderSamples = [];
  let frame = 0;

  window.requestAnimationFrame = (callback) => {
    frame += 1;
    callback(performance.now() + frame * 60);
    return frame;
  };

  app.render = () => {
    renderSamples.push({
      elevation: box.renderElevation,
      x: box.renderX
    });
  };

  app.movePlayers(1, 0);
  window.requestAnimationFrame = originalRequestAnimationFrame;

  assert.deepEqual([box.x, box.y], [4, 0]);
  assert.equal(box.elevation, 2);
  assert.ok(renderSamples.some((sample) => sample.x > 1 && sample.x < 2.9));
  assert.ok(
    renderSamples.some(
      (sample) => sample.x > 2 && sample.x < 3.2 && sample.elevation > 1 && sample.elevation < 2
    )
  );
}

{
  const player = { type: "player", x: 0, y: 0, elevation: 1, removed: false };
  const box = { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false };
  const terrain = [[
    iceBlockCell(0),
    iceBlockCell(0),
    iceBlockCell(0),
    iceSlopeCell("right", 1),
    iceBlockCell(1)
  ]];
  const app = createGameplayApp([player, box], {
    height: 1,
    moveDurationMs: 100,
    terrain,
    width: 5
  });
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const renderSamples = [];
  let frame = 0;

  window.requestAnimationFrame = (callback) => {
    frame += 1;
    callback(performance.now() + frame * 60);
    return frame;
  };

  app.render = () => {
    renderSamples.push({
      elevation: box.renderElevation,
      x: box.renderX
    });
  };

  app.movePlayers(1, 0);
  window.requestAnimationFrame = originalRequestAnimationFrame;

  assert.deepEqual([box.x, box.y], [4, 0]);
  assert.equal(box.elevation, 2);
  assert.ok(renderSamples.some((sample) => sample.x > 1 && sample.x < 2.9));
  assert.ok(
    renderSamples.some(
      (sample) => sample.x > 2 && sample.x < 3.2 && sample.elevation > 1 && sample.elevation < 2
    )
  );
}

{
  const player = { type: "player", x: 0, y: 0, elevation: 1, removed: false };
  const box = { type: "box", x: 1, y: 0, elevation: 1, removed: false };
  const terrain = [[
    iceBlockCell(0),
    iceBlockCell(0),
    iceBlockCell(0),
    iceSlopeCell("right", 1),
    iceBlockCell(1)
  ]];
  const app = createGameplayApp([player, box], {
    height: 1,
    moveDurationMs: 100,
    terrain,
    width: 5
  });
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const renderSamples = [];
  let frame = 0;

  window.requestAnimationFrame = (callback) => {
    frame += 1;
    callback(performance.now() + (frame === 1 ? 260 : 1000));
    return frame;
  };

  app.render = () => {
    renderSamples.push({
      elevation: box.renderElevation,
      x: box.renderX
    });
  };

  app.movePlayers(1, 0);
  window.requestAnimationFrame = originalRequestAnimationFrame;

  assert.ok(renderSamples[0].x > 1 && renderSamples[0].x < 4);
  assert.ok(renderSamples[0].x < 2);
  assert.ok(renderSamples[0].elevation >= 1 && renderSamples[0].elevation < 2);
}

{
  const player = { type: "player", x: 0, y: 0, elevation: 1, removed: false };
  const box = { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false };
  const terrain = [[
    iceBlockCell(0),
    iceBlockCell(0),
    iceBlockCell(0),
    iceSlopeCell("right", 1),
    iceBlockCell(1)
  ]];
  const app = createGameplayApp([player, box], {
    height: 1,
    moveDurationMs: 100,
    terrain,
    width: 5
  });
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const renderSamples = [];
  let frame = 0;

  window.requestAnimationFrame = (callback) => {
    frame += 1;
    callback(performance.now() + (frame === 1 ? 260 : 1000));
    return frame;
  };

  app.render = () => {
    renderSamples.push({
      elevation: box.renderElevation,
      x: box.renderX
    });
  };

  app.movePlayers(1, 0);
  window.requestAnimationFrame = originalRequestAnimationFrame;

  assert.ok(renderSamples[0].x > 1 && renderSamples[0].x < 2);
  assert.ok(renderSamples[0].elevation >= 1 && renderSamples[0].elevation < 2);
}

{
  const player = { type: "player", x: 0, y: 0, elevation: 1, removed: false };
  const box = { type: "box", x: 1, y: 0, elevation: 1, removed: false };
  const terrain = [[
    iceBlockCell(0),
    iceBlockCell(0),
    iceSlopeCell("right", 1),
    iceSlopeCell("left", 0),
    { type: "floor" },
    { type: "floor" }
  ]];
  const app = createGameplayApp([player, box], {
    height: 1,
    moveDurationMs: 100,
    terrain,
    width: 6
  });
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const renderSamples = [];
  let frame = 0;

  window.requestAnimationFrame = (callback) => {
    frame += 1;
    callback(performance.now() + frame * 60);
    return frame;
  };

  app.render = () => {
    renderSamples.push({
      elevation: box.renderElevation,
      x: box.renderX
    });
  };

  const result = app.movement.performPlayerMove(1, 0, {
    animate: true,
    recordHistory: false
  });
  window.requestAnimationFrame = originalRequestAnimationFrame;

  const boxMoves = result.moves.filter((move) => move.actor === box && !move.visualOnly);

  assert.equal(boxMoves.length, 1);
  assert.deepEqual([box.x, box.y], [5, 0]);
  assert.equal(box.elevation, 0);
  assert.ok(renderSamples[0].x > 1 && renderSamples[0].x < 2);
  assert.ok(renderSamples[0].elevation >= 1 && renderSamples[0].elevation < 2);
  assert.ok(renderSamples.some((sample) => sample.x > 2.1 && sample.elevation > 1.1));
  assert.ok(renderSamples.some((sample) => sample.x > 3.1 && sample.elevation < 1.9));
}

{
  const player = { type: "player", x: 0, y: 0, elevation: 1, removed: false };
  const box = { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false };
  const terrain = [[
    iceBlockCell(0),
    iceBlockCell(0),
    iceSlopeCell("right", 1),
    iceSlopeCell("left", 0),
    { type: "floor" },
    { type: "floor" }
  ]];
  const app = createGameplayApp([player, box], {
    height: 1,
    moveDurationMs: 100,
    terrain,
    width: 6
  });
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const renderSamples = [];
  let frame = 0;

  window.requestAnimationFrame = (callback) => {
    frame += 1;
    callback(performance.now() + frame * 60);
    return frame;
  };

  app.render = () => {
    renderSamples.push({
      elevation: box.renderElevation,
      x: box.renderX
    });
  };

  const result = app.movement.performPlayerMove(1, 0, {
    animate: true,
    recordHistory: false
  });
  window.requestAnimationFrame = originalRequestAnimationFrame;

  const boxMoves = result.moves.filter((move) => move.actor === box && !move.visualOnly);

  assert.equal(boxMoves.length, 1);
  assert.deepEqual([box.x, box.y], [5, 0]);
  assert.equal(box.elevation, 0);
  assert.ok(renderSamples[0].x > 1 && renderSamples[0].x < 2);
  assert.ok(renderSamples[0].elevation >= 1 && renderSamples[0].elevation < 2);
  assert.ok(renderSamples.some((sample) => sample.x > 2.1 && sample.elevation > 1.1));
  assert.ok(renderSamples.some((sample) => sample.x > 3.1 && sample.elevation < 1.9));
}

{
  const player = { type: "player", x: 0, y: 0, elevation: 0, removed: false };
  const terrain = createTerrain(8, 8);
  terrain[0][1] = { type: "ice" };
  terrain[0][2] = { type: "ice" };
  terrain[0][3] = { type: "hole" };
  const app = createGameplayApp([player], {
    terrain
  });

  app.movePlayers(1, 0);

  assert.deepEqual([player.x, player.y], [3, 0]);
  assert.equal(player.removed, true);
}

{
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  const queuedFrames = [];
  window.requestAnimationFrame = (callback) => {
    queuedFrames.push(callback);
    return queuedFrames.length;
  };
  window.cancelAnimationFrame = () => {};

  const buttonBox = {
    type: "weightless_box",
    groupId: "M0",
    x: 2,
    y: 0,
    elevation: 1,
    renderX: 1,
    renderY: 0,
    renderElevation: 1,
    removed: false
  };
  const orangeWallPassenger = {
    type: "player",
    x: 1,
    y: 0,
    elevation: 1,
    renderX: 1,
    renderY: 0,
    renderElevation: 1,
    removed: false
  };
  const app = createGameplayApp([buttonBox, orangeWallPassenger], {
    moveDurationMs: 1,
    playerLiftFallDurationMs: 1,
    playerLiftRiseDurationMs: 1
  });
  const moves = [
    {
      actor: buttonBox,
      actorIndex: 0,
      actorType: "weightless_box",
      fromX: 1,
      fromY: 0,
      toX: 2,
      toY: 0,
      fromElevation: 1,
      toElevation: 0
    },
    {
      actor: orangeWallPassenger,
      actorIndex: 1,
      actorType: "player",
      fromX: 1,
      fromY: 0,
      toX: 1,
      toY: 0,
      fromElevation: 1,
      toElevation: 0
    }
  ];
  let releasedOrangeWalls = false;

  app.animateMoves(moves, 1, {
    preTerrainLiftMoves: new Set([moves[0]]),
    startLiftPhase: () => {
      releasedOrangeWalls = true;
      assert.equal(buttonBox.elevation, 0);
      assert.equal(buttonBox.renderElevation, 0);
      assert.equal(orangeWallPassenger.elevation, 1);
      assert.equal(orangeWallPassenger.renderElevation, 1);
    }
  });

  while (queuedFrames.length > 0) {
    const callback = queuedFrames.shift();
    callback(performance.now() + 1000);
  }

  assert.equal(releasedOrangeWalls, true);
  assert.equal(buttonBox.elevation, 0);
  assert.equal(orangeWallPassenger.elevation, 0);

  window.requestAnimationFrame = originalRequestAnimationFrame;
  window.cancelAnimationFrame = originalCancelAnimationFrame;
}

asyncTests.push(
  (async () => {
    const entryPlayer = { type: "player", x: 7, y: 2, elevation: 0, removed: false };
    const nextTerrain = Array.from({ length: 8 }, () =>
      Array.from({ length: 8 }, () => ({ type: "floor" }))
    );
    nextTerrain[2][0] = { type: "hole" };

    const app = createGameplayApp([entryPlayer], {
      currentLevelId: "level_AxA",
      loadLevelState: async (levelId) => ({
        levelId,
        levelLabel: levelId,
        width: 8,
        height: 8,
        terrain: nextTerrain,
        actors: [{ type: "player", x: 4, y: 4, elevation: 0, removed: false }]
      })
    });

    const didTransition = await app.transitionToAdjacentLevel({
      player: entryPlayer,
      nextLevelId: "level_BxA",
      dx: 1,
      dy: 0,
      targetX: 0,
      targetY: 2
    });

    const revivedPlayer = app.state.actors.find((actor) => app.isPlayerActor(actor));

    assert.equal(didTransition, true);
    assert.deepEqual([revivedPlayer.x, revivedPlayer.y], [4, 4]);
    assert.equal(revivedPlayer.removed, false);
    assert.equal(revivedPlayer.renderAlpha, 1);
    assert.deepEqual(
      app.initialPositions.map(({ x, y, removed }) => ({ x, y, removed })),
      [{ x: 4, y: 4, removed: false }]
    );
  })()
);

{
  const edgePlayer = { type: "player", x: 7, y: 3, elevation: 0, removed: false };
  const app = createGameplayApp([edgePlayer]);
  const transition = app.edgeTransitionForMove(1, 0);

  assert.equal(transition?.nextLevelId, "level_BxA");
  assert.deepEqual([transition?.targetX, transition?.targetY], [0, 3]);
  assert.equal(transition?.sourceType, "floor");
}

{
  const edgePlayer = { type: "player", x: 7, y: 3, elevation: 1, removed: false };
  const terrain = createTerrain(8, 8);
  terrain[3][7] = { type: "wall" };
  const app = createGameplayApp([edgePlayer], { terrain });
  const transition = app.edgeTransitionForMove(1, 0);

  assert.equal(transition?.nextLevelId, "level_BxA");
  assert.deepEqual([transition?.targetX, transition?.targetY], [0, 3]);
  assert.equal(transition?.sourceType, "wall");
}

{
  const edgePlayer = { type: "player", x: 7, y: 3, elevation: 3, removed: false };
  const terrain = createTerrain(8, 8);
  terrain[3][7] = stackedWall(3);
  const app = createGameplayApp([edgePlayer], { terrain });
  const transition = app.edgeTransitionForMove(1, 0);

  assert.equal(transition?.nextLevelId, "level_BxA");
  assert.deepEqual([transition?.targetX, transition?.targetY], [0, 3]);
  assert.equal(transition?.sourceType, "wall");
  assert.equal(transition?.sourceElevation, 3);
}

asyncTests.push(
  (async () => {
    const width = 16;
    const height = 16;
    const edgePlayer = { type: "player", x: 2, y: 0, elevation: 4, removed: false };
    const terrain = createTerrain(width, height);
    const nextTerrain = createTerrain(width, height);
    terrain[0][2] = blockAssetCell(3);
    nextTerrain[height - 1][2] = blockAssetCell(3);
    const app = createGameplayApp([edgePlayer], {
      currentLevelId: "level_CxI",
      height,
      terrain,
      width,
      loadLevelState: async (levelId) => ({
        levelId,
        levelLabel: levelId,
        width,
        height,
        terrain: nextTerrain,
        actors: []
      })
    });
    const transition = app.edgeTransitionForMove(0, -1);

    assert.equal(transition?.nextLevelId, "level_CxH");
    assert.deepEqual([transition?.targetX, transition?.targetY], [2, height - 1]);
    assert.equal(transition?.sourceType, "block_asset");
    assert.equal(transition?.sourceElevation, 4);

    const didTransition = await app.transitionToAdjacentLevel(transition);
    const incomingPlayer = app.state.actors.find((actor) => app.isPlayerActor(actor));

    assert.equal(didTransition, true);
    assert.equal(app.currentLevelId, "level_CxH");
    assert.deepEqual(
      [incomingPlayer.x, incomingPlayer.y, incomingPlayer.elevation],
      [2, height - 1, 4]
    );
  })()
);

asyncTests.push(
  (async () => {
    const edgePlayer = { type: "player", x: 7, y: 2, elevation: 3, removed: false };
    const nextTerrain = createTerrain(8, 8);
    nextTerrain[2][0] = blockAssetCell(3);
    const app = createGameplayApp([edgePlayer], {
      currentLevelId: "level_AxA",
      loadLevelState: async (levelId) => ({
        levelId,
        levelLabel: levelId,
        width: 8,
        height: 8,
        terrain: nextTerrain,
        actors: []
      })
    });

    const didTransition = await app.transitionToAdjacentLevel({
      player: edgePlayer,
      nextLevelId: "level_BxA",
      sourceType: "punch",
      sourceElevation: 3,
      targetElevation: 3,
      dx: 1,
      dy: 0,
      targetX: 0,
      targetY: 2,
      continuePunchSlide: true
    });

    assert.equal(didTransition, false);
    assert.equal(app.currentLevelId, "level_AxA");
  })()
);

{
  const edgePlayer = { type: "player", x: 7, y: 3, elevation: 0, removed: false };
  const terrain = createTerrain(8, 8);
  terrain[3][7] = { type: "wall" };
  const app = createGameplayApp([edgePlayer], { terrain });

  assert.equal(app.edgeTransitionForMove(1, 0), null);
}

asyncTests.push(
  (async () => {
    const edgePlayer = { type: "player", x: 7, y: 2, elevation: 0, removed: false };
    const nextTerrain = Array.from({ length: 8 }, () =>
      Array.from({ length: 8 }, () => ({ type: "floor" }))
    );
    let loadedLevelId = null;
    const app = createGameplayApp([edgePlayer], {
      currentLevelId: "level_AxA",
      loadLevelState: async (levelId) => {
        loadedLevelId = levelId;
        return {
          levelId,
          levelLabel: levelId,
          width: 8,
          height: 8,
          terrain: nextTerrain,
          actors: []
        };
      }
    });

    app.movePlayers(1, 0);
    await flushAsyncTurns();

    const incomingPlayer = app.state.actors.find((actor) => app.isPlayerActor(actor));

    assert.equal(loadedLevelId, "level_BxA");
    assert.equal(app.currentLevelId, "level_BxA");
    assert.deepEqual([incomingPlayer.x, incomingPlayer.y], [0, 2]);
    assert.equal(app.moveHistory.at(-1)?.kind, "level-transition");
  })()
);

asyncTests.push(
  (async () => {
    const player = { type: "player", x: 0, y: 0, elevation: 0, removed: false };
    const gem = {
      type: "gem",
      collectionId: "level_AxA:gem:1,0,0",
      x: 1,
      y: 0,
      elevation: 0,
      removed: false
    };
    const app = createGameplayApp([player, gem], {
      height: 1,
      width: 3
    });
    app.collectedGemIds = new Set();
    app.applyCollectedGemVisual = (actor) => {
      actor.collected = true;
      actor.removed = true;
      actor.showCollectedGhost = true;
    };
    app.hideCollectedGemVisual = (actor) => {
      actor.collected = true;
      actor.removed = true;
      actor.showCollectedGhost = false;
    };
    app.initialPositions = app.cloneActorPositions();
    app.initialTerrain = app.cloneTerrainState();

    app.movePlayers(1, 0);
    await flushAsyncTurns();
    app.collectedGemIds.add(gem.collectionId);
    gem.collected = true;

    assert.equal(gem.removed, true);
    assert.deepEqual([player.x, player.y], [1, 0]);

    app.resetPositions();
    await flushAsyncTurns();
    assert.equal(gem.removed, true);
    assert.equal(app.collectedGemIds.has(gem.collectionId), true);
    assert.deepEqual([player.x, player.y], [0, 0]);

    app.undoMove();
    assert.equal(gem.removed, true);
    assert.equal(app.collectedGemIds.has(gem.collectionId), true);
    assert.deepEqual([player.x, player.y], [1, 0]);

    app.undoMove({ instantRestore: true });
    assert.equal(gem.removed, true);
    assert.equal(app.collectedGemIds.has(gem.collectionId), true);
    assert.deepEqual([player.x, player.y], [0, 0]);
  })()
);

asyncTests.push(
  (async () => {
    const player = { type: "player", x: 0, y: 0, elevation: 0, removed: false };
    const terrain = createTerrain(4, 1);
    terrain[0][1] = { type: "ice" };
    terrain[0][2] = { type: "ice" };
    terrain[0][3] = { type: "ice" };
    const nextTerrain = createTerrain(4, 1);
    nextTerrain[0][0] = { type: "ice" };
    nextTerrain[0][1] = { type: "ice" };
    let loadedLevelId = null;
    const app = createGameplayApp([player], {
      currentLevelId: "level_AxA",
      height: 1,
      width: 4,
      terrain,
      loadLevelState: async (levelId) => {
        loadedLevelId = levelId;
        return {
          levelId,
          levelLabel: levelId,
          width: 4,
          height: 1,
          terrain: nextTerrain,
          actors: []
        };
      }
    });

    app.movePlayers(1, 0);
    await flushAsyncTurns();

    const incomingPlayer = app.state.actors.find((actor) => app.isPlayerActor(actor));

    assert.equal(loadedLevelId, "level_BxA");
    assert.equal(app.currentLevelId, "level_BxA");
    assert.deepEqual([incomingPlayer.x, incomingPlayer.y], [2, 0]);

    app.undoMove();

    const restoredPlayer = app.state.actors.find((actor) => app.isPlayerActor(actor));

    assert.equal(app.currentLevelId, "level_AxA");
    assert.deepEqual([restoredPlayer.x, restoredPlayer.y], [0, 0]);
  })()
);

asyncTests.push(
  (async () => {
    const player = { type: "player", x: 0, y: 0, elevation: 0, removed: false };
    const terrain = createTerrain(4, 1);
    terrain[0][1] = { type: "ice" };
    terrain[0][2] = { type: "ice" };
    terrain[0][3] = { type: "ice" };
    const nextTerrain = createTerrain(4, 1);
    nextTerrain[0][0] = { type: "ice" };
    nextTerrain[0][1] = { type: "ice" };
    const app = createGameplayApp([player], {
      currentLevelId: "level_AxA",
      height: 1,
      width: 4,
      terrain,
      loadLevelState: async (levelId) => ({
        levelId,
        levelLabel: levelId,
        width: 4,
        height: 1,
        terrain: nextTerrain,
        actors: []
      })
    });

    app.movePlayers(1, 0);
    await flushAsyncTurns();

    const incomingPlayer = app.state.actors.find((actor) => app.isPlayerActor(actor));

    assert.deepEqual([incomingPlayer.x, incomingPlayer.y], [2, 0]);
    assert.deepEqual(
      app.initialPositions.map(({ x, y, elevation }) => ({ x, y, elevation })),
      [{ x: 2, y: 0, elevation: 0 }]
    );

    incomingPlayer.x = 3;
    incomingPlayer.renderX = 3;
    app.resetPositions();

    assert.deepEqual([incomingPlayer.x, incomingPlayer.y], [2, 0]);
  })()
);

asyncTests.push(
  (async () => {
    const player = { type: "player", x: 0, y: 0, elevation: 0, removed: false };
    const box = {
      type: "weightless_box",
      groupId: "M0",
      x: 1,
      y: 0,
      elevation: 0,
      removed: false
    };
    const app = createGameplayApp([player, box], {
      height: 1,
      width: 4
    });
    app.initialPositions = app.cloneActorPositions();
    app.initialTerrain = app.cloneTerrainState();

    app.movePlayers(1, 0);
    await flushAsyncTurns();

    assert.deepEqual([player.x, box.x], [1, 2]);
    assert.equal(app.moveHistory.length, 1);

    app.resetPositions();
    await flushAsyncTurns();

    assert.deepEqual([player.x, box.x], [0, 1]);
    assert.equal(app.moveHistory.length, 2);
    assert.equal(app.moveHistory.at(-1)?.kind, "reset");

    app.undoMove({ instantRestore: true });

    assert.deepEqual([player.x, box.x], [1, 2]);
    assert.equal(app.moveHistory.length, 1);

    app.undoMove({ instantRestore: true });

    assert.deepEqual([player.x, box.x], [0, 1]);
    assert.equal(app.moveHistory.length, 0);
  })()
);

{
  const player = {
    type: "player",
    x: 0,
    y: 0,
    elevation: 0,
    removed: false,
    renderX: 0,
    renderY: 0
  };
  const app = createGameplayApp([player], {
    height: 1,
    moveDurationMs: 100,
    width: 12
  });
  app.initialPositions = app.cloneActorPositions();
  app.initialTerrain = app.cloneTerrainState();
  player.x = 10;
  player.renderX = 10;

  app.resetPositions();

  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const queuedFrames = [];
  window.requestAnimationFrame = (callback) => {
    queuedFrames.push(callback);
    return queuedFrames.length;
  };

  const undoStartedAt = performance.now();
  app.undoMove();
  const undoWindowMs = app.inputActionEndsAtMs - undoStartedAt;

  window.requestAnimationFrame = originalRequestAnimationFrame;
  queuedFrames.shift()?.(performance.now() + 1000);

  assert.ok(
    undoWindowMs >= 90 && undoWindowMs < 200,
    `reset undo should use one move duration, received ${undoWindowMs}ms`
  );
  assert.equal(player.x, 10);
  assert.equal(player.renderX, 10);
}

asyncTests.push(
  (async () => {
    const player = { type: "player", x: 3, y: 0, elevation: 0, removed: false };
    const terrain = createTerrain(4, 1);
    terrain[0][3] = { type: "ice" };
    const nextTerrain = createTerrain(4, 1);
    nextTerrain[0][0] = { type: "ice" };
    let loadedLevelId = null;
    const app = createGameplayApp([player], {
      currentLevelId: "level_AxA",
      height: 1,
      width: 4,
      terrain,
      loadLevelState: async (levelId) => {
        loadedLevelId = levelId;
        return {
          levelId,
          levelLabel: levelId,
          width: 4,
          height: 1,
          terrain: nextTerrain,
          actors: []
        };
      }
    });

    app.movePlayers(1, 0);
    await flushAsyncTurns();

    const incomingPlayer = app.state.actors.find((actor) => app.isPlayerActor(actor));

    assert.equal(loadedLevelId, "level_BxA");
    assert.equal(app.currentLevelId, "level_BxA");
    assert.deepEqual([incomingPlayer.x, incomingPlayer.y], [1, 0]);

    app.undoMove();

    const restoredPlayer = app.state.actors.find((actor) => app.isPlayerActor(actor));

    assert.equal(app.currentLevelId, "level_AxA");
    assert.deepEqual([restoredPlayer.x, restoredPlayer.y], [3, 0]);
  })()
);

asyncTests.push(
  (async () => {
    const player = { type: "player", x: 3, y: 0, elevation: 0, removed: false };
    const terrain = createTerrain(4, 1);
    terrain[0][3] = { type: "ice" };
    const nextTerrain = createTerrain(4, 1);
    nextTerrain[0][0] = { type: "ice" };
    nextTerrain[0][1] = { type: "ice" };
    let transitionData = null;
    const app = createGameplayApp([player], {
      currentLevelId: "level_AxA",
      height: 1,
      width: 4,
      terrain,
      loadLevelState: async (levelId) => ({
        levelId,
        levelLabel: levelId,
        width: 4,
        height: 1,
        terrain: nextTerrain,
        actors: []
      }),
      startLevelTransition(...args) {
        const transitionOptions = args[7] || {};
        transitionData = transitionOptions.transitionData;
        app.levelTransition = {
          transitionData,
          startMs: performance.now(),
          durationMs: transitionOptions.durationMs || app.LEVEL_TRANSITION_DURATION_MS,
          onComplete: transitionOptions.onComplete || null
        };
        app.isTransitioningLevel = true;
      }
    });

    app.movePlayers(1, 0);
    await flushAsyncTurns();

    const incomingPlayer = app.state.actors.find((actor) => app.isPlayerActor(actor));

    assert.equal(app.isTransitioningLevel, true);
    assert.equal(transitionData.followIncomingPlayerDuringContinuation, true);
    assert.notEqual(transitionData.lightweightTransition, true);
    assert.equal(transitionData.steadyCamera, true);
    assert.deepEqual([incomingPlayer.x, incomingPlayer.y], [2, 0]);
  })()
);

asyncTests.push(
  (async () => {
    const player = { type: "player", x: 3, y: 0, elevation: 0, removed: false };
    const terrain = createTerrain(4, 1);
    terrain[0][3] = { type: "ice" };
    const nextTerrain = createTerrain(4, 1);
    nextTerrain[0][0] = { type: "ice" };
    let preserveAnimation = null;
    const app = createGameplayApp([player], {
      currentLevelId: "level_AxA",
      height: 1,
      width: 4,
      terrain,
      loadLevelState: async (levelId) => ({
        levelId,
        levelLabel: levelId,
        width: 4,
        height: 1,
        terrain: nextTerrain,
        actors: []
      }),
      onApplyLevelState: (options) => {
        preserveAnimation = options.preserveAnimation;
      }
    });

    await app.transitionToAdjacentLevel({
      player,
      nextLevelId: "level_BxA",
      dx: 1,
      dy: 0,
      sourceType: "ice",
      targetX: 0,
      targetY: 0,
      followSourcePlayerBeforeContinuation: true
    });

    assert.equal(preserveAnimation, true);
  })()
);

asyncTests.push(
  (async () => {
    const player = { type: "player", x: 3, y: 0, elevation: 0, removed: false };
    const terrain = createTerrain(4, 1);
    terrain[0][3] = { type: "ice" };
    const nextTerrain = createTerrain(4, 1);
    nextTerrain[0][0] = { type: "ice" };
    let transitionStarted = false;
    const app = createGameplayApp([player], {
      currentLevelId: "level_AxA",
      height: 1,
      width: 4,
      terrain,
      loadLevelState: async (levelId) => ({
        levelId,
        levelLabel: levelId,
        width: 4,
        height: 1,
        terrain: nextTerrain,
        actors: []
      }),
      startLevelTransition(...args) {
        transitionStarted = true;
        const transitionOptions = args[7] || {};
        app.levelTransition = {
          transitionData: transitionOptions.transitionData,
          startMs: performance.now(),
          durationMs: transitionOptions.durationMs || app.LEVEL_TRANSITION_DURATION_MS,
          onComplete: transitionOptions.onComplete || null
        };
        app.isTransitioningLevel = true;
      }
    });

    app.isTransitioningLevel = true;
    app.levelTransition = {
      transitionData: { kind: "adjacent-scene" },
      startMs: performance.now(),
      durationMs: 1000
    };

    const didTransition = await app.transitionToAdjacentLevel({
      player,
      nextLevelId: "level_BxA",
      sourceType: "ice",
      dx: 1,
      dy: 0,
      targetX: 0,
      targetY: 0,
      replaceActiveTransition: true
    });

    assert.equal(didTransition, true);
    assert.equal(transitionStarted, true);
    assert.equal(app.currentLevelId, "level_BxA");
  })()
);

{
    const player = { type: "player", x: 0, y: 0, elevation: 0, removed: false };
    const terrain = createTerrain(30, 1);

    for (let x = 0; x < 30; x += 1) {
      terrain[0][x] = { type: "ice" };
    }

    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const frameCallbacks = [];
    let loadStarted = false;
    let transitionRequestedRenderX = null;

    window.requestAnimationFrame = (callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    };

    const app = createGameplayApp([player], {
      currentLevelId: "level_AxA",
      height: 1,
      moveDurationMs: 100,
      width: 30,
      terrain,
      loadLevelState: async () => {
        loadStarted = true;
        return new Promise(() => {});
      }
    });

    const frameStart = performance.now();

    app.movePlayers(1, 0);
    assert.equal(loadStarted, true);
    assert.equal(app.isPlanningWorldAction, true);
    assert.equal(app.isTransitioningLevel, false);

    window.requestAnimationFrame = originalRequestAnimationFrame;
}

asyncTests.push(
  (async () => {
    const player = { type: "player", x: 0, y: 0, elevation: 0, removed: false };
    const terrain = createTerrain(4, 1);
    terrain[0][1] = { type: "ice" };
    terrain[0][2] = { type: "ice" };
    terrain[0][3] = { type: "ice" };
    const nextTerrain = createTerrain(4, 1);
    nextTerrain[0][0] = { type: "ice" };
    nextTerrain[0][1] = iceSlopeCell("right", 0);
    nextTerrain[0][2] = { type: "wall" };
    let loadedLevelId = null;
    const app = createGameplayApp([player], {
      currentLevelId: "level_AxA",
      height: 1,
      width: 4,
      terrain,
      loadLevelState: async (levelId) => {
        loadedLevelId = levelId;
        return {
          levelId,
          levelLabel: levelId,
          width: 4,
          height: 1,
          terrain: nextTerrain,
          actors: []
        };
      }
    });

    app.movePlayers(1, 0);
    await flushAsyncTurns();

    const incomingPlayer = app.state.actors.find((actor) => app.isPlayerActor(actor));

    assert.equal(loadedLevelId, "level_BxA");
    assert.equal(app.currentLevelId, "level_BxA");
    assert.deepEqual([incomingPlayer.x, incomingPlayer.y], [2, 0]);
    assert.equal(incomingPlayer.elevation, 1);

    app.undoMove();

    const restoredPlayer = app.state.actors.find((actor) => app.isPlayerActor(actor));

    assert.equal(app.currentLevelId, "level_AxA");
    assert.deepEqual([restoredPlayer.x, restoredPlayer.y], [0, 0]);
    assert.equal(restoredPlayer.elevation, 0);
  })()
);

asyncTests.push(
  (async () => {
    const player = { type: "player", x: 0, y: 0, elevation: 0, removed: false };
    const terrain = createTerrain(3, 1);
    terrain[0][1] = iceSlopeCell("right", 0);
    terrain[0][2] = iceSlopeCell("left", 0);
    const nextTerrain = createTerrain(4, 1);
    nextTerrain[0][0] = iceSlopeCell("right", 0);
    nextTerrain[0][1] = iceSlopeCell("left", 0);
    let loadedLevelId = null;
    const app = createGameplayApp([player], {
      currentLevelId: "level_AxA",
      height: 1,
      width: 3,
      terrain,
      loadLevelState: async (levelId) => {
        loadedLevelId = levelId;
        return {
          levelId,
          levelLabel: levelId,
          width: 4,
          height: 1,
          terrain: nextTerrain,
          actors: []
        };
      }
    });

    app.movePlayers(1, 0);
    await flushAsyncTurns();

    const incomingPlayer = app.state.actors.find((actor) => app.isPlayerActor(actor));

    assert.equal(loadedLevelId, "level_BxA");
    assert.equal(app.currentLevelId, "level_BxA");
    assert.deepEqual([incomingPlayer.x, incomingPlayer.y], [2, 0]);
    assert.equal(incomingPlayer.elevation, 0);

    app.undoMove();

    const restoredPlayer = app.state.actors.find((actor) => app.isPlayerActor(actor));

    assert.equal(app.currentLevelId, "level_AxA");
    assert.deepEqual([restoredPlayer.x, restoredPlayer.y], [0, 0]);
    assert.equal(restoredPlayer.elevation, 0);
  })()
);

asyncTests.push(
  (async () => {
    const edgePlayer = { type: "player", x: 7, y: 2, elevation: 0, removed: false };
    const nextTerrain = createTerrain(8, 8);
    nextTerrain[2][0] = { type: "wall" };
    const app = createGameplayApp([edgePlayer], {
      currentLevelId: "level_AxA",
      loadLevelState: async (levelId) => ({
        levelId,
        levelLabel: levelId,
        width: 8,
        height: 8,
        terrain: nextTerrain,
        actors: []
      })
    });

    const didTransition = await app.transitionToAdjacentLevel({
      player: edgePlayer,
      nextLevelId: "level_BxA",
      sourceType: "floor",
      dx: 1,
      dy: 0,
      targetX: 0,
      targetY: 2
    });

    assert.equal(didTransition, false);
    assert.equal(app.currentLevelId, "level_AxA");
    assert.equal(app.moveHistory.length, 0);
    assert.equal(app.isTransitioningLevel, false);
  })()
);

asyncTests.push(
  (async () => {
    const edgePlayer = { type: "player", x: 7, y: 2, elevation: 1, removed: false };
    const terrain = createTerrain(8, 8);
    terrain[2][7] = { type: "wall" };
    const nextTerrain = createTerrain(8, 8);
    nextTerrain[2][0] = { type: "wall" };
    const app = createGameplayApp([edgePlayer], {
      currentLevelId: "level_AxA",
      terrain,
      loadLevelState: async (levelId) => ({
        levelId,
        levelLabel: levelId,
        width: 8,
        height: 8,
        terrain: nextTerrain,
        actors: []
      })
    });

    const didTransition = await app.transitionToAdjacentLevel({
      player: edgePlayer,
      nextLevelId: "level_BxA",
      sourceType: "wall",
      dx: 1,
      dy: 0,
      targetX: 0,
      targetY: 2
    });
    const incomingPlayer = app.state.actors.find((actor) => app.isPlayerActor(actor));

    assert.equal(didTransition, true);
    assert.equal(app.currentLevelId, "level_BxA");
    assert.deepEqual([incomingPlayer.x, incomingPlayer.y], [0, 2]);
    assert.equal(incomingPlayer.elevation, 1);
  })()
);

asyncTests.push(
  (async () => {
    const edgePlayer = { type: "player", x: 7, y: 2, elevation: 3, removed: false };
    const terrain = createTerrain(8, 8);
    terrain[2][7] = stackedWall(3);
    const nextTerrain = createTerrain(8, 8);
    nextTerrain[2][0] = stackedWall(3);
    const app = createGameplayApp([edgePlayer], {
      currentLevelId: "level_AxA",
      terrain,
      loadLevelState: async (levelId) => ({
        levelId,
        levelLabel: levelId,
        width: 8,
        height: 8,
        terrain: nextTerrain,
        actors: []
      })
    });

    const didTransition = await app.transitionToAdjacentLevel({
      player: edgePlayer,
      nextLevelId: "level_BxA",
      sourceType: "wall",
      sourceElevation: 3,
      dx: 1,
      dy: 0,
      targetX: 0,
      targetY: 2
    });
    const incomingPlayer = app.state.actors.find((actor) => app.isPlayerActor(actor));

    assert.equal(didTransition, true);
    assert.equal(app.currentLevelId, "level_BxA");
    assert.deepEqual([incomingPlayer.x, incomingPlayer.y], [0, 2]);
    assert.equal(incomingPlayer.elevation, 3);
  })()
);

asyncTests.push(
  (async () => {
    const edgePlayer = { type: "player", x: 7, y: 2, elevation: 3, removed: false };
    const terrain = createTerrain(8, 8);
    terrain[2][7] = stackedWall(3);
    const nextTerrain = createTerrain(8, 8);
    nextTerrain[2][0] = stackedWall(2);
    const app = createGameplayApp([edgePlayer], {
      currentLevelId: "level_AxA",
      terrain,
      loadLevelState: async (levelId) => ({
        levelId,
        levelLabel: levelId,
        width: 8,
        height: 8,
        terrain: nextTerrain,
        actors: []
      })
    });

    const didTransition = await app.transitionToAdjacentLevel({
      player: edgePlayer,
      nextLevelId: "level_BxA",
      sourceType: "wall",
      sourceElevation: 3,
      dx: 1,
      dy: 0,
      targetX: 0,
      targetY: 2
    });

    assert.equal(didTransition, false);
    assert.equal(app.currentLevelId, "level_AxA");
    assert.equal(app.moveHistory.length, 0);
    assert.equal(app.isTransitioningLevel, false);
  })()
);

asyncTests.push(
  (async () => {
    const edgePlayer = { type: "player", x: 7, y: 2, elevation: 1, removed: false };
    const terrain = createTerrain(8, 8);
    terrain[2][7] = { type: "wall" };
    const nextTerrain = createTerrain(8, 8);
    const app = createGameplayApp([edgePlayer], {
      currentLevelId: "level_AxA",
      terrain,
      loadLevelState: async (levelId) => ({
        levelId,
        levelLabel: levelId,
        width: 8,
        height: 8,
        terrain: nextTerrain,
        actors: []
      })
    });

    const didTransition = await app.transitionToAdjacentLevel({
      player: edgePlayer,
      nextLevelId: "level_BxA",
      sourceType: "wall",
      dx: 1,
      dy: 0,
      targetX: 0,
      targetY: 2
    });

    assert.equal(didTransition, false);
    assert.equal(app.currentLevelId, "level_AxA");
    assert.equal(app.moveHistory.length, 0);
    assert.equal(app.isTransitioningLevel, false);
  })()
);

{
  const app = createGameplayApp(createUShapeActors());
  const result = app.tryMovePlayersInstant(-1, 0);

  assert.equal(result.moved, true);
  assert.equal(result.moves.filter((move) => move.actor.type === "weightless_box").length, 7);
  assert.deepEqual([app.state.actors[0].x, app.state.actors[0].y], [1, 0]);
  assert.deepEqual(
    app.state.actors
      .filter((actor) => actor.type === "weightless_box")
      .map((actor) => [actor.x, actor.y])
      .sort((left, right) => left[0] - right[0] || left[1] - right[1]),
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 2],
      [2, 0],
      [2, 1],
      [2, 2]
    ]
  );
}

{
  const blocker = { type: "circle_player", x: 0, y: 0, elevation: 0, removed: false };
  const app = createGameplayApp(createUShapeActors([blocker]));
  const result = app.tryMovePlayersInstant(-1, 0);

  // Edge-fall rule (2026-07): in single-room play the circle player at the
  // left boundary, standing on exposed floor, walks off the world and is
  // removed — it no longer bumps an invisible rail. It still occupies its
  // cell for the duration of the move, so the U-shape push stays blocked and
  // the main player does not advance.
  assert.equal(result.moved, true);
  const blockerMove = result.moves.find((move) => move.actor.type === "circle_player");
  assert.equal(blockerMove.edgeFall, true);
  assert.equal(blockerMove.toRemoved, true);
  assert.equal(
    app.state.actors.find((actor) => actor.type === "circle_player").removed,
    true
  );
  assert.deepEqual([app.state.actors[0].x, app.state.actors[0].y], [2, 0]);
  assert.equal(
    result.moves.some((move) => move.actor.type === "weightless_box"),
    false
  );
}

{
  const actors = [
    { type: "player", x: 4, y: 0, elevation: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 3, y: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 3, y: 1, removed: false },
    { type: "weightless_box", groupId: "M1", x: 2, y: 0, removed: false },
    { type: "weightless_box", groupId: "M1", x: 4, y: 1, removed: false }
  ];
  const app = createGameplayApp(actors);
  const player = actors[0];
  const result = app.tryMovePlayersInstant(-1, 0);

  assert.equal(result.moved, true);
  assert.equal(result.moves.filter((move) => move.actor.type === "weightless_box").length, 4);
  assert.deepEqual([player.x, player.y], [3, 0]);
  assert.deepEqual(
    actors
      .filter((actor) => actor.type === "weightless_box")
      .map((actor) => [actor.groupId, actor.x, actor.y])
      .sort((left, right) => left[0].localeCompare(right[0]) || left[1] - right[1] || left[2] - right[2]),
    [
      ["M0", 2, 0],
      ["M0", 2, 1],
      ["M1", 1, 0],
      ["M1", 3, 1]
    ]
  );
}

{
  const terrain = createTerrain(4, 1);
  terrain[0][0] = { type: "wall" };
  terrain[0][1] = { type: "wall" };
  const upperBox = { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false };
  const lowerBox = { type: "weightless_box", groupId: "M1", x: 2, y: 0, elevation: 0, removed: false };
  const actors = [
    { type: "player", x: 0, y: 0, elevation: 1, removed: false },
    upperBox,
    lowerBox
  ];
  const app = createGameplayApp(actors, {
    height: 1,
    terrain,
    width: 4
  });
  const result = app.tryMovePlayersInstant(1, 0);
  const upperBoxMove = result.moves.find((move) => move.actor === upperBox);

  assert.equal(result.moved, true);
  assert.deepEqual([upperBox.x, upperBox.y], [2, 0]);
  assert.equal(upperBox.elevation, 1);
  assert.deepEqual([lowerBox.x, lowerBox.y], [2, 0]);
  assert.equal(lowerBox.elevation, 0);
  assert.equal(upperBoxMove.fromElevation, 1);
  assert.equal(upperBoxMove.toElevation, 1);
}

{
  const bottomBox = { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false };
  const topBox = { type: "weightless_box", groupId: "M1", x: 1, y: 0, elevation: 1, removed: false };
  const actors = [
    { type: "player", x: 0, y: 0, elevation: 0, removed: false },
    bottomBox,
    topBox
  ];
  const app = createGameplayApp(actors, {
    height: 1,
    width: 4
  });
  const result = app.tryMovePlayersInstant(1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([actors[0].x, actors[0].y], [1, 0]);
  assert.deepEqual([bottomBox.x, bottomBox.y], [2, 0]);
  assert.equal(bottomBox.elevation, 0);
  assert.deepEqual([topBox.x, topBox.y], [1, 0]);
  assert.equal(topBox.elevation, 1);
  assert.equal(result.moves.some((move) => move.actor === topBox), false);
}

{
  const app = createGameplayApp([], {
    worldColumns: Array.from("ABCDEFGHIJKLMNOP"),
    worldRows: Array.from("ABCDEFGHIJKLMNOP")
  });

  // World edges do not wrap (the torus wrap was removed in c74950a): stepping
  // off the map returns null, and in-range neighbors resolve normally.
  assert.equal(app.adjacentWorldLevelId("level_AxA", -1, 0), null);
  assert.equal(app.adjacentWorldLevelId("level_AxA", 0, -1), null);
  assert.equal(app.adjacentWorldLevelId("level_PxP", 1, 0), null);
  assert.equal(app.adjacentWorldLevelId("level_PxP", 0, 1), null);
  assert.equal(app.adjacentWorldLevelId("level_AxA", 1, 0), "level_BxA");
  assert.equal(app.adjacentWorldLevelId("level_PxP", -1, 0), "level_OxP");
  assert.equal(app.adjacentWorldLevelId("level_AxA", 0, 1), "level_AxB");
}

asyncTests.push((async () => {
  const nextTerrain = createTerrain(4, 1);
  nextTerrain[0][3] = { type: "wall" };
  const player = { type: "player", x: 0, y: 0, elevation: 0, removed: false };
  const puncher = { type: "puncher", direction: "right", x: 1, y: 0, elevation: 0, removed: false };
  const app = createGameplayApp([player, puncher], {
    currentLevelId: "level_AxA",
    height: 1,
    loadLevelState: async (levelId) => ({
      gameId: "maze",
      levelId,
      levelLabel: levelId,
      width: 4,
      height: 1,
      terrain: nextTerrain,
      actors: [{ type: "player", x: 0, y: 0, elevation: 0, removed: false }]
    }),
    moveDurationMs: 0,
    width: 4
  });

  app.movePlayers(1, 0);
  await flushAsyncTurns();

  assert.equal(app.currentLevelId, "level_BxA");
  assert.deepEqual(
    app.state.actors
      .filter((actor) => app.isPlayerActor(actor) && !actor.removed)
      .map((actor) => [actor.x, actor.y, actor.elevation]),
    [[2, 0, 0]]
  );
})());

asyncTests.push((async () => {
  const terrain = createTerrain(4, 1);
  terrain[0][0] = stackedWall(2);
  terrain[0][1] = stackedWall(2);
  const middleTerrain = createTerrain(4, 1);
  const stopTerrain = createTerrain(4, 1);
  stopTerrain[0][0] = stackedWall(2);
  stopTerrain[0][1] = stackedWall(2);
  stopTerrain[0][2] = stackedWall(3);
  const player = { type: "player", x: 0, y: 0, elevation: 2, removed: false };
  const puncher = { type: "puncher", direction: "right", x: 1, y: 0, elevation: 2, removed: false };
  const app = createGameplayApp([player, puncher], {
    currentLevelId: "level_AxA",
    height: 1,
    loadLevelState: async (levelId) => ({
      gameId: "maze",
      levelId,
      levelLabel: levelId,
      width: 4,
      height: 1,
      terrain: levelId === "level_BxA" ? middleTerrain : stopTerrain,
      actors: [{ type: "player", x: 0, y: 0, elevation: 0, removed: false }]
    }),
    moveDurationMs: 0,
    terrain,
    width: 4
  });

  app.movePlayers(1, 0);
  await flushAsyncTurns();

  assert.equal(app.currentLevelId, "level_CxA");
  assert.deepEqual(
    app.state.actors
      .filter((actor) => app.isPlayerActor(actor) && !actor.removed)
      .map((actor) => [actor.x, actor.y, actor.elevation]),
    [[1, 0, 2]]
  );
})());

asyncTests.push((async () => {
  const terrain = createTerrain(4, 1);
  terrain[0][0] = stackedWall(2);
  terrain[0][1] = stackedWall(2);
  const middleTerrain = createTerrain(4, 1);
  const stopTerrain = createTerrain(4, 1);
  stopTerrain[0][2] = stackedWall(3);
  const player = { type: "player", x: 0, y: 0, elevation: 2, removed: false };
  const puncher = { type: "puncher", direction: "right", x: 1, y: 0, elevation: 2, removed: false };
  const app = createGameplayApp([player, puncher], {
    currentLevelId: "level_AxA",
    height: 1,
    loadLevelState: async (levelId) => ({
      gameId: "maze",
      levelId,
      levelLabel: levelId,
      width: 4,
      height: 1,
      terrain: levelId === "level_BxA" ? middleTerrain : stopTerrain,
      actors: [{ type: "player", x: 0, y: 0, elevation: 0, removed: false }]
    }),
    moveDurationMs: 0,
    terrain,
    width: 4
  });

  app.movePlayers(1, 0);
  await flushAsyncTurns();

  assert.equal(app.currentLevelId, "level_CxA");
  assert.deepEqual(
    app.state.actors
      .filter((actor) => app.isPlayerActor(actor) && !actor.removed)
      .map((actor) => [actor.x, actor.y, actor.elevation]),
    [[1, 0, 0]]
  );
})());

asyncTests.push((async () => {
  const terrain = createTerrain(4, 3);
  terrain[0][0] = stackedWall(2);
  terrain[0][1] = stackedWall(2);
  const middleTerrain = createTerrain(4, 3);
  const stopTerrain = createTerrain(4, 3);
  stopTerrain[0][2] = stackedWall(3);
  stopTerrain[2][1] = { type: "wall" };
  const player = { type: "player", x: 0, y: 0, elevation: 2, removed: false };
  const puncher = { type: "puncher", direction: "right", x: 1, y: 0, elevation: 2, removed: false };
  const app = createGameplayApp([player, puncher], {
    currentLevelId: "level_AxA",
    height: 3,
    loadLevelState: async (levelId) => ({
      gameId: "maze",
      levelId,
      levelLabel: levelId,
      width: 4,
      height: 3,
      terrain: levelId === "level_BxA" ? middleTerrain : stopTerrain,
      actors: [
        { type: "player", x: 0, y: 0, elevation: 0, removed: false },
        ...(levelId === "level_CxA"
          ? [{ type: "puncher", direction: "down", x: 1, y: 0, elevation: 0, removed: false }]
          : [])
      ]
    }),
    moveDurationMs: 0,
    terrain,
    width: 4
  });

  app.movePlayers(1, 0);
  await flushAsyncTurns();

  assert.equal(app.currentLevelId, "level_CxA");
  assert.deepEqual(
    app.state.actors
      .filter((actor) => app.isPlayerActor(actor) && !actor.removed)
      .map((actor) => [actor.x, actor.y, actor.elevation]),
    [[1, 1, 0]]
  );
})());

asyncTests.push((async () => {
  const nextTerrain = createTerrain(4, 4);
  nextTerrain[3][1] = { type: "wall" };
  const player = { type: "player", x: 0, y: 1, elevation: 0, removed: false };
  const puncher = { type: "puncher", direction: "down", x: 1, y: 1, elevation: 0, removed: false };
  const app = createGameplayApp([player, puncher], {
    currentLevelId: "level_AxA",
    height: 4,
    loadLevelState: async (levelId) => ({
      gameId: "maze",
      levelId,
      levelLabel: levelId,
      width: 4,
      height: 4,
      terrain: nextTerrain,
      actors: [{ type: "player", x: 0, y: 0, elevation: 0, removed: false }]
    }),
    moveDurationMs: 0,
    width: 4
  });

  app.movePlayers(1, 0);
  await flushAsyncTurns();

  assert.equal(app.currentLevelId, "level_AxB");
  assert.deepEqual(
    app.state.actors
      .filter((actor) => app.isPlayerActor(actor) && !actor.removed)
      .map((actor) => [actor.x, actor.y, actor.elevation]),
    [[1, 2, 0]]
  );
})());

Promise.all(asyncTests)
  .then(() => {
    console.log("weightless push regression tests passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
