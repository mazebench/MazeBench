#!/usr/bin/env node

// A tiny stdio MCP server that keeps MazeBench state outside the coding
// agent's shell sandbox. This lets Codex/Claude have genuinely read-only or
// offline shell policies while the maze itself can still save state and render
// vision frames. Swarm workers clone the lead session into independent run
// directories and explore those copies without racing the primary game.

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const GAME_WON_GEM_COUNT = 100;
const { spawnSync } = require("node:child_process");
const { publicObservationStatus, redactAgentStatus } = require("./codex-play");
const {
  preflightPythonSandbox,
  runSandboxedPython
} = require("./maze-python-sandbox");

const REPO_ROOT = path.resolve(process.env.MAZEBENCH_REPO_ROOT || path.join(__dirname, ".."));
const HELPER = path.join(REPO_ROOT, "scripts", "codex-play.js");
const RUN_DIR = path.resolve(process.env.MAZEBENCH_RUN_DIR || process.cwd());
const PRIMARY_SESSION = path.resolve(
  process.env.MAZEBENCH_SESSION_FILE || path.join(RUN_DIR, "session.json")
);
const SWARM_DIR = path.resolve(process.env.MAZEBENCH_SWARM_DIR || path.join(RUN_DIR, "swarm"));
const SWARM_WORKSPACES_DIR = path.resolve(
  process.env.MAZEBENCH_SWARM_WORKSPACES_DIR || path.join(RUN_DIR, "swarm-workspaces")
);
const AGENT_SWARM_WORKSPACES_DIR = String(
  process.env.MAZEBENCH_AGENT_SWARM_WORKSPACES_DIR || SWARM_WORKSPACES_DIR
);
const AGENT_WORKSPACE_DIR = path.resolve(
  process.env.MAZEBENCH_AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), "mazebench-agent-workspace")
);
const PYTHON_SANDBOX_STATE_DIR = path.resolve(
  process.env.MAZEBENCH_PYTHON_SANDBOX_STATE_DIR || path.join(RUN_DIR, ".python-sandbox")
);
const CODEX_BIN = process.env.MAZEBENCH_CODEX_BIN || "codex";
const PYTHON_BIN = process.env.MAZEBENCH_PYTHON_BIN || "";
const ACTIVITY_LOG = path.resolve(
  process.env.MAZEBENCH_TOOL_ACTIVITY_FILE || path.join(RUN_DIR, "tool-activity.jsonl")
);
const INSTANCE_EVENTS_LOG = path.resolve(
  process.env.MAZEBENCH_INSTANCE_EVENTS_FILE || path.join(RUN_DIR, "maze-instance-events.jsonl")
);
const PAUSE_REQUEST_FILE = path.join(RUN_DIR, "pause-request.json");
const PAUSE_BOUNDARY_FILE = path.join(RUN_DIR, "pause-boundary.json");
const PAUSE_CAPABILITY_FILE = path.join(RUN_DIR, "cold-pause-capability.json");
const RAW_PRIMARY_MOVE_BUDGET = String(process.env.MAZEBENCH_MOVE_BUDGET || "20").trim().toLowerCase();
const PRIMARY_MOVE_BUDGET = ["unlimited", "infinite", "infinity", "none"].includes(RAW_PRIMARY_MOVE_BUDGET)
  ? null
  : positiveInt(RAW_PRIMARY_MOVE_BUDGET, 20);
const ALLOW_QUIT = process.env.MAZEBENCH_ALLOW_QUIT !== "0";
const WORKER_ONLY = process.env.MAZEBENCH_WORKER_ONLY === "1";
const SWARM_REQUIRED = process.env.MAZEBENCH_SWARM === "1";
const MAX_SWARM_WORKERS = Math.min(32, positiveInt(process.env.MAZEBENCH_MAX_SWARM_WORKERS, 8));
const RESTRICTED_MODE = process.env.MAZEBENCH_RESTRICTED_MODE === "1";
const AUTO_RUN_TOOLS = !RESTRICTED_MODE && process.env.MAZEBENCH_AUTO_RUN_TOOLS === "1";
const AUTO_RUN_ALL_FRAMES = AUTO_RUN_TOOLS && process.env.MAZEBENCH_AUTO_RUN_ALL_FRAMES === "1";
const KIMI_OBSERVE_BREAK_ENABLED = process.env.MAZEBENCH_PROVIDER === "kimi";
const KIMI_IDENTICAL_ACTION_INTERVAL = 5;
const HTTP_TOKEN = String(process.env.MAZEBENCH_MCP_HTTP_TOKEN || "");
const WORKER_ALLOCATION_LOCK = path.join(SWARM_DIR, ".instance-allocation.lock");
const PYTHON_PREFLIGHTS = new Map();
const PYTHON_WORKSPACE_SNAPSHOT_LIMIT = 2000;
const MAX_ROUTE_FILE_BYTES = 1024 * 1024;
const OBSERVATION_DIRECTORY = "observations";

function sessionActionCount(file) {
  try {
    const session = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(session.actions) ? session.actions.length : 0;
  } catch (_error) {
    return 0;
  }
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

function primaryPauseRequest() {
  return readJson(PAUSE_REQUEST_FILE, null);
}

function primaryPauseBoundary() {
  return readJson(PAUSE_BOUNDARY_FILE, null);
}

// On Continue, the session already contains prior actions. The budget applies
// only to this invocation's additional primary actions, not the full history.
const PRIMARY_INITIAL_ACTION_COUNT = sessionActionCount(PRIMARY_SESSION);

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function safeWorkerId(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || `worker-${crypto.randomBytes(3).toString("hex")}`;
}

function workerDirectory(workerId) {
  const id = safeWorkerId(workerId);
  const directory = path.resolve(SWARM_DIR, id);
  const prefix = `${SWARM_DIR}${path.sep}`;
  if (!directory.startsWith(prefix)) throw new Error("Invalid worker id.");
  return directory;
}

function sessionFor(workerId) {
  if (!workerId) return PRIMARY_SESSION;
  const session = path.join(workerDirectory(workerId), "session.json");
  if (!fs.existsSync(session)) throw new Error(`Unknown maze worker \"${workerId}\".`);
  return session;
}

function runHelper(args, options = {}) {
  const result = spawnSync(process.execPath, [HELPER, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, MAZEBENCH_MCP_CHILD: "1" },
    ...(options.input === undefined ? {} : { input: String(options.input) }),
    maxBuffer: 128 * 1024 * 1024,
    ...(options.timeout === 0 ? {} : { timeout: options.timeout || 240000 })
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `Maze helper exited ${result.status}`).trim());
  }
  const text = String(result.stdout || "").trim();
  try {
    return applyQuitPolicy(JSON.parse(text));
  } catch (_error) {
    return { output: text };
  }
}

function applyQuitPolicy(value) {
  if (ALLOW_QUIT || !value || typeof value !== "object") return value;
  const status = value.status && typeof value.status === "object" ? value.status : value;
  if (Array.isArray(status.allowed_commands)) {
    status.allowed_commands = status.allowed_commands.filter(
      (command) => String(command).trim().toLowerCase() !== "quit"
    );
  }
  return value;
}

function startMaze() {
  const args = [
    "start",
    "--repo-root", REPO_ROOT,
    "--state", PRIMARY_SESSION,
    "--game", process.env.MAZEBENCH_GAME_ID || "maze",
    "--level", process.env.MAZEBENCH_LEVEL_ID || "level_HxI",
    "--view", process.env.MAZEBENCH_VIEW || "top-diagonal",
    "--yaw", String(Number(process.env.MAZEBENCH_YAW) || 0),
    "--game-won-gem-count", String(GAME_WON_GEM_COUNT),
    "--max-actions", PRIMARY_MOVE_BUDGET == null ? "unlimited" : String(PRIMARY_MOVE_BUDGET)
  ];
  if (process.env.MAZEBENCH_MODE === "vision") {
    args.push(
      "--vision",
      "--vision-width", String(positiveInt(process.env.MAZEBENCH_VISION_WIDTH, 512)),
      "--vision-height", String(positiveInt(process.env.MAZEBENCH_VISION_HEIGHT, 512))
    );
    const visionView = String(process.env.MAZEBENCH_VISION_VIEW || "").trim();
    if (visionView) args.push("--vision-view", visionView);
  } else if (process.env.MAZEBENCH_MODE === "json") {
    args.push("--json-observation");
    if (process.env.MAZEBENCH_OMNISCIENT === "1") args.push("--omniscient");
  }
  if (process.env.MAZEBENCH_HIDE_NAMES === "1") {
    args.push("--hide-names");
    const hideNamesSeed = String(process.env.MAZEBENCH_HIDE_NAMES_SEED || "").trim().slice(0, 128);
    if (hideNamesSeed) args.push("--hide-names-seed", hideNamesSeed);
  }
  if (!ALLOW_QUIT) args.push("--no-quit");
  return runHelper(args);
}

function synchronizePrimarySessionBudget() {
  const session = readJson(PRIMARY_SESSION, null);
  if (!session || typeof session !== "object" || Array.isArray(session)) return;
  const maxActions = PRIMARY_MOVE_BUDGET == null
    ? null
    : PRIMARY_INITIAL_ACTION_COUNT + PRIMARY_MOVE_BUDGET;
  if (session.maxActions === maxActions) return;
  writeJson(PRIMARY_SESSION, { ...session, maxActions });
}

function appendJsonLine(filePath, entry) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
  } catch (_error) {
    /* telemetry must never break gameplay */
  }
}

function writeJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

writeJson(PAUSE_CAPABILITY_FILE, {
  version: 2,
  pid: process.pid,
  started_at: new Date().toISOString(),
  boundary: "immediate-process-tree-cancellation"
});

function compactStatus(value) {
  const status = value?.status || value || {};
  const gemCount = Math.max(0, Number(status.gem_count) || 0);
  return {
    action_count: Math.max(0, Number(status.action_count) || 0),
    current_room: String(status.current_room || ""),
    current_view: String(status.current_view || ""),
    game_lost: Boolean(status.game_lost || status.player_dead),
    game_won: gemCount >= GAME_WON_GEM_COUNT,
    gem_count: gemCount,
    ...(process.env.MAZEBENCH_MODE === "json" ? { player: status.player || null } : {}),
    quit: Boolean(status.quit),
    yaw: Number(status.yaw) || 0
  };
}

function updateInstanceTelemetry(input, entry) {
  if (!input?.clone_id) return;
  const metadata = readWorkerMetadata(input.clone_id);
  if (!metadata) return;
  const filePath = path.join(workerDirectory(input.clone_id), "telemetry.json");
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    current = {};
  }
  writeJson(filePath, {
    instance_id: String(input.clone_id),
    parent_instance_id: metadata.parent_instance_id || "primary",
    fork_action_count: Math.max(0, Number(metadata.fork_action_count) || 0),
    actions_attempted: Math.max(0, Number(current.actions_attempted) || 0) + 1,
    actions_applied: Math.max(0, Number(current.actions_applied) || 0) + (entry.applied ? 1 : 0),
    last_action: String(entry.action || ""),
    last_action_at: entry.at,
    last_error: String(entry.error || ""),
    action_count: Math.max(0, Number(entry.action_count_after) || 0),
    own_action_count: Math.max(0, Number(entry.own_action_count) || 0),
    status: entry.status || current.status || null
  });
}

function readWorkerMetadata(workerId) {
  if (!workerId) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(workerDirectory(workerId), "worker.json"), "utf8"));
  } catch (_error) {
    return null;
  }
}

function withWorkerAllocationLock(callback) {
  fs.mkdirSync(SWARM_DIR, { recursive: true });
  const deadline = Date.now() + 30_000;
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(WORKER_ALLOCATION_LOCK, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(WORKER_ALLOCATION_LOCK).mtimeMs > 5 * 60_000;
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      if (stale) {
        try {
          fs.rmSync(WORKER_ALLOCATION_LOCK);
        } catch (removeError) {
          if (removeError?.code !== "ENOENT") throw removeError;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out while assigning a private swarm-worker instance.");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return callback();
  } finally {
    fs.closeSync(descriptor);
    try {
      fs.rmSync(WORKER_ALLOCATION_LOCK);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function createWorker(requestedId, options = {}) {
  if (!SWARM_REQUIRED) {
    throw new Error("Private worker instances are available only when agent swarm mode is enabled.");
  }
  if (!fs.existsSync(PRIMARY_SESSION)) {
    throw new Error("The lead must start or resume the primary maze before a worker can begin.");
  }
  return withWorkerAllocationLock(() => {
    if (listWorkers().length >= MAX_SWARM_WORKERS) {
      throw new Error(`This run already has its maximum of ${MAX_SWARM_WORKERS} swarm workers.`);
    }
    return createWorkerUnlocked(requestedId, options);
  });
}

function createWorkerUnlocked(requestedId, options = {}) {
  const sourceSession = PRIMARY_SESSION;
  const sourceDirectory = path.dirname(PRIMARY_SESSION);
  const forkActionCount = sessionActionCount(sourceSession);
  const ownerKind = "subagent";

  fs.mkdirSync(SWARM_DIR, { recursive: true });
  const base = safeWorkerId(requestedId);
  let id = base;
  let directory;
  let allocated = false;
  for (let index = 1; index < 1000; index += 1) {
    directory = workerDirectory(id);
    try {
      fs.mkdirSync(directory);
      allocated = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      id = `${base}-${index + 1}`;
    }
  }
  if (!allocated || !directory) throw new Error("Could not allocate a worker directory.");

  const session = path.join(directory, "session.json");
  const workspace = path.join(SWARM_WORKSPACES_DIR, id);
  const agentWorkspace = path.posix.join(AGENT_SWARM_WORKSPACES_DIR, id);
  fs.copyFileSync(sourceSession, session);
  const clonedSession = readJson(session, null);
  if (clonedSession && typeof clonedSession === "object" && !Array.isArray(clonedSession)) {
    writeJson(session, { ...clonedSession, maxActions: null });
  }
  fs.mkdirSync(workspace, { recursive: true });
  const agentUid = Number(process.env.MAZEBENCH_AGENT_UID);
  const agentGid = Number(process.env.MAZEBENCH_AGENT_GID);
  if (Number.isInteger(agentUid) && Number.isInteger(agentGid)) {
    fs.chownSync(workspace, agentUid, agentGid);
  }

  const sourceActions = path.join(sourceDirectory, "actions.jsonl");
  if (fs.existsSync(sourceActions)) {
    fs.copyFileSync(sourceActions, path.join(directory, "actions.jsonl"));
  }
  const sourceInitialStatus = path.join(sourceDirectory, "initial-status.json");
  if (fs.existsSync(sourceInitialStatus)) {
    fs.copyFileSync(sourceInitialStatus, path.join(directory, "initial-status.json"));
  }
  const sourceFrames = path.join(sourceDirectory, "frames");
  if (fs.existsSync(sourceFrames)) {
    const latestFrame = fs.readdirSync(sourceFrames)
      .map((name) => ({ name, match: name.match(/^frame-(\d+)\.png$/) }))
      .filter((entry) => entry.match && Number(entry.match[1]) <= forkActionCount)
      .sort((left, right) => Number(right.match[1]) - Number(left.match[1]))[0];
    if (latestFrame) {
      const targetFrames = path.join(directory, "frames");
      fs.mkdirSync(targetFrames, { recursive: true });
      fs.copyFileSync(path.join(sourceFrames, latestFrame.name), path.join(targetFrames, latestFrame.name));
    }
  }

  const metadata = {
    id,
    created_at: new Date().toISOString(),
    source_session: sourceSession,
    session,
    workspace,
    agent_workspace: agentWorkspace,
    parent_instance_id: "primary",
    fork_action_count: forkActionCount,
    primary_action_count_at_fork: sessionActionCount(PRIMARY_SESSION),
    owner_kind: ownerKind,
    owner_agent_id: String(options.ownerAgentId || requestedId || id).slice(0, 80),
    label: String(options.label || requestedId || id).slice(0, 120),
    observation_mode: ["json", "vision"].includes(process.env.MAZEBENCH_MODE)
      ? process.env.MAZEBENCH_MODE
      : "text"
  };
  fs.writeFileSync(path.join(directory, "worker.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  writeJson(path.join(directory, "telemetry.json"), {
    instance_id: id,
    parent_instance_id: metadata.parent_instance_id,
    fork_action_count: metadata.fork_action_count,
    actions_attempted: 0,
    actions_applied: 0,
    last_action: "",
    last_action_at: null,
    last_error: "",
    action_count: metadata.fork_action_count,
    own_action_count: 0,
    status: null
  });
  appendJsonLine(INSTANCE_EVENTS_LOG, {
    type: "instance.created",
    at: metadata.created_at,
    instance_id: id,
    parent_instance_id: metadata.parent_instance_id,
    fork_action_count: metadata.fork_action_count,
    primary_action_count_at_fork: metadata.primary_action_count_at_fork,
    owner_kind: metadata.owner_kind,
    owner_agent_id: metadata.owner_agent_id,
    label: metadata.label,
    observation_mode: metadata.observation_mode
  });
  return {
    ...metadata,
    own_action_count: 0,
    instruction:
      `This worker is bound to one private maze instance. ` +
      `Put code and notes in ${agentWorkspace}. Never act on the primary maze; report findings to the lead.`
  };
}

function listWorkers() {
  if (!fs.existsSync(SWARM_DIR)) return [];
  return fs.readdirSync(SWARM_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = path.join(SWARM_DIR, entry.name);
      try {
        return JSON.parse(fs.readFileSync(path.join(directory, "worker.json"), "utf8"));
      } catch (_error) {
        return {
          id: entry.name,
          session: path.join(directory, "session.json"),
          workspace: path.join(SWARM_WORKSPACES_DIR, entry.name),
          agent_workspace: path.posix.join(AGENT_SWARM_WORKSPACES_DIR, entry.name)
        };
      }
    });
}

function finishWorkerContext(context) {
  const workerId = String(context?.assignedCloneId || "");
  if (!workerId) return;
  const metadata = readWorkerMetadata(workerId);
  if (!metadata || metadata.finished_at) return;
  const finishedAt = new Date().toISOString();
  writeJson(path.join(workerDirectory(workerId), "worker.json"), {
    ...metadata,
    finished_at: finishedAt
  });
  appendJsonLine(INSTANCE_EVENTS_LOG, {
    type: "instance.finished",
    at: finishedAt,
    instance_id: workerId,
    parent_instance_id: metadata.parent_instance_id || "primary",
    owner_kind: metadata.owner_kind || "subagent",
    owner_agent_id: metadata.owner_agent_id || ""
  });
}

function pythonWorkspaceForInput(input = {}) {
  if (!input.clone_id) return AGENT_WORKSPACE_DIR;
  const metadata = readWorkerMetadata(input.clone_id);
  if (!metadata?.workspace) throw new Error("This worker has no isolated Python workspace.");
  const workspace = path.resolve(metadata.workspace);
  const relative = path.relative(SWARM_WORKSPACES_DIR, workspace);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Invalid worker Python workspace.");
  }
  return workspace;
}

function pythonSandboxOptions(workspace) {
  const key = crypto.createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  return {
    scratchDir: workspace,
    stateDir: path.join(PYTHON_SANDBOX_STATE_DIR, key),
    deniedPaths: [REPO_ROOT, RUN_DIR, os.homedir()],
    codexBin: CODEX_BIN,
    pythonBin: PYTHON_BIN
  };
}

function pythonWorkspaceSnapshot(workspace) {
  const root = path.resolve(workspace);
  const files = new Map();
  let truncated = false;

  function visit(directory, prefix = "") {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.size >= PYTHON_WORKSPACE_SNAPSHOT_LIMIT) {
        truncated = true;
        return;
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      let stat;
      try {
        stat = fs.lstatSync(absolute);
      } catch (_error) {
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(absolute, relative);
        if (truncated) return;
      } else {
        files.set(relative, `${stat.size}:${stat.mtimeMs}:${entry.isSymbolicLink() ? "link" : "file"}`);
      }
    }
  }

  visit(root);
  return { files, truncated };
}

function pythonWorkspaceChanges(before, after) {
  const created = [];
  const modified = [];
  const deleted = [];
  for (const [file, signature] of after.files) {
    if (!before.files.has(file)) created.push(file);
    else if (before.files.get(file) !== signature) modified.push(file);
  }
  for (const file of before.files.keys()) {
    if (!after.files.has(file)) deleted.push(file);
  }
  return {
    created,
    modified,
    deleted,
    truncated: before.truncated || after.truncated
  };
}

function pathInsideWorkspace(workspace, candidate) {
  const relative = path.relative(path.resolve(workspace), path.resolve(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function workspaceFile(workspace, requestedPath, label) {
  const raw = String(requestedPath || "").trim();
  if (!raw) throw new Error(`${label} is required.`);
  if (path.isAbsolute(raw)) throw new Error(`${label} must be relative to the solver workspace.`);
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(workspace);
  const resolved = path.resolve(root, raw);
  if (!pathInsideWorkspace(root, resolved)) {
    throw new Error(`${label} must stay inside the solver workspace.`);
  }
  let canonical;
  try {
    canonical = fs.realpathSync(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} does not exist.`);
    throw error;
  }
  if (!pathInsideWorkspace(root, canonical)) {
    throw new Error(`${label} must not resolve outside the solver workspace.`);
  }
  const stat = fs.statSync(canonical);
  if (!stat.isFile()) throw new Error(`${label} must name a regular file.`);
  if (stat.size > MAX_ROUTE_FILE_BYTES) {
    throw new Error(`${label} exceeds ${MAX_ROUTE_FILE_BYTES} bytes.`);
  }
  return canonical;
}

function sequencePlan(input, effectiveInput) {
  if (Array.isArray(input.actions)) {
    return { actions: input.actions, routeFile: "", observationRevision: null };
  }
  const workspace = pythonWorkspaceForInput(effectiveInput);
  const routeFile = String(input.route_file || "").trim();
  const absolute = workspaceFile(workspace, routeFile, "route_file");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new Error(`route_file must contain valid JSON: ${safeErrorMessage(error)}`);
  }
  const actions = Array.isArray(parsed) ? parsed : parsed?.actions;
  if (!Array.isArray(actions) || actions.length < 1) {
    throw new Error("route_file must contain a non-empty actions array.");
  }
  const normalizedActions = actions.map((action, index) => {
    if (typeof action !== "string" || !action.trim()) {
      throw new Error(`route_file actions[${index}] must be a non-empty string.`);
    }
    return action.trim();
  });
  const rawRevision = Array.isArray(parsed)
    ? null
    : parsed.observation_revision ?? parsed.revision ?? null;
  const observationRevision = rawRevision === null ? null : Number(rawRevision);
  if (
    observationRevision !== null &&
    (!Number.isInteger(observationRevision) || observationRevision < 0)
  ) {
    throw new Error("route_file observation_revision must be a non-negative integer.");
  }
  const currentRevision = actionCountForInput(effectiveInput);
  if (observationRevision !== null && observationRevision !== currentRevision) {
    throw new Error(
      `route_file is stale: it was planned from observation revision ${observationRevision}, ` +
      `but the live maze is at revision ${currentRevision}. Rerun the saved planner.`
    );
  }
  return { actions: normalizedActions, routeFile, observationRevision };
}

function rawObservation(value) {
  if (!value || typeof value !== "object") return null;
  const status = value.status && typeof value.status === "object" ? value.status : value;
  if (!status.json_observation) return null;
  return publicObservationStatus(status, { mode: "json" });
}

function observationWorkspaceDirectory(workspace) {
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(workspace);
  const directory = path.join(root, OBSERVATION_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonical = fs.realpathSync(directory);
  if (!pathInsideWorkspace(root, canonical)) {
    throw new Error("The observation directory must stay inside the solver workspace.");
  }
  return canonical;
}

function deliveredObservationRecords(value, effectiveInput) {
  if (process.env.MAZEBENCH_MODE !== "json" || !value || typeof value !== "object") return [];
  if (!Object.prototype.hasOwnProperty.call(value, "final_observation")) {
    const observation = rawObservation(value);
    return observation
      ? [{ observation, revision: actionCountForInput(effectiveInput) }]
      : [];
  }
  const steps = Array.isArray(value.steps) ? value.steps : [];
  const records = [];
  for (const entry of value.intermediate_observations || []) {
    const observation = rawObservation(entry.observation);
    if (!observation) continue;
    const step = steps.find((candidate) => Number(candidate.index) === Number(entry.index));
    records.push({
      observation,
      revision: Math.max(0, Number(step?.action_count_after) || Number(entry.index) || 0)
    });
  }
  const finalObservation = rawObservation(value.final_observation);
  if (finalObservation) {
    const finalStep = steps.at(-1);
    records.push({
      observation: finalObservation,
      revision: Math.max(
        0,
        Number(finalStep?.action_count_after) || actionCountForInput(effectiveInput)
      )
    });
  }
  return records;
}

function syncObservationWorkspace(value, effectiveInput) {
  const records = deliveredObservationRecords(value, effectiveInput);
  if (!records.length) return null;
  const workspace = pythonWorkspaceForInput(effectiveInput);
  const directory = observationWorkspaceDirectory(workspace);
  for (const record of records) {
    const snapshot = {
      ...record.observation,
      observation_revision: record.revision
    };
    writeJson(
      path.join(directory, `${String(record.revision).padStart(6, "0")}.json`),
      snapshot
    );
    appendJsonLine(path.join(directory, "history.jsonl"), snapshot);
    writeJson(path.join(directory, "current.json"), snapshot);
  }
  const latest = records.at(-1);
  return {
    current_file: `${OBSERVATION_DIRECTORY}/current.json`,
    history_file: `${OBSERVATION_DIRECTORY}/history.jsonl`,
    observation_revision: latest.revision,
    snapshots_written: records.length
  };
}

function runPythonTool(input = {}) {
  if (RESTRICTED_MODE) throw new Error("Python is disabled in game-only mode.");
  const workspace = pythonWorkspaceForInput(input);
  const options = pythonSandboxOptions(workspace);
  if (!PYTHON_PREFLIGHTS.has(workspace)) {
    PYTHON_PREFLIGHTS.set(workspace, preflightPythonSandbox(options));
  }
  return runSandboxedPython(String(input.code || ""), {
    ...options,
    timeoutSeconds: Number(input.timeout_seconds) || 10
  });
}

const LEAD_TOOLS = [
  {
    name: "maze_start",
    description: "Start the primary MazeBench session. The lead agent calls this exactly once on a fresh run.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "maze_observe",
    description: "Observe the lead agent's primary maze.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "maze_action",
    description: "Apply one MazeBench action to the lead agent's primary maze.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: ALLOW_QUIT
            ? "up, down, left, right, rotate camera up/down/left/right, undo, reset, quit, or go to level X Y"
            : "up, down, left, right, rotate camera up/down/left/right, undo, reset, or go to level X Y"
        }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "maze_action_sequence",
    description: "Apply a solver-generated action sequence in order. Pass actions directly or route_file for a JSON route saved in the isolated solver workspace. Returns compact per-step summaries and the final observation by default; optionally returns every intermediate observation.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
          description: "An ordered action list produced by the saved solver."
        },
        route_file: {
          type: "string",
          minLength: 1,
          description: "A relative JSON file in the solver workspace containing either an actions array or {observation_revision, actions}."
        },
        include_intermediate_observations: {
          type: "boolean",
          default: AUTO_RUN_ALL_FRAMES,
          description: AUTO_RUN_ALL_FRAMES
            ? "Every intermediate ASCII board, JSON observation, or vision frame is enforced by this run's harness."
            : "When true, also return every intermediate ASCII board, JSON observation, or vision frame."
        }
      },
      oneOf: [{ required: ["actions"] }, { required: ["route_file"] }],
      additionalProperties: false
    }
  },
  {
    name: "maze_workers",
    description: "List the private maze instances assigned to swarm workers during this run.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "python_exec",
    description: "Run Python in this agent's writable persistent isolated scratch workspace. In JSON mode, observations/current.json is automatically synchronized from the latest sanitized game result, so programs can import it without copying MCP output. Each call uses a fresh Python process, while relative-path files in the current working directory persist for the run. Create and reuse Python programs with pathlib/open and execute them with runpy/import. Repository files, host files, run artifacts, subprocesses, and network access are blocked.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Python source code to execute." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 60, default: 10 }
      },
      required: ["code"],
      additionalProperties: false
    }
  }
];

const WORKER_TOOLS = [
  {
    name: "maze_start",
    description: "Start or reconnect to this swarm worker's one assigned private maze instance.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "maze_observe",
    description: "Observe this swarm worker's assigned private maze instance.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "maze_action",
    description: "Apply one action to this swarm worker's assigned private maze instance.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: ALLOW_QUIT
            ? "up, down, left, right, rotate camera up/down/left/right, undo, reset, quit, or go to level X Y"
            : "up, down, left, right, rotate camera up/down/left/right, undo, reset, or go to level X Y"
        }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "maze_action_sequence",
    description: "Apply a solver-generated action sequence in order to this worker's private maze. Pass actions directly or route_file for a JSON route saved in this worker's isolated solver workspace. Returns compact summaries and the final observation unless intermediate observations are requested.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 }
        },
        route_file: { type: "string", minLength: 1 },
        include_intermediate_observations: { type: "boolean", default: AUTO_RUN_ALL_FRAMES }
      },
      oneOf: [{ required: ["actions"] }, { required: ["route_file"] }],
      additionalProperties: false
    }
  },
  {
    name: "python_exec",
    description: "Run Python in this worker's private writable persistent isolated scratch workspace. In JSON mode, observations/current.json is automatically synchronized from the latest sanitized game result, so programs can import it without copying MCP output. Each call uses a fresh Python process, while relative-path files in the current working directory persist for the run. Create and reuse Python programs with pathlib/open and execute them with runpy/import. Repository files, host files, run artifacts, subprocesses, and network access are blocked.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Python source code to execute." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 60, default: 10 }
      },
      required: ["code"],
      additionalProperties: false
    }
  }
];

const RESTRICTED_TOOLS = [
  {
    name: "game_start",
    description: "Start the current game once and return its first observation.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "game_observe",
    description: "Return the current game observation without changing state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "game_action",
    description: "Apply one allowed action to the current game.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: ALLOW_QUIT
            ? "up, down, left, right, rotate camera up/down/left/right, undo, reset, quit, or go to level X Y"
            : "up, down, left, right, rotate camera up/down/left/right, undo, reset, or go to level X Y"
        }
      },
      required: ["action"],
      additionalProperties: false
    }
  }
];

function createRequestContext({ workerOnly = false, workerKey = "" } = {}) {
  return {
    workerOnly: Boolean(workerOnly),
    workerKey: safeWorkerId(workerKey || `swarm-worker-${crypto.randomBytes(6).toString("hex")}`),
    assignedCloneId: "",
    lastActionKey: null,
    identicalActionStreak: 0,
    observeRequired: false
  };
}

function normalizedActionKey(action) {
  return String(action || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function resetKimiActionStreak(context) {
  context.lastActionKey = null;
  context.identicalActionStreak = 0;
  context.observeRequired = false;
}

function noteKimiAction(context, action) {
  const actionKey = normalizedActionKey(action);
  if (actionKey === context.lastActionKey) {
    context.identicalActionStreak += 1;
  } else {
    context.lastActionKey = actionKey;
    context.identicalActionStreak = 1;
  }
  context.observeRequired = context.identicalActionStreak >= KIMI_IDENTICAL_ACTION_INTERVAL;
}

function kimiToolName(kind) {
  return `${RESTRICTED_MODE ? "game" : "maze"}_${kind}`;
}

function kimiResultIsTerminal(value, input) {
  const candidate = value?.final_observation || value;
  const status = candidate?.status && typeof candidate.status === "object" ? candidate.status : candidate;
  if (
    Math.max(0, Number(status?.gem_count) || 0) >= GAME_WON_GEM_COUNT ||
    status?.game_lost ||
    status?.quit ||
    status?.user_pause_requested
  ) {
    return true;
  }
  return Boolean(
    !input?.clone_id &&
    (primaryPauseBoundary() ||
      (PRIMARY_MOVE_BUDGET != null &&
        sessionActionCount(PRIMARY_SESSION) - PRIMARY_INITIAL_ACTION_COUNT >= PRIMARY_MOVE_BUDGET))
  );
}

function kimiLoopControl(name, value, input, context) {
  if (
    !KIMI_OBSERVE_BREAK_ENABLED ||
    !["maze_start", "maze_observe", "maze_action", "maze_action_sequence"].includes(name) ||
    kimiResultIsTerminal(value, input)
  ) {
    return null;
  }
  return {
    completion_allowed: false,
    next_required_tool: kimiToolName(context.observeRequired ? "observe" : "action"),
    ...(context.observeRequired ? { observe_required: true } : {})
  };
}

function ensureWorkerAssignment(context) {
  if (!context?.workerOnly) throw new Error("Only swarm workers receive private maze instances.");
  if (!SWARM_REQUIRED) throw new Error("Private worker instances require agent swarm mode.");
  if (primaryPauseRequest()) {
    throw new Error("The user is pausing this run. Stop worker exploration and report back to the lead now.");
  }
  if (context.assignedCloneId) return context.assignedCloneId;
  const worker = createWorker(context.workerKey, {
    workerOnly: true,
    ownerAgentId: context.workerKey,
    label: context.workerKey
  });
  context.assignedCloneId = worker.id;
  return worker.id;
}

function normalizedToolCall(name, input = {}, { workerOnly = false } = {}) {
  if (!RESTRICTED_MODE) {
    const allowedNames = new Set(
      toolsFor(workerOnly).map((tool) => tool.name)
    );
    if (!allowedNames.has(name)) throw new Error(`Unknown game control "${name}".`);
    const allowedKeys = name === "maze_action"
      ? new Set(["action"])
      : name === "maze_action_sequence"
        ? new Set(["actions", "route_file", "include_intermediate_observations"])
      : name === "python_exec"
        ? new Set(["code", "timeout_seconds"])
        : new Set();
    const extraKey = Object.keys(input).find((key) => !allowedKeys.has(key));
    if (extraKey) throw new Error(`Unsupported argument "${extraKey}" for ${name}.`);
    if (name === "maze_action") return { name, input: { action: input.action } };
    if (name === "maze_action_sequence") {
      const hasActions = Array.isArray(input.actions);
      const routeFile = String(input.route_file || "").trim();
      if (hasActions === Boolean(routeFile)) {
        throw new Error("Supply exactly one of actions or route_file.");
      }
      let actions;
      if (hasActions) {
        if (input.actions.length < 1) throw new Error("actions must contain at least one item.");
        actions = input.actions.map((action, index) => {
          if (typeof action !== "string" || !action.trim()) {
            throw new Error(`actions[${index}] must be a non-empty string.`);
          }
          return action.trim();
        });
      }
      if (
        input.include_intermediate_observations !== undefined &&
        typeof input.include_intermediate_observations !== "boolean"
      ) {
        throw new Error("include_intermediate_observations must be a boolean.");
      }
      return {
        name,
        input: {
          ...(hasActions ? { actions } : { route_file: routeFile }),
          include_intermediate_observations:
            AUTO_RUN_ALL_FRAMES || input.include_intermediate_observations === true
        }
      };
    }
    if (name === "python_exec") {
      const timeoutSeconds = input.timeout_seconds === undefined ? 10 : Number(input.timeout_seconds);
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 60) {
        throw new Error("timeout_seconds must be an integer between 1 and 60.");
      }
      return { name, input: { code: String(input.code || ""), timeout_seconds: timeoutSeconds } };
    }
    return { name, input: {} };
  }
  if (!/^game_(start|observe|action)$/.test(name)) {
    throw new Error(`Unknown game control "${name}".`);
  }
  const allowedKeys = name === "game_action" ? new Set(["action"]) : new Set();
  const extraKey = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (extraKey) throw new Error(`Unsupported argument "${extraKey}" for ${name}.`);
  return {
    name: name.replace(/^game_/, "maze_"),
    input: name === "game_action" ? { action: input.action } : {}
  };
}

function runActionSequence(input, context) {
  if (!AUTO_RUN_TOOLS) throw new Error("Auto-run tools are not enabled for this run.");
  const workerOnly = Boolean(context?.workerOnly);
  const cloneId = workerOnly ? ensureWorkerAssignment(context) : "";
  const effectiveInput = cloneId ? { ...input, clone_id: cloneId } : input;
  const plan = sequencePlan(input, effectiveInput);
  if (workerOnly && primaryPauseRequest()) {
    throw new Error("The user is pausing this run. Stop worker exploration and report back to the lead now.");
  }
  const batch = runHelper(
    ["action-sequence", "--state", sessionFor(effectiveInput.clone_id)],
    {
      input: JSON.stringify({ actions: plan.actions, primary: !effectiveInput.clone_id }),
      timeout: 0
    }
  );
  const batchSteps = Array.isArray(batch.steps) ? batch.steps : [];
  const observations = batchSteps
    .filter((step) => step?.observation)
    .map((step) => step.observation);
  const steps = batchSteps.map((step) => ({
    index: Math.max(1, Number(step.index) || 1),
    action: String(step.action || ""),
    recorded: Boolean(step.recorded),
    action_count_before: Math.max(0, Number(step.action_count_before) || 0),
    action_count_after: Math.max(0, Number(step.action_count_after) || 0),
    ...(step.error ? { error: safeErrorMessage(step.error) } : {}),
    status: step.observation
      ? compactStatus(step.observation)
      : step.status
        ? compactStatus(step.status)
        : null
  }));
  const completedCount = observations.length;
  const finalObservation = observations.at(-1) || null;
  return {
    requested_count: plan.actions.length,
    attempted_count: Math.max(0, Number(batch.attempted_count) || 0),
    completed_count: completedCount,
    stopped_early: completedCount < plan.actions.length,
    stop_reason: String(batch.stop_reason || "completed"),
    steps,
    ...(input.include_intermediate_observations
      ? {
          intermediate_observations: observations.slice(0, -1).map((observation, index) => ({
            index: index + 1,
            action: plan.actions[index],
            observation
          }))
        }
      : {}),
    final_observation: finalObservation,
    ...(plan.routeFile
      ? {
          route_file: plan.routeFile,
          route_observation_revision: plan.observationRevision
        }
      : {})
  };
}

function callTool(name, input = {}, context = createRequestContext({ workerOnly: WORKER_ONLY })) {
  const workerOnly = Boolean(context?.workerOnly);
  const cloneId = workerOnly ? ensureWorkerAssignment(context) : "";
  const effectiveInput = cloneId ? { ...input, clone_id: cloneId } : input;
  if (name === "python_exec") return runPythonTool(effectiveInput);
  if (!workerOnly && name !== "maze_start") synchronizePrimarySessionBudget();
  if (name === "maze_start") {
    if (workerOnly) return runHelper(["observe", "--state", sessionFor(cloneId)]);
    return startMaze();
  }
  if (name === "maze_observe") {
    return runHelper(["observe", "--state", sessionFor(effectiveInput.clone_id)]);
  }
  if (name === "maze_action_sequence") {
    return runActionSequence(input, context);
  }
  if (name === "maze_action") {
    if (!String(input.action || "").trim()) throw new Error("action is required.");
    if (workerOnly && primaryPauseRequest()) {
      throw new Error("The user is pausing this run. Stop worker exploration and report back to the lead now.");
    }
    if (!effectiveInput.clone_id && primaryPauseBoundary()) {
      throw new Error("The user paused this run after the previous completed action. End your response now; the same thread will resume later.");
    }
    if (!ALLOW_QUIT && String(input.action).trim().toLowerCase() === "quit") {
      throw new Error(
        PRIMARY_MOVE_BUDGET == null
          ? "Quit is disabled by the user for this unlimited run. Continue playing until the maze is won or the user stops the run."
          : "Quit is disabled by the user for this run. Continue playing until the budget is exhausted or the user stops the run."
      );
    }
    if (
      PRIMARY_MOVE_BUDGET != null &&
      !effectiveInput.clone_id &&
      sessionActionCount(PRIMARY_SESSION) - PRIMARY_INITIAL_ACTION_COUNT >= PRIMARY_MOVE_BUDGET
    ) {
      throw new Error(`The primary move budget of ${PRIMARY_MOVE_BUDGET} action(s) is exhausted. Finish the run.`);
    }
    const result = runHelper(["action", "--state", sessionFor(effectiveInput.clone_id), String(input.action)]);
    if (!effectiveInput.clone_id) {
      const pauseRequest = primaryPauseRequest();
      const actionCount = sessionActionCount(PRIMARY_SESSION);
      const requestedAfter = Math.max(0, Number(pauseRequest?.requested_after_turn) || 0);
      if (pauseRequest && actionCount > requestedAfter) {
        const at = new Date().toISOString();
        writeJson(PAUSE_BOUNDARY_FILE, {
          requested_at: pauseRequest.requested_at || null,
          completed_at: at,
          completed_turn: actionCount,
          provider_thread_can_exit: true
        });
        const status = result?.status && typeof result.status === "object" ? result.status : result;
        if (status && typeof status === "object") {
          status.user_pause_requested = true;
          status.pause_message =
            "The user requested a pause. This action is fully saved. Do not take another maze action; end your response now so this exact thread can resume later.";
          status.allowed_commands = [];
        }
      }
    }
    return result;
  }
  if (name === "maze_workers") return listWorkers();
  throw new Error(`Unknown tool \"${name}\".`);
}

function stdioSend(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function success(send, id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .split(/\r?\n/, 1)[0]
    .replaceAll(REPO_ROOT, "[maze runtime]")
    .replaceAll(RUN_DIR, "[run]");
}

function failure(send, id, error) {
  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32000, message: safeErrorMessage(error) }
  });
}

function toolsFor(workerOnly) {
  if (RESTRICTED_MODE) return RESTRICTED_TOOLS;
  if (workerOnly) {
    return SWARM_REQUIRED
      ? WORKER_TOOLS.filter((tool) => AUTO_RUN_TOOLS || tool.name !== "maze_action_sequence")
      : [];
  }
  const tools = SWARM_REQUIRED
    ? LEAD_TOOLS
    : LEAD_TOOLS.filter((tool) => tool.name !== "maze_workers");
  return tools.filter((tool) => AUTO_RUN_TOOLS || tool.name !== "maze_action_sequence");
}

function publicToolValue(value) {
  const mode = ["json", "vision"].includes(process.env.MAZEBENCH_MODE)
    ? process.env.MAZEBENCH_MODE
    : "text";
  if (Array.isArray(value)) return value.map(publicToolValue);
  const status = value?.status && typeof value.status === "object" ? value.status : value;
  const hasObservation = status && typeof status === "object" && (
    typeof status.level === "string" ||
    status.json_observation ||
    status.frame_image
  );
  if (hasObservation) {
    const printable = publicObservationStatus(status, { mode });
    if (printable.frame_image) printable.frame_image = "attached:image/png";
    return printable;
  }
  const observationWrapper = value && typeof value === "object" && (
    Object.prototype.hasOwnProperty.call(value, "observation") ||
    Object.prototype.hasOwnProperty.call(value, "final_observation")
  );
  if (observationWrapper) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["session", "source_session", "workspace", "cpu_time_ms"].includes(key))
        .map(([key, item]) => [key, publicToolValue(item)])
    );
  }
  value = redactAgentStatus(value, { mode });
  if (!value || typeof value !== "object") return value;
  const printable = {};
  for (const [key, item] of Object.entries(value)) {
    // These are trusted-runner paths. They are not useful to the provider and
    // exposing them makes the isolation boundary needlessly discoverable.
    if (["session", "source_session", "workspace", "cpu_time_ms"].includes(key)) continue;
    printable[key] = key === "frame_image" ? "attached:image/png" : publicToolValue(item);
  }
  return printable;
}

function observationFramePath(value) {
  if (!value || typeof value !== "object") return "";
  const status = value.status && typeof value.status === "object" ? value.status : value;
  return String(status.frame_image || value.frame_image || "");
}

function frameEntries(value) {
  if (!value || typeof value !== "object") return [];
  if (Object.prototype.hasOwnProperty.call(value, "final_observation")) {
    const entries = Array.isArray(value.intermediate_observations)
      ? value.intermediate_observations.map((entry) => ({
          framePath: observationFramePath(entry.observation)
        }))
      : [];
    entries.push({
      framePath: observationFramePath(value.final_observation)
    });
    return entries;
  }
  return [{ framePath: observationFramePath(value) }];
}

function toolContent(value, control = null) {
  const printable = publicToolValue(value);
  if (control && printable && typeof printable === "object" && !Array.isArray(printable)) {
    Object.assign(printable, control);
  }
  const content = [{ type: "text", text: JSON.stringify(printable, null, 2) }];
  const seen = new Set();
  for (const entry of frameEntries(value)) {
    if (!entry.framePath) continue;
    const resolved = path.resolve(entry.framePath);
    if (resolved.startsWith(`${RUN_DIR}${path.sep}`) && fs.existsSync(resolved)) {
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      content.push({
        type: "image",
        data: fs.readFileSync(resolved).toString("base64"),
        mimeType: "image/png"
      });
    }
  }
  return { content, structuredContent: printable, isError: false };
}

function actionCountForInput(input) {
  try {
    return sessionActionCount(sessionFor(input?.clone_id));
  } catch (_error) {
    return 0;
  }
}

function lastStatusForInput(input) {
  try {
    const session = JSON.parse(fs.readFileSync(sessionFor(input?.clone_id), "utf8"));
    return compactStatus(session.lastStatus || session.initial || {});
  } catch (_error) {
    return null;
  }
}

function appendToolActivity(entry) {
  appendJsonLine(ACTIVITY_LOG, entry);
}

async function handle(
  request,
  send = stdioSend,
  context = createRequestContext({ workerOnly: WORKER_ONLY })
) {
  const workerOnly = Boolean(context?.workerOnly);
  if (!request || request.jsonrpc !== "2.0") return;
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return;
  if (request.method === "initialize") {
    success(send, request.id, {
      protocolVersion: request.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: RESTRICTED_MODE ? "game" : "mazebench", version: "1.0.0" }
    });
    return;
  }
  if (request.method === "ping") {
    success(send, request.id, {});
    return;
  }
  if (request.method === "tools/list") {
    success(send, request.id, { tools: toolsFor(workerOnly) });
    return;
  }
  if (request.method === "tools/call") {
    const requestedName = String(request.params?.name || "");
    let name;
    let input;
    try {
      ({ name, input } = normalizedToolCall(
        requestedName,
        request.params?.arguments || {},
        { workerOnly }
      ));
    } catch (error) {
      failure(send, request.id, error);
      return;
    }
    let effectiveInput = input;
    try {
      if (workerOnly) {
        effectiveInput = { ...input, clone_id: ensureWorkerAssignment(context) };
      }
    } catch (error) {
      success(send, request.id, {
        content: [{ type: "text", text: safeErrorMessage(error) }],
        isError: true
      });
      return;
    }
    const startedAt = new Date();
    const movesBefore = actionCountForInput(effectiveInput);
    const activityId = crypto.randomUUID();
    const instanceId = String(effectiveInput.clone_id || "primary");
    const instanceMetadata = readWorkerMetadata(effectiveInput.clone_id);
    const pythonCode = name === "python_exec" ? String(input.code || "") : "";
    const pythonCodeHash = pythonCode
      ? crypto.createHash("sha256").update(pythonCode).digest("hex")
      : "";
    const workspaceBefore = name === "python_exec"
      ? pythonWorkspaceSnapshot(pythonWorkspaceForInput(effectiveInput))
      : null;
    appendToolActivity({
      id: activityId,
      tool: name,
      actor: workerOnly ? "worker" : "lead",
      clone_id: String(effectiveInput.clone_id || ""),
      action: String(input.action || ""),
      ...(name === "maze_action_sequence"
        ? { actions: input.actions, route_file: String(input.route_file || "") }
        : {}),
      started_at: startedAt.toISOString(),
      status: "running",
      move_calls: 0,
      moves_before: movesBefore,
      moves_after: movesBefore,
      ...(name === "python_exec"
        ? {
            python_code: pythonCode,
            python_code_hash: pythonCodeHash,
            timeout_seconds: input.timeout_seconds
          }
        : {})
    });
    try {
      if (KIMI_OBSERVE_BREAK_ENABLED && name === "maze_action" && context.observeRequired) {
        throw new Error(`Call ${kimiToolName("observe")} before another ${kimiToolName("action")}.`);
      }
      if (KIMI_OBSERVE_BREAK_ENABLED && name === "maze_observe") {
        resetKimiActionStreak(context);
      } else if (KIMI_OBSERVE_BREAK_ENABLED && name === "maze_action") {
        noteKimiAction(context, input.action);
      } else if (KIMI_OBSERVE_BREAK_ENABLED && name === "maze_action_sequence") {
        resetKimiActionStreak(context);
      }
      const value = callTool(name, input, context);
      const observationWorkspace = syncObservationWorkspace(value, effectiveInput);
      const loopControl = kimiLoopControl(name, value, effectiveInput, context);
      const control = {
        ...(loopControl || {}),
        ...(observationWorkspace ? { observation_workspace: observationWorkspace } : {})
      };
      success(
        send,
        request.id,
        toolContent(value, Object.keys(control).length ? control : null)
      );
      const completedAt = new Date();
      const movesAfter = actionCountForInput(effectiveInput);
      const workspaceAfter = name === "python_exec"
        ? pythonWorkspaceSnapshot(pythonWorkspaceForInput(effectiveInput))
        : null;
      appendToolActivity({
        id: activityId,
        tool: name,
        actor: workerOnly ? "worker" : "lead",
        clone_id: String(effectiveInput.clone_id || ""),
        action: String(input.action || ""),
        ...(name === "maze_action_sequence"
          ? { actions: input.actions, route_file: String(input.route_file || "") }
          : {}),
        started_at: startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
        duration_ms: completedAt.getTime() - startedAt.getTime(),
        status: "completed",
        move_calls: name === "maze_action"
          ? 1
          : name === "maze_action_sequence"
            ? Math.max(0, Number(value.attempted_count) || 0)
            : 0,
        moves_before: movesBefore,
        moves_after: movesAfter,
        ...(name === "python_exec"
          ? {
              python_code_hash: pythonCodeHash,
              python_result: {
                exit_code: value.exit_code,
                stdout: String(value.stdout || ""),
                stderr: String(value.stderr || ""),
                cpu_time_ms: Number.isFinite(Number(value.cpu_time_ms))
                  ? Math.max(0, Number(value.cpu_time_ms))
                  : null,
                timed_out: Boolean(value.timed_out),
                output_truncated: Boolean(value.output_truncated)
              },
              workspace_changes: pythonWorkspaceChanges(workspaceBefore, workspaceAfter)
            }
          : {})
      });
      if (name === "maze_action" && (!effectiveInput.clone_id || instanceMetadata)) {
        const instanceEvent = {
          type: "instance.action",
          id: activityId,
          at: completedAt.toISOString(),
          instance_id: instanceId,
          parent_instance_id: instanceMetadata?.parent_instance_id || null,
          owner_kind: instanceMetadata?.owner_kind || (workerOnly ? "subagent" : "lead"),
          owner_agent_id: instanceMetadata?.owner_agent_id || "",
          action: String(input.action || ""),
          attempted: true,
          applied: movesAfter > movesBefore,
          action_count_before: movesBefore,
          action_count_after: movesAfter,
          own_action_count: effectiveInput.clone_id
            ? Math.max(0, movesAfter - Number(instanceMetadata?.fork_action_count || 0))
            : movesAfter,
          status: compactStatus(value)
        };
        appendJsonLine(INSTANCE_EVENTS_LOG, instanceEvent);
        updateInstanceTelemetry(effectiveInput, instanceEvent);
      } else if (name === "maze_action_sequence" && (!effectiveInput.clone_id || instanceMetadata)) {
        for (const step of value.steps || []) {
          const instanceEvent = {
            type: "instance.action",
            id: `${activityId}:${step.index}`,
            at: completedAt.toISOString(),
            instance_id: instanceId,
            parent_instance_id: instanceMetadata?.parent_instance_id || null,
            owner_kind: instanceMetadata?.owner_kind || (workerOnly ? "subagent" : "lead"),
            owner_agent_id: instanceMetadata?.owner_agent_id || "",
            action: String(step.action || ""),
            attempted: true,
            applied: Boolean(step.recorded),
            action_count_before: Math.max(0, Number(step.action_count_before) || 0),
            action_count_after: Math.max(0, Number(step.action_count_after) || 0),
            own_action_count: effectiveInput.clone_id
              ? Math.max(0, Number(step.action_count_after) - Number(instanceMetadata?.fork_action_count || 0))
              : Math.max(0, Number(step.action_count_after) || 0),
            ...(step.error ? { error: String(step.error) } : {}),
            status: step.status || null
          };
          appendJsonLine(INSTANCE_EVENTS_LOG, instanceEvent);
          updateInstanceTelemetry(effectiveInput, instanceEvent);
        }
      }
    } catch (error) {
      const errorMessage = safeErrorMessage(error);
      const control = kimiLoopControl(name, null, effectiveInput, context);
      const errorPayload = control ? { error: errorMessage, ...control } : null;
      success(send, request.id, {
        content: [{
          type: "text",
          text: errorPayload ? JSON.stringify(errorPayload, null, 2) : errorMessage
        }],
        ...(errorPayload ? { structuredContent: errorPayload } : {}),
        isError: true
      });
      const completedAt = new Date();
      const movesAfter = actionCountForInput(effectiveInput);
      const workspaceAfter = name === "python_exec"
        ? pythonWorkspaceSnapshot(pythonWorkspaceForInput(effectiveInput))
        : null;
      appendToolActivity({
        id: activityId,
        tool: name,
        actor: workerOnly ? "worker" : "lead",
        clone_id: String(effectiveInput.clone_id || ""),
        action: String(input.action || ""),
        ...(name === "maze_action_sequence"
          ? { actions: input.actions, route_file: String(input.route_file || "") }
          : {}),
        started_at: startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
        duration_ms: completedAt.getTime() - startedAt.getTime(),
        status: "failed",
        move_calls: name === "maze_action"
          ? 1
          : name === "maze_action_sequence"
            ? Math.max(0, movesAfter - movesBefore)
            : 0,
        moves_before: movesBefore,
        moves_after: movesAfter,
        error: errorMessage,
        ...(name === "python_exec"
          ? {
              python_code_hash: pythonCodeHash,
              workspace_changes: pythonWorkspaceChanges(workspaceBefore, workspaceAfter)
            }
          : {})
      });
      if (name === "maze_action" && (!effectiveInput.clone_id || instanceMetadata)) {
        const instanceEvent = {
          type: "instance.action",
          id: activityId,
          at: completedAt.toISOString(),
          instance_id: instanceId,
          parent_instance_id: instanceMetadata?.parent_instance_id || null,
          owner_kind: instanceMetadata?.owner_kind || (workerOnly ? "subagent" : "lead"),
          owner_agent_id: instanceMetadata?.owner_agent_id || "",
          action: String(input.action || ""),
          attempted: true,
          applied: movesAfter > movesBefore,
          action_count_before: movesBefore,
          action_count_after: movesAfter,
          own_action_count: effectiveInput.clone_id
            ? Math.max(0, movesAfter - Number(instanceMetadata?.fork_action_count || 0))
            : movesAfter,
          error: errorMessage,
          status: movesAfter > movesBefore ? lastStatusForInput(input) : null
        };
        appendJsonLine(INSTANCE_EVENTS_LOG, instanceEvent);
        updateInstanceTelemetry(effectiveInput, instanceEvent);
      }
    }
    return;
  }
  if (request.id !== undefined) failure(send, request.id, new Error(`Unsupported method \"${request.method}\".`));
}

function parseHttpMode(argv) {
  if (!argv.includes("--http")) return null;
  const portIndex = argv.indexOf("--port-file");
  return {
    portFile: portIndex >= 0
      ? path.resolve(argv[portIndex + 1] || "")
      : path.join(RUN_DIR, "mcp-http.json")
  };
}

function startHttpServer({ portFile }) {
  if (!HTTP_TOKEN) throw new Error("MAZEBENCH_MCP_HTTP_TOKEN is required in HTTP mode.");
  const leadContext = createRequestContext({ workerOnly: false, workerKey: "lead" });
  const workerSessions = new Map();
  const server = http.createServer((request, response) => {
    const match = String(request.url || "").match(/^\/([^/]+)\/(lead|worker)$/);
    if (!match || match[1] !== HTTP_TOKEN) {
      response.writeHead(404).end();
      return;
    }
    const workerOnly = match[2] === "worker";
    const requestedSessionId = String(request.headers["mcp-session-id"] || "");
    if (request.method === "DELETE") {
      if (workerOnly && requestedSessionId) {
        finishWorkerContext(workerSessions.get(requestedSessionId));
        workerSessions.delete(requestedSessionId);
      }
      response.writeHead(200).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST, DELETE" }).end();
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4 * 1024 * 1024) request.destroy();
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "null");
        const requests = Array.isArray(payload) ? payload : [payload];
        let sessionId = requestedSessionId;
        let context = leadContext;
        if (workerOnly) {
          if (!SWARM_REQUIRED) throw new Error("Worker MCP sessions require agent swarm mode.");
          if (!sessionId) {
            if (!requests.some((message) => message?.method === "initialize")) {
              throw new Error("Initialize a worker MCP session before calling worker tools.");
            }
            sessionId = crypto.randomUUID();
            context = createRequestContext({
              workerOnly: true,
              workerKey: `swarm-worker-${sessionId.slice(0, 12)}`
            });
            workerSessions.set(sessionId, context);
          } else {
            context = workerSessions.get(sessionId);
            if (!context) throw new Error("Unknown or expired worker MCP session.");
          }
        }
        const replies = [];
        for (const message of requests) {
          await handle(message, (reply) => replies.push(reply), context);
        }
        if (!replies.length) {
          response.writeHead(202).end();
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          ...(workerOnly ? { "Mcp-Session-Id": sessionId } : {})
        });
        response.end(JSON.stringify(Array.isArray(payload) ? replies : replies[0]));
      } catch (error) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: safeErrorMessage(error) }));
      }
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    fs.writeFileSync(
      portFile,
      `${JSON.stringify({ port: address.port, token: HTTP_TOKEN, pid: process.pid })}\n`,
      "utf8"
    );
  });
  const shutdown = () => {
    for (const context of workerSessions.values()) finishWorkerContext(context);
    workerSessions.clear();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (require.main === module) {
  const httpMode = parseHttpMode(process.argv.slice(2));
  if (httpMode) {
    startHttpServer(httpMode);
  } else {
    const stdioContext = createRequestContext({
      workerOnly: WORKER_ONLY,
      workerKey: process.env.MAZEBENCH_WORKER_KEY || ""
    });
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on("line", (line) => {
      if (!line.trim()) return;
      try {
        handle(JSON.parse(line), stdioSend, stdioContext);
      } catch (error) {
        failure(stdioSend, null, error);
      }
    });
    input.on("close", () => finishWorkerContext(stdioContext));
  }
}

module.exports = {
  callTool,
  compactStatus,
  createRequestContext,
  createWorker,
  finishWorkerContext,
  kimiResultIsTerminal,
  listWorkers,
  safeWorkerId,
  sessionFor,
  toolContent
};
