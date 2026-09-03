const assert = require("node:assert/strict");
const { actor, floorTerrain, iceCell, loadCpuHarness, makeBoardEnv, makeEnv, playData, test } = require("./helpers/train-env-fixture");

async function runCpuTests() {
  const { TrainEnv, TrainPpo } = loadCpuHarness();
  const { encodeGrid, encodeAux, screenMoveVector, ACTIONS, N_ACTIONS, AUX_DIM, GRID } = TrainEnv;

  await test("grid encoding writes terrain and actors into 16x16 cells", () => {
    const engine = {
      width: 16,
      height: 16,
      actorCount: 2,
      actorTypes: ["box", "player"]
    };
    const state = {
      terrain: new Uint8Array(256),
      actorX: new Int32Array([1, 3]),
      actorY: new Int32Array([2, 4]),
      actorElevation: new Float32Array([0, 0]),
      actorRemoved: new Uint8Array([0, 0])
    };
    state.terrain[0] = 2;
    const grid = encodeGrid(engine, state);
    assert.equal(grid.length, GRID * GRID);
    assert.equal(grid[0], 2);
    assert.equal(grid[2 * 16 + 1], 18);
    assert.equal(grid[4 * 16 + 3], 16);
  });

  await test("action table and camera-relative moves stay locked", () => {
    assert.equal(ACTIONS.length, N_ACTIONS);
    assert.equal(ACTIONS[8].command, "undo");
    assert.equal(ACTIONS[9].command, "reset_level");
    assert.equal(screenMoveVector("R", 0).dx, 1);
    assert.equal(screenMoveVector("U", 0).dy, -1);
    assert.equal(screenMoveVector("U", 2).dy, 1);
    assert.equal(screenMoveVector("R", 1).dx, 0);
    assert.equal(screenMoveVector("R", 1).dy, -1);
  });

  await test("aux features match the live observation contract", () => {
    const aux = encodeAux(
      {
        yaw: 3,
        pitch: 4,
        playerDead: true,
        gemCount: 9,
        visited: ["a", "b"],
        actionCount: 64,
        novelPushCount: 10,
        moved: true
      },
      128
    );
    assert.equal(aux.length, AUX_DIM);
    assert.equal(aux[0], 1);
    assert.equal(aux[1], 1);
    assert.equal(aux[2], 1);
    assert.ok(Math.abs(aux[3] - 9 / 90) < 1e-6);
    assert.ok(Math.abs(aux[5] - 64 / 128) < 1e-6);
    assert.equal(aux[7], 1);
  });

  await test("playback expansion walks one cell at a time", () => {
    const { walkManhattan, expandPlaybackFrames } = TrainEnv;
    assert.deepEqual(walkManhattan(1, 1, 3, 1), [
      { x: 2, y: 1 },
      { x: 3, y: 1 }
    ]);
    const prev = new Uint8Array(256);
    prev[1 * 16 + 1] = 16;
    const next = new Uint8Array(256);
    next[1 * 16 + 3] = 16;
    const frames = expandPlaybackFrames(
      prev,
      { x: 1, y: 1 },
      next,
      { x: 3, y: 1 },
      { path: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }] }
    );
    assert.equal(frames.length, 2);
    assert.equal(frames[0].grid[1 * 16 + 2], 16);
    assert.equal(frames[0].grid[1 * 16 + 1], 1);
    assert.equal(frames[1].grid[1 * 16 + 3], 16);
  });

  await test("softmax, mask, and GAE stay numerically stable", () => {
    const probs = TrainPpo.softmax(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    assert.equal(probs.length, 10);
    assert.ok(Math.abs(probs[0] - 0.1) < 1e-6);
    assert.ok(Math.abs(probs.reduce((sum, p) => sum + p, 0) - 1) < 1e-6);
    const masked = TrainPpo.maskedLogits(new Float32Array(10), [
      false, false, false, false, false, false, false, false, true, true
    ]);
    assert.equal(masked[0], -1e9);
    assert.equal(masked[8], 0);
    const gae = TrainPpo.computeGae([[1], [0]], [[0], [0]], [[false], [true]], [0], 0.99, 0.95);
    assert.equal(gae.advantages.length, 2);
    assert.ok(Math.abs(gae.advantages[0][0] - 1) < 1e-6);
    assert.ok(Math.abs(gae.returns[0][0] - 1) < 1e-6);
  });
}

async function runEnvTests() {
  await test("two fresh envs match on reset and the first step", async () => {
    const envA = await makeEnv();
    const envB = await makeEnv();
    const firstA = envA.snapshot();
    const firstB = envB.snapshot();
    assert.equal(firstA.hash, firstB.hash);
    assert.equal(firstA.grid.length, 256);
    assert.equal(firstA.aux.length, 8);
    assert.equal(firstA.mask.filter(Boolean).length, 10);
    const afterA = await envA.step(0);
    const afterB = await envB.step(0);
    assert.equal(afterA.hash, afterB.hash);
    assert.notEqual(afterA.hash, firstA.hash);
    assert.equal(typeof afterA.reward, "number");
    assert.ok(Number.isFinite(afterA.reward));
    assert.equal(afterA.actionCount, 1);
  });

  await test("camera rotate updates yaw and does not pay novelty", async () => {
    const envA = await makeEnv();
    const rotated = await envA.step(6);
    assert.equal(rotated.yaw, 3);
    assert.equal(rotated.done, false);
    assert.equal(rotated.parts.novel, 0);
    assert.equal(rotated.reward, 0);
  });

  await test("maxActions ends the episode", async () => {
    const env = await makeEnv({ maxActions: 2 });
    assert.equal((await env.step(7)).done, false);
    const last = await env.step(7);
    assert.equal(last.done, true);
    assert.equal(last.reason, "max_actions");
  });

  await test("an ice slide records a multi-cell travel path", async () => {
    const terrain = floorTerrain(4, 1);
    terrain[0][1] = iceCell();
    terrain[0][2] = iceCell();
    const env = await makeBoardEnv({
      width: 4,
      height: 1,
      terrain,
      actors: [actor("player", 0, 0)]
    });
    const { TrainEnv } = loadCpuHarness();
    const start = env.snapshot();
    const stepped = await env.step(3);
    assert.equal(stepped.player.x, 3);
    assert.ok(stepped.travelPath.length >= 2, "ice should expose a travel path");
    const frames = TrainEnv.expandPlaybackFrames(
      start.grid,
      start.player,
      stepped.grid,
      stepped.player,
      { path: stepped.travelPath }
    );
    assert.ok(frames.length >= 2, "playback must not skip ice cells");
  });

  await test("start level is a 16x16 maze room", () => {
    const start = playData();
    assert.equal(start.playData.width, 16);
    assert.equal(start.playData.height, 16);
  });
}

async function main() {
  await runCpuTests();
  await runEnvTests();
  console.log("train-harness tests passed");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
