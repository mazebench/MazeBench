const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const messages = [];
const context = {
  console,
  Date,
  Number,
  setTimeout,
  clearTimeout,
  postMessage(message) {
    messages.push(message);
  }
};
context.self = context;
vm.createContext(context);
context.importScripts = (...names) => {
  for (const name of names) {
    const source = fs.readFileSync(path.join(root, "public", name), "utf8");
    vm.runInContext(source, context, { filename: name });
  }
};

vm.runInContext(
  fs.readFileSync(path.join(root, "public", "author-solver-worker.js"), "utf8"),
  context,
  { filename: "author-solver-worker.js" }
);

function floorTerrain(width, height) {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ type: "floor" }))
  );
}

async function waitForDone(id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const done = messages.find((message) => message.type === "done" && message.id === id);
    if (done) return done;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for author solver worker job " + id + ".");
}

(async () => {
  context.onmessage({
    data: {
      type: "run",
      id: 1,
      op: "solve",
      playData: {
        width: 4,
        height: 1,
        terrain: floorTerrain(4, 1),
        actors: [
          { type: "player", x: 0, y: 0, removed: false },
          { type: "gem", x: 3, y: 0, removed: false }
        ]
      },
      options: { algorithm: "astar", maxExpandedStates: 1 }
    }
  });

  const capped = await waitForDone(1);
  assert.equal(capped.result.status, "capped");
  assert.equal(capped.result.expanded, 1);
  assert.ok(capped.continuationId);

  context.onmessage({
    data: {
      type: "continue",
      id: 2,
      continuationId: capped.continuationId,
      options: { additionalExpandedStates: 100 }
    }
  });

  const continued = await waitForDone(2);
  assert.equal(continued.result.status, "solved");
  assert.equal(continued.result.path, "RRR");
  assert.equal(continued.result.expanded >= capped.result.expanded, true);
  assert.equal(continued.continuationId, "");

  context.onmessage({
    data: {
      type: "run",
      id: 3,
      op: "solve",
      playData: {
        width: 4,
        height: 1,
        terrain: floorTerrain(4, 1),
        actors: [
          { type: "player", x: 0, y: 0, removed: false },
          { type: "gem", x: 3, y: 0, removed: false }
        ]
      },
      options: { algorithm: "astar", maxExpandedStates: null }
    }
  });

  const unlimited = await waitForDone(3);
  assert.equal(unlimited.result.status, "solved");
  assert.equal(unlimited.result.path, "RRR");
  assert.equal(unlimited.continuationId, "");
  console.log("author-solver-worker: OK — capped editor searches resume from their saved frontier.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
