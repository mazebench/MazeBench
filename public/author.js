(function () {
  const authorData = window.__AUTHOR_DATA__;
  const authorPlayData = window.AuthorPlayData;
  const levelPreviewRenderer = window.LevelPreviewRenderer;

  if (!authorData) {
    return;
  }

  // The local MazeBench author API stores the rendered portrait sent by this
  // client. Hosted deployments may keep portraits entirely browser-local, so
  // they can opt out of preview mutations without changing the shared editor
  // runtime.
  const clientPreviewPersistence = authorData.clientPreviewPersistence !== false;
  // MazeJam hosts the complete saved world in the author page. In that
  // environment every room remains one browser-local draft until the builder
  // deliberately presses Save; room navigation must never be a persistence
  // event.
  const hostedWorldDraftMode =
    clientPreviewPersistence === false && Boolean(authorData.worldMeta?.apiUrl);

  const elements = {
    applyCellValue: document.getElementById("apply-cell-value"),
    boardHeight: document.getElementById("board-height"),
    boardSizeLabel: document.getElementById("board-size-label"),
    boardWidth: document.getElementById("board-width"),
    canvas: document.getElementById("author-canvas"),
    cellValue: document.getElementById("cell-value"),
    clearLevel: document.getElementById("clear-level"),
    currentFileName: document.getElementById("current-file-name"),
    currentLevelName: document.getElementById("current-level-name"),
    existingLevels: document.getElementById("existing-levels"),
    worldMapSwap: document.getElementById("author-world-map-swap"),
    worldMapSwapStatus: document.getElementById("author-world-map-swap-status"),
    flipHorizontal: document.getElementById("flip-horizontal"),
    flipVertical: document.getElementById("flip-vertical"),
    frameLevel: document.getElementById("frame-level"),
    grid: document.getElementById("author-grid"),
    gridShell: document.querySelector(".author-grid-shell"),
    hitGrid: document.getElementById("author-hit-grid"),
    hotbar: document.getElementById("author-hotbar"),
    hillClimb: document.getElementById("hill-climb"),
    hillClimbMode: document.getElementById("hill-climb-mode"),
    hillClimbNext: document.getElementById("hill-climb-next"),
    hillClimbPrev: document.getElementById("hill-climb-prev"),
    hillClimbResultLabel: document.getElementById("hill-climb-result-label"),
    levelNeighbors: document.getElementById("level-neighbors"),
    levelColumn: document.getElementById("level-column"),
    levelRow: document.getElementById("level-row"),
    palette: document.getElementById("palette"),
    placeGem: document.getElementById("place-gem"),
    playLink: document.getElementById("author-play-link"),
    playSolution: document.getElementById("play-solution"),
    rawOutput: document.getElementById("raw-output"),
    resizeLevel: document.getElementById("resize-level"),
    rotateLeft: document.getElementById("rotate-left"),
    rotateRight: document.getElementById("rotate-right"),
    saveLevel: document.getElementById("save-level"),
    selectedCellLabel: document.getElementById("selected-cell-label"),
    selectedToolLabel: document.getElementById("selected-tool-label"),
    sidebar: document.querySelector(".author-sidebar"),
    solveLevel: document.getElementById("solve-level"),
    solverAlgorithm: document.getElementById("solver-algorithm"),
    solverCancel: document.getElementById("solver-cancel"),
    solverMaxStates: document.getElementById("solver-max-states"),
    solverModeHint: document.getElementById("solver-mode-hint"),
    solverModePicker: document.getElementById("solver-mode-picker"),
    solverModePlace: document.getElementById("solver-mode-place"),
    solverModeReach: document.getElementById("solver-mode-reach"),
    status: document.getElementById("author-status"),
    tokenIdCancel: document.getElementById("token-id-cancel"),
    tokenIdConfirm: document.getElementById("token-id-confirm"),
    tokenIdInput: document.getElementById("token-id-input"),
    tokenIdMessage: document.getElementById("token-id-message"),
    tokenIdModal: document.getElementById("token-id-modal"),
    tokenIdTitle: document.getElementById("token-id-title"),
    unsavedCancel: document.getElementById("unsaved-changes-cancel"),
    unsavedMessage: document.getElementById("unsaved-changes-message"),
    unsavedModal: document.getElementById("unsaved-changes-modal"),
    unsavedSave: document.getElementById("unsaved-changes-save"),
    undoLevel: document.getElementById("undo-level")
  };

  const optionalElementKeys = new Set([
    "boardSizeLabel",
    "currentFileName",
    "currentLevelName",
    "existingLevels",
    "hillClimb",
    "hillClimbMode",
    "hillClimbNext",
    "hillClimbPrev",
    "hillClimbResultLabel",
    "levelColumn",
    "levelNeighbors",
    "levelRow",
    "placeGem",
    "playSolution",
    "solverAlgorithm",
    "solverCancel",
    "tokenIdCancel",
    "tokenIdConfirm",
    "tokenIdInput",
    "tokenIdMessage",
    "tokenIdModal",
    "tokenIdTitle"
  ]);

  if (
    Object.entries(elements).some(
      ([key, element]) => !element && !optionalElementKeys.has(key)
    )
  ) {
    return;
  }

  if (!authorPlayData || typeof authorPlayData.createAdapter !== "function") {
    return;
  }

  const playDataAdapter = authorPlayData.createAdapter(authorData);
  const {
    buildPlayData,
    eraseCellElevationValue,
    getCellDescriptor,
    getCellTokens,
    getCellTools,
    appendCellToken,
    normalizeAuthoringCellValue,
    normalizeCellValue,
    placeCellElevationTokenIfVacant,
    setCellElevationToken,
    setSurfaceAttachmentToken,
    toolByName,
    toolByToken
  } = playDataAdapter;
  const editorTileSize = 64;
  const minimumEditorTileSize = 12;
  const editorGridOutlineSize = 8;
  const editorRenderer = {
    app: null,
    hasCompletedPreload: false,
    layoutFrameId: null,
    preloadVersion: 0,
    preloadedTokens: new Set(),
    sceneFrameId: null
  };
  // MazeBench editor boot: when the host page exposes a MARK_READY hook, the
  // first canvas frames render in the home "vector boot" look (black blocks,
  // blue edges primed hidden), the loading cover lifts over that frame, the
  // edge sweep traces the room in, then the glow melts into editor colors.
  // pending -> armed (theme applied before first mesh) -> running -> done.
  const editorBootReveal = { state: "pending" };
  const palettePreviewRenderer = {
    captureQueue: Promise.resolve(),
    pendingTokens: new Set(),
    previewsByToken: new Map(),
    promise: null
  };
  const editorGridRectCache = { rect: null };
  const pointerMoveScheduler = {
    frameId: null,
    samples: []
  };
  const authorOverlaySelector = [
    ".author-topbar",
    ".author-sidebar",
    ".author-sidebar-toggle",
    "#author-world-map-toggle",
    ".author-world-map-overlay",
    "#author-cam-pad",
    "#author-inventory",
    "#author-hotbar",
    ".build-mobile-blocker",
    ".publish-modal",
    ".solver-dock"
  ].join(",");
  const defaultSolverMaxExpandedStates = 1000000;
  const solverProgressYieldStateInterval = 4096;
  const solverProgressRenderIntervalMs = 80;
  const pointerPaintSamplesPerFrameLimit = 16;
  const undoStackLimit = 80;
  const solutionDirections = {
    U: { label: "U", dx: 0, dy: -1 },
    D: { label: "D", dx: 0, dy: 1 },
    L: { label: "L", dx: -1, dy: 0 },
    R: { label: "R", dx: 1, dy: 0 }
  };
  const eraserToken = "__erase_top__";
  const emptyCellToken = authorData.blockAdder || "+";
  const noopToken = "__select_only__";
  const toolboxToolConfigs =
    authorData.toolboxCatalog?.tools && typeof authorData.toolboxCatalog.tools === "object"
      ? authorData.toolboxCatalog.tools
      : {};
  const noopToolConfig = toolboxToolConfigs[noopToken] || {};
  const eraserToolConfig = toolboxToolConfigs[eraserToken] || {};
  const noopTool = {
    description:
      typeof noopToolConfig.description === "string" ? noopToolConfig.description : "",
    imageUrl: null,
    label: typeof noopToolConfig.name === "string" ? noopToolConfig.name : "Deselect",
    name: "select_only",
    selectable: true,
    token: noopToken,
    type: "select_only"
  };
  const eraserTool = {
    description:
      typeof eraserToolConfig.description === "string" ? eraserToolConfig.description : "",
    imageUrl: null,
    label: typeof eraserToolConfig.name === "string" ? eraserToolConfig.name : "Erase",
    name: "eraser",
    selectable: true,
    token: eraserToken,
    type: "eraser"
  };
  // Adapted from Lucide's ISC-licensed MousePointer2Off and Eraser icons.
  // https://lucide.dev/icons/mouse-pointer-2-off
  // https://lucide.dev/icons/eraser
  const deselectToolIconSvg =
    '<svg class="author-tool-icon author-tool-icon--deselect" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="m15.55 8.45 5.138 2.087a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063L8.45 15.551"></path>' +
    '<path d="M22 2 2 22"></path>' +
    '<path d="m6.816 11.528-2.779-6.84a.495.495 0 0 1 .651-.651l6.84 2.779"></path>' +
    "</svg>";
  const eraserToolIconSvg =
    '<svg class="author-tool-icon author-tool-icon--eraser" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"></path>' +
    '<path d="M22 21H7"></path>' +
    '<path d="m5 11 9 9"></path>' +
    "</svg>";
  // Ghost, Minimize 2, Maximize 2, Circle Stop, and X from Lucide Icons (ISC License).
  // https://lucide.dev/icons/ghost
  // https://lucide.dev/icons/minimize-2
  // https://lucide.dev/icons/maximize-2
  // https://lucide.dev/icons/circle-stop
  // https://lucide.dev/icons/x
  const solverGhostIconSvg =
    '<svg class="solver-dock__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="M9 10h.01"></path><path d="M15 10h.01"></path>' +
    '<path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"></path>' +
    "</svg>";
  const solverMinimizeIconSvg =
    '<svg class="solver-dock__icon solver-dock__icon--minimize" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="m14 10 7-7"></path><path d="M20 10h-6V4"></path><path d="m3 21 7-7"></path><path d="M4 14h6v6"></path>' +
    "</svg>";
  const solverMaximizeIconSvg =
    '<svg class="solver-dock__icon solver-dock__icon--maximize" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="M15 3h6v6"></path><path d="m21 3-7 7"></path><path d="m3 21 7-7"></path><path d="M9 21H3v-6"></path>' +
    "</svg>";
  const solverStopIconSvg =
    '<svg class="solver-dock__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<circle cx="12" cy="12" r="10"></circle><rect x="9" y="9" width="6" height="6" rx="1"></rect>' +
    "</svg>";
  const solverDismissIconSvg =
    '<svg class="solver-dock__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>' +
    "</svg>";
  // Prompt-style toolbox entries (owner feature 2026-07): "Box N" and friends
  // ask for a numeric id, then select the concrete pattern token (M<N>, c<N>,
  // SrM<N>, Src<N>). They follow the noop/eraser meta-tool precedent; the id
  // families are open-ended, so these four buttons stand in for whole families
  // while Box 0-4 and Clone 0-2 keep their dedicated buttons.
  const boxPromptToken = "__box_prompt__";
  const clonePromptToken = "__clone_prompt__";
  const blueSlopePromptToken = "__blue_slope_prompt__";
  const yellowSlopePromptToken = "__yellow_slope_prompt__";
  const tokenPatternHelpers = window.MazeTokenPatterns || null;

  function buildPromptPaletteTool(token, groupName, fallbackLabel, prompt) {
    const config = toolboxToolConfigs[token] || {};

    return {
      description: typeof config.description === "string" ? config.description : "",
      imageUrl: null,
      label: typeof config.name === "string" && config.name ? config.name : fallbackLabel,
      name: groupName,
      prompt,
      selectable: true,
      token,
      type: "token_prompt"
    };
  }

  const promptPaletteTools = [
    buildPromptPaletteTool(boxPromptToken, "weightless_box", "Box N", {
      // Box 0-4 keep their own buttons, so the next free id is the default.
      defaultId: 5,
      makeToken: (id) => (tokenPatternHelpers ? tokenPatternHelpers.boxToken(id) : "M" + id),
      message:
        "Choose the box id. Boxes sharing an id are connected and move together; the id shows on every piece."
    }),
    buildPromptPaletteTool(clonePromptToken, "clone", "Clone N", {
      defaultId: 3,
      makeToken: (id) => (tokenPatternHelpers ? tokenPatternHelpers.cloneToken(id) : "c" + id),
      message:
        "Choose the clone id. Clones copy the player's moves, and clones sharing an id are connected."
    }),
    buildPromptPaletteTool(blueSlopePromptToken, "ice_slope", "Box Ice Slope N", {
      defaultId: 0,
      makeToken: (id) =>
        tokenPatternHelpers ? tokenPatternHelpers.blueSlopeToken("right", id) : "SrM" + id,
      message:
        "Choose the box id this slope belongs to. It moves with box group N and faces the camera when placed."
    }),
    buildPromptPaletteTool(yellowSlopePromptToken, "ice_slope", "Clone Ice Slope N", {
      defaultId: 0,
      makeToken: (id) =>
        tokenPatternHelpers ? tokenPatternHelpers.yellowSlopeToken("right", id) : "Src" + id,
      message:
        "Choose the clone id this slope belongs to. It moves with clone group N and faces the camera when placed."
    })
  ];
  const promptToolsByToken = new Map(promptPaletteTools.map((tool) => [tool.token, tool]));

  function isPromptToolToken(token) {
    return promptToolsByToken.has(token);
  }

  function promptToolPreviewSpec(token) {
    if (token === boxPromptToken) {
      return { groupId: "MN", token: "M0" };
    }
    if (token === clonePromptToken) {
      return { groupId: "cN", token: "c0" };
    }
    if (token === blueSlopePromptToken) {
      return { groupId: "MN", token: "SrM0" };
    }
    if (token === yellowSlopePromptToken) {
      return { groupId: "cN", token: "Src0" };
    }
    return null;
  }

  function ownedSlopePalettePreviewSpec(token, promptPreview = null) {
    const match = /^Sr([Mc])(\d+)$/.exec(String(token || ""));

    if (!match) {
      return null;
    }

    const groupId = match[1] + match[2];

    return {
      actorToken: groupId,
      groupId: promptPreview?.groupId || groupId,
      type: match[1] === "M" ? "weightless_box" : "clone"
    };
  }

  // ---- Slope families ----
  // Every slope styling family — plain, black "#", orange "O", and the
  // open-ended blue "M<N>" / yellow "c<N>" tints — collapses to ONE toolbox
  // entry whose painted token follows the camera, exactly like the original
  // single Ice Slope entry. Families are keyed by the token's style suffix
  // ("Sr" -> "", "Sr#" -> "#", "SrM7" -> "M7", ...).
  const slopeFamiliesBySuffix = new Map();
  // These are core building tools, not optional discoveries from whichever
  // directional entries happen to be present in the page palette payload.
  const numberedBoxSlopeToolTokens = [0, 1, 2, 3, 4].map((id) => "SrM" + id);
  const numberedCloneSlopeToolTokens = [0, 1, 2].map((id) => "Src" + id);
  const permanentToolboxSlopeTokens = [
    "Sr",
    "Sr#",
    "SrO",
    ...numberedBoxSlopeToolTokens,
    ...numberedCloneSlopeToolTokens
  ];

  function slopeTokenStyleSuffix(token) {
    const match = /^S[rlud](.*)$/.exec(String(token || ""));
    return match ? match[1] : null;
  }

  function slopeFamilyLabelForSuffix(suffix, fallbackLabel) {
    if (suffix === "") {
      return "Ice Slope";
    }
    if (suffix === "#") {
      return "Black Ice Slope";
    }
    if (suffix === "O") {
      return "Orange Ice Slope";
    }
    const boxMatch = /^M(\d+)$/.exec(suffix);
    if (boxMatch) {
      return "Box Ice Slope " + boxMatch[1];
    }
    const cloneMatch = /^c(\d+)$/.exec(suffix);
    if (cloneMatch) {
      return "Clone Ice Slope " + cloneMatch[1];
    }
    return fallbackLabel || "Ice Slope";
  }

  function materializePatternTool(token) {
    if (!token || token === noopToken || token === eraserToken || isPromptToolToken(token)) {
      return null;
    }
    if (toolByToken.has(token)) {
      return toolByToken.get(token);
    }
    // getCellTools() delegates to the adapter's pattern resolver, which
    // synthesizes Box N / Clone N / colored-slope tools and caches them in
    // toolByToken so painting and normalizing accept them everywhere.
    const [tool] = getCellTools(token);
    return tool && tool.token === token ? tool : null;
  }

  function registerSlopeFamilyTool(tool) {
    const suffix = slopeTokenStyleSuffix(tool?.token);

    if (suffix === null || !isSlopeFamilyTool(tool)) {
      return null;
    }

    let family = slopeFamiliesBySuffix.get(suffix);

    if (!family) {
      family = {
        canonicalToken: null,
        paletteTool: null,
        suffix,
        tokenByDirection: new Map()
      };
      slopeFamiliesBySuffix.set(suffix, family);
    }

    if (
      typeof tool.direction === "string" &&
      tool.direction &&
      !family.tokenByDirection.has(tool.direction)
    ) {
      family.tokenByDirection.set(tool.direction, tool.token);
    }

    const canonicalToken =
      family.tokenByDirection.get("right") || family.canonicalToken || tool.token;

    if (family.canonicalToken !== canonicalToken || !family.paletteTool) {
      const canonicalTool = toolByToken.get(canonicalToken) || tool;
      const toolboxConfig = toolboxToolConfigs[canonicalToken] || {};
      family.canonicalToken = canonicalToken;
      family.paletteTool = {
        ...canonicalTool,
        description:
          toolboxConfig.description ||
          canonicalTool.description ||
          "An icy ramp that carries a slide between heights. It aims to match the camera — turn the camera to change which way it climbs.",
        displayToken: "S",
        label:
          toolboxConfig.name ||
          slopeFamilyLabelForSuffix(suffix, canonicalTool.label),
        token: canonicalToken
      };
    }

    return family;
  }

  function slopeFamilyForToken(token) {
    const suffix = slopeTokenStyleSuffix(token);

    if (suffix === null) {
      return null;
    }

    // Pattern-backed slope families must always own all four directional
    // tokens. This is especially important for older projects whose parser
    // predates Black/Orange Ice Slopes: a canonical Sr#/SrO fallback alone
    // would make every camera angle place the right-facing token.
    if (/^(?:#|O|M\d+|c\d+)$/.test(suffix)) {
      ["r", "l", "u", "d"].forEach((directionChar) => {
        const directionToken = "S" + directionChar + suffix;
        const directionTool =
          toolByToken.get(directionToken) || materializePatternTool(directionToken);
        if (directionTool) {
          registerSlopeFamilyTool(directionTool);
        }
      });
    }

    return slopeFamiliesBySuffix.get(suffix) || null;
  }

  authorData.palette.forEach((tool) => {
    if (isSlopeFamilyTool(tool)) {
      registerSlopeFamilyTool(tool);
    }
  });
  permanentToolboxSlopeTokens.forEach((token) => slopeFamilyForToken(token));

  function toolDescription(tool) {
    if (!tool) return "";
    return typeof tool.description === "string" ? tool.description : "";
  }
  const worldColumns =
    Array.isArray(authorData.worldColumns) && authorData.worldColumns.length > 0
      ? authorData.worldColumns
      : ["A"];
  const worldRows =
    Array.isArray(authorData.worldRows) && authorData.worldRows.length > 0
      ? authorData.worldRows
      : ["A"];
  const columnIndexByValue = new Map(worldColumns.map((letter, index) => [letter, index]));
  const rowIndexByValue = new Map(worldRows.map((letter, index) => [letter, index]));
  let renderStartRoomGrid = () => {};
  const initialHostedWorldLevel =
    hostedWorldDraftMode && authorData.initialLevel?.exists === false
      ? hostedWorldLevelRecord(
          authorData.initialLevel.levelId,
          authorData.initialLevel,
          { synthesizeMissing: true }
        )
      : null;
  const initialLevel = initialHostedWorldLevel
    ? { ...authorData.initialLevel, ...initialHostedWorldLevel }
    : authorData.initialLevel;
  const initialLevelCells = normalizeAuthoringCells(initialLevel.cells);
  const state = {
    cells: cloneCells(initialLevelCells),
    exists: initialLevel.exists,
    fileName: initialLevel.fileName,
    filePath: initialLevel.filePath,
    height: initialLevel.height,
    isDirty: false,
    isLevelLoading: false,
    isLevelSwitching: false,
    isSolutionPlaying: false,
    isSolverBusy: false,
    levelId: initialLevel.levelId,
    message: initialLevel.exists
      ? "Loaded existing level."
      : "Fresh level. Paint something good.",
    messageTone: initialLevel.exists ? "success" : "warning",
    lastPaintTargetKey: null,
    eraseGestureMode: null,
    hillClimbResults: [],
    hillClimbResultIndex: -1,
    paintDragPlane: null,
    paintPointerId: null,
    paintStrokeLevelId: null,
    paintStrokeDidPaint: false,
    paintStrokePaintedVoxelKeys: new Set(),
    paintStrokeToken: null,
    savedBoardSignature: boardSignature(
      initialLevel.width,
      initialLevel.height,
      initialLevelCells
    ),
    selectedCell: { x: 0, y: 0 },
    selectedToken:
      authorData.defaultWallToken || authorData.palette[0]?.token || authorData.defaultFloorToken,
    solutionPlaybackAbortController: null,
    solverAbortController: null,
    solverContinuation: null,
    solverExportFormat: null,
    solverGhostVisible: false,
    solverMode: null,
    solverSolutionCellsKey: null,
    solverSolutionPath: null,
    undoStack: [],
    width: initialLevel.width,
    worldMapSwapBusy: false,
    worldMapSwapFirstLevelId: null,
    worldMapSwapMessage: "Choose Swap rooms, then select two built rooms.",
    worldMapSwapMode: false
  };

  function editorSnapshot() {
    return {
      cells: cloneCells(state.cells),
      height: state.height,
      selectedCell: {
        x: state.selectedCell.x,
        y: state.selectedCell.y
      },
      width: state.width
    };
  }

  function snapshotSignature(snapshot) {
    return boardSignature(snapshot.width, snapshot.height, snapshot.cells);
  }

  function undoSnapshotSignature(snapshot) {
    if (typeof snapshot.signature !== "string") {
      snapshot.signature = snapshotSignature(snapshot);
    }

    return snapshot.signature;
  }

  function syncUndoButtonState() {
    const isLocked =
      state.isLevelLoading ||
      state.isLevelSwitching ||
      state.isSolverBusy ||
      state.isSolutionPlaying;

    elements.undoLevel.disabled = state.undoStack.length === 0 || isLocked;
    elements.undoLevel.title =
      state.undoStack.length === 0
        ? "Nothing to undo yet."
        : isLocked
          ? "Finish the current editor action before undoing."
          : "Undo the last editor change.";
  }

  // Callers that already verified the board is about to change (for example
  // per-cell painting) pass { boardChanged: true } so drag strokes skip the
  // full-board signature comparison entirely. Signatures are computed at most
  // once per snapshot and cached for later comparisons.
  function pushUndoSnapshot(options = {}) {
    const snapshot = editorSnapshot();
    const previous = state.undoStack[state.undoStack.length - 1];

    if (
      previous &&
      options.boardChanged !== true &&
      undoSnapshotSignature(previous) === undoSnapshotSignature(snapshot)
    ) {
      return;
    }

    state.undoStack.push(snapshot);

    if (state.undoStack.length > undoStackLimit) {
      state.undoStack.shift();
    }

    syncUndoButtonState();
  }

  function clearHillClimbResults() {
    state.hillClimbResults = [];
    state.hillClimbResultIndex = -1;
    syncHillClimbResultControls();
  }

  function clearUndoHistory() {
    state.undoStack = [];
    syncUndoButtonState();
  }

  function restoreEditorSnapshot(snapshot) {
    state.cells = cloneCells(snapshot.cells);
    state.height = snapshot.height;
    state.selectedCell = {
      x: Math.max(0, Math.min(snapshot.width - 1, snapshot.selectedCell.x)),
      y: Math.max(0, Math.min(snapshot.height - 1, snapshot.selectedCell.y))
    };
    state.width = snapshot.width;
    syncEditorDirtyState();
    clearSolverSolution();
    clearHillClimbResults();
    renderAll();
  }

  function undoLastEdit() {
    if (isEditorInteractionLocked()) {
      return false;
    }

    const snapshot = state.undoStack.pop();

    if (!snapshot) {
      setStatus("Nothing to undo.", "warning");
      return false;
    }

    restoreEditorSnapshot(snapshot);
    setStatus("Undid the last edit.", state.isDirty ? "warning" : "success");
    syncUndoButtonState();
    return true;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function cloneCells(cells) {
    return cells.map((row) => row.slice());
  }

  function normalizeAuthoringCells(cells) {
    return cells.map((row) => row.map((value) => normalizeAuthoringCellValue(value)));
  }

  function createBlankCells(width, height, fillToken) {
    return Array.from({ length: height }, () => Array.from({ length: width }, () => fillToken));
  }

  // Keep sparse hosted worlds cheap in storage without making their untouched
  // rooms invisible in the editor. This fallback intentionally mirrors
  // shared/default-world-template.js; the focused parity test fails if the
  // canonical room template ever changes without this client copy following.
  function defaultHostedWorldLevel(levelId) {
    const coordinates = parseLevelCoordinates(levelId) || { column: "A", row: "A" };
    const canonicalDefaultLevel = window.MazeBenchDefaultWorldTemplate?.defaultLevel;
    const worldWidth = Math.max(1, worldColumns.length);
    const worldHeight = Math.max(1, worldRows.length);

    if (typeof canonicalDefaultLevel === "function") {
      return canonicalDefaultLevel({
        column: coordinates.column,
        row: coordinates.row,
        worldHeight,
        worldWidth
      });
    }

    const width = 16;
    const height = 16;
    const columnIndex = coordinates.column.charCodeAt(0) - 65;
    const rowIndex = coordinates.row.charCodeAt(0) - 65;
    const openLeft = columnIndex > 0;
    const openRight = columnIndex < worldWidth - 1;
    const openTop = rowIndex > 0;
    const openBottom = rowIndex < worldHeight - 1;
    const openingSize = Math.max(0, Math.min(4, width - 2));
    const openingStart = Math.floor((width - openingSize) / 2);
    const openingEnd = openingStart + openingSize - 1;
    const cells = Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => {
        const inHorizontalOpening = x >= openingStart && x <= openingEnd;
        const inVerticalOpening = y >= openingStart && y <= openingEnd;

        if (y === 0) return openTop && inHorizontalOpening ? "." : ".+#";
        if (y === height - 1) return openBottom && inHorizontalOpening ? "." : ".+#";
        if (x === 0) return openLeft && inVerticalOpening ? "." : ".+#";
        if (x === width - 1) return openRight && inVerticalOpening ? "." : ".+#";
        if (x === 7 && y === 7) return ".+p";
        return ".";
      })
    );

    return {
      cells,
      column: coordinates.column,
      height,
      id: levelId,
      row: coordinates.row,
      title: `${coordinates.column}x${coordinates.row}`,
      width
    };
  }

  function boardSignature(width, height, cells) {
    return [
      width,
      height,
      cells.map((row) => row.join(authorData.separator)).join("\n")
    ].join("\n");
  }

  const hostedWorldDraftLevels = new Map();
  const hostedSavedLevelSignatures = new Map();
  const hostedDirtyLevelIds = new Set();

  function hostedWorldLevelRecord(levelId, source = null, options = {}) {
    const coordinates = parseLevelCoordinates(levelId) || { column: "A", row: "A" };
    const synthesized =
      options.synthesizeMissing === true && source?.exists === false
        ? defaultHostedWorldLevel(levelId)
        : null;
    const levelSource = synthesized
      ? {
          ...source,
          ...synthesized,
          exists: false,
          label: source?.label || synthesized.title,
          title: source?.title || synthesized.title
        }
      : source;
    const width = Math.max(
      1,
      Number(levelSource?.width) ||
        Number(authorData.initialLevel?.width) ||
        Number(authorData.defaultWidth) ||
        16
    );
    const height = Math.max(
      1,
      Number(levelSource?.height) ||
        Number(authorData.initialLevel?.height) ||
        Number(authorData.defaultHeight) ||
        16
    );
    const cells =
      Array.isArray(levelSource?.cells) && levelSource.cells.length > 0
        ? normalizeAuthoringCells(levelSource.cells)
        : createBlankCells(width, height, authorData.defaultFloorToken);
    return {
      cells: cloneCells(cells),
      column: coordinates.column,
      exists: levelSource?.exists !== false,
      height,
      id: levelId,
      label: levelSource?.label || levelSource?.title || levelId,
      row: coordinates.row,
      title: levelSource?.title || levelSource?.label || levelId.replace("level_", ""),
      width
    };
  }

  function initializeHostedWorldDraft() {
    if (!hostedWorldDraftMode) {
      return;
    }
    const savedById = new Map(
      (authorData.existingLevels || []).map((level) => [level.id, level])
    );
    worldRows.forEach((row) => {
      worldColumns.forEach((column) => {
        const levelId = "level_" + column + "x" + row;
        const source =
          levelId === state.levelId
            ? {
                ...savedById.get(levelId),
                ...authorData.initialLevel,
                exists: authorData.initialLevel.exists
              }
            : savedById.get(levelId) || { exists: false };
        const record = hostedWorldLevelRecord(levelId, source, {
          synthesizeMissing: true
        });
        hostedWorldDraftLevels.set(levelId, record);
        hostedSavedLevelSignatures.set(
          levelId,
          boardSignature(record.width, record.height, record.cells)
        );
      });
    });
  }

  function hostedWorldLevelEntries() {
    return hostedWorldDraftMode
      ? Array.from(hostedWorldDraftLevels.values())
      : authorData.existingLevels;
  }

  initializeHostedWorldDraft();

  function parseLevelCoordinates(levelId) {
    const match = String(levelId || "").match(/^level_([A-Z])x([A-Z])$/);

    if (!match) {
      return null;
    }

    return {
      column: match[1],
      row: match[2]
    };
  }

  function levelIdFromSelectors() {
    return "level_" + elements.levelColumn.value + "x" + elements.levelRow.value;
  }

  function adjacentLevelId(levelId, dx, dy) {
    const coordinates = parseLevelCoordinates(levelId);

    if (!coordinates || worldColumns.length === 0 || worldRows.length === 0) {
      return levelId;
    }

    const columnIndex = columnIndexByValue.get(coordinates.column);
    const rowIndex = rowIndexByValue.get(coordinates.row);

    if (typeof columnIndex !== "number" || typeof rowIndex !== "number") {
      return levelId;
    }

    const nextColumnIndex = columnIndex + dx;
    const nextRowIndex = rowIndex + dy;

    if (
      nextColumnIndex < 0 ||
      nextRowIndex < 0 ||
      nextColumnIndex >= worldColumns.length ||
      nextRowIndex >= worldRows.length
    ) {
      return null;
    }

    return "level_" + worldColumns[nextColumnIndex] + "x" + worldRows[nextRowIndex];
  }

  function levelSwitchTargetForId(levelId) {
    const current = parseLevelCoordinates(state.levelId);
    const target = parseLevelCoordinates(levelId);

    if (!current || !target) {
      return null;
    }

    const currentColumn = columnIndexByValue.get(current.column);
    const currentRow = rowIndexByValue.get(current.row);
    const targetColumn = columnIndexByValue.get(target.column);
    const targetRow = rowIndexByValue.get(target.row);

    if (
      !Number.isInteger(currentColumn) ||
      !Number.isInteger(currentRow) ||
      !Number.isInteger(targetColumn) ||
      !Number.isInteger(targetRow)
    ) {
      return null;
    }

    return {
      dx: targetColumn - currentColumn,
      dy: targetRow - currentRow,
      kind: "levelSwitch",
      levelId
    };
  }

  function switchToLevelId(levelId) {
    const target = levelSwitchTargetForId(levelId);

    if (!target || (target.dx === 0 && target.dy === 0)) {
      return Promise.resolve(false);
    }

    return switchToNeighborLevel(target);
  }

  function serializeCells() {
    return state.cells.map((row) => row.join(authorData.separator)).join("\n");
  }

  function clearSolverSolution() {
    state.solverSolutionCellsKey = null;
    state.solverSolutionPath = null;
    clearSolverGhostOverlay();
  }

  function rememberSolverSolution(path) {
    state.solverSolutionCellsKey = serializeCells();
    state.solverSolutionPath = String(path ?? "");
  }

  function hasPlayableSolution() {
    return (
      typeof state.solverSolutionPath === "string" &&
      state.solverSolutionCellsKey === serializeCells()
    );
  }

  function solverGhostCellsForPath(path) {
    const playData = buildEditorPlayData();
    const playerIndex = playData.actors.findIndex(isSolverPlayerActor);

    if (playerIndex < 0) return [];

    const engine = createSolverEngine(playData);
    const engineState = engine.cloneState(engine.initialState);
    const cells = [];

    function pushCell(x, y, elevation) {
      const cell = {
        elevation: Number(elevation) || 0,
        x: Number(x),
        y: Number(y)
      };
      const previous = cells[cells.length - 1];
      if (
        !Number.isFinite(cell.x) ||
        !Number.isFinite(cell.y) ||
        (previous &&
          previous.x === cell.x &&
          previous.y === cell.y &&
          previous.elevation === cell.elevation)
      ) {
        return;
      }
      cells.push(cell);
    }

    pushCell(
      engineState.actorX[playerIndex],
      engineState.actorY[playerIndex],
      engineState.actorElevation[playerIndex]
    );

    for (const label of String(path || "")) {
      const direction = solutionDirections[label];
      if (!direction) break;
      const result = engine.moveForSearch(engineState, direction.dx, direction.dy);
      if (!result?.moved) break;
      const playerMoves = result.moves.filter(
        (move) => move.actorIndex === playerIndex && !move.visualOnly
      );

      playerMoves.forEach((move) => {
        if (Array.isArray(move.path) && move.path.length > 0) {
          move.path.forEach((point) => pushCell(point.x, point.y, point.elevation));
        } else {
          pushCell(move.toX, move.toY, move.toElevation);
        }
      });

      pushCell(
        engineState.actorX[playerIndex],
        engineState.actorY[playerIndex],
        engineState.actorElevation[playerIndex]
      );
    }

    return cells;
  }

  function syncSolverDockControls() {
    if (!solverDock.element) return;
    const playable = hasPlayableSolution();
    const locked = state.isSolverBusy || state.isSolutionPlaying;
    const exporting = Boolean(state.solverExportFormat);
    if (solverDock.playbackButton) {
      solverDock.playbackButton.disabled = locked || exporting || !playable;
      solverDock.playbackButton.textContent = state.isSolutionPlaying ? "Playing..." : "Play Solution";
    }
    if (solverDock.stopPlaybackButton) {
      const stopping = Boolean(state.solutionPlaybackAbortController?.signal.aborted);
      solverDock.stopPlaybackButton.hidden = !state.isSolutionPlaying;
      solverDock.stopPlaybackButton.disabled = stopping;
      solverDock.stopPlaybackButton.setAttribute(
        "aria-label",
        stopping ? "Stopping solution playback" : "Stop solution playback"
      );
      solverDock.stopPlaybackButton.title = stopping
        ? "Stopping solution playback"
        : "Stop solution playback";
    }
    if (solverDock.ghostButton) {
      solverDock.ghostButton.disabled = locked || exporting || !playable;
      solverDock.ghostButton.setAttribute(
        "aria-pressed",
        state.solverGhostVisible ? "true" : "false"
      );
      const ghostLabel = state.solverGhostVisible ? "Hide ghost path" : "Show ghost path";
      solverDock.ghostButton.setAttribute("aria-label", ghostLabel);
      solverDock.ghostButton.title = ghostLabel;
    }
    if (solverDock.harderButton) solverDock.harderButton.disabled = locked || exporting;
    if (solverDock.harderInfoButton) solverDock.harderInfoButton.disabled = locked || exporting;
    if (solverDock.continueInput) solverDock.continueInput.disabled = locked || exporting;
    if (solverDock.continueButton) solverDock.continueButton.disabled = locked || exporting;
    if (solverDock.exportFormat) solverDock.exportFormat.disabled = locked || exporting || !playable;
    if (solverDock.exportButton) {
      solverDock.exportButton.disabled = locked || exporting || !playable;
      solverDock.exportButton.textContent = exporting ? "Rendering..." : "Download";
    }
    if (solverDock.minimizeButton) {
      const minimizeLabel = solverDock.minimized ? "Expand solver panel" : "Minimize solver panel";
      solverDock.minimizeButton.disabled = locked || exporting || !playable;
      solverDock.minimizeButton.setAttribute("aria-label", minimizeLabel);
      solverDock.minimizeButton.title = minimizeLabel;
      solverDock.minimizeButton.setAttribute(
        "aria-expanded",
        solverDock.minimized ? "false" : "true"
      );
    }
    if (solverDock.cancelButton && !state.isSolverBusy) {
      solverDock.cancelButton.disabled = state.isSolutionPlaying || exporting;
    }
  }

  function setSolverGhostVisible(visible) {
    const nextVisible = visible === true && hasPlayableSolution();
    state.solverGhostVisible = nextVisible;
    const app = editorRenderer.app;
    if (app?.threeRenderer?.setSolverGhostCells) {
      app.threeRenderer.setSolverGhostCells(
        nextVisible ? solverGhostCellsForPath(state.solverSolutionPath) : []
      );
    }
    syncSolverDockControls();
  }

  function clearSolverGhostOverlay() {
    state.solverGhostVisible = false;
    if (editorRenderer.app?.threeRenderer?.setSolverGhostCells) {
      editorRenderer.app.threeRenderer.setSolverGhostCells([]);
    }
    syncSolverDockControls();
  }

  function currentHillClimbResult() {
    if (
      !Array.isArray(state.hillClimbResults) ||
      state.hillClimbResultIndex < 0 ||
      state.hillClimbResultIndex >= state.hillClimbResults.length
    ) {
      return null;
    }

    return state.hillClimbResults[state.hillClimbResultIndex];
  }

  function hillClimbResultSummary(result, index = state.hillClimbResultIndex, total = state.hillClimbResults.length) {
    if (!result) {
      return "";
    }

    return (
      "Result " +
      (index + 1) +
      "/" +
      total +
      ": wall " +
      (result.wallX + 1) +
      ", " +
      (result.wallY + 1) +
      " - " +
      result.moves +
      " move" +
      (result.moves === 1 ? "" : "s")
    );
  }

  function syncHillClimbResultControls() {
    const hasResults = Array.isArray(state.hillClimbResults) && state.hillClimbResults.length > 0;
    const isLocked = state.isSolverBusy || state.isSolutionPlaying || state.isLevelSwitching;

    if (elements.hillClimbPrev) {
      elements.hillClimbPrev.disabled =
        isLocked || !hasResults || state.hillClimbResultIndex <= 0;
      elements.hillClimbPrev.title = hasResults
        ? "Show the previous hill-climb result."
        : "Run Hill-Climb before paging results.";
    }

    if (elements.hillClimbNext) {
      elements.hillClimbNext.disabled =
        isLocked ||
        !hasResults ||
        state.hillClimbResultIndex >= state.hillClimbResults.length - 1;
      elements.hillClimbNext.title = hasResults
        ? "Show the next hill-climb result."
        : "Run Hill-Climb before paging results.";
    }

    if (elements.hillClimbResultLabel) {
      elements.hillClimbResultLabel.textContent = hasResults
        ? hillClimbResultSummary(currentHillClimbResult())
        : "";
    }
  }

  function levelHasGem() {
    const cells = arguments.length > 0 ? arguments[0] : state.cells;

    return cells.some((row) =>
      row.some((cell) => getCellTools(cell).some((tool) => tool.name === "gem"))
    );
  }

  function levelHasPlayer() {
    const cells = arguments.length > 0 ? arguments[0] : state.cells;

    return cells.some((row) =>
      row.some((cell) =>
        getCellTools(cell).some((tool) => tool.name === "player" || tool.name === "circle_player")
      )
    );
  }

  function gemPlacementSurfaceKey(x, y, elevation) {
    return x + "," + y + "," + Math.max(0, Math.floor(Number(elevation) || 0));
  }

  function gemTerrainSurfaceElevation(layer) {
    const type = layer?.type || "";
    const elevation = Math.max(0, Math.floor(Number(layer?.elevation) || 0));

    if (!type || type === "empty" || type === "hole") {
      return null;
    }

    if (type === "tree") {
      return elevation + 3;
    }

    if (type === "player_lift") {
      return elevation + (layer.raised === true ? 1 : 0);
    }

    if (
      ["wall", "ice_block", "ice_slope", "orange_ice_slope", "shrub", "block_asset", "orange_wall"].includes(
        type
      )
    ) {
      return elevation + 1;
    }

    return elevation;
  }

  function gemPlacementSurfaceSets(cells = state.cells) {
    return gemPlacementSurfaceSetsFromPlayData(buildEditorPlayData({ cells, includeGems: false }));
  }

  function gemPlacementSurfaceSetsFromPlayData(playData) {
    const blockedSurfaces = new Set();
    const validSurfaces = new Set();

    playData.terrain.forEach((row, y) => {
      row.forEach((terrain, x) => {
        const layers = Array.isArray(terrain?.layers) ? terrain.layers : [];

        layers.forEach((layer) => {
          const surfaceElevation = gemTerrainSurfaceElevation(layer);

          if (surfaceElevation !== null) {
            validSurfaces.add(gemPlacementSurfaceKey(x, y, surfaceElevation));
          }
        });
      });
    });

    playData.actors.forEach((actor) => {
      if (actor.type === "gem") {
        return;
      }

      const elevation = Math.max(0, Math.floor(Number(actor.elevation) || 0));
      blockedSurfaces.add(gemPlacementSurfaceKey(actor.x, actor.y, elevation));

      if (["box", "floating_floor", "weightless_box"].includes(actor.type)) {
        validSurfaces.add(gemPlacementSurfaceKey(actor.x, actor.y, elevation + 1));
      }
    });

    return { blockedSurfaces, validSurfaces };
  }

  function gemPlacementValueForCell(x, y, elevation = 0) {
    return gemPlacementValueForCells(state.cells, x, y, elevation);
  }

  function gemPlacementValueForCells(cells, x, y, elevation = 0) {
    const gemToken = toolByName.get("gem")?.token || "G";
    return setCellElevationToken(cells[y]?.[x] ?? emptyCellToken, gemToken, elevation);
  }

  function stripGemFromCellValue(value) {
    const gemToken = toolByName.get("gem")?.token || "G";
    const tokens = getCellTokens(value).filter((token) => token !== gemToken);

    return normalizeAuthoringCellValue(
      tokens.some((token) => token.length > 0)
        ? tokens.join(authorData.blockAdder)
        : emptyCellToken
    );
  }

  function buildEditorPlayData(options = {}) {
    return buildPlayData({
      cameraView: options.cameraView || null,
      cells: options.cells || state.cells,
      disableHorizontalNeighborFetches:
        options.disableHorizontalNeighborFetches === true,
      editorRender: options.editorRender === true,
      gameId: authorData.game.id,
      height: state.height,
      includeGems: options.includeGems,
      levelId: options.levelId || "__editor_solver__",
      levelLabel: options.levelLabel || state.levelId,
      sourceFileName: state.fileName,
      width: state.width,
      worldColumns: options.worldColumns || null,
      worldRows: options.worldRows || null
    });
  }

  function isSolverPlayerActor(actor) {
    return actor?.type === "player" || actor?.type === "circle_player";
  }

  function createSolverEngine(playData) {
    const mazeEngine = window.MazeEngine;

    if (!mazeEngine || typeof mazeEngine.createEngine !== "function") {
      throw new Error("Solver engine is not available.");
    }

    return mazeEngine.createEngine(playData);
  }

  function getMazeSolver() {
    const mazeSolver = window.MazeSolver;

    if (
      !mazeSolver ||
      typeof mazeSolver.solveWithAStar !== "function" ||
      typeof mazeSolver.findHardestGemPlacement !== "function"
    ) {
      throw new Error("Solver module is not available.");
    }

    return mazeSolver;
  }

  function formatStateCount(value) {
    return Math.max(0, value).toLocaleString("en-US");
  }

  function getSolverMaxExpandedStates() {
    const value = Number(elements.solverMaxStates.value);

    if (!Number.isFinite(value) || value < 1) {
      return defaultSolverMaxExpandedStates;
    }

    return Math.max(1, Math.floor(value));
  }

  function normalizeSolverMaxExpandedStatesInput() {
    const maxExpandedStates = getSolverMaxExpandedStates();

    elements.solverMaxStates.value = String(maxExpandedStates);

    return maxExpandedStates;
  }

  function getSolverAlgorithm() {
    return "astar";
  }

  function solverAlgorithmLabel(algorithm = getSolverAlgorithm()) {
    return "A*";
  }

  function getSolverMode() {
    return state.solverMode === "place_gem" || state.solverMode === "reach_gem"
      ? state.solverMode
      : null;
  }

  function selectSolverMode(mode) {
    if (state.isSolverBusy || state.isSolutionPlaying) return;
    if (mode === "reach_gem" && !levelHasGem()) {
      setStatus("Reach Gem needs a gem on the board.", "warning");
      state.solverMode = null;
    } else {
      state.solverMode = mode === "place_gem" ? "place_gem" : mode === "reach_gem" ? "reach_gem" : null;
    }
    syncSolverButtonState();
  }

  function getHillClimbMode() {
    return elements.hillClimbMode?.value === "fixed_gem" ? "fixed_gem" : "place_gem";
  }

  function hillClimbModeLabel(mode = getHillClimbMode()) {
    return mode === "fixed_gem" ? "Fixed Gem" : "Place Gem";
  }

  function createSolverAbortController() {
    if (typeof window.AbortController === "function") {
      return new window.AbortController();
    }

    const signal = { aborted: false };

    return {
      signal,
      abort() {
        signal.aborted = true;
      }
    };
  }

  function performanceNow() {
    return window.performance && typeof window.performance.now === "function"
      ? window.performance.now()
      : Date.now();
  }

  function beginSolverRun(label, options = {}) {
    if (options.preserveContinuation !== true) {
      clearSolverContinuation();
    }
    clearSolverGhostOverlay();
    state.solverAbortController = createSolverAbortController();
    state.isSolverBusy = true;
    showSolverDock(label);
    syncSolverButtonState();
    return state.solverAbortController.signal;
  }

  function finishSolverRun() {
    state.isSolverBusy = false;
    state.solverAbortController = null;
    hideSolverProgress();
    syncSolverButtonState();
  }

  function isSolverCancelError(error) {
    return Boolean(error && (error.name === "AbortError" || error.message === "Solver cancelled."));
  }

  function cancelSolverRun() {
    if (!state.isSolverBusy || !state.solverAbortController) {
      return;
    }

    state.solverAbortController.abort();
    // Worker runs die instantly; main-thread fallbacks stop at the next yield.
    abortActiveSolverWorkerJob();
    if (solverDock.cancelButton) {
      solverDock.cancelButton.disabled = true;
      solverDock.cancelButton.setAttribute("aria-label", "Cancelling solver");
      solverDock.cancelButton.title = "Cancelling solver";
    }
    setStatus("Cancelling solver...", "warning");
    syncSolverButtonState();
  }

  function nextSolverProgressFrame() {
    return new Promise((resolve) => {
      // Hidden tabs never fire requestAnimationFrame and clamp timers to a
      // second, which would slow a run to a crawl; a message-channel hop
      // yields the event loop there without either penalty. Visible tabs get
      // a real paint frame so progress stays smooth.
      if (document.hidden || typeof window.requestAnimationFrame !== "function") {
        const channel = new MessageChannel();

        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(0);
        return;
      }

      window.requestAnimationFrame(() => resolve());
    });
  }

  // ---- Solver run dock ----
  // A drop-down panel under the topbar that appears for every solver run:
  // progress, elapsed time, instant cancel, and the experimental-engine note.
  // Generated here so every host page gets it without new required markup.
  const solverDock = {
    actions: null,
    bar: null,
    cancelButton: null,
    continueButton: null,
    continueGroup: null,
    continueInput: null,
    elapsed: null,
    element: null,
    exportBar: null,
    exportButton: null,
    exportFormat: null,
    exportGroup: null,
    exportLabel: null,
    exportProgress: null,
    exportTrack: null,
    harderButton: null,
    harderInfoButton: null,
    ghostButton: null,
    hideFinalizeTimer: 0,
    hideTimer: 0,
    layoutAnimation: null,
    minimizeButton: null,
    minimized: false,
    path: null,
    playbackButton: null,
    resizeObserver: null,
    startedAt: 0,
    status: "idle",
    stopPlaybackButton: null,
    text: null,
    tickTimer: 0,
    track: null
  };

  const SOLVER_DOCK_CSS = [
    ".solver-dock {",
    "  backdrop-filter: blur(8px);",
    "  background: rgba(5, 8, 18, 0.94);",
    "  border: 1px solid rgba(var(--cyan-rgb, 84, 240, 255), 0.45);",
    "  border-radius: 14px;",
    "  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.55), 0 0 22px rgba(var(--cyan-rgb, 84, 240, 255), 0.16);",
    "  color: var(--ink, #e7eaff);",
    "  display: grid;",
    "  gap: 9px;",
    "  left: 50%;",
    "  opacity: 0;",
    "  padding: 12px 14px;",
    "  pointer-events: none;",
    "  position: fixed;",
    "  top: 74px;",
    "  transform: translateX(-50%) translateY(-14px);",
    "  transition: opacity 200ms ease, transform 220ms ease;",
    "  width: min(94vw, 540px);",
    "  z-index: 60;",
    "}",
    ".solver-dock[hidden] { display: none; }",
    ".solver-dock.is-open { opacity: 1; pointer-events: auto; transform: translateX(-50%) translateY(0); }",
    ".solver-dock.is-layout-tweening { overflow: hidden; will-change: height, width; }",
    ".solver-dock__head { align-items: center; display: flex; gap: 8px; }",
    ".solver-dock__title {",
    "  font-family: var(--font-display, inherit);",
    "  font-size: 13px;",
    "  font-weight: 800;",
    "  letter-spacing: 0.08em;",
    "  text-transform: uppercase;",
    "}",
    ".solver-dock__badge {",
    "  background: rgba(var(--amber-rgb, 255, 193, 84), 0.12);",
    "  border: 1px solid rgba(var(--amber-rgb, 255, 193, 84), 0.65);",
    "  border-radius: 999px;",
    "  color: var(--amber, #ffc154);",
    "  font-family: var(--font-mono, monospace);",
    "  font-size: 10px;",
    "  letter-spacing: 0.1em;",
    "  padding: 2px 8px;",
    "  text-transform: uppercase;",
    "}",
    ".solver-dock__elapsed {",
    "  color: var(--muted, #9aa3c7);",
    "  font-family: var(--font-mono, monospace);",
    "  font-size: 11px;",
    "  margin-left: auto;",
    "}",
    ".solver-dock__cancel {",
    "  background: rgba(8, 11, 26, 0.85);",
    "  border: 1px solid rgba(var(--magenta-rgb, 255, 84, 170), 0.55);",
    "  border-radius: 9px;",
    "  color: var(--ink, #e7eaff);",
    "  cursor: pointer;",
    "  height: 34px;",
    "  padding: 0;",
    "  transition: border-color 150ms ease, box-shadow 150ms ease, background 150ms ease;",
    "  width: 34px;",
    "}",
    ".solver-dock__cancel:hover:not(:disabled),",
    ".solver-dock__cancel:focus-visible {",
    "  background: rgba(var(--magenta-rgb, 255, 84, 170), 0.12);",
    "  border-color: rgba(var(--magenta-rgb, 255, 84, 170), 0.9);",
    "  box-shadow: 0 0 14px rgba(var(--magenta-rgb, 255, 84, 170), 0.3);",
    "  outline: none;",
    "}",
    ".solver-dock__cancel:disabled { color: var(--muted, #9aa3c7); cursor: default; opacity: 0.7; }",
    ".solver-dock__minimize { background: rgba(var(--cyan-rgb, 84, 240, 255), 0.08); border: 1px solid rgba(var(--cyan-rgb, 84, 240, 255), 0.42); border-radius: 9px; color: var(--ink, #e7eaff); cursor: pointer; height: 34px; padding: 0; width: 34px; }",
    ".solver-dock__minimize:hover:not(:disabled), .solver-dock__minimize:focus-visible { background: rgba(var(--cyan-rgb, 84, 240, 255), 0.13); border-color: rgba(var(--cyan-rgb, 84, 240, 255), 0.86); box-shadow: 0 0 12px rgba(var(--cyan-rgb, 84, 240, 255), 0.22); outline: none; }",
    ".solver-dock__minimize:disabled { cursor: default; opacity: 0.48; }",
    ".solver-dock__minimize[hidden] { display: none; }",
    ".solver-dock__cancel, .solver-dock__minimize, .solver-dock__ghost, .solver-dock__stop-playback { align-items: center; display: inline-flex; flex: 0 0 auto; justify-content: center; }",
    ".solver-dock__icon { height: 17px; pointer-events: none; width: 17px; }",
    ".solver-dock__icon--maximize { display: none; }",
    ".solver-dock__track {",
    "  background: rgba(124, 143, 255, 0.14);",
    "  border: 1px solid rgba(124, 143, 255, 0.3);",
    "  border-radius: 999px;",
    "  height: 10px;",
    "  overflow: hidden;",
    "}",
    ".solver-dock__bar {",
    "  background: linear-gradient(90deg, rgba(var(--cyan-rgb, 84, 240, 255), 0.9), rgba(var(--violet-rgb, 124, 143, 255), 0.9));",
    "  border-radius: 999px;",
    "  box-shadow: 0 0 12px rgba(var(--cyan-rgb, 84, 240, 255), 0.5);",
    "  height: 100%;",
    "  transition: width 120ms linear;",
    "  width: 0%;",
    "}",
    ".solver-dock__text { color: var(--ink, #e7eaff); font-family: var(--font-mono, monospace); font-size: 11px; margin: 0; }",
    ".solver-dock__path { color: var(--cyan, #54f0ff); font-family: var(--font-mono, monospace); font-size: 11px; letter-spacing: 0.1em; line-height: 1.5; margin: 0; overflow-wrap: anywhere; user-select: all; }",
    ".solver-dock__path:empty { display: none; }",
    ".solver-dock__actions { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; }",
    ".solver-dock__actions[hidden] { display: none; }",
    ".solver-dock__continue { align-items: center; display: inline-flex; flex-wrap: wrap; gap: 7px; }",
    ".solver-dock__continue[hidden] { display: none; }",
    ".solver-dock__continue label { align-items: center; color: var(--muted, #9aa3c7); display: inline-flex; font: 11px var(--font-mono, monospace); gap: 6px; }",
    ".solver-dock__continue-input { background: rgba(10, 13, 31, 0.72); border: 1px solid rgba(var(--cyan-rgb, 84, 240, 255), 0.42); border-radius: 9px; color: var(--ink, #e7eaff); font: 11px var(--font-mono, monospace); height: 34px; padding: 0 9px; width: 112px; }",
    ".solver-dock__continue-button { background: rgba(var(--green-rgb, 88, 255, 178), 0.1); border: 1px solid rgba(var(--green-rgb, 88, 255, 178), 0.58); border-radius: 9px; color: var(--ink, #e7eaff); cursor: pointer; font: inherit; font-size: 12px; font-weight: 750; min-height: 34px; padding: 6px 12px; }",
    ".solver-dock__continue-button:hover:not(:disabled), .solver-dock__continue-button:focus-visible { border-color: rgba(var(--green-rgb, 88, 255, 178), 0.95); box-shadow: 0 0 14px rgba(var(--green-rgb, 88, 255, 178), 0.24); outline: none; }",
    ".solver-dock__continue-input:disabled, .solver-dock__continue-button:disabled { cursor: default; opacity: 0.48; }",
    ".solver-dock__playback { background: rgba(var(--cyan-rgb, 84, 240, 255), 0.14); border: 1px solid rgba(var(--cyan-rgb, 84, 240, 255), 0.7); border-radius: 9px; color: var(--ink, #e7eaff); cursor: pointer; font: inherit; font-size: 12px; font-weight: 750; min-height: 34px; padding: 6px 12px; }",
    ".solver-dock__playback:hover, .solver-dock__playback:focus-visible { border-color: rgba(var(--cyan-rgb, 84, 240, 255), 1); box-shadow: 0 0 14px rgba(var(--cyan-rgb, 84, 240, 255), 0.27); outline: none; }",
    ".solver-dock__stop-playback { background: rgba(var(--magenta-rgb, 255, 84, 170), 0.09); border: 1px solid rgba(var(--magenta-rgb, 255, 84, 170), 0.58); border-radius: 9px; color: var(--ink, #e7eaff); cursor: pointer; height: 34px; padding: 0; transition: background 150ms ease, border-color 150ms ease, box-shadow 150ms ease; width: 34px; }",
    ".solver-dock__stop-playback:hover:not(:disabled), .solver-dock__stop-playback:focus-visible { background: rgba(var(--magenta-rgb, 255, 84, 170), 0.16); border-color: rgba(var(--magenta-rgb, 255, 84, 170), 0.95); box-shadow: 0 0 14px rgba(var(--magenta-rgb, 255, 84, 170), 0.3); outline: none; }",
    ".solver-dock__ghost { background: rgba(124, 143, 255, 0.07); border: 1px solid rgba(124, 143, 255, 0.38); border-radius: 9px; color: var(--muted, #9aa3c7); cursor: pointer; height: 34px; padding: 0; transition: border-color 150ms ease, box-shadow 150ms ease, color 150ms ease; width: 34px; }",
    ".solver-dock__ghost:hover:not(:disabled), .solver-dock__ghost:focus-visible { border-color: rgba(var(--cyan-rgb, 84, 240, 255), 0.78); color: var(--ink, #e7eaff); outline: none; }",
    ".solver-dock__ghost[aria-pressed='true'] { border-color: rgba(var(--cyan-rgb, 84, 240, 255), 0.78); box-shadow: 0 0 12px rgba(var(--cyan-rgb, 84, 240, 255), 0.28); color: var(--cyan, #54f0ff); }",
    ".solver-dock__playback[hidden], .solver-dock__ghost[hidden], .solver-dock__stop-playback[hidden] { display: none; }",
    ".solver-dock__playback:disabled, .solver-dock__ghost:disabled, .solver-dock__stop-playback:disabled, .solver-dock__harder:disabled { cursor: default; opacity: 0.48; }",
    ".solver-dock__exports { align-items: center; display: inline-flex; gap: 6px; }",
    ".solver-dock__exports[hidden] { display: none; }",
    ".solver-dock__export-format { appearance: none; background: rgba(10, 13, 31, 0.72); border: 1px solid rgba(var(--green-rgb, 88, 255, 178), 0.42); border-radius: 9px; color: var(--ink, #e7eaff); cursor: pointer; font: inherit; font-size: 11px; font-weight: 750; height: 34px; padding: 0 25px 0 10px; }",
    ".solver-dock__export-select { position: relative; }",
    ".solver-dock__export-select::after { border-color: var(--green, #58ffb2) transparent transparent; border-style: solid; border-width: 4px 3.5px 0; content: ''; pointer-events: none; position: absolute; right: 9px; top: calc(50% - 1px); }",
    ".solver-dock__export-format:focus-visible { border-color: rgba(var(--green-rgb, 88, 255, 178), 0.9); box-shadow: 0 0 12px rgba(var(--green-rgb, 88, 255, 178), 0.18); outline: none; }",
    ".solver-dock__export { background: rgba(var(--green-rgb, 88, 255, 178), 0.08); border: 1px solid rgba(var(--green-rgb, 88, 255, 178), 0.5); border-radius: 9px; color: var(--ink, #e7eaff); cursor: pointer; font: inherit; font-size: 11px; font-weight: 700; min-height: 34px; padding: 6px 10px; }",
    ".solver-dock__export:hover:not(:disabled), .solver-dock__export:focus-visible { background: rgba(var(--green-rgb, 88, 255, 178), 0.14); border-color: rgba(var(--green-rgb, 88, 255, 178), 0.9); box-shadow: 0 0 14px rgba(var(--green-rgb, 88, 255, 178), 0.2); outline: none; }",
    ".solver-dock__export:disabled { cursor: default; opacity: 0.48; }",
    ".solver-dock__export-progress { background: rgba(3, 6, 16, 0.68); border: 1px solid rgba(124, 143, 255, 0.2); border-radius: 10px; display: grid; gap: 7px; padding: 8px 10px; }",
    ".solver-dock__export-progress[hidden] { display: none; }",
    ".solver-dock__export-progress-copy { align-items: center; display: flex; font-family: var(--font-mono, monospace); font-size: 10px; gap: 8px; justify-content: space-between; }",
    ".solver-dock__export-progress-copy strong { color: var(--green, #58ffb2); font-size: 10px; }",
    ".solver-dock__export-progress-label { color: var(--muted, #9aa3c7); text-align: right; }",
    ".solver-dock__export-track { background: rgba(124, 143, 255, 0.16); border: 1px solid rgba(124, 143, 255, 0.24); border-radius: 999px; height: 8px; overflow: hidden; }",
    ".solver-dock__export-bar { background: linear-gradient(90deg, var(--green, #58ffb2), var(--cyan, #54f0ff)); border-radius: 999px; box-shadow: 0 0 10px rgba(var(--green-rgb, 88, 255, 178), 0.34); height: 100%; transition: width 320ms ease; width: 0%; }",
    ".solver-dock__harder-group { align-items: center; display: inline-flex; gap: 7px; margin-left: auto; }",
    ".solver-dock__harder-group[hidden] { display: none; }",
    ".solver-dock__harder { background: rgba(var(--cyan-rgb, 84, 240, 255), 0.1); border: 1px solid rgba(var(--cyan-rgb, 84, 240, 255), 0.58); border-radius: 9px; color: var(--ink, #e7eaff); cursor: pointer; font: inherit; font-size: 12px; font-weight: 700; min-height: 34px; padding: 6px 12px; }",
    ".solver-dock__harder:hover, .solver-dock__harder:focus-visible { border-color: rgba(var(--cyan-rgb, 84, 240, 255), 0.92); box-shadow: 0 0 14px rgba(var(--cyan-rgb, 84, 240, 255), 0.24); outline: none; }",
    ".solver-dock__info { align-items: center; background: transparent; border: 1px solid rgba(var(--cyan-rgb, 84, 240, 255), 0.48); border-radius: 999px; color: var(--cyan, #54f0ff); cursor: pointer; display: inline-flex; font-family: var(--font-mono, monospace); font-size: 11px; font-style: italic; height: 27px; justify-content: center; min-height: 0; min-width: 0; padding: 0; width: 27px; }",
    ".solver-dock__info:hover, .solver-dock__info:focus-visible { background: rgba(var(--cyan-rgb, 84, 240, 255), 0.12); box-shadow: 0 0 12px rgba(var(--cyan-rgb, 84, 240, 255), 0.22); outline: none; }",
    ".solver-dock.is-failed { border-color: rgba(var(--magenta-rgb, 255, 84, 170), 0.48); box-shadow: 0 14px 40px rgba(0, 0, 0, 0.55), 0 0 22px rgba(var(--magenta-rgb, 255, 84, 170), 0.12); }",
    ".solver-dock.is-minimized { align-items: center; display: flex; gap: 7px; padding: 5px 8px; }",
    ".solver-dock.is-minimized .solver-dock__head, .solver-dock.is-minimized .solver-dock__actions { display: contents; }",
    ".solver-dock.is-minimized .solver-dock__badge, .solver-dock.is-minimized .solver-dock__elapsed, .solver-dock.is-minimized .solver-dock__track, .solver-dock.is-minimized .solver-dock__text, .solver-dock.is-minimized .solver-dock__path, .solver-dock.is-minimized .solver-dock__ghost, .solver-dock.is-minimized .solver-dock__exports, .solver-dock.is-minimized .solver-dock__continue, .solver-dock.is-minimized .solver-dock__harder-group, .solver-dock.is-minimized .solver-dock__export-progress { display: none; }",
    ".solver-dock.is-minimized .solver-dock__title { font-size: 11px; order: 1; white-space: nowrap; }",
    ".solver-dock.is-minimized .solver-dock__playback { min-height: 30px; order: 2; padding: 4px 9px; white-space: nowrap; }",
    ".solver-dock.is-minimized .solver-dock__stop-playback { order: 3; }",
    ".solver-dock.is-minimized .solver-dock__minimize { order: 4; }",
    ".solver-dock.is-minimized .solver-dock__cancel { order: 5; }",
    ".solver-dock.is-minimized .solver-dock__icon--minimize { display: none; }",
    ".solver-dock.is-minimized .solver-dock__icon--maximize { display: block; }",
    ".solver-dock.is-minimized .solver-dock__actions[hidden], .solver-dock.is-minimized .solver-dock__playback[hidden] { display: none; }"
  ].join("\n");

  function ensureSolverDock() {
    if (solverDock.element) {
      return solverDock;
    }

    const style = document.createElement("style");
    style.textContent = SOLVER_DOCK_CSS;
    document.head.append(style);

    const dock = document.createElement("section");
    dock.className = "solver-dock";
    dock.setAttribute("aria-live", "polite");
    dock.setAttribute("aria-label", "Solver run");
    dock.hidden = true;
    dock.innerHTML =
      '<div class="solver-dock__head">' +
      '<span class="solver-dock__title">Solver</span>' +
      '<span class="solver-dock__badge" title="Engine v0.1 — expect rough edges">Experimental</span>' +
      '<span class="solver-dock__elapsed">0.0s</span>' +
      '<button class="solver-dock__minimize" type="button" aria-label="Minimize solver panel" aria-expanded="true" title="Minimize solver panel" hidden>' +
      solverMinimizeIconSvg + solverMaximizeIconSvg +
      '</button>' +
      '<button class="solver-dock__cancel" type="button" aria-label="Cancel solver" title="Cancel solver">' +
      solverDismissIconSvg +
      '</button>' +
      "</div>" +
      '<div class="solver-dock__track" role="progressbar" aria-label="Solver search progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
      '<div class="solver-dock__bar"></div>' +
      "</div>" +
      '<p class="solver-dock__text">Starting search...</p>' +
      '<code class="solver-dock__path"></code>' +
      '<div class="solver-dock__actions" hidden>' +
      '<span class="solver-dock__continue" hidden>' +
      '<label>More states <input class="solver-dock__continue-input" type="number" min="1" step="1" inputmode="numeric" aria-label="Additional solver search states"></label>' +
      '<button class="solver-dock__continue-button" type="button">Continue Search</button>' +
      '</span>' +
      '<button class="solver-dock__playback" type="button" hidden>Play Solution</button>' +
      '<button class="solver-dock__stop-playback" type="button" aria-label="Stop solution playback" title="Stop solution playback" hidden>' +
      solverStopIconSvg +
      '</button>' +
      '<button class="solver-dock__ghost" type="button" aria-label="Show ghost path" aria-pressed="false" title="Show ghost path" hidden>' +
      solverGhostIconSvg +
      '</button>' +
      '<span class="solver-dock__exports" hidden>' +
      '<label class="solver-dock__export-select">' +
      '<select class="solver-dock__export-format" aria-label="Solution export format"><option value="mp4">MP4</option><option value="gif">GIF</option></select>' +
      '</label>' +
      '<button class="solver-dock__export" type="button">Download</button>' +
      '</span>' +
      '<span class="solver-dock__harder-group" hidden>' +
      '<button class="solver-dock__harder" type="button">Make Level Harder</button>' +
      '<button class="solver-dock__info" type="button" data-panel-info-title="Make Level Harder" data-panel-info-description="Tests adding exactly one block, then moves the gem only when A* verifies a strictly harder reachable placement. If no harder placement is found, the board is left unchanged." aria-label="About Make Level Harder" aria-controls="author-info-popover" aria-expanded="false">i</button>' +
      '</span>' +
      "</div>" +
      '<div class="solver-dock__export-progress" aria-live="polite" hidden>' +
      '<div class="solver-dock__export-progress-copy"><strong>Rendering MP4</strong><span class="solver-dock__export-progress-label">Starting...</span></div>' +
      '<div class="solver-dock__export-track" role="progressbar" aria-label="Solution export progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="solver-dock__export-bar"></div></div>' +
      '</div>';
    document.body.append(dock);

    solverDock.element = dock;
    solverDock.actions = dock.querySelector(".solver-dock__actions");
    solverDock.bar = dock.querySelector(".solver-dock__bar");
    solverDock.cancelButton = dock.querySelector(".solver-dock__cancel");
    solverDock.continueButton = dock.querySelector(".solver-dock__continue-button");
    solverDock.continueGroup = dock.querySelector(".solver-dock__continue");
    solverDock.continueInput = dock.querySelector(".solver-dock__continue-input");
    solverDock.elapsed = dock.querySelector(".solver-dock__elapsed");
    solverDock.exportBar = dock.querySelector(".solver-dock__export-bar");
    solverDock.exportButton = dock.querySelector(".solver-dock__export");
    solverDock.exportFormat = dock.querySelector(".solver-dock__export-format");
    solverDock.exportGroup = dock.querySelector(".solver-dock__exports");
    solverDock.exportLabel = dock.querySelector(".solver-dock__export-progress-label");
    solverDock.exportProgress = dock.querySelector(".solver-dock__export-progress");
    solverDock.exportTrack = dock.querySelector(".solver-dock__export-track");
    solverDock.harderButton = dock.querySelector(".solver-dock__harder");
    solverDock.harderInfoButton = dock.querySelector(".solver-dock__info");
    solverDock.ghostButton = dock.querySelector(".solver-dock__ghost");
    solverDock.minimizeButton = dock.querySelector(".solver-dock__minimize");
    solverDock.path = dock.querySelector(".solver-dock__path");
    solverDock.playbackButton = dock.querySelector(".solver-dock__playback");
    solverDock.stopPlaybackButton = dock.querySelector(".solver-dock__stop-playback");
    solverDock.text = dock.querySelector(".solver-dock__text");
    solverDock.track = dock.querySelector(".solver-dock__track");
    solverDock.cancelButton.addEventListener("click", () => {
      if (state.isSolverBusy) cancelSolverRun();
      else dismissSolverDock();
    });
    solverDock.continueButton.addEventListener("click", continueSolverSearch);
    solverDock.harderButton.addEventListener("click", makeLevelHarder);
    solverDock.playbackButton.addEventListener("click", playSolution);
    solverDock.stopPlaybackButton.addEventListener("click", stopSolutionPlayback);
    solverDock.minimizeButton.addEventListener("click", () => {
      setSolverDockMinimized(!solverDock.minimized);
    });
    solverDock.exportButton.addEventListener("click", () => {
      downloadSolutionExport(solverDock.exportFormat.value);
    });
    solverDock.ghostButton.addEventListener("click", () => {
      setSolverGhostVisible(!state.solverGhostVisible);
    });
    solverDock.harderInfoButton.addEventListener("click", (event) => {
      event.preventDefault();
      openAuthorInfoPopover(solverDock.harderInfoButton);
    });
    if (typeof window.ResizeObserver === "function" && elements.gridShell) {
      solverDock.resizeObserver = new window.ResizeObserver(positionSolverDock);
      solverDock.resizeObserver.observe(elements.gridShell);
    }

    return solverDock;
  }

  function setSolverDockMinimized(minimized, options = {}) {
    const dock = ensureSolverDock();
    const nextMinimized = minimized === true && hasPlayableSolution();
    let startRect = dock.element.getBoundingClientRect();

    if (dock.layoutAnimation) {
      startRect = dock.element.getBoundingClientRect();
      dock.layoutAnimation.cancel();
      dock.layoutAnimation = null;
      dock.element.classList.remove("is-layout-tweening");
    }

    if (dock.minimized === nextMinimized) {
      syncSolverDockControls();
      positionSolverDock();
      return;
    }

    dock.minimized = nextMinimized;
    dock.element.classList.toggle("is-minimized", dock.minimized);
    syncSolverDockControls();
    positionSolverDock();

    const endRect = dock.element.getBoundingClientRect();
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const shouldTween =
      options.animate !== false &&
      !dock.element.hidden &&
      typeof dock.element.animate === "function" &&
      !reduceMotion &&
      (Math.abs(startRect.width - endRect.width) > 1 ||
        Math.abs(startRect.height - endRect.height) > 1);

    if (!shouldTween) return;

    dock.element.classList.add("is-layout-tweening");
    const animation = dock.element.animate(
      [
        { height: `${startRect.height}px`, width: `${startRect.width}px` },
        { height: `${endRect.height}px`, width: `${endRect.width}px` }
      ],
      {
        duration: 280,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)"
      }
    );
    dock.layoutAnimation = animation;
    animation.finished
      .catch(() => {})
      .finally(() => {
        if (dock.layoutAnimation !== animation) return;
        dock.layoutAnimation = null;
        dock.element.classList.remove("is-layout-tweening");
      });
  }

  function solverDockTopOffset() {
    const header = document.querySelector(".author-header, .author-topbar");
    const bottom = header ? header.getBoundingClientRect().bottom : 0;

    return Math.max(10, Math.round(bottom + 10));
  }

  function positionSolverDock() {
    if (!solverDock.element || solverDock.element.hidden) return;

    const mapButton = document.getElementById("author-world-map-toggle");
    const sidebarToggle = document.getElementById("author-sidebar-toggle");
    const mapRect = mapButton?.getBoundingClientRect();
    const toggleRect = sidebarToggle?.getBoundingClientRect();
    const workspaceRect = elements.gridShell?.getBoundingClientRect();
    const hasControlBounds =
      mapRect &&
      toggleRect &&
      mapRect.width > 0 &&
      toggleRect.width > 0 &&
      toggleRect.left > mapRect.right;
    const center = hasControlBounds
      ? (mapRect.left + mapRect.width / 2 + toggleRect.left + toggleRect.width / 2) / 2
      : workspaceRect && workspaceRect.width > 0
        ? workspaceRect.left + workspaceRect.width / 2
        : window.innerWidth / 2;
    const availableWidth = hasControlBounds
      ? Math.max(240, toggleRect.left - mapRect.right - 24)
      : Math.max(240, Math.min(window.innerWidth * 0.94, workspaceRect?.width || 540));

    solverDock.element.style.left = Math.round(center) + "px";
    solverDock.element.style.top = solverDockTopOffset() + "px";
    solverDock.element.style.width =
      Math.min(solverDock.minimized ? 280 : 540, availableWidth) + "px";
  }

  function formatSolverElapsed(ms) {
    const seconds = Math.max(0, ms) / 1000;

    if (seconds < 60) {
      return seconds.toFixed(1) + "s";
    }

    const minutes = Math.floor(seconds / 60);
    const rest = Math.floor(seconds % 60);

    return minutes + "m " + String(rest).padStart(2, "0") + "s";
  }

  function updateSolverDockElapsed() {
    if (solverDock.elapsed) {
      solverDock.elapsed.textContent = formatSolverElapsed(performanceNow() - solverDock.startedAt);
    }
  }

  function showSolverDock(label) {
    const dock = ensureSolverDock();

    window.clearTimeout(solverDock.hideTimer);
    window.clearTimeout(solverDock.hideFinalizeTimer);
    window.clearInterval(solverDock.tickTimer);
    dock.element.hidden = false;
    setSolverDockMinimized(false, { animate: false });
    positionSolverDock();
    dock.text.textContent = (label ? label + " · " : "") + "starting search...";
    dock.bar.style.width = "0%";
    dock.track.setAttribute("aria-valuenow", "0");
    dock.cancelButton.disabled = false;
    dock.cancelButton.setAttribute("aria-label", "Cancel solver");
    dock.cancelButton.title = "Cancel solver";
    dock.minimizeButton.hidden = true;
    dock.actions.hidden = true;
    dock.continueGroup.hidden = true;
    dock.exportProgress.hidden = true;
    dock.path.textContent = "";
    dock.status = "running";
    solverDock.startedAt = performanceNow();
    updateSolverDockElapsed();
    solverDock.tickTimer = window.setInterval(updateSolverDockElapsed, 100);
    window.requestAnimationFrame(() => {
      if (!dock.element.hidden) {
        dock.element.classList.add("is-open");
      }
    });
  }

  function renderSolverProgress(label, expanded, maxExpanded) {
    if (!solverDock.element || solverDock.element.hidden) {
      return;
    }

    const safeMax = Math.max(1, maxExpanded);
    const safeExpanded = Math.max(0, Math.min(expanded, safeMax));
    const percent = Math.min(100, (safeExpanded / safeMax) * 100);

    solverDock.bar.style.width = percent.toFixed(1) + "%";
    solverDock.track.setAttribute("aria-valuenow", String(Math.round(percent)));
    solverDock.text.textContent =
      (label ? label + " · " : "") +
      formatStateCount(safeExpanded) +
      " / " +
      formatStateCount(safeMax) +
      " states";
  }

  function hideSolverProgress() {
    if (!solverDock.element) {
      return;
    }

    window.clearInterval(solverDock.tickTimer);
    if (solverDock.status === "running") {
      completeSolverDock({ detail: "Search stopped.", solved: false, title: "Stopped" });
    }
  }

  function dismissSolverDock() {
    if (!solverDock.element) return;
    clearSolverContinuation();
    clearSolverGhostOverlay();
    setSolverDockMinimized(false, { animate: false });
    solverDock.element.classList.remove("is-open");
    window.setTimeout(() => {
      if (!state.isSolverBusy && solverDock.element) solverDock.element.hidden = true;
    }, 240);
  }

  function completeSolverDock(result = {}) {
    const dock = ensureSolverDock();
    window.clearInterval(dock.tickTimer);
    updateSolverDockElapsed();
    dock.status = "complete";
    dock.cancelButton.disabled = false;
    dock.cancelButton.setAttribute("aria-label", "Dismiss solver panel");
    dock.cancelButton.title = "Dismiss solver panel";
    dock.bar.style.width = "100%";
    dock.track.setAttribute("aria-valuenow", "100");
    dock.text.textContent = [result.title, result.detail].filter(Boolean).join(" · ");
    dock.path.textContent = result.path || "";
    const canPlayback = result.canPlayback === true && hasPlayableSolution();
    const canExport = canPlayback && Boolean(authorData.solutionExportApiUrl);
    const canContinue = result.canContinue === true && Boolean(state.solverContinuation);
    dock.continueGroup.hidden = !canContinue;
    if (canContinue) {
      dock.continueInput.value = String(
        Math.max(1, Math.floor(Number(result.additionalStates) || getSolverMaxExpandedStates()))
      );
    }
    dock.playbackButton.hidden = !canPlayback;
    dock.ghostButton.hidden = !canPlayback;
    dock.exportGroup.hidden = !canExport;
    dock.minimizeButton.hidden = !canPlayback;
    dock.element.querySelector(".solver-dock__harder-group").hidden = result.canMakeHarder !== true;
    dock.actions.hidden = !canPlayback && !canContinue && result.canMakeHarder !== true;
    dock.element.classList.toggle("is-failed", result.solved === false);
    syncSolverDockControls();
  }

  // ---- Solver execution (worker first, cooperative main-thread fallback) ----
  const solverWorkerState = {
    activeJob: null,
    broken: false,
    jobId: 0,
    worker: null
  };

  function solverCancelError() {
    return new Error("Solver cancelled.");
  }

  function solverWorkerInfrastructureError(message) {
    const error = new Error(message || "Solver worker unavailable.");
    error.isSolverWorkerInfrastructure = true;

    return error;
  }

  function terminateSolverWorker() {
    if (solverWorkerState.worker) {
      solverWorkerState.worker.terminate();
      solverWorkerState.worker = null;
    }
  }

  function failActiveSolverWorkerJob(error) {
    const job = solverWorkerState.activeJob;

    if (!job) {
      return;
    }

    solverWorkerState.activeJob = null;
    job.reject(error);
  }

  function abortActiveSolverWorkerJob() {
    if (!solverWorkerState.activeJob) {
      return;
    }

    terminateSolverWorker();
    failActiveSolverWorkerJob(solverCancelError());
  }

  function getSolverWorker() {
    if (solverWorkerState.worker) {
      return solverWorkerState.worker;
    }

    const worker = new window.Worker("/author-solver-worker.js");

    worker.onmessage = (event) => {
      const message = event.data || {};
      const job = solverWorkerState.activeJob;

      if (!job || message.id !== job.id) {
        return;
      }

      if (message.type === "progress") {
        job.onProgress?.(message.expanded, message.maxExpanded);
        return;
      }

      if (message.type === "done") {
        solverWorkerState.activeJob = null;
        job.resolve({
          ...(message.result || {}),
          searchContinuation: message.continuationId
            ? { id: String(message.continuationId), kind: "worker" }
            : null
        });
        return;
      }

      if (message.type === "error") {
        solverWorkerState.activeJob = null;
        job.reject(new Error(message.message || "Solver worker failed."));
      }
    };
    worker.onerror = () => {
      // The worker script itself failed (missing file, parse error): retire
      // it and let the current and future runs use the main-thread fallback.
      solverWorkerState.broken = true;
      terminateSolverWorker();
      failActiveSolverWorkerJob(solverWorkerInfrastructureError("Solver worker failed to start."));
    };
    solverWorkerState.worker = worker;

    return worker;
  }

  function runSolverSearchInWorker(op, payload, runOptions) {
    return new Promise((resolve, reject) => {
      let worker;

      try {
        worker = getSolverWorker();
      } catch (error) {
        reject(solverWorkerInfrastructureError(error instanceof Error ? error.message : ""));
        return;
      }

      solverWorkerState.jobId += 1;
      const id = solverWorkerState.jobId;

      solverWorkerState.activeJob = {
        id,
        onProgress: runOptions.onProgress,
        reject,
        resolve
      };

      try {
        const continuation = runOptions.continuation;

        if (continuation?.kind === "worker") {
          worker.postMessage({
            type: "continue",
            id,
            continuationId: continuation.id,
            options: {
              additionalExpandedStates: runOptions.additionalExpandedStates,
              progressYieldStateInterval: solverProgressYieldStateInterval
            }
          });
        } else {
          worker.postMessage({
            type: "run",
            id,
            op,
            playData: payload.playData,
            options: {
              algorithm: payload.algorithm,
              maxExpandedStates: payload.maxExpandedStates,
              progressYieldStateInterval: solverProgressYieldStateInterval,
              surfaces: payload.surfaces || null
            }
          });
        }
      } catch (error) {
        solverWorkerState.activeJob = null;
        reject(solverWorkerInfrastructureError(error instanceof Error ? error.message : ""));
      }
    });
  }

  function serializeGemSurfaceSets(surfaceSets) {
    return {
      blocked: Array.from(surfaceSets.blockedSurfaces),
      height: state.height,
      valid: Array.from(surfaceSets.validSurfaces),
      width: state.width
    };
  }

  function gemSurfacePredicateFromSerialized(surfaces) {
    const validSurfaces = new Set(surfaces?.valid || []);
    const blockedSurfaces = new Set(surfaces?.blocked || []);

    return (x, y, elevation) => {
      if (!isInsideEditorCell(x, y)) {
        return false;
      }

      const key = gemPlacementSurfaceKey(x, y, elevation);

      return validSurfaces.has(key) && !blockedSurfaces.has(key);
    };
  }

  function createCooperativeSolverReporter(onProgress) {
    let lastRenderAt = 0;

    return async function reportSolverProgress(progress, force = false) {
      const now = performanceNow();

      if (!force && now - lastRenderAt < solverProgressRenderIntervalMs) {
        return;
      }

      lastRenderAt = now;
      onProgress?.(progress?.expanded ?? 0, progress?.maxExpanded ?? 1);
      await nextSolverProgressFrame();
    };
  }

  async function runSolverSearchOnMainThread(op, payload, runOptions) {
    const mazeSolver = getMazeSolver();
    const saved = runOptions.continuation?.kind === "main"
      ? runOptions.continuation
      : null;
    const engine = saved?.engine || createSolverEngine(payload.playData);
    const options = {
      additionalExpandedStates: saved ? runOptions.additionalExpandedStates : undefined,
      continuation: saved?.session || null,
      maxExpandedStates: payload.maxExpandedStates,
      onProgress: createCooperativeSolverReporter(runOptions.onProgress),
      progressYieldStateInterval: solverProgressYieldStateInterval,
      signal: runOptions.signal
    };

    let result;

    if (op === "place_gem") {
      result = await mazeSolver.findHardestGemPlacement(engine, {
        ...options,
        canPlaceGemAt: gemSurfacePredicateFromSerialized(payload.surfaces)
      });
    } else {
      result = await mazeSolver.solveWithAStar(engine, { ...options, algorithm: payload.algorithm });
    }

    return {
      ...result,
      searchContinuation: result?.continuation
        ? { engine, kind: "main", session: result.continuation }
        : null
    };
  }

  // Runs one search. Prefers the dedicated worker (keeps the editor free of
  // lag and makes Cancel instant); falls back to the cooperative main-thread
  // path when workers are unavailable or the worker script fails to load.
  async function runSolverSearch(op, payload, runOptions = {}) {
    if (runOptions.signal?.aborted) {
      throw solverCancelError();
    }

    if (typeof window.Worker === "function" && !solverWorkerState.broken) {
      try {
        return await runSolverSearchInWorker(op, payload, runOptions);
      } catch (error) {
        if (!error?.isSolverWorkerInfrastructure) {
          throw error;
        }

        solverWorkerState.broken = true;
        if (runOptions.continuation?.kind === "worker") {
          throw new Error("The worker holding the saved search stopped, so that search cannot continue.");
        }
      }
    }

    return runSolverSearchOnMainThread(op, payload, runOptions);
  }

  function discardSolverSearchContinuation(continuation) {
    if (continuation?.kind !== "worker" || !continuation.id || !solverWorkerState.worker) {
      return;
    }

    solverWorkerState.worker.postMessage({
      type: "discard",
      continuationId: continuation.id
    });
  }

  function clearSolverContinuation() {
    discardSolverSearchContinuation(state.solverContinuation?.search);
    state.solverContinuation = null;
    if (solverDock.continueGroup) {
      solverDock.continueGroup.hidden = true;
    }
  }

  function buildEditorRenderPlayData() {
    return buildEditorPlayData({
      cameraView: {
        width: state.width,
        height: state.height
      },
      editorRender: true,
      disableHorizontalNeighborFetches: hostedWorldDraftMode,
      levelId: state.levelId,
      levelLabel: state.levelId,
      worldColumns,
      worldRows
    });
  }

  function syncEditorCameraDownshift(app = editorRenderer.app) {
    if (!app) {
      return;
    }

    const shellRect = elements.gridShell?.getBoundingClientRect();
    const hotbarRect = elements.hotbar?.getBoundingClientRect();

    if (!shellRect || !hotbarRect || shellRect.height <= 0 || hotbarRect.height <= 0) {
      app.editorCameraDownshiftPx = 0;
      return;
    }

    // The camera moves down by half of the bottom control clearance. That
    // puts the room's center halfway between the top of the editor view and
    // the hotbar's top edge while preserving the existing room scale.
    app.editorCameraDownshiftPx = Math.max(0, shellRect.bottom - hotbarRect.top) / 2;
  }

  function ensureEditorRenderApp(playData) {
    const modules = window.PlayModules || {};

    if (
      typeof modules.createPlayCore !== "function" ||
      typeof modules.registerRenderFunctions !== "function"
    ) {
      return null;
    }

    if (editorRenderer.app) {
      return editorRenderer.app;
    }

    const app = modules.createPlayCore({
      playData,
      canvas: elements.canvas,
      playShell: null,
      playHeader: null,
      playStage: null,
      mazeFrame: null,
      fuzzyToggle: null,
      // The editor drives the camera itself (keyboard + CAM pad below) with
      // the same velocity/easing model the play page uses, so rotation and
      // tilt feel identical everywhere. The renderer's built-in key handler
      // stays off to avoid double-handling.
      enableCameraControls: false
    });

    if (!app) {
      return null;
    }

    modules.registerRenderFunctions(app);
    if (typeof modules.registerGameplayFunctions === "function") {
      modules.registerGameplayFunctions(app);
    }
    app.isEditorRenderApp = true;
    // Render the WHOLE world around the edited room through the same
    // optimized room-group path play mode uses (cached merged groups per
    // room, distance dimming, cheap redraws while painting).
    app.editorWorldView = true;
    app.playSurroundingRadius = 26;
    app.syncEditorCameraDownshift = () => syncEditorCameraDownshift(app);
    app.syncEditorCameraDownshift();
    // Diagnostic handle, matching the other __MAZEBENCH_* globals.
    window.__MAZEBENCH_AUTHOR_APP__ = app;
    if (
      editorBootReveal.state === "pending" &&
      typeof window.__MAZEBENCH_AUTHOR_MARK_READY__ === "function"
    ) {
      // Theme BEFORE the first mesh so the initial frame is already the
      // vector look — no colored flash under the loading cover.
      editorBootReveal.state = "armed";
      app.homeVectorTheme = true;
      app.vectorGlowAmount = 1;
    }
    editorRenderer.app = app;
    return app;
  }

  function boardImageTokens() {
    const tokens = new Set();

    state.cells.forEach((row) => {
      row.forEach((value) => {
        getCellTokens(value).forEach((token) => {
          if (token.length > 0) {
            tokens.add(token);
          }
        });
      });
    });

    return tokens;
  }

  function hasUnpreloadedBoardToken(tokens) {
    for (const token of tokens) {
      if (!editorRenderer.preloadedTokens.has(token)) {
        return true;
      }
    }

    return false;
  }

  function renderEditorScene() {
    // The compositor owns the renderer until its room transition completes.
    // Applying an editor level state here would cancel that animation and
    // strand the author-side input lock.
    if (state.isLevelSwitching) {
      return;
    }

    const playData = buildEditorRenderPlayData();
    const shouldStartNoiseTicker = !editorRenderer.app;
    const app = ensureEditorRenderApp(playData);

    if (!app || typeof app.applyLevelState !== "function") {
      return;
    }

    app.syncEditorCameraDownshift?.();

    app.applyLevelState(playData, {
      deferRender: true,
      immediateCamera: true,
      resetHistory: true,
      resetLevelEntry: true
    });

    if (shouldStartNoiseTicker) {
      app.syncNoiseTicker();
    }

    app.render();

    if (editorBootReveal.state === "armed") {
      editorBootReveal.state = "running";
      runEditorBootReveal(app);
    }

    // Only re-run the image preload pass when the board introduces a token
    // whose imagery has not been preloaded successfully yet.
    const boardTokens = boardImageTokens();

    if (editorRenderer.hasCompletedPreload && !hasUnpreloadedBoardToken(boardTokens)) {
      return;
    }

    const preloadVersion = editorRenderer.preloadVersion + 1;
    editorRenderer.preloadVersion = preloadVersion;

    app.preloadImagesForLevelState(playData)
      .then(() => {
        if (editorRenderer.app === app && editorRenderer.preloadVersion === preloadVersion) {
          editorRenderer.hasCompletedPreload = true;
          boardTokens.forEach((token) => editorRenderer.preloadedTokens.add(token));
          app.render();
        }
      })
      .catch(() => {});
  }

  function markAuthorPageReady() {
    try {
      window.__MAZEBENCH_AUTHOR_MARK_READY__?.();
      window.__MAZEJAM_AUTHOR_MARK_READY__?.();
    } catch {
      // The cover's own fallback timer still lifts it.
    }
  }

  async function runEditorBootReveal(app) {
    const timing = (window.__MAZEBENCH_AUTHOR_BOOT__ = window.__MAZEBENCH_AUTHOR_BOOT__ || {});
    const finishLook = () => {
      editorBootReveal.state = "done";
      timing.fallbackAtMs = Math.round(performance.now());
      app.cameraFlightFitOptions = null;
      app.worldViewUniformBrightness = false;
      app.homeVectorTheme = false;
      app.vectorGlowAmount = 0;
      app.threeRenderer?.setDebugCameraView?.({
        yaw: 0,
        tilt: 0.22,
        zoom: 1,
        mode: "perspective",
        skipRender: true
      });
      app.threeRenderer?.invalidateSceneCache?.();
      app.render();
      revealEditorWorld();
    };
    try {
      if (app.threeRendererReady && typeof app.threeRendererReady.then === "function") {
        await app.threeRendererReady;
      }
      const renderer = app.threeRenderer;
      const reducedMotion =
        window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
      if (
        !renderer ||
        typeof renderer.beginHomeEdgeReveal !== "function" ||
        typeof renderer.setDebugCameraView !== "function" ||
        reducedMotion
      ) {
        finishLook();
        markAuthorPageReady();
        return;
      }
      // The whole world takes part in the boot: neighbor states go in FIRST
      // so the vector-boot frame (rendered behind the loading cover) meshes
      // every room, the camera starts far out over the world's center, and
      // the glow sweep traces the entire world in.
      const primedStates = primeEditorWorldNeighbors();
      // Every GLB the world references loads BEHIND the loading cover
      // (capped so a broken asset can't strand it) — a model arriving
      // mid-sweep would re-mesh the world and stutter the glow.
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
      app.worldViewUniformBrightness = true;
      // Same vista vantage as the play routes: room fit at HOME_PAN
      // tilt/zoom (the dive itself brings in the world-frame fit, exactly
      // like flyCameraToRoom's "home-overview" source frame).
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
      markAuthorPageReady();
      timing.sweepStartedAtMs = Math.round(performance.now());
      renderer.beginHomeEdgeReveal({
        onComplete: () => {
          timing.sweepDoneAtMs = Math.round(performance.now());
          // Dive from the world vista down onto the edited room while the
          // glow melts — the same construction-then-dive the play routes
          // land with.
          editorDiveIntoRoom(app, () => {
            editorBootReveal.state = "done";
            timing.meltDoneAtMs = Math.round(performance.now());
            revealEditorWorld();
          });
        }
      });
    } catch {
      finishLook();
      markAuthorPageReady();
    }
  }


  function scheduleEditorSceneRender() {
    if (editorRenderer.sceneFrameId !== null) {
      return;
    }

    editorRenderer.sceneFrameId = window.requestAnimationFrame(() => {
      editorRenderer.sceneFrameId = null;
      renderEditorScene();
    });
  }

  function cancelScheduledEditorSceneRender() {
    if (editorRenderer.sceneFrameId === null) {
      return;
    }

    window.cancelAnimationFrame(editorRenderer.sceneFrameId);
    editorRenderer.sceneFrameId = null;
  }

  function setStatus(message, tone) {
    state.message = message;
    state.messageTone = tone || "warning";
    renderStatus();
  }

  function renderStatus() {
    const isChangingLevel = state.isLevelLoading || state.isLevelSwitching;

    elements.status.textContent = state.message;
    elements.status.className = "author-status is-" + state.messageTone;
    // The Save button carries the dirty state: amber + pulsing dot while
    // there are unsaved changes, quiet "Saved" once everything is stored.
    if (elements.saveLevel) {
      elements.saveLevel.disabled = !state.isDirty || isChangingLevel;
      elements.saveLevel.textContent = state.isDirty ? "Save" : "Saved";
      elements.saveLevel.classList.toggle("has-unsaved", state.isDirty);
    }
    elements.grid.setAttribute("aria-busy", isChangingLevel ? "true" : "false");
    renderWorldStats();
    syncUndoButtonState();
  }

  function gemCountForCells(cells) {
    let count = 0;
    (cells || []).forEach((row) => {
      row.forEach((cell) => {
        String(cell || "")
          .split(/[+\s]+/)
          .forEach((token) => {
            if (token === "G") {
              count += 1;
            }
          });
      });
    });
    return count;
  }

  function currentLevelGemCount() {
    return gemCountForCells(state.cells);
  }

  function formatWorldUpdatedAt(value) {
    if (!value) {
      return "--";
    }
    const parsed = new Date(String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "Z"));
    if (Number.isNaN(parsed.getTime())) {
      return String(value);
    }
    return parsed.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function renderWorldStats() {
    const meta = authorData.worldMeta;
    const sizeEl = document.getElementById("world-stat-size");
    if (!meta || !sizeEl) {
      return;
    }
    const gemsByLevel = { ...meta.gemsByLevel, [state.levelId]: currentLevelGemCount() };
    const totalGems = Object.values(gemsByLevel).reduce((sum, value) => sum + (value || 0), 0);
    sizeEl.textContent = meta.width + " × " + meta.height + " rooms";
    const gemsEl = document.getElementById("world-stat-gems");
    if (gemsEl) {
      gemsEl.textContent = String(totalGems);
    }
    const updatedEl = document.getElementById("world-stat-updated");
    if (updatedEl) {
      updatedEl.textContent = state.isDirty
        ? "Unsaved changes"
        : meta.savedThisSession
          ? "Just now"
          : formatWorldUpdatedAt(meta.updatedAt);
      updatedEl.classList.toggle("is-dirty", state.isDirty);
    }
  }

  function syncSolverButtonState() {
    const hasGem = levelHasGem();
    const hasPlayer = levelHasPlayer();
    const locked = state.isSolverBusy || state.isSolutionPlaying;

    if (state.solverMode === "reach_gem" && !hasGem) {
      state.solverMode = null;
    }
    const mode = getSolverMode();
    const picker = elements.solverModePicker;
    picker.dataset.mode = mode || "";
    picker.classList.toggle("has-selection", Boolean(mode));
    [elements.solverModePlace, elements.solverModeReach].forEach((button) => {
      const selected = button.dataset.solverMode === mode;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-checked", selected ? "true" : "false");
    });
    elements.solverModePlace.disabled = locked;
    elements.solverModeReach.disabled = locked || !hasGem;
    elements.solverModeReach.title = hasGem
      ? "Check whether the existing gem is reachable."
      : "Add a gem before choosing Reach Gem.";
    elements.solverMaxStates.disabled = locked;
    elements.solveLevel.hidden = !mode;
    elements.solveLevel.disabled = locked || !hasPlayer || (mode === "reach_gem" && !hasGem);
    elements.solveLevel.title = locked
      ? "Search is running."
      : !hasPlayer
        ? "Add a player before running the solver."
        : mode === "place_gem"
          ? "Find and place the hardest reachable gem location with A*."
          : "Use A* to reach the existing gem.";
    if (elements.solverModeHint) {
      elements.solverModeHint.textContent = hasGem
        ? "Choose whether to place a gem or reach the existing gem."
        : "Reach Gem becomes available when this room contains a gem.";
    }
    if (elements.placeGem) elements.placeGem.disabled = locked || !hasPlayer;
    if (elements.playSolution) elements.playSolution.disabled = locked || !hasPlayableSolution();
    syncSolverDockControls();
    syncHillClimbResultControls();
    syncUndoButtonState();
  }

  function syncLevelSelectors() {
    if (!elements.levelColumn || !elements.levelRow) {
      return;
    }

    const coordinates = parseLevelCoordinates(state.levelId);

    if (!coordinates) {
      return;
    }

    elements.levelColumn.value = coordinates.column;
    elements.levelRow.value = coordinates.row;
  }

  function renderLevelSelectors() {
    if (!elements.levelColumn || !elements.levelRow) {
      return;
    }

    const columnOptions = worldColumns
      .map((letter) => '<option value="' + escapeHtml(letter) + '">' + escapeHtml(letter) + "</option>")
      .join("");
    const rowOptions = worldRows
      .map((letter) => '<option value="' + escapeHtml(letter) + '">' + escapeHtml(letter) + "</option>")
      .join("");

    elements.levelColumn.innerHTML = columnOptions;
    elements.levelRow.innerHTML = rowOptions;
    syncLevelSelectors();
  }

  function selectablePaletteTools() {
    const tools = [noopTool, eraserTool];
    const addedSlopeFamilySuffixes = new Set();

    authorData.palette.forEach((tool) => {
      if (
        tool.selectable === false ||
        tool.name === "hole" ||
        tool.name === "box" ||
        tool.token === "b"
      ) {
        return;
      }

      if (isSlopeFamilyTool(tool)) {
        // Each slope family (plain, black, orange, ...) collapses to one
        // camera-facing entry instead of four directional buttons.
        const family = slopeFamilyForToken(tool.token);

        if (!family || !family.paletteTool || addedSlopeFamilySuffixes.has(family.suffix)) {
          return;
        }

        addedSlopeFamilySuffixes.add(family.suffix);
        tools.push(family.paletteTool);
        return;
      }

      tools.push(tool);
    });

    // Guarantee the three static slope families even if a server payload,
    // custom level parser, or stale catalog omitted their directional rows.
    permanentToolboxSlopeTokens.forEach((token) => {
      const family = slopeFamilyForToken(token);

      if (family?.paletteTool && !addedSlopeFamilySuffixes.has(family.suffix)) {
        addedSlopeFamilySuffixes.add(family.suffix);
        tools.push(family.paletteTool);
      }
    });

    tools.push(...promptPaletteTools);
    return tools;
  }

  // ---- Toolbox (inventory) + bottom hotbar ----
  function isIceSlopeInventoryTool(tool) {
    return (
      slopeTokenStyleSuffix(tool?.token) !== null ||
      tool?.token === blueSlopePromptToken ||
      tool?.token === yellowSlopePromptToken
    );
  }

  const INVENTORY_GROUPS = [
    { match: (tool) => ["select_only", "eraser", "floor", "ice", "wall", "ice_block", "gem"].includes(tool.name), name: "Basics" },
    {
      match: (tool) =>
        !isIceSlopeInventoryTool(tool) &&
        ["player_gate", "player_lift", "orange_wall", "orange_button", "puncher", "floating_floor", "weightless_box"].includes(tool.name),
      name: "Mechanisms"
    },
    {
      match: (tool) =>
        !isIceSlopeInventoryTool(tool) && ["player", "circle_player", "clone"].includes(tool.name),
      name: "Players & Clones"
    },
    { match: isIceSlopeInventoryTool, name: "Ice Slopes" },
    { match: () => true, name: "Scenery" }
  ];

  function inventoryToolPriority(tool) {
    const slopeSuffix = slopeTokenStyleSuffix(tool?.token);

    if (slopeSuffix === "") return 0;
    if (slopeSuffix === "#") return 1;
    if (slopeSuffix === "O") return 2;
    const boxSlopeMatch = /^M([0-4])$/.exec(slopeSuffix || "");
    const cloneSlopeMatch = /^c([0-2])$/.exec(slopeSuffix || "");

    if (boxSlopeMatch) return 10 + Number(boxSlopeMatch[1]);
    if (tool?.token === blueSlopePromptToken) return 15;
    if (cloneSlopeMatch) return 20 + Number(cloneSlopeMatch[1]);
    if (tool?.token === yellowSlopePromptToken) return 23;
    return 100;
  }
  const INVENTORY_DEMO_CLASSES = [
    "demo-gem",
    "demo-shimmer",
    "demo-jab",
    "demo-rise",
    "demo-slide",
    "demo-hop"
  ];
  // Every hotbar slot is replaceable: picking a tool from the toolbox (or the
  // right-click eyedropper) drops it into whichever slot is highlighted.
  const defaultHotbarTokens = [
    noopToken,
    eraserToken,
    toolByName.get("player")?.token || "p",
    toolByName.get("gem")?.token || "G",
    authorData.defaultWallToken || "#",
    authorData.defaultFloorToken || ".",
    toolByName.get("ice")?.token || "i",
    toolByToken.get("M0")?.token || "M0",
    toolByToken.get("M1")?.token || "M1",
    toolByToken.get("l")?.token || "l"
  ];
  const hotbarPersistenceEnabled = Array.isArray(authorData.hotbarTokens);
  const hotbarSlots = normalizeClientHotbarTokens(
    authorData.hotbarTokens,
    defaultHotbarTokens
  );
  let activeHotbarSlotIndex =
    hotbarSlots.indexOf(state.selectedToken) >= 0
      ? hotbarSlots.indexOf(state.selectedToken)
      : Math.max(0, hotbarSlots.length - 1);
  if (!hotbarSlots.includes(state.selectedToken) && hotbarSlots[activeHotbarSlotIndex]) {
    state.selectedToken = hotbarSlots[activeHotbarSlotIndex];
  }
  let savedHotbarTokens = hotbarSlots.slice();
  let savedHotbarSignature = hotbarSignature(savedHotbarTokens);
  let hotbarToolnameTimer = 0;

  function normalizeClientHotbarTokens(tokens, fallbackTokens = defaultHotbarTokens) {
    const normalized = [];
    const seen = new Set();
    for (const rawToken of Array.isArray(tokens) ? tokens : []) {
      const token = String(rawToken || "");
      if (isPromptToolToken(token) || !toolForToken(token) || seen.has(token)) {
        continue;
      }
      seen.add(token);
      normalized.push(token);
      if (normalized.length >= 10) {
        break;
      }
    }
    if (normalized.length > 0) {
      return normalized;
    }
    return (fallbackTokens || [])
      .filter((token, index, values) => toolForToken(token) && values.indexOf(token) === index)
      .slice(0, 10);
  }

  function hotbarSignature(tokens = hotbarSlots) {
    return JSON.stringify(tokens);
  }

  function syncEditorDirtyState() {
    const currentBoardSignature = boardSignature(state.width, state.height, state.cells);
    const savedBoardSignature = hostedWorldDraftMode
      ? hostedSavedLevelSignatures.get(state.levelId) || state.savedBoardSignature
      : state.savedBoardSignature;
    const boardDirty = currentBoardSignature !== savedBoardSignature;
    if (hostedWorldDraftMode) {
      if (boardDirty) {
        hostedDirtyLevelIds.add(state.levelId);
      } else {
        hostedDirtyLevelIds.delete(state.levelId);
      }
    }
    const hotbarDirty =
      hotbarPersistenceEnabled && hotbarSignature() !== savedHotbarSignature;
    state.isDirty = hostedWorldDraftMode
      ? hostedDirtyLevelIds.size > 0 || hotbarDirty
      : boardDirty || hotbarDirty;
    return state.isDirty;
  }

  function rememberPersistedHotbarTokens(tokens, fallbackTokens = savedHotbarTokens) {
    const nextTokens = normalizeClientHotbarTokens(tokens, fallbackTokens);
    savedHotbarTokens = nextTokens.slice();
    savedHotbarSignature = hotbarSignature(savedHotbarTokens);
    return nextTokens;
  }

  function applyPersistedHotbarTokens(tokens, fallbackTokens = savedHotbarTokens) {
    const nextTokens = rememberPersistedHotbarTokens(tokens, fallbackTokens);
    hotbarSlots.splice(0, hotbarSlots.length, ...nextTokens);
    const selectedIndex = hotbarSlots.indexOf(state.selectedToken);
    if (selectedIndex >= 0) {
      activeHotbarSlotIndex = selectedIndex;
    } else {
      activeHotbarSlotIndex = Math.max(
        0,
        Math.min(activeHotbarSlotIndex, hotbarSlots.length - 1)
      );
      state.selectedToken = hotbarSlots[activeHotbarSlotIndex] || state.selectedToken;
    }
  }

  function swapTokenIntoHotbarSlot(slots, targetIndex, token) {
    if (!Array.isArray(slots) || slots.length === 0) {
      return -1;
    }
    const safeTargetIndex = Math.max(0, Math.min(targetIndex, slots.length - 1));
    const sourceIndex = slots.indexOf(token);
    if (sourceIndex === safeTargetIndex) {
      return safeTargetIndex;
    }
    const displacedToken = slots[safeTargetIndex];
    slots[safeTargetIndex] = token;
    if (sourceIndex >= 0) {
      slots[sourceIndex] = displacedToken;
    }
    return safeTargetIndex;
  }

  function toolForToken(token) {
    if (token === noopToken) {
      return noopTool;
    }
    if (token === eraserToken) {
      return eraserTool;
    }
    const promptTool = promptToolsByToken.get(token);
    if (promptTool) {
      return promptTool;
    }
    const suffix = slopeTokenStyleSuffix(token);
    if (suffix !== null) {
      const family = slopeFamiliesBySuffix.get(suffix);
      if (family && family.canonicalToken === token && family.paletteTool) {
        return family.paletteTool;
      }
    }
    return toolByToken.get(token) || materializePatternTool(token) || null;
  }

  function hotbarTokens() {
    return hotbarSlots.slice();
  }

  // Directional slope variants picked up by the eyedropper (Su, Sl, ...)
  // share their family's canonical captured icon instead of sitting blank
  // while no capture of their own exists.
  function slopeFamilyPreviewUrl(token) {
    const suffix = slopeTokenStyleSuffix(token);

    if (suffix === null) {
      return null;
    }

    const canonicalToken = slopeFamiliesBySuffix.get(suffix)?.canonicalToken;

    return canonicalToken && canonicalToken !== token
      ? palettePreviewRenderer.previewsByToken.get(canonicalToken) || null
      : null;
  }

  // A concrete id chosen from an N-family prompt gets its own 3D portrait on
  // demand. Until that capture finishes, show the matching generic N portrait
  // so resolved tools never flash back to the old flat canvas illustration.
  function promptPreviewTokenForPatternToken(token) {
    if (/^M\d+$/.test(token)) return boxPromptToken;
    if (/^c\d+$/.test(token)) return clonePromptToken;
    if (/^S[rlud]M\d+$/.test(token)) return blueSlopePromptToken;
    if (/^S[rlud]c\d+$/.test(token)) return yellowSlopePromptToken;
    return null;
  }

  function promptFamilyPreviewUrl(token) {
    const promptToken = promptPreviewTokenForPatternToken(String(token || ""));
    return promptToken
      ? palettePreviewRenderer.previewsByToken.get(promptToken) || null
      : null;
  }

  function toolSwatchMarkup(tool) {
    if (tool.token === noopToken) {
      return deselectToolIconSvg;
    }
    if (tool.token === eraserToken) {
      return eraserToolIconSvg;
    }
    const previewUrl =
      palettePreviewRenderer.previewsByToken.get(tool.token) ||
      slopeFamilyPreviewUrl(tool.token) ||
      promptFamilyPreviewUrl(tool.token);
    return previewUrl
      ? '<img src="' + escapeHtml(previewUrl) + '" alt="">'
      : '<span class="palette__swatch-placeholder" aria-hidden="true"></span>';
  }

  function renderPalette() {
    if (!elements.palette) {
      return;
    }
    const tools = selectablePaletteTools();
    const used = new Set();
    elements.palette.innerHTML = INVENTORY_GROUPS.map((group) => {
      const groupTools = tools
        .filter((tool) => !used.has(tool.token) && group.match(tool))
        .sort((left, right) => inventoryToolPriority(left) - inventoryToolPriority(right));
      groupTools.forEach((tool) => used.add(tool.token));
      if (!groupTools.length) {
        return "";
      }
      return (
        '<section class="author-inv-group"><h4>' +
        escapeHtml(group.name) +
        "</h4>" +
        '<div class="author-inv-group__items">' +
        groupTools
          .map(
            (tool) =>
              '<button class="author-inv-item' +
              (tool.token === state.selectedToken ? " is-active" : "") +
              '" type="button" data-token="' +
              escapeHtml(tool.token) +
              '" title="' +
              escapeHtml(tool.label || tool.token) +
              '">' +
              '<span class="palette__swatch">' +
              toolSwatchMarkup(tool) +
              "</span>" +
              '<span class="author-inv-item__name">' +
              escapeHtml(tool.label || tool.token) +
              "</span>" +
              "</button>"
          )
          .join("") +
        "</div></section>"
      );
    }).join("");
    renderHotbar();
    renderInventoryDetail();
  }

  function renderHotbar() {
    const slots = document.getElementById("hotbar-slots");
    if (!slots) {
      return;
    }
    slots.innerHTML = hotbarTokens()
      .map((token, index) => {
        const tool = toolForToken(token);
        if (!tool) {
          return "";
        }
        const shortcutKey = index === 9 ? "0" : String(index + 1);
        return (
          '<button class="author-hotbar__slot' +
          (index === activeHotbarSlotIndex ? " is-active" : "") +
          '" type="button" data-slot-index="' +
          index +
          '" data-token="' +
          escapeHtml(token) +
          '" title="' +
          escapeHtml((tool.label || token) + " (" + shortcutKey + ")") +
          '" aria-keyshortcuts="' +
          shortcutKey +
          '" aria-label="' +
          escapeHtml(tool.label || token) +
          '">' +
          '<span class="author-hotbar__key" aria-hidden="true">' +
          (index + 1) +
          "</span>" +
          '<span class="palette__swatch">' +
          toolSwatchMarkup(tool) +
          "</span>" +
          "</button>"
        );
      })
      .join("");
  }

  function demoClassForTool(tool) {
    const kind = tool.type || tool.name || "";
    if (kind === "gem") {
      return "demo-gem";
    }
    if (kind === "ice" || kind === "ice_block" || kind === "ice_slope") {
      return "demo-shimmer";
    }
    if (kind === "puncher") {
      return "demo-jab";
    }
    if (
      kind === "player_lift" ||
      kind === "player_gate" ||
      kind === "orange_wall" ||
      kind === "orange_button" ||
      kind === "orange_ice_slope"
    ) {
      return "demo-rise";
    }
    if (kind === "weightless_box" || kind === "floating_floor") {
      return "demo-slide";
    }
    if (kind === "player" || kind === "clone") {
      return "demo-hop";
    }
    return "";
  }

  function renderInventoryDetail() {
    const nameEl = document.getElementById("inventory-detail-name");
    if (!nameEl) {
      return;
    }
    const tool = toolForToken(state.selectedToken);
    const stage = document.getElementById("inventory-detail-stage");
    const swatch = document.getElementById("inventory-detail-swatch");
    const textEl = document.getElementById("inventory-detail-text");
    if (!tool) {
      nameEl.textContent = "Pick a tool";
      if (textEl) {
        textEl.textContent = "Click any tool to see what it does.";
      }
      return;
    }
    nameEl.textContent = tool.label || tool.token;
    if (textEl) {
      textEl.textContent = toolDescription(tool) || "No description yet.";
    }
    if (swatch) {
      swatch.innerHTML = toolSwatchMarkup(tool);
    }
    if (stage) {
      const demoClass = demoClassForTool(tool);
      // Renderer state (notably has-demo and is-demo-resetting) must survive
      // detail refreshes while previews arrive progressively.
      stage.classList.remove(...INVENTORY_DEMO_CLASSES);
      if (demoClass) {
        stage.classList.add(demoClass);
      }
    }
    // Live 3D scene when the toolbox is showing; the CSS demo classes above
    // only surface if the scene renderer is unavailable.
    if (isInventoryOpen()) {
      runDemoScene(tool).catch(() => {});
    }
  }

  function isInventoryOpen() {
    const inventory = document.getElementById("author-inventory");
    return Boolean(inventory && !inventory.hidden);
  }

  function setInventoryOpen(open) {
    const inventory = document.getElementById("author-inventory");
    if (!inventory) {
      return;
    }
    inventory.hidden = !open;
    document.getElementById("hotbar-backpack")?.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      renderInventoryDetail();
      renderPalettePreviews(); // Memoized; covers opening before the boot chain gets there.
    } else {
      stopDemoScene();
    }
  }

  function flashHotbarToolname(label) {
    const el = document.getElementById("hotbar-toolname");
    if (!el || !label) {
      return;
    }
    el.textContent = label;
    el.classList.add("is-visible");
    window.clearTimeout(hotbarToolnameTimer);
    hotbarToolnameTimer = window.setTimeout(() => el.classList.remove("is-visible"), 1400);
  }

  function sleepMs(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  // ---- Editor camera controller ----
  // Mirrors the play page's camera feel exactly: quarter-turn yaw eased over
  // 400ms, and velocity-based tilt with acceleration/deceleration while held.
  const EDITOR_CAM_TILT_MAX_SPEED = Math.PI * 0.72;
  const EDITOR_CAM_TILT_ACCEL = Math.PI * 3.4;
  const EDITOR_CAM_TILT_DECEL = Math.PI * 4.2;
  const EDITOR_CAM_YAW_MS = 400;
  const editorCam = {
    frame: 0,
    heldTiltKeys: new Set(),
    lastMs: 0,
    pointerTiltDir: 0,
    tilt: 0.22,
    tiltDir: 0,
    tiltVel: 0,
    yaw: 0,
    yawAnim: null
  };

  function editorCamRendererApi() {
    return editorRenderer.app?.threeRenderer || null;
  }

  function editorCamIdle() {
    return !editorCam.yawAnim && !editorCam.tiltVel && !editorCam.tiltDir;
  }

  function editorCamSyncFromRenderer() {
    const rendererApi = editorCamRendererApi();
    if (rendererApi && typeof rendererApi.getDebugCameraYaw === "function") {
      editorCam.yaw = rendererApi.getDebugCameraYaw();
      editorCam.tilt = rendererApi.getDebugCameraTilt();
    }
  }

  function clampEditorCamTilt(value) {
    return Math.max(0, Math.min(Math.PI / 2, value));
  }

  function easeInOutQuadValue(progress) {
    const value = Math.max(0, Math.min(1, progress));
    return value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2;
  }

  function easeTowardValue(current, target, maxDelta) {
    if (current < target) {
      return Math.min(target, current + maxDelta);
    }
    if (current > target) {
      return Math.max(target, current - maxDelta);
    }
    return current;
  }

  function editorCamFrame(now) {
    editorCam.frame = 0;
    const rendererApi = editorCamRendererApi();
    const app = editorRenderer.app;
    if (!rendererApi || !app) {
      editorCam.yawAnim = null;
      editorCam.tiltVel = 0;
      editorCam.lastMs = 0;
      return;
    }
    const deltaSeconds = editorCam.lastMs
      ? Math.min(0.05, Math.max(0.001, (now - editorCam.lastMs) / 1000))
      : 1 / 60;
    editorCam.lastMs = now;
    let continueLoop = false;

    if (editorCam.yawAnim) {
      const progress = Math.min(1, (now - editorCam.yawAnim.startMs) / EDITOR_CAM_YAW_MS);
      editorCam.yaw =
        editorCam.yawAnim.startYaw +
        (editorCam.yawAnim.targetYaw - editorCam.yawAnim.startYaw) * easeInOutQuadValue(progress);
      if (progress >= 1) {
        editorCam.yaw = editorCam.yawAnim.targetYaw;
        editorCam.yawAnim = null;
      } else {
        continueLoop = true;
      }
    }

    if (editorCam.tiltDir || editorCam.tiltVel) {
      const targetVelocity = editorCam.tiltDir * EDITOR_CAM_TILT_MAX_SPEED;
      const rate = editorCam.tiltDir ? EDITOR_CAM_TILT_ACCEL : EDITOR_CAM_TILT_DECEL;
      editorCam.tiltVel = easeTowardValue(editorCam.tiltVel, targetVelocity, rate * deltaSeconds);
      if (!editorCam.tiltDir && Math.abs(editorCam.tiltVel) < 0.002) {
        editorCam.tiltVel = 0;
      }
      const previousTilt = editorCam.tilt;
      editorCam.tilt = clampEditorCamTilt(editorCam.tilt + editorCam.tiltVel * deltaSeconds);
      if (editorCam.tilt === previousTilt && editorCam.tiltVel !== 0 && !editorCam.tiltDir) {
        editorCam.tiltVel = 0;
      }
      if (editorCam.tiltDir || editorCam.tiltVel) {
        continueLoop = true;
      }
    }

    rendererApi.setDebugCameraView({
      yaw: editorCam.yaw,
      tilt: editorCam.tilt,
      mode: "perspective",
      skipRender: true
    });
    app.render(now);

    if (continueLoop) {
      scheduleEditorCamFrame();
    } else {
      editorCam.lastMs = 0;
    }
  }

  function scheduleEditorCamFrame() {
    if (!editorCam.frame) {
      editorCam.frame = window.requestAnimationFrame(editorCamFrame);
    }
  }

  function editorCamRotate(direction) {
    if (editorCamIdle()) {
      editorCamSyncFromRenderer();
    }
    const fromYaw = editorCam.yawAnim ? editorCam.yawAnim.targetYaw : editorCam.yaw;
    editorCam.yawAnim = {
      startMs: performance.now(),
      startYaw: editorCam.yaw,
      targetYaw: fromYaw + direction * (Math.PI / 2)
    };
    scheduleEditorCamFrame();
  }

  function editorCamRecomputeTiltDirection() {
    let direction = editorCam.pointerTiltDir;
    if (!direction) {
      if (editorCam.heldTiltKeys.has("s")) {
        direction = 1;
      }
      if (editorCam.heldTiltKeys.has("w")) {
        direction = -1;
      }
    }
    if (direction && editorCamIdle()) {
      editorCamSyncFromRenderer();
    }
    editorCam.tiltDir = direction;
    if (direction) {
      scheduleEditorCamFrame();
    }
  }

  function createAuxiliaryRenderApp(canvas, playData, hostFrame = null) {
    const modules = window.PlayModules || {};
    if (
      !canvas ||
      typeof modules.createPlayCore !== "function" ||
      typeof modules.registerRenderFunctions !== "function"
    ) {
      return null;
    }
    const auxiliaryPlayData = hostFrame
      ? { ...playData, hostFullBleedView: true }
      : playData;
    const app = modules.createPlayCore({
      playData: auxiliaryPlayData,
      canvas,
      playShell: null,
      playHeader: null,
      playStage: hostFrame,
      mazeFrame: hostFrame,
      fuzzyToggle: null,
      enableCameraControls: false
    });
    if (!app) {
      return null;
    }
    // Toolbox demos should remain crisp. With no fuzzy toggle present, the
    // gameplay renderer otherwise defaults these small canvases to grain-on.
    app.state.effects.fuzzyEnabled = false;
    app.state.effects.noisePhase = 0;
    if (hostFrame) {
      // Slow the demo app's native movement clock instead of overriding an
      // individual move. Punch and ice scenes depend on the native clock to
      // preserve their sequenced phases and distance-aware easing.
      app.MOVE_DURATION_MS = 220;
    }
    modules.registerRenderFunctions(app);
    if (typeof modules.registerGameplayFunctions === "function") {
      modules.registerGameplayFunctions(app);
    }
    app.setupCanvas();
    app.syncCameraTarget?.(true);
    return app;
  }

  function disposeAuxiliaryRenderApp(app, canvas) {
    if (!app) {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      return;
    }
    [
      "animationFrameId",
      "cameraFrameId",
      "floatingFloorFrameId",
      "gateAnimationFrameId",
      "levelTransitionFrameId",
      "noiseFrameId",
      "orangeWallAnimationFrameId",
      "playerLiftAnimationFrameId"
    ].forEach((key) => {
      if (app[key] !== null && app[key] !== undefined) {
        window.cancelAnimationFrame(app[key]);
        app[key] = null;
      }
    });
    try {
      app.threeRenderer?.dispose?.();
      const gl = app.gl;
      const loseContext =
        gl && typeof gl.getExtension === "function" ? gl.getExtension("WEBGL_lose_context") : null;
      loseContext?.loseContext?.();
    } catch {
      // Best-effort cleanup for one-shot renderers and page teardown.
    }
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  function demoPlayData(cells, label, key = "scene") {
    const height = cells.length;
    const width = cells[0].length;
    return buildPlayData({
      cameraView: { width, height },
      cells: cells.map((row) => row.slice()),
      // editorRender keeps the app in author-style rules: actors come from
      // the painted board (no play-entry snapshots) and gems always show.
      editorRender: true,
      gameId: authorData.game.id,
      height,
      includeGems: true,
      // A non-world ID prevents auxiliary scenes from fetching and meshing
      // the real BxA/AxB/BxB rooms behind a tiny demo.
      levelId: "__toolbox_demo_" + encodeURIComponent(key),
      levelLabel: label || "Demo",
      width
    });
  }

  // ---- Live 3D demo scenes for the toolbox detail pane ----
  // Each scene is a tiny board plus a scripted move loop played by the real
  // engine on a dedicated offscreen app, so tools demonstrate their actual
  // behavior (slides, punches, toggles, collection) with real models.
  function configuredDemoSceneForTool(tool) {
    const demo = tool?.demo;
    if (!demo || !Array.isArray(demo.layout) || demo.layout.length === 0) {
      return null;
    }

    const rows = demo.layout
      .map((row) =>
        Array.isArray(row)
          ? row.map((cell) => String(cell || ""))
          : String(row || "")
              .trim()
              .split(/\s+/)
      )
      .filter((row) => row.length > 0 && row.some((cell) => cell.length > 0));
    const width = rows.reduce((largest, row) => Math.max(largest, row.length), 0);
    if (rows.length === 0 || width === 0) {
      return null;
    }

    const floorToken = authorData.defaultFloorToken || ".";
    const cells = rows.map((row) =>
      Array.from({ length: width }, (_, index) =>
        String(row[index] || floorToken)
          .split("$")
          .join(tool.token)
      )
    );
    const scene = {
      ambient: demo.ambient === true,
      cells,
      moves:
        typeof demo.moves === "string"
          ? demo.moves.toUpperCase().replace(/[^UDLR]/g, "")
          : ""
    };
    const zoom = Number(demo.zoom);
    if (Number.isFinite(zoom) && zoom > 0) {
      scene.zoom = zoom;
    }
    return scene;
  }

  function demoSceneForTool(tool) {
    const configuredScene = configuredDemoSceneForTool(tool);
    if (configuredScene) {
      return configuredScene;
    }

    const kind = tool.type || tool.name || "";
    const t = tool.token;
    switch (kind) {
      case "floor":
        return { cells: [[".", ".", "."], [".", "p", "."], [".", ".", "."]], moves: "RL" };
      case "ice":
        return { cells: [[".", ".", ".", ".", "."], ["p", "i", "i", "i", "."], [".", ".", ".", ".", "."]], moves: "R" };
      case "wall":
        return { cells: [[".", ".", "."], ["p", ".", "#"], [".", ".", "."]], moves: "RR" };
      case "ice_block":
        return { cells: [[".", ".", "."], ["p", ".", "I"], [".", ".", "."]], moves: "RR" };
      case "ice_slope": {
        // Colored families (black, blue, yellow) reuse the plain scene with
        // their own right-facing token so the tint is visible.
        const slopeRight = slopeFamilyForToken(t)?.tokenByDirection.get("right") || "Sr";
        return { cells: [["p", "i", slopeRight, "I", "I"]], moves: "R" };
      }
      case "orange_ice_slope": {
        // A box parks on the button so the slope stays lowered while the
        // player walks around and climbs it.
        const slopeRight = slopeFamilyForToken(t)?.tokenByDirection.get("right") || t;
        return {
          cells: [
            [".", "M0", appendCellToken(authorData.defaultFloorToken, "o"), "."],
            ["p", ".", slopeRight, appendCellToken(authorData.defaultFloorToken, "I")]
          ],
          moves: "URDRR"
        };
      }
      case "player":
        return { cells: [[".", ".", "."], [".", "p", "."], [".", ".", "."]], moves: "RL" };
      case "clone":
        return { cells: [["p", ".", "."], [".", ".", "."], [t, ".", "."]], moves: "RL" };
      case "gem":
        return { ambient: true, cells: [["p", ".", "G"]], moves: "RR" };
      case "player_gate":
        return { cells: [["p", "g", ".", "."]], moves: "RRR" };
      case "player_lift":
        return { cells: [["p", t, "."]], moves: "RR" };
      case "orange_wall":
      case "orange_button":
        return {
          cells: [["p", appendCellToken(authorData.defaultFloorToken, "o"), ".", "O", "."]],
          moves: "RRRR"
        };
      case "puncher":
        return { cells: [["pr", ".", ".", "p"]], moves: "LL" };
      case "weightless_box":
        return { cells: [["p", t, ".", "."]], moves: "RR" };
      case "floating_floor":
        return { cells: [["p", "f", ".", "."]], moves: "RR" };
      case "tree":
      case "shrub":
        // Tall models: padding rows to the north plus a pulled-back camera
        // give the model vertical screen room, with the player for scale.
        return {
          cells: [[".", ".", "."], [".", ".", "."], [".", t, "."], [".", ".", "p"]],
          moves: "",
          zoom: 0.68
        };
      case "block_asset":
        return {
          cells: [[".", ".", "."], [".", t, "."], [".", ".", "p"]],
          moves: "",
          zoom: 1.08
        };
      default:
        return null;
    }
  }

  const demoSceneRenderer = {
    activeKey: null,
    app: null,
    movePromise: null,
    rafId: 0,
    ready: null,
    runToken: 0
  };

  function ensureDemoApp() {
    if (demoSceneRenderer.ready) {
      return demoSceneRenderer.ready;
    }
    demoSceneRenderer.ready = (async () => {
      const canvas = document.getElementById("inventory-demo-canvas");
      const stage = document.getElementById("inventory-detail-stage");
      const app = createAuxiliaryRenderApp(
        canvas,
        demoPlayData([[".", ".", "."], [".", "p", "."], [".", ".", "."]], "Demo", "boot"),
        stage
      );
      if (!app) {
        return null;
      }
      if (app.threeRendererReady && typeof app.threeRendererReady.then === "function") {
        await app.threeRendererReady;
      }
      demoSceneRenderer.app = app;
      // Diagnostic handle, matching the other __MAZEBENCH_* globals.
      window.__MAZEBENCH_AUTHOR_DEMO__ = app;
      return app;
    })().catch(() => {
      demoSceneRenderer.ready = null;
      return null;
    });
    return demoSceneRenderer.ready;
  }

  function stopDemoScene() {
    demoSceneRenderer.runToken += 1;
    demoSceneRenderer.activeKey = null;
    if (demoSceneRenderer.rafId) {
      window.cancelAnimationFrame(demoSceneRenderer.rafId);
      demoSceneRenderer.rafId = 0;
    }
    const app = demoSceneRenderer.app;
    if (app?.floatingFloorFrameId !== null && app?.floatingFloorFrameId !== undefined) {
      window.cancelAnimationFrame(app.floatingFloorFrameId);
      app.floatingFloorFrameId = null;
    }
    const stage = document.getElementById("inventory-detail-stage");
    stage?.classList.remove("has-demo", "is-demo-resetting");
  }

  async function runDemoScene(tool) {
    // Re-renders of the detail pane for the SAME tool must not restart the
    // demo: a duplicate half-started run clears the canvas under the live one.
    const sceneKey = tool ? tool.token : null;
    if (sceneKey && sceneKey === demoSceneRenderer.activeKey) {
      if (demoSceneRenderer.app) {
        document.getElementById("inventory-detail-stage")?.classList.add("has-demo");
      }
      return;
    }
    stopDemoScene();
    demoSceneRenderer.activeKey = sceneKey;
    const stage = document.getElementById("inventory-detail-stage");
    const scene = tool ? demoSceneForTool(tool) : null;
    if (!scene) {
      stage?.classList.remove("has-demo");
      return;
    }
    const token = demoSceneRenderer.runToken;
    const app = await ensureDemoApp();
    if (!app || token !== demoSceneRenderer.runToken) {
      if (token === demoSceneRenderer.runToken) {
        demoSceneRenderer.activeKey = null;
        stage?.classList.remove("has-demo");
      }
      return;
    }
    const playData = demoPlayData(scene.cells, tool.label, tool.token);
    try {
      await app.preloadImagesForLevelState(playData);
      await app.threeRenderer?.whenLevelStateModelsReady?.(playData);
    } catch {
      // Missing imagery keeps fallback primitives; the demo still runs.
    }
    if (token !== demoSceneRenderer.runToken) {
      return;
    }
    const pendingMove = demoSceneRenderer.movePromise;
    if (pendingMove) {
      await pendingMove.catch(() => {});
      if (token !== demoSceneRenderer.runToken) {
        return;
      }
    }
    app.setupCanvas();
    if (scene.ambient) {
      let lastIdleRenderMs = 0;
      const renderTick = (now) => {
        if (token !== demoSceneRenderer.runToken) {
          return;
        }
        // Gameplay owns frames during moves. This light ambient loop only
        // keeps genuinely animated idle assets (currently the gem) alive.
        if (!app.isAnimating && now - lastIdleRenderMs >= 1000 / 30) {
          lastIdleRenderMs = now;
          app.render(now);
        }
        demoSceneRenderer.rafId = window.requestAnimationFrame(renderTick);
      };
      demoSceneRenderer.rafId = window.requestAnimationFrame(renderTick);
    }
    const moves = String(scene.moves || "")
      .split("")
      .map((letter) => solutionDirections[letter])
      .filter(Boolean);
    // Loop: ease through a reset, breathe, play the scripted moves, repeat.
    let firstCycle = true;
    for (;;) {
      if (token !== demoSceneRenderer.runToken) {
        return;
      }
      if (!firstCycle) {
        stage?.classList.add("is-demo-resetting");
        await sleepMs(160);
        if (token !== demoSceneRenderer.runToken) {
          return;
        }
      }
      app.applyLevelState(playData, {
        deferRender: true,
        immediateCamera: true,
        resetHistory: true,
        resetLevelEntry: true
      });
      app.threeRenderer?.setDebugCameraView?.({
        yaw: 0,
        tilt: 0.6,
        zoom: scene.zoom || 1.05,
        mode: "perspective",
        skipRender: true
      });
      app.render();
      stage?.classList.add("has-demo");
      stage?.classList.remove("is-demo-resetting");
      if (!firstCycle) {
        await sleepMs(140);
      }
      firstCycle = false;
      if (!moves.length) {
        return; // Static scenery needs only the frame rendered above.
      }
      await sleepMs(500);
      for (const move of moves) {
        if (token !== demoSceneRenderer.runToken) {
          return;
        }
        try {
          const movePromise = performSolutionMove(app, move);
          demoSceneRenderer.movePromise = movePromise;
          try {
            await movePromise;
          } finally {
            if (demoSceneRenderer.movePromise === movePromise) {
              demoSceneRenderer.movePromise = null;
            }
          }
        } catch {
          break;
        }
        if (token !== demoSceneRenderer.runToken) {
          if (app.floatingFloorFrameId !== null) {
            window.cancelAnimationFrame(app.floatingFloorFrameId);
            app.floatingFloorFrameId = null;
          }
          return;
        }
        await sleepMs(180);
      }
      await sleepMs(900);
    }
  }

  // ---- Canonical world-map thumbnails ----
  // MazeJam's polished 3D room portraits are rendered with the real game
  // renderer. Unsaved paint stays local; saved rooms persist the same PNG so
  // Build cards, the editor map, and hosted MazeJam all show one image.
  const worldThumbRenderer = { app: null, canvas: null, ready: null };
  const localLevelThumbs = new Map();
  let currentLevelThumbTimer = 0;

  function localThumbTerrainColor(cell) {
    const types = Array.isArray(cell?.layers)
      ? cell.layers.map((layer) => layer?.type)
      : [cell?.type];

    if (types.includes("wall")) return "#383039";
    if (types.includes("ice_wall")) return "#7bb1c6";
    if (types.includes("ice") || types.includes("slope")) return "#abdbea";
    if (types.includes("orange_button")) return "#ed9142";
    if (types.includes("exit")) return "#40965b";
    return "#d9bc94";
  }

  function localThumbActorColor(type) {
    if (type === "gem") return "#1fd8df";
    if (type === "player" || type === "circle_player") return "#48b85f";
    if (type === "clone") return "#345087";
    if (type === "box" || type === "weightless_box") return "#856244";
    if (type === "puncher") return "#be6f44";
    return "#596273";
  }

  // Hosted editors already receive every saved room's cells in the page.
  // Draw their map tiles synchronously with a tiny 2D canvas: the map is
  // useful on its first frame, no WebGL contexts or model downloads are
  // needed, and no preview bytes ever leave the browser.
  function renderSimpleLevelThumbFromCells(levelId, cells, width, height) {
    const safeWidth = Math.max(1, Number(width) || cells?.[0]?.length || 1);
    const safeHeight = Math.max(1, Number(height) || cells?.length || 1);
    const playData = buildPlayData({
      cameraView: { width: safeWidth, height: safeHeight },
      cells: cells.map((row) => row.slice()),
      editorRender: true,
      gameId: authorData.game.id,
      height: safeHeight,
      includeGems: true,
      levelId: "__author_thumbnail_simple_" + encodeURIComponent(levelId),
      levelLabel: levelId,
      width: safeWidth
    });
    const terrain = Array.isArray(playData?.terrain) ? playData.terrain : [];
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext("2d");

    if (!context) {
      return "";
    }

    context.fillStyle = "#171923";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const cellWidth = canvas.width / safeWidth;
    const cellHeight = canvas.height / safeHeight;

    for (let y = 0; y < safeHeight; y += 1) {
      for (let x = 0; x < safeWidth; x += 1) {
        context.fillStyle = localThumbTerrainColor(terrain[y]?.[x]);
        context.fillRect(
          Math.floor(x * cellWidth),
          Math.floor(y * cellHeight),
          Math.ceil(cellWidth),
          Math.ceil(cellHeight)
        );
      }
    }

    for (const actor of Array.isArray(playData?.actors) ? playData.actors : []) {
      const x = Number(actor?.x);
      const y = Number(actor?.y);

      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        continue;
      }

      context.fillStyle = localThumbActorColor(actor?.type);
      context.beginPath();
      context.arc(
        (x + 0.5) * cellWidth,
        (y + 0.5) * cellHeight,
        Math.max(1.5, Math.min(cellWidth, cellHeight) * 0.3),
        0,
        Math.PI * 2
      );
      context.fill();
    }

    const url = canvas.toDataURL("image/png");
    localLevelThumbs.set(levelId, url);
    applyLocalThumbToMapTile(levelId, url);
    return url;
  }

  function ensureThumbApp() {
    if (worldThumbRenderer.ready) {
      return worldThumbRenderer.ready;
    }
    worldThumbRenderer.ready = (async () => {
      worldThumbRenderer.canvas = document.createElement("canvas");
      worldThumbRenderer.canvas.width = 512;
      worldThumbRenderer.canvas.height = 512;
      const app = createAuxiliaryRenderApp(
        worldThumbRenderer.canvas,
        demoPlayData([[".", "p"]], "Thumb")
      );
      if (!app) {
        return null;
      }
      if (app.threeRendererReady && typeof app.threeRendererReady.then === "function") {
        await app.threeRendererReady;
      }
      worldThumbRenderer.app = app;
      return app;
    })().catch(() => null);
    return worldThumbRenderer.ready;
  }

  function applyLocalThumbToMapTile(levelId, url) {
    const tile = elements.existingLevels?.querySelector(
      '[data-level-id="' + levelId + '"]'
    );
    if (!tile) {
      return;
    }
    let img = tile.querySelector(".author-level-pill__thumb");
    if (!img) {
      img = document.createElement("img");
      img.className = "author-level-pill__thumb";
      img.alt = "";
      tile.prepend(img);
    }
    img.src = url;
  }

  async function persistLevelThumb(levelId, imageDataUrl) {
    const response = await fetch(
      authorData.previewApiBaseUrl + "/" + encodeURIComponent(levelId) + "/preview",
      {
        body: JSON.stringify({ imageDataUrl }),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST"
      }
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Could not save that room thumbnail.");
    }
    const level = authorData.existingLevels.find((entry) => entry.id === levelId);
    if (level) level.previewUrl = payload.previewUrl || level.previewUrl || null;
    if (authorData.worldPreviewUrls && payload.previewUrl) {
      authorData.worldPreviewUrls[levelId] = payload.previewUrl;
    }
    return payload.previewUrl || null;
  }

  async function renderLevelThumbFromCells(levelId, cells, width, height, options = {}) {
    if (!levelId || !Array.isArray(cells) || !cells.length) {
      return;
    }
    if (!clientPreviewPersistence) {
      return renderSimpleLevelThumbFromCells(levelId, cells, width, height);
    }
    const app = await ensureThumbApp();
    if (!app) {
      return;
    }
    const playData = buildPlayData({
      cameraView: { width, height },
      cells: cells.map((row) => row.slice()),
      editorRender: true,
      gameId: authorData.game.id,
      height,
      includeGems: true,
      // Thumbnail renders are isolated portraits; using the real room ID
      // would make the auxiliary app stream and mesh adjacent rooms.
      levelId: "__author_thumbnail_" + encodeURIComponent(levelId),
      levelLabel: levelId,
      width
    });
    app.applyLevelState(playData, {
      deferRender: true,
      immediateCamera: true,
      resetHistory: true,
      resetLevelEntry: true
    });
    try {
      await app.preloadImagesForLevelState(playData);
      await app.threeRenderer?.whenLevelStateModelsReady?.(playData);
    } catch {
      // Fallback primitives still make a recognizable thumbnail.
    }
    app.threeRenderer?.useLevelPreviewCamera?.();
    app.render();
    const source = worldThumbRenderer.canvas;
    if (!source || !source.width || !source.height) {
      return;
    }
    const thumb = document.createElement("canvas");
    thumb.width = 128;
    thumb.height = 128;
    const context = thumb.getContext("2d");
    if (!context) {
      return;
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const cropSize = Math.min(source.width, source.height);
    context.drawImage(
      source,
      Math.round((source.width - cropSize) / 2),
      Math.round((source.height - cropSize) / 2),
      cropSize,
      cropSize,
      0,
      0,
      128,
      128
    );
    const url = thumb.toDataURL("image/png");
    localLevelThumbs.set(levelId, url);
    applyLocalThumbToMapTile(levelId, url);
    if (options.persist === true) {
      await persistLevelThumb(levelId, url);
    }
  }

  function scheduleCurrentLevelThumbRefresh(delayMs = 700, options = {}) {
    window.clearTimeout(currentLevelThumbTimer);
    currentLevelThumbTimer = window.setTimeout(() => {
      // Keep adjacent rooms' seam edges in sync with the room being painted.
      refreshCurrentRoomNeighborState();
      renderLevelThumbFromCells(
        state.levelId,
        state.cells,
        state.width,
        state.height,
        options
      ).catch(() => {});
    }, delayMs);
  }

  // Feed every room of the world into the editor app's neighbor cache so
  // the world view can mesh them (the editor already has all cells locally).
  // Runs after the boot melt so cached room groups never bake the vector
  // boot theme; safe to call repeatedly.
  let editorWorldNeighborsPrimed = false;

  function neighborStateForLevel(levelId, cells, width, height, label) {
    return buildPlayData({
      cameraView: { width, height },
      cells: cells.map((row) => row.slice()),
      editorRender: true,
      gameId: authorData.game.id,
      height,
      includeGems: true,
      levelId,
      levelLabel: label || levelId,
      width,
      worldColumns,
      worldRows
    });
  }

  function stageCurrentHostedWorldLevel() {
    if (!hostedWorldDraftMode) {
      return null;
    }
    const previous = hostedWorldDraftLevels.get(state.levelId);
    const record = hostedWorldLevelRecord(state.levelId, {
      ...previous,
      cells: state.cells,
      exists: state.exists || previous?.exists === true,
      height: state.height,
      label: previous?.label || state.levelId,
      width: state.width
    });
    hostedWorldDraftLevels.set(state.levelId, record);
    syncEditorDirtyState();
    if (authorData.worldMeta) {
      authorData.worldMeta.gemsByLevel[state.levelId] = gemCountForCells(record.cells);
    }
    return record;
  }

  function refreshCurrentRoomNeighborState() {
    const app = editorRenderer.app;
    const staged = stageCurrentHostedWorldLevel();
    if (
      !editorWorldNeighborsPrimed ||
      !app ||
      typeof app.rememberHorizontalNeighborLevelState !== "function"
    ) {
      return;
    }
    app.rememberHorizontalNeighborLevelState(
      neighborStateForLevel(
        state.levelId,
        staged?.cells || state.cells,
        staged?.width || state.width,
        staged?.height || state.height
      )
    );
  }

  function refreshEditorLevelNeighborState(payload) {
    if (!payload?.levelId || !Array.isArray(payload.cells) || payload.cells.length === 0) {
      return;
    }

    const existingLevel = authorData.existingLevels.find(
      (level) => level.id === payload.levelId
    );
    const levelRecord = existingLevel || {
      authorUrl: "#",
      id: payload.levelId,
      label: payload.levelId,
      playUrl: "#",
      previewUrl: null
    };

    levelRecord.cells = cloneCells(payload.cells);
    levelRecord.height = payload.height;
    levelRecord.width = payload.width;
    if (!existingLevel) {
      authorData.existingLevels.push(levelRecord);
    }

    const app = editorRenderer.app;
    app?.rememberHorizontalNeighborLevelState?.(
      neighborStateForLevel(
        payload.levelId,
        payload.cells,
        payload.width,
        payload.height,
        levelRecord.label
      )
    );
  }

  function primeEditorWorldNeighbors() {
    const app = editorRenderer.app;
    if (!app || typeof app.rememberHorizontalNeighborLevelState !== "function") {
      return [];
    }
    const primedStates = [];
    hostedWorldLevelEntries().forEach((level) => {
      if (!Array.isArray(level.cells) || !level.cells.length) {
        return;
      }
      const isCurrent = level.id === state.levelId;
      const levelState = isCurrent
        ? neighborStateForLevel(state.levelId, state.cells, state.width, state.height)
        : neighborStateForLevel(
            level.id,
            level.cells,
            level.width || level.cells[0].length,
            level.height || level.cells.length,
            level.label
          );
      app.rememberHorizontalNeighborLevelState(levelState);
      primedStates.push(levelState);
    });
    editorWorldNeighborsPrimed = true;
    return primedStates;
  }

  // World-fit rectangle in world units, relative to the current room's
  // origin — the same shape play's camera flights feed the renderer.
  function editorWorldFitOptions(app) {
    const unit = app.TILE_SIZE || 64;
    const roomSpan = 16 * unit;
    const coordinates = parseLevelCoordinates(state.levelId) || { column: "A", row: "A" };
    const columnIndex = Math.max(0, columnIndexByValue.get(coordinates.column) ?? 0);
    const rowIndex = Math.max(0, rowIndexByValue.get(coordinates.row) ?? 0);
    const minX = -columnIndex * roomSpan;
    const maxX = (worldColumns.length - columnIndex) * roomSpan;
    const minZ = -rowIndex * roomSpan;
    const maxZ = (worldRows.length - rowIndex) * roomSpan;
    return {
      centerX: (minX + maxX) / 2,
      centerZ: (minZ + maxZ) / 2,
      maxX,
      maxZ,
      minX,
      minZ
    };
  }

  // The construction-then-dive every other surface plays: the camera starts
  // far out over the world's center, the glow sweep traces the whole world
  // in, then the camera dives down onto the room being edited while the
  // vector look melts into editor colors.
  function editorDiveIntoRoom(app, onDone) {
    const rendererApi = app.threeRenderer;
    const unit = app.TILE_SIZE || 64;
    const roomSpan = 16 * unit;
    const worldFit = editorWorldFitOptions(app);
    const roomFit = {
      centerX: roomSpan / 2,
      centerZ: roomSpan / 2,
      maxX: roomSpan,
      maxZ: roomSpan,
      minX: 0,
      minZ: 0
    };
    // Exactly the numbers the draft play route dives with (flyCameraToRoom
    // from the world vista): 900ms cosine ease, tilt 1.3 -> 0.22, zoom
    // 0.2 -> 1 interpolated in log space, glow melting alongside, and the
    // brightness flip + 900ms world-shadow fade kicked at flight start.
    const durationMs = 900;
    const startedAt = performance.now();
    const startTilt = 1.3;
    const endTilt = 0.22;
    const lnStartZoom = Math.log(0.2);
    const lnEndZoom = Math.log(1);
    app.worldShadowFadeMs = 900;
    app.worldViewUniformBrightness = false;
    const land = () => {
      app.cameraFlightFitOptions = null;
      app.homeVectorTheme = false;
      app.vectorGlowAmount = 0;
      rendererApi?.setDebugCameraView?.({
        yaw: 0,
        tilt: endTilt,
        zoom: 1,
        mode: "perspective",
        skipRender: true
      });
      rendererApi?.invalidateSceneCache?.();
      app.render();
      if (typeof onDone === "function") {
        onDone();
      }
    };
    const reducedMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    if (reducedMotion || !rendererApi || typeof rendererApi.setDebugCameraView !== "function") {
      land();
      return;
    }
    const step = (now) => {
      const raw = (now - startedAt) / durationMs;
      const progress = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      // Play's flight easing (cosine ease-in-out), not the quad variant.
      const eased = 0.5 - Math.cos(Math.PI * progress) / 2;
      app.cameraFlightFitOptions = {
        centerX: worldFit.centerX + (roomFit.centerX - worldFit.centerX) * eased,
        centerZ: worldFit.centerZ + (roomFit.centerZ - worldFit.centerZ) * eased,
        maxX: worldFit.maxX + (roomFit.maxX - worldFit.maxX) * eased,
        maxZ: worldFit.maxZ + (roomFit.maxZ - worldFit.maxZ) * eased,
        minX: worldFit.minX + (roomFit.minX - worldFit.minX) * eased,
        minZ: worldFit.minZ + (roomFit.minZ - worldFit.minZ) * eased
      };
      rendererApi.setDebugCameraView({
        yaw: 0,
        tilt: startTilt + (endTilt - startTilt) * eased,
        zoom: Math.exp(lnStartZoom + (lnEndZoom - lnStartZoom) * eased),
        mode: "perspective",
        skipRender: true
      });
      app.vectorGlowAmount = 1 - eased;
      rendererApi.invalidateSceneCache?.();
      app.render(now);
      if (progress < 1) {
        window.requestAnimationFrame(step);
        return;
      }
      land();
    };
    window.requestAnimationFrame(step);
  }

  // Post-boot choreography, staged so nothing competes with the glow sweep:
  // prime neighbor states, mesh the world's room groups INCREMENTALLY (8ms
  // slices per frame instead of one synchronous build), then land the camera
  // on the active room — and only after that start the
  // heavy background work (map thumbnails, palette preview renders).
  let editorWorldRevealStarted = false;

  function revealEditorWorld() {
    if (editorWorldRevealStarted) {
      return;
    }
    const app = editorRenderer.app;
    const rendererApi = app?.threeRenderer;
    if (!app || !rendererApi) {
      return;
    }
    editorWorldRevealStarted = true;
    primeEditorWorldNeighbors();
    const warmStartedAt = performance.now();
    const warmTick = () => {
      if (!editorRenderer.app) {
        return;
      }
      let done = true;
      try {
        done = rendererApi.warmWorldViewRoomGroups?.(8) !== false;
      } catch {
        done = true;
      }
      if (!done && performance.now() - warmStartedAt < 8000) {
        window.requestAnimationFrame(warmTick);
        return;
      }
      rendererApi.invalidateSceneCache?.();
      app.render();
      // Tool symbols are the editor's primary controls, so publish those
      // first; room-map thumbnails wait until the hotbar pipeline is underway.
      window.setTimeout(() => {
        renderPalettePreviews();
      }, 100);
      window.setTimeout(() => {
        primeLocalWorldThumbs().catch(() => {});
      }, 900);
    };
    window.requestAnimationFrame(warmTick);
  }

  async function primeLocalWorldThumbs() {
    for (const level of hostedWorldLevelEntries()) {
      if (localLevelThumbs.has(level.id)) {
        continue;
      }
      const isCurrent = level.id === state.levelId;
      const cells = isCurrent ? state.cells : level.cells;
      const width = isCurrent ? state.width : level.width || cells?.[0]?.length;
      const height = isCurrent ? state.height : level.height || cells?.length;
      if (!Array.isArray(cells) || !cells.length) {
        continue;
      }
      await renderLevelThumbFromCells(level.id, cells, width, height, {
        // Local authoring persists missing portraits. Hosted deployments can
        // disable this capability and keep the same portraits browser-local,
        // preventing a large world from fanning out background mutations.
        persist:
          clientPreviewPersistence &&
          !level.previewUrl &&
          !(isCurrent && state.isDirty)
      }).catch(() => {});
      await sleepMs(80);
    }
  }

  function createPalettePreviewPlayData(tool) {
    // Icons are item portraits, not miniature rooms. A one-cell scene keeps
    // the object legible at 32px and activates the renderer's palette camera.
    const width = 1;
    const height = 1;
    const cells = createBlankCells(width, height, authorData.defaultFloorToken);
    const kind = tool.type || tool.name;
    const puncherPortrait = kind === "puncher";
    const tall = kind === "tree" || kind === "shrub";

    // The puncher preview faces the camera (south) so its punching face is
    // visible; slope portraits likewise use one canonical right-facing pose
    // so an eyedropped up/down/left token cannot turn edge-on in the hotbar.
    // Placement direction still follows the editor camera.
    const promptPreview = promptToolPreviewSpec(tool.token);
    const directionalPreviewToken = promptPreview
      ? promptPreview.token
      : puncherPortrait
        ? puncherTokenForDirection("down") || tool.token
        : tool.token;
    const slopeSuffix = slopeTokenStyleSuffix(directionalPreviewToken);
    const previewToken = slopeSuffix === null ? directionalPreviewToken : "Sr" + slopeSuffix;
    const slopePortrait = slopeSuffix !== null;
    const ownedSlopePreview = ownedSlopePalettePreviewSpec(previewToken, promptPreview);
    // Build owned-slope portraits from their owning actor, then turn that
    // actor into a wedge below. This keeps stale or custom palette entries
    // from resolving SrM<N>/Src<N> as a plain tan terrain slope.
    const previewCellToken = ownedSlopePreview?.actorToken || previewToken;

    cells[0][0] =
      kind === "orange_button"
        ? appendCellToken(authorData.defaultFloorToken, previewCellToken)
        : previewCellToken;

    const playData = buildPlayData({
        cameraView: { width, height },
        cells,
        editorRender: true,
        gameId: authorData.game.id,
        height,
        includeGems: true,
        // Tall scenery keeps the editor-height camera plus a pulled-back zoom;
        // other tools use the dedicated compact palette camera. Neither ID is
        // parseable as a world room, so no neighbor requests can be queued.
        levelId:
          (tall ? "__author_palette_tall_" : "__palette_preview_") +
          encodeURIComponent(tool.token),
        levelLabel: tool.label || tool.token,
        width
      });

    if (ownedSlopePreview) {
      playData.actors.forEach((actor) => {
        if (actor.type !== ownedSlopePreview.type) {
          return;
        }

        actor.direction = "right";
        actor.groupId = ownedSlopePreview.groupId;
        actor.shape = "slope";
        actor.styleKey = ownedSlopePreview.groupId;
      });
    } else if (promptPreview) {
      playData.actors.forEach((actor) => {
        if (actor.type === "weightless_box" || actor.type === "clone") {
          actor.groupId = promptPreview.groupId;
        }
      });
    }

    return {
      playData,
      puncherPortrait,
      slopePortrait,
      tall
    };
  }

  function captureSquarePreview(sourceCanvas, outputSize, tool = null) {
    if (!sourceCanvas || !sourceCanvas.width || !sourceCanvas.height) {
      return "";
    }
    const previewCanvas = document.createElement("canvas");
    const previewContext = previewCanvas.getContext("2d");

    if (!previewContext) {
      return "";
    }

    previewCanvas.width = outputSize;
    previewCanvas.height = outputSize;
    previewContext.imageSmoothingEnabled = true;
    previewContext.imageSmoothingQuality = "high";
    const kind = tool ? tool.type || tool.name : "";
    const isTall = kind === "tree" || kind === "shrub";
    const cropSize = Math.max(
      1,
      Math.round(Math.min(sourceCanvas.width, sourceCanvas.height) * (isTall ? 1 : 0.72))
    );
    previewContext.drawImage(
      sourceCanvas,
      Math.round((sourceCanvas.width - cropSize) / 2),
      Math.round((sourceCanvas.height - cropSize) / 2),
      cropSize,
      cropSize,
      0,
      0,
      outputSize,
      outputSize
    );

    return previewCanvas.toDataURL("image/png");
  }

  function publishPalettePreview(tool, previewUrl) {
    palettePreviewRenderer.previewsByToken.set(tool.token, previewUrl);
    [elements.palette, document.getElementById("hotbar-slots")].forEach((root) => {
      root?.querySelectorAll("[data-token]").forEach((button) => {
        if (button.dataset.token !== tool.token) {
          return;
        }
        const swatch = button.querySelector(".palette__swatch");
        if (swatch) {
          swatch.innerHTML = toolSwatchMarkup(tool);
        }
      });
    });
    if (state.selectedToken === tool.token) {
      const detailSwatch = document.getElementById("inventory-detail-swatch");
      if (detailSwatch) {
        detailSwatch.innerHTML = toolSwatchMarkup(tool);
      }
    }
  }

  function yieldPalettePreviewPaint() {
    return new Promise((resolve) => window.requestAnimationFrame(resolve));
  }

  async function capturePalettePreviewTools(orderedTools) {
    if (!orderedTools.length) {
      return;
    }

    const modules = window.PlayModules || {};

    if (
      typeof modules.createPlayCore !== "function" ||
      typeof modules.registerRenderFunctions !== "function"
    ) {
      throw new Error("Palette preview modules are not ready.");
    }

    const previewEntriesByToken = new Map(
      orderedTools.map((tool) => [tool.token, createPalettePreviewPlayData(tool)])
    );
    const firstEntry = previewEntriesByToken.get(orderedTools[0].token);
    const canvas = document.createElement("canvas");
    let app = modules.createPlayCore({
      playData: firstEntry.playData,
      canvas,
      playShell: null,
      playHeader: null,
      playStage: null,
      mazeFrame: null,
      fuzzyToggle: null,
      enableCameraControls: false
    });

    if (!app) {
      throw new Error("Palette preview renderer is unavailable.");
    }

    // These captures become the hotbar and toolbox icons, so never bake the
    // gameplay grain into them.
    app.state.effects.fuzzyEnabled = false;
    app.state.effects.noisePhase = 0;
    modules.registerRenderFunctions(app);
    app.setupCanvas();
    app.syncCameraTarget?.(true);
    const preloadPromises = new Map();
    const preloadTool = (tool) => {
      if (!preloadPromises.has(tool.token)) {
        const entry = previewEntriesByToken.get(tool.token);
        preloadPromises.set(
          tool.token,
          (async () => {
            try {
              await app.preloadImagesForLevelState(entry.playData);
              await app.threeRenderer?.whenLevelStateModelsReady?.(entry.playData);
            } catch {
              // Failed loads keep their generic 3D family portrait and do not
              // block the rest of the hotbar icons.
            }
          })()
        );
      }
      return preloadPromises.get(tool.token);
    };
    try {
      if (app.threeRendererReady && typeof app.threeRendererReady.then === "function") {
        await app.threeRendererReady;
      }

      const preloadWindowSize = 4;
      for (let index = 0; index < orderedTools.length; index += 1) {
        const tool = orderedTools[index];
        const entry = previewEntriesByToken.get(tool.token);
        // Keep a small hotbar-first load window ahead of the sequential
        // capture loop. This avoids both a 34-request burst and a full GLB
        // waterfall while preserving deterministic progressive publishing.
        for (
          let nextIndex = index;
          nextIndex < Math.min(orderedTools.length, index + preloadWindowSize);
          nextIndex += 1
        ) {
          preloadTool(orderedTools[nextIndex]);
        }
        await preloadTool(tool);
        app.applyLevelState(entry.playData, {
          deferRender: true,
          immediateCamera: true,
          resetHistory: true,
          resetLevelEntry: true
        });
        app.liveRaisedPlayerGates = app.computeRaisedPlayerGateSet();
        app.liveRaisedOrangeWalls = app.computeRaisedOrangeWallSet();
        app.syncGateAnimationTargets(0);
        app.syncOrangeWallAnimationTargets(0);
        app.syncPlayerLiftAnimationTargets(0);
        app.palettePreviewCameraTilt = entry.slopePortrait
          ? Math.PI * 0.18
          : entry.puncherPortrait
            ? Math.PI * 0.43
            : undefined;
        app.palettePreviewCameraZoom = entry.puncherPortrait ? 1.65 : undefined;
        app.threeRenderer?.setDebugCameraView?.({
          yaw: 0,
          tilt: 0.62,
          zoom: entry.tall ? 0.55 : 1.2,
          mode: entry.slopePortrait ? "isometric" : "perspective",
          skipRender: true
        });
        app.render();

        const previewUrl = captureSquarePreview(canvas, 96, tool);
        if (previewUrl) {
          publishPalettePreview(tool, previewUrl);
          // Give the browser a paint between captures so the first hotbar
          // symbols become visible without waiting for the slowest GLB.
          await yieldPalettePreviewPaint();
        }
      }
    } finally {
      await Promise.allSettled(Array.from(preloadPromises.values()));
      disposeAuxiliaryRenderApp(app, canvas);
      app = null;
    }
  }

  async function renderPalettePreviews() {
    if (palettePreviewRenderer.promise) {
      return palettePreviewRenderer.promise;
    }

    const renderPromise = (async function () {
      const paletteTools = selectablePaletteTools().filter(
        (tool) => tool.token !== eraserToken && tool.token !== noopToken
      );

      if (paletteTools.length === 0) {
        return;
      }

      const toolsByToken = new Map(paletteTools.map((tool) => [tool.token, tool]));
      const orderedTools = [...new Set([
        ...hotbarTokens(),
        ...promptPaletteTools.map((tool) => tool.token),
        ...paletteTools.map((tool) => tool.token)
      ])]
        .map((token) => toolsByToken.get(token) || toolForToken(token))
        .filter(
          (tool) => tool && tool.token !== eraserToken && tool.token !== noopToken
        );

      await capturePalettePreviewTools(orderedTools);
    })();

    palettePreviewRenderer.promise = renderPromise.catch(() => {
      // A transient WebGL/context failure can be retried the next time the
      // toolbox opens; successfully published previews remain available.
      palettePreviewRenderer.promise = null;
    });

    return palettePreviewRenderer.promise;
  }

  function requestPatternPalettePreview(tool) {
    if (
      !tool ||
      !promptPreviewTokenForPatternToken(String(tool.token || "")) ||
      palettePreviewRenderer.previewsByToken.has(tool.token) ||
      palettePreviewRenderer.pendingTokens.has(tool.token)
    ) {
      return;
    }

    palettePreviewRenderer.pendingTokens.add(tool.token);
    const capturePromise = palettePreviewRenderer.captureQueue
      .catch(() => {})
      .then(async () => {
        // The initial sweep publishes the generic N portraits first and may
        // already include a restored dynamic hotbar token.
        await renderPalettePreviews();
        if (!palettePreviewRenderer.previewsByToken.has(tool.token)) {
          await capturePalettePreviewTools([tool]);
        }
      })
      .finally(() => {
        palettePreviewRenderer.pendingTokens.delete(tool.token);
      });

    // Serialize one-cell WebGL captures so quick successive N selections do
    // not compete for contexts or dispose a renderer another capture is using.
    palettePreviewRenderer.captureQueue = capturePromise.catch(() => {});
  }

  function renderSelectedTool() {
    if (!elements.selectedToolLabel) {
      return;
    }
    const tool = toolByToken.get(state.selectedToken);
    const isNoop = state.selectedToken === noopToken;
    const isEraser = state.selectedToken === eraserToken;
    // Slope selections read as their family ("Ice Slope", "Black Ice Slope",
    // "Box Ice Slope 7", ...) because the painted direction tracks the camera.
    const slopeFamilyLabel =
      slopeFamilyForToken(state.selectedToken)?.paletteTool?.label || null;

    elements.selectedToolLabel.textContent =
      isNoop
        ? "Select"
        : isEraser
          ? "Erase"
          : slopeFamilyLabel
            ? slopeFamilyLabel
            : tool
              ? tool.label
              : state.selectedToken;
    elements.selectedToolLabel.title =
      isNoop
        ? noopTool.label
        : isEraser
          ? eraserTool.label
          : slopeFamilyLabel
            ? slopeFamilyLabel
        : tool
          ? tool.label
          : state.selectedToken;
  }

  function renderNeighborButtons() {
    if (!elements.levelNeighbors) {
      return;
    }
    Array.from(elements.levelNeighbors.querySelectorAll("[data-dx][data-dy]")).forEach(function (button) {
      const dx = Number(button.dataset.dx);
      const dy = Number(button.dataset.dy);
      const nextLevelId = adjacentLevelId(state.levelId, dx, dy);
      if (!nextLevelId) {
        delete button.dataset.levelId;
        button.disabled = true;
        button.title = "World edge";
        button.setAttribute("aria-label", "World edge");
        return;
      }

      button.disabled = false;
      button.dataset.levelId = nextLevelId;
      button.title = "Go to " + nextLevelId.replace("level_", "");
      button.setAttribute("aria-label", "Go to " + nextLevelId);
    });
  }

  function updateCellButton(button, x, y) {
    const value = state.cells[y][x];
    const descriptor = getCellDescriptor(value);
    const isSelected = state.selectedCell.x === x && state.selectedCell.y === y;

    button.className = "author-grid__cell" + (isSelected ? " is-selected" : "");
    button.textContent = "";
    button.setAttribute(
      "aria-label",
      "Cell " + (x + 1) + ", " + (y + 1) + ": " + value + " (" + descriptor.label + ")"
    );
    button.title = "Cell " + (x + 1) + ", " + (y + 1) + ": " + value;
  }

  function isPaintStrokeActive() {
    return state.paintPointerId !== null;
  }

  function isEditorInteractionLocked() {
    return (
      state.isLevelLoading ||
      state.isLevelSwitching ||
      state.isSolverBusy ||
      state.isSolutionPlaying
    );
  }

  function refreshHitButton(x, y) {
    if (!isInsideEditorCell(x, y)) {
      return;
    }

    const button = elements.hitGrid.children[y * state.width + x];

    if (button) {
      updateCellButton(button, x, y);
    }
  }

  function readPixelValue(value) {
    const parsed = parseFloat(value);

    return Number.isFinite(parsed) ? parsed : 0;
  }

  function clampEditorTileSize(value) {
    return Math.max(minimumEditorTileSize, Math.min(editorTileSize, Math.floor(value)));
  }

  function measureEditorTileSize() {
    const shellStyles = window.getComputedStyle(elements.gridShell);
    const paddingX =
      readPixelValue(shellStyles.paddingLeft) + readPixelValue(shellStyles.paddingRight);
    const paddingY =
      readPixelValue(shellStyles.paddingTop) + readPixelValue(shellStyles.paddingBottom);
    const viewportHeight =
      window.visualViewport?.height || window.innerHeight || state.height * editorTileSize;
    const shellRect = elements.gridShell.getBoundingClientRect();
    const cappedTop = Math.max(0, Math.min(shellRect.top, Math.max(120, viewportHeight * 0.28)));
    const availableWidth = Math.max(
      minimumEditorTileSize,
      elements.gridShell.clientWidth - paddingX - editorGridOutlineSize
    );
    const availableHeight = Math.max(
      minimumEditorTileSize,
      viewportHeight - cappedTop - paddingY - editorGridOutlineSize - 24
    );
    const widthTileSize = availableWidth / Math.max(1, state.width);
    const heightTileSize = availableHeight / Math.max(1, state.height);

    return clampEditorTileSize(Math.min(widthTileSize, heightTileSize));
  }

  function syncEditorGridLayout() {
    const displayTileSize = measureEditorTileSize();
    const gridWidth = state.width * displayTileSize;
    const gridHeight = state.height * displayTileSize;

    elements.grid.style.setProperty("--editor-cell-size", displayTileSize + "px");
    elements.grid.style.width = gridWidth + "px";
    elements.grid.style.height = gridHeight + "px";
    elements.hitGrid.style.gridTemplateColumns =
      "repeat(" + state.width + ", " + displayTileSize + "px)";
    elements.hitGrid.style.gridTemplateRows =
      "repeat(" + state.height + ", " + displayTileSize + "px)";

    const gridShellHeight = Math.ceil(elements.gridShell.getBoundingClientRect().height);
    if (Number.isFinite(gridShellHeight) && gridShellHeight > 0) {
      elements.sidebar.style.setProperty("--author-level-tray-height", gridShellHeight + "px");
    }

    invalidateEditorGridRect();
  }

  function scheduleEditorGridLayout() {
    if (editorRenderer.layoutFrameId !== null) {
      return;
    }

    editorRenderer.layoutFrameId = window.requestAnimationFrame(() => {
      editorRenderer.layoutFrameId = null;
      syncEditorGridLayout();
    });
  }

  function renderGrid(options = {}) {
    const cellCount = state.width * state.height;

    syncEditorGridLayout();

    if (
      elements.hitGrid.children.length !== cellCount ||
      elements.hitGrid.dataset.width !== String(state.width) ||
      elements.hitGrid.dataset.height !== String(state.height)
    ) {
      elements.hitGrid.innerHTML = "";
      elements.hitGrid.dataset.width = String(state.width);
      elements.hitGrid.dataset.height = String(state.height);

      for (let y = 0; y < state.height; y += 1) {
        for (let x = 0; x < state.width; x += 1) {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.x = String(x);
          button.dataset.y = String(y);
          elements.hitGrid.appendChild(button);
        }
      }
    }

    Array.from(elements.hitGrid.children).forEach((button) => {
      const x = Number(button.dataset.x);
      const y = Number(button.dataset.y);
      updateCellButton(button, x, y);
    });

    if (options.renderScene !== false) {
      renderEditorScene();
    }
  }

  function renderSelectedCell() {
    const x = state.selectedCell.x;
    const y = state.selectedCell.y;
    const value = state.cells[y][x];
    const descriptor = getCellDescriptor(value);

    elements.selectedCellLabel.textContent =
      "Cell " +
      (x + 1) +
      ", " +
      (y + 1) +
      " is " +
      value +
      " (" +
      descriptor.label +
      "). Right-click a cell to grab its token.";
    elements.cellValue.value = value;
  }

  function renderRawOutput() {
    elements.rawOutput.value = serializeCells();
  }

  function levelUrlFromTemplate(template, levelId, fallback) {
    const value = String(template || "");
    return value.includes("__LEVEL_ID__")
      ? value.replaceAll("__LEVEL_ID__", encodeURIComponent(levelId))
      : fallback;
  }

  function authorUrlForLevel(levelId) {
    return levelUrlFromTemplate(
      authorData.authorUrlTemplate,
      levelId,
      "/author/" + encodeURIComponent(authorData.game.id) + "/" + encodeURIComponent(levelId)
    );
  }

  function playUrlForLevel(levelId) {
    return levelUrlFromTemplate(
      authorData.playUrlTemplate,
      levelId,
      "/play/" + encodeURIComponent(authorData.game.id) + "/" + encodeURIComponent(levelId)
    );
  }

  function renderMeta() {
    elements.boardWidth.value = String(state.width);
    elements.boardHeight.value = String(state.height);
    if (elements.boardSizeLabel) {
      elements.boardSizeLabel.textContent = state.width + " x " + state.height;
    }
    if (elements.currentFileName) {
      elements.currentFileName.textContent = state.filePath;
    }
    if (elements.currentLevelName) {
      elements.currentLevelName.textContent = state.levelId.replace("level_", "");
    }
    const playUrl = playUrlForLevel(state.levelId);
    elements.playLink.href = playUrl;
    elements.playLink.setAttribute("aria-label", "Play " + state.levelId);
    document.querySelectorAll("[data-author-play-link]").forEach((link) => {
      link.href = playUrl;
      link.setAttribute("aria-label", "Play " + state.levelId);
    });
    syncSolverButtonState();
  }

  function renderExistingLevels() {
    if (!elements.existingLevels) {
      return;
    }

    const levelsById = new Map(authorData.existingLevels.map((level) => [level.id, level]));
    const draftLevelsById = new Map(
      hostedWorldLevelEntries().map((level) => [level.id, level])
    );

    if (state.exists && !levelsById.has(state.levelId)) {
      const created = {
        authorUrl: authorUrlForLevel(state.levelId),
        id: state.levelId,
        label: state.levelId.replace("level_", "Level "),
        playUrl: playUrlForLevel(state.levelId)
      };
      authorData.existingLevels.push(created);
      authorData.existingLevels.sort((left, right) => left.id.localeCompare(right.id));
      levelsById.set(created.id, created);
    }

    // The tray is the WHOLE world map: every room of the NxM grid renders as
    // a tile (thumbnail when the room has been built, dimmed placeholder when
    // it hasn't), and clicking any tile switches the editor to that room.
    elements.existingLevels.style.setProperty("--author-world-columns", String(worldColumns.length));

    const previewFor = (levelId) => {
      // Local live render first; server thumbnails only bridge the gap until
      // the local pass lands.
      const local = localLevelThumbs.get(levelId);
      if (local) {
        return local;
      }
      const level = draftLevelsById.get(levelId) || levelsById.get(levelId);
      const cells = levelId === state.levelId ? state.cells : level?.cells;
      const width = levelId === state.levelId ? state.width : level?.width;
      const height = levelId === state.levelId ? state.height : level?.height;

      if (
        !clientPreviewPersistence &&
        Array.isArray(cells) &&
        cells.length > 0
      ) {
        return renderSimpleLevelThumbFromCells(levelId, cells, width, height);
      }
      const fromWorld = authorData.worldPreviewUrls && authorData.worldPreviewUrls[levelId];
      return fromWorld || level?.previewUrl || null;
    };

    const tiles = [];
    worldRows.forEach((rowLetter) => {
      worldColumns.forEach((columnLetter) => {
        const levelId = "level_" + columnLetter + "x" + rowLetter;
        const exists = levelsById.has(levelId);
        const isActive = levelId === state.levelId;
        const preview = previewFor(levelId);
        const coordinateLabel = columnLetter + "x" + rowLetter;
        tiles.push(
          '<a class="author-level-pill' +
          (isActive ? " is-active" : "") +
          (exists || isActive ? "" : " is-empty") +
          (state.worldMapSwapMode && state.worldMapSwapFirstLevelId === levelId
            ? " is-swap-source"
            : "") +
          '" href="?level=' +
          encodeURIComponent(levelId) +
          '" data-level-id="' +
          escapeHtml(levelId) +
          '" title="' +
          escapeHtml((exists || isActive ? "Edit room " : "Start room ") + coordinateLabel) +
          '">' +
          (preview
            ? '<img class="author-level-pill__thumb" src="' + escapeHtml(preview) + '" alt="">'
            : '<span class="author-level-pill__label">' + escapeHtml(coordinateLabel) + "</span>") +
          "</a>"
        );
      });
    });

    elements.existingLevels.innerHTML = tiles.join("");
    renderWorldMapSwapControls();
    renderStartRoomGrid();
  }

  function renderWorldMapSwapControls() {
    if (!elements.worldMapSwap || !elements.worldMapSwapStatus) {
      return;
    }

    const panel = elements.worldMapSwap.closest(".author-world-map-panel");
    elements.worldMapSwap.disabled = state.worldMapSwapBusy;
    elements.worldMapSwap.setAttribute("aria-pressed", state.worldMapSwapMode ? "true" : "false");
    elements.worldMapSwap.textContent = state.worldMapSwapMode ? "Cancel swap" : "Swap rooms";
    elements.worldMapSwapStatus.textContent = state.worldMapSwapMessage;
    panel?.classList.toggle("is-swapping", state.worldMapSwapMode);
    panel?.setAttribute("aria-busy", state.worldMapSwapBusy ? "true" : "false");
  }

  function setWorldMapSwapMode(active, message) {
    if (state.worldMapSwapBusy) {
      return;
    }

    state.worldMapSwapMode = Boolean(active);
    state.worldMapSwapFirstLevelId = null;
    state.worldMapSwapMessage =
      message ||
      (state.worldMapSwapMode
        ? "Select the first built room."
        : "Choose Swap rooms, then select two built rooms.");
    renderExistingLevels();
  }

  async function swapWorldRooms(firstLevelId, secondLevelId) {
    state.worldMapSwapBusy = true;
    state.worldMapSwapMessage = "Saving and swapping rooms...";
    state.isLevelSwitching = true;
    finishPainting();
    renderWorldMapSwapControls();
    renderStatus();

    try {
      if (state.isDirty) {
        await saveLevel({
          refreshPreview: true,
          renderAfterSave: false,
          throwOnError: true,
          updateStatus: false
        });
      }

      if (!authorData.roomSwapApiUrl) {
        throw new Error("Room swapping is not available for this world.");
      }

      const response = await fetch(authorData.roomSwapApiUrl, {
        body: JSON.stringify({ firstLevelId, secondLevelId }),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST"
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || "Could not swap those rooms.");
      }

      const nextLevelId =
        state.levelId === firstLevelId
          ? secondLevelId
          : state.levelId === secondLevelId
            ? firstLevelId
            : state.levelId;
      allowDirtyUnload = true;
      window.location.assign(authorUrlForLevel(nextLevelId));
      return true;
    } catch (error) {
      state.isLevelSwitching = false;
      state.worldMapSwapBusy = false;
      state.worldMapSwapFirstLevelId = null;
      state.worldMapSwapMessage =
        error instanceof Error ? error.message : "Could not swap those rooms.";
      setStatus(state.worldMapSwapMessage, "error");
      renderExistingLevels();
      return false;
    }
  }

  function handleWorldMapSwapSelection(levelId) {
    if (!state.worldMapSwapMode) {
      return false;
    }

    if (state.worldMapSwapBusy) {
      return true;
    }

    const roomExists = authorData.existingLevels.some((level) => level.id === levelId);

    if (!roomExists) {
      state.worldMapSwapMessage = "That slot is empty. Choose a built room.";
      renderWorldMapSwapControls();
      return true;
    }

    if (!state.worldMapSwapFirstLevelId) {
      state.worldMapSwapFirstLevelId = levelId;
      state.worldMapSwapMessage =
        "Selected " + levelId.replace("level_", "") + ". Choose the second room.";
      renderExistingLevels();
      return true;
    }

    if (state.worldMapSwapFirstLevelId === levelId) {
      state.worldMapSwapFirstLevelId = null;
      state.worldMapSwapMessage = "First room deselected. Select a built room.";
      renderExistingLevels();
      return true;
    }

    swapWorldRooms(state.worldMapSwapFirstLevelId, levelId).catch(() => {});
    return true;
  }

  function renderAll(options = {}) {
    const renderScene = options.renderScene !== false;

    syncEditorDirtyState();
    renderStatus();
    renderMeta();
    renderNeighborButtons();
    renderSelectedTool();
    renderGrid({ renderScene });
    renderSelectedCell();
    renderRawOutput();
    renderExistingLevels();
  }

  function selectToken(token, options = {}) {
    if (state.isLevelLoading || state.isLevelSwitching) {
      return;
    }

    // Prompt pseudo-tools never become the paint token; the palette click
    // handler intercepts them and asks for an id first.
    if (isPromptToolToken(token)) {
      return;
    }

    // Pattern tokens (Box N, Clone N, colored slopes) are materialized into
    // toolByToken on first use, so anything resolvePatternToken accepts is
    // selectable even without an explicit palette entry.
    if (
      token !== eraserToken &&
      token !== noopToken &&
      !toolByToken.has(token) &&
      !materializePatternTool(token)
    ) {
      return;
    }

    if (isPaintStrokeActive() && token !== state.selectedToken) {
      finishPainting();
    }

    state.selectedToken = token;
    const slotIndex = hotbarSlots.indexOf(token);
    if (options.assignToActiveSlot === true && hotbarSlots.length > 0) {
      // Toolbox and eyedropper picks belong in the slot the builder already
      // highlighted. If that tool lives elsewhere, exchange the two tools so
      // the hotbar remains a stable, duplicate-free ten-slot inventory.
      activeHotbarSlotIndex = swapTokenIntoHotbarSlot(
        hotbarSlots,
        activeHotbarSlotIndex,
        token
      );
    } else if (slotIndex >= 0) {
      // Selecting a tool that's already on the hotbar highlights its slot.
      activeHotbarSlotIndex = slotIndex;
    } else if (hotbarSlots.length > 0) {
      // Tools picked outside the hotbar (toolbox, right-click pick) land in
      // the slot that was highlighted, not always the last one.
      activeHotbarSlotIndex = Math.max(0, Math.min(activeHotbarSlotIndex, hotbarSlots.length - 1));
      hotbarSlots[activeHotbarSlotIndex] = token;
    }
    syncEditorDirtyState();
    renderPalette();
    renderSelectedTool();
    renderStatus();
    const selectedTool = toolForToken(token);
    requestPatternPalettePreview(selectedTool);
    flashHotbarToolname(selectedTool?.label || "");
  }

  function selectCell(x, y) {
    if (!isInsideEditorCell(x, y)) {
      return false;
    }

    const previousCell = state.selectedCell;

    state.selectedCell = { x, y };

    if (isPaintStrokeActive()) {
      refreshHitButton(previousCell.x, previousCell.y);
      refreshHitButton(state.selectedCell.x, state.selectedCell.y);
    } else {
      renderGrid({ renderScene: false });
    }

    renderSelectedCell();
    return true;
  }

  function markDirty() {
    clearSolverSolution();
    clearHillClimbResults();
    syncEditorDirtyState();
    renderStatus();
    // Keep the world-map tile for this room live while painting.
    scheduleCurrentLevelThumbRefresh();

    if (isPaintStrokeActive()) {
      // Raw output and solver button syncing are flushed once when the paint
      // stroke ends (see stopPainting).
      return;
    }

    renderRawOutput();
    syncSolverButtonState();
  }

  // Cheap render path used while a paint stroke is active: refreshes only the
  // hit buttons whose cells (or selection) changed and coalesces the 3D scene
  // re-render to at most one per animation frame. The full grid refresh runs
  // once when the stroke ends.
  function renderPaintStrokeChange(changedCells, selectedX, selectedY) {
    const previousCell = state.selectedCell;

    state.paintStrokeDidPaint = true;
    if (isInsideEditorCell(selectedX, selectedY)) {
      state.selectedCell = { x: selectedX, y: selectedY };
    }
    refreshHitButton(previousCell.x, previousCell.y);
    changedCells.forEach((cell) => refreshHitButton(cell.x, cell.y));
    refreshHitButton(state.selectedCell.x, state.selectedCell.y);
    renderSelectedCell();
    markDirty();
    scheduleEditorSceneRender();
  }

  function updateCellValue(x, y, normalizedValue) {
    if (!isInsideEditorCell(x, y)) {
      return false;
    }

    if (state.cells[y][x] === normalizedValue) {
      selectCell(x, y);
      return false;
    }

    if (!isPaintStrokeActive() || !state.paintStrokeDidPaint) {
      pushUndoSnapshot({ boardChanged: true });
    }
    state.cells[y][x] = normalizedValue;

    if (isPaintStrokeActive()) {
      renderPaintStrokeChange([{ x, y }], x, y);
      return true;
    }

    state.selectedCell = { x, y };
    renderGrid();
    renderSelectedCell();
    markDirty();
    return true;
  }

  function updateCellsForSingleMainPlayerPlacement(x, y, normalizedValue) {
    if (!isInsideEditorCell(x, y)) {
      return false;
    }

    const nextCells = state.cells.map((row) => row.slice());
    const targetValue = keepFirstMainPlayerTokenInCellValue(normalizedValue);
    const changedCells = [];

    if (nextCells[y][x] !== targetValue) {
      changedCells.push({ x, y });
    }

    nextCells[y][x] = targetValue;

    for (let rowIndex = 0; rowIndex < state.height; rowIndex += 1) {
      for (let columnIndex = 0; columnIndex < state.width; columnIndex += 1) {
        if (rowIndex === y && columnIndex === x) {
          continue;
        }

        const strippedValue = stripMainPlayerTokensFromCellValue(nextCells[rowIndex][columnIndex]);

        if (strippedValue !== nextCells[rowIndex][columnIndex]) {
          changedCells.push({ x: columnIndex, y: rowIndex });
          nextCells[rowIndex][columnIndex] = strippedValue;
        }
      }
    }

    if (changedCells.length === 0) {
      selectCell(x, y);
      return false;
    }

    if (!isPaintStrokeActive() || !state.paintStrokeDidPaint) {
      pushUndoSnapshot({ boardChanged: true });
    }
    state.cells = nextCells;

    if (isPaintStrokeActive()) {
      renderPaintStrokeChange(changedCells, x, y);
      return true;
    }

    state.selectedCell = { x, y };
    renderGrid();
    renderSelectedCell();
    markDirty();
    return true;
  }

  function setCellValue(x, y, value) {
    if (!isInsideEditorCell(x, y) || isEditorInteractionLocked()) {
      return false;
    }

    const normalizedValue = normalizeAuthoringCellValue(value);

    if (cellValueHasMainPlayerToken(normalizedValue)) {
      return updateCellsForSingleMainPlayerPlacement(x, y, normalizedValue);
    }

    return updateCellValue(x, y, normalizedValue);
  }

  function appendTokenToCellValue(currentValue, token) {
    return appendCellToken(currentValue, token);
  }

  function eraseTopCellValue(currentValue) {
    const tokens = getCellTokens(currentValue);

    tokens.pop();

    return normalizeCellValue(
      tokens.some((token) => token.length > 0)
        ? tokens.join(authorData.blockAdder)
        : emptyCellToken
    );
  }

  function eraseResultForTarget(target) {
    if (!isInsideEditorCell(target.sourceX, target.sourceY)) {
      return null;
    }

    const currentValue = state.cells[target.sourceY][target.sourceX];
    const beforeTokens = getCellTokens(currentValue);
    const nextValue =
      target.sourceLayer === null || target.sourceLayer === undefined
        ? eraseTopCellValue(currentValue)
        : eraseCellElevationValue(currentValue, target.sourceLayer);

    if (nextValue === currentValue) {
      return null;
    }

    const afterTokens = getCellTokens(nextValue);
    const changedIndex = beforeTokens.findIndex((token, index) => token !== afterTokens[index]);
    const erasedToken = beforeTokens[
      changedIndex >= 0 ? changedIndex : Math.max(0, beforeTokens.length - 1)
    ];

    return {
      erasedToken,
      mode: isBaseSurfaceToken(erasedToken) ? "base" : "nonBase",
      nextValue
    };
  }

  function canEraseInCurrentGesture(mode) {
    if (!mode) {
      return false;
    }

    if (!state.eraseGestureMode) {
      return true;
    }

    return state.eraseGestureMode === "base" && mode === "base";
  }

  function paintCell(x, y, value) {
    if (!isInsideEditorCell(x, y) || isEditorInteractionLocked()) {
      return false;
    }

    if (value === noopToken) {
      selectCell(x, y);
      return false;
    }

    if (value === eraserToken) {
      return updateCellValue(x, y, eraseTopCellValue(state.cells[y][x]));
    }

    const isMainPlayerPaint = isMainPlayerToken(value);
    const currentValue = isMainPlayerPaint
      ? stripMainPlayerTokensFromCellValue(state.cells[y][x])
      : state.cells[y][x];
    const nextValue = appendTokenToCellValue(currentValue, value);

    if (isMainPlayerPaint) {
      return updateCellsForSingleMainPlayerPlacement(x, y, nextValue);
    }

    return updateCellValue(x, y, nextValue);
  }

  function isInsideEditorCell(x, y) {
    return (
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      x >= 0 &&
      y >= 0 &&
      x < state.width &&
      y < state.height
    );
  }

  function fallbackPaintTargetFromCell(x, y) {
    if (!isInsideEditorCell(x, y)) {
      return null;
    }

    return {
      face: "top",
      paintLayer: null,
      paintX: x,
      paintY: y,
      sourceLayer: null,
      sourceX: x,
      sourceY: y
    };
  }

  function fallbackPaintTargetFromButton(button) {
    if (!button) {
      return null;
    }

    return fallbackPaintTargetFromCell(Number(button.dataset.x), Number(button.dataset.y));
  }

  // The editor grid rect is cached and invalidated on resize/scroll/layout
  // changes instead of calling getBoundingClientRect per pointer event.
  function editorGridBoundingRect() {
    if (!editorGridRectCache.rect) {
      editorGridRectCache.rect = elements.grid.getBoundingClientRect();
    }

    return editorGridRectCache.rect;
  }

  function invalidateEditorGridRect() {
    editorGridRectCache.rect = null;
  }

  function fallbackPaintTargetFromPoint(clientX, clientY) {
    const rect = editorGridBoundingRect();

    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      clientX < rect.left ||
      clientX >= rect.right ||
      clientY < rect.top ||
      clientY >= rect.bottom
    ) {
      return null;
    }

    const x = Math.floor(((clientX - rect.left) / rect.width) * state.width);
    const y = Math.floor(((clientY - rect.top) / rect.height) * state.height);

    return fallbackPaintTargetFromCell(x, y);
  }

  function targetElementFromEvent(event) {
    return event.target instanceof Element ? event.target : null;
  }

  function resolveLevelSwitchTarget(target) {
    if (!target || target.kind !== "levelSwitch") {
      return null;
    }

    const dx = Math.round(Number(target.dx) || 0);
    const dy = Math.round(Number(target.dy) || 0);

    if (dx === 0 && dy === 0) {
      return null;
    }

    const levelId = adjacentLevelId(state.levelId, dx, dy);

    if (
      !levelId ||
      levelId === state.levelId ||
      (target.levelId && target.levelId !== levelId)
    ) {
      return null;
    }

    return { ...target, dx, dy, levelId };
  }

  function paintTargetFromPointerEvent(event) {
    const pickEditorFace = editorRenderer.app?.threeRenderer?.pickEditorFace;

    if (typeof pickEditorFace === "function") {
      const pickedTarget = pickEditorFace.call(
        editorRenderer.app.threeRenderer,
        event.clientX,
        event.clientY,
        elements.canvas
      );

      // A real 3D miss stays a miss. Mapping the blank pixel through the old
      // rectangular 2D fallback could select or paint an unrelated edge cell.
      if (!pickedTarget) {
        return null;
      }

      if (pickedTarget.kind === "levelSwitch") {
        return resolveLevelSwitchTarget(pickedTarget);
      }

      return isInsideEditorCell(pickedTarget.sourceX, pickedTarget.sourceY)
        ? pickedTarget
        : null;
    }

    // The cell-grid fallback is only for hosts where the 3D picker is not
    // available at all, never for a miss from a live perspective scene.
    return (
      fallbackPaintTargetFromButton(
        targetElementFromEvent(event)?.closest(".author-grid__cell")
      ) || fallbackPaintTargetFromPoint(event.clientX, event.clientY)
    );
  }

  function syncEditorHoverFromPointerEvent(event) {
    if (isEditorInteractionLocked()) {
      clearEditorHoverTarget();
      return null;
    }

    const target = paintTargetFromPointerEvent(event);

    editorRenderer.app?.threeRenderer?.setEditorHoverTarget?.(target);
    return target;
  }

  function clearEditorHoverTarget() {
    editorRenderer.app?.threeRenderer?.setEditorHoverTarget?.(null);
  }

  function paintTargetKey(target) {
    if (!target) {
      return "";
    }

    if (target.kind === "levelSwitch") {
      return "level-switch:" + (target.levelId || "") + ":" + (target.dx || 0) + ":" + (target.dy || 0);
    }

    if (state.selectedToken === noopToken) {
      return "";
    }

    const isEraser = state.selectedToken === eraserToken;
    const paintToken = isEraser ? state.selectedToken : effectivePaintToken();
    const x = isEraser ? target.sourceX : target.paintX;
    const y = isEraser ? target.sourceY : target.paintY;
    const paintLayer = adjustedPaintLayerForTarget(target);

    return [
      paintToken,
      x,
      y,
      paintLayer ?? "top",
      target.sourceLayer ?? "top",
      target.sourceX,
      target.sourceY,
      target.face || "top"
    ].join(":");
  }

  function isBaseSurfaceToken(token) {
    const tool = toolByToken.get(token);
    const type = tool?.type || tool?.name;

    return type === "floor" || type === "ice";
  }

  function isIceSlopeTool(tool) {
    return (tool?.type || tool?.name) === "ice_slope";
  }

  // Orange slopes are their own terrain type (they raise and lower with the
  // orange walls), and Box/Clone Ice Slopes are slope-SHAPED ACTORS of type
  // weightless_box/clone (they move with their group). The toolbox treats
  // every slope family the same way, so detection keys off the slope shape
  // and the S<direction><style> token pattern rather than tool type alone.
  function isSlopeFamilyTool(tool) {
    const type = tool?.type || tool?.name;
    if (type === "ice_slope" || type === "orange_ice_slope") {
      return true;
    }
    return tool?.shape === "slope" && slopeTokenStyleSuffix(tool?.token) !== null;
  }

  function isIceSlopeToken(token) {
    return isIceSlopeTool(toolByToken.get(token));
  }

  function toolTypeForToken(token) {
    const tool = toolByToken.get(token);
    return tool?.type || tool?.name || "";
  }

  function isMainPlayerToken(token) {
    const type = toolTypeForToken(token);

    return type === "player" || type === "circle_player";
  }

  function cellValueHasMainPlayerToken(value) {
    return getCellTokens(value).some((token) => isMainPlayerToken(token));
  }

  function stripMainPlayerTokensFromCellValue(value) {
    const tokens = getCellTokens(value).map((token) => (isMainPlayerToken(token) ? "" : token));

    return normalizeAuthoringCellValue(
      tokens.some((token) => token.length > 0)
        ? tokens.join(authorData.blockAdder)
        : emptyCellToken
    );
  }

  function keepFirstMainPlayerTokenInCellValue(value) {
    let hasMainPlayer = false;
    const tokens = getCellTokens(value).map((token) => {
      if (!isMainPlayerToken(token)) {
        return token;
      }

      if (hasMainPlayer) {
        return "";
      }

      hasMainPlayer = true;
      return token;
    });

    return normalizeAuthoringCellValue(
      tokens.some((token) => token.length > 0)
        ? tokens.join(authorData.blockAdder)
        : emptyCellToken
    );
  }

  function isPuncherToken(token) {
    return toolTypeForToken(token) === "puncher";
  }

  function isOrangeButtonToken(token) {
    return toolTypeForToken(token) === "orange_button";
  }

  function directionForPaintTarget(target) {
    const dx = Math.sign(Number(target?.dx) || 0);
    const dy = Math.sign(Number(target?.dy) || 0);

    if (dx > 0) {
      return "right";
    }

    if (dx < 0) {
      return "left";
    }

    if (dy > 0) {
      return "down";
    }

    if (dy < 0) {
      return "up";
    }

    return "";
  }

  function cameraFarDirection() {
    const [dx, dy] =
      typeof editorRenderer.app?.mapCameraRelativeDirection === "function"
        ? editorRenderer.app.mapCameraRelativeDirection(0, -1)
        : [0, -1];

    return directionForPaintTarget({ dx, dy });
  }

  function cameraFacingIceSlopeToken() {
    const family = slopeFamilyForToken(state.selectedToken);

    if (!family) {
      return state.selectedToken;
    }

    const direction = cameraFarDirection();

    return family.tokenByDirection.get(direction) || family.canonicalToken || state.selectedToken;
  }

  function effectivePaintToken() {
    return slopeFamilyForToken(state.selectedToken) ? cameraFacingIceSlopeToken() : state.selectedToken;
  }

  function puncherTokenForDirection(direction) {
    for (const [token, tool] of toolByToken.entries()) {
      if ((tool.type || tool.name) === "puncher" && tool.direction === direction) {
        return token;
      }
    }

    return "";
  }

  function targetHasPuncherSupport(target) {
    if (!target || target.kind === "levelSwitch") {
      return false;
    }

    if (!directionForPaintTarget(target)) {
      return false;
    }

    const sideHeight = Math.max(0, (target.topY ?? 0) - (target.bottomY ?? 0));

    return sideHeight >= 32;
  }

  function adjustedPaintLayerForTarget(target) {
    if (!target || state.selectedToken === eraserToken || state.selectedToken === noopToken) {
      return target?.paintLayer;
    }

    if (isBaseSurfaceToken(state.selectedToken)) {
      return 0;
    }

    const lockedLayer = state.paintDragPlane?.layer;
    if (
      lockedLayer !== null &&
      lockedLayer !== undefined &&
      Array.isArray(target.paintLayerCandidates) &&
      target.paintLayerCandidates.includes(lockedLayer)
    ) {
      return lockedLayer;
    }

    return target.paintLayer;
  }

  function paintPuncherTarget(target) {
    if (!targetHasPuncherSupport(target)) {
      return false;
    }

    if (!isInsideEditorCell(target.paintX, target.paintY)) {
      return false;
    }

    const directionToken = puncherTokenForDirection(directionForPaintTarget(target));

    if (!directionToken) {
      return false;
    }

    const targetLayer = adjustedPaintLayerForTarget(target);

    if (targetLayer === null || targetLayer === undefined) {
      return false;
    }

    const paintLayer = Math.max(0, Math.floor(Number(targetLayer) || 0));
    const currentValue = state.cells[target.paintY][target.paintX];
    const nextValue = placeCellElevationTokenIfVacant(
      currentValue,
      directionToken,
      paintLayer
    );

    if (nextValue === currentValue) {
      selectCell(target.paintX, target.paintY);
      return false;
    }

    return updateCellValue(target.paintX, target.paintY, nextValue);
  }

  function paintOrangeButtonTarget(target) {
    if (!target || target.kind === "levelSwitch" || target.face !== "top") {
      return false;
    }

    if (!isInsideEditorCell(target.paintX, target.paintY)) {
      return false;
    }

    const paintLayer = adjustedPaintLayerForTarget(target);

    if (paintLayer === null || paintLayer === undefined) {
      return false;
    }

    const paintToken = effectivePaintToken();
    const currentValue = state.cells[target.paintY][target.paintX];
    const vacancyProbe = placeCellElevationTokenIfVacant(
      currentValue,
      paintToken,
      paintLayer
    );

    if (vacancyProbe === currentValue) {
      selectCell(target.paintX, target.paintY);
      return false;
    }

    const nextValue = setSurfaceAttachmentToken(currentValue, paintToken, paintLayer);

    if (nextValue === currentValue) {
      selectCell(target.paintX, target.paintY);
      return false;
    }

    updateCellValue(target.paintX, target.paintY, nextValue);
    return true;
  }

  function paintFaceTarget(target) {
    if (isEditorInteractionLocked() || !target || target.kind === "levelSwitch") {
      return false;
    }

    if (state.selectedToken === noopToken) {
      const x = Number.isFinite(target.sourceX) ? target.sourceX : target.paintX;
      const y = Number.isFinite(target.sourceY) ? target.sourceY : target.paintY;

      if (isInsideEditorCell(x, y)) {
        selectCell(x, y);
      }

      return false;
    }

    if (state.selectedToken === eraserToken) {
      const eraseResult = eraseResultForTarget(target);

      if (!eraseResult || !canEraseInCurrentGesture(eraseResult.mode)) {
        return false;
      }

      state.eraseGestureMode = eraseResult.mode;
      updateCellValue(target.sourceX, target.sourceY, eraseResult.nextValue);
      return true;
    }

    if (isPuncherToken(state.selectedToken)) {
      return paintPuncherTarget(target);
    }

    if (isOrangeButtonToken(state.selectedToken)) {
      return paintOrangeButtonTarget(target);
    }

    if (!isInsideEditorCell(target.paintX, target.paintY)) {
      return false;
    }

    const paintToken = effectivePaintToken();
    const paintLayer = adjustedPaintLayerForTarget(target);
    const isMainPlayerPaint = isMainPlayerToken(paintToken);
    const currentValue = isMainPlayerPaint
      ? stripMainPlayerTokensFromCellValue(state.cells[target.paintY][target.paintX])
      : state.cells[target.paintY][target.paintX];
    const nextValue =
      paintLayer === null || paintLayer === undefined
        ? appendTokenToCellValue(currentValue, paintToken)
        : placeCellElevationTokenIfVacant(currentValue, paintToken, paintLayer);

    if (isMainPlayerPaint) {
      // Do not remove the player from its old cell when the requested target
      // was occupied and the non-replacing placement therefore failed.
      if (!cellValueHasMainPlayerToken(nextValue)) {
        selectCell(target.paintX, target.paintY);
        return false;
      }
      return updateCellsForSingleMainPlayerPlacement(target.paintX, target.paintY, nextValue);
    }

    return updateCellValue(target.paintX, target.paintY, nextValue);
  }

  function paintFaceTargetOnce(target) {
    const key = paintTargetKey(target);

    if (!key || key === state.lastPaintTargetKey) {
      return false;
    }

    state.lastPaintTargetKey = key;
    const didPaint = paintFaceTarget(target);

    if (didPaint) {
      const voxelKey = paintVoxelKeyForTarget(target);

      // Only the most recently created side-pickable voxel is unsafe as a
      // launch point. Base floor/ice edits do not create a side face and must
      // not make an existing wall at that coordinate look newly painted.
      state.paintStrokePaintedVoxelKeys.clear();
      if (voxelKey && !isBaseSurfaceToken(state.selectedToken)) {
        state.paintStrokePaintedVoxelKeys.add(voxelKey);
      }
    }

    return didPaint;
  }

  function paintGestureLayerForTarget(target) {
    if (!target) {
      return null;
    }

    return state.selectedToken === eraserToken
      ? target.sourceLayer
      : adjustedPaintLayerForTarget(target);
  }

  function paintVoxelKeyForTarget(target, useSource = false) {
    if (!target) {
      return "";
    }

    const useSourceCell = useSource || state.selectedToken === eraserToken;
    const x = useSourceCell ? target.sourceX : target.paintX;
    const y = useSourceCell ? target.sourceY : target.paintY;
    const lockedLayer = state.paintDragPlane?.layer;
    const layer =
      useSource &&
      lockedLayer !== null &&
      lockedLayer !== undefined &&
      Array.isArray(target.sourceLayerCandidates) &&
      target.sourceLayerCandidates.includes(lockedLayer)
        ? lockedLayer
        : useSource
          ? target.sourceLayer
          : paintGestureLayerForTarget(target);

    if (!isInsideEditorCell(x, y) || layer === null || layer === undefined) {
      return "";
    }

    return x + ":" + y + ":" + Math.max(0, Math.floor(Number(layer) || 0));
  }

  function canDragEraseFromTarget(target, layer) {
    if (state.selectedToken !== eraserToken) {
      return true;
    }

    if (
      !target ||
      target.face !== "top" ||
      Math.max(0, Math.floor(Number(layer) || 0)) !== 0 ||
      !isInsideEditorCell(target.sourceX, target.sourceY)
    ) {
      return false;
    }

    const bottomToken = String(getCellTokens(state.cells[target.sourceY][target.sourceX])?.[0] || "").trim();
    const topY = Number(target.topY);

    return isBaseSurfaceToken(bottomToken) && (!Number.isFinite(topY) || topY <= 0.05);
  }

  function paintDragPlaneForTarget(target) {
    if (
      !target ||
      target.kind === "levelSwitch" ||
      state.selectedToken === noopToken
    ) {
      return null;
    }

    const layer = paintGestureLayerForTarget(target);

    if (layer === null || layer === undefined) {
      return null;
    }

    if (!canDragEraseFromTarget(target, layer)) {
      return null;
    }

    return { layer };
  }

  function canDragPaintTarget(target) {
    if (!state.paintDragPlane) {
      return false;
    }

    if (
      state.paintStrokeLevelId !== state.levelId ||
      state.paintStrokeToken !== state.selectedToken
    ) {
      return false;
    }

    // A successful placement can move the yellow highlight onto the voxel it
    // just created without the pointer actually leaving that block. Keep the
    // guard latched until the picker highlights a different source voxel;
    // repeated samples on the new block must not grow or stack more blocks.
    const justPaintedVoxelKey =
      state.paintStrokePaintedVoxelKeys.values().next().value || "";

    if (!target || target.kind === "levelSwitch") {
      return false;
    }

    if (justPaintedVoxelKey) {
      const highlightedVoxelKey = paintVoxelKeyForTarget(target, true);

      if (!highlightedVoxelKey || highlightedVoxelKey === justPaintedVoxelKey) {
        return false;
      }

      state.paintStrokePaintedVoxelKeys.clear();
    }

    const layer = paintGestureLayerForTarget(target);

    if (layer !== state.paintDragPlane.layer) {
      return false;
    }

    if (state.selectedToken === eraserToken) {
      return canDragEraseFromTarget(target, layer);
    }

    if (!isInsideEditorCell(target.paintX, target.paintY)) {
      return false;
    }

    return true;
  }

  function resizeLevel() {
    if (isEditorInteractionLocked()) {
      return;
    }

    const requestedWidth = Number(elements.boardWidth.value);
    const requestedHeight = Number(elements.boardHeight.value);
    const nextWidth = Math.max(1, Math.min(authorData.maxBoardWidth, requestedWidth || state.width));
    const nextHeight = Math.max(1, Math.min(authorData.maxBoardHeight, requestedHeight || state.height));
    const nextCells = createBlankCells(nextWidth, nextHeight, authorData.defaultFloorToken);

    for (let y = 0; y < Math.min(state.height, nextHeight); y += 1) {
      for (let x = 0; x < Math.min(state.width, nextWidth); x += 1) {
        nextCells[y][x] = state.cells[y][x];
      }
    }

    pushUndoSnapshot();
    state.width = nextWidth;
    state.height = nextHeight;
    state.cells = nextCells;
    clearSolverSolution();
    state.selectedCell = {
      x: Math.min(state.selectedCell.x, state.width - 1),
      y: Math.min(state.selectedCell.y, state.height - 1)
    };
    setStatus("Resized the board.", "warning");
    state.isDirty = true;
    renderAll();
  }

  function clearLevel() {
    if (isEditorInteractionLocked()) {
      return;
    }

    pushUndoSnapshot();
    state.cells = createBlankCells(state.width, state.height, authorData.defaultFloorToken);
    clearSolverSolution();
    state.selectedCell = { x: 0, y: 0 };
    setStatus("Cleared the board to floor tiles.", "warning");
    state.isDirty = true;
    renderAll();
  }

  function centeredEdgeOpeningRange(length) {
    const openingSize = Math.max(0, Math.min(4, length - 2));

    if (openingSize === 0) {
      return null;
    }

    const start = Math.floor((length - openingSize) / 2);

    return {
      start,
      end: start + openingSize - 1
    };
  }

  function frameLevel() {
    if (isEditorInteractionLocked()) {
      return;
    }

    const horizontalOpening = centeredEdgeOpeningRange(state.width);
    const verticalOpening = centeredEdgeOpeningRange(state.height);

    pushUndoSnapshot();
    for (let y = 0; y < state.height; y += 1) {
      for (let x = 0; x < state.width; x += 1) {
        const isEdge = x === 0 || y === 0 || x === state.width - 1 || y === state.height - 1;
        const isHorizontalOpening =
          horizontalOpening !== null &&
          (y === 0 || y === state.height - 1) &&
          x >= horizontalOpening.start &&
          x <= horizontalOpening.end;
        const isVerticalOpening =
          verticalOpening !== null &&
          (x === 0 || x === state.width - 1) &&
          y >= verticalOpening.start &&
          y <= verticalOpening.end;

        if (isEdge) {
          state.cells[y][x] =
            isHorizontalOpening || isVerticalOpening
              ? authorData.defaultFloorToken
              : appendCellToken(authorData.defaultFloorToken, authorData.defaultWallToken);
        }
      }
    }

    clearSolverSolution();
    setStatus("Wrapped the border and left 4-tile openings centered on each side.", "warning");
    state.isDirty = true;
    renderAll();
  }

  function transformLevel(transformType) {
    if (isEditorInteractionLocked()) {
      return;
    }

    const oldCells = state.cells;
    const oldWidth = state.width;
    const oldHeight = state.height;
    const oldSelectedCell = state.selectedCell;
    let nextCells;
    let nextWidth = oldWidth;
    let nextHeight = oldHeight;
    let nextSelectedCell = oldSelectedCell;
    let message = "Transformed the board.";

    if (transformType === "rotate-left" || transformType === "rotate-right") {
      nextWidth = oldHeight;
      nextHeight = oldWidth;

      if (nextWidth > authorData.maxBoardWidth || nextHeight > authorData.maxBoardHeight) {
        setStatus("That rotation would exceed the editor board limits.", "error");
        return;
      }
    }

    if (transformType === "rotate-left") {
      nextCells = Array.from({ length: nextHeight }, (_, y) =>
        Array.from({ length: nextWidth }, (_, x) => oldCells[x][oldWidth - 1 - y])
      );
      nextSelectedCell = {
        x: oldSelectedCell.y,
        y: oldWidth - 1 - oldSelectedCell.x
      };
      message = "Rotated the board left.";
    } else if (transformType === "rotate-right") {
      nextCells = Array.from({ length: nextHeight }, (_, y) =>
        Array.from({ length: nextWidth }, (_, x) => oldCells[oldHeight - 1 - x][y])
      );
      nextSelectedCell = {
        x: oldHeight - 1 - oldSelectedCell.y,
        y: oldSelectedCell.x
      };
      message = "Rotated the board right.";
    } else if (transformType === "flip-horizontal") {
      nextCells = oldCells.map((row) => row.slice().reverse());
      nextSelectedCell = {
        x: oldWidth - 1 - oldSelectedCell.x,
        y: oldSelectedCell.y
      };
      message = "Flipped the board horizontally.";
    } else if (transformType === "flip-vertical") {
      nextCells = oldCells.slice().reverse().map((row) => row.slice());
      nextSelectedCell = {
        x: oldSelectedCell.x,
        y: oldHeight - 1 - oldSelectedCell.y
      };
      message = "Flipped the board vertically.";
    } else {
      return;
    }

    if (typeof tokenPatternHelpers?.transformDirectionalCellValue === "function") {
      nextCells = nextCells.map((row) =>
        row.map((cell) =>
          tokenPatternHelpers.transformDirectionalCellValue(
            cell,
            authorData.blockAdder,
            transformType
          )
        )
      );
    }

    pushUndoSnapshot();
    state.width = nextWidth;
    state.height = nextHeight;
    state.cells = nextCells;
    clearSolverSolution();
    state.selectedCell = nextSelectedCell;
    setStatus(message, "warning");
    state.isDirty = true;
    renderAll();
  }

  function applySelectedCellValue() {
    if (isEditorInteractionLocked()) {
      return;
    }

    try {
      setCellValue(state.selectedCell.x, state.selectedCell.y, elements.cellValue.value);
      setStatus("Updated that cell.", "warning");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update that cell.", "error");
      renderSelectedCell();
    }
  }

  function shouldDiscardUnsavedChanges() {
    return !state.isDirty || window.confirm("Discard your unsaved changes?");
  }

  let unsavedPromptResolve = null;
  let allowDirtyUnload = false;

  function closeUnsavedChangesPrompt(choice = "cancel") {
    elements.unsavedModal.classList.remove("open");
    const resolve = unsavedPromptResolve;
    unsavedPromptResolve = null;
    if (resolve) resolve(choice);
  }

  function ensureUnsavedChangesPromptListeners() {
    if (elements.unsavedModal.dataset.bound === "true") return;
    elements.unsavedModal.dataset.bound = "true";
    elements.unsavedCancel.addEventListener("click", () => closeUnsavedChangesPrompt("cancel"));
    elements.unsavedSave.addEventListener("click", () => closeUnsavedChangesPrompt("save"));
    elements.unsavedModal.addEventListener("click", (event) => {
      if (event.target === elements.unsavedModal) closeUnsavedChangesPrompt("cancel");
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && elements.unsavedModal.classList.contains("open")) {
        event.preventDefault();
        closeUnsavedChangesPrompt("cancel");
      }
    });
  }

  function promptForUnsavedChanges(options = {}) {
    if (!state.isDirty) return Promise.resolve("clean");
    ensureUnsavedChangesPromptListeners();
    if (unsavedPromptResolve) closeUnsavedChangesPrompt("cancel");
    elements.unsavedMessage.textContent =
      options.message ||
      (hostedWorldDraftMode
        ? "This world has unsaved changes. Save before continuing?"
        : "This room has unsaved changes. Save before continuing?");
    elements.unsavedSave.textContent = options.saveLabel || "Save & Continue";
    elements.unsavedModal.classList.add("open");
    window.setTimeout(() => elements.unsavedSave.focus(), 0);
    return new Promise((resolve) => {
      unsavedPromptResolve = resolve;
    });
  }

  // ---- Numeric-id prompt for Box N / Clone N / colored slope entries ----
  // Same promise-based modal shape as the unsaved-changes prompt above.
  let tokenIdPromptResolve = null;

  function hasTokenIdPromptElements() {
    return Boolean(
      elements.tokenIdModal &&
        elements.tokenIdTitle &&
        elements.tokenIdMessage &&
        elements.tokenIdInput &&
        elements.tokenIdCancel &&
        elements.tokenIdConfirm
    );
  }

  function closeTokenIdPrompt(value = null) {
    elements.tokenIdModal.classList.remove("open");
    const resolve = tokenIdPromptResolve;
    tokenIdPromptResolve = null;
    if (resolve) resolve(value);
  }

  function submitTokenIdPrompt() {
    const id = Number(elements.tokenIdInput.value);

    if (!Number.isInteger(id) || id < 0) {
      elements.tokenIdInput.setCustomValidity("Enter a whole number of 0 or more.");
      elements.tokenIdInput.reportValidity();
      return;
    }

    elements.tokenIdInput.setCustomValidity("");
    closeTokenIdPrompt(id);
  }

  function ensureTokenIdPromptListeners() {
    if (elements.tokenIdModal.dataset.bound === "true") return;
    elements.tokenIdModal.dataset.bound = "true";
    elements.tokenIdCancel.addEventListener("click", () => closeTokenIdPrompt(null));
    elements.tokenIdConfirm.addEventListener("click", submitTokenIdPrompt);
    elements.tokenIdInput.addEventListener("input", () =>
      elements.tokenIdInput.setCustomValidity("")
    );
    elements.tokenIdInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitTokenIdPrompt();
      }
    });
    elements.tokenIdModal.addEventListener("click", (event) => {
      if (event.target === elements.tokenIdModal) closeTokenIdPrompt(null);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && elements.tokenIdModal.classList.contains("open")) {
        event.preventDefault();
        closeTokenIdPrompt(null);
      }
    });
  }

  function promptForTokenId(promptTool) {
    if (!hasTokenIdPromptElements()) {
      // Same native-dialog precedent as shouldDiscardUnsavedChanges().
      const raw = window.prompt(promptTool.prompt.message, String(promptTool.prompt.defaultId));
      if (raw === null) return Promise.resolve(null);
      const id = Number(String(raw).trim());
      return Promise.resolve(Number.isInteger(id) && id >= 0 ? id : null);
    }
    ensureTokenIdPromptListeners();
    if (tokenIdPromptResolve) closeTokenIdPrompt(null);
    elements.tokenIdTitle.textContent = promptTool.label;
    elements.tokenIdMessage.textContent = promptTool.prompt.message;
    elements.tokenIdInput.value = String(promptTool.prompt.defaultId);
    elements.tokenIdInput.setCustomValidity("");
    elements.tokenIdModal.classList.add("open");
    window.setTimeout(() => {
      elements.tokenIdInput.focus();
      elements.tokenIdInput.select();
    }, 0);
    return new Promise((resolve) => {
      tokenIdPromptResolve = resolve;
    });
  }

  async function promptAndSelectPatternToken(promptToken) {
    const promptTool = promptToolsByToken.get(promptToken);

    if (!promptTool || isEditorInteractionLocked()) {
      return;
    }

    const id = await promptForTokenId(promptTool);

    if (id === null) {
      return;
    }

    const token = promptTool.prompt.makeToken(id);
    const tool = materializePatternTool(token);

    if (!tool) {
      setStatus('Unknown token "' + token + '".', "error");
      return;
    }

    // Colored slopes register their whole family so the painted token can
    // follow the camera like the plain ice slope does.
    slopeFamilyForToken(token);
    selectToken(token, { assignToActiveSlot: true });
  }

  async function navigateFromEditor(link) {
    const destination = String(link.textContent || "that page").trim();
    const choice = await promptForUnsavedChanges({
      message:
        (hostedWorldDraftMode ? "This world" : "This room") +
        " has unsaved changes. Save before opening " +
        destination +
        "?",
      saveLabel: "Save & Continue"
    });
    if (choice === "cancel") return false;
    setStatus("Saving before leaving...", "warning");
    const saved = await saveLevel({ refreshPreview: false });
    if (!saved || state.isDirty) return false;
    allowDirtyUnload = true;
    window.location.assign(link.href);
    return true;
  }

  function installUnsavedNavigationGuards() {
    document.querySelectorAll(".author-nav a, .build-mobile-blocker__actions a").forEach((link) => {
      link.addEventListener("click", (event) => {
        if (!state.isDirty || event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigateFromEditor(link);
      });
    });
  }

  function cachedAuthorLevelPayload(levelId) {
    if (!hostedWorldDraftMode) {
      return null;
    }

    const level = hostedWorldDraftLevels.get(levelId);

    if (!level || !Array.isArray(level.cells) || level.cells.length === 0) {
      return null;
    }

    const width = Math.max(1, Number(level.width) || level.cells[0]?.length || 1);
    const height = Math.max(1, Number(level.height) || level.cells.length || 1);
    const cells = cloneCells(level.cells);

    return {
      cells,
      exists: level.exists === true,
      fileName: levelId + ".txt",
      filePath: "build-worlds/" + levelId + ".txt",
      height,
      hotbarTokens: hotbarTokens(),
      label: level.label || levelId,
      levelId,
      message: "Loaded locally.",
      playUrl: playUrlForLevel(levelId),
      previewUrl: localLevelThumbs.get(levelId) || level.previewUrl || null,
      rawText: cells.map((row) => row.join(authorData.separator)).join("\n"),
      width
    };
  }

  async function fetchAuthorLevelPayload(levelId) {
    // Hosted pages already carry every saved room so the editor can render
    // the whole world. Reuse that snapshot for room switching instead of
    // spending an authenticated API read (and a rate-limit token) per click.
    const cachedPayload = cachedAuthorLevelPayload(levelId);
    if (cachedPayload) {
      return cachedPayload;
    }

    const response = await fetch(
      authorData.authorApiBaseUrl + "/" + encodeURIComponent(levelId),
      { headers: { Accept: "application/json" } }
    );
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Could not load that level.");
    }

    return payload;
  }

  function applyAuthorLevelPayload(payload, options = {}) {
    if (!hostedWorldDraftMode) {
      applyPersistedHotbarTokens(payload.hotbarTokens, savedHotbarTokens);
    }
    const normalizedCells = normalizeAuthoringCells(payload.cells);
    state.cells = cloneCells(normalizedCells);
    state.exists = payload.exists;
    state.fileName = payload.fileName;
    state.filePath = payload.filePath;
    state.height = payload.height;
    state.levelId = payload.levelId;
    state.message =
      options.message ||
      (payload.exists ? "Loaded existing level." : "Fresh level. Paint something good.");
    state.messageTone =
      options.messageTone || (payload.exists ? "success" : "warning");
    state.savedBoardSignature = hostedWorldDraftMode
      ? hostedSavedLevelSignatures.get(payload.levelId) ||
        boardSignature(payload.width, payload.height, normalizedCells)
      : boardSignature(payload.width, payload.height, normalizedCells);
    state.selectedCell = { x: 0, y: 0 };
    clearSolverSolution();
    clearUndoHistory();
    state.width = payload.width;
    syncEditorDirtyState();
  }

  async function loadLevel(levelId) {
    if (isEditorInteractionLocked()) {
      syncLevelSelectors();
      return false;
    }

    if (!hostedWorldDraftMode && !shouldDiscardUnsavedChanges()) {
      syncLevelSelectors();
      return false;
    }

    window.clearTimeout(currentLevelThumbTimer);
    currentLevelThumbTimer = 0;
    cancelScheduledPointerMove();
    finishPainting();
    if (hostedWorldDraftMode) {
      stageCurrentHostedWorldLevel();
    }
    state.isLevelLoading = true;
    clearEditorHoverTarget();
    syncUndoButtonState();
    setStatus("Loading " + String(levelId || "room").replace("level_", "") + "...", "warning");

    try {
      applyAuthorLevelPayload(await fetchAuthorLevelPayload(levelId));
      syncLevelSelectors();
      window.history.replaceState(
        null,
        "",
        authorUrlForLevel(state.levelId)
      );
      renderAll();
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load that level.", "error");
      syncLevelSelectors();
      return false;
    } finally {
      state.isLevelLoading = false;
      renderStatus();
    }
  }

  function hostedWorldEditorStateSnapshot() {
    stageCurrentHostedWorldLevel();
    const meta = authorData.worldMeta || {};
    return {
      hotbar_tokens: hotbarTokens(),
      levels: hostedWorldLevelEntries()
        .filter((level) => level.exists || hostedDirtyLevelIds.has(level.id))
        .map((level) => ({
          cells: cloneCells(level.cells),
          column: level.column,
          height: level.height,
          id: level.id,
          row: level.row,
          title: level.title || level.label || level.id.replace("level_", ""),
          width: level.width
        })),
      start_level_id:
        meta.startLevelId || authorData.initialLevel?.levelId || hostedWorldLevelEntries()[0]?.id,
      title: meta.title || authorData.game?.name || "Untitled World",
      version: 1,
      world: {
        height: worldRows.length,
        width: worldColumns.length
      }
    };
  }

  function applyHostedWorldSavePayload(payload, submittedHotbarTokens) {
    const persistedState = payload?.world?.editor_state;
    if (!persistedState || !Array.isArray(persistedState.levels)) {
      throw new Error("The saved world response was incomplete.");
    }
    hostedWorldDraftLevels.clear();
    hostedSavedLevelSignatures.clear();
    hostedDirtyLevelIds.clear();
    const persistedAuthorLevels = [];
    persistedState.levels.forEach((level) => {
      const record = hostedWorldLevelRecord(level.id, {
        ...level,
        exists: true,
        label: level.title
      });
      hostedWorldDraftLevels.set(record.id, record);
      hostedSavedLevelSignatures.set(
        record.id,
        boardSignature(record.width, record.height, record.cells)
      );
      persistedAuthorLevels.push({
        authorUrl: authorUrlForLevel(record.id),
        cells: cloneCells(record.cells),
        height: record.height,
        id: record.id,
        label: record.title,
        playUrl: playUrlForLevel(record.id),
        previewUrl: localLevelThumbs.get(record.id) || null,
        width: record.width
      });
    });
    worldRows.forEach((row) => {
      worldColumns.forEach((column) => {
        const levelId = "level_" + column + "x" + row;
        if (hostedWorldDraftLevels.has(levelId)) {
          return;
        }
        const record = hostedWorldLevelRecord(
          levelId,
          { exists: false },
          { synthesizeMissing: true }
        );
        hostedWorldDraftLevels.set(levelId, record);
        hostedSavedLevelSignatures.set(
          levelId,
          boardSignature(record.width, record.height, record.cells)
        );
      });
    });
    authorData.existingLevels.splice(
      0,
      authorData.existingLevels.length,
      ...persistedAuthorLevels
    );
    applyPersistedHotbarTokens(persistedState.hotbar_tokens, submittedHotbarTokens);
    const current = hostedWorldDraftLevels.get(state.levelId);
    if (current) {
      state.cells = cloneCells(current.cells);
      state.exists = current.exists === true;
      state.height = current.height;
      state.width = current.width;
      state.savedBoardSignature = hostedSavedLevelSignatures.get(state.levelId);
    }
    if (authorData.worldMeta) {
      authorData.worldMeta.gemsByLevel = Object.fromEntries(
        persistedAuthorLevels.map((level) => [
          level.id,
          gemCountForCells(level.cells)
        ])
      );
      authorData.worldMeta.savedThisSession = true;
      authorData.worldMeta.updatedAt = payload.world?.updated_at || authorData.worldMeta.updatedAt;
      authorData.worldMeta.walkthroughVerified = false;
    }
    syncEditorDirtyState();
    primeEditorWorldNeighbors();
    scheduleCurrentLevelThumbRefresh(0, { persist: false });
  }

  async function saveHostedWorldDraft(options = {}) {
    const renderAfterSave = options.renderAfterSave !== false;
    const updateStatus = options.updateStatus !== false;
    const throwOnError = options.throwOnError === true;
    const editorState = hostedWorldEditorStateSnapshot();
    const submittedHotbarTokens = hotbarTokens();
    state.isLevelLoading = true;
    if (updateStatus) {
      setStatus("Saving the whole world...", "warning");
    } else {
      renderStatus();
    }
    try {
      const response = await fetch(authorData.worldMeta.apiUrl, {
        body: JSON.stringify({
          editor_state: editorState,
          title: editorState.title,
          world_height: editorState.world.height,
          world_width: editorState.world.width
        }),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        method: "PATCH"
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Could not save that world.");
      }
      applyHostedWorldSavePayload(payload, submittedHotbarTokens);
      state.message = "World saved.";
      state.messageTone = "success";
      state.isLevelLoading = false;
      syncLevelSelectors();
      if (renderAfterSave) {
        renderAll();
      } else {
        renderStatus();
      }
      return payload;
    } catch (error) {
      state.isLevelLoading = false;
      setStatus(error instanceof Error ? error.message : "Could not save that world.", "error");
      if (throwOnError) {
        throw error;
      }
      return null;
    }
  }

  async function saveLevel(options = {}) {
    if (hostedWorldDraftMode) {
      return saveHostedWorldDraft(options);
    }
    const renderAfterSave = options.renderAfterSave !== false;
    const refreshPreview = options.refreshPreview !== false;
    const updateStatus = options.updateStatus !== false;
    const throwOnError = options.throwOnError === true;
    const submittedLevelId = state.levelId;
    const submittedCells = cloneCells(state.cells);
    const submittedFileName = state.fileName;
    const submittedHeight = state.height;
    const submittedWidth = state.width;
    const submittedHotbarTokens = hotbarTokens();
    const submittedBoardSignature = boardSignature(
      submittedWidth,
      submittedHeight,
      submittedCells
    );
    const submittedHotbarSignature = hotbarSignature(submittedHotbarTokens);
    const submittedBoardWasDirty = submittedBoardSignature !== state.savedBoardSignature;

    try {
      const response = await fetch(
        authorData.authorApiBaseUrl + "/" + encodeURIComponent(submittedLevelId),
        {
          body: JSON.stringify({
            cells: submittedCells,
            fileName: submittedFileName,
            height: submittedHeight,
            hotbarTokens: submittedHotbarTokens,
            width: submittedWidth
          }),
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          method: "POST"
        }
      );
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not save that level.");
      }

      refreshEditorLevelNeighborState(payload);

      const sameLevel = state.levelId === submittedLevelId;
      const liveBoardUnchanged =
        sameLevel &&
        boardSignature(state.width, state.height, state.cells) === submittedBoardSignature;
      const liveHotbarUnchanged = hotbarSignature() === submittedHotbarSignature;
      let hasNewerChanges = state.isDirty;

      if (sameLevel) {
        const persistedBoardSignature = boardSignature(
          payload.width,
          payload.height,
          payload.cells
        );
        if (liveBoardUnchanged) {
          state.cells = cloneCells(payload.cells);
          state.height = payload.height;
          state.width = payload.width;
        }
        state.exists = true;
        state.fileName = payload.fileName;
        state.filePath = payload.filePath;
        state.savedBoardSignature = persistedBoardSignature;
        if (liveHotbarUnchanged) {
          applyPersistedHotbarTokens(payload.hotbarTokens, submittedHotbarTokens);
        } else {
          rememberPersistedHotbarTokens(payload.hotbarTokens, submittedHotbarTokens);
        }
        hasNewerChanges = syncEditorDirtyState();
      }
      if (authorData.worldMeta) {
        authorData.worldMeta.gemsByLevel[submittedLevelId] = gemCountForCells(payload.cells);
        authorData.worldMeta.savedThisSession = true;
        authorData.worldMeta.walkthroughVerified = false;
      }
      if (state.solverSolutionCellsKey !== serializeCells()) {
        clearSolverSolution();
      }
      // Persist exactly one portrait after a saved board change. Live paint
      // previews remain local, so editing never creates upload churn.
      if (refreshPreview && submittedBoardWasDirty && liveBoardUnchanged) {
        // Hosted editors can keep this portrait browser-local. The local
        // author server opts into receiving it because it does not render one
        // itself.
        scheduleCurrentLevelThumbRefresh(0, { persist: clientPreviewPersistence });
      }

      if (updateStatus) {
        state.message = hasNewerChanges
          ? "Saved earlier changes. New changes are still unsaved."
          : payload.message || "Saved.";
        state.messageTone = hasNewerChanges ? "warning" : "success";
      }
      syncLevelSelectors();
      if (renderAfterSave) {
        renderAll();
      }
      return payload;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save that level.", "error");
      if (throwOnError) {
        throw error;
      }
      return null;
    }
  }

  function raisedSurfaceSnapshotForApp(app) {
    const raisedPlayerGates =
      typeof app.computeRaisedPlayerGateSet === "function"
        ? app.computeRaisedPlayerGateSet()
        : new Set();
    const raisedOrangeWalls =
      typeof app.computeRaisedOrangeWallSet === "function"
        ? app.computeRaisedOrangeWallSet()
        : new Set();

    app.liveRaisedPlayerGates = raisedPlayerGates;
    app.liveRaisedOrangeWalls = raisedOrangeWalls;
    app.syncGateAnimationTargets?.(0);
    app.syncOrangeWallAnimationTargets?.(0);
    app.syncPlayerLiftAnimationTargets?.(0);

    return {
      raisedPlayerGates: Array.from(raisedPlayerGates),
      raisedOrangeWalls: Array.from(raisedOrangeWalls)
    };
  }

  function editorLevelSnapshotForTransition(app) {
    const snapshot =
      typeof app.cloneLevelSnapshot === "function"
        ? app.cloneLevelSnapshot()
        : buildEditorRenderPlayData();

    return {
      ...snapshot,
      ...raisedSurfaceSnapshotForApp(app)
    };
  }

  async function prepareEditorAppLevelState(app, playData) {
    app.applyLevelState(playData, {
      deferRender: true,
      immediateCamera: true,
      resetHistory: true,
      resetLevelEntry: true
    });
    await app.preloadImagesForLevelState?.(playData);
    if (app.threeRendererReady && typeof app.threeRendererReady.then === "function") {
      await app.threeRendererReady.catch(() => {});
    }

    return editorLevelSnapshotForTransition(app);
  }

  function renderLoadedLevelWithoutScene(payload, options = {}) {
    applyAuthorLevelPayload(payload, options);
    syncLevelSelectors();
    window.history.replaceState(
      null,
      "",
      authorUrlForLevel(state.levelId)
    );
    renderAll({ renderScene: false });
  }

  async function switchToNeighborLevel(target) {
    if (isEditorInteractionLocked()) {
      return false;
    }

    const resolvedTarget = resolveLevelSwitchTarget(target);

    if (!resolvedTarget) {
      return false;
    }

    // Preserve the complete world-map delta. Far-room selections are true
    // camera flights across the shared world, not a one-room slide followed
    // by an anchor teleport.
    const dx = resolvedTarget.dx;
    const dy = resolvedTarget.dy;
    const nextLevelId = resolvedTarget.levelId;
    window.clearTimeout(currentLevelThumbTimer);
    currentLevelThumbTimer = 0;
    cancelScheduledPointerMove();
    finishPainting();
    const outgoingWasDirty = state.isDirty;
    if (hostedWorldDraftMode) {
      const stagedLevel = stageCurrentHostedWorldLevel();
      if (stagedLevel) {
        renderLevelThumbFromCells(
          stagedLevel.id,
          stagedLevel.cells,
          stagedLevel.width,
          stagedLevel.height,
          { persist: false }
        ).catch(() => {});
      }
    }
    state.isLevelSwitching = true;
    clearEditorHoverTarget();
    syncUndoButtonState();
    setStatus(
      !hostedWorldDraftMode && outgoingWasDirty
        ? "Saving before switching rooms..."
        : "Switching rooms...",
      "warning"
    );

    let app = null;
    let outgoingPlayData = null;

    try {
      if (!hostedWorldDraftMode && outgoingWasDirty) {
        const savedPayload = await saveLevel({
          refreshPreview: false,
          renderAfterSave: false,
          throwOnError: true,
          updateStatus: false
        });

        // Refresh the outgoing room while state still points at it. Hosted
        // deployments can disable client preview persistence and keep this
        // portrait browser-local; the local server receives the richer
        // portrait it cannot render itself.
        refreshEditorLevelNeighborState(savedPayload);
        renderLevelThumbFromCells(
          savedPayload.levelId,
          savedPayload.cells,
          savedPayload.width,
          savedPayload.height,
          { persist: clientPreviewPersistence }
        ).catch(() => {});
      }

      outgoingPlayData = buildEditorRenderPlayData();
      app = ensureEditorRenderApp(outgoingPlayData);
      const pendingPayload = await fetchAuthorLevelPayload(nextLevelId);

      if (
        !app ||
        typeof app.applyLevelState !== "function" ||
        !app.renderCompositor?.startLevelTransition
      ) {
        renderLoadedLevelWithoutScene(pendingPayload, {
          message: "Switched to " + nextLevelId.replace("level_", "") + ".",
          messageTone: state.isDirty ? "warning" : "success"
        });
        state.isLevelSwitching = false;
        renderStatus();
        renderEditorScene();
        return true;
      }

      const outgoingLevel = await prepareEditorAppLevelState(app, outgoingPlayData);
      const incomingPlayData = neighborStateForLevel(
        pendingPayload.levelId,
        pendingPayload.cells,
        pendingPayload.width,
        pendingPayload.height,
        pendingPayload.levelId
      );
      const incomingLevel = await prepareEditorAppLevelState(app, incomingPlayData);
      const incomingRaised = raisedSurfaceSnapshotForApp(app);

      const roomDistance = Math.hypot(dx, dy);
      app.renderCompositor.startLevelTransition(null, null, dx, dy, null, null, null, {
        durationMs: Math.min(
          2600,
          (app.LEVEL_TRANSITION_DURATION_MS || 1000) + Math.max(0, roomDistance - 1) * 150
        ),
        renderImmediately: false,
        transitionData: {
          kind: "adjacent-scene",
          dx,
          dy,
          outgoingLevel,
          outgoingResetLevel: outgoingLevel,
          incomingLevel,
          incomingRaisedPlayerGates: incomingRaised.raisedPlayerGates,
          incomingRaisedOrangeWalls: incomingRaised.raisedOrangeWalls
        },
        onComplete: () => {
          try {
            renderLoadedLevelWithoutScene(pendingPayload, {
              message: "Switched to " + nextLevelId.replace("level_", "") + ".",
              messageTone: state.isDirty ? "warning" : "success"
            });
          } catch (error) {
            setStatus(
              error instanceof Error ? error.message : "Could not finish switching rooms.",
              "error"
            );
          } finally {
            state.isLevelSwitching = false;
            renderStatus();
            renderEditorScene();
          }
        }
      });
      app.render();
      return true;
    } catch (error) {
      state.isLevelSwitching = false;
      syncUndoButtonState();
      if (app && outgoingPlayData) {
        renderEditorScene();
      }
      setStatus(
        error instanceof Error ? error.message : "Could not switch to that level.",
        "error"
      );
      return false;
    }
  }

  function formatSolverPath(path) {
    return path.length > 0 ? path : "(empty)";
  }

  // Solver results live in the top dock and persist until dismissed or replaced
  // by another solver run.
  function hideSolverResultCard() {
    if (!solverDock.element) return;
    window.clearTimeout(solverDock.hideTimer);
    window.clearTimeout(solverDock.hideFinalizeTimer);
    solverDock.element.classList.remove("is-open", "is-failed");
    solverDock.element.hidden = true;
    solverDock.status = "idle";
  }

  function renderSolverResultCard(result) {
    completeSolverDock(result);
  }

  function applyGemPlacement(candidate) {
    pushUndoSnapshot();
    for (let y = 0; y < state.height; y += 1) {
      for (let x = 0; x < state.width; x += 1) {
        state.cells[y][x] = stripGemFromCellValue(state.cells[y][x]);
      }
    }

    const placedValue = gemPlacementValueForCell(candidate.x, candidate.y, candidate.elevation ?? 0);
    state.cells[candidate.y][candidate.x] = placedValue;
    clearSolverSolution();
    clearHillClimbResults();
    state.selectedCell = { x: candidate.x, y: candidate.y };
    state.isDirty = true;
    renderGrid();
    renderSelectedCell();
    renderRawOutput();
    syncSolverButtonState();

    return placedValue;
  }

  function canHillClimbPlaceWallAtCell(value) {
    const tokens = getCellTokens(value).filter((token) => token.length > 0);

    return tokens.every((token) => {
      const tool = toolByToken.get(token);
      const type = tool?.type || tool?.name || "";

      return type === "floor" || type === "ice";
    });
  }

  function hillClimbBaseCells(mode = getHillClimbMode()) {
    const cells = cloneCells(state.cells);

    return mode === "fixed_gem"
      ? cells
      : cells.map((row) => row.map(stripGemFromCellValue));
  }

  function firstGemLocation(cells = state.cells) {
    for (let y = 0; y < cells.length; y += 1) {
      for (let x = 0; x < cells[y].length; x += 1) {
        if (getCellTools(cells[y][x]).some((tool) => tool.name === "gem")) {
          return { x, y };
        }
      }
    }

    return null;
  }

  function hillClimbWallCandidateCells(baseCells, x, y, wallToken) {
    const currentValue = baseCells[y]?.[x] ?? emptyCellToken;

    if (!canHillClimbPlaceWallAtCell(currentValue)) {
      return null;
    }

    const nextValue = setCellElevationToken(currentValue, wallToken, 0);

    if (nextValue === currentValue) {
      return null;
    }

    const candidateCells = cloneCells(baseCells);
    candidateCells[y][x] = nextValue;
    return candidateCells;
  }

  function canHillClimbPlaceWallAtPosition(baseCells, x, y, wallToken) {
    const currentValue = baseCells[y]?.[x] ?? emptyCellToken;

    if (!canHillClimbPlaceWallAtCell(currentValue)) {
      return false;
    }

    return setCellElevationToken(currentValue, wallToken, 0) !== currentValue;
  }

  function hillClimbCandidatePositions(baseCells, wallToken) {
    const positions = [];

    for (let y = 0; y < state.height; y += 1) {
      for (let x = 0; x < state.width; x += 1) {
        if (canHillClimbPlaceWallAtPosition(baseCells, x, y, wallToken)) {
          positions.push({ x, y });
        }
      }
    }

    return positions;
  }

  function hillClimbProgressRenderer(candidateIndex, candidateCount) {
    const label = "Hill-Climb " + (candidateIndex + 1) + "/" + Math.max(1, candidateCount);

    return (expanded, maxExpanded) => renderSolverProgress(label, expanded, maxExpanded);
  }

  async function makeLevelHarder() {
    if (isEditorInteractionLocked()) return;

    if (!levelHasPlayer()) {
      renderSolverResultCard({
        canMakeHarder: false,
        detail: "Add a player before testing harder layouts.",
        solved: false,
        title: "Player required"
      });
      setStatus("Make Level Harder needs a player first.", "error");
      return;
    }

    const wallToken = toolByName.get("wall")?.token || "#";
    const baseCells = cloneCells(state.cells).map((row) => row.map(stripGemFromCellValue));
    const positions = hillClimbCandidatePositions(baseCells, wallToken);

    if (positions.length === 0) {
      renderSolverResultCard({
        canMakeHarder: true,
        detail: "There is no open floor or ice cell where a single block can be tested. The board was not changed.",
        solved: false,
        title: "No harder placement found"
      });
      setStatus("No valid location was available for a trial block.", "warning");
      return;
    }

    const maxExpandedStates = normalizeSolverMaxExpandedStatesInput();
    const signal = beginSolverRun("Make Level Harder");
    renderSolverProgress("Baseline", 0, maxExpandedStates);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    let cappedCount = 0;

    try {
      const baselinePlayData = buildEditorPlayData({ cells: baseCells, includeGems: false });
      const baseline = await runSolverSearch(
        "place_gem",
        {
          maxExpandedStates,
          playData: baselinePlayData,
          surfaces: serializeGemSurfaceSets(gemPlacementSurfaceSetsFromPlayData(baselinePlayData))
        },
        {
          onProgress: (expanded, maxExpanded) =>
            renderSolverProgress("Baseline", expanded, maxExpanded),
          signal
        }
      );

      if (!baseline.candidate || baseline.status === "capped") {
        renderSolverResultCard({
          canMakeHarder: true,
          detail:
            baseline.status === "capped"
              ? "The baseline hit the search-state limit, so a strictly harder result could not be verified. The board was not changed."
              : "No reachable baseline gem placement was found. The board was not changed.",
          solved: false,
          title: "Could not verify a harder level"
        });
        setStatus("Could not establish a verified baseline for Make Level Harder.", "warning");
        return;
      }

      let best = null;
      let lastUiYieldAt = performanceNow();

      for (let index = 0; index < positions.length; index += 1) {
        if (performanceNow() - lastUiYieldAt > 24) {
          await nextSolverProgressFrame();
          lastUiYieldAt = performanceNow();
        }

        const position = positions[index];
        const candidateCells = hillClimbWallCandidateCells(
          baseCells,
          position.x,
          position.y,
          wallToken
        );
        if (!candidateCells || !levelHasPlayer(candidateCells)) continue;

        const candidatePlayData = buildEditorPlayData({
          cells: candidateCells,
          includeGems: false
        });
        const result = await runSolverSearch(
          "place_gem",
          {
            maxExpandedStates,
            playData: candidatePlayData,
            surfaces: serializeGemSurfaceSets(
              gemPlacementSurfaceSetsFromPlayData(candidatePlayData)
            )
          },
          {
            onProgress: (expanded, maxExpanded) =>
              renderSolverProgress(
                "Block " + (index + 1) + "/" + positions.length,
                expanded,
                maxExpanded
              ),
            signal
          }
        );

        if (result.status === "capped") {
          cappedCount += 1;
          continue;
        }
        if (!result.candidate || result.candidate.moves <= baseline.candidate.moves) continue;

        if (!best || result.candidate.moves > best.moves) {
          const cellsWithGem = cloneCells(candidateCells);
          cellsWithGem[result.candidate.y][result.candidate.x] = gemPlacementValueForCells(
            cellsWithGem,
            result.candidate.x,
            result.candidate.y,
            result.candidate.elevation ?? 0
          );
          best = {
            cells: cellsWithGem,
            moves: result.candidate.moves,
            path: result.candidate.path,
            selectedCell: { x: result.candidate.x, y: result.candidate.y },
            solutionPath: result.candidate.path,
            wallX: position.x,
            wallY: position.y
          };
        }
      }

      if (!best) {
        renderSolverResultCard({
          canMakeHarder: true,
          detail:
            "A* tested " +
            positions.length +
            " single-block placement" +
            (positions.length === 1 ? "" : "s") +
            " against the " +
            baseline.candidate.moves +
            "-move baseline, but none was strictly harder. The board was not changed." +
            (cappedCount > 0
              ? " " + cappedCount + " test" + (cappedCount === 1 ? "" : "s") + " hit the state limit."
              : ""),
          solved: false,
          title: "No harder placement found"
        });
        setStatus("No strictly harder single-block layout was found; nothing changed.", "warning");
        return;
      }

      applyHillClimbResult(best);
      renderSolverResultCard({
        canMakeHarder: true,
        canPlayback: true,
        detail:
          "Added one block and moved the gem from a " +
          baseline.candidate.moves +
          "-move challenge to " +
          best.moves +
          " moves with A*.",
        path: formatSolverPath(best.path),
        solved: true,
        title: "Level made harder"
      });
      setStatus("Added one block and moved the gem to a verified harder location.", "success");
    } catch (error) {
      const cancelled = isSolverCancelError(error);
      renderSolverResultCard({
        canMakeHarder: true,
        detail: cancelled
          ? "The board was not changed."
          : error instanceof Error
            ? error.message
            : "The harder-layout search failed. The board was not changed.",
        solved: false,
        title: cancelled ? "Search cancelled" : "Search failed"
      });
      setStatus(
        cancelled ? "Make Level Harder cancelled." : "Make Level Harder failed.",
        cancelled ? "warning" : "error"
      );
    } finally {
      finishSolverRun();
    }
  }

  function addAffectedCellKey(keys, x, y) {
    const cellX = Math.floor(Number(x));
    const cellY = Math.floor(Number(y));

    if (isInsideEditorCell(cellX, cellY)) {
      keys.add(cellX + "," + cellY);
    }
  }

  function addAffectedPathPoint(keys, point) {
    if (!point) {
      return;
    }

    const x = Number(point.x);
    const y = Number(point.y);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }

    addAffectedCellKey(keys, Math.floor(x), Math.floor(y));
    addAffectedCellKey(keys, Math.ceil(x), Math.floor(y));
    addAffectedCellKey(keys, Math.floor(x), Math.ceil(y));
    addAffectedCellKey(keys, Math.ceil(x), Math.ceil(y));
  }

  function addMoveAffectedCells(keys, move) {
    addAffectedCellKey(keys, move?.fromX, move?.fromY);
    addAffectedCellKey(keys, move?.toX, move?.toY);

    if (Array.isArray(move?.path)) {
      move.path.forEach((point) => addAffectedPathPoint(keys, point));
    }
  }

  function solverPathAffectedCellKeys(cells, path) {
    const engine = createSolverEngine(buildEditorPlayData({ cells }));
    const replayState = engine.createStateBuffer();
    const keys = new Set();

    engine.copyStateInto(replayState, engine.initialState);

    for (const label of String(path || "")) {
      const direction = solutionDirections[label];

      if (!direction) {
        break;
      }

      const moveResult = engine.moveForSearch(replayState, direction.dx, direction.dy);

      if (!moveResult?.moved) {
        break;
      }

      if (Array.isArray(moveResult.moves)) {
        moveResult.moves.forEach((move) => addMoveAffectedCells(keys, move));
      }
    }

    return keys;
  }

  function rankHillClimbResults(results) {
    return results.slice().sort((left, right) => {
      if (right.moves !== left.moves) {
        return right.moves - left.moves;
      }

      if (left.wallY !== right.wallY) {
        return left.wallY - right.wallY;
      }

      return left.wallX - right.wallX;
    });
  }

  function setHillClimbResults(results) {
    state.hillClimbResults = rankHillClimbResults(results);
    state.hillClimbResultIndex = state.hillClimbResults.length > 0 ? 0 : -1;
    syncHillClimbResultControls();
  }

  function applyHillClimbResult(best, options = {}) {
    if (options.recordUndo !== false) {
      pushUndoSnapshot();
    }
    state.cells = cloneCells(best.cells);
    if (typeof best.solutionPath === "string") {
      rememberSolverSolution(best.solutionPath);
    } else {
      clearSolverSolution();
    }
    state.selectedCell = best.selectedCell
      ? { x: best.selectedCell.x, y: best.selectedCell.y }
      : { x: best.wallX, y: best.wallY };
    state.isDirty = true;
    renderGrid();
    renderSelectedCell();
    renderRawOutput();
    syncSolverButtonState();
  }

  function showHillClimbResult(index) {
    if (!Array.isArray(state.hillClimbResults) || state.hillClimbResults.length === 0) {
      return false;
    }

    const nextIndex = Math.max(0, Math.min(state.hillClimbResults.length - 1, index));

    if (nextIndex === state.hillClimbResultIndex) {
      syncHillClimbResultControls();
      return false;
    }

    state.hillClimbResultIndex = nextIndex;
    const result = currentHillClimbResult();

    if (!result) {
      syncHillClimbResultControls();
      return false;
    }

    applyHillClimbResult(result, { recordUndo: false });
    setStatus(
      hillClimbResultSummary(result) +
        ". UDLR: " +
        formatSolverPath(result.path) +
        ".",
      "success"
    );
    return true;
  }

  function pageHillClimbResult(delta) {
    if (isEditorInteractionLocked()) {
      return false;
    }

    return showHillClimbResult(state.hillClimbResultIndex + delta);
  }

  async function hillClimb() {
    if (isEditorInteractionLocked()) {
      return;
    }

    if (!levelHasPlayer()) {
      setStatus("Hill-Climb needs a player first.", "error");
      syncSolverButtonState();
      return;
    }

    const mode = getHillClimbMode();

    if (mode === "fixed_gem" && !levelHasGem()) {
      setStatus("Fixed Gem Hill-Climb needs a gem first.", "error");
      syncSolverButtonState();
      return;
    }

    const wallToken = toolByName.get("wall")?.token || "#";
    const baseCells = hillClimbBaseCells(mode);
    const positions = hillClimbCandidatePositions(baseCells, wallToken);

    if (positions.length === 0) {
      setStatus("Hill-Climb found no empty floor or ice cells for a trial wall.", "warning");
      syncSolverButtonState();
      return;
    }

    const algorithm = getSolverAlgorithm();
    const algorithmLabel = solverAlgorithmLabel(algorithm);

    setStatus(
      "Hill-Climb " +
        hillClimbModeLabel(mode) +
        (mode === "fixed_gem" ? " with " + algorithmLabel : "") +
        " trying wall placements...",
      "warning"
    );
    const maxExpandedStates = normalizeSolverMaxExpandedStatesInput();
    const signal = beginSolverRun("Hill-Climb");
    renderSolverProgress("Hill-Climb", 0, maxExpandedStates);

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    let best = null;
    let cappedCount = 0;
    const hillClimbResults = [];
    let fixedGemBaseline = null;
    let fixedGemAffectedCells = null;

    try {
      if (mode === "fixed_gem") {
        fixedGemBaseline = await runSolverSearch(
          "solve",
          { algorithm, maxExpandedStates, playData: buildEditorPlayData({ cells: baseCells }) },
          {
            onProgress: hillClimbProgressRenderer(0, positions.length),
            signal
          }
        );

        if (fixedGemBaseline.status === "solved") {
          fixedGemAffectedCells = solverPathAffectedCellKeys(baseCells, fixedGemBaseline.path);
        } else if (fixedGemBaseline.status === "capped") {
          cappedCount += 1;
        }
      }

      let lastUiYieldAt = performanceNow();

      for (let index = 0; index < positions.length; index += 1) {
        // Worker searches keep the heavy lifting off this thread, but the
        // per-candidate prep here still queues back-to-back tasks that can
        // starve rendering — hand the browser a paint frame periodically.
        if (performanceNow() - lastUiYieldAt > 24) {
          await nextSolverProgressFrame();
          lastUiYieldAt = performanceNow();
        }

        const position = positions[index];
        const candidateCells = hillClimbWallCandidateCells(
          baseCells,
          position.x,
          position.y,
          wallToken
        );

        if (!candidateCells || !levelHasPlayer(candidateCells)) {
          continue;
        }

        if (mode === "fixed_gem") {
          const positionKey = position.x + "," + position.y;

          if (fixedGemBaseline?.status === "solved" && !fixedGemAffectedCells?.has(positionKey)) {
            const candidateResult = {
              cells: candidateCells,
              moves: fixedGemBaseline.moves,
              path: fixedGemBaseline.path,
              resultStatus: fixedGemBaseline.status,
              selectedCell: firstGemLocation(candidateCells) || { x: position.x, y: position.y },
              solutionPath: fixedGemBaseline.path,
              wallX: position.x,
              wallY: position.y
            };

            hillClimbResults.push(candidateResult);
            if (!best || candidateResult.moves > best.moves) {
              best = candidateResult;
            }
            continue;
          }

          const result = await runSolverSearch(
            "solve",
            { algorithm, maxExpandedStates, playData: buildEditorPlayData({ cells: candidateCells }) },
            {
              onProgress: hillClimbProgressRenderer(index, positions.length),
              signal
            }
          );

          if (result.status === "capped") {
            cappedCount += 1;
            continue;
          }

          if (result.status === "solved") {
            const candidateResult = {
              cells: candidateCells,
              moves: result.moves,
              path: result.path,
              resultStatus: result.status,
              selectedCell: firstGemLocation(candidateCells) || { x: position.x, y: position.y },
              solutionPath: result.path,
              wallX: position.x,
              wallY: position.y
            };

            hillClimbResults.push(candidateResult);
            if (!best || candidateResult.moves > best.moves) {
              best = candidateResult;
            }
          }
        } else {
          const candidatePlayData = buildEditorPlayData({ cells: candidateCells, includeGems: false });
          const result = await runSolverSearch(
            "place_gem",
            {
              maxExpandedStates,
              playData: candidatePlayData,
              surfaces: serializeGemSurfaceSets(gemPlacementSurfaceSetsFromPlayData(candidatePlayData))
            },
            {
              onProgress: hillClimbProgressRenderer(index, positions.length),
              signal
            }
          );

          if (result.status === "capped") {
            cappedCount += 1;
            continue;
          }

          if (result.candidate) {
            const cellsWithGem = cloneCells(candidateCells);
            cellsWithGem[result.candidate.y][result.candidate.x] = gemPlacementValueForCells(
              cellsWithGem,
              result.candidate.x,
              result.candidate.y,
              result.candidate.elevation ?? 0
            );
            const candidateResult = {
              cells: cellsWithGem,
              moves: result.candidate.moves,
              path: result.candidate.path,
              resultStatus: result.status,
              selectedCell: { x: result.candidate.x, y: result.candidate.y },
              solutionPath: result.candidate.path,
              wallX: position.x,
              wallY: position.y
            };

            hillClimbResults.push(candidateResult);
            if (!best || candidateResult.moves > best.moves) {
              best = candidateResult;
            }
          }
        }
      }

      if (hillClimbResults.length === 0 || !best) {
        setStatus(
          "Hill-Climb: no trial wall left a reachable gem placement after " +
            positions.length +
            " candidate" +
            (positions.length === 1 ? "" : "s") +
            ".",
          "warning"
        );
        return;
      }

      setHillClimbResults(hillClimbResults);
      best = currentHillClimbResult() || best;
      applyHillClimbResult(best);
      setStatus(
        "Hill-Climb " +
          hillClimbModeLabel(mode) +
          ": kept result 1/" +
          state.hillClimbResults.length +
          " wall at cell " +
          (best.wallX + 1) +
          ", " +
          (best.wallY + 1) +
          " for " +
          best.moves +
          " move" +
          (best.moves === 1 ? "" : "s") +
          ". UDLR: " +
          formatSolverPath(best.path) +
          "." +
          (cappedCount > 0
            ? " " + cappedCount + " trial" + (cappedCount === 1 ? "" : "s") + " hit the cap."
            : ""),
        best.resultStatus === "capped" ? "warning" : "success"
      );
    } catch (error) {
      setStatus(
        isSolverCancelError(error)
          ? "Hill-Climb cancelled."
          : error instanceof Error
            ? error.message
            : "Hill-Climb failed.",
        isSolverCancelError(error) ? "warning" : "error"
      );
    } finally {
      finishSolverRun();
    }
  }

  function rememberCappedSolverSearch(result, details) {
    if (result?.status !== "capped" || !result.searchContinuation) {
      clearSolverContinuation();
      return false;
    }

    state.solverContinuation = {
      additionalStates: Math.max(1, Math.floor(Number(details.additionalStates) || 1)),
      boardSignature: boardSignature(state.width, state.height, state.cells),
      expanded: Math.max(0, Number(result.expanded) || 0),
      label: details.label,
      levelId: state.levelId,
      op: details.op,
      payload: details.payload,
      search: result.searchContinuation
    };
    return true;
  }

  function presentPlaceGemSearchResult(result, details) {
    if (result.status === "capped") {
      const canContinue = rememberCappedSolverSearch(result, {
        ...details,
        label: "Place Gem",
        op: "place_gem"
      });
      const candidate = result.candidate;
      const candidateText = candidate
        ? " Best so far is cell " + (candidate.x + 1) + ", " + (candidate.y + 1) +
          " at " + candidate.moves + " move" + (candidate.moves === 1 ? "" : "s") + "."
        : " No reachable placement has been found yet.";

      renderSolverResultCard({
        additionalStates: details.additionalStates,
        canContinue,
        canMakeHarder: false,
        detail:
          "Paused after " + formatStateCount(result.expanded) + " states with the search frontier saved." +
          candidateText,
        path: candidate ? formatSolverPath(candidate.path) : "",
        solved: false,
        title: "Search capped"
      });
      setStatus(
        canContinue
          ? "Place Gem paused at the state limit. Choose how many more states to search."
          : "Place Gem reached the state limit.",
        "warning"
      );
      return;
    }

    clearSolverContinuation();
    if (result.candidate) {
      const placedValue = applyGemPlacement(result.candidate);
      rememberSolverSolution(result.candidate.path);
      setStatus(
        "Place Gem: placed hardest spot at cell " +
          (result.candidate.x + 1) +
          ", " +
          (result.candidate.y + 1) +
          " as " +
          placedValue +
          " in " +
          result.candidate.moves +
          " move" +
          (result.candidate.moves === 1 ? "" : "s") +
          ". UDLR: " +
          formatSolverPath(result.candidate.path) +
          ".",
        "success"
      );
      renderSolverResultCard({
        canMakeHarder: true,
        canPlayback: true,
        detail:
          "Placed at cell " +
          (result.candidate.x + 1) +
          ", " +
          (result.candidate.y + 1) +
          " after exploring " +
          formatStateCount(result.expanded) +
          " states with A*.",
        path: formatSolverPath(result.candidate.path),
        solved: true,
        title:
          "Gem placed · " +
          result.candidate.moves +
          " move" +
          (result.candidate.moves === 1 ? "" : "s")
      });
      return;
    }

    renderSolverResultCard({
      canMakeHarder: false,
      detail:
        "Explored " +
        formatStateCount(result.expanded) +
        " state" +
        (result.expanded === 1 ? "" : "s") +
        " with A*, but found no reachable open surface.",
      solved: false,
      title: "No gem placement found"
    });
    setStatus(
      "Place Gem: no reachable open surface found. Explored " +
        formatStateCount(result.expanded) +
        " state" +
        (result.expanded === 1 ? "" : "s") +
        ".",
      "warning"
    );
  }

  function presentSolveSearchResult(result, details) {
    if (result.status === "solved") {
      clearSolverContinuation();
      rememberSolverSolution(result.path);
      renderSolverResultCard({
        canMakeHarder: true,
        canPlayback: true,
        detail:
          "Explored " +
          formatStateCount(result.expanded) +
          " states with " +
          details.algorithmLabel +
          " in " +
          details.elapsed +
          ".",
        path: formatSolverPath(result.path),
        solved: true,
        title: "Solved in " + result.moves + " move" + (result.moves === 1 ? "" : "s")
      });
      setStatus(
        "Solver: possible in " + result.moves + " move" + (result.moves === 1 ? "" : "s") + ".",
        "success"
      );
      return;
    }

    if (result.status === "unsolved") {
      clearSolverContinuation();
      clearSolverSolution();
      renderSolverResultCard({
        canMakeHarder: false,
        detail:
          "Explored " + formatStateCount(result.expanded) +
          " state" + (result.expanded === 1 ? "" : "s") +
          " in " + details.elapsed + " — no path reaches a gem.",
        path: "",
        solved: false,
        title: "Not solvable"
      });
      setStatus("Solver: not possible.", "warning");
      return;
    }

    clearSolverSolution();
    const canContinue = rememberCappedSolverSearch(result, {
      ...details,
      label: details.algorithmLabel,
      op: "solve"
    });
    renderSolverResultCard({
      additionalStates: details.additionalStates,
      canContinue,
      canMakeHarder: false,
      detail:
        "Paused after " + formatStateCount(result.expanded) +
        " states with the search frontier saved. Choose an additional state budget to keep going.",
      path: "",
      solved: false,
      title: "Search capped"
    });
    setStatus(
      canContinue
        ? "Solver paused at the state limit. Choose how many more states to search."
        : "Solver reached the state limit.",
      "warning"
    );
  }

  function solverContinuationMatchesBoard(pending) {
    return Boolean(
      pending &&
      pending.levelId === state.levelId &&
      pending.boardSignature === boardSignature(state.width, state.height, state.cells)
    );
  }

  function getAdditionalSolverStates() {
    const value = Number(solverDock.continueInput?.value);
    const fallback = Math.max(1, Number(state.solverContinuation?.additionalStates) || 1);
    const additional = Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;

    if (solverDock.continueInput) solverDock.continueInput.value = String(additional);
    return additional;
  }

  async function continueSolverSearch() {
    if (isEditorInteractionLocked()) return;
    const pending = state.solverContinuation;

    if (!solverContinuationMatchesBoard(pending)) {
      clearSolverContinuation();
      renderSolverResultCard({
        canMakeHarder: false,
        detail: "The room changed after this search paused. Run a new search for the current room.",
        solved: false,
        title: "Saved search expired"
      });
      setStatus("The saved solver search no longer matches this room.", "warning");
      return;
    }

    const additionalExpandedStates = getAdditionalSolverStates();
    const targetExpanded = pending.expanded + additionalExpandedStates;
    state.solverContinuation = null;
    const signal = beginSolverRun(pending.label + " · continuing", { preserveContinuation: true });
    renderSolverProgress(pending.label, pending.expanded, targetExpanded);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    try {
      const result = await runSolverSearch(pending.op, pending.payload, {
        additionalExpandedStates,
        continuation: pending.search,
        onProgress: (expanded, maxExpanded) =>
          renderSolverProgress(pending.label, expanded, maxExpanded),
        signal
      });
      const details = {
        additionalStates: additionalExpandedStates,
        algorithmLabel: pending.label,
        elapsed: formatSolverElapsed(performanceNow() - solverDock.startedAt),
        payload: pending.payload
      };

      if (pending.op === "place_gem") {
        presentPlaceGemSearchResult(result, details);
      } else {
        presentSolveSearchResult(result, details);
      }
    } catch (error) {
      const cancelled = isSolverCancelError(error);
      clearSolverContinuation();
      renderSolverResultCard({
        canMakeHarder: false,
        detail: cancelled
          ? "The saved search was discarded."
          : error instanceof Error
            ? error.message
            : "The saved search could not continue.",
        solved: false,
        title: cancelled ? "Search cancelled" : "Search failed"
      });
      setStatus(cancelled ? "Solver cancelled." : "The saved search could not continue.", cancelled ? "warning" : "error");
    } finally {
      finishSolverRun();
    }
  }

  async function placeGem() {
    if (isEditorInteractionLocked()) {
      return;
    }

    if (!levelHasPlayer()) {
      setStatus("Place Gem needs a player first.", "error");
      syncSolverButtonState();
      return;
    }

    setStatus("Place Gem running reachability search...", "warning");
    const maxExpandedStates = normalizeSolverMaxExpandedStatesInput();
    const signal = beginSolverRun("Place Gem");
    renderSolverProgress("Place Gem", 0, maxExpandedStates);

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const payload = {
      maxExpandedStates,
      playData: buildEditorPlayData({ includeGems: false }),
      surfaces: serializeGemSurfaceSets(gemPlacementSurfaceSets())
    };

    try {
      const result = await runSolverSearch(
        "place_gem",
        payload,
        {
          onProgress: (expanded, maxExpanded) =>
            renderSolverProgress("Place Gem", expanded, maxExpanded),
          signal
        }
      );
      presentPlaceGemSearchResult(result, { additionalStates: maxExpandedStates, payload });
    } catch (error) {
      const cancelled = isSolverCancelError(error);
      renderSolverResultCard({
        canMakeHarder: false,
        detail: cancelled
          ? "No changes were made."
          : error instanceof Error
            ? error.message
            : "The gem-placement search failed.",
        solved: false,
        title: cancelled ? "Search cancelled" : "Search failed"
      });
      setStatus(
        cancelled
          ? "Place Gem cancelled."
          : error instanceof Error
            ? error.message
            : "Place Gem failed.",
        cancelled ? "warning" : "error"
      );
    } finally {
      finishSolverRun();
    }
  }

  async function solveLevel() {
    if (isEditorInteractionLocked()) {
      return;
    }

    if (!levelHasGem()) {
      setStatus("Solver needs a gem first.", "error");
      syncSolverButtonState();
      return;
    }

    const playData = buildEditorPlayData();

    if (!playData.actors.some((actor) => isSolverPlayerActor(actor))) {
      setStatus("Solver needs a player first.", "error");
      syncSolverButtonState();
      return;
    }

    const algorithm = getSolverAlgorithm();
    const algorithmLabel = solverAlgorithmLabel(algorithm);

    hideSolverResultCard();
    setStatus("Solver running " + algorithmLabel + "...", "warning");
    const maxExpandedStates = normalizeSolverMaxExpandedStatesInput();
    const signal = beginSolverRun(algorithmLabel);
    renderSolverProgress(algorithmLabel, 0, maxExpandedStates);

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const payload = { algorithm, maxExpandedStates, playData };

    try {
      const result = await runSolverSearch(
        "solve",
        payload,
        {
          onProgress: (expanded, maxExpanded) =>
            renderSolverProgress(algorithmLabel, expanded, maxExpanded),
          signal
        }
      );
      const elapsed = formatSolverElapsed(performanceNow() - solverDock.startedAt);
      presentSolveSearchResult(result, {
        additionalStates: maxExpandedStates,
        algorithmLabel,
        elapsed,
        payload
      });
    } catch (error) {
      const cancelled = isSolverCancelError(error);
      if (!cancelled) {
        clearSolverSolution();
      }
      renderSolverResultCard({
        canMakeHarder: false,
        detail: cancelled
          ? "The board was not changed."
          : error instanceof Error
            ? error.message
            : "The reachability search failed.",
        solved: false,
        title: cancelled ? "Search cancelled" : "Search failed"
      });
      setStatus(
        cancelled
          ? "Solver cancelled."
          : error instanceof Error
            ? error.message
            : "Solver failed.",
        cancelled ? "warning" : "error"
      );
    } finally {
      finishSolverRun();
    }
  }

  function runSelectedSolverMode() {
    const mode = getSolverMode();
    if (mode === "place_gem") return placeGem();
    if (mode === "reach_gem") return solveLevel();
    return undefined;
  }

  function parseSolutionMoves(path) {
    const moves = [];

    for (const label of String(path ?? "")) {
      const direction = solutionDirections[label];

      if (!direction) {
        throw new Error("Solution contains an unsupported move: " + label + ".");
      }

      moves.push(direction);
    }

    return moves;
  }

  function performSolutionMove(app, direction) {
    let finishMove;
    const completion = new Promise((resolve) => {
      finishMove = resolve;
    });
    const result = app.movement.performPlayerMove(direction.dx, direction.dy, {
      animate: true,
      onFinish: finishMove,
      recordHistory: false
    });

    return result.moved ? completion.then(() => result) : Promise.resolve(result);
  }

  function stopSolutionPlayback() {
    const controller = state.solutionPlaybackAbortController;

    if (!state.isSolutionPlaying || !controller || controller.signal.aborted) {
      return;
    }

    controller.abort();
    setStatus("Stopping solution playback...", "warning");
    syncSolverButtonState();
  }

  function buildSolutionExportPlayData() {
    return buildEditorPlayData({
      cameraView: {
        height: state.height,
        width: state.width
      },
      editorRender: false,
      levelId: state.levelId,
      levelLabel: state.levelId,
      worldColumns,
      worldRows
    });
  }

  function solutionExportFileName(response, format) {
    const disposition = response.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="?([^";]+)"?/i);
    if (match?.[1]) return match[1];
    return `${authorData.game.id}-${state.levelId}-solution.${format}`;
  }

  async function solutionExportError(response) {
    const body = await response.text();
    try {
      const payload = JSON.parse(body);
      return payload?.error || body;
    } catch (_error) {
      return body;
    }
  }

  function solutionExportPhaseLabel(phase, format) {
    const normalized = String(phase || "starting").toLowerCase();
    if (normalized === "starting") return "Preparing renderer";
    if (normalized === "capturing") return "Capturing play-mode frames";
    if (normalized === "encoding") return `Encoding ${format.toUpperCase()}`;
    if (normalized === "done") return "Ready to download";
    if (normalized === "failed") return "Render failed";
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  function showSolutionExportProgress(format, progress = {}) {
    const dock = ensureSolverDock();
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    const detail = [];
    if (
      progress.current != null &&
      progress.total != null &&
      Number.isFinite(Number(progress.current)) &&
      Number.isFinite(Number(progress.total))
    ) {
      detail.push(
        `${Number(progress.current).toLocaleString()}/${Number(progress.total).toLocaleString()} ${progress.unit || "frames"}`
      );
    }
    if (
      progress.eta_ms != null &&
      Number.isFinite(Number(progress.eta_ms)) &&
      Number(progress.eta_ms) >= 0
    ) {
      detail.push(`about ${formatSolverElapsed(Number(progress.eta_ms))} left`);
    }
    detail.push(`${Math.round(percent)}%`);

    dock.exportProgress.hidden = false;
    dock.exportProgress.querySelector("strong").textContent = `Rendering ${format.toUpperCase()}`;
    dock.exportLabel.textContent = `${solutionExportPhaseLabel(progress.phase, format)} · ${detail.join(" · ")}`;
    dock.exportBar.style.width = `${percent}%`;
    dock.exportTrack.setAttribute("aria-valuenow", String(Math.round(percent)));
    dock.exportTrack.setAttribute("aria-valuetext", dock.exportLabel.textContent);
  }

  function waitForSolutionExportPoll() {
    return new Promise((resolve) => window.setTimeout(resolve, 400));
  }

  async function waitForSolutionExport(job, format) {
    let current = job;
    while (current?.status === "rendering") {
      showSolutionExportProgress(format, current.progress);
      await waitForSolutionExportPoll();
      const response = await fetch(job.statusUrl, {
        headers: { Accept: "application/json" },
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error((await solutionExportError(response)) || "Could not read export progress.");
      }
      current = await response.json();
    }

    showSolutionExportProgress(format, current?.progress || {});
    if (current?.status !== "ready") {
      throw new Error(current?.error || `Could not render solution ${format.toUpperCase()}.`);
    }
    return current;
  }

  async function downloadSolutionExport(requestedFormat) {
    const format = String(requestedFormat || "").toLowerCase();
    if (!["gif", "mp4"].includes(format) || state.solverExportFormat) return;

    if (!hasPlayableSolution() || !authorData.solutionExportApiUrl) {
      setStatus("Run Solver successfully before exporting a solution.", "error");
      return;
    }

    state.solverExportFormat = format;
    setStatus(`Rendering play-mode ${format.toUpperCase()}...`, "warning");
    showSolutionExportProgress(format, { phase: "starting", percent: 0 });
    syncSolverDockControls();
    let statusUrl = "";

    try {
      const response = await fetch(
        authorData.solutionExportApiUrl +
          "/" +
          encodeURIComponent(state.levelId) +
          "/solution-export?format=" +
          encodeURIComponent(format),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: state.solverSolutionPath,
            playData: buildSolutionExportPlayData()
          })
        }
      );

      if (!response.ok) {
        throw new Error((await solutionExportError(response)) || "Could not render solution.");
      }

      const job = await response.json();
      if (!job?.statusUrl || !job?.downloadUrl) {
        throw new Error("Solution renderer did not return an export job.");
      }
      statusUrl = job.statusUrl;
      await waitForSolutionExport(job, format);
      showSolutionExportProgress(format, { phase: "done", percent: 100 });

      const downloadResponse = await fetch(job.downloadUrl, { cache: "no-store" });
      if (!downloadResponse.ok) {
        throw new Error(
          (await solutionExportError(downloadResponse)) || "Could not download rendered solution."
        );
      }
      const blob = await downloadResponse.blob();
      const objectUrl = URL.createObjectURL(blob);
      const download = document.createElement("a");
      download.href = objectUrl;
      download.download = solutionExportFileName(downloadResponse, format);
      download.hidden = true;
      document.body.append(download);
      download.click();
      download.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setStatus(`Downloaded play-mode solution ${format.toUpperCase()}.`, "success");
    } catch (error) {
      if (statusUrl) {
        fetch(statusUrl, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        }).catch(() => {});
      }
      setStatus(
        error instanceof Error ? error.message : `Could not render solution ${format.toUpperCase()}.`,
        "error"
      );
    } finally {
      state.solverExportFormat = null;
      syncSolverDockControls();
      window.setTimeout(() => {
        if (!state.solverExportFormat && solverDock.exportProgress) {
          solverDock.exportProgress.hidden = true;
        }
      }, 700);
    }
  }

  async function playSolution() {
    if (isEditorInteractionLocked()) {
      return;
    }

    if (!hasPlayableSolution()) {
      setStatus("Run Solver successfully before playing a solution.", "error");
      syncSolverButtonState();
      return;
    }

    const solutionPath = state.solverSolutionPath;
    let moves;

    try {
      moves = parseSolutionMoves(solutionPath);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not read the solution.", "error");
      syncSolverButtonState();
      return;
    }

    const playData = buildEditorRenderPlayData();
    const app = ensureEditorRenderApp(playData);

    if (!app || !app.movement || typeof app.movement.performPlayerMove !== "function") {
      setStatus("Solution playback is not available.", "error");
      syncSolverButtonState();
      return;
    }

    const playbackController = new AbortController();
    let completedMoves = 0;
    setSolverDockMinimized(true);
    state.solutionPlaybackAbortController = playbackController;
    state.isSolutionPlaying = true;
    setStatus("Playing solver solution...", "warning");
    syncSolverButtonState();

    try {
      app.applyLevelState(playData, {
        deferRender: true,
        immediateCamera: true,
        resetHistory: true,
        resetLevelEntry: true
      });
      await app.preloadImagesForLevelState(playData);
      app.render();

      for (let index = 0; index < moves.length; index += 1) {
        if (playbackController.signal.aborted) {
          break;
        }

        const result = await performSolutionMove(app, moves[index]);

        if (!result.moved) {
          throw new Error(
            "Solution stopped at move " +
              (index + 1) +
              " (" +
              moves[index].label +
              ")."
          );
        }

        completedMoves += 1;

        if (playbackController.signal.aborted) {
          break;
        }
      }

      if (playbackController.signal.aborted) {
        setStatus(
          "Stopped solution after " +
            completedMoves +
            " move" +
            (completedMoves === 1 ? "" : "s") +
            ".",
          "warning"
        );
      } else {
        setStatus(
          "Played solution: " +
            moves.length +
            " move" +
            (moves.length === 1 ? "" : "s") +
            ". UDLR: " +
            formatSolverPath(solutionPath) +
            ".",
          "success"
        );
      }
    } catch (error) {
      setStatus(
        playbackController.signal.aborted
          ? "Stopped solution after " +
              completedMoves +
              " move" +
              (completedMoves === 1 ? "" : "s") +
              "."
          : error instanceof Error
            ? error.message
            : "Could not play the solution.",
        playbackController.signal.aborted ? "warning" : "error"
      );
    } finally {
      if (state.solutionPlaybackAbortController === playbackController) {
        state.solutionPlaybackAbortController = null;
      }
      state.isSolutionPlaying = false;
      renderEditorScene();
      syncSolverButtonState();
    }
  }

  function isTypingTarget(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const tagName = element.tagName.toLowerCase();

    return (
      tagName === "input" ||
      tagName === "textarea" ||
      tagName === "select" ||
      element.isContentEditable ||
      Boolean(element.closest("[contenteditable='true']"))
    );
  }

  function handleEditorKeydown(event) {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      isTypingTarget(event.target)
    ) {
      return;
    }

    const key = String(event.key || "").toLowerCase();

    if (key === "escape") {
      if (isInventoryOpen()) {
        event.preventDefault();
        setInventoryOpen(false);
      }
      return;
    }

    // B toggles the toolbox; nearby camera keys stay with the renderer.
    if (key === "b") {
      event.preventDefault();
      setInventoryOpen(!isInventoryOpen());
      return;
    }

    if (key === "w" || key === "s") {
      event.preventDefault();
      editorCam.heldTiltKeys.add(key);
      editorCamRecomputeTiltDirection();
      return;
    }

    if (key === "a" || key === "d") {
      if (!event.repeat) {
        event.preventDefault();
        editorCamRotate(key === "a" ? -1 : 1);
      }
      return;
    }

    if (/^[0-9]$/.test(key)) {
      const slotIndex = key === "0" ? 9 : Number(key) - 1;
      const token = hotbarTokens()[slotIndex];
      if (token) {
        event.preventDefault();
        selectToken(token);
      }
      return;
    }

    if (key !== "u" && key !== "z") {
      return;
    }

    event.preventDefault();
    undoLastEdit();
  }

  function handleGridPointerDown(event) {
    if (
      isEditorInteractionLocked() ||
      event.button !== 0 ||
      event.isPrimary === false ||
      event.ctrlKey ||
      eventTargetsAuthorOverlay(event)
    ) {
      return;
    }

    const target = syncEditorHoverFromPointerEvent(event);

    if (!target) {
      return;
    }

    event.preventDefault();

    if (target.kind === "levelSwitch") {
      switchToNeighborLevel(target);
      return;
    }

    if (state.selectedToken === noopToken) {
      paintFaceTarget(target);
      return;
    }

    state.paintPointerId = event.pointerId;
    state.paintStrokeDidPaint = false;
    state.paintStrokeLevelId = state.levelId;
    state.paintStrokePaintedVoxelKeys.clear();
    state.paintStrokeToken = state.selectedToken;
    state.lastPaintTargetKey = null;
    state.eraseGestureMode = null;
    state.paintDragPlane = paintDragPlaneForTarget(target);
    try {
      elements.grid.setPointerCapture?.(event.pointerId);
    } catch (_) {}
    paintFaceTargetOnce(target);
  }

  function pointerSamplesForMoveEvent(event) {
    if (typeof event?.getCoalescedEvents !== "function") {
      return [event];
    }

    try {
      const coalesced = Array.from(event.getCoalescedEvents() || []);
      return coalesced.length > 0 ? coalesced : [event];
    } catch {
      return [event];
    }
  }

  function compactPointerMoveSamples(samples, limit) {
    if (samples.length <= limit) {
      return samples;
    }

    const compacted = [];
    for (let index = 0; index < limit; index += 1) {
      const sourceIndex = Math.round((index * (samples.length - 1)) / (limit - 1));
      const sample = samples[sourceIndex];

      if (compacted[compacted.length - 1] !== sample) {
        compacted.push(sample);
      }
    }

    return compacted;
  }

  // Hover-only moves remain latest-only. During an active paint stroke we
  // retain ordered/coalesced samples until the next frame so narrow side
  // faces cannot disappear merely because a newer pointer event arrived.
  function schedulePointerMove(event, processor) {
    const isPaintSample =
      state.paintPointerId === event.pointerId && event.buttons === 1;

    if (isPaintSample) {
      pointerSamplesForMoveEvent(event).forEach((sampleEvent) => {
        const previous = pointerMoveScheduler.samples[pointerMoveScheduler.samples.length - 1];
        const isDuplicate =
          previous?.isPaintSample === true &&
          previous.processor === processor &&
          previous.event.pointerId === sampleEvent.pointerId &&
          previous.event.clientX === sampleEvent.clientX &&
          previous.event.clientY === sampleEvent.clientY;

        if (!isDuplicate) {
          pointerMoveScheduler.samples.push({
            event: sampleEvent,
            isPaintSample: true,
            processor
          });
        }
      });
      pointerMoveScheduler.samples = compactPointerMoveSamples(
        pointerMoveScheduler.samples,
        pointerPaintSamplesPerFrameLimit
      );
    } else if (!pointerMoveScheduler.samples.some((sample) => sample.isPaintSample)) {
      pointerMoveScheduler.samples = [{ event, isPaintSample: false, processor }];
    }

    if (pointerMoveScheduler.frameId !== null) {
      return;
    }

    pointerMoveScheduler.frameId = window.requestAnimationFrame(() => {
      const pendingSamples = pointerMoveScheduler.samples;

      pointerMoveScheduler.frameId = null;
      pointerMoveScheduler.samples = [];

      pendingSamples.forEach((sample) => sample.processor?.(sample.event));
    });
  }

  function cancelScheduledPointerMove() {
    if (pointerMoveScheduler.frameId !== null) {
      window.cancelAnimationFrame(pointerMoveScheduler.frameId);
    }
    pointerMoveScheduler.frameId = null;
    pointerMoveScheduler.samples = [];
  }

  function flushScheduledPointerMoves() {
    if (pointerMoveScheduler.frameId !== null) {
      window.cancelAnimationFrame(pointerMoveScheduler.frameId);
    }

    const pendingSamples = pointerMoveScheduler.samples;
    pointerMoveScheduler.frameId = null;
    pointerMoveScheduler.samples = [];
    pendingSamples.forEach((sample) => sample.processor?.(sample.event));
  }

  function processGridPointerMove(event) {
    if (
      isEditorInteractionLocked() ||
      eventTargetsAuthorOverlay(event) ||
      !fallbackPaintTargetFromPoint(event.clientX, event.clientY)
    ) {
      clearEditorHoverTarget();
      return;
    }

    const target = syncEditorHoverFromPointerEvent(event);

    if (state.paintPointerId !== event.pointerId || event.buttons !== 1) {
      return;
    }

    if (!canDragPaintTarget(target)) {
      return;
    }

    paintFaceTargetOnce(target);
  }

  function handleGridPointerMove(event) {
    if (isEditorInteractionLocked()) {
      clearEditorHoverTarget();
      return;
    }
    schedulePointerMove(event, processGridPointerMove);
  }

  function finishPainting(pointerId = state.paintPointerId) {
    if (state.paintPointerId === null || pointerId !== state.paintPointerId) {
      return false;
    }

    // A pointerup can arrive before this frame's queued move samples. Process
    // them while the stroke lock is still active so its final side tiles are
    // not silently dropped.
    flushScheduledPointerMoves();
    const capturedPointerId = state.paintPointerId;
    const didPaint = state.paintStrokeDidPaint;

    state.paintPointerId = null;
    state.paintStrokeDidPaint = false;
    state.paintStrokeLevelId = null;
    state.paintStrokePaintedVoxelKeys.clear();
    state.paintStrokeToken = null;
    state.lastPaintTargetKey = null;
    state.eraseGestureMode = null;
    state.paintDragPlane = null;
    try {
      if (elements.grid.hasPointerCapture?.(capturedPointerId)) {
        elements.grid.releasePointerCapture(capturedPointerId);
      }
    } catch (_) {}

    if (didPaint) {
      // One full refresh per stroke: rebuild every hit button, render the 3D
      // scene immediately, and flush the deferred raw output / solver state.
      cancelScheduledEditorSceneRender();
      renderGrid();
      renderSelectedCell();
      renderRawOutput();
      syncSolverButtonState();
    }

    return didPaint;
  }

  function stopPainting(event) {
    finishPainting(event.pointerId);
  }

  function eventTargetsEditorGrid(event) {
    return event.target instanceof Node && elements.grid.contains(event.target);
  }

  // Editor chrome can float over the canvas; pointer capture still reports
  // the grid as event.target, so also inspect the element under the pointer.
  function eventTargetsAuthorOverlay(event) {
    const eventTarget = event.target instanceof Element ? event.target : null;
    const pointTarget =
      Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
        ? document.elementFromPoint?.(event.clientX, event.clientY)
        : null;

    return Boolean(
      eventTarget?.closest(authorOverlaySelector) ||
      pointTarget?.closest?.(authorOverlaySelector)
    );
  }

  function handleDocumentGridPointerDown(event) {
    if (isEditorInteractionLocked() || eventTargetsAuthorOverlay(event)) {
      return;
    }
    if (eventTargetsEditorGrid(event) || !fallbackPaintTargetFromPoint(event.clientX, event.clientY)) {
      return;
    }

    handleGridPointerDown(event);
  }

  function processDocumentGridPointerMove(event) {
    if (isEditorInteractionLocked()) {
      clearEditorHoverTarget();
      return;
    }

    const isActivePaintPointer = state.paintPointerId === event.pointerId;
    const isOverGrid =
      !eventTargetsAuthorOverlay(event) &&
      Boolean(fallbackPaintTargetFromPoint(event.clientX, event.clientY));

    if (!isActivePaintPointer && !isOverGrid) {
      clearEditorHoverTarget();
      return;
    }

    processGridPointerMove(event);
  }

  function handleDocumentGridPointerMove(event) {
    if (eventTargetsEditorGrid(event)) {
      return;
    }

    schedulePointerMove(event, processDocumentGridPointerMove);
  }

  function handleDocumentGridPointerEnd(event) {
    if (!eventTargetsEditorGrid(event) && state.paintPointerId === event.pointerId) {
      stopPainting(event);
    }
  }

  function handleGridContextMenu(event) {
    if (isEditorInteractionLocked() || eventTargetsAuthorOverlay(event)) {
      return;
    }

    const target = paintTargetFromPointerEvent(event);

    if (
      !target ||
      target.kind === "levelSwitch" ||
      !isInsideEditorCell(target.sourceX, target.sourceY)
    ) {
      return;
    }

    event.preventDefault();
    const x = target.sourceX;
    const y = target.sourceY;
    const descriptor = getCellDescriptor(state.cells[y][x]);

    selectCell(x, y);
    selectToken(descriptor.topToken, { assignToActiveSlot: true });
  }

  function handleDocumentGridContextMenu(event) {
    if (eventTargetsEditorGrid(event) || !fallbackPaintTargetFromPoint(event.clientX, event.clientY)) {
      return;
    }

    handleGridContextMenu(event);
  }

  function resetDisclosureBodyStyles(body) {
    body.style.height = "";
    body.style.opacity = "";
    body.style.overflow = "";
    body.style.paddingTop = "";
    body.style.paddingBottom = "";
  }

  function setDisclosureOpen(details, shouldOpen) {
    const body = details.querySelector(".author-disclosure__body");

    if (!body || details.classList.contains("is-animating")) {
      return;
    }

    const isOpen = details.hasAttribute("open");

    if (isOpen === shouldOpen) {
      return;
    }

    details.classList.add("is-animating");
    body.style.overflow = "hidden";

    let finished = false;
    const finish = function () {
      if (finished) {
        return;
      }

      finished = true;
      body.removeEventListener("transitionend", handleTransitionEnd);
      details.classList.remove("is-animating");

      if (!shouldOpen) {
        details.removeAttribute("open");
      }

      resetDisclosureBodyStyles(body);
      scheduleEditorGridLayout();
    };
    const handleTransitionEnd = function (event) {
      if (event.target === body && event.propertyName === "height") {
        finish();
      }
    };

    body.addEventListener("transitionend", handleTransitionEnd);

    // Animate padding alongside height so the collapse lands at a true 0px
    // instead of popping over the body's padding at the end.
    if (shouldOpen) {
      details.setAttribute("open", "");
      const computed = window.getComputedStyle(body);
      const targetHeight = body.scrollHeight;
      const targetPaddingTop = computed.paddingTop;
      const targetPaddingBottom = computed.paddingBottom;
      body.style.height = "0px";
      body.style.opacity = "0";
      body.style.paddingTop = "0px";
      body.style.paddingBottom = "0px";

      window.requestAnimationFrame(() => {
        body.style.height = targetHeight + "px";
        body.style.opacity = "1";
        body.style.paddingTop = targetPaddingTop;
        body.style.paddingBottom = targetPaddingBottom;
      });
    } else {
      const computed = window.getComputedStyle(body);
      body.style.height = body.scrollHeight + "px";
      body.style.opacity = "1";
      body.style.paddingTop = computed.paddingTop;
      body.style.paddingBottom = computed.paddingBottom;

      window.requestAnimationFrame(() => {
        body.style.height = "0px";
        body.style.opacity = "0";
        body.style.paddingTop = "0px";
        body.style.paddingBottom = "0px";
      });
    }

    window.setTimeout(finish, 260);
  }

  let activeAuthorInfoButton = null;
  let authorInfoCloseTimer = 0;

  function positionAuthorInfoPopover() {
    const popover = document.getElementById("author-info-popover");
    const button = activeAuthorInfoButton;
    if (!popover || !button || popover.hidden) return;

    const margin = 12;
    const gap = 10;
    const buttonRect = button.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    let left = buttonRect.right + gap;

    if (left + popoverRect.width > viewportWidth - margin) {
      left = buttonRect.left - popoverRect.width - gap;
    }
    left = Math.max(margin, Math.min(left, viewportWidth - popoverRect.width - margin));

    const preferredTop = buttonRect.top - 10;
    const top = Math.max(
      margin,
      Math.min(preferredTop, viewportHeight - popoverRect.height - margin)
    );

    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  function closeAuthorInfoPopover(options = {}) {
    const popover = document.getElementById("author-info-popover");
    const previousButton = activeAuthorInfoButton;
    if (!popover || popover.hidden) return;

    activeAuthorInfoButton = null;
    previousButton?.setAttribute("aria-expanded", "false");
    popover.classList.remove("is-open");
    window.clearTimeout(authorInfoCloseTimer);
    authorInfoCloseTimer = window.setTimeout(() => {
      if (!activeAuthorInfoButton) {
        popover.hidden = true;
        popover.style.removeProperty("left");
        popover.style.removeProperty("top");
      }
    }, 180);
    if (options.restoreFocus === true) {
      previousButton?.focus({ preventScroll: true });
    }
  }

  function openAuthorInfoPopover(button) {
    const popover = document.getElementById("author-info-popover");
    const title = document.getElementById("author-info-popover-title");
    const description = document.getElementById("author-info-popover-description");
    if (!popover || !title || !description || !button) return;

    if (activeAuthorInfoButton === button && !popover.hidden) {
      closeAuthorInfoPopover({ restoreFocus: true });
      return;
    }

    activeAuthorInfoButton?.setAttribute("aria-expanded", "false");
    window.clearTimeout(authorInfoCloseTimer);
    activeAuthorInfoButton = button;
    title.textContent = button.dataset.panelInfoTitle || "About this panel";
    description.textContent = button.dataset.panelInfoDescription || "";
    button.setAttribute("aria-expanded", "true");
    popover.hidden = false;
    popover.classList.remove("is-open");
    positionAuthorInfoPopover();
    window.requestAnimationFrame(() => {
      if (activeAuthorInfoButton !== button) return;
      popover.classList.add("is-open");
      popover.querySelector("[data-panel-info-close]")?.focus({ preventScroll: true });
    });
  }

  function initializeAuthorInfoPopover() {
    const popover = document.getElementById("author-info-popover");
    if (!popover) return;

    popover.querySelector("[data-panel-info-close]")?.addEventListener("click", () => {
      closeAuthorInfoPopover({ restoreFocus: true });
    });
    document.addEventListener("pointerdown", (event) => {
      if (popover.hidden) return;
      if (popover.contains(event.target) || activeAuthorInfoButton?.contains(event.target)) return;
      closeAuthorInfoPopover();
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !popover.hidden) {
        event.preventDefault();
        closeAuthorInfoPopover({ restoreFocus: true });
      }
    });
    window.addEventListener("resize", positionAuthorInfoPopover);
    document.addEventListener("scroll", positionAuthorInfoPopover, true);
  }

  function initializeAuthorDisclosures() {
    document.querySelectorAll(".author-disclosure").forEach((details) => {
      const summary = details.querySelector(".author-disclosure__summary");
      const body = details.querySelector(".author-disclosure__body");

      if (!summary || !body) {
        return;
      }

      // Panels marked data-open="1" start expanded (no animation on load);
      // everything else starts collapsed.
      if (details.dataset.open === "1") {
        details.setAttribute("open", "");
      } else {
        details.removeAttribute("open");
      }
      resetDisclosureBodyStyles(body);
      summary.addEventListener("click", function (event) {
        event.preventDefault();
        setDisclosureOpen(details, !details.hasAttribute("open"));
      });

      const infoButton = summary.querySelector("[data-panel-info]");
      if (infoButton) {
        infoButton.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          openAuthorInfoPopover(infoButton);
        });
      }
    });
  }

  function initializeAuthorPageExtras() {
    const meta = authorData.worldMeta;
    const titleInput = document.getElementById("world-title-input");
    const titleSave = document.getElementById("world-title-save");

    if (meta && titleInput && titleSave) {
      titleInput.value = meta.title || "";
      const rename = async () => {
        const title = titleInput.value.trim();
        if (!title || title === meta.title) {
          return;
        }
        titleSave.disabled = true;
        try {
          const response = await fetch(meta.apiUrl, {
            body: JSON.stringify({ title }),
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            method: "PATCH"
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || "Could not rename the world.");
          }
          meta.title = payload.world?.title || title;
          titleInput.value = meta.title;
          const heading = document.querySelector(".author-topbar h1");
          if (heading) {
            heading.textContent = meta.title;
          }
          document.title = meta.title + " — Maze Bench Editor";
          setStatus("World renamed.", "success");
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Could not rename the world.", "error");
        } finally {
          titleSave.disabled = false;
        }
      };
      titleSave.addEventListener("click", rename);
      titleInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          rename();
        }
      });
    }

    // Details: a compact pixel map chooses the room the world boots into.
    // Saved rooms are interactive; the current default is the bright pixel.
    const startGrid = document.getElementById("world-start-grid");
    if (meta && startGrid) {
      let startRoomSaving = false;
      renderStartRoomGrid = () => {
        const existingIds = new Set((authorData.existingLevels || []).map((level) => level.id));
        startGrid.style.setProperty("--author-start-room-columns", String(worldColumns.length));
        startGrid.replaceChildren();
        worldRows.forEach((rowLetter) => {
          worldColumns.forEach((columnLetter) => {
            const levelId = "level_" + columnLetter + "x" + rowLetter;
            const coordinateLabel = columnLetter + "x" + rowLetter;
            const exists = existingIds.has(levelId) || (levelId === state.levelId && state.exists);
            const isStart = levelId === meta.startLevelId;
            const pixel = document.createElement("button");
            pixel.type = "button";
            pixel.className = "author-start-room-pixel" + (isStart ? " is-start" : "");
            pixel.dataset.levelId = levelId;
            pixel.disabled = !exists || startRoomSaving;
            pixel.setAttribute("role", "gridcell");
            pixel.setAttribute("aria-pressed", isStart ? "true" : "false");
            pixel.setAttribute(
              "aria-label",
              isStart
                ? coordinateLabel + " is the starting room"
                : exists
                  ? "Use " + coordinateLabel + " as the starting room"
                  : coordinateLabel + " has not been saved"
            );
            pixel.title = pixel.getAttribute("aria-label");
            startGrid.append(pixel);
          });
        });
      };
      renderStartRoomGrid();
      startGrid.addEventListener("click", async (event) => {
        const pixel = event.target.closest(".author-start-room-pixel[data-level-id]");
        if (!pixel || pixel.disabled || startRoomSaving) return;
        const startLevelId = pixel.dataset.levelId;
        if (!startLevelId || startLevelId === meta.startLevelId) return;
        startRoomSaving = true;
        renderStartRoomGrid();
        try {
          const response = await fetch(meta.apiUrl, {
            body: JSON.stringify({ start_level_id: startLevelId }),
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            method: "PATCH"
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || "Could not set the starting room.");
          }
          meta.startLevelId = payload.world?.editor_state?.start_level_id || startLevelId;
          meta.walkthroughVerified = payload.world?.walkthrough_verified === true;
          setStatus("Starting room set to " + meta.startLevelId.replace("level_", "") + ".", "success");
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Could not set the starting room.", "error");
        } finally {
          startRoomSaving = false;
          renderStartRoomGrid();
        }
      });
    }

    // Publish gate: the page's publish button asks the editor for a live
    // checklist before it talks to the server (which re-enforces all of it).
    const playerTokenPattern = /^(p|cp|p[rlud])$/;
    window.__MAZEBENCH_AUTHOR_PUBLISH_CHECKS__ = async () => {
      if (state.isDirty) {
        const choice = await promptForUnsavedChanges({
          message:
            (hostedWorldDraftMode ? "This world" : "This room") +
            " has unsaved changes. Save before publishing?",
          saveLabel: "Save & Continue"
        });
        if (choice === "cancel") {
          return { cancelled: true, ok: false };
        }
        const saved = await saveLevel({ refreshPreview: false });
        if (!saved || state.isDirty) {
          return { cancelled: true, ok: false };
        }
        if (meta) {
          meta.walkthroughVerified = false;
          syncVerifiedStat();
        }
      }
      let totalGems = 0;
      const roomsMissingPlayer = [];
      (authorData.existingLevels || []).forEach((level) => {
        const cells = level.id === state.levelId ? state.cells : level.cells;
        let hasPlayer = false;
        (cells || []).forEach((row) => {
          (row || []).forEach((cell) => {
            String(cell || "").split("+").forEach((part) => {
              if (part === "G") totalGems += 1;
              if (playerTokenPattern.test(part)) hasPlayer = true;
            });
          });
        });
        if (!hasPlayer) {
          roomsMissingPlayer.push(level.id);
        }
      });
      const verified = false;
      return {
        ok: totalGems > 0 && roomsMissingPlayer.length === 0 && verified,
        roomsMissingPlayer,
        startWorldSolver: async () => {
          if (state.isDirty) {
            await saveLevel({ refreshPreview: false });
          }
          const worldId = String(meta?.apiUrl || "").split("/").pop() || "";
          const startId = meta?.startLevelId || authorData.existingLevels?.[0]?.id || "level_AxA";
          window.location.assign(
            "/play/maze/" + encodeURIComponent(startId) +
            "?world=" + encodeURIComponent(worldId) + "&draft=1&world_solver=1"
          );
        },
        totalGems,
        verified
      };
    };

    installUnsavedNavigationGuards();

    document.getElementById("hotbar-slots")?.addEventListener("click", (event) => {
      const slot = event.target.closest("[data-token]");
      if (slot) {
        selectToken(slot.dataset.token);
      }
    });

    const camPad = document.getElementById("author-cam-pad");
    if (camPad) {
      const endCameraHold = (event) => {
        const button = event.target.closest("[data-camera]");
        button?.classList.remove("is-active");
        if (editorCam.pointerTiltDir) {
          editorCam.pointerTiltDir = 0;
          editorCamRecomputeTiltDirection();
        }
      };
      camPad.addEventListener("pointerdown", (event) => {
        const button = event.target.closest("[data-camera]");
        if (!button) {
          return;
        }
        event.preventDefault();
        try {
          button.setPointerCapture?.(event.pointerId);
        } catch {
          // Synthetic or already-released pointers can't be captured.
        }
        button.classList.add("is-active");
        const move = button.dataset.camera;
        if (move === "left" || move === "right") {
          editorCamRotate(move === "left" ? -1 : 1);
        } else {
          editorCam.pointerTiltDir = move === "up" ? -1 : 1;
          editorCamRecomputeTiltDirection();
        }
      });
      camPad.addEventListener("pointerup", endCameraHold);
      camPad.addEventListener("pointercancel", endCameraHold);
    }
    document.getElementById("hotbar-backpack")?.addEventListener("click", () => {
      setInventoryOpen(!isInventoryOpen());
    });
    document.getElementById("inventory-close")?.addEventListener("click", () => {
      setInventoryOpen(false);
    });

    window.addEventListener("keydown", (event) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        String(event.key).toLowerCase() === "s"
      ) {
        event.preventDefault();
        if (state.isDirty && !state.isSolverBusy) {
          saveLevel();
        }
      }
    });

    // Safety net for hosts without the boot reveal (its completion is the
    // primary trigger): run the staged world reveal — neighbor priming,
    // incremental warm, camera pull-back, thumbnails, palette previews.
    window.setTimeout(() => {
      revealEditorWorld();
    }, 6000);

    // Publish-time hero: hosts can call this for a clean 3D whole-world image.
    window.__MAZEBENCH_RENDER_WORLD_HERO__ = (options) =>
      renderWorldHeroCardDataUrl(options || {});
  }

  // Stitch every room of the world into one continuous board (rooms sit
  // edge-to-edge in grid order). Bails when a room is missing or rooms are
  // not uniform 16x16, or when the combined board would be unreasonably big.
  function stitchWorldCells(levels, columns, rows) {
    if (!columns || !rows) {
      return null;
    }
    const roomWidth = 16;
    const roomHeight = 16;
    if (columns * roomWidth > 96 || rows * roomHeight > 96) {
      return null;
    }
    const levelsById = new Map((levels || []).map((level) => [level?.id, level]));
    const cells = Array.from({ length: rows * roomHeight }, () => []);
    for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
      for (let columnIndex = 0; columnIndex < columns; columnIndex += 1) {
        const levelId =
          "level_" + String.fromCharCode(65 + columnIndex) + "x" + String.fromCharCode(65 + rowIndex);
        const level = levelsById.get(levelId);
        if (
          !level ||
          !Array.isArray(level.cells) ||
          level.width !== roomWidth ||
          level.height !== roomHeight
        ) {
          return null;
        }
        for (let y = 0; y < roomHeight; y += 1) {
          const targetRow = cells[rowIndex * roomHeight + y];
          for (let x = 0; x < roomWidth; x += 1) {
            targetRow[columnIndex * roomWidth + x] = level.cells[y][x];
          }
        }
      }
    }
    return { cells, height: rows * roomHeight, width: columns * roomWidth };
  }

  // Renders the saved (canonical) world at card size on a throwaway app —
  // the WHOLE stitched world when possible, otherwise the start room. The
  // capture is image-only: no player, title, or metadata is baked into it.
  async function renderWorldHeroCardDataUrl(options) {
    const meta = authorData.worldMeta;
    if (!meta) {
      return null;
    }
    let board = null;
    try {
      const response = await fetch(meta.apiUrl, { headers: { Accept: "application/json" } });
      const payload = await response.json();
      const levels = payload?.world?.editor_state?.levels || [];
      const stitched = stitchWorldCells(levels, meta.width, meta.height);
      if (stitched) {
        board = stitched;
      } else {
        const level =
          levels.find((entry) => entry?.id === String(options.levelId || "")) || levels[0] || null;
        if (level && Array.isArray(level.cells)) {
          board = { cells: level.cells, height: level.height, width: level.width };
        }
      }
    } catch {
      board = null;
    }
    if (!board) {
      return null;
    }

    const sceneCanvas = document.createElement("canvas");
    sceneCanvas.width = 1200;
    sceneCanvas.height = 630;
    const playData = buildPlayData({
      cameraView: { width: board.width, height: board.height },
      cells: board.cells.map((row) => row.slice()),
      editorRender: true,
      gameId: authorData.game.id,
      height: board.height,
      includeGems: true,
      levelId: "__author_social_card__",
      levelLabel: meta.title || "World",
      width: board.width
    });
    playData.actors = (playData.actors || []).filter(
      (actor) => actor?.type !== "player" && actor?.type !== "circle_player"
    );
    const app = createAuxiliaryRenderApp(sceneCanvas, playData);
    if (!app) {
      return null;
    }

    try {
      if (app.threeRendererReady && typeof app.threeRendererReady.then === "function") {
        await app.threeRendererReady;
      }
      try {
        await app.preloadImagesForLevelState(playData);
        await app.threeRenderer?.whenLevelStateModelsReady?.(playData);
      } catch {
        // Fallback primitives are still better than no card.
      }
      app.threeRenderer?.setDebugCameraView?.({
        yaw: 0,
        tilt: 0.42,
        zoom: Math.max(0.55, Math.min(1.4, Number(meta.width || 1) / Math.max(1, Number(meta.height || 1)))),
        mode: "perspective",
        skipRender: true
      });
      app.render();

      const card = document.createElement("canvas");
      card.width = 1200;
      card.height = 630;
      const context = card.getContext("2d");
      if (!context) {
        return null;
      }
      context.fillStyle = "#05060e";
      context.fillRect(0, 0, card.width, card.height);
      // Cover-fit the rendered scene.
      const scale = Math.max(card.width / sceneCanvas.width, card.height / sceneCanvas.height);
      const drawWidth = sceneCanvas.width * scale;
      const drawHeight = sceneCanvas.height * scale;
      context.drawImage(
        sceneCanvas,
        (card.width - drawWidth) / 2,
        (card.height - drawHeight) / 2,
        drawWidth,
        drawHeight
      );
      return card.toDataURL("image/png");
    } finally {
      disposeAuxiliaryRenderApp(app, sceneCanvas);
    }
  }

  window.addEventListener("pagehide", (event) => {
    if (event.persisted) {
      return;
    }
    stopDemoScene();
    disposeAuxiliaryRenderApp(
      demoSceneRenderer.app,
      document.getElementById("inventory-demo-canvas")
    );
    demoSceneRenderer.app = null;
    disposeAuxiliaryRenderApp(worldThumbRenderer.app, worldThumbRenderer.canvas);
    worldThumbRenderer.app = null;
  });

  renderLevelSelectors();
  renderPalette();
  // Palette preview renders are deferred to the staged post-boot chain in
  // revealEditorWorld() so their WebGL work never competes with the glow
  // sweep (opening the toolbox early also kicks them; see setInventoryOpen).
  renderAll();
  initializeAuthorInfoPopover();
  initializeAuthorDisclosures();
  initializeAuthorPageExtras();

  elements.palette.addEventListener("click", function (event) {
    const button = event.target.closest("[data-token]");

    if (!button) {
      return;
    }

    if (isPromptToolToken(button.dataset.token)) {
      // Box N / Clone N / colored-slope entries ask for the id first, then
      // select the concrete pattern token themselves.
      promptAndSelectPatternToken(button.dataset.token).catch(() => {});
      return;
    }

    selectToken(button.dataset.token, { assignToActiveSlot: true });
  });

  elements.grid.addEventListener("pointerdown", handleGridPointerDown);
  elements.grid.addEventListener("pointermove", handleGridPointerMove);
  elements.grid.addEventListener("pointerup", stopPainting);
  elements.grid.addEventListener("pointercancel", stopPainting);
  elements.grid.addEventListener("pointerleave", function (event) {
    if (state.paintPointerId !== event.pointerId) {
      clearEditorHoverTarget();
    }
  });
  elements.grid.addEventListener("contextmenu", handleGridContextMenu);
  document.addEventListener("pointerdown", handleDocumentGridPointerDown, true);
  document.addEventListener("pointermove", handleDocumentGridPointerMove, true);
  document.addEventListener("pointerup", handleDocumentGridPointerEnd, true);
  document.addEventListener("pointercancel", handleDocumentGridPointerEnd, true);
  document.addEventListener("contextmenu", handleDocumentGridContextMenu, true);

  if (elements.levelColumn && elements.levelRow) {
    elements.levelColumn.addEventListener("change", function () {
      const nextLevelId = levelIdFromSelectors();

      if (nextLevelId !== state.levelId) {
        switchToLevelId(nextLevelId);
      }
    });

    elements.levelRow.addEventListener("change", function () {
      const nextLevelId = levelIdFromSelectors();

      if (nextLevelId !== state.levelId) {
        switchToLevelId(nextLevelId);
      }
    });
  }

  elements.resizeLevel.addEventListener("click", resizeLevel);
  elements.clearLevel.addEventListener("click", clearLevel);
  elements.frameLevel.addEventListener("click", frameLevel);
  elements.rotateLeft.addEventListener("click", function () {
    transformLevel("rotate-left");
  });
  elements.rotateRight.addEventListener("click", function () {
    transformLevel("rotate-right");
  });
  elements.flipHorizontal.addEventListener("click", function () {
    transformLevel("flip-horizontal");
  });
  elements.flipVertical.addEventListener("click", function () {
    transformLevel("flip-vertical");
  });
  elements.placeGem?.addEventListener("click", placeGem);
  elements.hillClimb?.addEventListener("click", hillClimb);
  elements.hillClimbMode?.addEventListener("change", syncSolverButtonState);
  elements.hillClimbPrev?.addEventListener("click", function () {
    pageHillClimbResult(-1);
  });
  elements.hillClimbNext?.addEventListener("click", function () {
    pageHillClimbResult(1);
  });
  elements.playSolution?.addEventListener("click", playSolution);
  elements.solverCancel?.addEventListener("click", cancelSolverRun);
  elements.solverAlgorithm?.addEventListener("change", syncSolverButtonState);
  elements.solverMaxStates.addEventListener("change", normalizeSolverMaxExpandedStatesInput);
  elements.solverModePlace.addEventListener("click", function () {
    selectSolverMode("place_gem");
  });
  elements.solverModeReach.addEventListener("click", function () {
    selectSolverMode("reach_gem");
  });
  elements.applyCellValue.addEventListener("click", applySelectedCellValue);
  elements.cellValue.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      applySelectedCellValue();
    }
  });
  elements.solveLevel.addEventListener("click", runSelectedSolverMode);
  elements.undoLevel.addEventListener("click", undoLastEdit);
  elements.saveLevel.addEventListener("click", saveLevel);
  document.addEventListener("keydown", handleEditorKeydown);
  document.addEventListener("keyup", function (event) {
    const key = String(event.key || "").toLowerCase();
    if (key === "w" || key === "s") {
      editorCam.heldTiltKeys.delete(key);
      editorCamRecomputeTiltDirection();
    }
  });
  window.addEventListener("blur", function () {
    editorCam.heldTiltKeys.clear();
    editorCam.pointerTiltDir = 0;
    editorCamRecomputeTiltDirection();
  });

  elements.levelNeighbors?.addEventListener("click", function (event) {
    const button = event.target.closest("[data-level-id]");

    if (!button) {
      return;
    }

    const nextLevelId = button.dataset.levelId;
    const dx = Number(button.dataset.dx);
    const dy = Number(button.dataset.dy);

    if (nextLevelId && nextLevelId !== state.levelId) {
      switchToNeighborLevel({
        dx,
        dy,
        kind: "levelSwitch",
        levelId: nextLevelId
      });
    }
  });

  if (elements.existingLevels) {
    elements.existingLevels.addEventListener("click", function (event) {
      const link = event.target.closest("[data-level-id]");

      if (!link) {
        return;
      }

      event.preventDefault();
      const nextLevelId = link.dataset.levelId;

      if (handleWorldMapSwapSelection(nextLevelId)) {
        return;
      }

      if (nextLevelId !== state.levelId) {
        if (elements.levelColumn && elements.levelRow) {
          const coordinates = parseLevelCoordinates(nextLevelId);

          if (coordinates) {
            elements.levelColumn.value = coordinates.column;
            elements.levelRow.value = coordinates.row;
          }
        }
        switchToLevelId(nextLevelId);
      }
    });
  }

  elements.worldMapSwap?.addEventListener("click", function () {
    setWorldMapSwapMode(!state.worldMapSwapMode);
  });
  window.addEventListener("mazebench:author-world-map-closed", function () {
    setWorldMapSwapMode(false);
  });

  window.addEventListener("beforeunload", function (event) {
    if (!state.isDirty || allowDirtyUnload) {
      return;
    }

    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("resize", scheduleEditorGridLayout);
  window.addEventListener("resize", positionSolverDock);
  window.addEventListener("resize", invalidateEditorGridRect);
  document.addEventListener("scroll", invalidateEditorGridRect, { capture: true, passive: true });
})();
