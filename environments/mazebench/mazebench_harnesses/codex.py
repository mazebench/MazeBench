"""Codex harness with isolated Streamable HTTP MCP configuration."""

from __future__ import annotations

import base64
import json
import logging
import os
import re

from verifiers.v1.clients import ModelContext
from verifiers.v1.harnesses.codex.harness import (
    CODEX_BIN,
    KEY_VAR,
    PROVIDER,
    CodexHarness,
)
from verifiers.v1.runtimes import ProgramResult, Runtime
from verifiers.v1.trace import Trace
from verifiers.v1.types import TextContentPart

logger = logging.getLogger(__name__)

GAME_ONLY_DISABLED_FEATURES = (
    "apps",
    "browser_use",
    "computer_use",
    "goals",
    "image_generation",
    "in_app_browser",
    "memories",
    "multi_agent",
    "plugins",
    "remote_plugin",
    "shell_tool",
    "standalone_web_search",
    "tool_search",
    "tool_suggest",
    "workspace_dependencies",
)


def _python_tools_enabled() -> bool:
    return os.environ.get("MAZEBENCH_PRIME_TOOL_USE", "").strip().lower() == "offline"


def _direct_mcp_model_catalog(model: str) -> bytes:
    return json.dumps(
        {
            "models": [
                {
                    "slug": model,
                    "display_name": model,
                    "description": "MazeBench game-only Codex runtime",
                    "supported_reasoning_levels": [],
                    "shell_type": "shell_command",
                    "visibility": "list",
                    "supported_in_api": True,
                    "priority": 1,
                    "availability_nux": None,
                    "upgrade": None,
                    "base_instructions": (
                        "You are Codex. Follow the user's instructions and use only the "
                        "supplied game tools."
                    ),
                    "supports_reasoning_summaries": False,
                    "support_verbosity": False,
                    "default_verbosity": None,
                    "apply_patch_tool_type": None,
                    "truncation_policy": {"mode": "bytes", "limit": 10_000},
                    "supports_parallel_tool_calls": False,
                    "experimental_supported_tools": [],
                    "supports_search_tool": False,
                }
            ]
        }
    ).encode()


class MazeBenchCodexHarness(CodexHarness):
    SUPPORTS_MCP = True

    async def launch(
        self,
        ctx: ModelContext,
        trace: Trace,
        runtime: Runtime,
        endpoint: str,
        secret: str,
        mcp_urls: dict[str, str],
    ) -> ProgramResult:
        task = trace.task.data
        system_prompt, prompt = self.resolve_prompt(task)
        image_args: list[str] = []
        image_dir = f".vf-codex-images-{trace.id}"
        if prompt is not None and not isinstance(prompt, str):
            texts = [system_prompt] if system_prompt else []
            image_index = 0
            for message in prompt:
                role = str(message.role)
                parts = (
                    [TextContentPart(text=message.content)]
                    if isinstance(message.content, str)
                    else message.content
                )
                message_text: list[str] = []
                for part in parts:
                    if isinstance(part, TextContentPart):
                        message_text.append(part.text)
                        continue
                    image = getattr(part, "image_url", None)
                    if image is None:
                        message_text.append(str(part))
                        continue
                    metadata, separator, encoded = image.url.partition(",")
                    media_type, *parameters = metadata.removeprefix("data:").split(";")
                    if (
                        not separator
                        or not metadata.startswith("data:image/")
                        or not any(p.lower() == "base64" for p in parameters)
                    ):
                        raise ValueError(
                            "codex image prompts require base64 data:image URLs"
                        )
                    extension = re.sub(
                        r"[^a-zA-Z0-9]+", "_", media_type.removeprefix("image/")
                    ).strip("_")
                    path = f"{image_dir}/image_{image_index}.{extension or 'image'}"
                    await runtime.write(path, base64.b64decode(encoded))
                    image_args += ["-i", path]
                    image_index += 1
                if message_text:
                    texts.append(f"[{role}]\n" + "\n".join(message_text))
            prompt = "\n\n".join(texts)
        elif system_prompt:
            prompt = "\n\n".join(part for part in (system_prompt, prompt) if part)

        env = {**self.config.resolved_env, KEY_VAR: secret}
        tool_names = ["start", "observe", "action", "action_sequence"]
        if _python_tools_enabled():
            tool_names.append("python_exec")
        allowed_tools = [
            f"mcp__{name}__{tool}"
            for name in mcp_urls
            for tool in tool_names
        ]
        guard_path = f".vf-codex-game-only-{trace.id}.js"
        model_catalog_path = f".vf-codex-models-{trace.id}.json"
        guard_source = f"""const allowed = new Set({json.dumps(allowed_tools)});
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {{ input += chunk; }});
process.stdin.on("end", () => {{
  let event = {{}};
  try {{ event = JSON.parse(input); }} catch (_error) {{
    process.stderr.write("Game-only mode rejected an unreadable tool request.\\n");
    process.exitCode = 2;
    return;
  }}
  if (!allowed.has(String(event.tool_name || ""))) {{
    process.stderr.write("External tools are disabled; use only the approved MazeBench controls.\\n");
    process.exitCode = 2;
  }}
}});
"""
        await runtime.write(guard_path, guard_source.encode())
        await runtime.write(model_catalog_path, _direct_mcp_model_catalog(ctx.model))
        guard_command = json.dumps(f"node {guard_path}")
        tool_config = [
            arg
            for tool in self.config.disabled_tools or []
            for arg in ("--disable", tool)
        ]
        restricted_features = [
            arg
            for feature in GAME_ONLY_DISABLED_FEATURES
            for arg in ("--disable", feature)
        ]
        mcp_config: list[str] = []
        for name, url in mcp_urls.items():
            prefix = f"mcp_servers.{name}"
            mcp_config += [
                "-c",
                f"{prefix}.url={json.dumps(url)}",
                "-c",
                f"{prefix}.required=true",
                "-c",
                f"{prefix}.startup_timeout_sec=30",
                "-c",
                f"{prefix}.tool_timeout_sec=120",
                "-c",
                f"{prefix}.default_tools_approval_mode=auto",
                "-c",
                f"{prefix}.enabled_tools={json.dumps(tool_names)}",
            ]
        argv = [
            CODEX_BIN,
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--dangerously-bypass-approvals-and-sandbox",
            "--dangerously-bypass-hook-trust",
            "--skip-git-repo-check",
            "-c",
            'web_search="disabled"',
            "-c",
            "tools.web_search=false",
            "-c",
            f"model_catalog_json={json.dumps(model_catalog_path)}",
            "-c",
            f'hooks.PreToolUse=[{{ matcher=".*", hooks=[{{ type="command", command={guard_command}, timeout=5, statusMessage="Enforcing game-only mode" }}] }}]',
            *restricted_features,
            "-c",
            f"features.multi_agent_v2.enabled={str(self.config.multi_agent).lower()}",
            "-m",
            ctx.model,
            "-c",
            f"model_provider={PROVIDER}",
            "-c",
            f"model_providers.{PROVIDER}.name={PROVIDER}",
            "-c",
            f"model_providers.{PROVIDER}.base_url={endpoint}",
            "-c",
            f"model_providers.{PROVIDER}.env_key={KEY_VAR}",
            "-c",
            f"model_providers.{PROVIDER}.wire_api=responses",
            "-c",
            f"model_providers.{PROVIDER}.requires_openai_auth=false",
            *mcp_config,
            *tool_config,
            *image_args,
            "--",
            prompt or "",
        ]
        try:
            return await runtime.run_program(argv, env)
        finally:
            try:
                await runtime.run(["rm", "-f", guard_path, model_catalog_path], {})
            except Exception:
                logger.warning("failed to clean up Codex tool guard", exc_info=True)
            if image_args:
                try:
                    await runtime.run(["rm", "-rf", image_dir], {})
                except Exception:
                    logger.warning(
                        "failed to clean up Codex prompt images", exc_info=True
                    )


__all__ = ["MazeBenchCodexHarness"]
