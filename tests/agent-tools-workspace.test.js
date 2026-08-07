const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createAgentRunService } = require("../server/agent-runs");

const projectRoot = path.join(__dirname, "..");
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-tools-workspace-"));
const serviceRootDir = `${rootDir}-symlink`;
fs.symlinkSync(rootDir, serviceRootDir, "dir");
const workspaceRoots = [];

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

const service = createAgentRunService({
  agentEnvironment: () => ({ codex: true, claude: true, kimi: true }),
  ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
  getGame: () => ({ id: "maze", name: "Maze", worldMap: { levels: [] } }),
  buildWorlds: { countWorldGems: () => 0 },
  loadJson,
  rootDir: serviceRootDir,
  worldMaps: {
    defaultLevelIdForGame: () => "level_HxI",
    isMazeWorldLevelId: () => true
  }
});

function prepareRun(runId, model = "codex", kind = "local") {
  const runDir = path.join(rootDir, "outputs", "maze-local", "site", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify({
    id: runId,
    kind,
    created_at: "2026-07-22T00:00:00.000Z",
    finished_at: "2026-07-22T00:01:00.000Z",
    status: "finished",
    model: kind === "prime" ? "prime" : model,
    provider: kind === "prime" ? "prime" : model,
    model_name: "test-model",
    game_id: "maze",
    game_title: "Maze",
    level_id: "level_HxI",
    room_total: 0,
    gem_total: 0,
    moves: 1,
    tool_use: "offline",
    tools: true,
    mode: "text",
    launch_params: { tool_use: "offline", tools: true }
  }, null, 2)}\n`);
  const key = crypto.createHash("sha256").update(fs.realpathSync(runDir)).digest("hex").slice(0, 24);
  const workspaceRoot = path.join(os.tmpdir(), "mazebench-agent-workspaces", key);
  workspaceRoots.push(workspaceRoot);
  return { runDir, workspaceRoot, workspace: path.join(workspaceRoot, "workspace") };
}

try {
  const runId = "2026-07-22T00-00-00-000-tools01";
  const { runDir, workspace } = prepareRun(runId);
  fs.mkdirSync(path.join(workspace, "maps"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "plan.py"), "print('route')\n");
  fs.writeFileSync(path.join(workspace, "maps", "room.txt"), "HxI\n");
  const outside = path.join(rootDir, "outside-secret.txt");
  fs.writeFileSync(outside, "not visible through workspace API\n");
  fs.symlinkSync(outside, path.join(workspace, "outside-link"));

  const repeatedCode = "print('route')";
  const repeatedHash = crypto.createHash("sha256").update(repeatedCode).digest("hex");
  const activity = [
    {
      id: "python-1",
      tool: "python_exec",
      actor: "lead",
      started_at: "2026-07-22T00:00:01.000Z",
      status: "running",
      python_code: repeatedCode,
      python_code_hash: repeatedHash,
      timeout_seconds: 10
    },
    {
      id: "python-1",
      tool: "python_exec",
      actor: "lead",
      started_at: "2026-07-22T00:00:01.000Z",
      completed_at: "2026-07-22T00:00:01.125Z",
      duration_ms: 125,
      status: "completed",
      python_code_hash: repeatedHash,
      python_result: { exit_code: 0, stdout: "route\n", stderr: "", cpu_time_ms: 12.5, timed_out: false, output_truncated: false },
      workspace_changes: { created: ["plan.py"], modified: [], deleted: [], truncated: false }
    },
    {
      id: "python-2",
      tool: "python_exec",
      actor: "lead",
      started_at: "2026-07-22T00:00:02.000Z",
      completed_at: "2026-07-22T00:00:02.050Z",
      duration_ms: 50,
      status: "completed",
      python_code: repeatedCode,
      python_code_hash: repeatedHash,
      timeout_seconds: 10,
      python_result: { exit_code: 0, stdout: "route\n", stderr: "", cpu_time_ms: 7.5, timed_out: false, output_truncated: false }
    },
    {
      id: "python-3",
      tool: "python_exec",
      actor: "lead",
      started_at: "2026-07-22T00:00:03.000Z",
      status: "running",
      python_code: "while True: pass",
      python_code_hash: crypto.createHash("sha256").update("while True: pass").digest("hex"),
      timeout_seconds: 10
    }
  ];
  fs.writeFileSync(path.join(runDir, "tool-activity.jsonl"), `${activity.map(JSON.stringify).join("\n")}\n`);

  const progress = service.getRunProgress(runId);
  assert.equal(progress.tools_workspace.available, true);
  assert.deepEqual(progress.tools_workspace.counts, {
    executions: 3,
    duration_ms: 175,
    active: 1,
    unique_commands: 2,
    files: 2,
    total_bytes: 19
  });
  const primary = progress.tools_workspace.workspaces.find((entry) => entry.id === "primary");
  assert.equal(primary.virtual_path, "/workspace");
  assert.equal(primary.total_bytes, 19);
  assert(primary.entries.some((entry) => entry.path === "plan.py" && entry.type === "file"));
  assert(primary.entries.some((entry) => entry.path === "maps/room.txt" && entry.type === "file"));
  assert(primary.entries.some((entry) => entry.path === "outside-link" && entry.type === "symlink"));
  assert.equal(progress.tools_workspace.executions[0].id, "python-3", "latest execution appears first");
  assert.equal(progress.tools_workspace.executions.find((entry) => entry.id === "python-1").repeat_count, 2);
  assert.equal(progress.tools_workspace.executions.find((entry) => entry.id === "python-2").repeat_index, 2);

  const detail = service.getToolExecution(runId, "python-1");
  assert.equal(detail.code, repeatedCode);
  assert.equal(detail.stdout, "route\n");
  assert.equal(Object.prototype.hasOwnProperty.call(detail, "cpu_time_ms"), false);
  assert.deepEqual(detail.workspace_changes.created, ["plan.py"]);

  const file = service.getToolWorkspaceFile(runId, "primary", "maps/room.txt");
  assert.equal(file.virtual_path, "/workspace/maps/room.txt");
  assert.equal(file.content, "HxI\n");
  assert.equal(service.getToolWorkspaceFile(runId, "primary", "../outside-secret.txt"), null);
  assert.equal(service.getToolWorkspaceFile(runId, "primary", "outside-link"), null);

  const primeId = "2026-07-22T00-00-00-000-prime01";
  const prime = prepareRun(primeId, "prime", "prime");
  fs.mkdirSync(prime.workspace, { recursive: true });
  fs.writeFileSync(path.join(prime.workspace, "prime-plan.py"), "print('prime route')\n");
  fs.writeFileSync(path.join(prime.runDir, "tool-activity.jsonl"), [
    {
      id: "prime-python",
      tool: "python_exec",
      actor: "lead",
      started_at: "2026-07-22T00:00:05.000Z",
      completed_at: "2026-07-22T00:00:05.010Z",
      duration_ms: 10,
      status: "completed",
      python_code: "print('prime route')",
      python_result: { exit_code: 0, stdout: "prime route\n", stderr: "" }
    }
  ].map(JSON.stringify).join("\n") + "\n");
  const primeProgress = service.getRunProgress(primeId);
  assert.equal(primeProgress.tools_workspace.available, true);
  assert.equal(primeProgress.tools_workspace.counts.executions, 1);
  assert.equal(service.getToolExecution(primeId, "prime-python").stdout, "prime route\n");
  assert.equal(
    service.getToolWorkspaceFile(primeId, "primary", "prime-plan.py").content,
    "print('prime route')\n"
  );

  const kimiId = "2026-07-22T00-00-00-000-kimi001";
  const kimi = prepareRun(kimiId, "kimi");
  const kimiMeta = loadJson(path.join(kimi.runDir, "run.json"), {});
  fs.writeFileSync(
    path.join(kimi.runDir, "run.json"),
    `${JSON.stringify({ ...kimiMeta, model_name: "kimi/k3" }, null, 2)}\n`
  );
  const kimiWire = path.join(kimi.workspaceRoot, "kimi-home", "sessions", "wd", "session", "agents", "main", "wire.jsonl");
  fs.mkdirSync(path.dirname(kimiWire), { recursive: true });
  fs.writeFileSync(kimiWire, [
    { type: "llm.request", maxTokens: 1000 },
    { type: "context.append_loop_event", event: { type: "tool.call", toolCallId: "move-1", name: "mcp__mazebench__maze_action", args: { action: "right" } } },
    { type: "context.append_loop_event", event: { type: "tool.result", toolCallId: "move-1", result: { output: "{}" } } },
    { type: "usage.record", usageScope: "turn", usage: { inputOther: 10, inputCacheRead: 20, inputCacheCreation: 0, output: 5 } }
  ].map(JSON.stringify).join("\n") + "\n");
  const initialKimiUsage = service.getRunProgress(kimiId).token_usage;
  assert.equal(initialKimiUsage.available, true);
  assert.equal(initialKimiUsage.total_tokens, 35);
  assert.equal(initialKimiUsage.context_window, 1000);
  assert.equal(initialKimiUsage.current_context_tokens, 35);
  fs.appendFileSync(kimiWire, [
    { type: "llm.request", maxTokens: 965 },
    { type: "usage.record", usageScope: "turn", usage: { inputOther: 2, inputCacheRead: 30, inputCacheCreation: 0, output: 3 } }
  ].map(JSON.stringify).join("\n") + "\n");
  const refreshedKimiUsage = service.getRunProgress(kimiId).token_usage;
  assert.equal(refreshedKimiUsage.total_tokens, 70, "live Kimi usage invalidates the run-page cache");
  assert.equal(refreshedKimiUsage.cached_input_tokens, 50);

  const legacyId = "2026-07-22T00-00-00-000-tools02";
  const legacy = prepareRun(legacyId, "codex");
  fs.mkdirSync(legacy.workspace, { recursive: true });
  fs.writeFileSync(path.join(legacy.runDir, "tool-activity.jsonl"), [
    { id: "legacy-python", tool: "python_exec", actor: "lead", started_at: "2026-07-22T00:00:04.000Z", status: "running" },
    { id: "legacy-python", tool: "python_exec", actor: "lead", started_at: "2026-07-22T00:00:04.000Z", completed_at: "2026-07-22T00:00:04.100Z", duration_ms: 100, status: "completed" }
  ].map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(path.join(legacy.runDir, "agent-events.jsonl"), [
    {
      type: "item.started",
      item: { id: "item-legacy", type: "mcp_tool_call", server: "mazebench", tool: "python_exec", arguments: { code: "print(42)" }, status: "in_progress" },
      _mazebench_received_at: "2026-07-22T00:00:04.010Z"
    },
    {
      type: "item.completed",
      item: {
        id: "item-legacy",
        type: "mcp_tool_call",
        server: "mazebench",
        tool: "python_exec",
        arguments: { code: "print(42)" },
        result: { structured_content: { exit_code: 0, stdout: "42\n", stderr: "", timed_out: false, output_truncated: false } },
        status: "completed"
      },
      _mazebench_received_at: "2026-07-22T00:00:04.110Z"
    }
  ].map(JSON.stringify).join("\n") + "\n");
  const legacyProgress = service.getRunProgress(legacyId);
  assert.equal(legacyProgress.tools_workspace.executions.length, 1);
  assert.equal(legacyProgress.tools_workspace.executions[0].code_preview, "print(42)");
  assert.equal(service.getToolExecution(legacyId, "legacy-python").stdout, "42\n");

  const pages = fs.readFileSync(path.join(projectRoot, "server", "pages.js"), "utf8");
  const agentRunsSource = fs.readFileSync(path.join(projectRoot, "server", "agent-runs.js"), "utf8");
  const client = fs.readFileSync(path.join(projectRoot, "public", "agent-run.js"), "utf8");
  const theme = fs.readFileSync(path.join(projectRoot, "public", "local-site.css"), "utf8");
  const router = fs.readFileSync(path.join(projectRoot, "server", "router.js"), "utf8");
  assert.match(pages, /id="run-tools-section"/);
  const primeSections = pages.match(/const mazeSections = isPrime\s+\? `([\s\S]*?)`\s+: `/)?.[1];
  assert(primeSections, "Prime run page branch is present");
  assert.match(primeSections, /\$\{toolsSection\}/);
  assert.match(pages, /id="run-tools-duration"/);
  assert.match(pages, /id="run-tools-file-size">0 B<\/strong><small>Total file size/);
  assert.doesNotMatch(pages, /Total CPU time/);
  assert.match(pages, /Each call is saved to a visible <code>\.py<\/code> file before that file runs/);
  assert.match(client, /function renderToolsWorkspace\(data\)/);
  assert.match(client, /function liveToolsWallTime\(data, now = Date\.now\(\)\)/);
  assert.match(client, /toolsFileSize\.textContent = formatBytes\(totalBytes\)/);
  assert.match(client, /window\.setInterval\(\(\) => refreshLiveToolsTiming\(\), 250\)/);
  assert.match(client, /data-tool-status-label/);
  assert.match(client, /saved as \$\{escapeText\(execution\.script_path\)\}/);
  assert.doesNotMatch(client, /Total CPU time/);
  const liveTimingSource = client.match(/function liveToolsWallTime[\s\S]*?\n  }\n\n  function refreshLiveToolsTiming/)?.[0]
    .replace(/\n\n  function refreshLiveToolsTiming$/, "");
  assert(liveTimingSource, "live wall-time helper is present");
  const liveToolsWallTime = vm.runInNewContext(`(${liveTimingSource})`);
  assert.equal(liveToolsWallTime({
    counts: { duration_ms: 175 },
    executions: [
      { status: "completed", started_at: "2026-07-22T00:00:01.000Z", duration_ms: 125 },
      { status: "running", started_at: "2026-07-22T00:00:03.000Z", duration_ms: 0 }
    ]
  }, Date.parse("2026-07-22T00:00:05.000Z")), 2175);
  assert.match(client, /execution\.status === "cancelled"/);
  assert.match(client, /data-tool-execution/);
  assert.match(client, /data-workspace-file/);
  assert.match(client, /data-workspace-directory/);
  assert.match(client, /directoryPath === "observations"/);
  assert.match(client, /aria-expanded="\$\{collapsed \? "false" : "true"\}"/);
  assert.match(client, /toolsCollapsedDirectories: new Map\(\)/);
  assert.match(client, /const childrenByParent = new Map\(\)/);
  assert.match(client, /const renderEntry = \(entry\) =>/);
  assert.match(client, /childrenByParent\.get\(String\(entry\.path \|\| ""\)\)/);
  assert.match(client, /childrenByParent\.get\(""\)/);
  assert.match(agentRunsSource, /const pending = \[\{ directory: descriptor\.directory, prefix: "" \}\]/);
  assert.match(agentRunsSource, /prefix === "observations"/);
  assert.match(theme, /\.run-tools__grid \{/);
  assert.match(theme, /\.run-tools__execution\.is-cancelled/);
  assert.match(router, /segments\[5\] === "execution"/);
  assert.match(router, /segments\[5\] === "file"/);
} finally {
  workspaceRoots.forEach((workspaceRoot) => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  fs.rmSync(serviceRootDir, { force: true });
  fs.rmSync(rootDir, { recursive: true, force: true });
}

console.log("agent-tools-workspace: OK — live Python commands and scratch files are visible without widening agent access.");
