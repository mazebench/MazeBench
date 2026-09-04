(() => {
  const data = window.__AGENT_DATA__ || {
    worlds: [],
    apiUrl: "/api/agent/runs",
    harnessesApiUrl: "/api/agent/harnesses",
    modelsApiBase: "/api/agent/models",
    environment: {},
    remote: {}
  };
  const statusEl = document.getElementById("agent-status");
  const launchStatusEl = document.getElementById("agent-launch-status");
  const runsEl = document.getElementById("agent-runs");

  // Harnesses are a small data registry on purpose: Prime can add another
  // built-in harness without changing the model or run-settings flow.
  const HARNESSES = [
    {
      id: "custom",
      name: "Prime Agent",
      logo: '<img src="/logos/prime.png" alt="" width="128" height="128" loading="eager" decoding="sync" fetchpriority="high">'
    },
    {
      id: "codex",
      name: "Codex",
      logo: '<img src="/logos/codex.png" alt="" width="128" height="128" loading="eager" decoding="sync" fetchpriority="high">'
    },
    {
      id: "claude-code",
      name: "Claude Code",
      logo: '<img src="/logos/claude.png" alt="" width="128" height="128" loading="eager" decoding="sync" fetchpriority="high">'
    },
    {
      id: "kimi-code",
      name: "Kimi Code",
      logo: '<img src="/logos/kimi.svg" alt="" width="128" height="128" loading="eager" decoding="sync" fetchpriority="high">'
    },
    {
      id: "muse-code",
      name: "Muse Code",
      logo: '<img src="/logos/muse-code.svg" alt="" width="128" height="128" loading="eager" decoding="sync" fetchpriority="high">'
    }
  ];
  const LOCAL_SETUP = {
    codex: {
      docs: "https://developers.openai.com/codex/cli/",
      install: "npm install -g @openai/codex\ncodex login",
      login: "codex login"
    },
    "claude-code": {
      docs: "https://docs.anthropic.com/en/docs/claude-code/getting-started",
      install: "npm install -g @anthropic-ai/claude-code\nclaude auth login",
      login: "claude auth login"
    },
    "kimi-code": {
      docs: "https://moonshotai.github.io/kimi-code/en/guides/getting-started.html",
      install: "npm install -g @moonshot-ai/kimi-code\nkimi login",
      login: "kimi login"
    },
    "muse-code": {
      docs: "https://research.meta.ai/blog/introducing-muse-code-and-muse-spark-1-2/",
      install: "curl -fsSL https://dev.meta.ai/install.sh | bash\nmuse login",
      login: "muse login"
    }
  };
  const PRIME_SETUP = {
    docs: "https://docs.primeintellect.ai/cli-reference/introduction",
    install: [
      "# Install uv only if needed",
      "curl -LsSf https://astral.sh/uv/install.sh | sh",
      "",
      "# Install Prime and sign in",
      "uv tool install -U prime",
      "prime login"
    ].join("\n"),
    login: "prime login"
  };
  const RUN_COMPANY_NAMES = {
    codex: "OpenAI",
    claude: "Anthropic",
    kimi: "Moonshot AI",
    muse: "Meta",
    prime: "Prime Intellect"
  };
  const RUN_STATUS_LABELS = {
    waiting: "Waiting",
    running: "Running",
    paused: "Paused",
    pausing: "Pausing",
    stopping: "Stopping",
    stopped: "Stopped",
    finished: "Ended",
    failed: "Failed"
  };

  const MODELS_LOADING_MARKUP =
    '<div class="models-loading" role="status" aria-live="polite"><span class="inline-spinner" aria-hidden="true"></span><span class="models-loading__label">Loading models</span></div>';
  // Route, Gem, and Door Open from Lucide Icons (ISC License).
  const RUN_METRIC_ICONS = {
    moves: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><circle cx="6" cy="19" r="3"></circle><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"></path><circle cx="18" cy="5" r="3"></circle></svg>',
    gems: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M10.5 3 8 9l4 13 4-13-2.5-6"></path><path d="M17 3a2 2 0 0 1 1.6.8l3 4a2 2 0 0 1 .013 2.382l-7.99 10.986a2 2 0 0 1-3.247 0l-7.99-10.986A2 2 0 0 1 2.4 7.8l2.998-3.997A2 2 0 0 1 7 3z"></path><path d="M2 9h20"></path></svg>',
    rooms: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M11 20H2"></path><path d="M11 4.562v16.157a1 1 0 0 0 1.242.97L19 20V5.562a2 2 0 0 0-1.515-1.94l-4-1A2 2 0 0 0 11 4.561z"></path><path d="M11 4H8a2 2 0 0 0-2 2v14"></path><path d="M14 12h.01"></path><path d="M22 20h-3"></path></svg>'
  };
  // Star and Trash 2 from Lucide Icons (ISC License).
  const FAVORITE_ICON = '<svg class="favorite-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.12 2.12 0 0 0 1.595 1.16l5.164.75a.53.53 0 0 1 .294.904l-3.737 3.643a2.12 2.12 0 0 0-.609 1.873l.882 5.143a.53.53 0 0 1-.77.559l-4.618-2.428a2.12 2.12 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.882-5.143a2.12 2.12 0 0 0-.61-1.873L2.163 9.79a.53.53 0 0 1 .294-.906l5.165-.75a2.12 2.12 0 0 0 1.595-1.16z"></path></svg>';
  const TRASH_ICON = '<svg class="trash-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
  const resizeAnimations = new WeakMap();
  const visibilityAnimations = new WeakMap();
  const selectionTargets = new WeakMap();
  let pendingLaunches = 0;
  let launchStatusHideTimer = null;

  const state = {
    execution: "prime",
    harness: null,
    customHarnesses: [],
    customHarnessId: "",
    customHarnessConfig: {},
    customHarnessesLoaded: false,
    modelId: null,
    customModel: "",
    reasoning: null,
    reasoningChosen: false,
    worldId: null,
    levelId: null, // null = use the world's default from its metadata
    mode: null,
    omniscient: false,
    hideNames: true,
    hideNamesSeed: "1",
    toolUse: null,
    autoRunTools: false,
    autoRunAllFrames: false,
    orchestration: null,
    unlimited: false,
    allowQuit: null,
    autoQuit: null,
    autoQuitThreshold: 10,
    autoQuitMode: "rolling",
    autoQuitWindow: 100,
    catalogs: {},
    catalogRequests: {},
    openFolders: new Set(),
    modelQuery: "",
    localAvailability: "idle"
  };

  function setStatus(message, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.classList.toggle("is-error", Boolean(isError));
  }

  function syncLaunchStatus() {
    if (!launchStatusEl) return;
    window.clearTimeout(launchStatusHideTimer);
    if (pendingLaunches > 0) {
      launchStatusEl.hidden = false;
      window.requestAnimationFrame(() => {
        if (pendingLaunches > 0) launchStatusEl.classList.add("is-visible");
      });
      return;
    }

    launchStatusEl.classList.remove("is-visible");
    launchStatusHideTimer = window.setTimeout(() => {
      if (pendingLaunches === 0) launchStatusEl.hidden = true;
    }, 220);
  }

  function beginLaunch() {
    pendingLaunches += 1;
    syncLaunchStatus();
  }

  function finishLaunch() {
    pendingLaunches = Math.max(0, pendingLaunches - 1);
    syncLaunchStatus();
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
    return payload;
  }

  function escapeText(value) {
    const el = document.createElement("span");
    el.textContent = String(value ?? "");
    return el.innerHTML;
  }

  function tweenResize(element, mutate, duration = 380) {
    if (!element) {
      mutate();
      return;
    }

    resizeAnimations.get(element)?.cancel();
    const startHeight = element.getBoundingClientRect().height;
    mutate();
    const endHeight = element.getBoundingClientRect().height;

    if (
      Math.abs(startHeight - endHeight) < 1 ||
      !element.animate ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const previousOverflow = element.style.overflow;
    element.style.overflow = "clip";
    const animation = element.animate(
      [{ height: `${startHeight}px` }, { height: `${endHeight}px` }],
      { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    );
    resizeAnimations.set(element, animation);
    const cleanup = () => {
      if (resizeAnimations.get(element) === animation) resizeAnimations.delete(element);
      element.style.overflow = previousOverflow;
    };
    animation.addEventListener("finish", cleanup, { once: true });
    animation.addEventListener("cancel", cleanup, { once: true });
  }

  function tweenVisibility(element, show, duration = 380, onComplete) {
    if (!element) {
      onComplete?.();
      return;
    }
    const current = visibilityAnimations.get(element);
    if (current?.show === show) return;
    current?.animation.cancel();

    if (show && !element.hidden) {
      onComplete?.();
      return;
    }
    if (!show && element.hidden) {
      onComplete?.();
      return;
    }
    if (!element.animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      element.hidden = !show;
      onComplete?.();
      return;
    }

    if (show) element.hidden = false;
    const fullHeight = element.getBoundingClientRect().height;
    const computedStyle = window.getComputedStyle(element);
    const expandedFrame = {
      height: `${fullHeight}px`,
      marginBottom: computedStyle.marginBottom,
      marginTop: computedStyle.marginTop,
      opacity: 1
    };
    const collapsedFrame = {
      height: "0px",
      marginBottom: "0px",
      marginTop: "0px",
      opacity: 0
    };
    const previousOverflow = element.style.overflow;
    element.style.overflow = "clip";
    const animation = element.animate(
      show ? [collapsedFrame, expandedFrame] : [expandedFrame, collapsedFrame],
      { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    );
    const entry = { animation, show };
    visibilityAnimations.set(element, entry);
    const cleanup = (finished) => {
      if (visibilityAnimations.get(element) !== entry) return;
      visibilityAnimations.delete(element);
      element.style.overflow = previousOverflow;
      if (finished && !show) element.hidden = true;
      if (finished) onComplete?.();
    };
    animation.addEventListener("finish", () => cleanup(true), { once: true });
    animation.addEventListener("cancel", () => cleanup(false), { once: true });
  }

  async function waitForVisibilityTween(element) {
    const entry = element ? visibilityAnimations.get(element) : null;
    if (!entry) return;
    try {
      await entry.animation.finished;
    } catch {
      // Reversed or cancelled by a newer selection.
    }
  }

  function selectedRect(host, selector) {
    const selected = typeof selector === "function" ? selector(host) : host?.querySelector(selector);
    if (!host || !selected) return null;
    const hostRect = host.getBoundingClientRect();
    const rect = selected.getBoundingClientRect();
    return {
      left: rect.left - hostRect.left + host.scrollLeft,
      top: rect.top - hostRect.top + host.scrollTop,
      width: rect.width,
      height: rect.height
    };
  }

  function renderSelectionSlider(host, selector, fromRect, variant) {
    if (!host) return;
    host.querySelector(":scope > .selection-slider")?.remove();
    if (variant === "model") {
      selectionTargets.delete(host);
      return;
    }
    selectionTargets.set(host, { selector, variant });
    const toRect = selectedRect(host, selector);
    if (!toRect) return;

    const slider = document.createElement("span");
    slider.className = `selection-slider selection-slider--${variant}`;
    slider.setAttribute("aria-hidden", "true");
    Object.assign(slider.style, {
      left: `${toRect.left}px`,
      top: `${toRect.top}px`,
      width: `${toRect.width}px`,
      height: `${toRect.height}px`
    });
    host.appendChild(slider);

    if (
      variant === "world" ||
      !fromRect ||
      !slider.animate ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    slider.animate(
      [
        {
          left: `${fromRect.left}px`,
          top: `${fromRect.top}px`,
          width: `${fromRect.width}px`,
          height: `${fromRect.height}px`
        },
        {
          left: `${toRect.left}px`,
          top: `${toRect.top}px`,
          width: `${toRect.width}px`,
          height: `${toRect.height}px`
        }
      ],
      { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    );
  }

  function syncSelectionSlider(host) {
    const target = selectionTargets.get(host);
    const slider = host?.querySelector(":scope > .selection-slider");
    if (!target || !slider) return;
    const rect = selectedRect(host, target.selector);
    if (!rect) return;
    Object.assign(slider.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`
    });
  }

  function syncAllSelectionSliders() {
    ["provider-picker", "model-picker", "world-picker", "reasoning-picker"].forEach((id) => {
      syncSelectionSlider(document.getElementById(id));
    });
  }

  function modelSelectionElement(host) {
    return [...(host?.querySelectorAll(".chip.is-selected") || [])].find((chip) => {
      const folder = chip.closest(".model-folder");
      return chip.offsetParent !== null && (!folder || folder.classList.contains("is-open"));
    })
      || host?.querySelector(".model-folder.has-selected .model-folder__head")
      || null;
  }

  function currentWorld() {
    return data.worlds.find((world) => world.id === state.worldId) || data.worlds[0] || null;
  }

  function effectiveLevelId() {
    const world = currentWorld();
    if (!world) return null;
    return state.levelId && world.levels.some((level) => level.id === state.levelId)
      ? state.levelId
      : world.default_level_id;
  }

  function levelLabel(levelId) {
    return String(levelId || "").replace(/^level_/, "");
  }

  function composerSettingsReady() {
    return Boolean(
      state.harness &&
      (state.harness !== "custom" || customHarnessConfigReady()) &&
      state.modelId &&
      state.reasoningChosen &&
      (state.execution === "prime" || state.worldId)
    );
  }

  function primePythonToolsAvailable() {
    return state.execution === "prime" &&
      state.mode !== "vision" &&
      ["codex", "claude_code"].includes(effectiveHarnessId());
  }

  function runOptionsReady() {
    const isolatedLocalAgent = state.execution === "local" && Boolean(localProviderId());
    return Boolean(
      composerSettingsReady() &&
      state.mode &&
      (
        state.execution === "prime"
          ? (!primePythonToolsAvailable() || state.toolUse)
          : isolatedLocalAgent ? state.toolUse : (state.toolUse && state.orchestration)
      )
    );
  }

  function moveBudget() {
    if (state.unlimited) return null;
    const input = document.getElementById(state.execution === "prime" ? "run-prime-turns" : "run-moves");
    return Math.max(0, Math.floor(Number(input?.value) || 0));
  }

  function runReady() {
    return runOptionsReady() &&
      state.allowQuit !== null &&
      state.autoQuit !== null &&
      (state.unlimited || moveBudget() > 0);
  }

  function syncComposerSteps(animate = true) {
    const hasHarness = Boolean(state.harness);
    const hasModel = Boolean(state.modelId);
    const showTarget = hasHarness && hasModel && state.reasoningChosen && state.execution === "local";
    const showSettings = composerSettingsReady();
    const showRun = runReady();
    const visibility = [
      [document.querySelector(".composer-section--model"), hasHarness],
      [document.querySelector(".composer-section--reasoning"), hasHarness && hasModel],
      [document.getElementById("world-section"), showTarget],
      [document.querySelector(".composer-section--settings"), showSettings],
      [document.querySelector(".composer-section--run"), showRun]
    ];

    visibility.forEach(([element, show]) => {
      if (!element) return;
      if (animate) tweenVisibility(element, show, 440);
      else element.hidden = !show;
    });
  }

  // ---- harness picker -----------------------------------------------------

  function selectedCustomHarness() {
    return state.customHarnesses.find((entry) => entry.id === state.customHarnessId) || null;
  }

  function customHarnessConfigReady() {
    const selected = selectedCustomHarness();
    return Boolean(selected?.launchable) && !document.querySelector("[data-harness-config][aria-invalid='true']");
  }

  function effectiveHarnessId(harnessId = state.harness) {
    if (harnessId === "custom") return state.customHarnessId;
    if (harnessId === "claude-code") return "claude_code";
    if (harnessId === "kimi-code") return "kimi_code";
    if (harnessId === "muse-code") return "muse_code";
    return harnessId;
  }

  function primeHarnessLaunchable() {
    const harnessId = effectiveHarnessId();
    if (harnessId === "none") return true;
    const definition = state.customHarnesses.find((entry) => entry.id === harnessId);
    return Boolean(definition?.launchable);
  }

  function localProviderId(harnessId = state.harness) {
    if (harnessId === "codex") return "codex";
    if (harnessId === "claude-code") return "claude";
    if (harnessId === "kimi-code") return "kimi";
    if (harnessId === "muse-code") return "muse";
    return "";
  }

  function catalogKey(harnessId = state.harness, execution = state.execution) {
    return `${execution}:${effectiveHarnessId(harnessId) || "none"}`;
  }

  function renderExecutionPicker() {
    const wrapper = document.getElementById("harness-execution");
    const picker = document.getElementById("execution-picker");
    const supportsLocal = Boolean(localProviderId());
    if (wrapper) tweenVisibility(wrapper, supportsLocal, 420);
    picker?.querySelectorAll("[data-execution]").forEach((option) => {
      const blockedPrimeAgentHarness = option.dataset.execution === "prime" && !primeHarnessLaunchable();
      const selected = option.dataset.execution === state.execution;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-pressed", String(selected));
      option.disabled = blockedPrimeAgentHarness;
      option.classList.toggle("is-disabled", blockedPrimeAgentHarness);
      option.title = blockedPrimeAgentHarness
        ? (selectedCustomHarness()?.reason || "This harness has not passed the isolated game-control compatibility gate.")
        : "";
    });

    const status = document.getElementById("local-run-status");
    if (status) {
      const labels = { checking: "Checking", active: "Active", inactive: "Setup needed" };
      status.hidden = state.localAvailability === "idle";
      status.innerHTML = state.localAvailability === "checking"
        ? `<span class="execution-option__spinner" aria-hidden="true"></span><span>${labels.checking}</span>`
        : labels[state.localAvailability] || "";
      status.className = `execution-option__status is-${state.localAvailability}`;
    }

    const note = document.getElementById("execution-note");
    if (note) {
      note.textContent = state.harness === "custom"
        ? "The selected framework harness and game Toolset run in separate Prime Sandboxes."
        : state.harness && state.harness !== "none" && state.execution === "prime"
        ? state.harness === "codex"
          ? "Codex uses Prime model inference inside MazeBench's fresh disposable local isolation, with only the selected game/Python controls."
          : `${HARNESSES.find((entry) => entry.id === state.harness)?.name || "This harness"} is hosted by Prime and connected to MazeBench's isolated game controls.`
        : state.execution === "local"
          ? `Local ${HARNESSES.find((entry) => entry.id === state.harness)?.name || "agent"} runs in a disposable Docker boundary with game controls and an optional isolated Python scratchpad.`
          : "Prime supplies inference through the isolated Verifiers environment.";
    }
  }

  function setExecution(value) {
    const next = value === "local" && localProviderId() ? "local" : "prime";
    if (next === "prime" && !primeHarnessLaunchable()) {
      setStatus(selectedCustomHarness()?.reason || "This harness is not compatible with the isolated Prime game controls.", true);
      return;
    }
    if (next === "local" && !localProviderId()) return;
    if (state.execution === next) return;
    state.execution = next;
    state.modelId = null;
    state.customModel = "";
    state.modelQuery = "";
    state.reasoning = null;
    state.reasoningChosen = false;
    state.worldId = null;
    state.levelId = null;
    resetRunOptions();
    renderExecutionPicker();
    renderHarnesses();
    renderWorlds(null, false);
    renderLevelSummary();
    tweenResize(document.querySelector(".settings-stage"), () => {
      document.getElementById("local-settings").hidden = next !== "local";
      document.getElementById("prime-settings").hidden = next !== "prime";
    }, 440);
    tweenResize(document.querySelector(".model-browser"), renderModels, 440);
    syncComposerSteps();
    if (state.harness) {
      loadModels(state.harness, { fresh: !state.catalogs[catalogKey()] });
    }
  }

  function renderHarnesses(selectionFrom = null) {
    const host = document.getElementById("provider-picker");
    host.innerHTML = HARNESSES.map((harness) => {
      return `<button type="button" class="provider-card${state.harness === harness.id ? " is-selected" : ""}"
          data-harness="${harness.id}" role="radio" aria-checked="${state.harness === harness.id}">
        <span class="provider-card__logo">${harness.logo}</span>
        <span class="provider-card__name">${escapeText(harness.name)}</span>
      </button>`;
    }).join("");

    host.querySelectorAll(".provider-card").forEach((card) => {
      card.addEventListener("click", () => selectHarness(card.dataset.harness));
    });
    renderSelectionSlider(host, ".provider-card.is-selected", selectionFrom, "provider");
  }

  function renderCustomHarnessPicker() {
    const panel = document.getElementById("custom-harness-panel");
    const select = document.getElementById("custom-harness-id");
    const status = document.getElementById("custom-harness-status");
    const note = document.getElementById("custom-harness-note");
    const configFields = document.getElementById("custom-harness-config-fields");
    if (!panel || !select || !status || !note || !configFields) return;

    panel.hidden = state.harness !== "custom";
    if (panel.hidden) return;
    if (!state.customHarnessesLoaded) {
      select.innerHTML = '<option value="">Loading…</option>';
      select.disabled = true;
      status.textContent = "Loading reviewed harnesses…";
      note.textContent = "";
      configFields.innerHTML = "";
      return;
    }

    select.disabled = false;
    select.innerHTML = state.customHarnesses.map((entry) => (
      `<option value="${escapeText(entry.id)}"${entry.id === state.customHarnessId ? " selected" : ""}${entry.launchable ? "" : " disabled"}>${escapeText(entry.label)}${entry.launchable ? "" : " — unavailable"}</option>`
    )).join("");
    const selected = selectedCustomHarness();
    if (!selected) {
      status.textContent = "No compatible harness is selected";
      status.classList.add("is-blocked");
      note.textContent = "MazeBench did not receive a launchable reviewed harness from the server.";
      configFields.innerHTML = "";
      return;
    }

    const routeLabels = {
      native: "native Verifiers harness",
      prime_agent_cli: "official Prime Agent v0.7.0"
    };
    status.textContent = selected.launchable
      ? `${selected.label} · ${routeLabels[selected.adapter] || "isolated gateway"}`
      : `${selected.label} · catalog error`;
    status.classList.toggle("is-blocked", !selected.launchable);
    note.textContent = selected.launchable ? selected.description : selected.reason;
    const properties = selected.config_schema?.properties || {};
    configFields.innerHTML = (selected.configurable || []).map((name) => {
      const schema = properties[name] || {};
      const value = state.customHarnessConfig[name];
      const unionTypes = [...new Set((schema.anyOf || []).map((entry) => entry.type).filter((type) => type && type !== "null"))];
      const type = schema.type || (unionTypes.length > 1 ? "json" : unionTypes[0]) || typeof value;
      const title = schema.title || name.replaceAll("_", " ");
      const description = schema.description ? `<small>${escapeText(schema.description)}</small>` : "";
      if (type === "boolean") {
        return `<label class="field"><span>${escapeText(title)}</span><select data-harness-config="${escapeText(name)}" data-config-type="boolean"><option value="true"${value === true ? " selected" : ""}>Enabled</option><option value="false"${value === false ? " selected" : ""}>Disabled</option></select>${description}</label>`;
      }
      if (type === "array" || type === "object" || type === "json") {
        return `<label class="field"><span>${escapeText(title)} (JSON)</span><textarea data-harness-config="${escapeText(name)}" data-config-type="json" rows="2" spellcheck="false">${escapeText(JSON.stringify(value ?? (type === "array" ? [] : {})))}</textarea>${description}</label>`;
      }
      const inputType = ["integer", "number"].includes(type) ? "number" : "text";
      const step = type === "number" ? " step=\"any\"" : type === "integer" ? " step=\"1\"" : "";
      return `<label class="field"><span>${escapeText(title)}</span><input data-harness-config="${escapeText(name)}" data-config-type="${escapeText(type)}" type="${inputType}"${step} value="${escapeText(value ?? "")}" autocomplete="off" spellcheck="false">${description}</label>`;
    }).join("");
  }

  async function loadCustomHarnesses() {
    if (state.customHarnessesLoaded) return;
    renderCustomHarnessPicker();
    try {
      const payload = await api(data.harnessesApiUrl || "/api/agent/harnesses");
      state.customHarnesses = Array.isArray(payload.harnesses) ? payload.harnesses : [];
      state.customHarnessesLoaded = true;
      const firstLaunchable = state.customHarnesses.find((entry) => entry.launchable);
      if (!state.customHarnessId || !state.customHarnesses.some((entry) => entry.id === state.customHarnessId)) {
        state.customHarnessId = firstLaunchable?.id || state.customHarnesses[0]?.id || "";
      }
      const selected = selectedCustomHarness();
      state.customHarnessConfig = { ...(selected?.default_config || {}) };
      renderCustomHarnessPicker();
      renderExecutionPicker();
      syncComposerSteps();
      if (state.harness === "custom" && selected?.launchable) {
        loadModels("custom", { fresh: !state.catalogs[catalogKey("custom")] });
      }
    } catch (error) {
      state.customHarnessesLoaded = true;
      state.customHarnesses = [];
      renderCustomHarnessPicker();
      setStatus(error.message, true);
    }
  }

  function selectCustomHarness(harnessId) {
    const selected = state.customHarnesses.find((entry) => entry.id === harnessId);
    if (!selected) return;
    state.customHarnessId = selected.id;
    state.customHarnessConfig = { ...(selected.default_config || {}) };
    state.modelId = null;
    state.customModel = "";
    state.reasoning = null;
    state.reasoningChosen = false;
    resetRunOptions();
    renderCustomHarnessPicker();
    renderExecutionPicker();
    renderModels();
    syncComposerSteps();
    if (selected.launchable) loadModels("custom", { fresh: !state.catalogs[catalogKey("custom")] });
  }

  function localRunAvailability(harnessId = state.harness, env = data.environment || {}) {
    if (env.checking || !Object.keys(env).length) {
      return { checking: true, available: false, installed: false, authenticated: false };
    }
    const provider = localProviderId(harnessId);
    if (!provider) return { checking: false, available: false, installed: false, authenticated: false };
    const installed = env[`${provider}_installed`] ?? Boolean(env[provider]);
    const authenticated = env[`${provider}_authenticated`] ?? Boolean(env[provider]);
    const subscription = env[`${provider}_subscription`] ?? Boolean(env[provider]);
    const imageVersions = env.local_agent_image_versions || {};
    const requiredVersions = env.local_agent_required_versions || {};
    return {
      checking: false,
      available: Boolean(env[provider]) && Boolean(subscription),
      installed: Boolean(installed),
      authenticated: Boolean(authenticated),
      subscription: Boolean(subscription),
      authMethod: env[`${provider}_auth_method`] || "",
      dockerInstalled: Boolean(env.docker_installed),
      dockerRunning: Boolean(env.docker_running),
      imageReady: Boolean(env.local_agent_image ?? env.local_codex_image),
      imageVersion: String(imageVersions[provider] || env.local_codex_image_version || ""),
      requiredVersion: String(requiredVersions[provider] || env.local_codex_required_version || "")
    };
  }

  let providerSetupRetry = null;

  function presentProviderSetup({ logo, title, message, command, note = "", docs, retry = null }) {
    const modal = document.getElementById("provider-setup-modal");
    if (!modal) return;
    const noteElement = document.getElementById("provider-setup-note");
    const closeButton = document.getElementById("provider-setup-close");

    providerSetupRetry = retry;
    document.getElementById("provider-setup-logo").innerHTML = logo || "";
    document.getElementById("provider-setup-title").textContent = title;
    document.getElementById("provider-setup-message").textContent = message;
    document.getElementById("provider-setup-command").textContent = command;
    document.getElementById("provider-setup-docs").href = docs;
    if (noteElement) {
      noteElement.textContent = note;
      noteElement.hidden = !note;
    }
    if (closeButton) closeButton.textContent = retry ? "Check again" : "Got it";
    modal.hidden = false;
    window.requestAnimationFrame(() => modal.classList.add("open"));
    window.setTimeout(() => closeButton?.focus(), 30);
  }

  function showLocalSetup(harnessId = state.harness, availability = localRunAvailability(harnessId)) {
    const harness = HARNESSES.find((entry) => entry.id === harnessId);
    const setup = LOCAL_SETUP[harnessId];
    if (!availability.dockerInstalled) {
      presentProviderSetup({
        logo: harness?.logo || "",
        title: "Install Docker Desktop",
        message: `${harness?.name || "This local agent"} is available only through MazeBench's disposable Docker isolation boundary.`,
        command: "Install Docker Desktop, start it, then return here.",
        note: "MazeBench intentionally has no host-access fallback.",
        docs: "https://docs.docker.com/desktop/",
        retry: () => checkLocalAvailability(harnessId)
      });
      return;
    }
    if (!availability.dockerRunning) {
      presentProviderSetup({
        logo: harness?.logo || "",
        title: "Start Docker Desktop",
        message: "Docker is installed, but its isolated runtime is not running.",
        command: "Open Docker Desktop and wait until it reports that Docker is running.",
        docs: "https://docs.docker.com/desktop/",
        retry: () => checkLocalAvailability(harnessId)
      });
      return;
    }
    if (!availability.imageReady) {
      presentProviderSetup({
        logo: harness?.logo || "",
        title: availability.imageVersion ? "Rebuild local agent isolation" : "Build local agent isolation",
        message: availability.imageVersion
          ? `The installed image contains ${harness?.name || "this provider"} ${availability.imageVersion}; MazeBench requires ${availability.requiredVersion}.`
          : "The reviewed MazeBench local-agent image has not been built yet.",
        command: "npm run maze:build-local-agents",
        note: "Run this from the MazeBenchEngine repository, then check again.",
        docs: setup.docs,
        retry: () => checkLocalAvailability(harnessId)
      });
      return;
    }
    const wrongLocalAuth = availability.authenticated && !availability.subscription;
    const message = !availability.installed
      ? `Install ${harness?.name || "the CLI"}, then sign in once from your terminal.`
      : wrongLocalAuth
        ? `${harness?.name} is signed in with ${availability.authMethod || "non-subscription credentials"}. Sign out, then sign in with your subscription account.`
      : !availability.authenticated
        ? `${harness?.name} is installed. Sign in once from your terminal, then try Local Run again.`
        : `Finish ${harness?.name} setup in your terminal, then try Local Run again.`;
    const command = wrongLocalAuth
      ? `${harnessId === "codex" ? "codex logout\ncodex login" : harnessId === "claude-code" ? "claude auth logout\nclaude auth login" : setup.login}`
      : availability.installed ? setup.login : setup.install;

    presentProviderSetup({
      logo: harness?.logo || "",
      title: `${harness?.name || "Local CLI"} account is unavailable`,
      message,
      command,
      docs: setup.docs
    });
  }

  function showPrimeSetup(environment = data.environment || {}) {
    const installed = Boolean(environment.prime_installed);
    if (!environment.prime) {
      presentProviderSetup({
        logo: '<img src="/logos/prime.png" alt="" width="128" height="128">',
        title: installed ? "Reconnect Prime" : "Install Prime CLI",
        message: installed
          ? "Your Prime login has expired or is no longer authorized. Run this command in a terminal to sign in again."
          : "Prime isn't installed on this computer yet. Run these commands in a terminal, then come back here.",
        command: installed ? PRIME_SETUP.login : PRIME_SETUP.install,
        note: installed
          ? "Prime will open a browser so you can authenticate securely."
          : "If uv is already installed, skip the first command.",
        docs: PRIME_SETUP.docs,
        retry: checkPrimeAvailability
      });
      return installed ? "Prime sign-in is needed." : "Prime CLI setup is needed.";
    }
    if (!environment.uv) {
      presentProviderSetup({
        logo: '<img src="/logos/prime.png" alt="" width="128" height="128">',
        title: "Install uv",
        message: "MazeBench uses uv to launch the isolated evaluation environment.",
        command: "curl -LsSf https://astral.sh/uv/install.sh | sh",
        docs: "https://docs.astral.sh/uv/getting-started/installation/",
        retry: checkPrimeAvailability
      });
      return "uv setup is needed.";
    }
    return "Prime and uv are ready.";
  }

  function closeProviderSetup() {
    const modal = document.getElementById("provider-setup-modal");
    modal?.classList.remove("open");
    window.setTimeout(() => {
      if (modal && !modal.classList.contains("open")) modal.hidden = true;
    }, 180);
  }

  async function closeOrRetryProviderSetup() {
    const retry = providerSetupRetry;
    providerSetupRetry = null;
    closeProviderSetup();
    if (retry) await retry();
  }

  let localAvailabilityRequest = 0;
  let primeAvailabilityRequest = 0;

  async function checkPrimeAvailability() {
    const requestId = ++primeAvailabilityRequest;
    setStatus("Checking Prime login…");

    try {
      const environment = await refreshEnvironment();
      if (requestId !== primeAvailabilityRequest || state.execution !== "prime") return environment;
      if (!environment.prime || !environment.uv) {
        setStatus(showPrimeSetup(environment), true);
        return environment;
      }
      setStatus("Prime and uv are ready.");
      return environment;
    } catch (error) {
      if (requestId !== primeAvailabilityRequest || state.execution !== "prime") return null;
      setStatus(error.message, true);
      return null;
    }
  }

  async function checkLocalAvailability(harnessId = state.harness) {
    if (!localProviderId(harnessId)) return;
    const requestId = ++localAvailabilityRequest;
    state.localAvailability = "checking";
    renderExecutionPicker();
    const harnessName = HARNESSES.find((entry) => entry.id === harnessId)?.name || "Local";
    setStatus(`Checking ${harnessName} account…`);

    try {
      const env = await refreshEnvironment();
      if (requestId !== localAvailabilityRequest || state.harness !== harnessId) return;
      const availability = localRunAvailability(harnessId, env);
      if (!availability.available) {
        if (state.execution === "local") setExecution("prime");
        state.localAvailability = "inactive";
        renderExecutionPicker();
        setStatus(
          !availability.dockerInstalled
            ? `Docker setup is needed for isolated local ${harnessName}.`
            : !availability.dockerRunning
              ? `Start Docker to use isolated local ${harnessName}.`
              : !availability.imageReady
                ? "Build the certified local-agent image."
                : `Local ${harnessName} account setup is needed.`,
          true
        );
        return availability;
      }

      state.localAvailability = "active";
      renderExecutionPicker();
      setStatus(`${harnessName} local account is active.`);
      return availability;
    } catch (error) {
      if (requestId !== localAvailabilityRequest || state.harness !== harnessId) return;
      if (state.execution === "local") setExecution("prime");
      state.localAvailability = "inactive";
      renderExecutionPicker();
      setStatus(error.message, true);
    }
  }

  function selectLocalRun() {
    const harnessId = state.harness;
    if (!localProviderId(harnessId)) return;
    if (state.localAvailability === "active") {
      setExecution("local");
      return;
    }
    if (state.localAvailability === "inactive") {
      showLocalSetup(harnessId, localRunAvailability(harnessId));
      return;
    }
    if (state.localAvailability === "idle") checkLocalAvailability(harnessId);
  }

  function selectHarness(harnessId) {
    if (state.harness === harnessId) {
      if (state.execution === "prime") void checkPrimeAvailability();
      return;
    }
    const providerHost = document.getElementById("provider-picker");
    const providerSelectionFrom = selectedRect(providerHost, ".provider-card.is-selected");
    localAvailabilityRequest += 1;
    state.execution = harnessId === "muse-code" ? "local" : "prime";
    state.localAvailability = "idle";
    state.harness = harnessId;
    state.modelId = null;
    state.customModel = "";
    state.modelQuery = "";
    state.worldId = null;
    state.levelId = null;
    renderWorlds(null, false);
    renderLevelSummary();
    const modelSearchInput = document.getElementById("model-search-input");
    if (modelSearchInput) modelSearchInput.value = "";
    state.reasoning = null;
    state.reasoningChosen = false;
    resetRunOptions();
    document.getElementById("run-codex-fast").checked = false;

    providerHost.querySelectorAll(".provider-card").forEach((card) => {
      const selected = card.dataset.harness === harnessId;
      card.classList.toggle("is-selected", selected);
      card.setAttribute("aria-checked", String(selected));
    });
    renderSelectionSlider(providerHost, ".provider-card.is-selected", providerSelectionFrom, "provider");
    renderCustomHarnessPicker();
    renderExecutionPicker();

    tweenResize(document.querySelector(".settings-stage"), () => {
      document.getElementById("local-settings").hidden = state.execution !== "local";
      document.getElementById("prime-settings").hidden = state.execution !== "prime";
    }, 440);
    tweenResize(document.querySelector(".model-browser"), renderModels, 440);
    syncComposerSteps();
    if (harnessId === "custom" && !state.customHarnessesLoaded) {
      void loadCustomHarnesses();
    } else if (harnessId !== "custom" || selectedCustomHarness()?.launchable) {
      loadModels(harnessId, { fresh: !state.catalogs[catalogKey(harnessId)] });
    }
    if (state.execution === "prime") void checkPrimeAvailability();
    if (localProviderId(harnessId)) void checkLocalAvailability(harnessId);
  }

  // ---- model picker ---------------------------------------------------------

  async function loadModels(harnessId, { fresh = false } = {}) {
    const execution = state.execution;
    const resolvedHarnessId = effectiveHarnessId(harnessId);
    if (!resolvedHarnessId) return;
    const key = catalogKey(harnessId, execution);
    const existing = state.catalogs[key];
    if (existing?.models?.length && !fresh) {
      return;
    }

    const requestId = (state.catalogRequests[key] || 0) + 1;
    state.catalogRequests[key] = requestId;

    const host = document.getElementById("model-picker");
    tweenResize(document.querySelector(".model-browser"), () => {
      host.innerHTML = MODELS_LOADING_MARKUP;
    });
    const refreshButton = document.getElementById("refresh-models");
    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.textContent = "Refreshing…";
    }

    try {
      const provider = execution === "prime" ? "prime" : localProviderId(harnessId);
      const query = new URLSearchParams();
      if (execution === "prime") query.set("harness", resolvedHarnessId);
      if (fresh) {
        query.set("refresh", "1");
        query.set("t", String(Date.now()));
      }
      const suffix = query.size ? `?${query}` : "";
      const catalog = await api(`${data.modelsApiBase}/${encodeURIComponent(provider)}${suffix}`);
      if (state.catalogRequests[key] !== requestId) return;
      state.catalogs[key] = catalog;
    } catch (error) {
      if (state.catalogRequests[key] !== requestId) return;
      // A transient request failure must never erase a catalog that was
      // already rendered successfully.
      if (!existing?.models?.length) {
        state.catalogs[key] = { models: [], note: error.message };
      }
    } finally {
      if (refreshButton && state.catalogRequests[key] === requestId) {
        refreshButton.disabled = false;
        refreshButton.textContent = "↻ Refresh";
      }
    }

    if (state.execution === execution && state.harness === harnessId) {
      await waitForVisibilityTween(document.querySelector(".composer-section--model"));
      if (state.execution !== execution || state.harness !== harnessId) return;
      const models = state.catalogs[key]?.models || [];
      if (state.modelId !== "__custom__" && !models.some((model) => model.id === state.modelId)) {
        state.modelId = null;
      }
      tweenResize(document.querySelector(".model-browser"), () => {
        renderModels(null, true);
      });
    }
  }

  function selectedModel() {
    const catalog = state.catalogs[catalogKey()] || { models: [] };
    return catalog.models.find((model) => model.id === state.modelId) || null;
  }

  function modelPrice(pricing) {
    if (!pricing) return "";
    const money = (value) => Number(value).toFixed(3).replace(/\.?0+$/, "");
    const input = Number.isFinite(pricing.input) ? `$${money(pricing.input)}` : "";
    const output = Number.isFinite(pricing.output) ? `$${money(pricing.output)}` : "";
    return input && output ? `${input} in / ${output} out per MTok` : "";
  }

  function modelChip(model, { showGroup = false } = {}) {
    const details = modelPrice(model.pricing);
    return `<button type="button" class="chip${state.modelId === model.id ? " is-selected" : ""}"
        data-model-id="${escapeText(model.id)}" role="radio" aria-checked="${state.modelId === model.id}">
      ${showGroup && model.group ? `<span class="chip__eyebrow">${escapeText(model.group)}</span>` : ""}
      <span class="chip__topline">
        <span class="chip__label">${escapeText(model.label)}</span>
      </span>
      ${details ? `<span class="chip__sub">${escapeText(details)}</span>` : ""}
    </button>`;
  }

  function catalogTime(catalog) {
    const value = catalog.updated_at || catalog.checked_at;
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${catalog.updated_at ? "updated" : "checked"} ${date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    })}`;
  }

  function revealModelChoices(host) {
    if (!host || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const choices = [...host.querySelectorAll(
      ".model-recent .chip, .model-search-results .chip, .model-folders > .model-folder, .model-grid--primary > .chip, .model-custom-row > .chip"
    )].filter((choice) => choice.offsetParent !== null);

    choices.forEach((choice, index) => {
      choice.animate(
        [
          { opacity: 0, transform: "translateY(8px) scale(0.985)" },
          { opacity: 1, transform: "translateY(0) scale(1)" }
        ],
        {
          delay: index * 28,
          duration: 260,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "backwards"
        }
      );
    });

    const selectedTarget = modelSelectionElement(host);
    const selectedIndex = Math.max(0, choices.findIndex((choice) => choice === selectedTarget || choice.contains(selectedTarget)));
    host.querySelector(":scope > .selection-slider")?.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      {
        delay: selectedIndex * 28,
        duration: 220,
        easing: "ease-out",
        fill: "backwards"
      }
    );
  }

  function renderModels(selectionFrom = null, reveal = false) {
    const host = document.getElementById("model-picker");
    const noteEl = document.getElementById("model-note");
    const metaEl = document.getElementById("model-meta");
    const searchWrap = document.getElementById("model-search");
    const catalog = state.catalogs[catalogKey()];

    if (!catalog) {
      host.innerHTML = MODELS_LOADING_MARKUP;
      noteEl.hidden = true;
      metaEl.textContent = "";
      searchWrap.hidden = true;
      renderReasoning();
      return;
    }

    const showCatalogNote = Boolean(catalog.note) && (
      !catalog.models.length || (state.execution === "prime" && state.harness !== "none")
    );
    noteEl.textContent = showCatalogNote ? catalog.note : "";
    noteEl.hidden = !showCatalogNote;
    metaEl.textContent = [catalog.source, catalogTime(catalog)].filter(Boolean).join(" · ");

    const customChip = { id: "__custom__", label: "Custom…", description: "type any model id" };
    const allowCustomModel =
      (state.execution === "local" && state.harness !== "muse-code") ||
      state.harness === "none" || state.harness === "custom";
    const customMarkup = allowCustomModel
      ? `<div class="model-custom-row">${modelChip(customChip)}</div>`
      : "";
    const grouped = catalog.models.some((model) => model.group);
    searchWrap.hidden = !grouped;

    if (grouped) {
      // Prime: recent additions stay visible up front, with provider folders for
      // the full live catalog and a search path for quickly narrowing 100+ ids.
      const groups = new Map();
      catalog.models.forEach((model) => {
        const key = model.group || "other";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(model);
      });
      const selected = catalog.models.find((model) => model.id === state.modelId);
      const query = state.modelQuery.trim().toLowerCase();
      const filteredModels = query
        ? catalog.models.filter((model) => `${model.group || ""}/${model.label} ${model.id}`.toLowerCase().includes(query))
        : [];
      const recentModels = [...catalog.models]
        .filter((model) => model.created_at)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 6);
      const folderMarkup = [...groups.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([group, models]) => {
          const open = state.openFolders.has(group);
          const containsSelected = models.some((model) => model.id === state.modelId);
          const orderedModels = [...models].sort((a, b) => (b.created_at || 0) - (a.created_at || 0) || a.label.localeCompare(b.label));
          return `<div class="model-folder${open ? " is-open" : ""}${containsSelected ? " has-selected" : ""}">
            <button type="button" class="model-folder__head" data-folder="${escapeText(group)}" aria-expanded="${open}">
              <span class="model-folder__glyph">›</span>
              <span class="model-folder__name">${escapeText(group)}</span>
              <span class="model-folder__count">${models.length}</span>
              ${containsSelected && !open ? `<span class="model-folder__selected">${escapeText(selected?.label || "")}</span>` : ""}
            </button>
            <div class="model-folder__reveal" aria-hidden="${!open}"${open ? "" : " inert"}>
              <div class="model-folder__clip">
                <div class="model-grid model-folder__body">${orderedModels.map((model) => modelChip(model)).join("")}</div>
              </div>
            </div>
          </div>`;
        })
        .join("");

      host.innerHTML = query
        ? `<div class="model-search-results">
            <div class="model-section-title">${filteredModels.length} match${filteredModels.length === 1 ? "" : "es"}</div>
            ${filteredModels.length ? `<div class="model-grid">${filteredModels.map((model) => modelChip(model, { showGroup: true })).join("")}</div>` : '<p class="muted model-empty">No models match that search.</p>'}
          </div>
          ${customMarkup}`
        : `${recentModels.length ? `<div class="model-recent"><div class="model-section-title">Recently added</div><div class="model-grid">${recentModels.map((model) => modelChip(model, { showGroup: true })).join("")}</div></div>` : ""}
          <div class="model-folders">${folderMarkup}</div>
          ${customMarkup}`;

      host.querySelectorAll(".model-folder__head").forEach((head) => {
        head.addEventListener("click", () => {
          const folder = head.closest(".model-folder");
          const reveal = folder.querySelector(".model-folder__reveal");
          const selectedLabel = head.querySelector(".model-folder__selected");
          const group = head.dataset.folder;
          const opening = !state.openFolders.has(group);
          const from = selectedRect(host, modelSelectionElement);

          head.setAttribute("aria-expanded", String(opening));

          if (opening) {
            state.openFolders.add(group);
            folder.classList.add("is-open");
            reveal.removeAttribute("inert");
            reveal.setAttribute("aria-hidden", "false");
            selectedLabel?.remove();
          } else {
            state.openFolders.delete(group);
            folder.classList.remove("is-open");
            reveal.setAttribute("inert", "");
            reveal.setAttribute("aria-hidden", "true");
            if (folder.classList.contains("has-selected") && !head.querySelector(".model-folder__selected")) {
              const label = selectedModel()?.label || "";
              head.insertAdjacentHTML("beforeend", `<span class="model-folder__selected">${escapeText(label)}</span>`);
            }
          }

          renderSelectionSlider(host, modelSelectionElement, from, "model");
          requestAnimationFrame(syncAllSelectionSliders);
        });
      });
    } else {
      const models = allowCustomModel ? [...catalog.models, customChip] : catalog.models;
      host.innerHTML = `<div class="model-grid model-grid--primary">${models.map((model) => modelChip(model)).join("")}</div>`;
    }

    host.querySelectorAll(".chip[data-model-id]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const from = selectedRect(host, modelSelectionElement);
        tweenResize(document.querySelector(".model-browser"), () => {
          state.modelId = chip.dataset.modelId;
          if (state.modelId !== "__custom__") state.customModel = "";
          state.reasoning = null;
          state.reasoningChosen = false;
          resetRunOptions();
          renderModels(from);
        });
        syncComposerSteps();
      });
    });

    const customWrap = document.getElementById("model-custom");
    customWrap.hidden = !allowCustomModel || state.modelId !== "__custom__";
    if (state.modelId === "__custom__" && catalog.models.length) {
      document.getElementById("model-custom-input").focus();
    }

    renderReasoning();
    renderPrimeMode();
    renderSelectionSlider(host, modelSelectionElement, selectionFrom, "model");
    if (reveal) requestAnimationFrame(() => revealModelChoices(host));
  }

  function reasoningOptions() {
    const model = selectedModel();
    if (state.execution === "prime") {
      return ["low", "medium", "high"];
    }
    if (state.harness === "claude-code") {
      return model && Array.isArray(model.reasoning_levels) ? model.reasoning_levels : [];
    }
    if (state.harness === "kimi-code") {
      return model && Array.isArray(model.reasoning_levels) && model.reasoning_levels.length
        ? model.reasoning_levels
        : ["high"];
    }
    if (state.harness === "muse-code") {
      return model && Array.isArray(model.reasoning_levels) && model.reasoning_levels.length
        ? model.reasoning_levels
        : ["none", "minimal", "low", "medium", "high", "xhigh", "ultra"];
    }
    return model && Array.isArray(model.reasoning_levels) && model.reasoning_levels.length
      ? model.reasoning_levels
      : ["low", "medium", "high", "xhigh"];
  }

  function renderReasoning(selectionFrom = null) {
    const row = document.getElementById("reasoning-row");
    const host = document.getElementById("reasoning-picker");
    const fastSwitch = document.getElementById("fast-switch");

    if (!state.modelId || !state.harness) {
      row.hidden = true;
      return;
    }

    const levels = reasoningOptions();
    const choices = state.execution === "prime" || (state.harness === "claude-code" && levels.length === 0)
      ? [{ id: "", label: "off" }, ...levels.map((level) => ({ id: level, label: level }))]
      : levels.map((level) => ({ id: level, label: level }));
    if (state.reasoning !== null && !choices.some((choice) => choice.id === state.reasoning)) {
      state.reasoning = null;
      state.reasoningChosen = false;
    }

    row.hidden = false;
    host.innerHTML = choices
      .map(
        (level) => `<button type="button" class="chip chip--small${state.reasoning === level.id ? " is-selected" : ""}"
            data-reasoning="${escapeText(level.id)}">${escapeText(level.label)}</button>`
      )
      .join("");
    host.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const from = selectedRect(host, ".chip.is-selected");
        state.reasoning = chip.dataset.reasoning;
        state.reasoningChosen = true;
        renderReasoning(from);
        syncComposerSteps();
      });
    });

    fastSwitch.hidden = state.execution !== "local" || state.harness !== "codex" || (Boolean(selectedModel()) && !selectedModel().fast);
    renderSelectionSlider(host, ".chip.is-selected", selectionFrom, "reasoning");
  }

  // ---- world + level pickers ------------------------------------------------

  function worldMosaic(world) {
    const urls = (world.preview_urls || []).slice(0, 4);
    if (!urls.length) {
      return '<span class="world-tile__nosignal">▦</span>';
    }
    return urls.map((url) => `<img src="${escapeText(url)}" alt="" loading="lazy">`).join("");
  }

  function renderWorlds(selectionFrom = null, syncSteps = true) {
    const host = document.getElementById("world-picker");
    host.innerHTML = data.worlds
      .map(
        (world) => `<button type="button" class="world-tile${state.worldId === world.id ? " is-selected" : ""}"
            data-world-id="${escapeText(world.id)}" role="radio" aria-checked="${state.worldId === world.id}">
          <span class="world-tile__screen">${worldMosaic(world)}</span>
          <span class="world-tile__name">${escapeText(world.title)}</span>
          <span class="world-tile__meta">${world.world_width}×${world.world_height} · ${world.level_count} level${world.level_count === 1 ? "" : "s"}</span>
        </button>`
      )
      .join("");

    host.querySelectorAll(".world-tile").forEach((tile) => {
      tile.addEventListener("click", () => {
        const from = selectedRect(host, ".world-tile.is-selected");
        const levelPicker = document.getElementById("level-picker");
        state.worldId = tile.dataset.worldId;
        state.levelId = null;
        renderWorlds(from);
        if (levelPicker.hidden) renderLevelSummary();
        else tweenVisibility(levelPicker, false, 440, renderLevelSummary);
      });
    });
    renderSelectionSlider(host, ".world-tile.is-selected", selectionFrom, "world");
    if (syncSteps) syncComposerSteps();
  }

  function renderLevelSummary() {
    const host = document.getElementById("level-summary");
    const world = currentWorld();

    if (!state.worldId && data.worlds.length) {
      host.innerHTML = '<span class="muted">Choose a world</span>';
      return;
    }

    if (!world) {
      host.innerHTML = '<span class="muted">No worlds available.</span>';
      return;
    }

    const levelId = effectiveLevelId();
    const level = world.levels.find((entry) => entry.id === levelId) || null;
    const isDefault = levelId === world.default_level_id && !state.levelId;
    const picker = document.getElementById("level-picker");

    host.innerHTML = `
      <span class="level-summary__thumb">${
        level?.preview_url
          ? `<img src="${escapeText(level.preview_url)}" alt="">`
          : `<span>${escapeText(levelLabel(levelId))}</span>`
      }</span>
      <span class="level-summary__text">
        <strong>${escapeText(levelLabel(levelId))}</strong>
        <small>${isDefault ? "world default start" : "custom start level"}</small>
      </span>
      <span class="level-summary__actions">
        <button type="button" id="level-change">${picker.hidden ? "Change…" : "Close"}</button>
        ${!isDefault ? '<button type="button" id="level-reset">Use world default</button>' : ""}
      </span>`;

    document.getElementById("level-change").addEventListener("click", () => {
      const opening = picker.hidden;
      if (opening) {
        renderLevelGrid();
        tweenVisibility(picker, true, 480);
        renderLevelSummary();
      } else {
        tweenVisibility(picker, false, 440, renderLevelSummary);
      }
    });
    document.getElementById("level-reset")?.addEventListener("click", () => {
      state.levelId = null;
      if (picker.hidden) {
        renderLevelSummary();
      } else {
        tweenVisibility(picker, false, 440, renderLevelSummary);
      }
    });
  }

  function renderLevelGrid() {
    const picker = document.getElementById("level-picker");
    const world = currentWorld();

    if (!world) return;

    const axis = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const selectedId = effectiveLevelId();
    picker.innerHTML = `<p class="muted picker-note">Pick where the agent starts. The outlined room is the world's default start from its metadata.</p>
      <div class="level-grid" style="grid-template-columns: repeat(${world.world_width}, minmax(0, 1fr))">
        ${world.levels
          .map((level) => {
            const column = axis.indexOf(level.column) + 1;
            const row = axis.indexOf(level.row) + 1;
            const isDefault = level.id === world.default_level_id;
            const isSelected = level.id === selectedId;
            return `<button type="button" class="level-cell${isSelected ? " is-selected" : ""}${isDefault ? " is-default" : ""}"
                style="grid-column: ${column}; grid-row: ${row}"
                data-level-id="${escapeText(level.id)}" title="${escapeText(levelLabel(level.id))}${isDefault ? " (default)" : ""}">
              ${level.preview_url ? `<img src="${escapeText(level.preview_url)}" alt="" loading="lazy">` : `<span>${escapeText(levelLabel(level.id))}</span>`}
            </button>`;
          })
          .join("")}
      </div>`;

    picker.querySelectorAll(".level-cell").forEach((cell) => {
      cell.addEventListener("click", () => {
        const world = currentWorld();
        state.levelId = cell.dataset.levelId === world.default_level_id ? null : cell.dataset.levelId;
        tweenVisibility(picker, false, 440, renderLevelSummary);
      });
    });
  }

  // ---- run settings ---------------------------------------------------------

  // Vision/ASCII/JSON segmented control. Both the local #mode-picker and the Prime
  // #prime-mode-picker drive the same state.mode, so selecting in one syncs the
  // visual state of both.
  function syncRunSettingCards() {
    const localSettings = document.getElementById("local-settings");
    const primeSettings = document.getElementById("prime-settings");
    const hasObservation = Boolean(state.mode);
    const hasToolUse = Boolean(state.toolUse);
    const hasOrchestration = Boolean(state.orchestration);
    const hasBudget = state.unlimited || moveBudget() > 0;
    const isolatedLocalAgent = state.execution === "local" && Boolean(localProviderId());
    const localBudgetReady = hasObservation && hasToolUse && (isolatedLocalAgent || hasOrchestration);

    const setCardVisibility = (card, show) => {
      if (!card) return;
      card.classList.toggle("is-gated", !show);
      card.toggleAttribute("inert", !show);
      card.setAttribute("aria-hidden", String(!show));
    };

    setCardVisibility(localSettings?.querySelector(".setting-card--tool-use"), hasObservation);
    setCardVisibility(
      localSettings?.querySelector(".setting-card--orchestration"),
      hasObservation && !isolatedLocalAgent && state.toolUse === "offline" && state.harness !== "kimi-code"
    );
    setCardVisibility(localSettings?.querySelector(".setting-card--budget"), localBudgetReady);
    setCardVisibility(localSettings?.querySelector(".setting-card--give-up"), localBudgetReady && hasBudget);
    setCardVisibility(localSettings?.querySelector(".setting-card--auto-quit"), localBudgetReady && hasBudget && state.allowQuit !== null);
    const primeToolsAvailable = primePythonToolsAvailable();
    const primeToolsReady = !primeToolsAvailable || hasToolUse;
    setCardVisibility(
      primeSettings?.querySelector(".setting-card--tool-use"),
      hasObservation && primeToolsAvailable
    );
    setCardVisibility(
      primeSettings?.querySelector(".setting-card--budget"),
      hasObservation && primeToolsReady
    );
    setCardVisibility(
      primeSettings?.querySelector(".setting-card--give-up"),
      hasObservation && primeToolsReady && hasBudget
    );
    setCardVisibility(
      primeSettings?.querySelector(".setting-card--auto-quit"),
      hasObservation && primeToolsReady && hasBudget && state.allowQuit !== null
    );
  }

  function setMode(mode, syncSteps = true) {
    state.mode = mode;
    const showIdentityOptions = mode === "json" || mode === "text";
    document.querySelectorAll(".segmented__option[data-mode]").forEach((option) => {
      const selected = option.dataset.mode === mode;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-pressed", String(selected));
    });
    document.querySelectorAll("#mode-picker, #prime-mode-picker").forEach((picker) => {
      picker.classList.toggle("has-selection", Boolean(mode));
      picker.classList.toggle("is-second", mode === "text");
      picker.classList.toggle("is-third", mode === "json");
    });
    document.querySelectorAll(".json-mode-options").forEach((options) => {
      const card = options.closest(".setting-card--observation");
      tweenResize(card, () => {
        options.hidden = !showIdentityOptions;
        options.querySelectorAll('[data-json-option="omniscient"]').forEach((input) => {
          input.closest(".json-mode-option").hidden = mode !== "json";
        });
        options.querySelectorAll("[data-hide-names-seed-wrap]").forEach((field) => {
          field.hidden = !showIdentityOptions || !state.hideNames;
        });
      }, 440);
    });
    document.querySelectorAll('[data-json-option="omniscient"]').forEach((input) => {
      input.checked = state.omniscient;
    });
    document.querySelectorAll('[data-json-option="hideNames"]').forEach((input) => {
      input.checked = state.hideNames;
    });
    document.querySelectorAll("[data-hide-names-seed]").forEach((input) => {
      if (input.value !== state.hideNamesSeed) input.value = state.hideNamesSeed;
    });
    syncRunSettingCards();
    if (syncSteps) syncComposerSteps();
  }

  document.querySelectorAll(".segmented__option[data-mode]").forEach((option) => {
    option.addEventListener("click", () => {
      if (option.disabled) return;
      setMode(option.dataset.mode);
    });
  });

  document.querySelectorAll("[data-json-option]").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.dataset.jsonOption === "omniscient") state.omniscient = input.checked;
      if (input.dataset.jsonOption === "hideNames") state.hideNames = input.checked;
      setMode(state.mode, false);
    });
  });

  document.querySelectorAll("[data-hide-names-seed]").forEach((input) => {
    input.addEventListener("input", () => {
      state.hideNamesSeed = input.value.slice(0, 128);
      document.querySelectorAll("[data-hide-names-seed]").forEach((peer) => {
        if (peer !== input) peer.value = state.hideNamesSeed;
      });
    });
  });

  // Prime models differ in whether they accept image inputs and the catalog
  // can't tell us directly, so the server infers it (primeModelVision) and tags
  // each model with `vision`. A text-only model locks Vision off. Custom ids
  // are available only when no coding-agent harness is selected.
  function primeModelAcceptsImages() {
    if (state.execution === "local") return true;
    if (state.harness === "custom" && !selectedCustomHarness()?.observation_modes?.includes("vision")) return false;
    if (state.modelId === "__custom__") return true;
    const model = selectedModel();
    return model ? Boolean(model.vision) : true;
  }

  function renderPrimeMode() {
    const picker = document.getElementById("prime-mode-picker");
    if (!picker) return;

    const visionOption = picker.querySelector('.segmented__option[data-mode="vision"]');
    const canVision = primeModelAcceptsImages();

    if (visionOption) {
      visionOption.disabled = !canVision;
      visionOption.classList.toggle("is-disabled", !canVision);
      visionOption.title = canVision ? "" : "This model is text-only — it can't accept image inputs.";
    }

    // An invalidated Vision choice must be selected again instead of silently
    // falling back to Text.
    if (!canVision && state.mode === "vision") state.mode = null;
    setMode(state.mode, false);

    const note = document.getElementById("prime-vision-note");
    if (note) {
      const model = selectedModel();
      note.textContent = canVision
        ? ""
        : state.harness === "custom"
          ? `${selectedCustomHarness()?.label || "This harness"} currently supports only the isolated Text and JSON controls.`
          : `${model ? model.label : "This model"} is text-only — Vision (image inputs) is unavailable.`;
      note.hidden = canVision;
    }
  }

  function syncToolUsePicker() {
    document.querySelectorAll(".segmented__option[data-tool-use]").forEach((option) => {
      const selected = option.dataset.toolUse === state.toolUse;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-pressed", String(selected));
    });
    document.querySelectorAll("#tool-use-picker, #prime-tool-use-picker").forEach((picker) => {
      picker.classList.toggle("has-selection", Boolean(state.toolUse));
      picker.classList.toggle("is-second", state.toolUse === "offline");
    });
    document.querySelectorAll("[data-auto-run-tools-option]").forEach((option) => {
      option.hidden = state.toolUse !== "offline";
    });
    document.querySelectorAll("[data-auto-run-tools]").forEach((input) => {
      input.disabled = state.toolUse !== "offline";
      input.checked = state.toolUse === "offline" && state.autoRunTools;
    });
    const allFramesEnabled = state.toolUse === "offline" && state.autoRunTools;
    document.querySelectorAll("[data-auto-run-all-frames-option]").forEach((option) => {
      option.hidden = !allFramesEnabled;
    });
    document.querySelectorAll("[data-auto-run-all-frames]").forEach((input) => {
      input.disabled = !allFramesEnabled;
      input.checked = allFramesEnabled && state.autoRunAllFrames;
    });
  }

  function setToolUse(value, syncSteps = true) {
    const next = value === "read-only" || value === "offline" ? value : null;
    if (state.toolUse !== next) {
      const isolatedLocalAgent = state.execution === "local" && Boolean(localProviderId());
      state.orchestration = isolatedLocalAgent || next === "read-only" || state.harness === "kimi-code" ? "single" : null;
      state.autoRunTools = next === "offline";
      state.autoRunAllFrames = next === "offline";
    }
    state.toolUse = next;
    syncToolUsePicker();
    syncOrchestrationPicker();
    syncRunSettingCards();
    if (syncSteps) syncComposerSteps();
  }

  function syncOrchestrationPicker() {
    document.querySelectorAll(".segmented__option[data-orchestration]").forEach((option) => {
      const selected = option.dataset.orchestration === state.orchestration;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-pressed", String(selected));
    });
    const picker = document.getElementById("orchestration-picker");
    picker?.classList.toggle("has-selection", Boolean(state.orchestration));
    picker?.classList.toggle("is-second", state.orchestration === "swarm");
  }

  function setOrchestration(value, syncSteps = true) {
    if (!state.toolUse) return;
    state.orchestration = state.toolUse === "read-only" || state.harness === "kimi-code"
      ? "single"
      : value === "single" || value === "swarm" ? value : null;
    syncOrchestrationPicker();
    syncRunSettingCards();
    if (syncSteps) syncComposerSteps();
  }

  function resetRunOptions() {
    ["run-moves", "run-prime-turns"].forEach((id) => {
      const input = document.getElementById(id);
      if (input) input.value = "0";
    });
    setUnlimited(false, false);
    setAllowQuit(null, false);
    state.omniscient = false;
    state.hideNames = true;
    state.hideNamesSeed = "1";
    state.autoQuitThreshold = 10;
    state.autoQuitMode = "rolling";
    state.autoQuitWindow = 100;
    setAutoQuit(null, false);
    setMode(null, false);
    setToolUse(null, false);
    setOrchestration(null, false);
  }

  function setUnlimited(selected, syncSteps = true) {
    state.unlimited = Boolean(selected);
    document.querySelectorAll("[data-budget-unlimited]").forEach((button) => {
      button.classList.toggle("is-selected", state.unlimited);
      button.setAttribute("aria-pressed", String(state.unlimited));
    });
    ["run-moves", "run-prime-turns"].forEach((id) => {
      const input = document.getElementById(id);
      if (input) input.disabled = state.unlimited;
    });
    syncRunSettingCards();
    if (syncSteps) syncComposerSteps();
  }

  function setAllowQuit(value, syncSteps = true) {
    state.allowQuit = typeof value === "boolean" ? value : null;
    document.querySelectorAll("[data-allow-quit]").forEach((option) => {
      const selected = state.allowQuit !== null && option.dataset.allowQuit === String(state.allowQuit);
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-pressed", String(selected));
    });
    document.querySelectorAll(".quit-policy-picker").forEach((picker) => {
      picker.classList.toggle("has-selection", state.allowQuit !== null);
      picker.classList.toggle("is-second", state.allowQuit === false);
    });
    syncRunSettingCards();
    if (syncSteps) syncComposerSteps();
  }

  function normalizedAutoQuitThreshold(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 10;
  }

  function normalizedAutoQuitWindow(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(1, Math.min(10000, Math.round(number))) : 100;
  }

  function syncAutoQuitOptions(animate = true) {
    document.querySelectorAll(".setting-card--auto-quit").forEach((card) => {
      const options = card.querySelector("[data-auto-quit-options]");
      const mutate = () => {
        options.hidden = state.autoQuit !== true;
        options.querySelector("[data-auto-quit-threshold]").value = String(state.autoQuitThreshold);
        options.querySelector("[data-auto-quit-mode]").value = state.autoQuitMode;
        options.querySelector("[data-auto-quit-window]").value = String(state.autoQuitWindow);
        options.querySelector("[data-auto-quit-window-wrap]").hidden = state.autoQuitMode !== "rolling";
      };
      if (animate) tweenResize(card, mutate, 440);
      else mutate();
    });
  }

  function setAutoQuit(value, syncSteps = true) {
    state.autoQuit = typeof value === "boolean" ? value : null;
    document.querySelectorAll("[data-auto-quit]").forEach((option) => {
      const selected = state.autoQuit !== null && option.dataset.autoQuit === String(state.autoQuit);
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-pressed", String(selected));
    });
    document.querySelectorAll(".auto-quit-picker").forEach((picker) => {
      picker.classList.toggle("has-selection", state.autoQuit !== null);
      picker.classList.toggle("is-second", state.autoQuit === false);
    });
    syncAutoQuitOptions();
    if (syncSteps) syncComposerSteps();
  }

  async function refreshEnvironment() {
    const env = await api("/api/agent/environment");
    data.environment = env;
    return env;
  }

  // ---- launch ---------------------------------------------------------------

  function resolvedModelName() {
    if (state.modelId === "__custom__") {
      return (document.getElementById("model-custom-input").value || "").trim();
    }
    return state.modelId || "";
  }

  function resetComposerForNextRun() {
    localAvailabilityRequest += 1;
    primeAvailabilityRequest += 1;
    state.execution = "prime";
    state.harness = null;
    state.modelId = null;
    state.customModel = "";
    state.modelQuery = "";
    state.reasoning = null;
    state.reasoningChosen = false;
    state.worldId = null;
    state.levelId = null;
    state.localAvailability = "idle";

    const modelSearchInput = document.getElementById("model-search-input");
    if (modelSearchInput) modelSearchInput.value = "";
    const customModelInput = document.getElementById("model-custom-input");
    if (customModelInput) customModelInput.value = "";
    const levelPicker = document.getElementById("level-picker");
    if (levelPicker) levelPicker.hidden = true;
    const fastSwitch = document.getElementById("run-codex-fast");
    if (fastSwitch) fastSwitch.checked = false;

    resetRunOptions();
    renderHarnesses();
    renderCustomHarnessPicker();
    renderExecutionPicker();
    renderWorlds(null, false);
    renderLevelSummary();
    renderReasoning();
    syncComposerSteps();
  }

  document.getElementById("launch-run")?.addEventListener("click", async () => {
    if (!runReady()) return;
    if (state.modelId === "__custom__" && !resolvedModelName() && (state.catalogs[catalogKey()]?.models || []).length) {
      setStatus("Type a model id or pick one from the list.", true);
      return;
    }

    const body = state.execution === "prime"
      ? {
          kind: "prime",
          harness: effectiveHarnessId(),
          harness_config: state.harness === "custom" ? { ...state.customHarnessConfig } : {},
          model_name: resolvedModelName(),
          max_turns: moveBudget(),
          unlimited: state.unlimited,
          mode: state.mode,
          vision: state.mode === "vision",
          omniscient: state.mode === "json" && state.omniscient,
          hide_names: state.mode !== "vision" && state.hideNames,
          hide_names_seed: state.mode !== "vision" && state.hideNames ? state.hideNamesSeed.trim() : "",
          reasoning: state.reasoning,
          tools: primePythonToolsAvailable() && state.toolUse === "offline",
          tool_use: primePythonToolsAvailable() ? state.toolUse : "read-only",
          auto_run_tools: primePythonToolsAvailable() && state.toolUse === "offline" && state.autoRunTools,
          auto_run_all_frames: primePythonToolsAvailable() && state.toolUse === "offline" && state.autoRunTools && state.autoRunAllFrames,
          allow_quit: state.allowQuit,
          auto_quit: state.autoQuit,
          auto_quit_threshold: state.autoQuitThreshold,
          auto_quit_mode: state.autoQuitMode,
          auto_quit_window: state.autoQuitWindow,
          video: false
        }
      : {
          kind: "local",
          subscription: true,
          model: localProviderId(),
          game_id: state.worldId,
          level_id: effectiveLevelId(),
          moves: moveBudget(),
          unlimited: state.unlimited,
          allow_quit: state.allowQuit,
          auto_quit: state.autoQuit,
          auto_quit_threshold: state.autoQuitThreshold,
          auto_quit_mode: state.autoQuitMode,
          auto_quit_window: state.autoQuitWindow,
          mode: state.mode,
          omniscient: state.mode === "json" && state.omniscient,
          hide_names: state.mode !== "vision" && state.hideNames,
          hide_names_seed: state.mode !== "vision" && state.hideNames ? state.hideNamesSeed.trim() : "",
          model_name: resolvedModelName(),
          reasoning: state.reasoning,
          codex_fast: state.harness === "codex" && document.getElementById("run-codex-fast").checked,
          container: true,
          video: false,
          tools: state.toolUse === "offline",
          tool_use: state.toolUse,
          auto_run_tools: state.toolUse === "offline" && state.autoRunTools,
          auto_run_all_frames: state.toolUse === "offline" && state.autoRunTools && state.autoRunAllFrames,
          swarm: false
        };

    body.count = 1;
    beginLaunch();
    setStatus("");
    resetComposerForNextRun();

    try {
      if (body.kind === "prime") {
        const environment = await refreshEnvironment();
        if (!environment?.prime || !environment?.uv) {
          setStatus(showPrimeSetup(environment), true);
          return;
        }
      } else {
        const environment = await refreshEnvironment();
        const launchedHarness = ({ codex: "codex", claude: "claude-code", kimi: "kimi-code", muse: "muse-code" })[body.model];
        const availability = localRunAvailability(launchedHarness, environment);
        if (!availability.available) {
          showLocalSetup(launchedHarness, availability);
          setStatus(`Isolated local ${HARNESSES.find((entry) => entry.id === launchedHarness)?.name || "agent"} setup is incomplete.`, true);
          return;
        }
      }
      const payload = await api(data.apiUrl, { method: "POST", body: JSON.stringify(body) });
      setStatus(payload.message);
      runsView.page = 1;
      void refreshRuns();
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      finishLaunch();
    }
  });

  // ---- runs list (unchanged behavior) ---------------------------------------

  const runsView = { page: 1, pageSize: 5, provider: "", model: "", status: "", starred: false, query: "", sort: "newest" };
  const runProgressCache = new Map();

  function formatRunDuration(value) {
    const seconds = Math.max(0, Math.round(Number(value || 0) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  }

  function runProgressLabel(run) {
    if (run.status === "waiting") return "Waiting";
    const eta = Number(run.progress?.eta_ms);
    if (run.status === "finished") return run.complete ? "Complete" : "Ended";
    if (run.status === "paused") return "Paused";
    if (run.status === "pausing") return "Pausing…";
    if (run.status === "stopping") return "Stopping…";
    if (run.status === "stopped") return "Stopped";
    if (run.status === "failed") return "Failed";
    if (Number.isFinite(eta) && Number(run.progress?.current) > 0) {
      return eta <= 0 ? "Finishing…" : `~${formatRunDuration(eta)} left`;
    }
    return "Estimating…";
  }

  function runStatusClass(status) {
    if (status === "running" || status === "pausing" || status === "stopping") return "agent-chip--running";
    if (status === "waiting" || status === "paused") return "agent-chip--paused";
    if (status === "finished") return "agent-chip--done";
    return "agent-chip--failed";
  }

  function runModeLabel(value) {
    const mode = String(value || "text").trim().toLowerCase();
    if (mode === "vision") return "Vision";
    if (mode === "json") return "JSON";
    return "ASCII";
  }

  function runCard(run) {
    const statusLabel =
      run.status === "pausing"
        ? "pausing after next action"
        : run.status === "paused"
        ? run.pause_reason === "quota"
          ? "paused · out of funds"
          : "paused"
        : run.status === "finished"
          ? run.complete
            ? "complete"
            : "ended"
          : run.status;
    const modelName = run.model_name || run.model;
    const harnessName = run.harness_label || HARNESSES.find((harness) => harness.id === (run.harness || "none"))?.name || run.harness;
    const providerName = run.provider === "prime"
      ? (run.harness || "none") === "none"
        ? "Prime Intellect"
        : `${harnessName || "Prime Intellect"} via Prime`
      : ({ codex: "Codex", claude: "Claude Code", kimi: "Kimi Code", muse: "Muse Code" }[run.provider || run.model] || run.model);
    const reasoningEffort = String(run.reasoning || (run.provider === "prime" ? "off" : "auto")).toLowerCase();
    const showStartRoom = Boolean(run.level_id) && !run.start_room_is_default;
    const createdAt = escapeText(run.created_at ? new Date(run.created_at).toLocaleString() : "");
    const continuation = run.continued
      ? ` · continued ×${run.continued}`
      : run.continue_of
        ? " · continued"
        : "";
    const progress = run.progress || {};
    const progressCurrent = Number(progress.current) || 0;
    const progressTotal = run.unlimited ? null : Math.max(1, Number(progress.total) || Number(run.moves) || 1);
    const progressTarget = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    const progressFrom = runProgressCache.get(run.id) ?? 0;
    const showProgress = !run.unlimited && progressTarget < 100;
    if (!showProgress) runProgressCache.delete(run.id);

    const actions = [
      `<button class="button--ghost run-favorite" type="button" data-action="favorite" title="${run.favorited ? "Remove from" : "Add to"} MazeJam AI leaderboard" aria-label="${run.favorited ? "Remove run from" : "Add run to"} MazeJam AI leaderboard favorites" aria-pressed="${run.favorited ? "true" : "false"}">${FAVORITE_ICON}</button>`,
      run.pausable ? '<button class="button" type="button" data-action="pause">Pause</button>' : "",
      run.resumable ? '<button class="button--primary" type="button" data-action="resume">Resume</button>' : "",
      run.continuable ? '<button class="button" type="button" data-action="continue">Continue</button>' : "",
      run.provider === "prime" && (run.status === "running" || run.status === "stopping")
        ? '<button class="button--coral" type="button" data-action="stop">Cancel</button>'
        : "",
      `<button class="button--ghost run-trash" type="button" data-action="delete" title="Delete run" aria-label="Delete run">${TRASH_ICON}</button>`
    ]
      .filter(Boolean)
      .join("");

    return `<article class="agent-run-card" data-run-id="${escapeText(run.id)}" data-provider="${escapeText(run.model)}">
      <a class="run-card__open" href="${escapeText(run.url)}" aria-label="Open ${escapeText(modelName)} run"></a>
      <div class="run-card__status">
        <span class="agent-chip ${runStatusClass(run.status)}">${escapeText(statusLabel)}</span>
        <span>${createdAt}${continuation}</span>
      </div>
      <div class="run-card__main">
        <div class="run-card__identity">
          <span class="run-card__provider">${escapeText(providerName)}</span>
          <h3 title="${escapeText(modelName)}">${escapeText(modelName)}</h3>
          <div class="run-card__details">
            <span class="run-card__world">${escapeText(run.game_title || run.game_id)}</span>
            ${showStartRoom ? `<span class="run-card__badge">Start ${escapeText(levelLabel(run.level_id))}</span>` : ""}
            <span class="run-card__badge run-card__badge--reasoning">${escapeText(reasoningEffort)} reasoning</span>
            <span class="run-card__badge run-card__badge--mode">${escapeText(runModeLabel(run.mode))}</span>
            ${Number(run.explorer_instances) > 0
              ? `<span class="run-card__badge">${escapeText(run.auxiliary_actions || 0)} auxiliary · ${escapeText(run.explorer_instances)} instance${Number(run.explorer_instances) === 1 ? "" : "s"}</span>`
              : ""}
          </div>
        </div>
        <div class="run-card__metrics" aria-label="Run results">
          <div class="run-metric run-metric--moves">
            <span class="run-metric__icon" aria-hidden="true">${RUN_METRIC_ICONS.moves}</span>
            <span class="run-metric__copy"><strong>${escapeText(run.turns)}<em>/ ${run.unlimited ? "∞" : escapeText(run.moves)}</em></strong><small>Moves</small></span>
          </div>
          <div class="run-metric run-metric--gems">
            <span class="run-metric__icon" aria-hidden="true">${RUN_METRIC_ICONS.gems}</span>
            <span class="run-metric__copy"><strong>${escapeText(run.gem_count ?? 0)}<em>/ ${escapeText(run.gem_total ?? "—")}</em></strong><small>Gems</small></span>
          </div>
          <div class="run-metric run-metric--rooms">
            <span class="run-metric__icon" aria-hidden="true">${RUN_METRIC_ICONS.rooms}</span>
            <span class="run-metric__copy"><strong>${escapeText(run.room_count ?? 0)}<em>/ ${escapeText(run.room_total ?? "—")}</em></strong><small>Rooms</small></span>
          </div>
        </div>
        <div class="run-card__actions">${actions}</div>
      </div>
      ${showProgress ? `<div class="run-card__progress">
        <div class="run-card__progress-copy"><span>${escapeText(progressCurrent)} / ${escapeText(progressTotal)} moves</span><strong>${escapeText(runProgressLabel(run))}</strong></div>
        <div class="run-card__progress-track" role="progressbar" aria-label="Run progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progressTarget)}">
          <span class="run-card__progress-fill${run.status === "paused" ? " is-paused" : ""}" data-progress-target="${progressTarget}" style="width:${progressFrom}%"></span>
        </div>
      </div>` : ""}
    </article>`;
  }

  function runsQuery() {
    const params = new URLSearchParams({
      page: String(runsView.page),
      page_size: String(runsView.pageSize),
      sort: runsView.sort
    });
    if (runsView.provider) params.set("provider", runsView.provider);
    if (runsView.model) params.set("model", runsView.model);
    if (runsView.status) params.set("status", runsView.status);
    if (runsView.starred) params.set("starred", "1");
    if (runsView.query) params.set("q", runsView.query);
    return params.toString();
  }

  function syncFilterSelect(id, values, current, allLabel, format = (value) => value) {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = [`<option value="">${allLabel}</option>`]
      .concat(values.map((value) => `<option value="${escapeText(value)}">${escapeText(format(value))}</option>`))
      .join("");
    select.value = values.includes(current) ? current : "";
  }

  const ACTION_LABELS = { pause: "Paused", resume: "Resumed", stop: "Stopping" };

  function wireRunActions() {
    runsEl.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        const runId = event.target.closest("[data-run-id]").dataset.runId;
        const action = button.dataset.action;
        try {
          if (action === "delete") {
            if (!window.confirm("Delete this run and its artifacts? This can't be undone.")) return;
            await api(`${data.apiUrl}/${encodeURIComponent(runId)}`, { method: "DELETE" });
            setStatus(`Deleted ${runId}.`);
          } else if (action === "favorite") {
            const favorite = button.getAttribute("aria-pressed") !== "true";
            button.disabled = true;
            const payload = await api(`${data.apiUrl}/${encodeURIComponent(runId)}/favorite`, {
              method: "POST",
              body: JSON.stringify({ favorite })
            });
            setStatus(payload.message);
          } else if (action === "continue") {
            const answer = window.prompt("How many more moves should it run?", "10");
            if (answer === null) return;
            const requestedMoves = Number(answer);
            const moves = Number.isFinite(requestedMoves) && requestedMoves > 0
              ? Math.floor(requestedMoves)
              : 0;
            if (!moves) {
              setStatus("Enter a positive number of moves.", true);
              return;
            }
            const payload = await api(`${data.apiUrl}/${encodeURIComponent(runId)}/continue`, {
              method: "POST",
              body: JSON.stringify({ moves })
            });
            setStatus(payload.message);
            window.location.href = payload.run.url;
            return;
          } else {
            const payload = await api(`${data.apiUrl}/${encodeURIComponent(runId)}/${action}`, { method: "POST" });
            // A quota resume relaunches as a new continuation run — go watch it.
            if (action === "resume" && payload.run && payload.run.id !== runId) {
              setStatus(`Resuming as run ${payload.run.id}…`);
              window.location.href = payload.run.url;
              return;
            }
            setStatus(`${ACTION_LABELS[action] || action} ${runId}.`);
          }
          refreshRuns();
        } catch (error) {
          setStatus(error.message, true);
        }
      });
    });
  }

  let refreshTimer = null;

  async function refreshRuns() {
    try {
      const payload = await api(`${data.apiUrl}?${runsQuery()}`);
      const runs = payload.runs || [];
      const total = payload.total ?? runs.length;

      document.getElementById("runs-total").textContent = total ? `${total} run${total === 1 ? "" : "s"}` : "";
      syncFilterSelect(
        "runs-provider",
        payload.providers || [],
        runsView.provider,
        "All",
        (value) => RUN_COMPANY_NAMES[value] || value
      );
      syncFilterSelect("runs-model", payload.models || [], runsView.model, "All");
      syncFilterSelect(
        "runs-status",
        payload.statuses || [],
        runsView.status,
        "All",
        (value) => RUN_STATUS_LABELS[value] || value
      );

      tweenResize(runsEl, () => {
        runsEl.innerHTML = runs.length
          ? runs.map(runCard).join("")
          : total
            ? '<div class="empty-state"><span class="glyph">▤</span><p>No matching runs.</p></div>'
            : '<div class="empty-state"><span class="glyph">▶</span><p>No runs yet.</p></div>';
        wireRunActions();
      });
      requestAnimationFrame(() => {
        runsEl.querySelectorAll(".run-card__progress-fill").forEach((bar) => {
          const card = bar.closest("[data-run-id]");
          const target = Number(bar.dataset.progressTarget) || 0;
          bar.style.width = `${target}%`;
          if (card) runProgressCache.set(card.dataset.runId, target);
        });
      });

      const pages = payload.pages || 1;
      const pager = document.getElementById("runs-pager");
      pager.hidden = pages <= 1;
      document.getElementById("runs-page-label").textContent = `Page ${payload.page || 1} of ${pages}`;
      document.getElementById("runs-prev").disabled = (payload.page || 1) <= 1;
      document.getElementById("runs-next").disabled = (payload.page || 1) >= pages;

      const active = payload.active || runs.some((run) => ["waiting", "running", "pausing", "stopping"].includes(run.status));
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refreshRuns, active ? 3000 : 15000);
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  function wireRunsToolbar() {
    const search = document.getElementById("runs-search");
    let searchTimer = null;
    search?.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        runsView.query = search.value.trim();
        runsView.page = 1;
        refreshRuns();
      }, 300);
    });

    const onFilter = (id, key, cast) =>
      document.getElementById(id)?.addEventListener("change", (event) => {
        runsView[key] = cast ? cast(event.target.value) : event.target.value;
        runsView.page = 1;
        refreshRuns();
      });
    onFilter("runs-provider", "provider");
    onFilter("runs-model", "model");
    onFilter("runs-status", "status");
    onFilter("runs-starred", "starred", (value) => value === "1");
    onFilter("runs-sort", "sort");
    onFilter("runs-page-size", "pageSize", (value) => Number(value) || 5);

    document.getElementById("runs-prev")?.addEventListener("click", () => {
      if (runsView.page > 1) {
        runsView.page -= 1;
        refreshRuns();
      }
    });
    document.getElementById("runs-next")?.addEventListener("click", () => {
      runsView.page += 1;
      refreshRuns();
    });
  }

  function wireModelCatalog() {
    document.getElementById("refresh-models")?.addEventListener("click", () => {
      if (state.harness) {
        loadModels(state.harness, { fresh: true });
        if (state.execution === "prime") void checkPrimeAvailability();
      }
    });

    document.getElementById("model-search-input")?.addEventListener("input", (event) => {
      const host = document.getElementById("model-picker");
      const from = selectedRect(host, modelSelectionElement);
      tweenResize(document.querySelector(".model-browser"), () => {
        state.modelQuery = event.target.value;
        renderModels(from);
      });
    });
  }

  function wireCustomHarnessPicker() {
    document.getElementById("custom-harness-id")?.addEventListener("change", (event) => {
      selectCustomHarness(event.target.value);
    });
    document.getElementById("custom-harness-config-fields")?.addEventListener("input", (event) => {
      const input = event.target.closest("[data-harness-config]");
      if (!input) return;
      const name = input.dataset.harnessConfig;
      let value = input.value;
      let valid = true;
      try {
        if (input.dataset.configType === "boolean") value = input.value === "true";
        else if (input.dataset.configType === "integer") value = input.value === "" ? null : Math.trunc(Number(input.value));
        else if (input.dataset.configType === "number") value = input.value === "" ? null : Number(input.value);
        else if (input.dataset.configType === "json") value = JSON.parse(input.value);
        else value = input.value.trim();
        if (["integer", "number"].includes(input.dataset.configType) && value !== null && !Number.isFinite(value)) valid = false;
      } catch (_error) {
        valid = false;
      }
      input.setAttribute("aria-invalid", String(!valid));
      if (valid) state.customHarnessConfig[name] = value;
      syncComposerSteps();
    });
  }

  function wireConfigurationSummary() {
    ["run-moves", "run-prime-turns"].forEach((id) => {
      document.getElementById(id)?.addEventListener("input", () => {
        syncRunSettingCards();
        syncComposerSteps();
      });
    });
    document.querySelectorAll("[data-budget-unlimited]").forEach((button) => {
      button.addEventListener("click", () => setUnlimited(!state.unlimited));
    });
    document.querySelectorAll("[data-allow-quit]").forEach((option) => {
      option.addEventListener("click", () => setAllowQuit(option.dataset.allowQuit === "true"));
    });
    document.querySelectorAll("[data-auto-quit]").forEach((option) => {
      option.addEventListener("click", () => setAutoQuit(option.dataset.autoQuit === "true"));
    });
    document.querySelectorAll("[data-auto-quit-threshold]").forEach((input) => {
      input.addEventListener("input", () => {
        if (input.value === "") return;
        state.autoQuitThreshold = normalizedAutoQuitThreshold(input.value);
        document.querySelectorAll("[data-auto-quit-threshold]").forEach((peer) => {
          if (peer !== input) peer.value = String(state.autoQuitThreshold);
        });
      });
      input.addEventListener("change", () => {
        state.autoQuitThreshold = normalizedAutoQuitThreshold(input.value);
        syncAutoQuitOptions(false);
      });
    });
    document.querySelectorAll("[data-auto-quit-mode]").forEach((select) => {
      select.addEventListener("change", () => {
        state.autoQuitMode = select.value === "rolling" ? "rolling" : "cumulative";
        syncAutoQuitOptions();
      });
    });
    document.querySelectorAll("[data-auto-quit-window]").forEach((input) => {
      input.addEventListener("input", () => {
        if (input.value === "") return;
        state.autoQuitWindow = normalizedAutoQuitWindow(input.value);
        document.querySelectorAll("[data-auto-quit-window]").forEach((peer) => {
          if (peer !== input) peer.value = String(state.autoQuitWindow);
        });
      });
      input.addEventListener("change", () => {
        state.autoQuitWindow = normalizedAutoQuitWindow(input.value);
        syncAutoQuitOptions(false);
      });
    });
  }

  function wireSelectionResize() {
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(syncAllSelectionSliders);
    };

    window.addEventListener("resize", schedule, { passive: true });
    if (!("ResizeObserver" in window)) return;

    const observer = new ResizeObserver(schedule);
    ["provider-picker", "model-picker", "world-picker", "reasoning-picker"].forEach((id) => {
      const host = document.getElementById(id);
      if (host) observer.observe(host);
    });
  }

  // ---- boot -----------------------------------------------------------------

  renderExecutionPicker();
  renderHarnesses();
  renderCustomHarnessPicker();
  void loadCustomHarnesses();
  renderWorlds();
  renderLevelSummary();
  document.querySelectorAll("[data-execution]").forEach((option) => {
    option.addEventListener("click", () => {
      if (option.disabled) {
        setStatus(option.title || "This harness is not compatible with the isolated Prime game controls.", true);
        return;
      }
      if (option.dataset.execution === "local") selectLocalRun();
      else {
        setExecution("prime");
        void checkPrimeAvailability();
      }
    });
  });
  document.querySelectorAll(".segmented__option[data-tool-use]").forEach((option) => {
    option.addEventListener("click", () => setToolUse(option.dataset.toolUse));
  });
  document.querySelectorAll("[data-auto-run-tools]").forEach((input) => {
    input.addEventListener("change", (event) => {
      state.autoRunTools = state.toolUse === "offline" && event.currentTarget.checked;
      state.autoRunAllFrames = state.autoRunTools;
      syncToolUsePicker();
    });
  });
  document.querySelectorAll("[data-auto-run-all-frames]").forEach((input) => {
    input.addEventListener("change", (event) => {
      state.autoRunAllFrames = state.toolUse === "offline" && state.autoRunTools && event.currentTarget.checked;
      syncToolUsePicker();
    });
  });
  document.querySelectorAll(".segmented__option[data-orchestration]").forEach((option) => {
    option.addEventListener("click", () => setOrchestration(option.dataset.orchestration));
  });
  syncRunSettingCards();
  wireModelCatalog();
  wireCustomHarnessPicker();
  wireConfigurationSummary();
  wireSelectionResize();
  wireRunsToolbar();
  refreshRuns();
  document.getElementById("provider-setup-close")?.addEventListener("click", closeOrRetryProviderSetup);
  document.getElementById("provider-setup-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "provider-setup-modal") closeProviderSetup();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.getElementById("provider-setup-modal")?.classList.contains("open")) {
      closeProviderSetup();
    }
  });
  syncComposerSteps(false);
})();
