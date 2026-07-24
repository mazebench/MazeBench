"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CHECKPOINT_FILE = "prime-resume.json";
const CHECKPOINT_VERSION = 1;

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function findResultsFile(directory, depth = 0) {
  if (depth > 6 || !fs.existsSync(directory)) return "";
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === "results.jsonl") {
      return path.join(directory, entry.name);
    }
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findResultsFile(path.join(directory, entry.name), depth + 1);
    if (found) return found;
  }
  return "";
}

function uniqueOrderedActions(filePath) {
  const byTurn = new Map();
  for (const action of readJsonLines(filePath)) {
    const turn = Math.floor(Number(action?.turn));
    if (turn > 0) byTurn.set(turn, { ...action, turn });
  }
  const actions = [...byTurn.values()].sort((left, right) => left.turn - right.turn);
  actions.forEach((action, index) => {
    if (action.turn !== index + 1) {
      throw new Error(`Prime resume actions are not contiguous at turn ${index + 1}.`);
    }
    if (!action.status || typeof action.status !== "object") {
      throw new Error(`Prime resume action ${action.turn} has no saved maze status.`);
    }
    if (!String(action.status.board_state_hash || "")) {
      throw new Error(`Prime resume action ${action.turn} has no board-state hash.`);
    }
  });
  return actions;
}

function resumableMessage(message) {
  if (!message || typeof message !== "object") return null;
  const role = String(message.role || "");
  if (!['user', 'assistant', 'tool'].includes(role)) return null;
  const saved = { role, content: message.content ?? null };
  for (const key of ["reasoning_content", "provider_state", "thinking_blocks", "tool_calls", "tool_call_id", "name"]) {
    if (message[key] != null) saved[key] = message[key];
  }
  return saved;
}

function leafPath(nodes, leaf) {
  const reversed = [];
  const seen = new Set();
  let index = leaf;
  while (index != null) {
    if (!Number.isInteger(index) || index < 0 || index >= nodes.length || seen.has(index)) {
      throw new Error("Prime result contains an invalid message-graph parent chain.");
    }
    seen.add(index);
    reversed.push(index);
    index = nodes[index].parent;
  }
  return reversed.reverse();
}

function buildPrimeResumeCheckpoint(runDir, { initialStatus = null, sourceRunId = "" } = {}) {
  const actionsPath = path.join(runDir, "actions.jsonl");
  const resultsPath = findResultsFile(path.join(runDir, "eval-output"));
  if (!fs.existsSync(actionsPath)) throw new Error("Prime resume requires actions.jsonl.");
  if (!resultsPath) throw new Error("Prime resume requires a saved Verifiers results.jsonl.");

  const rows = readJsonLines(resultsPath);
  if (!rows.length) throw new Error("Prime resume results are empty.");
  const row = rows[0];
  const nodes = Array.isArray(row.nodes) ? row.nodes : [];
  const actions = uniqueOrderedActions(actionsPath);
  let prior = null;
  try {
    prior = JSON.parse(fs.readFileSync(path.join(runDir, CHECKPOINT_FILE), "utf8"));
  } catch (_error) {
    /* legacy run or first checkpoint */
  }
  const priorActionCount = prior?.version === CHECKPOINT_VERSION
    ? Math.max(0, Math.floor(Number(prior.action_count) || 0))
    : 0;
  const sampled = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node?.sampled && node.message?.role === "assistant");
  if (!actions.length) throw new Error("Prime resume has no completed actions to restore.");
  const expectedSampled = actions.length - priorActionCount;
  if (expectedSampled < 0 || sampled.length !== expectedSampled) {
    throw new Error(
      `Prime resume transcript/action mismatch (${sampled.length} new sampled responses, ${actions.length} actions, ${priorActionCount} checkpointed).`
    );
  }

  if (sampled.length === 0 && prior) {
    if (String(actions.at(-1)?.status?.board_state_hash || "") !== String(prior.final_board_state_hash || "")) {
      throw new Error("Prime resume checkpoint no longer matches the saved action state.");
    }
    return {
      ...prior,
      created_at: new Date().toISOString(),
      source_run_id: sourceRunId || prior.source_run_id || path.basename(runDir),
      initial_status: initialStatus || prior.initial_status || null
    };
  }

  const leaf = sampled[sampled.length - 1].index;
  const indices = leafPath(nodes, leaf);
  const systemNode = indices
    .map((index) => nodes[index])
    .find((node) => node.message?.role === "system");
  const messages = indices
    .map((index) => resumableMessage(nodes[index].message))
    .filter(Boolean);
  if (!messages.length || messages[messages.length - 1].role !== "assistant") {
    throw new Error("Prime resume could not recover the final successful assistant response.");
  }

  const task = row.task && typeof row.task === "object" ? row.task : {};
  const resolvedInitialStatus = initialStatus || prior?.initial_status || null;
  const firstHash = String(
    resolvedInitialStatus?.board_state_hash ||
    resolvedInitialStatus?.boardStateHash ||
    prior?.initial_board_state_hash ||
    ""
  );
  const lastHash = String(actions[actions.length - 1].status.board_state_hash || "");
  const checkpoint = {
    version: CHECKPOINT_VERSION,
    source_run_id: sourceRunId || path.basename(runDir),
    created_at: new Date().toISOString(),
    system_prompt: String(task.system_prompt || systemNode?.message?.content || ""),
    task: {
      allow_quit: task.allow_quit !== false,
      auto_quit: Boolean(task.auto_quit),
      auto_quit_threshold: Number(task.auto_quit_threshold ?? 10),
      auto_quit_mode: task.auto_quit_mode === "rolling" ? "rolling" : "cumulative",
      auto_quit_window: Math.max(1, Math.floor(Number(task.auto_quit_window) || 100)),
      game_id: String(task.game_id || "maze"),
      game_won_gem_count: 100,
      level_id: String(task.level_id || "level_HxI"),
      observation_mode: ["json", "vision"].includes(task.observation_mode) ? task.observation_mode : "ascii",
      omniscient: Boolean(task.omniscient),
      hide_names: Boolean(task.hide_names),
      hide_names_seed: String(task.hide_names_seed || "1"),
      target_gems: Math.max(0, Math.floor(Number(task.target_gems) || 0)),
      view: String(task.view || "top-diagonal"),
      yaw: Math.floor(Number(task.yaw) || 0)
    },
    initial_status: resolvedInitialStatus,
    initial_board_state_hash: firstHash,
    final_board_state_hash: lastHash,
    action_count: actions.length,
    transcript_leaf: leaf,
    transcript_message_count: messages.length,
    messages,
    actions
  };
  if (checkpoint.task.observation_mode === "vision") {
    throw new Error("Prime vision checkpoints are not resumable yet because saved result JSON omits image pixels.");
  }
  return checkpoint;
}

function writePrimeResumeCheckpoint(runDir, options = {}) {
  const checkpoint = buildPrimeResumeCheckpoint(runDir, options);
  const target = path.join(runDir, CHECKPOINT_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
  return { checkpoint, path: target };
}

module.exports = {
  CHECKPOINT_FILE,
  CHECKPOINT_VERSION,
  buildPrimeResumeCheckpoint,
  findResultsFile,
  uniqueOrderedActions,
  writePrimeResumeCheckpoint
};
