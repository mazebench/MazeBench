const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAZE_LEVEL_FILE_GUID_LENGTH = 10;
const MAZE_LEVEL_FILE_GUID_PATTERN = new RegExp(`^[a-z0-9]{${MAZE_LEVEL_FILE_GUID_LENGTH}}\\.txt$`);

function createMazeLevelService({
  buildGameAssetUrl,
  buildMazePreviewData,
  gamesDir,
  listTopLevelFiles,
  loadJson,
  loadText,
  resolveGameAssetPath,
  rootDir,
  titleCase,
  worldMaps
}) {
  const toolboxCatalog =
    loadJson(path.join(gamesDir, "maze", "toolbox.json"), { format: 1, tools: {} }) || {};
  const toolboxTools =
    toolboxCatalog.tools && typeof toolboxCatalog.tools === "object"
      ? toolboxCatalog.tools
      : {};

  function isMazeFamilyGame(game) {
    return Boolean(game?.worldMap) || worldMaps.isMazeFamilyGameId(game?.id);
  }

  function worldConfigFor(game) {
    return worldMaps.worldConfigForGame(game.id);
  }
  function normalizeMazeGuidFileName(fileName) {
    const trimmed = typeof fileName === "string" ? fileName.trim().toLowerCase() : "";
    return MAZE_LEVEL_FILE_GUID_PATTERN.test(trimmed) ? trimmed : "";
  }

  function generateMazeLevelGuid(length = MAZE_LEVEL_FILE_GUID_LENGTH) {
    let guid = "";

    while (guid.length < length) {
      guid += crypto
        .randomBytes(length)
        .toString("base64url")
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase();
    }

    return guid.slice(0, length);
  }

  function generateMazeLevelFileName(existingFileNames = []) {
    const takenFileNames =
      existingFileNames instanceof Set ? existingFileNames : new Set(existingFileNames);
    let fileName = "";

    do {
      fileName = `${generateMazeLevelGuid()}.txt`;
    } while (takenFileNames.has(fileName));

    return fileName;
  }

  function chooseMazeEditableFileName(game, levelId, preferredFileName = "") {
    const existingLevel = game?.worldMap?.byPosition?.get(levelId) || null;

    if (existingLevel) {
      return existingLevel.fileName;
    }

    const existingFileNames = new Set(Array.isArray(game?.levelFiles) ? game.levelFiles : []);

    // Non-master maze-family games (draft/online worlds) name level files after
    // their world slot so the directory stays readable and syncable.
    if (game?.id !== "maze") {
      const slotFileName = `${levelId}.txt`;

      if (!existingFileNames.has(slotFileName)) {
        return slotFileName;
      }
    }

    const normalizedPreferred = normalizeMazeGuidFileName(preferredFileName);

    if (normalizedPreferred && !existingFileNames.has(normalizedPreferred)) {
      return normalizedPreferred;
    }

    return generateMazeLevelFileName(existingFileNames);
  }

  function clampMazeLevelDimension(value, max, fallback) {
    const numericValue = Number(value);

    if (!Number.isInteger(numericValue)) {
      return fallback;
    }

    return Math.max(1, Math.min(max, numericValue));
  }

  function clampMazeLevelWidth(config, value, fallback = config.authorDefaultWidth) {
    return clampMazeLevelDimension(value, config.gridWidth, fallback);
  }

  function clampMazeLevelHeight(config, value, fallback = config.authorDefaultHeight) {
    return clampMazeLevelDimension(value, config.gridHeight, fallback);
  }

  function parseLevelRows(rawLevel) {
    return rawLevel.split(/\r?\n/).filter((row) => row.length > 0);
  }

  function parseLevelCells(parser, row) {
    const separator = parser?.rules?.separator;

    if (typeof separator === "string" && separator.length > 0) {
      return row.split(separator);
    }

    return Array.from(row);
  }

  function parseCellStack(parser, cell) {
    const blockAdder = parser?.rules?.block_adder;

    if (typeof blockAdder === "string" && blockAdder.length > 0) {
      return String(cell)
        .split(blockAdder)
        .map(normalizeLegacyMazeToken);
    }

    return cell ? [normalizeLegacyMazeToken(cell)] : [];
  }

  function normalizeLegacyMazeToken(token) {
    const trimmedToken = String(token ?? "").trim();
    return trimmedToken === "h" ? "" : trimmedToken;
  }

  function getDefinitionTokens(config) {
    if (typeof config?.token === "string" && config.token.length > 0) {
      return [config.token];
    }

    if (Array.isArray(config?.tokens)) {
      return config.tokens
        .map((entry) => (typeof entry === "string" ? entry : entry?.token))
        .filter((token) => typeof token === "string" && token.length > 0);
    }

    return [];
  }

  function getDefinitionTokenEntries(config) {
    if (typeof config?.token === "string" && config.token.length > 0) {
      return [
        {
          initialRaised: config.initial_raised === true,
          direction: typeof config.direction === "string" ? config.direction : null,
          label: typeof config.label === "string" ? config.label : null,
          selectable: typeof config.selectable === "boolean" ? config.selectable : null,
          styleKey: typeof config.style_key === "string" ? config.style_key : null,
          token: config.token
        }
      ];
    }

    if (!Array.isArray(config?.tokens)) {
      return [];
    }

    return config.tokens
      .map((entry) => {
        if (typeof entry === "string") {
          return {
            initialRaised: false,
            direction: null,
            label: null,
            selectable: null,
            token: entry
          };
        }

        return {
          initialRaised: entry?.initial_raised === true,
          direction: typeof entry?.direction === "string" ? entry.direction : null,
          label: typeof entry?.label === "string" ? entry.label : null,
          selectable: typeof entry?.selectable === "boolean" ? entry.selectable : null,
          styleKey: typeof entry?.style_key === "string" ? entry.style_key : null,
          token: entry?.token
        };
      })
      .filter((entry) => typeof entry.token === "string" && entry.token.length > 0);
  }

  function getObjectDefinitions(game) {
    const definitions = Object.entries(game.parser?.objects || {}).map(([name, config]) => {
      const relativeImagePath = typeof config?.image === "string" ? config.image : null;
      const assetPath = relativeImagePath ? resolveGameAssetPath(game.id, relativeImagePath) : null;
      const relativeModelPath = typeof config?.model === "string" ? config.model : null;
      const modelPath = relativeModelPath ? resolveGameAssetPath(game.id, relativeModelPath) : null;

      return {
        checkpointKind:
          config?.checkpoint_kind === "primary" || config?.checkpoint_kind === "secondary"
            ? config.checkpoint_kind
            : null,
        initialRaised: config?.initial_raised === true,
        name,
        tokens: getDefinitionTokens(config),
        tokenEntries: getDefinitionTokenEntries(config),
        imageUrl: assetPath ? buildGameAssetUrl(game.id, relativeImagePath) : null,
        modelUrl: modelPath ? buildGameAssetUrl(game.id, relativeModelPath) : null,
        label: typeof config?.label === "string" ? config.label : titleCase(name),
        type: typeof config?.type === "string" ? config.type : name
      };
    });

    const tokenPatterns = require("../public/maze-token-patterns");

    function resolveDefinitionForToken(byName, byToken, token) {
      const existing = byToken.get(token);

      if (existing) {
        return existing;
      }

      const pattern = tokenPatterns.resolvePatternToken(token);

      if (!pattern) {
        return undefined;
      }

      // Keep server-side save/play parsing in lockstep with the browser
      // adapter. Older draft parsers have plain ice_slope but predate the
      // orange_ice_slope definition; the pattern still carries the correct
      // orange terrain type/style and can safely inherit the plain slope's
      // common geometry metadata.
      const base =
        byName.get(pattern.family) ||
        byName.get(pattern.type) ||
        (pattern.family === "orange_ice_slope" ? byName.get("ice_slope") : null);

      if (!base) {
        return undefined;
      }

      const synthesized = {
        ...base,
        direction: pattern.direction,
        groupId: pattern.groupId || null,
        initialRaised: false,
        label: pattern.label,
        selectable: null,
        shape: pattern.shape || null,
        styleKey: pattern.styleKey,
        token: pattern.token,
        type: pattern.type
      };

      byToken.set(token, synthesized);
      return synthesized;
    }

    return {
      resolveToken(token) {
        return resolveDefinitionForToken(this.byName, this.byToken, token);
      },
      byName: new Map(definitions.map((definition) => [definition.name, definition])),
      byToken: new Map(
        definitions
          .flatMap((definition) =>
            definition.tokenEntries.map((entry) => [
              entry.token,
              {
                ...definition,
                direction: entry.direction,
                initialRaised: definition.initialRaised || entry.initialRaised,
                label: entry.label || definition.label,
                selectable: entry.selectable,
                styleKey: entry.styleKey || null,
                token: entry.token
              }
            ])
          )
      )
    };
  }

  function buildTerrainCell(type, definition = null, options = {}) {
    return {
      type,
      direction: definition?.direction || null,
      label: definition?.label || titleCase(type),
      imageUrl: definition?.imageUrl || null,
      modelUrl: definition?.modelUrl || null,
      layers: Array.isArray(options.layers) ? options.layers : null,
      underlay: options.underlay || null,
      raised: Boolean(options.raised)
    };
  }

  function definitionType(definition) {
    return definition?.type || definition?.name;
  }

  function checkpointKindForDefinition(definition) {
    const kind = definition?.checkpointKind;

    return kind === "primary" || kind === "secondary" ? kind : null;
  }

  function isCheckpointDefinition(definition) {
    return checkpointKindForDefinition(definition) !== null;
  }

  function isActorDefinition(definition) {
    const type = definitionType(definition);

    return (
      type === "player" ||
      type === "circle_player" ||
      type === "clone" ||
      type === "box" ||
      type === "gem" ||
      type === "floating_floor" ||
      type === "orange_button" ||
      type === "puncher" ||
      type === "weightless_box"
    );
  }

  function isSupportActorDefinition(definition) {
    const type = definitionType(definition);

    return (
      type === "player" ||
      type === "circle_player" ||
      type === "clone" ||
      type === "box" ||
      type === "floating_floor" ||
      type === "weightless_box"
    );
  }

  function isTerrainDefinition(definition) {
    return Boolean(definition) && !isActorDefinition(definition) && !isCheckpointDefinition(definition);
  }

  function isRaisedTerrainDefinition(definition) {
    const type = definitionType(definition);

    return (
      type === "wall" ||
      type === "ice_block" ||
      type === "ice_slope" ||
      type === "tree" ||
      type === "shrub" ||
      type === "block_asset" ||
      type === "orange_wall" ||
      (type === "player_lift" && definition?.initialRaised === true)
    );
  }

  function terrainDefinitionStackHeight(definition) {
    return definitionType(definition) === "tree" ? 3 : isRaisedTerrainDefinition(definition) ? 1 : 0;
  }

  // In maze level text, "+" is a layer separator. It advances the logical stack
  // even for thin/non-blocking objects so later tokens do not share their layer.
  function actorDefinitionLayerSlotHeight(definition) {
    return isActorDefinition(definition) ? 1 : 0;
  }

  function terrainDefinitionLayerSlotHeight(definition) {
    const type = definitionType(definition);

    if (type === "floor" || type === "ice") {
      return 0;
    }

    return Math.max(1, terrainDefinitionStackHeight(definition));
  }

  function isSurfaceAttachmentDefinition(definition) {
    return definitionType(definition) === "orange_button";
  }

  function buildTerrainLayer(definition, elevation) {
    const type = definitionType(definition);

    return {
      type,
      label: definition?.label || titleCase(type),
      imageUrl: definition?.imageUrl || null,
      modelUrl: definition?.modelUrl || null,
      direction: definition?.direction || null,
      styleKey: definition?.styleKey || null,
      elevation,
      raised: type === "player_lift" ? definition?.initialRaised === true : false
    };
  }

  function buildCellStack(cellDefinitions, floorDefinition, exitDefinition) {
    const terrainLayers = [];
    const actors = [];
    const checkpoints = [];
    let surfaceHeight = null;
    let previousSurfaceTerrain = false;
    let hasAirEntry = false;
    let consumedBaseVoid = false;

    let previousCarrier = false;

    cellDefinitions.forEach((definition) => {
      if (definition?.isAir) {
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

      const checkpointKind = checkpointKindForDefinition(definition);

      if (checkpointKind) {
        checkpoints.push({
          definition,
          elevation: Math.max(0, surfaceHeight ?? 0),
          kind: checkpointKind
        });

        // The existing `p` token remains the real player actor for backwards
        // compatibility. F2 is metadata only: it never enters terrain,
        // physics, or consumes a written stack slot.
        if (checkpointKind === "secondary") {
          previousSurfaceTerrain = false;
          previousCarrier = false;
          return;
        }
      }

      if (isActorDefinition(definition)) {
        const elevation = Math.max(0, surfaceHeight ?? 0);

        actors.push({
          definition,
          elevation
        });

        surfaceHeight = elevation + actorDefinitionLayerSlotHeight(definition);
        previousSurfaceTerrain = false;
        previousCarrier =
          definitionType(definition) === "weightless_box" ||
          definitionType(definition) === "clone";

        return;
      }

      if (!isTerrainDefinition(definition)) {
        return;
      }

      // Owner rule (2026-07): a lift or gate stacked directly on top of a
      // movable carrier (weightless box, clone, orange wall) is STUCK to it —
      // it becomes a rider ACTOR that travels with the carrier and does not
      // interact with it (no toggling, no gating, no blocking).
      const stackedDeviceType = definitionType(definition);

      if (
        (stackedDeviceType === "player_lift" || stackedDeviceType === "player_gate") &&
        previousCarrier
      ) {
        const elevation = Math.max(0, surfaceHeight ?? 0);

        actors.push({
          definition: {
            ...definition,
            name: stackedDeviceType === "player_lift" ? "attached_lift" : "attached_gate",
            type: stackedDeviceType === "player_lift" ? "attached_lift" : "attached_gate"
          },
          elevation
        });

        surfaceHeight = elevation + 1;
        previousSurfaceTerrain = false;
        previousCarrier = false;
        return;
      }

      const isRaisedTerrain = isRaisedTerrainDefinition(definition);
      const isBaseSurface = definitionType(definition) === "floor" || definitionType(definition) === "ice";
      const stackHeight = terrainDefinitionLayerSlotHeight(definition);
      let elevation = Math.max(0, surfaceHeight ?? 0);

      if (isBaseSurface && !isRaisedTerrain && previousSurfaceTerrain && surfaceHeight !== null) {
        elevation = surfaceHeight + 1;
      }

      terrainLayers.push(buildTerrainLayer(definition, elevation));
      surfaceHeight = elevation + stackHeight;
      previousSurfaceTerrain = isBaseSurface;
      previousCarrier = definitionType(definition) === "orange_wall";
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
    const layers = terrainLayers.map((layer) => ({ ...layer }));

    if (raisedBlockLayer) {
      const underlayLayer =
        terrainLayers.find((layer) => layer.type !== raisedBlockLayer.type) || null;
      const underlayDefinition = underlayLayer || floorDefinition || null;

      return {
        actors,
        checkpoints,
        terrain: buildTerrainCell(raisedBlockLayer.type, raisedBlockLayer, {
          layers,
          underlay: buildTerrainCell(
            underlayLayer?.type || definitionType(underlayDefinition) || "floor",
            underlayDefinition
          )
        })
      };
    }

    if (terrainLayer?.type === "exit") {
      return {
        actors,
        checkpoints,
        terrain: buildTerrainCell("exit", exitDefinition || terrainLayer, {
          layers
        })
      };
    }

    if (terrainLayer) {
      return {
        actors,
        checkpoints,
        terrain: buildTerrainCell(terrainLayer.type, terrainLayer, {
          layers,
          raised: terrainLayer.type === "player_lift" ? terrainLayer.raised === true : undefined
        })
      };
    }

    if (!hasAirEntry && actors.some(({ definition }) => !isSurfaceAttachmentDefinition(definition))) {
      return {
        actors,
        checkpoints,
        terrain: buildTerrainCell("floor", floorDefinition, {
          layers: [buildTerrainLayer(floorDefinition || { type: "floor", name: "floor" }, 0)]
        })
      };
    }

    return {
      actors,
      checkpoints,
      terrain: buildTerrainCell("empty", null, { layers: [] })
    };
  }

  function buildCellState(cellDefinitions, floorDefinition, exitDefinition) {
    return buildCellStack(cellDefinitions, floorDefinition, exitDefinition).terrain;
  }

  function getLevelState(game, level) {
    const levelPath = path.join(gamesDir, game.id, "levels", level.fileName);
    const rawLevel = loadText(levelPath, "");
    const rawRows = parseLevelRows(rawLevel).map((row) => parseLevelCells(game.parser, row));
    const definitions = getObjectDefinitions(game);
    const floorDefinition = definitions.byName.get("floor") || null;
    const exitDefinition = definitions.byName.get("exit") || null;
    const terrain = [];
    const actors = [];
    const checkpoints = [];
    const family = isMazeFamilyGame(game);
    const config = family ? worldConfigFor(game) : null;
    const rawWidth = rawRows.reduce((maxColumns, row) => Math.max(maxColumns, row.length), 0);
    // Maze-family boards use the level's own dimensions (master levels are all
    // exactly grid-sized; draft levels may be smaller). Empty or missing files
    // fall back to the full grid so unmapped world slots render as open rooms.
    const boardWidth = family
      ? rawRows.length > 0
        ? Math.min(config.gridWidth, rawWidth)
        : config.gridWidth
      : rawWidth;
    const boardHeight = family
      ? rawRows.length > 0
        ? Math.min(config.gridHeight, rawRows.length)
        : config.gridHeight
      : rawRows.length;

    Array.from({ length: boardHeight }, (_, y) => {
      const row = rawRows[y] || [];
      const terrainRow = [];

      Array.from({ length: boardWidth }, (_, index) => {
        const hasSourceCell = y < rawRows.length && index < row.length;
        const cell = hasSourceCell ? row[index] : "";
        const cellDefinitions = parseCellStack(game.parser, cell)
          .map((token) => {
            const normalizedToken = String(token).trim();
            return normalizedToken.length === 0 ? { isAir: true } : definitions.resolveToken(normalizedToken);
          })
          .filter(Boolean);
        const cellStack = hasSourceCell
          ? buildCellStack(cellDefinitions, floorDefinition, exitDefinition)
            : {
              actors: [],
              checkpoints: [],
              terrain: buildTerrainCell("floor", floorDefinition)
            };

        terrainRow.push(cellStack.terrain);

        const cellCheckpointIds = new Map();
        cellStack.checkpoints.forEach(({ elevation, kind }) => {
          const id =
            kind === "primary"
              ? `${level.id}:checkpoint:primary`
              : `${level.id}:checkpoint:secondary:${index}:${y}:${elevation}`;

          cellCheckpointIds.set(kind, id);
          checkpoints.push({
            id,
            kind,
            x: index,
            y,
            elevation,
            active: false,
            userPlaced: false
          });
        });

        cellStack.actors.forEach(({ definition, elevation }) => {
          const actor = {
            type: definitionType(definition),
            groupId:
              definitionType(definition) === "weightless_box" ||
              definitionType(definition) === "clone"
                ? definition.groupId || definition.token
                : null,
            label: definition.label,
            imageUrl: definition.imageUrl,
            modelUrl: definition.modelUrl,
            direction: definition.direction || null,
            shape: definition.shape || null,
            styleKey: definition.styleKey || null,
            // Attached lifts converted from 'L' keep their raised look.
            raised: definition.initialRaised === true,
            elevation,
            x: index,
            y
          };

          if (checkpointKindForDefinition(definition) === "primary") {
            actor.primaryCheckpointId = cellCheckpointIds.get("primary") || `${level.id}:checkpoint:primary`;
            actor.isPrimaryCheckpointSpawn = true;
          }

          actors.push(actor);
        });
      });

      terrain.push(terrainRow);
    });

    return {
      gameId: game.id,
      levelId: level.id,
      levelLabel: level.label,
      sourceFileName: level.fileName,
      width: boardWidth,
      height: boardHeight,
      terrain,
      actors,
      checkpoints,
      cameraView: family
        ? {
            width: config.cameraView.width,
            height: config.cameraView.height
          }
        : null,
      worldColumns: family ? config.worldColumns : null,
      worldRows: family ? config.worldRows : null
    };
  }

  function getLevelFilePath(game, level) {
    return path.join(gamesDir, game.id, "levels", level.fileName);
  }

  function buildBlankEditorCells(width, height, fillToken) {
    return Array.from({ length: height }, () => Array.from({ length: width }, () => fillToken));
  }

  function serializeEditorCells(parser, cells) {
    const separator =
      typeof parser?.rules?.separator === "string" && parser.rules.separator.length > 0
        ? parser.rules.separator
        : " ";

    return cells.map((row) => row.join(separator)).join("\n");
  }

  function normalizeEditorCellValue(game, definitions, cell, floorToken) {
    const blockAdder =
      typeof game.parser?.rules?.block_adder === "string" && game.parser.rules.block_adder.length > 0
        ? game.parser.rules.block_adder
        : "+";
    const emptyCellToken = blockAdder;
    const trimmedCell = String(cell ?? "").trim();

    if (!trimmedCell) {
      return emptyCellToken;
    }

    const tokens = parseCellStack(game.parser, trimmedCell).map((token) => String(token).trim());

    if (tokens.length === 0 || tokens.every((token) => token.length === 0)) {
      return emptyCellToken;
    }

    const invalidToken = tokens.find(
      (token) => token.length > 0 && !definitions.resolveToken(token)
    );

    if (invalidToken) {
      throw new Error(`Unknown token "${invalidToken}".`);
    }

    return tokens.join(blockAdder);
  }

  function getLevelEditorState(game, level) {
    const levelPath = getLevelFilePath(game, level);
    const config = worldConfigFor(game);
    const definitions = getObjectDefinitions(game);
    const floorToken = definitions.byName.get("floor")?.tokens?.[0] || ".";
    const rawLevel = loadText(levelPath, "");
    const rawRows = parseLevelRows(rawLevel).map((row) => parseLevelCells(game.parser, row));
    const exists = fs.existsSync(levelPath);
    const width = exists
      ? clampMazeLevelWidth(
          config,
          rawRows.reduce((maxColumns, row) => Math.max(maxColumns, row.length), 0)
        )
      : config.authorDefaultWidth;
    const height = exists
      ? clampMazeLevelHeight(config, rawRows.length)
      : config.authorDefaultHeight;
    const cells =
      exists && rawRows.length > 0
        ? Array.from({ length: height }, (_, y) =>
            Array.from({ length: width }, (_, x) =>
              normalizeEditorCellValue(game, definitions, rawRows[y]?.[x] ?? floorToken, floorToken)
            )
          )
        : buildBlankEditorCells(width, height, floorToken);

    return {
      cells,
      exists,
      fileName: level.fileName,
      filePath: path.relative(rootDir, levelPath).replace(/\\/g, "/"),
      height,
      levelId: level.id,
      label: level.label,
      previewUrl: isMazeFamilyGame(game) ? buildMazePreviewData(game, level.fileName).previewUrl : null,
      rawText: serializeEditorCells(game.parser, cells),
      width
    };
  }

  function sanitizeEditorPayload(game, payload) {
    if (!Array.isArray(payload?.cells)) {
      throw new Error("Level payload must include a cells array.");
    }

    const config = worldConfigFor(game);
    const definitions = getObjectDefinitions(game);
    const floorToken = definitions.byName.get("floor")?.tokens?.[0] || ".";
    const width = clampMazeLevelWidth(config, payload?.width);
    const height = clampMazeLevelHeight(config, payload?.height);
    const cells = Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) =>
        normalizeEditorCellValue(game, definitions, payload.cells?.[y]?.[x] ?? floorToken, floorToken)
      )
    );
    const floorDefinition = definitions.byName.get("floor") || null;
    const exitDefinition = definitions.byName.get("exit") || null;
    let primaryCheckpointCount = 0;

    cells.forEach((row, y) => {
      row.forEach((cell, x) => {
        const cellDefinitions = parseCellStack(game.parser, cell)
          .map((token) => {
            const normalizedToken = String(token).trim();
            return normalizedToken.length === 0
              ? { isAir: true }
              : definitions.resolveToken(normalizedToken);
          })
          .filter(Boolean);
        const cellStack = buildCellStack(cellDefinitions, floorDefinition, exitDefinition);

        primaryCheckpointCount += cellStack.checkpoints.filter(
          (checkpoint) => checkpoint.kind === "primary"
        ).length;

        cellStack.checkpoints
          .filter((checkpoint) => checkpoint.kind === "secondary")
          .forEach((checkpoint) => {
            const validSupport = (cellStack.terrain.layers || []).some((layer) => {
              if ((layer.type === "floor" || layer.type === "ice") && layer.elevation === checkpoint.elevation) {
                return true;
              }

              return (
                (layer.type === "wall" || layer.type === "ice_block") &&
                layer.elevation + 1 === checkpoint.elevation
              );
            });
            const actorConflict = cellStack.actors.some(
              (actor) => actor.elevation === checkpoint.elevation
            );
            const terrainConflict = (cellStack.terrain.layers || []).some((layer) => {
              if (layer.type === "floor" || layer.type === "ice") {
                return false;
              }

              if (
                (layer.type === "wall" || layer.type === "ice_block") &&
                layer.elevation + 1 === checkpoint.elevation
              ) {
                return false;
              }

              const height = layer.type === "tree" ? 3 : 1;
              return (
                checkpoint.elevation >= layer.elevation &&
                checkpoint.elevation < layer.elevation + height
              );
            });
            const checkpointConflict =
              cellStack.checkpoints.filter(
                (candidate) => candidate.elevation === checkpoint.elevation
              ).length > 1;

            if (!validSupport || actorConflict || terrainConflict || checkpointConflict) {
              throw new Error(
                `Secondary checkpoint at ${x},${y},${checkpoint.elevation} must stand alone on floor, wall, ice, or ice block.`
              );
            }
          });
      });
    });

    if (primaryCheckpointCount > 1) {
      throw new Error("A room may contain only one primary checkpoint.");
    }

    return {
      cells,
      height,
      rawText: serializeEditorCells(game.parser, cells),
      width
    };
  }

  function buildAuthorPalette(game) {
    const definitions = getObjectDefinitions(game);
    const palette = [];

    Object.entries(game.parser?.objects || {}).forEach(([name, config]) => {
      const definition = definitions.byName.get(name);

      definition.tokenEntries.forEach((entry) => {
        const toolboxTool = toolboxTools[entry.token] || {};
        palette.push({
          demo:
            toolboxTool.demo && typeof toolboxTool.demo === "object"
              ? toolboxTool.demo
              : null,
          description:
            typeof toolboxTool.description === "string" ? toolboxTool.description : null,
          imageUrl: definition?.imageUrl || null,
          modelUrl: definition?.modelUrl || null,
          label:
            (typeof toolboxTool.name === "string" && toolboxTool.name) ||
            entry.label ||
            (definition.tokenEntries.length > 1
              ? `${definition?.label || titleCase(name)} ${entry.token}`
              : definition?.label || titleCase(name)),
          initialRaised: definition.initialRaised || entry.initialRaised,
          checkpointKind: definition.checkpointKind || null,
          name,
          selectable:
            config?.selectable !== false &&
            entry.selectable !== false &&
            name !== "circle_player" &&
            name !== "exit" &&
            name !== "hole",
          styleKey: entry.styleKey || null,
          token: entry.token,
          type: definition.type,
          direction: entry.direction || null
        });
      });
    });

    return palette;
  }

  function buildAuthorPageData(game, level) {
    const config = worldConfigFor(game);
    const definitions = getObjectDefinitions(game);
    const floorToken = definitions.byName.get("floor")?.tokens?.[0] || ".";
    const wallToken = definitions.byName.get("wall")?.tokens?.[0] || floorToken;
    const initialLevel = getLevelEditorState(game, level);

    return {
      authorApiBaseUrl: `/api/author/${encodeURIComponent(game.id)}`,
      blockAdder:
        typeof game.parser?.rules?.block_adder === "string" && game.parser.rules.block_adder.length > 0
          ? game.parser.rules.block_adder
          : "+",
      clientPreviewPersistence: true,
      defaultFloorToken: floorToken,
      defaultLevelId: worldMaps.defaultLevelIdForGame(game),
      defaultHeight: config.authorDefaultHeight,
      defaultWidth: config.authorDefaultWidth,
      defaultWallToken: wallToken,
      existingLevels: game.levels
        .filter((candidate) => worldMaps.isMazeWorldLevelId(game.id, candidate.id))
        .map((candidate) => {
          const editorLevel = getLevelEditorState(game, candidate);
          return {
            authorUrl: `/author/${encodeURIComponent(game.id)}/${encodeURIComponent(candidate.id)}`,
            cells: editorLevel.cells,
            height: editorLevel.height,
            id: candidate.id,
            label: candidate.label,
            playUrl: `/play/${encodeURIComponent(game.id)}/${encodeURIComponent(candidate.id)}`,
            previewUrl: candidate.previewUrl || editorLevel.previewUrl || null,
            width: editorLevel.width
          };
        }),
      game: {
        id: game.id,
        name: game.name
      },
      initialLevel,
      previewApiBaseUrl: `/api/author/${encodeURIComponent(game.id)}`,
      roomSwapApiUrl: `/api/world-map/${encodeURIComponent(game.id)}/swap`,
      solutionExportApiUrl: `/api/author/${encodeURIComponent(game.id)}`,
      worldColumns: config.worldColumns,
      worldRows: config.worldRows,
      maxBoardHeight: config.gridHeight,
      maxBoardWidth: config.gridWidth,
      palette: buildAuthorPalette(game),
      toolboxCatalog,
      separator:
        typeof game.parser?.rules?.separator === "string" && game.parser.rules.separator.length > 0
          ? game.parser.rules.separator
          : " "
    };
  }

  function listGames() {
    if (!fs.existsSync(gamesDir)) {
      return [];
    }

    return fs
      .readdirSync(gamesDir, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isDirectory()) {
          return false;
        }

        const gameDir = path.join(gamesDir, entry.name);
        return fs.existsSync(path.join(gameDir, "levels")) && fs.existsSync(path.join(gameDir, "level_parsing.json"));
      })
      .map((entry) => getGame(entry.name))
      .filter(Boolean);
  }

  const gameCache = new Map();

  function appendPathStatSignature(parts, targetPath) {
    let stats = null;

    try {
      stats = fs.statSync(targetPath);
    } catch (error) {
      stats = null;
    }

    parts.push(stats ? `${targetPath}:${stats.mtimeMs}:${stats.size}` : `${targetPath}:missing`);
  }

  function buildGameCacheSignature(gameId) {
    const gameDir = path.join(gamesDir, gameId);
    const previewsDir = path.join(gameDir, "previews");
    const parts = [];

    appendPathStatSignature(parts, gameDir);
    appendPathStatSignature(parts, path.join(gameDir, "levels"));
    appendPathStatSignature(parts, path.join(gameDir, "level_parsing.json"));
    appendPathStatSignature(parts, path.join(gameDir, "draft.json"));
    appendPathStatSignature(parts, path.join(gameDir, "player.py"));
    appendPathStatSignature(parts, path.join(gameDir, "world_map.json"));
    appendPathStatSignature(parts, path.join(gameDir, "world_parsing.json"));
    appendPathStatSignature(parts, previewsDir);
    listTopLevelFiles(previewsDir).forEach((fileName) => {
      appendPathStatSignature(parts, path.join(previewsDir, fileName));
    });

    return parts.join("|");
  }

  function getGame(gameId) {
    const signature = buildGameCacheSignature(gameId);
    const cached = gameCache.get(gameId);

    if (cached && cached.signature === signature) {
      return cached.game;
    }

    const game = buildGame(gameId);

    if (!game) {
      gameCache.delete(gameId);
      return null;
    }

    gameCache.set(gameId, { game, signature });
    return game;
  }

  function buildGame(gameId) {
    const gameDir = path.join(gamesDir, gameId);
    const levelsDir = path.join(gameDir, "levels");
    const parserPath = path.join(gameDir, "level_parsing.json");

    if (!fs.existsSync(gameDir) || !fs.existsSync(levelsDir) || !fs.existsSync(parserPath)) {
      return null;
    }

    const levelFiles = listTopLevelFiles(levelsDir);
    const draftMeta = loadJson(path.join(gameDir, "draft.json"), null);
    // The master maze IS the benchmark world; name it accordingly everywhere.
    const name =
      gameId === "maze"
        ? "Maze Bench Environment"
        : typeof draftMeta?.title === "string" && draftMeta.title.trim()
          ? draftMeta.title.trim()
          : titleCase(gameId);
    const baseGame = {
      id: gameId,
      levelFiles,
      name,
      draft: draftMeta || null,
      player: fs.existsSync(path.join(gameDir, "player.py")) ? "Python Player" : "Unknown Player",
      parser: loadJson(parserPath, {}),
      parserUrl: `/games/${gameId}/level_parsing.json`
    };

    if (worldMaps.isMazeFamilyGameId(gameId)) {
      const worldMap = worldMaps.buildMazeWorldMapState(baseGame);

      return {
        ...baseGame,
        levels: worldMap.levels,
        worldMap
      };
    }

    return {
      ...baseGame,
      levels: levelFiles.map((fileName) => {
        const levelId = path.parse(fileName).name;
        const match = fileName.match(/(\d+)/);
        const number = match ? Number(match[1]) : levelId;
        const label = typeof number === "number" ? `Level ${number}` : `Level ${levelId}`;
        return {
          fileName,
          id: levelId,
          number,
          label,
          playUrl: `/play/${gameId}/${levelId}`
        };
      })
    };
  }

  function findExistingLevel(game, levelId) {
    return isMazeFamilyGame(game)
      ? game.worldMap?.byPosition?.get(levelId) || null
      : game.levels.find((level) => level.id === levelId) || null;
  }

  function getLevel(game, levelId) {
    const requestedLevelId =
      typeof levelId === "string" && levelId.length > 0
        ? levelId
        : worldMaps.defaultLevelIdForGame(game);
    const existingLevel = findExistingLevel(game, requestedLevelId);

    if (existingLevel) {
      return existingLevel;
    }

    if (isMazeFamilyGame(game) && worldMaps.isMazeWorldLevelId(game.id, requestedLevelId)) {
      const fallbackFileName = worldMaps.buildMazeFallbackLevelFileName(
        game.id,
        requestedLevelId,
        game.levelFiles,
        game.worldMap
      );
      return worldMaps.buildMazeWorldLevel(game.id, requestedLevelId, {
        fileName: fallbackFileName,
        previewUrl: buildMazePreviewData(game, fallbackFileName).previewUrl
      });
    }

    return null;
  }

  function getEditableLevel(game, levelId, preferredFileName = "") {
    const requestedLevelId =
      typeof levelId === "string" && levelId.length > 0
        ? levelId
        : worldMaps.defaultLevelIdForGame(game);
    const existingLevel = findExistingLevel(game, requestedLevelId);

    if (existingLevel) {
      return existingLevel;
    }

    if (isMazeFamilyGame(game) && worldMaps.isMazeWorldLevelId(game.id, requestedLevelId)) {
      const editableFileName = chooseMazeEditableFileName(game, requestedLevelId, preferredFileName);
      return worldMaps.buildMazeWorldLevel(game.id, requestedLevelId, {
        fileName: editableFileName,
        previewUrl: buildMazePreviewData(game, editableFileName).previewUrl
      });
    }

    return null;
  }

  return {
    buildAuthorPageData,
    getEditableLevel,
    getGame,
    getLevel,
    getLevelEditorState,
    getLevelFilePath,
    getLevelState,
    listGames,
    sanitizeEditorPayload
  };
}

module.exports = {
  createMazeLevelService
};
