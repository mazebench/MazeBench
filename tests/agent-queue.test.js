const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  createAgentRunService,
  replayMessageForCommandText,
  resolveAgentRunsDir
} = require("../server/agent-runs");
const { BOARD_STATE_HASH_VERSION } = require("../shared/board-state");
const primeHarnessCatalog = require("../environments/mazebench/prime-harness-catalog.json");

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-agent-queue-"));
assert.equal(
  resolveAgentRunsDir(rootDir, { MAZEBENCH_RUNS_DIR: path.join(rootDir, "shared-runs") }),
  path.join(rootDir, "shared-runs")
);
assert.equal(
  resolveAgentRunsDir(rootDir, {}),
  path.join(rootDir, "outputs", "maze-local", "site")
);
const repositoryRoot = path.resolve(__dirname, "..");
const commonGitDir = spawnSync(
  "git",
  ["-C", repositoryRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
  { encoding: "utf8" }
).stdout.trim();
assert.equal(
  resolveAgentRunsDir(repositoryRoot, {}),
  path.join(path.dirname(commonGitDir), "outputs", "maze-local", "site")
);
const scriptsDir = path.join(rootDir, "scripts");
fs.mkdirSync(scriptsDir, { recursive: true });
fs.writeFileSync(
  path.join(scriptsDir, "maze-agent-local.js"),
  `const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const args = Object.fromEntries(process.argv.slice(2).map((part) => {
  const at = part.indexOf("=");
  return at < 0 ? [part, ""] : [part.slice(0, at), part.slice(at + 1)];
}));
const nested = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
if (args.out) fs.writeFileSync(path.join(args.out, "nested-runner.pid"), String(nested.pid));
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
`,
  "utf8"
);
fs.writeFileSync(
  path.join(scriptsDir, "maze-prime-run.js"),
  "setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(0));\n",
  "utf8"
);
fs.writeFileSync(
  path.join(scriptsDir, "maze-export-replay.js"),
  `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out-dir");
const outDir = outIndex >= 0 ? args[outIndex + 1] : process.cwd();
fs.writeFileSync(path.join(outDir, "video-args.json"), JSON.stringify(args));
setInterval(() => {}, 1000);
`,
  "utf8"
);
fs.writeFileSync(
  path.join(scriptsDir, "maze-bridge.js"),
  `const readline = require("node:readline");
const args = process.argv.slice(2);
const omniscient = args.includes("--omniscient");
const hideNames = args.includes("--hide-names");
const modeIndex = args.indexOf("--observation-mode");
const observationMode = modeIndex >= 0 ? args[modeIndex + 1] : "text";
let boardState = 0;
readline.createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
  const message = JSON.parse(line);
  if (["move", "goto_level", "reset_level", "undo"].includes(message.command)) boardState += 1;
  process.stdout.write(JSON.stringify(message.command === "close"
    ? { ok: true, action: "close" }
    : {
        ok: true,
        action: message.command,
        board_state_hash: "state-" + boardState,
        board_state_hash_version: ${BOARD_STATE_HASH_VERSION},
        player: { x: boardState, y: 8, elevation: 0 },
        level: observationMode === "text" ? "ASCII:" + message.command : undefined,
        json_observation: { mode: "json", omniscient, hide_names: hideNames, objects: [] }
      }) + "\\n");
});
`,
  "utf8"
);

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

const game = {
  id: "maze",
  name: "Maze Bench Environment",
  worldMap: { levels: [{ id: "level_HxI" }] }
};
let agentEnvironmentState = {
  codex: true,
  codex_installed: true,
  codex_authenticated: true,
  codex_subscription: true,
  claude: true,
  claude_installed: true,
  claude_authenticated: true,
  claude_subscription: true,
  kimi: true,
  kimi_installed: true,
  kimi_authenticated: true,
  kimi_subscription: true,
  prime: true,
  prime_installed: true,
  prime_authenticated: true,
  uv: true,
  docker: true,
  docker_installed: true,
  docker_running: true,
  local_agent_image: true,
  local_agent_versions: { codex: "0.146.0", claude: "2.1.220", kimi: "0.29.1" },
  local_agent_image_versions: { codex: "0.146.0", claude: "2.1.220", kimi: "0.29.1" },
  local_codex_image: true,
  local_codex_image_version: "0.146.0",
  local_codex_required_version: "0.146.0"
};
const service = createAgentRunService({
  agentEnvironment: () => agentEnvironmentState,
  ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
  getGame: (id) => (id === "maze" ? game : null),
  buildWorlds: { countWorldGems: () => 1 },
  loadJson,
  rootDir,
  worldMaps: {
    defaultLevelIdForGame: () => "level_HxI",
    isMazeWorldLevelId: () => true
  }
});

const launchedIds = [];

(async () => {
try {
  agentEnvironmentState = { ...agentEnvironmentState, uv: false };
  assert.throws(
    () => service.launchRuns({ kind: "prime", model_name: "preflight-test", max_turns: 1 }),
    /uv is required/
  );
  agentEnvironmentState = { ...agentEnvironmentState, uv: true, docker: false, docker_running: false };
  const [sandboxRun] = service.launchRuns({
    kind: "prime",
    model_name: "preflight-test",
    max_turns: 1
  });
  launchedIds.push(sandboxRun.id);
  agentEnvironmentState = { ...agentEnvironmentState, docker: true, docker_running: true };

  assert.deepEqual(replayMessageForCommandText("up"), { command: "move", direction: "up" });
  assert.deepEqual(replayMessageForCommandText("rotate camera left"), {
    command: "rotate_camera",
    direction: "left"
  });
  assert.deepEqual(replayMessageForCommandText("go to level H I"), {
    command: "goto_level",
    x: "H",
    y: "I"
  });
  assert.deepEqual(replayMessageForCommandText("no move"), { command: "no_move" });
  assert.equal(replayMessageForCommandText("not a command"), null);

  const harnessRegistry = service.listPrimeHarnesses();
  assert.deepEqual(harnessRegistry.harnesses.map((harness) => harness.id), ["mazebench_prime_agent"]);
  assert.equal(harnessRegistry.harnesses.find((harness) => harness.id === "mazebench_prime_agent").adapter, "prime_agent_cli");
  const [customPrime] = service.launchRuns({
    kind: "prime",
    harness: "mazebench_prime_agent",
    harness_config: {},
    model_name: "openai/gpt-5.6-luna",
    max_turns: 2,
    video: false
  });
  launchedIds.push(customPrime.id);
  const customPrimeMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", customPrime.id, "run.json")
  );
  assert.equal(customPrimeMeta.harness, "mazebench_prime_agent");
  assert.equal(customPrimeMeta.harness_label, "Prime Agent");
  assert.equal(customPrimeMeta.harness_version, "0.7.0");
  assert.equal(customPrimeMeta.harness_source, "prime-agent-v0.7.0-adapter");
  assert.deepEqual(customPrimeMeta.harness_config, { version: "0.7.0" });
  assert.equal(customPrimeMeta.harness_boundary, "game-tools-only");
  assert.equal(customPrimeMeta.harness_adapter, "prime_agent_cli");
  assert.equal(customPrimeMeta.harness_taskset, "mazebench-tools");
  assert.equal(customPrimeMeta.verifiers_version, primeHarnessCatalog.verifiers_version);
  assert.match(customPrimeMeta.harness_catalog_fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(customPrimeMeta.launch_params.harness_config, { version: "0.7.0" });
  assert.match(customPrimeMeta.command, /--harness mazebench_prime_agent/);
  assert.match(customPrimeMeta.command, /--harness-config \{"version":"0\.7\.0"\}/);
  const customPrimeDir = path.join(rootDir, "outputs", "maze-local", "site", customPrime.id);
  fs.writeFileSync(
    path.join(customPrimeDir, "initial-status.json"),
    `${JSON.stringify({ board_state_hash: "custom-state-0", current_room: "level_HxI" })}\n`
  );
  fs.writeFileSync(
    path.join(customPrimeDir, "actions.jsonl"),
    `${JSON.stringify({
      turn: 1,
      command_text: "right",
      valid: true,
      status: { board_state_hash: "custom-state-1", current_room: "level_HxI" }
    })}\n`
  );
  fs.mkdirSync(path.join(customPrimeDir, "eval-output"), { recursive: true });
  fs.writeFileSync(
    path.join(customPrimeDir, "eval-output", "results.jsonl"),
    `${JSON.stringify({
      task: { system_prompt: "system", level_id: "level_HxI", game_won_gem_count: 1 },
      nodes: [
        { parent: null, message: { role: "system", content: "system" }, sampled: false },
        { parent: 0, message: { role: "user", content: "opening" }, sampled: false },
        { parent: 1, message: { role: "assistant", content: "right" }, sampled: true }
      ]
    })}\n`
  );
  assert.equal(service.stopRun(customPrime.id).status, "stopped");
  const continuedCustomPrime = service.continueRun(customPrime.id, 1);
  launchedIds.push(continuedCustomPrime.id);
  assert.deepEqual(continuedCustomPrime.harness_config, { version: "0.7.0" });
  assert.equal(continuedCustomPrime.harness_boundary, "game-tools-only");
  assert.equal(service.stopRun(continuedCustomPrime.id).status, "stopped");
  service.deleteRun(continuedCustomPrime.id);
  service.deleteRun(customPrime.id);

  const [isolatedPrimeCodex] = service.launchRuns({
    kind: "prime",
    harness: "codex",
    model_name: "openai/gpt-5.6-luna",
    max_turns: 3,
    tools: true,
    tool_use: "offline",
    video: false
  });
  launchedIds.push(isolatedPrimeCodex.id);
  const isolatedPrimeCodexDir = path.join(
    rootDir,
    "outputs",
    "maze-local",
    "site",
    isolatedPrimeCodex.id
  );
  const isolatedPrimeCodexMeta = loadJson(path.join(isolatedPrimeCodexDir, "run.json"));
  assert.equal(isolatedPrimeCodexMeta.prime_execution, "local-isolated");
  assert.equal(isolatedPrimeCodexMeta.inference_provider, "prime");
  assert.equal(
    isolatedPrimeCodexMeta.harness_boundary,
    "prime-inference/disposable-container/game-tools+isolated-python"
  );
  assert.match(isolatedPrimeCodexMeta.command, /model=codex inference=prime/);
  assert.equal(isolatedPrimeCodexMeta.launch_params.model, "codex");
  assert.equal(isolatedPrimeCodexMeta.launch_params.inference, "prime");

  service.stopRun(isolatedPrimeCodex.id);
  const isolatedPrimeThreadId = "019fda33-2630-7ab0-89fd-51d2984b0602";
  fs.writeFileSync(
    path.join(isolatedPrimeCodexDir, "agent-events.jsonl"),
    `${JSON.stringify({ type: "thread.started", thread_id: isolatedPrimeThreadId })}\n`
  );
  fs.writeFileSync(
    path.join(isolatedPrimeCodexDir, "actions.jsonl"),
    `${JSON.stringify({ turn: 1, command_text: "up", valid: true, status: {} })}\n`
  );
  const isolatedPrimeSessionDir = path.join(
    isolatedPrimeCodexDir,
    "agent-state",
    "codex",
    "sessions",
    "2026",
    "08",
    "07"
  );
  fs.mkdirSync(isolatedPrimeSessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(isolatedPrimeSessionDir, `rollout-test-${isolatedPrimeThreadId}.jsonl`),
    `${JSON.stringify({ type: "session_meta", payload: { id: isolatedPrimeThreadId } })}\n`
  );
  fs.writeFileSync(
    path.join(isolatedPrimeCodexDir, "run.json"),
    `${JSON.stringify({
      ...loadJson(path.join(isolatedPrimeCodexDir, "run.json")),
      status: "paused",
      pid: null,
      moves: 3,
      pause_reason: "provider_backoff",
      pause_mode: "cold",
      retry_at: new Date(Date.now() - 1000).toISOString()
    }, null, 2)}\n`
  );
  const isolatedPrimeRelaunchLock = path.join(isolatedPrimeCodexDir, ".agent-relaunch.lock");
  fs.writeFileSync(isolatedPrimeRelaunchLock, "another-server-is-relaunching\n");
  assert.equal(service.resumeRun(isolatedPrimeCodex.id).status, "paused");
  fs.rmSync(isolatedPrimeRelaunchLock, { force: true });
  const resumedIsolatedPrimeCodex = service.resumeRun(isolatedPrimeCodex.id);
  assert.equal(resumedIsolatedPrimeCodex.id, isolatedPrimeCodex.id);
  assert.equal(resumedIsolatedPrimeCodex.status, "running");
  assert.equal(resumedIsolatedPrimeCodex.moves, 3);
  assert.match(resumedIsolatedPrimeCodex.command, /inference=prime/);
  assert.match(resumedIsolatedPrimeCodex.command, new RegExp(`resume=${isolatedPrimeThreadId}`));
  const coldStartRecoveryMeta = loadJson(path.join(isolatedPrimeCodexDir, "run.json"));
  assert.equal(coldStartRecoveryMeta.provider_resume_mode, "resume-thread");
  assert.equal(coldStartRecoveryMeta.resume_game_session, false);
  assert.equal(coldStartRecoveryMeta.resume_mode, "cold-start-recovery");
  service.stopRun(isolatedPrimeCodex.id);
  service.deleteRun(isolatedPrimeCodex.id);

  const [threadlessPrimeCodex] = service.launchRuns({
    kind: "prime",
    harness: "codex",
    model_name: "openai/gpt-5.6-luna",
    max_turns: 2,
    tools: false,
    tool_use: "read-only",
    video: false
  });
  launchedIds.push(threadlessPrimeCodex.id);
  const threadlessPrimeCodexDir = path.join(
    rootDir,
    "outputs",
    "maze-local",
    "site",
    threadlessPrimeCodex.id
  );
  service.stopRun(threadlessPrimeCodex.id);
  fs.writeFileSync(
    path.join(threadlessPrimeCodexDir, "run.json"),
    `${JSON.stringify({
      ...loadJson(path.join(threadlessPrimeCodexDir, "run.json")),
      status: "failed",
      pid: null,
      exit_code: 75
    }, null, 2)}\n`
  );
  const recoveredWithoutThread = service.resumeRun(threadlessPrimeCodex.id);
  assert.equal(recoveredWithoutThread.status, "running");
  assert.doesNotMatch(recoveredWithoutThread.command, /resume=/);
  const freshThreadRecoveryMeta = loadJson(path.join(threadlessPrimeCodexDir, "run.json"));
  assert.equal(freshThreadRecoveryMeta.provider_resume_mode, "fresh-thread");
  assert.equal(freshThreadRecoveryMeta.resume_game_session, false);
  assert.equal(freshThreadRecoveryMeta.resume_mode, "cold-start-recovery");
  service.stopRun(threadlessPrimeCodex.id);
  service.deleteRun(threadlessPrimeCodex.id);

  const [livePrime] = service.launchRuns({
    kind: "prime",
    model_name: "Qwen/Qwen3.5-0.8B",
    max_turns: 750,
    vision: false,
    reasoning: "low",
    allow_quit: false,
    video: false
  });
  launchedIds.push(livePrime.id);
  const livePrimeMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", livePrime.id, "run.json")
  );
  assert.equal(livePrimeMeta.prime_execution, "local");
  assert.equal(livePrimeMeta.moves, 750);
  assert.equal(livePrimeMeta.allow_quit, false);
  assert.doesNotMatch(livePrimeMeta.command, /--hosted/);
  assert.match(livePrimeMeta.command, /--model Qwen\/Qwen3\.5-0\.8B/);
  assert.match(livePrimeMeta.command, /--reasoning low/);
  assert.equal(livePrimeMeta.reasoning, "low");
  assert.match(livePrimeMeta.command, /--max-turns 750/);
  assert.equal(livePrimeMeta.harness, "mazebench_prime_agent");
  assert.equal(livePrimeMeta.harness_taskset, "mazebench-tools");
  assert.match(livePrimeMeta.note, /named game controls/);
  const livePrimeRunDir = path.join(rootDir, "outputs", "maze-local", "site", livePrime.id);
  fs.writeFileSync(
    path.join(livePrimeRunDir, "actions.jsonl"),
    `${JSON.stringify({
      turn: 1,
      command_text: "up",
      valid: true,
      status: { board_state_hash: "legacy-state-1", current_room: "level_HxI" }
    })}\n`
  );
  fs.writeFileSync(
    path.join(livePrimeRunDir, "initial-status.json"),
    `${JSON.stringify({ board_state_hash: "legacy-state-0", current_room: "level_HxI" })}\n`
  );
  fs.mkdirSync(path.join(livePrimeRunDir, "eval-output"), { recursive: true });
  fs.writeFileSync(
    path.join(livePrimeRunDir, "eval-output", "results.jsonl"),
    `${JSON.stringify({
      task: {
        system_prompt: "system",
        level_id: "level_HxI",
        game_won_gem_count: 1,
        observation_mode: "ascii"
      },
      nodes: [
        { parent: null, message: { role: "system", content: "system" }, sampled: false },
        { parent: 0, message: { role: "user", content: "opening" }, sampled: false },
        { parent: 1, message: { role: "assistant", content: "up" }, sampled: true }
      ]
    })}\n`
  );
  const livePrimeRecordedAt = Date.parse("2026-07-19T00:39:10.000Z") / 1000;
  fs.writeFileSync(
    path.join(livePrimeRunDir, "prime-usage.jsonl"),
    `${JSON.stringify({
      turn: 1,
      input_tokens: 10,
      completion_tokens: 2,
      recorded_at: livePrimeRecordedAt
    })}\n`
  );
  const livePrimeProgress = service.getRunProgress(livePrime.id);
  assert.equal(livePrimeProgress.actions[0].level, "ASCII:observe");
  assert.equal(livePrimeProgress.initial_board_state_hash, "state-0");
  assert.equal(livePrimeProgress.actions[0].board_state_hash, "state-1");
  assert.equal(livePrimeProgress.actions[0].board_state_hash_version, BOARD_STATE_HASH_VERSION);
  assert.equal(livePrimeProgress.actions[0].timestamp, "2026-07-19T00:39:10.000Z");
  assert.deepEqual(livePrimeProgress.reasoning, [
    { move: 1, timestamp: "2026-07-19T00:39:10.000Z" }
  ]);
  assert.deepEqual(livePrimeProgress.initial_player, { x: 0, y: 8, elevation: 0 });
  assert.deepEqual(livePrimeProgress.actions[0].player, { x: 1, y: 8, elevation: 0 });
  assert.equal(
    loadJson(path.join(livePrimeRunDir, "actions.jsonl"), {})?.status?.player,
    undefined,
    "trusted chart reconstruction must not write coordinates into agent-facing telemetry"
  );
  assert.deepEqual(service.getRunObservation(livePrime.id, { turn: 1 }).player, {
    x: 1,
    y: 8,
    elevation: 0
  });
  assert.equal(livePrimeProgress.run.inference.state, "in_flight");
  assert.equal(livePrimeProgress.run.inference.action, 2);
  assert.equal(service.stopRun(livePrime.id).status, "stopped");
  const continuedPrime = service.continueRun(livePrime.id, 750);
  launchedIds.push(continuedPrime.id);
  assert.equal(continuedPrime.moves, 1500, "Prime continuations must not stop at the former 500-turn ceiling");
  assert.match(continuedPrime.command, /--max-turns 1500/);
  assert.equal(service.stopRun(continuedPrime.id).status, "stopped");
  service.deleteRun(continuedPrime.id);
  service.deleteRun(livePrime.id);

  const [unlimitedPrime] = service.launchRuns({
    kind: "prime",
    model_name: "Qwen/Qwen3.5-0.8B",
    unlimited: true,
    allow_quit: false,
    video: false
  });
  launchedIds.push(unlimitedPrime.id);
  const unlimitedPrimeMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", unlimitedPrime.id, "run.json")
  );
  assert.equal(unlimitedPrimeMeta.moves, null);
  assert.equal(unlimitedPrimeMeta.unlimited, true);
  assert.equal(unlimitedPrimeMeta.launch_params.unlimited, true);
  assert.match(unlimitedPrimeMeta.command, /--unlimited/);
  assert.doesNotMatch(unlimitedPrimeMeta.command, /--max-turns/);
  const unlimitedPrimeSummary = service.summarizeRun(unlimitedPrime.id);
  assert.equal(unlimitedPrimeSummary.progress.unlimited, true);
  assert.equal(unlimitedPrimeSummary.progress.total, null);
  assert.equal(unlimitedPrimeSummary.progress.eta_ms, null);
  assert.equal(service.stopRun(unlimitedPrime.id).status, "stopped");
  service.deleteRun(unlimitedPrime.id);

  const [specialEffortPrime] = service.launchRuns({
    kind: "prime",
    model_name: "openai/gpt-5.6-sol",
    max_turns: 2,
    reasoning: "ultra",
    video: false
  });
  launchedIds.push(specialEffortPrime.id);
  const specialEffortMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", specialEffortPrime.id, "run.json")
  );
  assert.equal(specialEffortMeta.reasoning, "");
  assert.doesNotMatch(specialEffortMeta.command, /--reasoning/);
  assert.equal(service.stopRun(specialEffortPrime.id).status, "stopped");
  service.deleteRun(specialEffortPrime.id);

  const [autoQuitPrime] = service.launchRuns({
    kind: "prime",
    model_name: "Qwen/Qwen3.5-0.8B",
    max_turns: 50,
    auto_quit: true,
    auto_quit_threshold: 0,
    auto_quit_mode: "rolling",
    auto_quit_window: 2,
    video: false
  });
  launchedIds.push(autoQuitPrime.id);
  const autoQuitDir = path.join(rootDir, "outputs", "maze-local", "site", autoQuitPrime.id);
  fs.writeFileSync(
    path.join(autoQuitDir, "initial-status.json"),
    `${JSON.stringify({ board_state_hash: "repeat-state", board_state_hash_version: BOARD_STATE_HASH_VERSION })}\n`
  );
  fs.writeFileSync(
    path.join(autoQuitDir, "actions.jsonl"),
    `${[
      { turn: 1, command_text: "up", status: { board_state_hash: "repeat-state", board_state_hash_version: BOARD_STATE_HASH_VERSION } },
      { turn: 2, command_text: "down", status: { board_state_hash: "repeat-state", board_state_hash_version: BOARD_STATE_HASH_VERSION } }
    ].map(JSON.stringify).join("\n")}\n`
  );
  const autoQuitDeadline = Date.now() + 4000;
  let autoQuitSummary = service.summarizeRun(autoQuitPrime.id);
  while (autoQuitSummary.status !== "finished" && Date.now() < autoQuitDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    autoQuitSummary = service.summarizeRun(autoQuitPrime.id);
  }
  assert.equal(autoQuitSummary.status, "finished");
  assert.equal(autoQuitSummary.auto_quit_triggered, true);
  assert.equal(autoQuitSummary.auto_quit_percentage, 0);
  assert.equal(autoQuitSummary.auto_quit_novel_states, 0);
  assert.equal(autoQuitSummary.auto_quit_observed_states, 2);
  service.deleteRun(autoQuitPrime.id);

  const failedPrimeId = "prime-rollout-failure-test";
  const livePrimeDir = path.join(rootDir, "outputs", "maze-local", "site", failedPrimeId);
  fs.mkdirSync(livePrimeDir, { recursive: true });
  fs.writeFileSync(
    path.join(livePrimeDir, "run.json"),
    `${JSON.stringify({
      id: failedPrimeId,
      kind: "prime",
      created_at: new Date().toISOString(),
      status: "finished",
      model: "prime",
      model_name: "failure-test",
      game_id: "maze",
      level_id: "level_HxI",
      moves: 1,
      gem_total: 1
    }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(livePrimeDir, "prime-evaluation-samples.json"),
    `${JSON.stringify({
      samples: [{
        info: {
          stop_condition: "has_error",
          error: { error_chain_str: "ModelError -> HTTP 422" }
        }
      }]
    }, null, 2)}\n`
  );
  const failedPrimeSummary = service.summarizeRun(failedPrimeId);
  assert.equal(failedPrimeSummary.status, "failed");
  assert.equal(failedPrimeSummary.rollout_error, "ModelError -> HTTP 422");
  assert.equal(failedPrimeSummary.prime_evaluation_status, "FAILED");
  service.deleteRun(failedPrimeId);

  const primeVideoId = "prime-video-input-test";
  const primeVideoDir = path.join(rootDir, "outputs", "maze-local", "site", primeVideoId);
  const primeVideoResults = path.join(primeVideoDir, "eval-output", "results.jsonl");
  fs.mkdirSync(path.dirname(primeVideoResults), { recursive: true });
  fs.writeFileSync(primeVideoResults, "{}\n");
  fs.writeFileSync(
    path.join(primeVideoDir, "run.json"),
    `${JSON.stringify({
      id: primeVideoId,
      kind: "prime",
      created_at: new Date().toISOString(),
      status: "failed",
      model: "prime",
      model_name: "video-test",
      game_id: "maze",
      level_id: "level_HxI",
      moves: 1,
      mode: "text",
      gem_total: 1
    }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(primeVideoDir, "actions.jsonl"),
    `${JSON.stringify({ turn: 1, command_text: "up", status: {} })}\n`
  );
  assert.throws(
    () => service.generateRunVideo(primeVideoId, { action_limit: 0 }),
    /action_limit must be a positive integer/
  );
  const primeVideo = service.generateRunVideo(primeVideoId, {
    action_limit: 1,
    api_cost_limit_usd: 12.5,
    quality: "raw"
  });
  assert.equal(primeVideo.status, "failed");
  assert.equal(primeVideo.video_status, "rendering");
  assert.equal(primeVideo.video_snapshot_turns, 1);
  assert.equal(primeVideo.video_action_limit, 1);
  assert.equal(primeVideo.video_cost_limit_usd, 12.5);
  assert.equal(primeVideo.video_quality, "raw");
  const primeVideoArgsDeadline = Date.now() + 3000;
  while (!fs.existsSync(path.join(primeVideoDir, "video-args.json")) && Date.now() < primeVideoArgsDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const primeVideoArgs = loadJson(path.join(primeVideoDir, "video-args.json"), []);
  assert.equal(primeVideoArgs[0], path.join(primeVideoDir, "actions.jsonl"));
  assert.deepEqual(primeVideoArgs.slice(primeVideoArgs.indexOf("--action-limit"), primeVideoArgs.indexOf("--action-limit") + 2), ["--action-limit", "1"]);
  assert.equal(primeVideoArgs.includes("--max-video-mib"), false);
  service.cancelRunVideo(primeVideoId);
  service.deleteRun(primeVideoId);

  const interruptedPrimeVideoId = "prime-video-action-log-fallback-test";
  const interruptedPrimeVideoDir = path.join(
    rootDir,
    "outputs",
    "maze-local",
    "site",
    interruptedPrimeVideoId
  );
  const interruptedPrimeResults = path.join(
    interruptedPrimeVideoDir,
    "eval-output",
    "results.jsonl"
  );
  const interruptedPrimeActions = path.join(interruptedPrimeVideoDir, "actions.jsonl");
  fs.mkdirSync(path.dirname(interruptedPrimeResults), { recursive: true });
  fs.writeFileSync(interruptedPrimeResults, "");
  fs.writeFileSync(
    path.join(interruptedPrimeVideoDir, "run.json"),
    `${JSON.stringify({
      id: interruptedPrimeVideoId,
      kind: "prime",
      created_at: new Date().toISOString(),
      status: "finished",
      model: "prime",
      model_name: "video-fallback-test",
      game_id: "maze",
      level_id: "level_HxI",
      moves: 1,
      mode: "text",
      gem_total: 1
    }, null, 2)}\n`
  );
  fs.writeFileSync(
    interruptedPrimeActions,
    `${JSON.stringify({ turn: 1, command_text: "up", valid: true, status: {} })}\n`
  );
  const interruptedPrimeVideo = service.generateRunVideo(interruptedPrimeVideoId);
  assert.equal(interruptedPrimeVideo.video_status, "rendering");
  const interruptedPrimeVideoArgsDeadline = Date.now() + 3000;
  while (
    !fs.existsSync(path.join(interruptedPrimeVideoDir, "video-args.json")) &&
    Date.now() < interruptedPrimeVideoArgsDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const interruptedPrimeVideoArgs = loadJson(
    path.join(interruptedPrimeVideoDir, "video-args.json"),
    []
  );
  assert.equal(interruptedPrimeVideoArgs[0], interruptedPrimeActions);
  assert.deepEqual(
    interruptedPrimeVideoArgs.slice(
      interruptedPrimeVideoArgs.indexOf("--max-video-mib"),
      interruptedPrimeVideoArgs.indexOf("--max-video-mib") + 2
    ),
    ["--max-video-mib", "24"]
  );
  service.cancelRunVideo(interruptedPrimeVideoId);
  service.deleteRun(interruptedPrimeVideoId);

  assert.throws(
    () => service.launchRuns({
      kind: "prime",
      model_name: "hosted-test",
      max_turns: 1,
      hosted: true,
      video: false
    }),
    /Hosted agent evaluations do not run the V1 harness and Toolset route/
  );

  const [visionPrime] = service.launchRuns({
    kind: "prime",
    model_name: "vision-test",
    max_turns: 1,
    vision: true,
    video: false
  });
  launchedIds.push(visionPrime.id);
  const visionPrimeMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", visionPrime.id, "run.json")
  );
  assert.equal(visionPrimeMeta.prime_execution, "local");
  assert.doesNotMatch(visionPrimeMeta.command, /--hosted/);
  assert.match(visionPrimeMeta.command, /--vision/);
  service.stopRun(visionPrime.id);
  service.deleteRun(visionPrime.id);

  const [jsonPrime] = service.launchRuns({
    kind: "prime",
    model_name: "json-test",
    max_turns: 1,
    mode: "json",
    omniscient: true,
    hide_names: true,
    hide_names_seed: "repeatable-prime-seed",
    video: false
  });
  launchedIds.push(jsonPrime.id);
  const jsonPrimeMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", jsonPrime.id, "run.json")
  );
  assert.equal(jsonPrimeMeta.prime_execution, "local");
  assert.equal(jsonPrimeMeta.mode, "json");
  assert.equal(jsonPrimeMeta.omniscient, true);
  assert.equal(jsonPrimeMeta.hide_names, true);
  assert.equal(jsonPrimeMeta.hide_names_seed, "repeatable-prime-seed");
  assert.equal(jsonPrimeMeta.launch_params.hide_names_seed, "repeatable-prime-seed");
  assert.match(jsonPrimeMeta.command, /--observation-mode json/);
  assert.match(jsonPrimeMeta.command, /--omniscient/);
  assert.match(jsonPrimeMeta.command, /--hide-names/);
  assert.match(jsonPrimeMeta.command, /--hide-names-seed repeatable-prime-seed/);
  service.stopRun(jsonPrime.id);
  service.deleteRun(jsonPrime.id);

  for (const unsafeLocal of [
    { kind: "local", model: "other", container: true, tool_use: "read-only" },
    { kind: "local", model: "codex", container: false, tool_use: "read-only" },
    { kind: "local", model: "claude", container: true, tools: true, tool_use: "read-only" },
    { kind: "local", model: "kimi", container: true, tool_use: "read-only", swarm: true }
  ]) {
    assert.throws(
      () => service.launchRuns(unsafeLocal),
      /Certified local coding-agent routes require/
    );
  }
  agentEnvironmentState = { ...agentEnvironmentState, local_agent_image: false, local_codex_image: false };
  assert.throws(
    () => service.launchRuns({ kind: "local", model: "codex", container: true, tool_use: "read-only" }),
    /certified local-agent image is missing or stale/
  );
  agentEnvironmentState = { ...agentEnvironmentState, local_agent_image: true, local_codex_image: true };

  for (const [model, harness, version] of [
    ["codex", "codex", "0.146.0"],
    ["claude", "claude_code", "2.1.220"],
    ["kimi", "kimi_code", "0.29.1"]
  ]) {
    const [isolatedLocal] = service.launchRuns({
      kind: "local",
      subscription: true,
      model,
      container: true,
      tools: false,
      tool_use: "read-only",
      swarm: false,
      moves: 1,
      video: false
    });
    launchedIds.push(isolatedLocal.id);
    assert.equal(isolatedLocal.harness, harness);
    assert.equal(isolatedLocal.harness_version, version);
    assert.equal(isolatedLocal.harness_boundary, "disposable-container/game-tools-only");
    assert.equal(isolatedLocal.container, true);
    assert.equal(isolatedLocal.tools, false);
    assert.equal(isolatedLocal.tool_use, "read-only");
    assert.match(isolatedLocal.command, new RegExp(`model=${model}`));
    assert.match(isolatedLocal.command, /container=true/);
    assert.match(isolatedLocal.note, /game controls only/);
    service.stopRun(isolatedLocal.id);
    service.deleteRun(isolatedLocal.id);

    const [isolatedLocalTools] = service.launchRuns({
      kind: "local",
      subscription: true,
      model,
      container: true,
      tools: true,
      tool_use: "offline",
      auto_run_tools: false,
      auto_run_all_frames: false,
      swarm: false,
      moves: 1,
      video: false
    });
    launchedIds.push(isolatedLocalTools.id);
    assert.equal(isolatedLocalTools.harness, harness);
    assert.equal(isolatedLocalTools.harness_boundary, "disposable-container/game-tools+isolated-python");
    assert.equal(isolatedLocalTools.tools, true);
    assert.equal(isolatedLocalTools.tool_use, "offline");
    assert.equal(isolatedLocalTools.launch_params.tools, true);
    assert.equal(isolatedLocalTools.launch_params.tool_use, "offline");
    assert.match(isolatedLocalTools.command, /tools=true/);
    assert.match(isolatedLocalTools.command, /tool_use=offline/);
    assert.match(isolatedLocalTools.note, /run-scoped Python scratchpad/);
    service.stopRun(isolatedLocalTools.id);
    service.deleteRun(isolatedLocalTools.id);
  }

  const retiredLocalId = "retired-local-run";
  const retiredLocalDir = path.join(rootDir, "outputs", "maze-local", "site", retiredLocalId);
  fs.mkdirSync(retiredLocalDir, { recursive: true });
  fs.writeFileSync(
    path.join(retiredLocalDir, "run.json"),
    `${JSON.stringify({
      id: retiredLocalId,
      kind: "local",
      model: "codex",
      model_name: "gpt-test",
      status: "finished",
      created_at: new Date().toISOString(),
      game_id: "maze",
      level_id: "level_HxI",
      mode: "text",
      moves: 1,
      gem_total: 1,
      room_total: 1
    }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(retiredLocalDir, "actions.jsonl"),
    `${JSON.stringify({ turn: 1, command_text: "up", valid: true, status: {} })}\n`
  );
  for (const operation of [
    () => service.resumeRun(retiredLocalId),
    () => service.continueRun(retiredLocalId, 1),
    () => service.branchRun(retiredLocalId, 0),
    () => service.setRunMoveTarget(retiredLocalId, 2)
  ]) {
    assert.throws(operation, /Certified local coding-agent routes require/);
  }
  service.deleteRun(retiredLocalId);

  const originalHome = process.env.HOME;
  const codexHome = path.join(rootDir, "codex-home");
  const codexCachePath = path.join(codexHome, ".codex", "models_cache.json");
  fs.mkdirSync(path.dirname(codexCachePath), { recursive: true });
  const writeCodexCache = (slugs, fetchedAt) => {
    fs.writeFileSync(
      codexCachePath,
      JSON.stringify({
        fetched_at: fetchedAt,
        models: slugs.map((slug, priority) => ({
          slug,
          display_name: slug.toUpperCase(),
          priority,
          supported_reasoning_levels: [{ effort: "high" }]
        }))
      })
    );
  };

  try {
    process.env.HOME = codexHome;
    writeCodexCache(["gpt-new", "gpt-current"], "2026-07-10T01:00:00Z");
    assert.deepEqual(
      service.listProviderModels("codex").models.map((model) => model.id),
      ["gpt-new", "gpt-current"]
    );

    // A newer disk write containing an older subset must not make a model
    // disappear, and Codex requests must bypass the provider TTL cache.
    writeCodexCache(["gpt-current"], "2026-07-10T02:00:00Z");
    assert.deepEqual(
      service.listProviderModels("codex").models.map((model) => model.id),
      ["gpt-new", "gpt-current"]
    );

    writeCodexCache(["gpt-next", "gpt-new", "gpt-current"], "2026-07-10T03:00:00Z");
    assert.deepEqual(
      service.listProviderModels("codex").models.map((model) => model.id),
      ["gpt-next", "gpt-new", "gpt-current"]
    );

    // The last-known-good catalog survives a local server restart.
    writeCodexCache(["gpt-current"], "2026-07-10T04:00:00Z");
    const restartedService = createAgentRunService({
      agentEnvironment: () => agentEnvironmentState,
      ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
      getGame: (id) => (id === "maze" ? game : null),
      buildWorlds: { countWorldGems: () => 1 },
      loadJson,
      rootDir,
      worldMaps: {
        defaultLevelIdForGame: () => "level_HxI",
        isMazeWorldLevelId: () => true
      }
    });
    assert.deepEqual(
      restartedService.listProviderModels("codex").models.map((model) => model.id),
      ["gpt-next", "gpt-new", "gpt-current"]
    );
  } finally {
    process.env.HOME = originalHome;
  }

  console.log("agent queue tests passed");
} finally {
  launchedIds.forEach((runId) => {
    try {
      if (service.summarizeRun(runId)) service.deleteRun(runId);
    } catch (_error) {
      /* already deleted */
    }
  });
  fs.rmSync(rootDir, { recursive: true, force: true });
}
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
