const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMazeLevelService } = require("../server/maze-levels");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-game-author-"));
const gamesDir = path.join(tempRoot, "games");
const levelDir = path.join(gamesDir, "maze", "levels");

fs.mkdirSync(levelDir, { recursive: true });

const game = {
  id: "maze",
  levels: [],
  levelFiles: ["test-empty.txt"],
  parser: {
    rules: {
      block_adder: "+",
      separator: " "
    },
    objects: {
      floor: { token: "." },
      wall: { token: "#" },
      ice: { token: "i" },
      ice_block: { token: "I" },
      ice_slope: {
        label: "Ice Slope",
        tokens: [
          { token: "Sr", direction: "right" },
          { token: "Sl", direction: "left" },
          { token: "Su", direction: "up" },
          { token: "Sd", direction: "down" },
          { token: "Sr#", direction: "right", style_key: "wall" }
        ]
      },
      gem: { token: "G" },
      player: { token: "p", checkpoint_kind: "primary", label: "Primary Flag" },
      checkpoint_secondary: {
        token: "F2",
        checkpoint_kind: "secondary",
        label: "Secondary Flag"
      },
      player_gate: { token: "g" },
      player_lift: { token: "l" },
      orange_button: { token: "o", label: "Orange Button" },
      weightless_box: { token: "M0" },
      block_asset_1: {
        token: "b1",
        label: "Block 1",
        type: "block_asset",
        model: "assets_3d/b1.glb"
      },
      puncher: {
        label: "Puncher",
        type: "puncher",
        tokens: [
          { token: "pr", direction: "right" },
          { token: "pd", direction: "down", selectable: false }
        ]
      }
    }
  },
  worldMap: {
    byPosition: new Map([
      [
        "level_AxA",
        {
          fileName: "test-empty.txt",
          id: "level_AxA",
          label: "Level AxA"
        }
      ]
    ])
  }
};

fs.writeFileSync(path.join(levelDir, "test-empty.txt"), "+ . +++#\n", "utf8");
fs.writeFileSync(path.join(levelDir, "legacy_hole.txt"), "h h+# #+h+# h+M0 M0\n", "utf8");

const worldMaps = {
  buildMazeFallbackLevelFileName: () => "fallback.txt",
  buildMazeWorldLevel: (gameId, levelId, options = {}) => ({
    fileName: options.fileName || "fallback.txt",
    id: levelId,
    label: levelId
  }),
  buildMazeWorldMapState: () => ({}),
  defaultLevelIdForGame: () => "level_AxA",
  isMazeFamilyGameId: (gameId) => gameId === "maze",
  isMazeWorldLevelId: (gameId, levelId) => /^level_[A-Z]x[A-Z]$/.test(levelId),
  mazeLevelLabel: (gameId, levelId) => levelId,
  worldConfigForGame: () => ({
    worldSize: { width: 1, height: 1 },
    levelSize: { width: 16, height: 16 },
    cameraView: { width: 3, height: 1 },
    worldColumns: ["A"],
    worldRows: ["A"],
    gridWidth: 16,
    gridHeight: 16,
    authorDefaultWidth: 3,
    authorDefaultHeight: 1
  })
};

const service = createMazeLevelService({
  buildGameAssetUrl: () => "",
  buildMazePreviewData: () => ({ previewUrl: null }),
  gamesDir,
  listTopLevelFiles: () => [],
  loadJson: (filePath) =>
    filePath.endsWith(path.join("maze", "toolbox.json"))
      ? {
          format: 1,
          tools: {
            M0: {
              name: "Feather Box",
              description: "Catalog description.",
              demo: { layout: ["p $ ."], moves: "R" }
            }
          }
        }
      : null,
  loadText: (filePath, fallback) => fs.readFileSync(filePath, "utf8") || fallback,
  resolveGameAssetPath: () => null,
  rootDir: tempRoot,
  titleCase: (value) => String(value),
  worldMaps
});

const editorState = service.getLevelEditorState(game, game.worldMap.byPosition.get("level_AxA"));

const authorPageData = service.buildAuthorPageData(
  game,
  game.worldMap.byPosition.get("level_AxA")
);
const catalogWeightless = authorPageData.palette.find((tool) => tool.token === "M0");
assert.equal(catalogWeightless.label, "Feather Box");
assert.equal(catalogWeightless.description, "Catalog description.");
assert.deepEqual(catalogWeightless.demo, { layout: ["p $ ."], moves: "R" });
assert.equal(authorPageData.palette.find((tool) => tool.token === "Sr#").styleKey, "wall");
assert.equal(authorPageData.palette.find((tool) => tool.token === "p").checkpointKind, "primary");
assert.equal(authorPageData.palette.find((tool) => tool.token === "F2").checkpointKind, "secondary");
assert.equal(authorPageData.toolboxCatalog.format, 1);
assert.equal(authorPageData.roomSwapApiUrl, "/api/world-map/maze/swap");
assert.equal(
  authorPageData.clientPreviewPersistence,
  true,
  "the local author server must retain its client-rendered preview uploads"
);

assert.deepEqual(editorState.cells[0].slice(0, 3), ["+", ".", "+++#"]);

const legacyHoleEditorState = service.getLevelEditorState(
  game,
  { id: "legacy_hole", fileName: "legacy_hole.txt", label: "Legacy Hole" }
);

assert.deepEqual(legacyHoleEditorState.cells[0].slice(0, 3), ["+", "+#", "#++#"]);

const legacyHolePlayState = service.getLevelState(
  game,
  { id: "legacy_hole", fileName: "legacy_hole.txt", label: "Legacy Hole" }
);

assert.equal(legacyHolePlayState.terrain[0][0].type, "empty");
assert.deepEqual(
  legacyHolePlayState.terrain[0][2].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["wall", 0],
    ["wall", 2]
  ]
);
assert.equal(legacyHolePlayState.terrain[0][3].type, "empty");
assert.equal(legacyHolePlayState.actors.find((actor) => actor.x === 3).elevation, 0);
assert.equal(legacyHolePlayState.terrain[0][4].type, "floor");
assert.equal(legacyHolePlayState.actors.find((actor) => actor.x === 4).elevation, 0);
assert.equal(editorState.rawText, "+ . +++#");

const sanitized = service.sanitizeEditorPayload(game, {
  cells: [["+", ".", "+++#"]],
  height: 1,
  width: 3
});

assert.deepEqual(sanitized.cells[0], ["+", ".", "+++#"]);
assert.equal(sanitized.rawText, "+ . +++#");

const legacySanitized = service.sanitizeEditorPayload(game, {
  width: 3,
  height: 1,
  cells: [["h", "h+#", "#+h+#"]]
});

assert.deepEqual(legacySanitized.cells[0], ["+", "+#", "#++#"]);
assert.equal(legacySanitized.rawText, "+ +# #++#");

const puncherSanitized = service.sanitizeEditorPayload(game, {
  cells: [["#+pd", ".+pr", "+"]],
  height: 1,
  width: 3
});

assert.deepEqual(puncherSanitized.cells[0], ["#+pd", ".+pr", "+"]);

fs.writeFileSync(path.join(levelDir, "test-empty.txt"), puncherSanitized.rawText + "\n", "utf8");

const puncherPlayState = service.getLevelState(game, game.worldMap.byPosition.get("level_AxA"));

assert.deepEqual(
  puncherPlayState.actors.map((actor) => [actor.type, actor.x, actor.y, actor.elevation, actor.direction]),
  [
    ["puncher", 0, 0, 1, "down"],
    ["puncher", 1, 0, 0, "right"]
  ]
);

// Older drafts only declared the four plain slope tokens. Black and orange
// families still synthesize all four directions and must round-trip through
// the same save sanitizer used by the author endpoint.
const directionalSlopeTokens = [
  "Sr#",
  "Sl#",
  "Su#",
  "Sd#",
  "SrO",
  "SlO",
  "SuO",
  "SdO"
];
const slopeSanitized = service.sanitizeEditorPayload(game, {
  cells: [directionalSlopeTokens],
  height: 1,
  width: directionalSlopeTokens.length
});

assert.deepEqual(slopeSanitized.cells[0], directionalSlopeTokens);
assert.equal(slopeSanitized.rawText, directionalSlopeTokens.join(" "));

fs.writeFileSync(path.join(levelDir, "test-empty.txt"), slopeSanitized.rawText + "\n", "utf8");

const directionalSlopePlayState = service.getLevelState(
  game,
  game.worldMap.byPosition.get("level_AxA")
);

assert.deepEqual(
  directionalSlopePlayState.terrain[0].map((cell) => {
    const slope = (cell.layers || []).find(
      (layer) => layer.type === "ice_slope" || layer.type === "orange_ice_slope"
    );
    return [slope?.type, slope?.direction, slope?.styleKey];
  }),
  [
    ["ice_slope", "right", "wall"],
    ["ice_slope", "left", "wall"],
    ["ice_slope", "up", "wall"],
    ["ice_slope", "down", "wall"],
    ["orange_ice_slope", "right", "orange"],
    ["orange_ice_slope", "left", "orange"],
    ["orange_ice_slope", "up", "orange"],
    ["orange_ice_slope", "down", "orange"]
  ]
);

fs.writeFileSync(path.join(levelDir, "test-empty.txt"), ".+b1\n", "utf8");

const blockAssetPlayState = service.getLevelState(game, game.worldMap.byPosition.get("level_AxA"));
const blockAssetCell = blockAssetPlayState.terrain[0][0];

assert.equal(blockAssetCell.type, "block_asset");
assert.deepEqual(
  blockAssetCell.layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["block_asset", 0]
  ]
);

fs.writeFileSync(path.join(levelDir, "test-empty.txt"), "i+o #+o o\n", "utf8");

const orangeButtonPlayState = service.getLevelState(game, game.worldMap.byPosition.get("level_AxA"));

assert.equal(orangeButtonPlayState.terrain[0][0].type, "ice");
assert.equal(orangeButtonPlayState.terrain[0][1].type, "wall");
assert.equal(orangeButtonPlayState.terrain[0][2].type, "empty");
assert.deepEqual(
  orangeButtonPlayState.actors.map((actor) => [actor.type, actor.x, actor.y, actor.elevation]),
  [
    ["orange_button", 0, 0, 0],
    ["orange_button", 1, 0, 1],
    ["orange_button", 2, 0, 0]
  ]
);

fs.writeFileSync(path.join(levelDir, "test-empty.txt"), ".+#+G+# .+#+l+# .+#+o+# .+#+g+# .+l .+o .+G .+g\n", "utf8");

const layerSeparatorPlayState = service.getLevelState(game, game.worldMap.byPosition.get("level_AxA"));

assert.deepEqual(
  layerSeparatorPlayState.terrain[0][0].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["wall", 0],
    ["wall", 2]
  ]
);
assert.deepEqual(
  layerSeparatorPlayState.terrain[0][1].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["wall", 0],
    ["player_lift", 1],
    ["wall", 2]
  ]
);
assert.deepEqual(
  layerSeparatorPlayState.terrain[0][2].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["wall", 0],
    ["wall", 2]
  ]
);
assert.deepEqual(
  layerSeparatorPlayState.terrain[0][3].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["wall", 0],
    ["player_gate", 1],
    ["wall", 2]
  ]
);
assert.deepEqual(
  layerSeparatorPlayState.actors.map((actor) => [actor.type, actor.x, actor.elevation]),
  [
    ["gem", 0, 1],
    ["orange_button", 2, 1],
    ["orange_button", 5, 0],
    ["gem", 6, 0]
  ]
);
assert.deepEqual(
  layerSeparatorPlayState.terrain[0][4].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["player_lift", 0]
  ]
);
assert.deepEqual(
  layerSeparatorPlayState.terrain[0][7].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["player_gate", 0]
  ]
);

fs.writeFileSync(path.join(levelDir, "test-empty.txt"), ".+p+G .+F2+G #+F2\n", "utf8");

const checkpointPlayState = service.getLevelState(
  game,
  game.worldMap.byPosition.get("level_AxA")
);

assert.deepEqual(checkpointPlayState.checkpoints, [
  {
    id: "level_AxA:checkpoint:primary",
    kind: "primary",
    x: 0,
    y: 0,
    elevation: 0,
    active: false,
    userPlaced: false
  },
  {
    id: "level_AxA:checkpoint:secondary:1:0:0",
    kind: "secondary",
    x: 1,
    y: 0,
    elevation: 0,
    active: false,
    userPlaced: false
  },
  {
    id: "level_AxA:checkpoint:secondary:2:0:1",
    kind: "secondary",
    x: 2,
    y: 0,
    elevation: 1,
    active: false,
    userPlaced: false
  }
]);
const checkpointPrimaryActor = checkpointPlayState.actors.find(
  (actor) => actor.isPrimaryCheckpointSpawn === true
);
assert.equal(checkpointPrimaryActor.primaryCheckpointId, "level_AxA:checkpoint:primary");
assert.equal(
  checkpointPlayState.actors.find((actor) => actor.type === "gem" && actor.x === 0).elevation,
  1
);
assert.equal(
  checkpointPlayState.actors.find((actor) => actor.type === "gem" && actor.x === 1).elevation,
  0,
  "secondary metadata must not consume an elevation slot"
);
assert.equal(
  checkpointPlayState.actors.some((actor) => actor.type === "checkpoint_secondary"),
  false
);

assert.deepEqual(
  service.sanitizeEditorPayload(game, {
    cells: [[".+F2", "#+F2", "i+F2", "I+F2"]],
    height: 1,
    width: 4
  }).cells[0],
  [".+F2", "#+F2", "i+F2", "I+F2"]
);
assert.throws(
  () => service.sanitizeEditorPayload(game, { cells: [["+F2"]], height: 1, width: 1 }),
  /must stand alone/
);
assert.throws(
  () => service.sanitizeEditorPayload(game, { cells: [[".+M0+F2"]], height: 1, width: 1 }),
  /must stand alone/
);
assert.throws(
  () => service.sanitizeEditorPayload(game, { cells: [[".+F2+#"]], height: 1, width: 1 }),
  /must stand alone/
);
assert.throws(
  () => service.sanitizeEditorPayload(game, { cells: [[".+p", ".+p"]], height: 1, width: 2 }),
  /only one primary checkpoint/
);
assert.equal(
  service.sanitizeEditorPayload(game, { cells: [[".+b1+p"]], height: 1, width: 1 }).cells[0][0],
  ".+b1+p",
  "legacy primary starts on invalid supports remain editable and round-trip unchanged"
);

fs.rmSync(tempRoot, { recursive: true, force: true });

console.log("maze author level serialization tests passed");
