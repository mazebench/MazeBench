#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_RESULTS_ROOT = path.join(
  ROOT_DIR,
  "environments",
  "mazebench",
  "outputs",
  "evals"
);
const DEFAULT_BROWSER_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
];
const DIRECTIONS = new Set(["up", "down", "left", "right"]);
const VIEW_NAMES = ["top", "top-diagonal", "diagonal", "side-diagonal", "side"];
const LEGACY_GEM_ID_PATTERN = /^(.*):gem:(?:-?\d+:)?(-?\d+),(-?\d+),(-?\d+)$/;

function asciiViewIndex(view) {
  const index = VIEW_NAMES.indexOf(String(view || "").toLowerCase());
  return index === -1 ? VIEW_NAMES.indexOf("top-diagonal") : index;
}

function visionTiltDegreesForAsciiView(view) {
  // ASCII uses a four-row tile: pitch rows show the vertical side and the
  // remaining rows show its top. Matching tan(tilt) to that side/top ratio
  // gives the equivalent visual camera angle, including true 0° and 90° ends.
  const sideRows = asciiViewIndex(view);
  const topRows = VIEW_NAMES.length - 1 - sideRows;
  return (Math.atan2(sideRows, topRows) * 180) / Math.PI;
}

function rotateAsciiView(view, direction) {
  const currentIndex = asciiViewIndex(view);
  const nextIndex = direction === "up"
    ? Math.max(0, currentIndex - 1)
    : direction === "down"
      ? Math.min(VIEW_NAMES.length - 1, currentIndex + 1)
      : currentIndex;
  return VIEW_NAMES[nextIndex];
}

function normalizeGemCollectionId(value) {
  const id = String(value || "");
  const match = id.match(LEGACY_GEM_ID_PATTERN);
  return match ? `${match[1]}:gem:${match[2]},${match[3]},${match[4]}` : id;
}

function normalizedGemCollectionIds(values) {
  return Array.from(new Set((values || []).map(normalizeGemCollectionId))).sort();
}

function usage() {
  return `Usage: npm run maze:replay -- [results-dir | results.jsonl | traces.jsonl | session.json | actions.jsonl | run-dir] [options]

Creates maze_scorecard.json, maze_actions.txt, and maze_replay.mp4 from a mazebench
eval rollout JSONL, a local agent session, or a streamed run action log.

Options:
  --index <n>          Rollout row to export from results/traces JSONL. Default: 0.
  --action-limit <n>   Render only the first n actions (useful for replay QA).
  --out-dir <path>     Directory for exported artifacts. Default: eval results dir.
  --video              Render maze_replay.mp4. Enabled by default.
  --no-video           Only write maze_scorecard.json and maze_actions.txt.
  --width <px>         Output video width. Default: 400.
  --height <px>        Output video height. Default: 400.
  --fps <n>            Video frames per second. Default: 20.
  --accelerated        Use deterministic frame stepping and Chrome's native
                       H.264 canvas recorder, with raw and PNG fallbacks.
  --raw-accelerated    Use the accelerated raw-frame pipe instead of Chrome's
                       native H.264 canvas recorder.
  --no-accelerated     Use the original real-time PNG renderer.
  --fast               Capture only settled states, not animation tweens.
  --draft              Lower replay DPR and disable the fuzzy effect for
                       faster capture.
  --intro              Begin with the blue edge reveal, then zoom in while
                       the normal fill colors fade into view.
  --ascii-side-by-side Render the visual maze and ASCII observation together.
  --no-edges           Drop the black outline pass (on by default, matching
                       how the game looks in the browser).
  --move-speed <n>     Movement animation speed multiplier. Default: 5.
  --camera-speed <n>   Camera animation speed multiplier. Default: 2.
  --speed <n>          Uniform speed multiplier for movement and camera.
  --crf <n>            x264 CRF; lower is larger/higher quality. Default: 21.
  --preset <name>      x264 preset. Default: veryfast.
  --max-video-mib <n>  Maximum final video size in MiB; 0 disables. Default: 0.
  --camera-tilt <deg>  Perspective camera tilt from top-down. Default: 58.
  --camera-step <deg>  Tilt delta for rotate camera up/down. Default: 18.
  --camera-zoom <n>    Perspective camera zoom multiplier. Default: 1.
  --motion-scale <n>   Replay-only animation slowdown multiplier. Default: 4.
  --tail-seconds <n>   Final hold after the last action. Default: 0.45.
  --format <ext>       mp4 or mov. Default: mp4.
  --browser <name>     chrome, brave, chromium, edge, or executable path.
  --keep-frames        Keep the intermediate PNG frames beside the output.
  --help               Show this help.
`;
}

function parseCli(argv) {
  const options = defaultReplayOptions();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${arg} requires a value`);
      }
      return argv[index];
    };

    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else if (arg === "--index") {
      options.index = Number(next());
    } else if (arg === "--action-limit") {
      options.actionLimit = Number(next());
    } else if (arg === "--out-dir") {
      options.outDir = path.resolve(next());
    } else if (arg === "--video") {
      options.video = true;
    } else if (arg === "--no-video") {
      options.video = false;
    } else if (arg === "--width") {
      options.width = Number(next());
    } else if (arg === "--height") {
      options.height = Number(next());
    } else if (arg === "--fps") {
      options.fps = Number(next());
    } else if (arg === "--accelerated") {
      options.accelerated = true;
    } else if (arg === "--raw-accelerated") {
      options.accelerated = true;
      options.nativeRecorder = false;
    } else if (arg === "--no-accelerated") {
      options.accelerated = false;
    } else if (arg === "--fast" || arg === "--fast-render") {
      options.fast = true;
    } else if (arg === "--no-fast") {
      options.fast = false;
    } else if (arg === "--draft" || arg === "--draft-render") {
      options.draft = true;
    } else if (arg === "--no-draft") {
      options.draft = false;
    } else if (arg === "--intro") {
      options.intro = true;
    } else if (arg === "--no-intro") {
      options.intro = false;
    } else if (arg === "--ascii-side-by-side") {
      options.asciiSideBySide = true;
    } else if (arg === "--no-ascii-side-by-side") {
      options.asciiSideBySide = false;
    } else if (arg === "--edges") {
      options.edges = true;
    } else if (arg === "--no-edges") {
      options.edges = false;
    } else if (arg === "--speed") {
      const speed = Number(next());
      options.cameraSpeed = speed;
      options.moveSpeed = speed;
    } else if (arg === "--move-speed") {
      options.moveSpeed = Number(next());
    } else if (arg === "--camera-speed") {
      options.cameraSpeed = Number(next());
    } else if (arg === "--crf") {
      options.crf = Number(next());
    } else if (arg === "--preset") {
      options.preset = next();
    } else if (arg === "--max-video-mib") {
      options.maxVideoMiB = Number(next());
    } else if (arg === "--camera-tilt") {
      options.cameraTiltDegrees = Number(next());
    } else if (arg === "--camera-step") {
      options.cameraStepDegrees = Number(next());
    } else if (arg === "--camera-zoom") {
      options.cameraZoom = Number(next());
    } else if (arg === "--motion-scale") {
      options.motionScale = Number(next());
    } else if (arg === "--tail-seconds") {
      options.tailSeconds = Number(next());
    } else if (arg === "--format") {
      options.format = next().replace(/^\./, "").toLowerCase();
    } else if (arg === "--browser") {
      options.browser = next();
    } else if (arg === "--keep-frames") {
      options.keepFrames = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.resultsInput) {
      options.resultsInput = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return validateReplayOptions(options);
}

function defaultReplayOptions() {
  return {
    accelerated: false,
    actionLimit: 0,
    asciiSideBySide: false,
    browser: "",
    cameraStepDegrees: 18,
    cameraTiltDegrees: 58,
    cameraZoom: 1,
    cameraSpeed: 2,
    crf: 21,
    draft: false,
    edges: true,
    fps: 20,
    fast: false,
    format: "mp4",
    height: 400,
    index: 0,
    intro: false,
    keepFrames: false,
    maxVideoMiB: 0,
    moveSpeed: 5,
    nativeRecorder: true,
    outDir: "",
    // veryfast encodes these small clips an order of magnitude quicker than
    // veryslow for a marginal size difference; pass --preset to override.
    preset: "veryfast",
    resultsInput: "",
    video: true,
    motionScale: 4,
    tailSeconds: 0.45,
    width: 400
  };
}

function validateReplayOptions(options) {
  if (!Number.isInteger(options.index) || options.index < 0) {
    throw new Error("--index must be a non-negative integer");
  }

  if (!Number.isInteger(options.actionLimit) || options.actionLimit < 0) {
    throw new Error("--action-limit must be a non-negative integer");
  }

  for (const key of [
    "width",
    "height",
    "fps",
    "crf",
    "cameraTiltDegrees",
    "cameraStepDegrees",
    "cameraZoom",
    "cameraSpeed",
    "motionScale",
    "moveSpeed"
  ]) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) {
      throw new Error(`--${key} must be a positive number`);
    }
  }

  if (!Number.isFinite(options.tailSeconds) || options.tailSeconds < 0) {
    throw new Error("--tail-seconds must be zero or a positive number");
  }

  if (!Number.isFinite(options.maxVideoMiB) || options.maxVideoMiB < 0) {
    throw new Error("--max-video-mib must be zero or a positive number");
  }

  options.cameraTiltDegrees = Math.max(1, Math.min(89, options.cameraTiltDegrees));
  options.cameraStepDegrees = Math.max(1, Math.min(45, options.cameraStepDegrees));
  options.cameraZoom = Math.max(0.2, Math.min(4, options.cameraZoom));
  options.cameraSpeed = Math.max(0.1, Math.min(12, options.cameraSpeed));
  options.motionScale = Math.max(0.25, Math.min(12, options.motionScale));
  options.moveSpeed = Math.max(0.1, Math.min(12, options.moveSpeed));
  options.tailSeconds = Math.max(0, Math.min(4, options.tailSeconds));

  if (!["mp4", "mov"].includes(options.format)) {
    throw new Error("--format must be mp4 or mov");
  }

  return options;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function findResultsFiles(dir, depth = 0, found = []) {
  if (depth > 5 || !fs.existsSync(dir)) {
    return found;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isFile() && ["results.jsonl", "traces.jsonl"].includes(entry.name)) {
      found.push(entryPath);
    } else if (entry.isDirectory()) {
      findResultsFiles(entryPath, depth + 1, found);
    }
  }

  return found;
}

function latestResultsPath() {
  const candidates = findResultsFiles(DEFAULT_RESULTS_ROOT);

  if (candidates.length === 0) {
    throw new Error(`No rollout JSONL files found under ${DEFAULT_RESULTS_ROOT}`);
  }

  candidates.sort((a, b) => fileMtimeMs(b) - fileMtimeMs(a));
  return candidates[0];
}

function resolveInput(input) {
  const resolvedInput = input ? path.resolve(input) : latestResultsPath();
  const stats = fs.statSync(resolvedInput);

  if (stats.isDirectory()) {
    const resultsPath = path.join(resolvedInput, "results.jsonl");
    const tracesPath = path.join(resolvedInput, "traces.jsonl");
    const sessionPath = path.join(resolvedInput, "session.json");
    const actionsPath = path.join(resolvedInput, "actions.jsonl");

    if (fileHasContent(resultsPath)) {
      return { mode: "results", resultsDir: resolvedInput, resultsPath };
    }

    if (fileHasContent(tracesPath)) {
      return { mode: "results", resultsDir: resolvedInput, resultsPath: tracesPath };
    }

    if (fs.existsSync(sessionPath)) {
      return { mode: "session", sessionDir: resolvedInput, sessionPath };
    }

    if (fileHasContent(actionsPath)) {
      return { mode: "actions", runDir: resolvedInput, actionsPath };
    }

    throw new Error(`No completed results, saved session, or action log found in ${resolvedInput}`);
  }

  if (path.basename(resolvedInput) === "session.json") {
    return {
      mode: "session",
      sessionDir: path.dirname(resolvedInput),
      sessionPath: resolvedInput
    };
  }

  if (path.basename(resolvedInput) === "actions.jsonl") {
    return {
      mode: "actions",
      runDir: path.dirname(resolvedInput),
      actionsPath: resolvedInput
    };
  }

  return {
    mode: "results",
    resultsDir: path.dirname(resolvedInput),
    resultsPath: resolvedInput
  };
}

function fileHasContent(filePath) {
  try {
    return fs.statSync(filePath).size > 0;
  } catch (_error) {
    return false;
  }
}

function canonicalFromBridgeMessage(message) {
  if (!message || typeof message !== "object") {
    return "";
  }

  if (message.command === "move") {
    return String(message.direction || "");
  }

  if (message.command === "rotate_camera") {
    return `rotate camera ${message.direction}`;
  }

  if (message.command === "goto_level") {
    return `go to level ${message.x} ${message.y}`;
  }

  if (message.command === "reset_level") {
    return "reset";
  }

  if (message.command === "no_move") {
    return "no move";
  }

  return String(message.command || "");
}

// Adapt a local codex-play.js session.json into the same row shape the eval
// path produces, so extractActions/extractMazeOptions/existingScorecard work.
function rowFromSession(session) {
  const sessionActions = Array.isArray(session.actions) ? session.actions : [];
  const replayEntries = sessionActions
    .map((action) => ({
      command: canonicalFromBridgeMessage(action.message) || String(action.command_text || "").trim(),
      status: action?.status || null,
      valid: true
    }))
    .filter((action) => action.command);
  const actions = replayEntries.map(({ command, valid }) => ({ command, valid }));
  const scorecard = session.scorecard && Object.keys(session.scorecard).length > 0
    ? session.scorecard
    : {};

  return {
    maze_ascii_frames: [
      String(session.initial?.level || ""),
      ...sessionActions.map((action) => String(action?.status?.level || ""))
    ],
    maze_actions: actions,
    maze_scorecard: scorecard,
    maze_replay: {
      game_id: session.gameId || "maze",
      game_won_gem_count: 100,
      start_level_id: session.levelId || "level_HxI",
      target_gems: 0,
      initial: {
        view: session.view || "top-diagonal",
        yaw: Number(session.yaw) || 0
      },
      action_statuses: replayEntries.map((entry) => entry.status),
      scorecard
    }
  };
}

function normalizeReplayYaw(value) {
  const yaw = Number(value);
  const integer = Number.isInteger(yaw) ? yaw : 0;
  return ((integer % 4) + 4) % 4;
}

function replayMoveVector(direction, yaw = 0) {
  const vectors = {
    down: { dx: 0, dy: 1 },
    left: { dx: -1, dy: 0 },
    right: { dx: 1, dy: 0 },
    up: { dx: 0, dy: -1 }
  };
  const vector = vectors[String(direction || "").toLowerCase()];
  if (!vector) return null;

  switch (normalizeReplayYaw(yaw)) {
    case 1:
      return { dx: vector.dy, dy: -vector.dx };
    case 2:
      return { dx: -vector.dx, dy: -vector.dy };
    case 3:
      return { dx: -vector.dy, dy: vector.dx };
    default:
      return vector;
  }
}

function replayDirectionForVector(dx, dy, yaw) {
  return ["up", "down", "left", "right"].find((direction) => {
    const vector = replayMoveVector(direction, yaw);
    return vector?.dx === dx && vector?.dy === dy;
  }) || "";
}

function replayViewBeforeCommand(currentView, parsed) {
  const currentIndex = VIEW_NAMES.indexOf(String(currentView || "").toLowerCase());
  if (currentIndex < 0 || parsed?.command !== "rotate_camera") return currentView;
  if (parsed.direction === "up") return VIEW_NAMES[Math.min(VIEW_NAMES.length - 1, currentIndex + 1)];
  if (parsed.direction === "down") return VIEW_NAMES[Math.max(0, currentIndex - 1)];
  return currentView;
}

function replayYawBeforeCommand(currentYaw, parsed) {
  const yaw = normalizeReplayYaw(currentYaw);
  if (parsed?.command !== "rotate_camera") return yaw;
  if (parsed.direction === "right") return normalizeReplayYaw(yaw - 1);
  if (parsed.direction === "left") return normalizeReplayYaw(yaw + 1);
  return yaw;
}

// A live Prime trace occasionally contains one status whose bridge action
// count advances by more than the single recorded model turn. The status is
// authoritative, so recover simple missing screen-relative moves inside that
// turn instead of letting the visual replay drift (or silently exporting a
// dud through the unvalidated PNG fallback).
function inferReplayPrefixCommands(previousStatus, currentStatus, commandText, missingCount) {
  const count = Math.max(0, Math.floor(Number(missingCount) || 0));
  if (!count) return [];

  const parsed = parseCommandLine(commandText);
  const stableFallback = parsed?.command === "move" && currentStatus?.moved === false
    ? parsed.direction
    : "no move";
  const fallback = () => Array.from({ length: count }, () => stableFallback);
  const previousPlayer = previousStatus?.player;
  const currentPlayer = currentStatus?.player;
  if (!previousPlayer || !currentPlayer) return fallback();
  if (
    previousStatus?.current_room &&
    currentStatus?.current_room &&
    String(previousStatus.current_room) !== String(currentStatus.current_room)
  ) {
    return fallback();
  }

  const beforeYaw = replayYawBeforeCommand(currentStatus?.yaw, parsed);
  const beforeView = replayViewBeforeCommand(currentStatus?.current_view, parsed);
  if (
    previousStatus?.yaw !== undefined &&
    normalizeReplayYaw(previousStatus.yaw) !== beforeYaw
  ) {
    return fallback();
  }
  if (
    previousStatus?.current_view &&
    beforeView &&
    String(previousStatus.current_view) !== String(beforeView)
  ) {
    return fallback();
  }

  const beforeCurrent = {
    elevation: Number(currentPlayer.elevation) || 0,
    x: Number(currentPlayer.x),
    y: Number(currentPlayer.y)
  };
  if (parsed?.command === "move" && currentStatus?.moved === true) {
    const currentVector = replayMoveVector(parsed.direction, beforeYaw);
    if (!currentVector) return fallback();
    beforeCurrent.x -= currentVector.dx;
    beforeCurrent.y -= currentVector.dy;
  }
  if (
    !Number.isFinite(beforeCurrent.x) ||
    !Number.isFinite(beforeCurrent.y) ||
    (Number(previousPlayer.elevation) || 0) !== beforeCurrent.elevation
  ) {
    return fallback();
  }

  let dx = beforeCurrent.x - Number(previousPlayer.x);
  let dy = beforeCurrent.y - Number(previousPlayer.y);
  if (!Number.isInteger(dx) || !Number.isInteger(dy) || Math.abs(dx) + Math.abs(dy) > count) {
    return fallback();
  }

  const commands = [];
  while (dx !== 0) {
    const step = Math.sign(dx);
    const direction = replayDirectionForVector(step, 0, beforeYaw);
    if (!direction) return fallback();
    commands.push(direction);
    dx -= step;
  }
  while (dy !== 0) {
    const step = Math.sign(dy);
    const direction = replayDirectionForVector(0, step, beforeYaw);
    if (!direction) return fallback();
    commands.push(direction);
    dy -= step;
  }
  while (commands.length < count) commands.push(stableFallback);
  return commands;
}

function annotateReplayActionGaps(entries, initialStatus = null) {
  let previousStatus = initialStatus || null;
  let previousCount = Number(initialStatus?.action_count);
  if (!Number.isInteger(previousCount) || previousCount < 0) previousCount = 0;

  return entries.map((entry) => {
    const status = entry.status || {};
    const currentCount = Number(status.action_count);
    let next = entry;
    if (Number.isInteger(currentCount) && currentCount >= previousCount) {
      const recordedActionCount = entry.valid ? 1 : 0;
      const missingCount = Math.max(0, currentCount - previousCount - recordedActionCount);
      if (missingCount > 0) {
        next = {
          ...entry,
          status: {
            ...status,
            replay_prefix_commands: inferReplayPrefixCommands(
              previousStatus,
              status,
              entry.command,
              missingCount
            )
          }
        };
      }
      previousCount = currentCount;
    }
    previousStatus = status;
    return next;
  });
}

// Prime writes actions.jsonl after every turn, while results.jsonl is only
// finalized when the Verifiers rollout exits normally. Auto-quit and cancelled
// runs can therefore be replayable even when no final rollout row exists.
function rowFromActionLog(actionRecords, runMeta = {}, initialStatus = null) {
  const replayEntries = annotateReplayActionGaps((Array.isArray(actionRecords) ? actionRecords : [])
    .filter(Boolean)
    .map((action) => {
      const valid = action.valid !== false && !action.error;
      return {
        command: String(action.command_text || action.command || "").trim(),
        status: valid
          ? action.status || null
          : {
              ...(action.status || {}),
              replay_action_valid: false,
              replay_action_error: action.error || null
            },
        valid
      };
    })
    // Keep parseable rejected attempts in the timeline as visual no-ops. That
    // preserves exact action/observation alignment without trying to replay
    // malformed prose as a game command.
    .filter((action) => action.command && (action.valid || parseCommandLine(action.command))), initialStatus);
  const actions = replayEntries.map(({ command }) => ({ command, valid: true }));
  const firstStatus = replayEntries.find((entry) => entry.status)?.status || {};
  const initialLevel = String(initialStatus?.level || firstStatus.level || "");
  const view = String(
    runMeta.view ||
    runMeta.launch_params?.view ||
    initialStatus?.current_view ||
    firstStatus.current_view ||
    "top-diagonal"
  );
  const yaw = Number(
    runMeta.yaw ??
    runMeta.launch_params?.yaw ??
    initialStatus?.yaw ??
    firstStatus.yaw ??
    0
  );

  return {
    maze_ascii_frames: [
      initialLevel,
      ...replayEntries.map((entry) => String(entry.status?.level || ""))
    ],
    maze_actions: actions,
    maze_scorecard: {},
    maze_replay: {
      game_id: runMeta.game_id || "maze",
      game_won_gem_count: 100,
      start_level_id: runMeta.level_id || "level_HxI",
      target_gems: 0,
      initial: {
        view,
        yaw: Number.isInteger(yaw) ? yaw : 0
      },
      action_statuses: replayEntries.map((entry) => entry.status),
      scorecard: {}
    }
  };
}

function extractAsciiFrames(row) {
  const info = row.info || {};
  const replay = row.maze_replay || info.maze_replay || {};
  const frames = row.maze_ascii_frames || info.maze_ascii_frames || replay.ascii_frames;
  if (Array.isArray(frames) && frames.some((frame) => String(frame || "").trim())) {
    return frames.map((frame) => String(frame || ""));
  }

  const extractBoard = (content) => {
    const match = messageContentToText(content).match(/```(?:text)?\r?\n([\s\S]*?)```/i);
    return match ? match[1].replace(/\s+$/, "") : "";
  };
  const nodeMessages = (Array.isArray(row.nodes) ? row.nodes : [])
    .map((node) => node?.message)
    .filter(Boolean);
  const messages = nodeMessages.length
    ? nodeMessages
    : [
        ...(Array.isArray(row.prompt) ? row.prompt : []),
        ...(Array.isArray(row.completion) ? row.completion : [])
      ];
  const initialBoard =
    String(replay.initial?.level || "") ||
    messages
      .filter((message) => message?.role === "user")
      .map((message) => extractBoard(message.content))
      .find(Boolean) ||
    "";
  const actionRecords = (Array.isArray(row.maze_actions)
    ? row.maze_actions
    : Array.isArray(info.maze_actions)
      ? info.maze_actions
      : Array.isArray(replay.actions)
        ? replay.actions
        : [])
    .filter((record) => record && record.valid !== false && String(record.command || "").trim());

  // Hosted Prime rows can carry the initial prompt plus post-action boards on
  // each action record. Prefer those when present because they include the
  // terminal observation after the final action too.
  if (initialBoard && actionRecords.some((record) => String(record.status?.level || "").trim())) {
    let currentBoard = initialBoard;
    return [
      initialBoard,
      ...actionRecords.map((record) => {
        currentBoard = String(record.status?.level || "").trimEnd() || currentBoard;
        return currentBoard;
      })
    ];
  }

  // Local Prime results retain the exact model-facing observations in rollout
  // conversation nodes rather than maze_ascii_frames. Pair every valid model
  // action with the user board that preceded it, then shift by one so replay
  // action N displays the observation delivered before action N+1. The last
  // board is held for the tail because no later model observation exists.
  let latestBoard = "";
  const preActionBoards = [];
  for (const message of messages) {
    if (message?.role === "user") {
      latestBoard = extractBoard(message.content) || latestBoard;
      continue;
    }
    if (
      message?.role === "assistant" &&
      latestBoard &&
      extractCommandFromAssistantText(messageContentToText(message.content))
    ) {
      preActionBoards.push(latestBoard);
    }
  }
  if (!preActionBoards.length) return [];

  const actionCount = extractActions(row).length || preActionBoards.length;
  const recovered = [preActionBoards[0]];
  for (let index = 0; index < actionCount; index += 1) {
    recovered.push(
      preActionBoards[index + 1] ||
      preActionBoards[Math.min(index, preActionBoards.length - 1)] ||
      recovered[recovered.length - 1]
    );
  }
  return recovered;
}

function extractExpectedVisualStates(row) {
  const info = row.info || {};
  const replay = row.maze_replay || info.maze_replay || {};
  const statuses =
    row.maze_action_statuses || info.maze_action_statuses || replay.action_statuses;
  return Array.isArray(statuses) ? statuses : [];
}

function expectedReplayPlayerState(status) {
  const hasExplicitPlayer = Boolean(
    status && Object.prototype.hasOwnProperty.call(status, "player")
  );
  return {
    known: hasExplicitPlayer || status?.player_dead === true,
    player: hasExplicitPlayer ? status.player || null : null
  };
}

function readJsonl(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Could not parse ${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

function readMetadata(resultsDir) {
  const metadataPath = path.join(resultsDir, "metadata.json");

  if (!fs.existsSync(metadataPath)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(metadataPath, "utf8"));
}

function messageContentToText(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (part && typeof part === "object") {
          return part.text || part.content || "";
        }

        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return content == null ? "" : String(content);
}

function normalizeDirection(value) {
  const direction = String(value || "").trim().toLowerCase();
  return DIRECTIONS.has(direction) ? direction : "";
}

function normalizeLevelToken(value) {
  return String(value || "").trim().replace(/^level_/i, "").toUpperCase();
}

function canonicalCommand(parsed) {
  if (!parsed) {
    return "";
  }

  if (parsed.command === "move") {
    return parsed.direction;
  }

  if (parsed.command === "rotate_camera") {
    return `rotate camera ${parsed.direction}`;
  }

  if (parsed.command === "goto_level") {
    return `go to level ${parsed.x} ${parsed.y}`;
  }

  if (parsed.command === "reset_level") {
    return "reset";
  }

  return parsed.command;
}

function parseCommandLine(line) {
  const cleaned = String(line || "")
    .trim()
    .replace(/^```(?:text|json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  if (!cleaned) {
    return null;
  }

  if (cleaned.startsWith("{")) {
    try {
      const payload = JSON.parse(cleaned);
      const command = String(payload.command || payload.action || "").trim().toLowerCase();
      const direction = normalizeDirection(payload.direction);

      if (command === "move" && direction) {
        return { command: "move", direction };
      }

      if ((command === "rotate_camera" || command === "rotate") && direction) {
        return { command: "rotate_camera", direction };
      }

      if (command === "goto_level" || command === "go_to_level" || command === "goto") {
        const level = normalizeLevelToken(payload.level);
        const x = String(payload.x || level[0] || "").toUpperCase();
        const y = String(payload.y || level[2] || "").toUpperCase();

        if (/^[A-Z]$/.test(x) && /^[A-Z]$/.test(y)) {
          return { command: "goto_level", x, y };
        }
      }

      if (command === "undo" || command === "quit") {
        return { command };
      }

      if (command === "no_move") {
        return { command: "no_move" };
      }

      if (command === "reset" || command === "reset_level") {
        return { command: "reset_level" };
      }
    } catch {
      return null;
    }
  }

  const lower = cleaned.toLowerCase();

  if (DIRECTIONS.has(lower)) {
    return { command: "move", direction: lower };
  }

  if (lower === "undo" || lower === "quit") {
    return { command: lower };
  }

  if (lower === "no move" || lower === "no_move") {
    return { command: "no_move" };
  }

  if (lower === "reset" || lower === "reset level" || lower === "reset_level") {
    return { command: "reset_level" };
  }

  let match = lower.match(/^rotate\s+camera\s+(up|down|left|right)$/);
  if (match) {
    return { command: "rotate_camera", direction: match[1] };
  }

  match = cleaned.match(/^go\s+to\s+level\s+([A-Za-z])\s+([A-Za-z])$/i);
  if (match) {
    return { command: "goto_level", x: match[1].toUpperCase(), y: match[2].toUpperCase() };
  }

  match = cleaned.match(/^go\s+to\s+level\s+level_([A-Za-z])x([A-Za-z])$/i);
  if (match) {
    return { command: "goto_level", x: match[1].toUpperCase(), y: match[2].toUpperCase() };
  }

  return null;
}

function extractCommandFromAssistantText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseCommandLine(lines[index]);

    if (parsed) {
      return canonicalCommand(parsed);
    }
  }

  return "";
}

function extractActionsFromState(row) {
  const info = row.info || {};
  const replay = row.maze_replay || info.maze_replay || {};
  const actionRecords = Array.isArray(row.maze_actions)
    ? row.maze_actions
    : Array.isArray(info.maze_actions)
      ? info.maze_actions
      : Array.isArray(replay.actions)
      ? replay.actions
      : null;

  if (!actionRecords) {
    return [];
  }

  return actionRecords
    .filter((record) => record && record.valid !== false)
    .map((record) => String(record.command || "").trim())
    .filter(Boolean);
}

function extractActionsFromCompletion(row) {
  const completion = Array.isArray(row.completion) ? row.completion : [];
  const actions = [];

  for (const message of completion) {
    if (!message || message.role !== "assistant") {
      continue;
    }

    const command = extractCommandFromAssistantText(messageContentToText(message.content));

    if (command) {
      actions.push(command);
    }
  }

  return actions;
}

function extractActionsFromNodes(row) {
  const nodes = Array.isArray(row.nodes) ? row.nodes : [];
  const actions = [];

  for (const node of nodes) {
    if (!node || node.message?.role !== "assistant") {
      continue;
    }

    const command = extractCommandFromAssistantText(messageContentToText(node.message.content));

    if (command) {
      actions.push(command);
    }
  }

  return actions;
}

function extractActions(row) {
  const stateActions = extractActionsFromState(row);
  if (stateActions.length > 0) {
    return stateActions;
  }

  const completionActions = extractActionsFromCompletion(row);
  return completionActions.length > 0 ? completionActions : extractActionsFromNodes(row);
}

function extractMazeOptions(row, metadata) {
  const info = row.info?.mazebench || row.info || {};
  const task = row.task || {};
  const replay = row.maze_replay || row.info?.maze_replay || {};
  const gameWonGemCount = 100;
  const view = String(info.view || task.view || replay.initial?.view || "top-diagonal");
  const yaw = Number(info.yaw ?? task.yaw ?? replay.initial?.yaw ?? 0);

  return {
    gameId: String(replay.game_id || info.game_id || task.game_id || "maze"),
    gameWonGemCount,
    levelId: String(replay.start_level_id || info.level_id || task.level_id || "level_HxI"),
    metadata,
    view: VIEW_NAMES.includes(view) ? view : "top-diagonal",
    yaw: Number.isInteger(yaw) ? yaw : 0
  };
}

function commandToBridgeMessage(commandText) {
  const parsed = parseCommandLine(commandText);

  if (!parsed) {
    throw new Error(`Cannot replay unsupported action: ${commandText}`);
  }

  if (parsed.command === "move") {
    return { command: "move", direction: parsed.direction };
  }

  if (parsed.command === "rotate_camera") {
    return { command: "rotate_camera", direction: parsed.direction };
  }

  if (parsed.command === "goto_level") {
    return { command: "goto_level", x: parsed.x, y: parsed.y };
  }

  if (parsed.command === "reset_level") {
    return { command: "reset_level" };
  }

  return { command: parsed.command };
}

function replayScorecard(actions, mazeOptions) {
  const args = [
    path.join(ROOT_DIR, "scripts", "maze-bridge.js"),
    "--level",
    mazeOptions.levelId,
    "--view",
    mazeOptions.view,
    "--yaw",
    String(mazeOptions.yaw),
    "--game-won-gem-count",
    String(mazeOptions.gameWonGemCount)
  ];
  const messages = [
    ...actions.map(commandToBridgeMessage),
    { command: "scorecard" },
    { command: "close" }
  ];
  const input = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    input,
    maxBuffer: 1024 * 1024 * 20
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || `maze-bridge exited with status ${result.status}`);
  }

  const responses = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const scorecardResponse = [...responses].reverse().find((response) => response.scorecard);

  if (!scorecardResponse?.scorecard) {
    throw new Error("maze-bridge did not return a scorecard");
  }

  return scorecardResponse.scorecard;
}

function existingScorecard(row) {
  if (row.maze_scorecard && Object.keys(row.maze_scorecard).length > 0) {
    return row.maze_scorecard;
  }

  if (row.info?.maze_scorecard && Object.keys(row.info.maze_scorecard).length > 0) {
    return row.info.maze_scorecard;
  }

  if (row.maze_replay?.scorecard && Object.keys(row.maze_replay.scorecard).length > 0) {
    return row.maze_replay.scorecard;
  }

  if (row.info?.maze_replay?.scorecard && Object.keys(row.info.maze_replay.scorecard).length > 0) {
    return row.info.maze_replay.scorecard;
  }

  return null;
}

function writeSidecarFiles(outDir, actions, scorecard) {
  ensureDir(outDir);
  const scorecardPath = path.join(outDir, "maze_scorecard.json");
  const actionsPath = path.join(outDir, "maze_actions.txt");

  fs.writeFileSync(scorecardPath, `${JSON.stringify(scorecard, null, 2)}\n`);
  fs.writeFileSync(actionsPath, `${actions.join("\n")}${actions.length > 0 ? "\n" : ""}`);

  return { actionsPath, scorecardPath };
}

function browserExecutablePath(browserOption) {
  if (!browserOption) {
    return "";
  }

  if (browserOption.includes("/") && fs.existsSync(browserOption)) {
    return browserOption;
  }

  const normalized = browserOption.toLowerCase();
  const namedPaths = {
    brave: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    chromium: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    edge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  };

  return namedPaths[normalized] || "";
}

function launchAttempts(browserOption) {
  const attempts = [];
  const executable = browserExecutablePath(browserOption);

  if (browserOption === "chrome") {
    attempts.push({ channel: "chrome" });
  } else if (browserOption === "edge") {
    attempts.push({ channel: "msedge" });
  }

  if (executable && fs.existsSync(executable)) {
    attempts.push({ executablePath: executable });
  }

  if (!browserOption) {
    attempts.push({ channel: "chrome" });
    for (const executablePath of DEFAULT_BROWSER_PATHS) {
      if (fs.existsSync(executablePath)) {
        attempts.push({ executablePath });
      }
    }
  }

  attempts.push({});
  return attempts;
}

async function launchBrowser(chromium, browserOption, { accelerated = false } = {}) {
  let lastError = null;
  const gpuArgs = accelerated && process.platform === "darwin"
    ? ["--enable-gpu", "--use-angle=metal"]
    : ["--use-angle=swiftshader"];

  for (const attempt of launchAttempts(browserOption)) {
    try {
      return await chromium.launch({
        ...attempt,
        args: [
          "--disable-dev-shm-usage",
          "--hide-scrollbars",
          "--mute-audio",
          ...gpuArgs
        ],
        headless: true
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Could not launch a Chromium browser");
}

async function startServer({
  expectedRawFrameBytes = 0,
  onRawFrame = null,
  recordedVideoPath = ""
} = {}) {
  const { createRequestHandler } = require(path.join(ROOT_DIR, "server", "app"));
  const appRequestHandler = createRequestHandler();
  const server = http.createServer((req, res) => {
    if (
      req.method === "POST" &&
      req.url === "/__maze_replay_video__" &&
      recordedVideoPath
    ) {
      const output = fs.createWriteStream(recordedVideoPath, { flags: "w" });
      let failed = false;
      const fail = (error) => {
        if (failed) return;
        failed = true;
        output.destroy();
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        }
        res.end(error instanceof Error ? error.message : String(error));
      };
      req.on("error", fail);
      output.on("error", fail);
      output.on("finish", () => {
        if (!failed) res.writeHead(204).end();
      });
      req.pipe(output);
      return;
    }

    if (
      req.method === "POST" &&
      req.url === "/__maze_replay_frame__" &&
      typeof onRawFrame === "function"
    ) {
      const chunks = [];
      let receivedBytes = 0;
      let rejected = false;

      req.on("data", (chunk) => {
        if (rejected) return;
        receivedBytes += chunk.length;

        if (expectedRawFrameBytes > 0 && receivedBytes > expectedRawFrameBytes) {
          rejected = true;
          res.writeHead(413).end("Replay frame is larger than expected");
          req.destroy();
          return;
        }

        chunks.push(chunk);
      });
      req.on("end", async () => {
        if (rejected) return;

        try {
          if (expectedRawFrameBytes > 0 && receivedBytes !== expectedRawFrameBytes) {
            throw new Error(
              `Replay frame has ${receivedBytes} bytes; expected ${expectedRawFrameBytes}`
            );
          }

          await onRawFrame(Buffer.concat(chunks, receivedBytes));
          res.writeHead(204).end();
        } catch (error) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(error instanceof Error ? error.message : String(error));
        }
      });
      req.on("error", () => {
        if (!res.headersSent) res.writeHead(400);
        res.end();
      });
      return;
    }

    appRequestHandler(req, res);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Could not start local replay server");
  }

  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    port: address.port
  };
}

function frameName(index) {
  return `frame-${String(index).padStart(6, "0")}.png`;
}

function progressBar(percent, width = 24) {
  const safePercent = Math.max(0, Math.min(1, Number(percent) || 0));
  const filled = Math.round(safePercent * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return "--";
  }

  const seconds = Math.ceil(milliseconds / 1000);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function humanBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let size = Math.max(0, Number(bytes) || 0);
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

// Set by renderReplayVideo so progress reporters can publish a machine-readable
// percent the web UI polls for a replay progress bar.
let replayProgressFile = null;

function writeReplayProgress(payload) {
  if (!replayProgressFile) {
    return;
  }

  try {
    fs.writeFileSync(replayProgressFile, `${JSON.stringify(payload)}\n`);
  } catch (_error) {
    /* best effort — the bar just won't update */
  }
}

function createProgressReporter({
  estimateBytes = 0,
  label,
  overallEnd = 100,
  overallStart = 0,
  total,
  unit = "frames",
  phase = ""
}) {
  const startedAtMs = Date.now();
  const tty = Boolean(process.stdout.isTTY);
  let safeTotal = Math.max(1, Number(total) || 1);
  let current = 0;
  let highestPercent = 0;
  let lastLineLength = 0;
  let lastWriteMs = 0;

  function progressText(value) {
    if (unit === "seconds") {
      return `${value.toFixed(1)}s/${safeTotal.toFixed(1)}s`;
    }

    return `${Math.round(value)}/${Math.round(safeTotal)} ${unit}`;
  }

  function render(value = current, {
    force = false,
    nextEstimateBytes = estimateBytes,
    nextTotal = safeTotal
  } = {}) {
    current = Math.max(0, Number(value) || 0);
    estimateBytes = nextEstimateBytes;
    safeTotal = Math.max(current, Number(nextTotal) || safeTotal, 1);
    const now = Date.now();
    const measuredPercent = Math.max(0, Math.min(1, current / safeTotal));
    const percent = Math.max(highestPercent, measuredPercent);
    highestPercent = percent;

    if (!force && !tty && now - lastWriteMs < 1000) {
      return;
    }

    const elapsedMs = now - startedAtMs;
    const etaMs =
      measuredPercent > 0
        ? (elapsedMs / measuredPercent) * (1 - measuredPercent)
        : Infinity;
    const overallPercent = overallStart + percent * (overallEnd - overallStart);
    const line = `${label} ${progressBar(percent)} ${Math.round(
      percent * 100
    )}% | ${progressText(current)} | ETA ${formatDuration(
      etaMs
    )} | expected MP4 ~${humanBytes(estimateBytes)}`;

    if (tty) {
      process.stdout.write(`\r${line}${" ".repeat(Math.max(0, lastLineLength - line.length))}`);
      lastLineLength = line.length;
    } else {
      console.log(line);
    }

    writeReplayProgress({
      phase: phase || label,
      percent: Math.round(overallPercent),
      phase_percent: Math.round(percent * 100),
      current: Math.round(current),
      total: Math.round(safeTotal),
      unit,
      elapsed_ms: elapsedMs,
      rate_per_second: elapsedMs > 0 ? Math.round((current / elapsedMs) * 100_000) / 100 : null,
      eta_ms: Number.isFinite(etaMs) ? Math.round(etaMs) : null
    });

    lastWriteMs = now;
  }

  function finish(message = "") {
    render(safeTotal, { force: true });

    if (tty) {
      process.stdout.write("\n");
    }

    if (message) {
      console.log(message);
    }
  }

  return { finish, render };
}

function estimatedActionSeconds(parsed, options) {
  if (!parsed) {
    return 0;
  }

  if (parsed.command === "move") {
    return Math.max(0.08, (0.16 * options.motionScale) / options.moveSpeed);
  }

  if (parsed.command === "rotate_camera") {
    const baseMs = parsed.direction === "left" || parsed.direction === "right" ? 780 : 620;
    return Math.max(0.15, baseMs / 1000 / options.cameraSpeed);
  }

  if (parsed.command === "goto_level") {
    return 2;
  }

  if (parsed.command === "undo" || parsed.command === "reset_level") {
    return Math.max(0.08, (0.16 * options.motionScale) / options.moveSpeed);
  }

  if (parsed.command === "quit") {
    return 1 / options.fps;
  }

  return 0.1;
}

const REPLAY_INTRO_EDGE_SECONDS = 2.2;
const REPLAY_INTRO_DIVE_SECONDS = 0.9;

function estimateCaptureFrameCount(actions, options) {
  const parsedActions = actions.map(parseCommandLine).filter(Boolean);
  const tailFrames = Math.round(options.tailSeconds * options.fps);
  const introFrames =
    options.intro && !options.fast
      ? Math.round((REPLAY_INTRO_EDGE_SECONDS + REPLAY_INTRO_DIVE_SECONDS) * options.fps)
      : 0;

  if (options.fast) {
    return Math.max(1, 1 + introFrames + parsedActions.length + tailFrames);
  }

  const actionFrames = parsedActions.reduce(
    (total, parsed) => total + Math.max(1, Math.ceil(estimatedActionSeconds(parsed, options) * options.fps)),
    0
  );
  return Math.max(1, 1 + introFrames + actionFrames + tailFrames);
}

function nativeRecorderBitsPerSecond(options) {
  const relativePixels = (options.width * options.height) / (960 * 960);
  return Math.round(
    Math.max(2_000_000, Math.min(16_000_000, 6_000_000 * relativePixels))
  );
}

function estimatedVideoBytes(frameCount, options) {
  if (options.accelerated && options.nativeRecorder) {
    // Native capture is deliberately paced at 10ms, with rendering and IPC
    // bringing measured production cadence to roughly 24ms per frame.
    return Math.max(
      10 * 1024,
      (frameCount * 0.024 * nativeRecorderBitsPerSecond(options)) / 8
    );
  }

  const evenWidth = Math.max(2, Math.floor(options.width / 2) * 2);
  const evenHeight = Math.max(2, Math.floor(options.height / 2) * 2);
  const durationSeconds = Math.max(0.1, frameCount / options.fps);
  const pixels = evenWidth * evenHeight;
  const crfFactor = Math.pow(2, (23 - options.crf) / 6);
  const motionFactor = options.fast ? 0.75 : 1.25;
  const containerOverheadBytes = 10 * 1024;
  const estimatedBits = durationSeconds * pixels * motionFactor * crfFactor;

  return Math.max(containerOverheadBytes, containerOverheadBytes + estimatedBits / 8);
}

function parseFfmpegProgressSeconds(line) {
  const [key, rawValue] = String(line || "").split("=");
  const value = String(rawValue || "").trim();

  if (key === "out_time_us" || key === "out_time_ms") {
    const microseconds = Number(value);
    return Number.isFinite(microseconds) ? microseconds / 1000000 : null;
  }

  if (key === "out_time") {
    const match = value.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);

    if (match) {
      return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    }
  }

  return null;
}

async function encodeVideo(ffmpegArgs, { durationSeconds, estimateBytes }) {
  const progress = createProgressReporter({
    estimateBytes,
    label: "Encoding video",
    phase: "encoding",
    overallStart: 92,
    overallEnd: 100,
    total: Math.max(0.1, durationSeconds),
    unit: "seconds"
  });

  progress.render(0, { force: true });

  await new Promise((resolve, reject) => {
    const encode = spawn("ffmpeg", ffmpegArgs, {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let stdoutBuffer = "";

    encode.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        const seconds = parseFfmpegProgressSeconds(line);

        if (seconds !== null) {
          progress.render(Math.min(seconds, durationSeconds), { nextEstimateBytes: estimateBytes });
        } else if (line === "progress=end") {
          progress.render(durationSeconds, { force: true, nextEstimateBytes: estimateBytes });
        }
      }
    });

    encode.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    encode.on("error", reject);
    encode.on("close", (status) => {
      if (status === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `ffmpeg exited with status ${status}`));
      }
    });
  });

  progress.finish(`Encoded video; expected MP4 ~${humanBytes(estimateBytes)}.`);
}

const VIDEO_SIZE_TARGET_RATIO = 0.96;

function targetVideoBitrate(maxVideoMiB, durationSeconds) {
  if (
    !Number.isFinite(maxVideoMiB) ||
    maxVideoMiB <= 0 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return 0;
  }

  const maxBytes = maxVideoMiB * 1024 * 1024;
  return Math.max(1, Math.floor((maxBytes * 8 * VIDEO_SIZE_TARGET_RATIO) / durationSeconds));
}

function replayTranscodeArguments(sourcePath, targetPath, options, settings = {}) {
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostats",
    "-progress",
    "pipe:1",
    "-i",
    sourcePath,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    options.preset
  ];

  if (settings.bitrate) {
    args.push("-b:v", String(settings.bitrate));
  } else {
    args.push("-crf", String(options.crf));
  }

  args.push("-pix_fmt", "yuv420p");

  if (settings.pass) {
    args.push("-pass", String(settings.pass), "-passlogfile", settings.passLogPath);
  }

  if (settings.pass === 1) {
    args.push("-f", "null", process.platform === "win32" ? "NUL" : "/dev/null");
  } else {
    args.push("-movflags", "+faststart", targetPath);
  }

  return args;
}

function replaceVideoFile(sourcePath, targetPath) {
  fs.rmSync(targetPath, { force: true });
  fs.renameSync(sourcePath, targetPath);
}

function removePassLogs(passLogPath) {
  for (const suffix of ["-0.log", "-0.log.mbtree", ".log", ".log.mbtree"]) {
    fs.rmSync(`${passLogPath}${suffix}`, { force: true });
  }
}

async function optimizeNativeReplayVideo(sourcePath, videoPath, options, durationSeconds) {
  const extension = path.extname(videoPath);
  const optimizedPath = path.join(path.dirname(videoPath), `.maze_replay.optimized${extension}`);
  fs.rmSync(optimizedPath, { force: true });

  try {
    await encodeVideo(
      replayTranscodeArguments(sourcePath, optimizedPath, options),
      {
        durationSeconds,
        estimateBytes: fs.statSync(sourcePath).size
      }
    );
    replaceVideoFile(optimizedPath, videoPath);
  } finally {
    fs.rmSync(optimizedPath, { force: true });
  }
}

async function capReplayVideoSize(videoPath, options, durationSeconds) {
  if (!options.maxVideoMiB) return;

  const maxBytes = Math.floor(options.maxVideoMiB * 1024 * 1024);
  const currentBytes = fs.statSync(videoPath).size;
  if (currentBytes <= maxBytes) return;

  let bitrate = targetVideoBitrate(options.maxVideoMiB, durationSeconds);
  const extension = path.extname(videoPath);
  const cappedPath = path.join(path.dirname(videoPath), `.maze_replay.capped${extension}`);
  const passLogPath = path.join(path.dirname(videoPath), ".maze_replay.passlog");
  fs.rmSync(cappedPath, { force: true });
  removePassLogs(passLogPath);

  console.log(
    `Optimized replay is ${humanBytes(currentBytes)}; constraining it to ` +
      `${options.maxVideoMiB} MiB.`
  );

  try {
    let cappedBytes = Infinity;
    for (let attempt = 1; attempt <= 3 && cappedBytes > maxBytes; attempt += 1) {
      fs.rmSync(cappedPath, { force: true });
      removePassLogs(passLogPath);
      await encodeVideo(
        replayTranscodeArguments(videoPath, cappedPath, options, {
          bitrate,
          pass: 1,
          passLogPath
        }),
        { durationSeconds, estimateBytes: maxBytes }
      );
      await encodeVideo(
        replayTranscodeArguments(videoPath, cappedPath, options, {
          bitrate,
          pass: 2,
          passLogPath
        }),
        { durationSeconds, estimateBytes: maxBytes }
      );
      cappedBytes = fs.statSync(cappedPath).size;
      if (cappedBytes > maxBytes && attempt < 3) {
        bitrate = Math.max(
          1,
          Math.floor(bitrate * (maxBytes / cappedBytes) * VIDEO_SIZE_TARGET_RATIO)
        );
        console.log(
          `Capped replay is still ${humanBytes(cappedBytes)}; retrying with a corrected bitrate.`
        );
      }
    }

    if (cappedBytes > maxBytes) {
      throw new Error(
        `Could not constrain replay video below ${options.maxVideoMiB} MiB ` +
          `(encoded ${humanBytes(cappedBytes)})`
      );
    }
    replaceVideoFile(cappedPath, videoPath);
  } finally {
    fs.rmSync(cappedPath, { force: true });
    removePassLogs(passLogPath);
  }
}

function countedVideoFrames(videoPath) {
  const probe = spawnSync("ffprobe", [
    "-v",
    "error",
    "-count_frames",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=nb_read_frames",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    videoPath
  ], { encoding: "utf8" });
  const count = Number(String(probe.stdout || "").trim());
  if (probe.status !== 0 || !Number.isInteger(count) || count <= 0) {
    throw new Error(probe.stderr || "Could not count native replay frames");
  }
  return count;
}

function nativeCaptureGuardFrameCount(requestedFrames) {
  if (!Number.isInteger(requestedFrames) || requestedFrames <= 0) return 0;
  return Math.max(8, Math.ceil(requestedFrames / 200));
}

function nativeFrameCountIsAcceptable(retainedFrames, requestedFrames, guardFrames = 0) {
  return (
    Number.isInteger(retainedFrames) &&
    Number.isInteger(requestedFrames) &&
    Number.isInteger(guardFrames) &&
    retainedFrames > 0 &&
    requestedFrames > 0 &&
    guardFrames >= 0 &&
    retainedFrames >= requestedFrames &&
    retainedFrames <= requestedFrames + guardFrames
  );
}

function startRawVideoEncoder(videoPath, options) {
  const width = Math.max(2, Math.floor(options.width / 2) * 2);
  const height = Math.max(2, Math.floor(options.height / 2) * 2);
  const extension = path.extname(videoPath);
  const renderingPath = path.join(
    path.dirname(videoPath),
    `.maze_replay.rendering${extension}`
  );
  fs.rmSync(renderingPath, { force: true });

  const encoder = spawn("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostats",
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgba",
    "-video_size",
    `${width}x${height}`,
    "-framerate",
    String(options.fps),
    "-i",
    "pipe:0",
    "-vf",
    "format=yuv420p",
    "-r",
    String(options.fps),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    options.preset,
    "-crf",
    String(options.crf),
    "-movflags",
    "+faststart",
    renderingPath
  ], {
    cwd: ROOT_DIR,
    stdio: ["pipe", "ignore", "pipe"]
  });
  let stderr = "";
  let aborted = false;
  let settled = false;
  let queuedFrames = 0;
  let writeError = null;
  let writeChain = Promise.resolve();
  const capacityWaiters = [];
  const completed = new Promise((resolve, reject) => {
    encoder.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    encoder.on("error", reject);
    encoder.on("close", (status) => {
      settled = true;
      if (aborted) {
        resolve();
      } else if (status === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `ffmpeg exited with status ${status}`));
      }
    });
  });
  // A failed encoder reports through the awaited write/finish operations. This
  // listener prevents an EPIPE from becoming a separate uncaught exception.
  encoder.stdin.on("error", () => {});

  async function writeFrameNow(buffer) {
    if (aborted || settled || !encoder.stdin.writable) {
      throw new Error(stderr || "Replay encoder stopped before the final frame");
    }

    await new Promise((resolve, reject) => {
      encoder.stdin.write(buffer, (error) => (error ? reject(error) : resolve()));
    });
  }

  return {
    expectedFrameBytes: width * height * 4,
    async writeFrame(buffer) {
      if (buffer.length !== width * height * 4) {
        throw new Error(
          `Replay frame has ${buffer.length} bytes; expected ${width * height * 4}`
        );
      }

      // Keep a small bounded queue so Chromium can render the next frame while
      // ffmpeg converts/encodes the previous one. The old per-frame drain wait
      // serialized the GPU, localhost transfer, colorspace conversion, and
      // x264 even though they use independent resources.
      while (queuedFrames >= 8 && !writeError) {
        await new Promise((resolve) => capacityWaiters.push(resolve));
      }
      if (writeError) throw writeError;
      queuedFrames += 1;
      writeChain = writeChain
        .then(() => writeFrameNow(buffer))
        .catch((error) => {
          writeError = error;
        })
        .finally(() => {
          queuedFrames -= 1;
          capacityWaiters.shift()?.();
        });
    },
    async finish() {
      await writeChain;
      if (writeError) throw writeError;
      if (!encoder.stdin.destroyed && !encoder.stdin.writableEnded) {
        encoder.stdin.end();
      }
      await completed;
      fs.renameSync(renderingPath, videoPath);
    },
    async abort() {
      if (aborted) return;
      aborted = true;
      if (!encoder.stdin.destroyed) encoder.stdin.destroy();
      if (!settled) encoder.kill("SIGTERM");
      await completed.catch(() => {});
      fs.rmSync(renderingPath, { force: true });
    }
  };
}

async function renderReplayVideo(
  actions,
  mazeOptions,
  outDir,
  options,
  asciiFrames = [],
  expectedVisualStates = []
) {
  const ffmpegCheck = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });

  if (ffmpegCheck.error || ffmpegCheck.status !== 0) {
    throw new Error("ffmpeg is required to render maze_replay video");
  }

  replayProgressFile = path.join(outDir, "replay-progress.json");
  writeReplayProgress({ phase: "starting", percent: 0 });

  const { chromium } = await import("playwright-core");
  const framesDir = path.join(outDir, ".maze_replay_frames");
  const videoPath = path.join(outDir, `maze_replay.${options.format}`);
  const useNativeRecorder = Boolean(options.accelerated && options.nativeRecorder);
  const recordedVideoPath = path.join(outDir, ".maze_replay.captured.mp4");
  const estimatedFrames = estimateCaptureFrameCount(actions, options);
  let estimatedBytes = estimatedVideoBytes(estimatedFrames, options);
  let captureProgress = null;
  let frameIndex = 0;
  let nativeGuardFrames = 0;
  let lastFrameBuffer = null;
  const diagnosticsEnabled = process.env.MAZE_REPLAY_DIAGNOSTICS === "1";
  const replayManifest = {
    accelerated: Boolean(options.accelerated),
    actions: [],
    fps: options.fps,
    height: options.height,
    width: options.width
  };
  const rawEncoder = options.accelerated && !useNativeRecorder
    ? startRawVideoEncoder(videoPath, options)
    : null;
  if (useNativeRecorder) fs.rmSync(recordedVideoPath, { force: true });
  let server = null;
  let browser = null;
  try {
    server = await startServer({
      expectedRawFrameBytes: rawEncoder?.expectedFrameBytes || 0,
      recordedVideoPath: useNativeRecorder ? recordedVideoPath : "",
      onRawFrame: rawEncoder
        ? async (buffer) => {
            await rawEncoder.writeFrame(buffer);
            lastFrameBuffer = buffer;
            frameIndex += 1;
            estimatedBytes = estimatedVideoBytes(Math.max(frameIndex, estimatedFrames), options);
            captureProgress?.render(frameIndex, { nextEstimateBytes: estimatedBytes });
          }
        : null
    });
    browser = await launchBrowser(chromium, options.browser, {
      accelerated: Boolean(options.accelerated)
    });
  } catch (error) {
    await rawEncoder?.abort();
    await server?.close().catch(() => {});
    throw error;
  }
  let terminating = false;
  const terminateRenderer = () => {
    if (terminating) return;
    terminating = true;
    const forceExit = setTimeout(() => process.exit(143), 3000);
    Promise.allSettled([
      rawEncoder?.abort(),
      browser?.close(),
      server?.close()
    ]).finally(() => {
      if (useNativeRecorder) fs.rmSync(recordedVideoPath, { force: true });
      clearTimeout(forceExit);
      process.exit(143);
    });
  };
  process.once("SIGINT", terminateRenderer);
  process.once("SIGTERM", terminateRenderer);
  let captureSucceeded = false;

  if (!options.accelerated) {
    fs.rmSync(framesDir, { force: true, recursive: true });
    ensureDir(framesDir);
  }

  try {
    const visualWidth = options.asciiSideBySide ? Math.floor(options.width / 2) : options.width;
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: { width: visualWidth, height: options.height }
    });
    const levelUrl = `http://127.0.0.1:${server.port}/play/${encodeURIComponent(
      mazeOptions.gameId
    )}/${encodeURIComponent(mazeOptions.levelId)}`;

    await page.addInitScript(({ accelerated, frameStepMs }) => {
      window.__PIXEL_GAME_DEBUG__ = true;
      window.__PIXEL_GAME_REPLAY_CAPTURE__ = true;
      if (!accelerated) return;

      const nativeSetTimeout = window.setTimeout.bind(window);
      const nativePerformanceNow = performance.now.bind(performance);
      let syntheticNow = nativePerformanceNow();
      let nextFrameId = 1;
      let frameCallbacks = new Map();
      window.requestAnimationFrame = (callback) => {
        const frameId = nextFrameId;
        nextFrameId += 1;
        frameCallbacks.set(frameId, callback);
        return frameId;
      };
      window.cancelAnimationFrame = (frameId) => {
        frameCallbacks.delete(frameId);
      };
      window.__syncMazeReplayClock__ = () => {
        syntheticNow = nativePerformanceNow();
      };
      window.__advanceMazeReplayFrame__ = async () => {
        syntheticNow += frameStepMs;
        window.__MAZE_REPLAY_NOW__ = syntheticNow;
        const callbacks = frameCallbacks;
        frameCallbacks = new Map();

        for (const callback of callbacks.values()) {
          callback(syntheticNow);
        }

        await Promise.resolve();
        await new Promise((resolve) => nativeSetTimeout(resolve, 0));
      };
    }, {
      accelerated: Boolean(options.accelerated),
      // Advance exactly one output-frame interval. This samples the real
      // animation timeline at the requested FPS instead of recording every
      // 60 Hz browser tick and then playing those ticks back at 24 FPS, which
      // made room transitions about 2.5x slower than the game.
      frameStepMs: 1000 / options.fps
    });
    await page.goto(levelUrl, { waitUntil: "networkidle" });
    if (options.accelerated) {
      let ready = false;
      for (let attempt = 0; attempt < 600; attempt += 1) {
        ready = await page.evaluate(() => {
          const app = window.__PIXEL_GAME_APP__;
          return Boolean(app?.movement && app?.threeRenderer && app?.render);
        });
        if (ready) break;
        await page.evaluate(() => window.__advanceMazeReplayFrame__?.());
        await page.waitForTimeout(10);
      }
      if (!ready) throw new Error("The accelerated replay page did not initialize");
    } else {
      await page.waitForFunction(() => {
        const app = window.__PIXEL_GAME_APP__;
        return Boolean(app?.movement && app?.threeRenderer && app?.render);
      });
    }
    if (mazeOptions.playData) {
      await page.evaluate(async (playData) => {
        const app = window.__PIXEL_GAME_APP__;
        if (!app || typeof app.applyLevelState !== "function") {
          throw new Error("The replay page cannot apply a solution room snapshot.");
        }

        app.applyLevelState(playData, {
          deferRender: true,
          immediateCamera: true,
          resetHistory: true,
          resetLevelEntry: true
        });
        await app.preloadImagesForLevelState?.(playData);
        await app.threeRenderer?.whenLevelStateModelsReady?.(playData);
        app.render(performance.now());
      }, mazeOptions.playData);
    }
    await page.addStyleTag({
      content: `
        html, body {
          background: #050608 !important;
          height: 100% !important;
          margin: 0 !important;
          overflow: hidden !important;
          width: 100% !important;
        }
        .play-shell {
          display: block !important;
          height: 100vh !important;
          min-height: 100vh !important;
          width: 100vw !important;
        }
        .play-header {
          display: none !important;
        }
        .play-stage,
        .maze-frame {
          border: 0 !important;
          border-radius: 0 !important;
          box-shadow: none !important;
          height: 100vh !important;
          margin: 0 !important;
          max-height: none !important;
          max-width: none !important;
          padding: 0 !important;
          width: 100vw !important;
        }
        #maze-canvas {
          display: block !important;
          height: 100vh !important;
          width: 100vw !important;
        }
      `
    });
    await page.evaluate(async ({ accelerated, asciiSideBySide, draft, edges, fast, fps, height, motionScale, moveSpeed, nativeRecorder, outputWidth, width }) => {
      const app = window.__PIXEL_GAME_APP__;
      // Agent sessions record deaths as terminal states until the model
      // explicitly chooses undo, reset, or a room change. The interactive
      // player normally auto-undoes falls, which advances only the visual
      // replay and makes it diverge from the recorded text observations.
      app.autoUndoPlayerFalls = false;
      const pngDataUrl = (canvas) => new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error("Could not encode replay frame"));
            return;
          }
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error || new Error("Could not read replay frame"));
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        }, "image/png");
      });
      const rawFrame = async (canvas) => {
        const context = canvas.getContext("2d", { willReadFrequently: true });
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        return postRawPixels(pixels.buffer);
      };
      const postRawPixels = async (buffer) => {
        const response = await fetch("/__maze_replay_frame__", {
          body: buffer,
          cache: "no-store",
          method: "POST"
        });
        if (!response.ok) {
          throw new Error((await response.text()) || "Could not stream replay frame");
        }
      };
      const rawSourceFrame = async (source, targetWidth, targetHeight) => {
        if (
          source === app.canvas &&
          app.gl &&
          source.width === targetWidth &&
          source.height === targetHeight
        ) {
          const gl = app.gl;
          const rowBytes = source.width * 4;
          const bottomUp = new Uint8Array(source.width * source.height * 4);
          const topDown = new Uint8Array(bottomUp.length);
          gl.readPixels(0, 0, source.width, source.height, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp);
          for (let y = 0; y < source.height; y += 1) {
            const sourceRow = source.height - 1 - y;
            topDown.set(
              bottomUp.subarray(sourceRow * rowBytes, (sourceRow + 1) * rowBytes),
              y * rowBytes
            );
          }
          return postRawPixels(topDown.buffer);
        }

        return rawFrame(fittedCanvas(source, targetWidth, targetHeight));
      };
      const fittedCanvas = (source, targetWidth, targetHeight, targetCanvas = null) => {
        const canvas = targetCanvas || document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.fillStyle = "#050608";
        context.fillRect(0, 0, targetWidth, targetHeight);
        const scale = Math.min(targetWidth / source.width, targetHeight / source.height);
        const drawWidth = source.width * scale;
        const drawHeight = source.height * scale;
        context.drawImage(
          source,
          (targetWidth - drawWidth) / 2,
          (targetHeight - drawHeight) / 2,
          drawWidth,
          drawHeight
        );
        return canvas;
      };

      window.__MAZE_REPLAY_COMPOSITE__ = {
        action: 0,
        ascii: "",
        canvas: asciiSideBySide || nativeRecorder ? document.createElement("canvas") : null,
        enabled: asciiSideBySide,
        height,
        width: outputWidth
      };
      if (window.__MAZE_REPLAY_COMPOSITE__.canvas) {
        window.__MAZE_REPLAY_COMPOSITE__.canvas.width = outputWidth;
        window.__MAZE_REPLAY_COMPOSITE__.canvas.height = height;
      }
      const captureNativeFrame = async () => {
        const track = window.__MAZE_REPLAY_NATIVE_TRACK__;
        if (!track || typeof track.requestFrame !== "function") {
          throw new Error("Native replay recorder is not ready");
        }
        const canvas = window.__MAZE_REPLAY_COMPOSITE__.canvas;
        const context = canvas.getContext("2d");
        window.__MAZE_REPLAY_NATIVE_FRAME_SERIAL__ =
          (window.__MAZE_REPLAY_NATIVE_FRAME_SERIAL__ || 0) + 1;
        // Ensure blocked moves and tail holds still become distinct encoded
        // frames. The alternating pixel stays in the padded background.
        context.fillStyle = window.__MAZE_REPLAY_NATIVE_FRAME_SERIAL__ % 2
          ? "rgb(5,6,8)"
          : "rgb(5,6,9)";
        context.fillRect(canvas.width - 1, canvas.height - 1, 1, 1);
        track.requestFrame();
        // MediaRecorder coalesces frames requested in the same media tick.
        // Ten milliseconds retained 120/120 requested 960p frames in QA while
        // remaining far faster than synchronous WebGL readback.
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      };
      window.__startMazeReplayNativeRecorder__ = async (videoBitsPerSecond) => {
        if (!nativeRecorder) return;
        const mimeType = "video/mp4;codecs=avc1.42E01E";
        if (
          typeof MediaRecorder !== "function" ||
          !MediaRecorder.isTypeSupported(mimeType)
        ) {
          throw new Error("Chrome does not support native H.264 replay recording");
        }
        const source = nativeRecorder
          ? window.__MAZE_REPLAY_COMPOSITE__.canvas
          : app.canvas;
        const stream = source.captureStream(0);
        const track = stream.getVideoTracks()[0];
        const chunks = [];
        const recorder = new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond
        });
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        });
        window.__MAZE_REPLAY_NATIVE_TRACK__ = track;
        window.__MAZE_REPLAY_NATIVE_RECORDER__ = recorder;
        window.__MAZE_REPLAY_NATIVE_CHUNKS__ = chunks;
        recorder.start(5000);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      };
      window.__finishMazeReplayNativeRecorder__ = async () => {
        const recorder = window.__MAZE_REPLAY_NATIVE_RECORDER__;
        if (!recorder) throw new Error("Native replay recorder was not started");
        await new Promise((resolve, reject) => {
          recorder.addEventListener("stop", resolve, { once: true });
          recorder.addEventListener("error", () => reject(recorder.error), { once: true });
          recorder.stop();
        });
        const blob = new Blob(window.__MAZE_REPLAY_NATIVE_CHUNKS__, {
          type: recorder.mimeType
        });
        const response = await fetch("/__maze_replay_video__", {
          body: blob,
          cache: "no-store",
          method: "POST"
        });
        if (!response.ok) {
          throw new Error((await response.text()) || "Could not upload native replay video");
        }
        window.__MAZE_REPLAY_NATIVE_TRACK__?.stop();
        return blob.size;
      };
      window.__captureMazeReplayFrame__ = async () => {
        const source =
          app?.canvas ||
          app?.viewCanvas ||
          app?.sceneCanvas ||
          document.getElementById("maze-canvas");
        if (!source) throw new Error("Could not find a replay canvas");

        const composite = window.__MAZE_REPLAY_COMPOSITE__;
        if (!composite?.enabled) {
          if (!accelerated) return pngDataUrl(source);
          if (nativeRecorder) {
            fittedCanvas(source, composite.width, composite.height, composite.canvas);
            return captureNativeFrame();
          }
          return rawSourceFrame(source, composite.width, composite.height);
        }

        const canvas = composite.canvas || document.createElement("canvas");
        canvas.width = composite.width;
        canvas.height = composite.height;
        const context = canvas.getContext("2d");
        const visualWidth = Math.floor(canvas.width / 2);
        const asciiX = visualWidth;
        context.fillStyle = "#050713";
        context.fillRect(0, 0, canvas.width, canvas.height);

        const visualSource = source;
        const visualScale = Math.min(
          visualWidth / visualSource.width,
          canvas.height / visualSource.height
        );
        const drawWidth = visualSource.width * visualScale;
        const drawHeight = visualSource.height * visualScale;
        context.drawImage(
          visualSource,
          (visualWidth - drawWidth) / 2,
          (canvas.height - drawHeight) / 2,
          drawWidth,
          drawHeight
        );

        const divider = context.createLinearGradient(0, 0, 0, canvas.height);
        divider.addColorStop(0, "rgba(52,231,240,0)");
        divider.addColorStop(0.18, "rgba(52,231,240,0.75)");
        divider.addColorStop(0.82, "rgba(139,123,255,0.75)");
        divider.addColorStop(1, "rgba(139,123,255,0)");
        context.fillStyle = divider;
        context.fillRect(asciiX - 1, 0, 2, canvas.height);

        context.textBaseline = "top";
        const terminalColumns = 64;
        const terminalRows = 64;
        const lines = String(composite.ascii || "").split(/\r?\n/).slice(0, terminalRows);
        const availableWidth = canvas.width - asciiX - 44;
        const availableHeight = canvas.height - 64;
        const terminalFont = '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace';
        let fontSize = Math.min(13, availableHeight / terminalRows);
        context.font = `${fontSize}px ${terminalFont}`;
        const cellWidth = Math.max(1, context.measureText("M").width);
        fontSize *= Math.min(1, availableWidth / (cellWidth * terminalColumns));
        const lineHeight = availableHeight / terminalRows;
        context.fillStyle = "#d9e4ff";
        context.font = `${fontSize}px ${terminalFont}`;
        context.save();
        context.beginPath();
        context.rect(asciiX + 22, 54, availableWidth, availableHeight);
        context.clip();
        lines.forEach((line, index) => {
          context.fillText(line.slice(0, terminalColumns), asciiX + 22, 54 + index * lineHeight);
        });
        context.restore();
        context.fillStyle = "rgba(5,7,19,0.96)";
        context.fillRect(asciiX + 2, 0, visualWidth - 2, 47);
        context.fillStyle = "#65f3d4";
        context.font = "700 15px ui-monospace, SFMono-Regular, Menlo, monospace";
        context.textAlign = "left";
        context.fillText("What the model sees:", asciiX + 22, 18);
        context.fillStyle = "rgba(154,163,199,0.82)";
        context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
        context.textAlign = "right";
        context.fillText(`ACTION ${composite.action}`, canvas.width - 22, 21);
        context.textAlign = "left";
        if (!accelerated) return pngDataUrl(canvas);
        return nativeRecorder ? captureNativeFrame() : rawFrame(canvas);
      };

      if (draft) {
        const replayScale = Math.max(
          0.1,
          Math.min(1, width / app.viewportRect.width, height / app.viewportRect.height)
        );
        Object.defineProperty(window, "devicePixelRatio", {
          configurable: true,
          get: () => replayScale
        });
      }

      window.dispatchEvent(new Event("resize"));
      app.syncPlayLayout?.();
      app.setupCanvas?.();
      app.replayAnimationFrameStepMs = 1000 / fps;
      // Draft trades the fuzzy (CRT noise) post effect for capture speed, but
      // the black edge outlines stay on unless --no-edges: they're part of how
      // the game reads in the browser, and replays should match it.
      app.state.effects.fuzzyEnabled = !draft;
      app.state.effects.edgeOutlinesEnabled = edges;
      app.state.effects.noisePhase = 0;

      if (app.noiseFrameId !== null) {
        window.cancelAnimationFrame(app.noiseFrameId);
        app.noiseFrameId = null;
      }

      app.syncFuzzyToggle?.();
      app.syncEdgeToggle?.();

      [
        "MOVE_DURATION_MS",
        "GATE_RISE_DURATION_MS",
        "GATE_FALL_DURATION_MS",
        "ORANGE_WALL_RISE_DURATION_MS",
        "ORANGE_WALL_FALL_DURATION_MS",
        "PLAYER_LIFT_RISE_DURATION_MS",
        "PLAYER_LIFT_FALL_DURATION_MS",
        "HOLE_FALL_DURATION_MS",
        "LEVEL_TRANSITION_DURATION_MS"
      ].forEach((key) => {
        if (Number.isFinite(app[key])) {
          app[key] = fast ? 1 : app[key] * motionScale / moveSpeed;
        }
      });

      app.replayMoveDurationMs = Number.isFinite(app.MOVE_DURATION_MS)
        ? app.MOVE_DURATION_MS
        : null;
      await app.preloadImages?.();
      await app.threeRendererReady;
      app.syncCameraTarget?.(true);
      app.render?.();
    }, {
      draft: Boolean(options.draft),
      edges: options.edges !== false,
      fast: Boolean(options.fast),
      fps: options.fps,
      height: options.height,
      motionScale: options.motionScale,
      moveSpeed: options.moveSpeed,
      outputWidth: options.width,
      width: visualWidth,
      asciiSideBySide: Boolean(options.asciiSideBySide),
      accelerated: Boolean(options.accelerated),
      nativeRecorder: useNativeRecorder
    });

    if (options.accelerated) {
      // The normal browser gets several compositor frames while Playwright is
      // waiting on navigation and assets. Synthetic RAF intentionally pauses
      // those frames, so warm the exact same renderer before recording begins.
      await page.evaluate(async () => {
        const app = window.__PIXEL_GAME_APP__;
        app.homeVectorTheme = false;
        app.vectorGlowAmount = 0;
        app.threeRenderer?.cancelHomeEdgeReveal?.();
        app.threeRenderer?.invalidateSceneCache?.();
        window.__syncMazeReplayClock__?.();
        for (let frame = 0; frame < 12; frame += 1) {
          await window.__advanceMazeReplayFrame__();
          app.render?.(window.__MAZE_REPLAY_NOW__ || performance.now());
        }
      });
    }
    if (diagnosticsEnabled) {
      replayManifest.graphics = await page.evaluate(() => {
        const gl = window.__PIXEL_GAME_APP__?.gl;
        const debugInfo = gl?.getExtension?.("WEBGL_debug_renderer_info");
        return {
          renderer: debugInfo
            ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
            : gl?.getParameter?.(gl.RENDERER) || "",
          vendor: debugInfo
            ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
            : gl?.getParameter?.(gl.VENDOR) || ""
        };
      });
    }
    if (useNativeRecorder) {
      const videoBitsPerSecond = nativeRecorderBitsPerSecond(options);
      await page.evaluate(
        (bitrate) => window.__startMazeReplayNativeRecorder__(bitrate),
        videoBitsPerSecond
      );
      replayManifest.native_recorder_bitrate = videoBitsPerSecond;
    }

    async function setAsciiObservation(board, action) {
      if (!options.asciiSideBySide) return;
      await page.evaluate(({ actionNumber, ascii }) => {
        if (!window.__MAZE_REPLAY_COMPOSITE__) return;
        window.__MAZE_REPLAY_COMPOSITE__.action = actionNumber;
        window.__MAZE_REPLAY_COMPOSITE__.ascii = ascii;
      }, { actionNumber: action, ascii: String(board || "") });
    }

    await setAsciiObservation(asciiFrames[0], 0);

    function writeFrameDataUrl(dataUrl) {
      const base64 = String(dataUrl || "").split(",")[1];

      if (!base64) {
        throw new Error("Could not capture replay frame");
      }

      lastFrameBuffer = Buffer.from(base64, "base64");
      fs.writeFileSync(path.join(framesDir, frameName(frameIndex)), lastFrameBuffer);
      frameIndex += 1;
      estimatedBytes = estimatedVideoBytes(Math.max(frameIndex, estimatedFrames), options);
      captureProgress?.render(frameIndex, { nextEstimateBytes: estimatedBytes });
    }

    function recordNativeCapturedFrames(count) {
      if (!useNativeRecorder || count <= 0) return;
      frameIndex += count;
      estimatedBytes = estimatedVideoBytes(Math.max(frameIndex, estimatedFrames), options);
      captureProgress?.render(frameIndex, { nextEstimateBytes: estimatedBytes });
    }

    async function captureFrame() {
      const dataUrl = await page.evaluate(async (accelerated) => {
        if (accelerated) {
          await window.__advanceMazeReplayFrame__();
        } else {
          await new Promise((resolve) => window.requestAnimationFrame(resolve));
        }
        return window.__captureMazeReplayFrame__();
      }, Boolean(options.accelerated));
      if (useNativeRecorder) recordNativeCapturedFrames(1);
      else if (!options.accelerated) writeFrameDataUrl(dataUrl);
    }

    async function duplicateLastFrame(count) {
      if (useNativeRecorder) {
        const duplicateCount = Math.max(0, Math.floor(Number(count) || 0));
        await page.evaluate(async (limit) => {
          for (let index = 0; index < limit; index += 1) {
            await window.__captureMazeReplayFrame__();
          }
        }, duplicateCount);
        recordNativeCapturedFrames(duplicateCount);
        return;
      }

      if (!lastFrameBuffer) {
        return;
      }

      for (let index = 0; index < count; index += 1) {
        if (rawEncoder) {
          await rawEncoder.writeFrame(lastFrameBuffer);
        } else {
          fs.writeFileSync(path.join(framesDir, frameName(frameIndex)), lastFrameBuffer);
        }
        frameIndex += 1;
        estimatedBytes = estimatedVideoBytes(Math.max(frameIndex, estimatedFrames), options);
        captureProgress?.render(frameIndex, { nextEstimateBytes: estimatedBytes });
      }
    }

    async function waitUntilSettled(maxSeconds, { capture = true } = {}) {
      const maxFrames = Math.max(1, Math.ceil(maxSeconds * options.fps));
      const captured = await page.evaluate(async ({ accelerated, captureFrames, frameLimit }) => {
        function captureReplayFrame() {
          return window.__captureMazeReplayFrame__();
        }

        function replayIsBusy() {
          const app = window.__PIXEL_GAME_APP__;

          return Boolean(
            app?.isAnimating ||
              app?.isTransitioningLevel ||
              app?.levelTransition ||
              app?.levelTransitionFrameId !== null ||
              app?.cameraFrameId !== null ||
              app?.gateAnimationFrameId !== null ||
              app?.orangeWallAnimationFrameId !== null ||
              app?.playerLiftAnimationFrameId !== null ||
              app?.threeRenderer?.isDebugCameraAnimating?.()
          );
        }

        const frames = [];
        let capturedCount = 0;

        for (let index = 0; index < frameLimit; index += 1) {
          if (accelerated) {
            await window.__advanceMazeReplayFrame__();
          } else {
            await new Promise((resolve) => window.requestAnimationFrame(resolve));
          }
          if (captureFrames) {
            capturedCount += 1;
            if (accelerated) {
              await captureReplayFrame();
            } else {
              frames.push(captureReplayFrame());
            }
          }

          if (!replayIsBusy()) {
            break;
          }
        }

        return { capturedCount, dataUrls: await Promise.all(frames) };
      }, {
        accelerated: Boolean(options.accelerated),
        captureFrames: capture,
        frameLimit: maxFrames
      });

      if (useNativeRecorder) recordNativeCapturedFrames(captured.capturedCount);
      else if (!options.accelerated) captured.dataUrls.forEach(writeFrameDataUrl);
    }

    async function settleAndCapture(maxSeconds) {
      if (options.fast) {
        await waitUntilSettled(maxSeconds, { capture: false });
        await captureFrame();
      } else {
        await waitUntilSettled(maxSeconds);
      }
    }

    async function captureFixedFrames(count) {
      const frameLimit = Math.max(1, Math.floor(Number(count) || 1));
      const captured = await page.evaluate(async ({ accelerated, limit }) => {
        const frames = [];
        for (let index = 0; index < limit; index += 1) {
          if (accelerated) {
            await window.__advanceMazeReplayFrame__();
            await window.__captureMazeReplayFrame__();
          } else {
            await new Promise((resolve) => window.requestAnimationFrame(resolve));
            frames.push(window.__captureMazeReplayFrame__());
          }
        }
        return { capturedCount: limit, dataUrls: await Promise.all(frames) };
      }, { accelerated: Boolean(options.accelerated), limit: frameLimit });
      if (useNativeRecorder) recordNativeCapturedFrames(captured.capturedCount);
      else if (!options.accelerated) captured.dataUrls.forEach(writeFrameDataUrl);
    }

    let asciiCameraView = mazeOptions.view;
    let cameraTiltDegrees = options.asciiSideBySide
      ? visionTiltDegreesForAsciiView(asciiCameraView)
      : options.cameraTiltDegrees;
    let cameraYawTurns = ((mazeOptions.yaw % 4) + 4) % 4;
    const cameraTiltDurationMs = 620 / options.cameraSpeed;
    const cameraYawDurationMs = 780 / options.cameraSpeed;

    async function setCameraView({ animate = false, durationMs = 760 } = {}) {
      await page.evaluate(
        ({ animate: shouldAnimate, duration, tiltDegrees, yawTurns, zoom }) => {
          const tilt = (tiltDegrees * Math.PI) / 180;
          const app = window.__PIXEL_GAME_APP__;
          app?.threeRenderer?.setDebugCameraView?.({
            animate: shouldAnimate,
            durationMs: duration,
            mode: "perspective",
            tilt,
            yaw: yawTurns * (Math.PI / 2),
            zoom
          });
          app?.render?.(performance.now());
        },
        {
          animate,
          duration: durationMs,
          tiltDegrees: cameraTiltDegrees,
          yawTurns: cameraYawTurns,
          zoom: options.cameraZoom
        }
      );
    }

    async function captureIntro() {
      if (!options.intro || options.fast) return false;
      // The intro deliberately has two non-overlapping phases, matching the
      // browser's world boot: first the camera holds still while the blue
      // wireframe traces in; only once that is complete does the camera dive
      // while the near-black vector fills melt into the normal palette.
      const edgeFrames = Math.max(1, Math.round(REPLAY_INTRO_EDGE_SECONDS * options.fps));
      const diveFrames = Math.max(1, Math.round(REPLAY_INTRO_DIVE_SECONDS * options.fps));
      // Headless Chromium advances at roughly 60 RAFs/sec. In the reliable
      // PNG path, shorten wall-clock animation durations while retaining the
      // requested number of output frames and therefore the intended video
      // duration. Accelerated capture already advances at the output FPS.
      const edgeDurationMs = Math.max(
        550,
        Math.round((edgeFrames / (options.accelerated ? options.fps : 60)) * 1000)
      );
      const diveDurationMs = Math.max(
        200,
        Math.round((diveFrames / (options.accelerated ? options.fps : 60)) * 1000)
      );
      if (options.accelerated) {
        await page.evaluate(() => window.__syncMazeReplayClock__?.());
      }
      await page.evaluate(({ duration, yawTurns }) => {
        const app = window.__PIXEL_GAME_APP__;
        const renderer = app?.threeRenderer;
        if (!renderer) return;
        app.homeVectorTheme = true;
        app.vectorGlowAmount = 1;
        renderer.cancelHomeEdgeReveal?.();
        renderer.setDebugCameraView?.({
          animate: false,
          mode: "perspective",
          tilt: 1.28,
          yaw: yawTurns * (Math.PI / 2),
          zoom: 0.24,
          skipRender: true
        });
        renderer.primeHomeEdgeReveal?.();
        renderer.invalidateSceneCache?.();
        app.render?.();
        renderer.beginHomeEdgeReveal?.({ durationMs: duration });
      }, {
        duration: edgeDurationMs,
        yawTurns: cameraYawTurns
      });

      await captureFixedFrames(edgeFrames);

      await page.evaluate(({ duration, tiltDegrees, yawTurns, zoom }) => {
        const app = window.__PIXEL_GAME_APP__;
        const renderer = app?.threeRenderer;
        if (!app || !renderer) return;

        const startTilt = 1.28;
        const endTilt = (tiltDegrees * Math.PI) / 180;
        const startZoom = 0.24;
        const endZoom = zoom;
        const startLogZoom = Math.log(startZoom);
        const endLogZoom = Math.log(endZoom);
        // Accelerated capture drives RAF with a synthetic clock that may be
        // several seconds ahead of real performance.now() after the edge
        // phase. Start from that same clock or the first dive frame would
        // incorrectly read as already complete and jump straight to color.
        const startedAt = Number(window.__MAZE_REPLAY_NOW__) || performance.now();

        // Turning off the theme here does not flash the final palette:
        // vectorGlowAmount starts at 1, keeping fills near-black and edges
        // blue, then drives both continuously toward their gameplay colors.
        renderer.cancelHomeEdgeReveal?.();
        app.homeVectorTheme = false;
        app.vectorGlowAmount = 1;

        const step = (now) => {
          const raw = (now - startedAt) / duration;
          const progress = raw < 0 ? 0 : raw > 1 ? 1 : raw;
          const eased = 0.5 - Math.cos(Math.PI * progress) / 2;
          renderer.setDebugCameraView?.({
            animate: false,
            mode: "perspective",
            tilt: startTilt + (endTilt - startTilt) * eased,
            yaw: yawTurns * (Math.PI / 2),
            zoom: Math.exp(startLogZoom + (endLogZoom - startLogZoom) * eased),
            skipRender: true
          });
          app.vectorGlowAmount = 1 - eased;
          renderer.invalidateSceneCache?.();
          app.render?.(now);

          if (progress < 1) {
            window.requestAnimationFrame(step);
          }
        };

        window.requestAnimationFrame(step);
      }, {
        duration: diveDurationMs,
        tiltDegrees: cameraTiltDegrees,
        yawTurns: cameraYawTurns,
        zoom: options.cameraZoom
      });

      await captureFixedFrames(diveFrames);

      await page.evaluate(() => {
        const app = window.__PIXEL_GAME_APP__;
        if (!app) return;
        app.homeVectorTheme = false;
        app.vectorGlowAmount = 0;
        app.threeRenderer?.cancelHomeEdgeReveal?.();
        app.threeRenderer?.invalidateSceneCache?.();
        window.requestAnimationFrame((now) => app.render?.(now));
      });
      await captureFrame();
      return true;
    }

    captureProgress = createProgressReporter({
      estimateBytes: estimatedBytes,
      label: "Capturing replay frames",
      overallStart: 0,
      overallEnd: 92,
      phase: "capturing",
      total: estimatedFrames
    });
    captureProgress.render(0, { force: true });

    const introCaptured = await captureIntro();
    if (!introCaptured) {
      await setCameraView({ animate: false });
      await settleAndCapture(1);
    }
    const actionEntries = actions
      .map((commandText, sourceIndex) => ({ parsed: parseCommandLine(commandText), sourceIndex }))
      .filter((entry) => entry.parsed);
    const actionFrameStart = frameIndex;
    replayManifest.first_action_frame = actionFrameStart;
    if (useNativeRecorder) {
      const nativeFrameVisible = await page.evaluate(() => {
        const canvas = window.__MAZE_REPLAY_COMPOSITE__?.canvas;
        const context = canvas?.getContext?.("2d", { willReadFrequently: true });
        if (!canvas || !context) return false;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const pixelStride = Math.max(4, Math.floor(pixels.length / 40000 / 4) * 4);
        let brightSamples = 0;
        let samples = 0;
        for (let offset = 0; offset + 2 < pixels.length; offset += pixelStride) {
          samples += 1;
          if (pixels[offset] >= 42 || pixels[offset + 1] >= 42 || pixels[offset + 2] >= 42) {
            brightSamples += 1;
          }
        }
        return samples > 0 && brightSamples / samples >= 0.01;
      });
      if (!nativeFrameVisible) {
        throw new Error("Native replay recorder produced a blank gameplay frame");
      }
    } else if (options.accelerated && lastFrameBuffer) {
      let brightSamples = 0;
      let samples = 0;
      const pixelStride = Math.max(4, Math.floor(lastFrameBuffer.length / 40000 / 4) * 4);
      for (let offset = 0; offset + 2 < lastFrameBuffer.length; offset += pixelStride) {
        samples += 1;
        if (
          lastFrameBuffer[offset] >= 42 ||
          lastFrameBuffer[offset + 1] >= 42 ||
          lastFrameBuffer[offset + 2] >= 42
        ) {
          brightSamples += 1;
        }
      }
      if (samples === 0 || brightSamples / samples < 0.01) {
        throw new Error("Accelerated replay produced a blank gameplay frame");
      }
    }
    let completedActions = 0;

    async function readVisualState() {
      return page.evaluate(() => {
        const app = window.__PIXEL_GAME_APP__;
        const player = (app?.state?.actors || []).find(
          (actor) => actor?.type === "player" && actor.removed !== true
        );
        return {
          actors: (app?.state?.actors || [])
            .filter((actor) => actor?.type === "player" || actor?.type === "gem")
            .map((actor) => ({
              elevation: actor.elevation ?? 0,
              id: actor.id || actor.collectionId || actor.groupId || "",
              removed: actor.removed === true,
              type: actor.type,
              x: actor.x,
              y: actor.y
            })),
          animating: app?.isAnimating === true,
          collected_gems: Array.from(app?.collectedGemIds || []).map(String).sort(),
          level_id: app?.currentLevelId || app?.state?.levelId || "",
          player: player
            ? { elevation: player.elevation ?? 0, x: player.x, y: player.y }
            : null,
          transitioning: app?.isTransitioningLevel === true
        };
      });
    }

    async function settleReplayActionBoundary() {
      return page.evaluate((accelerated) => {
        const app = window.__PIXEL_GAME_APP__;
        const settled = Boolean(
          app &&
            !app.isAnimating &&
            !app.isTransitioningLevel &&
            !app.levelTransition &&
            app.animationFrameId === null &&
            app.levelTransitionFrameId === null &&
            app.cameraFrameId === null &&
            app.gateAnimationFrameId === null &&
            app.orangeWallAnimationFrameId === null &&
            app.playerLiftAnimationFrameId === null &&
            !app.threeRenderer?.isDebugCameraAnimating?.()
        );

        if (settled && accelerated) {
          // A room transition can be completed by an edge move as well as by
          // goto. Its final captured render still carries the synthetic clock's
          // high-water mark. Run one uncaptured idle render so the renderer
          // clears that timestamp before the next action re-anchors the clock.
          app.render?.(performance.now());
        }

        return {
          animating: app?.isAnimating === true,
          levelTransition: Boolean(app?.levelTransition),
          levelTransitionFramePending: app?.levelTransitionFrameId !== null,
          settled,
          transitioning: app?.isTransitioningLevel === true
        };
      }, Boolean(options.accelerated));
    }

    for (const entry of actionEntries) {
      const parsed = entry.parsed;
      const frameStart = frameIndex;
      const expectedState = expectedVisualStates[entry.sourceIndex];
      const replayActionValid = expectedState?.replay_action_valid !== false;
      await setAsciiObservation(asciiFrames[entry.sourceIndex + 1], entry.sourceIndex + 1);
      if (options.accelerated) {
        // Every recorded action begins from a settled state. Re-anchor the
        // synthetic RAF timestamp to performance.now() at that boundary so
        // animation code that records a fresh wall-clock start time receives
        // the same elapsed values as it does in the browser.
        await page.evaluate(() => window.__syncMazeReplayClock__?.());
      }

      for (const prefixCommand of expectedState?.replay_prefix_commands || []) {
        const prefix = parseCommandLine(prefixCommand);
        if (prefix?.command === "move") {
          const key = {
            down: "ArrowDown",
            left: "ArrowLeft",
            right: "ArrowRight",
            up: "ArrowUp"
          }[prefix.direction];
          await page.keyboard.press(key);
          await settleAndCapture(3.0);
        } else {
          await captureFrame();
        }
        const prefixHandoff = await settleReplayActionBoundary();
        if (!prefixHandoff.settled) {
          throw new Error(
            `Recovered replay action did not settle before action ${entry.sourceIndex + 1}`
          );
        }
        if (options.accelerated) {
          await page.evaluate(() => window.__syncMazeReplayClock__?.());
        }
      }

      if (!replayActionValid) {
        // The trusted evaluator rejected this attempt (for example, a goto to
        // an unvisited room). Hold the authoritative visual state for one
        // action instead of calling the browser's unrestricted room switcher.
        await captureFrame();
      } else if (parsed.command === "no_move") {
        await captureFrame();
      } else if (parsed.command === "move") {
        const key = {
          down: "ArrowDown",
          left: "ArrowLeft",
          right: "ArrowRight",
          up: "ArrowUp"
        }[parsed.direction];
        await page.keyboard.press(key);
        await settleAndCapture(3.0);
      } else if (parsed.command === "rotate_camera") {
        if (parsed.direction === "left") {
          cameraYawTurns -= 1;
          await setCameraView({ animate: !options.fast, durationMs: cameraYawDurationMs });
          await settleAndCapture(1.8);
        } else if (parsed.direction === "right") {
          cameraYawTurns += 1;
          await setCameraView({ animate: !options.fast, durationMs: cameraYawDurationMs });
          await settleAndCapture(1.8);
        } else if (parsed.direction === "up") {
          if (options.asciiSideBySide) {
            asciiCameraView = rotateAsciiView(asciiCameraView, "up");
            cameraTiltDegrees = visionTiltDegreesForAsciiView(asciiCameraView);
          } else {
            cameraTiltDegrees = Math.max(20, cameraTiltDegrees - options.cameraStepDegrees);
          }
          await setCameraView({ animate: !options.fast, durationMs: cameraTiltDurationMs });
          await settleAndCapture(1.5);
        } else if (parsed.direction === "down") {
          if (options.asciiSideBySide) {
            asciiCameraView = rotateAsciiView(asciiCameraView, "down");
            cameraTiltDegrees = visionTiltDegreesForAsciiView(asciiCameraView);
          } else {
            cameraTiltDegrees = Math.min(82, cameraTiltDegrees + options.cameraStepDegrees);
          }
          await setCameraView({ animate: !options.fast, durationMs: cameraTiltDurationMs });
          await settleAndCapture(1.5);
        }
      } else if (parsed.command === "undo") {
        await page.keyboard.press("z");
        await settleAndCapture(2.0);
      } else if (parsed.command === "reset_level") {
        await page.keyboard.press("r");
        await settleAndCapture(2.0);
      } else if (parsed.command === "goto_level") {
        const levelId = `level_${parsed.x}x${parsed.y}`;
        const started = await page.evaluate((nextLevelId) => {
          const app = window.__PIXEL_GAME_APP__;
          if (typeof app?.switchPlayWorldLevel !== "function") {
            return false;
          }
          window.__MAZE_REPLAY_GOTO_DONE__ = false;
          window.__MAZE_REPLAY_GOTO_PROMISE__ = Promise.resolve(
            app.switchPlayWorldLevel(nextLevelId, { reloadCurrent: true })
          ).finally(() => {
            window.__MAZE_REPLAY_GOTO_DONE__ = true;
          });
          return true;
        }, levelId);
        if (!started) {
          throw new Error("The game does not expose its room transition renderer.");
        }
        let animated = false;
        if (options.accelerated) {
          for (let frame = 0; frame < 300; frame += 1) {
            const transitionState = await page.evaluate(() => {
              const app = window.__PIXEL_GAME_APP__;
              if (app?.isTransitioningLevel || app?.levelTransition) return "animated";
              if (window.__MAZE_REPLAY_GOTO_DONE__) return "done";
              return "waiting";
            });
            if (transitionState === "animated") {
              animated = true;
              break;
            }
            if (transitionState === "done") break;
            await page.evaluate(() => window.__advanceMazeReplayFrame__());
          }
        } else {
          animated = await page.evaluate(async () => {
            for (let frame = 0; frame < 300; frame += 1) {
              await new Promise((resolve) => window.requestAnimationFrame(resolve));
              const app = window.__PIXEL_GAME_APP__;
              if (app?.isTransitioningLevel || app?.levelTransition) return true;
              if (window.__MAZE_REPLAY_GOTO_DONE__) return false;
            }
            return false;
          });
        }
        if (animated) await settleAndCapture(3.2);
        else await captureFrame();
        await page.evaluate(async () => {
          await window.__MAZE_REPLAY_GOTO_PROMISE__;
          window.__MAZE_REPLAY_GOTO_PROMISE__ = null;
          window.__MAZE_REPLAY_GOTO_DONE__ = false;
        });
      } else if (parsed.command === "quit") {
        await captureFrame();
      }

      // Do this for every action, not only goto: an ordinary directional move
      // can itself cross a room edge and leave the same synthetic transition
      // timestamp behind. The idle render is skipped unless all motion settled.
      const actionHandoff = await settleReplayActionBoundary();
      if (parsed.command === "goto_level" && !actionHandoff.settled) {
        throw new Error(
          `Room transition did not settle before the next action (${JSON.stringify(
            actionHandoff
          )})`
        );
      }

      completedActions += 1;
      let visualState = null;
      if (diagnosticsEnabled || (options.accelerated && expectedState)) {
        visualState = await readVisualState();
      }
      if (options.accelerated && expectedState && visualState) {
        const mismatches = [];
        if (
          expectedState.current_room &&
          String(expectedState.current_room) !== String(visualState.level_id)
        ) {
          mismatches.push(
            `room ${visualState.level_id || "(none)"} != ${expectedState.current_room}`
          );
        }
        const expectedPlayerState = expectedReplayPlayerState(expectedState);
        if (expectedPlayerState.known) {
          const expectedPlayer = expectedPlayerState.player;
          if (!expectedPlayer && visualState.player) {
            mismatches.push("player should be absent");
          } else if (expectedPlayer && !visualState.player) {
            mismatches.push("player should be present");
          } else if (expectedPlayer && visualState.player) {
            for (const key of ["x", "y", "elevation"]) {
              if (Number(expectedPlayer[key] || 0) !== Number(visualState.player[key] || 0)) {
                mismatches.push(
                  `player ${key} ${visualState.player[key]} != ${expectedPlayer[key]}`
                );
              }
            }
          }
        }
        if (Array.isArray(expectedState.collected_gems)) {
          const expectedGems = normalizedGemCollectionIds(expectedState.collected_gems);
          const visualGems = normalizedGemCollectionIds(visualState.collected_gems);
          if (JSON.stringify(expectedGems) !== JSON.stringify(visualGems)) {
            mismatches.push(
              `collected gems ${visualGems.join(",")} != ${expectedGems.join(",")}`
            );
          }
        }
        if (visualState.animating || visualState.transitioning) {
          mismatches.push("renderer did not settle at the action boundary");
        }
        if (mismatches.length > 0) {
          throw new Error(
            `Accelerated replay diverged after action ${entry.sourceIndex + 1} ` +
              `(${actions[entry.sourceIndex]}): ${mismatches.join("; ")}`
          );
        }
      }
      if (diagnosticsEnabled) {
        replayManifest.actions.push({
          command: actions[entry.sourceIndex],
          frame_end: Math.max(frameStart, frameIndex - 1),
          frame_start: frameStart,
          source_index: entry.sourceIndex,
          visual_state: visualState
        });
      }
      const actionFrames = Math.max(1, frameIndex - actionFrameStart);
      const averageFrames = actionFrames / completedActions;
      const remainingActions = actionEntries.length - completedActions;
      const tailFrames = Math.round(options.tailSeconds * options.fps);
      const measuredTotal = Math.ceil(frameIndex + averageFrames * remainingActions + tailFrames);
      estimatedBytes = estimatedVideoBytes(measuredTotal, options);
      captureProgress.render(frameIndex, {
        nextEstimateBytes: estimatedBytes,
        nextTotal: measuredTotal
      });
    }

    await duplicateLastFrame(Math.round(options.tailSeconds * options.fps));
    if (useNativeRecorder) {
      // captureStream(0) can occasionally coalesce requested frames. Record a
      // small tail reserve, then trim it after capture so the final MP4 still
      // contains exactly frameIndex frames without rerendering the whole run.
      nativeGuardFrames = nativeCaptureGuardFrameCount(frameIndex);
      await page.evaluate(async (guardFrameCount) => {
        for (let index = 0; index < guardFrameCount; index += 1) {
          await window.__captureMazeReplayFrame__();
        }
      }, nativeGuardFrames);
      await page.evaluate(() => window.__finishMazeReplayNativeRecorder__());
      if (!fs.existsSync(recordedVideoPath) || fs.statSync(recordedVideoPath).size === 0) {
        throw new Error("Native replay recorder did not produce an MP4");
      }
    }
    if (diagnosticsEnabled) {
      replayManifest.frame_count = frameIndex;
      fs.writeFileSync(
        path.join(outDir, ".maze_replay_manifest.json"),
        `${JSON.stringify(replayManifest, null, 2)}\n`
      );
    }
    captureSucceeded = true;
  } finally {
    process.off("SIGINT", terminateRenderer);
    process.off("SIGTERM", terminateRenderer);
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
    if (!captureSucceeded) await rawEncoder?.abort();
    if (!captureSucceeded && useNativeRecorder) {
      fs.rmSync(recordedVideoPath, { force: true });
    }
  }

  if (frameIndex === 0) {
    throw new Error("Replay renderer did not capture any frames");
  }

  estimatedBytes = estimatedVideoBytes(frameIndex, options);
  captureProgress?.finish(
    `Captured ${frameIndex} replay frame${frameIndex === 1 ? "" : "s"}; expected MP4 ~${humanBytes(
      estimatedBytes
    )}.`
  );

  if (useNativeRecorder) {
    const nativeFrameCount = countedVideoFrames(recordedVideoPath);
    if (!nativeFrameCountIsAcceptable(nativeFrameCount, frameIndex, nativeGuardFrames)) {
      fs.rmSync(recordedVideoPath, { force: true });
      throw new Error(
        `Native replay recorder retained ${nativeFrameCount}/${frameIndex + nativeGuardFrames} ` +
          `total requested frames; at least ${frameIndex} replay frames are required`
      );
    }
    if (nativeFrameCount !== frameIndex) {
      console.warn(
        `Native replay recorder retained ${nativeFrameCount} frames; trimming ` +
          `${nativeFrameCount - frameIndex} guard frames from the completed recording.`
      );
    }
    const retimedPath = path.join(
      outDir,
      `.maze_replay.retimed.${options.format}`
    );
    fs.rmSync(retimedPath, { force: true });
    writeReplayProgress({
      phase: "encoding",
      percent: 98,
      current: frameIndex,
      total: frameIndex,
      unit: "frames",
      eta_ms: null
    });
    const retime = spawnSync("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      recordedVideoPath,
      "-frames:v",
      String(frameIndex),
      "-an",
      "-c:v",
      "copy",
      "-bsf:v",
      `setts=pts=N:dts=N:duration=1:time_base=1/${options.fps}:prescale=1`,
      "-movflags",
      "+faststart",
      retimedPath
    ], { encoding: "utf8" });
    if (retime.status !== 0) {
      fs.rmSync(retimedPath, { force: true });
      fs.rmSync(recordedVideoPath, { force: true });
      throw new Error(retime.stderr || "Could not retime native replay video");
    }
    const retimedFrameCount = countedVideoFrames(retimedPath);
    if (retimedFrameCount !== frameIndex) {
      fs.rmSync(retimedPath, { force: true });
      fs.rmSync(recordedVideoPath, { force: true });
      throw new Error(
        `Retimed native replay contains ${retimedFrameCount}/${frameIndex} expected frames`
      );
    }
    try {
      await optimizeNativeReplayVideo(
        retimedPath,
        videoPath,
        options,
        frameIndex / options.fps
      );
      const optimizedFrameCount = countedVideoFrames(videoPath);
      if (optimizedFrameCount !== frameIndex) {
        fs.rmSync(videoPath, { force: true });
        throw new Error(
          `Optimized native replay contains ${optimizedFrameCount}/${frameIndex} expected frames`
        );
      }
    } finally {
      fs.rmSync(retimedPath, { force: true });
      fs.rmSync(recordedVideoPath, { force: true });
    }
  } else if (rawEncoder) {
    writeReplayProgress({
      phase: "encoding",
      percent: 98,
      current: frameIndex,
      total: frameIndex,
      unit: "frames",
      eta_ms: null
    });
    try {
      await rawEncoder.finish();
    } catch (error) {
      await rawEncoder.abort();
      throw error;
    }
  } else {
    const ffmpegArgs = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostats",
      "-progress",
      "pipe:1",
      "-framerate",
      String(options.fps),
      "-i",
      path.join(framesDir, "frame-%06d.png"),
      "-vf",
      videoFilter(options),
      "-r",
      String(options.fps),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      options.preset,
      "-crf",
      String(options.crf),
      "-movflags",
      "+faststart",
      videoPath
    ];
    await encodeVideo(ffmpegArgs, {
      durationSeconds: frameIndex / options.fps,
      estimateBytes: estimatedBytes
    });
  }

  await capReplayVideoSize(videoPath, options, frameIndex / options.fps);
  if (useNativeRecorder) {
    const finalFrameCount = countedVideoFrames(videoPath);
    if (finalFrameCount !== frameIndex) {
      fs.rmSync(videoPath, { force: true });
      throw new Error(
        `Final native replay contains ${finalFrameCount}/${frameIndex} expected frames`
      );
    }
  }

  if (!options.keepFrames) {
    fs.rmSync(framesDir, { force: true, recursive: true });
  }

  writeReplayProgress({ phase: "done", percent: 100 });
  return { videoPath };
}

function videoFilter(options) {
  const width = Math.max(2, Math.floor(options.width / 2) * 2);
  const height = Math.max(2, Math.floor(options.height / 2) * 2);

  return [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    "format=yuv420p"
  ].join(",");
}

function humanSize(filePath) {
  const bytes = fs.statSync(filePath).size;
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const input = resolveInput(options.resultsInput);
  let rows;
  let metadata;
  let sourceDir;
  let sourceLabel;

  if (input.mode === "session") {
    const session = JSON.parse(fs.readFileSync(input.sessionPath, "utf8"));
    rows = [rowFromSession(session)];
    metadata = {};
    sourceDir = input.sessionDir;
    sourceLabel = input.sessionPath;
  } else if (input.mode === "actions") {
    const runMetaPath = path.join(input.runDir, "run.json");
    const initialStatusPath = path.join(input.runDir, "initial-status.json");
    const runMeta = fs.existsSync(runMetaPath)
      ? JSON.parse(fs.readFileSync(runMetaPath, "utf8"))
      : {};
    const initialStatus = fs.existsSync(initialStatusPath)
      ? JSON.parse(fs.readFileSync(initialStatusPath, "utf8"))
      : null;
    rows = [rowFromActionLog(readJsonl(input.actionsPath), runMeta, initialStatus)];
    metadata = {};
    sourceDir = input.runDir;
    sourceLabel = input.actionsPath;
  } else {
    rows = readJsonl(input.resultsPath);
    metadata = readMetadata(input.resultsDir);
    sourceDir = input.resultsDir;
    sourceLabel = input.resultsPath;
  }

  const row = rows[options.index];

  if (!row) {
    throw new Error(
      `No rollout row at index ${options.index}; ${sourceLabel} has ${rows.length}`
    );
  }

  const outDir = options.outDir || sourceDir;
  const mazeOptions = extractMazeOptions(row, metadata);
  const actionLimit = options.actionLimit || Infinity;
  const actions = extractActions(row).slice(0, actionLimit);
  const asciiFrames = extractAsciiFrames(row).slice(0, actionLimit + 1);
  const expectedVisualStates = extractExpectedVisualStates(row).slice(0, actionLimit);

  if (actions.length === 0) {
    throw new Error(
      "Could not find replay actions. Check trace info, state columns, or completion output."
    );
  }

  const scorecard = existingScorecard(row) || replayScorecard(actions, mazeOptions);
  const written = writeSidecarFiles(outDir, actions, scorecard);

  console.log(`Source: ${sourceLabel}`);
  console.log(`Wrote ${written.scorecardPath}`);
  console.log(`Wrote ${written.actionsPath}`);

  if (options.video) {
    if (options.asciiSideBySide && !asciiFrames.some((frame) => String(frame || "").trim())) {
      throw new Error("ASCII side-by-side video requested, but no model-facing ASCII observations were found");
    }
    console.log("Rendering maze replay video...");
    let rendered;
    try {
      rendered = await renderReplayVideo(
        actions,
        mazeOptions,
        outDir,
        options,
        asciiFrames,
        expectedVisualStates
      );
    } catch (error) {
      if (!options.accelerated) throw error;
      if (options.nativeRecorder) {
        console.warn(
          `Native replay recording failed (${error instanceof Error ? error.message : error}); ` +
            "retrying with the accelerated raw-frame renderer."
        );
        try {
          rendered = await renderReplayVideo(
            actions,
            mazeOptions,
            outDir,
            { ...options, nativeRecorder: false },
            asciiFrames,
            expectedVisualStates
          );
        } catch (rawError) {
          console.warn(
            `Accelerated raw replay failed (` +
              `${rawError instanceof Error ? rawError.message : rawError}); ` +
              "retrying with the reliable PNG renderer."
          );
          rendered = await renderReplayVideo(
            actions,
            mazeOptions,
            outDir,
            { ...options, accelerated: false },
            asciiFrames,
            expectedVisualStates
          );
        }
      } else {
        console.warn(
          `Accelerated replay failed (${error instanceof Error ? error.message : error}); ` +
            "retrying with the reliable PNG renderer."
        );
        rendered = await renderReplayVideo(
          actions,
          mazeOptions,
          outDir,
          { ...options, accelerated: false },
          asciiFrames,
          expectedVisualStates
        );
      }
    }
    console.log(`Wrote ${rendered.videoPath} (${humanSize(rendered.videoPath)})`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  defaultReplayOptions,
  expectedReplayPlayerState,
  extractAsciiFrames,
  humanSize,
  inferReplayPrefixCommands,
  nativeCaptureGuardFrameCount,
  nativeFrameCountIsAcceptable,
  replayTranscodeArguments,
  resolveInput,
  renderReplayVideo,
  rotateAsciiView,
  rowFromActionLog,
  targetVideoBitrate,
  validateReplayOptions,
  visionTiltDegreesForAsciiView,
  writeSidecarFiles
};
