"""Retired direct Codex taskset alias."""

from __future__ import annotations

from mazebench_codex_harness import MazeBenchCodexHarness
from mazebench_tools import MazeBenchToolConfig, MazeBenchToolTaskset

RETIRED_MESSAGE = (
    "mazebench_codex is retired because its default subprocess runtime can expose "
    "repository or host files. Use scripts/maze-prime-run.js with mazebench-tools."
)


class MazeBenchCodexConfig(MazeBenchToolConfig):
    id: str = "mazebench_codex"


class MazeBenchCodexTaskset(MazeBenchToolTaskset):
    config: MazeBenchCodexConfig

    def load(self):
        raise RuntimeError(RETIRED_MESSAGE)


def load_taskset(config: MazeBenchCodexConfig) -> MazeBenchCodexTaskset:
    return MazeBenchCodexTaskset(config=config)


__all__ = [
    "MazeBenchCodexConfig",
    "MazeBenchCodexHarness",
    "MazeBenchCodexTaskset",
    "load_taskset",
]
