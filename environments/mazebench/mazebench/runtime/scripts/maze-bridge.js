#!/usr/bin/env node

const readline = require("node:readline");

const {
  applyMove,
  BOARD_STATE_HASH_VERSION,
  boardStateHash,
  buildAsciiLegend,
  buildJsonDisplayPalette,
  buildJsonObservation,
  buildScorecard,
  createTerminalContext,
  GAME_WON_GEM_COUNT,
  loadMazeEngine,
  normalizeGameWonGemCount,
  renderScreen,
  resetLevel,
  undoMove
} = require("./maze-terminal");

const VIEW_NAMES = ["top", "top-diagonal", "diagonal", "side-diagonal", "side"];
const DIRECTION_TO_MOVE = {
  down: "D",
  left: "L",
  right: "R",
  up: "U"
};
const LEVEL_PATTERN = /^(?:level_)?([A-Z])x([A-Z])$/;
const COORDINATE_PATTERN = /^[A-Z]$/i;
const PUSHABLE_ACTOR_TYPES = new Set(["box", "floating_floor", "weightless_box"]);

function normalizeLevelId(value) {
  const raw = String(value || "level_HxI").trim();
  const match = raw.match(LEVEL_PATTERN);
  return match ? `level_${match[1]}x${match[2]}` : raw;
}

function normalizeCoordinate(value, name) {
  const raw = String(value || "").trim();

  if (!COORDINATE_PATTERN.test(raw)) {
    throw new Error(`${name} must be a single world coordinate letter`);
  }

  return raw.toUpperCase();
}

function levelIdFromCoordinates(x, y) {
  return `level_${normalizeCoordinate(x, "x")}x${normalizeCoordinate(y, "y")}`;
}

function gotoLevelFromMessage(message) {
  if (message.x !== undefined || message.y !== undefined) {
    return levelIdFromCoordinates(message.x, message.y);
  }

  if (message.level !== undefined) {
    return normalizeLevelId(message.level);
  }

  throw new Error("goto_level requires x and y coordinate parameters");
}

function normalizeYaw(value) {
  const number = Number(value);
  const integerValue = Number.isInteger(number) ? number : 0;
  return ((integerValue % 4) + 4) % 4;
}

function clampPitch(value) {
  const number = Number(value);
  return Math.max(0, Math.min(4, Number.isInteger(number) ? number : 1));
}

function pitchFromView(value) {
  const index = VIEW_NAMES.indexOf(String(value || "").toLowerCase());
  return index === -1 ? 1 : index;
}

function parseArgs(argv) {
  const options = {
    gameId: "maze",
    gameWonGemCount: GAME_WON_GEM_COUNT,
    levelId: "level_HxI",
    observationMode: "text",
    omniscient: false,
    hideNames: false,
    hideNamesSeed: "1",
    pitch: 1,
    yaw: 0
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] || "";

    if (arg === "--game") {
      options.gameId = next();
    } else if (arg === "--level") {
      options.levelId = normalizeLevelId(next());
    } else if (arg === "--game-won-gem-count" || arg === "--game-won-gems") {
      options.gameWonGemCount = normalizeGameWonGemCount(next());
    } else if (arg === "--view") {
      options.pitch = pitchFromView(next());
    } else if (arg === "--pitch") {
      options.pitch = clampPitch(Number(next()));
    } else if (arg === "--yaw") {
      options.yaw = normalizeYaw(Number(next()));
    } else if (arg === "--observation-mode") {
      options.observationMode = next() === "json" ? "json" : "text";
    } else if (arg === "--omniscient") {
      options.omniscient = true;
    } else if (arg === "--hide-names") {
      options.hideNames = true;
    } else if (arg === "--hide-names-seed") {
      options.hideNamesSeed = next() || "1";
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`Usage: node scripts/maze-bridge.js [options]

Options:
  --level <id>       Maze world level id, for example level_HxI.
  --game-won-gem-count <n>
                     Legacy input; game_won is fixed at 100 unique gems.
  --view <name>      top, top-diagonal, diagonal, side-diagonal, or side.
  --pitch <0-4>      Camera pitch; 0 is top-down, 4 is side.
  --yaw <0-3>        Camera yaw rotation.
  --observation-mode <text|json>
                     Choose the model-facing board representation.
  --omniscient       Include every room object in JSON observations.
  --hide-names       Randomize ASCII glyphs or JSON names except player/gem.
  --hide-names-seed <value>
                     Stable per-run seed for hidden glyphs or names.

Commands are JSON lines on stdin:
  {"command":"observe"}
  {"command":"move","direction":"up"}
  {"command":"rotate_camera","direction":"left"}
  {"command":"undo"}
  {"command":"reset_level"}
  {"command":"goto_level","x":"H","y":"I"}
  {"command":"scorecard"}
  {"command":"quit"}
  {"command":"close"}
`);
      process.exit(0);
    }
  }

  return options;
}

function isPlayerActorType(type) {
  return type === "player" || type === "circle_player";
}

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
const DEAD_INTERNAL_COMMANDS = new Set([
  "close",
  "goto_level",
  "observe",
  "restore_checkpoint",
  "reset_level",
  "scorecard",
  "undo"
]);

const LEGACY_GEM_ID_PATTERN = /^(.*):gem:(?:-?\d+:)?(-?\d+),(-?\d+),(-?\d+)$/;

function normalizeGemCollectionId(value) {
  const id = String(value || "");
  const match = id.match(LEGACY_GEM_ID_PATTERN);
  return match ? `${match[1]}:gem:${match[2]},${match[3]},${match[4]}` : id;
}

function normalizeCollectedGemIds(ids) {
  if (!(ids instanceof Set) || ids.size === 0) {
    return ids;
  }

  const normalized = Array.from(ids, normalizeGemCollectionId);
  ids.clear();
  normalized.forEach((id) => ids.add(id));
  return ids;
}

function gemCollectionId(context, index) {
  const actor = context.playData.actors[index] || {};
  const x = actor.x ?? context.state.actorX[index] ?? 0;
  const y = actor.y ?? context.state.actorY[index] ?? 0;
  const elevation = actor.elevation ?? context.state.actorElevation[index] ?? 0;
  return `${context.level.id}:gem:${x},${y},${elevation}`;
}

function visibleGemIds(context) {
  const ids = [];

  for (let index = 0; index < context.engine.actorCount; index += 1) {
    const type = context.engine.actorTypes[index] || context.playData.actors[index]?.type || "";

    if (type === "gem" && !context.state.actorRemoved[index]) {
      ids.push(gemCollectionId(context, index));
    }
  }

  return ids;
}

function activePlayer(context) {
  for (let index = 0; index < context.engine.actorCount; index += 1) {
    const type = context.engine.actorTypes[index] || context.playData.actors[index]?.type || "";

    if (!context.state.actorRemoved[index] && isPlayerActorType(type)) {
      return {
        elevation: context.state.actorElevation[index] || 0,
        type,
        x: context.state.actorX[index],
        y: context.state.actorY[index]
      };
    }
  }

  return null;
}

function isPlayerDead(context) {
  return !activePlayer(context);
}

function allowedCommandsForContext(context) {
  return isPlayerDead(context)
    ? Array.from(DEAD_ALLOWED_COMMANDS)
    : Array.from(ALIVE_ALLOWED_COMMANDS);
}

function recordSessionVisit(session) {
  const stats = session?.context?.stats;
  const player = activePlayer(session.context);

  if (!stats || !player) {
    return;
  }

  const tileKey = `${session.context.level.id}:${player.x},${player.y}`;
  const elevationTileKey = `${tileKey},${player.elevation ?? 0}`;
  stats.uniqueTiles.add(tileKey);
  stats.uniqueElevationTiles.add(elevationTileKey);
  stats.visitedRooms.add(session.context.level.id);
  stats.minElevation =
    stats.minElevation === null ? player.elevation : Math.min(stats.minElevation, player.elevation);
  stats.maxElevation =
    stats.maxElevation === null ? player.elevation : Math.max(stats.maxElevation, player.elevation);
}

function recordCollectedGems(session, beforeIds) {
  normalizeCollectedGemIds(session.collectedGemIds);
  const before = new Set(Array.from(beforeIds || [], normalizeGemCollectionId));
  const after = new Set(visibleGemIds(session.context));
  const collected = [];

  before.forEach((id) => {
    if (!after.has(id) && !session.collectedGemIds.has(id)) {
      session.collectedGemIds.add(id);
      session.context.stats?.collectedGemIds?.add(id);
      collected.push(id);
    }
  });

  return collected;
}

function recordPushedBlocks(session, result) {
  const pushed = new Map();

  (Array.isArray(result?.moves) ? result.moves : []).forEach((move) => {
    if (
      move?.visualOnly ||
      !PUSHABLE_ACTOR_TYPES.has(String(move?.actorType || "")) ||
      (move.fromX === move.toX && move.fromY === move.toY && move.fromElevation === move.toElevation)
    ) {
      return;
    }

    pushed.set(String(move.actorIndex), move);
  });

  let novel = 0;
  pushed.forEach((move) => {
    const stateKey = [
      session.context.level.id,
      move.actorType,
      move.actorIndex,
      move.toX,
      move.toY,
      move.toElevation ?? 0
    ].join(":");
    if (!session.novelPushStates.has(stateKey)) {
      session.novelPushStates.add(stateKey);
      novel += 1;
    }
  });

  session.pushCount += pushed.size;
  return { pushes: pushed.size, novel };
}

function syncSessionStats(session) {
  const stats = session?.context?.stats;

  if (!stats) {
    return;
  }

  normalizeCollectedGemIds(session.collectedGemIds);
  normalizeCollectedGemIds(stats.collectedGemIds);
  session.collectedGemIds.forEach((id) => stats.collectedGemIds.add(id));
  normalizeCollectedGemIds(stats.collectedGemIds);
  session.visitedLevels.forEach((level) => stats.visitedRooms.add(level));
  recordSessionVisit(session);
}

function sessionScorecard(session) {
  syncSessionStats(session);
  const payload = JSON.parse(buildScorecard(session.context));
  const scorecard = payload.scorecard || {};
  const actions = scorecard.actions || {};
  const extraActions = session.extraActionCounts || {};
  actions.go_to_level = extraActions.goto_level || 0;
  actions.no_move = extraActions.no_move || 0;
  actions.quit = extraActions.quit || 0;
  actions.total = (actions.total || 0) + actions.go_to_level + actions.no_move + actions.quit;
  scorecard.actions = actions;
  scorecard.blocks = {
    pushes: session.pushCount,
    novel_positions: session.novelPushStates.size
  };
  return scorecard;
}

function applyCollectedGemsToContext(session) {
  if (!session?.context || !session.collectedGemIds?.size) {
    return;
  }

  normalizeCollectedGemIds(session.collectedGemIds);
  const { context } = session;

  for (let index = 0; index < context.engine.actorCount; index += 1) {
    const type = context.engine.actorTypes[index] || context.playData.actors[index]?.type || "";

    if (type === "gem" && session.collectedGemIds.has(gemCollectionId(context, index))) {
      context.state.actorRemoved[index] = 1;
    }
  }
}

function splitRenderedScreen(rendered) {
  const [header = "", ...rows] = String(rendered || "").split("\n");
  return {
    header,
    level: rows.join("\n")
  };
}

function terrainOverridesForRender(context) {
  const overrides = [];
  const typeNames = Object.fromEntries(
    Object.entries(context.engine.terrainTypes || {}).map(([name, value]) => [value, name])
  );
  const initialTerrain = context.engine.initialState?.terrain || [];

  for (let index = 0; index < context.state.terrain.length; index += 1) {
    const currentType = typeNames[context.state.terrain[index]] || "empty";
    const initialType = typeNames[initialTerrain[index]] || "empty";
    const raised = Boolean(context.state.liftRaised[index]);
    const initiallyRaised = Boolean(context.engine.initialState?.liftRaised?.[index]);
    if (currentType !== initialType) {
      overrides.push({ index, type: currentType, raised });
    } else if (raised !== initiallyRaised) {
      overrides.push({ index, raised });
    }
  }

  return overrides;
}

// A compact, authoritative render checkpoint. codex-play removes this private
// field before returning the observation to the model and keeps only the newest
// checkpoint on disk, so a 100k-move run does not accumulate 100k snapshots.
function renderStateSnapshot(session) {
  const context = session.context;
  const actors = (context.playData.actors || []).map((actor, index) => ({
    ...actor,
    elevation: context.state.actorElevation[index] ?? actor.elevation ?? 0,
    removed: Boolean(context.state.actorRemoved[index]),
    x: context.state.actorX[index] ?? actor.x,
    y: context.state.actorY[index] ?? actor.y
  }));

  return {
    version: 1,
    game_id: context.playData.gameId || context.game?.id || "maze",
    level_id: context.level.id,
    pitch: context.options.pitch,
    yaw: context.options.yaw,
    actors,
    terrain_overrides: terrainOverridesForRender(context)
  };
}

function sessionSnapshot(session, extra = {}) {
  const context = session.context;
  applyCollectedGemsToContext(session);
  session.visitedLevels.add(context.level.id);
  syncSessionStats(session);
  const currentView = VIEW_NAMES[context.options.pitch];
  const rendered = splitRenderedScreen(renderScreen(context));
  const gameWonGemCount = normalizeGameWonGemCount(context.options?.gameWonGemCount);
  const gameWon = session.collectedGemIds.size >= gameWonGemCount;
  const terminalExtra = { ...extra };
  const player = activePlayer(context);
  const playerDead = !player;

  if (gameWon && !terminalExtra.scorecard) {
    terminalExtra.game_won = true;
    terminalExtra.scorecard = sessionScorecard(session);
  }

  const snapshot = {
    ok: true,
    action_count: session.actionCount,
    allowed_commands: allowedCommandsForContext(context),
    board_state_hash: boardStateHash(context),
    board_state_hash_version: BOARD_STATE_HASH_VERSION,
    collected_gems: Array.from(session.collectedGemIds),
    current_room: context.level.id,
    current_view: currentView,
    death_message: playerDead ? DEATH_MESSAGE : "",
    gem_count: session.collectedGemIds.size,
    novel_push_count: session.novelPushStates.size,
    push_count: session.pushCount,
    level: rendered.level,
    ascii_legend: session.initialOptions.observationMode === "text"
      ? buildAsciiLegend(context)
      : [],
    player,
    player_dead: playerDead,
    visited_levels: Array.from(session.visitedLevels),
    yaw: context.options.yaw,
    _render_state: renderStateSnapshot(session),
    ...terminalExtra
  };

  if (session.initialOptions.observationMode === "json") {
    const observationOptions = {
      hideNames: session.initialOptions.hideNames,
      hideNamesSeed: session.initialOptions.hideNamesSeed,
      omniscient: session.initialOptions.omniscient
    };
    snapshot.json_observation = buildJsonObservation(context, observationOptions);
    snapshot.json_display_palette = buildJsonDisplayPalette(context, observationOptions);
  }

  return snapshot;
}

function createSession(options) {
  const mazeEngine = loadMazeEngine();
  const context = createTerminalContext(mazeEngine, {
    gameId: options.gameId,
    gameWonGemCount: options.gameWonGemCount,
    levelId: options.levelId,
    moves: "",
    once: true,
    hideNames: options.hideNames,
    hideNamesSeed: options.hideNamesSeed,
    pitch: options.pitch,
    yaw: options.yaw
  });
  const session = {
    actionCount: 0,
    collectedGemIds: new Set(),
    context,
    extraActionCounts: {
      goto_level: 0,
      no_move: 0,
      quit: 0
    },
    initialOptions: { ...options },
    mazeEngine,
    novelPushStates: new Set(),
    pushCount: 0,
    visitedLevels: new Set([context.level.id])
  };

  return session;
}

function resetSession(session) {
  const next = createSession(session.initialOptions);
  session.actionCount = 0;
  session.collectedGemIds = next.collectedGemIds;
  session.context = next.context;
  session.extraActionCounts = next.extraActionCounts;
  session.novelPushStates = next.novelPushStates;
  session.pushCount = next.pushCount;
  session.visitedLevels = next.visitedLevels;
}

function finiteInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}

function countedSet(prefix, count) {
  return new Set(
    Array.from({ length: Math.max(0, finiteInteger(count)) }, (_, index) => `${prefix}${index}`)
  );
}

function restoreCheckpointStats(session, checkpoint) {
  const stats = session.context.stats;
  const saved = checkpoint?.stats || {};
  const actionCounts = saved.action_counts || {};

  stats.actionCounts.move = Math.max(0, finiteInteger(actionCounts.move));
  stats.actionCounts.rotateCamera = Math.max(0, finiteInteger(actionCounts.rotate_camera));
  stats.actionCounts.undo = Math.max(0, finiteInteger(actionCounts.undo));
  stats.actionCounts.reset = Math.max(0, finiteInteger(actionCounts.reset));
  stats.moveAttempts = { ...stats.moveAttempts, ...(saved.move_attempts || {}) };
  stats.moveSuccesses = { ...stats.moveSuccesses, ...(saved.move_successes || {}) };
  stats.successfulMoves = Math.max(0, finiteInteger(saved.successful_moves));
  stats.blockedMoves = Math.max(0, finiteInteger(saved.blocked_moves));
  stats.roomTransitions = Math.max(0, finiteInteger(saved.room_transitions));
  stats.pitchRotations = { ...stats.pitchRotations, ...(saved.pitch_rotations || {}) };
  stats.yawRotations = { ...stats.yawRotations, ...(saved.yaw_rotations || {}) };
  stats.elevationChanges = Math.max(0, finiteInteger(saved.elevation_changes));
  stats.elevationGain = Math.max(0, Number(saved.elevation_gain) || 0);
  stats.elevationLoss = Math.max(0, Number(saved.elevation_loss) || 0);
  stats.minElevation = Number.isFinite(Number(saved.min_elevation)) ? Number(saved.min_elevation) : null;
  stats.maxElevation = Number.isFinite(Number(saved.max_elevation)) ? Number(saved.max_elevation) : null;
  stats.startingLevelId = String(saved.starting_level_id || stats.startingLevelId || checkpoint.level_id);
  stats.startedAtMs = Number.isFinite(Number(saved.started_at_ms)) ? Number(saved.started_at_ms) : Date.now();
  stats.uniqueTiles = countedSet("checkpoint-tile:", saved.unique_tile_count);
  stats.uniqueElevationTiles = countedSet("checkpoint-elevation-tile:", saved.unique_elevation_tile_count);
  stats.visitedRooms = new Set(session.visitedLevels);
  stats.collectedGemIds = new Set(session.collectedGemIds);
}

function restoreCheckpoint(session, checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object") {
    throw new Error("restore_checkpoint requires a checkpoint object");
  }

  const levelId = normalizeLevelId(checkpoint.level_id);
  const next = createSession({
    ...session.initialOptions,
    levelId,
    pitch: clampPitch(finiteInteger(checkpoint.pitch, session.context.options.pitch)),
    yaw: normalizeYaw(finiteInteger(checkpoint.yaw, session.context.options.yaw))
  });
  session.context = next.context;
  session.initialOptions = { ...next.initialOptions };
  session.actionCount = Math.max(0, finiteInteger(checkpoint.action_count, checkpoint.turn));
  session.collectedGemIds = new Set(checkpoint.collected_gems || []);
  session.visitedLevels = new Set(checkpoint.visited_levels || []);
  session.visitedLevels.add(levelId);
  session.pushCount = Math.max(0, finiteInteger(checkpoint.push_count));
  session.novelPushStates = countedSet("checkpoint-push:", checkpoint.novel_push_count);
  session.extraActionCounts = {
    goto_level: Math.max(0, finiteInteger(checkpoint.extra_action_counts?.goto_level)),
    no_move: Math.max(0, finiteInteger(checkpoint.extra_action_counts?.no_move)),
    quit: Math.max(0, finiteInteger(checkpoint.extra_action_counts?.quit))
  };

  const actors = Array.isArray(checkpoint.actors) ? checkpoint.actors : [];
  actors.forEach((actor, index) => {
    if (!actor || index >= session.context.engine.actorCount) return;
    if (Number.isFinite(Number(actor.x))) session.context.state.actorX[index] = Number(actor.x);
    if (Number.isFinite(Number(actor.y))) session.context.state.actorY[index] = Number(actor.y);
    if (Number.isFinite(Number(actor.elevation))) {
      session.context.state.actorElevation[index] = Number(actor.elevation);
    }
    if (actor.removed !== undefined) session.context.state.actorRemoved[index] = actor.removed ? 1 : 0;
  });

  if (actors.length === 0 && checkpoint.player) {
    const playerIndex = session.context.engine.actorTypes.findIndex(isPlayerActorType);
    if (playerIndex >= 0) {
      session.context.state.actorX[playerIndex] = Number(checkpoint.player.x);
      session.context.state.actorY[playerIndex] = Number(checkpoint.player.y);
      session.context.state.actorElevation[playerIndex] = Number(checkpoint.player.elevation) || 0;
      session.context.state.actorRemoved[playerIndex] = 0;
    }
  }

  (checkpoint.terrain_overrides || []).forEach((override) => {
    const index = finiteInteger(override?.index, -1);
    if (index < 0 || index >= session.context.state.terrain.length) return;
    if (override.type && session.context.engine.terrainTypes[override.type] !== undefined) {
      session.context.state.terrain[index] = session.context.engine.terrainTypes[override.type];
    }
    if (override.raised !== undefined && index < session.context.state.liftRaised.length) {
      session.context.state.liftRaised[index] = override.raised ? 1 : 0;
    }
  });

  session.context.history = [];
  session.context.entrySnapshot = {
    engine: session.context.engine,
    level: session.context.level,
    playData: session.context.playData,
    state: session.context.engine.cloneState(session.context.state)
  };
  restoreCheckpointStats(session, checkpoint);

  const snapshot = sessionSnapshot(session, { action: "restore_checkpoint" });
  if (checkpoint.expected_level !== undefined && snapshot.level !== checkpoint.expected_level) {
    throw new Error("restored checkpoint does not match its authoritative ASCII grid");
  }
  return snapshot;
}

function handleCommand(session, message) {
  const command = String(message.command || "observe");

  if (command === "restore_checkpoint") {
    return restoreCheckpoint(session, message.checkpoint);
  }

  if (command === "observe") {
    return sessionSnapshot(session, { action: "observe" });
  }

  if (command === "no_move") {
    session.extraActionCounts.no_move += 1;
    session.actionCount += 1;
    return sessionSnapshot(session, {
      action: "no_move",
      moved: false,
      synthetic: true
    });
  }

  if (isPlayerDead(session.context) && !DEAD_INTERNAL_COMMANDS.has(command)) {
    throw new Error(DEATH_MESSAGE);
  }

  if (command === "move") {
    const move = DIRECTION_TO_MOVE[String(message.direction || "").toLowerCase()];

    if (!move) {
      throw new Error("move direction must be one of: up, down, left, right");
    }

    const beforeLevel = session.context.level.id;
    const beforeGems = visibleGemIds(session.context);
    const result = applyMove(session.context, move);
    const roomChanged = beforeLevel !== session.context.level.id;
    const collected = roomChanged ? [] : recordCollectedGems(session, beforeGems);
    const pushed = recordPushedBlocks(session, result);
    session.actionCount += 1;
    session.visitedLevels.add(session.context.level.id);

    return sessionSnapshot(session, {
      action: "move",
      collected_this_action: collected,
      direction: String(message.direction).toLowerCase(),
      moved: Boolean(result === true || result?.moved),
      novel_pushes_this_action: pushed.novel,
      pushes_this_action: pushed.pushes,
      room_changed: roomChanged
    });
  }

  if (command === "rotate_camera") {
    const direction = String(message.direction || "").toLowerCase();

    if (direction === "up") {
      session.context.options.pitch = clampPitch(session.context.options.pitch - 1);
    } else if (direction === "down") {
      session.context.options.pitch = clampPitch(session.context.options.pitch + 1);
    } else if (direction === "left") {
      session.context.options.yaw = normalizeYaw(session.context.options.yaw - 1);
    } else if (direction === "right") {
      session.context.options.yaw = normalizeYaw(session.context.options.yaw + 1);
    } else {
      throw new Error("rotate_camera direction must be one of: up, down, left, right");
    }

    if (session.context.stats) {
      session.context.stats.actionCounts.rotateCamera += 1;
      if (direction === "up" || direction === "down") {
        session.context.stats.pitchRotations[direction] += 1;
      } else {
        session.context.stats.yawRotations[direction] += 1;
      }
    }

    session.actionCount += 1;
    return sessionSnapshot(session, {
      action: "rotate_camera",
      direction
    });
  }

  if (command === "undo") {
    const beforeGems = new Set(session.collectedGemIds);
    const undone = undoMove(session.context);

    // Keep gem score monotonic for the rollout: undo changes position, not achievement history.
    beforeGems.forEach((id) => session.collectedGemIds.add(id));
    session.actionCount += 1;

    return sessionSnapshot(session, {
      action: "undo",
      undone
    });
  }

  if (command === "reset_level") {
    const reset = resetLevel(session.context);
    session.actionCount += 1;

    return sessionSnapshot(session, {
      action: "reset_level",
      reset
    });
  }

  if (command === "goto_level") {
    const level = gotoLevelFromMessage(message);

    if (!session.visitedLevels.has(level)) {
      throw new Error(`cannot goto unvisited level: ${level}`);
    }

    const previousVisited = new Set(session.visitedLevels);
    const previousGems = new Set(session.collectedGemIds);
    const previousNovelPushStates = new Set(session.novelPushStates);
    const previousPushCount = session.pushCount;
    const previousStats = session.context.stats;
    const next = createSession({
      ...session.initialOptions,
      levelId: level,
      pitch: session.context.options.pitch,
      yaw: session.context.options.yaw
    });

    session.context = next.context;
    session.context.stats = previousStats || session.context.stats;
    previousVisited.forEach((visited) => session.visitedLevels.add(visited));
    previousGems.forEach((gemId) => session.collectedGemIds.add(gemId));
    session.novelPushStates = previousNovelPushStates;
    session.pushCount = previousPushCount;
    session.extraActionCounts.goto_level += 1;
    session.actionCount += 1;

    return sessionSnapshot(session, {
      action: "goto_level",
      destination_room: level,
      x: level.match(LEVEL_PATTERN)?.[1] || null,
      y: level.match(LEVEL_PATTERN)?.[2] || null
    });
  }

  if (command === "reset_run") {
    resetSession(session);
    return sessionSnapshot(session, { action: "reset_run" });
  }

  if (command === "scorecard") {
    return sessionSnapshot(session, {
      action: "scorecard",
      scorecard: sessionScorecard(session)
    });
  }

  if (command === "quit") {
    session.extraActionCounts.quit += 1;
    session.actionCount += 1;
    return sessionSnapshot(session, {
      action: "quit",
      game_lost: true,
      quit: true,
      scorecard: sessionScorecard(session)
    });
  }

  if (command === "close") {
    return { ok: true, action: "close" };
  }

  throw new Error(`unknown command: ${command}`);
}

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const session = createSession(options);
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false
  });

  rl.on("line", (line) => {
    let message;

    try {
      message = JSON.parse(line);
      const response = handleCommand(session, message);
      write(response);

      if (message.command === "close") {
        process.exit(0);
      }
    } catch (error) {
      write({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    write({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
    process.exitCode = 1;
  }
}

module.exports = {
  createSession,
  handleCommand,
  parseArgs
};
