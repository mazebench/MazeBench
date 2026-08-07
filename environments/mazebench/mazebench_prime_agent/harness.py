"""Run Prime Agent with IPython and only the isolated MazeBench MCP boundary."""

from __future__ import annotations

import base64
import json
import logging
import re
import shlex

from verifiers.v1.clients import ModelContext
from verifiers.v1.configs.harness import HarnessConfig
from verifiers.v1.harness import Harness
from verifiers.v1.runtimes import ProgramResult, Runtime
from verifiers.v1.task import TaskData
from verifiers.v1.trace import Trace
from verifiers.v1.types import TextContentPart

logger = logging.getLogger(__name__)

PRIME_AGENT_BIN = "/usr/local/bin/prime-agent"
PRIME_AGENT_ROOT = "/tmp/vf-prime-agent"
PRIME_AGENT_KERNEL_VENV = f"{PRIME_AGENT_ROOT}/kernel-venv"
INTERCEPT_PROVIDER = "mazebench-intercept"
INTERCEPT_KEY_VAR = "MAZEBENCH_INTERCEPT_KEY"
MCP_TOKEN_VAR = "MAZEBENCH_MCP_TOKEN"

INSTALL = r"""
set -eu
mkdir -p {root}
command -v curl >/dev/null 2>&1 || {{ apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null; }}
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh -o {root}/install.sh
env \
  PRIME_AGENT_INSTALLER_PLAIN=1 \
  PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=1 \
  PRIME_AGENT_KERNEL_VENV={kernel_venv} \
  PRIME_AGENT_CODING_AGENT_DIR={root}/bootstrap \
  sh {root}/install.sh {version}
"""

SKILL_MD = """---
name: mazebench
description: Required isolated MazeBench game controls. Use this Python skill for every game observation and action.
---

# MazeBench

The `mazebench` Python module is already imported in IPython. It is the only
interface to the game. Start exactly once, then inspect every returned result:

```python
state = await mazebench.start()
state = await mazebench.up()
state = await mazebench.observe()
```

Available methods are discovered from the evaluator-owned server. Use
`await mazebench.list_tools()` to inspect their schemas. Named movement methods
take no arguments. `go_to_level(x="A", y="B")` and
`action_sequence(actions=[...])` take the arguments documented by the server.
Never inspect the filesystem or network for game state; only this module's
returned values and displayed game image are authoritative.
"""

SKILL_PYPROJECT = """[project]
name = "mazebench-prime-agent-skill"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = ["mcp", "httpx", "prime-agent-runtime"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/mazebench"]
"""

SKILL_MODULE = r'''"""Prime Agent Python skill for the isolated MazeBench MCP server."""

from __future__ import annotations

import base64
import os
from contextlib import AsyncExitStack

from IPython.display import Image, display
from rlm import McpIntegration, McpToolError


class MazeBench(McpIntegration):
    server = "mazebench"
    url = os.environ["MAZEBENCH_MCP_URL"]
    bearer_token_env = "MAZEBENCH_MCP_TOKEN"

    async def call_tool(self, tool, arguments=None):
        async with AsyncExitStack() as stack:
            session = await self._open_session(stack)
            result = await session.call_tool(tool, arguments or {})

        texts = []
        other = []
        for block in getattr(result, "content", None) or []:
            kind = getattr(block, "type", "")
            if kind == "image" and getattr(block, "data", None):
                display(Image(data=base64.b64decode(block.data)))
            elif getattr(block, "text", None) is not None:
                texts.append(block.text)
            else:
                other.append(block.model_dump(mode="json") if hasattr(block, "model_dump") else block)

        if getattr(result, "isError", False):
            raise McpToolError("\n".join(texts) or "MazeBench tool returned an error")
        structured = getattr(result, "structuredContent", None)
        if structured is not None:
            return structured
        if texts:
            return "\n".join(texts)
        return other or result


mazebench = MazeBench()
_RESERVED = {"run", "__wrapped__", "__call__"}


def __getattr__(name):
    if name.startswith("_") or name in _RESERVED:
        raise AttributeError(name)
    return getattr(mazebench, name)
'''


class MazeBenchPrimeAgentHarnessConfig(HarnessConfig):
    version: str = "0.7.0"
    """Prime Agent stable release, pinned for benchmark reproducibility."""


class MazeBenchPrimeAgentHarness(Harness[MazeBenchPrimeAgentHarnessConfig]):
    """Prime Agent v0.7 with persistent IPython and isolated MazeBench MCP controls."""

    APPENDS_SYSTEM_PROMPT = True
    SUPPORTS_MCP = True

    async def setup(self, runtime: Runtime) -> None:
        logger.info("prime-agent: ensuring stable release %s is installed", self.config.version)
        script = (
            INSTALL.replace("{root}", PRIME_AGENT_ROOT)
            .replace("{kernel_venv}", PRIME_AGENT_KERNEL_VENV)
            .replace("{version}", self.config.version)
        )
        ensure = shlex.quote(
            f'[ -x {PRIME_AGENT_BIN} ] && '
            f'{PRIME_AGENT_BIN} --version 2>/dev/null | grep -Fq {shlex.quote(self.config.version)} '
            f'|| ({script})'
        )
        guarded = (
            f"mkdir -p {PRIME_AGENT_ROOT} && "
            f"flock {PRIME_AGENT_ROOT}/install.lock sh -c {ensure}"
        )
        result = await runtime.run(["sh", "-c", guarded], {})
        if result.exit_code != 0:
            detail = (result.stderr or result.stdout).strip()[-2_000:]
            raise RuntimeError(f"Prime Agent install failed: {detail}")

    async def launch(
        self,
        ctx: ModelContext,
        trace: Trace,
        runtime: Runtime,
        endpoint: str,
        secret: str,
        mcp_urls: dict[str, str],
        data: TaskData,
    ) -> ProgramResult:
        if set(mcp_urls) != {"mazebench"}:
            raise RuntimeError(
                "Prime Agent requires exactly one isolated MCP server named 'mazebench'."
            )
        system_prompt, prompt = self.resolve_prompt(data)
        if prompt is None:
            prompt = ""

        config_dir = f"{PRIME_AGENT_ROOT}/config-{trace.id}"
        workspace = f"/app/mazebench-agent/{trace.id}"
        skill_dir = f"{config_dir}/skills/mazebench"
        image_dir = f"{workspace}/prompt-images"
        created = await runtime.run(
            ["mkdir", "-p", workspace, skill_dir, image_dir], {}
        )
        if created.exit_code != 0:
            raise RuntimeError(
                f"Prime Agent workspace setup failed: {created.stderr.strip()[-500:]}"
            )

        await runtime.write(f"{skill_dir}/SKILL.md", SKILL_MD.encode())
        await runtime.write(f"{skill_dir}/pyproject.toml", SKILL_PYPROJECT.encode())
        await runtime.write(
            f"{skill_dir}/src/mazebench/__init__.py", SKILL_MODULE.encode()
        )

        models = {
            "providers": {
                INTERCEPT_PROVIDER: {
                    "baseUrl": endpoint,
                    "api": "openai-responses",
                    "apiKey": INTERCEPT_KEY_VAR,
                    "authHeader": True,
                    "compat": {"supportsStore": False},
                    "models": [
                        {
                            "id": ctx.model,
                            "name": ctx.model,
                            "reasoning": True,
                            "input": ["text", "image"],
                            "contextWindow": 256_000,
                            "maxTokens": 64_000,
                        }
                    ],
                }
            }
        }
        settings = {
            "enableBuiltinSkills": False,
            "mcpServers": {
                "mazebench": {
                    "type": "http",
                    "url": mcp_urls["mazebench"],
                    "bearerTokenEnvVar": MCP_TOKEN_VAR,
                }
            },
        }
        await runtime.write(
            f"{config_dir}/models.json", json.dumps(models).encode()
        )
        await runtime.write(
            f"{config_dir}/settings.json", json.dumps(settings).encode()
        )

        text, image_args = await self._prompt(runtime, prompt, image_dir)
        bridge = (
            "The game controls named in the task are methods on the auto-imported "
            "`mazebench` Python skill. Call them only from the built-in IPython tool, "
            "for example `state = await mazebench.start()` and then "
            "`state = await mazebench.up()`."
        )
        argv = [
            PRIME_AGENT_BIN,
            "--print",
            "--offline",
            "--no-session",
            "--tools",
            "ipython",
            "--no-extensions",
            "--no-skills",
            "--skill",
            skill_dir,
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--cwd",
            workspace,
            "--provider",
            INTERCEPT_PROVIDER,
            "--model",
            f"{INTERCEPT_PROVIDER}/{ctx.model}",
        ]
        if system_prompt:
            argv += ["--append-system-prompt", system_prompt]
        argv += [*image_args, "--", f"{bridge}\n\n{text}"]
        env = {
            **self.config.resolved_env,
            INTERCEPT_KEY_VAR: secret,
            MCP_TOKEN_VAR: "mazebench-run",
            "MAZEBENCH_MCP_URL": mcp_urls["mazebench"],
            "PRIME_AGENT_CODING_AGENT_DIR": config_dir,
            "PRIME_AGENT_KERNEL_VENV": PRIME_AGENT_KERNEL_VENV,
            "PRIME_AGENT_SESSION_DIR": f"{config_dir}/sessions",
            "PI_OFFLINE": "1",
            "NO_COLOR": "1",
        }
        return await runtime.run_program(argv, env)

    @staticmethod
    async def _prompt(
        runtime: Runtime, prompt: str | list, image_dir: str
    ) -> tuple[str, list[str]]:
        if isinstance(prompt, str):
            return prompt, []
        texts: list[str] = []
        image_args: list[str] = []
        image_index = 0
        for message in prompt:
            if message.role not in ("system", "user"):
                raise ValueError(
                    "Prime Agent opening prompts support only system and user messages."
                )
            parts = (
                [TextContentPart(text=message.content)]
                if isinstance(message.content, str)
                else message.content
            )
            for part in parts:
                if isinstance(part, TextContentPart):
                    texts.append(part.text)
                    continue
                metadata, separator, encoded = part.image_url.url.partition(",")
                media_type, *parameters = metadata.removeprefix("data:").split(";")
                if (
                    not separator
                    or not metadata.startswith("data:image/")
                    or not any(value.lower() == "base64" for value in parameters)
                ):
                    raise ValueError(
                        "Prime Agent image prompts require base64 data:image URLs."
                    )
                extension = re.sub(
                    r"[^a-zA-Z0-9]+", "_", media_type.removeprefix("image/")
                ).strip("_")
                target = f"{image_dir}/image_{image_index}.{extension or 'image'}"
                await runtime.write(target, base64.b64decode(encoded))
                image_args.append(f"@{target}")
                image_index += 1
        return "\n\n".join(texts), image_args
