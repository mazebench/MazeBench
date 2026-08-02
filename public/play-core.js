(function () {
  const modules = window.PlayModules || (window.PlayModules = {});

  function createFallbackPlayRules() {
    const DEFAULT_WORLD_AXIS = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    const WORLD_LEVEL_PATTERN = /^level_([A-Z])x([A-Z])$/;

    function normalizeAxisValues(values, fallback = DEFAULT_WORLD_AXIS) {
      const safeFallback = Array.isArray(fallback) ? fallback : DEFAULT_WORLD_AXIS;

      if (!Array.isArray(values) || values.length === 0) {
        return safeFallback.slice();
      }

      const normalized = values
        .filter((value) => typeof value === "string" && /^[A-Z]$/.test(value))
        .slice();

      return normalized.length > 0 ? normalized : safeFallback.slice();
    }

    function parseWorldLevelId(levelId, worldColumns = DEFAULT_WORLD_AXIS, worldRows = DEFAULT_WORLD_AXIS) {
      const match = String(levelId || "").match(WORLD_LEVEL_PATTERN);

      if (!match) {
        return null;
      }

      const columns = normalizeAxisValues(worldColumns);
      const rows = normalizeAxisValues(worldRows);
      const columnIndex = columns.indexOf(match[1]);
      const rowIndex = rows.indexOf(match[2]);

      if (columnIndex === -1 || rowIndex === -1) {
        return null;
      }

      return {
        columnIndex,
        rowIndex
      };
    }

    function worldLevelId(columnIndex, rowIndex, worldColumns = DEFAULT_WORLD_AXIS, worldRows = DEFAULT_WORLD_AXIS) {
      const columns = normalizeAxisValues(worldColumns);
      const rows = normalizeAxisValues(worldRows);

      if (columns.length === 0 || rows.length === 0) {
        return null;
      }

      if (
        columnIndex < 0 ||
        rowIndex < 0 ||
        columnIndex >= columns.length ||
        rowIndex >= rows.length
      ) {
        return null;
      }

      return `level_${columns[columnIndex]}x${rows[rowIndex]}`;
    }

    function adjacentWorldLevelId(levelId, dx, dy, worldColumns = DEFAULT_WORLD_AXIS, worldRows = DEFAULT_WORLD_AXIS) {
      const coordinates = parseWorldLevelId(levelId, worldColumns, worldRows);

      if (!coordinates) {
        return null;
      }

      return worldLevelId(coordinates.columnIndex + dx, coordinates.rowIndex + dy, worldColumns, worldRows);
    }

    return {
      DEFAULT_WORLD_AXIS,
      WORLD_LEVEL_PATTERN,
      normalizeAxisValues,
      parseWorldLevelId,
      worldLevelId,
      adjacentWorldLevelId
    };
  }

  modules.PlayRules = modules.PlayRules || createFallbackPlayRules();

  modules.createPlayCore = function createPlayCore({
    playData,
    canvas,
    playShell,
    playHeader,
    playStage,
    mazeFrame,
    fuzzyToggle,
    edgeToggle,
    cameraModeToggle,
    resetProgressButton,
    enableCameraControls
  }) {
    const currentPathSegments = window.location.pathname.split("/").filter(Boolean);
    const currentGameId =
      (typeof playData?.gameId === "string" && playData.gameId) ||
      (currentPathSegments[0] === "play" ? currentPathSegments[1] : "") ||
      "maze";
    const currentLevelId =
      (typeof playData?.levelId === "string" && playData.levelId) ||
      (currentPathSegments[0] === "play" ? currentPathSegments[2] : "") ||
      "";
    const playRoutePrefix =
      typeof playData?.routePrefix === "string" && /^[a-z][a-z0-9-]*$/i.test(playData.routePrefix)
        ? playData.routePrefix
        : "play";
    const playRules = modules.PlayRules;

    if (!playRules) {
      throw new Error("PlayRules must be loaded before play-core.js");
    }

    function normalizeViewportTiles(cameraView, fallbackWidth, fallbackHeight) {
      const widthValue = Number(cameraView?.width);
      const heightValue = Number(cameraView?.height);

      return {
        width: Number.isInteger(widthValue) && widthValue > 0 ? widthValue : fallbackWidth,
        height: Number.isInteger(heightValue) && heightValue > 0 ? heightValue : fallbackHeight
      };
    }

    const defaultWorldAxis = playRules.DEFAULT_WORLD_AXIS;
    const initialViewportTiles = normalizeViewportTiles(playData?.cameraView, 10, 10);
    const app = {
      playData,
      isEditorRenderApp: playData?.editorRender === true,
      // One-off render hosts can opt out of the player's persistent gem
      // history without inheriting the editor's different gameplay visuals.
      // This is immutable across room transitions for the lifetime of the app.
      ignoreSavedGemProgress: playData?.ignoreSavedGemProgress === true,
      currentGameId,
      // Base URL for level-state fetches; keeps custom worlds (editor and
      // play) from falling back to the main game's /api/play endpoint.
      playApiBaseUrl:
        typeof playData?.playApiBaseUrl === "string" ? playData.playApiBaseUrl.replace(/\/+$/, "") : "",
      currentLevelId,
      currentLevelLabel: playData.levelLabel || currentLevelId,
      playRoutePrefix,
      worldColumns: playRules.normalizeAxisValues(playData?.worldColumns, defaultWorldAxis),
      worldRows: playRules.normalizeAxisValues(playData?.worldRows, defaultWorldAxis),
      isFlyoverMode: playData?.flyover === true,
      // Host pages (e.g. the mazebench.com home vista) can opt into the
      // flyover-style full-bleed canvas measurement without the rest of
      // flyover's camera/input semantics.
      hostFullBleedView: playData?.hostFullBleedView === true,
      // Embedded hosts can own world-map navigation when they need to keep
      // host-only route state (such as MazeJam save ids) and run a custom
      // camera flight before committing the destination room.
      hostOwnsWorldMapNavigation: playData?.hostOwnsWorldMapNavigation === true,
      disableHorizontalNeighborFetches:
        playData?.disableHorizontalNeighborFetches === true,
      autoUndoPlayerFalls: playData?.autoUndoPlayerFalls === true,
      flyoverRadius: Math.max(1, Math.min(6, Number(playData?.flyoverRadius) || 3)),
      canvas,
      enableCameraControls:
        enableCameraControls === true ||
        (enableCameraControls !== false && Boolean(canvas?.isConnected)),
      playShell,
      playHeader,
      playStage,
      mazeFrame,
      fuzzyToggle,
      edgeToggle,
      cameraModeToggle,
      resetProgressButton,
      canonicalLevelPlayerStarts: new Map(),
      TILE_SIZE: 64,
      FUZZY_AMOUNT: 0.1,
      NOISE_FPS: 8,
      MOVE_DURATION_MS: 98,
      GATE_RISE_DURATION_MS: 220,
      GATE_FALL_DURATION_MS: 180,
      ORANGE_WALL_RISE_DURATION_MS: 220,
      ORANGE_WALL_FALL_DURATION_MS: 180,
      PLAYER_LIFT_RISE_DURATION_MS: 220,
      PLAYER_LIFT_FALL_DURATION_MS: 180,
      HOLE_FALL_DURATION_MS: 300,
      PLAYER_REVIVE_BLINK_DURATION_MS: 620,
      HOLE_SINK_DISTANCE: 64 * 3,
      GEM_HOVER_BASE: 64 * 0.035,
      GEM_HOVER_BOB: 64 * 0.028,
      GEM_HOVER_PERIOD_MS: 1800,
      GEM_DRAW_WIDTH: 64 * 0.56,
      GEM_SHADOW_WIDTH: 64 * 0.3,
      GEM_SHADOW_HEIGHT: 64 * 0.1,
      COLLECTED_GEM_ALPHA: 0.22,
      FLOATING_FLOOR_HOVER_BASE: 64 * 0.18,
      FLOATING_FLOOR_HOVER_BOB: 64 * 0.045,
      FLOATING_FLOOR_SHADOW_INSET: 64 * 0.16,
      FLOATING_FLOOR_SHADOW_HEIGHT: 64 * 0.12,
      FLOATING_FLOOR_HOVER_PERIOD_MS: 2400,
      FLOATING_FLOOR_HOVER_FPS: 30,
      VIEWPORT_TILE_WIDTH:
        playData?.flyover === true ? playData.width : initialViewportTiles.width,
      VIEWPORT_TILE_HEIGHT:
        playData?.flyover === true ? playData.height : initialViewportTiles.height,
      CAMERA_FOLLOW_SMOOTHING_MS: 210,
      LEVEL_TRANSITION_DURATION_MS: 1000,
      PLAYER_LIFT_ARROW_URL: `/assets/${encodeURIComponent(currentGameId)}/images/arrow.png`,
      state: {
        width: playData.width,
        height: playData.height,
        terrain: playData.terrain,
        actors: playData.actors.map((actor) => ({ ...actor })),
        effects: {
          fuzzyEnabled: fuzzyToggle ? fuzzyToggle.getAttribute("aria-pressed") === "true" : true,
          edgeOutlinesEnabled: edgeToggle ? edgeToggle.getAttribute("aria-pressed") === "true" : true,
          noisePhase: 0
        }
      },
      imageUrls: new Set(),
      modelUrls: new Set(),
      sceneCanvas: document.createElement("canvas"),
      viewCanvas: document.createElement("canvas"),
      weightlessGroupCanvas: document.createElement("canvas"),
      imageCache: new Map(),
      modelTextCache: new Map(),
      collectedGemIds: new Set(),
      moveHistory: [],
      animationFrameId: null,
      isAnimating: false,
      isTransitioningLevel: false,
      queuedAction: null,
      renderer: null,
      noiseFrameId: null,
      floatingFloorFrameId: null,
      lastFloatingFloorTickMs: 0,
      lastNoiseTickMs: 0,
      liveRaisedPlayerGates: new Set(),
      gateRenderOverride: null,
      liveRaisedOrangeWalls: new Set(),
      orangeWallRaisedState: Array.isArray(playData.raisedOrangeWalls)
        ? new Set(playData.raisedOrangeWalls)
        : null,
      orangeWallRenderOverride: null,
      gateAnimationFrameId: null,
      gateAnimationsInitialized: false,
      gateAnimations: new Map(),
      orangeWallAnimationFrameId: null,
      orangeWallAnimationsInitialized: false,
      orangeWallAnimations: new Map(),
      playerLiftAnimationFrameId: null,
      playerLiftAnimationsInitialized: false,
      playerLiftAnimations: new Map(),
      levelTransition: null,
      levelTransitionFrameId: null,
      cameraFrameId: null,
      lastCameraTickMs: 0,
      cameraX: 0,
      cameraY: 0,
      cameraTargetX: 0,
      cameraTargetY: 0
    };

    app.NOISE_FRAME_MS = 1000 / app.NOISE_FPS;
    app.FLOATING_FLOOR_HOVER_FRAME_MS = 1000 / app.FLOATING_FLOOR_HOVER_FPS;
    app.horizontalNeighborLevelStates = new Map();
    app.horizontalNeighborLevelQueue = [];
    app.horizontalNeighborQueuedLevelIds = new Set();
    app.horizontalNeighborActiveLoads = 0;
    app.horizontalNeighborQueueFrameId = 0;
    app.horizontalNeighborLoadConcurrency = app.isFlyoverMode ? 4 : 8;
    app.deferNeighborLoadRenders = playData?.deferNeighborLoadRenders === true;
    app.worldViewConsolidate = playData?.worldViewConsolidate === true;
    app.worldViewUniformBrightness = playData?.worldViewUniformBrightness === true;
    app.worldViewVistaMode = playData?.worldViewVistaMode === true;
    app.worldViewDetachedVista = playData?.worldViewDetachedVista === true;
    app.homeVectorTheme = playData?.homeVectorTheme === true;

    function parseWorldLevelId(levelId) {
      return playRules.parseWorldLevelId(levelId, app.worldColumns, app.worldRows);
    }

    function worldLevelId(columnIndex, rowIndex) {
      return playRules.worldLevelId(columnIndex, rowIndex, app.worldColumns, app.worldRows);
    }

    function adjacentWorldLevelId(levelId, dx, dy) {
      return playRules.adjacentWorldLevelId(levelId, dx, dy, app.worldColumns, app.worldRows);
    }

    function withTemporaryLevelState(levelState, callback) {
      const previousWidth = app.state.width;
      const previousHeight = app.state.height;
      const previousTerrain = app.state.terrain;
      const previousActors = app.state.actors;
      const previousOrangeWallRaisedState = app.orangeWallRaisedState;

      app.state.width = levelState.width;
      app.state.height = levelState.height;
      app.state.terrain = levelState.terrain;
      app.state.actors = levelState.actors;
      app.orangeWallRaisedState = Array.isArray(levelState.raisedOrangeWalls)
        ? new Set(levelState.raisedOrangeWalls)
        : null;
      // The feature index caches by app.state identity, which this in-place
      // swap preserves — drop it so callbacks index the temporary terrain.
      invalidateTerrainFeatureIndex();

      try {
        return callback();
      } finally {
        app.state.width = previousWidth;
        app.state.height = previousHeight;
        app.state.terrain = previousTerrain;
        app.state.actors = previousActors;
        app.orangeWallRaisedState = previousOrangeWallRaisedState;
        invalidateTerrainFeatureIndex();
      }
    }

    function prepareLevelRenderState(levelState) {
      if (!levelState || typeof levelState.levelId !== "string" || !Array.isArray(levelState.terrain)) {
        return null;
      }

      const preparedState = {
        ...levelState,
        levelId: levelState.levelId,
        width: Number(levelState.width) || 0,
        height: Number(levelState.height) || 0,
        terrain: cloneTerrainState(levelState.terrain),
        actors: (levelState.actors || []).map((actor, index) =>
          createRuntimeActor(actor, index, levelState.levelId)
        ),
        raisedPlayerGates: Array.isArray(levelState.raisedPlayerGates)
          ? levelState.raisedPlayerGates.slice()
          : null,
        raisedOrangeWalls: Array.isArray(levelState.raisedOrangeWalls)
          ? levelState.raisedOrangeWalls.slice()
          : null
      };

      withTemporaryLevelState(preparedState, () => {
        initializeActorElevations();

        if (!Array.isArray(preparedState.raisedPlayerGates)) {
          preparedState.raisedPlayerGates = Array.from(computeRaisedPlayerGateSet(preparedState.actors));
        }

        if (!Array.isArray(preparedState.raisedOrangeWalls)) {
          preparedState.raisedOrangeWalls = Array.from(computeRaisedOrangeWallSet(preparedState.actors));
        }
      });

      return preparedState;
    }

    function rememberHorizontalNeighborLevelState(levelState) {
      rememberCanonicalLevelPlayerStart(levelState);
      const storedLevelState = prepareLevelRenderState(levelState);

      if (!storedLevelState) {
        return null;
      }

      app.horizontalNeighborLevelStates.set(levelState.levelId, storedLevelState);
      // Cheap freshness counter so render-side caches keyed on neighbor
      // availability (e.g. world-view room signatures) can invalidate
      // without re-deriving tokens per frame.
      app.horizontalNeighborStatesVersion = (app.horizontalNeighborStatesVersion || 0) + 1;
      return storedLevelState;
    }

    function cachedHorizontalNeighborLevelState(levelId) {
      const cached = app.horizontalNeighborLevelStates.get(levelId);
      return cached && typeof cached.then !== "function" ? cached : null;
    }

    function waitForIdleSlot(timeoutMs = 48) {
      return new Promise((resolve) => {
        if (typeof window.requestIdleCallback === "function") {
          window.requestIdleCallback(resolve, { timeout: timeoutMs });
          return;
        }

        window.setTimeout(resolve, 0);
      });
    }

    function levelStateUrl(levelId) {
      if (app.playApiBaseUrl) {
        return `${app.playApiBaseUrl}/${encodeURIComponent(levelId)}`;
      }
      return `/api/play/${encodeURIComponent(app.currentGameId)}/${encodeURIComponent(levelId)}`;
    }

    async function loadHorizontalNeighborLevelState(levelId, options = {}) {
      if (
        app.disableHorizontalNeighborFetches ||
        !levelId ||
        typeof window.fetch !== "function"
      ) {
        return null;
      }

      app.horizontalNeighborQueuedLevelIds.delete(levelId);
      const cached = app.horizontalNeighborLevelStates.get(levelId);

      if (cached) {
        return typeof cached.then === "function" ? cached : Promise.resolve(cached);
      }

      const request = window
        .fetch(levelStateUrl(levelId), {
          headers: {
            Accept: "application/json"
          }
        })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Unable to load ${levelId}`);
          }

          const levelState = await response.json();
          rememberCanonicalLevelPlayerStart(levelState);

          // A bulk priming (e.g. the world bundle) may have landed while this
          // request was in flight; keep the already-prepared state so room
          // signatures keyed on state identity stay stable.
          const alreadyPrepared = app.horizontalNeighborLevelStates.get(levelId);
          if (alreadyPrepared && typeof alreadyPrepared.then !== "function") {
            return alreadyPrepared;
          }

          if (options.idlePrepare === true) {
            await waitForIdleSlot();
          }

          const storedLevelState = rememberHorizontalNeighborLevelState(levelState);

          if (storedLevelState && options.preloadAssets === true) {
            await preloadImagesForLevelState(storedLevelState);
          }

          if (
            storedLevelState &&
            typeof app.onNeighborLevelStateLoaded === "function"
          ) {
            app.onNeighborLevelStateLoaded(storedLevelState);
          }

          return storedLevelState;
        })
        .catch((error) => {
          // A host can replace an in-flight remote lookup with a complete
          // browser-local world snapshot. A stale 404 must not delete that
          // newer prepared room from the render cache.
          if (app.horizontalNeighborLevelStates.get(levelId) === request) {
            app.horizontalNeighborLevelStates.delete(levelId);
          }
          throw error;
        });

      app.horizontalNeighborLevelStates.set(levelId, request);
      return request;
    }

    function scheduleHorizontalNeighborLoadQueue() {
      if (app.horizontalNeighborQueueFrameId) {
        return;
      }

      app.horizontalNeighborQueueFrameId = window.setTimeout(processHorizontalNeighborLoadQueue, 0);
    }

    let neighborArrivalRenderTimeoutId = 0;

    function scheduleNeighborArrivalRender() {
      // Neighbor states can arrive in bursts (hundreds in world view);
      // coalesce them so each batch costs one scene rebuild.
      if (neighborArrivalRenderTimeoutId) {
        return;
      }

      neighborArrivalRenderTimeoutId = window.setTimeout(() => {
        neighborArrivalRenderTimeoutId = 0;

        if (
          !app.isTransitioningLevel &&
          !app.isPlanningWorldAction &&
          !app.worldActionAnimation &&
          typeof app.render === "function"
        ) {
          app.render();
        }
      }, 200);
    }

    function processHorizontalNeighborLoadQueue() {
      app.horizontalNeighborQueueFrameId = 0;

      while (
        app.horizontalNeighborActiveLoads < app.horizontalNeighborLoadConcurrency &&
        app.horizontalNeighborLevelQueue.length > 0
      ) {
        const queued = app.horizontalNeighborLevelQueue.shift();
        const levelId = queued?.levelId;

        if (!levelId || app.horizontalNeighborLevelStates.has(levelId)) {
          app.horizontalNeighborQueuedLevelIds.delete(levelId);
          continue;
        }

        app.horizontalNeighborQueuedLevelIds.delete(levelId);
        app.horizontalNeighborActiveLoads += 1;
        loadHorizontalNeighborLevelState(levelId, {
          idlePrepare: true,
          preloadAssets: app.preloadQueuedNeighborAssets === true
        })
          .then(() => {
            if (!app.deferNeighborLoadRenders) {
              scheduleNeighborArrivalRender();
            }
          })
          .catch(() => {})
          .finally(() => {
            app.horizontalNeighborActiveLoads = Math.max(0, app.horizontalNeighborActiveLoads - 1);
            scheduleHorizontalNeighborLoadQueue();
          });
      }

      if (app.horizontalNeighborLevelQueue.length > 0) {
        scheduleHorizontalNeighborLoadQueue();
      }
    }

    function queueHorizontalNeighborLevelState(levelId, options = {}) {
      if (
        app.disableHorizontalNeighborFetches ||
        !levelId ||
        typeof window.fetch !== "function"
      ) {
        return;
      }

      if (
        app.horizontalNeighborLevelStates.has(levelId) ||
        app.horizontalNeighborQueuedLevelIds.has(levelId)
      ) {
        return;
      }

      app.horizontalNeighborQueuedLevelIds.add(levelId);
      app.horizontalNeighborLevelQueue.push({
        levelId,
        priority: Number.isFinite(Number(options.priority)) ? Number(options.priority) : 0
      });
      app.horizontalNeighborLevelQueue.sort((left, right) => left.priority - right.priority);
      scheduleHorizontalNeighborLoadQueue();
    }

    function syncHorizontalNeighborLevelStates() {
      if (
        app.disableHorizontalNeighborFetches ||
        app.worldViewVistaMode === true
      ) {
        return;
      }

      const radius = app.isFlyoverMode
        ? app.flyoverRadius
        : Math.max(1, Math.min(26, Math.floor(Number(app.playSurroundingRadius) || 1)));
      // A wide radius can still reach the same room through overlapping
      // windows during transitions. Queue each room once, at the priority of
      // its nearest copy, so fetches stream outward.
      const priorities = new Map();

      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (dx === 0 && dy === 0) {
            continue;
          }

          const levelId = adjacentWorldLevelId(app.currentLevelId, dx, dy);

          if (!levelId || levelId === app.currentLevelId) {
            continue;
          }

          const distance = Math.hypot(dx, dy);
          const existing = priorities.get(levelId);

          if (existing === undefined || distance < existing) {
            priorities.set(levelId, distance);
          }
        }
      }

      Array.from(priorities.entries())
        .sort((left, right) => left[1] - right[1])
        .forEach(([levelId, priority]) => {
          queueHorizontalNeighborLevelState(levelId, { priority });
        });
    }

    function hoverSeedForActor(actor) {
      return (((actor.x + 1) * 0.61803398875 + (actor.y + 1) * 1.41421356237) % 1) * Math.PI * 2;
    }

    function collectedGemStorageKey() {
      return `pixel-game:${app.currentGameId}:collected-gems:v1`;
    }

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

    function loadCollectedGemIds() {
      if (app.isEditorRenderApp || app.ignoreSavedGemProgress) {
        return new Set();
      }

      try {
        const raw = window.localStorage?.getItem(collectedGemStorageKey());
        const values = JSON.parse(raw || "[]");
        return new Set(
          Array.isArray(values)
            ? values
                .filter((value) => typeof value === "string")
                .map(normalizeGemCollectionId)
            : []
        );
      } catch (error) {
        return new Set();
      }
    }

    function saveCollectedGemIds() {
      if (app.isEditorRenderApp || app.ignoreSavedGemProgress) {
        return;
      }

      try {
        normalizeCollectedGemIds(app.collectedGemIds);
        window.localStorage?.setItem(
          collectedGemStorageKey(),
          JSON.stringify(Array.from(app.collectedGemIds).sort())
        );
      } catch (error) {
        // Storage can fail in private browsing or constrained embedded contexts.
      }
    }

    function gemCollectionId(actor, index = 0, levelId = app.currentLevelId) {
      if (actor?.type !== "gem" || !levelId) {
        return null;
      }

      if (typeof actor.collectionId === "string" && actor.collectionId.length > 0) {
        return normalizeGemCollectionId(actor.collectionId);
      }

      const x = Number.isInteger(actor.x) ? actor.x : 0;
      const y = Number.isInteger(actor.y) ? actor.y : 0;
      const elevation = Number.isInteger(actor.elevation) ? actor.elevation : 0;
      return `${levelId}:gem:${x},${y},${elevation}`;
    }

    function applyCollectedGemVisual(actor) {
      if (!actor || actor.type !== "gem") {
        return;
      }

      actor.collected = true;
      actor.removed = true;
      actor.showCollectedGhost = true;
      actor.renderScale = 1;
      actor.renderAlpha = app.COLLECTED_GEM_ALPHA;
      actor.renderSink = 0;
      actor.renderInHole = false;
    }

    function hideCollectedGemVisual(actor) {
      if (!actor || actor.type !== "gem") {
        return;
      }

      actor.collected = true;
      actor.removed = true;
      actor.showCollectedGhost = false;
      actor.renderScale = 0;
      actor.renderAlpha = 0;
      actor.renderSink = 0;
      actor.renderInHole = false;
    }

    function clearCollectedGemVisual(actor) {
      if (!actor || actor.type !== "gem" || actor.collected !== true) {
        return;
      }

      actor.collected = false;
      actor.removed = false;
      actor.showCollectedGhost = false;
      actor.renderScale = 1;
      actor.renderAlpha = 1;
      actor.renderSink = 0;
      actor.renderInHole = false;
    }

    function hideCollectedGemsAtPlayers() {
      const players = app.state.actors.filter(
        (actor) => !actor.removed && isPlayerActorType(actor?.type)
      );
      let changed = false;

      if (players.length === 0) {
        return false;
      }

      app.state.actors.forEach((actor) => {
        if (actor.type !== "gem" || actor.collected !== true || actor.showCollectedGhost !== true) {
          return;
        }

        const isUnderPlayer = players.some(
          (player) =>
            player.x === actor.x &&
            player.y === actor.y &&
            (player.elevation ?? 0) === (actor.elevation ?? 0)
        );

        if (isUnderPlayer) {
          hideCollectedGemVisual(actor);
          changed = true;
        }
      });

      return changed;
    }

    function applyCollectedGemProgressToActors(actors = app.state.actors, levelId = app.currentLevelId) {
      if (app.isEditorRenderApp || app.ignoreSavedGemProgress) {
        return;
      }

      actors.forEach((actor, index) => {
        const collectionId = actor.collectionId || gemCollectionId(actor, index, levelId);

        if (!collectionId) {
          return;
        }

        actor.collectionId = collectionId;
        actor.showCollectedGhost = app.collectedGemIds.has(collectionId);

        if (app.collectedGemIds.has(collectionId)) {
          applyCollectedGemVisual(actor);
        }
      });
    }

    function recordCollectedGemsFromMoves(moves) {
      if (app.isEditorRenderApp) {
        return;
      }

      let changed = false;

      (moves || []).forEach((move) => {
        const actor = move?.actor;

        if (!actor || actor.type !== "gem" || move.toRemoved !== true) {
          return;
        }

        const collectionId =
          actor.collectionId || gemCollectionId(actor, move.actorIndex, app.currentLevelId);

        if (!collectionId || app.collectedGemIds.has(collectionId)) {
          return;
        }

        actor.collectionId = collectionId;
        actor.collected = true;
        actor.showCollectedGhost = false;
        app.collectedGemIds.add(collectionId);
        changed = true;
      });

      if (changed) {
        saveCollectedGemIds();
        syncResetProgressButton();
      }
    }

    function syncResetProgressButton() {
      if (!app.resetProgressButton) {
        return;
      }

      const hasProgress = app.collectedGemIds.size > 0;
      app.resetProgressButton.disabled = false;
      app.resetProgressButton.dataset.hasProgress = hasProgress ? "true" : "false";
      app.resetProgressButton.setAttribute("aria-disabled", "false");
      app.resetProgressButton.setAttribute("aria-label", "Reset collected gem progress");
    }

    function clearCollectedGemSavedState() {
      (app.initialPositions || []).forEach((position, index) => {
        const actor = app.state.actors[index];

        if (!position || actor?.type !== "gem") {
          return;
        }

        position.collectionId =
          position.collectionId || actor.collectionId || gemCollectionId(actor, index, app.currentLevelId);
        position.collected = false;
        position.removed = false;
        position.showCollectedGhost = false;
      });

      (app.levelEntrySnapshot?.actors || []).forEach((actor, index) => {
        if (!actor || actor.type !== "gem") {
          return;
        }

        actor.collectionId =
          actor.collectionId ||
          gemCollectionId(actor, index, app.levelEntrySnapshot?.levelId || app.currentLevelId);
        actor.collected = false;
        actor.removed = false;
        actor.showCollectedGhost = false;
      });
    }

    function resetCollectionProgress() {
      app.collectedGemIds.clear();
      saveCollectedGemIds();
      app.state.actors.forEach((actor) => clearCollectedGemVisual(actor));
      clearCollectedGemSavedState();
      app.horizontalNeighborLevelStates.clear();
      syncHorizontalNeighborLevelStates();
      syncResetProgressButton();
      syncFloatingFloorTicker();
      app.render();
    }

    app.collectedGemIds = loadCollectedGemIds();

    function createRuntimeActor(actor, index = 0, levelId = app.currentLevelId) {
      const collectionId = gemCollectionId(actor, index, levelId);
      const usesSavedGemProgress = !app.isEditorRenderApp && !app.ignoreSavedGemProgress;
      const collected = usesSavedGemProgress && collectionId
        ? app.collectedGemIds.has(collectionId)
        : false;
      const removed = Boolean(actor?.removed) || collected;
      const elevation = actor?.elevation ?? 0;
      const runtimeActor = {
        ...actor,
        collectionId: collectionId || actor?.collectionId || null,
        collected: usesSavedGemProgress ? actor?.collected === true || collected : false,
        showCollectedGhost:
          usesSavedGemProgress ? actor?.showCollectedGhost === true || collected : false,
        hoverSeed: actor?.hoverSeed ?? hoverSeedForActor(actor),
        renderX: actor?.renderX ?? actor.x,
        renderY: actor?.renderY ?? actor.y,
        elevation,
        renderElevation: actor?.renderElevation ?? elevation,
        renderScale: actor?.renderScale ?? (removed ? 0 : 1),
        renderAlpha: actor?.renderAlpha ?? (removed ? 0 : 1),
        renderSink: actor?.renderSink ?? (removed ? app.HOLE_SINK_DISTANCE : 0),
        renderInHole: Boolean(actor?.renderInHole),
        removed
      };

      if (collected) {
        applyCollectedGemVisual(runtimeActor);
      }

      Object.defineProperty(runtimeActor, "__explicitElevation", {
        value: Object.prototype.hasOwnProperty.call(actor ?? {}, "elevation")
      });

      return runtimeActor;
    }

    function rememberCanonicalLevelPlayerStart(levelState) {
      const levelId = String(levelState?.levelId || "");
      if (!levelId || app.canonicalLevelPlayerStarts.has(levelId)) return;
      const player = (levelState?.actors || []).find((actor) => isMainPlayerActor(actor) && !actor.removed);
      if (!player) return;
      app.canonicalLevelPlayerStarts.set(levelId, Object.freeze({
        elevation: Number(player.elevation || 0),
        levelId,
        x: Number(player.x),
        y: Number(player.y)
      }));
    }

    function canonicalLevelPlayerStart(levelId = app.currentLevelId) {
      const start = app.canonicalLevelPlayerStarts.get(String(levelId || ""));
      return start ? { ...start } : null;
    }

    function registerImageUrl(url) {
      if (typeof url === "string" && url.length > 0) {
        app.imageUrls.add(url);
      }
    }

    function registerModelUrl(url) {
      if (typeof url === "string" && url.length > 0) {
        app.modelUrls.add(url);
      }
    }

    function registerTerrainAssetUrlsForCell(cell) {
      if (!cell) {
        return;
      }

      registerImageUrl(cell?.imageUrl || null);
      registerModelUrl(cell?.modelUrl || null);
      registerTerrainAssetUrlsForCell(cell?.underlay || null);

      if (Array.isArray(cell?.layers)) {
        cell.layers.forEach((layer) => {
          registerImageUrl(layer?.imageUrl || null);
          registerModelUrl(layer?.modelUrl || null);
        });
      }
    }

    function registerTerrainImageUrls(terrain) {
      terrain.forEach((row) => {
        row.forEach((cell) => {
          registerTerrainAssetUrlsForCell(cell);
        });
      });
    }

    function registerActorImageUrls(actors) {
      actors.forEach((actor) => {
        registerImageUrl(actor?.imageUrl || null);
        registerModelUrl(actor?.modelUrl || null);
      });
    }

    app.state.actors = app.state.actors.map((actor, index) =>
      createRuntimeActor(actor, index, app.currentLevelId)
    );
    registerTerrainImageUrls(app.state.terrain);
    registerActorImageUrls(app.state.actors);
    registerImageUrl(app.PLAYER_LIFT_ARROW_URL);

    function updateBoardMetrics(width = app.state.width, height = app.state.height) {
      app.boardRect = {
        width: width * app.TILE_SIZE,
        height: height * app.TILE_SIZE
      };
      app.viewportRect = {
        width: Math.min(width, app.VIEWPORT_TILE_WIDTH) * app.TILE_SIZE,
        height: Math.min(height, app.VIEWPORT_TILE_HEIGHT) * app.TILE_SIZE
      };
    }

    updateBoardMetrics();
    app.sceneCtx = app.sceneCanvas.getContext("2d");
    app.viewCtx = app.viewCanvas.getContext("2d");
    app.weightlessGroupCtx = app.weightlessGroupCanvas.getContext("2d");
    app.gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: Boolean(window.__PIXEL_GAME_REPLAY_CAPTURE__)
    });
    app.fallbackCtx = app.gl ? null : canvas.getContext("2d");

    if (!app.sceneCtx || !app.viewCtx || (!app.gl && !app.fallbackCtx)) {
      return null;
    }

    app.FRAGMENT_PRECISION =
      app.gl &&
      typeof app.gl.getShaderPrecisionFormat === "function" &&
      app.gl.getShaderPrecisionFormat(app.gl.FRAGMENT_SHADER, app.gl.HIGH_FLOAT)?.precision > 0
        ? "highp"
        : "mediump";
    app.NOISE_PHASE_CYCLE = 10;
    app.VERTEX_SHADER_SOURCE = `
      attribute vec2 a_position;
      varying vec2 v_uv;

      void main() {
        v_uv = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;
    app.FRAGMENT_SHADER_SOURCE = `
      precision ${app.FRAGMENT_PRECISION} float;

      varying vec2 v_uv;

      uniform sampler2D u_texture;
      uniform vec2 u_logicalResolution;
      uniform float u_bleed;
      uniform float u_bloom;
      uniform float u_softness;
      uniform float u_scanlines;
      uniform float u_mask;
      uniform float u_ghosting;
      uniform float u_noise;
      uniform float u_vignetteStrength;
      uniform float u_noisePhase;

      float hashNoise(vec2 point) {
        return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453);
      }

      vec3 sampleSource(vec2 uv) {
        return texture2D(u_texture, clamp(uv, 0.0, 1.0)).rgb;
      }

      vec3 blurCross(vec2 uv, float radius) {
        vec2 uvPerPixel = 1.0 / u_logicalResolution;
        vec2 offset = uvPerPixel * radius;
        vec3 color = sampleSource(uv) * 0.28;
        color += sampleSource(uv + vec2(offset.x, 0.0)) * 0.18;
        color += sampleSource(uv - vec2(offset.x, 0.0)) * 0.18;
        color += sampleSource(uv + vec2(0.0, offset.y)) * 0.18;
        color += sampleSource(uv - vec2(0.0, offset.y)) * 0.18;
        color += sampleSource(uv + offset) * 0.045;
        color += sampleSource(uv - offset) * 0.045;
        color += sampleSource(uv + vec2(offset.x, -offset.y)) * 0.035;
        color += sampleSource(uv + vec2(-offset.x, offset.y)) * 0.035;
        return color;
      }

      vec3 buildMask(vec2 logicalCoord) {
        if (u_mask <= 0.0) {
          return vec3(1.0);
        }

        float stride = 1.0;
        float rowBand = 1.0;
        float column = floor(logicalCoord.x / stride);
        float row = floor(logicalCoord.y / rowBand);
        float phase = mod(column + mod(row, 2.0), 3.0);
        float monoMask = phase < 0.5 ? 1.08 : (phase < 1.5 ? 0.98 : 0.88);
        return vec3(mix(1.0, monoMask, u_mask));
      }

      void main() {
        vec2 logicalCoord = v_uv * u_logicalResolution;
        vec3 base = sampleSource(v_uv);
        vec3 soft = blurCross(v_uv, mix(0.55, 2.4, u_softness));
        vec3 bloom = blurCross(v_uv, 0.8 + u_bloom * 3.0);
        vec3 bleed = blurCross(v_uv, 0.45 + u_bleed * 1.85);
        vec2 uvPerPixel = 1.0 / u_logicalResolution;
        vec2 ghostOffset = uvPerPixel * vec2(0.25 + u_ghosting * 4.2, 0.16);
        float bleedShift = 0.4 + u_bleed * 2.6;
        vec3 bleedLeft = sampleSource(v_uv - vec2(uvPerPixel.x * bleedShift, 0.0));
        vec3 bleedRight = sampleSource(v_uv + vec2(uvPerPixel.x * bleedShift, 0.0));
        vec3 bleedShifted = (bleedLeft + bleed + bleedRight) / 3.0;
        vec3 ghost = sampleSource(v_uv + ghostOffset);
        float blurStrength = 0.5;
        float softMix = u_softness * 0.9 * blurStrength;
        vec3 color = mix(base, soft, softMix);
        color = mix(color, bleedShifted, u_bleed * 0.82 * blurStrength);

        color += max(vec3(0.0), bloom - base) * (u_bloom * 0.45 * blurStrength);
        color = mix(color, ghost, u_ghosting * 0.22 * blurStrength);

        float scanPhase = fract(logicalCoord.y);
        float beamProfile = 0.35 + 0.65 * (0.5 - 0.5 * cos(scanPhase * 6.28318530718));
        float beam = mix(1.0, beamProfile, u_scanlines);
        color *= beam;
        color *= buildMask(logicalCoord);

        float edgeDistance = length(v_uv * 2.0 - 1.0) / 1.41421356237;
        float vignette = mix(1.0, 1.0 - pow(edgeDistance, 2.2) * 0.32, u_vignetteStrength);
        color *= vignette;

        float phase = mod(floor(u_noisePhase + 0.5), 10.0);
        vec2 phaseOffset = vec2(phase * 7.0, phase * 13.0);
        float grain = (hashNoise(floor(logicalCoord) + phaseOffset) - 0.5) * u_noise;
        color += grain;

        gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
      }
    `;

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function usesScrollingViewport() {
      return (
        app.viewportRect.width !== app.boardRect.width || app.viewportRect.height !== app.boardRect.height
      );
    }

    function clampCameraAxis(target, boardSpan, viewSpan) {
      if (boardSpan <= viewSpan) {
        return -(viewSpan - boardSpan) / 2;
      }

      return clamp(target, 0, boardSpan - viewSpan);
    }

    function cameraFocusPoint() {
      const players = app.state.actors.filter((actor) => isPlayerActor(actor) && !actor.removed);

      if (players.length === 0) {
        return {
          x: app.cameraTargetX + app.viewportRect.width / 2,
          y: app.cameraTargetY + app.viewportRect.height / 2
        };
      }

      const focus = players.reduce(
        (sum, actor) => {
          sum.x += (actor.renderX + 0.5) * app.TILE_SIZE;
          sum.y += (actor.renderY + 0.5) * app.TILE_SIZE;
          return sum;
        },
        { x: 0, y: 0 }
      );

      return {
        x: focus.x / players.length,
        y: focus.y / players.length
      };
    }

    function syncCameraTarget(immediate = false) {
      if (!usesScrollingViewport()) {
        app.cameraX = 0;
        app.cameraY = 0;
        app.cameraTargetX = 0;
        app.cameraTargetY = 0;
        app.lastCameraTickMs = 0;
        return false;
      }

      const focus = cameraFocusPoint();
      app.cameraTargetX = clampCameraAxis(
        focus.x - app.viewportRect.width / 2,
        app.boardRect.width,
        app.viewportRect.width
      );
      app.cameraTargetY = clampCameraAxis(
        focus.y - app.viewportRect.height / 2,
        app.boardRect.height,
        app.viewportRect.height
      );

      if (immediate || app.lastCameraTickMs === 0) {
        app.cameraX = app.cameraTargetX;
        app.cameraY = app.cameraTargetY;
        app.lastCameraTickMs = performance.now();
        return false;
      }

      return true;
    }

    function isCameraInMotion() {
      return (
        Math.abs(app.cameraTargetX - app.cameraX) > 0.35 ||
        Math.abs(app.cameraTargetY - app.cameraY) > 0.35
      );
    }

    function advanceCamera(now = performance.now()) {
      if (!usesScrollingViewport()) {
        return false;
      }

      if (app.lastCameraTickMs === 0) {
        app.lastCameraTickMs = now;
      }

      const elapsed = Math.max(0, now - app.lastCameraTickMs);
      app.lastCameraTickMs = now;
      const smoothing = 1 - Math.exp(-elapsed / app.CAMERA_FOLLOW_SMOOTHING_MS);

      app.cameraX += (app.cameraTargetX - app.cameraX) * smoothing;
      app.cameraY += (app.cameraTargetY - app.cameraY) * smoothing;

      if (!isCameraInMotion()) {
        app.cameraX = app.cameraTargetX;
        app.cameraY = app.cameraTargetY;
        return false;
      }

      return true;
    }

    let renderedFrameTimestamp = -1;
    const renderedFrameChannels = new Set();

    function renderOncePerFrame(now = performance.now(), channel = "scene") {
      // Movement and camera controls have independent animation clocks. They
      // may both update during one display frame, so dedupe within each
      // channel rather than allowing the first callback to suppress the
      // other channel's freshly-updated state.
      if (now !== renderedFrameTimestamp) {
        renderedFrameTimestamp = now;
        renderedFrameChannels.clear();
      }

      if (renderedFrameChannels.has(channel)) {
        return;
      }

      renderedFrameChannels.add(channel);
      app.render(now);
    }

    function startCameraFollowLoop() {
      if (!usesScrollingViewport() || app.isAnimating || app.cameraFrameId !== null) {
        return;
      }

      function step(now) {
        app.cameraFrameId = null;
        renderOncePerFrame(now);
      }

      app.cameraFrameId = window.requestAnimationFrame(step);
    }

    function createShader(glContext, type, source) {
      const shader = glContext.createShader(type);

      if (!shader) {
        return null;
      }

      glContext.shaderSource(shader, source);
      glContext.compileShader(shader);

      if (!glContext.getShaderParameter(shader, glContext.COMPILE_STATUS)) {
        console.error(glContext.getShaderInfoLog(shader));
        glContext.deleteShader(shader);
        return null;
      }

      return shader;
    }

    function createProgram(glContext, vertexSource, fragmentSource) {
      const vertexShader = createShader(glContext, glContext.VERTEX_SHADER, vertexSource);
      const fragmentShader = createShader(glContext, glContext.FRAGMENT_SHADER, fragmentSource);

      if (!vertexShader || !fragmentShader) {
        return null;
      }

      const program = glContext.createProgram();

      if (!program) {
        glContext.deleteShader(vertexShader);
        glContext.deleteShader(fragmentShader);
        return null;
      }

      glContext.attachShader(program, vertexShader);
      glContext.attachShader(program, fragmentShader);
      glContext.linkProgram(program);
      glContext.deleteShader(vertexShader);
      glContext.deleteShader(fragmentShader);

      if (!glContext.getProgramParameter(program, glContext.LINK_STATUS)) {
        console.error(glContext.getProgramInfoLog(program));
        glContext.deleteProgram(program);
        return null;
      }

      return program;
    }

    function initializeRenderer(glContext) {
      const program = createProgram(glContext, app.VERTEX_SHADER_SOURCE, app.FRAGMENT_SHADER_SOURCE);

      if (!program) {
        return null;
      }

      const positionBuffer = glContext.createBuffer();
      const texture = glContext.createTexture();

      if (!positionBuffer || !texture) {
        return null;
      }

      glContext.bindBuffer(glContext.ARRAY_BUFFER, positionBuffer);
      glContext.bufferData(
        glContext.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        glContext.STATIC_DRAW
      );

      glContext.bindTexture(glContext.TEXTURE_2D, texture);
      glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_WRAP_S, glContext.CLAMP_TO_EDGE);
      glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_WRAP_T, glContext.CLAMP_TO_EDGE);

      return {
        program,
        positionBuffer,
        texture,
        attribs: {
          position: glContext.getAttribLocation(program, "a_position")
        },
        uniforms: {
          texture: glContext.getUniformLocation(program, "u_texture"),
          logicalResolution: glContext.getUniformLocation(program, "u_logicalResolution"),
          bleed: glContext.getUniformLocation(program, "u_bleed"),
          bloom: glContext.getUniformLocation(program, "u_bloom"),
          softness: glContext.getUniformLocation(program, "u_softness"),
          scanlines: glContext.getUniformLocation(program, "u_scanlines"),
          mask: glContext.getUniformLocation(program, "u_mask"),
          ghosting: glContext.getUniformLocation(program, "u_ghosting"),
          noise: glContext.getUniformLocation(program, "u_noise"),
          vignetteStrength: glContext.getUniformLocation(program, "u_vignetteStrength"),
          noisePhase: glContext.getUniformLocation(program, "u_noisePhase")
        }
      };
    }

    function posKey(x, y) {
      return `${x},${y}`;
    }

    function cloneActorPositions() {
      return app.state.actors.map((actor) => ({
        x: actor.x,
        y: actor.y,
        removed: actor.removed,
        elevation: actor.elevation ?? 0,
        raised: actor.raised === true,
        collectionId: actor.collectionId || null,
        collected: actor.collected === true,
        showCollectedGhost: actor.showCollectedGhost === true
      }));
    }

    function cloneActorState(actor) {
      return {
        type: actor.type,
        groupId: actor.groupId ?? null,
        label: actor.label,
        imageUrl: actor.imageUrl || null,
        modelUrl: actor.modelUrl || null,
        direction: actor.direction || null,
        shape: actor.shape || null,
        styleKey: actor.styleKey || null,
        raised: actor.raised === true,
        facing: actor.facing || null,
        collectionId: actor.collectionId || null,
        collected: actor.collected === true,
        showCollectedGhost: actor.showCollectedGhost === true,
        x: actor.x,
        y: actor.y,
        removed: Boolean(actor.removed),
        elevation: actor.elevation ?? 0
      };
    }

    function cloneActorStateList(actors = app.state.actors) {
      return actors.map((actor) => cloneActorState(actor));
    }

    function cloneTerrainCell(cell) {
      return {
        ...cell,
        layers: Array.isArray(cell?.layers) ? cell.layers.map((layer) => ({ ...layer })) : null,
        underlay: cell?.underlay ? cloneTerrainCell(cell.underlay) : null
      };
    }

    function cloneTerrainState(terrain) {
      return terrain.map((row) => row.map((cell) => cloneTerrainCell(cell)));
    }

    function preloadImageUrl(url) {
      if (typeof url !== "string" || url.length === 0) {
        return Promise.resolve();
      }

      registerImageUrl(url);

      if (app.imageCache.has(url)) {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        const image = new Image();
        image.onload = function () {
          app.imageCache.set(url, image);
          resolve();
        };
        image.onerror = function () {
          app.imageCache.set(url, null);
          resolve();
        };
        image.src = url;
      });
    }

    function preloadModelUrl(url) {
      if (typeof url !== "string" || url.length === 0) {
        return Promise.resolve();
      }

      registerModelUrl(url);

      if (app.modelTextCache.has(url)) {
        return Promise.resolve();
      }

      const isBinaryModel = /\.glb(?:[?#]|$)/i.test(url);

      return fetch(url)
        .then((response) => {
          if (!response.ok) {
            return null;
          }

          return isBinaryModel ? response.arrayBuffer() : response.text();
        })
        .then((data) => {
          app.modelTextCache.set(url, data);
          app.threeRenderer?.invalidateSceneCache?.();
        })
        .catch(() => {
          app.modelTextCache.set(url, null);
          app.threeRenderer?.invalidateSceneCache?.();
        });
    }

    function collectTerrainAssetUrls(cell, urls, modelUrls) {
      if (!cell) {
        return;
      }

      if (cell.imageUrl) {
        urls.add(cell.imageUrl);
      }
      if (cell.modelUrl) {
        modelUrls.add(cell.modelUrl);
      }

      collectTerrainAssetUrls(cell.underlay, urls, modelUrls);

      if (Array.isArray(cell.layers)) {
        cell.layers.forEach((layer) => {
          if (layer?.imageUrl) {
            urls.add(layer.imageUrl);
          }
          if (layer?.modelUrl) {
            modelUrls.add(layer.modelUrl);
          }
        });
      }
    }

    function preloadImagesForLevelState(levelState) {
      const urls = new Set([app.PLAYER_LIFT_ARROW_URL]);
      const modelUrls = new Set();
      registerImageUrl(app.PLAYER_LIFT_ARROW_URL);

      (levelState?.terrain || []).forEach((row) => {
        row.forEach((cell) => {
          collectTerrainAssetUrls(cell, urls, modelUrls);
        });
      });

      (levelState?.actors || []).forEach((actor) => {
        if (actor?.imageUrl) {
          urls.add(actor.imageUrl);
        }
        if (actor?.modelUrl) {
          modelUrls.add(actor.modelUrl);
        }
      });

      return Promise.all([
        ...Array.from(urls).map((url) => preloadImageUrl(url)),
        ...Array.from(modelUrls).map((url) => preloadModelUrl(url))
      ]);
    }

    function restoreTerrainState(terrain) {
      app.state.terrain = cloneTerrainState(terrain);
      invalidateTerrainFeatureIndex();
      app.terrainRenderVersion = (Number(app.terrainRenderVersion) || 0) + 1;
    }

    function syncDocumentLevelState() {
      const levelMeta = app.playHeader?.querySelector(".play-header-meta p");

      if (levelMeta && app.currentLevelLabel) {
        levelMeta.textContent = app.currentLevelLabel;
      }

      const authorLink =
        app.playHeader?.querySelector("[data-play-author-link]") ||
        Array.from(app.playHeader?.querySelectorAll("a") || []).find(
          (link) => link.textContent?.trim() === "Author"
        );

      if (authorLink && app.currentGameId && app.currentLevelId) {
        authorLink.href = `/author/${encodeURIComponent(app.currentGameId)}/${encodeURIComponent(app.currentLevelId)}`;
      }

      const gameTitle = app.playHeader?.querySelector("h1")?.textContent?.trim();

      if (gameTitle && app.currentLevelLabel) {
        document.title = `${gameTitle} ${app.currentLevelLabel}`;
      }
    }

    function cloneLevelSnapshot() {
      return {
        gameId: app.currentGameId,
        levelId: app.currentLevelId,
        levelLabel: app.currentLevelLabel,
        width: app.state.width,
        height: app.state.height,
        terrain: cloneTerrainState(app.state.terrain),
        actors: cloneActorStateList(),
        raisedOrangeWalls: Array.from(computeRaisedOrangeWallSet())
      };
    }

    function applyLevelState(levelState, options = {}) {
      if (!levelState) {
        return;
      }

      const {
        updateUrl = false,
        resetHistory = false,
        resetLevelEntry = false,
        immediateCamera = true,
        deferRender = false,
        preserveAnimation = false,
        skipTransientSideEffects = false
      } = options;

      if (app.animationFrameId !== null && !preserveAnimation) {
        window.cancelAnimationFrame(app.animationFrameId);
        app.animationFrameId = null;
      }

      if (app.gateAnimationFrameId !== null) {
        window.cancelAnimationFrame(app.gateAnimationFrameId);
        app.gateAnimationFrameId = null;
      }

      if (app.orangeWallAnimationFrameId !== null) {
        window.cancelAnimationFrame(app.orangeWallAnimationFrameId);
        app.orangeWallAnimationFrameId = null;
      }

      if (app.playerLiftAnimationFrameId !== null) {
        window.cancelAnimationFrame(app.playerLiftAnimationFrameId);
        app.playerLiftAnimationFrameId = null;
      }

      if (app.levelTransitionFrameId !== null) {
        window.cancelAnimationFrame(app.levelTransitionFrameId);
        app.levelTransitionFrameId = null;
      }

      if (!preserveAnimation) {
        app.isAnimating = false;
      }
      app.isTransitioningLevel = false;
      app.levelTransition = null;
      app.gateRenderOverride = null;
      app.orangeWallRenderOverride = null;
      app.currentLevelId = levelState.levelId || app.currentLevelId;
      app.currentLevelLabel = levelState.levelLabel || app.currentLevelLabel || app.currentLevelId;
      if (Object.prototype.hasOwnProperty.call(levelState, "editorRender")) {
        app.isEditorRenderApp = levelState.editorRender === true;
      }
      app.worldColumns = playRules.normalizeAxisValues(levelState.worldColumns, app.worldColumns);
      app.worldRows = playRules.normalizeAxisValues(levelState.worldRows, app.worldRows);
      const viewportTiles = normalizeViewportTiles(
        levelState.cameraView,
        app.VIEWPORT_TILE_WIDTH,
        app.VIEWPORT_TILE_HEIGHT
      );
      app.VIEWPORT_TILE_WIDTH = viewportTiles.width;
      app.VIEWPORT_TILE_HEIGHT = viewportTiles.height;
      app.state.width = levelState.width;
      app.state.height = levelState.height;
      app.state.terrain = cloneTerrainState(levelState.terrain || []);
      app.state.actors = (levelState.actors || []).map((actor, index) =>
        createRuntimeActor(actor, index, levelState.levelId || app.currentLevelId)
      );
      app.orangeWallRaisedState = Array.isArray(levelState.raisedOrangeWalls)
        ? new Set(levelState.raisedOrangeWalls)
        : null;
      // The editor reuses one runtime app while painting. Terrain can change
      // without actor coordinates changing, so invalidate the live surface
      // cache or newly painted gates/walls inherit the previous board state.
      liveSurfaceActorCodes = null;
      liveSurfaceActorState = null;
      invalidateTerrainFeatureIndex();
      app.gateAnimations.clear();
      app.gateAnimationsInitialized = false;
      app.orangeWallAnimations.clear();
      app.orangeWallAnimationsInitialized = false;
      app.playerLiftAnimations.clear();
      app.playerLiftAnimationsInitialized = false;
      initializeActorElevations();
      setRaisedOrangeWallState(computeRaisedOrangeWallSet());

      if (!skipTransientSideEffects) {
        registerTerrainImageUrls(app.state.terrain);
        registerActorImageUrls(app.state.actors);
        updateBoardMetrics(app.state.width, app.state.height);
        setupCanvas();
        syncDocumentLevelState();
        rememberHorizontalNeighborLevelState(levelState);
        syncHorizontalNeighborLevelStates();
        syncCameraTarget(immediateCamera);
        syncFloatingFloorTicker();
      }

      if (resetHistory) {
        app.moveHistory.length = 0;
      }

      if (resetLevelEntry) {
        app.initialPositions = cloneActorPositions();
        app.initialTerrain = cloneTerrainState(app.state.terrain);
        app.levelEntrySnapshot = cloneLevelSnapshot();
      }

      if (updateUrl && app.currentLevelId) {
        const routePrefix = app.playRoutePrefix || "play";
        const nextPath = `/${encodeURIComponent(routePrefix)}/${encodeURIComponent(app.currentGameId)}/${encodeURIComponent(app.currentLevelId)}`;
        // Hosts attach the active run identity in the query string (for
        // example ?save=... or ?world=...). A room transition changes only
        // the level path; dropping that identity detaches the live game from
        // its save before the host can checkpoint the transition.
        const nextUrl = `${nextPath}${window.location.search || ""}${window.location.hash || ""}`;
        window.history.replaceState(
          { ...(window.history.state || {}), levelId: app.currentLevelId },
          "",
          nextUrl
        );
      }

      if (!deferRender) {
        app.render();
      }

      if (typeof window.dispatchEvent === "function" && typeof window.CustomEvent === "function") {
        window.dispatchEvent(new window.CustomEvent("mazebench:level-state-applied", {
          detail: { levelId: app.currentLevelId, levelState }
        }));
      }
    }

    async function loadLevelState(levelId) {
      const response = await window.fetch(levelStateUrl(levelId), {
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(`Unable to load ${levelId}`);
      }

      const levelState = await response.json();
      rememberCanonicalLevelPlayerStart(levelState);
      rememberHorizontalNeighborLevelState(levelState);
      await preloadImagesForLevelState(levelState);
      return levelState;
    }

    function restoreActorPositions(positions) {
      app.state.actors.forEach((actor, index) => {
        const target = positions[index];

        if (!target) {
          return;
        }

        actor.x = target.x;
        actor.y = target.y;
        actor.removed = Boolean(target.removed);
        actor.elevation = target.elevation ?? 0;
        actor.renderX = target.x;
        actor.renderY = target.y;
        actor.renderElevation = actor.elevation;
        actor.collectionId = target.collectionId || actor.collectionId || null;
        actor.collected = !app.isEditorRenderApp && (
          target.collected === true ||
          (actor.collectionId ? app.collectedGemIds.has(actor.collectionId) : false)
        );

        if (actor.collected && actor.type === "gem") {
          if (target.showCollectedGhost === true) {
            applyCollectedGemVisual(actor);
          } else {
            hideCollectedGemVisual(actor);
          }
          return;
        }

        actor.renderScale = actor.removed ? 0 : 1;
        actor.renderAlpha = actor.removed ? 0 : 1;
        actor.renderSink = actor.removed ? app.HOLE_SINK_DISTANCE : 0;
        actor.renderInHole = false;
      });
    }

    function buildOccupiedSet(excludedActor = null) {
      const occupied = new Set(
        app.state.actors
          .filter((actor) => !actor.removed && !isNonBlockingActor(actor))
          .map((actor) => posKey(actor.x, actor.y))
      );

      if (excludedActor && !excludedActor.removed) {
        occupied.delete(posKey(excludedActor.x, excludedActor.y));
      }

      return occupied;
    }

    function actorsAt(x, y, predicate = null) {
      return app.state.actors.filter((actor) => {
        if (actor.removed) {
          return false;
        }

        if (actor.x !== x || actor.y !== y) {
          return false;
        }

        return typeof predicate === "function" ? predicate(actor) : true;
      });
    }

    function actorAt(x, y, predicate = null) {
      return actorsAt(x, y, predicate)[0] || null;
    }

    function pushEntityKey(actor) {
      return actor.type === "weightless_box" ? `weightless:${actor.groupId}` : actor;
    }

    function isMainPlayerActorType(type) {
      return type === "player" || type === "circle_player";
    }

    function isPlayerActorType(type) {
      return isMainPlayerActorType(type) || type === "clone";
    }

    function isMainPlayerActor(actor) {
      return isMainPlayerActorType(actor?.type);
    }

    function isPlayerActor(actor) {
      return isPlayerActorType(actor?.type);
    }

    function actorElevation(actor) {
      return actor?.elevation ?? 0;
    }

    function actorRenderElevation(actor) {
      return actor?.renderElevation ?? actor?.elevation ?? 0;
    }

    function isCollectibleActor(actor) {
      return actor?.type === "gem";
    }

    function isNonBlockingActor(actor) {
      return isCollectibleActor(actor) || actor?.type === "orange_button" || actor?.type === "puncher";
    }

    function pushWeight(actor) {
      return actor.type === "box" || actor.type === "floating_floor" ? 1 : 0;
    }

    function isPushableActor(actor) {
      return actor?.type === "box" || actor?.type === "floating_floor" || actor?.type === "weightless_box";
    }

    function pushActorMembers(actor) {
      return actor.type === "weightless_box" ? weightlessGroupMembers(actor.groupId) : [actor];
    }

    function weightlessGroupMembers(groupId, options = {}) {
      const includeRemoved = options.includeRemoved === true;

      return app.state.actors.filter((actor) => {
        if (actor.type !== "weightless_box" || actor.groupId !== groupId) {
          return false;
        }

        return includeRemoved || !actor.removed;
      });
    }

    function weightlessGroupRenderState(groupId) {
      const members = weightlessGroupMembers(groupId, { includeRemoved: true });
      const anchor = members[0];

      if (!anchor) {
        return {
          offsetX: 0,
          offsetY: 0,
          renderElevation: 0,
          surfaceLift: 0,
          scale: 1,
          sink: 0,
          centerX: 0,
          centerY: 0
        };
      }

      const visibleMembers = members.filter((member) => !member.removed || member.renderScale > 0.001);
      const boundsSource = visibleMembers.length > 0 ? visibleMembers : members;
      let minX = boundsSource[0].x;
      let maxX = boundsSource[0].x;
      let minY = boundsSource[0].y;
      let maxY = boundsSource[0].y;

      boundsSource.forEach((member) => {
        minX = Math.min(minX, member.x);
        maxX = Math.max(maxX, member.x);
        minY = Math.min(minY, member.y);
        maxY = Math.max(maxY, member.y);
      });

      const offsetX = Math.round(anchor.renderX * app.TILE_SIZE) - anchor.x * app.TILE_SIZE;
      const offsetY = Math.round(anchor.renderY * app.TILE_SIZE) - anchor.y * app.TILE_SIZE;
      const renderElevation = actorRenderElevation(anchor);
      const surfaceLift = Math.round(app.TILE_SIZE * 0.26 * renderElevation);

      return {
        offsetX,
        offsetY,
        renderElevation,
        surfaceLift,
        scale: anchor.renderScale ?? 1,
        sink: anchor.renderSink ?? 0,
        centerX: ((minX + maxX + 1) * app.TILE_SIZE) / 2 + offsetX,
        centerY: ((minY + maxY + 1) * app.TILE_SIZE) / 2 + offsetY - surfaceLift
      };
    }

    function isWeightlessBoxAt(groupId, x, y) {
      return app.state.actors.some(
        (actor) =>
          !actor.removed &&
          actor.type === "weightless_box" &&
          actor.groupId === groupId &&
          actor.x === x &&
          actor.y === y
      );
    }

    function isInsideBoard(x, y) {
      return x >= 0 && x < app.state.width && y >= 0 && y < app.state.height;
    }

    function terrainAt(x, y) {
      return (
        app.state.terrain[y]?.[x] || {
          type: "empty",
          label: "Empty",
          imageUrl: null,
          underlay: null,
          raised: false
        }
      );
    }

    function groundSurfaceCell(cell) {
      if (
        (
          cell?.type === "wall" ||
          cell?.type === "ice_block" ||
          cell?.type === "ice_slope" ||
          cell?.type === "orange_ice_slope" ||
          cell?.type === "tree" ||
          cell?.type === "shrub" ||
          cell?.type === "block_asset"
        ) &&
        cell.underlay
      ) {
        return cell.underlay;
      }

      return cell;
    }

    function terrainLayersAt(x, y) {
      const cell = terrainAt(x, y);

      if (Array.isArray(cell.layers)) {
        return cell.layers;
      }

      return cell.type === "empty"
        ? []
        : [
            {
              type: cell.type,
              elevation: 0,
              raised: cell.raised === true
            }
          ];
    }

    function terrainLayersOfType(x, y, type) {
      return terrainLayersAt(x, y).filter((layer) => layer.type === type);
    }

    function terrainLayerSurfaceHeight(
      layer,
      x,
      y,
      gateState = app.liveRaisedPlayerGates,
      orangeWallState = app.liveRaisedOrangeWalls
    ) {
      const elevation = layer.elevation ?? 0;

      if (layer.type === "empty" || layer.type === "hole" || layer.type === "orange_button") {
        return null;
      }

      if (
        layer.type === "wall" ||
        layer.type === "ice_block" ||
        layer.type === "ice_slope" ||
        layer.type === "shrub" ||
        layer.type === "block_asset"
      ) {
        return elevation + 1;
      }

      if (layer.type === "tree") {
        return elevation + 3;
      }

      if (layer.type === "player_gate") {
        return gateState.has(posKey(x, y)) ? elevation + 1 : elevation;
      }

      if (layer.type === "player_lift") {
        return isRaisedPlayerLift(x, y) ? elevation + 1 : elevation;
      }

      if (layer.type === "orange_wall" || layer.type === "orange_ice_slope") {
        return orangeWallState.has(posKey(x, y)) ? elevation + 1 : elevation;
      }

      return elevation;
    }

    function terrainSurfaceHeightsAt(
      x,
      y,
      gateState = app.liveRaisedPlayerGates,
      orangeWallState = app.liveRaisedOrangeWalls
    ) {
      if (!isInsideBoard(x, y)) {
        return [];
      }

      return terrainLayersAt(x, y)
        .map((layer) => terrainLayerSurfaceHeight(layer, x, y, gateState, orangeWallState))
        .filter((height) => height !== null);
    }

    function isPlayerGate(x, y) {
      return terrainLayersOfType(x, y, "player_gate").length > 0;
    }

    function isPlayerLift(x, y) {
      return terrainLayersOfType(x, y, "player_lift").length > 0;
    }

    function isOrangeWall(x, y) {
      return terrainLayersOfType(x, y, "orange_wall").length > 0;
    }

    function isOrangeButton(x, y) {
      return (
        terrainLayersOfType(x, y, "orange_button").length > 0 ||
        actorsAt(x, y, (actor) => actor.type === "orange_button").length > 0
      );
    }

    let terrainFeatureIndex = null;
    let terrainFeatureIndexState = null;

    function invalidateTerrainFeatureIndex() {
      terrainFeatureIndex = null;
      terrainFeatureIndexState = null;
    }

    function getTerrainFeatureIndex() {
      // Key on the terrain array identity, not app.state: app.state is
      // mutated in place when levels load/swap, so its identity is useless
      // as a freshness signal. A replaced terrain array must rebuild the
      // index. (In-place cell edits still require an explicit
      // invalidateTerrainFeatureIndex call.)
      if (terrainFeatureIndex && terrainFeatureIndexState === app.state.terrain) {
        return terrainFeatureIndex;
      }

      const index = {
        playerGates: [],
        playerLifts: [],
        orangeWalls: [],
        orangeButtons: []
      };

      for (let y = 0; y < app.state.height; y += 1) {
        for (let x = 0; x < app.state.width; x += 1) {
          const layers = terrainLayersAt(x, y);

          for (let i = 0; i < layers.length; i += 1) {
            const type = layers[i].type;

            if (type === "player_gate") {
              index.playerGates.push({ x, y, key: posKey(x, y) });
            } else if (type === "player_lift") {
              index.playerLifts.push({ x, y, key: posKey(x, y) });
            } else if (type === "orange_wall" || type === "orange_ice_slope") {
              index.orangeWalls.push({ x, y, key: posKey(x, y) });
            } else if (type === "orange_button") {
              index.orangeButtons.push({ x, y, key: posKey(x, y) });
            }
          }
        }
      }

      dedupeFeatureCells(index.playerGates);
      dedupeFeatureCells(index.playerLifts);
      dedupeFeatureCells(index.orangeWalls);
      dedupeFeatureCells(index.orangeButtons);
      terrainFeatureIndex = index;
      terrainFeatureIndexState = app.state.terrain;
      return index;
    }

    function dedupeFeatureCells(cells) {
      const seen = new Set();

      for (let i = cells.length - 1; i >= 0; i -= 1) {
        if (seen.has(cells[i].key)) {
          cells.splice(i, 1);
        } else {
          seen.add(cells[i].key);
        }
      }
    }

    function eachOrangeWall(callback) {
      getTerrainFeatureIndex().orangeWalls.forEach((cell) => {
        callback(cell.x, cell.y, cell.key);
      });
    }

    function isOrangeButtonPressed(x, y, actors = app.state.actors, elevation = 0) {
      return actors.some(
        (actor) =>
          !actor.removed &&
          !isNonBlockingActor(actor) &&
          actorElevation(actor) === elevation &&
          actor.x === x &&
          actor.y === y
      );
    }

    function isOrangeButtonActorPressed(button, actors = app.state.actors) {
      return isOrangeButtonPressed(button.x, button.y, actors, actorElevation(button));
    }

    function areOrangeButtonsPressed(actors = app.state.actors) {
      let hasOrangeButton = false;
      const buttonCells = getTerrainFeatureIndex().orangeButtons;

      for (let i = 0; i < buttonCells.length; i += 1) {
        const { x, y } = buttonCells[i];

        hasOrangeButton = true;

        if (
          !terrainLayersOfType(x, y, "orange_button").every((layer) =>
            isOrangeButtonPressed(x, y, actors, layer.elevation ?? 0)
          )
        ) {
          return false;
        }
      }

      for (const button of actors) {
        if (button.removed || button.type !== "orange_button") {
          continue;
        }

        hasOrangeButton = true;

        if (!isOrangeButtonActorPressed(button, actors)) {
          return false;
        }
      }

      return hasOrangeButton;
    }

    let liveSurfaceActorCodes = null;
    let liveSurfaceActorState = null;

    function actorSurfaceCode(actor) {
      // Encodes every actor property the raised-gate/orange-wall rules read.
      return [
        actor.x,
        actor.y,
        actorElevation(actor),
        actor.removed ? 1 : 0
      ].join(",");
    }

    function syncLiveRaisedSurfaces() {
      if (app.gateRenderOverride || app.orangeWallRenderOverride) {
        app.liveRaisedPlayerGates = app.gateRenderOverride || computeRaisedPlayerGateSet();
        app.liveRaisedOrangeWalls = app.orangeWallRenderOverride || computeRaisedOrangeWallSet();
        liveSurfaceActorCodes = null;
        return;
      }

      const actors = app.state.actors;
      let changed =
        !liveSurfaceActorCodes ||
        liveSurfaceActorState !== app.state ||
        liveSurfaceActorCodes.length !== actors.length;

      if (!changed) {
        for (let i = 0; i < actors.length; i += 1) {
          if (liveSurfaceActorCodes[i] !== actorSurfaceCode(actors[i])) {
            changed = true;
            break;
          }
        }
      }

      if (!changed) {
        return;
      }

      liveSurfaceActorCodes = actors.map(actorSurfaceCode);
      liveSurfaceActorState = app.state;
      app.liveRaisedPlayerGates = computeRaisedPlayerGateSet();
      app.liveRaisedOrangeWalls = computeRaisedOrangeWallSet();
    }

    function computeRaisedOrangeWallSet(actors = app.state.actors) {
      const raised = new Set();

      if (!app.isEditorRenderApp && areOrangeButtonsPressed(actors)) {
        return raised;
      }

      const resolvedState =
        actors === app.state.actors && app.orangeWallRaisedState instanceof Set
          ? app.orangeWallRaisedState
          : null;

      eachOrangeWall((x, y, key) => {
        if (!resolvedState || resolvedState.has(key)) {
          raised.add(key);
        }
      });

      return raised;
    }

    function setRaisedOrangeWallState(keys) {
      const nextState = keys instanceof Set ? new Set(keys) : new Set(keys || []);
      app.orangeWallRaisedState = nextState;
      app.liveRaisedOrangeWalls = new Set(nextState);
      liveSurfaceActorCodes = null;
      liveSurfaceActorState = null;
    }

    function isRaisedOrangeWall(x, y, orangeWallState = app.liveRaisedOrangeWalls) {
      return isOrangeWall(x, y) && orangeWallState.has(posKey(x, y));
    }

    function eachPlayerLift(callback) {
      getTerrainFeatureIndex().playerLifts.forEach((cell) => {
        callback(cell.x, cell.y, cell.key);
      });
    }

    function isRaisedPlayerLift(x, y) {
      return (
        isPlayerLift(x, y) &&
        (terrainAt(x, y).raised === true ||
          terrainLayersOfType(x, y, "player_lift").some((layer) => layer.raised === true))
      );
    }

    function setPlayerLiftRaised(x, y, raised) {
      if (!isPlayerLift(x, y)) {
        // Attached lifts keep their raised state on the actor: engine
        // rebuilds read it back and the renderer draws the raised block.
        let toggled = false;

        app.state.actors.forEach((actor) => {
          if (
            !actor.removed &&
            actor.type === "attached_lift" &&
            actor.x === x &&
            actor.y === y
          ) {
            actor.raised = Boolean(raised);
            toggled = true;
          }
        });

        if (toggled) {
          app.terrainRenderVersion = (Number(app.terrainRenderVersion) || 0) + 1;
        }

        return toggled && Boolean(raised);
      }

      const cell = terrainAt(x, y);

      app.terrainRenderVersion = (Number(app.terrainRenderVersion) || 0) + 1;
      cell.raised = Boolean(raised);

      if (Array.isArray(cell.layers)) {
        cell.layers.forEach((layer) => {
          if (layer.type === "player_lift") {
            layer.raised = Boolean(raised);
          }
        });
      }

      return cell.raised;
    }

    function togglePlayerLiftAt(x, y) {
      return setPlayerLiftRaised(x, y, !isRaisedPlayerLift(x, y));
    }

    function terrainSurfaceHeightAt(
      x,
      y,
      gateState = app.liveRaisedPlayerGates,
      orangeWallState = app.liveRaisedOrangeWalls
    ) {
      if (!isInsideBoard(x, y)) {
        return null;
      }

      const heights = terrainSurfaceHeightsAt(x, y, gateState, orangeWallState);

      return heights.length > 0 ? Math.max(...heights) : null;
    }

    function actorSupportSurfaceHeightsAt(
      x,
      y,
      ignoredActors = null,
      includePlayers = false,
      gateState = app.liveRaisedPlayerGates
    ) {
      return actorsAt(
        x,
        y,
        (actor) =>
          !ignoredActors?.has(actor) &&
          (includePlayers || !isMainPlayerActor(actor)) &&
          (actor.type === "box" ||
            actor.type === "floating_floor" ||
            actor.type === "weightless_box" ||
            actor.type === "attached_gate" ||
            isPlayerActor(actor))
      ).map((actor) =>
        actor.type === "attached_gate"
          ? actorElevation(actor) + (gateState.has(posKey(x, y)) ? 1 : 0)
          : actorElevation(actor) + 1
      );
    }

    function hasElevatedActorSurfaceAt(x, y, ignoredActors = null) {
      return actorSupportSurfaceHeightsAt(x, y, ignoredActors, false).some(
        (height) => height > 0
      );
    }

    function hasWeightlessSupportActorSurfaceAt(x, y, ignoredActors = null) {
      return actorSupportSurfaceHeightsAt(x, y, ignoredActors, true).length > 0;
    }

    function playerSurfaceHeightAt(
      x,
      y,
      gateState = app.liveRaisedPlayerGates,
      orangeWallState = app.liveRaisedOrangeWalls,
      ignoredActors = null
    ) {
      const heights = terrainSurfaceHeightsAt(x, y, gateState, orangeWallState).concat(
        actorSupportSurfaceHeightsAt(x, y, ignoredActors, false, gateState)
      );

      return heights.length > 0 ? Math.max(...heights) : null;
    }

    function weightlessGroupSupportedElevation(
      members,
      gateState = app.liveRaisedPlayerGates,
      orangeWallState = app.liveRaisedOrangeWalls
    ) {
      const memberSet = new Set(members);

      let baseElevation = 0;

      members.forEach((member) => {
        const relativeElevation = member.__weightlessRelativeElevation ?? 0;
        const currentElevation = actorElevation(member);
        const supportHeights = terrainSurfaceHeightsAt(
          member.x,
          member.y,
          gateState,
          orangeWallState
        ).concat(actorSupportSurfaceHeightsAt(member.x, member.y, memberSet, true, gateState));

        supportHeights.forEach((height) => {
          if (height > currentElevation + 1) {
            return;
          }

          baseElevation = Math.max(baseElevation, height - relativeElevation);
        });
      });

      return Math.max(0, baseElevation);
    }

    function computeRaisedPlayerGateSet(actors = app.state.actors) {
      const activeActors = actors.filter((actor) => !actor.removed);
      const players = activeActors.filter((actor) => isPlayerActor(actor));
      const raised = new Set();
      const gateCells = getTerrainFeatureIndex().playerGates;

      for (let i = 0; i < gateCells.length; i += 1) {
        const { x, y } = gateCells[i];

        terrainLayersOfType(x, y, "player_gate").forEach((gateLayer) => {
          const gateElevation = gateLayer.elevation ?? 0;
          const sameLevelBlockOnGate = activeActors.some(
            (actor) =>
              !isPlayerActor(actor) &&
              !isNonBlockingActor(actor) &&
              actorElevation(actor) === gateElevation &&
              actor.x === x &&
              actor.y === y
          );

          if (
            players.some(
              (actor) => {
                const playerElevation = actorElevation(actor);
                const xyDistance = Math.abs(actor.x - x) + Math.abs(actor.y - y);
                const standingOnGate = xyDistance === 0 && playerElevation === gateElevation;

                return (
                  xyDistance <= 1 &&
                  !standingOnGate &&
                  (playerElevation !== gateElevation || !sameLevelBlockOnGate)
                );
              }
            )
          ) {
            raised.add(posKey(x, y));
          }
        });
      }

      // Attached gates share the raised set (same proximity rule at the
      // carrier-top elevation), keyed by their current cell.
      activeActors.forEach((gateActor) => {
        if (gateActor.type !== "attached_gate") {
          return;
        }

        const x = gateActor.x;
        const y = gateActor.y;
        const gateElevation = actorElevation(gateActor);
        const sameLevelBlockOnGate = activeActors.some(
          (actor) =>
            actor !== gateActor &&
            !isPlayerActor(actor) &&
            !isNonBlockingActor(actor) &&
            actorElevation(actor) === gateElevation &&
            actor.x === x &&
            actor.y === y
        );

        if (
          players.some((actor) => {
            const playerElevation = actorElevation(actor);
            const xyDistance = Math.abs(actor.x - x) + Math.abs(actor.y - y);
            const standingOnGate = xyDistance === 0 && playerElevation === gateElevation;

            return (
              standingOnGate ||
              (xyDistance <= 1 &&
                (playerElevation !== gateElevation || !sameLevelBlockOnGate))
            );
          })
        ) {
          raised.add(posKey(x, y));
        }
      });

      return raised;
    }

    function eachPlayerGate(callback) {
      getTerrainFeatureIndex().playerGates.forEach((cell) => {
        callback(cell.x, cell.y, cell.key);
      });
    }

    function eachAttachedPlayerGate(callback) {
      app.state.actors.forEach((actor, index) => {
        if (!actor.removed && actor.type === "attached_gate") {
          callback(actor, index);
        }
      });
    }

    function isRaisedPlayerGate(x, y, gateState = app.liveRaisedPlayerGates) {
      return isPlayerGate(x, y) && gateState.has(posKey(x, y));
    }

    function isTerrainWall(x, y) {
      return terrainLayersOfType(x, y, "wall").length > 0 ||
        terrainLayersOfType(x, y, "ice_block").length > 0 ||
        terrainLayersOfType(x, y, "ice_slope").length > 0 ||
        terrainLayersOfType(x, y, "orange_ice_slope").length > 0 ||
        terrainLayersOfType(x, y, "tree").length > 0 ||
        terrainLayersOfType(x, y, "shrub").length > 0 ||
        terrainLayersOfType(x, y, "block_asset").length > 0;
    }

    function terrainCellAcrossHorizontalWorldEdge(x, y) {
      if (y < 0 || y >= app.state.height) {
        return null;
      }

      if (x >= 0 && x < app.state.width) {
        return terrainAt(x, y);
      }

      if (x !== -1 && x !== app.state.width) {
        return null;
      }

      const neighborLevelId = adjacentWorldLevelId(app.currentLevelId, x < 0 ? -1 : 1, 0);

      if (!neighborLevelId) {
        return null;
      }

      const neighborLevelState = cachedHorizontalNeighborLevelState(neighborLevelId);

      if (!neighborLevelState) {
        if (app.worldViewVistaMode !== true) {
          queueHorizontalNeighborLevelState(neighborLevelId);
        }
        return null;
      }

      const neighborX = x < 0 ? neighborLevelState.width - 1 : 0;

      if (neighborX < 0 || y >= neighborLevelState.height) {
        return null;
      }

      return neighborLevelState.terrain?.[y]?.[neighborX] || null;
    }

    function isTerrainWallAcrossHorizontalWorldEdge(x, y) {
      const cell = terrainCellAcrossHorizontalWorldEdge(x, y);

      return (
        cell?.type === "wall" ||
        cell?.type === "ice_block" ||
        cell?.type === "ice_slope" ||
        cell?.type === "orange_ice_slope" ||
        cell?.type === "tree" ||
        cell?.type === "shrub" ||
        cell?.type === "block_asset"
      );
    }

    function isWall(
      x,
      y,
      gateState = app.liveRaisedPlayerGates,
      orangeWallState = app.liveRaisedOrangeWalls
    ) {
      return (
        isTerrainWall(x, y) ||
        isRaisedPlayerGate(x, y, gateState) ||
        isRaisedPlayerLift(x, y) ||
        isRaisedOrangeWall(x, y, orangeWallState)
      );
    }

    function elevatedBlockFamiliesAt(
      x,
      y,
      gateState = app.liveRaisedPlayerGates,
      orangeWallState = app.liveRaisedOrangeWalls
    ) {
      const families = new Set();

      if ((x === -1 || x === app.state.width) && isTerrainWallAcrossHorizontalWorldEdge(x, y)) {
        families.add("terrain:wall");
        return families;
      }

      if (!isInsideBoard(x, y)) {
        return families;
      }

      if (isTerrainWall(x, y)) {
        families.add("terrain:wall");
      }

      if (isRaisedPlayerGate(x, y, gateState)) {
        families.add("terrain:player_gate");
      }

      if (isRaisedPlayerLift(x, y)) {
        families.add("terrain:player_lift");
      }

      if (isRaisedOrangeWall(x, y, orangeWallState)) {
        families.add("terrain:orange_wall");
      }

      app.state.actors.forEach((actor) => {
        if (actor.removed || actor.x !== x || actor.y !== y) {
          return;
        }

        if (actor.type === "weightless_box") {
          families.add(`actor:weightless_box:${actor.groupId ?? "__ungrouped__"}`);
          return;
        }

        if (actor.type === "player" || actor.type === "box" || actor.type === "floating_floor") {
          families.add(`actor:${actor.type}`);
        }
      });

      return families;
    }

    function sharedElevatedBlockFamilies(
      positions,
      gateState = app.liveRaisedPlayerGates,
      orangeWallState = app.liveRaisedOrangeWalls
    ) {
      let sharedFamilies = null;

      for (const position of positions) {
        const families = elevatedBlockFamiliesAt(position.x, position.y, gateState, orangeWallState);

        if (families.size === 0) {
          return new Set();
        }

        if (sharedFamilies === null) {
          sharedFamilies = new Set(families);
          continue;
        }

        sharedFamilies = new Set(
          Array.from(sharedFamilies).filter((family) => families.has(family))
        );

        if (sharedFamilies.size === 0) {
          return new Set();
        }
      }

      return sharedFamilies || new Set();
    }

    function sharedElevatedBlockFamily(
      positions,
      gateState = app.liveRaisedPlayerGates,
      orangeWallState = app.liveRaisedOrangeWalls
    ) {
      return sharedElevatedBlockFamilies(positions, gateState, orangeWallState).size > 0;
    }

    function elevatedSideBleedCoverFamily(
      x,
      y,
      dx,
      gateState = app.liveRaisedPlayerGates,
      orangeWallState = app.liveRaisedOrangeWalls
    ) {
      if (dx !== -1 && dx !== 1) {
        return null;
      }

      if (y >= app.state.height - 1) {
        return null;
      }

      const families = sharedElevatedBlockFamilies(
        [
          { x: x + dx, y },
          { x, y: y + 1 },
          { x: x + dx, y: y + 1 }
        ],
        gateState,
        orangeWallState
      );
      const family = families.values().next().value || null;

      return family === "terrain:player_lift" ? null : family;
    }

    function terrainLayerOfTypeAtElevation(x, y, type, elevation = 0) {
      return terrainLayersOfType(x, y, type).some((layer) => {
        if (type === "hole") {
          return (layer.elevation ?? 0) === elevation;
        }

        return terrainLayerSurfaceHeight(layer, x, y) === elevation;
      });
    }

    function isEmptyVoidAtElevation(x, y, elevation = 0) {
      return elevation === 0 && isInsideBoard(x, y) && terrainLayersAt(x, y).length === 0;
    }

    function isIce(x, y, elevation = 0) {
      return (
        terrainLayerOfTypeAtElevation(x, y, "ice", elevation) ||
        terrainLayerOfTypeAtElevation(x, y, "ice_block", elevation)
      );
    }

    function isHole(x, y, elevation = 0) {
      return (
        isEmptyVoidAtElevation(x, y, elevation) ||
        terrainLayerOfTypeAtElevation(x, y, "hole", elevation)
      );
    }

    function isIceOrHole(x, y, elevation = 0) {
      return isIce(x, y, elevation) || isHole(x, y, elevation);
    }

    function isGroundCell(cell) {
      const groundCell = groundSurfaceCell(cell);
      return (
        groundCell.type !== "wall" &&
        groundCell.type !== "ice_block" &&
        groundCell.type !== "ice_slope" &&
        groundCell.type !== "shrub" &&
        groundCell.type !== "block_asset" &&
        groundCell.type !== "hole" &&
        groundCell.type !== "empty"
      );
    }

    function hasVisibleFloatingFloorActors() {
      return app.state.actors.some(
        (actor) =>
          (actor.type === "floating_floor" || actor.type === "gem") &&
          (!actor.removed || (actor.renderScale ?? 0) > 0.001)
      );
    }

    function floatingFloorHoverOffset(actor, now = performance.now()) {
      if (actor?.type !== "gem" && actor?.type !== "floating_floor") {
        return 0;
      }

      const hoverBase = actor.type === "gem" ? app.GEM_HOVER_BASE : app.FLOATING_FLOOR_HOVER_BASE;
      const hoverBob = actor.type === "gem" ? app.GEM_HOVER_BOB : app.FLOATING_FLOOR_HOVER_BOB;
      const hoverPeriod =
        actor.type === "gem" ? app.GEM_HOVER_PERIOD_MS : app.FLOATING_FLOOR_HOVER_PERIOD_MS;
      const oscillation =
        Math.sin((now / hoverPeriod) * Math.PI * 2 + (actor.hoverSeed || 0)) * hoverBob;
      return hoverBase + oscillation;
    }

    function easeOutBack(progress) {
      const overshoot = 1.45;
      const shifted = progress - 1;
      return 1 + (overshoot + 1) * shifted * shifted * shifted + overshoot * shifted * shifted;
    }

    function easeInOutQuad(progress) {
      if (progress < 0.5) {
        return 2 * progress * progress;
      }

      return 1 - Math.pow(-2 * progress + 2, 2) / 2;
    }

    function gateAnimationValue(animation, now) {
      if (!animation) {
        return 0;
      }

      if (animation.startMs === null || animation.from === animation.to) {
        return animation.to;
      }

      const progress = clamp((now - animation.startMs) / animation.durationMs, 0, 1);
      const eased =
        animation.to > animation.from ? easeOutBack(progress) : easeInOutQuad(progress);
      return animation.from + (animation.to - animation.from) * eased;
    }

    function gateLiftAt(x, y, now = performance.now()) {
      const animation = app.gateAnimations.get(posKey(x, y));
      const target = app.liveRaisedPlayerGates.has(posKey(x, y)) ? 1 : 0;
      const value = animation ? gateAnimationValue(animation, now) : target;
      return clamp(value, 0, 1.08);
    }

    function attachedGateTarget(actor, animation = null) {
      if (app.gateRenderOverride && animation) {
        return animation.to;
      }

      const x = app.gateRenderOverride
        ? Math.round(actor.renderX ?? actor.x)
        : actor.x;
      const y = app.gateRenderOverride
        ? Math.round(actor.renderY ?? actor.y)
        : actor.y;

      return app.liveRaisedPlayerGates.has(posKey(x, y)) ? 1 : 0;
    }

    function attachedGateLiftAt(actor, now = performance.now()) {
      if (!actor || actor.type !== "attached_gate" || actor.removed) {
        return 0;
      }

      const animation = app.gateAnimations.get(actor);
      const target = attachedGateTarget(actor, animation);
      const value = animation ? gateAnimationValue(animation, now) : target;
      return clamp(value, 0, 1.08);
    }

    function canAuxiliaryTickerRender() {
      return !app.isAnimating && !app.isTransitioningLevel && !app.levelTransition;
    }

    function startGateAnimationLoop() {
      if (app.gateAnimationFrameId !== null) {
        return;
      }

      function step(now) {
        let hasActiveAnimation = false;

        app.gateAnimations.forEach((animation) => {
          if (animation.startMs === null) {
            return;
          }

          if (now - animation.startMs >= animation.durationMs) {
            animation.from = animation.to;
            animation.startMs = null;
            return;
          }

          hasActiveAnimation = true;
        });

        if (canAuxiliaryTickerRender()) {
          renderOncePerFrame(now);
        }

        if (hasActiveAnimation) {
          app.gateAnimationFrameId = window.requestAnimationFrame(step);
          return;
        }

        app.gateAnimationFrameId = null;
      }

      app.gateAnimationFrameId = window.requestAnimationFrame(step);
    }

    function syncGateAnimationTargets(now = performance.now()) {
      if (!app.gateAnimationsInitialized) {
        eachPlayerGate((x, y, key) => {
          const target = app.liveRaisedPlayerGates.has(key) ? 1 : 0;
          app.gateAnimations.set(key, {
            from: target,
            to: target,
            startMs: null,
            durationMs: app.GATE_RISE_DURATION_MS
          });
        });
        eachAttachedPlayerGate((actor) => {
          const target = attachedGateTarget(actor);
          app.gateAnimations.set(actor, {
            from: target,
            to: target,
            startMs: null,
            durationMs: app.GATE_RISE_DURATION_MS
          });
        });
        app.gateAnimationsInitialized = true;
        return;
      }

      let hasActiveAnimation = false;

      function syncTarget(key, target) {
        const animation = app.gateAnimations.get(key);

        if (!animation) {
          app.gateAnimations.set(key, {
            from: target,
            to: target,
            startMs: null,
            durationMs: app.GATE_RISE_DURATION_MS
          });
          return;
        }

        if (animation.startMs !== null && now - animation.startMs >= animation.durationMs) {
          animation.from = animation.to;
          animation.startMs = null;
        }

        const current = gateAnimationValue(animation, now);

        if (animation.to !== target) {
          animation.from = current;
          animation.to = target;
          animation.startMs = now;
          animation.durationMs =
            target > current ? app.GATE_RISE_DURATION_MS : app.GATE_FALL_DURATION_MS;
        }

        if (animation.startMs !== null) {
          hasActiveAnimation = true;
        }
      }

      eachPlayerGate((x, y, key) => {
        const target = app.liveRaisedPlayerGates.has(key) ? 1 : 0;
        syncTarget(key, target);
      });

      const activeAttachedGates = new Set();

      eachAttachedPlayerGate((actor) => {
        activeAttachedGates.add(actor);
        syncTarget(actor, attachedGateTarget(actor, app.gateAnimations.get(actor)));
      });

      app.gateAnimations.forEach((_animation, key) => {
        if (typeof key === "object" && !activeAttachedGates.has(key)) {
          app.gateAnimations.delete(key);
        }
      });

      if (hasActiveAnimation) {
        startGateAnimationLoop();
      }
    }

    function orangeWallLiftAt(x, y, now = performance.now()) {
      const key = posKey(x, y);
      const animation = app.orangeWallAnimations.get(key);
      const target = app.liveRaisedOrangeWalls.has(key) ? 1 : 0;
      const value = animation ? gateAnimationValue(animation, now) : target;
      return clamp(value, 0, 1.08);
    }

    function startOrangeWallAnimationLoop() {
      if (app.orangeWallAnimationFrameId !== null) {
        return;
      }

      function step(now) {
        let hasActiveAnimation = false;

        app.orangeWallAnimations.forEach((animation) => {
          if (animation.startMs === null) {
            return;
          }

          if (now - animation.startMs >= animation.durationMs) {
            animation.from = animation.to;
            animation.startMs = null;
            return;
          }

          hasActiveAnimation = true;
        });

        if (canAuxiliaryTickerRender()) {
          renderOncePerFrame(now);
        }

        if (hasActiveAnimation) {
          app.orangeWallAnimationFrameId = window.requestAnimationFrame(step);
          return;
        }

        app.orangeWallAnimationFrameId = null;
      }

      app.orangeWallAnimationFrameId = window.requestAnimationFrame(step);
    }

    function syncOrangeWallAnimationTargets(now = performance.now()) {
      if (!app.orangeWallAnimationsInitialized) {
        eachOrangeWall((x, y, key) => {
          const target = app.liveRaisedOrangeWalls.has(key) ? 1 : 0;
          app.orangeWallAnimations.set(key, {
            from: target,
            to: target,
            startMs: null,
            durationMs: app.ORANGE_WALL_RISE_DURATION_MS
          });
        });
        app.orangeWallAnimationsInitialized = true;
        return;
      }

      let hasActiveAnimation = false;

      eachOrangeWall((x, y, key) => {
        const target = app.liveRaisedOrangeWalls.has(key) ? 1 : 0;
        const animation = app.orangeWallAnimations.get(key);

        if (!animation) {
          app.orangeWallAnimations.set(key, {
            from: target,
            to: target,
            startMs: null,
            durationMs: app.ORANGE_WALL_RISE_DURATION_MS
          });
          return;
        }

        if (animation.startMs !== null && now - animation.startMs >= animation.durationMs) {
          animation.from = animation.to;
          animation.startMs = null;
        }

        const current = gateAnimationValue(animation, now);

        if (animation.to !== target) {
          animation.from = current;
          animation.to = target;
          animation.startMs = now;
          animation.durationMs =
            target > current ? app.ORANGE_WALL_RISE_DURATION_MS : app.ORANGE_WALL_FALL_DURATION_MS;
        }

        if (animation.startMs !== null) {
          hasActiveAnimation = true;
        }
      });

      if (hasActiveAnimation) {
        startOrangeWallAnimationLoop();
      }
    }

    function playerLiftAt(x, y, now = performance.now()) {
      const animation = app.playerLiftAnimations.get(posKey(x, y));
      const target = isRaisedPlayerLift(x, y) ? 1 : 0;
      const value = animation ? gateAnimationValue(animation, now) : target;
      return clamp(value, 0, 1.08);
    }

    function startPlayerLiftAnimationLoop() {
      if (app.playerLiftAnimationFrameId !== null) {
        return;
      }

      function step(now) {
        let hasActiveAnimation = false;

        app.playerLiftAnimations.forEach((animation) => {
          if (animation.startMs === null) {
            return;
          }

          if (now - animation.startMs >= animation.durationMs) {
            animation.from = animation.to;
            animation.startMs = null;
            return;
          }

          hasActiveAnimation = true;
        });

        if (canAuxiliaryTickerRender()) {
          renderOncePerFrame(now);
        }

        if (hasActiveAnimation) {
          app.playerLiftAnimationFrameId = window.requestAnimationFrame(step);
          return;
        }

        app.playerLiftAnimationFrameId = null;
      }

      app.playerLiftAnimationFrameId = window.requestAnimationFrame(step);
    }

    function syncPlayerLiftAnimationTargets(now = performance.now()) {
      if (!app.playerLiftAnimationsInitialized) {
        eachPlayerLift((x, y, key) => {
          const target = isRaisedPlayerLift(x, y) ? 1 : 0;
          app.playerLiftAnimations.set(key, {
            from: target,
            to: target,
            startMs: null,
            durationMs: app.PLAYER_LIFT_RISE_DURATION_MS
          });
        });
        app.playerLiftAnimationsInitialized = true;
        return;
      }

      let hasActiveAnimation = false;

      eachPlayerLift((x, y, key) => {
        const target = isRaisedPlayerLift(x, y) ? 1 : 0;
        const animation = app.playerLiftAnimations.get(key);

        if (!animation) {
          app.playerLiftAnimations.set(key, {
            from: target,
            to: target,
            startMs: null,
            durationMs: app.PLAYER_LIFT_RISE_DURATION_MS
          });
          return;
        }

        if (animation.startMs !== null && now - animation.startMs >= animation.durationMs) {
          animation.from = animation.to;
          animation.startMs = null;
        }

        const current = gateAnimationValue(animation, now);

        if (animation.to !== target) {
          animation.from = current;
          animation.to = target;
          animation.startMs = now;
          animation.durationMs =
            target > current ? app.PLAYER_LIFT_RISE_DURATION_MS : app.PLAYER_LIFT_FALL_DURATION_MS;
        }

        if (animation.startMs !== null) {
          hasActiveAnimation = true;
        }
      });

      if (hasActiveAnimation) {
        startPlayerLiftAnimationLoop();
      }
    }

    function initializeActorElevations() {
      app.state.actors.forEach((actor, index) => {
        if (actor.type === "weightless_box" && !actor.__explicitElevation) {
          const elevation = initialWeightlessStackElevation(actor, index);
          actor.elevation = elevation;
          actor.renderElevation = elevation;
        }
      });

      const weightlessGroupBases = new Map();

      app.state.actors.forEach((actor) => {
        if (actor.type !== "weightless_box") {
          return;
        }

        const base = weightlessGroupBases.has(actor.groupId)
          ? Math.min(weightlessGroupBases.get(actor.groupId), actor.elevation ?? 0)
          : actor.elevation ?? 0;

        weightlessGroupBases.set(actor.groupId, base);
      });

      app.state.actors.forEach((actor) => {
        if (actor.type !== "weightless_box") {
          return;
        }

        Object.defineProperty(actor, "__weightlessRelativeElevation", {
          configurable: true,
          value: (actor.elevation ?? 0) - (weightlessGroupBases.get(actor.groupId) ?? 0)
        });
      });

      let gateState = computeRaisedPlayerGateSet(app.state.actors);
      let orangeWallState = computeRaisedOrangeWallSet(app.state.actors);

      for (let iteration = 0; iteration < 4; iteration += 1) {
        const initializedWeightlessGroups = new Set();
        let changed = false;

        app.state.actors.forEach((actor) => {
          if (actor.type !== "weightless_box" || actor.removed) {
            return;
          }

          if (initializedWeightlessGroups.has(actor.groupId)) {
            return;
          }

          initializedWeightlessGroups.add(actor.groupId);

          const members = weightlessGroupMembers(actor.groupId);

          if (members.every((member) => member.__explicitElevation)) {
            return;
          }

          const baseElevation = weightlessGroupSupportedElevation(members, gateState, orangeWallState);

          members.forEach((member) => {
            const elevation = baseElevation + (member.__weightlessRelativeElevation ?? 0);

            if (member.elevation !== elevation) {
              changed = true;
            }

            member.elevation = elevation;
            member.renderElevation = elevation;
          });
        });

        gateState = computeRaisedPlayerGateSet(app.state.actors);
        orangeWallState = computeRaisedOrangeWallSet(app.state.actors);

        if (!changed) {
          break;
        }
      }

      app.state.actors.forEach((actor) => {
        if (!isPlayerActor(actor)) {
          return;
        }

        if (actor.__explicitElevation) {
          return;
        }

        const elevation =
          playerSurfaceHeightAt(actor.x, actor.y, gateState, orangeWallState, new Set([actor])) ??
          0;
        actor.elevation = elevation;
        actor.renderElevation = elevation;
      });
    }

    function initialWeightlessStackElevation(actor, index) {
      let elevation = 0;

      for (let otherIndex = 0; otherIndex < index; otherIndex += 1) {
        const other = app.state.actors[otherIndex];

        if (
          other &&
          (other.type === "player" ||
            other.type === "circle_player" ||
            other.type === "clone" ||
            other.type === "box" ||
            other.type === "floating_floor" ||
            other.type === "weightless_box") &&
          !other.removed &&
          other.x === actor.x &&
          other.y === actor.y
        ) {
          elevation = Math.max(elevation, (other.elevation ?? 0) + 1);
        }
      }

      return elevation;
    }

    function syncFuzzyToggle() {
      if (!app.fuzzyToggle) {
        return;
      }

      app.fuzzyToggle.classList.toggle("is-active", app.state.effects.fuzzyEnabled);
      app.fuzzyToggle.setAttribute("aria-pressed", app.state.effects.fuzzyEnabled ? "true" : "false");
    }

    function syncEdgeToggle() {
      if (!app.edgeToggle) {
        return;
      }

      app.edgeToggle.classList.toggle("is-active", app.state.effects.edgeOutlinesEnabled);
      app.edgeToggle.setAttribute("aria-pressed", app.state.effects.edgeOutlinesEnabled ? "true" : "false");
    }

    function syncNoiseTicker() {
      if (app.noiseFrameId !== null) {
        window.cancelAnimationFrame(app.noiseFrameId);
        app.noiseFrameId = null;
      }

      if (!app.state.effects.fuzzyEnabled) {
        app.lastNoiseTickMs = 0;
        return;
      }

      app.lastNoiseTickMs = performance.now();

      function step(now) {
        const elapsed = now - app.lastNoiseTickMs;
        const phaseStep = Math.floor(elapsed / app.NOISE_FRAME_MS);

        if (phaseStep > 0) {
          if (canAuxiliaryTickerRender()) {
            app.state.effects.noisePhase = (app.state.effects.noisePhase + phaseStep) % app.NOISE_PHASE_CYCLE;
            app.lastNoiseTickMs += phaseStep * app.NOISE_FRAME_MS;
            renderOncePerFrame(now);
          } else {
            app.lastNoiseTickMs = now;
          }
        }

        if (app.state.effects.fuzzyEnabled) {
          app.noiseFrameId = window.requestAnimationFrame(step);
        } else {
          app.noiseFrameId = null;
        }
      }

      app.noiseFrameId = window.requestAnimationFrame(step);
    }

    function syncFloatingFloorTicker() {
      if (app.floatingFloorFrameId !== null) {
        window.cancelAnimationFrame(app.floatingFloorFrameId);
        app.floatingFloorFrameId = null;
      }

      if (app.isFlyoverMode && app.flyoverWholeWorld === true) {
        app.lastFloatingFloorTickMs = 0;
        return;
      }

      if (!hasVisibleFloatingFloorActors()) {
        app.lastFloatingFloorTickMs = 0;
        return;
      }

      app.lastFloatingFloorTickMs = 0;

      function step(now) {
        if (!hasVisibleFloatingFloorActors()) {
          app.floatingFloorFrameId = null;
          app.lastFloatingFloorTickMs = 0;
          return;
        }

        if (
          app.lastFloatingFloorTickMs === 0 ||
          now - app.lastFloatingFloorTickMs >= app.FLOATING_FLOOR_HOVER_FRAME_MS
        ) {
          app.lastFloatingFloorTickMs = now;

          if (canAuxiliaryTickerRender()) {
            // Move the hover/spin meshes in place first; the render below
            // then hits the unchanged-signature blit path instead of a
            // full scene rebuild.
            app.threeRenderer?.renderHoverFrame?.(now);
            renderOncePerFrame(now);
          }
        }

        app.floatingFloorFrameId = window.requestAnimationFrame(step);
      }

      app.floatingFloorFrameId = window.requestAnimationFrame(step);
    }

    function setupCanvas() {
      // Full-bleed hosts can render the 3D pipeline above CSS resolution
      // (hostRenderPixelScale, e.g. 2 on high-DPI phones): boardRect and every
      // canvas in the composite chain scale together, and the final present
      // divides the scale back out of the device-pixel backing store. Without
      // this the scene rasterizes at CSS pixels and gets upscaled by the
      // device pixel ratio — blurry, with visibly thickened edge lines.
      const renderScale =
        !app.isFlyoverMode && app.hostFullBleedView === true
          ? Math.max(1, Math.min(3, Number(app.hostRenderPixelScale) || 1))
          : 1;

      app.renderPixelScale = renderScale;

      if ((app.isFlyoverMode || app.hostFullBleedView === true) && app.mazeFrame) {
        const rect = app.mazeFrame.getBoundingClientRect();
        const width = Math.max(
          1,
          Math.round((rect.width || window.innerWidth || app.boardRect.width / renderScale) * renderScale)
        );
        const height = Math.max(
          1,
          Math.round((rect.height || window.innerHeight || app.boardRect.height / renderScale) * renderScale)
        );

        app.boardRect = { width, height };
        app.viewportRect = { width, height };
      }

      const dpr = app.isFlyoverMode ? 1 : (window.devicePixelRatio || 1) / renderScale;
      app.canvas.width = Math.round(app.viewportRect.width * dpr);
      app.canvas.height = Math.round(app.viewportRect.height * dpr);
      app.canvas.style.aspectRatio = `${app.viewportRect.width} / ${app.viewportRect.height}`;
      app.sceneCanvas.width = app.boardRect.width;
      app.sceneCanvas.height = app.boardRect.height;
      app.sceneCtx.setTransform(1, 0, 0, 1, 0, 0);
      app.sceneCtx.imageSmoothingEnabled = false;
      app.viewCanvas.width = app.viewportRect.width;
      app.viewCanvas.height = app.viewportRect.height;
      app.viewCtx.setTransform(1, 0, 0, 1, 0, 0);
      app.viewCtx.imageSmoothingEnabled = false;

      if (app.renderer && app.gl) {
        app.gl.viewport(0, 0, app.canvas.width, app.canvas.height);
      } else if (app.fallbackCtx) {
        app.fallbackCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        app.fallbackCtx.imageSmoothingEnabled = false;
      }
    }

    function syncPlayLayout() {
      if ((app.isFlyoverMode || app.hostFullBleedView === true) && app.playStage && app.mazeFrame) {
        const width = Math.max(1, app.playStage.clientWidth || window.innerWidth || app.viewportRect.width);
        const height = Math.max(1, app.playStage.clientHeight || window.innerHeight || app.viewportRect.height);

        app.mazeFrame.style.width = `${width}px`;
        app.mazeFrame.style.height = `${height}px`;

        if (app.playHeader) {
          app.playHeader.style.width = `${width}px`;
        }
        return;
      }

      if (!app.playShell || !app.playHeader || !app.playStage || !app.mazeFrame) {
        return;
      }

      const frameStyles = window.getComputedStyle(app.mazeFrame);
      const marginRight = parseFloat(frameStyles.marginRight) || 0;
      const marginBottom = parseFloat(frameStyles.marginBottom) || 0;
      const availableWidth = Math.max(0, app.playStage.clientWidth - marginRight);
      const availableHeight = Math.max(0, app.playStage.clientHeight - marginBottom);
      const boardSize = Math.floor(Math.min(availableWidth, availableHeight));

      if (!Number.isFinite(boardSize) || boardSize <= 0) {
        return;
      }

      app.mazeFrame.style.width = `${boardSize}px`;
      app.mazeFrame.style.height = `${boardSize}px`;
      const shellWidth = app.playShell.clientWidth || app.playStage.clientWidth;
      const controlWidth = Math.max(boardSize + marginRight, app.playStage.clientWidth);
      app.playHeader.style.width = `${Math.min(shellWidth, controlWidth)}px`;
    }

    function preloadImages() {
      return Promise.all([
        ...Array.from(app.imageUrls).map((url) => preloadImageUrl(url)),
        ...Array.from(app.modelUrls).map((url) => preloadModelUrl(url))
      ]);
    }

    Object.assign(app, {
      clamp,
      usesScrollingViewport,
      cameraFocusPoint,
      syncCameraTarget,
      advanceCamera,
      startCameraFollowLoop,
      renderOncePerFrame,
      invalidateTerrainFeatureIndex,
      syncLiveRaisedSurfaces,
      parseWorldLevelId,
      worldLevelId,
      adjacentWorldLevelId,
      prepareLevelRenderState,
      rememberHorizontalNeighborLevelState,
      cachedHorizontalNeighborLevelState,
      loadHorizontalNeighborLevelState,
      queueHorizontalNeighborLevelState,
      syncHorizontalNeighborLevelStates,
      createRuntimeActor,
      rememberCanonicalLevelPlayerStart,
      canonicalLevelPlayerStart,
      gemCollectionId,
      applyCollectedGemVisual,
      hideCollectedGemVisual,
      clearCollectedGemVisual,
      hideCollectedGemsAtPlayers,
      applyCollectedGemProgressToActors,
      recordCollectedGemsFromMoves,
      resetCollectionProgress,
      syncResetProgressButton,
      registerImageUrl,
      registerTerrainImageUrls,
      registerActorImageUrls,
      updateBoardMetrics,
      createShader,
      createProgram,
      initializeRenderer,
      posKey,
      cloneActorPositions,
      cloneActorState,
      cloneActorStateList,
      cloneTerrainCell,
      cloneTerrainState,
      preloadImageUrl,
      preloadImagesForLevelState,
      restoreTerrainState,
      syncDocumentLevelState,
      cloneLevelSnapshot,
      applyLevelState,
      loadLevelState,
      restoreActorPositions,
      buildOccupiedSet,
      actorsAt,
      actorAt,
      pushEntityKey,
      isMainPlayerActorType,
      isMainPlayerActor,
      isPlayerActorType,
      isPlayerActor,
      actorElevation,
      actorRenderElevation,
      isCollectibleActor,
      pushWeight,
      isPushableActor,
      pushActorMembers,
      weightlessGroupMembers,
      weightlessGroupRenderState,
      isWeightlessBoxAt,
      isInsideBoard,
      terrainAt,
      terrainLayersAt,
      terrainLayersOfType,
      terrainLayerSurfaceHeight,
      terrainSurfaceHeightsAt,
      groundSurfaceCell,
      isPlayerGate,
      isPlayerLift,
      isOrangeWall,
      isOrangeButton,
      eachOrangeWall,
      isOrangeButtonPressed,
      areOrangeButtonsPressed,
      computeRaisedOrangeWallSet,
      setRaisedOrangeWallState,
      isRaisedOrangeWall,
      eachPlayerLift,
      isRaisedPlayerLift,
      setPlayerLiftRaised,
      togglePlayerLiftAt,
      terrainSurfaceHeightAt,
      hasElevatedActorSurfaceAt,
      playerSurfaceHeightAt,
      computeRaisedPlayerGateSet,
      eachPlayerGate,
      isRaisedPlayerGate,
      isTerrainWall,
      terrainCellAcrossHorizontalWorldEdge,
      isTerrainWallAcrossHorizontalWorldEdge,
      isWall,
      elevatedBlockFamiliesAt,
      sharedElevatedBlockFamilies,
      sharedElevatedBlockFamily,
      elevatedSideBleedCoverFamily,
      isIce,
      isHole,
      isIceOrHole,
      isGroundCell,
      hasVisibleFloatingFloorActors,
      floatingFloorHoverOffset,
      easeOutBack,
      easeInOutQuad,
      gateAnimationValue,
      gateLiftAt,
      attachedGateLiftAt,
      orangeWallLiftAt,
      startOrangeWallAnimationLoop,
      syncOrangeWallAnimationTargets,
      playerLiftAt,
      startGateAnimationLoop,
      syncGateAnimationTargets,
      startPlayerLiftAnimationLoop,
      syncPlayerLiftAnimationTargets,
      initializeActorElevations,
      syncFuzzyToggle,
      syncEdgeToggle,
      syncNoiseTicker,
      syncFloatingFloorTicker,
      setupCanvas,
      syncPlayLayout,
      preloadImages
    });

    rememberCanonicalLevelPlayerStart(playData);
    initializeActorElevations();
    setRaisedOrangeWallState(computeRaisedOrangeWallSet());
    syncDocumentLevelState();
    rememberHorizontalNeighborLevelState(playData);
    syncHorizontalNeighborLevelStates();
    syncCameraTarget(true);
    syncResetProgressButton();
    app.initialPositions = cloneActorPositions();
    app.initialTerrain = cloneTerrainState(app.state.terrain);
    app.levelEntrySnapshot = cloneLevelSnapshot();
    app.renderer = app.gl ? initializeRenderer(app.gl) : null;

    // Debug handle: lets DevTools (and headless checks) inspect the live
    // runtime state without reaching into module closures.
    if (typeof window !== "undefined") {
      window.__MAZEBENCH_APP__ = app;
    }

    return app;
  };
})();
