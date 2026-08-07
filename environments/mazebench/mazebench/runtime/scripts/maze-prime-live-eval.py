#!/usr/bin/env python3
"""Run the Verifiers v1 eval while exporting live usage and maze actions.

The stock eval runner keeps its Trace in process and writes results.jsonl only
after a rollout is finalized. MazeBench's site runs one rollout at a time, so a
small pair of hooks exposes provider usage and each resolved maze action without
changing Verifiers or the final saved eval output.
"""

from __future__ import annotations

import json
import os
import base64
import re
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from openai.types.responses.response_usage import InputTokensDetails
from prime_sandboxes import AsyncSandboxClient
from verifiers.v1.graph import PendingTurn
from verifiers.v1.dialects.responses import OpenAIResponse, ProviderUsage, ResponsesDialect


LIVE_USAGE_PATH = os.environ.get("MAZEBENCH_LIVE_USAGE_PATH", "").strip()
LIVE_ACTIONS_PATH = os.environ.get("MAZEBENCH_LIVE_ACTIONS_PATH", "").strip()
LIVE_REASONING_PATH = os.environ.get("MAZEBENCH_LIVE_REASONING_PATH", "").strip()
PRIME_HARNESS = os.environ.get("MAZEBENCH_PRIME_HARNESS", "").strip().lower()
RESUME_ACTION_COUNT = max(0, int(os.environ.get("MAZEBENCH_RESUME_ACTION_COUNT", "0") or 0))
_write_lock = threading.Lock()
_original_commit = PendingTurn.commit
_exported_action_counts: dict[str, int] = {}
_exported_agent_markers: dict[str, set[str]] = {}
_agent_marker = re.compile(r"MAZEBENCH_EVENT_V1:([A-Za-z0-9_-]+)")


def _patch_prime_creation_budget() -> None:
    """Fail a stuck warm-image allocation promptly instead of waiting minutes."""
    if getattr(AsyncSandboxClient, "_mazebench_creation_budget_patched", False):
        return
    original = AsyncSandboxClient.wait_for_creation
    configured = max(
        5,
        min(60, int(os.environ.get("MAZEBENCH_PRIME_SANDBOX_MAX_ATTEMPTS", "15") or 15)),
    )

    async def wait_for_creation(
        self,
        sandbox_id,
        max_attempts=60,
        stability_checks=1,
        image_build_timeout_seconds=3000,
    ):
        return await original(
            self,
            sandbox_id,
            max_attempts=min(max_attempts, configured),
            stability_checks=stability_checks,
            image_build_timeout_seconds=image_build_timeout_seconds,
        )

    AsyncSandboxClient.wait_for_creation = wait_for_creation
    AsyncSandboxClient._mazebench_creation_budget_patched = True


_patch_prime_creation_budget()


def _patch_prime_codex_reasoning_summary() -> None:
    """Prime Responses rejects Codex's automatic summary knob; keep the harness native."""
    if getattr(ResponsesDialect, "_mazebench_prime_codex_patched", False):
        return
    original = ResponsesDialect.apply_overrides

    def apply_overrides(self, body, model, sampling):
        patched = original(self, body, model, sampling)
        model_name = str(model).rsplit("/", 1)[-1].lower()
        # Codex CLI adds this knob for every model it drives, not only models
        # whose IDs contain "codex". Prime's Responses endpoint rejects it.
        if PRIME_HARNESS == "codex" or "codex" in model_name:
            reasoning = dict(patched.get("reasoning") or {})
            if reasoning.get("summary") == "auto":
                reasoning.pop("summary", None)
            if reasoning:
                patched["reasoning"] = reasoning
            else:
                patched.pop("reasoning", None)
        return patched

    ResponsesDialect.apply_overrides = apply_overrides
    ResponsesDialect._mazebench_prime_codex_patched = True


_patch_prime_codex_reasoning_summary()


def _patch_prime_usage_schema() -> None:
    """Accept Prime's valid cached-token detail with newer OpenAI SDK models."""
    field = InputTokensDetails.model_fields.get("cache_write_tokens")
    if field is None or not field.is_required():
        return
    field.default = 0
    InputTokensDetails.model_rebuild(force=True)
    ProviderUsage.model_rebuild(force=True)
    OpenAIResponse.model_rebuild(force=True)


_patch_prime_usage_schema()


def _append_jsonl(path: str, record: dict) -> None:
    if not path:
        return
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with _write_lock:
        with target.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, separators=(",", ":")) + "\n")
            stream.flush()


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _export_synchronized_actions(trace) -> None:
    if not LIVE_ACTIONS_PATH:
        return

    state = trace.state
    actions = state.get("maze_actions", []) if isinstance(state, dict) else getattr(state, "maze_actions", [])
    start = _exported_action_counts.get(trace.id, RESUME_ACTION_COUNT)
    for action in list(actions or [])[start:]:
        _append_jsonl(
            LIVE_ACTIONS_PATH,
            {
                "turn": action.get("turn"),
                "timestamp": action.get("timestamp") or _utc_timestamp(),
                "command_text": action.get("command") or action.get("raw_response") or "",
                "valid": action.get("valid", True),
                "error": action.get("error"),
                "status": action.get("status") or {},
            },
        )
    _exported_action_counts[trace.id] = len(actions or [])


def _export_agent_actions(pending: PendingTurn) -> None:
    """Export shell-helper events normalized by either coding-agent dialect."""
    if not LIVE_ACTIONS_PATH:
        return
    seen = _exported_agent_markers.setdefault(pending.trace.id, set())
    for message in pending.prompt:
        if getattr(message, "role", "") != "tool":
            continue
        for match in _agent_marker.finditer(_content_text(getattr(message, "content", ""))):
            encoded = match.group(1)
            if encoded in seen:
                continue
            try:
                padded = encoded + "=" * (-len(encoded) % 4)
                action = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
            except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(action, dict):
                continue
            _append_jsonl(
                LIVE_ACTIONS_PATH,
                {
                    "turn": action.get("turn"),
                    "timestamp": action.get("timestamp") or _utc_timestamp(),
                    "command_text": action.get("command_text") or "",
                    "valid": action.get("valid", True),
                    "error": action.get("error"),
                    "status": action.get("status") or {},
                },
            )
            seen.add(encoded)


def _content_text(content) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return "" if content is None else str(content)
    parts: list[str] = []
    for part in content:
        if isinstance(part, str):
            parts.append(part)
            continue
        if hasattr(part, "model_dump"):
            part = part.model_dump()
        if isinstance(part, dict):
            text = part.get("text") or part.get("content") or ""
            if text:
                parts.append(str(text))
    return "\n".join(parts)


def _reasoning_value_text(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    if hasattr(value, "model_dump"):
        value = value.model_dump()
    if isinstance(value, list):
        return [text for part in value for text in _reasoning_value_text(part)]
    if not isinstance(value, dict):
        return []
    parts: list[str] = []
    for key in ("text", "thinking", "summary", "reasoning", "reasoning_content"):
        parts.extend(_reasoning_value_text(value.get(key)))
    return parts


def _provider_state_reasoning(provider_state) -> str:
    if provider_state is None:
        return ""
    items = provider_state if isinstance(provider_state, list) else [provider_state]
    parts: list[str] = []
    for item in items:
        if hasattr(item, "model_dump"):
            item = item.model_dump()
        if not isinstance(item, dict):
            continue
        kind = str(item.get("type") or "").lower()
        explicitly_reasoning = any(
            key in item for key in ("thinking", "summary", "reasoning", "reasoning_content")
        )
        if not explicitly_reasoning and not any(marker in kind for marker in ("reasoning", "thinking")):
            continue
        if any(marker in kind for marker in ("encrypted", "redacted")):
            continue
        keys = ("summary", "content", "text", "thinking", "reasoning", "reasoning_content") if kind else (
            "summary", "thinking", "reasoning", "reasoning_content"
        )
        for key in keys:
            parts.extend(_reasoning_value_text(item.get(key)))
    return "\n".join(dict.fromkeys(part.strip() for part in parts if part.strip()))


def _response_reasoning(response) -> str:
    message = getattr(response, "message", None)
    reasoning = str(getattr(message, "reasoning_content", "") or "").strip()
    if reasoning:
        return reasoning
    reasoning = _provider_state_reasoning(getattr(message, "provider_state", None))
    if reasoning:
        return reasoning
    parts: list[str] = []
    for block in getattr(message, "thinking_blocks", None) or []:
        if hasattr(block, "model_dump"):
            block = block.model_dump()
        if isinstance(block, dict):
            text = block.get("thinking") or block.get("text") or ""
        else:
            text = getattr(block, "thinking", "") or getattr(block, "text", "")
        if text:
            parts.append(str(text))
    return "\n".join(parts).strip()


def _commit_with_live_usage(self: PendingTurn, response, *args, **kwargs) -> None:
    result = _original_commit(self, response, *args, **kwargs)
    # Telemetry must never turn a successfully committed model response into an
    # HTTP 500. Provider response schemas legitimately omit optional reasoning
    # fields, and the maze rollout must continue when that happens.
    try:
        _export_synchronized_actions(self.trace)
        _export_agent_actions(self)
        message = getattr(response, "message", None)
        reasoning = _response_reasoning(response)
        if LIVE_REASONING_PATH and reasoning:
            _append_jsonl(
                LIVE_REASONING_PATH,
                {
                    "move": RESUME_ACTION_COUNT + self.trace.num_turns,
                    "action": _content_text(getattr(message, "content", "")).strip(),
                    "reasoning": reasoning,
                    "recorded_at": time.time(),
                },
            )
        usage = getattr(response, "usage", None)
        if not LIVE_USAGE_PATH or usage is None:
            return

        record = {
            "trace_id": self.trace.id,
            "turn": RESUME_ACTION_COUNT + self.trace.num_turns,
            "prompt_tokens": int(getattr(usage, "prompt_tokens", 0) or 0),
            "cached_input_tokens": int(getattr(usage, "cached_input_tokens", 0) or 0),
            "completion_tokens": int(getattr(usage, "completion_tokens", 0) or 0),
            "reasoning_tokens": int(getattr(usage, "reasoning_tokens", 0) or 0),
            "input_tokens": int(getattr(usage, "input_tokens", 0) or 0),
            "total_tokens": int(getattr(usage, "total_tokens", 0) or 0),
            "recorded_at": time.time(),
        }
        _append_jsonl(LIVE_USAGE_PATH, record)
    except Exception as error:
        print(f"[mazebench] live telemetry skipped: {error}", file=sys.stderr)
    return result


PendingTurn.commit = _commit_with_live_usage


if __name__ == "__main__":
    from verifiers.v1.cli.eval.main import main

    main()
