#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  findPlaywrightBrowserChildren,
  killPlaywrightBrowserProcess,
  playwrightBrowserProcess,
  signalProcessGroup
} = require("./playwright-process");

const directions = new Set(["up", "down", "left", "right"]);
const GAME_WON_GEM_COUNT = 100;
const VISION_TEXT_BOARD_KEYS = new Set([
  "_render_state",
  "ascii",
  "board",
  "header",
  "json_observation",
  "level",
  "observation",
  "screen"
]);
const EXPLICIT_PLAYER_POSITION_KEYS = new Set([
  "current_position",
  "player",
  "player_elevation",
  "player_x",
  "player_y"
]);
const MODEL_PRIVATE_STATUS_KEYS = new Set([
  "collected_gems",
  "collected_this_action",
  "json_display_palette",
  "moved",
  "novel_push_count",
  "novel_pushes_this_action",
  "push_count",
  "pushes_this_action"
]);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function consumeRenderState(response, stateFile) {
  const status = response?.status || response;
  if (status && typeof status === "object") delete status._render_state;
  // Older runs may contain this renderer-only actor snapshot. It includes
  // exact coordinates, so never leave it beside a model-accessible session.
  fs.rmSync(path.join(path.dirname(stateFile), "current-render-state.json"), { force: true });
  return response;
}

function normalizeLevelId(value) {
  const raw = String(value || "level_HxI").trim();
  const match = raw.match(/^(?:level_)?([A-Z])x([A-Z])$/i);
  return match ? `level_${match[1].toUpperCase()}x${match[2].toUpperCase()}` : raw;
}

function normalizeYaw(value) {
  const number = Number(value);
  const integer = Number.isInteger(number) ? number : 0;
  return ((integer % 4) + 4) % 4;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizedMaxActions(value, fallback = 100) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["unlimited", "infinite", "infinity", "none"].includes(normalized)) return null;
  return positiveInt(value, fallback);
}

function sessionMaxActions(session) {
  if (session && Object.prototype.hasOwnProperty.call(session, "maxActions") && session.maxActions === null) {
    return null;
  }
  return normalizedMaxActions(session?.maxActions, 100);
}

// 1..26 rings of neighbor rooms (1 = the classic 3x3 window) or "world".
function normalizeVisionView(value) {
  const raw = String(value ?? "1").trim().toLowerCase();
  if (raw === "world") return "world";
  const rings = Number(raw);
  return Number.isFinite(rings) ? Math.max(1, Math.min(26, Math.floor(rings))) : 1;
}

function parseArgs(argv) {
  const options = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] || "";
    if (arg === "--repo-root") options.repoRoot = path.resolve(next());
    else if (arg === "--state") options.state = path.resolve(next());
    else if (arg === "--game") options.game = next();
    else if (arg === "--level") options.level = next();
    else if (arg === "--view") options.view = next();
    else if (arg === "--yaw") options.yaw = next();
    else if (arg === "--game-won-gem-count") options.gameWonGemCount = next();
    else if (arg === "--max-actions") options.maxActions = next();
    else if (arg === "--node-bin") options.nodeBin = next();
    else if (arg === "--vision") options.vision = true;
    else if (arg === "--json-observation") options.observationMode = "json";
    else if (arg === "--observation-mode") options.observationMode = next();
    else if (arg === "--omniscient") options.omniscient = true;
    else if (arg === "--hide-names") options.hideNames = true;
    else if (arg === "--hide-names-seed") options.hideNamesSeed = next();
    else if (arg === "--vision-width") options.visionWidth = next();
    else if (arg === "--vision-height") options.visionHeight = next();
    else if (arg === "--vision-view") options.visionView = next();
    else if (arg === "--no-quit") options.allowQuit = false;
    else options.positional.push(arg);
  }
  return options;
}

function applyQuitPolicy(response, session) {
  if (session?.allowQuit !== false) return response;
  const status = response?.status || response;
  if (status && Array.isArray(status.allowed_commands)) {
    status.allowed_commands = status.allowed_commands.filter(
      (command) => String(command).trim().toLowerCase() !== "quit"
    );
  }
  return response;
}

// Keep evaluator-only scoring out of every model-facing surface. Text and
// vision observations also omit explicit player coordinates; JSON intentionally
// retains them as part of its structured observation contract. Vision removes
// every text/JSON board representation as well.
function redactAgentStatus(value, { mode = "text", includeInternalSignals = false } = {}) {
  if (Array.isArray(value)) {
    return value.map((item) => redactAgentStatus(item, { mode, includeInternalSignals }));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => {
        const normalized = String(key).toLowerCase();
        if (normalized.includes("scorecard")) return false;
        if (!includeInternalSignals && MODEL_PRIVATE_STATUS_KEYS.has(normalized)) return false;
        if (!includeInternalSignals && normalized.includes("board_state_hash")) return false;
        if (normalized === "_render_state") return false;
        if (mode !== "json" && EXPLICIT_PLAYER_POSITION_KEYS.has(normalized)) return false;
        if (mode === "text" && normalized === "json_observation") return false;
        if (mode === "json" && normalized !== "json_observation" && VISION_TEXT_BOARD_KEYS.has(normalized)) return false;
        if (mode === "vision" && VISION_TEXT_BOARD_KEYS.has(normalized)) return false;
        return true;
      })
      .map(([key, nested]) => [
        key,
        redactAgentStatus(nested, { mode, includeInternalSignals })
      ])
  );
}

function redactVisionStatus(value) {
  return redactAgentStatus(value, { mode: "vision" });
}

function publicObservationStatus(value, { mode = "text" } = {}) {
  const status = value?.status && typeof value.status === "object" ? value.status : value;
  const source = redactAgentStatus(status, { mode });
  const observationMode = mode === "text" ? "ascii" : mode;
  const observation = {
    observation_mode: observationMode,
    current_room: String(source?.current_room || ""),
    current_view: String(source?.current_view || ""),
    yaw: Number.isInteger(source?.yaw) ? source.yaw : 0,
    gem_count: Math.max(0, Number(source?.gem_count) || 0),
    visited_levels: Array.isArray(source?.visited_levels)
      ? source.visited_levels.map(String)
      : [],
    player_dead: source?.player_dead === true,
    game_won: Math.max(0, Number(source?.gem_count) || 0) >= GAME_WON_GEM_COUNT,
    game_lost: source?.game_lost === true
  };

  if (observationMode === "ascii") {
    observation.level = String(source?.level || source?.observation || "");
    observation.ascii_legend = Array.isArray(source?.ascii_legend)
      ? source.ascii_legend
      : [];
  } else if (observationMode === "json") {
    observation.json_observation = source?.json_observation || {};
  } else if (observationMode === "vision" && source?.frame_image) {
    observation.frame_image = String(source.frame_image);
  }

  if (observation.player_dead) {
    observation.death_message = String(
      source?.death_message || "The player died, you must now undo or reset or go to a level."
    );
    observation.allowed_commands = Array.isArray(source?.allowed_commands)
      ? source.allowed_commands.map(String)
      : ["undo", "reset", "go to level X Y"];
  }
  if (source?.user_pause_requested === true) {
    observation.user_pause_requested = true;
    observation.pause_message = String(source.pause_message || "");
    observation.allowed_commands = [];
  }
  return observation;
}

function storedStatus(session, status) {
  return redactAgentStatus(status, {
    mode: session?.observationMode || "text",
    includeInternalSignals: true
  });
}

function requiredActionsRemaining(session) {
  const required = sessionMaxActions(session);
  if (required == null) return null;
  const completed = Array.isArray(session?.actions) ? session.actions.length : 0;
  return Math.max(0, required - completed);
}

function terminalStatus(status) {
  return Boolean(
    Math.max(0, Number(status?.gem_count) || 0) >= GAME_WON_GEM_COUNT ||
    status?.game_lost ||
    status?.player_dead ||
    status?.quit
  );
}

function usage() {
  console.log(`Usage:
  node codex-play.js start --repo-root <path> --state <session.json> [options]
  node codex-play.js observe --state <session.json>
  node codex-play.js action --state <session.json> <command words...>
  node codex-play.js action-sequence --state <session.json> < sequence.json

start options:
  --game <id>               game directory under games/ (default maze; draft
                            and online worlds use their games/<id> dirs)
  --level <id>              maze world level id (default level_HxI)
  --view <name>             top | top-diagonal | diagonal | side-diagonal | side
  --yaw <0-3>               camera yaw
  --game-won-gem-count <n>  legacy input; game_won is fixed at 100 unique gems
  --max-actions <n|unlimited> hard action budget enforced by the helper
  --vision                  render a PNG each turn; output includes frame_image
                            (path) and drops the ASCII board
  --json-observation        return a structured JSON room observation instead
                            of the ASCII board
  --omniscient              include every room object in JSON mode
  --hide-names              randomize ASCII glyphs or JSON names except
                            player/gem, stable within this run
  --vision-width <px>       vision frame width (default 512)
  --vision-height <px>      vision frame height (default 512)
  --vision-view <n|world>   how far the frame sees: 1-26 rings of neighbor
                            rooms (default 1 = classic 3x3) or "world"`);
}

function bridgeArgs(session) {
  const args = [
    path.join(session.repoRoot, "scripts", "maze-bridge.js"),
    "--game", session.gameId || "maze",
    "--level", normalizeLevelId(session.levelId),
    "--view", session.view || "top-diagonal",
    "--yaw", String(normalizeYaw(session.yaw)),
    "--game-won-gem-count", String(GAME_WON_GEM_COUNT)
  ];

  if (session.observationMode === "json") {
    args.push("--observation-mode", "json");
    if (session.omniscient) args.push("--omniscient");
  }
  if (session.hideNames) {
    args.push(
      "--hide-names",
      "--hide-names-seed",
      String(session.hideNamesSeed || "1")
    );
  }

  return args;
}

function runBridge(session, message) {
  const checkpoint = session.bridgeCheckpoint && typeof session.bridgeCheckpoint === "object"
    ? session.bridgeCheckpoint
    : null;
  const checkpointTurn = checkpoint && Number.isFinite(Number(checkpoint.turn))
    ? Math.max(0, Math.floor(Number(checkpoint.turn)))
    : null;
  const replay = (session.actions || [])
    .filter((action) =>
      action &&
      action.message &&
      action.replay !== false &&
      (checkpointTurn === null || Number(action.turn) > checkpointTurn)
    )
    .map((action) => action.message);
  const bootstrap = checkpoint
    ? [{ command: "restore_checkpoint", checkpoint }]
    : [];
  const messages = [...bootstrap, ...replay, message, { command: "close" }];
  const result = spawnSync(session.nodeBin || process.execPath, bridgeArgs(session), {
    cwd: session.repoRoot,
    encoding: "utf8",
    input: `${messages.map((item) => JSON.stringify(item)).join("\n")}\n`,
    maxBuffer: 80 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "").trim() || `maze bridge exited ${result.status}`);
  }
  const responses = String(result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const responseIndex = bootstrap.length + replay.length;
  const previousFailure = responses.slice(0, responseIndex).find((response) => !response.ok);
  if (previousFailure) {
    throw new Error(`Replay failed before requested command: ${previousFailure.error || "unknown error"}`);
  }
  const response = responses[responseIndex];
  if (!response) throw new Error("maze bridge returned no response");
  if (!response.ok) throw new Error(response.error || "maze bridge command failed");
  return response;
}

// Batch actions use the same trusted bridge implementation in-process. The
// saved history is replayed exactly once, after which every new action advances
// this one live bridge session. Single-action commands retain the process-
// isolated path above.
function replayedBridgeSession(session) {
  const {
    createSession,
    handleCommand,
    parseArgs: parseBridgeArgs
  } = require("./maze-bridge");
  const liveSession = createSession(parseBridgeArgs(bridgeArgs(session).slice(1)));
  const checkpoint = session.bridgeCheckpoint && typeof session.bridgeCheckpoint === "object"
    ? session.bridgeCheckpoint
    : null;
  const checkpointTurn = checkpoint && Number.isFinite(Number(checkpoint.turn))
    ? Math.max(0, Math.floor(Number(checkpoint.turn)))
    : null;
  const replay = (session.actions || []).filter((action) =>
    action &&
    action.message &&
    action.replay !== false &&
    (checkpointTurn === null || Number(action.turn) > checkpointTurn)
  );

  try {
    if (checkpoint) handleCommand(liveSession, { command: "restore_checkpoint", checkpoint });
    replay.forEach((action) => handleCommand(liveSession, action.message));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Replay failed before requested sequence: ${message}`);
  }

  return { handleCommand, liveSession };
}

function normalizeAction(words) {
  const text = words.join(" ").trim().toLowerCase();
  if (directions.has(text)) return { command: "move", direction: text };
  const move = text.match(/^move\s+(up|down|left|right)$/);
  if (move) return { command: "move", direction: move[1] };
  const rotate = text.match(/^rotate(?:\s+camera)?\s+(up|down|left|right)$/);
  if (rotate) return { command: "rotate_camera", direction: rotate[1] };
  if (text === "undo") return { command: "undo" };
  if (text === "reset" || text === "reset level") return { command: "reset_level" };
  if (text === "quit") return { command: "quit" };
  const goto = text.match(/^(?:go\s+to\s+level|goto)\s+([a-z])\s+([a-z])$/i);
  if (goto) return { command: "goto_level", x: goto[1].toUpperCase(), y: goto[2].toUpperCase() };
  throw new Error(`Unknown action: ${text}`);
}

function printStatus(response) {
  const value = response.status || response;
  console.log(JSON.stringify(value, null, 2));
}

function emitTelemetry(record, mode = "text") {
  // MCP children return their observation on stdout, where the MCP server
  // expects exactly one JSON document so it can attach vision frames. The
  // server records MCP actions separately, so appending the provider-facing
  // telemetry marker here is both redundant and breaks that JSON boundary.
  if (process.env.MAZEBENCH_MCP_CHILD === "1") return;
  const telemetryRecord = redactAgentStatus(record, { mode });
  const payload = Buffer.from(JSON.stringify(telemetryRecord), "utf8").toString("base64url");
  console.log(`MAZEBENCH_EVENT_V1:${payload}`);
}

function canonicalActionText(message) {
  if (!message || typeof message !== "object") return "";
  if (message.command === "move") return String(message.direction || "");
  if (message.command === "rotate_camera") return `rotate camera ${message.direction}`;
  if (message.command === "goto_level") return `go to level ${message.x} ${message.y}`;
  if (message.command === "reset_level") return "reset";
  return String(message.command || "");
}

function rendererScript(session) {
  return path.join(session.repoRoot, "scripts", "maze-render-frame.js");
}

function visionRenderPayload(session, stateFile) {
  return {
    // The persistent renderer applies only the new suffix when this full
    // action list extends its current state. Avoid an actor snapshot sidecar:
    // it would disclose exact coordinates to tool-capable coding agents.
    actions: (session.actions || [])
      .map((action) => canonicalActionText(action.message))
      .filter(Boolean),
    draft: true,
    fast: true,
    gameId: session.gameId || "maze",
    height: positiveInt(session.visionHeight, 512),
    levelId: normalizeLevelId(session.levelId),
    view: normalizeVisionView(session.visionView),
    width: positiveInt(session.visionWidth, 512),
    yaw: normalizeYaw(session.yaw)
  };
}

// ---- persistent render daemon ----------------------------------------------
// This helper runs once per agent turn, so it can't keep a browser alive
// itself. Instead the first vision render spawns maze-render-frame.js in
// --listen mode (a 127.0.0.1 socket, port recorded next to the session file)
// and every later turn just sends the daemon a "render" sync — the daemon
// applies only the newly appended actions, instead of booting a browser and
// replaying the whole run for every single frame.

function daemonPortFile(stateFile) {
  return path.join(path.dirname(stateFile), "render-daemon.json");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectDaemon(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.on("error", reject);
  });
}

function daemonRequest(socket, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      const error = new Error("render daemon timed out");
      error.renderTimeout = true;
      reject(error);
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        reject(new Error("render daemon returned an unreadable response"));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.write(`${JSON.stringify(message)}\n`);
  });
}

// Thrown when the renderer can't bind a localhost port at all — e.g. inside a
// no-network sandbox. The one-shot renderer binds the same way, so there is no
// point retrying it; callers surface this as a clean "render unavailable".
class RenderBindBlockedError extends Error {
  constructor(detail) {
    super(
      "cannot render maze frames: binding a local server was blocked " +
        `(${detail}). This host run is sandboxed with no network; use container ` +
        "mode or Full tool access for vision runs."
    );
    this.renderBindBlocked = true;
  }
}

async function openDaemonSocket(session, stateFile) {
  const portFile = daemonPortFile(stateFile);
  const existing = readJson(portFile, null);
  if (existing && existing.port) {
    try {
      return await connectDaemon(existing.port);
    } catch {
      fs.rmSync(portFile, { force: true });
    }
  } else if (existing && existing.error) {
    // A prior spawn already recorded that it could not bind — don't wait.
    fs.rmSync(portFile, { force: true });
    throw new RenderBindBlockedError(existing.error);
  }

  spawn(
    session.nodeBin || process.execPath,
    [rendererScript(session), "--listen", "--port-file", portFile, "--idle-seconds", "600"],
    { cwd: session.repoRoot, detached: true, stdio: "ignore" }
  ).unref();

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(150);
    const info = readJson(portFile, null);
    if (info && info.error) {
      // Sandbox blocked the bind; fail now instead of waiting out the timeout.
      fs.rmSync(portFile, { force: true });
      throw new RenderBindBlockedError(info.error);
    }
    if (info && info.port) {
      try {
        return await connectDaemon(info.port);
      } catch {
        /* not accepting yet — keep waiting */
      }
    }
  }
  throw new Error("render daemon did not start listening");
}

async function renderVisionFrameViaDaemon(session, payload, stateFile) {
  const socket = await openDaemonSocket(session, stateFile);
  // A bad WebGL/Chromium process must not pin several CPU cores indefinitely.
  // Ninety seconds still leaves ample room for the first browser boot.
  const response = await daemonRequest(socket, { command: "render", ...payload }, 90000);
  if (!response || response.ok !== true || !response.frame) {
    throw new Error((response && response.error) || "render daemon returned no frame");
  }
  return String(response.frame);
}

// Best-effort: tell the run's render daemon to shut down (used once the game
// is over, so the headless browser doesn't linger until its idle timeout).
async function stopRenderDaemon(stateFile, { force = false } = {}) {
  const info = readJson(daemonPortFile(stateFile), null);
  if (!info) return;
  if (!force && info.port) {
    try {
      const socket = await connectDaemon(info.port);
      await daemonRequest(socket, { command: "close" }, 10000);
    } catch {
      force = true;
    }
  }
  if (force && Number(info.pid) > 0) {
    signalProcessGroup(Number(info.pid), "SIGKILL");
  }
  if (force && Number(info.browser_pid) > 0) {
    killPlaywrightBrowserProcess(Number(info.browser_pid));
  }
  fs.rmSync(daemonPortFile(stateFile), { force: true });
}

// One-shot fallback when the daemon can't be used: boots a browser, replays
// every applied action, exits. Slow, but has no moving parts.
function renderVisionFrameOneShot(session, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(session.nodeBin || process.execPath, [rendererScript(session)], {
      cwd: session.repoRoot,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    const browserProcesses = new Map();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputError = null;
    let settled = false;
    let forceTimer = null;

    const trackBrowsers = () => {
      findPlaywrightBrowserChildren(child.pid).forEach((info) => {
        browserProcesses.set(info.pid, info);
      });
    };
    const cleanupBrowsers = () => {
      trackBrowsers();
      for (const info of browserProcesses.values()) {
        killPlaywrightBrowserProcess(playwrightBrowserProcess(info.pid) || info);
      }
    };
    const tracker = setInterval(trackBrowsers, 250);
    tracker.unref?.();
    const requestStop = () => {
      trackBrowsers();
      signalProcessGroup(child.pid, "SIGTERM");
      if (!forceTimer) {
        forceTimer = setTimeout(() => {
          cleanupBrowsers();
          signalProcessGroup(child.pid, "SIGKILL");
        }, 17_000);
        forceTimer.unref?.();
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      // Give the renderer and Playwright time to close Chromium cleanly. The
      // old spawnSync(SIGKILL) path killed only Node and leaked Chrome's
      // deliberately detached process group.
      requestStop();
    }, 90_000);

    const finish = (error, code = null) => {
      if (settled) return;
      settled = true;
      clearInterval(tracker);
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      cleanupBrowsers();

      if (error) {
        reject(error);
        return;
      }
      if (timedOut) {
        reject(new Error("maze-render-frame.js timed out after 90 seconds"));
        return;
      }
      if (code !== 0) {
        reject(new Error((stderr || stdout || "maze-render-frame.js failed").trim()));
        return;
      }

      try {
        resolve(String(JSON.parse(stdout).data_url || ""));
      } catch (parseError) {
        reject(parseError);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 128 * 1024 * 1024 && !outputError) {
        outputError = new Error("maze-render-frame.js exceeded its output limit");
        requestStop();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 16 * 1024 * 1024) {
        stderr = stderr.slice(-16 * 1024 * 1024);
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(outputError, code));
    child.stdin.end(JSON.stringify(payload));
  });
}

// Render the current maze view to a PNG via maze-render-frame.js (the same
// renderer humans see in the browser). Returns the absolute path to the
// written frame.
async function renderVisionFrame(session, turnIndex, stateFile) {
  const payload = visionRenderPayload(session, stateFile);
  let dataUrl;
  try {
    dataUrl = await renderVisionFrameViaDaemon(session, payload, stateFile);
  } catch (error) {
    // The one-shot renderer binds a local server too, so if the daemon was
    // blocked from binding, the fallback would fail identically — surface the
    // clear reason instead of wasting another browser boot.
    if (error && error.renderBindBlocked) {
      throw error;
    }
    // Reap the broken browser before trying one clean one-shot render. Without
    // this, a timed-out GPU process and its fallback can run side-by-side.
    await stopRenderDaemon(stateFile, { force: true });
    dataUrl = await renderVisionFrameOneShot(session, payload);
  }
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) {
    throw new Error("maze-render-frame.js did not return a PNG data URL");
  }
  const framesDir = path.join(path.dirname(stateFile), "frames");
  fs.mkdirSync(framesDir, { recursive: true });
  const framePath = path.join(framesDir, `frame-${String(turnIndex).padStart(3, "0")}.png`);
  fs.writeFileSync(framePath, Buffer.from(dataUrl.slice(prefix.length), "base64"));
  return framePath;
}

// Build the status the agent sees. In vision mode, render a perspective image,
// attach its path as frame_image, and drop the ASCII board so the agent must
// look at the picture. A render failure is fatal for this observation: silently
// falling back to ASCII would invalidate a vision benchmark.
async function materializeStatus(session, response, turnIndex, stateFile) {
  const status = response.status || response;

  if (session.observationMode === "json") {
    return { observation: publicObservationStatus(status, { mode: "json" }), ok: true };
  }

  if (!session.vision) {
    return { observation: publicObservationStatus(status, { mode: "text" }), ok: true };
  }

  const printable = publicObservationStatus(status, { mode: "vision" });
  try {
    printable.frame_image = await renderVisionFrame(session, turnIndex, stateFile);
  } catch (error) {
    printable.observation_mode = "vision (render unavailable)";
    printable.frame_error = error instanceof Error ? error.message : String(error);
    return { observation: printable, ok: false, error: printable.frame_error };
  }
  return { observation: printable, ok: true };
}

async function emitStatus(session, response, turnIndex, stateFile) {
  const materialized = await materializeStatus(session, response, turnIndex, stateFile);
  console.log(JSON.stringify(materialized.observation, null, 2));
  return materialized.ok;
}

function persistAction(session, stateFile, commandText, message, response) {
  const status = response.status || response;
  const persistedStatus = storedStatus(session, status);
  const record = {
    turn: session.actions.length + 1,
    timestamp: new Date().toISOString(),
    command_text: commandText,
    valid: true,
    error: null,
    message,
    status: persistedStatus
  };
  session.actions.push(record);
  session.lastStatus = persistedStatus;
  writeJson(stateFile, session);
  fs.appendFileSync(path.join(path.dirname(stateFile), "actions.jsonl"), `${JSON.stringify(record)}\n`);
  return record;
}

function sequenceControlPaths(stateFile) {
  const runDir = process.env.MAZEBENCH_RUN_DIR
    ? path.resolve(process.env.MAZEBENCH_RUN_DIR)
    : path.dirname(stateFile);
  return {
    boundary: path.join(runDir, "pause-boundary.json"),
    request: path.join(runDir, "pause-request.json")
  };
}

function applySequencePauseRequest(stateFile, actionCount, response) {
  const control = sequenceControlPaths(stateFile);
  const request = readJson(control.request, null);
  const requestedAfter = Math.max(0, Number(request?.requested_after_turn) || 0);
  if (!request || actionCount <= requestedAfter) return false;

  const at = new Date().toISOString();
  writeJson(control.boundary, {
    requested_at: request.requested_at || null,
    completed_at: at,
    completed_turn: actionCount,
    provider_thread_can_exit: true
  });
  const status = response?.status && typeof response.status === "object" ? response.status : response;
  if (status && typeof status === "object") {
    status.user_pause_requested = true;
    status.pause_message =
      "The user requested a pause. This action is fully saved. Do not take another maze action; end your response now so this exact thread can resume later.";
    status.allowed_commands = [];
  }
  return true;
}

function sequenceTerminalReason(status) {
  if (Math.max(0, Number(status?.gem_count) || 0) >= GAME_WON_GEM_COUNT) return "game_won";
  if (status?.game_lost || status?.player_dead) return "player_dead";
  if (status?.quit) return "quit";
  return "";
}

async function readStdinJson() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input || "{}");
}

async function runActionSequence(session, stateFile, payload) {
  const actions = Array.isArray(payload?.actions) ? payload.actions : null;
  if (!actions || actions.length < 1) throw new Error("actions must contain at least one item");
  const primary = payload.primary !== false;
  const control = sequenceControlPaths(stateFile);
  const { handleCommand, liveSession } = replayedBridgeSession(session);
  const steps = [];
  let attemptedCount = 0;
  let stopReason = "completed";

  if (primary && fs.existsSync(control.boundary)) {
    return { attempted_count: 0, stop_reason: "user_paused", steps };
  }

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    const before = session.actions.length;
    attemptedCount += 1;

    if (sessionMaxActions(session) != null && before >= sessionMaxActions(session)) {
      stopReason = "move_budget_exhausted";
      break;
    }

    try {
      if (typeof action !== "string" || !action.trim()) {
        throw new Error(`actions[${index}] must be a non-empty string`);
      }
      const commandText = action.trim();
      const message = normalizeAction([commandText]);
      if (message.command === "quit" && session.allowQuit === false) {
        throw new Error(
          "Quit is disabled by the user for this run. Continue playing until the budget is exhausted or the user stops the run."
        );
      }
      const response = applyQuitPolicy(
        consumeRenderState(handleCommand(liveSession, message), stateFile),
        session
      );
      const record = persistAction(session, stateFile, commandText, message, response);
      const paused = primary && applySequencePauseRequest(stateFile, session.actions.length, response);
      const rendered = await materializeStatus(session, response, record.turn, stateFile);
      if (!rendered.ok) {
        stopReason = "error";
        steps.push({
          index: index + 1,
          action: commandText,
          recorded: true,
          action_count_before: before,
          action_count_after: session.actions.length,
          error: rendered.error,
          status: record.status
        });
        break;
      }
      steps.push({
        index: index + 1,
        action: commandText,
        recorded: true,
        action_count_before: before,
        action_count_after: session.actions.length,
        observation: rendered.observation
      });

      if (paused) {
        stopReason = "user_paused";
        break;
      }
      const terminalReason = sequenceTerminalReason(response.status || response);
      if (terminalReason) {
        stopReason = terminalReason;
        break;
      }
      if (
        sessionMaxActions(session) != null &&
        session.actions.length >= sessionMaxActions(session)
      ) {
        stopReason = "move_budget_exhausted";
        break;
      }
    } catch (error) {
      stopReason = "error";
      steps.push({
        index: index + 1,
        action: String(action || ""),
        recorded: session.actions.length > before,
        action_count_before: before,
        action_count_after: session.actions.length,
        error: error instanceof Error ? error.message : String(error),
        status: session.actions.length > before ? session.lastStatus : null
      });
      break;
    }
  }

  return { attempted_count: attemptedCount, stop_reason: stopReason, steps };
}

async function main() {
  const command = process.argv[2] || "help";
  const options = parseArgs(process.argv.slice(3));
  if (command === "help" || !options.state) {
    usage();
    process.exit(command === "help" ? 0 : 2);
  }

  if (command === "start") {
    const observationMode = options.vision
      ? "vision"
      : options.observationMode === "json"
        ? "json"
        : "text";
    const session = {
      actions: [],
      allowQuit: options.allowQuit !== false,
      createdAt: new Date().toISOString(),
      gameId: String(options.game || "maze").trim() || "maze",
      gameWonGemCount: GAME_WON_GEM_COUNT,
      maxActions: normalizedMaxActions(options.maxActions, 100),
      levelId: normalizeLevelId(options.level),
      nodeBin: options.nodeBin || process.execPath,
      observationMode,
      omniscient: observationMode === "json" && Boolean(options.omniscient),
      hideNames: observationMode !== "vision" && Boolean(options.hideNames),
      hideNamesSeed: String(options.hideNamesSeed || "").trim() || "1",
      repoRoot: options.repoRoot,
      view: options.view || "top-diagonal",
      vision: observationMode === "vision",
      visionHeight: positiveInt(options.visionHeight, 512),
      visionView: normalizeVisionView(options.visionView),
      visionWidth: positiveInt(options.visionWidth, 512),
      yaw: normalizeYaw(Number(options.yaw))
    };
    const response = applyQuitPolicy(consumeRenderState(
      runBridge(session, { command: "observe" }),
      options.state
    ), session);
    session.initial = storedStatus(session, response.status || response);
    session.lastStatus = session.initial;
    writeJson(options.state, session);
    writeJson(path.join(path.dirname(options.state), "initial-status.json"), session.initial);
    if (!(await emitStatus(session, response, 0, options.state))) process.exitCode = 1;
    return;
  }

  const session = readJson(options.state, null);
  if (!session) throw new Error(`No session found at ${options.state}`);

  if (command === "action-sequence") {
    const result = await runActionSequence(session, options.state, await readStdinJson());
    console.log(JSON.stringify(result));
    return;
  }

  if (command === "record-no-move") {
    if (process.env.MAZEBENCH_TRUSTED_NO_MOVE !== "1") {
      throw new Error("Unknown command: record-no-move");
    }
    const maxActions = sessionMaxActions(session);
    if (maxActions != null && session.actions.length >= maxActions) {
      console.log(JSON.stringify({ ok: true, recorded: false, reason: "budget_exhausted" }));
      return;
    }
    if (terminalStatus(session.lastStatus || session.initial)) {
      console.log(JSON.stringify({ ok: true, recorded: false, reason: "terminal" }));
      return;
    }
    const message = { command: "no_move" };
    const response = applyQuitPolicy(
      consumeRenderState(runBridge(session, message), options.state),
      session
    );
    const persistedStatus = storedStatus(session, response.status || response);
    const record = {
      turn: session.actions.length + 1,
      timestamp: new Date().toISOString(),
      command_text: "no move",
      valid: true,
      error: null,
      synthetic: true,
      source: "model_no_response",
      message,
      status: persistedStatus
    };
    session.actions.push(record);
    session.lastStatus = persistedStatus;
    writeJson(options.state, session);
    fs.appendFileSync(path.join(path.dirname(options.state), "actions.jsonl"), `${JSON.stringify(record)}\n`);
    console.log(JSON.stringify({ ok: true, recorded: true, action_count: session.actions.length }));
    return;
  }

  if (command === "observe") {
    const response = applyQuitPolicy(consumeRenderState(
      runBridge(session, { command: "observe" }),
      options.state
    ), session);
    if (!(await emitStatus(session, response, session.actions.length, options.state))) process.exitCode = 1;
    return;
  }

  if (command === "scorecard") {
    throw new Error("Scorecards are evaluator-only and are not available to game agents.");
  }

  if (command === "finalize") {
    if (process.env.MAZEBENCH_TRUSTED_FINALIZE !== "1") {
      throw new Error("Unknown command: finalize");
    }
    const response = applyQuitPolicy(consumeRenderState(
      runBridge(session, { command: "scorecard" }),
      options.state
    ), session);
    const scorecard = (response.status || response).scorecard || response.scorecard || response.status || response;
    session.scorecard = scorecard;
    session.lastStatus = storedStatus(session, response.status || response);
    writeJson(options.state, session);
    writeJson(path.join(path.dirname(options.state), "scorecard.json"), session.scorecard);
    console.log(JSON.stringify({ ok: true, finalized: true }, null, 2));
    if (session.vision) await stopRenderDaemon(options.state);
    return;
  }

  if (command === "action") {
    const maxActions = sessionMaxActions(session);
    if (maxActions != null && session.actions.length >= maxActions) {
      throw new Error(
        `MazeBench action budget exhausted (${session.actions.length}/${maxActions}). Finish the run.`
      );
    }
    const message = normalizeAction(options.positional);
    if (message.command === "quit" && session.allowQuit === false) {
      throw new Error("Quit is disabled by the user for this run. Continue playing until the budget is exhausted or the user stops the run.");
    }
    const response = applyQuitPolicy(
      consumeRenderState(runBridge(session, message), options.state),
      session
    );
    const record = persistAction(
      session,
      options.state,
      options.positional.join(" ").trim(),
      message,
      response
    );
    if (!(await emitStatus(session, response, session.actions.length, options.state))) process.exitCode = 1;
    emitTelemetry(record, session.observationMode);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

const invokedThroughMazePlay = require.main && path.basename(require.main.filename) === "maze-play.js";

if (require.main === module || invokedThroughMazePlay) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = {
  publicObservationStatus,
  redactAgentStatus,
  redactVisionStatus,
  requiredActionsRemaining,
  sequenceTerminalReason,
  terminalStatus
};
