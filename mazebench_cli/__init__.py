"""mazebench: one command to run the MazeBench game locally or through Prime.

This is a thin launcher. The maze engine and replay/video renderer are Node
scripts in the repo; evaluated agents run through the isolated Prime path.

Examples
--------
    mazebench replay outputs/maze-local/codex/<run>/    # (re)make the video
    mazebench ascii --level CxD         # interactive ASCII game
    mazebench json --level CxD          # model-facing structured observation
    mazebench play                      # interactive human REPL
    mazebench prime install             # prime env install mazebench
    mazebench prime eval model=openai/gpt-5-nano n=1 r=1
    mazebench prime vision model=openai/gpt-4.1-mini
"""

from __future__ import annotations

import json
import hashlib
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

__version__ = "0.2.19"

USAGE = """mazebench — run the MazeBench maze game

Launch the website (Play / Build / Agent modes in your browser):
  mazebench launch [port=3000 host=127.0.0.1 open=true]   run it (Ctrl-C to stop)
  mazebench launch bg                                      run it in the background
  mazebench status                                         is it running? where?
  mazebench stop                                           shut down a running site
  mazebench restart [port=… bg]                            stop, then launch again

  The port is chosen automatically: it starts at 3000 (or your port=) and moves
  to the next free port if that one is busy, so a launch never fails on a port
  clash. The live URL is printed and saved so stop/status/restart just work.

Evaluated game agents:
  Launch the Game agent from the Agent page. A fixed trusted relay gives the
  model only named game controls; the game server runs in a separate Prime
  Sandbox with no host mounts.

Replay / video from a finished run or a Prime eval dir:
  mazebench replay <session-dir | session.json | results.jsonl> [video=on fast=on]

Interactive ASCII game (arrow-key controls):
  mazebench ascii [--level CxD] [--view top-diagonal]

Model-facing JSON observation (literal names by default):
  mazebench json [--level CxD] [--omniscient] [--hide-names]

Local-network JSON game bridge (game controls only):
  mazebench lan serve bg [port=7331 host=0.0.0.0 level=HxI moves=unlimited]
  mazebench lan status | stop | restart | discover
  mazebench lan start | observe | action <move> | sequence <moves...>

Restricted two-Mac host:
  mazebench host <pairing-code> [level=HxI]
  mazebench host status | stop
  mazebench kill host

Interactive command REPL:
  mazebench play [level=HxI view=top-diagonal]

Prime Intellect Verifiers:
  mazebench prime install
  mazebench prime eval   [model=openai/gpt-5-nano n=1 r=1 max_turns=8]
  mazebench prime vision [model=openai/gpt-4.1-mini width=512 height=512 max_turns=8]
Repo root is auto-detected; override with MAZEBENCH_REPO_ROOT.
"""


class CliError(RuntimeError):
    pass


RETIRED_LOCAL_AGENT_MESSAGE = (
    "Local coding-agent launches are retired because they can expose repository or "
    "host capabilities. Use the Agent page, which launches maze-prime-run.js with "
    "the mazebench-tools taskset."
)


def _is_repo_root(path: Path) -> bool:
    return (path / "package.json").is_file() and (
        path / "scripts" / "maze-bridge.js"
    ).is_file()


def find_repo_root() -> Path:
    env = os.environ.get("MAZEBENCH_REPO_ROOT")
    if env:
        candidate = Path(env).expanduser().resolve()
        if _is_repo_root(candidate):
            return candidate
        raise CliError(f"MAZEBENCH_REPO_ROOT={env!r} is not a MazeBench checkout")

    for start in (Path.cwd(), Path(__file__).resolve().parent):
        current = start
        while True:
            if _is_repo_root(current):
                return current
            if current.parent == current:
                break
            current = current.parent

    raise CliError(
        "Could not locate the MazeBench repo (looked for package.json + "
        "scripts/maze-bridge.js).\nRun from inside the checkout or set "
        "MAZEBENCH_REPO_ROOT=/path/to/PixelGameTest."
    )


def _packaged_runtime() -> Path | None:
    """The Node runtime bundled into the wheel (mazebench_cli/_runtime)."""
    candidate = Path(__file__).resolve().parent / "_runtime"
    return candidate if _is_repo_root(candidate) else None


def _workspace_dir() -> Path:
    return Path(os.environ.get("MAZEBENCH_HOME", "~/.mazebench")).expanduser() / "site"


def _materialize_workspace(runtime: Path) -> Path:
    """Copy the packaged runtime into a writable workspace (~/.mazebench/site).

    The site writes next to its root (draft worlds under games/, run artifacts
    under outputs/, account state under data/), so it cannot run from
    site-packages. Runtime code is refreshed whenever the packaged version
    changes; user content (games/draft-*, outputs/, data/, and any master-world
    edits) is left alone.
    """
    workspace = _workspace_dir()
    version_file = workspace / ".runtime-version"
    packaged_version = (
        (runtime / ".runtime-version").read_text().strip()
        if (runtime / ".runtime-version").is_file()
        else __version__
    )
    current_version = version_file.read_text().strip() if version_file.is_file() else ""

    if current_version != packaged_version or not _is_repo_root(workspace):
        workspace.mkdir(parents=True, exist_ok=True)
        for name in ("shared", "server", "public", "scripts", "vendor", "environments"):
            source = runtime / name
            if source.is_dir():
                shutil.copytree(source, workspace / name, dirs_exist_ok=True)
        for name in ("server.js", "package.json"):
            shutil.copy2(runtime / name, workspace / name)
        # The master world is seeded once and then owned by the user (it is
        # editable in Build Mode); draft worlds are never touched.
        if not (workspace / "games" / "maze").is_dir():
            shutil.copytree(runtime / "games" / "maze", workspace / "games" / "maze")
        version_file.write_text(f"{packaged_version}\n")
        print(f"mazebench: workspace ready at {workspace}", file=sys.stderr)

    return workspace


def resolve_root() -> Path:
    """A repo checkout if we are in one, else the pip-installed workspace."""
    try:
        return find_repo_root()
    except CliError:
        runtime = _packaged_runtime()
        if runtime is None:
            raise
        return _materialize_workspace(runtime)


def parse_args(argv: list[str]) -> tuple[list[str], dict[str, str], list[str]]:
    """Split argv into leading barewords, key=value pairs, and leftover flags."""
    words: list[str] = []
    pairs: dict[str, str] = {}
    flags: list[str] = []
    only_flags = False

    for token in argv:
        if "=" in token and not token.startswith("-"):
            key, value = token.split("=", 1)
            pairs[key.replace("-", "_")] = value
            only_flags = True
        elif token.startswith("-"):
            flags.append(token)
            only_flags = True
        elif only_flags:
            flags.append(token)
        else:
            words.append(token)

    return words, pairs, flags


def _node_bin() -> str:
    return os.environ.get("MAZEBENCH_NODE", "node")


def _require(binary: str, hint: str) -> None:
    if shutil.which(binary) is None:
        raise CliError(f"`{binary}` was not found on PATH. {hint}")


def _run(cmd: list[str], cwd: Path) -> int:
    printable = " ".join(str(part) for part in cmd)
    print(f"$ {printable}", file=sys.stderr)
    return subprocess.call(cmd, cwd=str(cwd))


def _pairs_to_kv(pairs: dict[str, str]) -> list[str]:
    return [f"{key}={value}" for key, value in pairs.items()]


def run_local(root: Path, model: str, pairs: dict[str, str], flags: list[str]) -> int:
    raise CliError(RETIRED_LOCAL_AGENT_MESSAGE)


def run_replay(
    root: Path, words: list[str], pairs: dict[str, str], flags: list[str]
) -> int:
    _require(_node_bin(), "Install Node.js.")
    target = words[0] if words else pairs.get("path") or pairs.get("dir")
    if not target:
        raise CliError(
            "replay needs a path: mazebench replay <session-dir|results.jsonl>"
        )
    cmd = [_node_bin(), str(root / "scripts" / "maze-export-replay.js"), target]
    if pairs.get("video", "on").lower() in ("off", "false", "0", "no"):
        cmd.append("--no-video")
    for boolean in ("fast", "draft"):
        if pairs.get(boolean, "").lower() in ("on", "true", "1", "yes"):
            cmd.append(f"--{boolean}")
    for numeric in ("width", "height", "fps"):
        if numeric in pairs:
            cmd.extend([f"--{numeric}", pairs[numeric]])
    cmd.extend(flags)
    return _run(cmd, root)


def run_play(root: Path, pairs: dict[str, str], flags: list[str]) -> int:
    _require(_node_bin(), "Install Node.js.")
    cmd = [_node_bin(), str(root / "scripts" / "maze-model-repl.js")]
    if "level" in pairs:
        cmd.extend(["--level", pairs["level"]])
    if "view" in pairs:
        cmd.extend(["--view", pairs["view"]])
    cmd.extend(flags)
    return _run(cmd, root)


def run_ascii(root: Path, pairs: dict[str, str], flags: list[str]) -> int:
    """Launch the interactive arrow-key ASCII renderer."""
    _require(_node_bin(), "Install Node.js (the maze engine runs on Node).")
    cmd = [_node_bin(), str(root / "scripts" / "maze-terminal.js")]
    if "level" in pairs:
        cmd.extend(["--level", pairs["level"]])
    if "view" in pairs:
        cmd.extend(["--view", pairs["view"]])
    cmd.extend(flags)
    return _run(cmd, root)


def run_json(root: Path, pairs: dict[str, str], flags: list[str]) -> int:
    """Print the same structured JSON observation exposed to model runners."""
    _require(_node_bin(), "Install Node.js (the maze engine runs on Node).")
    cmd = [_node_bin(), str(root / "scripts" / "maze-terminal.js"), "--json"]
    if "level" in pairs:
        cmd.extend(["--level", pairs["level"]])
    if "view" in pairs:
        cmd.extend(["--view", pairs["view"]])
    if _is_on(pairs.get("omniscient", "")):
        cmd.append("--omniscient")
    if _is_on(pairs.get("hide_names", "")):
        cmd.append("--hide-names")
        if pairs.get("hide_names_seed"):
            cmd.extend(["--hide-names-seed", pairs["hide_names_seed"]])
    cmd.extend(flags)
    return _run(cmd, root)


# ---- website lifecycle (launch / stop / status / restart) -----------------
#
# The server records {pid, host, port, url, started_at} in a small state file
# when it binds and removes it on exit, so stop/status/restart work from any
# terminal without the user tracking process ids. The port is chosen so a launch
# never dies on a clash: we probe upward from the preferred port for a free one,
# and server.js walks upward too if it still loses a race.


def _mazebench_home() -> Path:
    return Path(os.environ.get("MAZEBENCH_HOME", "~/.mazebench")).expanduser()


def _state_file() -> Path:
    return _mazebench_home() / "server.json"


def _server_log() -> Path:
    return _mazebench_home() / "server.log"


def _pid_alive(pid: int) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, just owned by another user
    except OSError:
        return False
    return True


def _read_state() -> dict | None:
    """The running server's record, or None (clearing a stale file)."""
    try:
        state = json.loads(_state_file().read_text())
    except (OSError, ValueError):
        return None
    if not _pid_alive(int(state.get("pid", 0) or 0)):
        _clear_state()
        return None
    return state


def _clear_state() -> None:
    _state_file().unlink(missing_ok=True)


def _bind_host(host: str) -> str:
    return "" if host in ("0.0.0.0", "::", "*") else host


def _port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((_bind_host(host), port))
            return True
        except OSError:
            return False


def _find_free_port(host: str, preferred: int, span: int = 50) -> int:
    for candidate in range(preferred, preferred + span):
        if 0 < candidate < 65536 and _port_is_free(host, candidate):
            return candidate
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((_bind_host(host), 0))  # OS-assigned free port
        return sock.getsockname()[1]


def _wait_for_state(pid: int, timeout: float = 6.0) -> dict | None:
    """Poll until the just-started server writes its bound port, or it dies."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            state = json.loads(_state_file().read_text())
            if int(state.get("pid", 0) or 0) == pid and state.get("url"):
                return state
        except (OSError, ValueError):
            pass
        if not _pid_alive(pid):
            return None
        time.sleep(0.15)
    return None


def _open_when_ready(pid: int, fallback_url: str) -> None:
    state = _wait_for_state(pid)
    webbrowser.open(state["url"] if state and state.get("url") else fallback_url)


def _is_on(value: str) -> bool:
    return value.strip().lower() in ("1", "true", "on", "yes", "bg")


def run_launch(
    root: Path, words: list[str], pairs: dict[str, str], flags: list[str]
) -> int:
    """Serve the website (Play / Build / Agent modes) from `root`."""
    _require(_node_bin(), "Install Node.js (the site and maze engine run on Node).")

    open_browser = pairs.get("open", "true").lower() not in ("off", "false", "0", "no")
    background = "bg" in words or _is_on(pairs.get("background", pairs.get("bg", "")))
    host = pairs.get("host", "127.0.0.1")

    # Already running? Point at it rather than starting a second server.
    existing = _read_state()
    if existing:
        url = existing.get("url", "")
        print(
            f"mazebench: already running at {url} (pid {existing.get('pid')}).",
            file=sys.stderr,
        )
        print(
            "  Use `mazebench stop` to shut it down, or `mazebench restart` for a fresh one.",
            file=sys.stderr,
        )
        if open_browser and url:
            webbrowser.open(url)
        return 0

    try:
        preferred = int(pairs.get("port", "3000") or "3000")
    except ValueError:
        preferred = 3000
    port = _find_free_port(host, preferred)
    if port != preferred:
        print(
            f"mazebench: port {preferred} is busy — using {port} instead.",
            file=sys.stderr,
        )

    state_file = _state_file()
    state_file.parent.mkdir(parents=True, exist_ok=True)
    _clear_state()
    env = dict(
        os.environ, PORT=str(port), HOST=host, MAZEBENCH_STATE_FILE=str(state_file)
    )
    display_host = "localhost" if host in ("0.0.0.0", "::") else host
    url = f"http://{display_host}:{port}"
    cmd = [_node_bin(), str(root / "server.js"), *flags]

    if background:
        log_path = _server_log()
        with open(log_path, "ab") as log:
            proc = subprocess.Popen(
                cmd,
                cwd=str(root),
                env=env,
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
        state = _wait_for_state(proc.pid)
        if state is None:
            print(
                f"mazebench: the server did not come up — see {log_path}",
                file=sys.stderr,
            )
            return 1
        print(
            f"mazebench: running in the background at {state['url']} (pid {state['pid']}).",
            file=sys.stderr,
        )
        print(
            "  Stop it with `mazebench stop`; check it with `mazebench status`.",
            file=sys.stderr,
        )
        if open_browser:
            webbrowser.open(state["url"])
        return 0

    print(
        f"mazebench: serving {url}  (Ctrl-C to stop; or `mazebench stop` elsewhere)",
        file=sys.stderr,
    )
    proc = subprocess.Popen(cmd, cwd=str(root), env=env)
    if open_browser:
        threading.Thread(
            target=_open_when_ready, args=(proc.pid, url), daemon=True
        ).start()

    try:
        return proc.wait()
    except KeyboardInterrupt:
        # Ctrl-C already reached the child (shared process group); let it clean up.
        try:
            proc.wait(timeout=8)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            proc.terminate()
        return 0
    finally:
        _clear_state()  # backstop if the server crashed without clearing it


def run_stop(root: Path, pairs: dict[str, str]) -> int:
    state = _read_state()
    if not state:
        print("mazebench: no running site found (nothing to stop).", file=sys.stderr)
        return 0

    pid = int(state.get("pid", 0) or 0)
    url = state.get("url", "")
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        _clear_state()
        print(
            "mazebench: the site was already gone; cleared its record.", file=sys.stderr
        )
        return 0

    for _ in range(50):  # up to ~5s for a clean shutdown
        if not _pid_alive(pid):
            break
        time.sleep(0.1)
    else:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass

    _clear_state()
    print(f"mazebench: stopped the site at {url} (pid {pid}).", file=sys.stderr)
    return 0


def run_status(root: Path) -> int:
    state = _read_state()
    if not state:
        print("mazebench: not running. Start it with `mazebench launch`.")
        return 0
    print(
        f"mazebench: running at {state.get('url')} "
        f"(pid {state.get('pid')}, since {state.get('started_at', '?')})."
    )
    return 0


def run_restart(
    root: Path, words: list[str], pairs: dict[str, str], flags: list[str]
) -> int:
    old = _read_state()
    # Keep the same port on restart unless the user asked for a different one.
    if old and "port" not in pairs and old.get("port"):
        pairs = {**pairs, "port": str(old["port"])}
    run_stop(root, pairs)
    time.sleep(0.4)  # let the port fully release before we grab it again
    return run_launch(root, words, pairs, flags)


# ---- local-network JSON game bridge ---------------------------------------

LAN_SERVICE_TYPE = "_mazebench._tcp"
LAN_HOST_SERVICE_PREFIX = "MazeBench-"
LAN_TOOL_NAMES = (
    "game_start",
    "game_observe",
    "game_action",
    "game_action_sequence",
)
LAN_MOVE_ALIASES = {
    "U": "up",
    "D": "down",
    "L": "left",
    "R": "right",
}

LAN_USAGE = """mazebench lan — expose or use MazeBench JSON game controls on your LAN

Serve from this Mac:
  mazebench lan serve bg [port=7331 host=0.0.0.0 level=HxI moves=unlimited]
  mazebench lan status
  mazebench lan stop
  mazebench lan restart

Use from this Mac or another Mac:
  mazebench lan start   [url=http://host:port/token/lead]
  mazebench lan observe [url=http://host:port/token/lead]
  mazebench lan action up
  mazebench lan sequence up right down
  mazebench lan sequence UURDDL
  mazebench lan tools
  mazebench lan discover

The LAN server always runs the restricted JSON MCP profile: game_start,
game_observe, game_action, and game_action_sequence only.
"""


def _lan_dir() -> Path:
    configured = os.environ.get("MAZEBENCH_LAN_STATE_ROOT")
    if configured:
        return Path(configured).expanduser()
    records_root = Path(
        os.environ.get("MAZEBENCH_RECORDS_ROOT", "~/records")
    ).expanduser()
    return records_root / "computer" / "host"


def _legacy_lan_dir() -> Path:
    return _mazebench_home() / "lan"


def _migrate_legacy_host_dir() -> str:
    legacy_dir = _legacy_lan_dir()
    visible_dir = _lan_dir()
    if legacy_dir == visible_dir or not legacy_dir.exists():
        return ""

    legacy_state = _read_json_file(legacy_dir / "server.json") or {}
    legacy_url = str(legacy_state.get("url") or "")
    _terminate_pid(int(legacy_state.get("advertiser_pid", 0) or 0), timeout=0.5)
    _terminate_pid(int(legacy_state.get("pid", 0) or 0))
    (legacy_dir / "server.json").unlink(missing_ok=True)
    (legacy_dir / "mcp-http.json").unlink(missing_ok=True)

    visible_dir.parent.mkdir(parents=True, exist_ok=True)
    if visible_dir.exists():
        destination = visible_dir / f"legacy-lan-{time.time_ns()}"
    else:
        destination = visible_dir
    legacy_dir.rename(destination)
    return legacy_url


def _lan_state_file() -> Path:
    return _lan_dir() / "server.json"


def _lan_port_file() -> Path:
    return _lan_dir() / "mcp-http.json"


def _lan_log() -> Path:
    return _lan_dir() / "server.log"


def _lan_advertise_log() -> Path:
    return _lan_dir() / "dns-sd.log"


def _read_json_file(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def _write_json_file(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(f"{json.dumps(value, indent=2)}\n")
    temporary.replace(path)


def _clear_lan_state() -> None:
    _lan_state_file().unlink(missing_ok=True)
    _lan_port_file().unlink(missing_ok=True)


def _terminate_pid(pid: int, timeout: float = 5.0) -> None:
    if not _pid_alive(pid):
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            return
        time.sleep(0.1)

    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


def _read_lan_state() -> dict | None:
    state = _read_json_file(_lan_state_file())
    if not state:
        return None
    if not _pid_alive(int(state.get("pid", 0) or 0)):
        _terminate_pid(int(state.get("advertiser_pid", 0) or 0), timeout=0.5)
        _clear_lan_state()
        return None
    return state


def _wait_for_lan_port_file(pid: int, port_file: Path, timeout: float = 6.0) -> dict | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = _read_json_file(port_file)
        if state and int(state.get("pid", 0) or 0) == pid and state.get("port"):
            return state
        if not _pid_alive(pid):
            return None
        time.sleep(0.1)
    return None


def _flag_value(flags: list[str], *names: str) -> str | None:
    for index, token in enumerate(flags):
        if token in names and index + 1 < len(flags):
            return flags[index + 1]
    return None


def _pair_or_flag(
    pairs: dict[str, str],
    flags: list[str],
    key: str,
    *flag_names: str,
    default: str = "",
) -> str:
    return pairs.get(key) or _flag_value(flags, *flag_names) or default


def _local_hostname() -> str:
    if shutil.which("scutil"):
        result = subprocess.run(
            ["scutil", "--get", "LocalHostName"],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and result.stdout.strip():
            return f"{result.stdout.strip()}.local"
    hostname = socket.gethostname().strip().rstrip(".")
    if hostname:
        return hostname if hostname.endswith(".local") else f"{hostname}.local"
    return "localhost"


def _lan_ipv4_addresses() -> list[str]:
    addresses: set[str] = set()

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        try:
            sock.connect(("8.8.8.8", 80))
            addresses.add(sock.getsockname()[0])
        except OSError:
            pass

    if shutil.which("ifconfig"):
        result = subprocess.run(["ifconfig"], capture_output=True, text=True)
        for line in result.stdout.splitlines():
            parts = line.strip().split()
            if len(parts) >= 2 and parts[0] == "inet":
                addresses.add(parts[1])

    return sorted(
        address
        for address in addresses
        if not address.startswith(("127.", "169.254."))
    )


def _lan_urls(host: str, port: int, token: str) -> list[str]:
    candidates: list[str] = []
    if host in ("0.0.0.0", "", "*"):
        candidates.extend(f"http://{address}:{port}/{token}/lead" for address in _lan_ipv4_addresses())
        candidates.append(f"http://{_local_hostname()}:{port}/{token}/lead")
        candidates.append(f"http://127.0.0.1:{port}/{token}/lead")
    else:
        candidates.append(f"http://{host}:{port}/{token}/lead")

    unique: list[str] = []
    for url in candidates:
        if url not in unique:
            unique.append(url)
    return unique


def _default_lan_url(state: dict) -> str:
    return str(state.get("url") or next(iter(state.get("urls", [])), ""))


def _start_lan_advertiser(
    service_name: str,
    port: int,
    enabled: bool,
    mode: str = "json",
) -> int | None:
    if not enabled or not shutil.which("dns-sd"):
        return None
    log_path = _lan_advertise_log()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "ab") as log:
        proc = subprocess.Popen(
            [
                "dns-sd",
                "-R",
                service_name,
                LAN_SERVICE_TYPE,
                "local",
                str(port),
                "txtvers=1",
                f"mode={mode}",
                "tools=game-only",
                "protocol=mcp-jsonrpc",
            ],
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
    return proc.pid


def _lan_server_env(root: Path, run_dir: Path, token: str, pairs: dict[str, str], flags: list[str]) -> dict[str, str]:
    level = _pair_or_flag(pairs, flags, "level", "--level", default="HxI")
    view = _pair_or_flag(pairs, flags, "view", "--view", default="top-diagonal")
    yaw = _pair_or_flag(pairs, flags, "yaw", "--yaw", default="0")
    moves = (
        pairs.get("moves")
        or pairs.get("max_turns")
        or _flag_value(flags, "--max-turns")
        or "unlimited"
    )
    mode = pairs.get("mode", "json").strip().lower()
    if mode not in ("json", "text"):
        raise CliError("LAN observation mode must be 'json' or 'text'.")
    return {
        **os.environ,
        "MAZEBENCH_REPO_ROOT": str(root),
        "MAZEBENCH_RUN_DIR": str(run_dir),
        "MAZEBENCH_SESSION_FILE": str(run_dir / "session.json"),
        "MAZEBENCH_MCP_HTTP_TOKEN": token,
        "MAZEBENCH_RESTRICTED_MODE": "1",
        "MAZEBENCH_MODE": mode,
        "MAZEBENCH_AUTO_RUN_TOOLS": "1",
        "MAZEBENCH_LEVEL_ID": level,
        "MAZEBENCH_VIEW": view,
        "MAZEBENCH_YAW": yaw,
        "MAZEBENCH_MOVE_BUDGET": str(moves),
    }


def run_lan_serve(words: list[str], pairs: dict[str, str], flags: list[str]) -> int:
    _require(_node_bin(), "Install Node.js (the LAN bridge runs on Node).")
    existing = _read_lan_state()
    if existing:
        print(
            f"mazebench: LAN JSON bridge already running at {_default_lan_url(existing)} "
            f"(pid {existing.get('pid')}).",
            file=sys.stderr,
        )
        return 0

    root = resolve_root()
    host = _pair_or_flag(pairs, flags, "host", "--host", default="0.0.0.0")
    try:
        preferred = int(_pair_or_flag(pairs, flags, "port", "--port", default="7331"))
    except ValueError:
        preferred = 7331
    port = _find_free_port(host, preferred)
    if port != preferred:
        print(f"mazebench: port {preferred} is busy — using {port} instead.", file=sys.stderr)

    token = pairs.get("token") or secrets.token_urlsafe(18)
    if any(char in token for char in "/?#"):
        raise CliError("token may not contain '/', '?', or '#'.")

    run_dir = _lan_dir()
    run_dir.mkdir(parents=True, exist_ok=True)
    if _is_on(pairs.get("fresh", "")):
        for name in (
            "session.json",
            "actions.jsonl",
            "initial-status.json",
            "tool-activity.jsonl",
            "maze-instance-events.jsonl",
        ):
            (run_dir / name).unlink(missing_ok=True)

    port_file = _lan_port_file()
    port_file.unlink(missing_ok=True)
    log_path = _lan_log()
    service_name = pairs.get("name") or f"MazeBench JSON on {_local_hostname().removesuffix('.local')}"
    multi_run = _is_on(pairs.get("multi_run", ""))
    environment = _lan_server_env(root, run_dir, token, pairs, flags)
    if multi_run:
        environment.update(
            {
                "MAZEBENCH_HOST_BASE_DIR": str(run_dir),
                "MAZEBENCH_HOST_BIND": host,
                "MAZEBENCH_HOST_PORT": str(port),
                "MAZEBENCH_HOST_PORT_FILE": str(port_file),
                "MAZEBENCH_NODE_BIN": _node_bin(),
            }
        )
        cmd = [sys.executable, "-m", "mazebench_cli.host"]
    else:
        cmd = [
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
        proc = subprocess.Popen(
            cmd,
            cwd=str(root),
            env=environment,
            stdout=log,
            stderr=log,
            start_new_session=True,
        )

    server = _wait_for_lan_port_file(proc.pid, port_file)
    if not server:
        print(f"mazebench: LAN bridge did not come up — see {log_path}", file=sys.stderr)
        return 1

    bound_port = int(server.get("port", port))
    urls = _lan_urls(host, bound_port, token)
    advertise = pairs.get("advertise", "true").lower() not in ("off", "false", "0", "no")
    advertiser_pid = _start_lan_advertiser(
        service_name,
        bound_port,
        advertise,
        mode=pairs.get("mode", "json").strip().lower(),
    )
    state = {
        "pid": proc.pid,
        "advertiser_pid": advertiser_pid,
        "host": host,
        "port": bound_port,
        "token": token,
        "url": urls[0],
        "urls": urls,
        "service_name": service_name,
        "service_type": LAN_SERVICE_TYPE,
        "repo_root": str(root),
        "run_dir": str(run_dir),
        "mode": pairs.get("mode", "json").strip().lower(),
        "multi_run": multi_run,
        "tools": list(LAN_TOOL_NAMES),
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    _write_json_file(_lan_state_file(), state)

    print(f"mazebench: LAN JSON bridge running at {state['url']} (pid {proc.pid}).")
    if advertiser_pid:
        print(f"mazebench: advertised as {service_name}.{LAN_SERVICE_TYPE}.local.")
    elif advertise:
        print("mazebench: dns-sd was not found, so Bonjour advertising is unavailable.")
    print("mazebench: exposed tools: " + ", ".join(LAN_TOOL_NAMES))
    return 0


def run_lan_stop() -> int:
    state = _read_lan_state()
    if not state:
        print("mazebench: no running LAN JSON bridge found.")
        return 0
    _terminate_pid(int(state.get("advertiser_pid", 0) or 0), timeout=0.5)
    _terminate_pid(int(state.get("pid", 0) or 0))
    _clear_lan_state()
    print(f"mazebench: stopped LAN JSON bridge at {_default_lan_url(state)}.")
    return 0


def _validate_host_code(value: str) -> str:
    code = str(value).strip()
    if not code.isdigit() or not 3 <= len(code) <= 12:
        raise CliError("pairing code must contain 3 to 12 digits")
    return code


def _host_service_name(code: str) -> str:
    fingerprint = hashlib.sha256(code.encode("ascii")).hexdigest()[:12]
    return f"{LAN_HOST_SERVICE_PREFIX}{fingerprint}"


def run_host(words: list[str], pairs: dict[str, str], flags: list[str]) -> int:
    action = (words[0] if words else "help").lower()
    if action in ("help", "-h", "--help"):
        print(
            "mazebench host <pairing-code> [level=HxI]\n"
            "mazebench host status\n"
            "mazebench host stop\n"
            "mazebench kill host"
        )
        return 0
    if action in ("stop", "shutdown", "kill") and len(words) == 1:
        legacy_url = _migrate_legacy_host_dir()
        if _read_lan_state():
            return run_lan_stop()
        if legacy_url:
            print(f"mazebench: stopped and migrated legacy host at {legacy_url}.")
            return 0
        return run_lan_stop()
    if action in ("status", "ps") and len(words) == 1:
        legacy_state = _read_json_file(_legacy_lan_dir() / "server.json") or {}
        if legacy_state and _pid_alive(int(legacy_state.get("pid", 0) or 0)):
            print(
                "mazebench: legacy host is running from ~/.mazebench/lan; "
                "rerun `mazebench host <pairing-code>` to migrate it into ~/records."
            )
            return 0
        return run_lan_status()
    if len(words) != 1:
        raise CliError("use `mazebench host <pairing-code>`")

    code = _validate_host_code(words[0])
    _migrate_legacy_host_dir()
    existing = _read_lan_state()
    if existing and str(existing.get("token") or "") != code:
        raise CliError(
            "a different MazeBench host is already running; use `mazebench host stop` first"
        )
    options = {
        **pairs,
        "token": code,
        "name": _host_service_name(code),
        "mode": "text",
        "advertise": "true",
        "multi_run": "true",
    }
    return run_lan_serve([], options, flags)


def run_lan_status() -> int:
    state = _read_lan_state()
    if not state:
        print("mazebench: LAN JSON bridge is not running. Start it with `mazebench lan serve bg`.")
        return 0
    print(f"mazebench: LAN JSON bridge running at {_default_lan_url(state)}")
    print(f"  pid: {state.get('pid')}")
    print(f"  Bonjour: {state.get('service_name')}.{state.get('service_type')}.local")
    print(f"  tools: {', '.join(state.get('tools') or LAN_TOOL_NAMES)}")
    for url in state.get("urls", [])[1:]:
        print(f"  alternate: {url}")
    return 0


def _lan_endpoint(pairs: dict[str, str]) -> str:
    url = pairs.get("url") or os.environ.get("MAZEBENCH_LAN_URL", "")
    if url:
        return url
    state = _read_lan_state()
    if state and _default_lan_url(state):
        return _default_lan_url(state)
    raise CliError(
        "No LAN URL configured. On the server Mac, run `mazebench lan status`, "
        "then pass url=... or set MAZEBENCH_LAN_URL."
    )


def _lan_rpc(
    url: str,
    request: dict,
    *,
    headers: dict[str, str] | None = None,
) -> dict:
    body = json.dumps(request).encode("utf-8")
    http_request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    try:
        with urllib.request.urlopen(http_request, timeout=240) as response:
            text = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(text)
        except ValueError as parse_error:
            raise CliError(f"LAN request failed with HTTP {error.code}: {text}") from parse_error
        raise CliError(f"LAN request failed with HTTP {error.code}: {payload}") from error
    except OSError as error:
        raise CliError(f"LAN request failed: {error}") from error

    try:
        return json.loads(text)
    except ValueError as error:
        raise CliError(f"LAN bridge returned non-JSON data: {text[:200]}") from error


def _lan_tool_call(url: str, name: str, arguments: dict | None = None) -> dict:
    return _lan_rpc(
        url,
        {
            "jsonrpc": "2.0",
            "id": int(time.time() * 1000) % 1_000_000_000,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments or {}},
        },
    )


def _print_lan_payload(payload: dict) -> int:
    if payload.get("error"):
        print(json.dumps(payload, indent=2))
        return 1
    result = payload.get("result")
    if isinstance(result, dict) and "structuredContent" in result:
        printable = result["structuredContent"]
    elif isinstance(result, dict) and result.get("content"):
        text = str(result["content"][0].get("text", ""))
        try:
            printable = json.loads(text)
        except ValueError:
            printable = text
    else:
        printable = payload
    print(json.dumps(printable, indent=2) if not isinstance(printable, str) else printable)
    return 1 if isinstance(result, dict) and result.get("isError") else 0


def _normalize_lan_action(value: str) -> str:
    text = str(value).strip()
    return LAN_MOVE_ALIASES.get(text.upper(), text)


def _lan_action_from_tokens(tokens: list[str]) -> str:
    action = " ".join(tokens).strip()
    if not action:
        raise CliError("LAN action needs a move, for example `mazebench lan action up`.")
    return _normalize_lan_action(action)


def _lan_sequence_from_tokens(tokens: list[str]) -> list[str]:
    if not tokens:
        raise CliError("LAN sequence needs moves, for example `mazebench lan sequence up right down`.")
    if len(tokens) == 1:
        text = tokens[0].strip()
        if text.startswith("["):
            parsed = json.loads(text)
            if not isinstance(parsed, list):
                raise CliError("LAN sequence JSON must be an array of action strings.")
            return [_normalize_lan_action(str(action)) for action in parsed]
        if text and all(char.upper() in LAN_MOVE_ALIASES for char in text):
            return [LAN_MOVE_ALIASES[char.upper()] for char in text]
        if "," in text:
            return [_normalize_lan_action(part) for part in text.split(",") if part.strip()]
    return [_normalize_lan_action(token) for token in tokens if str(token).strip()]


def run_lan_discover(pairs: dict[str, str]) -> int:
    if not shutil.which("dns-sd"):
        raise CliError("dns-sd was not found; Bonjour discovery is unavailable on this machine.")
    try:
        seconds = max(1.0, min(10.0, float(pairs.get("seconds", "3"))))
    except ValueError:
        seconds = 3.0
    try:
        result = subprocess.run(
            ["dns-sd", "-B", LAN_SERVICE_TYPE, "local"],
            capture_output=True,
            text=True,
            timeout=seconds,
        )
        output = result.stdout + result.stderr
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout.decode("utf-8", errors="replace") if isinstance(error.stdout, bytes) else (error.stdout or "")
        stderr = error.stderr.decode("utf-8", errors="replace") if isinstance(error.stderr, bytes) else (error.stderr or "")
        output = stdout + stderr

    services: list[str] = []
    marker = f"{LAN_SERVICE_TYPE}."
    for line in output.splitlines():
        if " Add " not in f" {line} " or marker not in line:
            continue
        service = line.split(marker, 1)[1].strip()
        if service and service not in services:
            services.append(service)

    if not services:
        print("mazebench: no MazeBench LAN services found.")
        return 0
    print("mazebench: discovered MazeBench LAN services:")
    for service in services:
        print(f"  {service}.{LAN_SERVICE_TYPE}.local")
    print("mazebench: use the tokenized URL from `mazebench lan status` on the server Mac.")
    return 0


def run_lan_repl(pairs: dict[str, str]) -> int:
    url = _lan_endpoint(pairs)
    print(f"mazebench: connected to {url}")
    _print_lan_payload(_lan_tool_call(url, "game_start"))
    while True:
        try:
            line = input("mazebench> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        if not line:
            continue
        if line.lower() in ("q", "quit", "exit"):
            return 0
        if line.lower().startswith("sequence "):
            payload = _lan_tool_call(
                url,
                "game_action_sequence",
                {"actions": _lan_sequence_from_tokens([line[9:].strip()])},
            )
        else:
            payload = _lan_tool_call(url, "game_action", {"action": _normalize_lan_action(line)})
        _print_lan_payload(payload)


def run_lan(words: list[str], pairs: dict[str, str], flags: list[str]) -> int:
    action = (words[0] if words else "help").lower()
    if action in ("help", "-h", "--help"):
        print(LAN_USAGE)
        return 0
    if action in ("serve", "launch", "start-server"):
        return run_lan_serve(words[1:], pairs, flags)
    if action == "restart":
        run_lan_stop()
        time.sleep(0.4)
        return run_lan_serve(words[1:], pairs, flags)
    if action in ("stop", "shutdown", "kill"):
        return run_lan_stop()
    if action in ("status", "ps"):
        return run_lan_status()
    if action == "discover":
        return run_lan_discover(pairs)
    if action == "url":
        print(_lan_endpoint(pairs))
        return 0
    if action in ("repl", "play"):
        return run_lan_repl(pairs)

    url = _lan_endpoint(pairs)
    if action == "tools":
        return _print_lan_payload(
            _lan_rpc(
                url,
                {
                    "jsonrpc": "2.0",
                    "id": int(time.time() * 1000) % 1_000_000_000,
                    "method": "tools/list",
                    "params": {},
                },
            )
        )
    if action == "start":
        return _print_lan_payload(_lan_tool_call(url, "game_start"))
    if action == "observe":
        return _print_lan_payload(_lan_tool_call(url, "game_observe"))
    if action in ("action", "move"):
        return _print_lan_payload(
            _lan_tool_call(url, "game_action", {"action": _lan_action_from_tokens(words[1:] + flags)})
        )
    if action in ("sequence", "moves"):
        return _print_lan_payload(
            _lan_tool_call(
                url,
                "game_action_sequence",
                {"actions": _lan_sequence_from_tokens(words[1:] + flags)},
            )
        )
    raise CliError(f"Unknown LAN command: {action!r}. Run `mazebench lan help`.")


def run_wizard(root: Path) -> int:
    raise CliError(RETIRED_LOCAL_AGENT_MESSAGE)


def run_build(root: Path, pairs: dict[str, str], flags: list[str]) -> int:
    raise CliError(RETIRED_LOCAL_AGENT_MESSAGE)


def run_prime(
    root: Path, words: list[str], pairs: dict[str, str], flags: list[str]
) -> int:
    action = (words[0] if words else pairs.get("action") or "help").lower()
    env_dir = root / "environments" / "mazebench"

    if action == "install":
        _require("prime", "Install the Prime CLI: https://docs.primeintellect.ai")
        return _run(["prime", "env", "install", "mazebench"], root)

    if action in {"eval", "vision"}:
        _require("uv", "Install uv: https://docs.astral.sh/uv/")
        if flags:
            raise CliError(
                "Raw eval flags are unavailable because they could replace the "
                "approved game-only harness."
            )
        try:
            moves = int(pairs.get("max_turns", "8" if action == "vision" else "20"))
        except ValueError as error:
            raise CliError("max_turns must be a positive integer") from error
        if moves < 1:
            raise CliError("max_turns must be a positive integer")
        model = pairs.get(
            "model",
            "openai/gpt-4.1-mini" if action == "vision" else "openai/gpt-5-nano",
        )
        cmd = [
            "uv",
            "run",
            "eval",
            "mazebench-tools",
            "-m",
            model,
            "-n",
            pairs.get("n", "1"),
            "-r",
            pairs.get("r", "1"),
            "--env.taskset.max-actions",
            str(moves),
            "--env.agent.max-turns",
            str(max(moves + 16, moves * 4)),
            "--env.agent.harness.id",
            "null",
            "--env.agent.runtime.type",
            "prime",
            "--push",
            "false",
            "--rich",
            "false",
        ]
        if action == "vision":
            cmd.extend(
                [
                    "--env.taskset.observation-mode",
                    "vision",
                    "--env.taskset.vision-width",
                    pairs.get("width", "512"),
                    "--env.taskset.vision-height",
                    pairs.get("height", "512"),
                ]
            )
        return _run(cmd, env_dir)

    if action == "codex":
        raise CliError(RETIRED_LOCAL_AGENT_MESSAGE)

    print(
        "mazebench prime <install|eval|vision> [key=value ...]\n\n"
        "  install   prime env install mazebench\n"
        "  eval      four-tool game-agent evaluation\n"
        "  vision    four-tool evaluation with perspective images",
        file=sys.stderr,
    )
    return 0 if action == "help" else 2


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    if argv and argv[0].lower() in ("help", "-h", "--help"):
        print(USAGE)
        return 0

    words, pairs, flags = parse_args(argv)

    if not words and not pairs and not flags:
        print(USAGE)
        return 0

    try:
        command = words[0].lower() if words else ""

        if command == "lan":
            return run_lan(words[1:], pairs, flags)
        if command == "host":
            return run_host(words[1:], pairs, flags)
        if command == "kill" and words[1:] == ["host"] and not pairs and not flags:
            return run_host(["stop"], {}, [])

        root = resolve_root()

        if command in ("launch", "serve", "site", "web"):
            return run_launch(root, words[1:], pairs, flags)
        if command in ("stop", "shutdown", "kill"):
            return run_stop(root, pairs)
        if command in ("status", "ps"):
            return run_status(root)
        if command == "restart":
            return run_restart(root, words[1:], pairs, flags)
        if command in ("wizard", "setup"):
            return run_wizard(root)
        if command == "build":
            return run_build(root, pairs, flags)
        if command == "prime":
            return run_prime(root, words[1:], pairs, flags)
        if command == "replay":
            return run_replay(root, words[1:], pairs, flags)
        if command == "ascii":
            return run_ascii(root, pairs, flags)
        if command == "json":
            return run_json(root, pairs, flags)
        if command == "play":
            return run_play(root, pairs, flags)
        if command in ("codex", "claude", "kimi"):
            return run_local(root, command, pairs, flags)
        if command in ("local", "run", ""):
            model = pairs.get("model", "").lower()
            if model not in ("codex", "claude", "kimi"):
                raise CliError(
                    "Specify which local agent: model=codex, model=claude, or model=kimi "
                    "(e.g. `mazebench model=codex moves=10`)."
                )
            return run_local(root, model, pairs, flags)

        raise CliError(f"Unknown command: {command!r}. Run `mazebench help`.")
    except CliError as error:
        print(f"mazebench: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
