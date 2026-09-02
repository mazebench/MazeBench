#!/usr/bin/env node

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  LOCAL_AGENT_IMAGE,
  imageLabelsAreCertified,
  localAgentSourceFingerprint,
  resolveLatestAntigravityRelease,
  resolveLatestLocalAgentVersions,
  versionsFromImageLabels
} = require("./local-agent-image");

const ROOT_DIR = path.resolve(__dirname, "..");

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    env: process.env,
    stdio: options.capture ? "pipe" : "inherit",
    timeout: options.timeout || 30 * 60_000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "").trim();
    throw new Error(
      [bin, ...args].join(" ") + " failed" +
      (result.status === null ? "" : " with status " + result.status) +
      (detail ? ": " + detail : ".")
    );
  }
  return result;
}

function inspectImageLabels(image) {
  const result = spawnSync(
    "docker",
    ["image", "inspect", image, "--format", "{{json .Config.Labels}}"],
    {
      cwd: ROOT_DIR,
      encoding: "utf8",
      env: process.env,
      timeout: 10_000,
      maxBuffer: 256 * 1024
    }
  );
  if (result.status !== 0) return null;
  try {
    return JSON.parse(String(result.stdout || "{}"));
  } catch (_error) {
    return null;
  }
}

function dockerRunning() {
  const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    env: process.env,
    timeout: 10_000,
    maxBuffer: 256 * 1024
  });
  return result.status === 0 && Boolean(String(result.stdout || "").trim());
}

function installedProviderVersion(image, provider) {
  const command = { antigravity: "agy", codex: "codex", claude: "claude", kimi: "kimi" }[provider];
  const result = run(
    "docker",
    ["run", "--rm", "--entrypoint", command, image, "--version"],
    { capture: true, timeout: 30_000 }
  );
  return String(result.stdout || result.stderr || "").match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] || "";
}

function ensureLocalAgentImage(options = {}) {
  if (!dockerRunning()) {
    if (options.allowMissingDocker) {
      console.warn("MazeBench: Docker is unavailable; skipping the local-agent image update.");
      return { skipped: true };
    }
    throw new Error("Docker must be running before the local-agent image can be built.");
  }

  console.log("MazeBench: resolving current coding-agent releases...");
  const antigravityRelease = resolveLatestAntigravityRelease();
  const versions = resolveLatestLocalAgentVersions({ antigravityRelease });
  const sourceFingerprint = localAgentSourceFingerprint(ROOT_DIR);
  const existingLabels = inspectImageLabels(LOCAL_AGENT_IMAGE);

  if (!options.force &&
      existingLabels &&
      imageLabelsAreCertified(existingLabels, ROOT_DIR, versions)) {
    console.log(
      "MazeBench: persistent local-agent image is current " +
      "(Antigravity " + versions.antigravity + ", Codex " + versions.codex +
      ", Claude Code " + versions.claude + ", Kimi Code " + versions.kimi + ")."
    );
    return { built: false, versions };
  }

  const candidate = "mazebench-agent:candidate-" + process.pid;
  console.log(
    "MazeBench: building a certified candidate with Antigravity " + versions.antigravity +
    ", Codex " + versions.codex + ", Claude Code " + versions.claude +
    ", and Kimi Code " + versions.kimi + "..."
  );
  try {
    run("docker", [
      "build",
      "--progress=plain",
      "--build-arg", "CODEX_VERSION=" + versions.codex,
      "--build-arg", "CLAUDE_CODE_VERSION=" + versions.claude,
      "--build-arg", "KIMI_CODE_VERSION=" + versions.kimi,
      "--build-arg", "ANTIGRAVITY_VERSION=" + antigravityRelease.version,
      "--build-arg", "ANTIGRAVITY_URL=" + antigravityRelease.url,
      "--build-arg", "ANTIGRAVITY_SHA512=" + antigravityRelease.sha512,
      "--build-arg", "MAZEBENCH_SOURCE_FINGERPRINT=" + sourceFingerprint,
      "-t", candidate,
      "."
    ]);

    const candidateLabels = inspectImageLabels(candidate);
    if (!candidateLabels ||
        !imageLabelsAreCertified(candidateLabels, ROOT_DIR, versions)) {
      throw new Error("The candidate image labels do not match the resolved releases and source.");
    }

    for (const [provider, expectedVersion] of Object.entries(versions)) {
      const installedVersion = installedProviderVersion(candidate, provider);
      if (installedVersion !== expectedVersion) {
        throw new Error(
          "The candidate contains " + provider + " " + (installedVersion || "unknown") +
          "; expected " + expectedVersion + "."
        );
      }
    }

    console.log("MazeBench: running candidate isolation certification...");
    run(
      "docker",
      ["run", "--rm", "--entrypoint", "node", candidate, "tests/agent-tool-isolation.test.js"],
      { timeout: 120_000 }
    );
    run(
      "docker",
      ["run", "--rm", "--entrypoint", "node", candidate, "tests/claude-reasoning.test.js"],
      { timeout: 120_000 }
    );
    run(
      "docker",
      [
        "run", "--rm",
        "--user", "root",
        "--cap-drop", "ALL",
        "--cap-add", "SYS_ADMIN",
        "--cap-add", "SETUID",
        "--cap-add", "SETGID",
        "--cap-add", "SETPCAP",
        "--cap-add", "CHOWN",
        "--cap-add", "DAC_OVERRIDE",
        "--security-opt", "seccomp=unconfined",
        "--security-opt", "apparmor=unconfined",
        "--entrypoint", "node",
        candidate,
        "tests/maze-python-sandbox.test.js"
      ],
      { timeout: 120_000 }
    );

    run("docker", ["tag", candidate, LOCAL_AGENT_IMAGE], { timeout: 30_000 });
    console.log(
      "MazeBench: promoted the verified persistent image " +
      "(Antigravity " + versions.antigravity + ", Codex " + versions.codex +
      ", Claude Code " + versions.claude + ", Kimi Code " + versions.kimi + ")."
    );
    return {
      built: true,
      versions,
      imageVersions: versionsFromImageLabels(candidateLabels)
    };
  } finally {
    spawnSync("docker", ["image", "rm", candidate], {
      cwd: ROOT_DIR,
      encoding: "utf8",
      env: process.env,
      timeout: 30_000,
      maxBuffer: 256 * 1024
    });
  }
}

if (require.main === module) {
  try {
    ensureLocalAgentImage({
      allowMissingDocker: process.argv.includes("--ensure"),
      force: process.argv.includes("--force")
    });
  } catch (error) {
    console.error("MazeBench local-agent update failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  dockerRunning,
  ensureLocalAgentImage,
  inspectImageLabels,
  installedProviderVersion
};
