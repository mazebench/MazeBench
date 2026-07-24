const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-mcp-test-"));
const leadWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-mcp-workspace-"));
const jsonBridgeWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-json-workspace-"));
const routeEscapeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-route-escape-"));
const codexAvailable = spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0;
let httpChild = null;

try {
  const terminalProbe = spawnSync(
    process.execPath,
    [
      "-e",
      `const {compactStatus,kimiResultIsTerminal}=require(${JSON.stringify(path.join(rootDir, "scripts", "maze-mcp-server.js"))});` +
        `process.stdout.write(JSON.stringify({` +
          `compactBelow:compactStatus({gem_count:2,game_won:true,solved:true}).game_won,` +
          `compactWon:compactStatus({gem_count:100}).game_won,` +
          `kimiBelow:kimiResultIsTerminal({final_observation:{gem_count:2,game_won:true,solved:true}},{clone_id:"test-worker"}),` +
          `kimiWon:kimiResultIsTerminal({final_observation:{gem_count:100}},{clone_id:"test-worker"})` +
        `}));`
    ],
    {
      cwd: rootDir,
      encoding: "utf8",
      env: {
        ...process.env,
        MAZEBENCH_RUN_DIR: runDir,
        MAZEBENCH_SESSION_FILE: path.join(runDir, "terminal-probe-session.json")
      }
    }
  );
  assert.equal(terminalProbe.status, 0, terminalProbe.stderr);
  assert.deepEqual(JSON.parse(terminalProbe.stdout), {
    compactBelow: false,
    compactWon: true,
    kimiBelow: false,
    kimiWon: true
  });

  const seededFramePath = path.join(runDir, "frames", "frame-000.png");
  fs.mkdirSync(path.dirname(seededFramePath), { recursive: true });
  fs.writeFileSync(seededFramePath, Buffer.from("89504e470d0a1a0a", "hex"));
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "maze_start", arguments: {} } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "maze_action", arguments: { action: "right" } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "maze_action", arguments: { action: "down" } } },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "python_exec", arguments: { code: "from pathlib import Path\nimport runpy\nPath('notes.txt').write_text('mapped', encoding='utf-8')\nPath('planner.py').write_text('def next_move():\\n    return \\\"up\\\"\\n', encoding='utf-8')\nplanner = runpy.run_path('planner.py')\nprint(planner['next_move']())" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "maze_clone", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "maze_action", arguments: { clone_id: "guessed-worker", action: "up" } } },
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "maze_workers", arguments: {} } }
  ];
  const result = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: runDir,
      MAZEBENCH_SESSION_FILE: path.join(runDir, "session.json"),
      MAZEBENCH_SWARM_DIR: path.join(runDir, "swarm"),
      MAZEBENCH_AGENT_WORKSPACE_DIR: leadWorkspace,
      MAZEBENCH_SWARM: "1",
      MAZEBENCH_MAX_SWARM_WORKERS: "2",
      MAZEBENCH_MOVE_BUDGET: "1"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const firstObservation = responses.find((response) => response.id === 2)?.result?.structuredContent;
  assert.deepEqual(Object.keys(firstObservation || {}), [
    "observation_mode",
    "current_room",
    "current_view",
    "yaw",
    "gem_count",
    "visited_levels",
    "player_dead",
    "game_won",
    "game_lost",
    "level",
    "ascii_legend"
  ]);
  assert.equal(firstObservation.observation_mode, "ascii");
  assert.match(firstObservation.level, /P|p/);
  assert.equal(firstObservation.visited_levels.length, 1);
  assert.match(firstObservation.visited_levels[0], /^level_[A-P]x[A-P]$/);
  assert.equal(Object.prototype.hasOwnProperty.call(firstObservation, "player"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(firstObservation, "scorecard"), false);
  const listedTools = responses.find((response) => response.id === 10)?.result?.tools || [];
  assert.deepEqual(listedTools.map((tool) => tool.name), ["maze_start", "maze_observe", "maze_action", "maze_workers", "python_exec"]);
  const listedPython = listedTools.find((tool) => tool.name === "python_exec");
  assert.match(listedPython?.description || "", /writable persistent isolated scratch workspace/);
  assert.match(listedPython?.description || "", /relative-path files[\s\S]*persist for the run/);
  assert.doesNotMatch(JSON.stringify(listedTools), /clone_id|maze_clone/i);
  assert.equal(listedTools.some((tool) => /scorecard/i.test(tool.name)), false);
  assert(responses.find((response) => response.id === 3)?.error, "the lead cannot call maze_clone");
  assert(responses.find((response) => response.id === 4)?.error, "the lead cannot supply clone_id");
  assert.deepEqual(responses.find((response) => response.id === 9)?.result?.structuredContent, []);

  const primary = JSON.parse(fs.readFileSync(path.join(runDir, "session.json"), "utf8"));
  assert.equal(primary.actions.length, 1, "the lead gets exactly its configured action budget");
  assert.equal(primary.maxActions, 1, "the helper cap must match the selected finite budget");
  assert.equal(Number.isFinite(Date.parse(primary.actions[0].timestamp)), true, "maze actions retain their exact timestamp");
  assert(fs.existsSync(path.join(runDir, "initial-status.json")));
  assert.equal(fs.existsSync(path.join(runDir, "current-render-state.json")), false);
  assert.equal(responses.find((response) => response.id === 6)?.result?.isError, true, "the MCP boundary enforces the lead budget");
  const pythonResponse = responses.find((response) => response.id === 7)?.result;
  if (codexAvailable) {
    assert.equal(pythonResponse?.structuredContent?.stdout, "up\n");
    assert.equal(
      pythonResponse?.structuredContent?.cpu_time_ms,
      undefined,
      "trusted CPU telemetry must not be exposed to the evaluated agent"
    );
    assert.equal(fs.readFileSync(path.join(leadWorkspace, "notes.txt"), "utf8"), "mapped");
    assert.match(fs.readFileSync(path.join(leadWorkspace, "planner.py"), "utf8"), /def next_move/);
  } else {
    assert.equal(pythonResponse?.isError, true, "python_exec fails closed without the Codex sandbox CLI");
    assert.match(pythonResponse?.content?.[0]?.text || "", /Codex executable was not found on PATH/);
  }

  const sequenceDir = path.join(runDir, "sequence");
  fs.mkdirSync(sequenceDir, { recursive: true });
  const longRoute = Array.from({ length: 40 }, (_, index) =>
    index % 2 === 0 ? "rotate camera left" : "rotate camera right"
  );
  const sequenceRequests = [
    { jsonrpc: "2.0", id: 70, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 71, method: "tools/call", params: { name: "maze_start", arguments: {} } },
    {
      jsonrpc: "2.0",
      id: 72,
      method: "tools/call",
      params: {
        name: "maze_action_sequence",
        arguments: { actions: ["rotate camera left", "rotate camera right"] }
      }
    },
    {
      jsonrpc: "2.0",
      id: 73,
      method: "tools/call",
      params: {
        name: "maze_action_sequence",
        arguments: { actions: longRoute, include_intermediate_observations: true }
      }
    }
  ];
  const sequenceResult = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${sequenceRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: sequenceDir,
      MAZEBENCH_SESSION_FILE: path.join(sequenceDir, "session.json"),
      MAZEBENCH_AUTO_RUN_TOOLS: "1",
      MAZEBENCH_MOVE_BUDGET: "5"
    },
    timeout: 240000
  });
  assert.equal(sequenceResult.status, 0, sequenceResult.stderr);
  const sequenceResponses = sequenceResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const sequenceTools = sequenceResponses.find((response) => response.id === 70)?.result?.tools || [];
  assert(sequenceTools.some((tool) => tool.name === "maze_action_sequence"));
  assert.equal(
    sequenceTools.find((tool) => tool.name === "maze_action_sequence")?.inputSchema?.properties?.actions?.maxItems,
    undefined,
    "solver routes must not have an arbitrary action-count ceiling"
  );
  const compactSequence = sequenceResponses.find((response) => response.id === 72)?.result?.structuredContent;
  assert.equal(compactSequence.requested_count, 2);
  assert.equal(compactSequence.completed_count, 2);
  assert.equal(compactSequence.intermediate_observations, undefined);
  assert.match(compactSequence.final_observation.level, /P|p/);
  const auditedSequence = sequenceResponses.find((response) => response.id === 73)?.result?.structuredContent;
  assert.equal(auditedSequence.requested_count, 40, "routes longer than the former 32-move cap are accepted");
  assert.equal(auditedSequence.completed_count, 3);
  assert.equal(auditedSequence.stopped_early, true);
  assert.equal(auditedSequence.stop_reason, "move_budget_exhausted");
  assert.equal(auditedSequence.intermediate_observations.length, 2);
  assert.match(auditedSequence.final_observation.level, /P|p/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(sequenceDir, "session.json"), "utf8")).actions.length, 5);
  const sequenceActivity = fs.readFileSync(path.join(sequenceDir, "tool-activity.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line))
    .filter((entry) => entry.tool === "maze_action_sequence" && entry.status === "completed");
  assert.deepEqual(sequenceActivity.map((entry) => entry.move_calls), [2, 3]);
  const sequenceEvents = fs.readFileSync(path.join(sequenceDir, "maze-instance-events.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(sequenceEvents.length, 5, "every batched move remains individually visible in telemetry");

  const allFramesDir = path.join(runDir, "all-frames");
  fs.mkdirSync(allFramesDir, { recursive: true });
  const allFramesRequests = [
    { jsonrpc: "2.0", id: 80, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 81, method: "tools/call", params: { name: "maze_start", arguments: {} } },
    {
      jsonrpc: "2.0",
      id: 82,
      method: "tools/call",
      params: {
        name: "maze_action_sequence",
        arguments: {
          actions: ["rotate camera left", "rotate camera right", "rotate camera left"],
          include_intermediate_observations: false
        }
      }
    }
  ];
  const allFramesResult = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${allFramesRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: allFramesDir,
      MAZEBENCH_SESSION_FILE: path.join(allFramesDir, "session.json"),
      MAZEBENCH_AUTO_RUN_TOOLS: "1",
      MAZEBENCH_AUTO_RUN_ALL_FRAMES: "1",
      MAZEBENCH_MOVE_BUDGET: "3"
    },
    timeout: 240000
  });
  assert.equal(allFramesResult.status, 0, allFramesResult.stderr);
  const allFramesResponses = allFramesResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const allFramesTool = allFramesResponses.find((response) => response.id === 80)?.result?.tools
    ?.find((tool) => tool.name === "maze_action_sequence");
  assert.equal(allFramesTool?.inputSchema?.properties?.include_intermediate_observations?.default, true);
  const enforcedFrames = allFramesResponses.find((response) => response.id === 82)?.result?.structuredContent;
  assert.equal(enforcedFrames.completed_count, 3);
  assert.equal(enforcedFrames.intermediate_observations.length, 2);
  assert.match(enforcedFrames.intermediate_observations[0].observation.level, /P|p/);
  assert.match(enforcedFrames.final_observation.level, /P|p/);

  const longHistoryDir = path.join(runDir, "long-history-sequence");
  fs.mkdirSync(longHistoryDir, { recursive: true });
  const longHistorySessionPath = path.join(longHistoryDir, "session.json");
  const longHistoryStart = spawnSync(
    process.execPath,
    [
      path.join(rootDir, "scripts", "codex-play.js"),
      "start",
      "--repo-root", rootDir,
      "--state", longHistorySessionPath,
      "--max-actions", "unlimited"
    ],
    { cwd: rootDir, encoding: "utf8" }
  );
  assert.equal(longHistoryStart.status, 0, longHistoryStart.stderr);
  const longHistorySession = JSON.parse(fs.readFileSync(longHistorySessionPath, "utf8"));
  longHistorySession.actions = Array.from({ length: 1000 }, (_, index) => ({
    turn: index + 1,
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    command_text: index % 2 === 0 ? "rotate camera left" : "rotate camera right",
    valid: true,
    error: null,
    message: {
      command: "rotate_camera",
      direction: index % 2 === 0 ? "left" : "right"
    },
    status: longHistorySession.initial
  }));
  longHistorySession.lastStatus = longHistorySession.initial;
  fs.writeFileSync(longHistorySessionPath, `${JSON.stringify(longHistorySession, null, 2)}\n`);
  fs.writeFileSync(
    path.join(longHistoryDir, "actions.jsonl"),
    `${longHistorySession.actions.map((action) => JSON.stringify(action)).join("\n")}\n`
  );
  const fastRoute = Array.from({ length: 100 }, (_, index) =>
    index % 2 === 0 ? "rotate camera left" : "rotate camera right"
  );
  const longHistoryRequests = [{
    jsonrpc: "2.0",
    id: 83,
    method: "tools/call",
    params: {
      name: "maze_action_sequence",
      arguments: { actions: fastRoute }
    }
  }];
  const longHistoryStartedAt = Date.now();
  const longHistoryResult = spawnSync(
    process.execPath,
    [path.join(rootDir, "scripts", "maze-mcp-server.js")],
    {
      cwd: rootDir,
      encoding: "utf8",
      input: `${longHistoryRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
      env: {
        ...process.env,
        MAZEBENCH_REPO_ROOT: rootDir,
        MAZEBENCH_RUN_DIR: longHistoryDir,
        MAZEBENCH_SESSION_FILE: longHistorySessionPath,
        MAZEBENCH_AUTO_RUN_TOOLS: "1",
        MAZEBENCH_MOVE_BUDGET: "unlimited"
      },
      timeout: 30000
    }
  );
  const longHistoryDuration = Date.now() - longHistoryStartedAt;
  assert.equal(longHistoryResult.status, 0, longHistoryResult.stderr);
  const fastSequence = JSON.parse(longHistoryResult.stdout).result.structuredContent;
  assert.equal(fastSequence.completed_count, 100);
  assert.equal(fastSequence.stop_reason, "completed");
  assert.equal(JSON.parse(fs.readFileSync(longHistorySessionPath, "utf8")).actions.length, 1100);
  assert(
    longHistoryDuration < 15_000,
    `100 batched moves after a 1,000-action replay took ${longHistoryDuration}ms`
  );

  const sequencePauseDir = path.join(runDir, "sequence-pause");
  fs.mkdirSync(sequencePauseDir, { recursive: true });
  fs.writeFileSync(
    path.join(sequencePauseDir, "pause-request.json"),
    JSON.stringify({ requested_at: "2026-07-10T00:00:00.000Z", requested_after_turn: 0 })
  );
  const sequencePauseRequests = [
    { jsonrpc: "2.0", id: 84, method: "tools/call", params: { name: "maze_start", arguments: {} } },
    {
      jsonrpc: "2.0",
      id: 85,
      method: "tools/call",
      params: {
        name: "maze_action_sequence",
        arguments: { actions: ["rotate camera left", "rotate camera right"] }
      }
    }
  ];
  const sequencePauseResult = spawnSync(
    process.execPath,
    [path.join(rootDir, "scripts", "maze-mcp-server.js")],
    {
      cwd: rootDir,
      encoding: "utf8",
      input: `${sequencePauseRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
      env: {
        ...process.env,
        MAZEBENCH_REPO_ROOT: rootDir,
        MAZEBENCH_RUN_DIR: sequencePauseDir,
        MAZEBENCH_SESSION_FILE: path.join(sequencePauseDir, "session.json"),
        MAZEBENCH_AUTO_RUN_TOOLS: "1",
        MAZEBENCH_MOVE_BUDGET: "unlimited"
      }
    }
  );
  assert.equal(sequencePauseResult.status, 0, sequencePauseResult.stderr);
  const sequencePauseResponses = sequencePauseResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const pausedSequence = sequencePauseResponses.find((response) => response.id === 85)?.result?.structuredContent;
  assert.equal(pausedSequence.completed_count, 1);
  assert.equal(pausedSequence.stop_reason, "user_paused");
  assert.equal(pausedSequence.final_observation.user_pause_requested, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(sequencePauseDir, "session.json"), "utf8")).actions.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(sequencePauseDir, "pause-boundary.json"), "utf8")).completed_turn, 1);

  const workerRequests = [
    { jsonrpc: "2.0", id: 100, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 101, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 102, method: "tools/call", params: { name: "maze_start", arguments: {} } },
    { jsonrpc: "2.0", id: 103, method: "tools/call", params: { name: "maze_action", arguments: { action: "up" } } },
    { jsonrpc: "2.0", id: 104, method: "tools/call", params: { name: "maze_start", arguments: {} } },
    { jsonrpc: "2.0", id: 105, method: "tools/call", params: { name: "maze_clone", arguments: {} } },
    { jsonrpc: "2.0", id: 106, method: "tools/call", params: { name: "maze_action", arguments: { clone_id: "other", action: "left" } } },
    { jsonrpc: "2.0", id: 107, method: "tools/call", params: { name: "maze_workers", arguments: {} } }
  ];
  const workerResult = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${workerRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: runDir,
      MAZEBENCH_SESSION_FILE: path.join(runDir, "session.json"),
      MAZEBENCH_SWARM_DIR: path.join(runDir, "swarm"),
      MAZEBENCH_SWARM: "1",
      MAZEBENCH_WORKER_ONLY: "1",
      MAZEBENCH_WORKER_KEY: "scout",
      MAZEBENCH_MAX_SWARM_WORKERS: "2",
      MAZEBENCH_MOVE_BUDGET: "1"
    }
  });
  assert.equal(workerResult.status, 0, workerResult.stderr);
  const workerResponses = workerResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const workerTools = workerResponses.find((response) => response.id === 101)?.result?.tools || [];
  assert.deepEqual(workerTools.map((tool) => tool.name), ["maze_start", "maze_observe", "maze_action", "python_exec"]);
  assert.doesNotMatch(JSON.stringify(workerTools), /clone_id|maze_clone|maze_workers/i);
  assert.match(workerResponses.find((response) => response.id === 102)?.result?.structuredContent?.level || "", /P|p/);
  assert.match(workerResponses.find((response) => response.id === 104)?.result?.structuredContent?.level || "", /P|p/);
  for (const id of [105, 106, 107]) {
    assert(workerResponses.find((response) => response.id === id)?.error, `worker request ${id} must fail closed`);
  }
  const workerIds = fs.readdirSync(path.join(runDir, "swarm"));
  assert.deepEqual(workerIds, ["scout"], "one worker endpoint receives exactly one private instance");
  const worker = JSON.parse(fs.readFileSync(path.join(runDir, "swarm", "scout", "session.json"), "utf8"));
  const workerMetadata = JSON.parse(fs.readFileSync(path.join(runDir, "swarm", "scout", "worker.json"), "utf8"));
  assert.equal(worker.actions.length, 2, "worker instance inherits the primary action and applies one private action");
  assert.equal(worker.maxActions, null, "independent worker exploration must not inherit the primary cap");
  assert.equal(workerMetadata.fork_action_count, 1);
  assert.equal(workerMetadata.owner_kind, "subagent");
  assert.equal(workerMetadata.parent_instance_id, "primary");
  assert(Number.isFinite(Date.parse(workerMetadata.finished_at)), "closing a worker endpoint finishes its instance");
  assert(fs.existsSync(path.join(runDir, "swarm", "scout", "initial-status.json")));
  assert(fs.existsSync(path.join(runDir, "swarm", "scout", "frames", "frame-000.png")));
  assert(fs.statSync(path.join(runDir, "swarm-workspaces", "scout")).isDirectory());
  const activity = fs.readFileSync(path.join(runDir, "tool-activity.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(activity.some((entry) => entry.tool === "maze_action" && entry.clone_id === "scout"));
  assert(activity.some((entry) => entry.status === "running"));
  const pythonStarted = activity.find((entry) => entry.tool === "python_exec" && entry.status === "running");
  assert.match(pythonStarted.python_code, /Path\('notes\.txt'\)/);
  assert.match(pythonStarted.python_code_hash, /^[a-f0-9]{64}$/);
  const pythonFinished = activity.find((entry) =>
    entry.tool === "python_exec" && entry.status === (codexAvailable ? "completed" : "failed")
  );
  if (codexAvailable) {
    assert.equal(pythonFinished.python_result.stdout, "up\n");
    assert(Number.isFinite(pythonFinished.python_result.cpu_time_ms));
    assert.deepEqual(new Set(pythonFinished.workspace_changes.created), new Set(["notes.txt", "planner.py"]));
  } else {
    assert.match(pythonFinished.error, /Codex executable was not found on PATH/);
    assert.deepEqual(pythonFinished.workspace_changes.created, []);
  }
  const instanceEvents = fs.readFileSync(path.join(runDir, "maze-instance-events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(instanceEvents.some((entry) => entry.type === "instance.created" && entry.instance_id === "scout"));
  assert(instanceEvents.some((entry) => entry.type === "instance.action" && entry.instance_id === "scout" && entry.applied));
  assert(instanceEvents.some((entry) => entry.type === "instance.finished" && entry.instance_id === "scout"));

  const restrictedDir = path.join(runDir, "restricted");
  fs.mkdirSync(restrictedDir, { recursive: true });
  const restrictedRequests = [
    { jsonrpc: "2.0", id: 90, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 91, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 92, method: "tools/call", params: { name: "game_start", arguments: {} } },
    { jsonrpc: "2.0", id: 93, method: "tools/call", params: { name: "game_observe", arguments: { clone_id: "scout" } } },
    { jsonrpc: "2.0", id: 94, method: "tools/call", params: { name: "maze_workers", arguments: {} } },
    { jsonrpc: "2.0", id: 95, method: "tools/call", params: { name: "game_action", arguments: { action: "right", clone_id: "scout" } } },
    { jsonrpc: "2.0", id: 96, method: "tools/call", params: { name: "game_scorecard", arguments: {} } }
  ];
  const restrictedResult = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${restrictedRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: restrictedDir,
      MAZEBENCH_SESSION_FILE: path.join(restrictedDir, "session.json"),
      MAZEBENCH_RESTRICTED_MODE: "1",
      MAZEBENCH_MOVE_BUDGET: "1"
    }
  });
  assert.equal(restrictedResult.status, 0, restrictedResult.stderr);
  const restrictedResponses = restrictedResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(restrictedResponses.find((response) => response.id === 90)?.result?.serverInfo?.name, "game");
  const restrictedTools = restrictedResponses.find((response) => response.id === 91)?.result?.tools || [];
  assert.deepEqual(
    restrictedTools.map((tool) => tool.name),
    ["game_start", "game_observe", "game_action"]
  );
  assert.doesNotMatch(JSON.stringify(restrictedTools), /MazeBench|clone_id|worker/i);
  const restrictedObservation = restrictedResponses.find((response) => response.id === 92)?.result?.structuredContent;
  assert.deepEqual(Object.keys(restrictedObservation || {}), [
    "observation_mode",
    "current_room",
    "current_view",
    "yaw",
    "gem_count",
    "visited_levels",
    "player_dead",
    "game_won",
    "game_lost",
    "level",
    "ascii_legend"
  ]);
  assert.equal(restrictedObservation.observation_mode, "ascii");
  assert.match(restrictedObservation.level, /P|p/);
  assert.equal(restrictedObservation.visited_levels.length, 1);
  assert.match(restrictedObservation.visited_levels[0], /^level_[A-P]x[A-P]$/);
  for (const id of [93, 94, 95, 96]) {
    assert(restrictedResponses.find((response) => response.id === id)?.error, `restricted request ${id} must fail closed`);
  }

  const noQuitDir = path.join(runDir, "no-quit");
  fs.mkdirSync(noQuitDir, { recursive: true });
  const noQuitRequests = [
    { jsonrpc: "2.0", id: 20, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 21, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "maze_start", arguments: {} } },
    { jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "maze_action", arguments: { action: "quit" } } },
    { jsonrpc: "2.0", id: 24, method: "tools/call", params: { name: "maze_observe", arguments: {} } }
  ];
  const noQuitResult = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${noQuitRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: noQuitDir,
      MAZEBENCH_SESSION_FILE: path.join(noQuitDir, "session.json"),
      MAZEBENCH_SWARM_DIR: path.join(noQuitDir, "swarm"),
      MAZEBENCH_ALLOW_QUIT: "0",
      MAZEBENCH_MOVE_BUDGET: "5"
    }
  });
  assert.equal(noQuitResult.status, 0, noQuitResult.stderr);
  const noQuitResponses = noQuitResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const noQuitActionTool = noQuitResponses
    .find((response) => response.id === 21)?.result?.tools
    ?.find((tool) => tool.name === "maze_action");
  assert.deepEqual(
    noQuitResponses.find((response) => response.id === 21)?.result?.tools?.map((tool) => tool.name),
    ["maze_start", "maze_observe", "maze_action", "python_exec"],
    "ordinary tools-enabled runs receive game controls and isolated Python, but no worker controls"
  );
  assert.doesNotMatch(noQuitActionTool?.inputSchema?.properties?.action?.description || "", /quit/i);
  assert.equal(noQuitResponses.find((response) => response.id === 23)?.result?.isError, true);
  assert.doesNotMatch(
    JSON.stringify(noQuitResponses.find((response) => response.id === 22)?.result?.structuredContent?.allowed_commands || []),
    /quit/i
  );
  assert.doesNotMatch(
    JSON.stringify(noQuitResponses.find((response) => response.id === 24)?.result?.structuredContent?.allowed_commands || []),
    /quit/i
  );
  const noQuitSession = JSON.parse(fs.readFileSync(path.join(noQuitDir, "session.json"), "utf8"));
  assert.equal(noQuitSession.allowQuit, false, "the policy must persist inside the maze session");
  assert.equal(noQuitSession.actions.length, 0, "a blocked quit must not consume an action");
  assert.equal(Boolean(noQuitSession.lastStatus?.quit), false, "a blocked quit must not mark the maze terminal");
  const directQuit = spawnSync(
    process.execPath,
    [path.join(rootDir, "scripts", "codex-play.js"), "action", "--state", path.join(noQuitDir, "session.json"), "quit"],
    { cwd: rootDir, encoding: "utf8" }
  );
  assert.notEqual(directQuit.status, 0, "the lower-level helper must not bypass the no-quit policy");
  assert.match(directQuit.stderr, /Quit is disabled by the user/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(noQuitDir, "session.json"), "utf8")).actions.length,
    0,
    "a direct blocked quit must also consume no action"
  );

  const jsonDir = path.join(runDir, "json-mode");
  fs.mkdirSync(jsonDir, { recursive: true });
  const jsonRequests = [
    { jsonrpc: "2.0", id: 25, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 26, method: "tools/call", params: { name: "maze_start", arguments: {} } },
    { jsonrpc: "2.0", id: 27, method: "tools/call", params: { name: "maze_observe", arguments: {} } }
  ];
  const jsonResult = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${jsonRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: jsonDir,
      MAZEBENCH_SESSION_FILE: path.join(jsonDir, "session.json"),
      MAZEBENCH_MODE: "json",
      MAZEBENCH_OMNISCIENT: "1",
      MAZEBENCH_HIDE_NAMES: "1",
      MAZEBENCH_HIDE_NAMES_SEED: "mcp-repeatable-seed"
    }
  });
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const jsonResponses = jsonResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const jsonStatus = jsonResponses.find((response) => response.id === 27)?.result?.structuredContent;
  assert.equal(jsonStatus.observation_mode, "json");
  assert.equal(jsonStatus.level, undefined);
  assert.equal(jsonStatus.json_observation.omniscient, true);
  assert.equal(jsonStatus.json_observation.hide_names, true);
  assert.equal(jsonStatus.json_observation.objects.player.length > 0, true);
  assert.equal(jsonStatus.moved, undefined);
  assert.equal(jsonStatus.json_display_palette, undefined);
  assert.equal(jsonStatus.board_state_hash, undefined);
  assert.equal(jsonStatus.board_state_hash_version, undefined);
  const storedJsonSession = JSON.parse(fs.readFileSync(path.join(jsonDir, "session.json"), "utf8"));
  assert.equal(storedJsonSession.hideNamesSeed, "mcp-repeatable-seed");
  assert.equal(storedJsonSession.initial.json_display_palette.player, "#5aa95c");

  const jsonBridgeDir = path.join(runDir, "json-solver-bridge");
  fs.mkdirSync(jsonBridgeDir, { recursive: true });
  const outsideRoute = path.join(routeEscapeDir, "outside-route.json");
  fs.writeFileSync(outsideRoute, `${JSON.stringify(["rotate camera left"])}\n`);
  const relativeOutsideRoute = path.relative(jsonBridgeWorkspace, outsideRoute);
  fs.symlinkSync(outsideRoute, path.join(jsonBridgeWorkspace, "escape-route.json"));
  fs.writeFileSync(
    path.join(jsonBridgeWorkspace, "route.json"),
    `${JSON.stringify({
      observation_revision: 0,
      actions: ["rotate camera left", "rotate camera right"]
    }, null, 2)}\n`
  );
  const jsonPlannerCode = `from pathlib import Path
import runpy
program = '''import json
from pathlib import Path
observation = json.loads(Path("observations/current.json").read_text())
assert observation["observation_mode"] == "json"
route = {
    "observation_revision": observation["observation_revision"],
    "actions": ["rotate camera left", "rotate camera right"],
}
Path("route.json").write_text(json.dumps(route), encoding="utf-8")
print(len(observation["json_observation"]["objects"]["player"]))
'''
Path("planner.py").write_text(program, encoding="utf-8")
runpy.run_path("planner.py")`;
  const jsonBridgeRequests = [
    { jsonrpc: "2.0", id: 28, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 29, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "maze_start", arguments: {} } },
    { jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "python_exec", arguments: { code: jsonPlannerCode } } },
    {
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      params: {
        name: "maze_action_sequence",
        arguments: { route_file: "route.json", include_intermediate_observations: true }
      }
    },
    {
      jsonrpc: "2.0",
      id: 33,
      method: "tools/call",
      params: { name: "maze_action_sequence", arguments: { route_file: "route.json" } }
    },
    {
      jsonrpc: "2.0",
      id: 34,
      method: "tools/call",
      params: { name: "maze_action_sequence", arguments: { route_file: relativeOutsideRoute } }
    },
    {
      jsonrpc: "2.0",
      id: 35,
      method: "tools/call",
      params: { name: "maze_action_sequence", arguments: { route_file: "escape-route.json" } }
    }
  ];
  const jsonBridgeResult = spawnSync(
    process.execPath,
    [path.join(rootDir, "scripts", "maze-mcp-server.js")],
    {
      cwd: rootDir,
      encoding: "utf8",
      input: `${jsonBridgeRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
      env: {
        ...process.env,
        MAZEBENCH_REPO_ROOT: rootDir,
        MAZEBENCH_RUN_DIR: jsonBridgeDir,
        MAZEBENCH_SESSION_FILE: path.join(jsonBridgeDir, "session.json"),
        MAZEBENCH_AGENT_WORKSPACE_DIR: jsonBridgeWorkspace,
        MAZEBENCH_MODE: "json",
        MAZEBENCH_OMNISCIENT: "1",
        MAZEBENCH_AUTO_RUN_TOOLS: "1",
        MAZEBENCH_AUTO_RUN_ALL_FRAMES: "1",
        MAZEBENCH_MOVE_BUDGET: "4"
      }
    }
  );
  assert.equal(jsonBridgeResult.status, 0, jsonBridgeResult.stderr);
  const jsonBridgeResponses = jsonBridgeResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const jsonBridgeTools = jsonBridgeResponses.find((response) => response.id === 29)?.result?.tools || [];
  assert.match(
    jsonBridgeTools.find((tool) => tool.name === "python_exec")?.description || "",
    /observations\/current\.json is automatically synchronized/
  );
  assert.equal(
    jsonBridgeTools.find((tool) => tool.name === "maze_action_sequence")?.inputSchema?.properties?.route_file?.type,
    "string"
  );
  const jsonBridgeStart = jsonBridgeResponses.find((response) => response.id === 30)?.result?.structuredContent;
  assert.equal(jsonBridgeStart.observation_workspace.current_file, "observations/current.json");
  assert.equal(jsonBridgeStart.observation_workspace.observation_revision, 0);
  const pythonPlanner = jsonBridgeResponses.find((response) => response.id === 31)?.result;
  if (codexAvailable) {
    assert.equal(pythonPlanner?.structuredContent?.stdout, "1\n");
    assert.match(fs.readFileSync(path.join(jsonBridgeWorkspace, "planner.py"), "utf8"), /observations\/current\.json/);
  } else {
    assert.equal(pythonPlanner?.isError, true);
  }
  const jsonSequence = jsonBridgeResponses.find((response) => response.id === 32)?.result?.structuredContent;
  assert.equal(jsonSequence.requested_count, 2);
  assert.equal(jsonSequence.completed_count, 2);
  assert.equal(jsonSequence.route_file, "route.json");
  assert.equal(jsonSequence.route_observation_revision, 0);
  assert.equal(jsonSequence.intermediate_observations.length, 1);
  assert.equal(jsonSequence.intermediate_observations[0].observation.observation_mode, "json");
  assert.equal(jsonSequence.final_observation.observation_mode, "json");
  assert.equal(jsonSequence.observation_workspace.snapshots_written, 2);
  assert.equal(jsonSequence.observation_workspace.observation_revision, 2);
  assert.doesNotMatch(JSON.stringify(jsonSequence), /board_state_hash|scorecard|collected_gems/);
  const currentJsonObservation = JSON.parse(
    fs.readFileSync(path.join(jsonBridgeWorkspace, "observations", "current.json"), "utf8")
  );
  assert.equal(currentJsonObservation.observation_revision, 2);
  assert.equal(currentJsonObservation.observation_mode, "json");
  assert.equal(currentJsonObservation.json_observation.omniscient, true);
  assert.equal(
    fs.readFileSync(path.join(jsonBridgeWorkspace, "observations", "history.jsonl"), "utf8").trim().split("\n").length,
    3,
    "start plus both delivered sequence frames must be available to saved programs"
  );
  assert(fs.existsSync(path.join(jsonBridgeWorkspace, "observations", "000000.json")));
  assert(fs.existsSync(path.join(jsonBridgeWorkspace, "observations", "000001.json")));
  assert(fs.existsSync(path.join(jsonBridgeWorkspace, "observations", "000002.json")));
  const staleRoute = jsonBridgeResponses.find((response) => response.id === 33)?.result;
  assert.equal(staleRoute?.isError, true);
  assert.match(staleRoute?.content?.[0]?.text || "", /route_file is stale/);
  assert.match(
    jsonBridgeResponses.find((response) => response.id === 34)?.result?.content?.[0]?.text || "",
    /route_file must stay inside the solver workspace/
  );
  assert.match(
    jsonBridgeResponses.find((response) => response.id === 35)?.result?.content?.[0]?.text || "",
    /route_file must not resolve outside the solver workspace/
  );

  const unlimitedDir = path.join(runDir, "unlimited");
  fs.mkdirSync(unlimitedDir, { recursive: true });
  const unlimitedRequests = [
    { jsonrpc: "2.0", id: 31, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "maze_start", arguments: {} } },
    ...Array.from({ length: 3 }, (_, index) => ({
      jsonrpc: "2.0",
      id: 33 + index,
      method: "tools/call",
      params: { name: "maze_action", arguments: { action: index % 2 ? "left" : "right" } }
    }))
  ];
  const unlimitedResult = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${unlimitedRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: unlimitedDir,
      MAZEBENCH_SESSION_FILE: path.join(unlimitedDir, "session.json"),
      MAZEBENCH_MOVE_BUDGET: "unlimited",
      MAZEBENCH_ALLOW_QUIT: "0"
    }
  });
  assert.equal(unlimitedResult.status, 0, unlimitedResult.stderr);
  const unlimitedResponses = unlimitedResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert(unlimitedResponses.filter((response) => response.id >= 33).every((response) => !response.result?.isError));
  const unlimitedSession = JSON.parse(fs.readFileSync(path.join(unlimitedDir, "session.json"), "utf8"));
  assert.equal(unlimitedSession.actions.length, 3, "unlimited mode must not enforce a hidden segment budget");
  assert.equal(unlimitedSession.maxActions, null, "unlimited mode must not persist a hidden helper cap");

  const kimiLoopDir = path.join(runDir, "kimi-identical-action-loop");
  fs.mkdirSync(kimiLoopDir, { recursive: true });
  const kimiLoopRequests = [
    { jsonrpc: "2.0", id: 50, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "maze_start", arguments: {} } },
    ...Array.from({ length: 4 }, (_, index) => ({
      jsonrpc: "2.0",
      id: 52 + index,
      method: "tools/call",
      params: { name: "maze_action", arguments: { action: "rotate camera left" } }
    })),
    ...Array.from({ length: 5 }, (_, index) => ({
      jsonrpc: "2.0",
      id: 56 + index,
      method: "tools/call",
      params: { name: "maze_action", arguments: { action: index === 4 ? "  ROTATE   CAMERA RIGHT  " : "rotate camera right" } }
    })),
    { jsonrpc: "2.0", id: 61, method: "tools/call", params: { name: "maze_action", arguments: { action: "up" } } },
    { jsonrpc: "2.0", id: 62, method: "tools/call", params: { name: "maze_observe", arguments: {} } },
    { jsonrpc: "2.0", id: 63, method: "tools/call", params: { name: "maze_action", arguments: { action: "up" } } }
  ];
  const kimiLoopResult = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${kimiLoopRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: kimiLoopDir,
      MAZEBENCH_SESSION_FILE: path.join(kimiLoopDir, "session.json"),
      MAZEBENCH_PROVIDER: "kimi",
      MAZEBENCH_MOVE_BUDGET: "unlimited",
      MAZEBENCH_ALLOW_QUIT: "0"
    }
  });
  assert.equal(kimiLoopResult.status, 0, kimiLoopResult.stderr);
  const kimiLoopResponses = kimiLoopResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const kimiPayload = (id) => kimiLoopResponses.find((response) => response.id === id)?.result;
  assert.equal(kimiPayload(51)?.structuredContent?.next_required_tool, "maze_action");
  assert.equal(kimiPayload(55)?.structuredContent?.observe_required, undefined);
  assert.equal(kimiPayload(56)?.structuredContent?.observe_required, undefined, "a different action resets the streak");
  assert.equal(kimiPayload(60)?.structuredContent?.observe_required, true);
  assert.equal(kimiPayload(60)?.structuredContent?.next_required_tool, "maze_observe");
  assert.equal(kimiPayload(61)?.isError, true, "even a different sixth action is blocked until observe");
  assert.match(kimiPayload(61)?.content?.[0]?.text || "", /Call maze_observe before another maze_action/);
  assert.equal(kimiPayload(62)?.structuredContent?.observe_required, undefined);
  assert.equal(kimiPayload(62)?.structuredContent?.next_required_tool, "maze_action");
  assert.equal(kimiPayload(63)?.isError, false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(kimiLoopDir, "session.json"), "utf8")).actions.length,
    10,
    "the required observe is free and the blocked sixth action consumes no move"
  );

  const restrictedKimiLoopDir = path.join(runDir, "restricted-kimi-identical-action-loop");
  fs.mkdirSync(restrictedKimiLoopDir, { recursive: true });
  const restrictedKimiLoopRequests = [
    { jsonrpc: "2.0", id: 70, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 71, method: "tools/call", params: { name: "game_start", arguments: {} } },
    ...Array.from({ length: 5 }, (_, index) => ({
      jsonrpc: "2.0",
      id: 72 + index,
      method: "tools/call",
      params: { name: "game_action", arguments: { action: "rotate camera left" } }
    })),
    { jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "game_action", arguments: { action: "right" } } },
    { jsonrpc: "2.0", id: 78, method: "tools/call", params: { name: "game_observe", arguments: {} } },
    { jsonrpc: "2.0", id: 79, method: "tools/call", params: { name: "game_action", arguments: { action: "right" } } }
  ];
  const restrictedKimiLoopResult = spawnSync(
    process.execPath,
    [path.join(rootDir, "scripts", "maze-mcp-server.js")],
    {
      cwd: rootDir,
      encoding: "utf8",
      input: `${restrictedKimiLoopRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
      env: {
        ...process.env,
        MAZEBENCH_REPO_ROOT: rootDir,
        MAZEBENCH_RUN_DIR: restrictedKimiLoopDir,
        MAZEBENCH_SESSION_FILE: path.join(restrictedKimiLoopDir, "session.json"),
        MAZEBENCH_PROVIDER: "kimi",
        MAZEBENCH_RESTRICTED_MODE: "1",
        MAZEBENCH_MOVE_BUDGET: "unlimited",
        MAZEBENCH_ALLOW_QUIT: "0"
      }
    }
  );
  assert.equal(restrictedKimiLoopResult.status, 0, restrictedKimiLoopResult.stderr);
  const restrictedKimiLoopResponses = restrictedKimiLoopResult.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const restrictedKimiPayload = (id) => restrictedKimiLoopResponses.find((response) => response.id === id)?.result;
  assert.equal(restrictedKimiPayload(76)?.structuredContent?.observe_required, true);
  assert.equal(restrictedKimiPayload(76)?.structuredContent?.next_required_tool, "game_observe");
  assert.equal(restrictedKimiPayload(77)?.isError, true);
  assert.match(restrictedKimiPayload(77)?.content?.[0]?.text || "", /Call game_observe before another game_action/);
  assert.equal(restrictedKimiPayload(78)?.structuredContent?.next_required_tool, "game_action");
  assert.equal(restrictedKimiPayload(79)?.isError, false);

  const largeBudgetDir = path.join(runDir, "large-budget");
  fs.mkdirSync(largeBudgetDir, { recursive: true });
  const largeBudgetRequests = [
    { jsonrpc: "2.0", id: 37, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 38, method: "tools/call", params: { name: "maze_start", arguments: {} } }
  ];
  const largeBudgetResult = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${largeBudgetRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: largeBudgetDir,
      MAZEBENCH_SESSION_FILE: path.join(largeBudgetDir, "session.json"),
      MAZEBENCH_MOVE_BUDGET: "125"
    }
  });
  assert.equal(largeBudgetResult.status, 0, largeBudgetResult.stderr);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(largeBudgetDir, "session.json"), "utf8")).maxActions,
    125,
    "finite selections above the old default must persist their exact cap"
  );

  const coldPauseDir = path.join(runDir, "cold-pause");
  fs.mkdirSync(coldPauseDir, { recursive: true });
  fs.writeFileSync(
    path.join(coldPauseDir, "pause-request.json"),
    JSON.stringify({ requested_at: "2026-07-10T00:00:00.000Z", requested_after_turn: 0 })
  );
  const coldPauseRequests = [
    { jsonrpc: "2.0", id: 41, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "maze_start", arguments: {} } },
    { jsonrpc: "2.0", id: 43, method: "tools/call", params: { name: "maze_action", arguments: { action: "right" } } },
    { jsonrpc: "2.0", id: 44, method: "tools/call", params: { name: "maze_action", arguments: { action: "left" } } }
  ];
  const coldPauseResult = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${coldPauseRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: coldPauseDir,
      MAZEBENCH_SESSION_FILE: path.join(coldPauseDir, "session.json"),
      MAZEBENCH_MOVE_BUDGET: "unlimited",
      MAZEBENCH_ALLOW_QUIT: "0"
    }
  });
  assert.equal(coldPauseResult.status, 0, coldPauseResult.stderr);
  const coldPauseResponses = coldPauseResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(coldPauseResponses.find((response) => response.id === 43)?.result?.structuredContent?.user_pause_requested, true);
  assert.equal(coldPauseResponses.find((response) => response.id === 44)?.result?.isError, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(coldPauseDir, "session.json"), "utf8")).actions.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(coldPauseDir, "pause-boundary.json"), "utf8")).completed_turn, 1);

  const framePath = seededFramePath;
  const imageProbe = spawnSync(
    process.execPath,
    [
      "-e",
      `process.env.MAZEBENCH_RUN_DIR=${JSON.stringify(runDir)};` +
        `process.env.MAZEBENCH_MODE="vision";` +
        `const {toolContent}=require(${JSON.stringify(path.join(rootDir, "scripts", "maze-mcp-server.js"))});` +
        `process.stdout.write(JSON.stringify(toolContent({ok:true,session:"/trusted/session.json",workspace:"/trusted/work",frame_image:${JSON.stringify(framePath)}})));`
    ],
    { cwd: rootDir, encoding: "utf8" }
  );
  assert.equal(imageProbe.status, 0, imageProbe.stderr);
  const imageResult = JSON.parse(imageProbe.stdout);
  assert.equal(imageResult.structuredContent.frame_image, "attached:image/png");
  assert.equal(imageResult.structuredContent.session, undefined);
  assert.equal(imageResult.structuredContent.workspace, undefined);
  assert.equal(imageResult.content[1].type, "image");
  assert.equal(imageResult.content[1].mimeType, "image/png");

  const sequenceFramePaths = [1, 2, 3].map((index) => path.join(runDir, "frames", `sequence-${index}.png`));
  for (const sequenceFramePath of sequenceFramePaths) {
    fs.writeFileSync(sequenceFramePath, Buffer.from("89504e470d0a1a0a", "hex"));
  }
  const sequenceImageProbe = spawnSync(
    process.execPath,
    [
      "-e",
      `process.env.MAZEBENCH_RUN_DIR=${JSON.stringify(runDir)};` +
        `process.env.MAZEBENCH_MODE="vision";` +
        `const {toolContent}=require(${JSON.stringify(path.join(rootDir, "scripts", "maze-mcp-server.js"))});` +
        `const status=(frame_image)=>({status:{frame_image,current_room:"level_HxI",current_view:"top-diagonal",yaw:0,gem_count:0,player_dead:false,game_won:false,game_lost:false,visited_levels:["level_HxI"]}});` +
        `const compact=toolContent({steps:[],final_observation:status(${JSON.stringify(sequenceFramePaths[2])})});` +
        `const audited=toolContent({steps:[],intermediate_observations:[{index:1,action:"up",observation:status(${JSON.stringify(sequenceFramePaths[0])})},{index:2,action:"right",observation:status(${JSON.stringify(sequenceFramePaths[1])})}],final_observation:status(${JSON.stringify(sequenceFramePaths[2])})});` +
        `process.stdout.write(JSON.stringify({compact,audited}));`
    ],
    { cwd: rootDir, encoding: "utf8" }
  );
  assert.equal(sequenceImageProbe.status, 0, sequenceImageProbe.stderr);
  const sequenceImages = JSON.parse(sequenceImageProbe.stdout);
  assert.equal(sequenceImages.compact.content.filter((item) => item.type === "image").length, 1);
  assert.equal(sequenceImages.audited.content.filter((item) => item.type === "image").length, 3);

  const asciiStatusProbe = spawnSync(
    process.execPath,
    [
      "-e",
      `process.env.MAZEBENCH_RUN_DIR=${JSON.stringify(runDir)};` +
        `process.env.MAZEBENCH_MODE="text";` +
        `const {toolContent}=require(${JSON.stringify(path.join(rootDir, "scripts", "maze-mcp-server.js"))});` +
        `const alive=toolContent({status:{level:"P",current_room:"level_HxH",current_view:"top-diagonal",yaw:0,gem_count:1,moved:false,board_state_hash:"alive-hash",board_state_hash_version:1,collected_gems:["gem-secret"],collected_this_action:["gem-secret"],push_count:2,pushes_this_action:1,novel_push_count:2,novel_pushes_this_action:1,player_dead:false,game_won:false,game_lost:false,visited_levels:["level_HxH"]}}).structuredContent;` +
        `const dead=toolContent({status:{level:".",current_room:"level_HxI",current_view:"top-diagonal",yaw:1,gem_count:1,moved:true,board_state_hash:"dead-hash",board_state_hash_version:1,collected_gems:["gem-secret"],push_count:2,player_dead:true,game_won:false,game_lost:false,death_message:"The player died, you must now undo or reset or go to a level.",allowed_commands:["undo","reset","go to level X Y"],visited_levels:["level_HxH","level_HxI"]}}).structuredContent;` +
        `process.stdout.write(JSON.stringify({alive,dead}));`
    ],
    { cwd: rootDir, encoding: "utf8" }
  );
  assert.equal(asciiStatusProbe.status, 0, asciiStatusProbe.stderr);
  const asciiStatuses = JSON.parse(asciiStatusProbe.stdout);
  assert.deepEqual(asciiStatuses.alive, {
    observation_mode: "ascii",
    current_room: "level_HxH",
    current_view: "top-diagonal",
    yaw: 0,
    gem_count: 1,
    visited_levels: ["level_HxH"],
    player_dead: false,
    game_won: false,
    game_lost: false,
    level: "P",
    ascii_legend: []
  });
  assert.deepEqual(asciiStatuses.dead, {
    observation_mode: "ascii",
    current_room: "level_HxI",
    current_view: "top-diagonal",
    yaw: 1,
    gem_count: 1,
    visited_levels: ["level_HxH", "level_HxI"],
    player_dead: true,
    game_won: false,
    game_lost: false,
    level: ".",
    ascii_legend: [],
    death_message: "The player died, you must now undo or reset or go to a level.",
    allowed_commands: ["undo", "reset", "go to level X Y"]
  });

  const visionDir = path.join(runDir, "restricted-vision");
  fs.mkdirSync(visionDir, { recursive: true });
  const visionSession = path.join(visionDir, "session.json");
  const visionRequests = [
    { jsonrpc: "2.0", id: 50, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "game_start", arguments: {} } },
    { jsonrpc: "2.0", id: 52, method: "tools/call", params: { name: "game_action", arguments: { action: "right" } } }
  ];
  const visionResult = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${visionRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: visionDir,
      MAZEBENCH_SESSION_FILE: visionSession,
      MAZEBENCH_RESTRICTED_MODE: "1",
      MAZEBENCH_MODE: "vision",
      MAZEBENCH_MOVE_BUDGET: "1"
    },
    timeout: 240000
  });
  assert.equal(visionResult.status, 0, visionResult.stderr);
  const visionResponses = visionResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  for (const id of [51, 52]) {
    const toolResult = visionResponses.find((response) => response.id === id)?.result;
    assert.equal(toolResult?.structuredContent?.observation_mode, "vision");
    assert.equal(toolResult?.structuredContent?.frame_image, "attached:image/png");
    assert.equal(toolResult?.content?.[1]?.type, "image", `vision tool call ${id} must attach its rendered frame`);
    assert.equal(toolResult?.content?.[1]?.mimeType, "image/png");
    assert.equal(Object.prototype.hasOwnProperty.call(toolResult?.structuredContent || {}, "level"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(toolResult?.structuredContent || {}, "json_observation"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(toolResult?.structuredContent || {}, "moved"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(toolResult?.structuredContent || {}, "board_state_hash"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(toolResult?.structuredContent || {}, "board_state_hash_version"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(toolResult?.structuredContent || {}, "collected_gems"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(toolResult?.structuredContent || {}, "collected_this_action"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(toolResult?.structuredContent || {}, "push_count"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(toolResult?.structuredContent || {}, "pushes_this_action"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(toolResult?.structuredContent || {}, "novel_push_count"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(toolResult?.structuredContent || {}, "novel_pushes_this_action"), false);
    assert.doesNotMatch(toolResult?.content?.[0]?.text || "", new RegExp(rootDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert(fs.existsSync(path.join(visionDir, "frames", "frame-000.png")));
  assert(fs.existsSync(path.join(visionDir, "frames", "frame-001.png")));
  const finalizeVision = spawnSync(
    process.execPath,
    [path.join(rootDir, "scripts", "codex-play.js"), "finalize", "--state", visionSession],
    {
      cwd: rootDir,
      encoding: "utf8",
      env: { ...process.env, MAZEBENCH_TRUSTED_FINALIZE: "1" },
      timeout: 240000
    }
  );
  assert.equal(finalizeVision.status, 0, finalizeVision.stderr);

  const httpDir = path.join(runDir, "http");
  const portFile = path.join(httpDir, "mcp-http.json");
  fs.mkdirSync(httpDir, { recursive: true });
  httpChild = spawn(
    process.execPath,
    [path.join(rootDir, "scripts", "maze-mcp-server.js"), "--http", "--port-file", portFile],
    {
      cwd: rootDir,
      stdio: "ignore",
      env: {
        ...process.env,
        MAZEBENCH_REPO_ROOT: rootDir,
        MAZEBENCH_RUN_DIR: httpDir,
        MAZEBENCH_SESSION_FILE: path.join(httpDir, "session.json"),
        MAZEBENCH_MCP_HTTP_TOKEN: "test-token",
        MAZEBENCH_SWARM: "1",
        MAZEBENCH_MAX_SWARM_WORKERS: "1"
      }
    }
  );
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(portFile) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert(fs.existsSync(portFile), "HTTP MCP server should publish its port");
  const { port } = JSON.parse(fs.readFileSync(portFile, "utf8"));
  const leadProbe = spawnSync(
    "curl",
    [
      "-fsS",
      "-H", "content-type: application/json",
      "-X", "POST",
      "--data", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      `http://127.0.0.1:${port}/test-token/lead`
    ],
    { encoding: "utf8" }
  );
  assert.equal(leadProbe.status, 0, leadProbe.stderr);
  const leadResponse = JSON.parse(leadProbe.stdout);
  assert.deepEqual(
    leadResponse.result.tools.map((tool) => tool.name),
    ["maze_start", "maze_observe", "maze_action", "maze_workers", "python_exec"]
  );
  assert.doesNotMatch(JSON.stringify(leadResponse.result.tools), /clone_id|maze_clone/i);
  const leadStart = spawnSync(
    "curl",
    [
      "-fsS",
      "-H", "content-type: application/json",
      "-X", "POST",
      "--data", JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "maze_start", arguments: {} }
      }),
      `http://127.0.0.1:${port}/test-token/lead`
    ],
    { encoding: "utf8" }
  );
  assert.equal(leadStart.status, 0, leadStart.stderr);
  assert.equal(JSON.parse(leadStart.stdout).result.isError, false);

  const initializeWorker = (id, headerFile) => spawnSync(
    "curl",
    [
      "-fsS",
      "-D", headerFile,
      "-H", "content-type: application/json",
      "-X", "POST",
      "--data", JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" }
      }),
      `http://127.0.0.1:${port}/test-token/worker`
    ],
    { encoding: "utf8" }
  );
  const sessionIdFrom = (headerFile) => {
    const match = fs.readFileSync(headerFile, "utf8").match(/^mcp-session-id:\s*(.+)\r?$/im);
    assert(match, "worker initialize must return an MCP session id");
    return match[1].trim();
  };
  const callWorker = (sessionId, id, name, args = {}) => spawnSync(
    "curl",
    [
      "-fsS",
      "-H", "content-type: application/json",
      "-H", `Mcp-Session-Id: ${sessionId}`,
      "-X", "POST",
      "--data", JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: name === "tools/list" ? "tools/list" : "tools/call",
        params: name === "tools/list" ? {} : { name, arguments: args }
      }),
      `http://127.0.0.1:${port}/test-token/worker`
    ],
    { encoding: "utf8" }
  );

  const workerHeaders = path.join(httpDir, "worker-headers.txt");
  const workerInitialize = initializeWorker(3, workerHeaders);
  assert.equal(workerInitialize.status, 0, workerInitialize.stderr);
  const workerSessionId = sessionIdFrom(workerHeaders);
  const workerList = callWorker(workerSessionId, 4, "tools/list");
  assert.equal(workerList.status, 0, workerList.stderr);
  const httpWorkerTools = JSON.parse(workerList.stdout).result.tools;
  assert.deepEqual(httpWorkerTools.map((tool) => tool.name), ["maze_start", "maze_observe", "maze_action", "python_exec"]);
  assert.doesNotMatch(JSON.stringify(httpWorkerTools), /clone_id|maze_clone|maze_workers/i);

  for (const request of [
    { id: 5, name: "maze_start", arguments: {}, error: false },
    { id: 6, name: "maze_action", arguments: { action: "up" }, error: false },
    { id: 7, name: "maze_start", arguments: {}, error: false },
    { id: 8, name: "maze_clone", arguments: {}, error: true },
    { id: 9, name: "maze_action", arguments: { action: "left", clone_id: "other" }, error: true }
  ]) {
    const call = callWorker(workerSessionId, request.id, request.name, request.arguments);
    assert.equal(call.status, 0, call.stderr);
    const response = JSON.parse(call.stdout);
    assert.equal(Boolean(response.error), request.error, `HTTP worker request ${request.id} error status`);
  }

  const httpWorkerIds = fs.readdirSync(path.join(httpDir, "swarm"));
  assert.equal(httpWorkerIds.length, 1, "one HTTP worker session receives exactly one instance");
  const httpWorkerId = httpWorkerIds[0];
  const httpWorkerSessionFile = path.join(httpDir, "swarm", httpWorkerId, "session.json");
  const actionsBeforePause = JSON.parse(fs.readFileSync(httpWorkerSessionFile, "utf8")).actions.length;
  fs.writeFileSync(path.join(httpDir, "pause-request.json"), `${JSON.stringify({
    requested_at: new Date().toISOString(),
    requested_after_turn: 0
  })}\n`);
  const pausedAction = callWorker(workerSessionId, 10, "maze_action", { action: "right" });
  assert.equal(pausedAction.status, 0, pausedAction.stderr);
  assert.equal(JSON.parse(pausedAction.stdout).result.isError, true, "paused runs reject worker actions");
  assert.equal(
    JSON.parse(fs.readFileSync(httpWorkerSessionFile, "utf8")).actions.length,
    actionsBeforePause,
    "a rejected paused action must not alter the worker instance"
  );
  fs.rmSync(path.join(httpDir, "pause-request.json"));

  const secondHeaders = path.join(httpDir, "second-worker-headers.txt");
  const secondInitialize = initializeWorker(11, secondHeaders);
  assert.equal(secondInitialize.status, 0, secondInitialize.stderr);
  const secondSessionId = sessionIdFrom(secondHeaders);
  const cappedStart = callWorker(secondSessionId, 12, "maze_start");
  assert.equal(cappedStart.status, 0, cappedStart.stderr);
  assert.equal(JSON.parse(cappedStart.stdout).result.isError, true, "the configured swarm-worker cap is enforced");
  assert.equal(fs.readdirSync(path.join(httpDir, "swarm")).length, 1);

  for (const sessionId of [workerSessionId, secondSessionId]) {
    const closed = spawnSync(
      "curl",
      [
        "-fsS",
        "-H", `Mcp-Session-Id: ${sessionId}`,
        "-X", "DELETE",
        `http://127.0.0.1:${port}/test-token/worker`
      ],
      { encoding: "utf8" }
    );
    assert.equal(closed.status, 0, closed.stderr);
  }
  const httpWorkerMetadata = JSON.parse(
    fs.readFileSync(path.join(httpDir, "swarm", httpWorkerId, "worker.json"), "utf8")
  );
  assert.equal(httpWorkerMetadata.owner_kind, "subagent");
  assert(Number.isFinite(Date.parse(httpWorkerMetadata.finished_at)));
} finally {
  if (httpChild) httpChild.kill("SIGTERM");
  fs.rmSync(leadWorkspace, { recursive: true, force: true });
  fs.rmSync(jsonBridgeWorkspace, { recursive: true, force: true });
  fs.rmSync(routeEscapeDir, { recursive: true, force: true });
  fs.rmSync(runDir, { recursive: true, force: true });
}

console.log("maze MCP server tests passed");
