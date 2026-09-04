const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const LOCAL_AGENT_IMAGE = "docker.io/library/mazebench-agent:latest";
const MUSE_STABLE_CHANNEL_URL = "https://api.meta.ai/muse-code/channels/muse-stable";
const LOCAL_AGENT_UPDATE_POLICY = "registry-latest-certified";
const LOCAL_AGENT_UPDATE_POLICY_LABEL = "org.mazebench.local-agent.update-policy";
const LOCAL_AGENT_SOURCE_LABEL = "org.mazebench.local-agent.source-fingerprint";
const LOCAL_AGENT_PACKAGES = Object.freeze({
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
  kimi: "@moonshot-ai/kimi-code"
});
const LOCAL_AGENT_IMAGE_LABELS = Object.freeze({
  codex: "org.mazebench.local-codex.version",
  claude: "org.mazebench.local-claude.version",
  kimi: "org.mazebench.local-kimi.version",
  muse: "org.mazebench.local-muse.version"
});
const DEFAULT_LOCAL_AGENT_VERSIONS = Object.freeze({
  codex: "0.152.1",
  claude: "2.1.258",
  kimi: "0.29.1",
  muse: "1.0.2-R2040.1"
});
const LOCAL_AGENT_SOURCE_FILES = Object.freeze([
  ".dockerignore",
  "Dockerfile",
  "package.json",
  "package-lock.json",
  "scripts/codex-play.js",
  "scripts/ensure-local-agent-image.js",
  "scripts/local-agent-image.js",
  "scripts/maze-agent-local.js",
  "scripts/muse-model-catalog.js",
  "scripts/maze-codex-tool-guard.js",
  "scripts/maze-mcp-server.js",
  "scripts/maze-python-sandbox.js",
  "server/agent-runs.js",
  "server/app.js"
]);

function isExactPackageVersion(value) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(value || "").trim());
}

function versionsFromImageLabels(labels) {
  return Object.fromEntries(
    Object.entries(LOCAL_AGENT_IMAGE_LABELS).map(([provider, label]) => [
      provider,
      String(labels?.[label] || "").trim()
    ])
  );
}

function localAgentSourceFingerprint(rootDir) {
  const hash = crypto.createHash("sha256");
  for (const relativePath of LOCAL_AGENT_SOURCE_FILES) {
    const filePath = path.join(rootDir, relativePath);
    hash.update(relativePath);
    hash.update("\0");
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      hash.update(fs.readFileSync(filePath));
    } else {
      hash.update("<missing>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function imageLabelsAreCertified(labels, rootDir, expectedVersions = null) {
  const versions = versionsFromImageLabels(labels);
  if (!Object.values(versions).every(isExactPackageVersion)) return false;
  if (labels?.[LOCAL_AGENT_UPDATE_POLICY_LABEL] !== LOCAL_AGENT_UPDATE_POLICY) return false;
  if (labels?.[LOCAL_AGENT_SOURCE_LABEL] !== localAgentSourceFingerprint(rootDir)) return false;
  if (expectedVersions) {
    return Object.entries(expectedVersions).every(
      ([provider, version]) => versions[provider] === version
    );
  }
  return true;
}

function resolveLatestLocalAgentVersions(options = {}) {
  const npmBin = options.npmBin || "npm";
  const env = options.env || process.env;
  const npmVersions = Object.fromEntries(Object.entries(LOCAL_AGENT_PACKAGES).map(([provider, packageName]) => {
    const result = spawnSync(npmBin, ["view", packageName, "version", "--json"], {
      encoding: "utf8",
      env,
      timeout: options.timeout || 20_000,
      maxBuffer: 256 * 1024
    });
    if (result.status !== 0) {
      throw new Error(
        "Could not resolve the latest " + packageName + " release: " +
        String(result.stderr || result.stdout || ("npm exited " + result.status)).trim()
      );
    }
    let version = "";
    try {
      version = JSON.parse(String(result.stdout || '""'));
    } catch (_error) {
      version = String(result.stdout || "").trim();
    }
    if (!isExactPackageVersion(version)) {
      throw new Error(
        "npm returned an invalid " + packageName + " version: " + JSON.stringify(version) + "."
      );
    }
    return [provider, version];
  }));
  const museRelease = options.museRelease || resolveLatestMuseRelease(options);
  return { ...npmVersions, muse: museRelease.version };
}

function resolveLatestMuseRelease(options = {}) {
  if (options.museRelease) return options.museRelease;
  const result = spawnSync(options.curlBin || "curl", ["-fsSL", options.museChannelUrl || MUSE_STABLE_CHANNEL_URL], {
    encoding: "utf8",
    env: options.env || process.env,
    timeout: options.timeout || 20_000,
    maxBuffer: 256 * 1024
  });
  if (result.status !== 0) {
    throw new Error("Could not resolve the latest Muse Code release: " +
      String(result.stderr || result.stdout || ("curl exited " + result.status)).trim());
  }
  let channel;
  try { channel = JSON.parse(String(result.stdout || "{}")); }
  catch (_error) { throw new Error("Muse Code returned an invalid stable-channel document."); }
  const release = { version: String(channel.version || "").trim(), manifestUrl: String(channel.manifest_url || "").trim() };
  if (!/^\d+\.\d+\.\d+-R\d+(?:\.\d+)?$/.test(release.version) ||
      !/^https:\/\//.test(release.manifestUrl) || channel.state !== "public") {
    throw new Error("Muse Code returned an incomplete or non-public stable release.");
  }
  return release;
}

module.exports = {
  DEFAULT_LOCAL_AGENT_VERSIONS,
  LOCAL_AGENT_IMAGE,
  LOCAL_AGENT_IMAGE_LABELS,
  LOCAL_AGENT_PACKAGES,
  LOCAL_AGENT_SOURCE_LABEL,
  LOCAL_AGENT_UPDATE_POLICY,
  LOCAL_AGENT_UPDATE_POLICY_LABEL,
  MUSE_STABLE_CHANNEL_URL,
  imageLabelsAreCertified,
  isExactPackageVersion,
  localAgentSourceFingerprint,
  resolveLatestLocalAgentVersions,
  resolveLatestMuseRelease,
  versionsFromImageLabels
};
