"""Action-only MazeBench client for a game hosted on another Mac."""

from __future__ import annotations

import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import time

from . import (
    CliError,
    LAN_SERVICE_TYPE,
    _host_service_name,
    _lan_rpc,
    _validate_host_code,
)
from .computer import (
    _ascii_board,
    _normalize_action,
    _prepare_record_dir,
    _record_move,
    _sequence_actions,
    _tool_error,
    _update_current,
    _validate_run_name,
)


USAGE = """lan — enter a restricted remote MazeBench action mode

  lan <pairing-code> login <run-name>

Examples:
  lan 123 login fable
  (fable) action up
  (fable) action sequence UDLRDLLDLDR
  (fable) action room HxI
  (fable) action quit

The client writes only ~/records/<run-name>. It does not create
~/records/computer or save the remote endpoint on this Mac.
"""


def _command_output(command: list[str], timeout: float) -> str:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return result.stdout + result.stderr
    except subprocess.TimeoutExpired as error:
        stdout = (
            error.stdout.decode("utf-8", errors="replace")
            if isinstance(error.stdout, bytes)
            else (error.stdout or "")
        )
        stderr = (
            error.stderr.decode("utf-8", errors="replace")
            if isinstance(error.stderr, bytes)
            else (error.stderr or "")
        )
        return stdout + stderr


def _parse_service_endpoint(output: str) -> tuple[str, int] | None:
    match = re.search(
        r"can be reached at\s+([^\s:]+):([0-9]+)",
        output,
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    return match.group(1).rstrip("."), int(match.group(2))


def _parse_matching_service_names(output: str, service_name: str) -> list[str]:
    pattern = re.compile(
        rf"^{re.escape(service_name)}(?: \(([0-9]+)\))?$"
    )
    matches: dict[str, int] = {}
    marker = f"{LAN_SERVICE_TYPE}."
    for line in output.splitlines():
        if " Add " not in f" {line} " or marker not in line:
            continue
        candidate = line.split(marker, 1)[1].strip()
        match = pattern.fullmatch(candidate)
        if match:
            generation = int(match.group(1) or 1)
            if generation == 1 and match.group(1):
                continue
            matches[candidate] = generation
    return sorted(matches, key=lambda name: matches[name], reverse=True)


def _host_override() -> tuple[str, int] | None:
    value = os.environ.get("MAZEBENCH_LAN_HOST", "").strip()
    if not value:
        return None
    host, separator, port_text = value.rpartition(":")
    if not separator:
        return value, 7331
    if not host or not port_text.isdigit():
        raise CliError("MAZEBENCH_LAN_HOST must be a hostname or hostname:port")
    return host, int(port_text)


def _discover_host(code: str) -> tuple[str, int]:
    override = _host_override()
    if override:
        return override
    if not shutil.which("dns-sd"):
        raise CliError(
            "Bonjour discovery is unavailable; set MAZEBENCH_LAN_HOST=host:port"
        )
    service_name = _host_service_name(code)
    browse_command = ["dns-sd", "-B", LAN_SERVICE_TYPE, "local"]
    browse_output = _command_output(browse_command, timeout=1.0)
    candidates = _parse_matching_service_names(browse_output, service_name)
    if len(candidates) <= 1:
        # Bonjour can report the first registration just before it reports a
        # collision-renamed replacement such as "(2)". Give that replacement
        # one more discovery window so a stale host cannot win by timing.
        retry_output = _command_output(browse_command, timeout=2.0)
        retry_candidates = _parse_matching_service_names(
            retry_output, service_name
        )
        if retry_candidates:
            candidates = retry_candidates
    if service_name not in candidates:
        candidates.append(service_name)
    for candidate in candidates:
        output = _command_output(
            ["dns-sd", "-L", candidate, LAN_SERVICE_TYPE, "local"],
            timeout=2.0,
        )
        endpoint = _parse_service_endpoint(output)
        if endpoint is not None:
            return endpoint
    raise CliError(
        f"could not find {service_name}; start `mazebench host {code}` on the other Mac"
    )


def _endpoint(code: str) -> str:
    host, port = _discover_host(code)
    try:
        addresses = socket.getaddrinfo(
            host,
            port,
            family=socket.AF_INET,
            type=socket.SOCK_STREAM,
        )
    except OSError:
        addresses = []
    if addresses:
        host = str(addresses[0][4][0])
    return f"http://{host}:{port}/{code}/lead"


def _record_start(run_name: str, payload: dict) -> None:
    start_path = _prepare_record_dir(run_name) / "move_history" / "move_0.txt"
    if not start_path.exists():
        start_path.write_text(_ascii_board(payload))


def _is_transient_network_error(error: CliError) -> bool:
    message = str(error).lower()
    return any(
        phrase in message
        for phrase in (
            "no route to host",
            "network is unreachable",
            "connection refused",
            "connection reset",
            "timed out",
            "temporary failure",
        )
    )


def _rpc_with_retry(url: str, request: dict, headers: dict[str, str]) -> dict:
    delays = (0.0, 0.25, 0.75, 1.5)
    for attempt, delay in enumerate(delays):
        if delay:
            time.sleep(delay)
        try:
            return _lan_rpc(url, request, headers=headers)
        except CliError as error:
            if attempt == len(delays) - 1 or not _is_transient_network_error(error):
                raise
    raise AssertionError("unreachable")


def _call(
    url: str,
    run_name: str,
    tool_name: str,
    arguments: dict | None = None,
    *,
    record_action: str | None = None,
    record_start: bool = False,
) -> int:
    request = {
        "jsonrpc": "2.0",
        "id": time.time_ns() % 1_000_000_000,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments or {}},
    }
    payload = _rpc_with_retry(
        url,
        request,
        {"X-MazeBench-Run": run_name},
    )
    error = _tool_error(payload)
    if error:
        raise CliError(error)
    _update_current(run_name, payload)
    if record_start:
        _record_start(run_name, payload)
    if record_action is not None:
        _record_move(run_name, record_action, payload)
    return 0


def login_mode(code: str, run_name: str) -> int:
    code = _validate_host_code(code)
    run_name = _validate_run_name(run_name)
    url = _endpoint(code)
    _call(url, run_name, "game_start", record_start=True)

    while True:
        try:
            line = input(f"({run_name}) ")
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        try:
            tokens = shlex.split(line)
        except ValueError as error:
            print(f"lan: {error}", file=sys.stderr)
            continue
        if not tokens:
            continue
        if tokens[0].lower() != "action":
            print("lan: only `action <move>` is available", file=sys.stderr)
            continue
        if " ".join(tokens[1:]).strip().lower() == "quit":
            return 0
        try:
            if len(tokens) >= 2 and tokens[1].lower() == "sequence":
                for action in _sequence_actions(tokens[2:]):
                    _call(
                        url,
                        run_name,
                        "game_action",
                        {"action": action},
                        record_action=action,
                    )
                continue
            action = _normalize_action(tokens[1:])
            _call(
                url,
                run_name,
                "game_action",
                {"action": action},
                record_action=action,
            )
        except (CliError, OSError) as error:
            print(f"lan: {error}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0].lower() in ("help", "-h", "--help"):
        print(USAGE)
        return 0
    if len(argv) != 3 or argv[1].lower() != "login":
        print("lan: use `lan <pairing-code> login <run-name>`", file=sys.stderr)
        return 1
    try:
        return login_mode(argv[0], argv[2])
    except (CliError, OSError) as error:
        print(f"lan: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
