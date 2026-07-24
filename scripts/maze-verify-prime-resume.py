#!/usr/bin/env python3
"""Verify a Prime checkpoint by replaying it locally without model inference."""

from __future__ import annotations

import argparse
import asyncio
import json
import tempfile
from pathlib import Path

from mazebench.mazebench import (
    MazeBenchConfig,
    MazeBenchTaskset,
    MazeSession,
    load_prime_resume_checkpoint,
    prime_resume_prompt,
    slim_status,
)


def config_for_checkpoint(path: Path) -> MazeBenchConfig:
    checkpoint = load_prime_resume_checkpoint(str(path))
    task = checkpoint["task"]
    return MazeBenchConfig(
        num_examples=1,
        allow_quit=bool(task.get("allow_quit")),
        auto_quit=bool(task.get("auto_quit")),
        auto_quit_threshold=float(task.get("auto_quit_threshold") or 0),
        auto_quit_mode=(
            "rolling" if task.get("auto_quit_mode") == "rolling" else "cumulative"
        ),
        auto_quit_window=max(1, int(task.get("auto_quit_window") or 100)),
        start_level_id=str(task.get("level_id") or "level_HxI"),
        game_won_gem_count=100,
        observation_mode=str(task.get("observation_mode") or "ascii"),
        omniscient=bool(task.get("omniscient")),
        hide_names=bool(task.get("hide_names")),
        hide_names_seed=str(task.get("hide_names_seed") or "1"),
        target_gems=max(0, int(task.get("target_gems") or 0)),
        view=str(task.get("view") or "top-diagonal"),
        yaw=int(task.get("yaw") or 0),
        max_actions=None,
        resume_checkpoint_path=str(path),
        system_prompt=str(checkpoint.get("system_prompt") or ""),
    )


async def verify(path: Path) -> dict:
    checkpoint = load_prime_resume_checkpoint(str(path))
    taskset = MazeBenchTaskset(config=config_for_checkpoint(path))
    task = taskset.load()[0]
    user = task.user_server()
    if user is None:
        raise AssertionError("MazeBench task did not declare its user simulator")
    try:
        await user.setup_task(task.data)
        actual_hash = str((user._resume_status or {}).get("board_state_hash") or "")
        expected_hash = str(checkpoint.get("final_board_state_hash") or "")
        if actual_hash != expected_hash:
            raise AssertionError("replay reached the wrong final board hash")
        action_count = len(user._resume_actions or [])
        if action_count != int(checkpoint.get("action_count") or 0):
            raise AssertionError("replay restored the wrong number of actions")
        return {"action_count": action_count, "final_board_state_hash": actual_hash}
    finally:
        user.close_session()


def self_test() -> None:
    root = Path(__file__).resolve().parents[1]
    session = MazeSession(
        game_won_gem_count=100,
        level_id="level_HxI",
        observation_mode="ascii",
        omniscient=False,
        hide_names=False,
        hide_names_seed="1",
        node_bin="node",
        repo_root=str(root),
        timeout_seconds=20,
        view="top-diagonal",
        yaw=0,
    )
    try:
        initial = session.request("observe")
        after = session.request("move", direction="up")
    finally:
        session.close()
    with tempfile.TemporaryDirectory(prefix="mazebench-prime-resume-") as directory:
        checkpoint_path = Path(directory) / "prime-resume.json"
        checkpoint_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "source_run_id": "self-test",
                    "system_prompt": "Choose one command.",
                    "task": {
                        "allow_quit": True,
                        "auto_quit": False,
                        "auto_quit_threshold": 10,
                        "auto_quit_mode": "rolling",
                        "auto_quit_window": 100,
                        "game_id": "maze",
                        "game_won_gem_count": 100,
                        "level_id": "level_HxI",
                        "observation_mode": "ascii",
                        "omniscient": False,
                        "hide_names": False,
                        "hide_names_seed": "1",
                        "target_gems": 0,
                        "view": "top-diagonal",
                        "yaw": 0,
                    },
                    "initial_status": slim_status(initial),
                    "initial_board_state_hash": initial["board_state_hash"],
                    "final_board_state_hash": after["board_state_hash"],
                    "action_count": 1,
                    "messages": [
                        {"role": "user", "content": "opening"},
                        {"role": "assistant", "content": "up"},
                    ],
                    "actions": [
                        {
                            "turn": 1,
                            "command_text": "up",
                            "valid": True,
                            "error": None,
                            "status": slim_status(after),
                        }
                    ],
                }
            ),
            encoding="utf8",
        )
        checkpoint = load_prime_resume_checkpoint(str(checkpoint_path))
        resumed_prompt = prime_resume_prompt(checkpoint)[-1]["content"]
        assert "Previous action: move." in resumed_prompt
        assert "Direction: up." in resumed_prompt
        assert "Moved:" not in resumed_prompt
        result = asyncio.run(verify(checkpoint_path))
        assert result["action_count"] == 1


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("checkpoint", nargs="?", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        print("prime-resume-environment: deterministic replay ready")
        return
    if args.checkpoint is None:
        parser.error("checkpoint is required unless --self-test is used")
    result = asyncio.run(verify(args.checkpoint.expanduser().resolve()))
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
