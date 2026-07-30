"""Fail-closed base for retired coding-agent adapters."""

from __future__ import annotations

from verifiers.v1.clients import ModelContext
from verifiers.v1.harness import Harness, HarnessConfig
from verifiers.v1.runtimes import ProgramResult, Runtime
from verifiers.v1.trace import Trace


class RetiredMazeBenchHarness(Harness[HarnessConfig]):
    """Reject coding-agent launch routes that can expose non-game capabilities."""

    def __init__(self, config: HarnessConfig) -> None:
        del config
        raise RuntimeError(
            "This MazeBench coding-agent adapter was retired; use the game agent relay."
        )

    async def launch(
        self,
        ctx: ModelContext,
        trace: Trace,
        runtime: Runtime,
        endpoint: str,
        secret: str,
        mcp_urls: dict[str, str],
    ) -> ProgramResult:
        del ctx, trace, runtime, endpoint, secret, mcp_urls
        raise RuntimeError("This MazeBench coding-agent adapter was retired.")


__all__ = ["RetiredMazeBenchHarness"]
