"""Certify the native Verifiers harness route used by MazeBench."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from mazebench.mazebench import MazeBenchConfig, MazeBenchTaskset
from mazebench_tools import (
    MazeBenchToolConfig,
    MazeBenchToolset,
    MazeBenchToolsetConfig,
    MazeBenchToolTask,
    MazeBenchToolTaskset,
)
from verifiers.v1.configs.agent import AgentConfig
from verifiers.v1.decorators import discover_decorated
from verifiers.v1.envs.single_agent import SingleAgentEnv, SingleAgentEnvConfig
from verifiers.v1.harness import HarnessConfig
from verifiers.v1.runtimes import PrimeConfig

ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "environments" / "mazebench" / "prime-harness-catalog.json"


def certify() -> dict:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    launchable = [entry for entry in catalog["harnesses"] if entry["launchable"]]
    assert len(launchable) == 1
    entry = launchable[0]
    assert entry["id"] == "null"
    assert entry["adapter"] == "native"
    assert entry["runtime_harness_id"] == "null"
    assert entry["default_config"] == {}

    try:
        MazeBenchTaskset(MazeBenchConfig(num_examples=1))
    except RuntimeError as error:
        assert "direct MazeBench taskset is retired" in str(error)
    else:
        raise AssertionError("the direct in-process game taskset was accepted")

    taskset = MazeBenchToolTaskset(MazeBenchToolConfig(num_examples=1, max_actions=1))
    assert MazeBenchToolTask.NEEDS_CONTAINER is True
    assert taskset.config.tools.colocated is False
    assert taskset.config.tools.url is None

    environment = SingleAgentEnv(
        SingleAgentEnvConfig(
            taskset=MazeBenchToolConfig(num_examples=1, max_actions=1),
            agent=AgentConfig(
                harness=HarnessConfig(id="null"),
                runtime=PrimeConfig(image="python:3.13-slim"),
            ),
        )
    )
    harness = environment._harnesses["agent"]
    assert harness.config.id == "null"
    assert harness.SUPPORTS_MCP is True

    toolset = MazeBenchToolset(MazeBenchToolsetConfig())
    controls = {fn.__name__ for fn in discover_decorated(toolset, "tool")}
    assert controls == {"start", "observe", "action", "action_sequence"}

    return {
        "schema_version": 1,
        "catalog_fingerprint": catalog["catalog_fingerprint"],
        "verifiers_version": catalog["verifiers_version"],
        "verifiers_revision": catalog["verifiers_revision"],
        "boundary": {
            "model_runtime": "framework-harness-sandbox",
            "game_runtime": "prime-tool-server-sandbox",
            "allowed_controls": sorted(f"game_{name}" for name in controls),
            "forbidden_capabilities": [
                "host-filesystem",
                "host-shell",
                "repository",
            ],
        },
        "harnesses": [
            {
                "id": "null",
                "adapter": "native",
                "runtime_harness_id": "null",
                "checks": [
                    "framework-owned-harness",
                    "isolated-harness-runtime",
                    "four-game-tools-only",
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
        print("MazeBench native harness certification ready: 1 harness")
    elif not args.write:
        print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
