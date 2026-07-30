"""Claude Code harness with no built-in tools and strict MazeBench MCP only."""

from __future__ import annotations

import json

from verifiers.v1.clients import ModelContext
from verifiers.v1.harnesses.claude_code.harness import (
    CLAUDE_BIN,
    CLAUDE_CONFIG_DIR,
    ClaudeCodeHarness,
)
from verifiers.v1.runtimes import ProgramResult, Runtime
from verifiers.v1.trace import Trace


CLAUDE_RESTRICTED_BUILTIN_TOOLS = (
    "Agent",
    "Bash",
    "CronCreate",
    "CronDelete",
    "CronList",
    "CreateGoal",
    "DesignSync",
    "Edit",
    "EnterWorktree",
    "ExitWorktree",
    "Glob",
    "Grep",
    "GetGoal",
    "Monitor",
    "NotebookEdit",
    "PushNotification",
    "Read",
    "RemoteTrigger",
    "ReportFindings",
    "ScheduleWakeup",
    "SendMessage",
    "Skill",
    "SetGoalBudget",
    "Task",
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskOutput",
    "TaskStop",
    "TaskUpdate",
    "ToolSearch",
    "WebFetch",
    "WebSearch",
    "Workflow",
    "Write",
)


class MazeBenchClaudeCodeHarness(ClaudeCodeHarness):
    """Run Claude Code with built-ins disabled and only evaluator-owned MCP."""

    async def launch(
        self,
        ctx: ModelContext,
        trace: Trace,
        runtime: Runtime,
        endpoint: str,
        secret: str,
        mcp_urls: dict[str, str],
    ) -> ProgramResult:
        system_prompt, instruction = self.resolve_prompt(trace.task.data)
        if ctx.client.base_url == "https://api.pinference.ai/api/v1":
            ctx.client.base_url = ctx.client.base_url.removesuffix("/v1")
        env = {
            **self.config.resolved_env,
            "ANTHROPIC_BASE_URL": endpoint.removesuffix("/v1"),
            "ANTHROPIC_API_KEY": secret,
            "CLAUDE_CONFIG_DIR": CLAUDE_CONFIG_DIR,
            "DISABLE_AUTOUPDATER": "1",
            # A custom provider URL disables Claude's deferred tool search.
            # Load the small evaluator-owned MCP surface synchronously instead.
            "ENABLE_TOOL_SEARCH": "false",
            "IS_SANDBOX": "1",
            "MCP_CONNECTION_NONBLOCKING": "false",
            "MCP_TIMEOUT": "30000",
        }
        allowed_tools = ",".join(
            f"mcp__{name}__*" for name in sorted(mcp_urls)
        )
        argv = [
            CLAUDE_BIN.format(version=self.config.version),
            "--print",
            "--bare",
            "--disable-slash-commands",
            "--no-session-persistence",
            "--permission-mode",
            "dontAsk",
            # Claude's default registry must be enabled for dynamic MCP
            # discovery. Every built-in remains explicitly denied, while the
            # exact evaluator-owned MCP server is the only allowed namespace.
            "--tools",
            "default",
            "--allowedTools",
            allowed_tools,
            "--disallowedTools",
            ",".join(CLAUDE_RESTRICTED_BUILTIN_TOOLS),
            "--model",
            ctx.model,
        ]
        if system_prompt:
            argv += ["--append-system-prompt", system_prompt]
        mcp = {
            "mcpServers": {
                name: {"type": "http", "url": url, "alwaysLoad": True}
                for name, url in mcp_urls.items()
            }
        }
        mcp_path = f"{CLAUDE_CONFIG_DIR}/mcp.json"
        await runtime.write(mcp_path, json.dumps(mcp).encode())
        argv += [
            "--mcp-config",
            mcp_path,
            "--strict-mcp-config",
            "--",
            instruction or "",
        ]
        return await runtime.run_program(argv, env)


__all__ = ["MazeBenchClaudeCodeHarness"]
