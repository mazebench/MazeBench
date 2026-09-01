"""Narrow interactive terminal controller for a local MazeBench run."""

from __future__ import annotations

import json
import os
import secrets
import shlex
import subprocess
import sys
import time
from pathlib import Path

from . import (
    CliError,
    _find_free_port,
    _lan_rpc,
    _node_bin,
    _normalize_lan_action,
    _pid_alive,
    _read_json_file,
    _require,
    _terminate_pid,
    _wait_for_lan_port_file,
    _write_json_file,
    resolve_root,
)


USAGE = """computer — enter a restricted MazeBench action mode

  computer login <run-name>

Inside the mode, the only available command is:
  action <move>

Examples:
  action up
  action down
  action sequence UDLRDLLDLDR
  action room HxI
  action undo
  action rotate left
  action quit

`action quit` exits the mode without sending or recording a game action.
"""


def _records_root() -> Path:
    return Path(os.environ.get("MAZEBENCH_RECORDS_ROOT", "~/records")).expanduser()


def _control_root() -> Path:
    configured = os.environ.get("MAZEBENCH_COMPUTER_STATE_ROOT")
    if configured:
        return Path(configured).expanduser()
    return _records_root() / "computer"


def _validate_run_name(name: str) -> str:
    value = str(name).strip()
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if (
        not value
        or value in (".", "..")
        or Path(value).name != value
        or any(char not in allowed for char in value)
    ):
        raise CliError(
            "run name may contain only letters, numbers, '.', '_', and '-'"
        )
    return value


def _record_dir(run_name: str) -> Path:
    return _records_root() / run_name


def _run_control_dir(run_name: str) -> Path:
    return _control_root() / "runs" / run_name


def _state_file(run_name: str) -> Path:
    return _run_control_dir(run_name) / "state.json"


def _write_private_json(path: Path, value: dict) -> None:
    _write_json_file(path, value)
    try:
        path.chmod(0o600)
    except OSError:
        pass


def _prepare_record_dir(run_name: str) -> Path:
    directory = _record_dir(run_name)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "move_history").mkdir(exist_ok=True)
    (directory / "moves.txt").touch(exist_ok=True)
    (directory / "current_board.txt").touch(exist_ok=True)
    state_path = directory / "current_state.json"
    if not state_path.exists():
        _write_json_file(
            state_path,
            {"died": False, "gems": 0, "rooms_available": []},
        )
    return directory


def _server_env(root: Path, runtime_dir: Path, token: str) -> dict[str, str]:
    return {
        **os.environ,
        "MAZEBENCH_REPO_ROOT": str(root),
        "MAZEBENCH_RUN_DIR": str(runtime_dir),
        "MAZEBENCH_SESSION_FILE": str(runtime_dir / "session.json"),
        "MAZEBENCH_MCP_HTTP_TOKEN": token,
        "MAZEBENCH_RESTRICTED_MODE": "1",
        "MAZEBENCH_MODE": "text",
        "MAZEBENCH_AUTO_RUN_TOOLS": "1",
        "MAZEBENCH_LEVEL_ID": os.environ.get("MAZEBENCH_LEVEL_ID", "HxI"),
        "MAZEBENCH_VIEW": os.environ.get("MAZEBENCH_VIEW", "top-diagonal"),
        "MAZEBENCH_YAW": os.environ.get("MAZEBENCH_YAW", "0"),
        "MAZEBENCH_MOVE_BUDGET": os.environ.get(
            "MAZEBENCH_MOVE_BUDGET", "unlimited"
        ),
    }


def _live_state(run_name: str) -> dict | None:
    state = _read_json_file(_state_file(run_name))
    if not state or not state.get("url") or state.get("stopped_at"):
        return None
    if not _pid_alive(int(state.get("pid", 0) or 0)):
        return None
    return state


def _tool_error(payload: dict) -> str | None:
    if payload.get("error"):
        return json.dumps(payload["error"], separators=(",", ":"))
    result = payload.get("result")
    if not isinstance(result, dict) or not result.get("isError"):
        return None
    content = result.get("content")
    if isinstance(content, list) and content and isinstance(content[0], dict):
        text = content[0].get("text")
        if text:
            return str(text)
    return "MazeBench rejected the command"


def _structured_observation(payload: dict) -> dict:
    result = payload.get("result")
    if isinstance(result, dict):
        structured = result.get("structuredContent")
        if isinstance(structured, dict):
            return structured
    raise CliError("MazeBench response did not include structured game state")


def _ascii_board(payload: dict) -> str:
    board = _structured_observation(payload).get("level")
    if not isinstance(board, str):
        raise CliError("MazeBench response did not include an ASCII board")
    return board if board.endswith("\n") else f"{board}\n"


def _room_label(value: object) -> str:
    room = str(value or "").strip()
    if room.startswith("level_"):
        room = room[len("level_") :]
    if "x" in room:
        left, right = room.split("x", 1)
        if left and right:
            return f"{left}x{right}"
    return room


def _update_current(run_name: str, payload: dict) -> None:
    structured = _structured_observation(payload)
    directory = _prepare_record_dir(run_name)
    (directory / "current_board.txt").write_text(_ascii_board(payload))

    visited = structured.get("visited_levels")
    if not isinstance(visited, list):
        visited = []
    rooms: list[str] = []
    for value in [*visited, structured.get("current_room")]:
        room = _room_label(value)
        if room and room not in rooms:
            rooms.append(room)

    try:
        gems = max(0, int(structured.get("gem_count", 0) or 0))
    except (TypeError, ValueError):
        gems = 0
    _write_json_file(
        directory / "current_state.json",
        {
            "died": bool(structured.get("player_dead", False)),
            "gems": gems,
            "rooms_available": rooms,
        },
    )


def _move_label(action: str) -> str:
    value = str(action).strip()
    prefix = "rotate camera "
    if value.lower().startswith(prefix):
        return f"rotate {value[len(prefix):]}"
    room_prefix = "go to level "
    if value.lower().startswith(room_prefix):
        coordinates = value[len(room_prefix) :].split()
        if len(coordinates) == 2:
            return f"room {coordinates[0].upper()}x{coordinates[1].upper()}"
    return value


def _move_slug(label: str) -> str:
    slug = "_".join(label.lower().split())
    slug = "".join(char if char.isalnum() or char in "_-" else "_" for char in slug)
    return slug.strip("_") or "action"


def _record_move(run_name: str, action: str, payload: dict) -> None:
    directory = _prepare_record_dir(run_name)
    history_dir = directory / "move_history"
    moves_path = directory / "moves.txt"
    existing_numbers = []
    for path in history_dir.glob("move_*_*.txt"):
        number = path.name.split("_", 2)[1]
        if number.isdigit():
            existing_numbers.append(int(number))
    move_number = max(
        max(existing_numbers, default=0),
        len(moves_path.read_text().splitlines()),
    ) + 1
    label = _move_label(action)
    filename = f"move_{move_number}_{_move_slug(label)}.txt"
    (history_dir / filename).write_text(_ascii_board(payload))
    with open(moves_path, "a", encoding="utf-8") as moves:
        moves.write(f"{label}\n")


def _record_start(run_name: str, payload: dict) -> None:
    start_path = _prepare_record_dir(run_name) / "move_history" / "move_0.txt"
    if not start_path.exists():
        board = None
        state = _read_json_file(_state_file(run_name)) or {}
        runtime_dir = Path(str(state.get("runtime_dir") or ""))
        if runtime_dir.is_dir():
            initial = _read_json_file(runtime_dir / "initial-status.json") or {}
            initial_board = initial.get("level")
            if isinstance(initial_board, str):
                board = initial_board if initial_board.endswith("\n") else f"{initial_board}\n"
        start_path.write_text(board or _ascii_board(payload))


def _call(
    run_name: str,
    tool_name: str,
    arguments: dict | None = None,
    *,
    record_action: str | None = None,
    record_start: bool = False,
) -> int:
    state = _live_state(run_name)
    if state is None:
        raise CliError(f"game session for {run_name!r} is not running")
    request = {
        "jsonrpc": "2.0",
        "id": time.time_ns() % 1_000_000_000,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments or {}},
    }
    payload = _lan_rpc(str(state["url"]), request)
    error = _tool_error(payload)
    if error:
        raise CliError(error)
    _update_current(run_name, payload)
    if record_start:
        _record_start(run_name, payload)
    if record_action is not None:
        _record_move(run_name, record_action, payload)
    return 0


def _start_server(run_name: str) -> int:
    _prepare_record_dir(run_name)
    if _live_state(run_name) is not None:
        return _call(run_name, "game_observe", record_start=True)

    _require(_node_bin(), "Install Node.js (the local game server runs on Node).")
    control_dir = _run_control_dir(run_name)
    control_dir.mkdir(parents=True, exist_ok=True)
    previous = _read_json_file(_state_file(run_name)) or {}
    previous_runtime = Path(str(previous.get("runtime_dir") or ""))
    if previous_runtime.is_dir() and previous_runtime.parent == control_dir:
        runtime_dir = previous_runtime
    else:
        runtime_dir = control_dir / "runtime"
        runtime_dir.mkdir(exist_ok=True)

    root = resolve_root()
    host = "127.0.0.1"
    port = _find_free_port(host, 7331)
    token = secrets.token_urlsafe(18)
    launch_id = f"{time.time_ns()}-{os.getpid()}"
    port_file = control_dir / f"mcp-http-{launch_id}.json"
    log_path = runtime_dir / "server.log"
    command = [
        _node_bin(),
        str(root / "scripts" / "maze-mcp-server.js"),
        "--http",
        "--host",
        host,
        "--port",
        str(port),
        "--port-file",
        str(port_file),
    ]
    with open(log_path, "ab") as log:
        process = subprocess.Popen(
            command,
            cwd=str(root),
            env=_server_env(root, runtime_dir, token),
            stdout=log,
            stderr=log,
            start_new_session=True,
        )

    server = _wait_for_lan_port_file(process.pid, port_file)
    if not server:
        _terminate_pid(process.pid, timeout=1.0)
        raise CliError(f"local game server failed to start; see {log_path}")

    state = {
        "run": run_name,
        "pid": process.pid,
        "host": host,
        "port": int(server.get("port", port)),
        "url": f"http://{host}:{int(server.get('port', port))}/{token}/lead",
        "runtime_dir": str(runtime_dir),
        "observation_mode": "ascii",
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    _write_private_json(_state_file(run_name), state)
    try:
        return _call(run_name, "game_start", record_start=True)
    except Exception:
        _terminate_pid(process.pid, timeout=1.0)
        state["stopped_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        _write_private_json(_state_file(run_name), state)
        raise


def _stop_server(run_name: str) -> None:
    state = _read_json_file(_state_file(run_name))
    if not state:
        return
    _terminate_pid(int(state.get("pid", 0) or 0))
    state["stopped_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    _write_private_json(_state_file(run_name), state)


def _normalize_action(parts: list[str]) -> str:
    action = " ".join(parts).strip()
    if not action:
        raise CliError("use `action <move>`")
    lowered = action.lower()
    if lowered.startswith("room "):
        room = action.split(None, 1)[1].strip().upper()
        letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        if (
            len(room) != 3
            or room[0] not in letters
            or room[1] != "X"
            or room[2] not in letters
        ):
            raise CliError("use `action room HxI`")
        return f"go to level {room[0]} {room[2]}"
    if lowered.startswith("go to level"):
        raise CliError("use `action room HxI`")
    if lowered.startswith("rotate "):
        direction = lowered.removeprefix("rotate ").strip()
        if direction not in ("up", "down", "left", "right"):
            raise CliError("rotation must be up, down, left, or right")
        return f"rotate camera {direction}"
    return _normalize_lan_action(action)


def _sequence_actions(parts: list[str]) -> list[str]:
    if len(parts) != 1:
        raise CliError("use `action sequence <UDLR...>`")
    sequence = parts[0].strip().upper()
    if not sequence or any(move not in "UDLR" for move in sequence):
        raise CliError("sequence may contain only U, D, L, and R")
    aliases = {"U": "up", "D": "down", "L": "left", "R": "right"}
    return [aliases[move] for move in sequence]


def login_mode(run_name: str) -> int:
    run_name = _validate_run_name(run_name)
    _start_server(run_name)
    try:
        while True:
            try:
                line = input(f"({run_name}) ")
            except (EOFError, KeyboardInterrupt):
                print()
                return 0
            try:
                tokens = shlex.split(line)
            except ValueError as error:
                print(f"computer: {error}", file=sys.stderr)
                continue
            if not tokens:
                continue
            if tokens[0].lower() != "action":
                print("computer: only `action <move>` is available", file=sys.stderr)
                continue
            if " ".join(tokens[1:]).strip().lower() == "quit":
                return 0
            try:
                if len(tokens) >= 2 and tokens[1].lower() == "sequence":
                    for action in _sequence_actions(tokens[2:]):
                        _call(
                            run_name,
                            "game_action",
                            {"action": action},
                            record_action=action,
                        )
                    continue
                action = _normalize_action(tokens[1:])
                _call(
                    run_name,
                    "game_action",
                    {"action": action},
                    record_action=action,
                )
            except (CliError, OSError) as error:
                print(f"computer: {error}", file=sys.stderr)
    finally:
        _stop_server(run_name)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0].lower() in ("help", "-h", "--help"):
        print(USAGE)
        return 0
    if len(argv) != 2 or argv[0].lower() != "login":
        print("computer: use `computer login <run-name>`", file=sys.stderr)
        return 1
    try:
        return login_mode(argv[1])
    except (CliError, OSError) as error:
        print(f"computer: {error}", file=sys.stderr)
        return 1
