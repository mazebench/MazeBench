from __future__ import annotations

import atexit
import asyncio
import functools
import json
import os
import re
import select
import signal
import shlex
import subprocess
import threading
from datetime import datetime, timezone
from importlib.resources import files
from pathlib import Path
from string import Template
from typing import Any, Literal

from pydantic import Field, model_validator

import verifiers.v1 as vf

from .auto_quit import (
    AUTO_QUIT_DEFAULT_MODE,
    AUTO_QUIT_DEFAULT_THRESHOLD,
    AUTO_QUIT_DEFAULT_WINDOW,
    AUTO_QUIT_MAX_WINDOW,
    evaluate_auto_quit,
)


def env_int(name: str, default: int, *, minimum: int = 0) -> int:
    try:
        value = int(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default
    return value if value >= minimum else default


def env_float(name: str, default: float, *, minimum: float = 0.0) -> float:
    try:
        value = float(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default
    return value if value >= minimum else default


def env_bool(name: str, default: bool) -> bool:
    value = str(os.environ.get(name, "")).strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return default


DEFAULT_GAME_ID = "maze"
DEFAULT_START_LEVEL_ID = os.environ.get("MAZEBENCH_START_LEVEL_ID", "level_HxI")
DEFAULT_VIEW = "top-diagonal"
DEFAULT_YAW = 0
DEFAULT_NODE_BIN = "node"
DEFAULT_TIMEOUT_SECONDS = 20
DEFAULT_MAX_TURNS = 40
DEFAULT_MAX_ACTIONS = env_int("MAZEBENCH_MAX_ACTIONS", 256, minimum=1)
DEFAULT_TARGET_GEMS = 0
_configured_observation_mode = str(
    os.environ.get("MAZEBENCH_OBSERVATION_MODE", "ascii")
).lower()
DEFAULT_OBSERVATION_MODE = (
    _configured_observation_mode
    if _configured_observation_mode in {"ascii", "json", "vision"}
    else "ascii"
)
DEFAULT_VISION_HEIGHT = 512
DEFAULT_VISION_WIDTH = 512
# How far vision frames see: 1..26 rings of neighbor rooms (1 = the classic
# 3x3 benchmark window) or "world" for the whole map.
DEFAULT_VISION_VIEW = "1"
DEFAULT_GAME_WON_GEM_COUNT = 100
DEFAULT_GEM_REWARD_WEIGHT = env_float("MAZEBENCH_GEM_REWARD_WEIGHT", 1.0)
DEFAULT_ROOM_REWARD_WEIGHT = env_float("MAZEBENCH_ROOM_REWARD_WEIGHT", 0.1)
DEFAULT_PUSH_REWARD_WEIGHT = env_float("MAZEBENCH_PUSH_REWARD_WEIGHT", 0.05)
REPO_ROOT_ENV = "MAZEBENCH_REPO_ROOT"
INFO_KEY = "mazebench"
LIVE_ACTIONS_PATH_ENV = "MAZEBENCH_LIVE_ACTIONS_PATH"
PRIME_RESUME_CHECKPOINT_VERSION = 1


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def write_live_actions(actions: list[dict[str, Any]]) -> None:
    path = str(os.environ.get(LIVE_ACTIONS_PATH_ENV) or "").strip()
    if not path:
        return
    records: list[str] = []
    for action in actions:
        try:
            turn = int(action.get("turn"))
        except (TypeError, ValueError):
            continue
        records.append(
            json.dumps(
                {
                    "turn": turn,
                    "timestamp": action.get("timestamp"),
                    "command_text": action.get("command") or action.get("raw_response") or "",
                    "valid": action.get("valid", True),
                    "error": action.get("error"),
                    "status": action.get("status") or {},
                },
                separators=(",", ":"),
            )
        )
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    temporary.write_text("\n".join(records) + ("\n" if records else ""), encoding="utf-8")
    os.replace(temporary, target)


def load_game_won_gem_count() -> int:
    """Return the fixed global win threshold used by every harness and mode."""
    return DEFAULT_GAME_WON_GEM_COUNT


GAME_WON_GEM_COUNT = load_game_won_gem_count()

DEATH_MESSAGE = "The player died, you must now undo or reset or go to a level."
ALIVE_ALLOWED_COMMANDS = (
    "up",
    "down",
    "left",
    "right",
    "rotate camera up",
    "rotate camera down",
    "rotate camera left",
    "rotate camera right",
    "undo",
    "reset",
    "go to level X Y",
    "quit",
)
DEAD_ALLOWED_COMMANDS = (
    "undo",
    "reset",
    "go to level X Y",
)

PROMPT_DIR = "prompts"
MULTITURN_SYSTEM_PROMPT_FILE = "multiturn_system.txt"
MULTITURN_USER_PROMPT_FILE = "multiturn_user.txt"
INFO_ROW_FIELD_NAMES = {
    "game_won_gem_count",
    "level_id",
    "node_bin",
    "repo_root",
    "target_gems",
    "timeout_seconds",
    "view",
    "yaw",
}
def read_prompt_file(filename: str) -> str:
    return (
        files(__package__ or "mazebench")
        .joinpath(PROMPT_DIR, filename)
        .read_text(encoding="utf8")
        .rstrip()
    )


def render_prompt_file(filename: str, **values: object) -> str:
    return Template(read_prompt_file(filename)).substitute(
        {key: str(value) for key, value in values.items()}
    )


MULTITURN_SYSTEM_PROMPT = read_prompt_file(MULTITURN_SYSTEM_PROMPT_FILE)

LEVEL_ID_PATTERN = re.compile(r"^(?:level_)?([A-Z])x([A-Z])$")


def normalize_level_id(value: str | None) -> str:
    level_id = str(value or DEFAULT_START_LEVEL_ID).strip()
    match = LEVEL_ID_PATTERN.fullmatch(level_id)

    if not match:
        return level_id

    return f"level_{match.group(1)}x{match.group(2)}"


def parse_level_ids(
    level_ids: str | list[str] | tuple[str, ...] | None,
    start_level_id: str,
) -> list[str]:
    if level_ids is None:
        return [normalize_level_id(start_level_id)]

    if isinstance(level_ids, str):
        values = [
            part.strip()
            for part in re.split(r"[,\\s]+", level_ids)
            if part.strip()
        ]
    else:
        values = [str(part).strip() for part in level_ids if str(part).strip()]

    return [normalize_level_id(value) for value in values] or [
        normalize_level_id(start_level_id)
    ]


def has_terminal_runner(root: Path) -> bool:
    return (root / "scripts" / "maze-terminal.js").is_file()


def has_bridge_runner(root: Path) -> bool:
    return (root / "scripts" / "maze-bridge.js").is_file()


def find_repo_root(configured_root: str | None = None) -> Path:
    candidates: list[Path] = []

    if configured_root:
        candidates.append(Path(configured_root).expanduser())

    env_root = os.environ.get(REPO_ROOT_ENV)
    if env_root:
        candidates.append(Path(env_root).expanduser())

    candidates.append(Path.cwd())
    candidates.append(Path(__file__).resolve().parent / "runtime")
    candidates.extend(Path(__file__).resolve().parents)

    for candidate in candidates:
        resolved = candidate.resolve()
        for root in (resolved, *resolved.parents):
            if has_terminal_runner(root):
                return root

    raise RuntimeError(
        "Could not locate scripts/maze-terminal.js. Run from the MazeBench repo "
        f"or set {REPO_ROOT_ENV}=/path/to/MazeBench."
    )


def find_bridge_root(configured_root: str | None = None) -> Path:
    root = find_repo_root(configured_root)

    if has_bridge_runner(root):
        return root

    raise RuntimeError(
        "Could not locate scripts/maze-bridge.js. Run from the MazeBench repo "
        f"or set {REPO_ROOT_ENV}=/path/to/MazeBench."
    )


def run_initial_ascii_observation(
    *,
    level_id: str,
    node_bin: str,
    repo_root: Path,
    timeout_seconds: int,
    view: str,
    yaw: int,
) -> dict[str, Any]:
    script_path = repo_root / "scripts" / "maze-bridge.js"
    command = [
        node_bin,
        str(script_path),
        "--level",
        normalize_level_id(level_id),
        "--view",
        view,
        "--yaw",
        str(int(yaw)),
    ]

    result = subprocess.run(
        command,
        cwd=repo_root,
        capture_output=True,
        check=False,
        encoding="utf8",
        input=json.dumps({"command": "observe"}) + "\n",
        timeout=timeout_seconds,
    )

    if result.returncode != 0:
        raise RuntimeError(
            "maze-bridge.js failed with exit code "
            f"{result.returncode}: {(result.stderr or result.stdout).strip()}"
        )

    try:
        return json.loads(result.stdout.strip())
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"maze-bridge.js returned invalid JSON: {result.stdout[:500]}"
        ) from error


def target_text_for_row(row: dict[str, Any]) -> str:
    target_gems = int(row.get("target_gems") or 0)
    if target_gems > 0:
        return (
            f"Collect at least {target_gems} unique gem"
            f"{'' if target_gems == 1 else 's'}."
        )

    return (
        f"Collect {GAME_WON_GEM_COUNT} unique gems to win."
    )


def player_fields(player: dict[str, Any] | None) -> dict[str, object]:
    player = player or {}
    return {
        "player_elevation": player.get("elevation", "?"),
        "player_x": player.get("x", "?"),
        "player_y": player.get("y", "?"),
    }


def status_player_dead(status: dict[str, Any]) -> bool:
    return bool(status.get("player_dead"))


def allowed_commands_for_status(status: dict[str, Any]) -> tuple[str, ...]:
    raw_commands = status.get("allowed_commands")
    if isinstance(raw_commands, list) and raw_commands:
        return tuple(str(command) for command in raw_commands)
    return DEAD_ALLOWED_COMMANDS if status_player_dead(status) else ALIVE_ALLOWED_COMMANDS


def apply_quit_policy(status: dict[str, Any], allow_quit: bool) -> dict[str, Any]:
    if allow_quit:
        return status
    filtered = dict(status)
    filtered["allowed_commands"] = [
        command
        for command in allowed_commands_for_status(status)
        if str(command).strip().lower() != "quit"
    ]
    return filtered


def allowed_commands_text(status: dict[str, Any]) -> str:
    return "\n".join(f"- {command}" for command in allowed_commands_for_status(status))


def death_text(status: dict[str, Any]) -> str:
    return DEATH_MESSAGE if status_player_dead(status) else ""


def terminal_note_text(status: dict[str, Any]) -> str:
    if status_player_dead(status):
        return ""
    if "quit" not in allowed_commands_for_status(status):
        return "Quit is disabled by the user. Continue until the budget is exhausted or the user stops the run."
    return "Typing quit ends the run as a loss."


def response_instruction(status: dict[str, Any]) -> str:
    if status_player_dead(status):
        return "Respond with exactly one command line: `undo`, `reset`, or `go to level H I`."
    suffix = ", or `quit`" if "quit" in allowed_commands_for_status(status) else ""
    return (
        "Respond with exactly one command line, such as `up`, `down`, "
        f"`rotate camera left`, or `go to level H I`{suffix}."
    )


def render_multiturn_user_prompt(
    *,
    status: dict[str, Any],
    target_text: str,
    result_text: str,
) -> str:
    normalized_result = str(result_text or "").strip()
    notice_parts: list[str] = [normalized_result] if normalized_result else []
    death = death_text(status)
    if death and death not in normalized_result:
        notice_parts.append(death)
    return render_prompt_file(
        MULTITURN_USER_PROMPT_FILE,
        current_room=status.get("current_room") or "",
        current_view=status.get("current_view") or "",
        gem_count=max(0, int(status.get("gem_count") or 0)),
        level=status.get("level") or status.get("observation") or "",
        notice_text="\n\n".join(dict.fromkeys(notice_parts)),
        player_dead=status_player_dead(status),
        response_instruction=response_instruction(status),
        target_text=target_text,
        terminal_note=terminal_note_text(status),
        visited_levels=", ".join(str(room) for room in status.get("visited_levels") or []),
        yaw=int(status.get("yaw") or 0),
    )


def render_vision_user_prompt(
    *,
    status: dict[str, Any],
    target_text: str,
    result_text: str,
) -> str:
    visited_rooms = status.get("visited_levels") or []
    current_room = status.get("current_room") or status.get("level_id") or "?"
    current_view = status.get("current_view") or status.get("view") or "?"
    lines = [
        result_text,
        "",
        f"Objective: {target_text}",
        "",
        f"Current room: `{current_room}`",
        f"Current view: {current_view}",
        f"Yaw: {status.get('yaw', 0)}",
        f"Gems collected: {status.get('gem_count', 0)}",
        "Visited rooms: " + (", ".join(str(room) for room in visited_rooms) or "(none)"),
    ]
    death = death_text(status)
    if death:
        lines.append(death)
    lines.extend(
        [
            "",
            "The current maze view is attached as a perspective image. Do not rely on an ASCII board.",
            "",
            "Allowed commands:",
            allowed_commands_text(status),
            "",
            terminal_note_text(status),
            response_instruction(status),
        ]
    )
    return "\n".join(line for line in lines if line is not None)


def render_json_user_prompt(
    *,
    status: dict[str, Any],
    target_text: str,
    result_text: str,
) -> str:
    observation = status.get("json_observation") or {}
    visited_rooms = status.get("visited_levels") or []
    fields = player_fields(status.get("player"))
    lines = [
        result_text,
        "",
        f"Objective: {target_text}",
        "",
        f"Current room: `{status.get('current_room') or '?'}`",
        f"Current view: {status.get('current_view') or '?'}",
        f"Yaw: {status.get('yaw', 0)}",
        (
            "Player: "
            f"x={fields['player_x']} y={fields['player_y']} "
            f"elevation={fields['player_elevation']}"
        ),
        f"Gems collected: {status.get('gem_count', 0)}",
        "Visited rooms: " + (", ".join(str(room) for room in visited_rooms) or "(none)"),
        death_text(status),
        "",
        "The current room is represented by JSON, not an ASCII board. Object coordinates are [x,y,elevation]. Directional names are camera-relative.",
        "```json",
        json.dumps(observation, indent=2),
        "```",
        "",
        "Allowed commands:",
        allowed_commands_text(status),
        "",
        terminal_note_text(status),
        response_instruction(status),
    ]
    return "\n".join(line for line in lines if line is not None)


async def run_blocking(func: Any, /, *args: Any, **kwargs: Any) -> Any:
    """Run blocking subprocess/pipe I/O off the event loop so rollouts overlap."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, functools.partial(func, *args, **kwargs))


PROCESS_SHUTDOWN_TIMEOUT_SECONDS = 20


def process_command(pid: int) -> str:
    if os.name != "posix" or int(pid) <= 1:
        return ""
    try:
        result = subprocess.run(
            ["ps", "-p", str(int(pid)), "-o", "command="],
            capture_output=True,
            encoding="utf8",
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def playwright_browser_children(parent_pid: int) -> set[int]:
    if os.name != "posix" or int(parent_pid) <= 1:
        return set()
    try:
        result = subprocess.run(
            ["ps", "-axo", "pid=,ppid=,command="],
            capture_output=True,
            encoding="utf8",
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return set()

    children: set[int] = set()
    for line in result.stdout.splitlines():
        match = re.match(r"^\s*(\d+)\s+(\d+)\s+(.+)$", line)
        if not match or int(match.group(2)) != int(parent_pid):
            continue
        command = match.group(3)
        if (
            "--remote-debugging-pipe" in command
            and "playwright_chromiumdev_profile-" in command
        ):
            children.add(int(match.group(1)))
    return children


def signal_process_group(process: subprocess.Popen[Any], sig: signal.Signals) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, sig)
        else:
            process.send_signal(sig)
    except (OSError, ProcessLookupError):
        try:
            process.send_signal(sig)
        except (OSError, ProcessLookupError):
            pass


def kill_playwright_browsers(browser_pids: set[int]) -> None:
    kill_signal = getattr(signal, "SIGKILL", signal.SIGTERM)
    for pid in browser_pids:
        command = process_command(pid)
        if (
            "--remote-debugging-pipe" not in command
            or "playwright_chromiumdev_profile-" not in command
        ):
            continue
        try:
            if os.name == "posix":
                os.killpg(pid, kill_signal)
            else:
                os.kill(pid, kill_signal)
        except (OSError, ProcessLookupError):
            pass


def terminate_process(
    process: subprocess.Popen[Any],
    *,
    browser_pids: set[int] | None = None,
) -> None:
    known_browsers = set(browser_pids or ())
    if process.poll() is None:
        known_browsers.update(playwright_browser_children(process.pid))
        signal_process_group(process, signal.SIGTERM)
        try:
            process.wait(timeout=PROCESS_SHUTDOWN_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            known_browsers.update(playwright_browser_children(process.pid))
            kill_playwright_browsers(known_browsers)
            signal_process_group(process, getattr(signal, "SIGKILL", signal.SIGTERM))
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
    kill_playwright_browsers(known_browsers)


def valid_action_commands(actions: list[dict[str, Any]]) -> list[str]:
    return [
        str(action.get("command") or "").strip()
        for action in actions
        if action and action.get("valid") is not False and action.get("command")
    ]


def render_vision_frame_data_url(
    *,
    actions: list[str],
    task: "MazeBenchTaskData",
) -> str:
    payload = {
        "actions": actions,
        "draft": True,
        "fast": True,
        "gameId": task.game_id,
        "height": int(task.vision_height),
        "levelId": task.level_id,
        "view": str(getattr(task, "vision_view", DEFAULT_VISION_VIEW)),
        "width": int(task.vision_width),
        "yaw": int(task.yaw),
    }
    process = subprocess.Popen(
        [
            task.node_bin,
            str(Path(task.repo_root) / "scripts" / "maze-render-frame.js"),
        ],
        cwd=task.repo_root,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        encoding="utf8",
        start_new_session=os.name == "posix",
    )
    try:
        stdout, stderr = process.communicate(
            json.dumps(payload), timeout=max(30, int(task.timeout_seconds))
        )
    except subprocess.TimeoutExpired as error:
        browser_pids = playwright_browser_children(process.pid)
        terminate_process(process, browser_pids=browser_pids)
        raise TimeoutError("maze-render-frame.js timed out") from error

    result = subprocess.CompletedProcess(
        process.args,
        process.returncode,
        stdout=stdout,
        stderr=stderr,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "maze-render-frame.js failed: "
            + (result.stderr.strip() or result.stdout.strip() or "unknown error")
        )
    try:
        response = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"maze-render-frame.js returned invalid JSON: {result.stdout[:500]}"
        ) from error
    data_url = str(response.get("data_url") or "")
    if not data_url.startswith("data:image/png;base64,"):
        raise RuntimeError("maze-render-frame.js did not return a PNG data URL")
    return data_url


def make_row(
    *,
    example_id: int,
    game_won_gem_count: int,
    level_id: str,
    node_bin: str,
    repo_root: Path,
    target_gems: int,
    timeout_seconds: int,
    view: str,
    yaw: int,
) -> dict[str, Any]:
    payload = run_initial_ascii_observation(
        level_id=level_id,
        node_bin=node_bin,
        repo_root=repo_root,
        timeout_seconds=timeout_seconds,
        view=view,
        yaw=yaw,
    )
    row = {
        "example_id": example_id,
        "game_id": DEFAULT_GAME_ID,
        "game_won_gem_count": GAME_WON_GEM_COUNT,
        "level_id": str(payload["current_room"]),
        "node_bin": node_bin,
        "observation": str(payload["level"]),
        "repo_root": str(repo_root),
        "target_gems": int(target_gems),
        "timeout_seconds": int(timeout_seconds),
        "view": str(payload["current_view"]),
        "yaw": int(payload["yaw"]),
    }
    row["info"] = json.dumps(
        {
            INFO_KEY: {
                field: row[field]
                for field in INFO_ROW_FIELD_NAMES
                if field in row
            }
        }
    )
    return row


def build_rows(
    *,
    count: int,
    game_won_gem_count: int,
    level_ids: list[str],
    node_bin: str,
    repo_root: Path,
    target_gems: int,
    timeout_seconds: int,
    view: str,
    yaw: int,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    safe_count = max(0, int(count))

    for index in range(safe_count):
        level_id = level_ids[index % len(level_ids)]
        rows.append(
            make_row(
                example_id=index,
                game_won_gem_count=GAME_WON_GEM_COUNT,
                level_id=level_id,
                node_bin=node_bin,
                repo_root=repo_root,
                target_gems=target_gems,
                timeout_seconds=timeout_seconds,
                view=view,
                yaw=yaw,
            )
        )

    return rows


class MazeSession:
    def __init__(
        self,
        *,
        game_won_gem_count: int,
        level_id: str,
        observation_mode: str,
        omniscient: bool,
        hide_names: bool,
        hide_names_seed: str,
        node_bin: str,
        repo_root: str,
        timeout_seconds: int,
        view: str,
        yaw: int,
    ) -> None:
        self.repo_root = Path(repo_root)
        self.timeout_seconds = int(timeout_seconds)
        command = [
                node_bin,
                str(self.repo_root / "scripts" / "maze-bridge.js"),
                "--game-won-gem-count",
                str(GAME_WON_GEM_COUNT),
                "--level",
                normalize_level_id(level_id),
                "--view",
                view,
                "--yaw",
                str(int(yaw)),
            ]
        if observation_mode == "json":
            command.extend(["--observation-mode", "json"])
            if omniscient:
                command.append("--omniscient")
        if observation_mode != "vision" and hide_names:
            command.extend(["--hide-names", "--hide-names-seed", hide_names_seed])
        self.process = subprocess.Popen(
            command,
            cwd=self.repo_root,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf8",
            start_new_session=os.name == "posix",
        )

    def request(self, command: str, **kwargs: Any) -> dict[str, Any]:
        if self.process.poll() is not None:
            raise RuntimeError("maze bridge process is not running")

        if self.process.stdin is None or self.process.stdout is None:
            raise RuntimeError("maze bridge pipes are unavailable")

        payload = {"command": command, **kwargs}
        self.process.stdin.write(json.dumps(payload) + "\n")
        self.process.stdin.flush()

        ready, _, _ = select.select(
            [self.process.stdout], [], [], self.timeout_seconds
        )
        if not ready:
            self.close(kill=True)
            raise TimeoutError(f"maze bridge timed out waiting for {command!r}")

        line = self.process.stdout.readline()
        if not line:
            stderr = self.process.stderr.read() if self.process.stderr else ""
            raise RuntimeError(f"maze bridge closed unexpectedly: {stderr.strip()}")

        result = json.loads(line)
        if not result.get("ok"):
            raise RuntimeError(str(result.get("error") or "maze bridge command failed"))

        return result

    def close(self, kill: bool = False) -> None:
        if self.process.poll() is not None:
            return

        try:
            if kill:
                self.process.send_signal(signal.SIGTERM)
            else:
                try:
                    self.request("close")
                except Exception:
                    self.process.terminate()
        finally:
            try:
                self.process.wait(timeout=PROCESS_SHUTDOWN_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                terminate_process(self.process)


class VisionSession:
    """Persistent maze-render-frame.js --serve session: one server + headless
    browser per rollout, with actions applied incrementally between frames."""

    def __init__(self, *, task: "MazeBenchTaskData") -> None:
        self.repo_root = Path(task.repo_root or find_repo_root())
        self.timeout_seconds = max(30, int(task.timeout_seconds))
        self.init_payload = {
            "draft": True,
            "fast": True,
            "gameId": task.game_id,
            "height": int(task.vision_height),
            "levelId": task.level_id,
            "view": str(getattr(task, "vision_view", DEFAULT_VISION_VIEW)),
            "width": int(task.vision_width),
            "yaw": int(task.yaw),
        }
        self.applied_actions: list[str] = []
        self.last_frame = ""
        self.browser_pids: set[int] = set()
        self.process = subprocess.Popen(
            [
                task.node_bin,
                str(self.repo_root / "scripts" / "maze-render-frame.js"),
                "--serve",
            ],
            cwd=self.repo_root,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf8",
            start_new_session=os.name == "posix",
        )
        try:
            self.last_frame = self.frame_from_response(
                self.request("init", **self.init_payload)
            )
        except Exception:
            self.close(kill=True)
            raise

    def request(self, command: str, **kwargs: Any) -> dict[str, Any]:
        if self.process.poll() is not None:
            raise RuntimeError("maze render process is not running")

        if self.process.stdin is None or self.process.stdout is None:
            raise RuntimeError("maze render pipes are unavailable")

        payload = {"command": command, **kwargs}
        self.process.stdin.write(json.dumps(payload) + "\n")
        self.process.stdin.flush()

        ready, _, _ = select.select(
            [self.process.stdout], [], [], self.timeout_seconds
        )
        if not ready:
            self.close(kill=True)
            raise TimeoutError(f"maze render timed out waiting for {command!r}")

        line = self.process.stdout.readline()
        if not line:
            stderr = self.process.stderr.read() if self.process.stderr else ""
            raise RuntimeError(f"maze render closed unexpectedly: {stderr.strip()}")

        result = json.loads(line)
        if not result.get("ok"):
            raise RuntimeError(str(result.get("error") or "maze render command failed"))

        try:
            browser_pid = int(result.get("browser_pid") or 0)
        except (TypeError, ValueError):
            browser_pid = 0
        if browser_pid > 1:
            self.browser_pids.add(browser_pid)

        return result

    @staticmethod
    def frame_from_response(response: dict[str, Any]) -> str:
        frame = str(response.get("frame") or "")
        if not frame.startswith("data:image/png;base64,"):
            raise RuntimeError("maze render did not return a PNG data URL")
        return frame

    def frame_for_actions(self, actions: list[str]) -> str:
        actions = [str(action) for action in actions]

        if self.applied_actions != actions[: len(self.applied_actions)]:
            # History diverged; replay everything in one fresh init request.
            self.last_frame = self.frame_from_response(
                self.request("init", actions=actions, **self.init_payload)
            )
            self.applied_actions = list(actions)
            return self.last_frame

        for action in actions[len(self.applied_actions) :]:
            self.last_frame = self.frame_from_response(
                self.request("action", action=action)
            )
            self.applied_actions.append(action)

        if not self.last_frame:
            self.last_frame = self.frame_from_response(self.request("frame"))

        return self.last_frame

    def close(self, kill: bool = False) -> None:
        process = getattr(self, "process", None)
        if process is None:
            return
        browser_pids = set(getattr(self, "browser_pids", set()))
        if process.poll() is not None:
            kill_playwright_browsers(browser_pids)
            return

        try:
            if kill:
                process.send_signal(signal.SIGTERM)
            else:
                try:
                    self.request("close")
                except Exception:
                    process.terminate()
        finally:
            try:
                process.wait(timeout=PROCESS_SHUTDOWN_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                terminate_process(process, browser_pids=browser_pids)
            else:
                kill_playwright_browsers(browser_pids)

    def __del__(self) -> None:
        try:
            self.close(kill=True)
        except Exception:
            pass


COMMAND_ALIASES = {
    "close": "quit",
    "go_to_level": "goto_level",
    "goto": "goto_level",
    "goto_level": "goto_level",
    "move": "move",
    "quit": "quit",
    "reset": "reset_level",
    "reset_level": "reset_level",
    "rotate": "rotate_camera",
    "rotate_camera": "rotate_camera",
    "undo": "undo",
}
DIRECTIONS = {"up", "down", "left", "right"}


def strip_code_fence(text: str) -> str:
    stripped = text.strip()
    fence = re.fullmatch(r"```(?:\w+)?\s*(.*?)\s*```", stripped, re.DOTALL)
    return fence.group(1).strip() if fence else stripped


def parse_json_action(value: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    if "command" in value:
        return normalize_action(str(value["command"]), value)

    function_value = value.get("function") or value.get("function_call") or {}
    name = value.get("name") or value.get("tool") or function_value.get("name")
    raw_args = value.get("arguments") or value.get("args") or function_value.get("arguments") or {}

    if isinstance(raw_args, str):
        raw_args = json.loads(raw_args) if raw_args.strip().startswith("{") else {}

    if not isinstance(raw_args, dict):
        raw_args = {}

    return normalize_action(str(name or ""), raw_args)


def parse_key_value_args(text: str) -> dict[str, str]:
    args: dict[str, str] = {}
    positional: list[str] = []

    for part in [part.strip() for part in text.split(",") if part.strip()]:
        key, separator, value = part.partition("=")
        if not separator:
            key, separator, value = part.partition(":")

        if separator:
            args[key.strip()] = value.strip().strip("\"'")
        else:
            positional.extend(shlex.split(part))

    if positional:
        args["_positional"] = positional

    return args


def normalize_action(command: str, args: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    raw_command = str(command or "").strip().lower().replace(" ", "_")
    if raw_command in DIRECTIONS:
        return "move", {"direction": raw_command}

    normalized = COMMAND_ALIASES.get(raw_command)
    positional = list(args.get("_positional") or [])

    if not normalized:
        raise ValueError(f"unknown command: {command}")

    if normalized in {"move", "rotate_camera"}:
        direction = str(args.get("direction") or (positional[0] if positional else "")).lower()
        if direction not in DIRECTIONS:
            raise ValueError(
                f"{normalized} requires direction: up, down, left, or right"
            )
        return normalized, {"direction": direction}

    if normalized in {"undo", "reset_level", "quit"}:
        return normalized, {}

    x = str(args.get("x") or (positional[0] if len(positional) >= 1 else "")).upper()
    y = str(args.get("y") or (positional[1] if len(positional) >= 2 else "")).upper()
    if not re.fullmatch(r"[A-Z]", x) or not re.fullmatch(r"[A-Z]", y):
        raise ValueError("go to level requires two world coordinate letters, e.g. go to level H I")

    return normalized, {"x": x, "y": y}


def parse_text_action(text: str) -> tuple[str, dict[str, Any]]:
    cleaned = strip_code_fence(text)
    first_line = next((line.strip() for line in cleaned.splitlines() if line.strip()), "")

    if not first_line:
        raise ValueError("empty response")

    if first_line.startswith("{"):
        parsed = json.loads(first_line)
        if not isinstance(parsed, dict):
            raise ValueError("JSON action must be an object")
        return parse_json_action(parsed)

    function_match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)", first_line)
    if function_match:
        return normalize_action(function_match.group(1), parse_key_value_args(function_match.group(2)))

    tokens = shlex.split(first_line)
    if not tokens:
        raise ValueError("empty response")

    lowered = [token.lower() for token in tokens]
    if len(tokens) == 1 and lowered[0] in DIRECTIONS:
        return "move", {"direction": lowered[0]}

    if len(tokens) >= 3 and lowered[:2] == ["rotate", "camera"]:
        return normalize_action("rotate_camera", {"_positional": tokens[2:]})

    if len(tokens) >= 5 and lowered[:3] == ["go", "to", "level"]:
        return normalize_action("goto_level", {"_positional": tokens[3:]})

    args: dict[str, Any] = {}
    positional: list[str] = []
    for token in tokens[1:]:
        key, separator, value = token.partition("=")
        if separator:
            args[key] = value.strip("\"'")
        else:
            positional.append(token.strip("\"'"))

    if positional:
        args["_positional"] = positional

    return normalize_action(tokens[0], args)


def scorecard_text(status: dict[str, Any]) -> str:
    return json.dumps(status.get("scorecard") or {}, indent=2)


def action_result_text(
    *,
    command: str | None = None,
    error: str | None = None,
    status: dict[str, Any] | None = None,
) -> str:
    if error:
        return f"Previous response was invalid: {error}"

    status = status or {}
    action = status.get("action") or command or "action"
    details = [f"Previous action: {action}."]

    if "direction" in status:
        details.append(f"Direction: {status['direction']}.")
    if status.get("room_changed"):
        details.append(f"Entered room: {status.get('current_room')}.")
    if status.get("destination_room"):
        details.append(f"Jumped to room: {status.get('destination_room')}.")
    if status_player_dead(status):
        details.append(DEATH_MESSAGE)
    return " ".join(details)


def load_prime_resume_checkpoint(file_path: str) -> dict[str, Any]:
    path = Path(file_path).expanduser().resolve()
    try:
        checkpoint = json.loads(path.read_text(encoding="utf8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"could not read Prime resume checkpoint {path}: {error}") from error
    if checkpoint.get("version") != PRIME_RESUME_CHECKPOINT_VERSION:
        raise ValueError("unsupported Prime resume checkpoint version")
    actions = checkpoint.get("actions")
    messages = checkpoint.get("messages")
    if not isinstance(actions, list) or not actions:
        raise ValueError("Prime resume checkpoint has no actions")
    if not isinstance(messages, list) or not messages:
        raise ValueError("Prime resume checkpoint has no model transcript")
    if checkpoint.get("task", {}).get("observation_mode") == "vision":
        raise ValueError("Prime vision checkpoints cannot resume without saved image pixels")
    checkpoint["_path"] = str(path)
    return checkpoint


def prime_resume_prompt(checkpoint: dict[str, Any]) -> vf.Messages:
    task = checkpoint.get("task") or {}
    latest = (checkpoint.get("actions") or [])[-1]
    status = latest.get("status") or {}
    if str(status.get("board_state_hash") or "") != str(
        checkpoint.get("final_board_state_hash") or ""
    ):
        raise ValueError("Prime resume checkpoint final board hash does not match its last action")
    if latest.get("valid", True) is False or latest.get("error"):
        result_text = action_result_text(error=str(latest.get("error") or "invalid response"))
    else:
        result_text = action_result_text(
            command=str(latest.get("command_text") or ""),
            status=status,
        )
    target_text = target_text_for_row(
        {
            "game_won_gem_count": GAME_WON_GEM_COUNT,
            "target_gems": int(task.get("target_gems") or 0),
        }
    )
    mode = str(task.get("observation_mode") or "ascii")
    if mode == "json":
        content: Any = render_json_user_prompt(
            status=status,
            target_text=target_text,
            result_text=result_text,
        )
    else:
        content = render_multiturn_user_prompt(
            status=status,
            target_text=target_text,
            result_text=result_text,
        )
    return [*(checkpoint.get("messages") or []), {"role": "user", "content": content}]


def canonical_command_text(command: str, args: dict[str, Any]) -> str:
    if command == "move":
        return str(args.get("direction") or "")
    if command == "rotate_camera":
        return f"rotate camera {args.get('direction') or ''}".strip()
    if command == "goto_level":
        return f"go to level {args.get('x') or ''} {args.get('y') or ''}".strip()
    if command == "reset_level":
        return "reset"
    if command in {"undo", "quit"}:
        return command
    return command


def slim_status(status: dict[str, Any] | None) -> dict[str, Any]:
    status = status or {}
    keys = (
        "action",
        "action_count",
        "allowed_commands",
        "board_state_hash",
        "board_state_hash_version",
        "collected_gems",
        "collected_this_action",
        "current_room",
        "current_view",
        "death_message",
        "destination_room",
        "direction",
        "game_lost",
        "game_won",
        "gem_count",
        "json_observation",
        "level",
        "moved",
        "novel_push_count",
        "novel_pushes_this_action",
        "player",
        "player_dead",
        "quit",
        "room_changed",
        "push_count",
        "pushes_this_action",
        "visited_levels",
        "yaw",
    )
    return {key: status[key] for key in keys if key in status}


def record_maze_action(
    state: vf.State,
    *,
    action_args: dict[str, Any] | None = None,
    command: str | None = None,
    error: str | None = None,
    raw_response: str = "",
    status: dict[str, Any] | None = None,
    timestamp: str | None = None,
) -> None:
    action_args = action_args or {}
    current_actions = (
        state.get("maze_actions", [])
        if isinstance(state, dict)
        else getattr(state, "maze_actions", [])
    )
    record = {
        "turn": len(current_actions or []) + 1,
        "timestamp": timestamp or _utc_timestamp(),
        "valid": error is None,
        "raw_response": raw_response.strip(),
        "command": (
            canonical_command_text(command, action_args)
            if command is not None and error is None
            else None
        ),
        "normalized_action": command,
        "args": action_args,
        "error": error,
        "status": slim_status(status),
    }
    if isinstance(state, dict):
        state.setdefault("maze_actions", []).append(record)
    else:
        actions = list(current_actions or [])
        actions.append(record)
        state.maze_actions = actions


def set_maze_scorecard(state: vf.State, scorecard: dict[str, Any] | None) -> None:
    if not isinstance(scorecard, dict):
        return

    if isinstance(state, dict):
        state["maze_scorecard"] = scorecard
        replay = state.get("maze_replay")
    else:
        state.maze_scorecard = scorecard
        replay = getattr(state, "maze_replay", None)
    if isinstance(replay, dict):
        replay["scorecard"] = scorecard
        if not isinstance(state, dict):
            state.maze_replay = replay


class MazeBenchTaskData(vf.TaskData):
    example_id: int
    allow_quit: bool = env_bool("MAZEBENCH_ALLOW_QUIT", True)
    auto_quit: bool = env_bool("MAZEBENCH_AUTO_QUIT", False)
    auto_quit_threshold: float = AUTO_QUIT_DEFAULT_THRESHOLD
    auto_quit_mode: Literal["cumulative", "rolling"] = AUTO_QUIT_DEFAULT_MODE
    auto_quit_window: int = AUTO_QUIT_DEFAULT_WINDOW
    game_id: str = DEFAULT_GAME_ID
    game_won_gem_count: int = GAME_WON_GEM_COUNT
    level_id: str = DEFAULT_START_LEVEL_ID
    max_actions: int | None = DEFAULT_MAX_ACTIONS
    node_bin: str = DEFAULT_NODE_BIN
    observation: str = ""
    observation_mode: Literal["ascii", "json", "vision"] = DEFAULT_OBSERVATION_MODE
    omniscient: bool = False
    hide_names: bool = False
    hide_names_seed: str = "1"
    repo_root: str = ""
    resume_checkpoint_path: str = ""
    target_gems: int = DEFAULT_TARGET_GEMS
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    view: str = DEFAULT_VIEW
    vision_height: int = DEFAULT_VISION_HEIGHT
    vision_view: str = DEFAULT_VISION_VIEW
    vision_width: int = DEFAULT_VISION_WIDTH
    yaw: int = DEFAULT_YAW


class MazeBenchTaskConfig(vf.TaskConfig):
    gem_reward_weight: float = Field(DEFAULT_GEM_REWARD_WEIGHT, ge=0)
    room_reward_weight: float = Field(DEFAULT_ROOM_REWARD_WEIGHT, ge=0)
    push_reward_weight: float = Field(DEFAULT_PUSH_REWARD_WEIGHT, ge=0)
    user: vf.UserConfig = Field(default_factory=vf.UserConfig)


# verifiers renamed the env-id type from `EnvId` to `ID` on main (both are the
# same Annotated[str, id-validator]); use whichever the installed version has.
_EnvId = getattr(vf, "EnvId", None) or getattr(vf, "ID", str)


class MazeBenchConfig(vf.TasksetConfig):
    id: _EnvId = "mazebench"
    task: MazeBenchTaskConfig = Field(default_factory=MazeBenchTaskConfig)
    num_examples: int = 1
    allow_quit: bool = env_bool("MAZEBENCH_ALLOW_QUIT", True)
    auto_quit: bool = env_bool("MAZEBENCH_AUTO_QUIT", False)
    auto_quit_threshold: float = Field(
        env_float("MAZEBENCH_AUTO_QUIT_THRESHOLD", AUTO_QUIT_DEFAULT_THRESHOLD),
        ge=0,
        le=100,
    )
    auto_quit_mode: Literal["cumulative", "rolling"] = (
        "rolling"
        if str(os.environ.get("MAZEBENCH_AUTO_QUIT_MODE") or "").strip().lower()
        == "rolling"
        else AUTO_QUIT_DEFAULT_MODE
    )
    auto_quit_window: int = Field(
        env_int("MAZEBENCH_AUTO_QUIT_WINDOW", AUTO_QUIT_DEFAULT_WINDOW, minimum=1),
        ge=1,
        le=AUTO_QUIT_MAX_WINDOW,
    )
    level_ids: str | list[str] | None = None
    start_level_id: str = DEFAULT_START_LEVEL_ID
    view: str = DEFAULT_VIEW
    yaw: int = DEFAULT_YAW
    game_won_gem_count: int = GAME_WON_GEM_COUNT
    gem_reward_weight: float = Field(DEFAULT_GEM_REWARD_WEIGHT, ge=0)
    room_reward_weight: float = Field(DEFAULT_ROOM_REWARD_WEIGHT, ge=0)
    push_reward_weight: float = Field(DEFAULT_PUSH_REWARD_WEIGHT, ge=0)
    max_actions: int | None = Field(DEFAULT_MAX_ACTIONS, ge=1)
    node_bin: str = DEFAULT_NODE_BIN
    observation_mode: Literal["ascii", "json", "vision"] = DEFAULT_OBSERVATION_MODE
    omniscient: bool = False
    hide_names: bool = False
    hide_names_seed: str = "1"
    repo_root: str | None = None
    resume_checkpoint_path: str | None = None
    target_gems: int = DEFAULT_TARGET_GEMS
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    vision_height: int = DEFAULT_VISION_HEIGHT
    vision_view: str = DEFAULT_VISION_VIEW
    vision_width: int = DEFAULT_VISION_WIDTH
    system_prompt: str = MULTITURN_SYSTEM_PROMPT
    user: vf.UserConfig = Field(default_factory=vf.UserConfig)


class MazeBenchEnvConfig(vf.EnvConfig):
    """Typed v1 environment config with usable local/Hub defaults."""

    taskset: MazeBenchConfig = Field(default_factory=MazeBenchConfig)
    harness: vf.HarnessConfig = Field(
        default_factory=lambda: vf.HarnessConfig(id="null")
    )
    max_turns: int | None = DEFAULT_MAX_TURNS

    @model_validator(mode="before")
    @classmethod
    def _safe_default_harness(cls, value: Any) -> Any:
        data = dict(value or {})
        data.setdefault("harness", {"id": "mazebench"})
        return data


class MazeBenchState(vf.State):
    game_lost: bool = False
    game_won: bool = False
    maze_auto_quit: dict[str, Any] = Field(default_factory=dict)
    maze_actions: list[dict[str, Any]] = Field(default_factory=list)
    maze_initial_board_state_hash: str = ""
    maze_replay: dict[str, Any] = Field(default_factory=dict)
    maze_scorecard: dict[str, Any] = Field(default_factory=dict)
    maze_status: dict[str, Any] = Field(default_factory=dict)
    maze_status_error: str = ""


class MazeBenchUser(vf.User[vf.UserConfig, MazeBenchState]):
    async def setup_task(self, task: MazeBenchTaskData) -> None:
        self.task = task
        self.vision_session = None
        self.vision_session_failed = False
        self.session = MazeSession(
            game_won_gem_count=GAME_WON_GEM_COUNT,
            level_id=task.level_id,
            observation_mode=task.observation_mode,
            omniscient=task.omniscient,
            hide_names=task.hide_names,
            hide_names_seed=task.hide_names_seed,
            node_bin=task.node_bin,
            repo_root=task.repo_root or str(find_bridge_root()),
            timeout_seconds=task.timeout_seconds,
            view=task.view,
            yaw=task.yaw,
        )
        self._resume_initial_status = None
        self._resume_status = None
        self._resume_actions = None
        if task.resume_checkpoint_path:
            checkpoint = load_prime_resume_checkpoint(task.resume_checkpoint_path)
            initial_status = apply_quit_policy(
                await run_blocking(self.session.request, "observe"),
                task.allow_quit,
            )
            expected_initial_hash = str(
                checkpoint.get("initial_board_state_hash") or ""
            )
            actual_initial_hash = str(initial_status.get("board_state_hash") or "")
            if not expected_initial_hash or actual_initial_hash != expected_initial_hash:
                raise ValueError(
                    "Prime checkpoint initial state does not match this MazeBench runtime"
                )
            replay_state: dict[str, Any] = {"maze_actions": []}
            status = initial_status
            for index, saved in enumerate(checkpoint.get("actions") or [], start=1):
                if int(saved.get("turn") or 0) != index:
                    raise ValueError(f"Prime checkpoint is missing action {index}")
                raw_response = str(saved.get("command_text") or "")
                if saved.get("valid", True) is False or saved.get("error"):
                    status = apply_quit_policy(
                        await run_blocking(self.session.request, "observe"),
                        task.allow_quit,
                    )
                    record_maze_action(
                        replay_state,
                        error=str(saved.get("error") or "invalid response"),
                        raw_response=raw_response,
                        status=status,
                        timestamp=str(saved.get("timestamp") or "") or None,
                    )
                else:
                    command, action_args = parse_text_action(raw_response)
                    status = apply_quit_policy(
                        await run_blocking(self.session.request, command, **action_args),
                        task.allow_quit,
                    )
                    record_maze_action(
                        replay_state,
                        action_args=action_args,
                        command=command,
                        raw_response=raw_response,
                        status=status,
                        timestamp=str(saved.get("timestamp") or "") or None,
                    )
                expected_hash = str(saved.get("status", {}).get("board_state_hash") or "")
                actual_hash = str(status.get("board_state_hash") or "")
                if not expected_hash or actual_hash != expected_hash:
                    raise ValueError(
                        f"Prime checkpoint diverged while replaying action {index}"
                    )
            final_hash = str(checkpoint.get("final_board_state_hash") or "")
            if str(status.get("board_state_hash") or "") != final_hash:
                raise ValueError("Prime checkpoint replay did not reach its saved final state")
            self._resume_initial_status = initial_status
            self._resume_status = status
            self._resume_actions = list(replay_state["maze_actions"])
        self._atexit_callback = self.close_session
        atexit.register(self._atexit_callback)

    def export_live_actions(self) -> None:
        write_live_actions(list(self.state.maze_actions or []))

    def auto_quit_evaluation(self) -> dict[str, Any] | None:
        task = self.task
        return evaluate_auto_quit(
            self.state.maze_initial_board_state_hash,
            self.state.maze_actions,
            enabled=task.auto_quit,
            threshold=task.auto_quit_threshold,
            mode=task.auto_quit_mode,
            window=task.auto_quit_window,
        )

    async def vision_frame_data_url(self) -> str:
        task = self.task
        actions = valid_action_commands(self.state.maze_actions)

        if not getattr(self, "vision_session_failed", False):
            try:
                if not isinstance(getattr(self, "vision_session", None), VisionSession):
                    self.vision_session = await run_blocking(VisionSession, task=task)
            except Exception:
                # Persistent mode is unavailable (e.g. stale runtime script);
                # stop retrying and use the one-shot renderer below.
                self.vision_session_failed = True
                self.vision_session = None
            else:
                try:
                    return await run_blocking(
                        self.vision_session.frame_for_actions, actions
                    )
                except Exception:
                    # Session died mid-rollout; fall back for this frame and
                    # let the next turn start a fresh session.
                    await run_blocking(self.close_vision_session)

        return await run_blocking(
            render_vision_frame_data_url, actions=actions, task=task
        )

    async def build_user_message(self, status: dict[str, Any], result_text: str) -> vf.Messages:
        task = self.task
        target_text = target_text_for_row(task.model_dump())
        if task.observation_mode == "ascii":
            return [
                {
                    "role": "user",
                    "content": render_multiturn_user_prompt(
                        status=status,
                        target_text=target_text,
                        result_text=result_text,
                    ),
                }
            ]

        if task.observation_mode == "json":
            return [
                {
                    "role": "user",
                    "content": render_json_user_prompt(
                        status=status,
                        target_text=target_text,
                        result_text=result_text,
                    ),
                }
            ]

        data_url = await self.vision_frame_data_url()
        return [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": render_vision_user_prompt(
                            status=status,
                            target_text=target_text,
                            result_text=result_text,
                        ),
                    },
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ]

    def close_vision_session(self) -> None:
        vision_session = getattr(self, "vision_session", None)
        if isinstance(vision_session, VisionSession):
            vision_session.close()
        self.vision_session = None

    def close_session(self) -> None:
        session = getattr(self, "session", None)
        if isinstance(session, MazeSession):
            session.close()
            self.session = None
        self.close_vision_session()
        callback = getattr(self, "_atexit_callback", None)
        if callback is not None:
            atexit.unregister(callback)
            self._atexit_callback = None

    def initialize_state(self, status: dict[str, Any]) -> None:
        task = self.task
        self.state.maze_auto_quit = {}
        self.state.maze_actions = []
        self.state.maze_initial_board_state_hash = str(
            status.get("board_state_hash") or ""
        ).strip()
        self.state.maze_scorecard = {}
        self.state.maze_status = status
        self.state.maze_status_error = ""
        self.state.game_lost = False
        self.state.game_won = False
        self.state.maze_replay = {
            "game_id": task.game_id,
            "game_won_gem_count": GAME_WON_GEM_COUNT,
            "initial": slim_status(status),
            "start_level_id": task.level_id,
            "target_gems": int(task.target_gems),
            "actions": self.state.maze_actions,
            "scorecard": None,
        }

    def update_terminal_flags(self, status: dict[str, Any]) -> None:
        self.state.game_lost = bool(status.get("game_lost") or status.get("quit"))
        self.state.game_won = int(status.get("gem_count") or 0) >= GAME_WON_GEM_COUNT

    def record_scorecard(self, status: dict[str, Any]) -> None:
        scorecard = status.get("scorecard")
        if not isinstance(scorecard, dict):
            return
        self.state.maze_scorecard = scorecard
        replay = dict(self.state.maze_replay or {})
        replay["scorecard"] = scorecard
        self.state.maze_replay = replay

    async def respond(self, message: str) -> vf.Messages:
        session = getattr(self, "session", None)
        task = self.task

        if not isinstance(session, MazeSession):
            self.state.maze_status_error = "maze session is not available"
            self.state.game_lost = True
            return [{"role": "user", "content": "Maze session is not available."}]

        if self._resume_actions is not None:
            initial_status = self._resume_initial_status or {}
            restored_status = self._resume_status or initial_status
            restored_actions = list(self._resume_actions)
            self.initialize_state(initial_status)
            self.state.maze_actions = restored_actions
            self.state.maze_status = restored_status
            replay = dict(self.state.maze_replay or {})
            replay["actions"] = restored_actions
            self.state.maze_replay = replay
            self.update_terminal_flags(restored_status)
            self._resume_initial_status = None
            self._resume_status = None
            self._resume_actions = None

        if not self.state.maze_status:
            status = apply_quit_policy(
                await run_blocking(session.request, "observe"),
                task.allow_quit,
            )
            self.initialize_state(status)
            return await self.build_user_message(status, "Start of run.")

        raw_response = str(message or "")
        result_text = ""
        blocked_quit_attempt = False
        try:
            command, action_args = parse_text_action(raw_response)
            if command == "quit" and not task.allow_quit:
                blocked_quit_attempt = True
                raise ValueError(
                    "Quit is disabled by the user. Continue until the budget is exhausted or the user stops the run."
                )
            status = apply_quit_policy(
                await run_blocking(session.request, command, **action_args),
                task.allow_quit,
            )
            self.state.maze_status = status
            record_maze_action(
                self.state,
                action_args=action_args,
                command=command,
                raw_response=raw_response,
                status=status,
            )
            result_text = action_result_text(command=command, status=status)
        except Exception as error:
            self.state.maze_status_error = str(error)
            try:
                status = apply_quit_policy(
                    await run_blocking(session.request, "observe"),
                    task.allow_quit,
                )
                self.state.maze_status = status
            except Exception:
                status = self.state.maze_status or {}
            if not blocked_quit_attempt:
                record_maze_action(
                    self.state,
                    error=str(error),
                    raw_response=raw_response,
                    status=status,
                )
            result_text = action_result_text(error=str(error))

        self.export_live_actions()

        self.update_terminal_flags(status)
        auto_quit = (
            None
            if self.state.game_lost or self.state.game_won
            else self.auto_quit_evaluation()
        )
        if auto_quit is not None:
            self.state.maze_auto_quit = auto_quit
        rollout_ended = bool(
            self.state.game_lost or self.state.game_won or self.state.maze_auto_quit
        )
        if rollout_ended and not status.get("scorecard"):
            status = apply_quit_policy(
                await run_blocking(session.request, "scorecard"),
                task.allow_quit,
            )
            self.state.maze_status = status
        self.record_scorecard(status)

        if rollout_ended:
            await run_blocking(self.close_session)
            if self.state.maze_auto_quit:
                percentage = float(self.state.maze_auto_quit.get("percentage") or 0)
                return [
                    {
                        "role": "user",
                        "content": (
                            "Auto-quit: state novelty reached "
                            f"{percentage:.1f}% new states. No further action is available."
                        ),
                    }
                ]
            return [
                {
                    "role": "user",
                    "content": "The game has ended. No further action is available.",
                }
            ]

        return await self.build_user_message(status, result_text)


class MazeBenchTaskBehavior:
    async def finalize(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        del runtime
        trace.info["maze_actions"] = trace.state.maze_actions
        if trace.state.maze_auto_quit:
            trace.info["maze_auto_quit"] = trace.state.maze_auto_quit
        trace.info["maze_scorecard"] = trace.state.maze_scorecard
        trace.info["maze_replay"] = trace.state.maze_replay
        trace.info["maze_status"] = slim_status(trace.state.maze_status)

    @vf.stop
    async def game_over(self, trace: vf.Trace) -> bool:
        return bool(
            trace.state.game_lost
            or trace.state.game_won
            or (
                self.data.max_actions is not None
                and len(trace.state.maze_actions) >= int(self.data.max_actions)
            )
        )

    @vf.stop
    async def low_state_novelty(self, trace: vf.Trace) -> bool:
        if trace.state.maze_auto_quit:
            return True
        evaluation = evaluate_auto_quit(
            trace.state.maze_initial_board_state_hash,
            trace.state.maze_actions,
            enabled=self.data.auto_quit,
            threshold=self.data.auto_quit_threshold,
            mode=self.data.auto_quit_mode,
            window=self.data.auto_quit_window,
        )
        if evaluation is None:
            return False
        trace.state.maze_auto_quit = evaluation
        return True

    @vf.reward
    async def gem_score(self, trace: vf.Trace) -> float:
        status = trace.state.maze_status or {}
        gem_count = int(status.get("gem_count") or 0)
        target = int(self.data.target_gems or 0)
        if target <= 0:
            raw_score = float(gem_count)
        else:
            raw_score = min(1.0, gem_count / target)
        return raw_score * float(self.config.gem_reward_weight)

    @vf.reward
    async def room_exploration_score(self, trace: vf.Trace) -> float:
        status = trace.state.maze_status or {}
        new_rooms = max(0, len(status.get("visited_levels") or []) - 1)
        return float(new_rooms) * float(self.config.room_reward_weight)

    @vf.reward
    async def block_progress_score(self, trace: vf.Trace) -> float:
        status = trace.state.maze_status or {}
        novel_positions = int(status.get("novel_push_count") or 0)
        return float(novel_positions) * float(self.config.push_reward_weight)

    @vf.metric
    async def collected_gems(self, trace: vf.Trace) -> float:
        status = trace.state.maze_status or {}
        return float(status.get("gem_count") or 0)

    @vf.metric
    async def visited_level_count(self, trace: vf.Trace) -> float:
        status = trace.state.maze_status or {}
        return float(len(status.get("visited_levels") or []))

    @vf.metric
    async def block_pushes(self, trace: vf.Trace) -> float:
        status = trace.state.maze_status or {}
        return float(status.get("push_count") or 0)

    @vf.metric
    async def novel_block_positions(self, trace: vf.Trace) -> float:
        status = trace.state.maze_status or {}
        return float(status.get("novel_push_count") or 0)


class MazeBenchTask(
    MazeBenchTaskBehavior,
    vf.Task[MazeBenchTaskData, MazeBenchState, MazeBenchTaskConfig],
):
    user = MazeBenchUser


class MazeBenchTaskset(vf.Taskset[MazeBenchTask, MazeBenchConfig]):
    def load(self) -> list[MazeBenchTask]:
        resolved_repo_root = find_bridge_root(self.config.repo_root)
        normalized_level_ids = parse_level_ids(
            self.config.level_ids,
            self.config.start_level_id,
        )
        rows = build_rows(
            count=self.config.num_examples,
            game_won_gem_count=GAME_WON_GEM_COUNT,
            level_ids=normalized_level_ids,
            node_bin=self.config.node_bin,
            repo_root=resolved_repo_root,
            target_gems=int(self.config.target_gems),
            timeout_seconds=int(self.config.timeout_seconds),
            view=self.config.view,
            yaw=int(self.config.yaw),
        )
        checkpoint = (
            load_prime_resume_checkpoint(self.config.resume_checkpoint_path)
            if self.config.resume_checkpoint_path
            else None
        )
        if checkpoint and len(rows) != 1:
            raise ValueError("Prime checkpoint resume supports exactly one rollout")
        task_config = self.config.task.model_copy(
            update={
                "gem_reward_weight": self.config.gem_reward_weight,
                "room_reward_weight": self.config.room_reward_weight,
                "push_reward_weight": self.config.push_reward_weight,
                "user": self.config.user,
            }
        )
        tasks: list[MazeBenchTask] = []
        for index, row in enumerate(rows):
            checkpoint_task = checkpoint.get("task") if checkpoint else {}
            if checkpoint:
                expected = {
                    "level_id": str(row["level_id"]),
                    "game_won_gem_count": GAME_WON_GEM_COUNT,
                    "observation_mode": self.config.observation_mode,
                    "omniscient": bool(self.config.omniscient),
                    "hide_names": bool(self.config.hide_names),
                    "hide_names_seed": str(self.config.hide_names_seed).strip()[:128] or "1",
                    "allow_quit": bool(self.config.allow_quit),
                    "auto_quit": bool(self.config.auto_quit),
                    "auto_quit_threshold": float(self.config.auto_quit_threshold),
                    "auto_quit_mode": self.config.auto_quit_mode,
                    "auto_quit_window": int(self.config.auto_quit_window),
                }
                for key, value in expected.items():
                    if checkpoint_task.get(key) != value:
                        raise ValueError(
                            f"Prime checkpoint {key} does not match the requested run configuration"
                        )
            data = MazeBenchTaskData(
                idx=index,
                name=f"{row['game_id']}:{row['level_id']}#{index}",
                prompt=prime_resume_prompt(checkpoint) if checkpoint else None,
                system_prompt=(
                    str(checkpoint.get("system_prompt") or self.config.system_prompt)
                    if checkpoint
                    else self.config.system_prompt
                ),
                example_id=int(row["example_id"]),
                allow_quit=bool(self.config.allow_quit),
                auto_quit=bool(self.config.auto_quit),
                auto_quit_threshold=float(self.config.auto_quit_threshold),
                auto_quit_mode=self.config.auto_quit_mode,
                auto_quit_window=int(self.config.auto_quit_window),
                game_id=str(row["game_id"]),
                game_won_gem_count=GAME_WON_GEM_COUNT,
                level_id=str(row["level_id"]),
                max_actions=(
                    None
                    if self.config.max_actions is None
                    else int(self.config.max_actions)
                ),
                node_bin=str(row["node_bin"]),
                observation=str(row["observation"]),
                observation_mode=self.config.observation_mode,
                omniscient=bool(self.config.omniscient),
                hide_names=bool(self.config.hide_names),
                hide_names_seed=str(self.config.hide_names_seed).strip()[:128] or "1",
                repo_root=str(row["repo_root"]),
                resume_checkpoint_path=(
                    str(checkpoint.get("_path") or "") if checkpoint else ""
                ),
                target_gems=int(row["target_gems"]),
                timeout_seconds=int(row["timeout_seconds"]),
                view=str(row["view"]),
                vision_height=int(self.config.vision_height),
                vision_view=str(self.config.vision_view),
                vision_width=int(self.config.vision_width),
                yaw=int(row["yaw"]),
            )
            tasks.append(MazeBenchTask(data, task_config))
        return tasks


def load_taskset(config: MazeBenchConfig) -> MazeBenchTaskset:
    return MazeBenchTaskset(config=config)


def load_environment(
    config: MazeBenchEnvConfig | vf.EnvConfig | dict[str, Any] | None = None,
) -> vf.Environment:
    """Load the JS-backed ASCII maze benchmark as a Verifiers v1 environment."""
    if config is None:
        config = MazeBenchEnvConfig()
    elif not isinstance(config, MazeBenchEnvConfig):
        raw_config = config if isinstance(config, dict) else config.model_dump()
        config = MazeBenchEnvConfig.model_validate(raw_config)
    if not config.taskset.id:
        taskset_config = MazeBenchConfig.model_validate(config.taskset.model_dump())
        config = config.model_copy(update={"taskset": taskset_config})
    return vf.Environment(config=config)


__all__ = ["MazeBenchConfig", "MazeBenchEnvConfig", "MazeBenchTaskset"]


if __name__ == "__main__":
    original_parent_pid = os.getppid()

    # A launcher can die in the narrow window before this module imports. In
    # framework mode this process is never an intentional daemon, so starting
    # already reparented to launchd means there is no rollout left to serve.
    if original_parent_pid <= 1 and "VF_CONFIG" in os.environ:
        raise SystemExit(0)

    if original_parent_pid > 1:
        parent_poll = threading.Event()

        def stop_when_parent_exits() -> None:
            while os.getppid() == original_parent_pid:
                parent_poll.wait(2)
            os.kill(os.getpid(), signal.SIGTERM)

        threading.Thread(target=stop_when_parent_exits, daemon=True).start()

    MazeBenchUser.run()
