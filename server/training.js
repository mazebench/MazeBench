const fs = require("fs");
const path = require("path");
const { execFile, spawnSync } = require("child_process");
const { promisify } = require("util");
const { enrichedPathEnv } = require("./agent-runs");

const execFileAsync = promisify(execFile);

const CACHE_MS = 30_000;
const HOSTED_TRAINING_DEFAULTS = Object.freeze({
  observation_mode: "ascii",
  gem_reward_weight: 1,
  room_reward_weight: 0.1,
  push_reward_weight: 0.05,
  max_actions: 64,
  max_steps: 10,
  batch_size: 32,
  rollouts_per_example: 4,
  max_tokens: 512,
  temperature: 1
});

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
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

function numberInRange(value, name, min, max, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return number;
}

function integerInRange(value, name, min, max, fallback) {
  return Math.floor(numberInRange(value, name, min, max, fallback));
}

function primeSetupKind({ cliOk = true, accountOk = true, error = "" } = {}) {
  if (!cliOk) return "install";
  if (!accountOk) return "login";

  return /(?:401|403|api key|auth(?:entication|orization)?|login|not logged|token|unauthorized)/i.test(
    String(error || "")
  )
    ? "login"
    : "";
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function createTrainingService({ buildWorlds, getGame, rootDir, worldMaps }) {
  const environmentId = process.env.MAZEBENCH_TRAIN_ENV_ID || "mazebench/mazebench";
  const environmentDir = path.join(rootDir, "environments", "mazebench");
  const generatedConfigDir = path.join(rootDir, "configs", "rl", "generated");
  let bootstrapCache = null;

  function runPrime(args, options = {}) {
    const result = spawnSync("prime", ["--plain", ...args], {
      cwd: rootDir,
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: options.timeout || 60_000,
      maxBuffer: 8 * 1024 * 1024
    });

    if (result.error) {
      throw new Error(
        result.error.code === "ETIMEDOUT"
          ? "Prime CLI timed out."
          : `Prime CLI is unavailable: ${result.error.message}`
      );
    }
    if (result.status !== 0) {
      throw new Error(stripAnsi(result.stderr || result.stdout) || `Prime CLI exited with status ${result.status}.`);
    }
    return result;
  }

  async function runPrimeAsync(args, options = {}) {
    try {
      return await execFileAsync("prime", ["--plain", ...args], {
        cwd: rootDir,
        encoding: "utf8",
        env: enrichedPathEnv(),
        timeout: options.timeout || 60_000,
        maxBuffer: 8 * 1024 * 1024
      });
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`Prime CLI is unavailable: ${error.message}`);
      if (error?.killed || error?.code === "ETIMEDOUT") throw new Error("Prime CLI timed out.");
      throw new Error(stripAnsi(error?.stderr || error?.stdout) || `Prime CLI exited with status ${error?.code ?? "unknown"}.`);
    }
  }

  function probe(args, options = {}) {
    try {
      const result = runPrime(args, options);
      return { ok: true, output: stripAnsi(result.stdout) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async function probeAsync(args, options = {}) {
    try {
      const result = await runPrimeAsync(args, options);
      return { ok: true, output: stripAnsi(result.stdout) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  function localEnvironmentProbe() {
    const result = spawnSync(
      "uv",
      [
        "run",
        "--directory",
        environmentDir,
        "python",
        "-c",
        "from mazebench.mazebench import MazeBenchConfig, load_environment; import verifiers.v1 as vf; c=MazeBenchConfig(); assert c.id == 'mazebench'; assert callable(load_environment); assert vf.Taskset is not None"
      ],
      {
        cwd: rootDir,
        encoding: "utf8",
        env: enrichedPathEnv(),
        timeout: 30_000
      }
    );
    return result.status === 0
      ? { ok: true }
      : { ok: false, error: stripAnsi(result.stderr || result.stdout) || "MazeBench v1 failed to import." };
  }

  async function localEnvironmentProbeAsync() {
    try {
      await execFileAsync(
        "uv",
        [
          "run",
          "--directory",
          environmentDir,
          "python",
          "-c",
          "from mazebench.mazebench import MazeBenchConfig, load_environment; import verifiers.v1 as vf; c=MazeBenchConfig(); assert c.id == 'mazebench'; assert callable(load_environment); assert vf.Taskset is not None"
        ],
        {
          cwd: rootDir,
          encoding: "utf8",
          env: enrichedPathEnv(),
          timeout: 30_000,
          maxBuffer: 8 * 1024 * 1024
        }
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: stripAnsi(error?.stderr || error?.stdout) || "MazeBench v1 failed to import." };
    }
  }

  function liveModels() {
    const payload = parseJsonOutput(runPrime(["train", "models", "--output", "json"]).stdout) || {};
    return (payload.models || []).map((model) => ({
      id: model.name,
      at_capacity: Boolean(model.at_capacity),
      training_price_per_mtok: model.effective_training_price_per_mtok ?? model.training_price_per_mtok ?? null,
      input_price_per_mtok: model.effective_inference_input_price_per_mtok ?? model.inference_input_price_per_mtok ?? null,
      output_price_per_mtok: model.effective_inference_output_price_per_mtok ?? model.inference_output_price_per_mtok ?? null,
      promo_label: model.promo_label || ""
    }));
  }

  async function liveModelsAsync() {
    const payload = parseJsonOutput((await runPrimeAsync(["train", "models", "--output", "json"])).stdout) || {};
    return (payload.models || []).map((model) => ({
      id: model.name,
      at_capacity: Boolean(model.at_capacity),
      training_price_per_mtok: model.effective_training_price_per_mtok ?? model.training_price_per_mtok ?? null,
      input_price_per_mtok: model.effective_inference_input_price_per_mtok ?? model.inference_input_price_per_mtok ?? null,
      output_price_per_mtok: model.effective_inference_output_price_per_mtok ?? model.inference_output_price_per_mtok ?? null,
      promo_label: model.promo_label || ""
    }));
  }

  function worldDefaults() {
    const game = getGame("maze");
    return {
      game_id: "maze",
      gem_total: game ? buildWorlds.countWorldGems(game) : 0,
      room_total: game?.worldMap?.levels?.length || 0,
      start_level_id: game ? worldMaps.defaultLevelIdForGame(game) : "level_HxI"
    };
  }

  function bootstrapValue({ cli, account, published, local, models, modelsError = "" }) {
    const setup = primeSetupKind({
      cliOk: cli.ok,
      accountOk: account.ok,
      error: modelsError || account.error || ""
    });
    const readiness = {
      cli: cli.ok,
      account: account.ok,
      local_environment: local.ok,
      published_environment: published.ok,
      ready: cli.ok && account.ok && local.ok && published.ok && models.length > 0,
      setup,
      environment_id: environmentId,
      version: cli.output || "",
      issue:
        (!cli.ok && cli.error) ||
        (!account.ok && account.error) ||
        (!local.ok && local.error) ||
        (!published.ok && `Publish ${environmentId} to the Prime Environments Hub before launching.`) ||
        modelsError ||
        (!models.length ? "No Hosted Training models are currently available." : "")
    };
    return {
      readiness,
      models,
      defaults: {
        ...worldDefaults(),
        ...HOSTED_TRAINING_DEFAULTS
      }
    };
  }

  function bootstrap(options = {}) {
    if (!options.fresh && bootstrapCache && Date.now() - bootstrapCache.at < CACHE_MS) {
      return bootstrapCache.value;
    }

    const cli = probe(["--version"]);
    const account = cli.ok ? probe(["whoami"]) : { ok: false, error: "Prime CLI is unavailable." };
    const published = account.ok
      ? probe(["env", "info", environmentId], { timeout: 30_000 })
      : { ok: false, error: "Sign in to Prime first." };
    const local = localEnvironmentProbe();
    let models = [];
    let modelsError = "";
    if (account.ok) {
      try {
        models = liveModels();
      } catch (error) {
        modelsError = error.message;
      }
    }

    const value = bootstrapValue({ cli, account, published, local, models, modelsError });
    bootstrapCache = { at: Date.now(), value };
    return value;
  }

  async function bootstrapAsync(options = {}) {
    if (!options.fresh && bootstrapCache && Date.now() - bootstrapCache.at < CACHE_MS) {
      return bootstrapCache.value;
    }

    // These probes are independent. Running them together removes several
    // seconds of serialized CLI startup and, unlike spawnSync, keeps the local
    // web server responsive while Prime and uv initialize.
    const [cli, account, publishedProbe, local, modelsResult] = await Promise.all([
      probeAsync(["--version"]),
      probeAsync(["whoami"]),
      probeAsync(["env", "info", environmentId], { timeout: 30_000 }),
      localEnvironmentProbeAsync(),
      liveModelsAsync().then((models) => ({ models, error: "" })).catch((error) => ({ models: [], error: error.message }))
    ]);
    const published = account.ok ? publishedProbe : { ok: false, error: "Sign in to Prime first." };
    const models = account.ok ? modelsResult.models : [];
    const modelsError = account.ok ? modelsResult.error : "";
    const value = bootstrapValue({ cli, account, published, local, models, modelsError });
    bootstrapCache = { at: Date.now(), value };
    return value;
  }

  function listRuns() {
    const payload = parseJsonOutput(runPrime(["train", "list", "--num", "50", "--output", "json"]).stdout) || {};
    return { runs: payload.runs || [], total: Number(payload.total) || 0 };
  }

  async function listRunsAsync(options = {}) {
    const limit = Math.max(1, Math.min(50, Math.floor(Number(options.limit) || 10)));
    const payload = parseJsonOutput((await runPrimeAsync(["train", "list", "--num", String(limit), "--output", "json"])).stdout) || {};
    return { runs: payload.runs || [], total: Number(payload.total) || 0 };
  }

  function normalizeLaunchPayload(payload = {}) {
    const models = liveModels();
    const model = String(payload.model || "").trim();
    if (!model || !models.some((entry) => entry.id === model && !entry.at_capacity)) {
      throw new Error("Choose an available Hosted Training model.");
    }

    const rolloutsPerExample = integerInRange(
      payload.rollouts_per_example,
      "Rollouts per example",
      2,
      128,
      HOSTED_TRAINING_DEFAULTS.rollouts_per_example
    );
    const defaultBatchSize =
      Math.ceil(HOSTED_TRAINING_DEFAULTS.batch_size / rolloutsPerExample) * rolloutsPerExample;
    const batchSize = integerInRange(
      payload.batch_size,
      "Batch size",
      rolloutsPerExample,
      8192,
      defaultBatchSize
    );
    if (batchSize % rolloutsPerExample !== 0) {
      throw new Error("Batch size must be divisible by rollouts per example.");
    }

    const rewards = {
      gems: numberInRange(payload.gem_reward_weight, "Gem reward", 0, 100, HOSTED_TRAINING_DEFAULTS.gem_reward_weight),
      rooms: numberInRange(payload.room_reward_weight, "Room reward", 0, 100, HOSTED_TRAINING_DEFAULTS.room_reward_weight),
      pushes: numberInRange(payload.push_reward_weight, "Block reward", 0, 100, HOSTED_TRAINING_DEFAULTS.push_reward_weight)
    };
    if (rewards.gems + rewards.rooms + rewards.pushes <= 0) {
      throw new Error("At least one reward value must be greater than zero.");
    }

    const defaults = worldDefaults();
    const observationMode = payload.observation_mode === "vision" ? "vision" : "ascii";
    if (observationMode !== "ascii") {
      throw new Error("Hosted Training currently supports MazeBench Text observations only.");
    }
    return {
      model,
      name: String(payload.name || "MazeBench").trim().slice(0, 80) || "MazeBench",
      observationMode,
      rewards,
      startLevelId: String(payload.start_level_id || defaults.start_level_id),
      gameWonGemCount: 100,
      maxActions: integerInRange(payload.max_actions, "Actions per rollout", 1, 100_000, HOSTED_TRAINING_DEFAULTS.max_actions),
      maxSteps: integerInRange(payload.max_steps, "Training steps", 1, 100_000, HOSTED_TRAINING_DEFAULTS.max_steps),
      batchSize,
      rolloutsPerExample,
      maxTokens: integerInRange(payload.max_tokens, "Tokens per turn", 64, 131_072, HOSTED_TRAINING_DEFAULTS.max_tokens),
      temperature: numberInRange(payload.temperature, "Temperature", 0, 2, HOSTED_TRAINING_DEFAULTS.temperature)
    };
  }

  function trainingConfigToml(config) {
    return [
      `name = ${tomlString(config.name)}`,
      `model = ${tomlString(config.model)}`,
      `max_steps = ${config.maxSteps}`,
      `batch_size = ${config.batchSize}`,
      `rollouts_per_example = ${config.rolloutsPerExample}`,
      "",
      "[sampling]",
      `max_tokens = ${config.maxTokens}`,
      `temperature = ${config.temperature}`,
      "",
      "[[env]]",
      `id = ${tomlString(environmentId)}`,
      "",
      "[env.args]",
      "num_train_examples = 1",
      "num_eval_examples = 1",
      `start_level_id = ${tomlString(config.startLevelId)}`,
      "game_won_gem_count = 100",
      `gem_reward_weight = ${config.rewards.gems}`,
      `room_reward_weight = ${config.rewards.rooms}`,
      `push_reward_weight = ${config.rewards.pushes}`,
      `max_actions = ${config.maxActions}`,
      "allow_quit = false",
      `observation_mode = ${tomlString(config.observationMode)}`,
      ""
    ].join("\n");
  }

  function launch(payload) {
    const ready = bootstrap({ fresh: true }).readiness;
    if (!ready.ready) throw new Error(ready.issue || "Hosted Training is not ready.");

    const config = normalizeLaunchPayload(payload);
    fs.mkdirSync(generatedConfigDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const configPath = path.join(generatedConfigDir, `mazebench-${stamp}.toml`);
    fs.writeFileSync(configPath, trainingConfigToml(config), "utf8");

    const args = ["train", configPath, "--yes", "--output", "json"];
    const result = parseJsonOutput(runPrime(args, { timeout: 120_000 }).stdout) || {};
    return {
      run: result.run || result,
      config_path: path.relative(rootDir, configPath),
      environment_id: environmentId
    };
  }

  return {
    bootstrap,
    bootstrapAsync,
    environmentId,
    launch,
    listRuns,
    listRunsAsync,
    trainingConfigToml
  };
}

module.exports = { HOSTED_TRAINING_DEFAULTS, createTrainingService, primeSetupKind };
