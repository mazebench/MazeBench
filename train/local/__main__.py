"""Local AMD GPU training CLI.

  python -m train.local probe
  python -m train.local train --updates 50
  python -m train.local eval --checkpoint outputs/local-train/latest.pt
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

from .device import benchmark_matmul, probe_text, resolve_device
from .env import repo_root_from
from .train import TrainConfig, evaluate, train


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="train.local", description="Local MazeBench PPO on AMD GPU")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("probe", help="Detect the RX 9070 XT and run a GPU matmul")

    train_parser = sub.add_parser("train", help="Train a local PPO policy")
    train_parser.add_argument("--level", default="level_HxI")
    train_parser.add_argument("--view", default="top-diagonal")
    train_parser.add_argument("--envs", type=int, default=8)
    train_parser.add_argument("--num-steps", type=int, default=128)
    train_parser.add_argument("--updates", type=int, default=200)
    train_parser.add_argument("--max-actions", type=int, default=256)
    train_parser.add_argument("--novelty-bonus", type=float, default=0.01)
    train_parser.add_argument("--seed", type=int, default=1)
    train_parser.add_argument("--out-dir", default="outputs/local-train")
    train_parser.add_argument("--no-auto-quit", action="store_true")

    eval_parser = sub.add_parser("eval", help="Run greedy rollouts from a checkpoint")
    eval_parser.add_argument("--checkpoint", default="outputs/local-train/latest.pt")
    eval_parser.add_argument("--episodes", type=int, default=4)
    eval_parser.add_argument("--level", default=None)
    eval_parser.add_argument("--max-actions", type=int, default=None)
    return parser


def cmd_probe() -> int:
    info = resolve_device(require_gpu=True)
    bench = benchmark_matmul(info)
    print(probe_text(info, bench))
    if "9070" not in info.name and "Radeon" not in info.name:
        print("warning: discrete AMD GPU name was unexpected", file=sys.stderr)
    return 0


def cmd_train(args: argparse.Namespace) -> int:
    config = TrainConfig(
        level=args.level,
        view=args.view,
        n_envs=args.envs,
        num_steps=args.num_steps,
        updates=args.updates,
        max_actions=args.max_actions,
        novelty_bonus=args.novelty_bonus,
        seed=args.seed,
        out_dir=args.out_dir,
        auto_quit=not args.no_auto_quit,
    )
    result = train(config)
    print(result)
    return 0


def cmd_eval(args: argparse.Namespace) -> int:
    root = repo_root_from()
    checkpoint = Path(args.checkpoint)
    if not checkpoint.is_absolute():
        checkpoint = root / checkpoint
    result = evaluate(
        checkpoint,
        episodes=args.episodes,
        max_actions=args.max_actions,
        level=args.level,
    )
    print(result)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "probe":
            return cmd_probe()
        if args.command == "train":
            return cmd_train(args)
        if args.command == "eval":
            return cmd_eval(args)
        parser.error(f"unknown command {args.command}")
        return 2
    except Exception as error:
        print(f"train.local: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
