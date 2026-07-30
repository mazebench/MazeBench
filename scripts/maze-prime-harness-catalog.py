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
    "null": "Default MCP",
    "pi": "Pi",
    "rlm": "RLM",
    "terminus_2": "Terminus 2",
}


def adapter_for(harness_id: str, harness_type: type[vf.Harness]) -> dict[str, Any]:
    if harness_id == "claude_code":
        return {
            "adapter": "claude_mcp",
            "runtime_harness_id": "mazebench_claude_harness",
        }
    if harness_id == "codex":
        return {
            "adapter": "codex_mcp",
            "runtime_harness_id": "mazebench_codex_harness",
        }
    if harness_id == "kimi_code":
        return {
            "adapter": "kimi_mcp",
            "runtime_harness_id": "mazebench_kimi_harness",
        }
    if harness_id == "pi":
        return {
            "adapter": "cli_gateway",
            "runtime_harness_id": "mazebench_cli_harness",
            "upstream_id": harness_id,
        }
    if harness_type.SUPPORTS_MCP:
        return {"adapter": "native_mcp", "runtime_harness_id": harness_id}
    return {
        "adapter": "cli_gateway",
        "runtime_harness_id": "mazebench_cli_harness",
        "upstream_id": harness_id,
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

        schema = config_type.model_json_schema()
        properties = schema.get("properties") or {}
        configurable = sorted(set(properties) - COMMON_CONFIG_FIELDS)
        defaults = config.model_dump(exclude=COMMON_CONFIG_FIELDS)
        adapter = adapter_for(harness_id, harness_type)
        vision_harnesses = {"bash", "claude_code", "codex", "kimi_code", "null", "pi"}
        harnesses.append(
            {
                "id": harness_id,
                "label": LABELS.get(harness_id, harness_id.replace("_", " ").title()),
                "description": (harness_type.__doc__ or "").strip().splitlines()[0]
                if (harness_type.__doc__ or "").strip()
                else f"Prime-provided {harness_id.replace('_', ' ')} harness.",
                "launchable": True,
                "status": "compatible",
                "reason": "",
                "boundary": "isolated-game-gateway",
                "observation_modes": [
                    "text",
                    "json",
                    *(["vision"] if harness_id in vision_harnesses else []),
                ],
                "supports_mcp": bool(harness_type.SUPPORTS_MCP),
                "supports_message_prompt": bool(harness_type.SUPPORTS_MESSAGE_PROMPT),
                "supports_user_sim": bool(harness_type.SUPPORTS_USER_SIM),
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
            "Prime-provided harnesses execute in disposable Prime sandboxes. "
            "MazeBench state, source, checkpoints, and scoring remain behind an "
            "evaluator-owned capability URL."
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
