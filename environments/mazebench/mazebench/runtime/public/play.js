(function () {
  const playData = window.__PLAY_DATA__;
  const canvas = document.getElementById("maze-canvas");
  const modules = window.PlayModules || {};

  if (
    !playData ||
    !canvas ||
    typeof modules.createPlayCore !== "function" ||
    typeof modules.registerRenderFunctions !== "function" ||
    typeof modules.registerGameplayFunctions !== "function"
  ) {
    return;
  }

  function ensureEdgeToggle() {
    const existing = document.getElementById("edge-toggle");

    if (existing) {
      return existing;
    }

    const fuzzyToggle = document.getElementById("fuzzy-toggle");

    if (!fuzzyToggle || !fuzzyToggle.parentNode) {
      return null;
    }

    const edgeToggle = document.createElement("button");
    edgeToggle.id = "edge-toggle";
    edgeToggle.className = "effect-toggle is-active";
    edgeToggle.type = "button";
    edgeToggle.setAttribute("aria-pressed", "true");
    edgeToggle.setAttribute("aria-label", "Black edges");
    edgeToggle.title = "Black edges";
    edgeToggle.innerHTML = [
      '<span class="effect-icon effect-icon--edges" aria-hidden="true"></span>',
      '<span class="effect-toggle-track" aria-hidden="true">',
      '<span class="effect-toggle-thumb"></span>',
      "</span>"
    ].join("");
    fuzzyToggle.parentNode.insertBefore(edgeToggle, fuzzyToggle);
    return edgeToggle;
  }

  function ensureResetProgressButton() {
    const existing = document.getElementById("reset-progress");

    if (existing) {
      existing.disabled = false;
      return existing;
    }

    const headerMeta = document.querySelector(".play-header-meta");

    if (!headerMeta) {
      return null;
    }

    const resetProgressButton = document.createElement("button");
    resetProgressButton.id = "reset-progress";
    resetProgressButton.className = "progress-reset-button";
    resetProgressButton.type = "button";
    resetProgressButton.textContent = "Reset Progress";
    resetProgressButton.title = "Reset collected gems";

    const cameraModeToggle = document.getElementById("camera-mode-toggle");
    headerMeta.insertBefore(resetProgressButton, cameraModeToggle || headerMeta.firstChild);
    return resetProgressButton;
  }

  const edgeToggle = ensureEdgeToggle();
  const resetProgressButton = ensureResetProgressButton();
  // MazeJam's play shell is full-bleed. Keep the canonical local player on
  // that same layout path so the HUD and d-pads frame the room instead of
  // shrinking the game into the legacy square canvas.
  playData.hostFullBleedView = true;
  playData.autoUndoPlayerFalls = true;
  const app = modules.createPlayCore({
    playData,
    canvas,
    playShell: document.querySelector(".play-shell"),
    playHeader: document.querySelector(".play-header"),
    playStage: document.querySelector(".play-stage"),
    mazeFrame: document.querySelector(".maze-frame"),
    fuzzyToggle: document.getElementById("fuzzy-toggle"),
    edgeToggle,
    cameraModeToggle: document.getElementById("camera-mode-toggle"),
    resetProgressButton,
    enableCameraControls: false
  });

  if (!app) {
    return;
  }

  function syncPlayCameraDownshift() {
    // MazeJam owns and sizes its play HUD separately. This compensation is
    // only for MazeBench's direct play shell, whose full-height canvas begins
    // below the site bar and is therefore clipped by that bar's height at the
    // bottom of the viewport.
    if (playData.hostOwnsPlayHud === true) {
      app.playCameraDownshiftPx = 0;
      return;
    }

    const shellRect = app.playShell?.getBoundingClientRect();
    const visualViewport = window.visualViewport;
    const viewportBottom = visualViewport
      ? (Number(visualViewport.offsetTop) || 0) + visualViewport.height
      : window.innerHeight;
    const clippedBottom = shellRect
      ? Math.max(0, shellRect.bottom - viewportBottom)
      : 0;

    // Moving the camera down by half the clipped band moves the room up to
    // the center of the actually visible play area without changing its fit.
    app.playCameraDownshiftPx = clippedBottom / 2;
  }

  // Play renders the whole world around the current room by default;
  // ?view=<n> limits it to n rings of neighboring rooms (?view=1 restores
  // the classic 3x3 neighborhood).
  const viewParam = new URLSearchParams(window.location.search).get("view");
  const viewRings = Number(viewParam);

  if (viewParam === "world" || viewParam === null || !Number.isFinite(viewRings)) {
    app.playSurroundingRadius = 26;
  } else {
    app.playSurroundingRadius = Math.max(1, Math.min(26, Math.floor(viewRings)));
  }

  const worldSolverRequested = new URLSearchParams(window.location.search).get("world_solver") === "1";
  if (window.__PIXEL_GAME_DEBUG__ === true || worldSolverRequested) {
    window.__PIXEL_GAME_APP__ = app;
  }

  modules.registerRenderFunctions(app);
  modules.registerGameplayFunctions(app);
  const playWorldData = window.__PLAY_WORLD_DATA__;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  const shouldRunWorldBoot =
    !reducedMotion &&
    window.__PIXEL_GAME_REPLAY_CAPTURE__ !== true &&
    Array.isArray(playWorldData?.existingLevels) &&
    playWorldData.existingLevels.length > 0 &&
    typeof window.AuthorPlayData?.createAdapter === "function";
  let playBootComplete = !shouldRunWorldBoot;
  let inputBound = false;
  let worldMapCloseTimer = 0;
  let worldMapSwitching = false;
  let worldSolverController = null;
  const visitedPlayRoomIds = new Set();

  // The controls synchronize overlay/input state immediately, so every piece
  // of state they read must exist before installation begins.
  installPlayControls();

  if (shouldRunWorldBoot) {
    // Match MazeJam's opening vista before any visible frame: near-black
    // blocks, blue vector edges, the entire world detached from the room,
    // then a dive into normal play colors.
    app.deferNeighborLoadRenders = true;
    app.homeVectorTheme = true;
    app.vectorGlowAmount = 1;
    app.worldViewConsolidate = true;
    app.worldViewUniformBrightness = true;
    app.worldViewVistaMode = true;
    app.worldViewDetachedVista = true;
    app.worldViewSynchronousBuild = true;
    document.getElementById("game-root")?.classList.add("is-overview");
  }

  function sleepMs(duration) {
    return new Promise((resolve) => window.setTimeout(resolve, duration));
  }

  function revealPlayFrame() {
    document.getElementById("game-root")?.classList.remove("is-loading");
    app.mazeFrame?.classList.remove("is-loading");
  }

  function startWorldSolver() {
    if (
      worldSolverController ||
      !worldSolverRequested ||
      !playWorldData ||
      typeof window.WorldSolver?.createController !== "function"
    ) return;
    app.resetCollectionProgress?.();
    worldSolverController = window.WorldSolver.createController({
      app,
      levels: playWorldData.existingLevels,
      startLevelId: playWorldData.defaultLevelId || playData.levelId,
      moveDirection(label) {
        const direction = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] }[label];
        if (!direction || typeof app.movePlayers !== "function") return false;
        app.movePlayers(direction[0], direction[1]);
        return true;
      },
      gotoLevel: switchPlayWorldLevel,
      onExit() {
        window.location.assign(
          "/author/" + encodeURIComponent(playData.gameId) + "/" + encodeURIComponent(app.currentLevelId)
        );
      }
    });
    worldSolverController.start();
  }

  function bindInput() {
    if (inputBound) return;
    inputBound = true;
    window.addEventListener("keydown", app.handleKeydown);
    window.addEventListener("keyup", app.handleKeyup);
    window.addEventListener("wheel", app.preventScroll, { passive: false });
  }

  function syncPlayHud() {
    // Hosted shells can restore a persisted room total that is broader than
    // this runtime instance's session-local room set. In that case the host
    // is the single HUD writer; otherwise this 200ms sync would make the
    // counter bounce between the persisted total and 1.
    if (playData.hostOwnsPlayHud === true) return;
    const roomTarget = document.getElementById("play-hud-rooms");
    const gemTarget = document.getElementById("play-hud-gems");
    const currentLevelId = String(app.currentLevelId || playData.levelId || "");
    if (currentLevelId) visitedPlayRoomIds.add(currentLevelId);
    const roomCount = Math.max(currentLevelId ? 1 : 0, visitedPlayRoomIds.size);
    const gemCount = app.collectedGemIds instanceof Set ? app.collectedGemIds.size : 0;

    if (roomTarget) {
      roomTarget.querySelector("[data-play-hud-value]").textContent = String(roomCount);
      roomTarget.setAttribute("aria-label", `${roomCount} room${roomCount === 1 ? "" : "s"} visited`);
    }
    if (gemTarget) {
      gemTarget.querySelector("[data-play-hud-value]").textContent = String(gemCount);
      gemTarget.setAttribute("aria-label", `${gemCount} gem${gemCount === 1 ? "" : "s"} collected`);
    }
  }

  function setControlsOverlayOpen(open) {
    const overlay = document.getElementById("controls-settings-overlay");
    if (!overlay) return;

    if (open) {
      overlay.hidden = false;
      window.requestAnimationFrame(() => overlay.classList.add("is-open"));
      syncPlayOverlayInputLock();
      return;
    }

    overlay.classList.remove("is-open");
    overlay.classList.add("is-closing");
    window.setTimeout(() => {
      overlay.classList.remove("is-closing");
      overlay.hidden = true;
      syncPlayOverlayInputLock();
    }, 180);
    syncPlayOverlayInputLock();
  }

  function runMoveControl(direction, inputSource = "") {
    const vectors = {
      up: [0, -1],
      down: [0, 1],
      left: [-1, 0],
      right: [1, 0]
    };
    const raw = vectors[direction];
    if (!raw || typeof app.movePlayers !== "function") return;
    const mapped = typeof app.mapCameraRelativeDirection === "function"
      ? app.mapCameraRelativeDirection(raw[0], raw[1])
      : raw;
    app.movePlayers(mapped[0], mapped[1], { inputSource });
  }

  let playCameraYaw = 0;
  let playCameraTilt = 0.22;
  let cameraTiltDirection = 0;
  let cameraTiltVelocity = 0;
  let cameraMotionFrame = 0;
  let cameraMotionLastMs = 0;
  let cameraYawAnimation = null;
  const heldCameraKeys = new Map();
  const cameraTiltMaxSpeed = Math.PI * 0.72;
  const cameraTiltAcceleration = Math.PI * 3.4;
  const cameraTiltDeceleration = Math.PI * 4.2;
  const cameraYawDurationMs = 400;

  function cameraInputLocked() {
    return (
      !playBootComplete ||
      document.getElementById("world-map-overlay")?.hidden === false ||
      document.getElementById("controls-settings-overlay")?.hidden === false
    );
  }

  function clampCameraTilt(value) {
    return Math.max(0, Math.min(Math.PI / 2, value));
  }

  function easeToward(current, target, maxDelta) {
    if (current < target) return Math.min(target, current + maxDelta);
    if (current > target) return Math.max(target, current - maxDelta);
    return current;
  }

  function easeInOutQuad(progress) {
    const value = Math.max(0, Math.min(1, progress));
    return value < 0.5
      ? 2 * value * value
      : 1 - Math.pow(-2 * value + 2, 2) / 2;
  }

  function syncPlayCameraFromRenderer() {
    const renderer = app.threeRenderer;
    if (!renderer) return;
    if (!cameraYawAnimation && typeof renderer.getDebugCameraYaw === "function") {
      const yaw = renderer.getDebugCameraYaw();
      if (Number.isFinite(yaw)) playCameraYaw = yaw;
    }
    if (!cameraTiltDirection && typeof renderer.getDebugCameraTilt === "function") {
      const tilt = renderer.getDebugCameraTilt();
      if (Number.isFinite(tilt)) playCameraTilt = tilt;
    }
  }

  function applyPlayCameraView(now = performance.now()) {
    const renderer = app.threeRenderer;
    if (!renderer || typeof renderer.setDebugCameraView !== "function") return false;
    renderer.setDebugCameraView({
      yaw: playCameraYaw,
      tilt: playCameraTilt,
      preserveSceneCache: true,
      skipRender: true,
      skipResize: true
    });
    // Camera and movement use separate render channels so one animation can
    // never suppress the other's update during the same display frame.
    (app.renderOncePerFrame || app.render)?.(now, "camera");
    return true;
  }

  function scheduleCameraMotionFrame() {
    if (cameraMotionFrame) return;
    cameraMotionFrame = window.requestAnimationFrame(stepCameraMotion);
  }

  function stepCameraMotion(now) {
    cameraMotionFrame = 0;
    const deltaSeconds = cameraMotionLastMs
      ? Math.min(0.05, Math.max(0, (now - cameraMotionLastMs) / 1000))
      : 1 / 60;
    cameraMotionLastMs = now;
    let changed = false;
    let shouldContinue = false;

    if (cameraYawAnimation) {
      const progress = Math.max(
        0,
        Math.min(1, (now - cameraYawAnimation.startMs) / cameraYawAnimation.durationMs)
      );
      const eased = easeInOutQuad(progress);
      playCameraYaw =
        cameraYawAnimation.startYaw +
        (cameraYawAnimation.targetYaw - cameraYawAnimation.startYaw) * eased;
      changed = true;
      if (progress >= 1) {
        playCameraYaw = cameraYawAnimation.targetYaw;
        cameraYawAnimation = null;
      } else {
        shouldContinue = true;
      }
    }

    if (cameraTiltDirection || cameraTiltVelocity) {
      const targetVelocity = cameraTiltDirection * cameraTiltMaxSpeed;
      const acceleration = cameraTiltDirection ? cameraTiltAcceleration : cameraTiltDeceleration;
      cameraTiltVelocity = easeToward(
        cameraTiltVelocity,
        targetVelocity,
        acceleration * deltaSeconds
      );
      if (!cameraTiltDirection && Math.abs(cameraTiltVelocity) < 0.002) {
        cameraTiltVelocity = 0;
      }
      const previousTilt = playCameraTilt;
      playCameraTilt = clampCameraTilt(playCameraTilt + cameraTiltVelocity * deltaSeconds);
      if (playCameraTilt === previousTilt && cameraTiltVelocity !== 0) {
        cameraTiltVelocity = 0;
      }
      changed = true;
      shouldContinue = shouldContinue || Boolean(cameraTiltDirection || cameraTiltVelocity);
    }

    if (changed) applyPlayCameraView(now);
    if (shouldContinue) scheduleCameraMotionFrame();
    else cameraMotionLastMs = 0;
  }

  function startCameraTiltHold(direction) {
    const nextDirection = direction === "up" ? -1 : direction === "down" ? 1 : 0;
    if (!nextDirection || cameraInputLocked()) return;
    syncPlayCameraFromRenderer();
    cameraTiltDirection = nextDirection;
    cameraMotionLastMs = 0;
    scheduleCameraMotionFrame();
  }

  function stopCameraTiltHold() {
    cameraTiltDirection = 0;
    if (cameraTiltVelocity) scheduleCameraMotionFrame();
  }

  function runCameraControl(direction) {
    if (cameraInputLocked()) return;
    if (direction === "up" || direction === "down") {
      startCameraTiltHold(direction);
      return;
    }
    syncPlayCameraFromRenderer();
    const targetYaw = cameraYawAnimation?.targetYaw ?? playCameraYaw;
    const yawStep = Math.PI / 2;
    cameraYawAnimation = {
      durationMs: cameraYawDurationMs,
      startMs: performance.now(),
      startYaw: playCameraYaw,
      targetYaw: targetYaw + (direction === "left" ? -yawStep : direction === "right" ? yawStep : 0)
    };
    if (cameraYawAnimation.targetYaw === targetYaw) {
      cameraYawAnimation = null;
      return;
    }
    scheduleCameraMotionFrame();
  }

  function syncPlayOverlayInputLock() {
    window.__MAZEBENCH_INPUT_LOCKED__ =
      worldMapSwitching ||
      document.getElementById("world-map-overlay")?.hidden === false ||
      document.getElementById("controls-settings-overlay")?.hidden === false;
  }

  function worldMapCells() {
    const columns = Array.isArray(playWorldData?.worldColumns) ? playWorldData.worldColumns : [];
    const rows = Array.isArray(playWorldData?.worldRows) ? playWorldData.worldRows : [];

    return (playWorldData?.existingLevels || [])
      .map((level) => {
        const match = String(level.id || "").match(/^level_(.+)x(.+)$/);
        if (!match) return null;
        const columnIndex = columns.indexOf(match[1]);
        const rowIndex = rows.indexOf(match[2]);
        if (columnIndex < 0 || rowIndex < 0) return null;
        return { ...level, columnIndex, rowIndex };
      })
      .filter(Boolean)
      .sort((left, right) => left.rowIndex - right.rowIndex || left.columnIndex - right.columnIndex);
  }

  function fittedWorldMapTileSize(columnCount, rowCount) {
    const overlay = document.getElementById("world-map-overlay");
    const panel = overlay?.querySelector(".world-map-panel");
    const bar = overlay?.querySelector(".world-map-bar");
    const stage = overlay?.querySelector(".world-map-stage");
    const overlayRect = overlay?.getBoundingClientRect();
    const overlayStyle = overlay ? window.getComputedStyle(overlay) : null;
    const panelStyle = panel ? window.getComputedStyle(panel) : null;
    const stageStyle = stage ? window.getComputedStyle(stage) : null;
    const horizontalOverlayPadding =
      (parseFloat(overlayStyle?.paddingLeft) || 0) + (parseFloat(overlayStyle?.paddingRight) || 0);
    const verticalOverlayPadding =
      (parseFloat(overlayStyle?.paddingTop) || 0) + (parseFloat(overlayStyle?.paddingBottom) || 0);
    const horizontalStagePadding =
      (parseFloat(stageStyle?.paddingLeft) || 0) + (parseFloat(stageStyle?.paddingRight) || 0);
    const verticalStagePadding =
      (parseFloat(stageStyle?.paddingTop) || 0) + (parseFloat(stageStyle?.paddingBottom) || 0);
    const panelGap = parseFloat(panelStyle?.rowGap) || 0;
    const viewportWidth = overlayRect?.width || window.innerWidth || document.documentElement.clientWidth || 820;
    const viewportHeight = overlayRect?.height || window.innerHeight || document.documentElement.clientHeight || 700;
    const availableWidth = Math.max(0, Math.min(820, viewportWidth - horizontalOverlayPadding) - horizontalStagePadding);
    const availableHeight = Math.max(
      0,
      viewportHeight - verticalOverlayPadding - (bar?.getBoundingClientRect().height || 44) - panelGap - verticalStagePadding
    );

    return Math.max(
      1,
      Math.floor(Math.min(82, availableWidth / Math.max(1, columnCount), availableHeight / Math.max(1, rowCount))) || 1
    );
  }

  function worldMapOutlinePath(occupied, tileSize) {
    const edges = new Map();
    const addEdge = (fromX, fromY, toX, toY) => {
      const key = fromX + "," + fromY;
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push([toX, toY]);
    };

    for (const key of occupied) {
      const [column, row] = key.split(",").map(Number);
      if (!occupied.has(column + "," + (row - 1))) addEdge(column + 1, row, column, row);
      if (!occupied.has(column + "," + (row + 1))) addEdge(column, row + 1, column + 1, row + 1);
      if (!occupied.has(column - 1 + "," + row)) addEdge(column, row, column, row + 1);
      if (!occupied.has(column + 1 + "," + row)) addEdge(column + 1, row + 1, column + 1, row);
    }

    const parts = [];
    for (const [startKey, targets] of edges) {
      while (targets.length) {
        const [startX, startY] = startKey.split(",").map(Number);
        let [x, y] = targets.pop();
        let previousX = startX;
        let previousY = startY;
        const points = [[startX, startY], [x, y]];

        while (x !== startX || y !== startY) {
          const nextTargets = edges.get(x + "," + y);
          if (!nextTargets?.length) break;
          let targetIndex = 0;
          if (nextTargets.length > 1) {
            const dx = x - previousX;
            const dy = y - previousY;
            let bestTurn = Infinity;
            nextTargets.forEach(([nextX, nextY], index) => {
              const turn = dx * (nextY - y) - dy * (nextX - x);
              if (turn < bestTurn) {
                bestTurn = turn;
                targetIndex = index;
              }
            });
          }
          const [nextX, nextY] = nextTargets.splice(targetIndex, 1)[0];
          previousX = x;
          previousY = y;
          x = nextX;
          y = nextY;
          points.push([x, y]);
        }

        points.pop();
        const corners = points.filter((point, index) => {
          const before = points[(index + points.length - 1) % points.length];
          const after = points[(index + 1) % points.length];
          return (before[0] === point[0]) !== (point[0] === after[0]);
        });
        if (corners.length >= 4) {
          parts.push(
            "M" +
              corners.map(([cornerX, cornerY]) => cornerX * tileSize + " " + cornerY * tileSize).join(" L") +
              " Z"
          );
        }
      }
    }
    return parts.join(" ");
  }

  function renderPlayWorldMap() {
    const grid = document.getElementById("world-map-grid");
    const backdrop = document.getElementById("world-map-backdrop");
    const cells = worldMapCells();
    if (!grid || !backdrop || cells.length === 0) return;
    const minColumn = Math.min(...cells.map((cell) => cell.columnIndex));
    const maxColumn = Math.max(...cells.map((cell) => cell.columnIndex));
    const minRow = Math.min(...cells.map((cell) => cell.rowIndex));
    const maxRow = Math.max(...cells.map((cell) => cell.rowIndex));
    const columnCount = maxColumn - minColumn + 1;
    const rowCount = maxRow - minRow + 1;
    const tileSize = fittedWorldMapTileSize(columnCount, rowCount);
    const occupied = new Set(
      cells.map((cell) => cell.columnIndex - minColumn + "," + (cell.rowIndex - minRow))
    );

    grid.style.setProperty("--world-map-columns", String(columnCount));
    grid.style.setProperty("--world-map-tile-size", tileSize + "px");
    grid.replaceChildren();
    backdrop.setAttribute("viewBox", "0 0 " + columnCount * tileSize + " " + rowCount * tileSize);
    backdrop.setAttribute("width", String(columnCount * tileSize));
    backdrop.setAttribute("height", String(rowCount * tileSize));
    backdrop.innerHTML = '<path fill-rule="evenodd" d="' + worldMapOutlinePath(occupied, tileSize) + '"></path>';

    cells.forEach((cell) => {
      const button = document.createElement("button");
      button.className = "world-map-cell";
      button.type = "button";
      button.dataset.levelId = cell.id;
      button.style.gridColumn = String(cell.columnIndex - minColumn + 1);
      button.style.gridRow = String(cell.rowIndex - minRow + 1);
      button.title = cell.label || cell.id.replace("level_", "");
      button.setAttribute("aria-label", button.title);
      if (cell.previewUrl) {
        const image = document.createElement("img");
        image.alt = "";
        image.className = "world-map-thumb";
        image.decoding = "async";
        image.loading = "lazy";
        image.src = cell.previewUrl;
        image.addEventListener("error", () => {
          image.remove();
          const label = document.createElement("span");
          label.className = "world-map-cell-label";
          label.textContent = cell.label || cell.id.replace("level_", "");
          button.append(label);
        }, { once: true });
        button.append(image);
      } else {
        const label = document.createElement("span");
        label.className = "world-map-cell-label";
        label.textContent = cell.label || cell.id.replace("level_", "");
        button.append(label);
      }
      if (cell.id === app.currentLevelId) button.classList.add("is-current");
      grid.append(button);
    });
  }

  function setWorldMapOpen(open) {
    const overlay = document.getElementById("world-map-overlay");
    const button = document.querySelector('[data-action="world-map"]');
    if (!overlay) return;
    window.clearTimeout(worldMapCloseTimer);
    if (open) {
      overlay.hidden = false;
      // Measure only after the overlay participates in layout so the entire
      // world can be fitted to the real viewport, including compact screens.
      renderPlayWorldMap();
      button?.setAttribute("aria-expanded", "true");
      window.requestAnimationFrame(() => {
        overlay.classList.remove("is-closing");
        overlay.classList.add("is-open");
        overlay.querySelector("[data-world-map-close]")?.focus({ preventScroll: true });
      });
      syncPlayOverlayInputLock();
      return;
    }
    overlay.classList.remove("is-open");
    overlay.classList.add("is-closing");
    button?.setAttribute("aria-expanded", "false");
    worldMapCloseTimer = window.setTimeout(() => {
      overlay.hidden = true;
      overlay.classList.remove("is-closing");
      syncPlayOverlayInputLock();
    }, 180);
    button?.focus({ preventScroll: true });
    syncPlayOverlayInputLock();
  }

  function playWorldMapTransitionSnapshot() {
    const snapshot = typeof app.cloneLevelSnapshot === "function"
      ? app.cloneLevelSnapshot()
      : {
          actors: (app.state.actors || []).map((actor) => ({ ...actor })),
          height: app.state.height,
          levelId: app.currentLevelId,
          terrain: app.state.terrain,
          width: app.state.width
        };
    const raisedPlayerGates = typeof app.computeRaisedPlayerGateSet === "function"
      ? Array.from(app.computeRaisedPlayerGateSet())
      : [];
    const raisedOrangeWalls = typeof app.computeRaisedOrangeWallSet === "function"
      ? Array.from(app.computeRaisedOrangeWallSet())
      : [];
    return { ...snapshot, raisedPlayerGates, raisedOrangeWalls };
  }

  function playWorldMapResetSnapshot(outgoingLevel) {
    if (!app.levelEntrySnapshot || typeof app.prepareLevelRenderState !== "function") {
      return outgoingLevel;
    }

    return app.prepareLevelRenderState(app.levelEntrySnapshot) || outgoingLevel;
  }

  function finishPlayWorldMapSwitch(levelId) {
    const editLink = document.querySelector("[data-play-author-link]");
    if (editLink && playWorldData?.game?.id) {
      editLink.href =
        "/author/" + encodeURIComponent(playWorldData.game.id) + "/" + encodeURIComponent(levelId);
    }
    syncPlayHud();
  }

  async function switchPlayWorldLevel(levelId, options = {}) {
    if (!levelId || worldMapSwitching) return;
    if (levelId === app.currentLevelId && options.reloadCurrent !== true) {
      setWorldMapOpen(false);
      return;
    }
    worldMapSwitching = true;
    setWorldMapOpen(false);
    syncPlayOverlayInputLock();
    try {
      const cells = worldMapCells();
      const outgoingCell = cells.find((cell) => cell.id === app.currentLevelId);
      const incomingCell = cells.find((cell) => cell.id === levelId);
      const dx = incomingCell && outgoingCell
        ? incomingCell.columnIndex - outgoingCell.columnIndex
        : 0;
      const dy = incomingCell && outgoingCell
        ? incomingCell.rowIndex - outgoingCell.rowIndex
        : 0;
      const canAnimate =
        (dx !== 0 || dy !== 0) &&
        typeof app.applyLevelState === "function" &&
        typeof app.renderCompositor?.startLevelTransition === "function";
      const outgoingLevel = canAnimate ? playWorldMapTransitionSnapshot() : null;
      const outgoingResetLevel = canAnimate ? playWorldMapResetSnapshot(outgoingLevel) : null;

      if (outgoingResetLevel && outgoingResetLevel !== outgoingLevel) {
        app.rememberHorizontalNeighborLevelState?.(outgoingResetLevel);
      }

      const levelState = await app.loadLevelState(levelId);
      app.applyLevelState(levelState, {
        deferRender: canAnimate,
        immediateCamera: true,
        resetHistory: true,
        resetLevelEntry: true,
        updateUrl: true
      });

      if (!canAnimate) {
        finishPlayWorldMapSwitch(levelId);
        return;
      }

      await Promise.resolve(app.preloadImagesForLevelState?.(levelState)).catch(() => {});
      if (app.threeRendererReady && typeof app.threeRendererReady.then === "function") {
        await app.threeRendererReady.catch(() => {});
      }
      await Promise.resolve(app.threeRenderer?.whenLevelStateModelsReady?.(levelState)).catch(() => {});
      const incomingLevel = playWorldMapTransitionSnapshot();
      const roomDistance = Math.hypot(dx, dy);
      const durationMs = Math.min(
        2600,
        (app.LEVEL_TRANSITION_DURATION_MS || 1000) + Math.max(0, roomDistance - 1) * 150
      );
      const transitionData = {
        kind: "adjacent-scene",
        dx,
        dy,
        outgoingLevel,
        outgoingResetLevel,
        incomingLevel,
        incomingRaisedPlayerGates: incomingLevel.raisedPlayerGates,
        incomingRaisedOrangeWalls: incomingLevel.raisedOrangeWalls
      };
      app.threeRenderer?.prewarmAdjacentLevelTransition?.(transitionData, durationMs);
      await new Promise((resolve) => {
        app.renderCompositor.startLevelTransition(null, null, dx, dy, null, null, null, {
          durationMs,
          renderImmediately: false,
          transitionData,
          onComplete: () => {
            finishPlayWorldMapSwitch(levelId);
            resolve();
          }
        });
        app.render();
      });
    } catch {
      if (playWorldData?.game?.id) {
        window.location.assign(
          "/play/" + encodeURIComponent(playWorldData.game.id) + "/" + encodeURIComponent(levelId)
        );
      }
    } finally {
      worldMapSwitching = false;
      syncPlayOverlayInputLock();
    }
  }

  // Replay export uses the same world-map navigation path as the interactive
  // game so valid goto actions retain the full room-to-room camera tween.
  app.switchPlayWorldLevel = switchPlayWorldLevel;

  function installPlayControls() {
    const controls = document.querySelector(".mazebench-controls");
    const controlsOverlay = document.getElementById("controls-settings-overlay");
    const worldMapOverlay = document.getElementById("world-map-overlay");
    let cameraPointerId = null;
    let cameraPointerButton = null;
    let movePointerId = null;
    let movePointerButton = null;
    let moveRepeatFrame = 0;
    let moveRepeatNextAtMs = 0;
    const moveRepeatDelayMs = 300;
    const moveRepeatIntervalMs = 100;
    if (!controls) return;

    function quadrantPadButtonAtPoint(pad, clientX, clientY) {
      if (!pad || !controls.contains(pad)) return null;
      const rect = pad.getBoundingClientRect();
      const radius = Math.min(rect.width, rect.height) * 0.56;
      const dx = clientX - (rect.left + rect.width / 2);
      const dy = clientY - (rect.top + rect.height / 2);
      if (Math.hypot(dx, dy) > radius) return null;

      const direction = Math.abs(dx) > Math.abs(dy)
        ? (dx < 0 ? "left" : "right")
        : (dy < 0 ? "up" : "down");
      const attribute = pad.dataset.quadrantPad === "camera" ? "data-camera" : "data-move";
      return pad.querySelector(`button[${attribute}="${direction}"]`);
    }

    function quadrantPadButtonForEvent(event) {
      const pad = event.target.closest?.("[data-quadrant-pad]");
      return quadrantPadButtonAtPoint(pad, event.clientX, event.clientY);
    }

    controls.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      event.preventDefault();
      if (button.dataset.move) {
        if (event.detail === 0) runMoveControl(button.dataset.move, "keyboard-button");
      } else if (button.dataset.camera) {
        if (event.detail === 0) {
          runCameraControl(button.dataset.camera);
          if (button.dataset.camera === "up" || button.dataset.camera === "down") {
            window.setTimeout(stopCameraTiltHold, 150);
          }
        }
      } else if (button.dataset.action === "undo") {
        app.undoMove?.();
      } else if (button.dataset.action === "reset") {
        app.resetPositions?.();
      } else if (button.dataset.action === "controls") {
        setControlsOverlayOpen(true);
      } else if (button.dataset.action === "world-map") {
        setWorldMapOpen(true);
      }
      button.blur?.();
    });

    controls.addEventListener("pointerdown", (event) => {
      const padButton = quadrantPadButtonForEvent(event);
      const moveButton = padButton?.dataset.move ? padButton : null;
      if (moveButton) {
        if (movePointerId !== null || cameraInputLocked()) return;
        event.preventDefault();
        movePointerId = event.pointerId;
        movePointerButton = moveButton;
        moveButton.classList.add("is-active");
        controls.setPointerCapture?.(event.pointerId);
        runMoveControl(moveButton.dataset.move, `pointer:${event.pointerId}`);
        moveRepeatNextAtMs = performance.now() + moveRepeatDelayMs;
        scheduleMoveRepeatFrame();
        return;
      }

      const button = padButton?.dataset.camera ? padButton : null;
      if (!button || cameraInputLocked() || cameraPointerId !== null) return;
      event.preventDefault();
      cameraPointerId = event.pointerId;
      cameraPointerButton = button;
      button.classList.add("is-active");
      controls.setPointerCapture?.(event.pointerId);
      runCameraControl(button.dataset.camera);
    });

    function scheduleMoveRepeatFrame() {
      if (moveRepeatFrame) return;
      moveRepeatFrame = window.requestAnimationFrame(stepMoveRepeat);
    }

    function stepMoveRepeat(now) {
      moveRepeatFrame = 0;
      if (movePointerId === null || !movePointerButton) return;
      if (now >= moveRepeatNextAtMs) {
        runMoveControl(movePointerButton.dataset.move, `pointer:${movePointerId}`);
        moveRepeatNextAtMs = now + moveRepeatIntervalMs;
      }
      scheduleMoveRepeatFrame();
    }

    function releaseMovePointer(event) {
      if (movePointerId === null || (event && event.pointerId !== movePointerId)) return;
      const inputSource = `pointer:${movePointerId}`;
      if (moveRepeatFrame) window.cancelAnimationFrame(moveRepeatFrame);
      moveRepeatFrame = 0;
      app.cancelQueuedAction?.(inputSource);
      movePointerButton?.classList.remove("is-active");
      if (controls.hasPointerCapture?.(movePointerId)) {
        controls.releasePointerCapture?.(movePointerId);
      }
      movePointerButton?.blur?.();
      movePointerButton = null;
      movePointerId = null;
      moveRepeatNextAtMs = 0;
    }

    function releaseCameraPointer(event) {
      if (cameraPointerId === null || (event && event.pointerId !== cameraPointerId)) return;
      const direction = cameraPointerButton?.dataset.camera;
      if (direction === "up" || direction === "down") stopCameraTiltHold();
      cameraPointerButton?.classList.remove("is-active");
      if (controls.hasPointerCapture?.(cameraPointerId)) {
        controls.releasePointerCapture?.(cameraPointerId);
      }
      cameraPointerButton?.blur?.();
      cameraPointerButton = null;
      cameraPointerId = null;
    }

    ["pointerup", "pointercancel", "pointerleave"].forEach((type) => {
      controls.addEventListener(type, (event) => {
        releaseMovePointer(event);
        releaseCameraPointer(event);
      });
    });
    ["pointerup", "pointercancel"].forEach((type) => {
      window.addEventListener(type, (event) => {
        releaseMovePointer(event);
        releaseCameraPointer(event);
      });
    });

    controlsOverlay?.addEventListener("click", (event) => {
      if (event.target === controlsOverlay || event.target.closest("[data-controls-close]")) {
        setControlsOverlayOpen(false);
      }
    });

    worldMapOverlay?.addEventListener("click", (event) => {
      const levelButton = event.target.closest(".world-map-cell[data-level-id]");
      if (levelButton) {
        // MazeJam installs its own save-aware world-map handler on this same
        // overlay. Let that handler receive the click without first changing
        // the canonical runtime room (which would erase its flight origin and
        // temporarily remove ?save= from the URL).
        if (app.hostOwnsWorldMapNavigation === true) return;
        switchPlayWorldLevel(levelButton.dataset.levelId).catch(() => {});
      } else if (event.target === worldMapOverlay || event.target.closest("[data-world-map-close]")) {
        setWorldMapOpen(false);
      }
    });

    function cameraDirectionForKey(event) {
      const configuredKeys = window.__MAZEBENCH_CONTROLS__?.keys;

      if (configuredKeys && typeof configuredKeys === "object") {
        const configuredCameraDirections = [
          ["cameraUp", "up"],
          ["cameraDown", "down"],
          ["cameraLeft", "left"],
          ["cameraRight", "right"]
        ];

        for (const [action, direction] of configuredCameraDirections) {
          if (Array.isArray(configuredKeys[action]) && configuredKeys[action].includes(event.code)) {
            return direction;
          }
        }
        return "";
      }

      if (event.code === "KeyW") return "up";
      if (event.code === "KeyS") return "down";
      if (event.code === "KeyA") return "left";
      if (event.code === "KeyD") return "right";
      return "";
    }

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && controlsOverlay?.hidden === false) {
        event.preventDefault();
        setControlsOverlayOpen(false);
        return;
      }
      if (event.key === "Escape" && worldMapOverlay?.hidden === false) {
        event.preventDefault();
        setWorldMapOpen(false);
        return;
      }
      const direction = cameraDirectionForKey(event);
      if (
        !direction ||
        cameraInputLocked() ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.target?.closest?.("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (heldCameraKeys.has(event.code)) return;
      heldCameraKeys.set(event.code, direction);
      controls.querySelector(`button[data-camera="${direction}"]`)?.classList.add("is-active");
      runCameraControl(direction);
    }, true);

    window.addEventListener("keyup", (event) => {
      const direction = heldCameraKeys.get(event.code);
      if (!direction) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      heldCameraKeys.delete(event.code);
      if (![...heldCameraKeys.values()].includes(direction)) {
        controls.querySelector(`button[data-camera="${direction}"]`)?.classList.remove("is-active");
      }
      if (direction === "up" || direction === "down") {
        const remainingTilt = [...heldCameraKeys.values()].reverse().find(
          (value) => value === "up" || value === "down"
        );
        if (remainingTilt) startCameraTiltHold(remainingTilt);
        else stopCameraTiltHold();
      }
    }, true);

    window.addEventListener("blur", () => {
      heldCameraKeys.clear();
      controls.querySelectorAll("button[data-camera].is-active").forEach((button) =>
        button.classList.remove("is-active")
      );
      releaseCameraPointer();
      stopCameraTiltHold();
    });
    window.addEventListener("resize", () => {
      if (worldMapOverlay?.hidden === false) renderPlayWorldMap();
    });
    syncPlayOverlayInputLock();
    syncPlayHud();
    window.setInterval(syncPlayHud, 200);
  }

  function primeWorldStates() {
    if (!shouldRunWorldBoot || typeof app.rememberHorizontalNeighborLevelState !== "function") {
      return [];
    }
    const adapter = window.AuthorPlayData.createAdapter(playWorldData);
    return playWorldData.existingLevels.flatMap((level) => {
      if (!Array.isArray(level.cells) || !level.cells.length) return [];
      const width = Number(level.width) || level.cells[0]?.length || 16;
      const height = Number(level.height) || level.cells.length || 16;
      const state = adapter.buildPlayData({
        cameraView: { width, height },
        cells: level.cells,
        gameId: playData.gameId,
        height,
        includeGems: true,
        levelId: level.id,
        levelLabel: level.label || level.id,
        playApiBaseUrl: playWorldData.playApiBaseUrl,
        width,
        worldColumns: playWorldData.worldColumns,
        worldRows: playWorldData.worldRows
      });
      app.rememberHorizontalNeighborLevelState(state);
      return [state];
    });
  }

  function finishWorldBoot(renderer) {
    app.cameraFlightFitOptions = null;
    app.deferNeighborLoadRenders = false;
    app.homeVectorTheme = false;
    app.vectorGlowAmount = 0;
    app.worldViewConsolidate = false;
    app.worldViewDetachedVista = false;
    app.worldViewSynchronousBuild = false;
    app.worldViewUniformBrightness = false;
    app.worldViewVistaMode = false;
    document.getElementById("game-root")?.classList.remove("is-overview");
    renderer?.setDebugCameraView?.({
      yaw: 0,
      tilt: 0.22,
      zoom: 1,
      mode: "perspective",
      skipRender: true
    });
    renderer?.invalidateSceneCache?.();
    playBootComplete = true;
    app.render();
    revealPlayFrame();
    bindInput();
    startWorldSolver();
  }

  function diveIntoRoom(renderer, onDone) {
    const unit = app.TILE_SIZE || 64;
    const roomWidth = Math.max(1, Number(playData.width) || 16) * unit;
    const roomHeight = Math.max(1, Number(playData.height) || 16) * unit;
    const renderScale = Math.max(1, Number(app.renderPixelScale) || 1);
    const sourceWidth = Math.max(1, Number(app.boardRect?.width) / renderScale || roomWidth);
    const sourceHeight = Math.max(1, Number(app.boardRect?.height) / renderScale || roomHeight);
    const sourceFit = {
      centerX: sourceWidth / 2,
      centerZ: sourceHeight / 2,
      maxX: sourceWidth,
      maxZ: sourceHeight,
      minX: 0,
      minZ: 0
    };
    const roomFit = {
      centerX: roomWidth / 2,
      centerZ: roomHeight / 2,
      maxX: roomWidth,
      maxZ: roomHeight,
      minX: 0,
      minZ: 0
    };
    const durationMs = 900;
    const startTilt = 1.3;
    const endTilt = 0.22;
    const lnStartZoom = Math.log(0.2);
    const lnEndZoom = Math.log(1);
    let animationElapsedMs = 0;
    let previousStepMs = 0;
    app.worldShadowFadeMs = 900;
    app.worldViewUniformBrightness = false;
    document.getElementById("game-root")?.classList.remove("is-overview");
    app.worldViewSynchronousBuild = false;
    app.worldViewConsolidate = false;
    app.deferNeighborLoadRenders = false;
    app.homeVectorTheme = false;
    renderer.cancelHomeEdgeReveal?.();

    app.cameraFlightFitOptions = sourceFit;
    renderer.invalidateSceneCache?.();
    app.render(performance.now());

    const step = (now) => {
      const deltaMs = previousStepMs > 0 ? Math.max(0, now - previousStepMs) : 0;
      previousStepMs = now;
      animationElapsedMs += Math.min(deltaMs, 50);
      const progress = Math.max(0, Math.min(1, animationElapsedMs / durationMs));
      const eased = 0.5 - Math.cos(Math.PI * progress) / 2;
      app.cameraFlightFitOptions = {
        centerX: sourceFit.centerX + (roomFit.centerX - sourceFit.centerX) * eased,
        centerZ: sourceFit.centerZ + (roomFit.centerZ - sourceFit.centerZ) * eased,
        maxX: sourceFit.maxX + (roomFit.maxX - sourceFit.maxX) * eased,
        maxZ: sourceFit.maxZ + (roomFit.maxZ - sourceFit.maxZ) * eased,
        minX: sourceFit.minX + (roomFit.minX - sourceFit.minX) * eased,
        minZ: sourceFit.minZ + (roomFit.minZ - sourceFit.minZ) * eased
      };
      renderer.setDebugCameraView({
        yaw: 0,
        tilt: startTilt + (endTilt - startTilt) * eased,
        zoom: Math.exp(lnStartZoom + (lnEndZoom - lnStartZoom) * eased),
        mode: "perspective",
        skipRender: true
      });
      app.vectorGlowAmount = 1 - eased;
      renderer.invalidateSceneCache?.();
      app.render(now);
      if (progress < 1) {
        window.requestAnimationFrame(step);
      } else {
        finishWorldBoot(renderer);
        onDone?.();
      }
    };
    window.requestAnimationFrame(() => window.requestAnimationFrame(step));
  }

  async function runWorldBoot() {
    try {
      if (app.threeRendererReady && typeof app.threeRendererReady.then === "function") {
        await app.threeRendererReady;
      }
      const renderer = app.threeRenderer;
      if (!renderer || typeof renderer.beginHomeEdgeReveal !== "function") {
        finishWorldBoot(renderer);
        return;
      }
      const primedStates = primeWorldStates();
      if (typeof renderer.whenLevelStateModelsReady === "function") {
        await Promise.race([
          Promise.all(
            primedStates.map((levelState) =>
              renderer.whenLevelStateModelsReady(levelState).catch(() => null)
            )
          ),
          sleepMs(6000)
        ]);
      }
      renderer.setDebugCameraView({
        yaw: 0,
        tilt: 1.3,
        zoom: 0.2,
        mode: "perspective",
        skipRender: true
      });
      renderer.primeHomeEdgeReveal?.();
      renderer.invalidateSceneCache?.();
      app.render();
      revealPlayFrame();
      renderer.beginHomeEdgeReveal({
        onComplete: () => diveIntoRoom(renderer)
      });
    } catch {
      finishWorldBoot(app.threeRenderer);
    }
  }

  if (app.gl) {
    app.canvas.addEventListener("webglcontextlost", function (event) {
      event.preventDefault();
      app.renderer = null;

      if (app.noiseFrameId !== null) {
        window.cancelAnimationFrame(app.noiseFrameId);
        app.noiseFrameId = null;
      }

      if (app.floatingFloorFrameId !== null) {
        window.cancelAnimationFrame(app.floatingFloorFrameId);
        app.floatingFloorFrameId = null;
      }

      if (app.playerLiftAnimationFrameId !== null) {
        window.cancelAnimationFrame(app.playerLiftAnimationFrameId);
        app.playerLiftAnimationFrameId = null;
      }

      if (app.levelTransitionFrameId !== null) {
        window.cancelAnimationFrame(app.levelTransitionFrameId);
        app.levelTransitionFrameId = null;
      }
      app.levelTransition = null;
      app.isTransitioningLevel = false;

      if (app.cameraFrameId !== null) {
        window.cancelAnimationFrame(app.cameraFrameId);
        app.cameraFrameId = null;
      }
    });

    app.canvas.addEventListener("webglcontextrestored", function () {
      app.renderer = app.initializeRenderer(app.gl);
      app.setupCanvas();
      app.syncNoiseTicker();
      app.syncFloatingFloorTicker();
      app.syncPlayerLiftAnimationTargets();
      app.syncCameraTarget(true);
      if (!app.isAnimating) {
        app.render();
      }
    });
  }

  if (app.fuzzyToggle) {
    app.fuzzyToggle.addEventListener("click", function () {
      app.state.effects.fuzzyEnabled = !app.state.effects.fuzzyEnabled;
      app.syncFuzzyToggle();
      app.syncNoiseTicker();
      app.render();
    });
  }

  if (app.edgeToggle && app.edgeToggle.dataset.edgeToggleBound !== "true") {
    app.edgeToggle.dataset.edgeToggleBound = "true";
    app.edgeToggle.addEventListener("click", function () {
      app.state.effects.edgeOutlinesEnabled = !app.state.effects.edgeOutlinesEnabled;
      app.syncEdgeToggle();
      app.render();
    });
  }

  if (app.resetProgressButton) {
    app.resetProgressButton.addEventListener("click", function () {
      app.resetCollectionProgress();
    });
  }

  app.syncPlayLayout();
  syncPlayCameraDownshift();
  app.setupCanvas();
  app.syncCameraTarget(true);
  app.syncFuzzyToggle();
  app.syncEdgeToggle();
  app.syncResetProgressButton();
  app.syncNoiseTicker();
  app.syncFloatingFloorTicker();
  app.preloadImages().finally(function () {
    if (shouldRunWorldBoot) {
      runWorldBoot();
    } else {
      app.render();
      revealPlayFrame();
      bindInput();
      startWorldSolver();
    }
  });
  window.addEventListener("resize", function () {
    app.syncPlayLayout();
    syncPlayCameraDownshift();
    app.setupCanvas();
    if (playBootComplete) {
      app.syncCameraTarget(true);
    } else {
      app.threeRenderer?.invalidateSceneCache?.();
    }
    app.render();
  });
})();
