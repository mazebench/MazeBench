const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentRunService } = require("../server/agent-runs");

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-run-review-"));
const runId = "review-test-run";
const runDir = path.join(rootDir, "outputs", "maze-local", "site", runId);
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(
  path.join(runDir, "run.json"),
  `${JSON.stringify({
    id: runId,
    kind: "local",
    status: "finished",
    created_at: new Date().toISOString(),
    model: "codex",
    model_name: "gpt-5.6-sol",
    game_id: "maze",
    level_id: "level_HxI",
    mode: "text",
    gem_total: 70,
    room_total: 256
  }, null, 2)}\n`
);

const game = { id: "maze", name: "Maze", worldMap: { levels: [{ id: "level_HxI" }] } };
const service = createAgentRunService({
  agentEnvironment: () => ({ codex: true, claude: true }),
  buildWorlds: { countWorldGems: () => 70 },
  ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
  getGame: () => game,
  loadJson,
  rootDir,
  worldMaps: { defaultLevelIdForGame: () => "level_HxI", isMazeWorldLevelId: () => true }
});

try {
  assert.equal(service.getRunReview(runId).status, "idle");
  assert.throws(
    () => service.generateRunReview(runId),
    /Provider-backed run reviews are retired because they grant a host agent repository and run-file access/
  );
  assert.throws(() => service.generateRunReview("missing-run"), /Unknown run/);

  fs.writeFileSync(
    path.join(runDir, "run-review.json"),
    `${JSON.stringify({
      schema_version: 1,
      status: "completed",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning: "max",
      review: "# Historical review",
      error: ""
    }, null, 2)}\n`
  );
  assert.equal(service.getRunReview(runId).review, "# Historical review");
  assert.equal(service.summarizeRun(runId).review_ready, true);

  fs.writeFileSync(
    path.join(runDir, "run-review.json"),
    `${JSON.stringify({
      schema_version: 1,
      generation_id: "interrupted-review",
      status: "running",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning: "ultra",
      started_at: new Date().toISOString(),
      review: "",
      error: ""
    }, null, 2)}\n`
  );
  const interrupted = service.getRunReview(runId);
  assert.equal(interrupted.status, "failed");
  assert.match(interrupted.error, /server restarted/i);
} finally {
  fs.rmSync(rootDir, { recursive: true, force: true });
}

console.log("agent run review tests passed");
