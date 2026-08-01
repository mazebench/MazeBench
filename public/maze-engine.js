(function () {
  const terrainTypes = {
    empty: 0,
    floor: 1,
    wall: 2,
    exit: 3,
    ice: 4,
    hole: 5,
    player_gate: 6,
    player_lift: 7,
    orange_wall: 8,
    orange_button: 9,
    tree: 10,
    ice_block: 11,
    shrub: 12,
    block_asset: 13,
    ice_slope: 14,
    orange_ice_slope: 15
  };
  const fallbackTerrainCell = {
    type: "empty",
    raised: false
  };
  const directionNames = {
    "-1,0": "L",
    "0,-1": "U",
    "0,1": "D",
    "1,0": "R"
  };
  const ICE_SLOPE_VISUAL_CLEARANCE = 0.08;
  const STATE_ELEVATION_KEY_OFFSET = 1024;
  // FIX(SEMANTICS §elevation): exit included — it has floor-identical surface
  // semantics everywhere else in the engine. Legacy omitted it, letting a
  // weightless box pushed into a raised exit's flank sink to elevation -1 and
  // be silently destroyed.
  const terrainSideBlockingSupportTypes = new Set([
    terrainTypes.floor,
    terrainTypes.ice,
    terrainTypes.exit
  ]);

  function actorType(actor) {
    return typeof actor?.type === "string" ? actor.type : "";
  }

  function isMainPlayerType(type) {
    return type === "player" || type === "circle_player";
  }

  function isPlayerType(type) {
    return isMainPlayerType(type) || type === "clone";
  }

  function isCloneType(type) {
    return type === "clone";
  }

  function isCollectibleType(type) {
    return type === "gem";
  }

  function isNonBlockingType(type) {
    return (
      isCollectibleType(type) ||
      type === "orange_button" ||
      type === "puncher" ||
      isAttachedDeviceType(type)
    );
  }

  // Attached devices use non-blocking actor records so their carrier can
  // share the cell; their raised bodies and standing surfaces are resolved
  // separately by the device-aware terrain/support helpers below.
  function isAttachedDeviceType(type) {
    return type === "attached_lift" || type === "attached_gate";
  }

  function isPushableType(type) {
    return type === "box" || type === "floating_floor" || type === "weightless_box";
  }

  function isSupportActorType(type) {
    return (
      type === "player" ||
      type === "circle_player" ||
      type === "clone" ||
      type === "box" ||
      type === "floating_floor" ||
      type === "weightless_box"
    );
  }

  function pushWeightForType(type) {
    return type === "box" || type === "floating_floor" ? 1 : 0;
  }

  function normalizePuncherDirection(direction) {
    const value = String(direction || "").toLowerCase();

    if (value === "left" || value === "l" || value === "-1,0") {
      return "left";
    }

    if (value === "up" || value === "u" || value === "0,-1") {
      return "up";
    }

    if (value === "down" || value === "d" || value === "0,1") {
      return "down";
    }

    return "right";
  }

  function puncherDirectionVector(direction) {
    const normalized = normalizePuncherDirection(direction);

    if (normalized === "left") {
      return { dx: -1, dy: 0 };
    }

    if (normalized === "up") {
      return { dx: 0, dy: -1 };
    }

    if (normalized === "down") {
      return { dx: 0, dy: 1 };
    }

    return { dx: 1, dy: 0 };
  }

  function normalizedTerrainType(type) {
    return terrainTypes[type] ?? terrainTypes.empty;
  }

  function normalizedTerrainLayers(cell, fallbackType = terrainTypes.empty) {
    const sourceLayers = Array.isArray(cell?.layers) ? cell.layers : null;
    const layers =
      sourceLayers && sourceLayers.length > 0
        ? sourceLayers
        : fallbackType === terrainTypes.empty
          ? []
          : [
              {
                type: cell?.type || "empty",
                elevation: 0,
                raised: cell?.raised === true
              }
            ];

    return layers
      .map((layer) => {
        const elevation = Number.isInteger(layer?.elevation) ? layer.elevation : 0;

        return {
          type: normalizedTerrainType(layer?.type),
          elevation: Math.max(0, elevation),
          direction: typeof layer?.direction === "string" ? layer.direction : null,
          raised: layer?.raised === true
        };
      })
      .filter((layer) => layer.type !== terrainTypes.empty)
      .sort((left, right) => left.elevation - right.elevation);
  }

  function encodeKeyValue(value) {
    return String.fromCharCode(Math.max(0, Math.min(65534, value | 0)));
  }

  function createEngine(playData) {
    const width = Math.max(1, Number(playData?.width) || 1);
    const height = Math.max(1, Number(playData?.height) || 1);
    const cellCount = width * height;
    const loadWarnings = [];
    const sourceTerrain = Array.isArray(playData?.terrain) ? playData.terrain : [];
    const baseTerrain = new Uint8Array(cellCount);
    const baseLiftRaised = new Uint8Array(cellCount);
    const terrainLayers = Array.from({ length: cellCount }, () => []);
    const playerGateCells = [];
    const playerLiftCells = [];
    const orangeWallCells = [];
    const orangeTerrainCells = [];
    const orangeButtonCells = [];
    const actorSource = Array.isArray(playData?.actors) ? playData.actors : [];
    const actorTypes = actorSource.map((actor) => actorType(actor));
    const actorGroupIds = actorSource.map((actor) => actor?.groupId ?? "");
    // Owner feature (2026-07): slope-SHAPED group members. A weightless box
    // or clone actor with shape "slope" moves with its group like any other
    // member, but other actors traverse it exactly like an ice-slope cell
    // (and it blocks its elevation band like one).
    const actorShapes = actorSource.map((actor) =>
      actor?.shape === "slope" ? "slope" : "cube"
    );
    const slopeActorIndexes = [];

    actorShapes.forEach((shape, index) => {
      if (shape === "slope") {
        slopeActorIndexes.push(index);
      }
    });

    const levelHasSlopeActors = slopeActorIndexes.length > 0;

    function isSlopeShapedActor(index) {
      return actorShapes[index] === "slope";
    }

    // A movable slope is still a support-category actor for settling and
    // group motion, but its inclined face is never a flat standing surface.
    // Traversal comes exclusively from the shared ice-slope helpers below,
    // matching terrain, black, and orange ice slopes exactly.
    function actorProvidesFlatSupport(index) {
      return isSupportActorType(actorTypes[index]) && !isSlopeShapedActor(index);
    }

    // Owner rule (2026-07, functional round): attached lifts/gates are REAL
    // devices that happen to ride a carrier. The lift's raised bit lives in
    // the journaled per-cell liftRaised buffer (the actor's elevation always
    // tracks the carrier top, so the ride syncs stay untouched); the gate's
    // raised state is derived per move from the same proximity rule as
    // terrain gates and shares the raised-gate cell set.
    const attachedLiftIndexes = [];
    const attachedGateIndexes = [];

    actorTypes.forEach((type, index) => {
      if (type === "attached_lift") {
        attachedLiftIndexes.push(index);
      } else if (type === "attached_gate") {
        attachedGateIndexes.push(index);
      }
    });

    const levelHasAttachedDevices =
      attachedLiftIndexes.length > 0 || attachedGateIndexes.length > 0;

    // An authored raised lift ('L') on a carrier starts with its bit set.
    attachedLiftIndexes.forEach((index) => {
      const actor = actorSource[index];
      const x = Number(actor?.x) || 0;
      const y = Number(actor?.y) || 0;

      if (actor?.raised === true && x >= 0 && x < width && y >= 0 && y < height) {
        baseLiftRaised[y * width + x] = 1;
      }
    });
    const actorDirections = actorSource.map((actor) =>
      normalizePuncherDirection(actor?.direction || actor?.facing)
    );
    const actorCount = actorSource.length;
    const orangeButtonActors = [];
    const actorInitialElevations = [];
    const weightlessRelativeElevations = [];
    const searchSeenActors = new Uint32Array(actorCount);
    const initialGemRemoved = new Uint8Array(actorCount);
    let searchSeenStamp = 0;

    for (let index = 0; index < actorCount; index += 1) {
      actorInitialElevations[index] = initialActorElevation(actorSource[index], index);
      weightlessRelativeElevations[index] = 0;

      if (actorTypes[index] === "gem" && actorSource[index]?.removed) {
        initialGemRemoved[index] = 1;
      }

      if (actorTypes[index] === "orange_button") {
        orangeButtonActors.push(index);
      }
    }

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const cell = sourceTerrain[y]?.[x] || fallbackTerrainCell;
        const index = cellIndex(x, y);
        const terrainType = normalizedTerrainType(cell.type);

        baseTerrain[index] = terrainType;
        terrainLayers[index] = normalizedTerrainLayers(cell, terrainType);

        // FIX(SEMANTICS §devices): stacked player lifts share one raised bit
        // per cell in the state contract, so multiple lift layers in a cell
        // are physically unrepresentable — stepping on "l+l" soft-locked the
        // game. Keep only the lowest lift layer and warn the author.
        const liftLayerList = terrainLayers[index].filter(
          (layer) => layer.type === terrainTypes.player_lift
        );

        if (liftLayerList.length > 1) {
          const keepLift = liftLayerList[0];
          terrainLayers[index] = terrainLayers[index].filter(
            (layer) => layer.type !== terrainTypes.player_lift || layer === keepLift
          );
          loadWarnings.push(
            `cell (${x},${y}): stacked player lifts normalized to the single lift at elevation ${keepLift.elevation}`
          );
        }

        if (
          terrainType === terrainTypes.player_lift && cell.raised === true ||
          terrainLayers[index].some(
            (layer) => layer.type === terrainTypes.player_lift && layer.raised === true
          )
        ) {
          baseLiftRaised[index] = 1;
        }

        if (terrainLayers[index].some((layer) => layer.type === terrainTypes.player_lift)) {
          playerLiftCells.push(index);
        }

        if (terrainLayers[index].some((layer) => layer.type === terrainTypes.player_gate)) {
          playerGateCells.push(index);
        }

        if (terrainLayers[index].some((layer) => layer.type === terrainTypes.orange_wall)) {
          orangeWallCells.push(index);
        }

        if (terrainLayers[index].some((layer) => isOrangeTerrainLayerType(layer.type))) {
          orangeTerrainCells.push(index);
        }

        if (terrainLayers[index].some((layer) => layer.type === terrainTypes.orange_button)) {
          orangeButtonCells.push(index);
        }
      }
    }

    const orangeTerrainCellMask = new Uint8Array(cellCount);
    const orangeTerrainComponents = [];

    orangeTerrainCells.forEach((cell) => {
      orangeTerrainCellMask[cell] = 1;
    });

    for (const startCell of orangeTerrainCells) {
      if (orangeTerrainCellMask[startCell] !== 1) {
        continue;
      }

      const component = [];
      const queue = [startCell];
      orangeTerrainCellMask[startCell] = 2;

      for (let head = 0; head < queue.length; head += 1) {
        const cell = queue[head];
        const x = cell % width;
        const y = Math.floor(cell / width);
        component.push(cell);

        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nextX = x + dx;
          const nextY = y + dy;

          if (!isInsideBoard(nextX, nextY)) {
            continue;
          }

          const nextCell = cellIndex(nextX, nextY);

          if (orangeTerrainCellMask[nextCell] === 1) {
            orangeTerrainCellMask[nextCell] = 2;
            queue.push(nextCell);
          }
        }
      }

      orangeTerrainComponents.push(component);
    }

    initializeWeightlessRelativeElevations();

    // ------------------------------------------------------------------
    // Perf caches for many-piece levels (giant weightless groups made the
    // cluster machinery quadratic: 224 boxes at 1.4k moves/s before these).
    // ------------------------------------------------------------------

    // Static group membership: actors never change group, so the per-call
    // O(actorCount) scans + array allocations become cached lookups.
    const weightlessMembersByGroup = new Map();
    const cloneMembersByGroup = new Map();

    for (let index = 0; index < actorCount; index += 1) {
      if (actorTypes[index] === "weightless_box") {
        const groupKey = actorGroupIds[index];

        if (!weightlessMembersByGroup.has(groupKey)) {
          weightlessMembersByGroup.set(groupKey, []);
        }

        weightlessMembersByGroup.get(groupKey).push(index);
      } else if (isCloneType(actorTypes[index])) {
        const groupKey = actorGroupIds[index] || "";

        if (!cloneMembersByGroup.has(groupKey)) {
          cloneMembersByGroup.set(groupKey, []);
        }

        cloneMembersByGroup.get(groupKey).push(index);
      }
    }

    // Slope cell mask: every slope helper starts from the target cell's
    // slope layers. On slope-free boards (or non-slope cells) a single byte
    // probe replaces five traversal probes and their layer-array filters.
    const slopeCellMask = new Uint8Array(cellCount);
    let levelHasSlopes = false;

    for (let cell = 0; cell < cellCount; cell += 1) {
      if (
        terrainLayers[cell].some(
          (layer) =>
            layer.type === terrainTypes.ice_slope ||
            layer.type === terrainTypes.orange_ice_slope
        )
      ) {
        slopeCellMask[cell] = 1;
        levelHasSlopes = true;
      }
    }

    const EMPTY_LAYER_LIST = Object.freeze([]);

    // ------------------------------------------------------------------
    // Rigid-body shape data. Weightless groups never change shape (members
    // move in lockstep, settle uniformly, and are removed only whole), so
    // for each cardinal push direction every member is either FRONTIER (its
    // target voxel is outside its own body — it can collide) or INTERIOR
    // (its target voxel is another member's cell at the same elevation — by
    // induction it can always enter, because the current occupant legally
    // stands there). A 75-voxel body then pays ~perimeter checks per step
    // instead of ~volume. Interior skips are disabled per group if any
    // member has been removed, and per cell when a side-blocking flank
    // (elevated floor/ice/exit) exists at the target.
    // Direction bits: 1=R(+x) 2=L(-x) 4=D(+y) 8=U(-y).
    const weightlessInteriorFlags = new Uint8Array(actorCount);

    {
      const positionKeys = new Set();
      const shapeKey = (x, y, e) => ((e + 4) * 4096 + (y + 2) * 128 + (x + 2));

      for (const cached of weightlessMembersByGroup.values()) {
        positionKeys.clear();

        for (const index of cached) {
          positionKeys.add(
            shapeKey(
              Number.isInteger(actorSource[index]?.x) ? actorSource[index].x : 0,
              Number.isInteger(actorSource[index]?.y) ? actorSource[index].y : 0,
              actorInitialElevations[index] || 0
            )
          );
        }

        for (const index of cached) {
          const x = Number.isInteger(actorSource[index]?.x) ? actorSource[index].x : 0;
          const y = Number.isInteger(actorSource[index]?.y) ? actorSource[index].y : 0;
          const e = actorInitialElevations[index] || 0;
          let flags = 0;

          if (positionKeys.has(shapeKey(x + 1, y, e))) flags |= 1;
          if (positionKeys.has(shapeKey(x - 1, y, e))) flags |= 2;
          if (positionKeys.has(shapeKey(x, y + 1, e))) flags |= 4;
          if (positionKeys.has(shapeKey(x, y - 1, e))) flags |= 8;

          weightlessInteriorFlags[index] = flags;
        }
      }
    }

    function interiorDirBit(dx, dy) {
      if (dx === 1 && dy === 0) return 1;
      if (dx === -1 && dy === 0) return 2;
      if (dx === 0 && dy === 1) return 4;
      if (dx === 0 && dy === -1) return 8;
      return 0;
    }

    // Cells whose flank refuses weightless entry (elevated floor/ice/exit
    // layers) — interior skips are not taken into such cells so the
    // side-block rule keeps its legacy semantics.
    const sideBlockCellMask = new Uint8Array(cellCount);

    for (let cell = 0; cell < cellCount; cell += 1) {
      if (
        terrainLayers[cell].some(
          (layer) =>
            terrainSideBlockingSupportTypes.has(layer.type) && layer.elevation >= 1
        )
      ) {
        sideBlockCellMask[cell] = 1;
      }
    }

    // Stamped actor mark set — replaces `new Set(members)` + .has() churn in
    // the hot group-support loops.
    const actorMarks = new Int32Array(actorCount);
    let actorMarkStamp = 0;

    function markActorList(list) {
      actorMarkStamp += 1;

      if (actorMarkStamp >= 0x7ffffff0) {
        actorMarks.fill(0);
        actorMarkStamp = 1;
      }

      for (let i = 0; i < list.length; i += 1) {
        actorMarks[list[i]] = actorMarkStamp;
      }

      return actorMarkStamp;
    }

    // Stamped spatial index of support-actor TOP surfaces: one O(actorCount)
    // build per group operation, then O(1) probes per member — replaces the
    // per-member O(actorCount) actorSupportSurfaceHeightsAt scans.
    // Sized with the same slot layout as the occupancy grid (ELEV_SLOTS is
    // declared below with the occupancy section; 20 must match it — the
    // helpers index through occupancySlot, so a mismatch would throw).
    const supportTopStampGrid = new Int32Array(cellCount * 20);
    const supportTopActorGrid = new Int16Array(cellCount * 20);
    let supportTopStamp = 0;

    let buildActorSupportTopGridEpoch = -1;
    let buildActorSupportTopGridLength = -1;

    function buildActorSupportTopGrid(state) {
      if (buildActorSupportTopGridEpoch === journalEpoch && buildActorSupportTopGridLength === journalLength) {
        return;
      }

      buildActorSupportTopGridEpoch = journalEpoch;
      buildActorSupportTopGridLength = journalLength;
      supportTopStamp += 1;

      if (supportTopStamp >= 0x3ffffff0) {
        supportTopStampGrid.fill(0);
        supportTopStamp = 1;
      }

      for (let index = 0; index < actorCount; index += 1) {
        if (state.actorRemoved[index] || !actorProvidesFlatSupport(index)) {
          continue;
        }

        const slot = occupancySlot(
          state.actorX[index],
          state.actorY[index],
          (state.actorElevation[index] || 0) + 1
        );

        if (slot >= 0) {
          supportTopStampGrid[slot] = supportTopStamp;
          supportTopActorGrid[slot] = index;
        }
      }
    }

    // Highest support height (terrain or non-member actor top) at (x, y)
    // that is <= maxHeight. Requires buildActorSupportTopGrid + markActorList
    // to have been called for the current operation.
    function maxSupportHeightAtOrBelow(
      state,
      x,
      y,
      maxHeight,
      memberStamp,
      includePlayers,
      gateState,
      orangeButtonsPressed
    ) {
      let best = -Infinity;

      if (!isInsideBoard(x, y)) {
        return best;
      }

      const cell = cellIndex(x, y);
      const layers = terrainLayersForCell(state, cell);

      for (let i = 0; i < layers.length; i += 1) {
        const height = terrainLayerSurfaceHeight(
          state,
          cell,
          layers[i],
          gateState,
          orangeButtonsPressed
        );

        if (height !== null && height <= maxHeight && height > best) {
          best = height;
        }
      }

      // Actor tops live at elevation+1, so the lowest possible top is
      // -ELEV_BASE+1; the hard floor also guards the -Infinity terrain case.
      for (let height = maxHeight; height > best && height >= 1 - ELEV_BASE_FOR_SUPPORT; height -= 1) {
        const slot = occupancySlot(x, y, height);

        if (slot < 0 || supportTopStampGrid[slot] !== supportTopStamp) {
          continue;
        }

        const actor = supportTopActorGrid[slot];

        if (actorMarks[actor] === memberStamp) {
          continue;
        }

        if (!includePlayers && isMainPlayerActor(actor)) {
          continue;
        }

        best = height;
        break;
      }

      return best;
    }

    const ELEV_BASE_FOR_SUPPORT = 2; // must match ELEV_BASE below

    // Compile-time probe: does any cell contain a hole layer or a bare void
    // at ground level (nothing standable or blocking at elevation 0)? Used
    // to gate the dynamic sink/removal logic. Conservative: hole fills only
    // ever ADD floor, so the base-terrain answer stays safe after fills.
    let levelHasVoidOrHoleCells = false;

    {
      const probeState = { terrain: baseTerrain, liftRaised: baseLiftRaised };

      for (let cell = 0; cell < cellCount; cell += 1) {
        const x = cellX(cell);
        const y = cellY(cell);

        if (
          terrainLayers[cell].some((layer) => layer.type === terrainTypes.hole) ||
          isEmptyVoidAtElevation(probeState, x, y, 0)
        ) {
          levelHasVoidOrHoleCells = true;
          break;
        }
      }
    }

    // Capability probe for the admissible heuristic: on a level where no
    // mechanic can move a player more than one cell per input (no ice, no
    // ice blocks, no slopes, no punchers), plain Manhattan distance is
    // admissible and much stronger guidance than the axis-count bound.
    let levelHasLongPlayerMoves = actorTypes.some((type) => type === "puncher");

    if (!levelHasLongPlayerMoves) {
      for (let cell = 0; cell < cellCount; cell += 1) {
        if (
          terrainLayers[cell].some(
            (layer) =>
              layer.type === terrainTypes.ice ||
              layer.type === terrainTypes.ice_block ||
              layer.type === terrainTypes.ice_slope ||
              layer.type === terrainTypes.orange_ice_slope
          )
        ) {
          levelHasLongPlayerMoves = true;
          break;
        }
      }
    }

    function cellIndex(x, y) {
      return y * width + x;
    }

    function cellX(index) {
      return index % width;
    }

    function cellY(index) {
      return Math.floor(index / width);
    }

    function isInsideBoard(x, y) {
      return x >= 0 && x < width && y >= 0 && y < height;
    }

    // ------------------------------------------------------------------
    // Load-time validation (FIX, SEMANTICS §load): the editor always writes
    // explicit elevations, which used to disable every safety snap — actors
    // authored floating in mid-air were permanently frozen, and actors
    // authored on holes obeyed different physics than actors pushed onto
    // them. Each normalization is recorded in engine.loadWarnings so the
    // editor can surface it. Gems are exempt: gems float (owner decision).
    // Weightless groups are exempt: their group settle runs separately.
    // ------------------------------------------------------------------
    function applyLoadNormalization(state, gateState, orangeButtonsPressed) {
      for (let index = 0; index < actorCount; index += 1) {
        if (state.actorRemoved[index]) {
          continue;
        }

        const typeName = actorTypes[index];
        const x = state.actorX[index];
        const y = state.actorY[index];

        if (!isInsideBoard(x, y)) {
          state.actorRemoved[index] = 1;
          loadWarnings.push(
            `actor ${index} (${typeName}) at (${x},${y}) is outside the board — removed`
          );
          continue;
        }

        // Normalization applies only to solid gravity-bound singles (box,
        // floating_floor). Gems float (owner decision); weightless boxes and
        // clones keep authored group formations (their group-settle passes
        // own their elevations); punchers and buttons are fixtures legally
        // authorable anywhere (including over holes); players are never
        // moved — cross-room punch continuations legitimately rebuild them
        // mid-flight at unsupported elevations.
        if (typeName !== "box" && typeName !== "floating_floor") {
          if (
            isPlayerType(typeName) &&
            !isCloneType(typeName) &&
            actorElevation(state, index) > 0 &&
            !surfaceSupportsElevation(
              state,
              x,
              y,
              actorElevation(state, index),
              gateState,
              orangeButtonsPressed,
              new Set([index]),
              true
            )
          ) {
            loadWarnings.push(
              `player ${index} authored floating at (${x},${y}) elevation ${actorElevation(state, index)} — left as authored (may be unreachable)`
            );
          }

          continue;
        }

        const elevation = actorElevation(state, index);

        if (
          surfaceSupportsElevation(
            state,
            x,
            y,
            elevation,
            gateState,
            orangeButtonsPressed,
            new Set([index]),
            true
          )
        ) {
          continue;
        }

        // Floating floor authored on a hole fills it at load — identical to
        // the pushed-into-hole behavior, so authored and reachable states
        // obey one physics. Strict hole layers only: actors authored on
        // bare-void cells (e.g. a lone orange_button cell) are legal and
        // stay put (tested legacy behavior — a box authored on a button
        // presses it).
        if (elevation === 0 && isTerrainHoleAtElevation(state, x, y, 0)) {
          if (typeName === "floating_floor") {
            state.terrain[cellIndex(x, y)] = terrainTypes.floor;
            state.actorRemoved[index] = 1;
            loadWarnings.push(
              `floating floor ${index} authored on the hole at (${x},${y}) filled it at load`
            );
          } else {
            state.actorRemoved[index] = 1;
            loadWarnings.push(
              `actor ${index} (${typeName}) authored on the hole at (${x},${y}) fell in at load`
            );
          }
          continue;
        }

        // Unsupported box/floating_floor: ground to the highest support
        // at-or-below (matching the in-game landing rule R2) — legacy left
        // them permanently frozen and unpushable in mid-air.
        const supports = terrainSurfaceHeightsAt(state, x, y, gateState, orangeButtonsPressed)
          .concat(actorSupportSurfaceHeightsAt(state, x, y, new Set([index]), true))
          .filter((height) => height < elevation)
          .sort((left, right) => right - left);
        const landing = supports.find(
          (height) => !terrainBlocksElevation(state, x, y, height, gateState, orangeButtonsPressed)
        );

        // Ground only when real support exists below. A box floating over a
        // hole/void keeps its authored elevation — pinned behavior: such
        // boxes take part in scripted fall sequences when something slides
        // in underneath.
        if (landing !== undefined) {
          state.actorElevation[index] = landing;
          loadWarnings.push(
            `actor ${index} (${typeName}) authored floating at (${x},${y}) elevation ${elevation} — grounded to ${landing}`
          );
        }
      }
    }

    function createInitialState() {
      const state = createStateBuffer();

      state.liftRaised.set(baseLiftRaised);
      state.terrain.set(baseTerrain);

      actorSource.forEach((actor, index) => {
        state.actorX[index] = Number.isInteger(actor?.x) ? actor.x : 0;
        state.actorY[index] = Number.isInteger(actor?.y) ? actor.y : 0;
        state.actorElevation[index] = actorInitialElevations[index] || 0;
        state.actorRemoved[index] = actor?.removed ? 1 : 0;
      });

      let gateState = computeRaisedPlayerGateSet(state);
      let orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState);

      for (let iteration = 0; iteration < 4; iteration += 1) {
        const changed = syncWeightlessGroupElevations(
          state,
          gateState,
          orangeButtonsPressed,
          true
        );

        gateState = computeRaisedPlayerGateSet(state);
        orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState);

        if (!changed) {
          break;
        }
      }

      for (let index = 0; index < actorCount; index += 1) {
        if (isPlayerActor(index)) {
          if (hasExplicitElevation(actorSource[index])) {
            continue;
          }

          state.actorElevation[index] =
            playerSurfaceHeightAt(
              state,
              state.actorX[index],
              state.actorY[index],
              gateState,
              orangeButtonsPressed,
              null,
              new Set([index])
            ) ?? 0;
        }
      }

      applyLoadNormalization(state, gateState, orangeButtonsPressed);

      // Discard any journal entries produced while settling the initial
      // state, and give the buffer a valid incremental hash baseline.
      journalLength = 0;
      journalEpoch += 1;
      recomputeHash(state);

      return state;
    }

    function hasExplicitElevation(actor) {
      return Object.prototype.hasOwnProperty.call(actor ?? {}, "elevation");
    }

    function initialActorElevation(actor, index) {
      if (hasExplicitElevation(actor)) {
        return actor?.elevation ?? 0;
      }

      if (!isSupportActorType(actorTypes[index]) && !isCollectibleType(actorTypes[index])) {
        return 0;
      }

      const x = Number.isInteger(actor?.x) ? actor.x : 0;
      const y = Number.isInteger(actor?.y) ? actor.y : 0;
      let elevation = 0;

      for (let other = 0; other < index; other += 1) {
        const otherActor = actorSource[other];

        if (
          actorProvidesFlatSupport(other) &&
          !otherActor?.removed &&
          (Number.isInteger(otherActor?.x) ? otherActor.x : 0) === x &&
          (Number.isInteger(otherActor?.y) ? otherActor.y : 0) === y
        ) {
          elevation = Math.max(elevation, (actorInitialElevations[other] || 0) + 1);
        }
      }

      return elevation;
    }

    function initializeWeightlessRelativeElevations() {
      const groupBaseElevations = new Map();

      for (let index = 0; index < actorCount; index += 1) {
        if (actorTypes[index] !== "weightless_box") {
          continue;
        }

        const groupId = actorGroupIds[index];
        const elevation = actorInitialElevations[index] || 0;
        const groupBase = groupBaseElevations.has(groupId)
          ? Math.min(groupBaseElevations.get(groupId), elevation)
          : elevation;

        groupBaseElevations.set(groupId, groupBase);
      }

      for (let index = 0; index < actorCount; index += 1) {
        if (actorTypes[index] !== "weightless_box") {
          continue;
        }

        weightlessRelativeElevations[index] =
          (actorInitialElevations[index] || 0) -
          (groupBaseElevations.get(actorGroupIds[index]) || 0);
      }
    }

    function syncWeightlessGroupElevations(
      state,
      gateState,
      orangeButtonsPressed,
      preserveAuthoredElevations = false
    ) {
      const initializedWeightlessGroups = new Set();
      let changed = false;

      for (let index = 0; index < actorCount; index += 1) {
        if (actorTypes[index] !== "weightless_box" || state.actorRemoved[index]) {
          continue;
        }

        const groupId = actorGroupIds[index];

        if (initializedWeightlessGroups.has(groupId)) {
          continue;
        }

        initializedWeightlessGroups.add(groupId);

        const members = weightlessGroupMembers(state, groupId);

        if (
          preserveAuthoredElevations &&
          members.every((member) => hasExplicitElevation(actorSource[member]))
        ) {
          continue;
        }

        const baseElevation = weightlessGroupSupportedElevation(
          state,
          members,
          gateState,
          orangeButtonsPressed
        );

        members.forEach((member) => {
          const elevation = baseElevation + (weightlessRelativeElevations[member] || 0);

          if (state.actorElevation[member] !== elevation) {
            jSetActorElevation(state, member, elevation);
            changed = true;
          }
        });
      }

      return changed;
    }

    function createStateBuffer() {
      return {
        actorElevation: new Int16Array(actorCount),
        actorRemoved: new Uint8Array(actorCount),
        actorX: new Int16Array(actorCount),
        actorY: new Int16Array(actorCount),
        liftRaised: new Uint8Array(cellCount),
        terrain: new Uint8Array(cellCount),
        hashLo: 0,
        hashHi: 0,
        hashValid: false
      };
    }

    function cloneState(state) {
      return {
        actorElevation: new Int16Array(state.actorElevation),
        actorRemoved: new Uint8Array(state.actorRemoved),
        actorX: new Int16Array(state.actorX),
        actorY: new Int16Array(state.actorY),
        liftRaised: new Uint8Array(state.liftRaised),
        terrain: new Uint8Array(state.terrain),
        hashLo: state.hashLo | 0,
        hashHi: state.hashHi | 0,
        hashValid: state.hashValid === true
      };
    }

    function copyStateInto(target, source) {
      target.actorElevation.set(source.actorElevation);
      target.actorRemoved.set(source.actorRemoved);
      target.actorX.set(source.actorX);
      target.actorY.set(source.actorY);
      target.liftRaised.set(source.liftRaised);
      target.terrain.set(source.terrain);
      target.hashLo = source.hashLo | 0;
      target.hashHi = source.hashHi | 0;
      target.hashValid = source.hashValid === true;
    }

    // -----------------------------------------------------------------------
    // Incremental 64-bit state hash (two Uint32 lanes, splitmix-style mixer).
    // Maintained by the journaled setters below, so stateKey() is O(1) instead
    // of the legacy O(actorCount + cellCount) string build. Buffers created
    // outside the engine (hashValid=false) get one full recompute on first use.
    // -----------------------------------------------------------------------
    const HASH_SEED_LO = 0x8f1bbcdc | 0;
    const HASH_SEED_HI = 0x5be0cd19 | 0;

    function mix32(value) {
      let z = (value + 0x9e3779b9) | 0;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) | 0;
    }

    function actorHashLo(index, x, y, elevation, removed) {
      return mix32(
        Math.imul(index + 1, 0x1000193) ^
          ((x + 2) & 0xff) ^ (((y + 2) & 0xff) << 8) ^
          (((elevation + 16) & 0x3f) << 16) ^ ((removed & 1) << 22)
      );
    }

    function actorHashHi(index, x, y, elevation, removed) {
      return mix32(
        0x517cc1b7 ^
          Math.imul(index + 1, 0x85ebca77) ^
          (((x + 2) & 0xff) << 4) ^ (((y + 2) & 0xff) << 12) ^
          (((elevation + 16) & 0x3f) << 20) ^ ((removed & 1) << 26)
      );
    }

    function terrainHashLo(cell, value) {
      return mix32(0x27d4eb2f ^ Math.imul(cell + 1, 0x9e3779b1) ^ (value << 16));
    }

    function terrainHashHi(cell, value) {
      return mix32(0x165667b1 ^ Math.imul(cell + 1, 0xc2b2ae3d) ^ (value << 12));
    }

    function liftHashLo(cell) {
      return mix32(0x62a9d9ed ^ Math.imul(cell + 1, 0x2545f491));
    }

    function liftHashHi(cell) {
      return mix32(0x94d049bb ^ Math.imul(cell + 1, 0x633d9abf));
    }

    function recomputeHash(state) {
      let lo = HASH_SEED_LO;
      let hi = HASH_SEED_HI;

      for (let index = 0; index < actorCount; index += 1) {
        lo ^= actorHashLo(index, state.actorX[index], state.actorY[index], state.actorElevation[index], state.actorRemoved[index]);
        hi ^= actorHashHi(index, state.actorX[index], state.actorY[index], state.actorElevation[index], state.actorRemoved[index]);
      }

      for (let cell = 0; cell < cellCount; cell += 1) {
        if (state.terrain[cell] !== baseTerrain[cell]) {
          lo ^= terrainHashLo(cell, state.terrain[cell]);
          hi ^= terrainHashHi(cell, state.terrain[cell]);
        }
      }

      for (let index = 0; index < playerLiftCells.length; index += 1) {
        const cell = playerLiftCells[index];

        if (state.liftRaised[cell] !== baseLiftRaised[cell]) {
          lo ^= liftHashLo(cell);
          hi ^= liftHashHi(cell);
        }
      }

      state.hashLo = lo;
      state.hashHi = hi;
      state.hashValid = true;
    }

    function stateKey(state) {
      if (state.hashValid !== true) {
        recomputeHash(state);
      }

      const lo = state.hashLo >>> 0;
      const hi = state.hashHi >>> 0;

      return String.fromCharCode(lo & 0xffff, lo >>> 16, hi & 0xffff, hi >>> 16);
    }

    // -----------------------------------------------------------------------
    // Mutation journal. Every state write on the move path goes through the
    // jSet* setters, which record (field, index, oldValue) triplets for exact
    // rollback and keep the incremental hash in sync. undoMove() restores the
    // buffer bit-for-bit \u2014 the legacy record-replay undo corrupted elevations
    // (audit: elevated gems zeroed on backtrack).
    // Fields: 0=actorX 1=actorY 2=actorElevation 3=actorRemoved 4=terrain 5=liftRaised
    // -----------------------------------------------------------------------
    let journal = new Int32Array(4096);
    let journalLength = 0;
    let journalEpoch = 1;

    function journalPush(field, index, oldValue) {
      if (journalLength + 3 > journal.length) {
        const grown = new Int32Array(journal.length * 2);
        grown.set(journal);
        journal = grown;
      }

      journal[journalLength] = field;
      journal[journalLength + 1] = index;
      journal[journalLength + 2] = oldValue;
      journalLength += 3;
    }

    function hashActorToggle(state, index) {
      if (state.hashValid !== true) {
        return;
      }

      state.hashLo ^= actorHashLo(index, state.actorX[index], state.actorY[index], state.actorElevation[index], state.actorRemoved[index]);
      state.hashHi ^= actorHashHi(index, state.actorX[index], state.actorY[index], state.actorElevation[index], state.actorRemoved[index]);
    }

    function jSetActorX(state, index, value) {
      if (state.actorX[index] === value) return;
      journalPush(0, index, state.actorX[index]);
      hashActorToggle(state, index);
      state.actorX[index] = value;
      hashActorToggle(state, index);
    }

    function jSetActorY(state, index, value) {
      if (state.actorY[index] === value) return;
      journalPush(1, index, state.actorY[index]);
      hashActorToggle(state, index);
      state.actorY[index] = value;
      hashActorToggle(state, index);
    }

    function jSetActorElevation(state, index, value) {
      if (state.actorElevation[index] === value) return;
      journalPush(2, index, state.actorElevation[index]);
      hashActorToggle(state, index);
      state.actorElevation[index] = value;
      hashActorToggle(state, index);
    }

    function jSetActorRemoved(state, index, value) {
      const next = value ? 1 : 0;
      if (state.actorRemoved[index] === next) return;
      journalPush(3, index, state.actorRemoved[index]);
      hashActorToggle(state, index);
      state.actorRemoved[index] = next;
      hashActorToggle(state, index);
    }

    function jSetTerrain(state, cell, value) {
      if (state.terrain[cell] === value) return;
      journalPush(4, cell, state.terrain[cell]);

      if (state.hashValid === true) {
        if (state.terrain[cell] !== baseTerrain[cell]) {
          state.hashLo ^= terrainHashLo(cell, state.terrain[cell]);
          state.hashHi ^= terrainHashHi(cell, state.terrain[cell]);
        }

        if (value !== baseTerrain[cell]) {
          state.hashLo ^= terrainHashLo(cell, value);
          state.hashHi ^= terrainHashHi(cell, value);
        }
      }

      state.terrain[cell] = value;
    }

    function jSetLiftRaised(state, cell, value) {
      const next = value ? 1 : 0;
      if (state.liftRaised[cell] === next) return;
      journalPush(5, cell, state.liftRaised[cell]);

      if (state.hashValid === true) {
        state.hashLo ^= liftHashLo(cell);
        state.hashHi ^= liftHashHi(cell);
      }

      state.liftRaised[cell] = next;
    }

    function journalMark() {
      return journalLength;
    }

    function journalRollback(state, mark) {
      while (journalLength > mark) {
        journalLength -= 3;
        const field = journal[journalLength];
        const index = journal[journalLength + 1];
        const oldValue = journal[journalLength + 2];

        switch (field) {
          case 0:
            hashActorToggle(state, index);
            state.actorX[index] = oldValue;
            hashActorToggle(state, index);
            break;
          case 1:
            hashActorToggle(state, index);
            state.actorY[index] = oldValue;
            hashActorToggle(state, index);
            break;
          case 2:
            hashActorToggle(state, index);
            state.actorElevation[index] = oldValue;
            hashActorToggle(state, index);
            break;
          case 3:
            hashActorToggle(state, index);
            state.actorRemoved[index] = oldValue;
            hashActorToggle(state, index);
            break;
          case 4:
            if (state.hashValid === true) {
              if (state.terrain[index] !== baseTerrain[index]) {
                state.hashLo ^= terrainHashLo(index, state.terrain[index]);
                state.hashHi ^= terrainHashHi(index, state.terrain[index]);
              }
              if (oldValue !== baseTerrain[index]) {
                state.hashLo ^= terrainHashLo(index, oldValue);
                state.hashHi ^= terrainHashHi(index, oldValue);
              }
            }
            state.terrain[index] = oldValue;
            break;
          case 5:
            if (state.hashValid === true) {
              state.hashLo ^= liftHashLo(index);
              state.hashHi ^= liftHashHi(index);
            }
            state.liftRaised[index] = oldValue;
            break;
          default:
            break;
        }
      }
    }

    // Preallocated per-move scratch (no per-move allocations on the hot path).
    // originalActor*: positions at move() entry, consumed by the puncher /
    // attachment sync passes. attemptBefore*: positions captured at the start
    // of a push attempt, consumed by ride-support checks after the push.
    const originalActorX = new Int16Array(actorCount);
    const originalActorY = new Int16Array(actorCount);
    const originalActorElevation = new Int16Array(actorCount);
    const attemptBeforeState = {
      actorX: new Int16Array(actorCount),
      actorY: new Int16Array(actorCount),
      actorElevation: new Int16Array(actorCount)
    };

    function captureAttemptBefore(state) {
      attemptBeforeState.actorX.set(state.actorX);
      attemptBeforeState.actorY.set(state.actorY);
      attemptBeforeState.actorElevation.set(state.actorElevation);
      return attemptBeforeState;
    }

    function actorCell(state, actorIndex) {
      return cellIndex(state.actorX[actorIndex], state.actorY[actorIndex]);
    }

    function isPlayerActor(actorIndex) {
      return isPlayerType(actorTypes[actorIndex]);
    }

    function isCloneActor(actorIndex) {
      return isCloneType(actorTypes[actorIndex]);
    }

    function isMainPlayerActor(actorIndex) {
      return isMainPlayerType(actorTypes[actorIndex]);
    }

    function isCollectibleActor(actorIndex) {
      return isCollectibleType(actorTypes[actorIndex]);
    }

    function isNonBlockingActor(actorIndex) {
      return isNonBlockingType(actorTypes[actorIndex]);
    }

    function isPuncherActor(actorIndex) {
      return actorTypes[actorIndex] === "puncher";
    }

    function isOrangeButtonActor(actorIndex) {
      return actorTypes[actorIndex] === "orange_button";
    }

    function isPushableActor(actorIndex) {
      return isPushableType(actorTypes[actorIndex]);
    }

    function actorElevation(state, actorIndex) {
      return state.actorElevation[actorIndex] || 0;
    }

    // -----------------------------------------------------------------------
    // Occupancy grid. Replaces the legacy Set of "x,y,e" template strings
    // (6.4% of solve time + GC pressure) with a stamped Int32Array. The
    // `occupied` parameter is kept as an opaque token for signature
    // compatibility with the ported logic; there is one active grid per
    // move() resolution. Slot layout: (cell * ELEV_SLOTS) + elevation + ELEV_BASE.
    // ELEV_BASE covers legal negative elevations (weightless sub-floor members).
    // -----------------------------------------------------------------------
    // Kept solely as a local map/set key builder for a few cold paths
    // (rider target dedup, cluster position sets) — the per-move occupancy
    // itself lives in the stamped grid below.
    function occupiedElevationKey(x, y, elevation) {
      return `${x},${y},${elevation || 0}`;
    }

    const ELEV_BASE = 2;
    const ELEV_SLOTS = 20;
    const occupancyGrid = new Int32Array(cellCount * ELEV_SLOTS);
    let occupancyStamp = 0;
    const OCCUPANCY_TOKEN = { grid: true };

    function occupancySlot(x, y, elevation) {
      const slot = (elevation | 0) + ELEV_BASE;
      if (slot < 0 || slot >= ELEV_SLOTS || !isInsideBoard(x, y)) {
        return -1;
      }
      return cellIndex(x, y) * ELEV_SLOTS + slot;
    }

    function occupancyRebuild(state, excludedActor = -1, excludedSet = null) {
      occupancyStamp += 1;
      if (occupancyStamp >= 0x3fffff) {
        occupancyGrid.fill(0);
        occupancyStamp = 1;
      }

      for (let index = 0; index < actorCount; index += 1) {
        if (
          index === excludedActor ||
          (excludedSet !== null && excludedSet.has(index)) ||
          state.actorRemoved[index] ||
          isNonBlockingActor(index)
        ) {
          continue;
        }

        const slot = occupancySlot(
          state.actorX[index],
          state.actorY[index],
          state.actorElevation[index] || 0
        );

        if (slot >= 0) {
          occupancyGrid[slot] = (occupancyStamp << 8) | (index + 1);
        }
      }

      return OCCUPANCY_TOKEN;
    }

    function isOccupiedAtElevation(occupied, x, y, elevation) {
      const slot = occupancySlot(x, y, elevation || 0);
      if (slot < 0) return false;
      const value = occupancyGrid[slot];
      return (value >>> 8) === occupancyStamp && (value & 0xff) !== 0;
    }

    function isOccupiedAtElevationByOtherThan(occupied, x, y, elevation, allowedActor) {
      const slot = occupancySlot(x, y, elevation || 0);

      if (slot < 0) {
        return false;
      }

      const value = occupancyGrid[slot];

      if ((value >>> 8) !== occupancyStamp || (value & 0xff) === 0) {
        return false;
      }

      // addOccupiedAtElevation uses 0xff when no actor identity is available;
      // that synthetic occupant must never inherit an actor exemption.
      return (value & 0xff) === 0xff || (value & 0xff) - 1 !== allowedActor;
    }

    function addOccupiedAtElevation(occupied, x, y, elevation) {
      const slot = occupancySlot(x, y, elevation || 0);
      if (slot >= 0) {
        occupancyGrid[slot] = (occupancyStamp << 8) | 0xff;
      }
    }

    function removeOccupiedAtElevation(occupied, x, y, elevation) {
      const slot = occupancySlot(x, y, elevation || 0);
      if (slot >= 0) {
        occupancyGrid[slot] = 0;
      }
    }

    // Lazily-built per-cell "filled" layer variants: what the cell's layers
    // become when its elevation-0 hole is filled by a floating floor (the only
    // terrain mutation in the game).
    const filledLayersCache = new Array(cellCount).fill(null);

    function filledLayersForCell(cell) {
      if (filledLayersCache[cell] === null) {
        filledLayersCache[cell] = (terrainLayers[cell] || [])
          .filter((layer) => !(layer.type === terrainTypes.hole && layer.elevation === 0))
          .concat([
            { type: terrainTypes.floor, elevation: 0, direction: null, raised: false }
          ])
          .sort((left, right) => left.elevation - right.elevation);
      }

      return filledLayersCache[cell];
    }

    function terrainLayersForCell(state, cell) {
      if (state.terrain[cell] !== baseTerrain[cell]) {
        const type = state.terrain[cell];

        if (type === terrainTypes.empty) {
          return [];
        }

        // FIX(SEMANTICS §elevation): a hole fill replaces only the hole layer
        // with floor@0 — every other authored layer survives. Legacy rewrote
        // the whole cell to a single synthetic floor layer, deleting bridges
        // above the hole and leaving actors on them floating.
        if (type === terrainTypes.floor) {
          return filledLayersForCell(cell);
        }

        return [
          {
            type,
            elevation: 0,
            raised: state.liftRaised[cell] === 1
          }
        ];
      }

      return terrainLayers[cell] || [];
    }

    function isOrangeTerrainLayerType(type) {
      return type === terrainTypes.orange_wall || type === terrainTypes.orange_ice_slope;
    }

    function isOrangeTerrainRaisedAtCell(cell, orangeState) {
      if (orangeState instanceof Set) {
        return orangeState.has(cell);
      }

      if (ArrayBuffer.isView(orangeState)) {
        return orangeState[cell] === 1;
      }

      // Backward-compatible boolean contract: true means the buttons are
      // pressed (orange terrain lowered), false means globally raised.
      return orangeState !== true;
    }

    function hasOrangeTerrainLayerAtElevation(state, cell, elevation) {
      return terrainLayersForCell(state, cell).some(
        (candidate) =>
          isOrangeTerrainLayerType(candidate.type) &&
          (candidate.elevation ?? 0) === elevation
      );
    }

    function hasOrangeTerrainLayerBelow(state, cell, layer) {
      const elevation = layer.elevation ?? 0;

      return elevation > 0 && hasOrangeTerrainLayerAtElevation(state, cell, elevation - 1);
    }

    function hasNonOrangeTerrainSupportAtElevation(
      state,
      cell,
      elevation,
      gateState,
      orangeButtonsPressed,
      ignoredLayer = null
    ) {
      return terrainLayersForCell(state, cell).some((candidate) => {
        if (candidate === ignoredLayer || isOrangeTerrainLayerType(candidate.type)) {
          return false;
        }

        return (
          terrainLayerSurfaceHeight(
            state,
            cell,
            candidate,
            gateState,
            orangeButtonsPressed
          ) === elevation
        );
      });
    }

    function shouldLowerPressedOrangeTerrainAsBlock(
      state,
      cell,
      layer,
      gateState,
      orangeButtonsPressed
    ) {
      const elevation = layer.elevation ?? 0;

      return (
        elevation > 0 &&
        (hasOrangeTerrainLayerBelow(state, cell, layer) ||
          !hasNonOrangeTerrainSupportAtElevation(
            state,
            cell,
            elevation,
            gateState,
            orangeButtonsPressed,
            layer
          ))
      );
    }

    function shouldLowerPressedOrangeWallAsBlock(
      state,
      cell,
      layer,
      gateState,
      orangeButtonsPressed
    ) {
      return shouldLowerPressedOrangeTerrainAsBlock(
        state,
        cell,
        layer,
        gateState,
        orangeButtonsPressed
      );
    }

    function shouldLowerPressedOrangeIceSlopeAsSlope(
      state,
      cell,
      layer,
      gateState,
      orangeButtonsPressed
    ) {
      return shouldLowerPressedOrangeTerrainAsBlock(
        state,
        cell,
        layer,
        gateState,
        orangeButtonsPressed
      );
    }

    function pressedOrangeWallLowersAsBlock(state, x, y, elevation) {
      if (!isInsideBoard(x, y)) {
        return false;
      }

      const cell = cellIndex(x, y);
      const gateState = computeRaisedPlayerGateSet(state);
      const orangeState = computeRaisedOrangeTerrainCells(state, gateState);

      if (orangeState.has(cell)) {
        return false;
      }

      const layer = terrainLayersForCell(state, cell).find(
        (candidate) =>
          candidate.type === terrainTypes.orange_wall &&
          (candidate.elevation ?? 0) === elevation
      );

      if (!layer) {
        return false;
      }

      return shouldLowerPressedOrangeWallAsBlock(
        state,
        cell,
        layer,
        gateState,
        orangeState
      );
    }

    function terrainLayerSurfaceHeight(state, cell, layer, gateState, orangeButtonsPressed) {
      if (
        layer.type === terrainTypes.empty ||
        layer.type === terrainTypes.hole ||
        layer.type === terrainTypes.orange_button
      ) {
        return null;
      }

      if (
        layer.type === terrainTypes.wall ||
        layer.type === terrainTypes.ice_block ||
        layer.type === terrainTypes.ice_slope ||
        layer.type === terrainTypes.shrub ||
        layer.type === terrainTypes.block_asset
      ) {
        return layer.elevation + 1;
      }

      if (layer.type === terrainTypes.orange_ice_slope) {
        return isOrangeTerrainRaisedAtCell(cell, orangeButtonsPressed)
          ? layer.elevation + 1
          : layer.elevation;
      }

      if (layer.type === terrainTypes.tree) {
        return layer.elevation + 3;
      }

      if (layer.type === terrainTypes.player_gate) {
        return gateState.has(cell) ? layer.elevation + 1 : layer.elevation;
      }

      if (layer.type === terrainTypes.player_lift) {
        return state.liftRaised[cell] === 1 ? layer.elevation + 1 : layer.elevation;
      }

      if (layer.type === terrainTypes.orange_wall) {
        return isOrangeTerrainRaisedAtCell(cell, orangeButtonsPressed)
          ? layer.elevation + 1
          : layer.elevation;
      }

      return layer.elevation;
    }

    function terrainSurfaceHeightsAt(
      state,
      x,
      y,
      gateState,
      orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState)
    ) {
      if (!isInsideBoard(x, y)) {
        return [];
      }

      const cell = cellIndex(x, y);
      const heights = [];

      terrainLayersForCell(state, cell).forEach((layer) => {
        const height = terrainLayerSurfaceHeight(
          state,
          cell,
          layer,
          gateState,
          orangeButtonsPressed
        );

        if (height !== null) {
          heights.push(height);
        }
      });

      return heights;
    }

    function terrainSurfaceHeightAt(
      state,
      x,
      y,
      gateState,
      orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState)
    ) {
      const heights = terrainSurfaceHeightsAt(state, x, y, gateState, orangeButtonsPressed);

      return heights.length > 0 ? Math.max(...heights) : null;
    }

    function terrainSupportsElevation(
      state,
      x,
      y,
      elevation,
      gateState,
      orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState)
    ) {
      if (!isInsideBoard(x, y)) {
        return false;
      }

      const cell = cellIndex(x, y);
      const layers = terrainLayersForCell(state, cell);

      for (let index = 0; index < layers.length; index += 1) {
        if (
          terrainLayerSurfaceHeight(state, cell, layers[index], gateState, orangeButtonsPressed) ===
          elevation
        ) {
          return true;
        }
      }

      return false;
    }

    function terrainSupportSideBlocksWeightlessEntry(
      state,
      x,
      y,
      elevation,
      gateState,
      orangeButtonsPressed
    ) {
      if (!isInsideBoard(x, y)) {
        return false;
      }

      const cell = cellIndex(x, y);

      return terrainLayersForCell(state, cell).some((layer) => {
        if (!terrainSideBlockingSupportTypes.has(layer.type)) {
          return false;
        }

        const surfaceHeight = terrainLayerSurfaceHeight(
          state,
          cell,
          layer,
          gateState,
          orangeButtonsPressed
        );

        return surfaceHeight !== null && elevation >= surfaceHeight - 1 && elevation < surfaceHeight;
      });
    }

    function terrainLayerOfTypeAtElevation(
      state,
      x,
      y,
      type,
      elevation,
      gateState,
      orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState)
    ) {
      if (!isInsideBoard(x, y)) {
        return null;
      }

      const cell = cellIndex(x, y);

      return (
        terrainLayersForCell(state, cell).find((layer) => {
          if (layer.type !== type) {
            return false;
          }

          if (type === terrainTypes.hole) {
            return layer.elevation === elevation;
          }

          return (
            terrainLayerSurfaceHeight(state, cell, layer, gateState, orangeButtonsPressed) ===
            elevation
          );
        }) || null
      );
    }

    function isEmptyVoidAtElevation(state, x, y, elevation = 0) {
      if (!isInsideBoard(x, y) || elevation !== 0) {
        return false;
      }

      const cell = cellIndex(x, y);
      const layers = terrainLayersForCell(state, cell);

      return !layers.some((layer) => {
        if (layer.type === terrainTypes.hole || layer.type === terrainTypes.orange_button) {
          return false;
        }

        return (
          terrainLayerSurfaceHeight(state, cell, layer, new Set(), false) === elevation ||
          terrainLayerBlocksElevation(state, cell, layer, new Set(), false, elevation)
        );
      });
    }

    function terrainLayersOfType(x, y, type) {
      if (!isInsideBoard(x, y)) {
        return [];
      }

      return terrainLayers[cellIndex(x, y)].filter((layer) => layer.type === type);
    }

    function isIce(state, x, y, elevation = 0, gateState = computeRaisedPlayerGateSet(state), orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState)) {
      return Boolean(
        terrainLayerOfTypeAtElevation(
          state,
          x,
          y,
          terrainTypes.ice,
          elevation,
          gateState,
          orangeButtonsPressed
        ) ||
        terrainLayerOfTypeAtElevation(
          state,
          x,
          y,
          terrainTypes.ice_block,
          elevation,
          gateState,
          orangeButtonsPressed
        )
      );
    }

    function iceSlopeLayersAt(state, x, y, orangeButtonsPressed = false) {
      if (!isInsideBoard(x, y)) {
        return EMPTY_LAYER_LIST;
      }

      const cell = cellIndex(x, y);
      const slopeActor = slopeActorAtCell(state, x, y);

      // Perf: one byte probe short-circuits every slope helper on non-slope
      // cells — the cluster machinery probes five slope traversals per
      // member per step, which on slope-free many-box levels was pure
      // allocation churn.
      if ((!levelHasSlopes || slopeCellMask[cell] === 0) && slopeActor === -1) {
        return EMPTY_LAYER_LIST;
      }

      // Orange ice slopes are ramps while the orange terrain is raised. When
      // the buttons are pressed they lower with the walls: ground-level (or
      // non-orange-supported) wedges flatten, while unsupported elevated
      // wedges remain ramps one elevation lower.
      const layers = [];

      if (levelHasSlopes && slopeCellMask[cell] === 1) {
        let gateState = null;

        terrainLayersForCell(state, cell).forEach((layer) => {
          if (layer.type === terrainTypes.ice_slope) {
            layers.push(layer);
            return;
          }

          if (layer.type !== terrainTypes.orange_ice_slope) {
            return;
          }

          if (isOrangeTerrainRaisedAtCell(cell, orangeButtonsPressed)) {
            layers.push(layer);
            return;
          }

          if ((layer.elevation ?? 0) <= 0) {
            return;
          }

          gateState ||= computeRaisedPlayerGateSet(state);

          if (
            shouldLowerPressedOrangeIceSlopeAsSlope(
              state,
              cell,
              layer,
              gateState,
              orangeButtonsPressed
            )
          ) {
            layers.push({
              ...layer,
              elevation: (layer.elevation ?? 0) - 1
            });
          }
        });
      }

      // Owner rule (2026-07): slope-SHAPED group members (Box/Clone Ice
      // Slopes) act as traversable ice slopes at their current position.
      // Approached along the slope axis they are climbed; approached
      // perpendicular they are ordinary pushable members of their group.
      if (slopeActor !== -1) {
        return layers.concat([
          {
            type: terrainTypes.ice_slope,
            elevation: actorElevation(state, slopeActor),
            direction: actorDirections[slopeActor],
            raised: false,
            slopeActorIndex: slopeActor
          }
        ]);
      }

      return layers;
    }

    function vectorMatches(left, right) {
      return left.dx === right.dx && left.dy === right.dy;
    }

    function iceSlopeTraversalForEntry(
      state,
      slopeX,
      slopeY,
      dx,
      dy,
      elevation,
      orangeButtonsPressed = false
    ) {
      const moveVector = { dx, dy };

      for (const layer of iceSlopeLayersAt(state, slopeX, slopeY, orangeButtonsPressed)) {
        const layerElevation = layer.elevation ?? 0;
        const uphill = puncherDirectionVector(layer.direction);
        const downhill = { dx: -uphill.dx, dy: -uphill.dy };

        if (vectorMatches(moveVector, uphill) && elevation === layerElevation) {
          return {
            entryElevation: elevation,
            exitElevation: layerElevation + 1,
            exitX: slopeX + uphill.dx,
            exitY: slopeY + uphill.dy,
            slopeX,
            slopeY,
            slopeLayer: layer
          };
        }

        if (vectorMatches(moveVector, downhill) && elevation === layerElevation + 1) {
          return {
            entryElevation: elevation,
            exitElevation: layerElevation,
            exitX: slopeX + downhill.dx,
            exitY: slopeY + downhill.dy,
            slopeX,
            slopeY,
            slopeLayer: layer
          };
        }
      }

      return null;
    }

    function iceSlopeTraversalPathPoints(traversal) {
      const isUphill = traversal.exitElevation > traversal.entryElevation;

      return [
        {
          x: traversal.slopeX,
          y: traversal.slopeY,
          elevation: isUphill ? traversal.exitElevation : traversal.entryElevation
        }
      ];
    }

    function iceSlopeExitCenterPoint(traversal) {
      return {
        x: traversal.exitX,
        y: traversal.exitY,
        elevation: traversal.exitElevation
      };
    }

    function iceSlopeSharedEdgePoint(traversal, dx, dy) {
      return {
        x: traversal.exitX - dx * 0.5,
        y: traversal.exitY - dy * 0.5,
        elevation: traversal.exitElevation + ICE_SLOPE_VISUAL_CLEARANCE
      };
    }

    function iceSlopeTopSlideLayersAt(state, x, y, elevation, orangeButtonsPressed = false) {
      return iceSlopeLayersAt(state, x, y, orangeButtonsPressed)
        .filter((layer) => (layer.elevation ?? 0) + 1 === elevation)
        .sort((left, right) => right.elevation - left.elevation);
    }

    function resolveIceSlopeTopSlideTraversal(
      state,
      slopeX,
      slopeY,
      elevation,
      occupied,
      gateState,
      orangeButtonsPressed,
      options = {}
    ) {
      for (const layer of iceSlopeTopSlideLayersAt(state, slopeX, slopeY, elevation, orangeButtonsPressed)) {
        const uphill = puncherDirectionVector(layer.direction);
        const downhill = { dx: -uphill.dx, dy: -uphill.dy };
        let traversal = resolveIceSlopeTraversal(
          state,
          slopeX,
          slopeY,
          downhill.dx,
          downhill.dy,
          elevation,
          occupied,
          gateState,
          orangeButtonsPressed,
          options
        );

        if (!traversal && typeof options.pushSlopeBlocker === "function") {
          const blockedSlope = blockedIceSlopePushForEntry(
            state,
            slopeX,
            slopeY,
            downhill.dx,
            downhill.dy,
            elevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            options.ignoredActors || new Set()
          );

          if (blockedSlope && options.pushSlopeBlocker(blockedSlope.blocker, downhill.dx, downhill.dy)) {
            traversal = resolveIceSlopeTraversal(
              state,
              slopeX,
              slopeY,
              downhill.dx,
              downhill.dy,
              elevation,
              occupied,
              gateState,
              orangeButtonsPressed,
              options
            );
          }
        }

        if (traversal) {
          return traversal;
        }
      }

      return null;
    }

    function samePathPoint(left, right) {
      return (
        left &&
        right &&
        left.x === right.x &&
        left.y === right.y &&
        left.elevation === right.elevation
      );
    }

    function appendPathPoints(path, points) {
      points.forEach((point) => {
        if (!samePathPoint(path[path.length - 1], point)) {
          path.push(point);
        }
      });
    }

    function moveRecordPathPoints(move) {
      if (Array.isArray(move.path) && move.path.length > 0) {
        return move.path
          .map((point) => ({
            x: Number(point.x),
            y: Number(point.y),
            elevation: Number(point.elevation)
          }))
          .filter(
            (point) =>
              Number.isFinite(point.x) &&
              Number.isFinite(point.y) &&
              Number.isFinite(point.elevation)
          );
      }

      return [
        {
          x: move.fromX,
          y: move.fromY,
          elevation: move.fromElevation ?? 0
        },
        {
          x: move.toX,
          y: move.toY,
          elevation: move.toElevation ?? move.fromElevation ?? 0
        }
      ];
    }

    function playerFollowPathForPushedMove(moves, startIndex, actorIndex, dx, dy) {
      const pushedMove = moves
        .slice(startIndex)
        .find((move) => move.actorIndex === actorIndex && !move.visualOnly);

      if (!pushedMove) {
        return null;
      }

      const path = moveRecordPathPoints(pushedMove);

      if (path.length < 2) {
        return null;
      }

      const startElevation = path[0].elevation;
      const movesFlatlyForward = path.every((point, index) => {
        if (point.elevation !== startElevation) {
          return false;
        }

        if (index === 0) {
          return true;
        }

        const previous = path[index - 1];
        return point.x - previous.x === dx && point.y - previous.y === dy;
      });

      if (!movesFlatlyForward) {
        return null;
      }

      return path.map((point) => ({
        x: point.x - dx,
        y: point.y - dy,
        elevation: point.elevation
      }));
    }

    function pushedSupportMembersUnderActors(beforeState, riders, members) {
      return new Set(
        members.filter((member) =>
          riders.some(
            (rider) =>
              beforeState.actorX[member] === beforeState.actorX[rider] &&
              beforeState.actorY[member] === beforeState.actorY[rider] &&
              actorElevation(beforeState, member) + 1 === actorElevation(beforeState, rider)
          )
        )
      );
    }

    function pushedSupportMembersUnderPlayer(beforeState, player, members) {
      return pushedSupportMembersUnderActors(beforeState, [player], members);
    }

    function pushedSupportMovePath(moves, startIndex, supportMembers) {
      for (const member of supportMembers) {
        const supportMove = moves
          .slice(startIndex)
          .find((move) => move.actorIndex === member && !move.visualOnly);

        if (!supportMove) {
          continue;
        }

        const path = moveRecordPathPoints(supportMove);

        if (path.length < 2) {
          continue;
        }

        return path;
      }

      return null;
    }

    function supportRidePathOffsets(moves, startIndex, supportMembers) {
      const path = pushedSupportMovePath(moves, startIndex, supportMembers);

      if (!path) {
        return null;
      }

      const first = path[0];

      return path.map((point) => ({
        dx: point.x - first.x,
        dy: point.y - first.y,
        elevation: point.elevation - first.elevation
      }));
    }

    function playerRidePathForPushedSupport(moves, startIndex, supportMembers) {
      const path = pushedSupportMovePath(moves, startIndex, supportMembers);

      if (!path) {
        return null;
      }

      return path.map((point) => ({
        x: point.x,
        y: point.y,
        elevation: point.elevation + 1
      }));
    }

    function riderPathForSupportMove(supportMove, rider) {
      const supportPath = moveRecordPathPoints(supportMove);
      const first = supportPath[0];

      if (!first) {
        return [];
      }

      return supportPath.map((point) => ({
        x: rider.fromX + (point.x - first.x),
        y: rider.fromY + (point.y - first.y),
        elevation: rider.fromElevation + (point.elevation - first.elevation)
      }));
    }

    function riderStandsOnAttachedDeviceCarriedByMember(
      state,
      rider,
      member,
      gateState
    ) {
      const x = state.actorX[member];
      const y = state.actorY[member];
      const deviceElevation = actorElevation(state, member) + 1;
      const riderElevation = actorElevation(state, rider);

      for (let i = 0; i < attachedLiftIndexes.length; i += 1) {
        const lift = attachedLiftIndexes[i];

        if (
          !state.actorRemoved[lift] &&
          state.actorX[lift] === x &&
          state.actorY[lift] === y &&
          actorElevation(state, lift) === deviceElevation &&
          attachedLiftSurfaceElevation(state, lift) === riderElevation
        ) {
          return true;
        }
      }

      for (let i = 0; i < attachedGateIndexes.length; i += 1) {
        const gate = attachedGateIndexes[i];

        if (
          !state.actorRemoved[gate] &&
          state.actorX[gate] === x &&
          state.actorY[gate] === y &&
          actorElevation(state, gate) === deviceElevation &&
          deviceElevation + (gateState.has(cellIndex(x, y)) ? 1 : 0) === riderElevation
        ) {
          return true;
        }
      }

      return false;
    }

    function cloneRidersForMove(
      state,
      members,
      dx,
      dy,
      gateState,
      orangeButtonsPressed,
      excludedActors = new Set()
    ) {
      const riders = [];
      const memberSet = new Set(members);
      const riderIndexes = new Set();
      const riderCloneGroups = new Set();

      for (const member of members) {
        const supportX = state.actorX[member];
        const supportY = state.actorY[member];
        const supportElevation = actorElevation(state, member);

        for (let actor = 0; actor < actorCount; actor += 1) {
          if (
            riderIndexes.has(actor) ||
            excludedActors.has(actor) ||
            state.actorRemoved[actor] ||
            (!isMainPlayerActor(actor) && !isCloneActor(actor)) ||
            memberSet.has(actor) ||
            state.actorX[actor] !== supportX ||
            state.actorY[actor] !== supportY ||
            (actorElevation(state, actor) !== supportElevation + 1 &&
              !riderStandsOnAttachedDeviceCarriedByMember(
                state,
                actor,
                member,
                gateState
              ))
          ) {
            continue;
          }

          const riderMembers = isCloneActor(actor)
            ? cloneGroupMembers(state, actorGroupIds[actor])
            : [actor];
          const riderGroupKey = isCloneActor(actor) ? actorGroupIds[actor] || "" : null;

          if (
            riderMembers.some((riderMember) => excludedActors.has(riderMember)) ||
            (riderGroupKey !== null && riderCloneGroups.has(riderGroupKey))
          ) {
            continue;
          }

          const ignoredActors = new Set([...memberSet, ...riderMembers]);
          const targetKeys = new Set();
          const canRide = riderMembers.every((riderMember) => {
            const targetX = state.actorX[riderMember] + dx;
            const targetY = state.actorY[riderMember] + dy;
            const targetElevation = actorElevation(state, riderMember);
            const targetKey = occupiedElevationKey(targetX, targetY, targetElevation);

            if (targetKeys.has(targetKey)) {
              return false;
            }

            targetKeys.add(targetKey);

            if (
              !isInsideBoard(targetX, targetY) ||
              terrainBlocksElevation(
                state,
                targetX,
                targetY,
                targetElevation,
                gateState,
                orangeButtonsPressed
              )
            ) {
              return false;
            }

            const blocker = actorAt(
              state,
              targetX,
              targetY,
              (candidate) =>
                !ignoredActors.has(candidate) &&
                !isNonBlockingActor(candidate) &&
                actorElevation(state, candidate) === targetElevation
            );

            return blocker === -1;
          });

          if (!canRide) {
            continue;
          }

          riderMembers.forEach((riderMember) => {
            riders.push({
              actorIndex: riderMember,
              fromElevation: actorElevation(state, riderMember),
              fromX: state.actorX[riderMember],
              fromY: state.actorY[riderMember],
              supportMember: member
            });
            riderIndexes.add(riderMember);
          });

          if (riderGroupKey !== null) {
            riderCloneGroups.add(riderGroupKey);
          }
        }
      }

      return riders;
    }

    function moveCarriedRidersForSupportMoves(
      state,
      carriedRiders,
      moves,
      moveStartIndex,
      occupied,
      gateState,
      orangeButtonsPressed,
      searchMode,
      carriedPlayers
    ) {
      carriedRiders.forEach((rider) => {
        const supportMove = moves
          .slice(moveStartIndex)
          .find((move) => move.actorIndex === rider.supportMember && !move.visualOnly);

        if (!supportMove) {
          addOccupiedAtElevation(occupied, rider.fromX, rider.fromY, rider.fromElevation);
          return;
        }

        const path = riderPathForSupportMove(supportMove, rider);
        let riderValidLength = 1;

        for (let pointIndex = 1; pointIndex < path.length; pointIndex += 1) {
          const point = path[pointIndex];

          if (
            !isInsideBoard(point.x, point.y) ||
            terrainBlocksElevation(
              state,
              point.x,
              point.y,
              point.elevation,
              gateState,
              orangeButtonsPressed
            ) ||
            blockingActorAtElevation(
              state,
              point.x,
              point.y,
              point.elevation,
              rider.actorIndex
            ) !== -1
          ) {
            break;
          }

          riderValidLength = pointIndex + 1;
        }

        if (riderValidLength < path.length) {
          path.length = riderValidLength;
        }

        const finalPoint = path[path.length - 1];
        const toX = finalPoint?.x ?? rider.fromX;
        const toY = finalPoint?.y ?? rider.fromY;
        const toElevation = finalPoint?.elevation ?? rider.fromElevation;
        const moveRecord = {
          actorIndex: rider.actorIndex,
          actorType: actorTypes[rider.actorIndex],
          fromElevation: rider.fromElevation,
          fromX: rider.fromX,
          fromY: rider.fromY,
          toElevation,
          toX,
          toY
        };

        if (path.length > 2 || path.some((point) => point.elevation !== rider.fromElevation)) {
          moveRecord.path = path;
          moveRecord.pathControlsElevation = path.some(
            (point) => point.elevation !== rider.fromElevation
          );
          moveRecord.pathEndElevation = path[path.length - 1]?.elevation ?? toElevation;
        }

        if (!searchMode && supportMove.iceSlide === true) {
          moveRecord.iceSlide = true;
        }

        jSetActorX(state, rider.actorIndex, toX);
        jSetActorY(state, rider.actorIndex, toY);
        jSetActorElevation(state, rider.actorIndex, toElevation);
        moves.push(moveRecord);
        addOccupiedAtElevation(occupied, toX, toY, toElevation);

        if (carriedPlayers instanceof Set) {
          carriedPlayers.add(rider.actorIndex);
        }
      });
    }

    function pathOffsetsForTraversal(traversal, fromX, fromY, fromElevation) {
      return traversal.path.map((point) => ({
        dx: point.x - fromX,
        dy: point.y - fromY,
        elevation: point.elevation - fromElevation
      }));
    }

    function pathOffsetsForPoints(points, fromX, fromY, fromElevation) {
      return points.map((point) => ({
        dx: point.x - fromX,
        dy: point.y - fromY,
        elevation: point.elevation - fromElevation
      }));
    }

    function samePathOffset(left, right) {
      return (
        left &&
        right &&
        left.dx === right.dx &&
        left.dy === right.dy &&
        left.elevation === right.elevation
      );
    }

    function samePathOffsets(left, right) {
      return (
        Array.isArray(left) &&
        Array.isArray(right) &&
        left.length === right.length &&
        left.every((point, index) => samePathOffset(point, right[index]))
      );
    }

    function canTravelThroughSpace(
      state,
      x,
      y,
      occupied,
      gateState,
      orangeButtonsPressed,
      elevation
    ) {
      if (!isInsideBoard(x, y)) {
        return false;
      }

      if (terrainBlocksElevation(state, x, y, elevation, gateState, orangeButtonsPressed)) {
        return false;
      }

      return !isOccupiedAtElevation(occupied, x, y, elevation);
    }

    function isHole(state, x, y, elevation = 0) {
      return (
        isEmptyVoidAtElevation(state, x, y, elevation) ||
        Boolean(
          terrainLayerOfTypeAtElevation(
            state,
            x,
            y,
            terrainTypes.hole,
            elevation,
            new Set(),
            false
          )
        )
      );
    }

    function isTerrainHoleAtElevation(state, x, y, elevation = 0) {
      return Boolean(
        terrainLayerOfTypeAtElevation(
          state,
          x,
          y,
          terrainTypes.hole,
          elevation,
          new Set(),
          false
        )
      );
    }

    function isIceOrHole(state, x, y, elevation = 0, gateState = computeRaisedPlayerGateSet(state), orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState)) {
      return (
        isIce(state, x, y, elevation, gateState, orangeButtonsPressed) ||
        isHole(state, x, y, elevation)
      );
    }

    function isPlayerLift(x, y) {
      return terrainLayersOfType(x, y, terrainTypes.player_lift).length > 0;
    }

    function playerLiftLayerAtElevation(
      state,
      x,
      y,
      elevation,
      gateState,
      orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState)
    ) {
      return terrainLayerOfTypeAtElevation(
        state,
        x,
        y,
        terrainTypes.player_lift,
        elevation,
        gateState,
        orangeButtonsPressed
      );
    }

    function isRaisedPlayerLift(state, x, y) {
      return isPlayerLift(x, y) && state.liftRaised[cellIndex(x, y)] === 1;
    }

    function setPlayerLiftRaised(state, x, y, raised) {
      // Attached lifts share the per-cell raised bit with terrain lifts.
      if (!isPlayerLift(x, y) && attachedLiftIndexAt(state, x, y) === -1) {
        return false;
      }

      jSetLiftRaised(state, cellIndex(x, y), raised ? 1 : 0);
      return state.liftRaised[cellIndex(x, y)] === 1;
    }

    function isOrangeWall(x, y) {
      return terrainLayersOfType(x, y, terrainTypes.orange_wall).length > 0;
    }

    function isOrangeButtonPressed(state, cell, layer) {
      const x = cellX(cell);
      const y = cellY(cell);

      for (let index = 0; index < actorCount; index += 1) {
        if (state.actorRemoved[index] || isNonBlockingActor(index)) {
          continue;
        }

        if (
          state.actorX[index] === x &&
          state.actorY[index] === y &&
          actorElevation(state, index) === layer.elevation
        ) {
          return true;
        }
      }

      return false;
    }

    function isOrangeButtonActorPressed(state, buttonIndex) {
      const x = state.actorX[buttonIndex];
      const y = state.actorY[buttonIndex];
      const elevation = actorElevation(state, buttonIndex);

      for (let index = 0; index < actorCount; index += 1) {
        if (
          index === buttonIndex ||
          state.actorRemoved[index] ||
          isNonBlockingActor(index)
        ) {
          continue;
        }

        if (
          state.actorX[index] === x &&
          state.actorY[index] === y &&
          actorElevation(state, index) === elevation
        ) {
          return true;
        }
      }

      return false;
    }

    function areOrangeButtonsPressed(state) {
      if (orangeButtonCells.length === 0 && orangeButtonActors.length === 0) {
        return false;
      }

      for (let index = 0; index < orangeButtonCells.length; index += 1) {
        const cell = orangeButtonCells[index];
        const buttonLayers = terrainLayersForCell(state, cell).filter(
          (layer) => layer.type === terrainTypes.orange_button
        );

        if (
          buttonLayers.length === 0 ||
          !buttonLayers.every((layer) => isOrangeButtonPressed(state, cell, layer))
        ) {
          return false;
        }
      }

      for (let index = 0; index < orangeButtonActors.length; index += 1) {
        const button = orangeButtonActors[index];

        if (state.actorRemoved[button] || !isOrangeButtonActorPressed(state, button)) {
          return false;
        }
      }

      return true;
    }

    function orangeComponentRideActors(state, component, gateState, raisedOrangeTerrain) {
      const componentCells = new Set(component);
      const riders = new Set();

      function addActorAndRigidGroup(actor) {
        if (riders.has(actor)) {
          return false;
        }

        const members =
          actorTypes[actor] === "weightless_box"
            ? weightlessGroupMembers(state, actorGroupIds[actor])
            : isCloneActor(actor)
              ? cloneGroupMembers(state, actorGroupIds[actor])
              : [actor];
        let changed = false;

        members.forEach((member) => {
          if (!riders.has(member)) {
            riders.add(member);
            changed = true;
          }
        });

        return changed;
      }

      for (let actor = 0; actor < actorCount; actor += 1) {
        if (state.actorRemoved[actor] || isCollectibleActor(actor)) {
          continue;
        }

        const x = state.actorX[actor];
        const y = state.actorY[actor];

        if (!isInsideBoard(x, y)) {
          continue;
        }

        const cell = cellIndex(x, y);

        if (!componentCells.has(cell)) {
          continue;
        }

        const elevation = actorElevation(state, actor);
        const ridesLoweredSurface = terrainLayersForCell(state, cell).some(
          (layer) =>
            isOrangeTerrainLayerType(layer.type) &&
            terrainLayerSurfaceHeight(state, cell, layer, gateState, true) === elevation
        );

        if (ridesLoweredSurface) {
          addActorAndRigidGroup(actor);
        }
      }

      // Carry complete vertical actor stacks. Rigid clone/weightless groups
      // join as a unit when any member is rooted on this orange component.
      let expanded = true;

      while (expanded) {
        expanded = false;

        for (const lower of Array.from(riders)) {
          if (!actorProvidesFlatSupport(lower)) {
            continue;
          }

          for (let upper = 0; upper < actorCount; upper += 1) {
            if (
              upper === lower ||
              riders.has(upper) ||
              state.actorRemoved[upper] ||
              isCollectibleActor(upper) ||
              state.actorX[upper] !== state.actorX[lower] ||
              state.actorY[upper] !== state.actorY[lower] ||
              actorElevation(state, upper) !== actorElevation(state, lower) + 1
            ) {
              continue;
            }

            expanded = addActorAndRigidGroup(upper) || expanded;
          }
        }
      }

      const blockingTargets = new Set();

      for (const rider of riders) {
        const x = state.actorX[rider];
        const y = state.actorY[rider];
        const targetElevation = actorElevation(state, rider) + 1;

        if (
          terrainBlocksElevation(
            state,
            x,
            y,
            targetElevation,
            gateState,
            raisedOrangeTerrain
          )
        ) {
          return null;
        }

        if (!isNonBlockingActor(rider)) {
          const targetKey = occupiedElevationKey(x, y, targetElevation);

          if (blockingTargets.has(targetKey)) {
            return null;
          }

          blockingTargets.add(targetKey);
        }

        for (let blocker = 0; blocker < actorCount; blocker += 1) {
          if (
            blocker === rider ||
            riders.has(blocker) ||
            state.actorRemoved[blocker] ||
            isNonBlockingActor(blocker) ||
            state.actorX[blocker] !== x ||
            state.actorY[blocker] !== y ||
            actorElevation(state, blocker) !== targetElevation
          ) {
            continue;
          }

          return null;
        }
      }

      // No stationary blocking actor may remain inside the component's raised
      // volume. Riders are exempt because they vacate those voxels atomically.
      for (let actor = 0; actor < actorCount; actor += 1) {
        if (
          riders.has(actor) ||
          state.actorRemoved[actor] ||
          isNonBlockingActor(actor) ||
          !isInsideBoard(state.actorX[actor], state.actorY[actor])
        ) {
          continue;
        }

        const cell = cellIndex(state.actorX[actor], state.actorY[actor]);

        if (
          componentCells.has(cell) &&
          terrainBlocksElevation(
            state,
            state.actorX[actor],
            state.actorY[actor],
            actorElevation(state, actor),
            gateState,
            raisedOrangeTerrain
          )
        ) {
          return null;
        }
      }

      return riders;
    }

    function computeRaisedOrangeTerrainCells(
      state,
      gateState = computeRaisedPlayerGateSet(state),
      buttonsPressed = areOrangeButtonsPressed(state)
    ) {
      const raised = new Set();

      if (buttonsPressed) {
        return raised;
      }

      for (const component of orangeTerrainComponents) {
        const candidateRaised = new Set(raised);
        component.forEach((cell) => candidateRaised.add(cell));

        if (orangeComponentRideActors(state, component, gateState, candidateRaised) !== null) {
          component.forEach((cell) => raised.add(cell));
        }
      }

      return raised;
    }

    function raisedOrangeWallKeys(state) {
      const raised = computeRaisedOrangeTerrainCells(state);

      return orangeTerrainCells
        .filter((cell) => raised.has(cell))
        .map((cell) => `${cell % width},${Math.floor(cell / width)}`);
    }

    function isRaisedOrangeWall(x, y, orangeButtonsPressed) {
      return (
        isOrangeWall(x, y) &&
        isOrangeTerrainRaisedAtCell(cellIndex(x, y), orangeButtonsPressed)
      );
    }

    function attachedLiftIndexAt(state, x, y) {
      for (let i = 0; i < attachedLiftIndexes.length; i += 1) {
        const index = attachedLiftIndexes[i];

        if (
          !state.actorRemoved[index] &&
          state.actorX[index] === x &&
          state.actorY[index] === y
        ) {
          return index;
        }
      }

      return -1;
    }

    // Flush-surface rule: an attached lift's standing surface is AT its
    // elevation (carrier top) when lowered and one above when raised.
    function attachedLiftSurfaceElevation(state, index) {
      const cell = cellIndex(state.actorX[index], state.actorY[index]);

      return (
        (state.actorElevation[index] || 0) + (state.liftRaised[cell] === 1 ? 1 : 0)
      );
    }

    // Raised attached devices block like their terrain twins: the lift's
    // body fills the band it rose out of; a proximity-raised gate fills the
    // band above the carrier top. Lowered they are flush plates and block
    // nothing.
    function attachedDeviceBlocksElevation(state, x, y, elevation, gateState) {
      for (let i = 0; i < attachedLiftIndexes.length; i += 1) {
        const index = attachedLiftIndexes[i];

        if (
          !state.actorRemoved[index] &&
          state.actorX[index] === x &&
          state.actorY[index] === y &&
          (state.actorElevation[index] || 0) === elevation &&
          state.liftRaised[cellIndex(x, y)] === 1
        ) {
          return true;
        }
      }

      for (let i = 0; i < attachedGateIndexes.length; i += 1) {
        const index = attachedGateIndexes[i];

        if (
          !state.actorRemoved[index] &&
          state.actorX[index] === x &&
          state.actorY[index] === y &&
          (state.actorElevation[index] || 0) === elevation &&
          gateState.has(cellIndex(x, y))
        ) {
          return true;
        }
      }

      return false;
    }

    function raisedAttachedDeviceCarrierAt(state, x, y, elevation, gateState) {
      let hasRaisedDevice = false;

      for (let i = 0; i < attachedLiftIndexes.length; i += 1) {
        const lift = attachedLiftIndexes[i];

        if (
          !state.actorRemoved[lift] &&
          state.actorX[lift] === x &&
          state.actorY[lift] === y &&
          actorElevation(state, lift) === elevation &&
          state.liftRaised[cellIndex(x, y)] === 1
        ) {
          hasRaisedDevice = true;
          break;
        }
      }

      if (!hasRaisedDevice) {
        for (let i = 0; i < attachedGateIndexes.length; i += 1) {
          const gate = attachedGateIndexes[i];

          if (
            !state.actorRemoved[gate] &&
            state.actorX[gate] === x &&
            state.actorY[gate] === y &&
            actorElevation(state, gate) === elevation &&
            gateState.has(cellIndex(x, y))
          ) {
            hasRaisedDevice = true;
            break;
          }
        }
      }

      if (!hasRaisedDevice) {
        return -1;
      }

      return actorAt(
        state,
        x,
        y,
        (actor) =>
          isPushableActor(actor) &&
          canActorCarrySurfaceAttachment(actorTypes[actor]) &&
          actorElevation(state, actor) + 1 === elevation
      );
    }

    function isPlayerGate(x, y) {
      return terrainLayersOfType(x, y, terrainTypes.player_gate).length > 0;
    }

    function isRaisedPlayerGate(x, y, gateState) {
      return isPlayerGate(x, y) && gateState.has(cellIndex(x, y));
    }

    function isTerrainWall(state, x, y) {
      if (!isInsideBoard(x, y)) {
        return false;
      }

      return terrainLayersForCell(state, cellIndex(x, y)).some(
        (layer) =>
          layer.type === terrainTypes.wall ||
          layer.type === terrainTypes.ice_block ||
          layer.type === terrainTypes.ice_slope ||
          layer.type === terrainTypes.orange_ice_slope ||
          layer.type === terrainTypes.tree ||
          layer.type === terrainTypes.shrub ||
          layer.type === terrainTypes.block_asset
      );
    }

    function isWall(state, x, y, gateState, orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState), elevation = 0) {
      const height = terrainSurfaceHeightAt(state, x, y, gateState, orangeButtonsPressed);

      return height !== null && height > elevation;
    }

    function terrainLayerBlocksElevation(
      state,
      cell,
      layer,
      gateState,
      orangeButtonsPressed,
      elevation
    ) {
      const layerElevation = layer.elevation ?? 0;

      if (
        layer.type === terrainTypes.wall ||
        layer.type === terrainTypes.ice_block ||
        layer.type === terrainTypes.block_asset
      ) {
        return layerElevation === elevation;
      }

      if (layer.type === terrainTypes.ice_slope) {
        return elevation === layerElevation || elevation === layerElevation + 1;
      }

      if (layer.type === terrainTypes.orange_ice_slope) {
        if (isOrangeTerrainRaisedAtCell(cell, orangeButtonsPressed)) {
          return elevation === layerElevation || elevation === layerElevation + 1;
        }

        if (
          !shouldLowerPressedOrangeIceSlopeAsSlope(
            state,
            cell,
            layer,
            gateState,
            orangeButtonsPressed
          )
        ) {
          return false;
        }

        const loweredElevation = layerElevation - 1;
        return elevation === loweredElevation || elevation === loweredElevation + 1;
      }

      if (layer.type === terrainTypes.shrub) {
        return elevation >= layerElevation && elevation <= layerElevation + 1;
      }

      if (layer.type === terrainTypes.tree) {
        return elevation >= layerElevation && elevation < layerElevation + 3;
      }

      if (layer.type === terrainTypes.player_gate) {
        return gateState.has(cell) && layerElevation === elevation;
      }

      if (layer.type === terrainTypes.player_lift) {
        return state.liftRaised[cell] === 1 && layerElevation === elevation;
      }

      if (layer.type === terrainTypes.orange_wall) {
        if (isOrangeTerrainRaisedAtCell(cell, orangeButtonsPressed)) {
          return layerElevation === elevation;
        }

        return shouldLowerPressedOrangeWallAsBlock(
          state,
          cell,
          layer,
          gateState,
          orangeButtonsPressed
        ) && layerElevation - 1 === elevation;
      }

      return false;
    }

    function terrainBlocksElevation(
      state,
      x,
      y,
      elevation,
      gateState,
      orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState)
    ) {
      if (!isInsideBoard(x, y)) {
        return true;
      }

      const cell = cellIndex(x, y);

      if (
        terrainLayersForCell(state, cell).some((layer) =>
          terrainLayerBlocksElevation(
            state,
            cell,
            layer,
            gateState,
            orangeButtonsPressed,
            elevation
          )
        )
      ) {
        return true;
      }

      return (
        levelHasAttachedDevices &&
        attachedDeviceBlocksElevation(state, x, y, elevation, gateState)
      );
    }

    function terrainBlockingLayersAtElevation(
      state,
      x,
      y,
      elevation,
      gateState,
      orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState)
    ) {
      if (!isInsideBoard(x, y)) {
        return [];
      }

      const cell = cellIndex(x, y);

      return terrainLayersForCell(state, cell).filter((layer) =>
        terrainLayerBlocksElevation(
          state,
          cell,
          layer,
          gateState,
          orangeButtonsPressed,
          elevation
        )
      );
    }

    function terrainBlocksOnlyByIceSlope(
      state,
      x,
      y,
      elevation,
      gateState,
      orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState)
    ) {
      const blockers = terrainBlockingLayersAtElevation(
        state,
        x,
        y,
        elevation,
        gateState,
        orangeButtonsPressed
      );

      return (
        blockers.length > 0 &&
        blockers.every(
          (layer) =>
            layer.type === terrainTypes.ice_slope ||
            layer.type === terrainTypes.orange_ice_slope
        )
      );
    }

    function actorSupportSurfaceHeightsAt(
      state,
      x,
      y,
      ignoredActors = null,
      includePlayers = false,
      gateState = null
    ) {
      const heights = [];
      let resolvedGateState = gateState;

      for (let index = 0; index < actorCount; index += 1) {
        if (state.actorRemoved[index]) {
          continue;
        }

        if (ignoredActors?.has(index)) {
          continue;
        }

        if (state.actorX[index] !== x || state.actorY[index] !== y) {
          continue;
        }

        if (actorTypes[index] === "attached_lift") {
          heights.push(attachedLiftSurfaceElevation(state, index));
          continue;
        }

        if (actorTypes[index] === "attached_gate") {
          resolvedGateState ||= computeRaisedPlayerGateSet(state);
          heights.push(
            actorElevation(state, index) +
              (resolvedGateState.has(cellIndex(x, y)) ? 1 : 0)
          );
          continue;
        }

        if (!actorProvidesFlatSupport(index)) {
          continue;
        }

        if (!includePlayers && isMainPlayerActor(index)) {
          continue;
        }

        heights.push(actorElevation(state, index) + 1);
      }

      return heights;
    }

    function actorSupportsElevation(
      state,
      x,
      y,
      elevation,
      ignoredActors = null,
      includePlayers = false,
      gateState = null
    ) {
      return actorSupportSurfaceHeightsAt(
        state,
        x,
        y,
        ignoredActors,
        includePlayers,
        gateState
      ).includes(elevation);
    }

    // Allocation-free single-exclusion variant for hot pass loops.
    function actorSupportsElevationExcluding(
      state,
      x,
      y,
      elevation,
      excludedIndex,
      includePlayers,
      gateState = null
    ) {
      let resolvedGateState = gateState;

      for (let index = 0; index < actorCount; index += 1) {
        if (
          index === excludedIndex ||
          state.actorRemoved[index] ||
          state.actorX[index] !== x ||
          state.actorY[index] !== y
        ) {
          continue;
        }

        if (actorTypes[index] === "attached_lift") {
          if (attachedLiftSurfaceElevation(state, index) === elevation) {
            return true;
          }

          continue;
        }

        if (actorTypes[index] === "attached_gate") {
          resolvedGateState ||= computeRaisedPlayerGateSet(state);

          if (
            actorElevation(state, index) +
              (resolvedGateState.has(cellIndex(x, y)) ? 1 : 0) ===
            elevation
          ) {
            return true;
          }

          continue;
        }

        if (
          !actorProvidesFlatSupport(index) ||
          (!includePlayers && isMainPlayerActor(index))
        ) {
          continue;
        }

        if ((state.actorElevation[index] || 0) + 1 === elevation) {
          return true;
        }
      }

      return false;
    }

    function surfaceSupportsElevation(
      state,
      x,
      y,
      elevation,
      gateState,
      orangeButtonsPressed,
      ignoredActors = null,
      includePlayers = false
    ) {
      return (
        terrainSupportsElevation(state, x, y, elevation, gateState, orangeButtonsPressed) ||
        actorSupportsElevation(
          state,
          x,
          y,
          elevation,
          ignoredActors,
          includePlayers,
          gateState
        )
      );
    }

    function canPlayerStandAtElevation(
      state,
      x,
      y,
      elevation,
      gateState,
      orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState),
      ignoredActors = null
    ) {
      if (terrainBlocksElevation(state, x, y, elevation, gateState, orangeButtonsPressed)) {
        return false;
      }

      return (
        surfaceSupportsElevation(
          state,
          x,
          y,
          elevation,
          gateState,
          orangeButtonsPressed,
          ignoredActors,
          false
        )
      );
    }

    function landingElevationAtLocation(
      state,
      x,
      y,
      elevation,
      occupied,
      gateState,
      orangeButtonsPressed,
      ignoredActors = null,
      includePlayerSupport = true
    ) {
      if (
        canMoveIntoAtElevation(
          state,
          x,
          y,
          occupied,
          gateState,
          orangeButtonsPressed,
          elevation
        )
      ) {
        return elevation;
      }

      if (
        !isInsideBoard(x, y) ||
        terrainBlocksElevation(state, x, y, elevation, gateState, orangeButtonsPressed) ||
        isOccupiedAtElevation(occupied, x, y, elevation)
      ) {
        return null;
      }

      const supportHeights = terrainSurfaceHeightsAt(
        state,
        x,
        y,
        gateState,
        orangeButtonsPressed
      )
        .concat(actorSupportSurfaceHeightsAt(state, x, y, ignoredActors, includePlayerSupport))
        // canMoveIntoAtElevation above recognizes same-height terrain
        // support, but actor support lives outside that helper. Keep an
        // actor surface at the current elevation eligible as a landing too;
        // otherwise a punch/ice continuation that stops on top of a box is
        // incorrectly dropped through it to the next terrain surface.
        .filter((height) => height <= elevation)
        .sort((left, right) => right - left);

      return supportHeights.find(
        (height) =>
          !terrainBlocksElevation(state, x, y, height, gateState, orangeButtonsPressed) &&
          !isOccupiedAtElevation(occupied, x, y, height)
      ) ?? null;
    }

    function lacksLandingSupportAtOrBelowLocation(
      state,
      x,
      y,
      elevation,
      gateState,
      orangeButtonsPressed,
      ignoredActors
    ) {
      const supportHeights = terrainSurfaceHeightsAt(
        state,
        x,
        y,
        gateState,
        orangeButtonsPressed
      ).concat(actorSupportSurfaceHeightsAt(state, x, y, ignoredActors, true));

      return !supportHeights.some((height) => height <= elevation);
    }

    function playerIceSlipLanding(
      state,
      player,
      fromX,
      fromY,
      targetX,
      targetY,
      elevation,
      occupied,
      gateState,
      orangeButtonsPressed
    ) {
      const ignoredActors = new Set([player]);

      if (
        !isInsideBoard(targetX, targetY) ||
        terrainBlocksElevation(state, targetX, targetY, elevation, gateState, orangeButtonsPressed) ||
        blockingActorAtElevation(state, targetX, targetY, elevation, player) !== -1
      ) {
        return null;
      }

      if (!isIce(state, fromX, fromY, elevation, gateState, orangeButtonsPressed)) {
        return null;
      }

      const slopeFall = iceSlopeFallTraversal(
        state,
        targetX,
        targetY,
        elevation,
        occupied,
        gateState,
        orangeButtonsPressed
      );

      if (slopeFall) {
        return {
          path: slopeFall.path,
          slopeSlide: true,
          toElevation: slopeFall.exitElevation,
          toX: slopeFall.exitX,
          toY: slopeFall.exitY
        };
      }

      const supportHeights = terrainSurfaceHeightsAt(
        state,
        targetX,
        targetY,
        gateState,
        orangeButtonsPressed
      )
        .concat(actorSupportSurfaceHeightsAt(state, targetX, targetY, ignoredActors, true))
        .filter((height) => height < elevation)
        .sort((left, right) => right - left);
      const landingElevation = supportHeights.find(
        (height) =>
          !terrainBlocksElevation(state, targetX, targetY, height, gateState, orangeButtonsPressed) &&
          blockingActorAtElevation(state, targetX, targetY, height, player) === -1
      );

      if (landingElevation === undefined && supportHeights.length > 0) {
        return null;
      }

      return {
        toElevation: landingElevation ?? elevation
      };
    }

    function weightlessGroupSupportedElevation(state, members, gateState, orangeButtonsPressed) {
      const memberStamp = markActorList(members);
      buildActorSupportTopGrid(state);
      let baseElevation = 0;

      for (let i = 0; i < members.length; i += 1) {
        const member = members[i];
        const currentElevation = actorElevation(state, member);
        const relativeElevation = weightlessRelativeElevations[member] || 0;
        let best = maxSupportHeightAtOrBelow(
          state,
          state.actorX[member],
          state.actorY[member],
          currentElevation + 1,
          memberStamp,
          true,
          gateState,
          orangeButtonsPressed
        );

        for (let gateOffset = 0; gateOffset < attachedGateIndexes.length; gateOffset += 1) {
          const gateIndex = attachedGateIndexes[gateOffset];

          if (
            state.actorRemoved[gateIndex] ||
            state.actorX[gateIndex] !== state.actorX[member] ||
            state.actorY[gateIndex] !== state.actorY[member]
          ) {
            continue;
          }

          const gateSurface =
            actorElevation(state, gateIndex) +
            (gateState.has(cellIndex(state.actorX[member], state.actorY[member])) ? 1 : 0);

          if (gateSurface <= currentElevation + 1) {
            best = Math.max(best, gateSurface);
          }
        }

        if (best !== -Infinity && best - relativeElevation > baseElevation) {
          baseElevation = best - relativeElevation;
        }
      }

      return Math.max(0, baseElevation);
    }

    function weightlessGroupCurrentBaseElevation(state, groupId) {
      const members = weightlessGroupMembers(state, groupId);
      let baseElevation = Infinity;

      members.forEach((member) => {
        baseElevation = Math.min(
          baseElevation,
          actorElevation(state, member) - (weightlessRelativeElevations[member] || 0)
        );
      });

      return Number.isFinite(baseElevation) ? baseElevation : 0;
    }

    function weightlessComponentSupportedElevation(state, groupIds, gateState, orangeButtonsPressed) {
      const members = weightlessClusterMembers(state, groupIds);
      const memberSet = new Set(members);
      const groupBaseElevations = new Map();
      let componentCurrentBase = Infinity;

      groupIds.forEach((groupId) => {
        const groupBase = weightlessGroupCurrentBaseElevation(state, groupId);
        groupBaseElevations.set(groupId, groupBase);
        componentCurrentBase = Math.min(componentCurrentBase, groupBase);
      });

      if (!Number.isFinite(componentCurrentBase)) {
        componentCurrentBase = 0;
      }

      const groupBaseOffsets = new Map();
      groupIds.forEach((groupId) => {
        groupBaseOffsets.set(groupId, groupBaseElevations.get(groupId) - componentCurrentBase);
      });

      let baseElevation = -Infinity;
      const memberStamp = markActorList(members);
      buildActorSupportTopGrid(state);

      for (let i = 0; i < members.length; i += 1) {
        const member = members[i];
        const currentElevation = actorElevation(state, member);
        const relativeElevation =
          (groupBaseOffsets.get(actorGroupIds[member]) ?? 0) +
          (weightlessRelativeElevations[member] || 0);
        const best = maxSupportHeightAtOrBelow(
          state,
          state.actorX[member],
          state.actorY[member],
          currentElevation + 1,
          memberStamp,
          true,
          gateState,
          orangeButtonsPressed
        );

        if (best !== -Infinity && best - relativeElevation > baseElevation) {
          baseElevation = best - relativeElevation;
        }
      }

      return {
        baseElevation: Number.isFinite(baseElevation) ? baseElevation : componentCurrentBase,
        groupBaseOffsets,
        memberSet,
        members
      };
    }

    function cloneGroupCurrentBaseElevation(state, groupId) {
      const members = cloneGroupMembers(state, groupId);
      let baseElevation = Infinity;

      members.forEach((member) => {
        baseElevation = Math.min(baseElevation, actorElevation(state, member));
      });

      return Number.isFinite(baseElevation) ? baseElevation : 0;
    }

    function cloneGroupSupportedElevation(state, groupId, gateState, orangeButtonsPressed) {
      const members = cloneGroupMembers(state, groupId);
      const memberSet = new Set(members);
      const currentBaseElevation = cloneGroupCurrentBaseElevation(state, groupId);
      let baseElevation = -Infinity;
      const memberStamp = markActorList(members);
      buildActorSupportTopGrid(state);

      for (let i = 0; i < members.length; i += 1) {
        const member = members[i];
        const currentElevation = actorElevation(state, member);
        const relativeElevation = currentElevation - currentBaseElevation;
        let best = maxSupportHeightAtOrBelow(
          state,
          state.actorX[member],
          state.actorY[member],
          currentElevation + 1,
          memberStamp,
          true,
          gateState,
          orangeButtonsPressed
        );

        for (let liftOffset = 0; liftOffset < attachedLiftIndexes.length; liftOffset += 1) {
          const liftIndex = attachedLiftIndexes[liftOffset];

          if (
            state.actorRemoved[liftIndex] ||
            state.actorX[liftIndex] !== state.actorX[member] ||
            state.actorY[liftIndex] !== state.actorY[member] ||
            members.some(
              (candidate) =>
                state.actorX[candidate] === state.actorX[liftIndex] &&
                state.actorY[candidate] === state.actorY[liftIndex] &&
                actorElevation(state, candidate) + 1 === actorElevation(state, liftIndex)
            )
          ) {
            continue;
          }

          const liftSurface = attachedLiftSurfaceElevation(state, liftIndex);

          if (liftSurface <= currentElevation + 1) {
            best = Math.max(best, liftSurface);
          }
        }

        for (let gateOffset = 0; gateOffset < attachedGateIndexes.length; gateOffset += 1) {
          const gateIndex = attachedGateIndexes[gateOffset];

          if (
            state.actorRemoved[gateIndex] ||
            state.actorX[gateIndex] !== state.actorX[member] ||
            state.actorY[gateIndex] !== state.actorY[member]
          ) {
            continue;
          }

          const gateSurface =
            actorElevation(state, gateIndex) +
            (gateState.has(cellIndex(state.actorX[member], state.actorY[member])) ? 1 : 0);

          if (gateSurface <= currentElevation + 1) {
            best = Math.max(best, gateSurface);
          }
        }

        if (best !== -Infinity && best - relativeElevation > baseElevation) {
          baseElevation = best - relativeElevation;
        }
      }

      return {
        baseElevation: Number.isFinite(baseElevation) ? baseElevation : currentBaseElevation,
        currentBaseElevation,
        memberSet,
        members
      };
    }

    function playerSurfaceHeightAt(
      state,
      x,
      y,
      gateState,
      orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState),
      currentElevation = null,
      ignoredActors = null
    ) {
      if (
        Number.isInteger(currentElevation) &&
        canPlayerStandAtElevation(
          state,
          x,
          y,
          currentElevation,
          gateState,
          orangeButtonsPressed
        )
      ) {
        return currentElevation;
      }

      const heights = terrainSurfaceHeightsAt(state, x, y, gateState, orangeButtonsPressed).concat(
        actorSupportSurfaceHeightsAt(state, x, y, ignoredActors, false, gateState)
      );

      // FIX(SEMANTICS R2): with a known travel elevation, the endpoint snap
      // never moves the player UP — legacy took Math.max of every surface in
      // the cell, teleporting a player exiting a slope at elevation 1 onto a
      // bridge top at elevation 3, through solid blocks and with no
      // reachability check. Spawn placement (currentElevation=null) keeps the
      // legacy max-surface behavior.
      const candidates = Number.isInteger(currentElevation)
        ? heights.filter((height) => height <= currentElevation)
        : heights;

      return candidates.length > 0 ? Math.max(...candidates) : null;
    }

    const EMPTY_GATE_SET = new Set();

    function computeRaisedPlayerGateSet(state) {
      if (playerGateCells.length === 0 && attachedGateIndexes.length === 0) {
        return EMPTY_GATE_SET;
      }

      const players = [];
      const raised = new Set();

      for (let index = 0; index < actorCount; index += 1) {
        if (state.actorRemoved[index]) {
          continue;
        }

        if (isPlayerActor(index)) {
          players.push(index);
        }
      }

      playerGateCells.forEach((gateCell) => {
        const x = cellX(gateCell);
        const y = cellY(gateCell);
        const gateLayers = terrainLayersForCell(state, gateCell).filter(
          (layer) => layer.type === terrainTypes.player_gate
        );

        for (const gateLayer of gateLayers) {
          const gateElevation = gateLayer.elevation ?? 0;
          const sameLevelBlockOnGate =
            actorAt(
              state,
              x,
              y,
              (actor) =>
                !isPlayerActor(actor) &&
                !isNonBlockingActor(actor) &&
                actorElevation(state, actor) === gateElevation
            ) !== -1;

          if (
            players.some(
              (player) => {
                const playerElevation = actorElevation(state, player);
                const xyDistance = Math.abs(state.actorX[player] - x) + Math.abs(state.actorY[player] - y);
                const standingOnGate = xyDistance === 0 && playerElevation === gateElevation;

                return (
                  xyDistance <= 1 &&
                  !standingOnGate &&
                  (playerElevation !== gateElevation || !sameLevelBlockOnGate)
                );
              }
            )
          ) {
            raised.add(gateCell);
            return;
          }
        }
      });

      // Attached gates share the raised-cell set, keyed by their current
      // cell, using the same proximity rule at the carrier-top elevation.
      for (let i = 0; i < attachedGateIndexes.length; i += 1) {
        const gateIndex = attachedGateIndexes[i];

        if (state.actorRemoved[gateIndex]) {
          continue;
        }

        const x = state.actorX[gateIndex];
        const y = state.actorY[gateIndex];
        const gateElevation = actorElevation(state, gateIndex);
        const sameLevelBlockOnGate =
          actorAt(
            state,
            x,
            y,
            (actor) =>
              !isPlayerActor(actor) &&
              !isNonBlockingActor(actor) &&
              actorElevation(state, actor) === gateElevation
          ) !== -1;

        if (
          players.some((player) => {
            const playerElevation = actorElevation(state, player);
            const xyDistance =
              Math.abs(state.actorX[player] - x) + Math.abs(state.actorY[player] - y);
            const standingOnGate = xyDistance === 0 && playerElevation === gateElevation;

            return (
              standingOnGate ||
              (xyDistance <= 1 &&
                (playerElevation !== gateElevation || !sameLevelBlockOnGate))
            );
          })
        ) {
          raised.add(cellIndex(x, y));
        }
      }

      return raised;
    }

    function buildOccupiedMap(state, excludedActor = -1) {
      return occupancyRebuild(state, excludedActor);
    }

    function actorAt(state, x, y, predicate = null) {
      for (let index = 0; index < actorCount; index += 1) {
        if (state.actorRemoved[index]) {
          continue;
        }

        if (state.actorX[index] !== x || state.actorY[index] !== y) {
          continue;
        }

        if (!predicate || predicate(index)) {
          return index;
        }
      }

      return -1;
    }

    function actorsAt(state, x, y, predicate = null) {
      const matches = [];

      for (let index = 0; index < actorCount; index += 1) {
        if (state.actorRemoved[index]) {
          continue;
        }

        if (state.actorX[index] !== x || state.actorY[index] !== y) {
          continue;
        }

        if (!predicate || predicate(index)) {
          matches.push(index);
        }
      }

      return matches;
    }

    function pushEntityKey(actorIndex) {
      if (actorTypes[actorIndex] === "weightless_box") {
        return `weightless:${actorGroupIds[actorIndex]}`;
      }

      if (isCloneActor(actorIndex)) {
        return `clone:${actorGroupIds[actorIndex] || ""}`;
      }

      return `actor:${actorIndex}`;
    }

    function pushActorMembers(state, actorIndex) {
      if (actorTypes[actorIndex] === "weightless_box") {
        return weightlessGroupMembers(state, actorGroupIds[actorIndex]);
      }

      if (isCloneActor(actorIndex)) {
        return cloneGroupMembers(state, actorGroupIds[actorIndex]);
      }

      return [actorIndex];
    }

    function liveMembersFromCache(state, cached, members) {
      if (!cached) {
        return members;
      }

      for (let i = 0; i < cached.length; i += 1) {
        if (!state.actorRemoved[cached[i]]) {
          members.push(cached[i]);
        }
      }

      return members;
    }

    function cloneGroupMembers(state, groupId) {
      return liveMembersFromCache(state, cloneMembersByGroup.get(groupId || ""), []);
    }

    function weightlessGroupMembers(state, groupId, actorType = "weightless_box") {
      const cache =
        actorType === "weightless_box"
          ? weightlessMembersByGroup.get(groupId)
          : actorType === "clone"
            ? cloneMembersByGroup.get(groupId || "")
            : null;

      if (cache) {
        return liveMembersFromCache(state, cache, []);
      }

      const members = [];

      for (let index = 0; index < actorCount; index += 1) {
        if (
          !state.actorRemoved[index] &&
          actorTypes[index] === actorType &&
          actorGroupIds[index] === groupId
        ) {
          members.push(index);
        }
      }

      return members;
    }

    function weightlessClusterMembers(state, groupIds, actorType = "weightless_box") {
      const members = [];

      for (const groupId of groupIds) {
        const cache =
          actorType === "weightless_box"
            ? weightlessMembersByGroup.get(groupId)
            : actorType === "clone"
              ? cloneMembersByGroup.get(groupId || "")
              : null;

        if (cache) {
          liveMembersFromCache(state, cache, members);
        } else {
          for (let index = 0; index < actorCount; index += 1) {
            if (
              !state.actorRemoved[index] &&
              actorTypes[index] === actorType &&
              actorGroupIds[index] === groupId
            ) {
              members.push(index);
            }
          }
        }
      }

      // Legacy scanned all actors in index order across the whole group set;
      // record ordering downstream depends on it.
      members.sort((left, right) => left - right);

      return members;
    }

    function weightlessActorsVerticallyTouch(state, left, right) {
      return (
        state.actorX[left] === state.actorX[right] &&
        state.actorY[left] === state.actorY[right] &&
        Math.abs(actorElevation(state, left) - actorElevation(state, right)) === 1
      );
    }

    function weightlessVerticalSupportComponentGroupIds(state, startGroupId) {
      // O(members) BFS over a stamped position grid — the legacy fixpoint
      // loop compared every component member against every other weightless
      // actor per round (quadratic in the 200-box levels).
      const componentGroupIds = new Set([startGroupId]);
      const queue = weightlessGroupMembers(state, startGroupId);

      if (queue.length === 0) {
        return componentGroupIds;
      }

      buildWeightlessPositionGrid(state);

      for (let head = 0; head < queue.length; head += 1) {
        const member = queue[head];
        const x = state.actorX[member];
        const y = state.actorY[member];
        const elevation = actorElevation(state, member);

        for (let delta = -1; delta <= 1; delta += 2) {
          const neighbor = weightlessActorAtSlot(x, y, elevation + delta);

          if (neighbor === -1) {
            continue;
          }

          const neighborGroup = actorGroupIds[neighbor];

          if (!componentGroupIds.has(neighborGroup)) {
            componentGroupIds.add(neighborGroup);
            liveMembersFromCache(state, weightlessMembersByGroup.get(neighborGroup), queue);
          }
        }
      }

      return componentGroupIds;
    }

    // Support-change cell mask: per sync iteration, the cells where a
    // support-relevant change happened this move (endpoints of support-actor
    // moves). Group settles are skipped for groups whose columns saw no
    // change — the settle is idempotent for them by construction. A skipped
    // group still joins a touched neighbor's component via the BFS, so
    // stacked structures stay correct.
    const supportChangeCellStamp = new Int32Array(cellCount);
    let supportChangeCounter = 0;

    function stampSupportChangeCells(moves) {
      supportChangeCounter += 1;

      if (supportChangeCounter >= 0x7ffffff0) {
        supportChangeCellStamp.fill(0);
        supportChangeCounter = 1;
      }

      for (let i = 0; i < moves.length; i += 1) {
        const move = moves[i];

        if (move.visualOnly || !isSupportActorType(move.actorType)) {
          continue;
        }

        if (isInsideBoard(move.fromX, move.fromY)) {
          supportChangeCellStamp[cellIndex(move.fromX, move.fromY)] = supportChangeCounter;
        }

        if (isInsideBoard(move.toX, move.toY)) {
          supportChangeCellStamp[cellIndex(move.toX, move.toY)] = supportChangeCounter;
        }
      }

      return supportChangeCounter;
    }

    function groupTouchesChangedCells(state, cached, stamp) {
      if (!cached) {
        return true;
      }

      for (let i = 0; i < cached.length; i += 1) {
        const index = cached[i];

        if (state.actorRemoved[index]) {
          continue;
        }

        if (
          supportChangeCellStamp[cellIndex(state.actorX[index], state.actorY[index])] === stamp
        ) {
          return true;
        }
      }

      return false;
    }

    function gateSetsDiffer(left, right) {
      if (left === right) {
        return false;
      }

      if (left.size !== right.size) {
        return true;
      }

      for (const cell of left) {
        if (!right.has(cell)) {
          return true;
        }
      }

      return false;
    }

    // Stamped slope-actor cell grid: which live slope-SHAPED actor sits in a
    // cell. Slope actors grant ice-slope traversal at their position (they
    // are otherwise ordinary group members: pushable, sliding, journaled).
    let slopeActorGridEpoch = -1;
    let slopeActorGridLength = -1;
    const slopeActorCellStamp = new Int32Array(cellCount);
    const slopeActorCellActor = new Int16Array(cellCount);
    let slopeActorStamp = 0;

    function buildSlopeActorGrid(state) {
      if (slopeActorGridEpoch === journalEpoch && slopeActorGridLength === journalLength) {
        return;
      }

      slopeActorGridEpoch = journalEpoch;
      slopeActorGridLength = journalLength;
      slopeActorStamp += 1;

      if (slopeActorStamp >= 0x7ffffff0) {
        slopeActorCellStamp.fill(0);
        slopeActorStamp = 1;
      }

      for (let i = 0; i < slopeActorIndexes.length; i += 1) {
        const index = slopeActorIndexes[i];

        if (state.actorRemoved[index]) {
          continue;
        }

        const cell = cellIndex(state.actorX[index], state.actorY[index]);
        slopeActorCellStamp[cell] = slopeActorStamp;
        slopeActorCellActor[cell] = index;
      }
    }

    function slopeActorAtCell(state, x, y) {
      if (!levelHasSlopeActors || !isInsideBoard(x, y)) {
        return -1;
      }

      buildSlopeActorGrid(state);
      const cell = cellIndex(x, y);

      return slopeActorCellStamp[cell] === slopeActorStamp
        ? slopeActorCellActor[cell]
        : -1;
    }

    // Owner rule (2026-07): clone groups (and pushed weightless groups)
    // climb slope-shaped actors exactly like terrain ice slopes. A wedge at
    // the target cell counts as a slope for cluster stepping ONLY when it is
    // not part of the moving cluster itself — own wedges ride along and are
    // never ramps or obstacles for their own group.
    function foreignSlopeActorAtCell(state, x, y, isOwnClusterMember) {
      const index = slopeActorAtCell(state, x, y);

      if (index === -1 || (isOwnClusterMember && isOwnClusterMember(index))) {
        return -1;
      }

      return index;
    }

    // Stamped weightless-actor position grid backing the component BFS.
    const weightlessPosStampGrid = new Int32Array(cellCount * 20);
    const weightlessPosActorGrid = new Int16Array(cellCount * 20);
    let weightlessPosStamp = 0;

    let buildWeightlessPositionGridEpoch = -1;
    let buildWeightlessPositionGridLength = -1;

    function buildWeightlessPositionGrid(state) {
      if (buildWeightlessPositionGridEpoch === journalEpoch && buildWeightlessPositionGridLength === journalLength) {
        return;
      }

      buildWeightlessPositionGridEpoch = journalEpoch;
      buildWeightlessPositionGridLength = journalLength;
      weightlessPosStamp += 1;

      if (weightlessPosStamp >= 0x3ffffff0) {
        weightlessPosStampGrid.fill(0);
        weightlessPosStamp = 1;
      }

      for (const cached of weightlessMembersByGroup.values()) {
        for (let i = 0; i < cached.length; i += 1) {
          const index = cached[i];

          if (state.actorRemoved[index]) {
            continue;
          }

          const slot = occupancySlot(
            state.actorX[index],
            state.actorY[index],
            state.actorElevation[index] || 0
          );

          if (slot >= 0) {
            weightlessPosStampGrid[slot] = weightlessPosStamp;
            weightlessPosActorGrid[slot] = index;
          }
        }
      }
    }

    function weightlessActorAtSlot(x, y, elevation) {
      const slot = occupancySlot(x, y, elevation);

      if (slot < 0 || weightlessPosStampGrid[slot] !== weightlessPosStamp) {
        return -1;
      }

      return weightlessPosActorGrid[slot];
    }

    // Stamped position grid of ALL blocking actors (everything except gems,
    // buttons, punchers) at their own elevation. Built once per cluster
    // collection; actors do not move while a cluster is being collected.
    const blockingPosStampGrid = new Int32Array(cellCount * 20);
    const blockingPosActorGrid = new Int16Array(cellCount * 20);
    let blockingPosStamp = 0;

    let buildBlockingPositionGridEpoch = -1;
    let buildBlockingPositionGridLength = -1;

    function buildBlockingPositionGrid(state) {
      if (buildBlockingPositionGridEpoch === journalEpoch && buildBlockingPositionGridLength === journalLength) {
        return;
      }

      buildBlockingPositionGridEpoch = journalEpoch;
      buildBlockingPositionGridLength = journalLength;
      blockingPosStamp += 1;

      if (blockingPosStamp >= 0x3ffffff0) {
        blockingPosStampGrid.fill(0);
        blockingPosStamp = 1;
      }

      for (let index = 0; index < actorCount; index += 1) {
        if (state.actorRemoved[index] || isNonBlockingActor(index)) {
          continue;
        }

        const slot = occupancySlot(
          state.actorX[index],
          state.actorY[index],
          state.actorElevation[index] || 0
        );

        if (slot >= 0) {
          blockingPosStampGrid[slot] = blockingPosStamp;
          blockingPosActorGrid[slot] = index;
        }
      }
    }

    function blockingActorAtSlot(x, y, elevation) {
      const slot = occupancySlot(x, y, elevation);

      if (slot < 0 || blockingPosStampGrid[slot] !== blockingPosStamp) {
        return -1;
      }

      return blockingPosActorGrid[slot];
    }

    function canMoveInto(state, x, y, occupied, gateState, orangeButtonsPressed, elevation = 0) {
      if (!isInsideBoard(x, y)) {
        return false;
      }

      if (terrainBlocksElevation(state, x, y, elevation, gateState, orangeButtonsPressed)) {
        return false;
      }

      if (
        !(elevation === 0 && isHole(state, x, y, 0)) &&
        !terrainSupportsElevation(state, x, y, elevation, gateState, orangeButtonsPressed)
      ) {
        return false;
      }

      return !isOccupiedAtElevation(occupied, x, y, elevation);
    }

    function canMoveIntoAtElevation(
      state,
      x,
      y,
      occupied,
      gateState,
      orangeButtonsPressed,
      elevation
    ) {
      return canMoveInto(state, x, y, occupied, gateState, orangeButtonsPressed, elevation);
    }

    function iceSlopeTraversalExitIsOccupied(state, occupied, traversal, nextTraversal) {
      const slopeActor = nextTraversal?.slopeLayer?.slopeActorIndex;

      // A slope-shaped actor occupies the voxel containing its own inclined
      // face. When that face continues a ramp chain, exempt only that actor;
      // any other occupant still blocks exactly as it would on terrain ramps.
      if (Number.isInteger(slopeActor)) {
        return isOccupiedAtElevationByOtherThan(
          occupied,
          traversal.exitX,
          traversal.exitY,
          traversal.exitElevation,
          slopeActor
        );
      }

      // Like a terrain ramp, an owned slope also fills its upper collision
      // band. A same-height wedge at the previous wedge's uphill exit is not
      // a continuation: it blocks and bounces the traversal. Without this,
      // the player could enter that upper band, settle underneath the wedge,
      // and lift the entire connected Box/Clone slope group one elevation.
      const exitSlopeActor = slopeActorAtCell(
        state,
        traversal.exitX,
        traversal.exitY
      );

      if (
        exitSlopeActor !== -1 &&
        actorElevation(state, exitSlopeActor) + 1 === traversal.exitElevation
      ) {
        return true;
      }

      return isOccupiedAtElevation(
        occupied,
        traversal.exitX,
        traversal.exitY,
        traversal.exitElevation
      );
    }

    function resolveIceSlopeTraversal(
      state,
      slopeX,
      slopeY,
      dx,
      dy,
      elevation,
      occupied,
      gateState,
      orangeButtonsPressed,
      options = {}
    ) {
      let traversal = iceSlopeTraversalForEntry(state, slopeX, slopeY, dx, dy, elevation, orangeButtonsPressed);
      const path = traversal ? iceSlopeTraversalPathPoints(traversal) : [];
      let guard = width * height + 1;

      while (traversal && guard > 0) {
        guard -= 1;

        if (!isInsideBoard(traversal.exitX, traversal.exitY)) {
          if (options.allowLevelExit !== true) {
            return null;
          }

          const resultPath = path.map((point) => ({ ...point }));
          const pathEnd = resultPath[resultPath.length - 1] || {
            x: traversal.slopeX,
            y: traversal.slopeY,
            elevation: traversal.entryElevation
          };

          return {
            ...traversal,
            exitX: traversal.slopeX,
            exitY: traversal.slopeY,
            exitElevation: pathEnd.elevation,
            levelExit: true,
            levelExitDx: dx,
            levelExitDy: dy,
            levelExitElevation: traversal.exitElevation,
            levelExitSourceType: "ice_slope",
            path: resultPath
          };
        }

        const nextTraversal = iceSlopeTraversalForEntry(
          state,
          traversal.exitX,
          traversal.exitY,
          dx,
          dy,
          traversal.exitElevation,
          orangeButtonsPressed
        );

        // Terrain slopes block both their lower and upper collision bands, so
        // the old order naturally discovered a connected downhill wedge.
        // Slope-shaped actors occupy only their lower actor voxel; prefer a
        // compatible continuation before treating their upper band as empty.
        if (
          nextTraversal &&
          !iceSlopeTraversalExitIsOccupied(state, occupied, traversal, nextTraversal)
        ) {
          if (
            traversal.exitElevation < traversal.entryElevation &&
            nextTraversal.exitElevation > nextTraversal.entryElevation
          ) {
            appendPathPoints(path, [iceSlopeSharedEdgePoint(traversal, dx, dy)]);
          }
          traversal = nextTraversal;
          appendPathPoints(path, iceSlopeTraversalPathPoints(traversal));
          continue;
        }

        if (
          iceSlopeTraversalExitIsOccupied(state, occupied, traversal, nextTraversal)
        ) {
          return null;
        }

        if (
          canTravelThroughSpace(
            state,
            traversal.exitX,
            traversal.exitY,
            occupied,
            gateState,
            orangeButtonsPressed,
            traversal.exitElevation
          )
        ) {
          const resultPath = path.concat(iceSlopeExitCenterPoint(traversal)).map((point) => ({ ...point }));
          const fallTraversal = resolveIceSlopeFallTraversalForLanding(
            state,
            traversal.exitX,
            traversal.exitY,
            traversal.exitElevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            options
          );

          if (fallTraversal) {
            appendPathPoints(resultPath, fallTraversal.path.map((point) => ({ ...point })));
            return {
              ...fallTraversal,
              path: resultPath
            };
          }

          return {
            ...traversal,
            path: resultPath
          };
        }

        return null;
      }

      return null;
    }

    function blockedIceSlopeBouncePathForEntry(
      state,
      slopeX,
      slopeY,
      dx,
      dy,
      elevation,
      occupied,
      gateState,
      orangeButtonsPressed
    ) {
      let traversal = iceSlopeTraversalForEntry(state, slopeX, slopeY, dx, dy, elevation, orangeButtonsPressed);
      const path = traversal ? iceSlopeTraversalPathPoints(traversal) : [];
      let guard = width * height + 1;

      while (traversal && guard > 0) {
        guard -= 1;

        const nextTraversal = iceSlopeTraversalForEntry(
          state,
          traversal.exitX,
          traversal.exitY,
          dx,
          dy,
          traversal.exitElevation,
          orangeButtonsPressed
        );

        if (
          nextTraversal &&
          !iceSlopeTraversalExitIsOccupied(state, occupied, traversal, nextTraversal)
        ) {
          traversal = nextTraversal;
          appendPathPoints(path, iceSlopeTraversalPathPoints(traversal));
          continue;
        }

        if (
          iceSlopeTraversalExitIsOccupied(state, occupied, traversal, nextTraversal)
        ) {
          return path.map((point) => ({ ...point }));
        }

        if (
          canTravelThroughSpace(
            state,
            traversal.exitX,
            traversal.exitY,
            occupied,
            gateState,
            orangeButtonsPressed,
            traversal.exitElevation
          )
        ) {
          return null;
        }

        return path.map((point) => ({ ...point }));
      }

      return null;
    }

    function pushableBlockingActorAtElevation(state, x, y, elevation, ignoredActors = new Set()) {
      return actorAt(
        state,
        x,
        y,
        (actor) =>
          !ignoredActors.has(actor) &&
          !isNonBlockingActor(actor) &&
          actorElevation(state, actor) === elevation &&
          isPushableActor(actor)
      );
    }

    function blockedIceSlopePushForEntry(
      state,
      slopeX,
      slopeY,
      dx,
      dy,
      elevation,
      occupied,
      gateState,
      orangeButtonsPressed,
      ignoredActors = new Set()
    ) {
      let traversal = iceSlopeTraversalForEntry(state, slopeX, slopeY, dx, dy, elevation, orangeButtonsPressed);
      const path = traversal ? iceSlopeTraversalPathPoints(traversal) : [];
      let guard = width * height + 1;

      while (traversal && guard > 0) {
        guard -= 1;

        const nextTraversal = iceSlopeTraversalForEntry(
          state,
          traversal.exitX,
          traversal.exitY,
          dx,
          dy,
          traversal.exitElevation,
          orangeButtonsPressed
        );

        if (nextTraversal) {
          if (iceSlopeTraversalExitIsOccupied(state, occupied, traversal, nextTraversal)) {
            return null;
          }

          traversal = nextTraversal;
          appendPathPoints(path, iceSlopeTraversalPathPoints(traversal));
          continue;
        }

        if (
          canTravelThroughSpace(
            state,
            traversal.exitX,
            traversal.exitY,
            occupied,
            gateState,
            orangeButtonsPressed,
            traversal.exitElevation
          )
        ) {
          return null;
        }

        const blocker = !terrainBlocksElevation(
          state,
          traversal.exitX,
          traversal.exitY,
          traversal.exitElevation,
          gateState,
          orangeButtonsPressed
        )
          ? pushableBlockingActorAtElevation(
              state,
              traversal.exitX,
              traversal.exitY,
              traversal.exitElevation,
              ignoredActors
            )
          : -1;

        return blocker === -1
          ? null
          : {
              blocker,
              traversal: {
                ...traversal,
                path: path.concat(iceSlopeExitCenterPoint(traversal)).map((point) => ({ ...point }))
              }
            };
      }

      return null;
    }

    function iceSlopeFallTraversal(
      state,
      slopeX,
      slopeY,
      fromElevation,
      occupied,
      gateState,
      orangeButtonsPressed,
      options = {}
    ) {
      const layers = iceSlopeLayersAt(state, slopeX, slopeY, orangeButtonsPressed)
        .filter((layer) => layer.elevation + 1 < fromElevation)
        .sort((left, right) => right.elevation - left.elevation);

      for (const layer of layers) {
        const uphill = puncherDirectionVector(layer.direction);
        const downhill = { dx: -uphill.dx, dy: -uphill.dy };
        let traversal = resolveIceSlopeTraversal(
          state,
          slopeX,
          slopeY,
          downhill.dx,
          downhill.dy,
          layer.elevation + 1,
          occupied,
          gateState,
          orangeButtonsPressed,
          options
        );

        if (!traversal && typeof options.pushSlopeBlocker === "function") {
          const blockedSlope = blockedIceSlopePushForEntry(
            state,
            slopeX,
            slopeY,
            downhill.dx,
            downhill.dy,
            layer.elevation + 1,
            occupied,
            gateState,
            orangeButtonsPressed,
            options.ignoredActors || new Set()
          );

          if (blockedSlope && options.pushSlopeBlocker(blockedSlope.blocker, downhill.dx, downhill.dy)) {
            traversal = resolveIceSlopeTraversal(
              state,
              slopeX,
              slopeY,
              downhill.dx,
              downhill.dy,
              layer.elevation + 1,
              occupied,
              gateState,
              orangeButtonsPressed,
              options
            );
          }
        }

        if (traversal) {
          return traversal;
        }
      }

      return null;
    }

    function resolveIceSlopeFallTraversalForLanding(
      state,
      slopeX,
      slopeY,
      elevation,
      occupied,
      gateState,
      orangeButtonsPressed,
      options = {}
    ) {
      const traversal = iceSlopeFallTraversal(
        state,
        slopeX,
        slopeY,
        elevation,
        occupied,
        gateState,
        orangeButtonsPressed,
        options
      );

      if (!traversal) {
        return null;
      }

      return {
        ...traversal,
        path: [
          { x: slopeX, y: slopeY, elevation },
          ...traversal.path.map((point) => ({ ...point }))
        ]
      };
    }

    function findSlideDestination(
      state,
      startX,
      startY,
      dx,
      dy,
      occupied,
      gateState,
      orangeButtonsPressed,
      elevation = 0,
      options = {}
    ) {
      let nextX = startX;
      let nextY = startY;
      let nextElevation = elevation;
      let stepDx = dx;
      let stepDy = dy;
      let reversedAfterSlopeBounce = false;
      const path = [{ x: startX, y: startY, elevation }];

      while (true) {
        let slopeTraversal = resolveIceSlopeTraversal(
          state,
          nextX + stepDx,
          nextY + stepDy,
          stepDx,
          stepDy,
          nextElevation,
          occupied,
          gateState,
          orangeButtonsPressed,
          options
        );

        if (!slopeTraversal && typeof options.pushSlopeBlocker === "function") {
          const blockedSlope = blockedIceSlopePushForEntry(
            state,
            nextX + stepDx,
            nextY + stepDy,
            stepDx,
            stepDy,
            nextElevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            options.ignoredActors || new Set()
          );

          if (blockedSlope && options.pushSlopeBlocker(blockedSlope.blocker, stepDx, stepDy)) {
            slopeTraversal = resolveIceSlopeTraversal(
              state,
              nextX + stepDx,
              nextY + stepDy,
              stepDx,
              stepDy,
              nextElevation,
              occupied,
              gateState,
              orangeButtonsPressed,
              options
            );
          }
        }

        if (!slopeTraversal) {
          slopeTraversal = resolveIceSlopeFallTraversalForLanding(
            state,
            nextX + stepDx,
            nextY + stepDy,
            nextElevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            options
          );
        }

        if (!slopeTraversal) {
          slopeTraversal = resolveIceSlopeTopSlideTraversal(
            state,
            nextX + stepDx,
            nextY + stepDy,
            nextElevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            options
          );
        }

        if (slopeTraversal) {
          nextX = slopeTraversal.exitX;
          nextY = slopeTraversal.exitY;
          nextElevation = slopeTraversal.exitElevation;
          path.push(...slopeTraversal.path);

          if (!isIce(state, nextX, nextY, nextElevation, gateState, orangeButtonsPressed)) {
            break;
          }

          continue;
        }

        if (
          options.reverseOnBlockedSlopeBounceFromIce === true &&
          !reversedAfterSlopeBounce
        ) {
          const bouncePath = blockedIceSlopeBouncePathForEntry(
            state,
            nextX + stepDx,
            nextY + stepDy,
            stepDx,
            stepDy,
            nextElevation,
            occupied,
            gateState,
            orangeButtonsPressed
          );

          if (
            bouncePath &&
            bouncePath.length > 0 &&
            isIce(state, nextX, nextY, nextElevation, gateState, orangeButtonsPressed)
          ) {
            appendPathPoints(path, bouncePath.map((point) => ({ ...point })));
            appendPathPoints(
              path,
              bouncePath
                .slice(0, -1)
                .reverse()
                .map((point) => ({ ...point }))
            );
            appendPathPoints(path, [{ x: nextX, y: nextY, elevation: nextElevation }]);
            stepDx = -stepDx;
            stepDy = -stepDy;
            reversedAfterSlopeBounce = true;
            continue;
          }
        }

        if (!canMoveInto(state, nextX + stepDx, nextY + stepDy, occupied, gateState, orangeButtonsPressed, nextElevation)) {
          break;
        }

        nextX += stepDx;
        nextY += stepDy;
        path.push({ x: nextX, y: nextY, elevation: nextElevation });

        // FIX(SEMANTICS R4): a slide reversed by a blocked-slope bounce may
        // ENTER the pushing player's cell (the codified pusher/box swap) but
        // never pass THROUGH it — legacy let the returning box glide through
        // the net-stationary pusher and land behind them, because the active
        // player is absent from the occupancy set for its whole move.
        if (
          reversedAfterSlopeBounce &&
          options.pusherX === nextX &&
          options.pusherY === nextY &&
          options.pusherElevation === nextElevation
        ) {
          break;
        }

        if (!isIce(state, nextX, nextY, nextElevation, gateState, orangeButtonsPressed)) {
          break;
        }
      }

      const landingElevation = landingElevationAtLocation(
        state,
        nextX,
        nextY,
        nextElevation,
        occupied,
        gateState,
        orangeButtonsPressed
      );
      const finalPath =
        landingElevation !== null && landingElevation !== nextElevation
          ? path.concat({ x: nextX, y: nextY, elevation: landingElevation })
          : path;

      return {
        elevation: landingElevation ?? nextElevation,
        hasLandingSupport: landingElevation !== null,
        path: finalPath,
        pathEndElevation: nextElevation,
        x: nextX,
        y: nextY
      };
    }

    function moveBox(
      state,
      actorIndex,
      dx,
      dy,
      occupied,
      moves,
      gateState,
      orangeButtonsPressed,
      searchMode,
      pushContext = null
    ) {
      const fromX = state.actorX[actorIndex];
      const fromY = state.actorY[actorIndex];
      const elevation = actorElevation(state, actorIndex);
      const carriedRiders = Array.isArray(pushContext?.carriedRiders)
        ? pushContext.carriedRiders
        : [];
      const moveStartIndex = pushContext?.moveStartIndex ?? moves.length;
      removeOccupiedAtElevation(occupied, fromX, fromY, elevation);
      carriedRiders.forEach((rider) => {
        removeOccupiedAtElevation(occupied, rider.fromX, rider.fromY, rider.fromElevation);
      });
      const ignoredActors = new Set(pushContext?.ignoredActors || []);
      ignoredActors.add(actorIndex);
      carriedRiders.forEach((rider) => ignoredActors.add(rider.actorIndex));

      const target = findSlideDestination(
        state,
        fromX,
        fromY,
        dx,
        dy,
        occupied,
        gateState,
        orangeButtonsPressed,
        elevation,
        pushContext
          ? {
              ignoredActors,
              reverseOnBlockedSlopeBounceFromIce: true,
              pusherX: pushContext.pusherX,
              pusherY: pushContext.pusherY,
              pusherElevation: pushContext.pusherElevation,
              pushSlopeBlocker: (blocker, pushDx = dx, pushDy = dy) => {
                if (blocker === actorIndex) {
                  return false;
                }

                const result = attemptPushActor(
                  state,
                  blocker,
                  pushDx,
                  pushDy,
                  occupied,
                  moves,
                  // FIX(SEMANTICS R3a): legacy hardcoded budget 1 here, so a
                  // multi-box chain at a slope exit could never be pushed by a
                  // sliding box no matter how many players pushed. The train's
                  // remaining budget propagates through the slide; the floor
                  // of 1 preserves the tested lone-pusher single-blocker case.
                  Math.max(1, pushContext.remainingBudget ?? 1),
                  pushContext.handled || new Set(),
                  gateState,
                  orangeButtonsPressed,
                  ignoredActors,
                  searchMode,
                  pushContext
                );

                return result !== null;
              }
            }
          : {}
      );

      if (target.x === fromX && target.y === fromY && target.elevation === elevation) {
        addOccupiedAtElevation(occupied, fromX, fromY, elevation);
        carriedRiders.forEach((rider) => {
          addOccupiedAtElevation(occupied, rider.fromX, rider.fromY, rider.fromElevation);
        });
        return false;
      }

      jSetActorX(state, actorIndex, target.x);
      jSetActorY(state, actorIndex, target.y);
      jSetActorElevation(state, actorIndex, target.elevation);

      const moveRecord = {
        actorIndex,
        actorType: actorTypes[actorIndex],
        fromElevation: elevation,
        fromX,
        fromY,
        toElevation: target.elevation,
        toX: target.x,
        toY: target.y
      };
      const pathControlsElevation = target.path.some((point) => point.elevation !== elevation);

      if (target.path.length > 2 || pathControlsElevation) {
        moveRecord.path = target.path;
        moveRecord.pathControlsElevation = pathControlsElevation;
        moveRecord.pathEndElevation = target.pathEndElevation;
      }

      if (!searchMode) {
        moveRecord.iceSlide =
          target.path.length > 2 ||
          Math.abs(target.x - fromX) + Math.abs(target.y - fromY) > 1 ||
          target.pathEndElevation !== elevation;
      }

      // FIX(SEMANTICS R2): iceSlipOff is semantic (it drives pit removal in
      // applyHoleFalls), not visual. Legacy set it only in play mode, so the
      // solver simulated a different game: a box sliding off a slope over a
      // void survived in search mode and died in play mode.
      if (target.elevation !== target.pathEndElevation || !target.hasLandingSupport) {
        moveRecord.iceSlipOff = true;
      }

      moves.push(moveRecord);
      addOccupiedAtElevation(occupied, target.x, target.y, target.elevation);
      moveCarriedRidersForSupportMoves(
        state,
        carriedRiders,
        moves,
        moveStartIndex,
        occupied,
        gateState,
        orangeButtonsPressed,
        searchMode,
        pushContext?.carriedPlayers
      );
      return true;
    }

    function countSupportingPlayers(state, player, dx, dy) {
      let count = 1;
      let checkX = state.actorX[player];
      let checkY = state.actorY[player];

      while (true) {
        checkX -= dx;
        checkY -= dy;

        const occupant = actorAt(
          state,
          checkX,
          checkY,
          (actor) => isPlayerActor(actor) && actorElevation(state, actor) === actorElevation(state, player)
        );

        if (occupant === -1) {
          break;
        }

        count += 1;
      }

      return count;
    }

    // FIX(SEMANTICS R3): contact-position variant used for mid-slide slope
    // pushes. Counts the pushing player plus the contiguous train of OTHER
    // players directly behind (x, y) at the given elevation. The slider's own
    // stale state position is excluded so a long slide cannot count itself.
    function countSupportingPlayersAt(state, player, x, y, elevation, dx, dy) {
      let count = 1;
      let checkX = x;
      let checkY = y;

      while (true) {
        checkX -= dx;
        checkY -= dy;

        const occupant = actorAt(
          state,
          checkX,
          checkY,
          (actor) =>
            actor !== player &&
            isPlayerActor(actor) &&
            actorElevation(state, actor) === elevation
        );

        if (occupant === -1) {
          break;
        }

        count += 1;
      }

      return count;
    }

    function blockingActorAtElevation(state, x, y, elevation, mover) {
      return actorAt(
        state,
        x,
        y,
        (actor) =>
          actor !== mover &&
          !isNonBlockingActor(actor) &&
          actorElevation(state, actor) === elevation
      );
    }

    function pushableSupportActorUnderPlayer(
      state,
      player,
      gateState,
      orangeButtonsPressed
    ) {
      const playerElevation = actorElevation(state, player);

      if (
        terrainSupportsElevation(
          state,
          state.actorX[player],
          state.actorY[player],
          playerElevation,
          gateState,
          orangeButtonsPressed
        )
      ) {
        return -1;
      }

      return actorAt(
        state,
        state.actorX[player],
        state.actorY[player],
        (actor) =>
          isPushableActor(actor) &&
          actorProvidesFlatSupport(actor) &&
          actorElevation(state, actor) + 1 === playerElevation
      );
    }

    function collectGemsAt(
      state,
      x,
      y,
      elevation,
      moves,
      collectedGems,
      fadeStartProgress,
      fadeEndProgress,
      searchMode
    ) {
      actorsAt(
        state,
        x,
        y,
        (actor) =>
          isCollectibleActor(actor) &&
          actorElevation(state, actor) === elevation &&
          !collectedGems.has(actor)
      ).forEach((gem) => {
        collectedGems.add(gem);
        const moveRecord = {
          actorIndex: gem,
          actorType: actorTypes[gem],
          fromX: state.actorX[gem],
          fromY: state.actorY[gem],
          toX: state.actorX[gem],
          toY: state.actorY[gem],
          fromRemoved: false,
          toRemoved: true
        };

        if (!searchMode) {
          moveRecord.fadeOut = true;
          moveRecord.fadeStartProgress = fadeStartProgress;
          moveRecord.fadeEndProgress = fadeEndProgress;
          moveRecord.skipHoleFall = true;
          moveRecord.visibleDuringMove = true;
        }

        moves.push(moveRecord);
      });
    }

    function collectGemsAtEndpoint(
      state,
      fromX,
      fromY,
      toX,
      toY,
      elevation,
      moves,
      collectedGems,
      searchMode
    ) {
      const travelDistance = Math.abs(toX - fromX) + Math.abs(toY - fromY);
      collectGemsAt(
        state,
        toX,
        toY,
        elevation,
        moves,
        collectedGems,
        travelDistance > 1 ? (travelDistance - 1) / travelDistance : 0,
        1,
        searchMode
      );
    }

    function canWeightlessMemberEnter(
      state,
      member,
      targetX,
      targetY,
      targetElevation,
      gateState,
      orangeButtonsPressed,
      options = {}
    ) {
      if (!isInsideBoard(targetX, targetY)) {
        return false;
      }

      const canEnter = !terrainBlocksElevation(
        state,
        targetX,
        targetY,
        targetElevation,
        gateState,
        orangeButtonsPressed
      );

      if (
        canEnter &&
        options.blockSupportSide === true &&
        (state.actorX[member] !== targetX || state.actorY[member] !== targetY) &&
        terrainSupportSideBlocksWeightlessEntry(
          state,
          targetX,
          targetY,
          targetElevation,
          gateState,
          orangeButtonsPressed
        )
      ) {
        return false;
      }

      return canEnter;
    }

    function weightlessMemberCanOccupy(
      state,
      member,
      targetX,
      targetY,
      targetElevation,
      occupied,
      gateState,
      orangeButtonsPressed,
      options = {}
    ) {
      if (
        !canWeightlessMemberEnter(
          state,
          member,
          targetX,
          targetY,
          targetElevation,
          gateState,
          orangeButtonsPressed,
          options
        )
      ) {
        if (
          !options.allowIceSlopeTransit ||
          !terrainBlocksOnlyByIceSlope(
            state,
            targetX,
            targetY,
            targetElevation,
            gateState,
            orangeButtonsPressed
          )
        ) {
          return false;
        }
      }

      return !isOccupiedAtElevation(occupied, targetX, targetY, targetElevation);
    }

    function weightlessClusterHasIceSlopeTransit(
      state,
      members,
      gateState,
      orangeButtonsPressed
    ) {
      const memberSet = new Set(members);

      return members.some((member) => {
        const x = state.actorX[member];
        const y = state.actorY[member];
        const elevation = actorElevation(state, member);

        if (
          terrainBlocksOnlyByIceSlope(
            state,
            x,
            y,
            elevation,
            gateState,
            orangeButtonsPressed
          )
        ) {
          return true;
        }

        // Slope-shaped actors do not appear in the terrain blocker list,
        // and a trailing rigid member can occupy either the lower or upper
        // band while the group's shared traversal finishes. Ignore the
        // cluster's own authored wedge: it moves with the rigid body and is
        // never a ramp beneath that same body.
        return iceSlopeLayersAt(state, x, y, orangeButtonsPressed).some((layer) => {
          if (
            Number.isInteger(layer.slopeActorIndex) &&
            memberSet.has(layer.slopeActorIndex)
          ) {
            return false;
          }

          const slopeElevation = layer.elevation ?? 0;
          return elevation === slopeElevation || elevation === slopeElevation + 1;
        });
      });
    }

    function weightlessClusterHasTrailingMember(state, members, dx, dy) {
      const memberPositions = new Set(
        members.map(
          (member) =>
            `${state.actorX[member]},${state.actorY[member]},${actorElevation(state, member)}`
        )
      );

      return members.some((member) =>
        memberPositions.has(
          `${state.actorX[member] - dx},${state.actorY[member] - dy},${actorElevation(state, member)}`
        )
      );
    }

    function weightlessClusterCanStartIceSlopeTransit(
      state,
      members,
      dx,
      dy,
      occupied,
      gateState,
      orangeButtonsPressed
    ) {
      return members.some((member) =>
        Boolean(
          resolveIceSlopeTraversal(
            state,
            state.actorX[member] + dx,
            state.actorY[member] + dy,
            dx,
            dy,
            actorElevation(state, member),
            occupied,
            gateState,
            orangeButtonsPressed
          )
        )
      );
    }

    function weightlessClusterShouldContinueSliding(
      state,
      members,
      gateState,
      orangeButtonsPressed,
      predictedSupports = null
    ) {
      const memberSet = new Set(members);
      let hasIceSlideContact = false;
      let hasRestingSupport = false;

      for (const member of members) {
        const x = state.actorX[member];
        const y = state.actorY[member];
        const elevation = actorElevation(state, member);

        if (isIceOrHole(state, x, y, elevation, gateState, orangeButtonsPressed)) {
          hasIceSlideContact = true;
          continue;
        }

        if (terrainBlocksOnlyByIceSlope(state, x, y, elevation, gateState, orangeButtonsPressed)) {
          hasIceSlideContact = true;
          continue;
        }

        if (
          terrainSupportsElevation(state, x, y, elevation, gateState, orangeButtonsPressed) ||
          actorSupportSurfaceHeightsAt(state, x, y, memberSet, true).includes(elevation) ||
          predictedSupportsElevation(predictedSupports, x, y, elevation, memberSet)
        ) {
          hasRestingSupport = true;
        }
      }

      // Ordinary ice motion can be anchored by another member's real flat
      // support. Mid-slope transit cannot: stopping the rigid body there
      // leaves one member inside the wedge and lets the later support pass
      // hoist the entire group to the wedge's highest surface.
      return (
        weightlessClusterHasIceSlopeTransit(state, members, gateState, orangeButtonsPressed) ||
        (hasIceSlideContact && !hasRestingSupport)
      );
    }

    function weightlessMemberHasCurrentSupport(
      state,
      member,
      gateState,
      orangeButtonsPressed,
      memberSet,
      predictedSupports = null
    ) {
      const x = state.actorX[member];
      const y = state.actorY[member];
      const elevation = actorElevation(state, member);

      return (
        terrainSupportsElevation(state, x, y, elevation, gateState, orangeButtonsPressed) ||
        actorSupportSurfaceHeightsAt(state, x, y, memberSet, true).includes(elevation) ||
        predictedSupportsElevation(predictedSupports, x, y, elevation, memberSet)
      );
    }

    function predictedSupportsElevation(
      predictedSupports,
      x,
      y,
      elevation,
      ignoredActors = null
    ) {
      if (!Array.isArray(predictedSupports) || predictedSupports.length === 0) {
        return false;
      }

      return predictedSupports.some((support) => {
        if (ignoredActors?.has(support.actorIndex)) {
          return false;
        }

        return support.x === x && support.y === y && support.elevation + 1 === elevation;
      });
    }

    function settleWeightlessClusterDownOneLayer(
      state,
      members,
      occupied,
      gateState,
      orangeButtonsPressed,
      predictedSupports = null
    ) {
      const memberSet = new Set(members);

      if (
        members.some((member) =>
          weightlessMemberHasCurrentSupport(
            state,
            member,
            gateState,
            orangeButtonsPressed,
            memberSet,
            predictedSupports
          )
        )
      ) {
        return false;
      }

      if (
        !members.every((member) =>
          weightlessMemberCanOccupy(
            state,
            member,
            state.actorX[member],
            state.actorY[member],
            actorElevation(state, member) - 1,
            occupied,
            gateState,
            orangeButtonsPressed
          )
        )
      ) {
        return false;
      }

      members.forEach((member) => {
        jSetActorElevation(state, member, state.actorElevation[member] - 1);
      });

      return true;
    }

    function clusterHasSupportedMemberAfterStep(
      state,
      members,
      step,
      occupied,
      gateState,
      orangeButtonsPressed,
      predictedSupports = null,
      options = {}
    ) {
      const memberSet = new Set(members);
      const allowEmptyPitEntry = options.allowEmptyPitEntry === true;
      const isClusterPitEntryTarget = (member) => {
        const targetX = state.actorX[member] + step.dx;
        const targetY = state.actorY[member] + step.dy;
        const targetElevation = actorElevation(state, member) + step.elevation;

        return (
          isTerrainHoleAtElevation(state, targetX, targetY, targetElevation) ||
          ((members.length > 1 || allowEmptyPitEntry) &&
            isEmptyVoidAtElevation(state, targetX, targetY, targetElevation))
        );
      };

      const hasDirectSupport = members.some((member) => {
        const targetX = state.actorX[member] + step.dx;
        const targetY = state.actorY[member] + step.dy;
        const targetElevation = actorElevation(state, member) + step.elevation;

        return (
          terrainSupportsElevation(
            state,
            targetX,
            targetY,
            targetElevation,
            gateState,
            orangeButtonsPressed
          ) ||
          actorSupportSurfaceHeightsAt(state, targetX, targetY, memberSet, true).includes(
            targetElevation
          ) ||
          predictedSupportsElevation(
            predictedSupports,
            targetX,
            targetY,
            targetElevation,
            memberSet
          )
        );
      });

      if (hasDirectSupport) {
        return true;
      }

      const canSettleAfterUnsupportedStep =
        (Array.isArray(step.pathOffsets) && step.pathOffsets.length > 0) ||
        members.some((member) => {
          const currentX = state.actorX[member];
          const currentY = state.actorY[member];
          const currentElevation = actorElevation(state, member);
          const targetX = currentX + step.dx;
          const targetY = currentY + step.dy;
          const targetElevation = currentElevation + step.elevation;

          return (
            isClusterPitEntryTarget(member) ||
            isIce(state, currentX, currentY, currentElevation, gateState, orangeButtonsPressed) ||
            terrainBlocksOnlyByIceSlope(
              state,
              currentX,
              currentY,
              currentElevation,
              gateState,
              orangeButtonsPressed
            ) ||
            terrainBlocksOnlyByIceSlope(
              state,
              targetX,
              targetY,
              targetElevation,
              gateState,
              orangeButtonsPressed
            )
          );
        });

      if (!canSettleAfterUnsupportedStep) {
        return false;
      }

      const canSettleDown = members.every((member) => {
        const targetX = state.actorX[member] + step.dx;
        const targetY = state.actorY[member] + step.dy;
        const targetElevation = actorElevation(state, member) + step.elevation - 1;

        return weightlessMemberCanOccupy(
          state,
          member,
          targetX,
          targetY,
          targetElevation,
          occupied,
          gateState,
          orangeButtonsPressed
        );
      });

      if (!canSettleDown) {
        return false;
      }

      if (
        members.some((member) => isClusterPitEntryTarget(member))
      ) {
        return true;
      }

      return members.some((member) => {
        const targetX = state.actorX[member] + step.dx;
        const targetY = state.actorY[member] + step.dy;
        const targetElevation = actorElevation(state, member) + step.elevation - 1;

        return (
          terrainSupportsElevation(
            state,
            targetX,
            targetY,
            targetElevation,
            gateState,
            orangeButtonsPressed
          ) ||
          actorSupportSurfaceHeightsAt(state, targetX, targetY, memberSet, true).includes(
            targetElevation
          ) ||
          predictedSupportsElevation(
            predictedSupports,
            targetX,
            targetY,
            targetElevation,
            memberSet
          )
        );
      });
    }

    function weightlessClusterStep(
      state,
      members,
      dx,
      dy,
      occupied,
      gateState,
      orangeButtonsPressed,
      options = {}
    ) {
      let slopeDelta = null;
      let slopePathOffsets = null;
      let encounteredBlockedSlope = false;
      const traversingSlopeMembers = new Set();
      const allowClusterIceSlopeTransit =
        options.allowIceSlopeTransit === true ||
        weightlessClusterCanStartIceSlopeTransit(
          state,
          members,
          dx,
          dy,
          occupied,
          gateState,
          orangeButtonsPressed
        );

      const isOwnClusterMember = (index) => members.includes(index);

      for (const member of members) {
        const elevation = actorElevation(state, member);
        const targetX = state.actorX[member] + dx;
        const targetY = state.actorY[member] + dy;

        // Perf: all slope probes key off the target cell's slope layers
        // (terrain mask, or a slope-shaped actor outside this cluster).
        if (
          (!levelHasSlopes ||
            !isInsideBoard(targetX, targetY) ||
            slopeCellMask[cellIndex(targetX, targetY)] === 0) &&
          foreignSlopeActorAtCell(state, targetX, targetY, isOwnClusterMember) === -1
        ) {
          continue;
        }

        let traversal = resolveIceSlopeTraversal(
          state,
          targetX,
          targetY,
          dx,
          dy,
          elevation,
          occupied,
          gateState,
          orangeButtonsPressed,
          options
        );

        if (!traversal && typeof options.pushSlopeBlocker === "function") {
          const blockedSlope = blockedIceSlopePushForEntry(
            state,
            targetX,
            targetY,
            dx,
            dy,
            elevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            options.ignoredActors || new Set()
          );

          if (blockedSlope && options.pushSlopeBlocker(blockedSlope.blocker)) {
            traversal = resolveIceSlopeTraversal(
              state,
              targetX,
              targetY,
              dx,
              dy,
              elevation,
              occupied,
              gateState,
              orangeButtonsPressed,
              options
            );
          }
        }

        if (
          !traversal &&
          !allowClusterIceSlopeTransit &&
          options.allowLowerSlopeFallTraversal !== false
        ) {
          traversal = resolveIceSlopeFallTraversalForLanding(
            state,
            targetX,
            targetY,
            elevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            options
          );
        }

        if (!traversal && !allowClusterIceSlopeTransit) {
          traversal = resolveIceSlopeTopSlideTraversal(
            state,
            targetX,
            targetY,
            elevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            options
          );
        }

        if (!traversal) {
          // While a rigid body is already crossing a slope, a valid slope
          // entry whose exit is blocked is not a plain one-cell move through
          // the wedge. Reject the shared step so moveWeightlessCluster can
          // apply the canonical forward-and-back bounce to every member.
          encounteredBlockedSlope ||= Boolean(
            blockedIceSlopeBouncePathForEntry(
              state,
              targetX,
              targetY,
              dx,
              dy,
              elevation,
              occupied,
              gateState,
              orangeButtonsPressed
            )
          );
          continue;
        }

        traversingSlopeMembers.add(member);
        const delta = {
          dx: traversal.exitX - state.actorX[member],
          dy: traversal.exitY - state.actorY[member],
          elevation: traversal.exitElevation - elevation
        };
        const pathOffsets = pathOffsetsForTraversal(
          traversal,
          state.actorX[member],
          state.actorY[member],
          elevation
        );

        if (
          slopeDelta &&
          (slopeDelta.dx !== delta.dx ||
            slopeDelta.dy !== delta.dy ||
            slopeDelta.elevation !== delta.elevation)
        ) {
          return null;
        }

        if (slopePathOffsets && !samePathOffsets(slopePathOffsets, pathOffsets)) {
          return null;
        }

        slopeDelta = delta;
        slopePathOffsets = pathOffsets;
      }

      if (encounteredBlockedSlope && allowClusterIceSlopeTransit) {
        return null;
      }

      if (slopeDelta?.elevation < 0) {
        for (const member of members) {
          if (traversingSlopeMembers.has(member)) {
            continue;
          }

          if (
            terrainBlocksOnlyByIceSlope(
              state,
              state.actorX[member] + dx,
              state.actorY[member] + dy,
              actorElevation(state, member),
              gateState,
              orangeButtonsPressed
            )
          ) {
            return null;
          }
        }
      }

      const delaySlopeDescent =
        slopeDelta?.elevation < 0 && weightlessClusterHasTrailingMember(state, members, dx, dy);
      const step = slopeDelta
        ? {
            ...slopeDelta,
            elevation: delaySlopeDescent ? 0 : slopeDelta.elevation,
            pathOffsets: delaySlopeDescent
              ? (slopePathOffsets || []).map((point) => ({ ...point, elevation: 0 }))
              : slopePathOffsets || []
          }
        : { dx, dy, elevation: 0, pathOffsets: [] };
      const allowIceSlopeTransit =
        Boolean(slopeDelta) || allowClusterIceSlopeTransit;

      // Rigid-body fast path for the plain unit step: interior members can
      // always enter their own body's cells. Only valid while every group in
      // the cluster is intact (shapes are static unless members were
      // removed) and the target cell has no side-block flank or slope.
      const stepDirBit =
        step.elevation === 0 && step.pathOffsets.length === 0
          ? interiorDirBit(step.dx, step.dy)
          : 0;
      let intactGroups = null;

      if (stepDirBit !== 0) {
        const liveCountByGroup = new Map();

        for (const member of members) {
          if (actorTypes[member] !== "weightless_box") {
            continue;
          }

          const groupKey = actorGroupIds[member];
          liveCountByGroup.set(groupKey, (liveCountByGroup.get(groupKey) || 0) + 1);
        }

        intactGroups = new Set();

        for (const [groupKey, liveCount] of liveCountByGroup) {
          if ((weightlessMembersByGroup.get(groupKey)?.length ?? -1) === liveCount) {
            intactGroups.add(groupKey);
          }
        }
      }

      if (
        members.every((member) => {
          const targetX = state.actorX[member] + step.dx;
          const targetY = state.actorY[member] + step.dy;
          const targetElevation = actorElevation(state, member) + step.elevation;

          if (
            stepDirBit !== 0 &&
            (weightlessInteriorFlags[member] & stepDirBit) !== 0 &&
            actorTypes[member] === "weightless_box" &&
            intactGroups.has(actorGroupIds[member]) &&
            isInsideBoard(targetX, targetY) &&
            sideBlockCellMask[cellIndex(targetX, targetY)] === 0 &&
            (!levelHasSlopes || slopeCellMask[cellIndex(targetX, targetY)] === 0)
          ) {
            return true;
          }

          return weightlessMemberCanOccupy(
            state,
            member,
            targetX,
            targetY,
            targetElevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            {
              allowIceSlopeTransit,
              blockSupportSide: step.dx !== 0 || step.dy !== 0
            }
          );
        })
      ) {
        return step;
      }

      return null;
    }

    function weightlessClusterBlockedSlopeBounceOffsets(
      state,
      members,
      dx,
      dy,
      occupied,
      gateState,
      orangeButtonsPressed
    ) {
      if (!levelHasSlopes && !levelHasSlopeActors) {
        return null;
      }

      // A rigid cluster can have a different member meet the blocked slope
      // than the member still crossing the previous one. Requiring the
      // blocked member itself to be on ice strands the whole group halfway
      // through a slope chain; the later support sync then lifts every
      // member to the highest wedge top and makes the cluster float. Match
      // the player transaction: any shared ice/slope contact keeps the
      // cluster in forced motion, so the blocked face bounces the WHOLE
      // rigid body back.
      const hasSharedSlideContact =
        weightlessClusterHasIceSlopeTransit(
          state,
          members,
          gateState,
          orangeButtonsPressed
        ) ||
        members.some((member) =>
          isIce(
            state,
            state.actorX[member],
            state.actorY[member],
            actorElevation(state, member),
            gateState,
            orangeButtonsPressed
          )
        );

      if (!hasSharedSlideContact) {
        return null;
      }

      let bounceOffsets = null;

      for (const member of members) {
        const elevation = actorElevation(state, member);
        const bouncePath = blockedIceSlopeBouncePathForEntry(
          state,
          state.actorX[member] + dx,
          state.actorY[member] + dy,
          dx,
          dy,
          elevation,
          occupied,
          gateState,
          orangeButtonsPressed
        );

        if (!bouncePath || bouncePath.length === 0) {
          continue;
        }

        const memberBounceOffsets = pathOffsetsForPoints(
          bouncePath
            .concat(
              bouncePath
                .slice(0, -1)
                .reverse()
                .map((point) => ({ ...point })),
              { x: state.actorX[member], y: state.actorY[member], elevation }
            ),
          state.actorX[member],
          state.actorY[member],
          elevation
        );

        if (bounceOffsets && !samePathOffsets(bounceOffsets, memberBounceOffsets)) {
          return null;
        }

        bounceOffsets = memberBounceOffsets;
      }

      return bounceOffsets;
    }

    function collectWeightlessPushCluster(
      state,
      groupId,
      dx,
      dy,
      occupied,
      gateState,
      orangeButtonsPressed,
      ignoredActors,
      actorType = "weightless_box"
    ) {
      const clusterGroupIds = new Set([groupId]);
      const blockers = [];
      const blockerKeys = new Set();
      let expanded = true;

      while (expanded) {
        expanded = false;
        buildBlockingPositionGrid(state);

        const isOwnClusterActor = (index) =>
          actorTypes[index] === actorType && clusterGroupIds.has(actorGroupIds[index]);

        Array.from(clusterGroupIds).forEach((currentGroupId) => {
          const members = weightlessGroupMembers(state, currentGroupId, actorType);
          const canStartIceSlopeTransit = (levelHasSlopes || levelHasSlopeActors)
            ? weightlessClusterCanStartIceSlopeTransit(
                state,
                members,
                dx,
                dy,
                occupied,
                gateState,
                orangeButtonsPressed
              )
            : false;
          // Hoisted out of the member loop (it was rebuilt per member — a
          // ~150-entry Set 75x per step on the 224-box levels), and built
          // lazily only when a slope cell is actually in front of a member.
          let slopeIgnoredActors = null;
          // Rigid-body fast path: interior members (target voxel inside the
          // group's own static shape) can never collide with anything.
          const dirBit = interiorDirBit(dx, dy);
          const groupIntact =
            actorType === "weightless_box" &&
            (weightlessMembersByGroup.get(currentGroupId)?.length ?? -1) === members.length;

          for (const member of members) {
            const memberElevation = actorElevation(state, member);
            const targetX = state.actorX[member] + dx;
            const targetY = state.actorY[member] + dy;

            if (
              groupIntact &&
              dirBit !== 0 &&
              (weightlessInteriorFlags[member] & dirBit) !== 0 &&
              isInsideBoard(targetX, targetY) &&
              sideBlockCellMask[cellIndex(targetX, targetY)] === 0 &&
              (!levelHasSlopes || slopeCellMask[cellIndex(targetX, targetY)] === 0) &&
              foreignSlopeActorAtCell(state, targetX, targetY, isOwnClusterActor) === -1
            ) {
              continue;
            }
            // Perf: all five slope probes key off the target cell's slope
            // layers — one mask byte (or a foreign slope-shaped actor)
            // decides them all.
            const targetHasSlope =
              (levelHasSlopes &&
                isInsideBoard(targetX, targetY) &&
                slopeCellMask[cellIndex(targetX, targetY)] === 1) ||
              foreignSlopeActorAtCell(state, targetX, targetY, isOwnClusterActor) !== -1;
            const slopeTraversal = targetHasSlope
              ? resolveIceSlopeTraversal(
                  state,
                  targetX,
                  targetY,
                  dx,
                  dy,
                  memberElevation,
                  occupied,
                  gateState,
                  orangeButtonsPressed
                )
              : null;

            if (targetHasSlope && slopeIgnoredActors === null) {
              slopeIgnoredActors = new Set(ignoredActors);
              weightlessClusterMembers(state, clusterGroupIds, actorType).forEach(
                (clusterMember) => slopeIgnoredActors.add(clusterMember)
              );
            }

            const blockedSlope =
              !targetHasSlope || slopeTraversal
                ? null
                : blockedIceSlopePushForEntry(
                    state,
                    targetX,
                    targetY,
                    dx,
                    dy,
                    memberElevation,
                    occupied,
                    gateState,
                    orangeButtonsPressed,
                    slopeIgnoredActors
                  );
            const fallSlopeTraversal =
              !targetHasSlope || slopeTraversal || blockedSlope
                ? null
                : resolveIceSlopeFallTraversalForLanding(
                    state,
                    targetX,
                    targetY,
                    memberElevation,
                    occupied,
                    gateState,
                    orangeButtonsPressed
                  );
            const topSlopeTraversal =
              !targetHasSlope || slopeTraversal || blockedSlope || fallSlopeTraversal
                ? null
                : resolveIceSlopeTopSlideTraversal(
                    state,
                    targetX,
                    targetY,
                    memberElevation,
                    occupied,
                    gateState,
                    orangeButtonsPressed
                  );
            const blockedSlopeBouncePath =
              !targetHasSlope || slopeTraversal || blockedSlope || fallSlopeTraversal || topSlopeTraversal
                ? null
                : blockedIceSlopeBouncePathForEntry(
                    state,
                    targetX,
                    targetY,
                    dx,
                    dy,
                    memberElevation,
                    occupied,
                    gateState,
                    orangeButtonsPressed
                  );
            const canBounceBackFromSlope =
              blockedSlopeBouncePath &&
              blockedSlopeBouncePath.length > 0 &&
              isIce(
                state,
                state.actorX[member],
                state.actorY[member],
                memberElevation,
                gateState,
                orangeButtonsPressed
              );

            if (
              !slopeTraversal &&
              !blockedSlope &&
              !fallSlopeTraversal &&
              !topSlopeTraversal &&
              !canBounceBackFromSlope &&
              !canWeightlessMemberEnter(
                state,
                member,
                targetX,
                targetY,
                memberElevation,
                gateState,
                orangeButtonsPressed,
                { blockSupportSide: true }
              ) &&
              !(
                canStartIceSlopeTransit &&
                terrainBlocksOnlyByIceSlope(
                  state,
                  targetX,
                  targetY,
                  memberElevation,
                  gateState,
                  orangeButtonsPressed
                )
              )
            ) {
              blockers.push(null);
              return;
            }

            if (
              slopeTraversal ||
              blockedSlope ||
              fallSlopeTraversal ||
              topSlopeTraversal ||
              canBounceBackFromSlope
            ) {
              continue;
            }

            // O(1) grid probe replaces the per-member O(actorCount) scan.
            const blockerCandidate = blockingActorAtSlot(targetX, targetY, memberElevation);
            const blocker =
              blockerCandidate !== -1 &&
              !ignoredActors.has(blockerCandidate) &&
              blockerCandidate !== member &&
              !(
                actorTypes[blockerCandidate] === actorType &&
                clusterGroupIds.has(actorGroupIds[blockerCandidate])
              )
                ? blockerCandidate
                : -1;

            if (blocker === -1) {
              continue;
            }

            if (!isPushableActor(blocker)) {
              blockers.push(null);
              return;
            }

            if (actorTypes[blocker] === actorType) {
              if (!clusterGroupIds.has(actorGroupIds[blocker])) {
                clusterGroupIds.add(actorGroupIds[blocker]);
                expanded = true;
              }

              continue;
            }

            const blockerKey = pushEntityKey(blocker);

            if (!blockerKeys.has(blockerKey)) {
              blockers.push(blocker);
              blockerKeys.add(blockerKey);
            }
          }
        });

        if (blockers.includes(null)) {
          return null;
        }
      }

      return {
        blockers,
        groupIds: Array.from(clusterGroupIds)
      };
    }

    function cloneGroupCanRideSupportPath(
      state,
      startPositions,
      rideOffsets,
      occupied,
      gateState,
      orangeButtonsPressed
    ) {
      if (!Array.isArray(rideOffsets) || rideOffsets.length < 2) {
        return false;
      }

      const finalOffset = rideOffsets[rideOffsets.length - 1];
      const memberSet = new Set(startPositions.map((position) => position.actorIndex));
      const finalKeys = new Set();
      const finalPositions = startPositions.map((position) => ({
        actorIndex: position.actorIndex,
        x: position.fromX + finalOffset.dx,
        y: position.fromY + finalOffset.dy,
        elevation: position.fromElevation + finalOffset.elevation
      }));

      for (const position of finalPositions) {
        const key = occupiedElevationKey(position.x, position.y, position.elevation);

        if (finalKeys.has(key)) {
          return false;
        }

        finalKeys.add(key);

        if (
          !weightlessMemberCanOccupy(
            state,
            position.actorIndex,
            position.x,
            position.y,
            position.elevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            { blockSupportSide: finalOffset.dx !== 0 || finalOffset.dy !== 0 }
          )
        ) {
          return false;
        }
      }

      return finalPositions.some((position) => {
        const selfSupportKey = occupiedElevationKey(
          position.x,
          position.y,
          position.elevation - 1
        );

        return (
          finalKeys.has(selfSupportKey) ||
          terrainSupportsElevation(
            state,
            position.x,
            position.y,
            position.elevation,
            gateState,
            orangeButtonsPressed
          ) ||
          actorSupportSurfaceHeightsAt(
            state,
            position.x,
            position.y,
            memberSet,
            true
          ).includes(position.elevation)
        );
      });
    }

    function moveCloneGroupAlongSupportPath(
      state,
      members,
      rideOffsets,
      occupied,
      moves,
      gateState,
      orangeButtonsPressed,
      searchMode,
      options = {}
    ) {
      const startPositions = members.map((actorIndex) => ({
        actorIndex,
        fromElevation: actorElevation(state, actorIndex),
        fromX: state.actorX[actorIndex],
        fromY: state.actorY[actorIndex]
      }));

      if (
        !cloneGroupCanRideSupportPath(
          state,
          startPositions,
          rideOffsets,
          occupied,
          gateState,
          orangeButtonsPressed
        )
      ) {
        return false;
      }

      const finalOffset = rideOffsets[rideOffsets.length - 1];

      startPositions.forEach(({ actorIndex, fromElevation, fromX, fromY }) => {
        const path = rideOffsets.map((offset) => ({
          x: fromX + offset.dx,
          y: fromY + offset.dy,
          elevation: fromElevation + offset.elevation
        }));

        jSetActorX(state, actorIndex, fromX + finalOffset.dx);
        jSetActorY(state, actorIndex, fromY + finalOffset.dy);
        jSetActorElevation(state, actorIndex, fromElevation + finalOffset.elevation);

        const moveRecord = {
          actorIndex,
          actorType: actorTypes[actorIndex],
          fromElevation,
          fromX,
          fromY,
          toElevation: actorElevation(state, actorIndex),
          toX: state.actorX[actorIndex],
          toY: state.actorY[actorIndex]
        };
        const pathControlsElevation = path.some((point) => point.elevation !== fromElevation);

        if (path.length > 2 || pathControlsElevation) {
          moveRecord.path = path;
          moveRecord.pathControlsElevation = pathControlsElevation;
          moveRecord.pathEndElevation = path[path.length - 1]?.elevation ?? actorElevation(state, actorIndex);
        }

        if (!searchMode) {
          moveRecord.iceSlide =
            path.length > 2 ||
            pathControlsElevation ||
            Math.abs(state.actorX[actorIndex] - fromX) +
              Math.abs(state.actorY[actorIndex] - fromY) >
              1 ||
            actorElevation(state, actorIndex) !== fromElevation;
        }

        moves.push(moveRecord);
        addOccupiedAtElevation(
          occupied,
          state.actorX[actorIndex],
          state.actorY[actorIndex],
          actorElevation(state, actorIndex)
        );
      });

      const carriedRiders =
        Array.isArray(options.carriedRiders) && options.carriedRiders.length > 0
          ? options.carriedRiders
          : [];

      carriedRiders.forEach((rider) => {
        const supportMove = moves
          .slice(options.moveStartIndex || 0)
          .find((move) => move.actorIndex === rider.supportMember && !move.visualOnly);

        if (!supportMove) {
          addOccupiedAtElevation(occupied, rider.fromX, rider.fromY, rider.fromElevation);
          return;
        }

        const path = riderPathForSupportMove(supportMove, rider);

        // FIX(SEMANTICS §clones): validate EVERY step of the carried rider's
        // path. Legacy validated only the first step, so a clone sliding
        // multiple cells on ice dragged its rider straight into solid
        // terrain — the player ended embedded in a block, a state legal
        // movement can never reach. The ride truncates at the last legal
        // point; if the support slides on without the rider, the dynamic
        // fall pass drops the rider to real support.
        let riderValidLength = 1;

        for (let pointIndex = 1; pointIndex < path.length; pointIndex += 1) {
          const point = path[pointIndex];

          if (
            !isInsideBoard(point.x, point.y) ||
            terrainBlocksElevation(
              state,
              point.x,
              point.y,
              point.elevation,
              gateState,
              orangeButtonsPressed
            ) ||
            blockingActorAtElevation(
              state,
              point.x,
              point.y,
              point.elevation,
              rider.actorIndex
            ) !== -1
          ) {
            break;
          }

          riderValidLength = pointIndex + 1;
        }

        if (riderValidLength < path.length) {
          path.length = riderValidLength;
        }

        const finalPoint = path[path.length - 1];
        const toX = finalPoint?.x ?? rider.fromX;
        const toY = finalPoint?.y ?? rider.fromY;
        const toElevation = finalPoint?.elevation ?? rider.fromElevation;
        const moveRecord = {
          actorIndex: rider.actorIndex,
          actorType: actorTypes[rider.actorIndex],
          fromElevation: rider.fromElevation,
          fromX: rider.fromX,
          fromY: rider.fromY,
          toElevation,
          toX,
          toY
        };

        if (path.length > 2 || path.some((point) => point.elevation !== rider.fromElevation)) {
          moveRecord.path = path;
          moveRecord.pathControlsElevation = path.some(
            (point) => point.elevation !== rider.fromElevation
          );
          moveRecord.pathEndElevation = path[path.length - 1]?.elevation ?? toElevation;
        }

        if (!searchMode && supportMove.iceSlide === true) {
          moveRecord.iceSlide = true;
        }

        jSetActorX(state, rider.actorIndex, toX);
        jSetActorY(state, rider.actorIndex, toY);
        jSetActorElevation(state, rider.actorIndex, toElevation);
        moves.push(moveRecord);
        addOccupiedAtElevation(occupied, toX, toY, toElevation);

        if (options.carriedPlayers instanceof Set) {
          options.carriedPlayers.add(rider.actorIndex);
        }
      });

      return true;
    }

    function moveWeightlessCluster(
      state,
      groupIds,
      dx,
      dy,
      occupied,
      moves,
      gateState,
      orangeButtonsPressed,
      searchMode,
      pushContext = null,
      actorType = "weightless_box",
      options = {}
    ) {
      const members = weightlessClusterMembers(state, groupIds, actorType);

      if (members.length === 0) {
        return false;
      }

      const startPositions = members.map((actorIndex) => ({
        actorIndex,
        fromElevation: actorElevation(state, actorIndex),
        fromX: state.actorX[actorIndex],
        fromY: state.actorY[actorIndex],
        path: [
          {
            x: state.actorX[actorIndex],
            y: state.actorY[actorIndex],
            elevation: actorElevation(state, actorIndex)
          }
        ]
      }));
      const startPositionByActor = new Map(
        startPositions.map((position) => [position.actorIndex, position])
      );
      const carriedRiders =
        Array.isArray(options.carriedRiders) && options.carriedRiders.length > 0
          ? options.carriedRiders
          : [];
      members.forEach((member) => {
        removeOccupiedAtElevation(
          occupied,
          state.actorX[member],
          state.actorY[member],
          actorElevation(state, member)
        );
      });
      carriedRiders.forEach((rider) => {
        removeOccupiedAtElevation(
          occupied,
          rider.fromX,
          rider.fromY,
          rider.fromElevation
        );
      });
      const ignoredActors = new Set(pushContext?.ignoredActors || []);
      members.forEach((member) => ignoredActors.add(member));
      carriedRiders.forEach((rider) => ignoredActors.add(rider.actorIndex));

      let moved = false;
      let stepDx = dx;
      let stepDy = dy;
      let reversedAfterSlopeBounce = false;
      const predictedSupports = Array.isArray(pushContext?.predictedSupports)
        ? pushContext.predictedSupports
        : null;
      // Cycle guard. Certain slope+ice geometries let a sliding cluster loop
      // forever (ascend a slope, fall in behind it, slide forward again): the
      // legacy engine hung in this loop growing path arrays without bound
      // (observed as a multi-GB OOM inside a single move on level_AxE). If
      // the cluster revisits a (position, direction) it has already been in
      // during THIS slide, the slide ends there.
      const seenSlideSignatures = new Set();
      const anchorMember = members.length > 0 ? members[0] : -1;

      while (true) {
        if (anchorMember !== -1) {
          const signature =
            (((state.actorElevation[anchorMember] + 4) * 128 + state.actorY[anchorMember] + 2) * 128 +
              state.actorX[anchorMember] + 2) *
              8 +
            (stepDx + 1) * 2 +
            (stepDy + 1) +
            (reversedAfterSlopeBounce ? 40000000 : 0);

          if (seenSlideSignatures.has(signature)) {
            break;
          }

          seenSlideSignatures.add(signature);
        }

        const attemptJournalMark = pushContext ? journalMark() : -1;
        const moveCount = moves.length;
        const allowIceSlopeTransit = weightlessClusterHasIceSlopeTransit(
          state,
          members,
          gateState,
          orangeButtonsPressed
        );
        const step = weightlessClusterStep(
          state,
          members,
          stepDx,
          stepDy,
          occupied,
          gateState,
          orangeButtonsPressed,
          pushContext
            ? {
              ignoredActors,
              allowIceSlopeTransit,
              allowLowerSlopeFallTraversal: actorType !== "clone",
              pushSlopeBlocker: (blocker, pushDx = stepDx, pushDy = stepDy) => {
                  if (ignoredActors.has(blocker)) {
                    return false;
                  }

                  const result = attemptPushActor(
                    state,
                    blocker,
                    pushDx,
                    pushDy,
                    occupied,
                    moves,
                    1,
                    pushContext.handled || new Set(),
                    gateState,
                    orangeButtonsPressed,
                    ignoredActors,
                    searchMode,
                    pushContext
                  );

                  return result !== null;
                }
              }
            : {
                allowIceSlopeTransit,
                allowLowerSlopeFallTraversal: actorType !== "clone"
              }
        );

        if (!step) {
          const bounceOffsets = !reversedAfterSlopeBounce
            ? weightlessClusterBlockedSlopeBounceOffsets(
                state,
                members,
                stepDx,
                stepDy,
                occupied,
                gateState,
                orangeButtonsPressed
              )
            : null;

          if (bounceOffsets && bounceOffsets.length > 0) {
            if (pushContext) {
              journalRollback(state, attemptJournalMark);
              occupancyRebuild(state, -1, ignoredActors);
              moves.length = moveCount;
            }

            members.forEach((member) => {
              const start = startPositionByActor.get(member);
              const fromElevation = actorElevation(state, member);
              const fromX = state.actorX[member];
              const fromY = state.actorY[member];

              if (start) {
                appendPathPoints(
                  start.path,
                  bounceOffsets.map((point) => ({
                    x: fromX + point.dx,
                    y: fromY + point.dy,
                    elevation: fromElevation + point.elevation
                  }))
                );
              }
            });
            stepDx = -stepDx;
            stepDy = -stepDy;
            reversedAfterSlopeBounce = true;
            continue;
          }

          if (pushContext) {
            journalRollback(state, attemptJournalMark);
            occupancyRebuild(state, -1, ignoredActors);
            moves.length = moveCount;
          }
          break;
        }

        if (
          actorType === "clone" &&
          !clusterHasSupportedMemberAfterStep(
            state,
            members,
            step,
            occupied,
            gateState,
            orangeButtonsPressed,
            predictedSupports,
            { allowEmptyPitEntry: true }
          )
        ) {
          break;
        }

        members.forEach((member) => {
          const start = startPositionByActor.get(member);
          const fromElevation = actorElevation(state, member);
          const fromX = state.actorX[member];
          const fromY = state.actorY[member];
          const pathOffsets = Array.isArray(step.pathOffsets) ? step.pathOffsets : [];

          if (start) {
            if (pathOffsets.length > 0) {
              appendPathPoints(
                start.path,
                pathOffsets.map((point) => ({
                  x: fromX + point.dx,
                  y: fromY + point.dy,
                  elevation: fromElevation + point.elevation
                }))
              );
            } else if (Math.abs(step.dx) > 1 || Math.abs(step.dy) > 1 || step.elevation !== 0) {
              appendPathPoints(start.path, [
                {
                  x: fromX + step.dx / 2,
                  y: fromY + step.dy / 2,
                  elevation: fromElevation + step.elevation / 2
                }
              ]);
            }
          }

          jSetActorX(state, member, state.actorX[member] + step.dx);
          jSetActorY(state, member, state.actorY[member] + step.dy);
          jSetActorElevation(state, member, state.actorElevation[member] + step.elevation);

          if (start) {
            appendPathPoints(start.path, [
              {
                x: state.actorX[member],
                y: state.actorY[member],
                elevation: actorElevation(state, member)
              }
            ]);
          }
        });

        let settledDown = false;
        const supportCheckMemberSet = new Set(members);

        function appendSettledPathPoint() {
          members.forEach((member) => {
            const start = startPositionByActor.get(member);

            if (!start) {
              return;
            }

            appendPathPoints(start.path, [
              {
                x: state.actorX[member],
                y: state.actorY[member],
                elevation: actorElevation(state, member)
              }
            ]);
          });
        }

        const hasPendingPuncherTrigger = members.some(
          (member) =>
            puncherActorAt(
              state,
              state.actorX[member],
              state.actorY[member],
              actorElevation(state, member)
            ) !== -1
        );

        while (
          !hasPendingPuncherTrigger &&
          settleWeightlessClusterDownOneLayer(
            state,
            members,
            occupied,
            gateState,
            orangeButtonsPressed,
            predictedSupports
          )
        ) {
          const hasSupportAfterSettling = members.some((member) =>
            weightlessMemberHasCurrentSupport(
              state,
              member,
              gateState,
              orangeButtonsPressed,
              supportCheckMemberSet,
              predictedSupports
            )
          );
          const fullyAtOrBelowFloor = members.every((member) => actorElevation(state, member) <= 0);

          appendSettledPathPoint();
          settledDown = true;

          if (hasSupportAfterSettling || fullyAtOrBelowFloor) {
            break;
          }
        }

        moved = true;

        if (
          members.every((member) =>
            isHole(state, state.actorX[member], state.actorY[member], actorElevation(state, member))
          )
        ) {
          break;
        }

        if (settledDown) {
          break;
        }

        if (
          !weightlessClusterShouldContinueSliding(
            state,
            members,
            gateState,
            orangeButtonsPressed,
            predictedSupports
          )
        ) {
          break;
        }
      }

      if (!moved) {
        startPositions.forEach(({ fromElevation, fromX, fromY }) => {
          addOccupiedAtElevation(occupied, fromX, fromY, fromElevation);
        });
        carriedRiders.forEach((rider) => {
          addOccupiedAtElevation(occupied, rider.fromX, rider.fromY, rider.fromElevation);
        });
        return false;
      }

      startPositions.forEach(({ actorIndex, fromElevation, fromX, fromY, path }) => {
        const moveRecord = {
          actorIndex,
          actorType: actorTypes[actorIndex],
          fromElevation,
          fromX,
          fromY,
          toElevation: actorElevation(state, actorIndex),
          toX: state.actorX[actorIndex],
          toY: state.actorY[actorIndex]
        };
        const pathControlsElevation = path.some((point) => point.elevation !== fromElevation);

        if (path.length > 2 || pathControlsElevation) {
          moveRecord.path = path;
          moveRecord.pathControlsElevation = pathControlsElevation;
          moveRecord.pathEndElevation = path[path.length - 1]?.elevation ?? actorElevation(state, actorIndex);
        }

        if (!searchMode) {
          moveRecord.iceSlide =
            path.length > 2 ||
            pathControlsElevation ||
            Math.abs(state.actorX[actorIndex] - fromX) +
              Math.abs(state.actorY[actorIndex] - fromY) >
              1 ||
            actorElevation(state, actorIndex) !== fromElevation;
        }

        moves.push(moveRecord);
      });

      members.forEach((member) => {
        addOccupiedAtElevation(
          occupied,
          state.actorX[member],
          state.actorY[member],
          actorElevation(state, member)
        );
      });

      carriedRiders.forEach((rider) => {
        const supportMove = moves
          .slice(options.moveStartIndex || 0)
          .find((move) => move.actorIndex === rider.supportMember && !move.visualOnly);

        if (!supportMove) {
          addOccupiedAtElevation(occupied, rider.fromX, rider.fromY, rider.fromElevation);
          return;
        }

        const path = riderPathForSupportMove(supportMove, rider);

        // FIX(SEMANTICS §clones): validate EVERY step of the carried rider's
        // path. Legacy validated only the first step, so a clone sliding
        // multiple cells on ice dragged its rider straight into solid
        // terrain — the player ended embedded in a block, a state legal
        // movement can never reach. The ride truncates at the last legal
        // point; if the support slides on without the rider, the dynamic
        // fall pass drops the rider to real support.
        let riderValidLength = 1;

        for (let pointIndex = 1; pointIndex < path.length; pointIndex += 1) {
          const point = path[pointIndex];

          if (
            !isInsideBoard(point.x, point.y) ||
            terrainBlocksElevation(
              state,
              point.x,
              point.y,
              point.elevation,
              gateState,
              orangeButtonsPressed
            ) ||
            blockingActorAtElevation(
              state,
              point.x,
              point.y,
              point.elevation,
              rider.actorIndex
            ) !== -1
          ) {
            break;
          }

          riderValidLength = pointIndex + 1;
        }

        if (riderValidLength < path.length) {
          path.length = riderValidLength;
        }

        const finalPoint = path[path.length - 1];
        const toX = finalPoint?.x ?? rider.fromX;
        const toY = finalPoint?.y ?? rider.fromY;
        const toElevation = finalPoint?.elevation ?? rider.fromElevation;
        const moveRecord = {
          actorIndex: rider.actorIndex,
          actorType: actorTypes[rider.actorIndex],
          fromElevation: rider.fromElevation,
          fromX: rider.fromX,
          fromY: rider.fromY,
          toElevation,
          toX,
          toY
        };

        if (path.length > 2 || path.some((point) => point.elevation !== rider.fromElevation)) {
          moveRecord.path = path;
          moveRecord.pathControlsElevation = path.some(
            (point) => point.elevation !== rider.fromElevation
          );
          moveRecord.pathEndElevation = path[path.length - 1]?.elevation ?? toElevation;
        }

        if (!searchMode && supportMove.iceSlide === true) {
          moveRecord.iceSlide = true;
        }

        jSetActorX(state, rider.actorIndex, toX);
        jSetActorY(state, rider.actorIndex, toY);
        jSetActorElevation(state, rider.actorIndex, toElevation);
        moves.push(moveRecord);
        addOccupiedAtElevation(occupied, toX, toY, toElevation);

        if (options.carriedPlayers instanceof Set) {
          options.carriedPlayers.add(rider.actorIndex);
        }
      });

      return true;
    }

    function attemptPushActor(
      state,
      actorIndex,
      dx,
      dy,
      occupied,
      moves,
      budget,
      handled = new Set(),
      gateState,
      orangeButtonsPressed,
      ignoredActors = new Set(),
      searchMode = false,
      pushContext = null
    ) {
      const entityKey = pushEntityKey(actorIndex);

      if (handled.has(entityKey)) {
        return budget;
      }

      const cost = pushWeightForType(actorTypes[actorIndex]);

      if (budget < cost) {
        return null;
      }

      let remainingBudget = budget - cost;
      const blockers = [];
      let movingMembers = [];
      let carriedRiders = [];
      let weightlessCluster = null;

      if (actorTypes[actorIndex] === "weightless_box") {
        // A rigid cluster member can sweep into a rider's current voxel while
        // the rider simultaneously vacates it with another support member.
        // Discover those riders before collision collection so the preflight
        // treats the whole carrier+rider move as one transaction. Re-run if
        // collection expands the moving cluster and exposes more riders.
        const riderAwareIgnoredActors = new Set(ignoredActors);
        movingMembers = weightlessGroupMembers(state, actorGroupIds[actorIndex]);
        cloneRidersForMove(
          state,
          movingMembers,
          dx,
          dy,
          gateState,
          orangeButtonsPressed,
          ignoredActors
        ).forEach((rider) => riderAwareIgnoredActors.add(rider.actorIndex));

        while (true) {
          weightlessCluster = collectWeightlessPushCluster(
            state,
            actorGroupIds[actorIndex],
            dx,
            dy,
            occupied,
            gateState,
            orangeButtonsPressed,
            riderAwareIgnoredActors
          );

          if (!weightlessCluster) {
            return null;
          }

          movingMembers = weightlessClusterMembers(state, weightlessCluster.groupIds);
          carriedRiders = cloneRidersForMove(
            state,
            movingMembers,
            dx,
            dy,
            gateState,
            orangeButtonsPressed,
            ignoredActors
          );

          let addedRider = false;

          carriedRiders.forEach((rider) => {
            if (!riderAwareIgnoredActors.has(rider.actorIndex)) {
              riderAwareIgnoredActors.add(rider.actorIndex);
              addedRider = true;
            }
          });

          if (!addedRider) {
            break;
          }
        }
      }

      if (actorTypes[actorIndex] === "weightless_box") {
        blockers.push(...weightlessCluster.blockers);
      } else {
        const members = pushActorMembers(state, actorIndex);
        movingMembers = members;
        const memberSet = new Set(members);
        const blockerKeys = new Set();

        for (const member of members) {
          const targetX = state.actorX[member] + dx;
          const targetY = state.actorY[member] + dy;
          const memberElevation = actorElevation(state, member);
          const canEnterHole = memberElevation === 0 && isHole(state, targetX, targetY, 0);
          let slopeTraversal = resolveIceSlopeTraversal(
            state,
            targetX,
            targetY,
            dx,
            dy,
            memberElevation,
            occupied,
            gateState,
            orangeButtonsPressed
          );
          const blockedSlope = slopeTraversal
            ? null
            : blockedIceSlopePushForEntry(
                state,
                targetX,
                targetY,
                dx,
                dy,
                memberElevation,
                occupied,
                gateState,
                orangeButtonsPressed,
                new Set([...ignoredActors, ...memberSet])
              );
          const fallSlopeTraversal =
            slopeTraversal || blockedSlope
              ? null
              : resolveIceSlopeFallTraversalForLanding(
                  state,
                  targetX,
                  targetY,
                  memberElevation,
                  occupied,
                  gateState,
                  orangeButtonsPressed
                );
          const topSlopeTraversal =
            slopeTraversal || blockedSlope || fallSlopeTraversal
              ? null
              : resolveIceSlopeTopSlideTraversal(
                  state,
                  targetX,
                  targetY,
                  memberElevation,
                  occupied,
                  gateState,
                  orangeButtonsPressed
                );
          const slideTraversal = slopeTraversal || fallSlopeTraversal || topSlopeTraversal;
          const blockedSlopeBouncePath =
            slideTraversal || blockedSlope
              ? null
              : blockedIceSlopeBouncePathForEntry(
                  state,
                  targetX,
                  targetY,
                  dx,
                  dy,
                  memberElevation,
                  occupied,
                  gateState,
                  orangeButtonsPressed
                );
          const canBounceBackFromSlope =
            blockedSlopeBouncePath &&
            blockedSlopeBouncePath.length > 0 &&
            isIce(state, state.actorX[member], state.actorY[member], memberElevation, gateState, orangeButtonsPressed);
          const blockerX = slideTraversal
            ? slideTraversal.exitX
            : blockedSlope
              ? blockedSlope.traversal.exitX
              : targetX;
          const blockerY = slideTraversal
            ? slideTraversal.exitY
            : blockedSlope
              ? blockedSlope.traversal.exitY
              : targetY;
          const blockerElevation = slideTraversal
            ? slideTraversal.exitElevation
            : blockedSlope
              ? blockedSlope.traversal.exitElevation
              : memberElevation;

          if (
            !isInsideBoard(targetX, targetY) ||
            (!slideTraversal &&
              !blockedSlope &&
              !canBounceBackFromSlope &&
              !canEnterHole &&
              !terrainSupportsElevation(
                state,
                targetX,
                targetY,
                memberElevation,
                gateState,
                orangeButtonsPressed
              ))
          ) {
            return null;
          }

          if (blockedSlope) {
            continue;
          }

          const blocker = actorAt(
            state,
            blockerX,
            blockerY,
            (candidate) =>
              !ignoredActors.has(candidate) &&
              !memberSet.has(candidate) &&
              !isNonBlockingActor(candidate) &&
              actorElevation(state, candidate) === blockerElevation
          );

          if (blocker === -1) {
            continue;
          }

          if (!isPushableActor(blocker)) {
            return null;
          }

          const blockerKey = pushEntityKey(blocker);

          if (!blockerKeys.has(blockerKey)) {
            blockers.push(blocker);
            blockerKeys.add(blockerKey);
          }
        }
      }

      const moveStartIndex = moves.length;

      if (actorTypes[actorIndex] !== "weightless_box") {
        carriedRiders = cloneRidersForMove(
          state,
          movingMembers,
          dx,
          dy,
          gateState,
          orangeButtonsPressed,
          ignoredActors
        );
      }

      for (const blocker of blockers) {
        const result = attemptPushActor(
          state,
          blocker,
          dx,
          dy,
          occupied,
          moves,
          remainingBudget,
          handled,
          gateState,
          orangeButtonsPressed,
          ignoredActors,
          searchMode,
          pushContext
        );

        if (result === null) {
          return null;
        }

        remainingBudget = result;
      }

      const moved =
        actorTypes[actorIndex] === "weightless_box"
          ? moveWeightlessCluster(
              state,
              weightlessCluster.groupIds,
              dx,
              dy,
              occupied,
              moves,
              gateState,
              orangeButtonsPressed,
              searchMode,
              {
                handled,
                ignoredActors,
                predictedSupports: pushContext?.predictedSupports || null
              },
              "weightless_box",
              {
                carriedPlayers: pushContext?.carriedPlayers,
                carriedRiders,
                moveStartIndex
              }
            )
          : moveBox(
              state,
              actorIndex,
              dx,
              dy,
              occupied,
              moves,
              gateState,
              orangeButtonsPressed,
              searchMode,
              {
                handled,
                ignoredActors,
                // FIX(SEMANTICS R3a): the surplus of the push train travels
                // with the sliding box, so a slope-exit blocker chain met
                // mid-slide can spend it.
                remainingBudget,
                pusherX: pushContext?.pusherX,
                pusherY: pushContext?.pusherY,
                pusherElevation: pushContext?.pusherElevation,
                carriedPlayers: pushContext?.carriedPlayers,
                carriedRiders,
                moveStartIndex
              }
            );

      if (!moved) {
        return null;
      }

      if (actorTypes[actorIndex] === "weightless_box") {
        weightlessCluster.groupIds.forEach((groupId) => {
          handled.add(`weightless:${groupId}`);
        });
      } else {
        handled.add(entityKey);
      }

      return remainingBudget;
    }

    function puncherActorAt(state, x, y, elevation) {
      return actorAt(
        state,
        x,
        y,
        (actor) => isPuncherActor(actor) && actorElevation(state, actor) === elevation
      );
    }

    function punchTriggerActorAt(state, x, y, elevation) {
      return actorAt(
        state,
        x,
        y,
        (actor) =>
          actorElevation(state, actor) === elevation &&
          (isPlayerActor(actor) || isPushableActor(actor))
      );
    }

    // Owner rule (2026-07): clones carry side-mounted punchers exactly like
    // the box family does — a puncher attached to a moving thing moves with it.
    function canPunchActorCarryPuncher(type) {
      return (
        type === "box" ||
        type === "floating_floor" ||
        type === "weightless_box" ||
        type === "clone"
      );
    }

    // FIX(SEMANTICS §clones): clones carry surface attachments too — the
    // editor explicitly allows stacking an orange button on a clone, and the
    // legacy whitelist stranded the button in mid-air on the clone's first
    // move, permanently locking every orange wall in the level.
    function canActorCarrySurfaceAttachment(type) {
      return (
        type === "box" ||
        type === "floating_floor" ||
        type === "weightless_box" ||
        type === "clone"
      );
    }

    function mergeMoveRecord(
      state,
      moves,
      actorIndex,
      originalActorX,
      originalActorY,
      originalActorElevation,
      options = {}
    ) {
      let moveRecord = moves.find((move) => move.actorIndex === actorIndex && !move.visualOnly);

      if (!moveRecord) {
        moveRecord = {
          actorIndex,
          actorType: actorTypes[actorIndex],
          fromX: originalActorX[actorIndex],
          fromY: originalActorY[actorIndex],
          toX: state.actorX[actorIndex],
          toY: state.actorY[actorIndex],
          fromElevation: originalActorElevation[actorIndex] || 0,
          toElevation: actorElevation(state, actorIndex)
        };
        moves.push(moveRecord);
      }

      moveRecord.toX = state.actorX[actorIndex];
      moveRecord.toY = state.actorY[actorIndex];
      moveRecord.toElevation = actorElevation(state, actorIndex);

      if (options.iceSlide === true) {
        moveRecord.iceSlide = true;
      }

      if (options.punchSlide === true) {
        moveRecord.punchSlide = true;
      }

      return moveRecord;
    }

    function movePathForMerge(move) {
      const fromElevation = move.fromElevation ?? 0;
      const toElevation = move.toElevation ?? fromElevation;
      const path = Array.isArray(move.path)
        ? move.path
            .map((point) => ({
              x: Number(point?.x),
              y: Number(point?.y),
              elevation: Number(point?.elevation)
            }))
            .filter(
              (point) =>
                Number.isFinite(point.x) &&
                Number.isFinite(point.y) &&
                Number.isFinite(point.elevation)
            )
        : [];

      if (path.length > 0) {
        return path;
      }

      return [
        { x: move.fromX, y: move.fromY, elevation: fromElevation },
        { x: move.toX, y: move.toY, elevation: toElevation }
      ];
    }

    function mergeActorMoveData(target, source) {
      const targetPath = movePathForMerge(target);
      const sourcePath = movePathForMerge(source);

      appendPathPoints(targetPath, sourcePath);

      target.toX = source.toX;
      target.toY = source.toY;
      target.toElevation = source.toElevation ?? target.toElevation ?? target.fromElevation ?? 0;
      target.finalX = source.finalX ?? target.finalX;
      target.finalY = source.finalY ?? target.finalY;
      target.finalElevation = source.finalElevation ?? target.finalElevation;
      target.iceSlide = target.iceSlide === true || source.iceSlide === true || targetPath.length > 2;

      if (source.toRemoved === true || target.toRemoved === true) {
        target.toRemoved = true;
      }

      if (source.punchSlide === true) {
        target.punchSlide = true;
      }

      if (source.iceSlipOff === true) {
        target.iceSlipOff = true;
      }

      if (source.visibleDuringMove === true) {
        target.visibleDuringMove = true;
      }

      if (source.skipHoleFall === true) {
        target.skipHoleFall = true;
      }

      if (source.snapHoleRestore === true) {
        target.snapHoleRestore = true;
      }

      if (source.fadeOut === true) {
        target.fadeOut = true;
      }

      if (source.fadeStartProgress !== undefined) {
        target.fadeStartProgress = source.fadeStartProgress;
      }

      if (source.fadeEndProgress !== undefined) {
        target.fadeEndProgress = source.fadeEndProgress;
      }

      if (source.fillsHole === true) {
        target.fillsHole = true;
        target.fillHoleX = source.fillHoleX ?? target.fillHoleX;
        target.fillHoleY = source.fillHoleY ?? target.fillHoleY;
        target.fillHolePreviousTerrain =
          source.fillHolePreviousTerrain ?? target.fillHolePreviousTerrain;
      }

      if (typeof source.punchStartX === "number" && typeof target.punchStartX !== "number") {
        target.punchStartX = source.punchStartX;
        target.punchStartY = source.punchStartY;
        target.punchStartElevation = source.punchStartElevation;
        target.punchStartIceSlide = source.punchStartIceSlide;
      }

      if (Array.isArray(source.punchSegments) && source.punchSegments.length > 0) {
        const targetSegments = Array.isArray(target.punchSegments) ? target.punchSegments : [];

        target.punchSegments = targetSegments.concat(
          source.punchSegments.map((segment) => ({ ...segment }))
        );
      }

      if (
        targetPath.length > 2 ||
        targetPath.some((point) => point.elevation !== (target.fromElevation ?? 0))
      ) {
        target.path = targetPath;
        target.pathControlsElevation = targetPath.some(
          (point) => point.elevation !== (target.fromElevation ?? 0)
        );
        target.pathEndElevation = targetPath[targetPath.length - 1]?.elevation ?? target.toElevation;
      } else {
        delete target.path;
        delete target.pathControlsElevation;
        delete target.pathEndElevation;
      }

      return target;
    }

    function collapseSequentialActorMoves(moves) {
      const collapsed = [];
      const moveByActor = new Map();

      moves.forEach((move) => {
        if (move.visualOnly || typeof move.actorIndex !== "number") {
          collapsed.push(move);
          return;
        }

        const existing = moveByActor.get(move.actorIndex);

        if (!existing) {
          moveByActor.set(move.actorIndex, move);
          collapsed.push(move);
          return;
        }

        mergeActorMoveData(existing, move);
      });

      if (collapsed.length !== moves.length) {
        moves.length = 0;
        collapsed.forEach((move) => moves.push(move));
      }
    }

    function punchStartSnapshotsForMembers(state, members, moves) {
      return members.map((member) => {
        const moveRecord = moves.find((move) => move.actorIndex === member && !move.visualOnly);

        return {
          actorIndex: member,
          elevation: actorElevation(state, member),
          iceSlide: moveRecord?.iceSlide === true,
          x: state.actorX[member],
          y: state.actorY[member]
        };
      });
    }

    function markPunchStartOnMoves(moves, punchStarts) {
      punchStarts.forEach(({ actorIndex, elevation, iceSlide, x, y }) => {
        const moveRecord = moves.find((move) => move.actorIndex === actorIndex && !move.visualOnly);

        if (!moveRecord || typeof moveRecord.punchStartX === "number") {
          return;
        }

        moveRecord.punchStartX = x;
        moveRecord.punchStartY = y;
        moveRecord.punchStartElevation = elevation;
        moveRecord.punchStartIceSlide = iceSlide === true;
      });
    }

    function recordPunchSegments(state, moves, punchStarts, sequence, searchMode) {
      if (searchMode) {
        return;
      }

      punchStarts.forEach(({ actorIndex, elevation, iceSlide, x, y }) => {
        const moveRecord = moves.find((move) => move.actorIndex === actorIndex && !move.visualOnly);

        if (!moveRecord) {
          return;
        }

        if (!Array.isArray(moveRecord.punchSegments)) {
          moveRecord.punchSegments = [];
        }

        moveRecord.punchSegments.push({
          sequence,
          fromX: x,
          fromY: y,
          fromElevation: elevation,
          toX: state.actorX[actorIndex],
          toY: state.actorY[actorIndex],
          toElevation: actorElevation(state, actorIndex),
          startIceSlide: iceSlide === true,
          punchSlide: true
        });
      });
    }

    function addPuncherVisualMove(
      state,
      puncher,
      targetX,
      targetY,
      moves,
      originalActorX,
      originalActorY,
      originalActorElevation,
      searchMode,
      punchSequence = 0
    ) {
      if (
        searchMode ||
        moves.some((move) => move.actorIndex === puncher && move.visualOnly && move.punchEffect)
      ) {
        return;
      }

      const carrierMove = moves.find((move) => move.actorIndex === puncher && !move.visualOnly);
      const fromX = carrierMove?.fromX ?? state.actorX[puncher];
      const fromY = carrierMove?.fromY ?? state.actorY[puncher];
      const fromElevation = carrierMove?.fromElevation ?? actorElevation(state, puncher);
      const finalX = carrierMove?.toX ?? state.actorX[puncher];
      const finalY = carrierMove?.toY ?? state.actorY[puncher];
      const finalElevation = carrierMove?.toElevation ?? actorElevation(state, puncher);
      const { dx, dy } = puncherDirectionVector(actorDirections[puncher]);
      const lungeX = finalX + dx;
      const lungeY = finalY + dy;

      moves.push({
        actorIndex: puncher,
        actorType: actorTypes[puncher],
        fromX,
        fromY,
        targetX,
        targetY,
        toX: lungeX,
        toY: lungeY,
        finalX,
        finalY,
        fromElevation,
        toElevation: finalElevation,
        finalElevation,
        iceSlide: true,
        punchEffect: true,
        punchSequence,
        visualOnly: true
      });
    }

    function puncherWasAttachedToActorAtMoveStart(
      puncher,
      actorIndex,
      originalActorX,
      originalActorY,
      originalActorElevation
    ) {
      if (!canPunchActorCarryPuncher(actorTypes[actorIndex])) {
        return false;
      }

      const { dx, dy } = puncherDirectionVector(actorDirections[puncher]);

      return (
        statePositionEquals(
          originalActorX[puncher],
          originalActorY[puncher],
          originalActorElevation[puncher] || 0,
          originalActorX[actorIndex] + dx,
          originalActorY[actorIndex] + dy,
          originalActorElevation[actorIndex] || 0
        )
      );
    }

    function puncherWasAttachedToPushEntityAtMoveStart(
      state,
      puncher,
      actorIndex,
      originalActorX,
      originalActorY,
      originalActorElevation
    ) {
      const members = pushActorMembers(state, actorIndex);

      return members.some((member) =>
        puncherWasAttachedToActorAtMoveStart(
          puncher,
          member,
          originalActorX,
          originalActorY,
          originalActorElevation
        )
      );
    }

    function statePositionEquals(leftX, leftY, leftElevation, rightX, rightY, rightElevation) {
      return leftX === rightX && leftY === rightY && leftElevation === rightElevation;
    }

    function pushEntityHasPunchSegment(moves, actorIndex) {
      const entityKey = pushEntityKey(actorIndex);

      return moves.some(
        (move) =>
          !move.visualOnly &&
          pushEntityKey(move.actorIndex) === entityKey &&
          Array.isArray(move.punchSegments) &&
          move.punchSegments.length > 0
      );
    }

    function punchFrontSortValue(state, actorIndex, dx, dy) {
      const members =
        isPushableActor(actorIndex) || isCloneActor(actorIndex)
          ? pushActorMembers(state, actorIndex)
          : [actorIndex];

      return members.reduce((front, member) => {
        const value = state.actorX[member] * dx + state.actorY[member] * dy;

        return Math.max(front, value);
      }, -Infinity);
    }

    function punchTriggerMembers(state, actorIndex) {
      return isPushableActor(actorIndex) || isCloneActor(actorIndex)
        ? pushActorMembers(state, actorIndex)
        : [actorIndex];
    }

    function collectPunchTrainMembers(state, actorIndex, dx, dy) {
      const members = [];
      const memberSet = new Set();
      const entityKeys = new Set();

      function entityKeyForPunchActor(actor) {
        return isPushableActor(actor) || isCloneActor(actor)
          ? pushEntityKey(actor)
          : `actor:${actor}`;
      }

      function addActorEntity(actor) {
        const entityKey = entityKeyForPunchActor(actor);

        if (entityKeys.has(entityKey)) {
          return false;
        }

        entityKeys.add(entityKey);
        punchTriggerMembers(state, actor).forEach((member) => {
          if (!memberSet.has(member)) {
            memberSet.add(member);
            members.push(member);
          }
        });

        return true;
      }

      addActorEntity(actorIndex);

      let expanded = true;

      while (expanded) {
        expanded = false;

        members.slice().forEach((member) => {
          const targetX = state.actorX[member] + dx;
          const targetY = state.actorY[member] + dy;
          const elevation = actorElevation(state, member);
          const nextActor = actorAt(
            state,
            targetX,
            targetY,
            (actor) =>
              !memberSet.has(actor) &&
              actorElevation(state, actor) === elevation &&
              (isPlayerActor(actor) || isPushableActor(actor))
          );

          if (nextActor !== -1 && addActorEntity(nextActor)) {
            expanded = true;
          }
        });
      }

      return members;
    }

    function removePunchMembersFromOccupied(state, occupied, members) {
      members.forEach((member) => {
        removeOccupiedAtElevation(
          occupied,
          state.actorX[member],
          state.actorY[member],
          actorElevation(state, member)
        );
      });
    }

    function addPunchMembersToOccupied(state, occupied, members) {
      members.forEach((member) => {
        addOccupiedAtElevation(
          occupied,
          state.actorX[member],
          state.actorY[member],
          actorElevation(state, member)
        );
      });
    }

    function applyPunchers(
      state,
      moves,
      originalActorX,
      originalActorY,
      originalActorElevation,
      searchMode,
      moveGateState,
      moveOrangeButtonsPressed,
      options = {}
    ) {
      if (!actorTypes.includes("puncher")) {
        return;
      }

      const candidateActorIndexes =
        options.candidateActorIndexes instanceof Set ? options.candidateActorIndexes : null;
      const includeUnpunchedMovedActors = options.includeUnpunchedMovedActors === true;
      const sequenceBase = Number.isFinite(options.sequenceBase) ? options.sequenceBase : 0;
      const triggered = new Set();
      let triggeredThisPass = true;
      let passCount = 0;

      function positionKey(x, y, elevation) {
        return `${x},${y},${elevation || 0}`;
      }

      function movingMemberInfoMap(infos) {
        const map = new Map();

        infos.forEach((info) => {
          info.members.forEach((member) => {
            map.set(member, info);
          });
        });

        return map;
      }

      function targetKeysForInfo(info) {
        return info.members.map((member) =>
          positionKey(
            state.actorX[member] + info.dx,
            state.actorY[member] + info.dy,
            actorElevation(state, member)
          )
        );
      }

      function targetCountsForInfos(infos) {
        const counts = new Map();

        infos.forEach((info) => {
          targetKeysForInfo(info).forEach((key) => {
            counts.set(key, (counts.get(key) || 0) + 1);
          });
        });

        return counts;
      }

      function actorTargetsPosition(actor, info, x, y, elevation) {
        return (
          state.actorX[actor] + info.dx === x &&
          state.actorY[actor] + info.dy === y &&
          actorElevation(state, actor) === elevation
        );
      }

      function canSimultaneousPunchStep(info, movingMemberInfo, targetCounts, occupied) {
        return info.members.every((member) => {
          const targetX = state.actorX[member] + info.dx;
          const targetY = state.actorY[member] + info.dy;
          const elevation = actorElevation(state, member);
          const targetKey = positionKey(targetX, targetY, elevation);

          if (!isInsideBoard(targetX, targetY)) {
            return false;
          }

          if (terrainBlocksElevation(state, targetX, targetY, elevation, info.gateState, info.orangeButtonsPressed)) {
            return false;
          }

          if ((targetCounts.get(targetKey) || 0) > 1) {
            return false;
          }

          const blocker = actorAt(
            state,
            targetX,
            targetY,
            (actor) =>
              !info.memberSet.has(actor) &&
              !isNonBlockingActor(actor) &&
              actorElevation(state, actor) === elevation
          );

          if (blocker !== -1) {
            if (!movingMemberInfo.has(blocker)) {
              return false;
            }

            const blockerInfo = movingMemberInfo.get(blocker);

            if (
              blockerInfo &&
              blockerInfo !== info &&
              actorTargetsPosition(
                blocker,
                blockerInfo,
                state.actorX[member],
                state.actorY[member],
                elevation
              )
            ) {
              return false;
            }
          }

          if (
            blocker === -1 &&
            isOccupiedAtElevation(occupied, targetX, targetY, elevation)
          ) {
            return false;
          }

          return true;
        });
      }

      // FIX(SEMANTICS §punchers): a punched SINGLE actor traverses ice slopes
      // with the same entry rules as a pushed box. Legacy treated slope cells
      // as absolute walls to punches (their layers block both elevations), so
      // a punched box stopped dead on the puncher forever while the same box
      // pushed by a player climbed the slope. Multi-actor punch trains still
      // stop at slopes (documented limitation).
      function attemptPunchSlopeTraversal(info, occupied) {
        if (info.members.length !== 1) {
          return null;
        }

        const member = info.members[0];

        return resolveIceSlopeTraversal(
          state,
          state.actorX[member] + info.dx,
          state.actorY[member] + info.dy,
          info.dx,
          info.dy,
          actorElevation(state, member),
          occupied,
          info.gateState,
          info.orangeButtonsPressed
        );
      }

      function moveSimultaneousPunchGroup(infos, occupied) {
        const movedInfos = new Set();
        let stepCount = 0;

        while (stepCount < actorCount + width + height) {
          stepCount += 1;
          let movingInfos = infos.slice();
          let changed = true;

          while (changed) {
            changed = false;
            const movingMemberInfo = movingMemberInfoMap(movingInfos);
            const targetCounts = targetCountsForInfos(movingInfos);
            const nextMovingInfos = movingInfos.filter((info) =>
              canSimultaneousPunchStep(info, movingMemberInfo, targetCounts, occupied)
            );

            if (nextMovingInfos.length !== movingInfos.length) {
              changed = true;
              movingInfos = nextMovingInfos;
            }
          }

          if (movingInfos.length === 0) {
            let sloped = false;

            for (const info of infos) {
              const traversal = attemptPunchSlopeTraversal(info, occupied);

              if (traversal) {
                const member = info.members[0];
                jSetActorX(state, member, traversal.exitX);
                jSetActorY(state, member, traversal.exitY);
                jSetActorElevation(state, member, traversal.exitElevation);
                movedInfos.add(info);
                sloped = true;
              }
            }

            if (!sloped) {
              break;
            }

            continue;
          }

          movingInfos.forEach((info) => {
            info.members.forEach((member) => {
              jSetActorX(state, member, state.actorX[member] + info.dx);
              jSetActorY(state, member, state.actorY[member] + info.dy);
            });
            movedInfos.add(info);
          });
        }

        return movedInfos;
      }

      while (triggeredThisPass && passCount < actorCount + width + height) {
        triggeredThisPass = false;
        passCount += 1;

        const occupied = buildOccupiedMap(state);
        // FIX(SEMANTICS R1): one device clock per move. Legacy recomputed
        // button/gate state from live mid-pipeline positions here, so a
        // punched box momentarily standing on a button opened an orange wall
        // for its own flight (tunneling through a wall that is raised both
        // before and after the move), and gate outcomes depended on how far
        // from the gate the punch started. Punches now resolve against the
        // same move-start device state that walking used. Lift state is read
        // live from state.liftRaised, so lift toggles applied earlier in this
        // move are visible to punches (a raised lift blocks a punch).
        const gateState = moveGateState || computeRaisedPlayerGateSet(state);
        const orangeButtonsPressed =
          typeof moveOrangeButtonsPressed === "boolean" || moveOrangeButtonsPressed instanceof Set
            ? moveOrangeButtonsPressed
            : computeRaisedOrangeTerrainCells(state, gateState);
        const candidateSource = (
          candidateActorIndexes
            ? Array.from(candidateActorIndexes)
            : moves.filter((move) => !move.visualOnly && !move.toRemoved).map((move) => move.actorIndex)
        );

        if (candidateActorIndexes && includeUnpunchedMovedActors) {
          moves.forEach((move) => {
            if (
              move.visualOnly ||
              move.toRemoved ||
              pushEntityHasPunchSegment(moves, move.actorIndex)
            ) {
              return;
            }

            candidateSource.push(move.actorIndex);
          });
        }

        const candidates = candidateSource.filter(
          (actorIndex, index, actorIndexes) =>
            actorIndexes.indexOf(actorIndex) === index &&
            !state.actorRemoved[actorIndex] &&
            (isPlayerActor(actorIndex) || isPushableActor(actorIndex))
        );
        const triggers = [];

        for (const actorIndex of candidates) {
          const elevation = actorElevation(state, actorIndex);
          const puncher = puncherActorAt(
            state,
            state.actorX[actorIndex],
            state.actorY[actorIndex],
            elevation
          );

          if (puncher === -1) {
            continue;
          }

          if (
            puncherWasAttachedToPushEntityAtMoveStart(
              state,
              puncher,
              actorIndex,
              originalActorX,
              originalActorY,
              originalActorElevation
            )
          ) {
            continue;
          }

          const triggerKey = `${pushEntityKey(actorIndex)}:${puncher}:${state.actorX[actorIndex]},${state.actorY[actorIndex]},${elevation}`;

          if (triggered.has(triggerKey)) {
            continue;
          }

          const { dx, dy } = puncherDirectionVector(actorDirections[puncher]);

          triggers.push({
            actorIndex,
            dx,
            dy,
            elevation,
            front: punchFrontSortValue(state, actorIndex, dx, dy),
            puncher,
            triggerKey
          });
        }

        triggers.sort(
          (left, right) =>
            left.dx - right.dx ||
            left.dy - right.dy ||
            left.front - right.front ||
            left.actorIndex - right.actorIndex
        );

        const claimedMembers = new Set();
        const triggerInfos = [];

        triggers
          .filter(
            ({ actorIndex, triggerKey }) =>
              !state.actorRemoved[actorIndex] && !triggered.has(triggerKey)
          )
          .forEach((trigger) => {
            const members = collectPunchTrainMembers(state, trigger.actorIndex, trigger.dx, trigger.dy);

            if (members.some((member) => claimedMembers.has(member))) {
              return;
            }

            members.forEach((member) => claimedMembers.add(member));
            triggerInfos.push({
              ...trigger,
              gateState,
              members,
              memberSet: new Set(members),
              orangeButtonsPressed,
              punchStarts: punchStartSnapshotsForMembers(state, members, moves)
            });
          });

        triggerInfos.forEach(({ members }) => {
          if (members.length > 0) {
            removePunchMembersFromOccupied(state, occupied, members);
          }
        });

        const movedInfos = moveSimultaneousPunchGroup(triggerInfos, occupied);

        // FIX(SEMANTICS R2): punched actors land like pushed boxes. Legacy
        // punches only wrote x/y, leaving actors hovering at their old
        // elevation over lower terrain (players soft-locked; boxes became
        // permanently unpushable), while the identical geometry over a true
        // void deleted them. Each member snaps to the highest support at or
        // below its travel elevation at the slide stop; true-void members are
        // left for the hole-fall pass (which now runs in both modes).
        movedInfos.forEach((info) => {
          info.members.forEach((member) => {
            // A punch that ran off the board edge may continue into the
            // neighboring room (cross-room flight, play-world-transitions):
            // its elevation belongs to the continuation's own landing, not
            // this room's. Only interior stops land here.
            if (
              !isInsideBoard(
                state.actorX[member] + info.dx,
                state.actorY[member] + info.dy
              )
            ) {
              return;
            }

            const memberElevation = actorElevation(state, member);
            const landing = landingElevationAtLocation(
              state,
              state.actorX[member],
              state.actorY[member],
              memberElevation,
              occupied,
              gateState,
              orangeButtonsPressed,
              info.memberSet,
              !isPlayerActor(member)
            );

            if (landing !== null && landing !== memberElevation) {
              jSetActorElevation(state, member, landing);
            }
          });
        });

        triggerInfos.forEach(({ members }) => {
          addPunchMembersToOccupied(state, occupied, members);
        });

        for (const info of triggerInfos) {
          if (!movedInfos.has(info)) {
            continue;
          }

          const { actorIndex, puncher, triggerKey, punchStarts } = info;
          triggered.add(triggerKey);
          const punchSequence = sequenceBase + passCount - 1;

          info.members.forEach((member) => {
            mergeMoveRecord(
              state,
              moves,
              member,
              originalActorX,
              originalActorY,
              originalActorElevation,
              {
                iceSlide: !searchMode,
                punchSlide: true
              }
            );
          });

          markPunchStartOnMoves(moves, punchStarts);
          recordPunchSegments(state, moves, punchStarts, punchSequence, searchMode);
          addPuncherVisualMove(
            state,
            puncher,
            state.actorX[actorIndex],
            state.actorY[actorIndex],
            moves,
            originalActorX,
            originalActorY,
            originalActorElevation,
            searchMode,
            punchSequence
          );

          if (candidateActorIndexes) {
            info.members.forEach((member) => candidateActorIndexes.add(member));
          }

          triggeredThisPass = true;
        }
      }
    }

    function nextPunchSequence(moves) {
      let nextSequence = 0;

      moves.forEach((move) => {
        if (Array.isArray(move.punchSegments)) {
          move.punchSegments.forEach((segment) => {
            const sequence = Number(segment?.sequence);

            if (Number.isFinite(sequence)) {
              nextSequence = Math.max(nextSequence, sequence + 1);
            }
          });
        }

        if (move.visualOnly && move.punchEffect) {
          const sequence = Number(move.punchSequence);

          if (Number.isFinite(sequence)) {
            nextSequence = Math.max(nextSequence, sequence + 1);
          }
        }
      });

      return nextSequence;
    }

    function syncAttachedPunchersForMoves(
      state,
      moves,
      originalActorX,
      originalActorY,
      originalActorElevation,
      searchMode
    ) {
      const punchCandidates = new Set();
      const syncedPunchers = new Set();

      if (!actorTypes.includes("puncher")) {
        return punchCandidates;
      }

      function copyStickyCarrierMoveData(carrierMove, puncherMove, dx, dy) {
        puncherMove.stickyCarrierActorIndex = carrierMove.actorIndex;
        puncherMove.stickyCarrierEntityKey = pushEntityKey(carrierMove.actorIndex);
        puncherMove.stickyCarrierDx = dx;
        puncherMove.stickyCarrierDy = dy;

        if (carrierMove.iceSlide === true) {
          puncherMove.iceSlide = true;
        }

        if (carrierMove.punchSlide === true) {
          puncherMove.punchSlide = true;
        }

        if (typeof carrierMove.punchStartX === "number") {
          puncherMove.punchStartX = carrierMove.punchStartX + dx;
          puncherMove.punchStartY = carrierMove.punchStartY + dy;
          puncherMove.punchStartElevation = carrierMove.punchStartElevation;
          puncherMove.punchStartIceSlide = carrierMove.punchStartIceSlide;
        }

        if (Array.isArray(carrierMove.punchSegments)) {
          puncherMove.punchSegments = carrierMove.punchSegments.map((segment) => ({
            ...segment,
            fromX: segment.fromX + dx,
            fromY: segment.fromY + dy,
            toX: segment.toX + dx,
            toY: segment.toY + dy
          }));
        }

        if (Array.isArray(carrierMove.path)) {
          puncherMove.path = carrierMove.path.map((point) => ({
            x: point.x + dx,
            y: point.y + dy,
            elevation: point.elevation
          }));
          puncherMove.pathControlsElevation = carrierMove.pathControlsElevation;
          puncherMove.pathEndElevation = carrierMove.pathEndElevation;
        }

        if (carrierMove.toRemoved === true) {
          puncherMove.toRemoved = true;
          puncherMove.skipHoleFall = carrierMove.skipHoleFall;
          puncherMove.visibleDuringMove = carrierMove.visibleDuringMove;
          puncherMove.fadeOut = carrierMove.fadeOut;
          puncherMove.fadeStartProgress = carrierMove.fadeStartProgress;
          puncherMove.fadeEndProgress = carrierMove.fadeEndProgress;
        }
      }

      function retargetPuncherVisualMove(visualMove, puncherMove) {
        if (!visualMove || !puncherMove) {
          return;
        }

        const { dx, dy } = puncherDirectionVector(actorDirections[visualMove.actorIndex]);
        const baseX = puncherMove.toX;
        const baseY = puncherMove.toY;
        const baseElevation = puncherMove.toElevation ?? puncherMove.fromElevation ?? 0;

        visualMove.toX = baseX + dx;
        visualMove.toY = baseY + dy;
        visualMove.toElevation = baseElevation;
        visualMove.finalX = baseX;
        visualMove.finalY = baseY;
        visualMove.finalElevation = baseElevation;
      }

      moves.forEach((move) => {
        if (
          move.visualOnly ||
          move.actorType !== "puncher" ||
          typeof move.stickyCarrierActorIndex !== "number"
        ) {
          return;
        }

        const carrierMove = moves.find(
          (candidate) =>
            !candidate.visualOnly &&
            candidate.actorIndex === move.stickyCarrierActorIndex &&
            pushEntityKey(candidate.actorIndex) === move.stickyCarrierEntityKey
        );

        if (!carrierMove) {
          return;
        }

        const dx =
          typeof move.stickyCarrierDx === "number"
            ? move.stickyCarrierDx
            : move.fromX - carrierMove.fromX;
        const dy =
          typeof move.stickyCarrierDy === "number"
            ? move.stickyCarrierDy
            : move.fromY - carrierMove.fromY;
        move.toX = carrierMove.toX + dx;
        move.toY = carrierMove.toY + dy;
        move.toElevation = carrierMove.toElevation ?? carrierMove.fromElevation ?? 0;
        jSetActorX(state, move.actorIndex, move.toX);
        jSetActorY(state, move.actorIndex, move.toY);
        jSetActorElevation(state, move.actorIndex, move.toElevation);
        jSetActorRemoved(state, move.actorIndex, carrierMove.toRemoved === true ? 1 : 0);
        copyStickyCarrierMoveData(carrierMove, move, dx, dy);
        retargetPuncherVisualMove(
          moves.find(
            (candidate) =>
              candidate.actorIndex === move.actorIndex &&
              candidate.visualOnly &&
              candidate.punchEffect === true
          ),
          move
        );
        syncedPunchers.add(move.actorIndex);
      });

      moves
        .filter(
          (move) =>
            !move.visualOnly &&
            canPunchActorCarryPuncher(move.actorType) &&
            (move.fromX !== move.toX ||
              move.fromY !== move.toY ||
              (move.fromElevation ?? 0) !== (move.toElevation ?? move.fromElevation ?? 0))
        )
        .forEach((move) => {
          for (let puncher = 0; puncher < actorCount; puncher += 1) {
            if (!isPuncherActor(puncher) || state.actorRemoved[puncher] || syncedPunchers.has(puncher)) {
              continue;
            }

            const { dx, dy } = puncherDirectionVector(actorDirections[puncher]);

            if (
              state.actorX[puncher] !== move.fromX + dx ||
              state.actorY[puncher] !== move.fromY + dy ||
              actorElevation(state, puncher) !== (move.fromElevation ?? 0)
            ) {
              continue;
            }

            // FIX(SEMANTICS §punchers): carrier rides never write an
            // off-board coordinate — every other position write in the
            // engine enforces board bounds. A carrier ride that would leave
            // the grid detaches the puncher at its current cell instead.
            if (!isInsideBoard(move.toX + dx, move.toY + dy)) {
              syncedPunchers.add(puncher);
              continue;
            }

            jSetActorX(state, puncher, move.toX + dx);
            jSetActorY(state, puncher, move.toY + dy);
            jSetActorElevation(state, puncher, move.toElevation ?? move.fromElevation ?? 0);
            syncedPunchers.add(puncher);
            const targetActor = punchTriggerActorAt(
              state,
              state.actorX[puncher],
              state.actorY[puncher],
              actorElevation(state, puncher)
            );

            if (
              targetActor !== -1 &&
              pushEntityKey(targetActor) !== pushEntityKey(move.actorIndex)
            ) {
              punchCandidates.add(targetActor);
            }

            const visualMove = moves.find(
              (candidate) =>
                candidate.actorIndex === puncher &&
                candidate.visualOnly &&
                candidate.punchEffect === true
            );

            const puncherMove = mergeMoveRecord(
              state,
              moves,
              puncher,
              originalActorX,
              originalActorY,
              originalActorElevation,
              {
                iceSlide: !searchMode && move.iceSlide === true
              }
            );

            copyStickyCarrierMoveData(move, puncherMove, dx, dy);
            retargetPuncherVisualMove(visualMove, puncherMove);

            if (move.toRemoved === true) {
              jSetActorRemoved(state, puncher, 1);
            }
          }
        });

      return punchCandidates;
    }

    // Surface attachments that ride on top of moving carriers: orange
    // buttons (legacy) and — owner rule 2026-07 — punchers standing on a
    // carrier's top surface. (Side-mounted punchers are handled by the
    // sticky-carrier sync; the two positions are mutually exclusive.)
    const surfaceAttachmentActors = (() => {
      const list = orangeButtonActors.slice();

      for (let index = 0; index < actorCount; index += 1) {
        if (isPuncherActor(index) || isAttachedDeviceType(actorTypes[index])) {
          list.push(index);
        }
      }

      return list;
    })();

    function syncAttachedSurfaceAttachmentsForMoves(
      state,
      moves,
      originalActorX,
      originalActorY,
      originalActorElevation,
      searchMode
    ) {
      if (surfaceAttachmentActors.length === 0) {
        return;
      }

      moves
        .filter(
          (move) =>
            !move.visualOnly &&
            canActorCarrySurfaceAttachment(move.actorType) &&
            (move.fromX !== move.toX ||
              move.fromY !== move.toY ||
              (move.fromElevation ?? 0) !== (move.toElevation ?? move.fromElevation ?? 0) ||
              move.toRemoved === true)
        )
        .forEach((move) => {
          for (let index = 0; index < surfaceAttachmentActors.length; index += 1) {
            const button = surfaceAttachmentActors[index];
            const carrierFromElevation = move.fromElevation ?? originalActorElevation[move.actorIndex] ?? 0;

            if (
              state.actorRemoved[button] ||
              originalActorX[button] !== move.fromX ||
              originalActorY[button] !== move.fromY ||
              (originalActorElevation[button] || 0) !== carrierFromElevation + 1
            ) {
              continue;
            }

            // A raised attached lift keeps its raised bit as it rides — the
            // bit lives per cell, so it relocates with the device (unless the
            // source cell's bit belongs to a terrain lift there).
            if (
              actorTypes[button] === "attached_lift" &&
              (move.fromX !== move.toX || move.fromY !== move.toY)
            ) {
              const fromCell = cellIndex(move.fromX, move.fromY);
              const toCell = cellIndex(move.toX, move.toY);

              if (
                state.liftRaised[fromCell] === 1 &&
                !terrainLayersForCell(state, fromCell).some(
                  (layer) => layer.type === terrainTypes.player_lift
                )
              ) {
                jSetLiftRaised(state, fromCell, 0);

                if (move.toRemoved !== true) {
                  jSetLiftRaised(state, toCell, 1);
                }
              }
            }

            jSetActorX(state, button, move.toX);
            jSetActorY(state, button, move.toY);
            jSetActorElevation(state, button, (move.toElevation ?? carrierFromElevation) + 1);
            jSetActorRemoved(state, button, move.toRemoved === true ? 1 : 0);

            const buttonMove = mergeMoveRecord(
              state,
              moves,
              button,
              originalActorX,
              originalActorY,
              originalActorElevation,
              {
                iceSlide: !searchMode && move.iceSlide === true,
                punchSlide: move.punchSlide === true
              }
            );

            if (Array.isArray(move.path) && move.path.length > 1) {
              buttonMove.path = move.path.map((point) => ({
                x: point.x,
                y: point.y,
                elevation: (point.elevation ?? carrierFromElevation) + 1
              }));
              buttonMove.pathControlsElevation = true;
              buttonMove.pathEndElevation =
                buttonMove.path[buttonMove.path.length - 1]?.elevation ?? buttonMove.toElevation;
            }

            if (move.toRemoved === true) {
              buttonMove.toRemoved = true;
              buttonMove.fadeOut = move.fadeOut;
              buttonMove.fadeStartProgress = move.fadeStartProgress;
              buttonMove.fadeEndProgress = move.fadeEndProgress;
            }
          }
        });
    }

    function actorIgnoredSupportSet(state, actorIndex) {
      if (actorTypes[actorIndex] !== "weightless_box") {
        return new Set([actorIndex]);
      }

      return new Set(weightlessGroupMembers(state, actorGroupIds[actorIndex]));
    }

    function lacksLandingSupportAtOrBelow(
      state,
      actorIndex,
      elevation,
      gateState,
      orangeButtonsPressed,
      ignoredActors = actorIgnoredSupportSet(state, actorIndex)
    ) {
      const x = state.actorX[actorIndex];
      const y = state.actorY[actorIndex];
      return lacksLandingSupportAtOrBelowLocation(
        state,
        x,
        y,
        elevation,
        gateState,
        orangeButtonsPressed,
        ignoredActors
      );
    }

    function applyHoleFalls(state, moves) {
      const gateState = computeRaisedPlayerGateSet(state);
      const orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState);
      const stickyPuncherMoves = [];

      function copyCarrierRemovalToStickyPuncher(move) {
        const carrierMove = moves.find(
          (candidate) =>
            !candidate.visualOnly &&
            candidate.actorIndex === move.stickyCarrierActorIndex &&
            pushEntityKey(candidate.actorIndex) === move.stickyCarrierEntityKey
        );

        move.toRemoved = Boolean(carrierMove?.toRemoved);

        if (carrierMove?.toRemoved === true) {
          move.skipHoleFall = carrierMove.skipHoleFall;
          move.visibleDuringMove = carrierMove.visibleDuringMove;
          move.fadeOut = carrierMove.fadeOut;
          move.fadeStartProgress = carrierMove.fadeStartProgress;
          move.fadeEndProgress = carrierMove.fadeEndProgress;
        }
      }

      moves.forEach((move) => {
        if (move.visualOnly) {
          return;
        }

        move.fromRemoved = Boolean(move.fromRemoved);
        move.toRemoved = Boolean(move.toRemoved);

        if (
          move.actorType === "puncher" &&
          typeof move.stickyCarrierActorIndex === "number"
        ) {
          stickyPuncherMoves.push(move);
          return;
        }

        if (move.actorType === "weightless_box") {
          return;
        }

        // FIX(SEMANTICS R2): punched clones obey the same pit rules as
        // punched players. Legacy exempted clones from hole falls entirely,
        // leaving a punched clone floating forever over a pit where an
        // identically punched player died. Non-punch clone movement keeps its
        // exemption (clone-group falls are handled by the group sync pass).
        if (isCloneType(move.actorType) && move.punchSlide !== true) {
          return;
        }

        if (
          move.actorType === "floating_floor" &&
          isHole(
            state,
            state.actorX[move.actorIndex],
            state.actorY[move.actorIndex],
            move.toElevation ?? actorElevation(state, move.actorIndex)
          )
        ) {
          move.toRemoved = true;
          move.skipHoleFall = true;
          move.visibleDuringMove = true;
          move.fillsHole = true;
          move.fillHoleX = state.actorX[move.actorIndex];
          move.fillHoleY = state.actorY[move.actorIndex];
          move.fillHolePreviousTerrain =
            state.terrain[cellIndex(move.fillHoleX, move.fillHoleY)];
          return;
        }

        const toElevation = move.toElevation ?? actorElevation(state, move.actorIndex);
        const actorIsOnHole = isHole(
          state,
          state.actorX[move.actorIndex],
          state.actorY[move.actorIndex],
          toElevation
        );
        const actorHasSurfaceSupport = surfaceSupportsElevation(
          state,
          state.actorX[move.actorIndex],
          state.actorY[move.actorIndex],
          toElevation,
          gateState,
          orangeButtonsPressed,
          new Set([move.actorIndex]),
          true
        );
        const actorIsOnUnsupportedHole = actorIsOnHole && !actorHasSurfaceSupport;
        const actorIsOverOpenPit =
          (move.punchSlide === true || move.iceSlipOff === true) &&
          !actorIsOnUnsupportedHole &&
          lacksLandingSupportAtOrBelow(
            state,
            move.actorIndex,
            toElevation,
            gateState,
            orangeButtonsPressed
          );

        if (
          (actorIsOnUnsupportedHole || actorIsOverOpenPit) &&
          (!isPlayerType(move.actorType) || actorIsOverOpenPit || toElevation === 0)
        ) {
          move.toRemoved = true;
        }
      });

      stickyPuncherMoves.forEach(copyCarrierRemovalToStickyPuncher);
    }

    function applyMoveFinalState(state, moves) {
      moves.forEach((move) => {
        if (move.visualOnly) {
          return;
        }

        const toElevation = move.toElevation ?? state.actorElevation[move.actorIndex] ?? 0;

        jSetActorX(state, move.actorIndex, move.toX);
        jSetActorY(state, move.actorIndex, move.toY);
        jSetActorElevation(state, move.actorIndex, toElevation);
        jSetActorRemoved(state, move.actorIndex, move.toRemoved ? 1 : 0);
      });

      moves.forEach(({ fillsHole = false, fillHoleX = null, fillHoleY = null }) => {
        if (!fillsHole || typeof fillHoleX !== "number" || typeof fillHoleY !== "number") {
          return;
        }

        jSetTerrain(state, cellIndex(fillHoleX, fillHoleY), terrainTypes.floor);
      });
    }

    // Perf: shared per-engine scratch for the dynamic sync pass — the legacy
    // pass allocated a Map + two Int16Arrays per move() call, a major share
    // of the GC pressure the profiler attributed to search.
    const devicesPresent =
      playerGateCells.length > 0 ||
      playerLiftCells.length > 0 ||
      orangeWallCells.length > 0 ||
      orangeButtonCells.length > 0 ||
      levelHasAttachedDevices;
    const syncOriginalElevations = new Int16Array(actorCount);
    const syncIterationElevations = new Int16Array(actorCount);

    function syncDynamicActorElevationsAndFalls(
      state,
      moves,
      previousGateState = computeRaisedPlayerGateSet(state),
      previousOrangeButtonsPressed = computeRaisedOrangeTerrainCells(state, previousGateState)
    ) {
      // Fast exit: with no device terrain, no hole/void cells, and every
      // actor exactly at ground level, nothing can ride a surface
      // transition, fall, or sink — the whole pass is a no-op. This is the
      // common case for flat rooms and a large share of search expansions.
      const anyDeviceButtons = devicesPresent || orangeButtonActors.length > 0;

      if (!anyDeviceButtons && !levelHasVoidOrHoleCells) {
        let anyOffGround = false;

        for (let index = 0; index < actorCount; index += 1) {
          if (!state.actorRemoved[index] && (state.actorElevation[index] || 0) !== 0) {
            anyOffGround = true;
            break;
          }
        }

        if (!anyOffGround) {
          return;
        }
      }

      const moveByActor = new Map(moves.map((move) => [move.actorIndex, move]));
      syncOriginalElevations.set(state.actorElevation);
      const originalElevations = syncOriginalElevations;
      let gateState = computeRaisedPlayerGateSet(state);
      let orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState);

      function dynamicAttachedGateRideElevation(index, nextGateState, nextOrangeButtonsPressed) {
        const elevation = actorElevation(state, index);
        const x = state.actorX[index];
        const y = state.actorY[index];
        const cell = isInsideBoard(x, y) ? cellIndex(x, y) : -1;

        if (cell === -1) {
          return elevation;
        }

        for (let i = 0; i < attachedGateIndexes.length; i += 1) {
          const gateIndex = attachedGateIndexes[i];

          if (
            gateIndex === index ||
            state.actorRemoved[gateIndex] ||
            state.actorX[gateIndex] !== x ||
            state.actorY[gateIndex] !== y
          ) {
            continue;
          }

          const gateElevation = actorElevation(state, gateIndex);
          const from = gateElevation + (previousGateState.has(cell) ? 1 : 0);

          if (from !== elevation) {
            continue;
          }

          const to = gateElevation + (nextGateState.has(cell) ? 1 : 0);

          if (to <= from) {
            return to;
          }

          for (let target = to; target > elevation; target -= 1) {
            if (
              !terrainBlocksElevation(
                state,
                x,
                y,
                target,
                nextGateState,
                nextOrangeButtonsPressed
              )
            ) {
              return target;
            }
          }

          return elevation;
        }

        return elevation;
      }

      function dynamicTerrainRideElevation(index, nextGateState, nextOrangeButtonsPressed) {
        const elevation = actorElevation(state, index);
        const attachedGateRideElevation = dynamicAttachedGateRideElevation(
          index,
          nextGateState,
          nextOrangeButtonsPressed
        );

        if (attachedGateRideElevation !== elevation) {
          return attachedGateRideElevation;
        }

        // Surface transitions only exist on device terrain; without any,
        // there is nothing to ride (perf fast path — this loop used to build
        // two arrays per actor per iteration).
        if (!devicesPresent) {
          return elevation;
        }

        const x = state.actorX[index];
        const y = state.actorY[index];

        if (
          actorSupportsElevationExcluding(
            state,
            x,
            y,
            elevation,
            index,
            isSupportActorType(actorTypes[index]),
            nextGateState
          )
        ) {
          return elevation;
        }

        if (!isInsideBoard(x, y)) {
          return elevation;
        }

        const cell = cellIndex(x, y);
        const layers = terrainLayersForCell(state, cell);

        for (const layer of layers) {
          const from = terrainLayerSurfaceHeight(
            state,
            cell,
            layer,
            previousGateState,
            previousOrangeButtonsPressed
          );

          if (from === null || from !== elevation) {
            continue;
          }

          const to = terrainLayerSurfaceHeight(
            state,
            cell,
            layer,
            nextGateState,
            nextOrangeButtonsPressed
          );

          if (to === null || to === from) {
            continue;
          }

          // FIX(SEMANTICS §devices): never ride a rising surface into a
          // terrain-blocked voxel (a gate/orange wall rising under a box
          // below a bridge used to embed the box inside the bridge). Stop
          // at the highest non-blocked elevation on the way up; stay put
          // if every step is blocked. Downward transitions are unchanged.
          if (to > from) {
            for (let target = to; target > elevation; target -= 1) {
              if (
                !terrainBlocksElevation(
                  state,
                  x,
                  y,
                  target,
                  nextGateState,
                  nextOrangeButtonsPressed
                )
              ) {
                return target;
              }
            }

            return elevation;
          }

          return to;
        }

        return elevation;
      }

      function lostDynamicSupportUnderActor(index) {
        const actorMove = moveByActor.get(index);
        const fromX = actorMove?.fromX ?? state.actorX[index];
        const fromY = actorMove?.fromY ?? state.actorY[index];
        const fromElevation = actorMove?.fromElevation ?? originalElevations[index] ?? 0;
        const currentX = state.actorX[index];
        const currentY = state.actorY[index];
        const currentElevation = actorElevation(state, index);

        return moves.some((move) => {
          if (
            move.visualOnly ||
            move.actorIndex === index ||
            !isSupportActorType(move.actorType)
          ) {
            return false;
          }

          if (
            move.toRemoved === true &&
            moveRecordPathPoints(move).some(
              (point) =>
                point.x === currentX &&
                point.y === currentY &&
                point.elevation + 1 === currentElevation
            )
          ) {
            return true;
          }

          if (
            move.fromX !== fromX ||
            move.fromY !== fromY ||
            (move.fromElevation ?? originalElevations[move.actorIndex] ?? 0) + 1 !== fromElevation
          ) {
            return false;
          }

          if (move.toRemoved === true) {
            return true;
          }

          return (
            move.toX !== state.actorX[index] ||
            move.toY !== state.actorY[index] ||
            (move.toElevation ?? move.fromElevation ?? originalElevations[move.actorIndex] ?? 0) + 1 !==
              actorElevation(state, index)
          );
        });
      }

      function dynamicUnsupportedFallElevation(index, nextGateState, nextOrangeButtonsPressed) {
        if (
          !isMainPlayerActor(index) &&
          actorTypes[index] !== "box" &&
          actorTypes[index] !== "floating_floor"
        ) {
          return actorElevation(state, index);
        }

        if (!lostDynamicSupportUnderActor(index)) {
          return actorElevation(state, index);
        }

        const elevation = actorElevation(state, index);
        const ignoredActors = new Set([index]);
        // FIX(SEMANTICS §elevation): a falling PLAYER does not rest on a main
        // player's head — the movement rules forbid standing there, so the
        // fall pass must not create that state (legacy left a rider standing
        // on the pusher's head, temporarily uncontrollable). Boxes may still
        // rest on player heads (preserved legacy rule).
        const supportIncludesPlayers = !isPlayerActor(index);

        if (
          surfaceSupportsElevation(
            state,
            state.actorX[index],
            state.actorY[index],
            elevation,
            nextGateState,
            nextOrangeButtonsPressed,
            ignoredActors,
            supportIncludesPlayers
          )
        ) {
          return elevation;
        }

        const occupied = buildOccupiedMap(state, index);
        const landingElevation = landingElevationAtLocation(
          state,
          state.actorX[index],
          state.actorY[index],
          elevation,
          occupied,
          nextGateState,
          nextOrangeButtonsPressed,
          ignoredActors,
          supportIncludesPlayers
        );

        if (landingElevation !== null) {
          return landingElevation;
        }

        for (let targetElevation = elevation - 1; targetElevation >= 0; targetElevation -= 1) {
          if (
            canMoveIntoAtElevation(
              state,
              state.actorX[index],
              state.actorY[index],
              occupied,
              nextGateState,
              nextOrangeButtonsPressed,
              targetElevation
            )
          ) {
            return targetElevation;
          }
        }

        return elevation;
      }

      const maxDynamicElevationIterations = Math.max(4, actorCount);

      for (let iteration = 0; iteration < maxDynamicElevationIterations; iteration += 1) {
        gateState = computeRaisedPlayerGateSet(state);
        orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState);
        let changed = false;
        syncIterationElevations.set(state.actorElevation);
        const iterationStartElevations = syncIterationElevations;
        const changedSupportActors = new Set();

        function setDynamicElevation(index, toElevation) {
          if (state.actorElevation[index] === toElevation) {
            return;
          }

          jSetActorElevation(state, index, toElevation);
          changed = true;

          if (actorProvidesFlatSupport(index)) {
            changedSupportActors.add(index);
          }
        }

        for (let index = 0; index < actorCount; index += 1) {
          if (
            state.actorRemoved[index] ||
            actorTypes[index] === "weightless_box" ||
            isCloneActor(index)
          ) {
            continue;
          }

          if (!isSupportActorType(actorTypes[index])) {
            // FIX(SEMANTICS §devices): punchers and button actors ride device
            // surface transitions beneath them — a puncher resting on a lift
            // used to be entombed at its stale elevation after one toggle and
            // never trigger again. They are fixtures: ride only, never fall.
            // Gems deliberately stay put (they float; owner decision).
            if (
              isPuncherActor(index) ||
              isOrangeButtonActor(index) ||
              isAttachedDeviceType(actorTypes[index])
            ) {
              setDynamicElevation(
                index,
                dynamicTerrainRideElevation(index, gateState, orangeButtonsPressed)
              );
            }

            continue;
          }

          const rideElevation = dynamicTerrainRideElevation(index, gateState, orangeButtonsPressed);

          setDynamicElevation(index, rideElevation);
          setDynamicElevation(index, dynamicUnsupportedFallElevation(index, gateState, orangeButtonsPressed));
        }

        // Perf gate: a group's settle is idempotent unless a support-relevant
        // change happened in one of its columns this move (or device state
        // changed). Skipped groups are NOT marked handled, so a touched
        // neighbor's component BFS still pulls them in.
        const changeStamp = stampSupportChangeCells(moves);
        const syncAllGroups =
          gateSetsDiffer(previousOrangeButtonsPressed, orangeButtonsPressed) ||
          gateSetsDiffer(previousGateState, gateState);

        const handledWeightlessGroups = new Set();

        for (let index = 0; index < actorCount; index += 1) {
          if (actorTypes[index] !== "weightless_box" || state.actorRemoved[index]) {
            continue;
          }

          const groupId = actorGroupIds[index];

          if (handledWeightlessGroups.has(groupId)) {
            continue;
          }

          if (
            !syncAllGroups &&
            !groupTouchesChangedCells(state, weightlessMembersByGroup.get(groupId), changeStamp)
          ) {
            continue;
          }

          handledWeightlessGroups.add(groupId);

          const componentGroupIds = weightlessVerticalSupportComponentGroupIds(state, groupId);
          componentGroupIds.forEach((componentGroupId) => handledWeightlessGroups.add(componentGroupId));

          const component = weightlessComponentSupportedElevation(
            state,
            componentGroupIds,
            gateState,
            orangeButtonsPressed
          );

          component.members.forEach((member) => {
            const toElevation =
              component.baseElevation +
              (component.groupBaseOffsets.get(actorGroupIds[member]) ?? 0) +
              (weightlessRelativeElevations[member] || 0);

            setDynamicElevation(member, toElevation);
          });
        }

        const handledCloneGroups = new Set();

        for (let index = 0; index < actorCount; index += 1) {
          if (!isCloneActor(index) || state.actorRemoved[index]) {
            continue;
          }

          const groupId = actorGroupIds[index] || "";

          if (handledCloneGroups.has(groupId)) {
            continue;
          }

          if (
            !syncAllGroups &&
            !groupTouchesChangedCells(state, cloneMembersByGroup.get(groupId), changeStamp)
          ) {
            continue;
          }

          handledCloneGroups.add(groupId);

          const group = cloneGroupSupportedElevation(state, groupId, gateState, orangeButtonsPressed);
          let targetBaseElevation = group.baseElevation;

          group.members.forEach((member) => {
            const currentElevation = actorElevation(state, member);
            const rideElevation = dynamicAttachedGateRideElevation(
              member,
              gateState,
              orangeButtonsPressed
            );

            if (rideElevation > currentElevation) {
              targetBaseElevation = Math.max(
                targetBaseElevation,
                rideElevation - (currentElevation - group.currentBaseElevation)
              );
            }
          });

          group.members.forEach((member) => {
            const toElevation =
              targetBaseElevation + (actorElevation(state, member) - group.currentBaseElevation);

            setDynamicElevation(member, toElevation);
          });
        }

        const propagationQueue = Array.from(changedSupportActors);
        for (let queueIndex = 0; queueIndex < propagationQueue.length; queueIndex += 1) {
          const lower = propagationQueue[queueIndex];
          const lowerFromElevation = iterationStartElevations[lower] || 0;
          const lowerToElevation = actorElevation(state, lower);

          if (lowerFromElevation === lowerToElevation) {
            continue;
          }

          for (let upper = 0; upper < actorCount; upper += 1) {
            if (
              upper === lower ||
              state.actorRemoved[upper] ||
              !actorProvidesFlatSupport(lower) ||
              !isSupportActorType(actorTypes[upper]) ||
              actorTypes[upper] === "weightless_box" ||
              isCloneActor(upper) ||
              state.actorX[upper] !== state.actorX[lower] ||
              state.actorY[upper] !== state.actorY[lower] ||
              (iterationStartElevations[upper] || 0) !== lowerFromElevation + 1
            ) {
              continue;
            }

            setDynamicElevation(upper, lowerToElevation + 1);
            propagationQueue.push(upper);
          }
        }

        if (!changed) {
          break;
        }
      }

      gateState = computeRaisedPlayerGateSet(state);
      orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState);

      function ensureDynamicMove(index, toElevation) {
        const existingMove = moveByActor.get(index);

        if (existingMove) {
          if (typeof existingMove.fromElevation !== "number") {
            existingMove.fromElevation = originalElevations[index] || 0;
          }

          existingMove.toElevation = toElevation;
          return existingMove;
        }

        const moveRecord = {
          actorIndex: index,
          actorType: actorTypes[index],
          fromX: state.actorX[index],
          fromY: state.actorY[index],
          toX: state.actorX[index],
          toY: state.actorY[index],
          fromElevation: originalElevations[index] || 0,
          toElevation
        };
        moves.push(moveRecord);
        moveByActor.set(index, moveRecord);
        return moveRecord;
      }

      function markDynamicHoleFallForMove(index, moveRecord, toElevation) {
        const actorIsOnHole = isHole(
          state,
          state.actorX[index],
          state.actorY[index],
          toElevation
        );
        const actorHasSurfaceSupport = surfaceSupportsElevation(
          state,
          state.actorX[index],
          state.actorY[index],
          toElevation,
          gateState,
          orangeButtonsPressed,
          new Set([index]),
          true
        );
        const shouldFallIntoHole =
          actorIsOnHole &&
          !actorHasSurfaceSupport &&
          (!isPlayerType(actorTypes[index]) || toElevation === 0);

        if (!shouldFallIntoHole) {
          return false;
        }

        moveRecord.toRemoved = true;

        if (actorTypes[index] === "floating_floor") {
          moveRecord.skipHoleFall = true;
          moveRecord.visibleDuringMove = true;
          moveRecord.fillsHole = true;
          moveRecord.fillHoleX = state.actorX[index];
          moveRecord.fillHoleY = state.actorY[index];
          moveRecord.fillHolePreviousTerrain =
            state.terrain[cellIndex(moveRecord.fillHoleX, moveRecord.fillHoleY)];
        }

        jSetActorRemoved(state, index, 1);
        return true;
      }

      function runPostSupportLossPass() {
        let changed = false;

        gateState = computeRaisedPlayerGateSet(state);
        orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState);

        for (let index = 0; index < actorCount; index += 1) {
          if (
            state.actorRemoved[index] ||
            actorTypes[index] === "weightless_box" ||
            isCloneActor(index) ||
            !isSupportActorType(actorTypes[index])
          ) {
            continue;
          }

          const previousElevation = actorElevation(state, index);
          const toElevation = dynamicUnsupportedFallElevation(
            index,
            gateState,
            orangeButtonsPressed
          );

          if (toElevation === previousElevation && !lostDynamicSupportUnderActor(index)) {
            continue;
          }

          const moveRecord = ensureDynamicMove(index, toElevation);

          jSetActorElevation(state, index, toElevation);
          changed = changed || toElevation !== previousElevation;

          if (markDynamicHoleFallForMove(index, moveRecord, toElevation)) {
            changed = true;
          }
        }

        return changed;
      }

      function cloneGroupFallBaseElevation(group, baseElevation) {
        const occupied = buildOccupiedMap(state);
        const memberRelativeElevations = new Map(
          group.members.map((member) => [
            member,
            actorElevation(state, member) - group.currentBaseElevation
          ])
        );

        group.members.forEach((member) => {
          removeOccupiedAtElevation(
            occupied,
            state.actorX[member],
            state.actorY[member],
            actorElevation(state, member)
          );
        });

        const memberElevationAtBase = (member, base) =>
          base + (memberRelativeElevations.get(member) || 0);
        const hasSupportAtBase = (base) =>
          group.members.some((member) => {
            const toElevation = memberElevationAtBase(member, base);

            return (
              terrainSupportsElevation(
                state,
                state.actorX[member],
                state.actorY[member],
                toElevation,
                gateState,
                orangeButtonsPressed
              ) ||
              actorSupportSurfaceHeightsAt(
                state,
                state.actorX[member],
                state.actorY[member],
                group.memberSet,
                true
              ).includes(toElevation)
            );
          });
        const canOccupyBase = (base) =>
          group.members.every((member) =>
            weightlessMemberCanOccupy(
              state,
              member,
              state.actorX[member],
              state.actorY[member],
              memberElevationAtBase(member, base),
              occupied,
              gateState,
              orangeButtonsPressed
            )
          );

        let base = baseElevation;
        let guard = Math.max(4, actorCount + width + height + 8);

        while (guard > 0) {
          guard -= 1;

          if (hasSupportAtBase(base)) {
            return base;
          }

          if (group.members.every((member) => memberElevationAtBase(member, base) <= 0)) {
            return base;
          }

          if (!canOccupyBase(base - 1)) {
            return base;
          }

          base -= 1;
        }

        return base;
      }

      function weightlessComponentFallBaseElevation(component, baseElevation) {
        const occupied = buildOccupiedMap(state);
        const memberRelativeElevations = new Map(
          component.members.map((member) => [
            member,
            (component.groupBaseOffsets.get(actorGroupIds[member]) ?? 0) +
              (weightlessRelativeElevations[member] || 0)
          ])
        );

        component.members.forEach((member) => {
          removeOccupiedAtElevation(
            occupied,
            state.actorX[member],
            state.actorY[member],
            actorElevation(state, member)
          );
        });

        const memberElevationAtBase = (member, base) =>
          base + (memberRelativeElevations.get(member) || 0);
        const hasSupportAtBase = (base) =>
          component.members.some((member) => {
            const toElevation = memberElevationAtBase(member, base);

            return (
              terrainSupportsElevation(
                state,
                state.actorX[member],
                state.actorY[member],
                toElevation,
                gateState,
                orangeButtonsPressed
              ) ||
              actorSupportSurfaceHeightsAt(
                state,
                state.actorX[member],
                state.actorY[member],
                component.memberSet,
                true
              ).includes(toElevation)
            );
          });
        const canOccupyBase = (base) =>
          component.members.every((member) =>
            weightlessMemberCanOccupy(
              state,
              member,
              state.actorX[member],
              state.actorY[member],
              memberElevationAtBase(member, base),
              occupied,
              gateState,
              orangeButtonsPressed
            )
          );

        let base = baseElevation;
        let guard = Math.max(4, actorCount + width + height + 8);

        while (guard > 0) {
          guard -= 1;

          if (hasSupportAtBase(base)) {
            return base;
          }

          if (component.members.every((member) => memberElevationAtBase(member, base) <= 0)) {
            return base;
          }

          if (!canOccupyBase(base - 1)) {
            return base;
          }

          base -= 1;
        }

        return base;
      }

      for (let index = 0; index < actorCount; index += 1) {
        if (
          state.actorRemoved[index] ||
          actorTypes[index] === "weightless_box" ||
          isCloneActor(index) ||
          !isSupportActorType(actorTypes[index])
        ) {
          continue;
        }

        const toElevation = actorElevation(state, index);
        if ((originalElevations[index] || 0) === toElevation) {
          continue;
        }

        ensureDynamicMove(index, toElevation);
      }

      const handledWeightlessGroups = new Set();

      for (let index = 0; index < actorCount; index += 1) {
        if (actorTypes[index] !== "weightless_box" || state.actorRemoved[index]) {
          continue;
        }

        const groupId = actorGroupIds[index];

        if (handledWeightlessGroups.has(groupId)) {
          continue;
        }

        const componentGroupIds = weightlessVerticalSupportComponentGroupIds(state, groupId);
        componentGroupIds.forEach((componentGroupId) => handledWeightlessGroups.add(componentGroupId));

        const component = weightlessComponentSupportedElevation(
          state,
          componentGroupIds,
          gateState,
          orangeButtonsPressed
        );
        const componentBaseElevation = component.members.some((member) => moveByActor.has(member))
          ? weightlessComponentFallBaseElevation(component, component.baseElevation)
          : component.baseElevation;
        const componentTargetElevation = (member) =>
          componentBaseElevation +
          (component.groupBaseOffsets.get(actorGroupIds[member]) ?? 0) +
          (weightlessRelativeElevations[member] || 0);
        const componentMovedOrChangedElevation = component.members.some((member) => {
          const toElevation = componentTargetElevation(member);

          return moveByActor.has(member) || (originalElevations[member] || 0) !== toElevation;
        });
        const componentFullyAtOrBelowFloor = component.members.every(
          (member) => componentTargetElevation(member) <= 0
        );
        const componentHasTargetSupport = component.members.some((member) => {
          const toElevation = componentTargetElevation(member);

          return (
            terrainSupportsElevation(
              state,
              state.actorX[member],
              state.actorY[member],
              toElevation,
              gateState,
              orangeButtonsPressed
            ) ||
            actorSupportSurfaceHeightsAt(
              state,
              state.actorX[member],
              state.actorY[member],
              component.memberSet,
              true
            ).includes(toElevation)
          );
        });
        const shouldFallIntoHole =
          componentMovedOrChangedElevation &&
          component.members.length > 0 &&
          componentFullyAtOrBelowFloor &&
          !componentHasTargetSupport;

        component.members.forEach((member) => {
          const toElevation = componentTargetElevation(member);

          if (
            (originalElevations[member] || 0) !== toElevation ||
            moveByActor.has(member) ||
            shouldFallIntoHole
          ) {
            const moveRecord = ensureDynamicMove(member, toElevation);

            if (
              !shouldFallIntoHole &&
              Array.isArray(moveRecord.path) &&
              moveRecord.path.length > 0
            ) {
              const pathEnd = moveRecord.path[moveRecord.path.length - 1];

              if (
                pathEnd &&
                pathEnd.x === state.actorX[member] &&
                pathEnd.y === state.actorY[member] &&
                pathEnd.elevation !== toElevation
              ) {
                if (typeof moveRecord.pathEndElevation !== "number") {
                  moveRecord.pathEndElevation = pathEnd.elevation;
                }

                appendPathPoints(moveRecord.path, [
                  {
                    x: state.actorX[member],
                    y: state.actorY[member],
                    elevation: toElevation
                  }
                ]);
                moveRecord.pathControlsElevation = true;
              }
            }

            moveRecord.toRemoved = shouldFallIntoHole;
          }

          jSetActorElevation(state, member, toElevation);
          jSetActorRemoved(state, member, shouldFallIntoHole ? 1 : 0);
        });
      }

      const maxPostWeightlessSupportIterations = Math.max(4, actorCount);

      for (
        let iteration = 0;
        iteration < maxPostWeightlessSupportIterations;
        iteration += 1
      ) {
        if (!runPostSupportLossPass()) {
          break;
        }
      }

      function syncCloneGroupsAfterSupportChanges() {
        const handledCloneGroups = new Set();
        const cloneGroupIds = [];

        for (let index = 0; index < actorCount; index += 1) {
          if (!isCloneActor(index) || state.actorRemoved[index]) {
            continue;
          }

          const groupId = actorGroupIds[index] || "";

          if (handledCloneGroups.has(groupId)) {
            continue;
          }

          handledCloneGroups.add(groupId);
          cloneGroupIds.push(groupId);
        }

        cloneGroupIds.sort(
          (left, right) =>
            cloneGroupCurrentBaseElevation(state, left) -
            cloneGroupCurrentBaseElevation(state, right)
        );

        let changed = false;

        cloneGroupIds.forEach((groupId) => {
          if (!cloneGroupMembers(state, groupId).some((member) => !state.actorRemoved[member])) {
            return;
          }

          const group = cloneGroupSupportedElevation(state, groupId, gateState, orangeButtonsPressed);
          const groupLostDynamicSupport = group.members.some((member) =>
            lostDynamicSupportUnderActor(member)
          );
          const baseElevation = groupLostDynamicSupport
            ? cloneGroupFallBaseElevation(group, group.baseElevation)
            : group.baseElevation;
          const groupTargetElevation = (member) =>
            baseElevation + (actorElevation(state, member) - group.currentBaseElevation);
          const groupMovedOrChangedElevation = group.members.some((member) => {
            const toElevation = groupTargetElevation(member);

            return moveByActor.has(member) || (originalElevations[member] || 0) !== toElevation;
          });
          const groupFullyAtOrBelowFloor = group.members.every(
            (member) => groupTargetElevation(member) <= 0
          );
          const groupHasTargetSupport = group.members.some((member) => {
            const toElevation = groupTargetElevation(member);

            return (
              terrainSupportsElevation(
                state,
                state.actorX[member],
                state.actorY[member],
                toElevation,
                gateState,
                orangeButtonsPressed
              ) ||
              actorSupportSurfaceHeightsAt(
                state,
                state.actorX[member],
                state.actorY[member],
                group.memberSet,
                true
              ).includes(toElevation)
            );
          });
          const shouldFallIntoHole =
            group.members.length > 0 &&
            (groupMovedOrChangedElevation || groupLostDynamicSupport) &&
            groupFullyAtOrBelowFloor &&
            !groupHasTargetSupport;

          group.members.forEach((member) => {
            const toElevation = groupTargetElevation(member);

            if (
              (originalElevations[member] || 0) !== toElevation ||
              moveByActor.has(member) ||
              shouldFallIntoHole
            ) {
              const moveRecord = ensureDynamicMove(member, toElevation);

              moveRecord.toRemoved = shouldFallIntoHole;
            }

            if (state.actorElevation[member] !== toElevation) {
              changed = true;
            }

            if (Boolean(state.actorRemoved[member]) !== shouldFallIntoHole) {
              changed = true;
            }

            jSetActorElevation(state, member, toElevation);
            jSetActorRemoved(state, member, shouldFallIntoHole ? 1 : 0);
          });
        });

        return changed;
      }

      const maxCloneSupportIterations = Math.max(4, actorCount);

      for (let iteration = 0; iteration < maxCloneSupportIterations; iteration += 1) {
        gateState = computeRaisedPlayerGateSet(state);
        orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, gateState);

        const cloneChanged = syncCloneGroupsAfterSupportChanges();
        const actorChanged = runPostSupportLossPass();

        if (!cloneChanged && !actorChanged) {
          break;
        }
      }

      // Every NET elevation change made by this sync must surface as a move
      // record: play mode replays records onto its own runtime actors, so a
      // journal-only ride leaves the visible board desynced from the engine
      // (owner bug 2026-07: orange button hovering above its lowered wall).
      // The device-ride branch above writes through setDynamicElevation
      // without records; this diff pass settles the difference exactly once,
      // and only for real net changes, so `moved` semantics and search
      // parity are untouched.
      for (let index = 0; index < actorCount; index += 1) {
        const finalElevation = actorElevation(state, index);

        if ((originalElevations[index] || 0) === finalElevation) {
          continue;
        }

        if (state.actorRemoved[index] && !moveByActor.has(index)) {
          continue;
        }

        ensureDynamicMove(index, finalElevation);
      }
    }

    function sortPlayersForMove(state, dx, dy) {
      const players = [];
      const moveOrderElevation = (actorIndex) => {
        if (!isCloneActor(actorIndex)) {
          return actorElevation(state, actorIndex);
        }

        return cloneGroupMembers(state, actorGroupIds[actorIndex]).reduce(
          (lowest, member) => Math.min(lowest, actorElevation(state, member)),
          Infinity
        );
      };

      for (let index = 0; index < actorCount; index += 1) {
        if (isPlayerActor(index) && !state.actorRemoved[index]) {
          players.push(index);
        }
      }

      const sortedPlayers = players.sort((left, right) => {
        if (dx > 0) {
          return (
            state.actorX[right] - state.actorX[left] ||
            state.actorY[left] - state.actorY[right] ||
            moveOrderElevation(left) - moveOrderElevation(right)
          );
        }
        if (dx < 0) {
          return (
            state.actorX[left] - state.actorX[right] ||
            state.actorY[left] - state.actorY[right] ||
            moveOrderElevation(left) - moveOrderElevation(right)
          );
        }
        if (dy > 0) {
          return (
            state.actorY[right] - state.actorY[left] ||
            state.actorX[left] - state.actorX[right] ||
            moveOrderElevation(left) - moveOrderElevation(right)
          );
        }
        return (
          state.actorY[left] - state.actorY[right] ||
          state.actorX[left] - state.actorX[right] ||
          moveOrderElevation(left) - moveOrderElevation(right)
        );
      });
      const seenCloneGroups = new Set();

      return sortedPlayers.filter((actorIndex) => {
        if (!isCloneActor(actorIndex)) {
          return true;
        }

        const groupKey = actorGroupIds[actorIndex] || "";

        if (seenCloneGroups.has(groupKey)) {
          return false;
        }

        seenCloneGroups.add(groupKey);
        return true;
      });
    }

    function interlockedMainPlayersForCloneMove(state, members, dx, dy, alreadyVacated) {
      if (!Array.isArray(members) || members.length === 0) {
        return [];
      }

      const memberCells = new Set();
      const targetCells = new Set();

      members.forEach((member) => {
        const elevation = actorElevation(state, member);
        memberCells.add(
          occupiedElevationKey(state.actorX[member], state.actorY[member], elevation)
        );
        targetCells.add(
          occupiedElevationKey(
            state.actorX[member] + dx,
            state.actorY[member] + dy,
            elevation
          )
        );
      });

      const interlockedPlayers = [];

      for (let actor = 0; actor < actorCount; actor += 1) {
        if (
          !isMainPlayerActor(actor) ||
          state.actorRemoved[actor] ||
          alreadyVacated?.has(actor)
        ) {
          continue;
        }

        const elevation = actorElevation(state, actor);
        const currentCell = occupiedElevationKey(
          state.actorX[actor],
          state.actorY[actor],
          elevation
        );
        const targetCell = occupiedElevationKey(
          state.actorX[actor] + dx,
          state.actorY[actor] + dy,
          elevation
        );

        // The clone group wants the player's current cell while the player
        // wants one of the group's current cells. Since both receive the same
        // input, this is a simultaneous translation dependency rather than a
        // collision (for example, a player enclosed by a rigid clone ring).
        if (targetCells.has(currentCell) && memberCells.has(targetCell)) {
          interlockedPlayers.push(actor);
        }
      }

      return interlockedPlayers;
    }

    // Whether the destination elevation of a lift toggle is blocked by any
    // terrain layer OTHER than the lift itself (whose state the toggle is
    // about to change) — e.g. a bridge layer authored above the lift.
    function liftToggleDestinationBlocked(state, x, y, elevation, gateState, orangeButtonsPressed) {
      if (!isInsideBoard(x, y)) {
        return true;
      }

      const cell = cellIndex(x, y);

      return terrainLayersForCell(state, cell).some(
        (layer) =>
          layer.type !== terrainTypes.player_lift &&
          terrainLayerBlocksElevation(
            state,
            cell,
            layer,
            gateState,
            orangeButtonsPressed,
            elevation
          )
      );
    }

    // Owner rule (2026-07): exposed floor / ice / ice-block surfaces do not
    // rail the world edge — a player standing on one of them at the boundary
    // walks (or slides) off and falls out of the world. Other surfaces
    // (devices, exits, actor tops) still act as a railing, and pushables are
    // always railed. Per-level default policy comes from playData.edgeFalls
    // ({left,right,up,down} or true for all); per-move options.edgeFalls
    // overrides on.
    const levelEdgeFalls = (() => {
      const source = playData?.edgeFalls;

      if (source === true) {
        return { left: true, right: true, up: true, down: true };
      }

      return {
        left: source?.left === true,
        right: source?.right === true,
        up: source?.up === true,
        down: source?.down === true
      };
    })();

    function edgeFallDirectionName(dx, dy) {
      if (dx === 1) return "right";
      if (dx === -1) return "left";
      if (dy === 1) return "down";
      return "up";
    }
    function playerEdgeFallSurfaceAt(state, x, y, elevation, gateState, orangeButtonsPressed) {
      if (!isInsideBoard(x, y)) {
        return false;
      }

      const cell = cellIndex(x, y);
      const layers = terrainLayersForCell(state, cell);

      for (let index = 0; index < layers.length; index += 1) {
        const layer = layers[index];

        if (
          layer.type !== terrainTypes.floor &&
          layer.type !== terrainTypes.ice &&
          layer.type !== terrainTypes.ice_block
        ) {
          continue;
        }

        if (
          terrainLayerSurfaceHeight(state, cell, layer, gateState, orangeButtonsPressed) ===
          elevation
        ) {
          return true;
        }
      }

      return false;
    }

    // FIX(SEMANTICS R5): unified endpoint sweep. Moved main players and
    // clones run endpoint interactions that are not already handled by the
    // walking branch. A clone entering a lift toggles it like a player;
    // riders merely carried with their support do not retrigger that lift.
    function applyEndpointDeviceInteractions(
      state,
      moves,
      pendingLiftToggles,
      gateState,
      orangeButtonsPressed,
      collectedGems,
      searchMode,
      carriedPlayers
    ) {
      const processed = new Set();

      for (let index = moves.length - 1; index >= 0; index -= 1) {
        const record = moves[index];

        if (record.visualOnly || record.toRemoved) {
          continue;
        }

        const actor = record.actorIndex;

        if (processed.has(actor)) {
          continue;
        }

        processed.add(actor);

        if (
          (!isMainPlayerActor(actor) && !isCloneActor(actor)) ||
          state.actorRemoved[actor]
        ) {
          continue;
        }

        const x = state.actorX[actor];
        const y = state.actorY[actor];

        if (
          record.punchSlide === true ||
          (isCloneActor(actor) && !carriedPlayers.has(actor))
        ) {
          const elevation = actorElevation(state, actor);
          const liftLayer = playerLiftLayerAtElevation(
            state,
            x,
            y,
            elevation,
            gateState,
            orangeButtonsPressed
          );
          const alreadyToggled = pendingLiftToggles.some(
            (toggle) => toggle.x === x && toggle.y === y
          );

          if (liftLayer && !alreadyToggled) {
            const toRaised = !isRaisedPlayerLift(state, x, y);
            const toElevation = liftLayer.elevation + (toRaised ? 1 : 0);

            if (
              !liftToggleDestinationBlocked(state, x, y, toElevation, gateState, orangeButtonsPressed)
            ) {
              setPlayerLiftRaised(state, x, y, toRaised);
              pendingLiftToggles.push({ x, y, raised: toRaised });
              jSetActorElevation(state, actor, toElevation);
              record.toElevation = toElevation;
            }
          }

          // Attached-lift twin of the terrain branch above (R5: punched
          // players toggle the lift they land on).
          if (!liftLayer && !alreadyToggled && levelHasAttachedDevices) {
            const attachedLift = attachedLiftIndexAt(state, x, y);

            if (
              attachedLift !== -1 &&
              attachedLiftSurfaceElevation(state, attachedLift) === elevation
            ) {
              const toRaised = state.liftRaised[cellIndex(x, y)] !== 1;
              const toElevation =
                (state.actorElevation[attachedLift] || 0) + (toRaised ? 1 : 0);

              if (
                !liftToggleDestinationBlocked(state, x, y, toElevation, gateState, orangeButtonsPressed)
              ) {
                setPlayerLiftRaised(state, x, y, toRaised);
                pendingLiftToggles.push({ x, y, raised: toRaised, attachedLift });
                jSetActorElevation(state, actor, toElevation);
                record.toElevation = toElevation;
              }
            }
          }
        }

        const finalElevation = actorElevation(state, actor);

        if (isMainPlayerActor(actor) && !isHole(state, x, y, finalElevation)) {
          collectGemsAt(state, x, y, finalElevation, moves, collectedGems, 0, 1, searchMode);
        }
      }
    }

    function applyMovedAttachedLiftInteractions(
      state,
      moves,
      pendingLiftToggles,
      gateState,
      orangeButtonsPressed,
      carriedPlayers
    ) {
      let changed = false;

      for (let liftOffset = 0; liftOffset < attachedLiftIndexes.length; liftOffset += 1) {
        const attachedLift = attachedLiftIndexes[liftOffset];
        const liftMove = moves.find(
          (move) =>
            !move.visualOnly &&
            move.actorIndex === attachedLift &&
            (move.fromX !== move.toX ||
              move.fromY !== move.toY ||
              (move.fromElevation ?? 0) !== (move.toElevation ?? move.fromElevation ?? 0))
        );

        if (!liftMove || state.actorRemoved[attachedLift]) {
          continue;
        }

        const x = state.actorX[attachedLift];
        const y = state.actorY[attachedLift];
        const liftCell = cellIndex(x, y);

        if (pendingLiftToggles.some((toggle) => toggle.x === x && toggle.y === y)) {
          continue;
        }

        const oldSurface = attachedLiftSurfaceElevation(state, attachedLift);
        const occupants = actorsAt(
          state,
          x,
          y,
          (actor) => isPlayerActor(actor) && actorElevation(state, actor) === oldSurface
        );

        if (occupants.length === 0) {
          continue;
        }

        const liftDx = liftMove.toX - liftMove.fromX;
        const liftDy = liftMove.toY - liftMove.fromY;
        const liftDe =
          (liftMove.toElevation ?? liftMove.fromElevation ?? 0) -
          (liftMove.fromElevation ?? 0);
        const liftMovedUnderOccupant = occupants.some((actor) => {
          if (carriedPlayers.has(actor)) {
            return false;
          }

          const actorMove = moves.find(
            (move) => !move.visualOnly && move.actorIndex === actor
          );

          return !(
            actorMove &&
            actorMove.fromX === liftMove.fromX &&
            actorMove.fromY === liftMove.fromY &&
            actorMove.toX - actorMove.fromX === liftDx &&
            actorMove.toY - actorMove.fromY === liftDy &&
            (actorMove.toElevation ?? actorMove.fromElevation ?? 0) -
                (actorMove.fromElevation ?? 0) ===
              liftDe
          );
        });

        if (!liftMovedUnderOccupant) {
          continue;
        }

        const toRaised = state.liftRaised[liftCell] !== 1;
        const newSurface = actorElevation(state, attachedLift) + (toRaised ? 1 : 0);

        if (
          liftToggleDestinationBlocked(
            state,
            x,
            y,
            newSurface,
            gateState,
            orangeButtonsPressed
          )
        ) {
          continue;
        }

        setPlayerLiftRaised(state, x, y, toRaised);
        pendingLiftToggles.push({ x, y, raised: toRaised, attachedLift });

        occupants.forEach((actor) => {
          jSetActorElevation(state, actor, newSurface);
          mergeMoveRecord(
            state,
            moves,
            actor,
            originalActorX,
            originalActorY,
            originalActorElevation
          );
        });
        changed = true;
      }

      return changed;
    }

    function move(state, dx, dy, options = {}) {
      const searchMode = options.search === true;

      // Journal lifecycle: each top-level move starts a fresh journal segment.
      // undoMove() can exactly roll back the most recent move (LIFO — the
      // solver contract); older results fall back to record-based restore.
      journalEpoch += 1;
      journalLength = 0;

      if (searchMode) {
        // Search relies on the incremental hash; establish a valid baseline.
        if (state.hashValid !== true) {
          recomputeHash(state);
        }
      } else {
        // Play-mode buffers can be mutated directly by tooling
        // (scripts/maze-bridge.js teleports/overrides) — never trust a stale
        // incremental hash there; recompute lazily on demand instead.
        state.hashValid = false;
      }

      const occupied = buildOccupiedMap(state);
      const raisedPlayerGates = computeRaisedPlayerGateSet(state);
      const orangeButtonsPressed = computeRaisedOrangeTerrainCells(state, raisedPlayerGates);
      const orderedPlayers = sortPlayersForMove(state, dx, dy).filter(
        (player) => options.suppressCloneInput !== true || !isCloneActor(player)
      );
      const moves = [];
      const collectedGems = new Set();
      const pendingLiftToggles = [];
      originalActorX.set(state.actorX);
      originalActorY.set(state.actorY);
      originalActorElevation.set(state.actorElevation);
      const continuePunchSlide = options.continuePunchSlide === true;
      const carriedPlayers = new Set();
      const preRemovedPlayerOccupancy = new Set();

      orderedPlayers.forEach((player) => {
        if (carriedPlayers.has(player)) {
          return;
        }

        const fromX = state.actorX[player];
        const fromY = state.actorY[player];
        const fromElevation = actorElevation(state, player);
        const canExitLevel = isMainPlayerActor(player);

        if (isCloneActor(player)) {
          const cloneGroupId = actorGroupIds[player] || "";
          const members = cloneGroupMembers(state, cloneGroupId);
          const carriedRiders = cloneRidersForMove(
            state,
            members,
            dx,
            dy,
            raisedPlayerGates,
            orangeButtonsPressed
          );
          const moveStartIndex = moves.length;
          const ignoredActors = new Set(members);
          carriedRiders.forEach((rider) => ignoredActors.add(rider.actorIndex));
          const interlockedMainPlayers = interlockedMainPlayersForCloneMove(
            state,
            members,
            dx,
            dy,
            preRemovedPlayerOccupancy
          );
          interlockedMainPlayers.forEach((actor) => ignoredActors.add(actor));
          const attemptSnapshot = captureAttemptBefore(state);
          const attemptJournalMark = journalMark();
          const clonePushCluster = collectWeightlessPushCluster(
            state,
            cloneGroupId,
            dx,
            dy,
            occupied,
            raisedPlayerGates,
            orangeButtonsPressed,
            ignoredActors,
            "clone"
          );
          let canMoveClone = clonePushCluster !== null;
          let remainingPushBudget = Math.max(1, members.length);
          const handled = new Set();
          const pushedActorMembers = new Set();
          const ridingSupportMembers =
            clonePushCluster && clonePushCluster.blockers.length > 0
              ? (() => {
                  clonePushCluster.blockers.forEach((blocker) => {
                    pushActorMembers(state, blocker).forEach((member) => {
                      pushedActorMembers.add(member);
                    });
                  });

                  return pushedSupportMembersUnderActors(
                    attemptSnapshot,
                    members,
                    Array.from(pushedActorMembers)
                  );
                })()
              : new Set();

          if (canMoveClone) {
            members.forEach((member) => {
              removeOccupiedAtElevation(
                occupied,
                state.actorX[member],
                state.actorY[member],
                actorElevation(state, member)
              );
            });
            carriedRiders.forEach((rider) => {
              removeOccupiedAtElevation(occupied, rider.fromX, rider.fromY, rider.fromElevation);
            });
            interlockedMainPlayers.forEach((actor) => {
              removeOccupiedAtElevation(
                occupied,
                state.actorX[actor],
                state.actorY[actor],
                actorElevation(state, actor)
              );
              preRemovedPlayerOccupancy.add(actor);
            });

            for (const blocker of clonePushCluster.blockers) {
              const result = attemptPushActor(
                state,
                blocker,
                dx,
                dy,
                occupied,
                moves,
                remainingPushBudget,
                handled,
                raisedPlayerGates,
                orangeButtonsPressed,
                ignoredActors,
                searchMode,
                { carriedPlayers }
              );

              if (result === null) {
                canMoveClone = false;
                break;
              }

              remainingPushBudget = result;
            }
          }

          const rideOffsets =
            canMoveClone && ridingSupportMembers.size > 0
              ? supportRidePathOffsets(moves, moveStartIndex, ridingSupportMembers)
              : null;

          if (
            canMoveClone &&
            ((rideOffsets &&
              moveCloneGroupAlongSupportPath(
                state,
                members,
                rideOffsets,
                occupied,
                moves,
                raisedPlayerGates,
                orangeButtonsPressed,
                searchMode,
                {
                  carriedPlayers,
                  carriedRiders,
                  moveStartIndex
                }
              )) ||
            moveWeightlessCluster(
              state,
              clonePushCluster.groupIds,
              dx,
              dy,
              occupied,
              moves,
              raisedPlayerGates,
              orangeButtonsPressed,
              searchMode,
              {
                handled,
                ignoredActors
              },
              "clone",
              {
                carriedPlayers,
                carriedRiders,
                moveStartIndex
              }
            ))
          ) {
            return;
          }

          journalRollback(state, attemptJournalMark);
          occupancyRebuild(state);
          interlockedMainPlayers.forEach((actor) => preRemovedPlayerOccupancy.delete(actor));
          moves.length = moveStartIndex;
          return;
        }

        if (preRemovedPlayerOccupancy.has(player)) {
          preRemovedPlayerOccupancy.delete(player);
        } else {
          removeOccupiedAtElevation(occupied, fromX, fromY, fromElevation);
        }

        let nextX = fromX;
        let nextY = fromY;
        let travelElevation = fromElevation;
        const travelPath = [{ x: fromX, y: fromY, elevation: fromElevation }];
        let iceSlipLanding = null;
        const ignoredPlayerSet = new Set([player]);
        let stepDx = dx;
        let stepDy = dy;
        let reversedAfterSlopeBounce = false;
        let levelExit = null;
        let edgeFall = null;
        let stopAfterStartSlope = false;

        if (!continuePunchSlide && options.startOnCurrentSlope === true) {
          const startSlopeTraversal = resolveIceSlopeTraversal(
            state,
            nextX,
            nextY,
            stepDx,
            stepDy,
            travelElevation,
            occupied,
            raisedPlayerGates,
            orangeButtonsPressed,
            {
              allowLevelExit: true,
              ignoredActors: ignoredPlayerSet
            }
          );

          if (startSlopeTraversal) {
            nextX = startSlopeTraversal.exitX;
            nextY = startSlopeTraversal.exitY;
            travelElevation = startSlopeTraversal.exitElevation;
            appendPathPoints(travelPath, startSlopeTraversal.path);

            if (startSlopeTraversal.levelExit === true) {
              if (canExitLevel) {
                levelExit = {
                  dx: startSlopeTraversal.levelExitDx,
                  dy: startSlopeTraversal.levelExitDy,
                  elevation: startSlopeTraversal.levelExitElevation,
                  sourceType: startSlopeTraversal.levelExitSourceType
                };
              } else {
                stopAfterStartSlope = true;
              }
            } else if (
              !isIce(state, nextX, nextY, travelElevation, raisedPlayerGates, orangeButtonsPressed)
            ) {
              stopAfterStartSlope = true;
            }
          }
        }

        while (true) {
          if (levelExit || stopAfterStartSlope) {
            break;
          }

          const targetX = nextX + stepDx;
          const targetY = nextY + stepDy;
          const isInitialStep =
            travelPath.length === 1 && nextX === fromX && nextY === fromY;

          if (continuePunchSlide) {
            if (!isInsideBoard(targetX, targetY)) {
              if (canExitLevel) {
                levelExit = {
                  dx: stepDx,
                  dy: stepDy,
                  elevation: travelElevation,
                  sourceType: "punch"
                };
              }
              break;
            }

            if (
              terrainBlocksElevation(
                state,
                targetX,
                targetY,
                travelElevation,
                raisedPlayerGates,
                orangeButtonsPressed
              ) ||
              blockingActorAtElevation(state, targetX, targetY, travelElevation, player) !== -1
            ) {
              break;
            }

            nextX = targetX;
            nextY = targetY;
            travelPath.push({
              x: nextX,
              y: nextY,
              elevation: travelElevation
            });
            continue;
          }

          const pushSlopeBlocker = (blocker, pushDx = stepDx, pushDy = stepDy) => {
            const attemptJournalMark = journalMark();
            const moveCount = moves.length;
            // FIX(SEMANTICS R3): compute the push train from the slider's
            // CONTACT position, not the pre-move origin — a lone player
            // ramming a slope mid-slide has no trailing train, while a train
            // standing directly behind the contact cell still counts.
            const pushBudget = countSupportingPlayersAt(
              state,
              player,
              nextX,
              nextY,
              travelElevation,
              pushDx,
              pushDy
            );

            const result = attemptPushActor(
              state,
              blocker,
              pushDx,
              pushDy,
              occupied,
              moves,
              pushBudget,
              new Set(),
              raisedPlayerGates,
              orangeButtonsPressed,
              ignoredPlayerSet,
              searchMode,
              { carriedPlayers }
            );

            if (result !== null) {
              return true;
            }

            journalRollback(state, attemptJournalMark);
            occupancyRebuild(state, player);
            moves.length = moveCount;
            return false;
          };
          const entersIceSlope = iceSlopeTraversalForEntry(
            state,
            targetX,
            targetY,
            stepDx,
            stepDy,
            travelElevation,
            orangeButtonsPressed
          ) !== null;
          let slopeTraversal = resolveIceSlopeTraversal(
            state,
            targetX,
            targetY,
            stepDx,
            stepDy,
            travelElevation,
            occupied,
            raisedPlayerGates,
            orangeButtonsPressed,
            {
              allowLevelExit: true,
              ignoredActors: ignoredPlayerSet,
              pushSlopeBlocker
            }
          );

          if (!slopeTraversal) {
            const blockedSlope = blockedIceSlopePushForEntry(
              state,
              targetX,
              targetY,
              stepDx,
              stepDy,
              travelElevation,
              occupied,
              raisedPlayerGates,
              orangeButtonsPressed,
              new Set([player])
            );

            if (blockedSlope) {
              if (pushSlopeBlocker(blockedSlope.blocker)) {
                slopeTraversal = resolveIceSlopeTraversal(
                  state,
                  targetX,
                  targetY,
                  stepDx,
                  stepDy,
                  travelElevation,
                  occupied,
                  raisedPlayerGates,
                  orangeButtonsPressed,
                  {
                    allowLevelExit: true,
                    ignoredActors: ignoredPlayerSet,
                    pushSlopeBlocker
                  }
                );
              }
            }
          }

          const canTraverseSlope =
            slopeTraversal !== null;
          const moveTargetX = canTraverseSlope ? slopeTraversal.exitX : targetX;
          const moveTargetY = canTraverseSlope ? slopeTraversal.exitY : targetY;
          const moveTargetElevation = canTraverseSlope ? slopeTraversal.exitElevation : travelElevation;
          const canEnterHole = moveTargetElevation === 0 && isHole(state, moveTargetX, moveTargetY, 0);
          const canStandAtTarget = canPlayerStandAtElevation(
            state,
            moveTargetX,
            moveTargetY,
            moveTargetElevation,
            raisedPlayerGates,
            orangeButtonsPressed,
            new Set([player])
          );
          let slipLanding =
            !canEnterHole && !canStandAtTarget
              ? playerIceSlipLanding(
                  state,
                  player,
                  nextX,
                  nextY,
                  moveTargetX,
                  moveTargetY,
                  moveTargetElevation,
                  occupied,
                  raisedPlayerGates,
                  orangeButtonsPressed
                )
              : null;
          let canSlipOffIce = slipLanding !== null;
          const blockingActor =
            !isInsideBoard(targetX, targetY) || canSlipOffIce || canTraverseSlope
              ? -1
              : blockingActorAtElevation(
                  state,
                  moveTargetX,
                  moveTargetY,
                  moveTargetElevation,
                  player
                );
          const supportActor = isInitialStep
            ? pushableSupportActorUnderPlayer(
                state,
                player,
                raisedPlayerGates,
                orangeButtonsPressed
              )
            : -1;
          const attachedDeviceCarrier =
            blockingActor === -1 && isInitialStep && isInsideBoard(moveTargetX, moveTargetY)
              ? raisedAttachedDeviceCarrierAt(
                  state,
                  moveTargetX,
                  moveTargetY,
                  moveTargetElevation,
                  raisedPlayerGates
                )
              : -1;
          const pushingRaisedAttachedDevice = attachedDeviceCarrier !== -1;
          const actorToPush = blockingActor !== -1 ? blockingActor : attachedDeviceCarrier;
          const canAttemptInitialPush =
            actorToPush !== -1 &&
            isInitialStep &&
            !entersIceSlope &&
            isPushableActor(actorToPush);
          let pushedFollowPath = null;
          let pushedFollowTargetX = moveTargetX;
          let pushedFollowTargetY = moveTargetY;
          let pushedFollowTargetElevation = moveTargetElevation;

          if (
            !isInsideBoard(targetX, targetY) ||
            (!canTraverseSlope &&
              !canEnterHole &&
              !canStandAtTarget &&
              !canSlipOffIce &&
              !canAttemptInitialPush)
          ) {
            // Owner rule (2026-07): a main player pressing (or sliding) into
            // the board edge while standing on exposed floor/ice/ice-block
            // falls off the world instead of bumping into an invisible rail.
            // Policy, not mechanism, decides where: options.edgeFalls (the
            // play layer enables it exactly where the world map has no
            // neighboring room in that direction) or the level's own
            // playData.edgeFalls annotation. Identical in play and search
            // modes — the solver simulates the same world the player sees.
            if (
              !isInsideBoard(targetX, targetY) &&
              (options.edgeFalls === true ||
                levelEdgeFalls[edgeFallDirectionName(stepDx, stepDy)] === true) &&
              canExitLevel &&
              !continuePunchSlide &&
              playerEdgeFallSurfaceAt(
                state,
                nextX,
                nextY,
                travelElevation,
                raisedPlayerGates,
                orangeButtonsPressed
              )
            ) {
              edgeFall = { dx: stepDx, dy: stepDy };
            }

            if (isInsideBoard(targetX, targetY)) {
              const bouncePath = blockedIceSlopeBouncePathForEntry(
                state,
                targetX,
                targetY,
                stepDx,
                stepDy,
                travelElevation,
                occupied,
                raisedPlayerGates,
                orangeButtonsPressed
              );

              if (bouncePath && bouncePath.length > 0) {
                const returnPath = bouncePath
                  .slice(0, -1)
                  .reverse()
                  .map((point) => ({ ...point }));
                const pathHome = { x: nextX, y: nextY, elevation: travelElevation };

                if (
                  !reversedAfterSlopeBounce &&
                  isIce(state, nextX, nextY, travelElevation, raisedPlayerGates, orangeButtonsPressed)
                ) {
                  appendPathPoints(travelPath, bouncePath.map((point) => ({ ...point })));
                  appendPathPoints(travelPath, returnPath);
                  appendPathPoints(travelPath, [pathHome]);
                  stepDx = -stepDx;
                  stepDy = -stepDy;
                  reversedAfterSlopeBounce = true;
                  continue;
                }

                if (travelPath.length > 1) {
                  appendPathPoints(travelPath, bouncePath.map((point) => ({ ...point })));
                  appendPathPoints(travelPath, returnPath);
                  appendPathPoints(travelPath, [pathHome]);
                } else if (!searchMode) {
                  moves.push({
                    actorIndex: player,
                    actorType: actorTypes[player],
                    fromX: nextX,
                    fromY: nextY,
                    toX: nextX,
                    toY: nextY,
                    finalX: nextX,
                    finalY: nextY,
                    fromElevation: travelElevation,
                    toElevation: travelElevation,
                    finalElevation: travelElevation,
                    path: [
                      pathHome,
                      ...bouncePath,
                      ...returnPath,
                      { ...pathHome }
                    ],
                    pathControlsElevation: true,
                    pathEndElevation: travelElevation,
                    iceSlide: true,
                    visualOnly: true
                  });
                }
              }
            }

            break;
          }

          if (actorToPush !== -1) {
            let didMoveBlockingActor = false;

            if (canAttemptInitialPush) {
              const attemptSnapshot = captureAttemptBefore(state);
              const attemptJournalMark = journalMark();
              const moveCount = moves.length;
              const pushBudget = countSupportingPlayers(state, player, stepDx, stepDy);
              const pushedActorMembers = pushActorMembers(state, actorToPush);
              const pushRidesSupport =
                supportActor !== -1 &&
                pushEntityKey(supportActor) === pushEntityKey(actorToPush);

              const result = attemptPushActor(
                state,
                actorToPush,
                stepDx,
                stepDy,
                occupied,
                moves,
                pushBudget,
                new Set(),
                raisedPlayerGates,
                orangeButtonsPressed,
                new Set([player]),
                searchMode,
                {
                  predictedSupports: [
                    {
                      actorIndex: player,
                      x: moveTargetX,
                      y: moveTargetY,
                      elevation: moveTargetElevation
                    }
                  ],
                  pusherX: fromX,
                  pusherY: fromY,
                  pusherElevation: fromElevation,
                  carriedPlayers
                }
              );

              if (result !== null) {
                const ridingSupportMembers = pushRidesSupport
                  ? pushedSupportMembersUnderPlayer(attemptSnapshot, player, pushedActorMembers)
                  : new Set();
                const rideFollowPath =
                  ridingSupportMembers.size > 0
                    ? playerRidePathForPushedSupport(moves, moveCount, ridingSupportMembers)
                    : null;
                const canFollowPushedIcePath = isIce(
                  state,
                  nextX,
                  nextY,
                  travelElevation,
                  raisedPlayerGates,
                  orangeButtonsPressed
                );
                const followPath =
                  rideFollowPath ||
                  (canFollowPushedIcePath
                    ? playerFollowPathForPushedMove(
                        moves,
                        moveCount,
                        actorToPush,
                        stepDx,
                        stepDy
                      )
                    : null);
                const followTarget =
                  followPath && followPath.length > 1 ? followPath[followPath.length - 1] : null;
                pushedFollowPath = followPath && followPath.length > 1 ? followPath : null;
                pushedFollowTargetX = followTarget?.x ?? moveTargetX;
                pushedFollowTargetY = followTarget?.y ?? moveTargetY;
                pushedFollowTargetElevation = followTarget?.elevation ?? moveTargetElevation;
                const ignoredPostPushSupports = new Set([player, ...pushedActorMembers]);
                ridingSupportMembers.forEach((member) => ignoredPostPushSupports.delete(member));
                if (pushedFollowPath) {
                  const followTargetBlocked =
                    blockingActorAtElevation(
                      state,
                      pushedFollowTargetX,
                      pushedFollowTargetY,
                      pushedFollowTargetElevation,
                      player
                    ) !== -1;
                  const followCanEnterHole =
                    pushedFollowTargetElevation === 0 &&
                    isHole(state, pushedFollowTargetX, pushedFollowTargetY, 0);
                  const followCanStand =
                    !followTargetBlocked &&
                    canPlayerStandAtElevation(
                      state,
                      pushedFollowTargetX,
                      pushedFollowTargetY,
                      pushedFollowTargetElevation,
                      raisedPlayerGates,
                      orangeButtonsPressed,
                      ignoredPostPushSupports
                    );

                  if (followTargetBlocked || (!followCanEnterHole && !followCanStand)) {
                    pushedFollowPath = null;
                    pushedFollowTargetX = moveTargetX;
                    pushedFollowTargetY = moveTargetY;
                    pushedFollowTargetElevation = moveTargetElevation;
                  }
                }
                const postPushCanEnterHole =
                  pushedFollowTargetElevation === 0 &&
                  isHole(state, pushedFollowTargetX, pushedFollowTargetY, 0);
                const targetBlockedAfterPush =
                  blockingActorAtElevation(
                    state,
                    pushedFollowTargetX,
                    pushedFollowTargetY,
                    pushedFollowTargetElevation,
                    player
                  ) !== -1;
                const canStandAtTargetAfterPush =
                  !targetBlockedAfterPush &&
                  canPlayerStandAtElevation(
                    state,
                    pushedFollowTargetX,
                    pushedFollowTargetY,
                    pushedFollowTargetElevation,
                    raisedPlayerGates,
                    orangeButtonsPressed,
                    ignoredPostPushSupports
                );
                const postPushSlipLanding =
                  !targetBlockedAfterPush && !postPushCanEnterHole && !canStandAtTargetAfterPush
                    ? playerIceSlipLanding(
                        state,
                        player,
                        nextX,
                        nextY,
                        pushedFollowTargetX,
                        pushedFollowTargetY,
                        pushedFollowTargetElevation,
                        occupied,
                        raisedPlayerGates,
                        orangeButtonsPressed
                      )
                    : null;
                const canOccupyTargetAfterPush =
                  !targetBlockedAfterPush &&
                  (postPushCanEnterHole ||
                    canStandAtTargetAfterPush ||
                    postPushSlipLanding !== null ||
                    // The raised fixture is still at its old actor position
                    // until the attachment sync later in the turn. Treat
                    // that vacated band like a normal pushed-block cell so
                    // the pusher advances in lockstep; endpoint support
                    // resolution then settles it to any lower surface.
                    pushingRaisedAttachedDevice);

                if (canOccupyTargetAfterPush) {
                  if (postPushSlipLanding) {
                    slipLanding = postPushSlipLanding;
                    canSlipOffIce = true;
                  }
                  didMoveBlockingActor = true;
                } else {
                  journalRollback(state, attemptJournalMark);
                  occupancyRebuild(state, player);
                  moves.length = moveCount;
                }
              } else {
                journalRollback(state, attemptJournalMark);
                occupancyRebuild(state, player);
                moves.length = moveCount;
              }
            }

            if (!didMoveBlockingActor) {
              break;
            }
          }

          nextX = pushedFollowTargetX;
          nextY = pushedFollowTargetY;
          travelElevation = pushedFollowTargetElevation;

          if (pushedFollowPath) {
            appendPathPoints(travelPath, pushedFollowPath.slice(1));
          } else if (canTraverseSlope) {
            travelPath.push(...slopeTraversal.path);
            if (slopeTraversal.levelExit === true) {
              if (canExitLevel) {
                levelExit = {
                  dx: slopeTraversal.levelExitDx,
                  dy: slopeTraversal.levelExitDy,
                  elevation: slopeTraversal.levelExitElevation,
                  sourceType: slopeTraversal.levelExitSourceType
                };
              } else {
                stopAfterStartSlope = true;
              }
            }
          } else {
            travelPath.push({
              x: nextX,
              y: nextY,
              elevation: travelElevation
            });
          }

          if (canSlipOffIce) {
            iceSlipLanding = slipLanding;
            if (Array.isArray(slipLanding.path)) {
              travelPath.push(...slipLanding.path);
            }
            if (Number.isInteger(slipLanding.toX) && Number.isInteger(slipLanding.toY)) {
              nextX = slipLanding.toX;
              nextY = slipLanding.toY;
            }
            travelElevation = slipLanding.toElevation;
            break;
          }

          if (levelExit) {
            break;
          }

          if (!isIce(state, nextX, nextY, travelElevation, raisedPlayerGates, orangeButtonsPressed)) {
            break;
          }
        }

        let occupiedElevation = fromElevation;

        if (continuePunchSlide && !levelExit) {
          const landingElevation = landingElevationAtLocation(
            state,
            nextX,
            nextY,
            travelElevation,
            occupied,
            raisedPlayerGates,
            orangeButtonsPressed,
            ignoredPlayerSet
          );

          if (landingElevation !== null && landingElevation !== travelElevation) {
            travelElevation = landingElevation;
            travelPath.push({
              x: nextX,
              y: nextY,
              elevation: travelElevation
            });
          }
        }

        if (nextX !== fromX || nextY !== fromY || travelElevation !== fromElevation || levelExit || edgeFall) {
          jSetActorX(state, player, nextX);
          jSetActorY(state, player, nextY);
          let toElevation = fromElevation;

          const playerLiftLayer = playerLiftLayerAtElevation(
            state,
            nextX,
            nextY,
            travelElevation,
            raisedPlayerGates,
            orangeButtonsPressed
          );

          if (continuePunchSlide) {
            toElevation = travelElevation;
          } else if (playerLiftLayer) {
            const toRaised = !isRaisedPlayerLift(state, nextX, nextY);
            const liftedElevation = playerLiftLayer.elevation + (toRaised ? 1 : 0);

            // FIX(SEMANTICS §devices): a lift never moves its rider into a
            // terrain-blocked voxel (e.g. a bridge layer authored above the
            // lift — legacy embedded the player in the bridge and soft-locked
            // the game). The step succeeds; the toggle is refused.
            if (
              !liftToggleDestinationBlocked(
                state,
                nextX,
                nextY,
                liftedElevation,
                raisedPlayerGates,
                orangeButtonsPressed
              )
            ) {
              pendingLiftToggles.push({
                x: nextX,
                y: nextY,
                raised: toRaised
              });
              toElevation = liftedElevation;
            } else {
              toElevation =
                playerLiftLayer.elevation + (isRaisedPlayerLift(state, nextX, nextY) ? 1 : 0);
            }
          } else if (
            levelHasAttachedDevices &&
            attachedLiftIndexAt(state, nextX, nextY) !== -1 &&
            attachedLiftSurfaceElevation(state, attachedLiftIndexAt(state, nextX, nextY)) ===
              travelElevation
          ) {
            // Owner rule (2026-07): an attached lift is a working lift. A
            // player ending its move on the platform toggles it and rides,
            // exactly like the terrain branch above — relative to the
            // carrier top instead of a terrain layer.
            const attachedLift = attachedLiftIndexAt(state, nextX, nextY);
            const liftCell = cellIndex(nextX, nextY);
            const toRaised = state.liftRaised[liftCell] !== 1;
            const liftedElevation = (state.actorElevation[attachedLift] || 0) + (toRaised ? 1 : 0);

            if (
              !liftToggleDestinationBlocked(
                state,
                nextX,
                nextY,
                liftedElevation,
                raisedPlayerGates,
                orangeButtonsPressed
              )
            ) {
              pendingLiftToggles.push({
                x: nextX,
                y: nextY,
                raised: toRaised,
                attachedLift
              });
              toElevation = liftedElevation;
            } else {
              toElevation = travelElevation;
            }
          } else if (iceSlipLanding) {
            toElevation = iceSlipLanding.toElevation;
          } else {
            const canStandAtTravelElevation = canPlayerStandAtElevation(
              state,
              nextX,
              nextY,
              travelElevation,
              raisedPlayerGates,
              orangeButtonsPressed,
              ignoredPlayerSet
            );

            if (isHole(state, nextX, nextY, travelElevation) && !canStandAtTravelElevation) {
              toElevation = travelElevation;
            } else {
              toElevation =
                playerSurfaceHeightAt(
                  state,
                  nextX,
                  nextY,
                  raisedPlayerGates,
                  orangeButtonsPressed,
                  travelElevation,
                  ignoredPlayerSet
                ) ?? travelElevation;
            }
          }

          const pathEndElevation = travelPath[travelPath.length - 1]?.elevation ?? travelElevation;

          if (!playerLiftLayer && toElevation !== pathEndElevation) {
            travelPath.push({
              x: nextX,
              y: nextY,
              elevation: toElevation
            });
          }

          jSetActorElevation(state, player, toElevation);
          occupiedElevation = toElevation;

          const travelDistance = Math.abs(nextX - fromX) + Math.abs(nextY - fromY);
          const moveRecord = {
            actorIndex: player,
            actorType: actorTypes[player],
            fromX,
            fromY,
            toX: nextX,
            toY: nextY,
            fromElevation,
            toElevation
          };
          const pathControlsElevation = travelPath.some((point) => point.elevation !== fromElevation);

          if (travelPath.length > 2 || pathControlsElevation) {
            moveRecord.path = travelPath;
            moveRecord.pathControlsElevation = pathControlsElevation;
            moveRecord.pathEndElevation = pathEndElevation;
          }

          if (!searchMode) {
            moveRecord.iceSlide =
              continuePunchSlide ||
              travelDistance > 1 ||
              iceSlipLanding !== null ||
              travelPath.length > 2 ||
              pathControlsElevation;

            if (levelExit) {
              moveRecord.levelExit = true;
              moveRecord.levelExitDx = levelExit.dx;
              moveRecord.levelExitDy = levelExit.dy;
              moveRecord.levelExitElevation = levelExit.elevation;
              moveRecord.levelExitSourceType = levelExit.sourceType;
            }
          }

          // FIX(SEMANTICS R2): punchSlide and iceSlipOff drive pit removal in
          // applyHoleFalls — they are semantic flags and must exist in both
          // modes so search simulates the same deaths as play.
          if (continuePunchSlide) {
            moveRecord.punchSlide = true;
          }

          if (
            iceSlipLanding ||
            (!playerLiftLayer &&
              (toElevation !== (moveRecord.pathEndElevation ?? toElevation) ||
                !canPlayerStandAtElevation(
                  state,
                  nextX,
                  nextY,
                  toElevation,
                  raisedPlayerGates,
                  orangeButtonsPressed
                )))
          ) {
            moveRecord.iceSlipOff = true;
          }

          if (edgeFall) {
            // The player leaves the world: removed at the boundary cell (the
            // state never holds out-of-board coordinates), with the fall
            // direction recorded for the renderer.
            moveRecord.toRemoved = true;
            moveRecord.edgeFall = true;
            moveRecord.edgeFallDx = edgeFall.dx;
            moveRecord.edgeFallDy = edgeFall.dy;
          }

          moves.push(moveRecord);

          if (
            !edgeFall &&
            !isHole(state, nextX, nextY, toElevation)
          ) {
            collectGemsAtEndpoint(
              state,
              fromX,
              fromY,
              nextX,
              nextY,
              toElevation,
              moves,
              collectedGems,
              searchMode
            );

            // FIX(SEMANTICS §devices): stepping onto a lift is a co-location
            // with whatever rests on the platform — collect gems at the
            // arrival elevation too, before the toggle raised the player.
            // Legacy compared only post-toggle elevations, so a gem sitting
            // on a lowered lift was never collectable.
            if (playerLiftLayer && toElevation !== travelElevation) {
              collectGemsAtEndpoint(
                state,
                fromX,
                fromY,
                nextX,
                nextY,
                travelElevation,
                moves,
                collectedGems,
                searchMode
              );
            }
          }
        } else if (!searchMode && travelPath.length > 1) {
          const pathEndElevation = travelPath[travelPath.length - 1]?.elevation ?? fromElevation;

          moves.push({
            actorIndex: player,
            actorType: actorTypes[player],
            fromX,
            fromY,
            toX: fromX,
            toY: fromY,
            finalX: fromX,
            finalY: fromY,
            fromElevation,
            toElevation: fromElevation,
            finalElevation: fromElevation,
            path: travelPath,
            pathControlsElevation: travelPath.some((point) => point.elevation !== fromElevation),
            pathEndElevation,
            iceSlide: true,
            visualOnly: true
          });
        }

        addOccupiedAtElevation(
          occupied,
          state.actorX[player],
          state.actorY[player],
          occupiedElevation
        );
      });

      if (moves.length > 0) {
        collapseSequentialActorMoves(moves);

        // FIX(SEMANTICS §devices): lift toggles apply BEFORE punch resolution.
        // Legacy applied them after, so a punch could slide an actor onto a
        // lift cell that was about to raise, and the second hole-fall pass
        // then silently erased the actor (a live player deleted on a board
        // with no holes). With the toggle applied first, the raised lift
        // simply blocks the punch.
        //
        // FIX(SEMANTICS §devices): non-player actors resting exactly on the
        // lift surface ride the toggle — a puncher on a lift used to be
        // entombed at its stale elevation and never trigger again, and boxes
        // were stranded the same way. Players own their elevation via their
        // endpoint logic; gems float (owner decision). Rides never enter a
        // terrain-blocked voxel.
        pendingLiftToggles.forEach(({ x, y, raised, attachedLift }) => {
          const liftCell = cellIndex(x, y);
          const isAttachedToggle = typeof attachedLift === "number";
          const liftLayer = isAttachedToggle
            ? null
            : terrainLayersForCell(state, liftCell).find(
                (layer) => layer.type === terrainTypes.player_lift
              ) || null;
          const liftBaseElevation = isAttachedToggle
            ? state.actorElevation[attachedLift] || 0
            : liftLayer
              ? liftLayer.elevation
              : null;
          const oldSurface =
            liftBaseElevation === null
              ? null
              : liftBaseElevation + (state.liftRaised[liftCell] === 1 ? 1 : 0);

          setPlayerLiftRaised(state, x, y, raised);

          if (liftBaseElevation === null) {
            return;
          }

          const newSurface = liftBaseElevation + (raised ? 1 : 0);

          if (newSurface === oldSurface) {
            return;
          }

          for (let index = 0; index < actorCount; index += 1) {
            if (
              state.actorRemoved[index] ||
              isPlayerActor(index) ||
              isCollectibleActor(index) ||
              // Attached devices never ride lift toggles: the toggling
              // attached lift owns its elevation (always the carrier top),
              // and sibling devices follow their carrier via the
              // surface-attachment sync instead.
              isAttachedDeviceType(actorTypes[index]) ||
              state.actorX[index] !== x ||
              state.actorY[index] !== y ||
              (state.actorElevation[index] || 0) !== oldSurface
            ) {
              continue;
            }

            let target = newSurface;

            if (newSurface > oldSurface) {
              while (
                target > oldSurface &&
                terrainBlocksElevation(state, x, y, target, raisedPlayerGates, orangeButtonsPressed)
              ) {
                target -= 1;
              }

              if (target === oldSurface) {
                continue;
              }
            }

            jSetActorElevation(state, index, target);
            mergeMoveRecord(
              state,
              moves,
              index,
              originalActorX,
              originalActorY,
              originalActorElevation
            );
          }
        });

        let movedPuncherCandidates = syncAttachedPunchersForMoves(
          state,
          moves,
          originalActorX,
          originalActorY,
          originalActorElevation,
          searchMode
        );

        applyPunchers(
          state,
          moves,
          originalActorX,
          originalActorY,
          originalActorElevation,
          searchMode,
          raisedPlayerGates,
          orangeButtonsPressed,
          movedPuncherCandidates.size > 0
            ? {
                candidateActorIndexes: movedPuncherCandidates,
                includeUnpunchedMovedActors: true,
                sequenceBase: nextPunchSequence(moves)
              }
            : {}
        );
        movedPuncherCandidates = syncAttachedPunchersForMoves(
          state,
          moves,
          originalActorX,
          originalActorY,
          originalActorElevation,
          searchMode
        );
        let stickyPuncherPassCount = 0;

        while (
          movedPuncherCandidates.size > 0 &&
          stickyPuncherPassCount < actorCount + width + height
        ) {
          stickyPuncherPassCount += 1;
          applyPunchers(
            state,
            moves,
            originalActorX,
            originalActorY,
            originalActorElevation,
            searchMode,
            raisedPlayerGates,
            orangeButtonsPressed,
            {
              candidateActorIndexes: movedPuncherCandidates,
              includeUnpunchedMovedActors: true,
              sequenceBase: nextPunchSequence(moves)
            }
          );
          movedPuncherCandidates = syncAttachedPunchersForMoves(
            state,
            moves,
            originalActorX,
            originalActorY,
            originalActorElevation,
            searchMode
          );
        }
        collapseSequentialActorMoves(moves);
        applyEndpointDeviceInteractions(
          state,
          moves,
          pendingLiftToggles,
          raisedPlayerGates,
          orangeButtonsPressed,
          collectedGems,
          searchMode,
          carriedPlayers
        );
        applyHoleFalls(state, moves);
        applyMoveFinalState(state, moves);
        // Move surface fixtures before support reconciliation so a player or
        // clone carried on a raised attached lift sees that lift at the
        // carrier's destination instead of falling into its stale position.
        syncAttachedSurfaceAttachmentsForMoves(
          state,
          moves,
          originalActorX,
          originalActorY,
          originalActorElevation,
          searchMode
        );
        applyMovedAttachedLiftInteractions(
          state,
          moves,
          pendingLiftToggles,
          raisedPlayerGates,
          orangeButtonsPressed,
          carriedPlayers
        );
        syncDynamicActorElevationsAndFalls(state, moves, raisedPlayerGates, orangeButtonsPressed);
        syncAttachedPunchersForMoves(
          state,
          moves,
          originalActorX,
          originalActorY,
          originalActorElevation,
          searchMode
        );
        syncAttachedSurfaceAttachmentsForMoves(
          state,
          moves,
          originalActorX,
          originalActorY,
          originalActorElevation,
          searchMode
        );
        if (
          applyMovedAttachedLiftInteractions(
            state,
            moves,
            pendingLiftToggles,
            raisedPlayerGates,
            orangeButtonsPressed,
            carriedPlayers
          )
        ) {
          syncDynamicActorElevationsAndFalls(
            state,
            moves,
            raisedPlayerGates,
            orangeButtonsPressed
          );
        }
        applyHoleFalls(state, moves);
        applyMoveFinalState(state, moves);
      }

      let effectiveMoveCount = 0;

      for (let index = 0; index < moves.length; index += 1) {
        if (moves[index].visualOnly !== true) {
          effectiveMoveCount += 1;
        }
      }

      return {
        direction: directionNames[`${dx},${dy}`] || "",
        liftToggles: pendingLiftToggles.map(({ x, y, raised }) => ({ x, y, raised })),
        raisedOrangeWalls: raisedOrangeWallKeys(state),
        // FIX(SEMANTICS): moved reflects a real state change in BOTH modes.
        // Legacy play mode returned moved:true for zero-effect visual bounce
        // records, so agents scored no-op inputs as successful moves and the
        // solver's move graph disagreed with play mode.
        moved: effectiveMoveCount > 0,
        moves,
        _jStart: 0,
        _jEnd: journalLength,
        _jEpoch: journalEpoch
      };
    }

    function countNonPlayerMoves(moves) {
      let count = 0;

      searchSeenStamp += 1;

      if (searchSeenStamp >= 4294967295) {
        searchSeenActors.fill(0);
        searchSeenStamp = 1;
      }

      moves.forEach((moveRecord) => {
        if (
          moveRecord.visualOnly ||
          moveRecord.actorType === "puncher" ||
          moveRecord.actorType === "orange_button" ||
          isAttachedDeviceType(moveRecord.actorType) ||
          isPlayerType(moveRecord.actorType) ||
          isCollectibleType(moveRecord.actorType) ||
          (moveRecord.fromX === moveRecord.toX && moveRecord.fromY === moveRecord.toY)
        ) {
          return;
        }

        if (searchSeenActors[moveRecord.actorIndex] === searchSeenStamp) {
          return;
        }

        searchSeenActors[moveRecord.actorIndex] = searchSeenStamp;
        count += 1;
      });

      return count;
    }

    function moveForSearch(state, dx, dy) {
      const result = move(state, dx, dy, { search: true });
      result.nonPlayerMoveCount = result.moved ? countNonPlayerMoves(result.moves) : 0;
      return result;
    }

    function undoMove(state, moveResult) {
      if (!moveResult?.moved || !Array.isArray(moveResult.moves)) {
        return;
      }

      // Fast path (the solver contract): undoing the most recent move rolls
      // the journal back and restores the buffer bit-for-bit, including
      // elevations the legacy record-replay undo corrupted (audit: elevated
      // gems reset to 0 on backtrack, poisoning every A* sibling branch).
      if (
        moveResult._jEpoch === journalEpoch &&
        typeof moveResult._jStart === "number" &&
        moveResult._jEnd === journalLength
      ) {
        journalRollback(state, moveResult._jStart);
        return;
      }

      // Fallback for non-LIFO undo (another move ran in between): restore
      // from the move records. Records always carry fromElevation now — the
      // legacy gem records lacked it, which is what made this path corrupt.
      for (let index = moveResult.moves.length - 1; index >= 0; index -= 1) {
        const moveRecord = moveResult.moves[index];

        if (moveRecord.visualOnly) {
          continue;
        }

        const actorIndex = moveRecord.actorIndex;

        state.actorX[actorIndex] = moveRecord.fromX;
        state.actorY[actorIndex] = moveRecord.fromY;
        state.actorElevation[actorIndex] = moveRecord.fromElevation ?? 0;
        state.actorRemoved[actorIndex] = moveRecord.fromRemoved ? 1 : 0;

        if (
          moveRecord.fillsHole &&
          typeof moveRecord.fillHoleX === "number" &&
          typeof moveRecord.fillHoleY === "number"
        ) {
          state.terrain[cellIndex(moveRecord.fillHoleX, moveRecord.fillHoleY)] =
            Number.isInteger(moveRecord.fillHolePreviousTerrain)
              ? moveRecord.fillHolePreviousTerrain
              : terrainTypes.empty;
        }
      }

      if (Array.isArray(moveResult.liftToggles)) {
        moveResult.liftToggles.forEach(({ x, y, raised }) => {
          state.liftRaised[cellIndex(x, y)] = raised ? 0 : 1;
        });
      }

      state.hashValid = false;
    }

    // FIX(SEMANTICS R5): solved means COLLECTED. Legacy had a second clause
    // counting any live player-type actor merely co-located with a live gem —
    // clones included — so the solver returned "solutions" (clone parked on a
    // gem) that collected nothing when replayed, and a solved state could
    // become unsolved one move later. Main players now collect gems at every
    // arrival mode (walk, punch, carried), so the co-location clause is
    // unnecessary as well as wrong.
    function isSolved(state) {
      for (let index = 0; index < actorCount; index += 1) {
        if (
          actorTypes[index] === "gem" &&
          state.actorRemoved[index] &&
          !initialGemRemoved[index]
        ) {
          return true;
        }
      }

      return false;
    }

    // FIX(SEMANTICS §heuristic): the default heuristic is ADMISSIBLE. One
    // input moves a player along exactly one axis (however many cells it
    // slides), so reaching a gem needs at least one move per differing axis.
    // The legacy Manhattan+elevation heuristic overestimates on ice — a
    // 7-cell slide costs 1 move, not 7 — which made algorithm:'astar' return
    // non-minimal "minimum move" counts on any ice level. The legacy
    // distance heuristic remains available as heuristicDistance for
    // weighted/greedy search modes.
    function heuristic(state) {
      let best = Infinity;
      let hasPlayer = false;
      let hasGem = false;

      for (let player = 0; player < actorCount; player += 1) {
        if (!isPlayerActor(player) || state.actorRemoved[player]) {
          continue;
        }

        hasPlayer = true;

        for (let gem = 0; gem < actorCount; gem += 1) {
          if (actorTypes[gem] !== "gem" || state.actorRemoved[gem]) {
            continue;
          }

          hasGem = true;

          // Without long-movers, every input advances a player at most one
          // cell, so Manhattan distance is admissible. With ice/slopes/
          // punchers, one input can cross many cells — only the axis count
          // is a safe lower bound.
          const cost = levelHasLongPlayerMoves
            ? (state.actorX[player] !== state.actorX[gem] ? 1 : 0) +
              (state.actorY[player] !== state.actorY[gem] ? 1 : 0)
            : Math.abs(state.actorX[player] - state.actorX[gem]) +
              Math.abs(state.actorY[player] - state.actorY[gem]);

          best = Math.min(best, cost);
        }
      }

      return hasPlayer && hasGem && Number.isFinite(best) ? best : 0;
    }

    function heuristicDistance(state) {
      let best = Infinity;
      let hasPlayer = false;
      let hasGem = false;

      for (let player = 0; player < actorCount; player += 1) {
        if (!isPlayerActor(player) || state.actorRemoved[player]) {
          continue;
        }

        hasPlayer = true;

        for (let gem = 0; gem < actorCount; gem += 1) {
          if (actorTypes[gem] !== "gem" || state.actorRemoved[gem]) {
            continue;
          }

          hasGem = true;

          best = Math.min(
            best,
            Math.abs(state.actorX[player] - state.actorX[gem]) +
              Math.abs(state.actorY[player] - state.actorY[gem]) +
              Math.abs(actorElevation(state, player) - actorElevation(state, gem))
          );
        }
      }

      return hasPlayer && hasGem && Number.isFinite(best) ? best : 0;
    }

    function isPlayerMove(moveRecord) {
      return isPlayerType(moveRecord?.actorType);
    }

    const initialState = createInitialState();

    return {
      actorCount,
      actorGroupIds,
      actorTypes,
      areOrangeButtonsPressed,
      cellCount,
      cellIndex,
      cloneState,
      computeRaisedPlayerGateSet,
      copyStateInto,
      createStateBuffer,
      height,
      heuristic,
      initialState,
      heuristicDistance,
      isPlayerLift,
      isPlayerMove,
      isSolved,
      loadWarnings,
      move,
      moveForSearch,
      pressedOrangeWallLowersAsBlock,
      raisedOrangeWallKeys,
      stateKey,
      terrainTypes,
      undoMove,
      width
    };
  }

  window.MazeEngine = {
    createEngine,
    terrainTypes
  };
})();
