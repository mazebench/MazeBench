const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pages = fs.readFileSync(path.join(root, "server", "pages.js"), "utf8");
const agentScript = fs.readFileSync(path.join(root, "public", "agent.js"), "utf8");
const siteTheme = fs.readFileSync(path.join(root, "public", "local-site.css"), "utf8");

assert.match(
  pages,
  /id="agent-launch-status"[^>]+role="status"[^>]+aria-live="polite"[^>]+hidden>[\s\S]*?Launching run/
);
assert.match(siteTheme, /\.agent-launch-status \{[\s\S]*?border-radius: 999px/);
assert.match(siteTheme, /\.agent-launch-status \{[\s\S]*?grid-column: 2;/);
assert.match(siteTheme, /\.agent-launch-status \{[\s\S]*?position: fixed;[\s\S]*?top: calc\(var\(--topbar-height/);
assert.match(siteTheme, /\.agent-launch-status__spinner \{[\s\S]*?animation: loading-spin/);
assert.match(agentScript, /function resetComposerForNextRun\(\)/);
assert.match(pages, /id="auto-run-tools-option"[\s\S]*id="run-auto-run-tools"[\s\S]*Auto-run tools/);
assert.match(pages, /id="prime-auto-run-tools-option"[\s\S]*id="run-prime-auto-run-tools"[\s\S]*Auto-run tools/);
assert.match(pages, /Lets solvers submit full action sequences, observe the final frame, and inspect intermediate frames\./);
assert.match(pages, /id="auto-run-all-frames-option"[\s\S]*id="run-auto-run-all-frames"[\s\S]*Include every frame/);
assert.match(agentScript, /autoRunTools: false/);
assert.match(agentScript, /autoRunAllFrames: false/);
assert.match(agentScript, /querySelectorAll\("\[data-auto-run-tools-option\]"\)/);
assert.match(agentScript, /state\.autoRunTools = next === "offline"/);
assert.match(agentScript, /state\.autoRunAllFrames = next === "offline"/);
assert.match(agentScript, /auto_run_tools: state\.toolUse === "offline" && state\.autoRunTools/);
assert.match(agentScript, /auto_run_tools: primePythonToolsAvailable\(\) && state\.toolUse === "offline" && state\.autoRunTools/);
assert.match(agentScript, /auto_run_all_frames: state\.toolUse === "offline" && state\.autoRunTools && state\.autoRunAllFrames/);
assert.match(agentScript, /tools: primePythonToolsAvailable\(\) && state\.toolUse === "offline"/);
assert.match(agentScript, /kind: "local",\s*subscription: true,\s*model: localProviderId\(\)/);
assert.match(agentScript, /tool_use: state\.toolUse,\s*auto_run_tools: state\.toolUse === "offline" && state\.autoRunTools,\s*auto_run_all_frames: state\.toolUse === "offline" && state\.autoRunTools && state\.autoRunAllFrames,\s*swarm: false/);
assert.match(siteTheme, /\.tool-use-options\[hidden\][\s\S]*display: none/);
assert.match(siteTheme, /\.tool-use-suboption\[hidden\][\s\S]*display: none/);
assert.match(agentScript, /state\.harness && state\.harness !== "none" && state\.execution === "prime"/);
assert.match(agentScript, /beginLaunch\(\);\s*setStatus\(""\);\s*resetComposerForNextRun\(\);\s*\n\s*try \{/);
assert.match(agentScript, /runsView\.page = 1;\s*void refreshRuns\(\);/);
assert.match(agentScript, /finally \{\s*finishLaunch\(\);\s*\}/);
const launchHandler = agentScript.slice(
  agentScript.indexOf('document.getElementById("launch-run")'),
  agentScript.indexOf("// ---- runs list")
);
assert.doesNotMatch(launchHandler, /window\.location\.href/);

console.log("agent-launch-transition: OK — launch resets immediately and reports progress without redirecting.");
