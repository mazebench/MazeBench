const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const runScript = fs.readFileSync(path.join(root, "public", "agent-run.js"), "utf8");
const siteTheme = fs.readFileSync(path.join(root, "public", "local-site.css"), "utf8");
const pages = fs.readFileSync(path.join(root, "server", "pages.js"), "utf8");
const agentRuns = fs.readFileSync(path.join(root, "server", "agent-runs.js"), "utf8");
const threeRenderer = fs.readFileSync(path.join(root, "public", "play-render-three.js"), "utf8");
const { asciiGlyphPalette } = require(path.join(root, "shared", "maze-ascii-palette"));

assert.match(runScript, /type="number" min="1" max="60" step="1"[^>]+data-replay-rate/);
assert.match(runScript, />FPS<\/span>/);
assert.match(runScript, /const DEFAULT_REPLAY_FPS = 30/);
assert.match(runScript, /: DEFAULT_REPLAY_FPS;/);
assert.doesNotMatch(runScript, /<select data-replay-rate/);
assert.match(pages, /agent-run\.js\?v=20260804-replay-export-limits-1/);
assert.match(pages, /id="run-history-progress"[^>]+role="progressbar"/);
assert.doesNotMatch(pages, /Loading move 0/);
assert.match(runScript, /function updateHistoryLoadProgress\(sync\)/);
assert.match(runScript, /scheduleProgressPoll\(25\)/);
assert.match(siteTheme, /\.run-history-progress__fill \{/);
assert.match(runScript, /function updateReplayControlsInPlace\(container, viewId\)/);
assert.match(runScript, /function fitAsciiBoard\(\)/);
assert.match(runScript, /function drawAsciiBitmap\(board, turn = null\)/);
assert.match(runScript, /function drawJsonGrid\(observation, displayPalette = null, turn = null\)/);
assert.match(runScript, /after move \$\{turn\} · live JSON grid/);
assert.match(runScript, /if \(!liveBitmap \|\| isVision\) return false/);
assert.equal(
  (pages.match(/id="run-live-bitmap" class="run-live__bitmap"/g) || []).length,
  2,
  "Prime and local ASCII layouts must both expose the colored grid"
);
assert.equal(
  (pages.match(/aria-label="Live colored grid view"/g) || []).length,
  2,
  "Prime and local run pages must both label the colored grid"
);
assert.match(pages, /ascii_palette: asciiGlyphPalette/);
assert.match(siteTheme, /\.run-live__bitmap \{[\s\S]*?image-rendering: pixelated/);
const terrainColorSource = threeRenderer.match(/function terrainColor\(type\) \{([\s\S]*?)\n    \}/)?.[1] || "";
const actorColorSource = threeRenderer.match(/function actorColor\(actor\) \{([\s\S]*?)\n    \}/)?.[1] || "";
const literalPalette = asciiGlyphPalette();
[
  ["W", terrainColorSource], ["T", terrainColorSource], ["S", terrainColorSource],
  ["&", terrainColorSource], ["I", terrainColorSource], ["O", terrainColorSource],
  ["Y", terrainColorSource], ["L", terrainColorSource], ["A", terrainColorSource],
  ["P", actorColorSource], ["C", actorColorSource], ["U", actorColorSource],
  ["F", actorColorSource], ["G", actorColorSource], ["Z", actorColorSource],
  ["B", actorColorSource]
].forEach(([glyph, source]) => {
  assert.ok(source.includes(literalPalette[glyph]), `${glyph} bitmap color must match the 3D renderer`);
});
assert.match(runScript, /Model request \$\{inferenceAction\} in flight/);
assert.match(agentRuns, /function reconstructAsciiObservation\(/);
assert.match(agentRuns, /latest\.level = reconstructAsciiObservation/);
assert.match(agentRuns, /json_display_palette: jsonDisplayPalette/);
assert.match(agentRuns, /status\?\.json_display_palette \|\| reconstructedJson\?\.displayPalette/);
assert.match(agentRuns, /mode === "json" && !status\?\.json_observation/);
assert.match(agentRuns, /function jsonDisplayPaletteForRun\(summary, metadata = \{\}, observation = null\)/);
assert.match(runScript, /--run-ascii-font-size/);
assert.doesNotMatch(runScript, /function resolveReplayFrame\(turn\)/);
assert.doesNotMatch(runScript, /\/api\/agent\/runs\/\$\{encodeURIComponent\(runId\)\}\/frame/);
assert.doesNotMatch(runScript, /liveGrid\?\.classList\.toggle\("is-text-history"/);
assert.match(runScript, /document\.activeElement !== rateInput/);
assert.match(runScript, /playbackGeneration: 0/);
assert.match(runScript, /state\.playbackGeneration \+= 1/);
assert.match(runScript, /function isCurrentPlayback\(viewId, generation\)/);
assert.match(runScript, /playbackRequest && !isCurrentPlayback\(viewId, playbackGeneration\)/);
assert.match(runScript, /const REPLAY_BUFFER_FRAMES = 240/);
assert.match(runScript, /function ensureReplayBuffered\(viewId, requestedTurn\)/);
assert.match(runScript, /\/observations\?\$\{params\}/);
assert.match(runScript, /state\.playbackTimer = requestAnimationFrame/);
assert.match(runScript, /timestamp \+ 1 < state\.playbackNextFrameAt/);
assert.match(runScript, /timestamp - state\.playbackNextFrameAt > delay/);
assert.doesNotMatch(runScript, /state\.playbackDeadline/);
assert.doesNotMatch(runScript, /Math\.max\(0, state\.playbackDeadline - performance\.now\(\)\)/);
assert.match(runScript, /state\.progressController\?\.abort\(\)/);
assert.match(runScript, /if \(!state\.playingView\) state\.timer = setTimeout\(poll, delay\)/);
assert.match(runScript, /control\.addEventListener\("input", \(event\) => updateRate\(event\)\)/);
assert.match(runScript, /data-replay-icon="play"/);
assert.match(runScript, /data-replay-icon="pause"/);
assert.doesNotMatch(runScript, /play\.innerHTML = playing/);
assert.match(runScript, /control\.addEventListener\("pointerdown"/);
assert.match(runScript, /control\.dataset\.replayPointerPending = "true"/);
assert.match(runScript, /delete control\.dataset\.replayPointerPending/);
assert.match(runScript, /event\.key !== "Enter" && event\.key !== " "/);
assert.match(runScript, /control\.dataset\.replayKeyboardPending = "true"/);
assert.match(runScript, /!pointerActivated && !keyboardActivated/);
assert.doesNotMatch(runScript, /replayPointerAt/);
assert.match(siteTheme, /\.replay-control__icon \{[\s\S]*?pointer-events: none/);
assert.match(siteTheme, /\.replay-control \{[\s\S]*?min-height: 40px/);
assert.match(siteTheme, /\.run-live__grid \{[\s\S]*?align-items: stretch/);
assert.match(siteTheme, /\.run-live__grid\.is-json-mode \{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
assert.match(siteTheme, /\.run-live__board \.agent-board \{[\s\S]*?height: 100%/);
assert.match(siteTheme, /\.run-live__json \.agent-board \{[\s\S]*?overflow: auto/);
assert.doesNotMatch(siteTheme, /\.run-live__grid\.is-text-history \.run-live__viewer/);
assert.match(siteTheme, /\.replay-rate input \{/);
assert.doesNotMatch(siteTheme, /\.replay-rate select \{/);
assert.match(runScript, /data-replay-turn data-replay-view=/);
assert.match(runScript, /type="range"[^>]+data-replay-scrubber/);
assert.match(runScript, /aria-label="Live view action timeline"/);
assert.match(runScript, /const REPLAY_SCRUB_DELAY_MS = 80/);
assert.match(runScript, /setTimeout\(seek, REPLAY_SCRUB_DELAY_MS\)/);
assert.match(runScript, /Math\.max\(0, Number\(state\.afterTurn\) \|\| 0, Number\(state\.run\?\.turns\) \|\| 0\)/);
assert.match(siteTheme, /\.replay-timeline input\[type="range"\] \{[\s\S]*?--timeline-progress/);
assert.match(siteTheme, /linear-gradient\(to right, #65f3d4 0 var\(--timeline-progress\)/);
assert.match(runScript, /function jumpToPrimaryFrame\(requestedTurn/);
assert.match(runScript, /data-jump-turn="\$\{escapeText\(num\)\}"/);
assert.match(runScript, /void jumpToPrimaryFrame\(Number\(frame\.dataset\.jumpTurn\)\)/);
assert.match(runScript, /canvas\._replayJumpTargets = jumpTargets/);
assert.match(runScript, /function wireMetricChart\(canvas\)/);
assert.match(runScript, /void jumpToPrimaryFrame\(target\.action\)/);
assert.match(runScript, /const minimum = key === "rooms" \? 1 : 0;/);
assert.match(runScript, /ceiling - valueRange \* \(index \/ tickCount\)/);
assert.match(pages, /id="run-rooms-latest" class="run-metric-chart__latest"/);
assert.match(pages, /id="run-gems-latest" class="run-metric-chart__latest"/);
assert.match(pages, /id="run-rooms-chart-tooltip" class="run-metric-chart__tooltip" role="tooltip" hidden/);
assert.match(pages, /id="run-gems-chart-tooltip" class="run-metric-chart__tooltip" role="tooltip" hidden/);
assert.equal(
  (pages.match(/id="run-main-replay-controls"/g) || []).length,
  2,
  "Prime and local run layouts must both expose ASCII playback controls"
);
assert.match(runScript, /if \(!url \|\| !liveImage\) return;/);
assert.match(runScript, /if \(liveImage\) liveImage\.hidden = !hasRenderedImage;/);
assert.match(runScript, /if \(livePlaceholder\) \{\s*livePlaceholder\.hidden = hasRenderedImage;/);
assert.match(runScript, /function showMetricTooltip\(canvas, target, event\)/);
assert.match(runScript, /tooltip\.textContent = `Frame \$\{target\.action\.toLocaleString\(\)\} · \$\{noun\}`/);
assert.match(siteTheme, /\.run-metric-chart__canvas\.has-jump-target/);
assert.match(siteTheme, /\.run-metric-chart__tooltip \{/);
assert.match(pages, /id="run-heatmap-export-limit-kind"[\s\S]*?>Up to move<[\s\S]*?>Up to API cost</);
assert.match(pages, /id="run-heatmap-export-limit-value" type="number" min="0"/);
assert.match(runScript, /function selectedHeatmapExportLimit\(\)/);
assert.match(runScript, /api_cost_cumulative_usd/);
assert.match(runScript, /heatmapVisitData\(limit\.maxMove\)/);
assert.match(siteTheme, /\.run-heatmap__limit \{/);
assert.equal((pages.match(/id="run-replay-export"/g) || []).length, 1);
assert.match(pages, /id="run-video-export-limit-kind"[\s\S]*?>Full run<[\s\S]*?>Up to move<[\s\S]*?>Up to API cost</);
assert.match(pages, /id="run-video-export-limit-value" type="number" min="1"/);
assert.match(pages, /id="run-video-export-quality"[\s\S]*?>Website quality \(&lt;25 MB\)<[\s\S]*?>Raw quality \(~100 MB\)</);
assert.match(
  pages,
  /id="run-replay-export"[\s\S]*?id="generate-video" class="run-heatmap__export run-replay-export__button"[\s\S]*?>Generate replay<[\s\S]*?id="run-replay-progress"[\s\S]*?id="run-replay-section"/
);
assert.match(pages, /<h2>Runner log<\/h2>[\s\S]*?\$\{replayExportSection\}/);
assert.match(runScript, /const previousLogScrollTop = logEl\.scrollTop/);
assert.match(runScript, /logEl\.scrollTop = previousLogScrollTop/);
assert.doesNotMatch(runScript, /logEl\.scrollTop = logEl\.scrollHeight/);
assert.doesNotMatch(pages, /id="generate-video" class="button run-video-action"/);
assert.match(runScript, /\["paused", "finished", "stopped", "failed"\]\.includes\(run\.status\)/);
assert.match(runScript, /Pausing now — cancelling active model and tools/);
assert.doesNotMatch(runScript, /Pausing after move/);
assert.match(runScript, /generateLabel\.textContent = renderingVideo \? "Generating…" : "Generate replay"/);
assert.match(runScript, /function selectedVideoExportLimit\(\)/);
assert.match(runScript, /action_limit: limit\.maxMove/);
assert.match(runScript, /quality,[\s\S]*?api_cost_limit_usd: limit\.value/);
assert.match(runScript, /videoExportQuality\?\.value === "raw"/);
assert.match(agentRuns, /videoRequest\.quality === "website"[\s\S]*?videoArgs\.push\("--max-video-mib", "24"\)/);
assert.match(agentRuns, /videoArgs\.push\("--action-limit", String\(videoRequest\.actionLimit\)\)/);
assert.match(agentRuns, /video_quality: videoRequest\.quality/);
assert.match(siteTheme, /\.run-video \{[\s\S]*?max-height: min\(62vh, 540px\);[\s\S]*?width: min\(100%, 760px\);/);
assert.match(siteTheme, /\.run-replay-progress-panel \{[\s\S]*?margin-top: 16px/);

console.log("agent-run-playback-source: OK — exact-frame input and linked logs/charts share race-safe replay navigation.");
