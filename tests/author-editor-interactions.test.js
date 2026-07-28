const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const authorSource = fs.readFileSync(
  path.join(__dirname, "..", "public", "author.js"),
  "utf8"
);
const rendererSource = fs.readFileSync(
  path.join(__dirname, "..", "public", "play-render-three.js"),
  "utf8"
);
const gameplaySource = fs.readFileSync(
  path.join(__dirname, "..", "public", "play-gameplay.js"),
  "utf8"
);
const worldTransitionsSource = fs.readFileSync(
  path.join(__dirname, "..", "public", "play-world-transitions.js"),
  "utf8"
);

assert.match(authorSource, /function openAuthorInfoPopover\(button\)/);
assert.match(authorSource, /function closeAuthorInfoPopover\(options = \{\}\)/);
assert.match(authorSource, /document\.addEventListener\("pointerdown"/);
assert.match(authorSource, /event\.key === "Escape"/);
assert.doesNotMatch(authorSource, /const showNote = note\.hidden/);
assert.match(authorSource, /Play Solution/);
assert.match(authorSource, /function authorUrlForLevel\(levelId\)/);
assert.match(authorSource, /function playUrlForLevel\(levelId\)/);
assert.match(authorSource, /document\.querySelectorAll\("\[data-author-play-link\]"\)/);
assert.match(authorSource, /authorUrlForLevel\(state\.levelId\)/);
assert.match(authorSource, /function solverGhostCellsForPath\(path\)/);
assert.match(authorSource, /engine\.moveForSearch\(engineState, direction\.dx, direction\.dy\)/);
assert.match(authorSource, /function setSolverGhostVisible\(visible\)/);
assert.match(authorSource, /setSolverGhostCells/);
assert.match(authorSource, /function positionSolverDock\(\)/);
assert.match(authorSource, /toggleRect\.left - mapRect\.right - 24/);
assert.match(authorSource, /new window\.ResizeObserver\(positionSolverDock\)/);
assert.match(authorSource, /function syncEditorCameraDownshift\(app = editorRenderer\.app\)/);
assert.match(authorSource, /shellRect\.bottom - hotbarRect\.top\) \/ 2/);
assert.match(rendererSource, /function applyCameraDownshift\(center\)/);
assert.match(rendererSource, /camera\.position\.addScaledVector\(camera\.up, -worldDownshift\)/);
assert.match(rendererSource, /function addSolverGhostPath\(now = performance\.now\(\)\)/);
assert.match(rendererSource, /new THREE\.InstancedMesh/);
assert.match(gameplaySource, /const LATE_INPUT_WINDOW_MS = 200/);
assert.match(gameplaySource, /app\.queuedAction = action/);
assert.match(gameplaySource, /app\.onPlayerPitAutoUndo\?\.\(\)/);
assert.match(gameplaySource, /blinkCount: 1,[\s\S]*blinkDurationMs: 50,[\s\S]*blinkRevivedPlayer: true,[\s\S]*blinkVisibleDurationMs: 50,[\s\S]*instantRestore: true/);
assert.match(gameplaySource, /if \(options\.instantRestore === true\)/);
assert.match(gameplaySource, /movement\.applyMoveFinalState\(moves\)/);
assert.match(gameplaySource, /moveResult\?\.moves\?\.some/);
assert.match(worldTransitionsSource, /if \(blinkCount === 1\)/);
assert.match(worldTransitionsSource, /now - startMs < visibleDurationMs/);
assert.match(worldTransitionsSource, /hiddenAtMs = now/);
assert.match(rendererSource, /`solver-ghost:\$\{solverGhostVersion\}`/);

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function assertBefore(source, firstMarker, secondMarker, message) {
  const first = source.indexOf(firstMarker);
  const second = source.indexOf(secondMarker);

  assert.notEqual(first, -1, `missing marker: ${firstMarker}`);
  assert.notEqual(second, -1, `missing marker: ${secondMarker}`);
  assert.ok(first < second, message || `${firstMarker} must precede ${secondMarker}`);
}

const transformLevelSection = sourceSection(
  authorSource,
  "function transformLevel",
  "function applySelectedCellValue"
);
assert.match(
  transformLevelSection,
  /tokenPatternHelpers\.transformDirectionalCellValue\([\s\S]*cell,[\s\S]*authorData\.blockAdder,[\s\S]*transformType/
);
assertBefore(
  transformLevelSection,
  "tokenPatternHelpers.transformDirectionalCellValue",
  "pushUndoSnapshot()",
  "directional tokens must be reoriented before the transformed board is committed"
);

const currentPlayerForWorldActionSource = sourceSection(
  gameplaySource,
  "function currentPlayerForWorldAction",
  "function worldActionLevelSnapshot"
);
const worldActionPlayer = { type: "player", removed: false };
const roomClone = { type: "clone", removed: false };
const currentPlayerForWorldAction = vm.runInNewContext(
  `(${currentPlayerForWorldActionSource.trim()})`,
  {
    app: {
      isMainPlayerActor: (actor) => actor.type === "player",
      isPlayerActor: (actor) => actor.type === "player" || actor.type === "clone"
    },
    state: { actors: [worldActionPlayer, roomClone] }
  }
);
assert.equal(
  currentPlayerForWorldAction(),
  worldActionPlayer,
  "a clone in the room must not disqualify the main player from smooth cross-room movement"
);

const mainPlayerMoveForWorldActionSource = sourceSection(
  gameplaySource,
  "function mainPlayerMoveForWorldAction",
  "function playerLevelExitMoveForContinuation"
);
const ordinaryPlayerMove = {
  actor: worldActionPlayer,
  fromX: 0,
  fromY: 2,
  toX: 1,
  toY: 2,
  visualOnly: false
};
const groupedCloneMoves = [
  { actor: { type: "clone", groupId: "c0" }, fromX: 6, toX: 7, visualOnly: false },
  { actor: { type: "clone", groupId: "c0" }, fromX: 6, toX: 7, visualOnly: false },
  {
    actor: { type: "clone", groupId: "c1", shape: "slope", direction: "left" },
    fromX: 6,
    toX: 6,
    visualOnly: false
  }
];
const mainPlayerMoveForWorldAction = vm.runInNewContext(
  `(${mainPlayerMoveForWorldActionSource.trim()})`,
  {
    app: {
      isMainPlayerActor: (actor) => actor.type === "player",
      isPlayerActor: (actor) => actor.type === "player" || actor.type === "clone"
    }
  }
);
assert.equal(
  mainPlayerMoveForWorldAction({
    moved: true,
    moves: [...groupedCloneMoves, ordinaryPlayerMove]
  }),
  ordinaryPlayerMove,
  "a settled cross-room step must select the main player instead of a member of a multiblock clone group"
);

const shouldContinuePlayerMoveAcrossEdgeSource = sourceSection(
  gameplaySource,
  "function shouldContinuePlayerMoveAcrossEdge",
  "function withContinuationModeForPlayerMove"
);
const shouldContinuePlayerMoveAcrossEdge = vm.runInNewContext(
  `(${shouldContinuePlayerMoveAcrossEdgeSource.trim()})`,
  {
    isSlideContinuationSurface: (type) =>
      type === "ice" || type === "ice_block" || type === "ice_slope",
    mainPlayerMoveForWorldAction: () => ordinaryPlayerMove,
    playerSlideMoveForContinuation: () => null
  }
);
assert.equal(
  shouldContinuePlayerMoveAcrossEdge(
    { moved: true, moves: [...groupedCloneMoves, ordinaryPlayerMove] },
    { sourceType: "ice" }
  ),
  true,
  "entering an ice tile on a room edge must continue without a second keypress"
);
assert.equal(
  shouldContinuePlayerMoveAcrossEdge(
    { moved: true, moves: [...groupedCloneMoves, ordinaryPlayerMove] },
    { sourceType: "floor" }
  ),
  false,
  "an ordinary step onto an edge floor must not turn into an ice continuation"
);

const supportsWorldActionMoveResultSource = sourceSection(
  gameplaySource,
  "function supportsWorldActionMoveResult",
  "function restorePlannedWorldActionStart"
);
const supportsWorldActionMoveResult = vm.runInNewContext(
  `(${supportsWorldActionMoveResultSource.trim()})`,
  {
    app: {
      isPlayerActor: (actor) => actor.type === "player" || actor.type === "clone"
    }
  }
);
assert.equal(
  supportsWorldActionMoveResult({
    moved: true,
    moves: [ordinaryPlayerMove, ...groupedCloneMoves]
  }),
  true,
  "continuous world actions must support every cube and ice-slope member of a clone group"
);

const continuousWorldActionPlanSource = sourceSection(
  gameplaySource,
  "async function planContinuousWorldAction",
  "function worldActionPointAt"
);
assert.match(
  continuousWorldActionPlanSource,
  /playerLevelExitMoveForContinuation\(moveResult\) \|\|[\s\S]*playerSlideMoveForContinuation\(moveResult\) \|\|[\s\S]*mainPlayerMoveForWorldAction\(moveResult\)/,
  "the planner must keep an ordinary landing step so it does not fall back and replay clone input in every room"
);

const restoreCrossRoomUndoStateSource = sourceSection(
  gameplaySource,
  "function restoreCrossRoomUndoState",
  "function restoreGroupedUndoEntry"
);
const historicalRoom = { levelId: "level_CxA", actors: [{ type: "clone", x: 6, y: 12 }] };
const resetEntry = { levelId: "level_CxA", actors: [{ type: "clone", x: 6, y: 9 }] };
const undoRestoreCalls = [];
const restoreCrossRoomUndoState = vm.runInNewContext(
  `(${restoreCrossRoomUndoStateSource.trim()})`,
  {
    applyLevelState: (snapshot) => undoRestoreCalls.push(["apply", snapshot]),
    app: {
      restoreLevelEntryState: (snapshot) => undoRestoreCalls.push(["entry", snapshot]),
      rememberHorizontalNeighborLevelState: (snapshot) => undoRestoreCalls.push(["cache", snapshot])
    }
  }
);
restoreCrossRoomUndoState(historicalRoom, resetEntry);
assert.deepEqual(
  undoRestoreCalls,
  [
    ["apply", historicalRoom],
    ["entry", resetEntry],
    ["cache", resetEntry]
  ],
  "cross-room undo must restore historical actors live without replacing the room reset cache"
);

const iceSlopeMergeSolidTypeSection = sourceSection(
  rendererSource,
  "function iceSlopeMergeSolidType",
  "function iceSlopeDescriptorContactsVoxel"
);
const iceSlopeMergeSolidType = vm.runInNewContext(
  `(${iceSlopeMergeSolidTypeSection.trim()})`
);
assert.equal(
  iceSlopeMergeSolidType({ type: "ice_slope", layer: {} }),
  "ice_block",
  "regular ice slopes must visually merge with ice blocks"
);
assert.equal(
  iceSlopeMergeSolidType({ type: "ice_slope", layer: { styleKey: "wall" } }),
  "wall",
  "black ice slopes must visually merge with normal walls"
);
assert.equal(
  iceSlopeMergeSolidType({ type: "orange_ice_slope", layer: { styleKey: "orange" } }),
  "orange_wall",
  "orange ice slopes must visually merge with orange walls"
);
assert.equal(
  iceSlopeMergeSolidType({ type: "ice_slope", layer: { styleKey: "M0" } }),
  null,
  "numbered slope families must not visually merge with unrelated terrain"
);

const layerSignatureSection = sourceSection(
  rendererSource,
  "function layerSignature",
  "function cameraFitSignature"
);
const layerSignature = vm.runInNewContext(`(${layerSignatureSection.trim()})`);
const plainSlopeLayer = {
  type: "ice_slope",
  elevation: 0,
  direction: "right",
  styleKey: null
};
assert.notEqual(
  layerSignature(plainSlopeLayer),
  layerSignature({ ...plainSlopeLayer, styleKey: "wall" }),
  "black ice slopes must invalidate an ice-colored cached render"
);
assert.notEqual(
  layerSignature(plainSlopeLayer),
  layerSignature({ ...plainSlopeLayer, direction: "left" }),
  "rotated ice slopes must invalidate cached slope geometry"
);

const selectCellSection = sourceSection(
  authorSource,
  "function selectCell",
  "function markDirty"
);
assert.match(
  selectCellSection,
  /if \(!isInsideEditorCell\(x, y\)\) \{\s*return false;\s*\}/,
  "off-board coordinates must be rejected instead of clamped onto an edge cell"
);
assertBefore(
  selectCellSection,
  "if (!isInsideEditorCell(x, y))",
  "const previousCell",
  "selection bounds must be checked before changing or rendering the selection"
);

const paintTargetSection = sourceSection(
  authorSource,
  "function paintTargetFromPointerEvent",
  "function syncEditorHoverFromPointerEvent"
);
assert.match(
  paintTargetSection,
  /if \(typeof pickEditorFace === "function"\) \{[\s\S]*?const pickedTarget = pickEditorFace(?:\.call)?\([\s\S]*?if \(!pickedTarget\) \{\s*return null;\s*\}/,
  "a miss from the active 3D picker must remain a miss instead of falling through to the 2D grid"
);
assert.match(
  paintTargetSection,
  /return\s*\(\s*fallbackPaintTargetFromButton\([\s\S]*?\|\| fallbackPaintTargetFromPoint\(/,
  "the 2D hit-grid fallback should remain available before the 3D picker is ready"
);

const pointerDownSection = sourceSection(
  authorSource,
  "function handleGridPointerDown",
  "function pointerSamplesForMoveEvent"
);
assert.match(pointerDownSection, /event\.button !== 0/);
assert.match(pointerDownSection, /isEditorInteractionLocked\(\)/);
assertBefore(
  pointerDownSection,
  "event.button !== 0",
  "syncEditorHoverFromPointerEvent(event)",
  "non-primary input must be rejected before any scene pick"
);
assertBefore(
  pointerDownSection,
  "isEditorInteractionLocked()",
  "syncEditorHoverFromPointerEvent(event)",
  "locked editor input must be rejected before any scene pick"
);

const contextMenuSection = sourceSection(
  authorSource,
  "function handleGridContextMenu",
  "function handleDocumentGridContextMenu"
);
assert.match(contextMenuSection, /isEditorInteractionLocked\(\)/);
assert.match(
  contextMenuSection,
  /target\.kind === "levelSwitch"/,
  "right-clicking a neighboring room must not eyedrop the current room at matching coordinates"
);
assertBefore(
  contextMenuSection,
  'target.kind === "levelSwitch"',
  "selectCell(x, y)",
  "neighbor-room targets must be rejected before selection"
);

const paintPlacementSection = sourceSection(
  authorSource,
  "function paintPuncherTarget",
  "function paintFaceTargetOnce"
);
assert.match(
  paintPlacementSection,
  /placeCellElevationTokenIfVacant\(/,
  "brush painting must use the additive, non-replacing elevation writer"
);
assert.doesNotMatch(
  paintPlacementSection,
  /setCellElevationToken\(/,
  "brush painting must not call the replacing elevation writer"
);

const dragPlaneSection = sourceSection(
  authorSource,
  "function paintDragPlaneForTarget",
  "function resizeLevel"
);
const paintDragPlaneSection = sourceSection(
  authorSource,
  "function paintDragPlaneForTarget",
  "function canDragPaintTarget"
);
assert.doesNotMatch(
  paintDragPlaneSection,
  /target\.face !== "top"/,
  "starting a paint stroke on a side face must still create a swipe plane"
);
assert.match(
  dragPlaneSection,
  /if \(layer !== state\.paintDragPlane\.layer\) \{\s*return false;/,
  "a swipe must remain on the elevation captured at pointer-down"
);
assert.doesNotMatch(
  dragPlaneSection,
  /target\.face !== state\.paintDragPlane\.face/,
  "a same-layer side face must not be rejected merely because the stroke began on top"
);

const sideStartState = {
  paintDragPlane: null,
  selectedToken: "W"
};
const paintDragPlaneForTarget = vm.runInNewContext(
  `(${paintDragPlaneSection.trim()})`,
  {
    canDragEraseFromTarget: (target) =>
      sideStartState.selectedToken !== "__erase_top__" || target.face === "top",
    eraserToken: "__erase_top__",
    noopToken: "__select_only__",
    paintGestureLayerForTarget: (target) => target.paintLayer,
    state: sideStartState
  }
);
assert.deepEqual(
  { ...paintDragPlaneForTarget({ face: "right", kind: "terrain", paintLayer: 2 }) },
  { layer: 2 },
  "pointer-down on a side must arm a same-layer paint swipe"
);
sideStartState.selectedToken = "__erase_top__";
assert.equal(
  paintDragPlaneForTarget({ face: "right", kind: "terrain", paintLayer: 2 }),
  null,
  "side-start erasing must retain its top-face safety restriction"
);
sideStartState.selectedToken = "W";
assert.match(
  dragPlaneSection,
  /const justPaintedVoxelKey[\s\S]*highlightedVoxelKey === justPaintedVoxelKey[\s\S]*paintStrokePaintedVoxelKeys\.clear\(\)/,
  "the immediately painted voxel guard must remain latched until the highlight moves to another voxel"
);
const paintOnceSection = sourceSection(
  authorSource,
  "function paintFaceTargetOnce",
  "function canDragEraseFromTarget"
);
assert.match(
  paintOnceSection,
  /state\.paintStrokePaintedVoxelKeys\.add\(voxelKey\)/,
  "successful paint targets must be tracked for safe side-face continuation"
);
assertBefore(
  paintOnceSection,
  "state.paintStrokePaintedVoxelKeys.clear()",
  "state.paintStrokePaintedVoxelKeys.add(voxelKey)",
  "only the most recently painted voxel should remain blocked as a side-face source"
);
assert.match(
  paintOnceSection,
  /voxelKey && !isBaseSurfaceToken\(state\.selectedToken\)/,
  "flat base-surface edits must not mark a pre-existing wall as newly created"
);

const dragState = {
  levelId: "level_AxA",
  paintDragPlane: { layer: 2 },
  paintStrokeLevelId: "level_AxA",
  paintStrokePaintedVoxelKeys: new Set(),
  paintStrokeToken: "W",
  selectedToken: "W"
};
const canDragPaintTarget = vm.runInNewContext(
  `(${sourceSection(authorSource, "function canDragPaintTarget", "function resizeLevel").trim()})`,
  {
    canDragEraseFromTarget: () => false,
    eraserToken: "__erase_top__",
    isInsideEditorCell: (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < 4 && y < 4,
    paintGestureLayerForTarget: (target) => target.paintLayer,
    paintVoxelKeyForTarget: (target, useSource) =>
      useSource
        ? `${target.sourceX}:${target.sourceY}:${target.sourceLayer}`
        : `${target.paintX}:${target.paintY}:${target.paintLayer}`,
    state: dragState
  }
);
const sameLayerSideTarget = {
  face: "right",
  kind: "terrain",
  paintLayer: 2,
  paintX: 2,
  paintY: 1,
  sourceLayer: 2,
  sourceX: 1,
  sourceY: 1
};

assert.equal(canDragPaintTarget(sameLayerSideTarget), true);
dragState.paintStrokePaintedVoxelKeys.add("1:1:2");
assert.equal(canDragPaintTarget(sameLayerSideTarget), false);
assert.equal(dragState.paintStrokePaintedVoxelKeys.size, 1);
assert.equal(
  canDragPaintTarget(sameLayerSideTarget),
  false,
  "repeated samples on the newly painted side must remain blocked"
);
assert.equal(
  canDragPaintTarget({
    ...sameLayerSideTarget,
    paintLayer: 1,
    sourceX: 3
  }),
  false,
  "a different highlighted voxel releases the latch even when that sample is off-plane"
);
assert.equal(dragState.paintStrokePaintedVoxelKeys.size, 0);
assert.equal(
  canDragPaintTarget(sameLayerSideTarget),
  true,
  "the previously painted voxel becomes a valid source after the highlight has left it"
);
dragState.paintStrokePaintedVoxelKeys.add("3:1:2");
assert.equal(
  canDragPaintTarget({
    ...sameLayerSideTarget,
    paintX: 2,
    sourceX: 3
  }),
  false,
  "the immediately preceding painted voxel cannot grow another voxel from its side"
);
assert.equal(dragState.paintStrokePaintedVoxelKeys.size, 1);
assert.equal(
  canDragPaintTarget({
    ...sameLayerSideTarget,
    face: "top",
    paintX: 3,
    sourceX: 3
  }),
  false,
  "the top face of the newly painted voxel must be blocked just like a side face"
);
assert.equal(canDragPaintTarget(null), false);
assert.equal(
  dragState.paintStrokePaintedVoxelKeys.size,
  1,
  "a raycast miss must not release the latch before another voxel is highlighted"
);

const puncherPlacementSection = sourceSection(
  authorSource,
  "function paintPuncherTarget",
  "function paintOrangeButtonTarget"
);
assert.match(
  puncherPlacementSection,
  /const targetLayer = adjustedPaintLayerForTarget\(target\)/,
  "punchers painted from a tall side must use the resolved side layer"
);
assert.doesNotMatch(
  puncherPlacementSection,
  /Number\(target\.sourceLayer\)/,
  "puncher placement must not collapse a tall side hit back to its erase/source layer"
);

const updateCellSection = sourceSection(
  authorSource,
  "function updateCellValue",
  "function updateCellsForSingleMainPlayerPlacement"
);
assert.match(
  updateCellSection,
  /if \(!isPaintStrokeActive\(\) \|\| !state\.paintStrokeDidPaint\) \{\s*pushUndoSnapshot/,
  "a swipe should capture one undo snapshot instead of one per painted cell"
);

const undoSection = sourceSection(
  authorSource,
  "function undoLastEdit",
  "function escapeHtml"
);
assert.match(
  undoSection,
  /if \(isEditorInteractionLocked\(\)\) \{\s*return false;/,
  "keyboard undo must not mutate the outgoing board while a room is loading"
);

const loadSection = sourceSection(
  authorSource,
  "async function loadLevel",
  "async function saveLevel"
);

const unsavedPromptSection = sourceSection(
  authorSource,
  "let unsavedPromptResolve",
  "async function fetchAuthorLevelPayload"
);
assert.match(unsavedPromptSection, /function promptForUnsavedChanges\(options = \{\}\)/);
assert.match(unsavedPromptSection, /function installUnsavedNavigationGuards\(\)/);
assert.match(unsavedPromptSection, /\.author-nav a, \.build-mobile-blocker__actions a/);
assert.match(unsavedPromptSection, /await saveLevel\(\{ refreshPreview: false \}\)/);
assert.match(unsavedPromptSection, /window\.location\.assign\(link\.href\)/);
assert.match(
  unsavedPromptSection,
  /function cachedAuthorLevelPayload\(levelId\)/
);
assert.match(
  authorSource,
  /const cachedPayload = cachedAuthorLevelPayload\(levelId\);\s*if \(cachedPayload\) \{\s*return cachedPayload;/
);

assert.doesNotMatch(authorSource, /discardLabel|Use Saved Version|Leave Without Saving/);
assert.match(
  authorSource,
  /\(hostedWorldDraftMode \? "This world" : "This room"\)[\s\S]*has unsaved changes\. Save before publishing\?/,
  "hosted navigation guards should describe the complete unsaved world draft"
);
assert.match(authorSource, /if \(choice === "cancel"\) \{\s*return \{ cancelled: true, ok: false \};/);
assert.match(authorSource, /installUnsavedNavigationGuards\(\)/);
assert.match(authorSource, /if \(!state\.isDirty \|\| allowDirtyUnload\)/);
assertBefore(
  loadSection,
  "window.clearTimeout(currentLevelThumbTimer)",
  "await fetchAuthorLevelPayload(levelId)",
  "discarding a room must cancel its delayed thumbnail before loading another room"
);

const switchSection = sourceSection(
  authorSource,
  "async function switchToNeighborLevel",
  "function formatSolverPath"
);
const backgroundThumbSection = sourceSection(
  authorSource,
  "async function primeLocalWorldThumbs",
  "function createPalettePreviewPlayData"
);
assert.match(
  backgroundThumbSection,
  /persist:\s*clientPreviewPersistence\s*&&\s*!level\.previewUrl/,
  "hosted editors must be able to keep editor-boot thumbnails local"
);
assert.match(
  authorSource,
  /const clientPreviewPersistence = authorData\.clientPreviewPersistence !== false/,
  "preview persistence must default on for the local author server"
);
assert.match(
  authorSource,
  /disableHorizontalNeighborFetches: hostedWorldDraftMode/,
  "hosted editors must render their complete local world without issuing neighbor API reads"
);
assert.match(switchSection, /cancelScheduledPointerMove\(\)/);
assert.match(switchSection, /finishPainting\(/);
assert.doesNotMatch(
  switchSection,
  /Math\.sign\(resolvedTarget\.(?:dx|dy)\)/,
  "far-room world-map flights must preserve their full room delta"
);
assert.match(
  switchSection,
  /const roomDistance = Math\.hypot\(dx, dy\)/,
  "far-room camera duration should scale with world distance"
);
assertBefore(
  switchSection,
  "cancelScheduledPointerMove()",
  "await saveLevel(",
  "queued pointer work must be canceled before the asynchronous room switch begins"
);
assertBefore(
  switchSection,
  "finishPainting(",
  "await saveLevel(",
  "an active stroke must finish before the asynchronous room switch begins"
);
assert.match(
  switchSection,
  /finishPainting\(\);\s*const outgoingWasDirty = state\.isDirty;/
);
assert.match(
  switchSection,
  /if \(hostedWorldDraftMode\) \{[\s\S]*stageCurrentHostedWorldLevel\(\)/,
  "hosted room switches must stage the outgoing room in the browser"
);
assert.match(
  switchSection,
  /if \(!hostedWorldDraftMode && outgoingWasDirty\) \{\s*const savedPayload = await saveLevel\(/
);
assert.doesNotMatch(
  switchSection,
  /Saved and switched/,
  "room navigation must not imply that a hosted draft was persisted"
);
assert.match(
  switchSection,
  /\{ persist: clientPreviewPersistence \}/,
  "host capability must control the post-save preview mutation"
);
assert.doesNotMatch(
  switchSection,
  /\{ persist: true \}/,
  "ordinary room switching must not issue a second thumbnail mutation"
);
assert.match(
  switchSection,
  /const pendingPayload = await fetchAuthorLevelPayload\(nextLevelId\)/
);
assertBefore(
  switchSection,
  "stageCurrentHostedWorldLevel()",
  "await fetchAuthorLevelPayload(nextLevelId)",
  "the outgoing browser draft must be staged before loading the next room"
);

const hostedSaveSection = sourceSection(
  authorSource,
  "function hostedWorldEditorStateSnapshot",
  "async function saveLevel"
);
assert.match(
  hostedSaveSection,
  /levels: hostedWorldLevelEntries\(\)[\s\S]*\.filter\(\(level\) => level\.exists \|\| hostedDirtyLevelIds\.has\(level\.id\)\)[\s\S]*\.map/,
  "whole-world Save should include every saved or newly edited room without materializing untouched blanks"
);
assert.match(hostedSaveSection, /stageCurrentHostedWorldLevel\(\)/);
assert.match(
  hostedSaveSection,
  /fetch\(authorData\.worldMeta\.apiUrl,[\s\S]*editor_state: editorState[\s\S]*method: "PATCH"/,
  "the explicit hosted Save must persist one complete world snapshot"
);
assert.match(
  authorSource,
  /async function saveLevel\(options = \{\}\) \{\s*if \(hostedWorldDraftMode\) \{\s*return saveHostedWorldDraft\(options\);/,
  "the Save button must dispatch to the whole-world hosted save"
);

const hostedCameraSection = sourceSection(
  authorSource,
  "function landEditorOnWholeWorld",
  "// The construction-then-dive"
);
assert.match(hostedCameraSection, /app\.cameraFlightFitOptions = editorWorldFitOptions\(app\)/);
assert.match(hostedCameraSection, /tilt: 0\.42/);
assert.match(hostedCameraSection, /zoom: 1/);
assert.match(
  rendererSource,
  /if \(app\.editorWorldView === true\) \{[\s\S]*normalizedCameraFitOptions\([\s\S]*app\.cameraFlightFitOptions,[\s\S]*stableCameraWorldHeight\(\)[\s\S]*return wholeWorldFit/,
  "hosted editor rendering must fit the supplied whole-world bounds instead of the current room"
);
assert.match(
  authorSource,
  /if \(landEditorOnWholeWorld\(app\)\) \{[\s\S]*revealEditorWorld\(\);[\s\S]*return;[\s\S]*editorDiveIntoRoom/,
  "hosted editor boot must stay on the whole-world fit instead of diving into one room"
);
const renderLoadedSection = sourceSection(
  authorSource,
  "function renderLoadedLevelWithoutScene",
  "async function switchToNeighborLevel"
);
assert.match(
  renderLoadedSection,
  /window\.history\.replaceState\([\s\S]*authorUrlForLevel\(state\.levelId\)/,
  "hosted room switches must keep the world-scoped editor URL"
);
const transitionStart = switchSection.indexOf("startLevelTransition(");
const onComplete = switchSection.indexOf("onComplete:", transitionStart);
const commitPayload = switchSection.indexOf(
  "renderLoadedLevelWithoutScene(pendingPayload",
  onComplete
);
assert.ok(transitionStart >= 0, "room switch must start the scene transition");
assert.ok(onComplete > transitionStart, "room switch transition must provide an onComplete callback");
assert.ok(
  commitPayload > onComplete,
  "the incoming editor payload must not become editable until the transition completes"
);

const incomingOffsetSection = sourceSection(
  rendererSource,
  "function transitionIncomingOffset",
  "function renderLevelStateAt"
);
assert.match(incomingOffsetSection, /dx \* incomingState\.width \* unit/);
assert.match(incomingOffsetSection, /dx \* outgoingState\.width \* unit/);
assert.match(incomingOffsetSection, /dy \* incomingState\.height \* unit/);
assert.match(incomingOffsetSection, /dy \* outgoingState\.height \* unit/);

const worldMapClickSection = sourceSection(
  authorSource,
  'if (elements.existingLevels) {',
  'window.addEventListener("beforeunload"'
);
assert.match(worldMapClickSection, /handleWorldMapSwapSelection\(nextLevelId\)/);
assertBefore(
  worldMapClickSection,
  "handleWorldMapSwapSelection(nextLevelId)",
  "switchToLevelId(nextLevelId)",
  "swap mode must consume room clicks before normal world-map navigation"
);
assert.match(worldMapClickSection, /switchToLevelId\(nextLevelId\)/);
assert.doesNotMatch(worldMapClickSection, /loadLevel\(nextLevelId\)/);
assert.equal(
  switchSection
    .slice(transitionStart, onComplete)
    .includes("renderLoadedLevelWithoutScene(pendingPayload"),
  false,
  "incoming editor state must not be committed before the transition callback"
);

const roomSwapSection = sourceSection(
  authorSource,
  "async function swapWorldRooms",
  "function handleWorldMapSwapSelection"
);
assertBefore(
  roomSwapSection,
  "await saveLevel(",
  "fetch(authorData.roomSwapApiUrl",
  "unsaved room edits must be persisted before the world mapping changes"
);
assert.match(roomSwapSection, /firstLevelId, secondLevelId/);
assert.match(roomSwapSection, /window\.location\.assign\(authorUrlForLevel\(nextLevelId\)\)/);

const pointerSchedulerSection = sourceSection(
  authorSource,
  "function pointerSamplesForMoveEvent",
  "function cancelScheduledPointerMove"
);
let scheduledPointerFrame = null;
const pointerSchedulerState = { paintPointerId: 7 };
const schedulePointerMove = vm.runInNewContext(
  `(() => { ${pointerSchedulerSection} return schedulePointerMove; })()`,
  {
    pointerMoveScheduler: { frameId: null, samples: [] },
    pointerPaintSamplesPerFrameLimit: 16,
    state: pointerSchedulerState,
    window: {
      requestAnimationFrame(callback) {
        scheduledPointerFrame = callback;
        return 1;
      }
    }
  }
);
const processedPointerSamples = [];
const pointerProcessor = (event) => processedPointerSamples.push(event.clientX);
schedulePointerMove(
  {
    buttons: 1,
    clientX: 20,
    clientY: 20,
    getCoalescedEvents: () => [
      { buttons: 1, clientX: 10, clientY: 20, pointerId: 7 },
      { buttons: 1, clientX: 20, clientY: 20, pointerId: 7 }
    ],
    pointerId: 7
  },
  pointerProcessor
);
schedulePointerMove(
  { buttons: 1, clientX: 30, clientY: 20, pointerId: 7 },
  pointerProcessor
);
scheduledPointerFrame();
assert.deepEqual(
  processedPointerSamples,
  [10, 20, 30],
  "all distinct active-stroke samples queued before a frame must be processed in order"
);

processedPointerSamples.length = 0;
pointerSchedulerState.paintPointerId = null;
schedulePointerMove(
  { buttons: 0, clientX: 40, clientY: 20, pointerId: 7 },
  pointerProcessor
);
schedulePointerMove(
  { buttons: 0, clientX: 50, clientY: 20, pointerId: 7 },
  pointerProcessor
);
scheduledPointerFrame();
assert.deepEqual(
  processedPointerSamples,
  [50],
  "hover-only pointer movement should remain latest-only"
);

const finishPaintingSection = sourceSection(
  authorSource,
  "function finishPainting",
  "function stopPainting"
);
assertBefore(
  finishPaintingSection,
  "flushScheduledPointerMoves()",
  "const didPaint = state.paintStrokeDidPaint",
  "queued tail samples must run before the stroke's final painted state is captured"
);
assertBefore(
  finishPaintingSection,
  "flushScheduledPointerMoves()",
  "state.paintPointerId = null",
  "queued tail samples must run while the active pointer and drag plane still exist"
);

let queuedFinishFrame = null;
let canceledFinishFrames = 0;
let releasedPointerId = null;
let flushedPaintSamples = 0;
const finishScheduler = { frameId: null, samples: [] };
const finishState = {
  eraseGestureMode: null,
  lastPaintTargetKey: "pending",
  paintDragPlane: { layer: 2 },
  paintPointerId: 7,
  paintStrokeDidPaint: false,
  paintStrokeLevelId: "level_AxA",
  paintStrokePaintedVoxelKeys: new Set(["1:1:2"]),
  paintStrokeToken: "W"
};
const finishSchedulerTools = vm.runInNewContext(
  `(() => { ${sourceSection(
    authorSource,
    "function pointerSamplesForMoveEvent",
    "function processGridPointerMove"
  )} return { schedulePointerMove, flushScheduledPointerMoves }; })()`,
  {
    pointerMoveScheduler: finishScheduler,
    pointerPaintSamplesPerFrameLimit: 16,
    state: finishState,
    window: {
      cancelAnimationFrame() {
        canceledFinishFrames += 1;
      },
      requestAnimationFrame(callback) {
        queuedFinishFrame = callback;
        return 12;
      }
    }
  }
);
finishSchedulerTools.schedulePointerMove(
  { buttons: 1, clientX: 40, clientY: 20, pointerId: 7 },
  () => {
    assert.equal(finishState.paintPointerId, 7);
    assert.deepEqual(finishState.paintDragPlane, { layer: 2 });
    finishState.paintStrokeDidPaint = true;
    flushedPaintSamples += 1;
  }
);
const finishPainting = vm.runInNewContext(`(${finishPaintingSection.trim()})`, {
  cancelScheduledEditorSceneRender() {},
  elements: {
    grid: {
      hasPointerCapture: () => true,
      releasePointerCapture(pointerId) {
        releasedPointerId = pointerId;
      }
    }
  },
  flushScheduledPointerMoves: finishSchedulerTools.flushScheduledPointerMoves,
  renderGrid() {},
  renderRawOutput() {},
  renderSelectedCell() {},
  state: finishState,
  syncSolverButtonState() {}
});
assert.equal(finishPainting(7), true);
assert.equal(flushedPaintSamples, 1);
assert.equal(canceledFinishFrames, 1);
assert.equal(releasedPointerId, 7);
assert.equal(finishScheduler.frameId, null);
assert.equal(finishScheduler.samples.length, 0);
assert.equal(finishState.paintPointerId, null);
assert.equal(finishState.paintDragPlane, null);
assert.equal(finishState.paintStrokePaintedVoxelKeys.size, 0);
queuedFinishFrame();
assert.equal(flushedPaintSamples, 1, "a canceled rAF must not replay flushed paint samples");

const rendererPickSection = sourceSection(
  rendererSource,
  "function pickEditorFace",
  "function editorHighlightPlaneGeometry"
);
for (const bound of [
  "clientX < rect.left",
  "clientX >= rect.right",
  "clientY < rect.top",
  "clientY >= rect.bottom"
]) {
  assert.ok(
    rendererPickSection.includes(bound),
    `3D editor picking must enforce the half-open canvas bound: ${bound}`
  );
  assertBefore(
    rendererPickSection,
    bound,
    "raycaster.setFromCamera",
    "out-of-viewport coordinates must be rejected before raycasting"
  );
}

const terrainPolycubePickSection = sourceSection(
  rendererSource,
  "function addTerrainPolycubeComponent",
  "function addTerrainPolycubeRegions"
);
assert.match(
  terrainPolycubePickSection,
  /occupiedLayers: new Set\(\)/,
  "merged terrain picks must retain the occupied layers of each individual cell"
);
assert.match(terrainPolycubePickSection, /occupiedLayers\.add\(voxel\.z\)/);

const weightlessPolycubePickSection = sourceSection(
  rendererSource,
  "const renderPolycubeComponent =",
  "const renderPolycubeGroup ="
);
assert.match(
  weightlessPolycubePickSection,
  /occupiedLayers\.add\(logicalLayer\)/,
  "weightless picks must retain per-cell logical layers independent of visual transforms"
);

const editorPickCellForPoint = vm.runInNewContext(
  `(${sourceSection(
    rendererSource,
    "function editorPickCellForPoint",
    "function editorVoxelLayerAt"
  ).trim()})`,
  { unit: 64 }
);
const rowCells = [
  { gridX: 0, gridY: 0, left: 0, right: 64, top: 0, bottom: 64 },
  { gridX: 0, gridY: 1, left: 0, right: 64, top: 64, bottom: 128 }
];
assert.equal(
  editorPickCellForPoint(
    { cells: rowCells },
    { x: 64, z: 65 },
    { x: 1, z: 0 }
  ).gridY,
  1,
  "side picks just beyond a row seam must resolve to the row under the pointer"
);
assert.equal(
  editorPickCellForPoint(
    { cells: rowCells },
    { x: 64, z: 64 },
    { x: 1, z: 0 }
  ).gridY,
  1,
  "half-open side bounds must resolve an exact seam deterministically"
);

const columnCells = [
  { gridX: 0, gridY: 0, left: 0, right: 64, top: 0, bottom: 64 },
  { gridX: 1, gridY: 0, left: 64, right: 128, top: 0, bottom: 64 }
];
assert.equal(
  editorPickCellForPoint(
    { cells: columnCells },
    { x: 65, z: 64 },
    { x: 0, z: 1 }
  ).gridX,
  1,
  "side picks just beyond a column seam must resolve to the column under the pointer"
);

const editorVoxelLayerAt = vm.runInNewContext(
  `(${sourceSection(
    rendererSource,
    "function editorVoxelLayerAt",
    "function editorCellOccupiedLayers"
  ).trim()})`,
  { actorVisualLift: 0, unit: 64 }
);
assert.equal(editorVoxelLayerAt(127.9995, "side"), 1);
assert.equal(editorVoxelLayerAt(128, "side"), 2);
assert.equal(
  editorVoxelLayerAt(128.0005, "side"),
  2,
  "a side hit just above a layer seam must not be biased into the layer below"
);

const editorCellOccupiedLayers = vm.runInNewContext(
  `(${sourceSection(
    rendererSource,
    "function editorCellOccupiedLayers",
    "function editorSideLayerRange"
  ).trim()})`
);
const editorSideLayerRange = vm.runInNewContext(
  `(${sourceSection(
    rendererSource,
    "function editorSideLayerRange",
    "function editorSidePaintLayerAt"
  ).trim()})`,
  { actorVisualLift: 0, editorVoxelLayerAt, unit: 64 }
);
const editorSidePaintLayerAt = vm.runInNewContext(
  `(${sourceSection(
    rendererSource,
    "function editorSidePaintLayerAt",
    "function editorSidePaintLayerCandidatesAt"
  ).trim()})`,
  { editorCellOccupiedLayers, editorSideLayerRange }
);
const editorSidePaintLayerCandidatesAt = vm.runInNewContext(
  `(${sourceSection(
    rendererSource,
    "function editorSidePaintLayerCandidatesAt",
    "function editorVoxelLayerBounds"
  ).trim()})`,
  { editorCellOccupiedLayers, editorSideLayerRange, editorSidePaintLayerAt, unit: 64 }
);
const tallPick = { bottomY: 128, topY: 320, sourceLayer: 2 };
assert.equal(
  editorSidePaintLayerAt(tallPick, 272, 2),
  4,
  "a tall object's upper side must paint at the hit height, not its base layer"
);
assert.equal(editorSidePaintLayerAt(tallPick, 400, 2), 4);
assert.equal(
  editorSidePaintLayerAt({ ...tallPick, topY: 320.000001 }, 320.0000005, 2),
  4,
  "floating-point noise at an exact top seam must not create a phantom layer"
);
assert.equal(
  editorSidePaintLayerAt({ bottomY: 128, topY: 148.48, sourceLayer: 2 }, 145, 2),
  2,
  "a thin elevated object must keep side painting in its occupied layer"
);
assert.deepEqual(
  Array.from(
    editorSidePaintLayerCandidatesAt({ bottomY: 64, topY: 192 }, 128.0005)
  ).sort(),
  [1, 2],
  "both stacked layers must remain eligible at their shared side seam"
);

const editorVoxelLayerBounds = vm.runInNewContext(
  `(${sourceSection(
    rendererSource,
    "function editorVoxelLayerBounds",
    "function pickEditorFace"
  ).trim()})`,
  { actorVisualLift: 0, unit: 64 }
);

function runEditorFacePick(pick, point, faceNormal) {
  const targetElement = {
    getBoundingClientRect: () => ({
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100
    })
  };
  const intersectionObject = {
    matrixWorld: {},
    userData: { editorPick: pick }
  };
  const transformedNormal = {
    x: faceNormal.x,
    y: faceNormal.y,
    z: faceNormal.z,
    transformDirection() {
      return this;
    }
  };
  const context = {
    THREE: {
      Vector2: class Vector2 {
        constructor(x, y) {
          this.x = x;
          this.y = y;
        }
      }
    },
    actorVisualLift: 0,
    app: { canvas: targetElement },
    camera: {},
    editorCellOccupiedLayers,
    editorPickCellForPoint,
    editorPickableMeshes: () => [intersectionObject],
    editorSidePaintLayerCandidatesAt,
    editorSidePaintLayerAt,
    editorSideLayerRange,
    editorVoxelLayerAt,
    editorVoxelLayerBounds,
    raycaster: {
      intersectObjects: () => [
        {
          face: {
            normal: {
              clone: () => transformedNormal
            }
          },
          object: intersectionObject,
          point
        }
      ],
      setFromCamera() {}
    },
    scene: {},
    unit: 64
  };
  const pickEditorFace = vm.runInNewContext(`(${rendererPickSection.trim()})`, context);

  return pickEditorFace(50, 50, targetElement);
}

const singleCell = {
  gridX: 1,
  gridY: 1,
  left: 64,
  right: 128,
  top: 64,
  bottom: 128
};
const seamSideTarget = runEditorFacePick(
  {
    bottomY: 64,
    cells: [singleCell],
    kind: "terrain",
    topY: 192,
    voxelPick: true
  },
  { x: 128, y: 128.0005, z: 96 },
  { x: 1, y: 0, z: 0 }
);
assert.equal(seamSideTarget.sourceLayer, 2);
assert.equal(seamSideTarget.paintLayer, 2);
assert.equal(seamSideTarget.bottomY, 128);
assert.equal(seamSideTarget.topY, 192);
assert.deepEqual(Array.from(seamSideTarget.paintLayerCandidates).sort(), [1, 2]);

const isolatedTopEdgeTarget = runEditorFacePick(
  {
    bottomY: 64,
    cells: [singleCell],
    kind: "terrain",
    topY: 128,
    voxelPick: true
  },
  { x: 128, y: 128, z: 96 },
  { x: 1, y: 0, z: 0 }
);
assert.equal(
  isolatedTopEdgeTarget.paintLayer,
  1,
  "an isolated voxel's top edge must clamp to its real side layer"
);
assert.deepEqual(Array.from(isolatedTopEdgeTarget.paintLayerCandidates), [1]);

const shortLShapeCell = { ...singleCell, occupiedLayers: [0] };
const shortLShapeSideTarget = runEditorFacePick(
  {
    bottomY: 0,
    cells: [shortLShapeCell],
    kind: "terrain",
    topY: 128,
    voxelPick: true
  },
  { x: 128, y: 64, z: 96 },
  { x: 1, y: 0, z: 0 }
);
assert.equal(
  shortLShapeSideTarget.paintLayer,
  0,
  "a short column in a merged L-shape must not borrow its neighbor's upper layer"
);
assert.deepEqual(Array.from(shortLShapeSideTarget.paintLayerCandidates), [0]);
assert.deepEqual(Array.from(shortLShapeSideTarget.sourceLayerCandidates), [0]);
const shortLShapeTopTarget = runEditorFacePick(
  {
    bottomY: 0,
    cells: [shortLShapeCell],
    kind: "terrain",
    topY: 128,
    voxelPick: true
  },
  { x: 96, y: 64, z: 96 },
  { x: 0, y: 1, z: 0 }
);
assert.equal(shortLShapeTopTarget.sourceLayer, 0);
assert.equal(shortLShapeTopTarget.paintLayer, 1);

const transformedVoxelTopTarget = runEditorFacePick(
  {
    bottomY: 80,
    cells: [{ ...singleCell, occupiedLayers: [2] }],
    kind: "actor",
    logicalBottomLayer: 2,
    logicalLayerCount: 1,
    topY: 144,
    voxelPick: true
  },
  { x: 96, y: 144, z: 96 },
  { x: 0, y: 1, z: 0 }
);
assert.equal(transformedVoxelTopTarget.sourceLayer, 2);
assert.equal(
  transformedVoxelTopTarget.paintLayer,
  3,
  "a vertically transformed voxel top must use its logical layer, not raw world Y"
);

const tallSideTarget = runEditorFacePick(
  {
    ...tallPick,
    cells: [singleCell],
    kind: "terrain"
  },
  { x: 128, y: 272, z: 96 },
  { x: 1, y: 0, z: 0 }
);
assert.equal(tallSideTarget.sourceLayer, 2, "erase identity remains at the tall object's base");
assert.equal(tallSideTarget.paintLayer, 4, "side placement uses the sliced hit layer");
assert.equal(tallSideTarget.bottomY, 256, "hover bounds show only the selected side slice");
assert.equal(tallSideTarget.topY, 320);

dragState.paintDragPlane = { layer: 4 };
assert.equal(
  canDragPaintTarget(tallSideTarget),
  true,
  "a pre-existing tall side is eligible when its sliced layer matches the swipe"
);
dragState.paintStrokePaintedVoxelKeys.add("1:1:2");
assert.equal(
  canDragPaintTarget(tallSideTarget),
  false,
  "the tall object's base identity still prevents chaining from an immediately painted object"
);
dragState.paintStrokePaintedVoxelKeys.clear();
dragState.paintDragPlane = { layer: 2 };

const sunkLogicalTarget = runEditorFacePick(
  {
    bottomY: 127,
    cells: [singleCell],
    kind: "actor",
    logicalBottomLayer: 2,
    logicalLayerCount: 1,
    logicalSourceFollowsPaint: true,
    sourceLayer: 2,
    topY: 191
  },
  { x: 128, y: 127.5, z: 96 },
  { x: 1, y: 0, z: 0 }
);
assert.equal(sunkLogicalTarget.sourceLayer, 2);
assert.equal(
  sunkLogicalTarget.paintLayer,
  2,
  "visual sink must not drag a weightless block into the logical layer below"
);
const sunkLogicalTopTarget = runEditorFacePick(
  {
    bottomY: 127,
    cells: [singleCell],
    kind: "actor",
    logicalBottomLayer: 2,
    logicalLayerCount: 1,
    logicalSourceFollowsPaint: true,
    sourceLayer: 2,
    topY: 147.48
  },
  { x: 96, y: 147.48, z: 96 },
  { x: 0, y: 1, z: 0 }
);
assert.equal(sunkLogicalTopTarget.sourceLayer, 2);
assert.equal(
  sunkLogicalTopTarget.paintLayer,
  3,
  "a thin elevated actor's top must paint in the next logical slot"
);

const adjustedPaintLayerForTarget = vm.runInNewContext(
  `(${sourceSection(
    authorSource,
    "function adjustedPaintLayerForTarget",
    "function paintPuncherTarget"
  ).trim()})`,
  {
    eraserToken: "__erase_top__",
    isBaseSurfaceToken: () => false,
    noopToken: "__select_only__",
    state: {
      paintDragPlane: { layer: 1 },
      selectedToken: "W"
    }
  }
);
assert.equal(
  adjustedPaintLayerForTarget(seamSideTarget),
  1,
  "the frozen swipe layer must disambiguate a shared horizontal side seam"
);
const seamSourceVoxelKey = vm.runInNewContext(
  `(${sourceSection(
    authorSource,
    "function paintVoxelKeyForTarget",
    "function canDragEraseFromTarget"
  ).trim()})`,
  {
    eraserToken: "__erase_top__",
    isInsideEditorCell: (x, y) => x >= 0 && y >= 0 && x < 4 && y < 4,
    paintGestureLayerForTarget: adjustedPaintLayerForTarget,
    state: {
      paintDragPlane: { layer: 1 },
      selectedToken: "W"
    }
  }
);
assert.equal(
  seamSourceVoxelKey(seamSideTarget, true),
  "1:1:1",
  "anti-cascade source identity must follow the frozen layer at an ambiguous seam"
);

console.log("author-editor-interactions: OK");
