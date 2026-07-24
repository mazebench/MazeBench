const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildPrimeResumeCheckpoint, writePrimeResumeCheckpoint } = require("../server/prime-resume");

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-prime-resume-"));
const evalDir = path.join(runDir, "eval-output");
fs.mkdirSync(evalDir, { recursive: true });

try {
  fs.writeFileSync(path.join(runDir, "actions.jsonl"), [
    JSON.stringify({ turn: 1, command_text: "up", valid: true, status: { board_state_hash: "one" } }),
    JSON.stringify({ turn: 2, command_text: "left", valid: true, status: { board_state_hash: "two" } }),
    // A final duplicate is possible when live telemetry and final artifact import overlap.
    JSON.stringify({ turn: 2, command_text: "left", valid: true, status: { board_state_hash: "two" } })
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(evalDir, "results.jsonl"), JSON.stringify({
    task: {
      system_prompt: "system",
      level_id: "level_HxI",
      game_won_gem_count: 70,
      observation_mode: "ascii"
    },
    nodes: [
      { parent: null, message: { role: "system", content: "system" }, sampled: false },
      { parent: 0, message: { role: "user", content: "opening" }, sampled: false },
      { parent: 1, message: { role: "assistant", content: "up" }, sampled: true },
      { parent: 2, message: { role: "user", content: "after up" }, sampled: false },
      // This dead branch is still one committed environment action, but is not
      // part of the provider's final compacted context.
      { parent: 3, message: { role: "assistant", content: "left", provider_state: [{ type: "reasoning", data: "old" }] }, sampled: true },
      // Retokenization/continuation-state compaction can re-root the final model
      // response. The parent chain, not array order, is the resumable context.
      { parent: 0, message: { role: "assistant", content: "left", provider_state: [{ type: "reasoning", data: "live" }] }, sampled: true }
    ]
  }) + "\n");

  assert.throws(() => buildPrimeResumeCheckpoint(runDir), /3 new sampled responses, 2 actions/);
  const row = JSON.parse(fs.readFileSync(path.join(evalDir, "results.jsonl"), "utf8"));
  row.nodes.splice(4, 1);
  row.nodes[4].parent = 0;
  fs.writeFileSync(path.join(evalDir, "results.jsonl"), JSON.stringify(row) + "\n");

  const checkpoint = buildPrimeResumeCheckpoint(runDir, {
    sourceRunId: "source-run",
    initialStatus: { board_state_hash: "zero" }
  });
  assert.equal(checkpoint.action_count, 2);
  assert.equal(checkpoint.task.game_won_gem_count, 100);
  assert.equal(checkpoint.initial_board_state_hash, "zero");
  assert.equal(checkpoint.final_board_state_hash, "two");
  assert.deepEqual(checkpoint.messages, [
    { role: "assistant", content: "left", provider_state: [{ type: "reasoning", data: "live" }] }
  ]);
  const written = writePrimeResumeCheckpoint(runDir, {
    sourceRunId: "source-run",
    initialStatus: { board_state_hash: "zero" }
  });
  assert.equal(JSON.parse(fs.readFileSync(written.path, "utf8")).source_run_id, "source-run");

  fs.appendFileSync(
    path.join(runDir, "actions.jsonl"),
    `${JSON.stringify({ turn: 3, command_text: "down", valid: true, status: { board_state_hash: "three" } })}\n`
  );
  fs.writeFileSync(path.join(evalDir, "results.jsonl"), `${JSON.stringify({
    task: {
      system_prompt: "system",
      level_id: "level_HxI",
      game_won_gem_count: 70,
      observation_mode: "ascii"
    },
    nodes: [
      { parent: null, message: { role: "system", content: "system" }, sampled: false },
      { parent: 0, message: { role: "assistant", content: "left" }, sampled: false },
      { parent: 1, message: { role: "user", content: "resume observation" }, sampled: false },
      { parent: 2, message: { role: "assistant", content: "down" }, sampled: true }
    ]
  })}\n`);
  const continued = writePrimeResumeCheckpoint(runDir, { sourceRunId: "continued-run" }).checkpoint;
  assert.equal(continued.action_count, 3);
  assert.equal(continued.final_board_state_hash, "three");
  assert.deepEqual(continued.messages.map((message) => message.role), ["assistant", "user", "assistant"]);

  console.log("prime-resume: checkpoint graph validation ready");
} finally {
  fs.rmSync(runDir, { recursive: true, force: true });
}
