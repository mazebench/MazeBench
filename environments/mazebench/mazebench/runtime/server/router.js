const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { isLoopbackHost, isLoopbackPeer } = require("./network");

const PREVIEW_REQUEST_BODY_MAX_BYTES = 20 * 1024 * 1024;
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function createRequestRouter({
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
  gamesDir,
  loadJson,
  publicFileRoutes,
  readJsonBody,
  remote,
  renderAgentPage,
  renderAgentRunPage,
  renderAuthorPage,
  renderBuildPage,
  renderFlyoverPage,
  renderGamePage,
  renderHomePage,
  renderLeaderboardPage,
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
}) {
  const defaultLevelIdForGame = (game) => worldMaps.defaultLevelIdForGame(game);
  const isWorldLevelId = (game, levelId) => worldMaps.isMazeWorldLevelId(game.id, levelId);
  async function handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const segments = url.pathname.split("/").filter(Boolean);
    const publicFilePath = publicFileRoutes.get(url.pathname);
    if (!isLoopbackRequest(request)) {
      sendHtml(response, 403, "Forbidden.");
      return;
    }
    if (segments[0] === "api") {
      const localApiError = validateLocalApiRequest(request, url, segments);
      if (localApiError) {
        sendJson(response, localApiError.status, { error: localApiError.message });
        return;
      }
    }

    if (publicFilePath) {
      sendFile(request, response, publicFilePath, getContentType(publicFilePath));
      return;
    }

    if (segments.length >= 3 && segments[0] === "assets") {
      const gameId = segments[1];
      const relativePath = segments.slice(2).map(decodeURIComponent).join(path.sep);
      const assetPath = resolveGameAssetPath(gameId, relativePath);

      if (!assetPath) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendFile(request, response, assetPath, getContentType(assetPath));
      return;
    }

    if (url.pathname === "/") {
      sendHtml(response, 200, renderHomePage());
      return;
    }

    if (url.pathname === "/build") {
      sendHtml(response, 200, renderBuildPage());
      return;
    }

    if (url.pathname === "/play") {
      sendRedirect(response, "/build");
      return;
    }

    if (url.pathname === "/agent") {
      sendHtml(response, 200, renderAgentPage());
      return;
    }

    if (url.pathname === "/leaderboard") {
      sendHtml(response, 200, renderLeaderboardPage());
      return;
    }

    if (url.pathname === "/train") {
      sendHtml(response, 200, renderTrainPage());
      return;
    }

    if (url.pathname === "/api/train/bootstrap") {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }
      sendJson(response, 200, await training.bootstrapAsync({ fresh: url.searchParams.get("refresh") === "1" }));
      return;
    }

    if (url.pathname === "/api/train/runs") {
      if (request.method === "GET") {
        sendJson(response, 200, await training.listRunsAsync({
          limit: Number(url.searchParams.get("limit")) || 10
        }));
        return;
      }
      if (request.method === "POST") {
        const payload = await readJsonBody(request);
        sendJson(response, 201, training.launch(payload));
        return;
      }
      response.writeHead(405, { Allow: "GET, POST" });
      response.end();
      return;
    }

    if (segments.length === 3 && segments[0] === "agent" && segments[1] === "runs") {
      const runId = decodeURIComponent(segments[2]);
      const summary = agentRuns.summarizeRun(runId);

      if (!summary) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendHtml(response, 200, renderAgentRunPage(summary));
      return;
    }

    if (segments.length >= 4 && segments[0] === "agent-runs" && segments[2] === "files") {
      const runId = decodeURIComponent(segments[1]);
      const fileName = segments.slice(3).map(decodeURIComponent).join("/");
      const filePath = agentRuns.resolveRunFilePath(runId, fileName);

      if (!filePath) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendFile(request, response, filePath, getContentType(filePath));
      return;
    }

    if (segments.length === 4 && segments[0] === "api" && segments[1] === "agent" && segments[2] === "models") {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }

      sendJson(
        response,
        200,
        agentRuns.listProviderModels(decodeURIComponent(segments[3]), {
          fresh: url.searchParams.get("refresh") === "1",
          harness: url.searchParams.get("harness") || "none"
        })
      );
      return;
    }

    if (segments.length === 3 && segments[0] === "api" && segments[1] === "agent" && segments[2] === "harnesses") {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }

      sendJson(response, 200, agentRuns.listPrimeHarnesses());
      return;
    }

    if (segments.length === 3 && segments[0] === "api" && segments[1] === "agent" && segments[2] === "environment") {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }

      sendJson(response, 200, await agentRuns.getEnvironmentAsync({ fresh: true }));
      return;
    }

    if (segments.length === 4 && segments[0] === "api" && segments[1] === "agent" && segments[2] === "docker" && segments[3] === "start") {
      if (request.method !== "POST") {
        response.writeHead(405, { Allow: "POST" });
        response.end();
        return;
      }

      sendJson(response, 200, agentRuns.startDocker());
      return;
    }

    if (segments.length === 3 && segments[0] === "api" && segments[1] === "agent" && segments[2] === "runs") {
      if (request.method === "GET") {
        sendJson(
          response,
          200,
          agentRuns.listRuns({
            page: Number(url.searchParams.get("page")) || 1,
            pageSize: Number(url.searchParams.get("page_size")) || 10,
            provider: url.searchParams.get("provider") || "",
            model: url.searchParams.get("model") || "",
            status: url.searchParams.get("status") || "",
            starred: url.searchParams.get("starred") === "1",
            query: url.searchParams.get("q") || "",
            sort: url.searchParams.get("sort") || "newest"
          })
        );
        return;
      }

      if (request.method === "POST") {
        const payload = await readJsonBody(request);
        const runs = agentRuns.launchRuns(payload);
        const waiting = runs.filter((run) => run.status === "waiting").length;
        sendJson(response, 201, {
          run: runs[0],
          runs,
          message:
            runs.length === 1
              ? runs[0].status === "waiting"
                ? `Queued run ${runs[0].id}.`
                : `Launched run ${runs[0].id}.`
              : waiting
                ? `Launched ${runs.length - waiting} run${runs.length - waiting === 1 ? "" : "s"}; ${waiting} waiting.`
                : `Launched ${runs.length} runs.`
        });
        return;
      }

      response.writeHead(405, { Allow: "GET, POST" });
      response.end();
      return;
    }

    if (segments.length === 4 && segments[0] === "api" && segments[1] === "agent" && segments[2] === "runs") {
      const runId = decodeURIComponent(segments[3]);

      if (request.method === "DELETE") {
        sendJson(response, 200, agentRuns.deleteRun(runId));
        return;
      }

      response.writeHead(405, { Allow: "DELETE" });
      response.end();
      return;
    }

    if (
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "leaderboard" &&
      segments[2] === "runs"
    ) {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }
      const leaderboardRun = agentRuns.getLeaderboardRun(decodeURIComponent(segments[3]));
      if (!leaderboardRun) {
        sendJson(response, 404, { error: "Starred run not found." });
        return;
      }
      sendJson(response, 200, leaderboardRun);
      return;
    }

    if (
      (segments.length === 5 || segments.length === 6) &&
      segments[0] === "api" &&
      segments[1] === "agent" &&
      segments[2] === "runs"
    ) {
      const runId = decodeURIComponent(segments[3]);

      if (segments[4] === "summary" && request.method === "GET") {
        sendJson(response, 200, { review: agentRuns.getRunReview(runId) });
        return;
      }

      if (segments[4] === "notes" && request.method === "GET") {
        sendJson(response, 200, { notes: agentRuns.getRunNotes(runId) });
        return;
      }

      if (segments[4] === "notes" && request.method === "PUT") {
        const payload = await readJsonBody(request);
        const notes = agentRuns.setRunNotes(runId, payload?.notes);
        sendJson(response, 200, { notes, message: notes.notes ? "Run notes saved." : "Run notes cleared." });
        return;
      }

      if (segments[4] === "tools" && segments[5] === "execution" && request.method === "GET") {
        const execution = agentRuns.getToolExecution(runId, url.searchParams.get("id"));
        if (!execution) {
          sendHtml(response, 404, renderNotFound());
          return;
        }
        sendJson(response, 200, { execution });
        return;
      }

      if (segments[4] === "tools" && segments[5] === "file" && request.method === "GET") {
        const file = agentRuns.getToolWorkspaceFile(
          runId,
          url.searchParams.get("workspace") || "primary",
          url.searchParams.get("path")
        );
        if (!file) {
          sendHtml(response, 404, renderNotFound());
          return;
        }
        sendJson(response, 200, { file });
        return;
      }

      if (segments[4] === "progress" && request.method === "GET") {
        const progress = agentRuns.getRunProgress(runId, {
          afterTurn: Number(url.searchParams.get("after_turn")) || 0,
          logOffset: Number(url.searchParams.get("log_offset")) || 0
        });

        if (!progress) {
          sendHtml(response, 404, renderNotFound());
          return;
        }

        sendJson(response, 200, progress);
        return;
      }

      if (segments[4] === "stop" && request.method === "POST") {
        sendJson(response, 200, { run: agentRuns.stopRun(runId) });
        return;
      }

      if (segments[4] === "pause" && request.method === "POST") {
        sendJson(response, 200, { run: agentRuns.pauseRun(runId) });
        return;
      }

      if (segments[4] === "resume" && request.method === "POST") {
        sendJson(response, 200, { run: agentRuns.resumeRun(runId) });
        return;
      }

      if (segments[4] === "continue" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const run = agentRuns.continueRun(runId, payload?.moves);
        sendJson(response, 201, { run, message: `Continuing as run ${run.id}.` });
        return;
      }

      if (segments[4] === "favorite" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const run = agentRuns.setRunFavorite(runId, payload?.favorite);
        sendJson(response, 200, {
          run,
          message: run.favorited
            ? "Run added to MazeJam AI leaderboard favorites."
            : "Run removed from MazeJam AI leaderboard favorites."
        });
        return;
      }

      if (segments[4] === "branch" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const run = agentRuns.branchRun(runId, payload?.turn);
        sendJson(response, 201, {
          run,
          message: `Branched action ${run.branch_turn} into run ${run.id}.`
        });
        return;
      }

      if (segments[4] === "budget" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const run = agentRuns.setRunMoveTarget(runId, payload?.moves);
        sendJson(response, 200, { run, message: `Move target updated to ${run.moves}.` });
        return;
      }

      if (segments[4] === "prime-sync" && request.method === "POST") {
        const run = agentRuns.syncPrimeEvaluation(runId);
        sendJson(response, 202, { run, message: "Prime evaluation sync started." });
        return;
      }

      if (segments[4] === "video" && segments[5] === "cancel" && request.method === "POST") {
        const run = agentRuns.cancelRunVideo(runId);
        sendJson(response, 200, { run, message: "Replay video generation canceled." });
        return;
      }

      if (segments[4] === "video" && segments[5] === "regenerate" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const run = agentRuns.regenerateRunVideo(runId, payload);
        sendJson(response, 202, { run, message: "Replay video regeneration started." });
        return;
      }

      if (segments.length === 5 && segments[4] === "video" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const run = agentRuns.generateRunVideo(runId, payload);
        sendJson(response, 202, { run, message: "Replay video generation started." });
        return;
      }

      if (segments[4] === "observations" && request.method === "GET") {
        const observations = agentRuns.getRunObservations(runId, {
          instanceId: url.searchParams.get("instance") || "primary",
          fromTurn: Math.max(0, Number(url.searchParams.get("from_turn")) || 0),
          limit: Math.max(1, Number(url.searchParams.get("limit")) || 1)
        });
        if (!observations) {
          sendHtml(response, 404, renderNotFound());
          return;
        }
        sendJson(response, 200, observations);
        return;
      }

      if (segments[4] === "observation" && request.method === "GET") {
        const observation = await agentRuns.getRunObservation(runId, {
          instanceId: url.searchParams.get("instance") || "primary",
          turn: Math.max(0, Number(url.searchParams.get("turn")) || 0)
        });
        if (!observation) {
          sendHtml(response, 404, renderNotFound());
          return;
        }
        sendJson(response, 200, observation);
        return;
      }

      sendHtml(response, 404, renderNotFound());
      return;
    }

    if (segments.length >= 2 && segments[0] === "api" && segments[1] === "remote") {
      if (segments.length === 3 && segments[2] === "status" && request.method === "GET") {
        sendJson(response, 200, remote.getStatus());
        return;
      }

      if (segments.length === 3 && segments[2] === "disconnect" && request.method === "POST") {
        sendJson(response, 200, await remote.disconnect());
        return;
      }

      if (segments.length === 3 && segments[2] === "origin" && request.method === "POST") {
        const payload = await readJsonBody(request);
        sendJson(response, 200, remote.setOrigin(payload?.origin));
        return;
      }

      if (segments.length === 4 && segments[2] === "link" && segments[3] === "start" && request.method === "GET") {
        const host = request.headers.host || "localhost:3000";
        const callback = `http://${host}/api/remote/link/callback`;
        sendJson(response, 200, { url: remote.deviceLinkUrl(callback) });
        return;
      }

      if (segments.length === 4 && segments[2] === "link" && segments[3] === "callback" && request.method === "GET") {
        const code = url.searchParams.get("code") || "";

        try {
          await remote.completeDeviceLink(code);
          sendRedirect(response, "/build?linked=1");
        } catch (error) {
          sendRedirect(response, `/build?link_error=${encodeURIComponent(error.message)}`);
        }
        return;
      }

      if (segments.length === 3 && segments[2] === "worlds" && request.method === "GET") {
        const view = url.searchParams.get("view") || "drafts";
        sendJson(response, 200, { worlds: await remote.listRemoteWorlds(view) });
        return;
      }

      if (segments.length === 5 && segments[2] === "worlds" && segments[4] === "pull" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const world = await remote.pullWorld(decodeURIComponent(segments[3]), {
          kind: payload?.kind === "online" ? "online" : "draft"
        });
        sendJson(response, 200, { world, message: `Pulled ${world.title}.` });
        return;
      }

      if (segments.length === 3 && segments[2] === "push" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const world = await remote.pushWorld(payload?.game_id);
        sendJson(response, 200, { world, message: `Pushed ${world.title} to ${remote.getStatus().origin}.` });
        return;
      }

      sendHtml(response, 404, renderNotFound());
      return;
    }

    if (segments.length === 3 && segments[0] === "api" && segments[1] === "build" && segments[2] === "worlds") {
      if (request.method === "GET") {
        sendJson(response, 200, { worlds: buildWorlds.listLocalWorlds() });
        return;
      }

      if (request.method === "POST") {
        const payload = await readJsonBody(request);
        let game = null;

        if (payload?.editor_state) {
          game = buildWorlds.createLocalWorld({
            title: payload.title,
            editorState: payload.editor_state
          });
        } else if (payload?.source_game_id) {
          game = buildWorlds.createLocalWorldFromGame(payload.source_game_id, payload.title);
        } else {
          game = buildWorlds.createLocalWorld({
            title: payload?.title,
            worldWidth: payload?.world_width,
            worldHeight: payload?.world_height
          });
        }

        sendJson(response, 201, {
          world: buildWorlds.describeLocalWorld(game.id),
          message: `Created ${game.name}.`
        });
        return;
      }

      response.writeHead(405, { Allow: "GET, POST" });
      response.end();
      return;
    }

    if (segments.length >= 4 && segments[0] === "api" && segments[1] === "build" && segments[2] === "worlds") {
      const worldGameId = decodeURIComponent(segments[3]);

      if (!buildWorlds.isLocalWorldGameId(worldGameId) || !buildWorlds.readDraftMeta(worldGameId)) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (segments.length === 5 && segments[4] === "export" && request.method === "GET") {
        const game = getGame(worldGameId);
        sendJson(response, 200, buildWorlds.editorStateForGame(game));
        return;
      }

      if (segments.length === 4 && request.method === "PATCH") {
        const payload = await readJsonBody(request);
        const patch = {};
        const messages = [];

        if (Object.prototype.hasOwnProperty.call(payload || {}, "title")) {
          const title = typeof payload.title === "string" ? payload.title.trim() : "";
          if (!title) {
            sendJson(response, 400, { error: "A non-empty title is required." });
            return;
          }
          patch.title = title;
          messages.push(`Renamed to ${title}.`);
        }

        if (Object.prototype.hasOwnProperty.call(payload || {}, "start_level_id")) {
          const startLevelId = String(payload.start_level_id || "");
          const game = getGame(worldGameId);
          if (!game || !game.worldMap?.byPosition?.has(startLevelId)) {
            sendJson(response, 400, { error: "Choose a saved room as the starting room." });
            return;
          }
          patch.default_level_id = startLevelId;
          messages.push(`Starting room set to ${startLevelId.replace(/^level_/, "")}.`);
        }

        if (Object.keys(patch).length === 0) {
          sendJson(response, 400, { error: "No supported world changes were provided." });
          return;
        }

        buildWorlds.updateDraftMeta(worldGameId, patch);
        sendJson(response, 200, {
          world: buildWorlds.describeLocalWorld(worldGameId),
          message: messages.join(" ")
        });
        return;
      }

      if (segments.length === 4 && request.method === "DELETE") {
        buildWorlds.removeLocalWorld(worldGameId);
        sendJson(response, 200, { message: `Deleted ${worldGameId}.` });
        return;
      }

      response.writeHead(405, { Allow: "GET, PATCH, DELETE" });
      response.end();
      return;
    }

    if (segments.length === 3 && segments[0] === "games" && segments[2] === "level_parsing.json") {
      const parserPath = path.join(gamesDir, segments[1], "level_parsing.json");
      if (!fs.existsSync(parserPath)) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendJson(response, 200, loadJson(parserPath, {}));
      return;
    }

    if (segments.length === 2 && segments[0] === "games") {
      const game = getGame(segments[1]);
      if (!game) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendHtml(response, 200, renderGamePage(game));
      return;
    }

    if (segments.length === 2 && segments[0] === "author") {
      const game = getGame(segments[1]);
      if (!game || !game.worldMap) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      const level = getEditableLevel(game, defaultLevelIdForGame(game));
      if (!level) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendHtml(response, 200, renderAuthorPage(game, level));
      return;
    }

    if (segments.length === 2 && segments[0] === "world-map") {
      const game = getGame(segments[1]);
      if (!game || !game.worldMap) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendHtml(response, 200, renderWorldMapEditorPage(game));
      return;
    }

    if (segments.length === 3 && segments[0] === "author") {
      const game = getGame(segments[1]);
      if (!game || !game.worldMap) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (!isWorldLevelId(game, segments[2])) {
        sendRedirect(
          response,
          `/author/${encodeURIComponent(game.id)}/${encodeURIComponent(defaultLevelIdForGame(game))}`
        );
        return;
      }

      const level = getEditableLevel(game, segments[2]);
      if (!level) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendHtml(response, 200, renderAuthorPage(game, level));
      return;
    }

    if (segments.length === 2 && segments[0] === "play") {
      const game = getGame(segments[1]);
      if (!game) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      const levelId = defaultLevelIdForGame(game);
      if (!levelId) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendRedirect(response, `/play/${encodeURIComponent(game.id)}/${encodeURIComponent(levelId)}`);
      return;
    }

    if (segments.length === 2 && segments[0] === "flyover") {
      const game = getGame(segments[1]);
      if (!game || !game.worldMap) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      const levelId = defaultLevelIdForGame(game);
      if (!levelId) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendRedirect(response, `/flyover/${encodeURIComponent(game.id)}/${encodeURIComponent(levelId)}`);
      return;
    }

    if (segments.length === 3 && segments[0] === "flyover") {
      const game = getGame(segments[1]);
      if (!game || !game.worldMap) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (!isWorldLevelId(game, segments[2])) {
        sendRedirect(
          response,
          `/flyover/${encodeURIComponent(game.id)}/${encodeURIComponent(defaultLevelIdForGame(game))}`
        );
        return;
      }

      const level = getLevel(game, segments[2]);
      if (!level) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendHtml(response, 200, renderFlyoverPage(game, level));
      return;
    }

    if (segments.length === 3 && segments[0] === "play") {
      const game = getGame(segments[1]);
      if (!game) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (game.worldMap && !isWorldLevelId(game, segments[2])) {
        sendRedirect(
          response,
          `/play/${encodeURIComponent(game.id)}/${encodeURIComponent(defaultLevelIdForGame(game))}`
        );
        return;
      }

      const level = getLevel(game, segments[2]);
      if (!level) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendHtml(response, 200, renderPlayPage(game, level));
      return;
    }

    if (segments.length === 4 && segments[0] === "api" && segments[1] === "play") {
      const game = getGame(segments[2]);
      if (!game) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (game.worldMap && !isWorldLevelId(game, segments[3])) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      const level = getLevel(game, segments[3]);
      if (!level) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendJson(response, 200, getLevelState(game, level));
      return;
    }

    if (
      segments.length >= 5 &&
      segments.length <= 7 &&
      segments[0] === "api" &&
      segments[1] === "author" &&
      segments[4] === "solution-export"
    ) {
      const game = getGame(segments[2]);
      if (!game || !game.worldMap || !isWorldLevelId(game, segments[3])) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      const level = getLevel(game, segments[3]);
      if (!level) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (segments.length === 5) {
        if (request.method !== "POST") {
          response.writeHead(405, { Allow: "POST" });
          response.end();
          return;
        }

        const payload = await readJsonBody(request);
        const job = solverExports.start({
          format: url.searchParams.get("format") || "mp4",
          gameId: game.id,
          levelId: level.id,
          payload
        });
        const jobUrl = `${url.pathname}/${encodeURIComponent(job.id)}`;
        sendJson(response, 202, {
          ...job,
          downloadUrl: `${jobUrl}/download`,
          statusUrl: jobUrl
        });
        return;
      }

      const identity = {
        gameId: game.id,
        jobId: segments[5],
        levelId: level.id
      };
      const job = solverExports.status(identity);
      if (!job) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (segments.length === 6) {
        if (request.method === "DELETE") {
          solverExports.cancel(identity);
          response.writeHead(204, { "Cache-Control": "no-store" });
          response.end();
          return;
        }
        if (request.method !== "GET") {
          response.writeHead(405, { Allow: "DELETE, GET" });
          response.end();
          return;
        }
        sendJson(response, 200, job);
        return;
      }

      if (segments[6] !== "download") {
        sendHtml(response, 404, renderNotFound());
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }
      if (job.status !== "ready") {
        sendJson(response, 409, job);
        return;
      }

      const artifact = solverExports.artifact(identity);
      if (!artifact) {
        sendHtml(response, 404, renderNotFound());
        return;
      }
      const stats = fs.statSync(artifact.filePath);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${artifact.fileName}"`,
        "Content-Length": stats.size,
        "Content-Type": artifact.contentType
      });
      const stream = fs.createReadStream(artifact.filePath);
      stream.once("close", artifact.cleanup);
      stream.once("error", () => response.destroy());
      stream.pipe(response);
      return;
    }

    if (
      segments.length === 5 &&
      segments[0] === "api" &&
      segments[1] === "author" &&
      segments[4] === "preview"
    ) {
      const game = getGame(segments[2]);
      if (!game || !game.worldMap || !isWorldLevelId(game, segments[3])) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (request.method !== "POST") {
        response.writeHead(405, { Allow: "POST" });
        response.end();
        return;
      }

      const level = getLevel(game, segments[3]);
      if (!level) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      const payload = await readJsonBody(request, { maxBytes: PREVIEW_REQUEST_BODY_MAX_BYTES });
      writeMazePreviewImageData(game, level, payload?.imageDataUrl);
      sendJson(response, 200, {
        fileName: level.fileName,
        levelId: level.id,
        message: `Saved preview for ${level.fileName}.`,
        previewUrl: buildMazePreviewData(game, level.fileName).previewUrl
      });
      return;
    }

    if (segments.length === 4 && segments[0] === "api" && segments[1] === "author") {
      const game = getGame(segments[2]);
      if (!game || !game.worldMap || !isWorldLevelId(game, segments[3])) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (request.method === "GET") {
        const level = getEditableLevel(game, segments[3]);
        if (!level) {
          sendHtml(response, 404, renderNotFound());
          return;
        }

        sendJson(response, 200, getLevelEditorState(game, level));
        return;
      }

      if (request.method === "POST") {
        const payload = await readJsonBody(request);
        const level = getEditableLevel(game, segments[3], payload?.fileName);
        if (!level) {
          sendHtml(response, 404, renderNotFound());
          return;
        }

        const editorState = sanitizeEditorPayload(game, payload);
        const levelPath = getLevelFilePath(game, level);
        fs.writeFileSync(levelPath, editorState.rawText, "utf8");
        worldMaps.ensureMazeWorldLevelMapped(game, level);
        buildWorlds.touchLocalWorld(game.id);
        sendJson(response, 200, {
          ...getLevelEditorState(game, level),
          message: `Saved ${level.fileName}.`,
          playUrl: `/play/${encodeURIComponent(game.id)}/${encodeURIComponent(level.id)}`
        });
        return;
      }

      response.writeHead(405, { Allow: "GET, POST" });
      response.end();
      return;
    }

    if (
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "world-map" &&
      segments[3] === "swap"
    ) {
      const game = getGame(segments[2]);
      if (!game || !game.worldMap) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (request.method === "POST") {
        const payload = await readJsonBody(request);
        const entries = worldMaps.swapMazeWorldRooms(
          game,
          String(payload?.firstLevelId || ""),
          String(payload?.secondLevelId || "")
        );
        worldMaps.writeMazeWorldMap(game.id, entries);
        buildWorlds.touchLocalWorld(game.id);
        sendJson(
          response,
          200,
          buildMazeWorldMapEditorData(getGame(game.id), {
            message: `Swapped ${payload.firstLevelId} and ${payload.secondLevelId}.`
          })
        );
        return;
      }

      response.writeHead(405, { Allow: "POST" });
      response.end();
      return;
    }

    if (segments.length === 3 && segments[0] === "api" && segments[1] === "world-map") {
      const game = getGame(segments[2]);
      if (!game || !game.worldMap) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (request.method === "GET") {
        sendJson(response, 200, buildMazeWorldMapEditorData(game));
        return;
      }

      if (request.method === "POST") {
        const payload = await readJsonBody(request);
        const rawLevels =
          payload && Object.prototype.hasOwnProperty.call(payload, "entries")
            ? payload.entries
            : payload?.levels;
        const entries = worldMaps.validateMazeWorldMapEntries(game.id, game.levelFiles, rawLevels);
        worldMaps.writeMazeWorldMap(game.id, entries);
        buildWorlds.touchLocalWorld(game.id);
        sendJson(
          response,
          200,
          buildMazeWorldMapEditorData(getGame(game.id), {
            message: `Saved world_map.json with ${entries.length} placed tile${entries.length === 1 ? "" : "s"}.`
          })
        );
        return;
      }

      response.writeHead(405, { Allow: "GET, POST" });
      response.end();
      return;
    }

    sendHtml(response, 404, renderNotFound());
  }

  return {
    handleRequest
  };
}

function validateLocalApiRequest(request, url, segments) {
  const host = String(request.headers.host || "");
  if (!isLoopbackRequest(request)) {
    return {
      status: 403,
      message: "Local API requests require a loopback Host and TCP peer."
    };
  }

  const isLinkCallback =
    request.method === "GET" &&
    segments.length === 4 &&
    segments[1] === "remote" &&
    segments[2] === "link" &&
    segments[3] === "callback";
  if (isLinkCallback) {
    const fetchSite = String(request.headers["sec-fetch-site"] || "").toLowerCase();
    const fetchMode = String(request.headers["sec-fetch-mode"] || "").toLowerCase();
    const fetchDest = String(request.headers["sec-fetch-dest"] || "").toLowerCase();
    if (
      fetchSite &&
      fetchSite !== "same-origin" &&
      fetchSite !== "none" &&
      (fetchMode !== "navigate" || fetchDest !== "document")
    ) {
      return { status: 403, message: "Local link callbacks require a top-level navigation." };
    }
  } else {
    const expectedOrigin = new URL(`http://${host}`).origin;
    const origin = String(request.headers.origin || "");
    if (origin && origin !== expectedOrigin) {
      return { status: 403, message: "Cross-site local API requests are not allowed." };
    }
    const fetchSite = String(request.headers["sec-fetch-site"] || "").toLowerCase();
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      return { status: 403, message: "Cross-site local API requests are not allowed." };
    }
  }

  if (UNSAFE_METHODS.has(String(request.method || "").toUpperCase())) {
    const contentType = String(request.headers["content-type"] || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      return { status: 415, message: "Local API mutations require application/json." };
    }
  }
  return null;
}

function isLoopbackRequest(request) {
  return (
    isLoopbackHost(request?.headers?.host) &&
    isLoopbackPeer(request?.socket?.remoteAddress)
  );
}

module.exports = {
  createRequestRouter
};
