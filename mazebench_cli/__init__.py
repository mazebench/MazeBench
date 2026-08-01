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
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

__version__ = "0.2.17"

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
  model four game tools; the game server runs in a separate networkless Docker
  sandbox with no host mounts.

Replay / video from a finished run or a Prime eval dir:
  mazebench replay <session-dir | session.json | results.jsonl> [video=on fast=on]

Interactive ASCII game (arrow-key controls):
  mazebench ascii [--level CxD] [--view top-diagonal]

Model-facing JSON observation (literal names by default):
  mazebench json [--level CxD] [--omniscient] [--hide-names]

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
        root = resolve_root()
        command = words[0].lower() if words else ""

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
