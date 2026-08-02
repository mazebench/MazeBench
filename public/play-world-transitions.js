(function () {
  const modules = window.PlayModules || (window.PlayModules = {});

  modules.registerWorldTransitionFunctions = function registerWorldTransitionFunctions(app) {
    const playRules = modules.PlayRules;

    if (!playRules) {
      throw new Error("PlayRules must be loaded before play-world-transitions.js");
    }

    const {
      state,
      moveHistory,
      PLAYER_REVIVE_BLINK_DURATION_MS,
      HOLE_SINK_DISTANCE
    } = app;
    const renderCompositor = app.renderCompositor || app;
    const {
      cloneActorPositions,
      cloneTerrainState,
      isPlayerActor,
      isMainPlayerActor,
      actorElevation,
      computeRaisedPlayerGateSet,
      computeRaisedOrangeWallSet,
      playerSurfaceHeightAt,
      cloneLevelSnapshot,
      prepareLevelRenderState,
      applyLevelState,
      loadLevelState,
      cachedHorizontalNeighborLevelState,
      loadHorizontalNeighborLevelState,
      syncFloatingFloorTicker
    } = app;
    const {
      startLevelTransition
    } = renderCompositor;
    const transitionWarmups = new Map();
    const TRANSITION_WARMUP_CACHE_LIMIT = 8;
    const isTransitionPlayerActor =
      typeof isMainPlayerActor === "function"
        ? isMainPlayerActor
        : (actor) => isPlayerActor(actor) && actor?.type !== "clone";

    function cloneStoredLevelSnapshot(snapshot) {
      if (!snapshot) {
        return null;
      }

      return {
        ...snapshot,
        terrain: cloneTerrainState(snapshot.terrain || []),
        actors: (snapshot.actors || []).map((actor) => ({ ...actor })),
        checkpoints: (snapshot.checkpoints || []).map((checkpoint) => ({ ...checkpoint }))
      };
    }

    function restoreLevelEntryState(snapshot) {
      const storedSnapshot = cloneStoredLevelSnapshot(snapshot);

      if (!storedSnapshot) {
        return;
      }

      app.levelEntrySnapshot = storedSnapshot;
      app.initialTerrain = cloneTerrainState(storedSnapshot.terrain);
      app.initialPositions = (storedSnapshot.actors || []).map((actor) => ({
        x: actor.x,
        y: actor.y,
        removed: Boolean(actor.removed),
        elevation: actor.elevation ?? 0,
        raised: actor.raised === true,
        collectionId: actor.collectionId || null,
        collected: actor.collected === true,
        showCollectedGhost: actor.showCollectedGhost === true
      }));
    }

    function terrainCellInLevelState(levelState, x, y) {
      if (!Array.isArray(levelState?.terrain) || !Number.isInteger(x) || !Number.isInteger(y)) {
        return null;
      }

      return levelState.terrain[y]?.[x] || null;
    }

    function playerStartForLevelState(levelState, preferredType = null) {
      const players = (levelState?.actors || []).filter((actor) => isTransitionPlayerActor(actor));

      if (players.length === 0) {
        return null;
      }

      return players.find((actor) => actor.type === preferredType) || players[0];
    }

    function isAllowedEdgeTransition(sourceType, targetType) {
      if (!sourceType || !targetType) {
        return false;
      }

      if (sourceType === "floor" && targetType === "hole") {
        return true;
      }

      return sourceType === targetType;
    }

    function isAllowedPunchContinuationTarget(levelState, x, y, elevation) {
      return !transitionTerrainBlocksElevation(
        levelState,
        x,
        y,
        elevation,
        {
          raisedPlayerGates: levelState.raisedPlayerGates
            ? new Set(levelState.raisedPlayerGates)
            : null,
          raisedOrangeWalls: levelState.raisedOrangeWalls
            ? new Set(levelState.raisedOrangeWalls)
            : null
        }
      );
    }

    function isAllowedTransitionTarget(transition, sourceType, targetType, levelState, x, y, elevation) {
      if (transition?.continuePunchSlide === true) {
        return isAllowedPunchContinuationTarget(levelState, x, y, elevation);
      }

      return isAllowedEdgeTransition(sourceType, targetType);
    }

    function continuationMoveController(transition, transitionData) {
      if (transition?.continueMove !== true || transition.entersHole === true) {
        return null;
      }

      const dx = Number(transition.dx);
      const dy = Number(transition.dy);

      if (!Number.isInteger(dx) || !Number.isInteger(dy) || (dx === 0 && dy === 0)) {
        return null;
      }

      let started = false;

      function start(options = {}) {
        if (started) {
          return undefined;
        }

        if (app.isAnimating) {
          return undefined;
        }

        started = true;

        if (transitionData) {
          transitionData.followIncomingPlayerDuringContinuation = true;
          transitionData.continuationStartedAtMs = performance.now();
          transitionData.continuationSourcePlayer = transitionData.liveSourcePlayer
            ? { ...transitionData.liveSourcePlayer }
            : { ...transitionData.sourcePlayer };
        }

        if (typeof app.movePlayers !== "function") {
          return undefined;
        }

        app.movePlayers(dx, dy, {
          allowDuringTransition: options.allowDuringTransition === true,
          continuePunchSlide: transition.continuePunchSlide === true,
          startOnCurrentSlope: transition.continueFromCurrentSlope === true
        });
        return false;
      }

      function schedule(durationMs) {
        if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
          return;
        }

        const transitionState = app.levelTransition;
        const transitionStartMs = transitionState?.startMs ?? performance.now();
        const handoffMs = Math.max(
          durationMs * 0.08,
          Math.min(durationMs * 0.24, app.MOVE_DURATION_MS || 100)
        );

        function step(now = performance.now()) {
          if (
            started ||
            app.levelTransition?.transitionData !== transitionData ||
            !app.isTransitioningLevel
          ) {
            return;
          }

          if (app.isAnimating || now - transitionStartMs < handoffMs) {
            window.requestAnimationFrame(step);
            return;
          }

          start({ allowDuringTransition: true });
        }

        window.requestAnimationFrame(step);
      }

      return {
        isStarted: () => started,
        schedule,
        start
      };
    }

    function terrainLayersForTransitionCell(cell) {
      if (Array.isArray(cell?.layers)) {
        return cell.layers;
      }

      return cell?.type && cell.type !== "empty"
        ? [
            {
              type: cell.type,
              elevation: 0,
              raised: cell.raised === true
            }
          ]
        : [];
    }

    function directionVector(direction) {
      if (direction === "left") {
        return { dx: -1, dy: 0 };
      }

      if (direction === "up") {
        return { dx: 0, dy: -1 };
      }

      if (direction === "down") {
        return { dx: 0, dy: 1 };
      }

      return { dx: 1, dy: 0 };
    }

    function transitionTerrainSlopeEntryAt(levelState, x, y, dx, dy, elevation, options = {}) {
      const cell = terrainCellInLevelState(levelState, x, y);

      if (!cell) {
        return null;
      }

      return (
        terrainLayersForTransitionCell(cell).find((layer) => {
          if (layer?.type !== "ice_slope" && layer?.type !== "orange_ice_slope") {
            return false;
          }

          let layerElevation = layer.elevation ?? 0;

          if (layer.type === "orange_ice_slope") {
            const isRaised = options.raisedOrangeWalls
              ? options.raisedOrangeWalls.has(`${x},${y}`)
              : true;

            if (!isRaised) {
              if (!transitionShouldLowerPressedOrangeWallAsBlock(levelState, x, y, layer, options)) {
                return false;
              }

              layerElevation -= 1;
            }
          }
          const uphill = directionVector(layer.direction);
          const downhill = { dx: -uphill.dx, dy: -uphill.dy };

          return (
            (dx === uphill.dx && dy === uphill.dy && elevation === layerElevation) ||
            (dx === downhill.dx && dy === downhill.dy && elevation === layerElevation + 1)
          );
        }) || null
      );
    }

    function transitionCellHasOrangeWallLayerAtElevation(cell, elevation) {
      return terrainLayersForTransitionCell(cell).some(
        (candidate) =>
          (candidate?.type === "orange_wall" || candidate?.type === "orange_ice_slope") &&
          (candidate.elevation ?? 0) === elevation
      );
    }

    function transitionLayerHasOrangeWallBelow(levelState, x, y, layer) {
      const elevation = layer?.elevation ?? 0;

      if (elevation <= 0) {
        return false;
      }

      return transitionCellHasOrangeWallLayerAtElevation(
        terrainCellInLevelState(levelState, x, y),
        elevation - 1
      );
    }

    function transitionLayerHasNonOrangeSupportAtElevation(levelState, x, y, layer, options = {}) {
      const elevation = layer?.elevation ?? 0;

      return terrainLayersForTransitionCell(terrainCellInLevelState(levelState, x, y)).some(
        (candidate) => {
          if (
            candidate === layer ||
            candidate?.type === "orange_wall" ||
            candidate?.type === "orange_ice_slope"
          ) {
            return false;
          }

          return transitionTerrainLayerSurfaceHeight(candidate, x, y, options) === elevation;
        }
      );
    }

    function transitionShouldLowerPressedOrangeWallAsBlock(levelState, x, y, layer, options = {}) {
      const elevation = layer?.elevation ?? 0;

      return (
        elevation > 0 &&
        (transitionLayerHasOrangeWallBelow(levelState, x, y, layer) ||
          !transitionLayerHasNonOrangeSupportAtElevation(levelState, x, y, layer, options))
      );
    }

    function transitionTerrainLayerSurfaceHeight(layer, x, y, options = {}) {
      const elevation = layer?.elevation ?? 0;

      if (layer?.type === "empty" || layer?.type === "hole") {
        return null;
      }

      if (
        layer?.type === "wall" ||
        layer?.type === "ice_block" ||
        layer?.type === "ice_slope" ||
        layer?.type === "shrub" ||
        layer?.type === "block_asset"
      ) {
        return elevation + 1;
      }

      if (layer?.type === "tree") {
        return elevation + 3;
      }

      if (layer?.type === "player_gate") {
        return options.raisedPlayerGates?.has?.(`${x},${y}`) ? elevation + 1 : elevation;
      }

      if (layer?.type === "player_lift") {
        return layer.raised === true ? elevation + 1 : elevation;
      }

      if (layer?.type === "orange_wall" || layer?.type === "orange_ice_slope") {
        if (options.raisedOrangeWalls) {
          return options.raisedOrangeWalls.has(`${x},${y}`) ? elevation + 1 : elevation;
        }

        return elevation + 1;
      }

      return elevation;
    }

    function transitionTerrainLayerBlocksElevation(layer, x, y, elevation, options = {}) {
      const layerElevation = layer?.elevation ?? 0;

      if (
        layer?.type === "wall" ||
        layer?.type === "ice_block" ||
        layer?.type === "block_asset"
      ) {
        return layerElevation === elevation;
      }

      if (layer?.type === "ice_slope") {
        return elevation === layerElevation || elevation === layerElevation + 1;
      }

      if (layer?.type === "orange_ice_slope") {
        const isRaised = options.raisedOrangeWalls
          ? options.raisedOrangeWalls.has(`${x},${y}`)
          : true;

        if (isRaised) {
          return elevation === layerElevation || elevation === layerElevation + 1;
        }

        if (
          !transitionShouldLowerPressedOrangeWallAsBlock(
            options.levelState,
            x,
            y,
            layer,
            options
          )
        ) {
          return false;
        }

        return elevation === layerElevation - 1 || elevation === layerElevation;
      }

      if (layer?.type === "tree") {
        return elevation >= layerElevation && elevation < layerElevation + 3;
      }

      if (layer?.type === "shrub") {
        return elevation >= layerElevation && elevation <= layerElevation + 1;
      }

      if (layer?.type === "player_gate") {
        return options.raisedPlayerGates?.has?.(`${x},${y}`) && layerElevation === elevation;
      }

      if (layer?.type === "player_lift") {
        return layer.raised === true && layerElevation === elevation;
      }

      if (layer?.type === "orange_wall") {
        const isRaised = options.raisedOrangeWalls
          ? options.raisedOrangeWalls.has(`${x},${y}`)
          : true;

        if (isRaised) {
          return layerElevation === elevation;
        }

        return transitionShouldLowerPressedOrangeWallAsBlock(
          options.levelState,
          x,
          y,
          layer,
          options
        ) &&
          layerElevation - 1 === elevation;
      }

      return false;
    }

    function transitionTerrainBlocksElevation(levelState, x, y, elevation, options = {}) {
      const cell = terrainCellInLevelState(levelState, x, y);

      if (!cell) {
        return true;
      }

      return terrainLayersForTransitionCell(cell).some((layer) =>
        transitionTerrainLayerBlocksElevation(layer, x, y, elevation, {
          ...options,
          levelState
        })
      );
    }

    function transitionTerrainSurfaceAtElevation(levelState, x, y, elevation, options = {}) {
      const cell = terrainCellInLevelState(levelState, x, y);

      if (!cell) {
        return null;
      }

      if (transitionTerrainBlocksElevation(levelState, x, y, elevation, options)) {
        return null;
      }

      return (
        terrainLayersForTransitionCell(cell)
          .map((layer, index) => ({
            index,
            layer,
            surfaceHeight: transitionTerrainLayerSurfaceHeight(layer, x, y, options)
          }))
          .filter((entry) => entry.surfaceHeight === elevation)
          .sort(
            (left, right) =>
              (right.layer.elevation ?? 0) - (left.layer.elevation ?? 0) ||
              right.index - left.index
          )[0]
          ?.layer || null
      );
    }

    function transitionTerrainHoleAtElevation(levelState, x, y, elevation) {
      const cell = terrainCellInLevelState(levelState, x, y);

      if (!cell) {
        return null;
      }

      if (elevation === 0 && terrainLayersForTransitionCell(cell).length === 0) {
        return { type: "hole", elevation: 0 };
      }

      return (
        terrainLayersForTransitionCell(cell).find(
          (layer) => layer.type === "hole" && (layer.elevation ?? 0) === elevation
        ) || null
      );
    }

    function currentLevelTransitionState() {
      return {
        width: state.width,
        height: state.height,
        terrain: state.terrain
      };
    }

    function rememberCurrentLevelEntryState() {
      app.initialPositions = cloneActorPositions();
      app.initialTerrain = cloneTerrainState(state.terrain);
      app.levelEntrySnapshot = cloneLevelSnapshot();
    }

    function attachRaisedSurfaceState(snapshot, raisedPlayerGates, raisedOrangeWalls) {
      if (!snapshot) {
        return snapshot;
      }

      snapshot.raisedPlayerGates = Array.from(raisedPlayerGates || []);
      snapshot.raisedOrangeWalls = Array.from(raisedOrangeWalls || []);
      return snapshot;
    }

    function revivePlayerAtPosition(player, x, y, elevation) {
      player.x = x;
      player.y = y;
      player.elevation = elevation;
      player.removed = false;
      player.renderX = x;
      player.renderY = y;
      player.renderElevation = elevation;
      player.renderScale = 1;
      player.renderSink = 0;
      player.renderInHole = false;
      player.renderAlpha = 0;
    }

    function revivePlayerAtLevelStart(player, startPlayer) {
      const gateState = computeRaisedPlayerGateSet();
      const orangeWallState = computeRaisedOrangeWallSet();
      const elevation =
        playerSurfaceHeightAt(startPlayer.x, startPlayer.y, gateState, orangeWallState) === 1 ? 1 : 0;

      revivePlayerAtPosition(player, startPlayer.x, startPlayer.y, elevation);
      rememberCurrentLevelEntryState();
    }

    function blinkRevivedPlayer(playerOrPlayers, options = {}) {
      const players = Array.isArray(playerOrPlayers) ? playerOrPlayers : [playerOrPlayers];
      const durationMs = Number.isFinite(options.durationMs)
        ? Math.max(1, options.durationMs)
        : (PLAYER_REVIVE_BLINK_DURATION_MS || 620) / 2.25;
      const blinkCount = Number.isInteger(options.blinkCount)
        ? Math.max(1, options.blinkCount)
        : 2;
      const visibleDurationMs = Number.isFinite(options.visibleDurationMs)
        ? Math.max(0, options.visibleDurationMs)
        : 0;
      const startMs = performance.now();

      app.isAnimating = true;

      function finishBlink() {
        players.forEach((player) => {
          player.renderAlpha = 1;
          player.renderScale = 1;
          player.renderSink = 0;
          player.renderInHole = false;
        });
        app.isAnimating = false;
        app.animationFrameId = null;
        syncFloatingFloorTicker();
        app.render();

        if (typeof app.runQueuedAction === "function") {
          app.runQueuedAction();
        }
      }

      function step(now) {
        const progress = Math.min(1, (now - startMs) / durationMs);

        if (progress >= 1) {
          finishBlink();
          return;
        }

        const phase = Math.floor(progress * blinkCount * 2);
        players.forEach((player) => {
          player.renderAlpha = phase % 2 === 0 ? 0 : 1;
        });
        app.render();
        app.animationFrameId = window.requestAnimationFrame(step);
      }

      if (blinkCount === 1) {
        let hiddenAtMs = null;

        function stepSingleBlink(now) {
          if (hiddenAtMs === null) {
            if (now - startMs < visibleDurationMs) {
              app.animationFrameId = window.requestAnimationFrame(stepSingleBlink);
              return;
            }

            hiddenAtMs = now;
            players.forEach((player) => {
              player.renderAlpha = 0;
            });
            app.render();
            app.animationFrameId = window.requestAnimationFrame(stepSingleBlink);
            return;
          }

          if (now - hiddenAtMs >= durationMs) {
            finishBlink();
            return;
          }

          app.animationFrameId = window.requestAnimationFrame(stepSingleBlink);
        }

        app.animationFrameId = window.requestAnimationFrame(stepSingleBlink);
        return;
      }

      app.animationFrameId = window.requestAnimationFrame(step);
    }

    function playEntryHoleFallAndRespawn(player, startPlayer) {
      if (!player || !startPlayer) {
        return true;
      }

      app.animateMoves(
        [
          {
            actor: player,
            fromX: player.x,
            fromY: player.y,
            toX: player.x,
            toY: player.y,
            fromElevation: actorElevation(player),
            toElevation: 0,
            fromRemoved: false,
            toRemoved: true
          }
        ],
        0,
        {
          onFinish: () => {
            revivePlayerAtLevelStart(player, startPlayer);
            blinkRevivedPlayer(player);
          }
        }
      );

      return false;
    }

    function adjacentWorldLevelId(levelId, dx, dy) {
      return playRules.adjacentWorldLevelId(levelId, dx, dy, app.worldColumns, app.worldRows);
    }

    async function loadTransitionLevelState(levelId) {
      const cachedLevelState =
        typeof cachedHorizontalNeighborLevelState === "function"
          ? cachedHorizontalNeighborLevelState(levelId)
          : null;
      const levelState =
        cachedLevelState ||
        (typeof loadHorizontalNeighborLevelState === "function"
          ? await loadHorizontalNeighborLevelState(levelId)
          : null) ||
        await loadLevelState(levelId);

      return cloneStoredLevelSnapshot(levelState) || levelState;
    }

    async function preloadTransitionNeighborhood(outgoingLevelId, incomingLevelId) {
      if (
        typeof loadHorizontalNeighborLevelState !== "function" ||
        typeof app.threeRenderer?.prewarmAdjacentLevelTransition !== "function"
      ) {
        return;
      }

      const levelIds = new Set();
      const addNeighborhood = (levelId) => {
        if (!levelId) {
          return;
        }

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) {
              continue;
            }

            const neighborLevelId = adjacentWorldLevelId(levelId, dx, dy);

            if (neighborLevelId) {
              levelIds.add(neighborLevelId);
            }
          }
        }
      };

      addNeighborhood(outgoingLevelId);
      addNeighborhood(incomingLevelId);
      levelIds.delete(outgoingLevelId);
      levelIds.delete(incomingLevelId);

      await Promise.all(
        Array.from(levelIds, (levelId) => {
          const cachedLevelState =
            typeof cachedHorizontalNeighborLevelState === "function"
              ? cachedHorizontalNeighborLevelState(levelId)
              : null;

          if (cachedLevelState) {
            return cachedLevelState;
          }

          return loadHorizontalNeighborLevelState(levelId).catch(() => null);
        })
      );
    }

    function queueTransitionNeighborhood(outgoingLevelId, incomingLevelId) {
      if (typeof app.queueHorizontalNeighborLevelState !== "function") {
        return;
      }

      const levelIds = new Set();
      const addNeighborhood = (levelId) => {
        if (!levelId) {
          return;
        }

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) {
              continue;
            }

            const neighborLevelId = adjacentWorldLevelId(levelId, dx, dy);

            if (neighborLevelId) {
              levelIds.add(neighborLevelId);
            }
          }
        }
      };

      addNeighborhood(outgoingLevelId);
      addNeighborhood(incomingLevelId);
      levelIds.delete(outgoingLevelId);
      levelIds.delete(incomingLevelId);
      levelIds.forEach((levelId) => {
        app.queueHorizontalNeighborLevelState(levelId);
      });
    }

    function queueForwardContinuationLevel(incomingLevelId, dx, dy) {
      if (
        typeof app.queueHorizontalNeighborLevelState !== "function" ||
        !incomingLevelId ||
        (!dx && !dy)
      ) {
        return;
      }

      const forwardLevelId = adjacentWorldLevelId(incomingLevelId, dx, dy);

      if (forwardLevelId) {
        app.queueHorizontalNeighborLevelState(forwardLevelId);
      }
    }

    function transitionWarmupKey(transition) {
      if (!transition?.nextLevelId) {
        return null;
      }

      return [
        app.currentLevelId || "",
        transition.nextLevelId,
        transition.dx,
        transition.dy,
        transition.targetX,
        transition.targetY,
        transition.sourceElevation ?? "",
        transition.targetElevation ?? ""
      ].join("->");
    }

    function pruneTransitionWarmups() {
      const originLevelId = app.currentLevelId || "";

      transitionWarmups.forEach((entry, key) => {
        if (entry.originLevelId !== originLevelId) {
          transitionWarmups.delete(key);
        }
      });

      while (transitionWarmups.size >= TRANSITION_WARMUP_CACHE_LIMIT) {
        transitionWarmups.delete(transitionWarmups.keys().next().value);
      }
    }

    function warmAdjacentLevelTransition(transition, options = {}) {
      const key = transitionWarmupKey(transition);

      if (!key) {
        return null;
      }

      const cachedWarmup = transitionWarmups.get(key);

      if (cachedWarmup) {
        return cachedWarmup.warmup;
      }

      const outgoingLevelId = app.currentLevelId;
      const warmup = (async () => {
        const nextLevelState = await loadTransitionLevelState(transition.nextLevelId);

        if (options.preloadNeighborhood === "queue") {
          queueForwardContinuationLevel(
            nextLevelState?.levelId,
            Number(transition.dx) || 0,
            Number(transition.dy) || 0
          );
          queueTransitionNeighborhood(outgoingLevelId, nextLevelState?.levelId);
        } else if (
          options.preloadNeighborhood !== false &&
          typeof app.threeRenderer?.prewarmAdjacentLevelTransition === "function"
        ) {
          await preloadTransitionNeighborhood(outgoingLevelId, nextLevelState?.levelId);
        }

        return {
          key,
          nextLevelState,
          neighborhoodPreloaded:
            options.preloadNeighborhood !== false && options.preloadNeighborhood !== "queue"
        };
      })().catch((error) => {
        transitionWarmups.delete(key);
        throw error;
      });

      pruneTransitionWarmups();
      transitionWarmups.set(key, { originLevelId: outgoingLevelId || "", warmup });
      return warmup;
    }

    async function consumeTransitionWarmup(transition) {
      const key = transition?.warmupKey || transitionWarmupKey(transition);
      const warmup =
        transition?.warmupPromise ||
        (key ? transitionWarmups.get(key)?.warmup : null);

      if (!warmup) {
        return null;
      }

      try {
        const result = await warmup;

        if (key) {
          transitionWarmups.delete(key);
        }

        return result;
      } catch {
        if (key) {
          transitionWarmups.delete(key);
        }

        return null;
      }
    }

    function edgeTransitionForMove(dx, dy) {
      const players = state.actors.filter((actor) => isTransitionPlayerActor(actor) && !actor.removed);

      if (players.length !== 1) {
        return null;
      }

      const player = players[0];
      const sourceElevation = actorElevation(player);
      const sourceSurface = transitionTerrainSurfaceAtElevation(
        currentLevelTransitionState(),
        player.x,
        player.y,
        sourceElevation,
        {
          raisedPlayerGates: computeRaisedPlayerGateSet(),
          raisedOrangeWalls: computeRaisedOrangeWallSet()
        }
      );
      const sourceType = sourceSurface?.type || "";

      if (!sourceType) {
        return null;
      }

      const onEdge =
        (dx < 0 && player.x === 0) ||
        (dx > 0 && player.x === state.width - 1) ||
        (dy < 0 && player.y === 0) ||
        (dy > 0 && player.y === state.height - 1);

      if (!onEdge) {
        return null;
      }

      const nextLevelId = adjacentWorldLevelId(app.currentLevelId, dx, dy);

      if (!nextLevelId) {
        return null;
      }

      return {
        player,
        nextLevelId,
        sourceType,
        sourceElevation,
        dx,
        dy,
        targetX: dx < 0 ? state.width - 1 : dx > 0 ? 0 : player.x,
        targetY: dy < 0 ? state.height - 1 : dy > 0 ? 0 : player.y
      };
    }

    function edgeTransitionForPlayerMove(player, x, y, elevation, dx, dy) {
      if (!player || !Number.isInteger(x) || !Number.isInteger(y)) {
        return null;
      }

      const sourceElevation = Number.isInteger(elevation) ? elevation : actorElevation(player);
      const sourceSurface = transitionTerrainSurfaceAtElevation(
        currentLevelTransitionState(),
        x,
        y,
        sourceElevation,
        {
          raisedPlayerGates: computeRaisedPlayerGateSet(),
          raisedOrangeWalls: computeRaisedOrangeWallSet()
        }
      );
      const sourceType = sourceSurface?.type || "";

      if (!sourceType) {
        return null;
      }

      const onEdge =
        (dx < 0 && x === 0) ||
        (dx > 0 && x === state.width - 1) ||
        (dy < 0 && y === 0) ||
        (dy > 0 && y === state.height - 1);

      if (!onEdge) {
        return null;
      }

      const nextLevelId = adjacentWorldLevelId(app.currentLevelId, dx, dy);

      if (!nextLevelId) {
        return null;
      }

      return {
        player,
        nextLevelId,
        sourceType,
        sourceElevation,
        dx,
        dy,
        targetX: dx < 0 ? state.width - 1 : dx > 0 ? 0 : x,
        targetY: dy < 0 ? state.height - 1 : dy > 0 ? 0 : y
      };
    }

    async function resolveAdjacentLevelTransfer(transition, previousLevelSnapshot) {
      // Only await warmup consumption when a warmup can actually exist:
      // the level load below must start synchronously during move planning.
      const warmupKey = transition?.warmupKey || transitionWarmupKey(transition);
      const warmup =
        transition?.warmupPromise || (warmupKey && transitionWarmups.has(warmupKey))
          ? await consumeTransitionWarmup(transition)
          : null;
      const nextLevelState =
        cloneStoredLevelSnapshot(warmup?.nextLevelState) ||
        await loadTransitionLevelState(transition.nextLevelId);
      const levelStartPlayer = playerStartForLevelState(nextLevelState, transition.player.type);
      const sourceElevation = Number.isInteger(transition.sourceElevation)
        ? transition.sourceElevation
        : actorElevation(transition.player);
      const sourceSurface =
        transition.sourceType
          ? { type: transition.sourceType }
          : transitionTerrainSurfaceAtElevation(
              previousLevelSnapshot,
              transition.player.x,
              transition.player.y,
              sourceElevation,
              {
                raisedPlayerGates: previousLevelSnapshot.raisedPlayerGates
                  ? new Set(previousLevelSnapshot.raisedPlayerGates)
                  : null,
                raisedOrangeWalls: previousLevelSnapshot.raisedOrangeWalls
                  ? new Set(previousLevelSnapshot.raisedOrangeWalls)
                  : null
              }
            );
      const sourceType = sourceSurface?.type || "empty";
      const targetElevation = Number.isInteger(transition.targetElevation)
        ? transition.targetElevation
        : sourceElevation;
      const targetSurface = transitionTerrainSurfaceAtElevation(
        nextLevelState,
        transition.targetX,
        transition.targetY,
        targetElevation
      );
      const targetHole = transitionTerrainHoleAtElevation(
        nextLevelState,
        transition.targetX,
        transition.targetY,
        targetElevation
      );
      const targetSlopeEntry = transitionTerrainSlopeEntryAt(
        nextLevelState,
        transition.targetX,
        transition.targetY,
        transition.dx,
        transition.dy,
        targetElevation,
        {
          raisedPlayerGates: nextLevelState.raisedPlayerGates
            ? new Set(nextLevelState.raisedPlayerGates)
            : null,
          raisedOrangeWalls: nextLevelState.raisedOrangeWalls
            ? new Set(nextLevelState.raisedOrangeWalls)
            : null
        }
      );
      const targetType = targetSurface?.type || targetHole?.type || targetSlopeEntry?.type || "empty";

      if (
        !isAllowedTransitionTarget(
          transition,
          sourceType,
          targetType,
          nextLevelState,
          transition.targetX,
          transition.targetY,
          targetElevation
        )
      ) {
        return null;
      }

      const transferredPlayer = {
        type: transition.player.type,
        groupId: transition.player.groupId ?? null,
        label: transition.player.label,
        imageUrl: transition.player.imageUrl || null,
        x: transition.targetX,
        y: transition.targetY,
        removed: false,
        elevation: targetElevation
      };

      nextLevelState.actors = [
        ...(nextLevelState.actors || []).filter((actor) => !isTransitionPlayerActor(actor)),
        transferredPlayer
      ];

      return {
        entersHole: targetType === "hole",
        levelStartPlayer,
        nextLevelState,
        previousLevelSnapshot,
        sourceType,
        targetElevation,
        targetType,
        transferredPlayer,
        warmup
      };
    }

    async function prepareAdjacentLevelTransfer(transition) {
      if (!transition) {
        return null;
      }

      const previousLevelSnapshot = attachRaisedSurfaceState(
        cloneLevelSnapshot(),
        computeRaisedPlayerGateSet(),
        computeRaisedOrangeWallSet()
      );
      const transfer = await resolveAdjacentLevelTransfer(transition, previousLevelSnapshot);

      if (!transfer) {
        return null;
      }

      return {
        entersHole: transfer.entersHole,
        nextLevelState: transfer.nextLevelState,
        previousLevelSnapshot: transfer.previousLevelSnapshot,
        sourceType: transfer.sourceType,
        targetElevation: transfer.targetElevation,
        targetType: transfer.targetType,
        transferredPlayer: transfer.transferredPlayer
      };
    }

    async function transitionToAdjacentLevel(transition) {
      if (!transition) {
        return false;
      }

      const canReplaceActiveTransition =
        transition.replaceActiveTransition === true &&
        app.levelTransition?.transitionData?.kind === "adjacent-scene";

      if (app.isTransitioningLevel && !canReplaceActiveTransition) {
        return false;
      }

      app.isTransitioningLevel = true;
      const previousLevelSnapshot = attachRaisedSurfaceState(
        cloneLevelSnapshot(),
        computeRaisedPlayerGateSet(),
        computeRaisedOrangeWallSet()
      );
      const previousEntrySnapshot = cloneStoredLevelSnapshot(app.levelEntrySnapshot || previousLevelSnapshot);
      const previousEntryRenderSnapshot =
        prepareLevelRenderState?.(previousEntrySnapshot) || previousEntrySnapshot;

      if (previousEntryRenderSnapshot) {
        app.rememberHorizontalNeighborLevelState?.(previousEntryRenderSnapshot);
      }

      try {
        const transfer = await resolveAdjacentLevelTransfer(transition, previousLevelSnapshot);

        if (!transfer) {
          app.isTransitioningLevel = false;
          return false;
        }

        const { entersHole, levelStartPlayer, nextLevelState, warmup } = transfer;
        const reviveStartPlayer = levelStartPlayer ? { ...levelStartPlayer } : null;

        if (
          typeof app.threeRenderer?.prewarmAdjacentLevelTransition === "function" &&
          transition.skipNeighborhoodPreload !== true &&
          warmup?.neighborhoodPreloaded !== true
        ) {
          await preloadTransitionNeighborhood(previousLevelSnapshot.levelId, nextLevelState.levelId);
        }

        moveHistory.push({
          kind: "level-transition",
          level: previousLevelSnapshot,
          entry: previousEntrySnapshot,
          undoGroupId: transition.undoGroupId || app.activeUndoGroupId || null
        });
        applyLevelState(nextLevelState, {
          updateUrl: true,
          resetLevelEntry: true,
          immediateCamera: true,
          deferRender: true,
          preserveAnimation: transition.followSourcePlayerBeforeContinuation === true
        });
        app.touchCheckpointsAtPlayer?.({ reason: "room-arrival" });
        pruneTransitionWarmups();

        const incomingRaisedPlayerGates = computeRaisedPlayerGateSet();
        const incomingRaisedOrangeWalls = computeRaisedOrangeWallSet();
        app.liveRaisedPlayerGates = incomingRaisedPlayerGates;
        app.liveRaisedOrangeWalls = incomingRaisedOrangeWalls;
        const incomingLevelSnapshot = attachRaisedSurfaceState(
          cloneLevelSnapshot(),
          incomingRaisedPlayerGates,
          incomingRaisedOrangeWalls
        );
        const incomingPlayer = state.actors.find((actor) => isTransitionPlayerActor(actor) && !actor.removed) || null;
        const durationMs = Number.isFinite(transition.durationMs)
          ? Math.max(1, transition.durationMs)
          : app.LEVEL_TRANSITION_DURATION_MS || 1000;
        const transitionData = {
          kind: "adjacent-scene",
          dx: transition.dx,
          dy: transition.dy,
          outgoingLevel: previousLevelSnapshot,
          outgoingResetLevel: previousEntryRenderSnapshot,
          incomingLevel: incomingLevelSnapshot,
          incomingRaisedPlayerGates: incomingLevelSnapshot.raisedPlayerGates,
          incomingRaisedOrangeWalls: incomingLevelSnapshot.raisedOrangeWalls,
          sourcePlayer: { ...transition.player },
          targetPlayer: incomingPlayer ? { ...incomingPlayer } : null,
          followSourcePlayerBeforeContinuation:
            transition.followSourcePlayerBeforeContinuation === true,
          lightweightTransition: transition.lightweightTransition === true,
          steadyCamera: transition.steadyCamera === true,
          liveSourcePlayer:
            transition.followSourcePlayerBeforeContinuation === true
              ? transition.player
              : null
        };

        if (transition.skipPrewarm !== true) {
          app.threeRenderer?.prewarmAdjacentLevelTransition?.(transitionData, durationMs);
        }
        const continuationController = continuationMoveController({
          ...transition,
          entersHole
        }, transitionData);
        const holeFallAfterTransition =
          entersHole && reviveStartPlayer
            ? () => playEntryHoleFallAndRespawn(incomingPlayer, reviveStartPlayer)
            : null;
        const onComplete = () => {
          if (continuationController && !continuationController.isStarted()) {
            return continuationController.start();
          }

          return holeFallAfterTransition?.();
        };

        startLevelTransition(null, null, transition.dx, transition.dy, null, null, null, {
          durationMs,
          renderImmediately: false,
          transitionData,
          onComplete
        });
        continuationController?.schedule(durationMs);

        return true;
      } catch (error) {
        console.error(error);
        app.isTransitioningLevel = false;
        return false;
      }
    }

    Object.assign(app, {
      adjacentWorldLevelId,
      cloneStoredLevelSnapshot,
      restoreLevelEntryState,
      rememberCurrentLevelEntryState,
      edgeTransitionForMove,
      edgeTransitionForPlayerMove,
      prepareAdjacentLevelTransfer,
      warmAdjacentLevelTransition,
      transitionToAdjacentLevel,
      blinkRevivedPlayer
    });
  };
})();
