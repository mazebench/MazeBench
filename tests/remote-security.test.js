const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  browserHostForBind,
  isLoopbackHost,
  isLoopbackPeer
} = require("../server/network.js");
const { createRemoteService } = require("../server/remote.js");
const { createRequestRouter } = require("../server/router.js");

async function main() {
  assertLoopbackAddressHandling();
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-remote-flow-"));
  const originalFetch = global.fetch;
  const requests = [];
  let draftMeta = {};
  let returnedDescription = null;
  let importedWorld = null;
  const editorState = {
    title: "Local Draft",
    world: { height: 1, width: 1 },
    levels: [
      {
        id: "level_AxA",
        column: "A",
        row: "A",
        title: "Room A1",
        height: 3,
        width: 3,
        cells: [["#", "#", "#"], ["#", "p", "#"], ["#", "G", "#"]]
      }
    ]
  };
  const loadJson = (filePath, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return fallback;
    }
  };
  const remote = createRemoteService({
    buildWorlds: {
      createLocalWorld(options) {
        importedWorld = structuredClone(options);
        return { id: "draft-import", title: options.title };
      },
      describeLocalWorld(id) {
        if (id === "draft-import") {
          return { id, title: importedWorld.title };
        }
        returnedDescription = { id, remote: { ...draftMeta } };
        return returnedDescription;
      },
      editorStateForGame() {
        return structuredClone(editorState);
      },
      isLocalWorldGameId(id) {
        return id === "draft-local";
      },
      listLocalWorlds() {
        return [];
      },
      readDraftMeta() {
        return { ...draftMeta };
      },
      updateDraftMeta(_id, nextMeta) {
        draftMeta = { ...nextMeta };
      }
    },
    ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
    getGame: (id) => id === "draft-local" ? { worldMap: {} } : null,
    loadJson,
    rootDir
  });

  try {
    await remote.disconnect();
    const callback = "http://localhost:3000/api/remote/link/callback";
    const linkUrl = new URL(remote.deviceLinkUrl(callback));
    const linkConfig = loadJson(path.join(rootDir, "data", "remote.json"), {});
    const expectedChallenge = crypto
      .createHash("sha256")
      .update(linkConfig.pending_link.code_verifier, "ascii")
      .digest("base64url");
    assert.equal(linkUrl.searchParams.get("code_challenge"), expectedChallenge);
    assert.equal(linkUrl.searchParams.has("token"), false);

    global.fetch = async (url, options = {}) => {
      const parsedUrl = new URL(String(url));
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ body, headers: options.headers || {}, method: options.method, url: parsedUrl });

      if (parsedUrl.pathname === "/api/local-link/exchange") {
        assert.equal(options.method, "POST");
        assert.equal(options.headers?.cookie, undefined, "the browser credential must not be sent during code exchange");
        assert.equal(body.code, linkCode);
        assert.equal(body.code_verifier, linkConfig.pending_link.code_verifier);
        return Response.json({
          expires_in: 86400,
          scope: "draft_sync",
          token: "sess_111111111111111111111111"
        });
      }
      if (parsedUrl.pathname === "/api/session") {
        if (options.method === "DELETE") {
          return Response.json({ authenticated: false });
        }
        assert.equal(
          options.headers?.cookie,
          "mazebench_session=sess_111111111111111111111111"
        );
        return Response.json({
          authenticated: true,
          user: {
            id: "user_1",
            mazebench_user_id: "player_one",
            name: "Player One",
            session_scope: "draft_sync"
          }
        });
      }
      if (parsedUrl.pathname === "/api/build/worlds" && options.method === "POST") {
        assert.equal(
          options.headers?.cookie,
          "mazebench_session=sess_111111111111111111111111"
        );
        assert.deepEqual(body, {
          title: "Local Draft",
          world_height: 1,
          world_width: 1
        });
        return Response.json({
          world: { id: "mbw_remote", status: "draft", updated_at: "2026-07-27 01:00:00" }
        });
      }
      if (parsedUrl.pathname === "/api/build/worlds/mbw_remote" && options.method === "PATCH") {
        assert.equal(
          options.headers?.cookie,
          "mazebench_session=sess_111111111111111111111111"
        );
        assert.deepEqual(body.editor_state, editorState);
        assert.equal(body.title, "Local Draft");
        assert.equal(body.world_height, 1);
        assert.equal(body.world_width, 1);
        return Response.json({
          world: { id: "mbw_remote", status: "draft", updated_at: "2026-07-27 01:01:00" }
        });
      }
      throw new Error(`Unexpected remote request: ${options.method} ${parsedUrl.pathname}`);
    };

    const linkCode = `mbl_${"c".repeat(43)}`;
    const status = await remote.completeDeviceLink(linkCode);
    assert.equal(status.connected, true);
    assert.equal(status.user.session_scope, "draft_sync");
    const linkedConfig = loadJson(path.join(rootDir, "data", "remote.json"), {});
    assert.equal(linkedConfig.pending_link, null);
    assert.equal(linkedConfig.session_token, "sess_111111111111111111111111");
    assert.equal(fs.statSync(path.join(rootDir, "data", "remote.json")).mode & 0o777, 0o600);

    const pushed = await remote.pushWorld("draft-local");
    assert.deepEqual(pushed, returnedDescription);
    assert.equal(draftMeta.remote_id, "mbw_remote");
    assert.equal(draftMeta.remote_status, "draft");
    assert.equal(
      requests.filter(({ url }) => url.pathname === "/api/build/worlds").length,
      1,
      "a new remote draft is created exactly once"
    );
    assert.equal(
      requests.filter(({ url }) => url.pathname === "/api/build/worlds/mbw_remote").length,
      1,
      "the real client then sends its bounded editor_state PATCH"
    );

    await remote.disconnect();
    const revoke = requests.find(({ method, url }) =>
      method === "DELETE" && url.pathname === "/api/session"
    );
    assert.ok(revoke, "disconnect must revoke the hosted draft-sync session");
    assert.equal(
      revoke.headers.cookie,
      "mazebench_session=sess_111111111111111111111111"
    );
    assert.equal(loadJson(path.join(rootDir, "data", "remote.json"), {}).session_token, "");

    global.fetch = async (url, options = {}) => {
      const parsedUrl = new URL(String(url));
      if (parsedUrl.pathname !== "/api/session") {
        throw new Error(`Unexpected request: ${parsedUrl.pathname}`);
      }
      assert.equal(options.headers?.cookie, "mazebench_session=sess_web");
      return Response.json({
        authenticated: true,
        user: { id: "admin_1", role: "admin", session_scope: "web" }
      });
    };
    await assert.rejects(
      remote.connectWithToken("sess_web"),
      /Browser session tokens cannot be linked to localhost/
    );
    const rejectedConfig = loadJson(path.join(rootDir, "data", "remote.json"), {});
    assert.equal(rejectedConfig.session_token, "");
    assert.equal(rejectedConfig.user, null);

    assert.throws(
      () => remote.setOrigin("https://attacker.example"),
      /valid http\\(s\\) URL|valid http\\(s\\)|valid|Origin/,
      "remote origins must be an exact MazeBench HTTPS allowlist entry"
    );
    for (const alias of [
      "https://mazebench-prod.pages.dev",
      "https://www.mazebench.com"
    ]) {
      assert.throws(
        () => remote.setOrigin(alias),
        /approved MazeBench HTTPS URL/,
        `${alias} must not receive or bind a local session credential`
      );
    }
    fs.writeFileSync(
      path.join(rootDir, "data", "remote.json"),
      `${JSON.stringify({
        origin: "https://dev.mazebench.com",
        pending_link: { code_verifier: "secret" },
        session_origin: "https://dev.mazebench.com",
        session_token: "sess_stale",
        user: { id: "user_1" },
        linked_at: "2026-07-27T01:00:00.000Z"
      })}\n`,
      { mode: 0o600 }
    );
    remote.setOrigin("https://mazebench.com");
    const changedOriginConfig = loadJson(path.join(rootDir, "data", "remote.json"), {});
    assert.equal(changedOriginConfig.origin, "https://mazebench.com");
    assert.equal(changedOriginConfig.pending_link, null);
    assert.equal(changedOriginConfig.session_origin, "");
    assert.equal(changedOriginConfig.session_token, "");
    assert.equal(changedOriginConfig.user, null);

    remote.setOrigin("https://dev.mazebench.com");
    const publicRequests = [];
    global.fetch = async (url, options = {}) => {
      const parsedUrl = new URL(String(url));
      publicRequests.push({ headers: options.headers || {}, method: options.method, url: parsedUrl });
      assert.equal(options.headers?.cookie, undefined, "public export must never receive a session cookie");
      if (parsedUrl.pathname === "/api/build/worlds") {
        return Response.json({
          worlds: [{ id: "community_world", title: "Community World", status: "published" }]
        });
      }
      if (!parsedUrl.searchParams.has("v")) {
        return new Response(null, {
          status: 307,
          headers: {
            location: "/api/build/worlds/community_world/export?v=4"
          }
        });
      }
      return Response.json({
        world: {
          id: "community_world",
          title: "Community World",
          status: "published",
          editor_state: editorState
        }
      });
    };
    const pulled = await remote.pullWorld("community_world", { kind: "draft" });
    assert.equal(pulled.id, "draft-import");
    assert.equal(importedWorld.prefix, "draft");
    assert.deepEqual(importedWorld.editorState, editorState);
    assert.equal(publicRequests.length, 2);
    assert.ok(publicRequests.every(({ url }) => url.pathname.endsWith("/export")));
    const communityWorlds = await remote.listRemoteWorlds("community");
    assert.equal(communityWorlds[0].id, "community_world");
    const communityRequest = publicRequests.at(-1);
    assert.equal(communityRequest.url.searchParams.get("view"), "community");
    assert.equal(communityRequest.headers.cookie, undefined);

    let networkCalls = 0;
    fs.writeFileSync(
      path.join(rootDir, "data", "remote.json"),
      `${JSON.stringify({
        origin: "http://attacker.example",
        session_origin: "http://attacker.example",
        session_token: "sess_stolen"
      })}\n`,
      { mode: 0o600 }
    );
    global.fetch = async () => {
      networkCalls += 1;
      throw new Error("must not fetch");
    };
    await assert.rejects(
      remote.listRemoteWorlds("drafts"),
      /origin is not trusted/
    );
    assert.equal(networkCalls, 0, "a tampered config cannot exfiltrate a credential");

    await assertLocalRouterGuards();
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function assertLoopbackAddressHandling() {
  for (const address of [
    "127.0.0.1",
    "127.255.255.254",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "0:0:0:0:0:ffff:7f00:1"
  ]) {
    assert.equal(isLoopbackPeer(address), true, `${address} must be a loopback TCP peer`);
  }
  for (const address of [
    "",
    "0.0.0.0",
    "128.0.0.1",
    "192.0.2.10",
    "::",
    "::ffff:192.0.2.10"
  ]) {
    assert.equal(isLoopbackPeer(address), false, `${address || "empty"} must not be trusted`);
  }
  for (const host of [
    "localhost:3000",
    "127.0.0.1:3000",
    "127.255.255.254:3000",
    "[::1]:3000",
    "[::ffff:127.0.0.1]:3000"
  ]) {
    assert.equal(isLoopbackHost(host), true, `${host} must be a loopback Host`);
  }
  for (const host of [
    "",
    "attacker.example:3000",
    "0.0.0.0:3000",
    "192.0.2.10:3000",
    "[::]:3000",
    "[::ffff:192.0.2.10]:3000"
  ]) {
    assert.equal(isLoopbackHost(host), false, `${host || "empty"} must not be trusted`);
  }
  assert.equal(browserHostForBind("0.0.0.0"), "localhost");
  assert.equal(browserHostForBind("::"), "localhost");
  assert.equal(browserHostForBind("*"), "localhost");
  assert.equal(browserHostForBind("127.0.0.1"), "127.0.0.1");
  assert.equal(browserHostForBind("::1"), "[::1]");
}

async function assertLocalRouterGuards() {
  let remoteOriginChanges = 0;
  let paidLaunches = 0;
  let callbacks = 0;
  let remoteWorldReads = 0;
  const remote = {
    async completeDeviceLink() {
      callbacks += 1;
    },
    async disconnect() {
      return { connected: false };
    },
    getStatus() {
      return { connected: false, origin: "https://dev.mazebench.com" };
    },
    async listRemoteWorlds() {
      remoteWorldReads += 1;
      return [];
    },
    setOrigin() {
      remoteOriginChanges += 1;
      return {};
    }
  };
  const sendJson = (response, status, payload) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };
  const sendHtml = (response, status, payload) => {
    response.writeHead(status, { "content-type": "text/html" });
    response.end(String(payload || ""));
  };
  const sendRedirect = (response, location, status = 302) => {
    response.writeHead(status, { location });
    response.end();
  };
  const router = createRequestRouter({
    agentRuns: {
      launchRuns() {
        paidLaunches += 1;
        return [];
      }
    },
    publicFileRoutes: new Map(),
    readJsonBody() {
      throw new Error("Rejected requests must not parse their body.");
    },
    remote,
    renderNotFound: () => "not found",
    sendHtml,
    sendJson,
    sendRedirect
  });

  const invoke = async ({
    headers = {},
    method = "GET",
    remoteAddress = "127.0.0.1",
    url
  }) => {
    const result = { body: "", headers: {}, status: 0 };
    const response = {
      end(body = "") {
        result.body = String(body || "");
      },
      writeHead(status, responseHeaders = {}) {
        result.status = status;
        result.headers = responseHeaders;
      }
    };
    await router.handleRequest({
      headers: {
        host: "127.0.0.1:3000",
        ...headers
      },
      method,
      socket: { remoteAddress },
      url
    }, response);
    return result;
  };

  const crossSiteOrigin = await invoke({
    headers: {
      "content-type": "text/plain",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site"
    },
    method: "POST",
    url: "/api/remote/origin"
  });
  assert.equal(crossSiteOrigin.status, 403);
  assert.equal(remoteOriginChanges, 0);

  const crossSitePaidLaunch = await invoke({
    headers: {
      "content-type": "text/plain",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site"
    },
    method: "POST",
    url: "/api/agent/runs"
  });
  assert.equal(crossSitePaidLaunch.status, 403);
  assert.equal(paidLaunches, 0);

  const sameOriginTextPlain = await invoke({
    headers: {
      "content-type": "text/plain",
      origin: "http://127.0.0.1:3000",
      "sec-fetch-site": "same-origin"
    },
    method: "POST",
    url: "/api/remote/origin"
  });
  assert.equal(sameOriginTextPlain.status, 415);
  assert.equal(remoteOriginChanges, 0);

  const rebound = await invoke({
    headers: { host: "attacker.example:3000" },
    url: "/api/remote/worlds?view=drafts"
  });
  assert.equal(rebound.status, 403);
  assert.equal(remoteWorldReads, 0);

  const reboundHtml = await invoke({
    headers: { host: "attacker.example:3000" },
    url: "/build"
  });
  assert.equal(reboundHtml.status, 403);

  const spoofedLoopbackHost = await invoke({
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "sec-fetch-site": "same-origin"
    },
    method: "POST",
    remoteAddress: "192.0.2.10",
    url: "/api/agent/runs"
  });
  assert.equal(spoofedLoopbackHost.status, 403);
  assert.equal(paidLaunches, 0, "a remote peer cannot bypass the guard with a spoofed Host");

  const mappedRemotePeer = await invoke({
    headers: { host: "localhost:3000" },
    remoteAddress: "::ffff:192.0.2.10",
    url: "/build"
  });
  assert.equal(mappedRemotePeer.status, 403);

  for (const remoteAddress of [
    "127.0.0.1",
    "127.255.255.254",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "0:0:0:0:0:ffff:7f00:1"
  ]) {
    const loopback = await invoke({
      headers: { "sec-fetch-site": "same-origin" },
      remoteAddress,
      url: "/api/remote/status"
    });
    assert.equal(loopback.status, 200, `${remoteAddress} must remain a valid local peer`);
  }

  const missingPeer = await invoke({
    headers: { host: "localhost:3000" },
    remoteAddress: "",
    url: "/build"
  });
  assert.equal(missingPeer.status, 403, "missing TCP peer data must fail closed");

  const status = await invoke({
    headers: { "sec-fetch-site": "same-origin" },
    url: "/api/remote/status"
  });
  assert.equal(status.status, 200);

  const removedManualConnect = await invoke({
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:3000",
      "sec-fetch-site": "same-origin"
    },
    method: "POST",
    url: "/api/remote/connect"
  });
  assert.equal(removedManualConnect.status, 404);

  const callback = await invoke({
    headers: {
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "cross-site"
    },
    url: `/api/remote/link/callback?code=mbl_${"c".repeat(43)}`
  });
  assert.equal(callback.status, 302);
  assert.equal(callbacks, 1, "the PKCE callback remains the sole cross-site API navigation");

  const imageCallback = await invoke({
    headers: {
      "sec-fetch-dest": "image",
      "sec-fetch-mode": "no-cors",
      "sec-fetch-site": "cross-site"
    },
    url: `/api/remote/link/callback?code=mbl_${"d".repeat(43)}`
  });
  assert.equal(imageCallback.status, 403);
  assert.equal(callbacks, 1);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
