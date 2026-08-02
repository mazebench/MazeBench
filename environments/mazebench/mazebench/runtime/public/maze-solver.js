(function () {
  const defaultDirections = [
    { label: "U", dx: 0, dy: -1 },
    { label: "D", dx: 0, dy: 1 },
    { label: "L", dx: -1, dy: 0 },
    { label: "R", dx: 1, dy: 0 }
  ];
  const defaultMaxExpandedStates = 1000000;
  const defaultNonPlayerMoveRewardCap = 3;
  const defaultProgressYieldStateInterval = 4096;

  function compareSolverNodes(left, right) {
    return left.priority - right.priority || left.cost - right.cost || left.order - right.order;
  }

  class SolverHeap {
    constructor() {
      this.items = [];
    }

    get size() {
      return this.items.length;
    }

    push(item) {
      this.items.push(item);
      this.bubbleUp(this.items.length - 1);
    }

    pop() {
      if (this.items.length === 0) {
        return null;
      }

      const first = this.items[0];
      const last = this.items.pop();

      if (this.items.length > 0) {
        this.items[0] = last;
        this.bubbleDown(0);
      }

      return first;
    }

    bubbleUp(index) {
      let currentIndex = index;

      while (currentIndex > 0) {
        const parentIndex = Math.floor((currentIndex - 1) / 2);

        if (compareSolverNodes(this.items[parentIndex], this.items[currentIndex]) <= 0) {
          return;
        }

        [this.items[parentIndex], this.items[currentIndex]] = [
          this.items[currentIndex],
          this.items[parentIndex]
        ];
        currentIndex = parentIndex;
      }
    }

    bubbleDown(index) {
      let currentIndex = index;

      while (true) {
        const leftIndex = currentIndex * 2 + 1;
        const rightIndex = currentIndex * 2 + 2;
        let smallestIndex = currentIndex;

        if (
          leftIndex < this.items.length &&
          compareSolverNodes(this.items[leftIndex], this.items[smallestIndex]) < 0
        ) {
          smallestIndex = leftIndex;
        }

        if (
          rightIndex < this.items.length &&
          compareSolverNodes(this.items[rightIndex], this.items[smallestIndex]) < 0
        ) {
          smallestIndex = rightIndex;
        }

        if (smallestIndex === currentIndex) {
          return;
        }

        [this.items[currentIndex], this.items[smallestIndex]] = [
          this.items[smallestIndex],
          this.items[currentIndex]
        ];
        currentIndex = smallestIndex;
      }
    }
  }

  // V8 limits a single Map to roughly 2^24 entries. Large author searches can
  // legitimately cross that boundary before either finding a solution or
  // exhausting the graph, which used to surface as "Map maximum size
  // exceeded" even when the configured state budget was higher. State keys
  // are four UTF-16 code units of uniformly mixed hash data, so partitioning
  // on the first unit keeps every backing Map small without changing lookup
  // semantics or imposing a new global limit.
  class SolverCostStore {
    constructor() {
      this.buckets = [];
    }

    bucketIndex(key) {
      return String(key).charCodeAt(0) || 0;
    }

    get(key) {
      return this.buckets[this.bucketIndex(key)]?.get(key);
    }

    set(key, value) {
      const bucketIndex = this.bucketIndex(key);
      const bucket = this.buckets[bucketIndex] || new Map();

      if (!this.buckets[bucketIndex]) {
        this.buckets[bucketIndex] = bucket;
      }
      bucket.set(key, value);
      return this;
    }
  }

  class SolverStatePool {
    constructor(engine) {
      this.engine = engine;
      this.items = [];
    }

    acquire(source) {
      const state = this.items.pop() || this.engine.createStateBuffer();

      if (source) {
        this.engine.copyStateInto(state, source);
      }

      return state;
    }

    release(state) {
      if (state) {
        this.items.push(state);
      }
    }
  }

  class SolverNodePool {
    constructor() {
      this.items = [];
    }

    acquire(values) {
      const node = this.items.pop() || {};

      node.cost = values.cost;
      node.key = values.key;
      node.order = values.order;
      node.path = values.path;
      node.priority = values.priority;
      node.searchReward = values.searchReward || 0;
      node.state = values.state;

      return node;
    }

    release(node) {
      if (!node) {
        return;
      }

      node.path = "";
      node.state = null;
      this.items.push(node);
    }
  }

  function numericOption(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function expandedStateBudget(value, fallback) {
    // `null` is the cross-worker sentinel for an intentionally unlimited
    // search. Infinity is also accepted for direct callers. The search still
    // yields for progress, honors AbortSignal cancellation, and can naturally
    // terminate by solving or exhausting its frontier.
    if (value === null || value === Infinity) {
      return Infinity;
    }

    return numericOption(value, fallback);
  }

  function solverAlgorithmOption(value) {
    if (value === "bfs") {
      return "bfs";
    }

    return value === "weighted_astar" || value === "weighted" ? "weighted_astar" : "astar";
  }

  function throwIfSolverAborted(signal) {
    if (!signal?.aborted) {
      return;
    }

    const error = new Error("Solver cancelled.");
    error.name = "AbortError";
    throw error;
  }

  function solverNonPlayerMoveReward(engine, moveResult, rewardCap) {
    if (Number.isFinite(moveResult?.nonPlayerMoveCount)) {
      return Math.min(rewardCap, moveResult.nonPlayerMoveCount);
    }

    const movedActorIndexes = new Set();

    if (!Array.isArray(moveResult?.moves)) {
      return 0;
    }

    moveResult.moves.forEach((move) => {
      if (engine.isPlayerMove(move) || move.actorType === "gem") {
        return;
      }

      if (move.fromX === move.toX && move.fromY === move.toY) {
        return;
      }

      movedActorIndexes.add(move.actorIndex);
    });

    return Math.min(rewardCap, movedActorIndexes.size);
  }

  async function reportProgress(reportProgressFn, expanded, maxExpanded, openSize, force = false) {
    if (!reportProgressFn) {
      return;
    }

    await reportProgressFn(
      {
        expanded,
        maxExpanded,
        openSize
      },
      force
    );
  }

  function resultWithContinuation(result, continuation) {
    Object.defineProperty(result, "continuation", {
      configurable: false,
      enumerable: false,
      value: continuation,
      writable: false
    });

    return result;
  }

  async function solveWithAStar(engine, options = {}) {
    throwIfSolverAborted(options.signal);
    const continuation = options.continuation?.type === "astar" ? options.continuation : null;
    const algorithm = continuation?.algorithm || solverAlgorithmOption(options.algorithm);
    const directions = continuation?.directions ||
      (Array.isArray(options.directions) ? options.directions : defaultDirections);
    const progressYieldStateInterval = continuation?.progressYieldStateInterval || numericOption(
      options.progressYieldStateInterval,
      defaultProgressYieldStateInterval
    );
    const nonPlayerMoveRewardCap = continuation?.nonPlayerMoveRewardCap || numericOption(
      options.nonPlayerMoveRewardCap,
      defaultNonPlayerMoveRewardCap
    );
    const heuristicWeight =
      algorithm === "bfs"
        ? 0
        : 1;
    const useSearchReward = algorithm === "weighted_astar";
    // 'astar' uses the engine's ADMISSIBLE heuristic (optimal move counts —
    // the legacy distance heuristic overestimated across ice slides, so its
    // "minimum moves" were wrong on ice levels). 'weighted_astar' keeps the
    // stronger inadmissible distance heuristic: the fast, explicitly
    // non-optimal mode.
    const heuristicFn =
      algorithm === "weighted_astar" && typeof engine.heuristicDistance === "function"
        ? engine.heuristicDistance
        : engine.heuristic;
    const open = continuation?.open || new SolverHeap();
    const bestCostByKey = continuation?.bestCostByKey || new SolverCostStore();
    const nodePool = continuation?.nodePool || new SolverNodePool();
    const reportProgressFn =
      typeof options.onProgress === "function" ? options.onProgress : null;
    let order = continuation?.order || 0;
    let expanded = continuation?.expanded || 0;
    const additionalExpandedStates = expandedStateBudget(
      options.additionalExpandedStates,
      expandedStateBudget(options.maxExpandedStates, defaultMaxExpandedStates)
    );
    const maxExpandedStates = expanded + additionalExpandedStates;

    // Compact node states: one live working buffer + per-node snapshots of
    // the actor arrays plus terrain/lift DIFFS versus the initial state.
    // The legacy pool kept a full state buffer (incl. whole terrain and lift
    // arrays) alive per open node — hundreds of MB on large searches, and a
    // full-buffer memcpy per pushed child. Snapshots are ~10-30x smaller and
    // restore in O(actors + diffs).
    const initialState = continuation?.initialState || engine.initialState;
    const live = continuation?.live || engine.cloneState(initialState);
    const snapArrayPool = continuation?.snapArrayPool || [];
    let liveTerrainDiffs = continuation?.liveTerrainDiffs || null;
    let liveLiftDiffs = continuation?.liveLiftDiffs || null;

    function acquireSnapArrays() {
      return (
        snapArrayPool.pop() || {
          ax: new Int16Array(live.actorX.length),
          ay: new Int16Array(live.actorY.length),
          ae: new Int16Array(live.actorElevation.length),
          ar: new Uint8Array(live.actorRemoved.length)
        }
      );
    }

    function makeSnap(state, parentSnap, moveResult) {
      const arrays = acquireSnapArrays();

      arrays.ax.set(state.actorX);
      arrays.ay.set(state.actorY);
      arrays.ae.set(state.actorElevation);
      arrays.ar.set(state.actorRemoved);

      // Terrain/lift diffs derive from the parent's diffs plus this move's
      // recorded deltas (hole fills and lift toggles are the only cell
      // mutations in the game) — no O(cellCount) scans.
      let terrainDiffs = parentSnap ? parentSnap.terrainDiffs : null;
      let liftDiffs = parentSnap ? parentSnap.liftDiffs : null;

      if (moveResult) {
        let addedTerrain = null;

        if (Array.isArray(moveResult.moves)) {
          for (const move of moveResult.moves) {
            if (
              move.fillsHole &&
              typeof move.fillHoleX === "number" &&
              typeof move.fillHoleY === "number"
            ) {
              (addedTerrain ||= []).push(engine.cellIndex(move.fillHoleX, move.fillHoleY));
            }
          }
        }

        if (addedTerrain) {
          terrainDiffs = (terrainDiffs || []).concat(addedTerrain);
        }

        if (Array.isArray(moveResult.liftToggles) && moveResult.liftToggles.length > 0) {
          const merged = liftDiffs ? liftDiffs.slice() : [];

          for (const toggle of moveResult.liftToggles) {
            const cell = engine.cellIndex(toggle.x, toggle.y);
            const existing = merged.indexOf(cell);

            if (existing === -1) {
              merged.push(cell);
            } else {
              merged.splice(existing, 1); // toggled back to initial
            }
          }

          liftDiffs = merged.length > 0 ? merged : null;
        }
      }

      return {
        ax: arrays.ax,
        ay: arrays.ay,
        ae: arrays.ae,
        ar: arrays.ar,
        terrainDiffs,
        liftDiffs,
        hashLo: state.hashLo | 0,
        hashHi: state.hashHi | 0,
        hashValid: state.hashValid === true
      };
    }

    function releaseSnap(snap) {
      if (snap) {
        snapArrayPool.push({ ax: snap.ax, ay: snap.ay, ae: snap.ae, ar: snap.ar });
      }
    }

    function restoreLive(snap) {
      // Revert cells the live buffer currently has diverged, then apply the
      // snapshot's divergences. Terrain diffs are always hole fills (floor).
      if (liveTerrainDiffs) {
        for (const cell of liveTerrainDiffs) {
          live.terrain[cell] = initialState.terrain[cell];
        }
      }

      if (snap.terrainDiffs) {
        for (const cell of snap.terrainDiffs) {
          live.terrain[cell] = 1; // terrainTypes.floor — the only fill value
        }
      }

      liveTerrainDiffs = snap.terrainDiffs;

      if (liveLiftDiffs) {
        for (const cell of liveLiftDiffs) {
          live.liftRaised[cell] = initialState.liftRaised[cell];
        }
      }

      if (snap.liftDiffs) {
        for (const cell of snap.liftDiffs) {
          live.liftRaised[cell] = initialState.liftRaised[cell] ? 0 : 1;
        }
      }

      liveLiftDiffs = snap.liftDiffs;

      live.actorX.set(snap.ax);
      live.actorY.set(snap.ay);
      live.actorElevation.set(snap.ae);
      live.actorRemoved.set(snap.ar);
      live.hashLo = snap.hashLo;
      live.hashHi = snap.hashHi;
      live.hashValid = snap.hashValid;
    }

    if (!continuation) {
      const initialKey = engine.stateKey(live);

      bestCostByKey.set(initialKey, 0);
      open.push(nodePool.acquire({
        state: makeSnap(live, null, null),
        key: initialKey,
        cost: 0,
        searchReward: 0,
        path: "",
        priority: heuristicWeight * heuristicFn(live),
        order: order
      }));
      order += 1;
    }

    await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size, true);

    while (open.size > 0) {
      throwIfSolverAborted(options.signal);

      if (expanded >= maxExpandedStates) {
        await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size, true);

        return resultWithContinuation(
          {
            status: "capped",
            expanded,
            maxExpanded: maxExpandedStates
          },
          {
            algorithm,
            bestCostByKey,
            directions,
            engine,
            expanded,
            initialState,
            live,
            liveLiftDiffs,
            liveTerrainDiffs,
            nodePool,
            nonPlayerMoveRewardCap,
            open,
            order,
            progressYieldStateInterval,
            snapArrayPool,
            type: "astar"
          }
        );
      }

      const current = open.pop();

      if (current.cost !== bestCostByKey.get(current.key)) {
        releaseSnap(current.state);
        nodePool.release(current);
        continue;
      }

      restoreLive(current.state);

      if (engine.isSolved(live)) {
        await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size, true);

        return {
          status: "solved",
          moves: current.cost,
          path: current.path,
          expanded
        };
      }

      expanded += 1;

      if (expanded % progressYieldStateInterval === 0) {
        await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size);
      }

      for (const direction of directions) {
        throwIfSolverAborted(options.signal);
        const moveResult = engine.moveForSearch(
          live,
          direction.dx,
          direction.dy
        );

        if (!moveResult?.moved) {
          continue;
        }

        const nextCost = current.cost + 1;
        const nextSearchReward =
          useSearchReward
            ? current.searchReward +
              solverNonPlayerMoveReward(engine, moveResult, nonPlayerMoveRewardCap)
            : 0;
        const nextKey = engine.stateKey(live);
        const bestKnownCost = bestCostByKey.get(nextKey);

        if (typeof bestKnownCost === "number" && bestKnownCost <= nextCost) {
          engine.undoMove(live, moveResult);
          continue;
        }

        bestCostByKey.set(nextKey, nextCost);
        open.push(nodePool.acquire({
          state: makeSnap(live, current.state, moveResult),
          key: nextKey,
          cost: nextCost,
          searchReward: nextSearchReward,
          path: current.path + direction.label,
          priority: nextCost + heuristicWeight * heuristicFn(live) - nextSearchReward,
          order
        }));
        order += 1;

        engine.undoMove(live, moveResult);
      }

      releaseSnap(current.state);
      nodePool.release(current);
    }

    await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size, true);

    return {
      status: "unsolved",
      expanded
    };
  }

  function canCollectGemAtMoveEndpoint(engine, move) {
    if (!engine.isPlayerMove(move) || move.toRemoved) {
      return false;
    }

    return Number.isFinite(Number(move.toElevation ?? 0));
  }

  function recordGemPlacementCandidates(
    engine,
    moveResult,
    cost,
    path,
    bestCandidateByCell,
    canPlaceGemAt
  ) {
    moveResult.moves.forEach((move) => {
      if (!canCollectGemAtMoveEndpoint(engine, move)) {
        return;
      }

      const elevation = Math.max(0, Math.floor(Number(move.toElevation ?? 0) || 0));

      if (!canPlaceGemAt(move.toX, move.toY, elevation, move)) {
        return;
      }

      const key = move.toX + "," + move.toY + "," + elevation;
      const previousCandidate = bestCandidateByCell.get(key);

      if (previousCandidate && previousCandidate.moves <= cost) {
        return;
      }

      bestCandidateByCell.set(key, {
        elevation,
        x: move.toX,
        y: move.toY,
        moves: cost,
        path
      });
    });
  }

  function hardestGemPlacementCandidate(bestCandidateByCell) {
    let hardest = null;

    bestCandidateByCell.forEach((candidate) => {
      if (!hardest || candidate.moves > hardest.moves) {
        hardest = candidate;
      }
    });

    return hardest;
  }

  async function findHardestGemPlacement(engine, options = {}) {
    throwIfSolverAborted(options.signal);
    const continuation = options.continuation?.type === "hardest_gem" ? options.continuation : null;
    const directions = continuation?.directions ||
      (Array.isArray(options.directions) ? options.directions : defaultDirections);
    const progressYieldStateInterval = continuation?.progressYieldStateInterval || numericOption(
      options.progressYieldStateInterval,
      defaultProgressYieldStateInterval
    );
    const canPlaceGemAt = continuation?.canPlaceGemAt ||
      (typeof options.canPlaceGemAt === "function" ? options.canPlaceGemAt : () => true);
    const open = continuation?.open || new SolverHeap();
    const bestCostByKey = continuation?.bestCostByKey || new SolverCostStore();
    const bestCandidateByCell = continuation?.bestCandidateByCell || new Map();
    const statePool = continuation?.statePool || new SolverStatePool(engine);
    const nodePool = continuation?.nodePool || new SolverNodePool();
    const reportProgressFn =
      typeof options.onProgress === "function" ? options.onProgress : null;
    let order = continuation?.order || 0;
    let expanded = continuation?.expanded || 0;
    const additionalExpandedStates = expandedStateBudget(
      options.additionalExpandedStates,
      expandedStateBudget(options.maxExpandedStates, defaultMaxExpandedStates)
    );
    const maxExpandedStates = expanded + additionalExpandedStates;

    if (!continuation) {
      const initialState = statePool.acquire(engine.initialState);
      const initialKey = engine.stateKey(initialState);

      bestCostByKey.set(initialKey, 0);
      open.push(nodePool.acquire({
        state: initialState,
        key: initialKey,
        cost: 0,
        path: "",
        priority: 0,
        order
      }));
      order += 1;
    }

    await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size, true);

    while (open.size > 0) {
      throwIfSolverAborted(options.signal);

      if (expanded >= maxExpandedStates) {
        await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size, true);

        return resultWithContinuation(
          {
            status: "capped",
            candidate: hardestGemPlacementCandidate(bestCandidateByCell),
            expanded,
            maxExpanded: maxExpandedStates
          },
          {
            bestCandidateByCell,
            bestCostByKey,
            canPlaceGemAt,
            directions,
            engine,
            expanded,
            nodePool,
            open,
            order,
            progressYieldStateInterval,
            statePool,
            type: "hardest_gem"
          }
        );
      }

      const current = open.pop();

      if (current.cost !== bestCostByKey.get(current.key)) {
        statePool.release(current.state);
        nodePool.release(current);
        continue;
      }

      expanded += 1;

      if (expanded % progressYieldStateInterval === 0) {
        await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size);
      }

      for (const direction of directions) {
        throwIfSolverAborted(options.signal);
        const moveResult = engine.moveForSearch(
          current.state,
          direction.dx,
          direction.dy
        );

        if (!moveResult?.moved) {
          continue;
        }

        const nextCost = current.cost + 1;
        const nextPath = current.path + direction.label;
        const nextKey = engine.stateKey(current.state);
        const bestKnownCost = bestCostByKey.get(nextKey);

        recordGemPlacementCandidates(
          engine,
          moveResult,
          nextCost,
          nextPath,
          bestCandidateByCell,
          canPlaceGemAt
        );

        if (typeof bestKnownCost === "number" && bestKnownCost <= nextCost) {
          engine.undoMove(current.state, moveResult);
          continue;
        }

        const nextState = statePool.acquire(current.state);

        bestCostByKey.set(nextKey, nextCost);
        open.push(nodePool.acquire({
          state: nextState,
          key: nextKey,
          cost: nextCost,
          path: nextPath,
          priority: nextCost,
          order
        }));
        order += 1;

        engine.undoMove(current.state, moveResult);
      }

      statePool.release(current.state);
      nodePool.release(current);
    }

    const candidate = hardestGemPlacementCandidate(bestCandidateByCell);

    await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size, true);

    return {
      status: candidate ? "found" : "none",
      candidate,
      expanded
    };
  }

  function normalizedPositionTargets(targets) {
    return (Array.isArray(targets) ? targets : [])
      .map((target, index) => ({
        ...target,
        id: String(target?.id || "target-" + index),
        x: Math.floor(Number(target?.x)),
        y: Math.floor(Number(target?.y)),
        elevation: Math.max(0, Math.floor(Number(target?.elevation || 0)))
      }))
      .filter((target) => Number.isFinite(target.x) && Number.isFinite(target.y));
  }

  function recordReachedPositionTargets(engine, state, path, targetsByPosition, targetCount, reachedById) {
    if (reachedById.size >= targetCount) return;
    for (let actorIndex = 0; actorIndex < engine.actorCount; actorIndex += 1) {
      const type = engine.actorTypes[actorIndex];
      if (
        (type !== "player" && type !== "circle_player" && type !== "clone") ||
        state.actorRemoved?.[actorIndex]
      ) continue;
      const x = Number(state.actorX?.[actorIndex]);
      const y = Number(state.actorY?.[actorIndex]);
      const elevation = Number(state.actorElevation?.[actorIndex] || 0);
      const targets = targetsByPosition.get(x + "," + y + "," + elevation) || [];
      for (const target of targets) {
        if (
          !reachedById.has(target.id) &&
          x === target.x &&
          y === target.y &&
          elevation === target.elevation
        ) {
          reachedById.set(target.id, { ...target, moves: path.length, path });
        }
      }
    }
  }

  // Exhaust a room state graph once and return the shortest path to every
  // requested position. Unlike running A* separately for every edge tile,
  // this shares the visited-state table and proves unreachable targets when
  // the open set becomes empty.
  async function findReachablePositions(engine, targets, options = {}) {
    throwIfSolverAborted(options.signal);
    const continuation = options.continuation?.type === "reachable_positions"
      ? options.continuation
      : null;
    const normalizedTargets = continuation?.normalizedTargets || normalizedPositionTargets(targets);
    const directions = continuation?.directions ||
      (Array.isArray(options.directions) ? options.directions : defaultDirections);
    const progressYieldStateInterval = continuation?.progressYieldStateInterval || numericOption(
      options.progressYieldStateInterval,
      defaultProgressYieldStateInterval
    );
    const reportProgressFn = typeof options.onProgress === "function" ? options.onProgress : null;
    const open = continuation?.open || new SolverHeap();
    const bestCostByKey = continuation?.bestCostByKey || new SolverCostStore();
    const reachedById = continuation?.reachedById || new Map();
    const targetsByPosition = continuation?.targetsByPosition || new Map();
    const statePool = continuation?.statePool || new SolverStatePool(engine);
    const nodePool = continuation?.nodePool || new SolverNodePool();
    let order = continuation?.order || 0;
    let expanded = continuation?.expanded || 0;
    const additionalExpandedStates = expandedStateBudget(
      options.additionalExpandedStates,
      expandedStateBudget(options.maxExpandedStates, Number.MAX_SAFE_INTEGER)
    );
    const maxExpandedStates = expanded + additionalExpandedStates;

    if (!continuation) {
      for (const target of normalizedTargets) {
        const key = target.x + "," + target.y + "," + target.elevation;
        if (!targetsByPosition.has(key)) targetsByPosition.set(key, []);
        targetsByPosition.get(key).push(target);
      }
      const initialState = statePool.acquire(engine.initialState);
      const initialKey = engine.stateKey(initialState);

      bestCostByKey.set(initialKey, 0);
      open.push(nodePool.acquire({
        state: initialState,
        key: initialKey,
        cost: 0,
        path: "",
        priority: 0,
        order: order++
      }));
    }
    await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size, true);

    while (open.size > 0) {
      throwIfSolverAborted(options.signal);

      if (expanded >= maxExpandedStates) {
        await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size, true);

        return resultWithContinuation(
          {
            status: "capped",
            expanded,
            maxExpanded: maxExpandedStates,
            reachable: Array.from(reachedById.values()),
            unreachable: normalizedTargets.filter((target) => !reachedById.has(target.id))
          },
          {
            bestCostByKey,
            directions,
            engine,
            expanded,
            nodePool,
            normalizedTargets,
            open,
            order,
            progressYieldStateInterval,
            reachedById,
            statePool,
            targetsByPosition,
            type: "reachable_positions"
          }
        );
      }

      const current = open.pop();
      if (current.cost !== bestCostByKey.get(current.key)) {
        statePool.release(current.state);
        nodePool.release(current);
        continue;
      }
      recordReachedPositionTargets(
        engine,
        current.state,
        current.path,
        targetsByPosition,
        normalizedTargets.length,
        reachedById
      );
      if (reachedById.size >= normalizedTargets.length) {
        statePool.release(current.state);
        nodePool.release(current);
        await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size, true);
        return {
          status: "found_all",
          expanded,
          reachable: Array.from(reachedById.values()),
          unreachable: []
        };
      }

      expanded += 1;
      if (expanded % progressYieldStateInterval === 0) {
        await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size);
      }
      for (const direction of directions) {
        const moveResult = engine.moveForSearch(current.state, direction.dx, direction.dy);
        if (!moveResult?.moved) continue;
        const nextCost = current.cost + 1;
        const nextKey = engine.stateKey(current.state);
        const bestKnownCost = bestCostByKey.get(nextKey);
        if (typeof bestKnownCost !== "number" || nextCost < bestKnownCost) {
          const nextState = statePool.acquire(current.state);
          bestCostByKey.set(nextKey, nextCost);
          open.push(nodePool.acquire({
            state: nextState,
            key: nextKey,
            cost: nextCost,
            path: current.path + direction.label,
            priority: nextCost,
            order: order++
          }));
        }
        engine.undoMove(current.state, moveResult);
      }

      statePool.release(current.state);
      nodePool.release(current);
    }

    await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size, true);
    return {
      status: "exhausted",
      expanded,
      reachable: Array.from(reachedById.values()),
      unreachable: normalizedTargets.filter((target) => !reachedById.has(target.id))
    };
  }

  window.MazeSolver = {
    SolverCostStore,
    findHardestGemPlacement,
    findReachablePositions,
    solveWithAStar
  };
})();
