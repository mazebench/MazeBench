const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pages = fs.readFileSync(path.join(root, "server", "pages.js"), "utf8");
const runScript = fs.readFileSync(path.join(root, "public", "agent-run.js"), "utf8");
const agentScript = fs.readFileSync(path.join(root, "public", "agent.js"), "utf8");
const siteTheme = fs.readFileSync(path.join(root, "public", "local-site.css"), "utf8");

assert.match(pages, /id="run-meta" class="run-config" aria-label="Launch configuration"/);
assert.match(runScript, /function runConfiguration\(run\)/);
assert.match(runScript, /run\.launch_params && typeof run\.launch_params === "object"/);
assert.doesNotMatch(pages, /setting-card--access/);
assert.doesNotMatch(pages, /data-isolation=/);
assert.match(pages, /<span>Tool use<\/span>/);
assert.doesNotMatch(pages, /Tool-use \(Not guaranteed\)/);
assert.match(pages, /id="run-prime-turns"[^>]+min="0"[^>]+value="0"/);
assert.doesNotMatch(pages, /id="run-prime-turns"[^>]+max=/);
assert.match(pages, /id="run-prime-unlimited"[^>]+data-budget-unlimited/);
assert.equal((pages.match(/data-budget-unlimited/g) || []).length, 2);
assert.match(agentScript, /max_turns: moveBudget\(\),\s*unlimited: state\.unlimited/);
assert.match(agentScript, /state\.unlimited \|\| moveBudget\(\) > 0/);
assert.match(runScript, /const unlimited = configuredFlag\(params, "unlimited", run\.unlimited\)/);
assert.doesNotMatch(agentScript, /Math\.min\(500/);
assert.doesNotMatch(runScript, /Math\.min\(500/);
assert.doesNotMatch(agentScript, /state\.isolation/);
assert.doesNotMatch(agentScript, /syncIsolationPicker|setIsolation/);
assert.doesNotMatch(agentScript, /container: false/);
assert.match(agentScript, /kind: "prime",\s*harness: effectiveHarnessId\(\)/);
assert.match(agentScript, /kind: "local",\s*subscription: true,\s*model: localProviderId\(\)/);
assert.match(agentScript, /container: true,\s*video: false,\s*tools: state\.toolUse === "offline",\s*tool_use: state\.toolUse/);
assert.doesNotMatch(runScript, /run-config__heading/);
assert.doesNotMatch(runScript, /"Eval complete"/);
assert.doesNotMatch(runScript, /"Eval ended"/);
assert.doesNotMatch(runScript, /replay video above/);
assert.doesNotMatch(runScript, /see the runner log for rewards and scores/);
assert.doesNotMatch(pages, /Generate a compact MP4 replay of this run\./);
assert.doesNotMatch(siteTheme, /\.run-config__heading/);
for (const label of [
  "Provider",
  "Model",
  "World",
  "Start room",
  "Budget",
  "Observation",
  "Reasoning",
  "Allow model to give up",
  "Auto-Quit",
  "Auto-Quit rule",
  "Fast mode",
  "Identity seed",
  "Isolation",
  "Tool use",
  "Auto-run tools",
  "Sequence frames",
  "Orchestration"
]) {
  assert.match(runScript, new RegExp(`\\["${label}"`), `missing ${label} launch parameter`);
}
assert.match(pages, /data-mode="json"/);
assert.match(pages, /data-json-option="omniscient"/);
assert.equal(
  (pages.match(/Omniscient mode reveals all blocks, even ones obstructed from view/g) || []).length,
  2
);
for (const pickerId of ["mode-picker", "prime-mode-picker"]) {
  const pickerStart = pages.indexOf(`id="${pickerId}"`);
  const pickerEnd = pages.indexOf("</div>", pickerStart);
  const picker = pages.slice(pickerStart, pickerEnd);
  assert.ok(picker.indexOf('data-mode="vision"') < picker.indexOf('data-mode="text"'));
  assert.ok(picker.indexOf('data-mode="text"') < picker.indexOf('data-mode="json"'));
}
assert.match(pages, /class="json-mode-info"[^>]+aria-label="About Omniscient mode"/);
assert.match(agentScript, /picker\.classList\.toggle\("is-second", mode === "text"\)/);
assert.match(agentScript, /picker\.classList\.toggle\("is-third", mode === "json"\)/);
assert.match(agentScript, /tweenResize\(card, \(\) => \{\s*options\.hidden = !showIdentityOptions;/);
assert.match(agentScript, /tweenResize\(card,[\s\S]*?field\.hidden = !showIdentityOptions \|\| !state\.hideNames;[\s\S]*?\}, 440\);/);
assert.match(siteTheme, /\.json-mode-info__tooltip \{/);
assert.match(pages, /data-json-option="hideNames"/);
assert.equal((pages.match(/data-hide-names-seed/g) || []).length >= 4, true);
assert.equal((pages.match(/data-hide-names-seed[^>]+value="1"/g) || []).length, 2);
assert.doesNotMatch(pages, /Same seed, same mapping/);
assert.match(agentScript, /hideNamesSeed: "1"/);
assert.match(agentScript, /hideNames: true/);
assert.match(agentScript, /state\.hideNames = true/);
assert.match(agentScript, /omniscient: state\.mode === "json" && state\.omniscient/);
assert.match(agentScript, /hide_names: state\.mode !== "vision" && state\.hideNames/);
assert.match(agentScript, /hide_names_seed: state\.mode !== "vision" && state\.hideNames/);
assert.match(runScript, /configuredValue\(params, "hide_names_seed", run\.hide_names_seed/);
assert.match(runScript, /function showJsonObservation\(observation, turn = null, displayPalette = null\)/);
assert.match(pages, /ASCII view — the model does not see this/);
assert.match(pages, /JSON observation — this is what the model sees/);
assert.match(pages, /id="run-json"/);
assert.match(runScript, /let jsonEl = document\.getElementById\("run-json"\)/);
assert.match(runScript, /liveGrid\?\.classList\.add\("is-json-mode"\)/);
assert.match(runScript, /function refreshLatestJsonObservation\(\)/);
assert.match(siteTheme, /\.run-live__grid\.is-json-mode \{[\s\S]*?repeat\(3/);
assert.match(runScript, /\["JSON visibility"/);
assert.match(runScript, /"Object names"/);
assert.match(runScript, /"Glyph identities"/);
assert.match(pages, /No Tools/);
assert.match(pages, /title="Isolated Python scratchpad; no host files or network"/);
assert.match(pages, /id="prime-tool-use-picker"/);
assert.match(pages, /no host files, subprocesses, or network/);
assert.match(pages, /<span class="segmented__icon">PY<\/span><span>Tools<\/span>/);
assert.doesNotMatch(pages, /Offline Tools/);
assert.equal((pages.match(/setting-card--give-up/g) || []).length, 2);
assert.equal((pages.match(/<span>Allow model to give up<\/span>/g) || []).length, 2);
assert.match(agentScript, /const hasBudget = state\.unlimited \|\| moveBudget\(\) > 0/);
assert.match(agentScript, /setting-card--give-up"\), localBudgetReady && hasBudget/);
assert.match(agentScript, /setting-card--give-up"\),\s*hasObservation && primeToolsReady && hasBudget/);
assert.match(agentScript, /function primePythonToolsAvailable\(\)/);
assert.match(agentScript, /\["codex", "claude_code"\]\.includes\(effectiveHarnessId\(\)\)/);
assert.match(agentScript, /tools: primePythonToolsAvailable\(\) && state\.toolUse === "offline"/);
assert.match(agentScript, /tool_use: primePythonToolsAvailable\(\) \? state\.toolUse : "read-only"/);
assert.match(agentScript, /tools: state\.toolUse === "offline"/);
assert.match(agentScript, /auto_run_tools: state\.toolUse === "offline" && state\.autoRunTools/);
assert.match(agentScript, /\["run-moves", "run-prime-turns"\][\s\S]*?addEventListener\("input", \(\) => \{\s*syncRunSettingCards\(\);\s*syncComposerSteps\(\);/);
assert.equal((pages.match(/setting-card--auto-quit/g) || []).length, 2);
assert.equal((pages.match(/<span>Auto-Quit<\/span>/g) || []).length, 2);
assert.equal((pages.match(/data-auto-quit-threshold/g) || []).length, 2);
assert.equal((pages.match(/data-auto-quit-window/g) || []).length >= 4, true);
assert.match(pages, /value="10"[^>]+data-auto-quit-threshold/);
assert.match(pages, /value="100"[^>]+data-auto-quit-window/);
assert.equal((pages.match(/<option value="rolling" selected>Rolling window<\/option>/g) || []).length, 2);
assert.doesNotMatch(pages, /data-auto-quit-window-wrap hidden/);
assert.doesNotMatch(pages, /quit-policy-control__label/);
assert.match(agentScript, /autoQuitThreshold: 10/);
assert.match(agentScript, /autoQuitMode: "rolling"/);
assert.match(agentScript, /autoQuitWindow: 100/);
assert.match(agentScript, /auto_quit: state\.autoQuit/);
assert.match(agentScript, /state\.autoQuit !== null/);
assert.match(runScript, /No Tools/);
assert.match(runScript, /run\.auto_quit_mode \|\| "rolling"/);
assert.match(runScript, /run\.model === "codex" && Object\.prototype\.hasOwnProperty\.call\(params, "codex_fast"\)/);
assert.doesNotMatch(runScript, /`run \$\{run\.id\}`/);
assert.match(runScript, /class="run-config__item\$\{active \? " is-active" : ""\}"/);
assert.match(siteTheme, /\.run-config__list \{/);
assert.match(siteTheme, /\.run-config__item\.is-active \{/);
assert.match(siteTheme, /\.auto-quit-options \{/);

console.log("agent-run-config-source: OK — saved launch choices render as structured configuration pills.");
