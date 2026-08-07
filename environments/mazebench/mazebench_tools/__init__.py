"""MazeBench taskset for untrusted harnesses using isolated MCP game controls.

MazeBench runs this evaluator-owned tool server in a sandbox separate from the
framework-selected harness. The game lives in the tool-server sandbox and only
named game controls cross that boundary.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from contextvars import ContextVar
from pathlib import Path, PurePosixPath
from typing import Annotated, Any, Literal

import verifiers.v1 as vf
import verifiers.v1.mcp.launch as mcp_launch
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
from pydantic import Field
from verifiers.v1.harnesses.codex.harness import INSTALL as CODEX_INSTALL
from verifiers.v1.mcp.server import ServerBase
from verifiers.v1.runtimes import register
from verifiers.v1.runtimes.prime import PrimeRuntime

logger = logging.getLogger(__name__)

GAME_SANDBOX_FINALIZATION_SECONDS = 30
MAX_ACTION_LENGTH = 128
MAX_ACTION_SEQUENCE_LENGTH = 1_000
PYTHON_SANDBOX_CODEX_VERSION = "0.144.5"
PYTHON_SANDBOX_CODEX_DIR = "/tmp/mazebench-python-codex"
PYTHON_SANDBOX_CODEX_BIN = f"{PYTHON_SANDBOX_CODEX_DIR}/bin/codex"
PRIME_TOOL_RUNTIME_IMAGE = os.environ.get(
    "MAZEBENCH_PRIME_TOOL_RUNTIME_IMAGE",
    "prime/mazebench/mazebench-tool-runtime:py313-codex-0.144.5-vf-b3b8f51-v3",
).strip()
PREBUILT_TOOL_MARKER = "/opt/mazebench-image/tool-runtime"
BoundedAction = Annotated[str, Field(min_length=1, max_length=MAX_ACTION_LENGTH)]
BoundedActionSequence = Annotated[
    list[BoundedAction], Field(min_length=1, max_length=MAX_ACTION_SEQUENCE_LENGTH)
]
WorldCoordinate = Annotated[str, Field(pattern=r"^[A-Za-z]$")]


class MazeBenchToolsetConfig(vf.ToolsetConfig):
    """A dedicated sandbox for one rollout's game tool server."""

    colocated: Literal[False] = False
    runtime: vf.RuntimeConfig = Field(
        default_factory=lambda: vf.PrimeConfig(
            image=PRIME_TOOL_RUNTIME_IMAGE,
            workdir="/app",
            # Bootstrap and the authenticated rollout-state channel need egress.
            # The model has no code-execution path inside this trusted sandbox.
            region="us",
            cpu=1,
            memory=2,
            disk=5,
            idle_timeout=1_800,
        )
    )
    url: None = None
    artifact_nonce: str = ""
    resume_checkpoint: dict[str, Any] | None = None
    vision: bool = False
    python_workspace_path: str = ""
    python_state_path: str = ""
    python_activity_path: str = ""


class MazeBenchPrimeRuntime(PrimeRuntime):
    """Prime runtime exposing MCP over a native TCP endpoint."""

    _python_export_paths: tuple[str, str, str] | None = None

    def configure_python_export(
        self, workspace_path: str, activity_path: str, state_path: str
    ) -> None:
        if workspace_path and activity_path and state_path:
            self._python_export_paths = (workspace_path, activity_path, state_path)

    async def expose(self, port: int) -> str:
        exposed = await self._client.expose(self.info.id, port, protocol="TCP")
        if not exposed.external_endpoint:
            raise RuntimeError("Prime did not return a TCP endpoint for MazeBench.")
        return f"http://{exposed.external_endpoint}"

    async def _export_python_workspace(self) -> None:
        if not self._python_export_paths or self._client is None:
            return
        workspace_path, activity_path, _state_path = self._python_export_paths
        report: dict[str, Any] = {
            "sandbox_id": self.info.id,
            "workspace_path": workspace_path,
            "exported_files": [],
            "omitted_files": [],
            "ok": True,
        }
        try:
            listing = await self.run(
                [
                    "python3",
                    "-c",
                    (
                        "import json, os, sys; root=sys.argv[1]; "
                        "print(json.dumps([[os.path.relpath(os.path.join(base, name), root), "
                        "os.path.getsize(os.path.join(base, name))] "
                        "for base, dirs, files in os.walk(root, followlinks=False) "
                        "for name in files if not os.path.islink(os.path.join(base, name))]))"
                    ),
                    workspace_path,
                ],
                {},
            )
            entries = json.loads(listing.stdout or "[]") if listing.exit_code == 0 else []
            destination_root = Path(workspace_path).resolve()
            total_bytes = 0
            for candidate in entries[:1_024]:
                if not isinstance(candidate, list) or len(candidate) != 2:
                    continue
                relative, size = str(candidate[0]), max(0, int(candidate[1]))
                remote_relative = PurePosixPath(relative)
                if remote_relative.is_absolute() or ".." in remote_relative.parts:
                    report["omitted_files"].append(relative)
                    continue
                if size > 16 * 1024 * 1024 or total_bytes + size > 64 * 1024 * 1024:
                    report["omitted_files"].append(relative)
                    continue
                target = (destination_root / Path(*remote_relative.parts)).resolve()
                if not target.is_relative_to(destination_root):
                    report["omitted_files"].append(relative)
                    continue
                data = await self.read(
                    str(PurePosixPath(workspace_path) / remote_relative)
                )
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                total_bytes += len(data)
                report["exported_files"].append(relative)

            metadata_paths = (
                (activity_path, False),
                (
                    str(
                        Path(activity_path).with_name(
                            "python-sandbox-preflight.json"
                        )
                    ),
                    True,
                ),
            )
            report["metadata_files"] = []
            for remote_path, required in metadata_paths:
                try:
                    data = await self.read(remote_path)
                except Exception as download_error:
                    fallback = await self.run(["cat", remote_path], {})
                    if fallback.exit_code != 0:
                        if required:
                            report["ok"] = False
                        report.setdefault("metadata_errors", []).append(
                            {
                                "path": Path(remote_path).name,
                                "error": str(download_error)[:300],
                            }
                        )
                        continue
                    data = fallback.stdout.encode()
                if data:
                    target = Path(remote_path)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                    report["metadata_files"].append(target.name)
        except Exception as error:  # best-effort export must not leak the paid sandbox
            report["ok"] = False
            report["error"] = str(error)[:500]
        finally:
            _atomic_json(
                str(Path(activity_path).with_name("python-sandbox-export.json")),
                report,
            )

    async def teardown(self) -> None:
        try:
            await self._export_python_workspace()
        finally:
            await super().teardown()


_verifiers_make_runtime = mcp_launch.make_runtime


def _make_mazebench_runtime(
    config: vf.RuntimeConfig, name: str | None = None
) -> vf.Runtime:
    if not isinstance(config, vf.PrimeConfig):
        return _verifiers_make_runtime(config, name)
    runtime = MazeBenchPrimeRuntime(config, name)
    binding = _current_rollout_tool_config.get()
    if binding is not None:
        tool_config = binding[2]
        runtime.configure_python_export(
            tool_config.python_workspace_path,
            tool_config.python_activity_path,
            tool_config.python_state_path,
        )
    register(runtime)
    return runtime


mcp_launch.make_runtime = _make_mazebench_runtime


_current_rollout_tool_config: ContextVar[
    tuple[object, str, MazeBenchToolsetConfig] | None
] = ContextVar("mazebench_rollout_tool_config", default=None)


class MazeBenchToolConfig(MazeBenchConfig):
    id: str = "mazebench-tools"
    python_tools: bool = False
    tools: MazeBenchToolsetConfig = Field(default_factory=MazeBenchToolsetConfig)


class MazeBenchToolTraceState(MazeBenchState):
    """State written only by the isolated evaluator-owned tool server."""


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
    python_policy = (
        """

TOOLS mode. In addition to the game controls, you have exactly one general-purpose
computation tool: `python_exec`. It runs Python in a fresh persistent scratch workspace.
Each call starts a fresh Python process, while relative-path files persist for this run.
Call `python_exec` directly. Do not use `functions.exec`, search `ALL_TOOLS`, or try to
discover it through another tool; MazeBench controls are deliberately direct-only.
Use it when isolated computation would help parse observations, track state, model mechanics,
or plan moves. You may create, revise, and execute reusable files through `python_exec`; there
is no shell, editor, browser, or host filesystem tool. Repository files, host files, run
artifacts, subprocesses, and network access are blocked.

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

Call `start` exactly once first and inspect its sanitized {mode} observation. Use the
named action tools `up`, `down`, `left`, `right`, `rotate_camera_up`,
`rotate_camera_down`, `rotate_camera_left`, `rotate_camera_right`, `undo`, `reset`,
`go_to_level`, and, when permitted, `quit`. A saved solver may instead call `action_sequence`
with an ordered `actions` array of at most 1,000 items. By default the
sequence result contains compact step summaries plus `final_observation`.
{sequence_observation_policy} Use `observe` only when you need to inspect the current state without
consuming an action. `go_to_level` accepts the two world-coordinate letters for a
previously visited room.{mode_policy}
The controls do not report whether a movement was blocked; infer its effect only from the
returned observation.{python_policy}

{objective} Explore as many rooms as possible. {budget} {quit_policy}
Finish with a short route summary only after a game result says `ended: true`. A belief that
no useful move remains is not a stop condition: while `ended: false`, never provide a final
response and continue using the game controls.

The game implementation, session, checkpoints, and scoring are evaluator-only. Do not try to
locate or access them. Do not claim moves or scores that were not returned by the game controls."""


def _tool_system_prompt(*, python_tools: bool = False) -> str:
    python_policy = " Python tools are available for isolated computation." if python_tools else ""
    return (
        "Use only the supplied game controls for game interaction. "
        "Use python_exec only for isolated computation when it is enabled. "
        "Treat game-control results as authoritative."
        f"{python_policy}"
    )


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

Continue using the isolated controls below. `start` returns the restored state and must
still be called exactly once by this new harness process.

{instructions}"""


class MazeBenchToolset(vf.Toolset[MazeBenchToolsetConfig, MazeBenchToolTraceState]):
    """Named model controls backed by a game in this tool-server sandbox."""

    # Codex and Prime Agent require a non-empty MCP server name. The raw MCP
    # methods remain the singular game controls below; generic function-calling
    # harnesses namespace them as `mazebench_<tool>` when combining servers.
    TOOL_PREFIX = "mazebench"

    async def setup_task(self, task: MazeBenchTaskData) -> None:
        if not self.config.artifact_nonce:
            raise RuntimeError("MazeBench game tools require a rollout binding.")
        self.task = task
        self._lock = asyncio.Lock()
        self._actions: list[dict[str, Any]] = []
        self._auto_quit: dict[str, Any] = {}
        self._scorecard: dict[str, Any] = {}
        self._status_error = ""
        self._runtime_root = (
            Path(__file__).resolve().parents[1] / "mazebench" / "runtime"
        )
        required = (
            self._runtime_root / "scripts" / "codex-play.js",
            self._runtime_root / "scripts" / "maze-bridge.js",
        )
        if not all(path.is_file() for path in required):
            raise RuntimeError("The packaged MazeBench game runtime is incomplete.")
        self._node = Path(sys.executable).with_name("node")
        if not self._node.is_file():
            raise RuntimeError(
                "The MazeBench tool sandbox has no packaged Node runtime."
            )
        digest = hashlib.sha256(self.config.artifact_nonce.encode()).hexdigest()[:16]
        self._run_dir = Path(tempfile.mkdtemp(prefix=f"mazebench-game-{digest}-"))
        self._state_path = self._run_dir / "session.json"
        self._exit_stack.callback(shutil.rmtree, self._run_dir, True)
        self._vision_session: VisionSession | None = None
        if task.observation_mode == "vision":
            vision_task = task.model_copy(
                update={
                    "node_bin": str(self._node),
                    "repo_root": str(self._runtime_root),
                }
            )
            self._vision_session = VisionSession(task=vision_task)
            self._exit_stack.callback(self._vision_session.close)

        args = [
            "start",
            "--repo-root",
            str(self._runtime_root),
            "--state",
            str(self._state_path),
            "--game",
            task.game_id,
            "--level",
            task.level_id,
            "--view",
            task.view,
            "--yaw",
            str(task.yaw),
            "--max-actions",
            "unlimited" if task.max_actions is None else str(task.max_actions),
        ]
        if task.observation_mode == "json":
            args.append("--json-observation")
            if task.omniscient:
                args.append("--omniscient")
        if task.hide_names:
            args.extend(["--hide-names", "--hide-names-seed", task.hide_names_seed])
        if not task.allow_quit:
            args.append("--no-quit")
        await self._run_game(args)
        self._sync_game_state()
        if self.config.resume_checkpoint:
            await self._restore_checkpoint(self.config.resume_checkpoint)

    async def _run_game(
        self,
        args: list[str],
        *,
        input_value: dict[str, Any] | None = None,
        trusted_env: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        env = {
            "HOME": os.environ.get("HOME", "/tmp"),
            "PATH": os.environ.get("PATH", ""),
            "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
            **(trusted_env or {}),
            "MAZEBENCH_MCP_CHILD": "1",
        }
        completed = await asyncio.to_thread(
            subprocess.run,
            [
                str(self._node),
                str(self._runtime_root / "scripts" / "codex-play.js"),
                *args,
            ],
            cwd=self._runtime_root,
            env=env,
            input=(json.dumps(input_value) if input_value is not None else None),
            text=True,
            capture_output=True,
            timeout=max(30, int(self.task.timeout_seconds)),
            check=False,
        )
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout).strip().splitlines()
            raise RuntimeError(
                (detail[-1] if detail else "MazeBench game command failed.")[:500]
            )
        output = completed.stdout.strip()
        if not output:
            return {}
        try:
            payload = json.loads(output)
        except json.JSONDecodeError as error:
            raise RuntimeError("The MazeBench game returned invalid data.") from error
        if not isinstance(payload, dict):
            raise TypeError("The MazeBench game returned invalid data.")
        return payload

    def _sync_game_state(self) -> None:
        try:
            session = json.loads(self._state_path.read_text(encoding="utf-8"))
            initial = session["initial"]
            status = session["lastStatus"]
            actions = session["actions"]
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, KeyError) as error:
            raise RuntimeError("The MazeBench game state is unavailable.") from error
        if (
            not isinstance(initial, dict)
            or not isinstance(status, dict)
            or not isinstance(actions, list)
        ):
            raise TypeError("The MazeBench game state is invalid.")
        self._initial = initial
        self._status = status
        self._actions = actions
        self._initial_hash = str(initial.get("board_state_hash") or "")
        scorecard = session.get("scorecard")
        self._scorecard = scorecard if isinstance(scorecard, dict) else {}

    async def _restore_checkpoint(self, checkpoint: dict[str, Any]) -> None:
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
                await self._run_game(
                    [
                        "action",
                        "--state",
                        str(self._state_path),
                        str(saved.get("command_text") or ""),
                    ]
                )
            else:
                await self._run_game(
                    [
                        "record-no-move",
                        "--state",
                        str(self._state_path),
                    ],
                    trusted_env={"MAZEBENCH_TRUSTED_NO_MOVE": "1"},
                )
            self._sync_game_state()
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
            status.get("game_lost")
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

    def _publish_state(self) -> None:
        for key, value in self._state_payload().items():
            setattr(self.state, key, value)

    async def _finalize_game(self) -> None:
        async with asyncio.timeout(GAME_SANDBOX_FINALIZATION_SECONDS):
            await self._run_game(
                [
                    "finalize",
                    "--state",
                    str(self._state_path),
                ],
                trusted_env={"MAZEBENCH_TRUSTED_FINALIZE": "1"},
            )
            self._sync_game_state()

    def _invalidate_scoring(self, error: Exception | str) -> None:
        self._status_error = str(error)
        self._status = {"game_lost": True}
        self._scorecard = {}
        self._auto_quit = {}

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
        if error:
            result["error"] = error
        if self._auto_quit:
            result["auto_quit"] = {
                "percentage": float(self._auto_quit.get("percentage") or 0),
                "mode": self._auto_quit.get("mode"),
            }
        return result

    async def _tool_response(self, result: dict[str, Any]) -> Any:
        try:
            # The framework tears the tool server down before Task.finalize. Keep the
            # trusted scorecard current after every model-visible interaction instead
            # of exposing a private lifecycle tool to the harness.
            await self._finalize_game()
        except Exception as error:  # noqa: BLE001 - scoring must fail closed
            self._invalidate_scoring(error)
        observation_workspace = self._sync_python_observation(result)
        if observation_workspace:
            result["observation_workspace"] = observation_workspace
        self._publish_state()
        if self.task.observation_mode == "vision":
            if self._vision_session is None:
                raise RuntimeError("The MazeBench vision renderer is unavailable.")
            data_url = await run_blocking(
                self._vision_session.frame_for_actions,
                valid_action_commands(self._actions),
            )
            encoded = data_url.removeprefix("data:image/png;base64,")
            return CallToolResult(
                content=[
                    TextContent(type="text", text=json.dumps(result)),
                    ImageContent(
                        type="image",
                        data=encoded,
                        mimeType="image/png",
                    ),
                ],
                structuredContent={"result": result},
            )
        return result

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
            return await self._tool_response(self._result())

    async def _single_action(self, action: str) -> Any:
        async with self._lock:
            if self._terminal():
                return await self._tool_response(
                    self._result(
                        error="The run has ended; no further action is available."
                    )
                )
            error, _recorded = await self._apply_action(action)
            return await self._tool_response(self._result(error=error))

    @vf.tool
    async def up(self) -> Any:
        """Move one screen-relative step up."""

        return await self._single_action("up")

    @vf.tool
    async def down(self) -> Any:
        """Move one screen-relative step down."""

        return await self._single_action("down")

    @vf.tool
    async def left(self) -> Any:
        """Move one screen-relative step left."""

        return await self._single_action("left")

    @vf.tool
    async def right(self) -> Any:
        """Move one screen-relative step right."""

        return await self._single_action("right")

    @vf.tool
    async def rotate_camera_up(self) -> Any:
        """Tilt the camera up."""

        return await self._single_action("rotate camera up")

    @vf.tool
    async def rotate_camera_down(self) -> Any:
        """Tilt the camera down."""

        return await self._single_action("rotate camera down")

    @vf.tool
    async def rotate_camera_left(self) -> Any:
        """Rotate the camera left."""

        return await self._single_action("rotate camera left")

    @vf.tool
    async def rotate_camera_right(self) -> Any:
        """Rotate the camera right."""

        return await self._single_action("rotate camera right")

    @vf.tool
    async def undo(self) -> Any:
        """Undo the most recent game action."""

        return await self._single_action("undo")

    @vf.tool
    async def reset(self) -> Any:
        """Reset the current room."""

        return await self._single_action("reset")

    @vf.tool
    async def go_to_level(self, x: str, y: str) -> Any:
        """Return to a visited room using its two world-coordinate letters."""

        return await self._single_action(f"go to level {x} {y}")

    @vf.tool
    async def quit(self) -> Any:
        """End the run when quitting is enabled for this task."""

        return await self._single_action("quit")

    async def _apply_action(self, raw: str) -> tuple[str, bool]:
        """Apply one action while the caller holds the toolset lock."""

        action_count_before = len(self._actions)
        if not self.task.allow_quit and raw.strip().casefold() == "quit":
            return "Quit is disabled for this run.", False

        error = ""
        try:
            await self._run_game(["action", "--state", str(self._state_path), raw])
        except RuntimeError as action_error:
            error = str(action_error).splitlines()[0][:300]
            self._status_error = error
        self._sync_game_state()

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
                action_count_before = len(self._actions)
                response = await self._run_game(
                    ["action-sequence", "--state", str(self._state_path)],
                    input_value={
                        "actions": normalized,
                        "include_intermediate_observations": (
                            include_intermediate_observations
                        ),
                    },
                )
                self._sync_game_state()
                raw_steps = response.get("steps")
                if not isinstance(raw_steps, list):
                    raise TypeError(
                        "The MazeBench action sequence returned invalid data."
                    )
                result = {
                    "requested_count": len(normalized),
                    "attempted_count": int(response.get("attempted_count") or 0),
                    "completed_count": len(self._actions) - action_count_before,
                    "stopped_early": int(response.get("attempted_count") or 0)
                    < len(normalized),
                    "stop_reason": str(response.get("stop_reason") or "completed"),
                    "steps": [
                        {
                            key: step[key]
                            for key in (
                                "index",
                                "action",
                                "recorded",
                                "action_count_before",
                                "action_count_after",
                                "error",
                            )
                            if key in step
                        }
                        for step in raw_steps
                        if isinstance(step, dict)
                    ],
                }
                if include_intermediate_observations:
                    new_actions = self._actions[action_count_before:]
                    result["intermediate_observations"] = [
                        {
                            "index": index,
                            "action": str(record.get("command_text") or ""),
                            "observation": _public_observation(
                                record.get("status") or {},
                                self.task.observation_mode,
                            ),
                        }
                        for index, record in enumerate(new_actions[:-1], start=1)
                    ]

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


MazeBenchToolset.go_to_level.__annotations__["x"] = WorldCoordinate
MazeBenchToolset.go_to_level.__annotations__["y"] = WorldCoordinate
MazeBenchToolset.action_sequence.__annotations__["actions"] = BoundedActionSequence


_verifiers_install_in_sandbox = mcp_launch._install_in_sandbox


async def _install_mazebench_in_sandbox(server: ServerBase, runtime: vf.Runtime) -> str:
    """Install this packaged environment without requiring a Verifiers checkout."""

    if not isinstance(server, MazeBenchToolset):
        return await _verifiers_install_in_sandbox(server, runtime)
    source_dir = mcp_launch._source_dir(type(server))
    if source_dir is None:
        raise RuntimeError("The MazeBench tool server package source is unavailable.")
    source = Path(source_dir)
    root = "/tmp/vf-src"
    await runtime.write(
        f"{root}/{source.name}.tar.gz",
        mcp_launch._tar_source(source),
    )
    venv = "/tmp/vf-venv"
    extras = ",".join(type(server).EXTRAS)
    package = f"{root}/{source.name}" + (f"[{extras}]" if extras else "")
    prebuilt_probe = await runtime.run(
        [
            "sh",
            "-c",
            (
                f"test -f {shlex.quote(PREBUILT_TOOL_MARKER)} && "
                f"test -x {shlex.quote(venv)}/bin/python && "
                f"test -x {shlex.quote(venv)}/bin/node"
            ),
        ],
        {},
    )
    prebuilt = prebuilt_probe.exit_code == 0
    codex_setup = ""
    if server.config.python_workspace_path:
        install = (
            CODEX_INSTALL.replace("{version}", PYTHON_SANDBOX_CODEX_VERSION)
            .replace("{dir}", PYTHON_SANDBOX_CODEX_DIR)
            .replace("{bin}", PYTHON_SANDBOX_CODEX_BIN)
        )
        codex_setup = (
            f" && ([ -x {shlex.quote(PYTHON_SANDBOX_CODEX_BIN)} ] || "
            f"( {install} ))"
        )
    vision_setup = ""
    if server.config.vision:
        runtime_root = f"{venv}/lib/python3.13/site-packages/mazebench/runtime"
        vision_setup = (
            " && apt-get update -qq && "
            "apt-get install -y -qq chromium >/dev/null && "
            f"{venv}/bin/npm install --prefix {runtime_root} --no-save "
            "--no-package-lock playwright-core@1.60.0 >/dev/null"
        )
    if prebuilt:
        install_package = (
            f"uv pip install --python {venv} --no-deps --reinstall "
            f"--no-build-isolation {shlex.quote(package)}"
        )
        logger.info("mazebench: reusing preinstalled tool runtime dependencies")
    else:
        install_package = (
            f"uv venv {venv} && "
            f"uv pip install --python {venv} {shlex.quote(package)}"
        )
        logger.warning(
            "mazebench: prebuilt tool runtime marker missing; using cold dependency install"
        )
    setup = (
        f"{mcp_launch._ENSURE_UV}; set -e; "
        "(command -v git >/dev/null 2>&1 && command -v curl >/dev/null 2>&1) || "
        "(apt-get update -qq && apt-get install -y -qq git curl ca-certificates); "
        f"tar -xzf {root}/{shlex.quote(source.name)}.tar.gz -C {root} && "
        f"{install_package}"
        f"{codex_setup}"
        f"{vision_setup}"
    )
    started_at = time.monotonic()
    result = await runtime.run(["sh", "-c", setup], {})
    if result.exit_code != 0:
        detail = (result.stderr or result.stdout).strip()[-2_000:]
        raise RuntimeError(f"MazeBench tool server install failed: {detail}")
    logger.info(
        "mazebench: tool runtime ready in %.1fs (prebuilt=%s)",
        time.monotonic() - started_at,
        prebuilt,
    )
    return f"{venv}/bin/python"


# The pinned Verifiers launcher only uploads Verifiers from a source checkout.
# MazeBench is self-contained and pins Verifiers itself, so scope that bootstrap
# exception to this server while leaving every other server on the stock path.
mcp_launch._install_in_sandbox = _install_mazebench_in_sandbox


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
        report = await run_blocking(self._python_request, "preflight", "", 5)
        _atomic_json(
            str(
                Path(self.config.python_activity_path).with_name(
                    "python-sandbox-preflight.json"
                )
            ),
            report,
        )

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
            "codex_bin": PYTHON_SANDBOX_CODEX_BIN,
            "python_bin": sys.executable,
        }
        completed = subprocess.run(
            [self.task.node_bin, str(script)],
            cwd=root,
            input=json.dumps(request),
            text=True,
            capture_output=True,
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
            raise TypeError("Isolated Python scratchpad returned invalid output.")
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
    NEEDS_CONTAINER = True

    async def setup(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        del runtime
        tool_config = self.config.tools.model_copy(
            update={
                "artifact_nonce": trace.id,
                "vision": self.data.observation_mode == "vision",
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
        write_live_actions(list(trace.state.maze_actions))
        if not trace.state.maze_scorecard:
            trace.state.game_lost = True
            if not trace.state.maze_status_error:
                trace.state.maze_status_error = "trusted game state unavailable"
        await MazeBenchTaskBehavior.finalize(self, trace, runtime)


class MazeBenchToolTaskWithPython(MazeBenchToolTask):
    """A task with isolated game controls and a fail-closed Python scratchpad."""

    tools = (MazeBenchToolsetWithPython,)


class MazeBenchToolTaskset(vf.Taskset[MazeBenchToolTask, MazeBenchToolConfig]):
    """MazeBench scoring with no user simulator and a trusted MCP tool server."""

    def load(self) -> list[MazeBenchToolTask]:
        tasks = MazeBenchTaskset(self.config, _trusted_task_generation=True).load()
        checkpoint = (
            load_prime_resume_checkpoint(self.config.resume_checkpoint_path)
            if self.config.resume_checkpoint_path
            else None
        )
        if checkpoint:
            checkpoint = {
                key: value for key, value in checkpoint.items() if key != "_path"
            }
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
            tool_config = self.config.tools.model_copy(
                update={
                    "resume_checkpoint": checkpoint,
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
                            "system_prompt": _tool_system_prompt(
                                python_tools=self.config.python_tools
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
