const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawnSync } = require("child_process");
const { promisify } = require("util");
const { createAgentRunService, enrichedPathEnv } = require("./agent-runs");
const { createTrainingService } = require("./training");
const { createLocalBuildWorldService } = require("./build-worlds-local");
const { createRemoteService } = require("./remote");
const { createMazeLevelService } = require("./maze-levels");
const { createMazePreviewService } = require("./maze-preview");
const { createMazeWorldMapService } = require("./maze-world-map");
const { createPageRenderer } = require("./pages");
const { createRequestRouter } = require("./router");
const { createSolverExportService } = require("./solver-exports");
const {
  ensureDirectory,
  getContentType,
  listTopLevelFiles,
  loadJson,
  loadText,
  titleCase
} = require("./support");

const ROOT_DIR = path.resolve(__dirname, "..");
const GAMES_DIR = path.join(ROOT_DIR, "games");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const execFileAsync = promisify(execFile);
const PUBLIC_FILE_ROUTES = new Map(
  [
    "/styles.css",
    "/play.js",
    "/play-rules.js",
    "/play-core.js",
    "/play-render-effects.js",
    "/play-render-terrain.js",
    "/play-render-actors.js",
    "/play-render-three.js",
    "/play-render-compositor.js",
    "/play-render.js",
    "/play-movement.js",
    "/play-world-transitions.js",
    "/play-gameplay.js",
    "/flyover.js",
    "/maze-engine.js",
    "/maze-solver.js",
    "/world-solver.js",
    "/world-solver-worker.js",
    "/maze-token-patterns.js",
    "/author-play-data.js",
    "/author-solver-worker.js",
    "/author-shell.js",
    "/author.js",
    "/world-map.js",
    "/level-preview.js",
    "/build.js",
    "/agent.js",
    "/agent-run.js",
    "/train.js",
    "/site.css",
    "/build-theme.css",
    "/author-theme.css",
    "/play-theme.css",
    "/local-site.css",
    "/favicon.svg",
    "/logos/codex.png",
    "/logos/claude.png",
    "/logos/kimi.svg",
    "/logos/prime.png"
  ].map((routePath) => [routePath, path.join(PUBLIC_DIR, routePath.slice(1))])
);

// Vendor JS ships from node_modules in a checkout; the packaged runtime that
// `pip install mazebench` unpacks has no node_modules, so scripts/
// build-python-runtime.js stages the same files under vendor/ instead.
function vendorFilePath(nodeModulesRelative, vendorName) {
  const nodeModulesPath = path.join(ROOT_DIR, "node_modules", ...nodeModulesRelative);

  if (fs.existsSync(nodeModulesPath)) {
    return nodeModulesPath;
  }

  return path.join(ROOT_DIR, "vendor", vendorName);
}

PUBLIC_FILE_ROUTES.set(
  "/vendor/three.module.js",
  vendorFilePath(["three", "build", "three.module.js"], "three.module.js")
);
PUBLIC_FILE_ROUTES.set(
  "/vendor/three.core.js",
  vendorFilePath(["three", "build", "three.core.js"], "three.core.js")
);
PUBLIC_FILE_ROUTES.set(
  "/vendor/GLTFLoader.js",
  vendorFilePath(["three", "examples", "jsm", "loaders", "GLTFLoader.js"], "GLTFLoader.js")
);
// GLTFLoader's relative "../utils/x.js" imports resolve against /vendor/.
PUBLIC_FILE_ROUTES.set(
  "/utils/BufferGeometryUtils.js",
  vendorFilePath(["three", "examples", "jsm", "utils", "BufferGeometryUtils.js"], "BufferGeometryUtils.js")
);
PUBLIC_FILE_ROUTES.set(
  "/utils/SkeletonUtils.js",
  vendorFilePath(["three", "examples", "jsm", "utils", "SkeletonUtils.js"], "SkeletonUtils.js")
);

function buildGameAssetUrl(gameId, relativePath) {
  const encodedPath = relativePath
    .split(/[\\/]/)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `/assets/${encodeURIComponent(gameId)}/${encodedPath}`;
}

function resolveGameAssetPath(gameId, relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    return null;
  }

  const gameDir = path.resolve(GAMES_DIR, gameId);
  const assetPath = path.resolve(gameDir, relativePath);
  const gameDirPrefix = `${gameDir}${path.sep}`;

  if (assetPath !== gameDir && !assetPath.startsWith(gameDirPrefix)) {
    return null;
  }

  if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
    return null;
  }

  return assetPath;
}

const mazePreviewService = createMazePreviewService({
  buildGameAssetUrl,
  ensureDirectory,
  gamesDir: GAMES_DIR
});

const {
  buildMazePreviewData,
  writeMazePreviewImageData
} = mazePreviewService;

const worldMaps = createMazeWorldMapService({
  buildMazePreviewData,
  listTopLevelFiles,
  loadJson,
  gamesDir: GAMES_DIR
});

const {
  buildMazeWorldMapEditorData,
  defaultLevelIdForGame
} = worldMaps;

const mazeLevelService = createMazeLevelService({
  buildGameAssetUrl,
  buildMazePreviewData,
  gamesDir: GAMES_DIR,
  listTopLevelFiles,
  loadJson,
  loadText,
  resolveGameAssetPath,
  rootDir: ROOT_DIR,
  titleCase,
  worldMaps
});

const {
  buildAuthorPageData,
  getEditableLevel,
  getGame,
  getLevel,
  getLevelEditorState,
  getLevelFilePath,
  getLevelState,
  listGames,
  sanitizeEditorPayload
} = mazeLevelService;

function buildGameWorldBundle(gameId = "maze") {
  const game = getGame(gameId);

  if (!game?.worldMap) {
    throw new Error(`"${gameId}" is not a world game.`);
  }

  const defaultLevelId = defaultLevelIdForGame(game);
  const levels = game.worldMap.levels.map((level) => ({
    column: level.column,
    fileName: level.fileName,
    id: level.id,
    label: level.label,
    row: level.row
  }));
  const levelStates = Object.fromEntries(
    game.worldMap.levels.map((level) => [level.id, getLevelState(game, level)])
  );
  const worldRevision = crypto
    .createHash("sha256")
    .update(JSON.stringify({ defaultLevelId, levels, levelStates }))
    .digest("hex");

  return {
    defaultLevelId,
    game: { id: game.id, name: game.name },
    levels,
    levelStates,
    worldRevision
  };
}

const buildWorlds = createLocalBuildWorldService({
  gamesDir: GAMES_DIR,
  getGame,
  getLevelEditorState,
  listTopLevelFiles,
  loadJson,
  sanitizeEditorPayload,
  worldMaps
});

const agentRuns = createAgentRunService({
  agentEnvironment,
  agentEnvironmentAsync,
  syncPrimeEvaluations: true,
  buildWorlds,
  ensureDirectory,
  getGame,
  loadJson,
  rootDir: ROOT_DIR,
  worldMaps
});

const training = createTrainingService({
  buildWorlds,
  getGame,
  rootDir: ROOT_DIR,
  worldMaps
});

const remote = createRemoteService({
  buildWorlds,
  ensureDirectory,
  getGame,
  loadJson,
  rootDir: ROOT_DIR
});

const solverExports = createSolverExportService({
  env: enrichedPathEnv(),
  rootDir: ROOT_DIR
});

// Prime agent runs need Prime and uv. Docker is still reported separately for
// local container-mode runs.
let agentEnvironmentCache = null;
let agentEnvironmentPromise = null;

// A container run needs BOTH the docker binary AND a reachable daemon. Report
// them separately so the UI can say "install Docker" vs "start Docker".
function dockerState() {
  const installed =
    spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8", env: enrichedPathEnv() }).status === 0;

  if (!installed) {
    return { installed: false, running: false };
  }

  // `docker info` fails fast when the daemon is down; the format keeps it tiny.
  const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    env: enrichedPathEnv(),
    timeout: 8000
  });
  const version = String(info.stdout || "").trim();
  const running = info.status === 0 && version.length > 0 && version !== "<no value>";

  return { installed: true, running };
}

function agentEnvironment(options = {}) {
  if (!options.fresh && agentEnvironmentCache && Date.now() - agentEnvironmentCache.at < 15000) {
    return agentEnvironmentCache.value;
  }

  // Page HTML should never wait on Docker or provider login probes. The Agent
  // client refreshes this asynchronously after first paint.
  if (options.cachedOnly) {
    return agentEnvironmentCache?.value || { checking: true };
  }

  const probe = (bin) =>
    spawnSync("sh", ["-c", `command -v ${JSON.stringify(bin)}`], {
      encoding: "utf8",
      env: enrichedPathEnv()
    }).status === 0;
  const probeCommand = (bin, args, timeout = 5000) =>
    spawnSync(bin, args, {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout,
      maxBuffer: 2 * 1024 * 1024
    });
  const primeInstalled = probe("prime");
  // An API key can remain in the environment after it expires. Ask Prime to
  // validate the current credentials instead of treating presence as proof.
  const primeAuthenticated =
    primeInstalled && probeCommand("prime", ["whoami"], 8000).status === 0;
  const docker = dockerState();
  const value = {
    checking: false,
    // `docker` means "ready for a container run" — installed AND daemon up.
    docker: docker.running,
    docker_installed: docker.installed,
    docker_running: docker.running,
    // Prime v1 evals run via `uv run eval`; the `prime` CLI is only needed for
    // the model catalog / login, so `uv` is what gates launching a Prime run.
    prime: primeInstalled && primeAuthenticated,
    prime_installed: primeInstalled,
    prime_authenticated: primeAuthenticated,
    uv: probe("uv")
  };

  agentEnvironmentCache = { at: Date.now(), value };
  return value;
}

async function agentEnvironmentAsync(options = {}) {
  if (!options.fresh && agentEnvironmentCache && Date.now() - agentEnvironmentCache.at < 15000) {
    return agentEnvironmentCache.value;
  }
  if (agentEnvironmentPromise) return agentEnvironmentPromise;

  const commandExists = async (bin) => {
    try {
      await execFileAsync("sh", ["-c", "command -v \"$1\"", "sh", bin], {
        encoding: "utf8",
        env: enrichedPathEnv(),
        timeout: 3000
      });
      return true;
    } catch (_error) {
      return false;
    }
  };
  const runCommand = async (bin, args, timeout = 5000) => {
    try {
      return await execFileAsync(bin, args, {
        encoding: "utf8",
        env: enrichedPathEnv(),
        timeout,
        maxBuffer: 2 * 1024 * 1024
      });
    } catch (_error) {
      return null;
    }
  };

  agentEnvironmentPromise = (async () => {
    const [primeInstalled, uvInstalled, dockerInstalled] = await Promise.all([
      commandExists("prime"),
      commandExists("uv"),
      commandExists("docker")
    ]);
    const [primeResult, dockerResult] = await Promise.all([
      primeInstalled ? runCommand("prime", ["whoami"], 8000) : null,
      dockerInstalled ? runCommand("docker", ["info", "--format", "{{.ServerVersion}}"], 8000) : null
    ]);
    const primeAuthenticated = Boolean(primeResult);
    const dockerRunning = Boolean(dockerResult && String(dockerResult.stdout || "").trim());
    const value = {
      checking: false,
      docker: Boolean(dockerRunning),
      docker_installed: dockerInstalled,
      docker_running: Boolean(dockerRunning),
      prime: primeInstalled && primeAuthenticated,
      prime_installed: primeInstalled,
      prime_authenticated: primeAuthenticated,
      uv: uvInstalled
    };
    agentEnvironmentCache = { at: Date.now(), value };
    return value;
  })();

  try {
    return await agentEnvironmentPromise;
  } finally {
    agentEnvironmentPromise = null;
  }
}

const DEFAULT_REQUEST_BODY_MAX_BYTES = 5 * 1024 * 1024;
const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache"
};
// This is a local authoring/runtime server. Always revalidate editable assets
// so restarting it can never leave the browser on an older CSS or JS bundle.
// ETags still make unchanged responses cheap 304s.
const STATIC_CACHE_CONTROL = "no-cache, max-age=0, must-revalidate";

function readRequestBody(request, options = {}) {
  return new Promise((resolve, reject) => {
    const maxBytes = Number.isFinite(options.maxBytes)
      ? options.maxBytes
      : DEFAULT_REQUEST_BODY_MAX_BYTES;
    let body = "";
    let rejected = false;

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (rejected) {
        return;
      }

      body += chunk;

      if (body.length > maxBytes) {
        rejected = true;
        body = "";
        reject(new Error("Request body is too large."));
        request.resume();
      }
    });
    request.on("end", () => {
      if (!rejected) {
        resolve(body);
      }
    });
    request.on("error", (error) => {
      if (!rejected) {
        rejected = true;
        reject(error);
      }
    });
  });
}

async function readJsonBody(request, options = {}) {
  const body = await readRequestBody(request, options);

  if (!body.trim()) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error("Request body must be valid JSON.");
  }
}

function sendHtml(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    ...NO_CACHE_HEADERS
  });
  response.end(body);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...NO_CACHE_HEADERS
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendRedirect(response, location, statusCode = 302) {
  response.writeHead(statusCode, {
    Location: location
  });
  response.end();
}

function buildStaticFileEtag(stats) {
  return `"${stats.size.toString(16)}-${Math.round(stats.mtimeMs).toString(16)}"`;
}

function requestEtagMatches(request, etag) {
  const ifNoneMatch = request.headers["if-none-match"];

  if (typeof ifNoneMatch !== "string" || ifNoneMatch.length === 0) {
    return false;
  }

  return ifNoneMatch
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === etag || value === `W/${etag}` || value === "*");
}

function sendFile(request, response, filePath, contentType) {
  const stats = fs.existsSync(filePath) ? fs.statSync(filePath) : null;

  if (!stats || !stats.isFile()) {
    sendHtml(response, 404, renderNotFound());
    return;
  }

  const etag = buildStaticFileEtag(stats);

  if (requestEtagMatches(request, etag)) {
    response.writeHead(304, {
      "Cache-Control": STATIC_CACHE_CONTROL,
      ETag: etag
    });
    response.end();
    return;
  }

  response.writeHead(200, {
    "Cache-Control": STATIC_CACHE_CONTROL,
    "Content-Length": stats.size,
    "Content-Type": contentType,
    ETag: etag
  });

  const fileStream = fs.createReadStream(filePath);
  fileStream.on("error", () => {
    response.destroy();
  });
  fileStream.pipe(response);
}

const {
  renderAgentPage,
  renderAgentRunPage,
  renderAuthorPage,
  renderBuildPage,
  renderFlyoverPage,
  renderGamePage,
  renderHomePage,
  renderNotFound,
  renderPlayPage,
  renderTrainPage,
  renderWorldMapEditorPage
} = createPageRenderer({
  agentEnvironment,
  buildAuthorPageData,
  buildMazeWorldMapEditorData,
  buildWorlds,
  getGame,
  getLevelState,
  listGames,
  remote,
  worldMaps
});

const { handleRequest } = createRequestRouter({
  agentRuns,
  buildMazePreviewData,
  buildMazeWorldMapEditorData,
  buildWorlds,
  getContentType,
  getEditableLevel,
  getGame,
  getLevel,
  getLevelEditorState,
  getLevelFilePath,
  getLevelState,
  gamesDir: GAMES_DIR,
  loadJson,
  publicFileRoutes: PUBLIC_FILE_ROUTES,
  readJsonBody,
  remote,
  renderAgentPage,
  renderAgentRunPage,
  renderAuthorPage,
  renderBuildPage,
  renderFlyoverPage,
  renderGamePage,
  renderHomePage,
  renderNotFound,
  renderPlayPage,
  renderTrainPage,
  renderWorldMapEditorPage,
  resolveGameAssetPath,
  sanitizeEditorPayload,
  sendFile,
  sendHtml,
  sendJson,
  sendRedirect,
  solverExports,
  training,
  worldMaps,
  writeMazePreviewImageData
});

function isExpectedRequestError(error) {
  return (
    error instanceof Error &&
    error.name === "Error" &&
    error.code === undefined &&
    error.syscall === undefined
  );
}

function createRequestHandler() {
  return async function requestHandler(request, response) {
    try {
      await handleRequest(request, response);
    } catch (error) {
      console.error(`Request failed: ${request.method} ${request.url}`, error);

      if (response.headersSent) {
        response.destroy();
        return;
      }

      if (isExpectedRequestError(error)) {
        const statusCode = error.message === "Request body is too large." ? 413 : 400;
        sendJson(response, statusCode, { error: error.message });
        return;
      }

      sendJson(response, 500, { error: "Something went wrong." });
    }
  };
}

module.exports = {
  HOST,
  PORT,
  buildGameWorldBundle,
  createRequestHandler,
  defaultLevelIdForGame,
  getGame,
  getLevel,
  getLevelState,
  handleRequest
};
