const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const playSource = fs.readFileSync(
  path.join(__dirname, "..", "public", "play.js"),
  "utf8"
);

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

async function main() {
  const outgoingLiveState = {
    levelId: "level_AxA",
    actors: [{ type: "box", x: 8, y: 2 }]
  };
  const outgoingEntryState = {
    levelId: "level_AxA",
    actors: [{ type: "box", x: 3, y: 2 }]
  };
  const outgoingResetState = {
    ...outgoingEntryState,
    prepared: true
  };
  const incomingState = {
    levelId: "level_BxA",
    actors: [{ type: "player", x: 0, y: 2 }]
  };
  let preparedSnapshot = null;
  let cachedSnapshot = null;
  let transitionData = null;
  let finishedLevelId = null;

  const app = {
    LEVEL_TRANSITION_DURATION_MS: 1000,
    currentLevelId: "level_AxA",
    levelEntrySnapshot: outgoingEntryState,
    applyLevelState: (levelState) => {
      app.currentLevelId = levelState.levelId;
      app.levelEntrySnapshot = incomingState;
    },
    loadLevelState: async () => incomingState,
    prepareLevelRenderState: (snapshot) => {
      preparedSnapshot = snapshot;
      return outgoingResetState;
    },
    rememberHorizontalNeighborLevelState: (snapshot) => {
      cachedSnapshot = snapshot;
    },
    preloadImagesForLevelState: async () => {},
    render: () => {},
    renderCompositor: {
      startLevelTransition: (...args) => {
        const options = args.at(-1);
        transitionData = options.transitionData;
        options.onComplete();
      }
    },
    threeRenderer: {
      prewarmAdjacentLevelTransition: () => {},
      whenLevelStateModelsReady: async () => {}
    }
  };
  const context = {
    app,
    document: {
      querySelector: () => null
    },
    playWorldData: { game: { id: "maze" } },
    playWorldMapTransitionSnapshot: () =>
      app.currentLevelId === "level_AxA" ? outgoingLiveState : incomingState,
    setWorldMapOpen: () => {},
    syncPlayHud: () => {
      finishedLevelId = app.currentLevelId;
    },
    syncPlayOverlayInputLock: () => {},
    window: {
      location: {
        assign: () => {
          throw new Error("world-map switch unexpectedly fell back to navigation");
        }
      }
    },
    worldMapCells: () => [
      { id: "level_AxA", columnIndex: 0, rowIndex: 0 },
      { id: "level_BxA", columnIndex: 1, rowIndex: 0 }
    ],
    worldMapSwitching: false
  };
  const switchSection = sourceSection(
    playSource,
    "function playWorldMapResetSnapshot(outgoingLevel)",
    "function installPlayControls()"
  );
  const switchPlayWorldLevel = vm.runInNewContext(
    `(() => { ${switchSection}; return switchPlayWorldLevel; })()`,
    context
  );

  await switchPlayWorldLevel("level_BxA");

  assert.equal(
    preparedSnapshot,
    outgoingEntryState,
    "teleport must prepare the room-entry snapshot before loading the destination"
  );
  assert.equal(
    cachedSnapshot,
    outgoingResetState,
    "teleport must replace the outgoing room cache with its reset state"
  );
  assert.equal(transitionData.outgoingLevel, outgoingLiveState);
  assert.equal(
    transitionData.outgoingResetLevel,
    outgoingResetState,
    "the reset animation must target original box positions"
  );
  assert.equal(transitionData.incomingLevel, incomingState);
  assert.equal(finishedLevelId, "level_BxA");

  console.log("play-world-map-reset: teleport exits restore the outgoing room entry state.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
