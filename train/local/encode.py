"""Encode MazeBench ASCII observations into glyph grids and aux features."""

from __future__ import annotations

from typing import Any

GRID_H = 64
GRID_W = 64
VIEWS = ("top", "top-diagonal", "diagonal", "side-diagonal", "side")
EXTRA_GLYPHS = "▼▽◀◁▶▷▲△↓⇩←⇦→⇨↑⇧"

CHARSET = "".join(chr(code) for code in range(32, 127)) + EXTRA_GLYPHS
CHAR_TO_ID = {char: index + 1 for index, char in enumerate(CHARSET)}
VOCAB_SIZE = len(CHARSET) + 1  # 0 = pad / unknown
AUX_DIM = 14


def glyph_id(char: str) -> int:
    return CHAR_TO_ID.get(char, 0)


def encode_ascii(level: str, height: int = GRID_H, width: int = GRID_W) -> list[list[int]]:
    rows = str(level or "").split("\n")
    grid = [[0] * width for _ in range(height)]
    for row_index, row in enumerate(rows[:height]):
        for col_index, char in enumerate(row[:width]):
            grid[row_index][col_index] = glyph_id(char)
    return grid


def _one_hot(index: int, size: int) -> list[float]:
    vector = [0.0] * size
    if 0 <= index < size:
        vector[index] = 1.0
    return vector


def encode_aux(
    snapshot: dict[str, Any],
    *,
    max_actions: int,
    gem_total: int = 90,
    room_total: int = 256,
) -> list[float]:
    view = str(snapshot.get("current_view") or "top-diagonal")
    view_index = VIEWS.index(view) if view in VIEWS else 1
    yaw = int(snapshot.get("yaw") or 0) % 4
    gems = float(snapshot.get("gem_count") or 0) / max(gem_total, 1)
    rooms = float(len(snapshot.get("visited_levels") or [])) / max(room_total, 1)
    progress = float(snapshot.get("action_count") or 0) / max(max_actions, 1)
    pushes = min(1.0, float(snapshot.get("novel_push_count") or 0) / 50.0)
    dead = 1.0 if snapshot.get("player_dead") else 0.0
    return (
        _one_hot(view_index, len(VIEWS))
        + _one_hot(yaw, 4)
        + [dead, gems, rooms, progress, pushes]
    )
