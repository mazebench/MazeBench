# MazeEngine rewrite — API compatibility contract

Status: generated 2026-07-16 from a full scan of every engine consumer.
Source of truth being replaced: `public/maze-engine.js` (~8,266 lines, IIFE, assigns `window.MazeEngine`).

Anything listed here is load-bearing: a consumer reads or writes it at the cited
file:line. The rewrite must keep every item byte-compatible (same names, same
shapes, same numeric conventions) unless the cited consumers are updated in the
same change.

---

## 1. `window.MazeEngine` exports

The engine file is an IIFE with **no module exports** — it only assigns:

```js
window.MazeEngine = {
  createEngine,   // (playData) => engine instance
  terrainTypes    // { name: numericCode } map (see section 2)
};
```

(`public/maze-engine.js:8262-8265`)

The global object it attaches to must be `window` — workers create
`self.window = self` aliases or the loaders fake a `window`:

| Consumer | Access | Location |
| --- | --- | --- |
| play-movement.js | `window.MazeEngine` read once at factory setup; destructures `createEngine` | `public/play-movement.js:5` |
| author.js | `window.MazeEngine` (guarded, may be undefined); uses `.createEngine` | `public/author.js:822` |
| author-solver-worker.js | `self.MazeEngine.createEngine(...)` after `importScripts` | `public/author-solver-worker.js:56` |
| world-solver-worker.js | `self.MazeEngine.createEngine(...)` (twice) after `importScripts` | `public/world-solver-worker.js:48,69` |
| maze-solver.js | does **not** touch the global; receives an already-constructed `engine` instance as an argument to `solveWithAStar` / `findReachablePositions` / `findHardestGemPlacement` | `public/maze-solver.js` (whole file) |
| scripts/maze-terminal.js | `loadMazeEngine()` → `global.window.MazeEngine` (vm loader, see section 7) | `scripts/maze-terminal.js:518-527,3562` |
| scripts/maze-bridge.js | `loadMazeEngine` re-exported from maze-terminal; `.createEngine` | `scripts/maze-bridge.js:12,478` |
| tests | `window.MazeEngine.{createEngine, terrainTypes}` after vm load | `tests/maze-engine.test.js:7`, `tests/maze-solver.test.js:8`, `tests/engine-parity.test.js:299`, `tests/repros/*.js` |

**`terrainTypes` (top-level export)** — exact name→code map. The numeric codes
leak out of the engine: consumers reverse-map codes to names
(`scripts/maze-terminal.js:707-709` builds `typeNames[code] = name`), write
codes back into `state.terrain` (`scripts/maze-bridge.js:609`), and hash the
raw code arrays into replay scorecards (`boardStateHash`,
`scripts/maze-terminal.js:3045`). The rewrite must keep the same numeric codes:

```js
{
  empty: 0, floor: 1, wall: 2, exit: 3, ice: 4, hole: 5,
  player_gate: 6, player_lift: 7, orange_wall: 8, orange_button: 9,
  tree: 10, ice_block: 11, shrub: 12, block_asset: 13, ice_slope: 14
}
```

(`public/maze-engine.js:2-18`)

### Engine instance surface (returned by `createEngine`)

```js
{
  actorCount,                     // number — actors.length
  actorGroupIds,                  // string[] — actor.groupId ?? "" per index (currently no external consumer, keep anyway)
  actorTypes,                     // string[] — actor.type per index
  areOrangeButtonsPressed,        // (state) => boolean
  cellCount,                      // number — width*height (no external consumer found)
  cellIndex,                      // (x, y) => y * width + x
  cloneState,                     // (state) => new state buffer (deep copy)
  computeRaisedPlayerGateSet,     // (state) => Set<cellIndex> of raised gates
  copyStateInto,                  // (target, source) => void
  createStateBuffer,              // () => zeroed state buffer
  height,                         // number
  heuristic,                      // (state) => number (admissible A* h)
  initialState,                   // state buffer PROPERTY (not a function) — settled initial state
  isPlayerLift,                   // (x, y) => boolean (static terrain check)
  isPlayerMove,                   // (moveRecord) => boolean (actorType is player/circle_player/clone)
  isSolved,                       // (state) => boolean
  move,                           // (state, dx, dy, options?) => result (mutates state)
  moveForSearch,                  // (state, dx, dy) => result + nonPlayerMoveCount
  pressedOrangeWallLowersAsBlock, // (state, x, y, elevation) => boolean
  stateKey,                       // (state) => string
  terrainTypes,                   // same map as the top-level export
  undoMove,                       // (state, moveResult) => void
  width                           // number
}
```

(`public/maze-engine.js:8235-8259`)

There is **no** `availableMoves` or `collectedGems` on the engine
(`collectedGems` in `public/world-solver.js:579,883,910` is a world-solver
progress field, not an engine API).

Per-member consumers are detailed in sections 3–6. Members with **no** consumer
found anywhere (safe to keep but unused): `actorGroupIds`, `cellCount`.

---

## 2. `createEngine(playData)` inputs

`createEngine` reads exactly four fields off `playData`
(`public/maze-engine.js:153-165`):

| Field | Type | Normalization |
| --- | --- | --- |
| `width` | number | `Math.max(1, Number(playData?.width) \|\| 1)` |
| `height` | number | `Math.max(1, Number(playData?.height) \|\| 1)` |
| `terrain` | `cell[][]` indexed `terrain[y][x]` | missing rows/cells → `{type:"empty", raised:false}` |
| `actors` | `actor[]` | missing → `[]` |

### Terrain cell format

```js
{
  type: "floor",              // string key of terrainTypes; unknown → empty. Sets the BASE terrain code
                              // stored in state.terrain (flattened, used for hole-fill restore + stateKey diff).
  raised: true,               // only meaningful for player_lift (initial raised state)
  layers: [                   // optional; if absent/empty a single layer is synthesized from
                              // {type, elevation:0, raised} unless type is empty (then no layers)
    {
      type: "player_lift",    // string key of terrainTypes; empty layers are dropped
      elevation: 0,           // integer, clamped >= 0, non-integer → 0
      direction: "R",         // string or null — used by ice_slope; any non-string → null
      raised: false           // boolean, only layer.raised === true counts
    }
  ]
}
```

Normalization details the rewrite must preserve (`public/maze-engine.js:115-147,192-226`):
- Layers are **sorted ascending by elevation** after normalization.
- `baseLiftRaised[idx] = 1` when the base cell is a raised `player_lift` **or** any
  layer is a raised `player_lift`.
- Cells contribute to gate/lift/orange-wall/orange-button index lists when **any
  layer** has that type (base `type` counts via the synthesized layer).

### Actor format

```js
{
  type: "player",        // string; known types: player, circle_player, clone, gem, box,
                         // floating_floor, weightless_box, puncher, orange_button
                         // (plus decorative types the engine treats as unknown/blocking-neutral)
  x: 3, y: 4,            // integers; non-integer → 0
  elevation: 1,          // OPTIONAL — presence is detected with hasOwnProperty, not value!
                         // If absent, elevation is derived by stacking on earlier same-cell
                         // support actors (public/maze-engine.js:304-330) and, for players,
                         // re-settled onto the surface in createInitialState (:278-295).
  groupId: "a",          // any value, ?? "" — links clone groups and weightless clusters
  direction: "right",    // or `facing` — puncher direction; accepts left/up/down/right,
                         // l/u/d, "-1,0"-style vectors; default "right" (:79-95,168-170)
  removed: false         // truthy → actor starts removed (state.actorRemoved = 1);
                         // a gem with removed:true at load is excluded from isSolved's
                         // "any gem removed" win check (initialGemRemoved, :183-185,8164-8173)
}
```

**`initialState` is not a raw copy of the inputs.** `createInitialState`
(`public/maze-engine.js:246-298`) runs up to 4 weightless-group settle
iterations and recomputes player elevations from the surface (skipped for
actors with an explicit `elevation` property). Consumers snapshot
`engine.initialState` (e.g. `scripts/maze-bridge.js:391` reads
`engine.initialState?.liftRaised?.[index]` to report "initially raised" lifts),
so the settled values are contract, not an implementation detail.

### `move(state, dx, dy, options)` options (all optional)

Complete set read inside `move()` (`public/maze-engine.js:7065-7068,7247`):

| Option | Meaning | External callers |
| --- | --- | --- |
| `search` | suppress visual-only records and animation fields (iceSlide/fadeOut/levelExit/etc.) | via `moveForSearch` only |
| `attemptSnapshot` | reusable state buffer for internal clone-move rollback | via `moveForSearch` (engine-internal buffers) |
| `occupiedSnapshot` | reusable Set for internal rollback | via `moveForSearch` |
| `continuePunchSlide` | continue a punch-slide (momentum) step; marks records `punchSlide`, allows off-board `levelExit` with `sourceType:"punch"` | `public/play-movement.js:317,413` (values originate in `play-gameplay.js:1892,2644,2664,3158` and `play-world-transitions.js:171`) |
| `startOnCurrentSlope` | begin movement by resolving the slope under the actor first (`maze-engine.js:7247`) | `public/play-movement.js:318,414` (from `play-gameplay.js:2643,2666,3159,3467` and `play-world-transitions.js:172`) |

No other caller passes options: the solvers and all scripts call
`moveForSearch(state, dx, dy)` / `move(state, dx, dy)` positionally.

`move` **mutates** `state` in place and returns the result object (section 4).

---

## 3. State buffer contract

`createStateBuffer()` (`public/maze-engine.js:412-421`) — a state is a plain
object of 6 typed arrays; **all six fields and their exact types/indexing are
public contract**:

```js
{
  actorElevation: Int16Array(actorCount),
  actorRemoved:   Uint8Array(actorCount),   // 0 | 1
  actorX:         Int16Array(actorCount),
  actorY:         Int16Array(actorCount),
  liftRaised:     Uint8Array(cellCount),    // indexed by cellIndex(x,y); 0 | 1
  terrain:        Uint8Array(cellCount)     // terrainTypes codes; base type per cell
}
```

`cloneState` must return the same shape with fresh arrays; `copyStateInto`
copies all six (`:423-441`).

### Direct state-field READS (rewrite must keep these fields readable)

| File:line | Fields | What the consumer does |
| --- | --- | --- |
| `public/play-movement.js:59-62` | `actorElevation`, `actorRemoved`, `actorX`, `actorY` | after each engine move, copies engine truth back onto the app's actor objects (`actorSnapshotsFromEngineState`) |
| `public/author.js:559-561,582-584` | `actorX`, `actorY`, `actorElevation` | ghost-path overlay: player position before/after each replayed solver move |
| `public/maze-solver.js:554-558` | `actorRemoved`, `actorX`, `actorY`, `actorElevation` | `recordReachedPositionTargets` builds `"x,y,elev"` keys for reachability targets |
| `scripts/maze-bridge.js:205-207,217,229-234` | `actorX`, `actorY`, `actorElevation`, `actorRemoved` | gem ids, visible gems, active-player JSON views for agents |
| `scripts/maze-bridge.js:387-391` | `terrain`, `liftRaised` + `engine.initialState.terrain/.liftRaised` | diffs live state vs initial to emit render terrain-overrides (code reverse-mapped via inverted `terrainTypes`) |
| `scripts/maze-bridge.js:409-412` | `actorElevation`, `actorRemoved`, `actorX`, `actorY` | `_render_state` snapshot consumed by maze-render-frame |
| `scripts/maze-terminal.js:737,819,857,918,3045` | `terrain` | `typeNames[state.terrain[index]]` board glyphs; `Array.from(state.terrain)` in `boardStateHash` |
| `scripts/maze-terminal.js:772,810,848,1033-1034,2353,3046` | `liftRaised` | raised-lift surface heights/glyphs; `Array.from(state.liftRaised)` in `boardStateHash` |
| `scripts/maze-terminal.js:1415,1774,1961,2007,2530,2646` | `actorRemoved` | skip removed actors when rendering |
| `scripts/maze-terminal.js:1427-1447,1465-1468,1785-1786,1976-1977,2408-2409,2538-2539,2617-2618,3040-3041` | `actorX`, `actorY` | actor placement in ASCII/3D renders + hash |
| `scripts/maze-terminal.js:1423,1442,1463,1791,1796,1983,2011,2405,2534,2619,3042` | `actorElevation` | elevation badges/render + hash |
| `tests/maze-engine.test.js:114,757,1010-1011,1834` | `actorRemoved`, `terrain`, `actorX/Y`, `actorElevation` | assertions |
| `tests/engine-parity.test.js:221-225` | `actorX`, `actorY`, `actorElevation`, `actorRemoved` | actor snapshots compared against the object runtime |
| `tests/repros/*.js` (~65 files) | all actor arrays + `terrain` via `cellIndex` | standalone repro assertions |

`boardStateHash` (`scripts/maze-terminal.js:3029-3050`) hashes
`Array.from(state.terrain)` and `Array.from(state.liftRaised)` plus per-actor
tuples — array lengths, ordering, and numeric codes are all hash inputs, so
replays/scorecards notice any representational change.

### Direct state-field WRITES (the state must stay externally mutable)

| File:line | Fields | Purpose |
| --- | --- | --- |
| `scripts/maze-terminal.js:2634` | `actorRemoved[index] = 1` | mark already-collected gems removed when re-entering a room |
| `scripts/maze-bridge.js:367` | `actorRemoved[index] = 1` | apply collected gems to a restored context |
| `scripts/maze-bridge.js:587-592` | `actorX/actorY/actorElevation/actorRemoved` | checkpoint restore: per-actor teleport |
| `scripts/maze-bridge.js:598-601` | player `actorX/Y/Elevation`, `actorRemoved = 0` | checkpoint restore: player fallback teleport |
| `scripts/maze-bridge.js:609-612` | `terrain[index] = engine.terrainTypes[type]`, `liftRaised[index] = 0/1` | terrain/lift overrides — writes codes via the **instance** `terrainTypes` map |
| `tests/maze-engine.test.js` + repros | `terrain[cellIndex(x,y)] = terrainTypes.floor` etc. | scenario setup mid-test |

The engine must keep tolerating external writes between `move()` calls: every
`move()` recomputes occupancy/gates/buttons from the raw buffers, no hidden
caches keyed on state identity (the rewrite must preserve this — maze-bridge
edits state directly and then keeps calling `move`/`isSolved`/`stateKey`).

**Not engine state (do not confuse):** `app.state.terrain[y]?.[x]`
(`public/play-core.js:1854`), `levelState.terrain[y][x]`
(`public/play-world-transitions.js:82`, `scripts/maze-render-frame.js:606`),
`state.terrain[boundaryY]?.[boundaryX]` (`public/play-gameplay.js:3194`), and
`playData.terrain[y]?.[x]` (`scripts/maze-terminal.js:738,919`) are the
app-side 2D object-cell states, not the engine buffer.

---

## 4. `move()` / `moveForSearch()` result contract

### Result object

```js
{
  direction: "L"|"U"|"D"|"R"|"",       // from directionNames lookup of `${dx},${dy}`
  liftToggles: [{ x, y, raised }],      // lifts toggled this move; `raised` = new state
  moved: boolean,                       // moves.length > 0
  moves: [moveRecord, ...],             // ordered; may contain visualOnly records
  nonPlayerMoveCount: number            // moveForSearch ONLY (0 when !moved) — counts distinct
                                        // non-player, non-gem, non-puncher/button actors that
                                        // actually changed cell (maze-engine.js:8083-8124)
}
```

`undoMove(state, result)` consumes `result.moves` (in reverse, skipping
`visualOnly`) and `result.liftToggles` — so both must contain **exactly** what
was applied (`public/maze-engine.js:8126-8162`). Undo restores
`fromX/fromY/fromElevation/fromRemoved` per record and un-fills holes via
`fillsHole`/`fillHoleX`/`fillHoleY`/`fillHolePreviousTerrain`.

### Move record — complete field inventory

Base fields present on every record: `actorIndex`, `actorType`, `fromX`,
`fromY`, `toX`, `toY`. Elevation fields `fromElevation`/`toElevation` are on all
positional records; gem-collect records instead carry
`fromRemoved:false`/`toRemoved:true` (`public/maze-engine.js:3024-3033`).
Optional fields by feature:

- slides/paths: `path` ([{x,y,elevation}]), `pathControlsElevation`,
  `pathEndElevation`, `iceSlide`, `iceSlipOff`
- punches: `punchSlide`, `punchEffect`, `punchSequence`, `punchSegments`
  ([{sequence, fromX, fromY, fromElevation, toX, toY, toElevation,
  startIceSlide, punchSlide}], `:5113-5123`), `punchStartX`, `punchStartY`,
  `punchStartElevation`, `punchStartIceSlide`, `targetX`, `targetY` (puncher
  lunge visual, `:5157-5175`)
- visual-only records: `visualOnly:true`, `finalX`, `finalY`, `finalElevation`
  (rest position distinct from the `toX/toY` lunge/overshoot point)
- level exit: `levelExit:true`, `levelExitDx`, `levelExitDy`,
  `levelExitElevation`, `levelExitSourceType` ("ice_slope" | "punch" |
  undefined-source from slope traversal)
- removal/holes: `toRemoved`, `fromRemoved`, `fillsHole`, `fillHoleX`,
  `fillHoleY`, `fillHolePreviousTerrain`, `skipHoleFall`, `visibleDuringMove`,
  `snapHoleRestore` (merged if set, `:4984-4986`; also synthesized by
  play-gameplay for rewind records)
- gem fade: `fadeOut`, `fadeStartProgress`, `fadeEndProgress`

Search mode (`moveForSearch`) suppresses: all visual-only records, `iceSlide`,
`punchSlide`, `iceSlipOff`, `levelExit*`, `fadeOut/fade*Progress`,
`skipHoleFall`, `visibleDuringMove`, `punchEffect` records. Search-mode records
still carry `toRemoved`, `fillsHole` + `fillHole*` (needed by `undoMove`), and
`path`/`pathEndElevation` when elevation changes en route.

After `collapseSequentialActorMoves` + merging, an actor has at most one
non-visualOnly record per `move()`; merge semantics are in `mergeActorMoveData`
(`public/maze-engine.js:4950-5039`).

### Per-field consumers (file:line → what it does)

Fields are listed with every consumer found; play-file line numbers below are
from the consumer scan and are the authoritative touch points.

#### Result-object fields

| Field | Consumers | Use |
| --- | --- | --- |
| `moved` | `public/maze-solver.js:306,482,661` (skip unproductive branch); `public/author.js:568,5790` (stop ghost path / replay); `public/play-movement.js:355,419` (spread through, then overridden with `moves.length > 0`); `public/play-gameplay.js:1731,1750,1769,2530` (via movement results); `scripts/maze-terminal.js:2691,2900` (stats + undo-snapshot gate); `scripts/maze-bridge.js:667` (agent snapshot `moved`); `tests/maze-engine.test.js:111`, `tests/engine-parity.test.js:326-334` (parity: must equal the object-runtime's moved flag) | boolean gate everywhere |
| `moves` | `public/play-movement.js:320,416` (maps records, attaches `.actor`); `public/play-gameplay.js:1731-1782,2302,2534,3430` (animation pipeline); `public/maze-solver.js:181-195,369` (reward + gem endpoints); `public/author.js:569,5794` (ghost path, affected cells); `scripts/maze-bridge.js:291-311` (pushed-block detection); tests throughout | the core payload |
| `liftToggles` | `public/play-movement.js:340,380,388` (reads each `{x,y,raised}` → `setPlayerLiftRaised`); engine's own `undoMove` (`maze-engine.js:8157-8161`); `tests/maze-engine.test.js:640,665` (deep-equals `[{x,y,raised}]`) | must contain exactly the toggles applied, `raised` = new state |
| `nonPlayerMoveCount` | `public/maze-solver.js:175-176` (weighted-A* search reward, capped) | must be finite when `moveForSearch` is used; solver falls back to counting `moves` if not |
| `direction` | **no consumer reads it** (rides along via spread at `play-movement.js:355,419`) | keep for safety; "L"/"U"/"D"/"R"/"" |

#### Move-record fields

Records must be **plain, extensible, mutable objects**: play-movement bolts on
`record.actor` (`public/play-movement.js:44-51`) and writes `iceSlide`,
`reverseIceSlide`, `path`, `pathControlsElevation`, `pathEndElevation` back
onto records during undo animation (`public/play-movement.js:200-211`);
play-gameplay adds `snapHoleRestore` (`public/play-gameplay.js:1685`).

| Field | Consumers (file:line) | Use |
| --- | --- | --- |
| `actorIndex` | `play-movement.js:44,182`; `play-gameplay.js:1676`; `maze-solver.js:194,570` (dedupe/player filter); `author.js:570`; `maze-bridge.js:308`; engine `undoMove:8138`; `tests/maze-engine.test.js:1037` | joins record to actor arrays |
| `actorType` | `maze-solver.js:186` (`=== "gem"`); `play-gameplay.js:2318,2324`; `maze-bridge.js:296` (pushable filter: box/floating_floor/weightless_box); `engine.isPlayerMove`; `tests/maze-engine.test.js:161`; `moveForSearch` count filter `maze-engine.js:8096-8098` | type dispatch |
| `fromX`/`fromY` | `play-movement.js:136-144,189-194`; `play-gameplay.js` pervasive (L128,414-419,455-457,840-947,971-1035,1059-1075,1160-1183,1276-1340,1366-1446,1507-1552,1621-1692,1841-1853,1931-1932,2305-2340,2387-2432); `maze-solver.js:190` (no-op filter); `author.js:5766`; `maze-bridge.js:299-306`; `undoMove:8140-8141`; tests | animation start, displacement checks, undo restore |
| `toX`/`toY` | `play-movement.js:98,136-144,189-194,237-248,290-299`; `play-gameplay.js` pervasive (same ranges); `maze-solver.js:190,376,380`; `author.js:577,5767`; `maze-bridge.js:299-311`; tests | animation end, final position apply |
| `fromElevation` | `play-movement.js:95,136-144,189-194`; `play-gameplay.js:416-419,486-487,656,693,770,817,849-850,1063-1122,1170-1185,1316-1341,1509-1553,1625-1692,1894,1927-1958,2290-2338,2399-2432`; `maze-bridge.js:299-306`; `undoMove:8142` (`?? 0`); `tests/maze-engine.test.js:643,669` | elevation animation + undo restore. Gem-collect records have **no** elevation fields (`maze-engine.js:3024-3033`) — undo relies on the `?? 0` default plus separate dynamic-sync records; preserve exactly (guarded by `tests/repros/repro-elevated-gem-undo.js`, `repro-gem-elevation-undo.js`) |
| `toElevation` | `play-movement.js:96,117,136-144,237-248`; `play-gameplay.js` (same ranges as fromElevation); `maze-solver.js:358,374,376` (gem endpoint key, floored); `author.js:577`; `maze-bridge.js:299-311`; tests:568,644 | landing elevation |
| `finalX`/`finalY`/`finalElevation` | `play-movement.js:237-248` (rest position after visual lunge); `play-gameplay.js:505-548,1204-1207,1361-1362,1539-1542,2305-2329` | where the actor logically ends when `toX/toY` is an overshoot point (puncher lunge) |
| `fromRemoved` | `play-gameplay.js:681,703,757,1065,1168,1457,1530,1554-1571,1623-1692,3433`; `undoMove:8143` | respawn/hole-fall animation + undo restore |
| `toRemoved` | `play-gameplay.js:682,704,758,1068,1088-1104,1173,1453-1571,1624-1699,1742,1761,1781,3434`; `play-movement.js:237-248`; `maze-solver.js:354` (reject gem endpoints on removed player moves); tests:446,581 | removal (hole fall / gem collect) |
| `path` (`[{x,y,elevation}]`) | `play-movement.js:136-144,157-164,204-211`; `play-gameplay.js:133,148-158,163-165,186-220,233-266,275-277,289-298,389,474,491,658,670,674,852,1010,1186,1414,1438`; `maze-solver.js` (indirect via engine); `author.js:574-575,5769-5770`; tests:499,533 | multi-cell slide animation; point fields `x`,`y`,`elevation` all read |
| `pathControlsElevation` | `play-movement.js:139,204-211`; `play-gameplay.js:658,683` | whether elevation follows path points |
| `pathEndElevation` | `play-movement.js:204-211`; `play-gameplay.js:659,674` (derived/fallback) | slide end elevation |
| `iceSlide` | `play-movement.js:134,200`; `play-gameplay.js:134,391,451,528,535,927,967,1011,1024,1176,1188,1324,1349,1400,1430,1744,1763`; tests:923,944 | slide animation gating |
| `iceSlipOff` | **no external consumer** (engine-internal flag, emitted `maze-engine.js:7933,2925`) | keep emitting; safe to leave unread |
| `punchSlide` | `play-gameplay.js:421,451,535,927,967,1322-1323,1400,1874,1886,1971,2001` | punch-momentum animation + continuation decisions |
| `punchEffect` | `play-gameplay.js:403,1178,1196` | puncher lunge visual |
| `punchSequence` | `play-gameplay.js:561,574,594,789,2311` | ordering simultaneous punch visuals |
| `punchSegments` (`[{sequence, fromX, fromY, fromElevation, toX, toY, toElevation, startIceSlide, punchSlide}]`) | `play-gameplay.js:407,411-422` (normalization reads every sub-field), 442-445,476-488,855-946,1251-1332,1841-1842,2284-2425; `tests/maze-engine.test.js:2700,2838` | multi-stage punch animation |
| `punchStartX`/`punchStartY`/`punchStartElevation`/`punchStartIceSlide` | `play-gameplay.js:399,496,519,528,971-973,987,1003-1005,1394-1417,1852-1853,2403-2405` | where the punch impulse began |
| `targetX`/`targetY` | emitted on puncher visual records (`maze-engine.js:5162-5163`); consumed inside the punch-visual pipeline in play-gameplay | punch target cell |
| `visualOnly` | `play-movement.js:245,290-299,349`; `play-gameplay.js:403,702,835,1741,1760,1780,2535,3432`; `maze-solver.js:570` (author path uses `!move.visualOnly`); `author.js:570`; `maze-bridge.js:293`; engine `undoMove:8134` skips them; tests:1012,1042 | marks animation-only records — no logical state change |
| `visibleDuringMove` | `play-gameplay.js:1066,1078,1169,1457,1688` | keep actor rendered while removing |
| `skipHoleFall` | `play-movement.js:237-248`; `play-gameplay.js:759,1532,1554-1558,1686` | suppress hole-fall animation (gem collect, floating_floor fill) |
| `snapHoleRestore` | merged by engine if present (`maze-engine.js:4984-4986`); **produced by** `play-gameplay.js:1685` on app-built rewind records, read at 760-761 | app round-trips it through record shape |
| `fillsHole`/`fillHoleX`/`fillHoleY` | `play-movement.js:279-284` (writes app 2D terrain to floor); engine `undoMove:8145-8153` + `applyMoveFinalState` (`maze-engine.js:6141` sets `state.terrain[cell]=floor`) | floating_floor hole fill |
| `fillHolePreviousTerrain` | engine `undoMove:8150-8153` only — **no external consumer**, but required for undo correctness | prior terrain code for restore |
| `fadeOut` | `play-gameplay.js:1067,1088,1104,1172,1453,1534,1556` | gem fade |
| `fadeStartProgress`/`fadeEndProgress` | `play-gameplay.js:99,1174-1175,1454` | fade timing (fractions of move progress) |
| `levelExit` | `play-gameplay.js:1763,1782`; `tests/maze-engine.test.js:161,2752` | triggers room/world transition |
| `levelExitDx`/`levelExitDy` | `play-gameplay.js:1784-1785,1829-1832` | exit direction |
| `levelExitElevation` | `play-gameplay.js:1927-1928` | entry elevation in next room |
| `levelExitSourceType` | `play-gameplay.js:1926` (`"ice_slope"` \| `"punch"` \| undefined) | continuation style across rooms |
| `reverseIceSlide` | app-only field written by `play-movement.js:201`, read `play-gameplay.js:865,988,1012,1025,1177,1193,1262,1411,1430` — never emitted by the engine | records must tolerate extra app fields |

---

## 5. `stateKey` usage

### Format (must stay byte-identical if keys are persisted; see below)

`public/maze-engine.js:446-476` — compact string built with
`String.fromCharCode(clamp(value|0, 0, 65534))`:

1. Per actor (in index order): `charCode(actorX+1) + charCode(actorY+1) +
   charCode(actorElevation + 1024) + charCode(actorRemoved)`
2. `"￿"` separator
3. Terrain diff vs `baseTerrain` (creation-time flattened base types):
   `charCode(cellIndex) + charCode(code)` per differing cell, ascending index
4. `"￿"` separator
5. Lift diff vs `baseLiftRaised`, only over `playerLiftCells` (cells that had a
   player_lift layer at creation), ascending: `charCode(cellIndex) + charCode(0|1)`

Assumptions baked in: elevations ≥ −1024, coordinates ≥ −1, board ≤ 65534
cells, and keys are **only comparable between engines built from identical
playData** (diffs are relative to that engine's base arrays).

### Consumers

Only `public/maze-solver.js` and tests call `stateKey`:

| File:line | Usage |
| --- | --- |
| `public/maze-solver.js:245,316` (`solveWithAStar`) | root key + post-`moveForSearch` key; stored in `bestCostByKey = new Map()` (`:237`) as Map keys with integer cost values; pruning via `Map.get/has` |
| `public/maze-solver.js:432,488` (`findHardestGemPlacement`) | same pattern, `:423` Map |
| `public/maze-solver.js:599,663` (`findReachablePositions`) | same pattern, `:588` Map |
| `tests/maze-engine.test.js:1802-1811` | asserts key **changes** after `moveForSearch` and is **byte-identical** after `undoMove` |
| `tests/repros/repro-bounce-moved.js`, `repro-puncher-oob.js`, `repro-elevated-gem-undo.js`, `repro-ice-slipoff-search.js`, `repro-stacked-lift.js`, `repro-gem-elevation-undo.js`, `repro-m0-m4-identical.js`, `repro-clone-gem.js` | same key-equality assertions around move/undo cycles |

**Persistence: none.** Keys live only in per-call in-memory Maps inside a
single solver invocation; they are never postMessaged, JSON-serialized, or
stored (`localStorage`/disk). The author editor's persisted "solution key" is a
cell-token serialization + UDLR path string (`public/author.js:516-519`), not a
stateKey. `scripts/maze-terminal.js` hashes board state itself
(`boardStateHash`, `:3029-3050`) from the raw buffers, not via stateKey.

**Rewrite freedom:** the format may change, provided keys remain (a)
deterministic pure functions of the state buffers for a given engine instance,
(b) equal iff states are equal within that instance (undo must round-trip to
the identical string), and (c) cheap — they are computed once per expanded
node in three hot search loops.

---

## 6. Other engine methods — consumers

| Member | Consumers (file:line) | Notes |
| --- | --- | --- |
| `move(state,dx,dy,opts)` | `public/play-movement.js:316,412` (with options, see section 2); `scripts/maze-terminal.js:2898` (positional only); `tests/maze-engine.test.js:109+`, `tests/engine-parity.test.js:326`, repros | mutates state in place; only interactive callers |
| `moveForSearch(state,dx,dy)` | `public/maze-solver.js:300,476,660`; `public/author.js:567,5788`; `tests/maze-engine.test.js:772,1803,1830`; `tests/author-editor-interactions.test.js`; repros | hot path; must reuse internal snapshot buffers (perf contract from the 2026-07 perf overhaul) |
| `undoMove(state,result)` | `public/maze-solver.js:320,338,501,518,677` (backtracking after every expansion — the mutate→key→clone-if-kept→undo pattern); `tests/maze-engine.test.js:778,1809,1836`; `tests/weightless-push.test.js` (via app); repros | play files and maze-terminal use their **own** app-level undo (snapshot history), not this |
| `isSolved(state)` | `public/maze-solver.js:271`; `scripts/maze-bridge.js:459`; `scripts/maze-terminal.js:3019,3068`; `tests/maze-engine.test.js:112`; ~15 repros | win = any gem newly removed (vs `initialGemRemoved`), or player co-located with a live gem at same elevation (`maze-engine.js:8164-8196`) |
| `heuristic(state)` | `public/maze-solver.js:254,333`; `tests/repros/repro-ice-astar.js`, `repro-gem-elevation-undo.js` | must stay admissible (min Manhattan+elevation distance player→gem, 0 if none); weighted-A* correctness depends on it |
| `cloneState(state)` | `public/play-movement.js:313,411`; `public/author.js:535`; `scripts/maze-terminal.js:586,595,608,2819`; `scripts/maze-bridge.js:621`; `tests/engine-parity.test.js:300`; ~65 repros | fresh buffers, deep copy of all six arrays |
| `copyStateInto(target,source)` | `public/maze-solver.js:109` (state pool); `public/author.js:5779` | copies all six arrays |
| `createStateBuffer()` | `public/maze-solver.js:106` (pool allocation); `public/author.js:5776` | zeroed buffers, correct lengths |
| `initialState` (property) | `public/play-movement.js:313,411`; `public/maze-solver.js:244,431,598`; `public/author.js:535,5779`; `scripts/maze-terminal.js:586,2819`; `scripts/maze-bridge.js:385,391` (reads `.terrain`/`.liftRaised` to diff against current state for render overrides); tests/repros everywhere | settled state (see section 2); consumers treat it as read-only but reachable |
| `stateKey(state)` | see section 5 | |
| `isPlayerMove(record)` | `public/maze-solver.js:186,354` | true for player/circle_player/clone actorType |
| `actorCount` | `public/maze-solver.js:550`; `scripts/maze-terminal.js:1414,1773,1960,2006,2397,2528,2630,2643,3033`; `scripts/maze-bridge.js:214,226,363,586`; `tests/engine-parity.test.js:243,247` | loop bound over actor arrays |
| `actorTypes` | `public/maze-solver.js:551`; `scripts/maze-terminal.js:1420,1778,1965,2012,2403,2531,2537,2631,2644,3039`; `scripts/maze-bridge.js:215,227,364` and `:596` (**`.findIndex(...)`** — must stay a real `Array` of strings, not a typed array); `tests/engine-parity.test.js:220`; repros | index-aligned with playData.actors |
| `actorGroupIds` | none | keep exporting |
| `areOrangeButtonsPressed(state)` | `scripts/maze-terminal.js:715-718` (typeof-guarded wrapper); repros (`repro-orange-clone.js` etc.) | `play-core.js`'s same-named function is app-local, not this |
| `pressedOrangeWallLowersAsBlock(state,x,y,elevation)` | `scripts/maze-terminal.js:721-724` (typeof-guarded); `tests/repros/repro-orange-wall-lower-into-actor.js` | |
| `computeRaisedPlayerGateSet(state)` → `Set<cellIndex>` | `tests/maze-engine.test.js:2372,2393,2415`; repros (`gate-box-repro.js`, `repro-punch-gate.js`, `repro-ride-into-blocked.js`, `repro-gem-support.js`) | all play-file/`author.js` calls of this name are the **app-local** function (`play-core.js:2287`), not the engine's |
| `isPlayerLift(x,y)` | none (play-file hits are app-local `play-core.js:1965`) | keep exporting |
| `cellIndex(x,y)` | `tests/maze-engine.test.js:757`; ~10 repros | `y*width+x` — repros index `state.terrain` with it; `scripts/maze-terminal.js:711-713` reimplements it locally with the same formula |
| `cellCount` | none | keep exporting |
| `width` / `height` | none found outside the engine (scripts use `playData.width/height`) | keep exporting |
| `terrainTypes` (instance) | `scripts/maze-terminal.js:707-709` (inverted to `code→name`; built at 879,907,1376,2019,2133,2367); `scripts/maze-bridge.js:383` (inverted for render overrides), `:608-609` (name→code writes into `state.terrain`) | must be the same name↔code map as the top-level export |

---

## 7. Loading mechanisms

The rewrite must remain a **single, self-contained, classic (non-module)
script** that runs with no DOM and assigns `window.MazeEngine`. Every loader
below breaks otherwise (no `export`/`import`, no `require`, no `document`
access at load time, safe under `"use strict"`-less vm evaluation).

### Browser pages (script tag)
- `server/pages.js:80` — `<script src="/maze-engine.js" defer></script>`, the
  last entry of the `RUNTIME_SCRIPTS` template (lines 72-80) after
  `play-rules.js`, `play-core.js`, `play-render-*.js`, `play-render.js`.
  Consumers read `window.MazeEngine` lazily (per move), so load order after
  play scripts is fine.
- Served by a hand-rolled static map: `server/app.js:46` registers
  `"/maze-engine.js"` in `PUBLIC_FILE_ROUTES` → `server/router.js:50-53`
  `sendFile`s it. The public URL and filename `/maze-engine.js` are contract.
- `server/maze-levels.js` and `server/maze-preview.js` have **no** engine
  usage (verified — pure level-file and preview-PNG services).

### Web workers (importScripts)
- `public/world-solver-worker.js:4-5` — `self.window = self;` then
  `importScripts("maze-engine.js", "maze-solver.js");` → uses
  `self.MazeEngine.createEngine` (:48,:69). Relative URL ⇒ file must stay
  siblings with the worker script under `/`.
- `public/author-solver-worker.js:14-15` — identical pattern; engine used at :56.
- The `self.window = self` alias means the engine's `window.MazeEngine`
  assignment must work when `window === self` (no window-specific APIs).

### Node CLI (vm, shared global context)
- `scripts/maze-terminal.js:508-522` — `loadBrowserScript` =
  `fs.readFileSync(public/maze-engine.js)` + **`vm.runInThisContext`** (real
  global scope, `global.window = global.window || {}` shim); `loadMazeEngine()`
  returns `global.window.MazeEngine` (:518-522, called at :3562, exported :3608).
- `scripts/maze-bridge.js:12,478` — imports `loadMazeEngine` from
  maze-terminal and builds `session.context = {engine, state, ...}` via
  `createTerminalContext` (maze-terminal.js:687-698).
- Everything else in `scripts/` reaches the engine only through subprocesses:
  `codex-play.js`/`maze-model-repl.js`/`maze-export-replay.js` spawn
  `maze-bridge.js`; `maze-prime-run.js` spawns `maze-terminal.js`;
  `maze-mcp-server.js` spawns `codex-play.js`; the former
  `maze-agent-local.js` entry point is retired and fails closed;
  `maze-render-frame.js` drives the browser app (`window.__PIXEL_GAME_APP__`)
  in Playwright and consumes maze-bridge's `_render_state` snapshots — none of
  them load the engine directly.

### Tests (vm loader)
- `tests/helpers/browser-module-loader.js:11-19` — `loadBrowserScript` via
  **`vm.runInThisContext`**; callers do `global.window = {}` first
  (`tests/maze-engine.test.js:4-7`, `tests/maze-solver.test.js:4-8`,
  `tests/engine-parity.test.js:111-116`, all ~65 `tests/repros/*.js`).
- `tests/world-solver-worker.test.js` stubs `importScripts` with
  `vm.runInContext` over `public/` — the engine must load in a bare fake-worker
  context too.
- `tests/engine-parity.test.js` is the behavioral contract: it drives one
  persistent engine (`createEngine`:299, `cloneState(initialState)`:300,
  `move`:326) against the play-core object runtime and requires every actor's
  `{type,x,y,elevation,removed}` and the `moved` flag to match after every
  scripted move (:209-266).
- `tests/runtime-drift.test.js` calls `computeRuntimeDrift()` — see mirror
  below; the rewrite must be re-mirrored or this test fails.

### Runtime mirror (sync-runtime)
`scripts/sync-runtime.js` mirrors runtime files into
`environments/mazebench/mazebench/runtime` for the MazeBench Python
environment. The authoritative selection is `MIRRORED_DIRECTORIES` and
`MIRRORED_FILES` near the top of that script; directories are copied
recursively and individual files are copied exactly. The selection includes
the game assets and levels, browser/server runtime, environment metadata, and
the isolated game-control scripts such as `scripts/maze-mcp-client.js`.
`tests/runtime-drift.test.js` compares every selected file byte-for-byte, so
this contract does not duplicate a second list that can become stale.

### playData producers feeding `createEngine`
- `public/play-movement.js:22-35` — runtime → engine: actors mapped to
  `{elevation, direction, groupId, removed, type, x, y}`; the app's 2D
  `state.terrain` passed straight through.
- `public/author-play-data.js:464-489,777-833` — editor → playData: cells
  `{type, direction, label, imageUrl, modelUrl, layers, underlay, raised}`
  with layers `{type, label, imageUrl, modelUrl, direction, elevation,
  raised}`; actors `{type, groupId (weightless_box/clone token, else null),
  label, imageUrl, modelUrl, direction, elevation, x, y}` — note authored
  actors carry **no `removed` and no `facing`**; extra presentation fields
  (label/imageUrl/underlay/…) must keep being ignored by the engine.
- `public/world-solver-worker.js:25-32` — `gemPlayData` spreads playData,
  strips all gems, appends `{...gem, removed:false, type:"gem"}`.
- `public/world-solver.js:180-196` — builds playData from the live runtime
  (extra fields `gameId`, `levelId` ride along, ignored by the engine).

---

## 8. Riskiest contract points (rewrite checklist)

1. **External state mutation between moves** — `scripts/maze-bridge.js` writes
   directly into `actorX/actorY/actorElevation/actorRemoved/terrain/liftRaised`
   (teleports, checkpoint restore, terrain overrides) and then keeps calling
   `move`/`isSolved`/`boardStateHash` on the same engine. No internal caching
   keyed on state identity is allowed.
2. **State buffers are the wire format** — six named typed arrays with exact
   element types/order; `maze-terminal`'s `boardStateHash` serializes
   `Array.from(state.terrain)`/`liftRaised` into scorecards.
3. **`actorTypes` must stay a plain `Array`** (`findIndex`/`map` used on it);
   `initialState` must stay a readable property holding the *settled* state.
4. **`undoMove` round-trip** — solver correctness depends on
   mutate → `stateKey` → `undoMove` restoring a byte-identical key; records
   must keep `fromRemoved`, `fillsHole`/`fillHole*` even in search mode.
5. **`moveForSearch` must set `nonPlayerMoveCount`** and suppress visual
   records/fields exactly as today (weighted-A* rewards depend on it).
6. **Move records are extensible plain objects** — consumers bolt on `actor`,
   `reverseIceSlide`, `snapHoleRestore`, and mutate `path`/`iceSlide` in place.
7. **Elevation-derivation subtleties** — actor `elevation` presence is tested
   with `hasOwnProperty`; implicit elevations stack on earlier same-cell
   actors; `initialState` runs weightless settle + player surface snap.
8. **Numeric terrain codes are frozen** (0-14 as listed) — reverse maps and
   scorecard hashes depend on them.
9. **`move()` options** `continuePunchSlide`/`startOnCurrentSlope` drive
   cross-room slide/punch continuations from play-gameplay/world-transitions.
10. **Loader constraints** — classic script, no DOM, assigns
    `window.MazeEngine`; must run under `importScripts` with
    `self.window = self`, `vm.runInThisContext` with a bare `{}` window, and a
    `<script defer>` tag; keep the `/maze-engine.js` filename.
11. **Parity harness** — `tests/engine-parity.test.js` requires actor
    `{type,x,y,elevation,removed}` + `moved` to match the play-core object
    runtime after every move; `tests/runtime-drift.test.js` requires the
    rewritten file to be re-mirrored via `scripts/sync-runtime.js`.
12. **~65 standalone repro scripts** in `tests/repros/` exercise deep edge
    cases (punch/lift/clone/ice interactions) against this exact API.
