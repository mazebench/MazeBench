#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  actor,
  actorPos,
  actorsOf,
  emptyCell,
  floorTerrain,
  holeCell,
  iceCell,
  loadCpuHarness,
  makeBoardEnv,
  test,
  wallCell
} = require("./helpers/train-env-fixture");

const U = 0;
const D = 1;
const L = 2;
const R = 3;
const PITCH_UP = 4;
const YAW_LEFT = 6;
const YAW_RIGHT = 7;
const UNDO = 8;
const RESET = 9;

function corridor(width, extras = {}) {
  const terrain = floorTerrain(width, 1);
  if (extras.walls) extras.walls.forEach((x) => (terrain[0][x] = wallCell()));
  if (extras.ice) extras.ice.forEach((x) => (terrain[0][x] = iceCell()));
  if (extras.empty) extras.empty.forEach((x) => (terrain[0][x] = emptyCell()));
  if (extras.holes) extras.holes.forEach((x) => (terrain[0][x] = holeCell()));
  return { width, height: 1, terrain, actors: extras.actors || [] };
}

async function board(spec, overrides) {
  return makeBoardEnv(typeof spec.width === "number" ? spec : corridor(spec), overrides);
}

async function main() {
  const { TrainEnv, MazeEngine } = loadCpuHarness();
  const { ACTIONS, N_ACTIONS, encodeGrid } = TrainEnv;

  await test("action table is four cardinals, camera, undo, reset — no diagonals", () => {
    assert.equal(N_ACTIONS, 10);
    assert.deepEqual(
      ACTIONS.map((item) => item.command),
      [
        "move",
        "move",
        "move",
        "move",
        "rotate_camera",
        "rotate_camera",
        "rotate_camera",
        "rotate_camera",
        "undo",
        "reset_level"
      ]
    );
    assert.deepEqual(
      ACTIONS.filter((item) => item.command === "move").map((item) => item.move),
      ["U", "D", "L", "R"]
    );
  });

  await test("a walk action moves exactly one floor square", async () => {
    const env = await board(corridor(5, { actors: [actor("player", 1, 0)] }));
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.deepEqual(next.player, { x: 2, y: 0, elevation: 0 });
    assert.equal(next.playerDead, false);
    const again = await env.step(R);
    assert.deepEqual(again.player, { x: 3, y: 0, elevation: 0 });
  });

  await test("the four cardinals each move one square and never skip a cell", async () => {
    const terrain = floorTerrain(3, 3);
    const env = await makeBoardEnv({
      width: 3,
      height: 3,
      terrain,
      actors: [actor("player", 1, 1)]
    });
    assert.deepEqual((await env.step(U)).player, { x: 1, y: 0, elevation: 0 });
    assert.deepEqual((await env.step(D)).player, { x: 1, y: 1, elevation: 0 });
    assert.deepEqual((await env.step(L)).player, { x: 0, y: 1, elevation: 0 });
    assert.deepEqual((await env.step(R)).player, { x: 1, y: 1, elevation: 0 });
  });

  await test("walking into a wall is illegal: no move, no hash change, no reward", async () => {
    const env = await board(
      corridor(4, { walls: [2], actors: [actor("player", 1, 0)] })
    );
    const before = env.snapshot();
    const next = await env.step(R);
    assert.equal(next.moved, false);
    assert.deepEqual(next.player, before.player);
    assert.equal(next.hash, before.hash);
    assert.equal(next.reward, 0);
    assert.equal(next.parts.pushes, 0);
  });

  await test("an isolated board edge rails the player instead of skipping off-map", async () => {
    const env = await board(corridor(3, { actors: [actor("player", 2, 0)] }));
    const next = await env.step(R);
    assert.equal(next.moved, false);
    assert.deepEqual(next.player, { x: 2, y: 0, elevation: 0 });
    assert.equal(next.levelId, "level_AxA");
  });

  await test("camera rotate does not move the player or the board", async () => {
    const env = await board(corridor(4, { actors: [actor("player", 1, 0)] }));
    const before = env.snapshot();
    const yawed = await env.step(YAW_RIGHT);
    assert.equal(yawed.moved, false);
    assert.deepEqual(yawed.player, before.player);
    assert.equal(yawed.yaw, 1);
    assert.equal(yawed.parts.novel, 0);
    assert.equal(yawed.reward, 0);
    const pitched = await env.step(PITCH_UP);
    assert.deepEqual(pitched.player, before.player);
    assert.equal(pitched.pitch, 0);
  });

  await test("yaw remaps screen moves onto world axes", async () => {
    const env = await makeBoardEnv({
      width: 3,
      height: 3,
      terrain: floorTerrain(3, 3),
      actors: [actor("player", 1, 1)]
    });
    await env.step(YAW_RIGHT);
    const north = await env.step(R);
    assert.deepEqual(north.player, { x: 1, y: 0, elevation: 0 }, "screen-right at yaw 1 is world up");
    const west = await env.step(U);
    assert.deepEqual(west.player, { x: 0, y: 0, elevation: 0 }, "screen-up at yaw 1 is world left");
  });

  await test("a single box is pushed exactly one square and the player takes its cell", async () => {
    const env = await board(
      corridor(5, { actors: [actor("player", 1, 0), actor("box", 2, 0)] })
    );
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.deepEqual(next.player, { x: 2, y: 0, elevation: 0 });
    assert.deepEqual(actorPos(env, "box"), { index: 1, x: 3, y: 0, elevation: 0 });
    assert.equal(next.parts.pushes, 1);
    assert.ok(next.reward >= 0.05 - 1e-9);
    const grid = encodeGrid(env.engine, env.state);
    assert.equal(grid[2], 16);
    assert.equal(grid[3], 18);
    const stayed = await env.step(R);
    assert.deepEqual(stayed.player, { x: 3, y: 0, elevation: 0 });
    assert.equal(actorPos(env, "box").x, 4);
  });

  await test("two boxes in a row are illegal to push with one player", async () => {
    const env = await board(
      corridor(6, {
        actors: [actor("player", 1, 0), actor("box", 2, 0), actor("box", 3, 0)]
      })
    );
    const before = env.snapshot();
    const next = await env.step(R);
    assert.equal(next.moved, false);
    assert.deepEqual(next.player, before.player);
    assert.deepEqual(
      actorsOf(env, "box").map((item) => item.x),
      [2, 3]
    );
    assert.equal(next.parts.pushes, 0);
  });

  await test("a box cannot be pushed into a wall", async () => {
    const env = await board(
      corridor(5, {
        walls: [3],
        actors: [actor("player", 1, 0), actor("box", 2, 0)]
      })
    );
    const next = await env.step(R);
    assert.equal(next.moved, false);
    assert.deepEqual(next.player, { x: 1, y: 0, elevation: 0 });
    assert.equal(actorPos(env, "box").x, 2);
  });

  await test("a weightless box also moves exactly one square when pushed", async () => {
    const env = await board(
      corridor(5, {
        actors: [actor("player", 1, 0), actor("weightless_box", 2, 0, { groupId: "M0" })]
      })
    );
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.deepEqual(next.player, { x: 2, y: 0, elevation: 0 });
    assert.equal(actorPos(env, "weightless_box").x, 3);
    assert.equal(next.parts.pushes, 1);
  });

  await test("pushing a floating floor over a hole fills the hole", async () => {
    const env = await board(
      corridor(4, {
        holes: [2],
        actors: [actor("player", 0, 0), actor("floating_floor", 1, 0)]
      })
    );
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.deepEqual(next.player, { x: 1, y: 0, elevation: 0 });
    assert.equal(env.state.actorRemoved[1], 1);
    assert.equal(env.state.terrain[2], MazeEngine.terrainTypes.floor);
    assert.equal(next.parts.pushes, 1);
  });

  await test("undo after a push restores the box and the player", async () => {
    const env = await board(
      corridor(5, { actors: [actor("player", 1, 0), actor("box", 2, 0)] })
    );
    const before = env.snapshot();
    await env.step(R);
    const undone = await env.step(UNDO);
    assert.deepEqual(undone.player, before.player);
    assert.equal(actorPos(env, "box").x, 2);
    assert.equal(undone.hash, before.hash);
  });

  await test("reset_level after a push restores the room entry", async () => {
    const env = await board(
      corridor(5, { actors: [actor("player", 1, 0), actor("box", 2, 0)] })
    );
    const entry = env.snapshot();
    await env.step(R);
    await env.step(R);
    const reset = await env.step(RESET);
    assert.deepEqual(reset.player, entry.player);
    assert.equal(actorPos(env, "box").x, 2);
    assert.equal(reset.hash, entry.hash);
  });

  await test("walking onto a gem collects it; standing beside it does not", async () => {
    const env = await board(
      corridor(5, { actors: [actor("player", 0, 0), actor("gem", 2, 0)] })
    );
    const beside = await env.step(R);
    assert.equal(beside.gemCount, 0);
    assert.equal(beside.parts.gems, 0);
    assert.deepEqual(beside.player, { x: 1, y: 0, elevation: 0 });
    assert.ok(actorPos(env, "gem"));
    const landed = await env.step(R);
    assert.equal(landed.gemCount, 1);
    assert.equal(landed.parts.gems, 1);
    assert.ok(landed.reward >= 1);
    assert.equal(actorPos(env, "gem"), null);
  });

  await test("stepping into void kills the player and leaves only undo/reset legal", async () => {
    const env = await board(
      corridor(3, { empty: [1], actors: [actor("player", 0, 0)] })
    );
    const next = await env.step(R);
    assert.equal(next.playerDead, true);
    assert.equal(next.player, null);
    assert.equal(next.parts.death, 1);
    assert.deepEqual(
      next.mask,
      [false, false, false, false, false, false, false, false, true, true]
    );
    const ignored = await env.step(R);
    assert.equal(ignored.playerDead, true);
    assert.equal(ignored.moved, false);
    const undone = await env.step(UNDO);
    assert.equal(undone.playerDead, false);
    assert.deepEqual(undone.player, { x: 0, y: 0, elevation: 0 });
  });

  await test("ice slides more than one square and collects only the landing gem", async () => {
    const env = await board(
      corridor(4, {
        ice: [1, 2],
        actors: [actor("player", 0, 0), actor("gem", 1, 0), actor("gem", 3, 0)]
      })
    );
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.deepEqual(next.player, { x: 3, y: 0, elevation: 0 });
    assert.equal(next.gemCount, 1);
    assert.ok(actorPos(env, "gem"), "mid-slide gem must survive");
    assert.equal(actorPos(env, "gem").x, 1);
  });

  await test("ice slide stops at a wall instead of passing through", async () => {
    const env = await board(
      corridor(4, {
        ice: [1, 2],
        walls: [3],
        actors: [actor("player", 0, 0)]
      })
    );
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.deepEqual(next.player, { x: 2, y: 0, elevation: 0 });
  });

  await test("a clone copies the same one-square input; a wall only blocks the clone", async () => {
    const terrain = floorTerrain(3, 2);
    terrain[1][1] = wallCell();
    const env = await makeBoardEnv({
      width: 3,
      height: 2,
      terrain,
      actors: [actor("player", 0, 0), actor("clone", 0, 1, { groupId: "c0" })]
    });
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.deepEqual(next.player, { x: 1, y: 0, elevation: 0 });
    assert.deepEqual(actorPos(env, "clone"), { index: 1, x: 0, y: 1, elevation: 0 });
  });

  await test("a box two squares away is not tele-pushed", async () => {
    const env = await board(
      corridor(5, { actors: [actor("player", 0, 0), actor("box", 2, 0)] })
    );
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.deepEqual(next.player, { x: 1, y: 0, elevation: 0 });
    assert.equal(actorPos(env, "box").x, 2);
    assert.equal(next.parts.pushes, 0);
  });

  await test("sliding on ice does not shove a box mid-slide", async () => {
    const env = await board(
      corridor(4, {
        ice: [1],
        actors: [actor("player", 0, 0), actor("box", 2, 0)]
      })
    );
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.deepEqual(next.player, { x: 1, y: 0, elevation: 0 });
    assert.equal(actorPos(env, "box").x, 2);
    assert.equal(next.parts.pushes, 0);
  });

  await test("a raised orange wall is illegal to walk through", async () => {
    const terrain = floorTerrain(3, 1);
    terrain[0][1] = { type: "orange_wall" };
    const env = await makeBoardEnv({
      width: 3,
      height: 1,
      terrain,
      actors: [actor("player", 0, 0)]
    });
    const next = await env.step(R);
    assert.equal(next.moved, false);
    assert.deepEqual(next.player, { x: 0, y: 0, elevation: 0 });
  });

  await test("a box holding an orange button keeps the wall down", async () => {
    const terrain = floorTerrain(3, 1);
    terrain[0][1] = { type: "orange_wall" };
    terrain[0][2] = { type: "orange_button" };
    const env = await makeBoardEnv({
      width: 3,
      height: 1,
      terrain,
      actors: [actor("player", 0, 0), actor("box", 2, 0)]
    });
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.deepEqual(next.player, { x: 1, y: 0, elevation: 0 });
    assert.equal(actorPos(env, "box").x, 2);
  });

  await test("walking off the east edge enters the neighboring room", async () => {
    const west = {
      width: 3,
      height: 1,
      terrain: floorTerrain(3, 1),
      actors: [actor("player", 2, 0)]
    };
    const east = {
      width: 3,
      height: 1,
      terrain: floorTerrain(3, 1),
      actors: [actor("player", 1, 0)]
    };
    const env = await makeBoardEnv(
      {
        levelId: "level_AxA",
        playCache: new Map([
          ["level_AxA", west],
          ["level_BxA", east]
        ])
      }
    );
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.equal(next.levelId, "level_BxA");
    assert.deepEqual(next.player, { x: 0, y: 0, elevation: 0 });
    assert.equal(next.parts.rooms, 1);
    assert.ok(next.reward >= 0.1 - 1e-9);
  });

  console.log("train-moves tests passed");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
