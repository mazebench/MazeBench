from __future__ import annotations

import asyncio
import contextlib
import copy
import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import mazebench_harnesses.codex as relay_module
import mazebench_tools
import verifiers.v1.mcp.launch as mcp_launch
from mazebench_harnesses.codex import (
    MazeBenchCodexHarness,
    MazeBenchRelayHarnessConfig,
)
from mcp.types import CallToolResult, TextContent
from verifiers.v1.clients import ModelContext
from verifiers.v1.clients.eval import EvalClient
from verifiers.v1.env import EnvConfig, Environment
from verifiers.v1.runtimes import PrimeConfig, SubprocessConfig
from verifiers.v1.runtimes.subprocess import SubprocessRuntime
from verifiers.v1.types import Sampling

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_GAME_TOOLS = {
    "game_start",
    "game_observe",
    "game_action",
    "game_action_sequence",
}


class GameRuntimeIsolationTests(unittest.TestCase):
    def test_tool_server_uses_a_dedicated_prime_runtime(self) -> None:
        config = mazebench_tools.MazeBenchToolsetConfig()

        self.assertFalse(config.colocated)
        self.assertIsNone(config.url)
        self.assertIsInstance(config.runtime, PrimeConfig)
        self.assertEqual(config.runtime.image, "python:3.13-slim")
        self.assertEqual(config.runtime.workdir, "/app")
        self.assertEqual(config.runtime.region, "us")
        self.assertEqual(config.runtime.cpu, 1)
        self.assertEqual(config.runtime.memory, 2)
        self.assertEqual(config.runtime.disk, 5)
        self.assertIsNone(config.runtime.gpu)
        self.assertIsInstance(
            mcp_launch.make_runtime(config.runtime),
            mazebench_tools.MazeBenchPrimeRuntime,
        )

        source = (
            ROOT / "environments/mazebench/mazebench_tools/__init__.py"
        ).read_text()
        self.assertNotIn("DockerRuntime", source)
        self.assertNotIn("game_runtime:", source)
        self.assertNotIn("docker rm", source)

    def test_packaged_environment_bootstraps_without_a_verifiers_checkout(self) -> None:
        asyncio.run(self._verify_packaged_environment_bootstrap())

    def test_game_controls_run_directly_in_the_tool_server(self) -> None:
        asyncio.run(self._verify_direct_game_controls())

    def test_json_and_vision_modes_use_the_same_sandbox_tools(self) -> None:
        asyncio.run(self._verify_observation_modes())

    def test_model_relay_advertises_only_game_tools(self) -> None:
        asyncio.run(self._verify_model_relay())

    @unittest.skipUnless(
        os.environ.get("MAZEBENCH_REAL_PRIME") == "1",
        "set MAZEBENCH_REAL_PRIME=1 for a live Prime Sandbox smoke",
    )
    def test_real_prime_sandbox_tool_server(self) -> None:
        asyncio.run(self._verify_model_relay(real_prime=True))

    def test_model_relay_accepts_prime_https_and_preserves_vision_role(self) -> None:
        asyncio.run(self._verify_vision_message_roles())

    def test_tool_server_requires_rollout_binding(self) -> None:
        taskset = mazebench_tools.MazeBenchToolTaskset(
            mazebench_tools.MazeBenchToolConfig(
                num_examples=1,
                start_level_id="level_HxI",
            )
        )
        MazeBenchCodexHarness(MazeBenchRelayHarnessConfig())
        task = taskset.load()[0]
        with self.assertRaisesRegex(RuntimeError, "active rollout binding"):
            task.tool_servers()

    async def _bound_task(
        self,
        *,
        max_actions: int = 2,
        observation_mode: str = "ascii",
    ):
        taskset = mazebench_tools.MazeBenchToolTaskset(
            mazebench_tools.MazeBenchToolConfig(
                num_examples=1,
                start_level_id="level_HxI",
                max_actions=max_actions,
                observation_mode=observation_mode,
            )
        )
        harness = MazeBenchCodexHarness(MazeBenchRelayHarnessConfig())
        task = taskset.load()[0]
        await task.setup(
            SimpleNamespace(
                id=f"test-{id(task)}",
                agent=SimpleNamespace(harness=harness.config),
            ),
            SubprocessRuntime(SubprocessConfig(), name="trusted-relay-test"),
        )
        return taskset, harness, task

    async def _verify_packaged_environment_bootstrap(self) -> None:
        _taskset, _harness, task = await self._bound_task()
        toolset = task.tool_servers()[0]

        class Runtime:
            type = "prime"

            def __init__(self) -> None:
                self.writes: dict[str, bytes] = {}
                self.command = ""

            async def write(self, path: str, value: bytes) -> None:
                self.writes[path] = value

            async def run(self, argv: list[str], env: dict[str, str]):
                del env
                self.command = " ".join(argv)
                return SimpleNamespace(exit_code=0, stdout="", stderr="")

        runtime = Runtime()
        python = await mazebench_tools._install_mazebench_in_sandbox(toolset, runtime)

        self.assertEqual(python, "/tmp/vf-venv/bin/python")
        self.assertEqual(list(runtime.writes), ["/tmp/vf-src/mazebench.tar.gz"])
        self.assertIn("uv pip install", runtime.command)
        self.assertIn("/tmp/vf-src/mazebench", runtime.command)
        self.assertIs(
            mcp_launch._install_in_sandbox,
            mazebench_tools._install_mazebench_in_sandbox,
        )

    async def _verify_direct_game_controls(self) -> None:
        _taskset, _harness, task = await self._bound_task()
        toolset = task.tool_servers()[0]
        try:
            await toolset.setup_task(task.data)
            started = await toolset.start()
            moved = await toolset.action("up")
            finalized = await toolset.finalize()

            self.assertEqual(started["observation"]["observation_mode"], "ascii")
            self.assertEqual(moved["actions_used"], 1)
            self.assertEqual(finalized, {"finalized": True})
            self.assertEqual(len(toolset.state.maze_actions), 1)
            self.assertTrue(toolset.state.maze_scorecard)
            self.assertTrue(toolset._state_path.is_file())
            self.assertFalse(toolset._state_path.is_relative_to(ROOT))
            self.assertNotIn(str(ROOT), json.dumps(started))
        finally:
            await toolset._exit_stack.aclose()

    async def _verify_observation_modes(self) -> None:
        for mode in ("json", "vision"):
            _taskset, _harness, task = await self._bound_task(observation_mode=mode)
            toolset = task.tool_servers()[0]
            try:
                await toolset.setup_task(task.data)
                observation = (await toolset.start())["observation"]
                self.assertEqual(observation["observation_mode"], mode)
                if mode == "json":
                    self.assertIn("json_observation", observation)
                    self.assertNotIn("level", observation)
                else:
                    self.assertNotIn("json_observation", observation)
                    self.assertNotIn("level", observation)
                await toolset.finalize()
            finally:
                await toolset._exit_stack.aclose()

    async def _verify_model_relay(self, *, real_prime: bool = False) -> None:
        requests: list[dict] = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                requests.append(body)
                index = len(requests)
                if index == 1:
                    message = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "unsafe-call",
                                "type": "function",
                                "function": {
                                    "name": "read_file",
                                    "arguments": json.dumps(
                                        {"path": str(ROOT / "package.json")}
                                    ),
                                },
                            }
                        ],
                    }
                elif index == 2:
                    message = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "game-call",
                                "type": "function",
                                "function": {
                                    "name": "game_start",
                                    "arguments": "{}",
                                },
                            }
                        ],
                    }
                else:
                    message = {"role": "assistant", "content": "done"}
                payload = {
                    "id": f"fake-{index}",
                    "object": "chat.completion",
                    "created": 0,
                    "model": "fake-model",
                    "choices": [
                        {
                            "index": 0,
                            "message": message,
                            "finish_reason": (
                                "tool_calls" if message.get("tool_calls") else "stop"
                            ),
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 1,
                        "completion_tokens": 1,
                        "total_tokens": 2,
                    },
                }
                encoded = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, format: str, *args) -> None:
                del format, args

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        client = EvalClient(
            f"http://127.0.0.1:{server.server_port}/v1", "fake-provider-key"
        )

        def local_tool_runtime(_config):
            return SubprocessRuntime(SubprocessConfig(), name="game-tool-sandbox-test")

        try:
            environment = Environment(
                EnvConfig(
                    taskset=mazebench_tools.MazeBenchToolConfig(
                        num_examples=1,
                        start_level_id="level_HxI",
                        max_actions=1,
                    ),
                    harness=MazeBenchRelayHarnessConfig(),
                    max_turns=4,
                )
            )
            task = environment.taskset.select(1)[0]
            runtime_patch = (
                contextlib.nullcontext()
                if real_prime
                else patch.object(
                    mcp_launch,
                    "make_runtime",
                    side_effect=local_tool_runtime,
                )
            )
            tunnel_patch = (
                contextlib.nullcontext()
                if real_prime
                else patch.object(environment, "_requires_tunnel", return_value=False)
            )
            with runtime_patch, tunnel_patch:
                async with environment.serving():
                    traces = await environment.episode(
                        task,
                        ModelContext(
                            model="fake-model",
                            client=client,
                            sampling=Sampling(),
                        ),
                    ).run()

            self.assertEqual(len(traces), 1)
            self.assertIsNone(traces[0].error)
            self.assertTrue(traces[0].state.maze_scorecard)
            self.assertEqual(len(requests), 3)
            for request in requests:
                names = {
                    tool["function"]["name"] for tool in request.get("tools") or []
                }
                self.assertEqual(names, EXPECTED_GAME_TOOLS)
            self.assertNotIn(str(ROOT), json.dumps(requests[0]))
            self.assertIn(
                "unknown tool 'read_file'", requests[1]["messages"][-1]["content"]
            )
        finally:
            await client.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    async def _verify_vision_message_roles(self) -> None:
        requests: list[dict] = []
        session_calls: list[str] = []

        class AsyncContext:
            def __init__(self, value):
                self.value = value

            async def __aenter__(self):
                return self.value

            async def __aexit__(self, exc_type, exc, traceback):
                del exc_type, exc, traceback
                return False

        class FakeSession:
            async def initialize(self):
                return None

            async def list_tools(self):
                return SimpleNamespace(
                    tools=[
                        SimpleNamespace(
                            name=name,
                            description="",
                            inputSchema={"type": "object"},
                        )
                        for name in (
                            "start",
                            "observe",
                            "action",
                            "action_sequence",
                            "finalize",
                        )
                    ]
                )

            async def call_tool(self, name, arguments):
                del arguments
                session_calls.append(name)
                if name == "finalize":
                    return CallToolResult(
                        content=[TextContent(type="text", text='{"finalized":true}')],
                        structuredContent={"finalized": True},
                        isError=False,
                    )
                return CallToolResult(
                    content=[
                        TextContent(type="text", text='{"observation":"attached"}'),
                    ],
                    structuredContent={"observation": "attached"},
                    isError=False,
                )

        tool_call = SimpleNamespace(
            id="vision-call",
            function=SimpleNamespace(name="game_start", arguments="{}"),
        )
        tool_message = SimpleNamespace(
            tool_calls=[tool_call],
            model_dump=lambda **_kwargs: {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "vision-call",
                        "type": "function",
                        "function": {"name": "game_start", "arguments": "{}"},
                    }
                ],
            },
        )
        final_message = SimpleNamespace(
            tool_calls=None,
            model_dump=lambda **_kwargs: {"role": "assistant", "content": "done"},
        )

        class FakeCompletions:
            async def create(self, **kwargs):
                requests.append(copy.deepcopy(kwargs))
                message = tool_message if len(requests) == 1 else final_message
                return SimpleNamespace(choices=[SimpleNamespace(message=message)])

        fake_openai = SimpleNamespace(
            chat=SimpleNamespace(completions=FakeCompletions())
        )

        class FakeVisionSession:
            def __init__(self, *, task):
                del task

            def frame_for_actions(self, actions):
                del actions
                return "data:image/png;base64,aGVsbG8="

            def close(self):
                return None

        _taskset, harness, task = await self._bound_task(observation_mode="vision")
        trace = SimpleNamespace(
            id="vision-relay",
            task=task,
            state=mazebench_tools.MazeBenchToolTraceState(),
        )
        runtime = SubprocessRuntime(SubprocessConfig(), name="relay-vision-test")

        with (
            patch.object(
                relay_module,
                "streamable_http_client",
                return_value=AsyncContext((object(), object())),
            ),
            patch.object(
                relay_module,
                "ClientSession",
                return_value=AsyncContext(FakeSession()),
            ),
            patch.object(
                relay_module,
                "AsyncOpenAI",
                return_value=AsyncContext(fake_openai),
            ),
            patch.object(
                relay_module,
                "VisionSession",
                FakeVisionSession,
            ),
            patch.object(harness, "resolve_prompt", return_value=("system", "prompt")),
            patch.dict(os.environ, {"MAZEBENCH_LIVE_ACTIONS_PATH": ""}),
        ):
            result = await harness.launch(
                SimpleNamespace(model="fake-model"),
                trace,
                runtime,
                "http://127.0.0.1/v1",
                "secret",
                {"game": "https://localhost/mcp"},
            )

        self.assertEqual(result.exit_code, 0)
        self.assertEqual(session_calls, ["start", "finalize"])
        self.assertEqual(len(requests), 2)
        messages = requests[1]["messages"]
        self.assertEqual(messages[-2]["role"], "tool")
        self.assertNotIn("image_url", messages[-2]["content"])
        self.assertEqual(messages[-1]["role"], "user")
        self.assertTrue(
            any(
                part.get("image_url", {}).get("url") == "data:image/png;base64,aGVsbG8="
                for part in messages[-1]["content"]
            )
        )


if __name__ == "__main__":
    unittest.main()
