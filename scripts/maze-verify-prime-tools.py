#!/usr/bin/env python3
"""Smoke-test the trust boundary used by Prime-hosted custom harnesses."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import tempfile
from pathlib import Path

import verifiers.v1 as vf
from pydantic import ValidationError

from mazebench.mazebench import MazeBenchState
from mazebench_tools import (
    MazeBenchToolConfig,
    MazeBenchToolTaskset,
    MazeBenchToolTraceState,
)


FORBIDDEN_TOOL_FIELDS = {
    "board_state_hash",
    "player",
    "repo_root",
    "resume_checkpoint_path",
    "scorecard",
}


def nested_keys(value: object) -> set[str]:
    if isinstance(value, dict):
        return set(value).union(*(nested_keys(child) for child in value.values()))
    if isinstance(value, list):
        return set().union(*(nested_keys(child) for child in value))
    return set()


async def verify_boundary() -> None:
    with tempfile.TemporaryDirectory(prefix="mazebench-prime-tools-") as temporary:
        base = Path(temporary)
        live_actions_path = base / "actions.jsonl"
        previous_live_actions = os.environ.get("MAZEBENCH_LIVE_ACTIONS_PATH")
        os.environ["MAZEBENCH_LIVE_ACTIONS_PATH"] = str(live_actions_path)
        toolset = None
        try:
            config = MazeBenchToolConfig(
                num_examples=1,
                start_level_id="level_HxI",
                game_won_gem_count=100,
                max_actions=1,
            )
            taskset = MazeBenchToolTaskset(config=config)
            tasks = taskset.load()
            assert len(tasks) == 1
            task = tasks[0]

            # /task is authenticated with a token the harness itself knows.
            # Therefore no evaluator path or initial raw observation may be in it.
            serialized_task = task.data.model_dump_json()
            assert task.data.repo_root == ""
            assert task.data.resume_checkpoint_path == ""
            assert task.data.observation == ""
            assert str(Path(__file__).resolve().parents[1]) not in serialized_task
            assert task.user is None

            # /state uses the same bearer. Its schema must reject any attempted
            # evaluator-owned maze fields while the harness is alive.
            try:
                MazeBenchToolTraceState.model_validate(
                    {"maze_status": {"board_state_hash": "forged"}}
                )
            except ValidationError:
                pass
            else:
                raise AssertionError("harness-facing state accepted forged maze data")

            toolsets = task.tool_servers()
            assert len(toolsets) == 1
            toolset = toolsets[0]
            assert toolset.config.colocated is False
            await toolset.setup_task(task.data)

            opening = await toolset.start()
            assert opening["actions_used"] == 0
            assert not FORBIDDEN_TOOL_FIELDS.intersection(nested_keys(opening))

            moved = await toolset.action("right")
            assert moved["actions_used"] == 1
            assert moved["ended"] is True
            assert not FORBIDDEN_TOOL_FIELDS.intersection(nested_keys(moved))
            assert toolset._session is None

            snapshot_path = Path(taskset._snapshot_paths[int(task.data.idx)])
            snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
            assert len(snapshot["state"]["maze_actions"]) == 1
            assert live_actions_path.exists()

            # Finalization occurs after the untrusted harness is done. It must
            # replace the empty harness-facing state with the trusted snapshot.
            trace = vf.Trace(
                task=vf.TraceTask(type="MazeBenchToolTask", data=task.data),
                state=MazeBenchToolTraceState(),
            )
            await task.finalize(trace, None)
            assert isinstance(trace.state, MazeBenchState)
            assert len(trace.info["maze_actions"]) == 1
            assert trace.info["maze_status"]
        finally:
            if toolset is not None:
                toolset.close_session()
            if previous_live_actions is None:
                os.environ.pop("MAZEBENCH_LIVE_ACTIONS_PATH", None)
            else:
                os.environ["MAZEBENCH_LIVE_ACTIONS_PATH"] = previous_live_actions


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if not args.self_test:
        parser.error("use --self-test")
    asyncio.run(verify_boundary())
    print("isolated custom harness boundary ready")


if __name__ == "__main__":
    main()
