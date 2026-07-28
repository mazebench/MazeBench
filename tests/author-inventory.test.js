const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadBrowserScript } = require("./helpers/browser-module-loader");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "author.js"), "utf8");

function sourceSection(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const auxiliarySection = sourceSection(
  "function createAuxiliaryRenderApp",
  "function demoPlayData"
);
assert.match(auxiliarySection, /hostFullBleedView: true/);
assert.match(auxiliarySection, /playStage: hostFrame/);
assert.match(auxiliarySection, /mazeFrame: hostFrame/);
assert.match(auxiliarySection, /app\.MOVE_DURATION_MS = 220/);
assert.match(auxiliarySection, /app\.state\.effects\.fuzzyEnabled = false/);
assert.match(auxiliarySection, /app\.state\.effects\.noisePhase = 0/);

const detailSection = sourceSection(
  "function renderInventoryDetail",
  "function isInventoryOpen"
);
assert.doesNotMatch(detailSection, /stage\.className\s*=/);
assert.match(detailSection, /stage\.classList\.remove\(\.\.\.INVENTORY_DEMO_CLASSES\)/);

const demoDataSection = sourceSection("function demoPlayData", "function demoSceneForTool");
assert.match(demoDataSection, /levelId: "__toolbox_demo_"/);
assert.doesNotMatch(demoDataSection, /levelId: "level_AxA"/);

const demoRunSection = sourceSection("async function runDemoScene", "Canonical world-map thumbnails");
assert.match(demoRunSection, /!app\.isAnimating/);
assert.match(demoRunSection, /if \(scene\.ambient\)/);
assert.doesNotMatch(demoRunSection, /scene\.orbit/);
assert.doesNotMatch(demoRunSection, /durationMs:/);
assert.match(demoRunSection, /is-demo-resetting/);

const configuredDemoSection = sourceSection(
  "function configuredDemoSceneForTool",
  "const demoSceneRenderer"
);
assert.match(configuredDemoSection, /\.split\("\$"\)/);
assert.match(configuredDemoSection, /replace\(\/\[\^UDLR\]\/g, ""\)/);
assert.match(configuredDemoSection, /const configuredScene = configuredDemoSceneForTool\(tool\)/);

const thumbnailSection = sourceSection(
  "async function renderLevelThumbFromCells",
  "function scheduleCurrentLevelThumbRefresh"
);
assert.match(thumbnailSection, /levelId: "__author_thumbnail_"/);
assert.match(thumbnailSection, /options\.persist === true/);
assert.match(thumbnailSection, /await persistLevelThumb\(levelId, url\)/);

const thumbnailUploadSection = sourceSection(
  "async function persistLevelThumb",
  "async function renderLevelThumbFromCells"
);
assert.match(thumbnailUploadSection, /authorData\.previewApiBaseUrl/);
assert.match(thumbnailUploadSection, /method: "POST"/);

const levelMapSection = sourceSection(
  "function renderExistingLevels",
  "function renderAll"
);
assert.match(levelMapSection, /preview[\s\S]*?author-level-pill__thumb/);
assert.match(levelMapSection, /: '<span class="author-level-pill__label">'/);
assert.match(levelMapSection, /renderStartRoomGrid\(\)/);

const startRoomSection = sourceSection(
  "// Details: a compact pixel map chooses the room the world boots into.",
  "// Publish gate: the page's publish button"
);
assert.match(startRoomSection, /document\.getElementById\("world-start-grid"\)/);
assert.match(startRoomSection, /className = "author-start-room-pixel"/);
assert.match(startRoomSection, /pixel\.setAttribute\("aria-pressed", isStart \? "true" : "false"\)/);
assert.match(startRoomSection, /body: JSON\.stringify\(\{ start_level_id: startLevelId \}\)/);

const socialCardSection = sourceSection(
  "async function renderWorldHeroCardDataUrl",
  'window.addEventListener("pagehide"'
);
assert.match(socialCardSection, /actor\?\.type !== "player"/);
assert.match(socialCardSection, /actor\?\.type !== "circle_player"/);
assert.match(socialCardSection, /tilt: 0\.42/);
assert.doesNotMatch(socialCardSection, /fillText/);
assert.doesNotMatch(socialCardSection, /PLAY IT ON MAZEBENCH/);

const previewSection = sourceSection(
  "function createPalettePreviewPlayData",
  "function renderSelectedTool"
);
assert.match(previewSection, /const width = 1/);
assert.match(previewSection, /"__palette_preview_"/);
assert.match(previewSection, /const promptPreview = promptToolPreviewSpec\(tool\.token\)/);
assert.match(previewSection, /const ownedSlopePreview = ownedSlopePalettePreviewSpec\(previewToken, promptPreview\)/);
assert.match(previewSection, /const previewCellToken = ownedSlopePreview\?\.actorToken \|\| previewToken/);
assert.match(previewSection, /actor\.groupId = ownedSlopePreview\.groupId/);
assert.match(previewSection, /actor\.shape = "slope"/);
assert.match(previewSection, /actor\.styleKey = ownedSlopePreview\.groupId/);
assert.match(previewSection, /const puncherPortrait = kind === "puncher"/);
assert.match(previewSection, /const slopeSuffix = slopeTokenStyleSuffix\(directionalPreviewToken\)/);
assert.match(previewSection, /slopeSuffix === null \? directionalPreviewToken : "Sr" \+ slopeSuffix/);
assert.match(previewSection, /slopePortrait/);
assert.match(previewSection, /const orderedTools =/);
assert.match(previewSection, /\.\.\.hotbarTokens\(\)/);
assert.match(previewSection, /\.\.\.promptPaletteTools\.map\(\(tool\) => tool\.token\)/);
assert.match(previewSection, /const preloadWindowSize = 4/);
assert.match(previewSection, /await preloadTool\(tool\)/);
assert.match(previewSection, /publishPalettePreview\(tool, previewUrl\)/);
assert.match(previewSection, /await yieldPalettePreviewPaint\(\)/);
assert.match(previewSection, /async function capturePalettePreviewTools\(orderedTools\)/);
assert.match(previewSection, /function requestPatternPalettePreview\(tool\)/);
assert.match(previewSection, /await capturePalettePreviewTools\(\[tool\]\)/);
assert.match(previewSection, /palettePreviewRenderer\.captureQueue = capturePromise\.catch/);
assert.match(previewSection, /disposeAuxiliaryRenderApp\(app, canvas\)/);
assert.match(previewSection, /app\.state\.effects\.fuzzyEnabled = false/);
assert.match(previewSection, /app\.state\.effects\.noisePhase = 0/);
assert.match(
  previewSection,
  /app\.palettePreviewCameraTilt = entry\.slopePortrait[\s\S]*?\? Math\.PI \* 0\.18/
);
assert.match(previewSection, /entry\.puncherPortrait[\s\S]*?Math\.PI \* 0\.43/);
assert.match(previewSection, /app\.palettePreviewCameraZoom = entry\.puncherPortrait \? 1\.65/);
assert.match(previewSection, /mode: entry\.slopePortrait \? "isometric" : "perspective"/);
assert.doesNotMatch(previewSection, /await Promise\.all\(/);
assert.doesNotMatch(previewSection, /palettePreviewRenderer\.previewsByToken\s*=/);
assert.doesNotMatch(source, /drawnSwatch/);
assert.match(source, /\^S\[rlud\]M\\d\+\$\/\.test\(token\)[\s\S]*?blueSlopePromptToken/);
assert.match(source, /\^S\[rlud\]c\\d\+\$\/\.test\(token\)[\s\S]*?yellowSlopePromptToken/);
assert.match(source, /requestPatternPalettePreview\(selectedTool\)/);

assert.match(
  fs.readFileSync(path.join(__dirname, "..", "public", "play-render-three.js"), "utf8"),
  /isPalettePreview && Number\.isFinite\(requestedPaletteTilt\)/
);
assert.match(
  fs.readFileSync(path.join(__dirname, "..", "public", "play-render-three.js"), "utf8"),
  /isPalettePreview && Number\.isFinite\(requestedPaletteZoom\)/
);
assert.match(
  fs.readFileSync(path.join(__dirname, "..", "public", "play-render-three.js"), "utf8"),
  /actor\?\.shape === "slope"[\s\S]*?slopeStyleColor\([\s\S]*?actor\.styleKey \|\| actor\.groupId/
);

const defaultHotbarSection = sourceSection(
  "const defaultHotbarTokens",
  "const hotbarPersistenceEnabled"
);
const defaultHotbarMarkers = [
  "noopToken",
  "eraserToken",
  'toolByName.get("player")',
  'toolByName.get("gem")',
  "authorData.defaultWallToken",
  "authorData.defaultFloorToken",
  'toolByName.get("ice")',
  'toolByToken.get("M0")',
  'toolByToken.get("M1")',
  'toolByToken.get("l")'
];
let previousDefaultMarkerIndex = -1;
for (const marker of defaultHotbarMarkers) {
  const markerIndex = defaultHotbarSection.indexOf(marker);
  assert.ok(markerIndex > previousDefaultMarkerIndex, `default hotbar marker is out of order: ${marker}`);
  previousDefaultMarkerIndex = markerIndex;
}
assert.match(source, /const hotbarPersistenceEnabled = Array\.isArray\(authorData\.hotbarTokens\)/);
assert.match(source, /if \(normalized\.length >= 10\)/);
assert.match(source, /\.slice\(0, 10\)/);
assert.match(source, /const slotIndex = key === "0" \? 9 : Number\(key\) - 1/);
assert.match(source, /toolboxToolConfigs\[noopToken\]/);
assert.match(source, /toolboxToolConfigs\[eraserToken\]/);
assert.match(source, /noopToolConfig\.name[\s\S]*?: "Deselect"/);
assert.match(source, /eraserToolConfig\.name[\s\S]*?: "Erase"/);
assert.match(source, /const toolboxToolConfigs =/);
assert.doesNotMatch(source, /Board token:/);
assert.doesNotMatch(source, /inventory-detail-token/);
assert.match(source, /lucide\.dev\/icons\/mouse-pointer-2-off/);
assert.match(source, /lucide\.dev\/icons\/eraser/);
assert.match(source, /return deselectToolIconSvg/);
assert.match(source, /return eraserToolIconSvg/);
assert.doesNotMatch(source, /promptToolIconSvg/);
assert.match(source, /if \(slopeSuffix === "#"\) return 1/);
assert.match(source, /if \(slopeSuffix === "O"\) return 2/);
assert.match(source, /const numberedBoxSlopeToolTokens = \[0, 1, 2, 3, 4\]/);
assert.match(source, /const numberedCloneSlopeToolTokens = \[0, 1, 2\]/);
assert.match(
  source,
  /const permanentToolboxSlopeTokens = \[[\s\S]*?\.\.\.numberedBoxSlopeToolTokens[\s\S]*?\.\.\.numberedCloneSlopeToolTokens/
);
assert.match(source, /\["r", "l", "u", "d"\]\.forEach\(\(directionChar\) =>/);
assert.match(
  source,
  /toolByToken\.get\(directionToken\) \|\| materializePatternTool\(directionToken\)/
);
assert.match(
  source,
  /permanentToolboxSlopeTokens\.forEach\(\(token\) => slopeFamilyForToken\(token\)\)/
);
assert.match(
  source,
  /permanentToolboxSlopeTokens\.forEach\(\(token\) => \{[\s\S]*?tools\.push\(family\.paletteTool\)/
);
const cameraSlopeSection = sourceSection(
  "function cameraFarDirection",
  "function puncherTokenForDirection"
);
assert.match(cameraSlopeSection, /mapCameraRelativeDirection\(0, -1\)/);
assert.match(cameraSlopeSection, /family\.tokenByDirection\.get\(direction\)/);
assert.match(cameraSlopeSection, /slopeFamilyForToken\(state\.selectedToken\)/);
assert.match(source, /function promptToolPreviewSpec/);
assert.match(source, /return \{ groupId: "MN", token: "M0" \}/);
assert.match(source, /return \{ groupId: "cN", token: "c0" \}/);

const inventoryGroupsSection = sourceSection(
  "function isIceSlopeInventoryTool",
  "const INVENTORY_DEMO_CLASSES"
);
assert.match(inventoryGroupsSection, /"ice_block", "gem"/);
assert.match(inventoryGroupsSection, /name: "Players & Clones"/);
assert.match(inventoryGroupsSection, /name: "Ice Slopes"/);
assert.ok(
  inventoryGroupsSection.indexOf('name: "Players & Clones"') <
    inventoryGroupsSection.indexOf('name: "Ice Slopes"')
);
assert.match(inventoryGroupsSection, /\^M\(\[0-4\]\)\$/);
assert.match(inventoryGroupsSection, /\^c\(\[0-2\]\)\$/);
assert.match(inventoryGroupsSection, /blueSlopePromptToken\) return 15/);
assert.match(inventoryGroupsSection, /yellowSlopePromptToken\) return 23/);

const ownedSlopePreviewSource = sourceSection(
  "function ownedSlopePalettePreviewSpec",
  "// ---- Slope families ----"
).trim();
const ownedSlopePalettePreviewSpec = vm.runInNewContext(`(${ownedSlopePreviewSource})`);

assert.deepEqual(
  { ...ownedSlopePalettePreviewSpec("SrM7") },
  { actorToken: "M7", groupId: "M7", type: "weightless_box" }
);
assert.deepEqual(
  { ...ownedSlopePalettePreviewSpec("Src2") },
  { actorToken: "c2", groupId: "c2", type: "clone" }
);
assert.deepEqual(
  { ...ownedSlopePalettePreviewSpec("SrM0", { groupId: "MN" }) },
  { actorToken: "M0", groupId: "MN", type: "weightless_box" }
);
assert.equal(ownedSlopePalettePreviewSpec("Sr"), null);

const threeRenderSource = fs.readFileSync(
  path.join(__dirname, "..", "public", "play-render-three.js"),
  "utf8"
);
const actorContextSection = threeRenderSource.slice(
  threeRenderSource.indexOf("function renderActorContextKey"),
  threeRenderSource.indexOf("function invalidateSceneCache")
);
const actorSignatureSection = threeRenderSource.slice(
  threeRenderSource.indexOf("function actorSignature"),
  threeRenderSource.indexOf("function levelStateSignature")
);

assert.match(actorContextSection, /actor\?\.shape \|\| ""/);
assert.match(actorContextSection, /actor\?\.styleKey \|\| ""/);
assert.match(actorSignatureSection, /actor\.shape \|\| ""/);
assert.match(actorSignatureSection, /actor\.styleKey \|\| ""/);

const dirtyStateSection = sourceSection(
  "function syncEditorDirtyState",
  "function applyPersistedHotbarTokens"
);
assert.match(dirtyStateSection, /hotbarPersistenceEnabled && hotbarSignature\(\) !== savedHotbarSignature/);

const saveSection = sourceSection("async function saveLevel", "function raisedSurfaceSnapshotForApp");
assert.match(saveSection, /const submittedHotbarTokens = hotbarTokens\(\)/);
assert.match(saveSection, /hotbarTokens: submittedHotbarTokens/);
assert.match(saveSection, /const liveHotbarUnchanged = hotbarSignature\(\) === submittedHotbarSignature/);
assert.match(saveSection, /applyPersistedHotbarTokens\(payload\.hotbarTokens, submittedHotbarTokens\)/);
assert.match(saveSection, /rememberPersistedHotbarTokens\(payload\.hotbarTokens, submittedHotbarTokens\)/);
assert.match(
  saveSection,
  /scheduleCurrentLevelThumbRefresh\(0, \{ persist: clientPreviewPersistence \}\)/,
  "the host capability must prevent a hosted room save from issuing a duplicate preview mutation"
);
assert.match(saveSection, /New changes are still unsaved\./);

const loadSection = sourceSection("function applyAuthorLevelPayload", "async function loadLevel");
assert.match(loadSection, /applyPersistedHotbarTokens\(payload\.hotbarTokens, savedHotbarTokens\)/);
assert.match(loadSection, /syncEditorDirtyState\(\)/);

const hotbarSwapSource = sourceSection(
  "function swapTokenIntoHotbarSlot",
  "function toolForToken"
).trim();
const swapTokenIntoHotbarSlot = vm.runInNewContext(`(${hotbarSwapSource})`);
const numberedSlots = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

assert.equal(swapTokenIntoHotbarSlot(numberedSlots, 3, "7"), 3);
assert.deepEqual(Array.from(numberedSlots), ["1", "2", "3", "7", "5", "6", "4", "8", "9"]);

const replacementSlots = ["floor", "wall", "gem"];
assert.equal(swapTokenIntoHotbarSlot(replacementSlots, 1, "tree"), 1);
assert.deepEqual(Array.from(replacementSlots), ["floor", "tree", "gem"]);

const selectTokenSection = sourceSection("function selectToken", "function selectCell");
assert.match(selectTokenSection, /options\.assignToActiveSlot === true/);
assert.match(selectTokenSection, /swapTokenIntoHotbarSlot/);
assert.match(selectTokenSection, /syncEditorDirtyState\(\)/);
assert.match(source, /selectToken\(button\.dataset\.token, \{ assignToActiveSlot: true \}\)/);
assert.match(source, /selectToken\(descriptor\.topToken, \{ assignToActiveSlot: true \}\)/);
assert.match(source, /selectToken\(slot\.dataset\.token\);/);

const noop = () => {};
const context2d = {
  clearRect: noop,
  drawImage: noop,
  fillRect: noop,
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  imageSmoothingEnabled: false,
  putImageData: noop,
  setTransform: noop
};
const makeCanvas = () => ({
  height: 0,
  style: {},
  width: 0,
  getContext(type) {
    return type === "2d" ? context2d : null;
  }
});

global.performance = { now: () => 0 };
global.document = {
  title: "",
  createElement(tag) {
    return tag === "canvas" ? makeCanvas() : { style: {} };
  }
};
global.window = {
  PlayModules: {},
  cancelAnimationFrame: noop,
  devicePixelRatio: 2,
  history: { replaceState: noop },
  localStorage: { getItem: () => null, setItem: noop },
  location: { pathname: "/build/worlds/test" },
  requestAnimationFrame: () => 1,
  setTimeout: () => 1
};

loadBrowserScript("public/play-rules.js");
loadBrowserScript("public/play-core.js");

const demoCanvas = makeCanvas();
const demoHost = {
  clientHeight: 140,
  clientWidth: 224,
  style: {},
  getBoundingClientRect: () => ({ height: 140, width: 224 })
};
const floor = () => ({ imageUrl: null, label: "Floor", raised: false, type: "floor", underlay: null });
const demoApp = window.PlayModules.createPlayCore({
  canvas: demoCanvas,
  enableCameraControls: false,
  fuzzyToggle: null,
  mazeFrame: demoHost,
  playData: {
    actors: [{ id: "player", type: "player", x: 1, y: 1 }],
    cameraView: { height: 3, width: 3 },
    editorRender: true,
    gameId: "maze",
    height: 3,
    hostFullBleedView: true,
    levelId: "__toolbox_demo_test",
    levelLabel: "Demo",
    terrain: Array.from({ length: 3 }, () => Array.from({ length: 3 }, floor)),
    width: 3
  },
  playHeader: null,
  playShell: null,
  playStage: demoHost
});
demoApp.setupCanvas();

assert.deepEqual(demoApp.boardRect, { height: 140, width: 224 });
assert.deepEqual(demoApp.viewportRect, { height: 140, width: 224 });
assert.equal(demoCanvas.width, 448);
assert.equal(demoCanvas.height, 280);
assert.equal(demoCanvas.style.aspectRatio, "224 / 140");

console.log("author-inventory: OK");
