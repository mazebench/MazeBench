#!/usr/bin/env node
"use strict";

// Prime Verifiers run wrapper (Agent Mode).
//
// Runs the mazebench Verifiers v1 taskset via `uv run eval`, then builds the
// the web run artifacts — maze_replay.mp4, maze_scorecard.json, and a per-move
// actions.jsonl — from the eval's results.jsonl or traces.jsonl. That lets the
// run page show renderings + a video for Prime runs, not just the log. Spawned
// detached by server/agent-runs.js with stdout/stderr wired to launcher.log.
//
// Usage:
//   node maze-prime-run.js --env-dir <dir> --out <runDir> [--model <id>]
//     --harness <none|prime-harness-id> (--max-turns <n> | --unlimited)
//     [--observation-mode <ascii|json|vision>] [--no-video]

const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn, spawnSync } = require("node:child_process");
const { writePrimeResumeCheckpoint } = require("../server/prime-resume");
const { BOARD_STATE_HASH_VERSION } = require("../shared/board-state");

const ROOT_DIR = path.resolve(__dirname, "..");
const BRIDGE = path.join(ROOT_DIR, "scripts", "maze-bridge.js");
const EXPORT_REPLAY = path.join(ROOT_DIR, "scripts", "maze-export-replay.js");
const LIVE_EVAL = path.join(ROOT_DIR, "scripts", "maze-prime-live-eval.py");
const HOSTED_STATE_FILE = "prime-evaluation.json";
const HOSTED_SAMPLES_FILE = "prime-evaluation-samples.json";
const HARNESS_CATALOG_FILE = path.join(ROOT_DIR, "environments", "mazebench", "prime-harness-catalog.json");
const HARNESS_CATALOG = JSON.parse(fs.readFileSync(HARNESS_CATALOG_FILE, "utf8"));
const HARNESS_CERTIFICATION_FILE = path.join(ROOT_DIR, "environments", "mazebench", "prime-harness-certification.json");
const HARNESS_CERTIFICATION = JSON.parse(fs.readFileSync(HARNESS_CERTIFICATION_FILE, "utf8"));
if (HARNESS_CERTIFICATION.catalog_fingerprint !== HARNESS_CATALOG.catalog_fingerprint) {
  throw new Error("Prime harness catalog does not match its safety certification.");
}
const CERTIFIED_HARNESSES = new Set(
  HARNESS_CERTIFICATION.harnesses.filter((entry) => entry.status === "certified").map((entry) => entry.id)
);
const PRIME_HARNESSES = new Map(HARNESS_CATALOG.harnesses.map((entry) => [entry.id, entry]));
const TEXT_RUNTIME_IMAGE = "node:24-bookworm-slim";
const VISION_RUNTIME_IMAGE = "mcr.microsoft.com/playwright:v1.60.0-noble";
const PRIME_REASONING_LEVELS = new Set(["low", "medium", "high"]);
const PRIME_PROVIDER_RETRY_ATTEMPTS = 3;
const PRIME_PROVIDER_RETRY_BASE_MS = 30_000;
const GAME_WON_GEM_COUNT = 100;

function harnessDefinition(harnessId) {
  return harnessId === "none" ? null : PRIME_HARNESSES.get(harnessId);
}

function harnessCliValue(value) {
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null) return "None";
  if (Array.isArray(value) || (value && typeof value === "object")) return JSON.stringify(value);
  return String(value);
}

function positiveTurnBudget(value, fallback = 20) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function primeModelSupportsReasoning(modelId) {
  return /^openai\/gpt-oss-(?:20b|120b)(?:-|$)/i.test(String(modelId || "").trim());
}

function parseArgs(argv) {
  const opts = {
    envDir: "",
    environment: "mazebench/mazebench",
    gameWonGemCount: GAME_WON_GEM_COUNT,
    harness: "none",
    harnessConfig: {},
    hosted: false,
    levelId: "level_HxI",
    maxTurns: 20,
    model: "",
    observationMode: "ascii",
    omniscient: false,
    hideNames: false,
    hideNamesSeed: "1",
    outDir: "",
    reasoning: "",
    resumeCheckpoint: "",
    runId: "",
    unlimited: false,
    vision: false,
    allowQuit: true,
    autoQuit: false,
    autoQuitThreshold: 10,
    autoQuitMode: "cumulative",
    autoQuitWindow: 100,
    video: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[(index += 1)];

    if (arg === "--env-dir") opts.envDir = path.resolve(next());
    else if (arg === "--harness") {
      const harness = String(next() || "none").trim().toLowerCase();
      const aliases = {
        claude: "claude_code",
        "claude-code": "claude_code",
        default: "null",
        "kimi-code": "kimi_code",
        "mini-swe-agent": "mini_swe_agent",
        "terminus-2": "terminus_2"
      };
      opts.harness = aliases[harness] || harness;
    }
    else if (arg === "--harness-config-json") {
      try {
        const value = JSON.parse(String(next() || "{}"));
        opts.harnessConfig = value && typeof value === "object" && !Array.isArray(value) ? value : {};
      } catch (_error) {
        throw new Error("Prime harness configuration must be valid JSON.");
      }
    }
    else if (arg === "--environment") opts.environment = String(next() || opts.environment);
    else if (arg === "--out") opts.outDir = next();
    else if (arg === "--model") opts.model = next();
    else if (arg === "--run-id") opts.runId = String(next() || "");
    else if (arg === "--level") opts.levelId = String(next() || opts.levelId);
    else if (arg === "--game-won-gem-count") {
      next();
      opts.gameWonGemCount = GAME_WON_GEM_COUNT;
    }
    else if (arg === "--max-turns") opts.maxTurns = positiveTurnBudget(next());
    else if (arg === "--unlimited") opts.unlimited = true;
    else if (arg === "--hosted") opts.hosted = true;
    else if (arg === "--vision") {
      opts.vision = true;
      opts.observationMode = "vision";
    }
    else if (arg === "--observation-mode") {
      const mode = String(next() || "ascii").toLowerCase();
      opts.observationMode = ["json", "vision"].includes(mode) ? mode : "ascii";
      opts.vision = opts.observationMode === "vision";
    }
    else if (arg === "--omniscient") opts.omniscient = true;
    else if (arg === "--hide-names") opts.hideNames = true;
    else if (arg === "--hide-names-seed") opts.hideNamesSeed = String(next() || "").trim().slice(0, 128);
    else if (arg === "--reasoning") opts.reasoning = String(next() || "").trim();
    else if (arg === "--resume-checkpoint") opts.resumeCheckpoint = path.resolve(String(next() || ""));
    else if (arg === "--no-quit") opts.allowQuit = false;
    else if (arg === "--auto-quit") opts.autoQuit = true;
    else if (arg === "--auto-quit-threshold") {
      opts.autoQuitThreshold = Math.max(0, Math.min(100, Number(next()) || 0));
    }
    else if (arg === "--auto-quit-mode") {
      opts.autoQuitMode = String(next() || "").trim().toLowerCase() === "rolling"
        ? "rolling"
        : "cumulative";
    }
    else if (arg === "--auto-quit-window") {
      opts.autoQuitWindow = Math.max(1, Math.min(10_000, Math.round(Number(next()) || 100)));
    }
    else if (arg === "--no-video") opts.video = false;
  }

  if (!opts.outDir || (!opts.hosted && !opts.envDir)) {
    throw new Error("maze-prime-run.js requires --out and, for local evaluations, --env-dir");
  }
  const definition = harnessDefinition(opts.harness);
  if (opts.harness !== "none" && !definition) {
    throw new Error(`Unknown Prime harness "${opts.harness}".`);
  }
  if (definition && !definition.launchable) {
    throw new Error(definition.reason || `Prime harness "${opts.harness}" failed catalog validation.`);
  }
  if (definition && !CERTIFIED_HARNESSES.has(opts.harness)) {
    throw new Error(`Prime harness "${opts.harness}" has not passed MazeBench compatibility certification.`);
  }
  if (opts.hosted && opts.harness !== "none") {
    throw new Error("Custom harnesses run through the local trusted evaluator with only their harness program in a Prime sandbox.");
  }
  if (definition && opts.vision) {
    throw new Error(`${opts.harness} currently supports only text and JSON through MazeBench's isolated MCP controls.`);
  }
  const allowedHarnessConfig = new Set(definition?.configurable || []);
  const unknownHarnessConfig = Object.keys(opts.harnessConfig).filter((key) => !allowedHarnessConfig.has(key));
  if (unknownHarnessConfig.length) {
    throw new Error(`Unsupported ${opts.harness} harness configuration: ${unknownHarnessConfig.join(", ")}.`);
  }
  opts.harnessConfig = { ...(definition?.default_config || {}), ...opts.harnessConfig };
  if (opts.resumeCheckpoint && !fs.existsSync(opts.resumeCheckpoint)) {
    throw new Error(`Prime resume checkpoint does not exist: ${opts.resumeCheckpoint}`);
  }
  opts.reasoning = primeModelSupportsReasoning(opts.model) &&
    PRIME_REASONING_LEVELS.has(String(opts.reasoning).toLowerCase())
    ? String(opts.reasoning).toLowerCase()
    : "";
  return opts;
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function writeTextAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, value, "utf8");
  fs.renameSync(temporary, filePath);
}

function parseJsonOutput(value) {
  const text = stripAnsi(value);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error(text);
  }
}

function hostedStatePath(opts) {
  return path.join(opts.outDir, HOSTED_STATE_FILE);
}

function updateHostedState(opts, patch) {
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(hostedStatePath(opts), "utf8"));
  } catch (_error) {
    /* first update */
  }
  writeJsonAtomic(hostedStatePath(opts), { ...previous, ...patch, updated_at: new Date().toISOString() });
}

function writeInitialStatus(opts) {
  const bridgeArgs = [
    BRIDGE,
    "--level",
    opts.levelId,
    "--game-won-gem-count",
    String(opts.gameWonGemCount)
  ];
  if (opts.observationMode === "ascii" && opts.hideNames) {
    bridgeArgs.push("--hide-names", "--hide-names-seed", opts.hideNamesSeed || "1");
  }
  const result = spawnSync(
    process.execPath,
    bridgeArgs,
    {
      cwd: ROOT_DIR,
      encoding: "utf8",
      input: `${JSON.stringify({ command: "observe" })}\n`,
      maxBuffer: 16 * 1024 * 1024
    }
  );
  if (result.status !== 0) return;
  try {
    const payload = JSON.parse(result.stdout);
    writeJsonAtomic(path.join(opts.outDir, "initial-status.json"), {
      allowed_commands: payload.allowed_commands || [],
      board_state_hash: payload.board_state_hash || null,
      board_state_hash_version: Number(payload.board_state_hash_version) || BOARD_STATE_HASH_VERSION,
      current_room: payload.current_room || opts.levelId,
      current_view: payload.current_view || "top-diagonal",
      gem_count: 0,
      level: payload.level || "",
      player: payload.player || null,
      player_dead: Boolean(payload.player_dead),
      visited_levels: payload.visited_levels || [payload.current_room || opts.levelId],
      yaw: Number(payload.yaw) || 0
    });
  } catch (_error) {
    /* the hosted evaluation can still run without the local move-zero preview */
  }
}

function hostedEvalArgs(opts) {
  const envArgs = {
    num_train_examples: 1,
    num_eval_examples: 1,
    start_level_id: opts.levelId,
    game_won_gem_count: opts.gameWonGemCount,
    max_actions: opts.unlimited ? null : opts.maxTurns,
    allow_quit: opts.allowQuit,
    auto_quit: opts.autoQuit,
    auto_quit_threshold: opts.autoQuitThreshold,
    auto_quit_mode: opts.autoQuitMode,
    auto_quit_window: opts.autoQuitWindow,
    observation_mode: opts.observationMode
  };
  if (opts.unlimited) envArgs.unlimited = true;
  if (opts.observationMode === "json") {
    envArgs.omniscient = opts.omniscient;
  }
  if (opts.observationMode !== "vision" && opts.hideNames) {
    envArgs.hide_names = true;
    if (opts.hideNamesSeed) envArgs.hide_names_seed = opts.hideNamesSeed;
  }
  // Reasoning models spend this budget on reasoning_content before emitting the
  // one-line command. A 64-token cap can therefore produce a null command and
  // poison the next chat request even though the requested action is tiny.
  const samplingArgs = { max_tokens: 512 };
  if (opts.reasoning) samplingArgs.reasoning_effort = opts.reasoning;
  const evalName = `MazeBench Agent ${opts.runId || path.basename(opts.outDir)}`;
  const args = [
    "eval",
    "run",
    opts.environment,
    "--hosted",
    "--follow",
    "--eval-name",
    evalName,
    "-n",
    "1",
    "-r",
    "1",
    "-c",
    "1",
    "-S",
    JSON.stringify(samplingArgs),
    "-a",
    JSON.stringify(envArgs),
    "--state-columns",
    "maze_actions,maze_auto_quit,maze_scorecard,maze_replay,maze_status",
    "--timeout-minutes",
    opts.unlimited ? "1440" : "60",
    "--poll-interval",
    "2"
  ];
  if (opts.model) args.push("-m", opts.model);
  return args;
}

function verifierTurnBudgetArgs(opts) {
  if (opts.unlimited) {
    return ["--taskset.max-actions", "None", "--max-turns", "None"];
  }
  // Verifiers counts every sampled graph branch against max_turns. Provider
  // continuation-state retokenization can fork the graph without advancing
  // the user simulator, so keep this as a safety ceiling and let the
  // environment's exact max_actions value enforce the requested move budget.
  return [
    "--taskset.max-actions",
    String(opts.maxTurns),
    "--max-turns",
    String(Math.max(opts.maxTurns + 16, opts.maxTurns * 4))
  ];
}

function primeJson(args) {
  const result = spawnSync("prime", [...args, "--output", "json", "--plain"], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000
  });
  if (result.status !== 0) {
    throw new Error(stripAnsi(result.stderr || result.stdout) || `prime ${args.join(" ")} failed`);
  }
  return parseJsonOutput(result.stdout);
}

function primeJsonAsync(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "prime",
      [...args, "--output", "json", "--plain"],
      {
        cwd: ROOT_DIR,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60_000
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stripAnsi(stderr || stdout) || `prime ${args.join(" ")} failed`));
          return;
        }
        try {
          resolve(parseJsonOutput(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

function nestedField(value, key, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return undefined;
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  for (const [name, child] of Object.entries(value)) {
    if (["prompt", "completion", "logs"].includes(name)) continue;
    const found = nestedField(child, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function hostedSampleToResultRow(sample) {
  const mazeActions = nestedField(sample, "maze_actions") || [];
  const mazeAutoQuit = nestedField(sample, "maze_auto_quit") || {};
  const mazeScorecard = nestedField(sample, "maze_scorecard") || {};
  const mazeReplay = nestedField(sample, "maze_replay") || {};
  const observations = (Array.isArray(sample.completion) ? sample.completion : [])
    .filter((message) => message?.role === "user")
    .map((message) => extractBoard(messageText(message.content)));
  const hydratedActions = (Array.isArray(mazeActions) ? mazeActions : []).map((action, index) => {
    const board = observations[index] || "";
    return board
      ? { ...action, status: { ...(action.status || {}), level: board } }
      : action;
  });
  return {
    prompt: sample.prompt || [],
    completion: sample.completion || [],
    reward: Number(sample.reward ?? sample.score ?? 0),
    info: {
      ...(sample.info || {}),
      maze_actions: hydratedActions,
      maze_auto_quit: mazeAutoQuit && typeof mazeAutoQuit === "object" ? mazeAutoQuit : {},
      maze_scorecard: mazeScorecard && typeof mazeScorecard === "object" ? mazeScorecard : {},
      maze_replay: mazeReplay && typeof mazeReplay === "object" ? mazeReplay : {}
    },
    metrics: sample.info?.metrics || {},
    nodes: []
  };
}

function writeHostedResults(opts, samplesPayload) {
  const samples = Array.isArray(samplesPayload?.samples) ? samplesPayload.samples : [];
  const outputDir = path.join(opts.outDir, "eval-output", "hosted");
  fs.mkdirSync(outputDir, { recursive: true });
  writeJsonAtomic(path.join(opts.outDir, HOSTED_SAMPLES_FILE), samplesPayload || { samples: [] });
  const rows = samples.map(hostedSampleToResultRow);
  const resultsPath = path.join(outputDir, "results.jsonl");
  fs.writeFileSync(resultsPath, rows.length ? `${rows.map(JSON.stringify).join("\n")}\n` : "", "utf8");

  const sample = samples[0] || {};
  const tokenUsage = sample.info?.token_usage || {};
  const actions = rows[0]?.info?.maze_actions || [];
  if (Number(tokenUsage.input_tokens || tokenUsage.final_input_tokens) > 0) {
    fs.writeFileSync(
      path.join(opts.outDir, "prime-usage.jsonl"),
      `${JSON.stringify({
        turn: Math.max(1, actions.length),
        input_tokens: Number(tokenUsage.input_tokens || tokenUsage.final_input_tokens) || 0,
        completion_tokens: Number(tokenUsage.output_tokens || tokenUsage.final_output_tokens) || 0,
        total_tokens:
          (Number(tokenUsage.input_tokens || tokenUsage.final_input_tokens) || 0) +
          (Number(tokenUsage.output_tokens || tokenUsage.final_output_tokens) || 0),
        recorded_at: Date.now() / 1000
      })}\n`,
      "utf8"
    );
  }
  return resultsPath;
}

function writeHostedLiveArtifacts(opts, samplesPayload) {
  const samples = Array.isArray(samplesPayload?.samples) ? samplesPayload.samples : [];
  if (samples.length === 0) return { moves: 0, resultsPath: "" };
  const resultsPath = writeHostedResults(opts, samplesPayload);
  const moves = writeMoveArtifacts(resultsPath, opts.outDir);
  return { moves, resultsPath };
}

function hostedRolloutError(samplesPayload) {
  const samples = Array.isArray(samplesPayload?.samples) ? samplesPayload.samples : [];
  for (const sample of samples) {
    const info = sample?.info || {};
    const error = info.error;
    if (info.stop_condition !== "has_error" && !error) continue;
    return String(
      error?.error_chain_str ||
      error?.message ||
      error?.error ||
      "The hosted rollout stopped with an error."
    ).trim();
  }
  return "";
}

function localRolloutError(resultsPath) {
  if (!resultsPath || !fs.existsSync(resultsPath)) return "";
  const firstLine = fs.readFileSync(resultsPath, "utf8").split(/\r?\n/).find((line) => line.trim());
  if (!firstLine) return "The local Prime evaluation produced no result row.";
  const row = JSON.parse(firstLine);
  const errors = Array.isArray(row.errors) ? row.errors : [];
  if (!errors.length && !["error", "has_error"].includes(String(row.stop_condition || ""))) return "";
  const error = errors[errors.length - 1] || {};
  const traceback = String(error.traceback || "");
  const providerMatches = [...traceback.matchAll(/openai\.([A-Za-z]+Error):\s*([^\n]+)/g)];
  const providerError = providerMatches[providerMatches.length - 1];
  if (providerError) return `${providerError[1]}: ${providerError[2]}`;
  return [error.type, error.message].filter(Boolean).join(": ") || "The local Prime rollout stopped with an error.";
}

function retryablePrimeProviderError(message) {
  const text = String(message || "");
  if (!/\bProviderError\b/i.test(text)) return false;
  const statuses = [...text.matchAll(/(?:upstream\s+|status(?:_code)?[^0-9]{0,12})([1-5][0-9]{2})\b/gi)]
    .map((match) => Number(match[1]));
  const status = statuses[statuses.length - 1] || 0;
  return [404, 408, 409, 425, 429].includes(status) || status >= 500;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runEvalWithProviderRetry(opts) {
  if (opts.hosted) return runEval(opts);

  for (let attempt = 1; attempt <= PRIME_PROVIDER_RETRY_ATTEMPTS; attempt += 1) {
    const code = await runEval(opts);
    const evalOutDir = path.join(opts.outDir, "eval-output");
    const rolloutError = localRolloutError(findResults(evalOutDir));
    const actionPath = path.join(opts.outDir, "actions.jsonl");
    const hasActions = fs.existsSync(actionPath) && fs.statSync(actionPath).size > 0;
    const retryable = !hasActions && retryablePrimeProviderError(rolloutError);

    if (!retryable || attempt === PRIME_PROVIDER_RETRY_ATTEMPTS) return code;

    const retryDelay = PRIME_PROVIDER_RETRY_BASE_MS * (2 ** (attempt - 1));
    const archive = path.join(opts.outDir, `eval-output-provider-failure-${attempt}-${Date.now()}`);
    if (fs.existsSync(evalOutDir)) fs.renameSync(evalOutDir, archive);
    console.error(
      `[mazebench] transient Prime provider routing failure before action 1; ` +
      `retrying evaluation ${attempt + 1}/${PRIME_PROVIDER_RETRY_ATTEMPTS} in ${Math.round(retryDelay / 1000)}s: ${rolloutError}`
    );
    await delay(retryDelay);
  }

  return 1;
}

function runHostedEval(opts) {
  writeInitialStatus(opts);
  const argv = hostedEvalArgs(opts);
  console.log(`[mazebench] prime ${argv.join(" ")}`);
  updateHostedState(opts, { status: "STARTING", environment: opts.environment, model: opts.model || null });

  return new Promise((resolve) => {
    const child = spawn("prime", argv, { cwd: ROOT_DIR, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let combined = "";
    let evaluationId = "";
    let samplePollTimer = null;
    let samplePollInFlight = null;
    let lastSamplePollError = "";
    const pollHostedSamples = () => {
      if (!evaluationId || samplePollInFlight) return samplePollInFlight;
      samplePollInFlight = primeJsonAsync(["eval", "samples", evaluationId])
        .then((samples) => {
          const { moves } = writeHostedLiveArtifacts(opts, samples);
          updateHostedState(opts, {
            evaluation_id: evaluationId,
            live_action_count: moves,
            status: "RUNNING"
          });
          lastSamplePollError = "";
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          if (message !== lastSamplePollError) {
            console.error(`[mazebench] waiting for hosted sample stream: ${message}`);
            lastSamplePollError = message;
          }
        })
        .finally(() => {
          samplePollInFlight = null;
        });
      return samplePollInFlight;
    };
    const startHostedSamplePolling = () => {
      if (samplePollTimer) return;
      void pollHostedSamples();
      samplePollTimer = setInterval(pollHostedSamples, 2_000);
    };
    const stopHostedSamplePolling = async () => {
      if (samplePollTimer) clearInterval(samplePollTimer);
      samplePollTimer = null;
      if (samplePollInFlight) await samplePollInFlight;
    };
    const consume = (chunk, stream) => {
      const text = chunk.toString();
      stream.write(text);
      combined = `${combined}${text}`.slice(-32 * 1024);
      if (!evaluationId) {
        const match = stripAnsi(combined).match(/Evaluation ID:\s*([a-z0-9]+)/i);
        if (match) {
          evaluationId = match[1];
          updateHostedState(opts, {
            evaluation_id: evaluationId,
            status: "RUNNING",
            viewer_url: `https://app.primeintellect.ai/dashboard/evaluations/${evaluationId}`
          });
          startHostedSamplePolling();
        }
      }
    };
    child.stdout.on("data", (chunk) => consume(chunk, process.stdout));
    child.stderr.on("data", (chunk) => consume(chunk, process.stderr));
    child.on("error", (error) => {
      updateHostedState(opts, { status: "FAILED", error: error.message });
      resolve(127);
    });
    child.on("close", async (code) => {
      await stopHostedSamplePolling();
      if (!evaluationId) {
        updateHostedState(opts, {
          status: code === 0 ? "COMPLETED" : "FAILED",
          error: code === 0 ? null : `Prime evaluation launcher exited with status ${code ?? "unknown"}.`
        });
        resolve(code == null ? 1 : code);
        return;
      }
      try {
        const evaluation = primeJson(["eval", "get", evaluationId]);
        const samples = primeJson(["eval", "samples", evaluationId]);
        const { moves } = writeHostedLiveArtifacts(opts, samples);
        const rolloutError = hostedRolloutError(samples);
        updateHostedState(opts, {
          ...evaluation,
          evaluation_id: evaluationId,
          live_action_count: moves,
          status: rolloutError ? "FAILED" : evaluation.status || (code === 0 ? "COMPLETED" : "FAILED"),
          rollout_error: rolloutError || null,
          viewer_url: evaluation.viewer_url || `https://app.primeintellect.ai/dashboard/evaluations/${evaluationId}`
        });
        resolve(
          !rolloutError && String(evaluation.status || "").toUpperCase() === "COMPLETED"
            ? 0
            : code == null
              ? 1
              : code || 1
        );
      } catch (error) {
        updateHostedState(opts, { status: "FAILED", error: error.message });
        console.error(`[mazebench] could not import hosted evaluation ${evaluationId}: ${error.message}`);
        resolve(code == null ? 1 : code || 1);
      }
    });
  });
}

// mazebench is a Verifiers v1 taskset, run via `uv run eval` (NOT `prime eval
// run`, the legacy env-module loader). --max-turns is the per-rollout move
// budget; we fix examples/rollouts at 1 (one maze, one attempt) so the run is
// simply "make N moves and stop". -o keeps results inside the run dir.
function runEval(opts) {
  if (opts.hosted) return runHostedEval(opts);
  const evalOutDir = path.join(opts.outDir, "eval-output");
  const liveUsagePath = path.join(opts.outDir, "prime-usage.jsonl");
  const liveActionsPath = path.join(opts.outDir, "actions.jsonl");
  const liveReasoningPath = path.join(opts.outDir, "prime-reasoning.jsonl");
  const agentic = opts.harness !== "none";
  const taskset = agentic ? "mazebench-tools" : "mazebench";
  const argv = ["run", "--project", opts.envDir, "python", LIVE_EVAL, taskset];

  let resumeActionCount = 0;
  if (opts.resumeCheckpoint) {
    const checkpoint = JSON.parse(fs.readFileSync(opts.resumeCheckpoint, "utf8"));
    resumeActionCount = Math.max(0, Math.floor(Number(checkpoint.action_count) || 0));
  } else {
    // The live exporter appends after every model turn. Start each fresh run
    // clean so polling clients never mix usage from an earlier attempt.
    fs.writeFileSync(liveUsagePath, "");
    fs.writeFileSync(liveActionsPath, "");
    fs.writeFileSync(liveReasoningPath, "");
  }

  if (opts.model) {
    argv.push("-m", opts.model);
  }

  argv.push(
    "-r",
    "1",
    "--taskset.num-examples",
    "1",
    "--taskset.start-level-id",
    opts.levelId,
    "--taskset.game-won-gem-count",
    String(opts.gameWonGemCount),
    ...verifierTurnBudgetArgs(opts),
    "--rich",
    "False",
    "-o",
    evalOutDir
  );

  if (opts.resumeCheckpoint) {
    argv.push("--taskset.resume-checkpoint-path", opts.resumeCheckpoint);
  }

  if (agentic) {
    const definition = harnessDefinition(opts.harness);
    const runtimeImage = opts.vision ? VISION_RUNTIME_IMAGE : TEXT_RUNTIME_IMAGE;
    argv.push(
      "--harness.id",
      definition.runtime_harness_id,
      "--harness.runtime.type",
      "prime",
      "--harness.runtime.image",
      runtimeImage,
      "--harness.runtime.workdir",
      "/app",
      "--harness.runtime.cpu",
      "2",
      "--harness.runtime.memory",
      "4",
      "--harness.runtime.disk",
      "8",
      "--taskset.tools.colocated",
      "False",
      "--push",
      "False"
    );
    if (definition.adapter === "cli_gateway") {
      argv.push(
        "--harness.upstream-id",
        definition.upstream_id || opts.harness,
        "--harness.upstream-config-json",
        JSON.stringify(opts.harnessConfig)
      );
    } else {
      for (const [key, value] of Object.entries(opts.harnessConfig)) {
        argv.push(`--harness.${key.replace(/_/g, "-")}`, harnessCliValue(value));
      }
    }
  }

  if (opts.vision) {
    argv.push("--taskset.observation-mode", "vision");
  } else if (opts.observationMode === "json") {
    argv.push("--taskset.observation-mode", "json");
    if (opts.omniscient) argv.push("--taskset.omniscient", "True");
  }
  if (!opts.vision && opts.hideNames) {
    argv.push("--taskset.hide-names", "True");
    if (opts.hideNamesSeed) argv.push("--taskset.hide-names-seed", opts.hideNamesSeed);
  }

  if (!opts.allowQuit) {
    argv.push("--taskset.allow-quit", "False");
  }
  if (opts.autoQuit) {
    argv.push(
      "--taskset.auto-quit",
      "True",
      "--taskset.auto-quit-threshold",
      String(opts.autoQuitThreshold),
      "--taskset.auto-quit-mode",
      opts.autoQuitMode,
      "--taskset.auto-quit-window",
      String(opts.autoQuitWindow)
    );
  }

  // Prime documents low/medium/high reasoning effort for GPT-OSS. Unsupported
  // model/value combinations are normalized to off during argument parsing.
  if (opts.reasoning) {
    argv.push("--sampling.reasoning-effort", opts.reasoning);
  }

  console.log(`[mazebench] uv ${argv.join(" ")}`);

  return new Promise((resolve) => {
    const child = spawn("uv", argv, {
      cwd: opts.envDir,
      env: {
        ...process.env,
        MAZEBENCH_PRIME_HARNESS: opts.harness,
        MAZEBENCH_PRIME_HARNESS_ADAPTER: harnessDefinition(opts.harness)?.adapter || "user_simulator",
        MAZEBENCH_PRIME_HARNESS_CATALOG: HARNESS_CATALOG.catalog_fingerprint,
        MAZEBENCH_LIVE_USAGE_PATH: liveUsagePath,
        MAZEBENCH_LIVE_ACTIONS_PATH: liveActionsPath,
        MAZEBENCH_LIVE_REASONING_PATH: liveReasoningPath,
        MAZEBENCH_RESUME_ACTION_COUNT: String(resumeActionCount)
      },
      stdio: ["ignore", "inherit", "inherit"]
    });
    child.on("error", (error) => {
      console.error(`[mazebench] could not start uv: ${error.message}`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code == null ? 1 : code));
  });
}

function findResults(dir, depth = 0) {
  if (depth > 5 || !fs.existsSync(dir)) {
    return null;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && ["results.jsonl", "traces.jsonl"].includes(entry.name)) {
      return path.join(dir, entry.name);
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findResults(path.join(dir, entry.name), depth + 1);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

// Flatten an OpenAI-style message content (string, or a list of text/image
// parts) into plain text, dropping image parts.
function messageText(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") return part.text || "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return content == null ? "" : String(content);
}

function reasoningValueText(value) {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(reasoningValueText);
  if (!value || typeof value !== "object") return [];

  return ["text", "thinking", "summary", "reasoning", "reasoning_content"]
    .flatMap((key) => reasoningValueText(value[key]));
}

// Verifiers normally normalizes provider-specific fields into
// reasoning_content. Preserve a direct fallback for trace formats that retain
// only provider_state (Responses summaries, reasoning_details, thinking blocks).
function providerReasoningText(providerState) {
  const items = Array.isArray(providerState) ? providerState : providerState ? [providerState] : [];
  const parts = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type || "").toLowerCase();
    const explicitlyReasoning = ["thinking", "summary", "reasoning", "reasoning_content"]
      .some((key) => Object.hasOwn(item, key));
    if (!explicitlyReasoning && !type.includes("reasoning") && !type.includes("thinking")) continue;
    if (type.includes("encrypted") || type.includes("redacted")) continue;

    const keys = type
      ? ["summary", "content", "text", "thinking", "reasoning", "reasoning_content"]
      : ["summary", "thinking", "reasoning", "reasoning_content"];
    for (const key of keys) {
      parts.push(...reasoningValueText(item[key]));
    }
  }

  return [...new Set(parts.filter(Boolean))].join("\n");
}

// The observation embeds the ASCII maze in a ```text … ``` fence; pull it out so
// the run page can show exactly the board the model read. In vision mode there
// is no fence (the board is an image), so this returns "".
function extractBoard(observation) {
  const match = String(observation || "").match(/```(?:text)?\r?\n([\s\S]*?)```/);
  return match ? match[1].replace(/\s+$/, "") : "";
}

// Walk the rollout's conversation once, pairing each assistant turn with the
// user observation that preceded it. Assistant turns carry reasoning_content
// (the reasoning tokens) and the chosen action; the user turn carries the board.
function conversationTurns(row) {
  const nodes = Array.isArray(row.nodes) ? row.nodes : [];
  const turns = [];
  let lastObservation = "";

  for (const node of nodes) {
    const message = node && node.message;
    if (!message || typeof message !== "object") {
      continue;
    }

    if (message.role === "user") {
      lastObservation = messageText(message.content);
    } else if (message.role === "assistant" && node.sampled !== false) {
      const normalizedReasoning = String(messageText(message.reasoning_content) || "").trim();
      turns.push({
        board: extractBoard(lastObservation),
        reasoning: normalizedReasoning || providerReasoningText(message.provider_state),
        action: String(messageText(message.content) || "").trim()
      });
    }
  }

  return turns;
}

function agenticConversationTurns(row) {
  const nodes = Array.isArray(row.nodes) ? row.nodes : [];
  const turns = [];
  let assistant = null;
  const pendingGameActions = new Map();

  for (const node of nodes) {
    const message = node && node.message;
    if (!message || typeof message !== "object") continue;
    if (message.role === "assistant") {
      const normalizedReasoning = String(messageText(message.reasoning_content) || "").trim();
      assistant = {
        reasoning: normalizedReasoning || providerReasoningText(message.provider_state),
        action: String(messageText(message.content) || "").trim()
      };
      for (const call of message.tool_calls || []) {
        if (!/(?:^|__)game_action$/.test(String(call?.name || ""))) continue;
        try {
          const args = JSON.parse(String(call.arguments || "{}"));
          pendingGameActions.set(String(call.id || ""), {
            action: String(args.action || "").trim(),
            reasoning: assistant.reasoning
          });
        } catch (_error) {
          /* malformed tool arguments are retained by Verifiers but are not a move */
        }
      }
      continue;
    }
    if (message.role !== "tool") continue;
    const pending = pendingGameActions.get(String(message.tool_call_id || ""));
    if (pending) {
      turns.push({
        turn: turns.length + 1,
        board: "",
        reasoning: pending.reasoning || "",
        action: pending.action
      });
      pendingGameActions.delete(String(message.tool_call_id || ""));
    }
    const markers = String(messageText(message.content) || "").matchAll(/MAZEBENCH_EVENT_V1:([A-Za-z0-9_-]+)/g);
    for (const marker of markers) {
      try {
        const event = JSON.parse(Buffer.from(marker[1], "base64url").toString("utf8"));
        turns.push({
          turn: Number(event.turn) || turns.length + 1,
          board: String(event.status?.level || ""),
          reasoning: assistant?.reasoning || "",
          action: String(event.command_text || assistant?.action || "").trim()
        });
      } catch (_error) {
        /* malformed telemetry is ignored; finalized task artifacts remain authoritative */
      }
    }
  }

  return turns.sort((left, right) => left.turn - right.turn);
}

// Build the per-move artifacts the run page reads: actions.jsonl (turn,
// command_text, status incl. the text board) drives the board + move list, and
// reasoning.json drives the per-move reasoning shown alongside each move.
function writeMoveArtifacts(resultsPath, outDir) {
  const firstLine = fs
    .readFileSync(resultsPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return 0;
  }

  const row = JSON.parse(firstLine);
  const info = row.info || {};
  const mazeActions = (Array.isArray(info.maze_actions) ? info.maze_actions : []).filter(
    (action) => action && action.turn != null
  );
  const agenticTurns = agenticConversationTurns(row);
  const turns = agenticTurns.length ? agenticTurns : conversationTurns(row);
  const turnOffset = Math.max(0, mazeActions.length - turns.length);

  const actionLines = [];
  let reasoning = [];
  for (const priorPath of [
    path.join(outDir, "reasoning.json"),
    path.join(outDir, "prime-reasoning.jsonl")
  ]) {
    if (!fs.existsSync(priorPath)) continue;
    try {
      const prior = priorPath.endsWith(".jsonl")
        ? fs.readFileSync(priorPath, "utf8")
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : JSON.parse(fs.readFileSync(priorPath, "utf8"));
      reasoning = [...reasoning, ...(Array.isArray(prior) ? prior : [])]
        .filter((entry) => Number(entry?.move) > 0 && Number(entry.move) <= turnOffset);
    } catch (_error) {
      /* optional historical reasoning must not prevent final artifact export */
    }
  }
  reasoning = [...new Map(reasoning.map((entry) => [Number(entry.move), entry])).values()]
    .sort((left, right) => Number(left.move) - Number(right.move));

  mazeActions.forEach((action, index) => {
    const detail = index >= turnOffset ? (turns[index - turnOffset] || {}) : {};
    const status = { ...(action.status || {}) };

    // Surface the board the model saw as status.level (what the run page reads
    // for the ASCII board panel in text mode).
    if (detail.board) {
      status.level = detail.board;
    }

    const commandText = String(action.command || action.raw_response || detail.action || "").trim();

    const timestamp = action.timestamp || action.created_at || detail.timestamp || null;
    actionLines.push(JSON.stringify({
      turn: action.turn,
      timestamp,
      command_text: commandText,
      valid: action.valid !== false,
      error: action.error || null,
      status
    }));

    if (detail.reasoning) {
      reasoning.push({
        move: action.turn,
        timestamp,
        reasoning: detail.reasoning,
        action: commandText,
        room: status.current_room || "",
        gems: status.gem_count ?? 0,
        moved: status.moved,
        player_dead: Boolean(status.player_dead)
      });
    }
  });

  writeTextAtomic(
    path.join(outDir, "actions.jsonl"),
    actionLines.length ? `${actionLines.join("\n")}\n` : ""
  );
  writeTextAtomic(
    path.join(outDir, "reasoning.json"),
    reasoning.length ? `${JSON.stringify(reasoning, null, 2)}\n` : "[]\n"
  );

  return actionLines.length;
}

function replayExportArgs(resultsPath, outDir, opts) {
  const actionLogPath = path.join(outDir, "actions.jsonl");
  const replayInputPath = fs.existsSync(actionLogPath) && fs.statSync(actionLogPath).size > 0
    ? actionLogPath
    : resultsPath;
  const argv = [EXPORT_REPLAY, replayInputPath, "--out-dir", outDir, "--draft"];

  if (opts.observationMode === "ascii") {
    argv.push("--width", "1280", "--height", "720", "--ascii-side-by-side");
  } else {
    argv.push("--width", "640", "--height", "640");
  }

  if (!opts.video) {
    argv.push("--no-video");
  }

  return argv;
}

function runReplayExport(resultsPath, outDir, opts) {
  const argv = replayExportArgs(resultsPath, outDir, opts);

  console.log("[mazebench] node scripts/maze-export-replay.js <results> --out-dir <run> --draft");

  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: ROOT_DIR, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (error) => {
      console.error(`[mazebench] replay export could not start: ${error.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code == null ? 1 : code));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  writeInitialStatus(opts);
  const code = await runEvalWithProviderRetry(opts);

  const resultsPath = findResults(path.join(opts.outDir, "eval-output"));

  if (!resultsPath) {
    console.error("[mazebench] eval finished but no rollout JSONL was found; no resume checkpoint can be created.");
    process.exit(code || 1);
  }

  try {
    const initialStatus = JSON.parse(
      fs.readFileSync(path.join(opts.outDir, "initial-status.json"), "utf8")
    );
    const { checkpoint } = writePrimeResumeCheckpoint(opts.outDir, {
      initialStatus,
      sourceRunId: opts.runId || path.basename(opts.outDir)
    });
    console.log(`[mazebench] saved a verified resume checkpoint at action ${checkpoint.action_count}`);
  } catch (error) {
    console.error(`[mazebench] could not create a safe resume checkpoint: ${error.message}`);
  }

  if (code !== 0) {
    console.error(`[mazebench] eval exited with status ${code}; skipping replay.`);
    process.exit(code);
  }

  const rolloutError = localRolloutError(resultsPath);
  if (rolloutError) {
    console.error(`[mazebench] rollout failed: ${rolloutError}`);
    process.exit(1);
  }

  try {
    const moves = writeMoveArtifacts(resultsPath, opts.outDir);
    console.log(`[mazebench] wrote ${moves} move${moves === 1 ? "" : "s"} (board + reasoning) from the eval`);
  } catch (error) {
    console.error(`[mazebench] could not build the move feed: ${error.message}`);
  }

  console.log("\n=== Rendering replay video from the eval ===");
  const replayCode = await runReplayExport(resultsPath, opts.outDir, opts);

  if (replayCode !== 0) {
    // The eval itself succeeded; a missing video should not fail the whole run.
    console.error(`[mazebench] replay export exited ${replayCode}; the eval results are still saved.`);
  }

  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  agenticConversationTurns,
  conversationTurns,
  hostedEvalArgs,
  hostedRolloutError,
  hostedSampleToResultRow,
  localRolloutError,
  parseArgs,
  providerReasoningText,
  replayExportArgs,
  retryablePrimeProviderError,
  verifierTurnBudgetArgs,
  writeMoveArtifacts,
  writeHostedLiveArtifacts,
  writeHostedResults
};
