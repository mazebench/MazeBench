const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const {
  distillClaudeEvents,
  distillCodexEvents,
  distillKimiEvents,
  loadCodexModels
} = require("../scripts/maze-agent-local");
const {
  findClaudeSessionFile,
  findCodexSessionFile,
  findCodexSessionFiles,
  findKimiWireFile,
  findPrimeResultsFile,
  parseClaudeEvents,
  parseCodexEvents,
  parseCodexSession,
  parseCodexSwarmSessions,
  parseKimiWire,
  parsePrimeLiveUsage,
  parsePrimeResults,
  withApiCostEstimate
} = require("./token-usage");
const {
  claudeProjectKey,
  claudeTranscriptPrefix,
  codexTranscriptPrefix,
  providerEventPrefix,
  toolActivityPrefix
} = require("./run-branch");
const { killPlaywrightBrowserProcess } = require("../scripts/playwright-process");
const {
  autoQuitLaunchParams,
  evaluateAutoQuit,
  normalizeAutoQuitConfig
} = require("../shared/auto-quit");
const { BOARD_STATE_HASH_VERSION } = require("../shared/board-state");
const GAME_WON_GEM_COUNT = 100;
const {
  CHECKPOINT_FILE: PRIME_RESUME_CHECKPOINT_FILE,
  writePrimeResumeCheckpoint
} = require("./prime-resume");

// GUI-launched servers (editors, preview harnesses) often get a minimal PATH
// that misses the dirs where codex/claude/docker/prime live. Enrich the PATH
// for child processes with the running Node's own bin dir (which is where
// npm-global CLIs like claude land) plus the usual install locations.
function enrichedPathEnv() {
  const extra = [
    path.dirname(fs.realpathSync(process.execPath)),
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".claude", "local"),
    path.join(os.homedir(), ".kimi-code", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ];
  const current = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  // Prefer the running Node installation's bin directory. That is where this
  // app installs npm-global agents, and it may be newer than a Homebrew cask
  // that appears earlier in a GUI process's inherited PATH.
  const merged = [];

  [extra[0], ...current, ...extra.slice(1)].forEach((dir) => {
    if (!merged.includes(dir) && fs.existsSync(dir)) {
      merged.push(dir);
    }
  });

  return { ...process.env, PATH: merged.join(path.delimiter) };
}

function fileHasContent(filePath) {
  try {
    return Boolean(filePath) && fs.statSync(filePath).size > 0;
  } catch (_error) {
    return false;
  }
}

function normalizeEventTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const trimmed = typeof value === "string" ? value.trim() : value;
  const numeric = typeof trimmed === "number" || /^\d+(?:\.\d+)?$/.test(String(trimmed))
    ? Number(trimmed)
    : Number.NaN;
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(String(trimmed));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Agent Mode backend: launches scripts/maze-agent-local.js (Codex CLI, Claude
// Code, or Kimi Code) or `prime eval run` as detached child processes, one directory per run
// under outputs/maze-local/site/. The runner writes actions.jsonl + session.json
// into that directory as the agent plays, so progress endpoints just read files
// — no state beyond run.json survives a server restart, and none is needed.

const VIEW_NAMES = ["top", "top-diagonal", "diagonal", "side-diagonal", "side"];
const PRIME_HARNESS_CATALOG = require("../environments/mazebench/prime-harness-catalog.json");
const PRIME_HARNESS_CERTIFICATION = require("../environments/mazebench/prime-harness-certification.json");
if (PRIME_HARNESS_CERTIFICATION.catalog_fingerprint !== PRIME_HARNESS_CATALOG.catalog_fingerprint) {
  throw new Error("Prime harness catalog does not match its safety certification.");
}
const CERTIFIED_PRIME_HARNESSES = new Set(
  PRIME_HARNESS_CERTIFICATION.harnesses
    .filter((entry) => entry.status === "certified")
    .map((entry) => entry.id)
);
const VERIFIED_VERIFIERS_REVISION = PRIME_HARNESS_CATALOG.verifiers_revision;
const PRIME_HARNESSES = new Map([
  ["none", {
    id: "none",
    label: "Prime Intellect",
    taskset: "mazebench",
    protocol: "Prime model API",
    launchable: true,
    boundary: "trusted-user-simulator",
    observation_modes: ["text", "json", "vision"]
  }],
  ...PRIME_HARNESS_CATALOG.harnesses.map((definition) => [definition.id, {
    ...definition,
    launchable: Boolean(definition.launchable) && CERTIFIED_PRIME_HARNESSES.has(definition.id),
    status: CERTIFIED_PRIME_HARNESSES.has(definition.id) ? "certified" : "uncertified",
    reason: CERTIFIED_PRIME_HARNESSES.has(definition.id)
      ? definition.reason
      : "This generated harness route has not passed the checked-in compatibility certification.",
    taskset: "mazebench-tools",
    protocol: definition.adapter,
    custom: true
  }])
]);
const UNSAFE_PRIME_AGENT_HARNESS_MESSAGE =
  "This Prime harness is not approved for MazeBench's isolated game-control boundary.";

const STANDARD_REASONING_LEVELS = ["low", "medium", "high"];
const PRIME_REASONING_LEVELS = ["low", "medium", "high"];

function claudeReasoningLevels(modelId) {
  const id = String(modelId || "").toLowerCase().replace(/\./g, "-");
  const supportsXhigh = /(?:^|-)claude-(?:fable-5|mythos-5|opus-4-(?:7|8)|sonnet-5)(?:-|$)/.test(`-${id}`);
  const supportsMax = supportsXhigh ||
    /(?:^|-)claude-(?:mythos-preview|opus-4-6|sonnet-4-6)(?:-|$)/.test(`-${id}`);
  const supportsEffort = supportsMax || /(?:^|-)claude-opus-4-5(?:-|$)/.test(`-${id}`);

  if (!supportsEffort) return [];
  return [
    ...STANDARD_REASONING_LEVELS,
    ...(supportsXhigh ? ["xhigh"] : []),
    ...(supportsMax ? ["max"] : [])
  ];
}

// Keep Prime's runner contract provider-neutral. Provider-specific extensions
// are intentionally excluded, but every Prime model gets the stable
// off/low/medium/high choice exposed by the runner.
function primeReasoningLevels(_modelId) {
  return [...PRIME_REASONING_LEVELS];
}

function primeHarnessModelCompatible(modelId, harnessId) {
  const harness = normalizePrimeHarness(harnessId);
  const id = String(modelId || "").trim();
  if (!id) return false;
  // Prime's interception endpoint is the compatibility layer between a
  // harness protocol and the selected model. The live /models response does
  // not expose a provider-name rule that can safely predict that pairing, so
  // do not hide Codex, Claude Code, or future harnesses based on model ids.
  // The compatibility certificate records actual launch results instead.
  return true;
}

function primeSandboxIdsFromText(value) {
  const ids = new Set();
  const text = String(value || "");
  for (const pattern of [
    /\bsandbox\s+([a-z0-9]{12,64})\s+up\b/gi,
    /\bsandbox-job-([a-z0-9]{12,64})\b/gi
  ]) {
    for (const match of text.matchAll(pattern)) ids.add(match[1]);
  }
  return [...ids];
}

function filterPrimeCatalogForHarness(catalog, harnessId) {
  const harness = normalizePrimeHarness(harnessId);
  if (harness === "none") return { ...catalog, harness };
  const definition = PRIME_HARNESSES.get(harness);
  const allModels = Array.isArray(catalog?.models) ? catalog.models : [];
  if (!definition?.launchable) {
    return {
      ...catalog,
      harness,
      models: [],
      default_model_id: "",
      note: definition.reason || UNSAFE_PRIME_AGENT_HARNESS_MESSAGE
    };
  }
  const models = allModels
    .filter((model) => primeHarnessModelCompatible(model.id, harness))
    .map((model) => ({
      ...model,
      harness_compatible: true,
      compatibility: definition.adapter || definition.protocol
    }));
  return {
    ...catalog,
    harness,
    models,
    default_model_id: models[0]?.id || "",
    note: models.length
      ? `${models.length} live Prime model${models.length === 1 ? "" : "s"}. ${definition.label} is connected through MazeBench's ${definition.adapter || "native"} compatibility route; launch certification is recorded separately because Prime's model list has no harness capability flags.`
      : catalog?.note || `Prime's live model catalog is currently empty.`
  };
}

function publicPrimeHarnesses() {
  return [...PRIME_HARNESSES.values()]
    .filter((definition) => definition.custom)
    .map((definition) => ({
      id: definition.id,
      label: definition.label,
      description: definition.description || "",
      launchable: Boolean(definition.launchable),
      reason: definition.reason || "",
      protocol: definition.protocol || "",
      boundary: definition.boundary || "",
      observation_modes: [...(definition.observation_modes || [])],
      default_config: { ...(definition.default_config || {}) },
      configurable: [...(definition.configurable || [])],
      config_schema: definition.config_schema || { properties: {} },
      adapter: definition.adapter || "native_mcp",
      runtime_harness_id: definition.runtime_harness_id || definition.id,
      upstream_id: definition.upstream_id || null,
      supports_mcp: Boolean(definition.supports_mcp),
      status: definition.status || (definition.launchable ? "compatible" : "catalog_error"),
      catalog_fingerprint: PRIME_HARNESS_CATALOG.catalog_fingerprint,
      certification_schema_version: PRIME_HARNESS_CERTIFICATION.schema_version,
      verifiers_version: PRIME_HARNESS_CATALOG.verifiers_version,
      verifiers_revision: VERIFIED_VERIFIERS_REVISION
    }));
}

function primeHarnessConfigValueValid(value, schema = {}) {
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((option) => primeHarnessConfigValueValid(value, option));
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.type === "null") return value === null;
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "integer") return Number.isInteger(value);
  if (schema.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (schema.type === "string") {
    if (typeof value !== "string") return false;
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) return false;
    return true;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return false;
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return false;
    if (Array.isArray(schema.prefixItems)) {
      return schema.prefixItems.every((item, index) => primeHarnessConfigValueValid(value[index], item));
    }
    return !schema.items || value.every((item) => primeHarnessConfigValueValid(item, schema.items));
  }
  if (schema.type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return value === null || ["string", "number", "boolean"].includes(typeof value) || Array.isArray(value);
}

function normalizePrimeHarnessConfig(value, harnessId) {
  const definition = PRIME_HARNESSES.get(normalizePrimeHarness(harnessId));
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > 16_384) {
    throw new Error(`${definition.label} configuration is too large.`);
  }
  const allowed = new Set(definition.configurable || []);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new Error(`Unsupported ${definition.label} configuration: ${unknown.join(", ")}.`);
  }
  const config = { ...(definition.default_config || {}) };
  for (const [key, value] of Object.entries(raw)) {
    const schema = definition.config_schema?.properties?.[key] || {};
    if (!primeHarnessConfigValueValid(value, schema)) {
      throw new Error(`${definition.label} configuration field "${key}" does not match its pinned Verifiers schema.`);
    }
    config[key] = value;
  }
  return config;
}

function normalizePrimeHarness(value) {
  const requested = String(value || "none").trim().toLowerCase();
  const aliases = {
    claude: "claude_code",
    "claude-code": "claude_code",
    default: "null",
    "kimi-code": "kimi_code",
    "mini-swe-agent": "mini_swe_agent",
    "terminus-2": "terminus_2"
  };
  const normalized = aliases[requested] || requested;
  if (!PRIME_HARNESSES.has(normalized)) {
    throw new Error(
      `Unknown Prime harness "${value}". Supported harnesses: ${[...PRIME_HARNESSES.keys()].join(", ")}.`
    );
  }
  return normalized;
}

function normalizeObservationMode(value) {
  const mode = String(value || "text").toLowerCase();
  return ["json", "vision"].includes(mode) ? mode : "text";
}

function positiveTurnBudget(value, fallback = 20) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizedHideNamesSeed(value) {
  return String(value || "").trim().slice(0, 128);
}

function resolvedHideNamesSeed(hideNames, value) {
  if (!hideNames) return "";
  return normalizedHideNamesSeed(value) || "1";
}

function replayMessageForCommandText(value) {
  const command = String(value || "").trim().toLowerCase();
  if (["up", "down", "left", "right"].includes(command)) {
    return { command: "move", direction: command };
  }
  const rotation = command.match(/^rotate camera (up|down|left|right)$/);
  if (rotation) return { command: "rotate_camera", direction: rotation[1] };
  if (command === "undo") return { command: "undo" };
  if (command === "reset") return { command: "reset_level" };
  if (command === "no move" || command === "no_move") return { command: "no_move" };
  if (command === "quit") return { command: "quit" };
  const level = command.match(/^go to level (?:level_)?([a-z])(?:x|\s+)([a-z])$/i);
  if (level) return { command: "goto_level", x: level[1].toUpperCase(), y: level[2].toUpperCase() };
  return null;
}

const MAX_LOCAL_MOVE_BUDGET = 100_000;
const RUNNER_STARTUP_GRACE_MS = 15_000;
const RUNNER_ACTIVITY_GRACE_MS = 120_000;
const PROVIDER_RETRY_SCAN_MS = 10_000;
const PROVIDER_RETRY_MAX_MS = 15 * 60_000;
const PAUSE_REQUEST_FILE = "pause-request.json";
const PAUSE_BOUNDARY_FILE = "pause-boundary.json";
const PAUSE_CAPABILITY_FILE = "cold-pause-capability.json";
const RUN_FAVORITE_FILE = "favorite.json";
const RUN_REVIEW_FILE = "run-review.json";
const RUN_NOTES_FILE = "run-notes.json";
const MAX_RUN_NOTES_LENGTH = 50_000;
const TOOL_WORKSPACE_MAX_ENTRIES = 2000;
const TOOL_WORKSPACE_READ_BYTES = 512 * 1024;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{4,80}$/i;
const SERVABLE_RUN_FILES = new Set([
  "run.json",
  "launcher.log",
  "session.json",
  "actions.jsonl",
  "reasoning.json",
  "agent.log",
  "agent-events.jsonl",
  "prime-evaluation.json",
  "prime-evaluation-samples.json",
  RUN_REVIEW_FILE,
  RUN_NOTES_FILE,
  "run-review.log",
  "scorecard.json",
  "maze_scorecard.json",
  "maze_actions.txt",
  "maze_replay.mp4"
]);

function runReviewPrompt(runId, runDir, rootDir) {
  return `You are the post-run analyst for MazeBench agent run ${runId}. Produce a candid, detailed review of how the agent played and reasoned.

You have read-only access to the complete run directory at ${runDir} and the MazeBench game implementation at ${rootDir}. Do not modify any file. Read the game source only when it helps explain mechanics; the recorded evaluator artifacts are authoritative about what actually happened.

Inspect the full run, not only the last few turns. Prioritize run.json, maze_scorecard.json, actions.jsonl, reasoning.json, prime-reasoning.jsonl, agent-events.jsonl, launcher.log, and eval-output/results.jsonl when present. Correlate reasoning with actions and outcomes. Treat valid:false actions and their errors as rejected attempts that did not change game state. Do not attempt to decode binary video files.

Write a standalone Markdown report with these sections:
1. Overall verdict and concise scorecard.
2. Strategy and thought-process narrative across the run.
3. What it understood and did well, with specific action numbers.
4. Bad ideas, mistakes, invalid actions, repeated confusion, and wasted effort, with specific action numbers.
5. How well its beliefs matched the actual game state and mechanics.
6. Important turning points and interesting anecdotes from the reasoning logs.
7. Efficiency, exploration, recovery behavior, and use of memory/tools/other agents when applicable.
8. A better strategy it should have followed.
9. Final lessons and concrete recommendations for the next attempt.

Distinguish evidence from inference. Quote only short phrases from the reasoning logs and otherwise summarize. Be thorough, specific, readable, and honest.`;
}

function runReviewCommand({ provider, model, reasoning, runDir, rootDir, outputPath, prompt }) {
  if (provider === "codex") {
    const argv = [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "-C", runDir,
      "--sandbox", "read-only",
      "-c", 'approval_policy="never"',
      "-c", 'web_search="disabled"',
      "-c", "tools.web_search=false",
      "--disable", "multi_agent",
      "--disable", "apps",
      "--disable", "plugins",
      "--output-last-message", outputPath
    ];
    if (model) argv.push("--model", model);
    if (reasoning) argv.push("-c", `model_reasoning_effort=${JSON.stringify(reasoning)}`);
    argv.push(prompt);
    return { bin: "codex", argv };
  }

  if (provider === "claude") {
    const argv = [
      "-p", prompt,
      "--output-format", "text",
      "--no-session-persistence",
      "--safe-mode",
      "--disable-slash-commands",
      "--no-chrome",
      "--permission-mode", "dontAsk",
      "--tools", "Read,Glob,Grep",
      "--allowedTools", "Read,Glob,Grep",
      "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,Agent",
      "--add-dir", rootDir
    ];
    if (model) argv.push("--model", model);
    if (reasoning) argv.push("--effort", reasoning);
    return { bin: "claude", argv };
  }

  throw new Error('Review provider must be "codex" or "claude".');
}

function branchLaunchParams(meta, sourceParams, runId, turn) {
  const params = { ...(sourceParams || {}) };
  const unlimited = [meta?.unlimited, params.unlimited].some((value) => value === true || value === "true");
  const moves = Math.max(
    1,
    Math.min(
      MAX_LOCAL_MOVE_BUDGET,
      Math.floor(Number(params.moves) || Number(meta?.segment_move_budget) || Number(meta?.moves) || 20)
    )
  );
  return {
    ...params,
    kind: "local",
    unlimited,
    ...(unlimited ? {} : { moves }),
    branch_of: runId,
    branch_turn: turn
  };
}

function collectedAllWorldGems(gemCount, gemTotal) {
  if (gemTotal === null || gemTotal === undefined || gemTotal === "") return false;
  const collected = Number(gemCount);
  const total = Number(gemTotal);
  return Number.isFinite(collected) && Number.isFinite(total) && total >= 0 && collected >= total;
}

function normalizedPricingModelId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function apiPricingForRun(summary, models) {
  const runModel = normalizedPricingModelId(summary?.model_name);
  if (!runModel) return null;

  const expectedProvider = summary?.provider === "codex"
    ? "openai"
    : summary?.provider === "claude"
      ? "anthropic"
      : summary?.provider === "kimi"
        ? "moonshotai"
        : "";
  const model = (Array.isArray(models) ? models : []).find((candidate) => {
    const id = String(candidate?.id || "");
    const slash = id.indexOf("/");
    const provider = slash === -1 ? "" : id.slice(0, slash).toLowerCase();
    const shortId = slash === -1 ? id : id.slice(slash + 1);
    if (expectedProvider && provider !== expectedProvider) return false;
    return normalizedPricingModelId(id) === runModel || normalizedPricingModelId(shortId) === runModel;
  });
  const input = Number(model?.pricing?.input);
  const output = Number(model?.pricing?.output);
  if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) return null;
  return { model: model.id, input, output };
}

function primeEvaluationReward(sample, scorecard = null) {
  const scalar = Number(sample?.reward);
  if (Number.isFinite(scalar)) return scalar;
  const components = Object.values(sample?.rewards || {})
    .map(Number)
    .filter(Number.isFinite);
  if (components.length) return components.reduce((sum, value) => sum + value, 0);
  const metricReward = Number(sample?.metrics?.reward);
  if (Number.isFinite(metricReward)) return metricReward;
  const percent = Number(scorecard?.result?.percent);
  return Number.isFinite(percent) ? percent / 100 : 0;
}

function createAgentRunService({
  agentEnvironment,
  agentEnvironmentAsync,
  allowLegacyLocalLaunch = true,
  primeEvaluationCreator = {},
  reviewBins = {},
  syncPrimeEvaluations = false,
  ensureDirectory,
  getGame,
  buildWorlds,
  loadJson,
  rootDir,
  worldMaps
}) {
  const runsDir = path.join(rootDir, "outputs", "maze-local", "site");
  const runnerScript = path.join(rootDir, "scripts", "maze-agent-local.js");
  const primeRunnerScript = path.join(rootDir, "scripts", "maze-prime-run.js");
  const replayScript = path.join(rootDir, "scripts", "maze-export-replay.js");
  const primeEvaluationCreatorScript = path.join(rootDir, "scripts", "prime-create-evaluation.js");
  const liveChildren = new Map();
  const videoChildren = new Map();
  const primeSyncChildren = new Map();
  const reviewChildren = new Map();
  const resolvedRunModels = new Map();
  const legacyClaudeSnapshotTimers = new Map();
  const legacyClaudeSnapshotStamps = new Map();
  const codexSessionPaths = new Map();
  const autoQuitMonitors = new Map();

  function requireLegacyLocalLaunch() {
    if (!allowLegacyLocalLaunch) {
      throw new Error(
        "Local Codex, Claude Code, and Kimi Code launches are disabled. Choose the corresponding Prime harness."
      );
    }
  }

  function requireLocalSubscription(params) {
    if (!(params?.subscription === true || params?.subscription === "true")) return;
    const provider = String(params.model || "").toLowerCase();
    const environment = typeof agentEnvironment === "function"
      ? agentEnvironment({ fresh: true })
      : {};
    if (!environment[provider]) {
      const label = { claude: "Claude Code", kimi: "Kimi Code", codex: "Codex" }[provider] || provider;
      const login = { claude: "claude auth login", kimi: "kimi login", codex: "codex login" }[provider] || "";
      throw new Error(`${label} needs an active local account. Run \`${login}\`, then refresh the Agent page.`);
    }
  }

  function localLaunchEnvironment(params) {
    const environment = enrichedPathEnv();
    if (!(params?.subscription === true || params?.subscription === "true")) return environment;
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_ACCESS_TOKEN"]) {
      delete environment[key];
    }
    return environment;
  }
  const primeResultsPaths = new Map();
  const actionCache = new Map();
  const reasoningCache = new Map();
  const toolActivityCache = new Map();
  const toolWorkspaceCache = new Map();
  const primeRolloutFailureCache = new Map();
  const tokenUsageCache = new Map();
  const jsonLineIndexes = new Map();
  const initialPlayerCache = new Map();
  const reconstructedJsonObservationCache = new Map();
  const jsonDisplayPaletteCache = new Map();
  const reconstructedAsciiObservationCache = new Map();
  const reconstructedBoardStateTimelineCache = new Map();
  const LARGE_TELEMETRY_BYTES = 1024 * 1024;
  const LARGE_TELEMETRY_REFRESH_MS = 10_000;
  // History reconstruction uses spawnSync, so an oversized legacy run can
  // otherwise block every HTTP request until the bridge times out. Large runs
  // still load normally; only unavailable legacy observations/positions are
  // omitted instead of being rebuilt synchronously on the server thread.
  const MAX_SYNCHRONOUS_HISTORY_REPLAY_ACTIONS = 500;
  // Hydrate long run pages in bounded chunks so JSON parsing and DOM updates
  // yield between batches instead of freezing the browser on a 10k+ move run.
  const PROGRESS_ACTION_BATCH_SIZE = 500;
  const stableCodexCatalogPath = path.join(runsDir, ".codex-model-catalog.json");
  let stableCodexCatalog;
  let startingClaudeQueue = false;

  // Container mode needs Docker installed AND its daemon running. Prefer the
  // shared (cached) environment probe; fall back to a direct check otherwise.
  function dockerAvailable() {
    if (typeof agentEnvironment === "function") {
      return Boolean(agentEnvironment().docker);
    }

    if (spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8", env: enrichedPathEnv() }).status !== 0) {
      return false;
    }

    const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 8000
    });
    const version = String(info.stdout || "").trim();
    return info.status === 0 && version.length > 0 && version !== "<no value>";
  }

  function dockerInstalled() {
    if (typeof agentEnvironment === "function") {
      return Boolean(agentEnvironment().docker_installed);
    }

    return spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8", env: enrichedPathEnv() }).status === 0;
  }

  function getEnvironment(options = {}) {
    return typeof agentEnvironment === "function" ? agentEnvironment(options) : {};
  }

  function getEnvironmentAsync(options = {}) {
    if (typeof agentEnvironmentAsync === "function") return agentEnvironmentAsync(options);
    return Promise.resolve(getEnvironment(options));
  }

  // Launch the Docker daemon when it is installed but stopped. The daemon takes
  // ~30-60s to become reachable, so this only kicks off the launch; the client
  // polls the environment until docker_running flips true.
  function startDocker() {
    if (dockerAvailable()) {
      return { started: true, running: true, message: "Docker is already running." };
    }

    if (!dockerInstalled()) {
      throw new Error("Docker is not installed.");
    }

    const spawnDetached = (bin, args) => {
      const child = spawn(bin, args, { detached: true, stdio: "ignore", env: enrichedPathEnv() });
      child.on("error", () => {});
      child.unref();
    };

    if (process.platform === "darwin") {
      const app = process.env.MAZEBENCH_DOCKER_APP || "Docker";
      spawnDetached("open", ["-a", app]);
      return { started: true, running: false, message: `Starting ${app}… this can take up to a minute.` };
    }

    if (process.platform === "win32") {
      spawnDetached("cmd", ["/c", "start", "", "Docker Desktop"]);
      return { started: true, running: false, message: "Starting Docker Desktop… this can take up to a minute." };
    }

    // Linux: the daemon is usually a privileged system service we should not
    // guess at (systemctl needs sudo; Docker Desktop is a user service).
    return {
      started: false,
      running: false,
      message: "Start Docker manually (e.g. `systemctl start docker` or launch Docker Desktop), then reload."
    };
  }

  function timestampSlug() {
    return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  }

  function generateRunId() {
    return `${timestampSlug()}-${crypto.randomBytes(3).toString("hex")}`;
  }

  function runDirFor(runId) {
    if (!RUN_ID_PATTERN.test(String(runId || ""))) {
      throw new Error(`Invalid run id "${runId}".`);
    }

    return path.join(runsDir, runId);
  }

  function agentWorkspaceRootFor(runId) {
    const runDir = runDirFor(runId);
    let workspaceIdentity = runDir;
    try {
      // A development server may run from a temporary merged checkout whose
      // outputs directory is a symlink to the canonical repository outputs.
      // The runner hashes the canonical run directory, so the UI must do the
      // same or it will report an empty workspace even though files still exist.
      workspaceIdentity = fs.realpathSync(runDir);
    } catch (_error) {
      /* an incomplete/deleted run has no workspace to inspect */
    }
    const key = crypto.createHash("sha256").update(workspaceIdentity).digest("hex").slice(0, 24);
    return path.join(os.tmpdir(), "mazebench-agent-workspaces", key);
  }

  function runMetaPath(runId) {
    return path.join(runDirFor(runId), "run.json");
  }

  function runFavoritePath(runId) {
    return path.join(runDirFor(runId), RUN_FAVORITE_FILE);
  }

  function runNotesPath(runId) {
    return path.join(runDirFor(runId), RUN_NOTES_FILE);
  }

  function getRunNotes(runId) {
    if (!readRunMeta(runId)) throw new Error(`Unknown run "${runId}".`);
    const saved = loadJson(runNotesPath(runId), null);
    return {
      schema_version: 1,
      notes: String(saved?.notes || ""),
      updated_at: saved?.updated_at || null
    };
  }

  function setRunNotes(runId, value) {
    if (!readRunMeta(runId)) throw new Error(`Unknown run "${runId}".`);
    if (typeof value !== "string") throw new Error("Run notes must be text.");
    const notes = value.replace(/\r\n?/g, "\n").trim();
    if (notes.length > MAX_RUN_NOTES_LENGTH) {
      throw new Error(`Run notes must be ${MAX_RUN_NOTES_LENGTH.toLocaleString()} characters or fewer.`);
    }

    const target = runNotesPath(runId);
    if (!notes) {
      fs.rmSync(target, { force: true });
      return getRunNotes(runId);
    }

    const saved = {
      schema_version: 1,
      notes,
      updated_at: new Date().toISOString()
    };
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, target);
    return saved;
  }

  function isRunFavorite(runId) {
    const markerPath = runFavoritePath(runId);
    if (!fs.existsSync(markerPath)) return fs.existsSync(path.join(runDirFor(runId), "favorite"));
    const marker = loadJson(markerPath, null);
    return marker === null || marker.favorite === true || marker.favorited === true || marker.is_favorite === true;
  }

  function setRunFavorite(runId, favorite) {
    if (typeof favorite !== "boolean") {
      throw new Error("Favorite must be true or false.");
    }

    const meta = readRunMeta(runId);
    if (!meta) {
      throw new Error(`Unknown run "${runId}".`);
    }

    const markerPath = runFavoritePath(runId);
    if (favorite) {
      const previous = loadJson(markerPath, null);
      const now = new Date().toISOString();
      const marker = {
        schema_version: 1,
        favorite: true,
        favorited_at: previous?.favorited_at || now,
        updated_at: now
      };
      const temporary = `${markerPath}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
      fs.renameSync(temporary, markerPath);
    } else {
      fs.rmSync(markerPath, { force: true });
      fs.rmSync(path.join(runDirFor(runId), "favorite"), { force: true });
    }

    return summarizeRun(runId);
  }

  function clearColdPauseMarkers(runId) {
    const runDir = runDirFor(runId);
    fs.rmSync(path.join(runDir, PAUSE_REQUEST_FILE), { force: true });
    fs.rmSync(path.join(runDir, PAUSE_BOUNDARY_FILE), { force: true });
  }

  function clearColdPauseCapability(runId) {
    fs.rmSync(path.join(runDirFor(runId), PAUSE_CAPABILITY_FILE), { force: true });
  }

  function runContainerId(runId) {
    try {
      const id = fs.readFileSync(path.join(runDirFor(runId), "container.cid"), "utf8").trim();
      return /^[a-f0-9]{12,64}$/i.test(id) ? id : "";
    } catch (_error) {
      return "";
    }
  }

  function dockerRunControl(runId, args, action, { required = true } = {}) {
    const containerId = runContainerId(runId);

    if (!containerId) {
      if (required) throw new Error(`The Docker container is still starting; try ${action} again in a moment.`);
      return false;
    }

    const result = spawnSync("docker", [...args, containerId], {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });

    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || "").trim().split(/\r?\n/).pop();
      throw new Error(`Could not ${action} the Docker run${detail ? `: ${detail}` : "."}`);
    }

    return true;
  }

  function dockerRunAlive(runId) {
    const containerId = runContainerId(runId);
    if (!containerId) return false;
    const result = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", containerId], {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 3000,
      maxBuffer: 128 * 1024
    });
    return result.status === 0 && String(result.stdout || "").trim() === "true";
  }

  function runRecentlyActive(runId) {
    const directory = runDirFor(runId);
    const files = ["launcher.log", "agent-events.jsonl", "tool-activity.jsonl", "session.json"];
    return files.some((name) => {
      try {
        return Date.now() - fs.statSync(path.join(directory, name)).mtimeMs < RUNNER_ACTIVITY_GRACE_MS;
      } catch (_error) {
        return false;
      }
    });
  }

  // Runs created before per-run Claude mounts were introduced still keep their
  // native transcript inside the live container. Mirror it after each completed
  // maze action so those already-running sessions can also Continue losslessly.
  function snapshotLegacyClaudeConversation(runId, meta, { force = false } = {}) {
    if (!meta?.container || meta.model !== "claude" || meta.conversation_persistence === "run-dir") return false;
    const conversationId = readConversationId(runId);
    const containerId = runContainerId(runId);
    if (!conversationId || !containerId) return false;

    const runDir = runDirFor(runId);
    const actionsStamp = fileStamp(path.join(runDir, "actions.jsonl"));
    if (!force && legacyClaudeSnapshotStamps.get(runId) === actionsStamp) return true;

    const targetDir = path.join(runDir, "agent-state", "claude", "projects", "-app");
    const target = path.join(targetDir, `${conversationId}.jsonl`);
    const temporary = `${target}.snapshot-${process.pid}`;
    fs.mkdirSync(targetDir, { recursive: true });
    fs.rmSync(temporary, { force: true });

    const result = spawnSync(
      "docker",
      ["cp", `${containerId}:/home/pwuser/.claude/projects/-app/${conversationId}.jsonl`, temporary],
      { encoding: "utf8", env: enrichedPathEnv(), timeout: 15000, maxBuffer: 1024 * 1024 }
    );

    if (result.status !== 0 || !fs.existsSync(temporary)) {
      fs.rmSync(temporary, { force: true });
      return false;
    }

    fs.renameSync(temporary, target);
    legacyClaudeSnapshotStamps.set(runId, actionsStamp);
    return true;
  }

  function stopLegacyClaudeSnapshots(runId) {
    const timer = legacyClaudeSnapshotTimers.get(runId);
    if (timer) clearInterval(timer);
    legacyClaudeSnapshotTimers.delete(runId);
    legacyClaudeSnapshotStamps.delete(runId);
  }

  function startLegacyClaudeSnapshots(runId) {
    if (legacyClaudeSnapshotTimers.has(runId)) return;
    const meta = readRunMeta(runId);
    if (!meta?.container || meta.model !== "claude" || meta.conversation_persistence === "run-dir") return;

    snapshotLegacyClaudeConversation(runId, meta, { force: true });
    const timer = setInterval(() => {
      const current = readRunMeta(runId);
      if (!current || !["running", "stopping"].includes(current.status)) {
        stopLegacyClaudeSnapshots(runId);
        return;
      }
      snapshotLegacyClaudeConversation(runId, current);
    }, 1500);
    timer.unref?.();
    legacyClaudeSnapshotTimers.set(runId, timer);
  }

  function signalRunProcess(meta, signal) {
    if (!meta?.pid) return false;

    try {
      process.kill(-meta.pid, signal);
      return true;
    } catch (_error) {
      try {
        process.kill(meta.pid, signal);
        return true;
      } catch (_innerError) {
        return false;
      }
    }
  }

  function reconcileInterruptedActionLogs(runId) {
    const runDir = runDirFor(runId);
    const directories = [runDir];
    const swarmDir = path.join(runDir, "swarm");
    try {
      fs.readdirSync(swarmDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .forEach((entry) => directories.push(path.join(swarmDir, entry.name)));
    } catch (_error) {
      /* no worker sessions */
    }

    directories.forEach((directory) => {
      const session = loadJson(path.join(directory, "session.json"), null);
      if (!Array.isArray(session?.actions)) return;
      const target = path.join(directory, "actions.jsonl");
      const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      const content = session.actions.length
        ? `${session.actions.map((action) => JSON.stringify(action)).join("\n")}\n`
        : "";
      fs.writeFileSync(temporary, content, "utf8");
      fs.renameSync(temporary, target);
    });
    actionCache.delete(runId);
  }

  function settleInterruptedToolActivity(runId, completedAt) {
    const activityPath = path.join(runDirFor(runId), "tool-activity.jsonl");
    const latest = new Map();
    readJsonLineTail(activityPath, 32 * 1024 * 1024).forEach((entry) => {
      if (entry?.id) latest.set(String(entry.id), entry);
    });
    const completedMs = Date.parse(completedAt);
    const cancelled = [...latest.values()]
      .filter((entry) => entry.status === "running")
      .map((entry) => {
        const startedMs = Date.parse(entry.started_at || "");
        return {
          id: entry.id,
          tool: entry.tool,
          actor: entry.actor,
          clone_id: entry.clone_id,
          action: entry.action,
          ...(Array.isArray(entry.actions) ? { actions: entry.actions } : {}),
          started_at: entry.started_at || null,
          completed_at: completedAt,
          duration_ms: Number.isFinite(startedMs) && Number.isFinite(completedMs)
            ? Math.max(0, completedMs - startedMs)
            : 0,
          status: "cancelled",
          error: "Cancelled because the user paused the run.",
          move_calls: 0,
          moves_before: entry.moves_before,
          moves_after: entry.moves_before,
          ...(entry.python_code_hash ? { python_code_hash: entry.python_code_hash } : {})
        };
      });
    if (!cancelled.length) return;
    fs.appendFileSync(activityPath, `${cancelled.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    toolActivityCache.delete(runId);
    toolWorkspaceCache.delete(runId);
  }

  function processCommand(pid) {
    if (!pid) return "";
    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 3000,
      maxBuffer: 256 * 1024
    });
    return result.status === 0 ? String(result.stdout || "").trim() : "";
  }

  function stopDetachedRunRenderers(runId, { force = false } = {}) {
    const runDir = runDirFor(runId);
    const portFiles = [path.join(runDir, "render-daemon.json")];
    const swarmDir = path.join(runDir, "swarm");
    if (fs.existsSync(swarmDir)) {
      fs.readdirSync(swarmDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .forEach((entry) => portFiles.push(path.join(swarmDir, entry.name, "render-daemon.json")));
    }

    portFiles.forEach((portFile) => {
      const info = loadJson(portFile, null);
      const pid = Math.floor(Number(info?.pid) || 0);
      // Container PIDs can overlap unrelated host PIDs. Never signal a PID
      // unless the host command proves it belongs to our renderer.
      if (pid && /maze-render-frame\.js/.test(processCommand(pid))) {
        try {
          process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
        } catch (_error) {
          try {
            process.kill(pid, force ? "SIGKILL" : "SIGTERM");
          } catch (_innerError) {
            /* already exited */
          }
        }
      }
      if (Number(info?.browser_pid) > 0) {
        killPlaywrightBrowserProcess(Number(info.browser_pid));
      }
      fs.rmSync(portFile, { force: true });
    });
  }

  function readRunMeta(runId) {
    return loadJson(runMetaPath(runId), null);
  }

  function readPrimeEvaluation(runId) {
    return loadJson(path.join(runDirFor(runId), "prime-evaluation.json"), null);
  }

  function writePrimeEvaluation(runId, value) {
    const target = path.join(runDirFor(runId), "prime-evaluation.json");
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, target);
    return value;
  }

  function primePushEvaluationId(value) {
    const text = String(value || "").replace(/\u001b\[[0-9;]*m/g, "");
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const payload = JSON.parse(lines[index]);
        const id = String(payload?.evaluation_id || payload?.eval_id || "");
        if (id) return id;
      } catch (_error) {
        /* Prime also prints human-readable progress before its final JSON. */
      }
    }
    const jsonMatch = text.match(/"evaluation_id"\s*:\s*"([a-z0-9]+)"/i);
    if (jsonMatch) return jsonMatch[1];
    return text.match(/Evaluation ID:\s*([a-z0-9]+)/i)?.[1] || "";
  }

  function primeEnvironmentForRun(meta) {
    return String(
      meta.prime_environment ||
      process.env.MAZEBENCH_PRIME_ENVIRONMENT ||
      "mazebench/mazebench"
    );
  }

  function primeEvalMetadata(runId, meta, environment, existing = {}) {
    return {
      ...existing,
      env_id: environment,
      model: String(meta.model_name || meta.model || "prime"),
      framework: existing.framework || "verifiers",
      task_type: existing.task_type || "agent-evaluation",
      mazebench_run_id: runId,
      mazebench_harness: String(meta.harness || "none"),
      mazebench_harness_label: String(meta.harness_label || "Prime Intellect"),
      mazebench_observation_mode: String(meta.mode || "text"),
      mazebench_execution: "local",
      mazebench_run_status: String(meta.status || ""),
      num_examples: Number(existing.num_examples) || 1,
      rollouts_per_example: Number(existing.rollouts_per_example) || 1
    };
  }

  function syncPrimeEvaluation(runId) {
    const meta = readRunMeta(runId);
    if (!meta) throw new Error(`Unknown run "${runId}".`);
    if (meta.kind !== "prime") throw new Error("Only Prime-backed runs can sync to Prime Evals.");
    if (meta.prime_execution === "hosted") return summarizeRun(runId);
    if (!["paused", "finished", "stopped", "failed"].includes(meta.status)) {
      throw new Error("Finish, stop, or pause the run before syncing it to Prime Evals.");
    }

    const resultsPath = findPrimeResultsFile(runDirFor(runId));
    if (!fileHasContent(resultsPath)) {
      throw new Error("This run does not have a completed results.jsonl to sync yet.");
    }
    const existingState = readPrimeEvaluation(runId) || {};
    // Never create a duplicate for a fully synced run. A failed upload can
    // safely resume against its already-created evaluation id with --eval.
    if (existingState.evaluation_id && existingState.sync_status === "synced") {
      return summarizeRun(runId);
    }
    if (primeSyncChildren.has(runId)) return summarizeRun(runId);

    const runDir = runDirFor(runId);
    const resultsDir = path.join(runDir, ".prime-eval-sync");
    fs.mkdirSync(resultsDir, { recursive: true });
    const scorecard = loadJson(path.join(runDir, "maze_scorecard.json"), null);
    const normalizedResults = fs.readFileSync(resultsPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        const sample = JSON.parse(line);
        return JSON.stringify({ ...sample, reward: primeEvaluationReward(sample, scorecard) });
      });
    if (!normalizedResults.length) {
      throw new Error("This run does not have a valid result sample to sync yet.");
    }
    fs.writeFileSync(path.join(resultsDir, "results.jsonl"), `${normalizedResults.join("\n")}\n`, "utf8");
    const metadataPath = path.join(resultsDir, "metadata.json");
    const environment = primeEnvironmentForRun(meta);
    const existingMetadata = {
      ...(loadJson(path.join(path.dirname(resultsPath), "metadata.json"), {}) || {}),
      ...(loadJson(metadataPath, {}) || {})
    };
    fs.writeFileSync(
      metadataPath,
      `${JSON.stringify(primeEvalMetadata(runId, meta, environment, existingMetadata), null, 2)}\n`,
      "utf8"
    );

    const evalName = `MazeBench Agent ${runId}`;
    const startedAt = new Date().toISOString();
    writePrimeEvaluation(runId, {
      ...existingState,
      evaluation_id: existingState.evaluation_id || "",
      environment,
      model: String(meta.model_name || meta.model || "prime"),
      name: evalName,
      status: "UPLOADING",
      sync_status: "syncing",
      sync_started_at: startedAt,
      sync_error: null,
      updated_at: startedAt
    });

    let settled = false;
    const fail = (detailValue) => {
      if (settled) return;
      settled = true;
      primeSyncChildren.delete(runId);
      const current = readPrimeEvaluation(runId) || {};
      const completedAt = new Date().toISOString();
      const detail = String(detailValue || "Prime evaluation sync failed.")
        .replace(/\u001b\[[0-9;]*m/g, "")
        .trim()
        .slice(-2000);
      writePrimeEvaluation(runId, {
        ...current,
        status: "SYNC_FAILED",
        sync_status: "failed",
        sync_completed_at: completedAt,
        sync_error: detail || "Prime evaluation sync failed.",
        updated_at: completedAt
      });
    };

    const pushEvaluation = (evaluationId) => {
      if (settled) return;
      const evaluationStartedAt = new Date().toISOString();
      writePrimeEvaluation(runId, {
        ...(readPrimeEvaluation(runId) || {}),
        evaluation_id: evaluationId,
        status: "UPLOADING",
        sync_status: "syncing",
        sync_error: null,
        updated_at: evaluationStartedAt
      });
      const child = spawn(
        "prime",
        [
          "eval", "push", resultsDir,
          "--eval", evaluationId,
          "--name", evalName,
          "--output", "json",
          "--plain"
        ],
        { cwd: rootDir, env: enrichedPathEnv(), stdio: ["ignore", "pipe", "pipe"] }
      );
      child.unref();
      primeSyncChildren.set(runId, child);
      let output = "";
      const consume = (chunk) => {
        output = `${output}${chunk.toString()}`.slice(-2 * 1024 * 1024);
      };
      child.stdout.on("data", consume);
      child.stderr.on("data", consume);
      child.on("error", (error) => fail(error.message));
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          fail(output || `prime eval push exited with status ${code ?? "unknown"}.`);
          return;
        }
        settled = true;
        primeSyncChildren.delete(runId);
        const completedAt = new Date().toISOString();
        writePrimeEvaluation(runId, {
          ...(readPrimeEvaluation(runId) || {}),
          evaluation_id: evaluationId,
          status: "COMPLETED",
          sync_status: "synced",
          sync_completed_at: completedAt,
          sync_error: null,
          updated_at: completedAt,
          viewer_url: `https://app.primeintellect.ai/dashboard/evaluations/${evaluationId}`
        });
      });
    };

    if (existingState.evaluation_id) {
      pushEvaluation(existingState.evaluation_id);
      return summarizeRun(runId);
    }

    // prime-evals 0.2.3 incorrectly treats every owner-qualified environment
    // as team-owned. Resolve the Hub environment to its database id first so
    // personal, team, and public environments all upload through the same path.
    const creatorArgs = [
      ...(Array.isArray(primeEvaluationCreator.args)
        ? primeEvaluationCreator.args
        : [primeEvaluationCreatorScript]),
      "--environment", environment,
      "--name", evalName,
      "--model", String(meta.model_name || meta.model || "prime"),
      "--metadata", metadataPath
    ];
    const creator = spawn(
      String(primeEvaluationCreator.bin || process.execPath),
      creatorArgs,
      { cwd: rootDir, env: enrichedPathEnv(), stdio: ["ignore", "pipe", "pipe"] }
    );
    creator.unref();
    primeSyncChildren.set(runId, creator);
    let creatorOutput = "";
    const consumeCreator = (chunk) => {
      creatorOutput = `${creatorOutput}${chunk.toString()}`.slice(-2 * 1024 * 1024);
    };
    creator.stdout.on("data", consumeCreator);
    creator.stderr.on("data", consumeCreator);
    creator.on("error", (error) => fail(error.message));
    creator.on("close", (code) => {
      if (settled) return;
      const evaluationId = code === 0 ? primePushEvaluationId(creatorOutput) : "";
      if (!evaluationId) {
        fail(creatorOutput || `Prime evaluation creation exited with status ${code ?? "unknown"}.`);
        return;
      }
      pushEvaluation(evaluationId);
    });
    return summarizeRun(runId);
  }

  function maybeSyncPrimeEvaluation(runId, meta = readRunMeta(runId)) {
    if (!syncPrimeEvaluations || meta?.kind !== "prime" || meta.prime_execution === "hosted") return false;
    if (!["paused", "finished", "stopped", "failed"].includes(meta.status)) return false;
    const state = readPrimeEvaluation(runId);
    if (state?.sync_status === "synced" || primeSyncChildren.has(runId)) return false;
    if (!fileHasContent(findPrimeResultsFile(runDirFor(runId)))) return false;
    try {
      syncPrimeEvaluation(runId);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function getRunReview(runId) {
    const meta = readRunMeta(runId);
    if (!meta) throw new Error(`Unknown run "${runId}".`);
    const review = loadJson(path.join(runDirFor(runId), RUN_REVIEW_FILE), {
      status: "idle",
      provider: "",
      model: "",
      reasoning: "",
      review: "",
      error: ""
    });
    if (review.status === "running" && !reviewChildren.has(runId)) {
      return writeRunReview(runId, {
        ...review,
        status: "failed",
        completed_at: new Date().toISOString(),
        review: "",
        error: "The MazeBench server restarted while this review was running. Start the review again."
      });
    }
    return review;
  }

  function writeRunReview(runId, value) {
    const target = path.join(runDirFor(runId), RUN_REVIEW_FILE);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, target);
    return value;
  }

  function generateRunReview(runId, params = {}) {
    const meta = readRunMeta(runId);
    if (!meta) throw new Error(`Unknown run "${runId}".`);
    if (!["paused", "finished", "stopped", "failed"].includes(meta.status)) {
      throw new Error("Pause or finish the run before asking another model to review it.");
    }
    if (!fileHasContent(path.join(runDirFor(runId), "actions.jsonl"))) {
      throw new Error("This run has no recorded actions to review.");
    }

    const provider = String(params.provider || "codex").trim().toLowerCase();
    if (!["codex", "claude"].includes(provider)) {
      throw new Error('Review provider must be "codex" or "claude".');
    }
    const model = String(params.model || "").trim();
    if (!model || model.length > 200 || /[\r\n\0]/.test(model)) {
      throw new Error("Choose a valid reviewer model.");
    }
    const reasoning = String(params.reasoning || "").trim().toLowerCase();
    if (reasoning && !["low", "medium", "high", "xhigh", "max", "ultra"].includes(reasoning)) {
      throw new Error("Choose a supported reviewer reasoning effort.");
    }
    const environment = getEnvironment({ fresh: true });
    if (!environment[provider]) {
      const label = provider === "claude" ? "Claude Code" : "Codex";
      const login = provider === "claude" ? "claude auth login" : "codex login";
      throw new Error(`${label} is not signed in. Run \`${login}\`, then try again.`);
    }
    if (reviewChildren.has(runId)) return getRunReview(runId);

    const runDir = runDirFor(runId);
    const generationId = crypto.randomUUID();
    const outputPath = path.join(runDir, `.run-review-${generationId}.md`);
    const logPath = path.join(runDir, "run-review.log");
    const prompt = runReviewPrompt(runId, runDir, rootDir);
    const command = runReviewCommand({ provider, model, reasoning, runDir, rootDir, outputPath, prompt });
    const startedAt = new Date().toISOString();
    writeRunReview(runId, {
      schema_version: 1,
      generation_id: generationId,
      status: "running",
      provider,
      model,
      reasoning,
      started_at: startedAt,
      completed_at: null,
      review: "",
      error: ""
    });

    const child = spawn(String(reviewBins[provider] || command.bin), command.argv, {
      cwd: runDir,
      env: enrichedPathEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.unref();
    reviewChildren.set(runId, child);
    let stdout = "";
    let log = "";
    let settled = false;
    const append = (chunk, isStdout) => {
      const text = chunk.toString();
      log = `${log}${text}`.slice(-8 * 1024 * 1024);
      if (isStdout) stdout = `${stdout}${text}`.slice(-8 * 1024 * 1024);
      try {
        fs.appendFileSync(logPath, text, "utf8");
      } catch (_error) {
        /* the final state still reports provider errors */
      }
    };
    child.stdout.on("data", (chunk) => append(chunk, true));
    child.stderr.on("data", (chunk) => append(chunk, false));
    const finish = (code, spawnError = null) => {
      if (settled) return;
      settled = true;
      reviewChildren.delete(runId);
      const current = loadJson(path.join(runDir, RUN_REVIEW_FILE), {});
      if (current.generation_id !== generationId) return;
      let review = provider === "codex" && fileHasContent(outputPath)
        ? fs.readFileSync(outputPath, "utf8").trim()
        : stdout.trim();
      fs.rmSync(outputPath, { force: true });
      const completedAt = new Date().toISOString();
      if (code === 0 && review) {
        writeRunReview(runId, {
          ...current,
          status: "completed",
          completed_at: completedAt,
          review,
          error: ""
        });
        return;
      }
      const error = String(spawnError?.message || log || `Reviewer exited with status ${code ?? "unknown"}.`)
        .trim()
        .slice(-4000);
      writeRunReview(runId, {
        ...current,
        status: "failed",
        completed_at: completedAt,
        review: "",
        error: error || "The reviewer did not return a report."
      });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
    return getRunReview(runId);
  }

  function readPrimeRolloutFailure(runId) {
    const samplesPath = path.join(runDirFor(runId), "prime-evaluation-samples.json");
    const localResultsPath = findPrimeResultsFile(runDirFor(runId));
    const signature = `${fileStamp(samplesPath)}|${fileStamp(localResultsPath)}`;
    const cached = primeRolloutFailureCache.get(runId);
    if (cached?.signature === signature) return cached.value;

    const payload = loadJson(samplesPath, null);
    const samples = Array.isArray(payload?.samples) ? payload.samples : [];
    let value = null;
    for (const sample of samples) {
      const info = sample?.info || {};
      const error = info.error;
      if (info.stop_condition !== "has_error" && !error) continue;
      value = {
        message: String(
          error?.error_chain_str ||
          error?.message ||
          error?.error ||
          "The Prime rollout stopped with an error."
        ).trim(),
        stop_condition: String(info.stop_condition || "has_error")
      };
      break;
    }
    if (!value && localResultsPath && fs.existsSync(localResultsPath)) {
      try {
        const firstLine = fs.readFileSync(localResultsPath, "utf8").split(/\r?\n/).find((line) => line.trim());
        const result = firstLine ? JSON.parse(firstLine) : null;
        const errors = Array.isArray(result?.errors) ? result.errors : [];
        if (errors.length || ["error", "has_error"].includes(String(result?.stop_condition || ""))) {
          const error = errors[errors.length - 1] || {};
          const traceback = String(error.traceback || "");
          const providerMatches = [...traceback.matchAll(/openai\.([A-Za-z]+Error):\s*([^\n]+)/g)];
          const providerError = providerMatches[providerMatches.length - 1];
          value = {
            message: providerError
              ? `${providerError[1]}: ${providerError[2]}`
              : [error.type, error.message].filter(Boolean).join(": ") || "The Prime rollout stopped with an error.",
            stop_condition: String(result?.stop_condition || "error")
          };
        }
      } catch (_error) {
        /* a partial result row is not a terminal failure yet */
      }
    }
    primeRolloutFailureCache.set(runId, { signature, value });
    return value;
  }

  function writeRunMeta(runId, meta) {
    const previous = readRunMeta(runId);
    if (
      previous?.status === "running" &&
      ["failed", "finished"].includes(meta?.status) &&
      (
        pidAlive(previous.pid) ||
        (previous.container && dockerRunAlive(runId))
      )
    ) {
      // Never let a stale process/exit observation overwrite visibly active
      // work. The real child exit will retry after its PID/container and output
      // stream are quiet; manual Stop uses its own stopping → stopped path.
      return previous;
    }
    fs.writeFileSync(runMetaPath(runId), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    return meta;
  }

  function pidAlive(pid) {
    if (!pid) {
      return false;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  function activeElapsedMs(meta, now = Date.now()) {
    const stored = Number(meta?.active_elapsed_ms);
    const tracked = Number.isFinite(stored) || Boolean(meta?.active_started_at);

    if (tracked) {
      let elapsed = Number.isFinite(stored) ? Math.max(0, stored) : 0;
      const startedAt = Date.parse(meta.active_started_at || "");
      if (Number.isFinite(startedAt) && ["running", "pausing", "stopping"].includes(meta.status)) {
        elapsed += Math.max(0, now - startedAt);
      }
      return Math.round(elapsed);
    }

    // Existing runs predate active-time tracking. Use their terminal/pause time
    // so their progress UI still has a reasonable historical duration.
    const createdAt = Date.parse(meta?.created_at || "");
    const endedAt = Date.parse(
      meta?.finished_at || meta?.paused_at || (["running", "pausing", "stopping"].includes(meta?.status) ? new Date(now).toISOString() : "")
    );
    return Number.isFinite(createdAt) && Number.isFinite(endedAt) ? Math.max(0, endedAt - createdAt) : 0;
  }

  function terminalRunMeta(meta, status, extras = {}) {
    const finishedAt = extras.finished_at || new Date().toISOString();
    return {
      ...meta,
      ...extras,
      status,
      finished_at: finishedAt,
      active_elapsed_ms: activeElapsedMs(meta, Date.parse(finishedAt)),
      active_started_at: null
    };
  }

  function coldPausedRunMeta(meta, extras = {}) {
    const pausedAt = extras.paused_at || new Date().toISOString();
    return {
      ...meta,
      ...extras,
      status: "paused",
      pid: null,
      pause_reason: "manual",
      pause_mode: "cold",
      paused_at: pausedAt,
      active_elapsed_ms: activeElapsedMs(meta, Date.parse(pausedAt)),
      active_started_at: null
    };
  }

  function progressForRun(meta, turns) {
    const current = Math.max(0, Math.floor(Number(turns) || 0));
    const elapsedMs = activeElapsedMs(meta);
    const averageTurnMs = current > 0 ? elapsedMs / current : null;
    if (meta.unlimited) {
      return {
        current,
        total: null,
        percent: null,
        unlimited: true,
        elapsed_ms: elapsedMs,
        average_turn_ms: averageTurnMs == null ? null : Math.round(averageTurnMs),
        eta_ms: null
      };
    }

    const total = Math.max(1, Math.floor(Number(meta.moves) || 1));
    const rawPercent = (Math.min(current, total) / total) * 100;
    const percent = Math.max(0, Math.min(100, rawPercent));
    const etaMs = meta.status === "running" && averageTurnMs != null
      ? Math.max(0, Math.round(averageTurnMs * Math.max(0, total - current)))
      : null;

    return {
      current,
      total,
      percent: Math.round(percent * 10) / 10,
      elapsed_ms: elapsedMs,
      average_turn_ms: averageTurnMs == null ? null : Math.round(averageTurnMs),
      eta_ms: etaMs
    };
  }

  function autoContinueBudgetTarget(runId, meta) {
    const unlimited = Boolean(meta?.unlimited);
    const quitBlocked = meta?.allow_quit === false;
    const configuredTarget = Number(meta?.auto_continue_target) || (quitBlocked ? Number(meta?.moves) : 0);
    const target = Math.min(MAX_LOCAL_MOVE_BUDGET, Math.floor(configuredTarget || 0));
    if ((!unlimited && !target) || meta?.kind === "prime") return null;

    const turns = readActions(runId).length;
    const segmentStart = Math.max(0, Math.floor(Number(meta.segment_start_turns) || 0));
    const segmentBudget = unlimited
      ? null
      : Math.max(1, Math.floor(Number(meta.segment_move_budget) || Number(meta.moves) || 1));
    const exhaustedSegment = segmentBudget != null && turns - segmentStart >= segmentBudget;
    if (!unlimited && ((!quitBlocked && !exhaustedSegment) || turns >= target)) return null;

    if (unlimited || quitBlocked) {
      const session = loadJson(path.join(runDirFor(runId), "session.json"), null);
      const status = session?.lastStatus || session?.actions?.at?.(-1)?.status || null;
      if (
        Math.max(0, Number(status?.gem_count) || 0) >= GAME_WON_GEM_COUNT ||
        status?.game_lost ||
        status?.quit
      ) return null;
    }

    const conversationId = readConversationId(runId);
    if (
      !conversationId ||
      !(meta.container === false || hasPersistedContainerConversation(runId, meta, conversationId))
    ) return null;

    // Treat the moves already played as the old total so continueLocalInPlace
    // writes the requested target, while its MCP segment receives only the
    // remaining actions. The provider thread and maze session stay unchanged.
    try {
      continueLocalInPlace(
        runId,
        { ...meta, moves: turns },
        unlimited ? null : target - turns,
        conversationId
      );
      return readRunMeta(runId);
    } catch (error) {
      console.error(`Could not auto-continue run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  function finalizeStatus(runId, meta) {
    if (!meta) {
      return meta;
    }

    if (
      ["failed", "finished"].includes(meta.status) &&
      (pidAlive(meta.pid) || (meta.container && dockerRunAlive(runId)))
    ) {
      const { finished_at, exit_code, launch_error, queue_error, ...rest } = meta;
      const revived = {
        ...rest,
        status: "running",
        active_started_at: new Date().toISOString(),
        active_elapsed_ms: Math.max(0, Number(meta.active_elapsed_ms) || 0)
      };
      writeRunMeta(runId, revived);
      return revived;
    }

    if (
      meta.status === "pausing" &&
      !pidAlive(meta.pid) &&
      !liveChildren.has(runId) &&
      !(meta.container && dockerRunAlive(runId))
    ) {
      stopLegacyClaudeSnapshots(runId);
      stopDetachedRunRenderers(runId, { force: true });
      const updated = coldPausedRunMeta(meta);
      writeRunMeta(runId, updated);
      return updated;
    }

    if (meta.status === "stopping" && !pidAlive(meta.pid) && !liveChildren.has(runId)) {
      const updated = terminalRunMeta(meta, meta.auto_quit_triggered ? "finished" : "stopped", {
        exit_code: meta.exit_code ?? null,
        finished_at: meta.finished_at || new Date().toISOString()
      });
      writeRunMeta(runId, updated);
      if (meta.model === "claude") setImmediate(() => startNextWaitingClaudeRun());
      return updated;
    }

    if (
      meta.status !== "running" ||
      pidAlive(meta.pid) ||
      liveChildren.has(runId) ||
      (meta.container && dockerRunAlive(runId)) ||
      runRecentlyActive(runId)
    ) {
      return meta;
    }

    // Detached children can briefly be absent from the process table while
    // launch wrappers settle. The attached exit handler is authoritative in a
    // live server; this recovery path is for genuinely orphaned metadata after
    // a restart, so never fail a brand-new run on a single early probe.
    const createdAt = Date.parse(meta.created_at || "");
    if (Number.isFinite(createdAt) && Date.now() - createdAt < RUNNER_STARTUP_GRACE_MS) {
      return meta;
    }

    // The process is gone but no exit handler fired (server restarted).
    const providerFailure = readProviderFailure(runId);
    if (providerFailure) {
      const updated = providerBackoffMeta(runId, meta, providerFailure, meta.exit_code ?? null);
      writeRunMeta(runId, updated);
      return updated;
    }

    const succeeded =
      fs.existsSync(path.join(runDirFor(runId), "maze_scorecard.json")) ||
      fs.existsSync(path.join(runDirFor(runId), "scorecard.json"));
    if (succeeded || meta.allow_quit === false) {
      const continued = autoContinueBudgetTarget(runId, meta);
      if (continued) return continued;
    }
    const quota = succeeded ? null : detectQuotaPause(runId);
    const now = new Date().toISOString();
    const updated = quota
      ? {
          ...meta,
          status: "paused",
          pid: null,
          pause_reason: "quota",
          pause_mode: "cold",
          pause_message: quota.message,
          paused_at: meta.paused_at || now,
          active_elapsed_ms: activeElapsedMs(meta, Date.parse(meta.paused_at || now)),
          active_started_at: null
        }
      : terminalRunMeta(meta, succeeded ? "finished" : "failed", { finished_at: meta.finished_at || now });
    writeRunMeta(runId, updated);
    if (meta.model === "claude") {
      setImmediate(() => startNextWaitingClaudeRun());
    }
    return updated;
  }

  function runMetaEntries() {
    if (!fs.existsSync(runsDir)) return [];

    return fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
      .map((entry) => ({ id: entry.name, meta: readRunMeta(entry.name) }))
      .filter((entry) => entry.meta);
  }

  function waitingClaudeRuns(excludeRunId = "") {
    return runMetaEntries()
      .filter((entry) => entry.id !== excludeRunId && entry.meta.model === "claude" && entry.meta.status === "waiting")
      .sort((left, right) => {
        const orderDifference = Number(left.meta.queue_order || 0) - Number(right.meta.queue_order || 0);
        return orderDifference || String(left.meta.created_at || "").localeCompare(String(right.meta.created_at || ""));
      });
  }

  function startWaitingClaudeRun(runId) {
    const meta = readRunMeta(runId);
    if (!meta || meta.model !== "claude" || meta.status !== "waiting") return null;

    const args = Array.isArray(meta.queued_args) ? meta.queued_args : [];
    if (!args.length) {
      writeRunMeta(runId, terminalRunMeta(meta, "failed", { queue_error: "Queued launch arguments are missing." }));
      setImmediate(() => startNextWaitingClaudeRun());
      return summarizeRun(runId);
    }

    const logFd = fs.openSync(path.join(runDirFor(runId), "launcher.log"), "a");
    let child;
    try {
      child = spawn(process.execPath, [runnerScript, ...args], {
        cwd: rootDir,
        detached: true,
        env: localLaunchEnvironment(meta.launch_params),
        stdio: ["ignore", logFd, logFd]
      });
    } catch (error) {
      writeRunMeta(
        runId,
        terminalRunMeta(meta, "failed", { queue_error: error instanceof Error ? error.message : String(error) })
      );
      setImmediate(() => startNextWaitingClaudeRun());
      return summarizeRun(runId);
    } finally {
      fs.closeSync(logFd);
    }

    const startedAt = new Date().toISOString();
    writeRunMeta(runId, {
      ...meta,
      status: "running",
      pid: child.pid,
      queue_started_at: startedAt,
      active_started_at: startedAt,
      active_elapsed_ms: activeElapsedMs(meta)
    });
    attachRunChild(runId, child);
    return summarizeRun(runId);
  }

  function startNextWaitingClaudeRun() {
    if (!allowLegacyLocalLaunch) return null;
    if (startingClaudeQueue) return null;
    startingClaudeQueue = true;

    try {
      const waiting = waitingClaudeRuns();
      waiting.forEach((entry) => startWaitingClaudeRun(entry.id));
      return waiting.length ? summarizeRun(waiting[waiting.length - 1].id) : null;
    } finally {
      startingClaudeQueue = false;
    }
  }

  function readActions(runId, afterTurn = 0) {
    const actionsPath = path.join(runDirFor(runId), "actions.jsonl");

    if (!fs.existsSync(actionsPath)) {
      actionCache.delete(runId);
      return [];
    }

    const stat = fs.statSync(actionsPath);
    let cached = actionCache.get(runId);
    const canAppend = Boolean(cached && stat.ino === cached.ino && stat.size >= cached.size);

    if (!canAppend || (cached && stat.size === cached.size && stat.mtimeMs !== cached.mtimeMs)) {
      cached = null;
    }

    if (!cached || stat.size > cached.size) {
      const start = cached?.size || 0;
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(actionsPath, "r");
      try {
        if (length) fs.readSync(fd, buffer, 0, length, start);
      } finally {
        fs.closeSync(fd);
      }

      const records = cached?.records || [];
      const text = `${cached?.remainder || ""}${buffer.toString("utf8")}`;
      const lines = text.split("\n");
      const remainder = text.endsWith("\n") ? "" : lines.pop() || "";

      lines.filter(Boolean).forEach((line) => {
        let record;
        try {
          record = JSON.parse(line);
        } catch (_error) {
          return;
        }
        if (!record) return;

        // Only the newest action needs its full observation for the live board.
        // Keeping a 64x64 board on every historical row made large progress
        // responses tens of megabytes and retained the same data in memory.
        const previous = records[records.length - 1];
        if (previous) {
          delete previous.level;
          delete previous.json_observation;
          delete previous.json_display_palette;
        }
        records.push({
        turn: record.turn,
        timestamp: normalizeEventTimestamp(record.timestamp || record.recorded_at || record.created_at),
        board_state_hash: record.status?.board_state_hash || null,
        board_state_hash_version: Number(record.status?.board_state_hash_version) || null,
        command_text: record.command_text,
        moved: record.status?.moved,
        gem_count: record.status?.gem_count,
        game_won: Math.max(0, Number(record.status?.gem_count) || 0) >= GAME_WON_GEM_COUNT,
        game_lost: Boolean(record.status?.game_lost),
        quit: Boolean(record.status?.quit),
        current_room: record.status?.current_room,
        player: record.status?.player || null,
        player_dead: Boolean(record.status?.player_dead),
        valid: record.valid !== false && !record.error,
        error: record.error || null,
        level: record.status?.level || null,
        json_observation: record.status?.json_observation || null,
        json_display_palette: record.status?.json_display_palette || null
        });
      });

      cached = { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, records, remainder };
      actionCache.set(runId, cached);
    }

    const threshold = Number(afterTurn) || 0;
    return threshold > 0
      ? cached.records.filter((record) => Number(record.turn) > threshold)
      : cached.records;
  }

  function readInitialPlayer(runId) {
    if (initialPlayerCache.has(runId)) return initialPlayerCache.get(runId);
    const runDir = runDirFor(runId);
    const initialStatus = loadJson(path.join(runDir, "initial-status.json"), null);
    // Older runs predate initial-status.json. Parse their session once so the
    // heatmap still includes move zero without making every poll pay that cost.
    const status = initialStatus || loadJson(path.join(runDir, "session.json"), null)?.initial || null;
    const player = normalizedPlayerPosition(status?.player);
    if (!player) return null;
    initialPlayerCache.set(runId, player);
    return player;
  }

  function normalizedPlayerPosition(value) {
    const x = Number(value?.x);
    const y = Number(value?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const player = { x, y };
    const elevation = Number(value?.elevation);
    if (Number.isFinite(elevation)) player.elevation = elevation;
    return player;
  }

  function readInitialBoardStateHash(runId) {
    const runDir = runDirFor(runId);
    const initialStatus = loadJson(path.join(runDir, "initial-status.json"), null);
    const status = initialStatus || loadJson(path.join(runDir, "session.json"), null)?.initial || null;
    return String(status?.board_state_hash || "");
  }

  function readInitialBoardStateHashVersion(runId) {
    const runDir = runDirFor(runId);
    const initialStatus = loadJson(path.join(runDir, "initial-status.json"), null);
    const status = initialStatus || loadJson(path.join(runDir, "session.json"), null)?.initial || null;
    return Number(status?.board_state_hash_version) || 0;
  }

  function primeResumeCheckpointPath(runId) {
    return path.join(runDirFor(runId), PRIME_RESUME_CHECKPOINT_FILE);
  }

  function primeInitialStatus(meta) {
    const argv = [
      path.join(rootDir, "scripts", "maze-bridge.js"),
      "--level",
      String(meta.level_id || "level_HxI"),
      "--game-won-gem-count",
      String(GAME_WON_GEM_COUNT)
    ];
    if (meta.hide_names) {
      argv.push("--hide-names", "--hide-names-seed", String(meta.hide_names_seed || "1"));
    }
    const result = spawnSync(process.execPath, argv, {
      cwd: rootDir,
      encoding: "utf8",
      input: `${JSON.stringify({ command: "observe" })}\n`,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024
    });
    if (result.status !== 0) {
      throw new Error(String(result.stderr || "Could not reconstruct Prime move zero.").trim());
    }
    const payload = JSON.parse(result.stdout);
    return {
      allowed_commands: payload.allowed_commands || [],
      board_state_hash: payload.board_state_hash || null,
      board_state_hash_version: Number(payload.board_state_hash_version) || BOARD_STATE_HASH_VERSION,
      current_room: payload.current_room || meta.level_id || "level_HxI",
      current_view: payload.current_view || "top-diagonal",
      gem_count: 0,
      level: payload.level || "",
      player: payload.player || null,
      player_dead: Boolean(payload.player_dead),
      visited_levels: payload.visited_levels || [payload.current_room || meta.level_id || "level_HxI"],
      yaw: Number(payload.yaw) || 0
    };
  }

  function ensurePrimeResumeCheckpoint(runId) {
    const meta = readRunMeta(runId);
    if (!meta || meta.kind !== "prime") {
      throw new Error("Only Prime Intellect runs use Verifiers checkpoints.");
    }
    if (meta.prime_execution === "hosted") {
      throw new Error("Prime Hosted Evaluations cannot resume a local Verifiers checkpoint.");
    }
    const existing = primeResumeCheckpointPath(runId);
    if (fileHasContent(existing)) return existing;
    const initialStatus = loadJson(path.join(runDirFor(runId), "initial-status.json"), null) || primeInitialStatus(meta);
    if (!fileHasContent(path.join(runDirFor(runId), "initial-status.json"))) {
      fs.writeFileSync(
        path.join(runDirFor(runId), "initial-status.json"),
        `${JSON.stringify(initialStatus, null, 2)}\n`,
        "utf8"
      );
    }
    const { checkpoint, path: checkpointPath } = writePrimeResumeCheckpoint(runDirFor(runId), {
      initialStatus,
      sourceRunId: runId
    });
    writeRunMeta(runId, {
      ...meta,
      resume_checkpoint_ready: true,
      resume_action_count: checkpoint.action_count
    });
    return checkpointPath;
  }

  function autoQuitConfigForMeta(meta) {
    const params = meta?.launch_params && typeof meta.launch_params === "object"
      ? { ...meta.launch_params }
      : {};
    for (const key of ["auto_quit", "auto_quit_threshold", "auto_quit_mode", "auto_quit_window"]) {
      if (meta && Object.prototype.hasOwnProperty.call(meta, key)) params[key] = meta[key];
    }
    return normalizeAutoQuitConfig(params);
  }

  function stopAutoQuitMonitor(runId) {
    const timer = autoQuitMonitors.get(runId);
    if (timer) clearInterval(timer);
    autoQuitMonitors.delete(runId);
  }

  function autoQuitEvaluation(runId, meta) {
    const config = autoQuitConfigForMeta(meta);
    if (!config.enabled) return null;
    const actions = readActions(runId);
    const last = actions[actions.length - 1];
    if (
      Math.max(0, Number(last?.gem_count) || 0) >= GAME_WON_GEM_COUNT ||
      last?.quit
    ) return null;
    let initialHash = readInitialBoardStateHash(runId);
    let evaluationActions = actions;
    const legacyBoardStateHashes = readInitialBoardStateHashVersion(runId) !== BOARD_STATE_HASH_VERSION ||
      actions.some((action) => action.board_state_hash_version !== BOARD_STATE_HASH_VERSION);
    if (legacyBoardStateHashes) {
      const reconstructed = reconstructBoardStateTimeline(runId, meta);
      if (reconstructed) {
        initialHash = reconstructed.initial_hash;
        evaluationActions = actions.map((action) => ({
          ...action,
          board_state_hash: reconstructed.hashes.get(Number(action.turn)) || action.board_state_hash,
          board_state_hash_version: reconstructed.hash_version
        }));
      }
    }
    return evaluateAutoQuit(initialHash, evaluationActions, config);
  }

  function forceAutoQuitShutdown(runId) {
    const current = readRunMeta(runId);
    if (!current?.auto_quit_triggered || current.status !== "stopping") return;
    if (current.container) {
      try {
        dockerRunControl(runId, ["rm", "-f"], "auto-quit", { required: false });
      } catch (_error) {
        /* already removed */
      }
    }
    signalRunProcess(current, "SIGKILL");
  }

  function triggerAutoQuit(runId, meta, evaluation) {
    const triggeredAt = new Date().toISOString();
    const updated = {
      ...meta,
      status: "stopping",
      auto_quit_triggered: true,
      auto_quit_triggered_at: triggeredAt,
      auto_quit_percentage: evaluation.percentage,
      auto_quit_novel_states: evaluation.novel_states,
      auto_quit_observed_states: evaluation.observed_states,
      auto_quit_action_count: evaluation.action_count
    };
    writeRunMeta(runId, updated);
    stopAutoQuitMonitor(runId);
    if (meta.kind === "prime") {
      cancelPrimeEvaluation(runId);
      stopPrimeAgentSandboxes(runId);
    }
    stopLegacyClaudeSnapshots(runId);
    stopDetachedRunRenderers(runId, { force: true });

    if (meta.container) {
      try {
        dockerRunControl(runId, ["stop", "-t", "2"], "auto-quit", { required: false });
      } catch (_error) {
        /* the force-shutdown fallback below reaps a surviving container */
      }
    }
    signalRunProcess(meta, "SIGTERM");
    const forceTimer = setTimeout(() => forceAutoQuitShutdown(runId), 3000);
    forceTimer.unref?.();
    return updated;
  }

  function maybeAutoQuitRun(runId) {
    const meta = readRunMeta(runId);
    if (!meta || meta.status !== "running" || meta.auto_quit_triggered) return meta;
    const evaluation = autoQuitEvaluation(runId, meta);
    return evaluation ? triggerAutoQuit(runId, meta, evaluation) : meta;
  }

  function startAutoQuitMonitor(runId) {
    if (autoQuitMonitors.has(runId)) return;
    const meta = readRunMeta(runId);
    if (!meta || meta.status !== "running" || !autoQuitConfigForMeta(meta).enabled) return;
    const timer = setInterval(() => {
      const current = maybeAutoQuitRun(runId);
      if (!current || current.status !== "running") stopAutoQuitMonitor(runId);
    }, 500);
    timer.unref?.();
    autoQuitMonitors.set(runId, timer);
    maybeAutoQuitRun(runId);
  }

  function readPrimeLiveTurns(runDir) {
    const usagePath = path.join(runDir, "prime-usage.jsonl");
    if (!fs.existsSync(usagePath)) return 0;

    return fs
      .readFileSync(usagePath, "utf8")
      .split(/\r?\n/)
      .reduce((highest, line) => {
        if (!line.trim()) return highest;
        try {
          return Math.max(highest, Number(JSON.parse(line).turn) || 0);
        } catch (_error) {
          return highest;
        }
      }, 0);
  }

  function readLogChunk(runId, offset = 0) {
    const logPath = path.join(runDirFor(runId), "launcher.log");

    if (!fs.existsSync(logPath)) {
      return { chunk: "", offset: 0 };
    }

    const size = fs.statSync(logPath).size;
    const start = Math.max(0, Math.min(Number(offset) || 0, size));

    if (start >= size) {
      return { chunk: "", offset: size };
    }

    const fd = fs.openSync(logPath, "r");

    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return { chunk: buffer.toString("utf8"), offset: size };
    } finally {
      fs.closeSync(fd);
    }
  }

  function readLogTail(runId, maxBytes = 16 * 1024) {
    const logPath = path.join(runDirFor(runId), "launcher.log");

    if (!fs.existsSync(logPath)) {
      return "";
    }

    const size = fs.statSync(logPath).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(logPath, "r");

    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }

  // When a run exits non-zero we peek at the tail of its log for the tell-tale
  // "you're out of money/credits/usage" messages so we can auto-pause it (and
  // let the user resume once they top up) instead of marking it failed. Kept
  // deliberately specific so a normal error isn't mistaken for a funds problem.
  const QUOTA_PATTERNS = [
    /insufficient (funds|credit|credits|balance|quota)/i,
    /out of (funds|credit|credits)/i,
    /(credit|account) balance is too low/i,
    /add (funds|credits|more credits|to your balance)/i,
    /payment required/i,
    /\b402\b/,
    /quota (exceeded|has been reached|exhausted)/i,
    /you have (hit|reached|exceeded) your (usage|plan) limit/i,
    /usage limit reached/i,
    /(monthly|weekly|daily) (usage )?limit/i,
    /billing (hard|soft) limit/i,
    /exceeded your current quota/i
  ];

  function detectQuotaPause(runId) {
    const tail = readLogTail(runId);

    if (!tail) {
      return null;
    }

    const pattern = QUOTA_PATTERNS.find((regex) => regex.test(tail));

    if (!pattern) {
      return null;
    }

    // Surface the actual offending line so the run page can explain the pause.
    const line = tail
      .split(/\r?\n/)
      .reverse()
      .find((entry) => pattern.test(entry));
    return { reason: "quota", message: (line || "Out of funds/credits/usage.").trim().slice(0, 300) };
  }

  function readProviderFailure(runId) {
    const failure = loadJson(path.join(runDirFor(runId), "provider-failure.json"), null);
    if (!failure || !failure.message) return null;
    return {
      provider: String(failure.provider || "provider"),
      status: Number(failure.status) || null,
      message: String(failure.message).trim().slice(0, 500),
      detected_at: String(failure.detected_at || "")
    };
  }

  function providerRetryDelayMs(failure, attempt) {
    const status = Number(failure?.status) || 0;
    // Authentication/socket failures and explicit rate limits often need a
    // usage-window reset. Gateway errors usually recover much sooner.
    const base = [401, 403, 429].includes(status) ? 5 * 60_000 : 60_000;
    return Math.min(PROVIDER_RETRY_MAX_MS, base * (2 ** Math.max(0, attempt - 1)));
  }

  function providerBackoffMeta(runId, meta, failure, exitCode = null) {
    const turns = readActions(runId).length;
    const madeProgress = turns > Math.max(0, Number(meta.provider_failure_turns) || 0);
    const attempt = madeProgress ? 1 : Math.max(1, Number(meta.provider_retry_attempt) + 1 || 1);
    const delayMs = providerRetryDelayMs(failure, attempt);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    return {
      ...meta,
      status: "paused",
      pid: null,
      pause_reason: "provider_backoff",
      pause_mode: "cold",
      pause_message: failure.message,
      provider_failure_status: failure.status,
      provider_failure_turns: turns,
      provider_retry_attempt: attempt,
      retry_at: new Date(nowMs + delayMs).toISOString(),
      exit_code: exitCode,
      paused_at: now,
      active_elapsed_ms: activeElapsedMs(meta, nowMs),
      active_started_at: null
    };
  }

  function retryProviderBackoff(runId, meta) {
    if (meta?.status !== "paused" || meta.pause_reason !== "provider_backoff") return null;
    if (Date.parse(meta.retry_at || "") > Date.now()) return null;

    const conversationId = readConversationId(runId);
    if (!conversationId) {
      writeRunMeta(runId, {
        ...meta,
        pause_message: `${meta.pause_message || "Provider unavailable."} Automatic retry is waiting for a saved provider thread.`,
        retry_at: new Date(Date.now() + PROVIDER_RETRY_MAX_MS).toISOString()
      });
      return null;
    }

    const turns = readActions(runId).length;
    const add = meta.unlimited ? null : Math.max(1, (Number(meta.moves) || turns + 1) - turns);
    try {
      return continueLocalInPlace(runId, meta, add, conversationId);
    } catch (error) {
      writeRunMeta(runId, {
        ...meta,
        pause_message: error instanceof Error ? error.message : String(error),
        retry_at: new Date(Date.now() + PROVIDER_RETRY_MAX_MS).toISOString()
      });
      return null;
    }
  }

  function retryDueProviderBackoffs() {
    if (!allowLegacyLocalLaunch) return;
    runMetaEntries().forEach(({ id, meta }) => {
      if (meta.status === "paused" && meta.pause_reason === "provider_backoff") {
        retryProviderBackoff(id, meta);
      }
    });
  }

  function resolveClaudeCatalogModelId(modelName) {
    const requested = String(modelName || "").trim();

    if (!requested || !/^[a-z][a-z0-9-]*$/i.test(requested)) {
      return requested;
    }

    const match = listProviderModels("claude").models.find(
      (model) => String(model.id).toLowerCase() === requested.toLowerCase()
    );
    return String(match?.resolved_model_id || requested);
  }

  // Claude Code is launched with a stable alias, but its final result records
  // the exact model id actually used. Prefer that authoritative id so completed
  // run cards never collapse back to an ambiguous "sonnet" or "opus" label.
  function readClaudeRunModelId(runId, requestedModel) {
    if (resolvedRunModels.has(runId)) {
      return resolvedRunModels.get(runId);
    }

    const eventsPath = path.join(runDirFor(runId), "agent-events.jsonl");

    if (!fs.existsSync(eventsPath)) {
      return "";
    }

    const family = String(requestedModel || "").toLowerCase().match(/(?:^|claude-)(fable|opus|sonnet|haiku)(?:-|$)/)?.[1] || "";
    const lines = fs.readFileSync(eventsPath, "utf8").split(/\r?\n/).reverse();

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);
        const usage = event && event.modelUsage;
        if (!usage || typeof usage !== "object") continue;

        const candidates = Object.entries(usage)
          .filter(([id]) => /^claude-[a-z0-9.-]+$/i.test(id))
          .map(([id, stats]) => ({
            id,
            tokens: Number(stats?.outputTokens || 0) + Number(stats?.inputTokens || 0)
          }));
        const familyMatches = family
          ? candidates.filter((candidate) => candidate.id.toLowerCase().includes(`claude-${family}-`))
          : [];
        const selected = (familyMatches.length ? familyMatches : candidates)
          .sort((left, right) => right.tokens - left.tokens)[0];

        if (selected) {
          resolvedRunModels.set(runId, selected.id);
          return selected.id;
        }
      } catch (_error) {
        /* skip partial/non-JSON stream lines */
      }
    }

    return "";
  }

  function resolvedRunModelName(runId, meta) {
    const modelName = String(meta.model_name || meta.model || "");

    if (meta.model !== "claude") {
      return modelName;
    }

    const requested = meta.model_alias || meta.launch_params?.model_name || modelName;
    return readClaudeRunModelId(runId, requested) || resolveClaudeCatalogModelId(requested) || modelName;
  }

  function summarizeRun(runId) {
    let meta = finalizeStatus(runId, readRunMeta(runId));

    if (!meta) {
      return null;
    }

    if (meta.status === "running") {
      meta = maybeAutoQuitRun(runId) || meta;
    }

    const runDir = runDirFor(runId);
    const primeRolloutFailure = meta.kind === "prime" ? readPrimeRolloutFailure(runId) : null;
    if (primeRolloutFailure && meta.status === "finished") {
      meta = {
        ...meta,
        status: "failed",
        rollout_error: primeRolloutFailure.message,
        rollout_stop_condition: primeRolloutFailure.stop_condition
      };
    }

    if (meta.status === "running") {
      startLegacyClaudeSnapshots(runId);
      startAutoQuitMonitor(runId);
    }

    const actions = readActions(runId);
    const last = actions[actions.length - 1] || null;
    let primeEvaluation = meta.kind === "prime" ? readPrimeEvaluation(runId) : null;
    if (primeEvaluation?.sync_status === "syncing" && !primeSyncChildren.has(runId)) {
      primeEvaluation = writePrimeEvaluation(runId, {
        ...primeEvaluation,
        status: "SYNC_FAILED",
        sync_status: "failed",
        sync_completed_at: new Date().toISOString(),
        sync_error: "The MazeBench server restarted while this Prime upload was running. Retry the sync.",
        updated_at: new Date().toISOString()
      });
    }
    const modelName = resolvedRunModelName(runId, meta);
    const scorecard = loadJson(path.join(runDir, "maze_scorecard.json"), null);
    const review = loadJson(path.join(runDir, RUN_REVIEW_FILE), null);
    const runNotes = loadJson(path.join(runDir, RUN_NOTES_FILE), null);
    const observedRooms = new Set(
      [meta.level_id, ...actions.map((action) => action.current_room)].filter(Boolean)
    );
    const scorecardRooms = Number(scorecard?.rooms?.visited);
    const scorecardRoomTotal = Number(scorecard?.rooms?.total);
    const scorecardGemCount = Number(scorecard?.gems?.collected);
    const scorecardGemTotal = Number(scorecard?.gems?.total);
    const scorecardActionCount = Number(scorecard?.actions?.total);
    // A scorecard is a point-in-time snapshot. Continued runs keep the prior
    // file while actions.jsonl resumes growing, so collected/visited values in
    // that file must not override newer live action state. Older terminal
    // scorecards may not record an action total; they remain authoritative once
    // the run can no longer advance.
    const scorecardStatsCurrent = Number.isFinite(scorecardActionCount)
      ? scorecardActionCount === actions.length
      : ["finished", "stopped", "failed"].includes(meta.status);
    // Prime's evaluator may sample several graph branches for one committed
    // environment move. Only committed actions are user-visible turns.
    const turns = actions.length;
    const game = getGame(meta.game_id);
    const defaultLevelId = game ? worldMaps.defaultLevelIdForGame(game) : "";
    const instanceMetrics = readInstanceMetrics(runId);
    const gemCount = scorecardStatsCurrent && Number.isFinite(scorecardGemCount)
      ? scorecardGemCount
      : Math.max(0, Number(last?.gem_count) || 0);
    const gemTotal = Number.isFinite(scorecardGemTotal)
      ? scorecardGemTotal
      : Number.isFinite(Number(meta.gem_total))
        ? Number(meta.gem_total)
        : null;
    const complete = collectedAllWorldGems(gemCount, gemTotal);

    const hasVideo = fs.existsSync(path.join(runDir, "maze_replay.mp4"));
    const storedVideoStatus =
      meta.video_status === "rendering" && !videoChildren.has(runId) && !pidAlive(meta.video_pid)
        ? "failed"
        : meta.video_status;
    const videoStatus = hasVideo
      ? "ready"
      : videoChildren.has(runId) || (meta.video_status === "rendering" && pidAlive(meta.video_pid))
        ? "rendering"
        : storedVideoStatus || (meta.video && ["finished", "stopped", "failed"].includes(meta.status) ? "failed" : "idle");

    return {
      ...meta,
      model_name: modelName,
      turns,
      auxiliary_actions: instanceMetrics.auxiliary_actions,
      auxiliary_action_attempts: instanceMetrics.auxiliary_action_attempts,
      simulated_actions: turns + instanceMetrics.auxiliary_actions,
      explorer_instances: instanceMetrics.instances,
      gem_count: gemCount,
      gem_total: gemTotal,
      room_count: scorecardStatsCurrent && Number.isFinite(scorecardRooms) ? scorecardRooms : observedRooms.size,
      room_total: Number.isFinite(scorecardRoomTotal) ? scorecardRoomTotal : meta.room_total ?? null,
      progress: progressForRun(meta, turns),
      start_room_is_default: Boolean(defaultLevelId && meta.level_id === defaultLevelId),
      current_room: last ? last.current_room : meta.level_id,
      complete,
      has_video: hasVideo,
      video_status: videoStatus,
      has_reasoning: fs.existsSync(path.join(runDir, "reasoning.json")),
      favorited: isRunFavorite(runId),
      run_notes: String(runNotes?.notes || ""),
      run_notes_updated_at: runNotes?.updated_at || null,
      review_status: String(review?.status || "idle"),
      review_provider: String(review?.provider || ""),
      review_model: String(review?.model || ""),
      review_reasoning: String(review?.reasoning || ""),
      review_error: String(review?.error || ""),
      review_ready: Boolean(review?.status === "completed" && review?.review),
      reviewable:
        ["paused", "finished", "stopped", "failed"].includes(meta.status) &&
        fileHasContent(path.join(runDir, "actions.jsonl")),
      prime_evaluation_id: String(primeEvaluation?.evaluation_id || primeEvaluation?.id || ""),
      prime_evaluation_status: String(primeRolloutFailure ? "FAILED" : primeEvaluation?.status || ""),
      prime_evaluation_sync_status: String(primeEvaluation?.sync_status || ""),
      prime_evaluation_sync_error: String(primeEvaluation?.sync_error || ""),
      prime_evaluation_syncable:
        meta.kind === "prime" &&
        meta.prime_execution !== "hosted" &&
        ["paused", "finished", "stopped", "failed"].includes(meta.status) &&
        fileHasContent(findPrimeResultsFile(runDir)),
      prime_evaluation_url: String(
        primeEvaluation?.viewer_url ||
        (primeEvaluation?.evaluation_id
          ? `https://app.primeintellect.ai/dashboard/evaluations/${primeEvaluation.evaluation_id}`
          : "")
      ),
      prime_evaluation_score:
        Number.isFinite(Number(primeEvaluation?.avg_score)) ? Number(primeEvaluation.avg_score) : null,
      // Grouping key for the runs-list provider filter (codex | claude | kimi | prime).
      provider: meta.kind === "prime" ? "prime" : meta.model,
      pausable:
        ["running", "pausing"].includes(meta.status) &&
        meta.kind !== "prime" &&
        (meta.container === false || Boolean(runContainerId(runId))),
      resumable:
        (meta.status === "paused" && (meta.kind !== "prime" || meta.prime_execution !== "hosted")) ||
        (meta.kind === "prime" &&
          meta.prime_execution !== "hosted" &&
          meta.status === "failed" &&
          (actions.length === 0 || fileHasContent(primeResumeCheckpointPath(runId)))),
      continuable:
        !meta.auto_quit_triggered &&
        (meta.status === "finished" || meta.status === "stopped"),
      branchable:
        meta.kind !== "prime" &&
        ["codex", "claude"].includes(meta.model) &&
        !meta.swarm &&
        ["paused", "finished", "stopped", "failed"].includes(meta.status),
      url: `/agent/runs/${encodeURIComponent(runId)}`
    };
  }

  function allRunSummaries() {
    if (!fs.existsSync(runsDir)) {
      return [];
    }

    return fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
      .map((entry) => summarizeRun(entry.name))
      .filter(Boolean)
      .sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")));
  }

  // The runs page usually shows only five recent cards. Reading and parsing every
  // historical actions.jsonl before slicing that page made initial load scale
  // with the lifetime of the installation rather than the number of visible
  // cards. Keep filtering/pagination on tiny run.json records, then deeply
  // summarize only the requested page. Metric sorts still use full summaries
  // because their ordering genuinely depends on replay-derived data.
  function lightweightRunRecords() {
    if (!fs.existsSync(runsDir)) return [];

    return fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
      .flatMap((entry) => {
        const raw = readRunMeta(entry.name);
        if (!raw) return [];
        const meta = ["running", "pausing", "stopping"].includes(raw.status)
          ? finalizeStatus(entry.name, raw)
          : raw;
        return [{
          id: entry.name,
          created_at: meta.created_at || entry.name,
          game_id: meta.game_id || "",
          game_title: meta.game_title || "",
          model: meta.model || "",
          model_name: meta.model_name || meta.model || "",
          provider: meta.kind === "prime" ? "prime" : meta.model,
          status: meta.status || "",
          favorited: isRunFavorite(entry.name)
        }];
      })
      .sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")));
  }

  // Paginated, filterable, sortable runs listing. Returns the requested page plus
  // the totals and the facet lists (providers/models present across ALL runs) so
  // the UI can offer stable filter dropdowns. With no options it behaves like the
  // old full list (page 1), so existing callers keep working.
  function listRuns(options = {}) {
    const provider = String(options.provider || "").trim();
    const model = String(options.model || "").trim();
    const status = String(options.status || "").trim();
    const starred = options.starred === true || String(options.starred || "") === "1";
    const query = String(options.query || "").trim().toLowerCase();
    const sort = String(options.sort || "newest");
    const metricSort = ["actions", "rooms", "gems"].includes(sort);
    const all = metricSort ? allRunSummaries() : lightweightRunRecords();

    const providers = [...new Set(all.map((run) => run.provider).filter(Boolean))].sort();
    const models = [...new Set(all.map((run) => run.model_name).filter(Boolean))].sort();
    const standardStatuses = ["waiting", "running", "paused", "stopping", "stopped", "finished", "failed"];
    const extraStatuses = [...new Set(all.map((run) => run.status).filter(Boolean))]
      .filter((value) => !standardStatuses.includes(value))
      .sort();
    const statuses = [...standardStatuses, ...extraStatuses];

    let filtered = all;

    if (provider) {
      filtered = filtered.filter((run) => run.provider === provider);
    }

    if (model) {
      filtered = filtered.filter((run) => (run.model_name || "") === model);
    }

    if (status) {
      filtered = filtered.filter((run) => run.status === status);
    }

    if (starred) {
      filtered = filtered.filter((run) => run.favorited);
    }

    if (query) {
      filtered = filtered.filter((run) =>
        [run.id, run.model, run.model_name, run.provider, run.game_title, run.game_id, run.status]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query)
      );
    }

    if (sort === "oldest") {
      filtered = [...filtered].reverse();
    } else if (metricSort) {
      const key = { actions: "turns", rooms: "room_count", gems: "gem_count" }[sort];
      filtered = [...filtered].sort((left, right) => {
        const difference = (Number(right[key]) || 0) - (Number(left[key]) || 0);
        return difference || String(right.created_at || "").localeCompare(String(left.created_at || ""));
      });
    }

    const total = filtered.length;
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(options.pageSize) || 10)));
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.max(1, Math.min(pages, Math.floor(Number(options.page) || 1)));
    const start = (page - 1) * pageSize;

    const pageRows = filtered.slice(start, start + pageSize);
    const runs = metricSort
      ? pageRows
      : pageRows.map((record) => summarizeRun(record.id)).filter(Boolean);

    return {
      runs,
      total,
      page,
      pages,
      page_size: pageSize,
      providers,
      models,
      statuses,
      active: all.some((run) => ["waiting", "running", "pausing", "stopping"].includes(run.status))
    };
  }

  // Per-move reasoning, live. reasoning.json exists only once the run finishes;
  // while it runs we distill the streamed agent-events.jsonl on the fly so the
  // web UI shows each move's thoughts as they arrive.
  function readReasoningUncached(runId, model) {
    const runDir = runDirFor(runId);
    const finalPath = path.join(runDir, "reasoning.json");
    const finalReasoning = fs.existsSync(finalPath) ? loadJson(finalPath, []) : [];
    const executedMoves = readActions(runId).length;
    const alignToMoves = (entries) => entries.filter(
      (entry) => !Number(entry?.move) || Number(entry.move) <= executedMoves
    );

    if (model === "prime") {
      const livePath = path.join(runDir, "prime-reasoning.jsonl");
      const liveReasoning = fs.existsSync(livePath)
        ? fs.readFileSync(livePath, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch (_error) {
              return [];
            }
          })
        : [];
      const selected = finalReasoning.length ? finalReasoning : liveReasoning;
      const usageByMove = new Map(readJsonLineTail(path.join(runDir, "prime-usage.jsonl"))
        .map((entry) => [Number(entry?.turn ?? entry?.move), entry])
        .filter(([move]) => Number.isFinite(move) && move > 0));
      const selectedMoves = new Set();
      const withTimestamps = selected.map((entry) => {
        const move = Number(entry?.move);
        if (Number.isFinite(move) && move > 0) selectedMoves.add(move);
        return {
          ...entry,
          timestamp: normalizeEventTimestamp(
            entry?.timestamp || usageByMove.get(move)?.recorded_at || entry?.recorded_at
          )
        };
      });
      usageByMove.forEach((usage, move) => {
        if (!selectedMoves.has(move)) {
          withTimestamps.push({
            move,
            timestamp: normalizeEventTimestamp(usage?.recorded_at || usage?.timestamp)
          });
        }
      });
      return alignToMoves(withTimestamps.sort((left, right) => Number(left.move) - Number(right.move)));
    }

    const eventsPath = path.join(runDir, "agent-events.jsonl");

    if (!fs.existsSync(eventsPath)) {
      return alignToMoves(finalReasoning);
    }

    try {
      const raw = fs.readFileSync(eventsPath, "utf8");
      const distilled = model === "claude"
        ? distillClaudeEvents(raw)
        : model === "kimi"
          ? distillKimiEvents(raw)
          : distillCodexEvents(raw);
      const liveReasoning = distilled.entries || [];
      const liveWithText = liveReasoning.filter((entry) => entry.reasoning).length;
      const finalWithText = finalReasoning.filter((entry) => entry.reasoning).length;
      const selected = liveReasoning.length > finalReasoning.length || liveWithText > finalWithText
        ? liveReasoning
        : finalReasoning;
      // Older reasoning.json files predate action timestamps. Merge the live
      // provider event timestamp by move so historical runs gain timestamps
      // without rewriting their preserved artifacts.
      const liveByMove = new Map(liveReasoning.map((entry) => [Number(entry.move), entry]));
      return alignToMoves(selected.map((entry) => ({
        ...entry,
        timestamp: entry.timestamp || liveByMove.get(Number(entry.move))?.timestamp || null
      })));
    } catch (error) {
      return alignToMoves(finalReasoning);
    }
  }

  function readReasoning(runId, model, status = "") {
    const runDir = runDirFor(runId);
    const signature = [
      model,
      fileStamp(path.join(runDir, "reasoning.json")),
      fileStamp(path.join(runDir, "prime-reasoning.jsonl")),
      fileStamp(path.join(runDir, "prime-usage.jsonl")),
      fileStamp(path.join(runDir, "agent-events.jsonl")),
      fileStamp(path.join(runDir, "actions.jsonl"))
    ].join("|");
    const cached = reasoningCache.get(runId);
    if (cached?.signature === signature) return cached.value;

    // Reasoning is supplemental telemetry. Re-distilling a growing provider
    // stream can mean parsing tens of megabytes, so do it at a human-readable
    // cadence instead of on every 1.5 second run-page poll.
    const active = ["running", "pausing", "stopping"].includes(status);
    const expensive = fileSize(path.join(runDir, "agent-events.jsonl")) > LARGE_TELEMETRY_BYTES;
    if (active && expensive && cached && Date.now() - cached.checkedAt < LARGE_TELEMETRY_REFRESH_MS) {
      return cached.value;
    }

    const value = readReasoningUncached(runId, model);
    reasoningCache.set(runId, { signature, checkedAt: Date.now(), value });
    return value;
  }

  function readJsonLineTail(filePath, maxBytes = 8 * 1024 * 1024) {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.size) return [];
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(filePath, "r");
      try {
        fs.readSync(fd, buffer, 0, length, stat.size - length);
      } finally {
        fs.closeSync(fd);
      }
      const lines = buffer.toString("utf8").split(/\r?\n/);
      if (length < stat.size) lines.shift();
      return lines.flatMap((line) => {
        if (!line.trim()) return [];
        try {
          return [JSON.parse(line)];
        } catch (_error) {
          return [];
        }
      });
    } catch (_error) {
      return [];
    }
  }

  function normalizedPythonResult(value) {
    if (value === null || value === undefined) return null;
    let candidate = value;
    for (let depth = 0; depth < 5; depth += 1) {
      if (typeof candidate === "string") {
        try {
          candidate = JSON.parse(candidate);
          continue;
        } catch (_error) {
          return { stdout: candidate, stderr: "", exit_code: null, timed_out: false, output_truncated: false };
        }
      }
      if (Array.isArray(candidate)) {
        const text = candidate.find((entry) => entry?.type === "text")?.text;
        if (text !== undefined) {
          candidate = text;
          continue;
        }
      }
      if (!candidate || typeof candidate !== "object") return null;
      if (candidate.structured_content || candidate.structuredContent) {
        candidate = candidate.structured_content || candidate.structuredContent;
        continue;
      }
      if (candidate.content) {
        candidate = candidate.content;
        continue;
      }
      if (candidate.result && !Object.prototype.hasOwnProperty.call(candidate, "exit_code")) {
        candidate = candidate.result;
        continue;
      }
      break;
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    return {
      exit_code: Number.isInteger(candidate.exit_code) ? candidate.exit_code : null,
      stdout: String(candidate.stdout || ""),
      stderr: String(candidate.stderr || ""),
      cpu_time_ms: candidate.cpu_time_ms !== null
        && candidate.cpu_time_ms !== undefined
        && Number.isFinite(Number(candidate.cpu_time_ms))
        ? Math.max(0, Number(candidate.cpu_time_ms))
        : null,
      timed_out: Boolean(candidate.timed_out),
      output_truncated: Boolean(candidate.output_truncated)
    };
  }

  function pythonToolName(value) {
    return /(?:^|__)python_exec$/.test(String(value || ""));
  }

  function pythonExecutionsFromProviderEvents(events, provider) {
    const executions = new Map();
    const started = (id, values = {}) => {
      const key = String(id || `python-${executions.size + 1}`);
      executions.set(key, {
        ...(executions.get(key) || {}),
        id: `provider-${key}`,
        provider_id: key,
        workspace_id: "primary",
        actor: "lead",
        status: "running",
        ...values
      });
    };
    const completed = (id, values = {}) => {
      const key = String(id || "");
      if (!key || !executions.has(key)) return;
      const previous = executions.get(key);
      executions.set(key, {
        ...previous,
        status: values.status || "completed",
        ...values
      });
    };

    if (provider === "codex") {
      events.forEach((event) => {
        const item = event.item;
        if (item?.type !== "mcp_tool_call" || !pythonToolName(item.tool || item.name)) return;
        const timestamp = normalizeEventTimestamp(event._mazebench_received_at || event.timestamp);
        if (event.type === "item.started") {
          started(item.id, {
            code: String(item.arguments?.code || ""),
            timeout_seconds: Number(item.arguments?.timeout_seconds) || 10,
            started_at: timestamp
          });
        } else if (event.type === "item.completed") {
          if (!executions.has(String(item.id || ""))) {
            started(item.id, {
              code: String(item.arguments?.code || ""),
              timeout_seconds: Number(item.arguments?.timeout_seconds) || 10,
              started_at: timestamp
            });
          }
          completed(item.id, {
            completed_at: timestamp,
            status: item.status === "failed" || item.error ? "failed" : "completed",
            error: item.error ? String(item.error?.message || item.error) : "",
            result: normalizedPythonResult(item.result || item.output || item.content)
          });
        }
      });
    } else if (provider === "claude") {
      events.forEach((event) => {
        const timestamp = normalizeEventTimestamp(event._mazebench_received_at || event.timestamp);
        if (event.type === "assistant" && Array.isArray(event.message?.content)) {
          event.message.content.forEach((block) => {
            if (block?.type !== "tool_use" || !pythonToolName(block.name)) return;
            started(block.id, {
              code: String(block.input?.code || ""),
              timeout_seconds: Number(block.input?.timeout_seconds) || 10,
              started_at: timestamp
            });
          });
        } else if (event.type === "user" && Array.isArray(event.message?.content)) {
          event.message.content.forEach((block) => {
            if (block?.type !== "tool_result") return;
            completed(block.tool_use_id, {
              completed_at: timestamp,
              status: block.is_error ? "failed" : "completed",
              error: block.is_error ? toolResultText(block.content) : "",
              result: block.is_error ? null : normalizedPythonResult(block.content)
            });
          });
        }
      });
    } else if (provider === "kimi") {
      events.forEach((event) => {
        const timestamp = normalizeEventTimestamp(event._mazebench_received_at || event.timestamp);
        if (event.role === "assistant") {
          for (const call of Array.isArray(event.tool_calls) ? event.tool_calls : []) {
            const fn = call.function || call;
            if (!pythonToolName(fn.name || call.name)) continue;
            let input = fn.arguments ?? call.arguments ?? call.input ?? {};
            if (typeof input === "string") {
              try {
                input = JSON.parse(input);
              } catch (_error) {
                input = {};
              }
            }
            started(call.id, {
              code: String(input.code || ""),
              timeout_seconds: Number(input.timeout_seconds) || 10,
              started_at: timestamp
            });
          }
        } else if (event.role === "tool") {
          const failed = event.is_error === true || Boolean(event.error);
          completed(event.tool_call_id || event.id, {
            completed_at: timestamp,
            status: failed ? "failed" : "completed",
            error: failed ? toolResultText(event.content ?? event.output ?? event.result) : "",
            result: failed ? null : normalizedPythonResult(event.content ?? event.output ?? event.result)
          });
        }
      });
    }

    return [...executions.values()].map((execution) => ({
      ...execution,
      duration_ms: execution.completed_at && execution.started_at
        ? Math.max(0, Date.parse(execution.completed_at) - Date.parse(execution.started_at))
        : 0
    }));
  }

  function readPythonExecutionsUncached(runId, summary) {
    const runDir = runDirFor(runId);
    const activityEntries = readJsonLineTail(path.join(runDir, "tool-activity.jsonl"), 32 * 1024 * 1024);
    const activityById = new Map();
    activityEntries.forEach((entry, index) => {
      if (entry.tool !== "python_exec") return;
      const id = String(entry.id || `legacy-${index}`);
      activityById.set(id, { ...(activityById.get(id) || {}), ...entry, id });
    });
    const activityExecutions = [...activityById.values()]
      .sort((left, right) => Date.parse(left.started_at || "") - Date.parse(right.started_at || ""))
      .map((entry) => ({
        id: entry.id,
        workspace_id: String(entry.clone_id || "primary"),
        actor: entry.clone_id ? `instance · ${entry.clone_id}` : entry.actor || "lead",
        code: typeof entry.python_code === "string" ? entry.python_code : "",
        code_hash: String(entry.python_code_hash || ""),
        timeout_seconds: Number(entry.timeout_seconds) || 10,
        started_at: normalizeEventTimestamp(entry.started_at),
        completed_at: normalizeEventTimestamp(entry.completed_at),
        duration_ms: Math.max(0, Number(entry.duration_ms) || 0),
        status: entry.status || "completed",
        error: String(entry.error || ""),
        result: normalizedPythonResult(entry.python_result),
        workspace_changes: entry.workspace_changes || null
      }));

    const needsProviderFallback = !activityExecutions.length || activityExecutions.some((entry) => !entry.code);
    const providerExecutions = needsProviderFallback
      ? pythonExecutionsFromProviderEvents(
          readJsonLineTail(path.join(runDir, "agent-events.jsonl"), 32 * 1024 * 1024),
          summary.provider || summary.model
        )
      : [];
    const unusedProvider = new Set(providerExecutions.map((entry) => entry.id));
    const combined = activityExecutions.map((execution) => {
      const start = Date.parse(execution.started_at || "");
      const match = providerExecutions
        .filter((candidate) => unusedProvider.has(candidate.id))
        .map((candidate) => ({ candidate, distance: Math.abs(Date.parse(candidate.started_at || "") - start) }))
        .filter(({ distance }) => Number.isFinite(distance) && distance <= 5000)
        .sort((left, right) => left.distance - right.distance)[0]?.candidate;
      if (!match) return execution;
      unusedProvider.delete(match.id);
      return {
        ...match,
        ...execution,
        code: execution.code || match.code,
        code_hash: execution.code_hash || match.code_hash,
        result: execution.result || match.result,
        error: execution.error || match.error,
        started_at: execution.started_at || match.started_at,
        completed_at: execution.completed_at || match.completed_at,
        duration_ms: execution.duration_ms || match.duration_ms
      };
    });
    if (!activityExecutions.length) combined.push(...providerExecutions);
    else providerExecutions.forEach((entry) => {
      if (unusedProvider.has(entry.id)) combined.push(entry);
    });

    combined.forEach((execution) => {
      execution.code_hash ||= execution.code
        ? crypto.createHash("sha256").update(execution.code).digest("hex")
        : "";
    });
    combined.sort((left, right) => Date.parse(left.started_at || "") - Date.parse(right.started_at || ""));
    const totals = new Map();
    combined.forEach((execution) => {
      if (execution.code_hash) totals.set(execution.code_hash, (totals.get(execution.code_hash) || 0) + 1);
    });
    const seen = new Map();
    return combined.map((execution, index) => {
      const repeatIndex = execution.code_hash ? (seen.get(execution.code_hash) || 0) + 1 : 1;
      if (execution.code_hash) seen.set(execution.code_hash, repeatIndex);
      return {
        ...execution,
        sequence: index + 1,
        repeat_index: repeatIndex,
        repeat_count: execution.code_hash ? totals.get(execution.code_hash) || 1 : 1
      };
    });
  }

  function readPythonExecutions(runId, summary, { fresh = false } = {}) {
    const runDir = runDirFor(runId);
    const signature = [
      summary.provider || summary.model,
      fileStamp(path.join(runDir, "tool-activity.jsonl")),
      fileStamp(path.join(runDir, "agent-events.jsonl"))
    ].join("|");
    const cached = toolWorkspaceCache.get(runId);
    if (!fresh && cached?.signature === signature) return cached.value;
    const value = readPythonExecutionsUncached(runId, summary);
    toolWorkspaceCache.set(runId, { signature, value });
    return value;
  }

  function workspaceDescriptors(runId) {
    const root = agentWorkspaceRootFor(runId);
    const workspaces = [{
      id: "primary",
      label: "Lead agent",
      virtual_path: "/workspace",
      directory: path.join(root, "workspace")
    }];
    const workersDir = path.join(root, "swarm-workspaces");
    try {
      fs.readdirSync(workersDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[a-z0-9_-]{1,80}$/i.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name))
        .forEach((entry) => workspaces.push({
          id: entry.name,
          label: `Worker · ${entry.name}`,
          virtual_path: `/workspace/${entry.name}`,
          directory: path.join(workersDir, entry.name)
        }));
    } catch (_error) {
      /* no swarm workspaces yet */
    }
    return workspaces;
  }

  function scanToolWorkspace(descriptor) {
    const entries = [];
    let totalBytes = 0;
    let fileCount = 0;
    let truncated = false;
    function visit(directory, prefix = "") {
      let children;
      try {
        children = fs.readdirSync(directory, { withFileTypes: true });
      } catch (_error) {
        return;
      }
      children.sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
      for (const child of children) {
        if (entries.length >= TOOL_WORKSPACE_MAX_ENTRIES) {
          truncated = true;
          return;
        }
        const relative = prefix ? `${prefix}/${child.name}` : child.name;
        const absolute = path.join(directory, child.name);
        let stat;
        try {
          stat = fs.lstatSync(absolute);
        } catch (_error) {
          continue;
        }
        const type = child.isSymbolicLink() ? "symlink" : child.isDirectory() ? "directory" : "file";
        entries.push({
          path: relative,
          name: child.name,
          type,
          size: type === "file" ? stat.size : 0,
          modified_at: normalizeEventTimestamp(stat.mtimeMs)
        });
        if (type === "file") {
          fileCount += 1;
          totalBytes += stat.size;
        } else if (type === "directory") {
          visit(absolute, relative);
          if (truncated) return;
        }
      }
    }
    visit(descriptor.directory);
    return {
      id: descriptor.id,
      label: descriptor.label,
      virtual_path: descriptor.virtual_path,
      exists: fs.existsSync(descriptor.directory),
      entries,
      file_count: fileCount,
      total_bytes: totalBytes,
      truncated
    };
  }

  function pythonExecutionSummary(execution) {
    const firstLine = String(execution.code || "").split(/\r?\n/).find((line) => line.trim()) || "";
    const output = execution.result?.stdout || execution.result?.stderr || execution.error || "";
    return {
      id: execution.id,
      sequence: execution.sequence,
      workspace_id: execution.workspace_id,
      actor: execution.actor,
      status: execution.status,
      started_at: execution.started_at,
      completed_at: execution.completed_at,
      duration_ms: execution.duration_ms,
      timeout_seconds: execution.timeout_seconds,
      code_hash: execution.code_hash,
      code_bytes: Buffer.byteLength(String(execution.code || ""), "utf8"),
      code_preview: firstLine.trim().slice(0, 180),
      output_preview: String(output).replace(/\s+/g, " ").trim().slice(0, 180),
      repeat_index: execution.repeat_index,
      repeat_count: execution.repeat_count,
      exit_code: execution.result?.exit_code ?? null,
      timed_out: Boolean(execution.result?.timed_out),
      output_truncated: Boolean(execution.result?.output_truncated),
      workspace_changes: execution.workspace_changes
    };
  }

  function readToolsWorkspace(runId, summary) {
    if (summary.kind === "prime" || summary.tool_use !== "offline") return null;
    const executions = readPythonExecutions(runId, summary);
    const workspaces = workspaceDescriptors(runId).map(scanToolWorkspace);
    return {
      available: true,
      workspaces,
      executions: executions.map(pythonExecutionSummary).reverse(),
      counts: {
        executions: executions.length,
        duration_ms: executions.reduce(
          (sum, execution) => sum + Math.max(0, Number(execution.duration_ms) || 0),
          0
        ),
        active: executions.filter((entry) => entry.status === "running").length,
        unique_commands: new Set(executions.map((entry) => entry.code_hash).filter(Boolean)).size,
        files: workspaces.reduce((sum, workspace) => sum + workspace.file_count, 0),
        total_bytes: workspaces.reduce((sum, workspace) => sum + workspace.total_bytes, 0)
      }
    };
  }

  function getToolExecution(runId, executionId) {
    const summary = summarizeRun(runId);
    if (!summary || summary.kind === "prime" || summary.tool_use !== "offline") return null;
    const execution = readPythonExecutions(runId, summary, { fresh: true })
      .find((entry) => entry.id === String(executionId || ""));
    if (!execution) return null;
    return {
      ...pythonExecutionSummary(execution),
      code: String(execution.code || ""),
      stdout: String(execution.result?.stdout || ""),
      stderr: String(execution.result?.stderr || ""),
      error: String(execution.error || "")
    };
  }

  function getToolWorkspaceFile(runId, workspaceId, requestedPath) {
    const summary = summarizeRun(runId);
    if (!summary || summary.kind === "prime" || summary.tool_use !== "offline") return null;
    const descriptor = workspaceDescriptors(runId)
      .find((entry) => entry.id === String(workspaceId || "primary"));
    if (!descriptor) return null;
    const relative = String(requestedPath || "").replaceAll("\\", "/");
    if (!relative || relative.includes("\0") || relative.startsWith("/") || relative.split("/").includes("..")) {
      return null;
    }
    const root = path.resolve(descriptor.directory);
    const candidate = path.resolve(root, ...relative.split("/"));
    const within = path.relative(root, candidate);
    if (!within || within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) return null;
    let stat;
    try {
      stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const realRoot = fs.realpathSync(root);
      const realFile = fs.realpathSync(candidate);
      const realRelative = path.relative(realRoot, realFile);
      if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
        return null;
      }
    } catch (_error) {
      return null;
    }
    const length = Math.min(stat.size, TOOL_WORKSPACE_READ_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      if (length) fs.readSync(fd, buffer, 0, length, 0);
    } finally {
      fs.closeSync(fd);
    }
    const binary = buffer.includes(0);
    return {
      workspace_id: descriptor.id,
      path: relative,
      virtual_path: `${descriptor.virtual_path}/${relative}`,
      size: stat.size,
      modified_at: normalizeEventTimestamp(stat.mtimeMs),
      truncated: stat.size > length,
      binary,
      content: binary ? "" : buffer.toString("utf8")
    };
  }

  function readInstanceEventSummary(runId) {
    const events = readJsonLineTail(
      path.join(runDirFor(runId), "maze-instance-events.jsonl"),
      16 * 1024 * 1024
    );
    const instances = new Map();

    events.forEach((event) => {
      const instanceId = String(event.instance_id || "");
      if (!instanceId || instanceId === "primary") return;
      const current = instances.get(instanceId) || {
        actions_applied: 0,
        actions_attempted: 0,
        created_at: null,
        last_action: "",
        last_action_at: null
      };
      if (event.type === "instance.created") {
        current.created_at = event.at || current.created_at;
      } else if (event.type === "instance.action") {
        current.actions_attempted += event.attempted === false ? 0 : 1;
        current.actions_applied += event.applied ? 1 : 0;
        current.last_action = String(event.action || "");
        current.last_action_at = event.at || current.last_action_at;
      }
      instances.set(instanceId, current);
    });

    return instances;
  }

  function readInstanceMetrics(runId) {
    const byInstance = readInstanceEventSummary(runId);
    const swarmDir = path.join(runDirFor(runId), "swarm");
    const directories = fs.existsSync(swarmDir)
      ? fs.readdirSync(swarmDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      : [];
    const rows = directories.map((entry) => {
      const directory = path.join(swarmDir, entry.name);
      const metadata = loadJson(path.join(directory, "worker.json"), {}) || {};
      const telemetry = loadJson(path.join(directory, "telemetry.json"), null);
      const session = telemetry ? null : loadJson(path.join(directory, "session.json"), null);
      const inherited = Math.max(0, Number(metadata.fork_action_count) || 0);
      const fallbackApplied = Math.max(0, Number(session?.actions?.length) || 0) - inherited;
      const recorded = byInstance.get(entry.name);
      return {
        actions_applied: telemetry
          ? Math.max(0, Number(telemetry.actions_applied) || 0)
          : recorded
            ? recorded.actions_applied
            : fallbackApplied,
        actions_attempted: telemetry
          ? Math.max(0, Number(telemetry.actions_attempted) || 0)
          : recorded
            ? recorded.actions_attempted
            : fallbackApplied
      };
    });
    return {
      instances: Math.max(directories.length, byInstance.size),
      auxiliary_actions: rows.reduce((sum, row) => sum + row.actions_applied, 0),
      auxiliary_action_attempts: rows.reduce((sum, row) => sum + row.actions_attempted, 0)
    };
  }

  function shellActivityLabel(command) {
    const text = String(command || "").replace(/^\S+\s+-[lc]+\s+/, "").replace(/["']/g, "").trim();
    const script = text.match(/(?:^|[;&|]\s*|\s)(?:node|python\d*|ruby|bash|sh)\s+([^\s;&|]+\.(?:js|mjs|cjs|py|rb|sh))\b/i);
    return {
      label: script ? `Algorithm · ${path.basename(script[1])}` : "Shell",
      detail: text.split("\n")[0].slice(0, 140)
    };
  }

  function readToolActivityUncached(runId, summary) {
    if (summary.provider === "prime") return { active: [], recent: [], calls: 0, moves_tried: 0 };
    const runDir = runDirFor(runId);
    const mcpEntries = readJsonLineTail(path.join(runDir, "tool-activity.jsonl"), 4 * 1024 * 1024);
    const events = readJsonLineTail(path.join(runDir, "agent-events.jsonl"));
    const mcpById = new Map();
    mcpEntries.forEach((entry, index) => {
      const id = String(entry.id || `legacy-${index}`);
      mcpById.set(id, { ...(mcpById.get(id) || {}), ...entry, id });
    });
    const mcpRows = [...mcpById.values()].map((entry) => ({
      id: entry.id,
      label: String(entry.tool || "Maze tool").replace(/^maze_/, "Maze · ").replaceAll("_", " "),
      detail: entry.action || entry.clone_id || "",
      actor: entry.clone_id ? `instance · ${entry.clone_id}` : entry.actor || "lead",
      started_at: entry.started_at,
      completed_at: entry.completed_at,
      duration_ms: Math.max(0, Number(entry.duration_ms) || 0),
      status: entry.status || "completed",
      moves_tried: Math.max(0, Number(entry.move_calls) || 0)
    }));
    const activeMcp = mcpRows.filter((entry) => entry.status === "running");
    const completed = mcpRows.filter((entry) => entry.status !== "running");
    const pending = new Map();
    const providerRows = [];
    const timedMoves = completed.filter((entry) => entry.label === "Maze · action" && entry.started_at);
    const movesDuring = (startedAt, completedAt = new Date().toISOString()) => {
      const start = Date.parse(startedAt || "");
      const end = Date.parse(completedAt || "");
      if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
      return timedMoves.filter((entry) => {
        const time = Date.parse(entry.started_at);
        return Number.isFinite(time) && time >= start && time <= end;
      }).length;
    };

    if (summary.provider === "codex") {
      events.forEach((event) => {
        const item = event.item;
        if (!item || !["command_execution", "collab_tool_call"].includes(item.type) || !event._mazebench_received_at) return;
        const id = String(item.id || "");
        if (!id) return;
        if (event.type === "item.started") {
          const shell = item.type === "command_execution" ? shellActivityLabel(item.command) : null;
          pending.set(id, {
            id: `provider-${id}`,
            label: shell?.label || `Subagent · ${String(item.tool || "activity").replaceAll("_", " ")}`,
            detail: shell?.detail || (item.type === "collab_tool_call" ? "Provider worker" : ""),
            actor: "provider",
            started_at: event._mazebench_received_at,
            status: "running"
          });
        } else if (event.type === "item.completed") {
          const row = pending.get(id);
          if (!row) return;
          pending.delete(id);
          const completedAt = event._mazebench_received_at;
          providerRows.push({
            ...row,
            completed_at: completedAt,
            duration_ms: Math.max(0, Date.parse(completedAt) - Date.parse(row.started_at)),
            status: item.status === "failed" ? "failed" : "completed",
            moves_tried: movesDuring(row.started_at, completedAt)
          });
        }
      });
    } else if (summary.provider === "claude") {
      events.forEach((event) => {
        const timestamp = event._mazebench_received_at;
        if (!timestamp) return;
        if (event.type === "assistant" && Array.isArray(event.message?.content)) {
          event.message.content.forEach((block) => {
            if (block?.type !== "tool_use" || !block.id || /^mcp__mazebench/.test(block.name)) return;
            const shell = block.name === "Bash" ? shellActivityLabel(block.input?.command) : null;
            pending.set(block.id, {
              id: `provider-${block.id}`,
              label: shell?.label || (["Task", "Agent"].includes(block.name) ? "Subagent" : block.name || "Tool"),
              detail: shell?.detail || (["Task", "Agent"].includes(block.name)
                ? "Provider worker"
                : String(block.input?.description || block.input?.file_path || "").slice(0, 140)),
              actor: "provider",
              started_at: timestamp,
              status: "running"
            });
          });
        } else if (event.type === "user" && Array.isArray(event.message?.content)) {
          event.message.content.forEach((block) => {
            if (block?.type !== "tool_result" || !pending.has(block.tool_use_id)) return;
            const row = pending.get(block.tool_use_id);
            pending.delete(block.tool_use_id);
            providerRows.push({
              ...row,
              completed_at: timestamp,
              duration_ms: Math.max(0, Date.parse(timestamp) - Date.parse(row.started_at)),
              status: block.is_error ? "failed" : "completed",
              moves_tried: movesDuring(row.started_at, timestamp)
            });
          });
        }
      });
    }

    const active = [...activeMcp, ...pending.values()].map((row) => ({
      ...row,
      duration_ms: Math.max(0, Date.now() - Date.parse(row.started_at)),
      moves_tried: movesDuring(row.started_at)
    }));
    const recent = [...completed, ...providerRows]
      .sort((left, right) => Date.parse(right.completed_at || right.started_at) - Date.parse(left.completed_at || left.started_at))
      .slice(0, 40);
    return {
      active,
      recent,
      calls: mcpRows.length + providerRows.length + pending.size,
      moves_tried: completed.reduce((sum, row) => sum + row.moves_tried, 0)
    };
  }

  function readToolActivity(runId, summary) {
    if (summary.provider === "prime") return { active: [], recent: [], calls: 0, moves_tried: 0 };
    const runDir = runDirFor(runId);
    const signature = [
      summary.provider,
      fileStamp(path.join(runDir, "tool-activity.jsonl")),
      fileStamp(path.join(runDir, "agent-events.jsonl"))
    ].join("|");
    const cached = toolActivityCache.get(runId);
    if (cached?.signature === signature) return cached.value;
    const active = ["running", "pausing", "stopping"].includes(summary.status);
    const expensive = fileSize(path.join(runDir, "agent-events.jsonl")) +
      fileSize(path.join(runDir, "tool-activity.jsonl")) > LARGE_TELEMETRY_BYTES;
    if (active && expensive && cached && Date.now() - cached.checkedAt < LARGE_TELEMETRY_REFRESH_MS) {
      return cached.value;
    }

    const value = readToolActivityUncached(runId, summary);
    toolActivityCache.set(runId, { signature, checkedAt: Date.now(), value });
    return value;
  }

  function fileSize(filePath) {
    if (!filePath) return 0;
    try {
      return fs.statSync(filePath).size;
    } catch (_error) {
      return 0;
    }
  }

  function fileStamp(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return "-";

    try {
      const stat = fs.statSync(filePath);
      return `${filePath}:${stat.size}:${stat.mtimeMs}`;
    } catch (_error) {
      return "-";
    }
  }

  function readTokenUsage(runId, summary) {
    const runDir = runDirFor(runId);
    const eventsPath = path.join(runDir, "agent-events.jsonl");
    const primeLiveUsagePath = path.join(runDir, "prime-usage.jsonl");
    let codexSessionPath = "";
    let codexSwarmSessionPaths = [];
    let kimiWirePath = "";
    let primeResultsPath = "";

    if (summary.provider === "codex") {
      const conversationId = readConversationId(runId);
      const runCodexHome = path.join(runDir, "agent-state", "codex");
      codexSessionPath = codexSessionPaths.get(conversationId) || "";

      if (conversationId && !codexSessionPath) {
        const hostCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
        codexSessionPath =
          findCodexSessionFile(runCodexHome, conversationId) ||
          findCodexSessionFile(hostCodexHome, conversationId);
        if (codexSessionPath) codexSessionPaths.set(conversationId, codexSessionPath);
      }
      if (summary.swarm) {
        codexSwarmSessionPaths = findCodexSessionFiles(runCodexHome);
        if (!codexSwarmSessionPaths.length && codexSessionPath) {
          codexSwarmSessionPaths = [codexSessionPath];
        }
      }
    } else if (summary.provider === "kimi") {
      kimiWirePath = findKimiWireFile(path.join(agentWorkspaceRootFor(runId), "kimi-home"));
    } else if (summary.provider === "prime") {
      primeResultsPath = primeResultsPaths.get(runId) || "";
      if (!primeResultsPath) {
        primeResultsPath = findPrimeResultsFile(runDir);
        if (primeResultsPath) primeResultsPaths.set(runId, primeResultsPath);
      }
    }

    const signature = [
      fileStamp(eventsPath),
      fileStamp(codexSessionPath),
      codexSwarmSessionPaths.map(fileStamp).join(","),
      fileStamp(kimiWirePath),
      fileStamp(primeLiveUsagePath),
      fileStamp(primeResultsPath)
    ].join("|");
    const withSwarmAgentStatus = (usage) => {
      if (!summary.swarm) return usage;
      const agentsRan = Math.max(1, Number(usage?.agents_total) || 0);
      const runIsActive = summary.status === "running" || summary.status === "stopping";
      return {
        ...usage,
        agents_running: runIsActive ? Math.max(1, Number(usage?.agents_current) || 0) : 0,
        agents_ran: agentsRan
      };
    };
    const withCatalogApiEstimate = (usage) => {
      const existingCost = usage?.api_cost_estimate_usd;
      if (
        !usage?.available ||
        existingCost !== null && existingCost !== undefined && Number.isFinite(Number(existingCost))
      ) {
        return usage;
      }
      try {
        const pricing = apiPricingForRun(summary, listProviderModels("prime").models);
        return withApiCostEstimate(usage, pricing);
      } catch (_error) {
        return usage;
      }
    };
    const cached = tokenUsageCache.get(runId);
    if (cached?.signature === signature) return withSwarmAgentStatus(withCatalogApiEstimate(cached.value));
    const active = ["running", "pausing", "stopping"].includes(summary.status);
    const expensive = [eventsPath, codexSessionPath, ...codexSwarmSessionPaths, kimiWirePath, primeLiveUsagePath, primeResultsPath]
      .some((filePath) => fileSize(filePath) > LARGE_TELEMETRY_BYTES);
    if (active && expensive && cached && Date.now() - cached.checkedAt < LARGE_TELEMETRY_REFRESH_MS) {
      return withSwarmAgentStatus(withCatalogApiEstimate(cached.value));
    }

    let value;
    try {
      if (summary.provider === "codex") {
        if (summary.swarm && codexSwarmSessionPaths.length) {
          value = parseCodexSwarmSessions(
            codexSwarmSessionPaths.map((filePath) => fs.readFileSync(filePath, "utf8")),
            readConversationId(runId)
          );
        } else {
          value = codexSessionPath
            ? parseCodexSession(fs.readFileSync(codexSessionPath, "utf8"))
            : parseCodexEvents(fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf8") : "");
        }
      } else if (summary.provider === "claude") {
        value = parseClaudeEvents(fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf8") : "");
      } else if (summary.provider === "kimi") {
        value = kimiWirePath
          ? parseKimiWire(fs.readFileSync(kimiWirePath, "utf8"))
          : {
              provider: "kimi",
              available: false,
              exact: false,
              note: "Waiting for Kimi Code usage…",
              actions: []
            };
      } else {
        const hasFinalResults = primeResultsPath && fs.statSync(primeResultsPath).size > 0;
        value = hasFinalResults
          ? parsePrimeResults(fs.readFileSync(primeResultsPath, "utf8"))
          : parsePrimeLiveUsage(
              fs.existsSync(primeLiveUsagePath) ? fs.readFileSync(primeLiveUsagePath, "utf8") : ""
            );
      }
    } catch (_error) {
      value = {
        provider: summary.provider,
        available: false,
        exact: false,
        note: "Token telemetry is not available for this run.",
        actions: []
      };
    }

    tokenUsageCache.set(runId, { signature, checkedAt: Date.now(), value });
    return withSwarmAgentStatus(withCatalogApiEstimate(value));
  }

  // Vision mode already records the exact image the agent saw. Text mode uses
  // a cheap colored ASCII bitmap and reserves 3D frames for manual replay.
  function latestVisionFrame(runId) {
    const framesDir = path.join(runDirFor(runId), "frames");

    if (!fs.existsSync(framesDir)) {
      return null;
    }

    const frames = fs
      .readdirSync(framesDir)
      .filter((name) => /^frame-\d+\.png$/.test(name))
      .sort();
    const latest = frames[frames.length - 1];
    return latest ? `/agent-runs/${encodeURIComponent(runId)}/files/frames/${latest}` : null;
  }

  function readLastJsonLine(filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.size) return null;
      const length = Math.min(stat.size, 256 * 1024);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(filePath, "r");
      try {
        fs.readSync(fd, buffer, 0, length, stat.size - length);
      } finally {
        fs.closeSync(fd);
      }
      const lines = buffer.toString("utf8").trim().split("\n");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          return JSON.parse(lines[index]);
        } catch (_error) {
          /* The first line may be a partial read; keep walking backward. */
        }
      }
    } catch (_error) {
      /* missing or concurrently-created file */
    }
    return null;
  }

  function jsonLineIndexFor(filePath) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_error) {
      return { size: 0, mtimeMs: 0, offsets: [] };
    }

    const existing = jsonLineIndexes.get(filePath);
    if (existing && existing.size === stat.size && existing.mtimeMs === stat.mtimeMs) return existing;

    const incremental = Boolean(existing && stat.size > existing.size);
    const offsets = incremental ? [...existing.offsets] : stat.size ? [0] : [];
    const start = incremental ? existing.size : 0;

    if (incremental && start > 0) {
      const previous = Buffer.alloc(1);
      const previousFd = fs.openSync(filePath, "r");
      try {
        fs.readSync(previousFd, previous, 0, 1, start - 1);
      } finally {
        fs.closeSync(previousFd);
      }
      if (previous[0] === 10 && start < stat.size && offsets[offsets.length - 1] !== start) offsets.push(start);
    }

    if (stat.size > start) {
      const buffer = Buffer.alloc(stat.size - start);
      const fd = fs.openSync(filePath, "r");
      try {
        fs.readSync(fd, buffer, 0, buffer.length, start);
      } finally {
        fs.closeSync(fd);
      }
      for (let index = 0; index < buffer.length; index += 1) {
        if (buffer[index] !== 10) continue;
        const next = start + index + 1;
        if (next < stat.size && offsets[offsets.length - 1] !== next) offsets.push(next);
      }
    }

    const value = { size: stat.size, mtimeMs: stat.mtimeMs, offsets };
    jsonLineIndexes.set(filePath, value);
    return value;
  }

  function readJsonLineAt(filePath, lineIndex) {
    const index = jsonLineIndexFor(filePath);
    const start = index.offsets[lineIndex];
    if (!Number.isFinite(start)) return null;
    const end = index.offsets[lineIndex + 1] ?? index.size;
    const length = Math.max(0, end - start);
    if (!length) return null;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    try {
      return JSON.parse(buffer.toString("utf8").trim());
    } catch (_error) {
      return null;
    }
  }

  function readJsonLineRange(filePath, index, lineIndex, count) {
    const start = index.offsets[lineIndex];
    if (!Number.isFinite(start) || count <= 0) return [];
    const end = index.offsets[lineIndex + count] ?? index.size;
    const length = Math.max(0, end - start);
    if (!length) return [];
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    return buffer.toString("utf8").split("\n").slice(0, count).map((line) => {
      try {
        return JSON.parse(line.trim());
      } catch (_error) {
        return null;
      }
    });
  }

  function latestSwarmFrame(runId, workerId, workerDir) {
    const framesDir = path.join(workerDir, "frames");
    if (!fs.existsSync(framesDir)) return null;
    const latest = fs.readdirSync(framesDir)
      .map((name) => ({ name, match: name.match(/^frame-(\d+)\.png$/) }))
      .filter((entry) => entry.match)
      .sort((left, right) => Number(right.match[1]) - Number(left.match[1]))[0];
    return latest
      ? `/agent-runs/${encodeURIComponent(runId)}/files/swarm/${encodeURIComponent(workerId)}/frames/${encodeURIComponent(latest.name)}`
      : null;
  }

  function readSwarmViews(runId) {
    const swarmDir = path.join(runDirFor(runId), "swarm");
    if (!fs.existsSync(swarmDir)) return [];
    const eventSummary = readInstanceEventSummary(runId);

    return fs.readdirSync(swarmDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-z0-9_-]{1,48}$/i.test(entry.name))
      .map((entry) => {
        const workerDir = path.join(swarmDir, entry.name);
        const actionsPath = path.join(workerDir, "actions.jsonl");
        const sessionPath = path.join(workerDir, "session.json");
        const metadata = loadJson(path.join(workerDir, "worker.json"), {}) || {};
        const telemetry = loadJson(path.join(workerDir, "telemetry.json"), null);
        const lastAction = readLastJsonLine(actionsPath);
        const session = loadJson(sessionPath, null);
        let status = lastAction?.status || null;

        if (!status) {
          status = session?.lastStatus || session?.initial || null;
        }
        if (!status) return null;

        const checkpoint = loadJson(path.join(workerDir, "current-render-state.json"), null);
        const turn = Math.max(
          0,
          Number(lastAction?.turn) ||
            Number(checkpoint?.turn) ||
            Number(status.action_count) ||
            Number(session?.actions?.length) ||
            0
        );
        let updatedAt = 0;
        try {
          updatedAt = Math.max(
            fs.existsSync(actionsPath) ? fs.statSync(actionsPath).mtimeMs : 0,
            fs.existsSync(sessionPath) ? fs.statSync(sessionPath).mtimeMs : 0,
            fs.existsSync(path.join(workerDir, "current-render-state.json"))
              ? fs.statSync(path.join(workerDir, "current-render-state.json")).mtimeMs
              : 0
          );
        } catch (_error) {
          updatedAt = 0;
        }
        const terminal = Boolean(
          metadata.finished_at ||
          Math.max(0, Number(status.gem_count) || 0) >= GAME_WON_GEM_COUNT ||
          status.game_lost ||
          status.quit ||
          fs.existsSync(path.join(workerDir, "scorecard.json"))
        );
        const activity = terminal
          ? "finished"
          : updatedAt && Date.now() - updatedAt < 15_000
            ? "acting"
            : updatedAt && Date.now() - updatedAt < 120_000
              ? "exploring"
            : "standing by";
        const inheritedActionCount = Math.max(0, Number(metadata.fork_action_count) || 0);
        const recorded = eventSummary.get(entry.name);
        const ownActionCount = Math.max(0, turn - inheritedActionCount);
        const observationMode = normalizeObservationMode(
          metadata.observation_mode || session?.observationMode || (session?.vision ? "vision" : "text")
        );

        return {
          id: entry.name,
          label: String(metadata.label || entry.name),
          activity,
          board: String(status.level || ""),
          json_observation: status.json_observation || null,
          frame_url: observationMode === "vision"
            ? latestSwarmFrame(runId, entry.name, workerDir)
            : null,
          gem_count: Math.max(0, Number(status.gem_count) || 0),
          player: status.player
            ? {
                elevation: Number(status.player.elevation) || 0,
                x: Number(status.player.x) || 0,
                y: Number(status.player.y) || 0
              }
            : null,
          room: String(status.current_room || checkpoint?.snapshot?.level_id || ""),
          turn,
          inherited_action_count: inheritedActionCount,
          auxiliary_actions: telemetry
            ? Math.max(0, Number(telemetry.actions_applied) || 0)
            : recorded
              ? recorded.actions_applied
              : ownActionCount,
          auxiliary_action_attempts: telemetry
            ? Math.max(0, Number(telemetry.actions_attempted) || 0)
            : recorded
              ? recorded.actions_attempted
              : ownActionCount,
          last_action: String(telemetry?.last_action || recorded?.last_action || ""),
          owner_kind: String(metadata.owner_kind || "subagent"),
          owner_agent_id: String(metadata.owner_agent_id || entry.name),
          parent_instance_id: String(metadata.parent_instance_id || "primary"),
          observation_mode: observationMode,
          updated_at: updatedAt ? new Date(updatedAt).toISOString() : null,
          view: String(status.current_view || ""),
          yaw: Number(status.yaw) || 0
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
        const rank = { acting: 0, exploring: 1, "standing by": 2, finished: 3 };
        return (rank[left.activity] ?? 3) - (rank[right.activity] ?? 3) || left.id.localeCompare(right.id);
      });
  }

  function readReplayProgress(runId) {
    return loadJson(path.join(runDirFor(runId), "replay-progress.json"), null);
  }

  function reconstructAsciiObservation(runId, absoluteTurn, summary) {
    const actionsPath = path.join(runDirFor(runId), "actions.jsonl");
    let actionsStamp = "";
    try {
      const stat = fs.statSync(actionsPath);
      actionsStamp = `${stat.size}:${stat.mtimeMs}`;
    } catch (_error) {
      if (absoluteTurn > 0) return "";
    }

    const launchParams = summary.launch_params || {};
    const hideNames = Boolean(launchParams.hide_names ?? summary.hide_names);
    const seed = resolvedHideNamesSeed(hideNames, launchParams.hide_names_seed || summary.hide_names_seed);
    const turn = Math.max(0, Math.floor(Number(absoluteTurn) || 0));
    if (turn > MAX_SYNCHRONOUS_HISTORY_REPLAY_ACTIONS) return "";
    const cacheKey = [runId, turn, actionsStamp, hideNames ? 1 : 0, seed].join(":");
    if (reconstructedAsciiObservationCache.has(cacheKey)) {
      return reconstructedAsciiObservationCache.get(cacheKey);
    }

    const replay = readActions(runId)
      .slice(0, turn)
      .filter((action) => action?.valid !== false)
      .map((action) => replayMessageForCommandText(action.command_text))
      .filter(Boolean);
    const bridgeArgs = [
      path.join(rootDir, "scripts", "maze-bridge.js"),
      "--game", String(launchParams.game_id || summary.game_id || "maze"),
      "--level", String(launchParams.level_id || summary.level_id || "level_HxI"),
      "--view", String(launchParams.view || summary.view || "top-diagonal"),
      "--yaw", String(Number(launchParams.yaw ?? summary.yaw) || 0),
      "--game-won-gem-count", String(GAME_WON_GEM_COUNT),
      "--observation-mode", "text",
      "--hide-names-seed", seed || "1"
    ];
    if (hideNames) bridgeArgs.push("--hide-names");

    const messages = [...replay, { command: "observe" }, { command: "close" }];
    const result = spawnSync(process.execPath, bridgeArgs, {
      cwd: rootDir,
      encoding: "utf8",
      input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
      maxBuffer: 80 * 1024 * 1024,
      timeout: 30_000
    });
    if (result.error || result.status !== 0) return "";

    try {
      const responses = String(result.stdout || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const board = String(responses[replay.length]?.level || "");
      if (!board) return "";
      if (reconstructedAsciiObservationCache.size >= 64) {
        reconstructedAsciiObservationCache.delete(reconstructedAsciiObservationCache.keys().next().value);
      }
      reconstructedAsciiObservationCache.set(cacheKey, board);
      return board;
    } catch (_error) {
      return "";
    }
  }

  function reconstructBoardStateTimeline(runId, summary) {
    const actionsPath = path.join(runDirFor(runId), "actions.jsonl");
    let actionsStamp = "0";
    try {
      const stat = fs.statSync(actionsPath);
      actionsStamp = `${stat.size}:${stat.mtimeMs}`;
    } catch (_error) {
      // Move zero still has a canonical state when no actions have been written.
    }

    const launchParams = summary.launch_params || {};
    const cacheKey = [
      runId,
      actionsStamp,
      launchParams.game_id || summary.game_id || "maze",
      launchParams.level_id || summary.level_id || "level_HxI"
    ].join(":");
    if (reconstructedBoardStateTimelineCache.has(cacheKey)) {
      return reconstructedBoardStateTimelineCache.get(cacheKey);
    }

    const actions = readActions(runId);
    if (actions.length > MAX_SYNCHRONOUS_HISTORY_REPLAY_ACTIONS) return null;
    const replay = actions.map((action) => {
      if (action?.valid === false) return { command: "observe" };
      return replayMessageForCommandText(action.command_text) || { command: "observe" };
    });
    const bridgeArgs = [
      path.join(rootDir, "scripts", "maze-bridge.js"),
      "--game", String(launchParams.game_id || summary.game_id || "maze"),
      "--level", String(launchParams.level_id || summary.level_id || "level_HxI"),
      "--view", String(launchParams.view || summary.view || "top-diagonal"),
      "--yaw", String(Number(launchParams.yaw ?? summary.yaw) || 0),
      "--game-won-gem-count", String(GAME_WON_GEM_COUNT),
      "--observation-mode", "text"
    ];
    const messages = [{ command: "observe" }, ...replay, { command: "close" }];
    const result = spawnSync(process.execPath, bridgeArgs, {
      cwd: rootDir,
      encoding: "utf8",
      input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
      maxBuffer: 80 * 1024 * 1024,
      timeout: 30_000
    });
    if (result.error || result.status !== 0) return null;

    try {
      const responses = String(result.stdout || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const initialHash = String(responses[0]?.board_state_hash || "");
      if (!initialHash) return null;
      const initialPlayer = normalizedPlayerPosition(responses[0]?.player);
      const hashes = new Map();
      const players = new Map();
      actions.forEach((action, index) => {
        const response = responses[index + 1];
        const turn = Number(action.turn) || index + 1;
        const hash = String(response?.board_state_hash || "");
        const player = normalizedPlayerPosition(response?.player);
        if (hash) hashes.set(turn, hash);
        if (player) players.set(turn, player);
      });
      const timeline = {
        hash_version: BOARD_STATE_HASH_VERSION,
        initial_hash: initialHash,
        initial_player: initialPlayer,
        hashes,
        players
      };
      if (reconstructedBoardStateTimelineCache.size >= 32) {
        reconstructedBoardStateTimelineCache.delete(reconstructedBoardStateTimelineCache.keys().next().value);
      }
      reconstructedBoardStateTimelineCache.set(cacheKey, timeline);
      return timeline;
    } catch (_error) {
      return null;
    }
  }

  function reconstructJsonObservation(runId, instanceId, instanceDir, absoluteTurn, summary, metadata) {
    const sessionPath = path.join(instanceDir, "session.json");
    const session = loadJson(sessionPath, null);
    if (!session || !Array.isArray(session.actions)) return null;
    if (absoluteTurn > MAX_SYNCHRONOUS_HISTORY_REPLAY_ACTIONS) return null;

    let sessionMtime = 0;
    try {
      sessionMtime = fs.statSync(sessionPath).mtimeMs;
    } catch (_error) {
      return null;
    }

    const launchParams = summary.launch_params || {};
    const omniscient = typeof session.omniscient === "boolean"
      ? session.omniscient
      : Boolean(metadata.omniscient ?? launchParams.omniscient);
    const hideNames = typeof session.hideNames === "boolean"
      ? session.hideNames
      : Boolean(metadata.hide_names ?? launchParams.hide_names);
    const seed = String(
      session.hideNamesSeed || metadata.hide_names_seed || launchParams.hide_names_seed || "1"
    );
    const cacheKey = [
      runId,
      instanceId,
      absoluteTurn,
      sessionMtime,
      omniscient ? 1 : 0,
      hideNames ? 1 : 0,
      seed
    ].join(":");
    if (reconstructedJsonObservationCache.has(cacheKey)) {
      return reconstructedJsonObservationCache.get(cacheKey);
    }

    const replay = session.actions
      .slice(0, absoluteTurn)
      .filter((action) => action?.message && action.replay !== false)
      .map((action) => action.message);
    const bridgeArgs = [
      path.join(rootDir, "scripts", "maze-bridge.js"),
      "--game", String(session.gameId || summary.game_id || "maze"),
      "--level", String(session.levelId || summary.level_id || "level_HxI"),
      "--view", String(session.view || summary.view || "top-diagonal"),
      "--yaw", String(Number(session.yaw) || 0),
      "--game-won-gem-count", String(GAME_WON_GEM_COUNT),
      "--observation-mode", "json",
      "--hide-names-seed", seed
    ];
    if (omniscient) bridgeArgs.push("--omniscient");
    if (hideNames) bridgeArgs.push("--hide-names");

    const messages = [...replay, { command: "observe" }, { command: "close" }];
    const result = spawnSync(process.execPath, bridgeArgs, {
      cwd: rootDir,
      encoding: "utf8",
      input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
      maxBuffer: 80 * 1024 * 1024,
      timeout: 30_000
    });
    if (result.error || result.status !== 0) return null;

    try {
      const responses = String(result.stdout || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const response = responses[replay.length] || null;
      const observation = response?.json_observation || null;
      if (!observation) return null;
      const reconstructed = {
        observation,
        displayPalette: response?.json_display_palette || null
      };
      if (reconstructedJsonObservationCache.size >= 64) {
        reconstructedJsonObservationCache.delete(reconstructedJsonObservationCache.keys().next().value);
      }
      reconstructedJsonObservationCache.set(cacheKey, reconstructed);
      return reconstructed;
    } catch (_error) {
      return null;
    }
  }

  function jsonDisplayPaletteForRun(summary, metadata = {}, observation = null) {
    const launchParams = summary.launch_params || {};
    const gameId = String(metadata.game_id || summary.game_id || "maze");
    const levelId = String(metadata.level_id || summary.level_id || "level_HxI");
    const view = String(metadata.view || summary.view || "top-diagonal");
    const yaw = Number(metadata.yaw ?? summary.yaw) || 0;
    const hideNames = typeof observation?.hide_names === "boolean"
      ? observation.hide_names
      : Boolean(metadata.hide_names ?? launchParams.hide_names ?? summary.hide_names);
    const seed = String(metadata.hide_names_seed || launchParams.hide_names_seed || summary.hide_names_seed || "1");
    const cacheKey = [gameId, levelId, view, yaw, hideNames ? 1 : 0, seed].join(":");
    if (jsonDisplayPaletteCache.has(cacheKey)) return jsonDisplayPaletteCache.get(cacheKey);

    try {
      // Loading this lazily avoids the maze-terminal -> server/app dependency
      // cycle during startup. Palette generation creates only the initial room
      // context; it never replays the run or starts a child process.
      const {
        buildJsonDisplayPalette,
        createTerminalContext,
        loadMazeEngine
      } = require("../scripts/maze-terminal");
      const pitch = Math.max(0, ["top", "top-diagonal", "diagonal", "side-diagonal", "side"].indexOf(view));
      const context = createTerminalContext(loadMazeEngine(), {
        gameId,
        levelId,
        gameWonGemCount: GAME_WON_GEM_COUNT,
        hideNames,
        hideNamesSeed: seed,
        pitch,
        yaw
      });
      const palette = buildJsonDisplayPalette(context, { hideNames, hideNamesSeed: seed });
      jsonDisplayPaletteCache.set(cacheKey, palette);
      return palette;
    } catch (_error) {
      return null;
    }
  }

  function runObservationContext(runId, instanceId) {
    const summary = summarizeRun(runId);
    if (!summary) return null;

    const requestedInstance = String(instanceId || "primary");
    const primary = requestedInstance === "primary";
    if (!primary && !/^[a-z0-9_-]{1,48}$/i.test(requestedInstance)) return null;

    const runDir = runDirFor(runId);
    const instanceDir = primary ? runDir : path.join(runDir, "swarm", requestedInstance);
    if (!primary && (!fs.existsSync(instanceDir) || !fs.statSync(instanceDir).isDirectory())) return null;

    const metadata = primary ? {} : loadJson(path.join(instanceDir, "worker.json"), {}) || {};
    const actionsPath = path.join(instanceDir, "actions.jsonl");
    const actionIndex = jsonLineIndexFor(actionsPath);
    const forkActionCount = primary ? 0 : Math.max(0, Number(metadata.fork_action_count) || 0);
    const total = Math.max(0, actionIndex.offsets.length - forkActionCount);
    return {
      actionIndex,
      actionsPath,
      forkActionCount,
      instanceDir,
      metadata,
      mode: normalizeObservationMode(metadata.observation_mode || summary.mode),
      primary,
      requestedInstance,
      runId,
      summary,
      total
    };
  }

  function runObservationAt(context, turn, suppliedRecord) {
    const {
      actionsPath,
      forkActionCount,
      instanceDir,
      metadata,
      mode,
      primary,
      requestedInstance,
      runId,
      summary,
      total
    } = context;
    const relativeTurn = Math.max(0, Math.min(total, Math.floor(Number(turn) || 0)));
    const absoluteTurn = forkActionCount + relativeTurn;
    const record = suppliedRecord === undefined && absoluteTurn > 0
      ? readJsonLineAt(actionsPath, absoluteTurn - 1)
      : suppliedRecord || null;
    let status = record?.status || null;

    if (!status && absoluteTurn === 0) {
      status = loadJson(path.join(instanceDir, "initial-status.json"), null);
      if (!status) {
        const session = loadJson(path.join(instanceDir, "session.json"), null);
        status = session?.initial || session?.lastStatus || null;
      }
    }

    const board = mode === "text" && primary && !status?.level
      ? reconstructAsciiObservation(runId, absoluteTurn, summary)
      : String(status?.level || "");
    const reconstructedJson = mode === "json" && !status?.json_observation
      ? reconstructJsonObservation(runId, requestedInstance, instanceDir, absoluteTurn, summary, metadata)
      : null;
    const jsonObservation = status?.json_observation || reconstructedJson?.observation || null;
    const jsonDisplayPalette = status?.json_display_palette || reconstructedJson?.displayPalette ||
      (jsonObservation ? jsonDisplayPaletteForRun(summary, metadata, jsonObservation) : null);
    let player = normalizedPlayerPosition(status?.player);
    if (primary && !player) {
      const reconstructed = reconstructBoardStateTimeline(runId, summary);
      player = absoluteTurn === 0
        ? reconstructed?.initial_player || null
        : reconstructed?.players.get(absoluteTurn) || null;
    }
    const frameName = `frame-${String(absoluteTurn).padStart(3, "0")}.png`;
    const exactFrame = path.join(instanceDir, "frames", frameName);
    let frameUrl = null;

    if (mode === "vision" && fs.existsSync(exactFrame)) {
      frameUrl = primary
        ? `/agent-runs/${encodeURIComponent(runId)}/files/frames/${frameName}`
        : `/agent-runs/${encodeURIComponent(runId)}/files/swarm/${encodeURIComponent(requestedInstance)}/frames/${frameName}`;
    }

    return {
      instance_id: requestedInstance,
      label: primary ? "Primary" : String(metadata.label || requestedInstance),
      mode,
      turn: relativeTurn,
      absolute_turn: absoluteTurn,
      total,
      command_text: String(record?.command_text || ""),
      board,
      json_observation: jsonObservation,
      json_display_palette: jsonDisplayPalette,
      frame_url: frameUrl,
      current_room: String(status?.current_room || ""),
      gem_count: Math.max(0, Number(status?.gem_count) || 0),
      player,
      yaw: Number(status?.yaw) || 0
    };
  }

  function getRunObservation(runId, { instanceId = "primary", turn = 0 } = {}) {
    const context = runObservationContext(runId, instanceId);
    return context ? runObservationAt(context, turn) : null;
  }

  function getRunObservations(runId, { instanceId = "primary", fromTurn = 0, limit = 1 } = {}) {
    const context = runObservationContext(runId, instanceId);
    if (!context) return null;
    const batchSize = Math.max(1, Math.min(240, Math.floor(Number(limit) || 1)));
    const firstTurn = Math.max(0, Math.min(context.total, Math.floor(Number(fromTurn) || 0)));
    const lastTurn = Math.min(context.total, firstTurn + batchSize - 1);
    const firstAbsoluteTurn = context.forkActionCount + firstTurn;
    const lastAbsoluteTurn = context.forkActionCount + lastTurn;
    const firstRecordTurn = Math.max(1, firstAbsoluteTurn);
    const recordCount = Math.max(0, lastAbsoluteTurn - firstRecordTurn + 1);
    const records = readJsonLineRange(
      context.actionsPath,
      context.actionIndex,
      firstRecordTurn - 1,
      recordCount
    );
    const observations = [];
    for (let turn = firstTurn; turn <= lastTurn; turn += 1) {
      const absoluteTurn = context.forkActionCount + turn;
      const record = absoluteTurn > 0 ? records[absoluteTurn - firstRecordTurn] || null : undefined;
      observations.push(runObservationAt(context, turn, record));
    }

    return {
      instance_id: context.requestedInstance,
      from_turn: firstTurn,
      total: context.total,
      observations
    };
  }

  function getRunProgress(runId, { afterTurn = 0, logOffset = 0 } = {}) {
    const summary = summarizeRun(runId);

    if (!summary) {
      return null;
    }

    if (summary.status === "running") startLegacyClaudeSnapshots(runId);

    const cursor = Math.max(0, Number(afterTurn) || 0);
    const log = readLogChunk(runId, logOffset);
    const instanceViews = readSwarmViews(runId);
    const pendingActions = readActions(runId, cursor);
    const actions = pendingActions.slice(0, PROGRESS_ACTION_BATCH_SIZE);
    const totalTurns = Math.max(0, Number(summary.turns) || 0);
    const historyThrough = actions.length
      ? Math.max(cursor, Number(actions[actions.length - 1]?.turn) || cursor)
      : cursor;
    const historySync = {
      current: Math.min(totalTurns, historyThrough),
      total: totalTurns,
      complete: historyThrough >= totalTurns
    };
    const historyFloor = Math.max(1, cursor - 5);
    const historyCeiling = Math.max(cursor, historyThrough);
    if (summary.mode === "json" && actions.length) {
      const latest = actions[actions.length - 1];
      if (latest.json_observation && !latest.json_display_palette) {
        latest.json_display_palette = jsonDisplayPaletteForRun(summary, {}, latest.json_observation);
      }
    }
    if (summary.mode === "text" && actions.length) {
      const latest = actions[actions.length - 1];
      const latestTurn = Math.max(0, Number(summary.turns) || 0);
      if (!latest.level && Number(latest.turn) === latestTurn) {
        latest.level = reconstructAsciiObservation(runId, latestTurn, summary) || null;
      }
    }
    let initialBoardStateHash = readInitialBoardStateHash(runId);
    let initialBoardStateHashVersion = readInitialBoardStateHashVersion(runId);
    let initialPlayer = readInitialPlayer(runId);
    const legacyBoardStateHashes = initialBoardStateHashVersion !== BOARD_STATE_HASH_VERSION ||
      actions.some((action) => action.board_state_hash_version !== BOARD_STATE_HASH_VERSION);
    if (
      legacyBoardStateHashes ||
      !initialBoardStateHash ||
      !initialPlayer ||
      actions.some((action) => !action.board_state_hash || !action.player)
    ) {
      const reconstructed = reconstructBoardStateTimeline(runId, summary);
      if (reconstructed) {
        if (legacyBoardStateHashes || !initialBoardStateHash) {
          initialBoardStateHash = reconstructed.initial_hash;
          initialBoardStateHashVersion = reconstructed.hash_version;
        }
        initialPlayer ||= reconstructed.initial_player;
        actions.forEach((action) => {
          if (legacyBoardStateHashes || !action.board_state_hash) {
            action.board_state_hash = reconstructed.hashes.get(Number(action.turn)) || null;
            action.board_state_hash_version = reconstructed.hash_version;
          }
          action.player ||= reconstructed.players.get(Number(action.turn)) || null;
        });
      }
    }
    const reasoning = readReasoning(runId, summary.model, summary.status);
    const reasoningTimestamps = new Map(reasoning
      .filter((entry) => entry?.timestamp)
      .map((entry) => [Number(entry.move), entry.timestamp]));
    actions.forEach((action) => {
      action.timestamp ||= reasoningTimestamps.get(Number(action.turn)) || null;
    });
    const tokenUsage = readTokenUsage(runId, summary);
    const incrementalTokenUsage = Array.isArray(tokenUsage?.actions)
      ? {
          ...tokenUsage,
          actions: tokenUsage.actions.filter((point, index) =>
            Math.max(1, Number(point?.action) || index + 1) >= historyFloor &&
              Math.max(1, Number(point?.action) || index + 1) <= historyCeiling
          )
        }
      : tokenUsage;

    const latestPrimeUsage = summary.provider === "prime"
      ? readLastJsonLine(path.join(runDirFor(runId), "prime-usage.jsonl"))
      : null;
    const lastModelActivityMs = Number(latestPrimeUsage?.recorded_at) > 0
      ? Number(latestPrimeUsage.recorded_at) * 1000
      : Date.parse(summary.active_started_at || summary.created_at || "");
    const inference = summary.provider === "prime" && summary.status === "running"
      ? {
          state: "in_flight",
          action: Math.max(1, Number(summary.turns) + 1),
          elapsed_ms: Number.isFinite(lastModelActivityMs) ? Math.max(0, Date.now() - lastModelActivityMs) : 0
        }
      : null;

    return {
      run: inference ? { ...summary, inference } : summary,
      actions,
      history_sync: historySync,
      initial_board_state_hash: initialBoardStateHash || null,
      initial_player: initialPlayer,
      log_chunk: log.chunk,
      log_offset: log.offset,
      token_usage: incrementalTokenUsage,
      tool_activity: historySync.complete ? readToolActivity(runId, summary) : null,
      tools_workspace: historySync.complete ? readToolsWorkspace(runId, summary) : null,
      reasoning: reasoning.filter((entry) => {
        const move = Math.max(1, Number(entry?.move) || 0);
        return move >= historyFloor && move <= historyCeiling;
      }),
      instance_activity: {
        active: instanceViews.filter((instance) => ["acting", "exploring"].includes(instance.activity)).length,
        instances: Math.max(0, Number(summary.explorer_instances) || 0),
        auxiliary_actions: Math.max(0, Number(summary.auxiliary_actions) || 0),
        auxiliary_action_attempts: Math.max(0, Number(summary.auxiliary_action_attempts) || 0)
      },
      swarm_views: instanceViews,
      vision_frame_url: summary.mode === "vision" ? latestVisionFrame(runId) : null,
      replay_progress: summary.has_video ? { phase: "done", percent: 100 } : readReplayProgress(runId)
    };
  }

  // ---- provider model catalogs ------------------------------------------
  // codex: read the Codex app's disk catalog on every request, then merge it
  //        into a last-known-good snapshot. The app can briefly rewrite its
  //        cache with an older/subset catalog; that must not make newly exposed
  //        models disappear from Maze Bench.
  // claude: help aliases plus the installed /model picker's static metadata.
  // prime: `prime inference models --output json` (needs `prime login`);
  //        results are cached and errors surface as a hint instead of a 500.
  const providerModelCache = new Map();
  const PROVIDER_MODEL_TTL_MS = 10 * 60 * 1000;
  const PROVIDER_MODEL_ERROR_TTL_MS = 60 * 1000;

  function modelCatalogCheckedAt() {
    return new Date().toISOString();
  }

  function readStableCodexCatalog() {
    if (stableCodexCatalog !== undefined) return stableCodexCatalog;
    const saved = loadJson(stableCodexCatalogPath, null);
    stableCodexCatalog = saved && Array.isArray(saved.models) ? saved : null;
    return stableCodexCatalog;
  }

  function mergeStableCodexCatalog(candidate) {
    const previous = readStableCodexCatalog();
    if (!candidate.models.length) return previous || candidate;
    const snapshot = { ...candidate };
    delete snapshot.checked_at;
    if (!previous?.models?.length) {
      stableCodexCatalog = snapshot;
    } else {
      const currentById = new Map(snapshot.models.map((model) => [model.id, model]));
      const previousById = new Map(previous.models.map((model) => [model.id, model]));
      const introducedIds = snapshot.models
        .map((model) => model.id)
        .filter((id) => !previousById.has(id));
      const candidateIsRegression = previous.models.some((model) => !currentById.has(model.id));
      const orderedIds = introducedIds.length
        ? [...snapshot.models.map((model) => model.id), ...previous.models.map((model) => model.id)]
        : previous.models.map((model) => model.id);
      const seen = new Set();
      const models = orderedIds
        .filter((id) => id && !seen.has(id) && seen.add(id))
        // If this is a subset regression, preserve the richer metadata too
        // (reasoning levels and fast-tier support), not only the model ids.
        .map((id) => candidateIsRegression
          ? previousById.get(id) || currentById.get(id)
          : currentById.get(id) || previousById.get(id))
        .filter(Boolean);

      stableCodexCatalog = {
        ...snapshot,
        models,
        updated_at: candidateIsRegression
          ? previous.updated_at || snapshot.updated_at
          : snapshot.updated_at || previous.updated_at
      };
    }

    if (JSON.stringify(stableCodexCatalog) !== JSON.stringify(previous)) {
      ensureDirectory(runsDir);
      const temporary = `${stableCodexCatalogPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(stableCodexCatalog, null, 2)}\n`, "utf8");
      fs.renameSync(temporary, stableCodexCatalogPath);
    }

    return stableCodexCatalog;
  }

  function codexModelCatalog() {
    const models = loadCodexModels().map((model) => ({
      id: model.slug,
      label: model.displayName,
      description: model.description,
      reasoning_levels: model.reasoningLevels.map((level) => level.effort),
      default_reasoning: model.defaultReasoning,
      fast: Boolean(model.fast)
    }));
    let updatedAt = "";

    try {
      const cache = JSON.parse(
        fs.readFileSync(path.join(process.env.HOME || "", ".codex", "models_cache.json"), "utf8")
      );
      updatedAt = String(cache.fetched_at || "");
    } catch (_error) {
      /* loadCodexModels reports the missing cache below */
    }

    const candidate = {
      models,
      source: "Codex live catalog",
      updated_at: updatedAt,
      checked_at: modelCatalogCheckedAt(),
      // The Codex app orders its catalog strongest-first.
      default_model_id: models[0]?.id || "",
      note: models.length
        ? "This is the model list available to the installed Codex app."
        : "No Codex model cache found (~/.codex/models_cache.json) — run the Codex app once, or type a model id."
    };
    const stable = mergeStableCodexCatalog(candidate);
    return {
      ...stable,
      checked_at: candidate.checked_at,
      default_model_id: stable.models[0]?.id || "",
      note: stable.models.length ? candidate.note : stable.note
    };
  }

  function claudeModelCatalog() {
    // Claude Code has no JSON model-catalog command. Its help lists most aliases,
    // while the model picker metadata embedded in the installed CLI is more
    // complete (for example, current builds expose Haiku in /model but omit it
    // from the --model help example). Read both so this catalog follows the
    // installed CLI instead of maintaining a stale model list here.
    const help = spawnSync("claude", ["--help"], {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024
    });
    const helpText = String(help.stdout || help.stderr || "");
    const aliasExample = helpText.match(/alias for the latest model[\s\S]{0,180}?\((?:e\.g\.\s*)?([^)]*)\)/i);
    const detectedAliases = aliasExample
      ? [...aliasExample[1].matchAll(/['"]([a-z][a-z0-9-]*)['"]/gi)].map((match) => match[1].toLowerCase())
      : [];

    const pickerLabels = new Map();
    const pickerModelIds = new Map();
    const executable = spawnSync("sh", ["-c", "command -v claude"], {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 2000
    });
    const executablePath = String(executable.stdout || "").trim();

    if (executable.status === 0 && executablePath) {
      // `strings` lets us read the same static labels used by /model without
      // opening an interactive session, changing the user's default, or making
      // an API request. The awk filter keeps the 200MB+ executable out of memory.
      const pickerMetadata = spawnSync(
        "sh",
        [
          "-c",
          "LC_ALL=C strings \"$1\" | awk '/^Custom [[:alnum:]-]+ model$/ || /^[[:alnum:]-]+ [0-9]+([.][0-9]+)*([[:space:]]+-|[[:space:]]*$)/'",
          "claude-model-catalog",
          executablePath
        ],
        {
          encoding: "utf8",
          env: enrichedPathEnv(),
          timeout: 5000,
          maxBuffer: 2 * 1024 * 1024
        }
      );
      const metadataLines = String(pickerMetadata.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const pickerFamilies = [...new Set(metadataLines.flatMap((line) => {
        const match = line.match(/^Custom ([a-z][a-z0-9-]*) model$/i);
        return match ? [match[1]] : [];
      }))];

      for (const family of pickerFamilies) {
        const escapedFamily = family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const versionPattern = new RegExp(`^${escapedFamily}\\s+(\\d+(?:\\.\\d+)*)\\s*(?:-|$)`, "i");
        const versions = metadataLines.flatMap((line) => {
          const match = line.match(versionPattern);
          return match ? [match[1]] : [];
        });
        versions.sort((left, right) => {
          const leftParts = left.split(".").map(Number);
          const rightParts = right.split(".").map(Number);
          const length = Math.max(leftParts.length, rightParts.length);
          for (let index = 0; index < length; index += 1) {
            const difference = (rightParts[index] || 0) - (leftParts[index] || 0);
            if (difference) return difference;
          }
          return 0;
        });

        const alias = family.toLowerCase();
        const version = versions[0];
        if (version) {
          pickerLabels.set(alias, `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}`);
          pickerModelIds.set(alias, `claude-${alias}-${version.replace(/\./g, "-")}`);
        }
      }
    }

    const aliases = [...new Set([...detectedAliases, ...pickerLabels.keys()])]
      .filter((alias) => /^[a-z][a-z0-9-]*$/.test(alias));
    const descriptions = {
      fable: "Latest Fable tier — highest capability",
      opus: "Latest Opus tier — deep reasoning",
      sonnet: "Latest Sonnet tier — balanced speed and capability",
      haiku: "Latest Haiku tier — fastest responses"
    };
    const version = spawnSync("claude", ["--version"], {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 5000
    });
    const versionText = String(version.stdout || "").trim().replace(/\s*\(Claude Code\)\s*$/i, "");

    return {
      models: aliases.map((alias) => ({
        id: alias,
        label: pickerLabels.get(alias) || `${alias.charAt(0).toUpperCase()}${alias.slice(1)} (latest)`,
        description: descriptions[alias] || `Latest model behind the ${alias} alias`,
        resolved_model_id: pickerModelIds.get(alias) || "",
        reasoning_levels: claudeReasoningLevels(pickerModelIds.get(alias) || "")
      })),
      source: versionText ? `Claude Code ${versionText}` : "Installed Claude Code CLI",
      checked_at: modelCatalogCheckedAt(),
      default_model_id: aliases[0] || "",
      // The CLI accepts this complete syntax set, but each model above carries
      // its own supported subset. For example, Haiku 4.5 has no effort control.
      reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
      reasoning_default: "",
      note: pickerLabels.size
        ? "Models and display versions detected from this installed Claude Code build. Aliases stay dynamic when Claude rolls them forward."
        : detectedAliases.length
          ? "Aliases detected from the installed CLI; this build did not expose exact picker labels."
          : "Claude Code did not expose a model list. Use Custom… for a full model id."
    };
  }

  function kimiModelCatalog() {
    const result = spawnSync("kimi", ["provider", "list", "--json"], {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024
    });
    const version = spawnSync("kimi", ["--version"], {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 3000
    });
    const versionText = String(version.stdout || "").trim();

    if (result.status !== 0) {
      return {
        models: [],
        source: versionText ? `Kimi Code ${versionText}` : "Installed Kimi Code CLI",
        checked_at: modelCatalogCheckedAt(),
        note: "Kimi Code did not expose a configured model catalog. Run `kimi login`, then reopen this page."
      };
    }

    try {
      const payload = JSON.parse(String(result.stdout || "{}"));
      const rows = Object.entries(payload.models || {}).map(([id, model]) => {
        const capabilities = Array.isArray(model?.capabilities) ? model.capabilities : [];
        const efforts = Array.isArray(model?.supportEfforts) && model.supportEfforts.length
          ? model.supportEfforts.map(String)
          : capabilities.includes("thinking")
            ? [String(model?.defaultEffort || "high")]
            : [];
        return {
          id,
          label: String(model?.displayName || id),
          description: `${String(model?.model || id)} via ${String(model?.provider || "Kimi")}`,
          reasoning_levels: [...new Set(efforts)],
          default_reasoning: String(model?.defaultEffort || efforts[0] || ""),
          vision: capabilities.includes("image_in")
        };
      });
      let configuredDefault = "";
      try {
        const kimiHome = process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
        const configText = fs.readFileSync(path.join(kimiHome, "config.toml"), "utf8");
        configuredDefault = String(configText.match(/^\s*default_model\s*=\s*["']([^"']+)["']/m)?.[1] || "");
      } catch (_error) {
        /* the catalog still works without a configured default */
      }
      const defaultId = String(payload.defaultModel || payload.default_model || configuredDefault);
      rows.sort((left, right) => Number(right.id === defaultId) - Number(left.id === defaultId));
      return {
        models: rows,
        source: versionText ? `Kimi Code ${versionText}` : "Installed Kimi Code CLI",
        checked_at: modelCatalogCheckedAt(),
        default_model_id: defaultId || rows[0]?.id || "",
        note: rows.length
          ? "Models loaded from the installed Kimi Code CLI; MazeBench launches them with only isolated game and Python MCP tools."
          : "Kimi Code is configured but has no models. Run `kimi login` or add a provider."
      };
    } catch (_error) {
      return {
        models: [],
        source: versionText ? `Kimi Code ${versionText}` : "Installed Kimi Code CLI",
        checked_at: modelCatalogCheckedAt(),
        note: "Could not parse the Kimi Code model catalog."
      };
    }
  }

  // Prime's model list (OpenAI-style /models) exposes no modality field, so we
  // infer image-input support from the model id: an allowlist of known
  // multimodal families, with text-only variants (…-mini reasoning models,
  // audio-only endpoints) carved back out. Unknown ids default to text-only so
  // the UI never offers vision to a model that can't read images.
  function primeModelVision(id) {
    const slug = String(id || "").toLowerCase();

    // Text-only variants that would otherwise match a multimodal family below.
    if (/(^|\/)(o1|o3|o4)-mini/.test(slug)) return false;
    if (/gpt-4o-mini-(tts|audio|transcribe|realtime|search)/.test(slug)) return false;
    if (/gpt-4o-(audio|realtime|transcribe|tts)/.test(slug)) return false;

    const visionFamilies = [
      /gpt-4o/,
      /gpt-4\.1/,
      /gpt-4-turbo/,
      /gpt-4-vision/,
      /chatgpt-4o/,
      /gpt-5/,
      /(^|\/)o1(\b|-)/,
      /(^|\/)o3(\b|-)/,
      /(^|\/)o4(\b|-)/,
      /claude-3/,
      /claude-(opus|sonnet|haiku|fable)-\d/,
      /gemini/,
      /-vl(\b|-)/,
      /qwen.*-vl/,
      /qwen2\.5-omni/,
      /llava/,
      /pixtral/,
      /llama-3\.2-(11|90)b/,
      /llama-4/,
      /internvl/,
      /deepseek-vl/,
      /molmo/,
      /phi-3-vision/,
      /phi-4-multimodal/,
      /mistral-small-3/,
      /grok-4/,
      /grok-2-vision/,
      /grok-vision/
    ];

    return visionFamilies.some((pattern) => pattern.test(slug));
  }

  function primeModelCatalog() {
    const result = spawnSync("prime", ["--plain", "inference", "models", "--output", "json"], {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024
    });

    if (result.error && result.error.code === "ENOENT") {
      return {
        models: [],
        source: "Prime CLI",
        checked_at: modelCatalogCheckedAt(),
        note: "The `prime` CLI is not installed — type a model id (e.g. openai/gpt-5-nano), or install it from docs.primeintellect.ai."
      };
    }

    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || "").trim().split("\n")[0];
      const authProblem = /401|token|login|unauthorized/i.test(detail);

      return {
        models: [],
        source: "Prime CLI",
        checked_at: modelCatalogCheckedAt(),
        note: authProblem
          ? "Prime is not logged in — run `prime login` in a terminal, then reopen this page. You can still type a model id (e.g. openai/gpt-5-nano)."
          : `Could not load the Prime model catalog (${detail || "unknown error"}). Type a model id instead.`
      };
    }

    try {
      const payload = JSON.parse(String(result.stdout || "{}"));
      const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
      const models = rows
        .map((row) => {
          const id = String(row.id || "");
          const slash = id.indexOf("/");

          return {
            id,
            label: slash === -1 ? id : id.slice(slash + 1),
            description: "",
            group: slash === -1 ? "other" : id.slice(0, slash),
            vision: primeModelVision(id),
            reasoning_levels: primeReasoningLevels(id),
            created_at: Number(row.created) || 0,
            pricing: row.pricing && typeof row.pricing === "object"
              ? {
                  input: Number(row.pricing.input_usd_per_mtok),
                  output: Number(row.pricing.output_usd_per_mtok)
                }
              : null
          };
        })
        .filter((model) => model.id);

      return {
        models,
        source: "Prime Inference live catalog",
        checked_at: modelCatalogCheckedAt(),
        default_model_id: models[0]?.id || "",
        note: models.length
          ? `${models.length} live models. Prices are USD per million tokens; image support is inferred from the model id and Prime reasoning is limited to off, low, medium, or high.`
          : "The Prime catalog came back empty — type a model id instead."
      };
    } catch (error) {
      return {
        models: [],
        source: "Prime CLI",
        checked_at: modelCatalogCheckedAt(),
        note: "Could not parse the Prime model catalog — type a model id instead."
      };
    }
  }

  function listProviderModels(provider, { fresh = false, harness = "none" } = {}) {
    const normalized = String(provider || "").toLowerCase();

    if (!["codex", "claude", "kimi", "prime"].includes(normalized)) {
      throw new Error(`Unknown provider "${provider}".`);
    }

    // Codex already maintains its own host-side cache. Always inspect it so
    // Maze Bench cannot add another ten minutes of staleness on top.
    if (normalized === "codex") {
      return codexModelCatalog();
    }

    const cached = fresh ? null : providerModelCache.get(normalized);

    if (cached && Date.now() < cached.expiresAt) {
      return normalized === "prime"
        ? filterPrimeCatalogForHarness(cached.value, harness)
        : cached.value;
    }

    const value = normalized === "claude"
      ? claudeModelCatalog()
      : normalized === "kimi"
        ? kimiModelCatalog()
        : primeModelCatalog();
    const ttl = value.models.length ? PROVIDER_MODEL_TTL_MS : PROVIDER_MODEL_ERROR_TTL_MS;

    providerModelCache.set(normalized, { value, expiresAt: Date.now() + ttl });
    return normalized === "prime" ? filterPrimeCatalogForHarness(value, harness) : value;
  }

  function listPrimeHarnesses() {
    return {
      harnesses: publicPrimeHarnesses(),
      verifiers_revision: VERIFIED_VERIFIERS_REVISION,
      verifiers_version: PRIME_HARNESS_CATALOG.verifiers_version,
      catalog_fingerprint: PRIME_HARNESS_CATALOG.catalog_fingerprint,
      certification: PRIME_HARNESS_CERTIFICATION.boundary,
      policy: PRIME_HARNESS_CATALOG.policy
    };
  }

  function normalizedGameForRun(gameId) {
    const game = getGame(String(gameId || "maze"));

    if (!game || !game.worldMap) {
      throw new Error(`"${gameId}" is not a runnable world.`);
    }

    return game;
  }

  function buildLocalRunArgs(runId, params, game) {
    const model = String(params.model || "").toLowerCase();

    if (!["codex", "claude", "kimi"].includes(model)) {
      throw new Error('model must be "codex", "claude", or "kimi".');
    }

    const levelId = String(params.level_id || worldMaps.defaultLevelIdForGame(game));

    if (!worldMaps.isMazeWorldLevelId(game.id, levelId)) {
      throw new Error(`"${levelId}" is not a level of ${game.name}.`);
    }

    const unlimited = params.unlimited === true || params.unlimited === "true";
    const moves = unlimited ? null : Math.max(1, Math.min(MAX_LOCAL_MOVE_BUDGET, Number(params.moves) || 20));
    const gems = GAME_WON_GEM_COUNT;
    const view = VIEW_NAMES.includes(String(params.view)) ? String(params.view) : "top-diagonal";
    const wantContainer = !(params.container === false || params.container === "false");
    const wantTools = params.tools === true || params.tools === "true";
    const requestedToolUse = String(params.tool_use || "").trim().toLowerCase();
    const toolUse = ["read-only", "offline"].includes(requestedToolUse)
      ? requestedToolUse
      : wantTools
        ? "offline"
        : "read-only";
    const autoRunTools = toolUse === "offline" &&
      !(params.auto_run_tools === false || params.auto_run_tools === "false");
    const autoRunAllFrames = autoRunTools &&
      !(params.auto_run_all_frames === false || params.auto_run_all_frames === "false");
    const swarm = model !== "kimi" && toolUse === "offline" && (params.swarm === true || params.swarm === "true");
    const allowQuit = !(params.allow_quit === false || params.allow_quit === "false");
    const autoQuit = normalizeAutoQuitConfig(params);
    const mode = normalizeObservationMode(params.mode);
    const omniscient = mode === "json" && (params.omniscient === true || params.omniscient === "true");
    const hideNames = mode !== "vision" && (params.hide_names === true || params.hide_names === "true");
    const hideNamesSeed = resolvedHideNamesSeed(hideNames, params.hide_names_seed);

    // Safety net for the UI toggle: container mode needs Docker installed AND
    // its daemon running.
    if (model === "kimi" && wantContainer) {
      throw new Error("Kimi Code local runs require container=false so MazeBench can apply the CLI's verified permission boundary.");
    }
    if (wantContainer && !dockerAvailable()) {
      throw new Error(
        dockerInstalled()
          ? "Container mode needs the Docker daemon running. Start Docker, or switch to Host access."
          : "Container mode needs Docker, which is not installed. Switch to Host access, or install Docker."
      );
    }
    const args = [
      `model=${model}`,
      `game=${game.id}`,
      `level=${levelId}`,
      `moves=${unlimited ? "unlimited" : moves}`,
      `unlimited=${unlimited ? "true" : "false"}`,
      `allow_quit=${allowQuit ? "true" : "false"}`,
      `gems=${gems}`,
      `view=${view}`,
      `mode=${mode}`,
      `omniscient=${omniscient ? "true" : "false"}`,
      `hide_names=${hideNames ? "true" : "false"}`,
      ...(hideNames ? [`hide_names_seed=${hideNamesSeed}`] : []),
      `tools=${toolUse === "read-only" ? "false" : "true"}`,
      `tool_use=${toolUse}`,
      `auto_run_tools=${autoRunTools ? "true" : "false"}`,
      `auto_run_all_frames=${autoRunAllFrames ? "true" : "false"}`,
      `swarm=${swarm ? "true" : "false"}`,
      `container=${params.container === false || params.container === "false" ? "false" : "true"}`,
      `video=${params.video === false || params.video === "false" ? "off" : "on"}`,
      `out=${runDirFor(runId)}`
    ];

    // Vision view distance: 1-26 rings of neighbor rooms or "world". Unset
    // keeps the classic 3x3 window the benchmark defaults to.
    if (params.vision_view !== undefined && String(params.vision_view).trim() !== "") {
      const rawView = String(params.vision_view).trim().toLowerCase();
      const rings = Number(rawView);
      const visionView =
        rawView === "world"
          ? "world"
          : Number.isFinite(rings)
            ? Math.max(1, Math.min(26, Math.floor(rings)))
            : null;

      if (visionView !== null) {
        args.push(`vision_view=${visionView}`);
      }
    }

    if (params.model_name) {
      args.push(`model_name=${String(params.model_name)}`);
    }

    if (params.reasoning) {
      const reasoning = String(params.reasoning).toLowerCase();

      if (model === "claude") {
        const exactModelId = resolveClaudeCatalogModelId(params.model_name);
        const supported = claudeReasoningLevels(exactModelId);

        if (exactModelId.startsWith("claude-") && !supported.includes(reasoning)) {
          throw new Error(
            supported.length
              ? `${exactModelId} supports Claude effort: ${supported.join(", ")}.`
              : `${exactModelId} does not support Claude effort. Choose off.`
          );
        }
      } else if (model === "kimi" && params.model_name) {
        const exact = listProviderModels("kimi", { fresh: false }).models.find(
          (entry) => String(entry.id) === String(params.model_name)
        );
        const supported = Array.isArray(exact?.reasoning_levels) ? exact.reasoning_levels : [];
        if (exact && supported.length && !supported.includes(reasoning)) {
          throw new Error(`${exact.id} supports Kimi effort: ${supported.join(", ")}.`);
        }
      }

      args.push(`reasoning=${reasoning}`);
    }

    if (params.codex_fast === true || params.codex_fast === "true") {
      args.push("codex_fast=true");
    }

    if (params.fast === true || params.fast === "true") {
      args.push("fast=true");
    }

    if (params.draft === true || params.draft === "true") {
      args.push("draft=true");
    }

    // Continue: resume the maze from a prior run's exact state. Both the runner
    // and the bridge rebuild state by replaying the action list, so copying the
    // prior session (and its per-move log) is enough — maze-agent-local.js sees
    // seed=true, skips the fresh `start`, and plays `moves` more from there.
    if (params.seed_run) {
      const priorDir = runDirFor(String(params.seed_run));
      const priorSession = path.join(priorDir, "session.json");

      if (fs.existsSync(priorSession)) {
        fs.copyFileSync(priorSession, path.join(runDirFor(runId), "session.json"));

        const priorActions = path.join(priorDir, "actions.jsonl");
        if (fs.existsSync(priorActions)) {
          fs.copyFileSync(priorActions, path.join(runDirFor(runId), "actions.jsonl"));
        }

        args.push("seed=true");
      }
    }

    // In-place continue: the session.json already lives in this run's dir, so
    // just resume the conversation (which also implies skipping the fresh start).
    if (params.resume_id) {
      args.push(`resume=${String(params.resume_id)}`);
    }
    if (params.fork_session) {
      args.push("fork_session=true");
    }
    if (params.session_id) {
      args.push(`session_id=${String(params.session_id)}`);
    }

    return { args, model, levelId, moves, gems, view, toolUse, autoRunTools, autoRunAllFrames, swarm, unlimited, allowQuit, autoQuit, mode, omniscient, hideNames, hideNamesSeed };
  }

  // Agent Runner defaults to a local Verifiers evaluator (while inference still
  // goes through Prime). Its PendingTurn hook can publish every resolved move
  // immediately. A hosted evaluation only publishes sample artifacts on the
  // platform's schedule, which can be after this single long rollout finishes.
  // Keep hosted execution as an API-level opt-in for evaluation workflows.
  function buildPrimeCommand(params, runDir, runId, game) {
    const harness = normalizePrimeHarness(params.harness);
    const definition = PRIME_HARNESSES.get(harness);
    if (!definition.launchable) throw new Error(definition.reason || UNSAFE_PRIME_AGENT_HARNESS_MESSAGE);
    const harnessConfig = normalizePrimeHarnessConfig(params.harness_config, harness);
    const model = String(params.model_name || params.model || "").trim();
    if (harness !== "none" && !primeHarnessModelCompatible(model, harness)) {
      const definition = PRIME_HARNESSES.get(harness);
      throw new Error(
        `${definition.label} requires a known-compatible Prime model using ${definition.protocol}. Choose a model from the displayed catalog.`
      );
    }
    const unlimited = params.unlimited === true || params.unlimited === "true";
    const maxTurns = unlimited ? null : positiveTurnBudget(params.max_turns);
    const mode = normalizeObservationMode(
      params.mode || (params.vision === true || params.vision === "true" ? "vision" : "text")
    );
    const vision = mode === "vision";
    if (!(definition.observation_modes || []).includes(mode)) {
      throw new Error(`${definition.label} does not support MazeBench ${mode} observations through its approved boundary.`);
    }
    const omniscient = mode === "json" && (params.omniscient === true || params.omniscient === "true");
    const hideNames = mode !== "vision" && (params.hide_names === true || params.hide_names === "true");
    const hideNamesSeed = resolvedHideNamesSeed(hideNames, params.hide_names_seed);
    const hosted = harness === "none" && !vision && (params.hosted === true || params.hosted === "true");
    const wantVideo = !(params.video === false || params.video === "false");
    const allowQuit = !(params.allow_quit === false || params.allow_quit === "false");
    const autoQuit = normalizeAutoQuitConfig(params);
    // Reasoning effort → --sampling.reasoning-effort. Prime's stable contract
    // is off/low/medium/high. "" omits the override and preserves the default.
    const requestedReasoning = String(params.reasoning || "").toLowerCase();
    const reasoning = primeReasoningLevels(model).includes(requestedReasoning)
      ? requestedReasoning
      : "";
    const envDir = path.join(rootDir, "environments", "mazebench");
    const levelId = String(params.level_id || "level_HxI");
    const gemTotal = buildWorlds.countWorldGems(game);

    const argv = [
      primeRunnerScript,
      "--env-dir",
      envDir,
      "--out",
      runDir,
      "--run-id",
      runId,
      "--harness",
      harness,
      "--harness-config-json",
      JSON.stringify(harnessConfig),
      "--level",
      levelId,
      "--game-won-gem-count",
      String(GAME_WON_GEM_COUNT)
    ];

    if (unlimited) {
      argv.push("--unlimited");
    } else {
      argv.push("--max-turns", String(maxTurns));
    }

    if (hosted) {
      argv.push("--hosted", "--environment", "mazebench/mazebench");
    }

    if (model) {
      argv.push("--model", model);
    }

    if (vision) {
      argv.push("--vision");
    } else if (mode === "json") {
      argv.push("--observation-mode", "json");
      if (omniscient) argv.push("--omniscient");
    }
    if (hideNames) argv.push("--hide-names", "--hide-names-seed", hideNamesSeed);

    if (reasoning) {
      argv.push("--reasoning", reasoning);
    }

    if (!allowQuit) {
      argv.push("--no-quit");
    }

    if (autoQuit.enabled) {
      argv.push(
        "--auto-quit",
        "--auto-quit-threshold",
        String(autoQuit.threshold),
        "--auto-quit-mode",
        autoQuit.mode,
        "--auto-quit-window",
        String(autoQuit.window)
      );
    }

    if (!wantVideo) {
      argv.push("--no-video");
    }
    if (params.resume_checkpoint) {
      argv.push("--resume-checkpoint", String(params.resume_checkpoint));
    }

    // A readable command string for the run page / logs (not the resolved path).
    const display = ["node", "scripts/maze-prime-run.js"]
      .concat(hosted ? ["--hosted"] : [])
      .concat(["--out", "<run>", "--harness", harness])
      .concat(Object.keys(harnessConfig).length ? ["--harness-config", JSON.stringify(harnessConfig)] : [])
      .concat(unlimited ? ["--unlimited"] : ["--max-turns", String(maxTurns)])
      .concat(model ? ["--model", model] : [])
      .concat(vision ? ["--vision"] : [])
      .concat(mode === "json" ? ["--observation-mode", "json"] : [])
      .concat(omniscient ? ["--omniscient"] : [])
      .concat(hideNames ? ["--hide-names", "--hide-names-seed", hideNamesSeed] : [])
      .concat(reasoning ? ["--reasoning", reasoning] : [])
      .concat(!allowQuit ? ["--no-quit"] : [])
      .concat(autoQuit.enabled
        ? [
            "--auto-quit",
            "--auto-quit-threshold",
            String(autoQuit.threshold),
            "--auto-quit-mode",
            autoQuit.mode,
            "--auto-quit-window",
            String(autoQuit.window)
          ]
        : [])
      .concat(params.resume_checkpoint ? ["--resume-checkpoint", "<run>/prime-resume.json"] : [])
      .join(" ");

    return {
      bin: process.execPath,
      argv,
      display,
      harness,
      harnessConfig,
      harnessLabel: definition.label,
      harnessBoundary: definition.boundary,
      harnessAdapter: definition.adapter || "user_simulator",
      runtimeHarnessId: definition.runtime_harness_id || definition.id,
      upstreamHarnessId: definition.upstream_id || null,
      harnessCatalogFingerprint: PRIME_HARNESS_CATALOG.catalog_fingerprint,
      verifiersVersion: PRIME_HARNESS_CATALOG.verifiers_version,
      runtimeImage: harness === "none" ? null : (vision ? "mcr.microsoft.com/playwright:v1.60.0-noble" : "node:24-bookworm-slim"),
      taskset: definition.taskset,
      model,
      maxTurns,
      unlimited,
      mode,
      vision,
      omniscient,
      hideNames,
      hideNamesSeed,
      hosted,
      levelId,
      gemTotal,
      reasoning,
      allowQuit,
      autoQuit,
      video: wantVideo
    };
  }

  function launchRun(params = {}) {
    const kind = String(params.kind || "local");
    if (kind !== "prime") requireLegacyLocalLaunch();
    const runId = generateRunId();
    const runDir = runDirFor(runId);

    ensureDirectory(runDir);

    const logPath = path.join(runDir, "launcher.log");
    const logFd = fs.openSync(logPath, "a");
    let child = null;
    let meta = null;
    let branchPreparation = null;

    try {
      if (kind === "prime") {
        let effectiveParams = params;
        if (params.resume_checkpoint) {
          const sourceCheckpoint = path.resolve(String(params.resume_checkpoint));
          if (!fileHasContent(sourceCheckpoint)) {
            throw new Error("The Prime resume checkpoint is missing or empty.");
          }
          const sourceDir = path.dirname(sourceCheckpoint);
          const targetCheckpoint = path.join(runDir, PRIME_RESUME_CHECKPOINT_FILE);
          fs.copyFileSync(sourceCheckpoint, targetCheckpoint);
          for (const name of [
            "actions.jsonl",
            "initial-status.json",
            "prime-reasoning.jsonl",
            "prime-usage.jsonl",
            "reasoning.json"
          ]) {
            const source = path.join(sourceDir, name);
            if (fs.existsSync(source)) fs.copyFileSync(source, path.join(runDir, name));
          }
          effectiveParams = { ...params, resume_checkpoint: targetCheckpoint };
        }
        const game = normalizedGameForRun("maze");
        const command = buildPrimeCommand(effectiveParams, runDir, runId, game);

        child = spawn(command.bin, command.argv, {
          cwd: rootDir,
          detached: true,
          env: enrichedPathEnv(),
          stdio: ["ignore", logFd, logFd]
        });
        meta = {
          id: runId,
          kind,
          created_at: new Date().toISOString(),
          status: "running",
          pid: child.pid,
          command: command.display,
          model: "prime",
          model_name: command.model || "(prime default)",
          harness: command.harness,
          harness_label: command.harnessLabel,
          harness_version: command.harnessConfig.version || null,
          harness_source: "pinned-prime-verifiers",
          harness_config: command.harnessConfig,
          harness_boundary: command.harnessBoundary,
          harness_adapter: command.harnessAdapter,
          harness_runtime_id: command.runtimeHarnessId,
          harness_upstream_id: command.upstreamHarnessId,
          harness_catalog_fingerprint: command.harnessCatalogFingerprint,
          harness_runtime_image: command.runtimeImage,
          harness_taskset: command.taskset,
          verifiers_version: command.verifiersVersion,
          verifiers_revision: VERIFIED_VERIFIERS_REVISION,
          game_id: "maze",
          game_title: "Maze Bench Environment",
          level_id: command.levelId,
          gem_total: command.gemTotal,
          room_total: game.worldMap?.levels?.length || 0,
          moves: command.maxTurns,
          unlimited: command.unlimited,
          mode: command.mode,
          vision: command.vision,
          omniscient: command.omniscient,
          hide_names: command.hideNames,
          hide_names_seed: command.hideNamesSeed,
          reasoning: command.reasoning,
          allow_quit: command.allowQuit,
          ...autoQuitLaunchParams(command.autoQuit),
          video: command.video,
          launch_params: {
            ...launchParamsOf(effectiveParams),
            ...autoQuitLaunchParams(command.autoQuit),
            unlimited: command.unlimited,
            harness: command.harness,
            harness_version: command.harnessConfig.version || null,
            harness_config: command.harnessConfig,
            harness_adapter: command.harnessAdapter,
            harness_runtime_id: command.runtimeHarnessId,
            harness_catalog_fingerprint: command.harnessCatalogFingerprint,
            verifiers_revision: VERIFIED_VERIFIERS_REVISION,
            ...(command.hideNames ? { hide_names_seed: command.hideNamesSeed } : {})
          },
          continue_of: params.continue_of || null,
          resumed_from: params.resume_source_run || null,
          resume_checkpoint_ready: Boolean(params.resume_checkpoint),
          resume_action_count: params.resume_checkpoint
            ? Math.max(0, Number(loadJson(path.join(runDir, PRIME_RESUME_CHECKPOINT_FILE), {})?.action_count) || 0)
            : 0,
          prime_execution: command.hosted ? "hosted" : "local",
          note: command.hosted
            ? "Prime Hosted Evaluation. Sample artifacts sync as Prime publishes them; per-turn streaming requires local Agent execution."
            : command.harness === "none"
              ? "Local Prime Verifiers evaluation using Prime inference. Moves, boards, reasoning, and usage stream into this page after every model turn."
              : `${command.harnessLabel} runs in a Prime sandbox and receives only MazeBench's isolated MCP game controls; the trusted evaluator retains game state and scoring.`
        };
      } else {
        let effectiveParams = params;
        if (params.branch_of) {
          const sourceMeta = readRunMeta(String(params.branch_of));
          if (!sourceMeta) throw new Error(`Unknown source run "${params.branch_of}".`);
          branchPreparation = prepareProviderBranch(
            String(params.branch_of),
            runId,
            sourceMeta,
            Math.max(0, Math.floor(Number(params.branch_turn) || 0))
          );
          effectiveParams = {
            ...params,
            resume_id: branchPreparation.resumeId,
            fork_session: branchPreparation.forkSession,
            session_id: branchPreparation.newConversationId
          };
        }

        requireLocalSubscription(effectiveParams);
        const game = normalizedGameForRun(effectiveParams.game_id);
        const { args, model, levelId, moves, gems, view, toolUse, autoRunTools, autoRunAllFrames, swarm, unlimited, allowQuit, autoQuit, mode, omniscient, hideNames, hideNamesSeed } = buildLocalRunArgs(runId, effectiveParams, game);
        const requestedModelName = String(effectiveParams.model_name || "");
        const exactModelName = model === "claude"
          ? resolveClaudeCatalogModelId(requestedModelName)
          : requestedModelName;
        const gemTotal = buildWorlds.countWorldGems(game);
        const roomTotal = game.worldMap?.levels?.length || 0;
        const segmentStartTurns = readActions(runId).length;

        child = spawn(process.execPath, [runnerScript, ...args], {
          cwd: rootDir,
          detached: true,
          env: localLaunchEnvironment(effectiveParams),
          stdio: ["ignore", logFd, logFd]
        });
        meta = {
          id: runId,
          kind: "local",
          created_at: new Date().toISOString(),
          status: "running",
          pid: child.pid,
          command: ["node", "scripts/maze-agent-local.js", ...args].join(" "),
          model,
          model_name: exactModelName,
          model_alias: exactModelName !== requestedModelName ? requestedModelName : "",
          reasoning: effectiveParams.reasoning || "",
          game_id: game.id,
          game_title: game.name,
          level_id: levelId,
          gem_total: gemTotal,
          room_total: roomTotal,
          moves: unlimited ? null : segmentStartTurns + moves,
          unlimited,
          allow_quit: allowQuit,
          ...autoQuitLaunchParams(autoQuit),
          segment_start_turns: segmentStartTurns,
          segment_move_budget: moves,
          gems,
          view,
          mode,
          omniscient,
          hide_names: hideNames,
          hide_names_seed: hideNamesSeed,
          tools: toolUse !== "read-only",
          tool_use: toolUse,
          auto_run_tools: autoRunTools,
          auto_run_all_frames: autoRunAllFrames,
          swarm,
          container: !(effectiveParams.container === false || effectiveParams.container === "false"),
          video: !(effectiveParams.video === false || effectiveParams.video === "false"),
          launch_params: {
            ...launchParamsOf(effectiveParams),
            ...autoQuitLaunchParams(autoQuit),
            ...(hideNames ? { hide_names_seed: hideNamesSeed } : {})
          },
          continue_of: effectiveParams.continue_of || null,
          branch_of: effectiveParams.branch_of || null,
          branch_turn: effectiveParams.branch_of ? segmentStartTurns : null,
          branch_provider_id: branchPreparation?.newConversationId || null,
          seeded: Boolean(effectiveParams.seed_run || effectiveParams.branch_of),
          conversation_persistence: !(effectiveParams.container === false || effectiveParams.container === "false")
            ? "run-dir"
            : "cli"
        };
      }
    } catch (error) {
      fs.closeSync(logFd);
      branchPreparation?.cleanup();
      fs.rmSync(runDir, { recursive: true, force: true });
      throw error;
    }

    fs.closeSync(logFd);
    meta.active_started_at = child ? meta.created_at : null;
    meta.active_elapsed_ms = 0;
    writeRunMeta(runId, meta);
    if (child) attachRunChild(runId, child);
    return summarizeRun(runId);
  }

  // Track a spawned run child and resolve its final status on exit. Shared by a
  // fresh launch and an in-place continue (which re-spawns into the same dir).
  function attachRunChild(runId, child) {
    child.unref();
    liveChildren.set(runId, child);
    startAutoQuitMonitor(runId);
    child.on("exit", (code) => {
      liveChildren.delete(runId);
      stopAutoQuitMonitor(runId);
      const current = readRunMeta(runId);

      if (!current) {
        return;
      }

      if (current.status === "stopped") {
        maybeSyncPrimeEvaluation(runId, current);
        return;
      }

      // Immediate pause finalizes metadata before the killed child is reaped;
      // its exit callback must not overwrite that resumable paused state.
      if (current.status === "paused") {
        maybeSyncPrimeEvaluation(runId, current);
        return;
      }

      let updated;
      if (current.status === "pausing") {
        // The provider saw the saved action result and ended its turn itself.
        // Its run-scoped transcript and maze files remain mounted in the run
        // directory; only the disposable process/container is released.
        stopLegacyClaudeSnapshots(runId);
        stopDetachedRunRenderers(runId, { force: true });
        updated = coldPausedRunMeta(current, { exit_code: code });
      } else if (current.status === "stopping") {
        // A user stop is terminal even when Docker/provider shutdown is clean
        // and therefore exits 0. Never relabel an explicitly stopped run as
        // naturally finished (or auto-continue it).
        updated = terminalRunMeta(current, current.auto_quit_triggered ? "finished" : "stopped", { exit_code: code });
      } else if (readProviderFailure(runId)) {
        // Claude Code can emit a structured API error while still exiting 0.
        // Treat the event artifact as authoritative, release the provider slot,
        // and retry this same saved thread after a resource-free backoff.
        updated = providerBackoffMeta(runId, current, readProviderFailure(runId), code);
      } else if (code === 0) {
        const continued = autoContinueBudgetTarget(runId, current);
        if (continued) return;
        updated = terminalRunMeta(current, "finished", { exit_code: code });
      } else {
        // Non-zero exit that isn't a user stop: if it's an out-of-funds/credits/
        // usage error, auto-pause (resumable) rather than fail it outright.
        const quota = detectQuotaPause(runId);
        const now = new Date().toISOString();
        updated = quota
          ? {
              ...current,
              status: "paused",
              pid: null,
              pause_reason: "quota",
              pause_mode: "cold",
              pause_message: quota.message,
              exit_code: code,
              paused_at: now,
              active_elapsed_ms: activeElapsedMs(current, Date.parse(now)),
              active_started_at: null
            }
          : terminalRunMeta(current, "failed", { exit_code: code, finished_at: now });
      }
      writeRunMeta(runId, updated);
      maybeSyncPrimeEvaluation(runId, updated);
      if (current.model === "claude") startNextWaitingClaudeRun();
    });
    child.on("error", (error) => {
      liveChildren.delete(runId);
      stopAutoQuitMonitor(runId);
      const current = readRunMeta(runId);
      if (!current || current.status === "paused") return;
      if (current.status === "pausing") {
        writeRunMeta(
          runId,
          coldPausedRunMeta(current, { pause_message: error instanceof Error ? error.message : String(error) })
        );
        return;
      }
      writeRunMeta(
        runId,
        terminalRunMeta(current, "failed", { launch_error: error instanceof Error ? error.message : String(error) })
      );
      maybeSyncPrimeEvaluation(runId, readRunMeta(runId));
      if (current.model === "claude") startNextWaitingClaudeRun();
    });
  }

  // Strip internal orchestration keys so meta.launch_params holds just the
  // config, ready to relaunch verbatim for a Continue.
  function launchParamsOf(params) {
    const {
      count,
      seed_run,
      continue_of,
      branch_of,
      branch_turn,
      resume_id,
      resume_checkpoint,
      resume_source_run,
      fork_session,
      session_id,
      ...rest
    } = params || {};
    return rest;
  }

  // Launch N runs of the same config at once. Local CLIs support parallel
  // sessions; provider subscription limits are enforced by their own service.
  function launchRuns(params = {}) {
    const count = Math.max(1, Math.min(8, Math.floor(Number(params.count) || 1)));

    const runs = [];
    for (let index = 0; index < count; index += 1) {
      runs.push(launchRun(params));
    }
    return runs;
  }

  function pauseRun(runId) {
    const meta = readRunMeta(runId);

    if (!meta) {
      throw new Error(`Unknown run "${runId}".`);
    }

    if (meta.status === "paused") {
      return summarizeRun(runId);
    }

    if (!["running", "pausing"].includes(meta.status)) return summarizeRun(runId);

    if (meta.kind === "prime") {
      throw new Error("Prime Intellect runs cannot be paused. Cancel the run instead.");
    }

    const turns = readActions(runId).length;
    const requestedAt = meta.pause_requested_at || new Date().toISOString();
    clearColdPauseMarkers(runId);
    fs.writeFileSync(
      path.join(runDirFor(runId), PAUSE_REQUEST_FILE),
      `${JSON.stringify({ requested_at: requestedAt, requested_after_turn: turns, mode: "immediate" }, null, 2)}\n`
    );
    const pausing = {
      ...meta,
      status: "pausing",
      pause_reason: "manual",
      pause_mode: "cold",
      pause_requested_at: requestedAt,
      pause_after_turn: undefined
    };
    writeRunMeta(runId, pausing);
    stopAutoQuitMonitor(runId);
    snapshotLegacyClaudeConversation(runId, meta, { force: true });
    stopLegacyClaudeSnapshots(runId);

    if (meta.container) {
      try {
        dockerRunControl(runId, ["rm", "-f"], "pause", { required: false });
      } catch (_error) {
        /* killing the outer process group below remains the fallback */
      }
    }

    stopDetachedRunRenderers(runId, { force: true });
    signalRunProcess(meta, "SIGKILL");
    liveChildren.delete(runId);

    const pausedAt = new Date().toISOString();
    reconcileInterruptedActionLogs(runId);
    settleInterruptedToolActivity(runId, pausedAt);
    const paused = coldPausedRunMeta(pausing, {
      pause_after_turn: undefined,
      pause_message: "Active model and tool work were cancelled immediately.",
      paused_at: pausedAt
    });
    writeRunMeta(runId, paused);
    if (meta.model === "claude") setImmediate(() => startNextWaitingClaudeRun());
    return summarizeRun(runId);
  }

  function resumeRun(runId) {
    let meta = readRunMeta(runId);

    if (!meta) {
      throw new Error(`Unknown run "${runId}".`);
    }
    if (meta.kind !== "prime") requireLegacyLocalLaunch();

    if (meta.kind === "prime" && ["paused", "failed"].includes(meta.status)) {
      const base = {
        ...(meta.launch_params || reconstructParams(meta)),
        kind: "prime",
        continue_of: runId,
        resume_source_run: runId
      };
      if (readActions(runId).length > 0) {
        base.resume_checkpoint = ensurePrimeResumeCheckpoint(runId);
      }
      if (meta.unlimited) {
        base.unlimited = true;
        delete base.max_turns;
      } else {
        base.unlimited = false;
        base.max_turns = Math.max(
          summarizeRun(runId)?.turns || 0,
          Math.floor(Number(meta.moves) || 20)
        );
      }
      return launchRun(base);
    }

    if (meta.status !== "paused") {
      return summarizeRun(runId);
    }

    meta = discardRunVideo(runId, meta);

    const needsRelaunch =
      ["quota", "provider_backoff"].includes(meta.pause_reason) ||
      meta.pause_mode === "cold" ||
      (!pidAlive(meta.pid) && !(meta.container && dockerRunAlive(runId)));

    if (!needsRelaunch && meta.container) {
      dockerRunControl(runId, ["unpause"], "resume");
      const { pause_reason, pause_message, pause_mode, pause_requested_at, pause_after_turn, paused_at, ...rest } = meta;
      writeRunMeta(runId, {
        ...rest,
        status: "running",
        active_started_at: new Date().toISOString(),
        active_elapsed_ms: activeElapsedMs(meta)
      });
      startLegacyClaudeSnapshots(runId);
      return summarizeRun(runId);
    }

    // A manually-paused run still has a live (stopped) process — just continue it.
    if (!needsRelaunch && pidAlive(meta.pid)) {
      signalRunProcess(meta, "SIGCONT");

      if (pidAlive(meta.pid)) {
        const { pause_reason, pause_message, pause_mode, pause_requested_at, pause_after_turn, paused_at, ...rest } = meta;
        writeRunMeta(runId, {
          ...rest,
          status: "running",
          active_started_at: new Date().toISOString(),
          active_elapsed_ms: activeElapsedMs(meta)
        });
        startLegacyClaudeSnapshots(runId);
        return summarizeRun(runId);
      }
    }

    // A quota/provider backoff pause (or a process that died while paused) has no process to
    // resume, so relaunch a continuation from where it left off with whatever
    // move budget remains.
    const summary = summarizeRun(runId);
    const remaining = Math.max(1, (Number(meta.moves) || 20) - (summary.turns || 0));
    return continueRun(runId, remaining);
  }

  // Rebuild launch params from a run's own metadata — the fallback for runs
  // created before launch_params was recorded, so any run can still be continued.
  function reconstructParams(meta) {
    if (meta.kind === "prime") {
      const model = meta.model_name && meta.model_name !== "(prime default)" ? meta.model_name : "";
      return {
        kind: "prime",
        harness: meta.harness || "none",
        harness_config: meta.harness_config || {},
        model_name: model,
        mode: normalizeObservationMode(meta.mode),
        vision: meta.mode === "vision",
        omniscient: Boolean(meta.omniscient),
        hide_names: Boolean(meta.hide_names),
        hide_names_seed: normalizedHideNamesSeed(meta.hide_names_seed),
        reasoning: meta.reasoning || "",
        unlimited: Boolean(meta.unlimited),
        allow_quit: meta.allow_quit !== false,
        ...autoQuitLaunchParams(meta),
        video: meta.video !== false
      };
    }

    return {
      kind: "local",
      model: meta.model,
      model_name: meta.model_name || "",
      game_id: meta.game_id,
      level_id: meta.level_id,
      mode: meta.mode,
      omniscient: Boolean(meta.omniscient),
      hide_names: Boolean(meta.hide_names),
      hide_names_seed: normalizedHideNamesSeed(meta.hide_names_seed),
      reasoning: meta.reasoning || "",
      unlimited: Boolean(meta.unlimited),
      allow_quit: meta.allow_quit !== false,
      ...autoQuitLaunchParams(meta),
      container: meta.container !== false,
      video: meta.video !== false,
      tools: Boolean(meta.tools),
      tool_use: ["read-only", "offline"].includes(meta.tool_use)
        ? meta.tool_use
        : meta.tools
          ? "offline"
          : "read-only",
      auto_run_tools: Boolean(meta.auto_run_tools),
      auto_run_all_frames: Boolean(meta.auto_run_all_frames),
      swarm: Boolean(meta.swarm),
      gems: meta.gems,
      view: meta.view
    };
  }

  // The CLI conversation id captured in a run's event stream — codex emits
  // `thread.started` with a thread_id, claude tags every event with session_id.
  function readConversationId(runId) {
    const eventsPath = path.join(runDirFor(runId), "agent-events.jsonl");

    if (!fs.existsSync(eventsPath)) {
      return "";
    }

    for (const line of fs.readFileSync(eventsPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);
        const id = event.thread_id || event.session_id;
        if (id) return String(id);
      } catch (_error) {
        /* skip non-JSON lines */
      }
    }

    return "";
  }

  function providerConversationFile(runId, meta, conversationId) {
    const runState = path.join(runDirFor(runId), "agent-state");
    if (meta.model === "codex") {
      const runFile = findCodexSessionFile(path.join(runState, "codex"), conversationId);
      if (runFile) return runFile;
      if (meta.container) return "";
      return findCodexSessionFile(
        process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
        conversationId
      );
    }

    if (meta.model === "claude") {
      let runFile = findClaudeSessionFile(path.join(runState, "claude"), conversationId);
      if (!runFile && meta.container) {
        snapshotLegacyClaudeConversation(runId, meta, { force: true });
        runFile = findClaudeSessionFile(path.join(runState, "claude"), conversationId);
      }
      if (runFile) return runFile;
      if (meta.container) return "";
      return findClaudeSessionFile(
        process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
        conversationId
      );
    }

    return "";
  }

  function copyBranchFrames(sourceDir, targetDir, turn) {
    const sourceFrames = path.join(sourceDir, "frames");
    if (!fs.existsSync(sourceFrames)) return;
    const targetFrames = path.join(targetDir, "frames");
    for (const entry of fs.readdirSync(sourceFrames, { withFileTypes: true })) {
      const match = entry.isFile() && entry.name.match(/^(?:frame|live)-(\d+)\.png$/);
      if (!match || Number(match[1]) > turn) continue;
      fs.mkdirSync(targetFrames, { recursive: true });
      fs.copyFileSync(path.join(sourceFrames, entry.name), path.join(targetFrames, entry.name));
    }
  }

  function prepareMazeBranchPrefix(sourceRunId, targetRunId, turn, oldConversationId, newConversationId, model) {
    const sourceDir = runDirFor(sourceRunId);
    const targetDir = runDirFor(targetRunId);
    const sourceSession = loadJson(path.join(sourceDir, "session.json"), null);
    if (!sourceSession || !Array.isArray(sourceSession.actions)) {
      throw new Error("This run has no replayable maze session to branch.");
    }

    const actionLines = fs.existsSync(path.join(sourceDir, "actions.jsonl"))
      ? fs.readFileSync(path.join(sourceDir, "actions.jsonl"), "utf8").split("\n").filter(Boolean)
      : [];
    if (turn > sourceSession.actions.length || turn > actionLines.length) {
      throw new Error(`Action ${turn} is outside this run's saved ${Math.min(sourceSession.actions.length, actionLines.length)}-action prefix.`);
    }

    const actions = sourceSession.actions.slice(0, turn);
    const session = {
      ...sourceSession,
      actions,
      lastStatus: turn > 0 ? actions[turn - 1]?.status || sourceSession.initial : sourceSession.initial
    };
    delete session.scorecard;
    fs.writeFileSync(path.join(targetDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
    fs.writeFileSync(
      path.join(targetDir, "actions.jsonl"),
      turn > 0 ? `${actionLines.slice(0, turn).join("\n")}\n` : ""
    );

    const initialStatus = path.join(sourceDir, "initial-status.json");
    if (fs.existsSync(initialStatus)) fs.copyFileSync(initialStatus, path.join(targetDir, "initial-status.json"));
    else if (sourceSession.initial) {
      fs.writeFileSync(path.join(targetDir, "initial-status.json"), `${JSON.stringify(sourceSession.initial, null, 2)}\n`);
    }

    const sourceEvents = path.join(sourceDir, "agent-events.jsonl");
    const eventPrefix = fs.existsSync(sourceEvents)
      ? providerEventPrefix(
          fs.readFileSync(sourceEvents, "utf8"),
          model,
          turn,
          oldConversationId,
          newConversationId
        )
      : "";
    fs.writeFileSync(path.join(targetDir, "agent-events.jsonl"), eventPrefix);

    const sourceActivity = path.join(sourceDir, "tool-activity.jsonl");
    if (fs.existsSync(sourceActivity)) {
      const activity = toolActivityPrefix(fs.readFileSync(sourceActivity, "utf8"), turn);
      if (activity) fs.writeFileSync(path.join(targetDir, "tool-activity.jsonl"), activity);
    }
    copyBranchFrames(sourceDir, targetDir, turn);
  }

  function prepareProviderBranch(sourceRunId, targetRunId, meta, turn) {
    const oldConversationId = readConversationId(sourceRunId);
    if (!oldConversationId) {
      throw new Error("This run did not save a Codex or Claude conversation id.");
    }
    const sourceFile = providerConversationFile(sourceRunId, meta, oldConversationId);
    if (!sourceFile) {
      throw new Error(
        `The saved ${meta.model === "codex" ? "Codex" : "Claude"} transcript is unavailable, so its context prefix cannot be restored.`
      );
    }

    const targetDir = runDirFor(targetRunId);
    const newConversationId = crypto.randomUUID();
    const sourceText = fs.readFileSync(sourceFile, "utf8");
    const cleanupPaths = [];
    let resumeId = newConversationId;
    let forkSession = false;
    let destination;

    if (meta.model === "codex") {
      const root = meta.container
        ? path.join(targetDir, "agent-state", "codex")
        : process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
      const now = new Date();
      const destinationDir = path.join(
        root,
        "sessions",
        String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0")
      );
      const sourceName = path.basename(sourceFile);
      const destinationName = sourceName.includes(oldConversationId)
        ? sourceName.replace(oldConversationId, newConversationId)
        : `rollout-${timestampSlug()}-${newConversationId}.jsonl`;
      destination = path.join(destinationDir, destinationName);
      fs.mkdirSync(destinationDir, { recursive: true });
      fs.writeFileSync(destination, codexTranscriptPrefix(sourceText, turn, newConversationId));
    } else {
      const claudeHome = meta.container
        ? path.join(targetDir, "agent-state", "claude")
        : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
      const providerCwd = meta.container ? "/app/workspace" : path.join(targetDir, "workspace");
      const destinationDir = path.join(claudeHome, "projects", claudeProjectKey(providerCwd));
      destination = path.join(destinationDir, `${oldConversationId}.jsonl`);
      fs.mkdirSync(destinationDir, { recursive: true });
      fs.writeFileSync(destination, claudeTranscriptPrefix(sourceText, turn));
      resumeId = oldConversationId;
      forkSession = true;
    }

    if (!destination.startsWith(`${targetDir}${path.sep}`)) cleanupPaths.push(destination);
    prepareMazeBranchPrefix(
      sourceRunId,
      targetRunId,
      turn,
      oldConversationId,
      newConversationId,
      meta.model
    );

    return {
      cleanup() {
        for (const filePath of cleanupPaths) {
          fs.rmSync(filePath, { force: true });
          try {
            const directory = path.dirname(filePath);
            if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
          } catch (_error) {
            /* another provider session now owns the directory */
          }
        }
      },
      forkSession,
      newConversationId,
      resumeId
    };
  }

  function hasPersistedContainerConversation(runId, meta, conversationId) {
    if (!meta.container || !conversationId) return false;
    const stateRoot = path.join(runDirFor(runId), "agent-state");

    if (meta.model === "codex") {
      return Boolean(findCodexSessionFile(path.join(stateRoot, "codex"), conversationId));
    }

    if (meta.model === "claude") {
      return Boolean(findClaudeSessionFile(path.join(stateRoot, "claude"), conversationId));
    }

    return false;
  }

  // A true continue: re-spawn the agent into the SAME run dir with the CLI
  // conversation resumed, so the model keeps its full memory and the maze keeps
  // its state (both live here). The run itself is extended in place.
  function continueLocalInPlace(runId, meta, add, conversationId) {
    requireLegacyLocalLaunch();
    const runDir = runDirFor(runId);
    clearColdPauseMarkers(runId);
    clearColdPauseCapability(runId);
    const segmentStartTurns = readActions(runId).length;
    const params = meta.launch_params || reconstructParams(meta);
    const game = normalizedGameForRun(params.game_id);
    const { args } = buildLocalRunArgs(runId, { ...params, moves: add, resume_id: conversationId }, game);
    const nextMeta = {
      ...meta,
      moves: meta.unlimited ? null : (Number(meta.moves) || 0) + Number(add || 0),
      continued: (meta.continued || 0) + 1,
      segment_start_turns: segmentStartTurns,
      segment_move_budget: meta.unlimited ? null : add,
      command: ["node", "scripts/maze-agent-local.js", ...args].join(" ")
    };

    const logFd = fs.openSync(path.join(runDir, "launcher.log"), "a");
    let child;

    try {
      child = spawn(process.execPath, [runnerScript, ...args], {
        cwd: rootDir,
        detached: true,
        env: localLaunchEnvironment(params),
        stdio: ["ignore", logFd, logFd]
      });
    } finally {
      fs.closeSync(logFd);
    }

    writeRunMeta(runId, {
      ...nextMeta,
      status: "running",
      pid: child.pid,
      exit_code: undefined,
      finished_at: undefined,
      pause_reason: undefined,
      pause_message: undefined,
      pause_mode: undefined,
      pause_requested_at: undefined,
      pause_after_turn: undefined,
      paused_at: undefined,
      retry_at: undefined,
      active_started_at: new Date().toISOString(),
      active_elapsed_ms: activeElapsedMs(meta)
    });
    attachRunChild(runId, child);
    return summarizeRun(runId);
  }

  function setRunMoveTarget(runId, requestedTarget) {
    const meta = readRunMeta(runId);
    if (!meta) throw new Error(`Unknown run "${runId}".`);
    if (meta.kind === "prime") throw new Error("Prime eval budgets cannot be changed while running.");
    requireLegacyLocalLaunch();

    const turns = readActions(runId).length;
    const requested = Math.floor(Number(requestedTarget));
    if (!Number.isFinite(requested) || requested <= turns) {
      throw new Error(`Move target must be greater than the ${turns} actions already played.`);
    }
    const target = Math.min(MAX_LOCAL_MOVE_BUDGET, requested);

    const next = {
      ...meta,
      moves: target,
      unlimited: false,
      auto_continue_target: target,
      segment_start_turns: Math.max(0, Math.floor(Number(meta.segment_start_turns) || 0)),
      segment_move_budget: Math.max(1, Math.floor(Number(meta.segment_move_budget) || Number(meta.moves) || 20)),
      launch_params: {
        ...(meta.launch_params || reconstructParams(meta)),
        moves: target,
        unlimited: false
      }
    };
    writeRunMeta(runId, next);
    return summarizeRun(runId);
  }

  function continueRun(runId, additionalMoves) {
    const meta = readRunMeta(runId);

    if (!meta) {
      throw new Error(`Unknown run "${runId}".`);
    }
    if (meta.auto_quit_triggered) {
      throw new Error("This run ended by Auto-Quit. Branch from an earlier action to try a different route.");
    }

    const requestedAdd = positiveTurnBudget(additionalMoves);
    const add = meta.kind === "prime"
      ? requestedAdd
      : Math.min(MAX_LOCAL_MOVE_BUDGET, requestedAdd);

    if (meta.kind === "prime") {
      const checkpoint = ensurePrimeResumeCheckpoint(runId);
      const currentTurns = summarizeRun(runId)?.turns || 0;
      const base = {
        ...(meta.launch_params || reconstructParams(meta)),
        continue_of: runId,
        kind: "prime",
        resume_checkpoint: checkpoint,
        resume_source_run: runId,
        unlimited: false,
        max_turns: Math.max(currentTurns, Math.floor(Number(meta.moves) || 0)) + add
      };
      return launchRun(base);
    }
    requireLegacyLocalLaunch();

    // Resume the same CLI conversation in the same run directory. Host agents
    // use their normal CLI session store; new Docker runs keep a private,
    // run-scoped session store under agent-state/ and mount it into every
    // replacement container. Older Docker runs without that store fall back to
    // a maze-state-only continuation because their model transcript is gone.
    const conversationId = readConversationId(runId);
    const canResumeConversation =
      Boolean(conversationId) &&
      (meta.container === false || hasPersistedContainerConversation(runId, meta, conversationId));
    if (canResumeConversation) {
      return continueLocalInPlace(runId, discardRunVideo(runId, meta), add, conversationId);
    }

    const base = {
      ...(meta.launch_params || reconstructParams(meta)),
      continue_of: runId,
      kind: "local",
      moves: add,
      seed_run: runId
    };
    return launchRun(base);
  }

  function branchRun(runId, requestedTurn) {
    const meta = readRunMeta(runId);
    if (!meta) throw new Error(`Unknown run "${runId}".`);
    if (meta.kind === "prime") {
      throw new Error("Prime evaluations do not expose a resumable provider transcript.");
    }
    requireLegacyLocalLaunch();
    if (!["codex", "claude"].includes(meta.model)) {
      throw new Error("Only Codex and Claude runs can preserve a provider context prefix.");
    }
    if (meta.swarm) {
      throw new Error("Swarm rollback is not safe yet because worker conversation prefixes cannot be restored consistently.");
    }
    if (!["paused", "finished", "stopped", "failed"].includes(meta.status)) {
      throw new Error("Pause or stop the run before branching from an action.");
    }

    const total = readActions(runId).length;
    const turn = Math.floor(Number(requestedTurn));
    if (!Number.isFinite(turn) || turn < 0 || turn > total) {
      throw new Error(`Choose an action from 0 through ${total}.`);
    }
    const base = branchLaunchParams(meta, meta.launch_params || reconstructParams(meta), runId, turn);
    return launchRun(base);
  }

  function generateRunVideo(runId) {
    const meta = readRunMeta(runId);

    if (!meta) {
      throw new Error(`Unknown run "${runId}".`);
    }

    if (!["paused", "finished", "stopped", "failed"].includes(meta.status)) {
      throw new Error("Pause or end the run before generating a replay video.");
    }

    const runDir = runDirFor(runId);
    const videoPath = path.join(runDir, "maze_replay.mp4");
    if (fs.existsSync(videoPath)) {
      return summarizeRun(runId);
    }

    const activeVideo = videoChildren.get(runId);
    if (activeVideo || (meta.video_status === "rendering" && pidAlive(meta.video_pid))) {
      return summarizeRun(runId);
    }

    const sessionPath = path.join(runDir, "session.json");
    const resultsPath = findPrimeResultsFile(runDir);
    const actionsPath = path.join(runDir, "actions.jsonl");
    // actions.jsonl is the trusted evaluator's authoritative record. It also
    // marks rejected attempts, which must remain visual no-ops; replaying raw
    // model completions from results.jsonl can otherwise switch to a room the
    // agent was never allowed to visit.
    const replayInputPath = fileHasContent(actionsPath)
      ? actionsPath
      : fs.existsSync(sessionPath)
        ? sessionPath
        : fileHasContent(resultsPath)
          ? resultsPath
          : "";
    if (!replayInputPath) {
      throw new Error("This run has no completed eval result, saved session, or action log to render.");
    }

    const snapshotTurns = readActions(runId).length;
    const generationId = crypto.randomUUID();
    fs.writeFileSync(
      path.join(runDir, "replay-progress.json"),
      `${JSON.stringify({ phase: "starting", percent: 0, current: 0, total: snapshotTurns, unit: "actions", eta_ms: null })}\n`
    );

    const logFd = fs.openSync(path.join(runDir, "launcher.log"), "a");
    let child;
    try {
      const videoArgs = [
        replayScript,
        replayInputPath,
        "--out-dir", runDir,
        "--fps", "24",
        // The native recorder produces a high-bitrate intermediate. The replay
        // exporter applies this quality setting to every final MP4 and enforces
        // a Pages-safe ceiling for unusually long runs.
        "--crf", "25",
        "--max-video-mib", "24",
        "--preset", "veryfast",
        "--tail-seconds", "1",
        "--accelerated",
        "--intro"
      ];
      if (normalizeObservationMode(meta.mode) === "text") {
        videoArgs.push("--width", "1280", "--height", "720", "--ascii-side-by-side");
      } else {
        videoArgs.push("--width", "960", "--height", "960");
      }
      child = spawn(
        process.execPath,
        videoArgs,
        {
          cwd: rootDir,
          detached: true,
          env: enrichedPathEnv(),
          stdio: ["ignore", logFd, logFd]
        }
      );
    } finally {
      fs.closeSync(logFd);
    }

    const { video_error: _previousVideoError, ...cleanMeta } = meta;
    writeRunMeta(runId, {
      ...cleanMeta,
      video_generation_id: generationId,
      video_pid: child.pid,
      video_snapshot_turns: snapshotTurns,
      video_status: "rendering"
    });

    child.unref();
    videoChildren.set(runId, child);
    let settled = false;
    const finish = (code, spawnError = null) => {
      if (settled) return;
      settled = true;
      videoChildren.delete(runId);
      const current = readRunMeta(runId);
      if (!current || current.video_generation_id !== generationId) return;

      const rendered = fs.existsSync(videoPath);
      const { video_pid: _videoPid, ...rest } = current;
      writeRunMeta(runId, {
        ...rest,
        video_generation_id: undefined,
        video_status: rendered ? "ready" : "failed",
        ...(rendered
          ? { video_error: undefined }
          : { video_error: spawnError?.message || `Video renderer exited with status ${code ?? "unknown"}.` })
      });
    };
    child.on("exit", (code) => finish(code));
    child.on("error", (error) => finish(null, error));

    return summarizeRun(runId);
  }

  function discardRunVideo(runId, meta = readRunMeta(runId)) {
    if (!meta) return meta;
    const runDir = runDirFor(runId);
    const activeVideo = videoChildren.get(runId);
    const hasArtifacts = Boolean(
      activeVideo ||
      meta.video_status ||
      meta.video_pid ||
      fs.existsSync(path.join(runDir, "maze_replay.mp4")) ||
      fs.existsSync(path.join(runDir, "replay-progress.json"))
    );
    if (!hasArtifacts) return meta;

    const terminateRenderer = (pid) => {
      try {
        process.kill(-pid, "SIGTERM");
      } catch (_error) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (_innerError) {
          /* renderer already exited */
        }
      }
      const forceTimer = setTimeout(() => {
        if (!/maze-export-replay\.js/.test(processCommand(pid))) return;
        try {
          process.kill(-pid, "SIGKILL");
        } catch (_error) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (_innerError) {
            /* renderer already exited */
          }
        }
      }, 3500);
      forceTimer.unref?.();
    };
    if (activeVideo?.pid) {
      terminateRenderer(activeVideo.pid);
    } else if (meta.video_pid && pidAlive(meta.video_pid)) {
      terminateRenderer(meta.video_pid);
    }
    videoChildren.delete(runId);
    fs.rmSync(path.join(runDir, "maze_replay.mp4"), { force: true });
    fs.rmSync(path.join(runDir, "replay-progress.json"), { force: true });
    fs.rmSync(path.join(runDir, ".maze_replay_frames"), { force: true, recursive: true });

    const {
      video_error: _videoError,
      video_generation_id: _videoGenerationId,
      video_pid: _videoPid,
      video_snapshot_turns: _videoSnapshotTurns,
      video_status: _videoStatus,
      ...cleanMeta
    } = meta;
    writeRunMeta(runId, cleanMeta);
    return cleanMeta;
  }

  function cancelRunVideo(runId) {
    const meta = readRunMeta(runId);
    if (!meta) throw new Error(`Unknown run "${runId}".`);
    if (meta.video_status !== "rendering" && !videoChildren.has(runId)) {
      return summarizeRun(runId);
    }
    discardRunVideo(runId, meta);
    return summarizeRun(runId);
  }

  function regenerateRunVideo(runId) {
    const meta = readRunMeta(runId);
    if (!meta) throw new Error(`Unknown run "${runId}".`);
    if (!["paused", "finished", "stopped", "failed"].includes(meta.status)) {
      throw new Error("Pause or end the run before regenerating its replay video.");
    }
    discardRunVideo(runId, meta);
    return generateRunVideo(runId);
  }

  function cancelPrimeEvaluation(runId) {
    const state = readPrimeEvaluation(runId);
    const evaluationId = String(state?.evaluation_id || state?.id || "");
    const status = String(state?.status || "").toUpperCase();
    if (!evaluationId || ["CANCELLED", "COMPLETED", "FAILED", "STOPPED"].includes(status)) return false;

    const result = spawnSync("prime", ["eval", "stop", evaluationId, "--plain"], {
      cwd: rootDir,
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024
    });
    const updated = {
      ...state,
      status: result.status === 0 ? "STOPPED" : state.status,
      stopped_at: result.status === 0 ? new Date().toISOString() : state.stopped_at,
      ...(result.status === 0
        ? { stop_error: undefined }
        : { stop_error: String(result.stderr || result.stdout || "Prime evaluation cancellation failed.").trim() })
    };
    fs.writeFileSync(
      path.join(runDirFor(runId), "prime-evaluation.json"),
      `${JSON.stringify(updated, null, 2)}\n`,
      "utf8"
    );
    return result.status === 0;
  }

  function stopPrimeAgentSandboxes(runId) {
    const runDir = runDirFor(runId);
    const ids = new Set();
    for (const filePath of [
      path.join(runDir, "launcher.log"),
      path.join(runDir, "eval-output", "eval.log")
    ]) {
      try {
        primeSandboxIdsFromText(fs.readFileSync(filePath, "utf8")).forEach((id) => ids.add(id));
      } catch (_error) {
        /* the sandbox may not have started or logged its id yet */
      }
    }
    if (!ids.size) return false;

    const sandboxIds = [...ids];
    const result = spawnSync(
      "prime",
      ["sandbox", "delete", ...sandboxIds, "--yes", "--plain"],
      {
        cwd: rootDir,
        encoding: "utf8",
        env: enrichedPathEnv(),
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024
      }
    );
    const record = {
      sandbox_ids: sandboxIds,
      stopped_at: result.status === 0 ? new Date().toISOString() : null,
      error: result.status === 0
        ? null
        : String(result.stderr || result.stdout || "Prime sandbox cleanup failed.").trim()
    };
    try {
      fs.writeFileSync(
        path.join(runDir, "prime-sandbox-cleanup.json"),
        `${JSON.stringify(record, null, 2)}\n`,
        "utf8"
      );
    } catch (_error) {
      /* cleanup must still proceed when its audit record cannot be written */
    }
    return result.status === 0;
  }

  function deleteRun(runId) {
    const meta = readRunMeta(runId);
    const runDir = runDirFor(runId);
    const agentWorkspaceRoot = agentWorkspaceRootFor(runId);

    const primeSync = primeSyncChildren.get(runId);
    if (primeSync?.pid) {
      try {
        primeSync.kill("SIGTERM");
      } catch (_error) {
        /* sync process already exited */
      }
      primeSyncChildren.delete(runId);
    }
    const reviewer = reviewChildren.get(runId);
    if (reviewer?.pid) {
      try {
        reviewer.kill("SIGTERM");
      } catch (_error) {
        /* reviewer already exited */
      }
      reviewChildren.delete(runId);
    }

    if (meta?.kind === "prime" && ["running", "stopping"].includes(meta.status)) {
      cancelPrimeEvaluation(runId);
      stopPrimeAgentSandboxes(runId);
    }

    // Remove the daemon-owned container first; killing only the attached docker
    // client can otherwise leave the agent running after its card disappears.
    if (meta?.container && meta.status !== "waiting") {
      try {
        dockerRunControl(runId, ["rm", "-f"], "delete", { required: false });
      } catch (_error) {
        /* the container may already have exited and removed itself */
      }
    }

    // Kill any still-live (or paused) host process before removing its directory.
    if (meta && meta.pid && pidAlive(meta.pid)) {
      signalRunProcess(meta, "SIGKILL");
    }

    const videoChild = videoChildren.get(runId);
    if (videoChild?.pid) {
      try {
        process.kill(-videoChild.pid, "SIGKILL");
      } catch (_error) {
        try {
          process.kill(videoChild.pid, "SIGKILL");
        } catch (_innerError) {
          /* renderer already exited */
        }
      }
      videoChildren.delete(runId);
    }

    liveChildren.delete(runId);
    stopAutoQuitMonitor(runId);
    stopLegacyClaudeSnapshots(runId);
    actionCache.delete(runId);
    reasoningCache.delete(runId);
    toolActivityCache.delete(runId);
    toolWorkspaceCache.delete(runId);
    tokenUsageCache.delete(runId);
    primeRolloutFailureCache.delete(runId);
    initialPlayerCache.delete(runId);
    for (const filePath of jsonLineIndexes.keys()) {
      if (filePath.startsWith(`${runDir}${path.sep}`)) jsonLineIndexes.delete(filePath);
    }
    fs.rmSync(agentWorkspaceRoot, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
    if (meta?.model === "claude") startNextWaitingClaudeRun();
    return { id: runId, deleted: true };
  }

  function stopRun(runId) {
    const meta = readRunMeta(runId);

    if (!meta) {
      throw new Error(`Unknown run "${runId}".`);
    }

    // Local providers have one resumable lifecycle control. "Stop" is kept as
    // an API compatibility alias, but it now requests the same immediate cold
    // pause. Prime rollouts remain cancellable because they cannot resume.
    if (meta.kind !== "prime" && ["running", "pausing", "paused"].includes(meta.status)) {
      return pauseRun(runId);
    }

    const terminalButAlive = !["running", "stopping", "paused"].includes(meta.status) &&
      (pidAlive(meta.pid) || (meta.container && dockerRunAlive(runId)));
    if (
      meta.status !== "running" &&
      meta.status !== "stopping" &&
      !(meta.status === "paused" && meta.pause_reason === "manual") &&
      !terminalButAlive
    ) {
      if (meta.status === "stopped") {
        // Stop is idempotent and doubles as a cleanup sweep. This matters when
        // a server restart observed the dead runner and finalized metadata
        // before it could reap detached renderers or their marker files.
        stopLegacyClaudeSnapshots(runId);
        stopDetachedRunRenderers(runId, { force: true });
        if (meta.container) {
          try {
            dockerRunControl(runId, ["rm", "-f"], "clean up", { required: false });
          } catch (_error) {
            /* already removed */
          }
        }
        signalRunProcess(meta, "SIGKILL");
        if (meta.kind === "prime") stopPrimeAgentSandboxes(runId);
      }
      return summarizeRun(runId);
    }

    writeRunMeta(runId, { ...meta, status: "stopping" });
    stopAutoQuitMonitor(runId);
    if (meta.kind === "prime") cancelPrimeEvaluation(runId);
    if (meta.kind === "prime") stopPrimeAgentSandboxes(runId);
    stopLegacyClaudeSnapshots(runId);

    if (meta.container) {
      if (meta.status === "paused") {
        // Docker requires a paused container to be unpaused before graceful stop.
        try {
          dockerRunControl(runId, ["unpause"], "resume before stopping");
        } catch (_error) {
          /* it may already have resumed or exited */
        }
      }

      try {
        dockerRunControl(runId, ["stop", "-t", "2"], "stop", { required: false });
      } catch (_error) {
        // If graceful stop failed, force-remove the whole container so daemon-
        // owned descendants cannot survive their attached docker client.
        try {
          dockerRunControl(runId, ["rm", "-f"], "force stop", { required: false });
        } catch (_innerError) {
          /* already removed or Docker is unavailable */
        }
      }
    } else if (meta.status === "paused") {
      signalRunProcess(meta, "SIGCONT");
    }

    // Docker owns everything inside a container. Host vision daemons are
    // detached by design, so clean their process groups explicitly too.
    stopDetachedRunRenderers(runId, { force: true });

    // Stop is intentionally final, not graceful pausing. Force-reap the outer
    // process group after Docker/provider cleanup so no shell, solver, worker,
    // or fallback renderer can linger. Record the terminal state immediately;
    // a late child exit callback explicitly preserves it.
    signalRunProcess(meta, "SIGKILL");
    liveChildren.delete(runId);
    stopAutoQuitMonitor(runId);
    const stopped = terminalRunMeta(readRunMeta(runId), "stopped", { exit_code: meta.exit_code ?? null });
    writeRunMeta(runId, stopped);
    maybeSyncPrimeEvaluation(runId, stopped);
    if (meta.model === "claude") startNextWaitingClaudeRun();

    return summarizeRun(runId);
  }

  function resolveRunFilePath(runId, fileName) {
    const runDir = runDirFor(runId);
    const isFrame = /^frames\/frame-\d+\.png$/.test(fileName);
    const isSwarmFrame = /^swarm\/[a-z0-9_-]{1,48}\/frames\/frame-\d+\.png$/i.test(fileName);

    if (!SERVABLE_RUN_FILES.has(fileName) && !isFrame && !isSwarmFrame) {
      return null;
    }

    const filePath = path.join(runDir, ...fileName.split("/"));
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : null;
  }

  setImmediate(() => {
    startNextWaitingClaudeRun();
    retryDueProviderBackoffs();
    runMetaEntries()
      .filter((entry) => entry.meta.status === "running")
      .forEach((entry) => startAutoQuitMonitor(entry.id));
  });
  const providerRetryTimer = setInterval(retryDueProviderBackoffs, PROVIDER_RETRY_SCAN_MS);
  providerRetryTimer.unref?.();

  return {
    branchRun,
    cancelRunVideo,
    continueRun,
    deleteRun,
    generateRunVideo,
    generateRunReview,
    getEnvironment,
    getEnvironmentAsync,
    getRunNotes,
    getRunReview,
    getRunObservation,
    getRunObservations,
    getRunProgress,
    getToolExecution,
    getToolWorkspaceFile,
    launchRun,
    launchRuns,
    listPrimeHarnesses,
    listProviderModels,
    listRuns,
    pauseRun,
    regenerateRunVideo,
    resolveRunFilePath,
    resumeRun,
    setRunFavorite,
    setRunNotes,
    setRunMoveTarget,
    syncPrimeEvaluation,
    startDocker,
    stopRun,
    summarizeRun
  };
}

module.exports = {
  apiPricingForRun,
  branchLaunchParams,
  collectedAllWorldGems,
  createAgentRunService,
  enrichedPathEnv,
  filterPrimeCatalogForHarness,
  normalizePrimeHarnessConfig,
  primeReasoningLevels,
  primeHarnessModelCompatible,
  primeEvaluationReward,
  primeSandboxIdsFromText,
  publicPrimeHarnesses,
  replayMessageForCommandText,
  runReviewCommand,
  runReviewPrompt
};
