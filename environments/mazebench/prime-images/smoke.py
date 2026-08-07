#!/usr/bin/env python3
"""Provision one Prime image, verify commands, and always clean it up."""

from __future__ import annotations

import argparse
import time

from prime_sandboxes import CreateSandboxRequest, SandboxClient
from prime_sandboxes.core import APIClient


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("--name", default="mazebench-image-smoke")
    parser.add_argument("--region", default="auto", help="Prime region, or 'auto' for backend selection")
    parser.add_argument("--max-attempts", type=int, default=15)
    parser.add_argument("--cpu", type=float, default=1.0)
    parser.add_argument("--memory", type=float, default=2.0)
    parser.add_argument("--disk", type=float, default=5.0)
    parser.add_argument("--command", action="append", default=[])
    args = parser.parse_args()

    client = SandboxClient(APIClient())
    started_at = time.monotonic()
    sandbox = client.create(
        CreateSandboxRequest(
            name=args.name,
            docker_image=args.image,
            cpu_cores=args.cpu,
            memory_gb=args.memory,
            disk_size_gb=args.disk,
            timeout_minutes=30,
            idle_timeout_minutes=10,
            region=None if args.region == "auto" else args.region,
            guaranteed=False,
            labels=["mazebench-image-smoke"],
        )
    )
    print(f"created id={sandbox.id} after={time.monotonic() - started_at:.1f}s", flush=True)
    try:
        try:
            sandbox = client.wait_for_creation(
                sandbox.id,
                max_attempts=max(5, min(60, args.max_attempts)),
            )
        except Exception:
            latest = client.get(sandbox.id)
            print(
                f"failed id={latest.id} status={latest.status} region={latest.region} "
                f"error_type={latest.error_type!r} error_message={latest.error_message!r} "
                f"termination_reason={latest.termination_reason!r} "
                f"after={time.monotonic() - started_at:.1f}s",
                flush=True,
            )
            raise
        print(
            f"ready id={sandbox.id} status={sandbox.status} "
            f"after={time.monotonic() - started_at:.1f}s",
            flush=True,
        )
        for command in args.command:
            command_started_at = time.monotonic()
            result = client.execute_command(sandbox.id, command)
            print(
                f"command exit={result.exit_code} "
                f"after={time.monotonic() - command_started_at:.1f}s "
                f"stdout={result.stdout.strip()!r} stderr={result.stderr.strip()!r}",
                flush=True,
            )
            if result.exit_code:
                return result.exit_code
        return 0
    finally:
        client.delete(sandbox.id)
        print(f"deleted id={sandbox.id}", flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
