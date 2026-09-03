"""Gymnasium-free wrapper around scripts/maze-bridge.js."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import subprocess
import threading
from typing import Any

from .encode import AUX_DIM, GRID_H, GRID_W, encode_ascii, encode_aux


ACTIONS: tuple[tuple[str, str | None], ...] = (
    ("move", "up"),
    ("move", "down"),
    ("move", "left"),
    ("move", "right"),
    ("rotate_camera", "up"),
    ("rotate_camera", "down"),
    ("rotate_camera", "left"),
    ("rotate_camera", "right"),
    ("undo", None),
    ("reset_level", None),
)
N_ACTIONS = len(ACTIONS)
DEAD_ACTIONS = {8, 9}


@dataclass(frozen=True)
class RewardWeights:
    gems: float = 1.0
    rooms: float = 0.1
    pushes: float = 0.05
    novelty: float = 0.01
    death: float = -0.05


def repo_root_from(start: Path | None = None) -> Path:
    current = (start or Path(__file__).resolve()).parent
    for candidate in [current, *current.parents]:
        if (candidate / "package.json").is_file() and (candidate / "scripts" / "maze-bridge.js").is_file():
            return candidate
    raise FileNotFoundError("Could not locate MazeBench repo root")


def action_command(action: int) -> dict[str, Any]:
    if action < 0 or action >= N_ACTIONS:
        raise ValueError(f"action {action} is out of range")
    command, direction = ACTIONS[action]
    payload: dict[str, Any] = {"command": command}
    if direction is not None:
        payload["direction"] = direction
    return payload


def action_mask_from(snapshot: dict[str, Any]) -> list[bool]:
    if snapshot.get("player_dead"):
        return [index in DEAD_ACTIONS for index in range(N_ACTIONS)]
    return [True] * N_ACTIONS


def step_reward(
    prev: dict[str, Any],
    curr: dict[str, Any],
    seen_hashes: set[str],
    weights: RewardWeights,
) -> tuple[float, dict[str, float]]:
    d_gem = max(0, int(curr.get("gem_count") or 0) - int(prev.get("gem_count") or 0))
    d_room = max(
        0,
        len(curr.get("visited_levels") or []) - len(prev.get("visited_levels") or []),
    )
    d_push = max(
        0,
        int(curr.get("novel_push_count") or 0) - int(prev.get("novel_push_count") or 0),
    )
    state_hash = str(curr.get("board_state_hash") or "")
    novel = 0.0
    camera = str(curr.get("action") or "").startswith("rotate_camera")
    if state_hash and state_hash not in seen_hashes:
        seen_hashes.add(state_hash)
        if not camera:
            novel = 1.0
    death = 0.0
    if curr.get("player_dead") and not prev.get("player_dead"):
        death = 1.0
    reward = (
        weights.gems * d_gem
        + weights.rooms * d_room
        + weights.pushes * d_push
        + weights.novelty * novel
        + weights.death * death
    )
    return reward, {
        "gems": float(d_gem),
        "rooms": float(d_room),
        "pushes": float(d_push),
        "novel": novel,
        "death": death,
    }


class MazeBridgeWorker:
    def __init__(
        self,
        repo_root: Path,
        *,
        level_id: str = "level_HxI",
        view: str = "top-diagonal",
        node_bin: str = "node",
    ) -> None:
        self.repo_root = repo_root
        self.level_id = level_id
        self.view = view
        self.node_bin = node_bin
        self.proc: subprocess.Popen[bytes] | None = None
        self._stderr_chunks: list[bytes] = []
        self._stderr_thread: threading.Thread | None = None
        self.start()

    def start(self) -> None:
        self.close()
        script = self.repo_root / "scripts" / "maze-bridge.js"
        self.proc = subprocess.Popen(
            [
                self.node_bin,
                str(script),
                "--level",
                self.level_id,
                "--view",
                self.view,
                "--observation-mode",
                "text",
            ],
            cwd=str(self.repo_root),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        assert self.proc.stderr is not None
        self._stderr_chunks = []
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _drain_stderr(self) -> None:
        assert self.proc is not None and self.proc.stderr is not None
        while True:
            chunk = self.proc.stderr.readline()
            if not chunk:
                break
            self._stderr_chunks.append(chunk)
            if len(self._stderr_chunks) > 40:
                self._stderr_chunks.pop(0)

    def close(self) -> None:
        proc = self.proc
        self.proc = None
        if proc is None:
            return
        try:
            if proc.stdin:
                proc.stdin.write(b'{"command":"close"}\n')
                proc.stdin.flush()
                proc.stdin.close()
        except Exception:
            pass
        try:
            if proc.stdout:
                proc.stdout.close()
        except Exception:
            pass
        try:
            proc.kill()
        except Exception:
            pass
        try:
            proc.wait(timeout=3)
        except Exception:
            pass
        try:
            if proc.stderr:
                proc.stderr.close()
        except Exception:
            pass

    def _ensure(self) -> subprocess.Popen[bytes]:
        if self.proc is None or self.proc.poll() is not None:
            raise RuntimeError(
                "maze-bridge exited: "
                + b"".join(self._stderr_chunks).decode("utf-8", "replace")[-500:]
            )
        return self.proc

    def request(self, message: dict[str, Any]) -> dict[str, Any]:
        proc = self._ensure()
        assert proc.stdin is not None and proc.stdout is not None
        payload = json.dumps(message, separators=(",", ":")).encode("utf-8") + b"\n"
        proc.stdin.write(payload)
        proc.stdin.flush()
        raw = proc.stdout.readline()
        if not raw:
            raise RuntimeError(
                "maze-bridge closed stdout: "
                + b"".join(self._stderr_chunks).decode("utf-8", "replace")[-500:]
            )
        response = json.loads(raw.decode("utf-8"))
        if not response.get("ok", False):
            response.setdefault("error", "maze-bridge returned ok=false")
        return response


class MazeEnv:
    def __init__(
        self,
        repo_root: Path | None = None,
        *,
        level_id: str = "level_HxI",
        view: str = "top-diagonal",
        max_actions: int = 256,
        gem_total: int = 90,
        room_total: int = 256,
        auto_quit: bool = True,
        auto_quit_threshold: float = 10.0,
        auto_quit_window: int = 100,
        weights: RewardWeights | None = None,
        node_bin: str | None = None,
    ) -> None:
        self.repo_root = repo_root or repo_root_from()
        self.level_id = level_id if level_id.startswith("level_") else f"level_{level_id}"
        self.view = view
        self.max_actions = max_actions
        self.gem_total = gem_total
        self.room_total = room_total
        self.auto_quit = auto_quit
        self.auto_quit_threshold = auto_quit_threshold
        self.auto_quit_window = auto_quit_window
        self.weights = weights or RewardWeights()
        self.worker = MazeBridgeWorker(
            self.repo_root,
            level_id=self.level_id,
            view=self.view,
            node_bin=node_bin or os.environ.get("MAZEBENCH_NODE", "node"),
        )
        self.snapshot: dict[str, Any] = {}
        self.seen_hashes: set[str] = set()
        self.novelty_flags: list[int] = []
        self.episode_reward = 0.0
        self.info: dict[str, Any] = {}

    def close(self) -> None:
        self.worker.close()

    def _observation(self, snapshot: dict[str, Any]) -> tuple[list[list[int]], list[float], list[bool]]:
        glyphs = encode_ascii(str(snapshot.get("level") or ""))
        aux = encode_aux(
            snapshot,
            max_actions=self.max_actions,
            gem_total=self.gem_total,
            room_total=self.room_total,
        )
        return glyphs, aux, action_mask_from(snapshot)

    def reset(self) -> tuple[list[list[int]], list[float], list[bool], dict[str, Any]]:
        snapshot = self.worker.request({"command": "reset_run"})
        if not snapshot.get("ok", False):
            snapshot = self.worker.request({"command": "observe"})
        self.snapshot = snapshot
        self.seen_hashes = set()
        hash_value = str(snapshot.get("board_state_hash") or "")
        if hash_value:
            self.seen_hashes.add(hash_value)
        self.novelty_flags = []
        self.episode_reward = 0.0
        self.info = {
            "gem_count": int(snapshot.get("gem_count") or 0),
            "rooms": len(snapshot.get("visited_levels") or []),
            "novel_push_count": int(snapshot.get("novel_push_count") or 0),
            "terminated": False,
            "reason": "",
        }
        glyphs, aux, mask = self._observation(snapshot)
        return glyphs, aux, mask, dict(self.info)

    def _should_auto_quit(self) -> bool:
        if not self.auto_quit or len(self.novelty_flags) < self.auto_quit_window:
            return False
        window = self.novelty_flags[-self.auto_quit_window :]
        percentage = 100.0 * sum(window) / len(window)
        return percentage <= self.auto_quit_threshold

    def step(
        self, action: int
    ) -> tuple[list[list[int]], list[float], list[bool], float, bool, dict[str, Any]]:
        prev = self.snapshot
        command = action_command(int(action))
        snapshot = self.worker.request(command)
        if not snapshot.get("ok", False):
            snapshot = dict(prev)
            snapshot["ok"] = False
            snapshot["action"] = "invalid"
            snapshot["error"] = snapshot.get("error") or "invalid_action"
        reward, parts = step_reward(prev, snapshot, self.seen_hashes, self.weights)
        if str(snapshot.get("action") or "") != "rotate_camera":
            self.novelty_flags.append(int(parts["novel"]))
        self.snapshot = snapshot
        self.episode_reward += reward
        gem_count = int(snapshot.get("gem_count") or 0)
        rooms = len(snapshot.get("visited_levels") or [])
        actions_taken = int(snapshot.get("action_count") or 0)
        reason = ""
        done = False
        if snapshot.get("game_won"):
            done = True
            reason = "win"
        elif snapshot.get("quit") or snapshot.get("game_lost"):
            done = True
            reason = "quit"
        elif actions_taken >= self.max_actions:
            done = True
            reason = "max_actions"
        elif self._should_auto_quit():
            done = True
            reason = "auto_quit"
        self.info = {
            "gem_count": gem_count,
            "rooms": rooms,
            "novel_push_count": int(snapshot.get("novel_push_count") or 0),
            "episode_reward": self.episode_reward,
            "terminated": done,
            "reason": reason,
            "parts": parts,
            "error": snapshot.get("error"),
        }
        glyphs, aux, mask = self._observation(snapshot)
        return glyphs, aux, mask, float(reward), done, dict(self.info)


class VecMazeEnv:
    def __init__(self, n_envs: int, **kwargs: Any) -> None:
        if n_envs < 1:
            raise ValueError("n_envs must be >= 1")
        self.n_envs = n_envs
        self.envs = [MazeEnv(**kwargs) for _ in range(n_envs)]
        self.grid_h = GRID_H
        self.grid_w = GRID_W
        self.aux_dim = AUX_DIM
        self.n_actions = N_ACTIONS

    def close(self) -> None:
        for env in self.envs:
            env.close()

    def reset(self) -> tuple[list[list[list[int]]], list[list[float]], list[list[bool]]]:
        glyphs, aux, masks = [], [], []
        for env in self.envs:
            grid, features, mask, _info = env.reset()
            glyphs.append(grid)
            aux.append(features)
            masks.append(mask)
        return glyphs, aux, masks

    def step(
        self, actions: list[int]
    ) -> tuple[
        list[list[list[int]]],
        list[list[float]],
        list[list[bool]],
        list[float],
        list[bool],
        list[dict[str, Any]],
    ]:
        if len(actions) != self.n_envs:
            raise ValueError("actions length must match n_envs")
        glyphs, aux, masks, rewards, dones, infos = [], [], [], [], [], []
        for env, action in zip(self.envs, actions):
            grid, features, mask, reward, done, info = env.step(int(action))
            if done:
                grid, features, mask, reset_info = env.reset()
                info = {**info, "reset": reset_info}
            glyphs.append(grid)
            aux.append(features)
            masks.append(mask)
            rewards.append(reward)
            dones.append(done)
            infos.append(info)
        return glyphs, aux, masks, rewards, dones, infos
