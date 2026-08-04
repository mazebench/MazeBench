const fs = require("fs");
const path = require("path");
const { actionsFromShellCommand, actionsFromToolCall } = require("../scripts/maze-agent-local");

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function distributedInteger(value, count, index) {
  const total = Math.max(0, Math.round(number(value)));
  const parts = Math.max(1, Math.floor(number(count)));
  const base = Math.floor(total / parts);
  return base + (index < total % parts ? 1 : 0);
}

function jsonLines(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}

function isMazeAction(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  return /(?:codex-play|maze-agent-local)\.js[\s\S]{0,1800}?\baction\s+--state\b/i.test(text);
}

function mazeActionCount(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  return actionsFromShellCommand(text).length || (isMazeAction(value) ? 1 : 0);
}

function mazeToolActionCount(name, input) {
  return actionsFromToolCall(name, input).length;
}

function withCompactionFlags(points) {
  return points.map((point, index) => {
    const previous = points[index - 1];
    const drop = previous && previous.context_tokens && point.context_tokens
      ? previous.context_tokens - point.context_tokens
      : 0;
    return {
      ...point,
      compacted: Boolean(previous && drop >= 4096 && point.context_tokens <= previous.context_tokens * 0.8)
    };
  });
}

function reconcilePointTotals(points, totals) {
  if (!points.length) return points;
  const last = points[points.length - 1];
  ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens", "total_tokens"].forEach((key) => {
    const accounted = points.reduce((sum, point) => sum + number(point[key]), 0);
    last[key] = number(last[key]) + Math.max(0, number(totals?.[key]) - accounted);
  });
  return points;
}

function finishUsage({
  provider,
  points,
  totals,
  currentContext,
  contextWindow,
  exact,
  note = "",
  averageTokensPerAction = null,
  agentsCurrent = null,
  agentsTotal = null
}) {
  const marked = withCompactionFlags(points);
  const perActionTotal = marked.reduce((sum, point) => sum + number(point.total_tokens), 0);

  return {
    provider,
    available: marked.length > 0 || number(totals.total_tokens) > 0,
    exact,
    note,
    total_tokens: number(totals.total_tokens),
    input_tokens: number(totals.input_tokens),
    cached_input_tokens: number(totals.cached_input_tokens),
    output_tokens: number(totals.output_tokens),
    reasoning_tokens: number(totals.reasoning_tokens),
    current_context_tokens: number(currentContext) || null,
    context_window: number(contextWindow) || null,
    average_tokens_per_action: marked.length
      ? Math.round(
          averageTokensPerAction !== null &&
          averageTokensPerAction !== undefined &&
          Number.isFinite(Number(averageTokensPerAction))
            ? Number(averageTokensPerAction)
            : perActionTotal / marked.length
        )
      : null,
    agents_current: agentsCurrent != null && Number.isFinite(Number(agentsCurrent)) ? Number(agentsCurrent) : null,
    agents_total: agentsTotal != null && Number.isFinite(Number(agentsTotal)) ? Number(agentsTotal) : null,
    compactions: marked.filter((point) => point.compacted).length,
    actions: marked
  };
}

function withApiCostEstimate(usage, pricing) {
  const inputRate = pricing?.input === null || pricing?.input === undefined || pricing?.input === ""
    ? NaN
    : Number(pricing.input);
  const outputRate = pricing?.output === null || pricing?.output === undefined || pricing?.output === ""
    ? NaN
    : Number(pricing.output);
  const existingCost = usage?.api_cost_estimate_usd;
  const hasExistingCost = existingCost !== null && existingCost !== undefined &&
    Number.isFinite(Number(existingCost));
  if (
    !usage ||
    hasExistingCost ||
    !Number.isFinite(inputRate) || inputRate < 0 ||
    !Number.isFinite(outputRate) || outputRate < 0
  ) {
    return usage;
  }

  const inputTokens = Math.max(0, number(usage.input_tokens));
  const outputTokens = Math.max(0, number(usage.output_tokens));
  return {
    ...usage,
    api_cost_estimate_usd: (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000,
    api_pricing: {
      model: String(pricing.model || ""),
      input: inputRate,
      output: outputRate
    }
  };
}

function withActionCostTimeline(usage) {
  const totalCost = Number(usage?.api_cost_estimate_usd);
  const points = Array.isArray(usage?.actions) ? usage.actions : [];
  const costEvents = Array.isArray(usage?.cost_events) ? usage.cost_events : [];
  if (!Number.isFinite(totalCost) || totalCost < 0 || (!points.length && !costEvents.length)) return usage;

  const pricing = usage?.api_pricing || {};
  const inputRate = Number(pricing.input);
  const outputRate = Number(pricing.output);
  const cacheReadRate = Number(pricing.cache_read);
  const cacheWriteRate = Number(pricing.cache_write);
  const cacheWrite5mRate = Number(pricing.cache_write_5m);
  const cacheWrite1hRate = Number(pricing.cache_write_1h);
  const cacheReadTokens = number(usage.cache_read_input_tokens);
  const cacheWriteTokens = number(usage.cache_creation_input_tokens);
  const cacheWrite5mTokens = number(usage.cache_creation_5m_input_tokens);
  const cacheWrite1hTokens = number(usage.cache_creation_1h_input_tokens);
  const cacheWriteUnknownTokens = number(usage.cache_creation_unknown_input_tokens);
  const pricedCachedTokens = cacheReadTokens + cacheWriteTokens;
  const pricedCachedCost =
    cacheReadTokens * (Number.isFinite(cacheReadRate) ? cacheReadRate : inputRate) +
    cacheWrite5mTokens * (Number.isFinite(cacheWrite5mRate) ? cacheWrite5mRate : inputRate) +
    cacheWrite1hTokens * (Number.isFinite(cacheWrite1hRate) ? cacheWrite1hRate : inputRate) +
    cacheWriteUnknownTokens * (
      Number.isFinite(cacheWriteRate)
        ? cacheWriteRate
        : Number.isFinite(cacheWrite1hRate)
          ? cacheWrite1hRate
          : inputRate
    );
  const blendedCachedRate = pricedCachedTokens > 0 && Number.isFinite(pricedCachedCost)
    ? pricedCachedCost / pricedCachedTokens
    : Number.isFinite(cacheReadRate)
      ? cacheReadRate
      : inputRate;
  const hasTokenPricing = Number.isFinite(inputRate) && inputRate >= 0 &&
    Number.isFinite(outputRate) && outputRate >= 0;
  const weightedTimeline = (entries, sorter) => [...entries]
    .sort(sorter)
    .map((point) => {
      const inputTokens = Math.max(0, number(point.input_tokens));
      const cachedTokens = Math.min(inputTokens, Math.max(0, number(point.cached_input_tokens)));
      const uncachedTokens = Math.max(0, inputTokens - cachedTokens);
      const outputTokens = Math.max(0, number(point.output_tokens));
      const fallbackTokens = Math.max(0, number(point.total_tokens)) || inputTokens + outputTokens;
      const weight = hasTokenPricing
        ? uncachedTokens * inputRate + cachedTokens * blendedCachedRate + outputTokens * outputRate
        : fallbackTokens;
      return { point, weight: Math.max(0, Number.isFinite(weight) ? weight : fallbackTokens) };
    });
  const annotate = (weighted) => {
    const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    if (!(totalWeight > 0)) return weighted.map(({ point }) => point);
    let cumulative = 0;
    return weighted.map(({ point, weight }, index) => {
      cumulative += totalCost * weight / totalWeight;
      return {
        ...point,
        api_cost_cumulative_usd: index === weighted.length - 1 ? totalCost : cumulative
      };
    });
  };
  const actions = annotate(weightedTimeline(
    points,
    (left, right) => number(left?.action) - number(right?.action)
  ));
  const apiCostTimeline = annotate(weightedTimeline(
    costEvents,
    (left, right) => number(left?.at_ms) - number(right?.at_ms)
  )).map((point) => ({
    at_ms: number(point.at_ms),
    api_cost_cumulative_usd: point.api_cost_cumulative_usd
  }));
  const { cost_events: _costEvents, ...publicUsage } = usage;
  return {
    ...publicUsage,
    actions,
    ...(apiCostTimeline.length ? { api_cost_timeline: apiCostTimeline } : {})
  };
}

function codexUsageShape(usage = {}) {
  const input = number(usage.input_tokens);
  const output = number(usage.output_tokens);
  return {
    input_tokens: input,
    cached_input_tokens: number(usage.cached_input_tokens),
    output_tokens: output,
    reasoning_tokens: number(usage.reasoning_output_tokens),
    total_tokens: number(usage.total_tokens) || input + output
  };
}

function parsedJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || ""));
  } catch (_error) {
    return fallback;
  }
}

// Codex CLI's saved session wraps MCP calls made through the exec compositor
// as JavaScript source. Recover primary maze actions from that wrapper while
// continuing to exclude private worker-clone exploration.
function codexPayloadActions(payload = {}) {
  const name = payload.name || payload.tool || payload.tool_name;
  const input = payload.input || payload.arguments || payload.command;
  const direct = mazeToolActionCount(name, input) || mazeActionCount(input);
  if (direct) return Array.from({ length: direct }, () => "action");

  const source = typeof input === "string" ? input : "";
  const actions = [];
  const appendAction = (body) => {
    if (/(?:["']clone_id["']|\bclone_id)\s*:/.test(body)) return;
    const action = body.match(/(?:^|[,\s])(?:["']action["']|action)\s*:\s*(["'`])([\s\S]*?)\1/);
    if (action?.[2]?.trim()) actions.push(action[2].trim());
  };
  const directCallPattern = /mcp__mazebench__maze_action\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  let match;

  while ((match = directCallPattern.exec(source))) {
    appendAction(match[1]);
  }

  // Codex may discover a deferred MCP tool through ALL_TOOLS and invoke it by
  // its computed name: `const m = ALL_TOOLS.find(..."maze_action"...);` then
  // `tools[m.name]({ action: "up" })`. Track only bindings whose resolver
  // explicitly selects the primary maze action tool so observe calls and other
  // computed tools are not mistaken for moves.
  const bindingPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*ALL_TOOLS\.find\s*\(([\s\S]*?)\)\s*;/g;
  while ((match = bindingPattern.exec(source))) {
    const [, binding, selector] = match;
    if (!/maze_action/i.test(selector)) continue;

    const escapedBinding = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const computedCallPattern = new RegExp(
      `\\btools\\s*\\[\\s*${escapedBinding}\\s*\\.\\s*name\\s*\\]\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)`,
      "g"
    );
    let callMatch;
    while ((callMatch = computedCallPattern.exec(source))) {
      appendAction(callMatch[1]);
    }
  }

  return actions;
}

function codexSessionId(raw) {
  const meta = jsonLines(raw).find((event) => event.type === "session_meta");
  return String(meta?.payload?.session_id || meta?.payload?.id || "");
}

function codexTokenTimeline(raw) {
  return jsonLines(raw).flatMap((event, index) => {
    if (event.type !== "event_msg" || event.payload?.type !== "token_count" || !event.payload.info) {
      return [];
    }
    const timestamp = Date.parse(event.timestamp || "");
    return [{
      at_ms: Number.isFinite(timestamp) ? timestamp : index,
      cumulative: codexUsageShape(event.payload.info.total_token_usage || {}),
      latest: codexUsageShape(event.payload.info.last_token_usage || {}),
      context_window: number(event.payload.info.model_context_window)
    }];
  });
}

function codexAgentMessageText(payload = {}) {
  return (Array.isArray(payload.content) ? payload.content : [])
    .map((part) => String(part?.text || ""))
    .join("\n");
}

function codexToolCallFailed(payload = {}) {
  if (payload.error || payload.is_error || payload.status === "failed") return true;
  const text = typeof payload.output === "string"
    ? payload.output
    : JSON.stringify(payload.output || "");
  return /\bScript (?:failed|error)\b|\bError:\s|budget exhausted|maze bridge returned no response|paused this run after the previous completed action/i.test(text);
}

function parseCodexSession(raw) {
  const points = [];
  let latest = null;
  let cumulative = {};
  let contextWindow = 0;
  const activeAgents = new Set(["/root"]);
  const allAgents = new Set(["/root"]);
  const pendingSpawns = new Map();
  const pendingActionPoints = new Map();

  for (const [eventIndex, event] of jsonLines(raw).entries()) {
    const payload = event.payload || {};
    const timestamp = Date.parse(event.timestamp || "");
    const atMs = Number.isFinite(timestamp) ? timestamp : eventIndex;

    if (event.type === "response_item" && payload.type === "function_call" && payload.name === "spawn_agent") {
      const args = parsedJson(payload.arguments);
      if (payload.call_id) pendingSpawns.set(payload.call_id, String(args.task_name || "worker"));
      continue;
    }

    if (event.type === "response_item" && payload.type === "function_call_output" && pendingSpawns.has(payload.call_id)) {
      const result = parsedJson(payload.output);
      if (result.task_name) {
        activeAgents.add(String(result.task_name));
        allAgents.add(String(result.task_name));
      }
      pendingSpawns.delete(payload.call_id);
      continue;
    }

    if (event.type === "response_item" && payload.type === "custom_tool_call_output") {
      const pending = pendingActionPoints.get(payload.call_id);
      if (pending && codexToolCallFailed(payload)) {
        const rejected = new Set(pending);
        for (let index = points.length - 1; index >= 0; index -= 1) {
          if (rejected.has(points[index])) points.splice(index, 1);
        }
      }
      pendingActionPoints.delete(payload.call_id);
      continue;
    }

    if (
      event.type === "response_item" &&
      payload.type === "agent_message" &&
      payload.author &&
      /Message Type:\s*FINAL_ANSWER/i.test(codexAgentMessageText(payload))
    ) {
      activeAgents.delete(String(payload.author));
      continue;
    }

    if (event.type === "event_msg" && event.payload?.type === "token_count" && event.payload.info) {
      latest = codexUsageShape(event.payload.info.last_token_usage || {});
      cumulative = codexUsageShape(event.payload.info.total_token_usage || {});
      contextWindow = number(event.payload.info.model_context_window) || contextWindow;
      continue;
    }

    if (
      event.type === "response_item" &&
      ["custom_tool_call", "function_call", "mcp_tool_call"].includes(event.payload?.type) &&
      latest
    ) {
      const actions = codexPayloadActions(event.payload);
      const count = actions.length;
      if (!count) continue;
      const added = [];
      for (let index = 0; index < count; index += 1) {
        const point = {
          action: points.length + 1,
          total_tokens: Math.round(latest.total_tokens / count),
          input_tokens: Math.round(latest.input_tokens / count),
          cached_input_tokens: Math.round(latest.cached_input_tokens / count),
          output_tokens: Math.round(latest.output_tokens / count),
          reasoning_tokens: Math.round(latest.reasoning_tokens / count),
          context_tokens: latest.input_tokens,
          active_agents: activeAgents.size,
          at_ms: atMs
        };
        points.push(point);
        added.push(point);
      }
      if (payload.call_id) pendingActionPoints.set(payload.call_id, added);
    }
  }

  points.forEach((point, index) => {
    point.action = index + 1;
  });

  return finishUsage({
    provider: "codex",
    points: reconcilePointTotals(points, cumulative),
    totals: cumulative,
    currentContext: latest?.input_tokens,
    contextWindow,
    exact: true,
    agentsCurrent: activeAgents.size,
    agentsTotal: allAgents.size
  });
}

function sumUsageShapes(values) {
  return values.reduce(
    (sum, value) => {
      Object.keys(sum).forEach((key) => {
        sum[key] += number(value?.[key]);
      });
      return sum;
    },
    { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0 }
  );
}

function timelineSnapshotAt(timeline, atMs) {
  let snapshot = null;
  for (const entry of timeline) {
    if (entry.at_ms > atMs) break;
    snapshot = entry;
  }
  return snapshot;
}

// A Codex swarm stores one rollout session per agent. Aggregate every saved
// thread so Total and Context include the workers, then align the combined
// context timeline to the lead's primary maze actions.
function parseCodexSwarmSessions(rawSessions, leadConversationId = "") {
  const sessions = (Array.isArray(rawSessions) ? rawSessions : [])
    .filter(Boolean)
    .map((raw) => ({
      id: codexSessionId(raw),
      usage: parseCodexSession(raw),
      timeline: codexTokenTimeline(raw)
    }));
  const lead = sessions.find((session) => session.id === leadConversationId) ||
    sessions.find((session) => session.usage.actions.length) ||
    sessions[0];

  if (!lead) return parseCodexSession("");

  const totals = sumUsageShapes(sessions.map((session) => session.usage));
  let previousCumulative = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0
  };
  const points = lead.usage.actions.map((leadPoint) => {
    const snapshots = sessions
      .map((session) => timelineSnapshotAt(session.timeline, number(leadPoint.at_ms)))
      .filter(Boolean);
    const cumulative = sumUsageShapes(snapshots.map((snapshot) => snapshot.cumulative));
    const delta = {};
    Object.keys(previousCumulative).forEach((key) => {
      delta[key] = Math.max(0, cumulative[key] - previousCumulative[key]);
    });
    previousCumulative = cumulative;
    return {
      action: leadPoint.action,
      ...delta,
      context_tokens: snapshots.reduce((sum, snapshot) => sum + number(snapshot.latest.input_tokens), 0),
      active_agents: leadPoint.active_agents
    };
  });
  const currentContext = sessions.reduce(
    (sum, session) => sum + number(session.usage.current_context_tokens),
    0
  );
  const contextWindow = sessions.reduce(
    (sum, session) => sum + number(session.usage.context_window),
    0
  );
  const agentCount = sessions.filter((session) => session.usage.available).length || sessions.length;
  reconcilePointTotals(points, totals);

  return finishUsage({
    provider: "codex",
    points,
    totals,
    currentContext,
    contextWindow,
    exact: true,
    note: `${agentCount} agent session${agentCount === 1 ? "" : "s"} · combined token use and context`,
    averageTokensPerAction: points.length ? totals.total_tokens / points.length : null,
    agentsCurrent: lead.usage.agents_current,
    agentsTotal: Math.max(number(lead.usage.agents_total), agentCount)
  });
}

function parseCodexEvents(raw) {
  const points = [];
  let pendingActions = 0;
  let previous = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0 };
  let totals = previous;

  for (const event of jsonLines(raw)) {
    const item = event.item || event.msg?.item;
    if ((event.type || event.msg?.type) === "item.completed") {
      const kind = item?.type || item?.item_type;
      const count = kind === "command_execution"
        ? mazeActionCount(item.command)
        : kind === "mcp_tool_call" && item.status !== "failed" && !item.error
          ? mazeToolActionCount(item.tool || item.name || item.tool_name, item.arguments || item.input)
          : 0;
      if (count) {
        pendingActions += count;
        continue;
      }
    }

    if ((event.type || event.msg?.type) !== "turn.completed" || !event.usage) continue;
    const current = codexUsageShape(event.usage);
    const delta = {
      input_tokens: Math.max(0, current.input_tokens - previous.input_tokens),
      cached_input_tokens: Math.max(0, current.cached_input_tokens - previous.cached_input_tokens),
      output_tokens: Math.max(0, current.output_tokens - previous.output_tokens),
      reasoning_tokens: Math.max(0, current.reasoning_tokens - previous.reasoning_tokens),
      total_tokens: Math.max(0, current.total_tokens - previous.total_tokens)
    };
    const count = Math.max(1, pendingActions);

    for (let index = 0; index < pendingActions; index += 1) {
      points.push({
        action: points.length + 1,
        total_tokens: Math.round(delta.total_tokens / count),
        input_tokens: Math.round(delta.input_tokens / count),
        cached_input_tokens: Math.round(delta.cached_input_tokens / count),
        output_tokens: Math.round(delta.output_tokens / count),
        reasoning_tokens: Math.round(delta.reasoning_tokens / count),
        context_tokens: null,
        active_agents: 1
      });
    }

    pendingActions = 0;
    previous = current;
    totals = current;
  }

  return finishUsage({
    provider: "codex",
    points,
    totals,
    currentContext: null,
    contextWindow: null,
    exact: false,
    note: "Per-action use is estimated from the CLI turn total; container context size is not exposed.",
    agentsCurrent: 1,
    agentsTotal: 1
  });
}

function claudeUsageShape(usage = {}) {
  const uncached = number(usage.input_tokens);
  const cached = number(usage.cache_read_input_tokens) + number(usage.cache_creation_input_tokens);
  const output = number(usage.output_tokens);
  return {
    input_tokens: uncached + cached,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_tokens: number(usage.output_tokens_details?.thinking_tokens),
    total_tokens: uncached + cached + output
  };
}

// USD per million tokens. Claude Code's Fable 5 modelUsage records price at
// these API-equivalent rates; cache writes retain the TTL-specific multipliers
// exposed in each streamed usage record.
const CLAUDE_API_PRICING = Object.freeze({
  "claude-fable-5": Object.freeze({
    input: 10,
    cache_read: 1,
    cache_write_5m: 12.5,
    cache_write_1h: 20,
    output: 50
  })
});

function claudeApiPricing(modelId) {
  const normalized = String(modelId || "").toLowerCase();
  return Object.entries(CLAUDE_API_PRICING).find(([prefix]) => normalized.startsWith(prefix))?.[1] || null;
}

function claudeCacheCreationBreakdown(usage = {}) {
  const direct = usage.cache_creation && typeof usage.cache_creation === "object"
    ? usage.cache_creation
    : null;
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  const fromIterations = iterations.reduce(
    (sum, iteration) => {
      sum.fiveMinute += number(iteration?.cache_creation?.ephemeral_5m_input_tokens);
      sum.oneHour += number(iteration?.cache_creation?.ephemeral_1h_input_tokens);
      return sum;
    },
    { fiveMinute: 0, oneHour: 0 }
  );
  const fiveMinute = direct
    ? number(direct.ephemeral_5m_input_tokens)
    : fromIterations.fiveMinute;
  const oneHour = direct
    ? number(direct.ephemeral_1h_input_tokens)
    : fromIterations.oneHour;
  const total = number(usage.cache_creation_input_tokens);

  return {
    five_minute: fiveMinute,
    one_hour: oneHour,
    unknown: Math.max(0, total - fiveMinute - oneHour)
  };
}

function claudeApiCost(details, pricing) {
  if (!pricing) return null;
  return (
    number(details.uncached_input_tokens) * pricing.input +
    number(details.cache_read_input_tokens) * pricing.cache_read +
    number(details.cache_creation_5m_input_tokens) * pricing.cache_write_5m +
    (number(details.cache_creation_1h_input_tokens) + number(details.cache_creation_unknown_input_tokens)) * pricing.cache_write_1h +
    number(details.output_tokens) * pricing.output
  ) / 1_000_000;
}

function parseClaudeEvents(raw) {
  const points = [];
  const costEvents = [];
  const pending = new Map();
  const pendingAgents = new Set();
  const allAgentTools = new Set();
  const totals = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0 };
  let previousActionTotals = { ...totals };
  const reportedTotals = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0 };
  const streamedDetails = {
    uncached_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_creation_5m_input_tokens: 0,
    cache_creation_1h_input_tokens: 0,
    cache_creation_unknown_input_tokens: 0,
    output_tokens: 0
  };
  const reportedDetails = { ...streamedDetails };
  let streamedResponses = 0;
  let reportedCost = 0;
  let selectedModelId = "";
  let latest = null;
  let contextWindow = 0;
  let selectedModelWeight = -1;
  let sawAgentTools = false;

  for (const [eventIndex, event] of jsonLines(raw).entries()) {
    if (event.type === "stream_event" && event.event?.type === "message_delta" && event.event.usage) {
      latest = claudeUsageShape(event.event.usage);
      streamedResponses += 1;
      Object.keys(totals).forEach((key) => {
        totals[key] += latest[key];
      });
      const cacheCreation = claudeCacheCreationBreakdown(event.event.usage);
      streamedDetails.uncached_input_tokens += number(event.event.usage.input_tokens);
      streamedDetails.cache_read_input_tokens += number(event.event.usage.cache_read_input_tokens);
      streamedDetails.cache_creation_input_tokens += number(event.event.usage.cache_creation_input_tokens);
      streamedDetails.cache_creation_5m_input_tokens += cacheCreation.five_minute;
      streamedDetails.cache_creation_1h_input_tokens += cacheCreation.one_hour;
      streamedDetails.cache_creation_unknown_input_tokens += cacheCreation.unknown;
      streamedDetails.output_tokens += number(event.event.usage.output_tokens);
      const timestamp = Date.parse(event.timestamp || event._mazebench_received_at || "");
      costEvents.push({
        ...latest,
        at_ms: Number.isFinite(timestamp) ? timestamp : eventIndex
      });
      continue;
    }

    if (event.type === "assistant" && Array.isArray(event.message?.content) && latest) {
      event.message.content.forEach((block) => {
        if (
          block?.type === "tool_use" &&
          block.id &&
          ["agent", "task"].includes(String(block.name || "").toLowerCase())
        ) {
          pendingAgents.add(block.id);
          allAgentTools.add(block.id);
          sawAgentTools = true;
        }
      });
      for (const block of event.message.content) {
        if (block?.type !== "tool_use" || !block.id) continue;
        const count = block.name === "Bash"
          ? mazeActionCount(block.input?.command)
          : mazeToolActionCount(block.name, block.input);
        if (count) {
          pending.set(block.id, {
            count,
            cumulative: { ...totals },
            context: { ...latest },
            active_agents: 1 + pendingAgents.size
          });
        }
      }
    }

    if (event.type === "user" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type !== "tool_result") continue;
        if (pendingAgents.delete(block.tool_use_id)) continue;
        if (!pending.has(block.tool_use_id)) continue;
        const batch = pending.get(block.tool_use_id);
        pending.delete(block.tool_use_id);
        if (block.is_error) continue;
        const delta = {};
        Object.keys(previousActionTotals).forEach((key) => {
          delta[key] = Math.max(0, number(batch.cumulative[key]) - number(previousActionTotals[key]));
        });
        previousActionTotals = batch.cumulative;
        for (let index = 0; index < batch.count; index += 1) {
          points.push({
            action: points.length + 1,
            total_tokens: Math.round(delta.total_tokens / batch.count),
            input_tokens: Math.round(delta.input_tokens / batch.count),
            cached_input_tokens: Math.round(delta.cached_input_tokens / batch.count),
            output_tokens: Math.round(delta.output_tokens / batch.count),
            reasoning_tokens: Math.round(delta.reasoning_tokens / batch.count),
            context_tokens: batch.context.input_tokens,
            active_agents: batch.active_agents
          });
        }
      }
    }

    if (event.type === "result" && event.modelUsage && typeof event.modelUsage === "object") {
      const modelStats = Object.entries(event.modelUsage);
      modelStats.forEach(([modelId, stats]) => {
        const input = number(stats?.inputTokens) +
          number(stats?.cacheReadInputTokens) +
          number(stats?.cacheCreationInputTokens);
        const output = number(stats?.outputTokens);
        reportedTotals.input_tokens += input;
        reportedTotals.cached_input_tokens += number(stats?.cacheReadInputTokens) + number(stats?.cacheCreationInputTokens);
        reportedTotals.output_tokens += output;
        reportedTotals.total_tokens += input + output;
        reportedDetails.uncached_input_tokens += number(stats?.inputTokens);
        reportedDetails.cache_read_input_tokens += number(stats?.cacheReadInputTokens);
        reportedDetails.cache_creation_input_tokens += number(stats?.cacheCreationInputTokens);
        reportedDetails.cache_creation_unknown_input_tokens += number(stats?.cacheCreationInputTokens);
        reportedDetails.output_tokens += output;
        reportedCost += number(stats?.costUSD);
        const weight =
          number(stats?.inputTokens) +
          number(stats?.cacheReadInputTokens) +
          number(stats?.cacheCreationInputTokens) +
          number(stats?.outputTokens);
        if (weight > selectedModelWeight) {
          selectedModelWeight = weight;
          selectedModelId = modelId;
          contextWindow = number(stats?.contextWindow) || contextWindow;
        }
      });
    }
  }

  // Streamed message usage is additive across resumes, retries, and
  // compactions. Result.modelUsage is scoped to one CLI invocation, so it is
  // only a fallback for legacy transcripts that contain no streamed deltas.
  const finalTotals = streamedResponses ? totals : reportedTotals;
  const finalDetails = streamedResponses ? streamedDetails : reportedDetails;
  reconcilePointTotals(points, finalTotals);

  const pricing = claudeApiPricing(selectedModelId);
  const apiCostEstimate = claudeApiCost(finalDetails, pricing);

  return {
    ...finishUsage({
      provider: "claude",
      points,
      totals: finalTotals,
      currentContext: latest?.input_tokens,
      contextWindow,
      exact: true,
      note: sawAgentTools ? "Claude Code · subagent usage included" : "",
      averageTokensPerAction: points.length && finalTotals.total_tokens
        ? finalTotals.total_tokens / points.length
        : null,
      agentsCurrent: 1 + pendingAgents.size,
      agentsTotal: 1 + allAgentTools.size
    }),
    ...finalDetails,
    cost_events: costEvents,
    api_cost_estimate_usd: apiCostEstimate ?? (reportedCost || null),
    api_pricing: pricing ? { model: selectedModelId, ...pricing } : null
  };
}

function kimiUsageShape(usage = {}) {
  const uncached = number(usage.inputOther);
  const cacheRead = number(usage.inputCacheRead);
  const cacheCreation = number(usage.inputCacheCreation);
  const input = uncached + cacheRead + cacheCreation;
  const output = number(usage.output);
  return {
    input_tokens: input,
    cached_input_tokens: cacheRead + cacheCreation,
    output_tokens: output,
    reasoning_tokens: 0,
    total_tokens: input + output,
    uncached_input_tokens: uncached,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation
  };
}

function kimiToolResultPayload(event = {}) {
  const output = event.result?.output ?? event.output ?? event.result;
  return parsedJson(output, null);
}

function parseKimiWire(raw) {
  const points = [];
  const pendingActionCalls = new Map();
  const totals = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0
  };
  const details = {
    uncached_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0
  };
  let previousActionTotals = { ...totals };
  let completedActionCount = 0;
  let latest = null;
  let usageRecords = 0;
  let requestRecords = 0;
  let contextWindow = 0;
  let latestRequestMaxTokens = 0;

  for (const record of jsonLines(raw)) {
    if (record.type === "llm.request") {
      const maxTokens = number(record.maxTokens);
      if (maxTokens > 0) {
        requestRecords += 1;
        contextWindow = Math.max(contextWindow, maxTokens);
        latestRequestMaxTokens = maxTokens;
      }
      continue;
    }

    if (record.type === "context.append_loop_event") {
      const event = record.event || {};
      if (event.type === "tool.call") {
        const count = mazeToolActionCount(event.name, event.args);
        if (count && event.toolCallId) {
          pendingActionCalls.set(event.toolCallId, { count, name: event.name });
        }
      } else if (event.type === "tool.result" && pendingActionCalls.has(event.toolCallId)) {
        const pending = pendingActionCalls.get(event.toolCallId);
        pendingActionCalls.delete(event.toolCallId);
        const payload = kimiToolResultPayload(event);
        const failed = Boolean(
          event.error ||
          event.isError ||
          event.result?.error ||
          event.result?.isError ||
          payload?.error ||
          payload?.isError
        );
        if (!failed) {
          const completed = /maze_action_sequence$/i.test(String(pending.name || "")) &&
            Number.isFinite(Number(payload?.completed_count))
            ? Math.max(0, Number(payload.completed_count))
            : pending.count;
          completedActionCount += completed;
        }
      }
      continue;
    }

    if (record.type !== "usage.record" || record.usageScope !== "turn") continue;
    latest = kimiUsageShape(record.usage);
    usageRecords += 1;
    Object.keys(totals).forEach((key) => {
      totals[key] += latest[key];
    });
    details.uncached_input_tokens += latest.uncached_input_tokens;
    details.cache_read_input_tokens += latest.cache_read_input_tokens;
    details.cache_creation_input_tokens += latest.cache_creation_input_tokens;

    if (!completedActionCount) continue;
    const delta = {};
    Object.keys(totals).forEach((key) => {
      delta[key] = Math.max(0, totals[key] - previousActionTotals[key]);
    });
    previousActionTotals = { ...totals };
    for (let index = 0; index < completedActionCount; index += 1) {
      points.push({
        action: points.length + 1,
        total_tokens: Math.round(delta.total_tokens / completedActionCount),
        input_tokens: Math.round(delta.input_tokens / completedActionCount),
        cached_input_tokens: Math.round(delta.cached_input_tokens / completedActionCount),
        output_tokens: Math.round(delta.output_tokens / completedActionCount),
        reasoning_tokens: 0,
        context_tokens: latest.input_tokens,
        active_agents: 1
      });
    }
    completedActionCount = 0;
  }

  reconcilePointTotals(points, totals);
  const currentContext = latest
    ? requestRecords > usageRecords && contextWindow && latestRequestMaxTokens
      ? Math.max(0, contextWindow - latestRequestMaxTokens)
      : latest.total_tokens
    : null;

  return {
    ...finishUsage({
      provider: "kimi",
      points,
      totals,
      currentContext,
      contextWindow,
      exact: usageRecords > 0,
      note: usageRecords > 0
        ? "Kimi Code · isolated session usage"
        : "Waiting for Kimi Code usage…",
      averageTokensPerAction: points.length && totals.total_tokens
        ? totals.total_tokens / points.length
        : null,
      agentsCurrent: 1,
      agentsTotal: 1
    }),
    ...details
  };
}

// Prime Agent reports per-message token usage and provider cost inline on its
// JSON event stream. Parse that stream directly so local Prime-Agent runs use
// the same token and cost cards as the other providers.
function primeAgentToolResultPayload(message = {}) {
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block?.type !== "text") continue;
    const value = parsedJson(block.text, null);
    if (value && typeof value === "object") return value;
  }
  return {};
}

function parsePrimeAgentEvents(raw, contextWindow = 0) {
  const points = [];
  const pending = new Map();
  const totals = {
    total_tokens: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0
  };
  const priceBuckets = {
    input: { tokens: 0, cost: 0 },
    cache_read: { tokens: 0, cost: 0 },
    cache_write: { tokens: 0, cost: 0 },
    output: { tokens: 0, cost: 0 }
  };
  let previousActionTotals = { ...totals };
  let previousActionCompactions = 0;
  let latestTotal = null;
  let usageRecords = 0;
  let compactions = 0;
  let cacheWriteTokens = 0;
  let cost = 0;

  const completeBatch = (batch, payload, failed) => {
    const reportedCompleted = batch.sequence
      ? Number.isFinite(Number(payload.completed_count))
        ? Math.max(0, Math.floor(Number(payload.completed_count)))
        : Array.isArray(payload.steps)
          ? payload.steps.length
          : batch.count
      : failed
        ? 0
        : batch.count;
    const completed = batch.count
      ? Math.min(batch.count, reportedCompleted)
      : reportedCompleted;
    if (!completed) return;

    const delta = {};
    Object.keys(previousActionTotals).forEach((key) => {
      delta[key] = Math.max(0, number(batch.cumulative[key]) - number(previousActionTotals[key]));
    });
    previousActionTotals = batch.cumulative;
    const compacted = batch.compactions > previousActionCompactions;
    previousActionCompactions = batch.compactions;

    for (let index = 0; index < completed; index += 1) {
      points.push({
        action: points.length + 1,
        total_tokens: distributedInteger(delta.total_tokens, completed, index),
        input_tokens: distributedInteger(delta.input_tokens, completed, index),
        cached_input_tokens: distributedInteger(delta.cached_input_tokens, completed, index),
        output_tokens: distributedInteger(delta.output_tokens, completed, index),
        reasoning_tokens: 0,
        context_tokens: batch.context_tokens,
        compacted: compacted && index === 0,
        active_agents: 1
      });
    }
  };

  for (const event of jsonLines(raw)) {
    if (event?.type === "compaction_end" && event.result && !event.aborted && !event.errorMessage) {
      compactions += 1;
      continue;
    }

    if (event?.type === "tool_execution_end" && pending.has(event.toolCallId)) {
      const batch = pending.get(event.toolCallId);
      pending.delete(event.toolCallId);
      const payload = primeAgentToolResultPayload(event.result);
      completeBatch(batch, payload, Boolean(
        event.isError || event.result?.isError || payload.error || payload.isError || payload.ok === false
      ));
      continue;
    }

    if (event?.type !== "message_end") continue;

    if (event.message?.role === "assistant") {
      const usage = event.message.usage;
      if (!usage) continue;
      const uncachedInput = number(usage.input);
      const output = number(usage.output);
      const cacheRead = number(usage.cacheRead);
      const cacheWrite = number(usage.cacheWrite);
      const input = uncachedInput + cacheRead;
      const total = number(usage.totalTokens) || input + output;
      if (!total) continue;

      usageRecords += 1;
      totals.input_tokens += input;
      totals.output_tokens += output;
      totals.cached_input_tokens += cacheRead;
      totals.total_tokens += total;
      cacheWriteTokens += cacheWrite;
      cost += number(usage.cost?.total);
      latestTotal = total;

      priceBuckets.input.tokens += uncachedInput;
      priceBuckets.input.cost += number(usage.cost?.input);
      priceBuckets.cache_read.tokens += cacheRead;
      priceBuckets.cache_read.cost += number(usage.cost?.cacheRead);
      priceBuckets.cache_write.tokens += cacheWrite;
      priceBuckets.cache_write.cost += number(usage.cost?.cacheWrite);
      priceBuckets.output.tokens += output;
      priceBuckets.output.cost += number(usage.cost?.output);

      for (const block of Array.isArray(event.message.content) ? event.message.content : []) {
        if (block?.type !== "toolCall" || !block.id) continue;
        const toolName = String(block.name || "");
        const sequence = /(?:^|__)(?:maze|game)_action_sequence$/.test(toolName);
        const single = /(?:^|__)(?:maze|game)_action$/.test(toolName);
        if (!single && !sequence) continue;
        const args = parsedJson(block.arguments);
        if (args.clone_id) continue;
        const plannedActions = actionsFromToolCall(toolName, args);
        if (!sequence && !plannedActions.length) continue;
        pending.set(block.id, {
          count: plannedActions.length,
          sequence,
          cumulative: { ...totals },
          context_tokens: total,
          compactions
        });
      }
      continue;
    }

    if (event.message?.role !== "toolResult" || !pending.has(event.message.toolCallId)) continue;
    const batch = pending.get(event.message.toolCallId);
    pending.delete(event.message.toolCallId);
    const payload = primeAgentToolResultPayload(event.message);
    completeBatch(batch, payload, Boolean(
      event.message.isError || payload.error || payload.isError || payload.ok === false
    ));
  }

  reconcilePointTotals(points, totals);
  const observedRate = ({ tokens, cost: observedCost }) => tokens > 0
    ? Number((observedCost * 1_000_000 / tokens).toFixed(6))
    : null;
  const apiPricing = Object.fromEntries(
    Object.entries(priceBuckets).map(([key, bucket]) => [key, observedRate(bucket)])
  );
  const hasObservedPricing = Number.isFinite(apiPricing.input) && Number.isFinite(apiPricing.output);

  return {
    ...finishUsage({
      provider: "prime-agent",
      points,
      totals,
      currentContext: latestTotal,
      contextWindow,
      exact: usageRecords > 0,
      note: usageRecords > 0
        ? "Prime Agent · provider-reported session usage"
        : "Waiting for Prime Agent usage…",
      averageTokensPerAction: points.length && totals.total_tokens
        ? totals.total_tokens / points.length
        : null,
      agentsCurrent: 1,
      agentsTotal: 1,
      compactions
    }),
    cache_read_input_tokens: totals.cached_input_tokens,
    cache_creation_input_tokens: cacheWriteTokens,
    uncached_input_tokens: Math.max(0, totals.input_tokens - totals.cached_input_tokens),
    api_cost_estimate_usd: cost || null,
    api_pricing: hasObservedPricing ? apiPricing : null
  };
}

function parsePrimeResults(raw) {
  const row = jsonLines(raw)[0] || {};
  const sampled = Array.isArray(row.nodes) ? row.nodes.filter((node) => node?.sampled && node.usage) : [];
  let points = sampled.map((node, index) => {
    const usage = node.usage || {};
    const input = number(usage.prompt_tokens) + number(usage.cached_input_tokens);
    const output = number(usage.completion_tokens);
    return {
      action: index + 1,
      total_tokens: input + output,
      input_tokens: input,
      cached_input_tokens: number(usage.cached_input_tokens),
      output_tokens: output,
      reasoning_tokens: number(usage.reasoning_tokens),
      context_tokens: input,
      active_agents: 1
    };
  });
  if (!points.length) {
    const usage = row.info?.token_usage || {};
    const input = number(usage.input_tokens) || number(usage.final_input_tokens);
    const output = number(usage.output_tokens) || number(usage.final_output_tokens);
    if (input || output) {
      points = [{
        action: Math.max(1, Number(row.info?.maze_actions?.length) || 1),
        total_tokens: input + output,
        input_tokens: input,
        cached_input_tokens: number(usage.cached_input_tokens),
        output_tokens: output,
        reasoning_tokens: number(usage.reasoning_tokens),
        context_tokens: number(usage.final_input_tokens) || input,
        active_agents: 1
      }];
    }
  }
  const totals = points.reduce(
    (sum, point) => {
      sum.input_tokens += point.input_tokens;
      sum.cached_input_tokens += point.cached_input_tokens;
      sum.output_tokens += point.output_tokens;
      sum.reasoning_tokens += point.reasoning_tokens;
      sum.total_tokens += point.total_tokens;
      return sum;
    },
    { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0 }
  );

  return finishUsage({
    provider: "prime",
    points,
    totals,
    currentContext: points.at(-1)?.context_tokens,
    contextWindow: null,
    exact: true,
    agentsCurrent: 1,
    agentsTotal: 1
  });
}

function parsePrimeLiveUsage(raw) {
  const byTurn = new Map();
  for (const record of jsonLines(raw)) {
    const turn = Math.max(1, Math.floor(number(record.turn)) || byTurn.size + 1);
    const input = number(record.input_tokens) || number(record.prompt_tokens) + number(record.cached_input_tokens);
    const output = number(record.completion_tokens);
    byTurn.set(turn, {
      action: turn,
      total_tokens: number(record.total_tokens) || input + output,
      input_tokens: input,
      cached_input_tokens: number(record.cached_input_tokens),
      output_tokens: output,
      reasoning_tokens: number(record.reasoning_tokens),
      context_tokens: input,
      active_agents: 1
    });
  }

  const points = [...byTurn.values()].sort((left, right) => left.action - right.action);
  const totals = points.reduce(
    (sum, point) => {
      sum.input_tokens += point.input_tokens;
      sum.cached_input_tokens += point.cached_input_tokens;
      sum.output_tokens += point.output_tokens;
      sum.reasoning_tokens += point.reasoning_tokens;
      sum.total_tokens += point.total_tokens;
      return sum;
    },
    { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0 }
  );

  return finishUsage({
    provider: "prime",
    points,
    totals,
    currentContext: points.at(-1)?.context_tokens,
    contextWindow: null,
    exact: true,
    agentsCurrent: 1,
    agentsTotal: 1
  });
}

function findFile(directory, predicate, depth = 0) {
  if (!directory || depth > 8 || !fs.existsSync(directory)) return "";

  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (_error) {
    return "";
  }

  for (const entry of entries) {
    if (entry.isFile() && predicate(entry.name)) return path.join(directory, entry.name);
  }

  for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
    if (!entry.isDirectory()) continue;
    const found = findFile(path.join(directory, entry.name), predicate, depth + 1);
    if (found) return found;
  }

  return "";
}

function findFiles(directory, predicate, depth = 0, results = []) {
  if (!directory || depth > 8 || !fs.existsSync(directory)) return results;

  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (_error) {
    return results;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && predicate(entry.name)) results.push(entryPath);
    else if (entry.isDirectory()) findFiles(entryPath, predicate, depth + 1, results);
  }

  return results;
}

function findCodexSessionFile(codexHome, conversationId) {
  if (!conversationId) return "";
  return findFile(
    path.join(codexHome || "", "sessions"),
    (name) => name.endsWith(".jsonl") && name.includes(conversationId)
  );
}

function findCodexSessionFiles(codexHome) {
  return findFiles(
    path.join(codexHome || "", "sessions"),
    (name) => name.endsWith(".jsonl")
  ).sort();
}

function findClaudeSessionFile(claudeHome, conversationId) {
  if (!conversationId) return "";
  return findFile(
    path.join(claudeHome || "", "projects"),
    (name) => name === `${conversationId}.jsonl`
  );
}

function findPrimeResultsFile(runDir) {
  return findFile(
    path.join(runDir, "eval-output"),
    (name) => name === "results.jsonl" || name === "traces.jsonl",
    0
  );
}

function findKimiWireFile(kimiHome) {
  return findFiles(
    path.join(kimiHome || "", "sessions"),
    (name) => name === "wire.jsonl"
  ).sort((left, right) => {
    let leftMtime = 0;
    let rightMtime = 0;
    try {
      leftMtime = fs.statSync(left).mtimeMs;
    } catch (_error) {
      /* unreadable candidates sort last */
    }
    try {
      rightMtime = fs.statSync(right).mtimeMs;
    } catch (_error) {
      /* unreadable candidates sort last */
    }
    return rightMtime - leftMtime || right.localeCompare(left);
  })[0] || "";
}

module.exports = {
  findClaudeSessionFile,
  findCodexSessionFile,
  findCodexSessionFiles,
  findKimiWireFile,
  findPrimeResultsFile,
  parseClaudeEvents,
  parseCodexEvents,
  parseCodexSession,
  parseCodexSwarmSessions,
  parseKimiWire,
  parsePrimeAgentEvents,
  parsePrimeLiveUsage,
  parsePrimeResults,
  withActionCostTimeline,
  withApiCostEstimate
};
