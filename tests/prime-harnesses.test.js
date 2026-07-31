const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  agenticHarnessArgs,
  agenticConversationTurns,
  parseArgs,
  retryablePrimeProviderError,
  writeMoveArtifacts
} = require("../scripts/maze-prime-run");
const {
  createAgentRunService,
  filterPrimeCatalogForHarness,
  normalizePrimeHarnessConfig,
  primeReasoningLevels,
  primeHarnessModelCompatible,
  primeSandboxIdsFromText,
  publicPrimeHarnesses
} = require("../server/agent-runs");
const { findPrimeResultsFile } = require("../server/token-usage");

const root = path.join(__dirname, "..");
const environmentDir = path.join(root, "environments", "mazebench");
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-prime-harness-"));
const statePath = path.join(runDir, "session.json");

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

try {
  const agentSource = fs.readFileSync(path.join(root, "public", "agent.js"), "utf8");
  const runSource = fs.readFileSync(path.join(root, "scripts", "maze-prime-run.js"), "utf8");
  const retiredLocalAgentSource = fs.readFileSync(
    path.join(root, "scripts", "maze-agent-local.js"),
    "utf8"
  );
  const liveSource = fs.readFileSync(
    path.join(root, "scripts", "maze-prime-live-eval.py"),
    "utf8"
  );
  const retiredTasksetSource = fs.readFileSync(
    path.join(root, "environments", "mazebench_agent", "mazebench_agent", "__init__.py"),
    "utf8"
  );
  const toolsTasksetSource = fs.readFileSync(
    path.join(environmentDir, "mazebench_tools", "__init__.py"),
    "utf8"
  );
  const mazeTasksetSource = fs.readFileSync(
    path.join(environmentDir, "mazebench", "mazebench.py"),
    "utf8"
  );
  const project = fs.readFileSync(path.join(environmentDir, "pyproject.toml"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "server", "app.js"), "utf8");
  const runsSource = fs.readFileSync(path.join(root, "server", "agent-runs.js"), "utf8");
  const pagesSource = fs.readFileSync(path.join(root, "server", "pages.js"), "utf8");
  const harnessCatalog = JSON.parse(
    fs.readFileSync(path.join(environmentDir, "prime-harness-catalog.json"), "utf8")
  );

  assert.doesNotMatch(agentSource, /kind: "local",\s*subscription: true/);
  assert.doesNotMatch(
    appSource,
    /probeCommand\("(?:codex|claude|kimi)"|runCommand\("(?:codex|claude|kimi)"/
  );
  assert.match(agentSource, /state\.execution = "prime"/);
  assert.match(agentSource, /async function loadCustomHarnesses\(\)/);
  assert.match(agentSource, /api\(data\.harnessesApiUrl \|\| "\/api\/agent\/harnesses"\)/);
  assert.match(agentSource, /entry\.launchable \? "" : " disabled"/);
  assert.doesNotMatch(
    pagesSource,
    /id="harness-execution"|data-execution="local"|<strong>Local Run<\/strong>/
  );
  assert.match(runsSource, /throw new Error\(RETIRED_LOCAL_AGENT_MESSAGE\)/);
  assert.match(
    retiredLocalAgentSource,
    /async function main\(\) \{\s*throw new Error\(RETIRED_LOCAL_AGENT_MESSAGE\)/
  );
  assert.match(runsSource, /prime-harness-catalog\.json/);
  assert.match(runsSource, /catalog_fingerprint/);

  assert.match(
    runSource,
    /\["null", \{\s*adapter: "native",\s*runtimeHarnessId: "null"/
  );
  assert.match(
    runSource,
    /\["codex", \{\s*adapter: "native",\s*runtimeHarnessId: "codex"[\s\S]*disabled_tools: \["shell_tool"\]/
  );
  assert.match(runSource, /'type = "prime"'/);
  assert.doesNotMatch(runSource, /"--env\.taskset\.(?:tools\.colocated|python-tools)"/);
  assert.doesNotMatch(runSource, /"--env\.agent\.runtime\.type",\s*"subprocess"/);
  assert.match(runSource, /const taskset = "mazebench-tools"/);
  assert.doesNotMatch(runSource, /const taskset = .*"mazebench"/);
  assert.match(
    runSource,
    /\["--env\.taskset\.max-actions", "None", "--env\.agent\.max-turns", "None"\]/
  );
  assert.match(runSource, /runEvalWithProviderRetry/);
  assert.match(runSource, /eval-output-provider-failure/);
  assert.match(liveSource, /MAZEBENCH_EVENT_V1/);
  assert.match(liveSource, /_patch_prime_usage_schema/);
  assert.match(liveSource, /cache_write_tokens/);
  assert.match(liveSource, /"timestamp": action\.get\("timestamp"\) or _utc_timestamp\(\)/);
  assert.match(mazeTasksetSource, /"timestamp": timestamp or _utc_timestamp\(\)/);
  assert.match(mazeTasksetSource, /"timestamp": action\.get\("timestamp"\)/);

  assert.match(
    project,
    /verifiers @ git\+https:\/\/github\.com\/PrimeIntellect-ai\/verifiers\.git@b3b8f51ed470e3c46c12bb858ad18d257dc50c5e/
  );
  assert.match(retiredTasksetSource, /__all__ = \["MazeBenchAgentTaskset"\]/);
  assert.match(retiredTasksetSource, /raise RuntimeError\(UNSAFE_HARNESS_MESSAGE\)/);
  assert.match(retiredTasksetSource, /Use `mazebench-tools` from/);
  assert.doesNotMatch(
    retiredTasksetSource,
    /runtime\.tar\.gz|_runtime_archive|async def setup|async def finalize|class MazeBenchAgentTask\(/
  );
  assert.equal(
    fs.existsSync(
      path.join(root, "environments", "mazebench_agent", "mazebench_agent", "runtime.tar.gz")
    ),
    false
  );
  assert.equal(fs.existsSync(path.join(root, "scripts", "package-agent-runtime.py")), false);

  assert.match(toolsTasksetSource, /MAX_ACTION_LENGTH = 128/);
  assert.match(toolsTasksetSource, /MAX_ACTION_SEQUENCE_LENGTH = 1_000/);
  assert.match(
    toolsTasksetSource,
    /Field\(min_length=1, max_length=MAX_ACTION_LENGTH\)/
  );
  assert.match(
    toolsTasksetSource,
    /Field\(min_length=1, max_length=MAX_ACTION_SEQUENCE_LENGTH\)/
  );
  assert.match(toolsTasksetSource, /class MazeBenchToolTraceState\(MazeBenchState\)/);
  assert.match(toolsTasksetSource, /colocated: Literal\[False\] = False/);
  assert.match(toolsTasksetSource, /runtime: vf\.PrimeConfig/);
  assert.match(toolsTasksetSource, /region="us"/);
  assert.match(toolsTasksetSource, /class MazeBenchPrimeRuntime\(PrimeRuntime\)/);
  assert.match(toolsTasksetSource, /protocol="TCP"/);
  assert.match(toolsTasksetSource, /mcp_launch\._install_in_sandbox = _install_mazebench_in_sandbox/);
  assert.doesNotMatch(toolsTasksetSource, /DockerRuntime|game_runtime:/);
  assert.match(toolsTasksetSource, /url: None = None/);
  assert.match(toolsTasksetSource, /python_tools: Literal\[False\] = False/);
  assert.match(toolsTasksetSource, /class MazeBenchToolTask\(/);
  assert.match(toolsTasksetSource, /class MazeBenchToolTaskset\(/);
  assert.match(toolsTasksetSource, /NEEDS_CONTAINER = True/);
  assert.doesNotMatch(toolsTasksetSource, /_bind_game_only_harness/);
  assert.match(toolsTasksetSource, /"colocated": False/);
  assert.match(toolsTasksetSource, /__all__ = \["MazeBenchToolTaskset"\]/);

  assert.match(toolsTasksetSource, /CallToolResult/);
  assert.match(toolsTasksetSource, /ImageContent/);
  assert.doesNotMatch(toolsTasksetSource, /async def finalize\(self\)/);
  assert.equal(
    fs.existsSync(path.join(environmentDir, "mazebench_harnesses", "codex.py")),
    false
  );

  const launchableCatalogEntries = harnessCatalog.harnesses.filter(
    (harness) => harness.launchable
  );
  assert.deepEqual(
    launchableCatalogEntries.map((entry) => entry.id),
    ["codex", "null"]
  );
  const codexHarness = launchableCatalogEntries.find((entry) => entry.id === "codex");
  assert.deepEqual(codexHarness.default_config, {
    disabled_tools: ["shell_tool"],
    version: "0.144.5",
    multi_agent: false
  });
  assert.equal(codexHarness.adapter, "native");
  assert.equal(codexHarness.runtime_harness_id, "codex");
  assert.equal(codexHarness.boundary, "game-tools-only");
  assert.deepEqual(codexHarness.configurable, []);

  assert.equal(primeHarnessModelCompatible("openai/gpt-5.4", "null"), true);
  assert.equal(primeHarnessModelCompatible("anthropic/claude-sonnet-5", "default"), true);
  assert.equal(
    retryablePrimeProviderError(
      'ProviderError: upstream 404: {"error":{"message":"Requested resource not found."}}'
    ),
    true
  );
  assert.equal(retryablePrimeProviderError("ProviderError: upstream 429: rate limited"), true);
  assert.equal(retryablePrimeProviderError("ProviderError: upstream 503: unavailable"), true);
  assert.equal(
    retryablePrimeProviderError("ProviderError: upstream 400: unsupported parameter"),
    false
  );
  assert.equal(retryablePrimeProviderError("ordinary harness error"), false);

  const publicHarnesses = publicPrimeHarnesses();
  assert.deepEqual(
    publicHarnesses.filter((harness) => harness.launchable).map((harness) => harness.id),
    ["codex", "null"]
  );
  const gameAgent = publicHarnesses.find((harness) => harness.id === "null");
  assert.equal(gameAgent.label, "Game agent");
  assert.equal(gameAgent.adapter, "native");
  assert.equal(gameAgent.runtime_harness_id, "null");
  assert.equal(gameAgent.boundary, "game-tools-only");
  assert.deepEqual(gameAgent.configurable, []);
  assert.deepEqual(gameAgent.observation_modes, ["text", "json", "vision"]);
  assert.deepEqual(
    publicHarnesses.filter((harness) => !harness.launchable).map((harness) => harness.id),
    [
      "bash",
      "browser_use",
      "claude_code",
      "kimi_code",
      "mini_swe_agent",
      "pi",
      "pool",
      "rlm",
      "terminus_2"
    ]
  );
  assert.equal(
    publicHarnesses.every(
      (harness) =>
        harness.verifiers_revision === "b3b8f51ed470e3c46c12bb858ad18d257dc50c5e"
    ),
    true
  );
  assert.equal(
    publicHarnesses.every(
      (harness) => harness.catalog_fingerprint === harnessCatalog.catalog_fingerprint
    ),
    true
  );
  assert.deepEqual(normalizePrimeHarnessConfig({}, "default"), {});
  assert.deepEqual(normalizePrimeHarnessConfig({}, "codex"), {
    disabled_tools: ["shell_tool"],
    version: "0.144.5",
    multi_agent: false
  });
  assert.throws(
    () => normalizePrimeHarnessConfig({ version: "untrusted" }, "null"),
    /Unsupported Game agent configuration/
  );
  assert.deepEqual(
    primeSandboxIdsFromText(
      [
        "PrimeRuntime: sandbox azquf017rdi59jhwqoiu43z0 up",
        "pod sandbox-job-azquf017rdi59jhwqoiu43z0",
        "PrimeRuntime: sandbox bbcdef2345678901 up"
      ].join("\n")
    ),
    ["azquf017rdi59jhwqoiu43z0", "bbcdef2345678901"]
  );

  const sampleCatalog = {
    models: [
      { id: "openai/gpt-5-codex" },
      { id: "anthropic/claude-sonnet-5" },
      { id: "google/gemini-3.5-flash" }
    ]
  };
  assert.deepEqual(
    filterPrimeCatalogForHarness(sampleCatalog, "default").models.map((model) => model.id),
    ["openai/gpt-5-codex", "anthropic/claude-sonnet-5", "google/gemini-3.5-flash"]
  );
  assert.deepEqual(
    filterPrimeCatalogForHarness(sampleCatalog, "codex").models.map((model) => model.id),
    ["openai/gpt-5-codex", "anthropic/claude-sonnet-5", "google/gemini-3.5-flash"]
  );
  for (const modelId of [
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "openai/gpt-5.6-sol",
    "anthropic/claude-fable-5",
    "google/gemini-3.5-flash",
    "Qwen/Qwen3.5-0.8B"
  ]) {
    assert.deepEqual(primeReasoningLevels(modelId), ["low", "medium", "high"]);
  }

  const primeOnlyService = createAgentRunService({
    agentEnvironment: () => ({}),
    ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
    getGame: () => null,
    buildWorlds: { countWorldGems: () => 0 },
    loadJson: () => null,
    rootDir: runDir,
    worldMaps: {}
  });
  assert.throws(
    () => primeOnlyService.launchRuns({ kind: "local", model: "codex" }),
    /Local coding-agent launches are retired/
  );

  const parsedGameAgent = parseArgs([
    "--env-dir",
    environmentDir,
    "--out",
    runDir,
    "--harness",
    "default",
    "--model",
    "google/gemini-3.5-flash"
  ]);
  assert.equal(parsedGameAgent.harness, "null");
  assert.deepEqual(parsedGameAgent.harnessConfig, {});
  assert.equal(
    parseArgs(["--env-dir", environmentDir, "--out", runDir, "--harness", "none"]).harness,
    "null"
  );
  const relayArgs = agenticHarnessArgs(parsedGameAgent);
  assert.equal(relayArgs[0], "@");
  assert.equal(relayArgs[1], path.join(runDir, "prime-harness.toml"));
  const gameAgentConfig = fs.readFileSync(relayArgs[1], "utf8");
  assert.match(gameAgentConfig, /\[env\.agent\.harness\]\nid = "null"/);
  assert.match(gameAgentConfig, /\[env\.agent\.runtime\]\ntype = "prime"/);
  assert.equal(argumentValue(relayArgs, "--env.taskset.tools.colocated"), undefined);
  assert.equal(argumentValue(relayArgs, "--env.taskset.python-tools"), undefined);
  assert.equal(argumentValue(relayArgs, "--push"), "False");

  const parsedCodexAgent = parseArgs([
    "--env-dir",
    environmentDir,
    "--out",
    runDir,
    "--harness",
    "codex",
    "--model",
    "openai/gpt-oss-20b"
  ]);
  assert.deepEqual(parsedCodexAgent.harnessConfig, {
    disabled_tools: ["shell_tool"],
    version: "0.144.5",
    multi_agent: false
  });
  const codexArgs = agenticHarnessArgs(parsedCodexAgent);
  const codexConfig = fs.readFileSync(codexArgs[1], "utf8");
  assert.match(codexConfig, /id = "codex"/);
  assert.match(codexConfig, /disabled_tools = \["shell_tool"\]/);
  assert.match(codexConfig, /version = "0\.144\.5"/);
  assert.match(codexConfig, /multi_agent = false/);

  const parsedVisionAgent = parseArgs([
    "--env-dir",
    environmentDir,
    "--out",
    runDir,
    "--harness",
    "null",
    "--vision"
  ]);
  assert.equal(parsedVisionAgent.harness, "null");
  assert.equal(parsedVisionAgent.observationMode, "vision");
  assert.equal(parsedVisionAgent.vision, true);

  assert.throws(
    () =>
      parseArgs([
        "--env-dir",
        environmentDir,
        "--out",
        runDir,
        "--hosted"
      ]),
    /Hosted agent evaluations do not run the V1 harness and Toolset route/
  );
  assert.throws(
    () =>
      parseArgs([
        "--env-dir",
        environmentDir,
        "--out",
        runDir,
        "--harness",
        "null",
        "--tool-use",
        "offline"
      ]),
    /Agent computation tools are unavailable/
  );
  for (const harness of [
    "bash",
    "claude-code",
    "kimi-code",
    "mini-swe-agent",
    "pi",
    "rlm",
    "terminus-2"
  ]) {
    assert.throws(
      () =>
        parseArgs([
          "--env-dir",
          environmentDir,
          "--out",
          runDir,
          "--harness",
          harness
        ]),
      /not approved for MazeBench's game-tools-only agent boundary/
    );
  }
  assert.throws(
    () =>
      parseArgs([
        "--env-dir",
        environmentDir,
        "--out",
        runDir,
        "--harness",
        "unknown"
      ]),
    /Unknown Prime harness/
  );
  assert.throws(
    () => parseArgs(["--env-dir", root, "--out", runDir, "--harness", "null"]),
    /require the isolated MazeBench environment/
  );
  assert.throws(
    () =>
      parseArgs([
        "--env-dir",
        environmentDir,
        "--out",
        runDir,
        "--harness",
        "null",
        "--harness-config-json",
        JSON.stringify({ version: "untrusted" })
      ]),
    /Unsupported null harness configuration/
  );
  assert.throws(
    () =>
      parseArgs([
        "--env-dir",
        environmentDir,
        "--out",
        runDir,
        "--harness",
        "codex",
        "--harness-config-json",
        JSON.stringify({ disabled_tools: [] })
      ]),
    /Unsupported codex harness variant/
  );
  assert.throws(
    () =>
      agenticHarnessArgs({
        harness: "bash",
        harnessConfig: {},
        vision: false,
        toolUse: "read-only"
      }),
    /not approved for MazeBench's game-tools-only agent boundary/
  );

  const start = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts", "maze-play.js"),
      "start",
      "--repo-root",
      root,
      "--state",
      statePath,
      "--level",
      "level_HxI",
      "--game-won-gem-count",
      "69",
      "--max-actions",
      "1"
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  assert.equal(start.status, 0, start.stderr);
  const startStatus = JSON.parse(start.stdout);
  assert.equal(Object.prototype.hasOwnProperty.call(startStatus, "player"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(startStatus, "scorecard"), false);
  assert.match(startStatus.level, /P|p/);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).gameWonGemCount, 100);

  const action = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "maze-play.js"), "action", "--state", statePath, "up"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  assert.equal(action.status, 0, action.stderr);
  const marker = action.stdout.match(/MAZEBENCH_EVENT_V1:([A-Za-z0-9_-]+)/);
  assert(marker, "provider-neutral helper must emit a live telemetry marker");
  const event = JSON.parse(Buffer.from(marker[1], "base64url").toString("utf8"));
  assert.equal(event.turn, 1);
  assert.equal(event.command_text, "up");
  assert.equal(event.valid, true);
  assert.equal(Object.prototype.hasOwnProperty.call(event.status, "player"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(event.status, "scorecard"), false);
  assert.equal(fs.existsSync(path.join(runDir, "current-render-state.json")), false);
  const traced = agenticConversationTurns({
    nodes: [
      { message: { role: "assistant", content: "", reasoning_content: "reasoned move" } },
      { message: { role: "tool", content: `status\n${marker[0]}`, tool_call_id: "shell-1" } }
    ]
  });
  assert.equal(traced.length, 1);
  assert.equal(traced[0].reasoning, "reasoned move");
  assert.equal(traced[0].action, "up");

  const artifactTrace = path.join(runDir, "artifact-traces.jsonl");
  fs.writeFileSync(
    artifactTrace,
    `${JSON.stringify({
      traces: [{
        nodes: [
          { message: { role: "assistant", content: "", reasoning_content: "reasoned move" } },
          { message: { role: "tool", content: `status\n${marker[0]}`, tool_call_id: "shell-1" } }
        ],
        info: {
          maze_actions: [
            {
              turn: 1,
              command_text: "up",
              valid: true,
              error: null,
              status: { current_room: "level_HxI", gem_count: 0, moved: true }
            }
          ]
        }
      }]
    })}\n`
  );
  assert.equal(writeMoveArtifacts(artifactTrace, runDir), 1);
  const actionArtifact = JSON.parse(
    fs.readFileSync(path.join(runDir, "actions.jsonl"), "utf8")
  );
  assert.equal(actionArtifact.command_text, "up");
  assert.equal(actionArtifact.status.level, event.status.level);
  const reasoningArtifact = JSON.parse(
    fs.readFileSync(path.join(runDir, "reasoning.json"), "utf8")
  );
  assert.equal(reasoningArtifact[0].reasoning, "reasoned move");

  const overBudget = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "maze-play.js"), "action", "--state", statePath, "right"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  assert.notEqual(overBudget.status, 0);
  assert.match(overBudget.stderr, /action budget exhausted \(1\/1\)/i);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).actions.length, 1);

  const traceDir = path.join(runDir, "eval-output", "current-v1");
  fs.mkdirSync(traceDir, { recursive: true });
  const tracesPath = path.join(traceDir, "traces.jsonl");
  fs.writeFileSync(tracesPath, `${JSON.stringify({ nodes: [], info: {} })}\n`);
  assert.equal(findPrimeResultsFile(runDir), tracesPath);
} finally {
  fs.rmSync(runDir, { recursive: true, force: true });
}

console.log("prime harness tests passed");
