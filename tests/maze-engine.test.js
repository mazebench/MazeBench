const assert = require("node:assert/strict");
const { loadBrowserScript } = require("./helpers/browser-module-loader");

global.window = {};
loadBrowserScript("public/maze-engine.js");

const { createEngine, terrainTypes } = window.MazeEngine;

function floorTerrain(width, height) {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ type: "floor" }))
  );
}

function iceBlockLayer(elevation = 0) {
  return {
    type: "ice_block",
    layers: [{ type: "ice_block", elevation }]
  };
}

function iceFloorLayer(elevation = 0) {
  return {
    type: "ice",
    layers: [{ type: "ice", elevation }]
  };
}

function iceBlockStack(...elevations) {
  return {
    type: "ice_block",
    layers: elevations.map((elevation) => ({ type: "ice_block", elevation }))
  };
}

function iceSlopeLayer(direction = "right", elevation = 0) {
  return {
    type: "ice_slope",
    layers: [{ type: "ice_slope", direction, elevation }]
  };
}

function iceSlopeOnIceBlockLayer(direction = "right", elevation = 1) {
  return {
    type: "ice_slope",
    layers: [
      { type: "ice_block", elevation: 0 },
      { type: "ice_slope", direction, elevation }
    ]
  };
}

function playerLiftLayer(elevation = 0, raised = false) {
  return {
    type: "player_lift",
    layers: [{ type: "player_lift", elevation, raised }],
    raised
  };
}

function playerGateLayer(elevation = 0) {
  return {
    type: "player_gate",
    layers: [{ type: "player_gate", elevation }]
  };
}

function wallStack(count, startElevation = 0) {
  return {
    type: "wall",
    layers: Array.from({ length: count }, (_, index) => ({
      type: "wall",
      elevation: startElevation + index
    }))
  };
}

function orangeWallStack(count, startElevation = 0, underlayLayers = []) {
  return {
    type: "orange_wall",
    layers: underlayLayers.concat(
      Array.from({ length: count }, (_, index) => ({
        type: "orange_wall",
        elevation: startElevation + index
      }))
    )
  };
}

function createState(playData) {
  const engine = createEngine(playData);
  return {
    engine,
    state: engine.cloneState(engine.initialState)
  };
}

{
  // Cross-room movement continues the main player's motion in the next room,
  // but must not replay the source-room input against clones already there.
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: floorTerrain(4, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "clone", groupId: "c0", x: 2, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0, { suppressCloneInput: true });

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.equal(result.moves.some((move) => move.actorType === "clone"), false);
}

{
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain: floorTerrain(2, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "gem", x: 1, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.equal(engine.isSolved(state), true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorRemoved[1], 1);
}

{
  // Regression: gems already collected before the engine was created
  // (mid-session states) must not register as instantly solved.
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: floorTerrain(3, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "gem", x: 1, y: 0, removed: true },
      { type: "gem", x: 2, y: 0, removed: false }
    ]
  });

  assert.equal(engine.isSolved(state), false);

  const firstMove = engine.move(state, 1, 0);

  assert.equal(firstMove.moved, true);
  assert.equal(engine.isSolved(state), false);

  const secondMove = engine.move(state, 1, 0);

  assert.equal(secondMove.moved, true);
  assert.equal(state.actorRemoved[2], 1);
  assert.equal(engine.isSolved(state), true);
}

{
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: floorTerrain(3, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "clone", groupId: "c0", x: 1, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.equal(result.moves.some((move) => move.actorType === "clone" && move.levelExit), false);
}

{
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain: floorTerrain(2, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "clone", groupId: "c0", x: 1, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [1, 0]);
}

for (const { name, dx, dy } of [
  { name: "left", dx: -1, dy: 0 },
  { name: "right", dx: 1, dy: 0 },
  { name: "up", dx: 0, dy: -1 },
  { name: "down", dx: 0, dy: 1 }
]) {
  // A rigid clone formation may surround the main player. Every player-type
  // actor receives the same input, so the clone group and player must vacate
  // one another's cells atomically instead of deadlocking on their starting
  // occupancy.
  const actors = [];

  for (let y = 1; y <= 3; y += 1) {
    for (let x = 1; x <= 3; x += 1) {
      actors.push(
        x === 2 && y === 2
          ? { type: "player", x, y, removed: false }
          : { type: "clone", groupId: "c0", x, y, removed: false }
      );
    }
  }

  const { engine, state } = createState({
    width: 5,
    height: 5,
    terrain: floorTerrain(5, 5),
    actors
  });
  const beforeKey = engine.stateKey(state);
  const result = engine.move(state, dx, dy);

  assert.equal(result.moved, true, `surrounded player formation moves ${name}`);
  actors.forEach((actor, index) => {
    assert.deepEqual(
      [state.actorX[index], state.actorY[index]],
      [actor.x + dx, actor.y + dy],
      `${actor.type} translates with the ${name} formation`
    );
  });
  assert.equal(
    result.moves.filter((move) => !move.visualOnly).length,
    actors.length,
    `every formation member records one ${name} move`
  );

  engine.undoMove(state, result);
  assert.equal(engine.stateKey(state), beforeKey, `${name} formation move undoes exactly`);
}

{
  // Interlocked occupancy is not permission to cross terrain or board edges:
  // the same formation remains wholly stationary when its front face is
  // blocked.
  const actors = [];

  for (let y = 1; y <= 3; y += 1) {
    for (let x = 0; x <= 2; x += 1) {
      actors.push(
        x === 1 && y === 2
          ? { type: "player", x, y, removed: false }
          : { type: "clone", groupId: "c0", x, y, removed: false }
      );
    }
  }

  const { engine, state } = createState({
    width: 5,
    height: 5,
    terrain: floorTerrain(5, 5),
    actors
  });
  const beforeKey = engine.stateKey(state);
  const result = engine.move(state, -1, 0);

  assert.equal(result.moved, false);
  assert.equal(engine.stateKey(state), beforeKey, "edge-blocked formation stays intact");
}

{
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: floorTerrain(3, 1),
    actors: [
      { type: "clone", groupId: "c0", x: 0, y: 0, elevation: 0, removed: false },
      { type: "clone", groupId: "c0", x: 0, y: 0, elevation: 1, removed: false },
      { type: "clone", groupId: "c0", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorElevation[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorElevation[1]], [1, 1]);
  assert.deepEqual([state.actorX[2], state.actorElevation[2]], [2, 1]);
  assert.equal(result.moves.filter((move) => move.actorType === "clone").length, 3);
}

{
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: floorTerrain(3, 1),
    actors: [
      { type: "clone", groupId: "c0", x: 0, y: 0, elevation: 0, removed: false },
      { type: "clone", groupId: "c1", x: 0, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorElevation[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorElevation[1]], [1, 1]);
}

{
  const terrain = floorTerrain(2, 1);
  terrain[0][1] = wallStack(1, 0);
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain,
    actors: [
      { type: "clone", groupId: "c0", x: 0, y: 0, elevation: 0, removed: false },
      { type: "clone", groupId: "c0", x: 0, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorElevation[0]], [0, 0]);
  assert.deepEqual([state.actorX[1], state.actorElevation[1]], [0, 1]);
}

{
  const terrain = floorTerrain(2, 1);
  terrain[0][1] = { type: "empty" };
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain,
    actors: [{ type: "clone", groupId: "c0", x: 0, y: 0, elevation: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual(
    [state.actorX[0], state.actorElevation[0], state.actorRemoved[0]],
    [1, -1, 1]
  );
  assert.equal(result.moves[0].toRemoved, true);
}

{
  const terrain = floorTerrain(2, 1);
  terrain[0][1] = { type: "empty" };
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain,
    actors: [
      { type: "clone", groupId: "c0", x: 0, y: 0, elevation: 0, removed: false },
      { type: "clone", groupId: "c0", x: 0, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorElevation[0], state.actorRemoved[0]], [1, -1, 1]);
  assert.deepEqual([state.actorX[1], state.actorElevation[1], state.actorRemoved[1]], [1, 0, 1]);
}

{
  const terrain = [[{ type: "floor" }, { type: "empty", layers: [] }, { type: "floor" }]];
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "clone", groupId: "c2", x: 0, y: 0, elevation: 0, removed: false },
      { type: "clone", groupId: "c1", x: 0, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorElevation[0], state.actorRemoved[0]], [1, -1, 1]);
  assert.deepEqual([state.actorX[1], state.actorElevation[1], state.actorRemoved[1]], [1, 0, 1]);
}

{
  const terrain = floorTerrain(2, 1);
  terrain[0][0] = wallStack(1);
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain,
    actors: [{ type: "clone", groupId: "c0", x: 0, y: 0, elevation: 1, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorElevation[0]], [0, 1]);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][2] = { type: "hole" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "clone", groupId: "c0", x: 0, y: 0, elevation: 0, removed: false },
      { type: "clone", groupId: "c0", x: 1, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorElevation[0], state.actorRemoved[0]], [1, 0, 0]);
  assert.deepEqual([state.actorX[1], state.actorElevation[1], state.actorRemoved[1]], [2, 0, 0]);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: floorTerrain(4, 1),
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: -1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[1], state.actorElevation[1]], [1, 0]);
  assert.deepEqual([state.actorX[2], state.actorElevation[2]], [1, -1]);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: floorTerrain(4, 1),
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: -2, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorElevation[1]], [2, 0]);
  assert.deepEqual([state.actorX[2], state.actorElevation[2]], [2, -2]);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: floorTerrain(4, 1),
    actors: [
      { type: "clone", groupId: "c0", x: 0, y: 0, elevation: 0, removed: false },
      { type: "box", x: 1, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorElevation[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorElevation[1]], [2, 0]);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: floorTerrain(4, 1),
    actors: [
      { type: "clone", groupId: "c0", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorElevation[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorElevation[1]], [2, 0]);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: floorTerrain(4, 1),
    actors: [
      { type: "clone", groupId: "c0", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorElevation[0]], [1, 1]);
  assert.deepEqual([state.actorX[1], state.actorElevation[1]], [1, 0]);
  assert.deepEqual([state.actorX[2], state.actorElevation[2]], [2, 0]);
  assert.deepEqual([state.actorX[3], state.actorElevation[3]], [2, 1]);
}

{
  const terrain = [[{ type: "floor" }, { type: "floor" }, { type: "hole" }, { type: "hole" }]];
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "clone", groupId: "c0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "clone", groupId: "c0", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual(Array.from(state.actorX), [2, 2]);
  assert.deepEqual(Array.from(state.actorElevation), [-1, 0]);
  assert.deepEqual(Array.from(state.actorRemoved), [1, 1]);
  assert.equal(result.moves.every((move) => move.toRemoved === true), true);
}

{
  const terrain = [[wallStack(1), { type: "floor" }, { type: "empty", layers: [] }, { type: "floor" }]];
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "clone", groupId: "c0", x: 0, y: 0, elevation: 1, removed: false },
      { type: "clone", groupId: "c0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "clone", groupId: "c0", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual(Array.from(state.actorX), [1, 2, 2]);
  assert.deepEqual(Array.from(state.actorElevation), [0, -1, 0]);
  assert.deepEqual(Array.from(state.actorRemoved), [0, 0, 0]);
}

{
  const terrain = [[
    iceFloorLayer(0),
    iceFloorLayer(0),
    iceFloorLayer(0),
    iceFloorLayer(0),
    iceFloorLayer(0),
    iceFloorLayer(0)
  ]];
  const { engine, state } = createState({
    width: 6,
    height: 1,
    terrain,
    actors: [
      { type: "clone", groupId: "c0", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const cloneMove = result.moves.find((move) => move.actorType === "clone");

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorElevation[0]], [4, 1]);
  assert.deepEqual([state.actorX[1], state.actorElevation[1]], [4, 0]);
  assert.deepEqual([state.actorX[2], state.actorElevation[2]], [5, 0]);
  assert.deepEqual([state.actorX[3], state.actorElevation[3]], [5, 1]);
  assert.deepEqual(cloneMove.path, [
    { x: 0, y: 0, elevation: 1 },
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 1 },
    { x: 3, y: 0, elevation: 1 },
    { x: 4, y: 0, elevation: 1 }
  ]);
}

{
  const terrain = [[
    wallStack(1),
    wallStack(1),
    iceSlopeOnIceBlockLayer("right", 1),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0)
  ]];
  const { engine, state } = createState({
    width: 6,
    height: 1,
    terrain,
    actors: [
      { type: "clone", groupId: "c0", x: 0, y: 0, elevation: 1, removed: false },
      { type: "box", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorType === "box");

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorElevation[0]], [1, 1]);
  assert.deepEqual([state.actorX[1], state.actorElevation[1]], [3, 1]);
  assert.deepEqual(boxMove.path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 1 }
  ]);
}

{
  const terrain = [[
    wallStack(1),
    wallStack(1),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceSlopeOnIceBlockLayer("right", 1),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0)
  ]];
  const { engine, state } = createState({
    width: 9,
    height: 1,
    terrain,
    actors: [
      { type: "clone", groupId: "c0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "clone", groupId: "c0", x: 2, y: 0, elevation: 1, removed: false },
      { type: "clone", groupId: "c0", x: 3, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const cloneMoves = result.moves.filter((move) => move.actorType === "clone");

  assert.equal(result.moved, true);
  assert.deepEqual(cloneMoves.map((move) => [move.toX, move.toElevation]), [
    [5, 1],
    [6, 1],
    [7, 1]
  ]);
  assert.deepEqual(cloneMoves[0].path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 2 },
    { x: 4, y: 0, elevation: 2 },
    { x: 5, y: 0, elevation: 2 },
    { x: 5, y: 0, elevation: 1 }
  ]);
  assert.equal(cloneMoves.every((move) => move.toRemoved === false), true);
}

{
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: floorTerrain(3, 1),
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "clone", groupId: "c0", x: 0, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorElevation[1]], [1, 0]);
  assert.deepEqual([state.actorX[0], state.actorElevation[0]], [1, 1]);
}

{
  const { engine, state } = createState({
    width: 3,
    height: 2,
    terrain: floorTerrain(3, 2),
    actors: [
      { type: "player", x: 1, y: 0, elevation: 1, removed: false },
      { type: "clone", groupId: "c0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "clone", groupId: "c0", x: 2, y: 0, elevation: 0, removed: false },
      { type: "clone", groupId: "c0", x: 1, y: 1, elevation: 0, removed: false },
      { type: "clone", groupId: "c0", x: 2, y: 1, elevation: 0, removed: false },
      { type: "clone", groupId: "c0", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, -1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [0, 0, 1]);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [0, 0, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2], state.actorElevation[2]], [1, 0, 0]);
  assert.deepEqual([state.actorX[3], state.actorY[3], state.actorElevation[3]], [0, 1, 0]);
  assert.deepEqual([state.actorX[4], state.actorY[4], state.actorElevation[4]], [1, 1, 0]);
  assert.deepEqual([state.actorX[5], state.actorY[5], state.actorElevation[5]], [1, 0, 1]);
}

{
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain: [[{ type: "floor" }, playerLiftLayer(0, false)]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);
  const playerMove = result.moves[0];

  assert.equal(result.moved, true);
  assert.deepEqual(result.liftToggles, [{ x: 1, y: 0, raised: true }]);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.equal(playerMove.fromElevation, 0);
  assert.equal(playerMove.toElevation, 1);
  assert.equal(playerMove.pathControlsElevation, undefined);
  assert.equal(playerMove.path, undefined);
}

{
  const oneHighWall = {
    type: "wall",
    layers: [{ type: "wall", elevation: 0 }]
  };
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain: [[oneHighWall, playerLiftLayer(0, true)]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 1, removed: false }]
  });

  const result = engine.move(state, 1, 0);
  const playerMove = result.moves[0];

  assert.equal(result.moved, true);
  assert.deepEqual(result.liftToggles, [{ x: 1, y: 0, raised: false }]);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.equal(state.actorRemoved[0], 0);
  assert.equal(playerMove.fromElevation, 1);
  assert.equal(playerMove.toElevation, 0);
  assert.equal(playerMove.iceSlipOff, undefined);
  assert.equal(playerMove.toRemoved, false);
}

{
  const { state } = createState({
    width: 2,
    height: 1,
    terrain: floorTerrain(2, 1),
    actors: [
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 3, removed: false }
    ]
  });

  assert.equal(state.actorElevation[0], 2);
  assert.equal(state.actorElevation[1], 3);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: floorTerrain(4, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 1, y: 0, removed: false },
      { type: "gem", x: 2, y: 0, removed: false }
    ]
  });

  engine.move(state, 1, 0);

  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.equal(state.actorRemoved[2], 0);

  engine.move(state, 1, 0);

  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [3, 0]);
  assert.equal(state.actorRemoved[2], 1);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][0] = { type: "wall" };
  terrain[0][1] = { type: "hole" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.equal(state.actorRemoved[0], 0);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [1, 0]);
  assert.equal(state.actorRemoved[1], 0);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][2] = { type: "hole" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "floating_floor", x: 1, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorRemoved[1], 1);
  assert.equal(state.terrain[engine.cellIndex(2, 0)], terrainTypes.floor);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][2] = { type: "empty", layers: [] };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "floating_floor", x: 1, y: 0, removed: false }
    ]
  });
  const result = engine.moveForSearch(state, 1, 0);

  assert.equal(result.moved, true);
  assert.equal(state.actorRemoved[1], 1);
  assert.equal(state.terrain[engine.cellIndex(2, 0)], terrainTypes.floor);

  engine.undoMove(state, result);

  assert.equal(state.terrain[engine.cellIndex(2, 0)], terrainTypes.empty);
  assert.equal(state.actorRemoved[1], 0);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [1, 0]);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][1] = { type: "ice" };
  terrain[0][2] = { type: "ice" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "gem", x: 1, y: 0, removed: false },
      { type: "gem", x: 3, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.equal(state.actorRemoved[1], 0);
  assert.equal(state.actorRemoved[2], 1);
}

{
  const terrain = floorTerrain(2, 1);
  terrain[0][1] = { type: "ice_block" };
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain,
    actors: [{ type: "player", x: 0, y: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
}

{
  const iceBlock = {
    type: "ice_block",
    layers: [{ type: "ice_block", elevation: 0 }]
  };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[iceBlock, iceBlock, iceBlock]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "gem", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(engine.isSolved(state), true);
}

{
  const iceBlock = {
    type: "ice_block",
    layers: [{ type: "ice_block", elevation: 0 }]
  };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[iceBlock, iceBlock, { type: "empty" }]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 1, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.equal(state.actorRemoved[0], 1);
  assert.equal(result.moves[0].iceSlipOff, true);
  assert.equal(result.moves[0].toRemoved, true);
}

{
  const iceBlock = {
    type: "ice_block",
    layers: [{ type: "ice_block", elevation: 0 }]
  };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[iceBlock, iceBlock, { type: "floor" }]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 1, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.equal(state.actorRemoved[0], 0);
  assert.equal(result.moves[0].iceSlipOff, true);
  assert.equal(result.moves[0].toElevation, 0);
  assert.equal(result.moves[0].toRemoved, false);
}

{
  const oneHighWall = {
    type: "wall",
    layers: [{ type: "wall", elevation: 0 }]
  };
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain: [[oneHighWall, { type: "empty" }]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 1, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.equal(state.actorRemoved[0], 0);
}

{
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[{ type: "floor" }, iceSlopeLayer("right", 0), iceBlockLayer(0)]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.equal(result.moves[0].iceSlide, true);
  assert.deepEqual(result.moves[0].path, [
    { x: 0, y: 0, elevation: 0 },
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 1 }
  ]);
}

{
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[{ type: "floor" }, iceSlopeLayer("right", 0), iceBlockLayer(0)]],
    actors: [{ type: "player", x: 2, y: 0, elevation: 1, removed: false }]
  });

  const result = engine.move(state, -1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.equal(result.moves[0].iceSlide, true);
  assert.deepEqual(result.moves[0].path, [
    { x: 2, y: 0, elevation: 1 },
    { x: 1, y: 0, elevation: 1 },
    { x: 0, y: 0, elevation: 0 }
  ]);
}

{
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[{ type: "floor" }, iceSlopeLayer("right", 0), { type: "floor" }]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.equal(state.actorRemoved[0], 0);
  assert.equal(result.moves[0].iceSlipOff, true);
  assert.deepEqual(result.moves[0].path, [
    { x: 0, y: 0, elevation: 0 },
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 0 }
  ]);
}

{
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[{ type: "floor" }, iceSlopeLayer("right", 0), { type: "empty" }]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.equal(state.actorRemoved[0], 1);
  assert.equal(result.moves[0].iceSlipOff, true);
}

{
  const tallWall = {
    type: "wall",
    layers: [
      { type: "wall", elevation: 0 },
      { type: "wall", elevation: 1 }
    ]
  };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[{ type: "floor" }, iceSlopeLayer("right", 0), tallWall]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  // MazeCore rewrite (SEMANTICS.md): a pure visual bounce changes no state,
  // so moved is false in BOTH modes — legacy returned moved:true in play
  // mode only, making agents score no-op inputs as successful moves and
  // desynchronizing the solver's move graph from play mode. The visualOnly
  // record is still emitted for the bounce animation.
  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.equal(result.moves[0].visualOnly, true);
  assert.deepEqual(result.moves[0].path, [
    { x: 0, y: 0, elevation: 0 },
    { x: 1, y: 0, elevation: 1 },
    { x: 0, y: 0, elevation: 0 }
  ]);
}

{
  const threeHighWall = {
    type: "wall",
    layers: [
      { type: "wall", elevation: 0 },
      { type: "wall", elevation: 1 },
      { type: "wall", elevation: 2 }
    ]
  };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: [[iceBlockLayer(0), iceBlockLayer(0), iceSlopeLayer("right", 1), threeHighWall]],
    actors: [{ type: "player", x: 1, y: 0, elevation: 1, removed: false }]
  });

  const result = engine.move(state, 1, 0);
  const playerMove = result.moves.find((move) => move.actorIndex === 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.equal(playerMove.visualOnly, undefined);
  assert.equal(playerMove.iceSlide, true);
  assert.deepEqual(playerMove.path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 1, y: 0, elevation: 1 },
    { x: 0, y: 0, elevation: 1 }
  ]);
}

{
  const threeHighWall = {
    type: "wall",
    layers: [
      { type: "wall", elevation: 0 },
      { type: "wall", elevation: 1 },
      { type: "wall", elevation: 2 }
    ]
  };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: [[iceBlockLayer(0), iceBlockLayer(0), iceSlopeLayer("right", 1), threeHighWall]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "box", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [0, 0]);
  assert.equal(state.actorElevation[1], 1);
  assert.equal(boxMove.iceSlide, true);
  assert.deepEqual(boxMove.path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 1, y: 0, elevation: 1 },
    { x: 0, y: 0, elevation: 1 }
  ]);
}

{
  const threeHighWall = {
    type: "wall",
    layers: [
      { type: "wall", elevation: 0 },
      { type: "wall", elevation: 1 },
      { type: "wall", elevation: 2 }
    ]
  };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: [[iceBlockLayer(0), iceBlockLayer(0), iceSlopeLayer("right", 1), threeHighWall]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [0, 0]);
  assert.equal(state.actorElevation[1], 1);
  assert.equal(boxMove.iceSlide, true);
  assert.deepEqual(boxMove.path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 1, y: 0, elevation: 1 },
    { x: 0, y: 0, elevation: 1 }
  ]);
}

{
  const terrain = [[
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceSlopeLayer("right", 1),
    iceSlopeLayer("left", 0),
    { type: "floor" },
    { type: "floor" }
  ]];
  const { engine, state } = createState({
    width: 6,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "box", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.equal(boxMoves.length, 1);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [5, 0]);
  assert.equal(state.actorElevation[1], 0);
  assert.deepEqual(boxMoves[0].path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 1 },
    { x: 4, y: 0, elevation: 0 },
    { x: 5, y: 0, elevation: 0 }
  ]);
}

{
  const terrain = [[
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceSlopeLayer("right", 1),
    iceSlopeLayer("left", 0),
    { type: "floor" },
    { type: "floor" }
  ]];
  const { engine, state } = createState({
    width: 6,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.equal(boxMoves.length, 1);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [5, 0]);
  assert.equal(state.actorElevation[1], 0);
  assert.deepEqual(boxMoves[0].path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 1 },
    { x: 4, y: 0, elevation: 0 },
    { x: 5, y: 0, elevation: 0 }
  ]);
}

{
  const terrain = [[
    wallStack(1),
    wallStack(1),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceSlopeOnIceBlockLayer("right", 1),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0)
  ]];
  const { engine, state } = createState({
    width: 9,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual(boxMoves.map((move) => [move.toX, move.toElevation]), [
    [5, 1],
    [6, 1],
    [7, 1]
  ]);
  assert.deepEqual(boxMoves[0].path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 2 },
    { x: 4, y: 0, elevation: 2 },
    { x: 5, y: 0, elevation: 2 },
    { x: 5, y: 0, elevation: 1 }
  ]);
  assert.equal(boxMoves[0].pathEndElevation, 1);
}

{
  const terrain = [[
    wallStack(1),
    wallStack(1),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceSlopeOnIceBlockLayer("right", 1),
    iceBlockStack(0, 1),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0)
  ]];
  const { engine, state } = createState({
    width: 10,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual(boxMoves.map((move) => [move.toX, move.toElevation]), [
    [6, 1],
    [7, 1],
    [8, 1]
  ]);
  assert.deepEqual(boxMoves[0].path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 2 },
    { x: 4, y: 0, elevation: 2 },
    { x: 5, y: 0, elevation: 2 },
    { x: 6, y: 0, elevation: 2 },
    { x: 6, y: 0, elevation: 1 }
  ]);
  assert.equal(boxMoves[0].pathEndElevation, 1);
}

{
  const terrain = [[
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceSlopeOnIceBlockLayer("right", 1),
    iceBlockStack(0, 1),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0)
  ]];
  const { engine, state } = createState({
    width: 9,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 3, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual(boxMoves.map((move) => [move.toX, move.toElevation]), [
    [4, 1],
    [4, 2],
    [4, 3]
  ]);
  assert.deepEqual(boxMoves[0].path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 2 },
    { x: 4, y: 0, elevation: 2 },
    { x: 4, y: 0, elevation: 1 }
  ]);
  assert.equal(boxMoves[0].pathEndElevation, 1);
}

{
  const terrain = [[
    wallStack(2),
    wallStack(2),
    iceBlockLayer(1),
    iceBlockLayer(1),
    iceSlopeOnIceBlockLayer("left", 1),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0)
  ]];
  const { engine, state } = createState({
    width: 9,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 0, elevation: 2, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual(boxMoves.map((move) => [move.toX, move.toElevation]), [
    [5, 1],
    [6, 1],
    [7, 1]
  ]);
  assert.deepEqual(boxMoves[0].path, [
    { x: 1, y: 0, elevation: 2 },
    { x: 2, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 2 },
    { x: 4, y: 0, elevation: 2 },
    { x: 5, y: 0, elevation: 2 },
    { x: 5, y: 0, elevation: 1 }
  ]);
  assert.equal(boxMoves[0].pathEndElevation, 1);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: [[{ type: "floor" }, iceSlopeLayer("right", 0), iceBlockLayer(0), iceBlockLayer(0)]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "box", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [3, 0]);
  assert.equal(state.actorElevation[1], 1);
  assert.equal(result.moves.some((move) => move.visualOnly), false);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: [[{ type: "floor" }, iceSlopeLayer("right", 0), iceBlockLayer(0), iceBlockLayer(0)]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [3, 0]);
  assert.equal(state.actorElevation[1], 1);
  assert.equal(result.moves.some((move) => move.visualOnly), false);
}

{
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain: [[{ type: "floor" }, { type: "floor" }, iceSlopeLayer("right", 0), iceBlockLayer(0), iceBlockLayer(0)]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "box", x: 1, y: 0, elevation: 0, removed: false },
      { type: "box", x: 3, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [3, 0]);
  assert.equal(state.actorElevation[1], 1);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [4, 0]);
  assert.equal(state.actorElevation[2], 1);
  assert.deepEqual(result.moves.find((move) => move.actorIndex === 1).path, [
    { x: 1, y: 0, elevation: 0 },
    { x: 2, y: 0, elevation: 1 },
    { x: 3, y: 0, elevation: 1 }
  ]);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: [[{ type: "floor" }, iceSlopeLayer("right", 0), iceBlockLayer(0), iceBlockLayer(0)]],
    actors: [
      { type: "player", x: 3, y: 0, elevation: 1, removed: false },
      { type: "box", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, -1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [0, 0]);
  assert.equal(state.actorElevation[1], 0);
  assert.deepEqual(result.moves.find((move) => move.actorIndex === 1).path, [
    { x: 2, y: 0, elevation: 1 },
    { x: 1, y: 0, elevation: 1 },
    { x: 0, y: 0, elevation: 0 }
  ]);
  assert.deepEqual(result.moves.find((move) => move.actorIndex === 0).path, [
    { x: 3, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 1 },
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 1 },
    { x: 3, y: 0, elevation: 1 }
  ]);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][1] = { type: "ice" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "box", x: 2, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: [[{ type: "floor" }, iceSlopeLayer("right", 0), iceSlopeLayer("right", 1), iceBlockLayer(1)]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.equal(state.actorElevation[0], 2);
  assert.equal(result.moves[0].iceSlide, true);
  assert.deepEqual(result.moves[0].path, [
    { x: 0, y: 0, elevation: 0 },
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 2 }
  ]);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: [[{ type: "floor" }, { type: "floor" }, iceSlopeLayer("right", 0), iceBlockLayer(0)]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [3, 0]);
  assert.equal(state.actorElevation[1], 1);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);
  assert.equal(boxMove.iceSlide, true);
  assert.deepEqual(boxMove.path, [
    { x: 1, y: 0, elevation: 0 },
    { x: 2, y: 0, elevation: 1 },
    { x: 3, y: 0, elevation: 1 }
  ]);
}

{
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain: [[{ type: "floor" }, { type: "floor" }, iceSlopeLayer("right", 0), iceBlockLayer(0), iceBlockLayer(0)]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "box", x: 3, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [3, 0]);
  assert.equal(state.actorElevation[1], 1);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [4, 0]);
  assert.equal(state.actorElevation[2], 1);
  assert.deepEqual(result.moves.find((move) => move.actorIndex === 1).path, [
    { x: 1, y: 0, elevation: 0 },
    { x: 2, y: 0, elevation: 1 },
    { x: 3, y: 0, elevation: 1 }
  ]);
}

{
  const highIce = {
    type: "ice_block",
    layers: [
      { type: "floor", elevation: 0 },
      { type: "ice_block", elevation: 1 }
    ]
  };
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain: [[highIce, iceSlopeLayer("right", 0)]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 2, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.equal(result.moves[0].iceSlipOff, true);
}

{
  const tower = {
    type: "wall",
    layers: [
      { type: "wall", elevation: 0 },
      { type: "wall", elevation: 1 }
    ]
  };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[tower, iceSlopeLayer("left", 0), { type: "floor" }]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 2, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.equal(state.actorElevation[0], 2);
  assert.equal(state.actorRemoved[0], 0);
}

{
  const lowWall = {
    type: "wall",
    layers: [{ type: "wall", elevation: 0 }]
  };
  const terrain = floorTerrain(3, 3);
  terrain[0][1] = lowWall;
  terrain[1][1] = lowWall;
  terrain[2][1] = iceSlopeLayer("right", 0);
  const { engine, state } = createState({
    width: 3,
    height: 3,
    terrain,
    actors: [
      { type: "player", x: 1, y: 0, elevation: 1, removed: false },
      { type: "box", x: 1, y: 1, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 0, 1);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [0, 2]);
  assert.equal(state.actorElevation[1], 0);
  assert.equal(boxMove.iceSlide, true);
  assert.deepEqual(boxMove.path, [
    { x: 1, y: 1, elevation: 1 },
    { x: 1, y: 2, elevation: 1 },
    { x: 0, y: 2, elevation: 0 }
  ]);
}

{
  const tower = {
    type: "wall",
    layers: [{ type: "wall", elevation: 0 }]
  };
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain: [[tower, tower, iceSlopeLayer("right", 1), iceSlopeLayer("left", 0), { type: "floor" }]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "box", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [4, 0]);
  assert.equal(state.actorElevation[1], 0);
  assert.equal(boxMove.iceSlide, true);
  assert.deepEqual(boxMove.path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 1 },
    { x: 4, y: 0, elevation: 0 }
  ]);
}

{
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain: [[iceBlockLayer(0), iceSlopeLayer("right", 1), iceSlopeLayer("left", 0), { type: "floor" }, { type: "floor" }]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "box", x: 3, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);
  const playerMove = result.moves.find((move) => move.actorIndex === 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [4, 0]);
  assert.equal(state.actorElevation[1], 0);
  assert.deepEqual([boxMove.fromX, boxMove.toX], [3, 4]);
  assert.deepEqual(playerMove.path, [
    { x: 0, y: 0, elevation: 1 },
    { x: 1, y: 0, elevation: 2 },
    { x: 2, y: 0, elevation: 2 },
    { x: 2, y: 0, elevation: 1 },
    { x: 3, y: 0, elevation: 0 }
  ]);
}

{
  const tower = {
    type: "wall",
    layers: [
      { type: "wall", elevation: 0 },
      { type: "wall", elevation: 1 }
    ]
  };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: [[tower, tower, iceSlopeLayer("left", 0), { type: "floor" }]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 2, removed: false },
      { type: "box", x: 1, y: 0, elevation: 2, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [3, 0]);
  assert.equal(state.actorElevation[1], 0);
  assert.equal(boxMove.iceSlide, true);
  assert.deepEqual(boxMove.path, [
    { x: 1, y: 0, elevation: 2 },
    { x: 2, y: 0, elevation: 2 },
    { x: 2, y: 0, elevation: 1 },
    { x: 3, y: 0, elevation: 0 }
  ]);
}

{
  const { engine, state } = createState({
    width: 3,
    height: 2,
    terrain: floorTerrain(3, 2),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [2, 1]);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][2] = {
    type: "floor",
    layers: [
      { type: "floor", elevation: 0 },
      { type: "wall", elevation: 1 }
    ]
  };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.equal(state.actorElevation[1], 0);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: floorTerrain(4, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 1, y: 0, removed: false },
      { type: "gem", x: 3, y: 0, removed: false }
    ]
  });
  const beforeKey = engine.stateKey(state);
  const result = engine.moveForSearch(state, 1, 0);

  assert.equal(result.moved, true);
  assert.equal(result.nonPlayerMoveCount, 1);
  assert.notEqual(engine.stateKey(state), beforeKey);

  engine.undoMove(state, result);

  assert.equal(engine.stateKey(state), beforeKey);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [1, 0]);
  assert.equal(state.actorRemoved[2], 0);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][2] = { type: "hole" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "floating_floor", x: 1, y: 0, removed: false }
    ]
  });
  const beforeKey = engine.stateKey(state);
  const result = engine.moveForSearch(state, 1, 0);

  assert.equal(result.moved, true);
  assert.equal(result.nonPlayerMoveCount, 1);
  assert.equal(state.terrain[engine.cellIndex(2, 0)], terrainTypes.floor);

  engine.undoMove(state, result);

  assert.equal(engine.stateKey(state), beforeKey);
  assert.equal(state.terrain[engine.cellIndex(2, 0)], terrainTypes.hole);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [1, 0]);
  assert.equal(state.actorRemoved[1], 0);
}

{
  const terrain = floorTerrain(2, 1);
  terrain[0][1] = { type: "orange_wall" };
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain,
    actors: [{ type: "player", x: 0, y: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
}

{
  const terrain = floorTerrain(2, 1);
  terrain[0][1] = { type: "tree" };
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain,
    actors: [{ type: "player", x: 0, y: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
}

{
  const terrain = floorTerrain(2, 1);
  terrain[0][1] = { type: "shrub" };
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain,
    actors: [{ type: "player", x: 0, y: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
}

{
  const terrain = floorTerrain(2, 1);
  terrain[0][1] = { type: "block_asset" };
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain,
    actors: [{ type: "player", x: 0, y: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
}

{
  const terrain = floorTerrain(2, 1);
  terrain[0][0] = { type: "wall" };
  terrain[0][1] = { type: "shrub" };
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain,
    actors: [{ type: "player", x: 0, y: 0, elevation: 1, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.equal(state.actorElevation[0], 1);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][1] = { type: "orange_wall" };
  terrain[0][2] = { type: "orange_button" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 2, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 0);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][1] = { type: "orange_wall" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 2, y: 0, removed: false },
      { type: "orange_button", x: 2, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 0);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][1] = orangeWallStack(2);
  terrain[0][2] = { type: "orange_button" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 2, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][0] = { type: "wall", layers: [{ type: "wall", elevation: 0 }] };
  terrain[0][1] = orangeWallStack(2);
  terrain[0][2] = { type: "orange_button" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "box", x: 2, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 1);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][0] = { type: "wall", layers: [{ type: "wall", elevation: 0 }] };
  terrain[0][1] = orangeWallStack(1, 1, [{ type: "wall", elevation: 0 }]);
  terrain[0][2] = { type: "orange_button" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "box", x: 2, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 1);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][0] = { type: "wall", layers: [{ type: "wall", elevation: 0 }] };
  terrain[0][1] = orangeWallStack(1, 2);
  terrain[0][2] = { type: "orange_button" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "box", x: 2, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.equal(state.actorElevation[0], 1);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][1] = { type: "ice" };
  terrain[0][2] = { type: "ice" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "orange_button", x: 1, y: 0, elevation: 0, removed: false },
      { type: "gem", x: 3, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.equal(state.actorRemoved[2], 1);
}

{
  const terrain = floorTerrain(3, 1);
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
      { type: "orange_button", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const buttonMove = result.moves.find((move) => move.actorIndex === 2);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [2, 0]);
  assert.equal(state.actorElevation[2], 1);
  assert.equal(buttonMove.actorType, "orange_button");
  assert.equal(buttonMove.fromX, 1);
  assert.equal(buttonMove.toX, 2);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][1] = { type: "orange_wall" };
  terrain[0][2] = { type: "orange_button" };
  terrain[0][3] = { type: "orange_button" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 2, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
}

{
  const terrain = floorTerrain(2, 2);
  terrain[0][0] = { type: "orange_button" };
  terrain[0][1] = { type: "orange_wall" };
  const { engine, state } = createState({
    width: 2,
    height: 2,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false }
    ]
  });

  assert.equal(state.actorElevation[1], 0);

  const result = engine.move(state, 0, 1);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 1]);
  assert.equal(state.actorElevation[1], 1);
  assert.equal(boxMove.fromElevation, 0);
  assert.equal(boxMove.toElevation, 1);
}

{
  const terrain = floorTerrain(2, 2);
  terrain[0][0] = { type: "orange_button" };
  terrain[0][1] = { type: "orange_wall" };
  const { engine, state } = createState({
    width: 2,
    height: 2,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
      { type: "player", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 0, 1);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);
  const riderMove = result.moves.find((move) => move.actorIndex === 2);

  assert.equal(result.moved, true);
  assert.equal(state.actorElevation[1], 1);
  assert.equal(state.actorElevation[2], 2);
  assert.equal(boxMove.fromElevation, 0);
  assert.equal(boxMove.toElevation, 1);
  assert.equal(riderMove.fromElevation, 1);
  assert.equal(riderMove.toElevation, 2);
}

{
  const terrain = floorTerrain(2, 2);
  terrain[0][1] = { type: "orange_wall" };
  const { engine, state } = createState({
    width: 2,
    height: 2,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "orange_button", x: 0, y: 1, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "player", x: 1, y: 0, elevation: 2, removed: false }
    ]
  });

  const result = engine.move(state, 0, 1);
  const boxMove = result.moves.find((move) => move.actorIndex === 2);
  const riderMove = result.moves.find((move) => move.actorIndex === 3);

  assert.equal(result.moved, true);
  assert.equal(state.actorElevation[2], 0);
  assert.equal(state.actorElevation[3], 1);
  assert.equal(boxMove.fromElevation, 1);
  assert.equal(boxMove.toElevation, 0);
  assert.equal(riderMove.fromElevation, 2);
  assert.equal(riderMove.toElevation, 1);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][0] = { type: "orange_wall" };
  terrain[0][1] = { type: "orange_wall" };
  terrain[0][2] = { type: "orange_wall" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [3, 0]);
  assert.equal(state.actorElevation[1], 1);
  assert.equal(state.actorElevation[2], 1);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][0] = { type: "orange_wall" };
  terrain[0][1] = { type: "orange_wall" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.equal(state.actorElevation[1], 0);
  assert.equal(state.actorRemoved[1], 0);
  assert.equal(boxMove.fromElevation, 1);
  assert.equal(boxMove.toElevation, 0);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][0] = { type: "wall" };
  terrain[0][1] = { type: "wall" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
      { type: "weightless_box", groupId: "M1", x: 2, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const upperBoxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.equal(state.actorElevation[1], 1);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [2, 0]);
  assert.equal(state.actorElevation[2], 0);
  assert.equal(upperBoxMove.fromElevation, 1);
  assert.equal(upperBoxMove.toElevation, 1);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: floorTerrain(4, 1),
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M1", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.equal(state.actorElevation[1], 0);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [1, 0]);
  assert.equal(state.actorElevation[2], 1);
  assert.equal(result.moves.some((move) => move.actorIndex === 2), false);
}

{
  const terrain = [[wallStack(2), playerGateLayer(0), wallStack(1)]];
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 2, removed: false },
      { type: "circle_player", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, -1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [1, 0, 1]);
}

{
  const terrain = [[wallStack(1), playerGateLayer(0)]];
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "box", x: 1, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, 1]);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [1, 0, 0]);
}

{
  const terrain = [[{ type: "floor" }, playerGateLayer(0), { type: "floor" }]];
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "box", x: 1, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [2, 0, 0]);
}

{
  const terrain = [[playerGateLayer(0)]];
  const { engine, state } = createState({
    width: 1,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false }
    ]
  });

  assert.equal(engine.computeRaisedPlayerGateSet(state).has(engine.cellIndex(0, 0)), false);
}

{
  const terrain = [[wallStack(1), wallStack(1), playerGateLayer(0)]];
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 0, removed: false },
      { type: "box", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const lowerMove = result.moves.find((move) => move.actorIndex === 1);
  const riderMove = result.moves.find((move) => move.actorIndex === 2);

  assert.equal(result.moved, true);
  assert.equal(engine.computeRaisedPlayerGateSet(state).has(engine.cellIndex(2, 0)), true);
  assert.equal(state.actorElevation[1], 1);
  assert.equal(state.actorElevation[2], 2);
  assert.equal(lowerMove.fromElevation, 0);
  assert.equal(lowerMove.toElevation, 1);
  assert.equal(riderMove.fromElevation, 1);
  assert.equal(riderMove.toElevation, 2);
}

{
  const terrain = [[wallStack(1), wallStack(1), playerGateLayer(0)]];
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 1, removed: false },
      { type: "box", x: 2, y: 0, elevation: 2, removed: false }
    ]
  });

  assert.equal(engine.computeRaisedPlayerGateSet(state).has(engine.cellIndex(2, 0)), true);

  const result = engine.move(state, -1, 0);
  const lowerMove = result.moves.find((move) => move.actorIndex === 1);
  const riderMove = result.moves.find((move) => move.actorIndex === 2);

  assert.equal(result.moved, true);
  assert.equal(engine.computeRaisedPlayerGateSet(state).has(engine.cellIndex(2, 0)), false);
  assert.equal(state.actorElevation[1], 0);
  assert.equal(state.actorElevation[2], 1);
  assert.equal(lowerMove.fromElevation, 1);
  assert.equal(lowerMove.toElevation, 0);
  assert.equal(riderMove.fromElevation, 2);
  assert.equal(riderMove.toElevation, 1);
}

{
  const terrain = [[
    wallStack(1),
    {
      type: "player_gate",
      layers: [
        { type: "player_gate", elevation: 0 },
        { type: "wall", elevation: 2 }
      ]
    }
  ]];
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 1, y: 0, elevation: 3, removed: false },
      { type: "circle_player", x: 0, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [1, 0, 1]);
}

{
  const { state } = createState({
    width: 3,
    height: 1,
    terrain: floorTerrain(3, 1),
    actors: [
      { type: "weightless_box", groupId: "M2", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M2", x: 1, y: 0, removed: false },
      { type: "weightless_box", groupId: "M3", x: 1, y: 0, removed: false },
      { type: "weightless_box", groupId: "M2", x: 2, y: 0, removed: false },
      { type: "weightless_box", groupId: "M3", x: 2, y: 0, removed: false }
    ]
  });

  assert.deepEqual(Array.from(state.actorElevation), [0, 0, 1, 0, 1]);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][0] = { type: "orange_wall" };
  terrain[0][1] = { type: "orange_wall" };
  terrain[0][2] = { type: "hole" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.equal(state.actorElevation[1], 0);
  assert.equal(state.actorRemoved[1], 1);
  assert.equal(boxMove.fromElevation, 1);
  assert.equal(boxMove.toElevation, 0);
  assert.equal(boxMove.toRemoved, true);
}

{
  const terrain = floorTerrain(3, 2);
  terrain[0][1] = { type: "orange_wall" };
  const { engine, state } = createState({
    width: 3,
    height: 2,
    terrain,
    actors: [
      { type: "player", x: 0, y: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 1, removed: false }
    ]
  });

  assert.equal(state.actorElevation[1], 1);
  assert.equal(state.actorElevation[2], 1);

  const result = engine.move(state, 1, 0);
  const playerMove = result.moves.find((move) => move.actorIndex === 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 1]);
  assert.equal(state.actorElevation[0], 0);
  assert.equal(playerMove.toElevation, 0);
  assert.equal(state.actorElevation[2], 1);
}

{
  const { state } = createState({
    width: 1,
    height: 2,
    terrain: floorTerrain(1, 2),
    actors: [
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 0, y: 1, elevation: 0, removed: false }
    ]
  });

  assert.deepEqual(Array.from(state.actorElevation), [0, 1, 0]);
}

{
  const { state } = createState({
    width: 1,
    height: 1,
    terrain: floorTerrain(1, 1),
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 1, removed: false }
    ]
  });

  assert.deepEqual(Array.from(state.actorElevation), [0, 1]);
}

{
  const terrain = [
    [
      {
        type: "wall",
        layers: [
          { type: "wall", elevation: 0 },
          { type: "wall", elevation: 1 }
        ]
      },
      {
        type: "ice",
        layers: [
          { type: "ice", elevation: 0 },
          { type: "ice", elevation: 1 }
        ]
      },
      {
        type: "floor"
      }
    ]
  ];
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "gem", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  assert.equal(state.actorElevation[0], 2);
  assert.equal(engine.move(state, 1, 0).moved, false);
}

{
  const elevatedIce = {
    type: "ice",
    layers: [
      { type: "ice", elevation: 0 },
      { type: "ice", elevation: 1 }
    ]
  };
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain: [[elevatedIce, elevatedIce]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "gem", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.equal(engine.isSolved(state), true);
  assert.equal(state.actorRemoved[1], 1);
}

{
  const elevatedIce = {
    type: "ice",
    layers: [
      { type: "ice", elevation: 0 },
      { type: "ice", elevation: 1 }
    ]
  };
  const oneHighWall = {
    type: "wall",
    layers: [{ type: "wall", elevation: 0 }]
  };
  const twoHighWall = {
    type: "wall",
    layers: [
      { type: "wall", elevation: 0 },
      { type: "wall", elevation: 1 }
    ]
  };

  {
    const { engine, state } = createState({
      width: 2,
      height: 1,
      terrain: [[elevatedIce, oneHighWall]],
      actors: [{ type: "player", x: 0, y: 0, elevation: 1, removed: false }]
    });

    const result = engine.move(state, 1, 0);

    assert.equal(result.moved, true);
    assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
    assert.equal(state.actorElevation[0], 1);
  }

  {
    const { engine, state } = createState({
      width: 2,
      height: 1,
      terrain: [[elevatedIce, twoHighWall]],
      actors: [{ type: "player", x: 0, y: 0, elevation: 1, removed: false }]
    });

    const result = engine.move(state, 1, 0);

    assert.equal(result.moved, false);
    assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
    assert.equal(state.actorElevation[0], 1);
  }
}

{
  const terrain = floorTerrain(5, 1);
  terrain[0][4] = { type: "wall" };
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "puncher", direction: "right", x: 1, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const puncherVisualMove = result.moves.find((move) => move.actorIndex === 1 && move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [1, 0]);
  assert.deepEqual(
    result.moves.find((move) => move.actorIndex === 0 && !move.visualOnly),
    {
      actorIndex: 0,
      actorType: "player",
      fromElevation: 0,
      fromRemoved: false,
      fromX: 0,
      fromY: 0,
      iceSlide: true,
      punchSlide: true,
      punchSegments: [
        {
          fromElevation: 0,
          fromX: 1,
          fromY: 0,
          punchSlide: true,
          sequence: 0,
          startIceSlide: false,
          toElevation: 0,
          toX: 3,
          toY: 0
        }
      ],
      punchStartElevation: 0,
      punchStartIceSlide: false,
      punchStartX: 1,
      punchStartY: 0,
      toElevation: 0,
      toRemoved: false,
      toX: 3,
      toY: 0
    }
  );
  assert.deepEqual(
    {
      fromX: puncherVisualMove.fromX,
      fromY: puncherVisualMove.fromY,
      toX: puncherVisualMove.toX,
      toY: puncherVisualMove.toY,
      targetX: puncherVisualMove.targetX,
      targetY: puncherVisualMove.targetY,
      finalX: puncherVisualMove.finalX,
      finalY: puncherVisualMove.finalY
    },
    { fromX: 1, fromY: 0, toX: 2, toY: 0, targetX: 3, targetY: 0, finalX: 1, finalY: 0 }
  );
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: floorTerrain(4, 1),
    actors: [{ type: "player", x: 0, y: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0, { continuePunchSlide: true });
  const playerMove = result.moves.find((move) => move.actorIndex === 0 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.equal(playerMove.punchSlide, true);
  assert.equal(playerMove.levelExit, true);
  assert.equal(playerMove.levelExitDx, 1);
  assert.equal(playerMove.levelExitDy, 0);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][3] = { type: "wall" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [{ type: "player", x: 0, y: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0, { continuePunchSlide: true });
  const playerMove = result.moves.find((move) => move.actorIndex === 0 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(playerMove.punchSlide, true);
  assert.equal(playerMove.levelExit, undefined);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: floorTerrain(4, 1),
    actors: [{ type: "player", x: 0, y: 0, elevation: 2, removed: false }]
  });

  const result = engine.move(state, 1, 0, { continuePunchSlide: true });
  const playerMove = result.moves.find((move) => move.actorIndex === 0 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.equal(state.actorElevation[0], 2);
  assert.equal(playerMove.punchSlide, true);
  assert.equal(playerMove.levelExit, true);
  assert.equal(playerMove.levelExitElevation, 2);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][3] = wallStack(3);
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [{ type: "player", x: 0, y: 0, elevation: 2, removed: false }]
  });

  const result = engine.move(state, 1, 0, { continuePunchSlide: true });
  const playerMove = result.moves.find((move) => move.actorIndex === 0 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.equal(playerMove.punchSlide, true);
  assert.equal(playerMove.pathControlsElevation, true);
  assert.deepEqual(playerMove.path.at(-1), { x: 2, y: 0, elevation: 0 });
}

{
  // A cross-room punch continuation may stop over an actor surface rather
  // than terrain. Preserve that same-height support instead of dropping the
  // player through the box to the floor below (GxK regression).
  const terrain = floorTerrain(4, 1);
  terrain[0][0] = wallStack(4);
  terrain[0][1] = wallStack(2);
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 2, removed: false },
      { type: "player", x: 3, y: 0, elevation: 3, removed: false }
    ]
  });

  const result = engine.move(state, -1, 0, { continuePunchSlide: true });
  const playerMove = result.moves.find((move) => move.actorIndex === 1 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [1, 0]);
  assert.equal(state.actorElevation[1], 3);
  assert.equal(playerMove.toElevation, 3);
  assert.equal(playerMove.punchSlide, true);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][3] = wallStack(3);
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 2, removed: false },
      { type: "puncher", direction: "left", x: 2, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0, { continuePunchSlide: true });
  const playerMove = result.moves.find((move) => move.actorIndex === 0 && !move.visualOnly);
  const puncherMove = result.moves.find((move) => move.actorIndex === 1 && move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.equal(playerMove.punchSlide, true);
  assert.deepEqual(
    playerMove.punchSegments.map(({ fromX, fromY, fromElevation, toX, toY, toElevation }) => ({
      fromX,
      fromY,
      fromElevation,
      toX,
      toY,
      toElevation
    })),
    [{ fromX: 2, fromY: 0, fromElevation: 0, toX: 0, toY: 0, toElevation: 0 }]
  );
  assert.equal(puncherMove?.punchSequence, 0);
}

{
  const terrain = floorTerrain(5, 4);
  terrain[0][4] = { type: "wall" };
  terrain[3][3] = { type: "wall" };
  const { engine, state } = createState({
    width: 5,
    height: 4,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "puncher", direction: "right", x: 1, y: 0, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 3, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const playerMove = result.moves.find((move) => move.actorIndex === 0 && !move.visualOnly);
  const puncherMoves = result.moves.filter((move) => move.actorType === "puncher" && move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 2]);
  assert.deepEqual(
    playerMove.punchSegments.map(
      ({ sequence, fromX, fromY, fromElevation, toX, toY, toElevation, startIceSlide }) => ({
        sequence,
        fromX,
        fromY,
        fromElevation,
        toX,
        toY,
        toElevation,
        startIceSlide
      })
    ),
    [
      {
        sequence: 0,
        fromX: 1,
        fromY: 0,
        fromElevation: 0,
        toX: 3,
        toY: 0,
        toElevation: 0,
        startIceSlide: false
      },
      {
        sequence: 1,
        fromX: 3,
        fromY: 0,
        fromElevation: 0,
        toX: 3,
        toY: 2,
        toElevation: 0,
        startIceSlide: true
      }
    ]
  );
  assert.deepEqual(
    puncherMoves.map((move) => move.punchSequence).sort(),
    [0, 1]
  );
}

{
  // IxB regression: a vertical rigid box punched downward lands with its
  // upper member on a second puncher. Preserve the group's relative
  // elevations before scanning for chained punches, then move both adjacent
  // rigid groups as one punch train.
  const terrain = floorTerrain(8, 6);
  terrain[5][5] = { type: "wall" };
  terrain[4][0] = { type: "wall" };
  terrain[0][1] = { type: "wall" };
  const { engine, state } = createState({
    width: 8,
    height: 6,
    terrain,
    actors: [
      { type: "player", x: 7, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "incoming", x: 6, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "incoming", x: 6, y: 0, elevation: 1, removed: false },
      { type: "puncher", direction: "down", x: 5, y: 0, elevation: 1, removed: false },
      { type: "puncher", direction: "left", x: 5, y: 4, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "target", x: 4, y: 4, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "target", x: 4, y: 4, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "target", x: 4, y: 4, elevation: 2, removed: false },
      { type: "puncher", direction: "up", x: 1, y: 4, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, -1, 0);
  const puncherMoves = result.moves.filter((move) => move.actorType === "puncher" && move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual(
    [
      state.actorX[1], state.actorY[1], state.actorElevation[1],
      state.actorX[2], state.actorY[2], state.actorElevation[2]
    ],
    [2, 4, 0, 2, 4, 1]
  );
  assert.deepEqual(
    [
      state.actorX[5], state.actorY[5], state.actorElevation[5],
      state.actorX[6], state.actorY[6], state.actorElevation[6],
      state.actorX[7], state.actorY[7], state.actorElevation[7]
    ],
    [1, 1, 0, 1, 1, 1, 1, 1, 2]
  );
  assert.deepEqual(
    result.moves
      .find((move) => move.actorIndex === 2 && !move.visualOnly)
      .punchSegments.map(({ sequence, fromX, fromY, toX, toY, toElevation }) => ({
        sequence,
        fromX,
        fromY,
        toX,
        toY,
        toElevation
      })),
    [
      { sequence: 0, fromX: 5, fromY: 0, toX: 5, toY: 4, toElevation: 1 },
      { sequence: 1, fromX: 5, fromY: 4, toX: 2, toY: 4, toElevation: 1 }
    ]
  );
  assert.deepEqual(
    puncherMoves.map((move) => move.punchSequence).sort(),
    [0, 1, 2]
  );
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][2] = { type: "hole", layers: [{ type: "hole", elevation: 0 }] };
  terrain[0][3] = { type: "wall" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "puncher", direction: "right", x: 1, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorRemoved[0], 1);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][2] = { type: "empty", layers: [] };
  terrain[0][3] = { type: "wall" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "puncher", direction: "right", x: 1, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const playerMove = result.moves.find((move) => move.actorIndex === 0 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorRemoved[0], 1);
  assert.equal(playerMove.toRemoved, true);
  assert.equal(playerMove.skipHoleFall, undefined);
}

{
  const terrain = floorTerrain(3, 4);
  terrain[2][2] = { type: "empty", layers: [] };
  terrain[3][2] = { type: "wall" };
  const { engine, state } = createState({
    width: 3,
    height: 4,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 1, y: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 2]);
  assert.equal(state.actorRemoved[1], 1);
  assert.equal(boxMove.toRemoved, true);
  assert.equal(boxMove.punchStartX, 2);
  assert.equal(boxMove.punchStartY, 0);
}

{
  const terrain = floorTerrain(3, 4);
  terrain[3][2] = { type: "wall" };
  const { engine, state } = createState({
    width: 3,
    height: 4,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 1, y: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 2]);
  assert.equal(
    result.moves.some(
      (move) =>
        move.actorIndex === 1 &&
        move.punchSlide &&
        move.punchStartX === 2 &&
        move.punchStartY === 0
    ),
    true
  );
}

{
  const terrain = floorTerrain(3, 4);
  terrain[2][2] = { type: "hole", layers: [{ type: "hole", elevation: 0 }] };
  terrain[3][2] = { type: "wall" };
  const { engine, state } = createState({
    width: 3,
    height: 4,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 2]);
  assert.equal(state.actorRemoved[1], 1);
  assert.equal(boxMove.toRemoved, true);
  assert.equal(boxMove.punchSlide, true);
  assert.equal(boxMove.punchStartX, 2);
  assert.equal(boxMove.punchStartY, 0);
}

{
  const terrain = floorTerrain(3, 4);
  terrain[2][2] = { type: "empty", layers: [] };
  terrain[3][2] = { type: "wall" };
  const { engine, state } = createState({
    width: 3,
    height: 4,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 2]);
  assert.equal(state.actorRemoved[1], 1);
  assert.equal(boxMove.toRemoved, true);
  assert.equal(boxMove.punchSlide, true);
  assert.equal(boxMove.punchStartX, 2);
  assert.equal(boxMove.punchStartY, 0);
}

{
  const terrain = floorTerrain(5, 1);
  terrain[0][4] = { type: "wall" };
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "puncher", direction: "right", x: 2, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [3, 0]);
  assert.equal(result.moves.some((move) => move.actorIndex === 2 && !move.visualOnly), true);
  assert.equal(result.moves.some((move) => move.actorIndex === 1 && move.punchSlide), false);
}

{
  const terrain = floorTerrain(6, 5);
  const { engine, state } = createState({
    width: 6,
    height: 5,
    terrain,
    actors: [
      { type: "player", x: 4, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 1, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 1, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, -1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual(
    [state.actorX[1], state.actorY[1], state.actorX[2], state.actorY[2], state.actorX[3], state.actorY[3]],
    [1, 0, 2, 0, 2, 1]
  );
  assert.deepEqual([state.actorX[4], state.actorY[4]], [1, 1]);
  assert.equal(boxMoves.some((move) => move.punchSlide), false);
}

{
  const terrain = floorTerrain(7, 5);
  const { engine, state } = createState({
    width: 7,
    height: 5,
    terrain,
    actors: [
      { type: "player", x: 1, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 1, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 1, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual(
    [state.actorX[1], state.actorY[1], state.actorX[2], state.actorY[2], state.actorX[3], state.actorY[3]],
    [3, 0, 4, 0, 4, 1]
  );
  assert.deepEqual([state.actorX[4], state.actorY[4]], [3, 1]);
  assert.equal(boxMoves.some((move) => move.punchSlide), false);
}

{
  const terrain = floorTerrain(4, 6);
  terrain[5][2] = { type: "wall" };
  const { engine, state } = createState({
    width: 4,
    height: 6,
    terrain,
    actors: [
      { type: "player", x: 0, y: 1, removed: false },
      { type: "box", x: 1, y: 1, elevation: 0, removed: false },
      { type: "puncher", direction: "up", x: 1, y: 0, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 1, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1 && !move.visualOnly);
  const attachedPuncherMove = result.moves.find((move) => move.actorIndex === 2 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 4]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [2, 3]);
  assert.equal(boxMove.punchStartX, 2);
  assert.equal(boxMove.punchStartY, 1);
  assert.deepEqual(
    attachedPuncherMove.punchSegments.map(
      ({ sequence, fromX, fromY, fromElevation, toX, toY, toElevation }) => ({
        sequence,
        fromX,
        fromY,
        fromElevation,
        toX,
        toY,
        toElevation
      })
    ),
    [
      {
        sequence: 0,
        fromX: 2,
        fromY: 0,
        fromElevation: 0,
        toX: 2,
        toY: 3,
        toElevation: 0
      }
    ]
  );
}

{
  const terrain = floorTerrain(6, 1);
  terrain[0][5] = { type: "wall" };
  const { engine, state } = createState({
    width: 6,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 1, y: 0, elevation: 0, removed: false },
      { type: "puncher", direction: "right", x: 2, y: 0, elevation: 0, removed: false },
      { type: "box", x: 3, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const carriedPuncherMove = result.moves.find((move) => move.actorIndex === 2 && !move.visualOnly);
  const puncherVisualMove = result.moves.find((move) => move.actorIndex === 2 && move.visualOnly);
  const punchedBoxMove = result.moves.find((move) => move.actorIndex === 3 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [3, 0]);
  assert.deepEqual([state.actorX[3], state.actorY[3]], [4, 0]);
  assert.deepEqual(
    {
      fromX: carriedPuncherMove.fromX,
      fromY: carriedPuncherMove.fromY,
      toX: carriedPuncherMove.toX,
      toY: carriedPuncherMove.toY
    },
    { fromX: 2, fromY: 0, toX: 3, toY: 0 }
  );
  assert.deepEqual(
    {
      fromX: puncherVisualMove.fromX,
      fromY: puncherVisualMove.fromY,
      toX: puncherVisualMove.toX,
      toY: puncherVisualMove.toY,
      finalX: puncherVisualMove.finalX,
      finalY: puncherVisualMove.finalY,
      punchSequence: puncherVisualMove.punchSequence
    },
    { fromX: 2, fromY: 0, toX: 4, toY: 0, finalX: 3, finalY: 0, punchSequence: 0 }
  );
  assert.equal(punchedBoxMove.punchStartX, 3);
  assert.equal(punchedBoxMove.punchStartY, 0);
  assert.deepEqual(
    punchedBoxMove.punchSegments.map(({ sequence, fromX, fromY, toX, toY }) => ({
      sequence,
      fromX,
      fromY,
      toX,
      toY
    })),
    [{ sequence: 0, fromX: 3, fromY: 0, toX: 4, toY: 0 }]
  );
}

{
  const terrain = floorTerrain(7, 3);
  terrain[1][6] = { type: "wall" };
  const { engine, state } = createState({
    width: 7,
    height: 3,
    terrain,
    actors: [
      { type: "player", x: 0, y: 1, removed: false },
      { type: "box", x: 1, y: 1, elevation: 0, removed: false },
      { type: "puncher", direction: "right", x: 2, y: 1, elevation: 0, removed: false },
      { type: "box", x: 3, y: 1, elevation: 0, removed: false },
      { type: "puncher", direction: "up", x: 3, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const targetBoxMove = result.moves.find((move) => move.actorIndex === 3 && !move.visualOnly);
  const targetPuncherMove = result.moves.find((move) => move.actorIndex === 4 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 1]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [3, 1]);
  assert.deepEqual([state.actorX[3], state.actorY[3]], [5, 1]);
  assert.deepEqual([state.actorX[4], state.actorY[4]], [5, 0]);
  assert.equal(targetBoxMove.punchStartX, 3);
  assert.equal(targetBoxMove.punchStartY, 1);
  assert.deepEqual(
    targetPuncherMove.punchSegments.map(({ sequence, fromX, fromY, toX, toY }) => ({
      sequence,
      fromX,
      fromY,
      toX,
      toY
    })),
    [{ sequence: 0, fromX: 3, fromY: 0, toX: 5, toY: 0 }]
  );
}

{
  const terrain = floorTerrain(4, 4);
  terrain[1][2] = { type: "hole", layers: [{ type: "hole", elevation: 0 }] };
  terrain[3][2] = { type: "wall" };
  const { engine, state } = createState({
    width: 4,
    height: 4,
    terrain,
    actors: [
      { type: "player", x: 0, y: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 1, elevation: 0, removed: false },
      { type: "puncher", direction: "up", x: 1, y: 0, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 1, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1 && !move.visualOnly);
  const attachedPuncherMove = result.moves.find((move) => move.actorIndex === 2 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 2]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [2, 1]);
  assert.equal(state.actorRemoved[1], 0);
  assert.equal(state.actorRemoved[2], 0);
  assert.equal(boxMove.toRemoved, false);
  assert.equal(attachedPuncherMove.toRemoved, false);
  assert.equal(attachedPuncherMove.stickyCarrierEntityKey, "weightless:M0");
}

{
  const terrain = floorTerrain(4, 4);
  terrain[1][2] = { type: "hole", layers: [{ type: "hole", elevation: 0 }] };
  terrain[2][2] = { type: "hole", layers: [{ type: "hole", elevation: 0 }] };
  terrain[3][2] = { type: "wall" };
  const { engine, state } = createState({
    width: 4,
    height: 4,
    terrain,
    actors: [
      { type: "player", x: 0, y: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 1, elevation: 0, removed: false },
      { type: "puncher", direction: "up", x: 1, y: 0, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 1, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1 && !move.visualOnly);
  const attachedPuncherMove = result.moves.find((move) => move.actorIndex === 2 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 2]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [2, 1]);
  assert.equal(state.actorRemoved[1], 1);
  assert.equal(state.actorRemoved[2], 1);
  assert.equal(boxMove.toRemoved, true);
  assert.equal(attachedPuncherMove.toRemoved, true);
  assert.equal(attachedPuncherMove.stickyCarrierEntityKey, "weightless:M0");
}

{
  const terrain = floorTerrain(4, 5);
  terrain[4][2] = { type: "wall" };
  const { engine, state } = createState({
    width: 4,
    height: 5,
    terrain,
    actors: [
      { type: "player", x: 0, y: 2, removed: false },
      { type: "box", x: 2, y: 1, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 2, elevation: 0, removed: false },
      { type: "box", x: 1, y: 2, elevation: 0, removed: false },
      { type: "puncher", direction: "up", x: 1, y: 1, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const upperBoxMove = result.moves.find((move) => move.actorIndex === 1 && !move.visualOnly);
  const lowerBoxMove = result.moves.find((move) => move.actorIndex === 3 && !move.visualOnly);
  const downPuncherMove = result.moves.find((move) => move.actorIndex === 2 && !move.visualOnly);
  const upPuncherMove = result.moves.find((move) => move.actorIndex === 4 && !move.visualOnly);
  const downPuncherVisualMove = result.moves.find((move) => move.actorIndex === 2 && move.visualOnly);
  const upPuncherVisualMove = result.moves.find((move) => move.actorIndex === 4 && move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.deepEqual([state.actorX[3], state.actorY[3]], [2, 3]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [2, 1]);
  assert.deepEqual([state.actorX[4], state.actorY[4]], [2, 2]);
  assert.equal(upperBoxMove.punchSlide, true);
  assert.equal(lowerBoxMove.punchSlide, true);
  assert.equal(downPuncherMove.stickyCarrierEntityKey, "actor:1");
  assert.equal(upPuncherMove.stickyCarrierEntityKey, "actor:3");
  assert.deepEqual(
    {
      toX: downPuncherVisualMove.toX,
      toY: downPuncherVisualMove.toY,
      finalX: downPuncherVisualMove.finalX,
      finalY: downPuncherVisualMove.finalY,
      punchSequence: downPuncherVisualMove.punchSequence
    },
    { toX: 2, toY: 2, finalX: 2, finalY: 1, punchSequence: 0 }
  );
  assert.deepEqual(
    {
      toX: upPuncherVisualMove.toX,
      toY: upPuncherVisualMove.toY,
      finalX: upPuncherVisualMove.finalX,
      finalY: upPuncherVisualMove.finalY,
      punchSequence: upPuncherVisualMove.punchSequence
    },
    { toX: 2, toY: 1, finalX: 2, finalY: 2, punchSequence: 0 }
  );
}

{
  const terrain = floorTerrain(7, 6);
  terrain[5][2] = { type: "wall" };
  terrain[5][3] = { type: "wall" };
  terrain[5][4] = { type: "wall" };
  const { engine, state } = createState({
    width: 7,
    height: 6,
    terrain,
    actors: [
      { type: "player", x: 0, y: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 4, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 4, y: 1, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 4, y: 2, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 2, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 1, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M1", x: 1, y: 1, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M1", x: 2, y: 1, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 2, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const m0Moves = result.moves.filter(
    (move) => move.actorType === "weightless_box" && [1, 2, 3, 4, 5, 6].includes(move.actorIndex)
  );
  const m1Moves = result.moves.filter(
    (move) => move.actorType === "weightless_box" && [8, 9].includes(move.actorIndex)
  );

  assert.equal(result.moved, true);
  assert.deepEqual(
    [state.actorX[1], state.actorY[1], state.actorX[6], state.actorY[6]],
    [2, 2, 3, 4]
  );
  assert.deepEqual(
    [state.actorX[8], state.actorY[8], state.actorX[9], state.actorY[9]],
    [2, 3, 3, 3]
  );
  assert.deepEqual([state.actorX[7], state.actorY[7]], [2, 3]);
  assert.deepEqual([state.actorX[10], state.actorY[10]], [3, 4]);
  assert.equal(m0Moves.every((move) => move.punchSlide === true), true);
  assert.equal(m1Moves.every((move) => move.punchSlide === true), true);
}

{
  const terrain = floorTerrain(7, 1);
  terrain[0][6] = { type: "wall" };
  const { engine, state } = createState({
    width: 7,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "puncher", direction: "right", x: 1, y: 0, elevation: 0, removed: false },
      { type: "box", x: 2, y: 0, elevation: 0, removed: false },
      { type: "box", x: 3, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [4, 0]);
  assert.deepEqual([state.actorX[3], state.actorY[3]], [5, 0]);
  assert.equal(
    [0, 2, 3].every((actorIndex) =>
      result.moves.some((move) => move.actorIndex === actorIndex && move.punchSlide === true)
    ),
    true
  );
}

{
  const terrain = floorTerrain(7, 2);
  terrain[0][6] = { type: "wall" };
  terrain[1][6] = { type: "wall" };
  const { engine, state } = createState({
    width: 7,
    height: 2,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "puncher", direction: "right", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 1, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M1", x: 3, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [4, 0]);
  assert.deepEqual([state.actorX[3], state.actorY[3]], [4, 1]);
  assert.deepEqual([state.actorX[4], state.actorY[4]], [5, 0]);
  assert.equal(
    [0, 2, 3, 4].every((actorIndex) =>
      result.moves.some((move) => move.actorIndex === actorIndex && move.punchSlide === true)
    ),
    true
  );
}

{
  const terrain = floorTerrain(5, 1);
  terrain[0][0] = wallStack(1);
  terrain[0][1] = wallStack(1);
  terrain[0][2] = wallStack(1);
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 2, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [2, 0, 1]);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [3, 0, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2], state.actorElevation[2]], [3, 0, 1]);
}

{
  const terrain = floorTerrain(4, 2);
  terrain[0][0] = iceBlockLayer(0);
  terrain[1][0] = iceBlockLayer(0);
  const { engine, state } = createState({
    width: 4,
    height: 2,
    terrain,
    actors: [
      { type: "player", x: 0, y: 1, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 1, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 1, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [1, 0, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2], state.actorElevation[2]], [2, 0, 0]);
  assert.deepEqual([state.actorX[3], state.actorY[3], state.actorElevation[3]], [2, 1, 0]);
  assert.equal(result.moves.some((move) => move.actorIndex === 0 && move.iceSlipOff), true);
}

{
  const terrain = [[
    iceFloorLayer(0),
    iceFloorLayer(0),
    iceFloorLayer(0),
    iceSlopeLayer("left", 0),
    { type: "floor" }
  ]];
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorElevation[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorElevation[1]], [2, 0]);
  assert.deepEqual([state.actorX[2], state.actorElevation[2]], [2, 1]);
  assert.equal(
    result.moves.some((move) => Array.isArray(move.path) && move.path.some((point) => point.elevation < 0)),
    false
  );
}

{
  const terrain = [[
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceSlopeLayer("left", 1),
    { type: "floor" }
  ]];
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 2, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorElevation[0]], [1, 1]);
  assert.deepEqual([state.actorX[1], state.actorElevation[1]], [2, 1]);
  assert.deepEqual([state.actorX[2], state.actorElevation[2]], [2, 2]);
}

{
  const terrain = Array.from({ length: 10 }, (_, y) =>
    Array.from({ length: 2 }, () => (y === 9 ? wallStack(1) : iceFloorLayer(0)))
  );
  const actors = [
    { type: "weightless_box", groupId: "M0", x: 0, y: 1, elevation: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 1, y: 1, elevation: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 0, y: 2, elevation: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 0, y: 3, elevation: 0, removed: false },
    { type: "player", x: 1, y: 3, elevation: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 0, y: 4, elevation: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 1, y: 4, elevation: 0, removed: false }
  ];
  const { engine, state } = createState({
    width: 2,
    height: 10,
    terrain,
    actors
  });

  const result = engine.move(state, 0, 1);
  const playerMove = result.moves.find((move) => move.actorIndex === 4);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[4], state.actorY[4], state.actorElevation[4]], [1, 7, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [1, 5, 0]);
  assert.deepEqual([state.actorX[6], state.actorY[6], state.actorElevation[6]], [1, 8, 0]);
  assert.equal(playerMove.iceSlide, true);
  assert.deepEqual(playerMove.path, [
    { x: 1, y: 3, elevation: 0 },
    { x: 1, y: 4, elevation: 0 },
    { x: 1, y: 5, elevation: 0 },
    { x: 1, y: 6, elevation: 0 },
    { x: 1, y: 7, elevation: 0 }
  ]);
  assert.ok(
    result.moves.some(
      (move) =>
        move.actorType === "weightless_box" &&
        Array.isArray(move.path) &&
        move.path.slice(1).some((point) => point.x === 1 && point.y === 4 && point.elevation === 0)
    )
  );
}

{
  const terrain = [[
    { type: "floor" },
    { type: "floor" },
    iceFloorLayer(0),
    iceFloorLayer(0),
    wallStack(1)
  ]];
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "box", x: 1, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const playerMove = result.moves.find((move) => move.actorIndex === 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [3, 0, 0]);
  assert.equal(playerMove.iceSlide, false);
  assert.equal(boxMove.iceSlide, true);
}

{
  const terrain = [[wallStack(1), wallStack(1), wallStack(1), wallStack(1), wallStack(1)]];
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 2, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, 2]);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [1, 0, 1]);
  assert.deepEqual([state.actorX[4], state.actorY[4], state.actorElevation[4]], [2, 0, 2]);
}

{
  const terrain = [[wallStack(1), wallStack(1), wallStack(1), wallStack(1)]];
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [0, 0, 2]);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [0, 0, 1]);
}

{
  const terrain = floorTerrain(5, 1);
  terrain[0][2] = { type: "hole" };
  terrain[0][3] = { type: "hole" };
  terrain[0][4] = { type: "hole" };
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M1", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M2", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M2", x: 2, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M1", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual(Array.from(state.actorRemoved).slice(1), [1, 1, 1, 1]);
  assert.deepEqual(Array.from(state.actorElevation).slice(1), [-1, 0, -1, 0]);
  assert.equal(boxMoves.length, 4);
  assert.equal(boxMoves.every((move) => move.toRemoved === true), true);
}

{
  const terrain = [[{ type: "floor" }, { type: "hole" }, { type: "hole" }]];
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const playerMove = result.moves.find((move) => move.actorIndex === 0);

  assert.equal(result.moved, true);
  assert.equal(state.actorRemoved[0], 1);
  assert.equal(playerMove.toRemoved, true);
}

{
  const terrain = [[{ type: "floor" }, { type: "floor" }, { type: "hole" }, { type: "hole" }]];
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "puncher", direction: "right", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 0, removed: false },
      { type: "box", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const riderMove = result.moves.find((move) => move.actorIndex === 3);

  assert.equal(result.moved, true);
  assert.equal(state.actorRemoved[3], 1);
  assert.equal(riderMove.fromElevation, 1);
  assert.equal(riderMove.toElevation, 0);
  assert.equal(riderMove.toRemoved, true);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][2] = { type: "hole" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 2, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, 0]);
  assert.deepEqual(Array.from(state.actorRemoved), [0, 1, 1, 1]);
  assert.deepEqual(
    Array.from(state.actorX).slice(1).map((x, index) => [x, state.actorElevation[index + 1]]),
    [
      [2, -2],
      [2, -1],
      [2, 0]
    ]
  );
  assert.deepEqual(
    boxMoves.map((move) => [move.fromElevation, move.toElevation, move.toRemoved]),
    [
      [0, -2, true],
      [1, -1, true],
      [2, 0, true]
    ]
  );
}

{
  const terrain = [[{ type: "floor" }, { type: "floor" }, { type: "floor" }, { type: "hole" }, { type: "floor" }]];
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M1", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M2", x: 2, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M2", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, 0]);
  assert.deepEqual(
    Array.from(state.actorX).slice(1).map((x, index) => [
      x,
      state.actorElevation[index + 1],
      state.actorRemoved[index + 1]
    ]),
    [
      [2, 0, 0],
      [3, -1, 1],
      [3, 0, 1]
    ]
  );
  assert.deepEqual(
    boxMoves.map((move) => [move.actorIndex, move.fromElevation, move.toElevation, move.toRemoved]),
    [
      [1, 0, 0, false],
      [2, 0, -1, true],
      [3, 1, 0, true]
    ]
  );
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][2] = { type: "hole" };
  terrain[0][3] = wallStack(1);
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 2, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual(Array.from(state.actorRemoved), [0, 0, 0, 0, 0]);
  assert.deepEqual(
    Array.from(state.actorX).slice(1).map((x, index) => [x, state.actorElevation[index + 1]]),
    [
      [2, -1],
      [2, 0],
      [2, 1],
      [3, 1]
    ]
  );
  assert.equal(boxMoves.every((move) => move.toRemoved === false), true);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][2] = { type: "hole" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: -1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, 0]);
  assert.deepEqual(
    Array.from(state.actorX).slice(1).map((x, index) => [x, state.actorElevation[index + 1]]),
    [
      [2, -1],
      [2, 0],
      [2, 1]
    ]
  );
}

{
  const terrain = [[wallStack(1), wallStack(1), { type: "floor" }, { type: "floor" }]];
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 2, removed: false }
    ]
  });

  const pushResult = engine.move(state, 1, 0);

  assert.equal(pushResult.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, 1]);
  assert.deepEqual(
    Array.from(state.actorX).slice(1).map((x, index) => [x, state.actorElevation[index + 1]]),
    [
      [1, 2],
      [2, 1],
      [2, 2]
    ]
  );

  const leaveResult = engine.move(state, -1, 0);

  assert.equal(leaveResult.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [0, 0, 1]);
  assert.deepEqual(
    Array.from(state.actorX).slice(1).map((x, index) => [x, state.actorElevation[index + 1]]),
    [
      [1, 1],
      [2, 0],
      [2, 1]
    ]
  );
}

{
  const terrain = [[{ type: "floor" }, { type: "floor" }, { type: "hole" }, { type: "floor" }]];
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const pushResult = engine.move(state, 1, 0);

  assert.equal(pushResult.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, 0]);
  assert.deepEqual(
    Array.from(state.actorX).slice(1).map((x, index) => [x, state.actorElevation[index + 1]]),
    [
      [1, 1],
      [2, 0],
      [2, 1]
    ]
  );
  assert.equal(
    pushResult.moves
      .filter((move) => move.actorType === "weightless_box")
      .some((move) => move.iceSlide === true),
    false
  );

  const leaveResult = engine.move(state, -1, 0);

  assert.equal(leaveResult.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [0, 0, 0]);
  assert.deepEqual(
    Array.from(state.actorX).slice(1).map((x, index) => [x, state.actorElevation[index + 1]]),
    [
      [1, 0],
      [2, -1],
      [2, 0]
    ]
  );
}

{
  const terrain = [[{ type: "floor" }, { type: "hole" }, { type: "floor" }]];
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: -1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, 0]);
  assert.equal(state.actorRemoved[0], 0);
}

{
  const terrain = [[
    { type: "hole" },
    { type: "hole" },
    { type: "hole" },
    { type: "hole" },
    { type: "floor" },
    { type: "floor" }
  ]];
  const { engine, state } = createState({
    width: 6,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: -1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: -2, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: -1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 4, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, -1]);
  assert.deepEqual(
    Array.from(state.actorX).slice(1).map((x, index) => [x, state.actorElevation[index + 1]]),
    [
      [1, -2],
      [2, -1],
      [5, 0]
    ]
  );
  assert.equal(state.actorRemoved[0], 0);
  assert.equal(result.moves.filter((move) => move.actorType === "weightless_box").length, 3);
}

[
  {
    actor: { type: "box", x: 2, y: 0, elevation: 1, removed: false },
    expectedTerrain: terrainTypes.hole
  },
  {
    actor: { type: "floating_floor", x: 2, y: 0, elevation: 1, removed: false },
    expectedTerrain: terrainTypes.floor
  },
  {
    actor: { type: "clone", groupId: "c0", x: 2, y: 0, elevation: 1, removed: false },
    expectedTerrain: terrainTypes.hole
  }
].forEach(({ actor, expectedTerrain }) => {
  const terrain = [[{ type: "floor" }, { type: "floor" }, { type: "hole" }]];
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      actor
    ]
  });

  const result = engine.move(state, 1, 0);
  const riderMove = result.moves.find((move) => move.actorIndex === 2);

  assert.equal(result.moved, true);
  assert.equal(state.actorRemoved[1], 1);
  assert.equal(state.actorRemoved[2], 1);
  assert.equal(riderMove.toElevation, 0);
  assert.equal(riderMove.toRemoved, true);
  assert.equal(state.terrain[engine.cellIndex(2, 0)], expectedTerrain);
});

[
  {
    bottom: { type: "clone", groupId: "c0", x: 2, y: 0, elevation: 1, removed: false },
    top: { type: "clone", groupId: "c1", x: 2, y: 0, elevation: 2, removed: false }
  },
  {
    bottom: { type: "clone", groupId: "c0", x: 2, y: 0, elevation: 1, removed: false },
    top: { type: "circle_player", x: 2, y: 0, elevation: 2, removed: false }
  },
  {
    bottom: { type: "circle_player", x: 2, y: 0, elevation: 1, removed: false },
    top: { type: "clone", groupId: "c0", x: 2, y: 0, elevation: 2, removed: false }
  }
].forEach(({ bottom, top }) => {
  const terrain = [[{ type: "floor" }, { type: "floor" }, { type: "hole" }, wallStack(3)]];
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      bottom,
      top
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.equal(state.actorRemoved[1], 1);
  assert.equal(state.actorRemoved[2], 1);
  assert.equal(state.actorRemoved[3], 1);
  assert.equal(result.moves.find((move) => move.actorIndex === 2).toRemoved, true);
  assert.equal(result.moves.find((move) => move.actorIndex === 3).toRemoved, true);
});

{
  const terrain = [[{ type: "floor" }, { type: "hole" }]];
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "box", x: 1, y: 0, elevation: 5, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, 0]);
  assert.equal(state.actorRemoved[0], 1);
  assert.equal(result.moves[0].toRemoved, true);
}

{
  const terrain = [[{ type: "floor" }, wallStack(1, 5)]];
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, 0]);
  assert.equal(state.actorRemoved[0], 1);
  assert.equal(result.moves[0].toRemoved, true);
}

{
  const terrain = [Array.from({ length: 9 }, (_, x) => (x <= 4 ? wallStack(1) : { type: "floor" }))];
  const { engine, state } = createState({
    width: 9,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 2, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M1", x: 3, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M1", x: 4, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M1", x: 3, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M2", x: 4, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M2", x: 5, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M1", x: 3, y: 0, elevation: 3, removed: false },
      { type: "weightless_box", groupId: "M1", x: 4, y: 0, elevation: 3, removed: false },
      { type: "weightless_box", groupId: "M2", x: 5, y: 0, elevation: 3, removed: false }
    ]
  });

  assert.equal(engine.move(state, 1, 0).moved, true);
  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual(Array.from(state.actorRemoved).slice(1), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    Array.from(state.actorElevation).slice(1),
    [0, 0, 1, 1, 1, 2, 2, 2]
  );
  assert.equal(boxMoves.every((move) => move.toRemoved === false), true);
  assert.equal(boxMoves.every((move) => move.toElevation === move.fromElevation - 1), true);
}

console.log("maze-engine tests passed");

// Owner rule (2026-07): exposed floor/ice/ice-block surfaces do not rail the
// board edge for MAIN PLAYERS when edge falls are enabled (options.edgeFalls
// per move, or playData.edgeFalls per level). Pushables are always railed,
// and the default stays railed for compatibility.
{
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain: floorTerrain(2, 1),
    actors: [{ type: "player", x: 1, y: 0, removed: false }]
  });

  const blocked = engine.move(engine.cloneState(state), 1, 0);
  assert.equal(blocked.moved, false);

  const result = engine.move(state, 1, 0, { edgeFalls: true });
  assert.equal(result.moved, true);
  assert.equal(state.actorRemoved[0], 1);
  const playerMove = result.moves.find((move) => move.actorIndex === 0);
  assert.equal(playerMove.edgeFall, true);
  assert.equal(playerMove.toRemoved, true);
  assert.deepEqual([playerMove.toX, playerMove.toY], [1, 0]);
  assert.equal(playerMove.edgeFallDx, 1);
}

{
  // Ice carries the slide off the edge.
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[{ type: "floor" }, iceFloorLayer(0), iceFloorLayer(0)]],
    actors: [{ type: "player", x: 0, y: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0, { edgeFalls: true });
  assert.equal(result.moved, true);
  assert.equal(state.actorRemoved[0], 1);
}

{
  // Boxes stay railed at the edge even with edge falls enabled.
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain: floorTerrain(2, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 1, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0, { edgeFalls: true });
  assert.equal(result.moved, false);
  assert.equal(state.actorRemoved[1], 0);
}

{
  // playData.edgeFalls annotation drives both modes identically, and the
  // journal undo restores the fall exactly.
  const engine = createEngine({
    width: 2,
    height: 1,
    terrain: floorTerrain(2, 1),
    actors: [{ type: "player", x: 1, y: 0, removed: false }],
    edgeFalls: true
  });
  const state = engine.cloneState(engine.initialState);
  const keyBefore = engine.stateKey(state);
  const result = engine.moveForSearch(state, 1, 0);

  assert.equal(result.moved, true);
  assert.equal(state.actorRemoved[0], 1);

  engine.undoMove(state, result);
  assert.equal(engine.stateKey(state), keyBefore);
  assert.equal(state.actorRemoved[0], 0);
}

// Owner rules (2026-07): punchers ride carriers — side-mounted on clones
// (sticky carrier) and standing on any carrier's top surface — and the
// orange ice slope raises/lowers with the orange buttons.
{
  // Puncher standing ON TOP of a weightless box rides its push.
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: floorTerrain(4, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "puncher", direction: "right", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.deepEqual(
    [state.actorX[2], state.actorY[2], state.actorElevation[2]],
    [2, 0, 1]
  );
}

{
  // Puncher side-mounted on a clone rides the clone's move.
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain: floorTerrain(5, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "clone", groupId: "c0", x: 2, y: 0, removed: false },
      { type: "puncher", direction: "right", x: 3, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [3, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [4, 0]);
}

{
  // Orange ice slopes are ramps while raised, in both directions.
  const terrain = floorTerrain(4, 1);
  terrain[0][1] = {
    type: "orange_ice_slope",
    layers: [{ type: "orange_ice_slope", elevation: 0, direction: "right" }]
  };
  terrain[0][2] = { type: "wall", layers: [{ type: "wall", elevation: 0 }] };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [{ type: "player", x: 0, y: 0, removed: false }]
  });

  engine.move(state, 1, 0);
  assert.deepEqual([state.actorX[0], state.actorElevation[0]], [2, 1]);

  engine.move(state, -1, 0);
  assert.deepEqual([state.actorX[0], state.actorElevation[0]], [0, 0]);
}

{
  // Clones use the same raised orange-ramp traversal in both directions.
  const terrain = floorTerrain(4, 2);
  terrain[1][1] = {
    type: "orange_ice_slope",
    layers: [{ type: "orange_ice_slope", elevation: 0, direction: "right" }]
  };
  terrain[1][2] = wallStack(1);
  const { engine, state } = createState({
    width: 4,
    height: 2,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "clone", groupId: "c0", x: 0, y: 1, removed: false }
    ]
  });

  engine.move(state, 1, 0);
  assert.deepEqual([state.actorX[1], state.actorElevation[1]], [2, 1]);

  engine.move(state, -1, 0);
  assert.deepEqual([state.actorX[1], state.actorElevation[1]], [0, 0]);
}

{
  // A ground-level orange slope flattens when the orange terrain lowers.
  const terrain = floorTerrain(4, 2);
  terrain[0][1] = {
    type: "orange_ice_slope",
    layers: [{ type: "orange_ice_slope", elevation: 0, direction: "right" }]
  };
  terrain[0][2] = { type: "wall", layers: [{ type: "wall", elevation: 0 }] };
  const { engine, state } = createState({
    width: 4,
    height: 2,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 2, y: 1, removed: false },
      { type: "orange_button", x: 2, y: 1, removed: false }
    ]
  });

  assert.equal(engine.areOrangeButtonsPressed(state), true);
  engine.move(state, 1, 0);
  assert.deepEqual(
    [state.actorX[0], state.actorElevation[0]],
    [1, 0],
    "the lowered wedge is a flat surface, not an active ramp"
  );
}

{
  // An unsupported elevated orange slope lowers by one full elevation and
  // remains a ramp at its new height.
  const terrain = floorTerrain(4, 2);
  terrain[0][1] = {
    type: "orange_ice_slope",
    layers: [{ type: "orange_ice_slope", elevation: 1, direction: "right" }]
  };
  terrain[0][2] = wallStack(1);
  const { engine, state } = createState({
    width: 4,
    height: 2,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 2, y: 1, removed: false },
      { type: "orange_button", x: 2, y: 1, removed: false }
    ]
  });

  engine.move(state, 1, 0);
  assert.deepEqual([state.actorX[0], state.actorElevation[0]], [2, 1]);
}

{
  // Non-orange support below a lowered orange slope also flattens it in
  // place instead of allowing the wedge to sink into the support.
  const terrain = floorTerrain(4, 2);
  terrain[0][0] = wallStack(1);
  terrain[0][1] = {
    type: "orange_ice_slope",
    layers: [
      { type: "wall", elevation: 0 },
      { type: "orange_ice_slope", elevation: 1, direction: "right" }
    ]
  };
  terrain[0][2] = wallStack(2);
  const { engine, state } = createState({
    width: 4,
    height: 2,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "box", x: 2, y: 1, removed: false },
      { type: "orange_button", x: 2, y: 1, removed: false }
    ]
  });

  engine.move(state, 1, 0);
  assert.deepEqual([state.actorX[0], state.actorElevation[0]], [1, 1]);
}

// Owner rule (2026-07 rework): Box/Clone Ice Slopes are slope-SHAPED members
// of their groups — they push and mirror with the group, and other actors
// traverse them like ice slopes when approaching along the slope axis.
{
  const { engine, state } = createState({
    width: 6,
    height: 1,
    terrain: floorTerrain(6, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, shape: "slope", direction: "right", removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorX[2]], [2, 3]);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][3] = { type: "wall", layers: [{ type: "wall", elevation: 0 }] };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 1, y: 0, removed: false },
      { type: "weightless_box", groupId: "M3", x: 2, y: 0, shape: "slope", direction: "right", removed: false }
    ]
  });

  const keyBefore = engine.stateKey(engine.cloneState(state));
  const result = engine.moveForSearch(state, 1, 0);
  assert.equal(result.moved, true);
  assert.deepEqual(
    [state.actorX[0], state.actorElevation[0]],
    [3, 1],
    "player climbs the box ice slope onto the wall top"
  );
  assert.deepEqual([state.actorX[1], state.actorElevation[1]], [2, 0], "slope member did not move");
  engine.undoMove(state, result);
  assert.equal(engine.stateKey(state), keyBefore);
}

for (const ownerType of ["weightless_box", "clone"]) {
  // level_AxA regression: a slope-shaped group member occupies the same
  // voxel that begins its inclined face. Chaining two owned wedges therefore
  // puts the second wedge at the first wedge's exit. That wedge is the next
  // ramp, not a solid actor blocking the chain.
  const terrain = floorTerrain(2, 4);
  terrain[0][0] = wallStack(2);
  terrain[3][1] = wallStack(1);
  const groupId = ownerType === "clone" ? "c7" : "M7";
  const { engine, state } = createState({
    width: 2,
    height: 4,
    terrain,
    actors: [
      { type: "player", x: 0, y: 3, removed: false },
      {
        type: ownerType,
        groupId,
        shape: "slope",
        direction: "up",
        x: 0,
        y: 2,
        elevation: 0,
        removed: false
      },
      { type: ownerType, groupId, x: 0, y: 1, elevation: 0, removed: false },
      {
        type: ownerType,
        groupId,
        shape: "slope",
        direction: "up",
        x: 0,
        y: 1,
        elevation: 1,
        removed: false
      },
      // Clone-owned ramps mirror the input before the main player moves.
      // This foreign member makes the c7 structure stationary on the down
      // action, matching the conditions under which another actor can use it.
      ...(ownerType === "clone"
        ? [{ type: ownerType, groupId, x: 1, y: 2, elevation: 0, removed: false }]
        : [])
    ]
  });

  const result = engine.move(state, 0, -1);

  assert.equal(result.moved, true);
  assert.deepEqual(
    [state.actorX[0], state.actorY[0], state.actorElevation[0]],
    [0, 0, 2],
    `player slides through a connected ${ownerType} ice-slope chain`
  );
  assert.deepEqual(
    result.moves.find((move) => move.actorIndex === 0)?.path,
    [
      { x: 0, y: 3, elevation: 0 },
      { x: 0, y: 2, elevation: 1 },
      { x: 0, y: 1, elevation: 2 },
      { x: 0, y: 0, elevation: 2 }
    ],
    `${ownerType} wedges use the normal connected-ramp path`
  );

  const descent = engine.move(state, 0, 1);
  const descentMove = descent.moves.find((move) => move.actorIndex === 0);

  assert.equal(descent.moved, true);
  assert.deepEqual(
    [state.actorX[0], state.actorY[0], state.actorElevation[0]],
    [0, 3, 0],
    `player slides back down a connected ${ownerType} ice-slope chain`
  );
  assert.deepEqual(
    descentMove?.path,
    [
      { x: 0, y: 0, elevation: 2 },
      { x: 0, y: 1, elevation: 2 },
      { x: 0, y: 2, elevation: 1 },
      { x: 0, y: 3, elevation: 0 }
    ],
    `${ownerType} wedges use the normal connected-ramp descent path`
  );
  assert.notEqual(
    descentMove?.iceSlipOff,
    true,
    `${ownerType} descent exits the ramp instead of falling through its bottom`
  );
}

{
  // level_AxA regression: two adjacent Box slopes at the same elevation
  // behave like two adjacent terrain slopes. The upper collision band of the
  // second wedge blocks the first wedge's exit, so the player bounces home;
  // it must not settle underneath and lift the connected group into the air.
  const terrain = floorTerrain(1, 4);
  terrain[3][0] = iceFloorLayer(0);
  const { engine, state } = createState({
    width: 1,
    height: 4,
    terrain,
    actors: [
      { type: "player", x: 0, y: 3, elevation: 0, removed: false },
      {
        type: "weightless_box",
        groupId: "M1",
        shape: "slope",
        direction: "up",
        x: 0,
        y: 2,
        elevation: 0,
        removed: false
      },
      {
        type: "weightless_box",
        groupId: "M1",
        shape: "slope",
        direction: "up",
        x: 0,
        y: 1,
        elevation: 0,
        removed: false
      }
    ]
  });

  const result = engine.move(state, 0, -1);

  assert.equal(result.moved, false);
  assert.deepEqual(
    [state.actorX[0], state.actorY[0], state.actorElevation[0]],
    [0, 3, 0],
    "player bounces home from adjacent same-height box slopes"
  );
  assert.deepEqual(
    [
      [state.actorY[1], state.actorElevation[1]],
      [state.actorY[2], state.actorElevation[2]]
    ],
    [[2, 0], [1, 0]],
    "connected box slopes keep their authored positions and elevations"
  );
}

{
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain: floorTerrain(5, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "clone", groupId: "c1", x: 2, y: 0, shape: "slope", direction: "right", removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [3, 0], "clone ice slope mirrors the player");
}

// Owner rule (2026-07): lifts/gates stacked on movable carriers are STUCK
// rider fixtures — they travel with the carrier (horizontally on boxes and
// clones, vertically on orange walls) and interact with nothing.
{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: floorTerrain(4, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
      { type: "attached_lift", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorX[2], state.actorElevation[2]], [2, 2, 1]);
  assert.equal(result.liftToggles.length, 0, "attached lift never toggles");
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][1] = {
    type: "orange_wall",
    layers: [
      { type: "floor", elevation: 0 },
      { type: "orange_wall", elevation: 0 }
    ]
  };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 3, y: 0, removed: false },
      { type: "attached_lift", x: 1, y: 0, elevation: 1, removed: false },
      { type: "orange_button", x: 2, y: 0, removed: false }
    ]
  });

  engine.move(state, -1, 0);
  assert.equal(state.actorElevation[1], 0, "rides the lowering orange wall");
  engine.move(state, 1, 0);
  assert.equal(state.actorElevation[1], 1, "rides the wall back up");
}

{
  // Owner rule (2026-07, functional round): an attached gate is a working
  // player gate — proximity raises it and the raised panel blocks the
  // player, exactly like the terrain twin.
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: floorTerrain(3, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "attached_gate", x: 1, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  assert.equal(result.moved, false, "proximity-raised attached gate blocks the player");
  assert.equal(state.actorX[0], 0);
}

for (const landingType of ["player", "clone"]) {
  // Forced motion can land a player/clone directly on a lowered attached
  // gate without first entering its one-cell proximity trigger. The landing
  // must raise the gate and carry the rider to the new surface.
  const terrain = landingType === "clone"
    ? [[iceFloorLayer(1), iceFloorLayer(1), iceFloorLayer(1), { type: "floor" }, wallStack(2)]]
    : [[wallStack(1), wallStack(1), wallStack(1), { type: "floor" }, wallStack(2)]];
  const landingActor = {
    type: landingType,
    x: 0,
    y: 0,
    elevation: 1,
    removed: false
  };

  if (landingType === "clone") {
    landingActor.groupId = "c0";
  }

  const deviceActors = [
    { type: "weightless_box", groupId: "M0", x: 3, y: 0, elevation: 0, removed: false },
    { type: "attached_gate", x: 3, y: 0, elevation: 1, removed: false }
  ];
  const actors = landingType === "clone"
    ? [landingActor, ...deviceActors]
    : [
        landingActor,
        { type: "puncher", direction: "right", x: 1, y: 0, elevation: 1, removed: false },
        ...deviceActors
      ];
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors
  });

  const result = engine.move(state, 1, 0);
  const landingMove = result.moves.find((move) => move.actorIndex === 0);

  assert.equal(result.moved, true);
  assert.equal(
    engine.computeRaisedPlayerGateSet(state).has(engine.cellIndex(3, 0)),
    true,
    `${landingType} standing on an attached gate raises it`
  );
  assert.deepEqual(
    [state.actorX[0], state.actorElevation[0]],
    [3, 2],
    `${landingType} rides the attached gate up`
  );
  assert.deepEqual(
    [landingMove.fromElevation, landingMove.toElevation],
    [1, 2],
    `${landingType} move record includes the gate ride`
  );
}

// Owner bug (2026-07): play mode replays MOVE RECORDS onto its runtime
// actors, so a vertical device ride that only touches the journal leaves the
// visible board desynced (orange button hovering above its lowered wall).
// Every net elevation change from the dynamic sync must emit a record.
{
  const terrain = floorTerrain(5, 1);
  terrain[0][2] = {
    type: "orange_wall",
    layers: [
      { type: "floor", elevation: 0 },
      { type: "orange_wall", elevation: 0 }
    ]
  };
  terrain[0][3] = {
    type: "orange_wall",
    layers: [
      { type: "floor", elevation: 0 },
      { type: "orange_wall", elevation: 0 }
    ]
  };
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "orange_button", x: 1, y: 0, removed: false },
      { type: "orange_button", x: 2, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M9", x: 2, y: 0, elevation: 1, removed: false },
      { type: "attached_lift", x: 3, y: 0, elevation: 1, removed: false }
    ]
  });

  // Box parked on the wall-top button keeps it pressed; stepping onto the
  // ground button completes the AND — walls lower, riders descend.
  const lower = engine.move(state, 1, 0);
  assert.equal(state.actorElevation[2], 0, "rider button descends with its wall");
  assert.equal(state.actorElevation[4], 0, "attached lift descends with its wall");

  const riderButtonMove = lower.moves.find((move) => move.actorIndex === 2);
  const attachedLiftMove = lower.moves.find((move) => move.actorIndex === 4);
  assert.ok(riderButtonMove, "rider button ride emits a move record");
  assert.deepEqual(
    [riderButtonMove.fromElevation, riderButtonMove.toElevation],
    [1, 0],
    "rider button record captures the descent"
  );
  assert.ok(attachedLiftMove, "attached lift ride emits a move record");
  assert.deepEqual(
    [attachedLiftMove.fromElevation, attachedLiftMove.toElevation],
    [1, 0],
    "attached lift record captures the descent"
  );
  assert.ok(
    !lower.moves.some((move) => move.actorIndex === 1),
    "unmoved ground button gets no record"
  );

  // Stepping back off releases the AND — walls raise, riders ride up, again
  // with records.
  const raise = engine.move(state, -1, 0);
  assert.equal(state.actorElevation[2], 1, "rider button rides the wall back up");
  assert.equal(state.actorElevation[4], 1, "attached lift rides the wall back up");
  assert.ok(
    raise.moves.some(
      (move) => move.actorIndex === 2 && move.fromElevation === 0 && move.toElevation === 1
    ),
    "raise direction emits a record too"
  );
}

{
  // A wall-top button must ride down with the player pressing it. The player
  // is not support for the fixture; otherwise the button hovers at elevation
  // one, becomes unpressed, and immediately raises the orange terrain again.
  const terrain = floorTerrain(3, 1);
  terrain[0][1] = {
    type: "orange_wall",
    layers: [
      { type: "floor", elevation: 0 },
      { type: "orange_wall", elevation: 0 }
    ]
  };
  terrain[0][2] = wallStack(1);
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 2, y: 0, elevation: 1, removed: false },
      { type: "orange_button", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const lower = engine.move(state, -1, 0);

  assert.equal(engine.areOrangeButtonsPressed(state), true);
  assert.deepEqual(
    [state.actorElevation[0], state.actorElevation[1]],
    [0, 0],
    "player and button remain together on the lowered orange wall"
  );
  assert.ok(
    lower.moves.some(
      (move) => move.actorIndex === 1 && move.fromElevation === 1 && move.toElevation === 0
    ),
    "the button descent is replayable by play mode"
  );
}

{
  // Released orange terrain raises per connected component. A rider trapped
  // under a fixed ceiling holds only its own component down; after the rider
  // can leave, that pending component retries and raises automatically.
  const terrain = floorTerrain(7, 1);
  terrain[0][0] = wallStack(1);
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

  const { engine, state } = createState({
    width: 7,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 1, y: 0, elevation: 1, removed: false },
      { type: "player", x: 4, y: 0, removed: false },
      { type: "box", x: 5, y: 0, removed: false },
      { type: "orange_button", x: 4, y: 0, elevation: 0, removed: false }
    ]
  });

  assert.equal(engine.areOrangeButtonsPressed(state), true);
  assert.deepEqual(engine.raisedOrangeWallKeys(state), []);

  const release = engine.move(state, 1, 0);

  assert.equal(release.moved, true);
  assert.equal(engine.areOrangeButtonsPressed(state), false);
  assert.deepEqual(
    engine.raisedOrangeWallKeys(state),
    ["3,0"],
    "the disconnected clear component raises while the ceiling-blocked component stays down"
  );
  assert.deepEqual(
    [state.actorX[0], state.actorElevation[0]],
    [1, 1],
    "the blocked rider remains legally supported on the lowered component"
  );

  state.actorRemoved[1] = 1;
  const clear = engine.move(state, -1, 0);

  assert.equal(clear.moved, true);
  assert.deepEqual(
    [state.actorX[0], state.actorElevation[0]],
    [0, 1],
    "the rider can leave the pending component through valid territory"
  );
  assert.deepEqual(
    engine.raisedOrangeWallKeys(state),
    ["1,0", "3,0"],
    "the pending component raises on the first state change that clears it"
  );
}

// Owner rule (2026-07, functional round): attached lifts WORK. A player
// ending its move on the platform toggles it and rides up; the raised
// platform blocks the band it rose out of; the raised bit rides carrier
// pushes; authored 'L' starts raised.
{
  const terrain = floorTerrain(4, 1);
  terrain[0][0] = {
    type: "wall",
    layers: [
      { type: "floor", elevation: 0 },
      { type: "wall", elevation: 0 }
    ]
  };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
      { type: "attached_lift", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const onto = engine.move(state, 1, 0);
  assert.equal(state.actorElevation[0], 2, "player rides the toggling lift up");
  assert.equal(state.liftRaised[1], 1, "attached lift raised bit set");
  assert.equal(state.actorElevation[2], 1, "lift actor elevation stays at the carrier top");
  assert.deepEqual(onto.liftToggles, [{ x: 1, y: 0, raised: true }]);
}

{
  // A raised attached lift transfers a side push to its carrier.
  const terrain = floorTerrain(3, 1);
  terrain[0][0] = {
    type: "wall",
    layers: [
      { type: "floor", elevation: 0 },
      { type: "wall", elevation: 0 }
    ]
  };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
      { type: "attached_lift", x: 1, y: 0, elevation: 1, raised: true, removed: false }
    ]
  });

  assert.equal(state.liftRaised[1], 1, "authored 'L' starts raised");
  const pushed = engine.move(state, 1, 0);
  assert.equal(pushed.moved, true, "raised attached lift pushes its carrier");
  assert.deepEqual([state.actorX[0], state.actorX[1], state.actorX[2]], [1, 2, 2]);
}

{
  // The raised bit rides carrier pushes; a proximity-raised attached gate
  // rides too and keeps not interacting with its carrier.
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain: floorTerrain(5, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
      { type: "attached_lift", x: 1, y: 0, elevation: 1, raised: true, removed: false },
      { type: "weightless_box", groupId: "M1", x: 3, y: 0, removed: false },
      { type: "attached_gate", x: 3, y: 0, elevation: 1, removed: false }
    ]
  });

  const push = engine.move(state, 1, 0);
  assert.equal(push.moved, true);
  assert.deepEqual(
    [state.actorX[1], state.actorX[2], state.liftRaised[1], state.liftRaised[2]],
    [2, 2, 0, 1],
    "raised bit relocates with the pushed lift"
  );
}

for (const boxType of ["box", "weightless_box"]) {
  for (const riderType of ["player", "clone"]) {
    // A player/clone on a pushed box takes the carrier's step instead of
    // being left unsupported in the box's old cell (or moving twice later
    // in the same global input).
    const rider = {
      type: riderType,
      x: 1,
      y: 0,
      elevation: 1,
      removed: false
    };

    if (riderType === "clone") {
      rider.groupId = "c0";
    }

    const box = {
      type: boxType,
      x: 1,
      y: 0,
      elevation: 0,
      removed: false
    };

    if (boxType === "weightless_box") {
      box.groupId = "M0";
    }

    const { engine, state } = createState({
      width: 5,
      height: 1,
      terrain: floorTerrain(5, 1),
      actors: [
        { type: "player", x: 0, y: 0, removed: false },
        box,
        rider
      ]
    });

    const result = engine.move(state, 1, 0);

    assert.equal(result.moved, true);
    assert.deepEqual(
      [state.actorX[1], state.actorX[2], state.actorElevation[2]],
      [2, 2, 1],
      `${riderType} rides the pushed ${boxType}`
    );
    assert.equal(
      result.moves.filter((move) => move.actorIndex === 2 && !move.visualOnly).length,
      1,
      "carried rider moves exactly once"
    );
  }
}

{
  // A different member of a rigid carrier may move into the rider's current
  // voxel while the rider vacates it with its own support. The collision
  // preflight must treat that swept cell as part of the same transaction.
  const { engine, state } = createState({
    width: 4,
    height: 2,
    terrain: floorTerrain(4, 2),
    actors: [
      { type: "player", x: 0, y: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 1, removed: false },
      { type: "clone", groupId: "c0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "clone", groupId: "c1", x: 2, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, -1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual(
    [
      [state.actorX[1], state.actorY[1], state.actorElevation[1]],
      [state.actorX[2], state.actorY[2], state.actorElevation[2]],
      [state.actorX[3], state.actorY[3], state.actorElevation[3]],
      [state.actorX[4], state.actorY[4], state.actorElevation[4]]
    ],
    [
      [0, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
      [1, 0, 0]
    ],
    "the pushing clone moves the cluster while the other clone rides it"
  );
  assert.equal(
    result.moves.filter((move) => move.actorIndex === 3 && !move.visualOnly).length,
    1,
    "the swept-cell rider moves exactly once"
  );
}

for (const riderType of ["player", "clone"]) {
  // A raised attached lift is the rider's immediate surface, but its
  // underlying pushblock remains the moving carrier.
  const rider = {
    type: riderType,
    x: 1,
    y: 0,
    elevation: 2,
    removed: false
  };

  if (riderType === "clone") {
    rider.groupId = "c1";
  }

  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain: floorTerrain(5, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M1", x: 1, y: 0, elevation: 0, removed: false },
      { type: "attached_lift", x: 1, y: 0, elevation: 1, raised: true, removed: false },
      rider
    ]
  });
  const keyBefore = engine.stateKey(state);
  const result = engine.moveForSearch(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual(
    [state.actorX[1], state.actorX[2], state.actorX[3], state.actorElevation[3]],
    [2, 2, 2, 2],
    `${riderType} stays on the raised lift while its pushblock moves`
  );
  assert.deepEqual(
    [state.liftRaised[1], state.liftRaised[2]],
    [0, 1],
    "raised phase follows the lift and rider"
  );

  engine.undoMove(state, result);
  assert.equal(engine.stateKey(state), keyBefore, "carried lift ride undoes exactly");
}

for (const deviceType of ["attached_lift", "attached_gate"]) {
  // Pushing the raised panel redirects to its pushblock carrier. The pusher
  // advances into the vacated cell in lockstep, then settles to the surface
  // below if the carrier had been its only elevated support there.
  const terrain = floorTerrain(4, 1);
  terrain[0][0] = wallStack(1);
  const device = {
    type: deviceType,
    x: 1,
    y: 0,
    elevation: 1,
    removed: false
  };

  if (deviceType === "attached_lift") {
    device.raised = true;
  }

  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M2", x: 1, y: 0, elevation: 0, removed: false },
      device
    ]
  });
  const keyBefore = engine.stateKey(state);
  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true, `${deviceType} transfers the push to its carrier`);
  assert.deepEqual(
    [state.actorX[0], state.actorElevation[0], state.actorX[1], state.actorX[2]],
    [1, 0, 2, 2],
    `${deviceType}, pushblock, and pusher advance together`
  );

  engine.undoMove(state, result);
  assert.equal(engine.stateKey(state), keyBefore, `${deviceType} carrier push undoes exactly`);
}

for (const initiallyRaised of [false, true]) {
  // Clones interact with ordinary terrain lifts in both directions, using
  // the same enter-and-ride behavior as the main player.
  const terrain = floorTerrain(4, 1);
  terrain[0][0] = initiallyRaised ? wallStack(1) : { type: "floor" };
  terrain[0][1] = playerLiftLayer(0, initiallyRaised);
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      {
        type: "clone",
        groupId: "lift-clone",
        x: 0,
        y: 0,
        elevation: initiallyRaised ? 1 : 0,
        removed: false
      },
      { type: "player", x: 3, y: 0, removed: false }
    ]
  });
  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual(
    [state.actorX[0], state.actorElevation[0], state.liftRaised[1]],
    [1, initiallyRaised ? 0 : 1, initiallyRaised ? 0 : 1],
    `clone ${initiallyRaised ? "lowers" : "raises"} a terrain lift`
  );
  assert.deepEqual(result.liftToggles, [
    { x: 1, y: 0, raised: !initiallyRaised }
  ]);
}

for (const { carrierType, initiallyRaised } of ["weightless_box", "clone", "orange_wall"].flatMap(
  (carrierType) => [false, true].map((initiallyRaised) => ({ carrierType, initiallyRaised }))
)) {
  // Attached lifts remain interactive when their support is a pushblock,
  // another clone group, or a phase-changing orange wall.
  const terrain = floorTerrain(4, 1);
  terrain[0][0] = wallStack(initiallyRaised ? 2 : 1);
  const actors = [
    { type: "player", x: 3, y: 0, removed: false },
    {
      type: "clone",
      groupId: "lift-rider",
      x: 0,
      y: 0,
      elevation: initiallyRaised ? 2 : 1,
      removed: false
    }
  ];

  if (carrierType === "weightless_box") {
    actors.push({
      type: "weightless_box",
      groupId: "lift-box",
      x: 1,
      y: 0,
      elevation: 0,
      removed: false
    });
  } else if (carrierType === "clone") {
    // Keep the carrier clone stationary under the shared right input so the
    // other clone can enter its attached lift.
    terrain[0][2] = wallStack(1);
    actors.push({
      type: "clone",
      groupId: "lift-carrier",
      x: 1,
      y: 0,
      elevation: 0,
      removed: false
    });
  } else {
    terrain[0][1] = orangeWallStack(1, 0, [{ type: "floor", elevation: 0 }]);
  }

  const attachedLiftIndex = actors.length;
  actors.push({
    type: "attached_lift",
    x: 1,
    y: 0,
    elevation: 1,
    raised: initiallyRaised,
    removed: false
  });

  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors
  });
  const keyBefore = engine.stateKey(state);
  const result = engine.moveForSearch(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual(
    [state.actorX[1], state.actorElevation[1], state.liftRaised[1]],
    [1, initiallyRaised ? 1 : 2, initiallyRaised ? 0 : 1],
    `clone ${initiallyRaised ? "lowers" : "raises"} an attached lift on ${carrierType}`
  );
  assert.deepEqual(
    [state.actorX[attachedLiftIndex], state.actorElevation[attachedLiftIndex]],
    [1, 1],
    "attached lift remains anchored to its carrier surface"
  );
  assert.deepEqual(result.liftToggles, [
    { x: 1, y: 0, raised: !initiallyRaised }
  ]);

  engine.undoMove(state, result);
  assert.equal(engine.stateKey(state), keyBefore, `${carrierType} lift interaction undoes exactly`);
}

for (const { initiallyRaised, occupantType } of [false, true].flatMap((initiallyRaised) =>
  ["circle_player", "clone"].map((occupantType) => ({ initiallyRaised, occupantType }))
)) {
  // Device-arrival interaction: an attached lift pushed underneath a player
  // or clone must toggle even though that occupant did not move onto it and
  // therefore has no ordinary endpoint interaction to process.
  const occupant = {
    type: occupantType,
    x: 2,
    y: 0,
    elevation: initiallyRaised ? 2 : 1,
    removed: false
  };

  if (occupantType === "clone") {
    occupant.groupId = "under-lift-clone";
  }

  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: floorTerrain(3, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "under-lift-box", x: 1, y: 0, elevation: 0, removed: false },
      {
        type: "attached_lift",
        x: 1,
        y: 0,
        elevation: 1,
        raised: initiallyRaised,
        removed: false
      },
      occupant
    ]
  });
  const keyBefore = engine.stateKey(state);
  const result = engine.moveForSearch(state, 1, 0);
  const occupantMove = result.moves.find((move) => move.actorIndex === 3);

  assert.equal(result.moved, true);
  assert.deepEqual(
    [state.actorX[1], state.actorX[2], state.actorX[3]],
    [2, 2, 2],
    "carrier and attached lift arrive underneath the occupant"
  );
  assert.deepEqual(
    [state.liftRaised[1], state.liftRaised[2], state.actorElevation[3]],
    [0, initiallyRaised ? 0 : 1, initiallyRaised ? 1 : 2],
    `${occupantType} rides the arriving lift ${initiallyRaised ? "down" : "up"}`
  );
  assert.deepEqual(result.liftToggles, [
    { x: 2, y: 0, raised: !initiallyRaised }
  ]);
  assert.deepEqual(
    [occupantMove.fromElevation, occupantMove.toElevation],
    [initiallyRaised ? 2 : 1, initiallyRaised ? 1 : 2],
    "stationary occupant receives the vertical tween record"
  );

  engine.undoMove(state, result);
  assert.equal(engine.stateKey(state), keyBefore, "arriving lift interaction undoes exactly");
}

// Owner rule (2026-07): clones slide up ice slopes of ANY type — including
// slope-shaped group members (box/clone ice slopes) of other groups.
{
  const terrain = floorTerrain(4, 2);
  terrain[1][2] = {
    type: "wall",
    layers: [
      { type: "floor", elevation: 0 },
      { type: "wall", elevation: 0 }
    ]
  };
  const { engine, state } = createState({
    width: 4,
    height: 2,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "clone", groupId: "c0", x: 0, y: 1, removed: false },
      {
        type: "weightless_box",
        groupId: "M5",
        shape: "slope",
        direction: "right",
        x: 1,
        y: 1,
        removed: false
      }
    ]
  });

  const result = engine.move(state, 1, 0);
  assert.equal(result.moved, true);
  assert.deepEqual(
    [state.actorX[1], state.actorY[1], state.actorElevation[1]],
    [2, 1, 1],
    "clone climbs a foreign box ice slope onto the wall top"
  );
  assert.deepEqual(
    [state.actorX[2], state.actorElevation[2]],
    [1, 0],
    "the climbed wedge does not move"
  );
}

{
  // Clone climbs a foreign CLONE group's wedge the same way.
  const terrain = floorTerrain(4, 2);
  terrain[1][2] = {
    type: "wall",
    layers: [
      { type: "floor", elevation: 0 },
      { type: "wall", elevation: 0 }
    ]
  };
  const { engine, state } = createState({
    width: 4,
    height: 2,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "clone", groupId: "c0", x: 0, y: 1, removed: false },
      {
        type: "clone",
        groupId: "c1",
        shape: "slope",
        direction: "right",
        x: 1,
        y: 1,
        removed: false
      }
    ]
  });

  engine.move(state, 1, 0);
  assert.deepEqual(
    [state.actorX[1], state.actorY[1], state.actorElevation[1]],
    [2, 1, 1],
    "clone climbs a foreign clone ice slope"
  );
}

// Every slope family exposes the same inclined collision band. A blocked
// downhill exit bounces the player home; movable slope actors must never be
// treated as flat actor tops that can be stood upon.
const blockedBounceSlopeFamilies = [
  {
    name: "normal ice slope",
    terrainCell: iceSlopeLayer("up", 0)
  },
  {
    name: "black ice slope",
    terrainCell: {
      type: "ice_slope",
      layers: [
        { type: "ice_slope", elevation: 0, direction: "up", styleKey: "wall" }
      ]
    }
  },
  {
    name: "raised orange ice slope",
    terrainCell: {
      type: "orange_ice_slope",
      layers: [
        { type: "orange_ice_slope", elevation: 0, direction: "up", styleKey: "orange" }
      ]
    }
  },
  {
    name: "box ice slope",
    slopeActor: {
      type: "weightless_box",
      groupId: "M2",
      shape: "slope",
      direction: "up",
      x: 0,
      y: 1,
      elevation: 0,
      removed: false
    }
  },
  {
    name: "clone ice slope",
    slopeActor: {
      type: "clone",
      groupId: "c2",
      shape: "slope",
      direction: "up",
      x: 0,
      y: 1,
      elevation: 0,
      removed: false
    }
  }
];

for (const family of blockedBounceSlopeFamilies) {
  const terrain = [
    [iceBlockLayer(0)],
    [family.terrainCell || { type: "floor" }],
    [wallStack(1)]
  ];
  const { engine, state } = createState({
    width: 1,
    height: 3,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      ...(family.slopeActor ? [family.slopeActor] : [])
    ]
  });

  const result = engine.move(state, 0, 1);
  const playerBounce = result.moves.find((move) => move.actorIndex === 0);

  assert.equal(result.moved, false);
  assert.deepEqual(
    [state.actorX[0], state.actorY[0], state.actorElevation[0]],
    [0, 0, 1],
    `player bounces home from a blocked ${family.name}`
  );
  assert.equal(playerBounce?.visualOnly, true, `${family.name} emits a visual bounce`);
  assert.deepEqual(playerBounce?.path, [
    { x: 0, y: 0, elevation: 1 },
    { x: 0, y: 1, elevation: 1 },
    { x: 0, y: 0, elevation: 1 }
  ], `${family.name} uses the canonical slope bounce path`);
}

// Clones may traverse connected slopes, but walking toward a lower slope must
// not turn a ledge into a fall. This applies to cube and slope-shaped clones.
for (const cloneShape of [undefined, "slope"]) {
  const terrain = floorTerrain(3, 3);
  terrain[0][1] = wallStack(2);
  const clone = {
    type: "clone",
    groupId: "c0",
    x: 1,
    y: 0,
    elevation: 2,
    removed: false
  };

  if (cloneShape) {
    clone.shape = cloneShape;
    clone.direction = "up";
  }

  const { engine, state } = createState({
    width: 3,
    height: 3,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      clone,
      {
        type: "weightless_box",
        groupId: "M0",
        shape: "slope",
        direction: "up",
        x: 1,
        y: 1,
        removed: false
      }
    ]
  });

  const result = engine.move(state, 0, 1);

  assert.equal(result.moved, true, "the player may still move");
  assert.deepEqual(
    [state.actorX[1], state.actorY[1], state.actorElevation[1]],
    [1, 0, 2],
    `${cloneShape || "cube"} clone does not walk off its support onto a lower slope`
  );
  assert.equal(
    result.moves.some((move) => move.actorIndex === 1),
    false,
    "blocked clone emits no movement tween"
  );
}

{
  // level_AxA regression: after the large clone group moves down once, the
  // second down sends its front wedge across the stacked slopes. One member
  // reaches a wall top while another is still inside the next slope band.
  // The group must finish the same blocked-slope bounce as the player; it
  // must not stop mid-slope and be hoisted to elevation 2 by support sync.
  const terrain = floorTerrain(3, 6);
  terrain[2][1] = {
    type: "ice_slope",
    layers: [
      { type: "ice_slope", direction: "down", elevation: 0 },
      { type: "ice_slope", direction: "down", elevation: 1 }
    ]
  };
  terrain[3][1] = wallStack(1);
  terrain[4][1] = iceSlopeLayer("up", 0);
  terrain[5][1] = wallStack(1);

  const { engine, state } = createState({
    width: 3,
    height: 6,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "clone", groupId: "c1", x: 1, y: 0, removed: false },
      { type: "clone", groupId: "c1", x: 2, y: 0, removed: false },
      {
        type: "clone",
        groupId: "c1",
        shape: "slope",
        direction: "up",
        x: 1,
        y: 1,
        removed: false
      }
    ]
  });

  const result = engine.move(state, 0, 1);

  assert.deepEqual(
    [
      [state.actorX[1], state.actorY[1], state.actorElevation[1]],
      [state.actorX[2], state.actorY[2], state.actorElevation[2]],
      [state.actorX[3], state.actorY[3], state.actorElevation[3]]
    ],
    [
      [1, 0, 0],
      [2, 0, 0],
      [1, 1, 0]
    ],
    "the complete rigid clone group bounces home instead of floating"
  );

  for (const actorIndex of [1, 2, 3]) {
    const bounce = result.moves.find((move) => move.actorIndex === actorIndex);
    assert.ok(bounce?.path?.length > 2, "every clone member receives the shared bounce path");
    assert.deepEqual(
      bounce.path.at(-1),
      bounce.path[0],
      "every clone member returns to its own starting position and elevation"
    );
    assert.equal(
      Math.max(...bounce.path.map((point) => point.elevation)),
      1,
      "the bounce never invents the stacked slope's elevation-2 flat support"
    );
  }
}
