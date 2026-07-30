"""Fail-closed tombstone for the retired colocated agent taskset."""

from __future__ import annotations

import verifiers.v1 as vf

UNSAFE_HARNESS_MESSAGE = (
    "mazebench-agent is retired because it placed the game runtime and hidden state "
    "inside the evaluated agent sandbox. Use `mazebench-tools` from "
    "`environments/mazebench`; it exposes only evaluator-owned external tools."
)


class MazeBenchAgentTaskset(vf.Taskset):
    """Reject legacy launches before an evaluated-agent runtime is created."""

    def load(self) -> list[vf.Task]:
        raise RuntimeError(UNSAFE_HARNESS_MESSAGE)


__all__ = ["MazeBenchAgentTaskset"]
