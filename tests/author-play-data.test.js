const assert = require("node:assert/strict");
const { loadBrowserScript } = require("./helpers/browser-module-loader");

global.window = {};

loadBrowserScript("public/maze-token-patterns.js");
loadBrowserScript("public/author-play-data.js");

const authorData = {
  blockAdder: "+",
  defaultFloorToken: ".",
  game: { id: "maze" },
  palette: [
    { imageUrl: null, label: "Floor", name: "floor", token: "." },
    { imageUrl: null, label: "Ice", name: "ice", token: "i", type: "ice" },
    { imageUrl: null, label: "Ice Block", name: "ice_block", token: "I", type: "ice_block" },
    { direction: "right", imageUrl: null, label: "Ice Slope Right", name: "ice_slope", token: "Sr", type: "ice_slope" },
    { imageUrl: null, label: "Wall", name: "wall", token: "W" },
    {
      imageUrl: null,
      label: "Tree 1",
      modelUrl: "/assets/maze/assets_3d/t1.glb",
      name: "tree_1",
      token: "t1",
      type: "tree"
    },
    {
      imageUrl: null,
      label: "Small Tree 1",
      modelUrl: "/assets/maze/assets_3d/st1.glb",
      name: "small_tree_1",
      token: "st1",
      type: "tree"
    },
    {
      imageUrl: null,
      label: "Shrub",
      modelUrl: "/assets/maze/assets_3d/sh.glb",
      name: "shrub",
      token: "sh",
      type: "shrub"
    },
    {
      imageUrl: null,
      label: "Block 1",
      modelUrl: "/assets/maze/assets_3d/b1.glb",
      name: "block_asset_1",
      token: "b1",
      type: "block_asset"
    },
    { imageUrl: null, label: "Player Gate", name: "player_gate", token: "g", type: "player_gate" },
    { imageUrl: null, initialRaised: false, label: "Player Lift l", name: "player_lift", token: "l", type: "player_lift" },
    { imageUrl: null, initialRaised: true, label: "Raised Player Lift", name: "player_lift", token: "L", type: "player_lift" },
    { imageUrl: null, label: "Orange Wall", name: "orange_wall", token: "O", type: "orange_wall" },
    { imageUrl: null, label: "Orange Button", name: "orange_button", token: "o", type: "orange_button" },
    { direction: "right", imageUrl: null, label: "Puncher", name: "puncher", token: "pr", type: "puncher" },
    { direction: "left", imageUrl: null, label: "Puncher Left", name: "puncher", token: "pl", type: "puncher" },
    { direction: "up", imageUrl: null, label: "Puncher Up", name: "puncher", token: "pu", type: "puncher" },
    { direction: "down", imageUrl: null, label: "Puncher Down", name: "puncher", token: "pd", type: "puncher" },
    { imageUrl: null, label: "Player", name: "player", token: "P" },
    { imageUrl: null, label: "Circle Player", name: "circle_player", token: "CP" },
    { imageUrl: null, label: "Clone 0", name: "clone", token: "c0", type: "clone" },
    { imageUrl: null, label: "Clone 1", name: "clone", token: "c1", type: "clone" },
    { imageUrl: null, label: "Clone 2", name: "clone", token: "c2", type: "clone" },
    {
      imageUrl: "/assets/maze/images/gem.png",
      label: "Gem",
      modelUrl: "/assets/maze/assets_3d/gem.glb",
      name: "gem",
      token: "G"
    },
    {
      imageUrl: "/assets/maze/images/crate.png",
      label: "Weightless Box",
      name: "weightless_box",
      token: "B"
    }
  ]
};

const adapter = window.AuthorPlayData.createAdapter(authorData);
const playData = adapter.buildPlayData({
  cameraView: { width: 3, height: 2 },
  cells: [
    ["W+.", "P+G", "B"],
    [".", "", "W"]
  ],
  height: 2,
  levelId: "__editor_render__",
  levelLabel: "Level AxA",
  sourceFileName: "level_AxA.txt",
  width: 3
});

assert.equal(playData.gameId, "maze");
assert.deepEqual(playData.cameraView, { width: 3, height: 2 });
assert.equal(playData.disableHorizontalNeighborFetches, false);
assert.equal(playData.terrain[0][0].type, "wall");
assert.equal(playData.terrain[0][0].underlay.type, "floor");
assert.equal(playData.terrain[0][1].type, "floor");
assert.equal(playData.terrain[1][1].type, "empty");
assert.deepEqual(
  playData.actors.map((actor) => [actor.type, actor.x, actor.y, actor.groupId]),
  [
    ["player", 1, 0, null],
    ["gem", 1, 0, null],
    ["weightless_box", 2, 0, "B"]
  ]
);
assert.equal(playData.actors[1].modelUrl, "/assets/maze/assets_3d/gem.glb");

const localWorldPlayData = adapter.buildPlayData({
  cells: [["."]],
  disableHorizontalNeighborFetches: true,
  height: 1,
  width: 1
});
assert.equal(localWorldPlayData.disableHorizontalNeighborFetches, true);

const clonePlayData = adapter.buildPlayData({
  cells: [["c1+c1"]],
  height: 1,
  width: 1
});

assert.deepEqual(
  clonePlayData.actors.map((actor) => [actor.type, actor.groupId, actor.elevation]),
  [
    ["clone", "c1", 0],
    ["clone", "c1", 1]
  ]
);

const noGemPlayData = adapter.buildPlayData({
  cells: [["P+G"]],
  height: 1,
  includeGems: false,
  width: 1
});

assert.deepEqual(
  noGemPlayData.actors.map((actor) => actor.type),
  ["player"]
);
assert.equal(adapter.getCellDescriptor("P+G").topToken, "G");
assert.throws(() => adapter.normalizeCellValue("NOPE"), /Unknown token/);
assert.equal(adapter.normalizeCellValue("W++W"), "W++W");
assert.equal(adapter.normalizeCellValue(""), "+");
assert.equal(adapter.normalizeCellValue("+"), "+");
assert.equal(adapter.normalizeCellValue("++"), "+");
assert.equal(adapter.normalizeCellValue("++W"), "++W");
assert.equal(adapter.normalizeCellValue("h"), "+");
assert.equal(adapter.normalizeCellValue("W+h+W"), "W++W");
assert.deepEqual(adapter.getCellTokens("h+W"), ["", "W"]);
assert.equal(adapter.setCellElevationToken(".", "W", 1), ".++W");
assert.equal(adapter.setCellElevationToken(".", "W", 0), ".+W");
assert.equal(adapter.setCellElevationToken(".", "I", 0), ".+I");
assert.equal(adapter.setCellElevationToken(".", "sh", 0), ".+sh");
assert.equal(adapter.setCellElevationToken(".+W", "O", 0), ".+O");
assert.equal(adapter.setCellElevationToken("+", ".", 0), ".");
assert.equal(adapter.setCellElevationToken("+", "W", 0), "W");
assert.equal(adapter.setCellElevationToken("+", "B", 0), "+B");
assert.equal(adapter.setCellElevationToken("++++W", ".", 0), ".++++W");
assert.equal(adapter.setCellElevationToken(".", ".", 0), ".");
assert.equal(adapter.setCellElevationToken(".+.", ".", 1), ".");
assert.equal(adapter.setCellElevationToken("W", ".", 0), ".+W");
assert.equal(adapter.setCellElevationToken("W", "i", 2), "i+W");
assert.equal(adapter.setCellElevationToken(".", "t1", 0), ".+t1");
assert.equal(adapter.setSurfaceAttachmentToken(".", "o", 0), ".+o");
assert.equal(adapter.setSurfaceAttachmentToken("i", "o", 0), "i+o");
assert.equal(adapter.setSurfaceAttachmentToken("W", "o", 1), "W+o");
assert.equal(adapter.setSurfaceAttachmentToken("Sr", "o", 1), "Sr");
assert.equal(adapter.setSurfaceAttachmentToken("B", "o", 1), "B+o");
assert.equal(adapter.setSurfaceAttachmentToken("+", "o", 0), "+");
assert.equal(adapter.appendCellToken("+", "W"), "W");
assert.equal(adapter.appendCellToken("+", "B"), "+B");
assert.equal(adapter.appendCellToken(".", "W"), ".+W");
assert.equal(adapter.appendCellToken("W", "B"), "W+B");
assert.equal(adapter.appendCellToken(".+W", "i"), "i+W");
assert.equal(adapter.normalizeAuthoringCellValue(".+W+i"), "i+W");
assert.equal(adapter.normalizeAuthoringCellValue("W"), "W");
assert.equal(adapter.normalizeAuthoringCellValue("P"), ".+P");
assert.equal(adapter.normalizeAuthoringCellValue("CP"), ".+CP");
assert.equal(adapter.normalizeAuthoringCellValue("+P"), "+P");
assert.equal(adapter.setCellElevationToken("", "W", 3), "++++W");
assert.equal(adapter.placeCellElevationTokenIfVacant(".", "W", 0), ".+W");
assert.equal(adapter.placeCellElevationTokenIfVacant("+", "B", 0), "+B");
assert.equal(adapter.placeCellElevationTokenIfVacant("+", "B", 1), "++B");
assert.equal(adapter.placeCellElevationTokenIfVacant(".+G", "W", 0), ".+G");
assert.equal(adapter.placeCellElevationTokenIfVacant(".+G", "W", 1), ".+G+W");
assert.equal(adapter.placeCellElevationTokenIfVacant(".+W", "O", 0), ".+W");
assert.equal(adapter.placeCellElevationTokenIfVacant(".+W", "O", 1), ".+W+O");
assert.equal(adapter.placeCellElevationTokenIfVacant(".+t1", "W", 0), ".+t1");
assert.equal(adapter.placeCellElevationTokenIfVacant(".+t1", "W", 1), ".+t1");
assert.equal(adapter.placeCellElevationTokenIfVacant(".+t1", "W", 2), ".+t1");
assert.equal(adapter.placeCellElevationTokenIfVacant(".+t1", "W", 3), ".+t1+W");
assert.equal(adapter.placeCellElevationTokenIfVacant(".+++W", "O", 1), ".++O+W");
assert.equal(adapter.placeCellElevationTokenIfVacant(".++W", "t1", 0), ".++W");
assert.equal(adapter.placeCellElevationTokenIfVacant(".++++W", "t1", 0), ".+t1+W");
assert.equal(adapter.placeCellElevationTokenIfVacant(".+W++++W", "t1", 1), ".+W+t1+W");
assert.equal(adapter.eraseCellElevationValue("W++W", 0), "++W");
assert.equal(adapter.eraseCellElevationValue("W++W", 2), "W");
assert.equal(adapter.eraseCellElevationValue(".++W", 0), "++W");
assert.equal(adapter.eraseCellElevationValue(".+++W", 0), "+++W");
assert.equal(adapter.eraseCellElevationValue(".+++++W", 0), "+++++W");
assert.equal(adapter.eraseCellElevationValue(".+W", 0), ".");
assert.equal(adapter.eraseCellElevationValue(".", 0), "+");
assert.equal(adapter.eraseCellElevationValue("B++B", 0), "++B");
assert.equal(adapter.eraseCellElevationValue(".+W+G+W", 1), ".+W++W");
assert.equal(adapter.eraseCellElevationValue(".+W+l+W", 1), ".+W++W");
assert.equal(adapter.eraseCellElevationValue(".+W+o+W", 1), ".+W++W");
assert.equal(adapter.eraseCellElevationValue(".+W+g+W", 1), ".+W++W");
assert.equal(adapter.eraseCellElevationValue(".+l", 0), ".");
assert.equal(adapter.eraseCellElevationValue("W+l", 1), "W");
assert.equal(adapter.eraseCellElevationValue(".+L", 0), ".");
assert.equal(adapter.eraseCellElevationValue("P", 0), ".");
assert.equal(adapter.eraseCellElevationValue("CP", 0), ".");
assert.equal(adapter.eraseCellElevationValue(".+P", 0), ".");
assert.equal(adapter.eraseCellElevationValue("+P", 0), "+");
assert.equal(adapter.eraseCellElevationValue("W+P", 1), ".+W");

const loweredLiftPlayData = adapter.buildPlayData({
  cells: [["l"]],
  height: 1,
  width: 1
});
assert.equal(loweredLiftPlayData.terrain[0][0].type, "player_lift");
assert.equal(loweredLiftPlayData.terrain[0][0].raised, false);

const raisedLiftPlayData = adapter.buildPlayData({
  cells: [["L"]],
  height: 1,
  width: 1
});
assert.equal(raisedLiftPlayData.terrain[0][0].type, "player_lift");
assert.equal(raisedLiftPlayData.terrain[0][0].raised, true);

const orangePlayData = adapter.buildPlayData({
  cells: [["O", ".+o+B", "i+o", "W+o"]],
  height: 1,
  width: 4
});
assert.equal(orangePlayData.terrain[0][0].type, "orange_wall");
assert.equal(orangePlayData.terrain[0][1].type, "floor");
assert.equal(orangePlayData.terrain[0][2].type, "ice");
assert.equal(orangePlayData.terrain[0][3].type, "wall");
assert.deepEqual(
  orangePlayData.actors.map((actor) => [actor.type, actor.x, actor.y, actor.elevation]),
  [
    ["orange_button", 1, 0, 0],
    ["weightless_box", 1, 0, 1],
    ["orange_button", 2, 0, 0],
    ["orange_button", 3, 0, 1]
  ]
);

const layerSeparatorSpecialTokenPlayData = adapter.buildPlayData({
  cells: [[".+W+G+W", ".+W+l+W", ".+W+o+W", ".+W+g+W", ".+l", ".+o", ".+G", ".+g"]],
  height: 1,
  width: 8
});

assert.deepEqual(
  layerSeparatorSpecialTokenPlayData.terrain[0][0].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["wall", 0],
    ["wall", 2]
  ]
);
assert.deepEqual(
  layerSeparatorSpecialTokenPlayData.terrain[0][1].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["wall", 0],
    ["player_lift", 1],
    ["wall", 2]
  ]
);
assert.deepEqual(
  layerSeparatorSpecialTokenPlayData.terrain[0][2].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["wall", 0],
    ["wall", 2]
  ]
);
assert.deepEqual(
  layerSeparatorSpecialTokenPlayData.terrain[0][3].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["wall", 0],
    ["player_gate", 1],
    ["wall", 2]
  ]
);
assert.deepEqual(
  layerSeparatorSpecialTokenPlayData.actors.map((actor) => [actor.type, actor.x, actor.elevation]),
  [
    ["gem", 0, 1],
    ["orange_button", 2, 1],
    ["orange_button", 5, 0],
    ["gem", 6, 0]
  ]
);
assert.deepEqual(
  layerSeparatorSpecialTokenPlayData.terrain[0][4].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["player_lift", 0]
  ]
);
assert.deepEqual(
  layerSeparatorSpecialTokenPlayData.terrain[0][7].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["player_gate", 0]
  ]
);

const puncherPlayData = adapter.buildPlayData({
  cells: [["W+pr", ".++pl", ".+pu", ".+pd"]],
  height: 1,
  width: 4
});

assert.deepEqual(
  puncherPlayData.actors.map((actor) => [actor.type, actor.x, actor.y, actor.elevation, actor.direction]),
  [
    ["puncher", 0, 0, 1, "right"],
    ["puncher", 1, 0, 1, "left"],
    ["puncher", 2, 0, 0, "up"],
    ["puncher", 3, 0, 0, "down"]
  ]
);

const stackedPlayData = adapter.buildPlayData({
  cells: [["W+L+B+G", "B+B"]],
  height: 1,
  width: 2
});

assert.deepEqual(
  stackedPlayData.terrain[0][0].layers.map((layer) => [layer.type, layer.elevation, layer.raised]),
  [
    ["wall", 0, false],
    ["player_lift", 1, true]
  ]
);
assert.deepEqual(
  stackedPlayData.actors.map((actor) => [actor.type, actor.x, actor.y, actor.elevation]),
  [
    ["weightless_box", 0, 0, 2],
    ["gem", 0, 0, 3],
    ["weightless_box", 1, 0, 0],
    ["weightless_box", 1, 0, 1]
  ]
);

const gappedStackPlayData = adapter.buildPlayData({
  cells: [["W++W", "W++B"]],
  height: 1,
  width: 2
});

assert.deepEqual(
  gappedStackPlayData.terrain[0][0].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["wall", 0],
    ["wall", 2]
  ]
);
assert.deepEqual(
  gappedStackPlayData.actors.map((actor) => [actor.type, actor.x, actor.y, actor.elevation]),
  [["weightless_box", 1, 0, 2]]
);

const baseSurfacePlayData = adapter.buildPlayData({
  cells: [[".+W", ".+."]],
  height: 1,
  width: 2
});

assert.deepEqual(
  baseSurfacePlayData.terrain[0][0].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["wall", 0]
  ]
);
assert.deepEqual(
  baseSurfacePlayData.terrain[0][1].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["floor", 1]
  ]
);

const elevatedBaseSurfacePlayData = adapter.buildPlayData({
  cells: [[adapter.setCellElevationToken("++++W", ".", 0)]],
  height: 1,
  width: 1
});

assert.deepEqual(
  elevatedBaseSurfacePlayData.terrain[0][0].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["wall", 3]
  ]
);

const legacyHolePlayData = adapter.buildPlayData({
  cells: [["h", "W+h+W"]],
  height: 1,
  width: 2
});

assert.equal(legacyHolePlayData.terrain[0][0].type, "empty");
assert.deepEqual(
  legacyHolePlayData.terrain[0][1].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["wall", 0],
    ["wall", 2]
  ]
);

const actorOverExplicitVoidPlayData = adapter.buildPlayData({
  cells: [["+B", "B"]],
  height: 1,
  width: 2
});

assert.equal(actorOverExplicitVoidPlayData.terrain[0][0].type, "empty");
assert.equal(actorOverExplicitVoidPlayData.actors[0].elevation, 0);
assert.equal(actorOverExplicitVoidPlayData.terrain[0][1].type, "floor");
assert.equal(actorOverExplicitVoidPlayData.actors[1].elevation, 0);

const iceBlockPlayData = adapter.buildPlayData({
  cells: [["I+P", "I+I"]],
  height: 1,
  width: 2
});

assert.equal(iceBlockPlayData.terrain[0][0].type, "ice_block");
assert.equal(iceBlockPlayData.terrain[0][0].underlay.type, "floor");
assert.deepEqual(
  iceBlockPlayData.terrain[0][1].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["ice_block", 0],
    ["ice_block", 1]
  ]
);
assert.deepEqual(
  iceBlockPlayData.actors.map((actor) => [actor.type, actor.elevation]),
  [["player", 1]]
);

const iceSlopePlayData = adapter.buildPlayData({
  cells: [["Sr+P", "Sr+Sr"]],
  height: 1,
  width: 2
});

assert.equal(iceSlopePlayData.terrain[0][0].type, "ice_slope");
assert.equal(iceSlopePlayData.terrain[0][0].direction, "right");
assert.equal(iceSlopePlayData.terrain[0][0].underlay.type, "floor");
assert.deepEqual(
  iceSlopePlayData.terrain[0][1].layers.map((layer) => [layer.type, layer.elevation, layer.direction]),
  [
    ["ice_slope", 0, "right"],
    ["ice_slope", 1, "right"]
  ]
);
assert.deepEqual(
  iceSlopePlayData.actors.map((actor) => [actor.type, actor.elevation]),
  [["player", 1]]
);

const treePlayData = adapter.buildPlayData({
  cells: [["t1+P", "t1+t1"]],
  height: 1,
  width: 2
});

assert.equal(treePlayData.terrain[0][0].type, "tree");
assert.equal(treePlayData.terrain[0][0].modelUrl, "/assets/maze/assets_3d/t1.glb");
assert.deepEqual(
  treePlayData.terrain[0][1].layers.map((layer) => [layer.type, layer.elevation, layer.modelUrl]),
  [
    ["tree", 0, "/assets/maze/assets_3d/t1.glb"],
    ["tree", 3, "/assets/maze/assets_3d/t1.glb"]
  ]
);
assert.deepEqual(
  treePlayData.actors.map((actor) => [actor.type, actor.elevation]),
  [["player", 3]]
);

const shrubPlayData = adapter.buildPlayData({
  cells: [["sh+P", "sh+sh", "st1"]],
  height: 1,
  width: 3
});

assert.equal(shrubPlayData.terrain[0][0].type, "shrub");
assert.equal(shrubPlayData.terrain[0][0].modelUrl, "/assets/maze/assets_3d/sh.glb");
assert.deepEqual(
  shrubPlayData.terrain[0][1].layers.map((layer) => [layer.type, layer.elevation, layer.modelUrl]),
  [
    ["shrub", 0, "/assets/maze/assets_3d/sh.glb"],
    ["shrub", 1, "/assets/maze/assets_3d/sh.glb"]
  ]
);
assert.equal(shrubPlayData.terrain[0][2].type, "tree");
assert.equal(shrubPlayData.terrain[0][2].modelUrl, "/assets/maze/assets_3d/st1.glb");
assert.deepEqual(
  shrubPlayData.actors.map((actor) => [actor.type, actor.elevation]),
  [["player", 1]]
);

const blockAssetPlayData = adapter.buildPlayData({
  cells: [["b1+P", "b1+b1"]],
  height: 1,
  width: 2
});

assert.equal(blockAssetPlayData.terrain[0][0].type, "block_asset");
assert.equal(blockAssetPlayData.terrain[0][0].modelUrl, "/assets/maze/assets_3d/b1.glb");
assert.deepEqual(
  blockAssetPlayData.terrain[0][1].layers.map((layer) => [layer.type, layer.elevation, layer.modelUrl]),
  [
    ["block_asset", 0, "/assets/maze/assets_3d/b1.glb"],
    ["block_asset", 1, "/assets/maze/assets_3d/b1.glb"]
  ]
);
assert.deepEqual(
  blockAssetPlayData.actors.map((actor) => [actor.type, actor.elevation]),
  [["player", 1]]
);

console.log("author play data tests passed");

// Owner feature (2026-07): open-ended token families resolve through
// maze-token-patterns — arbitrary box/clone ids and colored ice slopes.
{
  const directionalTokensByChar = {
    r: ["pr", "Sr", "Sr#", "SrO", "SrM12", "Src9"],
    l: ["pl", "Sl", "Sl#", "SlO", "SlM12", "Slc9"],
    u: ["pu", "Su", "Su#", "SuO", "SuM12", "Suc9"],
    d: ["pd", "Sd", "Sd#", "SdO", "SdM12", "Sdc9"]
  };
  const directionCharsByTransform = {
    "rotate-left": { r: "u", u: "l", l: "d", d: "r" },
    "rotate-right": { r: "d", d: "l", l: "u", u: "r" },
    "flip-horizontal": { r: "l", l: "r", u: "u", d: "d" },
    "flip-vertical": { r: "r", l: "l", u: "d", d: "u" }
  };

  Object.entries(directionCharsByTransform).forEach(([transformType, directionMap]) => {
    Object.entries(directionalTokensByChar).forEach(([directionChar, tokens]) => {
      const expectedTokens = directionalTokensByChar[directionMap[directionChar]];

      tokens.forEach((token, index) => {
        assert.equal(
          window.MazeTokenPatterns.transformDirectionalToken(token, transformType),
          expectedTokens[index],
          `${transformType} must reorient ${token}`
        );
      });
    });
  });
  assert.equal(
    window.MazeTokenPatterns.transformDirectionalCellValue(
      ".+pr+Sl#+SuO+SdM12+Src9+p",
      "+",
      "rotate-left"
    ),
    ".+pu+Sd#+SlO+SrM12+Suc9+p",
    "every directional layer in a stacked cell must transform while ordinary tokens stay unchanged"
  );

  const patternAdapter = window.AuthorPlayData.createAdapter(authorData);
  const playData = patternAdapter.buildPlayData({
    cameraView: { width: 6, height: 1 },
    cells: [["P", "M7", ".+SrM7", ".+Sr#", ".+SdO", "c9"]],
    height: 1,
    levelId: "__pattern_tokens__",
    levelLabel: "Pattern Tokens",
    sourceFileName: "pattern.txt",
    width: 6
  });

  const box = playData.actors.find((actor) => actor.type === "weightless_box" && actor.groupId === "M7");
  assert.ok(box, "arbitrary-id weightless box resolves");
  const clone = playData.actors.find((actor) => actor.type === "clone" && actor.groupId === "c9");
  assert.ok(clone, "arbitrary-id clone resolves");

  // Box/Clone Ice Slopes are slope-SHAPED GROUP MEMBERS (actors), not terrain.
  const boxSlope = playData.actors.find(
    (actor) => actor.type === "weightless_box" && actor.shape === "slope"
  );
  assert.equal(boxSlope?.groupId, "M7");
  assert.equal(boxSlope?.direction, "right");
  assert.equal(boxSlope?.styleKey, "M7");

  const blackSlope = (playData.terrain[0][3].layers || []).find((layer) => layer.type === "ice_slope");
  assert.equal(blackSlope?.styleKey, "wall");

  const orangeSlope = (playData.terrain[0][4].layers || []).find((layer) => layer.type === "orange_ice_slope");
  assert.equal(orangeSlope?.styleKey, "orange");
  assert.equal(orangeSlope?.direction, "down");
}

// Owner rule (2026-07): lift/gate stacked directly on a movable carrier
// converts to a stuck rider actor (attached_lift / attached_gate).
{
  const attachAdapter = window.AuthorPlayData.createAdapter(authorData);
  const playData = attachAdapter.buildPlayData({
    cameraView: { width: 4, height: 1 },
    cells: [["P", ".+B+l", ".+c0+g", "."]],
    height: 1,
    levelId: "__attached_devices__",
    levelLabel: "Attached Devices",
    sourceFileName: "attached.txt",
    width: 4
  });

  const lift = playData.actors.find((actor) => actor.type === "attached_lift");
  assert.ok(lift, "lift on weightless box converts to attached_lift actor");
  assert.equal(lift.elevation, 1);
  const gate = playData.actors.find((actor) => actor.type === "attached_gate");
  assert.ok(gate, "gate on clone converts to attached_gate actor");
}
