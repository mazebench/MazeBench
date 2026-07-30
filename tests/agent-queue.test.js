const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentRunService, replayMessageForCommandText } = require("../server/agent-runs");
const { BOARD_STATE_HASH_VERSION } = require("../shared/board-state");

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-agent-queue-"));
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
const service = createAgentRunService({
  agentEnvironment: () => ({ codex: true, claude: true, docker: false, docker_installed: false }),
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
  assert.deepEqual(
    harnessRegistry.harnesses.filter((harness) => harness.launchable).map((harness) => harness.id),
    ["bash", "claude_code", "codex", "kimi_code", "mini_swe_agent", "null", "pi", "rlm", "terminus_2"]
  );
  assert.equal(harnessRegistry.harnesses.find((harness) => harness.id === "codex").adapter, "codex_mcp");
  assert.equal(harnessRegistry.harnesses.find((harness) => harness.id === "claude_code").adapter, "claude_mcp");
  assert.equal(harnessRegistry.harnesses.find((harness) => harness.id === "kimi_code").adapter, "kimi_mcp");
  assert.equal(harnessRegistry.harnesses.find((harness) => harness.id === "mini_swe_agent").adapter, "cli_gateway");
  const [customPrime] = service.launchRuns({
    kind: "prime",
    harness: "kimi_code",
    harness_config: { version: "0.15.0" },
    model_name: "openai/gpt-5.6-luna",
    max_turns: 2,
    video: false
  });
  launchedIds.push(customPrime.id);
  const customPrimeMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", customPrime.id, "run.json")
  );
  assert.equal(customPrimeMeta.harness, "kimi_code");
  assert.equal(customPrimeMeta.harness_label, "Kimi Code");
  assert.equal(customPrimeMeta.harness_version, "0.15.0");
  assert.equal(customPrimeMeta.harness_source, "pinned-prime-verifiers");
  assert.deepEqual(customPrimeMeta.harness_config, { version: "0.15.0" });
  assert.equal(customPrimeMeta.harness_boundary, "isolated-game-gateway");
  assert.equal(customPrimeMeta.harness_adapter, "kimi_mcp");
  assert.equal(customPrimeMeta.harness_taskset, "mazebench-tools");
  assert.equal(customPrimeMeta.verifiers_revision, "653bb14003b87e39588bde308fa8626d1038ce15");
  assert.match(customPrimeMeta.harness_catalog_fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(customPrimeMeta.launch_params.harness_config, { version: "0.15.0" });
  assert.match(customPrimeMeta.command, /--harness kimi_code/);
  assert.match(customPrimeMeta.command, /--harness-config \{"version":"0\.15\.0"\}/);
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
  assert.deepEqual(continuedCustomPrime.harness_config, { version: "0.15.0" });
  assert.equal(continuedCustomPrime.harness_boundary, "isolated-game-gateway");
  assert.equal(service.stopRun(continuedCustomPrime.id).status, "stopped");
  service.deleteRun(continuedCustomPrime.id);
  service.deleteRun(customPrime.id);

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
  assert.match(livePrimeMeta.note, /every model turn/);
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
  const primeVideo = service.generateRunVideo(primeVideoId);
  assert.equal(primeVideo.status, "failed");
  assert.equal(primeVideo.video_status, "rendering");
  const primeVideoArgsDeadline = Date.now() + 3000;
  while (!fs.existsSync(path.join(primeVideoDir, "video-args.json")) && Date.now() < primeVideoArgsDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const primeVideoArgs = loadJson(path.join(primeVideoDir, "video-args.json"), []);
  assert.equal(primeVideoArgs[0], path.join(primeVideoDir, "actions.jsonl"));
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
  service.cancelRunVideo(interruptedPrimeVideoId);
  service.deleteRun(interruptedPrimeVideoId);

  const [hostedPrime] = service.launchRuns({
    kind: "prime",
    model_name: "hosted-test",
    max_turns: 1,
    hosted: true,
    video: false
  });
  launchedIds.push(hostedPrime.id);
  const hostedPrimeMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", hostedPrime.id, "run.json")
  );
  assert.equal(hostedPrimeMeta.prime_execution, "hosted");
  assert.match(hostedPrimeMeta.command, /--hosted/);
  service.stopRun(hostedPrime.id);
  service.deleteRun(hostedPrime.id);

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

  const [jsonLocal] = service.launchRuns({
    kind: "local",
    model: "codex",
    game_id: "maze",
    level_id: "level_HxI",
    moves: 1,
    mode: "json",
    omniscient: true,
    hide_names: true,
    hide_names_seed: "repeatable-local-seed",
    container: false,
    video: false
  });
  launchedIds.push(jsonLocal.id);
  const jsonLocalMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", jsonLocal.id, "run.json")
  );
  assert.equal(jsonLocalMeta.mode, "json");
  assert.equal(jsonLocalMeta.omniscient, true);
  assert.equal(jsonLocalMeta.hide_names, true);
  assert.equal(jsonLocalMeta.hide_names_seed, "repeatable-local-seed");
  assert.equal(jsonLocalMeta.launch_params.hide_names_seed, "repeatable-local-seed");
  assert.match(jsonLocalMeta.command, /mode=json/);
  assert.match(jsonLocalMeta.command, /omniscient=true/);
  assert.match(jsonLocalMeta.command, /hide_names=true/);
  assert.match(jsonLocalMeta.command, /hide_names_seed=repeatable-local-seed/);
  const jsonLocalDir = path.join(rootDir, "outputs", "maze-local", "site", jsonLocal.id);
  fs.writeFileSync(path.join(jsonLocalDir, "session.json"), JSON.stringify({
    actions: [],
    gameId: "maze",
    gameWonGemCount: 100,
    levelId: "level_HxI",
    view: "top-diagonal",
    yaw: 0,
    initial: { level: "ASCII-ONLY" }
  }));
  fs.writeFileSync(path.join(jsonLocalDir, "initial-status.json"), JSON.stringify({ level: "ASCII-ONLY" }));
  const reconstructedJson = service.getRunObservation(jsonLocal.id, { turn: 0 });
  assert.equal(reconstructedJson.board, "ASCII-ONLY");
  assert.deepEqual(reconstructedJson.json_observation, {
    mode: "json",
    omniscient: true,
    hide_names: true,
    objects: []
  });
  const cachedActionsPath = path.join(jsonLocalDir, "actions.jsonl");
  fs.writeFileSync(cachedActionsPath, `${JSON.stringify({
    turn: 1,
    command_text: "up",
    status: { current_room: "level_HxI" }
  })}\n`);
  assert.equal(service.getRunProgress(jsonLocal.id).actions[0].command_text, "up");
  const replacementActionsPath = `${cachedActionsPath}.replacement`;
  fs.writeFileSync(replacementActionsPath, `${JSON.stringify({
    turn: 1,
    command_text: "right",
    status: { current_room: "level_HxI", level: "A MUCH LARGER ATOMIC REPLACEMENT" }
  })}\n`);
  fs.renameSync(replacementActionsPath, cachedActionsPath);
  const replacedActions = service.getRunProgress(jsonLocal.id).actions;
  assert.equal(replacedActions.length, 1, "atomic action-file replacement must not append cached rows");
  assert.equal(replacedActions[0].command_text, "right");
  service.stopRun(jsonLocal.id);
  service.deleteRun(jsonLocal.id);

  const [hostReadOnlySwarm] = service.launchRuns({
    kind: "local",
    model: "codex",
    model_name: "gpt-test",
    game_id: "maze",
    level_id: "level_HxI",
    moves: 1,
    allow_quit: false,
    mode: "text",
    hide_names: true,
    container: false,
    tools: false,
    tool_use: "read-only",
    swarm: true,
    video: false
  });
  launchedIds.push(hostReadOnlySwarm.id);
  const hostSwarmMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", hostReadOnlySwarm.id, "run.json")
  );
  assert.equal(hostSwarmMeta.tool_use, "read-only");
  assert.equal(hostSwarmMeta.tools, false);
  assert.equal(hostSwarmMeta.swarm, false, "game-only mode must disable provider workers");
  assert.equal(hostSwarmMeta.container, false);
  assert.equal(hostSwarmMeta.allow_quit, false);
  assert.equal(hostSwarmMeta.hide_names_seed, "1");
  assert.equal(hostSwarmMeta.launch_params.hide_names_seed, hostSwarmMeta.hide_names_seed);
  assert.equal(hostSwarmMeta.launch_params.allow_quit, false);
  assert.match(hostSwarmMeta.command, /tool_use=read-only/);
  assert.match(hostSwarmMeta.command, /allow_quit=false/);
  assert.match(hostSwarmMeta.command, /swarm=false/);
  const retargeted = service.setRunMoveTarget(hostReadOnlySwarm.id, 100_000);
  assert.equal(retargeted.moves, 100_000);
  const retargetedMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", hostReadOnlySwarm.id, "run.json")
  );
  assert.equal(retargetedMeta.auto_continue_target, 100_000);
  assert.equal(retargetedMeta.segment_move_budget, 1);
  assert.equal(retargetedMeta.launch_params.moves, 100_000);

  const swarmWorkerDir = path.join(
    rootDir,
    "outputs",
    "maze-local",
    "site",
    hostReadOnlySwarm.id,
    "swarm",
    "scout_one"
  );
  fs.mkdirSync(path.join(swarmWorkerDir, "frames"), { recursive: true });
  fs.writeFileSync(path.join(swarmWorkerDir, "worker.json"), JSON.stringify({
    id: "scout_one",
    fork_action_count: 5,
    label: "north scout",
    observation_mode: "text",
    owner_kind: "subagent",
    parent_instance_id: "primary"
  }));
  fs.writeFileSync(path.join(swarmWorkerDir, "telemetry.json"), JSON.stringify({
    actions_applied: 2,
    actions_attempted: 3,
    last_action: "up"
  }));
  fs.writeFileSync(
    path.join(swarmWorkerDir, "actions.jsonl"),
    Array.from({ length: 7 }, (_, index) => JSON.stringify({
      turn: index + 1,
      command_text: index < 5 ? "inherited" : index === 5 ? "right" : "up",
      status: {
        current_room: "level_GxH",
        current_view: "top-diagonal",
        gem_count: index === 6 ? 2 : 0,
        level: `BOARD-${index + 1}`,
        player: { elevation: 0, x: index + 1, y: 0 },
        yaw: 1
      }
    })).join("\n") + "\n"
  );
  fs.writeFileSync(path.join(swarmWorkerDir, "frames", "frame-007.png"), "png");
  fs.writeFileSync(
    path.join(rootDir, "outputs", "maze-local", "site", hostReadOnlySwarm.id, "initial-status.json"),
    JSON.stringify({ player: { elevation: 3, x: 4, y: 12 } })
  );
  const swarmProgress = service.getRunProgress(hostReadOnlySwarm.id);
  assert.deepEqual(swarmProgress.initial_player, { elevation: 3, x: 4, y: 12 });
  assert.equal(swarmProgress.swarm_views.length, 1);
  assert.equal(swarmProgress.swarm_views[0].id, "scout_one");
  assert.equal(swarmProgress.swarm_views[0].room, "level_GxH");
  assert.equal(swarmProgress.swarm_views[0].turn, 7);
  assert.equal(swarmProgress.swarm_views[0].auxiliary_actions, 2);
  assert.equal(swarmProgress.swarm_views[0].auxiliary_action_attempts, 3);
  assert.equal(swarmProgress.swarm_views[0].inherited_action_count, 5);
  assert.equal(swarmProgress.swarm_views[0].observation_mode, "text");
  assert.equal(swarmProgress.swarm_views[0].owner_kind, "subagent");
  assert.equal(swarmProgress.instance_activity.instances, 1);
  assert.equal(swarmProgress.instance_activity.auxiliary_actions, 2);
  assert.equal(swarmProgress.run.explorer_instances, 1);
  assert.equal(swarmProgress.run.auxiliary_actions, 2);
  assert.equal(swarmProgress.run.simulated_actions, swarmProgress.run.turns + 2);
  assert.deepEqual(swarmProgress.swarm_views[0].player, { elevation: 0, x: 7, y: 0 });
  assert.equal(swarmProgress.swarm_views[0].frame_url, null);
  const forkObservation = service.getRunObservation(hostReadOnlySwarm.id, {
    instanceId: "scout_one",
    turn: 0
  });
  const latestObservation = service.getRunObservation(hostReadOnlySwarm.id, {
    instanceId: "scout_one",
    turn: 2
  });
  assert.equal(forkObservation.turn, 0);
  assert.equal(forkObservation.absolute_turn, 5);
  assert.equal(forkObservation.total, 2);
  assert.equal(forkObservation.board, "BOARD-5");
  assert.equal(latestObservation.turn, 2);
  assert.equal(latestObservation.absolute_turn, 7);
  assert.equal(latestObservation.command_text, "up");
  assert.equal(latestObservation.frame_url, null);
  assert.equal(
    service.resolveRunFilePath(hostReadOnlySwarm.id, "swarm/scout_one/frames/frame-007.png"),
    path.join(swarmWorkerDir, "frames", "frame-007.png")
  );
  assert.equal(service.resolveRunFilePath(hostReadOnlySwarm.id, "swarm/../run.json"), null);

  const hostRunDir = path.join(rootDir, "outputs", "maze-local", "site", hostReadOnlySwarm.id);
  fs.writeFileSync(
    path.join(hostRunDir, "tool-activity.jsonl"),
    `${JSON.stringify({
      id: "maze-1",
      tool: "maze_action",
      actor: "worker",
      clone_id: "scout_one",
      action: "up",
      started_at: "2026-07-10T00:00:01.000Z",
      completed_at: "2026-07-10T00:00:01.200Z",
      duration_ms: 200,
      status: "completed",
      move_calls: 1
    })}\n`
  );
  fs.writeFileSync(
    path.join(hostRunDir, "agent-events.jsonl"),
    [
      {
        type: "item.started",
        item: { id: "algo-1", type: "command_execution", command: "node explore.js", status: "in_progress" },
        _mazebench_received_at: "2026-07-10T00:00:00.000Z"
      },
      {
        type: "item.completed",
        item: { id: "algo-1", type: "command_execution", command: "node explore.js", status: "completed" },
        _mazebench_received_at: "2026-07-10T00:00:02.000Z"
      }
    ].map(JSON.stringify).join("\n") + "\n"
  );
  const activityProgress = service.getRunProgress(hostReadOnlySwarm.id);
  assert(activityProgress.tool_activity.recent.some((row) => row.label === "Algorithm · explore.js"));
  assert(activityProgress.tool_activity.recent.some((row) => row.label === "Maze · action"));
  assert.equal(
    activityProgress.tool_activity.recent.find((row) => row.label === "Algorithm · explore.js").moves_tried,
    1
  );

  fs.appendFileSync(
    path.join(rootDir, "outputs", "maze-local", "site", hostReadOnlySwarm.id, "agent-events.jsonl"),
    `${JSON.stringify({ type: "thread.started", thread_id: "cold-pause-thread" })}\n`
  );
  const savedAction = {
    turn: 1,
    command_text: "up",
    status: { current_room: "level_HxI", gem_count: 0 }
  };
  fs.writeFileSync(
    path.join(hostRunDir, "session.json"),
    `${JSON.stringify({ actions: [savedAction], lastStatus: savedAction.status }, null, 2)}\n`
  );
  fs.writeFileSync(path.join(hostRunDir, "actions.jsonl"), `${JSON.stringify(savedAction)}\n{"partial"`);
  fs.appendFileSync(
    path.join(hostRunDir, "tool-activity.jsonl"),
    `${JSON.stringify({
      id: "python-paused",
      tool: "python_exec",
      actor: "lead",
      started_at: new Date(Date.now() - 100).toISOString(),
      status: "running",
      python_code: "while True: pass",
      python_code_hash: "paused-hash"
    })}\n`
  );
  const nestedPid = Number(fs.readFileSync(path.join(hostRunDir, "nested-runner.pid"), "utf8"));
  const pauseRequested = service.pauseRun(hostReadOnlySwarm.id);
  assert.equal(pauseRequested.status, "paused");
  assert.equal(pauseRequested.pause_mode, "cold");
  assert.match(pauseRequested.pause_message, /cancelled immediately/);
  const pauseDeadline = Date.now() + 3000;
  let nestedAlive = true;
  while (nestedAlive && Date.now() < pauseDeadline) {
    try {
      process.kill(nestedPid, 0);
    } catch (_error) {
      nestedAlive = false;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(nestedAlive, false, "pause kills nested provider/tool processes");
  const pausedHostRun = service.summarizeRun(hostReadOnlySwarm.id);
  assert.equal(pausedHostRun.status, "paused");
  assert.equal(pausedHostRun.pause_reason, "manual");
  assert.equal(pausedHostRun.pause_mode, "cold");
  assert.equal(pausedHostRun.pid, null);
  assert.deepEqual(
    fs.readFileSync(path.join(hostRunDir, "actions.jsonl"), "utf8").trim().split("\n").map(JSON.parse),
    [savedAction],
    "immediate pause repairs a partial action log from the last complete session"
  );
  const pausedActivity = fs.readFileSync(path.join(hostRunDir, "tool-activity.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter((entry) => entry.id === "python-paused");
  assert.equal(pausedActivity.at(-1).status, "cancelled");
  fs.writeFileSync(path.join(hostRunDir, "session.json"), "{}\n");
  const renderingVideo = service.generateRunVideo(hostReadOnlySwarm.id);
  assert.equal(renderingVideo.video_status, "rendering");
  assert.equal(renderingVideo.has_video, false);
  assert.equal(fs.existsSync(path.join(hostRunDir, "replay-progress.json")), true);
  const videoArgsDeadline = Date.now() + 3000;
  while (!fs.existsSync(path.join(hostRunDir, "video-args.json")) && Date.now() < videoArgsDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const videoArgs = loadJson(path.join(hostRunDir, "video-args.json"), []);
  assert(videoArgs.includes("--intro"));
  assert(videoArgs.includes("--ascii-side-by-side"));
  assert.equal(videoArgs.includes("--draft"), false);
  assert.equal(videoArgs[videoArgs.indexOf("--preset") + 1], "veryfast");
  assert.equal(videoArgs[videoArgs.indexOf("--crf") + 1], "25");
  assert.equal(videoArgs[videoArgs.indexOf("--max-video-mib") + 1], "24");
  assert.ok(videoArgs.includes("--accelerated"));
  const canceledVideo = service.cancelRunVideo(hostReadOnlySwarm.id);
  assert.equal(canceledVideo.video_status, "idle");
  assert.equal(fs.existsSync(path.join(hostRunDir, "replay-progress.json")), false);
  fs.writeFileSync(path.join(hostRunDir, "maze_replay.mp4"), "old replay");
  const readyMeta = loadJson(path.join(hostRunDir, "run.json"), {});
  fs.writeFileSync(
    path.join(hostRunDir, "run.json"),
    JSON.stringify({ ...readyMeta, video_status: "ready" })
  );
  assert.equal(service.summarizeRun(hostReadOnlySwarm.id).has_video, true);
  const regeneratedVideo = service.regenerateRunVideo(hostReadOnlySwarm.id);
  assert.equal(regeneratedVideo.video_status, "rendering");
  assert.equal(regeneratedVideo.has_video, false);
  assert.equal(fs.existsSync(path.join(hostRunDir, "maze_replay.mp4")), false);
  const resumedHostRun = service.resumeRun(hostReadOnlySwarm.id);
  assert.equal(resumedHostRun.status, "running");
  assert.match(resumedHostRun.command, /resume=cold-pause-thread/);
  assert.equal(resumedHostRun.video_status, "idle");
  assert.equal(resumedHostRun.has_video, false);
  assert.equal(fs.existsSync(path.join(hostRunDir, "replay-progress.json")), false);
  const resumedHostMeta = loadJson(path.join(hostRunDir, "run.json"), {});
  assert.equal("video_pid" in resumedHostMeta, false);
  assert.equal("video_generation_id" in resumedHostMeta, false);
  const stopAlias = service.stopRun(hostReadOnlySwarm.id);
  assert.equal(stopAlias.status, "paused", "local Stop aliases the same immediate resumable pause");
  service.deleteRun(hostReadOnlySwarm.id);

  const [unlimitedRun] = service.launchRuns({
    kind: "local",
    model: "codex",
    model_name: "gpt-test",
    game_id: "maze",
    level_id: "level_HxI",
    moves: 5,
    unlimited: true,
    mode: "text",
    container: false,
    tools: false,
    tool_use: "read-only",
    swarm: false,
    video: false
  });
  launchedIds.push(unlimitedRun.id);
  const unlimitedMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", unlimitedRun.id, "run.json")
  );
  assert.equal(unlimitedMeta.unlimited, true);
  assert.equal(unlimitedMeta.moves, null);
  assert.equal(unlimitedMeta.segment_move_budget, null);
  assert.equal(unlimitedMeta.launch_params.unlimited, true);
  assert.match(unlimitedMeta.command, /unlimited=true/);
  const unlimitedSummary = service.summarizeRun(unlimitedRun.id);
  assert.equal(unlimitedSummary.progress.unlimited, true);
  assert.equal(unlimitedSummary.progress.total, null);
  assert.equal(unlimitedSummary.progress.eta_ms, null);
  const toolInstanceDir = path.join(
    rootDir,
    "outputs",
    "maze-local",
    "site",
    unlimitedRun.id,
    "swarm",
    "tool_search"
  );
  fs.mkdirSync(toolInstanceDir, { recursive: true });
  fs.writeFileSync(path.join(toolInstanceDir, "worker.json"), JSON.stringify({
    id: "tool_search",
    fork_action_count: 0,
    label: "search algorithm",
    observation_mode: "text",
    owner_kind: "tool",
    parent_instance_id: "primary"
  }));
  fs.writeFileSync(path.join(toolInstanceDir, "telemetry.json"), JSON.stringify({
    actions_applied: 0,
    actions_attempted: 0
  }));
  fs.writeFileSync(path.join(toolInstanceDir, "session.json"), JSON.stringify({
    actions: [],
    vision: false,
    initial: {
      current_room: "level_HxI",
      current_view: "top-diagonal",
      gem_count: 0,
      level: "AP",
      player: { elevation: 0, x: 1, y: 0 },
      yaw: 0
    }
  }));
  const toolInstanceProgress = service.getRunProgress(unlimitedRun.id);
  assert.equal(toolInstanceProgress.run.swarm, false);
  assert.equal(toolInstanceProgress.swarm_views.length, 1, "tool-created instances stay visible outside swarm mode");
  assert.equal(toolInstanceProgress.swarm_views[0].owner_kind, "tool");
  service.stopRun(unlimitedRun.id);
  service.deleteRun(unlimitedRun.id);

  const runs = service.launchRuns({
    kind: "local",
    model: "claude",
    model_name: "test/model",
    game_id: "maze",
    level_id: "level_HxI",
    moves: 5,
    mode: "text",
    container: false,
    tools: true,
    video: false,
    count: 3
  });
  launchedIds.push(...runs.map((run) => run.id));

  assert.deepEqual(runs.map((run) => run.status), ["running", "running", "running"]);
  runs.forEach((run) => assert.ok(run.pid, "every Claude run should start immediately"));

  const secondMeta = loadJson(path.join(rootDir, "outputs", "maze-local", "site", runs[1].id, "run.json"));
  const thirdMeta = loadJson(path.join(rootDir, "outputs", "maze-local", "site", runs[2].id, "run.json"));
  assert.equal(secondMeta.auto_run_tools, true);
  assert.equal(secondMeta.auto_run_all_frames, true);
  assert.equal(secondMeta.launch_params.auto_run_tools, undefined);
  assert.equal(secondMeta.launch_params.auto_run_all_frames, undefined);
  assert.match(secondMeta.command, /auto_run_tools=true/);
  assert.match(secondMeta.command, /auto_run_all_frames=true/);
  assert.equal(secondMeta.queue_order, undefined);
  assert.equal(thirdMeta.queue_order, undefined);

  const metricFixtures = [
    { run: runs[0], actions: 1, rooms: 2, gems: 3 },
    { run: runs[1], actions: 3, rooms: 1, gems: 2 },
    { run: runs[2], actions: 2, rooms: 3, gems: 5 }
  ];
  metricFixtures.forEach(({ run, actions, rooms, gems }) => {
    const runDir = path.join(rootDir, "outputs", "maze-local", "site", run.id);
    const actionRows = Array.from({ length: actions }, (_, index) => ({
      turn: index + 1,
      command_text: "up",
      status: { current_room: `level_${String.fromCharCode(65 + index)}xA`, gem_count: gems }
    }));
    fs.writeFileSync(path.join(runDir, "actions.jsonl"), `${actionRows.map(JSON.stringify).join("\n")}\n`);
    fs.writeFileSync(
      path.join(runDir, "maze_scorecard.json"),
      `${JSON.stringify({ actions: { total: actions }, rooms: { visited: rooms, total: 256 }, gems: { collected: gems, total: 69 } })}\n`
    );
  });

  const continuedFixtureDir = path.join(rootDir, "outputs", "maze-local", "site", runs[0].id);
  fs.writeFileSync(
    path.join(continuedFixtureDir, "maze_scorecard.json"),
    `${JSON.stringify({
      actions: { total: 0 },
      rooms: { visited: 1, total: 256 },
      gems: { collected: 2, total: 69 }
    })}\n`
  );
  const continuedFixtureSummary = service.summarizeRun(runs[0].id);
  assert.equal(continuedFixtureSummary.turns, 1);
  assert.equal(continuedFixtureSummary.gem_count, 3, "continued runs ignore stale collected-gem scorecards");
  assert.equal(continuedFixtureSummary.room_count, 2, "continued runs ignore stale visited-room scorecards");

  assert.deepEqual(
    service.listRuns({ sort: "actions", pageSize: 10 }).runs.map((run) => run.id),
    [runs[1].id, runs[2].id, runs[0].id]
  );
  assert.deepEqual(
    service.listRuns({ sort: "rooms", pageSize: 10 }).runs.map((run) => run.id),
    [runs[2].id, runs[0].id, runs[1].id]
  );
  assert.deepEqual(
    service.listRuns({ sort: "gems", pageSize: 10 }).runs.map((run) => run.id),
    [runs[2].id, runs[0].id, runs[1].id]
  );

  service.deleteRun(runs[0].id);
  assert.equal(service.summarizeRun(runs[1].id).status, "running");
  assert.equal(service.summarizeRun(runs[2].id).status, "running");

  service.deleteRun(runs[1].id);
  assert.equal(service.summarizeRun(runs[2].id).status, "running");

  service.stopRun(runs[2].id);
  service.deleteRun(runs[2].id);

  fs.writeFileSync(
    path.join(scriptsDir, "maze-agent-local.js"),
    `const fs = require("node:fs");
const path = require("node:path");
const args = Object.fromEntries(process.argv.slice(2).map((part) => {
  const at = part.indexOf("=");
  return at < 0 ? [part, ""] : [part.slice(0, at), part.slice(at + 1)];
}));
fs.mkdirSync(args.out, { recursive: true });
if (!args.resume) {
  fs.writeFileSync(path.join(args.out, "agent-events.jsonl"), JSON.stringify({ type: "thread.started", thread_id: "no-quit-thread" }) + "\\n");
  process.exit(0);
}
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
`,
    "utf8"
  );
  const [noQuitRun] = service.launchRuns({
    kind: "local",
    model: "codex",
    model_name: "gpt-test",
    game_id: "maze",
    level_id: "level_HxI",
    moves: 5,
    allow_quit: false,
    mode: "text",
    container: false,
    tools: false,
    tool_use: "read-only",
    swarm: false,
    video: false
  });
  launchedIds.push(noQuitRun.id);
  const noQuitDeadline = Date.now() + 3000;
  let noQuitSummary = service.summarizeRun(noQuitRun.id);
  while ((noQuitSummary.continued || 0) < 1 && Date.now() < noQuitDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    noQuitSummary = service.summarizeRun(noQuitRun.id);
  }
  assert.equal(noQuitSummary.status, "running");
  assert.equal(noQuitSummary.allow_quit, false);
  assert.equal(noQuitSummary.continued, 1, "a clean early exit must resume the same provider thread");
  assert.equal(noQuitSummary.moves, 5, "automatic persistence must retain the user's action target");
  assert.match(noQuitSummary.command, /resume=no-quit-thread/);
  service.stopRun(noQuitRun.id);
  service.deleteRun(noQuitRun.id);

  fs.writeFileSync(
    path.join(scriptsDir, "maze-agent-local.js"),
    `const fs = require("node:fs");
const path = require("node:path");
const args = Object.fromEntries(process.argv.slice(2).map((part) => {
  const at = part.indexOf("=");
  return at < 0 ? [part, ""] : [part.slice(0, at), part.slice(at + 1)];
}));
fs.mkdirSync(args.out, { recursive: true });
fs.writeFileSync(path.join(args.out, "agent-events.jsonl"), JSON.stringify({ type: "thread.started", thread_id: "retry-thread" }) + "\\n");
fs.writeFileSync(path.join(args.out, "provider-failure.json"), JSON.stringify({ provider: "claude", status: 502, message: "Bad Gateway", detected_at: new Date().toISOString() }));
process.exit(75);
`,
    "utf8"
  );
  const [providerFailureRun] = service.launchRuns({
    kind: "local",
    model: "claude",
    model_name: "claude-test",
    game_id: "maze",
    level_id: "level_HxI",
    moves: 5,
    mode: "text",
    container: false,
    tools: false,
    tool_use: "read-only",
    swarm: false,
    video: false
  });
  launchedIds.push(providerFailureRun.id);
  const providerFailureDeadline = Date.now() + 3000;
  let providerFailureSummary = service.summarizeRun(providerFailureRun.id);
  while (providerFailureSummary.status === "running" && Date.now() < providerFailureDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    providerFailureSummary = service.summarizeRun(providerFailureRun.id);
  }
  assert.equal(providerFailureSummary.status, "paused");
  assert.equal(providerFailureSummary.pause_reason, "provider_backoff");
  assert.equal(providerFailureSummary.pause_mode, "cold");
  assert.equal(providerFailureSummary.pid, null);
  assert.equal(providerFailureSummary.provider_failure_status, 502);
  assert.equal(providerFailureSummary.provider_retry_attempt, 1);
  assert(Date.parse(providerFailureSummary.retry_at) > Date.now());

  // Backoff pauses created before pause_mode was recorded are also resource-free
  // and must not prevent a newer Claude run from starting.
  const providerFailureMetaPath = path.join(
    rootDir,
    "outputs",
    "maze-local",
    "site",
    providerFailureRun.id,
    "run.json"
  );
  const legacyProviderFailureMeta = loadJson(providerFailureMetaPath, {});
  delete legacyProviderFailureMeta.pause_mode;
  legacyProviderFailureMeta.pid = 999999;
  fs.writeFileSync(providerFailureMetaPath, `${JSON.stringify(legacyProviderFailureMeta, null, 2)}\n`);
  fs.writeFileSync(
    path.join(scriptsDir, "maze-agent-local.js"),
    "setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(0));\n",
    "utf8"
  );
  const [runAfterProviderBackoff] = service.launchRuns({
    kind: "local",
    model: "claude",
    model_name: "claude-test",
    game_id: "maze",
    level_id: "level_HxI",
    moves: 5,
    mode: "text",
    container: false,
    tools: false,
    tool_use: "read-only",
    swarm: false,
    video: false
  });
  launchedIds.push(runAfterProviderBackoff.id);
  assert.equal(runAfterProviderBackoff.status, "running");
  assert.ok(runAfterProviderBackoff.pid, "a newer Claude run should start during provider backoff");
  service.stopRun(runAfterProviderBackoff.id);
  service.deleteRun(runAfterProviderBackoff.id);
  service.deleteRun(providerFailureRun.id);

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
      agentEnvironment: () => ({ codex: true, claude: true, docker: false, docker_installed: false }),
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
