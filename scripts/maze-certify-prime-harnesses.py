#!/usr/bin/env python3
"""Certify MazeBench's sole game-tools-only model route."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from unittest.mock import patch

from mazebench.mazebench import MazeBenchConfig, MazeBenchTaskset
from mazebench_harnesses.claude import MazeBenchClaudeCodeHarness
from mazebench_harnesses.cli import MazeBenchCLIHarness
from mazebench_harnesses.codex import (
    GAME_TOOL_NAMES,
    MazeBenchCodexHarness,
    MazeBenchRelayHarnessConfig,
)
from mazebench_harnesses.kimi import MazeBenchKimiCodeHarness
from mazebench_tools import MazeBenchToolConfig, MazeBenchToolTaskset
from pydantic import ValidationError
from verifiers.v1.env import EnvConfig, Environment
from verifiers.v1.harness import HarnessConfig
from verifiers.v1.runtimes import SubprocessConfig

ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "environments" / "mazebench" / "prime-harness-catalog.json"


def paired_taskset() -> tuple[MazeBenchCodexHarness, MazeBenchToolTaskset]:
    taskset = MazeBenchToolTaskset(MazeBenchToolConfig(num_examples=1, max_actions=1))
    harness = MazeBenchCodexHarness(
        MazeBenchRelayHarnessConfig(
            id="mazebench_codex_harness",
            runtime=SubprocessConfig(),
        )
    )
    return harness, taskset


def certify() -> dict:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    launchable = [entry for entry in catalog["harnesses"] if entry["launchable"]]
    assert len(launchable) == 1
    entry = launchable[0]
    assert entry["id"] == "null"
    assert entry["adapter"] == "trusted_model_relay"
    assert entry["runtime_harness_id"] == "mazebench_codex_harness"
    assert entry["default_config"] == {}
    assert entry["configurable"] == []

    try:
        MazeBenchTaskset(MazeBenchConfig(num_examples=1))
    except RuntimeError as error:
        assert "direct MazeBench taskset is retired" in str(error)
    else:
        raise AssertionError("the direct in-process game taskset was accepted")

    with patch.dict(
        os.environ,
        {
            "MAZEBENCH_PRIME_HARNESS": "codex",
            "MAZEBENCH_PRIME_HARNESS_ADAPTER": "codex_mcp",
            "MAZEBENCH_PRIME_HARNESS_CATALOG": "forged",
        },
    ):
        unbound = MazeBenchToolTaskset(
            MazeBenchToolConfig(num_examples=1, max_actions=1)
        )
        try:
            unbound.load()
        except RuntimeError as error:
            assert "fixed evaluator-side model relay" in str(error)
        else:
            raise AssertionError("an unbound MazeBench tool taskset was accepted")

    for harness_id in ("bash", "null", "codex"):
        try:
            environment = Environment(
                EnvConfig(
                    taskset=MazeBenchToolConfig(num_examples=1, max_actions=1),
                    harness=HarnessConfig(id=harness_id),
                )
            )
            environment.taskset.select(1)
        except (RuntimeError, ValueError):
            pass
        else:
            raise AssertionError(f"unsafe builtin harness {harness_id!r} was accepted")

    harness, taskset = paired_taskset()
    assert harness.SUPPORTS_MCP is True
    assert type(harness.config.runtime) is SubprocessConfig
    assert taskset._bound_game_only_harness is harness
    assert taskset.config.tools.colocated is False
    assert taskset.config.tools.url is None

    try:
        MazeBenchRelayHarnessConfig.model_validate(
            {
                "id": "mazebench_codex_harness",
                "runtime": {"type": "prime"},
            }
        )
    except ValidationError:
        pass
    else:
        raise AssertionError("the trusted relay accepted an agent sandbox runtime")

    for retired in (
        MazeBenchClaudeCodeHarness,
        MazeBenchKimiCodeHarness,
        MazeBenchCLIHarness,
    ):
        try:
            retired(HarnessConfig(id="retired"))
        except RuntimeError as error:
            assert "retired" in str(error)
        else:
            raise AssertionError(f"retired adapter {retired.__name__} was accepted")

    return {
        "schema_version": 1,
        "catalog_fingerprint": catalog["catalog_fingerprint"],
        "verifiers_version": catalog["verifiers_version"],
        "verifiers_revision": catalog["verifiers_revision"],
        "boundary": {
            "model_runtime": "trusted-evaluator-relay",
            "game_runtime": "networkless-evaluator-owned-docker-tool-server",
            "allowed_controls": sorted(GAME_TOOL_NAMES),
            "forbidden_capabilities": [
                "filesystem",
                "host-shell",
                "network-tool",
                "repository",
                "subprocess",
            ],
        },
        "harnesses": [
            {
                "id": "null",
                "adapter": "trusted_model_relay",
                "runtime_harness_id": "mazebench_codex_harness",
                "checks": [
                    "exact-taskset-binding",
                    "fixed-local-relay-runtime",
                    "four-game-tools-only",
                    "retired-coding-adapters",
                    "evaluator-owned-tool-server",
                ],
                "status": "certified",
            }
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    payload = certify()
    if args.write:
        args.write.resolve().write_text(
            json.dumps(payload, indent=2) + "\n", encoding="utf-8"
        )
    if args.self_test:
        print("MazeBench game-agent certification ready: 1 harness")
    elif not args.write:
        print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
