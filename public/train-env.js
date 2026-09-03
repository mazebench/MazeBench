(() => {
  const GRID = 16;
  const AUX_DIM = 8;
  const N_ACTIONS = 10;
  const MAX_ACTORS = 64;
  const WORLD_W = 16;
  const WORLD_ROOMS = WORLD_W * WORLD_W;
  const ROOM_STRIDE = GRID * GRID * 2;
  const WORLD_HEADER = WORLD_ROOMS;
  const DIR_CODE = Object.freeze({ up: 0, u: 0, down: 1, d: 1, left: 2, l: 2, right: 3, r: 3 });
  const WORLD_AXIS = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  const LEVEL_PATTERN = /^level_([A-Z])x([A-Z])$/;
  const ACTIONS = Object.freeze([
    { command: "move", direction: "up", move: "U" },
    { command: "move", direction: "down", move: "D" },
    { command: "move", direction: "left", move: "L" },
    { command: "move", direction: "right", move: "R" },
    { command: "rotate_camera", direction: "up" },
    { command: "rotate_camera", direction: "down" },
    { command: "rotate_camera", direction: "left" },
    { command: "rotate_camera", direction: "right" },
    { command: "undo" },
    { command: "reset_level" }
  ]);
  const MOVE_VECTORS = {
    U: { dx: 0, dy: -1 },
    D: { dx: 0, dy: 1 },
    L: { dx: -1, dy: 0 },
    R: { dx: 1, dy: 0 }
  };
  const ACTOR_CELL = Object.freeze({
    player: 16,
    circle_player: 16,
    gem: 17,
    box: 18,
    weightless_box: 19,
    clone: 20,
    puncher: 21,
    floating_floor: 22
  });
  const CELL_COLORS = Object.freeze([
    "#050608",
    "#d6bd94",
    "#23262c",
    "#6aa84f",
    "#8ecae6",
    "#111111",
    "#c9a227",
    "#5aa95c",
    "#e07a3d",
    "#f2c14e",
    "#355e3b",
    "#7aa2c8",
    "#3f7d20",
    "#6d6d6d",
    "#9ad0f5",
    "#f4a261",
    "#5aa95c",
    "#3ecfbe",
    "#c47a3a",
    "#315991",
    "#9b59b6",
    "#e74c3c",
    "#b8d4e3",
    "#8892a8"
  ]);
  const PUSHABLE = new Set(["box", "floating_floor", "weightless_box"]);

  function rootObject() {
    return typeof window !== "undefined" ? window : self;
  }

  function mazeEngine() {
    const engine = rootObject().MazeEngine;
    if (!engine) throw new Error("MazeEngine is not loaded");
    return engine;
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

  function parseWorldLevelId(levelId, columns = WORLD_AXIS, rows = WORLD_AXIS) {
    const match = String(levelId || "").match(LEVEL_PATTERN);
    if (!match) return null;
    const columnIndex = columns.indexOf(match[1]);
    const rowIndex = rows.indexOf(match[2]);
    if (columnIndex === -1 || rowIndex === -1) return null;
    return { columnIndex, rowIndex };
  }

  function worldLevelId(columnIndex, rowIndex, columns = WORLD_AXIS, rows = WORLD_AXIS) {
    if (columnIndex < 0 || rowIndex < 0 || columnIndex >= columns.length || rowIndex >= rows.length) {
      return null;
    }
    return `level_${columns[columnIndex]}x${rows[rowIndex]}`;
  }

  function adjacentWorldLevelId(levelId, dx, dy, columns, rows) {
    const coordinates = parseWorldLevelId(levelId, columns, rows);
    if (!coordinates) return null;
    return worldLevelId(coordinates.columnIndex + dx, coordinates.rowIndex + dy, columns, rows);
  }

  function moveVector(dx, dy) {
    return {
      dx: Object.is(dx, -0) ? 0 : dx,
      dy: Object.is(dy, -0) ? 0 : dy
    };
  }

  function screenMoveVector(move, yaw = 0) {
    const screenMove = MOVE_VECTORS[String(move || "").toUpperCase()];
    if (!screenMove) return null;
    const { dx, dy } = screenMove;
    switch (normalizeYaw(yaw)) {
      case 1:
        return moveVector(dy, -dx);
      case 2:
        return moveVector(-dx, -dy);
      case 3:
        return moveVector(-dy, dx);
      default:
        return moveVector(dx, dy);
    }
  }

  function gemId(levelId, x, y, elevation) {
    return `${levelId}:gem:${x},${y},${elevation}`;
  }

  const ROOM_BIT_WORDS = 8;

  function roomRid(coords) {
    if (!coords || coords.columnIndex < 0 || coords.rowIndex < 0) return -1;
    if (coords.columnIndex >= WORLD_W || coords.rowIndex >= WORLD_W) return -1;
    return coords.rowIndex * WORLD_W + coords.columnIndex;
  }

  function setCellBit(mask, rid, x, y) {
    if (rid < 0 || x < 0 || y < 0 || x >= GRID || y >= GRID) return;
    const idx = y * GRID + x;
    mask[rid * ROOM_BIT_WORDS + (idx >>> 5)] |= 1 << (idx & 31);
  }

  function packGemMask(collectedGemIds, columns, rows) {
    const mask = new Uint32Array(WORLD_ROOMS * ROOM_BIT_WORDS);
    collectedGemIds.forEach((id) => {
      const split = String(id).split(":gem:");
      if (split.length < 2) return;
      const xy = split[1].split(",");
      setCellBit(mask, roomRid(parseWorldLevelId(split[0], columns, rows)), Number(xy[0]), Number(xy[1]));
    });
    return mask;
  }

  function packPushMask(novelPushStates, columns, rows) {
    const mask = new Uint32Array(WORLD_ROOMS * ROOM_BIT_WORDS);
    novelPushStates.forEach((key) => {
      const parts = String(key).split(":");
      if (parts.length < 6) return;
      setCellBit(
        mask,
        roomRid(parseWorldLevelId(parts[0], columns, rows)),
        Number(parts[3]),
        Number(parts[4])
      );
    });
    return mask;
  }

  function dirCode(value) {
    const key = String(value || "").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(DIR_CODE, key)) return DIR_CODE[key];
    if (key === "0,-1") return 0;
    if (key === "0,1") return 1;
    if (key === "-1,0") return 2;
    return 3;
  }

  function terrainCellAt(playData, x, y) {
    const row = playData && Array.isArray(playData.terrain) ? playData.terrain[y] : null;
    if (!row) return null;
    if (Array.isArray(row)) return row[x] || null;
    return null;
  }

  function slopeLayerAt(playData, x, y) {
    const cell = terrainCellAt(playData, x, y);
    if (!cell || typeof cell !== "object") return null;
    if (Array.isArray(cell.layers)) {
      return cell.layers.find((item) => item && (item.type === "ice_slope" || item.type === "orange_ice_slope")) || null;
    }
    return null;
  }

  function slopeDirAt(playData, x, y) {
    const cell = terrainCellAt(playData, x, y);
    if (!cell || typeof cell !== "object") return 3;
    const layer = slopeLayerAt(playData, x, y);
    return dirCode((layer && layer.direction) || cell.direction);
  }

  function slopeElevAt(playData, x, y) {
    const layer = slopeLayerAt(playData, x, y);
    return Math.max(0, (layer && layer.elevation) || 0) & 15;
  }

  function terrainBlockMaskAt(playData, x, y) {
    const cell = terrainCellAt(playData, x, y);
    const layers = cell && Array.isArray(cell.layers) ? cell.layers : [];
    let mask = 0;
    for (let i = 0; i < layers.length; i += 1) {
      const layer = layers[i];
      if (!layer) continue;
      const e = Math.max(0, layer.elevation || 0);
      const kind = layer.type;
      if (kind === "wall" || kind === "ice_block" || kind === "block_asset") {
        if (e < 4) mask |= 1 << e;
      } else if (kind === "ice_slope") {
        if (e < 4) mask |= 1 << e;
        if (e + 1 < 4) mask |= 1 << (e + 1);
      } else if (kind === "shrub") {
        if (e < 4) mask |= 1 << e;
        if (e + 1 < 4) mask |= 1 << (e + 1);
      } else if (kind === "tree") {
        for (let k = 0; k < 3 && e + k < 4; k += 1) mask |= 1 << (e + k);
      }
    }
    return mask & 15;
  }

  function packActors(engine, state, playData) {
    const actors = new Uint32Array(MAX_ACTORS * 2);
    const groupSerial = new Map();
    let nextGroup = 1;
    let n = 0;
    let player = 0xffffffff;
    for (let actor = 0; actor < engine.actorCount && n < MAX_ACTORS; actor += 1) {
      if (state.actorRemoved[actor]) continue;
      const kind = engine.actorTypes[actor];
      const type = ACTOR_CELL[kind] || 0;
      if (!type) continue;
      const gid = String(engine.actorGroupIds[actor] || `solo-${actor}`);
      if (!groupSerial.has(gid)) groupSerial.set(gid, nextGroup++);
      const source = playData && Array.isArray(playData.actors) ? playData.actors[actor] : null;
      const dir = dirCode(source && (source.direction || source.facing));
      const x = state.actorX[actor];
      const y = state.actorY[actor];
      const elev = state.actorElevation[actor] || 0;
      actors[n * 2] = type | (groupSerial.get(gid) << 8) | (dir << 16) | (1 << 24);
      actors[n * 2 + 1] = (x & 255) | ((y & 255) << 8) | ((elev & 255) << 16);
      if (type === 16 && player === 0xffffffff) player = n;
      n += 1;
    }
    return { actors, nActors: n, playerId: player, groups: groupSerial };
  }

  function isSupportCellType(type) {
    return type === 18 || type === 19 || type === 20 || type === 22;
  }

  function packOccupancy(engine, state, playData) {
    const packedTerrain = packTerrain(engine, state, playData);
    const packed = packActors(engine, state, playData);
    const occ = new Uint32Array(GRID * GRID);
    for (let i = 0; i < GRID * GRID; i += 1) occ[i] = packedTerrain[i] & 255;
    let playerIdx = -1;
    let pe = 0;
    for (let n = 0; n < packed.nActors; n += 1) {
      const meta = packed.actors[n * 2];
      const pos = packed.actors[n * 2 + 1];
      const type = meta & 255;
      const group = (meta >> 8) & 255;
      const dir = (meta >> 16) & 255;
      const x = pos & 255;
      const y = (pos >> 8) & 255;
      const elev = (pos >> 16) & 255;
      if (x >= GRID || y >= GRID) continue;
      if (type === 16) {
        playerIdx = y * GRID + x;
        pe = elev;
        continue;
      }
      occ[y * GRID + x] = type | (group << 8) | (type === 21 ? dir << 16 : 0) | (elev << 24);
    }
    if (playerIdx >= 0) {
      const cell = occ[playerIdx];
      const type = cell & 255;
      const elev = (cell >>> 24) & 255;
      if (!((isSupportCellType(type) && elev !== pe) || type === 21)) occ[playerIdx] = 16 | (pe << 24);
    }
    let flags = 0;
    for (let i = 0; i < GRID * GRID; i += 1) {
      const t = packedTerrain[i] & 255;
      if (t === 9) flags |= 1;
      if (t === 6) flags |= 16;
      if (t === 7) flags |= 8;
      if (t === 14 || t === 15) flags |= 32;
      if (t === 4) flags |= 64;
    }
    for (let n = 0; n < packed.nActors; n += 1) {
      const kind = packed.actors[n * 2] & 255;
      if (kind === 20) flags |= 2;
      if (kind === 21) flags |= 4;
      if (kind === 22) flags |= 128;
    }
    return { occ, pe, packedTerrain, packed, flags };
  }

  function packRoomFromPlay(playData) {
    const engine = mazeEngine().createEngine(playData);
    const state = engine.cloneState(engine.initialState);
    const packed = packOccupancy(engine, state, playData);
    return {
      occ: packed.occ,
      ter: packed.packedTerrain,
      width: engine.width,
      height: engine.height,
      flags: packed.flags
    };
  }

  function packTerrain(engine, state, playData) {
    const packed = new Uint32Array(GRID * GRID);
    const width = engine.width;
    const height = engine.height;
    const terrain = state.terrain;
    const lifts = state.liftRaised;
    for (let y = 0; y < height && y < GRID; y += 1) {
      for (let x = 0; x < width && x < GRID; x += 1) {
        const type = terrain[y * width + x] || 0;
        const raised = lifts && lifts[y * width + x] ? 1 : 0;
        const dir = type === 14 || type === 15 ? slopeDirAt(playData, x, y) : 3;
        const slopeElev = type === 14 || type === 15 ? slopeElevAt(playData, x, y) : 0;
        const blockMask = terrainBlockMaskAt(playData, x, y);
        packed[y * GRID + x] =
          type | ((dir & 3) << 8) | ((slopeElev & 15) << 10) | ((raised & 1) << 16) | ((blockMask & 15) << 17);
      }
    }
    return packed;
  }

  function playerIndex(engine, state) {
    for (let index = 0; index < engine.actorCount; index += 1) {
      const type = engine.actorTypes[index];
      if ((type === "player" || type === "circle_player") && !state.actorRemoved[index]) {
        return index;
      }
    }
    return -1;
  }

  const PLAYER_CELL = 16;

  function walkManhattan(x0, y0, x1, y1) {
    const points = [];
    let x = x0;
    let y = y0;
    while (x !== x1) {
      x += x1 > x ? 1 : -1;
      points.push({ x, y });
    }
    while (y !== y1) {
      y += y1 > y ? 1 : -1;
      points.push({ x, y });
    }
    return points;
  }

  function shiftPlayerCell(grid, fromX, fromY, toX, toY) {
    const next = grid.slice ? grid.slice() : Array.from(grid);
    const from = fromY * GRID + fromX;
    const to = toY * GRID + toX;
    if (from >= 0 && from < next.length && next[from] === PLAYER_CELL) next[from] = 1;
    if (to >= 0 && to < next.length) next[to] = PLAYER_CELL;
    return next;
  }

  function playerPathFromMove(moveResult) {
    const moves = Array.isArray(moveResult?.moves) ? moveResult.moves : [];
    for (let i = 0; i < moves.length; i += 1) {
      const move = moves[i];
      if (move.actorType !== "player" && move.actorType !== "circle_player") continue;
      if (Array.isArray(move.path) && move.path.length > 1) {
        return move.path.map((point) => ({ x: point.x | 0, y: point.y | 0 }));
      }
    }
    return [];
  }

  function expandPlaybackFrames(prevGrid, prevPlayer, nextGrid, nextPlayer, options = {}) {
    if (options.roomChanged) return [{ grid: Array.from(nextGrid) }];
    let path = Array.isArray(options.path) ? options.path.slice() : [];
    if (!path.length && prevPlayer && nextPlayer && (prevPlayer.x !== nextPlayer.x || prevPlayer.y !== nextPlayer.y)) {
      path = [{ x: prevPlayer.x, y: prevPlayer.y }].concat(
        walkManhattan(prevPlayer.x, prevPlayer.y, nextPlayer.x, nextPlayer.y)
      );
    }
    if (!prevPlayer || path.length < 2) return [{ grid: Array.from(nextGrid) }];
    const frames = [];
    let x = prevPlayer.x;
    let y = prevPlayer.y;
    let grid = Array.from(prevGrid);
    for (let i = 0; i < path.length; i += 1) {
      const point = path[i];
      if (point.x === x && point.y === y) continue;
      const hops = walkManhattan(x, y, point.x, point.y);
      for (let h = 0; h < hops.length; h += 1) {
        const hop = hops[h];
        grid = shiftPlayerCell(grid, x, y, hop.x, hop.y);
        x = hop.x;
        y = hop.y;
        frames.push({ grid: Array.from(grid) });
      }
    }
    if (!frames.length) return [{ grid: Array.from(nextGrid) }];
    frames[frames.length - 1] = { grid: Array.from(nextGrid) };
    return frames;
  }

  function encodeGrid(engine, state) {
    const width = engine.width;
    const height = engine.height;
    const cells = new Uint8Array(GRID * GRID);
    const terrain = state.terrain;
    for (let y = 0; y < height && y < GRID; y += 1) {
      for (let x = 0; x < width && x < GRID; x += 1) {
        cells[y * GRID + x] = terrain[y * width + x] || 0;
      }
    }
    const delayed = [];
    for (let index = 0; index < engine.actorCount; index += 1) {
      if (state.actorRemoved[index]) continue;
      const x = state.actorX[index];
      const y = state.actorY[index];
      if (x < 0 || y < 0 || x >= GRID || y >= GRID) continue;
      const type = engine.actorTypes[index];
      const id = ACTOR_CELL[type] || 23;
      if (id === 16) delayed.push({ x, y, id });
      else cells[y * GRID + x] = id;
    }
    delayed.forEach((actor) => {
      cells[actor.y * GRID + actor.x] = actor.id;
    });
    return cells;
  }

  function encodeAux(snapshot, maxActions) {
    const aux = new Float32Array(AUX_DIM);
    aux[0] = snapshot.yaw / 3;
    aux[1] = snapshot.pitch / 4;
    aux[2] = snapshot.playerDead ? 1 : 0;
    aux[3] = Math.min(1, snapshot.gemCount / 90);
    aux[4] = Math.min(1, snapshot.visited.length / 256);
    aux[5] = Math.min(1, snapshot.actionCount / Math.max(1, maxActions));
    aux[6] = Math.min(1, snapshot.novelPushCount / 50);
    aux[7] = snapshot.moved ? 1 : 0;
    return aux;
  }

  function actionMask(playerDead) {
    if (!playerDead) return [true, true, true, true, true, true, true, true, true, true];
    return [false, false, false, false, false, false, false, false, true, true];
  }

  function cellColor(id) {
    return CELL_COLORS[id] || "#8892a8";
  }

  class MazeTrainEnv {
    constructor(options) {
      this.playCache = options.playCache || new Map();
      this.fetchPlayData = options.fetchPlayData;
      this.startLevelId = options.startLevelId || "level_HxI";
      this.maxActions = options.maxActions || 128;
      this.gemWeight = options.gemWeight ?? 1;
      this.roomWeight = options.roomWeight ?? 0.1;
      this.pushWeight = options.pushWeight ?? 0.05;
      this.noveltyBonus = options.noveltyBonus ?? 0.01;
      this.deathPenalty = options.deathPenalty ?? -0.05;
      this.worldColumns = options.worldColumns || WORLD_AXIS;
      this.worldRows = options.worldRows || WORLD_AXIS;
      this.profiler = options.profiler || null;
      this.prefetchWorld = options.prefetchWorld === true;
      this.engine = null;
      this.state = null;
      this.playData = null;
      this.levelId = this.startLevelId;
      this.yaw = 0;
      this.pitch = 1;
      this.history = [];
      this.entrySnapshot = null;
      this.visited = new Set();
      this.collectedGemIds = new Set();
      this.novelPushStates = new Set();
      this.seenHashes = new Set();
      this.actionCount = 0;
      this.episodeReward = 0;
    }

    async ensurePlayData(levelId) {
      if (this.playCache.has(levelId)) return this.playCache.get(levelId);
      if (!this.fetchPlayData) throw new Error(`Missing play data for ${levelId}`);
      const playData = await this.fetchPlayData(levelId);
      this.playCache.set(levelId, playData);
      if (playData.worldColumns) this.worldColumns = playData.worldColumns;
      if (playData.worldRows) this.worldRows = playData.worldRows;
      return playData;
    }

    span(name, fn) {
      if (!this.profiler) return fn();
      this.profiler.begin(name);
      try {
        return fn();
      } finally {
        this.profiler.end();
      }
    }

    loadRoom(playData, levelId, playerPlacement = null) {
      this.playData = playData;
      this.levelId = levelId;
      this.engine = mazeEngine().createEngine(playData);
      this.state = this.engine.cloneState(this.engine.initialState);
      if (playerPlacement) {
        const index = playerIndex(this.engine, this.state);
        if (index >= 0) {
          this.state.actorX[index] = playerPlacement.x;
          this.state.actorY[index] = playerPlacement.y;
          this.state.actorElevation[index] = playerPlacement.elevation || 0;
          this.state.actorRemoved[index] = 0;
        }
      }
      this.visited.add(levelId);
      this.applyCollectedGems();
    }

    applyCollectedGems() {
      for (let index = 0; index < this.engine.actorCount; index += 1) {
        if (this.engine.actorTypes[index] !== "gem") continue;
        const id = gemId(
          this.levelId,
          this.state.actorX[index],
          this.state.actorY[index],
          this.state.actorElevation[index] || 0
        );
        if (this.collectedGemIds.has(id)) this.state.actorRemoved[index] = 1;
      }
    }

    visibleGemIds() {
      const ids = [];
      for (let index = 0; index < this.engine.actorCount; index += 1) {
        if (this.engine.actorTypes[index] !== "gem" || this.state.actorRemoved[index]) continue;
        ids.push(
          gemId(
            this.levelId,
            this.state.actorX[index],
            this.state.actorY[index],
            this.state.actorElevation[index] || 0
          )
        );
      }
      return ids;
    }

    capture() {
      return this.span("env.capture", () => ({
        levelId: this.levelId,
        yaw: this.yaw,
        pitch: this.pitch,
        state: this.engine.cloneState(this.state),
        playData: this.playData
      }));
    }

    restore(snapshot) {
      this.playData = snapshot.playData;
      this.levelId = snapshot.levelId;
      this.yaw = snapshot.yaw;
      this.pitch = snapshot.pitch;
      this.engine = mazeEngine().createEngine(snapshot.playData);
      this.state = this.engine.cloneState(snapshot.state);
      this.applyCollectedGems();
    }

    boardHash() {
      return this.span("env.stateKey", () => {
        const key = this.engine.stateKey(this.state);
        return `${this.levelId}:${this.yaw}:${this.pitch}:${key}`;
      });
    }

    gpuCapture() {
      const grid = encodeGrid(this.engine, this.state);
      const occupancy = packOccupancy(this.engine, this.state, this.playData);
      const packedTerrain = occupancy.packedTerrain;
      const packed = occupancy.packed;
      const under = new Uint8Array(GRID * GRID);
      const groups = new Uint8Array(GRID * GRID);
      for (let i = 0; i < GRID * GRID; i += 1) {
        under[i] = packedTerrain[i] & 255;
        groups[i] = (occupancy.occ[i] >> 8) & 255;
      }
      const index = playerIndex(this.engine, this.state);
      const flags = occupancy.flags;
      const pe = index >= 0 ? this.state.actorElevation[index] || 0 : occupancy.pe;
      const coords = parseWorldLevelId(this.levelId, this.worldColumns, this.worldRows) || {
        columnIndex: 0,
        rowIndex: 0
      };
      const visited = new Uint32Array(8);
      this.visited.forEach((id) => {
        const c = parseWorldLevelId(id, this.worldColumns, this.worldRows);
        if (!c || c.columnIndex >= WORLD_W || c.rowIndex >= WORLD_W) return;
        const rid = c.rowIndex * WORLD_W + c.columnIndex;
        visited[Math.floor(rid / 32)] |= 1 << rid % 32;
      });
      const capture = {
        grid,
        occ: occupancy.occ,
        pe,
        under,
        groups,
        terrain: packedTerrain,
        actors: packed.actors,
        nActors: packed.nActors,
        playerId: packed.playerId,
        flags,
        width: this.engine.width,
        height: this.engine.height,
        px: index >= 0 ? this.state.actorX[index] : 0,
        py: index >= 0 ? this.state.actorY[index] : 0,
        yaw: this.yaw,
        pitch: this.pitch,
        dead: index < 0,
        gemCount: this.collectedGemIds.size,
        actionCount: this.actionCount,
        roomCol: coords.columnIndex,
        roomRow: coords.rowIndex,
        visited,
        worldAtlas: this.worldAtlas || null,
        gemMask: packGemMask(this.collectedGemIds, this.worldColumns, this.worldRows),
        pushMask: packPushMask(this.novelPushStates, this.worldColumns, this.worldRows)
      };
      if (!this._gpuStart) {
        this._gpuStart = {
          terrain: packedTerrain.slice(),
          actors: packed.actors.slice(),
          nActors: packed.nActors,
          playerId: packed.playerId,
          grid: Uint8Array.from(grid),
          occ: occupancy.occ.slice(),
          groups: Uint8Array.from(groups),
          px: capture.px,
          py: capture.py,
          pe,
          dead: capture.dead,
          gemCount: capture.gemCount,
          roomCol: coords.columnIndex,
          roomRow: coords.rowIndex
        };
      }
      capture.startTerrain = this._gpuStart.terrain;
      capture.startActors = this._gpuStart.actors;
      capture.startNActors = this._gpuStart.nActors;
      capture.startPlayerId = this._gpuStart.playerId;
      capture.startGrid = this._gpuStart.grid;
      capture.startOcc = this._gpuStart.occ;
      capture.startGroups = this._gpuStart.groups;
      capture.startPx = this._gpuStart.px;
      capture.startPy = this._gpuStart.py;
      capture.startPe = this._gpuStart.pe || 0;
      capture.startDead = this._gpuStart.dead;
      capture.startGemCount = this._gpuStart.gemCount;
      capture.startRoomCol = this._gpuStart.roomCol == null ? coords.columnIndex : this._gpuStart.roomCol;
      capture.startRoomRow = this._gpuStart.roomRow == null ? coords.rowIndex : this._gpuStart.roomRow;
      capture.prevTerrain = packedTerrain.slice();
      capture.prevActors = packed.actors.slice();
      return capture;
    }

    snapshot(extra = {}) {
      return this.span("env.snapshot", () => {
      const index = playerIndex(this.engine, this.state);
      const playerDead = index < 0;
      const grid = this.span("env.encodeGrid", () => encodeGrid(this.engine, this.state));
      const status = {
        yaw: this.yaw,
        pitch: this.pitch,
        playerDead,
        gemCount: this.collectedGemIds.size,
        visited: Array.from(this.visited),
        actionCount: this.actionCount,
        novelPushCount: this.novelPushStates.size,
        moved: Boolean(extra.moved)
      };
      return {
        grid,
        aux: encodeAux(status, this.maxActions),
        mask: actionMask(playerDead),
        hash: this.boardHash(),
        levelId: this.levelId,
        yaw: this.yaw,
        pitch: this.pitch,
        playerDead,
        gemCount: status.gemCount,
        rooms: this.visited.size,
        novelPushCount: status.novelPushCount,
        actionCount: this.actionCount,
        player:
          index >= 0
            ? {
                x: this.state.actorX[index],
                y: this.state.actorY[index],
                elevation: this.state.actorElevation[index] || 0
              }
            : null,
        ...extra
      };
      });
    }

    async ensureWorldAtlas() {
      if (this.worldAtlas) return this.worldAtlas;
      const header = new Uint32Array(WORLD_ROOMS);
      const rooms = new Uint32Array(WORLD_ROOMS * ROOM_STRIDE);
      const ids = new Set(this.playCache.keys());
      if (this.prefetchWorld) {
        const cols = Math.min(WORLD_W, this.worldColumns.length);
        const rows = Math.min(WORLD_W, this.worldRows.length);
        for (let row = 0; row < rows; row += 1) {
          for (let col = 0; col < cols; col += 1) {
            const id = worldLevelId(col, row, this.worldColumns, this.worldRows);
            if (id) ids.add(id);
          }
        }
      }
      for (const id of ids) {
        const coords = parseWorldLevelId(id, this.worldColumns, this.worldRows);
        if (!coords || coords.columnIndex >= WORLD_W || coords.rowIndex >= WORLD_W) continue;
        let play;
        try {
          play = await this.ensurePlayData(id);
        } catch (_error) {
          continue;
        }
        const packed = packRoomFromPlay(play);
        const rid = coords.rowIndex * WORLD_W + coords.columnIndex;
        header[rid] = (packed.width & 255) | ((packed.height & 255) << 8) | ((packed.flags & 255) << 16);
        rooms.set(packed.occ, rid * ROOM_STRIDE);
        rooms.set(packed.ter, rid * ROOM_STRIDE + GRID * GRID);
      }
      const data = new Uint32Array(WORLD_HEADER + rooms.length);
      data.set(header, 0);
      data.set(rooms, WORLD_HEADER);
      this.worldAtlas = data;
      return data;
    }

    async reset() {
      const playData = await this.ensurePlayData(this.startLevelId);
      this.yaw = 0;
      this.pitch = 1;
      this.history = [];
      this.visited = new Set();
      this.collectedGemIds = new Set();
      this.novelPushStates = new Set();
      this.seenHashes = new Set();
      this.actionCount = 0;
      this.episodeReward = 0;
      this._gpuStart = null;
      this.loadRoom(playData, this.startLevelId);
      await this.ensureWorldAtlas();
      this.entrySnapshot = this.capture();
      const snap = this.snapshot({ moved: false, action: "reset_run" });
      this.seenHashes.add(snap.hash);
      return snap;
    }

    recordPushes(result) {
      let novel = 0;
      const moves = Array.isArray(result?.moves) ? result.moves : [];
      moves.forEach((move) => {
        if (move?.visualOnly || !PUSHABLE.has(String(move?.actorType || ""))) return;
        if (move.fromX === move.toX && move.fromY === move.toY && move.fromElevation === move.toElevation) {
          return;
        }
        const key = [
          this.levelId,
          move.actorType,
          move.actorIndex,
          move.toX,
          move.toY,
          move.toElevation ?? 0
        ].join(":");
        if (!this.novelPushStates.has(key)) {
          this.novelPushStates.add(key);
          novel += 1;
        }
      });
      return novel;
    }

    collectGems(beforeIds) {
      const before = new Set(beforeIds);
      const after = new Set(this.visibleGemIds());
      let collected = 0;
      before.forEach((id) => {
        if (!after.has(id) && !this.collectedGemIds.has(id)) {
          this.collectedGemIds.add(id);
          collected += 1;
        }
      });
      return collected;
    }

    async tryEdgeTransition(dx, dy) {
      const index = playerIndex(this.engine, this.state);
      if (index < 0) return null;
      const x = this.state.actorX[index];
      const y = this.state.actorY[index];
      const width = this.engine.width;
      const height = this.engine.height;
      const onEdge =
        (dx < 0 && x === 0) ||
        (dx > 0 && x === width - 1) ||
        (dy < 0 && y === 0) ||
        (dy > 0 && y === height - 1);
      if (!onEdge) return null;
      const nextLevelId = adjacentWorldLevelId(this.levelId, dx, dy, this.worldColumns, this.worldRows);
      if (!nextLevelId) return null;
      let nextPlay;
      try {
        nextPlay = await this.ensurePlayData(nextLevelId);
      } catch (_error) {
        return null;
      }
      const elevation = this.state.actorElevation[index] || 0;
      const targetX = dx < 0 ? nextPlay.width - 1 : dx > 0 ? 0 : Math.min(x, nextPlay.width - 1);
      const targetY = dy < 0 ? nextPlay.height - 1 : dy > 0 ? 0 : Math.min(y, nextPlay.height - 1);
      this.history.push(this.capture());
      this.loadRoom(nextPlay, nextLevelId, { x: targetX, y: targetY, elevation });
      this.entrySnapshot = this.capture();
      return { moved: true, roomChanged: true };
    }

    rewardBetween(prev, next, parts) {
      const reward =
        this.gemWeight * parts.gems +
        this.roomWeight * parts.rooms +
        this.pushWeight * parts.pushes +
        this.noveltyBonus * parts.novel +
        this.deathPenalty * parts.death;
      this.episodeReward += reward;
      return reward;
    }

    async step(actionIndex) {
      if (this.profiler) this.profiler.begin("env.step");
      try {
      const prev = this.snapshot({ moved: false });
      const action = ACTIONS[actionIndex] || ACTIONS[0];
      const beforeGems = this.visibleGemIds();
      const beforeRooms = this.visited.size;
      const beforeDead = prev.playerDead;
      let moved = false;
      let roomChanged = false;
      let novelPushes = 0;
      let engineMove = null;

      if (action.command === "rotate_camera") {
        if (action.direction === "up") this.pitch = clampPitch(this.pitch - 1);
        else if (action.direction === "down") this.pitch = clampPitch(this.pitch + 1);
        else if (action.direction === "left") this.yaw = normalizeYaw(this.yaw - 1);
        else if (action.direction === "right") this.yaw = normalizeYaw(this.yaw + 1);
      } else if (action.command === "undo") {
        const previous = this.history.pop();
        if (previous) this.restore(previous);
      } else if (action.command === "reset_level") {
        if (this.entrySnapshot) {
          this.history.push(this.capture());
          this.restore(this.entrySnapshot);
          this.entrySnapshot = this.capture();
        }
      } else if (!prev.playerDead && action.command === "move") {
        const vector = screenMoveVector(action.move, this.yaw);
        const edge = await this.tryEdgeTransition(vector.dx, vector.dy);
        if (edge) {
          moved = true;
          roomChanged = true;
        } else {
          const before = this.capture();
          engineMove = this.span("env.engine.move", () => this.engine.move(this.state, vector.dx, vector.dy));
          moved = Boolean(engineMove?.moved);
          if (moved) this.history.push(before);
          novelPushes = this.recordPushes(engineMove);
          const exitMove = (engineMove?.moves || []).find((item) => item.levelExit);
          if (exitMove) {
            const again = await this.tryEdgeTransition(exitMove.levelExitDx, exitMove.levelExitDy);
            if (again) roomChanged = true;
          }
        }
        if (!roomChanged) this.collectGems(beforeGems);
      }

      this.actionCount += 1;
      const next = this.snapshot({ moved, action: action.command });
      const gems = Math.max(0, next.gemCount - prev.gemCount);
      const rooms = Math.max(0, next.rooms - beforeRooms);
      const death = next.playerDead && !beforeDead ? 1 : 0;
      let novel = 0;
      if (next.hash && !this.seenHashes.has(next.hash)) {
        this.seenHashes.add(next.hash);
        if (action.command !== "rotate_camera") novel = 1;
      }
      const parts = { gems, rooms, pushes: novelPushes, novel, death };
      const reward = this.rewardBetween(prev, next, parts);
      const done =
        this.actionCount >= this.maxActions || next.gemCount >= 100;
      const reason = next.gemCount >= 100 ? "win" : this.actionCount >= this.maxActions ? "max_actions" : "";
      return {
        ...next,
        reward,
        done,
        reason,
        parts,
        episodeReward: this.episodeReward,
        roomChanged,
        travelPath: roomChanged ? [] : playerPathFromMove(engineMove)
      };
      } finally {
        if (this.profiler) this.profiler.end();
      }
    }
  }

  rootObject().TrainEnv = {
    ACTIONS,
    AUX_DIM,
    CELL_COLORS,
    GRID,
    MAX_ACTORS,
    WORLD_W,
    MazeTrainEnv,
    N_ACTIONS,
    adjacentWorldLevelId,
    cellColor,
    encodeAux,
    encodeGrid,
    expandPlaybackFrames,
    playerPathFromMove,
    screenMoveVector,
    shiftPlayerCell,
    walkManhattan
  };
})();
