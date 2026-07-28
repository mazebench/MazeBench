(function () {
  const modules = window.PlayModules || (window.PlayModules = {});

  modules.registerRenderCompositorFunctions = function registerRenderCompositorFunctions(app) {
    const {
      state,
      TILE_SIZE,
      sceneCanvas,
      sceneCtx,
      viewCanvas,
      viewCtx,
      boardRect,
      viewportRect
    } = app;
    const {
      clamp,
      isCollectibleActor,
      isMainPlayerActor,
      isPlayerActor,
      actorRenderElevation,
      easeInOutQuad
    } = app;
    const { paintGround } = app.renderTerrain;
    const {
      paintDepthSortedScene,
      actorDepthRow,
      paintRaisedPlayer
    } = app.renderActors;

    function canvasTextureVersion(canvas) {
      return canvas?.__pixelGameTextureVersion ?? "unversioned";
    }

    function markCanvasTextureChanged(canvas) {
      if (!canvas) {
        return;
      }

      canvas.__pixelGameTextureVersion = (canvas.__pixelGameTextureVersion || 0) + 1;
    }

    function isTransitionHiddenPlayer(actor) {
      return typeof isMainPlayerActor === "function"
        ? isMainPlayerActor(actor)
        : isPlayerActor(actor) && actor?.type !== "clone";
    }

    function drawViewportFromScene(
      context,
      sourceCanvas,
      sourceBoardRect,
      sourceViewportRect,
      cameraX,
      cameraY,
      offsetX = 0,
      offsetY = 0
    ) {
      if (!context || !sourceCanvas || !sourceBoardRect || !sourceViewportRect) {
        return;
      }

      const useSubpixelViewport = Boolean(app.threeRenderer);
      const drawOffsetX = useSubpixelViewport ? offsetX : Math.round(offsetX);
      const drawOffsetY = useSubpixelViewport ? offsetY : Math.round(offsetY);
      const previousImageSmoothing = context.imageSmoothingEnabled;

      context.imageSmoothingEnabled = useSubpixelViewport;

      if (
        sourceViewportRect.width === sourceBoardRect.width &&
        sourceViewportRect.height === sourceBoardRect.height
      ) {
        context.drawImage(sourceCanvas, drawOffsetX, drawOffsetY);
        context.imageSmoothingEnabled = previousImageSmoothing;
        return;
      }

      const viewportCameraX = useSubpixelViewport ? cameraX : Math.round(cameraX);
      const viewportCameraY = useSubpixelViewport ? cameraY : Math.round(cameraY);
      const sourceX = Math.max(0, viewportCameraX);
      const sourceY = Math.max(0, viewportCameraY);
      const destX = drawOffsetX + Math.max(0, -viewportCameraX);
      const destY = drawOffsetY + Math.max(0, -viewportCameraY);
      const drawWidth = Math.max(
        0,
        Math.min(sourceBoardRect.width - sourceX, sourceViewportRect.width - Math.max(0, -viewportCameraX))
      );
      const drawHeight = Math.max(
        0,
        Math.min(sourceBoardRect.height - sourceY, sourceViewportRect.height - Math.max(0, -viewportCameraY))
      );

      if (drawWidth <= 0 || drawHeight <= 0) {
        context.imageSmoothingEnabled = previousImageSmoothing;
        return;
      }

      context.drawImage(
        sourceCanvas,
        sourceX,
        sourceY,
        drawWidth,
        drawHeight,
        destX,
        destY,
        drawWidth,
        drawHeight
      );
      context.imageSmoothingEnabled = previousImageSmoothing;
    }

    function composeViewportSource() {
      if (!viewCtx) {
        return sceneCanvas;
      }

      const signature = [
        canvasTextureVersion(sceneCanvas),
        sceneCanvas.width,
        sceneCanvas.height,
        viewportRect.width,
        viewportRect.height,
        boardRect.width,
        boardRect.height,
        Math.round(app.cameraX * 1000),
        Math.round(app.cameraY * 1000),
        Boolean(app.threeRenderer) ? 1 : 0
      ].join(":");

      if (viewCanvas.__pixelGameViewportSignature === signature) {
        return viewCanvas;
      }

      viewCtx.clearRect(0, 0, viewportRect.width, viewportRect.height);
      viewCtx.fillStyle = "#d6bd94";
      viewCtx.fillRect(0, 0, viewportRect.width, viewportRect.height);
      drawViewportFromScene(
        viewCtx,
        sceneCanvas,
        boardRect,
        viewportRect,
        app.cameraX,
        app.cameraY
      );
      viewCanvas.__pixelGameViewportSignature = signature;
      markCanvasTextureChanged(viewCanvas);
      return viewCanvas;
    }

    function drawScene(now = performance.now()) {
      if (app.threeRenderer && app.threeRenderer.renderScene(now)) {
        return;
      }

      sceneCtx.clearRect(0, 0, boardRect.width, boardRect.height);
      paintGround(now);
      paintDepthSortedScene(now);
      markCanvasTextureChanged(sceneCanvas);
    }

    function cloneCanvas(sourceCanvas, width = sourceCanvas.width, height = sourceCanvas.height) {
      const snapshot = document.createElement("canvas");
      snapshot.width = width;
      snapshot.height = height;
      const snapshotCtx = snapshot.getContext("2d");

      if (!snapshotCtx) {
        return snapshot;
      }

      snapshotCtx.imageSmoothingEnabled = false;
      snapshotCtx.drawImage(sourceCanvas, 0, 0, width, height);
      return snapshot;
    }

    function viewportPositionForActorAtCamera(
      actor,
      cameraX,
      cameraY,
      sourceViewportRect = viewportRect,
      sourceBoardRect = boardRect
    ) {
      const surfaceLift = Math.round(TILE_SIZE * 0.26 * actorRenderElevation(actor));
      const left = actor.renderX * TILE_SIZE;
      const top = actor.renderY * TILE_SIZE - surfaceLift;

      if (
        sourceViewportRect.width === sourceBoardRect.width &&
        sourceViewportRect.height === sourceBoardRect.height
      ) {
        return { left, top };
      }

      return {
        left: left - Math.round(cameraX),
        top: top - Math.round(cameraY)
      };
    }

    function viewportPositionForActor(actor) {
      return viewportPositionForActorAtCamera(actor, app.cameraX, app.cameraY);
    }

    function paintTransitionPlayer(actor, left, top) {
      const elevation = actor.renderElevation ?? actor.elevation ?? 0;
      const surfaceLift = Math.round(TILE_SIZE * 0.26 * elevation);
      const overlayActor = {
        ...actor,
        renderX: left / TILE_SIZE,
        renderY: (top + surfaceLift) / TILE_SIZE,
        renderElevation: elevation,
        renderScale: actor.renderScale ?? 1,
        renderAlpha: actor.renderAlpha ?? 1,
        renderSink: 0,
        renderInHole: false,
        removed: false
      };

      if (overlayActor.type === "player") {
        paintRaisedPlayer(overlayActor, viewCtx);
        return;
      }

      if (overlayActor.type === "circle_player") {
        viewCtx.fillStyle = "#5aa95c";
        viewCtx.beginPath();
        viewCtx.arc(
          left + TILE_SIZE / 2,
          top + TILE_SIZE / 2,
          TILE_SIZE * 0.338 * (overlayActor.renderScale ?? 1),
          0,
          Math.PI * 2
        );
        viewCtx.fill();
        viewCtx.lineWidth = 3;
        viewCtx.strokeStyle = "#000000";
        viewCtx.stroke();
      }
    }

    function captureViewportSnapshot(options = {}, now = performance.now()) {
      const skipActorsPredicate =
        typeof options.skipActorsPredicate === "function" ? options.skipActorsPredicate : null;
      app.syncLiveRaisedSurfaces();
      app.syncGateAnimationTargets(now);
      app.syncOrangeWallAnimationTargets(now);
      app.syncPlayerLiftAnimationTargets(now);
      const hiddenActors = [];

      if (skipActorsPredicate) {
        state.actors.forEach((actor) => {
          if (!skipActorsPredicate(actor)) {
            return;
          }

          hiddenActors.push({
            actor,
            removed: actor.removed
          });
          actor.removed = true;
        });
      }

      drawScene(now);
      const snapshot = cloneCanvas(composeViewportSource(), viewportRect.width, viewportRect.height);
      hiddenActors.forEach(({ actor, removed }) => {
        actor.removed = removed;
      });
      return snapshot;
    }

    function captureSceneSnapshot(options = {}, now = performance.now()) {
      const skipActorsPredicate =
        typeof options.skipActorsPredicate === "function" ? options.skipActorsPredicate : null;
      app.syncLiveRaisedSurfaces();
      app.syncGateAnimationTargets(now);
      app.syncOrangeWallAnimationTargets(now);
      app.syncPlayerLiftAnimationTargets(now);
      const hiddenActors = [];

      if (skipActorsPredicate) {
        state.actors.forEach((actor) => {
          if (!skipActorsPredicate(actor)) {
            return;
          }

          hiddenActors.push({
            actor,
            removed: actor.removed
          });
          actor.removed = true;
        });
      }

      drawScene(now);
      const snapshot = cloneCanvas(sceneCanvas, boardRect.width, boardRect.height);
      hiddenActors.forEach(({ actor, removed }) => {
        actor.removed = removed;
      });
      return snapshot;
    }

    function captureForegroundOccluderSnapshot(options = {}, now = performance.now()) {
      const skipActorsPredicate =
        typeof options.skipActorsPredicate === "function" ? options.skipActorsPredicate : null;
      const occludingActor = options.occludingActor || null;
      const hiddenActors = [];

      if (!occludingActor) {
        return null;
      }

      const occluderDepth = actorDepthRow(occludingActor) + (occludingActor.renderInHole ? 0 : 1);
      const occluderTieBreaker =
        occludingActor.renderInHole
          ? -1
          : isCollectibleActor(occludingActor)
            ? 0
            : isPlayerActor(occludingActor)
              ? 2
              : 1;

      app.syncLiveRaisedSurfaces();
      app.syncGateAnimationTargets(now);
      app.syncOrangeWallAnimationTargets(now);
      app.syncPlayerLiftAnimationTargets(now);

      if (skipActorsPredicate) {
        state.actors.forEach((actor) => {
          if (!skipActorsPredicate(actor)) {
            return;
          }

          hiddenActors.push({
            actor,
            removed: actor.removed
          });
          actor.removed = true;
        });
      }

      sceneCtx.clearRect(0, 0, boardRect.width, boardRect.height);
      paintDepthSortedScene(now, function (item) {
        return (
          item.depth > occluderDepth ||
          (item.depth === occluderDepth && item.tieBreaker > occluderTieBreaker)
        );
      });
      const snapshot = cloneCanvas(sceneCanvas, boardRect.width, boardRect.height);
      hiddenActors.forEach(({ actor, removed }) => {
        actor.removed = removed;
      });
      return snapshot;
    }

    function startLevelTransitionLoop() {
      if (app.levelTransitionFrameId !== null) {
        return;
      }

      function step(now) {
        app.levelTransitionFrameId = null;
        // A camera/model callback may already have rendered the default
        // "scene" channel at this exact RAF timestamp. The transition loop
        // must use its own channel: if renderOncePerFrame dedupes this
        // callback after we clear levelTransitionFrameId, no callback remains
        // to advance or complete the transition.
        (app.renderOncePerFrame || app.render)(now, "level-transition");
      }

      app.levelTransitionFrameId = window.requestAnimationFrame(step);
    }

    function startLevelTransition(
      fromCanvas,
      toCanvas,
      dx,
      dy,
      player = null,
      fromScene = null,
      fromForeground = null,
      options = {}
    ) {
      app.levelTransition = {
        fromCanvas,
        fromScene,
        fromForeground,
        toCanvas,
        dx,
        dy,
        player,
        startMs: performance.now(),
        durationMs: options.durationMs || app.LEVEL_TRANSITION_DURATION_MS,
        transitionData: options.transitionData || null,
        onComplete: typeof options.onComplete === "function" ? options.onComplete : null
      };
      app.inputActionEndsAtMs = app.levelTransition.startMs + app.levelTransition.durationMs;
      app.isTransitioningLevel = true;
      startLevelTransitionLoop();

      if (options.renderImmediately !== false) {
        app.render();
      }
    }

    function composeLevelTransitionSource(now = performance.now()) {
      const transition = app.levelTransition;

      if (!transition) {
        return null;
      }

      const progress = clamp((now - transition.startMs) / transition.durationMs, 0, 1);

      if (transition.transitionData?.kind === "adjacent-scene") {
        if (app.threeRenderer && app.threeRenderer.renderScene(now)) {
          return {
            sourceCanvas: composeViewportSource(),
            active: progress < 1
          };
        }

        drawScene(now);
        return {
          sourceCanvas: composeViewportSource(),
          active: false
        };
      }

      const eased = easeInOutQuad(progress);
      const worldShiftX = -transition.dx;
      const worldShiftY = -transition.dy;
      const overlap = 0;
      const oldX = worldShiftX * eased * viewportRect.width;
      const oldY = worldShiftY * eased * viewportRect.height;
      const newX = oldX - worldShiftX * (viewportRect.width - overlap);
      const newY = oldY - worldShiftY * (viewportRect.height - overlap);
      let outgoingCameraX = transition.fromScene?.cameraX ?? 0;
      let outgoingCameraY = transition.fromScene?.cameraY ?? 0;
      const incomingCanvas = captureViewportSnapshot({
        skipActorsPredicate: isTransitionHiddenPlayer
      }, now);
      const incomingForegroundCanvas =
        transition.player?.targetActor
          ? captureForegroundOccluderSnapshot(
              {
                occludingActor: transition.player.targetActor,
                skipActorsPredicate: isTransitionHiddenPlayer
              },
              now
            )
          : null;

      viewCtx.clearRect(0, 0, viewportRect.width, viewportRect.height);
      viewCtx.fillStyle = "#d6bd94";
      viewCtx.fillRect(0, 0, viewportRect.width, viewportRect.height);

      if (transition.fromScene?.canvas) {
        if (transition.dx !== 0) {
          outgoingCameraY = app.cameraY;
        }

        if (transition.dy !== 0) {
          outgoingCameraX = app.cameraX;
        }

        drawViewportFromScene(
          viewCtx,
          transition.fromScene.canvas,
          transition.fromScene.boardRect,
          transition.fromScene.viewportRect,
          outgoingCameraX,
          outgoingCameraY,
          oldX,
          oldY
        );
      } else {
        viewCtx.drawImage(transition.fromCanvas, Math.round(oldX), Math.round(oldY));
      }

      viewCtx.drawImage(incomingCanvas || transition.toCanvas, Math.round(newX), Math.round(newY));

      if (transition.player) {
        let sourcePosition = transition.player.from;

        if (transition.player.sourceActor && transition.fromScene) {
          sourcePosition = viewportPositionForActorAtCamera(
            transition.player.sourceActor,
            outgoingCameraX,
            outgoingCameraY,
            transition.fromScene.viewportRect,
            transition.fromScene.boardRect
          );
        }

        const targetActor =
          transition.player.targetActor && !transition.player.targetActor.removed
            ? transition.player.targetActor
            : null;
        const overlayActor = targetActor || transition.player.actor || transition.player.sourceActor;
        const targetPosition = targetActor ? viewportPositionForActor(targetActor) : transition.player.to;
        const overlayLeft =
          sourcePosition.left +
          oldX +
          (targetPosition.left + newX - (sourcePosition.left + oldX)) * eased;
        const overlayTop =
          sourcePosition.top +
          oldY +
          (targetPosition.top + newY - (sourcePosition.top + oldY)) * eased;
        paintTransitionPlayer(overlayActor, overlayLeft, overlayTop);
      }

      if (transition.fromForeground?.canvas) {
        drawViewportFromScene(
          viewCtx,
          transition.fromForeground.canvas,
          transition.fromForeground.boardRect,
          transition.fromForeground.viewportRect,
          outgoingCameraX,
          outgoingCameraY,
          oldX,
          oldY
        );
      }

      if (incomingForegroundCanvas) {
        drawViewportFromScene(
          viewCtx,
          incomingForegroundCanvas,
          boardRect,
          viewportRect,
          app.cameraX,
          app.cameraY,
          newX,
          newY
        );
      }

      return {
        sourceCanvas: viewCanvas,
        active: progress < 1
      };
    }

    app.renderCompositor = {
      drawViewportFromScene,
      composeViewportSource,
      drawScene,
      cloneCanvas,
      viewportPositionForActorAtCamera,
      viewportPositionForActor,
      paintTransitionPlayer,
      captureViewportSnapshot,
      captureSceneSnapshot,
      captureForegroundOccluderSnapshot,
      startLevelTransitionLoop,
      startLevelTransition,
      composeLevelTransitionSource
    };
  };
})();
