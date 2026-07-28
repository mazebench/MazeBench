(function () {
  const modules = window.AuthorPlayData || (window.AuthorPlayData = {});
  const actorNames = new Set([
    "player",
    "circle_player",
    "clone",
    "box",
    "gem",
    "floating_floor",
    "orange_button",
    "puncher",
    "weightless_box"
  ]);
  const supportActorNames = new Set([
    "player",
    "circle_player",
    "clone",
    "box",
    "floating_floor",
    "weightless_box"
  ]);
  const raisedTerrainNames = new Set([
    "wall",
    "ice_block",
    "ice_slope",
    "tree",
    "shrub",
    "block_asset",
    "orange_wall"
  ]);
  const baseSurfaceNames = new Set(["floor", "ice"]);
  const surfaceAttachmentNames = new Set(["orange_button"]);

  function titleCaseName(name) {
    return String(name || "")
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function createAdapter(authorData) {
    const blockAdder =
      typeof authorData?.blockAdder === "string" && authorData.blockAdder.length > 0
        ? authorData.blockAdder
        : "+";
    const emptyCellToken = blockAdder;
    const defaultFloorToken = authorData?.defaultFloorToken || ".";
    const palette = Array.isArray(authorData?.palette) ? authorData.palette : [];
    const toolByToken = new Map(palette.map((tool) => [tool.token, tool]));

    // Open-ended token families (Box N, Clone N, colored slopes): explicit
    // palette entries win; on a miss, synthesize a palette-shaped tool from
    // the family's base entry so painted cells with arbitrary ids round-trip.
    const tokenPatterns =
      typeof window !== "undefined" && window.MazeTokenPatterns
        ? window.MazeTokenPatterns
        : null;

    function resolveTool(token) {
      const existing = toolByToken.get(token);

      if (existing || !tokenPatterns) {
        return existing;
      }

      const pattern = tokenPatterns.resolvePatternToken(token);

      if (!pattern) {
        return undefined;
      }

      const base =
        toolByName.get(pattern.family) ||
        toolByName.get(pattern.type) ||
        (pattern.family === "orange_ice_slope" ? toolByName.get("ice_slope") : null) ||
        null;

      if (!base) {
        return undefined;
      }

      const synthesized = {
        ...base,
        direction: pattern.direction,
        groupId: pattern.groupId || null,
        label: pattern.label,
        name: pattern.family,
        shape: pattern.shape || null,
        styleKey: pattern.styleKey,
        token: pattern.token,
        type: pattern.type
      };

      toolByToken.set(token, synthesized);
      return synthesized;
    }
    const toolByName = new Map(palette.map((tool) => [tool.name, tool]));

    function toolType(tool) {
      return tool?.type || tool?.name;
    }

    function normalizeLegacyToken(token) {
      const trimmedToken = String(token ?? "").trim();
      return trimmedToken === "h" ? "" : trimmedToken;
    }

    function normalizeCellValue(value) {
      const trimmedValue = String(value ?? "").trim();

      if (!trimmedValue) {
        return emptyCellToken;
      }

      const tokens = trimmedValue.split(blockAdder).map(normalizeLegacyToken);

      if (tokens.length === 0 || tokens.every((token) => token.length === 0)) {
        return emptyCellToken;
      }

      const invalidToken = tokens.find((token) => token.length > 0 && !resolveTool(token));

      if (invalidToken) {
        throw new Error('Unknown token "' + invalidToken + '".');
      }

      return tokens.join(blockAdder);
    }

    function getCellTokens(value) {
      return String(value || "")
        .split(blockAdder)
        .map(normalizeLegacyToken);
    }

    function getCellTools(value) {
      return getCellTokens(value)
        .map((token) => resolveTool(token))
        .filter(Boolean);
    }

    function getCellStackEntries(value) {
      return getCellTokens(value)
        .map((token) => (token.length === 0 ? { isAir: true } : resolveTool(token)))
        .filter(Boolean);
    }

    // In maze level text, "+" is a layer separator. Even thin or non-blocking
    // tokens still reserve their written layer so later tokens stack above them.
    function actorToolLayerSlotHeight(tool) {
      return isActorTool(tool) ? 1 : 0;
    }

    function terrainToolLayerSlotHeight(tool) {
      if (isBaseSurfaceTool(tool)) {
        return 0;
      }

      return Math.max(1, terrainToolStackHeight(tool));
    }

    function cellStackMetadata(tokens) {
      const entries = [];
      let surfaceHeight = null;
      let previousSurfaceTerrain = false;
      let consumedBaseVoid = false;

      tokens.forEach((token, index) => {
        if (token.length === 0) {
          if (surfaceHeight === null && !consumedBaseVoid) {
            entries.push({ elevation: 0, index, isAir: true, isBaseVoid: true, token });
            consumedBaseVoid = true;
            previousSurfaceTerrain = false;
            return;
          }

          const elevation = Math.max(0, surfaceHeight ?? 0);
          entries.push({ elevation, index, isAir: true, token });
          surfaceHeight = elevation + 1;
          consumedBaseVoid = true;
          previousSurfaceTerrain = false;
          return;
        }

        const tool = resolveTool(token);

        if (!tool) {
          return;
        }

        if (isActorTool(tool)) {
          const elevation = Math.max(0, surfaceHeight ?? 0);
          entries.push({ elevation, index, isAir: false, token, tool });

          surfaceHeight = elevation + actorToolLayerSlotHeight(tool);
          previousSurfaceTerrain = false;

          return;
        }

        const isRaisedTerrain = isRaisedTerrainTool(tool);
        const isBaseSurface = isBaseSurfaceTool(tool);
        const stackHeight = terrainToolLayerSlotHeight(tool);
        let elevation = Math.max(0, surfaceHeight ?? 0);

        if (isBaseSurface && !isRaisedTerrain && previousSurfaceTerrain && surfaceHeight !== null) {
          elevation = surfaceHeight + 1;
        }

        entries.push({ elevation, index, isAir: false, token, tool });
        surfaceHeight = elevation + stackHeight;
        previousSurfaceTerrain = isBaseSurface;
      });

      return {
        entries,
        nextElevation: Math.max(0, surfaceHeight ?? 0)
      };
    }

    function stackEntryCreatesElevationSlot(entry) {
      if (!entry || entry.isAir || !entry.tool) {
        return false;
      }

      return isActorTool(entry.tool)
        ? actorToolLayerSlotHeight(entry.tool) > 0
        : terrainToolLayerSlotHeight(entry.tool) > 0;
    }

    function trimTrailingAirTokens(tokens) {
      while (tokens.length > 0 && String(tokens[tokens.length - 1] || "").trim().length === 0) {
        tokens.pop();
      }

      return tokens;
    }

    function isAirToken(token) {
      return String(token || "").trim().length === 0;
    }

    function isBaseSurfaceToken(token) {
      return isBaseSurfaceTool(resolveTool(String(token || "").trim()));
    }

    function actorPlacementValueForEmptyCell(currentValue, normalizedToken) {
      if (
        normalizeCellValue(currentValue) !== emptyCellToken ||
        !isActorTool(resolveTool(normalizedToken))
      ) {
        return null;
      }

      // The canonical empty cell is just the layer separator. Keep that
      // leading separator when placing an actor at elevation zero: it is the
      // explicit base-void marker that prevents the runtime from supplying
      // the legacy implicit floor beneath a bare actor token.
      return blockAdder + normalizedToken;
    }

    function normalizeTokenRows(tokens) {
      const trimmedTokens = trimTrailingAirTokens(tokens.slice());

      return normalizeCellValue(
        trimmedTokens.some((token) => !isAirToken(token))
          ? trimmedTokens.join(blockAdder)
          : emptyCellToken
      );
    }

    function enforceBottomSurfaceRows(tokens) {
      const rows = tokens.map((token) => String(token || "").trim());
      let bottomSurfaceToken = null;

      for (let index = 0; index < rows.length; index += 1) {
        if (!isBaseSurfaceToken(rows[index])) {
          continue;
        }

        bottomSurfaceToken = rows[index];
        rows[index] = "";
      }

      if (bottomSurfaceToken !== null) {
        if (isAirToken(rows[0])) {
          rows[0] = bottomSurfaceToken;
        } else {
          rows.unshift(bottomSurfaceToken);
        }
      }

      return trimTrailingAirTokens(rows);
    }

    function normalizeAuthoringCellValue(value) {
      const tokens = enforceBottomSurfaceRows(getCellTokens(normalizeCellValue(value)));

      return normalizeTokenRows(
        enforceBottomSurfaceRows(ensureMainPlayerSupportRows(tokens))
      );
    }

    function ensureMainPlayerSupportRows(tokens) {
      const rows = tokens.map((token) => String(token || "").trim());
      const hasMainPlayer = rows.some((token) =>
        isMainPlayerTool(resolveTool(token))
      );
      const hasExplicitSupport = rows.some((token) => isBaseSurfaceToken(token));
      const hasExplicitVoid = rows.some((token) => isAirToken(token));

      if (!hasMainPlayer || hasExplicitSupport || hasExplicitVoid) {
        return rows;
      }

      return [defaultFloorToken, ...rows];
    }

    function setBottomSurfaceToken(currentValue, token) {
      const normalizedToken = normalizeCellValue(token);

      if (!isBaseSurfaceToken(normalizedToken)) {
        return normalizeAuthoringCellValue(currentValue);
      }

      const tokens = enforceBottomSurfaceRows(getCellTokens(currentValue));

      if (tokens.length === 0) {
        tokens.push(normalizedToken);
      } else if (isAirToken(tokens[0])) {
        tokens[0] = normalizedToken;
      } else if (isBaseSurfaceToken(tokens[0])) {
        tokens[0] = normalizedToken;
      } else {
        tokens.unshift(normalizedToken);
      }

      return normalizeTokenRows(enforceBottomSurfaceRows(tokens));
    }

    function setAboveBottomRowToken(currentValue, token) {
      const normalizedToken = normalizeCellValue(token);

      if (isBaseSurfaceToken(normalizedToken)) {
        return setBottomSurfaceToken(currentValue, normalizedToken);
      }

      const emptyActorPlacement = actorPlacementValueForEmptyCell(
        currentValue,
        normalizedToken
      );

      if (emptyActorPlacement !== null) {
        return emptyActorPlacement;
      }

      const tokens = enforceBottomSurfaceRows(getCellTokens(currentValue));

      if (tokens.length === 0 || isAirToken(tokens[0])) {
        tokens[0] = normalizedToken;
        return normalizeTokenRows(enforceBottomSurfaceRows(tokens));
      }

      if (isBaseSurfaceToken(tokens[0])) {
        while (tokens.length < 2) {
          tokens.push("");
        }

        tokens[1] = normalizedToken;
      } else {
        tokens[0] = normalizedToken;
      }

      return normalizeTokenRows(enforceBottomSurfaceRows(tokens));
    }

    function appendCellToken(currentValue, token) {
      const normalizedToken = normalizeCellValue(token);

      if (isBaseSurfaceToken(normalizedToken)) {
        return setBottomSurfaceToken(currentValue, normalizedToken);
      }

      const emptyActorPlacement = actorPlacementValueForEmptyCell(
        currentValue,
        normalizedToken
      );

      if (emptyActorPlacement !== null) {
        return emptyActorPlacement;
      }

      const tokens = enforceBottomSurfaceRows(getCellTokens(currentValue));

      tokens.push(normalizedToken);

      return normalizeTokenRows(enforceBottomSurfaceRows(tokens));
    }

    function getCellDescriptor(value) {
      const tokens = getCellTokens(value);
      const topToken = tokens.slice().reverse().find((token) => token.length > 0) || "";
      const tool = resolveTool(topToken) || resolveTool(tokens[0]) || null;

      return {
        label: tool ? tool.label : topToken || "Empty",
        tool,
        topToken,
        tokens
      };
    }

    function isActorTool(tool) {
      return actorNames.has(toolType(tool));
    }

    function isMainPlayerTool(tool) {
      const type = toolType(tool);

      return type === "player" || type === "circle_player";
    }

    function isSurfaceAttachmentTool(tool) {
      return surfaceAttachmentNames.has(toolType(tool));
    }

    function isSupportActorTool(tool) {
      return supportActorNames.has(toolType(tool));
    }

    function isRaisedTerrainTool(tool) {
      const type = toolType(tool);

      return (
        raisedTerrainNames.has(type) ||
        (type === "player_lift" && tool?.initialRaised === true)
      );
    }

    function terrainToolStackHeight(tool) {
      return toolType(tool) === "tree" ? 3 : isRaisedTerrainTool(tool) ? 1 : 0;
    }

    function isBaseSurfaceTool(tool) {
      return baseSurfaceNames.has(toolType(tool));
    }

    function isAttachableSurfaceTool(tool) {
      if (!tool || isSurfaceAttachmentTool(tool)) {
        return false;
      }

      if (toolType(tool) === "ice_slope") {
        return false;
      }

      return isActorTool(tool) ? isSupportActorTool(tool) : true;
    }

    function setSurfaceAttachmentToken(currentValue, token, targetElevation) {
      const normalizedToken = normalizeCellValue(token);
      const attachmentTool = resolveTool(normalizedToken);

      if (!isSurfaceAttachmentTool(attachmentTool)) {
        return normalizeAuthoringCellValue(currentValue);
      }

      const elevation = Math.max(0, Math.floor(Number(targetElevation) || 0));
      const tokens = enforceBottomSurfaceRows(getCellTokens(currentValue));
      let surfaceHeight = null;
      let previousSurfaceTerrain = false;
      let insertionIndex = -1;

      for (let index = 0; index < tokens.length; index += 1) {
        const currentToken = String(tokens[index] || "").trim();

        if (currentToken.length === 0) {
          surfaceHeight = Math.max(0, surfaceHeight ?? 0) + 1;
          previousSurfaceTerrain = false;
          continue;
        }

        const tool = resolveTool(currentToken);

        if (!tool) {
          continue;
        }

        if (isActorTool(tool)) {
          const actorElevation = Math.max(0, surfaceHeight ?? 0);

          if (isSurfaceAttachmentTool(tool) && actorElevation === elevation) {
            tokens[index] = normalizedToken;
            return normalizeTokenRows(enforceBottomSurfaceRows(tokens));
          }

          if (isSupportActorTool(tool)) {
            const supportHeight = actorElevation + 1;

            if (supportHeight === elevation && isAttachableSurfaceTool(tool)) {
              insertionIndex = index + 1;
            }

            surfaceHeight = supportHeight;
            previousSurfaceTerrain = false;
          }

          surfaceHeight = Math.max(
            surfaceHeight ?? actorElevation,
            actorElevation + actorToolLayerSlotHeight(tool)
          );
          previousSurfaceTerrain = false;

          continue;
        }

        const isRaisedTerrain = isRaisedTerrainTool(tool);
        const isBaseSurface = isBaseSurfaceTool(tool);
        const stackHeight = terrainToolLayerSlotHeight(tool);
        let terrainElevation = Math.max(0, surfaceHeight ?? 0);

        if (isBaseSurface && !isRaisedTerrain && previousSurfaceTerrain && surfaceHeight !== null) {
          terrainElevation = surfaceHeight + 1;
        }

        const supportHeight = terrainElevation + stackHeight;

        if (supportHeight === elevation && isAttachableSurfaceTool(tool)) {
          insertionIndex = index + 1;
        }

        surfaceHeight = supportHeight;
        previousSurfaceTerrain = isBaseSurface;
      }

      if (insertionIndex === -1) {
        return normalizeAuthoringCellValue(currentValue);
      }

      tokens.splice(insertionIndex, 0, normalizedToken);
      return normalizeTokenRows(enforceBottomSurfaceRows(tokens));
    }

    function buildTerrainCell(type, tool = null, options = {}) {
      return {
        type,
        direction: tool?.direction || null,
        label: tool?.label || titleCaseName(type),
        imageUrl: tool?.imageUrl || null,
        modelUrl: tool?.modelUrl || null,
        layers: Array.isArray(options.layers) ? options.layers : null,
        underlay: options.underlay || null,
        raised: options.raised === true
      };
    }

    function buildTerrainLayer(tool, elevation) {
      const type = toolType(tool);

      return {
        type,
        label: tool?.label || titleCaseName(type),
        imageUrl: tool?.imageUrl || null,
        modelUrl: tool?.modelUrl || null,
        direction: tool?.direction || null,
        styleKey: tool?.styleKey || null,
        elevation,
        raised: type === "player_lift" ? tool?.initialRaised === true : false
      };
    }

    function buildCellStack(entries) {
      const floorTool = toolByName.get("floor") || null;
      const exitTool = toolByName.get("exit") || null;
      const terrainLayers = [];
      const actors = [];
      let surfaceHeight = null;
      let previousSurfaceTerrain = false;
      let hasAirEntry = false;
      let consumedBaseVoid = false;

      let previousCarrier = false;

      entries.forEach((entry) => {
        if (entry?.isAir) {
          hasAirEntry = true;
          previousCarrier = false;

          if (surfaceHeight === null && !consumedBaseVoid) {
            consumedBaseVoid = true;
            previousSurfaceTerrain = false;
            return;
          }

          surfaceHeight = Math.max(0, surfaceHeight ?? 0) + 1;
          consumedBaseVoid = true;
          previousSurfaceTerrain = false;
          return;
        }

        const tool = entry;

        if (isActorTool(tool)) {
          const elevation = Math.max(0, surfaceHeight ?? 0);

          actors.push({
            elevation,
            tool
          });

          surfaceHeight = elevation + actorToolLayerSlotHeight(tool);
          previousSurfaceTerrain = false;
          previousCarrier =
            toolType(tool) === "weightless_box" || toolType(tool) === "clone";

          return;
        }

        // Owner rule (2026-07): a lift/gate stacked directly on a movable
        // carrier becomes a stuck rider ACTOR (attached_lift / attached_gate)
        // that travels with the carrier and does not interact with it.
        const stackedDeviceType = toolType(tool);

        if (
          (stackedDeviceType === "player_lift" || stackedDeviceType === "player_gate") &&
          previousCarrier
        ) {
          const elevation = Math.max(0, surfaceHeight ?? 0);

          actors.push({
            elevation,
            tool: {
              ...tool,
              name: stackedDeviceType === "player_lift" ? "attached_lift" : "attached_gate",
              type: stackedDeviceType === "player_lift" ? "attached_lift" : "attached_gate"
            }
          });

          surfaceHeight = elevation + 1;
          previousSurfaceTerrain = false;
          previousCarrier = false;
          return;
        }

        const isRaisedTerrain = isRaisedTerrainTool(tool);
        const isBaseSurface = isBaseSurfaceTool(tool);
        const stackHeight = terrainToolLayerSlotHeight(tool);
        let elevation = Math.max(0, surfaceHeight ?? 0);

        if (isBaseSurface && !isRaisedTerrain && previousSurfaceTerrain && surfaceHeight !== null) {
          elevation = surfaceHeight + 1;
        }

        terrainLayers.push(buildTerrainLayer(tool, elevation));
        surfaceHeight = elevation + stackHeight;
        previousSurfaceTerrain = isBaseSurface;
        previousCarrier = toolType(tool) === "orange_wall";
      });

      const wallLayer = terrainLayers.find((layer) => layer.type === "wall") || null;
      const iceBlockLayer = terrainLayers.find((layer) => layer.type === "ice_block") || null;
      const iceSlopeLayer = terrainLayers.find((layer) => layer.type === "ice_slope") || null;
      const treeLayer = terrainLayers.find((layer) => layer.type === "tree") || null;
      const shrubLayer = terrainLayers.find((layer) => layer.type === "shrub") || null;
      const blockAssetLayer = terrainLayers.find((layer) => layer.type === "block_asset") || null;
      const raisedBlockLayer =
        wallLayer || iceBlockLayer || iceSlopeLayer || treeLayer || shrubLayer || blockAssetLayer;
      const exitLayer = terrainLayers.find((layer) => layer.type === "exit") || null;
      const topLayer =
        terrainLayers.length > 0
          ? terrainLayers.reduce((highest, layer) =>
              layer.elevation >= highest.elevation ? layer : highest
            )
          : null;
      const terrainLayer = raisedBlockLayer || exitLayer || topLayer || null;
      const terrainLayerTool = terrainLayer || null;
      const layers = terrainLayers.map((layer) => ({ ...layer }));

      if (raisedBlockLayer) {
        const underlayLayer =
          terrainLayers.find((layer) => layer.type !== raisedBlockLayer.type) || null;
        const underlayTool = underlayLayer || floorTool;

        return {
          actors,
          terrain: buildTerrainCell(raisedBlockLayer.type, raisedBlockLayer, {
            layers,
            underlay: buildTerrainCell(
              underlayLayer?.type || toolType(underlayTool) || "floor",
              underlayTool
            )
          })
        };
      }

      if (terrainLayer?.type === "exit") {
        return {
          actors,
          terrain: buildTerrainCell("exit", exitTool || terrainLayerTool || terrainLayer, {
            layers
          })
        };
      }

      if (terrainLayer) {
        const terrainType = terrainLayer.type;
        const tool = terrainLayerTool || terrainLayer;

        return {
          actors,
          terrain: buildTerrainCell(terrainType, tool, {
            layers,
            raised: terrainType === "player_lift" ? terrainLayer.raised === true : undefined
          })
        };
      }

      if (!hasAirEntry && actors.some(({ tool }) => !isSurfaceAttachmentTool(tool))) {
        return {
          actors,
          terrain: buildTerrainCell("floor", floorTool, {
            layers: [buildTerrainLayer(floorTool || { name: "floor", type: "floor" }, 0)]
          })
        };
      }

      return {
        actors,
        terrain: buildTerrainCell("empty", null, { layers: [] })
      };
    }

    function buildCellState(tools) {
      return buildCellStack(tools).terrain;
    }

    function setCellElevationToken(currentValue, token, targetElevation) {
      const normalizedToken = normalizeCellValue(token);
      const elevation = Math.max(0, Math.floor(Number(targetElevation) || 0));
      const tool = resolveTool(normalizedToken);
      const tokens = enforceBottomSurfaceRows(getCellTokens(currentValue));

      if (isBaseSurfaceTool(tool)) {
        return setBottomSurfaceToken(currentValue, normalizedToken);
      }

      if (elevation === 0) {
        return setAboveBottomRowToken(currentValue, normalizedToken);
      }

      let metadata = cellStackMetadata(tokens);
      const sameElevationEntries = metadata.entries.filter((entry) => entry.elevation === elevation);
      const matchingEntry = sameElevationEntries[0];

      if (matchingEntry) {
        tokens[matchingEntry.index] = normalizedToken;
        trimTrailingAirTokens(tokens);
        return normalizeTokenRows(enforceBottomSurfaceRows(tokens));
      }

      while (metadata.nextElevation < elevation) {
        tokens.push("");
        metadata = cellStackMetadata(tokens);
      }

      tokens.push(normalizedToken);

      return normalizeTokenRows(enforceBottomSurfaceRows(tokens));
    }

    // Brush painting is additive: an occupied voxel must survive a swipe.
    // Keep setCellElevationToken's explicit replacement semantics for raw
    // editing/solver code, and use this narrower helper for paint gestures.
    // Base floor/ice is support at elevation zero rather than an occupant,
    // while tall terrain (notably trees) reserves every voxel it spans.
    function placeCellElevationTokenIfVacant(currentValue, token, targetElevation) {
      const normalizedToken = normalizeCellValue(token);
      const elevation = Math.max(0, Math.floor(Number(targetElevation) || 0));
      const tool = resolveTool(normalizedToken);

      if (isBaseSurfaceTool(tool)) {
        return setCellElevationToken(currentValue, normalizedToken, elevation);
      }

      const emptyActorPlacement =
        elevation === 0
          ? actorPlacementValueForEmptyCell(currentValue, normalizedToken)
          : null;

      if (emptyActorPlacement !== null) {
        return emptyActorPlacement;
      }

      const tokens = enforceBottomSurfaceRows(getCellTokens(currentValue));
      const metadata = cellStackMetadata(tokens);
      const candidateHeight = isActorTool(tool)
        ? Math.max(1, actorToolLayerSlotHeight(tool))
        : Math.max(1, terrainToolLayerSlotHeight(tool));
      const candidateTop = elevation + candidateHeight;
      const occupied = metadata.entries.some((entry) => {
        if (entry.isAir || !entry.tool || isBaseSurfaceTool(entry.tool)) {
          return false;
        }

        const occupiedHeight = isActorTool(entry.tool)
          ? Math.max(1, actorToolLayerSlotHeight(entry.tool))
          : Math.max(1, terrainToolLayerSlotHeight(entry.tool));
        const occupiedTop = entry.elevation + occupiedHeight;

        return elevation < occupiedTop && candidateTop > entry.elevation;
      });

      if (occupied) {
        return normalizeAuthoringCellValue(currentValue);
      }

      // Prefer the explicit air row at the requested elevation. A tall token
      // then consumes the remaining air rows in its span so objects above it
      // keep their original elevation instead of being pushed upward.
      const targetAirEntry = metadata.entries.find(
        (entry) => entry.isAir && entry.elevation === elevation
      );
      let placementIndex;

      if (targetAirEntry) {
        placementIndex = targetAirEntry.index;
        tokens[placementIndex] = normalizedToken;
      } else {
        let nextElevation = metadata.nextElevation;

        while (nextElevation < elevation) {
          tokens.push("");
          nextElevation = cellStackMetadata(tokens).nextElevation;
        }

        placementIndex = tokens.length;
        tokens.push(normalizedToken);
      }

      metadata.entries
        .filter(
          (entry) =>
            entry.isAir &&
            entry.index !== placementIndex &&
            entry.elevation >= elevation &&
            entry.elevation < candidateTop
        )
        .map((entry) => entry.index)
        .sort((left, right) => right - left)
        .forEach((index) => tokens.splice(index, 1));

      return normalizeTokenRows(enforceBottomSurfaceRows(tokens));
    }

    function eraseCellElevationValue(currentValue, targetElevation) {
      const tokens = getCellTokens(currentValue);
      const elevation = Math.max(0, Math.floor(Number(targetElevation) || 0));
      const metadata = cellStackMetadata(tokens);
      const matchingEntry = metadata.entries
        .slice()
        .reverse()
        .find((entry) => !entry.isAir && entry.elevation === elevation);

      if (!matchingEntry) {
        return normalizeCellValue(currentValue);
      }

      const preserveImplicitPlayerFloor =
        isMainPlayerTool(matchingEntry.tool) &&
        !tokens.some((token) => isBaseSurfaceToken(token)) &&
        !tokens.some((token) => isAirToken(token));

      const hasNonAirAbove = metadata.entries.some(
        (entry) => !entry.isAir && entry.index > matchingEntry.index
      );

      if (
        hasNonAirAbove &&
        (stackEntryCreatesElevationSlot(matchingEntry) || isBaseSurfaceTool(matchingEntry.tool))
      ) {
        tokens[matchingEntry.index] = "";
      } else {
        tokens.splice(matchingEntry.index, 1);
      }

      trimTrailingAirTokens(tokens);

      if (preserveImplicitPlayerFloor && !tokens.some((token) => isBaseSurfaceToken(token))) {
        tokens.unshift(defaultFloorToken);
      }

      return normalizeAuthoringCellValue(
        tokens.some((token) => token.length > 0)
          ? tokens.join(blockAdder)
          : emptyCellToken
      );
    }

    function buildPlayData(options = {}) {
      const includeGems = options.includeGems !== false;
      const width = Math.max(1, Number(options.width) || 1);
      const height = Math.max(1, Number(options.height) || 1);
      const cells = Array.isArray(options.cells) ? options.cells : [];
      const terrain = [];
      const actors = [];

      for (let y = 0; y < height; y += 1) {
        const terrainRow = [];

        for (let x = 0; x < width; x += 1) {
          const entries = getCellStackEntries(cells[y]?.[x] ?? defaultFloorToken);
          const cellStack = buildCellStack(entries);

          terrainRow.push(cellStack.terrain);
          cellStack.actors.forEach(({ tool, elevation }) => {
            if (!includeGems && tool.name === "gem") {
              return;
            }

            actors.push({
              type: toolType(tool),
              groupId:
                toolType(tool) === "weightless_box" || toolType(tool) === "clone"
                  ? tool.groupId || tool.token
                  : null,
              label: tool.label,
              imageUrl: tool.imageUrl || null,
              modelUrl: tool.modelUrl || null,
              direction: tool.direction || null,
              shape: tool.shape || null,
              styleKey: tool.styleKey || null,
              // Attached lifts converted from 'L' keep their raised look.
              raised: tool.initialRaised === true,
              elevation,
              x,
              y
            });
          });
        }

        terrain.push(terrainRow);
      }

      return {
        gameId: options.gameId || authorData?.game?.id || "maze",
        playApiBaseUrl: options.playApiBaseUrl || authorData?.playApiBaseUrl || "",
        levelId: options.levelId || "__editor__",
        levelLabel: options.levelLabel || options.levelId || "__editor__",
        editorRender: options.editorRender === true,
        disableHorizontalNeighborFetches:
          options.disableHorizontalNeighborFetches === true,
        sourceFileName: options.sourceFileName || "",
        width,
        height,
        terrain,
        actors,
        cameraView: options.cameraView || null,
        worldColumns: options.worldColumns || null,
        worldRows: options.worldRows || null
      };
    }

    return {
      actorNames,
      buildCellState,
      buildPlayData,
      eraseCellElevationValue,
      getCellDescriptor,
      getCellTokens,
      getCellTools,
      appendCellToken,
      isActorTool,
      normalizeAuthoringCellValue,
      normalizeCellValue,
      placeCellElevationTokenIfVacant,
      setCellElevationToken,
      setSurfaceAttachmentToken,
      toolByName,
      toolByToken
    };
  }

  modules.createAdapter = createAdapter;
})();
