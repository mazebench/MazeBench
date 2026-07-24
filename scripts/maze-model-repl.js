#!/usr/bin/env node

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const GAME_WON_GEM_COUNT = 100;

function gameWon(status) {
  return Math.max(0, Number(status?.gem_count) || 0) >= GAME_WON_GEM_COUNT;
}

const ROOT_DIR = path.resolve(__dirname, "..");
const bridgeScript = path.join(ROOT_DIR, "scripts", "maze-bridge.js");
const promptDir = path.join(ROOT_DIR, "environments", "mazebench", "mazebench", "prompts");
const VIEW_NAMES = ["top", "top-diagonal", "diagonal", "side-diagonal", "side"];
const DIRECTION_VALUES = new Set(["up", "down", "left", "right"]);
const LEVEL_PATTERN = /^(?:level_)?([A-Z])x([A-Z])$/i;
const DEATH_MESSAGE = "The player died, you must now undo or reset or go to a level.";
const ALIVE_ALLOWED_COMMANDS = Object.freeze([
  "up",
  "down",
  "left",
  "right",
  "rotate camera up",
  "rotate camera down",
  "rotate camera left",
  "rotate camera right",
  "undo",
  "reset",
  "go to level X Y",
  "quit"
]);
const DEAD_ALLOWED_COMMANDS = Object.freeze([
  "undo",
  "reset",
  "go to level X Y"
]);

function normalizeGameWonGemCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 100;
}

const ACTION_ALIASES = {
  close: "quit",
  go_to_level: "goto_level",
  goto: "goto_level",
  goto_level: "goto_level",
  move: "move",
  quit: "quit",
  reset: "reset_level",
  reset_level: "reset_level",
  rotate: "rotate_camera",
  rotate_camera: "rotate_camera",
  undo: "undo"
};
const ACTION_SCHEMAS = [
  {
    name: "up / down / left / right",
    arguments: {},
    description: "Move the player one screen-relative step."
  },
  {
    name: "rotate camera up / down / left / right",
    arguments: { direction: "up | down | left | right" },
    description: "Rotate the camera: up/down changes pitch, left/right changes yaw."
  },
  {
    name: "undo",
    arguments: {},
    description: "Undo the most recent movement action."
  },
  {
    name: "reset",
    arguments: {},
    description: "Reset the current level to the state it had when you entered it."
  },
  {
    name: "go to level X Y",
    arguments: { x: "world column letter", y: "world row letter" },
    description: "Jump back to a previously visited world level by x/y coordinate letters."
  },
  {
    name: "quit",
    arguments: {},
    description: "End the run as a loss."
  }
];

function parseArgs(argv) {
  const options = {
    gameId: "maze",
    gameWonGemCount: process.env.MAZEBENCH_GAME_WON_GEM_COUNT
      ? normalizeGameWonGemCount(process.env.MAZEBENCH_GAME_WON_GEM_COUNT)
      : null,
    levelId: "level_HxI",
    maxTurns: 40,
    pitch: 1,
    promptOnly: false,
    targetGems: 0,
    yaw: 0
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] || "";

    if (arg === "--game") {
      options.gameId = next();
    } else if (arg === "--game-won-gem-count" || arg === "--game-won-gems") {
      options.gameWonGemCount = normalizeGameWonGemCount(next());
    } else if (arg === "--level") {
      options.levelId = normalizeLevelId(next());
    } else if (arg === "--target-gems") {
      options.targetGems = Math.max(0, Number(next()) || 0);
    } else if (arg === "--max-turns") {
      options.maxTurns = Math.max(1, Number(next()) || options.maxTurns);
    } else if (arg === "--view") {
      options.pitch = pitchFromView(next());
    } else if (arg === "--pitch") {
      options.pitch = clampPitch(Number(next()));
    } else if (arg === "--yaw") {
      options.yaw = normalizeYaw(Number(next()));
    } else if (arg === "--prompt-only") {
      options.promptOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: npm run maze:model -- [options]

Options:
  --level <id>       Maze world level id, for example level_HxI.
  --view <name>      top, top-diagonal, diagonal, side-diagonal, or side.
  --pitch <0-4>      Camera pitch; 0 is top-down, 4 is side.
  --yaw <0-3>        Camera yaw rotation.
  --target-gems <n>  Target gem count used in the multi-turn user prompt.
  --game-won-gem-count <n>
                     Legacy input; game_won is fixed at 100 unique gems.
  --max-turns <n>    Turn budget shown in the local harness instructions.
  --prompt-only      Print the model-facing prompt/actions and exit.

Text actions:
  up
  rotate camera left
  undo
  reset
  go to level A I
  quit

Function-style calls:
  move(direction="up")
  rotate_camera(direction="left")
  goto_level(x="A", y="I")

JSON calls:
  {"command":"move","direction":"up"}
  {"name":"move","arguments":{"direction":"up"}}
  {"function":{"name":"move","arguments":"{\\"direction\\":\\"up\\"}"}}

Local commands:
  help, prompt, q, close`);
}

function normalizeLevelId(value) {
  const raw = String(value || "level_HxI").trim();
  const match = raw.match(LEVEL_PATTERN);
  return match ? `level_${match[1].toUpperCase()}x${match[2].toUpperCase()}` : raw;
}

function normalizeYaw(value) {
  const integerValue = Number.isInteger(value) ? value : 0;
  return ((integerValue % 4) + 4) % 4;
}

function clampPitch(value) {
  return Math.max(0, Math.min(4, Number.isInteger(value) ? value : 1));
}

function pitchFromView(value) {
  const index = VIEW_NAMES.indexOf(String(value || "").toLowerCase());
  return index === -1 ? 1 : index;
}

function readPrompt(filename) {
  return fs.readFileSync(path.join(promptDir, filename), "utf8").trimEnd();
}

function renderTemplate(template, values) {
  return template.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  ));
}

function targetText(targetGems) {
  const target = Number(targetGems) || 0;

  if (target > 0) {
    return `Collect at least ${target} unique gem${target === 1 ? "" : "s"}.`;
  }

  return "Collect as many unique gems as you can within the turn budget.";
}

function screenFromSnapshot(snapshot) {
  if (typeof snapshot.level === "string") {
    const room = snapshot.current_room || "unknown";
    const view = snapshot.current_view || "unknown";
    const yaw = Number.isInteger(snapshot.yaw) ? snapshot.yaw : 0;
    return `maze ${room} | view=${view} yaw=${yaw}\n${snapshot.level}`;
  }

  return String(snapshot.observation || "");
}

function actionResultText(status) {
  const details = [`Previous action: ${status.action || "action"}.`];

  if (status.direction) {
    details.push(`Direction: ${status.direction}.`);
  }
  if (status.room_changed) {
    details.push(`Entered room: ${status.current_room}.`);
  }
  if (status.destination_room) {
    details.push(`Jumped to room: ${status.destination_room}.`);
  }
  if (status.player_dead) {
    details.push(status.death_message || DEATH_MESSAGE);
  }
  if ((status.quit || status.game_lost || gameWon(status)) && status.scorecard) {
    details.push(`Final scorecard:\n${JSON.stringify(status.scorecard, null, 2)}`);
  }

  return details.join(" ");
}

function allowedCommandsForSnapshot(snapshot) {
  if (Array.isArray(snapshot.allowed_commands) && snapshot.allowed_commands.length > 0) {
    return snapshot.allowed_commands.map(String);
  }
  return snapshot.player_dead
    ? Array.from(DEAD_ALLOWED_COMMANDS)
    : Array.from(ALIVE_ALLOWED_COMMANDS);
}

function allowedCommandsText(snapshot) {
  return allowedCommandsForSnapshot(snapshot).map((command) => `- ${command}`).join("\n");
}

function responseInstruction(snapshot) {
  if (snapshot.player_dead) {
    return "Respond with exactly one command line: `undo`, `reset`, or `go to level H I`.";
  }
  return "Respond with exactly one command line, such as `up`, `down`, `rotate camera left`, `go to level H I`, or `quit`.";
}

function noticeText(snapshot, resultText) {
  const notices = [];
  const text = String(resultText || "");
  if (text.startsWith("Previous response was invalid:")) notices.push(text);
  if (snapshot.player_dead) notices.push(snapshot.death_message || DEATH_MESSAGE);
  return [...new Set(notices)].join("\n\n");
}

function renderUserMessage(snapshot, options, resultText = "Start of run.") {
  return renderTemplate(readPrompt("multiturn_user.txt"), {
    current_room: snapshot.current_room || "",
    current_view: snapshot.current_view || "",
    gem_count: Math.max(0, Number(snapshot.gem_count) || 0),
    level: snapshot.level || screenFromSnapshot(snapshot).split("\n").slice(1).join("\n"),
    notice_text: noticeText(snapshot, resultText),
    player_dead: snapshot.player_dead === true,
    response_instruction: responseInstruction(snapshot),
    target_text: targetText(options.targetGems),
    terminal_note: snapshot.player_dead ? "" : "Typing quit ends the run as a loss.",
    visited_levels: Array.isArray(snapshot.visited_levels) ? snapshot.visited_levels.join(", ") : "",
    yaw: Number.isInteger(snapshot.yaw) ? snapshot.yaw : 0
  });
}

function buildModelMessages(snapshot, options) {
  const system = readPrompt("multiturn_system.txt");
  const user = renderUserMessage(snapshot, options);

  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

function printModelContext(snapshot, options) {
  const messages = buildModelMessages(snapshot, options);

  console.log("=== MODEL-FACING MESSAGES ===");
  messages.forEach((message) => {
    console.log(`\n--- ${message.role.toUpperCase()} ---`);
    console.log(message.content);
  });

  console.log("\n=== LOCAL ACTION CHEAT SHEET ===");
  ACTION_SCHEMAS.forEach((action) => {
    console.log(`\n${action.name}`);
    console.log(`  description: ${action.description}`);
    console.log(`  arguments: ${JSON.stringify(action.arguments)}`);
  });

  console.log(`\n=== LOCAL HARNESS ===
Type one text action at a time. Environment responses below are the user messages the model receives next.
Turn budget for this local smoke: ${options.maxTurns}.
`);
}

function splitArgs(value) {
  const parts = [];
  let current = "";
  let quote = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];

    if ((char === "\"" || char === "'") && previous !== "\\") {
      quote = quote === char ? "" : quote || char;
      current += char;
    } else if (char === "," && !quote) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function stripQuotes(value) {
  const text = String(value || "").trim();
  if (
    (text.startsWith("\"") && text.endsWith("\"")) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function parseArgList(value) {
  const args = {};
  const positional = [];

  splitArgs(value).forEach((part) => {
    const match = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|:)\s*(.*)$/);

    if (match) {
      args[match[1]] = stripQuotes(match[2]);
    } else if (part) {
      positional.push(stripQuotes(part));
    }
  });

  if (positional.length > 0) {
    args._positional = positional;
  }

  return args;
}

function parseMaybeJsonArguments(value) {
  if (value && typeof value === "object") {
    return value;
  }

  const text = String(value || "").trim();
  if (!text) {
    return {};
  }

  if (text.startsWith("{")) {
    return JSON.parse(text);
  }

  return parseArgList(text);
}

function normalizeDirection(value, actionName) {
  const direction = String(value || "").toLowerCase();

  if (!DIRECTION_VALUES.has(direction)) {
    throw new Error(`${actionName} direction must be one of: up, down, left, right`);
  }

  return direction;
}

function buildActionMessage(name, args = {}) {
  const rawName = String(name || "").trim().toLowerCase().replace(/\s+/g, "_");
  const positional = Array.isArray(args._positional) ? args._positional : [];

  if (DIRECTION_VALUES.has(rawName)) {
    return { command: "move", direction: rawName };
  }

  const normalizedName = ACTION_ALIASES[rawName];

  if (!normalizedName) {
    throw new Error(`unknown action: ${name}`);
  }

  if (normalizedName === "move") {
    return {
      command: "move",
      direction: normalizeDirection(args.direction ?? positional[0], "move")
    };
  }

  if (normalizedName === "rotate_camera") {
    return {
      command: "rotate_camera",
      direction: normalizeDirection(args.direction ?? positional[0], "rotate_camera")
    };
  }

  if (normalizedName === "undo" || normalizedName === "reset_level" || normalizedName === "quit") {
    return { command: normalizedName };
  }

  if (normalizedName === "goto_level") {
    const x = args.x ?? positional[0];
    const y = args.y ?? positional[1];

    if (!x || !y) {
      throw new Error("goto_level requires x and y coordinate letters");
    }

    return { command: "goto_level", x: String(x).toUpperCase(), y: String(y).toUpperCase() };
  }

  throw new Error(`unknown action: ${name}`);
}

function parseJsonAction(line) {
  const value = JSON.parse(line);
  if (!value || typeof value !== "object") {
    throw new Error("JSON action must be an object");
  }

  if (value.command) {
    return buildActionMessage(value.command, value);
  }

  const functionValue = value.function || value.function_call || {};
  const name = value.name || value.tool || functionValue.name;
  const args = parseMaybeJsonArguments(
    value.arguments ?? value.args ?? functionValue.arguments ?? {}
  );

  return buildActionMessage(name, args);
}

function parseTextAction(line) {
  const trimmed = line.trim();
  const functionMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)$/);

  if (functionMatch) {
    return buildActionMessage(functionMatch[1], parseArgList(functionMatch[2]));
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const lowered = tokens.map((token) => token.toLowerCase());

  if (tokens.length === 1 && DIRECTION_VALUES.has(lowered[0])) {
    return { command: "move", direction: lowered[0] };
  }

  if (tokens.length >= 3 && lowered[0] === "rotate" && lowered[1] === "camera") {
    return buildActionMessage("rotate_camera", { _positional: tokens.slice(2) });
  }

  if (
    tokens.length >= 5 &&
    lowered[0] === "go" &&
    lowered[1] === "to" &&
    lowered[2] === "level"
  ) {
    return buildActionMessage("goto_level", { _positional: tokens.slice(3) });
  }

  const name = tokens.shift();
  const args = {};
  const positional = [];

  tokens.forEach((token) => {
    const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
    if (match) {
      args[match[1]] = stripQuotes(match[2]);
    } else {
      positional.push(stripQuotes(token));
    }
  });

  if (positional.length > 0) {
    args._positional = positional;
  }

  return buildActionMessage(name, args);
}

function parseInputLine(line) {
  const trimmed = line.trim();

  if (!trimmed) {
    return { local: "noop" };
  }

  if (trimmed === "help" || trimmed === "?") {
    return { local: "help" };
  }

  if (trimmed === "prompt") {
    return { local: "prompt" };
  }

  if (trimmed === "q" || trimmed === "close") {
    return { local: "quit" };
  }

  if (trimmed.startsWith("{")) {
    return parseJsonAction(trimmed);
  }

  return parseTextAction(trimmed);
}

function formatAction(message) {
  if (message.command === "move") {
    return message.direction;
  }
  if (message.command === "rotate_camera") {
    return `rotate camera ${message.direction}`;
  }
  if (message.command === "reset_level") {
    return "reset";
  }
  if (message.command === "undo") {
    return "undo";
  }
  if (message.command === "goto_level") {
    return `go to level ${message.x} ${message.y}`;
  }
  if (message.command === "quit") {
    return "quit";
  }

  const args = Object.entries(message)
    .filter(([key]) => key !== "command")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
  return `${message.command}(${args})`;
}

function printEnvResponse(response, options) {
  console.log("\n=== ENV RESPONSE (USER) ===");

  if (response.quit || response.game_lost || gameWon(response)) {
    console.log("The game has ended. No further action is available.");
    return;
  }

  console.log(renderUserMessage(response, options, actionResultText(response)));
}

function createBridge(options) {
  const args = [
    bridgeScript,
    "--game",
    options.gameId,
    "--level",
    options.levelId,
    "--pitch",
    String(options.pitch),
    "--yaw",
    String(options.yaw)
  ];

  if (options.gameWonGemCount !== null) {
    args.push("--game-won-gem-count", String(options.gameWonGemCount));
  }

  const child = spawn(process.execPath, args, {
    cwd: ROOT_DIR,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const output = readline.createInterface({
    input: child.stdout,
    terminal: false
  });
  const pending = [];
  let closeRequested = false;
  let stderr = "";

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  output.on("line", (line) => {
    const next = pending.shift();
    if (!next) {
      return;
    }

    try {
      next.resolve(JSON.parse(line));
    } catch (error) {
      next.reject(error);
    }
  });

  child.on("exit", (code) => {
    while (pending.length > 0) {
      pending.shift().reject(new Error(`maze bridge exited with code ${code}: ${stderr.trim()}`));
    }
  });

  function request(payload) {
    return new Promise((resolve, reject) => {
      if (child.exitCode !== null) {
        reject(new Error(`maze bridge is closed: ${stderr.trim()}`));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error(`maze bridge timed out waiting for ${payload.command}`));
      }, 20000);

      pending.push({
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        }
      });
      closeRequested = closeRequested || payload.command === "close";
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async function close() {
    if (closeRequested || child.exitCode !== null) {
      return;
    }

    try {
      await request({ command: "close" });
    } catch (_error) {
      child.kill();
    }
  }

  return { close, request };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const bridge = createBridge(options);
  let snapshot = await bridge.request({ command: "observe" });

  printModelContext(snapshot, options);

  if (options.promptOnly) {
    await bridge.close();
    return;
  }

  const input = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "input: "
  });

  if (process.stdin.isTTY) {
    input.prompt();
  }

  let closing = false;
  let lineQueue = Promise.resolve();

  async function handleLine(line) {
    if (closing) {
      return;
    }

    try {
      const message = parseInputLine(line);

      if (message.local === "noop") {
        // Keep the prompt responsive on blank lines.
      } else if (message.local === "help") {
        printHelp();
      } else if (message.local === "prompt") {
        printModelContext(snapshot, options);
      } else if (message.local === "quit") {
        closing = true;
        input.close();
        return;
      } else {
        console.log(`\n=== ASSISTANT RESPONSE ===\n${formatAction(message)}`);
        const response = await bridge.request(message);
        printEnvResponse(response, options);

        if (response.ok) {
          snapshot = response;
        }

        if (
          message.command === "quit" ||
          message.command === "close" ||
          response.game_lost ||
          gameWon(response)
        ) {
          closing = true;
          input.close();
          return;
        }
      }
    } catch (error) {
      console.log("\n=== LOCAL PARSE ERROR ===");
      console.log(error instanceof Error ? error.message : String(error));
    } finally {
      if (!closing) {
        input.resume();
      }
      if (!closing && process.stdin.isTTY) {
        input.prompt();
      }
    }
  }

  input.on("line", (line) => {
    lineQueue = lineQueue.then(() => handleLine(line), () => handleLine(line));
  });

  input.on("close", async () => {
    lineQueue = lineQueue.finally(async () => {
      closing = true;
      await bridge.close();
    });
  });
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
