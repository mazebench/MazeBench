const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  agenticConversationTurns,
  parseArgs,
  retryablePrimeProviderError,
  writeMoveArtifacts
} = require("../scripts/maze-prime-run");
const {
  createAgentRunService,
  filterPrimeCatalogForHarness,
  normalizePrimeHarnessConfig,
  primeReasoningLevels,
  primeHarnessModelCompatible,
  primeSandboxIdsFromText,
  publicPrimeHarnesses
} = require("../server/agent-runs");
const { findPrimeResultsFile } = require("../server/token-usage");

const root = path.join(__dirname, "..");
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-prime-harness-"));
const statePath = path.join(runDir, "session.json");

try {
  const agentSource = fs.readFileSync(path.join(root, "public", "agent.js"), "utf8");
  const runSource = fs.readFileSync(path.join(root, "scripts", "maze-prime-run.js"), "utf8");
  const liveSource = fs.readFileSync(path.join(root, "scripts", "maze-prime-live-eval.py"), "utf8");
  const tasksetSource = fs.readFileSync(
    path.join(root, "environments", "mazebench_agent", "mazebench_agent", "__init__.py"),
    "utf8"
  );
  const toolsTasksetSource = fs.readFileSync(
    path.join(root, "environments", "mazebench", "mazebench_tools", "__init__.py"),
    "utf8"
  );
  const kimiHarnessSource = fs.readFileSync(
    path.join(root, "environments", "mazebench", "mazebench_harnesses", "kimi.py"),
    "utf8"
  );
  const codexHarnessSource = fs.readFileSync(
    path.join(root, "environments", "mazebench", "mazebench_harnesses", "codex.py"),
    "utf8"
  );
  const cliHarnessSource = fs.readFileSync(
    path.join(root, "environments", "mazebench", "mazebench_harnesses", "cli.py"),
    "utf8"
  );
  const commonHarnessSource = fs.readFileSync(
    path.join(root, "environments", "mazebench", "mazebench_harnesses", "common.py"),
    "utf8"
  );
  const mazeTasksetSource = fs.readFileSync(
    path.join(root, "environments", "mazebench", "mazebench", "mazebench.py"),
    "utf8"
  );
  const project = fs.readFileSync(path.join(root, "environments", "mazebench", "pyproject.toml"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "server", "app.js"), "utf8");
  const runsSource = fs.readFileSync(path.join(root, "server", "agent-runs.js"), "utf8");
  const pagesSource = fs.readFileSync(path.join(root, "server", "pages.js"), "utf8");
  const siteTheme = fs.readFileSync(path.join(root, "public", "local-site.css"), "utf8");
  const harnessCatalog = JSON.parse(fs.readFileSync(
    path.join(root, "environments", "mazebench", "prime-harness-catalog.json"),
    "utf8"
  ));

  assert.doesNotMatch(agentSource, /id: "none",\s*name: "Prime Intellect"/);
  assert.match(agentSource, /id: "custom",\s*name: "Prime Intellect",\s*logo: '<img src="\/logos\/prime\.png"/);
  assert.doesNotMatch(agentSource, /<circle cx=\"24\" cy=\"24\" r=\"17\.5\"><\/circle><path d=\"M12\.5 35\.5 35\.5 12\.5\"><\/path>/);
  assert.match(agentSource, /id: "codex",\s*name: "Codex"/);
  assert.match(agentSource, /id: "claude-code",\s*name: "Claude Code"/);
  assert.match(agentSource, /id: "kimi-code",\s*name: "Kimi Code",\s*logo: '<img src="\/logos\/kimi\.svg"/);
  assert.match(agentSource, /harness: effectiveHarnessId\(\)/);
  assert.match(agentSource, /harness_config: state\.harness === "custom"/);
  assert.match(agentSource, /kind: "local",\s*subscription: true/);
  assert.match(agentSource, /query\.set\("harness", resolvedHarnessId\)/);
  assert.match(agentSource, /const allowCustomModel = state\.execution === "local" \|\| state\.harness === "none" \|\| state\.harness === "custom"/);
  assert.match(agentSource, /selectedCustomHarness\(\)\?\.observation_modes\?\.includes\("vision"\)/);
  assert.match(agentSource, /function setExecution\(value\)/);
  assert.match(agentSource, /blockedPrimeAgentHarness/);
  assert.doesNotMatch(agentSource, /Codex and Claude Code via Prime remain disabled/);
  assert.match(agentSource, /Codex MCP/);
  assert.match(agentSource, /isolated CLI gateway/);
  assert.match(agentSource, /state\.execution = harnessId === "none" \|\| harnessId === "custom" \? "prime" : "local"/);
  assert.match(agentSource, /async function loadCustomHarnesses\(\)/);
  assert.match(agentSource, /api\(data\.harnessesApiUrl \|\| "\/api\/agent\/harnesses"\)/);
  assert.match(agentSource, /entry\.launchable \? "" : " disabled"/);
  assert.match(agentSource, /async function checkLocalAvailability\(harnessId = state\.harness\)/);
  assert.match(agentSource, /state\.localAvailability = "checking";[\s\S]*?await refreshEnvironment\(\)/);
  assert.match(agentSource, /state\.localAvailability = "active"/);
  assert.match(agentSource, /if \(localProviderId\(harnessId\)\) checkLocalAvailability\(harnessId\)/);
  assert.match(agentSource, /if \(option\.dataset\.execution === "local"\) selectLocalRun\(\)/);
  assert.doesNotMatch(agentSource, /provider-card__avail/);
  assert.doesNotMatch(agentSource, /refreshEnvironment\(\)\.catch/);
  assert.ok(
    pagesSource.indexOf('id="provider-picker"') < pagesSource.indexOf('id="harness-execution"'),
    "the contextual Run through picker must render below the harness choices"
  );
  assert.match(pagesSource, /data-execution="prime"[\s\S]*?src="\/logos\/prime\.png"/);
  assert.match(pagesSource, /data-execution="local"[\s\S]*?<strong>Local Run<\/strong>/);
  assert.match(pagesSource, /id="local-run-status"[^>]*hidden/);
  assert.match(siteTheme, /\.execution-option__status\.is-active/);
  assert.match(siteTheme, /\.execution-option__spinner[\s\S]*?animation: executionStatusSpin/);
  assert.match(agentSource, /renderSelectionSlider\(host, "\.provider-card\.is-selected", selectionFrom, "provider"\)/);
  assert.match(siteTheme, /\.selection-slider--provider \{\s*border-radius: 12px;/);
  assert.match(agentSource, /tweenVisibility\(wrapper, supportsLocal, 420\)/);
  assert.match(agentSource, /const collapsedFrame = \{[\s\S]*?marginBottom: "0px",[\s\S]*?marginTop: "0px"/);
  assert.match(appSource, /allowLegacyLocalLaunch: true/);
  assert.match(appSource, /codex.*\["login", "status"\]/s);
  assert.match(appSource, /claude.*\["auth", "status", "--json"\]/s);
  assert.match(appSource, /kimi.*\["provider", "list", "--json"\]/s);
  assert.match(appSource, /logged in using chatgpt/i);
  assert.match(runsSource, /Local Codex, Claude Code, and Kimi Code launches are disabled/);
  assert.match(runsSource, /prime-harness-catalog\.json/);
  assert.match(runsSource, /catalog_fingerprint/);
  assert.match(runsSource, /do not hide Codex, Claude Code, or future harnesses/);
  assert.match(runsSource, /localLaunchEnvironment/);
  assert.match(runsSource, /delete environment\[key\]/);
  assert.doesNotMatch(runsSource, /const shouldWait = model === "claude"/);

  assert.match(runSource, /"--harness\.runtime\.type",\s*"prime"/);
  assert.match(runSource, /PRIME_HARNESSES = new Map\(HARNESS_CATALOG\.harnesses/);
  assert.match(runSource, /definition\.adapter === "cli_gateway"/);
  assert.match(runSource, /definition\.runtime_harness_id/);
  assert.match(runSource, /TEXT_RUNTIME_IMAGE = "node:24-bookworm-slim"/);
  assert.match(runSource, /VISION_RUNTIME_IMAGE = "mcr\.microsoft\.com\/playwright:v1\.60\.0-noble"/);
  assert.match(runSource, /opts\.vision \? VISION_RUNTIME_IMAGE : TEXT_RUNTIME_IMAGE/);
  assert.match(runSource, /const taskset = agentic \? "mazebench-tools" : "mazebench"/);
  assert.match(runSource, /"--taskset\.tools\.colocated",\s*"False"/);
  assert.doesNotMatch(runSource, /--taskset\.tools\.shared/);
  assert.doesNotMatch(runSource, /Math\.min\(500/);
  assert.doesNotMatch(runsSource, /Math\.min\(500/);
  assert.match(liveSource, /MAZEBENCH_EVENT_V1/);
  assert.match(liveSource, /_patch_prime_codex_reasoning_summary/);
  assert.match(liveSource, /PRIME_HARNESS == "codex"/);
  assert.match(liveSource, /reasoning\.get\("summary"\) == "auto"/);
  assert.match(runSource, /MAZEBENCH_PRIME_HARNESS: opts\.harness/);
  assert.match(runSource, /runEvalWithProviderRetry/);
  assert.match(runSource, /eval-output-provider-failure/);
  assert.match(runsSource, /actions\.length === 0 \|\| fileHasContent\(primeResumeCheckpointPath\(runId\)\)/);
  assert.match(runsSource, /if \(readActions\(runId\)\.length > 0\)/);
  assert.match(liveSource, /_patch_prime_usage_schema/);
  assert.match(liveSource, /cache_write_tokens/);
  assert.match(liveSource, /"timestamp": action\.get\("timestamp"\) or _utc_timestamp\(\)/);
  assert.match(mazeTasksetSource, /"timestamp": timestamp or _utc_timestamp\(\)/);
  assert.match(mazeTasksetSource, /"timestamp": action\.get\("timestamp"\)/);

  assert.match(project, /verifiers @ git\+https:\/\/github\.com\/PrimeIntellect-ai\/verifiers\.git@653bb14003b87e39588bde308fa8626d1038ce15/);
  assert.match(tasksetSource, /__all__ = \["MazeBenchAgentTaskset"\]/);
  assert.match(tasksetSource, /raise RuntimeError\(UNSAFE_HARNESS_MESSAGE\)/);
  assert.doesNotMatch(tasksetSource, /class \w*Harness/);
  assert.match(tasksetSource, /extra_instructions: str = ""/);
  assert.match(tasksetSource, /`view_image` in\s+Codex; `Read` in Claude Code/);
  assert.match(tasksetSource, /playwright-core@\{PLAYWRIGHT_CORE_VERSION\}/);
  assert.match(tasksetSource, /max_actions: int \| None = 20/);
  assert.match(tasksetSource, /"unlimited" if unlimited else str\(data\.max_actions\)/);
  assert.match(runSource, /\["--taskset\.max-actions", "None", "--max-turns", "None"\]/);
  assert.doesNotMatch(tasksetSource, /node \{HELPER\} scorecard/);
  assert.match(tasksetSource, /Scoring is evaluator-only/);
  assert.match(toolsTasksetSource, /class MazeBenchToolTraceState\(vf\.State\)/);
  assert.match(toolsTasksetSource, /repo_root": ""/);
  assert.match(toolsTasksetSource, /resume_checkpoint_path": ""/);
  assert.match(toolsTasksetSource, /"observation": ""/);
  assert.match(toolsTasksetSource, /"colocated": False/);
  assert.match(toolsTasksetSource, /class MazeBenchToolTask\(/);
  assert.match(toolsTasksetSource, /user = None/);
  assert.match(toolsTasksetSource, /trace\.state = trusted_state/);
  assert.match(toolsTasksetSource, /__all__ = \["MazeBenchToolTaskset"\]/);
  assert.match(toolsTasksetSource, /KIMI_CODE_IDENTICAL_ACTION_INTERVAL = 5/);
  assert.match(toolsTasksetSource, /A different action resets the repetition count/);
  assert.match(toolsTasksetSource, /next_required_tool.*game_observe/s);
  assert.match(toolsTasksetSource, /Call game_observe before another game_action/);
  assert.match(toolsTasksetSource, /async def action_sequence/);
  assert.match(toolsTasksetSource, /include_intermediate_observations/);
  assert.match(toolsTasksetSource, /there is no sequence-length cap/);
  assert.match(toolsTasksetSource, /`json_observation` field/);
  assert.match(codexHarnessSource, /"start", "observe", "action", "action_sequence"/);
  assert.match(codexHarnessSource, /enabled_tools=\["start","observe","action","action_sequence"\]/);
  assert.match(codexHarnessSource, /model_catalog_json=/);
  assert.match(codexHarnessSource, /"supports_search_tool": False/);
  assert.match(codexHarnessSource, /GAME_ONLY_DISABLED_FEATURES[\s\S]*?"tool_suggest"/);
  assert.doesNotMatch(codexHarnessSource, /allowed_tools = \["tool_search"/);
  assert.match(cliHarnessSource, /delegate\.launch\(ctx, trace, runtime, endpoint, secret, \{\}\)/);
  assert.match(commonHarnessSource, /observations\/current\.json/);
  assert.match(commonHarnessSource, /observations\/history\.jsonl/);
  assert.match(commonHarnessSource, /value\?\.result && typeof value\.result === "object"/);
  assert.match(commonHarnessSource, /it does not include the CLI output's `result` envelope/);
  assert.match(commonHarnessSource, /action-sequence route\.json --all-frames/);
  assert.match(commonHarnessSource, /there is no route-length cap/);
  assert.match(kimiHarnessSource, /KIMI_MODEL_CAPABILITIES/);
  assert.match(kimiHarnessSource, /capabilities\.append\("image_in"\)/);

  const kimiCatalogEntry = harnessCatalog.harnesses.find((harness) => harness.id === "kimi_code");
  assert.equal(kimiCatalogEntry.adapter, "kimi_mcp");
  assert.equal(kimiCatalogEntry.runtime_harness_id, "mazebench_kimi_harness");
  assert.equal(kimiCatalogEntry.observation_modes.includes("vision"), true);
  const piCatalogEntry = harnessCatalog.harnesses.find((harness) => harness.id === "pi");
  assert.equal(piCatalogEntry.adapter, "cli_gateway");
  assert.equal(piCatalogEntry.runtime_harness_id, "mazebench_cli_harness");
  assert.equal(piCatalogEntry.upstream_id, "pi");
  assert.equal(
    harnessCatalog.harnesses.find((harness) => harness.id === "rlm").observation_modes.includes("vision"),
    false
  );

  const kimiObserveProbe = spawnSync(
    "uv",
    [
      "run",
      "--project",
      path.join(root, "environments", "mazebench"),
      "python",
      "-c",
      `import asyncio
import os
from types import SimpleNamespace

import mazebench_tools as module


prompt_task = SimpleNamespace(
    allow_quit=False,
    game_won_gem_count=75,
    max_actions=None,
    observation_mode="ascii",
    target_gems=0,
)
os.environ["MAZEBENCH_PRIME_HARNESS"] = "kimi-code"
prompt = module._tool_prompt(prompt_task)
assert "Kimi Code compatibility rule" in prompt
assert "Collect 100 unique gems to win." in prompt
assert "Collect 0 gems" not in prompt
assert "never provide a final" in prompt
assert "completion_allowed: false" in prompt
os.environ["MAZEBENCH_PRIME_HARNESS"] = "codex"
assert "Kimi Code compatibility rule" not in module._tool_prompt(prompt_task)
json_prompt_task = SimpleNamespace(**{**prompt_task.__dict__, "observation_mode": "json"})
json_prompt = module._tool_prompt(json_prompt_task)
assert "game_action_sequence" in json_prompt
assert "there is no sequence-length cap" in json_prompt
assert "include_intermediate_observations: true" in json_prompt
assert "json_observation" in json_prompt
assert "final_observation" in json_prompt

public_observation = module._public_observation(
    {
        "level": "test board",
        "current_room": "level_HxI",
        "current_view": "top-diagonal",
        "yaw": 3,
        "gem_count": 1,
        "moved": False,
        "board_state_hash": "model-secret-state-hash",
        "board_state_hash_version": 1,
        "collected_gems": ["gem-secret"],
        "collected_this_action": ["gem-secret"],
        "push_count": 4,
        "pushes_this_action": 1,
        "novel_push_count": 3,
        "novel_pushes_this_action": 1,
        "player_dead": True,
        "game_won": True,
        "game_lost": False,
        "solved": True,
        "allowed_commands": ["undo", "reset", "go to level X Y"],
        "visited_levels": ["level_HxH", "level_HxI"],
    },
    "ascii",
)
assert "moved" not in public_observation
assert "board_state_hash" not in public_observation
assert "board_state_hash_version" not in public_observation
assert "collected_gems" not in public_observation
assert "collected_this_action" not in public_observation
assert "push_count" not in public_observation
assert "pushes_this_action" not in public_observation
assert "novel_push_count" not in public_observation
assert "novel_pushes_this_action" not in public_observation
assert "solved" not in public_observation
assert public_observation["observation_mode"] == "ascii"
assert public_observation["current_room"] == "level_HxI"
assert public_observation["current_view"] == "top-diagonal"
assert public_observation["yaw"] == 3
assert public_observation["gem_count"] == 1
assert public_observation["game_won"] is False
assert public_observation["player_dead"] is True
assert public_observation["allowed_commands"] == ["undo", "reset", "go to level X Y"]
assert public_observation["visited_levels"] == ["level_HxH", "level_HxI"]

vision_result = module._vision_tool_result(
    {
        "observation": module._public_observation(
            {
                "current_room": "level_HxI",
                "current_view": "perspective",
                "visited_levels": ["level_HxI"],
            },
            "vision",
        ),
        "ended": False,
    },
    "data:image/png;base64,iVBORw0KGgo=",
)
assert vision_result.structuredContent["observation"]["frame_image"] == "attached:image/png"
assert vision_result.content[0].type == "text"
assert vision_result.content[1].type == "image"
assert vision_result.content[1].mimeType == "image/png"


async def probe():
    toolset = module.MazeBenchToolset(config=module.MazeBenchToolsetConfig())
    toolset.task = SimpleNamespace(
        allow_quit=True,
        auto_quit=False,
        auto_quit_mode="cumulative",
        auto_quit_threshold=0.0,
        auto_quit_window=100,
        game_won_gem_count=999,
        game_id="maze",
        level_id="level_HxI",
        max_actions=None,
        observation_mode="json",
        target_gems=0,
    )
    toolset._lock = asyncio.Lock()
    toolset._closed = False
    toolset._actions = []
    toolset._identical_action_interval = module.KIMI_CODE_IDENTICAL_ACTION_INTERVAL
    toolset._last_action_key = None
    toolset._identical_action_streak = 0
    toolset._auto_quit = {}
    toolset._scorecard = {}
    toolset._status_error = ""
    toolset._initial_hash = "state-0"
    toolset._status = {
        "action_count": 0,
        "board_state_hash": "state-0",
        "game_lost": False,
        "game_won": False,
        "quit": False,
        "gem_count": 0,
        "json_observation": {
            "omniscient": True,
            "objects": {"player": [[1, 2, 0]], "gem": [[2, 2, 0]]},
        },
    }
    toolset._initial = dict(toolset._status)
    toolset._session = SimpleNamespace(request=lambda *args, **kwargs: None)
    toolset._write_snapshot = lambda: None
    toolset._status = {**toolset._status, "game_won": True, "solved": True, "gem_count": 2}
    assert toolset._terminal() is False
    assert toolset._state_payload()["game_won"] is False
    assert toolset._state_payload()["maze_replay"]["game_won_gem_count"] == 100
    toolset._status = {**toolset._status, "gem_count": 100}
    assert toolset._terminal() is True
    assert toolset._state_payload()["game_won"] is True
    toolset._status = {**toolset._status, "game_won": False, "solved": False, "gem_count": 0}

    async def fake_run_blocking(_func, command, **_kwargs):
        if command == "observe":
            return dict(toolset._status)
        next_action = len(toolset._actions) + 1
        return {
            **toolset._status,
            "action_count": next_action,
            "board_state_hash": f"state-{next_action}",
            "moved": True,
        }

    module.run_blocking = fake_run_blocking

    for _index in range(4):
        before_change = await toolset.action("up")
        assert before_change["completion_allowed"] is False
        assert before_change["next_required_tool"] == "game_action"
        assert "observe_required" not in before_change

    changed = await toolset.action("right")
    assert changed["actions_used"] == 5
    assert changed["next_required_tool"] == "game_action"
    assert "observe_required" not in changed

    for index in range(4):
        fifth = await toolset.action("  RIGHT  ")
        if index < 3:
            assert fifth["next_required_tool"] == "game_action"
            assert "observe_required" not in fifth
    assert fifth["actions_used"] == 9
    assert fifth["observe_required"] is True
    assert fifth["next_required_tool"] == "game_observe"

    blocked = await toolset.action("left")
    assert blocked["actions_used"] == 9
    assert blocked["error"] == "Call game_observe before another game_action."

    observed = await toolset.observe()
    assert "observe_required" not in observed
    assert observed["completion_allowed"] is False
    assert observed["next_required_tool"] == "game_action"
    resumed = await toolset.action("left")
    assert resumed["actions_used"] == 10
    assert "observe_required" not in resumed

    route = [
        "rotate camera left" if index % 2 == 0 else "rotate camera right"
        for index in range(40)
    ]
    sequence = await toolset.action_sequence(
        route,
        include_intermediate_observations=True,
    )
    assert sequence["requested_count"] == 40
    assert sequence["attempted_count"] == 40
    assert sequence["completed_count"] == 40
    assert sequence["stopped_early"] is False
    assert sequence["stop_reason"] == "completed"
    assert sequence["actions_used"] == 50
    assert len(sequence["steps"]) == 40
    assert len(sequence["intermediate_observations"]) == 39
    assert sequence["intermediate_observations"][0]["observation"]["observation_mode"] == "json"
    assert sequence["final_observation"]["json_observation"]["omniscient"] is True
    assert "observation" not in sequence
    assert sequence["next_required_tool"] == "game_action"
    assert toolset._identical_action_streak == 0


asyncio.run(probe())
print("kimi observe break ready")`
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  assert.equal(kimiObserveProbe.status, 0, kimiObserveProbe.stderr || kimiObserveProbe.stdout);
  assert.match(kimiObserveProbe.stdout, /kimi observe break ready/);

  assert.equal(primeHarnessModelCompatible("openai/gpt-5-codex", "codex"), true);
  assert.equal(primeHarnessModelCompatible("openai/gpt-4.1", "codex"), true);
  assert.equal(primeHarnessModelCompatible("openai/gpt-oss-120b", "codex"), true);
  assert.equal(primeHarnessModelCompatible("anthropic/claude-sonnet-5", "codex"), true);
  assert.equal(primeHarnessModelCompatible("anthropic/claude-sonnet-5", "claude-code"), true);
  assert.equal(primeHarnessModelCompatible("openai/gpt-5.4", "claude-code"), true);
  assert.equal(primeHarnessModelCompatible("google/gemini-3.5-flash", "default"), true);
  assert.equal(primeHarnessModelCompatible("anthropic/claude-sonnet-5", "bash"), true);
  assert.equal(primeHarnessModelCompatible("openai/gpt-5.4", "kimi_code"), true);
  assert.equal(primeHarnessModelCompatible("moonshotai/kimi-k3", "codex"), true);
  assert.equal(
    retryablePrimeProviderError(
      'ProviderError: upstream 404: {"error":{"message":"Requested resource not found."}}'
    ),
    true
  );
  assert.equal(retryablePrimeProviderError("ProviderError: upstream 429: rate limited"), true);
  assert.equal(retryablePrimeProviderError("ProviderError: upstream 503: unavailable"), true);
  assert.equal(retryablePrimeProviderError("ProviderError: upstream 400: unsupported parameter"), false);
  assert.equal(retryablePrimeProviderError("ordinary harness error"), false);
  const publicHarnesses = publicPrimeHarnesses();
  assert.deepEqual(
    publicHarnesses.filter((harness) => harness.launchable).map((harness) => harness.id),
    ["bash", "claude_code", "codex", "kimi_code", "mini_swe_agent", "null", "pi", "rlm", "terminus_2"]
  );
  assert.equal(publicHarnesses.every((harness) => harness.verifiers_revision === "653bb14003b87e39588bde308fa8626d1038ce15"), true);
  assert.equal(publicHarnesses.every((harness) => harness.catalog_fingerprint === harnessCatalog.catalog_fingerprint), true);
  assert.deepEqual(normalizePrimeHarnessConfig({}, "kimi_code"), { version: "0.27.0" });
  assert.deepEqual(normalizePrimeHarnessConfig({ version: "0.15.0" }, "kimi-code"), { version: "0.15.0" });
  assert.throws(() => normalizePrimeHarnessConfig({ package: "untrusted" }, "bash"), /Unsupported Bash configuration/);
  assert.deepEqual(
    primeSandboxIdsFromText([
      "PrimeRuntime: sandbox azquf017rdi59jhwqoiu43z0 up",
      "pod sandbox-job-azquf017rdi59jhwqoiu43z0",
      "PrimeRuntime: sandbox bbcdef2345678901 up"
    ].join("\n")),
    ["azquf017rdi59jhwqoiu43z0", "bbcdef2345678901"]
  );
  const sampleCatalog = {
    models: [
      { id: "openai/gpt-5-codex" },
      { id: "anthropic/claude-sonnet-5" },
      { id: "google/gemini-3.5-flash" }
    ]
  };
  assert.deepEqual(
    filterPrimeCatalogForHarness(sampleCatalog, "codex").models.map((model) => model.id),
    ["openai/gpt-5-codex", "anthropic/claude-sonnet-5", "google/gemini-3.5-flash"]
  );
  assert.deepEqual(
    filterPrimeCatalogForHarness(sampleCatalog, "claude-code").models.map((model) => model.id),
    ["openai/gpt-5-codex", "anthropic/claude-sonnet-5", "google/gemini-3.5-flash"]
  );
  assert.deepEqual(
    filterPrimeCatalogForHarness(sampleCatalog, "default").models.map((model) => model.id),
    ["openai/gpt-5-codex", "anthropic/claude-sonnet-5", "google/gemini-3.5-flash"]
  );
  for (const modelId of [
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "openai/gpt-5.6-sol",
    "anthropic/claude-fable-5",
    "google/gemini-3.5-flash",
    "Qwen/Qwen3.5-0.8B"
  ]) {
    assert.deepEqual(primeReasoningLevels(modelId), ["low", "medium", "high"]);
  }
  assert.match(agentSource, /state\.execution === "prime"[\s\S]{0,180}\["low", "medium", "high"\]/);

  const primeOnlyService = createAgentRunService({
    agentEnvironment: () => ({}),
    allowLegacyLocalLaunch: false,
    ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
    getGame: () => null,
    buildWorlds: { countWorldGems: () => 0 },
    loadJson: () => null,
    rootDir: runDir,
    worldMaps: {}
  });
  assert.throws(
    () => primeOnlyService.launchRuns({ kind: "local", model: "codex" }),
    /Local Codex, Claude Code, and Kimi Code launches are disabled/
  );

  const inactiveLocalService = createAgentRunService({
    agentEnvironment: () => ({ codex: false, claude: false }),
    allowLegacyLocalLaunch: true,
    ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
    getGame: () => null,
    buildWorlds: { countWorldGems: () => 0 },
    loadJson: () => null,
    rootDir: path.join(runDir, "inactive-local"),
    worldMaps: {}
  });
  assert.throws(
    () => inactiveLocalService.launchRuns({ kind: "local", model: "codex", subscription: true }),
    /Codex needs an active local account/
  );

  const parsedCodex = parseArgs([
    "--env-dir", path.join(root, "environments", "mazebench"),
    "--out", runDir,
    "--harness", "codex"
  ]);
  assert.equal(parsedCodex.harness, "codex");
  assert.deepEqual(parsedCodex.harnessConfig, { version: "0.144.5", multi_agent: false });
  const parsedClaude = parseArgs([
    "--env-dir", path.join(root, "environments", "mazebench"),
    "--out", runDir,
    "--harness", "claude"
  ]);
  assert.equal(parsedClaude.harness, "claude_code");
  assert.deepEqual(parsedClaude.harnessConfig, { version: "2.1.214" });
  assert.throws(
    () => parseArgs(["--env-dir", root, "--out", runDir, "--harness", "unknown"]),
    /Unknown Prime harness/
  );
  assert.throws(
    () => parseArgs([
      "--env-dir", root,
      "--out", runDir,
      "--harness", "codex",
      "--vision"
    ]),
    /supports only text and JSON/
  );
  const parsedDefault = parseArgs([
    "--env-dir", path.join(root, "environments", "mazebench"),
    "--out", runDir,
    "--harness", "default",
    "--model", "google/gemini-3.5-flash"
  ]);
  assert.equal(parsedDefault.harness, "null");
  assert.deepEqual(parsedDefault.harnessConfig, {});
  const parsedKimi = parseArgs([
    "--env-dir", path.join(root, "environments", "mazebench"),
    "--out", runDir,
    "--harness", "kimi-code",
    "--harness-config-json", JSON.stringify({ version: "0.15.0" })
  ]);
  assert.equal(parsedKimi.harness, "kimi_code");
  assert.deepEqual(parsedKimi.harnessConfig, { version: "0.15.0" });
  assert.throws(
    () => parseArgs([
      "--env-dir", path.join(root, "environments", "mazebench"),
      "--out", runDir,
      "--harness", "bash",
      "--harness-config-json", JSON.stringify({ package: "anything" })
    ]),
    /Unsupported bash harness configuration/
  );
  assert.throws(
    () => parseArgs([
      "--env-dir", path.join(root, "environments", "mazebench"),
      "--out", runDir,
      "--harness", "null",
      "--vision"
    ]),
    /supports only text and JSON/
  );

  const start = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts", "maze-play.js"),
      "start",
      "--repo-root", root,
      "--state", statePath,
      "--level", "level_HxI",
      "--game-won-gem-count", "69",
      "--max-actions", "1"
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  assert.equal(start.status, 0, start.stderr);
  const startStatus = JSON.parse(start.stdout);
  assert.equal(Object.prototype.hasOwnProperty.call(startStatus, "player"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(startStatus, "scorecard"), false);
  assert.match(startStatus.level, /P|p/);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).gameWonGemCount, 100);

  const action = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "maze-play.js"), "action", "--state", statePath, "up"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  assert.equal(action.status, 0, action.stderr);
  const marker = action.stdout.match(/MAZEBENCH_EVENT_V1:([A-Za-z0-9_-]+)/);
  assert(marker, "provider-neutral helper must emit a live telemetry marker");
  const event = JSON.parse(Buffer.from(marker[1], "base64url").toString("utf8"));
  assert.equal(event.turn, 1);
  assert.equal(event.command_text, "up");
  assert.equal(event.valid, true);
  assert.equal(Object.prototype.hasOwnProperty.call(event.status, "player"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(event.status, "scorecard"), false);
  assert.equal(fs.existsSync(path.join(runDir, "current-render-state.json")), false);
  const traced = agenticConversationTurns({
    nodes: [
      { message: { role: "assistant", content: "", reasoning_content: "reasoned move" } },
      { message: { role: "tool", content: `status\n${marker[0]}`, tool_call_id: "shell-1" } }
    ]
  });
  assert.equal(traced.length, 1);
  assert.equal(traced[0].reasoning, "reasoned move");
  assert.equal(traced[0].action, "up");

  const artifactTrace = path.join(runDir, "artifact-traces.jsonl");
  fs.writeFileSync(
    artifactTrace,
    `${JSON.stringify({
      nodes: [
        { message: { role: "assistant", content: "", reasoning_content: "reasoned move" } },
        { message: { role: "tool", content: `status\n${marker[0]}`, tool_call_id: "shell-1" } }
      ],
      info: {
        maze_actions: [{
          turn: 1,
          command: "up",
          valid: true,
          error: null,
          status: { current_room: "level_HxI", gem_count: 0, moved: true }
        }]
      }
    })}\n`
  );
  assert.equal(writeMoveArtifacts(artifactTrace, runDir), 1);
  const actionArtifact = JSON.parse(fs.readFileSync(path.join(runDir, "actions.jsonl"), "utf8"));
  assert.equal(actionArtifact.command_text, "up");
  assert.equal(actionArtifact.status.level, event.status.level);
  const reasoningArtifact = JSON.parse(fs.readFileSync(path.join(runDir, "reasoning.json"), "utf8"));
  assert.equal(reasoningArtifact[0].reasoning, "reasoned move");

  const overBudget = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "maze-play.js"), "action", "--state", statePath, "right"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  assert.notEqual(overBudget.status, 0);
  assert.match(overBudget.stderr, /action budget exhausted \(1\/1\)/i);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).actions.length, 1);

  const traceDir = path.join(runDir, "eval-output", "current-v1");
  fs.mkdirSync(traceDir, { recursive: true });
  const tracesPath = path.join(traceDir, "traces.jsonl");
  fs.writeFileSync(tracesPath, `${JSON.stringify({ nodes: [], info: {} })}\n`);
  assert.equal(findPrimeResultsFile(runDir), tracesPath);
} finally {
  fs.rmSync(runDir, { recursive: true, force: true });
}

console.log("prime harness tests passed");
