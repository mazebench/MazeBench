"""MazeBench taskset for untrusted harnesses using isolated MCP game controls.

The harness runs in its own Prime sandbox. The game session and authoritative
artifacts stay in this per-rollout tool-server process on the trusted evaluator
host. Nothing from the MazeBench runtime is copied into the harness runtime.
"""

from __future__ import annotations

import atexit
import asyncio
import base64
import json
import os
import tempfile
from pathlib import Path
from typing import Any

import verifiers.v1 as vf
from mcp.types import CallToolResult, ImageContent, TextContent
from pydantic import Field

from mazebench.mazebench import (
    GAME_WON_GEM_COUNT,
    MazeBenchConfig,
    MazeBenchState,
    MazeBenchTaskBehavior,
    MazeBenchTaskConfig,
    MazeBenchTaskData,
    MazeBenchTaskset,
    MazeSession,
    VisionSession,
    apply_quit_policy,
    evaluate_auto_quit,
    find_bridge_root,
    load_prime_resume_checkpoint,
    parse_text_action,
    record_maze_action,
    run_blocking,
    slim_status,
    target_text_for_row,
    valid_action_commands,
    write_live_actions,
)


KIMI_CODE_IDENTICAL_ACTION_INTERVAL = 5


def _prime_harness_id() -> str:
    return os.environ.get("MAZEBENCH_PRIME_HARNESS", "").strip().lower().replace("-", "_")


class MazeBenchToolsetConfig(vf.ToolsetConfig):
    """Private evaluator-owned paths supplied when a rollout tool server starts."""

    snapshot_path: str = ""
    resume_checkpoint_path: str = ""


class MazeBenchToolConfig(MazeBenchConfig):
    id: str = "mazebench-tools"
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
        raise RuntimeError("MazeBench vision result did not contain an observation")
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


def _tool_prompt(task: MazeBenchTaskData) -> str:
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
    return f"""Play the hidden 3D grid game using only the supplied game controls.

Call `game_start` exactly once first. Inspect its sanitized {mode} observation, then call
`game_action` for a single action. A saved solver may instead call `game_action_sequence`
with its complete ordered `actions` array; there is no sequence-length cap. By default the
sequence result contains compact step summaries plus `final_observation`. Set
`include_intermediate_observations: true` to also receive every completed step before the
final one in `intermediate_observations`, each with its action, index, and sanitized
observation. Use `game_observe` only when you need to inspect the current state without
consuming an action. Valid actions include up, down, left, right,
rotate camera up, rotate camera down, rotate camera left, rotate camera right, undo, reset,
and go to level X Y.{mode_policy}{kimi_observe_policy}
The controls do not report whether a movement was blocked; infer its effect only from the
returned observation.

{objective} Explore as many rooms as possible. {budget} {quit_policy}
Finish with a short route summary only after a game result says `ended: true`. A belief that
no useful move remains is not a stop condition: while `ended: false`, never provide a final
response and continue using the game controls.

The game implementation, session, checkpoints, and scoring are evaluator-only. Do not try to
locate or access them. Do not claim moves or scores that were not returned by the game controls."""


def _tool_prompt_with_resume(task: MazeBenchTaskData) -> str:
    instructions = _tool_prompt(task)
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
    """Four narrow controls backed by evaluator-owned MazeBench state."""

    TOOL_PREFIX = "game"

    async def setup_task(self, task: MazeBenchTaskData) -> None:
        self.task = task
        self._lock = asyncio.Lock()
        self._closed = False
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
        self._session = MazeSession(
            game_won_gem_count=GAME_WON_GEM_COUNT,
            level_id=task.level_id,
            observation_mode=task.observation_mode,
            omniscient=task.omniscient,
            hide_names=task.hide_names,
            hide_names_seed=task.hide_names_seed,
            node_bin=task.node_bin,
            repo_root=str(find_bridge_root()),
            timeout_seconds=task.timeout_seconds,
            view=task.view,
            yaw=task.yaw,
        )
        initial = apply_quit_policy(
            await run_blocking(self._session.request, "observe"),
            task.allow_quit,
        )
        self._initial = initial
        self._status = initial
        self._initial_hash = str(initial.get("board_state_hash") or "")
        self._atexit_callback = self.close_session
        atexit.register(self._atexit_callback)
        if self.config.resume_checkpoint_path:
            await self._restore_checkpoint(self.config.resume_checkpoint_path)
        self._write_snapshot()

    def close_game_session(self) -> None:
        session = getattr(self, "_session", None)
        if isinstance(session, MazeSession):
            session.close()
            self._session = None

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

    async def _restore_checkpoint(self, checkpoint_path: str) -> None:
        checkpoint = load_prime_resume_checkpoint(checkpoint_path)
        expected_initial_hash = str(checkpoint.get("initial_board_state_hash") or "")
        if not expected_initial_hash or self._initial_hash != expected_initial_hash:
            raise ValueError("Prime checkpoint initial state does not match this MazeBench runtime")

        status = self._initial
        restored: dict[str, Any] = {"maze_actions": []}
        for index, saved in enumerate(checkpoint.get("actions") or [], start=1):
            if int(saved.get("turn") or 0) != index:
                raise ValueError(f"Prime checkpoint is missing action {index}")
            raw_response = str(saved.get("command_text") or "")
            if saved.get("valid", True) is False or saved.get("error"):
                status = apply_quit_policy(
                    await run_blocking(self._session.request, "observe"),
                    self.task.allow_quit,
                )
                record_maze_action(
                    restored,
                    error=str(saved.get("error") or "invalid response"),
                    raw_response=raw_response,
                    status=status,
                )
            else:
                command, action_args = parse_text_action(raw_response)
                status = apply_quit_policy(
                    await run_blocking(self._session.request, command, **action_args),
                    self.task.allow_quit,
                )
                record_maze_action(
                    restored,
                    action_args=action_args,
                    command=command,
                    raw_response=raw_response,
                    status=status,
                )
            expected_hash = str(saved.get("status", {}).get("board_state_hash") or "")
            if not expected_hash or str(status.get("board_state_hash") or "") != expected_hash:
                raise ValueError(f"Prime checkpoint diverged while replaying action {index}")

        final_hash = str(checkpoint.get("final_board_state_hash") or "")
        if str(status.get("board_state_hash") or "") != final_hash:
            raise ValueError("Prime checkpoint replay did not reach its saved final state")
        self._actions = list(restored["maze_actions"])
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
            or (task.max_actions is not None and len(self._actions) >= int(task.max_actions))
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
                {"version": 1, "state": self._state_payload()},
            )
        write_live_actions(list(self._actions))

    async def _finish_if_needed(self) -> None:
        if not self._terminal() or self._scorecard:
            return
        try:
            status = apply_quit_policy(
                await run_blocking(self._session.request, "scorecard"),
                self.task.allow_quit,
            )
            self._status = status
            scorecard = status.get("scorecard")
            if isinstance(scorecard, dict):
                self._scorecard = scorecard
        except Exception as error:  # evaluator detail stays out of the tool result
            self._status_error = str(error)
        finally:
            await run_blocking(self.close_game_session)

    def _result(self, *, error: str = "") -> dict[str, Any]:
        result = {
            "observation": _public_observation(self._status or {}, self.task.observation_mode),
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
    async def action(self, action: str) -> Any:
        """Apply one allowed game action, such as up, down, left, right, undo, reset, or rotate camera left."""

        async with self._lock:
            if self._terminal():
                return await self._tool_response(
                    self._result(error="The run has ended; no further action is available.")
                )
            if (
                self._identical_action_interval
                and self._identical_action_streak >= self._identical_action_interval
            ):
                return await self._tool_response(
                    self._result(error="Call game_observe before another game_action.")
                )

            raw = str(action or "").strip()
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
        blocked_quit = False
        try:
            command, action_args = parse_text_action(raw)
            if command == "quit" and not self.task.allow_quit:
                blocked_quit = True
                raise ValueError("Quit is disabled for this run.")
            status = apply_quit_policy(
                await run_blocking(self._session.request, command, **action_args),
                self.task.allow_quit,
            )
            self._status = status
            state = {"maze_actions": self._actions}
            record_maze_action(
                state,
                action_args=action_args,
                command=command,
                raw_response=raw,
                status=status,
            )
            self._actions = list(state["maze_actions"])
            error = ""
        except Exception as exception:
            error = str(exception).splitlines()[0][:300]
            self._status_error = error
            try:
                self._status = apply_quit_policy(
                    await run_blocking(self._session.request, "observe"),
                    self.task.allow_quit,
                )
            except Exception:
                pass
            if not blocked_quit:
                state = {"maze_actions": self._actions}
                record_maze_action(
                    state,
                    error=error,
                    raw_response=raw,
                    status=self._status,
                )
                self._actions = list(state["maze_actions"])

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
        normalized: list[str] = []
        for index, action in enumerate(actions):
            if not isinstance(action, str) or not action.strip():
                raise ValueError(f"actions[{index}] must be a non-empty string.")
            normalized.append(action.strip())
        if not isinstance(include_intermediate_observations, bool):
            raise ValueError("include_intermediate_observations must be a boolean.")

        async with self._lock:
            self._last_action_key = None
            self._identical_action_streak = 0
            observations: list[dict[str, Any]] = []
            steps: list[dict[str, Any]] = []
            stop_reason = "completed"

            for index, raw in enumerate(normalized, start=1):
                if self._terminal():
                    stop_reason = "run_ended"
                    break
                action_count_before = len(self._actions)
                error, recorded = await self._apply_action(raw)
                observation = _public_observation(
                    self._status or {}, self.task.observation_mode
                )
                observations.append(observation)
                steps.append(
                    {
                        "index": index,
                        "action": raw,
                        "recorded": recorded,
                        "action_count_before": action_count_before,
                        "action_count_after": len(self._actions),
                        **({"error": error} if error else {}),
                        "status": {
                            "current_room": observation.get("current_room", ""),
                            "current_view": observation.get("current_view", ""),
                            "yaw": observation.get("yaw", 0),
                            "gem_count": observation.get("gem_count", 0),
                            "player_dead": observation.get("player_dead", False),
                            "game_won": observation.get("game_won", False),
                            "game_lost": observation.get("game_lost", False),
                        },
                    }
                )
                if error:
                    stop_reason = "action_error"
                    break
                if self._terminal() and index < len(normalized):
                    stop_reason = "run_ended"
                    break

            self._last_action_key = None
            self._identical_action_streak = 0
            final_observation = observations[-1] if observations else _public_observation(
                self._status or {}, self.task.observation_mode
            )
            result: dict[str, Any] = {
                "requested_count": len(normalized),
                "attempted_count": len(steps),
                "completed_count": len(observations),
                "stopped_early": len(steps) < len(normalized) or stop_reason != "completed",
                "stop_reason": stop_reason,
                "steps": steps,
                **(
                    {
                        "intermediate_observations": [
                            {
                                "index": entry["index"],
                                "action": entry["action"],
                                "observation": observation,
                            }
                            for entry, observation in zip(steps[:-1], observations[:-1])
                        ]
                    }
                    if include_intermediate_observations
                    else {}
                ),
                "final_observation": final_observation,
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
            return await self._tool_response(result)


class MazeBenchToolTaskConfig(MazeBenchTaskConfig):
    tools: MazeBenchToolsetConfig = Field(default_factory=MazeBenchToolsetConfig)


class MazeBenchToolTask(
    MazeBenchTaskBehavior,
    vf.Task[MazeBenchTaskData, MazeBenchToolTraceState, MazeBenchToolTaskConfig],
):
    """A task whose only game access is the evaluator-owned MCP server."""

    tools = (MazeBenchToolset,)
    user = None

    @vf.stop
    async def game_over(self, trace: vf.Trace) -> bool:
        del trace
        return False

    @vf.stop
    async def low_state_novelty(self, trace: vf.Trace) -> bool:
        del trace
        return False

    async def finalize(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        path = self.config.tools.snapshot_path
        try:
            payload = json.loads(Path(path).read_text(encoding="utf-8"))
            trusted_state = MazeBenchState.model_validate(payload["state"])
        except Exception as error:
            trusted_state = MazeBenchState(
                game_lost=True,
                maze_status_error=f"trusted game state unavailable: {error}",
            )

        # The harness knows the interception bearer and could forge /state.
        # Replace it unconditionally with evaluator-owned data before scoring.
        trace.state = trusted_state
        await MazeBenchTaskBehavior.finalize(self, trace, runtime)


class MazeBenchToolTaskset(vf.Taskset[MazeBenchToolTask, MazeBenchToolConfig]):
    """MazeBench scoring with no user simulator and a trusted MCP tool server."""

    def load(self) -> list[MazeBenchToolTask]:
        tasks = MazeBenchTaskset(self.config).load()
        live_actions_path = os.environ.get("MAZEBENCH_LIVE_ACTIONS_PATH", "").strip()
        if live_actions_path and len(tasks) == 1:
            base = Path(live_actions_path).resolve().parent
        else:
            base = Path(tempfile.mkdtemp(prefix="mazebench-tools-"))
        base.mkdir(parents=True, exist_ok=True)

        self._snapshot_paths: dict[int, str] = {}
        sanitized: list[MazeBenchToolTask] = []
        for task in tasks:
            data = task.data
            snapshot_path = str(base / f"trusted-tool-state-{data.idx}.json")
            self._snapshot_paths[int(data.idx)] = snapshot_path
            tool_config = self.config.tools.model_copy(
                update={
                    "snapshot_path": snapshot_path,
                    "resume_checkpoint_path": str(
                        self.config.resume_checkpoint_path or ""
                    ),
                    # Never upload this server beside an untrusted harness.
                    "colocated": False,
                }
            )
            task_config = MazeBenchToolTaskConfig.model_validate(
                {**task.config.model_dump(), "tools": tool_config.model_dump()}
            )
            sanitized.append(
                MazeBenchToolTask(
                    data.model_copy(
                        update={
                            # These evaluator paths must not be serialized through the
                            # task channel that the harness can authenticate to.
                            "repo_root": "",
                            "resume_checkpoint_path": "",
                            "observation": "",
                            "prompt": _tool_prompt_with_resume(data),
                            "system_prompt": "Use only the supplied game controls for game interaction. Treat their results as authoritative.",
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
