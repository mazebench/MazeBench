"""Harness-neutral MazeBench taskset for Prime-managed coding agents."""

from __future__ import annotations

import io
import json
import tarfile
from functools import lru_cache
from pathlib import Path
from typing import Any

import verifiers.v1 as vf
from verifiers.v1.errors import SandboxError
from verifiers.v1.runtimes import Runtime

DEFAULT_LEVEL_ID = "level_HxI"
DEFAULT_VIEW = "top-diagonal"
DEFAULT_YAW = 0
RUNTIME_ROOT = "/app/mazebench-runtime"
ARTIFACT_ROOT = "/app/.mazebench"
SESSION_FILE = f"{ARTIFACT_ROOT}/session.json"
HELPER = f"{RUNTIME_ROOT}/scripts/maze-play.js"
TELEMETRY_PREFIX = "MAZEBENCH_EVENT_V1:"
PLAYWRIGHT_CORE_VERSION = "1.60.0"
GAME_WON_GEM_COUNT = 100
UNSAFE_HARNESS_MESSAGE = (
    "mazebench-agent is disabled because a coding-agent sandbox can inspect the "
    "bundled benchmark runtime and hidden state. Use the isolated mazebench taskset."
)


def _runtime_source() -> Path:
    packaged = Path(__file__).resolve().parent / "runtime"
    if packaged.is_dir():
        return packaged
    source_tree = (
        Path(__file__).resolve().parents[2]
        / "mazebench"
        / "mazebench"
        / "runtime"
    )
    if source_tree.is_dir():
        return source_tree
    raise FileNotFoundError("MazeBench runtime bundle was not packaged")


@lru_cache(maxsize=1)
def _runtime_archive() -> bytes:
    packaged = Path(__file__).resolve().parent / "runtime.tar.gz"
    if packaged.is_file():
        return packaged.read_bytes()
    source = _runtime_source()
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for item in sorted(source.rglob("*")):
            if item.is_file():
                archive.add(item, arcname=item.relative_to(source))
    return buffer.getvalue()


def _prompt(data: "MazeBenchAgentData") -> str:
    unlimited = data.max_actions is None
    start = [
        "node",
        HELPER,
        "start",
        "--repo-root",
        RUNTIME_ROOT,
        "--state",
        SESSION_FILE,
        "--level",
        data.level_id,
        "--view",
        data.view,
        "--yaw",
        str(data.yaw),
        "--game-won-gem-count",
        str(data.game_won_gem_count),
        "--max-actions",
        "unlimited" if unlimited else str(data.max_actions),
    ]
    if data.observation_mode == "vision":
        start.append("--vision")
    else:
        start.extend(["--observation-mode", data.observation_mode])
    if data.omniscient:
        start.append("--omniscient")
    if data.hide_names:
        start.extend(["--hide-names", "--hide-names-seed", data.hide_names_seed])
    if not data.allow_quit:
        start.append("--no-quit")
    start_command = " ".join(start)

    extra = (
        f"\nAdditional run instructions:\n\n{data.extra_instructions.strip()}\n"
        if data.extra_instructions.strip()
        else ""
    )
    vision = (
        """
This is a visual-only rollout. The start command and every action response include
an absolute `frame_image` PNG path. Before choosing the first action, and again after
every action, inspect that exact PNG with your built-in image tool (`view_image` in
Codex; `Read` in Claude Code). Do not infer the board from filenames or telemetry.
Do not inspect session artifacts, renderer state, runtime source, or level files to
reconstruct the board; the PNG is the only permitted board observation.
If an image cannot be inspected, stop and report the visual-observation failure.
"""
        if data.observation_mode == "vision"
        else ""
    )
    if unlimited:
        action_policy = """Then inspect the observation and keep playing without a move ceiling. Run one
shell command per action:"""
        termination_policy = (
            """Stop if the game is won, the player dies, or no useful move remains."""
            if data.allow_quit
            else """QUIT IS DISABLED and there is no action ceiling. Do not finish because no useful
move remains, the player dies, or you would prefer to report the score. If the player
dies, recover with an available action such as undo or reset and continue until the
game is won or the run is stopped externally."""
        )
        helper_policy = "The helper does not enforce a move ceiling."
        finish_condition = "the game is won or the run is stopped"
    else:
        action_policy = (
            f"""Then inspect the observation and play up to {data.max_actions} maze actions. Run one
shell command per action:"""
            if data.allow_quit
            else f"""Then inspect the observation and take exactly {data.max_actions} maze actions unless
the game is won earlier. Run one shell command per action:"""
        )
        termination_policy = (
            """Stop early if the game is won, the player dies, or no useful move remains."""
            if data.allow_quit
            else f"""QUIT IS DISABLED. The {data.max_actions}-action budget is a required action count,
not an optional maximum. Do not stop because no useful move remains, the player dies,
or you would prefer to report the score. If the player dies, recover with an available
action such as undo or reset and continue. Blocked moves and other accepted helper
actions count toward the budget. Do not finish while the game is not won and fewer
than {data.max_actions} actions have been accepted."""
        )
        helper_policy = "The helper enforces the action budget."
        finish_condition = "the game is won or the action budget is exhausted"
    return f"""Play MazeBench using shell commands. The task runtime is already installed.

Run this exact command first:

```bash
{start_command}
```

{action_policy}

```bash
node {HELPER} action --state {SESSION_FILE} up
node {HELPER} action --state {SESSION_FILE} down
node {HELPER} action --state {SESSION_FILE} left
node {HELPER} action --state {SESSION_FILE} right
node {HELPER} action --state {SESSION_FILE} rotate camera left
node {HELPER} action --state {SESSION_FILE} undo
node {HELPER} action --state {SESSION_FILE} reset
node {HELPER} action --state {SESSION_FILE} go to level H I
```

Goal: collect {data.target_gems} gems and explore as many rooms as possible.
{termination_policy} {helper_policy} Lines beginning with
`{TELEMETRY_PREFIX}` are telemetry; do not interpret or copy them.{vision}{extra}

Scoring is evaluator-only. Do not attempt to access a scorecard. When {finish_condition},
finish with a short summary of the route and gems
collected. Do not edit the runtime or session artifacts directly.
"""


class MazeBenchAgentData(vf.TaskData):
    level_id: str = DEFAULT_LEVEL_ID
    view: str = DEFAULT_VIEW
    yaw: int = DEFAULT_YAW
    game_won_gem_count: int = GAME_WON_GEM_COUNT
    target_gems: int = GAME_WON_GEM_COUNT
    max_actions: int | None = 20
    observation_mode: str = "text"
    omniscient: bool = False
    hide_names: bool = False
    hide_names_seed: str = "1"
    allow_quit: bool = True
    extra_instructions: str = ""


def _slim_status(value: Any) -> dict[str, Any]:
    status = value if isinstance(value, dict) else {}
    keep = (
        "allowed_commands",
        "board_state_hash",
        "board_state_hash_version",
        "current_room",
        "current_view",
        "game_won",
        "gem_count",
        "level",
        "moved",
        "observation_mode",
        "player",
        "player_dead",
        "visited_levels",
        "yaw",
    )
    return {key: status[key] for key in keep if key in status}


def _canonical_action(message: dict[str, Any], raw: str) -> str:
    command = str(message.get("command") or "")
    if command == "move":
        return str(message.get("direction") or raw)
    if command == "rotate_camera":
        return f"rotate camera {message.get('direction', '')}".strip()
    if command == "goto_level":
        return f"go to level {message.get('x', '')} {message.get('y', '')}".strip()
    if command == "reset_level":
        return "reset"
    return command or raw


def _normalize_actions(actions: Any) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for index, action in enumerate(actions if isinstance(actions, list) else [], start=1):
        if not isinstance(action, dict):
            continue
        message = action.get("message") if isinstance(action.get("message"), dict) else {}
        raw = str(action.get("command_text") or "").strip()
        command = str(message.get("command") or "")
        args = {key: value for key, value in message.items() if key != "command"}
        normalized.append(
            {
                "turn": int(action.get("turn") or index),
                "timestamp": action.get("timestamp"),
                "valid": action.get("valid", True) is not False,
                "raw_response": raw,
                "command": _canonical_action(message, raw),
                "normalized_action": command,
                "args": args,
                "error": action.get("error"),
                "status": _slim_status(action.get("status")),
            }
        )
    return normalized


async def _read_json(runtime: Runtime, path: str, fallback: Any) -> Any:
    try:
        return json.loads((await runtime.read(path)).decode("utf-8"))
    except (SandboxError, OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return fallback


class MazeBenchAgentTask(vf.Task[MazeBenchAgentData]):
    NEEDS_CONTAINER = True

    async def setup(self, trace: vf.Trace, runtime: Runtime) -> None:
        del trace
        archive = "/tmp/mazebench-runtime.tar.gz"
        await runtime.write(archive, _runtime_archive())
        setup = (
            f"mkdir -p {RUNTIME_ROOT} {ARTIFACT_ROOT} && "
            f"tar -xzf {archive} -C {RUNTIME_ROOT}"
        )
        env: dict[str, str] = {}
        if self.data.observation_mode == "vision":
            setup += (
                f" && npm install --prefix {RUNTIME_ROOT} --no-save --no-audit --no-fund "
                f"playwright-core@{PLAYWRIGHT_CORE_VERSION}"
            )
            env["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"] = "1"
        result = await runtime.run(
            ["sh", "-lc", setup],
            env,
        )
        if result.exit_code != 0:
            detail = (result.stderr or result.stdout).strip()[-1000:]
            raise RuntimeError(f"could not install MazeBench runtime: {detail}")

    async def finalize(self, trace: vf.Trace, runtime: Runtime) -> None:
        session = await _read_json(runtime, SESSION_FILE, {})
        if session:
            await runtime.run(
                ["node", HELPER, "finalize", "--state", SESSION_FILE],
                {"MAZEBENCH_TRUSTED_FINALIZE": "1"},
            )
            session = await _read_json(runtime, SESSION_FILE, session)
        scorecard = await _read_json(runtime, f"{ARTIFACT_ROOT}/scorecard.json", {})
        if not scorecard and isinstance(session, dict):
            scorecard = session.get("scorecard") or {}
        actions = _normalize_actions(session.get("actions") if isinstance(session, dict) else [])
        initial = _slim_status(session.get("initial") if isinstance(session, dict) else {})
        status = _slim_status(session.get("lastStatus") if isinstance(session, dict) else {})

        trace.info["maze_actions"] = actions
        trace.info["maze_scorecard"] = scorecard
        trace.info["maze_status"] = status
        trace.info["maze_replay"] = {
            "game_id": "maze",
            "game_won_gem_count": GAME_WON_GEM_COUNT,
            "initial": initial,
            "start_level_id": self.data.level_id,
            "target_gems": self.data.target_gems,
            "actions": actions,
            "scorecard": scorecard,
        }

    @vf.reward(weight=1.0)
    async def gem_score(self, trace: vf.Trace) -> float:
        scorecard = trace.info.get("maze_scorecard") or {}
        collected = float(scorecard.get("collected_gems") or scorecard.get("gem_count") or 0)
        return min(1.0, collected / max(1, self.data.target_gems))

    @vf.reward(weight=0.01)
    async def room_exploration_score(self, trace: vf.Trace) -> float:
        status = trace.info.get("maze_status") or {}
        return float(max(0, len(status.get("visited_levels") or []) - 1))

    @vf.metric
    async def collected_gems(self, trace: vf.Trace) -> float:
        scorecard = trace.info.get("maze_scorecard") or {}
        return float(scorecard.get("collected_gems") or scorecard.get("gem_count") or 0)

    @vf.metric
    async def action_count(self, trace: vf.Trace) -> float:
        return float(len(trace.info.get("maze_actions") or []))


class MazeBenchAgentConfig(vf.TasksetConfig):
    num_examples: int = 1
    start_level_id: str = DEFAULT_LEVEL_ID
    game_won_gem_count: int = GAME_WON_GEM_COUNT
    target_gems: int | None = None
    max_actions: int | None = 20
    observation_mode: str = "text"
    omniscient: bool = False
    hide_names: bool = False
    hide_names_seed: str = "1"
    allow_quit: bool = True
    extra_instructions: str = ""
    view: str = DEFAULT_VIEW
    yaw: int = DEFAULT_YAW


class MazeBenchAgentTaskset(
    vf.Taskset[MazeBenchAgentTask, MazeBenchAgentConfig]
):
    def load(self) -> list[MazeBenchAgentTask]:
        raise RuntimeError(UNSAFE_HARNESS_MESSAGE)
        tasks: list[MazeBenchAgentTask] = []
        count = max(1, int(self.config.num_examples))
        target = int(self.config.target_gems or GAME_WON_GEM_COUNT)
        for index in range(count):
            data = MazeBenchAgentData(
                idx=index,
                name=f"maze:{self.config.start_level_id}#{index}",
                prompt="",
                system_prompt=(
                    "You are an autonomous coding agent controlling a grid game through "
                    "the provided shell helper. Follow the command contract exactly."
                ),
                workdir="/app",
                level_id=self.config.start_level_id,
                view=self.config.view,
                yaw=int(self.config.yaw),
                game_won_gem_count=GAME_WON_GEM_COUNT,
                target_gems=max(1, target),
                max_actions=(
                    None
                    if self.config.max_actions is None
                    else max(1, int(self.config.max_actions))
                ),
                observation_mode=str(self.config.observation_mode),
                omniscient=bool(self.config.omniscient),
                hide_names=bool(self.config.hide_names),
                hide_names_seed=str(self.config.hide_names_seed),
                allow_quit=bool(self.config.allow_quit),
                extra_instructions=str(self.config.extra_instructions),
                timeout=vf.TaskTimeout(
                    setup=1800,
                    harness=None if self.config.max_actions is None else 3600,
                    finalize=120,
                    scoring=60,
                ),
                resources=vf.TaskResources(cpu=2, memory=4, disk=8),
            )
            data = data.model_copy(update={"prompt": _prompt(data)})
            tasks.append(MazeBenchAgentTask(data, self.config.task))
        return tasks


__all__ = ["MazeBenchAgentTaskset"]
