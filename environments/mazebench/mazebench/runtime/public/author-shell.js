(function () {
  "use strict";

  const authorData = window.__AUTHOR_DATA__ || {};
  const config = window.__AUTHOR_SHELL__ || {};
  const capabilities = config.capabilities || {};
  const root = document.getElementById("author-shell-root");

  if (!root) {
    return;
  }

  root.innerHTML = `
    <main class="shell author-shell">
      <header class="author-header">
        <div class="author-topbar">
          <nav class="page-nav author-nav" aria-label="Build navigation"></nav>
          <h1 class="author-title"></h1>
          <div class="author-actions">
            <button id="undo-level" class="tool-button author-undo-button" type="button" disabled>Undo</button>
            <button id="save-level" class="tool-button tool-button--primary author-save-button" type="button">Saved</button>
          </div>
          <p id="author-status" class="author-status" role="status" aria-live="polite"></p>
          <a id="author-play-link" class="build-author-hidden" href="#" tabindex="-1">Play</a>
        </div>
      </header>
      <div class="author-layout">
        <aside id="author-sidebar" class="author-sidebar">
          <details class="author-panel author-disclosure" id="world-details-panel" data-open="1">
            <summary class="author-disclosure__summary">
              <span class="author-disclosure__chevron" aria-hidden="true">&#9656;</span>
              <span>Details</span>
              <button class="author-panel__info-button" type="button" data-panel-info="details" data-panel-info-title="Details" data-panel-info-description="Rename your world and keep an eye on its size, rooms, and gems. Renames save immediately; everything else updates as you edit." aria-label="About the Details panel" aria-controls="author-info-popover" aria-expanded="false">i</button>
            </summary>
            <div class="author-disclosure__body">
              <div class="author-control-row">
                <label class="field">
                  <span>World name</span>
                  <input id="world-title-input" type="text" maxlength="30" spellcheck="false" autocomplete="off">
                </label>
                <button id="world-title-save" class="tool-button" type="button">Rename</button>
              </div>
              <div class="author-control-row">
                <div class="field author-start-room-field">
                  <span>Starting room</span>
                  <div id="world-start-grid" class="author-start-room-grid" role="grid" aria-label="Choose the starting room"></div>
                </div>
              </div>
              <dl class="author-stats">
                <div><dt>Size</dt><dd id="world-stat-size">--</dd></div>
                <div><dt>Gems</dt><dd id="world-stat-gems">--</dd></div>
                <div class="author-stats__wide"><dt>Last saved</dt><dd id="world-stat-updated">--</dd></div>
              </dl>
            </div>
          </details>
          <details class="author-panel author-disclosure build-author-hidden" open>
            <summary class="author-disclosure__summary"><span>Board</span></summary>
            <div class="author-disclosure__body">
              <div class="author-control-row">
                <label class="field field--compact"><span>Width</span><input id="board-width" type="number" min="1" inputmode="numeric"></label>
                <label class="field field--compact"><span>Height</span><input id="board-height" type="number" min="1" inputmode="numeric"></label>
                <button id="resize-level" class="tool-button" type="button">Resize</button>
              </div>
              <div class="author-control-row">
                <button id="clear-level" class="tool-button tool-button--danger" type="button"><span class="tool-button__icon" aria-hidden="true">&#10005;</span><span>Clear</span></button>
                <button id="frame-level" class="tool-button" type="button"><span class="tool-button__icon" aria-hidden="true">&#9633;</span><span>Frame</span></button>
              </div>
            </div>
          </details>
          <details class="author-panel author-disclosure">
            <summary class="author-disclosure__summary">
              <span class="author-disclosure__chevron" aria-hidden="true">&#9656;</span>
              <span>Transform</span>
              <button class="author-panel__info-button" type="button" data-panel-info="transform" data-panel-info-title="Transform" data-panel-info-description="Rotate or mirror the whole room in one move; handy for reusing a layout with a fresh orientation." aria-label="About the Transform panel" aria-controls="author-info-popover" aria-expanded="false">i</button>
            </summary>
            <div class="author-disclosure__body">
              <div class="author-control-row">
                <button id="rotate-left" class="tool-button" type="button" title="Rotate level left"><span class="tool-button__icon" aria-hidden="true">&#8634;</span><span>Rotate Left</span></button>
                <button id="rotate-right" class="tool-button" type="button" title="Rotate level right"><span class="tool-button__icon" aria-hidden="true">&#8635;</span><span>Rotate Right</span></button>
                <button id="flip-horizontal" class="tool-button" type="button" title="Mirror level left to right"><span class="tool-button__icon" aria-hidden="true">&#8596;</span><span>Flip H</span></button>
                <button id="flip-vertical" class="tool-button" type="button" title="Mirror level top to bottom"><span class="tool-button__icon" aria-hidden="true">&#8597;</span><span>Flip V</span></button>
              </div>
            </div>
          </details>
          <details class="author-panel author-disclosure">
            <summary class="author-disclosure__summary">
              <span class="author-disclosure__chevron" aria-hidden="true">&#9656;</span>
              <span>Solver</span>
              <span class="author-panel__flag" title="Engine v0.1 — expect rough edges">Experimental</span>
              <button class="author-panel__info-button" type="button" data-panel-info="solver" data-panel-info-title="Solver" data-panel-info-description="The solver uses the A* search algorithm in a background worker. Place Gem finds and places the hardest reachable gem position. Reach Gem checks whether the existing gem can be reached." aria-label="About the Solver panel" aria-controls="author-info-popover" aria-expanded="false">i</button>
            </summary>
            <div class="author-disclosure__body">
              <label class="field"><span>Search states</span><input id="solver-max-states" type="number" min="1" step="1" value="1000000" inputmode="numeric" aria-label="Solver search state limit"></label>
              <label class="solver-unlimited-toggle"><input id="solver-unlimited-states" type="checkbox"><span>Unlimited states</span></label>
              <p class="solver-mode-field__hint">Unlimited runs until solved, exhausted, or cancelled and may use substantial memory.</p>
              <div class="solver-mode-field">
                <span class="solver-mode-field__label">Mode</span>
                <div id="solver-mode-picker" class="solver-mode-picker" role="radiogroup" aria-label="Solver mode">
                  <span class="solver-mode-picker__slider" aria-hidden="true"></span>
                  <button id="solver-mode-place" class="solver-mode-picker__option" type="button" data-solver-mode="place_gem" role="radio" aria-checked="false">Place Gem</button>
                  <button id="solver-mode-reach" class="solver-mode-picker__option" type="button" data-solver-mode="reach_gem" role="radio" aria-checked="false">Reach Gem</button>
                </div>
                <p id="solver-mode-hint" class="solver-mode-field__hint">Reach Gem becomes available when this room contains a gem.</p>
              </div>
              <button id="solve-level" class="tool-button tool-button--primary solver-run-button" type="button" hidden>Run Solver</button>
            </div>
          </details>
          <details class="author-panel author-disclosure build-author-hidden">
            <summary class="author-disclosure__summary"><span>Cell</span></summary>
            <div class="author-disclosure__body"><p id="selected-cell-label" class="author-panel__copy"></p><label class="field"><span>Raw value</span><input id="cell-value" type="text" spellcheck="false" aria-label="Selected cell raw value"></label><button id="apply-cell-value" class="tool-button" type="button">Apply Cell</button></div>
          </details>
          <details class="author-panel author-disclosure author-output-panel build-author-hidden">
            <summary class="author-disclosure__summary"><span>Text Output</span></summary>
            <div class="author-disclosure__body"><textarea id="raw-output" class="raw-output" readonly spellcheck="false"></textarea></div>
          </details>
        </aside>
        <button id="author-sidebar-toggle" class="author-sidebar-toggle" type="button" aria-controls="author-sidebar" aria-expanded="true" aria-label="Hide editor toolbar" title="Hide tools"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 18l6-6-6-6"></path></svg></button>
        <section class="author-workspace">
          <section class="author-stage" aria-label="Level canvas">
            <section class="author-grid-shell">
              <div id="author-grid" class="author-grid" aria-label="Maze author grid"><canvas id="author-canvas" class="author-grid__canvas"></canvas><div id="author-hit-grid" class="author-grid__hit-grid"></div></div>
              <div class="author-load-art" aria-hidden="true"><span class="author-load-label">Loading</span><span class="author-load-progress"><span></span></span></div>
              <button id="author-world-map-toggle" class="control-button author-world-map-button" type="button" aria-controls="author-world-map-overlay" aria-expanded="false" aria-label="World map" title="World map">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.5 6.5 9 4l6 3 4.5-2.5v13L15 20l-6-3-4.5 2.5v-13Z"></path><path d="M9 4v13"></path><path d="M15 7v13"></path></svg>
              </button>
              <section id="author-world-map-overlay" class="author-world-map-overlay" aria-label="World map" hidden>
                <div class="author-world-map-panel" role="dialog" aria-modal="true" aria-labelledby="author-world-map-title">
                  <header class="author-world-map-bar">
                    <h2 id="author-world-map-title">World Map</h2>
                    <button id="author-world-map-close" class="control-button author-world-map-close" type="button" aria-label="Close world map" title="Close">
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 6 12 12"></path><path d="m18 6-12 12"></path></svg>
                    </button>
                  </header>
                  <div class="author-world-map-stage">
                    <div id="existing-levels" class="author-level-tray" aria-label="Existing levels"></div>
                  </div>
                  <footer class="author-world-map-actions">
                    <button id="author-world-map-swap" class="tool-button author-world-map-swap" type="button" aria-pressed="false">Swap rooms</button>
                    <p id="author-world-map-swap-status" class="author-world-map-swap-status" role="status" aria-live="polite">Choose Swap rooms, then select two built rooms.</p>
                  </footer>
                </div>
              </section>
              <div id="author-cam-pad" class="control-pad camera-pad" aria-label="Camera controls">
                <button class="control-button dpad-button" type="button" data-camera="up" aria-label="Camera up" tabindex="-1"></button>
                <button class="control-button dpad-button" type="button" data-camera="left" aria-label="Rotate camera left" tabindex="-1"></button>
                <span class="dpad-center" aria-hidden="true">CAM</span>
                <button class="control-button dpad-button" type="button" data-camera="right" aria-label="Rotate camera right" tabindex="-1"></button>
                <button class="control-button dpad-button" type="button" data-camera="down" aria-label="Camera down" tabindex="-1"></button>
              </div>
              <div id="author-hotbar" class="author-hotbar" aria-label="Tool hotbar">
                <span id="hotbar-toolname" class="author-hotbar__toolname" aria-hidden="true"></span>
                <span id="selected-tool-label" class="build-author-hidden" aria-hidden="true"></span>
                <div id="hotbar-slots" class="author-hotbar__slots"></div><span class="author-hotbar__divider" aria-hidden="true"></span>
                <button id="hotbar-backpack" class="author-hotbar__backpack" type="button" aria-expanded="false" aria-label="Open the toolbox" title="All tools (B)"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="5" height="5" rx="1"></rect><rect x="9.5" y="1.5" width="5" height="5" rx="1"></rect><rect x="1.5" y="9.5" width="5" height="5" rx="1"></rect><rect x="9.5" y="9.5" width="5" height="5" rx="1"></rect></svg><span class="author-hotbar__shortcut" aria-hidden="true">B</span></button>
              </div>
              <section id="author-inventory" class="author-inventory" aria-label="Toolbox" hidden>
                <div class="author-inventory__head"><h2>Toolbox</h2><button id="inventory-close" class="author-inventory__close" type="button" aria-label="Close the toolbox">&times;</button></div>
                <div class="author-inventory__layout"><div id="palette" class="author-inventory__grid"></div><aside class="author-inventory__detail" aria-live="polite"><div id="inventory-detail-stage" class="author-inventory__stage"><canvas id="inventory-demo-canvas" class="author-inventory__democanvas" aria-hidden="true"></canvas><span id="inventory-detail-swatch" class="author-inventory__swatch"></span></div><h3 id="inventory-detail-name">Pick a tool</h3><p id="inventory-detail-text" class="author-inventory__text">Click any tool to see what it does.</p></aside></div>
              </section>
            </section>
          </section>
        </section>
      </div>
      <aside id="author-info-popover" class="author-info-popover" role="dialog" aria-modal="false" aria-labelledby="author-info-popover-title" hidden>
        <header class="author-info-popover__header">
          <h2 id="author-info-popover-title"></h2>
          <button class="author-info-popover__close" type="button" data-panel-info-close aria-label="Close description">&times;</button>
        </header>
        <p id="author-info-popover-description"></p>
      </aside>
      <div id="unsaved-changes-modal" class="publish-modal author-unsaved-modal" role="dialog" aria-modal="true" aria-labelledby="unsaved-changes-title" aria-describedby="unsaved-changes-message">
        <div class="publish-modal__dialog">
          <h2 id="unsaved-changes-title" class="publish-modal__title">Save changes?</h2>
          <p id="unsaved-changes-message" class="author-unsaved-modal__message">This room has unsaved changes.</p>
          <div class="publish-modal__actions author-unsaved-modal__actions">
            <button id="unsaved-changes-cancel" class="tool-button" type="button">Cancel</button>
            <button id="unsaved-changes-save" class="tool-button author-unsaved-modal__save" type="button">Save &amp; Continue</button>
          </div>
        </div>
      </div>
      <div id="token-id-modal" class="publish-modal author-unsaved-modal" role="dialog" aria-modal="true" aria-labelledby="token-id-title" aria-describedby="token-id-message">
        <div class="publish-modal__dialog">
          <h2 id="token-id-title" class="publish-modal__title">Pick an id</h2>
          <p id="token-id-message" class="author-unsaved-modal__message">Choose a numeric id.</p>
          <label class="field"><span>Id (0 or more)</span><input id="token-id-input" type="number" min="0" step="1" inputmode="numeric"></label>
          <div class="publish-modal__actions author-unsaved-modal__actions">
            <button id="token-id-cancel" class="tool-button" type="button">Cancel</button>
            <button id="token-id-confirm" class="tool-button author-unsaved-modal__save" type="button">Select</button>
          </div>
        </div>
      </div>
      <div id="publish-modal" class="publish-modal" role="dialog" aria-modal="true" aria-labelledby="publish-modal-title"><div class="publish-modal__dialog"><h2 id="publish-modal-title" class="publish-modal__title">Publish checklist</h2><ul id="publish-modal-list" class="publish-modal__list"></ul><div id="publish-modal-actions" class="publish-modal__actions"></div></div></div>
    </main>
    <main class="build-mobile-blocker"><section class="build-mobile-blocker__panel"><h1>Desktop editor only</h1><p>World editing is available on desktop for now.</p><div class="build-mobile-blocker__actions"></div></section></main>`;

  const title = String(config.title || authorData.game?.name || "Maze Bench Editor");
  const titleElement = root.querySelector(".author-title");
  if (titleElement) {
    titleElement.textContent = title;
  }

  const nav = root.querySelector(".author-nav");
  for (const item of Array.isArray(config.navigation) ? config.navigation : []) {
    if (!item || !item.href || !item.label) continue;
    const link = document.createElement("a");
    link.className = "back-link";
    link.href = item.href;
    link.textContent = item.label;
    if (item.testLink === true) link.id = "author-test-link";
    if (item.roomPlayLink === true || item.testLink === true) {
      link.dataset.authorPlayLink = "";
    }
    nav.append(link);
  }

  const mobileActions = root.querySelector(".build-mobile-blocker__actions");
  for (const item of Array.isArray(config.mobileNavigation) ? config.mobileNavigation : config.navigation || []) {
    if (!item || !item.href || !item.label) continue;
    const link = document.createElement("a");
    link.className = "back-link";
    link.href = item.href;
    link.textContent = item.label;
    if (item.roomPlayLink === true) link.dataset.authorPlayLink = "";
    mobileActions.append(link);
  }

  const widthInput = document.getElementById("board-width");
  const heightInput = document.getElementById("board-height");
  if (widthInput) widthInput.max = String(authorData.maxBoardWidth || 64);
  if (heightInput) heightInput.max = String(authorData.maxBoardHeight || 64);

  if (capabilities.worldDetails === false) {
    document.getElementById("world-details-panel")?.setAttribute("hidden", "");
  }

  if (capabilities.publish === true) {
    const button = document.createElement("button");
    button.id = "publish-world";
    button.className = "tool-button";
    button.type = "button";
    button.textContent = "Publish";
    root.querySelector(".author-actions")?.append(button);
  } else {
    document.getElementById("publish-modal")?.setAttribute("hidden", "");
  }

  installChromeInteractionShield();
  installSidebarToggle();
  installWorldMapOverlay();
  installBootReveal();
  window.dispatchEvent(new CustomEvent("mazebench:author-shell-ready"));

  function installChromeInteractionShield() {
    const protectedTypes = new Set(["pointerdown", "pointermove", "contextmenu"]);
    const chromeSelector = [
      ".author-topbar",
      ".author-sidebar",
      ".author-sidebar-toggle",
      "#author-world-map-toggle",
      ".author-world-map-overlay",
      "#author-cam-pad",
      "#author-hotbar",
      "#author-inventory",
      ".author-info-popover",
      ".publish-modal",
      ".solver-dock",
      ".build-mobile-blocker"
    ].join(",");
    const originalAddEventListener = document.addEventListener.bind(document);

    function isCaptureOption(options) {
      return options === true || (options && typeof options === "object" && options.capture === true);
    }

    function targetsEditorChrome(event) {
      const target = event.target instanceof Element ? event.target : null;
      return Boolean(target && target.closest(chromeSelector));
    }

    function wrapDocumentListener(listener) {
      if (typeof listener === "function") {
        return function shieldedDocumentListener(event) {
          if (targetsEditorChrome(event)) return;
          return listener.call(this, event);
        };
      }
      if (listener && typeof listener.handleEvent === "function") {
        return { handleEvent(event) { if (!targetsEditorChrome(event)) return listener.handleEvent(event); } };
      }
      return listener;
    }

    document.addEventListener = function addAuthorShieldedDocumentListener(type, listener, options) {
      if (protectedTypes.has(String(type)) && isCaptureOption(options)) {
        return originalAddEventListener(type, wrapDocumentListener(listener), options);
      }
      return originalAddEventListener(type, listener, options);
    };
    window.__MAZEBENCH_AUTHOR_CHROME_SHIELD__ = { targetsEditorChrome };
  }

  function installSidebarToggle() {
    const layout = root.querySelector(".author-layout");
    const toggle = document.getElementById("author-sidebar-toggle");
    const workspace = root.querySelector(".author-workspace");
    const gridShell = root.querySelector(".author-grid-shell");
    if (!layout || !toggle) return;

    function syncAuthorAppViewport(collapsed, attempts = 0) {
      const app = window.__MAZEBENCH_AUTHOR_APP__;
      if (!app) {
        if (collapsed && attempts < 20) window.setTimeout(() => syncAuthorAppViewport(collapsed, attempts + 1), 80);
        return;
      }
      if (collapsed) {
        if (!app.__mazebenchSidebarNormalViewport) {
          app.__mazebenchSidebarNormalViewport = {
            boardRect: { ...(app.boardRect || {}) },
            viewportRect: { ...(app.viewportRect || {}) },
            hostFullBleedView: app.hostFullBleedView === true,
            mazeFrame: app.mazeFrame || null,
            playShell: app.playShell || null,
            playStage: app.playStage || null
          };
        }
        app.hostFullBleedView = true;
        app.playShell = layout;
        app.playStage = workspace || gridShell;
        app.mazeFrame = gridShell || app.mazeFrame;
      } else if (app.__mazebenchSidebarNormalViewport) {
        const saved = app.__mazebenchSidebarNormalViewport;
        gridShell?.style.removeProperty("height");
        gridShell?.style.removeProperty("width");
        app.boardRect = { ...saved.boardRect };
        app.viewportRect = { ...saved.viewportRect };
        app.hostFullBleedView = saved.hostFullBleedView;
        app.playShell = saved.playShell;
        app.playStage = saved.playStage;
        app.mazeFrame = saved.mazeFrame;
        app.__mazebenchSidebarNormalViewport = null;
      }
      app.syncPlayLayout?.();
      app.syncEditorCameraDownshift?.();
      app.setupCanvas?.();
      app.syncCameraTarget?.(true);
      app.render?.();
    }

    function announceResize() {
      syncAuthorAppViewport(layout.classList.contains("is-sidebar-collapsed"));
      window.dispatchEvent(new Event("resize"));
    }

    function setSidebarCollapsed(collapsed) {
      layout.classList.toggle("is-sidebar-collapsed", collapsed);
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      toggle.setAttribute("aria-label", collapsed ? "Show editor toolbar" : "Hide editor toolbar");
      toggle.title = collapsed ? "Show tools" : "Hide tools";
      window.requestAnimationFrame(announceResize);
      window.setTimeout(announceResize, 220);
    }

    toggle.addEventListener("click", () => setSidebarCollapsed(!layout.classList.contains("is-sidebar-collapsed")));
  }

  function installWorldMapOverlay() {
    const button = document.getElementById("author-world-map-toggle");
    const overlay = document.getElementById("author-world-map-overlay");
    const closeButton = document.getElementById("author-world-map-close");
    const swapButton = document.getElementById("author-world-map-swap");
    const tray = document.getElementById("existing-levels");
    if (!button || !overlay || !closeButton || !swapButton || !tray) return;
    let closeTimer = null;

    function fitMap() {
      const columns = Math.max(1, authorData.worldColumns?.length || 1);
      const rows = Math.max(1, authorData.worldRows?.length || 1);
      const viewportWidth = window.visualViewport?.width || window.innerWidth || 980;
      const viewportHeight = window.visualViewport?.height || window.innerHeight || 720;
      const topbarHeight =
        Number.parseFloat(
          window.getComputedStyle(document.documentElement).getPropertyValue("--build-topbar-height")
        ) || 64;
      const availableWidth = Math.max(80, Math.min(980, viewportWidth - 80));
      const availableHeight = Math.max(80, viewportHeight - topbarHeight - 200);
      const tileSize = Math.max(
        8,
        Math.floor(Math.min(82, availableWidth / columns, availableHeight / rows))
      );
      tray.style.setProperty("--author-world-map-tile-size", tileSize + "px");
    }

    function openMap() {
      if (closeTimer) window.clearTimeout(closeTimer);
      fitMap();
      overlay.hidden = false;
      button.setAttribute("aria-expanded", "true");
      window.requestAnimationFrame(() => {
        overlay.classList.remove("is-closing");
        overlay.classList.add("is-open");
        closeButton.focus({ preventScroll: true });
      });
    }

    function closeMap({ restoreFocus = true } = {}) {
      overlay.classList.remove("is-open");
      overlay.classList.add("is-closing");
      button.setAttribute("aria-expanded", "false");
      closeTimer = window.setTimeout(() => {
        overlay.hidden = true;
        overlay.classList.remove("is-closing");
      }, 190);
      window.dispatchEvent(new CustomEvent("mazebench:author-world-map-closed"));
      if (restoreFocus) button.focus({ preventScroll: true });
    }

    button.addEventListener("click", () => {
      if (overlay.hidden) openMap();
      else closeMap();
    });
    closeButton.addEventListener("click", () => closeMap());
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeMap();
      if (
        event.target.closest("[data-level-id]") &&
        swapButton.getAttribute("aria-pressed") !== "true"
      ) {
        closeMap({ restoreFocus: false });
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !overlay.hidden) {
        event.preventDefault();
        closeMap();
      }
    });
    window.addEventListener("resize", fitMap);
    window.visualViewport?.addEventListener("resize", fitMap);
  }

  function installBootReveal() {
    const grid = root.querySelector(".author-grid-shell");
    if (!grid) return;
    let revealed = false;
    function reveal() {
      if (revealed) return;
      revealed = true;
      grid.classList.remove("is-loading");
      grid.classList.add("is-ready");
      window.setTimeout(() => grid.classList.remove("is-ready"), 320);
    }
    grid.classList.add("is-loading");
    window.__MAZEBENCH_AUTHOR_MARK_READY__ = reveal;
    window.__MAZEJAM_AUTHOR_MARK_READY__ = reveal;
    window.setTimeout(reveal, 8000);
  }
})();
