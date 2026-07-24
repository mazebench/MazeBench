#!/usr/bin/env node

// Drive MazeBench with a LOCAL coding agent (Codex CLI, Claude Code, or Kimi Code) instead
// of Prime Intellect Verifiers. The agent plays the maze by shelling out to
// scripts/codex-play.js (a stateful CLI over scripts/maze-bridge.js). When the
// agent is done we make sure a scorecard exists and then render a replay video
// via scripts/maze-export-replay.js.
//
// Usage:
//   node scripts/maze-agent-local.js --model codex [options]
//   node scripts/maze-agent-local.js model=claude moves=10 level=HxI
//   node scripts/maze-agent-local.js model=kimi moves=10 level=HxI container=false
//
// Options accept either "--flag value" or "key=value" form:
//   model        codex | claude | kimi                       (required)
//   container    true (run inside docker, host FS isolated)  (default true)
//                | false (run on host with the CLI sandbox)
//   image        container image tag                         (default mazebench-agent)
//   docker_bin   container runtime                           (default docker)
//   codex_auth / claude_auth   host auth dir to mount read-only (subscription logins)
//   kimi_auth    host Kimi Code data dir                     (default $KIMI_CODE_HOME or ~/.kimi-code)
//   tool_use     read-only (game controls only) | offline (isolated Python)
//                                                            (default read-only)
//   tools        legacy boolean alias (false=game-only, true=offline)
//   auto_run_tools      allow saved solvers to submit action sequences (tools only)
//   auto_run_all_frames return every intermediate sequence observation (default true)
//   swarm        true lets an offline lead spawn identical-model workers
//   max_swarm_workers  hard cap on workers/private instances   (default 8)
//   mode         text (ASCII) | json (structured room) | vision (PNG) (default text)
//   omniscient   JSON mode includes every object in the room (default false)
//   hide_names   ASCII/JSON randomizes glyphs/names except player/gem
//   moves        maze action budget shown to the agent       (default 20)
//   game         game directory under games/ (default maze; draft/online
//                worlds created in Build Mode use their games/<id> dirs)
//   level        world level id, e.g. HxI or level_HxI       (default level_HxI)
//   vision_width, vision_height   PNG size in vision mode     (default 512)
//   vision_view  how far vision frames see: 1-26 rings of neighbor rooms
//                or "world"                                   (default 1 = 3x3)
//   view         top | top-diagonal | diagonal | side-diagonal | side
//   yaw          0-3 camera yaw                               (default 0)
//   gems         legacy compatibility input; game_won is fixed at 100
//   model_name   underlying LLM id (codex -m / claude --model) (agent default)
//   reasoning    reasoning effort. codex: low|medium|high|xhigh; claude:
//                low|medium|high|xhigh|max (model/agent default when unset)
//   codex_fast   codex Fast mode (priority tier)              (default false)
//   video        on | off                                     (default on)
//   out          output directory for this run's artifacts
//   session      explicit session.json path (overrides out)
//   resume       provider conversation id to resume
//   fork_session Claude: fork resume into session_id (internal branch support)
//   session_id   Claude: id assigned to the forked conversation
//   codex_bin    codex executable                             (default codex)
//   claude_bin   claude executable                            (default claude)
//   kimi_bin     kimi executable                              (default kimi)
//   fast|draft   forwarded to the video renderer for speed
//   width|height|fps  forwarded to the video renderer
//   dry_run      print the agent command + prompt and exit (no run)

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
const SUPPORTED_KIMI_CODE_VERSIONS = new Set(["0.28.1"]);

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
// the certified CLI version instead, allow exact MCP tools, and reject any
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

function migrateSeedSessionObservation(config) {
  if (!config.seed || !fs.existsSync(config.sessionFile)) return;

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
maze_action_sequence for quickly applying a route produced by a saved Python
planner or solver.

- Call maze_action_sequence only with an ordered action list that your saved
  Python program actually generated. Prefer route_file="route.json" so the MCP server reads
  the saved route directly instead of making you copy a long action list.
- A saved route may be a JSON action array or an object with actions and the
  observation_revision it was planned from. Revision-aware routes are rejected
  if the live game changed, so rerun the planner instead of executing stale moves.
- If that saved program produces two or more moves, use maze_action_sequence for
  the entire remaining route instead of replaying those moves one call at a time.
- A single call may contain the solver's full route. Each action is still validated,
  budgeted, persisted, and logged exactly like an individual maze_action.
- The sequence stops immediately on a terminal state, death, pause, exhausted
  move budget, rejected action, or other error, and reports how far it got.
${observationDelivery}
- After the call, inspect the final observation and the ordered summaries. If
  they disagree with the solver's prediction, update and rerun the saved program
  before submitting another route.

Never create a Python helper that calls a live game API or sends game actions.
Only maze_action and maze_action_sequence may change the live game.`;
}

function buildMcpPrompt(config) {
  const restricted = config.toolUse === "read-only";
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
general-purpose computation tool: python_exec. It runs Python in a fresh,
persistent scratch workspace. Each python_exec call starts a fresh Python
process, but its current working directory is writable and persists for this
entire run. Use relative paths to create and reuse .py, .json, and other scratch
files. Before your first primary game action—or before your next one when
resuming without a saved program—you MUST use python_exec to create and execute
at least one reusable Python program that helps parse observations, track state,
model mechanics, or plan moves. Keep reusable logic in files instead of
repeatedly sending the same logic inline. For example, Python can call
Path("planner.py").write_text(...), then runpy.run_path("planner.py"). There is no
separate editor or shell; create, revise, and execute files through python_exec.
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
  const jsonWorkspace = config.toolUse === "offline" && config.mode === "json"
    ? `JSON SOLVER WORKSPACE BRIDGE. After maze_start, maze_observe, maze_action,
or maze_action_sequence, the trusted MCP server atomically writes the exact
sanitized observation you just received to observations/current.json inside
your Python scratch workspace. It also appends delivered observations to
observations/history.jsonl. Do not copy or retype JSON from the tool result.
Instead, have saved Python programs load it directly with:

  observation = json.loads(Path("observations/current.json").read_text())

Your first Python call after the initial observation MUST create a real reusable
planner.py or solver.py file containing that load, then execute the saved file
with runpy.run_path. Inline-only JSON analysis does not satisfy this requirement.
Revise and rerun that saved program as the observation changes.

The file includes observation_revision. A solver that produces a route must
write route.json as {"observation_revision": observation["observation_revision"],
"actions": [...]}. When auto-run tools are available, submit it with
maze_action_sequence(route_file="route.json"). The server validates the path,
action strings, live revision, budget, pause state, and every individual move.`
    : "";
  const autoRunTools = autoRunToolsInstructions(config);
  const firstStep = config.resume || config.seed
    ? `Call ${controls.observe} first. This is the same primary game; do not call ${controls.start}.`
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
    : `Then play up to ${config.moves} ${config.resume || config.seed ? "MORE " : ""}primary game actions unless the game reaches a terminal state earlier.`;
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
${jsonWorkspace}
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

${config.resume
    ? `You are CONTINUING the SAME grid game you were just controlling — you already
have the full history in memory and know the helper. The session file is still
${config.sessionFile}. Do NOT run "start"; that would erase the progress.

Your FIRST shell command must re-read the current observation:

  node "${HELPER}" observe --state "${config.sessionFile}"

Then ${config.unlimited ? "keep taking maze actions from where you left off" : `play up to ${config.moves} MORE maze action(s) from where you left off`},`
    : config.seed
    ? `This maze is ALREADY IN PROGRESS: earlier moves were made and the game state
is saved in the session file. Do NOT run "start" — that would erase the progress.

Your FIRST shell command must read the current observation to see where the maze
stands right now:

  node "${HELPER}" observe --state "${config.sessionFile}"

Then ${config.unlimited ? "keep taking maze actions from that state" : `continue playing up to ${config.moves} MORE maze action(s) from that state`},`
    : `Your FIRST shell command must start the session (run it exactly once):

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
        ? "Explore only your private maze, use python_exec for isolated local computation, and report findings to the lead. " +
          "Each call starts a fresh Python process but relative-path files persist. Before your first maze_action, create and execute a reusable .py program in that workspace. " +
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
  if (config.toolUse === "read-only") {
    const codexDir = config.codexRuntimeDir || path.join(config.outDir, ".codex-runtime");
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
      autoAllowBashIfSandboxed: offline,
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
          "Each call starts a fresh Python process but relative-path files persist. Before your first maze_action, create and execute a reusable .py program in that workspace. " +
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

function sanitizeKimiConfig(source, config) {
  const unsafeTopLevel = new Set([
    "default_permission_mode",
    "default_plan_mode",
    "extra_skill_dirs",
    "merge_all_available_skills",
    "telemetry"
  ]);
  const unsafeSections = /^(?:permission|hooks|services|workspace|background|subagent|loop_control)(?:\.|$)/;
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
      keepBlock = !unsafeSections.test(section);
      continue;
    }
    if (block) {
      block.push(line);
      continue;
    }
    const assignment = line.match(/^\s*([A-Za-z_][\w-]*)\s*=/);
    if (!assignment || !unsafeTopLevel.has(assignment[1])) preamble.push(line);
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
  for (const entry of ["config.toml", "mcp.json", "credentials", "device_id"]) {
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
    pythonBin: config.pythonBin
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
  for (const directory of ["/home/pwuser/.codex/sessions", "/home/pwuser/.claude/projects"]) {
    chownTree(directory);
  }
  const credentialOverlays = [];
  const stageCredential = (directory, fileName) => {
    const source = path.join(directory, fileName);
    if (!fs.existsSync(source)) return;
    const staged = path.join(directory, `.${fileName}.mazebench-${process.pid}`);
    fs.copyFileSync(source, staged);
    fs.chmodSync(staged, 0o600);
    fs.chownSync(staged, config.agentUid, config.agentGid);
    credentialOverlays.push([staged, source]);
  };
  stageCredential("/home/pwuser/.codex", "auth.json");
  stageCredential("/home/pwuser/.claude", ".credentials.json");
  // A bwrap tmpfs root is owned by root. Give the demoted provider a private,
  // container-ephemeral /tmp so Claude Code can create its per-UID runtime dir
  // without exposing the trusted runner's /tmp contents.
  const providerTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-provider-"));
  fs.chmodSync(providerTmpDir, 0o700);
  fs.chownSync(providerTmpDir, config.agentUid, config.agentGid);
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
    "--dir", config.agentSwarmWorkspaceDir,
    "--bind", providerTmpDir, "/tmp",
    "--dev", "/dev",
    "--proc", "/proc",
    "--bind", config.workspaceDir, config.agentWorkspaceDir,
    "--bind", config.swarmWorkspaceDir, config.agentSwarmWorkspaceDir,
    ...(fs.existsSync(config.codexRuntimeDir)
      ? [
          "--dir", config.agentCodexRuntimeDir,
          "--ro-bind", config.codexRuntimeDir, config.agentCodexRuntimeDir
        ]
      : []),
    "--chdir", config.agentWorkspaceDir,
    "--setenv", "HOME", "/home/pwuser",
    "--setenv", "USER", "pwuser",
    "--setenv", "LOGNAME", "pwuser"
  ];
  for (const directory of ["/home/pwuser/.codex", "/home/pwuser/.claude"]) {
    if (fs.existsSync(directory)) args.push("--bind", directory, directory);
  }
  for (const [source, destination] of credentialOverlays) {
    args.push("--ro-bind", source, destination);
  }
  args.push(
    "--",
    "setpriv",
    "--reuid", String(config.agentUid),
    "--regid", String(config.agentGid),
    "--clear-groups",
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
      "--disable", "shell_tool",
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
    if (config.resume) argv.push("--session", config.resume);
    if (config.modelName) argv.push("--model", config.modelName);
    argv.push(
      "--prompt", prompt,
      "--output-format", "stream-json",
      "--skills-dir", config.agentKimiSkillsDir
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
        KIMI_LOG_LEVEL: "warn",
        NO_COLOR: "1",
        CI: "1",
        ...(config.reasoning ? { KIMI_MODEL_THINKING_EFFORT: config.reasoning } : {})
      }
    };
  }

  throw new Error(`Unknown model: ${config.model} (expected "codex", "claude", or "kimi")`);
}

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
      return {
        provider,
        status: Number(event.status || event.status_code) || null,
        message: String(event.message || event.error?.message || event.error || "Codex request failed.").trim().slice(0, 500)
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
  const { bin, argv, env: commandEnv = {} } = isolatedDockerAgentCommand(config, agentCommand(config, prompt));
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
    const env = config.model === "kimi"
      ? {
          PATH: process.env.PATH || "",
          HOME: process.env.HOME || os.homedir(),
          TMPDIR: process.env.TMPDIR || os.tmpdir(),
          LANG: process.env.LANG || "C.UTF-8",
          ...commandEnv
        }
      : { ...process.env, ...commandEnv };
    if (config.model === "claude" && config.mcpEnabled) {
      if (config.swarm && config.modelName) env.CLAUDE_CODE_SUBAGENT_MODEL = config.modelName;
    }
    const cwd = config.mcpEnabled ? config.workspaceDir : ROOT_DIR;
    const child = spawn(bin, argv, { cwd, env, stdio: ["ignore", "pipe", "inherit"] });
    let raw = "";
    let eventBuffer = "";

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
      const text = chunk.toString();
      raw += text;
      try {
        appendTimedEvents(text);
      } catch (_error) {
        /* best effort — the final write below still captures everything */
      }
    });
    child.on("error", (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      resolve({ code: null, failure: { provider: config.model, status: null, message: error.message } });
    });
    child.on("close", (code) => {
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
      resolve({ code, failure: providerFailureFromEvents(raw, config.model) });
    });
  });
}

function ensureScorecard(config) {
  if (!fs.existsSync(config.sessionFile)) {
    return false;
  }
  // Scoring runs only after the provider process has exited.
  const result = spawnSync(process.execPath, [HELPER, "finalize", "--state", config.sessionFile], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    env: { ...process.env, MAZEBENCH_TRUSTED_FINALIZE: "1" },
    timeout: 30000,
    killSignal: "SIGKILL"
  });
  if (result.status !== 0) {
    console.warn(`Could not finalize scorecard: ${(result.stderr || "").trim()}`);
    return false;
  }
  return true;
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
  const hostOutputs = path.join(ROOT_DIR, "outputs", "maze-local");
  const cidFile = path.join(config.outDir, "container.cid");
  const agentStateDir = path.join(config.outDir, "agent-state");

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

  // Forward the meaningful options to the in-container runner. Host-specific
  // path options (out/session) are intentionally dropped; the inner run writes
  // under the mounted /app/outputs/maze-local.
  const forwardKeys = [
    "model", "moves", "unlimited", "allow_quit", "mode", "omniscient", "hide_names", "hide_names_seed", "tools", "tool_use", "auto_run_tools", "auto_run_all_frames", "swarm", "max_swarm_workers", "game", "level", "view", "yaw", "gems",
    "video", "no_video", "fast", "draft", "width", "height", "fps",
    "vision_width", "vision_height", "vision_view", "model_name", "llm",
    "reasoning", "effort", "codex_fast", "resume", "seed", "fork_session", "session_id",
    "codex_bin", "claude_bin", "claude_allowed_tools"
  ];
  const inner = ["node", "scripts/maze-agent-local.js", "container=false"];
  for (const key of forwardKeys) {
    if (raw[key] !== undefined) inner.push(`${key}=${raw[key]}`);
  }
  // An explicit out dir inside the mounted outputs tree survives the re-exec:
  // rewrite it to the container-side path so callers (e.g. the web UI) can
  // tail a run directory they chose. Out dirs elsewhere are dropped as before.
  if (raw.out) {
    const hostOut = path.resolve(raw.out);
    const relative = path.relative(hostOutputs, hostOut);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      inner.push(`out=${path.posix.join("/app/outputs/maze-local", relative.split(path.sep).join("/"))}`);
    }
  }

  const dockerArgs = [
    "run", "--rm", "-i", "--cidfile", cidFile,
    "--user", "root",
    "--cap-drop", "ALL",
    "--cap-add", "SYS_ADMIN",
    "--cap-add", "SETUID",
    "--cap-add", "SETGID",
    "--cap-add", "CHOWN",
    "--cap-add", "DAC_OVERRIDE",
    "--security-opt", "seccomp=unconfined",
    "--security-opt", "apparmor=unconfined",
    "-e", "MAZEBENCH_IN_CONTAINER=1",
    "-v", `${hostOutputs}:/app/outputs/maze-local`,
    ...containerRuntimeMountArgs(ROOT_DIR)
  ];
  // Keep only this run's CLI conversation transcript across disposable
  // containers. These are the provider-owned stores consumed by `codex exec
  // resume <id>` / `claude --resume <id>`, and persisting them avoids mounting
  // the user's global agent history or colliding with the nested auth mounts.
  if (config.model === "codex") {
    const codexSessions = path.join(agentStateDir, "codex", "sessions");
    fs.mkdirSync(codexSessions, { recursive: true });
    dockerArgs.push("-v", `${codexSessions}:/home/pwuser/.codex/sessions`);
  } else if (config.model === "claude") {
    const claudeProjects = path.join(agentStateDir, "claude", "projects");
    fs.mkdirSync(claudeProjects, { recursive: true });
    dockerArgs.push("-v", `${claudeProjects}:/home/pwuser/.claude/projects`);
  }
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
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    if (process.env[key]) dockerArgs.push("-e", key);
  }
  // Optional: mount ONLY the credential file (read-only) for subscription
  // logins. We deliberately do NOT mount the whole ~/.codex or ~/.claude, which
  // hold history, memories, logs, etc. — that would leak personal data into the
  // container and can be gigabytes.
  let codexAutoMounted = false;
  if (raw.codex_auth) {
    const p = path.resolve(expandTilde(raw.codex_auth));
    const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, "auth.json") : p;
    dockerArgs.push("-v", `${file}:/home/pwuser/.codex/auth.json:ro`);
  } else if (config.model === "codex" && !process.env.OPENAI_API_KEY) {
    // Auto: mount the Codex subscription login (~/.codex/auth.json) read-only when
    // no explicit credential is given, so `model=codex` just works.
    const authFile = path.join(process.env.HOME || "", ".codex", "auth.json");
    if (fs.existsSync(authFile)) {
      dockerArgs.push("-v", `${authFile}:/home/pwuser/.codex/auth.json:ro`);
      codexAutoMounted = true;
    }
  }
  if (raw.claude_auth) {
    const p = path.resolve(expandTilde(raw.claude_auth));
    const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, ".credentials.json") : p;
    dockerArgs.push("-v", `${file}:/home/pwuser/.claude/.credentials.json:ro`);
  }
  // Auto: a Claude Code subscription login lives in the macOS Keychain (no file
  // to mount), so materialize just that credential into a short-lived temp file
  // when no explicit Claude credential was supplied.
  let claudeCredTemp = null;
  if (
    config.model === "claude" &&
    !raw.claude_auth &&
    !process.env.ANTHROPIC_API_KEY &&
    !process.env.CLAUDE_CODE_OAUTH_TOKEN &&
    claudeKeychainAvailable()
  ) {
    claudeCredTemp = path.join("/tmp", `mazebench-claude-cred-${process.pid}.json`);
    dockerArgs.push("-v", `${claudeCredTemp}:/home/pwuser/.claude/.credentials.json:ro`);
  }
  dockerArgs.push(config.image, ...inner);

  if (isTruthy(raw.dry_run, false)) {
    console.log(`# would run in container (${config.image}):`);
    console.log([config.dockerBin, ...dockerArgs].join(" "));
    if (claudeCredTemp) {
      console.log("# (mounts your Claude Code subscription credential from the Keychain, read-only)");
    }
    console.log(`\n# host artifacts would appear under: ${hostOutputs}`);
    return 0;
  }

  const dockerProbe = spawnSync("sh", ["-c", `command -v ${JSON.stringify(config.dockerBin)}`], {
    encoding: "utf8"
  });
  if (dockerProbe.status !== 0) {
    console.error(
      `Container runtime not found: ${config.dockerBin}\n` +
        "Install Docker (or pass docker_bin=<path>, e.g. docker_bin=podman), or run on the\n" +
        "host with the CLI sandbox via container=false."
    );
    return 1;
  }
  fs.mkdirSync(hostOutputs, { recursive: true });

  // Stage the Keychain credential just before running, and remove it after.
  if (claudeCredTemp) {
    const cred = extractClaudeKeychainCredential();
    if (!cred) {
      console.error("Could not read your Claude Code credential from the Keychain.");
      return 1;
    }
    fs.writeFileSync(claudeCredTemp, cred, { mode: 0o600 });
  }

  console.log(`\n=== Running in container: ${config.image} ===`);
  console.log(`Host FS is isolated; only ${hostOutputs} is mounted writable.`);
  console.log("The current maze runtime is mounted read-only so this run uses the latest behavior.");
  const hasCred =
    process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN || raw.codex_auth || raw.claude_auth ||
    claudeCredTemp || codexAutoMounted;
  if (!hasCred) {
    console.warn(
      "Warning: the agent inside the container has no credentials. Set OPENAI_API_KEY " +
        "/ ANTHROPIC_API_KEY, or pass codex_auth=~/.codex (Codex) / claude_auth=<file> (Claude)."
    );
  }

  const result = spawnSync(config.dockerBin, dockerArgs, { cwd: ROOT_DIR, stdio: "inherit" });
  if (claudeCredTemp) {
    try {
      fs.unlinkSync(claudeCredTemp);
    } catch (_error) {
      /* best effort */
    }
  }
  if (result.error) {
    console.error(
      `\nFailed to launch container: ${result.error.message}\n` +
        `Is the image built? Run: docker build -t ${config.image} .  (or: npm run maze:build-image)`
    );
    return 1;
  }
  if (result.status !== 0) {
    console.error(
      `\nContainer exited with status ${result.status}. If the image is missing, build it:\n` +
        `  docker build -t ${config.image} .   (or: npm run maze:build-image)`
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

  out.container = out.model === "kimi"
    ? "false"
    : await promptSelect("Access?", [
        { label: "Container", value: "true", hint: "isolated from your files — recommended" },
        { label: "Host", value: "false", hint: "native OS sandbox with launch-time verification" }
      ]);

  out.tool_use = await promptSelect("Tool use?", [
    { label: "No Tools", value: "read-only", hint: "game controls only; no files, shell, web, memory, or workers" },
    { label: "[PY] Tools", value: "offline", hint: "isolated Python scratchpad; no host files or network" }
  ]);

  if (out.tool_use === "offline" && out.model !== "kimi") {
    out.swarm = await promptSelect("Orchestration?", [
      { label: "Single", value: "false", hint: "one lead agent" },
      { label: "Swarm", value: "true", hint: "lead controls identical-model workers" }
    ]);
  } else {
    out.swarm = "false";
  }

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

async function main() {
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

  if (!model || !["codex", "claude", "kimi"].includes(model)) {
    console.error(
      "Usage: node scripts/maze-agent-local.js --model <codex|claude|kimi> [moves=N level=HxI ...]"
    );
    process.exit(2);
  }

  const view = VIEW_NAMES.includes(String(raw.view)) ? String(raw.view) : "top-diagonal";
  const outDir = raw.session
    ? path.dirname(path.resolve(raw.session))
    : path.resolve(raw.out || path.join(ROOT_DIR, "outputs", "maze-local", model, timestampSlug()));
  const sessionFile = raw.session ? path.resolve(raw.session) : path.join(outDir, "session.json");
  const inContainer = process.env.MAZEBENCH_IN_CONTAINER === "1";
  const wantsContainer = isTruthy(raw.container, true);
  const requestedToolUse = String(raw.tool_use || "").trim().toLowerCase();
  const toolUse = ["read-only", "offline"].includes(requestedToolUse)
    ? requestedToolUse
    : isTruthy(raw.tools, false)
      ? "offline"
      : "read-only";
  const requestedSwarm = toolUse === "offline" && isTruthy(raw.swarm, false);
  const autoRunTools = toolUse === "offline" && isTruthy(raw.auto_run_tools, true);
  const autoRunAllFrames = autoRunTools && isTruthy(raw.auto_run_all_frames, true);
  if (model === "kimi" && requestedSwarm) {
    throw new Error("Kimi Code local runs currently support a single isolated agent, not swarm workers.");
  }
  const swarm = requestedSwarm;
  const unlimited = isTruthy(raw.unlimited, false);
  const hostAccess = !wantsContainer && !inContainer;
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
  const workspaceRoot = path.join(os.tmpdir(), "mazebench-agent-workspaces", workspaceKey);
  const workspaceDir = path.join(workspaceRoot, "workspace");
  const swarmDir = path.join(outDir, "swarm");
  const swarmWorkspaceDir = path.join(workspaceRoot, "swarm-workspaces");
  const codexRuntimeDir = path.join(outDir, ".codex-runtime");
  const pythonSandboxStateDir = path.join(outDir, ".python-sandbox");
  const kimiRuntimeDir = path.join(workspaceRoot, "kimi-home");
  const kimiSkillsDir = path.join(kimiRuntimeDir, "empty-skills");

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
    agentCodexRuntimeDir: inContainer ? "/run/mazebench-codex-runtime" : codexRuntimeDir,
    agentKimiRuntimeDir: kimiRuntimeDir,
    agentKimiSkillsDir: kimiSkillsDir,
    // The outer Docker launcher re-execs before starting an agent. Actual host
    // and in-container agents both use MCP so maze persistence stays outside
    // their file/tool sandbox.
    mcpEnabled: !wantsContainer || inContainer,
    // Continue a prior run. seed=true means the session.json (action history) is
    // present in outDir so we resume the maze from it instead of starting fresh.
    // resume=<conversation-id> additionally resumes the CLI conversation so the
    // model keeps its full memory (a true continue). resume implies seed.
    resume: String(raw.resume || "").trim(),
    forkSession: isTruthy(raw.fork_session, false),
    sessionId: String(raw.session_id || "").trim(),
    seed: isTruthy(raw.seed, false) || Boolean(String(raw.resume || "").trim()),
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

  if (config.model === "kimi" && (config.container || inContainer)) {
    throw new Error("Kimi Code local runs use the verified host permission boundary; pass container=false.");
  }
  if (config.model === "kimi") verifyKimiCliCompatibility(config);

  // Default: isolate the whole run inside a container. `container=false` (or the
  // in-container re-exec, flagged by MAZEBENCH_IN_CONTAINER) runs on the host.
  if (config.container && !inContainer) {
    process.exit(runInContainer(config, raw));
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(path.join(outDir, "cold-pause-capability.json"), { force: true });
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  fs.mkdirSync(config.swarmDir, { recursive: true });
  fs.mkdirSync(config.swarmWorkspaceDir, { recursive: true });
  migrateSeedSessionObservation(config);
  // Claude Code 2.1.214 connects CLI-supplied stdio MCP servers asynchronously.
  // In the intentionally empty restricted workspace its first model request can
  // outrun that connection and receive no game tools. Start the existing
  // authenticated localhost transport before launching Claude so its tools are
  // ready immediately. Containers already require the same transport.
  prepareAgentRuntime(config);
  if (!isTruthy(raw.dry_run, false) && config.toolUse === "offline") {
    verifyToolIsolation(config);
    console.log("Tool isolation verified: Python scratch writes allowed; repository, host files, symlink escapes, subprocesses, and network blocked.");
  }
  const privateMcp = needsPrivateMcpServer(config)
    ? await startPrivateMcpServer(config)
    : null;
  if (config.model === "kimi") {
    try {
      prepareKimiRuntime(config);
    } catch (error) {
      privateMcp?.stop();
      throw error;
    }
  }

  const prompt = buildPrompt(config);

  if (isTruthy(raw.dry_run, false)) {
    const { bin, argv } = agentCommand(config, prompt);
    const shown = argv.map((arg) => (arg === prompt ? '"<prompt>"' : arg));
    console.log(`# would launch (${config.model}):`);
    console.log([bin, ...shown].join(" "));
    console.log(`# with <prompt>:\n${prompt}`);
    console.log(`\n# artifacts would land in: ${config.outDir}`);
    scrubKimiRuntimeSecrets(config);
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
    scrubKimiRuntimeSecrets(config);
    privateMcp?.stop();
  }

  const finalized = ensureScorecard(config);
  if (!finalized) {
    console.error(
      `\nNo session was written at ${config.sessionFile}. The agent likely never ran the ` +
        "start command. Nothing to export."
    );
    process.exit(1);
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

module.exports = {
  actionFromShellCommand,
  agentCommand,
  actionsFromShellCommand,
  actionsFromToolCall,
  buildMcpPrompt,
  claudeSandboxSettings,
  codexMcpConfigArgs,
  containerRuntimeMountArgs,
  distillClaudeEvents,
  distillCodexEvents,
  distillKimiEvents,
  kimiAllowedTools,
  kimiMcpConfig,
  loadCodexModels,
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
