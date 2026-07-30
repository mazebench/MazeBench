from __future__ import annotations

import asyncio
import copy
import json
import os
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import mazebench_harnesses.codex as relay_module
import mazebench_tools
from mazebench_harnesses.codex import (
    MazeBenchCodexHarness,
    MazeBenchRelayHarnessConfig,
)
from mcp.types import CallToolResult, ImageContent, TextContent
from verifiers.v1.clients import ModelContext
from verifiers.v1.clients.eval import EvalClient
from verifiers.v1.env import EnvConfig, Environment, TimeoutConfig
from verifiers.v1.errors import SandboxError
from verifiers.v1.runtimes import DockerConfig, SubprocessConfig
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
    def test_live_game_runtime_has_only_the_game_capability(self) -> None:
        asyncio.run(self._verify_live_game_runtime())

    def test_model_relay_advertises_only_game_tools(self) -> None:
        asyncio.run(self._verify_model_relay())

    def test_model_relay_sends_vision_as_user_content(self) -> None:
        asyncio.run(self._verify_vision_message_roles())

    def test_finalize_closes_game_after_snapshot_failure(self) -> None:
        asyncio.run(self._verify_failed_finalization_cleanup())

    def test_rollouts_receive_distinct_trusted_artifacts(self) -> None:
        asyncio.run(self._verify_distinct_rollout_artifacts())

    def test_failed_docker_removal_remains_retryable(self) -> None:
        runtime = mazebench_tools.MazeBenchGameRuntime(
            DockerConfig(image="node:24-bookworm-slim", cpu=1, memory=2, disk=4),
            name="mazebench-game-cleanup-test",
        )
        runtime._container = runtime.name
        toolset = mazebench_tools.MazeBenchToolset(
            mazebench_tools.MazeBenchToolsetConfig()
        )
        toolset._game_runtime = runtime
        failed = subprocess.CompletedProcess([], 1, stdout="", stderr="remove failed")
        still_listed = subprocess.CompletedProcess(
            [], 0, stdout=f"{runtime.name}\n", stderr=""
        )
        removed = subprocess.CompletedProcess([], 0, stdout=runtime.name, stderr="")
        with patch.object(
            mazebench_tools.subprocess,
            "run",
            side_effect=[failed, still_listed, removed],
        ):
            with self.assertRaisesRegex(RuntimeError, "remove failed"):
                toolset.close_game_session()
            self.assertIs(toolset._game_runtime, runtime)
            self.assertFalse(runtime._stopped)
            toolset.close_game_session()
        self.assertIsNone(toolset._game_runtime)
        self.assertTrue(runtime._stopped)

    def test_model_relay_finalizes_after_tool_listing_failure(self) -> None:
        asyncio.run(self._verify_tool_listing_failure_cleanup())

    def test_concurrent_rollouts_keep_scoring_isolated(self) -> None:
        asyncio.run(self._verify_concurrent_rollout_scoring())

    def test_relay_transport_timeout_removes_game_container(self) -> None:
        asyncio.run(self._verify_relay_transport_timeout_cleanup())

    def test_tool_server_requires_rollout_binding(self) -> None:
        taskset = mazebench_tools.MazeBenchToolTaskset(
            mazebench_tools.MazeBenchToolConfig(
                num_examples=1,
                start_level_id="level_HxI",
            )
        )
        MazeBenchCodexHarness(MazeBenchRelayHarnessConfig(id="mazebench_codex_harness"))
        task = taskset.load()[0]
        with self.assertRaisesRegex(RuntimeError, "active rollout binding"):
            task.tool_servers()

    def test_cancelled_game_start_stops_runtime(self) -> None:
        asyncio.run(self._verify_cancelled_game_start_cleanup())

    async def _game_containers(self) -> set[str]:
        result = await asyncio.to_thread(
            subprocess.run,
            [
                "docker",
                "ps",
                "-a",
                "--filter",
                "name=^/mazebench-game-",
                "--format",
                "{{.Names}}",
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
        return set(result.stdout.split())

    async def _verify_failed_finalization_cleanup(self) -> None:
        toolset = mazebench_tools.MazeBenchToolset(
            mazebench_tools.MazeBenchToolsetConfig()
        )
        toolset._lock = asyncio.Lock()
        toolset._closed = False
        with (
            patch.object(
                toolset,
                "_snapshot_before_game_stop",
                side_effect=RuntimeError("snapshot failed"),
            ),
            patch.object(toolset, "close_session") as close_session,
        ):
            with self.assertRaisesRegex(RuntimeError, "snapshot failed"):
                await toolset.finalize()
            close_session.assert_called_once_with()
            self.assertEqual(await toolset.finalize(), {"finalized": True})
            self.assertEqual(close_session.call_count, 2)

    async def _verify_cancelled_game_start_cleanup(self) -> None:
        class CancelledRuntime:
            def __init__(self) -> None:
                self.stopped = False

            async def start(self) -> None:
                raise asyncio.CancelledError

            async def stop(self) -> None:
                self.stopped = True

        with tempfile.TemporaryDirectory(prefix="mazebench-cancelled-start-") as temp:
            with patch.dict(
                os.environ,
                {"MAZEBENCH_LIVE_ACTIONS_PATH": str(Path(temp) / "actions.jsonl")},
            ):
                taskset = mazebench_tools.MazeBenchToolTaskset(
                    mazebench_tools.MazeBenchToolConfig(
                        num_examples=1,
                        start_level_id="level_HxI",
                    )
                )
                harness = MazeBenchCodexHarness(
                    MazeBenchRelayHarnessConfig(id="mazebench_codex_harness")
                )
                task = taskset.load()[0]
                await task.setup(
                    SimpleNamespace(
                        id="cancelled-start",
                        agent=SimpleNamespace(harness=harness.config),
                    ),
                    SubprocessRuntime(SubprocessConfig(), name="cancelled-start"),
                )
                toolset = task.tool_servers()[0]

            runtime = CancelledRuntime()
            with (
                patch.object(
                    mazebench_tools,
                    "_make_game_runtime",
                    return_value=runtime,
                ),
                self.assertRaises(asyncio.CancelledError),
            ):
                await toolset.setup_task(task.data)
            self.assertTrue(runtime.stopped)
            self.assertIsNone(toolset._game_runtime)

    async def _verify_distinct_rollout_artifacts(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mazebench-rollout-artifacts-") as temp:
            with patch.dict(
                os.environ,
                {"MAZEBENCH_LIVE_ACTIONS_PATH": str(Path(temp) / "actions.jsonl")},
            ):
                taskset = mazebench_tools.MazeBenchToolTaskset(
                    mazebench_tools.MazeBenchToolConfig(
                        num_examples=1,
                        start_level_id="level_HxI",
                    )
                )
                harness = MazeBenchCodexHarness(
                    MazeBenchRelayHarnessConfig(id="mazebench_codex_harness")
                )
                task = taskset.load()[0]

            async def bind(trace_id: str):
                await task.setup(
                    SimpleNamespace(
                        id=trace_id,
                        agent=SimpleNamespace(harness=harness.config),
                    ),
                    SubprocessRuntime(SubprocessConfig(), name=trace_id),
                )
                return task.tool_servers()[0].config

            first, second = await asyncio.gather(bind("rollout-a"), bind("rollout-b"))
            self.assertNotEqual(first.snapshot_path, second.snapshot_path)
            self.assertNotEqual(first.finalized_path, second.finalized_path)
            self.assertEqual(first.artifact_nonce, "rollout-a")
            self.assertEqual(second.artifact_nonce, "rollout-b")

    async def _verify_tool_listing_failure_cleanup(self) -> None:
        containers_before = await self._game_containers()
        client = EvalClient("http://127.0.0.1:9/v1", "unused-provider-key")
        try:
            environment = Environment(
                EnvConfig(
                    taskset=mazebench_tools.MazeBenchToolConfig(
                        num_examples=1,
                        start_level_id="level_HxI",
                        game_won_gem_count=100,
                        max_actions=1,
                    ),
                    harness=MazeBenchRelayHarnessConfig(id="mazebench_codex_harness"),
                    max_turns=1,
                )
            )
            task = environment.taskset.select(1)[0]
            with patch.object(
                relay_module.ClientSession,
                "list_tools",
                side_effect=RuntimeError("forced tool listing failure"),
            ):
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
            self.assertIsNotNone(traces[0].error)
        finally:
            await client.close()
        self.assertEqual(
            await self._game_containers(),
            containers_before,
            "tool-list failure leaked a game container",
        )

    async def _verify_concurrent_rollout_scoring(self) -> None:
        containers_before = await self._game_containers()
        assigned_actions: list[str] = []
        assignment_lock = threading.Lock()

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                has_tool_result = any(
                    message.get("role") == "tool" for message in body["messages"]
                )
                if has_tool_result:
                    message = {"role": "assistant", "content": "done"}
                    finish_reason = "stop"
                else:
                    with assignment_lock:
                        action = ("left", "right")[len(assigned_actions)]
                        assigned_actions.append(action)
                    message = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": f"move-{action}",
                                "type": "function",
                                "function": {
                                    "name": "game_action",
                                    "arguments": json.dumps({"action": action}),
                                },
                            }
                        ],
                    }
                    finish_reason = "tool_calls"
                payload = {
                    "id": "fake-concurrent",
                    "object": "chat.completion",
                    "created": 0,
                    "model": "fake-model",
                    "choices": [
                        {
                            "index": 0,
                            "message": message,
                            "finish_reason": finish_reason,
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
        try:
            environment = Environment(
                EnvConfig(
                    taskset=mazebench_tools.MazeBenchToolConfig(
                        num_examples=1,
                        start_level_id="level_HxI",
                        game_won_gem_count=100,
                        max_actions=1,
                    ),
                    harness=MazeBenchRelayHarnessConfig(id="mazebench_codex_harness"),
                    max_turns=3,
                )
            )
            task = environment.taskset.select(1)[0]
            async with environment.serving():
                traces = await environment.episode(
                    task,
                    ModelContext(
                        model="fake-model",
                        client=client,
                        sampling=Sampling(),
                    ),
                    n=2,
                ).run()
            self.assertEqual(len(traces), 2)
            self.assertTrue(all(trace.error is None for trace in traces))
            commands = {trace.state.maze_actions[0]["command_text"] for trace in traces}
            self.assertEqual(commands, {"left", "right"})
            self.assertTrue(all(trace.state.maze_scorecard for trace in traces))
        finally:
            await client.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
        self.assertEqual(
            await self._game_containers(),
            containers_before,
            "concurrent rollouts leaked a game container",
        )

    async def _verify_relay_transport_timeout_cleanup(self) -> None:
        containers_before = await self._game_containers()

        class BlockingTransport:
            async def __aenter__(self):
                await asyncio.Event().wait()

            async def __aexit__(self, exc_type, exc, traceback):
                del exc_type, exc, traceback
                return False

        client = EvalClient("http://127.0.0.1:9/v1", "unused-provider-key")
        try:
            environment = Environment(
                EnvConfig(
                    taskset=mazebench_tools.MazeBenchToolConfig(
                        num_examples=1,
                        start_level_id="level_HxI",
                        game_won_gem_count=100,
                        max_actions=1,
                    ),
                    harness=MazeBenchRelayHarnessConfig(id="mazebench_codex_harness"),
                    timeout=TimeoutConfig(rollout=0.2),
                    max_turns=1,
                )
            )
            task = environment.taskset.select(1)[0]
            with patch.object(
                relay_module,
                "streamable_http_client",
                return_value=BlockingTransport(),
            ):
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
            self.assertEqual(traces[0].stop_condition, "harness_timeout")
        finally:
            await client.close()
        self.assertEqual(
            await self._game_containers(),
            containers_before,
            "relay transport timeout leaked a game container",
        )

    async def _verify_model_relay(self) -> None:
        requests: list[dict] = []
        containers_before = await asyncio.to_thread(
            subprocess.run,
            [
                "docker",
                "ps",
                "-a",
                "--filter",
                "name=^/mazebench-game-",
                "--format",
                "{{.Names}}",
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )

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
                    finish_reason = "tool_calls"
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
                    finish_reason = "tool_calls"
                else:
                    message = {"role": "assistant", "content": "done"}
                    finish_reason = "stop"
                payload = {
                    "id": f"fake-{index}",
                    "object": "chat.completion",
                    "created": 0,
                    "model": "fake-model",
                    "choices": [
                        {
                            "index": 0,
                            "message": message,
                            "finish_reason": finish_reason,
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
        try:
            environment = Environment(
                EnvConfig(
                    taskset=mazebench_tools.MazeBenchToolConfig(
                        num_examples=1,
                        start_level_id="level_HxI",
                        game_won_gem_count=100,
                        max_actions=1,
                    ),
                    harness=MazeBenchRelayHarnessConfig(id="mazebench_codex_harness"),
                    max_turns=4,
                )
            )
            task = environment.taskset.select(1)[0]
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
            self.assertNotEqual(
                traces[0].state.maze_status_error,
                "trusted game state unavailable",
            )
            self.assertTrue(traces[0].state.maze_scorecard)
            self.assertEqual(len(requests), 3)
            for request in requests:
                names = {
                    tool["function"]["name"] for tool in request.get("tools") or []
                }
                self.assertEqual(names, EXPECTED_GAME_TOOLS)
            schemas = {
                tool["function"]["name"]: tool["function"]["parameters"]
                for tool in requests[0]["tools"]
            }
            self.assertEqual(
                schemas["game_action"]["properties"]["action"]["maxLength"], 128
            )
            self.assertEqual(
                schemas["game_action_sequence"]["properties"]["actions"]["maxItems"],
                1_000,
            )
            self.assertNotIn(str(ROOT), json.dumps(requests[0]))
            self.assertIn(
                "unknown tool 'read_file'", requests[1]["messages"][-1]["content"]
            )
            self.assertEqual(requests[2]["messages"][-1]["role"], "tool")
            self.assertNotIn("package-lock.json", json.dumps(requests))
        finally:
            await client.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
            containers_after = await asyncio.to_thread(
                subprocess.run,
                [
                    "docker",
                    "ps",
                    "-a",
                    "--filter",
                    "name=^/mazebench-game-",
                    "--format",
                    "{{.Names}}",
                ],
                capture_output=True,
                text=True,
                timeout=30,
                check=True,
            )
            self.assertEqual(
                set(containers_after.stdout.split()),
                set(containers_before.stdout.split()),
                "model relay leaked a game container",
            )

    async def _verify_vision_message_roles(self) -> None:
        requests: list[dict] = []
        http_client_options: list[dict] = []
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
                        ImageContent(
                            type="image",
                            data="aGVsbG8=",
                            mimeType="image/png",
                        ),
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

        def fake_http_client(**kwargs):
            http_client_options.append(kwargs)
            return AsyncContext(object())

        taskset = mazebench_tools.MazeBenchToolTaskset(
            mazebench_tools.MazeBenchToolConfig()
        )
        harness = MazeBenchCodexHarness(
            MazeBenchRelayHarnessConfig(id="mazebench_codex_harness")
        )
        self.assertIs(taskset._bound_game_only_harness, harness)
        runtime = SubprocessRuntime(SubprocessConfig(), name="relay-vision-test")

        with (
            patch.object(
                relay_module.httpx,
                "AsyncClient",
                side_effect=fake_http_client,
            ),
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
                relay_module.mazebench_tools,
                "_remove_game_container",
            ) as remove_game_container,
            patch.object(harness, "resolve_prompt", return_value=("system", "prompt")),
            patch.dict(
                os.environ,
                {
                    "HTTP_PROXY": "http://proxy.invalid:8080",
                    "ALL_PROXY": "http://proxy.invalid:8080",
                },
            ),
        ):
            result = await harness.launch(
                SimpleNamespace(model="fake-model"),
                SimpleNamespace(id="vision-relay", task=SimpleNamespace(data={})),
                runtime,
                "http://127.0.0.1/v1",
                "secret",
                {"game": "http://127.0.0.1/game"},
            )

        self.assertEqual(result.exit_code, 0)
        self.assertEqual(session_calls, ["start", "finalize"])
        remove_game_container.assert_not_called()
        self.assertEqual(len(http_client_options), 2)
        for options in http_client_options:
            self.assertIs(options["trust_env"], False)
            self.assertIs(options["follow_redirects"], False)
        self.assertEqual(len(requests), 2)
        messages = requests[1]["messages"]
        self.assertEqual(messages[-2]["role"], "tool")
        self.assertIsInstance(messages[-2]["content"], str)
        self.assertNotIn("image_url", messages[-2]["content"])
        self.assertEqual(messages[-1]["role"], "user")
        self.assertTrue(
            any(
                part.get("image_url", {}).get("url") == "data:image/png;base64,aGVsbG8="
                for part in messages[-1]["content"]
            )
        )
        with self.assertRaisesRegex(RuntimeError, "local interception endpoint"):
            await harness.launch(
                SimpleNamespace(model="fake-model"),
                SimpleNamespace(id="vision-relay", task=SimpleNamespace(data={})),
                runtime,
                "https://127.0.0.1/v1",
                "secret",
                {"game": "http://127.0.0.1/game"},
            )

    async def _verify_live_game_runtime(self) -> None:
        docker = await asyncio.to_thread(
            subprocess.run,
            ["docker", "info", "--format", "{{json .ServerVersion}}"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(docker.returncode, 0, docker.stderr)

        with tempfile.TemporaryDirectory(prefix="mazebench-game-isolation-") as temp:
            base = Path(temp)
            host_canary = base / "host-canary.txt"
            host_canary.write_bytes(os.urandom(32))
            live_actions = base / "actions.jsonl"

            with patch.dict(
                os.environ,
                {"MAZEBENCH_LIVE_ACTIONS_PATH": str(live_actions)},
            ):
                config = mazebench_tools.MazeBenchToolConfig(
                    num_examples=1,
                    start_level_id="level_HxI",
                    game_won_gem_count=100,
                    max_actions=1,
                )
                taskset = mazebench_tools.MazeBenchToolTaskset(config=config)
                harness = MazeBenchCodexHarness(
                    MazeBenchRelayHarnessConfig(id="mazebench_codex_harness")
                )
                task = taskset.load()[0]
                await task.setup(
                    SimpleNamespace(
                        id="runtime-isolation",
                        agent=SimpleNamespace(harness=harness.config),
                    ),
                    SubprocessRuntime(SubprocessConfig(), name="runtime-isolation"),
                )

            toolset = task.tool_servers()[0]
            container_name = ""
            try:
                await toolset.setup_task(task.data)
                runtime = toolset._game_runtime
                self.assertIsInstance(runtime, mazebench_tools.MazeBenchGameRuntime)
                assert runtime is not None
                container_name = runtime.name

                inspected = await asyncio.to_thread(
                    subprocess.run,
                    ["docker", "inspect", container_name],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                container = json.loads(inspected.stdout)[0]
                host_config = container["HostConfig"]
                self.assertEqual(host_config["NetworkMode"], "none")
                self.assertEqual(container["Mounts"], [])
                self.assertIsNone(host_config["Binds"])

                interfaces = await runtime.run(
                    [
                        "sh",
                        "-c",
                        'for interface in /sys/class/net/*; do basename "$interface"; done',
                    ],
                    {},
                )
                self.assertEqual(interfaces.exit_code, 0, interfaces.stderr)
                self.assertEqual(interfaces.stdout.split(), ["lo"])

                network = await runtime.run(
                    [
                        "node",
                        "-e",
                        (
                            "const net=require('node:net');"
                            "const socket=net.connect(80,'1.1.1.1');"
                            "socket.setTimeout(1000,()=>process.exit(7));"
                            "socket.on('connect',()=>process.exit(0));"
                            "socket.on('error',()=>process.exit(7));"
                        ),
                    ],
                    {},
                )
                self.assertNotEqual(
                    network.exit_code, 0, "game sandbox reached the network"
                )

                for private_path in (host_canary, ROOT / "package.json"):
                    with self.assertRaises(SandboxError):
                        await runtime.read(str(private_path))

                listed = await toolset._game_request("tools/list")
                names = [tool["name"] for tool in listed["tools"]]
                self.assertEqual(len(names), len(EXPECTED_GAME_TOOLS))
                self.assertEqual(set(names), EXPECTED_GAME_TOOLS)
            finally:
                await toolset._exit_stack.aclose()
                toolset.close_session()

            removed = await asyncio.to_thread(
                subprocess.run,
                ["docker", "inspect", container_name],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertNotEqual(
                removed.returncode, 0, "game container leaked after teardown"
            )


if __name__ == "__main__":
    unittest.main()
