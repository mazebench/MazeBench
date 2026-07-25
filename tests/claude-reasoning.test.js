const assert = require("node:assert/strict");

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

console.log("claude reasoning tests passed");
