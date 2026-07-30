#!/usr/bin/env python3
"""Smoke-test the trust boundary used by Prime-hosted custom harnesses."""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import tarfile
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import mazebench_tools as tools_module
import verifiers.v1 as vf
from mazebench.mazebench import MazeBenchState
from mazebench_harnesses.codex import (
    MazeBenchCodexHarness,
    MazeBenchRelayHarnessConfig,
)
from mazebench_tools import (
    MazeBenchGameRuntime,
    MazeBenchToolConfig,
    MazeBenchToolset,
    MazeBenchToolsetConfig,
    MazeBenchToolTaskset,
    MazeBenchToolTraceState,
)
from mcp.server.fastmcp import FastMCP
from pydantic import ValidationError
from verifiers.v1.runtimes import ProgramResult
from verifiers.v1.runtimes.subprocess import SubprocessRuntime

ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_TOOL_FIELDS = {
    "board_state_hash",
    "player",
    "repo_root",
    "resume_checkpoint_path",
    "scorecard",
}
FORBIDDEN_RUNTIME_FIELDS = {
    "bind",
    "binds",
    "host_path",
    "mount",
    "mounts",
    "repo_root",
    "volume",
    "volumes",
}


class RecordingGameRuntime:
    """A no-Docker probe that models an isolated game filesystem and MCP server."""

    type = "docker"

    def __init__(self, host_canary: Path) -> None:
        self.host_canary = host_canary
        self.created_config: vf.DockerConfig | None = None
        self.created_name = ""
        self.started = False
        self.stopped = False
        self.cleaned = False
        self.writes: dict[str, bytes] = {}
        self.background: tuple[list[str], dict[str, str], str] | None = None
        self.called_tools: list[str] = []
        self.initial = {
            "action_count": 0,
            "board_state_hash": "sandbox-initial",
            "current_room": "level_HxI",
            "current_view": "top-diagonal",
            "game_lost": False,
            "gem_count": 0,
            "level": "P",
            "player": {"x": 0, "y": 0},
            "player_dead": False,
            "visited_levels": ["level_HxI"],
            "yaw": 0,
        }
        self.status = dict(self.initial)
        self.actions: list[dict[str, object]] = []
        self.scorecard: dict[str, object] = {}

    def _assert_sandbox_value(self, value: object) -> None:
        encoded = json.dumps(value, default=str)
        assert str(ROOT) not in encoded
        assert str(self.host_canary) not in encoded

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    def cleanup(self) -> None:
        self.cleaned = True

    async def write(self, path: str, data: bytes) -> None:
        assert path == "/tmp/mazebench-runtime.tar.gz" or path.startswith("/app/")
        self._assert_sandbox_value(path)
        self.writes[path] = data

    async def read(self, path: str) -> bytes:
        if not path.startswith("/app/"):
            raise PermissionError("game sandbox cannot read host paths")
        if path == "/app/run/mcp-http.json":
            return b'{"port":43123}'
        if path == "/app/run/session.json":
            return json.dumps(
                {
                    "initial": self.initial,
                    "lastStatus": self.status,
                    "actions": self.actions,
                    "scorecard": self.scorecard,
                }
            ).encode()
        raise FileNotFoundError(path)

    async def run(self, argv: list[str], env: dict[str, str]) -> ProgramResult:
        self._assert_sandbox_value({"argv": argv, "env": env})
        if argv[:2] == ["sh", "-c"]:
            assert argv == [
                "sh",
                "-c",
                (
                    "tar --no-same-owner -xzf /tmp/mazebench-runtime.tar.gz -C /app "
                    "&& rm -f /tmp/mazebench-runtime.tar.gz && mkdir -p /app/run"
                ),
            ]
            return ProgramResult(0, "", "")
        if argv == [
            "node",
            "/app/scripts/codex-play.js",
            "finalize",
            "--state",
            "/app/run/session.json",
        ]:
            assert env["MAZEBENCH_TRUSTED_FINALIZE"] == "1"
            self.scorecard = {"score": 1}
            return ProgramResult(0, "", "")
        if argv[:2] != ["node", "/app/scripts/maze-mcp-client.js"]:
            raise AssertionError(f"unexpected game sandbox command: {argv}")
        assert len(argv) == 4
        request = json.loads(self.writes[argv[3]])
        response = {
            "jsonrpc": "2.0",
            "id": request["id"],
            "result": self._mcp_result(request),
        }
        return ProgramResult(0, json.dumps(response), "")

    async def run_background(
        self,
        argv: list[str],
        env: dict[str, str],
        log: str,
    ) -> None:
        self._assert_sandbox_value({"argv": argv, "env": env, "log": log})
        assert argv == [
            "node",
            "/app/scripts/maze-mcp-server.js",
            "--http",
            "--port-file",
            "/app/run/mcp-http.json",
        ]
        assert env["MAZEBENCH_REPO_ROOT"] == "/app"
        assert env["MAZEBENCH_RESTRICTED_MODE"] == "1"
        assert log == "/app/run/mcp-server.log"
        self.background = (list(argv), dict(env), log)

    def _mcp_result(self, request: dict[str, object]) -> dict[str, object]:
        method = request["method"]
        if method == "initialize":
            return {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "sandbox-probe", "version": "1"},
            }
        if method == "tools/list":
            return {
                "tools": [
                    {"name": name, "inputSchema": {"type": "object"}}
                    for name in (
                        "game_start",
                        "game_observe",
                        "game_action",
                        "game_action_sequence",
                    )
                ]
            }
        if method != "tools/call":
            raise AssertionError(f"unexpected MCP method: {method}")

        params = request.get("params")
        assert isinstance(params, dict)
        name = str(params["name"])
        self.called_tools.append(name)
        arguments = params.get("arguments")
        assert isinstance(arguments, dict)
        if name == "game_action":
            action = str(arguments["action"])
            self.status = {
                **self.status,
                "action_count": 1,
                "board_state_hash": "sandbox-after-action",
            }
            self.actions.append(
                {
                    "turn": 1,
                    "valid": True,
                    "raw_response": action,
                    "command": action,
                    "normalized_action": "move",
                    "args": {"direction": action},
                    "error": None,
                    "status": self.status,
                }
            )
        result = {
            "observation": {
                "observation_mode": "ascii",
                "current_room": self.status["current_room"],
                "current_view": self.status["current_view"],
                "yaw": self.status["yaw"],
                "gem_count": 0,
                "visited_levels": ["level_HxI"],
                "player_dead": False,
                "game_won": False,
                "game_lost": False,
                "level": "P",
            },
            "actions_used": len(self.actions),
            "actions_remaining": max(0, 1 - len(self.actions)),
            "ended": len(self.actions) == 1,
        }
        return {
            "content": [{"type": "text", "text": json.dumps(result)}],
            "structuredContent": result,
            "isError": False,
        }


def nested_keys(value: object) -> set[str]:
    if isinstance(value, dict):
        return set(value).union(*(nested_keys(child) for child in value.values()))
    if isinstance(value, list):
        return set().union(*(nested_keys(child) for child in value))
    return set()


async def verify_tool_schema() -> None:
    toolset = MazeBenchToolset(MazeBenchToolsetConfig())
    server = FastMCP("mazebench-isolation-test")
    toolset._register(server)
    tools = await server.list_tools()
    schemas = {f"{toolset.server_name}_{tool.name}": tool.inputSchema for tool in tools}
    parameters = {
        name: set(schema.get("properties") or {}) for name, schema in schemas.items()
    }
    assert parameters == {
        "game_action": {"action"},
        "game_action_sequence": {
            "actions",
            "include_intermediate_observations",
        },
        "game_finalize": set(),
        "game_observe": set(),
        "game_start": set(),
    }
    assert schemas["game_action"]["properties"]["action"]["maxLength"] == 128
    sequence_schema = schemas["game_action_sequence"]["properties"]["actions"]
    assert sequence_schema["maxItems"] == 1_000
    assert sequence_schema["items"]["maxLength"] == 128
    advertised = json.dumps([tool.model_dump(mode="json") for tool in tools])
    assert str(ROOT) not in advertised
    assert not FORBIDDEN_TOOL_FIELDS.intersection(nested_keys(schemas))

    toolset.task = type("VisionTask", (), {"observation_mode": "vision"})()
    try:
        await toolset.action_sequence(["right"], include_intermediate_observations=True)
    except ValueError as error:
        assert "unavailable in vision mode" in str(error)
    else:
        raise AssertionError("vision sequence exposed text intermediate observations")


def verify_game_runtime_config(config: MazeBenchToolsetConfig) -> None:
    assert config.colocated is False
    assert isinstance(config.runtime, vf.SubprocessConfig)
    assert config.url is None
    assert isinstance(config.game_runtime, vf.DockerConfig)
    assert config.game_runtime.image == "node:24-bookworm-slim"
    assert config.game_runtime.workdir == "/app"
    assert config.game_runtime.cpu is not None and config.game_runtime.cpu > 0
    assert config.game_runtime.memory is not None and config.game_runtime.memory > 0
    assert config.game_runtime.disk is not None and config.game_runtime.disk > 0
    assert config.game_runtime.gpu is None
    assert MazeBenchGameRuntime.is_local is False

    runtime = config.game_runtime.model_dump(mode="json")
    assert not FORBIDDEN_RUNTIME_FIELDS.intersection(nested_keys(runtime))
    assert str(ROOT) not in json.dumps(runtime)

    for invalid in (
        {**config.model_dump(), "colocated": True},
        {**config.model_dump(), "url": "https://unsafe.example/mcp"},
        {**config.model_dump(), "runtime": {"type": "docker"}},
        {
            **config.model_dump(),
            "game_runtime": {"type": "subprocess"},
        },
        {
            **config.model_dump(),
            "game_runtime": {
                **config.game_runtime.model_dump(),
                "mounts": [f"{ROOT}:/repo"],
            },
        },
        {
            **config.model_dump(),
            "game_runtime": {
                **config.game_runtime.model_dump(),
                "image": "unsafe:latest",
            },
        },
        {
            **config.model_dump(),
            "game_runtime": {
                **config.game_runtime.model_dump(),
                "gpu": "all",
            },
        },
        {
            **config.model_dump(),
            "game_runtime": {
                **config.game_runtime.model_dump(),
                "memory": 9,
            },
        },
        {
            **config.model_dump(),
            "game_runtime": {
                **config.game_runtime.model_dump(),
                "memory": 0.001,
            },
        },
    ):
        try:
            MazeBenchToolsetConfig.model_validate(invalid)
        except ValidationError:
            pass
        else:
            raise AssertionError("unsafe game runtime configuration was accepted")


def verify_runtime_archive(runtime: RecordingGameRuntime, canary: bytes) -> None:
    archive = runtime.writes["/tmp/mazebench-runtime.tar.gz"]
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as bundle:
        members = bundle.getmembers()
        assert members
        for member in members:
            path = Path(member.name)
            assert not path.is_absolute()
            assert ".." not in path.parts
            assert not member.issym() and not member.islnk()
            if not member.isfile():
                continue
            source = bundle.extractfile(member)
            assert source is not None
            content = source.read()
            assert canary not in content
            assert str(ROOT).encode() not in content


async def verify_boundary() -> None:
    await verify_tool_schema()
    unbound = MazeBenchToolTaskset(MazeBenchToolConfig(num_examples=1, max_actions=1))
    try:
        unbound.load()
    except RuntimeError:
        pass
    else:
        raise AssertionError("an unbound harness route passed the taskset gate")

    with tempfile.TemporaryDirectory(prefix="mazebench-prime-tools-") as temporary:
        base = Path(temporary)
        host_canary = base / "host-canary.txt"
        canary = os.urandom(24).hex().encode()
        host_canary.write_bytes(canary)
        live_actions_path = base / "actions.jsonl"
        required_environment = {
            "MAZEBENCH_LIVE_ACTIONS_PATH": str(live_actions_path),
        }
        previous_environment = {
            key: os.environ.get(key) for key in required_environment
        }
        os.environ.update(required_environment)
        toolset = None
        try:
            config = MazeBenchToolConfig(
                num_examples=1,
                start_level_id="level_HxI",
                game_won_gem_count=100,
                max_actions=10,
                auto_quit=True,
            )
            taskset = MazeBenchToolTaskset(config=config)
            harness = MazeBenchCodexHarness(
                MazeBenchRelayHarnessConfig(id="mazebench_codex_harness")
            )
            tasks = taskset.load()
            assert len(tasks) == 1
            task = tasks[0]
            trace = vf.Trace(
                task=vf.TraceTask(type="MazeBenchToolTask", data=task.data),
                state=MazeBenchToolTraceState(),
            )
            await task.setup(
                SimpleNamespace(
                    id=trace.id,
                    agent=SimpleNamespace(harness=harness.config),
                ),
                SubprocessRuntime(vf.SubprocessConfig(), name=trace.id),
            )

            # /task is authenticated with a token the harness itself knows.
            # Therefore no evaluator path or initial raw observation may be in it.
            serialized_task = task.data.model_dump_json()
            assert task.data.repo_root == ""
            assert task.data.resume_checkpoint_path == ""
            assert task.data.observation == ""
            assert str(Path(__file__).resolve().parents[1]) not in serialized_task
            assert task.user is None

            # /state uses the same bearer. Its schema must reject any attempted
            # evaluator-owned maze fields while the harness is alive.
            try:
                MazeBenchToolTraceState.model_validate(
                    {"maze_status": {"board_state_hash": "forged"}}
                )
            except ValidationError:
                pass
            else:
                raise AssertionError("harness-facing state accepted forged maze data")

            toolsets = task.tool_servers()
            assert len(toolsets) == 1
            toolset = toolsets[0]
            verify_game_runtime_config(toolset.config)
            game_runtime = RecordingGameRuntime(host_canary)

            def make_game_runtime(
                runtime_config: vf.DockerConfig,
                *,
                name: str,
            ) -> RecordingGameRuntime:
                game_runtime.created_config = runtime_config
                game_runtime.created_name = name
                return game_runtime

            with (
                patch.object(
                    tools_module,
                    "_make_game_runtime",
                    side_effect=make_game_runtime,
                ),
                patch.object(
                    tools_module,
                    "MazeSession",
                    side_effect=AssertionError(
                        "the evaluator host must not create the game session"
                    ),
                    create=True,
                ),
                patch.object(
                    tools_module,
                    "evaluate_auto_quit",
                    return_value={"percentage": 100.0, "mode": "states"},
                ),
            ):
                await toolset.setup_task(task.data)

                opening = await toolset.start()
                assert opening["actions_used"] == 0
                assert not FORBIDDEN_TOOL_FIELDS.intersection(nested_keys(opening))

                moved = await toolset.action_sequence(
                    ["right", "left"], include_intermediate_observations=True
                )
                assert moved["attempted_count"] == 1
                assert moved["stopped_early"] is True
                assert moved["stop_reason"] == "run_ended"
                assert moved["actions_used"] == 1
                assert moved["ended"] is True
                assert moved["intermediate_observations"] == []
                assert not FORBIDDEN_TOOL_FIELDS.intersection(nested_keys(moved))

            assert game_runtime.created_config is toolset.config.game_runtime
            assert game_runtime.created_name == tools_module._game_container_name(
                trace.id
            )
            assert game_runtime.started is True
            assert game_runtime.background is not None
            assert game_runtime.called_tools == ["game_start", "game_action"]
            verify_runtime_archive(game_runtime, canary)
            for private_path in (host_canary, ROOT / "package.json"):
                try:
                    await game_runtime.read(str(private_path))
                except PermissionError:
                    pass
                else:
                    raise AssertionError(
                        "game runtime read a host or repository canary"
                    )

            snapshot_path = Path(toolset.config.snapshot_path)
            snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
            assert len(snapshot["state"]["maze_actions"]) == 1
            assert snapshot["artifact_nonce"] == trace.id
            assert live_actions_path.exists()

            await toolset._exit_stack.aclose()
            finalized_path = Path(toolset.config.finalized_path)
            assert json.loads(finalized_path.read_text(encoding="utf-8")) == {
                "version": 1,
                "artifact_nonce": trace.id,
            }

            # Finalization occurs after the untrusted harness is done. It must
            # replace the empty harness-facing state with the trusted snapshot.
            await task.finalize(trace, None)
            assert isinstance(trace.state, MazeBenchState)
            assert len(trace.info["maze_actions"]) == 1
            assert trace.info["maze_status"]

            toolset._status = {
                "gem_count": 99,
                "visited_levels": ["one", "two"],
                "novel_push_count": 99,
            }
            toolset._scorecard = {"score": 99}
            toolset._invalidate_scoring("forced finalization failure")
            failed_state = MazeBenchState.model_validate(toolset._state_payload())
            trace.state = failed_state
            assert failed_state.game_lost is True
            assert failed_state.maze_scorecard == {}
            assert failed_state.maze_status == {"game_lost": True}
            assert await task.gem_score(trace) == 0
            assert await task.room_exploration_score(trace) == 0
            assert await task.block_progress_score(trace) == 0

            toolset.close_session()
            assert game_runtime.cleaned is True
            assert game_runtime.stopped is True
            toolset = None
        finally:
            if toolset is not None:
                toolset.close_session()
            for key, value in previous_environment.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if not args.self_test:
        parser.error("use --self-test")
    asyncio.run(verify_boundary())
    print("isolated custom harness boundary ready")


if __name__ == "__main__":
    main()
