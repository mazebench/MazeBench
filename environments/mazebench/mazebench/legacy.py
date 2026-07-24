"""Hosted Training compatibility for the current Prime legacy env-server API.

MazeBench's native implementation lives in :mod:`mazebench.mazebench` and uses
the Verifiers v1 Taskset/Harness API. Prime Hosted Training 0.6.x still starts
Hub environments through ``verifiers.load_environment``. This adapter exposes
the same game, rewards, metrics, and stop conditions as a classic MultiTurnEnv
without changing the native v1 taskset used by ``uv run eval``.
"""

from __future__ import annotations

import json
import os
from typing import Any

from datasets import Dataset

import verifiers as vf
from verifiers.utils.message_utils import concat_messages, normalize_messages

from .auto_quit import (
    AUTO_QUIT_DEFAULT_MODE,
    AUTO_QUIT_DEFAULT_THRESHOLD,
    AUTO_QUIT_DEFAULT_WINDOW,
    evaluate_auto_quit,
    normalize_auto_quit_config,
)
from .mazebench import (
    DEFAULT_GAME_ID,
    DEFAULT_MAX_ACTIONS,
    DEFAULT_NODE_BIN,
    DEFAULT_START_LEVEL_ID,
    DEFAULT_TARGET_GEMS,
    DEFAULT_TIMEOUT_SECONDS,
    DEFAULT_VIEW,
    DEFAULT_YAW,
    GAME_WON_GEM_COUNT,
    INFO_KEY,
    MULTITURN_SYSTEM_PROMPT,
    MazeSession,
    action_result_text,
    apply_quit_policy,
    build_rows,
    env_bool,
    env_float,
    env_int,
    find_bridge_root,
    parse_level_ids,
    parse_text_action,
    record_maze_action,
    render_json_user_prompt,
    render_multiturn_user_prompt,
    scorecard_text,
    set_maze_scorecard,
    slim_status,
    target_text_for_row,
)


def _message_content(message: object) -> str:
    content = message.get("content", "") if isinstance(message, dict) else getattr(message, "content", "")
    if isinstance(content, list):
        return "\n".join(
            str(part.get("text") or part.get("content") or "")
            if isinstance(part, dict)
            else str(part)
            for part in content
        )
    return str(content or "")


def _row_mapping(value: object) -> dict[str, Any]:
    if isinstance(value, str):
        try:
            return _row_mapping(json.loads(value))
        except json.JSONDecodeError:
            return {}
    if isinstance(value, dict):
        return dict(value)
    if hasattr(value, "keys"):
        try:
            return {str(key): value[key] for key in value.keys()}
        except Exception:
            return {}
    return {}


def _row_from_state(state: vf.State) -> dict[str, Any]:
    row = _row_mapping(state.get("maze_row"))
    if row:
        return row

    for key in ("input", "task"):
        candidate = _row_mapping(state.get(key))
        info = _row_mapping(candidate.get("info"))
        packaged = _row_mapping(info.get(INFO_KEY))
        if packaged:
            candidate.update(packaged)
        if candidate:
            return candidate
    return {}


def _legacy_prompt(row: dict[str, Any], *, allow_quit: bool) -> list[dict[str, str]]:
    status = apply_quit_policy(
        {
            "current_room": row["level_id"],
            "current_view": row["view"],
            "gem_count": 0,
            "level": row["observation"],
            "player": None,
            "visited_levels": [row["level_id"]],
            "yaw": row["yaw"],
        },
        allow_quit,
    )
    return [
        {
            "role": "user",
            "content": render_multiturn_user_prompt(
                status=status,
                target_text=target_text_for_row(row),
                result_text="Start of run.",
            ),
        }
    ]


def _legacy_rows(rows: list[dict[str, Any]], *, allow_quit: bool) -> list[dict[str, Any]]:
    prepared = []
    for row in rows:
        copy = dict(row)
        copy["prompt"] = _legacy_prompt(copy, allow_quit=allow_quit)
        prepared.append(copy)
    return prepared


def gem_score(state: vf.State, **_: Any) -> float:
    status = state.get("maze_status") or {}
    row = _row_from_state(state)
    count = int(status.get("gem_count") or 0)
    target = int(row.get("target_gems") or 0)
    return float(count) if target <= 0 else min(1.0, count / target)


def room_exploration_score(state: vf.State, **_: Any) -> float:
    status = state.get("maze_status") or {}
    return float(max(0, len(status.get("visited_levels") or []) - 1))


def block_progress_score(state: vf.State, **_: Any) -> float:
    status = state.get("maze_status") or {}
    return float(status.get("novel_push_count") or 0)


def collected_gems(state: vf.State, **_: Any) -> float:
    return float((state.get("maze_status") or {}).get("gem_count") or 0)


def visited_level_count(state: vf.State, **_: Any) -> float:
    return float(len((state.get("maze_status") or {}).get("visited_levels") or []))


def block_pushes(state: vf.State, **_: Any) -> float:
    return float((state.get("maze_status") or {}).get("push_count") or 0)


def novel_block_positions(state: vf.State, **_: Any) -> float:
    return float((state.get("maze_status") or {}).get("novel_push_count") or 0)


class LegacyMazeEnv(vf.MultiTurnEnv):
    """Classic MultiTurnEnv adapter used by Prime's hosted legacy bridge."""

    def __init__(
        self,
        *,
        allow_quit: bool,
        auto_quit: bool,
        auto_quit_threshold: float,
        auto_quit_mode: str,
        auto_quit_window: int,
        observation_mode: str,
        omniscient: bool,
        hide_names: bool,
        max_actions: int | None,
        rubric: vf.Rubric,
        **kwargs: Any,
    ) -> None:
        super().__init__(max_turns=-1, rubric=rubric, **kwargs)
        self.allow_quit = bool(allow_quit)
        auto_quit_config = normalize_auto_quit_config(
            enabled=auto_quit,
            threshold=auto_quit_threshold,
            mode=auto_quit_mode,
            window=auto_quit_window,
        )
        self.auto_quit = bool(auto_quit_config["enabled"])
        self.auto_quit_threshold = float(auto_quit_config["threshold"])
        self.auto_quit_mode = str(auto_quit_config["mode"])
        self.auto_quit_window = int(auto_quit_config["window"])
        self.observation_mode = str(observation_mode)
        self.omniscient = bool(omniscient)
        self.hide_names = bool(hide_names)
        self.max_actions = None if max_actions is None else max(1, int(max_actions))

    def auto_quit_evaluation(self, state: vf.State) -> dict[str, Any] | None:
        return evaluate_auto_quit(
            state.get("maze_initial_board_state_hash"),
            state.get("maze_actions"),
            enabled=self.auto_quit,
            threshold=self.auto_quit_threshold,
            mode=self.auto_quit_mode,
            window=self.auto_quit_window,
        )

    def status_prompt(
        self,
        row: dict[str, Any],
        status: dict[str, Any],
        result_text: str,
    ) -> str:
        renderer = (
            render_json_user_prompt
            if self.observation_mode == "json"
            else render_multiturn_user_prompt
        )
        return renderer(
            status=status,
            target_text=target_text_for_row(row),
            result_text=result_text,
        )

    async def get_prompt_messages(self, state: vf.State) -> vf.Messages:
        if not state["trajectory"]:
            return normalize_messages(state["prompt"], field_name="prompt_messages")

        previous = state["trajectory"][-1]
        messages = concat_messages([previous["prompt"], previous["completion"]])
        env_response = normalize_messages(
            await self.env_response(messages, state),
            field_name="env_response",
        )
        state.setdefault("maze_conversation_log", []).extend(env_response)
        return normalize_messages(
            concat_messages([messages, env_response]),
            field_name="prompt_messages",
        )

    async def render_completion(self, state: vf.State) -> None:
        log = state.get("maze_conversation_log")
        if log is not None:
            state["completion"] = normalize_messages(log, field_name="maze_conversation_log")
            return
        await super().render_completion(state)

    async def setup_state(self, state: vf.State, **_: Any) -> None:
        state["maze_auto_quit"] = {}
        state["maze_actions"] = []
        state["maze_conversation_log"] = []
        state["maze_scorecard"] = {}
        row = _row_from_state(state)
        state["maze_row"] = row
        session = MazeSession(
            game_won_gem_count=GAME_WON_GEM_COUNT,
            level_id=str(row.get("level_id") or DEFAULT_START_LEVEL_ID),
            observation_mode=self.observation_mode,
            omniscient=self.omniscient,
            hide_names=self.hide_names,
            hide_names_seed="1",
            node_bin=str(row.get("node_bin") or DEFAULT_NODE_BIN),
            repo_root=str(row.get("repo_root") or find_bridge_root()),
            timeout_seconds=int(row.get("timeout_seconds") or DEFAULT_TIMEOUT_SECONDS),
            view=str(row.get("view") or DEFAULT_VIEW),
            yaw=int(row.get("yaw") or DEFAULT_YAW),
        )
        state["maze_session"] = session
        status = apply_quit_policy(session.request("observe"), self.allow_quit)
        state["maze_status"] = status
        state["maze_initial_board_state_hash"] = str(
            status.get("board_state_hash") or ""
        ).strip()
        state["prompt"] = [
            {
                "role": "user",
                "content": self.status_prompt(
                    row,
                    status,
                    "Start of run.",
                ),
            }
        ]
        state["maze_replay"] = {
            "game_id": row.get("game_id") or DEFAULT_GAME_ID,
            "game_won_gem_count": GAME_WON_GEM_COUNT,
            "initial": slim_status(status),
            "start_level_id": str(row.get("level_id") or DEFAULT_START_LEVEL_ID),
            "target_gems": int(row.get("target_gems") or DEFAULT_TARGET_GEMS),
            "actions": state["maze_actions"],
            "scorecard": None,
        }

    async def env_response(
        self,
        messages: vf.Messages,
        state: vf.State,
        **_: Any,
    ) -> vf.Messages:
        last_message = messages[-1]
        session = state.get("maze_session")
        row = _row_from_state(state)
        status = state.get("maze_status") or {}

        if isinstance(session, MazeSession):
            try:
                raw_response = _message_content(last_message)
                command, action_args = parse_text_action(raw_response)
                if command == "quit" and not self.allow_quit:
                    raise ValueError("quit is disabled for this run")
                status = apply_quit_policy(
                    session.request(command, **action_args),
                    self.allow_quit,
                )
                state["maze_status"] = status
                record_maze_action(
                    state,
                    action_args=action_args,
                    command=command,
                    raw_response=raw_response,
                    status=status,
                )
                result_text = action_result_text(command=command, status=status)
            except Exception as error:
                state["maze_status_error"] = str(error)
                try:
                    status = apply_quit_policy(session.request("observe"), self.allow_quit)
                    state["maze_status"] = status
                except Exception:
                    pass
                record_maze_action(
                    state,
                    error=str(error),
                    raw_response=_message_content(last_message),
                    status=status,
                )
                result_text = action_result_text(error=str(error))
        else:
            result_text = action_result_text(error="maze session is not available")

        state["game_lost"] = bool(
            self.allow_quit and (status.get("game_lost") or status.get("quit"))
        )
        state["game_won"] = int(status.get("gem_count") or 0) >= GAME_WON_GEM_COUNT

        terminal = state["game_lost"] or state["game_won"]
        auto_quit = None if terminal else self.auto_quit_evaluation(state)
        if auto_quit is not None:
            state["maze_auto_quit"] = auto_quit
        auto_quit_triggered = bool(state.get("maze_auto_quit"))
        if (terminal or auto_quit_triggered) and not status.get("scorecard") and isinstance(session, MazeSession):
            status = apply_quit_policy(session.request("scorecard"), self.allow_quit)
            state["maze_status"] = status
        set_maze_scorecard(state, status.get("scorecard"))

        if auto_quit_triggered:
            percentage = float((state.get("maze_auto_quit") or {}).get("percentage") or 0)
            response = [
                vf.UserMessage(
                    content=(
                        "Auto-quit: state novelty reached "
                        f"{percentage:.1f}% new states. No further action is available."
                    )
                )
            ]
        elif terminal:
            response = [vf.UserMessage(content="The game has ended. No further action is available.")]
        else:
            response = [
                vf.UserMessage(
                    content=self.status_prompt(
                        row,
                        status,
                        result_text,
                    )
                )
            ]

        budget_exhausted = (
            self.max_actions is not None
            and len(state.get("maze_actions") or []) >= self.max_actions
        )
        if terminal or auto_quit_triggered or budget_exhausted:
            state["final_env_response"] = response
        return response

    @vf.stop(priority=50)
    async def game_lost(self, state: vf.State) -> bool:
        return bool(state.get("game_lost"))

    @vf.stop(priority=40)
    async def game_won(self, state: vf.State) -> bool:
        return bool(state.get("game_won"))

    @vf.stop(priority=35)
    async def low_state_novelty(self, state: vf.State) -> bool:
        if state.get("maze_auto_quit"):
            return True
        evaluation = self.auto_quit_evaluation(state)
        if evaluation is None:
            return False
        state["maze_auto_quit"] = evaluation
        return True

    @vf.stop(priority=30)
    async def action_budget(self, state: vf.State) -> bool:
        return bool(
            self.max_actions is not None
            and len(state.get("maze_actions") or []) >= self.max_actions
        )

    @vf.cleanup
    async def close_maze_session(self, state: vf.State) -> None:
        session = state.get("maze_session")
        if not isinstance(session, MazeSession):
            return
        try:
            status = apply_quit_policy(session.request("scorecard"), self.allow_quit)
            state["maze_status"] = status
            set_maze_scorecard(state, status.get("scorecard"))
        except Exception:
            pass
        session.close()


def load_environment(
    num_train_examples: int = 1,
    num_eval_examples: int = 1,
    level_ids: str | list[str] | None = None,
    start_level_id: str | None = None,
    view: str = DEFAULT_VIEW,
    yaw: int = DEFAULT_YAW,
    game_won_gem_count: int | None = None,
    gem_reward_weight: float | None = None,
    room_reward_weight: float | None = None,
    push_reward_weight: float | None = None,
    max_actions: int | None = None,
    max_turns: int | None = None,
    unlimited: bool = False,
    allow_quit: bool | None = None,
    auto_quit: bool | None = None,
    auto_quit_threshold: float | None = None,
    auto_quit_mode: str | None = None,
    auto_quit_window: int | None = None,
    observation_mode: str | None = None,
    omniscient: bool = False,
    hide_names: bool = False,
    node_bin: str = DEFAULT_NODE_BIN,
    repo_root: str | None = None,
    target_gems: int = DEFAULT_TARGET_GEMS,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    system_prompt: str | None = None,
    **kwargs: Any,
) -> vf.Environment:
    """Load the hosted-compatible ASCII or JSON MazeBench environment."""
    mode = str(observation_mode or os.environ.get("MAZEBENCH_OBSERVATION_MODE") or "ascii").lower()
    if mode not in {"ascii", "json"}:
        raise ValueError("Hosted Training supports MazeBench ASCII and JSON observations.")

    resolved_start = str(start_level_id or os.environ.get("MAZEBENCH_START_LEVEL_ID") or DEFAULT_START_LEVEL_ID)
    resolved_win_count = GAME_WON_GEM_COUNT
    resolved_max_actions = None if unlimited else int(
        max_actions
        if max_actions is not None
        else max_turns
        if max_turns is not None
        else env_int("MAZEBENCH_MAX_ACTIONS", DEFAULT_MAX_ACTIONS, minimum=1)
    )
    resolved_allow_quit = (
        bool(allow_quit)
        if allow_quit is not None
        else env_bool("MAZEBENCH_ALLOW_QUIT", True)
    )
    auto_quit_config = normalize_auto_quit_config(
        enabled=(
            auto_quit
            if auto_quit is not None
            else env_bool("MAZEBENCH_AUTO_QUIT", False)
        ),
        threshold=(
            auto_quit_threshold
            if auto_quit_threshold is not None
            else env_float(
                "MAZEBENCH_AUTO_QUIT_THRESHOLD",
                AUTO_QUIT_DEFAULT_THRESHOLD,
            )
        ),
        mode=(
            auto_quit_mode
            if auto_quit_mode is not None
            else os.environ.get("MAZEBENCH_AUTO_QUIT_MODE", AUTO_QUIT_DEFAULT_MODE)
        ),
        window=(
            auto_quit_window
            if auto_quit_window is not None
            else env_int(
                "MAZEBENCH_AUTO_QUIT_WINDOW",
                AUTO_QUIT_DEFAULT_WINDOW,
                minimum=1,
            )
        ),
    )
    weights = {
        "gems": float(
            gem_reward_weight
            if gem_reward_weight is not None
            else env_float("MAZEBENCH_GEM_REWARD_WEIGHT", 1.0)
        ),
        "rooms": float(
            room_reward_weight
            if room_reward_weight is not None
            else env_float("MAZEBENCH_ROOM_REWARD_WEIGHT", 0.1)
        ),
        "pushes": float(
            push_reward_weight
            if push_reward_weight is not None
            else env_float("MAZEBENCH_PUSH_REWARD_WEIGHT", 0.05)
        ),
    }

    resolved_root = find_bridge_root(repo_root)
    row_options = {
        "game_won_gem_count": resolved_win_count,
        "level_ids": parse_level_ids(level_ids, resolved_start),
        "node_bin": node_bin,
        "repo_root": resolved_root,
        "target_gems": int(target_gems),
        "timeout_seconds": int(timeout_seconds),
        "view": view,
        "yaw": int(yaw),
    }
    train_rows = _legacy_rows(
        build_rows(count=max(1, int(num_train_examples)), **row_options),
        allow_quit=resolved_allow_quit,
    )
    eval_rows = _legacy_rows(
        build_rows(count=max(1, int(num_eval_examples)), **row_options),
        allow_quit=resolved_allow_quit,
    )

    rubric = vf.Rubric()
    rubric.add_reward_func(gem_score, weight=weights["gems"])
    rubric.add_reward_func(room_exploration_score, weight=weights["rooms"])
    rubric.add_reward_func(block_progress_score, weight=weights["pushes"])
    rubric.add_metric(collected_gems)
    rubric.add_metric(visited_level_count)
    rubric.add_metric(block_pushes)
    rubric.add_metric(novel_block_positions)

    return LegacyMazeEnv(
        dataset=Dataset.from_list(train_rows),
        eval_dataset=Dataset.from_list(eval_rows),
        system_prompt=system_prompt or MULTITURN_SYSTEM_PROMPT,
        allow_quit=resolved_allow_quit,
        auto_quit=bool(auto_quit_config["enabled"]),
        auto_quit_threshold=float(auto_quit_config["threshold"]),
        auto_quit_mode=str(auto_quit_config["mode"]),
        auto_quit_window=int(auto_quit_config["window"]),
        observation_mode=mode,
        omniscient=bool(omniscient),
        hide_names=bool(hide_names),
        max_actions=resolved_max_actions,
        rubric=rubric,
        **kwargs,
    )


__all__ = ["LegacyMazeEnv", "load_environment"]
