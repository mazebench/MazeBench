const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const shell = fs.readFileSync(path.join(root, "public", "author-shell.js"), "utf8");
const theme = fs.readFileSync(path.join(root, "public", "author-theme.css"), "utf8");
const site = fs.readFileSync(path.join(root, "public", "site.css"), "utf8");
const pages = fs.readFileSync(path.join(root, "server", "pages.js"), "utf8");

for (const id of [
  "author-sidebar",
  "author-sidebar-toggle",
  "author-world-map-toggle",
  "author-world-map-overlay",
  "author-world-map-close",
  "author-world-map-swap",
  "author-world-map-swap-status",
  "author-grid",
  "author-canvas",
  "author-cam-pad",
  "author-hotbar",
  "author-inventory",
  "solver-max-states",
  "solver-unlimited-states",
  "solver-mode-picker",
  "solver-mode-place",
  "solver-mode-reach",
  "solve-level",
  "world-details-panel",
  "world-start-grid",
  "author-info-popover",
  "unsaved-changes-modal",
  "unsaved-changes-cancel",
  "unsaved-changes-save",
  "existing-levels"
]) {
  assert.match(shell, new RegExp(`id=["']${id}["']`), `canonical editor shell is missing #${id}`);
}

assert.match(shell, /mazebench:author-shell-ready/);
assert.match(shell, /class="author-load-label">Loading</);
assert.match(theme, /\.author-load-label \{/);
assert.match(theme, /font-size: clamp\(16px, 1\.8vw, 22px\)/);
assert.match(shell, /link\.dataset\.authorPlayLink = ""/);
assert.match(shell, /__MAZEBENCH_AUTHOR_MARK_READY__/);
assert.match(shell, /function installChromeInteractionShield/);
assert.match(shell, /function setSidebarCollapsed/);
assert.match(shell, /function syncAuthorAppViewport/);
assert.match(shell, /app\.syncEditorCameraDownshift\?\.\(\)/);
assert.match(shell, /requestAnimationFrame\(announceResize\)/);
assert.match(shell, /app\.hostFullBleedView = true/);
assert.match(shell, /window\.setTimeout\(reveal, 8000\)/);
assert.match(shell, /author-hotbar__shortcut/);
assert.doesNotMatch(shell, /inventory-detail-token|Board token/);
assert.match(shell, /data-panel-info-description=/);
assert.doesNotMatch(shell, /author-panel__note/);
assert.doesNotMatch(shell, /author-disclosure--world/);
assert.doesNotMatch(shell, /author-world-solver|World Solver/);
assert.doesNotMatch(shell, /world-start-select/);
assert.match(shell, /The solver uses the A\* search algorithm/);
assert.match(shell, /Unlimited runs until solved, exhausted, or cancelled/);
assert.match(shell, /Reach Gem becomes available when this room contains a gem/);
assert.doesNotMatch(shell, /id=["']solver-algorithm["']/);
assert.doesNotMatch(shell, /id=["']hill-climb["']/);
assert.doesNotMatch(shell, /id=["']play-solution["']/);
assert.match(theme, /Canonical MazeBench world-editor skin/);
assert.match(theme, /rgba\(var\(--cyan-rgb\), 0\.95\)/);
assert.match(theme, /\.author-layout\.is-sidebar-collapsed/);
assert.match(theme, /\.author-inventory__democanvas \{/);
assert.match(theme, /\.author-tool-icon--eraser \{/);
assert.match(theme, /\.author-world-map-overlay\.is-open/);
assert.match(theme, /\.author-world-map-swap\[aria-pressed="true"\]/);
assert.match(theme, /\.author-world-map-stage \.author-level-pill\.is-swap-source/);
assert.match(theme, /\.is-swap-source::after \{[\s\S]*border: 5px solid #ff334f/);
assert.match(shell, /Math\.max\(\s*8,[\s\S]*availableWidth \/ columns[\s\S]*availableHeight \/ rows/);
assert.match(shell, /mazebench:author-world-map-closed/);
assert.match(theme, /\.author-start-room-grid \{/);
assert.match(theme, /\.author-start-room-pixel\.is-start \{/);
assert.match(theme, /\.author-info-popover\.is-open/);
assert.match(theme, /\.author-unsaved-modal \.publish-modal__dialog/);
assert.match(theme, /\.author-unsaved-modal__save/);
assert.match(theme, /rgba\(var\(--green-rgb\), 0\.12\)/);
assert.doesNotMatch(shell, /unsaved-changes-discard|Leave Without Saving/);
assert.match(site, /grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
assert.match(pages, /<div id="author-shell-root"><\/div>/);
assert.match(pages, /<script src="\/author-shell\.js" defer><\/script>/);
assert.match(pages, /includeRuntimeStyles: false/);
assert.doesNotMatch(pages, /<aside id="author-sidebar" class="author-sidebar">/);
assert.doesNotMatch(pages, /worldSolver:/);

console.log("author-shell-source: OK — MazeBench owns the complete editor shell and skin.");
