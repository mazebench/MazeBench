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
from verifiers.v1.utils.loaders import harness_class, harness_config_type
from verifiers.v1.utils.version import verifiers_commit

COMMON_CONFIG_FIELDS = {
    "disabled_tools",
    "env",
    "forward_env",
    "id",
    "skills",
}
LABELS = {
    "bash": "Bash",
    "claude_code": "Claude Code",
    "codex": "Codex",
    "kimi_code": "Kimi Code",
    "mini_swe_agent": "mini-swe-agent",
    "mazebench_prime_agent": "Prime Agent",
    "null": "Null",
    "pi": "Pi",
    "rlm": "RLM",
    "terminus_2": "Terminus 2",
}
GAME_TOOLS_ONLY_ROUTES = {
    "codex": {
        "adapter": "native",
        "runtime_harness_id": "codex",
        "default_config": {
            "disabled_tools": ["shell_tool"],
            "version": "0.144.5",
            "multi_agent": False,
        },
    },
    "mazebench_prime_agent": {
        "adapter": "prime_agent_cli",
        "runtime_harness_id": "mazebench_prime_agent",
        "default_config": {"version": "0.7.0"},
    },
}
LOCAL_HARNESS_IDS = ("mazebench_prime_agent",)


def adapter_for(harness_id: str, harness_type: type[vf.Harness]) -> dict[str, Any]:
    del harness_type
    if harness_id in GAME_TOOLS_ONLY_ROUTES:
        return {
            "adapter": GAME_TOOLS_ONLY_ROUTES[harness_id]["adapter"],
            "runtime_harness_id": harness_id,
        }
    return {
        "adapter": "unsupported",
        "runtime_harness_id": "",
    }


def discover() -> dict[str, Any]:
    harnesses: list[dict[str, Any]] = []
    harness_types: dict[str, type[vf.Harness]] = {}
    candidates = {
        *(module.name for module in pkgutil.iter_modules(builtin_harnesses.__path__)),
        *LOCAL_HARNESS_IDS,
    }
    for harness_id in sorted(candidates):
        try:
            harness_types[harness_id] = harness_class(harness_id)
        except AttributeError as error:
            # The harness package also contains shared implementation modules such
            # as node.py; only modules exporting a harness through __all__ are plugins.
            if "defines no `__all__`" not in str(error):
                raise
    for harness_id, harness_type in harness_types.items():
        config_type = harness_config_type(harness_id)
        config = config_type.model_validate({"id": harness_id})
        schema = config_type.model_json_schema()
        properties = schema.get("properties") or {}
        configurable = sorted(set(properties) - COMMON_CONFIG_FIELDS)
        defaults = config.model_dump(exclude=COMMON_CONFIG_FIELDS)
        adapter = adapter_for(harness_id, harness_type)
        approved = GAME_TOOLS_ONLY_ROUTES.get(harness_id) or {}
        if approved:
            config_type.model_validate({"id": harness_id, **approved["default_config"]})
            defaults = approved["default_config"]
        game_tools_only = bool(approved) and adapter == {
            "adapter": approved.get("adapter"),
            "runtime_harness_id": approved.get("runtime_harness_id"),
        }
        if game_tools_only:
            # Only the generated default variant is approved. An
            # arbitrary CLI version or feature toggle is a different boundary.
            configurable = []
        harnesses.append(
            {
                "id": harness_id,
                "label": LABELS.get(harness_id, harness_id.replace("_", " ").title()),
                "description": (harness_type.__doc__ or "").strip().splitlines()[0]
                if (harness_type.__doc__ or "").strip()
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
                    *(["vision"] if harness_id == "mazebench_prime_agent" else []),
                ],
                "supports_mcp": bool(harness_type.SUPPORTS_MCP),
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
        "source": "pinned-prime-verifiers-and-mazebench-adapters",
        "verifiers_version": version,
        "verifiers_revision": commit,
        "policy": (
            "MazeBench uses pinned Verifiers harnesses plus a pinned Prime Agent adapter "
            "in isolated Prime runtimes. "
            "Each approved route pins its standard harness configuration so the model can "
            "reach the named MazeBench game controls without receiving shell, host filesystem, "
            "or repository access."
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
