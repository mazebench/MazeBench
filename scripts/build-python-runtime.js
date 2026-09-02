#!/usr/bin/env node

// Stage the Node site/runtime into mazebench_cli/_runtime/ so the Python wheel
// is self-contained: `pip install mazebench` then `mazebench launch` serves the
// full site without a repo checkout. Run this before `python -m build`;
// .github/workflows/publish.yml does it automatically.
//
// The staged tree mirrors a minimal checkout:
//   server.js, package.json, shared/, server/, public/, scripts/, games/maze/,
//   environments/mazebench/, vendor/ (the three.js files normally served from
//   node_modules), licenses
//
// Node.js remains a runtime prerequisite on the user's machine (plus ffmpeg +
// a Chromium-family browser for replay videos, plus uv and Docker for agents).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const RUNTIME_DIR = path.join(ROOT_DIR, "mazebench_cli", "_runtime");

const COPY_DIRECTORIES = [
  "shared",
  "server",
  "public",
  "scripts",
  "environments/mazebench",
  "games/maze/levels",
  "games/maze/images",
  "games/maze/assets_3d",
  "games/maze/previews"
];

const COPY_FILES = [
  ".dockerignore",
  "Dockerfile",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "server.js",
  "package.json",
  "package-lock.json",
  "games/maze/config.json",
  "games/maze/level_parsing.json",
  "games/maze/toolbox.json",
  "games/maze/world_map.json",
  "games/maze/world_parsing.json"
];

const VENDOR_FILES = [
  ["three/build/three.module.js", "three.module.js"],
  ["three/build/three.core.js", "three.core.js"],
  ["three/examples/jsm/loaders/GLTFLoader.js", "GLTFLoader.js"],
  ["three/examples/jsm/utils/BufferGeometryUtils.js", "BufferGeometryUtils.js"],
  ["three/examples/jsm/utils/SkeletonUtils.js", "SkeletonUtils.js"]
];

function isIgnoredName(name) {
  return name.startsWith(".") || name === "__pycache__" || name.endsWith(".pyc");
}

function copyDirectory(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.readdirSync(sourceDir, { withFileTypes: true }).forEach((entry) => {
    if (isIgnoredName(entry.name)) {
      return;
    }

    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  });
}

function readPackageVersion() {
  const pyproject = fs.readFileSync(path.join(ROOT_DIR, "pyproject.toml"), "utf8");
  const match = pyproject.match(/^version\s*=\s*"([^"]+)"/m);
  return match ? match[1] : "0.0.0";
}

function buildRuntime() {
  fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });

  COPY_DIRECTORIES.forEach((relative) => {
    const source = path.join(ROOT_DIR, ...relative.split("/"));

    if (!fs.existsSync(source)) {
      throw new Error(`Missing directory: ${relative}`);
    }

    copyDirectory(source, path.join(RUNTIME_DIR, ...relative.split("/")));
  });

  COPY_FILES.forEach((relative) => {
    const source = path.join(ROOT_DIR, ...relative.split("/"));

    if (!fs.existsSync(source)) {
      throw new Error(`Missing file: ${relative}`);
    }

    const target = path.join(RUNTIME_DIR, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  });

  const vendorDir = path.join(RUNTIME_DIR, "vendor");
  fs.mkdirSync(vendorDir, { recursive: true });
  VENDOR_FILES.forEach(([relative, name]) => {
    const source = path.join(ROOT_DIR, "node_modules", ...relative.split("/"));

    if (!fs.existsSync(source)) {
      throw new Error(`Missing vendor file (run npm install first): node_modules/${relative}`);
    }

    fs.copyFileSync(source, path.join(vendorDir, name));
  });

  // Stamp the version PLUS a content hash of the staged runtime. The installed
  // CLI refreshes its ~/.mazebench/site workspace whenever this stamp changes,
  // so a code change *within* the same version (not just a version bump) still
  // propagates — otherwise an edited server.js/public file would be ignored.
  const version = readPackageVersion();
  const stamp = `${version}+${runtimeHash(RUNTIME_DIR)}`;
  fs.writeFileSync(path.join(RUNTIME_DIR, ".runtime-version"), `${stamp}\n`, "utf8");

  let fileCount = 0;
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else fileCount += 1;
    });
  };
  walk(RUNTIME_DIR);

  console.log(`build-python-runtime: staged ${fileCount} files at ${path.relative(ROOT_DIR, RUNTIME_DIR)} (${stamp})`);
}

// A stable fingerprint of the staged runtime: sha256 over every file's path +
// contents (sorted, excluding the stamp file itself), truncated for brevity.
function runtimeHash(dir) {
  const files = [];
  const collect = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) collect(entryPath);
      else files.push(entryPath);
    }
  };
  collect(dir);

  const hash = crypto.createHash("sha256");
  for (const file of files.sort()) {
    const relative = path.relative(dir, file);
    if (relative === ".runtime-version") continue;
    hash.update(relative);
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex").slice(0, 12);
}

if (require.main === module) {
  buildRuntime();
}

module.exports = { RUNTIME_DIR, buildRuntime };
