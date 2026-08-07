from __future__ import annotations

import asyncio
import contextlib
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import mazebench_tools
from mazebench.mazebench import resolve_default_node_bin
import verifiers.v1.mcp.launch as mcp_launch
import verifiers.v1.rollout as rollout_module
from mcp.types import CallToolResult, ImageContent
from verifiers.v1.clients import ModelContext
from verifiers.v1.clients.eval import EvalClient
from verifiers.v1.configs.agent import AgentConfig
from verifiers.v1.decorators import discover_decorated
from verifiers.v1.envs.single_agent import SingleAgentEnv, SingleAgentEnvConfig
from verifiers.v1.harness import HarnessConfig
from verifiers.v1.runtimes import PrimeConfig, SubprocessConfig
from verifiers.v1.runtimes.subprocess import SubprocessRuntime
from verifiers.v1.types import Sampling

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_GAME_TOOLS = {
    "start",
    "observe",
    "up",
    "down",
    "left",
    "right",
    "rotate_camera_up",
    "rotate_camera_down",
    "rotate_camera_left",
    "rotate_camera_right",
    "undo",
    "reset",
    "go_to_level",
    "quit",
    "action_sequence",
}
EXPECTED_FRAMEWORK_GAME_TOOLS = {
    f"mazebench_{name}" for name in EXPECTED_GAME_TOOLS
}


class GameRuntimeIsolationTests(unittest.TestCase):
    def test_default_node_uses_the_packaged_python_sibling(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            bin_dir = Path(temporary_dir) / "bin"
            bin_dir.mkdir()
            python = bin_dir / "python"
            node = bin_dir / "node"
            node.touch()

            self.assertEqual(resolve_default_node_bin(python), str(node))

            node.unlink()
            self.assertEqual(resolve_default_node_bin(python), "node")

    def test_tool_server_uses_a_dedicated_prime_runtime(self) -> None:
        config = mazebench_tools.MazeBenchToolsetConfig()

        self.assertFalse(config.colocated)
        self.assertIsNone(config.url)
        self.assertIsInstance(config.runtime, PrimeConfig)
        self.assertEqual(
            config.runtime.image,
            "prime/mazebench/mazebench-tool-runtime:py313-codex-0.144.5-vf-b3b8f51-v3",
        )
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

    def test_taskset_uses_framework_harnesses(self) -> None:
        environment = SingleAgentEnv(
            SingleAgentEnvConfig(
                taskset=mazebench_tools.MazeBenchToolConfig(num_examples=1),
                agent=AgentConfig(
                    harness=HarnessConfig(id="null"),
                    runtime=PrimeConfig(image="python:3.13-slim"),
                ),
            )
        )

        harness = environment._harnesses["agent"]
        self.assertEqual(harness.config.id, "null")
        self.assertTrue(harness.SUPPORTS_MCP)
        self.assertTrue(mazebench_tools.MazeBenchToolTask.NEEDS_CONTAINER)
        self.assertFalse(
            (ROOT / "environments/mazebench/mazebench_harnesses/codex.py").exists()
        )

    def test_packaged_environment_bootstraps_without_a_verifiers_checkout(self) -> None:
        asyncio.run(self._verify_packaged_environment_bootstrap())

    def test_game_controls_run_directly_in_the_tool_server(self) -> None:
        asyncio.run(self._verify_direct_game_controls())

    def test_json_and_vision_modes_use_the_same_sandbox_tools(self) -> None:
        asyncio.run(self._verify_observation_modes())

    def test_framework_harness_advertises_only_game_tools(self) -> None:
        asyncio.run(self._verify_framework_harness())

    @unittest.skipUnless(
        os.environ.get("MAZEBENCH_REAL_PRIME") == "1",
        "set MAZEBENCH_REAL_PRIME=1 for a live Prime Sandbox smoke",
    )
    def test_real_prime_sandbox_tool_server(self) -> None:
        asyncio.run(self._verify_framework_harness(real_prime=True))

    @unittest.skipUnless(
        os.environ.get("MAZEBENCH_REAL_PRIME") == "1",
        "set MAZEBENCH_REAL_PRIME=1 for a live Prime Sandbox smoke",
    )
    def test_real_prime_sandbox_vision_tool_server(self) -> None:
        asyncio.run(
            self._verify_framework_harness(
                real_prime=True,
                observation_mode="vision",
            )
        )

    def test_tool_server_requires_rollout_binding(self) -> None:
        taskset = mazebench_tools.MazeBenchToolTaskset(
            mazebench_tools.MazeBenchToolConfig(
                num_examples=1,
                start_level_id="level_HxI",
            )
        )
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
        task = taskset.load()[0]
        await task.setup(SimpleNamespace(id=f"test-{id(task)}"), SimpleNamespace())
        return taskset, task

    async def _verify_packaged_environment_bootstrap(self) -> None:
        _taskset, task = await self._bound_task()
        toolset = task.tool_servers()[0]

        class Runtime:
            type = "prime"

            def __init__(self, *, prebuilt: bool) -> None:
                self.writes: dict[str, bytes] = {}
                self.command = ""
                self.prebuilt = prebuilt

            async def write(self, path: str, value: bytes) -> None:
                self.writes[path] = value

            async def run(self, argv: list[str], env: dict[str, str]):
                del env
                self.command = " ".join(argv)
                if "test -f /opt/mazebench-image/tool-runtime" in self.command:
                    return SimpleNamespace(
                        exit_code=0 if self.prebuilt else 1,
                        stdout="",
                        stderr="",
                    )
                return SimpleNamespace(exit_code=0, stdout="", stderr="")

        runtime = Runtime(prebuilt=False)
        python = await mazebench_tools._install_mazebench_in_sandbox(
            toolset, runtime
        )

        self.assertEqual(python, "/tmp/vf-venv/bin/python")
        self.assertEqual(list(runtime.writes), ["/tmp/vf-src/mazebench.tar.gz"])
        self.assertIn("uv pip install", runtime.command)
        self.assertIn("uv venv /tmp/vf-venv", runtime.command)
        self.assertIn("/tmp/vf-src/mazebench", runtime.command)
        self.assertNotIn("chromium", runtime.command)
        prebuilt_runtime = Runtime(prebuilt=True)
        await mazebench_tools._install_mazebench_in_sandbox(
            toolset, prebuilt_runtime
        )
        self.assertIn("--no-deps --reinstall", prebuilt_runtime.command)
        self.assertNotIn("uv venv /tmp/vf-venv", prebuilt_runtime.command)
        self.assertIs(
            mcp_launch._install_in_sandbox,
            mazebench_tools._install_mazebench_in_sandbox,
        )

    async def _verify_direct_game_controls(self) -> None:
        _taskset, task = await self._bound_task()
        toolset = task.tool_servers()[0]
        try:
            await toolset.setup_task(task.data)
            started = await toolset.start()
            moved = await toolset.up()
            controls = {fn.__name__ for fn in discover_decorated(toolset, "tool")}

            self.assertEqual(
                controls,
                EXPECTED_GAME_TOOLS,
            )
            self.assertEqual(started["observation"]["observation_mode"], "ascii")
            self.assertEqual(moved["actions_used"], 1)
            self.assertNotIn("error", moved)
            self.assertEqual(len(toolset.state.maze_actions), 1)
            self.assertTrue(toolset.state.maze_scorecard)
            self.assertTrue(toolset._state_path.is_file())
            self.assertFalse(toolset._state_path.is_relative_to(ROOT))
            self.assertNotIn(str(ROOT), json.dumps(started))
        finally:
            await toolset._exit_stack.aclose()

    async def _verify_observation_modes(self) -> None:
        _taskset, json_task = await self._bound_task(observation_mode="json")
        json_toolset = json_task.tool_servers()[0]
        try:
            await json_toolset.setup_task(json_task.data)
            observation = (await json_toolset.start())["observation"]
            self.assertEqual(observation["observation_mode"], "json")
            self.assertIn("json_observation", observation)
            self.assertNotIn("level", observation)
        finally:
            await json_toolset._exit_stack.aclose()

        class FakeVisionSession:
            def __init__(self, *, task) -> None:
                del task

            def frame_for_actions(self, actions: list[str]) -> str:
                del actions
                return "data:image/png;base64,aGVsbG8="

            def close(self) -> None:
                return None

        _taskset, vision_task = await self._bound_task(observation_mode="vision")
        vision_toolset = vision_task.tool_servers()[0]
        with patch.object(mazebench_tools, "VisionSession", FakeVisionSession):
            try:
                await vision_toolset.setup_task(vision_task.data)
                result = await vision_toolset.start()
                self.assertIsInstance(result, CallToolResult)
                self.assertEqual(
                    result.structuredContent["result"]["observation"][
                        "observation_mode"
                    ],
                    "vision",
                )
                images = [
                    part for part in result.content if isinstance(part, ImageContent)
                ]
                self.assertEqual(len(images), 1)
                self.assertEqual(images[0].data, "aGVsbG8=")
            finally:
                await vision_toolset._exit_stack.aclose()

    async def _verify_framework_harness(
        self,
        *,
        real_prime: bool = False,
        observation_mode: str = "ascii",
    ) -> None:
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
                                    "name": "mazebench_start",
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

        def local_runtime(_config, name=None):
            return SubprocessRuntime(
                SubprocessConfig(), name=name or "mazebench-local-runtime-test"
            )

        try:
            environment = SingleAgentEnv(
                SingleAgentEnvConfig(
                    taskset=mazebench_tools.MazeBenchToolConfig(
                        num_examples=1,
                        start_level_id="level_HxI",
                        max_actions=1,
                        observation_mode=observation_mode,
                    ),
                    agent=AgentConfig(
                        harness=HarnessConfig(id="null"),
                        runtime=PrimeConfig(image="python:3.13-slim"),
                        max_turns=4,
                    ),
                )
            )
            task = next(iter(environment.taskset.head(1)))
            tool_runtime_patch = (
                contextlib.nullcontext()
                if real_prime
                else patch.object(
                    mcp_launch,
                    "make_runtime",
                    side_effect=local_runtime,
                )
            )
            harness_runtime_patch = (
                contextlib.nullcontext()
                if real_prime
                else patch.object(
                    rollout_module,
                    "make_runtime",
                    side_effect=local_runtime,
                )
            )
            tunnel_patch = (
                contextlib.nullcontext()
                if real_prime
                else patch.object(environment, "_requires_tunnel", return_value=False)
            )
            with tool_runtime_patch, harness_runtime_patch, tunnel_patch:
                async with environment.serving():
                    episode = await environment.run_episode(
                        task,
                        ModelContext(
                            model="fake-model",
                            client=client,
                            sampling=Sampling(
                                max_tokens=512,
                                reasoning_effort="high",
                                temperature=0.2,
                            ),
                        ),
                    )

            traces = episode.traces
            self.assertEqual(len(traces), 1)
            self.assertFalse(traces[0].errors)
            self.assertTrue(
                traces[0].state.maze_scorecard,
                traces[0].state.model_dump_json(indent=2),
            )
            self.assertEqual(len(requests), 3)
            for request in requests:
                tools = {
                    tool["function"]["name"]: tool["function"]
                    for tool in request.get("tools") or []
                }
                names = set(tools)
                self.assertEqual(names, EXPECTED_FRAMEWORK_GAME_TOOLS)
                coordinates = tools["mazebench_go_to_level"]["parameters"]["properties"]
                self.assertEqual(coordinates["x"]["pattern"], "^[A-Za-z]$")
                self.assertEqual(coordinates["y"]["pattern"], "^[A-Za-z]$")
                self.assertEqual(request["max_tokens"], 512)
                self.assertEqual(request["reasoning_effort"], "high")
                self.assertEqual(request["temperature"], 0.2)
            self.assertNotIn(str(ROOT), json.dumps(requests[0]))
            self.assertIn(
                "unknown tool 'read_file'", requests[1]["messages"][-1]["content"]
            )
            if observation_mode == "vision":
                content = requests[2]["messages"][-1]["content"]
                self.assertIsInstance(content, list)
                self.assertTrue(
                    any(part.get("type") == "image_url" for part in content)
                )
        finally:
            await client.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
