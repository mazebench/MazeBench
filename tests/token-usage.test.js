const assert = require("assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  findKimiWireFile,
  parseClaudeEvents,
  parseCodexEvents,
  parseCodexSession,
  parseCodexSwarmSessions,
  parseKimiWire,
  parsePrimeAgentEvents,
  parsePrimeLiveUsage,
  parsePrimeResults,
  withApiCostEstimate
} = require("../server/token-usage");
const { apiPricingForRun } = require("../server/agent-runs");
const {
  actionsFromShellCommand,
  actionsFromToolCall,
  containerRuntimeMountArgs,
  distillClaudeEvents,
  distillCodexEvents,
  providerFailureFromEvents,
  resultsFromOutput
} = require("../scripts/maze-agent-local");

assert.deepEqual(containerRuntimeMountArgs("/tmp/maze-current"), [
  "-v", "/tmp/maze-current/scripts:/app/scripts:ro",
  "-v", "/tmp/maze-current/server:/app/server:ro",
  "-v", "/tmp/maze-current/public:/app/public:ro",
  "-v", "/tmp/maze-current/games/maze:/app/games/maze:ro"
]);

const lines = (...events) => events.map((event) => JSON.stringify(event)).join("\n");

{
  const catalog = [
    { id: "openai/gpt-5.6-sol", pricing: { input: 5, output: 30 } },
    { id: "anthropic/claude-haiku-4.5", pricing: { input: 1, output: 5 } },
    { id: "google/gemini-3.5-flash", pricing: { input: 1.5, output: 9 } }
  ];
  assert.deepEqual(
    apiPricingForRun({ provider: "prime", model_name: "google/gemini-3.5-flash" }, catalog),
    { model: "google/gemini-3.5-flash", input: 1.5, output: 9 }
  );
  assert.deepEqual(
    apiPricingForRun({ provider: "codex", model_name: "gpt-5.6-sol" }, catalog),
    { model: "openai/gpt-5.6-sol", input: 5, output: 30 }
  );
  assert.deepEqual(
    apiPricingForRun({ provider: "claude", model_name: "claude-haiku-4-5" }, catalog),
    { model: "anthropic/claude-haiku-4.5", input: 1, output: 5 }
  );
  assert.deepEqual(
    apiPricingForRun(
      { provider: "kimi", model_name: "kimi/k3" },
      [
        { id: "other/kimi-k3", pricing: { input: 99, output: 99 } },
        { id: "moonshotai/kimi-k3", pricing: { input: 3, output: 15 } }
      ]
    ),
    { model: "moonshotai/kimi-k3", input: 3, output: 15 }
  );

  const usage = withApiCostEstimate(
    { available: true, input_tokens: 1_000_000, output_tokens: 500_000, api_cost_estimate_usd: null },
    { model: "google/gemini-3.5-flash", input: 1.5, output: 9 }
  );
  assert.equal(usage.api_cost_estimate_usd, 6);
  assert.deepEqual(usage.api_pricing, {
    model: "google/gemini-3.5-flash",
    input: 1.5,
    output: 9
  });
  assert.equal(
    withApiCostEstimate(
      { input_tokens: 100, output_tokens: 100, api_cost_estimate_usd: 2.75 },
      { model: "test", input: 100, output: 100 }
    ).api_cost_estimate_usd,
    2.75,
    "provider-reported cost remains authoritative"
  );
}

{
  const loop = (event) => ({ type: "context.append_loop_event", event });
  const kimiWire = lines(
    { type: "llm.request", maxTokens: 1000 },
    { type: "usage.record", usageScope: "turn", usage: { inputOther: 10, inputCacheRead: 20, inputCacheCreation: 0, output: 5 } },
    { type: "llm.request", maxTokens: 965 },
    loop({ type: "tool.call", toolCallId: "move-1", name: "mcp__mazebench__maze_action", args: { action: "right" } }),
    loop({ type: "tool.result", toolCallId: "move-1", result: { output: "{}" } }),
    { type: "usage.record", usageScope: "turn", usage: { inputOther: 5, inputCacheRead: 30, inputCacheCreation: 0, output: 5 } },
    { type: "llm.request", maxTokens: 925 },
    loop({ type: "tool.call", toolCallId: "batch-1", name: "mcp__mazebench__maze_action_sequence", args: { actions: ["up", "right", "down"] } }),
    loop({ type: "tool.result", toolCallId: "batch-1", result: { output: JSON.stringify({ completed_count: 2 }) } }),
    { type: "usage.record", usageScope: "turn", usage: { inputOther: 4, inputCacheRead: 40, inputCacheCreation: 0, output: 6 } }
  );
  const usage = parseKimiWire(kimiWire);
  assert.equal(usage.available, true);
  assert.equal(usage.exact, true);
  assert.equal(usage.input_tokens, 109);
  assert.equal(usage.cached_input_tokens, 90);
  assert.equal(usage.output_tokens, 16);
  assert.equal(usage.total_tokens, 125);
  assert.equal(usage.current_context_tokens, 50);
  assert.equal(usage.context_window, 1000);
  assert.equal(usage.uncached_input_tokens, 19);
  assert.equal(usage.cache_read_input_tokens, 90);
  assert.equal(usage.actions.length, 3, "completed sequence moves receive individual chart points");
  assert.deepEqual(usage.actions.map((point) => point.total_tokens), [75, 25, 25]);
  assert.equal(usage.actions.reduce((sum, point) => sum + point.total_tokens, 0), usage.total_tokens);
  assert.equal(usage.average_tokens_per_action, 42);
  assert.match(usage.note, /isolated session usage/);
  assert.equal(
    withApiCostEstimate(usage, { model: "moonshotai/kimi-k3", input: 3, output: 15 }).api_cost_estimate_usd,
    0.000567
  );

  const inFlight = parseKimiWire(`${kimiWire}\n${JSON.stringify({ type: "llm.request", maxTokens: 900 })}`);
  assert.equal(inFlight.current_context_tokens, 100, "the latest request exposes live context use while Kimi is thinking");
  assert.equal(parseKimiWire("").available, false);

  const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-kimi-usage-"));
  try {
    const oldWire = path.join(kimiHome, "sessions", "old", "agents", "main", "wire.jsonl");
    const newWire = path.join(kimiHome, "sessions", "new", "agents", "main", "wire.jsonl");
    fs.mkdirSync(path.dirname(oldWire), { recursive: true });
    fs.mkdirSync(path.dirname(newWire), { recursive: true });
    fs.writeFileSync(oldWire, "{}\n");
    fs.writeFileSync(newWire, "{}\n");
    fs.utimesSync(oldWire, new Date(1000), new Date(1000));
    fs.utimesSync(newWire, new Date(2000), new Date(2000));
    assert.equal(findKimiWireFile(kimiHome), newWire, "the active Kimi session wins over stale session files");
  } finally {
    fs.rmSync(kimiHome, { recursive: true, force: true });
  }
}

assert.deepEqual(
  providerFailureFromEvents(lines({ type: "result", is_error: true, api_error_status: 502, result: "Bad Gateway" }), "claude"),
  { provider: "claude", status: 502, message: "Bad Gateway" }
);
assert.equal(
  providerFailureFromEvents(lines({ type: "result", is_error: false, result: "done" }), "claude"),
  null
);
const codexCall = (verb) => ({
  type: "response_item",
  payload: { type: "custom_tool_call", input: `node scripts/codex-play.js ${verb} --state run/session.json up` }
});

{
  const usage = parseCodexSession(
    lines(
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 10 }, last_token_usage: { input_tokens: 100, output_tokens: 10 }, model_context_window: 1000 } } },
      codexCall("action"),
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 150, output_tokens: 20 }, last_token_usage: { input_tokens: 50, output_tokens: 10 }, model_context_window: 1000 } } },
      codexCall("action")
    )
  );
  assert.equal(usage.total_tokens, 170);
  assert.equal(usage.actions.length, 2);
  assert.equal(usage.actions[1].context_tokens, 50);
  assert.equal(usage.context_window, 1000);
}

{
  const tokenEvent = (totalInput, latestInput, totalOutput, latestOutput = totalOutput) => ({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: totalInput, output_tokens: totalOutput },
        last_token_usage: { input_tokens: latestInput, output_tokens: latestOutput },
        model_context_window: 1000
      }
    }
  });
  const dynamicCall = (tool, input, callId = "") => ({
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: callId,
      input: `const m=ALL_TOOLS.find(x=>x.name.endsWith("${tool}"));const r=await tools[m.name](${JSON.stringify(input)});`
    }
  });
  const usage = parseCodexSession(
    lines(
      tokenEvent(100, 100, 10),
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: 'await tools.mcp__mazebench__maze_action({action:"right"})' } },
      tokenEvent(150, 50, 20, 10),
      dynamicCall("maze_action", { action: "up" }),
      dynamicCall("maze_observe", {}),
      dynamicCall("maze_action", { action: "left", clone_id: "scout" }),
      dynamicCall("maze_action", { action: "left" }, "failed-action"),
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "failed-action", output: "Script completed\nOutput:\nError: cannot goto unvisited level" } }
    )
  );
  assert.equal(usage.actions.length, 2, "computed maze action calls receive per-action token points");
  assert.deepEqual(usage.actions.map((point) => point.total_tokens), [110, 60]);
}

{
  const tokenEvent = (timestamp, totalInput, latestInput, output = 10) => ({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: totalInput, output_tokens: output },
        last_token_usage: { input_tokens: latestInput, output_tokens: output },
        model_context_window: 1000
      }
    }
  });
  const lead = lines(
    { timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { session_id: "lead" } },
    tokenEvent("2026-01-01T00:00:01.000Z", 100, 100),
    { timestamp: "2026-01-01T00:00:02.000Z", type: "response_item", payload: { type: "function_call", name: "spawn_agent", call_id: "spawn-1", arguments: '{"task_name":"scout"}' } },
    { timestamp: "2026-01-01T00:00:03.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "spawn-1", output: '{"task_name":"/root/scout"}' } },
    tokenEvent("2026-01-01T00:00:04.000Z", 200, 120, 20),
    { timestamp: "2026-01-01T00:00:05.000Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: 'await tools.mcp__mazebench__maze_action({action:"right"})' } },
    { timestamp: "2026-01-01T00:00:06.000Z", type: "response_item", payload: { type: "agent_message", author: "/root/scout", content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER" }] } },
    tokenEvent("2026-01-01T00:00:07.000Z", 280, 150, 20),
    { timestamp: "2026-01-01T00:00:08.000Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: 'await tools.mcp__mazebench__maze_action({action:"up"})' } }
  );
  const worker = lines(
    { timestamp: "2026-01-01T00:00:03.100Z", type: "session_meta", payload: { session_id: "worker" } },
    tokenEvent("2026-01-01T00:00:03.500Z", 180, 180, 20)
  );
  const leadUsage = parseCodexSession(lead);
  assert.deepEqual(leadUsage.actions.map((point) => point.active_agents), [2, 1]);

  const swarmUsage = parseCodexSwarmSessions([lead, worker], "lead");
  assert.equal(swarmUsage.total_tokens, 500);
  assert.equal(swarmUsage.current_context_tokens, 330);
  assert.equal(swarmUsage.context_window, 2000);
  assert.equal(swarmUsage.average_tokens_per_action, 250);
  assert.deepEqual(swarmUsage.actions.map((point) => point.context_tokens), [300, 330]);
  assert.deepEqual(swarmUsage.actions.map((point) => point.active_agents), [2, 1]);
  assert.deepEqual(swarmUsage.actions.map((point) => point.total_tokens), [420, 80]);
  assert.equal(swarmUsage.actions.reduce((sum, point) => sum + point.total_tokens, 0), swarmUsage.total_tokens);
  assert.equal(swarmUsage.agents_current, 1);
  assert.equal(swarmUsage.agents_total, 2);
}

{
  const action = { type: "item.completed", item: { type: "command_execution", command: "node scripts/codex-play.js action --state session.json up" } };
  const usage = parseCodexEvents(
    lines(
      action,
      { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } },
      action,
      { type: "turn.completed", usage: { input_tokens: 260, output_tokens: 40 } }
    )
  );
  assert.equal(usage.total_tokens, 300, "Codex JSON turn totals are cumulative, not additive");
  assert.deepEqual(usage.actions.map((point) => point.total_tokens), [120, 180]);
  assert.equal(usage.exact, false);
}

{
  assert.deepEqual(actionsFromToolCall("mcp__mazebench__maze_action", { action: "left" }), ["left"]);
  assert.deepEqual(
    actionsFromToolCall("mcp__mazebench__maze_action_sequence", { actions: ["up", "right", "down"] }),
    ["up", "right", "down"]
  );
  assert.deepEqual(
    actionsFromToolCall("mcp__mazebench__maze_action", { action: "right", clone_id: "scout" }),
    [],
    "worker-clone moves do not belong to the lead token chart"
  );

  const command = [
    'node scripts/codex-play.js action --state "session.json" up',
    'node scripts/codex-play.js action --state "session.json" "rotate camera left"',
    'node scripts/codex-play.js action --state "session.json" right'
  ].join(" && ");
  assert.deepEqual(actionsFromShellCommand(command), ["up", "rotate camera left", "right"]);

  const output = `${JSON.stringify({ moved: true, gem_count: 1, current_room: "level_AxI" })}\n${JSON.stringify({ moved: false, gem_count: 1, current_room: "level_AxI" })}`;
  assert.deepEqual(resultsFromOutput(output).map((result) => result.moved), [true, false]);

  const sequenceOutput = JSON.stringify({
    requested_count: 3,
    completed_count: 2,
    steps: [
      { action: "up", status: { current_room: "level_HxI", gem_count: 0, game_lost: false } },
      { action: "right", status: { current_room: "level_HxJ", gem_count: 1, game_lost: false } },
      { action: "down", error: "budget exhausted", status: null }
    ],
    final_observation: { current_room: "level_HxJ", gem_count: 1 }
  });
  assert.deepEqual(resultsFromOutput(sequenceOutput).map((result) => result.room), ["level_HxI", "level_HxJ"]);

  const distilled = distillClaudeEvents(
    lines(
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Follow the corridor." } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "batch-1", name: "Bash", input: { command } }] } },
      { type: "user", _mazebench_received_at: "2026-07-10T13:05:11.000Z", message: { content: [{ type: "tool_result", tool_use_id: "batch-1", content: output }] } }
    )
  );
  assert.deepEqual(distilled.entries.map((entry) => entry.action), ["up", "rotate camera left"]);
  assert.deepEqual(distilled.entries.map((entry) => entry.move), [1, 2]);
  assert(distilled.entries.every((entry) => entry.reasoning === "Follow the corridor."));
  assert(distilled.entries.every((entry) => entry.timestamp === "2026-07-10T13:05:11.000Z"));

  const mcpDistilled = distillClaudeEvents(
    lines(
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Take the open lane." } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "mcp-1", name: "mcp__mazebench__maze_action", input: { action: "up" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "mcp-1", content: JSON.stringify({ moved: true, gem_count: 2, current_room: "level_HxI" }) }] } }
    )
  );
  assert.deepEqual(mcpDistilled.entries.map((entry) => entry.action), ["up"]);
  assert.equal(mcpDistilled.entries[0].reasoning, "Take the open lane.");

  const sequenceDistilled = distillClaudeEvents(
    lines(
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Run the saved route." } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "mcp-sequence", name: "mcp__mazebench__maze_action_sequence", input: { actions: ["up", "right", "down"] } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "mcp-sequence", content: sequenceOutput }] } }
    )
  );
  assert.deepEqual(sequenceDistilled.entries.map((entry) => entry.action), ["up", "right"]);
  assert.deepEqual(sequenceDistilled.entries.map((entry) => entry.room), ["level_HxI", "level_HxJ"]);
  assert(sequenceDistilled.entries.every((entry) => entry.reasoning === "Run the saved route."));

  const codexSequenceDistilled = distillCodexEvents(
    lines(
      { type: "item.completed", item: { type: "reasoning", text: "Run the saved route." } },
      { type: "item.completed", item: { type: "mcp_tool_call", name: "maze_action_sequence", arguments: { actions: ["up", "right", "down"] }, status: "completed", result: sequenceOutput } }
    )
  );
  assert.deepEqual(codexSequenceDistilled.entries.map((entry) => entry.action), ["up", "right"]);
  assert.deepEqual(codexSequenceDistilled.entries.map((entry) => entry.room), ["level_HxI", "level_HxJ"]);
}

{
  const usage = parseClaudeEvents(
    lines(
      { type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 5 } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "a1", name: "Bash", input: { command: "node scripts/codex-play.js action --state session.json up" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "{}" }] } },
      { type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 10, cache_creation_input_tokens: 110, output_tokens: 7 } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "a2", name: "Bash", input: { command: "node scripts/codex-play.js action --state session.json left" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a2", content: "{}" }] } },
      { type: "result", modelUsage: { "claude-test": { inputTokens: 30, outputTokens: 12, cacheReadInputTokens: 80, cacheCreationInputTokens: 110, contextWindow: 200000 } } }
    )
  );
  assert.equal(usage.total_tokens, 232);
  assert.deepEqual(usage.actions.map((point) => point.context_tokens), [100, 120]);
  assert.equal(usage.context_window, 200000);
}

{
  const usage = parseClaudeEvents(
    lines(
      { type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 5 } } },
      { type: "result", modelUsage: { "claude-fable-5": { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 80, costUSD: 0.00035, contextWindow: 1000000 } } },
      { type: "stream_event", event: { type: "message_delta", usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 110,
        output_tokens: 7,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 110 }
      } } },
      { type: "result", modelUsage: { "claude-fable-5": { inputTokens: 10, outputTokens: 7, cacheCreationInputTokens: 110, costUSD: 0.00265, contextWindow: 1000000 } } }
    )
  );
  assert.equal(usage.total_tokens, 232, "Claude result chunks must not replace the cumulative stream total");
  assert.equal(usage.input_tokens, 220);
  assert.equal(usage.output_tokens, 12);
  assert.equal(usage.uncached_input_tokens, 30);
  assert.equal(usage.cache_read_input_tokens, 80);
  assert.equal(usage.cache_creation_input_tokens, 110);
  assert.equal(usage.api_cost_estimate_usd, 0.00318);
  assert.equal(usage.api_pricing.model, "claude-fable-5");
}

{
  const command = [
    "node scripts/codex-play.js action --state session.json up",
    "node scripts/codex-play.js action --state session.json left"
  ].join(" && ");
  const usage = parseClaudeEvents(
    lines(
      { type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 100, output_tokens: 20 } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "batch", name: "Bash", input: { command } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "batch", content: "{}" }] } }
    )
  );
  assert.equal(usage.actions.length, 2);
  assert.deepEqual(usage.actions.map((point) => point.context_tokens), [100, 100]);
  assert.deepEqual(usage.actions.map((point) => point.total_tokens), [60, 60]);
}

{
  const usage = parseClaudeEvents(
    lines(
      { type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 50, output_tokens: 10 } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "ok", name: "mcp__mazebench__maze_action", input: { action: "right" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ok", content: "{}" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "over", name: "mcp__mazebench__maze_action", input: { action: "down" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "over", content: "budget exhausted", is_error: true }] } }
    )
  );
  assert.equal(usage.actions.length, 1, "failed MCP actions are not charted as completed maze moves");
}

{
  const usage = parseClaudeEvents(
    lines(
      { type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 50, output_tokens: 10 } } },
      { type: "assistant", message: { content: [
        { type: "tool_use", id: "worker", name: "Agent", input: { prompt: "Scout" } },
        { type: "tool_use", id: "move-1", name: "mcp__mazebench__maze_action", input: { action: "right" } }
      ] } },
      { type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "move-1", content: "{}" },
        { type: "tool_result", tool_use_id: "worker", content: "done" }
      ] } },
      { type: "assistant", message: { content: [
        { type: "tool_use", id: "move-2", name: "mcp__mazebench__maze_action", input: { action: "up" } }
      ] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "move-2", content: "{}" }] } }
    )
  );
  assert.deepEqual(usage.actions.map((point) => point.active_agents), [2, 1]);
  assert.equal(usage.agents_current, 1);
  assert.equal(usage.agents_total, 2);
}

{
  const usage = parsePrimeAgentEvents(
    lines(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "move-1", name: "maze_action", arguments: { action: "up" } }],
          usage: {
            input: 100,
            output: 20,
            cacheRead: 100,
            cacheWrite: 50,
            totalTokens: 220,
            cost: { input: 0.0005, output: 0.0006, cacheRead: 0, cacheWrite: 0, total: 0.0011 }
          }
        }
      },
      {
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "move-1",
          content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
          isError: false
        }
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          usage: {
            input: 150,
            output: 30,
            cacheRead: 50,
            cacheWrite: 25,
            totalTokens: 230,
            cost: { input: 0.00075, output: 0.0009, cacheRead: 0, cacheWrite: 0, total: 0.00165 }
          }
        }
      }
    ),
    250_000
  );
  assert.equal(usage.available, true);
  assert.equal(usage.exact, true);
  assert.equal(usage.input_tokens, 400);
  assert.equal(usage.cached_input_tokens, 150);
  assert.equal(usage.uncached_input_tokens, 250);
  assert.equal(usage.cache_creation_input_tokens, 75);
  assert.equal(usage.output_tokens, 50);
  assert.equal(usage.api_cost_estimate_usd, 0.00275);
  assert.deepEqual(usage.api_pricing, {
    input: 5,
    cache_read: 0,
    cache_write: 0,
    output: 30
  });
  assert.equal(usage.actions.length, 1);
}

{
  const usage = parsePrimeLiveUsage(
    lines(
      { turn: 1, prompt_tokens: 100, cached_input_tokens: 20, completion_tokens: 8, reasoning_tokens: 5, input_tokens: 120, total_tokens: 128 },
      { turn: 2, prompt_tokens: 40, cached_input_tokens: 100, completion_tokens: 10, reasoning_tokens: 7, input_tokens: 140, total_tokens: 150 }
    )
  );
  assert.equal(usage.total_tokens, 278);
  assert.deepEqual(usage.actions.map((point) => point.context_tokens), [120, 140]);
  assert.equal(usage.reasoning_tokens, 12);
  assert.equal(usage.agents_current, 1);
  assert.equal(usage.agents_total, 1);
}

{
  const usage = parsePrimeResults(
    lines({
      nodes: [
        { sampled: true, usage: { prompt_tokens: 100, cached_input_tokens: 20, completion_tokens: 8, reasoning_tokens: 5 } },
        { sampled: true, usage: { prompt_tokens: 40, cached_input_tokens: 100, completion_tokens: 10, reasoning_tokens: 7 } }
      ]
    })
  );
  assert.equal(usage.total_tokens, 278);
  assert.deepEqual(usage.actions.map((point) => point.context_tokens), [120, 140]);
  assert.equal(usage.reasoning_tokens, 12);
}

{
  const usage = parsePrimeResults(
    lines({
      info: {
        maze_actions: [{ turn: 1, command: "up" }],
        token_usage: {
          input_tokens: 1471,
          output_tokens: 2,
          final_input_tokens: 1471,
          final_output_tokens: 2
        }
      },
      nodes: []
    })
  );
  assert.equal(usage.available, true);
  assert.equal(usage.total_tokens, 1473);
  assert.equal(usage.current_context_tokens, 1471);
  assert.equal(usage.average_tokens_per_action, 1473);
  assert.equal(usage.actions[0].action, 1);
}

console.log("token usage tests passed");
