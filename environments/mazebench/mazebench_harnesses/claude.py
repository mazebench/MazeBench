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
            "IS_SANDBOX": "1",
        }
        argv = [
            CLAUDE_BIN.format(version=self.config.version),
            "--print",
            "--bare",
            "--disable-slash-commands",
            "--dangerously-skip-permissions",
            "--no-session-persistence",
            # An empty --tools value removes every built-in tool. The explicit
            # strict MCP file below remains available to the evaluated model.
            "--tools",
            "",
            "--model",
            ctx.model,
        ]
        if system_prompt:
            argv += ["--append-system-prompt", system_prompt]
        mcp = {
            "mcpServers": {
                name: {"type": "http", "url": url} for name, url in mcp_urls.items()
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
