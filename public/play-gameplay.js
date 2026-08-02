(function () {
  const modules = window.PlayModules || (window.PlayModules = {});

  modules.registerGameplayFunctions = function registerGameplayFunctions(app) {
    // Forced motion uses constant velocity; duration still scales with travel distance.
    const ICE_SLIDE_TOP_SPEED_MULTIPLIER = 2.67;
    const ICE_SLIDE_ACCELERATION_DISTANCE = 5;
    const ICE_SLIDE_STOP_DISTANCE = 1;
    const {
      state,
      moveHistory,
      MOVE_DURATION_MS,
      PLAYER_LIFT_RISE_DURATION_MS,
      PLAYER_LIFT_FALL_DURATION_MS,
      HOLE_FALL_DURATION_MS,
      HOLE_SINK_DISTANCE
    } = app;
    const {
      restoreTerrainState,
      computeRaisedPlayerGateSet,
      computeRaisedOrangeWallSet,
      setRaisedOrangeWallState,
      easeOutBack,
      easeInOutQuad,
      syncFloatingFloorTicker,
      applyLevelState
    } = app;
    let movement = null;
    const ANIMATION_STARTUP_GRACE_MS = 1000 / 60;
    const MAX_ANIMATION_FRAME_STEP_MS = 1000 / 30;
    const SYNTHETIC_FRAME_DELTA_EPSILON_MS = 0.5;
    const HOLE_FADE_START_PROGRESS = 0.42;
    const HOLE_PRE_FADE_SINK_DISTANCE = Math.max(HOLE_SINK_DISTANCE * 0.62, app.TILE_SIZE * 2);
    const HOLE_FADE_SINK_DISTANCE = Math.max(HOLE_SINK_DISTANCE * 0.72, app.TILE_SIZE * 2);
    const LATE_INPUT_WINDOW_MS = 200;
    let nextUndoGroupId = 1;

    function canQueueLateAction(now = performance.now()) {
      const actionEndsAtMs = Number(app.inputActionEndsAtMs || 0);
      const remainingMs = actionEndsAtMs - now;
      return remainingMs >= 0 && remainingMs <= LATE_INPUT_WINDOW_MS;
    }

    function queueLateAction(action) {
      if (!action || !canQueueLateAction()) return false;
      // One slot only. A later input replaces the earlier buffered choice,
      // preventing a burst of taps from becoming a long action backlog.
      app.queuedAction = action;
      return true;
    }

    function cancelQueuedAction(inputSource) {
      if (!inputSource || app.queuedAction?.inputSource !== inputSource) return false;
      app.queuedAction = null;
      return true;
    }

    function createAnimationElapsedTracker() {
      const replayFrameStepMs = Number(app.replayAnimationFrameStepMs);

      if (Number.isFinite(replayFrameStepMs) && replayFrameStepMs > 0) {
        let replayElapsedMs = 0;

        return function replayAnimationElapsed() {
          replayElapsedMs += replayFrameStepMs;
          return replayElapsedMs;
        };
      }

      const requestedAt = performance.now();
      let elapsedMs = 0;
      let previousNow = null;

      return function animationElapsed(now) {
        if (previousNow === null) {
          elapsedMs = Math.min(
            Math.max(0, now - requestedAt),
            ANIMATION_STARTUP_GRACE_MS
          );
          previousNow = now;
          return elapsedMs;
        }

        let deltaMs = now - previousNow;

        if (deltaMs < SYNTHETIC_FRAME_DELTA_EPSILON_MS) {
          deltaMs = MAX_ANIMATION_FRAME_STEP_MS;
        }

        elapsedMs += Math.min(Math.max(0, deltaMs), MAX_ANIMATION_FRAME_STEP_MS);
        previousNow = now;
        return elapsedMs;
      };
    }

    function localAnimationProgress(progress, start, duration) {
      return Math.max(0, Math.min(1, (progress - start) / Math.max(0.0001, duration)));
    }

    function fadeAlphaForMoveProgress(progress, fadeStartProgress = 0, fadeEndProgress = 1) {
      if (progress <= fadeStartProgress) {
        return 1;
      }

      if (progress >= fadeEndProgress) {
        return 0;
      }

      const duration = Math.max(0.0001, fadeEndProgress - fadeStartProgress);
      const localProgress = (progress - fadeStartProgress) / duration;
      return 1 - easeInOutQuad(localProgress);
    }

    function holeFallAlphaForProgress(progress) {
      return fadeAlphaForMoveProgress(progress, HOLE_FADE_START_PROGRESS, 1);
    }

    function holeFallSinkForProgress(progress) {
      const preFadeProgress = easeInOutQuad(
        localAnimationProgress(progress, 0, HOLE_FADE_START_PROGRESS)
      );
      const fadeProgress = easeInOutQuad(
        localAnimationProgress(progress, HOLE_FADE_START_PROGRESS, 1 - HOLE_FADE_START_PROGRESS)
      );

      return HOLE_PRE_FADE_SINK_DISTANCE * preFadeProgress + HOLE_FADE_SINK_DISTANCE * fadeProgress;
    }

    function moveDistance({ fromX, fromY, toX, toY }) {
      return Math.abs(toX - fromX) + Math.abs(toY - fromY);
    }

    function normalizedMovePath(move) {
      if (!Array.isArray(move.path) || move.path.length < 2) {
        return [
          {
            x: move.fromX,
            y: move.fromY,
            elevation: move.fromElevation ?? move.actor?.elevation ?? 0
          },
          {
            x: move.toX,
            y: move.toY,
            elevation: move.toElevation ?? move.fromElevation ?? move.actor?.elevation ?? 0
          }
        ];
      }

      return move.path
        .map((point) => ({
          x: Number(point?.x),
          y: Number(point?.y),
          elevation: Number(point?.elevation)
        }))
        .filter(
          (point) =>
            Number.isFinite(point.x) &&
            Number.isFinite(point.y) &&
            Number.isFinite(point.elevation)
        );
    }

    function pathSegmentDistance(from, to) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dz = to.elevation - from.elevation;

      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    function pathDistanceFor(move) {
      const path = normalizedMovePath(move);
      let distance = 0;

      for (let index = 1; index < path.length; index += 1) {
        distance += pathSegmentDistance(path[index - 1], path[index]);
      }

      return distance;
    }

    function pointAlongPath(move, progress) {
      const path = normalizedMovePath(move);

      if (path.length === 0) {
        return {
          x: move.toX,
          y: move.toY,
          elevation: move.toElevation ?? move.fromElevation ?? move.actor?.elevation ?? 0
        };
      }

      if (path.length === 1) {
        return path[0];
      }

      const totalDistance = pathDistanceFor(move);

      if (totalDistance <= 0) {
        return path[path.length - 1];
      }

      let remainingDistance = totalDistance * Math.max(0, Math.min(1, progress));

      for (let index = 1; index < path.length; index += 1) {
        const from = path[index - 1];
        const to = path[index];
        const segmentDistanceValue = pathSegmentDistance(from, to);

        if (remainingDistance > segmentDistanceValue && index < path.length - 1) {
          remainingDistance -= segmentDistanceValue;
          continue;
        }

        const segmentProgress =
          segmentDistanceValue <= 0 ? 1 : Math.max(0, Math.min(1, remainingDistance / segmentDistanceValue));

        return {
          x: from.x + (to.x - from.x) * segmentProgress,
          y: from.y + (to.y - from.y) * segmentProgress,
          elevation: from.elevation + (to.elevation - from.elevation) * segmentProgress
        };
      }

      return path[path.length - 1];
    }

    function pointAlongPathDistance(move, traveledDistance) {
      const path = normalizedMovePath(move);

      if (path.length === 0) {
        return {
          x: move.toX,
          y: move.toY,
          elevation: move.toElevation ?? move.fromElevation ?? move.actor?.elevation ?? 0
        };
      }

      if (path.length === 1) {
        return path[0];
      }

      const totalDistance = pathDistanceFor(move);

      if (totalDistance <= 0) {
        return path[path.length - 1];
      }

      let remainingDistance = Math.max(0, Math.min(totalDistance, traveledDistance));

      for (let index = 1; index < path.length; index += 1) {
        const from = path[index - 1];
        const to = path[index];
        const segmentDistanceValue = pathSegmentDistance(from, to);

        if (remainingDistance > segmentDistanceValue && index < path.length - 1) {
          remainingDistance -= segmentDistanceValue;
          continue;
        }

        const segmentProgress =
          segmentDistanceValue <= 0 ? 1 : Math.max(0, Math.min(1, remainingDistance / segmentDistanceValue));

        return {
          x: from.x + (to.x - from.x) * segmentProgress,
          y: from.y + (to.y - from.y) * segmentProgress,
          elevation: from.elevation + (to.elevation - from.elevation) * segmentProgress
        };
      }

      return path[path.length - 1];
    }

    function pathPointMatches(left, right) {
      return (
        Math.abs(left.x - right.x) < 0.0001 &&
        Math.abs(left.y - right.y) < 0.0001 &&
        Math.abs(left.elevation - right.elevation) < 0.0001
      );
    }

    function pathDistanceToPoint(move, targetPoint) {
      const path = normalizedMovePath(move);
      let distance = 0;

      if (path.length === 0) {
        return null;
      }

      if (pathPointMatches(path[0], targetPoint)) {
        return 0;
      }

      for (let index = 1; index < path.length; index += 1) {
        const from = path[index - 1];
        const to = path[index];
        const segmentDistanceValue = pathSegmentDistance(from, to);

        if (pathPointMatches(to, targetPoint)) {
          return distance + segmentDistanceValue;
        }

        distance += segmentDistanceValue;
      }

      return null;
    }

    function pointAlongPathToPoint(move, targetPoint, progress) {
      const targetDistance = pathDistanceToPoint(move, targetPoint);

      if (targetDistance === null) {
        return pointAlongPath(move, progress);
      }

      return pointAlongPathDistance(move, targetDistance * Math.max(0, Math.min(1, progress)));
    }

    function iceSlideDuration(distance) {
      if (distance <= 0 || MOVE_DURATION_MS <= 0) {
        return 0;
      }

      if (isShortIceSlide(distance)) {
        return shortIceSlideDuration(distance);
      }

      const accelerationDurationMs = iceSlideAccelerationDuration();
      const stopDurationMs = iceSlideStopDuration();
      const cruiseDistance =
        distance - ICE_SLIDE_ACCELERATION_DISTANCE - ICE_SLIDE_STOP_DISTANCE;
      const cruiseDurationMs =
        (cruiseDistance * MOVE_DURATION_MS) / ICE_SLIDE_TOP_SPEED_MULTIPLIER;

      return accelerationDurationMs + cruiseDurationMs + stopDurationMs;
    }

    function isShortIceSlide(distance) {
      return distance < ICE_SLIDE_ACCELERATION_DISTANCE + ICE_SLIDE_STOP_DISTANCE;
    }

    function shortIceSlideDuration(distance) {
      return Math.max(
        MOVE_DURATION_MS,
        (distance * 1.5 * MOVE_DURATION_MS) / ICE_SLIDE_TOP_SPEED_MULTIPLIER
      );
    }

    function iceSlideAccelerationDuration() {
      return (
        ((ICE_SLIDE_ACCELERATION_DISTANCE * 1.5) / ICE_SLIDE_TOP_SPEED_MULTIPLIER) *
        MOVE_DURATION_MS
      );
    }

    function iceSlideStopDuration() {
      return (
        ((ICE_SLIDE_STOP_DISTANCE * 3) / ICE_SLIDE_TOP_SPEED_MULTIPLIER) *
        MOVE_DURATION_MS
      );
    }

    function linearMotionProgress(elapsedMs, durationMs) {
      if (durationMs <= 0) {
        return 1;
      }

      return Math.min(1, Math.max(0, elapsedMs / durationMs));
    }

    function iceSlideProgress(elapsedMs, distance, reverse = false) {
      if (distance <= 0 || MOVE_DURATION_MS <= 0) {
        return 1;
      }

      return linearMotionProgress(elapsedMs, iceSlideDuration(distance));
    }

    function iceSlideProgressForDuration(elapsedMs, distance, durationMs, reverse = false) {
      const nativeDurationMs = iceSlideDuration(distance);

      if (nativeDurationMs <= 0 || !Number.isFinite(durationMs) || durationMs <= nativeDurationMs) {
        return iceSlideProgress(elapsedMs, distance, reverse);
      }

      return linearMotionProgress(elapsedMs, durationMs);
    }

    function moveDurationFor(move) {
      const distance = Array.isArray(move.path) ? pathDistanceFor(move) : moveDistance(move);

      if (move.iceSlide) {
        return iceSlideDuration(distance);
      }

      return MOVE_DURATION_MS * distance;
    }

    function hasPunchStart(move) {
      return typeof move.punchStartX === "number" && typeof move.punchStartY === "number";
    }

    function isPunchVisualMove(move) {
      return move.visualOnly === true && move.punchEffect === true;
    }

    function normalizedPunchSegments(move) {
      if (!Array.isArray(move.punchSegments)) {
        return [];
      }

      return move.punchSegments
        .map((segment) => ({
          sequence: Number(segment?.sequence),
          fromX: Number(segment?.fromX),
          fromY: Number(segment?.fromY),
          fromElevation: Number(segment?.fromElevation),
          toX: Number(segment?.toX),
          toY: Number(segment?.toY),
          toElevation: Number(segment?.toElevation),
          startIceSlide: segment?.startIceSlide === true,
          punchSlide: segment?.punchSlide === true
        }))
        .filter(
          (segment) =>
            Number.isFinite(segment.sequence) &&
            Number.isFinite(segment.fromX) &&
            Number.isFinite(segment.fromY) &&
            Number.isFinite(segment.fromElevation) &&
            Number.isFinite(segment.toX) &&
            Number.isFinite(segment.toY) &&
            Number.isFinite(segment.toElevation)
        )
        .sort((left, right) => left.sequence - right.sequence);
    }

    function firstPunchSegment(move) {
      const segments = normalizedPunchSegments(move);
      return segments.length > 0 ? segments[0] : null;
    }

    function punchSegmentDistance(segment) {
      return pathSegmentDistance(
        { x: segment.fromX, y: segment.fromY, elevation: segment.fromElevation },
        { x: segment.toX, y: segment.toY, elevation: segment.toElevation }
      );
    }

    function punchSegmentDurationFor(move, segment) {
      return segmentDuration(
        punchSegmentDistance(segment),
        segment.punchSlide === true || move.punchSlide === true || move.iceSlide === true
      );
    }

    function segmentDistance(fromX, fromY, toX, toY) {
      return Math.abs(toX - fromX) + Math.abs(toY - fromY);
    }

    function segmentDuration(distance, iceSlide = false) {
      if (distance <= 0) {
        return 0;
      }

      return iceSlide ? iceSlideDuration(distance) : MOVE_DURATION_MS * distance;
    }

    function punchPhaseOneDistance(move) {
      if (isPunchVisualMove(move)) {
        return 0;
      }

      const firstSegment = firstPunchSegment(move);

      if (firstSegment && Array.isArray(move.path) && move.path.length > 1) {
        const distanceToPunch = pathDistanceToPoint(move, {
          x: firstSegment.fromX,
          y: firstSegment.fromY,
          elevation: firstSegment.fromElevation
        });

        return distanceToPunch === null ? pathDistanceFor(move) : distanceToPunch;
      }

      if (firstSegment) {
        return pathSegmentDistance(
          { x: move.fromX, y: move.fromY, elevation: move.fromElevation ?? 0 },
          { x: firstSegment.fromX, y: firstSegment.fromY, elevation: firstSegment.fromElevation }
        );
      }

      if (hasPunchStart(move) && Array.isArray(move.path) && move.path.length > 1) {
        return pathDistanceFor(move);
      }

      if (hasPunchStart(move)) {
        return segmentDistance(move.fromX, move.fromY, move.punchStartX, move.punchStartY);
      }

      return moveDistance(move);
    }

    function punchPhaseTwoDistance(move) {
      if (isPunchVisualMove(move)) {
        return segmentDistance(
          typeof move.finalX === "number" ? move.finalX : move.fromX,
          typeof move.finalY === "number" ? move.finalY : move.fromY,
          move.toX,
          move.toY
        );
      }

      const firstSegment = firstPunchSegment(move);

      if (firstSegment) {
        return punchSegmentDistance(firstSegment);
      }

      if (hasPunchStart(move)) {
        return segmentDistance(move.punchStartX, move.punchStartY, move.toX, move.toY);
      }

      return 0;
    }

    function punchPhaseOneDurationFor(move) {
      return segmentDuration(
        punchPhaseOneDistance(move),
        hasPunchStart(move) ? move.punchStartIceSlide === true : move.iceSlide === true
      );
    }

    function punchPhaseTwoDurationFor(move) {
      return segmentDuration(
        punchPhaseTwoDistance(move),
        isPunchVisualMove(move) || move.punchSlide === true || move.iceSlide === true
      );
    }

    function punchRetractDistance(move) {
      if (!isPunchVisualMove(move)) {
        return 0;
      }

      return segmentDistance(
        move.toX,
        move.toY,
        typeof move.finalX === "number" ? move.finalX : move.fromX,
        typeof move.finalY === "number" ? move.finalY : move.fromY
      );
    }

    function punchRetractDurationFor(move) {
      return segmentDuration(punchRetractDistance(move), isPunchVisualMove(move));
    }

    function punchVisualCycleDurationFor(move) {
      return punchPhaseTwoDurationFor(move) + punchRetractDurationFor(move);
    }

    function punchSequenceForVisualMove(move) {
      const sequence = Number(move.punchSequence);
      return Number.isFinite(sequence) ? sequence : 0;
    }

    function buildPunchSequenceTimings(moves, initialDuration, retractPunchDuringFall) {
      const sequenceSet = new Set();

      moves.forEach((move) => {
        normalizedPunchSegments(move).forEach((segment) => {
          sequenceSet.add(segment.sequence);
        });

        if (isPunchVisualMove(move)) {
          sequenceSet.add(punchSequenceForVisualMove(move));
        }
      });

      const sequences = Array.from(sequenceSet).sort((left, right) => left - right);
      const timings = new Map();
      let cursor = initialDuration;
      let totalDuration = initialDuration;

      sequences.forEach((sequence) => {
        let punchDuration = MOVE_DURATION_MS;
        let retractDuration = 0;

        moves.forEach((move) => {
          normalizedPunchSegments(move)
            .filter((segment) => segment.sequence === sequence)
            .forEach((segment) => {
              punchDuration = Math.max(punchDuration, punchSegmentDurationFor(move, segment));
            });

          if (isPunchVisualMove(move) && punchSequenceForVisualMove(move) === sequence) {
            punchDuration = Math.max(punchDuration, punchVisualCycleDurationFor(move));
          }
        });

        const timing = {
          sequence,
          start: cursor,
          punchDuration,
          retractDuration,
          punchEnd: cursor + punchDuration,
          retractEnd: cursor + punchDuration + retractDuration
        };

        timings.set(sequence, timing);
        cursor = timing.punchEnd;
        totalDuration = Math.max(totalDuration, timing.retractEnd);
      });

      return { timings, totalDuration };
    }

    function segmentProgress(elapsedMs, distance, durationMs, iceSlide = false, reverse = false) {
      if (distance <= 0) {
        return 1;
      }

      if (iceSlide) {
        return iceSlideProgressForDuration(elapsedMs, distance, durationMs, reverse);
      }

      const progress = durationMs <= 0 ? 1 : Math.min(1, elapsedMs / durationMs);
      return easeInOutQuad(progress);
    }

    function runQueuedAction() {
      if (!app.queuedAction) {
        return;
      }

      const nextAction = app.queuedAction;
      app.queuedAction = null;
      runAction(nextAction);
    }

    function syncSurfaceAnimationTargets(now) {
      app.liveRaisedPlayerGates = app.gateRenderOverride || computeRaisedPlayerGateSet();
      app.liveRaisedOrangeWalls = app.orangeWallRenderOverride || computeRaisedOrangeWallSet();
      app.syncGateAnimationTargets?.(now);
      app.syncOrangeWallAnimationTargets?.(now);
      app.syncPlayerLiftAnimationTargets?.(now);
    }

    function liftRenderElevation(fromElevation, toElevation, progress) {
      const eased =
        toElevation > fromElevation ? easeOutBack(progress) : easeInOutQuad(progress);
      const cappedProgress = toElevation > fromElevation ? Math.min(1.08, eased) : eased;

      return fromElevation + (toElevation - fromElevation) * cappedProgress;
    }

    function liftPhaseStartElevationForMove(move) {
      const fromElevation = move.fromElevation ?? move.actor?.elevation ?? 0;

      if (move.pathControlsElevation === true && Array.isArray(move.path) && move.path.length > 0) {
        const pathEndElevation = pathRenderEndElevationForMove(move);

        if (Number.isFinite(pathEndElevation)) {
          return pathEndElevation;
        }
      }

      return fromElevation;
    }

    function pathRenderEndElevationForMove(move) {
      if (!Array.isArray(move.path) || move.path.length === 0) {
        return null;
      }

      const pathEndElevation = Number(move.path[move.path.length - 1]?.elevation);

      return Number.isFinite(pathEndElevation) ? pathEndElevation : null;
    }

    function shouldDeferPathDropToHoleFall(move) {
      return (
        move.fromRemoved !== true &&
        move.toRemoved === true &&
        move.pathControlsElevation === true &&
        pathRenderEndElevationForMove(move) !== null
      );
    }

    function fallPhaseStartElevationForMove(move) {
      if (shouldDeferPathDropToHoleFall(move)) {
        return pathRenderEndElevationForMove(move);
      }

      return move.toElevation ?? move.actor?.elevation ?? 0;
    }

    function finishAnimation(moves, options = {}) {
      const onFinish = typeof options.onFinish === "function" ? options.onFinish : null;
      const mainPlayerFell =
        app.autoUndoPlayerFalls === true &&
        moves.some(
          (move) =>
            move?.visualOnly !== true &&
            move?.fromRemoved !== true &&
            move?.toRemoved === true &&
            app.isMainPlayerActor?.(move.actor)
        );
      movement.applyMoveFinalState(moves);
      app.gateRenderOverride = null;
      app.orangeWallRenderOverride = null;
      app.isAnimating = false;
      app.inputActionEndsAtMs = 0;
      app.animationFrameId = null;
      syncFloatingFloorTicker();
      app.render();

      if (onFinish) {
        onFinish();
        return;
      }

      if (mainPlayerFell) {
        app.queuedAction = null;
        app.onPlayerPitAutoUndo?.();
        undoMove({
          blinkCount: 1,
          blinkDurationMs: 50,
          blinkRevivedPlayer: true,
          blinkVisibleDurationMs: 50,
          instantRestore: true
        });
        return;
      }

      runQueuedAction();
    }

    function animateMoves(moves, durationMs = null, options = {}) {
      if (moves.length === 0) {
        return;
      }

      moves.sort((left, right) => {
        const leftVisual = isPunchVisualMove(left) ? 1 : 0;
        const rightVisual = isPunchVisualMove(right) ? 1 : 0;

        return leftVisual - rightVisual;
      });

      app.isAnimating = true;
      const startLiftPhaseCallback =
        typeof options.startLiftPhase === "function" ? options.startLiftPhase : null;
      const moveFrameCallback =
        typeof options.onMoveFrame === "function" ? options.onMoveFrame : null;
      const liftPhaseFirst = options.liftPhaseFirst === true;
      const holeStateMoves = moves.filter(
        ({
          fromRemoved = false,
          toRemoved = false,
          skipHoleFall = false,
          snapHoleRestore = false
        }) => !skipHoleFall && !snapHoleRestore && fromRemoved !== toRemoved
      );
      const liftStateMoves = moves.filter(
        (move) => {
          if (shouldDeferPathDropToHoleFall(move)) {
            return false;
          }

          const liftFromElevation = liftPhaseStartElevationForMove(move);
          return liftFromElevation !== (move.toElevation ?? liftFromElevation);
        }
      );
      const preTerrainLiftMoveSet =
        options.preTerrainLiftMoves instanceof Set ? options.preTerrainLiftMoves : new Set();
      const preTerrainLiftStateMoves = liftStateMoves.filter((move) =>
        preTerrainLiftMoveSet.has(move)
      );
      const postTerrainLiftStateMoves = liftStateMoves.filter(
        (move) => !preTerrainLiftMoveSet.has(move)
      );
      const hasPunchPhase = moves.some((move) => hasPunchStart(move) || isPunchVisualMove(move));
      const retractPunchDuringFall = false;
      const hasSequencedPunchPhase =
        hasPunchPhase &&
        typeof durationMs !== "number" &&
        moves.some(
          (move) =>
            normalizedPunchSegments(move).length > 0 ||
            (isPunchVisualMove(move) && Number.isFinite(Number(move.punchSequence)))
        );
      const punchPhaseOneDuration =
        hasPunchPhase && typeof durationMs !== "number"
          ? Math.max(MOVE_DURATION_MS, ...moves.map(punchPhaseOneDurationFor))
          : 0;
      const punchSequenceTimings = hasSequencedPunchPhase
        ? buildPunchSequenceTimings(moves, punchPhaseOneDuration, retractPunchDuringFall)
        : { timings: new Map(), totalDuration: 0 };
      const punchPhaseTwoDuration =
        hasPunchPhase && typeof durationMs !== "number"
          ? Math.max(MOVE_DURATION_MS, ...moves.map(punchPhaseTwoDurationFor))
          : 0;
      const punchRetractDuration =
        hasPunchPhase && typeof durationMs !== "number" && !retractPunchDuringFall
          ? Math.max(MOVE_DURATION_MS, ...moves.map(punchRetractDurationFor))
          : 0;
      const moveDuration =
        typeof durationMs === "number"
          ? durationMs
          : hasPunchPhase
            ? hasSequencedPunchPhase
              ? punchSequenceTimings.totalDuration
              : punchPhaseOneDuration + punchPhaseTwoDuration + punchRetractDuration
            : Math.max(MOVE_DURATION_MS, ...moves.map(moveDurationFor));
      const liftPhaseDuration = (activeMoves) =>
        activeMoves.reduce((duration, move) => {
          const fromElevation = liftPhaseStartElevationForMove(move);
          const toElevation = move.toElevation ?? fromElevation;
          const moveLiftDuration =
            toElevation > fromElevation
              ? PLAYER_LIFT_RISE_DURATION_MS
              : PLAYER_LIFT_FALL_DURATION_MS;
          return Math.max(duration, moveLiftDuration);
        }, 0);
      app.inputActionEndsAtMs =
        performance.now() +
        moveDuration +
        liftPhaseDuration(preTerrainLiftStateMoves) +
        liftPhaseDuration(postTerrainLiftStateMoves) +
        (holeStateMoves.length > 0 ? HOLE_FALL_DURATION_MS : 0);
      const useIceSlideTiming = typeof durationMs !== "number";
      const completedLiftMoves = new Set();
      const logicalMoveByActor = new Map();

      moves.forEach((move) => {
        if (move.visualOnly !== true && move.actor && !logicalMoveByActor.has(move.actor)) {
          logicalMoveByActor.set(move.actor, move);
        }
      });

      function lerpMovePoint(fromX, fromY, fromElevation, toX, toY, toElevation, progress) {
        return {
          x: fromX + (toX - fromX) * progress,
          y: fromY + (toY - fromY) * progress,
          elevation: fromElevation + (toElevation - fromElevation) * progress
        };
      }

      function visualBasePointForMove(move, elapsedMs) {
        const fromElevation = move.fromElevation ?? move.actor?.elevation ?? 0;
        const toElevation = move.toElevation ?? fromElevation;
        const punchSegments = normalizedPunchSegments(move);
        const usesPath = Array.isArray(move.path) && move.path.length > 1;

        if (hasSequencedPunchPhase && useIceSlideTiming && punchSegments.length > 0) {
          const firstSegment = punchSegments[0];

          if (elapsedMs < punchPhaseOneDuration) {
            const distance = punchPhaseOneDistance(move);
            const duration = punchPhaseOneDurationFor(move);
            const progress = segmentProgress(
              elapsedMs,
              distance,
              duration,
              firstSegment.startIceSlide === true,
              move.reverseIceSlide === true
            );

            if (usesPath) {
              const point = pointAlongPathToPoint(
                move,
                {
                  x: firstSegment.fromX,
                  y: firstSegment.fromY,
                  elevation: firstSegment.fromElevation
                },
                progress
              );

              if (point) {
                return point;
              }
            }

            return lerpMovePoint(
              move.fromX,
              move.fromY,
              fromElevation,
              firstSegment.fromX,
              firstSegment.fromY,
              firstSegment.fromElevation,
              progress
            );
          }

          let activeSegment = null;
          let activeTiming = null;
          let lastCompletedSegment = null;

          for (let index = 0; index < punchSegments.length; index += 1) {
            const segment = punchSegments[index];
            const timing = punchSequenceTimings.timings.get(segment.sequence);

            if (!timing) {
              continue;
            }

            if (elapsedMs < timing.start) {
              break;
            }

            if (elapsedMs < timing.punchEnd) {
              activeSegment = segment;
              activeTiming = timing;
              break;
            }

            lastCompletedSegment = segment;
          }

          if (activeSegment && activeTiming) {
            const distance = punchSegmentDistance(activeSegment);
            const duration = punchSegmentDurationFor(move, activeSegment);
            const progress = segmentProgress(
              elapsedMs - activeTiming.start,
              distance,
              duration,
              activeSegment.punchSlide === true || move.punchSlide === true || move.iceSlide === true
            );

            return lerpMovePoint(
              activeSegment.fromX,
              activeSegment.fromY,
              activeSegment.fromElevation,
              activeSegment.toX,
              activeSegment.toY,
              activeSegment.toElevation,
              progress
            );
          }

          // A later punch train has not started yet. Keep its actors at the
          // start of their first segment instead of previewing that segment's
          // destination, which otherwise makes them jump ahead and snap back
          // when their puncher actually fires.
          if (!lastCompletedSegment) {
            return {
              x: firstSegment.fromX,
              y: firstSegment.fromY,
              elevation: firstSegment.fromElevation
            };
          }

          const renderSegment = lastCompletedSegment;

          return {
            x: renderSegment.toX,
            y: renderSegment.toY,
            elevation: renderSegment.toElevation
          };
        }

        if (hasPunchPhase && useIceSlideTiming && hasPunchStart(move)) {
          const punchPhaseTwoStart = punchPhaseOneDuration;
          const punchRetractStart = punchPhaseOneDuration + punchPhaseTwoDuration;
          const inPunchPhase = elapsedMs >= punchPhaseTwoStart;
          const inRetractPhase = !retractPunchDuringFall && elapsedMs >= punchRetractStart;

          if (inRetractPhase) {
            return { x: move.toX, y: move.toY, elevation: toElevation };
          }

          if (inPunchPhase) {
            const distance = punchPhaseTwoDistance(move);
            const duration = punchPhaseTwoDurationFor(move);
            const progress = segmentProgress(
              Math.max(0, elapsedMs - punchPhaseTwoStart),
              distance,
              duration,
              move.punchSlide === true || move.iceSlide === true
            );

            return lerpMovePoint(
              move.punchStartX,
              move.punchStartY,
              move.punchStartElevation ?? fromElevation,
              move.toX,
              move.toY,
              toElevation,
              progress
            );
          }

          const distance = punchPhaseOneDistance(move);
          const duration = punchPhaseOneDurationFor(move);
          const progress = segmentProgress(
            elapsedMs,
            distance,
            duration,
            move.punchStartIceSlide === true,
            move.reverseIceSlide === true
          );

          if (usesPath) {
            const point = pointAlongPath(move, progress);

            if (point) {
              return point;
            }
          }

          return lerpMovePoint(
            move.fromX,
            move.fromY,
            fromElevation,
            move.punchStartX,
            move.punchStartY,
            move.punchStartElevation ?? fromElevation,
            progress
          );
        }

        if (usesPath && !hasPunchStart(move)) {
          const progress = useIceSlideTiming && move.iceSlide
            ? iceSlideProgressForDuration(elapsedMs, pathDistanceFor(move), moveDuration, move.reverseIceSlide === true)
            : moveDuration <= 0
              ? 1
              : easeInOutQuad(Math.min(1, elapsedMs / moveDuration));
          const point = pointAlongPath(move, progress);

          if (point) {
            return point;
          }
        }

        const distance = moveDistance(move);
        const progress = useIceSlideTiming && move.iceSlide
          ? iceSlideProgressForDuration(elapsedMs, distance, moveDuration, move.reverseIceSlide === true)
          : moveDuration <= 0
            ? 1
            : easeInOutQuad(Math.min(1, elapsedMs / moveDuration));

        return lerpMovePoint(
          move.fromX,
          move.fromY,
          fromElevation,
          move.toX,
          move.toY,
          toElevation,
          progress
        );
      }

      function runLiftAnimation(activeLiftMoves, nextPhase, options = {}) {
        if (activeLiftMoves.length === 0) {
          nextPhase();
          return;
        }

        const activeLiftMoveSet = new Set(activeLiftMoves);
        const commitElevationAtEnd = options.commitElevationAtEnd === true;
        const elapsedForLift = createAnimationElapsedTracker();
        syncSurfaceAnimationTargets(performance.now());

        function stepLift(now) {
          const elapsedMs = elapsedForLift(now);
          let hasActiveLift = false;

          moves.forEach((move) => {
            const {
              actor,
              fromX,
              fromY,
              toX,
              toY,
              fromElevation = actor.elevation ?? 0,
              toElevation = fromElevation,
              fromRemoved = false,
              visibleDuringMove = false,
              fadeOut = false,
              toRemoved = false
            } = move;
            const liftFromElevation = liftPhaseStartElevationForMove(move);

            actor.renderPunchEffect =
              retractPunchDuringFall && isPunchVisualMove(move) ? true : false;
            actor.renderX = liftPhaseFirst ? fromX : toX;
            actor.renderY = liftPhaseFirst ? fromY : toY;
            actor.renderInHole = false;

            if (fromRemoved && !visibleDuringMove) {
              actor.renderScale = 0;
              actor.renderSink = HOLE_SINK_DISTANCE;
            } else {
              actor.renderScale = 1;
              actor.renderSink = 0;
            }

            if (liftFromElevation === toElevation) {
              actor.renderElevation = toElevation;
              actor.renderAlpha = fadeOut && toRemoved ? 0 : 1;
              return;
            }

            if (!activeLiftMoveSet.has(move)) {
              actor.renderElevation = completedLiftMoves.has(move) ? toElevation : liftFromElevation;
              actor.renderAlpha = fadeOut && toRemoved ? 0 : 1;
              return;
            }

            const duration =
              toElevation > liftFromElevation
                ? PLAYER_LIFT_RISE_DURATION_MS
                : PLAYER_LIFT_FALL_DURATION_MS;
            const progress = Math.min(1, elapsedMs / duration);
            actor.renderElevation = liftRenderElevation(liftFromElevation, toElevation, progress);
            actor.renderAlpha = fadeOut && toRemoved ? 0 : 1;

            if (progress < 1) {
              hasActiveLift = true;
            }
          });

          (app.renderOncePerFrame || app.render)(now);

          if (hasActiveLift) {
            app.animationFrameId = window.requestAnimationFrame(stepLift);
            return;
          }

          activeLiftMoves.forEach((move) => {
            completedLiftMoves.add(move);

            if (commitElevationAtEnd) {
              move.actor.elevation = move.toElevation ?? move.fromElevation ?? move.actor.elevation ?? 0;
              move.actor.renderElevation = move.actor.elevation;
            }
          });

          nextPhase();
        }

        app.animationFrameId = window.requestAnimationFrame(stepLift);
      }

      function startLiftPhase(nextPhase) {
        const startPostTerrainLiftPhase = () => {
          if (startLiftPhaseCallback) {
            startLiftPhaseCallback();
          }

          runLiftAnimation(postTerrainLiftStateMoves, nextPhase);
        };

        if (preTerrainLiftStateMoves.length > 0) {
          runLiftAnimation(preTerrainLiftStateMoves, startPostTerrainLiftPhase, {
            commitElevationAtEnd: true
          });
          return;
        }

        startPostTerrainLiftPhase();
      }

      function startMovePhase(useToElevation = false) {
        const elapsedForMove = createAnimationElapsedTracker();

        function step(now) {
          const elapsedMs = elapsedForMove(now);
          const progress = moveDuration <= 0 ? 1 : Math.min(1, elapsedMs / moveDuration);
          const eased = easeInOutQuad(progress);

          moves.forEach(
            (move) => {
              const {
                actor,
                fromX,
                fromY,
                toX,
                toY,
                fromRemoved = false,
                visibleDuringMove = false,
                fromElevation = actor.elevation ?? 0,
                toElevation = fromElevation,
                fadeOut = false,
                toRemoved = false,
                fadeStartProgress = 0,
                fadeEndProgress = 1,
                iceSlide = false,
                reverseIceSlide = false,
                punchEffect = false
              } = move;
              let renderFromX = fromX;
              let renderFromY = fromY;
              let renderToX = toX;
              let renderToY = toY;
              let renderFromElevation = fromElevation;
              let renderToElevation = useToElevation ? toElevation : fromElevation;
              const usesPath = Array.isArray(move.path) && move.path.length > 1;
              const pathDistance = usesPath ? pathDistanceFor(move) : 0;
              let positionProgress = useIceSlideTiming && iceSlide
                ? iceSlideProgressForDuration(
                    elapsedMs,
                    usesPath ? pathDistance : moveDistance({ fromX, fromY, toX, toY }),
                    moveDuration,
                    reverseIceSlide
                  )
                : eased;
              let renderPunchEffect = punchEffect === true;
              let pathPointOverride = null;

              if (hasSequencedPunchPhase && useIceSlideTiming) {
                const punchSegments = normalizedPunchSegments(move);

                if (isPunchVisualMove(move)) {
                  const timing = punchSequenceTimings.timings.get(punchSequenceForVisualMove(move));
                  const baseX = typeof move.finalX === "number" ? move.finalX : fromX;
                  const baseY = typeof move.finalY === "number" ? move.finalY : fromY;
                  const baseElevation =
                    typeof move.finalElevation === "number" ? move.finalElevation : fromElevation;
                  const baseMove = logicalMoveByActor.get(actor);
                  const basePoint = baseMove
                    ? visualBasePointForMove(baseMove, elapsedMs)
                    : { x: baseX, y: baseY, elevation: baseElevation };
                  const lungeDx = toX - baseX;
                  const lungeDy = toY - baseY;
                  let lungeProgress = 0;

                  if (!timing || elapsedMs < timing.start) {
                    renderPunchEffect = false;
                  } else {
                    const distance = punchPhaseTwoDistance(move);
                    const duration = punchPhaseTwoDurationFor(move);
                    const lungeEnd = timing.start + duration;
                    const retractDuration = punchRetractDurationFor(move);
                    const retractEnd = lungeEnd + retractDuration;

                    if (elapsedMs < lungeEnd) {
                      lungeProgress = segmentProgress(elapsedMs - timing.start, distance, duration, true);
                      renderPunchEffect = true;
                    } else if (elapsedMs < retractEnd) {
                      lungeProgress = 1 - segmentProgress(
                        elapsedMs - lungeEnd,
                        punchRetractDistance(move),
                        retractDuration,
                        true
                      );
                      renderPunchEffect = true;
                    } else {
                      renderPunchEffect = false;
                    }
                  }

                  renderFromX = basePoint.x;
                  renderFromY = basePoint.y;
                  renderToX = basePoint.x + lungeDx;
                  renderToY = basePoint.y + lungeDy;
                  renderFromElevation = basePoint.elevation;
                  renderToElevation = basePoint.elevation;
                  positionProgress = lungeProgress;
                  actor.renderPunchBaseX = basePoint.x;
                  actor.renderPunchBaseY = basePoint.y;
                } else if (punchSegments.length > 0) {
                  const firstSegment = punchSegments[0];

                  if (elapsedMs < punchPhaseOneDuration) {
                    const distance = punchPhaseOneDistance(move);
                    const duration = punchPhaseOneDurationFor(move);

                    positionProgress = segmentProgress(
                      elapsedMs,
                      distance,
                      duration,
                      firstSegment.startIceSlide === true,
                      reverseIceSlide
                    );

                    if (usesPath) {
                      pathPointOverride = pointAlongPathToPoint(
                        move,
                        {
                          x: firstSegment.fromX,
                          y: firstSegment.fromY,
                          elevation: firstSegment.fromElevation
                        },
                        positionProgress
                      );
                    } else {
                      renderToX = firstSegment.fromX;
                      renderToY = firstSegment.fromY;
                      renderToElevation = firstSegment.fromElevation;
                    }
                  } else {
                    let activeSegment = null;
                    let activeTiming = null;
                    let lastCompletedSegment = null;

                    for (let index = 0; index < punchSegments.length; index += 1) {
                      const segment = punchSegments[index];
                      const timing = punchSequenceTimings.timings.get(segment.sequence);

                      if (!timing) {
                        continue;
                      }

                      if (elapsedMs < timing.start) {
                        break;
                      }

                      if (elapsedMs < timing.punchEnd) {
                        activeSegment = segment;
                        activeTiming = timing;
                        break;
                      }

                      lastCompletedSegment = segment;
                    }

                    if (activeSegment && activeTiming) {
                      const distance = punchSegmentDistance(activeSegment);
                      const duration = punchSegmentDurationFor(move, activeSegment);

                      renderFromX = activeSegment.fromX;
                      renderFromY = activeSegment.fromY;
                      renderToX = activeSegment.toX;
                      renderToY = activeSegment.toY;
                      renderFromElevation = activeSegment.fromElevation;
                      renderToElevation = activeSegment.toElevation;
                      positionProgress = segmentProgress(
                        elapsedMs - activeTiming.start,
                        distance,
                        duration,
                        activeSegment.punchSlide === true ||
                          move.punchSlide === true ||
                          iceSlide === true
                      );
                    } else if (!lastCompletedSegment) {
                      renderFromX = firstSegment.fromX;
                      renderFromY = firstSegment.fromY;
                      renderToX = firstSegment.fromX;
                      renderToY = firstSegment.fromY;
                      renderFromElevation = firstSegment.fromElevation;
                      renderToElevation = firstSegment.fromElevation;
                      positionProgress = 1;
                    } else {
                      renderFromX = lastCompletedSegment.toX;
                      renderFromY = lastCompletedSegment.toY;
                      renderToX = lastCompletedSegment.toX;
                      renderToY = lastCompletedSegment.toY;
                      renderFromElevation = lastCompletedSegment.toElevation;
                      renderToElevation = lastCompletedSegment.toElevation;
                      positionProgress = 1;
                    }
                  }
                } else if (elapsedMs >= punchPhaseOneDuration) {
                  renderFromX = toX;
                  renderFromY = toY;
                  renderToX = toX;
                  renderToY = toY;
                  renderFromElevation = toElevation;
                  renderToElevation = toElevation;
                  positionProgress = 1;
                  renderPunchEffect = false;
                } else {
                  const distance = punchPhaseOneDistance(move);
                  const duration = punchPhaseOneDurationFor(move);

                  positionProgress = segmentProgress(elapsedMs, distance, duration, iceSlide, reverseIceSlide);
                }
              } else if (hasPunchPhase && useIceSlideTiming) {
                const punchPhaseTwoStart = punchPhaseOneDuration;
                const punchRetractStart = punchPhaseOneDuration + punchPhaseTwoDuration;
                const inPunchPhase = elapsedMs >= punchPhaseTwoStart;
                const inRetractPhase = !retractPunchDuringFall && elapsedMs >= punchRetractStart;
                const punchElapsedMs = Math.max(0, elapsedMs - punchPhaseTwoStart);
                const retractElapsedMs = Math.max(0, elapsedMs - punchRetractStart);

                if (isPunchVisualMove(move)) {
                  if (inRetractPhase) {
                    const finalX = typeof move.finalX === "number" ? move.finalX : fromX;
                    const finalY = typeof move.finalY === "number" ? move.finalY : fromY;
                    const distance = punchRetractDistance(move);
                    const duration = punchRetractDurationFor(move);

                    renderFromX = toX;
                    renderFromY = toY;
                    renderToX = finalX;
                    renderToY = finalY;
                    positionProgress = segmentProgress(retractElapsedMs, distance, duration, true);
                    renderPunchEffect = true;
                  } else if (inPunchPhase) {
                    const distance = punchPhaseTwoDistance(move);
                    const duration = punchPhaseTwoDurationFor(move);

                    positionProgress = segmentProgress(punchElapsedMs, distance, duration, true);
                    renderPunchEffect = true;
                  } else {
                    renderToX = fromX;
                    renderToY = fromY;
                    positionProgress = 1;
                    renderPunchEffect = false;
                  }
                } else if (hasPunchStart(move)) {
                  if (inRetractPhase) {
                    renderFromX = toX;
                    renderFromY = toY;
                    positionProgress = 1;
                    renderPunchEffect = false;
                  } else if (inPunchPhase) {
                    const distance = punchPhaseTwoDistance(move);
                    const duration = punchPhaseTwoDurationFor(move);

                    renderFromX = move.punchStartX;
                    renderFromY = move.punchStartY;
                    positionProgress = segmentProgress(
                      punchElapsedMs,
                      distance,
                      duration,
                      move.punchSlide === true || iceSlide === true
                    );
                  } else {
                    const distance = punchPhaseOneDistance(move);
                    const duration = punchPhaseOneDurationFor(move);

                    positionProgress = segmentProgress(
                      elapsedMs,
                      distance,
                      duration,
                      move.punchStartIceSlide === true,
                      reverseIceSlide
                    );

                    if (usesPath) {
                      pathPointOverride = pointAlongPath(move, positionProgress);
                    } else {
                      renderToX = move.punchStartX;
                      renderToY = move.punchStartY;
                    }
                  }
                } else if (inPunchPhase) {
                  renderFromX = toX;
                  renderFromY = toY;
                  positionProgress = 1;
                  renderPunchEffect = false;
                } else {
                  const distance = punchPhaseOneDistance(move);
                  const duration = punchPhaseOneDurationFor(move);

                  positionProgress = segmentProgress(elapsedMs, distance, duration, iceSlide, reverseIceSlide);
                }
              }

              if (pathPointOverride) {
                actor.renderX = pathPointOverride.x;
                actor.renderY = pathPointOverride.y;
                actor.renderElevation = pathPointOverride.elevation;
              } else if (usesPath && !hasPunchStart(move) && !isPunchVisualMove(move)) {
                const pathPoint = pointAlongPath(move, positionProgress);

                actor.renderX = pathPoint.x;
                actor.renderY = pathPoint.y;
                actor.renderElevation = pathPoint.elevation;
              } else {
                actor.renderX = renderFromX + (renderToX - renderFromX) * positionProgress;
                actor.renderY = renderFromY + (renderToY - renderFromY) * positionProgress;
                actor.renderElevation =
                  renderFromElevation + (renderToElevation - renderFromElevation) * positionProgress;
              }
              actor.renderInHole = false;
              actor.renderPunchEffect = renderPunchEffect;
              actor.renderAlpha =
                fadeOut && toRemoved
                  ? fadeAlphaForMoveProgress(progress, fadeStartProgress, fadeEndProgress)
                  : 1;

              if (fromRemoved && !visibleDuringMove) {
                actor.renderScale = 0;
                actor.renderSink = HOLE_SINK_DISTANCE;
                return;
              }

              actor.renderScale = 1;
              actor.renderSink = 0;
            }
          );

          if (moveFrameCallback) {
            moveFrameCallback({
              elapsedMs,
              moveDuration,
              moves,
              progress
            });
          }

          (app.renderOncePerFrame || app.render)(now);

          if (progress < 1) {
            app.animationFrameId = window.requestAnimationFrame(step);
            return;
          }

          if (liftPhaseFirst) {
            startFallPhase();
            return;
          }

          startLiftPhase(startFallPhase);
        }

        app.animationFrameId = window.requestAnimationFrame(step);
      }

      function startFallPhase() {
        if (holeStateMoves.length === 0) {
          finishAnimation(moves, options);
          return;
        }

        if (retractPunchDuringFall) {
          moves.forEach((move) => {
            if (!isPunchVisualMove(move)) {
              return;
            }

            move.actor.renderX = move.toX;
            move.actor.renderY = move.toY;
            move.actor.renderElevation = move.toElevation ?? move.actor.elevation ?? 0;
            move.actor.renderPunchEffect = true;
            move.actor.renderAlpha = 1;
            move.actor.renderScale = 1;
            move.actor.renderSink = 0;
          });
        }

        const elapsedForFall = createAnimationElapsedTracker();

        function stepFall(now) {
          const elapsedMs = elapsedForFall(now);
          const progress = Math.min(1, elapsedMs / HOLE_FALL_DURATION_MS);
          const eased = easeInOutQuad(progress);

          moves.forEach(
            (move) => {
              const {
                actor,
                toX,
                toY,
                fromRemoved = false,
                toRemoved = false,
                skipHoleFall = false,
                toElevation = actor.elevation ?? 0,
                fadeOut = false
              } = move;
              const fallStartElevation = fallPhaseStartElevationForMove(move);

              if (isPunchVisualMove(move)) {
                actor.renderX = typeof move.finalX === "number" ? move.finalX : move.fromX;
                actor.renderY = typeof move.finalY === "number" ? move.finalY : move.fromY;
                actor.renderElevation =
                  typeof move.finalElevation === "number" ? move.finalElevation : fallStartElevation;
                actor.renderInHole = false;
                actor.renderPunchEffect = false;
                actor.renderAlpha = 1;
                actor.renderScale = 1;
                actor.renderSink = 0;
                return;
              }

              actor.renderX = toX;
              actor.renderY = toY;
              actor.renderElevation = fallStartElevation;
              actor.renderInHole = !skipHoleFall && fromRemoved !== toRemoved;
              actor.renderPunchEffect = false;
              actor.renderAlpha = fadeOut && toRemoved ? 0 : 1;

              if (skipHoleFall) {
                actor.renderScale = 1;
                actor.renderSink = 0;
                return;
              }

              if (fromRemoved && !toRemoved) {
                actor.renderScale = 1;
                actor.renderAlpha = eased;
                actor.renderSink = HOLE_SINK_DISTANCE * (1 - eased);
                return;
              }

              if (!fromRemoved && toRemoved) {
                actor.renderScale = 1;
                actor.renderAlpha = holeFallAlphaForProgress(progress);
                actor.renderSink = holeFallSinkForProgress(progress);
                return;
              }

              actor.renderScale = toRemoved ? 0 : 1;
              actor.renderSink = toRemoved ? HOLE_SINK_DISTANCE : 0;
            }
          );

          (app.renderOncePerFrame || app.render)(now);

          if (progress < 1) {
            app.animationFrameId = window.requestAnimationFrame(stepFall);
            return;
          }

          finishAnimation(moves, options);
        }

        app.animationFrameId = window.requestAnimationFrame(stepFall);
      }

      if (app.animationFrameId !== null) {
        window.cancelAnimationFrame(app.animationFrameId);
      }

      if (liftPhaseFirst) {
        startLiftPhase(() => {
          startMovePhase(true);
        });
        return;
      }

      startMovePhase(false);
    }

    function buildMovesToPositions(targetPositions, options = {}) {
      const moves = [];
      const collectedGemVisual = options.collectedGemVisual || null;

      state.actors.forEach((actor, index) => {
        const target = targetPositions[index];

        if (!target) {
          return;
        }

        const fromX = actor.x;
        const fromY = actor.y;
        const fromRemoved = Boolean(actor.removed);
        const toRemoved = Boolean(target.removed);
        const fromElevation = actor.elevation ?? 0;
        const toElevation = target.elevation ?? 0;
        const fromRaised = actor.raised === true;
        const toRaised = target.raised === true;
        const isCollectedGemTarget =
          actor.type === "gem" &&
          (target.collected === true ||
            (target.collectionId && app.collectedGemIds?.has?.(target.collectionId)) ||
            (actor.collectionId && app.collectedGemIds?.has?.(actor.collectionId)));
        actor.x = target.x;
        actor.y = target.y;
        actor.elevation = toElevation;
        actor.collectionId = target.collectionId || actor.collectionId || null;
        actor.collected = isCollectedGemTarget;

        if (actor.type === "attached_lift" && fromRaised !== toRaised) {
          actor.raised = toRaised;
          app.terrainRenderVersion = (Number(app.terrainRenderVersion) || 0) + 1;
        }

        if (!toRemoved) {
          actor.removed = false;
        }

        if (
          fromX === target.x &&
          fromY === target.y &&
          fromRemoved === toRemoved &&
          fromElevation === toElevation
        ) {
          actor.renderX = target.x;
          actor.renderY = target.y;
          actor.renderElevation = toElevation;
          if (isCollectedGemTarget) {
            if (collectedGemVisual === "ghost" || target.showCollectedGhost === true) {
              app.applyCollectedGemVisual?.(actor);
            } else {
              app.hideCollectedGemVisual?.(actor);
            }
            return;
          }
          actor.renderScale = toRemoved ? 0 : 1;
          actor.renderAlpha = toRemoved ? 0 : 1;
          actor.renderSink = toRemoved ? HOLE_SINK_DISTANCE : 0;
          actor.renderInHole = false;
          actor.removed = toRemoved;
          return;
        }

        actor.renderX = fromX;
        actor.renderY = fromY;
        actor.renderElevation = fromElevation;
        actor.renderScale = fromRemoved ? 0 : 1;
        actor.renderAlpha = fromRemoved ? 0 : 1;
        actor.renderSink = fromRemoved ? HOLE_SINK_DISTANCE : 0;
        actor.renderInHole = false;
        moves.push({
          actor,
          actorIndex: index,
          fromX,
          fromY,
          toX: target.x,
          toY: target.y,
          fromRemoved,
          toRemoved,
          fromElevation,
          toElevation,
          snapHoleRestore: fromRemoved && !toRemoved,
          skipHoleFall: actor.type === "floating_floor" && fromRemoved !== toRemoved,
          collectedGemVisual,
          visibleDuringMove:
            fromRemoved && !toRemoved
              ? true
              : actor.type === "floating_floor" && fromRemoved !== toRemoved
        });
      });

      return moves;
    }

    function tryMovePlayersInstant(dx, dy) {
      if (app.isAnimating || app.isTransitioningLevel) {
        return {
          moved: false,
          moves: [],
          blocked: true
        };
      }

      return movement.performPlayerMove(dx, dy, {
        animate: false,
        recordHistory: false
      });
    }

    function isSlideContinuationSurface(type) {
      return type === "ice" || type === "ice_block" || type === "ice_slope";
    }

    function beginMoveUndoGroup() {
      if (!app.activeUndoGroupId) {
        app.activeUndoGroupId = `move-${nextUndoGroupId}`;
        nextUndoGroupId += 1;
      }

      return app.activeUndoGroupId;
    }

    function finishMoveUndoGroup() {
      app.activeUndoGroupId = null;
    }

    function playerSlideMoveForContinuation(moveResult) {
      if (!moveResult?.moved || !Array.isArray(moveResult.moves)) {
        return null;
      }

      const isTransitionPlayer =
        typeof app.isMainPlayerActor === "function" ? app.isMainPlayerActor : app.isPlayerActor;

      return (
        moveResult.moves.find(
          (move) =>
            move?.visualOnly !== true &&
            move?.toRemoved !== true &&
            isTransitionPlayer(move.actor) &&
            (move.iceSlide === true || move.punchSlide === true)
        ) || null
      );
    }

    function mainPlayerMoveForWorldAction(moveResult) {
      if (!moveResult?.moved || !Array.isArray(moveResult.moves)) {
        return null;
      }

      const isTransitionPlayer =
        typeof app.isMainPlayerActor === "function" ? app.isMainPlayerActor : app.isPlayerActor;

      return (
        moveResult.moves.find(
          (move) =>
            move?.visualOnly !== true &&
            isTransitionPlayer(move.actor)
        ) || null
      );
    }

    function playerLevelExitMoveForContinuation(moveResult, dx = null, dy = null) {
      if (!moveResult?.moved || !Array.isArray(moveResult.moves)) {
        return null;
      }

      const hasDirectionFilter = Number.isInteger(dx) && Number.isInteger(dy);
      const isTransitionPlayer =
        typeof app.isMainPlayerActor === "function" ? app.isMainPlayerActor : app.isPlayerActor;

      return (
        moveResult.moves.find(
          (move) =>
            move?.visualOnly !== true &&
            move?.toRemoved !== true &&
            move.levelExit === true &&
            (!hasDirectionFilter ||
              (move.levelExitDx === dx &&
                move.levelExitDy === dy)) &&
            isTransitionPlayer(move.actor)
        ) || null
      );
    }

    function normalizedDirectionFromDelta(deltaX, deltaY) {
      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        return { dx: Math.sign(deltaX), dy: 0 };
      }

      if (Math.abs(deltaY) > 0) {
        return { dx: 0, dy: Math.sign(deltaY) };
      }

      return null;
    }

    function lastMovementDirectionForPath(path) {
      if (!Array.isArray(path) || path.length < 2) {
        return null;
      }

      for (let index = path.length - 1; index > 0; index -= 1) {
        const from = path[index - 1];
        const to = path[index];
        const direction = normalizedDirectionFromDelta(
          Number(to?.x) - Number(from?.x),
          Number(to?.y) - Number(from?.y)
        );

        if (direction) {
          return direction;
        }
      }

      return null;
    }

    function playerMoveContinuationDirection(playerMove, fallbackDx, fallbackDy) {
      if (!playerMove) {
        return null;
      }

      if (Number.isInteger(playerMove.levelExitDx) || Number.isInteger(playerMove.levelExitDy)) {
        return {
          dx: Number(playerMove.levelExitDx) || 0,
          dy: Number(playerMove.levelExitDy) || 0
        };
      }

      const punchSegments = normalizedPunchSegments(playerMove);
      const lastPunchSegment = punchSegments[punchSegments.length - 1];

      if (lastPunchSegment) {
        const direction = normalizedDirectionFromDelta(
          lastPunchSegment.toX - lastPunchSegment.fromX,
          lastPunchSegment.toY - lastPunchSegment.fromY
        );

        if (direction) {
          return direction;
        }
      }

      if (hasPunchStart(playerMove)) {
        const direction = normalizedDirectionFromDelta(
          playerMove.toX - playerMove.punchStartX,
          playerMove.toY - playerMove.punchStartY
        );

        if (direction) {
          return direction;
        }
      }

      return lastMovementDirectionForPath(normalizedMovePath(playerMove)) || {
        dx: fallbackDx,
        dy: fallbackDy
      };
    }

    function shouldContinuePlayerMoveAcrossEdge(moveResult, edgeTransition) {
      const playerMove =
        playerSlideMoveForContinuation(moveResult) ||
        mainPlayerMoveForWorldAction(moveResult);

      if (!playerMove || playerMove.toRemoved === true || !edgeTransition) {
        return false;
      }

      if (playerMove.punchSlide === true) {
        return true;
      }

      return isSlideContinuationSurface(edgeTransition.sourceType);
    }

    function withContinuationModeForPlayerMove(edgeTransition, playerMove) {
      if (!edgeTransition || !playerMove) {
        return edgeTransition;
      }

      if (playerMove.punchSlide !== true) {
        return edgeTransition;
      }

      return {
        ...edgeTransition,
        continuePunchSlide: true,
        sourceType: edgeTransition.sourceType || "punch",
        targetElevation: edgeTransition.targetElevation ?? playerMove.toElevation ?? playerMove.fromElevation ?? 0
      };
    }

    function levelExitTransitionForMove(moveResult, dx, dy) {
      const playerMove = playerLevelExitMoveForContinuation(moveResult);

      if (
        !playerMove ||
        typeof app.adjacentWorldLevelId !== "function" ||
        !app.currentLevelId
      ) {
        return null;
      }

      const direction = playerMoveContinuationDirection(playerMove, dx, dy);
      const transitionDx = direction?.dx || 0;
      const transitionDy = direction?.dy || 0;

      if (!transitionDx && !transitionDy) {
        return null;
      }

      const nextLevelId = app.adjacentWorldLevelId(app.currentLevelId, transitionDx, transitionDy);

      if (!nextLevelId) {
        return null;
      }

      return withContinuationModeForPlayerMove({
        player: playerMove.actor,
        nextLevelId,
        sourceType: playerMove.levelExitSourceType || (playerMove.punchSlide === true ? "punch" : "ice_slope"),
        sourceElevation: playerMove.levelExitElevation ?? playerMove.toElevation ?? 0,
        targetElevation: playerMove.levelExitElevation ?? playerMove.toElevation ?? 0,
        dx: transitionDx,
        dy: transitionDy,
        targetX: transitionDx < 0 ? state.width - 1 : transitionDx > 0 ? 0 : playerMove.toX,
        targetY: transitionDy < 0 ? state.height - 1 : transitionDy > 0 ? 0 : playerMove.toY,
        continueFromCurrentSlope: true,
        continueMove: true
      }, playerMove);
    }

    function edgeTransitionForMoveResult(moveResult, dx, dy) {
      const playerMove =
        playerSlideMoveForContinuation(moveResult) ||
        mainPlayerMoveForWorldAction(moveResult);

      if (
        !playerMove ||
        (typeof app.edgeTransitionForPlayerMove !== "function" &&
          typeof app.adjacentWorldLevelId !== "function")
      ) {
        return null;
      }

      const direction = playerMoveContinuationDirection(playerMove, dx, dy);
      const transitionDx = direction?.dx || 0;
      const transitionDy = direction?.dy || 0;

      if (!transitionDx && !transitionDy) {
        return null;
      }

      const transitionElevation =
        playerMove.toElevation ?? playerMove.fromElevation ?? playerMove.actor?.elevation ?? 0;
      let edgeTransition =
        typeof app.edgeTransitionForPlayerMove === "function"
          ? app.edgeTransitionForPlayerMove(
              playerMove.actor,
              playerMove.toX,
              playerMove.toY,
              transitionElevation,
              transitionDx,
              transitionDy
            )
          : null;

      if (!edgeTransition && playerMove.punchSlide === true) {
        const onEdge =
          (transitionDx < 0 && playerMove.toX === 0) ||
          (transitionDx > 0 && playerMove.toX === state.width - 1) ||
          (transitionDy < 0 && playerMove.toY === 0) ||
          (transitionDy > 0 && playerMove.toY === state.height - 1);
        const nextLevelId =
          onEdge && typeof app.adjacentWorldLevelId === "function" && app.currentLevelId
            ? app.adjacentWorldLevelId(app.currentLevelId, transitionDx, transitionDy)
            : null;

        if (nextLevelId) {
          edgeTransition = {
            player: playerMove.actor,
            nextLevelId,
            sourceType: "punch",
            sourceElevation: transitionElevation,
            targetElevation: transitionElevation,
            dx: transitionDx,
            dy: transitionDy,
            targetX: transitionDx < 0 ? state.width - 1 : transitionDx > 0 ? 0 : playerMove.toX,
            targetY: transitionDy < 0 ? state.height - 1 : transitionDy > 0 ? 0 : playerMove.toY
          };
        }
      }

      if (!shouldContinuePlayerMoveAcrossEdge(moveResult, edgeTransition)) {
        return null;
      }

      return withContinuationModeForPlayerMove(edgeTransition, playerMove);
    }

    function continuationTransitionForMoveResult(moveResult, dx, dy) {
      return levelExitTransitionForMove(moveResult, dx, dy) ||
        edgeTransitionForMoveResult(moveResult, dx, dy);
    }

    function transitionLeadMsForMove(moveDuration) {
      const transitionDuration = app.LEVEL_TRANSITION_DURATION_MS || 1000;
      const normalizedMoveDuration = Number.isFinite(moveDuration) ? Math.max(0, moveDuration) : 0;

      return Math.max(
        MOVE_DURATION_MS * 1.6,
        Math.min(transitionDuration * 0.46, normalizedMoveDuration * 0.5)
      );
    }

    function extendedTransitionDurationMs(moveDuration, leadMs) {
      const transitionDuration = app.LEVEL_TRANSITION_DURATION_MS || 1000;
      const normalizedMoveDuration = Number.isFinite(moveDuration) ? Math.max(0, moveDuration) : 0;

      return Math.max(
        transitionDuration * 0.48,
        Math.min(
          transitionDuration * 0.68,
          transitionDuration * 0.42 + leadMs * 0.35 + normalizedMoveDuration * 0.05
        )
      );
    }

    function continuousRoomTransitionDurationMs(transition, moveDuration, leadMs) {
      const transitionDuration = app.LEVEL_TRANSITION_DURATION_MS || 1000;
      const roomDistance =
        Number(transition?.dx) !== 0
          ? Math.max(1, state.width || 1)
          : Math.max(1, state.height || 1);
      const roomSlideDuration = iceSlideDuration(roomDistance);

      return Math.max(
        transitionDuration * 0.5,
        Math.min(
          transitionDuration * 1.15,
          Math.max(roomSlideDuration, extendedTransitionDurationMs(moveDuration, leadMs))
        )
      );
    }

    function continuePlayerMoveAcrossEdge(moveResult, dx, dy) {
      if (
        typeof app.edgeTransitionForMove !== "function" ||
        typeof app.transitionToAdjacentLevel !== "function"
      ) {
        return false;
      }

      const edgeTransition = continuationTransitionForMoveResult(moveResult, dx, dy);

      if (!edgeTransition || !shouldContinuePlayerMoveAcrossEdge(moveResult, edgeTransition)) {
        return false;
      }

      Promise.resolve(
        app.transitionToAdjacentLevel({
          ...edgeTransition,
          continueMove: true,
          durationMs: continuousRoomTransitionDurationMs(
            edgeTransition,
            iceSlideDuration(Number(edgeTransition.dx) !== 0 ? state.width : state.height),
            0
          ),
          steadyCamera: true,
          replaceActiveTransition: true,
          skipNeighborhoodPreload: true,
          skipPrewarm: true,
          warmupPromise:
            typeof app.warmAdjacentLevelTransition === "function"
              ? app.warmAdjacentLevelTransition(edgeTransition, { preloadNeighborhood: "queue" })
              : null
        })
      ).then((didTransition) => {
        if (didTransition !== false) {
          return;
        }

        finishMoveUndoGroup();
        runQueuedAction();
      });
      return true;
    }

    function collectUndoGroupEntries(latestEntry) {
      const entries = [latestEntry];
      const undoGroupId = latestEntry?.undoGroupId || null;

      if (!undoGroupId) {
        return entries;
      }

      while (moveHistory.at(-1)?.undoGroupId === undoGroupId) {
        entries.push(moveHistory.pop());
      }

      return entries.reverse();
    }

    function finishRestoredUndo(options = {}) {
      app.gateRenderOverride = null;
      app.orangeWallRenderOverride = null;
      syncFloatingFloorTicker();

      if (options.blinkRevivedPlayer === true) {
        const players = state.actors.filter(
          (actor) => app.isMainPlayerActor?.(actor) && !actor.removed
        );
        app.render();
        app.blinkRevivedPlayer?.(players, {
          blinkCount: options.blinkCount,
          durationMs: options.blinkDurationMs,
          visibleDurationMs: options.blinkVisibleDurationMs
        });
        return;
      }

      app.render();
    }

    function restoreCrossRoomUndoState(levelSnapshot, entrySnapshot) {
      applyLevelState(levelSnapshot, {
        updateUrl: true,
        immediateCamera: true
      });

      if (entrySnapshot && typeof app.restoreLevelEntryState === "function") {
        app.restoreLevelEntryState(entrySnapshot);
      }

      // Undo restores the historical live room, but a later normal re-entry
      // must still load the room-entry reset state rather than that history.
      if (
        entrySnapshot &&
        typeof app.rememberHorizontalNeighborLevelState === "function"
      ) {
        app.rememberHorizontalNeighborLevelState(entrySnapshot);
      }
    }

    function restoreGroupedUndoEntry(firstEntry, options = {}) {
      if (firstEntry?.kind === "level-transition") {
        restoreCrossRoomUndoState(firstEntry.level, firstEntry.entry);
      } else if (firstEntry?.levelSnapshot) {
        restoreCrossRoomUndoState(
          firstEntry.levelSnapshot,
          firstEntry.levelEntrySnapshot
        );
      } else {
        restoreTerrainState(firstEntry.terrain);
      }

      finishRestoredUndo(options);
    }

    function activeUndoGroupIncludesLevelTransition() {
      const undoGroupId = app.activeUndoGroupId;

      if (!undoGroupId) {
        return false;
      }

      return moveHistory.some(
        (entry) => entry?.undoGroupId === undoGroupId && entry.kind === "level-transition"
      );
    }

    function rememberSettledEntryStateAfterContinuation() {
      if (
        activeUndoGroupIncludesLevelTransition() &&
        typeof app.rememberCurrentLevelEntryState === "function"
      ) {
        app.rememberCurrentLevelEntryState();
      }
    }

    function currentPlayerForWorldAction() {
      const isWorldActionPlayer =
        typeof app.isMainPlayerActor === "function"
          ? app.isMainPlayerActor
          : app.isPlayerActor;
      const players = state.actors.filter(
        (actor) => isWorldActionPlayer(actor) && !actor.removed
      );

      return players.length === 1 ? players[0] : null;
    }

    function worldActionLevelSnapshot() {
      const snapshot = app.cloneLevelSnapshot?.();

      if (!snapshot) {
        return null;
      }

      snapshot.raisedPlayerGates = Array.from(computeRaisedPlayerGateSet());
      snapshot.raisedOrangeWalls = Array.from(computeRaisedOrangeWallSet());

      return snapshot;
    }

    function cloneWorldActionLevelState(levelState) {
      if (!levelState) {
        return null;
      }

      if (typeof app.cloneStoredLevelSnapshot === "function") {
        return app.cloneStoredLevelSnapshot(levelState);
      }

      return JSON.parse(JSON.stringify(levelState));
    }

    function markWorldActionPlayerRemoved(levelState) {
      if (!levelState || !Array.isArray(levelState.actors)) {
        return levelState;
      }

      levelState.actors.forEach((actor) => {
        if (app.isPlayerActor(actor)) {
          actor.removed = true;
        }
      });

      return levelState;
    }

    function actionRoomOffsetAfterTransition(currentOffset, currentState, nextState, dx, dy) {
      return {
        x: dx < 0
          ? currentOffset.x - nextState.width
          : dx > 0
            ? currentOffset.x + currentState.width
            : currentOffset.x,
        y: dy < 0
          ? currentOffset.y - nextState.height
          : dy > 0
            ? currentOffset.y + currentState.height
            : currentOffset.y
      };
    }

    function appendWorldPathPoints(worldPath, localPath, roomOffset) {
      localPath.forEach((point) => {
        const worldPoint = {
          x: point.x + roomOffset.x,
          y: point.y + roomOffset.y,
          elevation: point.elevation
        };
        const previous = worldPath[worldPath.length - 1];

        if (previous && pathPointMatches(previous, worldPoint)) {
          return;
        }

        worldPath.push(worldPoint);
      });
    }

    function worldActionActorKey(actor, x = actor?.x, y = actor?.y, elevation = actor?.elevation ?? 0) {
      return [
        actor?.type || "",
        actor?.groupId || "",
        actor?.direction || actor?.facing || "",
        x,
        y,
        elevation ?? 0
      ].join(":");
    }

    function worldActionPointFromLocal(point, roomOffset) {
      return {
        x: Number(point?.x) + roomOffset.x,
        y: Number(point?.y) + roomOffset.y,
        elevation: Number(point?.elevation)
      };
    }

    function worldActionRoomKeyFromOffset(offset) {
      return [
        Math.round(Number(offset?.x || 0) * 1000),
        Math.round(Number(offset?.y || 0) * 1000)
      ].join(",");
    }

    function collectWorldPunchData(moveResult, playerMove, roomOffset, roomIndex, sequenceBase) {
      const punchEvents = [];
      const puncherVisuals = [];
      let maxSequence = -1;

      normalizedPunchSegments(playerMove).forEach((segment) => {
        const sequence = sequenceBase + segment.sequence;
        const eventPoint = worldActionPointFromLocal(
          {
            x: segment.fromX,
            y: segment.fromY,
            elevation: segment.fromElevation
          },
          roomOffset
        );

        maxSequence = Math.max(maxSequence, segment.sequence);
        punchEvents.push({
          point: eventPoint,
          sequence
        });
      });

      moveResult.moves
        .filter(isPunchVisualMove)
        .forEach((move) => {
          const localFinalX = typeof move.finalX === "number" ? move.finalX : move.fromX;
          const localFinalY = typeof move.finalY === "number" ? move.finalY : move.fromY;
          const localFinalElevation =
            typeof move.finalElevation === "number"
              ? move.finalElevation
              : move.fromElevation ?? move.actor?.elevation ?? 0;
          const localSequence = punchSequenceForVisualMove(move);
          const sequence = sequenceBase + localSequence;

          maxSequence = Math.max(maxSequence, localSequence);
          puncherVisuals.push({
            actor: {
              ...(move.actor || {}),
              type: move.actor?.type || move.actorType || "puncher",
              direction: move.actor?.direction || move.actor?.facing || move.direction || null,
              facing: move.actor?.facing || move.actor?.direction || move.direction || null,
              removed: false
            },
            actorKey: worldActionActorKey(
              move.actor || { type: move.actorType || "puncher", direction: move.direction },
              localFinalX,
              localFinalY,
              localFinalElevation
            ),
            finalElevation: localFinalElevation,
            finalX: localFinalX + roomOffset.x,
            finalY: localFinalY + roomOffset.y,
            fromElevation: move.fromElevation ?? localFinalElevation,
            fromX: move.fromX + roomOffset.x,
            fromY: move.fromY + roomOffset.y,
            roomIndex,
            roomKey: worldActionRoomKeyFromOffset(roomOffset),
            sequence,
            toElevation: move.toElevation ?? localFinalElevation,
            toX: move.toX + roomOffset.x,
            toY: move.toY + roomOffset.y
          });
        });

      return {
        nextSequenceBase: sequenceBase + maxSequence + 1,
        punchEvents,
        puncherVisuals
      };
    }

    function playerMovePathForWorldAction(move) {
      const path = normalizedMovePath(move);
      const punchSegments = normalizedPunchSegments(move);

      if (!hasPunchStart(move) && punchSegments.length === 0) {
        return path;
      }

      const punchPath = [];

      function appendLocalPathPoints(points) {
        points.forEach((point) => {
          const previous = punchPath[punchPath.length - 1];

          if (previous && pathPointMatches(previous, point)) {
            return;
          }

          punchPath.push(point);
        });
      }

      function appendPathToPoint(targetPoint) {
        const prefix = [];

        for (const point of path) {
          prefix.push(point);

          if (pathPointMatches(point, targetPoint)) {
            appendLocalPathPoints(prefix);
            return;
          }
        }

        appendLocalPathPoints([
          path[0] || {
            x: move.fromX,
            y: move.fromY,
            elevation: move.fromElevation ?? move.actor?.elevation ?? 0
          }
        ]);
        appendLocalPathPoints([targetPoint]);
      }

      const firstPunchPoint = punchSegments[0]
        ? {
            x: punchSegments[0].fromX,
            y: punchSegments[0].fromY,
            elevation: punchSegments[0].fromElevation
          }
        : hasPunchStart(move)
          ? {
              x: move.punchStartX,
              y: move.punchStartY,
              elevation: move.punchStartElevation ?? path[0]?.elevation ?? move.fromElevation ?? 0
            }
          : null;

      if (firstPunchPoint) {
        appendPathToPoint(firstPunchPoint);
      } else {
        appendLocalPathPoints(path);
      }

      punchSegments.forEach((segment) => {
        appendLocalPathPoints([{
          x: segment.fromX,
          y: segment.fromY,
          elevation: segment.fromElevation
        }]);
        appendLocalPathPoints([{
          x: segment.toX,
          y: segment.toY,
          elevation: segment.toElevation
        }]);
      });

      const lastPunchPoint = punchPath[punchPath.length - 1];
      const finalPoint = {
        x: move.toX,
        y: move.toY,
        elevation: move.toElevation ?? path[path.length - 1]?.elevation ?? move.fromElevation ?? 0
      };

      if (finalPoint && !pathPointMatches(lastPunchPoint, finalPoint)) {
        punchPath.push(finalPoint);
      }

      return punchPath;
    }

    function worldActionCameraPathForRooms(rooms) {
      const cameraPath = [];

      rooms.forEach((room) => {
        const levelState = room?.levelState;

        if (!levelState?.width || !levelState?.height) {
          return;
        }

        const point = {
          x: Number(room.offset?.x || 0) + levelState.width / 2,
          y: Number(room.offset?.y || 0) + levelState.height / 2
        };
        const previous = cameraPath[cameraPath.length - 1];

        if (
          previous &&
          Math.abs(previous.x - point.x) < 0.0001 &&
          Math.abs(previous.y - point.y) < 0.0001
        ) {
          return;
        }

        cameraPath.push(point);
      });

      return cameraPath;
    }

    function cameraPathDistance(cameraPath) {
      if (!Array.isArray(cameraPath) || cameraPath.length < 2) {
        return 0;
      }

      let distance = 0;

      for (let index = 1; index < cameraPath.length; index += 1) {
        const from = cameraPath[index - 1];
        const to = cameraPath[index];
        distance += Math.hypot(to.x - from.x, to.y - from.y);
      }

      return distance;
    }

    function pointAlongCameraPath(cameraPath, progress) {
      if (!Array.isArray(cameraPath) || cameraPath.length === 0) {
        return null;
      }

      if (cameraPath.length === 1) {
        return cameraPath[0];
      }

      const totalDistance = cameraPathDistance(cameraPath);

      if (totalDistance <= 0) {
        return cameraPath[cameraPath.length - 1];
      }

      let remainingDistance = totalDistance * Math.max(0, Math.min(1, progress));

      for (let index = 1; index < cameraPath.length; index += 1) {
        const from = cameraPath[index - 1];
        const to = cameraPath[index];
        const segmentDistanceValue = Math.hypot(to.x - from.x, to.y - from.y);

        if (remainingDistance > segmentDistanceValue && index < cameraPath.length - 1) {
          remainingDistance -= segmentDistanceValue;
          continue;
        }

        const segmentProgress =
          segmentDistanceValue <= 0
            ? 1
            : Math.max(0, Math.min(1, remainingDistance / segmentDistanceValue));

        return {
          x: from.x + (to.x - from.x) * segmentProgress,
          y: from.y + (to.y - from.y) * segmentProgress
        };
      }

      return cameraPath[cameraPath.length - 1];
    }

    function supportsWorldActionMoveResult(moveResult) {
      if (!moveResult?.moved || !Array.isArray(moveResult.moves)) {
        return false;
      }

      return moveResult.moves.every((move) => {
        if (move.visualOnly === true) {
          return app.isPlayerActor(move.actor) || move.actor?.type === "puncher";
        }

        return app.isPlayerActor(move.actor);
      });
    }

    function restorePlannedWorldActionStart(startSnapshot, startCollectedGemIds) {
      if (startCollectedGemIds && app.collectedGemIds) {
        app.collectedGemIds.clear();
        startCollectedGemIds.forEach((id) => app.collectedGemIds.add(id));
      }

      applyLevelState(startSnapshot, {
        deferRender: true,
        immediateCamera: true,
        skipTransientSideEffects: true,
        updateUrl: false
      });
    }

    function preloadForwardWorldActionLevels(dx, dy) {
      if (
        typeof app.loadHorizontalNeighborLevelState !== "function" ||
        typeof app.adjacentWorldLevelId !== "function"
      ) {
        return;
      }

      const requested = new Set();
      let levelId = app.currentLevelId;

      for (let index = 0; index < 4; index += 1) {
        levelId = app.adjacentWorldLevelId(levelId, dx, dy);

        if (!levelId || requested.has(levelId)) {
          return;
        }

        requested.add(levelId);
        app.loadHorizontalNeighborLevelState(levelId).catch(() => null);
      }
    }

    function queueWorldActionNeighborhood(rooms) {
      if (
        !Array.isArray(rooms) ||
        typeof app.queueHorizontalNeighborLevelState !== "function" ||
        typeof app.adjacentWorldLevelId !== "function"
      ) {
        return;
      }

      const requested = new Set();

      rooms.forEach((room) => {
        const levelId = room?.levelId || room?.levelState?.levelId;

        if (!levelId) {
          return;
        }

        for (let y = -1; y <= 1; y += 1) {
          for (let x = -1; x <= 1; x += 1) {
            if (x === 0 && y === 0) {
              continue;
            }

            const neighborLevelId = app.adjacentWorldLevelId(levelId, x, y);

            if (!neighborLevelId || requested.has(neighborLevelId)) {
              continue;
            }

            requested.add(neighborLevelId);
            app.queueHorizontalNeighborLevelState(neighborLevelId);
          }
        }
      });
    }

    async function planContinuousWorldAction(dx, dy, options = {}) {
      if (
        !currentPlayerForWorldAction() ||
        typeof app.prepareAdjacentLevelTransfer !== "function" ||
        typeof app.adjacentWorldLevelId !== "function" ||
        typeof app.cloneLevelSnapshot !== "function"
      ) {
        return null;
      }

      const startSnapshot = app.cloneLevelSnapshot();
      const startEntrySnapshot =
        typeof app.cloneStoredLevelSnapshot === "function"
          ? app.cloneStoredLevelSnapshot(app.levelEntrySnapshot)
          : null;
      const startCollectedGemIds = app.collectedGemIds
        ? new Set(app.collectedGemIds)
        : null;
      const rooms = [];
      const worldPath = [];
      const worldPunchEvents = [];
      const worldPuncherVisuals = [];
      let roomOffset = { x: 0, y: 0 };
      let crossedLevel = false;
      let moveDx = dx;
      let moveDy = dy;
      let startOnCurrentSlope = options.startOnCurrentSlope === true;
      let continuePunchSlide = options.continuePunchSlide === true;
      let punchSequenceBase = 0;

      preloadForwardWorldActionLevels(dx, dy);

      try {
        for (let guard = 0; guard < 16; guard += 1) {
          const roomState = worldActionLevelSnapshot();

          if (!roomState) {
            return null;
          }

          rooms.push({
            levelId: roomState.levelId,
            levelState: roomState,
            offset: { ...roomOffset }
          });
          const moveResult = movement.performPlayerMove(moveDx, moveDy, {
            animate: false,
            continuePunchSlide,
            recordHistory: false,
            startOnCurrentSlope,
            // The keypress belongs to the source room. After crossing a room
            // boundary, only the main player is continuing that motion.
            suppressCloneInput: crossedLevel
          });

          if (!supportsWorldActionMoveResult(moveResult)) {
            return null;
          }

          const playerMove =
            playerLevelExitMoveForContinuation(moveResult) ||
            playerSlideMoveForContinuation(moveResult) ||
            mainPlayerMoveForWorldAction(moveResult);

          if (!playerMove) {
            return null;
          }

          appendWorldPathPoints(
            worldPath,
            playerMovePathForWorldAction(playerMove),
            roomOffset
          );
          const punchData = collectWorldPunchData(
            moveResult,
            playerMove,
            roomOffset,
            rooms.length - 1,
            punchSequenceBase
          );

          worldPunchEvents.push(...punchData.punchEvents);
          worldPuncherVisuals.push(...punchData.puncherVisuals);
          punchSequenceBase = punchData.nextSequenceBase;

          if (playerMove.toRemoved === true) {
            if (!crossedLevel) {
              return null;
            }

            const finalSnapshot = app.cloneLevelSnapshot();
            queueWorldActionNeighborhood(rooms);
            return {
              finalLevelState: finalSnapshot,
              player: { ...playerMove.actor, removed: false },
              rooms,
              startEntrySnapshot,
              startLevelState: startSnapshot,
              path: worldPath,
              punchEvents: worldPunchEvents,
              puncherVisuals: worldPuncherVisuals,
              terminalPlayerRemoved: true
            };
          }

          const edgeTransition = continuationTransitionForMoveResult(moveResult, moveDx, moveDy);

          if (
            !edgeTransition ||
            !shouldContinuePlayerMoveAcrossEdge(moveResult, edgeTransition)
          ) {
            if (!crossedLevel) {
              return null;
            }

            const finalSnapshot = app.cloneLevelSnapshot();
            queueWorldActionNeighborhood(rooms);
            return {
              finalLevelState: finalSnapshot,
              player: { ...playerMove.actor },
              rooms,
              startEntrySnapshot,
              startLevelState: startSnapshot,
              path: worldPath,
              punchEvents: worldPunchEvents,
              puncherVisuals: worldPuncherVisuals
            };
          }

          const transfer = await app.prepareAdjacentLevelTransfer({
            ...edgeTransition,
            continueMove: true
          });

          if (!transfer?.nextLevelState) {
            return null;
          }

          crossedLevel = true;

          const nextOffset = actionRoomOffsetAfterTransition(
            roomOffset,
            {
              width: state.width,
              height: state.height
            },
            transfer.nextLevelState,
            edgeTransition.dx,
            edgeTransition.dy
          );
          appendWorldPathPoints(
            worldPath,
            [
              {
                x: edgeTransition.targetX,
                y: edgeTransition.targetY,
                elevation: transfer.targetElevation
              }
            ],
            nextOffset
          );

          if (transfer.entersHole) {
            const finalLevelState = markWorldActionPlayerRemoved(
              cloneWorldActionLevelState(transfer.nextLevelState)
            );

            rooms.push({
              levelId: finalLevelState?.levelId || transfer.nextLevelState.levelId,
              levelState: finalLevelState || transfer.nextLevelState,
              offset: { ...nextOffset }
            });
            queueWorldActionNeighborhood(rooms);
            return {
              finalLevelState,
              player: { ...(transfer.transferredPlayer || {}), removed: false },
              rooms,
              startEntrySnapshot,
              startLevelState: startSnapshot,
              path: worldPath,
              punchEvents: worldPunchEvents,
              puncherVisuals: worldPuncherVisuals,
              terminalPlayerRemoved: true
            };
          }

          applyLevelState(transfer.nextLevelState, {
            deferRender: true,
            immediateCamera: true,
            resetLevelEntry: true,
            skipTransientSideEffects: true,
            updateUrl: false
          });

          roomOffset = nextOffset;
          moveDx = edgeTransition.dx;
          moveDy = edgeTransition.dy;
          startOnCurrentSlope = edgeTransition.continueFromCurrentSlope === true;
          continuePunchSlide = edgeTransition.continuePunchSlide === true;
        }
      } finally {
        restorePlannedWorldActionStart(startSnapshot, startCollectedGemIds);
      }

      return null;
    }

    function worldActionPointAt(path, traveledDistance) {
      return pointAlongPathDistance({ path }, traveledDistance);
    }

    function worldActionDistanceToPoint(path, targetPoint) {
      return pathDistanceToPoint({ path }, targetPoint);
    }

    function normalizedWorldPunchEvents(path, punchEvents) {
      if (!Array.isArray(punchEvents) || punchEvents.length === 0) {
        return [];
      }

      const eventsByDistance = new Map();

      punchEvents.forEach((event) => {
        const distance = worldActionDistanceToPoint(path, event.point);

        if (distance === null) {
          return;
        }

        const key = Math.round(distance * 10000) / 10000;
        const existing = eventsByDistance.get(key) || {
          distance,
          point: event.point,
          sequences: []
        };

        if (!existing.sequences.includes(event.sequence)) {
          existing.sequences.push(event.sequence);
        }

        eventsByDistance.set(key, existing);
      });

      return Array.from(eventsByDistance.values())
        .sort((left, right) => left.distance - right.distance)
        .map((event) => ({
          ...event,
          sequences: event.sequences.sort((left, right) => left - right)
        }));
    }

    function worldActionPunchLungeDuration() {
      return Math.max(MOVE_DURATION_MS, segmentDuration(1, true));
    }

    function worldActionTimelineFor(path, punchEvents, options = {}) {
      const totalDistance = pathDistanceFor({ path });
      const events = normalizedWorldPunchEvents(path, punchEvents);
      const steps = [];
      const eventTimings = new Map();
      let cursorDistance = 0;
      let cursorMs = 0;
      let afterPunch = false;

      if (events.length === 0) {
        const duration = iceSlideDuration(totalDistance);
        const terminalFallDuration =
          options.terminalPlayerRemoved === true ? HOLE_FALL_DURATION_MS : 0;

        return {
          cameraStartDistance: 0,
          durationMs: duration + terminalFallDuration,
          eventTimings,
          pathEndMs: duration,
          steps: [
            {
              durationMs: duration,
              endDistance: totalDistance,
              endMs: duration,
              kind: "path",
              startDistance: 0,
              startMs: 0
            }
          ],
          totalDistance
        };
      }

      function pushPathStep(endDistance) {
        const distance = Math.max(0, endDistance - cursorDistance);

        if (distance <= 0.0001) {
          cursorDistance = endDistance;
          return;
        }

        const duration = afterPunch
          ? iceSlideDuration(distance)
          : segmentDuration(distance, false);

        steps.push({
          durationMs: duration,
          endDistance,
          endMs: cursorMs + duration,
          kind: "path",
          startDistance: cursorDistance,
          startMs: cursorMs
        });
        cursorDistance = endDistance;
        cursorMs += duration;
      }

      events.forEach((event) => {
        pushPathStep(event.distance);

        const duration = worldActionPunchLungeDuration();
        const timing = {
          lungeEndMs: cursorMs + duration,
          lungeStartMs: cursorMs,
          retractEndMs: cursorMs + duration * 2,
          retractStartMs: cursorMs + duration
        };

        event.sequences.forEach((sequence) => {
          eventTimings.set(sequence, timing);
        });

        steps.push({
          distance: event.distance,
          durationMs: duration,
          endMs: timing.lungeEndMs,
          kind: "punch_lunge",
          sequences: event.sequences,
          startMs: timing.lungeStartMs
        });
        cursorMs = timing.lungeEndMs;
        afterPunch = true;
      });

      pushPathStep(totalDistance);
      const pathEndMs = cursorMs;

      const lastRetractEndMs = Array.from(eventTimings.values()).reduce(
        (latest, timing) => Math.max(latest, timing.retractEndMs),
        cursorMs
      );
      const terminalFallDuration =
        options.terminalPlayerRemoved === true ? HOLE_FALL_DURATION_MS : 0;

      return {
        cameraStartDistance: events[0]?.distance ?? 0,
        durationMs: Math.max(pathEndMs + terminalFallDuration, lastRetractEndMs),
        eventTimings,
        pathEndMs,
        steps,
        totalDistance
      };
    }

    function worldActionPointAtTime(action, elapsedMs) {
      const timeline = action?.timeline;
      const path = action?.path || [];

      if (!timeline || !Array.isArray(timeline.steps) || timeline.steps.length === 0) {
        return worldActionPointAt(path, (timeline?.totalDistance ?? pathDistanceFor({ path })) * (action?.progress || 0));
      }

      const clampedElapsed = Math.max(0, Math.min(timeline.durationMs, elapsedMs));

      for (const step of timeline.steps) {
        if (clampedElapsed > step.endMs && step !== timeline.steps[timeline.steps.length - 1]) {
          continue;
        }

        if (step.kind === "punch_lunge") {
          return worldActionPointAt(path, step.distance);
        }

        const progress = step.durationMs <= 0
          ? 1
          : linearMotionProgress(clampedElapsed - step.startMs, step.durationMs);
        const distance = step.startDistance + (step.endDistance - step.startDistance) * progress;

        return worldActionPointAt(path, distance);
      }

      return worldActionPointAt(path, timeline.totalDistance);
    }

    function worldActionDistanceAtTime(action, elapsedMs) {
      const timeline = action?.timeline;

      if (!timeline || !Array.isArray(timeline.steps) || timeline.steps.length === 0) {
        return (timeline?.totalDistance ?? pathDistanceFor({ path: action?.path || [] })) *
          (action?.progress || 0);
      }

      const clampedElapsed = Math.max(0, Math.min(timeline.durationMs, elapsedMs));

      for (const step of timeline.steps) {
        if (clampedElapsed > step.endMs && step !== timeline.steps[timeline.steps.length - 1]) {
          continue;
        }

        if (step.kind === "punch_lunge") {
          return step.distance;
        }

        const progress = step.durationMs <= 0
          ? 1
          : linearMotionProgress(clampedElapsed - step.startMs, step.durationMs);

        return step.startDistance + (step.endDistance - step.startDistance) * progress;
      }

      return timeline.totalDistance;
    }

    function worldActionCameraPointAtTime(action, elapsedMs) {
      const cameraPath = action?.cameraPath || [];

      if (cameraPath.length === 0) {
        return null;
      }

      const totalDistance = Math.max(
        0.0001,
        action?.timeline?.totalDistance ?? pathDistanceFor({ path: action?.path || [] })
      );
      const cameraStartDistance = Math.max(
        0,
        Math.min(totalDistance, Number(action?.timeline?.cameraStartDistance || 0))
      );
      const traveledDistance = worldActionDistanceAtTime(action, elapsedMs);
      const cameraDistance = Math.max(0, traveledDistance - cameraStartDistance);
      const cameraTravelDistance = Math.max(0.0001, totalDistance - cameraStartDistance);

      return pointAlongCameraPath(cameraPath, cameraDistance / cameraTravelDistance);
    }

    function startContinuousWorldActionAnimation(plan) {
      if (!plan || !Array.isArray(plan.path) || plan.path.length < 2) {
        return false;
      }

      const timeline = worldActionTimelineFor(plan.path, plan.punchEvents, {
        terminalPlayerRemoved: plan.terminalPlayerRemoved === true
      });
      const durationMs = timeline.durationMs;
      const elapsedForFrame = createAnimationElapsedTracker();
      const undoGroupId = beginMoveUndoGroup();
      const cameraPath = worldActionCameraPathForRooms(plan.rooms);
      app.worldActionAnimation = {
        cameraPath,
        cameraPoint: cameraPath[0] || null,
        currentPoint: plan.path[0],
        elapsedMs: 0,
        puncherVisuals: plan.puncherVisuals || [],
        progress: 0,
        path: plan.path,
        player: plan.player,
        rooms: plan.rooms,
        stableWidth: Math.max(1, plan.rooms[0]?.levelState?.width || state.width),
        stableHeight: Math.max(1, plan.rooms[0]?.levelState?.height || state.height),
        terminalPlayerRemoved: plan.terminalPlayerRemoved === true,
        timeline
      };
      app.isAnimating = true;
      app.inputActionEndsAtMs = performance.now() + durationMs;
      moveHistory.push({
        levelSnapshot: plan.startLevelState,
        levelEntrySnapshot: plan.startEntrySnapshot,
        undoGroupId
      });

      function finish() {
        app.worldActionAnimation = null;
        app.isAnimating = false;
        app.inputActionEndsAtMs = 0;
        app.animationFrameId = null;
        applyLevelState(plan.finalLevelState, {
          immediateCamera: true,
          resetLevelEntry: true,
          updateUrl: true
        });
        finishMoveUndoGroup();
        if (plan.terminalPlayerRemoved === true && app.autoUndoPlayerFalls === true) {
          app.queuedAction = null;
          app.onPlayerPitAutoUndo?.();
          undoMove({
            blinkCount: 1,
            blinkDurationMs: 50,
            blinkRevivedPlayer: true,
            blinkVisibleDurationMs: 50,
            instantRestore: true
          });
          return;
        }
        runQueuedAction();
      }

      function step(now = performance.now()) {
        const elapsedMs = elapsedForFrame(now);
        const progress = linearMotionProgress(elapsedMs, durationMs);
        app.worldActionAnimation.elapsedMs = elapsedMs;
        app.worldActionAnimation.progress = progress;
        app.worldActionAnimation.currentPoint = worldActionPointAtTime(
          app.worldActionAnimation,
          elapsedMs
        );
        app.worldActionAnimation.cameraPoint = worldActionCameraPointAtTime(
          app.worldActionAnimation,
          elapsedMs
        );
        app.worldActionAnimation.visualSignature = [
          Math.floor(elapsedMs / 16),
          Math.round(app.worldActionAnimation.currentPoint.x * 1000),
          Math.round(app.worldActionAnimation.currentPoint.y * 1000),
          Math.round(app.worldActionAnimation.currentPoint.elevation * 1000),
          Math.round((app.worldActionAnimation.cameraPoint?.x || 0) * 1000),
          Math.round((app.worldActionAnimation.cameraPoint?.y || 0) * 1000)
        ].join(":");
        (app.renderOncePerFrame || app.render)(now);

        if (progress >= 1) {
          finish();
          return;
        }

        app.animationFrameId = window.requestAnimationFrame(step);
      }

      app.animationFrameId = window.requestAnimationFrame(step);
      return true;
    }

    function hasContinuousWorldActionCrossing(dx, dy, options = {}) {
      const player = currentPlayerForWorldAction();

      if (!player || typeof movement.previewPlayerMove !== "function") {
        return false;
      }

      const moveResult = movement.previewPlayerMove(dx, dy, {
        continuePunchSlide: options.continuePunchSlide === true,
        startOnCurrentSlope: options.startOnCurrentSlope === true
      });

      if (!supportsWorldActionMoveResult(moveResult)) {
        return false;
      }

      const edgeTransition = continuationTransitionForMoveResult(moveResult, dx, dy);

      return Boolean(edgeTransition && shouldContinuePlayerMoveAcrossEdge(moveResult, edgeTransition));
    }

    function terrainCellHasContinuationSurface(cell) {
      if (!cell) {
        return false;
      }

      if (isSlideContinuationSurface(cell.type)) {
        return true;
      }

      return Array.isArray(cell.layers) &&
        cell.layers.some((layer) => isSlideContinuationSurface(layer.type));
    }

    function boundaryContinuationSurfaceCandidate(dx, dy) {
      const player = currentPlayerForWorldAction();

      if (!player) {
        return false;
      }

      const boundaryX = dx < 0 ? 0 : dx > 0 ? state.width - 1 : player.x;
      const boundaryY = dy < 0 ? 0 : dy > 0 ? state.height - 1 : player.y;

      return terrainCellHasContinuationSurface(state.terrain[boundaryY]?.[boundaryX]);
    }

    function initialPuncherContinuationCandidate(dx, dy) {
      const player = currentPlayerForWorldAction();

      if (!player) {
        return false;
      }

      const targetX = player.x + dx;
      const targetY = player.y + dy;
      const elevation = player.elevation ?? 0;

      if (targetX < 0 || targetX >= state.width || targetY < 0 || targetY >= state.height) {
        return false;
      }

      return state.actors.some(
        (actor) =>
          actor &&
          !actor.removed &&
          actor.type === "puncher" &&
          actor.x === targetX &&
          actor.y === targetY &&
          (actor.elevation ?? 0) === elevation
      );
    }

    function playerOnlyCorridorCandidate(dx, dy) {
      const player = currentPlayerForWorldAction();

      if (!player) {
        return false;
      }

      return !state.actors.some((actor) => {
        if (!actor || actor.removed || app.isPlayerActor(actor) || app.isCollectibleActor?.(actor)) {
          return false;
        }

        if (dx !== 0) {
          if (actor.y !== player.y) {
            return false;
          }

          return dx > 0
            ? actor.x > player.x
            : actor.x < player.x;
        }

        if (actor.x !== player.x) {
          return false;
        }

        return dy > 0
          ? actor.y > player.y
          : actor.y < player.y;
      });
    }

    function maybeStartContinuousWorldAction(dx, dy, options = {}) {
      if (
        options.skipWorldAction === true ||
        options.allowDuringTransition === true ||
        app.isTransitioningLevel ||
        app.isPlanningWorldAction === true
      ) {
        return false;
      }

      const canSlideAcrossBoundary =
        boundaryContinuationSurfaceCandidate(dx, dy) &&
        playerOnlyCorridorCandidate(dx, dy);
      const canPunchAcrossBoundary = initialPuncherContinuationCandidate(dx, dy);

      if (!canSlideAcrossBoundary && !canPunchAcrossBoundary) {
        return false;
      }

      if (!hasContinuousWorldActionCrossing(dx, dy, options)) {
        return false;
      }

      app.isPlanningWorldAction = true;
      Promise.resolve(planContinuousWorldAction(dx, dy, options))
        .then((plan) => {
          app.isPlanningWorldAction = false;

          if (plan && startContinuousWorldActionAnimation(plan)) {
            return;
          }

          movePlayers(dx, dy, {
            ...options,
            skipWorldAction: true
          });
        })
        .catch((error) => {
          app.isPlanningWorldAction = false;
          console.error(error);
          movePlayers(dx, dy, {
            ...options,
            skipWorldAction: true
          });
        });

      return true;
    }

    function movePlayers(dx, dy, options = {}) {
      const allowDuringTransition = options.allowDuringTransition === true;

      if (
        app.isPlanningWorldAction ||
        app.isAnimating ||
        (app.isTransitioningLevel && !allowDuringTransition)
      ) {
        queueLateAction({ type: "move", dx, dy, inputSource: options.inputSource || "" });
        return;
      }

      if (maybeStartContinuousWorldAction(dx, dy, options)) {
        return;
      }

      const edgeTransition =
        options.skipEdgeTransition === true
          ? null
          : typeof app.edgeTransitionForMove === "function"
            ? app.edgeTransitionForMove(dx, dy)
            : null;

      if (edgeTransition) {
        const shouldContinue = isSlideContinuationSurface(edgeTransition.sourceType);

        if (shouldContinue) {
          beginMoveUndoGroup();
        }

        Promise.resolve(
          app.transitionToAdjacentLevel({
            ...edgeTransition,
            continueMove: shouldContinue,
            durationMs: shouldContinue
              ? continuousRoomTransitionDurationMs(
                  edgeTransition,
                  iceSlideDuration(Number(edgeTransition.dx) !== 0 ? state.width : state.height),
                  0
                )
              : undefined,
            steadyCamera: shouldContinue,
            replaceActiveTransition: shouldContinue,
            skipNeighborhoodPreload: shouldContinue,
            skipPrewarm: shouldContinue,
            warmupPromise:
              shouldContinue && typeof app.warmAdjacentLevelTransition === "function"
                ? app.warmAdjacentLevelTransition(edgeTransition, { preloadNeighborhood: "queue" })
                : null,
            undoGroupId: app.activeUndoGroupId || null
          })
        ).then((didTransition) => {
          if (didTransition === false) {
            if (shouldContinue) {
              finishMoveUndoGroup();
            }
            movePlayers(dx, dy, {
              ...options,
              skipEdgeTransition: true
            });
          }
        });
        return;
      }

      beginMoveUndoGroup();
      let moveResult = null;
      let earlyTransition = null;

      const startEarlyTransition = (frame) => {
        if (!earlyTransition || earlyTransition.started) {
          return;
        }

        const moveDuration = Number.isFinite(frame?.moveDuration) ? frame.moveDuration : 0;
        const leadMs = transitionLeadMsForMove(moveDuration);
        const triggerMs = Math.max(0, moveDuration - leadMs);
        const elapsedMs = Number.isFinite(frame?.elapsedMs) ? frame.elapsedMs : moveDuration;

        if (elapsedMs < triggerMs) {
          return;
        }

        earlyTransition.started = true;
        earlyTransition.promise = Promise.resolve(
          app.transitionToAdjacentLevel({
            ...earlyTransition.transition,
            continueMove: true,
            durationMs: continuousRoomTransitionDurationMs(
              earlyTransition.transition,
              moveDuration,
              leadMs
            ),
            followSourcePlayerBeforeContinuation: true,
            steadyCamera: true,
            replaceActiveTransition: true,
            skipNeighborhoodPreload: true,
            skipPrewarm: true,
            warmupPromise: earlyTransition.warmupPromise,
            undoGroupId: app.activeUndoGroupId || null
          })
        ).then((didTransition) => {
          earlyTransition.didTransition = didTransition !== false;

          if (didTransition !== false) {
            return;
          }

          earlyTransition.failed = true;

          if (earlyTransition.sourceFinished) {
            finishMoveUndoGroup();
            runQueuedAction();
          }
        });
      };

      const onFinish = () => {
        Promise.resolve().then(() => {
          if (earlyTransition?.started && !earlyTransition.failed) {
            earlyTransition.sourceFinished = true;
            return;
          }

          const mainPlayerFell =
            app.autoUndoPlayerFalls === true &&
            moveResult?.moves?.some(
              (move) =>
                move?.visualOnly !== true &&
                move?.fromRemoved !== true &&
                move?.toRemoved === true &&
                app.isMainPlayerActor?.(move.actor)
            );
          if (mainPlayerFell) {
            finishMoveUndoGroup();
            app.queuedAction = null;
            app.onPlayerPitAutoUndo?.();
            undoMove({
              blinkCount: 1,
              blinkDurationMs: 50,
              blinkRevivedPlayer: true,
              blinkVisibleDurationMs: 50,
              instantRestore: true
            });
            return;
          }

          if (continuePlayerMoveAcrossEdge(moveResult, dx, dy)) {
            return;
          }

          rememberSettledEntryStateAfterContinuation();
          finishMoveUndoGroup();
          runQueuedAction();
        });
      };

      moveResult = movement.performPlayerMove(dx, dy, {
        animate: true,
        durationMs: Number.isFinite(app.replayMoveDurationMs)
          ? app.replayMoveDurationMs
          : null,
        recordHistory: true,
        // Cross-room punch continuations arrive via the transition
        // controller with this flag; dropping it turned the rest of the
        // flight into a single walk step in the new room (owner bug:
        // "puncher doesn't punch the player all the way into far rooms").
        continuePunchSlide: options.continuePunchSlide === true,
        startOnCurrentSlope: options.startOnCurrentSlope === true,
        beforeAnimate: ({ moveResult: preparedMoveResult }) => {
          const transition = continuationTransitionForMoveResult(preparedMoveResult, dx, dy);

          if (!transition) {
            return;
          }

          earlyTransition = {
            didTransition: false,
            failed: false,
            promise: null,
            sourceFinished: false,
            started: false,
            transition,
            warmupPromise:
              typeof app.warmAdjacentLevelTransition === "function"
                ? app.warmAdjacentLevelTransition(transition, { preloadNeighborhood: "queue" })
                : null
          };
        },
        onMoveFrame: startEarlyTransition,
        onFinish
      });
    }

    function undoMove(options = {}) {
      if (app.isAnimating || app.isTransitioningLevel) {
        queueLateAction({ type: "undo", inputSource: options.inputSource || "" });
        return;
      }

      const previousState = moveHistory.pop();

      if (!previousState) {
        return;
      }

      const undoEntries = collectUndoGroupEntries(previousState);

      if (undoEntries.length > 1) {
        restoreGroupedUndoEntry(undoEntries[0], options);
        return;
      }

      if (previousState.kind === "level-transition") {
        restoreCrossRoomUndoState(previousState.level, previousState.entry);
        finishRestoredUndo(options);
        return;
      }

      if (previousState.levelSnapshot && !previousState.actors) {
        restoreCrossRoomUndoState(
          previousState.levelSnapshot,
          previousState.levelEntrySnapshot
        );
        finishRestoredUndo(options);
        return;
      }

      const raisedPlayerGates = computeRaisedPlayerGateSet();
      const raisedOrangeWalls = computeRaisedOrangeWallSet();
      const moves = buildMovesToPositions(previousState.actors, {
        collectedGemVisual: "hidden"
      });
      movement.applyUndoIceSlideMetadata(moves, previousState);
      // Reset already returns every actor to the room-entry state in one
      // normal move duration. Its inverse should be equally snappy instead
      // of scaling with however many tiles the actors traveled before Reset.
      const undoDurationMs = previousState.kind === "reset" ? MOVE_DURATION_MS : null;

      if (options.instantRestore === true) {
        restoreTerrainState(previousState.terrain);
        movement.applyMoveFinalState(moves);
        setRaisedOrangeWallState(previousState.raisedOrangeWalls || []);
        finishRestoredUndo(options);
        return;
      }

      const hasLiftReversal = moves.some(
        (move) => {
          const liftFromElevation = liftPhaseStartElevationForMove(move);
          return liftFromElevation !== (move.toElevation ?? liftFromElevation);
        }
      );
      const finishUndo = options.blinkRevivedPlayer === true
        ? () => {
            const players = state.actors.filter(
              (actor) => app.isMainPlayerActor?.(actor) && !actor.removed
            );
            app.blinkRevivedPlayer?.(players, {
              blinkCount: options.blinkCount,
              durationMs: options.blinkDurationMs,
              visibleDurationMs: options.blinkVisibleDurationMs
            });
          }
        : null;

      if (moves.length > 0) {
        if (hasLiftReversal) {
          app.gateRenderOverride = raisedPlayerGates;
          app.orangeWallRenderOverride = raisedOrangeWalls;
          animateMoves(moves, undoDurationMs, {
            liftPhaseFirst: true,
            startLiftPhase: () => {
              restoreTerrainState(previousState.terrain);
              setRaisedOrangeWallState(previousState.raisedOrangeWalls || []);
              app.gateRenderOverride = null;
              app.orangeWallRenderOverride = null;
            },
            onFinish: finishUndo
          });
          return;
        }

        restoreTerrainState(previousState.terrain);
        setRaisedOrangeWallState(previousState.raisedOrangeWalls || []);
        app.gateRenderOverride = raisedPlayerGates;
        app.orangeWallRenderOverride = raisedOrangeWalls;
        animateMoves(moves, undoDurationMs, { onFinish: finishUndo });
        return;
      }

      restoreTerrainState(previousState.terrain);
      setRaisedOrangeWallState(previousState.raisedOrangeWalls || []);
      app.gateRenderOverride = null;
      app.orangeWallRenderOverride = null;
      syncFloatingFloorTicker();
      app.render();
    }

    function pushResetUndoSnapshot() {
      moveHistory.push({
        kind: "reset",
        actors: app.cloneActorPositions(),
        terrain: app.cloneTerrainState(state.terrain),
        raisedOrangeWalls: Array.from(computeRaisedOrangeWallSet()),
        undoGroupId: null
      });

      if (moveHistory.length > 500) {
        moveHistory.splice(0, moveHistory.length - 500);
      }
    }

    function resetPositions() {
      if (app.isAnimating || app.isTransitioningLevel) {
        queueLateAction({ type: "reset" });
        return;
      }

      // Reset is a normal reversible game action. Preserve both the exact
      // pre-reset room state and the older move history so one undo restores
      // an accidental reset and subsequent undos can continue normally.
      pushResetUndoSnapshot();
      restoreTerrainState(app.initialTerrain);
      app.gateRenderOverride = computeRaisedPlayerGateSet();
      app.orangeWallRenderOverride = computeRaisedOrangeWallSet();
      setRaisedOrangeWallState(app.levelEntrySnapshot?.raisedOrangeWalls || []);
      const moves = buildMovesToPositions(app.initialPositions, {
        collectedGemVisual: "ghost"
      });

      if (moves.length > 0) {
        animateMoves(moves, MOVE_DURATION_MS);
        return;
      }

      app.gateRenderOverride = null;
      app.orangeWallRenderOverride = null;
      syncFloatingFloorTicker();
      app.render();
    }

    function runAction(action) {
      if (!action) {
        return;
      }

      if (action.type === "move") {
        movePlayers(action.dx, action.dy, { inputSource: action.inputSource || "" });
        return;
      }

      if (action.type === "undo") {
        undoMove({ inputSource: action.inputSource || "" });
        return;
      }

      if (action.type === "reset") {
        resetPositions();
      }
    }

    // Bindings honor the shared controls config (window.__MAZEBENCH_CONTROLS__)
    // when the host page provides one; otherwise the classic defaults apply.
    function matchesGameplayControl(event, action, fallbackCodes) {
      const keys = window.__MAZEBENCH_CONTROLS__?.keys;
      const codes = keys && Array.isArray(keys[action]) ? keys[action] : fallbackCodes;
      return codes.includes(event.code);
    }

    function handleKeydown(event) {
      if (
        window.__MAZEBENCH_CONTROLS_CAPTURE__ === true ||
        window.__MAZEBENCH_INPUT_LOCKED__ === true
      ) {
        return;
      }

      const directionalMoves = {
        moveUp: { fallback: ["ArrowUp"], vector: [0, -1] },
        moveDown: { fallback: ["ArrowDown"], vector: [0, 1] },
        moveLeft: { fallback: ["ArrowLeft"], vector: [-1, 0] },
        moveRight: { fallback: ["ArrowRight"], vector: [1, 0] }
      };

      for (const [action, move] of Object.entries(directionalMoves)) {
        if (!matchesGameplayControl(event, action, move.fallback)) {
          continue;
        }
        event.preventDefault();
        const [rawDx, rawDy] = move.vector;
        const [dx, dy] =
          typeof app.mapCameraRelativeDirection === "function"
            ? app.mapCameraRelativeDirection(rawDx, rawDy)
            : [rawDx, rawDy];
        movePlayers(dx, dy, { inputSource: `key:${event.code}` });
        return;
      }

      if (matchesGameplayControl(event, "undo", ["KeyZ", "KeyU"])) {
        event.preventDefault();
        undoMove();
        return;
      }

      if (matchesGameplayControl(event, "reset", ["KeyR"])) {
        event.preventDefault();
        resetPositions();
      }
    }

    function handleKeyup(event) {
      cancelQueuedAction(`key:${event.code}`);
    }

    function preventScroll(event) {
      event.preventDefault();
    }

    Object.assign(app, {
      finishAnimation,
      animateMoves,
      buildMovesToPositions,
      tryMovePlayersInstant,
      movePlayers,
      undoMove,
      resetPositions,
      runQueuedAction,
      finishMoveUndoGroup,
      runAction,
      canQueueLateAction,
      queueLateAction,
      cancelQueuedAction,
      handleKeydown,
      handleKeyup,
      preventScroll
    });

    if (typeof modules.createMovementController === "function") {
      movement = modules.createMovementController(app);
      app.movement = movement;
    } else if (typeof modules.registerMovementFunctions === "function") {
      movement = modules.registerMovementFunctions(app);
    }

    if (!movement) {
      throw new Error("play-movement.js must be loaded before play-gameplay.js");
    }

    if (typeof modules.registerWorldTransitionFunctions === "function") {
      modules.registerWorldTransitionFunctions(app);
    }
  };
})();
