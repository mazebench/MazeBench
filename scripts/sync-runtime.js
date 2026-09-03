const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const RUNTIME_DIR = path.join(ROOT_DIR, "environments", "mazebench", "mazebench", "runtime");

// The runtime bundle mirrors the subset of the live tree that the MazeBench
// environment needs. Directories listed in MIRRORED_DIRECTORIES are copied
// recursively; MIRRORED_FILES are copied individually. Everything else in the
// live tree (authoring-only public modules, generated previews, player.py,
// vendored node_modules, etc.) is intentionally excluded, and dotfiles such as
// .DS_Store are always ignored.
const MIRRORED_DIRECTORIES = [
  "games/maze/assets_3d",
  "games/maze/images",
  "games/maze/levels",
  "public/logos",
  "server"
];

const MIRRORED_FILES = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "environments/mazebench/prime-harness-catalog.json",
  "games/maze/level_parsing.json",
  "games/maze/toolbox.json",
  "games/maze/world_map.json",
  "games/maze/world_parsing.json",
  "public/author-play-data.js",
  "public/agent-run.js",
  "public/agent.js",
  "public/maze-token-patterns.js",
  "public/author-shell.js",
  "public/author-solver-worker.js",
  "public/author-theme.css",
  "public/author.js",
  "public/build-theme.css",
  "public/build.js",
  "public/favicon.svg",
  "public/level-preview.js",
  "public/local-site.css",
  "public/maze-engine.js",
  "public/maze-solver.js",
  "public/world-solver.js",
  "public/world-solver-worker.js",
  "public/play-core.js",
  "public/play-gameplay.js",
  "public/play-movement.js",
  "public/play-render-actors.js",
  "public/play-render-compositor.js",
  "public/play-render-effects.js",
  "public/play-render-terrain.js",
  "public/play-render-three.js",
  "public/play-render.js",
  "public/play-rules.js",
  "public/play-theme.css",
  "public/play-world-transitions.js",
  "public/play.js",
  "public/train-chart.js",
  "public/train-env.js",
  "public/train-ppo-webgpu.js",
  "public/train-profile.js",
  "public/train-worker.js",
  "public/train.js",
  "public/site.css",
  "public/styles.css",
  "shared/auto-quit.js",
  "shared/board-state.js",
  "shared/default-world-template.js",
  "shared/maze-ascii-palette.js",
  "shared/maze-observation-contract.js",
  "scripts/maze-agent-local.js",
  "scripts/maze-bridge.js",
  "scripts/codex-play.js",
  "scripts/maze-play.js",
  "scripts/maze-codex-tool-guard.js",
  "scripts/maze-mcp-client.js",
  "scripts/maze-mcp-server.js",
  "scripts/maze-python-sandbox.js",
  "scripts/maze-prime-live-eval.py",
  "scripts/maze-prime-run.js",
  "scripts/prime-create-evaluation.js",
  "scripts/maze-export-replay.js",
  "scripts/maze-export-solution.js",
  "scripts/playwright-process.js",
  "scripts/maze-render-frame.js",
  "scripts/maze-terminal.js"
];

function isIgnoredName(name) {
  return name.startsWith(".");
}

function walkFiles(directoryPath, relativePrefix, results = []) {
  if (!fs.existsSync(directoryPath)) {
    return results;
  }

  fs.readdirSync(directoryPath, { withFileTypes: true }).forEach((entry) => {
    if (isIgnoredName(entry.name)) {
      return;
    }

    const entryPath = path.join(directoryPath, entry.name);
    const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      walkFiles(entryPath, relativePath, results);
    } else if (entry.isFile()) {
      results.push(relativePath);
    }
  });

  return results;
}

function collectExpectedFiles() {
  const expected = new Set();

  MIRRORED_DIRECTORIES.forEach((directory) => {
    walkFiles(path.join(ROOT_DIR, directory), directory).forEach((relativePath) => {
      expected.add(relativePath);
    });
  });

  MIRRORED_FILES.forEach((relativePath) => {
    if (fs.existsSync(path.join(ROOT_DIR, relativePath))) {
      expected.add(relativePath);
    }
  });

  return expected;
}

function collectRuntimeFiles(runtimeDir = RUNTIME_DIR) {
  return new Set(walkFiles(runtimeDir, ""));
}

function filesMatch(leftPath, rightPath) {
  if (fs.statSync(leftPath).size !== fs.statSync(rightPath).size) {
    return false;
  }

  return fs.readFileSync(leftPath).equals(fs.readFileSync(rightPath));
}

function computeTargetDrift(runtimeDir) {
  const expected = collectExpectedFiles();
  const runtimeFiles = collectRuntimeFiles(runtimeDir);
  const missing = [];
  const modified = [];
  const stale = [];

  [...expected].sort().forEach((relativePath) => {
    if (!runtimeFiles.has(relativePath)) {
      missing.push(relativePath);
    } else if (
      !filesMatch(path.join(ROOT_DIR, relativePath), path.join(runtimeDir, relativePath))
    ) {
      modified.push(relativePath);
    }
  });

  [...runtimeFiles].sort().forEach((relativePath) => {
    if (!expected.has(relativePath)) {
      stale.push(relativePath);
    }
  });

  return { missing, modified, stale };
}

function computeRuntimeDrift() {
  return computeTargetDrift(RUNTIME_DIR);
}

function removeEmptyDirectories(directoryPath, runtimeDir = RUNTIME_DIR) {
  if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
    return;
  }

  fs.readdirSync(directoryPath, { withFileTypes: true }).forEach((entry) => {
    if (entry.isDirectory()) {
      removeEmptyDirectories(path.join(directoryPath, entry.name), runtimeDir);
    }
  });

  if (directoryPath !== runtimeDir && fs.readdirSync(directoryPath).length === 0) {
    fs.rmdirSync(directoryPath);
  }
}

function syncTarget(runtimeDir) {
  const drift = computeTargetDrift(runtimeDir);
  const copied = drift.missing.concat(drift.modified);

  copied.forEach((relativePath) => {
    const targetPath = path.join(runtimeDir, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(path.join(ROOT_DIR, relativePath), targetPath);
  });

  drift.stale.forEach((relativePath) => {
    fs.unlinkSync(path.join(runtimeDir, relativePath));
  });

  removeEmptyDirectories(runtimeDir, runtimeDir);
  return { ...drift, copied };
}

function syncRuntime() {
  const result = syncTarget(RUNTIME_DIR);

  console.log(
    `sync-runtime: copied ${result.copied.length} file(s), removed ${result.stale.length} stale file(s).`
  );

  return computeRuntimeDrift();
}

if (require.main === module) {
  syncRuntime();
}

module.exports = {
  MIRRORED_DIRECTORIES,
  MIRRORED_FILES,
  ROOT_DIR,
  RUNTIME_DIR,
  computeRuntimeDrift,
  syncRuntime
};
