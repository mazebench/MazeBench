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
  makeEnv,
  test,
  wallCell
} = require("./helpers/train-env-fixture");

const R = 3;
const L = 2;
const U = 0;
const D = 1;
const PLAYER = 16;
const GEM = 17;
const BOX = 18;
const WEIGHTLESS = 19;
const FLOATING = 22;
const FLOOR = 1;
const HOLE = 5;
const LIFT = 7;
const PUNCHER = 21;

function puncherActor(direction, x, y) {
  return actor("puncher", x, y, { direction });
}

function liftCell(raised = false) {
  return {
    type: "player_lift",
    layers: [{ type: "player_lift", elevation: 0, raised }],
    raised
  };
}

function iceSlopeCell(direction = "right", elevation = 0) {
  return { type: "ice_slope", layers: [{ type: "ice_slope", direction, elevation }] };
}

function iceBlockCell(elevation = 0) {
  return { type: "ice_block", layers: [{ type: "ice_block", elevation }] };
}

function stackedWall(...elevations) {
  return { type: "wall", layers: elevations.map((elevation) => ({ type: "wall", elevation })) };
}

function corridor(width, extras = {}) {
  const terrain = floorTerrain(width, 1);
  if (extras.walls) extras.walls.forEach((x) => (terrain[0][x] = wallCell()));
  if (extras.ice) extras.ice.forEach((x) => (terrain[0][x] = iceCell()));
  if (extras.empty) extras.empty.forEach((x) => (terrain[0][x] = emptyCell()));
  if (extras.holes) extras.holes.forEach((x) => (terrain[0][x] = holeCell()));
  return { width, height: 1, terrain, actors: extras.actors || [] };
}

async function board(spec, overrides) {
  if (typeof spec === "number") return makeBoardEnv(corridor(spec), overrides);
  if (spec && spec.terrain) return makeBoardEnv(spec, overrides);
  return makeBoardEnv(corridor(spec.width, spec), overrides);
}

function gridAt(env, x, y = 0) {
  const { encodeGrid } = loadCpuHarness().TrainEnv;
  return encodeGrid(env.engine, env.state)[y * 16 + x];
}

async function main() {
  const { TrainEnv, MazeEngine } = loadCpuHarness();
  const { encodeGrid } = TrainEnv;

  await test("CPU box: push one square, player takes the cell, novel push pays 0.05", async () => {
    const env = await board({
      width: 5,
      actors: [actor("player", 1, 0), actor("box", 2, 0)]
    });
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.deepEqual(next.player, { x: 2, y: 0, elevation: 0 });
    assert.equal(actorPos(env, "box").x, 3);
    assert.equal(actorPos(env, "box").y, 0);
    assert.equal(next.parts.pushes, 1);
    assert.ok(next.reward >= 0.05 - 1e-9, `push reward missing: ${next.reward}`);
    assert.equal(gridAt(env, 2), PLAYER);
    assert.equal(gridAt(env, 3), BOX);
  });

  await test("CPU box: a second push to a new cell still pays novel push", async () => {
    const env = await board({
      width: 6,
      actors: [actor("player", 1, 0), actor("box", 2, 0)]
    });
    const first = await env.step(R);
    const second = await env.step(R);
    assert.equal(first.parts.pushes, 1);
    assert.equal(second.parts.pushes, 1);
    assert.equal(actorPos(env, "box").x, 4);
  });

  await test("CPU box: pushing back onto a previous dest is not a novel push", async () => {
    const env = await board({
      width: 6,
      actors: [actor("player", 1, 0), actor("box", 2, 0)]
    });
    const first = await env.step(R);
    assert.equal(first.parts.pushes, 1);
    await env.step(8);
    const again = await env.step(R);
    assert.equal(again.moved, true);
    assert.equal(actorPos(env, "box").x, 3);
    assert.equal(again.parts.pushes, 0);
  });

  await test("CPU box: two boxes in a row do not move and pay no push", async () => {
    const env = await board({
      width: 6,
      actors: [actor("player", 1, 0), actor("box", 2, 0), actor("box", 3, 0)]
    });
    const next = await env.step(R);
    assert.equal(next.moved, false);
    assert.equal(next.parts.pushes, 0);
    assert.deepEqual(
      actorsOf(env, "box").map((item) => item.x),
      [2, 3]
    );
  });

  await test("CPU box: cannot push into a wall", async () => {
    const env = await board({
      width: 5,
      walls: [3],
      actors: [actor("player", 1, 0), actor("box", 2, 0)]
    });
    const next = await env.step(R);
    assert.equal(next.moved, false);
    assert.equal(next.parts.pushes, 0);
    assert.equal(actorPos(env, "box").x, 2);
  });

  await test("CPU box: pushing into empty void is a legal novel push", async () => {
    const env = await board({
      width: 5,
      empty: [3],
      actors: [actor("player", 1, 0), actor("box", 2, 0)]
    });
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.equal(next.parts.pushes, 1);
    assert.ok(next.reward >= 0.05 - 1e-9);
    assert.equal(next.player.x, 2);
  });

  await test("CPU box: pushing into a hole is a legal novel push", async () => {
    const env = await board({
      width: 5,
      holes: [3],
      actors: [actor("player", 1, 0), actor("box", 2, 0)]
    });
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.equal(next.parts.pushes, 1);
    assert.ok(next.reward >= 0.05 - 1e-9);
    assert.equal(next.player.x, 2);
    const box = actorPos(env, "box");
    if (box) {
      assert.equal(box.x, 3);
    } else {
      assert.equal(env.state.actorRemoved[1], 1);
    }
  });

  await test("CPU stand-on-box: walking at e1 onto a box does not push it", async () => {
    const env = await board({
      width: 4,
      actors: [actor("player", 0, 0, { elevation: 1 }), actor("box", 0, 0), actor("box", 1, 0)]
    });
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.deepEqual(next.player, { x: 1, y: 0, elevation: 1 });
    assert.equal(next.parts.pushes, 0);
    assert.deepEqual(
      actorsOf(env, "box").map((item) => ({ x: item.x, elevation: item.elevation })),
      [
        { x: 0, elevation: 0 },
        { x: 1, elevation: 0 }
      ]
    );
    assert.equal(gridAt(env, 0), BOX);
    assert.equal(gridAt(env, 1), PLAYER);
  });

  await test("CPU stand-on-box: cannot step down from a box onto floor", async () => {
    const env = await board({
      width: 4,
      actors: [actor("player", 0, 0, { elevation: 1 }), actor("box", 0, 0)]
    });
    const next = await env.step(R);
    assert.equal(next.moved, false);
    assert.deepEqual(next.player, { x: 0, y: 0, elevation: 1 });
    assert.equal(actorPos(env, "box").x, 0);
  });

  await test("CPU lift ride then stand-on-box keeps the box and elevation 1", async () => {
    const terrain = floorTerrain(4, 1);
    terrain[0][1] = liftCell(false);
    const env = await board({
      width: 4,
      height: 1,
      terrain,
      actors: [actor("player", 0, 0), actor("box", 2, 0)]
    });
    const ontoLift = await env.step(R);
    assert.deepEqual(ontoLift.player, { x: 1, y: 0, elevation: 1 });
    const ontoBox = await env.step(R);
    assert.equal(ontoBox.moved, true);
    assert.deepEqual(ontoBox.player, { x: 2, y: 0, elevation: 1 });
    assert.equal(ontoBox.parts.pushes, 0);
    assert.equal(actorPos(env, "box").x, 2);
    assert.equal(gridAt(env, 2), PLAYER);
  });

  await test("CPU ice slope: uphill lands on ice_block at e1", async () => {
    const terrain = floorTerrain(3, 1);
    terrain[0][1] = iceSlopeCell("right", 0);
    terrain[0][2] = iceBlockCell(0);
    const env = await board({
      width: 3,
      height: 1,
      terrain,
      actors: [actor("player", 0, 0)]
    });
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.deepEqual(next.player, { x: 2, y: 0, elevation: 1 });
    assert.equal(next.parts.pushes, 0);
    assert.equal(gridAt(env, 2), PLAYER);
  });

  await test("CPU ice slope: downhill from ice_block exits at e0", async () => {
    const terrain = floorTerrain(3, 1);
    terrain[0][1] = iceSlopeCell("right", 0);
    terrain[0][2] = iceBlockCell(0);
    const env = await board({
      width: 3,
      height: 1,
      terrain,
      actors: [actor("player", 2, 0, { elevation: 1 })]
    });
    const next = await env.step(L);
    assert.equal(next.moved, true);
    assert.deepEqual(next.player, { x: 0, y: 0, elevation: 0 });
  });

  await test("CPU ice slope: blocked exit bounces then slides on ice_block", async () => {
    const terrain = floorTerrain(4, 1);
    terrain[0][0] = iceBlockCell(0);
    terrain[0][1] = iceBlockCell(0);
    terrain[0][2] = iceSlopeCell("right", 1);
    terrain[0][3] = stackedWall(0, 1, 2);
    const env = await board({
      width: 4,
      height: 1,
      terrain,
      actors: [actor("player", 1, 0, { elevation: 1 })]
    });
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.deepEqual(next.player, { x: 0, y: 0, elevation: 1 });
  });

  await test("CPU puncher: walking onto it trains to the far floor", async () => {
    const env = await board({
      width: 6,
      height: 1,
      terrain: floorTerrain(6, 1),
      actors: [actor("player", 0, 0), puncherActor("right", 1, 0)]
    });
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.deepEqual(next.player, { x: 5, y: 0, elevation: 0 });
    assert.equal(next.playerDead, false);
  });

  await test("CPU puncher: punched box trains down to the last floor", async () => {
    const env = await board({
      width: 4,
      height: 4,
      terrain: floorTerrain(4, 4),
      actors: [actor("player", 0, 0), actor("box", 1, 0), puncherActor("down", 2, 0)]
    });
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.deepEqual(next.player, { x: 1, y: 0, elevation: 0 });
    assert.equal(actorPos(env, "box").x, 2);
    assert.equal(actorPos(env, "box").y, 3);
  });

  await test("CPU weightless_box: push one square and pay novel push", async () => {
    const env = await board({
      width: 5,
      actors: [actor("player", 1, 0), actor("weightless_box", 2, 0, { groupId: "M0" })]
    });
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.equal(actorPos(env, "weightless_box").x, 3);
    assert.equal(next.parts.pushes, 1);
    assert.ok(next.reward >= 0.05 - 1e-9);
    assert.equal(gridAt(env, 3), WEIGHTLESS);
  });

  await test("CPU weightless_box: slides across ice to the far floor", async () => {
    const env = await board({
      width: 6,
      ice: [3, 4],
      actors: [actor("player", 1, 0), actor("weightless_box", 2, 0, { groupId: "M0" })]
    });
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.equal(actorPos(env, "weightless_box").x, 5);
    assert.equal(next.parts.pushes, 1);
  });

  await test("CPU weightless_box: cannot push into a wall", async () => {
    const env = await board({
      width: 5,
      walls: [3],
      actors: [actor("player", 1, 0), actor("weightless_box", 2, 0, { groupId: "M0" })]
    });
    const next = await env.step(R);
    assert.equal(next.moved, false);
    assert.equal(next.parts.pushes, 0);
  });

  await test("CPU floating_floor: push onto floor one square and pay novel push", async () => {
    const env = await board({
      width: 5,
      actors: [actor("player", 1, 0), actor("floating_floor", 2, 0)]
    });
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.equal(actorPos(env, "floating_floor").x, 3);
    assert.equal(next.parts.pushes, 1);
    assert.ok(next.reward >= 0.05 - 1e-9);
    assert.equal(gridAt(env, 3), FLOATING);
  });

  await test("CPU floating_floor: pushing over a hole fills the hole and pays novel push", async () => {
    const env = await board({
      width: 4,
      holes: [2],
      actors: [actor("player", 0, 0), actor("floating_floor", 1, 0)]
    });
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.equal(env.state.actorRemoved[1], 1);
    assert.equal(env.state.terrain[2], MazeEngine.terrainTypes.floor);
    assert.equal(next.parts.pushes, 1);
    assert.ok(next.reward >= 0.05 - 1e-9);
    assert.equal(gridAt(env, 2), FLOOR);
    assert.equal(gridAt(env, 1), PLAYER);
  });

  await test("CPU floating_floor: cannot push into a wall", async () => {
    const env = await board({
      width: 5,
      walls: [3],
      actors: [actor("player", 1, 0), actor("floating_floor", 2, 0)]
    });
    const next = await env.step(R);
    assert.equal(next.moved, false);
    assert.equal(next.parts.pushes, 0);
  });

  await test("CPU ice slide does not shove a box mid-slide", async () => {
    const env = await board({
      width: 6,
      ice: [1, 2],
      actors: [actor("player", 0, 0), actor("box", 3, 0)]
    });
    const next = await env.step(R);
    assert.equal(actorPos(env, "box").x, 3);
    assert.equal(next.parts.pushes, 0);
  });

  await test("CPU 2x2 weightless group is one rigid body", async () => {
    const env = await makeBoardEnv({
      width: 6,
      height: 3,
      terrain: floorTerrain(6, 3),
      actors: [
        actor("player", 0, 1),
        actor("weightless_box", 1, 1, { groupId: "M0" }),
        actor("weightless_box", 2, 1, { groupId: "M0" }),
        actor("weightless_box", 1, 2, { groupId: "M0" }),
        actor("weightless_box", 2, 2, { groupId: "M0" })
      ]
    });
    const next = await env.step(R);
    assert.equal(next.moved, true);
    assert.equal(next.parts.pushes, 4);
    assert.equal(gridAt(env, 1, 1), PLAYER);
    assert.equal(gridAt(env, 2, 1), WEIGHTLESS);
    assert.equal(gridAt(env, 3, 1), WEIGHTLESS);
    assert.equal(gridAt(env, 2, 2), WEIGHTLESS);
    assert.equal(gridAt(env, 3, 2), WEIGHTLESS);
  });

  let ppo;
  try {
    const { installWebGpu } = require("../scripts/webgpu-node");
    await installWebGpu();
    const { TrainPpo } = loadCpuHarness();
    ppo = new TrainPpo.WebGpuPpo();
    await ppo.init(1);
  } catch (error) {
    console.log(`SKIP GPU push match: ${error.message}`);
    console.log("train-push tests passed (CPU only)");
    return;
  }

  async function gpuMatch(label, spec, action, check) {
    await test(`GPU matches CPU: ${label}`, async () => {
      const env = await board(spec);
      const cap = env.gpuCapture();
      const cpu = await env.step(action);
      const rolled = await ppo.gpuRollout([cap], 1, { actions: [action], maxActions: 64, seed: 1 });
      const next = rolled.nextCaptures[0];
      const gpuGrid = rolled.grids[0][0];
      const cpuGrid = encodeGrid(env.engine, env.state);
      assert.equal(rolled.actions[0][0], action);
      assert.equal(next.dead, cpu.playerDead, `${label} dead`);
      if (!cpu.playerDead) {
        assert.equal(next.px, cpu.player.x, `${label} px`);
        assert.equal(next.py, cpu.player.y, `${label} py`);
      }
      if (cpu.moved) {
        assert.ok(
          Math.abs(rolled.rewards[0][0] - cpu.reward) < 0.02,
          `${label} reward gpu=${rolled.rewards[0][0]} cpu=${cpu.reward}`
        );
      } else {
        assert.ok(rolled.rewards[0][0] <= 1e-6, `${label} failed move should not pay, got ${rolled.rewards[0][0]}`);
      }
      for (let i = 0; i < spec.width; i += 1) {
        assert.equal(gpuGrid[i], cpuGrid[i], `${label} cell ${i} gpu=${gpuGrid[i]} cpu=${cpuGrid[i]}`);
      }
      if (check) check({ cpu, rolled, env, gpuGrid });
    });
  }

  await gpuMatch(
    "box push one square",
    { width: 5, actors: [actor("player", 1, 0), actor("box", 2, 0)] },
    R,
    ({ cpu, gpuGrid }) => {
      assert.equal(cpu.parts.pushes, 1);
      assert.equal(gpuGrid[2], PLAYER);
      assert.equal(gpuGrid[3], BOX);
    }
  );

  await gpuMatch(
    "stand on box at e1 does not push",
    {
      width: 4,
      actors: [actor("player", 0, 0, { elevation: 1 }), actor("box", 0, 0), actor("box", 1, 0)]
    },
    R,
    ({ cpu, gpuGrid, rolled }) => {
      assert.equal(cpu.parts.pushes, 0);
      assert.equal(cpu.player.elevation, 1);
      assert.equal(rolled.nextCaptures[0].pe, 1);
      assert.equal(gpuGrid[0], BOX);
      assert.equal(gpuGrid[1], PLAYER);
      assert.equal(gpuGrid[2], FLOOR);
    }
  );

  await test("GPU lift ride then stand-on-box does not push", async () => {
    const terrain = floorTerrain(4, 1);
    terrain[0][1] = liftCell(false);
    const env = await board({
      width: 4,
      height: 1,
      terrain,
      actors: [actor("player", 0, 0), actor("box", 2, 0)]
    });
    const cap = env.gpuCapture();
    assert.equal(cap.pe, 0);
    await env.step(R);
    const cpu = await env.step(R);
    const rolled = await ppo.gpuRollout([cap], 2, { actions: [R, R], maxActions: 64, seed: 1 });
    assert.equal(cpu.player.elevation, 1);
    assert.equal(cpu.parts.pushes, 0);
    assert.equal(rolled.nextCaptures[0].px, 2);
    assert.equal(rolled.nextCaptures[0].pe, 1);
    assert.equal(rolled.grids[1][0][1], LIFT);
    assert.equal(rolled.grids[1][0][2], PLAYER);
    assert.equal(rolled.grids[1][0][3], FLOOR, "old kernel pushed the box to x=3");
    assert.ok(rolled.rewards[1][0] < 0.04, `must not pay push, got ${rolled.rewards[1][0]}`);
  });

  await test("GPU stand-on-box pe survives a collect carry", async () => {
    const env = await board({
      width: 5,
      actors: [
        actor("player", 0, 0, { elevation: 1 }),
        actor("box", 0, 0),
        actor("box", 1, 0),
        actor("box", 2, 0)
      ]
    });
    const first = await ppo.gpuRollout([env.gpuCapture()], 1, { actions: [R], maxActions: 64, seed: 1 });
    assert.equal(first.nextCaptures[0].pe, 1);
    assert.equal(first.nextCaptures[0].occ[0] & 255, BOX);
    const rest = await ppo.gpuRollout([first.nextCaptures[0]], 1, { actions: [R], maxActions: 64, seed: 1 });
    assert.equal(rest.nextCaptures[0].px, 2);
    assert.equal(rest.nextCaptures[0].pe, 1);
    assert.equal(rest.grids[0][0][0], BOX);
    assert.equal(rest.grids[0][0][1], BOX);
    assert.equal(rest.grids[0][0][2], PLAYER);
    assert.equal(rest.grids[0][0][3], FLOOR);
  });

  await gpuMatch(
    "ice slope uphill lands on ice_block at e1",
    {
      width: 3,
      height: 1,
      terrain: (() => {
        const t = floorTerrain(3, 1);
        t[0][1] = iceSlopeCell("right", 0);
        t[0][2] = iceBlockCell(0);
        return t;
      })(),
      actors: [actor("player", 0, 0)]
    },
    R,
    ({ cpu, gpuGrid, rolled }) => {
      assert.equal(cpu.player.elevation, 1);
      assert.equal(rolled.nextCaptures[0].pe, 1, "old hop failed to raise pe onto ice_block");
      assert.equal(rolled.nextCaptures[0].px, 2);
      assert.equal(gpuGrid[2], PLAYER);
      assert.equal(gpuGrid[0], FLOOR);
    }
  );

  await gpuMatch(
    "ice slope downhill from ice_block exits at e0",
    {
      width: 3,
      height: 1,
      terrain: (() => {
        const t = floorTerrain(3, 1);
        t[0][1] = iceSlopeCell("right", 0);
        t[0][2] = iceBlockCell(0);
        return t;
      })(),
      actors: [actor("player", 2, 0, { elevation: 1 })]
    },
    L,
    ({ cpu, rolled }) => {
      assert.equal(cpu.player.x, 0);
      assert.equal(cpu.player.elevation, 0);
      assert.equal(rolled.nextCaptures[0].px, 0);
      assert.equal(rolled.nextCaptures[0].pe, 0, "old hop did not descend the slope");
    }
  );

  await test("GPU ice slope bounce then ice_block slide", async () => {
    const terrain = floorTerrain(4, 1);
    terrain[0][0] = iceBlockCell(0);
    terrain[0][1] = iceBlockCell(0);
    terrain[0][2] = iceSlopeCell("right", 1);
    terrain[0][3] = stackedWall(0, 1, 2);
    const env = await board({
      width: 4,
      height: 1,
      terrain,
      actors: [actor("player", 1, 0, { elevation: 1 })]
    });
    const cap = env.gpuCapture();
    const cpu = await env.step(R);
    const rolled = await ppo.gpuRollout([cap], 1, { actions: [R], maxActions: 64, seed: 1 });
    assert.equal(cpu.player.x, 0);
    assert.equal(cpu.player.elevation, 1);
    assert.equal(rolled.nextCaptures[0].px, 0, "old hop stayed put instead of bouncing onto ice");
    assert.equal(rolled.nextCaptures[0].pe, 1);
    assert.equal(rolled.grids[0][0][0], PLAYER);
  });

  await test("GPU chained ice slopes raise pe to 2", async () => {
    const terrain = floorTerrain(4, 1);
    terrain[0][1] = iceSlopeCell("right", 0);
    terrain[0][2] = iceSlopeCell("right", 1);
    terrain[0][3] = iceBlockCell(1);
    const env = await board({
      width: 4,
      height: 1,
      terrain,
      actors: [actor("player", 0, 0)]
    });
    const cap = env.gpuCapture();
    const cpu = await env.step(R);
    const rolled = await ppo.gpuRollout([cap], 1, { actions: [R], maxActions: 64, seed: 1 });
    assert.equal(cpu.player.x, 3);
    assert.equal(cpu.player.elevation, 2);
    assert.equal(rolled.nextCaptures[0].px, 3, "old hop did not chain slopes");
    assert.equal(rolled.nextCaptures[0].pe, 2);
  });

  await gpuMatch(
    "two boxes in a row stay put",
    { width: 6, actors: [actor("player", 1, 0), actor("box", 2, 0), actor("box", 3, 0)] },
    R,
    ({ cpu }) => {
      assert.equal(cpu.parts.pushes, 0);
      assert.equal(cpu.moved, false);
    }
  );

  await gpuMatch(
    "box into wall is illegal",
    { width: 5, walls: [3], actors: [actor("player", 1, 0), actor("box", 2, 0)] },
    R
  );

  await gpuMatch(
    "box into empty void",
    { width: 5, empty: [3], actors: [actor("player", 1, 0), actor("box", 2, 0)] },
    R
  );

  await gpuMatch(
    "player stepping into empty void dies",
    { width: 3, empty: [1], actors: [actor("player", 0, 0)] },
    R,
    ({ cpu }) => {
      assert.equal(cpu.playerDead, true);
      assert.equal(cpu.parts.death, 1);
    }
  );

  await gpuMatch(
    "player stepping into a hole dies",
    { width: 3, holes: [1], actors: [actor("player", 0, 0)] },
    R,
    ({ cpu }) => {
      assert.equal(cpu.playerDead, true);
      assert.equal(cpu.parts.death, 1);
    }
  );

  await gpuMatch(
    "box into hole",
    { width: 5, holes: [3], actors: [actor("player", 1, 0), actor("box", 2, 0)] },
    R,
    ({ cpu }) => {
      assert.equal(cpu.parts.pushes, 1);
    }
  );

  await gpuMatch(
    "weightless_box push one square",
    {
      width: 5,
      actors: [actor("player", 1, 0), actor("weightless_box", 2, 0, { groupId: "M0" })]
    },
    R,
    ({ cpu, gpuGrid }) => {
      assert.equal(cpu.parts.pushes, 1);
      assert.equal(gpuGrid[3], WEIGHTLESS);
    }
  );

  await gpuMatch(
    "two weightless cells in one group push together",
    {
      width: 6,
      actors: [
        actor("player", 1, 0),
        actor("weightless_box", 2, 0, { groupId: "M0" }),
        actor("weightless_box", 3, 0, { groupId: "M0" })
      ]
    },
    R,
    ({ cpu, gpuGrid }) => {
      assert.equal(cpu.moved, true);
      assert.equal(cpu.parts.pushes, 2);
      assert.equal(gpuGrid[2], PLAYER);
      assert.equal(gpuGrid[3], WEIGHTLESS);
      assert.equal(gpuGrid[4], WEIGHTLESS);
    }
  );

  await test("GPU 2x2 weightless group pushes as one body", async () => {
    const spec = {
      width: 6,
      height: 3,
      terrain: floorTerrain(6, 3),
      actors: [
        actor("player", 0, 1),
        actor("weightless_box", 1, 1, { groupId: "M0" }),
        actor("weightless_box", 2, 1, { groupId: "M0" }),
        actor("weightless_box", 1, 2, { groupId: "M0" }),
        actor("weightless_box", 2, 2, { groupId: "M0" })
      ]
    };
    const env = await makeBoardEnv(spec);
    const cap = env.gpuCapture();
    const cpu = await env.step(R);
    const rolled = await ppo.gpuRollout([cap], 1, { actions: [R], maxActions: 64, seed: 1 });
    const gpuGrid = rolled.grids[0][0];
    assert.equal(cpu.parts.pushes, 4);
    assert.equal(rolled.nextCaptures[0].px, cpu.player.x);
    assert.equal(rolled.nextCaptures[0].py, cpu.player.y);
    assert.equal(gpuGrid[1 * 16 + 1], PLAYER);
    assert.equal(gpuGrid[1 * 16 + 2], WEIGHTLESS);
    assert.equal(gpuGrid[1 * 16 + 3], WEIGHTLESS);
    assert.equal(gpuGrid[2 * 16 + 2], WEIGHTLESS);
    assert.equal(gpuGrid[2 * 16 + 3], WEIGHTLESS);
    assert.ok(
      Math.abs(rolled.rewards[0][0] - cpu.reward) < 0.05,
      `2x2 reward gpu=${rolled.rewards[0][0]} cpu=${cpu.reward}`
    );
  });

  await gpuMatch(
    "weightless_box slides on ice to the far floor",
    {
      width: 6,
      ice: [3, 4],
      actors: [actor("player", 1, 0), actor("weightless_box", 2, 0, { groupId: "M0" })]
    },
    R,
    ({ cpu, gpuGrid, env }) => {
      assert.equal(cpu.player.x, 2);
      assert.equal(actorPos(env, "weightless_box").x, 5);
      assert.equal(gpuGrid[5], WEIGHTLESS, "old pushGroup stopped on the first ice cell");
      assert.equal(gpuGrid[3], 4);
    }
  );

  await gpuMatch(
    "weightless pair slides as one body when every member lands on ice",
    {
      width: 8,
      ice: [2, 3, 4, 5, 6],
      actors: [
        actor("player", 0, 0),
        actor("weightless_box", 1, 0, { groupId: "M0" }),
        actor("weightless_box", 2, 0, { groupId: "M0" })
      ]
    },
    R,
    ({ cpu, gpuGrid }) => {
      assert.equal(cpu.player.x, 1);
      assert.equal(gpuGrid[6], WEIGHTLESS, "old pushGroup left the pair one cell over");
      assert.equal(gpuGrid[7], WEIGHTLESS);
      assert.equal(gpuGrid[2], 4);
      assert.equal(gpuGrid[3], 4);
    }
  );

  await gpuMatch(
    "puncher trains the player to the far floor",
    {
      width: 6,
      height: 1,
      terrain: floorTerrain(6, 1),
      actors: [actor("player", 0, 0), puncherActor("right", 1, 0)]
    },
    R,
    ({ cpu, gpuGrid, rolled }) => {
      assert.equal(cpu.player.x, 5);
      assert.equal(rolled.nextCaptures[0].px, 5, "old puncher only shoved one cell or stayed on the fixture");
      assert.equal(gpuGrid[5], PLAYER);
      assert.equal(gpuGrid[1], PUNCHER);
    }
  );

  await test("GPU puncher trains a box down the column", async () => {
    const env = await board({
      width: 4,
      height: 4,
      terrain: floorTerrain(4, 4),
      actors: [actor("player", 0, 0), actor("box", 1, 0), puncherActor("down", 2, 0)]
    });
    const cap = env.gpuCapture();
    const cpu = await env.step(R);
    const rolled = await ppo.gpuRollout([cap], 1, { actions: [R], maxActions: 64, seed: 1 });
    const gpuGrid = rolled.grids[0][0];
    assert.equal(cpu.player.x, 1);
    assert.equal(actorPos(env, "box").y, 3);
    assert.equal(rolled.nextCaptures[0].px, 1);
    assert.equal(gpuGrid[3 * 16 + 2], BOX, "old puncher left the box on the fixture cell");
    assert.equal(gpuGrid[2], PUNCHER);
  });

  await gpuMatch(
    "weightless_box into wall is illegal",
    {
      width: 5,
      walls: [3],
      actors: [actor("player", 1, 0), actor("weightless_box", 2, 0, { groupId: "M0" })]
    },
    R
  );

  await gpuMatch(
    "floating_floor push onto floor",
    { width: 5, actors: [actor("player", 1, 0), actor("floating_floor", 2, 0)] },
    R,
    ({ cpu, gpuGrid }) => {
      assert.equal(cpu.parts.pushes, 1);
      assert.equal(gpuGrid[3], FLOATING);
    }
  );

  await gpuMatch(
    "floating_floor fills a hole",
    { width: 4, holes: [2], actors: [actor("player", 0, 0), actor("floating_floor", 1, 0)] },
    R,
    ({ cpu, gpuGrid }) => {
      assert.equal(cpu.parts.pushes, 1);
      assert.equal(gpuGrid[1], PLAYER);
      assert.equal(gpuGrid[2], FLOOR);
    }
  );

  await gpuMatch(
    "floating_floor into wall is illegal",
    { width: 5, walls: [3], actors: [actor("player", 1, 0), actor("floating_floor", 2, 0)] },
    R
  );

  await gpuMatch(
    "ice slide does not shove a box",
    { width: 6, ice: [1, 2], actors: [actor("player", 0, 0), actor("box", 3, 0)] },
    R,
    ({ cpu, gpuGrid }) => {
      assert.equal(cpu.parts.pushes, 0);
      assert.equal(gpuGrid[3], BOX);
    }
  );

  await test("GPU mega kernel uses rollout pushWeight, not a hardcoded 0.05", async () => {
    const spec = { width: 5, actors: [actor("player", 1, 0), actor("box", 2, 0)] };
    const weights = { pushWeight: 0.4, noveltyBonus: 0, gemWeight: 0, roomWeight: 0, deathPenalty: 0 };
    const env = await board(spec, weights);
    const cap = env.gpuCapture();
    const rolled = await ppo.gpuRollout([cap], 1, {
      actions: [R],
      maxActions: 64,
      seed: 1,
      ...weights
    });
    assert.ok(
      Math.abs(rolled.rewards[0][0] - 0.4) < 1e-5,
      `expected 0.4 pushWeight, got ${rolled.rewards[0][0]}`
    );
  });

  await test("GPU mega kernel uses rollout gemWeight", async () => {
    const spec = { width: 4, actors: [actor("player", 0, 0), actor("gem", 1, 0)] };
    const weights = { gemWeight: 2.5, noveltyBonus: 0, pushWeight: 0, roomWeight: 0, deathPenalty: 0 };
    const env = await board(spec, weights);
    const cap = env.gpuCapture();
    const rolled = await ppo.gpuRollout([cap], 1, {
      actions: [R],
      maxActions: 64,
      seed: 1,
      ...weights
    });
    assert.ok(
      Math.abs(rolled.rewards[0][0] - 2.5) < 1e-5,
      `expected 2.5 gemWeight, got ${rolled.rewards[0][0]}`
    );
  });

  await test("GPU mega kernel uses rollout noveltyBonus", async () => {
    const spec = { width: 4, actors: [actor("player", 0, 0)] };
    const weights = { noveltyBonus: 0.2, gemWeight: 0, pushWeight: 0, roomWeight: 0, deathPenalty: 0 };
    const env = await board(spec, weights);
    const cap = env.gpuCapture();
    const rolled = await ppo.gpuRollout([cap], 1, {
      actions: [R],
      maxActions: 64,
      seed: 1,
      ...weights
    });
    assert.ok(
      Math.abs(rolled.rewards[0][0] - 0.2) < 1e-5,
      `expected 0.2 noveltyBonus, got ${rolled.rewards[0][0]}`
    );
  });

  await test("GPU second novel box dest still pays", async () => {
    const env = await board({ width: 6, actors: [actor("player", 1, 0), actor("box", 2, 0)] });
    const cap = env.gpuCapture();
    const rolled = await ppo.gpuRollout([cap], 2, { actions: [R, R], maxActions: 64, seed: 1 });
    assert.ok(rolled.rewards[0][0] >= 0.05 - 1e-6, `first push ${rolled.rewards[0][0]}`);
    assert.ok(rolled.rewards[1][0] >= 0.05 - 1e-6, `second dest ${rolled.rewards[1][0]}`);
    assert.equal(rolled.nextCaptures[0].px, 3);
    assert.equal(rolled.grids[1][0][4], BOX);
  });

  await gpuMatch(
    "two clones in one group push together",
    {
      width: 6,
      actors: [
        actor("player", 1, 0),
        actor("clone", 2, 0, { groupId: "C0" }),
        actor("clone", 3, 0, { groupId: "C0" })
      ]
    },
    R,
    ({ cpu, gpuGrid }) => {
      assert.equal(cpu.moved, true);
      assert.equal(cpu.parts.pushes, 0);
      assert.equal(gpuGrid[2], PLAYER);
      assert.equal(gpuGrid[3], 20);
      assert.equal(gpuGrid[4], 20);
    }
  );

  await test("GPU 2x2 groups survive an 8-step camera carry", async () => {
    const spec = {
      width: 6,
      height: 3,
      terrain: floorTerrain(6, 3),
      actors: [
        actor("player", 0, 1),
        actor("weightless_box", 1, 1, { groupId: "M0" }),
        actor("weightless_box", 2, 1, { groupId: "M0" }),
        actor("weightless_box", 1, 2, { groupId: "M0" }),
        actor("weightless_box", 2, 2, { groupId: "M0" })
      ]
    };
    const env = await makeBoardEnv(spec, { pushWeight: 1, noveltyBonus: 0, gemWeight: 0 });
    const first = await ppo.gpuRollout([env.gpuCapture()], 8, {
      actions: [6, 6, 6, 6, 6, 6, 6, 6],
      maxActions: 64,
      seed: 1,
      pushWeight: 1,
      noveltyBonus: 0,
      gemWeight: 0
    });
    const carry = first.nextCaptures[0];
    assert.ok(carry.groups, "nextCaptures must keep group ids");
    assert.equal(carry.groups[1 * 16 + 1], carry.groups[2 * 16 + 2]);
    assert.ok(carry.groups[1 * 16 + 1] > 0, "2x2 cells must share a nonzero group");
    const rolled = await ppo.gpuRollout([carry], 1, {
      actions: [R],
      maxActions: 64,
      seed: 1,
      pushWeight: 1,
      noveltyBonus: 0,
      gemWeight: 0
    });
    assert.ok(
      rolled.rewards[0][0] >= 3.9,
      `carried 2x2 should still pay 4, got ${rolled.rewards[0][0]}`
    );
  });

  await gpuMatch(
    "clone copies the player's walk and a wall only blocks the clone",
    {
      width: 3,
      height: 2,
      terrain: (() => {
        const t = floorTerrain(3, 2);
        t[1][1] = wallCell();
        return t;
      })(),
      actors: [actor("player", 0, 0), actor("clone", 0, 1, { groupId: "c0" })]
    },
    R,
    ({ cpu, gpuGrid, env }) => {
      assert.equal(cpu.player.x, 1);
      assert.deepEqual(actorPos(env, "clone"), { index: 1, x: 0, y: 1, elevation: 0 });
      assert.equal(gpuGrid[1], PLAYER);
      assert.equal(gpuGrid[16], 20);
    }
  );

  await gpuMatch(
    "raised orange wall is illegal",
    {
      width: 3,
      terrain: (() => {
        const t = floorTerrain(3, 1);
        t[0][1] = { type: "orange_wall" };
        return t;
      })(),
      actors: [actor("player", 0, 0)]
    },
    R
  );

  await gpuMatch(
    "box on orange button lowers the wall",
    {
      width: 3,
      terrain: (() => {
        const t = floorTerrain(3, 1);
        t[0][1] = { type: "orange_wall" };
        t[0][2] = { type: "orange_button" };
        return t;
      })(),
      actors: [actor("player", 0, 0), actor("box", 2, 0)]
    },
    R,
    ({ cpu }) => {
      assert.equal(cpu.moved, true);
      assert.equal(cpu.player.x, 1);
    }
  );

  await gpuMatch(
    "box pushed onto ice slides to the far floor",
    {
      width: 6,
      ice: [2, 3, 4],
      actors: [actor("player", 0, 0), actor("box", 1, 0)]
    },
    R,
    ({ cpu, gpuGrid, env }) => {
      assert.equal(cpu.player.x, 1);
      assert.equal(actorPos(env, "box").x, 5);
      assert.equal(gpuGrid[1], PLAYER);
      assert.equal(gpuGrid[5], BOX);
    }
  );

  await gpuMatch(
    "box sliding on ice stops before a wall",
    {
      width: 6,
      ice: [2, 3, 4],
      walls: [5],
      actors: [actor("player", 0, 0), actor("box", 1, 0)]
    },
    R,
    ({ cpu, gpuGrid, env }) => {
      assert.equal(actorPos(env, "box").x, 4);
      assert.equal(gpuGrid[4], BOX);
    }
  );

  await gpuMatch(
    "ice slide collects only the landing gem",
    {
      width: 4,
      ice: [1, 2],
      actors: [actor("player", 0, 0), actor("gem", 1, 0), actor("gem", 3, 0)]
    },
    R,
    ({ cpu }) => {
      assert.equal(cpu.player.x, 3);
      assert.equal(cpu.gemCount, 1);
    }
  );

  await test("GPU walking off the east edge loads the neighboring room", async () => {
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
    const env = await makeBoardEnv({
      levelId: "level_AxA",
      playCache: new Map([
        ["level_AxA", west],
        ["level_BxA", east]
      ]),
      roomWeight: 0.1,
      noveltyBonus: 0
    });
    const cap = env.gpuCapture();
    assert.ok(cap.worldAtlas, "world atlas missing");
    const rolled = await ppo.gpuRollout([cap], 1, {
      actions: [R],
      maxActions: 64,
      seed: 1,
      roomWeight: 0.1,
      noveltyBonus: 0,
      gemWeight: 0
    });
    assert.equal(rolled.nextCaptures[0].px, 0);
    assert.equal(rolled.nextCaptures[0].roomCol, 1);
    assert.ok(rolled.rewards[0][0] >= 0.1 - 1e-5, `room pay ${rolled.rewards[0][0]}`);
    assert.equal(rolled.grids[0][0][0], PLAYER);
  });

  await test("GPU collected gems stay gone after leaving and re-entering the room", async () => {
    const west = {
      width: 4,
      height: 1,
      terrain: floorTerrain(4, 1),
      actors: [actor("player", 0, 0), actor("gem", 1, 0)]
    };
    const east = {
      width: 4,
      height: 1,
      terrain: floorTerrain(4, 1),
      actors: [actor("player", 1, 0)]
    };
    const env = await makeBoardEnv({
      levelId: "level_AxA",
      playCache: new Map([
        ["level_AxA", west],
        ["level_BxA", east]
      ]),
      roomWeight: 0.1,
      noveltyBonus: 0,
      gemWeight: 1,
      pushWeight: 0
    });
    const rolled = await ppo.gpuRollout([env.gpuCapture()], 5, {
      actions: [R, R, R, R, L],
      maxActions: 64,
      seed: 1,
      roomWeight: 0.1,
      noveltyBonus: 0,
      gemWeight: 1,
      pushWeight: 0
    });
    assert.ok(rolled.rewards[0][0] >= 1 - 1e-5, `first gem pay ${rolled.rewards[0][0]}`);
    assert.equal(rolled.nextCaptures[0].roomCol, 0);
    assert.equal(rolled.nextCaptures[0].px, 3);
    assert.equal(rolled.nextCaptures[0].gemCount, 1);
    assert.notEqual(rolled.grids[4][0][1], GEM, "re-entered room must not restore the gem");
    for (let t = 1; t < 5; t += 1) {
      assert.ok(
        rolled.rewards[t][0] < 0.9,
        `gem must not pay twice at step ${t}: ${rolled.rewards[t][0]}`
      );
    }
  });

  await test("GPU novel push bits are room-scoped, not global cell dest", async () => {
    const west = {
      width: 3,
      height: 2,
      terrain: floorTerrain(3, 2),
      actors: [actor("player", 0, 0), actor("box", 1, 0)]
    };
    const east = {
      width: 3,
      height: 2,
      terrain: floorTerrain(3, 2),
      actors: [actor("player", 0, 1), actor("box", 1, 0)]
    };
    const env = await makeBoardEnv({
      levelId: "level_AxA",
      playCache: new Map([
        ["level_AxA", west],
        ["level_BxA", east]
      ]),
      roomWeight: 0,
      noveltyBonus: 0,
      gemWeight: 0,
      pushWeight: 0.05
    });
    const rolled = await ppo.gpuRollout([env.gpuCapture()], 6, {
      actions: [R, D, R, R, U, R],
      maxActions: 64,
      seed: 1,
      roomWeight: 0,
      noveltyBonus: 0,
      gemWeight: 0,
      pushWeight: 0.05
    });
    assert.equal(rolled.nextCaptures[0].roomCol, 1);
    assert.ok(rolled.rewards[0][0] >= 0.05 - 1e-6, `room A push ${rolled.rewards[0][0]}`);
    assert.ok(
      rolled.rewards[5][0] >= 0.05 - 1e-6,
      `room B same dest must still pay, got ${rolled.rewards[5][0]}`
    );
    assert.equal(rolled.grids[5][0][2], BOX);
  });

  await gpuMatch(
    "isolated board edge rails instead of dying in padding",
    { width: 3, actors: [actor("player", 2, 0)] },
    R,
    ({ cpu }) => {
      assert.equal(cpu.moved, false);
      assert.equal(cpu.playerDead, false);
    }
  );

  await test("GPU undo restores a floating-floor hole fill", async () => {
    const terrain = floorTerrain(5, 1);
    terrain[0][3] = holeCell();
    const env = await board({
      width: 5,
      height: 1,
      terrain,
      actors: [actor("player", 0, 0), actor("floating_floor", 1, 0)]
    });
    const cap = env.gpuCapture();
    const rolled = await ppo.gpuRollout([cap], 3, {
      actions: [R, R, 8],
      maxActions: 64,
      seed: 1
    });
    const gpuGrid = rolled.grids[2][0];
    assert.equal(rolled.nextCaptures[0].px, 1);
    assert.equal(gpuGrid[1], PLAYER);
    assert.equal(gpuGrid[2], FLOATING);
    assert.equal(rolled.nextCaptures[0].under[3] & 255, HOLE, "undo must restore the hole, not the filled floor");
  });

  await test("GPU undo restores a lift raise", async () => {
    const terrain = floorTerrain(3, 1);
    terrain[0][1] = liftCell();
    const env = await board({
      width: 3,
      height: 1,
      terrain,
      actors: [actor("player", 0, 0)]
    });
    const cap = env.gpuCapture();
    const rolled = await ppo.gpuRollout([cap], 2, {
      actions: [R, 8],
      maxActions: 64,
      seed: 1
    });
    assert.equal(rolled.nextCaptures[0].px, 0);
    assert.equal(rolled.grids[1][0][0], PLAYER);
    assert.equal((rolled.nextCaptures[0].under[1] >> 16) & 255, 0, "undo must clear the raised lift bit");
  });

  await gpuMatch(
    "clone walking onto a gem does not collect it",
    {
      width: 5,
      actors: [actor("player", 0, 0), actor("clone", 2, 0, { groupId: "c0" }), actor("gem", 3, 0)]
    },
    R,
    ({ cpu, gpuGrid, env }) => {
      assert.equal(cpu.gemCount, 0);
      assert.deepEqual(actorPos(env, "clone"), { index: 1, x: 3, y: 0, elevation: 0 });
      assert.equal(gpuGrid[3], GEM);
    }
  );

  await test("GPU undo restores a box push", async () => {
    const env = await board({ width: 5, actors: [actor("player", 1, 0), actor("box", 2, 0)] });
    const cap = env.gpuCapture();
    const rolled = await ppo.gpuRollout([cap], 2, {
      actions: [R, 8],
      maxActions: 64,
      seed: 1
    });
    assert.equal(rolled.nextCaptures[0].px, 1);
    assert.equal(rolled.grids[1][0][1], PLAYER);
    assert.equal(rolled.grids[1][0][2], BOX);
  });

  await test("GPU reset restores the entry after a push", async () => {
    const env = await board({ width: 5, actors: [actor("player", 1, 0), actor("box", 2, 0)] });
    const cap = env.gpuCapture();
    const rolled = await ppo.gpuRollout([cap], 3, {
      actions: [R, R, 9],
      maxActions: 64,
      seed: 1
    });
    assert.equal(rolled.nextCaptures[0].px, 1);
    assert.equal(rolled.grids[2][0][1], PLAYER);
    assert.equal(rolled.grids[2][0][2], BOX);
  });

  await test("GPU HxI 2x2 still pushes after 8-step collect carry", async () => {
    const env = await makeEnv({ maxActions: 256, pushWeight: 1, noveltyBonus: 0, gemWeight: 0 });
    const grid = encodeGrid(env.engine, env.state);
    const index = env.engine.actorTypes.findIndex((type) => type === "player" || type === "circle_player");
    const start = { x: env.state.actorX[index], y: env.state.actorY[index] };
    const dirs = [
      { a: 0, dx: 0, dy: -1 },
      { a: 1, dx: 0, dy: 1 },
      { a: 2, dx: -1, dy: 0 },
      { a: 3, dx: 1, dy: 0 }
    ];
    function walkable(x, y) {
      if (x < 0 || y < 0 || x > 15 || y > 15) return false;
      const t = grid[y * 16 + x];
      return t === 1 || t === 16;
    }
    const goal = { x: 10, y: 5 };
    const q = [{ x: start.x, y: start.y, path: [] }];
    const seen = new Set([`${start.x},${start.y}`]);
    let path = null;
    while (q.length) {
      const cur = q.shift();
      if (cur.x === goal.x && cur.y === goal.y) {
        path = cur.path;
        break;
      }
      for (const d of dirs) {
        const nx = cur.x + d.dx;
        const ny = cur.y + d.dy;
        const k = `${nx},${ny}`;
        if (seen.has(k) || !walkable(nx, ny)) continue;
        seen.add(k);
        q.push({ x: nx, y: ny, path: cur.path.concat([d.a]) });
      }
    }
    assert.ok(path, "HxI must have a floor path to the east face of the blue block");
    const actions = path.concat([2]);
    assert.ok(actions.length > 8, `expected a long approach, got ${actions.length}`);
    const first = await ppo.gpuRollout([env.gpuCapture()], 8, {
      actions: actions.slice(0, 8),
      maxActions: 256,
      seed: 1,
      pushWeight: 1,
      noveltyBonus: 0,
      gemWeight: 0
    });
    assert.ok(first.nextCaptures[0].groups, "HxI carry must keep groups");
    assert.ok(first.nextCaptures[0].groups[5 * 16 + 8] > 0, "blue block group dropped after 8 steps");
    const rest = await ppo.gpuRollout([first.nextCaptures[0]], actions.length - 8, {
      actions: actions.slice(8),
      maxActions: 256,
      seed: 1,
      pushWeight: 1,
      noveltyBonus: 0,
      gemWeight: 0
    });
    const last = rest.grids[rest.grids.length - 1][0];
    const boxes = [];
    for (let i = 0; i < 256; i += 1) if (last[i] === 19) boxes.push(`${i % 16},${Math.floor(i / 16)}`);
    const pay = rest.rewards[rest.rewards.length - 1][0];
    assert.ok(pay >= 3.9, `chunked HxI push pay ${pay}`);
    assert.deepEqual(boxes.sort(), ["7,5", "7,6", "8,5", "8,6"]);
  });

  console.log("train-push tests passed");
  process.exit(0);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
