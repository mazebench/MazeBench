const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Bridge to the hosted site (mazebench.com, with dev.mazebench.com retained
// for explicit development use). The hosted API is session-cookie based with
// no CORS headers, so the browser never talks to it directly: this local
// server holds the session token in data/remote.json and makes server-to-server
// calls with a Cookie header.
//
// Connecting an account:
//   1. Device link (preferred): open <origin>/link-local?return_to=<local
//      callback>. The hosted site (once it ships the endpoint) asks the
//      signed-in user to approve, then redirects back with a short-lived
//      PKCE-bound code. This server exchanges it for a draft-sync-only token.

const SESSION_COOKIE = "mazebench_session";
const DEFAULT_ORIGIN = "https://mazebench.com";
const REQUEST_TIMEOUT_MS = 20000;
const ALLOWED_REMOTE_ORIGINS = new Set([
  "https://dev.mazebench.com",
  "https://mazebench.com"
]);

function createRemoteService({ buildWorlds, ensureDirectory, getGame, loadJson, rootDir }) {
  const dataDir = path.join(rootDir, "data");
  const configPath = path.join(dataDir, "remote.json");

  function readConfig() {
    return {
      origin: DEFAULT_ORIGIN,
      pending_link: null,
      session_origin: "",
      session_token: "",
      user: null,
      linked_at: null,
      ...(loadJson(configPath, null) || {})
    };
  }

  function writeConfig(config) {
    ensureDirectory(dataDir);
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    // writeFile's mode only applies when creating a file. Tighten existing
    // configs too because this file contains the hosted session cookie.
    fs.chmodSync(configPath, 0o600);
  }

  function sanitizeOrigin(value) {
    try {
      const url = new URL(String(value));
      return ALLOWED_REMOTE_ORIGINS.has(url.origin) && url.href === `${url.origin}/`
        ? url.origin
        : null;
    } catch (error) {
      return null;
    }
  }

  async function remoteFetch(
    pathname,
    {
      method = "GET",
      body = undefined,
      auth = false,
      followSameOriginRedirect = false,
      sendSession = true
    } = {}
  ) {
    const config = readConfig();
    const origin = sanitizeOrigin(config.origin);
    if (!origin) {
      throw new Error("The configured MazeBench origin is not trusted.");
    }
    const headers = { accept: "application/json" };

    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const sessionBoundToOrigin =
      Boolean(config.session_token) &&
      config.session_origin === origin;
    if (auth) {
      if (!sessionBoundToOrigin) {
        throw new Error("Not connected to a mazebench.com account.");
      }

      headers.cookie = `${SESSION_COOKIE}=${config.session_token}`;
    } else if (sendSession && sessionBoundToOrigin) {
      // Send the cookie opportunistically so owner-only resources work too.
      headers.cookie = `${SESSION_COOKIE}=${config.session_token}`;
    }

    let response;

    try {
      response = await fetch(`${origin}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (followSameOriginRedirect && isRedirect(response.status)) {
        const location = response.headers.get("location");
        const redirectUrl = location ? new URL(location, origin) : null;
        if (!redirectUrl || redirectUrl.origin !== origin) {
          throw new Error("The hosted site returned an unsafe redirect.");
        }
        response = await fetch(redirectUrl, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "manual",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
      }
    } catch (error) {
      throw new Error(`Could not reach ${origin}: ${error instanceof Error ? error.message : error}`);
    }

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const message = payload?.error || payload?.message || `${response.status} ${response.statusText}`;
      throw new Error(`${origin}${pathname} failed: ${message}`);
    }

    return payload;
  }

  function getStatus() {
    const config = readConfig();

    return {
      origin: config.origin,
      connected: Boolean(
        config.session_token &&
        sanitizeOrigin(config.origin) &&
        config.session_origin === sanitizeOrigin(config.origin)
      ),
      user: config.user,
      linked_at: config.linked_at
    };
  }

  function setOrigin(value) {
    const origin = sanitizeOrigin(value);

    if (!origin) {
      throw new Error("Origin must be an approved MazeBench HTTPS URL.");
    }

    const config = readConfig();
    writeConfig(
      config.origin === origin
        ? { ...config, origin }
        : {
            ...config,
            origin,
            pending_link: null,
            session_origin: "",
            session_token: "",
            user: null,
            linked_at: null
          }
    );
    return getStatus();
  }

  async function connectWithToken(token) {
    const trimmed = String(token || "").trim();

    if (!trimmed) {
      throw new Error("A session token is required.");
    }

    const config = readConfig();
    const origin = sanitizeOrigin(config.origin);
    if (!origin) {
      throw new Error("The configured MazeBench origin is not trusted.");
    }
    writeConfig({ ...config, session_origin: origin, session_token: trimmed });

    let session;

    try {
      session = await remoteFetch("/api/session", { auth: true });
    } catch (error) {
      writeConfig({
        ...config,
        session_origin: "",
        session_token: "",
        user: null,
        linked_at: null
      });
      throw error;
    }

    if (!session?.authenticated || !session?.user) {
      writeConfig({
        ...config,
        session_origin: "",
        session_token: "",
        user: null,
        linked_at: null
      });
      throw new Error("That token is not an active mazebench.com session.");
    }
    if (session.user.session_scope !== "draft_sync") {
      writeConfig({ ...config, session_token: "", user: null, linked_at: null });
      throw new Error(
        "Browser session tokens cannot be linked to localhost. Use the secure Link Local flow."
      );
    }

    writeConfig({
      ...readConfig(),
      pending_link: null,
      user: session.user,
      linked_at: new Date().toISOString()
    });
    return getStatus();
  }

  async function disconnect() {
    const config = readConfig();
    try {
      if (
        config.session_token &&
        config.session_origin === sanitizeOrigin(config.origin)
      ) {
        await remoteFetch("/api/session", { auth: true, method: "DELETE" });
      }
    } catch {
      // Local revocation is unconditional. The hosted credential expires
      // within 24 hours even if the network is unavailable during disconnect.
    } finally {
      writeConfig({
        ...readConfig(),
        pending_link: null,
        session_origin: "",
        session_token: "",
        user: null,
        linked_at: null
      });
    }
    return getStatus();
  }

  function deviceLinkUrl(localCallbackUrl) {
    const config = readConfig();
    const origin = sanitizeOrigin(config.origin);
    if (!origin) {
      throw new Error("The configured MazeBench origin is not trusted.");
    }
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier, "ascii")
      .digest("base64url");
    writeConfig({
      ...config,
      pending_link: {
        code_verifier: codeVerifier,
        created_at: new Date().toISOString(),
        return_to: localCallbackUrl
      }
    });
    const url = new URL("/link-local", origin);

    url.searchParams.set("return_to", localCallbackUrl);
    url.searchParams.set("code_challenge", codeChallenge);
    return url.toString();
  }

  async function completeDeviceLink(code) {
    const normalizedCode = String(code || "");
    if (!/^mbl_[A-Za-z0-9_-]{43}$/.test(normalizedCode)) {
      throw new Error("The local link code is invalid. Start Link Local again.");
    }
    const config = readConfig();
    const pending = config.pending_link;
    const createdAt = Date.parse(pending?.created_at || "");
    if (
      !pending?.code_verifier ||
      !Number.isFinite(createdAt) ||
      Date.now() - createdAt > 10 * 60 * 1000
    ) {
      throw new Error("The local link request expired. Start Link Local again.");
    }
    const exchange = await remoteFetch("/api/local-link/exchange", {
      body: {
        code: normalizedCode,
        code_verifier: pending.code_verifier
      },
      method: "POST",
      sendSession: false
    });
    if (exchange?.scope !== "draft_sync" || !exchange?.token) {
      throw new Error("The hosted site did not return a draft-sync credential.");
    }
    return connectWithToken(exchange.token);
  }

  async function listRemoteWorlds(view = "drafts") {
    const normalizedView = ["drafts", "published", "community", "featured"].includes(view)
      ? view
      : "drafts";
    const needsAuth = normalizedView === "drafts" || normalizedView === "published";
    const payload = await remoteFetch(`/api/build/worlds?view=${normalizedView}`, {
      auth: needsAuth,
      sendSession: needsAuth
    });
    const worlds = Array.isArray(payload?.worlds) ? payload.worlds : [];

    return worlds.map((world) => ({
      id: world.id,
      title: world.title || world.id,
      status: world.status || null,
      world_width: world.world_width ?? world.world?.width ?? null,
      world_height: world.world_height ?? world.world?.height ?? null,
      updated_at: world.updated_at || null,
      published_at: world.published_at || null,
      creator: world.creator?.name || world.owner_name || null,
      total_gems: world.total_gems ?? null
    }));
  }

  async function fetchRemoteWorld(remoteWorldId) {
    let payload = null;
    if (getStatus().connected) {
      try {
        payload = await remoteFetch(
          `/api/build/worlds/${encodeURIComponent(remoteWorldId)}`,
          { auth: true }
        );
      } catch (error) {
        if (!/404/.test(String(error.message))) throw error;
      }
    }
    if (!payload) {
      payload = await remoteFetch(
        `/api/build/worlds/${encodeURIComponent(remoteWorldId)}/export`,
        {
          followSameOriginRedirect: true,
          sendSession: false
        }
      );
    }
    const world = payload?.world || payload;

    if (!world?.editor_state) {
      throw new Error(
        "The hosted site did not return an editor state for that world (it may be private — connect the owning account)."
      );
    }

    return world;
  }

  function findLocalWorldByRemoteId(remoteWorldId) {
    return (
      buildWorlds
        .listLocalWorlds()
        .find((world) => world.remote_id === remoteWorldId) || null
    );
  }

  // Pull a world from the hosted site into a local game dir. Owned drafts land
  // as draft-*, other people's published worlds as online-* copies.
  async function pullWorld(remoteWorldId, { kind = "draft" } = {}) {
    const world = await fetchRemoteWorld(remoteWorldId);
    const existing = findLocalWorldByRemoteId(world.id);
    const remoteMeta = {
      id: world.id,
      updated_at: world.updated_at || null,
      status: world.status || null
    };

    if (existing) {
      buildWorlds.replaceLocalWorldFromEditorState(existing.id, world.editor_state, {
        title: world.title,
        remote: remoteMeta
      });
      return buildWorlds.describeLocalWorld(existing.id);
    }

    const game = buildWorlds.createLocalWorld({
      title: world.title,
      editorState: world.editor_state,
      prefix: kind === "online" ? "online" : "draft",
      remote: remoteMeta
    });

    return buildWorlds.describeLocalWorld(game.id);
  }

  // Push a local draft up to the hosted site (creates or updates the linked
  // remote draft; publishing stays a deliberate action on the site itself).
  async function pushWorld(localGameId) {
    const game = getGame(localGameId);

    if (!game || !game.worldMap || !buildWorlds.isLocalWorldGameId(localGameId)) {
      throw new Error(`"${localGameId}" is not a local world.`);
    }

    const meta = buildWorlds.readDraftMeta(localGameId) || {};
    const editorState = buildWorlds.editorStateForGame(game);
    const body = {
      title: editorState.title,
      world_width: editorState.world.width,
      world_height: editorState.world.height,
      editor_state: editorState
    };
    let world = null;

    if (meta.remote_id) {
      try {
        const payload = await remoteFetch(`/api/build/worlds/${encodeURIComponent(meta.remote_id)}`, {
          method: "PATCH",
          body,
          auth: true
        });
        world = payload?.world || payload;
      } catch (error) {
        if (!/404/.test(String(error.message))) {
          throw error;
        }
      }
    }

    if (!world) {
      const payload = await remoteFetch("/api/build/worlds", { method: "POST", body: { title: body.title, world_width: body.world_width, world_height: body.world_height }, auth: true });
      world = payload?.world || payload;

      if (!world?.id) {
        throw new Error("The hosted site did not return the created world.");
      }

      const patchPayload = await remoteFetch(`/api/build/worlds/${encodeURIComponent(world.id)}`, {
        method: "PATCH",
        body,
        auth: true
      });
      world = patchPayload?.world || world;
    }

    buildWorlds.updateDraftMeta(localGameId, {
      remote_id: world.id,
      remote_updated_at: world.updated_at || new Date().toISOString(),
      remote_status: world.status || "draft"
    });

    return buildWorlds.describeLocalWorld(localGameId);
  }

  return {
    completeDeviceLink,
    connectWithToken,
    deviceLinkUrl,
    disconnect,
    getStatus,
    listRemoteWorlds,
    pullWorld,
    pushWorld,
    setOrigin
  };
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

module.exports = {
  createRemoteService
};
