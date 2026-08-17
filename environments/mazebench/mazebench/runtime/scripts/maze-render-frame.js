#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const readline = require("node:readline");
const { pathToFileURL } = require("node:url");
const {
  cleanupPlaywrightProfile,
  findPlaywrightBrowserChildren,
  killPlaywrightBrowserProcess
} = require("./playwright-process");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_BROWSER_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
];
const DIRECTIONS = new Set(["up", "down", "left", "right"]);
const BROWSER_CLOSE_TIMEOUT_MS = 3_000;
const ACTIVE_BROWSER_PROCESSES = new Map();

// Playwright deliberately launches Chromium as a separate process-group
// leader. If this renderer is forced to exit, kill that group synchronously so
// Chromium cannot be reparented to launchd and survive the rollout that owned
// it. Normal browser.close() remains the preferred path below.
process.once("exit", () => {
  for (const processInfo of ACTIVE_BROWSER_PROCESSES.values()) {
    killPlaywrightBrowserProcess(processInfo);
  }
});

function trackLaunchedBrowser() {
  const processInfo = findPlaywrightBrowserChildren(process.pid)[0] || null;
  if (processInfo) ACTIVE_BROWSER_PROCESSES.set(processInfo.pid, processInfo);
  return processInfo;
}

async function closeBrowser(browser, processInfo) {
  if (!browser && !processInfo) return;

  let settled = false;
  const closePromise = Promise.resolve()
    .then(() => browser?.close())
    .catch(() => {})
    .finally(() => {
      settled = true;
    });

  await Promise.race([
    closePromise,
    new Promise((resolve) => setTimeout(resolve, BROWSER_CLOSE_TIMEOUT_MS))
  ]);

  // browser.close() normally removes the profile itself. If it hung or Chrome
  // ignored the close request, kill the browser's own process group explicitly.
  if (!settled) killPlaywrightBrowserProcess(processInfo);
  await Promise.race([
    closePromise,
    new Promise((resolve) => setTimeout(resolve, 1000))
  ]);

  if (processInfo) {
    killPlaywrightBrowserProcess(processInfo);
    cleanupPlaywrightProfile(processInfo);
    ACTIVE_BROWSER_PROCESSES.delete(processInfo.pid);
  }
}

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function normalizeDirection(value) {
  const direction = String(value || "").trim().toLowerCase();
  return DIRECTIONS.has(direction) ? direction : "";
}

function normalizeLevelToken(value) {
  return String(value || "").trim().replace(/^level_/i, "").toUpperCase();
}

function parseCommandLine(line) {
  const cleaned = String(line || "").trim();

  if (!cleaned) {
    return null;
  }

  if (cleaned.startsWith("{")) {
    try {
      const payload = JSON.parse(cleaned);
      const command = String(payload.command || payload.action || "").trim().toLowerCase();
      const direction = normalizeDirection(payload.direction);

      if (command === "move" && direction) {
        return { command: "move", direction };
      }
      if ((command === "rotate_camera" || command === "rotate") && direction) {
        return { command: "rotate_camera", direction };
      }
      if (command === "reset" || command === "reset_level") {
        return { command: "reset_level" };
      }
      if (command === "undo" || command === "quit") {
        return { command };
      }
      if (command === "no_move") {
        return { command: "no_move" };
      }
      if (command === "goto_level" || command === "go_to_level" || command === "goto") {
        const level = normalizeLevelToken(payload.level);
        const x = String(payload.x || level[0] || "").toUpperCase();
        const y = String(payload.y || level[2] || "").toUpperCase();

        if (/^[A-Z]$/.test(x) && /^[A-Z]$/.test(y)) {
          return { command: "goto_level", x, y };
        }
      }
    } catch {
      return null;
    }
  }

  const lower = cleaned.toLowerCase();

  if (DIRECTIONS.has(lower)) {
    return { command: "move", direction: lower };
  }
  if (lower === "undo" || lower === "quit") {
    return { command: lower };
  }
  if (lower === "no move" || lower === "no_move") {
    return { command: "no_move" };
  }
  if (lower === "reset" || lower === "reset level" || lower === "reset_level") {
    return { command: "reset_level" };
  }

  let match = lower.match(/^rotate\s+camera\s+(up|down|left|right)$/);
  if (match) {
    return { command: "rotate_camera", direction: match[1] };
  }

  match = cleaned.match(/^go\s+to\s+level\s+([A-Za-z])\s+([A-Za-z])$/i);
  if (match) {
    return { command: "goto_level", x: match[1].toUpperCase(), y: match[2].toUpperCase() };
  }

  return null;
}

async function launchBrowser(chromium, browserName = "") {
  const requested = String(browserName || "").trim().toLowerCase();
  const candidates = [];

  if (requested && !["chrome", "brave", "chromium", "edge"].includes(requested)) {
    candidates.push(browserName);
  } else if (requested === "chrome") {
    candidates.push(DEFAULT_BROWSER_PATHS[0]);
  } else if (requested === "brave") {
    candidates.push(DEFAULT_BROWSER_PATHS[1]);
  } else if (requested === "chromium") {
    candidates.push(DEFAULT_BROWSER_PATHS[2]);
  } else if (requested === "edge") {
    candidates.push(DEFAULT_BROWSER_PATHS[3]);
  } else {
    candidates.push(...DEFAULT_BROWSER_PATHS);
  }

  // MCP servers receive an intentionally narrow environment from Codex and
  // Claude, which can omit PLAYWRIGHT_BROWSERS_PATH even inside our Playwright
  // Docker image. Discover the bundled executable directly instead of falling
  // back to a nonexistent per-user cache.
  if (fs.existsSync("/ms-playwright")) {
    for (const directory of fs.readdirSync("/ms-playwright")) {
      candidates.push(
        path.join("/ms-playwright", directory, "chrome-linux", "headless_shell"),
        path.join("/ms-playwright", directory, "chrome-linux", "chrome")
      );
    }
  }

  let lastError = null;
  for (const executablePath of candidates) {
    if (!fs.existsSync(executablePath)) {
      continue;
    }
    try {
      return await chromium.launch({
        executablePath,
        args: ["--disable-gpu", "--use-angle=swiftshader"],
        headless: true
      });
    } catch (error) {
      lastError = error;
    }
  }

  try {
    return await chromium.launch({
      args: ["--disable-gpu", "--use-angle=swiftshader"],
      headless: true
    });
  } catch (error) {
    throw lastError || error;
  }
}

async function startServer() {
  const { createRequestHandler } = require(path.join(ROOT_DIR, "server", "app"));
  const server = http.createServer(createRequestHandler());

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Could not start local maze server");
  }

  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    port: address.port
  };
}

async function waitUntilSettled(page, maxFrames = 90) {
  await page.evaluate(async (frameLimit) => {
    function isBusy() {
      const app = window.__PIXEL_GAME_APP__;
      return Boolean(
        app?.isAnimating ||
          app?.isTransitioningLevel ||
          app?.threeRenderer?.isDebugCameraAnimating?.()
      );
    }

    for (let index = 0; index < frameLimit; index += 1) {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      if (!isBusy()) {
        break;
      }
    }
  }, maxFrames);
}

async function captureFrame(page) {
  return page.evaluate(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    const app = window.__PIXEL_GAME_APP__;
    const canvas =
      app?.canvas ||
      app?.viewCanvas ||
      app?.sceneCanvas ||
      document.getElementById("maze-canvas");

    if (!canvas) {
      throw new Error("Could not find maze canvas");
    }

    return canvas.toDataURL("image/png");
  });
}

async function thawRenderPage(session) {
  await session.page.evaluate(() => {
    if (window.__MAZEBENCH_NATIVE_RAF__) {
      window.requestAnimationFrame = window.__MAZEBENCH_NATIVE_RAF__;
      delete window.__MAZEBENCH_NATIVE_RAF__;
    }
  });
}

async function freezeRenderPage(session) {
  await session.page.evaluate(() => {
    const app = window.__PIXEL_GAME_APP__;
    if (!window.__MAZEBENCH_NATIVE_RAF__) {
      window.__MAZEBENCH_NATIVE_RAF__ = window.requestAnimationFrame.bind(window);
    }
    // Settled agent observations are still images. Cancel tracked presentation
    // loops and reject any untracked loop's next RAF until the following maze
    // action explicitly thaws the page. This prevents headless SwiftShader from
    // consuming every CPU core while the model is reasoning.
    [
      "animationFrameId",
      "cameraFrameId",
      "floatingFloorFrameId",
      "gateAnimationFrameId",
      "levelTransitionFrameId",
      "noiseFrameId",
      "orangeWallAnimationFrameId",
      "playerLiftAnimationFrameId"
    ].forEach((key) => {
      if (app?.[key] != null) window.cancelAnimationFrame(app[key]);
      if (app) app[key] = null;
    });
    window.requestAnimationFrame = () => 0;
  });
}

// The view window: 1..26 rings of neighbor rooms around the player (1 = the
// classic 3x3 neighborhood) or "world" for the whole map, mirroring the
// ?view= query parameter that public/play.js understands.
function normalizeViewOption(value) {
  const raw = String(value ?? "1").trim().toLowerCase();

  if (raw === "world") {
    return "world";
  }

  const rings = Number(raw);
  return Number.isFinite(rings) ? Math.max(1, Math.min(26, Math.floor(rings))) : 1;
}

function normalizeRenderOptions(payload) {
  return {
    actions: Array.isArray(payload.actions) ? payload.actions : [],
    browser: String(payload.browser || ""),
    cameraStepDegrees: Number(payload.cameraStepDegrees || 18),
    cameraTiltDegrees: Number(payload.cameraTiltDegrees || 58),
    cameraZoom: Number(payload.cameraZoom || 1),
    draft: payload.draft !== false,
    edges: payload.edges !== false,
    fast: payload.fast !== false,
    gameId: String(payload.gameId || "maze"),
    height: Number(payload.height || 512),
    levelId: String(payload.levelId || "level_HxI"),
    view: normalizeViewOption(payload.view),
    width: Number(payload.width || 512),
    yaw: Number(payload.yaw || 0)
  };
}

async function setCameraView(session) {
  await session.page.evaluate(
    ({ tiltDegrees, yawTurns, zoom }) => {
      const tilt = (tiltDegrees * Math.PI) / 180;
      window.__PIXEL_GAME_APP__?.threeRenderer?.setDebugCameraView?.({
        animate: false,
        mode: "perspective",
        tilt,
        yaw: yawTurns * (Math.PI / 2),
        zoom
      });
    },
    {
      tiltDegrees: session.cameraTiltDegrees,
      yawTurns: session.cameraYawTurns,
      zoom: session.options.cameraZoom
    }
  );
  await waitUntilSettled(session.page, 20);
}

async function createRenderSession(payload) {
  const playwrightCore = process.env.MAZEBENCH_PLAYWRIGHT_CORE;
  const { chromium } = await import(
    playwrightCore ? pathToFileURL(playwrightCore).href : "playwright-core"
  );
  const options = normalizeRenderOptions(payload);
  const server = await startServer();
  let browser = null;
  let browserProcess = null;

  try {
    browser = await launchBrowser(chromium, options.browser);
    browserProcess = trackLaunchedBrowser();
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: { width: options.width, height: options.height }
    });
    // Pin the view window (default: the classic 3x3 neighborhood) so benchmark
    // observations stay stable regardless of the browser default. options.view
    // is 1..26 rings or "world" — both understood by public/play.js.
    const levelUrl = `http://127.0.0.1:${server.port}/play/${encodeURIComponent(
      options.gameId
    )}/${encodeURIComponent(options.levelId)}?view=${encodeURIComponent(options.view)}`;

    await page.addInitScript(() => {
      window.__PIXEL_GAME_DEBUG__ = true;
      window.__PIXEL_GAME_REPLAY_CAPTURE__ = true;
    });
    await page.goto(levelUrl, { waitUntil: "networkidle" });
    await page.waitForFunction(() => {
      const app = window.__PIXEL_GAME_APP__;
      return Boolean(app?.movement && app?.threeRenderer && app?.render);
    });
    await page.evaluate(() => {
      const app = window.__PIXEL_GAME_APP__;
      // Agent sessions keep deaths terminal until the model explicitly
      // chooses undo, reset, or a room change. The interactive play page
      // auto-undoes falls, which otherwise advances only the vision replay
      // and makes later frames diverge from the authoritative run state.
      app.autoUndoPlayerFalls = false;
    });
    await page.addStyleTag({
      content: `
        html, body {
          background: #050608 !important;
          height: 100% !important;
          margin: 0 !important;
          overflow: hidden !important;
          width: 100% !important;
        }
        .play-shell {
          display: block !important;
          height: 100vh !important;
          min-height: 100vh !important;
          width: 100vw !important;
        }
        .play-header {
          display: none !important;
        }
        .play-stage,
        .maze-frame {
          border: 0 !important;
          border-radius: 0 !important;
          box-shadow: none !important;
          height: 100vh !important;
          margin: 0 !important;
          max-height: none !important;
          max-width: none !important;
          padding: 0 !important;
          width: 100vw !important;
        }
        #maze-canvas {
          display: block !important;
          height: 100vh !important;
          width: 100vw !important;
        }
      `
    });
    await page.evaluate(async ({ draft, edges, fast, height, width }) => {
      const app = window.__PIXEL_GAME_APP__;

      if (draft) {
        const scale = Math.max(
          0.1,
          Math.min(1, width / app.viewportRect.width, height / app.viewportRect.height)
        );
        Object.defineProperty(window, "devicePixelRatio", {
          configurable: true,
          get: () => scale
        });
      }

      window.dispatchEvent(new Event("resize"));
      app.syncPlayLayout?.();
      app.setupCanvas?.();
      // Fuzzy (CRT noise) is a per-frame post effect — draft mode drops it for
      // speed. Black edge outlines are part of how the game reads, so they stay
      // on unless explicitly disabled; humans see them by default too.
      app.state.effects.fuzzyEnabled = !draft;
      app.state.effects.edgeOutlinesEnabled = edges;
      app.state.effects.noisePhase = 0;

      if (app.noiseFrameId !== null) {
        window.cancelAnimationFrame(app.noiseFrameId);
        app.noiseFrameId = null;
      }

      if (draft) {
        // Floating-floor hover is a presentation-only ticker. In a persistent
        // agent renderer it otherwise redraws WebGL continuously between maze
        // actions and can pin every SwiftShader core while the model thinks.
        if (app.floatingFloorFrameId !== null) {
          window.cancelAnimationFrame(app.floatingFloorFrameId);
          app.floatingFloorFrameId = null;
        }
        app.syncFloatingFloorTicker = () => {
          if (app.floatingFloorFrameId !== null) {
            window.cancelAnimationFrame(app.floatingFloorFrameId);
            app.floatingFloorFrameId = null;
          }
        };
      }

      app.syncFuzzyToggle?.();
      app.syncEdgeToggle?.();

      if (fast) {
        // Historical live-view rebuilds may replay hundreds of actions after a
        // site-server restart. Advance animation clocks by a full second per
        // RAF so every move settles in a couple of frames instead of real time.
        app.replayAnimationFrameStepMs = 1000;
        app.replayMoveDurationMs = 1;
        [
          "MOVE_DURATION_MS",
          "GATE_RISE_DURATION_MS",
          "GATE_FALL_DURATION_MS",
          "ORANGE_WALL_RISE_DURATION_MS",
          "ORANGE_WALL_FALL_DURATION_MS",
          "PLAYER_LIFT_RISE_DURATION_MS",
          "PLAYER_LIFT_FALL_DURATION_MS",
          "HOLE_FALL_DURATION_MS",
          "LEVEL_TRANSITION_DURATION_MS"
        ].forEach((key) => {
          if (Number.isFinite(app[key])) {
            app[key] = 1;
          }
        });
      }

      await app.preloadImages?.();
      await app.threeRendererReady;
      app.syncCameraTarget?.(true);
      app.render?.();
    }, options);

    const session = {
      appliedActions: [],
      browser,
      browserProcess,
      cameraTiltDegrees: options.cameraTiltDegrees,
      cameraYawTurns: ((options.yaw % 4) + 4) % 4,
      closed: false,
      options,
      page,
      server
    };

    await setCameraView(session);
    await waitUntilSettled(page);
    return session;
  } catch (error) {
    await closeBrowser(browser, browserProcess);
    await server.close().catch(() => {});
    throw error;
  }
}

async function applySessionAction(session, commandText) {
  const { options, page } = session;
  const parsed = parseCommandLine(commandText);

  if (!parsed) {
    return false;
  }

  await thawRenderPage(session);

  if (parsed.command === "move") {
    const key = {
      down: "ArrowDown",
      left: "ArrowLeft",
      right: "ArrowRight",
      up: "ArrowUp"
    }[parsed.direction];
    await page.keyboard.press(key);
    await waitUntilSettled(page);
  } else if (parsed.command === "rotate_camera") {
    if (parsed.direction === "left") {
      session.cameraYawTurns -= 1;
    } else if (parsed.direction === "right") {
      session.cameraYawTurns += 1;
    } else if (parsed.direction === "up") {
      session.cameraTiltDegrees = Math.max(20, session.cameraTiltDegrees - options.cameraStepDegrees);
    } else if (parsed.direction === "down") {
      session.cameraTiltDegrees = Math.min(82, session.cameraTiltDegrees + options.cameraStepDegrees);
    }
    await setCameraView(session);
  } else if (parsed.command === "undo") {
    await page.keyboard.press("z");
    await waitUntilSettled(page);
  } else if (parsed.command === "reset_level") {
    await page.keyboard.press("r");
    await waitUntilSettled(page);
  } else if (parsed.command === "goto_level") {
    const levelId = `level_${parsed.x}x${parsed.y}`;
    await page.evaluate(async (nextLevelId) => {
      const app = window.__PIXEL_GAME_APP__;
      const response = await fetch(
        `/api/play/${encodeURIComponent(app.currentGameId)}/${encodeURIComponent(nextLevelId)}`
      );

      if (!response.ok) {
        throw new Error(`Could not load ${nextLevelId}`);
      }

      const levelState = await response.json();
      app.applyLevelState(levelState, {
        deferRender: true,
        immediateCamera: true,
        resetHistory: false,
        resetLevelEntry: true
      });
      await app.preloadImagesForLevelState?.(levelState);
      app.render?.();
    }, levelId);
    await waitUntilSettled(page);
  }

  session.appliedActions.push(String(commandText));
  return true;
}

async function applyRenderStateSnapshot(session, snapshot) {
  if (!snapshot?.level_id || !Array.isArray(snapshot.actors)) {
    return false;
  }

  await thawRenderPage(session);
  await session.page.evaluate(async (renderState) => {
    const app = window.__PIXEL_GAME_APP__;
    const response = await fetch(
      `/api/play/${encodeURIComponent(renderState.game_id || app.currentGameId)}/${encodeURIComponent(renderState.level_id)}`
    );
    if (!response.ok) throw new Error(`Could not load ${renderState.level_id}`);
    const levelState = await response.json();
    levelState.actors = renderState.actors;
    (renderState.terrain_overrides || []).forEach((override) => {
      const index = Number(override.index);
      const x = index % levelState.width;
      const y = Math.floor(index / levelState.width);
      const cell = levelState.terrain?.[y]?.[x];
      if (!cell) return;
      if (override.type) {
        levelState.terrain[y][x] = {
          elevation: 0,
          imageUrl: null,
          label: String(override.type).replaceAll("_", " "),
          layers: null,
          raised: Boolean(override.raised),
          type: override.type,
          underlay: null
        };
      } else {
        cell.raised = Boolean(override.raised);
        if (Array.isArray(cell.layers)) {
          cell.layers.forEach((layer) => {
            if (layer?.type === "player_lift") layer.raised = Boolean(override.raised);
          });
        }
      }
    });

    app.applyLevelState(levelState, {
      deferRender: true,
      immediateCamera: true,
      resetHistory: true,
      resetLevelEntry: true
    });
    await app.preloadImagesForLevelState?.(levelState);
    app.render?.();
  }, snapshot);

  session.cameraYawTurns = ((Number(snapshot.yaw) || 0) % 4 + 4) % 4;
  const pitch = Math.max(0, Math.min(4, Number(snapshot.pitch) || 0));
  session.cameraTiltDegrees = Math.max(
    20,
    Math.min(82, 58 + (pitch - 1) * session.options.cameraStepDegrees)
  );
  session.appliedActions = [];
  await setCameraView(session);
  await waitUntilSettled(session.page, 20);
  return true;
}

async function captureSessionFrame(session) {
  await thawRenderPage(session);
  await setCameraView(session);
  const frame = await captureFrame(session.page);
  await freezeRenderPage(session);
  return frame;
}

async function closeRenderSession(session) {
  if (!session || session.closed) {
    return;
  }

  session.closed = true;
  await closeBrowser(session.browser, session.browserProcess);
  await session.server.close().catch(() => {});
}

async function renderFrame(payload) {
  const session = await createRenderSession(payload);

  try {
    if (payload.snapshot?.level_id && Array.isArray(payload.snapshot.actors)) {
      await applyRenderStateSnapshot(session, payload.snapshot);
    } else {
      for (const commandText of session.options.actions) {
        await applySessionAction(session, commandText);
      }
    }

    return await captureSessionFrame(session);
  } finally {
    await closeRenderSession(session);
  }
}

function writeLine(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

// Option fields that must match for a live session to be reused by a `render`
// sync; a mismatch (different level, size, view, ...) forces a fresh session.
const SESSION_OPTION_KEYS = [
  "browser",
  "cameraStepDegrees",
  "cameraTiltDegrees",
  "cameraZoom",
  "draft",
  "edges",
  "fast",
  "gameId",
  "height",
  "levelId",
  "view",
  "width",
  "yaw"
];

function renderOptionsMatch(current, next) {
  return SESSION_OPTION_KEYS.every((key) => current[key] === next[key]);
}

async function initSession(payload) {
  const session = await createRenderSession(payload);

  if (payload.snapshot?.level_id && Array.isArray(payload.snapshot.actors)) {
    await applyRenderStateSnapshot(session, payload.snapshot);
  } else {
    for (const commandText of session.options.actions) {
      await applySessionAction(session, commandText);
    }
  }

  return session;
}

// Shared message handling for the persistent modes (--serve on stdin, --listen
// on a local socket). One render session at a time.
function createServeHandler() {
  let session = null;

  async function closeSession() {
    const current = session;
    session = null;
    await closeRenderSession(current);
  }

  // Reuse the live session when the requested action list extends what it has
  // already applied — the common one-new-action-per-turn case. Anything else
  // (rewritten history, changed options) rebuilds from scratch.
  async function syncSession(message) {
    const next = normalizeRenderOptions(message);
    const wanted = next.actions.map(String).filter((text) => parseCommandLine(text));

    if (message.snapshot?.level_id && Array.isArray(message.snapshot.actors)) {
      if (!session || !renderOptionsMatch(session.options, next)) {
        await closeSession();
        session = await createRenderSession(message);
      }
      await applyRenderStateSnapshot(session, message.snapshot);
      return;
    }

    if (session && renderOptionsMatch(session.options, next)) {
      const applied = session.appliedActions;
      const extendsApplied =
        applied.length <= wanted.length && applied.every((text, index) => text === wanted[index]);

      if (extendsApplied) {
        for (const text of wanted.slice(applied.length)) {
          await applySessionAction(session, text);
        }
        return;
      }
    }

    await closeSession();
    session = await initSession(message);
  }

  async function handleMessage(message) {
    const command = String(message.command || "").trim().toLowerCase();

    if (command === "init") {
      await closeSession();
      session = await initSession(message);
      return {
        ok: true,
        browser_pid: session.browserProcess?.pid || null,
        frame: await captureSessionFrame(session)
      };
    }

    if (command === "render") {
      await syncSession(message);
      return {
        ok: true,
        browser_pid: session.browserProcess?.pid || null,
        frame: await captureSessionFrame(session)
      };
    }

    if (command === "close") {
      await closeSession();
      return { ok: true, closing: true };
    }

    if (!session) {
      throw new Error('render session is not initialized; send {"command":"init",...} first');
    }

    if (command === "action") {
      const applied = await applySessionAction(session, message.action);
      return {
        ok: true,
        applied,
        browser_pid: session.browserProcess?.pid || null,
        frame: await captureSessionFrame(session)
      };
    }

    if (command === "frame") {
      return {
        ok: true,
        browser_pid: session.browserProcess?.pid || null,
        frame: await captureSessionFrame(session)
      };
    }

    throw new Error(`unknown command: ${message.command}`);
  }

  return { closeSession, handleMessage };
}

function runServeMode() {
  const handler = createServeHandler();
  let queue = Promise.resolve();
  let closing = false;

  function shutdown() {
    if (closing) return;
    closing = true;
    const forceExit = setTimeout(() => process.exit(0), BROWSER_CLOSE_TIMEOUT_MS + 2000);
    queue = queue
      .then(() => handler.closeSession())
      .catch(() => {})
      .finally(() => {
        clearTimeout(forceExit);
        process.exit(0);
      });
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false
  });

  rl.on("line", (line) => {
    if (!String(line || "").trim()) {
      return;
    }

    queue = queue.then(async () => {
      let response;

      try {
        response = await handler.handleMessage(JSON.parse(line));
      } catch (error) {
        response = {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }

      writeLine(response);

      if (response.ok && response.closing) {
        shutdown();
      }
    });
  });

  rl.on("close", shutdown);
}

// Daemon mode: same JSON-line protocol as --serve, but over a 127.0.0.1 TCP
// socket so short-lived callers (codex-play.js runs once per agent turn) can
// share one long-lived browser. The chosen port is written to --port-file.
function runListenMode({ idleSeconds = 600, portFile = "" } = {}) {
  const net = require("node:net");
  const handler = createServeHandler();
  let queue = Promise.resolve();
  let lastActivity = Date.now();
  let closing = false;
  let listeningInfo = null;

  function writePortInfo(extra = {}) {
    if (!portFile || !listeningInfo) return;
    listeningInfo = { ...listeningInfo, ...extra };
    fs.mkdirSync(path.dirname(portFile), { recursive: true });
    fs.writeFileSync(portFile, `${JSON.stringify(listeningInfo)}\n`);
  }

  function shutdown() {
    if (closing) {
      return;
    }

    closing = true;
    clearInterval(idleTimer);
    queue = queue
      .then(() => handler.closeSession())
      .catch(() => {})
      .finally(() => {
        if (portFile) {
          fs.rmSync(portFile, { force: true });
        }

        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), BROWSER_CLOSE_TIMEOUT_MS + 2000).unref();
      });
  }

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");

      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");

        if (!line) {
          continue;
        }

        lastActivity = Date.now();
        queue = queue.then(async () => {
          let response;

          try {
            response = await handler.handleMessage(JSON.parse(line));
          } catch (error) {
            response = {
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            };
          }

          lastActivity = Date.now();

          if (Number(response.browser_pid) > 0) {
            writePortInfo({ browser_pid: Number(response.browser_pid) });
          }

          if (!socket.destroyed) {
            socket.write(`${JSON.stringify(response)}\n`);
          }

          if (response.ok && response.closing) {
            shutdown();
          }
        });
      }
    });
    socket.on("error", () => {});
  });

  // A crashed or finished caller may never send close; exit once idle so
  // headless browsers don't accumulate.
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > idleSeconds * 1000) {
      shutdown();
    }
  }, 5000);

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Binding a localhost port fails under a no-network sandbox (e.g. codex's
  // workspace-write). Record the failure in the port file so the caller falls
  // back immediately instead of waiting out its start-up timeout.
  server.on("error", (error) => {
    if (portFile) {
      try {
        fs.mkdirSync(path.dirname(portFile), { recursive: true });
        fs.writeFileSync(portFile, `${JSON.stringify({ error: error.code || error.message })}\n`);
      } catch (writeError) {
        /* best effort */
      }
    }

    writeLine({ ok: false, error: error.message });
    process.exit(1);
  });

  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const info = { pid: process.pid, port: address.port };
    listeningInfo = info;

    writePortInfo();

    writeLine({ ok: true, listening: true, ...info });
  });
}

function printUsage() {
  process.stdout.write(`Usage: node scripts/maze-render-frame.js [--serve | --listen]

One-shot mode (default):
  Reads one JSON payload on stdin, replays payload.actions in a headless
  browser, then writes {"data_url":"data:image/png;base64,..."} on stdout.
  Payload fields: actions, browser, cameraStepDegrees, cameraTiltDegrees,
  cameraZoom, draft, edges, fast, gameId, height, levelId, view, width, yaw.
  view is 1..26 neighbor-room rings (default 1 = the classic 3x3 window)
  or "world"; edges (default true) keeps the black outline pass on.

Serve mode (--serve):
  Keeps one local server + headless browser alive and answers JSON lines
  on stdin, mirroring scripts/maze-bridge.js:
    {"command":"init","gameId":"maze","levelId":"level_HxI","width":512,"height":512,"yaw":0}
    {"command":"action","action":"up"}
    {"command":"render","actions":["up","left"],...}   (sync to a full action
      list; applies only the new suffix when it extends the live session)
    {"command":"frame"}
    {"command":"close"}
  Each response is one JSON line, {"ok":true,"frame":"data:image/png;base64,..."}
  or {"ok":false,"error":"..."}.

Listen mode (--listen [--port-file <path>] [--idle-seconds <n>]):
  Same protocol as --serve, but over a 127.0.0.1 TCP socket so one browser can
  be shared across many short-lived callers (one agent turn each). Writes
  {"pid","port"} to --port-file once listening, and exits by itself after
  --idle-seconds (default 600) without a request.
`);
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }

  if (argv.includes("--listen")) {
    const portFileIndex = argv.indexOf("--port-file");
    const idleIndex = argv.indexOf("--idle-seconds");
    const portFileValue = portFileIndex >= 0 ? String(argv[portFileIndex + 1] || "") : "";
    runListenMode({
      idleSeconds: idleIndex >= 0 ? Math.max(30, Number(argv[idleIndex + 1]) || 600) : 600,
      portFile: portFileValue ? path.resolve(portFileValue) : ""
    });
    return;
  }

  if (argv.includes("--serve")) {
    runServeMode();
    return;
  }

  const payload = JSON.parse(readStdin() || "{}");
  const dataUrl = await renderFrame(payload);
  process.stdout.write(`${JSON.stringify({ data_url: dataUrl })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  applySessionAction,
  captureSessionFrame,
  closeRenderSession,
  createRenderSession,
  createServeHandler,
  normalizeRenderOptions,
  renderFrame
};
