const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SUPPORTED_LOCAL_AGENT_VERSIONS,
  SUPPORTED_LOCAL_CLAUDE_VERSION,
  SUPPORTED_LOCAL_CODEX_VERSION,
  SUPPORTED_LOCAL_KIMI_VERSION,
  agentCommand,
  assertLocalClaudeCommandIsolation,
  assertLocalCodexCommandIsolation,
  assertLocalKimiCommandIsolation,
  buildMcpPrompt,
  claudeSandboxSettings,
  codexMcpConfigArgs,
  distillClaudeEvents,
  distillCodexEvents,
  distillKimiEvents,
  hasResumableGameSession,
  kimiAgentProfile,
  kimiMcpConfig,
  migrateSeedSessionObservation,
  needsPrivateMcpServer,
  sanitizeKimiConfig
} = require("../scripts/maze-agent-local");

const root = path.resolve(__dirname, "..");
const localAgentSource = fs.readFileSync(path.join(root, "scripts", "maze-agent-local.js"), "utf8");
const agentRunsSource = fs.readFileSync(path.join(root, "server", "agent-runs.js"), "utf8");
const localAgentDockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const workspace = path.join(os.tmpdir(), "game-only-agent-test");
const baseConfig = {
  agentSwarmWorkspaceDir: path.join(workspace, "swarm-workspaces"),
  agentWorkspaceDir: workspace,
  agentCodexRuntimeDir: path.join(workspace, "codex-runtime"),
  allowQuit: false,
  claudeBin: "claude",
  codexBin: "codex",
  kimiBin: "kimi",
  kimiRuntimeDir: path.join(workspace, "kimi-home"),
  kimiSkillsDir: path.join(workspace, "kimi-home", "empty-skills"),
  agentKimiRuntimeDir: path.join(workspace, "kimi-home"),
  agentKimiSkillsDir: path.join(workspace, "kimi-home", "empty-skills"),
  codexFast: false,
  gameId: "maze",
  gems: 100,
  hideNames: true,
  hostAccess: false,
  inContainer: false,
  levelId: "level_HxI",
  maxSwarmWorkers: 8,
  mcpEnabled: true,
  mcpUrl: "http://127.0.0.1:1234/private",
  mode: "text",
  modelName: "gpt-test",
  moves: 2,
  omniscient: false,
  outDir: workspace,
  codexRuntimeDir: path.join(workspace, "codex-runtime"),
  pythonBin: "",
  pythonSandboxStateDir: path.join(workspace, "python-sandbox"),
  reasoning: "low",
  autoRunTools: false,
  autoRunAllFrames: false,
  resume: "",
  seed: false,
  sessionFile: path.join(workspace, "session.json"),
  swarm: false,
  swarmDir: path.join(workspace, "swarm"),
  swarmWorkspaceDir: path.join(workspace, "swarm-workspaces"),
  toolUse: "read-only",
  unlimited: false,
  view: "top-diagonal",
  visionHeight: 512,
  visionView: "",
  visionWidth: 512,
  workspaceDir: workspace,
  yaw: 0
};

assert.match(localAgentSource, /const resuming = \$\{JSON\.stringify\(Boolean\(config\.resume\)\)\}/);
assert.match(localAgentSource, /workspace_state_valid: resuming \|\| workspaceEntries\.length === 0/);
assert.match(localAgentSource, /name !== "workspace_empty" && value !== true/);

for (const mode of ["text", "json", "vision"]) {
  const config = {
    ...baseConfig,
    mode,
    hideNames: mode !== "vision",
    omniscient: mode === "json"
  };
  const prompt = buildMcpPrompt(config);
  assert.doesNotMatch(prompt, /MazeBench/i, `${mode} game-only prompt must not reveal the benchmark name`);
  assert.doesNotMatch(prompt, /ice_slope|puncher|player_lift|orange_wall/i);
  assert.match(prompt, /game_start/);
  assert.match(prompt, /TOOLS-OFF mode/);
  assert.match(prompt, /Do not search the web/);
  assert.match(prompt, /do not read any\s+files/);
  assert.match(prompt, /do not spawn any sub-agents/);
  assert.doesNotMatch(prompt, /(?:game|maze)_scorecard/);
  assert.match(prompt, /do not report whether a movement was\s+blocked/i);
  if (mode === "text") {
    assert.match(prompt, /current room's ASCII[\s\S]*complete visited_levels list/);
    assert.doesNotMatch(prompt, /ASCII board in the level\s+field plus the current status/);
  }
  if (mode !== "json") assert.doesNotMatch(prompt, /player position|x\/y\/elevation/i);
}

{
  const retryDir = fs.mkdtempSync(path.join(os.tmpdir(), "maze-cold-start-retry-"));
  const missingSessionFile = path.join(retryDir, "session.json");
  const coldRetryPrompt = buildMcpPrompt({
    ...baseConfig,
    outDir: retryDir,
    resume: "provider-thread-without-game",
    seed: true,
    sessionFile: missingSessionFile
  });
  assert.equal(hasResumableGameSession(missingSessionFile), false);
  assert.match(coldRetryPrompt, /COLD-START RECOVERY/);
  assert.match(coldRetryPrompt, /no primary game was ever created/);
  assert.match(coldRetryPrompt, /Call game_start exactly once as your first game-control call/);
  assert.doesNotMatch(coldRetryPrompt, /Call game_observe first/);
  assert.doesNotMatch(coldRetryPrompt, /MORE primary game actions/);

  fs.writeFileSync(
    missingSessionFile,
    `${JSON.stringify({ initial: { level: "P" }, lastStatus: { level: "P" }, actions: [] })}\n`
  );
  const warmRetryPrompt = buildMcpPrompt({
    ...baseConfig,
    outDir: retryDir,
    resume: "provider-thread-with-game",
    seed: false,
    sessionFile: missingSessionFile
  });
  assert.equal(hasResumableGameSession(missingSessionFile), true);
  assert.match(warmRetryPrompt, /Call game_observe first/);
  assert.match(warmRetryPrompt, /do not call game_start/);
  assert.match(warmRetryPrompt, /MORE primary game actions/);
  assert.doesNotMatch(warmRetryPrompt, /COLD-START RECOVERY/);
  fs.rmSync(retryDir, { recursive: true, force: true });
}

const toolsOnConfig = {
  ...baseConfig,
  hostAccess: true,
  model: "codex",
  swarm: false,
  toolUse: "offline",
  tools: true
};
const toolsOnPrompt = buildMcpPrompt(toolsOnConfig);
assert.match(toolsOnPrompt, /TOOLS mode/);
assert.match(toolsOnPrompt, /python_exec/);
assert.match(toolsOnPrompt, /relative \.py script_path chosen by you/);
assert.match(toolsOnPrompt, /create, reuse, modify, and organize as many relative-path \.py/);
assert.match(toolsOnPrompt, /Python is optional; decide naturally/);
assert.doesNotMatch(toolsOnPrompt, /planner\.py|solver\.py|reuse the same path|disposable inline-only/);
assert.match(toolsOnPrompt, /observations\/current\.json/);
assert.match(toolsOnPrompt, /PYTHON WORKSPACE OBSERVATION BRIDGE/);
assert.match(toolsOnPrompt, /cannot read MazeBench source, repositories/);
assert.match(toolsOnPrompt, /Shell, file-browser,\s+editor, web, app, and connector tools are disabled/);
assert.doesNotMatch(toolsOnPrompt, /tool availability is not guaranteed/);
assert.doesNotMatch(toolsOnPrompt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.doesNotMatch(toolsOnPrompt, /TOOLS-OFF mode/);
assert.doesNotMatch(toolsOnPrompt, /maze_scorecard/);
assert.doesNotMatch(toolsOnPrompt, /AUTO-RUN TOOLS HARNESS IS ENABLED/);
assert.match(localAgentSource, /const autoRunTools = toolUse === "offline" && isTruthy\(raw\.auto_run_tools, true\)/);
assert.match(agentRunsSource, /const autoRunTools = toolUse === "offline" &&\s+!\(params\.auto_run_tools === false \|\| params\.auto_run_tools === "false"\)/);
assert.match(localAgentSource, /const autoRunAllFrames = autoRunTools && isTruthy\(raw\.auto_run_all_frames, false\)/);

const jsonToolsPrompt = buildMcpPrompt({
  ...toolsOnConfig,
  mode: "json",
  hideNames: false,
  omniscient: true,
  autoRunTools: true,
  autoRunAllFrames: true
});
assert.match(jsonToolsPrompt, /PYTHON WORKSPACE OBSERVATION BRIDGE/);
assert.match(jsonToolsPrompt, /observations\/current\.json/);
assert.match(jsonToolsPrompt, /observations\/history\.jsonl/);
assert.match(jsonToolsPrompt, /json\.loads\(Path\("observations\/current\.json"\)\.read_text\(\)\)/);
assert.doesNotMatch(jsonToolsPrompt, /reusable planner|Revise and rerun|throwaway Python/);
assert.match(jsonToolsPrompt, /observation_revision/);
assert.match(jsonToolsPrompt, /route file submitted to\s+maze_action_sequence/);
assert.match(jsonToolsPrompt, /observation is omniscient/);

const autoRunToolsPrompt = buildMcpPrompt({
  ...toolsOnConfig,
  autoRunTools: true
});
assert.match(autoRunToolsPrompt, /AUTO-RUN TOOLS HARNESS IS ENABLED/);
assert.match(autoRunToolsPrompt, /maze_action_sequence/);
assert.match(autoRunToolsPrompt, /ordered action list you intend to\s+apply/);
assert.match(autoRunToolsPrompt, /intend to apply two or more moves[\s\S]*route/);
assert.match(autoRunToolsPrompt, /single call may contain the full route/);
assert.doesNotMatch(autoRunToolsPrompt, /saved Python|planner or solver|solver's prediction/);
assert.match(autoRunToolsPrompt, /final full\s+observation/);
assert.match(autoRunToolsPrompt, /include_intermediate_observations=true/);
assert.match(autoRunToolsPrompt, /every intermediate ASCII board, JSON observation, or vision frame/);
assert.match(autoRunToolsPrompt, /stops immediately on a terminal state, death, pause, exhausted\s+move budget/);
assert.match(autoRunToolsPrompt, /Never create a Python helper that calls a live game API/);
assert.doesNotMatch(autoRunToolsPrompt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

const autoRunAllFramesPrompt = buildMcpPrompt({
  ...toolsOnConfig,
  autoRunTools: true,
  autoRunAllFrames: true
});
assert.match(autoRunAllFramesPrompt, /Every sequence automatically returns every intermediate ASCII board/);
assert.match(autoRunAllFramesPrompt, /Inspect\s+the full ordered trajectory/);
assert.doesNotMatch(autoRunAllFramesPrompt, /By default it returns compact per-action summaries plus only the final/);

const swarmPrompt = buildMcpPrompt({ ...toolsOnConfig, swarm: true });
assert.match(swarmPrompt, /SWARM IS ENABLED/);
assert.match(swarmPrompt, /spawn at most\s+8 workers/i);
assert.match(swarmPrompt, /exactly one private maze instance/i);
assert.match(swarmPrompt, /delegation is optional/);
assert.doesNotMatch(swarmPrompt, /Spawn at least one worker/);
assert.doesNotMatch(swarmPrompt, /maze_clone|clone_id/i);

assert.deepEqual(
  codexMcpConfigArgs(toolsOnConfig).filter((value) => value.includes("enabled_tools")),
  ['mcp_servers.mazebench.enabled_tools=["maze_start","maze_observe","maze_action","python_exec"]']
);
assert.deepEqual(
  codexMcpConfigArgs({ ...toolsOnConfig, swarm: true }).filter((value) => value.includes("enabled_tools")),
  ['mcp_servers.mazebench.enabled_tools=["maze_start","maze_observe","maze_action","maze_workers","python_exec"]']
);
assert.deepEqual(
  codexMcpConfigArgs({ ...toolsOnConfig, autoRunTools: true }).filter((value) => value.includes("enabled_tools")),
  ['mcp_servers.mazebench.enabled_tools=["maze_start","maze_observe","maze_action","maze_action_sequence","python_exec"]']
);

const codexConfig = { ...baseConfig, model: "codex" };
const codex = agentCommand(codexConfig, buildMcpPrompt(codexConfig));
const codexArgs = codex.argv.join("\n");
assert.match(codexArgs, /mcp_servers\.game/);
assert.doesNotMatch(codexArgs, /mcp_servers\.mazebench/);
assert.match(codexArgs, /skills\.include_instructions=false/);
assert.match(codexArgs, /skills\.bundled\.enabled=false/);
assert.match(codexArgs, /web_search="disabled"/);
assert.match(codexArgs, /hooks\.PreToolUse/);
for (const feature of [
  "apps", "plugins", "plugin_sharing", "memories", "multi_agent", "tool_search",
  "shell_tool", "unified_exec", "computer_use"
]) {
  const index = codex.argv.indexOf(feature);
  assert(index > 0 && codex.argv[index - 1] === "--disable", `${feature} must be disabled`);
}
assert.match(codexArgs, /default_permissions="mazebench_agent"/);
assert.match(codexArgs, /permissions\.mazebench_agent\.network\.enabled=false/);
assert.match(codexArgs, new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*deny`));
assert.equal(codex.argv.includes("--sandbox"), false, "permission profiles must not be mixed with legacy sandbox mode");
assert.equal(codex.argv.includes("--add-dir"), false, "the repository must never be added to the agent workspace");
assert.doesNotMatch(codexArgs, /sandbox_mode|sandbox_workspace_write/);
assert.deepEqual(
  codexMcpConfigArgs(codexConfig).filter((value) => value.includes("enabled_tools")),
  ['mcp_servers.game.enabled_tools=["game_start","game_observe","game_action"]']
);
assert(codex.argv.includes('model_reasoning_summary="detailed"'));

const isolatedCodexConfig = {
  ...codexConfig,
  agentCodexRuntimeDir: "/run/mazebench-codex-runtime",
  agentWorkspaceDir: "/app/workspace",
  codexRuntimeDir: "/run/mazebench-output/.codex-runtime",
  inContainer: true,
  outDir: "/run/mazebench-output",
  swarmWorkspaceDir: "/run/mazebench-workspace/swarm-workspaces",
  tools: false,
  workspaceDir: "/run/mazebench-workspace/workspace"
};
const isolatedCodex = agentCommand(isolatedCodexConfig, buildMcpPrompt(isolatedCodexConfig));
assert.equal(assertLocalCodexCommandIsolation(isolatedCodexConfig, isolatedCodex), true);
const isolatedPrimeCodexConfig = {
  ...isolatedCodexConfig,
  inference: "prime",
  modelName: "openai/gpt-5.6-luna",
  primeInferenceUrl: "https://api.pinference.ai/api/v1"
};
const isolatedPrimeCodex = agentCommand(
  isolatedPrimeCodexConfig,
  buildMcpPrompt(isolatedPrimeCodexConfig)
);
assert.equal(assertLocalCodexCommandIsolation(isolatedPrimeCodexConfig, isolatedPrimeCodex), true);
assert.match(isolatedPrimeCodex.argv.join("\n"), /model_provider="prime_intellect"/);
assert.match(isolatedPrimeCodex.argv.join("\n"), /wire_api="responses"/);
assert.match(isolatedPrimeCodex.argv.join("\n"), /prime-auth\.js/);
assert.doesNotMatch(isolatedPrimeCodex.argv.join("\n"), /env_key|experimental_bearer_token/);
assert.throws(
  () => assertLocalCodexCommandIsolation(isolatedPrimeCodexConfig, {
    ...isolatedPrimeCodex,
    argv: [...isolatedPrimeCodex.argv, "-c", 'model_providers.prime_intellect.env_key="PRIME_API_KEY"']
  }),
  /credentials/i
);
const isolatedCodexToolsConfig = {
  ...isolatedCodexConfig,
  agentSwarmWorkspaceDir: "/app/swarm-workspaces",
  toolUse: "offline",
  tools: true
};
const isolatedCodexTools = agentCommand(isolatedCodexToolsConfig, buildMcpPrompt(isolatedCodexToolsConfig));
assert.equal(assertLocalCodexCommandIsolation(isolatedCodexToolsConfig, isolatedCodexTools), true);
assert.match(isolatedCodexTools.argv.join("\n"), /mcp_servers\.mazebench\.enabled_tools=.*python_exec/);
assert.match(isolatedCodexTools.argv.join("\n"), /"\/app\/workspace"="write"/);
for (const unsafeCommand of [
  { ...isolatedCodex, argv: [...isolatedCodex.argv, "--enable", "unified_exec"] },
  { ...isolatedCodex, argv: [...isolatedCodex.argv, "--add-dir", "/app"] },
  { ...isolatedCodex, argv: [...isolatedCodex.argv, "-c", "permissions.mazebench_agent.network.enabled=true"] },
  {
    ...isolatedCodex,
    argv: isolatedCodex.argv.map((value) => value === 'mcp_servers.game.enabled_tools=["game_start","game_observe","game_action"]'
      ? 'mcp_servers.game.enabled_tools=["game_start","game_observe","game_action","exec"]'
      : value)
  }
]) {
  assert.throws(
    () => assertLocalCodexCommandIsolation(isolatedCodexConfig, unsafeCommand),
    /isolation|missing|non-game|widen/i
  );
}
assert.equal(SUPPORTED_LOCAL_CODEX_VERSION, "0.146.0");
assert.equal(SUPPORTED_LOCAL_CLAUDE_VERSION, "2.1.220");
assert.equal(SUPPORTED_LOCAL_KIMI_VERSION, "0.29.1");
assert.deepEqual(SUPPORTED_LOCAL_AGENT_VERSIONS, {
  codex: "0.146.0",
  claude: "2.1.220",
  kimi: "0.29.1"
});
assert.match(localAgentDockerfile, /FROM mcr\.microsoft\.com\/playwright:v1\.60\.0-noble/);
for (const packagePattern of [
  /"@openai\/codex@\$\{CODEX_VERSION\}"/,
  /"@anthropic-ai\/claude-code@\$\{CLAUDE_CODE_VERSION\}"/,
  /"@moonshot-ai\/kimi-code@\$\{KIMI_CODE_VERSION\}"/
]) {
  assert.match(localAgentDockerfile, packagePattern);
}
for (const label of ["local-codex", "local-claude", "local-kimi"]) {
  assert.match(localAgentDockerfile, new RegExp(`org\\.mazebench\\.${label}\\.version`));
}
for (const boundary of [
  /"--read-only"/,
  /"--tmpfs", config\.outDir/,
  /credentialSources\.map\(\(source\) => path\.dirname\(source\)\)/,
  /"--tmpfs", path\.dirname\(config\.workspaceDir\)/,
  /"--bind", config\.workspaceDir, config\.agentWorkspaceDir/,
  /"--ro-bind", authFile, "\/home\/pwuser\/\.codex\/auth\.json"/,
  /"--ro-bind", authFile, "\/home\/pwuser\/\.claude\/\.credentials\.json"/,
  /"--setenv", "KIMI_CODE_HOME", "\/home\/pwuser\/\.kimi-code"/,
  /"--bounding-set=-all"/,
  /"--inh-caps=-all"/,
  /"--ambient-caps=-all"/,
  /capabilities_dropped/,
  /no_new_privileges/
]) {
  assert.match(localAgentSource, boundary);
}
assert.doesNotMatch(localAgentSource, /Host access|switch to Host access/);

const codexSparkConfig = {
  ...codexConfig,
  modelName: "gpt-5.3-codex-spark",
  reasoning: "xhigh"
};
const codexSpark = agentCommand(codexSparkConfig, buildMcpPrompt(codexSparkConfig));
assert.equal(
  codexSpark.argv.some((value) => value.includes("model_reasoning_summary")),
  false,
  "Codex Spark rejects reasoning.summary"
);
assert(codexSpark.argv.includes('model_reasoning_effort="xhigh"'));

const claudeConfig = { ...baseConfig, model: "claude", modelName: "claude-test" };
const claude = agentCommand(claudeConfig, buildMcpPrompt(claudeConfig));
const valueAfter = (flag) => claude.argv[claude.argv.indexOf(flag) + 1];
assert.equal(valueAfter("--tools"), "default", "Claude needs its default registry enabled to discover MCP tools");
assert.equal(claude.argv.includes("--setting-sources"), false, "overriding setting sources races Claude MCP startup");
assert.equal(claude.argv.includes("--system-prompt"), false, "replacing Claude's base prompt races MCP startup");
assert.equal(valueAfter("--append-system-prompt").includes("only the explicitly configured game controls"), true);
assert.deepEqual(
  new Set(valueAfter("--allowedTools").split(",")),
  new Set([
    "mcp__game__game_start",
    "mcp__game__game_observe",
    "mcp__game__game_action"
  ])
);
for (const denied of [
  "Bash", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent", "ToolSearch",
  "CronCreate", "DesignSync", "EnterWorktree", "Monitor", "PushNotification", "RemoteTrigger",
  "ReportFindings", "ScheduleWakeup", "SendMessage", "TaskCreate", "TaskUpdate", "Workflow"
]) {
  assert(valueAfter("--disallowedTools").split(",").includes(denied), `${denied} must be denied`);
}
const claudeSettings = JSON.parse(claudeSandboxSettings(claudeConfig));
assert.deepEqual(claudeSettings.sandbox.network.allowedDomains, []);
assert.equal(claudeSettings.sandbox.failIfUnavailable, true);
assert.deepEqual(claudeSettings.sandbox.filesystem.allowWrite, []);
assert.deepEqual(
  new Set(claudeSettings.permissions.allow),
  new Set([
    "mcp__game__game_start",
    "mcp__game__game_observe",
    "mcp__game__game_action"
  ])
);
assert.equal(needsPrivateMcpServer(claudeConfig), true, "host Claude runs need a prestarted MCP service");
assert.equal(needsPrivateMcpServer({ ...baseConfig, model: "kimi" }), true, "host Kimi runs need a private MCP service");
assert.equal(needsPrivateMcpServer(codexConfig), false, "host Codex can use its synchronous stdio MCP startup");
assert.equal(needsPrivateMcpServer({ ...codexConfig, inContainer: true }), true);

const isolatedClaudeConfig = {
  ...claudeConfig,
  agentWorkspaceDir: "/app/workspace",
  inContainer: true,
  outDir: "/run/mazebench-output",
  workspaceDir: "/run/mazebench-workspace/workspace"
};
const isolatedClaude = agentCommand(isolatedClaudeConfig, buildMcpPrompt(isolatedClaudeConfig));
assert.equal(assertLocalClaudeCommandIsolation(isolatedClaudeConfig, isolatedClaude), true);
const isolatedClaudeToolsConfig = { ...isolatedClaudeConfig, toolUse: "offline", tools: true };
const isolatedClaudeTools = agentCommand(isolatedClaudeToolsConfig, buildMcpPrompt(isolatedClaudeToolsConfig));
assert.equal(assertLocalClaudeCommandIsolation(isolatedClaudeToolsConfig, isolatedClaudeTools), true);
assert(
  isolatedClaudeTools.argv[isolatedClaudeTools.argv.indexOf("--allowedTools") + 1]
    .split(",")
    .includes("mcp__mazebench__python_exec")
);
assert.equal(JSON.parse(claudeSandboxSettings(isolatedClaudeToolsConfig)).sandbox.autoAllowBashIfSandboxed, false);
for (const flag of ["--no-chrome", "--disable-slash-commands", "--strict-mcp-config"]) {
  assert(isolatedClaude.argv.includes(flag), `${flag} must be enabled for isolated Claude Code`);
}
assert.equal(isolatedClaude.argv[isolatedClaude.argv.indexOf("--prompt-suggestions") + 1], "false");
assert.throws(
  () => assertLocalClaudeCommandIsolation(isolatedClaudeConfig, {
    ...isolatedClaude,
    argv: [...isolatedClaude.argv, "--add-dir", "/app"]
  }),
  /widen/i
);

const claudeToolsOn = agentCommand(
  { ...toolsOnConfig, model: "claude", modelName: "claude-test" },
  toolsOnPrompt
);
const claudeToolsOnAllowed = new Set(
  claudeToolsOn.argv[claudeToolsOn.argv.indexOf("--allowedTools") + 1].split(",")
);
assert.deepEqual(claudeToolsOnAllowed, new Set([
  "mcp__mazebench__maze_start",
  "mcp__mazebench__maze_observe",
  "mcp__mazebench__maze_action",
  "mcp__mazebench__python_exec"
]));
const claudeAutoRunConfig = {
  ...toolsOnConfig,
  model: "claude",
  modelName: "claude-test",
  autoRunTools: true
};
const claudeAutoRun = agentCommand(claudeAutoRunConfig, autoRunToolsPrompt);
const claudeAutoRunAllowed = new Set(
  claudeAutoRun.argv[claudeAutoRun.argv.indexOf("--allowedTools") + 1].split(",")
);
assert(claudeAutoRunAllowed.has("mcp__mazebench__maze_action_sequence"));
assert(
  JSON.parse(claudeSandboxSettings(claudeAutoRunConfig)).permissions.allow.includes(
    "mcp__mazebench__maze_action_sequence"
  )
);
for (const builtin of ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"]) {
  assert(
    claudeToolsOn.argv[claudeToolsOn.argv.indexOf("--disallowedTools") + 1].split(",").includes(builtin),
    `${builtin} must remain unavailable in tools mode`
  );
}
assert.equal(claudeToolsOn.argv.includes("--add-dir"), false);

const kimiConfig = { ...baseConfig, model: "kimi", modelName: "kimi/k3", reasoning: "high" };
assert.match(localAgentSource, /SUPPORTED_KIMI_CODE_VERSIONS = new Set\(\[SUPPORTED_LOCAL_KIMI_VERSION\]\)/);
assert.match(localAgentSource, /SUPPORTED_LOCAL_AGENT_VERSIONS\[model\]/);
const kimiPrompt = buildMcpPrompt(kimiConfig);
assert.match(kimiPrompt, /after five consecutive game_action[\s\S]*same normalized action/i);
assert.match(kimiPrompt, /A different action resets the repetition[\s\S]*game_observe resets the[\s\S]*count/i);
const kimiAutoRunPrompt = buildMcpPrompt({ ...kimiConfig, toolUse: "offline", tools: true, autoRunTools: true });
assert.match(kimiAutoRunPrompt, /AUTO-RUN TOOLS HARNESS IS ENABLED/);
assert.match(kimiAutoRunPrompt, /after five consecutive maze_action[\s\S]*maze_observe resets the[\s\S]*count/i);
const kimi = agentCommand(kimiConfig, kimiPrompt);
assert.equal(kimi.bin, "kimi");
assert.equal(kimi.argv[kimi.argv.indexOf("--model") + 1], "kimi/k3");
assert.equal(kimi.argv[kimi.argv.indexOf("--output-format") + 1], "stream-json");
assert.equal(kimi.argv[kimi.argv.indexOf("--skills-dir") + 1], kimiConfig.agentKimiSkillsDir);
assert.equal(kimi.argv.includes("--yolo"), false);
assert.equal(kimi.argv.includes("--auto"), false);
assert.equal(kimi.argv.includes("--add-dir"), false);
assert.equal(kimi.env.KIMI_CODE_HOME, kimiConfig.agentKimiRuntimeDir);
assert.equal(kimi.env.KIMI_DISABLE_TELEMETRY, "1");
assert.equal(kimi.env.KIMI_CODE_NO_AUTO_UPDATE, "1");
assert.equal(kimi.env.KIMI_DISABLE_CRON, "1");
assert.equal(kimi.env.KIMI_CODE_EXPERIMENTAL_FLAG, "1");
assert.equal(kimi.env.KIMI_MODEL_THINKING_EFFORT, "high");
const restrictedKimiProfile = kimiAgentProfile(kimiConfig);
assert.match(restrictedKimiProfile, /subagents: \[\]/);
for (const tool of [
  "mcp__game__game_start",
  "mcp__game__game_observe",
  "mcp__game__game_action"
]) {
  assert.match(restrictedKimiProfile, new RegExp(`  - ${tool}`));
}
assert.doesNotMatch(restrictedKimiProfile, /mcp__mazebench__python_exec/);

const isolatedKimiConfig = {
  ...kimiConfig,
  agentKimiProfile: "/home/pwuser/.kimi-code/mazebench-agent.md",
  agentKimiRuntimeDir: "/home/pwuser/.kimi-code",
  agentKimiSkillsDir: "/home/pwuser/.kimi-code/empty-skills",
  agentWorkspaceDir: "/app/workspace",
  inContainer: true,
  outDir: "/run/mazebench-output",
  workspaceDir: "/run/mazebench-workspace/workspace"
};
const isolatedKimi = agentCommand(isolatedKimiConfig, buildMcpPrompt(isolatedKimiConfig));
assert.equal(assertLocalKimiCommandIsolation(isolatedKimiConfig, isolatedKimi), true);
const isolatedKimiToolsConfig = { ...isolatedKimiConfig, toolUse: "offline", tools: true };
const isolatedKimiTools = agentCommand(isolatedKimiToolsConfig, buildMcpPrompt(isolatedKimiToolsConfig));
assert.equal(assertLocalKimiCommandIsolation(isolatedKimiToolsConfig, isolatedKimiTools), true);
assert.match(kimiAgentProfile(isolatedKimiToolsConfig), /mcp__mazebench__python_exec/);
assert.throws(
  () => assertLocalKimiCommandIsolation(isolatedKimiConfig, {
    ...isolatedKimi,
    argv: [...isolatedKimi.argv, "--yolo"]
  }),
  /unreviewed option/i
);

const unsafeKimiConfig = `
default_model = "kimi/k3"
default_permission_mode = "yolo"
telemetry = true

[providers.kimi]
type = "kimi"
api_key = "test-secret"
base_url = "https://api.kimi.invalid"

[models."kimi/k3"]
provider = "kimi"
model = "k3"
max_context_size = 1000
capabilities = ["thinking", "tool_use"]

[services.moonshot_search]
base_url = "https://search.invalid"

[[permission.rules]]
decision = "allow"
pattern = "Read"

[[hooks]]
event = "PreToolUse"
command = "unsafe-hook"
`;
const safeKimiConfig = sanitizeKimiConfig(unsafeKimiConfig, kimiConfig);
assert.match(safeKimiConfig, /api_key = "test-secret"/, "the private runtime must retain provider authentication");
assert.match(safeKimiConfig, /default_permission_mode = "auto"/);
assert.match(safeKimiConfig, /merge_all_available_skills = false/);
assert.match(safeKimiConfig, /telemetry = false/);
assert.doesNotMatch(safeKimiConfig, /search\.invalid|unsafe-hook/);
assert.doesNotMatch(safeKimiConfig, /decision = "allow"\s+pattern = "Read"/);
for (const tool of [
  "mcp__game__game_start",
  "mcp__game__game_observe",
  "mcp__game__game_action"
]) {
  assert.match(safeKimiConfig, new RegExp(`decision = "allow"\\s+pattern = "${tool}"`));
}
for (const builtin of [
  "Bash", "Read", "Write", "Grep", "Glob", "WebSearch", "FetchURL", "Agent", "Skill",
  "CreateGoal", "GetGoal", "SetGoalBudget", "UpdateGoal"
]) {
  assert.match(safeKimiConfig, new RegExp(`decision = "deny"\\s+pattern = "${builtin}"`));
}
assert.doesNotMatch(safeKimiConfig, /pattern = "\*\*"/);

const kimiOfflineMcp = JSON.parse(kimiMcpConfig({ ...toolsOnConfig, model: "kimi" }));
assert.deepEqual(
  kimiOfflineMcp.mcpServers.mazebench.enabledTools,
  ["maze_start", "maze_observe", "maze_action", "python_exec"]
);
const kimiAutoRunMcp = JSON.parse(kimiMcpConfig({ ...toolsOnConfig, model: "kimi", autoRunTools: true }));
assert.deepEqual(
  kimiAutoRunMcp.mcpServers.mazebench.enabledTools,
  ["maze_start", "maze_observe", "maze_action", "maze_action_sequence", "python_exec"]
);
assert.deepEqual(Object.keys(kimiOfflineMcp.mcpServers), ["mazebench"]);

const kimiEvents = [
  { role: "assistant", content: "Move right.", tool_calls: [{ id: "call-1", type: "function", function: { name: "mcp__game__game_action", arguments: JSON.stringify({ action: "right" }) } }] },
  { role: "tool", tool_call_id: "call-1", content: JSON.stringify({ moved: true, gem_count: 1, current_room: "HxI" }) },
  { role: "assistant", content: "Done." },
  { role: "meta", type: "session.resume_hint", session_id: "session-test" }
].map(JSON.stringify).join("\n");
assert.deepEqual(distillKimiEvents(kimiEvents).entries, [{
  move: 1,
  action: "right",
  reasoning: "Move right.",
  timestamp: null,
  moved: true,
  gems: 1,
  room: "HxI",
  room_changed: false,
  player_dead: false
}]);
const savedRouteSequenceResult = {
    requested_count: 3,
    completed_count: 2,
    steps: [
      { action: "up", status: { current_room: "level_HxI", gem_count: 0, game_lost: false } },
      { action: "right", status: { current_room: "level_HxJ", gem_count: 1, game_lost: false } },
      { action: "down", error: "budget exhausted", status: null }
    ],
    final_observation: { current_room: "level_HxJ", gem_count: 1 }
};
const kimiSequenceEvents = [
  { role: "assistant", content: "Run the saved route.", tool_calls: [{ id: "sequence-1", type: "function", function: { name: "mcp__mazebench__maze_action_sequence", arguments: JSON.stringify({ route_file: "route.json" }) } }] },
  { role: "tool", tool_call_id: "sequence-1", content: JSON.stringify(savedRouteSequenceResult) }
].map(JSON.stringify).join("\n");
assert.deepEqual(
  distillKimiEvents(kimiSequenceEvents).entries.map((entry) => entry.action),
  ["up", "right"]
);
const codexSequenceEvents = [
  { type: "item.completed", item: { type: "reasoning", text: "Run the saved route." } },
  {
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      name: "maze_action_sequence",
      arguments: { route_file: "route.json" },
      status: "completed",
      result: { structuredContent: savedRouteSequenceResult }
    }
  }
].map(JSON.stringify).join("\n");
assert.deepEqual(
  distillCodexEvents(codexSequenceEvents).entries.map((entry) => entry.action),
  ["up", "right"]
);
const claudeSequenceEvents = [
  {
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        id: "sequence-claude",
        name: "mcp__mazebench__maze_action_sequence",
        input: { route_file: "route.json" }
      }]
    }
  },
  {
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: "sequence-claude",
        content: JSON.stringify(savedRouteSequenceResult)
      }]
    }
  }
].map(JSON.stringify).join("\n");
assert.deepEqual(
  distillClaudeEvents(claudeSequenceEvents).entries.map((entry) => entry.action),
  ["up", "right"]
);

const guard = path.join(root, "scripts", "maze-codex-tool-guard.js");
const blocked = spawnSync(process.execPath, [guard], {
  input: JSON.stringify({ tool_name: "exec" }),
  encoding: "utf8"
});
assert.equal(blocked.status, 2);
assert.match(blocked.stderr, /External tools are disabled/);
const directGame = spawnSync(process.execPath, [guard], {
  input: JSON.stringify({ tool_name: "mcp__game__game_action" }),
  encoding: "utf8"
});
assert.equal(directGame.status, 0);

{
  const resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), "maze-resume-policy-"));
  const sessionFile = path.join(resumeDir, "session.json");
  const session = {
    actions: [{ turn: 1, status: { level: "P..", moved: true, board_state_hash: "state-1", player: { x: 4, y: 15, elevation: 0 }, scorecard: { secret: true } } }],
    bridgeCheckpoint: { player: { x: 4, y: 15, elevation: 0 } },
    initial: { level: "P..", board_state_hash: "state-0", player: { x: 4, y: 15, elevation: 0 } },
    lastStatus: { level: ".P.", moved: true, board_state_hash: "state-1", player: { x: 5, y: 15, elevation: 0 } },
    scorecard: { current_position: { x: 5, y: 15, elevation: 0 } }
  };
  fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`);
  fs.writeFileSync(path.join(resumeDir, "scorecard.json"), "{}\n");
  fs.writeFileSync(path.join(resumeDir, "maze_scorecard.json"), "{}\n");
  fs.writeFileSync(path.join(resumeDir, "current-render-state.json"), "{}\n");
  migrateSeedSessionObservation({
    ...baseConfig,
    hideNamesSeed: "resume-seed",
    mode: "text",
    outDir: resumeDir,
    seed: true,
    sessionFile
  });
  const sanitized = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(sanitized.maxActions, 3, "a finite continuation adds its selected moves to existing actions");
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, "scorecard"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, "bridgeCheckpoint"), false);
  assert.deepEqual(sanitized.initial.player, { x: 4, y: 15, elevation: 0 });
  assert.deepEqual(sanitized.lastStatus.player, { x: 5, y: 15, elevation: 0 });
  assert.deepEqual(sanitized.actions[0].status.player, { x: 4, y: 15, elevation: 0 });
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized.actions[0].status, "scorecard"), false);
  assert.equal(sanitized.initial.board_state_hash, "state-0");
  assert.equal(sanitized.lastStatus.board_state_hash, "state-1");
  assert.equal(sanitized.lastStatus.moved, true);
  assert.equal(sanitized.actions[0].status.board_state_hash, "state-1");
  assert.equal(fs.existsSync(path.join(resumeDir, "scorecard.json")), false);
  assert.equal(fs.existsSync(path.join(resumeDir, "maze_scorecard.json")), false);
  assert.equal(fs.existsSync(path.join(resumeDir, "current-render-state.json")), false);
  migrateSeedSessionObservation({
    ...baseConfig,
    hideNamesSeed: "resume-seed",
    mode: "text",
    outDir: resumeDir,
    seed: true,
    sessionFile,
    unlimited: true
  });
  assert.equal(
    JSON.parse(fs.readFileSync(sessionFile, "utf8")).maxActions,
    null,
    "an unlimited continuation clears an older finite helper cap"
  );
  fs.rmSync(resumeDir, { recursive: true, force: true });
}

console.log("agent tool isolation tests passed");
