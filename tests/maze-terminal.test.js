const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const terminalScript = path.join(ROOT_DIR, "scripts", "maze-terminal.js");
const bridgeScript = path.join(ROOT_DIR, "scripts", "maze-bridge.js");
const codexPlayScript = path.join(ROOT_DIR, "scripts", "codex-play.js");
const modelReplScript = path.join(ROOT_DIR, "scripts", "maze-model-repl.js");
const {
  expectedReplayPlayerState,
  extractAsciiFrames,
  inferReplayPrefixCommands,
  resolveInput,
  rowFromActionLog
} = require(path.join(ROOT_DIR, "scripts", "maze-export-replay.js"));
const {
  publicObservationStatus,
  redactAgentStatus,
  redactVisionStatus,
  requiredActionsRemaining,
  sequenceTerminalReason,
  terminalStatus
} = require(codexPlayScript);
const { recordNoMoveIfIdle } = require(path.join(ROOT_DIR, "scripts", "maze-agent-local.js"));
const { evaluateAutoQuit } = require(path.join(ROOT_DIR, "shared", "auto-quit.js"));
const { asciiGlyphPalette } = require(path.join(ROOT_DIR, "shared", "maze-ascii-palette.js"));
const {
  applyMove,
  BOARD_STATE_HASH_VERSION,
  boardStateHash,
  buildAsciiLegend,
  buildJsonDisplayPalette,
  buildJsonObservation,
  buildObservationInventory,
  buildScorecard,
  cameraDirectionForInteractiveKey,
  createTerminalContext,
  GAME_WON_GEM_COUNT,
  isGameWon,
  loadMazeEngine,
  normalizeGameWonGemCount,
  replayActionCommands,
  renderScreen,
  resetLevel,
  rotateCamera,
  screenMoveVector,
  stringifyTerminalJson,
  undoMove
} = require(terminalScript);
const mazeEngine = loadMazeEngine();

assert.equal(normalizeGameWonGemCount(1), 100, "legacy threshold overrides cannot lower the global target");
assert.equal(normalizeGameWonGemCount(999), 100, "legacy threshold overrides cannot raise the global target");

for (const mode of ["text", "json", "vision"]) {
  const belowTarget = publicObservationStatus(
    { gem_count: 2, game_won: true, solved: true },
    { mode }
  );
  assert.equal(belowTarget.game_won, false, `${mode} mode derives game_won from the 100-gem target`);
  assert.equal(Object.prototype.hasOwnProperty.call(belowTarget, "solved"), false);
}
assert.equal(publicObservationStatus({ gem_count: 100 }, { mode: "text" }).game_won, true);
assert.equal(terminalStatus({ gem_count: 2, game_won: true, solved: true }), false);
assert.equal(sequenceTerminalReason({ gem_count: 2, game_won: true, solved: true }), "");
assert.equal(terminalStatus({ gem_count: 100 }), true);
assert.equal(sequenceTerminalReason({ gem_count: 100 }), "game_won");

{
  const literal = asciiGlyphPalette();
  assert.equal(literal.P, "#5aa95c");
  assert.equal(literal.G, "#6cd7ff");
  assert.equal(literal.W, "#23262c");
  assert.equal(literal.I, "#a9d6f4");
  assert.equal(literal.C, "#b59a2a");
  assert.equal(literal.U, "#315991");

  const hidden = asciiGlyphPalette({ hideNames: true, hideNamesSeed: "bitmap-seed" });
  assert.equal(hidden.P, "#5aa95c", "hidden ASCII keeps the player glyph and 3D color");
  assert.equal(hidden.G, "#6cd7ff", "hidden ASCII keeps the gem glyph and 3D color");
  assert.notDeepEqual(hidden, literal, "hidden ASCII colors follow the run's glyph permutation");
  assert.deepEqual(
    Object.values(hidden).sort(),
    Object.values(literal).sort(),
    "glyph randomization preserves the complete semantic 3D color palette"
  );

  const legacySeed = asciiGlyphPalette({ hideNames: true, hideNamesSeed: "1" });
  assert.equal(legacySeed.q, "#d6bd94", "adding Unicode identities must not recolor hidden floor glyphs");
  assert.equal(legacySeed.j, "#23262c", "adding Unicode identities must not recolor hidden wall glyphs");
  assert.equal(legacySeed["}"], "#050608", "adding Unicode identities must not recolor hidden empty cells");
  assert.equal(legacySeed["?"], "#315991", "adding Unicode identities must not recolor hidden boxes");
}

assert.deepEqual(expectedReplayPlayerState({ player_dead: false }), {
  known: false,
  player: null
});
assert.deepEqual(expectedReplayPlayerState({ player_dead: true }), {
  known: true,
  player: null
});
assert.deepEqual(expectedReplayPlayerState({
  player: { elevation: 0, x: 4, y: 12 },
  player_dead: false
}), {
  known: true,
  player: { elevation: 0, x: 4, y: 12 }
});

assert.deepEqual(
  inferReplayPrefixCommands(
    { current_room: "level_HxI", current_view: "top", player: { elevation: 0, x: 4, y: 14 }, yaw: 0 },
    { current_room: "level_HxI", current_view: "top", moved: false, player: { elevation: 0, x: 5, y: 14 }, yaw: 0 },
    "down",
    1
  ),
  ["right"]
);
assert.deepEqual(
  inferReplayPrefixCommands(
    { current_room: "level_HxH", current_view: "top", player: { elevation: 0, x: 4, y: 9 }, yaw: 0 },
    { current_room: "level_HxH", current_view: "top", player: { elevation: 0, x: 4, y: 10 }, yaw: 1 },
    "rotate camera right",
    1
  ),
  ["down"]
);
assert.deepEqual(
  inferReplayPrefixCommands(
    { current_room: "level_HxH", current_view: "top", player: { elevation: 0, x: 1, y: 13 }, yaw: 2 },
    { current_room: "level_HxH", current_view: "top", moved: true, player: { elevation: 0, x: 1, y: 11 }, yaw: 2 },
    "down",
    1
  ),
  ["down"]
);

{
  const board = (name) => `maze level_HxI | view=top-diagonal yaw=0\n${name}`;
  const fenced = (name) => `Observation\n\n\`\`\`text\n${board(name)}\n\`\`\``;
  const localPrimeRow = {
    info: {
      maze_actions: ["up", "down", "left"].map((command, index) => ({
        command,
        status: { turn: index + 1 },
        valid: true
      }))
    },
    nodes: [
      { message: { role: "user", content: fenced("BOARD-0") } },
      { message: { role: "assistant", content: "up" } },
      { message: { role: "user", content: fenced("BOARD-1") } },
      { message: { role: "assistant", content: "down" } },
      { message: { role: "assistant", content: "left" } }
    ]
  };
  assert.deepEqual(extractAsciiFrames(localPrimeRow), [
    board("BOARD-0"),
    board("BOARD-1"),
    board("BOARD-1"),
    board("BOARD-1")
  ]);

  const hostedPrimeRow = {
    prompt: [{ role: "user", content: fenced("HOSTED-0") }],
    info: {
      maze_actions: [
        { command: "up", status: { level: board("HOSTED-1") }, valid: true },
        { command: "down", status: { level: board("HOSTED-2") }, valid: true }
      ],
      maze_replay: {}
    }
  };
  assert.deepEqual(extractAsciiFrames(hostedPrimeRow), [
    board("HOSTED-0"),
    board("HOSTED-1"),
    board("HOSTED-2")
  ]);
}

{
  const actionLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-replay-actions-"));
  const actionsPath = path.join(actionLogDir, "actions.jsonl");
  fs.writeFileSync(actionsPath, "{}\n");
  fs.writeFileSync(path.join(actionLogDir, "results.jsonl"), "");
  assert.deepEqual(resolveInput(actionsPath), {
    mode: "actions",
    runDir: actionLogDir,
    actionsPath
  });
  assert.deepEqual(resolveInput(actionLogDir), {
    mode: "actions",
    runDir: actionLogDir,
    actionsPath
  });

  const row = rowFromActionLog(
    [
      {
        command_text: "up",
        valid: true,
        status: { level: "AFTER-UP", current_view: "top", yaw: 1 }
      },
      {
        command_text: "not a maze command",
        valid: false,
        status: { level: "AFTER-INVALID" }
      },
      {
        command_text: "rotate camera right",
        valid: true,
        status: { level: "AFTER-ROTATE", current_view: "top", yaw: 2 }
      }
    ],
    { game_id: "maze", level_id: "level_AB", gem_total: 70 },
    { level: "INITIAL", current_view: "diagonal", yaw: 0 }
  );
  assert.deepEqual(row.maze_actions, [
    { command: "up", valid: true },
    { command: "rotate camera right", valid: true }
  ]);
  assert.deepEqual(row.maze_ascii_frames, ["INITIAL", "AFTER-UP", "AFTER-ROTATE"]);
  assert.deepEqual(row.maze_replay.action_statuses, [
    { level: "AFTER-UP", current_view: "top", yaw: 1 },
    { level: "AFTER-ROTATE", current_view: "top", yaw: 2 }
  ]);
  assert.equal(row.maze_replay.start_level_id, "level_AB");
  assert.equal(row.maze_replay.game_won_gem_count, 100);
  assert.deepEqual(row.maze_replay.initial, { view: "diagonal", yaw: 0 });

  const rejectedGoto = rowFromActionLog(
    [
      {
        command_text: "go to level G I",
        valid: false,
        error: "cannot goto unvisited level: level_GxI",
        status: { level: "SAME-ROOM", current_room: "level_HxI" }
      }
    ],
    { game_id: "maze", level_id: "level_HxI", gem_total: 70 },
    { level: "INITIAL", current_view: "top", yaw: 0 }
  );
  assert.deepEqual(rejectedGoto.maze_actions, [
    { command: "go to level G I", valid: true }
  ]);
  assert.equal(rejectedGoto.maze_replay.action_statuses[0].replay_action_valid, false);
  assert.match(rejectedGoto.maze_replay.action_statuses[0].replay_action_error, /unvisited/);
  assert.deepEqual(rejectedGoto.maze_ascii_frames, ["INITIAL", "SAME-ROOM"]);

  const bridgedGap = rowFromActionLog(
    [
      {
        command_text: "down",
        valid: true,
        status: {
          action_count: 1,
          current_room: "level_HxI",
          current_view: "top",
          moved: true,
          player: { elevation: 0, x: 4, y: 14 },
          yaw: 0
        }
      },
      {
        command_text: "down",
        valid: true,
        status: {
          action_count: 3,
          current_room: "level_HxI",
          current_view: "top",
          moved: false,
          player: { elevation: 0, x: 5, y: 14 },
          yaw: 0
        }
      }
    ],
    {},
    {
      action_count: 0,
      current_room: "level_HxI",
      current_view: "top",
      player: { elevation: 0, x: 4, y: 13 },
      yaw: 0
    }
  );
  assert.deepEqual(bridgedGap.maze_replay.action_statuses[1].replay_prefix_commands, ["right"]);
  fs.rmSync(actionLogDir, { recursive: true, force: true });
}

{
  const config = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, "games", "maze", "config.json"), "utf8")
  );
  assert.equal(config.game_won_gem_count, 100);
  assert.equal(GAME_WON_GEM_COUNT, config.game_won_gem_count);
}

function runTerminal(args) {
  return execFileSync(process.execPath, [terminalScript, ...args], {
    cwd: ROOT_DIR,
    encoding: "utf8"
  });
}

function runBridge(commands, args = []) {
  const input = `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`;
  const output = execFileSync(process.execPath, [bridgeScript, ...args], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    input,
    maxBuffer: 10 * 1024 * 1024
  });

  return output.trim().split("\n").map((line) => JSON.parse(line));
}

function runModelRepl(input, args = []) {
  return execFileSync(process.execPath, [modelReplScript, ...args], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    input,
    maxBuffer: 20 * 1024 * 1024
  });
}

function runCodexPlay(args) {
  return JSON.parse(execFileSync(process.execPath, [codexPlayScript, ...args], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  }));
}

function runCodexPlayRaw(args) {
  return execFileSync(process.execPath, [codexPlayScript, ...args], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
}

function runCodexPlayFailure(args) {
  return spawnSync(process.execPath, [codexPlayScript, ...args], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
}

function body(output) {
  return output.split("\n").slice(1).join("\n");
}

function bodyRows(output) {
  return body(output).split("\n").filter(Boolean);
}

function countMatches(value, pattern) {
  return (value.match(pattern) || []).length;
}

function assertMove(move, yaw, expected) {
  assert.deepEqual(screenMoveVector(move, yaw), expected);
}

{
  const secretBoard = "maze level_HxI | view=top\nASCII-BOARD-SECRET";
  const source = {
    _render_state: { actors: [{ type: "player", x: 1, y: 2, elevation: 0 }] },
    level: secretBoard,
    board: secretBoard,
    player: { x: 1, y: 2, elevation: 0 },
    observation: { screen: secretBoard },
    nested: {
      header: "board header",
      json_observation: { objects: { player: [[1, 2, 0]] } },
      scorecard: { actions: { total: 9 }, gems: { collected: 1 } }
    },
    current_room: "level_HxI",
    moved: false,
    board_state_hash: "model-secret-state-hash",
    board_state_hash_version: 1,
    collected_gems: ["gem-secret"],
    collected_this_action: ["gem-secret"],
    push_count: 4,
    pushes_this_action: 1,
    novel_push_count: 3,
    novel_pushes_this_action: 1,
    frame_image: "/tmp/frame.png"
  };
  const redacted = redactVisionStatus(source);

  assert.equal(JSON.stringify(redacted).includes(secretBoard), false);
  assert.equal(redacted.current_room, "level_HxI");
  assert.equal(redacted.frame_image, "/tmp/frame.png");
  assert.equal(Object.prototype.hasOwnProperty.call(redacted, "player"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(redacted, "moved"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(redacted, "board_state_hash"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(redacted, "board_state_hash_version"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(redacted, "collected_gems"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(redacted, "collected_this_action"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(redacted, "push_count"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(redacted, "pushes_this_action"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(redacted, "novel_push_count"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(redacted, "novel_pushes_this_action"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(redacted.nested, "scorecard"), false);

  const text = redactAgentStatus(source, { mode: "text" });
  assert.equal(text.level, secretBoard);
  assert.equal(Object.prototype.hasOwnProperty.call(text, "player"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(text, "_render_state"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(text, "moved"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(text, "board_state_hash"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(text.nested, "json_observation"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(text.nested, "scorecard"), false);

  const json = redactAgentStatus(source, { mode: "json" });
  assert.deepEqual(json.player, { x: 1, y: 2, elevation: 0 });
  assert.deepEqual(json.nested.json_observation.objects.player, [[1, 2, 0]]);
  assert.equal(Object.prototype.hasOwnProperty.call(json, "level"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(json, "moved"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(json, "board_state_hash"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(json.nested, "scorecard"), false);

  const internal = redactAgentStatus(source, { mode: "json", includeInternalSignals: true });
  assert.equal(internal.moved, false);
  assert.equal(internal.board_state_hash, "model-secret-state-hash");
  assert.equal(internal.board_state_hash_version, 1);
  assert.deepEqual(internal.collected_gems, ["gem-secret"]);
  assert.equal(internal.push_count, 4);

  const unfinished = {
    actions: [{ command: "up" }],
    allowQuit: false,
    lastStatus: { game_won: false },
    maxActions: 2
  };
  assert.equal(requiredActionsRemaining(unfinished), 1);
  assert.equal(requiredActionsRemaining({ ...unfinished, maxActions: null }), null);
}

function createContext(overrides = {}) {
  return createTerminalContext(mazeEngine, {
    gameId: "maze",
    levelId: "level_AxA",
    moves: "",
    pitch: 0,
    yaw: 0,
    once: true,
    ...overrides
  });
}

function playerPosition(context) {
  for (let index = 0; index < context.engine.actorCount; index += 1) {
    if (
      !context.state.actorRemoved[index] &&
      context.engine.actorTypes[index] === "player"
    ) {
      return {
        elevation: context.state.actorElevation[index],
        x: context.state.actorX[index],
        y: context.state.actorY[index]
      };
    }
  }

  return null;
}

function renderSynthetic(playData, overrides = {}) {
  const engine = mazeEngine.createEngine(playData);
  return renderScreen({
    engine,
    level: { id: playData.levelId },
    options: {
      pitch: 2,
      yaw: 0,
      ...overrides
    },
    playData,
    state: engine.cloneState(engine.initialState)
  });
}

function syntheticContext(playData, overrides = {}) {
  const engine = mazeEngine.createEngine(playData);
  return {
    engine,
    level: { id: playData.levelId },
    options: { pitch: 1, yaw: 0, ...overrides },
    playData,
    state: engine.cloneState(engine.initialState),
    stats: null
  };
}

function syntheticFloor(width, height) {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({
      type: "floor",
      label: "Floor",
      imageUrl: null,
      underlay: null,
      raised: false
    }))
  );
}

{
  const parsing = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, "games", "maze", "level_parsing.json"), "utf8")
  );
  const actorTypes = new Set([
    "box",
    "circle_player",
    "clone",
    "floating_floor",
    "gem",
    "orange_button",
    "player",
    "puncher",
    "weightless_box"
  ]);
  const terrainSources = [];
  const actors = [];

  Object.entries(parsing.objects).forEach(([name, definition]) => {
    const type = definition.type || name;
    const tokenEntries = Array.isArray(definition.tokens)
      ? definition.tokens
      : [definition.token || name];

    tokenEntries.forEach((entryValue) => {
      const entry = typeof entryValue === "string" ? { token: entryValue } : entryValue;
      const source = {
        type,
        direction: entry.direction || null,
        groupId: ["clone", "weightless_box"].includes(type) ? entry.token : null,
        label: entry.label || definition.label || name,
        modelUrl: definition.model ? `/assets/maze/${definition.model}` : null,
        styleKey: entry.style_key || null,
        token: entry.token
      };
      if (actorTypes.has(type)) actors.push(source);
      else terrainSources.push(source);
    });
  });

  terrainSources.push({ type: "empty" }, { type: "hole" });
  actors.push(
    { type: "clone", groupId: "c999" },
    { type: "clone", groupId: "c999", shape: "slope", direction: "up" },
    { type: "weightless_box", groupId: "M712" },
    { type: "weightless_box", groupId: "M712", shape: "slope", direction: "left" },
    { type: "attached_lift", raised: false },
    { type: "attached_gate" }
  );

  const width = terrainSources.length + actors.length;
  const terrain = syntheticFloor(width, 1);
  terrainSources.forEach((source, x) => {
    terrain[0][x] = source.type === "empty"
      ? { type: "empty" }
      : { type: source.type, ...source, layers: [{ elevation: 0, ...source }] };
  });
  const actorOffset = terrainSources.length;
  const playData = {
    actors: actors.map((actor, index) => ({
      ...actor,
      elevation: 0,
      removed: false,
      x: actorOffset + index,
      y: 0
    })),
    gameId: "maze",
    height: 1,
    levelId: "complete_observation_inventory",
    terrain,
    width
  };
  const context = syntheticContext(playData, { pitch: 0, yaw: 0 });
  const report = buildObservationInventory(context);
  const sourceTypes = new Set(report.map((entry) => entry.sourceType));
  const names = new Set(report.map((entry) => entry.name));

  Object.entries(parsing.objects).forEach(([name, definition]) => {
    assert.equal(
      sourceTypes.has(definition.type || name),
      true,
      `${name} must be covered by the observation inventory`
    );
  });
  report.forEach((entry) => {
    assert.notEqual(entry.name, "unknown", `${entry.sourceType} must have a semantic JSON name`);
    assert.notDeepEqual(entry.glyph, { top: "|", side: "\\" }, `${entry.sourceType} must have an actor glyph`);
    assert.notDeepEqual(entry.glyph, { top: "`", side: "'" }, `${entry.sourceType} must have a terrain glyph`);
  });
  [
    "black_ice_slope_up",
    "orange_ice_slope_down",
    "clone_c999",
    "ramped_clone_c999_up",
    "weightless_push_box_M712",
    "ramped_weightless_push_box_M712_left",
    "attached_player_lift_lowered"
  ].forEach((name) => assert.equal(names.has(name), true, `${name} must be lifted`));
}

{
  const playData = {
    actors: [{ type: "player", x: 0, y: 0, elevation: 0, removed: false }],
    gameId: "maze",
    height: 1,
    levelId: "board_state_hash",
    terrain: syntheticFloor(2, 1),
    width: 2
  };
  const context = syntheticContext(playData, { pitch: 0, yaw: 0 });
  const initialHash = boardStateHash(context);
  context.options.pitch = 4;
  context.options.yaw = 3;
  assert.equal(
    boardStateHash(context),
    initialHash,
    "camera changes do not create new canonical board states"
  );
  context.state.actorX[0] = 1;
  assert.notEqual(boardStateHash(context), initialHash, "actor x/y/z changes alter the hash");
  context.state.actorX[0] = 0;
  assert.equal(boardStateHash(context), initialHash, "restoring every object restores the hash");
  context.stats = { collectedGemIds: new Set(["level_AxA:gem:1,1,0"]) };
  assert.equal(
    boardStateHash(context),
    initialHash,
    "world-level collected gems do not alter board novelty"
  );
}

{
  const basePlayData = {
    actors: [{ type: "player", x: 0, y: 0, elevation: 0, removed: false }],
    gameId: "maze",
    height: 1,
    levelId: "board_state_hash_gems",
    terrain: syntheticFloor(2, 1),
    width: 2
  };
  const withGemPlayData = {
    ...basePlayData,
    actors: basePlayData.actors.concat({
      type: "gem",
      collectionId: "board_state_hash_gems:gem:1,0,0",
      x: 1,
      y: 0,
      elevation: 0,
      removed: false
    })
  };
  const initialHash = boardStateHash(syntheticContext(basePlayData));
  const gemContext = syntheticContext(withGemPlayData);
  assert.equal(boardStateHash(gemContext), initialHash, "in-room gems do not alter board novelty");
  gemContext.state.actorX[1] = 0;
  gemContext.state.actorElevation[1] = 1;
  gemContext.state.actorRemoved[1] = 1;
  assert.equal(
    boardStateHash(gemContext),
    initialHash,
    "moving or removing an in-room gem does not alter board novelty"
  );
}

{
  const actors = [
    { type: "player", x: 3, y: 0, elevation: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 0, removed: false }
  ];
  const playData = {
    actors,
    gameId: "maze",
    height: 1,
    levelId: "board_state_hash_actor_order",
    terrain: syntheticFloor(4, 1),
    width: 4
  };
  const reorderedPlayData = {
    ...playData,
    actors: [actors[1], actors[2], actors[0]]
  };
  assert.equal(
    boardStateHash(syntheticContext(reorderedPlayData)),
    boardStateHash(syntheticContext(playData)),
    "equivalent actor lists hash identically regardless of engine array order"
  );

  const regroupedPlayData = {
    ...playData,
    actors: actors.map((actor, index) => index === 1 ? { ...actor, groupId: "M1" } : actor)
  };
  assert.notEqual(
    boardStateHash(syntheticContext(regroupedPlayData)),
    boardStateHash(syntheticContext(playData)),
    "gameplay-relevant actor group identity remains part of the canonical state"
  );
}

{
  assert.equal(cameraDirectionForInteractiveKey("w"), "up");
  assert.equal(cameraDirectionForInteractiveKey("W"), "up");
  assert.equal(cameraDirectionForInteractiveKey("s"), "down");
  assert.equal(cameraDirectionForInteractiveKey("a"), "left");
  assert.equal(cameraDirectionForInteractiveKey("d"), "right");
  assert.equal(cameraDirectionForInteractiveKey("i"), null);
  assert.equal(cameraDirectionForInteractiveKey("k"), null);
  assert.equal(cameraDirectionForInteractiveKey("j"), null);
  assert.equal(cameraDirectionForInteractiveKey("l"), null);
}

{
  const value = {
    json_observation: {
      objects: {
        player: [[7, 11, 0]],
        wall: [[0, 0, 0], [1, 0, 0], [2, 0, 0]]
      }
    },
    visited_levels: ["level_CxD", "level_CxE"]
  };
  const output = stringifyTerminalJson(value);

  assert.deepEqual(JSON.parse(output), value);
  assert.match(output, /^  "json_observation": \{$/m);
  assert.match(output, /^      "wall": \[\[0,0,0\],\[1,0,0\],\[2,0,0\]\]$/m);
  assert.match(output, /^  "visited_levels": \["level_CxD","level_CxE"\]$/m);
}

{
  const output = runTerminal(["--help"]);

  assert.match(output, /W\/S\s+Pitch Camera Up\/Down/);
  assert.match(output, /A\/D\s+Yaw Camera Left\/Right/);
  assert.doesNotMatch(output, /i\/k|j\/l/);
}

{
  const terrain = syntheticFloor(2, 1);
  terrain[0][0] = {
    type: "ice_slope",
    layers: [{ type: "ice_slope", direction: "up", elevation: 0 }]
  };
  const playData = {
    actors: [
      { type: "puncher", direction: "up", x: 1, y: 0, removed: false, elevation: 0 }
    ],
    gameId: "maze",
    height: 1,
    levelId: "json_directions",
    terrain,
    width: 2
  };
  const context = syntheticContext(playData, { pitch: 0 });
  const expected = ["up", "right", "down", "left"];

  expected.forEach((direction, yaw) => {
    context.options.yaw = yaw;
    const observation = buildJsonObservation(context, { omniscient: true });
    assert.deepEqual(observation.objects[`ice_slope_${direction}`], [[0, 0, 1]]);
    assert.deepEqual(observation.objects[`puncher_${direction}`], [[1, 0, 1]]);
  });
}

{
  const terrain = syntheticFloor(2, 1);
  terrain[0][1] = {
    type: "player_lift",
    raised: false,
    layers: [{ type: "player_lift", elevation: 0, raised: false }]
  };
  const playData = {
    actors: [],
    gameId: "maze",
    height: 1,
    levelId: "player_lift_top_diagonal",
    terrain,
    width: 2
  };
  const context = syntheticContext(playData, { pitch: 1 });

  assert.equal(
    body(renderScreen(context)),
    ["AAAA>>>>", "AAAA>>>>", "AAAA>>>>", "aaaallll"].join("\n")
  );

  context.state.liftRaised[1] = 1;

  assert.equal(
    body(renderScreen(context)),
    ["    LLLL", "AAAALLLL", "AAAALLLL", "AAAAllll", "aaaa    "].join("\n")
  );

  context.options.pitch = 4;

  assert.equal(
    body(renderScreen(context)),
    ["    llll", "    llll", "    llll", "    llll", "aaaa    "].join("\n")
  );
}

{
  const terrain = syntheticFloor(3, 1);
  terrain[0][0] = {
    type: "wall",
    layers: [{ type: "wall", elevation: 0 }]
  };
  terrain[0][1] = {
    type: "player_lift",
    raised: true,
    layers: [{ type: "player_lift", elevation: 0, raised: true }]
  };
  terrain[0][2] = {
    type: "wall",
    layers: [{ type: "wall", elevation: 0 }]
  };
  const playData = {
    actors: [],
    gameId: "maze",
    height: 1,
    levelId: "raised_player_lift_between_walls",
    terrain,
    width: 3
  };
  const context = syntheticContext(playData, { pitch: 1 });

  assert.equal(
    body(renderScreen(context)),
    [
      "WWWWLLLLWWWW",
      "WWWWLLLLWWWW",
      "WWWWLLLLWWWW",
      "wwwwllllwwww"
    ].join("\n")
  );
}

{
  const terrain = syntheticFloor(3, 1);
  terrain[0][1] = {
    type: "player_lift",
    raised: false,
    layers: [{ type: "player_lift", elevation: 0, raised: false }]
  };
  terrain[0][2] = {
    type: "wall",
    layers: [{ type: "wall", elevation: 0 }]
  };
  const playData = {
    actors: [{ type: "player", x: 0, y: 0, removed: false, elevation: 0 }],
    gameId: "maze",
    height: 1,
    levelId: "dynamic_player_lift_observation",
    terrain,
    width: 3
  };
  const context = syntheticContext(playData, { pitch: 0 });
  const loweredAscii = body(renderScreen(context));
  const loweredJson = buildJsonObservation(context, { omniscient: true });

  assert.match(loweredAscii, />>>>/);
  assert.deepEqual(loweredJson.objects.player_lift_lowered, [[1, 0, 0]]);
  assert.deepEqual(loweredJson.objects.player, [[0, 0, 1]]);
  assert.deepEqual(loweredJson.objects.wall, [[2, 0, 1]]);
  assert.equal(loweredJson.objects.player_lift_raised, undefined);

  const ontoLift = context.engine.move(context.state, 1, 0);
  const raisedJson = buildJsonObservation(context, { omniscient: true });

  assert.equal(ontoLift.moved, true);
  assert.deepEqual(ontoLift.liftToggles, [{ x: 1, y: 0, raised: true }]);
  assert.deepEqual(raisedJson.objects.player_lift_raised, [[1, 0, 1]]);
  assert.equal(raisedJson.objects.player_lift_lowered, undefined);
  assert.deepEqual(raisedJson.objects.player, [[1, 0, 2]]);

  const offLift = context.engine.move(context.state, 1, 0);
  const raisedAscii = body(renderScreen(context));

  assert.equal(offLift.moved, true);
  assert.match(raisedAscii, /LLLL/);
  assert.doesNotMatch(raisedAscii, /llll/);
}

{
  const terrain = syntheticFloor(3, 1);
  terrain[0][2] = {
    type: "player_gate",
    layers: [{ type: "player_gate", elevation: 0 }]
  };
  const playData = {
    actors: [{ type: "player", x: 1, y: 0, removed: false, elevation: 0 }],
    gameId: "maze",
    height: 1,
    levelId: "dynamic_player_gate_observation",
    terrain,
    width: 3
  };
  const context = syntheticContext(playData, { pitch: 0 });
  const raisedAscii = body(renderScreen(context));
  const raisedJson = buildJsonObservation(context, { omniscient: true });

  assert.match(raisedAscii, /YYYY/);
  assert.deepEqual(raisedJson.objects.floor, [
    [0, 0, 0],
    [1, 0, 0]
  ]);
  assert.deepEqual(raisedJson.objects.player_gate, [[2, 0, 1]]);

  context.options.pitch = 4;
  const raisedSideAscii = body(renderScreen(context));
  const awayFromGate = context.engine.move(context.state, -1, 0);
  const loweredSideAscii = body(renderScreen(context));
  const loweredJson = buildJsonObservation(context, { omniscient: true });

  assert.equal(awayFromGate.moved, true);
  assert.equal(countMatches(raisedSideAscii, /y/g), 16);
  assert.equal(countMatches(loweredSideAscii, /y/g), 0);
  assert.deepEqual(loweredJson.objects.player_gate, [[2, 0, 0]]);

  context.options.pitch = 0;
  const loweredAscii = body(renderScreen(context));

  assert.match(loweredAscii, /YYYY/);
  assert.doesNotMatch(loweredAscii, /yyyy/);

  const towardGate = context.engine.move(context.state, 1, 0);
  const raisedAgainAscii = body(renderScreen(context));
  const raisedAgainJson = buildJsonObservation(context, { omniscient: true });

  assert.equal(towardGate.moved, true);
  assert.match(raisedAgainAscii, /YYYY/);
  assert.deepEqual(raisedAgainJson.objects.player_gate, [[2, 0, 1]]);
}

{
  const terrain = syntheticFloor(3, 1);
  terrain[0][2] = {
    type: "orange_wall",
    layers: [{ type: "orange_wall", elevation: 0 }]
  };
  const playData = {
    actors: [
      { type: "player", x: 1, y: 0, removed: false, elevation: 0 },
      { type: "orange_button", x: 0, y: 0, removed: false, elevation: 0 }
    ],
    gameId: "maze",
    height: 1,
    levelId: "dynamic_orange_wall_observation",
    terrain,
    width: 3
  };
  const context = syntheticContext(playData, { pitch: 0 });
  const raisedAscii = body(renderScreen(context));
  const raisedJson = buildJsonObservation(context, { omniscient: true });

  assert.match(raisedAscii, /OOOO/);
  assert.deepEqual(raisedJson.objects.orange_wall, [[2, 0, 1]]);

  context.options.pitch = 4;
  const raisedSideAscii = body(renderScreen(context));
  const ontoButton = context.engine.move(context.state, -1, 0);
  const loweredSideAscii = body(renderScreen(context));
  const loweredJson = buildJsonObservation(context, { omniscient: true });

  assert.equal(ontoButton.moved, true);
  assert.equal(countMatches(raisedSideAscii, /o/g), 16);
  assert.equal(countMatches(loweredSideAscii, /o/g), 0);
  assert.deepEqual(loweredJson.objects.orange_wall, [[2, 0, 0]]);

  context.options.pitch = 0;
  const loweredAscii = body(renderScreen(context));
  assert.match(loweredAscii, /OOOO/);
  assert.doesNotMatch(loweredAscii, /oooo/);

  const offButton = context.engine.move(context.state, 1, 0);
  const releasedJson = buildJsonObservation(context, { omniscient: true });

  assert.equal(offButton.moved, true);
  assert.deepEqual(releasedJson.objects.orange_wall, [[2, 0, 1]]);
}

{
  const terrain = syntheticFloor(3, 1);
  terrain[0][2] = {
    type: "wall",
    layers: [
      { type: "wall", elevation: 0 },
      { type: "orange_wall", elevation: 1 }
    ]
  };
  const playData = {
    actors: [
      { type: "player", x: 1, y: 0, removed: false, elevation: 0 },
      { type: "orange_button", x: 0, y: 0, removed: false, elevation: 0 }
    ],
    gameId: "maze",
    height: 1,
    levelId: "supported_orange_wall_observation",
    terrain,
    width: 3
  };
  const context = syntheticContext(playData, { pitch: 1 });
  const raisedJson = buildJsonObservation(context, { omniscient: true });

  assert.deepEqual(raisedJson.objects.orange_wall, [[2, 0, 2]]);

  const ontoButton = context.engine.move(context.state, -1, 0);
  const loweredTopDiagonal = body(renderScreen(context));
  const loweredJson = buildJsonObservation(context, { omniscient: true });

  assert.equal(ontoButton.moved, true);
  assert.equal(countMatches(loweredTopDiagonal, /O/g), 12);
  assert.equal(countMatches(loweredTopDiagonal, /w/g), 4);
  assert.deepEqual(loweredJson.objects.orange_wall, [[2, 0, 1]]);

  context.options.pitch = 4;
  const loweredSide = body(renderScreen(context));

  assert.equal(countMatches(loweredSide, /O/g), 0);
  assert.equal(countMatches(loweredSide, /w/g), 16);
}

{
  const terrain = syntheticFloor(3, 1);
  terrain[0][2] = {
    type: "orange_ice_slope",
    layers: [{
      type: "orange_ice_slope",
      direction: "up",
      elevation: 0,
      styleKey: "orange"
    }]
  };
  const playData = {
    actors: [
      { type: "player", x: 1, y: 0, removed: false, elevation: 0 },
      { type: "orange_button", x: 0, y: 0, removed: false, elevation: 0 }
    ],
    gameId: "maze",
    height: 1,
    levelId: "orange_ice_slope_observation",
    terrain,
    width: 3
  };
  const context = syntheticContext(playData, { pitch: 0, yaw: 0 });
  const raised = buildJsonObservation(context, { omniscient: true });

  assert.deepEqual(raised.objects.orange_ice_slope_up, [[2, 0, 1]]);
  assert.match(body(renderScreen(context)), /↑↑↑↑/);

  context.options.yaw = 1;
  const rotated = buildJsonObservation(context, { omniscient: true });
  assert.deepEqual(rotated.objects.orange_ice_slope_right, [[2, 0, 1]]);
  assert.match(body(renderScreen(context)), /→→→→/);

  context.options.yaw = 0;
  assert.equal(context.engine.move(context.state, -1, 0).moved, true);
  const lowered = buildJsonObservation(context, { omniscient: true });
  assert.deepEqual(lowered.objects.orange_ice_slope_up, [[2, 0, 0]]);
  context.options.pitch = 4;
  assert.doesNotMatch(body(renderScreen(context)), /⇧/);
}

{
  const terrain = [[{
    type: "ice_slope",
    layers: [{
      type: "ice_slope",
      direction: "left",
      elevation: 0,
      styleKey: "wall"
    }]
  }]];
  const playData = {
    actors: [],
    gameId: "maze",
    height: 1,
    levelId: "black_ice_slope_observation",
    terrain,
    width: 1
  };
  const context = syntheticContext(playData, { pitch: 0, yaw: 0 });
  assert.deepEqual(
    buildJsonObservation(context, { omniscient: true }).objects.black_ice_slope_left,
    [[0, 0, 1]]
  );
  assert.equal(body(renderScreen(context)), ["◀◀◀◀", "◀◀◀◀", "◀◀◀◀", "◀◀◀◀"].join("\n"));
}

{
  const playData = {
    actors: [
      { type: "clone", groupId: "c27", x: 0, y: 0, removed: false, elevation: 0 },
      { type: "clone", groupId: "c27", x: 1, y: 0, removed: false, elevation: 0 },
      {
        type: "clone",
        groupId: "c27",
        shape: "slope",
        direction: "up",
        x: 2,
        y: 0,
        removed: false,
        elevation: 0
      },
      { type: "weightless_box", groupId: "M712", x: 3, y: 0, removed: false, elevation: 0 },
      {
        type: "weightless_box",
        groupId: "M712",
        shape: "slope",
        direction: "left",
        x: 4,
        y: 0,
        removed: false,
        elevation: 0
      },
      { type: "circle_player", x: 5, y: 0, removed: false, elevation: 0 }
    ],
    gameId: "maze",
    height: 1,
    levelId: "arbitrary_group_observation",
    terrain: syntheticFloor(6, 1),
    width: 6
  };
  const context = syntheticContext(playData, { pitch: 0, yaw: 0 });
  const json = buildJsonObservation(context, { omniscient: true });
  const legend = buildAsciiLegend(context);
  const topGlyphs = legend.map((entry) => entry.top);

  assert.equal(json.schema_version, 2);
  assert.deepEqual(json.objects.clone_c27, [[0, 0, 1], [1, 0, 1]]);
  assert.deepEqual(json.objects.ramped_clone_c27_up, [[2, 0, 1]]);
  assert.deepEqual(json.objects.weightless_push_box_M712, [[3, 0, 1]]);
  assert.deepEqual(json.objects.ramped_weightless_push_box_M712_left, [[4, 0, 1]]);
  assert.deepEqual(json.objects.player, [[5, 0, 1]]);
  assert.equal(legend.length, 4);
  assert.equal(new Set(topGlyphs).size, 4);
  topGlyphs.forEach((glyph) => assert.match(body(renderScreen(context)), new RegExp(glyph.repeat(4))));

  context.options.yaw = 1;
  const rotated = buildJsonObservation(context, { omniscient: true });
  assert.deepEqual(rotated.objects.ramped_clone_c27_right, [[2, 0, 1]]);
  assert.deepEqual(rotated.objects.ramped_weightless_push_box_M712_up, [[4, 0, 1]]);
}

{
  const playData = {
    actors: [
      { type: "player", x: 0, y: 0, removed: false, elevation: 0 },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false, elevation: 0 },
      { type: "attached_lift", x: 1, y: 0, removed: false, elevation: 1, raised: false },
      { type: "weightless_box", groupId: "M1", x: 3, y: 0, removed: false, elevation: 0 },
      { type: "attached_gate", x: 3, y: 0, removed: false, elevation: 1 }
    ],
    gameId: "maze",
    height: 1,
    levelId: "attached_device_observation",
    terrain: syntheticFloor(4, 1),
    width: 4
  };
  const context = syntheticContext(playData, { pitch: 0 });
  const lowered = buildJsonObservation(context, { omniscient: true });

  assert.deepEqual(lowered.objects.attached_player_lift_lowered, [[1, 0, 1]]);
  assert.deepEqual(lowered.objects.attached_player_gate_lowered, [[3, 0, 1]]);

  context.state.liftRaised[1] = 1;
  context.state.actorX[0] = 2;
  const raised = buildJsonObservation(context, { omniscient: true });
  assert.deepEqual(raised.objects.attached_player_lift_raised, [[1, 0, 2]]);
  assert.deepEqual(raised.objects.attached_player_gate_raised, [[3, 0, 2]]);
}

{
  const playData = {
    actors: [
      { type: "box", x: 0, y: 0, removed: false, elevation: 0 },
      { type: "player", x: 0, y: 1, removed: false, elevation: 0 }
    ],
    gameId: "maze",
    height: 2,
    levelId: "json_clipped_actor",
    terrain: syntheticFloor(1, 2),
    width: 1
  };
  const observation = buildJsonObservation(syntheticContext(playData, { pitch: 3 }), {
    omniscient: false
  });

  // Only one four-character row of the rear box survives, but that is enough.
  assert.deepEqual(observation.objects.box, [[0, 0, 1]]);
}

{
  const terrain = syntheticFloor(1, 2);
  terrain[1][0] = { type: "tree", layers: [{ type: "tree", elevation: 0 }] };
  const playData = {
    actors: [
      { type: "box", x: 0, y: 0, removed: false, elevation: 0 },
      { type: "player", x: 0, y: 1, removed: false, elevation: 0 }
    ],
    gameId: "maze",
    height: 2,
    levelId: "json_occluded_actor",
    terrain,
    width: 1
  };
  const context = syntheticContext(playData, { pitch: 2 });
  const limited = buildJsonObservation(context, { omniscient: false });
  const omniscient = buildJsonObservation(context, { omniscient: true });

  assert.equal(limited.objects.box, undefined);
  assert.deepEqual(omniscient.objects.box, [[0, 0, 1]]);
}

{
  const terrain = [[
    { type: "empty", label: "Empty" },
    { type: "floor", label: "Floor" },
    { type: "floor", label: "Floor" }
  ]];
  const playData = {
    actors: [
      { type: "player", x: 2, y: 0, removed: false, elevation: 0 },
      { type: "gem", x: 1, y: 0, removed: false, elevation: 0 }
    ],
    gameId: "maze",
    height: 1,
    levelId: "json_empty_and_hidden_names",
    terrain,
    width: 3
  };
  const context = syntheticContext(playData, { pitch: 0 });
  const visible = buildJsonObservation(context, { omniscient: false });
  const hiddenA = buildJsonObservation(context, {
    omniscient: true,
    hideNames: true,
    hideNamesSeed: "run-a"
  });
  const hiddenAAgain = buildJsonObservation(context, {
    omniscient: true,
    hideNames: true,
    hideNamesSeed: "run-a"
  });
  const hiddenB = buildJsonObservation(context, {
    omniscient: true,
    hideNames: true,
    hideNamesSeed: "run-b"
  });
  const hiddenPalette = buildJsonDisplayPalette(context, {
    omniscient: true,
    hideNames: true,
    hideNamesSeed: "run-a"
  });

  assert.deepEqual(visible.objects.empty, [[0, 0, 0]]);
  assert.deepEqual(hiddenA, hiddenAAgain);
  assert.deepEqual(hiddenA.objects.player, [[2, 0, 1]]);
  assert.deepEqual(hiddenA.objects.gem, [[1, 0, 1]]);
  assert.equal(
    Object.keys(hiddenA.objects).every((name) => ["player", "gem"].includes(name) || /^[A-Za-z]$/.test(name)),
    true
  );
  assert.notDeepEqual(Object.keys(hiddenA.objects).sort(), Object.keys(hiddenB.objects).sort());
  Object.keys(hiddenA.objects).forEach((name) => {
    assert.match(hiddenPalette[name], /^#[0-9a-f]{6}$/i, `${name} must have a trusted display color`);
  });
  assert.equal(hiddenPalette.player, "#5aa95c");
  assert.equal(hiddenPalette.gem, "#6cd7ff");
}

{
  assertMove("U", 0, { dx: 0, dy: -1 });
  assertMove("D", 0, { dx: 0, dy: 1 });
  assertMove("L", 0, { dx: -1, dy: 0 });
  assertMove("R", 0, { dx: 1, dy: 0 });

  assertMove("U", 1, { dx: -1, dy: 0 });
  assertMove("D", 1, { dx: 1, dy: 0 });
  assertMove("L", 1, { dx: 0, dy: 1 });
  assertMove("R", 1, { dx: 0, dy: -1 });

  assertMove("U", 2, { dx: 0, dy: 1 });
  assertMove("D", 2, { dx: 0, dy: -1 });
  assertMove("L", 2, { dx: 1, dy: 0 });
  assertMove("R", 2, { dx: -1, dy: 0 });

  assertMove("U", 3, { dx: 1, dy: 0 });
  assertMove("D", 3, { dx: -1, dy: 0 });
  assertMove("L", 3, { dx: 0, dy: -1 });
  assertMove("R", 3, { dx: 0, dy: 1 });
}

{
  const context = createContext();

  applyMove(context, "D");
  assert.equal(context.level.id, "level_AxB");
  assert.deepEqual(playerPosition(context), { elevation: 0, x: 6, y: 0 });
  assert.equal(undoMove(context), true);
  assert.equal(context.level.id, "level_AxA");
  assert.deepEqual(playerPosition(context), { elevation: 0, x: 6, y: 15 });
}

{
  const context = createContext();

  applyMove(context, "U");
  applyMove(context, "U");
  assert.deepEqual(playerPosition(context), { elevation: 0, x: 6, y: 13 });
  assert.equal(resetLevel(context), true);
  assert.deepEqual(playerPosition(context), { elevation: 0, x: 6, y: 15 });
  assert.equal(undoMove(context), false);
}

{
  const context = createContext();

  applyMove(context, "U");
  rotateCamera(context, "left");
  undoMove(context);
  resetLevel(context);
  assert.deepEqual(replayActionCommands(context), [
    "up",
    "rotate camera left",
    "undo",
    "reset"
  ]);
}

{
  const context = createContext();

  context.stats.startedAtMs = 1000;
  applyMove(context, "D");
  const scorecard = JSON.parse(buildScorecard(context, 61000)).scorecard;

  assert.deepEqual(scorecard.result, {
    percent: 0,
    won: false
  });
  assert.equal(scorecard.gems.collected, 0);
  assert.equal(scorecard.gems.total > 0, true);
  assert.equal(scorecard.rooms.visited, 2);
  assert.equal(scorecard.rooms.total > 0, true);
  assert.deepEqual(scorecard.rooms.ids, ["level_AxA", "level_AxB"]);
  assert.equal(typeof scorecard.tiles.visited, "number");
  assert.equal(Object.prototype.hasOwnProperty.call(scorecard.tiles, "visited_with_elevation"), false);
  assert.equal(scorecard.duration.milliseconds, 60000);
  assert.equal(scorecard.duration.seconds, 60);
  assert.deepEqual(scorecard.current_position, {
    elevation: 0,
    level_id: "level_AxB",
    x: 6,
    y: 0
  });
  assert.equal(scorecard.actions.moves.attempted, 1);
  assert.equal(scorecard.actions.moves.successful, 1);
  assert.equal(scorecard.actions.moves.blocked, 0);
  assert.equal(scorecard.actions.moves.room_transitions, 1);
  assert.equal(scorecard.actions.moves.by_direction.down.attempted, 1);
  assert.equal(scorecard.actions.moves.by_direction.down.successful, 1);

  context.options.gameWonGemCount = 1;
  assert.equal(isGameWon(context), false);
  for (let index = 0; index < 99; index += 1) {
    context.stats.collectedGemIds.add(`fake-gem-id-${index}`);
  }
  assert.equal(isGameWon(context), false);
  context.stats.collectedGemIds.add("fake-gem-id-99");
  assert.equal(isGameWon(context), true);
  const wonScorecard = JSON.parse(buildScorecard(context, 61000)).scorecard;
  assert.deepEqual(wonScorecard.result, {
    percent: 100,
    won: true
  });

  // Regression: overshooting the threshold (e.g. two gems collected by one
  // action) must still count as a win.
  context.stats.collectedGemIds.add("fake-gem-id-100");
  assert.equal(isGameWon(context), true);
  const overshotScorecard = JSON.parse(buildScorecard(context, 61000)).scorecard;
  assert.equal(overshotScorecard.result.won, true);
}

{
  const playData = {
    actors: [
      { type: "gem", x: 0, y: 0, removed: false, elevation: 0, imageUrl: null },
      { type: "player", x: 1, y: 0, removed: false, elevation: 0, imageUrl: null }
    ],
    gameId: "maze",
    height: 1,
    levelId: "gem_suppress",
    levelLabel: "Gem Suppress",
    terrain: syntheticFloor(2, 1),
    width: 2
  };
  const engine = mazeEngine.createEngine(playData);
  const baseContext = {
    engine,
    level: { id: playData.levelId },
    options: { pitch: 0, yaw: 0 },
    playData,
    state: engine.cloneState(engine.initialState)
  };

  assert.match(body(renderScreen(baseContext)), /G/);

  const collectedContext = {
    ...baseContext,
    state: engine.cloneState(engine.initialState),
    stats: {
      collectedGemIds: new Set([
        "gem_suppress:gem:0:0,0,0",
        "gem_suppress:gem:1:0,0,0"
      ])
    }
  };

  assert.doesNotMatch(body(renderScreen(collectedContext)), /G/);
  assert.deepEqual(Array.from(collectedContext.stats.collectedGemIds), [
    "gem_suppress:gem:0,0,0"
  ]);
}

{
  const playData = {
    actors: [
      { type: "gem", x: 0, y: 0, removed: false, elevation: 0, imageUrl: null },
      { type: "player", x: 1, y: 0, removed: false, elevation: 0, imageUrl: null },
      { type: "box", x: 2, y: 0, removed: false, elevation: 0, imageUrl: null }
    ],
    gameId: "maze",
    height: 1,
    levelId: "hidden_ascii_glyphs",
    terrain: syntheticFloor(3, 1),
    width: 3
  };
  const engine = mazeEngine.createEngine(playData);
  const renderHidden = (hideNamesSeed, pitch = 0) => body(renderScreen({
    engine,
    level: { id: playData.levelId },
    options: { pitch, yaw: 0, hideNames: true, hideNamesSeed },
    playData,
    state: engine.cloneState(engine.initialState)
  }));
  const hiddenA = renderHidden("ascii-run-a");
  const hiddenAAgain = renderHidden("ascii-run-a");
  const hiddenB = renderHidden("ascii-run-b");

  assert.equal(hiddenA, hiddenAAgain, "a run keeps one stable ASCII glyph map");
  assert.notEqual(hiddenA, hiddenB, "different runs receive different ASCII glyph maps");
  assert.match(hiddenA, /P/);
  assert.match(hiddenA, /G/);
  assert.doesNotMatch(hiddenA, /[pg]/, "top faces reserve uppercase P/G for player and gem");
  const hiddenPalette = asciiGlyphPalette({ hideNames: true, hideNamesSeed: "ascii-run-a" });
  Array.from(hiddenA.replaceAll("\n", "")).forEach((glyph) => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(hiddenPalette, glyph),
      `the live bitmap palette must color hidden glyph ${JSON.stringify(glyph)}`
    );
  });

  const hiddenSide = renderHidden("ascii-run-a", 4);
  assert.match(hiddenSide, /p/);
  assert.match(hiddenSide, /g/);
  assert.doesNotMatch(hiddenSide, /[PG]/, "side faces reserve lowercase p/g for player and gem");
}

{
  const terrain = syntheticFloor(3, 1);
  terrain[0][0] = { type: "hole" };
  terrain[0][1] = { type: "empty" };
  const playData = {
    actors: [],
    gameId: "maze",
    height: 1,
    levelId: "hidden_ascii_edge_hole",
    terrain,
    width: 3
  };
  const hiddenRows = bodyRows(renderScreen(syntheticContext(playData, {
    hideNames: true,
    hideNamesSeed: "edge-hole-seed",
    pitch: 0
  })));

  assert.equal(hiddenRows.length, 4);
  assert.equal(
    hiddenRows.every((row) => row.length === 12),
    true,
    "hidden ASCII keeps a hole on the board edge instead of trimming it"
  );
  assert.doesNotMatch(hiddenRows.join("\n"), / /, "every in-board space receives a glyph");
  hiddenRows.forEach((row) => {
    const holeGlyph = row[0];
    const emptyGlyph = row[4];
    const floorGlyph = row[8];
    assert.equal(row.slice(0, 4), holeGlyph.repeat(4));
    assert.equal(row.slice(4, 8), emptyGlyph.repeat(4));
    assert.equal(row.slice(8, 12), floorGlyph.repeat(4));
    assert.equal(new Set([holeGlyph, emptyGlyph, floorGlyph]).size, 3);
  });

  const sideRows = bodyRows(renderScreen(syntheticContext(playData, {
    hideNames: true,
    hideNamesSeed: "edge-hole-seed",
    pitch: 4
  })));
  assert.equal(sideRows.length, 1);
  assert.equal(sideRows[0].length, 12, "side view also keeps edge holes");
  assert.doesNotMatch(sideRows[0], / /);
}

{
  const emptyRows = () => Array.from(
    { length: 2 },
    () => Array.from({ length: 3 }, () => ({ type: "empty" }))
  );
  const renderHiddenRows = (terrain, levelId) => bodyRows(renderScreen(syntheticContext({
    actors: [],
    gameId: "maze",
    height: 4,
    levelId,
    terrain,
    width: 3
  }, {
    hideNames: true,
    hideNamesSeed: "leading-empty-seed",
    pitch: 1
  })));
  const hiddenRows = renderHiddenRows(
    [...emptyRows(), ...syntheticFloor(3, 2)],
    "hidden_ascii_leading_empty_rows"
  );

  assert.equal(hiddenRows.length, 13);
  assert.equal(hiddenRows.every((row) => row.length === 12), true);
  const emptyGlyph = hiddenRows[0][0];
  hiddenRows.slice(0, 6).forEach((row) => {
    assert.equal(row, emptyGlyph.repeat(12));
  });
  assert.notEqual(hiddenRows[6][0], emptyGlyph);

  const trailingRows = renderHiddenRows(
    [...syntheticFloor(3, 2), ...emptyRows()],
    "hidden_ascii_trailing_empty_rows"
  );
  assert.equal(trailingRows.length, 13);
  trailingRows.slice(-6).forEach((row) => {
    assert.equal(row, emptyGlyph.repeat(12));
  });

  const fullyEmptyRows = renderHiddenRows(
    [...emptyRows(), ...emptyRows()],
    "hidden_ascii_fully_empty_grid"
  );
  assert.equal(fullyEmptyRows.length, 12);
  fullyEmptyRows.forEach((row) => {
    assert.equal(row, emptyGlyph.repeat(12));
  });
}

{
  const renderRows = (yaw) => bodyRows(runTerminal([
    "--level", "level_GxE",
    "--view", "top-diagonal",
    "--yaw", String(yaw),
    "--hide-names",
    "--hide-names-seed", "1",
    "--once"
  ]));
  const rows = renderRows(0);

  assert.equal(rows.length, 50, "level_GxE keeps all 16 projected grid rows");
  assert.equal(rows.every((row) => row.length === 64), true);
  const hiddenEmptyGlyph = rows[0][0];
  rows.slice(0, 18).forEach((row) => {
    assert.equal(row, hiddenEmptyGlyph.repeat(64));
  });
  assert.equal(rows[18].slice(0, 12), hiddenEmptyGlyph.repeat(12));
  assert.equal(rows[18].slice(16), hiddenEmptyGlyph.repeat(48));
  assert.equal(new Set(Array.from(rows[18].slice(12, 16))).size, 1);
  assert.notEqual(rows[18][12], hiddenEmptyGlyph);

  [1, 2, 3].forEach((yaw) => {
    const rotatedRows = renderRows(yaw);
    assert.equal(rotatedRows.length, 50, `yaw ${yaw} keeps the full projected height`);
    assert.equal(
      rotatedRows.every((row) => row.length === 64),
      true,
      `yaw ${yaw} keeps the full projected width`
    );
  });
}

{
  const output = renderSynthetic({
    actors: [],
    gameId: "maze",
    height: 1,
    levelId: "stack_test",
    levelLabel: "Stack Test",
    terrain: [
      [
        {
          type: "ice_block",
          layers: [
            { type: "floor", elevation: 0 },
            { type: "wall", elevation: 0 },
            { type: "ice_block", elevation: 1 }
          ]
        }
      ]
    ],
    width: 1
  });

  assert.match(body(output), /K/);
  assert.match(body(output), /k/);
  assert.match(body(output), /w/);
}

{
  const row = [1, 2, 3, 4].map((variant) => ({
    type: "block_asset",
    layers: [
      {
        type: "block_asset",
        elevation: 0,
        label: `Block ${variant}`,
        modelUrl: `/assets/maze/assets_3d/b${variant}.glb`
      }
    ]
  }));
  const playData = {
    actors: [],
    gameId: "maze",
    height: 1,
    levelId: "block_variant_glyphs",
    levelLabel: "Block Variant Glyphs",
    terrain: [row],
    width: 4
  };
  const output = renderSynthetic(playData, { pitch: 0 });
  const sideOutput = renderSynthetic(playData, { pitch: 4 });

  assert.match(body(output), /!!!!@@@@####\$\$\$\$/);
  assert.match(body(sideOutput), /1111222233334444/);
}

{
  const row = ["right", "left", "up", "down"].map((direction) => ({
    type: "ice_slope",
    layers: [{ type: "ice_slope", elevation: 0, direction }]
  }));
  const playData = {
    actors: [],
    gameId: "maze",
    height: 1,
    levelId: "ice_slope_direction_glyphs",
    levelLabel: "Ice Slope Direction Glyphs",
    terrain: [row],
    width: 4
  };
  const output = renderSynthetic(playData, { pitch: 0 });
  const sideOutput = renderSynthetic(playData, { pitch: 4 });

  assert.match(body(output), /RRRR<<<<\^\^\^\^VVVV/);
  assert.match(body(sideOutput), /rrrr,,,,6666vvvv/);
}

{
  const playData = {
    actors: [
      { type: "clone", groupId: "c0", x: 0, y: 0, removed: false, elevation: 0 },
      { type: "clone", groupId: "c1", x: 1, y: 0, removed: false, elevation: 0 },
      { type: "clone", groupId: "c2", x: 2, y: 0, removed: false, elevation: 0 }
    ],
    gameId: "maze",
    height: 1,
    levelId: "clone_variant_glyphs",
    levelLabel: "Clone Variant Glyphs",
    terrain: syntheticFloor(3, 1),
    width: 3
  };
  const output = renderSynthetic(playData, { pitch: 0 });
  const sideOutput = renderSynthetic(playData, { pitch: 4 });

  assert.match(body(output), /CCCCDDDDJJJJ/);
  assert.match(body(sideOutput), /ccccddddjjjj/);
}

{
  const playData = {
    actors: [0, 1, 2, 3, 4].map((variant, x) => ({
      type: "weightless_box",
      groupId: `M${variant}`,
      x,
      y: 0,
      removed: false,
      elevation: 0
    })),
    gameId: "maze",
    height: 1,
    levelId: "weightless_box_variant_glyphs",
    levelLabel: "Weightless Box Variant Glyphs",
    terrain: syntheticFloor(5, 1),
    width: 5
  };
  const output = renderSynthetic(playData, { pitch: 0 });
  const sideOutput = renderSynthetic(playData, { pitch: 4 });

  assert.match(body(output), /UUUU0000\(\(\(\(\+\+\+\+\.\.\.\./);
  assert.match(body(sideOutput), /uuuu9999\)\)\)\)====::::/);
}

{
  const playData = {
    actors: ["right", "left", "up", "down"].map((direction, x) => ({
      type: "puncher",
      direction,
      x,
      y: 0,
      removed: false,
      elevation: 0
    })),
    gameId: "maze",
    height: 1,
    levelId: "puncher_direction_glyphs",
    levelLabel: "Puncher Direction Glyphs",
    terrain: syntheticFloor(4, 1),
    width: 4
  };
  const output = renderSynthetic(playData, { pitch: 0 });
  const sideOutput = renderSynthetic(playData, { pitch: 4 });

  assert.match(body(output), /QQQQXXXXZZZZ%%%%/);
  assert.match(body(sideOutput), /qqqqxxxxzzzz5555/);
}

{
  const playData = {
    actors: [{ type: "orange_button", x: 0, y: 0, removed: false, elevation: 0 }],
    gameId: "maze",
    height: 1,
    levelId: "orange_button_actor_glyphs",
    levelLabel: "Orange Button Actor Glyphs",
    terrain: syntheticFloor(1, 1),
    width: 1
  };
  const output = renderSynthetic(playData, { pitch: 0 });
  const topDiagonalOutput = renderSynthetic(playData, { pitch: 1 });
  const sideOutput = renderSynthetic(playData, { pitch: 4 });

  assert.equal(body(output), ["8888", "8888", "8888", "8888"].join("\n"));
  assert.equal(body(topDiagonalOutput), ["8888", "8888", "8888", "aaaa"].join("\n"));
  assert.equal(body(sideOutput), "aaaa");
}

{
  const terrain = syntheticFloor(1, 1);
  terrain[0][0] = {
    type: "wall",
    layers: [{ type: "wall", elevation: 0 }]
  };
  const playData = {
    actors: [{ type: "orange_button", x: 0, y: 0, removed: false, elevation: 1 }],
    gameId: "maze",
    height: 1,
    levelId: "orange_button_on_wall_face",
    levelLabel: "Orange Button On Wall Face",
    terrain,
    width: 1
  };
  const topDiagonalOutput = renderSynthetic(playData, { pitch: 1 });
  const sideOutput = renderSynthetic(playData, { pitch: 4 });

  assert.equal(body(topDiagonalOutput), ["8888", "8888", "8888", "wwww"].join("\n"));
  assert.equal(body(sideOutput), ["wwww", "wwww", "wwww", "wwww"].join("\n"));
}

{
  const playData = {
    actors: [
      { type: "player", x: 0, y: 0, removed: false, elevation: 0 },
      { type: "orange_button", x: 0, y: 0, removed: false, elevation: 0 }
    ],
    gameId: "maze",
    height: 1,
    levelId: "player_over_orange_button",
    levelLabel: "Player Over Orange Button",
    terrain: syntheticFloor(1, 1),
    width: 1
  };

  assert.equal(
    body(renderSynthetic(playData, { pitch: 0 })),
    ["PPPP", "PPPP", "PPPP", "PPPP"].join("\n")
  );
}

{
  const output = runTerminal(["--level", "level_AxA", "--once"]);

  assert.match(output, /maze level_AxA \| view=top-diagonal yaw=0/);
}

{
  const output = runTerminal(["--level", "cxd", "--once"]);

  assert.match(output, /maze level_CxD \| view=top-diagonal yaw=0/);
}

{
  const output = runTerminal(["--level", "level_AxA", "--view", "top", "--once"]);

  assert.match(output, /maze level_AxA \| view=top yaw=0/);
  assert.match(output, /P/);
  assert.doesNotMatch(body(output), /[a-z]/);
}

{
  const output = runTerminal(["--level", "level_AxA", "--view", "diagonal", "--once"]);

  assert.match(output, /maze level_AxA \| view=diagonal yaw=0/);
  assert.match(output, /p/);
  assert.match(body(output), /[A-Z]/);
  assert.match(body(output), /[A-Za-z] +[A-Za-z]/);
  assert.equal(/pAp|appA/.test(body(output)), false);
}

{
  const output = runTerminal(["--level", "level_AxA", "--view", "top", "--moves", "D", "--once"]);

  assert.match(output, /maze level_AxB \| view=top yaw=0/);
  assert.match(body(output), /P/);
  assert.doesNotMatch(body(output), /[a-z]/);
}

{
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "maze-terminal-replay-"));

  try {
    const output = runTerminal([
      "--level",
      "level_AxA",
      "--view",
      "top",
      "--moves",
      "U",
      "--once",
      "--record-replay",
      "--replay-out-dir",
      outDir
    ]);
    const scorecardPath = path.join(outDir, "maze_scorecard.json");
    const actionsPath = path.join(outDir, "maze_actions.txt");
    const videoPath = path.join(outDir, "maze_replay.mp4");
    const replayPath = path.join(outDir, "maze_replay.json");
    const resultsPath = path.join(outDir, "results.jsonl");

    assert.match(output, /Replay artifacts:/);
    assert.match(output, /maze_scorecard\.json/);
    assert.equal(fs.existsSync(scorecardPath), true);
    assert.equal(fs.existsSync(actionsPath), true);
    assert.equal(fs.existsSync(replayPath), true);
    assert.equal(fs.existsSync(resultsPath), true);
    assert.equal(fs.existsSync(videoPath), false);
    assert.equal(fs.readFileSync(actionsPath, "utf8"), "up\n");

    const replay = JSON.parse(fs.readFileSync(replayPath, "utf8"));
    assert.equal(replay.start_level_id, "level_AxA");
    assert.deepEqual(replay.initial, { view: "top", yaw: 0 });
    assert.equal(replay.actions[0].command, "up");

    const row = JSON.parse(fs.readFileSync(resultsPath, "utf8").trim());
    assert.equal(row.maze_actions[0].command, "up");
    assert.equal(row.maze_scorecard.rooms.starting, "level_AxA");
  } finally {
    fs.rmSync(outDir, { force: true, recursive: true });
  }
}

{
  const output = runTerminal([
    "--level",
    "level_AxA",
    "--view",
    "side",
    "--once"
  ]);
  const rows = bodyRows(output);

  assert.match(output, /maze level_AxA \| view=side yaw=0/);
  assert.match(body(output), /[a-z]/);
  assert.doesNotMatch(body(output), /[A-Z]/);
  assert.match(body(output), /[a-z] +[a-z]/);
  assert.equal(rows.filter((row) => row.includes("p")).length, 4);
  assert.equal(rows.some((row) => row.includes("p") && row.includes("a")), false);
}

{
  const output = runTerminal(["--level", "level_AxA", "--view", "side", "--yaw", "1", "--once"]);

  assert.match(output, /maze level_AxA \| view=side yaw=1/);
  assert.doesNotMatch(body(output), /p/);
}

{
  const payload = JSON.parse(runTerminal([
    "--level",
    "level_HxI",
    "--view",
    "diagonal",
    "--json",
    "--solve"
  ]));

  assert.equal(payload.observation_mode, "json");
  assert.equal(payload.current_room, "level_HxI");
  assert.equal(payload.current_view, "diagonal");
  assert.equal(payload.json_observation.hide_names, false);
  assert.equal(payload.json_observation.omniscient, false);
  assert.equal(payload.json_observation.objects.player.length > 0, true);
  assert.equal(typeof payload.solution.status, "string");
  assert.equal(typeof payload.solution.path, "string");
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "observation"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "screen"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "level"), false);
}

{
  const payload = JSON.parse(runTerminal([
    "--level",
    "level_HxI",
    "--view",
    "diagonal",
    "--moves",
    "U",
    "--json"
  ]));

  assert.equal(payload.observation_mode, "json");
  assert.equal(payload.current_room, "level_HxI");
  assert.equal(payload.current_view, "diagonal");
  assert.equal(payload.json_observation.observation_mode, "json");
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "inputMoves"), false);
}

{
  const initial = JSON.parse(runTerminal([
    "--level", "CxD",
    "--json",
    "--omniscient"
  ]));
  const movedLeft = JSON.parse(runTerminal([
    "--level", "CxD",
    "--moves", "L",
    "--json",
    "--omniscient"
  ]));

  assert.equal(
    initial.json_observation.objects.floor.every(([, , elevation]) => elevation === 0),
    true
  );
  assert.deepEqual(initial.json_observation.objects.player, [[7, 11, 1]]);
  assert.equal(
    initial.json_observation.objects.wall.some(([, , elevation]) => elevation === 1),
    true
  );
  assert.equal(
    initial.json_observation.objects.player_gate.some(
      ([x, y, elevation]) => x === 5 && y === 11 && elevation === 0
    ),
    true
  );
  assert.equal(
    movedLeft.json_observation.objects.player_gate.some(
      ([x, y, elevation]) => x === 5 && y === 11 && elevation === 1
    ),
    true
  );
}

{
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "maze-terminal-model-json-"));
  const stateFile = path.join(outDir, "session.json");

  try {
    const terminalOutput = runTerminal([
      "--level", "CxD",
      "--view", "top-diagonal",
      "--json",
      "--omniscient"
    ]);
    const terminalPayload = JSON.parse(terminalOutput);
    const modelPayload = runCodexPlay([
      "start",
      "--repo-root", ROOT_DIR,
      "--state", stateFile,
      "--level", "CxD",
      "--view", "top-diagonal",
      "--json-observation",
      "--omniscient"
    ]);

    assert.deepEqual(terminalPayload, modelPayload);
    assert.equal(terminalPayload.json_observation.hide_names, false);
    assert.equal(terminalPayload.json_observation.omniscient, true);
    assert.equal(terminalPayload.json_observation.objects.wall.length > 0, true);
    assert.equal(Object.prototype.hasOwnProperty.call(terminalPayload, "level"), false);
    assert.match(terminalOutput, /^      "wall": \[\[.*\]\],?$/m);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

{
  const [initial, moved, rotated, undone, reset, jumped, closed] = runBridge(
    [
      { command: "observe" },
      { command: "move", direction: "up" },
      { command: "rotate_camera", direction: "left" },
      { command: "undo" },
      { command: "reset_level" },
      { command: "goto_level", x: "H", y: "I" },
      { command: "close" }
    ],
    ["--level", "level_HxI", "--view", "diagonal"]
  );

  assert.equal(initial.action, "observe");
  assert.equal(initial.action_count, 0);
  assert.equal(initial.board_state_hash_version, BOARD_STATE_HASH_VERSION);
  assert.equal(initial.current_room, "level_HxI");
  assert.equal(initial.current_view, "diagonal");
  assert.equal(initial.gem_count, 0);
  assert.deepEqual(initial.visited_levels, ["level_HxI"]);
  assert.match(initial.level, /P|p/);
  assert.equal(Object.prototype.hasOwnProperty.call(initial, "observation"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(initial, "current_level"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(initial, "view"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(initial, "header"), false);

  assert.equal(moved.action, "move");
  assert.equal(moved.action_count, 1);
  assert.equal(moved.direction, "up");
  assert.equal(moved.moved, true);
  assert.equal(moved.player.y, initial.player.y - 1);

  assert.equal(rotated.action, "rotate_camera");
  assert.equal(rotated.action_count, 2);
  assert.equal(rotated.yaw, 3);

  assert.equal(undone.action, "undo");
  assert.equal(undone.action_count, 3);
  assert.equal(undone.undone, true);
  assert.equal(undone.player.y, initial.player.y);

  assert.equal(reset.action, "reset_level");
  assert.equal(reset.action_count, 4);
  assert.equal(reset.reset, true);
  assert.equal(reset.player.y, initial.player.y);

  assert.equal(jumped.action, "goto_level");
  assert.equal(jumped.action_count, 5);
  assert.equal(jumped.current_room, "level_HxI");
  assert.equal(jumped.destination_room, "level_HxI");
  assert.equal(jumped.x, "H");
  assert.equal(jumped.y, "I");

  assert.equal(closed.action, "close");
  assert.equal(closed.ok, true);
}

{
  const [initial, rotated] = runBridge(
    [
      { command: "observe" },
      { command: "rotate_camera", direction: "right" },
      { command: "close" }
    ],
    [
      "--level", "level_HxI",
      "--view", "top-diagonal",
      "--observation-mode", "json",
      "--omniscient",
      "--hide-names",
      "--hide-names-seed", "bridge-run"
    ]
  );

  assert.equal(initial.json_observation.observation_mode, "json");
  assert.equal(initial.json_observation.omniscient, true);
  assert.equal(initial.json_observation.hide_names, true);
  assert.equal(initial.json_observation.objects.player.length > 0, true);
  assert.equal(Object.prototype.hasOwnProperty.call(initial, "level"), true);
  assert.equal(rotated.json_observation.camera.yaw, 1);
  assert.equal(rotated.json_observation.objects.player.length > 0, true);
  assert.equal(
    Object.keys(rotated.json_observation.objects).every(
      (name) => ["player", "gem"].includes(name) || /^[A-Za-z]+$/.test(name)
    ),
    true
  );
}

{
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "maze-json-helper-"));
  const stateFile = path.join(outDir, "session.json");

  try {
    const initial = runCodexPlay([
      "start",
      "--repo-root", ROOT_DIR,
      "--state", stateFile,
      "--level", "level_HxI",
      "--json-observation",
      "--omniscient",
      "--hide-names",
      "--hide-names-seed", "user-selected-seed"
    ]);
    const observed = runCodexPlay(["observe", "--state", stateFile]);
    const session = JSON.parse(fs.readFileSync(stateFile, "utf8"));

    assert.equal(initial.observation_mode, "json");
    assert.equal(Object.prototype.hasOwnProperty.call(initial, "level"), false);
    assert.equal(initial.json_observation.omniscient, true);
    assert.equal(initial.json_observation.hide_names, true);
    assert.equal(Object.prototype.hasOwnProperty.call(initial, "player"), false);
    assert.equal(initial.json_observation.objects.player.length > 0, true);
    assert.equal(Object.prototype.hasOwnProperty.call(initial, "scorecard"), false);
    assert.deepEqual(initial.json_observation.objects, observed.json_observation.objects);
    assert.equal(session.hideNamesSeed, "user-selected-seed");
    assert.equal(Object.prototype.hasOwnProperty.call(session.initial, "level"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(session.initial, "json_observation"), true);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

{
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "maze-unlimited-budget-"));
  const stateFile = path.join(outDir, "session.json");

  try {
    runCodexPlay([
      "start",
      "--repo-root", ROOT_DIR,
      "--state", stateFile,
      "--level", "level_HxI",
      "--max-actions", "unlimited",
      "--no-quit"
    ]);
    const session = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(session.maxActions, null);
    session.actions = Array.from({ length: 100 }, (_, index) => ({
      turn: index + 1,
      replay: false,
      status: {}
    }));
    fs.writeFileSync(stateFile, `${JSON.stringify(session, null, 2)}\n`);
    runCodexPlayRaw(["action", "--state", stateFile, "up"]);
    const continued = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(continued.actions.length, 101, "unlimited helper sessions must permit action 101");
    assert.equal(continued.maxActions, null);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

{
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "maze-no-response-action-"));
  const stateFile = path.join(outDir, "session.json");

  try {
    runCodexPlay([
      "start",
      "--repo-root", ROOT_DIR,
      "--state", stateFile,
      "--level", "level_HxI",
      "--max-actions", "2",
      "--no-quit"
    ]);
    const initial = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(recordNoMoveIfIdle({ sessionFile: stateFile }, 0), true);
    assert.equal(recordNoMoveIfIdle({ sessionFile: stateFile }, 0), false);

    const session = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(session.actions.length, 1);
    assert.equal(session.actions[0].command_text, "no move");
    assert.deepEqual(session.actions[0].message, { command: "no_move" });
    assert.equal(session.actions[0].synthetic, true);
    assert.equal(session.actions[0].source, "model_no_response");
    assert.equal(session.actions[0].status.moved, false);
    assert.equal(session.actions[0].status.board_state_hash, initial.initial.board_state_hash);
    assert.deepEqual(
      evaluateAutoQuit(initial.initial.board_state_hash, session.actions, {
        enabled: true,
        mode: "rolling",
        threshold: 10,
        window: 1
      }),
      {
        mode: "rolling",
        threshold: 10,
        window: 1,
        percentage: 0,
        novel_states: 0,
        observed_states: 1,
        action_count: 1
      }
    );

    const finalized = execFileSync(
      process.execPath,
      [codexPlayScript, "finalize", "--state", stateFile],
      {
        cwd: ROOT_DIR,
        encoding: "utf8",
        env: { ...process.env, MAZEBENCH_TRUSTED_FINALIZE: "1" }
      }
    );
    assert.deepEqual(JSON.parse(finalized), { ok: true, finalized: true });
    const scorecard = JSON.parse(fs.readFileSync(path.join(outDir, "scorecard.json"), "utf8"));
    assert.equal(scorecard.actions.no_move, 1);
    assert.equal(scorecard.actions.total, 1);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

{
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "maze-no-quit-budget-"));
  const stateFile = path.join(outDir, "session.json");

  try {
    runCodexPlay([
      "start",
      "--repo-root", ROOT_DIR,
      "--state", stateFile,
      "--level", "level_HxI",
      "--max-actions", "2",
      "--no-quit"
    ]);
    const blockedScorecard = runCodexPlayFailure(["scorecard", "--state", stateFile]);
    assert.notEqual(blockedScorecard.status, 0);
    assert.match(blockedScorecard.stderr, /Scorecards are evaluator-only/);

    runCodexPlayRaw(["action", "--state", stateFile, "up"]);
    runCodexPlayRaw(["action", "--state", stateFile, "up"]);
    const stillBlocked = runCodexPlayFailure(["scorecard", "--state", stateFile]);
    assert.notEqual(stillBlocked.status, 0);
    assert.match(stillBlocked.stderr, /Scorecards are evaluator-only/);
    const finalized = execFileSync(
      process.execPath,
      [codexPlayScript, "finalize", "--state", stateFile],
      {
        cwd: ROOT_DIR,
        encoding: "utf8",
        env: { ...process.env, MAZEBENCH_TRUSTED_FINALIZE: "1" }
      }
    );
    assert.deepEqual(JSON.parse(finalized), { ok: true, finalized: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, "scorecard.json"), "utf8")).actions.total, 2);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

{
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "maze-vision-scorecard-"));
  const stateFile = path.join(outDir, "session.json");

  try {
    runCodexPlay([
      "start",
      "--repo-root", ROOT_DIR,
      "--state", stateFile,
      "--level", "level_HxI"
    ]);
    const session = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    session.vision = true;
    session.observationMode = "vision";
    fs.writeFileSync(stateFile, `${JSON.stringify(session, null, 2)}\n`);

    const blocked = runCodexPlayFailure(["scorecard", "--state", stateFile]);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /Scorecards are evaluator-only/);
    const finalized = execFileSync(
      process.execPath,
      [codexPlayScript, "finalize", "--state", stateFile],
      {
        cwd: ROOT_DIR,
        encoding: "utf8",
        env: { ...process.env, MAZEBENCH_TRUSTED_FINALIZE: "1" }
      }
    );
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.deepEqual(JSON.parse(finalized), { ok: true, finalized: true });
    assert.equal(Object.prototype.hasOwnProperty.call(saved.lastStatus, "level"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(saved.lastStatus, "player"), false);
    assert.equal(saved.scorecard.actions.total, 0);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

{
  // Regression: entering a room moves the player to the end of the runtime
  // actor array. Gem identity must survive that reorder and a later goto-level
  // reconstruction, or the same physical gem respawns and increments twice.
  const routeToGem = [
    "down",
    "right",
    "right",
    "right",
    "right",
    "down",
    "left",
    "down",
    "right",
    "down",
    "left",
    "up",
    "right",
    "down",
    "left",
    "up",
    "right",
    "down",
    "left",
    "down",
    "left",
    "up",
    "right",
    "down",
    "right",
    "up",
    "left",
    "up",
    "right",
    "down",
    "left",
    "down",
    "left",
    "up"
  ];
  const move = (direction) => ({ command: "move", direction });
  const enterFromNorth = ["up", "up", "down", "down"].map(move);
  const firstRoute = routeToGem.map(move);
  const secondRoute = routeToGem.map(move);
  const commands = [
    ...enterFromNorth,
    ...firstRoute,
    { command: "goto_level", x: "I", y: "I" },
    ...secondRoute,
    { command: "close" }
  ];
  const responses = runBridge(commands, ["--level", "level_IxI", "--view", "top"]);
  const firstPickupIndex = enterFromNorth.length + firstRoute.length - 1;
  const gotoIndex = firstPickupIndex + 1;
  const revisitIndex = gotoIndex + secondRoute.length;
  const firstPickup = responses[firstPickupIndex];
  const jumpedBack = responses[gotoIndex];
  const revisitedGemTile = responses[revisitIndex];

  assert.equal(firstPickup.gem_count, 1);
  assert.deepEqual(firstPickup.collected_this_action, ["level_IxI:gem:1,13,0"]);
  assert.doesNotMatch(firstPickup.level, /G/);

  assert.equal(jumpedBack.action, "goto_level");
  assert.equal(jumpedBack.current_room, "level_IxI");
  assert.equal(jumpedBack.gem_count, 1);
  assert.deepEqual(jumpedBack.collected_gems, ["level_IxI:gem:1,13,0"]);
  assert.doesNotMatch(jumpedBack.level, /G/);

  assert.equal(revisitedGemTile.player.x, 1);
  assert.equal(revisitedGemTile.player.y, 13);
  assert.equal(revisitedGemTile.gem_count, 1);
  assert.deepEqual(revisitedGemTile.collected_this_action, []);
  assert.deepEqual(revisitedGemTile.collected_gems, ["level_IxI:gem:1,13,0"]);
  assert.doesNotMatch(revisitedGemTile.level, /G/);
}

{
  const [firstMove, secondMove, thirdMove, collectedOne] = runBridge(
    [
      { command: "move", direction: "up" },
      { command: "move", direction: "right" },
      { command: "move", direction: "right" },
      { command: "move", direction: "left" }
    ],
    ["--level", "level_HxC", "--view", "top", "--game-won-gem-count", "1"]
  );

  assert.equal(firstMove.game_won, undefined);
  assert.equal(secondMove.game_won, undefined);
  assert.equal(thirdMove.game_won, undefined);
  assert.equal(collectedOne.gem_count, 1);
  assert.equal(collectedOne.game_won, undefined);
  assert.equal(collectedOne.scorecard, undefined);
  assert.equal(collectedOne.current_room, "level_IxC");
  for (const response of [firstMove, secondMove, thirdMove, collectedOne]) {
    assert.equal(Object.prototype.hasOwnProperty.call(response, "solved"), false);
  }
}

{
  const [
    initial,
    changedRoom,
    jumpedBack,
    rejectedJump,
    closed
  ] = runBridge(
    [
      { command: "observe" },
      { command: "move", direction: "down" },
      { command: "goto_level", x: "A", y: "A" },
      { command: "goto_level", x: "B", y: "B" },
      { command: "close" }
    ],
    ["--level", "level_AxA", "--view", "top"]
  );

  assert.equal(initial.current_room, "level_AxA");
  assert.deepEqual(initial.visited_levels, ["level_AxA"]);

  assert.equal(changedRoom.action, "move");
  assert.equal(changedRoom.current_room, "level_AxB");
  assert.equal(changedRoom.room_changed, true);
  assert.deepEqual(changedRoom.visited_levels, ["level_AxA", "level_AxB"]);

  assert.equal(jumpedBack.action, "goto_level");
  assert.equal(jumpedBack.current_room, "level_AxA");
  assert.equal(jumpedBack.destination_room, "level_AxA");
  assert.deepEqual(jumpedBack.visited_levels, ["level_AxA", "level_AxB"]);

  assert.equal(rejectedJump.ok, false);
  assert.match(rejectedJump.error, /cannot goto unvisited level: level_BxB/);

  assert.equal(closed.action, "close");
  assert.equal(closed.ok, true);
}

{
  const checkpoint = {
    version: 1,
    turn: 3065,
    level_id: "level_LxD",
    pitch: 0,
    yaw: 0,
    player: { type: "player", x: 4, y: 15, elevation: 0 },
    visited_levels: ["level_HxI", "level_MxE", "level_LxD"],
    collected_gems: ["level_HxH:gem:1,3,0"],
    action_count: 3065,
    push_count: 17,
    novel_push_count: 9,
    terrain_overrides: [{ index: 133, raised: false }],
    extra_action_counts: { goto_level: 2, quit: 0 },
    stats: {
      action_counts: { move: 3000, rotate_camera: 40, undo: 20, reset: 3 },
      move_attempts: { D: 700, L: 750, R: 760, U: 790 },
      move_successes: { D: 680, L: 730, R: 740, U: 770 },
      successful_moves: 2920,
      blocked_moves: 80,
      room_transitions: 30,
      pitch_rotations: { up: 20, down: 20 },
      yaw_rotations: { left: 0, right: 0 },
      elevation_changes: 4,
      elevation_gain: 2,
      elevation_loss: 2,
      min_elevation: 0,
      max_elevation: 1,
      starting_level_id: "level_HxI",
      unique_tile_count: 900,
      unique_elevation_tile_count: 905
    }
  };
  const [restored, jumped, moved, closed] = runBridge(
    [
      { command: "restore_checkpoint", checkpoint },
      { command: "goto_level", x: "M", y: "E" },
      { command: "move", direction: "up" },
      { command: "close" }
    ],
    ["--level", "level_HxI", "--view", "top-diagonal"]
  );

  assert.equal(restored.action, "restore_checkpoint");
  assert.equal(restored.action_count, 3065);
  assert.equal(restored.current_room, "level_LxD");
  assert.equal(restored.current_view, "top");
  assert.deepEqual(restored.player, checkpoint.player);
  assert.deepEqual(restored.visited_levels, checkpoint.visited_levels);
  assert.equal(restored.gem_count, 1);
  assert.match(restored.level, /LLLL/);
  assert.match(restored.level, />{4}/);
  assert.equal(jumped.action, "goto_level");
  assert.equal(jumped.current_room, "level_MxE");
  assert.equal(jumped.action_count, 3066);
  assert.equal(moved.action_count, 3067);
  assert.equal(closed.ok, true);

  const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-checkpoint-test-"));
  const checkpointState = path.join(checkpointDir, "session.json");
  fs.writeFileSync(checkpointState, `${JSON.stringify({
    actions: [{
      turn: 1,
      message: { command: "goto_level", x: "Z", y: "Z" },
      status: { current_room: "level_ZxZ" }
    }],
    allowQuit: false,
    bridgeCheckpoint: { ...checkpoint, expected_level: restored.level },
    gameId: "maze",
    gameWonGemCount: 100,
    levelId: "level_HxI",
    nodeBin: process.execPath,
    observationMode: "text",
    omniscient: false,
    hideNames: false,
    repoRoot: ROOT_DIR,
    view: "top-diagonal",
    vision: false,
    yaw: 0
  }, null, 2)}\n`);
  const observed = runCodexPlay(["observe", "--state", checkpointState]);
  assert.equal(observed.current_room, "level_LxD");
  assert.equal(Object.prototype.hasOwnProperty.call(observed, "action_count"), false);
  assert.deepEqual(observed.visited_levels, checkpoint.visited_levels);
  fs.rmSync(checkpointDir, { recursive: true, force: true });
}

{
  const output = runModelRepl("", [
    "--level",
    "level_HxI",
    "--view",
    "top-diagonal",
    "--target-gems",
    "1",
    "--prompt-only"
  ]);

  assert.match(output, /=== MODEL-FACING MESSAGES ===/);
  assert.match(output, /--- SYSTEM ---/);
  assert.match(output, /--- USER ---/);
  assert.match(output, /Objective: Collect at least 1 unique gem\./);
  assert.doesNotMatch(output, /\$notice_text/);
  assert.match(output, /Current room: level_HxI/);
  assert.match(output, /Current view: top-diagonal/);
  assert.match(output, /Gems collected: 0/);
  assert.match(output, /Visited rooms: level_HxI/);
  assert.doesNotMatch(output, /Player:/);
  assert.match(output, /Player dead: false/);
  assert.match(output, /- up/);
  assert.match(output, /- rotate camera left/);
  assert.match(output, /- reset/);
  assert.match(output, /- go to level X Y/);
  assert.match(output, /- quit/);
  assert.match(output, /Typing quit ends the run as a loss\./);
  assert.match(output, /=== LOCAL ACTION CHEAT SHEET ===/);
  assert.match(output, /up \/ down \/ left \/ right\n  description:/);
  assert.match(output, /go to level X Y\n  description:/);
  assert.doesNotMatch(output, /observe\n  description:/);
}

{
  const output = runModelRepl(
    [
      "up",
      "rotate camera left",
      "undo",
      "reset",
      "go to level A A",
      "quit"
    ].join("\n"),
    ["--level", "level_AxA", "--view", "top"]
  );

  assert.match(output, /=== ASSISTANT RESPONSE ===\nup/);
  assert.match(output, /=== ASSISTANT RESPONSE ===\nrotate camera left/);
  assert.match(output, /=== ASSISTANT RESPONSE ===\nundo/);
  assert.match(output, /=== ASSISTANT RESPONSE ===\nreset/);
  assert.match(output, /=== ASSISTANT RESPONSE ===\ngo to level A A/);
  assert.match(output, /=== ASSISTANT RESPONSE ===\nquit/);
  assert.match(output, /=== ENV RESPONSE \(USER\) ===/);
  assert.match(output, /The game has ended\. No further action is available\./);
  assert.doesNotMatch(output, /Previous action:/);
  assert.doesNotMatch(output, /Final scorecard:/);
  assert.doesNotMatch(output, /"result":/);
  assert.doesNotMatch(output, /"gems":/);
  assert.doesNotMatch(output, /=== NEXT MODEL TURN ===/);
  assert.match(output, /Current room: level_AxA/);
  assert.match(output, /Current view: top/);
  assert.doesNotMatch(output, /"observation":/);
  assert.doesNotMatch(output, /"current_level":/);
  assert.doesNotMatch(output, /"view":/);
  assert.doesNotMatch(output, /"header":/);
}

console.log("maze terminal tests passed");
