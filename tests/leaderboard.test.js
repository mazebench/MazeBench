const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentRunService } = require("../server/agent-runs");

const root = path.join(__dirname, "..");
const pagesSource = fs.readFileSync(path.join(root, "server", "pages.js"), "utf8");
const routerSource = fs.readFileSync(path.join(root, "server", "router.js"), "utf8");
const chromeSource = fs.readFileSync(path.join(root, "server", "page-chrome.js"), "utf8");
const clientSource = fs.readFileSync(path.join(root, "public", "leaderboard.js"), "utf8");
const themeSource = fs.readFileSync(path.join(root, "public", "local-site.css"), "utf8");

assert.match(pagesSource, /renderLeaderboardPage/);
assert.match(pagesSource, /data-x-axis="move_count"/);
assert.match(pagesSource, /data-x-axis="api_cost_usd"/);
assert.match(pagesSource, /data-x-axis="input_tokens"/);
assert.match(chromeSource, /href="\/leaderboard">Leaderboard/);
assert.match(routerSource, /agentRuns\.getLeaderboardRun/);
assert.match(clientSource, /fable-5-1/);
assert.match(clientSource, /companyForRun\(left\)\.localeCompare\(companyForRun\(right\)\)/);
assert.match(clientSource, /Number\(right\.gem_count\).*Number\(left\.gem_count\)/);
assert.match(clientSource, /milestoneLineSeries/);
assert.match(clientSource, /if \(point\.y === lastScore\) continue/);
assert.match(clientSource, /return `L \$\{px\.toFixed\(2\)\} \$\{py\.toFixed\(2\)\}`/);
assert.match(clientSource, /leaderboard-chart__point/);
assert.match(clientSource, /leaderboard-chart__series-label/);
assert.match(clientSource, /function renderHeatmaps\(entries\)/);
assert.match(clientSource, /function paintHeatmapComparison\(canvas, heatmap, bounds, maxCount\)/);
assert.match(clientSource, /function heatmapColumnsFromUrl\(\)/);
assert.match(pagesSource, /id="leaderboard-heatmaps"/);
assert.match(pagesSource, /data-heatmap-columns="2"[\s\S]*data-heatmap-columns="3"/);
assert.match(themeSource, /\.leaderboard-chart__line/);
assert.match(themeSource, /\.leaderboard-heatmaps__grid/);
assert.match(themeSource, /\.leaderboard-heatmaps__grid\[data-columns="3"\]/);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-leaderboard-"));
const runId = "2026-09-01T12-00-00-000-fable51";
const runDir = path.join(tempRoot, "outputs", "maze-local", "site", runId);
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({
  id: runId,
  kind: "local",
  model: "claude",
  model_name: "claude-fable-5-1",
  game_id: "maze",
  game_title: "Maze Bench Environment",
  level_id: "level_HxI",
  mode: "text",
  tool_use: "offline",
  moves: 10,
  status: "paused",
  created_at: "2026-09-01T12:00:00.000Z"
}));
fs.writeFileSync(path.join(runDir, "favorite.json"), JSON.stringify({
  schema_version: 1,
  favorite: true,
  favorited_at: "2026-09-01T12:01:00.000Z"
}));
fs.writeFileSync(path.join(runDir, "initial-status.json"), JSON.stringify({
  player: { x: 0, y: 0, elevation: 0 }
}));
fs.writeFileSync(path.join(runDir, "actions.jsonl"), [
  { turn: 1, command_text: "up", status: { gem_count: 1, current_room: "level_HxI", player: { x: 1, y: 2 } } },
  { turn: 2, command_text: "right", status: { gem_count: 2, current_room: "level_IxI", player: { x: 3, y: 4 } } }
].map((row) => JSON.stringify(row)).join("\n") + "\n");
fs.writeFileSync(path.join(runDir, "agent-events.jsonl"), JSON.stringify({
  type: "result",
  modelUsage: {
    "claude-fable-5-1": {
      inputTokens: 100,
      cacheReadInputTokens: 50,
      outputTokens: 20,
      costUSD: 0.05,
      contextWindow: 1_000_000
    }
  }
}) + "\n");

const loadJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
};
const service = createAgentRunService({
  agentEnvironment: () => ({ docker: false, docker_installed: false }),
  ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
  getGame: () => ({ id: "maze", name: "Maze", worldMap: { levels: [{ id: "level_HxI" }] } }),
  buildWorlds: { countWorldGems: () => 0 },
  loadJson,
  rootDir: tempRoot,
  worldMaps: {
    defaultLevelIdForGame: () => "level_HxI",
    isMazeWorldLevelId: () => true
  }
});

try {
  const comparison = service.getLeaderboardRun(runId);
  assert.equal(comparison.run.model_name, "claude-fable-5-1");
  assert.equal(comparison.run.turns, 2);
  assert.equal(comparison.points.length, 3, "move zero plus both actions are charted");
  assert.deepEqual(comparison.points.map((point) => point.gems), [0, 1, 2]);
  assert.deepEqual(comparison.points.map((point) => point.rooms), [1, 1, 2]);
  assert.equal(comparison.points.at(-1).input_tokens, 150);
  assert.equal(comparison.points.at(-1).api_cost_usd, comparison.usage.api_cost_usd);
  assert.ok(comparison.usage.api_cost_usd > 0);
  assert.equal(comparison.usage.approximate_timeline, true);
  assert.equal(comparison.heatmap.total_visits, 3, "move zero and both action positions are counted");
  assert.equal(comparison.heatmap.unique_cells, 3);
  assert.equal(comparison.heatmap.rooms.length, 2);
  assert.deepEqual(comparison.heatmap.cells, [[112, 128, 1], [113, 130, 1], [131, 132, 1]]);

  service.setRunFavorite(runId, false);
  assert.equal(service.getLeaderboardRun(runId), null, "unstarred runs leave the curated API");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("leaderboard: OK — starred runs expose chart-ready moves, tokens, price, gems, and rooms.");
