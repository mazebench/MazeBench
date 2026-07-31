"""Trusted model relay exposing only MazeBench MCP tools."""

from __future__ import annotations

import asyncio
import base64
import json
import socket
from contextlib import AsyncExitStack
from typing import Literal
from urllib.parse import urlsplit

import httpx
from mazebench.mazebench import (
    VisionSession,
    run_blocking,
    valid_action_commands,
    write_live_actions,
)
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from openai import AsyncOpenAI
from pydantic import Field, model_validator
from verifiers.v1.clients import ModelContext
from verifiers.v1.dialects.chat import message_to_wire
from verifiers.v1.harness import Harness, HarnessConfig
from verifiers.v1.runtimes import ProgramResult, Runtime, SubprocessConfig
from verifiers.v1.runtimes.subprocess import SubprocessRuntime
from verifiers.v1.trace import Trace

GAME_TOOL_NAMES = {
    "game_start",
    "game_observe",
    "game_action",
    "game_action_sequence",
}
SERVER_TOOL_NAMES = {"start", "observe", "action", "action_sequence", "finalize"}
FINALIZATION_TIMEOUT_SECONDS = 10


class MazeBenchRelayHarnessConfig(HarnessConfig):
    """Configuration for the fixed evaluator-side model relay."""

    id: Literal["mazebench_codex_harness"] = "mazebench_codex_harness"
    runtime: SubprocessConfig = Field(default_factory=SubprocessConfig)

    @model_validator(mode="after")
    def validate_fixed_relay(self) -> MazeBenchRelayHarnessConfig:
        if self.env or self.forward_env or self.disabled_tools is not None:
            raise ValueError(
                "The MazeBench model relay does not accept runtime overrides."
            )
        return self


class MazeBenchCodexHarness(Harness[MazeBenchRelayHarnessConfig]):
    """Drive any configured model through four evaluator-owned game tools only."""

    APPENDS_SYSTEM_PROMPT = True
    SUPPORTS_MCP = True
    SUPPORTS_MESSAGE_PROMPT = True

    def __init__(self, config: MazeBenchRelayHarnessConfig) -> None:
        super().__init__(config)
        from mazebench_tools import _bind_game_only_harness

        _bind_game_only_harness(self)

    async def launch(
        self,
        ctx: ModelContext,
        trace: Trace,
        runtime: Runtime,
        endpoint: str,
        secret: str,
        mcp_urls: dict[str, str],
    ) -> ProgramResult:
        if type(runtime) is not SubprocessRuntime:
            raise RuntimeError(
                "The MazeBench model relay must run in the trusted evaluator."
            )
        endpoint_url = urlsplit(endpoint)
        local_endpoint = endpoint_url.scheme == "http" and endpoint_url.hostname in {
            "127.0.0.1",
            "localhost",
            "::1",
        }
        tunneled_endpoint = (
            endpoint_url.scheme == "https"
            and bool(endpoint_url.hostname)
            and endpoint_url.username is None
            and endpoint_url.password is None
        )
        if not local_endpoint and not tunneled_endpoint:
            raise RuntimeError(
                "The MazeBench model relay requires a local or framework HTTPS endpoint."
            )
        if set(mcp_urls) != {"game"}:
            raise RuntimeError(
                "The MazeBench model relay requires exactly one game tool server."
            )
        game_url = mcp_urls["game"]
        parsed_game_url = urlsplit(game_url)
        local_game_url = (
            parsed_game_url.scheme == "http"
            and parsed_game_url.hostname in {"127.0.0.1", "localhost", "::1"}
        )
        prime_tcp_game_url = (
            parsed_game_url.scheme == "http"
            and bool(parsed_game_url.hostname)
            and parsed_game_url.hostname.endswith(".l4.sandbox.pinfra.io")
            and parsed_game_url.port is not None
            and parsed_game_url.username is None
            and parsed_game_url.password is None
        )
        remote_game_url = prime_tcp_game_url or (
            parsed_game_url.scheme == "https"
            and bool(parsed_game_url.hostname)
            and parsed_game_url.username is None
            and parsed_game_url.password is None
        )
        if not local_game_url and not remote_game_url:
            raise RuntimeError(
                "The MazeBench game capability must use a local or Prime endpoint."
            )

        system_prompt, prompt = self.resolve_prompt(trace.task.data)
        messages: list[dict] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        if isinstance(prompt, str):
            messages.append({"role": "user", "content": prompt})
        elif prompt is not None:
            messages.extend(message_to_wire(message) for message in prompt)

        async with AsyncExitStack() as stack:
            game_finalized = False
            vision_session: VisionSession | None = None

            async def close_vision() -> None:
                nonlocal vision_session
                if vision_session is not None:
                    await run_blocking(vision_session.close)
                    vision_session = None

            stack.push_async_callback(close_vision)
            http_client = await stack.enter_async_context(
                httpx.AsyncClient(
                    timeout=httpx.Timeout(5.0, read=300.0),
                    follow_redirects=False,
                    trust_env=False,
                )
            )
            if remote_game_url:
                connection_deadline = asyncio.get_running_loop().time() + 90
                while True:
                    try:
                        await asyncio.to_thread(
                            socket.getaddrinfo,
                            parsed_game_url.hostname,
                            parsed_game_url.port or 443,
                        )
                        break
                    except socket.gaierror:
                        if asyncio.get_running_loop().time() >= connection_deadline:
                            raise
                        await asyncio.sleep(1)
            read, write, *_ = await stack.enter_async_context(
                streamable_http_client(game_url, http_client=http_client)
            )
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            finalization_deadline: float | None = None

            async def finalize_game() -> None:
                nonlocal game_finalized, finalization_deadline
                if game_finalized:
                    return
                if finalization_deadline is None:
                    finalization_deadline = (
                        asyncio.get_running_loop().time() + FINALIZATION_TIMEOUT_SECONDS
                    )
                async with asyncio.timeout_at(finalization_deadline):
                    finalized = await session.call_tool("finalize", {})
                    if finalized.isError:
                        raise RuntimeError(
                            "The MazeBench game sandbox did not finalize."
                        )
                write_live_actions(list(trace.state.maze_actions))
                game_finalized = True

            stack.push_async_callback(finalize_game)
            listed = (await session.list_tools()).tools
            listed_names = {tool.name for tool in listed}
            if listed_names != SERVER_TOOL_NAMES:
                raise RuntimeError(
                    "The MazeBench tool server exposed an unsafe tool set."
                )
            tools: list[dict] = []
            dispatch: dict[str, str] = {}
            for tool in listed:
                if tool.name == "finalize":
                    continue
                name = f"game_{tool.name}"
                tools.append(
                    {
                        "type": "function",
                        "function": {
                            "name": name,
                            "description": tool.description or "",
                            "parameters": tool.inputSchema,
                        },
                    }
                )
                dispatch[name] = tool.name
            if set(dispatch) != GAME_TOOL_NAMES:
                raise RuntimeError("The MazeBench model relay tool set is incomplete.")

            try:
                provider_http_client = await stack.enter_async_context(
                    httpx.AsyncClient(
                        timeout=httpx.Timeout(600.0),
                        follow_redirects=False,
                        trust_env=False,
                    )
                )
                async with AsyncOpenAI(
                    base_url=endpoint,
                    api_key=secret,
                    timeout=600.0,
                    http_client=provider_http_client,
                ) as client:
                    while True:
                        completion = await client.chat.completions.create(
                            model=ctx.model,
                            messages=messages,
                            tools=tools,
                        )
                        message = completion.choices[0].message
                        messages.append(message.model_dump(exclude_none=True))
                        if not message.tool_calls:
                            break
                        image_parts: list[dict] = []
                        for call in message.tool_calls:
                            name = call.function.name
                            try:
                                arguments = json.loads(call.function.arguments or "{}")
                            except json.JSONDecodeError as error:
                                content: str | list[dict] = (
                                    f"error: invalid JSON in tool arguments ({error})"
                                )
                            else:
                                if name not in dispatch:
                                    content = f"error: unknown tool {name!r}"
                                elif not isinstance(arguments, dict):
                                    content = (
                                        "error: tool arguments must be a JSON object"
                                    )
                                else:
                                    result = await session.call_tool(
                                        dispatch[name], arguments
                                    )
                                    write_live_actions(list(trace.state.maze_actions))
                                    text_parts: list[str] = []
                                    returned_image = False
                                    for block in result.content:
                                        if block.type == "text":
                                            text_parts.append(block.text)
                                        elif block.type == "image":
                                            returned_image = True
                                            image_parts.extend(
                                                [
                                                    {
                                                        "type": "text",
                                                        "text": f"Image returned by {name}:",
                                                    },
                                                    {
                                                        "type": "image_url",
                                                        "image_url": {
                                                            "url": f"data:{block.mimeType};base64,{block.data}"
                                                        },
                                                    },
                                                ]
                                            )
                                    if (
                                        not returned_image
                                        and getattr(
                                            trace.task.data,
                                            "observation_mode",
                                            "",
                                        )
                                        == "vision"
                                    ):
                                        if vision_session is None:
                                            vision_session = await run_blocking(
                                                VisionSession,
                                                task=trace.task.data,
                                            )
                                        frame = await run_blocking(
                                            vision_session.frame_for_actions,
                                            valid_action_commands(
                                                trace.state.maze_actions
                                            ),
                                        )
                                        prefix = "data:image/png;base64,"
                                        if not frame.startswith(prefix):
                                            raise RuntimeError(
                                                "MazeBench vision renderer did not return a PNG image"
                                            )
                                        encoded = frame[len(prefix) :]
                                        base64.b64decode(encoded, validate=True)
                                        image_parts.extend(
                                            [
                                                {
                                                    "type": "text",
                                                    "text": f"Image returned by {name}:",
                                                },
                                                {
                                                    "type": "image_url",
                                                    "image_url": {
                                                        "url": frame,
                                                    },
                                                },
                                            ]
                                        )
                                    content = "\n".join(text_parts) or (
                                        json.dumps(result.structuredContent)
                                        if result.structuredContent is not None
                                        else "Game tool returned no text."
                                    )
                            messages.append(
                                {
                                    "role": "tool",
                                    "tool_call_id": call.id,
                                    "content": content,
                                }
                            )
                        if image_parts:
                            messages.append(
                                {
                                    "role": "user",
                                    "content": image_parts,
                                }
                            )
            finally:
                await finalize_game()

        return ProgramResult(exit_code=0, stdout="", stderr="")


__all__ = ["MazeBenchCodexHarness", "MazeBenchRelayHarnessConfig"]
