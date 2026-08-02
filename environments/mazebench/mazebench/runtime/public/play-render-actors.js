(function () {
  const modules = window.PlayModules || (window.PlayModules = {});

  modules.registerRenderActorFunctions = function registerRenderActorFunctions(app) {
    const {
      state,
      TILE_SIZE,
      FLOATING_FLOOR_SHADOW_INSET,
      FLOATING_FLOOR_SHADOW_HEIGHT,
      GEM_DRAW_WIDTH,
      GEM_SHADOW_WIDTH,
      GEM_SHADOW_HEIGHT,
      sceneCtx,
      weightlessGroupCanvas,
      weightlessGroupCtx,
      imageCache
    } = app;
    const {
      terrainAt,
      terrainSurfaceHeightAt,
      gateLiftAt,
      playerLiftAt,
      orangeWallLiftAt,
      isWeightlessBoxAt,
      weightlessGroupRenderState,
      weightlessGroupMembers,
      floatingFloorHoverOffset,
      isCollectibleActor,
      isPlayerActor,
      actorRenderElevation
    } = app;
    const {
      roundRectPath,
      paintWallTile,
      paintRaisedTerrainStackTile,
      paintRaisedPlayerGateTile,
      paintRaisedPlayerLiftTile,
      paintRaisedOrangeWallTile,
      queueElevatedSideBleedCoverItems
    } = app.renderTerrain;

    function paintWeightlessBoxTile(actor, offsetX = 0, offsetY = 0, context = sceneCtx) {
      const left = actor.x * TILE_SIZE + offsetX;
      const top = actor.y * TILE_SIZE + offsetY;
      const right = left + TILE_SIZE;
      const bottom = top + TILE_SIZE;
      const openTop = !isWeightlessBoxAt(actor.groupId, actor.x, actor.y - 1);
      const openRight = !isWeightlessBoxAt(actor.groupId, actor.x + 1, actor.y);
      const openBottom = !isWeightlessBoxAt(actor.groupId, actor.x, actor.y + 1);
      const openLeft = !isWeightlessBoxAt(actor.groupId, actor.x - 1, actor.y);
      const faceHeight = Math.round(TILE_SIZE * 0.26);
      const liftHeight = openTop ? faceHeight : 0;
      const wallTop = top - liftHeight;
      const wallHeight = TILE_SIZE + liftHeight;
      const radius = TILE_SIZE * 0.18;
      const radii = {
        tl: openTop && openLeft ? radius : 0,
        tr: openTop && openRight ? radius : 0,
        br: 0,
        bl: 0
      };
      const rightSideVisibleEnd =
        openRight &&
        actor.x < state.width - 1 &&
        actor.y < state.height - 1 &&
        !openBottom &&
        isWeightlessBoxAt(actor.groupId, actor.x + 1, actor.y + 1) &&
        !isWeightlessBoxAt(actor.groupId, actor.x + 1, actor.y)
          ? bottom - faceHeight
          : bottom - radii.br;
      const leftSideVisibleEnd =
        openLeft &&
        actor.x > 0 &&
        actor.y < state.height - 1 &&
        !openBottom &&
        isWeightlessBoxAt(actor.groupId, actor.x - 1, actor.y + 1) &&
        !isWeightlessBoxAt(actor.groupId, actor.x - 1, actor.y)
          ? bottom - faceHeight
          : bottom - radii.bl;
      const rightSideEnd = rightSideVisibleEnd;
      const leftSideEnd = leftSideVisibleEnd;

      roundRectPath(context, left, wallTop, TILE_SIZE, wallHeight, radii);
      context.save();
      context.clip();
      context.fillStyle = "#315991";
      context.fillRect(left, wallTop, TILE_SIZE, wallHeight);

      if (openBottom) {
        const shineTop = bottom - faceHeight;
        const shineBorderWidth = 3;
        const leftNeighborHasShine =
          actor.x > 0 &&
          isWeightlessBoxAt(actor.groupId, actor.x - 1, actor.y) &&
          !isWeightlessBoxAt(actor.groupId, actor.x - 1, actor.y + 1);
        const rightNeighborHasShine =
          actor.x < state.width - 1 &&
          isWeightlessBoxAt(actor.groupId, actor.x + 1, actor.y) &&
          !isWeightlessBoxAt(actor.groupId, actor.x + 1, actor.y + 1);
        context.fillStyle = "#79abeb";
        context.fillRect(left, shineTop, TILE_SIZE, faceHeight);
        context.lineWidth = shineBorderWidth;
        context.strokeStyle = "#000000";
        context.beginPath();
        context.moveTo(left, shineTop + shineBorderWidth / 2);
        context.lineTo(right, shineTop + shineBorderWidth / 2);
        context.stroke();
        context.fillStyle = "#000000";
        if (!openLeft && !leftNeighborHasShine) {
          context.fillRect(left, shineTop, shineBorderWidth, faceHeight);
        }
        if (!openRight && !rightNeighborHasShine) {
          context.fillRect(right - shineBorderWidth, shineTop, shineBorderWidth, faceHeight);
        }
      }
      context.restore();

      function traceOutline() {
        context.beginPath();

        if (openTop) {
          context.moveTo(left + radii.tl, wallTop);
          context.lineTo(right - radii.tr, wallTop);
        }

        if (openRight) {
          context.moveTo(right, wallTop + radii.tr);
          context.lineTo(right, rightSideEnd);
        }

        if (openBottom) {
          context.moveTo(right - radii.br, bottom);
          context.lineTo(left + radii.bl, bottom);
        }

        if (openLeft) {
          context.moveTo(left, leftSideEnd);
          context.lineTo(left, wallTop + radii.tl);
        }

        if (radii.tl > 0) {
          context.moveTo(left + radii.tl, wallTop);
          context.quadraticCurveTo(left, wallTop, left, wallTop + radii.tl);
        }

        if (radii.tr > 0) {
          context.moveTo(right - radii.tr, wallTop);
          context.quadraticCurveTo(right, wallTop, right, wallTop + radii.tr);
        }

        if (radii.br > 0) {
          context.moveTo(right, bottom - radii.br);
          context.quadraticCurveTo(right, bottom, right - radii.br, bottom);
        }

        if (radii.bl > 0) {
          context.moveTo(left + radii.bl, bottom);
          context.quadraticCurveTo(left, bottom, left, bottom - radii.bl);
        }
      }

      context.lineWidth = 3;
      context.strokeStyle = "#315991";
      traceOutline();
      context.stroke();
      context.strokeStyle = "#000000";
      traceOutline();
      context.stroke();
    }

    function paintRaisedPlayer(actor, context = sceneCtx) {
      const scale = actor.renderScale ?? 1;
      const alpha = actor.renderAlpha ?? 1;

      if (scale <= 0.001 || alpha <= 0.001) {
        return;
      }

      const sink = actor.renderSink ?? 0;
      const surfaceLift = Math.round(TILE_SIZE * 0.26 * actorRenderElevation(actor));
      const left = actor.renderX * TILE_SIZE;
      const top = actor.renderY * TILE_SIZE - surfaceLift;
      const bottom = top + TILE_SIZE;
      const faceHeight = Math.round(TILE_SIZE * 0.26);
      const liftHeight = faceHeight;
      const blockTop = top - liftHeight;
      const blockHeight = TILE_SIZE + liftHeight;
      const radius = TILE_SIZE * 0.18;
      const radii = {
        tl: radius,
        tr: radius,
        br: 0,
        bl: 0
      };
      const rightSideEnd = bottom;
      const leftSideEnd = bottom;

      context.save();
      context.translate(left + TILE_SIZE / 2, bottom + sink);
      context.scale(scale, scale);
      context.translate(-(left + TILE_SIZE / 2), -bottom);

      roundRectPath(context, left, blockTop, TILE_SIZE, blockHeight, radii);
      context.save();
      context.clip();
      context.fillStyle = "#4d8b52";
      context.fillRect(left, blockTop, TILE_SIZE, blockHeight);

      const shineTop = bottom - faceHeight;
      const shineBorderWidth = 3;
      context.fillStyle = "#86cb7d";
      context.fillRect(left, shineTop, TILE_SIZE, faceHeight);
      context.lineWidth = shineBorderWidth;
      context.strokeStyle = "#000000";
      context.beginPath();
      context.moveTo(left, shineTop + shineBorderWidth / 2);
      context.lineTo(left + TILE_SIZE, shineTop + shineBorderWidth / 2);
      context.stroke();
      context.restore();

      function tracePlayerOutline() {
        context.beginPath();
        context.moveTo(left + radii.tl, blockTop);
        context.lineTo(left + TILE_SIZE - radii.tr, blockTop);
        context.moveTo(left + TILE_SIZE, blockTop + radii.tr);
        context.lineTo(left + TILE_SIZE, rightSideEnd);
        context.moveTo(left + TILE_SIZE, bottom);
        context.lineTo(left, bottom);
        context.moveTo(left, leftSideEnd);
        context.lineTo(left, blockTop + radii.tl);
        if (radii.tl > 0) {
          context.moveTo(left + radii.tl, blockTop);
          context.quadraticCurveTo(left, blockTop, left, blockTop + radii.tl);
        }
        if (radii.tr > 0) {
          context.moveTo(left + TILE_SIZE - radii.tr, blockTop);
          context.quadraticCurveTo(
            left + TILE_SIZE,
            blockTop,
            left + TILE_SIZE,
            blockTop + radii.tr
          );
        }
      }

      context.lineWidth = 3;
      context.strokeStyle = "#4d8b52";
      tracePlayerOutline();
      context.stroke();
      context.strokeStyle = "#000000";
      tracePlayerOutline();
      context.stroke();
      context.restore();
    }

    function paintFloatingFloor(actor, context = sceneCtx, now = performance.now()) {
      const scale = actor.renderScale ?? 1;
      const alpha = actor.renderAlpha ?? 1;

      if (scale <= 0.001 || alpha <= 0.001) {
        return;
      }

      const sink = actor.renderSink ?? 0;
      const left = actor.renderX * TILE_SIZE;
      const top = actor.renderY * TILE_SIZE;
      const right = left + TILE_SIZE;
      const bottom = top + TILE_SIZE;
      const hover = Math.max(0, floatingFloorHoverOffset(actor, now));
      const platformTop = top - hover + sink;
      const platformBottom = bottom - hover + sink;
      const radius = Math.min(7, TILE_SIZE * 0.11);
      const rightSideEnd = bottom + sink;
      const leftSideEnd = bottom + sink;

      context.save();
      context.translate(left + TILE_SIZE / 2, bottom + sink);
      context.scale(scale, scale);
      context.translate(-(left + TILE_SIZE / 2), -(bottom + sink));

      roundRectPath(
        context,
        left + FLOATING_FLOOR_SHADOW_INSET,
        bottom - FLOATING_FLOOR_SHADOW_HEIGHT * 0.5 + sink,
        TILE_SIZE - FLOATING_FLOOR_SHADOW_INSET * 2,
        FLOATING_FLOOR_SHADOW_HEIGHT,
        {
          tl: FLOATING_FLOOR_SHADOW_HEIGHT * 0.5,
          tr: FLOATING_FLOOR_SHADOW_HEIGHT * 0.5,
          br: FLOATING_FLOOR_SHADOW_HEIGHT * 0.5,
          bl: FLOATING_FLOOR_SHADOW_HEIGHT * 0.5
        }
      );
      context.fillStyle = "rgba(0, 0, 0, 0.18)";
      context.fill();

      roundRectPath(context, left, platformTop, TILE_SIZE, TILE_SIZE + hover, {
        tl: radius,
        tr: radius,
        br: 0,
        bl: 0
      });
      context.save();
      context.clip();
      context.fillStyle = "#d6bd94";
      context.fillRect(left, platformTop, TILE_SIZE, TILE_SIZE + hover);
      context.strokeStyle = "rgba(0, 0, 0, 0.12)";
      context.lineWidth = 1.5;
      context.strokeRect(left + 0.75, platformTop + 0.75, TILE_SIZE - 1.5, TILE_SIZE - 1.5);

      if (hover > 0.001) {
        context.fillStyle = "#b89c73";
        context.fillRect(left, platformBottom, TILE_SIZE, hover);
      }
      context.restore();

      context.lineWidth = 3;
      context.strokeStyle = "#000000";
      context.beginPath();
      context.moveTo(left + radius, platformTop);
      context.lineTo(right - radius, platformTop);
      context.moveTo(right, platformTop + radius);
      context.lineTo(right, rightSideEnd);
      context.moveTo(right, bottom + sink);
      context.lineTo(left, bottom + sink);
      context.moveTo(left, leftSideEnd);
      context.lineTo(left, platformTop + radius);
      context.moveTo(left + radius, platformTop);
      context.quadraticCurveTo(left, platformTop, left, platformTop + radius);
      context.moveTo(right - radius, platformTop);
      context.quadraticCurveTo(right, platformTop, right, platformTop + radius);

      if (hover > 0.001) {
        context.moveTo(left, platformBottom);
        context.lineTo(right, platformBottom);
      }

      context.stroke();
      context.restore();
    }

    function animatedWeightlessGroupMembers(groupId) {
      return weightlessGroupMembers(groupId, { includeRemoved: true }).filter(
        (member) => !member.removed || member.renderScale > 0.001
      );
    }

    function paintWeightlessGroupSeamCovers(members, offsetX = 0, offsetY = 0, context = sceneCtx) {
      const memberKeys = new Set(members.map((member) => `${member.x},${member.y}`));
      const seamRows = new Map();
      const coverHeight = 5;
      const coverInsetX = 2;
      const coverTopOffset = Math.floor(coverHeight / 2);

      members.forEach((member) => {
        if (!memberKeys.has(`${member.x},${member.y + 1}`)) {
          return;
        }

        const seamY = member.y + 1;
        const row = seamRows.get(seamY) || [];
        row.push(member.x);
        seamRows.set(seamY, row);
      });

      if (seamRows.size === 0) {
        return;
      }

      context.save();
      context.fillStyle = "#315991";

      seamRows.forEach((columns, seamY) => {
        columns.sort((left, right) => left - right);
        let spanStart = columns[0];
        let previous = columns[0];

        for (let index = 1; index <= columns.length; index += 1) {
          const column = columns[index];

          if (column === previous + 1) {
            previous = column;
            continue;
          }

          context.fillRect(
            spanStart * TILE_SIZE + offsetX + coverInsetX,
            seamY * TILE_SIZE + offsetY - coverTopOffset,
            (previous - spanStart + 1) * TILE_SIZE - coverInsetX * 2,
            coverHeight
          );

          spanStart = column;
          previous = column;
        }
      });

      context.restore();
    }

    function hasWeightlessGroupSeams(members) {
      const memberKeys = new Set(members.map((member) => `${member.x},${member.y}`));

      return members.some((member) => memberKeys.has(`${member.x},${member.y + 1}`));
    }

    function isWeightlessGroupTransformAnimation(groupState) {
      return (
        Math.abs((groupState.scale ?? 1) - 1) > 0.001 ||
        Math.abs(groupState.sink ?? 0) > 0.001
      );
    }

    function paintWeightlessGroup(groupId) {
      const groupState = weightlessGroupRenderState(groupId);

      if (groupState.scale <= 0.001) {
        return;
      }

      const members = animatedWeightlessGroupMembers(groupId).sort((left, right) => {
        if (left.y !== right.y) {
          return left.y - right.y;
        }

        return left.x - right.x;
      });

      if (members.length === 0) {
        return;
      }

      if (!weightlessGroupCtx) {
        members.forEach((member) => {
          paintWeightlessBoxTile(
            member,
            groupState.offsetX,
            groupState.offsetY - (groupState.surfaceLift ?? 0)
          );
        });
        paintWeightlessGroupSeamCovers(
          members,
          groupState.offsetX,
          groupState.offsetY - (groupState.surfaceLift ?? 0)
        );
        return;
      }

      const faceHeight = Math.round(TILE_SIZE * 0.26);
      const minX = Math.min(...members.map((member) => member.x));
      const maxX = Math.max(...members.map((member) => member.x));
      const minY = Math.min(...members.map((member) => member.y));
      const maxY = Math.max(...members.map((member) => member.y));
      const bitmapWidth = (maxX - minX + 1) * TILE_SIZE;
      const bitmapHeight = (maxY - minY + 1) * TILE_SIZE + faceHeight;
      const tileOffsetX = -minX * TILE_SIZE;
      const tileOffsetY = faceHeight - minY * TILE_SIZE;
      const drawLeft = minX * TILE_SIZE + groupState.offsetX;
      const drawTop =
        minY * TILE_SIZE -
        faceHeight +
        groupState.offsetY -
        (groupState.surfaceLift ?? 0);

      if (
        weightlessGroupCanvas.width !== bitmapWidth ||
        weightlessGroupCanvas.height !== bitmapHeight
      ) {
        weightlessGroupCanvas.width = bitmapWidth;
        weightlessGroupCanvas.height = bitmapHeight;
      }

      weightlessGroupCtx.setTransform(1, 0, 0, 1, 0, 0);
      weightlessGroupCtx.clearRect(0, 0, bitmapWidth, bitmapHeight);
      weightlessGroupCtx.imageSmoothingEnabled = false;
      members.forEach((member) => {
        paintWeightlessBoxTile(member, tileOffsetX, tileOffsetY, weightlessGroupCtx);
      });
      paintWeightlessGroupSeamCovers(members, tileOffsetX, tileOffsetY, weightlessGroupCtx);

      sceneCtx.save();
      if (groupState.sink > 0.001) {
        sceneCtx.beginPath();
        members.forEach((member) => {
          sceneCtx.rect(member.x * TILE_SIZE, member.y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        });
        sceneCtx.clip();
      }
      sceneCtx.translate(groupState.centerX, groupState.centerY + groupState.sink);
      sceneCtx.scale(groupState.scale, groupState.scale);
      sceneCtx.translate(-groupState.centerX, -groupState.centerY);
      sceneCtx.imageSmoothingEnabled = false;
      sceneCtx.drawImage(weightlessGroupCanvas, drawLeft, drawTop);
      sceneCtx.restore();
    }

    function queueWeightlessGroupSeamCoverItems(drawItems) {
      const groupIds = new Set();

      state.actors.forEach((actor) => {
        if (actor.removed || actor.type !== "weightless_box") {
          return;
        }

        groupIds.add(actor.groupId);
      });

      groupIds.forEach((groupId) => {
        const groupState = weightlessGroupRenderState(groupId);
        const members = animatedWeightlessGroupMembers(groupId);

        if (
          members.length < 2 ||
          (groupState.renderElevation ?? 0) <= 0.001 ||
          isWeightlessGroupTransformAnimation(groupState) ||
          !hasWeightlessGroupSeams(members)
        ) {
          return;
        }

        drawItems.push({
          depth: 1 + Math.ceil(Math.max(...members.map((member) => member.renderY ?? member.y))),
          tieBreaker: 3.25,
          order: drawItems.length,
          paint: function () {
            paintWeightlessGroupSeamCovers(
              members,
              groupState.offsetX,
              groupState.offsetY - (groupState.surfaceLift ?? 0)
            );
          }
        });
      });
    }

    function actorDepthRow(actor) {
      const renderY = actor.renderY ?? actor.y;
      const underElevatedWeightlessDepthRow = actorUnderElevatedWeightlessDepthRow(actor);

      if (underElevatedWeightlessDepthRow !== null) {
        return underElevatedWeightlessDepthRow;
      }

      if (actorRenderElevation(actor) <= 0.001) {
        return renderY;
      }

      return Math.ceil(renderY);
    }

    function playerDownwardElevatedWeightlessPushDepthRow(actor) {
      if (!isPlayerActor(actor) || actorRenderElevation(actor) <= 0.001) {
        return null;
      }

      const renderX = actor.renderX ?? actor.x;
      const renderY = actor.renderY ?? actor.y;
      const downwardProgress = actor.y - renderY;
      const epsilon = 0.001;
      let depthRow = null;

      if (downwardProgress <= epsilon) {
        return null;
      }

      state.actors.forEach((candidate) => {
        if (
          candidate.removed ||
          candidate.type !== "weightless_box" ||
          actorRenderElevation(candidate) <= 0.001 ||
          candidate.y !== actor.y + 1
        ) {
          return;
        }

        const candidateRenderX = candidate.renderX ?? candidate.x;
        const candidateRenderY = candidate.renderY ?? candidate.y;
        const sameColumn = Math.abs(candidateRenderX - renderX) <= epsilon;
        const pushedOneTileAhead = Math.abs(candidateRenderY - renderY - 1) <= epsilon;

        if (!sameColumn || !pushedOneTileAhead) {
          return;
        }

        const candidateDepthRow = Math.ceil(candidateRenderY);
        depthRow = depthRow === null ? candidateDepthRow : Math.max(depthRow, candidateDepthRow);
      });

      return depthRow;
    }

    function paintPlayerDownwardPushUpperOverlay(actor) {
      if (actor.type !== "player") {
        return;
      }

      const surfaceLift = Math.round(TILE_SIZE * 0.26 * actorRenderElevation(actor));
      const faceHeight = Math.round(TILE_SIZE * 0.26);
      const left = actor.renderX * TILE_SIZE;
      const top = actor.renderY * TILE_SIZE - surfaceLift;
      const bottom = top + TILE_SIZE;
      const blockTop = top - faceHeight;
      const overlayBottom = bottom - faceHeight;
      const strokePadding = 4;

      sceneCtx.save();
      sceneCtx.beginPath();
      sceneCtx.rect(
        left - strokePadding,
        blockTop - strokePadding,
        TILE_SIZE + strokePadding * 2,
        overlayBottom - blockTop + strokePadding
      );
      sceneCtx.clip();
      paintRaisedPlayer(actor);
      sceneCtx.restore();
    }

    function actorUnderElevatedWeightlessDepthRow(actor) {
      const actorIsElevated = actorRenderElevation(actor) > 0.001;
      const actorCanShareElevatedWeightlessDepth = !actorIsElevated || isPlayerActor(actor);

      if (!actorCanShareElevatedWeightlessDepth) {
        return null;
      }

      const epsilon = 0.001;
      let depthRow = null;

      function renderBounds(target) {
        const renderX = target.renderX ?? target.x;
        const renderY = target.renderY ?? target.y;

        return {
          left: renderX,
          right: renderX + 1,
          top: renderY,
          bottom: renderY + 1
        };
      }

      function logicalBounds(target) {
        return {
          left: target.x,
          right: target.x + 1,
          top: target.y,
          bottom: target.y + 1
        };
      }

      function boundsOverlap(left, right) {
        return (
          left.left < right.right - epsilon &&
          left.right > right.left + epsilon &&
          left.top < right.bottom - epsilon &&
          left.bottom > right.top + epsilon
        );
      }

      function actorStackBoundsOverlap(lowerActor, upperActor) {
        const lowerRenderBounds = renderBounds(lowerActor);
        const lowerLogicalBounds = logicalBounds(lowerActor);
        const upperRenderBounds = renderBounds(upperActor);
        const upperLogicalBounds = logicalBounds(upperActor);

        return (
          boundsOverlap(lowerRenderBounds, upperRenderBounds) ||
          boundsOverlap(lowerRenderBounds, upperLogicalBounds) ||
          boundsOverlap(lowerLogicalBounds, upperRenderBounds) ||
          boundsOverlap(lowerLogicalBounds, upperLogicalBounds)
        );
      }

      state.actors.forEach((candidate) => {
        if (
          candidate === actor ||
          candidate.removed ||
          candidate.type !== "weightless_box" ||
          actorRenderElevation(candidate) <= 0.001
        ) {
          return;
        }

        const candidateRenderY = candidate.renderY ?? candidate.y;
        const candidateDepthRow = Math.ceil(candidateRenderY);

        if (!actorStackBoundsOverlap(actor, candidate)) {
          return;
        }

        if (actorIsElevated && candidateDepthRow !== Math.ceil(actor.renderY ?? actor.y)) {
          return;
        }

        depthRow = depthRow === null ? candidateDepthRow : Math.min(depthRow, candidateDepthRow);
      });

      return depthRow;
    }

    function actorUnderElevatedWeightlessTieBreaker(actor) {
      const depthRow = actorUnderElevatedWeightlessDepthRow(actor);

      if (depthRow === null) {
        return null;
      }

      const renderY = actor.renderY ?? actor.y;
      const normalTieBreaker = actorTieBreakerWithoutElevatedWeightless(actor);
      const typeOffset = Math.max(0, Math.min(0.2, normalTieBreaker * 0.05));

      return 1 + Math.max(0, Math.min(1.5, renderY - depthRow + 1)) + typeOffset;
    }

    function actorTieBreakerWithoutElevatedWeightless(actor) {
      if (actor.renderInHole) {
        return -1;
      }

      if (isCollectibleActor(actor)) {
        return 0;
      }

      if (actor.type === "weightless_box" && actorRenderElevation(actor) > 0.001) {
        return 2.75;
      }

      if (isPlayerActor(actor)) {
        return 2;
      }

      return 1;
    }

    function actorTieBreaker(actor) {
      const underElevatedWeightlessTieBreaker = actorUnderElevatedWeightlessTieBreaker(actor);

      if (underElevatedWeightlessTieBreaker !== null) {
        return underElevatedWeightlessTieBreaker;
      }

      return actorTieBreakerWithoutElevatedWeightless(actor);
    }

    function buildDrawItems(now = performance.now()) {
      const drawItems = [];
      const animatedWeightlessGroups = new Set();

      for (let y = 0; y < state.height; y += 1) {
        for (let x = 0; x < state.width; x += 1) {
          const cell = terrainAt(x, y);
          const gateLift = cell.type === "player_gate" ? gateLiftAt(x, y, now) : 0;
          const playerLift = cell.type === "player_lift" ? playerLiftAt(x, y, now) : 0;
          const orangeWallLift = cell.type === "orange_wall" ? orangeWallLiftAt(x, y, now) : 0;
          const terrainHeight = terrainSurfaceHeightAt(x, y) ?? 0;

          if (
            cell.type !== "wall" &&
            gateLift <= 0.001 &&
            playerLift <= 0.001 &&
            orangeWallLift <= 0.001 &&
            terrainHeight <= 0
          ) {
            continue;
          }

          drawItems.push({
            depth: y + 1,
            tieBreaker: 0,
            order: drawItems.length,
            paint: function () {
              if (cell.type === "player_gate") {
                paintRaisedPlayerGateTile(x, y, cell, gateLift);
                return;
              }

              if (cell.type === "player_lift") {
                paintRaisedPlayerLiftTile(x, y, cell, playerLift);
                return;
              }

              if (cell.type === "orange_wall") {
                paintRaisedOrangeWallTile(x, y, cell, orangeWallLift);
                return;
              }

              if (terrainHeight > 0 && cell.type !== "wall") {
                paintRaisedTerrainStackTile(x, y, cell, terrainHeight);
                return;
              }

              paintWallTile(x, y, cell);
            }
          });
        }
      }

      state.actors.forEach((actor, index) => {
        const isCollectedGem = actor.type === "gem" && actor.showCollectedGhost === true;

        if (actor.removed && !isCollectedGem) {
          return;
        }

        if (actor.type === "weightless_box") {
          const groupState = weightlessGroupRenderState(actor.groupId);
          const isGroupedAnimation = isWeightlessGroupTransformAnimation(groupState);

          if (isGroupedAnimation) {
            if (animatedWeightlessGroups.has(actor.groupId)) {
              return;
            }

            animatedWeightlessGroups.add(actor.groupId);
            const members = animatedWeightlessGroupMembers(actor.groupId);

            if (members.length === 0) {
              return;
            }

            drawItems.push({
              depth:
                (actor.renderInHole ? 0 : 1) +
                ((groupState.renderElevation ?? 0) > 0.001
                  ? Math.ceil(Math.max(...members.map((member) => member.renderY)))
                  : Math.max(...members.map((member) => member.renderY))),
              tieBreaker: actor.renderInHole
                ? -1
                : (groupState.renderElevation ?? 0) > 0.001
                  ? 2.75
                  : 1,
              order: index,
              paint: function () {
                paintWeightlessGroup(actor.groupId);
              }
            });
            return;
          }
        }

        const depthRow = actorDepthRow(actor);
        drawItems.push({
          depth: depthRow + (actor.renderInHole ? 0 : 1),
          tieBreaker: actorTieBreaker(actor),
          order: index,
          paint: function () {
            paintActor(actor, now);
          }
        });

        const downwardPushDepthRow = playerDownwardElevatedWeightlessPushDepthRow(actor);

        if (downwardPushDepthRow !== null && actor.type === "player") {
          drawItems.push({
            depth: downwardPushDepthRow + (actor.renderInHole ? 0 : 1),
            tieBreaker: 3,
            order: index + 0.5,
            paint: function () {
              paintPlayerDownwardPushUpperOverlay(actor);
            }
          });
        }
      });

      queueWeightlessGroupSeamCoverItems(drawItems);
      queueElevatedSideBleedCoverItems(drawItems, now);

      drawItems.sort((left, right) => {
        if (left.depth !== right.depth) {
          return left.depth - right.depth;
        }

        if (left.tieBreaker !== right.tieBreaker) {
          return left.tieBreaker - right.tieBreaker;
        }

        return left.order - right.order;
      });

      return drawItems;
    }

    function paintDepthSortedScene(now = performance.now(), itemFilter = null) {
      const drawItems = buildDrawItems(now);

      drawItems.forEach((item) => {
        if (typeof itemFilter === "function" && !itemFilter(item)) {
          return;
        }

        item.paint();
      });

      return drawItems;
    }

    function paintActor(actor, now = performance.now()) {
      const isCollectedGem = actor.type === "gem" && actor.showCollectedGhost === true;

      if (actor.removed && !isCollectedGem) {
        return;
      }

      const scale = actor.renderScale ?? 1;
      const alpha = actor.renderAlpha ?? 1;

      if (scale <= 0.001 || alpha <= 0.001) {
        return;
      }

      const sink = actor.renderSink ?? 0;
      const surfaceLift = Math.round(TILE_SIZE * 0.26 * actorRenderElevation(actor));
      const left = actor.renderX * TILE_SIZE;
      const top = actor.renderY * TILE_SIZE - surfaceLift;
      const image = actor.imageUrl ? imageCache.get(actor.imageUrl) : null;
      const clipToHole = sink > 0.001;

      if (clipToHole) {
        sceneCtx.save();
        sceneCtx.beginPath();
        sceneCtx.rect(left, top, TILE_SIZE, TILE_SIZE);
        sceneCtx.clip();
      }

      if (actor.type === "weightless_box") {
        const groupState = weightlessGroupRenderState(actor.groupId);
        paintWeightlessBoxTile(
          actor,
          groupState.offsetX,
          groupState.offsetY - (groupState.surfaceLift ?? 0)
        );
        if (clipToHole) {
          sceneCtx.restore();
        }
        return;
      }

      if (actor.type === "floating_floor") {
        paintFloatingFloor(actor, sceneCtx, now);
        if (clipToHole) {
          sceneCtx.restore();
        }
        return;
      }

      if (actor.type === "gem") {
        const hover = Math.max(0, floatingFloorHoverOffset(actor, now));
        const drawWidth = GEM_DRAW_WIDTH * scale;
        const drawHeight = image ? drawWidth * (image.height / image.width) : drawWidth;
        const drawLeft = left + (TILE_SIZE - drawWidth) / 2;
        const drawTop = top + TILE_SIZE * 0.66 - drawHeight + sink - hover;
        const shadowWidth = GEM_SHADOW_WIDTH * scale;
        const shadowHeight = GEM_SHADOW_HEIGHT * scale;

        sceneCtx.fillStyle = "#000000";
        sceneCtx.beginPath();
        sceneCtx.ellipse(
          left + TILE_SIZE / 2,
          top + TILE_SIZE * 0.76 + sink,
          shadowWidth / 2,
          shadowHeight / 2,
          0,
          0,
          Math.PI * 2
        );
        sceneCtx.globalAlpha = alpha * 0.3;
        sceneCtx.fill();
        sceneCtx.globalAlpha = alpha;

        if (image) {
          sceneCtx.drawImage(image, drawLeft, drawTop, drawWidth, drawHeight);
        } else {
          sceneCtx.fillStyle = "#6cd7ff";
          sceneCtx.beginPath();
          sceneCtx.moveTo(left + TILE_SIZE / 2, drawTop);
          sceneCtx.lineTo(drawLeft + drawWidth, drawTop + drawHeight * 0.45);
          sceneCtx.lineTo(left + TILE_SIZE / 2, drawTop + drawHeight);
          sceneCtx.lineTo(drawLeft, drawTop + drawHeight * 0.45);
          sceneCtx.closePath();
          sceneCtx.fill();
        }

        sceneCtx.globalAlpha = 1;

        if (clipToHole) {
          sceneCtx.restore();
        }
        return;
      }

      if (image) {
        if (actor.type === "box") {
          const drawWidth = TILE_SIZE * scale;
          const drawHeight = drawWidth * (image.height / image.width);
          const drawLeft = left + (TILE_SIZE - drawWidth) / 2;
          const drawTop = top + TILE_SIZE - drawHeight + sink;

          sceneCtx.drawImage(image, drawLeft, drawTop, drawWidth, drawHeight);
          if (clipToHole) {
            sceneCtx.restore();
          }
          return;
        }

        const drawWidth = TILE_SIZE * scale;
        const drawHeight = TILE_SIZE * scale;
        const drawLeft = left + (TILE_SIZE - drawWidth) / 2;
        const drawTop = top + (TILE_SIZE - drawHeight) / 2 + sink;

        sceneCtx.drawImage(image, drawLeft, drawTop, drawWidth, drawHeight);
        if (clipToHole) {
          sceneCtx.restore();
        }
        return;
      }

      if (actor.type === "circle_player") {
        sceneCtx.fillStyle = "#5aa95c";
        sceneCtx.beginPath();
        sceneCtx.arc(
          left + TILE_SIZE / 2,
          top + TILE_SIZE / 2 + sink,
          TILE_SIZE * 0.338 * scale,
          0,
          Math.PI * 2
        );
        sceneCtx.fill();
        sceneCtx.lineWidth = 3;
        sceneCtx.strokeStyle = "#000000";
        sceneCtx.stroke();
        if (clipToHole) {
          sceneCtx.restore();
        }
        return;
      }

      if (actor.type === "player") {
        paintRaisedPlayer(actor);
        if (clipToHole) {
          sceneCtx.restore();
        }
        return;
      }

      if (actor.type === "clone") {
        sceneCtx.save();
        sceneCtx.translate(left + TILE_SIZE / 2, top + TILE_SIZE + sink);
        sceneCtx.scale(scale, scale);
        sceneCtx.translate(-(left + TILE_SIZE / 2), -(top + TILE_SIZE));
        const inset = TILE_SIZE * 0.12;
        const cloneLeft = left + inset;
        const cloneTop = top + inset;
        const cloneSize = TILE_SIZE - inset * 2;
        const cloneBottom = cloneTop + cloneSize;
        const lipHeight = Math.max(6, Math.round(TILE_SIZE * 0.12));

        sceneCtx.fillStyle = "#b59a2a";
        sceneCtx.fillRect(cloneLeft, cloneTop, cloneSize, cloneSize);
        sceneCtx.lineWidth = 3;
        sceneCtx.strokeStyle = "#000000";
        sceneCtx.strokeRect(cloneLeft, cloneTop, cloneSize, cloneSize);
        sceneCtx.fillStyle = "#8f7b21";
        sceneCtx.fillRect(cloneLeft, cloneBottom - lipHeight, cloneSize, lipHeight);
        sceneCtx.beginPath();
        sceneCtx.moveTo(cloneLeft, cloneBottom - lipHeight);
        sceneCtx.lineTo(cloneLeft + cloneSize, cloneBottom - lipHeight);
        sceneCtx.stroke();
        sceneCtx.restore();
        if (clipToHole) {
          sceneCtx.restore();
        }
        return;
      }

      if (actor.type === "box") {
        sceneCtx.save();
        sceneCtx.translate(left + TILE_SIZE / 2, top + TILE_SIZE + sink);
        sceneCtx.scale(scale, scale);
        sceneCtx.translate(-(left + TILE_SIZE / 2), -(top + TILE_SIZE));
        const inset = TILE_SIZE * 0.19;
        const boxLeft = left + inset;
        const boxTop = top + inset;
        const boxSize = TILE_SIZE - inset * 2;
        const boxBottom = boxTop + boxSize;
        const lipHeight = Math.max(6, Math.round(TILE_SIZE * 0.12));
        const radius = Math.min(8, TILE_SIZE * 0.12);

        roundRectPath(sceneCtx, boxLeft, boxTop, boxSize, boxSize, {
          tl: radius,
          tr: radius,
          br: radius * 0.75,
          bl: radius * 0.75
        });
        sceneCtx.fillStyle = "#2a2d33";
        sceneCtx.fill();
        sceneCtx.lineWidth = 3;
        sceneCtx.strokeStyle = "#000000";
        sceneCtx.stroke();

        sceneCtx.fillStyle = "#5b616d";
        sceneCtx.fillRect(boxLeft, boxBottom - lipHeight, boxSize, lipHeight);
        sceneCtx.beginPath();
        sceneCtx.moveTo(boxLeft, boxBottom - lipHeight);
        sceneCtx.lineTo(boxLeft + boxSize, boxBottom - lipHeight);
        sceneCtx.lineWidth = 3;
        sceneCtx.strokeStyle = "#000000";
        sceneCtx.stroke();
        sceneCtx.restore();
      }

      if (clipToHole) {
        sceneCtx.restore();
      }
    }

    app.renderActors = {
      paintWeightlessBoxTile,
      paintRaisedPlayer,
      paintFloatingFloor,
      animatedWeightlessGroupMembers,
      paintWeightlessGroup,
      paintWeightlessGroupSeamCovers,
      queueWeightlessGroupSeamCoverItems,
      actorDepthRow,
      actorTieBreaker,
      paintDepthSortedScene,
      buildDrawItems,
      paintActor
    };
  };
})();
