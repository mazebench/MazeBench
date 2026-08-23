const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { claudeReasoningLevels } = require("../server/agent-runs");

const fullEffortRange = ["low", "medium", "high", "xhigh", "max"];
const families = ["opus", "fable", "sonnet", "haiku"];

families.forEach((family) => {
  [
    `claude-${family}-5`,
    `claude-${family}-99-7`,
    `anthropic/claude-${family}-x`
  ].forEach((modelId) => {
    assert.deepEqual(
      claudeReasoningLevels(modelId),
      fullEffortRange,
      `${modelId} should inherit the full Claude family effort range`
    );
  });
});

assert.deepEqual(claudeReasoningLevels("claude-mythos-5"), fullEffortRange);
assert.deepEqual(
  claudeReasoningLevels("claude-mythos-preview"),
  ["low", "medium", "high", "max"]
);
assert.deepEqual(claudeReasoningLevels("claude-unknown-5"), []);

const agentRunsSource = fs.readFileSync(path.join(__dirname, "..", "server", "agent-runs.js"), "utf8");
const agentClientSource = fs.readFileSync(path.join(__dirname, "..", "public", "agent.js"), "utf8");
assert.match(agentRunsSource, /id: "stealth\/ox-alpha"/);
assert.match(agentRunsSource, /inference: "openrouter"/);
assert.match(agentRunsSource, /pricing: \{ input: 0, output: 0 \}/);
assert.match(agentClientSource, /inference: selectedModel\(\)\?\.inference \|\| "subscription"/);
assert.match(agentClientSource, /body\.inference === "openrouter"/);

console.log("claude reasoning tests passed");
