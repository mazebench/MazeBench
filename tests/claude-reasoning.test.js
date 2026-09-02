const assert = require("node:assert/strict");

const {
  claudeCatalogModelsFromMetadata,
  claudeReasoningLevels
} = require("../server/agent-runs");

const catalogModels = claudeCatalogModelsFromMetadata([
  "Custom fable model",
  "Fable 5 - capable",
  "Fable 5.1 - most capable",
  "Custom opus model",
  "Opus 4.6 - deep reasoning"
], ["fable", "opus"]);
assert.deepEqual(
  catalogModels.map(({ id, label, resolved_model_id: resolved }) => ({ id, label, resolved })),
  [
    { id: "claude-fable-5-1", label: "Fable 5.1", resolved: "claude-fable-5-1" },
    { id: "claude-fable-5", label: "Fable 5", resolved: "claude-fable-5" },
    { id: "opus", label: "Opus 4.6", resolved: "claude-opus-4-6" }
  ],
  "Fable 5.1 must submit its exact id instead of the moving fable alias"
);

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
