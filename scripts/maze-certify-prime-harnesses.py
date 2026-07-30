#!/usr/bin/env python3
"""Certify every harness route generated from the pinned Verifiers package."""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import verifiers.v1 as vf
from verifiers.v1.loaders import harness_class, harness_config_type
from verifiers.v1.runtimes import ProgramResult

from mazebench_harnesses.cli import MazeBenchCLIHarness, MazeBenchCLIHarnessConfig
from mazebench_harnesses.claude import MazeBenchClaudeCodeHarness
from mazebench_harnesses.common import cli_source
from mazebench_harnesses.codex import MazeBenchCodexHarness
from mazebench_harnesses.kimi import MazeBenchKimiCodeHarness
from mazebench_tools import MazeBenchToolConfig, MazeBenchToolTaskset


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "environments" / "mazebench" / "prime-harness-catalog.json"
RUNTIME = {
    "type": "prime",
    "image": "node:24-bookworm-slim",
    "workdir": "/app",
    "cpu": 2,
    "memory": 4,
    "disk": 8,
}


class RecordingRuntime:
    type = "prime"

    def __init__(self) -> None:
        self.argv: list[str] = []
        self.env: dict[str, str] = {}
        self.writes: dict[str, bytes] = {}

    async def write(self, path: str, data: bytes) -> None:
        self.writes[path] = data

    async def run(self, argv: list[str], env: dict[str, str]) -> ProgramResult:
        del argv, env
        return ProgramResult(0, "", "")

    async def run_program(self, argv: list[str], env: dict[str, str]) -> ProgramResult:
        self.argv = list(argv)
        self.env = dict(env)
        return ProgramResult(0, "", "")


def certify_cli_protocol() -> None:
    calls: list[tuple[str, str, str]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - stdlib callback name
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            calls.append(
                (
                    self.path,
                    str(body.get("method") or ""),
                    str(self.headers.get("mcp-session-id") or ""),
                )
            )
            if self.path != "/mcp/capability-token":
                self.send_error(404)
                return
            if body.get("method") == "notifications/initialized":
                self.send_response(202)
                self.end_headers()
                return
            if body.get("method") == "initialize":
                result = {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "certification", "version": "1"},
                }
            elif body.get("method") == "tools/call":
                assert self.headers.get("mcp-session-id") == "certified-session"
                assert body.get("params", {}).get("name") == "start"
                result = {
                    "content": [{"type": "text", "text": '{"ok":true}'}],
                    "structuredContent": {
                        "result": {
                            "observation": {
                                "observation_mode": "json",
                                "json_observation": {
                                    "objects": {"player": [[1, 2, 0]]}
                                },
                            },
                            "actions_used": 0,
                        }
                    },
                }
            else:
                self.send_error(400)
                return
            encoded = json.dumps(
                {"jsonrpc": "2.0", "id": body.get("id"), "result": result}
            ).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            self.send_header("mcp-session-id", "certified-session")
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, format: str, *args) -> None:
            del format, args

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/mcp/capability-token"
        with tempfile.TemporaryDirectory(prefix="mazebench-cli-cert-") as directory:
            helper = Path(directory) / "mazebench-game.js"
            helper.write_bytes(cli_source(url))
            result = subprocess.run(
                ["node", str(helper), "start"],
                text=True,
                capture_output=True,
                timeout=15,
                cwd=directory,
            )
            assert result.returncode == 0, result.stderr
            assert json.loads(result.stdout)["result"]["actions_used"] == 0
            current = json.loads(
                (Path(directory) / "observations" / "current.json").read_text()
            )
            assert current["observation_revision"] == 0
            assert current["json_observation"]["objects"]["player"] == [[1, 2, 0]]
            history = (Path(directory) / "observations" / "history.jsonl").read_text()
            assert len(history.splitlines()) == 1
        assert [method for _, method, _ in calls] == [
            "initialize",
            "notifications/initialized",
            "tools/call",
        ]
        assert all(path == "/mcp/capability-token" for path, _, _ in calls)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def effective_harness(entry: dict) -> vf.Harness:
    route = entry["adapter"]
    if route == "native_mcp":
        config = harness_config_type(entry["id"]).model_validate(
            {"id": entry["id"], "runtime": RUNTIME, **entry["default_config"]}
        )
        return harness_class(entry["id"])(config)
    if route == "claude_mcp":
        config = harness_config_type(entry["runtime_harness_id"]).model_validate(
            {
                "id": entry["runtime_harness_id"],
                "runtime": RUNTIME,
                **entry["default_config"],
            }
        )
        return MazeBenchClaudeCodeHarness(config)
    if route == "codex_mcp":
        config = harness_config_type(entry["runtime_harness_id"]).model_validate(
            {
                "id": entry["runtime_harness_id"],
                "runtime": RUNTIME,
                **entry["default_config"],
            }
        )
        return MazeBenchCodexHarness(config)
    if route == "kimi_mcp":
        config = harness_config_type(entry["runtime_harness_id"]).model_validate(
            {
                "id": entry["runtime_harness_id"],
                "runtime": RUNTIME,
                **entry["default_config"],
            }
        )
        return MazeBenchKimiCodeHarness(config)
    if route == "cli_gateway":
        config = MazeBenchCLIHarnessConfig.model_validate(
            {
                "id": entry["runtime_harness_id"],
                "runtime": RUNTIME,
                "upstream_id": entry.get("upstream_id") or entry["id"],
                "upstream_config_json": json.dumps(entry["default_config"]),
            }
        )
        wrapper = MazeBenchCLIHarness(config)
        delegate = wrapper._load_delegate()
        assert isinstance(delegate, harness_class(entry["id"]))
        return wrapper
    raise AssertionError(f"unknown adapter route {route!r}")


async def certify() -> dict:
    certify_cli_protocol()
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    task = MazeBenchToolTaskset(
        MazeBenchToolConfig(num_examples=1, max_actions=1)
    ).load()[0]
    serialized = task.data.model_dump_json()
    assert task.user is None
    assert len(task.tool_servers()) == 1
    assert task.data.repo_root == ""
    assert task.data.resume_checkpoint_path == ""
    assert task.data.observation == ""
    assert str(ROOT) not in serialized

    results: list[dict] = []
    for entry in catalog["harnesses"]:
        harness = effective_harness(entry)
        assert harness.SUPPORTS_MCP is True
        results.append(
            {
                "id": entry["id"],
                "adapter": entry["adapter"],
                "runtime_harness_id": entry["runtime_harness_id"],
                "checks": [
                    "upstream-load",
                    "effective-mcp-pairing",
                    "external-task-boundary",
                    "config-validation",
                    *(
                        ["capability-cli-protocol"]
                        if entry["adapter"] == "cli_gateway"
                        else []
                    ),
                    *(["codex-mcp-argv"] if entry["adapter"] == "codex_mcp" else []),
                    *(
                        ["claude-mcp-argv"]
                        if entry["adapter"] == "claude_mcp"
                        else []
                    ),
                    *(
                        ["kimi-image-capability"]
                        if entry["adapter"] == "kimi_mcp"
                        else []
                    ),
                ],
                "status": "certified",
            }
        )
    next(result for result in results if result["id"] == "codex")["checks"].append(
        "isolated-python-tool"
    )

    codex = effective_harness(
        next(h for h in catalog["harnesses"] if h["id"] == "codex")
    )
    runtime = RecordingRuntime()
    trace = vf.Trace(task=vf.TraceTask(type="MazeBenchToolTask", data=task.data))

    claude_entry = next(
        h for h in catalog["harnesses"] if h["id"] == "claude_code"
    )
    claude = effective_harness(claude_entry)
    claude_runtime = RecordingRuntime()
    await claude.launch(
        SimpleNamespace(
            model="zai-org/GLM-5.2",
            client=SimpleNamespace(base_url="https://api.pinference.ai/api/v1"),
        ),
        trace,
        claude_runtime,
        "https://interception.invalid/v1",
        "test-secret",
        {"mazebench": "https://capability.invalid/mcp/token"},
    )
    assert claude_runtime.argv[claude_runtime.argv.index("--tools") + 1] == "default"
    assert (
        claude_runtime.argv[claude_runtime.argv.index("--allowedTools") + 1]
        == "mcp__mazebench__*"
    )
    assert "--permission-mode" in claude_runtime.argv
    assert "--disable-slash-commands" in claude_runtime.argv
    assert "--strict-mcp-config" in claude_runtime.argv
    assert "--disallowedTools" in claude_runtime.argv
    denied_tools = set(
        claude_runtime.argv[
            claude_runtime.argv.index("--disallowedTools") + 1
        ].split(",")
    )
    assert {"Bash", "Read", "WebFetch", "WebSearch", "ToolSearch"} <= denied_tools
    assert claude_runtime.env["ENABLE_TOOL_SEARCH"] == "false"
    assert claude_runtime.env["MCP_CONNECTION_NONBLOCKING"] == "false"
    assert claude_runtime.env["MCP_TIMEOUT"] == "30000"
    claude_mcp = json.loads(
        next(
            data.decode()
            for path, data in claude_runtime.writes.items()
            if path.endswith("/mcp.json")
        )
    )
    assert claude_mcp == {
        "mcpServers": {
            "mazebench": {
                "type": "http",
                "url": "https://capability.invalid/mcp/token",
                "alwaysLoad": True,
            }
        }
    }
    assert str(ROOT) not in "\n".join(claude_runtime.argv)

    with patch(
        "mazebench_harnesses.codex._python_tools_enabled", return_value=False
    ):
        await codex.launch(
            SimpleNamespace(model="openai/gpt-5"),
            trace,
            runtime,
            "https://interception.invalid/v1",
            "test-secret",
            {"mazebench": "https://capability.invalid/mcp/token"},
        )
    command = "\n".join(runtime.argv)
    assert "mcp_servers.mazebench.url" in command
    assert (
        'enabled_tools=["start", "observe", "action", "action_sequence"]'
        in command
    )
    assert "--ephemeral" in runtime.argv
    assert "--ignore-user-config" in runtime.argv
    assert "--ignore-rules" in runtime.argv
    assert 'web_search="disabled"' in runtime.argv
    assert "tools.web_search=false" in runtime.argv
    for feature in (
        "apps",
        "browser_use",
        "computer_use",
        "goals",
        "image_generation",
        "in_app_browser",
        "memories",
        "multi_agent",
        "plugins",
        "remote_plugin",
        "shell_tool",
        "standalone_web_search",
        "tool_search",
        "tool_suggest",
        "workspace_dependencies",
    ):
        index = runtime.argv.index(feature)
        assert index > 0 and runtime.argv[index - 1] == "--disable"
    assert any("hooks.PreToolUse" in value for value in runtime.argv)
    guard_source = next(
        data.decode()
        for path, data in runtime.writes.items()
        if path.startswith(".vf-codex-game-only-")
    )
    assert "mcp__mazebench__start" in guard_source
    assert "mcp__mazebench__observe" in guard_source
    assert "mcp__mazebench__action" in guard_source
    assert "mcp__mazebench__action_sequence" in guard_source
    assert '"tool_search"' not in guard_source
    assert "External tools are disabled" in guard_source
    model_catalog = json.loads(
        next(
            data.decode()
            for path, data in runtime.writes.items()
            if path.startswith(".vf-codex-models-")
        )
    )
    assert model_catalog["models"][0]["slug"] == "openai/gpt-5"
    assert model_catalog["models"][0]["supports_search_tool"] is False
    assert any("model_catalog_json" in value for value in runtime.argv)
    assert str(ROOT) not in command

    python_runtime = RecordingRuntime()
    with patch(
        "mazebench_harnesses.codex._python_tools_enabled", return_value=True
    ):
        await codex.launch(
            SimpleNamespace(model="openai/gpt-5"),
            trace,
            python_runtime,
            "https://interception.invalid/v1",
            "test-secret",
            {"mazebench": "https://capability.invalid/mcp/token"},
        )
    python_command = "\n".join(python_runtime.argv)
    assert (
        'enabled_tools=["start", "observe", "action", "action_sequence", '
        '"python_exec"]'
        in python_command
    )
    python_guard_source = next(
        data.decode()
        for path, data in python_runtime.writes.items()
        if path.startswith(".vf-codex-game-only-")
    )
    assert "mcp__mazebench__python_exec" in python_guard_source
    assert str(ROOT) not in python_command

    kimi_entry = next(h for h in catalog["harnesses"] if h["id"] == "kimi_code")
    kimi = effective_harness(kimi_entry)
    vision_task = task.data.model_copy(update={"observation_mode": "vision"})
    vision_trace = vf.Trace(
        task=vf.TraceTask(type="MazeBenchToolTask", data=vision_task)
    )
    kimi_runtime = RecordingRuntime()
    await kimi.launch(
        SimpleNamespace(model="moonshotai/kimi-k3"),
        vision_trace,
        kimi_runtime,
        "https://interception.invalid/v1",
        "test-secret",
        {"mazebench": "https://capability.invalid/mcp/token"},
    )
    assert kimi_runtime.env["KIMI_MODEL_CAPABILITIES"] == "tool_use,image_in"

    return {
        "schema_version": 1,
        "catalog_fingerprint": catalog["catalog_fingerprint"],
        "verifiers_version": catalog["verifiers_version"],
        "verifiers_revision": catalog["verifiers_revision"],
        "boundary": {
            "harness_runtime": "disposable-prime-sandbox",
            "game_runtime": "evaluator-owned-external-tool-server",
            "allowed_controls": ["start", "observe", "action", "action_sequence"],
            "forbidden_task_fields": [
                "repo_root",
                "resume_checkpoint_path",
                "raw_observation",
                "scorecard",
            ],
        },
        "harnesses": results,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    payload = asyncio.run(certify())
    if args.write:
        args.write.resolve().write_text(
            json.dumps(payload, indent=2) + "\n", encoding="utf-8"
        )
    if args.self_test:
        print(
            f"Prime harness certification ready: {len(payload['harnesses'])} harnesses"
        )
    elif not args.write:
        print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
