#!/usr/bin/env node

// Certified local coding-agent launcher. The trusted runner stays in the outer
// Docker container; the evaluated Codex, Claude Code, or Kimi Code process runs
// in a second bubblewrap namespace that hides the repository, run output,
// credential sources, and host files. Only a fresh workspace, run-scoped
// provider state, and the private MazeBench MCP game controls cross into the
// evaluated process.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn, spawnSync } = require("node:child_process");
const { redactAgentStatus } = require("./codex-play");
const {
  canonicalPath,
  inlinePermissionTable,
  preflightPythonSandbox
} = require("./maze-python-sandbox");
const DEFAULT_MAX_SWARM_WORKERS = 8;
const SUPPORTED_LOCAL_CODEX_VERSION = "0.146.0";
const SUPPORTED_LOCAL_CLAUDE_VERSION = "2.1.220";
const SUPPORTED_LOCAL_KIMI_VERSION = "0.29.1";
const SUPPORTED_LOCAL_AGENT_VERSIONS = Object.freeze({
  codex: SUPPORTED_LOCAL_CODEX_VERSION,
  claude: SUPPORTED_LOCAL_CLAUDE_VERSION,
  kimi: SUPPORTED_LOCAL_KIMI_VERSION
});
const SUPPORTED_KIMI_CODE_VERSIONS = new Set([SUPPORTED_LOCAL_KIMI_VERSION]);
const RETIRED_LOCAL_AGENT_MESSAGE =
  "Certified local coding-agent routes require a pinned Codex, Claude Code, or Kimi Code CLI " +
  "inside a fresh Docker container, reviewed game/Python tools only, and launch-time isolation preflights.";

// Claude Code discovers MCP tools only when its default tool registry is
// enabled. Keep that registry on, then explicitly remove every non-game tool
// from restricted runs. This list includes the workflow/scheduling tools added
// by newer Claude Code releases, not just the traditional coding tools.
const CLAUDE_RESTRICTED_BUILTIN_TOOLS = [
  "Agent",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "CreateGoal",
  "DesignSync",
  "Edit",
  "EnterWorktree",
  "ExitWorktree",
  "Glob",
  "Grep",
  "GetGoal",
  "Monitor",
  "NotebookEdit",
  "PushNotification",
  "Read",
  "RemoteTrigger",
  "ReportFindings",
  "ScheduleWakeup",
  "SendMessage",
  "Skill",
  "SetGoalBudget",
  "Task",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write"
];

// Kimi Code evaluates deny policies before allow policies, so an overlapping
// catch-all deny would also block MazeBench MCP. Deny every built-in exposed by
// the pinned CLI version instead, allow exact MCP tools, and reject any
// unreviewed Kimi version before launch. mcp.json also pins the exact tool list.
const KIMI_RESTRICTED_BUILTIN_TOOLS = [
  "Agent",
  "AgentSwarm",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "CreateGoal",
  "Edit",
  "EnterPlanMode",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "GetGoal",
  "Read",
  "ReadMediaFile",
  "Skill",
  "SetGoalBudget",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TodoList",
  "UpdateGoal",
  "WebSearch",
  "FetchURL",
  "Write"
];

const ROOT_DIR = path.resolve(__dirname, "..");
const HELPER = path.join(ROOT_DIR, "scripts", "codex-play.js");
const MAZE_MCP_SERVER = path.join(ROOT_DIR, "scripts", "maze-mcp-server.js");
const CODEX_TOOL_GUARD = path.join(ROOT_DIR, "scripts", "maze-codex-tool-guard.js");
const EXPORT_REPLAY = path.join(ROOT_DIR, "scripts", "maze-export-replay.js");
const VIEW_NAMES = ["top", "top-diagonal", "diagonal", "side-diagonal", "side"];

function parseArgs(argv) {
  const raw = {};
  const passthrough = [];
  let sawSeparator = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      sawSeparator = true;
      continue;
    }

    if (sawSeparator) {
      passthrough.push(arg);
      continue;
    }

    const kv = arg.match(/^(?:--)?([A-Za-z_][\w-]*)=(.*)$/);
    if (kv) {
      raw[kv[1].replace(/-/g, "_")] = kv[2];
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-/g, "_");
      const next = argv[index + 1];
      // Boolean-ish flags (video renderer passthrough) take no value.
      if (["fast", "draft", "no_video"].includes(key) || next === undefined || next.startsWith("--")) {
        raw[key] = "true";
      } else {
        raw[key] = next;
        index += 1;
      }
      continue;
    }

    passthrough.push(arg);
  }

  return { raw, passthrough };
}

function normalizeLevelId(value) {
  const match = String(value || "level_HxI").trim().match(/^(?:level_)?([A-Za-z])x([A-Za-z])$/);
  return match ? `level_${match[1].toUpperCase()}x${match[2].toUpperCase()}` : "level_HxI";
}

function normalizeGameId(value) {
  const gameId = String(value || "maze").trim();
  return /^[a-z0-9][a-z0-9_-]*$/i.test(gameId) ? gameId : "maze";
}

function isTruthy(value, fallback = false) {
  if (value === undefined) return fallback;
  return !["off", "false", "0", "no", ""].includes(String(value).toLowerCase());
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function hasResumableGameSession(sessionFile) {
  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    return Boolean(
      session &&
      typeof session === "object" &&
      !Array.isArray(session) &&
      session.initial &&
      typeof session.initial === "object" &&
      Array.isArray(session.actions)
    );
  } catch (_error) {
    return false;
  }
}

function migrateSeedSessionObservation(config) {
  if (!config.seed || !hasResumableGameSession(config.sessionFile)) return;

  let session;
  try {
    session = JSON.parse(fs.readFileSync(config.sessionFile, "utf8"));
  } catch (_error) {
    return;
  }
  if (!session || typeof session !== "object" || Array.isArray(session)) return;

  const hideNamesSeed = String(session.hideNamesSeed || "").trim() ||
    String(config.hideNamesSeed || "").trim() ||
    "1";
  const completedActions = Array.isArray(session.actions) ? session.actions.length : 0;
  const next = redactAgentStatus({
    ...session,
    maxActions: config.unlimited ? null : completedActions + positiveInt(config.moves, 20),
    observationMode: config.mode,
    vision: config.mode === "vision",
    omniscient: config.mode === "json" && config.omniscient,
    hideNames: config.mode !== "vision" && config.hideNames,
    hideNamesSeed
  }, { mode: config.mode, includeInternalSignals: true });
  delete next.bridgeCheckpoint;

  const temporary = `${config.sessionFile}.observation-${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(temporary, config.sessionFile);

  if (next.initial) {
    fs.writeFileSync(
      path.join(config.outDir, "initial-status.json"),
      `${JSON.stringify(next.initial, null, 2)}\n`
    );
  }
  if (Array.isArray(next.actions)) {
    fs.writeFileSync(
      path.join(config.outDir, "actions.jsonl"),
      next.actions.map((action) => JSON.stringify(action)).join("\n") +
        (next.actions.length ? "\n" : "")
    );
  }
  for (const file of ["current-render-state.json", "scorecard.json", "maze_scorecard.json"]) {
    fs.rmSync(path.join(config.outDir, file), { force: true });
  }
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

function autoRunToolsInstructions(config) {
  if (config.toolUse !== "offline" || !config.autoRunTools) return "";
  const observationDelivery = config.autoRunAllFrames
    ? `- Every sequence automatically returns every intermediate ASCII board,
  JSON observation, or vision frame, followed by the final observation. Inspect
  the full ordered trajectory before deciding what to do next.`
    : `- By default it returns compact per-action summaries plus only the final full
  observation. Set include_intermediate_observations=true when you specifically
  need every intermediate ASCII board, JSON observation, or vision frame.`;
  return `AUTO-RUN TOOLS HARNESS IS ENABLED. You additionally have
maze_action_sequence for quickly applying an ordered route, either as an
action list or from a persisted JSON route file.

- Call maze_action_sequence only with an ordered action list you intend to
  apply. When a route is already persisted, prefer route_file so the MCP server
  can read it directly instead of making you copy a long action list.
- A route file may be a JSON action array or an object with actions and the
  observation_revision it was planned from. Revision-aware routes are rejected
  if the live game changed, so update it instead of executing stale moves.
- If you intend to apply two or more moves, use maze_action_sequence for the
  route instead of replaying those moves one call at a time.
- A single call may contain the full route. Each action is still validated,
  budgeted, persisted, and logged exactly like an individual maze_action.
- The sequence stops immediately on a terminal state, death, pause, exhausted
  move budget, rejected action, or other error, and reports how far it got.
${observationDelivery}
- After the call, inspect the final observation and the ordered summaries. If
  they disagree with the expected result, reassess before submitting another
  route.

Never create a Python helper that calls a live game API or sends game actions.
Only maze_action and maze_action_sequence may change the live game.`;
}

function buildMcpPrompt(config) {
  const restricted = config.toolUse === "read-only";
  // A provider transcript and a game session are independent artifacts. A
  // provider retry may have a resumable thread even when the first attempt
  // stalled before maze_start. Only a valid session.json proves that the game
  // itself can be observed instead of started.
  const continuingGame = hasResumableGameSession(config.sessionFile);
  const recoveringColdStart = Boolean(config.resume) && !continuingGame;
  const maxSwarmWorkers = positiveInt(config.maxSwarmWorkers, DEFAULT_MAX_SWARM_WORKERS);
  const controlPrefix = restricted ? "game" : "maze";
  const controls = {
    start: `${controlPrefix}_start`,
    observe: `${controlPrefix}_observe`,
    action: `${controlPrefix}_action`
  };
  const observation = config.mode === "vision"
    ? `This is VISION mode. Every observation includes the current PNG as an
image attachment. Inspect that image before choosing a move; there is no
ASCII board. The status also includes the room, gems, game state, and
the recovery commands after a death.`
    : config.mode === "json"
      ? config.hideNames
        ? `This is JSON mode. Read json_observation.objects instead of an ASCII
board. Coordinates are [x,y,elevation]. Object types have stable random letter
IDs for this run; player and gem remain literal. Infer every hidden type only
from the observations and interactions in this run.`
        : `This is JSON mode. Read json_observation.objects instead of an ASCII
board. Schema version 2 coordinates are [x,y,elevation]. Directional object
names such as ice_slope_up, black_ice_slope_left, orange_ice_slope_down,
puncher_left, ramped_clone_c7_up, and ramped_weightless_push_box_M7_right are
relative to the current camera. Clone and weightless-push-box names preserve
their arbitrary group ids. Player lifts and attached lifts/gates include their
live raised/lowered state in the name. Orange walls and orange ice slopes drop
one elevation while the orange buttons are pressed. ${
  config.omniscient
    ? "The observation is omniscient and contains every object in the current room, so camera rotation is not needed for visibility."
    : "Only objects with at least one character visible in the equivalent ASCII view are included, so rotate the camera to reveal occluded objects."
} Object type names are literal.`
      : config.hideNames
        ? `This is ASCII mode. Observations contain the current room's ASCII
board in the level field and the complete visited_levels list. Directional
glyphs are relative to the current camera. Every glyph except player P and gem
G is assigned a stable random identity for this run. Infer meanings only from
observations and interactions in this run.`
        : `This is ASCII mode. Observations contain the current room's ASCII
board in the level field, any dynamic Unicode clone/box symbols in ascii_legend,
and the complete visited_levels list. Directional slope and puncher glyphs are
relative to the current camera.`;
  const movementFeedback = `The controls do not report whether a movement was
blocked. Infer its effect only from the returned observation.`;
  const capability = config.toolUse === "offline"
    ? `TOOLS mode. In addition to the game controls, you have exactly one
general-purpose computation tool: python_exec. Every call saves the supplied
code to a relative .py script_path chosen by you, then executes that file in a
fresh Python process. The writable working directory persists for this entire
run. You may create, reuse, modify, and organize as many relative-path .py,
.json, and scratch files as useful. Python is optional; decide naturally when
and how to use it. There is no separate editor or shell; create, revise, and
execute files through python_exec.
It cannot read MazeBench source, repositories, run artifacts, host files,
credentials, or prior runs, and it has no network access. Shell, file-browser,
editor, web, app, and connector tools are disabled.
Only genuine swarm workers receive private game instances, and each worker is
permanently bound to exactly one instance.`
    : `Do not use any external tools. Do not search the web, do not read any
files, do not run shell commands, and do not spawn any sub-agents. This is
TOOLS-OFF mode. Do not access repositories, connectors, resource listings,
prior-run memory, workers, or private branches. Use only the three game controls
named below and your current conversation memory.`;
  const observationWorkspace = config.toolUse === "offline" && config.mode !== "vision"
    ? `PYTHON WORKSPACE OBSERVATION BRIDGE. After maze_start, maze_observe, maze_action,
or maze_action_sequence, the trusted MCP server atomically writes the exact
sanitized observation you just received to observations/current.json inside
your Python scratch workspace. It also appends delivered observations to
observations/history.jsonl. Python programs may load the current observation
directly with:

  observation = json.loads(Path("observations/current.json").read_text())

The file includes observation_revision. A route file submitted to
maze_action_sequence must be a JSON action array or an object such as
{"observation_revision": observation["observation_revision"], "actions": [...]}.
The server validates the path, action strings, live revision, budget, pause
state, and every individual move.`
    : "";
  const autoRunTools = autoRunToolsInstructions(config);
  const firstStep = continuingGame
    ? `Call ${controls.observe} first. This is the same primary game; do not call ${controls.start}.`
    : recoveringColdStart
      ? `COLD-START RECOVERY: the provider conversation is being resumed, but no primary game was ever created. Call ${controls.start} exactly once as your first game-control call, even if earlier conversation context said not to start.`
    : `Call ${controls.start} exactly once as your first game-control call.`;
  const workerSpawnRule = config.model === "codex"
    ? "Use the Codex collaboration spawn tool to spawn the custom maze-worker agent without a full-history fork. Its model and reasoning effort are pinned to yours."
    : "Use the Task/Agent tool to spawn the configured maze-worker subagent type. The subagent creates its own branch. Its model and effort are pinned to yours.";
  const workerCapability = config.toolUse === "offline"
    ? "may use python_exec in its private isolated scratch workspace"
    : "is read-only and must not write files or execute general-purpose code";
  const swarm = config.swarm
    ? `
SWARM IS ENABLED. You are the superior lead and retain control of the primary
maze. ${workerSpawnRule} Every worker uses the exact same model and reasoning
effort as you and inherits your tool-use policy. You may spawn at most
${maxSwarmWorkers} workers; delegation is optional.

Each worker receives exactly one private maze instance automatically and begins
by calling maze_start once. It then uses maze_observe and maze_action without an
instance id, may explore freely, ${workerCapability}, and reports its findings
to you. Workers must never act on the primary maze. You decide which findings
to use and make every primary move yourself. No model may create, branch, or
select additional maze instances.
Beyond that, spawn, steer, stop, or wait for workers at your
discretion. If you spawn workers, gather their reports before finishing.`
    : "";
  const budgetInstruction = config.unlimited
    ? `This run has NO MOVE LIMIT. Keep taking primary game actions until the
game is won or the user stops the run.`
    : `Then play up to ${config.moves} ${continuingGame ? "MORE " : ""}primary game actions unless the game reaches a terminal state earlier.`;
  const quitPolicy = config.allowQuit
    ? ""
    : config.unlimited
      ? `QUIT IS DISABLED BY THE USER. The quit action is unavailable and rejected without consuming an action. Continue until the game is won or the user stops the run.`
      : `QUIT IS DISABLED BY THE USER. The quit action is unavailable and rejected without consuming an action. Do not end your provider response while playable budget remains; continue until the budget is exhausted, the game is won, or the user stops the run.`;
  const validActions = config.allowQuit
    ? "up, down, left, right, rotate camera left/right/up/down, undo, reset, quit, and go to level H I"
    : "up, down, left, right, rotate camera left/right/up/down, undo, reset, and go to level H I";
  const kimiObservePolicy = config.model === "kimi"
    ? `Kimi Code compatibility rule: after five consecutive ${controls.action}
calls with the same normalized action, you must call ${controls.observe} once
before any further ${controls.action}. A different action resets the repetition
count. The fifth identical action result reports observe_required=true and
next_required_tool=${controls.observe}; obey it. ${controls.observe} resets the
count and does not consume a game action.`
    : "";

  const intro = restricted
    ? `You are solving a 3D grid game. Control it only through ${controls.start},
${controls.observe}, and ${controls.action}.`
    : `You are controlling a 3D grid game. Control game state only
through the configured MCP tools: maze_start, maze_observe, and maze_action.
Swarm workers receive one automatically assigned private instance. Never edit
session JSON directly or create, select, or branch game instances yourself.`;

  return `${intro}

${observation}
${movementFeedback}
${capability}
${observationWorkspace}
${autoRunTools}
${swarm}
${quitPolicy}
${kimiObservePolicy}

${firstStep}

${budgetInstruction} Do not
stop after the first observation while budget remains. Before every primary
${controls.action}${config.autoRunTools ? " or maze_action_sequence call" : ""}, write one short sentence explaining the choice. Valid action
strings include ${validActions}.

After every ${config.autoRunTools ? "maze_action or maze_action_sequence call" : "action"}, inspect the returned ${config.autoRunTools && config.autoRunAllFrames ? "ordered observations and final " : config.autoRunTools ? "final " : ""}${config.mode === "vision" ? "frame and status" : config.mode === "json" ? "JSON observation and status" : "ASCII board"} before choosing the next move. Collect as many
unique gems as possible. If the player dies, recover with undo, reset, or a room
change. Scoring is runner-only; do not attempt to access a scorecard. When done,
give a one-line summary of the route and gems collected.`;
}

function buildPrompt(config) {
  if (config.mcpEnabled) return buildMcpPrompt(config);
  const continuingGame = hasResumableGameSession(config.sessionFile);
  const recoveringColdStart = Boolean(config.resume) && !continuingGame;
  const observationFlags = config.mode === "vision"
    ? ` --vision --vision-width ${config.visionWidth} --vision-height ${config.visionHeight}` +
      (config.visionView ? ` --vision-view ${config.visionView}` : "")
    : config.mode === "json"
      ? ` --json-observation${config.omniscient ? " --omniscient" : ""}${config.hideNames ? ` --hide-names --hide-names-seed ${JSON.stringify(config.hideNamesSeed)}` : ""}`
      : config.hideNames
        ? ` --hide-names --hide-names-seed ${JSON.stringify(config.hideNamesSeed)}`
        : "";
  const observation = config.mode === "vision"
    ? `This is VISION mode. Every helper command prints JSON containing a
"frame_image" field: an absolute path to a PNG of the current maze view. OPEN
and LOOK AT that image to decide your next move — there is NO ASCII board. The
JSON also carries a short text status (current_room, gem_count, game state,
allowed_commands). The first command boots a headless browser
(a few seconds); later commands render quickly.`
    : config.mode === "json"
      ? config.hideNames
        ? `This is JSON mode. Every helper command prints json_observation.objects,
grouped by schema-version-2 object type with [x,y,elevation] coordinates, and no
ASCII board. Object types have stable random letter IDs for this run; player
and gem remain literal. Directional identities are camera-relative. Infer every
hidden type only from observations and interactions in this run.`
        : `This is JSON mode. Every helper command prints json_observation.objects,
grouped by schema-version-2 object type with [x,y,elevation] coordinates, and no
ASCII board. Directional names are camera-relative. Clone and weightless push
box ids are preserved, including ramped_*_<id>_<direction> actors. Player lifts
and attached devices include live state in their names. Orange walls and orange
ice slopes drop one elevation while the buttons are pressed. ${config.omniscient ? "Every room object is included, so rotating the camera is unnecessary for visibility." : "Only objects visible in the equivalent ASCII view are included; rotate the camera to uncover occluded objects."}
Names are literal.`
      : config.hideNames
        ? `This is ASCII mode. Every helper command prints a JSON observation with an
ASCII board in the "level" field and a short status. Directional glyphs are
camera-relative. Every glyph except player P and gem G is assigned a stable
random identity for this run. Infer meanings only from observations and
interactions in this run.`
        : `This is ASCII mode. Every helper command prints a JSON observation with an
ASCII board in the "level" field, an ascii_legend for any dynamic Unicode
clone/box identities, and a short status. Directional slope and puncher glyphs
are camera-relative. Read the JSON to choose your next move.`;
  const toolsNote = config.tools
    ? ""
    : `
You are sandboxed: you may ONLY run the maze helper commands shown below${
        config.mode === "vision" ? " and open the frame_image PNG" : ""
      }.
Reading other files, writing files, running other programs, and network access
are blocked. Do not attempt them — just play the maze.
`;
  const quitPolicy = config.allowQuit
    ? ""
    : config.unlimited
      ? `
QUIT IS DISABLED BY THE USER. A quit attempt is rejected without consuming an action. Continue until the maze is won or the user stops the run.
`
      : `
QUIT IS DISABLED BY THE USER. A quit attempt is rejected without consuming an action. Do not end your provider response while playable budget remains; continue until the budget is exhausted, the maze is won, or the user stops the run.
`;

  return `You are controlling a 3D grid game through a local CLI helper.
Drive the game ONLY through the helper commands below. Do NOT read or modify
source files and do NOT try to parse the board yourself.

${observation}
${toolsNote}
${quitPolicy}
Repo root:    ${ROOT_DIR}
Helper:       ${HELPER}
Session file: ${config.sessionFile}

${continuingGame && config.resume
    ? `You are CONTINUING the SAME grid game you were just controlling — you already
have the full history in memory and know the helper. The session file is still
${config.sessionFile}. Do NOT run "start"; that would erase the progress.

Your FIRST shell command must re-read the current observation:

  node "${HELPER}" observe --state "${config.sessionFile}"

Then ${config.unlimited ? "keep taking maze actions from where you left off" : `play up to ${config.moves} MORE maze action(s) from where you left off`},`
    : continuingGame
    ? `This maze is ALREADY IN PROGRESS: earlier moves were made and the game state
is saved in the session file. Do NOT run "start" — that would erase the progress.

Your FIRST shell command must read the current observation to see where the maze
stands right now:

  node "${HELPER}" observe --state "${config.sessionFile}"

Then ${config.unlimited ? "keep taking maze actions from that state" : `continue playing up to ${config.moves} MORE maze action(s) from that state`},`
    : `${recoveringColdStart ? "COLD-START RECOVERY: the provider conversation exists, but no game session was created. Ignore any earlier instruction not to start.\n\n" : ""}Your FIRST shell command must start the session (run it exactly once):

  node "${HELPER}" start --repo-root "${ROOT_DIR}" --state "${config.sessionFile}" --game "${config.gameId}" --level "${config.levelId}" --view "${config.view}" --yaw "${config.yaw}" --game-won-gem-count "${config.gems}" --max-actions "${config.unlimited ? "unlimited" : config.moves}"${observationFlags}

Then ${config.unlimited ? "keep taking maze actions" : `play up to ${config.moves} maze action(s)`},`} ${
  config.unlimited
    ? "This run has NO MOVE LIMIT. Continue until the maze is won or the user stops the run."
    : "unless the game reaches a terminal state earlier."
} Do not stop right after the first command: choose and run at least one action. After each action, read the
observation (${config.mode === "vision" ? "the frame_image PNG plus the JSON status" : config.mode === "json" ? "json_observation plus the status" : "the JSON board"}) and choose the next command.

Before you run each action command, write one short sentence (as normal text,
not a comment) explaining why you are choosing that move.

Action command forms:

  node "${HELPER}" action --state "${config.sessionFile}" up        (also down / left / right)
  node "${HELPER}" action --state "${config.sessionFile}" rotate camera left
  node "${HELPER}" action --state "${config.sessionFile}" undo
  node "${HELPER}" action --state "${config.sessionFile}" reset
  node "${HELPER}" action --state "${config.sessionFile}" go to level H I

Goal: collect as many unique gems as you can within the action budget. If the
player dies, recover with undo / reset / go to level.

Scoring is runner-only; do not attempt to access a scorecard. Finish with a
one-line summary of the path you took and how many gems you got.`;
}

function mcpEnvironment(config, workerOnly = false) {
  return {
    MAZEBENCH_REPO_ROOT: ROOT_DIR,
    MAZEBENCH_RUN_DIR: config.outDir,
    MAZEBENCH_SESSION_FILE: config.sessionFile,
    MAZEBENCH_SWARM_DIR: config.swarmDir,
    MAZEBENCH_SWARM_WORKSPACES_DIR: config.swarmWorkspaceDir,
    MAZEBENCH_AGENT_SWARM_WORKSPACES_DIR: config.agentSwarmWorkspaceDir,
    MAZEBENCH_AGENT_WORKSPACE_DIR: config.workspaceDir,
    MAZEBENCH_PYTHON_SANDBOX_STATE_DIR: config.pythonSandboxStateDir || path.join(config.outDir, ".python-sandbox"),
    MAZEBENCH_CODEX_BIN: config.codexBin,
    MAZEBENCH_PYTHON_BIN: config.pythonBin || "",
    MAZEBENCH_PYTHON_RUN_UID: config.inContainer ? String(config.agentUid) : "",
    MAZEBENCH_PYTHON_RUN_GID: config.inContainer ? String(config.agentGid) : "",
    MAZEBENCH_TOOL_ACTIVITY_FILE: path.join(config.outDir, "tool-activity.jsonl"),
    MAZEBENCH_INSTANCE_EVENTS_FILE: path.join(config.outDir, "maze-instance-events.jsonl"),
    MAZEBENCH_GAME_ID: config.gameId,
    MAZEBENCH_LEVEL_ID: config.levelId,
    MAZEBENCH_VIEW: config.view,
    MAZEBENCH_YAW: String(config.yaw),
    MAZEBENCH_GEMS: String(config.gems),
    MAZEBENCH_MOVE_BUDGET: config.unlimited ? "unlimited" : String(config.moves),
    MAZEBENCH_ALLOW_QUIT: config.allowQuit ? "1" : "0",
    MAZEBENCH_SWARM: config.swarm ? "1" : "0",
    MAZEBENCH_MAX_SWARM_WORKERS: String(
      positiveInt(config.maxSwarmWorkers, DEFAULT_MAX_SWARM_WORKERS)
    ),
    MAZEBENCH_MODE: config.mode,
    MAZEBENCH_OMNISCIENT: config.omniscient ? "1" : "0",
    MAZEBENCH_HIDE_NAMES: config.hideNames ? "1" : "0",
    MAZEBENCH_HIDE_NAMES_SEED: config.hideNamesSeed || "",
    MAZEBENCH_PROVIDER: config.model,
    MAZEBENCH_RESTRICTED_MODE: config.toolUse === "read-only" ? "1" : "0",
    MAZEBENCH_AUTO_RUN_TOOLS: config.autoRunTools ? "1" : "0",
    MAZEBENCH_AUTO_RUN_ALL_FRAMES: config.autoRunAllFrames ? "1" : "0",
    MAZEBENCH_VISION_WIDTH: String(config.visionWidth),
    MAZEBENCH_VISION_HEIGHT: String(config.visionHeight),
    MAZEBENCH_VISION_VIEW: config.visionView || "",
    ...(config.inContainer
      ? { MAZEBENCH_AGENT_UID: String(config.agentUid), MAZEBENCH_AGENT_GID: String(config.agentGid) }
      : {}),
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH
      ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
      : {}),
    ...(workerOnly ? { MAZEBENCH_WORKER_ONLY: "1" } : {})
  };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function codexPrimeProviderConfigArgs(config) {
  if (config.inference !== "prime") return [];
  const runtimeDir = config.agentCodexRuntimeDir || config.codexRuntimeDir || path.join(config.outDir, ".codex-runtime");
  return [
    "-c", 'model_provider="prime_intellect"',
    "-c", 'model_providers.prime_intellect.name="Prime Intellect"',
    "-c", `model_providers.prime_intellect.base_url=${tomlString(config.primeInferenceUrl)}`,
    "-c", 'model_providers.prime_intellect.wire_api="responses"',
    "-c", `model_providers.prime_intellect.auth.command=${tomlString(process.execPath)}`,
    "-c", `model_providers.prime_intellect.auth.args=[${tomlString(path.posix.join(runtimeDir, "prime-auth.js"))}, ${tomlString("/home/pwuser/.codex/prime-config.json")}]`,
    "-c", "model_providers.prime_intellect.auth.timeout_ms=5000",
    "-c", "model_providers.prime_intellect.auth.refresh_interval_ms=300000",
    "-c", "model_providers.prime_intellect.request_max_retries=2",
    "-c", "model_providers.prime_intellect.stream_max_retries=1",
    "-c", "model_providers.prime_intellect.stream_idle_timeout_ms=45000"
  ];
}

function codexPermissionConfigArgs(config) {
  const permissions = { ":minimal": "read" };
  if (config.toolUse === "offline") {
    permissions[canonicalPath(config.agentWorkspaceDir)] = "write";
    permissions[canonicalPath(config.agentSwarmWorkspaceDir)] = "write";
  }
  permissions[canonicalPath(ROOT_DIR)] = "deny";
  permissions[canonicalPath(config.outDir)] = "deny";
  permissions[canonicalPath(config.inContainer ? "/home" : os.homedir())] = "deny";
  const profile = "mazebench_agent";
  return [
    "-c", `default_permissions=${tomlString(profile)}`,
    "-c", `permissions.${profile}.filesystem=${inlinePermissionTable(permissions)}`,
    "-c", `permissions.${profile}.network.enabled=false`
  ];
}

function codexMcpConfigArgs(config) {
  const restricted = config.toolUse === "read-only";
  const prefix = `mcp_servers.${restricted ? "game" : "mazebench"}`;
  const enabledTools = restricted
    ? JSON.stringify(["game_start", "game_observe", "game_action"])
    : JSON.stringify([
        "maze_start",
        "maze_observe",
        "maze_action",
        ...(config.autoRunTools ? ["maze_action_sequence"] : []),
        ...(config.swarm ? ["maze_workers"] : []),
        "python_exec"
      ]);
  if (config.mcpUrl) {
    return [
      "-c", `${prefix}.url=${tomlString(config.mcpUrl)}`,
      "-c", `${prefix}.enabled_tools=${enabledTools}`,
      "-c", `${prefix}.default_tools_approval_mode="approve"`,
      "-c", `${prefix}.startup_timeout_sec=15`,
      "-c", `${prefix}.tool_timeout_sec=300`
    ];
  }
  const envEntries = Object.entries(mcpEnvironment(config))
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(", ");
  return [
    "-c", `${prefix}.command=${tomlString(process.execPath)}`,
    "-c", `${prefix}.args=[${tomlString(MAZE_MCP_SERVER)}]`,
    "-c", `${prefix}.enabled_tools=${enabledTools}`,
    "-c", `${prefix}.default_tools_approval_mode="approve"`,
    "-c", `${prefix}.startup_timeout_sec=15`,
    "-c", `${prefix}.tool_timeout_sec=300`,
    "-c", `${prefix}.env={ ${envEntries} }`
  ];
}

function codexWorkerConfig(config, name) {
  const offline = config.toolUse === "offline";
  const rows = [
    `name = ${tomlString(name)}`,
    `description = ${tomlString(
      offline
        ? "A grid-game exploration and coding worker controlled by the lead."
        : "A read-only grid-game exploration worker controlled by the lead."
    )}`
  ];
  if (config.modelName) rows.push(`model = ${tomlString(config.modelName)}`);
  if (config.reasoning) rows.push(`model_reasoning_effort = ${tomlString(config.reasoning)}`);
  rows.push(
    `default_permissions = ${tomlString("mazebench_worker")}`,
    `developer_instructions = ${tomlString(
      "You are a grid-game swarm worker. Use the identical model and reasoning effort inherited from the lead. " +
      "You have exactly one private maze instance. Call maze_start once, then use maze_observe and maze_action without an instance id. " +
      (offline
        ? "Explore only your private maze, use python_exec for isolated local computation when useful, and report findings to the lead. " +
          "Each call executes a caller-named relative .py file in a fresh Python process, while relative-path files persist. You may organize any number of files as useful. " +
          (config.autoRunTools ? `${autoRunToolsInstructions(config)} ` : "")
        : "Explore only your private maze without writing files or executing general-purpose code, and report findings to the lead. ") +
      "Never act on the primary maze and never change your model or reasoning effort."
    )}`,
    "",
    "[permissions.mazebench_worker.filesystem]",
    `${tomlString(":minimal")} = "read"`,
    `${tomlString(canonicalPath(ROOT_DIR))} = "deny"`,
    `${tomlString(canonicalPath(config.outDir))} = "deny"`,
    "",
    "[permissions.mazebench_worker.network]",
    "enabled = false",
    "",
    "[mcp_servers.mazebench]",
    ...(config.mcpWorkerUrl
      ? [`url = ${tomlString(config.mcpWorkerUrl)}`]
      : [
          `command = ${tomlString(process.execPath)}`,
          `args = [${tomlString(MAZE_MCP_SERVER)}]`,
          `env = { ${Object.entries(mcpEnvironment(config, true)).map(([key, value]) => `${key} = ${tomlString(value)}`).join(", ")} }`
        ]),
    'default_tools_approval_mode = "approve"',
    `enabled_tools = ${JSON.stringify([
      "maze_start",
      "maze_observe",
      "maze_action",
      ...(offline && config.autoRunTools ? ["maze_action_sequence"] : []),
      ...(offline ? ["python_exec"] : [])
    ])}`,
    "startup_timeout_sec = 15",
    "tool_timeout_sec = 300"
  );
  return `${rows.join("\n")}\n`;
}

function prepareCodexRuntime(config) {
  const codexDir = config.codexRuntimeDir || path.join(config.outDir, ".codex-runtime");
  if (config.inference === "prime") {
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "prime-auth.js"),
      [
        '"use strict";',
        'const fs = require("node:fs");',
        'const file = process.argv[2];',
        'const config = JSON.parse(fs.readFileSync(file, "utf8"));',
        'const key = String(config.api_key || "").trim();',
        'if (!key) process.exit(2);',
        'process.stdout.write(key);',
        ''
      ].join("\n"),
      { mode: 0o500 }
    );
  }
  if (config.toolUse === "read-only") {
    fs.mkdirSync(codexDir, { recursive: true });
    fs.copyFileSync(CODEX_TOOL_GUARD, path.join(codexDir, "tool-guard.js"));
    fs.writeFileSync(
      path.join(codexDir, "restricted-instructions.txt"),
      "Solve the user's current grid-game task using only the explicitly exposed game controls. Do not use or request external capabilities.\n"
    );
  }
  if (config.swarm) {
    // Project-scoped agent profiles keep host runs from modifying the user's
    // global ~/.codex configuration. The CLI still uses its normal auth and
    // session store, which is required for true Continue.
    const agentsDir = path.join(config.codexRuntimeDir || path.join(config.outDir, ".codex-runtime"), "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const name of ["default", "worker", "explorer", "maze-worker"]) {
      fs.writeFileSync(path.join(agentsDir, `${name}.toml`), codexWorkerConfig(config, name));
    }
  }
}

function codexAgentConfigArgs(config) {
  if (!config.swarm) return [];
  return ["default", "worker", "explorer", "maze-worker"].flatMap((name) => [
    "-c", `agents.${name}.description=${tomlString("An identical-model grid-game worker controlled by the lead.")}`,
    "-c", `agents.${name}.config_file=${tomlString(path.posix.join(config.agentCodexRuntimeDir || config.codexRuntimeDir || path.join(config.outDir, ".codex-runtime"), "agents", `${name}.toml`))}`
  ]);
}

function claudeMcpConfig(config) {
  const serverName = config.toolUse === "read-only" ? "game" : "mazebench";
  return JSON.stringify({
    mcpServers: {
      [serverName]: config.mcpUrl
        ? { type: "http", url: config.mcpUrl }
        : { command: process.execPath, args: [MAZE_MCP_SERVER], env: mcpEnvironment(config) }
    }
  });
}

function claudeSandboxSettings(config) {
  const offline = config.toolUse === "offline";
  const leadAllow = offline
    ? [
        "mcp__mazebench__maze_start",
        "mcp__mazebench__maze_observe",
        "mcp__mazebench__maze_action",
        ...(config.autoRunTools ? ["mcp__mazebench__maze_action_sequence"] : []),
        "mcp__mazebench__python_exec",
        ...(config.swarm ? ["mcp__mazebench__maze_workers"] : [])
      ]
    : [
        "mcp__game__game_start",
        "mcp__game__game_observe",
        "mcp__game__game_action"
      ];
  const workerAllow = config.swarm
    ? [
        "mcp__mazebench_worker__maze_start",
        "mcp__mazebench_worker__maze_observe",
        "mcp__mazebench_worker__maze_action",
        ...(offline && config.autoRunTools ? ["mcp__mazebench_worker__maze_action_sequence"] : []),
        ...(offline ? ["mcp__mazebench_worker__python_exec"] : [])
      ]
    : [];
  const home = config.inContainer ? "/home/pwuser" : process.env.HOME || "/home/pwuser";
  const denyRead = [
    process.env.CODEX_HOME || path.join(home, ".codex"),
    process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"),
    ROOT_DIR,
    config.outDir,
    ...(config.hostAccess
      ? ["~/.ssh", "~/.aws", "~/.gnupg", "~/.kube", "~/.config/gcloud"]
      : [])
  ];
  const allowWrite = [];
  return JSON.stringify({
    sandbox: {
      enabled: true,
      // Python is provided by the reviewed MCP sandbox, never Claude's Bash.
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      enableWeakerNestedSandbox: config.inContainer,
      filesystem: {
        allowWrite,
        denyRead
      },
      network: { allowedDomains: [] },
      credentials: {
        envVars: [
          { name: "OPENAI_API_KEY", mode: "deny" },
          { name: "ANTHROPIC_API_KEY", mode: "deny" },
          { name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" }
        ]
      }
    },
    permissions: {
      // Custom-agent `tools` controls what the worker can see. Under dontAsk,
      // these names must also be pre-approved or Claude silently denies them.
      // The provider sandbox still confines writes to the selected access roots.
      allow: [...leadAllow, ...workerAllow],
      deny: [
        "WebFetch", "WebSearch",
        ...CLAUDE_RESTRICTED_BUILTIN_TOOLS.filter(
          (tool) => !config.swarm || !["Task", "Agent"].includes(tool)
        ),
        ...denyRead.map((entry) => `Read(${entry}/**)`)
      ]
    }
  });
}

function claudeAgents(config) {
  if (!config.swarm) return "";
  const offline = config.toolUse === "offline";
  const worker = {
    description: offline
      ? "Explore a private game clone, use isolated Python, and report to the lead."
      : "Explore a private game clone read-only and report to the lead.",
    prompt:
      "You are a grid-game swarm worker controlled by the superior lead. You have exactly one private maze instance. " +
      "Call maze_start once, then use maze_observe and maze_action without an instance id. Report findings to the lead. " +
      (offline
        ? "You may use python_exec for isolated computation in your private scratch workspace. " +
          "Each call executes a caller-named relative .py file in a fresh Python process, while relative-path files persist. You may organize any number of files as useful. " +
          (config.autoRunTools ? `${autoRunToolsInstructions(config)} ` : "")
        : "Do not write files or execute general-purpose code. ") +
      "Never act on the primary maze and never switch model or reasoning effort.",
    model: config.modelName || "inherit",
    permissionMode: "dontAsk",
    background: true,
    tools: [
      "mcp__mazebench_worker__maze_start",
      "mcp__mazebench_worker__maze_observe",
      "mcp__mazebench_worker__maze_action",
      ...(offline && config.autoRunTools ? ["mcp__mazebench_worker__maze_action_sequence"] : []),
      ...(offline ? ["mcp__mazebench_worker__python_exec"] : [])
    ],
    mcpServers: [{
      mazebench_worker: config.mcpWorkerUrl
        ? { type: "http", url: config.mcpWorkerUrl }
        : {
            type: "stdio",
            command: process.execPath,
            args: [MAZE_MCP_SERVER],
            env: mcpEnvironment(config, true)
          }
    }]
  };
  if (config.reasoning) worker.effort = config.reasoning;
  return JSON.stringify({ "maze-worker": worker });
}

function kimiAllowedTools(config) {
  const restricted = config.toolUse === "read-only";
  return restricted
    ? [
        "mcp__game__game_start",
        "mcp__game__game_observe",
        "mcp__game__game_action"
      ]
    : [
        "mcp__mazebench__maze_start",
        "mcp__mazebench__maze_observe",
        "mcp__mazebench__maze_action",
        ...(config.autoRunTools ? ["mcp__mazebench__maze_action_sequence"] : []),
        "mcp__mazebench__python_exec"
      ];
}

function kimiAgentProfile(config) {
  const tools = kimiAllowedTools(config);
  return [
    "---",
    "name: mazebench",
    "description: MazeBench game-controls-only benchmark agent",
    "tools:",
    ...tools.map((tool) => `  - ${tool}`),
    "disallowedTools:",
    ...KIMI_RESTRICTED_BUILTIN_TOOLS.map((tool) => `  - ${tool}`),
    "subagents: []",
    "---",
    "Solve the current grid-game task using only the explicitly exposed MazeBench game controls.",
    "Do not request or attempt shell, filesystem, web, plugin, skill, or sub-agent capabilities.",
    ""
  ].join("\n");
}

function sanitizeKimiConfig(source, config) {
  // Provider/model data is required for authentication and inference. Drop all
  // other user configuration (plugins, services, hooks, skills, agents,
  // workspace settings, tool switches, and prior permissions) rather than
  // trying to maintain an ever-growing unsafe-field blocklist.
  const allowedSection = /^(?:providers|models)(?:\.|$)|^thinking$/;
  const preamble = [];
  const blocks = [];
  let block = null;
  let keepBlock = true;

  for (const line of String(source || "").split(/\r?\n/)) {
    const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/);
    if (header) {
      if (block && keepBlock) blocks.push(block.join("\n"));
      block = [line];
      const section = String(header[1] || "").trim().replace(/^['"]|['"]$/g, "");
      keepBlock = allowedSection.test(section);
      continue;
    }
    if (block) {
      block.push(line);
      continue;
    }
    const assignment = line.match(/^\s*([A-Za-z_][\w-]*)\s*=/);
    if (!assignment || assignment[1] === "default_model") preamble.push(line);
  }
  if (block && keepBlock) blocks.push(block.join("\n"));

  const maxSteps = config.unlimited
    ? 1000
    : Math.max(12, Number(config.moves || 0) + 10);
  const rules = kimiAllowedTools(config).flatMap((tool) => [
    "[[permission.rules]]",
    'decision = "allow"',
    `pattern = ${tomlString(tool)}`,
    'reason = "MazeBench isolated MCP tool"',
    ""
  ]);
  for (const tool of KIMI_RESTRICTED_BUILTIN_TOOLS) {
    rules.push(
      "[[permission.rules]]",
      'decision = "deny"',
      `pattern = ${tomlString(tool)}`,
      'reason = "Disabled by MazeBench isolation"',
      ""
    );
  }
  return [
    ...preamble,
    'default_permission_mode = "auto"',
    "default_plan_mode = false",
    "merge_all_available_skills = false",
    "extra_skill_dirs = []",
    "telemetry = false",
    "",
    ...blocks,
    "",
    "[loop_control]",
    `max_steps_per_turn = ${maxSteps}`,
    "max_retries_per_step = 2",
    "",
    ...rules
  ].join("\n").replace(/\n{4,}/g, "\n\n\n").trim() + "\n";
}

function verifyKimiCliCompatibility(config) {
  const probe = spawnSync(config.kimiBin, ["--version"], {
    encoding: "utf8",
    timeout: 5000
  });
  const version = String(probe.stdout || probe.stderr || "").trim().match(/\d+\.\d+\.\d+/)?.[0] || "";
  if (probe.status !== 0 || !SUPPORTED_KIMI_CODE_VERSIONS.has(version)) {
    throw new Error(
      `Kimi Code ${version || "unknown"} has not passed MazeBench's built-in tool isolation review. ` +
      `Supported version: ${[...SUPPORTED_KIMI_CODE_VERSIONS].join(", ")}.`
    );
  }
  return version;
}

function kimiMcpConfig(config) {
  if (!config.mcpUrl) {
    throw new Error("Kimi Code requires the private MazeBench MCP endpoint.");
  }
  const restricted = config.toolUse === "read-only";
  const name = restricted ? "game" : "mazebench";
  const enabledTools = restricted
    ? ["game_start", "game_observe", "game_action"]
    : [
        "maze_start",
        "maze_observe",
        "maze_action",
        ...(config.autoRunTools ? ["maze_action_sequence"] : []),
        "python_exec"
      ];
  return JSON.stringify({
    mcpServers: {
      [name]: {
        url: config.mcpUrl,
        enabled: true,
        enabledTools,
        toolTimeoutMs: 300_000,
        startupTimeoutMs: 15_000
      }
    }
  }, null, 2) + "\n";
}

function prepareKimiRuntime(config) {
  const sourceHome = config.kimiAuthDir || process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
  const sourceConfig = path.join(sourceHome, "config.toml");
  if (!fs.existsSync(sourceConfig)) {
    throw new Error(`Kimi Code is not configured at ${sourceConfig}. Run \`kimi login\` first.`);
  }

  fs.mkdirSync(config.kimiRuntimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.kimiRuntimeDir, 0o700);
  fs.mkdirSync(config.kimiSkillsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(config.kimiRuntimeDir, "config.toml"),
    sanitizeKimiConfig(fs.readFileSync(sourceConfig, "utf8"), config),
    { mode: 0o600 }
  );
  fs.writeFileSync(path.join(config.kimiRuntimeDir, "mcp.json"), kimiMcpConfig(config), { mode: 0o600 });
  fs.writeFileSync(path.join(config.kimiRuntimeDir, "mazebench-agent.md"), kimiAgentProfile(config), { mode: 0o600 });

  const sourceCredentials = path.join(sourceHome, "credentials");
  const runtimeCredentials = path.join(config.kimiRuntimeDir, "credentials");
  fs.rmSync(runtimeCredentials, { recursive: true, force: true });
  if (fs.existsSync(sourceCredentials)) {
    fs.cpSync(sourceCredentials, runtimeCredentials, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    fs.chmodSync(runtimeCredentials, 0o700);
  }
  const sourceDeviceId = path.join(sourceHome, "device_id");
  if (fs.existsSync(sourceDeviceId)) {
    fs.copyFileSync(sourceDeviceId, path.join(config.kimiRuntimeDir, "device_id"));
    fs.chmodSync(path.join(config.kimiRuntimeDir, "device_id"), 0o600);
  }
}

function scrubKimiRuntimeSecrets(config) {
  if (config.model !== "kimi" || !config.kimiRuntimeDir) return;
  for (const entry of ["config.toml", "mcp.json", "mazebench-agent.md", "credentials", "device_id"]) {
    fs.rmSync(path.join(config.kimiRuntimeDir, entry), { recursive: true, force: true });
  }
}

function prepareAgentRuntime(config) {
  if (!config.mcpEnabled) return;
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  fs.mkdirSync(config.swarmDir, { recursive: true });
  fs.mkdirSync(config.swarmWorkspaceDir, { recursive: true });
  if (config.model === "codex") prepareCodexRuntime(config);
}

function verifyToolIsolation(config) {
  if (config.toolUse !== "offline") return null;
  const report = preflightPythonSandbox({
    scratchDir: config.workspaceDir,
    stateDir: config.pythonSandboxStateDir,
    deniedPaths: [ROOT_DIR, config.outDir, config.inContainer ? "/home" : os.homedir()],
    codexBin: config.codexBin,
    pythonBin: config.pythonBin,
    runUid: config.inContainer ? config.agentUid : undefined,
    runGid: config.inContainer ? config.agentGid : undefined
  });
  fs.writeFileSync(
    path.join(config.outDir, "tool-isolation.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 }
  );
  return report;
}

async function startPrivateMcpServer(config) {
  const token = crypto.randomBytes(24).toString("hex");
  const portFile = path.join(config.outDir, "mcp-http.json");
  fs.rmSync(portFile, { force: true });
  const child = spawn(
    process.execPath,
    [MAZE_MCP_SERVER, "--http", "--port-file", portFile],
    {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ...mcpEnvironment(config),
        MAZEBENCH_MCP_HTTP_TOKEN: token
      },
      stdio: ["ignore", "ignore", "inherit"]
    }
  );

  let exited = null;
  child.once("exit", (code) => {
    exited = code;
  });
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(portFile) && Date.now() < deadline && exited === null) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (!fs.existsSync(portFile)) {
    child.kill("SIGKILL");
    throw new Error(`Private MazeBench MCP service failed to start${exited === null ? "" : ` (exit ${exited})`}.`);
  }
  const info = JSON.parse(fs.readFileSync(portFile, "utf8"));
  const base = `http://127.0.0.1:${Number(info.port)}/${token}`;
  config.mcpUrl = `${base}/lead`;
  config.mcpWorkerUrl = `${base}/worker`;
  return {
    stop() {
      if (child.exitCode == null) child.kill("SIGTERM");
      fs.rmSync(portFile, { force: true });
    }
  };
}

function needsPrivateMcpServer(config) {
  return Boolean(config.mcpEnabled && (config.inContainer || ["claude", "kimi"].includes(config.model)));
}

function isolatedDockerAgentCommand(config, command) {
  if (!config.inContainer) return command;
  const chownTree = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) chownTree(child);
      fs.chownSync(child, config.agentUid, config.agentGid);
    }
    fs.chownSync(directory, config.agentUid, config.agentGid);
  };
  chownTree(config.workspaceDir);
  chownTree(config.swarmWorkspaceDir);

  // A bwrap tmpfs root is owned by root. Give the demoted provider a private,
  // container-ephemeral home and /tmp so it cannot inspect trusted runner
  // state. Only the selected provider's credential and this run's transcript
  // directory are rebound.
  const providerTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-provider-"));
  fs.chmodSync(providerTmpDir, 0o700);
  fs.chownSync(providerTmpDir, config.agentUid, config.agentGid);
  const providerHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-provider-home-"));
  const providerBindArgs = [];
  const credentialSources = [];
  const providerSetenv = [];

  if (config.model === "codex") {
    const providerDir = path.join(providerHomeDir, ".codex");
    const sessionsDir = path.join(config.outDir, "agent-state", "codex", "sessions");
    fs.mkdirSync(path.join(providerDir, "sessions"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(providerDir, "maze-runtime"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(sessionsDir, { recursive: true });
    providerBindArgs.push(
      ...(fs.existsSync(config.codexRuntimeDir)
        ? ["--ro-bind", config.codexRuntimeDir, config.agentCodexRuntimeDir]
        : []),
      "--bind", sessionsDir, "/home/pwuser/.codex/sessions"
    );
    if (config.inference === "prime") {
      const primeConfigFile = process.env.MAZEBENCH_PRIME_CONFIG_FILE ||
        "/run/mazebench-credentials/prime-config.json";
      if (!fs.existsSync(primeConfigFile) || !fs.statSync(primeConfigFile).isFile()) {
        throw new Error("The isolated Codex/Prime runtime has no mounted Prime credential.");
      }
      providerBindArgs.push(
        "--ro-bind", primeConfigFile, "/home/pwuser/.codex/prime-config.json"
      );
      credentialSources.push(primeConfigFile);
    } else {
      const authFile = process.env.MAZEBENCH_CODEX_AUTH_FILE ||
        "/run/mazebench-credentials/codex-auth.json";
      if (!fs.existsSync(authFile) || !fs.statSync(authFile).isFile()) {
        throw new Error("The isolated local Codex runtime has no mounted auth file.");
      }
      fs.writeFileSync(path.join(providerDir, "auth.json"), "", { mode: 0o600 });
      providerBindArgs.push(
        "--ro-bind", authFile, "/home/pwuser/.codex/auth.json"
      );
      credentialSources.push(authFile);
    }
    providerSetenv.push("--setenv", "CODEX_HOME", "/home/pwuser/.codex");
    chownTree(sessionsDir);
  } else if (config.model === "claude") {
    const authFile = process.env.MAZEBENCH_CLAUDE_AUTH_FILE ||
      "/run/mazebench-credentials/claude-credentials.json";
    if (!fs.existsSync(authFile) || !fs.statSync(authFile).isFile()) {
      throw new Error("The isolated local Claude Code runtime has no mounted subscription credential.");
    }
    const providerDir = path.join(providerHomeDir, ".claude");
    const projectsDir = path.join(config.outDir, "agent-state", "claude", "projects");
    fs.mkdirSync(path.join(providerDir, "projects"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(providerDir, ".credentials.json"), "", { mode: 0o600 });
    fs.mkdirSync(projectsDir, { recursive: true });
    providerBindArgs.push(
      "--ro-bind", authFile, "/home/pwuser/.claude/.credentials.json",
      "--bind", projectsDir, "/home/pwuser/.claude/projects"
    );
    credentialSources.push(authFile);
    providerSetenv.push(
      "--setenv", "CLAUDE_CONFIG_DIR", "/home/pwuser/.claude",
      "--setenv", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1",
      "--setenv", "DISABLE_TELEMETRY", "1",
      "--setenv", "DISABLE_ERROR_REPORTING", "1",
      "--setenv", "DISABLE_AUTOUPDATER", "1"
    );
    chownTree(projectsDir);
  } else if (config.model === "kimi") {
    const configFile = process.env.MAZEBENCH_KIMI_CONFIG_FILE ||
      "/run/mazebench-credentials/kimi-config.toml";
    if (!fs.existsSync(configFile) || !fs.statSync(configFile).isFile()) {
      throw new Error("The isolated local Kimi Code runtime has no mounted account configuration.");
    }
    const providerDir = path.join(providerHomeDir, ".kimi-code");
    const sessionsDir = path.join(config.outDir, "agent-state", "kimi", "sessions");
    const sessionIndex = path.join(config.outDir, "agent-state", "kimi", "session_index.jsonl");
    fs.mkdirSync(path.join(providerDir, "empty-skills"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(providerDir, "sessions"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(sessionsDir, { recursive: true });
    if (!fs.existsSync(sessionIndex)) fs.writeFileSync(sessionIndex, "", { mode: 0o600 });
    fs.writeFileSync(
      path.join(providerDir, "config.toml"),
      sanitizeKimiConfig(fs.readFileSync(configFile, "utf8"), config),
      { mode: 0o600 }
    );
    fs.writeFileSync(path.join(providerDir, "mcp.json"), kimiMcpConfig(config), { mode: 0o600 });
    fs.writeFileSync(path.join(providerDir, "mazebench-agent.md"), kimiAgentProfile(config), { mode: 0o600 });

    const credentialsDir = process.env.MAZEBENCH_KIMI_CREDENTIALS_DIR || "";
    if (credentialsDir && fs.existsSync(credentialsDir) && fs.statSync(credentialsDir).isDirectory()) {
      fs.cpSync(credentialsDir, path.join(providerDir, "credentials"), { recursive: true });
      credentialSources.push(credentialsDir);
    }
    const deviceId = process.env.MAZEBENCH_KIMI_DEVICE_ID_FILE || "";
    if (deviceId && fs.existsSync(deviceId) && fs.statSync(deviceId).isFile()) {
      fs.copyFileSync(deviceId, path.join(providerDir, "device_id"));
      credentialSources.push(deviceId);
    }
    providerBindArgs.push(
      "--bind", sessionsDir, "/home/pwuser/.kimi-code/sessions",
      "--bind", sessionIndex, "/home/pwuser/.kimi-code/session_index.jsonl"
    );
    credentialSources.push(configFile);
    providerSetenv.push(
      "--setenv", "KIMI_CODE_HOME", "/home/pwuser/.kimi-code",
      "--setenv", "KIMI_DISABLE_TELEMETRY", "1",
      "--setenv", "KIMI_CODE_NO_AUTO_UPDATE", "1",
      "--setenv", "KIMI_DISABLE_CRON", "1",
      "--setenv", "KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT", "0",
      "--setenv", "KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY", "1",
      "--setenv", "KIMI_CODE_EXPERIMENTAL_FLAG", "1",
      "--setenv", "KIMI_LOG_LEVEL", "warn"
    );
    if (config.reasoning) {
      providerSetenv.push("--setenv", "KIMI_MODEL_THINKING_EFFORT", config.reasoning);
    }
    chownTree(sessionsDir);
    fs.chownSync(sessionIndex, config.agentUid, config.agentGid);
  } else {
    throw new Error(`Unknown local provider: ${config.model}`);
  }
  chownTree(providerHomeDir);

  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--ro-bind", "/", "/",
    // Hide every bundled MazeBench source, level, world-map, prior output, and
    // solver from the provider and all descendants. Only blank run workspaces
    // are rebound below; gameplay stays behind the private HTTP MCP service.
    "--tmpfs", ROOT_DIR,
    "--dir", config.agentWorkspaceDir,
    "--bind", providerHomeDir, "/home/pwuser",
    "--bind", providerTmpDir, "/tmp",
    "--dev", "/dev",
    "--proc", "/proc",
    "--bind", config.workspaceDir, config.agentWorkspaceDir,
    ...providerBindArgs,
    // The sources of the narrow rebinds above live in trusted directories.
    // Mask those source locations after rebinding so the provider cannot reach
    // any sibling artifact by path.
    "--tmpfs", config.outDir,
    ...[...new Set(credentialSources.map((source) => path.dirname(source)))].flatMap((directory) => [
      "--tmpfs", directory
    ]),
    "--tmpfs", path.dirname(config.workspaceDir),
    "--chdir", config.agentWorkspaceDir,
    "--clearenv",
    "--setenv", "PATH", process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    "--setenv", "HOME", "/home/pwuser",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "LANG", process.env.LANG || "C.UTF-8",
    "--setenv", "LC_ALL", process.env.LC_ALL || "C.UTF-8",
    "--setenv", "NO_COLOR", "1",
    "--setenv", "CI", "1",
    "--setenv", "USER", "pwuser",
    "--setenv", "LOGNAME", "pwuser",
    ...providerSetenv
  ];
  args.push(
    "--",
    "setpriv",
    "--reuid", String(config.agentUid),
    "--regid", String(config.agentGid),
    "--clear-groups",
    "--bounding-set=-all",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--no-new-privs",
    command.bin,
    ...command.argv
  );
  return { bin: "bwrap", argv: args };
}

function agentCommand(config, prompt) {
  const maxTurns = config.unlimited ? "" : String(config.swarm ? config.moves + 30 : config.moves + 10);

  if (config.model === "codex") {
    const commandRoot = config.agentWorkspaceDir;
    // --json streams structured events (agent messages, reasoning, shell calls)
    // on stdout so we can build a per-move reasoning log. `exec resume <id>`
    // continues a prior conversation (the model keeps its full memory).
    const argv = config.resume
      ? ["exec", "resume", config.resume, "--json", "--skip-git-repo-check"]
      : ["exec", "--json", "--skip-git-repo-check", "-C", commandRoot];
    // Ignore global behavioral config while retaining the provider's normal
    // auth/session store. All run policy arrives explicitly or from the
    // project-scoped worker profiles under this run's workspace.
    argv.push(
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "-c", 'approval_policy="never"',
      "-c", 'web_search="disabled"',
      "-c", "tools.web_search=false",
      "-c", "features.code_mode.enabled=false",
      "-c", "agents.max_depth=1",
      "-c", "project_doc_max_bytes=0",
      "-c", "memories.use_memories=false",
      "-c", "memories.generate_memories=false",
      "-c", "apps._default.enabled=false",
      "-c", "skills.include_instructions=false",
      "-c", "skills.bundled.enabled=false",
      "-c", "include_apps_instructions=false",
      "-c", "include_collaboration_mode_instructions=false",
      "-c", "include_environment_context=false",
      ...codexPermissionConfigArgs(config),
      ...codexAgentConfigArgs(config),
      ...codexMcpConfigArgs(config),
      ...codexPrimeProviderConfigArgs(config),
      "--disable", "shell_tool",
      "--disable", "unified_exec",
      "--disable", "code_mode",
      "--disable", "memories",
      "--disable", "apps",
      "--disable", "plugins",
      "--disable", "enable_mcp_apps",
      "--disable", "tool_search",
      "--disable", "tool_suggest",
      "--disable", "standalone_web_search",
      "--disable", "image_generation",
      "--disable", "computer_use",
      "--disable", "in_app_browser",
      "--disable", "browser_use",
      "--disable", "remote_plugin",
      "--disable", "plugin_sharing"
    );
    if (config.toolUse === "read-only") {
      const restrictedCodexDir = config.agentCodexRuntimeDir || config.codexRuntimeDir || path.join(config.outDir, ".codex-runtime");
      const guardCommand = `${process.execPath} ${path.posix.join(restrictedCodexDir, "tool-guard.js")}`;
      argv.push(
        "-c", "suppress_unstable_features_warning=true",
        "-c", `model_instructions_file=${tomlString(path.posix.join(restrictedCodexDir, "restricted-instructions.txt"))}`,
        "-c", `hooks.PreToolUse=[{ matcher="^exec$", hooks=[{ type="command", command=${tomlString(guardCommand)}, timeout=5, statusMessage="Enforcing game-only mode" }] }]`,
        "--dangerously-bypass-hook-trust"
      );
    }
    argv.push(config.swarm ? "--enable" : "--disable", "multi_agent");
    // Ask Codex for fuller reasoning summaries (it emits `reasoning` items in
    // the JSON stream). Codex only ever exposes summaries — never raw
    // chain-of-thought — but "detailed" is richer than the terse default.
    // Spark rejects the underlying reasoning.summary request entirely, so let
    // that model use its provider default instead of failing before game_start.
    if (!String(config.modelName || "").toLowerCase().includes("codex-spark")) {
      argv.push("-c", 'model_reasoning_summary="detailed"');
    }
    if (config.modelName) {
      argv.push("-m", config.modelName);
    }
    if (config.reasoning) {
      argv.push("-c", `model_reasoning_effort="${config.reasoning}"`);
    }
    if (config.codexFast) {
      // The "priority" service tier is Codex's Fast mode (~1.5x speed).
      argv.push("-c", 'service_tier="priority"');
    }
    argv.push(prompt);
    return { bin: config.codexBin, argv };
  }

  if (config.model === "claude") {
    // stream-json (requires --verbose in -p mode) emits the structured event
    // stream we parse into the reasoning log; --include-partial-messages adds the
    // text_delta/thinking_delta chunks that carry the actual reasoning (the
    // aggregated `thinking` blocks are withheld).
    const argv = [
      "-p", prompt,
      "--output-format", "stream-json", "--verbose", "--include-partial-messages"
    ];
    // Resume the prior conversation so the model keeps its full memory.
    if (config.resume) {
      argv.push("--resume", config.resume);
      if (config.forkSession) {
        argv.push("--fork-session");
        if (config.sessionId) argv.push("--session-id", config.sessionId);
      }
    }
    if (config.mcpEnabled) {
      const restricted = config.toolUse === "read-only";
      const mcpTools = restricted
        ? [
            "mcp__game__game_start",
            "mcp__game__game_observe",
            "mcp__game__game_action"
          ]
        : [
            "mcp__mazebench__maze_start",
            "mcp__mazebench__maze_observe",
            "mcp__mazebench__maze_action",
            ...(config.autoRunTools ? ["mcp__mazebench__maze_action_sequence"] : []),
            "mcp__mazebench__python_exec",
            ...(config.swarm ? ["mcp__mazebench__maze_workers"] : [])
          ];
      const localTools = [];
      // Claude Code has called this built-in both `Task` and `Agent` across
      // releases. Permit both names so the lead can delegate, while the
      // worker definition itself deliberately omits either tool.
      if (config.swarm) localTools.push("Task", "Agent");
      // Current Claude Code releases require the default registry for dynamic
      // MCP discovery. Restricted mode still exposes only game controls because
      // every built-in tool is denied below and in the sandbox settings.
      const enabledTools = "default";

      argv.push(
        "--mcp-config", claudeMcpConfig(config),
        "--strict-mcp-config",
        "--settings", claudeSandboxSettings(config),
        "--permission-mode", "dontAsk",
        "--no-chrome",
        "--disable-slash-commands",
        "--prompt-suggestions", "false",
        "--tools", enabledTools,
        "--allowedTools", [...localTools, ...mcpTools].join(","),
        "--disallowedTools", [
          "WebFetch", "WebSearch",
          ...CLAUDE_RESTRICTED_BUILTIN_TOOLS.filter(
            (tool) => !config.swarm || !["Task", "Agent"].includes(tool)
          )
        ].join(","),
        "--append-system-prompt",
        restricted
          ? "You are solving the current grid-game task. Use only the explicitly configured game controls and your current conversation memory."
          : "Use only the configured game controls and python_exec. Host shell, files, repositories, web, apps, and connectors are unavailable."
      );
      const agents = claudeAgents(config);
      if (agents) argv.push("--agents", agents);
    } else if (config.tools) {
      argv.push("--permission-mode", "bypassPermissions");
    } else {
      // dontAsk auto-denies every tool not on the allowlist (no prompt, run
      // continues). Allow ONLY the maze helper — both the quoted form the
      // prompt uses and the bare form, since Bash patterns match the literal
      // command string. Claude blocks command chaining per-subcommand, so this
      // cannot be widened with `; other-cmd`. Vision also needs to read frames.
      const allow = config.claudeAllowedTools
        ? [config.claudeAllowedTools]
        : [`Bash(node "${HELPER}" *)`, `Bash(node ${HELPER} *)`];
      if (config.mode === "vision") {
        allow.push(`Read(${path.join(config.outDir, "frames")}/**)`);
      }
      argv.push("--permission-mode", "dontAsk", "--allowedTools", allow.join(","));
    }
    if (maxTurns) argv.push("--max-turns", maxTurns);
    if (config.modelName) {
      argv.push("--model", config.modelName);
    }
    // Claude Code's reasoning-effort knob (low|medium|high|xhigh|max).
    if (["low", "medium", "high", "xhigh", "max"].includes(config.reasoning)) {
      argv.push("--effort", config.reasoning);
    }
    return { bin: config.claudeBin, argv };
  }

  if (config.model === "kimi") {
    const argv = [];
    const kimiProfile = config.agentKimiProfile || path.join(config.agentKimiRuntimeDir, "mazebench-agent.md");
    if (config.resume) argv.push("--session", config.resume);
    if (config.modelName) argv.push("--model", config.modelName);
    argv.push(
      "--prompt", prompt,
      "--output-format", "stream-json",
      "--skills-dir", config.agentKimiSkillsDir,
      "--agent-file", kimiProfile
    );
    return {
      bin: config.kimiBin,
      argv,
      env: {
        KIMI_CODE_HOME: config.agentKimiRuntimeDir,
        KIMI_DISABLE_TELEMETRY: "1",
        KIMI_CODE_NO_AUTO_UPDATE: "1",
        KIMI_DISABLE_CRON: "1",
        KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT: "0",
        KIMI_CODE_EXPERIMENTAL_FLAG: "1",
        KIMI_LOG_LEVEL: "warn",
        NO_COLOR: "1",
        CI: "1",
        ...(config.reasoning ? { KIMI_MODEL_THINKING_EFFORT: config.reasoning } : {})
      }
    };
  }

  throw new Error(`Unknown model: ${config.model} (expected "codex", "claude", or "kimi")`);
}

const REQUIRED_LOCAL_CODEX_DISABLED_FEATURES = Object.freeze([
  "apps",
  "browser_use",
  "code_mode",
  "computer_use",
  "enable_mcp_apps",
  "image_generation",
  "in_app_browser",
  "memories",
  "multi_agent",
  "plugin_sharing",
  "plugins",
  "remote_plugin",
  "shell_tool",
  "standalone_web_search",
  "tool_search",
  "tool_suggest",
  "unified_exec"
]);

function assertLocalCodexCommandIsolation(config, command) {
  if (!config.inContainer || config.model !== "codex") {
    throw new Error("Local Codex must run inside the certified disposable container boundary.");
  }
  const offline = config.toolUse === "offline";
  if (!["read-only", "offline"].includes(config.toolUse) || Boolean(config.tools) !== offline || config.swarm) {
    throw new Error("Local Codex supports one agent with game controls and the optional isolated Python tool only.");
  }
  if (command.bin !== config.codexBin) {
    throw new Error("The evaluated process must be the pinned Codex CLI.");
  }

  const args = command.argv.map(String);
  const joined = args.join("\n");
  if (
    args.includes("--add-dir") ||
    args.includes("--sandbox") ||
    args.includes("--search") ||
    args.includes("--enable") ||
    args.includes("--dangerously-bypass-approvals-and-sandbox") ||
    /sandbox_mode|sandbox_workspace_write/.test(joined)
  ) {
    throw new Error("Local Codex launch attempted to widen filesystem access.");
  }
  for (const feature of REQUIRED_LOCAL_CODEX_DISABLED_FEATURES) {
    const disabled = args.some((value, index) => value === feature && args[index - 1] === "--disable");
    if (!disabled) throw new Error(`Local Codex launch did not disable ${feature}.`);
  }
  const configValues = args.filter((_value, index) => args[index - 1] === "-c");
  const mcpPrefix = offline ? "mazebench" : "game";
  const enabledTools = offline
    ? ["maze_start", "maze_observe", "maze_action", ...(config.autoRunTools ? ["maze_action_sequence"] : []), "python_exec"]
    : ["game_start", "game_observe", "game_action"];
  for (const required of [
    'approval_policy="never"',
    'web_search="disabled"',
    "tools.web_search=false",
    "permissions.mazebench_agent.network.enabled=false",
    `mcp_servers.${mcpPrefix}.enabled_tools=${JSON.stringify(enabledTools)}`
  ]) {
    if (configValues.filter((value) => value === required).length !== 1) {
      throw new Error(`Local Codex launch is missing isolation setting: ${required}`);
    }
  }
  const primeProviderValues = config.inference === "prime"
    ? [
        'model_provider="prime_intellect"',
        'model_providers.prime_intellect.name="Prime Intellect"',
        `model_providers.prime_intellect.base_url=${tomlString(config.primeInferenceUrl)}`,
        'model_providers.prime_intellect.wire_api="responses"',
        `model_providers.prime_intellect.auth.command=${tomlString(process.execPath)}`,
        `model_providers.prime_intellect.auth.args=[${tomlString(path.posix.join(config.agentCodexRuntimeDir, "prime-auth.js"))}, ${tomlString("/home/pwuser/.codex/prime-config.json")}]`,
        "model_providers.prime_intellect.auth.timeout_ms=5000",
        "model_providers.prime_intellect.auth.refresh_interval_ms=300000",
        "model_providers.prime_intellect.request_max_retries=2",
        "model_providers.prime_intellect.stream_max_retries=1",
        "model_providers.prime_intellect.stream_idle_timeout_ms=45000"
      ]
    : [];
  if (config.inference === "prime" &&
      primeProviderValues.some((required) => configValues.filter((value) => value === required).length !== 1)) {
    throw new Error("Codex/Prime launch is missing its reviewed command-backed inference provider.");
  }
  if (config.inference !== "prime" &&
      configValues.some((value) => /^(?:model_provider|model_providers\.)/.test(value))) {
    throw new Error("Local subscription Codex cannot inject a custom model provider.");
  }
  if (configValues.some((value) => /(?:env_key|experimental_bearer_token|requires_openai_auth)=/.test(value))) {
    throw new Error("Codex provider credentials must use the reviewed command-backed reader.");
  }
  if (configValues.filter((value) => value.startsWith(`mcp_servers.${mcpPrefix}.url=`)).length !== 1) {
    throw new Error("Local Codex must use exactly one private HTTP MCP endpoint.");
  }
  const filesystemProfile = configValues.find((value) => value.startsWith("permissions.mazebench_agent.filesystem="));
  const workspaceWrite = `"${canonicalPath(config.agentWorkspaceDir)}"="write"`;
  const swarmWorkspaceWrite = `"${canonicalPath(config.agentSwarmWorkspaceDir)}"="write"`;
  if (!filesystemProfile || !filesystemProfile.includes('":minimal"="read"') ||
      (offline
        ? !filesystemProfile.includes(workspaceWrite) || !filesystemProfile.includes(swarmWorkspaceWrite)
        : filesystemProfile.includes('"write"'))) {
    throw new Error("Local Codex filesystem permissions do not match the reviewed run-scoped policy.");
  }
  if (
    new RegExp(`mcp_servers\\.(?!${mcpPrefix}\\.)`).test(joined) ||
    new RegExp(`mcp_servers\\.${mcpPrefix}\\.(?:command|args|env)=`).test(joined) ||
    /maze_workers/.test(joined) ||
    (!offline && /python_exec|mcp_servers\.mazebench/.test(joined)) ||
    configValues.some((value) => /^(?:approval_policy|web_search|tools\.web_search|permissions\.mazebench_agent\.network\.enabled)=/.test(value) && ![
      'approval_policy="never"',
      'web_search="disabled"',
      "tools.web_search=false",
      "permissions.mazebench_agent.network.enabled=false"
    ].includes(value))
  ) {
    throw new Error("Local Codex launch exposed a non-game capability.");
  }
  return true;
}

function assertLocalClaudeCommandIsolation(config, command) {
  if (!config.inContainer || config.model !== "claude") {
    throw new Error("Local Claude Code must run inside the certified disposable container boundary.");
  }
  const offline = config.toolUse === "offline";
  if (!["read-only", "offline"].includes(config.toolUse) || Boolean(config.tools) !== offline || config.swarm) {
    throw new Error("Local Claude Code supports one agent with game controls and the optional isolated Python tool only.");
  }
  if (command.bin !== config.claudeBin) {
    throw new Error("The evaluated process must be the pinned Claude Code CLI.");
  }

  const args = command.argv.map(String);
  const forbidden = [
    "--add-dir", "--agent", "--agents", "--allow-dangerously-skip-permissions",
    "--bare", "--chrome", "--dangerously-skip-permissions", "--plugin-dir",
    "--plugin-url", "--remote-control", "--safe-mode", "--worktree"
  ];
  if (forbidden.some((flag) => args.includes(flag))) {
    throw new Error("Local Claude Code launch attempted to widen agent capabilities.");
  }
  const valueAfter = (flag) => {
    const indexes = args.flatMap((value, index) => value === flag ? [index] : []);
    if (indexes.length !== 1 || indexes[0] + 1 >= args.length) {
      throw new Error(`Local Claude Code launch is missing one exact ${flag} setting.`);
    }
    return args[indexes[0] + 1];
  };
  if (!args.includes("--strict-mcp-config") || !args.includes("--no-chrome") ||
      !args.includes("--disable-slash-commands")) {
    throw new Error("Local Claude Code launch did not disable ambient integrations.");
  }
  if (valueAfter("--permission-mode") !== "dontAsk" || valueAfter("--tools") !== "default") {
    throw new Error("Local Claude Code launch has an unsafe permission mode.");
  }
  const expectedAllowed = offline
    ? [
        "mcp__mazebench__maze_start",
        "mcp__mazebench__maze_observe",
        "mcp__mazebench__maze_action",
        ...(config.autoRunTools ? ["mcp__mazebench__maze_action_sequence"] : []),
        "mcp__mazebench__python_exec"
      ]
    : [
        "mcp__game__game_start",
        "mcp__game__game_observe",
        "mcp__game__game_action"
      ];
  const allowed = new Set(valueAfter("--allowedTools").split(",").filter(Boolean));
  if (allowed.size !== expectedAllowed.length || !expectedAllowed.every((tool) => allowed.has(tool))) {
    throw new Error("Local Claude Code launch exposed an unreviewed tool.");
  }
  const denied = new Set(valueAfter("--disallowedTools").split(",").filter(Boolean));
  if (!CLAUDE_RESTRICTED_BUILTIN_TOOLS.every((tool) => denied.has(tool))) {
    throw new Error("Local Claude Code launch did not deny every reviewed built-in tool.");
  }
  const mcp = JSON.parse(valueAfter("--mcp-config"));
  const servers = Object.entries(mcp?.mcpServers || {});
  const serverName = offline ? "mazebench" : "game";
  const server = servers[0]?.[1];
  if (servers.length !== 1 || servers[0][0] !== serverName || server?.type !== "http" ||
      server?.url !== config.mcpUrl || Object.keys(server).some((key) => !["type", "url"].includes(key))) {
    throw new Error("Local Claude Code must use exactly one private HTTP MCP endpoint.");
  }
  const settings = JSON.parse(valueAfter("--settings"));
  if (settings?.sandbox?.network?.allowedDomains?.length ||
      settings?.sandbox?.filesystem?.allowWrite?.length ||
      settings?.sandbox?.failIfUnavailable !== true) {
    throw new Error("Local Claude Code sandbox settings attempted to widen access.");
  }
  return true;
}

function assertLocalKimiCommandIsolation(config, command) {
  if (!config.inContainer || config.model !== "kimi") {
    throw new Error("Local Kimi Code must run inside the certified disposable container boundary.");
  }
  const offline = config.toolUse === "offline";
  if (!["read-only", "offline"].includes(config.toolUse) || Boolean(config.tools) !== offline || config.swarm) {
    throw new Error("Local Kimi Code supports one agent with game controls and the optional isolated Python tool only.");
  }
  if (command.bin !== config.kimiBin) {
    throw new Error("The evaluated process must be the pinned Kimi Code CLI.");
  }
  const args = command.argv.map(String);
  const valueFlags = new Set(["--session", "--model", "--prompt", "--output-format", "--skills-dir", "--agent-file"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!valueFlags.has(flag) || index + 1 >= args.length) {
      throw new Error(`Local Kimi Code launch contains an unreviewed option: ${flag}`);
    }
  }
  const valueAfter = (flag) => {
    const indexes = args.flatMap((value, index) => value === flag ? [index] : []);
    if (indexes.length !== 1) throw new Error(`Local Kimi Code needs one exact ${flag} setting.`);
    return args[indexes[0] + 1];
  };
  const kimiProfilePath = config.agentKimiProfile || path.join(config.agentKimiRuntimeDir, "mazebench-agent.md");
  if (valueAfter("--output-format") !== "stream-json" ||
      valueAfter("--skills-dir") !== config.agentKimiSkillsDir ||
      valueAfter("--agent-file") !== kimiProfilePath) {
    throw new Error("Local Kimi Code launch did not use its empty skills directory and reviewed agent profile.");
  }
  const profile = kimiAgentProfile(config);
  const expectedTools = kimiAllowedTools(config);
  if (!profile.includes("subagents: []") ||
      !expectedTools.every((tool) => profile.includes(`  - ${tool}`)) ||
      !KIMI_RESTRICTED_BUILTIN_TOOLS.every((tool) => profile.includes(`  - ${tool}`))) {
    throw new Error("Local Kimi Code agent profile contains an unreviewed tool.");
  }
  return true;
}

function assertLocalAgentCommandIsolation(config, command) {
  if (config.model === "codex") return assertLocalCodexCommandIsolation(config, command);
  if (config.model === "claude") return assertLocalClaudeCommandIsolation(config, command);
  if (config.model === "kimi") return assertLocalKimiCommandIsolation(config, command);
  throw new Error(`Unsupported local provider: ${config.model}`);
}

function isolatedAgentEnvironment(config, commandEnv = {}) {
  if (!config.inContainer) {
    return { ...process.env, ...commandEnv };
  }
  const providerHome = config.model === "codex"
    ? { CODEX_HOME: "/home/pwuser/.codex" }
    : config.model === "claude"
      ? { CLAUDE_CONFIG_DIR: "/home/pwuser/.claude" }
      : { KIMI_CODE_HOME: "/home/pwuser/.kimi-code" };
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: "/home/pwuser",
    TMPDIR: "/tmp",
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || "C.UTF-8",
    NO_COLOR: "1",
    CI: "1",
    ...providerHome,
    ...commandEnv
  };
}

function localAgentIsolationPreflight(config) {
  const preflightConfig = {
    ...config,
    mcpUrl: config.mcpUrl || "http://127.0.0.1:1/isolation-preflight"
  };
  const command = agentCommand(preflightConfig, "Isolation preflight only.");
  assertLocalAgentCommandIsolation(preflightConfig, command);

  const providerBin = { codex: config.codexBin, claude: config.claudeBin, kimi: config.kimiBin }[config.model];
  const requiredVersion = SUPPORTED_LOCAL_AGENT_VERSIONS[config.model];
  const versionProbe = spawnSync(providerBin, ["--version"], {
    encoding: "utf8",
    env: isolatedAgentEnvironment(config),
    timeout: 10_000
  });
  const installedVersion = String(versionProbe.stdout || versionProbe.stderr || "")
    .match(/\d+\.\d+\.\d+/)?.[0] || "";
  if (versionProbe.status !== 0 || installedVersion !== requiredVersion) {
    throw new Error(
      `Local ${config.model} ${installedVersion || "unknown"} has not passed MazeBench's isolation review; ` +
      `rebuild the image with ${config.model} ${requiredVersion}.`
    );
  }

  const credentialSource = {
    codex: config.inference === "prime"
      ? process.env.MAZEBENCH_PRIME_CONFIG_FILE || "/run/mazebench-credentials/prime-config.json"
      : process.env.MAZEBENCH_CODEX_AUTH_FILE || "/run/mazebench-credentials/codex-auth.json",
    claude: process.env.MAZEBENCH_CLAUDE_AUTH_FILE || "/run/mazebench-credentials/claude-credentials.json",
    kimi: process.env.MAZEBENCH_KIMI_CONFIG_FILE || "/run/mazebench-credentials/kimi-config.toml"
  }[config.model];
  const probeSource = `
    const fs = require("node:fs");
    const path = require("node:path");
    const workspace = ${JSON.stringify(config.agentWorkspaceDir)};
    const output = ${JSON.stringify(config.outDir)};
    const authSource = ${JSON.stringify(credentialSource)};
    const resuming = ${JSON.stringify(Boolean(config.resume))};
    const processStatus = fs.readFileSync("/proc/self/status", "utf8");
    const workspaceEntries = fs.readdirSync(workspace);
    const checks = {
      workspace_is_cwd: path.resolve(process.cwd()) === path.resolve(workspace),
      workspace_empty: workspaceEntries.length === 0,
      workspace_state_valid: resuming || workspaceEntries.length === 0,
      repository_hidden: fs.readdirSync("/app").every((entry) => entry === "workspace") &&
        !fs.existsSync("/app/scripts/maze-agent-local.js"),
      run_output_hidden: fs.readdirSync(output).length === 0 && !fs.existsSync(path.join(output, "run.json")),
      credential_source_hidden: !fs.existsSync(authSource),
      host_home_hidden: !fs.existsSync("/Users") && !fs.existsSync("/root/.ssh"),
      capabilities_dropped: ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].every((name) =>
        new RegExp("^" + name + ":\\\\s+0+$", "m").test(processStatus)
      ),
      no_new_privileges: /^NoNewPrivs:\\s+1$/m.test(processStatus)
    };
    process.stdout.write(JSON.stringify(checks));
    if (Object.entries(checks).some(([name, value]) => name !== "workspace_empty" && value !== true)) {
      process.exitCode = 2;
    }
  `;
  const namespaceCommand = isolatedDockerAgentCommand(preflightConfig, {
    bin: process.execPath,
    argv: ["-e", probeSource]
  });
  const namespaceProbe = spawnSync(namespaceCommand.bin, namespaceCommand.argv, {
    cwd: config.workspaceDir,
    encoding: "utf8",
    env: isolatedAgentEnvironment(config),
    timeout: 20_000,
    maxBuffer: 1024 * 1024
  });
  let checks = {};
  try {
    checks = JSON.parse(String(namespaceProbe.stdout || "{}"));
  } catch (_error) {
    /* the failure below includes stderr */
  }
  if (namespaceProbe.status !== 0 || !Object.keys(checks).length) {
    const detail = String(namespaceProbe.stderr || namespaceProbe.stdout || "").trim();
    throw new Error(`Local ${config.model} isolation preflight failed${detail ? `: ${detail}` : "."}`);
  }

  const report = {
    schema_version: 1,
    verified: true,
    checked_at: new Date().toISOString(),
    provider: config.model,
    boundary: config.toolUse === "offline"
      ? "disposable-container/game-tools+isolated-python"
      : "disposable-container/game-tools-only",
    provider_version: installedVersion,
    [`${config.model}_version`]: installedVersion,
    command_policy: {
      approval_escalation: false,
      shell: false,
      filesystem_tools: false,
      web: false,
      apps: false,
      subagents: false,
      mcp_tools: config.toolUse === "offline"
        ? ["maze_start", "maze_observe", "maze_action", ...(config.autoRunTools ? ["maze_action_sequence"] : []), "python_exec"]
        : ["game_start", "game_observe", "game_action"]
    },
    namespace: checks
  };
  for (const name of ["local-agent-isolation.json", `local-${config.model}-isolation.json`]) {
    fs.writeFileSync(path.join(config.outDir, name), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  return report;
}

// Backward-compatible export for callers/tests that still use the former
// Codex-specific helper name.
const localCodexIsolationPreflight = localAgentIsolationPreflight;

function ensureAgentAvailable(bin) {
  const probe = spawnSync("sh", ["-c", `command -v ${JSON.stringify(bin)}`], { encoding: "utf8" });
  if (probe.status !== 0) {
    throw new Error(
      `Agent CLI not found on PATH: ${bin}\n` +
        `Install it (or pass ${bin === "codex" ? "codex_bin=" : bin === "claude" ? "claude_bin=" : "kimi_bin="}<path>) and try again.`
    );
  }
}

function unwrapShellCommand(command) {
  let inner = String(command || "");
  const wrapped = inner.match(/-lc\s+'([\s\S]*)'\s*$/) || inner.match(/-lc\s+"([\s\S]*)"\s*$/);
  if (wrapped) inner = wrapped[1];
  return inner;
}

function splitShellCommands(command) {
  const input = unwrapShellCommand(command);
  const commands = [];
  let current = "";
  let quote = "";
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    const separatorLength = input.startsWith("&&", index) || input.startsWith("||", index) ? 2 : character === ";" ? 1 : 0;
    if (separatorLength) {
      if (current.trim()) commands.push(current.trim());
      current = "";
      index += separatorLength - 1;
      continue;
    }
    current += character;
  }

  if (current.trim()) commands.push(current.trim());
  return commands;
}

function actionsFromShellCommand(command) {
  return splitShellCommands(command).flatMap((inner) => {
    const match = inner.match(/\baction\s+--state\s+(?:"[^"]*"|'[^']*'|\S+)\s+([\s\S]+?)\s*$/);
    return match ? [match[1].trim().replace(/^["']|["']$/g, "")] : [];
  });
}

function actionFromShellCommand(command) {
  return actionsFromShellCommand(command)[0] || null;
}

function parsedToolInput(input) {
  if (input && typeof input === "object") return input;
  try {
    return JSON.parse(String(input || "{}"));
  } catch (_error) {
    return {};
  }
}

function actionsFromToolCall(name, input) {
  const toolName = String(name || "");
  const singleAction = /(?:^|__)(?:maze|game)_action$/.test(toolName);
  const actionSequence = /(?:^|__)(?:maze|game)_action_sequence$/.test(toolName);
  if (!singleAction && !actionSequence) return [];
  const args = parsedToolInput(input);
  // Private worker explorations are intentionally absent from the lead run's
  // move counter, token chart, and reasoning feed.
  if (args.clone_id) return [];
  if (actionSequence) {
    return Array.isArray(args.actions)
      ? args.actions.map((action) => String(action || "").trim()).filter(Boolean)
      : [];
  }
  const action = String(args.action || "").trim();
  return action ? [action] : [];
}

function isActionSequenceTool(name) {
  return /(?:^|__)(?:maze|game)_action_sequence$/.test(String(name || ""));
}

function completedSequenceCount(output) {
  const match = String(output || "").match(/"completed_count"\s*:\s*(\d+)/);
  return match ? Math.max(0, Number(match[1]) || 0) : null;
}

function sequenceActionsFromOutput(output) {
  for (const value of jsonValuesFromOutput(output)) {
    if (!Array.isArray(value?.steps)) continue;
    const completed = Math.max(0, Number(value.completed_count) || value.steps.length);
    return value.steps
      .slice(0, completed)
      .map((step) => String(step?.action || "").trim())
      .filter(Boolean);
  }
  return [];
}

function executedToolActions(actions, results, output, sequence) {
  if (sequence) {
    const reportedActions = sequenceActionsFromOutput(output);
    const plannedActions = reportedActions.length ? reportedActions : actions;
    const completedCount = completedSequenceCount(output);
    if (completedCount != null) return plannedActions.slice(0, completedCount);
    return results.length ? plannedActions.slice(0, results.length) : plannedActions;
  }
  return results.length ? actions.slice(0, results.length) : actions;
}

function resultShape(status) {
  return {
    moved: status.moved,
    gems: status.gem_count,
    room: status.current_room,
    room_changed: Boolean(status.room_changed),
    player_dead: Boolean(status.player_dead)
  };
}

function jsonValuesFromOutput(output) {
  const raw = String(output || "").trim();
  if (!raw) return [];
  const values = [];
  let start = -1;
  let depth = 0;
  let quote = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') {
      quote = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          values.push(JSON.parse(raw.slice(start, index + 1)));
        } catch (_error) {
          /* skip non-status JSON */
        }
        start = -1;
      }
    }
  }

  return values;
}

function resultsFromOutput(output) {
  return jsonValuesFromOutput(output).flatMap((value) => {
    if (Array.isArray(value?.steps) && Number.isFinite(Number(value.completed_count))) {
      return value.steps
        .slice(0, Math.max(0, Number(value.completed_count) || 0))
        .map((step) => resultShape(step?.status || {}));
    }
    return [resultShape(value)];
  });
}

function resultFromOutput(output) {
  return resultsFromOutput(output)[0] || {};
}

// Turn codex's --json event stream into a per-move reasoning log plus a
// human-readable transcript.
function distillCodexEvents(raw) {
  const entries = [];
  const transcript = [];
  let commentary = [];
  let move = 0;
  let finalMessage = "";

  for (const line of String(raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (_error) {
      continue;
    }
    if ((event.type || event.msg?.type) !== "item.completed") continue;
    const item = event.item || event.msg?.item;
    if (!item) continue;
    const kind = item.type || item.item_type;
    const timestamp = event._mazebench_received_at || event.timestamp || item.timestamp || null;

    if (kind === "reasoning" || kind === "agent_message") {
      const text = String(item.text || "").trim();
      if (!text) continue;
      commentary.push(text);
      finalMessage = text;
      transcript.push(`${kind === "reasoning" ? "[reasoning]" : "[agent]"} ${text}`);
    } else if (kind === "command_execution") {
      const command = String(item.command || "");
      const output = String(item.aggregated_output || "");
      transcript.push(`$ ${command}`);
      const actions = actionsFromShellCommand(command);
      if (actions.length) {
        const reasoning = commentary.join("\n\n").trim();
        const results = resultsFromOutput(output);
        const executed = results.length ? actions.slice(0, results.length) : actions;
        executed.forEach((action, index) => {
          move += 1;
          entries.push({ move, action, reasoning, timestamp, ...(results[index] || {}) });
        });
        commentary = [];
      }
    } else if (kind === "mcp_tool_call") {
      const name = item.tool || item.name || item.tool_name;
      const input = item.arguments || item.input || {};
      const actions = actionsFromToolCall(name, input);
      const sequence = isActionSequenceTool(name);
      transcript.push(`[tool] ${name || "mcp"} ${JSON.stringify(input)}`);
      if ((actions.length || sequence) && item.status !== "failed" && !item.error) {
        const reasoning = commentary.join("\n\n").trim();
        const output = toolResultText(item.result || item.output || item.content);
        const results = resultsFromOutput(output);
        const executed = executedToolActions(actions, results, output, sequence);
        executed.forEach((action, index) => {
          move += 1;
          entries.push({ move, action, reasoning, timestamp, ...(results[index] || {}) });
        });
        commentary = [];
      }
    }
  }

  return { entries, transcript: transcript.join("\n\n"), finalMessage };
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : String(part?.text || ""))).join("\n");
  }
  if (content && typeof content === "object") {
    if (content.content) return toolResultText(content.content);
    if (content.structuredContent) return JSON.stringify(content.structuredContent);
    return JSON.stringify(content);
  }
  return "";
}

// Turn Claude Code's --output-format stream-json events into the same per-move
// reasoning log. Reasoning comes from `text`/`thinking` content blocks; moves
// come from `tool_use` (Bash) blocks; results are matched by tool_use_id from
// the following `tool_result`.
function distillClaudeEvents(raw) {
  const entries = [];
  const transcript = [];
  const pending = new Map();
  let commentary = "";
  let move = 0;
  let finalMessage = "";

  for (const line of String(raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (_error) {
      continue;
    }

    // Reasoning arrives as streamed text/thinking deltas (--include-partial-messages).
    if (event.type === "stream_event" && event.event?.type === "content_block_delta") {
      const delta = event.event.delta || {};
      if (delta.type === "text_delta" && delta.text) commentary += delta.text;
      else if (delta.type === "thinking_delta" && delta.thinking) commentary += delta.thinking;
      continue;
    }

    // Moves come from the aggregated assistant message's tool_use blocks.
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      const reasoning = commentary.trim();
      let hasActions = false;
      for (const block of event.message.content) {
        if (block.type !== "tool_use") continue;
        const command = block.name === "Bash" ? String(block.input?.command || "") : "";
        transcript.push(`$ ${command || block.name}`);
        const actions = command
          ? actionsFromShellCommand(command)
          : actionsFromToolCall(block.name, block.input);
        const sequence = isActionSequenceTool(block.name);
        if (actions.length || sequence) {
          hasActions = true;
          if (reasoning) transcript.push(`[reasoning] ${reasoning}`);
          if (block.id) pending.set(block.id, {
            actions,
            sequence,
            reasoning,
            timestamp: event._mazebench_received_at || event.timestamp || null
          });
        }
      }
      if (hasActions) commentary = "";
    } else if (event.type === "user" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === "tool_result" && pending.has(block.tool_use_id)) {
          const output = toolResultText(block.content);
          const batch = pending.get(block.tool_use_id);
          if (block.is_error) {
            if (output) transcript.push(`[tool error] ${output}`);
            pending.delete(block.tool_use_id);
            continue;
          }
          const results = resultsFromOutput(output);
          const executed = executedToolActions(batch.actions, results, output, batch.sequence);
          const timestamp = event._mazebench_received_at || event.timestamp || batch.timestamp || null;
          executed.forEach((action, index) => {
            move += 1;
            entries.push({ move, action, reasoning: batch.reasoning, timestamp, ...(results[index] || {}) });
          });
          if (output) transcript.push(output.split("\n").slice(0, 3).join("\n"));
          pending.delete(block.tool_use_id);
        }
      }
    } else if (event.type === "result" && event.result) {
      finalMessage = String(event.result).trim();
    }
  }

  return { entries, transcript: transcript.join("\n\n"), finalMessage };
}

// Kimi Code's stream-json format uses OpenAI-style Assistant/Tool messages.
// Match each MCP action call to its following Tool result so the live page has
// the same per-move reasoning shape as Codex and Claude Code runs.
function distillKimiEvents(raw) {
  const entries = [];
  const transcript = [];
  const pending = new Map();
  let commentary = "";
  let move = 0;
  let finalMessage = "";

  for (const line of String(raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (_error) {
      continue;
    }

    if (event.role === "assistant") {
      const text = toolResultText(event.content).trim();
      if (text) {
        commentary = [commentary, text].filter(Boolean).join("\n\n");
        finalMessage = text;
        transcript.push(`[agent] ${text}`);
      }
      for (const call of Array.isArray(event.tool_calls) ? event.tool_calls : []) {
        const fn = call.function || call;
        const name = fn.name || call.name || "";
        let input = fn.arguments ?? call.arguments ?? call.input ?? {};
        if (typeof input === "string") {
          try {
            input = JSON.parse(input);
          } catch (_error) {
            input = {};
          }
        }
        const actions = actionsFromToolCall(name, input);
        const sequence = isActionSequenceTool(name);
        transcript.push(`[tool] ${name || "mcp"} ${JSON.stringify(input)}`);
        if ((actions.length || sequence) && call.id) {
          pending.set(call.id, {
            actions,
            sequence,
            reasoning: commentary.trim(),
            timestamp: event._mazebench_received_at || event.timestamp || null
          });
          commentary = "";
        }
      }
      continue;
    }

    if (event.role === "tool") {
      const id = event.tool_call_id || event.id;
      const batch = pending.get(id);
      if (!batch) continue;
      const output = toolResultText(event.content ?? event.output ?? event.result);
      const failed = event.is_error === true || event.error;
      if (!failed) {
        const results = resultsFromOutput(output);
        const executed = executedToolActions(batch.actions, results, output, batch.sequence);
        const timestamp = event._mazebench_received_at || event.timestamp || batch.timestamp || null;
        executed.forEach((action, index) => {
          move += 1;
          entries.push({ move, action, reasoning: batch.reasoning, timestamp, ...(results[index] || {}) });
        });
      }
      if (output) transcript.push(`${failed ? "[tool error] " : ""}${output.split("\n").slice(0, 3).join("\n")}`);
      pending.delete(id);
    }
  }

  return { entries, transcript: transcript.join("\n\n"), finalMessage };
}

function writeReasoningArtifacts(config, raw, distilled, options = {}) {
  try {
    // When the caller already streamed agent-events.jsonl live, don't rewrite it.
    if (!options.skipEvents) {
      fs.writeFileSync(
        path.join(config.outDir, "agent-events.jsonl"),
        raw.endsWith("\n") ? raw : `${raw}\n`
      );
    }
    const { entries, transcript, finalMessage } = distilled;
    fs.writeFileSync(path.join(config.outDir, "reasoning.json"), `${JSON.stringify(entries, null, 2)}\n`);
    fs.writeFileSync(
      path.join(config.outDir, "agent.log"),
      `${transcript}${finalMessage ? `\n\n=== final summary ===\n${finalMessage}` : ""}\n`
    );

    console.log("\n=== Agent reasoning (per move) ===");
    for (const entry of entries) {
      const gist = String(entry.reasoning || "").replace(/\s+/g, " ").trim().slice(0, 110);
      const flags = [
        entry.moved === false ? "blocked" : null,
        entry.room_changed ? `→ ${entry.room}` : null,
        entry.gems != null ? `gems ${entry.gems}` : null
      ].filter(Boolean).join(", ");
      console.log(`  ${entry.move}. ${entry.action}${flags ? ` [${flags}]` : ""}${gist ? `\n     ↳ ${gist}` : ""}`);
    }
    if (entries.length === 0) {
      console.log("  (no maze actions detected in the event stream)");
    }
    console.log(`  full log: ${path.join(config.outDir, "reasoning.json")}`);
  } catch (error) {
    console.warn(`Could not capture reasoning log: ${error instanceof Error ? error.message : error}`);
  }
}

function providerFailureFromEvents(raw, provider) {
  const events = String(raw || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch (_error) {
        return [];
      }
    });

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (provider === "claude" && event.type === "result") {
      if (!event.is_error && !event.api_error_status) return null;
      return {
        provider,
        status: Number(event.api_error_status) || null,
        message: String(event.result || event.error || "Claude Code request failed.").trim().slice(0, 500)
      };
    }
    if (provider === "codex" && ["error", "turn.failed"].includes(event.type)) {
      const message = String(event.message || event.error?.message || event.error || "Codex request failed.")
        .trim()
        .slice(0, 500);
      return {
        provider,
        status: Number(event.status || event.status_code) || Number(message.match(/\b([45]\d\d)\b/)?.[1]) || null,
        message
      };
    }
    if (provider === "codex" && ["turn.completed", "thread.started"].includes(event.type)) return null;
    if (provider === "kimi" && event.role === "meta" && /(?:error|failed)/i.test(String(event.type || ""))) {
      return {
        provider,
        status: Number(event.status || event.status_code) || null,
        message: String(event.content || event.message || event.error || "Kimi Code request failed.").trim().slice(0, 500)
      };
    }
    if (provider === "kimi" && ["assistant", "tool"].includes(event.role)) return null;
  }
  return null;
}

function sessionActionCount(sessionFile) {
  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    return Array.isArray(session.actions) ? session.actions.length : 0;
  } catch (_error) {
    return 0;
  }
}

function recordNoMoveIfIdle(config, actionCountBefore) {
  const actionCountAfter = sessionActionCount(config.sessionFile);
  if (actionCountAfter !== actionCountBefore || !fs.existsSync(config.sessionFile)) return false;

  const result = spawnSync(
    process.execPath,
    [HELPER, "record-no-move", "--state", config.sessionFile],
    {
      cwd: ROOT_DIR,
      encoding: "utf8",
      env: { ...process.env, MAZEBENCH_TRUSTED_NO_MOVE: "1" }
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "").trim() || "Could not record a no-move action.");
  }

  let payload;
  try {
    payload = JSON.parse(String(result.stdout || "").trim());
  } catch (_error) {
    throw new Error("The no-move recorder returned an invalid response.");
  }
  if (payload.recorded) {
    console.log("\nNo game action was emitted; recorded a synthetic no move for novelty tracking.");
  }
  return Boolean(payload.recorded);
}

function runAgent(config, prompt) {
  const agent = agentCommand(config, prompt);
  if (config.inContainer && config.model === "codex") {
    assertLocalCodexCommandIsolation(config, agent);
  }
  const { bin, argv, env: commandEnv = {} } = isolatedDockerAgentCommand(config, agent);
  ensureAgentAvailable(bin);

  console.log(`\n=== Launching local ${config.model} agent (${bin}) ===`);
  console.log(`Session: ${config.sessionFile}`);
  console.log(
    `${config.hostAccess ? "Verified native sandbox" : "Docker isolation"} | Tool-use ${config.toolUse.toUpperCase()}${config.swarm ? " + SWARM" : ""} | ` +
      `Mode ${config.mode}${config.mode === "vision" ? ` (${config.visionWidth}x${config.visionHeight})` : ""} | ` +
      `Game ${config.gameId} | Level ${config.levelId} | view ${config.view} | yaw ${config.yaw} | budget ${config.unlimited ? "unlimited" : `${config.moves} moves`}\n`
  );

  // All local agents emit a structured JSONL event stream on stdout. Append it
  // to agent-events.jsonl AS IT
  // ARRIVES so the web UI can distill live per-move reasoning while the agent is
  // still playing. We use synchronous appends (not a buffered WriteStream) so
  // the on-disk file the web UI tails never lags behind — important for Codex,
  // whose events are sparse (one short message per move) and would otherwise
  // sit unflushed in a stream buffer until the very end.
  const distill = config.model === "codex"
    ? distillCodexEvents
    : config.model === "claude"
      ? distillClaudeEvents
      : distillKimiEvents;
  const eventsPath = path.join(config.outDir, "agent-events.jsonl");
  // On a resume we keep the prior run's events and append the new turns, so the
  // reasoning feed shows the whole journey. A fresh run starts the file empty.
  if (!config.resume) {
    fs.writeFileSync(eventsPath, "");
  }
  fs.rmSync(path.join(config.outDir, "provider-failure.json"), { force: true });

  return new Promise((resolve) => {
    const env = isolatedAgentEnvironment(config, commandEnv);
    if (config.model === "claude" && config.mcpEnabled) {
      if (config.swarm && config.modelName) env.CLAUDE_CODE_SUBAGENT_MODEL = config.modelName;
    }
    const cwd = config.mcpEnabled ? config.workspaceDir : ROOT_DIR;
    const child = spawn(bin, argv, { cwd, env, stdio: ["ignore", "pipe", "inherit"] });
    let raw = "";
    let eventBuffer = "";
    let primeInactivityTimer = null;
    let timeoutFailure = null;
    const resetPrimeInactivityTimer = () => {
      if (primeInactivityTimer) clearTimeout(primeInactivityTimer);
      if (config.inference !== "prime") return;
      primeInactivityTimer = setTimeout(() => {
        timeoutFailure = {
          provider: config.model,
          status: null,
          message: "Prime inference produced no Codex events for 90 seconds; the stalled request was terminated."
        };
        console.error(timeoutFailure.message);
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode == null) child.kill("SIGKILL");
        }, 2_000).unref();
      }, 90_000);
      primeInactivityTimer.unref();
    };
    resetPrimeInactivityTimer();

    const appendTimedEvents = (text, flush = false) => {
      eventBuffer += text;
      const lines = eventBuffer.split("\n");
      eventBuffer = flush ? "" : lines.pop() || "";
      if (flush && lines.at(-1) === "") lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let output = line;
        try {
          const event = JSON.parse(line);
          event._mazebench_received_at = new Date().toISOString();
          output = JSON.stringify(event);
        } catch (_error) {
          /* preserve unexpected provider output verbatim */
        }
        fs.appendFileSync(eventsPath, `${output}\n`);
      }
    };

    child.stdout.on("data", (chunk) => {
      resetPrimeInactivityTimer();
      const text = chunk.toString();
      raw += text;
      try {
        appendTimedEvents(text);
      } catch (_error) {
        /* best effort — the final write below still captures everything */
      }
    });
    child.on("error", (error) => {
      if (primeInactivityTimer) clearTimeout(primeInactivityTimer);
      console.error(error instanceof Error ? error.message : String(error));
      resolve({ code: null, failure: { provider: config.model, status: null, message: error.message } });
    });
    child.on("close", (code) => {
      if (primeInactivityTimer) clearTimeout(primeInactivityTimer);
      try {
        appendTimedEvents("", true);
      } catch (_error) {
        /* best effort */
      }
      // On resume, distill the whole file (prior turns + the new ones) so the
      // feed keeps the earlier moves' reasoning too.
      let full = raw;
      if (config.resume) {
        try {
          full = fs.readFileSync(eventsPath, "utf8");
        } catch (_error) {
          full = raw;
        }
      }
      if (full.trim()) writeReasoningArtifacts(config, full, distill(full), { skipEvents: true });
      if (code !== 0) {
        console.warn(`\n(agent exited with status ${code}; continuing to export whatever it played)`);
      }
      resolve({ code, failure: timeoutFailure || providerFailureFromEvents(raw, config.model) });
    });
  });
}

function ensureScorecard(config) {
  if (!fs.existsSync(config.sessionFile)) {
    return { ok: false, reason: "missing-session" };
  }
  // Finalizing replays the whole saved history, so the ceiling has to grow with
  // it rather than stay a flat 30s that long unlimited runs silently blow past.
  const actionCount = sessionActionCount(config.sessionFile);
  const timeout = Math.min(600000, 60000 + actionCount * 20);
  // Scoring runs only after the provider process has exited.
  const result = spawnSync(process.execPath, [HELPER, "finalize", "--state", config.sessionFile], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    env: { ...process.env, MAZEBENCH_TRUSTED_FINALIZE: "1" },
    timeout,
    killSignal: "SIGKILL"
  });
  if (result.status !== 0) {
    // A SIGKILL from the timeout leaves no stderr and a null status; say so
    // rather than reporting an empty reason.
    const detail = (result.stderr || "").trim() ||
      (result.signal ? `finalize timed out after ${Math.round(timeout / 1000)}s (${result.signal})` : "") ||
      `finalize exited ${result.status}`;
    console.warn(`Could not finalize scorecard: ${detail}`);
    return { ok: false, reason: "finalize-failed", detail };
  }
  return { ok: true };
}

function exportReplay(config) {
  const argv = [EXPORT_REPLAY, config.outDir];
  if (config.video) {
    if (config.fast) argv.push("--fast");
    if (config.draft) argv.push("--draft");
    if (config.width) argv.push("--width", String(config.width));
    if (config.height) argv.push("--height", String(config.height));
    if (config.fps) argv.push("--fps", String(config.fps));
  } else {
    argv.push("--no-video");
  }

  console.log(`\n=== Exporting artifacts${config.video ? " + replay video" : ""} ===`);
  const result = spawnSync(process.execPath, argv, { cwd: ROOT_DIR, stdio: "inherit" });
  if (result.status !== 0) {
    console.warn(
      "\nReplay export failed. The session JSON is still saved; you can retry with:\n" +
        `  node scripts/maze-export-replay.js ${config.outDir}`
    );
    return false;
  }
  return true;
}

function expandTilde(value) {
  const text = String(value || "");
  return text.startsWith("~") ? path.join(process.env.HOME || "", text.slice(1)) : text;
}

function readPrimeCredential(filePath) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    throw new Error("Prime credentials are unavailable. Run `prime login`, then retry.");
  }
  const apiKey = String(value?.api_key || "").trim();
  const inferenceUrl = String(value?.inference_url || "https://api.pinference.ai/api/v1")
    .trim()
    .replace(/\/+$/, "");
  if (!apiKey || !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/.test(inferenceUrl)) {
    throw new Error("Prime credentials are incomplete. Run `prime login`, then retry.");
  }
  return { api_key: apiKey, inference_url: inferenceUrl };
}

// Claude Code stores a subscription login in the macOS Keychain (service
// "Claude Code-credentials"), not a file. These read it so we can mount it.
function claudeKeychainAvailable() {
  if (process.platform !== "darwin") return false;
  const probe = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], {
    encoding: "utf8"
  });
  return probe.status === 0;
}

function extractClaudeKeychainCredential() {
  const result = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
    encoding: "utf8"
  });
  if (result.status !== 0) return null;
  const out = String(result.stdout || "").trim();
  return out.startsWith("{") ? out : null;
}

// Read the Codex model catalog (with per-model reasoning levels + fast-tier
// availability) that the Codex app caches on the host.
function loadCodexModels() {
  try {
    const cache = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME || "", ".codex", "models_cache.json"), "utf8")
    );
    return (Array.isArray(cache.models) ? cache.models : [])
      .filter((m) => m && (m.slug || m.id))
      .map((m) => ({
        slug: String(m.slug || m.id),
        displayName: String(m.display_name || m.slug || m.id),
        description: String(m.description || "").replace(/\s+/g, " ").slice(0, 56),
        defaultReasoning: String(m.default_reasoning_level || ""),
        reasoningLevels: Array.isArray(m.supported_reasoning_levels)
          ? m.supported_reasoning_levels
              .filter((l) => l && l.effort)
              .map((l) => ({ effort: String(l.effort), description: String(l.description || "") }))
          : [],
        fast:
          (Array.isArray(m.additional_speed_tiers) && m.additional_speed_tiers.includes("fast")) ||
          (Array.isArray(m.service_tiers) &&
            m.service_tiers.some((t) => /fast|priority/i.test(String((t && (t.id || t.name)) || ""))))
      }));
  } catch (_error) {
    return [];
  }
}

const CONTAINER_RUNTIME_MOUNTS = Object.freeze([
  ["scripts", "/app/scripts"],
  ["server", "/app/server"],
  ["public", "/app/public"],
  [path.join("games", "maze"), "/app/games/maze"]
]);

function containerRuntimeMountArgs(rootDir) {
  return CONTAINER_RUNTIME_MOUNTS.flatMap(([source, destination]) => [
    "-v",
    `${path.join(rootDir, source)}:${destination}:ro`
  ]);
}

// Re-exec this runner inside a container so the agent remains isolated from the
// host filesystem. The output directory is writable; the small maze runtime
// surface is mounted read-only so every newly launched run or branch uses the
// currently installed gameplay, ASCII, and JSON implementation instead of a
// potentially stale copy baked into the agent image.
function runInContainer(config, raw) {
  if (!SUPPORTED_LOCAL_AGENT_VERSIONS[config.model] ||
      !["read-only", "offline"].includes(config.toolUse) ||
      config.tools !== (config.toolUse === "offline") || config.swarm) {
    throw new Error(RETIRED_LOCAL_AGENT_MESSAGE);
  }
  const hostRunDir = config.outDir;
  const hostWorkspaceRoot = path.dirname(config.workspaceDir);
  const cidFile = path.join(config.outDir, "container.cid");

  // Docker writes the exact container id here as soon as it creates the
  // container. The Agent backend uses it for real docker pause/unpause/stop
  // operations instead of merely freezing the attached docker client.
  fs.mkdirSync(config.outDir, { recursive: true });
  fs.rmSync(path.join(config.outDir, "cold-pause-capability.json"), { force: true });
  try {
    fs.unlinkSync(cidFile);
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }

  // Forward the meaningful options to the in-container runner. The exact run
  // directory and its otherwise empty model workspace are mounted separately;
  // no repository output root or prior-run directory crosses the boundary.
  const forwardKeys = [
    "model", "inference", "moves", "unlimited", "allow_quit", "mode", "omniscient", "hide_names", "hide_names_seed", "tools", "tool_use", "auto_run_tools", "auto_run_all_frames", "swarm", "max_swarm_workers", "game", "level", "view", "yaw", "gems",
    "video", "no_video", "fast", "draft", "width", "height", "fps",
    "vision_width", "vision_height", "vision_view", "model_name", "llm",
    "reasoning", "effort", "codex_fast", "resume", "seed", "fork_session", "session_id",
    "preflight_only"
  ];
  const inner = ["node", "scripts/maze-agent-local.js", "container=false"];
  for (const key of forwardKeys) {
    if (raw[key] !== undefined) inner.push(`${key}=${raw[key]}`);
  }
  inner.push("out=/run/mazebench-output", "workspace_root=/run/mazebench-workspace");

  const credentialMounts = [];
  const credentialEnvironment = [];
  let temporaryCredentialDir = "";
  if (config.model === "codex") {
    if (config.inference === "prime") {
      const source = raw.prime_auth
        ? path.resolve(expandTilde(raw.prime_auth))
        : path.join(process.env.HOME || "", ".prime", "config.json");
      const prime = readPrimeCredential(source);
      temporaryCredentialDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-prime-auth-"));
      const primeConfigPath = path.join(temporaryCredentialDir, "config.json");
      fs.writeFileSync(primeConfigPath, `${JSON.stringify(prime)}\n`, { mode: 0o600 });
      credentialEnvironment.push("-e", "MAZEBENCH_PRIME_CONFIG_FILE=/run/mazebench-credentials/prime-config.json");
      credentialMounts.push("-v", `${primeConfigPath}:/run/mazebench-credentials/prime-config.json:ro`);
    } else {
      const authPath = raw.codex_auth
        ? (() => {
            const requested = path.resolve(expandTilde(raw.codex_auth));
            return fs.existsSync(requested) && fs.statSync(requested).isDirectory()
              ? path.join(requested, "auth.json")
              : requested;
          })()
        : path.join(process.env.HOME || "", ".codex", "auth.json");
      if (!fs.existsSync(authPath) || !fs.statSync(authPath).isFile()) {
        throw new Error("Codex subscription credentials are unavailable. Run `codex login`, then retry.");
      }
      credentialEnvironment.push("-e", "MAZEBENCH_CODEX_AUTH_FILE=/run/mazebench-credentials/codex-auth.json");
      credentialMounts.push("-v", `${authPath}:/run/mazebench-credentials/codex-auth.json:ro`);
    }
  } else if (config.model === "claude") {
    let authPath = "";
    if (raw.claude_auth) {
      const requested = path.resolve(expandTilde(raw.claude_auth));
      authPath = fs.existsSync(requested) && fs.statSync(requested).isDirectory()
        ? path.join(requested, ".credentials.json")
        : requested;
    } else {
      const fileCredential = path.join(process.env.HOME || "", ".claude", ".credentials.json");
      if (fs.existsSync(fileCredential) && fs.statSync(fileCredential).isFile()) {
        authPath = fileCredential;
      } else if (claudeKeychainAvailable()) {
        const credential = extractClaudeKeychainCredential();
        if (credential) {
          temporaryCredentialDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-claude-auth-"));
          authPath = path.join(temporaryCredentialDir, "credentials.json");
          fs.writeFileSync(authPath, credential, { mode: 0o600 });
        }
      }
    }
    if (!authPath || !fs.existsSync(authPath) || !fs.statSync(authPath).isFile()) {
      throw new Error("Claude Code subscription credentials are unavailable. Run `claude auth login`, then retry.");
    }
    credentialEnvironment.push("-e", "MAZEBENCH_CLAUDE_AUTH_FILE=/run/mazebench-credentials/claude-credentials.json");
    credentialMounts.push("-v", `${authPath}:/run/mazebench-credentials/claude-credentials.json:ro`);
  } else {
    const requested = raw.kimi_auth
      ? path.resolve(expandTilde(raw.kimi_auth))
      : path.resolve(process.env.KIMI_CODE_HOME || path.join(process.env.HOME || "", ".kimi-code"));
    const kimiHome = fs.existsSync(requested) && fs.statSync(requested).isDirectory()
      ? requested
      : path.dirname(requested);
    const configPath = fs.existsSync(requested) && fs.statSync(requested).isDirectory()
      ? path.join(requested, "config.toml")
      : requested;
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
      throw new Error("Kimi Code account configuration is unavailable. Run `kimi login`, then retry.");
    }
    credentialEnvironment.push("-e", "MAZEBENCH_KIMI_CONFIG_FILE=/run/mazebench-credentials/kimi-config.toml");
    credentialMounts.push("-v", `${configPath}:/run/mazebench-credentials/kimi-config.toml:ro`);
    const credentialsDir = path.join(kimiHome, "credentials");
    if (fs.existsSync(credentialsDir) && fs.statSync(credentialsDir).isDirectory()) {
      credentialEnvironment.push("-e", "MAZEBENCH_KIMI_CREDENTIALS_DIR=/run/mazebench-credentials/kimi-credentials");
      credentialMounts.push("-v", `${credentialsDir}:/run/mazebench-credentials/kimi-credentials:ro`);
    }
    const deviceId = path.join(kimiHome, "device_id");
    if (fs.existsSync(deviceId) && fs.statSync(deviceId).isFile()) {
      credentialEnvironment.push("-e", "MAZEBENCH_KIMI_DEVICE_ID_FILE=/run/mazebench-credentials/kimi-device-id");
      credentialMounts.push("-v", `${deviceId}:/run/mazebench-credentials/kimi-device-id:ro`);
    }
  }

  const dockerArgs = [
    "run", "--rm", "-i", "--cidfile", cidFile,
    "--user", "root",
    "--read-only",
    "--pids-limit", "512",
    "--memory", "4g",
    "--cpus", "2",
    "--cap-drop", "ALL",
    "--cap-add", "SYS_ADMIN",
    "--cap-add", "SETUID",
    "--cap-add", "SETGID",
    "--cap-add", "SETPCAP",
    "--cap-add", "CHOWN",
    "--cap-add", "DAC_OVERRIDE",
    "--security-opt", "seccomp=unconfined",
    "--security-opt", "apparmor=unconfined",
    "-e", "MAZEBENCH_IN_CONTAINER=1",
    ...credentialEnvironment,
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g",
    "-v", `${hostRunDir}:/run/mazebench-output`,
    "-v", `${hostWorkspaceRoot}:/run/mazebench-workspace`,
    ...credentialMounts,
    ...containerRuntimeMountArgs(ROOT_DIR)
  ];
  // Draft/online worlds are not baked into the image — mount the game dir
  // read-only. Its images/assets_3d symlinks resolve against the in-image
  // /app/games/maze copy.
  if (config.gameId !== "maze") {
    const gameDir = path.join(ROOT_DIR, "games", config.gameId);
    if (!fs.existsSync(gameDir)) {
      console.error(`Game directory not found: ${gameDir}`);
      return 1;
    }
    dockerArgs.push("-v", `${gameDir}:/app/games/${config.gameId}:ro`);
  }
  dockerArgs.push(config.image, ...inner);

  if (isTruthy(raw.dry_run, false)) {
    console.log(`# would run in container (${config.image}):`);
    console.log([config.dockerBin, ...dockerArgs].join(" "));
    console.log(`\n# host artifacts would appear under: ${hostRunDir}`);
    if (temporaryCredentialDir) fs.rmSync(temporaryCredentialDir, { recursive: true, force: true });
    return 0;
  }

  const dockerProbe = spawnSync("sh", ["-c", `command -v ${JSON.stringify(config.dockerBin)}`], {
    encoding: "utf8"
  });
  if (dockerProbe.status !== 0) {
    console.error(
      `Container runtime not found: ${config.dockerBin}\n` +
        "Install and start Docker; local host execution is intentionally unavailable."
    );
    return 1;
  }
  fs.mkdirSync(hostRunDir, { recursive: true });
  fs.mkdirSync(hostWorkspaceRoot, { recursive: true });

  console.log(`\n=== Running in container: ${config.image} ===`);
  console.log(`Only this run directory and its fresh model workspace are mounted writable.`);
  console.log(`The evaluated ${config.model} process cannot see the mounted MazeBench runtime or run artifacts.`);

  const result = spawnSync(config.dockerBin, dockerArgs, { cwd: ROOT_DIR, stdio: "inherit" });
  if (temporaryCredentialDir) fs.rmSync(temporaryCredentialDir, { recursive: true, force: true });
  if (result.error) {
    console.error(
      `\nFailed to launch container: ${result.error.message}\n` +
        `Is the image built? Run: npm run maze:build-local-agents`
    );
    return 1;
  }
  if (result.status !== 0) {
    console.error(
      `\nContainer exited with status ${result.status}. If the image is missing, build it:\n` +
        `  npm run maze:build-local-agents`
    );
  }
  return result.status || 0;
}

// Arrow-key single-select prompt (↑/↓ + Enter). Resolves to the chosen value.
function promptSelect(title, options) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (!stdin.isTTY) {
      reject(new Error("interactive setup needs a terminal (TTY)"));
      return;
    }
    let index = 0;

    function render(first) {
      if (!first) stdout.write(`[${options.length + 1}A`);
      stdout.write("[0J");
      stdout.write(`? [1m${title}[0m\n`);
      options.forEach((option, i) => {
        const selected = i === index;
        const pointer = selected ? "[36m❯[0m" : " ";
        const label = selected ? `[36m${option.label}[0m` : option.label;
        const hint = option.hint ? ` [90m— ${option.hint}[0m` : "";
        stdout.write(`${pointer} ${label}${hint}\n`);
      });
    }

    const wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    render(true);

    function cleanup() {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    }

    function onData(key) {
      if (key === "") {
        cleanup();
        stdout.write("\n");
        process.exit(130);
      } else if (key === "\r" || key === "\n") {
        cleanup();
        resolve(options[index].value);
      } else if (key === "[A" || key === "OA" || key === "k") {
        index = (index - 1 + options.length) % options.length;
        render(false);
      } else if (key === "[B" || key === "OB" || key === "j") {
        index = (index + 1) % options.length;
        render(false);
      }
    }

    stdin.on("data", onData);
  });
}

function promptText(title, defaultValue) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    rl.question(`? [1m${title}[0m${suffix}: `, (answer) => {
      rl.close();
      resolve(String(answer || "").trim() || defaultValue || "");
    });
  });
}

async function runWizard(raw) {
  const out = { ...raw };
  console.log("\n=== MazeBench setup ===");
  console.log("↑/↓ to move, Enter to select.\n");

  out.model = await promptSelect("Which agent?", [
    { label: "Codex CLI", value: "codex", hint: "uses your OpenAI/ChatGPT login" },
    { label: "Claude Code", value: "claude", hint: "uses your Claude subscription" },
    { label: "Kimi Code", value: "kimi", hint: "uses your configured Kimi account" }
  ]);

  const topModel = await promptSelect("Which model?", [
    { label: "Default", value: "__default__", hint: out.model === "codex" ? "codex default" : "account default" },
    { label: "Custom…", value: "__custom__", hint: "pick from the full list" }
  ]);
  let selectedModelInfo = null;
  delete out.model_name;
  if (topModel === "__custom__") {
    let modelInfos = [];
    let listOptions;
    if (out.model === "codex") {
      modelInfos = loadCodexModels();
      listOptions = modelInfos.map((m) => ({ label: m.displayName, value: m.slug, hint: m.description }));
    } else if (out.model === "claude") {
      listOptions = [
        { label: "Opus", value: "opus" },
        { label: "Sonnet", value: "sonnet" },
        { label: "Haiku", value: "haiku" }
      ];
    } else {
      const result = spawnSync(out.kimi_bin || "kimi", ["provider", "list", "--json"], {
        encoding: "utf8",
        timeout: 5000
      });
      try {
        const payload = JSON.parse(String(result.stdout || "{}"));
        listOptions = Object.entries(payload.models || {}).map(([id, model]) => ({
          label: String(model?.displayName || id),
          value: id,
          hint: String(model?.model || "")
        }));
      } catch (_error) {
        listOptions = [];
      }
    }
    listOptions.push({ label: "Type an id manually…", value: "__type__" });
    let picked = await promptSelect("Choose a model", listOptions);
    if (picked === "__type__") {
      picked = await promptText("Model id", out.model === "claude" ? "opus" : out.model === "kimi" ? "kimi/k3" : "gpt-5.5");
    } else if (out.model === "codex") {
      selectedModelInfo = modelInfos.find((m) => m.slug === picked) || null;
    }
    if (picked) out.model_name = picked;
  }

  // Codex-specific: reasoning effort, then Fast mode.
  if (out.model === "codex") {
    const levels = (selectedModelInfo && selectedModelInfo.reasoningLevels.length)
      ? selectedModelInfo.reasoningLevels.map((l) => ({ label: l.effort, value: l.effort, hint: l.description }))
      : [
          { label: "low", value: "low" },
          { label: "medium", value: "medium" },
          { label: "high", value: "high" },
          { label: "xhigh", value: "xhigh" }
        ];
    const effort = await promptSelect("Reasoning effort?", [
      { label: "Default", value: "", hint: selectedModelInfo && selectedModelInfo.defaultReasoning ? `model default (${selectedModelInfo.defaultReasoning})` : "model default" },
      ...levels
    ]);
    if (effort) out.reasoning = effort;
    else delete out.reasoning;

    if (!selectedModelInfo || selectedModelInfo.fast) {
      out.codex_fast = await promptSelect("Fast mode? (priority tier, ~1.5x speed)", [
        { label: "No", value: "false" },
        { label: "Yes", value: "true" }
      ]);
    }
  } else if (out.model === "kimi") {
    out.reasoning = await promptSelect("Reasoning effort?", [
      { label: "low", value: "low" },
      { label: "high", value: "high" },
      { label: "max", value: "max" }
    ]);
  }

  let moves = await promptSelect("Action budget (moves)?", [
    { label: "5", value: "5" },
    { label: "10", value: "10" },
    { label: "20", value: "20" },
    { label: "50", value: "50" },
    { label: "Unlimited", value: "__unlimited__" },
    { label: "Custom…", value: "__custom__" }
  ]);
  if (moves === "__unlimited__") {
    out.unlimited = "true";
    moves = "500";
  }
  if (moves === "__custom__") moves = await promptText("Number of moves", "10");
  out.moves = moves;

  out.mode = await promptSelect("Observation mode?", [
    { label: "ASCII", value: "text", hint: "text grid" },
    { label: "JSON", value: "json", hint: "structured room objects" },
    { label: "Vision", value: "vision", hint: "rendered images (slower)" }
  ]);

  if (out.mode === "json") {
    out.omniscient = await promptSelect("JSON visibility?", [
      { label: "Visible only", value: "false", hint: "camera occlusion applies" },
      { label: "Omniscient", value: "true", hint: "all room objects" }
    ]);
  }
  if (out.mode === "json" || out.mode === "text") {
    out.hide_names = await promptSelect(out.mode === "json" ? "JSON object names?" : "ASCII glyph identities?", [
      { label: "Normal", value: "false", hint: "literal type names" },
      { label: "Hidden", value: "true", hint: out.mode === "json" ? "stable random letters" : "stable random glyphs; P/G unchanged" }
    ]);
    if (out.hide_names === "true") {
      out.hide_names_seed = await promptText("Identity seed", "1");
    }
  }

  out.container = "true";

  out.tool_use = await promptSelect("Tool use?", [
    { label: "No Tools", value: "read-only", hint: "game controls only; no files, shell, web, memory, or workers" },
    { label: "[PY] Tools", value: "offline", hint: "isolated Python scratchpad; no host files or network" }
  ]);
  out.tools = out.tool_use === "offline" ? "true" : "false";
  out.swarm = "false";

  out.video = await promptSelect("Render replay video?", [
    { label: "Yes", value: "on" },
    { label: "No", value: "off" }
  ]);

  console.log("\n=== Summary ===");
  console.log(
    `  model=${out.model}` +
      `${out.model_name ? ` model_name=${out.model_name}` : ""}` +
      `${out.reasoning ? ` reasoning=${out.reasoning}` : ""}` +
      `${isTruthy(out.codex_fast, false) ? " fast=on" : ""}` +
      ` moves=${out.moves} mode=${out.mode} tool_use=${out.tool_use}` +
      ` swarm=${out.swarm} container=${out.container} video=${out.video}\n`
  );
  const proceed = await promptSelect("Proceed?", [
    { label: "Run it", value: "go" },
    { label: "Cancel", value: "cancel" }
  ]);
  if (proceed !== "go") {
    console.log("Cancelled.");
    process.exit(0);
  }
  console.log("");
  return out;
}

async function localCodexMain() {
  const { raw: parsedRaw, passthrough } = parseArgs(process.argv.slice(2));
  let raw = parsedRaw;

  const wantWizard =
    isTruthy(raw.wizard, false) ||
    passthrough.includes("wizard") ||
    passthrough.includes("setup") ||
    (Object.keys(raw).length === 0 && passthrough.length === 0);
  if (wantWizard) {
    if (!process.stdin.isTTY) {
      console.error("The interactive setup needs a terminal. Pass parameters directly instead, e.g. model=codex moves=5.");
      process.exit(2);
    }
    raw = await runWizard(raw);
  }

  const model = String(raw.model || "").toLowerCase();

  if (!SUPPORTED_LOCAL_AGENT_VERSIONS[model]) {
    console.error("Usage: node scripts/maze-agent-local.js --model codex|claude|kimi [moves=N level=HxI ...]");
    process.exit(2);
  }
  const inference = String(raw.inference || "subscription").trim().toLowerCase();
  if (!["subscription", "prime"].includes(inference) || (inference === "prime" && model !== "codex")) {
    throw new Error("Prime inference is supported only by the isolated Codex runner.");
  }
  if ((raw.image && raw.image !== "mazebench-agent") ||
      (raw.docker_bin && raw.docker_bin !== "docker") ||
      (raw.codex_bin && raw.codex_bin !== "codex") ||
      (raw.claude_bin && raw.claude_bin !== "claude") ||
      (raw.kimi_bin && raw.kimi_bin !== "kimi")) {
    throw new Error("Local agents use the pinned mazebench-agent image and its bundled provider CLIs.");
  }

  const view = VIEW_NAMES.includes(String(raw.view)) ? String(raw.view) : "top-diagonal";
  const outDir = raw.session
    ? path.dirname(path.resolve(raw.session))
    : path.resolve(raw.out || path.join(ROOT_DIR, "outputs", "maze-local", model, timestampSlug()));
  const sessionFile = raw.session ? path.resolve(raw.session) : path.join(outDir, "session.json");
  const inContainer = process.env.MAZEBENCH_IN_CONTAINER === "1";
  const wantsContainer = isTruthy(raw.container, true);
  const requestedTools = isTruthy(raw.tools, false);
  const requestedToolUse = String(raw.tool_use || (requestedTools ? "offline" : "read-only")).trim().toLowerCase();
  if (!["read-only", "offline"].includes(requestedToolUse) ||
      requestedTools !== (requestedToolUse === "offline") || isTruthy(raw.swarm, false)) {
    throw new Error("Local agents expose only the game controls and optional isolated Python; shell, host files, web, and workers remain disabled.");
  }
  if (!wantsContainer && !inContainer) {
    throw new Error("Local agents cannot run on the host. The disposable Docker boundary is mandatory.");
  }
  const toolUse = requestedToolUse;
  const autoRunTools = toolUse === "offline" && isTruthy(raw.auto_run_tools, true);
  const autoRunAllFrames = autoRunTools && isTruthy(raw.auto_run_all_frames, false);
  const swarm = false;
  const unlimited = isTruthy(raw.unlimited, false);
  const hostAccess = false;
  const agentHomeStat = inContainer ? fs.statSync("/home/pwuser") : null;
  let workspaceIdentity = outDir;
  try {
    // Match the run-page lookup when an ancestor such as outputs/ is symlinked
    // from a temporary merged checkout into the canonical repository.
    workspaceIdentity = fs.realpathSync(outDir);
  } catch (_error) {
    /* direct CLI launches may not have created outDir yet */
  }
  const workspaceKey = crypto.createHash("sha256").update(workspaceIdentity).digest("hex").slice(0, 24);
  const workspaceRoot = raw.workspace_root
    ? path.resolve(String(raw.workspace_root))
    : path.join(os.tmpdir(), "mazebench-agent-workspaces", workspaceKey);
  const workspaceDir = path.join(workspaceRoot, "workspace");
  const swarmDir = path.join(outDir, "swarm");
  const swarmWorkspaceDir = path.join(workspaceRoot, "swarm-workspaces");
  const codexRuntimeDir = path.join(outDir, ".codex-runtime");
  const pythonSandboxStateDir = path.join(outDir, ".python-sandbox");
  const kimiRuntimeDir = path.join(outDir, "agent-state", "kimi");
  const kimiSkillsDir = path.join(kimiRuntimeDir, "empty-skills");
  const primeCredential = inference === "prime"
    ? readPrimeCredential(
        inContainer
          ? process.env.MAZEBENCH_PRIME_CONFIG_FILE || "/run/mazebench-credentials/prime-config.json"
          : raw.prime_auth
            ? path.resolve(expandTilde(raw.prime_auth))
            : path.join(process.env.HOME || "", ".prime", "config.json")
      )
    : null;

  const requestedMode = String(raw.mode || raw.observation || "text").toLowerCase();
  const mode = ["json", "vision"].includes(requestedMode) ? requestedMode : "text";
  const config = {
    claudeBin: raw.claude_bin || "claude",
    claudeAllowedTools: raw.claude_allowed_tools || "",
    codexBin: raw.codex_bin || "codex",
    kimiBin: raw.kimi_bin || "kimi",
    kimiAuthDir: raw.kimi_auth ? path.resolve(expandTilde(raw.kimi_auth)) : "",
    pythonBin: raw.python_bin || "",
    container: wantsContainer,
    dockerBin: raw.docker_bin || "docker",
    image: raw.image || "mazebench-agent",
    draft: isTruthy(raw.draft, false),
    fast: isTruthy(raw.fast, false),
    fps: raw.fps ? positiveInt(raw.fps, undefined) : undefined,
    gameId: normalizeGameId(raw.game),
    gems: 100,
    height: raw.height ? positiveInt(raw.height, undefined) : undefined,
    levelId: normalizeLevelId(raw.level),
    mode,
    omniscient: mode === "json" && isTruthy(raw.omniscient, false),
    hideNames: mode !== "vision" && isTruthy(raw.hide_names, false),
    hideNamesSeed: mode !== "vision" && isTruthy(raw.hide_names, false)
      ? String(raw.hide_names_seed || "").trim().slice(0, 128) || "1"
      : "",
    tools: toolUse !== "read-only",
    toolUse,
    autoRunTools,
    autoRunAllFrames,
    swarm,
    maxSwarmWorkers: Math.min(
      32,
      positiveInt(raw.max_swarm_workers, DEFAULT_MAX_SWARM_WORKERS)
    ),
    hostAccess,
    inContainer,
    agentUid: agentHomeStat?.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
    agentGid: agentHomeStat?.gid ?? (typeof process.getgid === "function" ? process.getgid() : 0),
    model,
    inference,
    primeInferenceUrl: primeCredential?.inference_url || "",
    modelName: raw.model_name || raw.llm || "",
    reasoning: String(raw.reasoning || raw.effort || "").toLowerCase(),
    codexFast: isTruthy(raw.codex_fast, false),
    moves: unlimited ? null : positiveInt(raw.moves, 20),
    unlimited,
    allowQuit: isTruthy(raw.allow_quit, true),
    outDir,
    workspaceDir,
    swarmDir,
    swarmWorkspaceDir,
    codexRuntimeDir,
    kimiRuntimeDir,
    kimiSkillsDir,
    pythonSandboxStateDir,
    agentWorkspaceDir: inContainer ? "/app/workspace" : workspaceDir,
    agentSwarmWorkspaceDir: inContainer ? "/app/swarm-workspaces" : swarmWorkspaceDir,
    agentCodexRuntimeDir: inContainer ? "/home/pwuser/.codex/maze-runtime" : codexRuntimeDir,
    agentKimiRuntimeDir: inContainer ? "/home/pwuser/.kimi-code" : kimiRuntimeDir,
    agentKimiSkillsDir: inContainer ? "/home/pwuser/.kimi-code/empty-skills" : kimiSkillsDir,
    agentKimiProfile: inContainer ? "/home/pwuser/.kimi-code/mazebench-agent.md" : path.join(kimiRuntimeDir, "mazebench-agent.md"),
    // The outer Docker launcher re-execs before starting an agent. Actual host
    // and in-container agents both use MCP so maze persistence stays outside
    // their file/tool sandbox.
    mcpEnabled: !wantsContainer || inContainer,
    // Provider conversation state and game state are independent. A valid
    // session.json alone permits observing an existing game. `resume` may be
    // present without one when a provider stalled before its first maze_start;
    // that case must resume the transcript but cold-start the game.
    resume: String(raw.resume || "").trim(),
    forkSession: isTruthy(raw.fork_session, false),
    sessionId: String(raw.session_id || "").trim(),
    seed: hasResumableGameSession(sessionFile),
    sessionFile,
    video: isTruthy(raw.video, true) && !isTruthy(raw.no_video, false),
    view,
    visionHeight: positiveInt(raw.vision_height, 512),
    // 1-26 rings or "world"; empty = codex-play's default (1 = classic 3x3).
    visionView: String(raw.vision_view || "").trim().toLowerCase(),
    visionWidth: positiveInt(raw.vision_width, 512),
    width: raw.width ? positiveInt(raw.width, undefined) : undefined,
    yaw: ((positiveInt(raw.yaw, 0) % 4) + 4) % 4
  };

  // The outer launcher re-execs once inside Docker. `container=false` is
  // accepted only for that trusted in-container re-exec.
  if (config.container && !inContainer) {
    process.exit(runInContainer(config, raw));
  }
  if (!inContainer) {
    throw new Error("Local agents cannot run on the host. The disposable Docker boundary is mandatory.");
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(path.join(outDir, "cold-pause-capability.json"), { force: true });
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  fs.mkdirSync(config.swarmDir, { recursive: true });
  fs.mkdirSync(config.swarmWorkspaceDir, { recursive: true });
  migrateSeedSessionObservation(config);
  prepareAgentRuntime(config);
  if (!isTruthy(raw.dry_run, false)) {
    const isolation = localAgentIsolationPreflight(config);
    console.log(
      `Local ${config.model} isolation verified (${isolation.provider_version}): repository, run output, credential source, ` +
      "host files, shell, web, file tools, apps, and workers are unavailable."
    );
    const toolIsolation = verifyToolIsolation(config);
    if (toolIsolation) {
      console.log("Local Python isolation verified: scratch writes allowed; repository/host reads, subprocesses, and network blocked.");
    }
    if (isTruthy(raw.preflight_only, false)) return;
  }
  const privateMcp = needsPrivateMcpServer(config)
    ? await startPrivateMcpServer(config)
    : null;
  const prompt = buildPrompt(config);

  if (isTruthy(raw.dry_run, false)) {
    const { bin, argv } = agentCommand(config, prompt);
    const shown = argv.map((arg) => (arg === prompt ? '"<prompt>"' : arg));
    console.log(`# would launch (${config.model}):`);
    console.log([bin, ...shown].join(" "));
    console.log(`# with <prompt>:\n${prompt}`);
    console.log(`\n# artifacts would land in: ${config.outDir}`);
    privateMcp?.stop();
    return;
  }

  try {
    const actionCountBefore = sessionActionCount(config.sessionFile);
    const agentResult = await runAgent(config, prompt);
    if (agentResult?.failure || agentResult?.code !== 0) {
      const failure = agentResult.failure || {
        provider: config.model,
        status: null,
        message: `${config.model} exited with status ${agentResult?.code ?? "unknown"}.`
      };
      fs.writeFileSync(
        path.join(config.outDir, "provider-failure.json"),
        `${JSON.stringify({ ...failure, detected_at: new Date().toISOString() }, null, 2)}\n`
      );
      console.warn(`Provider unavailable; preserving the maze and provider thread for retry: ${failure.message}`);
      process.exitCode = 75;
      return;
    }
    recordNoMoveIfIdle(config, actionCountBefore);
  } finally {
    privateMcp?.stop();
  }

  const finalized = ensureScorecard(config);
  if (!finalized.ok) {
    if (finalized.reason === "missing-session") {
      console.error(
        `\nNo session was written at ${config.sessionFile}. The agent likely never ran the ` +
          "start command. Nothing to export."
      );
      process.exit(1);
    }
    // The session exists and the moves are saved — only scoring failed. Exiting
    // non-zero here would strand a resumable run, because the server only
    // auto-continues on a clean exit.
    console.error(
      `\nScorecard could not be finalized (${finalized.detail}); the session and its ` +
        `${sessionActionCount(config.sessionFile)} saved actions are intact at ${config.sessionFile}.`
    );
  }

  // Signal the rendering phase so the web UI can show a replay progress bar
  // (maze-export-replay.js updates replay-progress.json as it works).
  if (config.video) {
    try {
      fs.writeFileSync(
        path.join(config.outDir, "replay-progress.json"),
        `${JSON.stringify({ phase: "starting", percent: 0 })}\n`
      );
    } catch (_error) {
      /* best effort */
    }
  }

  exportReplay(config);

  console.log("\n=== Done ===");
  console.log(`Run directory: ${config.outDir}`);
  console.log(`  session.json      full state + per-action replay`);
  console.log(`  actions.jsonl     per-turn action log`);
  console.log(`  scorecard.json    gems / rooms / actions`);
  console.log(`  maze_scorecard.json + maze_actions.txt`);
  console.log(`  reasoning.json    [{move, action, reasoning, ...}] per move`);
  console.log(`  agent.log         human-readable agent transcript`);
  console.log(`  agent-events.jsonl raw agent event stream`);
  if (config.video) {
    console.log(`  maze_replay.mp4   replay video`);
  }
}

async function main() {
  return localCodexMain();
}

module.exports = {
  RETIRED_LOCAL_AGENT_MESSAGE,
  SUPPORTED_LOCAL_AGENT_VERSIONS,
  SUPPORTED_LOCAL_CLAUDE_VERSION,
  SUPPORTED_LOCAL_CODEX_VERSION,
  SUPPORTED_LOCAL_KIMI_VERSION,
  actionFromShellCommand,
  agentCommand,
  assertLocalAgentCommandIsolation,
  assertLocalClaudeCommandIsolation,
  assertLocalCodexCommandIsolation,
  assertLocalKimiCommandIsolation,
  actionsFromShellCommand,
  actionsFromToolCall,
  buildMcpPrompt,
  claudeSandboxSettings,
  codexMcpConfigArgs,
  containerRuntimeMountArgs,
  distillClaudeEvents,
  distillCodexEvents,
  distillKimiEvents,
  hasResumableGameSession,
  kimiAllowedTools,
  kimiAgentProfile,
  kimiMcpConfig,
  loadCodexModels,
  localAgentIsolationPreflight,
  localCodexIsolationPreflight,
  migrateSeedSessionObservation,
  needsPrivateMcpServer,
  providerFailureFromEvents,
  recordNoMoveIfIdle,
  resultFromOutput,
  resultsFromOutput,
  sanitizeKimiConfig
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
