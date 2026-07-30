"""MazeBench taskset for untrusted harnesses using isolated MCP game controls.

The harness and game run in separate sandboxes. This evaluator-owned toolset
proxies four narrow controls to a disposable game container and mirrors only
the trusted scoring snapshot. Nothing from MazeBench is copied into the harness.
"""

from __future__ import annotations

import asyncio
import atexit
import base64
import hashlib
import io
import json
import math
import os
import subprocess
import tarfile
import tempfile
import threading
import time
import uuid
from contextvars import ContextVar
from pathlib import Path
from typing import Annotated, Any, Literal

import verifiers.v1 as vf
from mazebench.mazebench import (
    GAME_WON_GEM_COUNT,
    MazeBenchConfig,
    MazeBenchState,
    MazeBenchTaskBehavior,
    MazeBenchTaskConfig,
    MazeBenchTaskData,
    MazeBenchTaskset,
    VisionSession,
    evaluate_auto_quit,
    find_bridge_root,
    load_prime_resume_checkpoint,
    run_blocking,
    slim_status,
    target_text_for_row,
    valid_action_commands,
    write_live_actions,
)
from mcp.types import CallToolResult, ImageContent, TextContent
from pydantic import Field, model_validator
from verifiers.v1.errors import SandboxError
from verifiers.v1.runtimes import Runtime, register
from verifiers.v1.runtimes.docker import DockerRuntime, docker
from verifiers.v1.runtimes.subprocess import SubprocessRuntime

KIMI_CODE_IDENTICAL_ACTION_INTERVAL = 5
GAME_FINALIZATION_WAIT_SECONDS = 10
GAME_SANDBOX_FINALIZATION_SECONDS = 4
GAME_CLEANUP_TIMEOUT_SECONDS = 4
MAX_ACTION_LENGTH = 128
MAX_ACTION_SEQUENCE_LENGTH = 1_000
BoundedAction = Annotated[str, Field(min_length=1, max_length=MAX_ACTION_LENGTH)]
BoundedActionSequence = Annotated[
    list[BoundedAction], Field(min_length=1, max_length=MAX_ACTION_SEQUENCE_LENGTH)
]
_game_only_pairing = threading.local()


def _game_container_name(artifact_nonce: str) -> str:
    digest = hashlib.sha256(artifact_nonce.encode()).hexdigest()[:12]
    return f"mazebench-game-{digest}"


def _remove_game_container(name: str) -> None:
    removed = subprocess.run(
        ["docker", "rm", "--force", name],
        capture_output=True,
        text=True,
        timeout=GAME_CLEANUP_TIMEOUT_SECONDS,
        check=False,
    )
    if removed.returncode == 0:
        return
    listed = subprocess.run(
        [
            "docker",
            "ps",
            "-a",
            "--filter",
            f"name=^/{name}$",
            "--format",
            "{{.Names}}",
        ],
        capture_output=True,
        text=True,
        timeout=GAME_CLEANUP_TIMEOUT_SECONDS,
        check=False,
    )
    if listed.returncode == 0 and name not in listed.stdout.split():
        return
    detail = (removed.stderr or removed.stdout or listed.stderr).strip()
    raise RuntimeError(f"MazeBench could not remove the game sandbox: {detail[:500]}")


class MazeBenchGameRuntime(DockerRuntime):
    """A disposable game container with no host mounts or network."""

    is_local = False

    async def start(self) -> None:
        try:
            version = await docker("version", "--format", "{{.Server.Version}}")
        except FileNotFoundError as error:
            raise RuntimeError(
                "MazeBench requires Docker for the isolated game sandbox."
            ) from error
        if version.exit_code != 0:
            detail = (version.stderr or version.stdout).strip()
            raise RuntimeError(
                f"MazeBench could not reach Docker for the game sandbox: {detail}"
            )

        self._container = self.name
        memory_mib = int(float(self.config.memory or 0) * 1024)
        disk_mib = int(float(self.config.disk or 0) * 1024)
        run = await docker(
            "run",
            "--detach",
            "--network",
            "none",
            "--read-only",
            "--tmpfs",
            f"/app:rw,exec,nosuid,nodev,size={disk_mib}m",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=64m",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "256",
            "--cpus",
            str(self.config.cpu),
            "--memory",
            f"{memory_mib}m",
            "--workdir",
            self.config.workdir,
            "--entrypoint",
            "sleep",
            "--name",
            self._container,
            self.config.image,
            "infinity",
        )
        if run.exit_code != 0:
            self._container = None
            raise SandboxError(f"MazeBench game sandbox failed: {run.stderr.strip()}")
        self.info.id = run.stdout.strip()[:12]

    def cleanup(self) -> None:
        """Remove the game container and report any unconfirmed cleanup."""

        if self._container is None or self._stopped:
            return
        _remove_game_container(self._container)
        self._stopped = True


def _make_game_runtime(config: vf.DockerConfig, *, name: str) -> MazeBenchGameRuntime:
    runtime = MazeBenchGameRuntime(config, name=name)
    register(runtime)
    return runtime


def _game_runtime_archive() -> bytes:
    """Package only the installed MazeBench runtime, never its source checkout."""

    runtime = Path(__file__).resolve().parents[1] / "mazebench" / "runtime"
    required = (
        runtime / "scripts" / "maze-mcp-server.js",
        runtime / "scripts" / "maze-mcp-client.js",
        runtime / "scripts" / "codex-play.js",
    )
    if not all(path.is_file() for path in required):
        raise RuntimeError("The packaged MazeBench game runtime is incomplete.")

    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w:gz") as bundle:
        for path in sorted(runtime.rglob("*")):
            if path.is_symlink():
                raise RuntimeError(
                    "The packaged MazeBench game runtime contains a symlink."
                )
            bundle.add(path, arcname=path.relative_to(runtime), recursive=False)
    return archive.getvalue()


def _prime_harness_id() -> str:
    return (
        os.environ.get("MAZEBENCH_PRIME_HARNESS", "").strip().lower().replace("-", "_")
    )


def _bind_game_only_harness(harness: vf.Harness) -> None:
    from mazebench_harnesses.codex import MazeBenchCodexHarness

    taskset = getattr(_game_only_pairing, "taskset", None)
    if taskset is None:
        raise RuntimeError(
            "The MazeBench model relay must be constructed with its tool taskset."
        )
    if (
        type(harness) is not MazeBenchCodexHarness
        or harness.config.id != "mazebench_codex_harness"
        or not isinstance(harness.config.runtime, vf.SubprocessConfig)
    ):
        raise RuntimeError(
            "MazeBench agent runs require the fixed evaluator-side model relay."
        )
    taskset._bound_game_only_harness = harness
    _game_only_pairing.taskset = None


class MazeBenchToolsetConfig(vf.ToolsetConfig):
    """Private evaluator-owned paths supplied when a rollout tool server starts."""

    colocated: Literal[False] = False
    runtime: vf.SubprocessConfig = Field(default_factory=vf.SubprocessConfig)
    url: None = None
    game_runtime: vf.DockerConfig = Field(
        default_factory=lambda: vf.DockerConfig(
            image="node:24-bookworm-slim",
            workdir="/app",
            cpu=1,
            memory=2,
            disk=4,
        )
    )
    snapshot_path: str = ""
    finalized_path: str = ""
    artifact_nonce: str = ""
    resume_checkpoint_path: str = ""
    python_workspace_path: str = ""
    python_state_path: str = ""
    python_activity_path: str = ""

    @model_validator(mode="after")
    def validate_game_runtime(self) -> MazeBenchToolsetConfig:
        runtime = self.game_runtime
        if runtime.image != "node:24-bookworm-slim":
            raise ValueError("The MazeBench game sandbox image is fixed.")
        if runtime.workdir != "/app":
            raise ValueError("The MazeBench game sandbox workdir must be /app.")
        limits = (
            (runtime.cpu, 0.1, 4),
            (runtime.memory, 0.25, 8),
            (runtime.disk, 0.25, 8),
        )
        if any(
            value is None
            or not math.isfinite(float(value))
            or value < minimum
            or value > maximum
            for value, minimum, maximum in limits
        ):
            raise ValueError("The MazeBench game sandbox must have bounded resources.")
        if runtime.gpu is not None:
            raise ValueError("The MazeBench game sandbox does not allow GPU access.")
        return self


_current_rollout_tool_config: ContextVar[
    tuple[object, str, MazeBenchToolsetConfig] | None
] = ContextVar("mazebench_rollout_tool_config", default=None)


class MazeBenchToolConfig(MazeBenchConfig):
    id: str = "mazebench-tools"
    python_tools: Literal[False] = False
    tools: MazeBenchToolsetConfig = Field(default_factory=MazeBenchToolsetConfig)


class MazeBenchToolTraceState(vf.State):
    """Deliberately empty while the harness is alive.

    A CLI harness knows its interception bearer, so it can reach Verifiers'
    state endpoint. Keeping this schema empty prevents it from reading or
    forging authoritative game fields. Finalize replaces it after the harness
    exits with the evaluator-owned MazeBenchState snapshot.
    """


def _atomic_json(path: str, value: dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(target)


def _public_observation(status: dict[str, Any], mode: str) -> dict[str, Any]:
    """Return only the observation fields intended for the model."""

    observation_mode = "ascii" if mode in {"ascii", "text"} else mode
    gem_count = max(0, int(status.get("gem_count") or 0))
    common: dict[str, Any] = {
        "observation_mode": observation_mode,
        "current_room": str(status.get("current_room") or ""),
        "current_view": str(status.get("current_view") or ""),
        "yaw": int(status.get("yaw") or 0),
        "gem_count": gem_count,
        "visited_levels": [str(level) for level in status.get("visited_levels") or []],
        "player_dead": bool(status.get("player_dead")),
        "game_won": gem_count >= GAME_WON_GEM_COUNT,
        "game_lost": bool(status.get("game_lost")),
    }
    if observation_mode == "json":
        common["json_observation"] = status.get("json_observation") or {}
    elif observation_mode == "ascii":
        common["level"] = str(status.get("level") or "")
    if common["player_dead"]:
        common["death_message"] = str(
            status.get("death_message")
            or "The player died, you must now undo or reset or go to a level."
        )
        common["allowed_commands"] = [
            str(command)
            for command in status.get("allowed_commands")
            or ["undo", "reset", "go to level X Y"]
        ]
    return common


def _vision_tool_result(result: dict[str, Any], frame: str) -> CallToolResult:
    prefix = "data:image/png;base64,"
    if not frame.startswith(prefix):
        raise RuntimeError("MazeBench vision renderer did not return a PNG image")
    encoded = frame[len(prefix) :]
    base64.b64decode(encoded, validate=True)
    observation = result.get("observation") or result.get("final_observation")
    if not isinstance(observation, dict):
        raise TypeError("MazeBench vision result did not contain an observation")
    observation["frame_image"] = "attached:image/png"
    return CallToolResult(
        content=[
            TextContent(type="text", text=json.dumps(result, indent=2)),
            ImageContent(
                type="image",
                data=encoded,
                mimeType="image/png",
            ),
        ],
        structuredContent=result,
        isError=False,
    )


def _tool_prompt(task: MazeBenchTaskData, *, python_tools: bool = False) -> str:
    budget = (
        "There is no action limit; continue until the game is won or the run is stopped."
        if task.max_actions is None
        else f"You may use at most {int(task.max_actions)} game actions."
    )
    quit_policy = (
        "You may use quit when no useful move remains."
        if task.allow_quit
        else "Quit is disabled; recover with undo or reset after a death and keep playing."
    )
    if task.observation_mode == "json":
        mode = "structured JSON"
        mode_policy = """
In JSON mode, the structured board is the `json_observation` field inside each returned
`observation` (or inside `final_observation` for an action sequence). Programs should parse
that object directly rather than transcribing it into a different format."""
    elif task.observation_mode == "vision":
        mode = "perspective image"
        mode_policy = (
            " Each result includes an MCP image block containing the complete board "
            "observation for that turn. Inspect that image before choosing the next action; "
            "there is no ASCII or JSON board fallback."
        )
    else:
        mode = "ASCII"
        mode_policy = ""
    objective = target_text_for_row(
        {
            "game_won_gem_count": GAME_WON_GEM_COUNT,
            "target_gems": task.target_gems,
        }
    )
    kimi_observe_policy = (
        "\n\nKimi Code compatibility rule: while a result reports "
        "`completion_allowed: false`, every response must call exactly the "
        "`next_required_tool`; never provide a final response or substitute another tool. "
        "After five consecutive `game_action` calls with the same normalized action, "
        "you must call `game_observe` once before any further `game_action`. "
        "A different action resets the repetition count. "
        "The fifth action result reports `observe_required: true`; treat it as mandatory. "
        "`game_observe` resets the count and does not consume a game action."
        if _prime_harness_id() == "kimi_code"
        else ""
    )
    python_policy = (
        """

TOOLS mode. In addition to the game controls, you have exactly one general-purpose
computation tool: `python_exec`. It runs Python in a fresh persistent scratch workspace.
Each call starts a fresh Python process, while relative-path files persist for this run.
Before your first game action, use `python_exec` to create and execute at least one reusable
Python program that helps parse observations, track state, model mechanics, or plan moves.
Create, revise, and execute files through `python_exec`; there is no shell, editor, browser,
or host filesystem tool. Repository files, host files, run artifacts, subprocesses, and
network access are blocked.

In JSON mode, every delivered sanitized observation is also written atomically to
`observations/current.json` in that scratch workspace and appended to
`observations/history.jsonl`. Have saved Python programs load those files directly instead
of transcribing the tool result."""
        if python_tools
        else ""
    )
    sequence_observation_policy = (
        "Intermediate observations are unavailable in vision mode; inspect the attached "
        "image for the final completed step."
        if task.observation_mode == "vision"
        else "Set `include_intermediate_observations: true` to also receive every completed "
        "step before the final one in `intermediate_observations`, each with its action, "
        "index, and sanitized observation."
    )
    return f"""Play the hidden 3D grid game using only the supplied game controls.

Call `game_start` exactly once first. Inspect its sanitized {mode} observation, then call
`game_action` for a single action. A saved solver may instead call `game_action_sequence`
with an ordered `actions` array of at most 1,000 items. By default the
sequence result contains compact step summaries plus `final_observation`.
{sequence_observation_policy} Use `game_observe` only when you need to inspect the current state without
consuming an action. Valid actions include up, down, left, right,
rotate camera up, rotate camera down, rotate camera left, rotate camera right, undo, reset,
and go to level X Y.{mode_policy}{kimi_observe_policy}
The controls do not report whether a movement was blocked; infer its effect only from the
returned observation.{python_policy}

{objective} Explore as many rooms as possible. {budget} {quit_policy}
Finish with a short route summary only after a game result says `ended: true`. A belief that
no useful move remains is not a stop condition: while `ended: false`, never provide a final
response and continue using the game controls.

The game implementation, session, checkpoints, and scoring are evaluator-only. Do not try to
locate or access them. Do not claim moves or scores that were not returned by the game controls."""


def _tool_prompt_with_resume(
    task: MazeBenchTaskData, *, python_tools: bool = False
) -> str:
    instructions = _tool_prompt(task, python_tools=python_tools)
    if not isinstance(task.prompt, list):
        return instructions
    turns: list[str] = []
    for message in task.prompt[-20:]:
        role = str(getattr(message, "role", None) or message.get("role", "message"))
        content = getattr(message, "content", None)
        if content is None and isinstance(message, dict):
            content = message.get("content", "")
        text = content if isinstance(content, str) else json.dumps(content, default=str)
        turns.append(f"[{role}]\n{text}")
    context = "\n\n".join(turns)
    if len(context) > 40_000:
        context = context[-40_000:]
    return f"""This is a continued run. The evaluator has replayed and verified the saved game
checkpoint. Here is the tail of the prior model conversation for context:

{context}

Continue using the isolated controls below. `game_start` returns the restored state and must
still be called exactly once by this new harness process.

{instructions}"""


class MazeBenchToolset(vf.Toolset[MazeBenchToolsetConfig]):
    """Four model controls plus evaluator-only teardown for a game sandbox."""

    TOOL_PREFIX = "game"

    async def setup_task(self, task: MazeBenchTaskData) -> None:
        if not (
            self.config.snapshot_path
            and self.config.finalized_path
            and self.config.artifact_nonce
        ):
            raise RuntimeError(
                "MazeBench trusted scoring artifacts require a rollout binding."
            )
        self.task = task
        self._lock = asyncio.Lock()
        self._closed = False
        self._game_runtime: Runtime | None = None
        self._actions: list[dict[str, Any]] = []
        self._identical_action_interval = (
            KIMI_CODE_IDENTICAL_ACTION_INTERVAL
            if _prime_harness_id() == "kimi_code"
            else 0
        )
        self._last_action_key: str | None = None
        self._identical_action_streak = 0
        self._auto_quit: dict[str, Any] = {}
        self._scorecard: dict[str, Any] = {}
        self._status_error = ""
        self._vision_session: VisionSession | None = None
        runtime = _make_game_runtime(
            self.config.game_runtime,
            name=_game_container_name(self.config.artifact_nonce),
        )
        self._game_runtime = runtime
        try:
            await runtime.start()
            self._exit_stack.push_async_callback(runtime.stop)
            await runtime.write(
                "/tmp/mazebench-runtime.tar.gz", _game_runtime_archive()
            )
            unpacked = await runtime.run(
                [
                    "sh",
                    "-c",
                    (
                        "tar --no-same-owner -xzf /tmp/mazebench-runtime.tar.gz -C /app "
                        "&& rm -f /tmp/mazebench-runtime.tar.gz && mkdir -p /app/run"
                    ),
                ],
                {},
            )
            if unpacked.exit_code != 0:
                raise RuntimeError("The MazeBench game runtime could not be installed.")

            token = uuid.uuid4().hex
            self._game_env = {
                "MAZEBENCH_ALLOW_QUIT": "1" if task.allow_quit else "0",
                "MAZEBENCH_GAME_ID": task.game_id,
                "MAZEBENCH_HIDE_NAMES": "1" if task.hide_names else "0",
                "MAZEBENCH_HIDE_NAMES_SEED": task.hide_names_seed,
                "MAZEBENCH_LEVEL_ID": task.level_id,
                "MAZEBENCH_MCP_HTTP_TOKEN": token,
                "MAZEBENCH_MODE": (
                    task.observation_mode
                    if task.observation_mode != "vision"
                    else "text"
                ),
                "MAZEBENCH_MOVE_BUDGET": (
                    "unlimited" if task.max_actions is None else str(task.max_actions)
                ),
                "MAZEBENCH_OMNISCIENT": "1" if task.omniscient else "0",
                "MAZEBENCH_REPO_ROOT": "/app",
                "MAZEBENCH_RESTRICTED_MODE": "1",
                "MAZEBENCH_RUN_DIR": "/app/run",
                "MAZEBENCH_SESSION_FILE": "/app/run/session.json",
                "MAZEBENCH_VIEW": task.view,
                "MAZEBENCH_YAW": str(task.yaw),
            }
            await runtime.run_background(
                [
                    "node",
                    "/app/scripts/maze-mcp-server.js",
                    "--http",
                    "--port-file",
                    "/app/run/mcp-http.json",
                ],
                self._game_env,
                "/app/run/mcp-server.log",
            )

            port_info: dict[str, Any] | None = None
            for _attempt in range(200):
                try:
                    port_info = json.loads(
                        (await runtime.read("/app/run/mcp-http.json")).decode()
                    )
                    break
                except (SandboxError, UnicodeDecodeError, json.JSONDecodeError):
                    await asyncio.sleep(0.05)
            if not port_info or not int(port_info.get("port") or 0):
                try:
                    log = (await runtime.read("/app/run/mcp-server.log")).decode()
                except (SandboxError, UnicodeDecodeError):
                    log = ""
                detail = log.strip().splitlines()[-1:] or ["no startup log"]
                raise RuntimeError(
                    f"The MazeBench game tool server did not start: {detail[0][:500]}"
                )
            self._game_url = f"http://127.0.0.1:{int(port_info['port'])}/{token}/lead"

            await self._game_request(
                "initialize",
                {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "mazebench-evaluator", "version": "1"},
                },
            )
            listed = await self._game_request("tools/list")
            names = {tool.get("name") for tool in listed.get("tools", [])}
            expected = {
                "game_start",
                "game_observe",
                "game_action",
                "game_action_sequence",
            }
            if names != expected:
                raise RuntimeError(
                    "The MazeBench game tool server exposed unsafe tools."
                )

            started = await self._game_call("game_start")
            if started.isError:
                raise RuntimeError(
                    "The MazeBench game sandbox could not start the game."
                )
            await self._sync_game_state()
            self._exit_stack.push_async_callback(self._snapshot_before_game_stop)
            self._atexit_callback = self.close_session
            atexit.register(self._atexit_callback)
            if self.config.resume_checkpoint_path:
                await self._restore_checkpoint(self.config.resume_checkpoint_path)
            self._write_snapshot()
        except BaseException:  # cleanup must also survive task cancellation
            await runtime.stop()
            self._game_runtime = None
            raise

    def close_game_session(self) -> None:
        runtime = getattr(self, "_game_runtime", None)
        if runtime is not None:
            runtime.cleanup()
            self._game_runtime = None

    def close_vision_session(self) -> None:
        session = getattr(self, "_vision_session", None)
        if isinstance(session, VisionSession):
            session.close()
            self._vision_session = None

    def close_session(self) -> None:
        self.close_game_session()
        self.close_vision_session()
        callback = getattr(self, "_atexit_callback", None)
        if callback is not None:
            atexit.unregister(callback)
            self._atexit_callback = None

    async def _game_request(
        self, method: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        runtime = self._game_runtime
        if runtime is None:
            raise RuntimeError("The MazeBench game sandbox is not running.")
        request = {
            "jsonrpc": "2.0",
            "id": uuid.uuid4().hex,
            "method": method,
            **({"params": params} if params is not None else {}),
        }
        request_path = "/app/run/evaluator-request.json"
        await runtime.write(request_path, json.dumps(request).encode())
        result = await runtime.run(
            [
                "node",
                "/app/scripts/maze-mcp-client.js",
                self._game_url,
                request_path,
            ],
            {},
        )
        if result.exit_code != 0:
            raise RuntimeError("The MazeBench game sandbox did not answer.")
        try:
            response = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError(
                "The MazeBench game sandbox returned invalid data."
            ) from error
        if response.get("error"):
            raise RuntimeError(
                str(response["error"].get("message") or "game request failed")
            )
        payload = response.get("result")
        if not isinstance(payload, dict):
            raise TypeError("The MazeBench game sandbox returned invalid data.")
        return payload

    async def _game_call(
        self, name: str, arguments: dict[str, Any] | None = None
    ) -> CallToolResult:
        result = await self._game_request(
            "tools/call",
            {"name": name, "arguments": arguments or {}},
        )
        return CallToolResult.model_validate(result)

    async def _sync_game_state(self) -> None:
        runtime = self._game_runtime
        if runtime is None:
            raise RuntimeError("The MazeBench game sandbox is not running.")
        try:
            session = json.loads((await runtime.read("/app/run/session.json")).decode())
            initial = session["initial"]
            status = session["lastStatus"]
            actions = session["actions"]
        except (
            SandboxError,
            UnicodeDecodeError,
            json.JSONDecodeError,
            KeyError,
        ) as error:
            raise RuntimeError(
                "The MazeBench game sandbox state is unavailable."
            ) from error
        if (
            not isinstance(initial, dict)
            or not isinstance(status, dict)
            or not isinstance(actions, list)
        ):
            raise TypeError("The MazeBench game sandbox state is invalid.")
        self._initial = initial
        self._status = status
        self._actions = actions
        self._initial_hash = str(initial.get("board_state_hash") or "")
        scorecard = session.get("scorecard")
        self._scorecard = scorecard if isinstance(scorecard, dict) else {}

    async def _restore_checkpoint(self, checkpoint_path: str) -> None:
        checkpoint = load_prime_resume_checkpoint(checkpoint_path)
        expected_initial_hash = str(checkpoint.get("initial_board_state_hash") or "")
        if not expected_initial_hash or self._initial_hash != expected_initial_hash:
            raise ValueError(
                "Prime checkpoint initial state does not match this MazeBench runtime"
            )

        status = self._initial
        for index, saved in enumerate(checkpoint.get("actions") or [], start=1):
            if int(saved.get("turn") or 0) != index:
                raise ValueError(f"Prime checkpoint is missing action {index}")
            if saved.get("valid", True) is not False and not saved.get("error"):
                result = await self._game_call(
                    "game_action",
                    {"action": str(saved.get("command_text") or "")},
                )
                if result.isError:
                    raise ValueError(f"Prime checkpoint action {index} was rejected")
            else:
                runtime = self._game_runtime
                if runtime is None:
                    raise RuntimeError("The MazeBench game sandbox is not running.")
                recorded = await runtime.run(
                    [
                        "node",
                        "/app/scripts/codex-play.js",
                        "record-no-move",
                        "--state",
                        "/app/run/session.json",
                    ],
                    {**self._game_env, "MAZEBENCH_TRUSTED_NO_MOVE": "1"},
                )
                if recorded.exit_code != 0:
                    raise ValueError(
                        f"Prime checkpoint action {index} could not be restored"
                    )
            await self._sync_game_state()
            status = self._status
            expected_hash = str(saved.get("status", {}).get("board_state_hash") or "")
            if (
                not expected_hash
                or str(status.get("board_state_hash") or "") != expected_hash
            ):
                raise ValueError(
                    f"Prime checkpoint diverged while replaying action {index}"
                )

        final_hash = str(checkpoint.get("final_board_state_hash") or "")
        if str(status.get("board_state_hash") or "") != final_hash:
            raise ValueError(
                "Prime checkpoint replay did not reach its saved final state"
            )
        self._status = status

    def _terminal(self) -> bool:
        task = self.task
        status = self._status or {}
        return bool(
            self._closed
            or status.get("game_lost")
            or int(status.get("gem_count") or 0) >= GAME_WON_GEM_COUNT
            or status.get("quit")
            or self._auto_quit
            or (
                task.max_actions is not None
                and len(self._actions) >= int(task.max_actions)
            )
        )

    def _state_payload(self) -> dict[str, Any]:
        status = self._status or {}
        replay = {
            "game_id": self.task.game_id,
            "game_won_gem_count": GAME_WON_GEM_COUNT,
            "initial": slim_status(self._initial),
            "start_level_id": self.task.level_id,
            "target_gems": int(self.task.target_gems),
            "actions": self._actions,
            "scorecard": self._scorecard or None,
        }
        state = MazeBenchState(
            game_lost=bool(status.get("game_lost") or status.get("quit")),
            game_won=int(status.get("gem_count") or 0) >= GAME_WON_GEM_COUNT,
            maze_auto_quit=self._auto_quit,
            maze_actions=self._actions,
            maze_initial_board_state_hash=self._initial_hash,
            maze_replay=replay,
            maze_scorecard=self._scorecard,
            maze_status=status,
            maze_status_error=self._status_error,
        )
        return state.model_dump()

    def _write_snapshot(self) -> None:
        if self.config.snapshot_path:
            _atomic_json(
                self.config.snapshot_path,
                {
                    "version": 1,
                    "artifact_nonce": self.config.artifact_nonce,
                    "state": self._state_payload(),
                },
            )
        write_live_actions(list(self._actions))

    async def _finalize_game(self) -> None:
        runtime = self._game_runtime
        if runtime is None or self._scorecard:
            return
        async with asyncio.timeout(GAME_SANDBOX_FINALIZATION_SECONDS):
            finalized = await runtime.run(
                [
                    "node",
                    "/app/scripts/codex-play.js",
                    "finalize",
                    "--state",
                    "/app/run/session.json",
                ],
                {**self._game_env, "MAZEBENCH_TRUSTED_FINALIZE": "1"},
            )
            if finalized.exit_code != 0:
                raise RuntimeError(
                    "The MazeBench game sandbox could not finalize the run."
                )
            await self._sync_game_state()

    def _invalidate_scoring(self, error: Exception | str) -> None:
        self._status_error = str(error)
        self._status = {"game_lost": True}
        self._scorecard = {}
        self._auto_quit = {}

    async def _snapshot_before_game_stop(self) -> None:
        if self._game_runtime is None and not self._scorecard:
            self._invalidate_scoring(
                "The MazeBench game sandbox stopped before finalization."
            )
        elif self._game_runtime is not None:
            try:
                await self._finalize_game()
            except Exception as error:  # noqa: BLE001 - scoring must fail closed
                self._invalidate_scoring(error)
        self._write_snapshot()
        if self.config.finalized_path:
            _atomic_json(
                self.config.finalized_path,
                {
                    "version": 1,
                    "artifact_nonce": self.config.artifact_nonce,
                },
            )

    async def _finish_if_needed(self) -> None:
        if not self._terminal() or self._scorecard:
            return
        try:
            await self._finalize_game()
        except Exception as error:  # noqa: BLE001 - evaluator detail stays private
            self._invalidate_scoring(error)
        finally:
            await asyncio.to_thread(self.close_game_session)

    def _result(self, *, error: str = "") -> dict[str, Any]:
        result = {
            "observation": _public_observation(
                self._status or {}, self.task.observation_mode
            ),
            "actions_used": len(self._actions),
            "actions_remaining": (
                None
                if self.task.max_actions is None
                else max(0, int(self.task.max_actions) - len(self._actions))
            ),
            "ended": self._terminal(),
        }
        if not result["ended"] and self._identical_action_interval:
            result["completion_allowed"] = False
            result["next_required_tool"] = "game_action"
            if self._identical_action_streak >= self._identical_action_interval:
                result["observe_required"] = True
                result["next_required_tool"] = "game_observe"
        if error:
            result["error"] = error
        if self._auto_quit:
            result["auto_quit"] = {
                "percentage": float(self._auto_quit.get("percentage") or 0),
                "mode": self._auto_quit.get("mode"),
            }
        return result

    async def _tool_response(self, result: dict[str, Any]) -> Any:
        observation_workspace = self._sync_python_observation(result)
        if observation_workspace:
            result["observation_workspace"] = observation_workspace
        if self.task.observation_mode != "vision":
            return result
        try:
            if not isinstance(self._vision_session, VisionSession):
                self._vision_session = await run_blocking(VisionSession, task=self.task)
            frame = await run_blocking(
                self._vision_session.frame_for_actions,
                valid_action_commands(self._actions),
            )
        except Exception as error:
            await run_blocking(self.close_vision_session)
            raise RuntimeError("MazeBench vision renderer is unavailable") from error
        response = _vision_tool_result(result, frame)
        if result.get("ended"):
            await run_blocking(self.close_vision_session)
        return response

    def _sync_python_observation(self, result: dict[str, Any]) -> dict[str, Any] | None:
        workspace_value = self.config.python_workspace_path
        if not workspace_value or self.task.observation_mode != "json":
            return None
        observation = result.get("final_observation") or result.get("observation")
        if not isinstance(observation, dict):
            return None
        workspace = Path(workspace_value)
        workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
        root = workspace.resolve()
        directory = workspace / "observations"
        if directory.is_symlink():
            raise RuntimeError("The observation workspace must not be a symlink.")
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        resolved_directory = directory.resolve()
        if not resolved_directory.is_relative_to(root):
            raise RuntimeError(
                "The observation workspace escaped its scratch directory."
            )
        revision = len(self._actions)
        snapshot = {**observation, "observation_revision": revision}
        _atomic_json(str(resolved_directory / f"{revision:06d}.json"), snapshot)
        with (resolved_directory / "history.jsonl").open(
            "a", encoding="utf-8"
        ) as handle:
            handle.write(json.dumps(snapshot, separators=(",", ":")) + "\n")
        _atomic_json(str(resolved_directory / "current.json"), snapshot)
        return {
            "current_file": "observations/current.json",
            "history_file": "observations/history.jsonl",
            "observation_revision": revision,
        }

    @vf.tool
    async def start(self) -> Any:
        """Start the game and return the current sanitized observation. This is idempotent."""

        async with self._lock:
            return await self._tool_response(self._result())

    @vf.tool
    async def observe(self) -> Any:
        """Return the current sanitized observation without consuming an action."""

        async with self._lock:
            self._last_action_key = None
            self._identical_action_streak = 0
            return await self._tool_response(self._result())

    @vf.tool
    async def finalize(self) -> dict[str, bool]:
        """Finalize trusted scoring and stop the game sandbox. Evaluator use only."""

        async with self._lock:
            try:
                if not self._closed:
                    await self._snapshot_before_game_stop()
            except BaseException:  # noqa: BLE001 - cleanup must survive cancellation
                self._closed = True
                try:
                    await asyncio.to_thread(self.close_session)
                finally:
                    raise
            self._closed = True
            await asyncio.to_thread(self.close_session)
            return {"finalized": True}

    @vf.tool
    async def action(self, action: str) -> Any:
        """Apply one allowed game action, such as up, down, left, right, undo, reset, or rotate camera left."""

        async with self._lock:
            if self._terminal():
                return await self._tool_response(
                    self._result(
                        error="The run has ended; no further action is available."
                    )
                )
            if (
                self._identical_action_interval
                and self._identical_action_streak >= self._identical_action_interval
            ):
                return await self._tool_response(
                    self._result(error="Call game_observe before another game_action.")
                )

            raw = str(action or "").strip()
            if not raw or len(raw) > MAX_ACTION_LENGTH:
                raise ValueError(
                    f"action must contain between 1 and {MAX_ACTION_LENGTH} characters."
                )
            action_key = " ".join(raw.casefold().split())
            if action_key == self._last_action_key:
                self._identical_action_streak += 1
            else:
                self._last_action_key = action_key
                self._identical_action_streak = 1

            error, _recorded = await self._apply_action(raw)
            return await self._tool_response(self._result(error=error))

    async def _apply_action(self, raw: str) -> tuple[str, bool]:
        """Apply one action while the caller holds the toolset lock."""

        action_count_before = len(self._actions)
        if not self.task.allow_quit and raw.strip().casefold() == "quit":
            return "Quit is disabled for this run.", False

        response = await self._game_call("game_action", {"action": raw})
        await self._sync_game_state()
        error = ""
        if response.isError:
            content = response.content[0] if response.content else None
            error = str(getattr(content, "text", "Game action failed.")).splitlines()[
                0
            ][:300]
            self._status_error = error

        if not self._terminal():
            evaluation = evaluate_auto_quit(
                self._initial_hash,
                self._actions,
                enabled=self.task.auto_quit,
                threshold=self.task.auto_quit_threshold,
                mode=self.task.auto_quit_mode,
                window=self.task.auto_quit_window,
            )
            if evaluation is not None:
                self._auto_quit = evaluation
        await self._finish_if_needed()
        self._write_snapshot()
        return error, len(self._actions) > action_count_before

    @vf.tool
    async def action_sequence(
        self,
        actions: list[str],
        include_intermediate_observations: bool = False,
    ) -> Any:
        """Apply a solver-generated action list and return the final sanitized observation."""

        if not isinstance(actions, list) or not actions:
            raise ValueError("actions must contain at least one item.")
        if len(actions) > MAX_ACTION_SEQUENCE_LENGTH:
            raise ValueError(
                f"actions must contain at most {MAX_ACTION_SEQUENCE_LENGTH} items."
            )
        normalized: list[str] = []
        for index, action in enumerate(actions):
            if not isinstance(action, str) or not action.strip():
                raise ValueError(f"actions[{index}] must be a non-empty string.")
            if len(action.strip()) > MAX_ACTION_LENGTH:
                raise ValueError(
                    f"actions[{index}] exceeds {MAX_ACTION_LENGTH} characters."
                )
            normalized.append(action.strip())
        if not isinstance(include_intermediate_observations, bool):
            raise TypeError("include_intermediate_observations must be a boolean.")
        if self.task.observation_mode == "vision" and include_intermediate_observations:
            raise ValueError(
                "Intermediate observations are unavailable in vision mode."
            )

        async with self._lock:
            self._last_action_key = None
            self._identical_action_streak = 0
            if self._terminal():
                result: dict[str, Any] = {
                    "requested_count": len(normalized),
                    "attempted_count": 0,
                    "completed_count": 0,
                    "stopped_early": True,
                    "stop_reason": "run_ended",
                    "steps": [],
                }
            elif self.task.auto_quit:
                result = await self._auto_quit_action_sequence(
                    normalized, include_intermediate_observations
                )
            else:
                response = await self._game_call(
                    "game_action_sequence",
                    {
                        "actions": normalized,
                        "include_intermediate_observations": (
                            include_intermediate_observations
                        ),
                    },
                )
                await self._sync_game_state()
                if response.isError or not isinstance(response.structuredContent, dict):
                    content = response.content[0] if response.content else None
                    error = str(
                        getattr(content, "text", "Game action sequence failed.")
                    )
                    result = {
                        "requested_count": len(normalized),
                        "attempted_count": 0,
                        "completed_count": 0,
                        "stopped_early": True,
                        "stop_reason": "action_error",
                        "steps": [],
                        "error": error.splitlines()[0][:300],
                    }
                else:
                    result = dict(response.structuredContent)

            if not self._terminal():
                evaluation = evaluate_auto_quit(
                    self._initial_hash,
                    self._actions,
                    enabled=self.task.auto_quit,
                    threshold=self.task.auto_quit_threshold,
                    mode=self.task.auto_quit_mode,
                    window=self.task.auto_quit_window,
                )
                if evaluation is not None:
                    self._auto_quit = evaluation
            await self._finish_if_needed()
            self._write_snapshot()
            if self.task.observation_mode == "vision":
                result.pop("intermediate_observations", None)
            result["final_observation"] = _public_observation(
                self._status or {}, self.task.observation_mode
            )
            result["actions_used"] = len(self._actions)
            result["actions_remaining"] = (
                None
                if self.task.max_actions is None
                else max(0, int(self.task.max_actions) - len(self._actions))
            )
            result["ended"] = self._terminal()
            if not result["ended"] and self._identical_action_interval:
                result["completion_allowed"] = False
                result["next_required_tool"] = "game_action"
            return await self._tool_response(result)

    async def _auto_quit_action_sequence(
        self, actions: list[str], include_intermediate: bool
    ) -> dict[str, Any]:
        """Preserve per-action auto-quit checks while the toolset lock is held."""

        steps: list[dict[str, Any]] = []
        observations: list[dict[str, Any]] = []
        stop_reason = "completed"
        for index, action in enumerate(actions, start=1):
            action_count_before = len(self._actions)
            error, recorded = await self._apply_action(action)
            observation = _public_observation(
                self._status or {}, self.task.observation_mode
            )
            observations.append(observation)
            steps.append(
                {
                    "index": index,
                    "action": action,
                    "recorded": recorded,
                    "action_count_before": action_count_before,
                    "action_count_after": len(self._actions),
                    **({"error": error} if error else {}),
                }
            )
            if error or self._terminal():
                stop_reason = "action_error" if error else "run_ended"
                break

        result: dict[str, Any] = {
            "requested_count": len(actions),
            "attempted_count": len(steps),
            "completed_count": len(observations),
            "stopped_early": len(steps) < len(actions),
            "stop_reason": stop_reason,
            "steps": steps,
        }
        if include_intermediate:
            result["intermediate_observations"] = [
                {"index": index, "action": actions[index - 1], "observation": value}
                for index, value in enumerate(observations[:-1], start=1)
            ]
        return result


MazeBenchToolset.action.__annotations__["action"] = BoundedAction
MazeBenchToolset.action_sequence.__annotations__["actions"] = BoundedActionSequence


def _workspace_snapshot(
    workspace: Path, limit: int = 2_000
) -> dict[str, tuple[int, int]]:
    snapshot: dict[str, tuple[int, int]] = {}
    if not workspace.is_dir():
        return snapshot
    for entry in sorted(workspace.rglob("*")):
        if len(snapshot) >= limit:
            break
        try:
            if entry.is_symlink() or not entry.is_file():
                continue
            relative = entry.relative_to(workspace).as_posix()
            stat = entry.stat()
            snapshot[relative] = (stat.st_size, stat.st_mtime_ns)
        except (OSError, ValueError):
            continue
    return snapshot


def _workspace_changes(
    before: dict[str, tuple[int, int]], after: dict[str, tuple[int, int]]
) -> dict[str, Any]:
    return {
        "created": sorted(after.keys() - before.keys()),
        "modified": sorted(
            path for path in before.keys() & after.keys() if before[path] != after[path]
        ),
        "deleted": sorted(before.keys() - after.keys()),
        "truncated": len(before) >= 2_000 or len(after) >= 2_000,
    }


def _append_json_line(path: str, value: dict[str, Any]) -> None:
    try:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(value, separators=(",", ":")) + "\n")
    except OSError:
        pass


class MazeBenchToolsetWithPython(MazeBenchToolset):
    """Game controls plus fail-closed Python in a run-scoped scratch workspace."""

    async def setup_task(self, task: MazeBenchTaskData) -> None:
        await super().setup_task(task)
        self._python_lock = asyncio.Lock()
        try:
            report = await run_blocking(self._python_request, "preflight", "", 5)
            _atomic_json(
                str(
                    Path(self.config.python_activity_path).with_name(
                        "python-sandbox-preflight.json"
                    )
                ),
                report,
            )
        except Exception:
            self.close_session()
            raise

    def _python_request(
        self, operation: str, code: str, timeout_seconds: int
    ) -> dict[str, Any]:
        root = find_bridge_root()
        script = root / "scripts" / "maze-python-sandbox.js"
        if not all(
            (
                self.config.python_workspace_path,
                self.config.python_state_path,
                self.config.python_activity_path,
            )
        ):
            raise RuntimeError("The isolated Python scratchpad is not configured.")
        workspace = Path(self.config.python_workspace_path)
        state = Path(self.config.python_state_path)
        activity = Path(self.config.python_activity_path)
        if not script.is_file():
            raise RuntimeError("The isolated Python scratchpad is not configured.")
        request = {
            "operation": operation,
            "code": code,
            "timeout_seconds": timeout_seconds,
            "scratch_dir": str(workspace),
            "state_dir": str(state),
            "denied_paths": [str(root), str(activity.parent), str(Path.home())],
        }
        completed = subprocess.run(
            [self.task.node_bin, str(script)],
            cwd=root,
            input=json.dumps(request),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds + 15,
            check=False,
        )
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "").strip().splitlines()
            message = detail[-1] if detail else "sandbox process failed"
            for private in (
                str(root),
                str(workspace),
                str(state),
                str(activity.parent),
                str(Path.home()),
            ):
                message = message.replace(private, "<private>")
            raise RuntimeError(
                f"Isolated Python scratchpad unavailable: {message[:500]}"
            )
        try:
            result = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError(
                "Isolated Python scratchpad returned invalid output."
            ) from error
        if not isinstance(result, dict):
            raise RuntimeError("Isolated Python scratchpad returned invalid output.")
        return result

    @vf.tool
    async def python_exec(self, code: str, timeout_seconds: int = 10) -> dict[str, Any]:
        """Run Python in a persistent isolated scratch workspace with no host files, subprocesses, or network."""

        if not isinstance(code, str) or not code.strip():
            raise ValueError("code must be a non-empty Python source string.")
        if (
            not isinstance(timeout_seconds, int)
            or isinstance(timeout_seconds, bool)
            or timeout_seconds < 1
            or timeout_seconds > 60
        ):
            raise ValueError("timeout_seconds must be an integer between 1 and 60.")
        async with self._python_lock:
            workspace = Path(self.config.python_workspace_path)
            before = _workspace_snapshot(workspace)
            activity_id = str(uuid.uuid4())
            started_at = time.time()
            started_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started_at))
            code_hash = hashlib.sha256(code.encode()).hexdigest()
            _append_json_line(
                self.config.python_activity_path,
                {
                    "id": activity_id,
                    "tool": "python_exec",
                    "actor": "lead",
                    "clone_id": "",
                    "started_at": started_iso,
                    "status": "running",
                    "python_code": code,
                    "python_code_hash": code_hash,
                    "timeout_seconds": timeout_seconds,
                },
            )
            try:
                result = await run_blocking(
                    self._python_request, "run", code, timeout_seconds
                )
            except Exception as error:
                completed_at = time.time()
                after = _workspace_snapshot(workspace)
                _append_json_line(
                    self.config.python_activity_path,
                    {
                        "id": activity_id,
                        "tool": "python_exec",
                        "actor": "lead",
                        "clone_id": "",
                        "started_at": started_iso,
                        "completed_at": time.strftime(
                            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(completed_at)
                        ),
                        "duration_ms": round((completed_at - started_at) * 1_000),
                        "status": "failed",
                        "python_code_hash": code_hash,
                        "timeout_seconds": timeout_seconds,
                        "error": str(error)[:500],
                        "workspace_changes": _workspace_changes(before, after),
                    },
                )
                raise
            completed_at = time.time()
            after = _workspace_snapshot(workspace)
            _append_json_line(
                self.config.python_activity_path,
                {
                    "id": activity_id,
                    "tool": "python_exec",
                    "actor": "lead",
                    "clone_id": "",
                    "started_at": started_iso,
                    "completed_at": time.strftime(
                        "%Y-%m-%dT%H:%M:%SZ", time.gmtime(completed_at)
                    ),
                    "duration_ms": round((completed_at - started_at) * 1_000),
                    "status": "completed",
                    "python_code_hash": code_hash,
                    "timeout_seconds": timeout_seconds,
                    "python_result": result,
                    "workspace_changes": _workspace_changes(before, after),
                },
            )
            return result


class MazeBenchToolTaskConfig(MazeBenchTaskConfig):
    tools: MazeBenchToolsetConfig = Field(default_factory=MazeBenchToolsetConfig)


class MazeBenchToolTask(
    MazeBenchTaskBehavior,
    vf.Task[MazeBenchTaskData, MazeBenchToolTraceState, MazeBenchToolTaskConfig],
):
    """A task whose only game access is the evaluator-owned MCP server."""

    tools = (MazeBenchToolset,)
    user = None

    async def setup(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        harness = trace.agent.harness
        if (
            harness is None
            or harness.id != "mazebench_codex_harness"
            or type(harness.runtime) is not vf.SubprocessConfig
            or type(runtime) is not SubprocessRuntime
        ):
            raise RuntimeError(
                "MazeBench tool tasks require the fixed evaluator-side model relay."
            )

        if not self.config.tools.snapshot_path or not self.config.tools.finalized_path:
            raise RuntimeError("MazeBench trusted artifact storage is not configured.")
        artifact_root = Path(self.config.tools.snapshot_path).parent
        rollout_root = artifact_root / f"rollout-{trace.id}"
        rollout_root.mkdir(parents=True, mode=0o700, exist_ok=False)
        tool_config = self.config.tools.model_copy(
            update={
                "snapshot_path": str(rollout_root / "trusted-state.json"),
                "finalized_path": str(rollout_root / "trusted-finalized.json"),
                "artifact_nonce": trace.id,
            }
        )
        _current_rollout_tool_config.set((self, trace.id, tool_config))

    def tool_servers(self) -> list[vf.Toolset]:
        binding = _current_rollout_tool_config.get()
        if binding is None or binding[0] is not self:
            raise RuntimeError(
                "MazeBench tool servers require an active rollout binding."
            )
        server_cls = type(self).tools[0]
        return [server_cls(binding[2])]

    @vf.stop
    async def game_over(self, trace: vf.Trace) -> bool:
        del trace
        return False

    @vf.stop
    async def low_state_novelty(self, trace: vf.Trace) -> bool:
        del trace
        return False

    async def finalize(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        try:
            artifact_root = Path(self.config.tools.snapshot_path).parent
            rollout_root = artifact_root / f"rollout-{trace.id}"
            snapshot_path = rollout_root / "trusted-state.json"
            finalized_path = rollout_root / "trusted-finalized.json"
            deadline = time.monotonic() + GAME_FINALIZATION_WAIT_SECONDS
            while not finalized_path.is_file() and time.monotonic() < deadline:
                await asyncio.sleep(0.05)
            finalized = json.loads(finalized_path.read_text(encoding="utf-8"))
            expected_marker = {
                "version": 1,
                "artifact_nonce": trace.id,
            }
            if finalized != expected_marker:
                raise ValueError("trusted game finalization marker is invalid")
            payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
            if payload.get("artifact_nonce") != trace.id:
                raise ValueError("trusted game snapshot belongs to another rollout")
            trusted_state = MazeBenchState.model_validate(payload["state"])
            snapshot_path.unlink()
            finalized_path.unlink()
            rollout_root.rmdir()
        except Exception:  # noqa: BLE001 - unavailable trusted state must score zero
            trusted_state = MazeBenchState(
                game_lost=True,
                maze_status_error="trusted game state unavailable",
            )

        # The harness knows the interception bearer and could forge /state.
        # Replace it unconditionally with evaluator-owned data before scoring.
        trace.state = trusted_state
        await MazeBenchTaskBehavior.finalize(self, trace, runtime)


class MazeBenchToolTaskWithPython(MazeBenchToolTask):
    """A task with isolated game controls and a fail-closed Python scratchpad."""

    tools = (MazeBenchToolsetWithPython,)


class MazeBenchToolTaskset(vf.Taskset[MazeBenchToolTask, MazeBenchToolConfig]):
    """MazeBench scoring with no user simulator and a trusted MCP tool server."""

    def __init__(self, config: MazeBenchToolConfig) -> None:
        super().__init__(config)
        self._bound_game_only_harness: vf.Harness | None = None
        _game_only_pairing.taskset = self

    def load(self) -> list[MazeBenchToolTask]:
        from mazebench_harnesses.codex import MazeBenchCodexHarness

        harness = self._bound_game_only_harness
        if (
            type(harness) is not MazeBenchCodexHarness
            or harness.config.id != "mazebench_codex_harness"
            or type(harness.config.runtime) is not vf.SubprocessConfig
        ):
            raise RuntimeError(
                "MazeBench tool tasks require the fixed evaluator-side model relay."
            )
        tasks = MazeBenchTaskset(self.config, _trusted_task_generation=True).load()
        live_actions_path = os.environ.get("MAZEBENCH_LIVE_ACTIONS_PATH", "").strip()
        if live_actions_path and len(tasks) == 1:
            base = Path(live_actions_path).resolve().parent
        else:
            base = Path(tempfile.mkdtemp(prefix="mazebench-tools-"))
        base.mkdir(parents=True, exist_ok=True)

        sanitized: list[MazeBenchToolTask] = []
        workspace_key = hashlib.sha256(str(base.resolve()).encode()).hexdigest()[:24]
        python_workspace = (
            Path(tempfile.gettempdir())
            / "mazebench-agent-workspaces"
            / workspace_key
            / "workspace"
        )
        for task in tasks:
            data = task.data
            artifact_root = base / f"trusted-tool-{data.idx}"
            tool_config = self.config.tools.model_copy(
                update={
                    "snapshot_path": str(artifact_root / "state-template.json"),
                    "finalized_path": str(artifact_root / "marker-template.json"),
                    "resume_checkpoint_path": str(
                        self.config.resume_checkpoint_path or ""
                    ),
                    "python_workspace_path": (
                        str(python_workspace) if self.config.python_tools else ""
                    ),
                    "python_state_path": (
                        str(base / ".python-sandbox")
                        if self.config.python_tools
                        else ""
                    ),
                    "python_activity_path": (
                        str(base / "tool-activity.jsonl")
                        if self.config.python_tools
                        else ""
                    ),
                    # Never upload this server beside an untrusted harness.
                    "colocated": False,
                }
            )
            task_config = MazeBenchToolTaskConfig.model_validate(
                {**task.config.model_dump(), "tools": tool_config.model_dump()}
            )
            task_class = (
                MazeBenchToolTaskWithPython
                if self.config.python_tools
                else MazeBenchToolTask
            )
            sanitized.append(
                task_class(
                    data.model_copy(
                        update={
                            # These evaluator paths must not be serialized through the
                            # task channel that the harness can authenticate to.
                            "repo_root": "",
                            "resume_checkpoint_path": "",
                            "observation": "",
                            "prompt": _tool_prompt_with_resume(
                                data, python_tools=self.config.python_tools
                            ),
                            "system_prompt": (
                                "Use only the supplied game controls for game interaction. "
                                "When available, use python_exec only for isolated computation. "
                                "Treat game-control results as authoritative."
                            ),
                        }
                    ),
                    task_config,
                )
            )
        return sanitized


def load_taskset(config: MazeBenchToolConfig) -> MazeBenchToolTaskset:
    return MazeBenchToolTaskset(config=config)


__all__ = ["MazeBenchToolTaskset"]


if __name__ == "__main__":
    MazeBenchToolset.run()
