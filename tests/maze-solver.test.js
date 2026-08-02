const assert = require("node:assert/strict");
const { loadBrowserScript } = require("./helpers/browser-module-loader");

global.window = {};
loadBrowserScript("public/maze-engine.js");
loadBrowserScript("public/maze-solver.js");

const { createEngine } = window.MazeEngine;
const {
  SolverCostStore,
  findHardestGemPlacement,
  findReachablePositions,
  solveWithAStar
} = window.MazeSolver;

function floorTerrain(width, height) {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ type: "floor" }))
  );
}

(async () => {
  {
    const costs = new SolverCostStore();
    const firstBucketKey = String.fromCharCode(1, 2, 3, 4);
    const secondBucketKey = String.fromCharCode(2, 2, 3, 4);

    costs.set(firstBucketKey, 7).set(secondBucketKey, 9).set(firstBucketKey, 5);
    assert.equal(costs.get(firstBucketKey), 5);
    assert.equal(costs.get(secondBucketKey), 9);
    assert.equal(
      costs.buckets.filter(Boolean).reduce((sum, bucket) => sum + bucket.size, 0),
      2
    );
    assert.equal(costs.buckets.filter(Boolean).length, 2);

    // Exercise more total entries than a deliberately small per-bucket
    // threshold without allocating millions of objects. The production
    // state hash distributes the same way across all 65,536 possible buckets.
    const perBucketThreshold = 8;
    for (let bucket = 0; bucket < 32; bucket += 1) {
      for (let entry = 0; entry < perBucketThreshold; entry += 1) {
        costs.set(String.fromCharCode(bucket, entry, 17, 23), bucket + entry);
      }
    }
    assert.equal(
      costs.buckets.filter(Boolean).reduce((sum, bucket) => sum + bucket.size, 0) > perBucketThreshold,
      true
    );
    assert.equal(
      costs.buckets.filter(Boolean).every((bucket) => bucket.size <= perBucketThreshold + 1),
      true
    );
  }

  {
    const progressEvents = [];
    const engine = createEngine({
      width: 4,
      height: 1,
      terrain: floorTerrain(4, 1),
      actors: [
        { type: "player", x: 0, y: 0, removed: false },
        { type: "gem", x: 3, y: 0, removed: false }
      ]
    });
    const result = await solveWithAStar(engine, {
      maxExpandedStates: null,
      onProgress: (progress) => progressEvents.push(progress),
      progressYieldStateInterval: 1
    });

    assert.equal(result.status, "solved");
    assert.equal(result.path, "RRR");
    assert.equal(progressEvents.some((progress) => progress.maxExpanded === Infinity), true);
  }

  {
    const progressEvents = [];
    const engine = createEngine({
      width: 3,
      height: 1,
      terrain: floorTerrain(3, 1),
      actors: [
        { type: "player", x: 0, y: 0, removed: false },
        { type: "gem", x: 2, y: 0, removed: false }
      ]
    });

    const result = await solveWithAStar(engine, {
      maxExpandedStates: 100,
      onProgress: (progress) => {
        progressEvents.push(progress);
      },
      progressYieldStateInterval: 1
    });

    assert.equal(result.status, "solved");
    assert.equal(result.moves, 2);
    assert.equal(result.path, "RR");
    assert.equal(progressEvents.length > 0, true);
  }

  {
    const engine = createEngine({
      width: 4,
      height: 1,
      terrain: floorTerrain(4, 1),
      actors: [
        { type: "player", x: 0, y: 0, removed: false },
        { type: "gem", x: 3, y: 0, removed: false }
      ]
    });
    const capped = await solveWithAStar(engine, { maxExpandedStates: 1 });

    assert.equal(capped.status, "capped");
    assert.equal(capped.expanded, 1);
    assert.ok(capped.continuation);
    assert.equal(capped.continuation.bestCostByKey instanceof SolverCostStore, true);

    const continued = await solveWithAStar(engine, {
      additionalExpandedStates: 100,
      continuation: capped.continuation
    });

    assert.equal(continued.status, "solved");
    assert.equal(continued.path, "RRR");
    assert.equal(continued.expanded >= capped.expanded, true);
  }

  {
    // Regression: a gem collected before the engine was created (mid-session
    // state) must not count as an instant solve; the solver has to path to
    // the remaining live gem instead of returning an empty path.
    const engine = createEngine({
      width: 3,
      height: 1,
      terrain: floorTerrain(3, 1),
      actors: [
        { type: "player", x: 0, y: 0, removed: false },
        { type: "gem", x: 0, y: 0, removed: true },
        { type: "gem", x: 2, y: 0, removed: false }
      ]
    });

    const result = await solveWithAStar(engine, {
      maxExpandedStates: 100,
      progressYieldStateInterval: 1
    });

    assert.equal(result.status, "solved");
    assert.equal(result.moves, 2);
    assert.equal(result.path, "RR");
  }

  {
    const engine = createEngine({
      width: 4,
      height: 1,
      terrain: floorTerrain(4, 1),
      actors: [{ type: "player", x: 0, y: 0, removed: false }]
    });
    const capped = await findHardestGemPlacement(engine, {
      canPlaceGemAt: (x, y) => x === 3 && y === 0,
      maxExpandedStates: 1
    });

    assert.equal(capped.status, "capped");
    assert.ok(capped.continuation);

    const continued = await findHardestGemPlacement(engine, {
      additionalExpandedStates: 100,
      continuation: capped.continuation
    });

    assert.equal(continued.status, "found");
    assert.equal(continued.candidate.x, 3);
    assert.equal(continued.candidate.path, "RRR");
  }

  {
    const engine = createEngine({
      width: 3,
      height: 1,
      terrain: floorTerrain(3, 1),
      actors: [
        { type: "player", x: 0, y: 0, removed: false },
        { type: "gem", x: 2, y: 0, removed: false }
      ]
    });

    const result = await solveWithAStar(engine, {
      algorithm: "bfs",
      maxExpandedStates: 100,
      progressYieldStateInterval: 1
    });

    assert.equal(result.status, "solved");
    assert.equal(result.moves, 2);
    assert.equal(result.path, "RR");
  }

  {
    const engine = createEngine({
      width: 16,
      height: 16,
      terrain: floorTerrain(16, 16),
      actors: [
        { type: "player", x: 0, y: 0, removed: false },
        { type: "gem", x: 15, y: 0, removed: false }
      ]
    });

    const result = await solveWithAStar(engine, {
      algorithm: "astar",
      maxExpandedStates: 1000,
      progressYieldStateInterval: 1000
    });

    assert.equal(result.status, "solved");
    assert.equal(result.moves, 15);
    assert.equal(result.expanded <= 20, true);
  }

  {
    const engine = createEngine({
      width: 3,
      height: 1,
      terrain: floorTerrain(3, 1),
      actors: [
        { type: "player", x: 0, y: 0, removed: false },
        { type: "gem", x: 2, y: 0, removed: false }
      ]
    });

    await assert.rejects(
      () =>
        solveWithAStar(engine, {
          maxExpandedStates: 100,
          signal: { aborted: true }
        }),
      /Solver cancelled/
    );
  }

  {
    const engine = createEngine({
      width: 3,
      height: 1,
      terrain: floorTerrain(3, 1),
      actors: [{ type: "player", x: 0, y: 0, removed: false }]
    });

    const result = await findHardestGemPlacement(engine, {
      canPlaceGemAt: (x, y) => x === 2 && y === 0,
      maxExpandedStates: 100,
      progressYieldStateInterval: 1
    });

    assert.equal(result.status, "found");
    assert.deepEqual(
      {
        x: result.candidate.x,
        y: result.candidate.y,
        moves: result.candidate.moves,
        path: result.candidate.path
      },
      {
        x: 2,
        y: 0,
        moves: 2,
        path: "RR"
      }
    );
  }

  {
    const engine = createEngine({
      width: 3,
      height: 2,
      terrain: [
        [{ type: "floor" }, { type: "floor" }, { type: "floor" }],
        [{ type: "wall" }, { type: "wall" }, { type: "wall" }]
      ],
      actors: [{ type: "player", x: 0, y: 0, removed: false }]
    });
    const result = await findReachablePositions(engine, [
      { id: "near", x: 1, y: 0, elevation: 0 },
      { id: "far", x: 2, y: 0, elevation: 0 },
      { id: "blocked", x: 1, y: 1, elevation: 0 }
    ], { progressYieldStateInterval: 1 });

    assert.equal(result.status, "exhausted");
    assert.deepEqual(
      result.reachable.map((target) => ({ id: target.id, path: target.path })),
      [{ id: "near", path: "R" }, { id: "far", path: "RR" }]
    );
    assert.deepEqual(result.unreachable.map((target) => target.id), ["blocked"]);
  }

  {
    const engine = createEngine({
      width: 4,
      height: 1,
      terrain: floorTerrain(4, 1),
      actors: [{ type: "player", x: 0, y: 0, removed: false }]
    });
    const targets = [{ id: "far", x: 3, y: 0, elevation: 0 }];
    const capped = await findReachablePositions(engine, targets, { maxExpandedStates: 1 });

    assert.equal(capped.status, "capped");
    assert.ok(capped.continuation);

    const continued = await findReachablePositions(engine, targets, {
      additionalExpandedStates: 100,
      continuation: capped.continuation
    });

    assert.equal(continued.status, "found_all");
    assert.equal(continued.reachable[0].path, "RRR");
  }

  {
    const wallSurface = { type: "wall", layers: [{ type: "wall", elevation: 0 }] };
    const engine = createEngine({
      width: 2,
      height: 1,
      terrain: [[wallSurface, wallSurface]],
      actors: [{ type: "player", x: 0, y: 0, elevation: 1, removed: false }]
    });

    const result = await findHardestGemPlacement(engine, {
      canPlaceGemAt: (x, y, elevation) => x === 1 && y === 0 && elevation === 1,
      maxExpandedStates: 100,
      progressYieldStateInterval: 1
    });

    assert.equal(result.status, "found");
    assert.deepEqual(
      {
        elevation: result.candidate.elevation,
        x: result.candidate.x,
        y: result.candidate.y,
        moves: result.candidate.moves,
        path: result.candidate.path
      },
      {
        elevation: 1,
        x: 1,
        y: 0,
        moves: 1,
        path: "R"
      }
    );
  }

  console.log("maze solver tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
