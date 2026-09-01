"""Restricted multi-run HTTP supervisor for a MazeBench host Mac."""

from __future__ import annotations

import json
import os
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


RUN_HEADER = "X-MazeBench-Run"
LEGACY_RUNTIME_FILES = (
    "actions.jsonl",
    "cold-pause-capability.json",
    "initial-status.json",
    "maze-instance-events.jsonl",
    "session.json",
    "tool-activity.jsonl",
)


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def _write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(f"{json.dumps(value, indent=2)}\n")
    temporary.replace(path)


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        waited, _status = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            return False
    except ChildProcessError:
        pass
    except OSError:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _terminate(pid: int) -> None:
    if not _pid_alive(pid):
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            return
        time.sleep(0.05)
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


def _validate_run_name(value: str) -> str:
    name = str(value).strip()
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if (
        not name
        or name in (".", "..")
        or Path(name).name != name
        or any(character not in allowed for character in name)
    ):
        raise ValueError(
            "run name may contain only letters, numbers, '.', '_', and '-'"
        )
    return name


class RunSupervisor:
    def __init__(self) -> None:
        self.base_dir = Path(os.environ["MAZEBENCH_HOST_BASE_DIR"]).expanduser()
        self.repo_root = Path(os.environ["MAZEBENCH_REPO_ROOT"]).expanduser()
        self.node_bin = os.environ.get("MAZEBENCH_NODE_BIN", "node")
        self.level = os.environ.get("MAZEBENCH_LEVEL_ID", "HxI")
        self.view = os.environ.get("MAZEBENCH_VIEW", "top-diagonal")
        self.yaw = os.environ.get("MAZEBENCH_YAW", "0")
        self.moves = os.environ.get("MAZEBENCH_MOVE_BUDGET", "unlimited")
        self._lock = threading.Lock()
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def _run_dir(self, run_name: str) -> Path:
        name = _validate_run_name(run_name)
        directory = (self.base_dir / name).resolve()
        prefix = f"{self.base_dir.resolve()}{os.sep}"
        if not str(directory).startswith(prefix):
            raise ValueError("run directory escaped the host records root")
        return directory

    def _claim_legacy_runtime(self, run_dir: Path) -> None:
        if (run_dir / "session.json").exists():
            return
        legacy_files = [
            self.base_dir / name
            for name in LEGACY_RUNTIME_FILES
            if (self.base_dir / name).exists()
        ]
        if not legacy_files:
            return
        run_dir.mkdir(parents=True, exist_ok=True)
        for source in legacy_files:
            destination = run_dir / source.name
            if not destination.exists():
                source.rename(destination)

    def _server_environment(self, run_dir: Path, token: str) -> dict[str, str]:
        return {
            **os.environ,
            "MAZEBENCH_REPO_ROOT": str(self.repo_root),
            "MAZEBENCH_RUN_DIR": str(run_dir),
            "MAZEBENCH_SESSION_FILE": str(run_dir / "session.json"),
            "MAZEBENCH_MCP_HTTP_TOKEN": token,
            "MAZEBENCH_RESTRICTED_MODE": "1",
            "MAZEBENCH_MODE": "text",
            "MAZEBENCH_AUTO_RUN_TOOLS": "1",
            "MAZEBENCH_LEVEL_ID": self.level,
            "MAZEBENCH_VIEW": self.view,
            "MAZEBENCH_YAW": self.yaw,
            "MAZEBENCH_MOVE_BUDGET": self.moves,
        }

    def _wait_for_port(self, pid: int, port_file: Path) -> dict | None:
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline:
            state = _read_json(port_file)
            if state and int(state.get("pid", 0) or 0) == pid and state.get("port"):
                return state
            if not _pid_alive(pid):
                return None
            time.sleep(0.05)
        return None

    def ensure_run(self, run_name: str) -> dict:
        with self._lock:
            run_dir = self._run_dir(run_name)
            self._claim_legacy_runtime(run_dir)
            run_dir.mkdir(parents=True, exist_ok=True)
            state_path = run_dir / "server.json"
            state = _read_json(state_path) or {}
            if (
                state.get("url")
                and not state.get("stopped_at")
                and _pid_alive(int(state.get("pid", 0) or 0))
            ):
                return state

            token = secrets.token_urlsafe(18)
            port_file = run_dir / "mcp-http.json"
            port_file.unlink(missing_ok=True)
            log_path = run_dir / "server.log"
            command = [
                self.node_bin,
                str(self.repo_root / "scripts" / "maze-mcp-server.js"),
                "--http",
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--port-file",
                str(port_file),
            ]
            with open(log_path, "ab") as log:
                process = subprocess.Popen(
                    command,
                    cwd=str(self.repo_root),
                    env=self._server_environment(run_dir, token),
                    stdout=log,
                    stderr=log,
                    start_new_session=True,
                )

            bound = self._wait_for_port(process.pid, port_file)
            if not bound:
                _terminate(process.pid)
                raise RuntimeError(f"run server failed to start; see {log_path}")
            port = int(bound["port"])
            state = {
                "run": run_name,
                "pid": process.pid,
                "host": "127.0.0.1",
                "port": port,
                "url": f"http://127.0.0.1:{port}/{token}/lead",
                "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "tools": [
                    "game_start",
                    "game_observe",
                    "game_action",
                    "game_action_sequence",
                ],
            }
            _write_json(state_path, state)
            return state

    def stop_all(self) -> None:
        if not self.base_dir.is_dir():
            return
        for state_path in self.base_dir.glob("*/server.json"):
            state = _read_json(state_path) or {}
            state["stopped_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            _write_json(state_path, state)
            _terminate(int(state.get("pid", 0) or 0))


class HostServer(ThreadingHTTPServer):
    supervisor: RunSupervisor
    pairing_code: str


class HostHandler(BaseHTTPRequestHandler):
    server: HostServer

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _reply(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path != f"/{self.server.pairing_code}/lead":
            self._reply(404, b"", "text/plain")
            return
        try:
            run_name = _validate_run_name(self.headers.get(RUN_HEADER, ""))
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length < 1 or length > 4 * 1024 * 1024:
                raise ValueError("invalid request size")
            body = self.rfile.read(length)
            state = self.server.supervisor.ensure_run(run_name)
            request = urllib.request.Request(
                str(state["url"]),
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=240) as response:
                    response_body = response.read()
                    content_type = response.headers.get(
                        "Content-Type", "application/json"
                    )
                    self._reply(response.status, response_body, content_type)
            except urllib.error.HTTPError as error:
                self._reply(
                    error.code,
                    error.read(),
                    error.headers.get("Content-Type", "application/json"),
                )
        except Exception as error:
            body = json.dumps({"error": str(error)}).encode("utf-8")
            self._reply(400, body, "application/json")


def main() -> int:
    host = os.environ.get("MAZEBENCH_HOST_BIND", "0.0.0.0")
    port = int(os.environ.get("MAZEBENCH_HOST_PORT", "0"))
    port_file = Path(os.environ["MAZEBENCH_HOST_PORT_FILE"])
    pairing_code = os.environ["MAZEBENCH_MCP_HTTP_TOKEN"]
    supervisor = RunSupervisor()
    server = HostServer((host, port), HostHandler)
    server.supervisor = supervisor
    server.pairing_code = pairing_code
    bound_port = int(server.server_address[1])
    _write_json(
        port_file,
        {
            "host": host,
            "port": bound_port,
            "token": pairing_code,
            "pid": os.getpid(),
        },
    )

    def shutdown(_signum: int, _frame: object) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        supervisor.stop_all()
        server.server_close()
        port_file.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
