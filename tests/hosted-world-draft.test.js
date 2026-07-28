const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  defaultLevel
} = require("../shared/default-world-template");

const authorSource = fs.readFileSync(
  path.join(__dirname, "..", "public", "author.js"),
  "utf8"
);

function sourceSection(startMarker, endMarker) {
  const start = authorSource.indexOf(startMarker);
  const end = authorSource.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return authorSource.slice(start, end).trim();
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const parseLevelCoordinates = vm.runInNewContext(
  `(${sourceSection(
    "function parseLevelCoordinates",
    "function levelIdFromSelectors"
  )})`
);
const defaultHostedWorldLevelSource = sourceSection(
  "function defaultHostedWorldLevel",
  "function boardSignature"
);
const hostedWorldLevelRecordSource = sourceSection(
  "function hostedWorldLevelRecord",
  "function initializeHostedWorldDraft"
);

function compileDefaultHostedWorldLevel(worldWidth, worldHeight, window = {}) {
  return vm.runInNewContext(`(${defaultHostedWorldLevelSource})`, {
    parseLevelCoordinates,
    window,
    worldColumns: Array.from({ length: worldWidth }, (_, index) =>
      String.fromCharCode(65 + index)
    ),
    worldRows: Array.from({ length: worldHeight }, (_, index) =>
      String.fromCharCode(65 + index)
    )
  });
}

for (const [worldWidth, worldHeight] of [[1, 1], [3, 2], [4, 4]]) {
  const browserDefaultLevel = compileDefaultHostedWorldLevel(worldWidth, worldHeight);

  for (let rowIndex = 0; rowIndex < worldHeight; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < worldWidth; columnIndex += 1) {
      const column = String.fromCharCode(65 + columnIndex);
      const row = String.fromCharCode(65 + rowIndex);
      const levelId = `level_${column}x${row}`;

      assert.deepEqual(
        plain(browserDefaultLevel(levelId)),
        defaultLevel({ column, row, worldHeight, worldWidth }),
        `${levelId} in a ${worldWidth}x${worldHeight} hosted world must match the canonical template`
      );
    }
  }
}

const canonicalCalls = [];
const canonicalBrowserDefault = compileDefaultHostedWorldLevel(5, 2, {
  MazeBenchDefaultWorldTemplate: {
    defaultLevel(options) {
      canonicalCalls.push(options);
      return { marker: "canonical" };
    }
  }
});
assert.deepEqual(plain(canonicalBrowserDefault("level_DxB")), { marker: "canonical" });
assert.deepEqual(plain(canonicalCalls), [{
  column: "D",
  row: "B",
  worldHeight: 2,
  worldWidth: 5
}]);

const worldColumns = ["A", "B", "C"];
const worldRows = ["A", "B"];
const defaultHostedWorldLevel = compileDefaultHostedWorldLevel(
  worldColumns.length,
  worldRows.length
);
const authorData = {
  defaultFloorToken: ".",
  defaultHeight: 16,
  defaultWidth: 16,
  existingLevels: [
    {
      cells: [["saved"]],
      exists: true,
      height: 1,
      id: "level_AxA",
      label: "Saved AxA",
      width: 1
    }
  ],
  initialLevel: {
    cells: [["saved"]],
    exists: true,
    height: 1,
    levelId: "level_AxA",
    width: 1
  }
};
const hostedWorldLevelRecord = vm.runInNewContext(
  `(${hostedWorldLevelRecordSource})`,
  {
    authorData,
    cloneCells: (cells) => cells.map((row) => row.slice()),
    createBlankCells: (width, height, token) =>
      Array.from({ length: height }, () => Array.from({ length: width }, () => token)),
    defaultHostedWorldLevel,
    normalizeAuthoringCells: (cells) => cells.map((row) => row.slice()),
    parseLevelCoordinates
  }
);

const synthesized = hostedWorldLevelRecord(
  "level_BxB",
  { cells: [["featureless-placeholder"]], exists: false, height: 1, width: 1 },
  { synthesizeMissing: true }
);
assert.equal(synthesized.exists, false);
assert.deepEqual(
  plain(synthesized.cells),
  defaultLevel({
    column: "B",
    row: "B",
    worldHeight: worldRows.length,
    worldWidth: worldColumns.length
  }).cells
);

const editedMissingRoom = hostedWorldLevelRecord("level_BxB", {
  cells: [["edited-browser-draft"]],
  exists: false,
  height: 1,
  width: 1
});
assert.deepEqual(
  plain(editedMissingRoom.cells),
  [["edited-browser-draft"]],
  "staging a newly edited room must not replace its browser-local cells with the template"
);

const hostedWorldDraftLevels = new Map();
const hostedSavedLevelSignatures = new Map();
const initializeHostedWorldDraft = vm.runInNewContext(
  `(${sourceSection(
    "function initializeHostedWorldDraft",
    "function hostedWorldLevelEntries"
  )})`,
  {
    authorData,
    boardSignature: (width, height, cells) => JSON.stringify({ width, height, cells }),
    hostedSavedLevelSignatures,
    hostedWorldDraftLevels,
    hostedWorldDraftMode: true,
    hostedWorldLevelRecord,
    state: { levelId: "level_AxA" },
    worldColumns,
    worldRows
  }
);
initializeHostedWorldDraft();

assert.equal(hostedWorldDraftLevels.size, worldColumns.length * worldRows.length);
for (const row of worldRows) {
  for (const column of worldColumns) {
    const levelId = `level_${column}x${row}`;
    const level = hostedWorldDraftLevels.get(levelId);

    assert.ok(level, `${levelId} must be available without an API read`);
    if (levelId === "level_AxA") {
      assert.equal(level.exists, true);
      assert.deepEqual(plain(level.cells), [["saved"]]);
      continue;
    }
    assert.equal(level.exists, false);
    assert.deepEqual(
      plain(level.cells),
      defaultLevel({
        column,
        row,
        worldHeight: worldRows.length,
        worldWidth: worldColumns.length
      }).cells
    );
  }
}

const fetchCalls = [];
const cachedAuthorLevelPayload = vm.runInNewContext(
  `(${sourceSection(
    "function cachedAuthorLevelPayload",
    "async function fetchAuthorLevelPayload"
  )})`,
  {
    authorData: { separator: " " },
    cloneCells: (cells) => cells.map((row) => row.slice()),
    hostedWorldDraftLevels,
    hostedWorldDraftMode: true,
    hotbarTokens: () => [],
    localLevelThumbs: new Map(),
    playUrlForLevel: (levelId) => `/play/${levelId}`
  }
);
const fetchAuthorLevelPayload = vm.runInNewContext(
  `(${sourceSection(
    "async function fetchAuthorLevelPayload",
    "function applyAuthorLevelPayload"
  )})`,
  {
    authorData: { authorApiBaseUrl: "/api/author" },
    cachedAuthorLevelPayload,
    encodeURIComponent,
    fetch: async (...args) => {
      fetchCalls.push(args);
      throw new Error("hosted room switch unexpectedly issued an API read");
    }
  }
);

async function run() {
  for (const levelId of hostedWorldDraftLevels.keys()) {
    const payload = await fetchAuthorLevelPayload(levelId);
    assert.equal(payload.levelId, levelId);
  }
  assert.equal(fetchCalls.length, 0);

  const hostedDirtyLevelIds = new Set(["level_CxB"]);
  hostedWorldDraftLevels.set("level_CxB", {
    ...hostedWorldDraftLevels.get("level_CxB"),
    cells: [["newly-edited"]],
    height: 1,
    width: 1
  });
  const hostedWorldEditorStateSnapshot = vm.runInNewContext(
    `(${sourceSection(
      "function hostedWorldEditorStateSnapshot",
      "function applyHostedWorldSavePayload"
    )})`,
    {
      authorData: {
        game: { name: "Sparse hosted world" },
        initialLevel: { levelId: "level_AxA" },
        worldMeta: {}
      },
      cloneCells: (cells) => cells.map((row) => row.slice()),
      hostedDirtyLevelIds,
      hostedWorldLevelEntries: () => Array.from(hostedWorldDraftLevels.values()),
      hotbarTokens: () => [],
      stageCurrentHostedWorldLevel: () => {},
      worldColumns,
      worldRows
    }
  );
  const snapshot = hostedWorldEditorStateSnapshot();

  assert.deepEqual(
    plain(snapshot.levels.map((level) => level.id).sort()),
    ["level_AxA", "level_CxB"],
    "whole-world Save must keep saved and edited rooms while filtering untouched synthesized rooms"
  );

  const switchSection = sourceSection(
    "async function switchToNeighborLevel",
    "function formatSolverPath"
  );
  assert.match(
    switchSection,
    /if \(!hostedWorldDraftMode && outgoingWasDirty\) \{\s*const savedPayload = await saveLevel\(/
  );
  assert.doesNotMatch(
    switchSection,
    /if \(hostedWorldDraftMode && outgoingWasDirty\)[\s\S]*await saveLevel\(/
  );

  console.log("hosted-world-draft: canonical sparse rooms stay local and save sparsely");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
