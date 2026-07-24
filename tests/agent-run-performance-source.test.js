const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentRunService } = require("../server/agent-runs");

const root = path.join(__dirname, "..");
const runService = fs.readFileSync(path.join(root, "server", "agent-runs.js"), "utf8");
const runScript = fs.readFileSync(path.join(root, "public", "agent-run.js"), "utf8");
const router = fs.readFileSync(path.join(root, "server", "router.js"), "utf8");
const siteTheme = fs.readFileSync(path.join(root, "public", "local-site.css"), "utf8");

assert.match(runService, /const actionCache = new Map\(\)/);
assert.match(runService, /const start = cached\?\.size \|\| 0/);
assert.match(runService, /delete previous\.level/);
assert.match(runService, /const LARGE_TELEMETRY_REFRESH_MS = 10_000/);
assert.match(runService, /Date\.now\(\) - cached\.checkedAt < LARGE_TELEMETRY_REFRESH_MS/);
assert.match(runService, /const MAX_SYNCHRONOUS_HISTORY_REPLAY_ACTIONS = 500/);
assert.match(runService, /if \(actions\.length > MAX_SYNCHRONOUS_HISTORY_REPLAY_ACTIONS\) return null/);
assert.match(runService, /actions: tokenUsage\.actions\.filter/);
assert.match(runService, /reasoning\.filter\(\(entry\)/);
assert.match(runService, /apiPricingForRun\(summary, listProviderModels\("prime"\)\.models\)/);
assert.match(runScript, /const FEED_RENDER_BATCH = 200/);
assert.doesNotMatch(runScript, /frame\?turn=/);
assert.doesNotMatch(runScript, /mayRenderLiveFrame/);
assert.match(runScript, /function drawAsciiBitmap\(board, turn = null\)/);
assert.match(runScript, /context\.createImageData\(width, height\)/);
assert.match(runScript, /if \(liveBitmap\.width !== width\) liveBitmap\.width = width/);
assert.match(runScript, /if \(!drawAsciiBitmap\.palette\)/);
assert.match(runScript, /if \(wasHidden\) requestAnimationFrame\(fitAsciiBoard\)/);
assert.doesNotMatch(runScript, /document\.querySelectorAll\("\[data-jump-turn\]"\)/);
assert.match(runScript, /state\.currentJumpControl/);
assert.match(runService, /function getRunObservations\(runId/);
assert.match(router, /segments\[4\] === "observations"/);
assert.doesNotMatch(runScript, /function maybeRenderLocalFrame/);
assert.doesNotMatch(runService, /LIVE_RENDERER_IDLE_MS/);
assert.doesNotMatch(runService, /function renderLiveFrame\(/);
assert.doesNotMatch(runService, /liveFrameLocks/);
assert.doesNotMatch(router, /renderLiveFrame/);
assert.match(runScript, /const renderedMoveNums = hiddenMoveCount > 0 \? moveNums\.slice\(-state\.feedRenderLimit\) : moveNums/);
assert.match(runScript, /data-feed-load-more/);
assert.match(runScript, /state\.tokenUsagePoints\.set\(action/);
assert.match(runScript, /\$\$\{pricing\.input\}\/M in · \$\$\{pricing\.output\}\/M out/);
assert.match(siteTheme, /\.agent-feed__load-more \{/);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-run-performance-"));
const runId = "perf-run-123";
const runDir = path.join(tempRoot, "outputs", "maze-local", "site", runId);
fs.mkdirSync(runDir, { recursive: true });
const loadJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
};
const game = { id: "maze", name: "Maze", worldMap: { levels: [{ id: "level_HxI" }] } };
const service = createAgentRunService({
  agentEnvironment: () => ({ docker: false, docker_installed: false }),
  ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
  getGame: () => game,
  buildWorlds: { countWorldGems: () => 1 },
  loadJson,
  rootDir: tempRoot,
  worldMaps: {
    defaultLevelIdForGame: () => "level_HxI",
    isMazeWorldLevelId: () => true
  }
});
fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({
  id: runId,
  kind: "local",
  model: "codex",
  model_name: "test-model",
  game_id: "maze",
  game_title: "Maze",
  level_id: "level_HxI",
  mode: "text",
  moves: 500,
  status: "finished",
  finished_at: new Date().toISOString()
}));
fs.writeFileSync(path.join(runDir, "initial-status.json"), JSON.stringify({ player: { x: 0, y: 0 } }));
const actionLine = (turn) => JSON.stringify({
  turn,
  command_text: "right",
  status: {
    current_room: "level_HxI",
    gem_count: 0,
    player: { x: turn % 16, y: 0 },
    level: "W".repeat(4096)
  }
});
fs.writeFileSync(
  path.join(runDir, "actions.jsonl"),
  `${Array.from({ length: 450 }, (_, index) => actionLine(index + 1)).join("\n")}\n`
);
fs.writeFileSync(
  path.join(runDir, "reasoning.json"),
  JSON.stringify(Array.from({ length: 450 }, (_, index) => ({ move: index + 1, reasoning: `Move ${index + 1}` })))
);

const initialProgress = service.getRunProgress(runId);
assert.equal(initialProgress.actions.length, 450);
assert.equal(initialProgress.actions.filter((action) => action.level).length, 1);
assert.ok(Buffer.byteLength(JSON.stringify(initialProgress.actions)) < 150_000);

fs.appendFileSync(path.join(runDir, "actions.jsonl"), `${actionLine(451)}\n`);
const incrementalProgress = service.getRunProgress(runId, { afterTurn: 450, logOffset: 0 });
assert.deepEqual(incrementalProgress.actions.map((action) => action.turn), [451]);
assert.equal(incrementalProgress.actions[0].level.length, 4096);
assert.ok(incrementalProgress.reasoning.length <= 6);

fs.mkdirSync(path.join(runDir, "frames"), { recursive: true });
fs.writeFileSync(path.join(runDir, "frames", "frame-451.png"), "legacy exact frame");
fs.writeFileSync(path.join(runDir, "frames", "live-451.png"), "legacy live frame");
const textObservation = service.getRunObservation(runId, { turn: 451 });
assert.equal(textObservation.frame_url, null, "ASCII history must not expose cached 3D frames");
const observationBatch = service.getRunObservations(runId, { fromTurn: 448, limit: 10 });
assert.deepEqual(observationBatch.observations.map((observation) => observation.turn), [448, 449, 450, 451]);
assert.ok(observationBatch.observations.every((observation) => observation.board.length === 4096));
assert.equal(
  service.resolveRunFilePath(runId, "frames/live-451.png"),
  null,
  "legacy live-render PNGs are no longer served"
);

const oversizedRunId = "perf-run-oversized";
const oversizedRunDir = path.join(tempRoot, "outputs", "maze-local", "site", oversizedRunId);
const replayMarker = path.join(tempRoot, "legacy-replay-started");
const legacyTopBoard = (worldX, worldY, yaw = 0) => {
  const roomSize = 16;
  const tileSize = 4;
  const normalizedYaw = (yaw % 4 + 4) % 4;
  const display = normalizedYaw === 1
    ? { x: roomSize - 1 - worldY, y: worldX }
    : normalizedYaw === 2
      ? { x: roomSize - 1 - worldX, y: roomSize - 1 - worldY }
      : normalizedYaw === 3
        ? { x: worldY, y: roomSize - 1 - worldX }
        : { x: worldX, y: worldY };
  const rows = Array.from(
    { length: roomSize * tileSize },
    () => Array.from({ length: roomSize * tileSize }, () => "q")
  );
  for (let row = display.y * tileSize; row < (display.y + 1) * tileSize; row += 1) {
    for (let column = display.x * tileSize; column < (display.x + 1) * tileSize; column += 1) {
      rows[row][column] = "P";
    }
  }
  return rows.map((row) => row.join("")).join("\n");
};
fs.mkdirSync(oversizedRunDir, { recursive: true });
fs.mkdirSync(path.join(tempRoot, "scripts"), { recursive: true });
fs.writeFileSync(
  path.join(tempRoot, "scripts", "maze-bridge.js"),
  `require("node:fs").writeFileSync(${JSON.stringify(replayMarker)}, "started");\n`
);
fs.writeFileSync(path.join(oversizedRunDir, "run.json"), JSON.stringify({
  id: oversizedRunId,
  kind: "local",
  model: "codex",
  model_name: "legacy-test-model",
  game_id: "maze",
  game_title: "Maze",
  level_id: "level_HxI",
  mode: "text",
  moves: null,
  unlimited: true,
  status: "paused"
}));
fs.writeFileSync(path.join(oversizedRunDir, "initial-status.json"), JSON.stringify({
  board_state_hash: "initial-v3",
  board_state_hash_version: 3,
  current_room: "level_HxI",
  current_view: "top",
  level: legacyTopBoard(0, 0),
  yaw: 0
}));
fs.writeFileSync(
  path.join(oversizedRunDir, "actions.jsonl"),
  `${Array.from({ length: 501 }, (_, index) => JSON.stringify({
    turn: index + 1,
    command_text: "right",
    status: {
      board_state_hash: `state-${index + 1}`,
      board_state_hash_version: 3,
      current_room: "level_HxI",
      current_view: "top",
      level: legacyTopBoard((index + 1) % 16, Math.floor((index + 1) / 16) % 16, index % 4),
      yaw: index % 4
    }
  })).join("\n")}\n`
);

const oversizedProgress = service.getRunProgress(oversizedRunId);
assert.equal(oversizedProgress.actions.length, 500);
assert.deepEqual(oversizedProgress.history_sync, { current: 500, total: 501, complete: false });
assert.deepEqual(oversizedProgress.initial_player, { x: 0, y: 0 });
assert.deepEqual(oversizedProgress.actions[0].player, { x: 1, y: 0 });
assert.deepEqual(oversizedProgress.actions[499].player, {
  x: 500 % 16,
  y: Math.floor(500 / 16) % 16
});
assert.equal(
  fs.existsSync(replayMarker),
  false,
  "oversized legacy heatmaps must not synchronously replay history on the HTTP server thread"
);
const oversizedFinalProgress = service.getRunProgress(oversizedRunId, { afterTurn: 500 });
assert.deepEqual(oversizedFinalProgress.actions.map((action) => action.turn), [501]);
assert.deepEqual(oversizedFinalProgress.actions[0].player, {
  x: 501 % 16,
  y: Math.floor(501 / 16) % 16
});
assert.deepEqual(oversizedFinalProgress.history_sync, { current: 501, total: 501, complete: true });
assert.equal(fs.existsSync(replayMarker), false);

fs.rmSync(tempRoot, { recursive: true, force: true });

console.log("agent-run-performance-source: OK — large runs use incremental server reads and a bounded move-feed DOM.");
