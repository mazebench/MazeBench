#!/usr/bin/env python3
"""Discover the harnesses shipped by the pinned Verifiers distribution."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import pkgutil
from pathlib import Path
from typing import Any

import verifiers.v1 as vf
import verifiers.v1.harnesses as builtin_harnesses
from mazebench_harnesses.codex import (
    MazeBenchCodexHarness,
    MazeBenchRelayHarnessConfig,
)
from verifiers.v1.loaders import harness_class, harness_config_type
from verifiers.v1.utils.version import verifiers_commit

COMMON_CONFIG_FIELDS = {
    "disabled_tools",
    "env",
    "forward_env",
    "id",
    "runtime",
}
LABELS = {
    "bash": "Bash",
    "claude_code": "Claude Code",
    "codex": "Codex",
    "kimi_code": "Kimi Code",
    "mini_swe_agent": "mini-swe-agent",
    "null": "Game agent",
    "pi": "Pi",
    "rlm": "RLM",
    "terminus_2": "Terminus 2",
}
GAME_TOOLS_ONLY_ROUTES = {
    "null": {
        "adapter": "trusted_model_relay",
        "runtime_harness_id": "mazebench_codex_harness",
        "default_config": {},
    }
}


def adapter_for(harness_id: str, harness_type: type[vf.Harness]) -> dict[str, Any]:
    del harness_type
    if harness_id == "null":
        return {
            "adapter": "trusted_model_relay",
            "runtime_harness_id": "mazebench_codex_harness",
        }
    return {
        "adapter": "unsupported",
        "runtime_harness_id": "",
    }


def discover() -> dict[str, Any]:
    harnesses: list[dict[str, Any]] = []
    for module in sorted(
        pkgutil.iter_modules(builtin_harnesses.__path__), key=lambda item: item.name
    ):
        harness_id = module.name
        try:
            harness_type = harness_class(harness_id)
            config_type = harness_config_type(harness_id)
            config = config_type.model_validate({"id": harness_id})
        except Exception as error:
            harnesses.append(
                {
                    "id": harness_id,
                    "label": LABELS.get(
                        harness_id, harness_id.replace("_", " ").title()
                    ),
                    "launchable": False,
                    "status": "catalog_error",
                    "reason": str(error).splitlines()[0][:500],
                }
            )
            continue

        effective_type = MazeBenchCodexHarness if harness_id == "null" else harness_type
        effective_config_type = (
            MazeBenchRelayHarnessConfig if harness_id == "null" else config_type
        )
        if harness_id == "null":
            config = effective_config_type.model_validate(
                {"id": "mazebench_codex_harness"}
            )
        schema = effective_config_type.model_json_schema()
        properties = schema.get("properties") or {}
        configurable = sorted(set(properties) - COMMON_CONFIG_FIELDS)
        defaults = config.model_dump(exclude=COMMON_CONFIG_FIELDS)
        adapter = adapter_for(harness_id, harness_type)
        approved = GAME_TOOLS_ONLY_ROUTES.get(harness_id) or {}
        game_tools_only = adapter == {
            "adapter": approved.get("adapter"),
            "runtime_harness_id": approved.get("runtime_harness_id"),
        } and defaults == approved.get("default_config")
        if game_tools_only:
            # Only the generated, certified default variant is approved. An
            # arbitrary CLI version or feature toggle is a different boundary.
            configurable = []
        harnesses.append(
            {
                "id": harness_id,
                "label": LABELS.get(harness_id, harness_id.replace("_", " ").title()),
                "description": (effective_type.__doc__ or "").strip().splitlines()[0]
                if (effective_type.__doc__ or "").strip()
                else f"Prime-provided {harness_id.replace('_', ' ')} harness.",
                "launchable": game_tools_only,
                "status": "compatible" if game_tools_only else "unsafe_agent_tools",
                "reason": ""
                if game_tools_only
                else (
                    "This harness can expose shell, filesystem, subprocess, or network "
                    "capabilities beyond MazeBench game tools."
                ),
                "boundary": "game-tools-only"
                if game_tools_only
                else "unrestricted-agent-tools",
                "observation_modes": [
                    "text",
                    "json",
                    *(["vision"] if harness_id == "null" else []),
                ],
                "supports_mcp": bool(effective_type.SUPPORTS_MCP),
                "supports_message_prompt": bool(effective_type.SUPPORTS_MESSAGE_PROMPT),
                "supports_user_sim": bool(effective_type.SUPPORTS_USER_SIM),
                "configurable": configurable,
                "default_config": defaults,
                "config_schema": {
                    "properties": {name: properties[name] for name in configurable},
                },
                **adapter,
            }
        )

    commit = verifiers_commit() or "unknown"
    version = importlib.metadata.version("verifiers")
    payload: dict[str, Any] = {
        "schema_version": 1,
        "source": "pinned-prime-verifiers",
        "verifiers_version": version,
        "verifiers_revision": commit,
        "policy": (
            "Only the fixed evaluator-side model relay is launchable. It advertises the "
            "four MazeBench game tools and no shell, filesystem, subprocess, or network "
            "tools. Game state and scoring remain inside the evaluator-owned sandbox."
        ),
        "harnesses": harnesses,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    payload["catalog_fingerprint"] = hashlib.sha256(encoded).hexdigest()
    return payload


def write_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    output = parser.add_mutually_exclusive_group()
    output.add_argument("--write", type=Path)
    output.add_argument(
        "--check",
        type=Path,
        help="fail if the committed catalog differs from current discovery",
    )
    args = parser.parse_args()
    payload = discover()
    if args.write:
        write_atomic(args.write.resolve(), payload)
    elif args.check:
        target = args.check.resolve()
        current = json.loads(target.read_text(encoding="utf-8"))
        if current != payload:
            raise SystemExit(
                f"Prime harness catalog is stale; run {Path(__file__).name} --write {target}"
            )
        print(
            f"Prime harness catalog ready: {len(payload['harnesses'])} harnesses, "
            f"Verifiers {payload['verifiers_revision']}"
        )
    else:
        print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
