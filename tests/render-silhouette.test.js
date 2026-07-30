const assert = require("node:assert/strict");
const { loadBrowserScript } = require("./helpers/browser-module-loader");

function createStubContext() {
  const noop = () => {};
  const operations = [];
  const context = {
    __operations: operations,
    clearRect: noop,
    fillRect(...args) {
      operations.push({ type: "fillRect", fillStyle: context.fillStyle, args });
    },
    strokeRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    fill: noop,
    save: noop,
    restore: noop,
    clip: noop,
    quadraticCurveTo: noop,
    arc: noop,
    ellipse: noop,
    drawImage: noop,
    setTransform: noop,
    rect: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    closePath: noop,
    viewport: noop,
    imageSmoothingEnabled: false,
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: ""
  };
  return context;
}

function buildTerrain(width, height, wallPositions = []) {
  const walls = new Set(wallPositions.map(([x, y]) => `${x},${y}`));

  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) =>
      walls.has(`${x},${y}`)
        ? {
            type: "wall",
            label: "Wall",
            imageUrl: null,
            underlay: {
              type: "floor",
              label: "Floor",
              imageUrl: null,
              underlay: null,
              raised: false
            },
            raised: false
          }
        : {
            type: "floor",
            label: "Floor",
            imageUrl: null,
            underlay: null,
            raised: false
          }
    )
  );
}

function buildPlayerGateTerrain(width, height, gateX, gateY, elevation = 0) {
  const terrain = buildTerrain(width, height);
  terrain[gateY][gateX] = {
    type: "player_gate",
    label: "Red Gate",
    imageUrl: null,
    underlay: null,
    raised: false,
    layers: [{ type: "player_gate", elevation }]
  };
  return terrain;
}

function buildOrangeWallTerrain() {
  const terrain = buildTerrain(2, 1);
  terrain[0][0] = {
    type: "orange_wall",
    label: "Orange Wall",
    imageUrl: null,
    underlay: null,
    raised: false,
    layers: [{ type: "orange_wall", elevation: 0 }]
  };
  terrain[0][1] = {
    type: "orange_button",
    label: "Orange Button",
    imageUrl: null,
    underlay: null,
    raised: false,
    layers: [{ type: "orange_button", elevation: 0 }]
  };
  return terrain;
}

function buildOrangeSlopeTerrain() {
  const terrain = buildTerrain(2, 1);
  terrain[0][0] = {
    type: "orange_ice_slope",
    label: "Orange Ice Slope",
    imageUrl: null,
    underlay: null,
    raised: false,
    layers: [{ type: "orange_ice_slope", elevation: 0, direction: "right" }]
  };
  terrain[0][1] = buildOrangeWallTerrain()[0][1];
  return terrain;
}

function createRenderApp({ terrain, actors, playData = {}, collectedGemIds = [] }) {
  const context = createStubContext();
  const storedCollectedGemIds = JSON.stringify(collectedGemIds);
  global.performance = { now: () => 0 };
  global.document = {
    title: "",
    createElement(tag) {
      if (tag !== "canvas") {
        return {};
      }

      return {
        width: 0,
        height: 0,
        style: {},
        getContext(type) {
          return type === "webgl" ? null : context;
        }
      };
    }
  };
  global.window = {
    location: { pathname: "/play/maze/level_AxA" },
    history: { replaceState: () => {} },
    devicePixelRatio: 1,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    localStorage: {
      getCalls: 0,
      setCalls: [],
      getItem() {
        this.getCalls += 1;
        return storedCollectedGemIds;
      },
      setItem(...args) {
        this.setCalls.push(args);
      }
    },
    PlayModules: {}
  };

  loadBrowserScript("public/play-rules.js");
  loadBrowserScript("public/play-core.js");
  loadBrowserScript("public/play-render-effects.js");
  loadBrowserScript("public/play-render-terrain.js");
  loadBrowserScript("public/play-render-actors.js");
  loadBrowserScript("public/play-render-compositor.js");
  loadBrowserScript("public/play-render.js");

  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getContext(type) {
      return type === "webgl" ? null : context;
    }
  };

  const app = window.PlayModules.createPlayCore({
    playData: {
      gameId: "maze",
      levelId: "level_AxA",
      levelLabel: "level_AxA",
      width: terrain[0].length,
      height: terrain.length,
      terrain,
      actors,
      ...playData
    },
    canvas,
    playShell: null,
    playHeader: null,
    playStage: null,
    mazeFrame: null,
    fuzzyToggle: null
  });

  window.PlayModules.registerRenderFunctions(app);
  return app;
}

{
  const actors = [{ type: "box", x: 1, y: 0, elevation: 0, removed: false }];
  const playApp = createRenderApp({ terrain: buildOrangeWallTerrain(), actors });
  const editorApp = createRenderApp({
    terrain: buildOrangeWallTerrain(),
    actors,
    playData: { editorRender: true, levelId: "__editor_render__" }
  });

  assert.equal(playApp.computeRaisedOrangeWallSet().has("0,0"), false);
  assert.equal(editorApp.computeRaisedOrangeWallSet().has("0,0"), true);
}

{
  const app = createRenderApp({ terrain: buildOrangeWallTerrain(), actors: [] });
  app.setRaisedOrangeWallState([]);
  const loweredSnapshot = app.cloneLevelSnapshot();
  app.setRaisedOrangeWallState(["0,0"]);

  app.applyLevelState(loweredSnapshot, {
    deferRender: true,
    skipTransientSideEffects: true
  });

  assert.deepEqual(
    Array.from(app.computeRaisedOrangeWallSet()),
    [],
    "level snapshots preserve a deferred lowered orange-wall component"
  );
}

{
  const actors = [{ type: "box", x: 1, y: 0, elevation: 0, removed: false }];
  const playApp = createRenderApp({ terrain: buildOrangeSlopeTerrain(), actors });
  const editorApp = createRenderApp({
    terrain: buildOrangeSlopeTerrain(),
    actors,
    playData: { editorRender: true, levelId: "__editor_render__" }
  });

  assert.equal(
    playApp.computeRaisedOrangeWallSet().has("0,0"),
    false,
    "a pressed orange slope lowers with the walls"
  );
  assert.equal(
    editorApp.computeRaisedOrangeWallSet().has("0,0"),
    true,
    "the editor renders the orange slope in its raised wedge state"
  );
}

{
  const actors = [{ type: "box", x: 1, y: 0, elevation: 0, removed: false }];
  const initialTerrain = buildTerrain(2, 1);
  initialTerrain[0][1] = buildOrangeWallTerrain()[0][1];
  const app = createRenderApp({
    terrain: initialTerrain,
    actors,
    playData: { editorRender: true, levelId: "__editor_render__" }
  });

  app.syncLiveRaisedSurfaces();
  assert.equal(app.liveRaisedOrangeWalls.has("0,0"), false);

  app.applyLevelState(
    {
      editorRender: true,
      levelId: "__editor_render__",
      levelLabel: "__editor_render__",
      width: 2,
      height: 1,
      terrain: buildOrangeWallTerrain(),
      actors
    },
    { deferRender: true, skipTransientSideEffects: true }
  );
  app.syncLiveRaisedSurfaces();
  assert.equal(app.liveRaisedOrangeWalls.has("0,0"), true);
}

{
  const app = createRenderApp({
    terrain: buildPlayerGateTerrain(3, 3, 1, 1, 4),
    actors: [{ type: "player", x: 1, y: 1, elevation: 0, removed: false }]
  });

  assert.equal(app.computeRaisedPlayerGateSet().has("1,1"), true);
}

{
  const app = createRenderApp({
    terrain: buildPlayerGateTerrain(3, 3, 1, 1, 4),
    actors: [{ type: "player", x: 1, y: 1, elevation: 4, removed: false }]
  });

  assert.equal(app.computeRaisedPlayerGateSet().has("1,1"), false);
}

{
  const app = createRenderApp({
    terrain: buildPlayerGateTerrain(3, 3, 1, 1, 4),
    actors: [{ type: "player", x: 0, y: 1, elevation: 9, removed: false }]
  });

  assert.equal(app.computeRaisedPlayerGateSet().has("1,1"), true);
}

{
  const app = createRenderApp({
    terrain: buildPlayerGateTerrain(3, 3, 1, 1, 0),
    actors: [
      { type: "player", x: 0, y: 1, elevation: 0, removed: false },
      { type: "box", x: 1, y: 1, elevation: 0, removed: false }
    ]
  });

  assert.equal(app.computeRaisedPlayerGateSet().has("1,1"), false);
}

{
  const app = createRenderApp({
    terrain: buildPlayerGateTerrain(3, 3, 1, 1, 0),
    actors: [
      { type: "player", x: 0, y: 1, elevation: 1, removed: false },
      { type: "box", x: 1, y: 1, elevation: 0, removed: false }
    ]
  });

  assert.equal(app.computeRaisedPlayerGateSet().has("1,1"), true);
}

{
  const app = createRenderApp({
    terrain: buildPlayerGateTerrain(3, 3, 1, 1, 4),
    actors: [{ type: "player", x: 0, y: 0, elevation: 4, removed: false }]
  });

  assert.equal(app.computeRaisedPlayerGateSet().has("1,1"), false);
}

{
  const carrier = {
    type: "weightless_box",
    groupId: "M0",
    x: 1,
    y: 0,
    elevation: 0,
    removed: false
  };
  const gate = { type: "attached_gate", x: 1, y: 0, elevation: 1, removed: false };
  const clone = { type: "clone", groupId: "c0", x: 3, y: 0, elevation: 1, removed: false };
  const app = createRenderApp({
    terrain: buildTerrain(4, 1),
    actors: [clone, carrier, gate]
  });
  const liveClone = app.state.actors[0];
  const liveGate = app.state.actors[2];

  app.syncLiveRaisedSurfaces();
  app.syncGateAnimationTargets(0);
  assert.equal(app.attachedGateLiftAt(liveGate, 0), 0);

  liveClone.x = 1;
  app.syncLiveRaisedSurfaces();
  assert.equal(app.liveRaisedPlayerGates.has("1,0"), true, "clone-on-gate activates it");
  app.syncGateAnimationTargets(10);

  assert.equal(app.attachedGateLiftAt(liveGate, 10), 0, "attached gate starts from its lowered pose");
  assert.ok(
    app.attachedGateLiftAt(liveGate, 120) > 0 && app.attachedGateLiftAt(liveGate, 120) < 1.08,
    "attached gate uses an intermediate tween value"
  );
  assert.equal(app.attachedGateLiftAt(liveGate, 230), 1, "attached gate tween reaches raised");
}

{
  const player = { type: "player", x: 0, y: 0, elevation: 1, removed: false };
  const carrier = {
    type: "weightless_box",
    groupId: "M0",
    x: 1,
    y: 0,
    elevation: 0,
    removed: false
  };
  const gate = {
    type: "attached_gate",
    x: 1,
    y: 0,
    elevation: 1,
    renderX: 1,
    renderY: 0,
    removed: false
  };
  const app = createRenderApp({
    terrain: buildTerrain(4, 1),
    actors: [player, carrier, gate]
  });
  const liveCarrier = app.state.actors[1];
  const liveGate = app.state.actors[2];

  app.syncLiveRaisedSurfaces();
  app.syncGateAnimationTargets(0);
  assert.equal(app.attachedGateLiftAt(liveGate, 0), 1);

  liveCarrier.x = 2;
  liveGate.x = 2;
  app.gateRenderOverride = new Set(["1,0"]);
  app.syncLiveRaisedSurfaces();
  app.syncGateAnimationTargets(20);

  assert.equal(
    app.attachedGateLiftAt(liveGate, 20),
    1,
    "moving attached gate keeps its identity-based phase during the carrier tween"
  );
}

{
  const app = createRenderApp({
    terrain: buildTerrain(1, 1),
    actors: [{ type: "gem", x: 0, y: 0, removed: false, elevation: 0, imageUrl: null }],
    playData: {
      levelId: "level_AxA"
    },
    collectedGemIds: ["level_AxA:gem:0:0,0,0", "level_AxA:gem:1:0,0,0"]
  });

  assert.equal(app.state.actors[0].collected, true);
  assert.equal(app.state.actors[0].removed, true);
  assert.equal(app.state.actors[0].showCollectedGhost, true);
  assert.equal(app.state.actors[0].renderAlpha, app.COLLECTED_GEM_ALPHA);
  assert.equal(app.state.actors[0].collectionId, "level_AxA:gem:0,0,0");
  assert.deepEqual(Array.from(app.collectedGemIds), ["level_AxA:gem:0,0,0"]);
  assert.equal(
    app.gemCollectionId({ type: "gem", x: 0, y: 0, elevation: 0 }, 99, "level_AxA"),
    "level_AxA:gem:0,0,0"
  );
}

{
  const app = createRenderApp({
    terrain: buildTerrain(1, 1),
    actors: [{ type: "gem", x: 0, y: 0, removed: false, elevation: 0, imageUrl: null }],
    playData: {
      editorRender: true,
      levelId: "level_AxA"
    },
    collectedGemIds: ["level_AxA:gem:0:0,0,0"]
  });

  assert.equal(app.state.actors[0].collected, false);
  assert.equal(app.state.actors[0].removed, false);
  assert.equal(app.state.actors[0].showCollectedGhost, false);
  assert.equal(app.state.actors[0].renderAlpha, 1);
}

{
  const actors = [
    { type: "gem", x: 0, y: 0, removed: false, elevation: 0, imageUrl: null }
  ];
  const app = createRenderApp({
    terrain: buildTerrain(1, 1),
    actors,
    playData: {
      ignoreSavedGemProgress: true,
      levelId: "level_AxA"
    },
    collectedGemIds: ["level_AxA:gem:0,0,0"]
  });

  assert.equal(app.ignoreSavedGemProgress, true);
  assert.equal(window.localStorage.getCalls, 0);
  assert.deepEqual(Array.from(app.collectedGemIds), []);
  assert.equal(app.state.actors[0].collected, false);
  assert.equal(app.state.actors[0].removed, false);
  assert.equal(app.state.actors[0].showCollectedGhost, false);
  assert.equal(app.state.actors[0].renderAlpha, 1);

  app.recordCollectedGemsFromMoves([
    {
      actor: app.state.actors[0],
      actorIndex: 0,
      toRemoved: true
    }
  ]);
  assert.deepEqual(Array.from(app.collectedGemIds), ["level_AxA:gem:0,0,0"]);
  assert.deepEqual(
    window.localStorage.setCalls,
    [],
    "one-off captures must never persist collected-gem progress"
  );

  app.applyLevelState(
    {
      actors,
      height: 1,
      levelId: "level_BxA",
      levelLabel: "level_BxA",
      terrain: buildTerrain(1, 1),
      width: 1
    },
    { deferRender: true, skipTransientSideEffects: true }
  );
  assert.equal(
    app.ignoreSavedGemProgress,
    true,
    "the capture-only progress policy must survive room transitions"
  );
  assert.equal(app.state.actors[0].collected, false);
  assert.equal(app.state.actors[0].removed, false);
}

{
  const app = createRenderApp({
    terrain: buildTerrain(4, 4, [
      [2, 0],
      [1, 1],
      [2, 1]
    ]),
    actors: []
  });

  assert.equal(app.elevatedSideBleedCoverFamily(1, 0, 1), "terrain:wall");
  assert.equal(app.renderTerrain.elevatedBleedCoverColor(app.elevatedSideBleedCoverFamily(1, 0, 1)), "#23262c");

  app.renderTerrain.paintElevatedSideBleedCover(app.sceneCtx, 1, 0, 1, 64, 74, 100);
  assert.deepEqual(app.sceneCtx.__operations.at(-1), {
    type: "fillRect",
    fillStyle: "#23262c",
    args: [61.5, 77, 5, 28]
  });

  app.sceneCtx.__operations.length = 0;
  app.renderActors.paintDepthSortedScene(0);
  assert.ok(
    app.sceneCtx.__operations.some(
      (operation) =>
        operation.fillStyle === "#23262c" &&
        operation.args[0] === 125.5 &&
        operation.args[1] === 50 &&
        operation.args[2] === 5 &&
        operation.args[3] === 19
    )
  );
}

{
  const app = createRenderApp({
    terrain: buildTerrain(4, 4),
    actors: [
      { type: "floating_floor", x: 2, y: 0, removed: false, elevation: 0, imageUrl: null },
      { type: "floating_floor", x: 1, y: 1, removed: false, elevation: 0, imageUrl: null },
      { type: "floating_floor", x: 2, y: 1, removed: false, elevation: 0, imageUrl: null }
    ]
  });

  assert.equal(app.elevatedSideBleedCoverFamily(1, 0, 1), "actor:floating_floor");
  assert.equal(app.elevatedSideBleedCoverFamily(1, 0, -1), null);
}

{
  const app = createRenderApp({
    terrain: buildTerrain(1, 1),
    actors: [{ type: "puncher", direction: "down", x: 0, y: 0, removed: false, elevation: 0 }]
  });
  const actorSnapshot = app.cloneActorState(app.state.actors[0]);
  const levelSnapshot = app.cloneLevelSnapshot();

  assert.equal(actorSnapshot.direction, "down");
  assert.equal(levelSnapshot.actors[0].direction, "down");
}

{
  const terrain = buildTerrain(4, 4);
  terrain[0][2] = { type: "player_lift", raised: true, imageUrl: null, underlay: null };
  terrain[1][1] = { type: "player_lift", raised: true, imageUrl: null, underlay: null };
  terrain[1][2] = { type: "player_lift", raised: true, imageUrl: null, underlay: null };
  const app = createRenderApp({
    terrain,
    actors: []
  });

  assert.equal(app.elevatedSideBleedCoverFamily(1, 0, 1), null);
  assert.equal(app.renderTerrain.elevatedBleedCoverColor("terrain:player_lift"), null);

  app.sceneCtx.__operations.length = 0;
  app.renderActors.paintDepthSortedScene(0);
  assert.equal(
    app.sceneCtx.__operations.some(
      (operation) =>
        operation.fillStyle === "#8a63d2" &&
        operation.args[2] === 5
    ),
    false
  );
}

{
  const app = createRenderApp({
    terrain: buildTerrain(4, 4),
    actors: [
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, removed: false, elevation: 0, imageUrl: null },
      { type: "weightless_box", groupId: "M0", x: 1, y: 1, removed: false, elevation: 0, imageUrl: null },
      { type: "weightless_box", groupId: "M0", x: 2, y: 1, removed: false, elevation: 0, imageUrl: null }
    ]
  });

  assert.equal(app.elevatedSideBleedCoverFamily(1, 0, 1), "actor:weightless_box:M0");

  app.state.actors.forEach((actor) => {
    actor.renderX = actor.x - 0.5;
    actor.renderY = actor.y + 0.25;
  });
  app.sceneCtx.__operations.length = 0;
  app.renderActors.paintDepthSortedScene(0);
  assert.ok(
    app.sceneCtx.__operations.some(
      (operation) =>
        operation.fillStyle === "#315991" &&
        operation.args[0] === 93.5 &&
        operation.args[1] === 66 &&
        operation.args[2] === 5 &&
        operation.args[3] === 19
    )
  );

  app.state.actors.forEach((actor) => {
    actor.renderScale = 0.5;
    actor.renderSink = 8;
  });
  app.sceneCtx.__operations.length = 0;
  app.renderActors.paintDepthSortedScene(0);
  assert.equal(
    app.sceneCtx.__operations.some(
      (operation) =>
        operation.fillStyle === "#315991" &&
        operation.args[2] === 5 &&
        operation.args[3] === 19
    ),
    false
  );
}

{
  const app = createRenderApp({
    terrain: buildTerrain(4, 4),
    actors: [
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, removed: false, elevation: 1, renderElevation: 1, imageUrl: null },
      { type: "weightless_box", groupId: "M0", x: 1, y: 1, removed: false, elevation: 1, renderElevation: 1, imageUrl: null },
      { type: "weightless_box", groupId: "M0", x: 2, y: 1, removed: false, elevation: 1, renderElevation: 1, imageUrl: null }
    ]
  });

  app.state.actors.forEach((actor) => {
    actor.renderX = actor.x - 0.5;
    actor.renderY = actor.y + 0.25;
    actor.renderElevation = 1;
  });
  app.sceneCtx.__operations.length = 0;
  app.renderActors.paintDepthSortedScene(0);
  assert.ok(
    app.sceneCtx.__operations.some(
      (operation) =>
        operation.fillStyle === "#315991" &&
        operation.args[0] === 93.5 &&
        operation.args[1] === 49 &&
        operation.args[2] === 5 &&
        operation.args[3] === 19
    )
  );
  assert.equal(app.renderActors.actorDepthRow(app.state.actors[1]), 2);
  assert.equal(app.renderActors.actorTieBreaker(app.state.actors[1]), 2.75);
  assert.ok(app.renderActors.buildDrawItems(0).some((item) => item.tieBreaker === 3));
}

{
  const app = createRenderApp({
    terrain: buildTerrain(3, 4),
    actors: [
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false, elevation: 1, renderElevation: 1, imageUrl: null },
      { type: "weightless_box", groupId: "M0", x: 1, y: 1, removed: false, elevation: 1, renderElevation: 1, imageUrl: null },
      { type: "weightless_box", groupId: "M0", x: 1, y: 2, removed: false, elevation: 1, renderElevation: 1, imageUrl: null }
    ]
  });

  app.state.actors.forEach((actor) => {
    actor.elevation = 1;
    actor.renderElevation = 1;
  });

  assert.ok(app.renderActors.buildDrawItems(0).some((item) => item.tieBreaker === 3.25));

  app.sceneCtx.__operations.length = 0;
  app.renderActors.paintDepthSortedScene(0);
  assert.ok(
    app.sceneCtx.__operations.some(
      (operation) =>
        operation.fillStyle === "#315991" &&
        operation.args[0] === 66 &&
        operation.args[1] === 45 &&
        operation.args[2] === 60 &&
        operation.args[3] === 5
    )
  );
  assert.ok(
    app.sceneCtx.__operations.some(
      (operation) =>
        operation.fillStyle === "#315991" &&
        operation.args[0] === 66 &&
        operation.args[1] === 109 &&
        operation.args[2] === 60 &&
        operation.args[3] === 5
    )
  );
}

{
  const app = createRenderApp({
    terrain: buildTerrain(3, 4),
    actors: [
      { type: "player", x: 1, y: 1, removed: false, elevation: 0, renderElevation: 0, imageUrl: null },
      { type: "weightless_box", groupId: "M0", x: 1, y: 1, removed: false, elevation: 1, renderElevation: 1, imageUrl: null }
    ]
  });

  app.state.actors[0].elevation = 0;
  app.state.actors[0].renderElevation = 0;
  app.state.actors[1].elevation = 1;
  app.state.actors[1].renderElevation = 1;

  const drawItems = app.renderActors.buildDrawItems(0);
  const playerDrawIndex = drawItems.findIndex((item) => item.order === 0);
  const weightlessDrawIndex = drawItems.findIndex((item) => item.order === 1);

  assert.notEqual(playerDrawIndex, -1);
  assert.notEqual(weightlessDrawIndex, -1);
  assert.ok(playerDrawIndex < weightlessDrawIndex);
}

{
  const app = createRenderApp({
    terrain: buildTerrain(3, 3),
    actors: [
      { type: "player", x: 1, y: 1, removed: false, elevation: 0, renderElevation: 0, imageUrl: null },
      { type: "weightless_box", groupId: "M0", x: 1, y: 1, removed: false, elevation: 1, renderElevation: 1, imageUrl: null }
    ]
  });

  app.state.actors[0].elevation = 0;
  app.state.actors[0].renderElevation = 0;
  app.state.actors[1].elevation = 1;
  app.state.actors[1].renderElevation = 1;

  for (const renderY of [0.4, 1.6]) {
    app.state.actors[0].renderY = renderY;

    const drawItems = app.renderActors.buildDrawItems(0);
    const playerDrawIndex = drawItems.findIndex((item) => item.order === 0);
    const weightlessDrawIndex = drawItems.findIndex((item) => item.order === 1);

    assert.equal(app.renderActors.actorDepthRow(app.state.actors[0]), 1);
    assert.notEqual(playerDrawIndex, -1);
    assert.notEqual(weightlessDrawIndex, -1);
    assert.ok(playerDrawIndex < weightlessDrawIndex);
  }

  app.state.actors[0].y = 2;
  app.state.actors[0].renderY = 1.4;

  {
    const drawItems = app.renderActors.buildDrawItems(0);
    const playerDrawIndex = drawItems.findIndex((item) => item.order === 0);
    const weightlessDrawIndex = drawItems.findIndex((item) => item.order === 1);

    assert.equal(app.renderActors.actorDepthRow(app.state.actors[0]), 1);
    assert.notEqual(playerDrawIndex, -1);
    assert.notEqual(weightlessDrawIndex, -1);
    assert.ok(playerDrawIndex < weightlessDrawIndex);
  }
}

{
  const app = createRenderApp({
    terrain: buildTerrain(3, 3),
    actors: [
      { type: "weightless_box", groupId: "M1", x: 1, y: 1, removed: false, elevation: 0, renderElevation: 0, imageUrl: null },
      { type: "weightless_box", groupId: "M0", x: 1, y: 1, removed: false, elevation: 1, renderElevation: 1, imageUrl: null }
    ]
  });

  app.state.actors[0].elevation = 0;
  app.state.actors[0].renderElevation = 0;
  app.state.actors[1].elevation = 1;
  app.state.actors[1].renderElevation = 1;
  app.state.actors[1].renderY = 0;

  const drawItems = app.renderActors.buildDrawItems(0);
  const lowerDrawIndex = drawItems.findIndex((item) => item.order === 0);
  const upperDrawIndex = drawItems.findIndex((item) => item.order === 1);

  assert.equal(app.renderActors.actorDepthRow(app.state.actors[0]), 0);
  assert.notEqual(lowerDrawIndex, -1);
  assert.notEqual(upperDrawIndex, -1);
  assert.ok(lowerDrawIndex < upperDrawIndex);
}

{
  const app = createRenderApp({
    terrain: buildTerrain(3, 1),
    actors: [
      { type: "weightless_box", groupId: "M2", x: 0, y: 0, removed: false, imageUrl: null },
      { type: "weightless_box", groupId: "M2", x: 1, y: 0, removed: false, imageUrl: null },
      { type: "weightless_box", groupId: "M3", x: 1, y: 0, removed: false, imageUrl: null },
      { type: "weightless_box", groupId: "M2", x: 2, y: 0, removed: false, imageUrl: null },
      { type: "weightless_box", groupId: "M3", x: 2, y: 0, removed: false, imageUrl: null }
    ]
  });

  assert.deepEqual(
    app.state.actors.map((actor) => [actor.groupId, actor.elevation, actor.renderElevation]),
    [
      ["M2", 0, 0],
      ["M2", 0, 0],
      ["M3", 1, 1],
      ["M2", 0, 0],
      ["M3", 1, 1]
    ]
  );
}

{
  const app = createRenderApp({
    terrain: buildTerrain(3, 4),
    actors: [
      { type: "player", x: 1, y: 1, removed: false, elevation: 0, renderElevation: 0, imageUrl: null },
      { type: "weightless_box", groupId: "M1", x: 1, y: 2, removed: false, elevation: 0, renderElevation: 0, imageUrl: null },
      { type: "weightless_box", groupId: "M0", x: 1, y: 1, removed: false, elevation: 1, renderElevation: 1, imageUrl: null }
    ]
  });

  app.state.actors[0].renderX = 1;
  app.state.actors[0].renderY = 0.5;
  app.state.actors[0].renderElevation = 0;
  app.state.actors[1].renderX = 1;
  app.state.actors[1].renderY = 1.5;
  app.state.actors[1].renderElevation = 0;
  app.state.actors[2].renderX = 1;
  app.state.actors[2].renderY = 1;
  app.state.actors[2].renderElevation = 1;

  const drawItems = app.renderActors.buildDrawItems(0);
  const playerDrawIndex = drawItems.findIndex((item) => item.order === 0);
  const bottomBoxDrawIndex = drawItems.findIndex((item) => item.order === 1);
  const topBoxDrawIndex = drawItems.findIndex((item) => item.order === 2);

  assert.equal(app.renderActors.actorDepthRow(app.state.actors[0]), 1);
  assert.equal(app.renderActors.actorDepthRow(app.state.actors[1]), 1);
  assert.notEqual(playerDrawIndex, -1);
  assert.notEqual(bottomBoxDrawIndex, -1);
  assert.notEqual(topBoxDrawIndex, -1);
  assert.ok(playerDrawIndex < bottomBoxDrawIndex);
  assert.ok(bottomBoxDrawIndex < topBoxDrawIndex);
}

{
  const app = createRenderApp({
    terrain: buildTerrain(5, 3),
    actors: [
      { type: "player", x: 2, y: 1, removed: false, elevation: 1, renderElevation: 1, imageUrl: null },
      { type: "weightless_box", groupId: "S0", x: 1, y: 1, removed: false, elevation: 0, renderElevation: 0, imageUrl: null },
      { type: "weightless_box", groupId: "S1", x: 2, y: 1, removed: false, elevation: 0, renderElevation: 0, imageUrl: null },
      { type: "weightless_box", groupId: "S2", x: 3, y: 1, removed: false, elevation: 0, renderElevation: 0, imageUrl: null },
      { type: "weightless_box", groupId: "M0", x: 3, y: 1, removed: false, elevation: 1, renderElevation: 1, imageUrl: null }
    ]
  });

  app.state.actors[0].renderX = 1.5;
  app.state.actors[0].renderY = 1;
  app.state.actors[0].renderElevation = 1;
  app.state.actors[1].renderX = 1;
  app.state.actors[1].renderY = 1;
  app.state.actors[1].renderElevation = 0;
  app.state.actors[2].renderX = 2;
  app.state.actors[2].renderY = 1;
  app.state.actors[2].renderElevation = 0;
  app.state.actors[3].renderX = 3;
  app.state.actors[3].renderY = 1;
  app.state.actors[3].renderElevation = 0;
  app.state.actors[4].renderX = 2.5;
  app.state.actors[4].renderY = 1;
  app.state.actors[4].renderElevation = 1;

  const drawItems = app.renderActors.buildDrawItems(0);
  const playerDrawIndex = drawItems.findIndex((item) => item.order === 0);
  const supportDrawIndex = drawItems.findIndex((item) => item.order === 2);
  const pushedBoxDrawIndex = drawItems.findIndex((item) => item.order === 4);

  assert.equal(app.renderActors.actorDepthRow(app.state.actors[0]), 1);
  assert.equal(app.renderActors.actorDepthRow(app.state.actors[2]), 1);
  assert.notEqual(playerDrawIndex, -1);
  assert.notEqual(supportDrawIndex, -1);
  assert.notEqual(pushedBoxDrawIndex, -1);
  assert.ok(supportDrawIndex < playerDrawIndex);
  assert.ok(playerDrawIndex < pushedBoxDrawIndex);
}

{
  const app = createRenderApp({
    terrain: buildTerrain(3, 4),
    actors: [
      { type: "weightless_box", groupId: "M1", x: 1, y: 1, removed: false, elevation: 0, renderElevation: 0, imageUrl: null },
      { type: "weightless_box", groupId: "M2", x: 1, y: 2, removed: false, elevation: 0, renderElevation: 0, imageUrl: null },
      { type: "player", x: 1, y: 1, removed: false, elevation: 1, renderElevation: 1, imageUrl: null },
      { type: "weightless_box", groupId: "M0", x: 1, y: 2, removed: false, elevation: 1, renderElevation: 1, imageUrl: null }
    ]
  });

  app.state.actors[0].elevation = 0;
  app.state.actors[0].renderElevation = 0;
  app.state.actors[1].elevation = 0;
  app.state.actors[1].renderElevation = 0;
  app.state.actors[2].elevation = 1;
  app.state.actors[2].renderElevation = 1;
  app.state.actors[2].renderY = 0.5;
  app.state.actors[3].elevation = 1;
  app.state.actors[3].renderElevation = 1;
  app.state.actors[3].renderY = 1.5;

  const drawItems = app.renderActors.buildDrawItems(0);
  const playerDrawIndex = drawItems.findIndex((item) => item.order === 2 && item.tieBreaker === 2);
  const playerOverlayDrawIndex = drawItems.findIndex((item) => item.order === 2.5 && item.tieBreaker === 3);
  const pushedBoxDrawIndex = drawItems.findIndex((item) => item.order === 3);

  assert.equal(app.renderActors.actorDepthRow(app.state.actors[2]), 1);
  assert.equal(app.renderActors.actorTieBreaker(app.state.actors[2]), 2);
  assert.notEqual(playerDrawIndex, -1);
  assert.notEqual(playerOverlayDrawIndex, -1);
  assert.notEqual(pushedBoxDrawIndex, -1);
  assert.ok(playerDrawIndex < pushedBoxDrawIndex);
  assert.ok(pushedBoxDrawIndex < playerOverlayDrawIndex);
}

{
  const app = createRenderApp({
    terrain: buildTerrain(4, 4),
    actors: [
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, removed: false, elevation: 0, imageUrl: null },
      { type: "weightless_box", groupId: "M1", x: 1, y: 1, removed: false, elevation: 0, imageUrl: null },
      { type: "weightless_box", groupId: "M1", x: 2, y: 1, removed: false, elevation: 0, imageUrl: null }
    ]
  });

  assert.equal(app.elevatedSideBleedCoverFamily(1, 0, 1), null);
}

{
  const app = createRenderApp({
    terrain: buildTerrain(20, 20),
    actors: [],
    playData: {
      cameraView: { width: 16, height: 16 },
      worldColumns: Array.from("ABCDEFGHIJKLMNOP"),
      worldRows: Array.from("ABCDEFGHIJKLMNOP")
    }
  });

  assert.equal(app.VIEWPORT_TILE_WIDTH, 16);
  assert.equal(app.VIEWPORT_TILE_HEIGHT, 16);
  assert.equal(app.viewportRect.width, 16 * app.TILE_SIZE);
  assert.equal(app.viewportRect.height, 16 * app.TILE_SIZE);
}

{
  const app = createRenderApp({
    terrain: buildTerrain(4, 4, [
      [3, 0],
      [3, 1]
    ]),
    actors: [],
    playData: {
      worldColumns: ["A", "B"],
      worldRows: ["A"],
      width: 4,
      height: 4
    }
  });

  assert.equal(app.isTerrainWallAcrossHorizontalWorldEdge(4, 0), false);
  assert.equal(app.elevatedSideBleedCoverFamily(3, 0, 1), null);

  app.rememberHorizontalNeighborLevelState({
    levelId: "level_BxA",
    width: 4,
    height: 4,
    terrain: buildTerrain(4, 4, [
      [0, 0],
      [0, 1]
    ]),
    actors: []
  });

  assert.equal(app.isTerrainWallAcrossHorizontalWorldEdge(4, 0), true);
  assert.equal(app.elevatedSideBleedCoverFamily(3, 0, 1), "terrain:wall");
}

console.log("render silhouette regression tests passed");
