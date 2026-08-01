"""Smoke-test the harness-agnostic Prime Sandbox game Toolset."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import verifiers.v1 as vf
from mazebench_tools import (
    MazeBenchToolConfig,
    MazeBenchToolsetConfig,
    MazeBenchToolTask,
    MazeBenchToolTaskset,
)
from verifiers.v1.decorators import discover_decorated

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_TOOLS = {"start", "observe", "action", "action_sequence"}


async def verify() -> None:
    config = MazeBenchToolsetConfig()
    assert config.colocated is False
    assert config.url is None
    assert isinstance(config.runtime, vf.PrimeConfig)
    assert config.runtime.region == "us"
    assert config.runtime.workdir == "/app"
    assert config.runtime.cpu == 1
    assert config.runtime.memory == 2
    assert config.runtime.disk == 5
    assert config.runtime.gpu is None

    taskset = MazeBenchToolTaskset(
        MazeBenchToolConfig(
            num_examples=1,
            start_level_id="level_HxI",
            max_actions=2,
        )
    )
    task = taskset.load()[0]
    assert isinstance(task, MazeBenchToolTask)
    assert task.NEEDS_CONTAINER is True
    assert task.data.repo_root == ""
    assert task.data.resume_checkpoint_path == ""
    assert str(ROOT) not in task.data.model_dump_json()

    await task.setup(SimpleNamespace(id="prime-sandbox-self-test"), SimpleNamespace())
    toolset = task.tool_servers()[0]
    names = {function.__name__ for function in discover_decorated(toolset, "tool")}
    assert names == EXPECTED_TOOLS

    try:
        await toolset.setup_task(task.data)
        started = await toolset.start()
        moved = await toolset.action("up")
        assert started["observation"]["observation_mode"] == "ascii"
        assert moved["actions_used"] == 1
        assert toolset.state.maze_scorecard
        assert str(ROOT) not in json.dumps(started)
    finally:
        await toolset._exit_stack.aclose()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.parse_args()
    asyncio.run(verify())
    print("MazeBench native harness boundary ready (Prime Sandbox).")


if __name__ == "__main__":
    main()
