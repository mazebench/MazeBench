from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from games.shared import GridWorld, Sprite

MAZE_DIR = Path(__file__).resolve().parent


def clamp_maze_config_dimension(value: object, fallback: int, maximum: int = 26) -> int:
    try:
        numeric_value = int(value)
    except (TypeError, ValueError):
        return fallback

    return max(1, min(maximum, numeric_value))


def load_maze_world_config() -> tuple[int, int]:
    world_parsing_path = MAZE_DIR / "world_parsing.json"

    if not world_parsing_path.exists():
        return (26, 26)

    try:
        world_parsing = json.loads(world_parsing_path.read_text(encoding="utf8"))
    except json.JSONDecodeError:
        return (26, 26)

    rules = world_parsing.get("rules", {})
    level_size = rules.get("level_size")

    if not isinstance(level_size, list):
        return (26, 26)

    return (
        clamp_maze_config_dimension(level_size[0] if len(level_size) > 0 else None, 26),
        clamp_maze_config_dimension(level_size[1] if len(level_size) > 1 else None, 26),
    )


MAZE_LEVEL_GRID_WIDTH, MAZE_LEVEL_GRID_HEIGHT = load_maze_world_config()


def default_level_file_name() -> str:
    levels_dir = MAZE_DIR / "levels"
    world_map_path = MAZE_DIR / "world_map.json"

    if world_map_path.exists():
        try:
            world_map = json.loads(world_map_path.read_text(encoding="utf8"))
        except json.JSONDecodeError:
            world_map = {}

        levels = world_map.get("levels")
        if isinstance(levels, dict):
            for file_name, position in levels.items():
                if position == ["A", "A"] and isinstance(file_name, str) and (levels_dir / file_name).exists():
                    return file_name

            for file_name in levels:
                if isinstance(file_name, str) and (levels_dir / file_name).exists():
                    return file_name

    if levels_dir.exists():
        level_files = sorted(
            path.name for path in levels_dir.iterdir() if path.is_file() and not path.name.startswith(".")
        )
        if level_files:
            return level_files[0]

    return "level_AxA.txt"


def config_tokens(config: dict[str, Any]) -> list[str]:
    token = config.get("token")
    if isinstance(token, str) and token:
        return [token]

    tokens = config.get("tokens")
    if isinstance(tokens, list):
        return [
            entry if isinstance(entry, str) else entry.get("token")
            for entry in tokens
            if (isinstance(entry, str) and entry) or (isinstance(entry, dict) and isinstance(entry.get("token"), str))
        ]

    return []


def config_token_entry(config: dict[str, Any], token: str) -> dict[str, Any]:
    if config.get("token") == token:
        return config

    tokens = config.get("tokens")
    if isinstance(tokens, list):
        for entry in tokens:
            if entry == token:
                return {"token": token}
            if isinstance(entry, dict) and entry.get("token") == token:
                return entry

    return {"token": token}


def is_actor_object_name(object_name: str) -> bool:
    return object_name in {"player", "circle_player", "box", "gem", "floating_floor", "weightless_box"}


class MazeSprite(Sprite):
    token = "?"
    solid = False

    def __init__(self, x: int, y: int, *, image: str | None = None, name: str | None = None) -> None:
        super().__init__(
            image=image or self.token,
            x=x,
            y=y,
            name=name or self.__class__.__name__.lower(),
        )


class Wall(MazeSprite):
    token = "#"
    solid = True

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="wall")


class Floor(MazeSprite):
    token = "."

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="floor")


class Exit(MazeSprite):
    token = "e"

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="exit")


class Ice(MazeSprite):
    token = "i"

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="ice")


class Hole(MazeSprite):
    token = "+"

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="hole")


class PlayerGate(MazeSprite):
    token = "g"

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="player_gate")


class PlayerLift(MazeSprite):
    token = "l"

    def __init__(self, x: int, y: int, *, raised: bool = False) -> None:
        self.raised = raised
        super().__init__(x, y, name="player_lift")


class OrangeWall(MazeSprite):
    token = "O"

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="orange_wall")


class OrangeButton(MazeSprite):
    token = "o"

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="orange_button")


class Box(MazeSprite):
    token = "b"
    solid = True

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="box")


class Gem(MazeSprite):
    token = "G"

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="gem")


class FloatingFloor(MazeSprite):
    token = "f"
    solid = True

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="floating_floor")


class WeightlessBox(MazeSprite):
    token = "M"
    solid = True

    def __init__(self, x: int, y: int, *, group_key: str) -> None:
        self.group_key = group_key
        super().__init__(x, y, name="weightless_box")


class Player(MazeSprite):
    token = "p"

    def __init__(self, x: int, y: int, *, name: str = "player") -> None:
        self.elevation = 0
        super().__init__(x, y, name=name)

    def try_move(self, dx: int, dy: int, *, allow_push: bool = True) -> bool:
        gate_snapshot_owner = False

        if isinstance(self.world, MazeWorld) and self.world.gate_snapshot is None:
            self.world.gate_snapshot = self.world.compute_raised_player_gates()
            gate_snapshot_owner = True

        try:
            if allow_push and isinstance(self.world, MazeWorld) and self.elevation == 0:
                pushable = self.world.pushable_at(self.x + dx, self.y + dy)
                if pushable is not None:
                    snapshot = self.world.snapshot_state()
                    push_budget = self.world.contiguous_player_count(self, dx, dy)
                    if self.world.try_push_actor(pushable, dx, dy, push_budget) is None:
                        self.world.restore_state(snapshot)
                        return False

            return super().try_move(dx, dy, allow_push=allow_push)
        finally:
            if gate_snapshot_owner and isinstance(self.world, MazeWorld):
                self.world.gate_snapshot = None


class PythonPlayer(Player):
    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="python_player")

    def choose_move(self, world: "MazeWorld") -> tuple[int, int]:
        del world
        return (0, 0)


class CirclePlayer(Player):
    token = "cp"

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="circle_player")


class MazeWorld(GridWorld):
    object_classes: dict[str, type[MazeSprite]] = {
        "wall": Wall,
        "player": PythonPlayer,
        "circle_player": CirclePlayer,
        "player_gate": PlayerGate,
        "player_lift": PlayerLift,
        "orange_wall": OrangeWall,
        "orange_button": OrangeButton,
        "box": Box,
        "gem": Gem,
        "floating_floor": FloatingFloor,
        "weightless_box": WeightlessBox,
        "exit": Exit,
        "ice": Ice,
        "hole": Hole,
        "floor": Floor,
    }

    def __init__(self, parser: dict[str, Any] | None = None, raw_level: str = "") -> None:
        super().__init__(parser=parser or {}, raw_level=raw_level)
        self.tiles: dict[tuple[int, int], list[MazeSprite]] = {}
        self.gate_snapshot: set[tuple[int, int]] | None = None
        if raw_level:
            self.parse_level(raw_level)

    @classmethod
    def from_disk(cls, level_name: str | None = None) -> "MazeWorld":
        parser = json.loads((MAZE_DIR / "level_parsing.json").read_text(encoding="utf8"))
        resolved_level_name = level_name or default_level_file_name()
        level_path = MAZE_DIR / "levels" / resolved_level_name
        raw_level = level_path.read_text(encoding="utf8") if level_path.exists() else ""
        return cls(parser=parser, raw_level=raw_level)

    def register_object_class(self, name: str, object_class: type[MazeSprite]) -> None:
        self.object_classes = {**self.object_classes, name: object_class}

    def parse_level(self, raw_level: str | None = None) -> list[list[str]]:
        if raw_level is not None:
            self.raw_level = raw_level

        self.sprites.clear()
        self.tiles.clear()

        source_rows = self.load_level(self.raw_level)
        normalized_rows: list[list[str]] = []
        self.width = MAZE_LEVEL_GRID_WIDTH
        self.height = MAZE_LEVEL_GRID_HEIGHT

        for y in range(MAZE_LEVEL_GRID_HEIGHT):
            source_row = source_rows[y] if y < len(source_rows) else []
            normalized_row: list[str] = []

            for x in range(MAZE_LEVEL_GRID_WIDTH):
                has_source_cell = y < len(source_rows) and x < len(source_row)
                cell = source_row[x] if has_source_cell else Floor.token
                normalized_row.append(cell)
                cell_definitions: list[dict[str, str]] = []

                for token in self.tokens_from_cell(cell):
                    definition = self.object_definition_for_token(token)
                    if definition is None:
                        continue

                    cell_definitions.append(definition)

                has_wall = any(definition["name"] == "wall" for definition in cell_definitions)
                has_actor = any(is_actor_object_name(definition["name"]) for definition in cell_definitions)
                has_explicit_ground = any(
                    definition["name"] != "wall" and not is_actor_object_name(definition["name"])
                    for definition in cell_definitions
                )

                if (has_wall or has_actor) and not has_explicit_ground:
                    cell_definitions.append({"name": "floor", "token": Floor.token})

                for definition in cell_definitions:
                    sprite = self.build_sprite(definition["name"], x, y, token=definition["token"])
                    self.add_sprite(sprite)

            normalized_rows.append(normalized_row)

        for sprite in self.sprites:
            if isinstance(sprite, Player):
                sprite.elevation = 1 if self.player_surface_height(sprite.x, sprite.y) == 1 else 0

        return normalized_rows

    def object_definition_for_token(self, token: str) -> dict[str, str] | None:
        for object_name, config in self.parser.get("objects", {}).items():
            if token in config_tokens(config):
                entry = config_token_entry(config, token)
                return {
                    "initial_raised": bool(entry.get("initial_raised") or config.get("initial_raised")),
                    "name": object_name,
                    "token": token,
                }
        return None

    def build_sprite(self, object_name: str, x: int, y: int, *, token: str | None = None) -> MazeSprite:
        if object_name == "weightless_box":
            return WeightlessBox(x, y, group_key=token or WeightlessBox.token)

        if object_name == "player_lift":
            definition = self.object_definition_for_token(token or PlayerLift.token) or {}
            return PlayerLift(x, y, raised=bool(definition.get("initial_raised")))

        sprite_class = self.object_classes.get(object_name, MazeSprite)
        return sprite_class(x, y)

    def add_sprite(self, sprite: MazeSprite) -> MazeSprite:
        super().add_sprite(sprite)
        self.tiles.setdefault(sprite.position, []).append(sprite)
        return sprite

    def remove_sprite(self, sprite: MazeSprite) -> None:
        tile = self.tiles.get(sprite.position, [])

        if sprite in tile:
            tile.remove(sprite)

        if not tile and sprite.position in self.tiles:
            del self.tiles[sprite.position]

        super().remove_sprite(sprite)

    def tile_has_name(self, x: int, y: int, name: str) -> bool:
        return any(sprite.name == name for sprite in self.tiles.get((x, y), []))

    def tile_is_void(self, x: int, y: int) -> bool:
        return self.in_bounds(x, y) and not self.tiles.get((x, y))

    def tile_is_hole_or_void(self, x: int, y: int) -> bool:
        return self.tile_has_name(x, y, "hole") or self.tile_is_void(x, y)

    def pushable_at(self, x: int, y: int) -> Box | FloatingFloor | WeightlessBox | None:
        for sprite in self.tiles.get((x, y), []):
            if isinstance(sprite, (Box, FloatingFloor, WeightlessBox)):
                return sprite
        return None

    def player_at(self, x: int, y: int) -> Player | None:
        for sprite in self.tiles.get((x, y), []):
            if isinstance(sprite, Player):
                return sprite
        return None

    def player_lift_at(self, x: int, y: int) -> PlayerLift | None:
        for sprite in self.tiles.get((x, y), []):
            if isinstance(sprite, PlayerLift):
                return sprite
        return None

    def player_elevation(self, sprite: Sprite | None) -> int:
        if not isinstance(sprite, Player):
            return 0
        return sprite.elevation

    def is_raised_player_lift(self, x: int, y: int) -> bool:
        lift = self.player_lift_at(x, y)
        return lift.raised if lift is not None else False

    def set_player_lift_raised(self, x: int, y: int, raised: bool) -> bool:
        lift = self.player_lift_at(x, y)
        if lift is None:
            return False
        lift.raised = raised
        return lift.raised

    def are_orange_buttons_pressed(self) -> bool:
        button_positions = [
            (x, y)
            for (x, y), sprites in self.tiles.items()
            if any(sprite.name == "orange_button" for sprite in sprites)
        ]

        return bool(button_positions) and all(
            self.has_ground_mobile_actor_at(x, y)
            for x, y in button_positions
        )

    def is_raised_orange_wall(self, x: int, y: int) -> bool:
        return self.tile_has_name(x, y, "orange_wall") and not self.are_orange_buttons_pressed()

    def terrain_surface_height(self, x: int, y: int) -> int | None:
        if not self.in_bounds(x, y):
            return None

        if (
            self.tile_has_name(x, y, "wall")
            or self.is_raised_player_gate(x, y)
            or self.is_raised_player_lift(x, y)
            or self.is_raised_orange_wall(x, y)
        ):
            return 1

        if self.tile_is_hole_or_void(x, y):
            return None

        return 0

    def has_elevated_actor_surface(self, x: int, y: int) -> bool:
        return any(
            isinstance(sprite, (FloatingFloor, WeightlessBox))
            for sprite in self.tiles.get((x, y), [])
        )

    def player_surface_height(self, x: int, y: int) -> int | None:
        terrain_height = self.terrain_surface_height(x, y)

        if terrain_height == 1 or self.has_elevated_actor_surface(x, y):
            return 1

        return terrain_height

    def has_mobile_actor_at(self, x: int, y: int) -> bool:
        return any(
            isinstance(sprite, (Player, Box, FloatingFloor, WeightlessBox))
            for sprite in self.tiles.get((x, y), [])
        )

    def has_ground_mobile_actor_at(self, x: int, y: int) -> bool:
        return any(
            (
                isinstance(sprite, Player)
                and self.player_elevation(sprite) == 0
            )
            or isinstance(sprite, (Box, FloatingFloor, WeightlessBox))
            for sprite in self.tiles.get((x, y), [])
        )

    def compute_raised_player_gates(self) -> set[tuple[int, int]]:
        raised: set[tuple[int, int]] = set()
        players = [sprite for sprite in self.sprites if isinstance(sprite, Player)]

        for (x, y), sprites in self.tiles.items():
            if not any(sprite.name == "player_gate" for sprite in sprites):
                continue

            if any(player.x == x and player.y == y and self.player_elevation(player) == 1 for player in players):
                raised.add((x, y))
                continue

            if self.has_ground_mobile_actor_at(x, y):
                continue

            if (
                any(player.x == x + 1 and player.y == y for player in players)
                or any(player.x == x - 1 and player.y == y for player in players)
                or any(player.x == x and player.y == y + 1 for player in players)
                or any(player.x == x and player.y == y - 1 for player in players)
            ):
                raised.add((x, y))

        return raised

    def is_raised_player_gate(self, x: int, y: int) -> bool:
        if not self.tile_has_name(x, y, "player_gate"):
            return False

        gate_positions = self.gate_snapshot if self.gate_snapshot is not None else self.compute_raised_player_gates()
        return (x, y) in gate_positions

    def contiguous_player_count(self, player: Player, dx: int, dy: int) -> int:
        count = 1
        check_x = player.x
        check_y = player.y

        while True:
            check_x -= dx
            check_y -= dy

            occupant = self.player_at(check_x, check_y)
            if occupant is None or self.player_elevation(occupant) != self.player_elevation(player):
                break

            count += 1

        return count

    def weightless_group_members(self, group_key: str) -> list[WeightlessBox]:
        return [
            sprite
            for sprite in self.sprites
            if isinstance(sprite, WeightlessBox) and sprite.group_key == group_key
        ]

    def push_entity_key(self, sprite: Box | FloatingFloor | WeightlessBox) -> tuple[str, str | int]:
        if isinstance(sprite, WeightlessBox):
            return ("weightless", sprite.group_key)

        if isinstance(sprite, FloatingFloor):
            return ("floating_floor", id(sprite))

        return ("box", id(sprite))

    def push_weight(self, sprite: Box | FloatingFloor | WeightlessBox) -> int:
        return 1 if isinstance(sprite, (Box, FloatingFloor)) else 0

    def push_actor_members(
        self,
        sprite: Box | FloatingFloor | WeightlessBox,
    ) -> list[Box | FloatingFloor | WeightlessBox]:
        if isinstance(sprite, WeightlessBox):
            return self.weightless_group_members(sprite.group_key)

        return [sprite]

    def fill_hole_with_floor(self, x: int, y: int) -> None:
        for sprite in list(self.tiles.get((x, y), [])):
            if sprite.name == "hole":
                self.remove_sprite(sprite)

        if not self.tile_has_name(x, y, "floor"):
            self.add_sprite(Floor(x, y))

    def collect_gems_at(self, x: int, y: int) -> None:
        for sprite in list(self.tiles.get((x, y), [])):
            if sprite.name == "gem":
                self.remove_sprite(sprite)

    def snapshot_state(self) -> list[tuple[Sprite, tuple[int, int], dict[str, Any]]]:
        snapshot: list[tuple[Sprite, tuple[int, int], dict[str, Any]]] = []
        for sprite in self.sprites:
            state: dict[str, Any] = {}
            if isinstance(sprite, Player):
                state["elevation"] = sprite.elevation
            if isinstance(sprite, PlayerLift):
                state["raised"] = sprite.raised
            snapshot.append((sprite, sprite.position, state))
        return snapshot

    def restore_state(self, snapshot: list[tuple[Sprite, tuple[int, int], dict[str, Any]]]) -> None:
        self.sprites.clear()
        self.tiles.clear()

        for sprite, position, state in snapshot:
            sprite.x, sprite.y = position
            if isinstance(sprite, Player):
                sprite.elevation = state.get("elevation", 0)
            if isinstance(sprite, PlayerLift):
                sprite.raised = state.get("raised", False)
            self.add_sprite(sprite)

    def can_move_weightless_group(self, members: list[WeightlessBox], dx: int, dy: int) -> bool:
        for member in members:
            target_x = member.x + dx
            target_y = member.y + dy

            if not self.in_bounds(target_x, target_y):
                return False

            if self.is_raised_player_gate(target_x, target_y):
                return False

            if self.is_raised_player_lift(target_x, target_y):
                return False

            if self.is_raised_orange_wall(target_x, target_y):
                return False

            for occupant in self.tiles.get((target_x, target_y), []):
                if occupant in members:
                    continue
                if getattr(occupant, "solid", False):
                    return False

        return True

    def sync_sprite_tile(self, sprite: Sprite, old_position: tuple[int, int]) -> None:
        old_tile = self.tiles.get(old_position, [])
        if sprite in old_tile:
            old_tile.remove(sprite)
        if not old_tile and old_position in self.tiles:
            del self.tiles[old_position]
        self.tiles.setdefault(sprite.position, []).append(sprite)

    def try_move_weightless_group(self, group_key: str, dx: int, dy: int) -> bool:
        members = self.weightless_group_members(group_key)

        if not members:
            return False

        moved = False

        while self.can_move_weightless_group(members, dx, dy):
            old_positions = [(member, member.position) for member in members]

            for member in members:
                member.x += dx
                member.y += dy

            for member, old_position in old_positions:
                self.sync_sprite_tile(member, old_position)

            moved = True

            if all(self.tile_is_hole_or_void(member.x, member.y) for member in members):
                break

            if not all(
                self.tile_has_name(member.x, member.y, "ice")
                or self.tile_is_hole_or_void(member.x, member.y)
                for member in members
            ):
                break

        if moved and all(self.tile_is_hole_or_void(member.x, member.y) for member in members):
            for member in list(members):
                self.remove_sprite(member)

        return moved

    def try_push_actor(
        self,
        sprite: Box | FloatingFloor | WeightlessBox,
        dx: int,
        dy: int,
        budget: int,
        handled: set[tuple[str, str | int]] | None = None,
    ) -> int | None:
        if handled is None:
            handled = set()

        entity_key = self.push_entity_key(sprite)

        if entity_key in handled:
            return budget

        cost = self.push_weight(sprite)

        if budget < cost:
            return None

        remaining_budget = budget - cost
        members = self.push_actor_members(sprite)
        member_ids = {id(member) for member in members}
        blockers: list[Box | FloatingFloor | WeightlessBox] = []
        blocker_keys: set[tuple[str, str | int]] = set()

        for member in members:
            target_x = member.x + dx
            target_y = member.y + dy

            if not self.in_bounds(target_x, target_y):
                return None

            if self.is_raised_player_gate(target_x, target_y):
                return None

            if self.is_raised_player_lift(target_x, target_y):
                return None

            if self.is_raised_orange_wall(target_x, target_y):
                return None

            for occupant in self.tiles.get((target_x, target_y), []):
                if id(occupant) in member_ids:
                    continue

                if not isinstance(occupant, (Box, FloatingFloor, WeightlessBox)):
                    if getattr(occupant, "solid", False):
                        return None
                    continue

                blocker_key = self.push_entity_key(occupant)

                if blocker_key not in blocker_keys:
                    blockers.append(occupant)
                    blocker_keys.add(blocker_key)

        for blocker in blockers:
            result = self.try_push_actor(blocker, dx, dy, remaining_budget, handled)

            if result is None:
                return None

            remaining_budget = result

        moved = (
            self.try_move_weightless_group(sprite.group_key, dx, dy)
            if isinstance(sprite, WeightlessBox)
            else sprite.try_move(dx, dy, allow_push=False)
        )

        if not moved:
            return None

        handled.add(entity_key)
        return remaining_budget

    def update_sprite_position(self, sprite: Sprite, old_position: tuple[int, int]) -> None:
        self.sync_sprite_tile(sprite, old_position)

        if isinstance(sprite, WeightlessBox):
            return

        if isinstance(sprite, Player):
            lift = self.player_lift_at(sprite.x, sprite.y)
            if lift is not None and sprite.position != old_position:
                lift.raised = not lift.raised
                sprite.elevation = 1 if lift.raised else 0
            else:
                sprite.elevation = 1 if self.player_surface_height(sprite.x, sprite.y) == 1 else 0

        if self.tile_is_hole_or_void(sprite.x, sprite.y):
            if isinstance(sprite, FloatingFloor):
                self.fill_hole_with_floor(sprite.x, sprite.y)

            if not isinstance(sprite, Player) or sprite.elevation == 0:
                self.remove_sprite(sprite)
                return

        dx = sprite.x - old_position[0]
        dy = sprite.y - old_position[1]

        if (
            (dx, dy) != (0, 0)
            and self.tile_has_name(sprite.x, sprite.y, "ice")
            and not isinstance(sprite, Player)
        ):
            sprite.try_move(dx, dy, allow_push=False)
            return

        if (
            (dx, dy) != (0, 0)
            and isinstance(sprite, Player)
            and sprite.elevation == 0
            and self.tile_has_name(sprite.x, sprite.y, "ice")
        ):
            if sprite.try_move(dx, dy, allow_push=False):
                return

        if isinstance(sprite, Player) and sprite.elevation == 0:
            self.collect_gems_at(sprite.x, sprite.y)

    def can_move_to(self, x: int, y: int, sprite: Sprite | None = None) -> bool:
        if not self.in_bounds(x, y):
            return False

        if isinstance(sprite, Player):
            current_elevation = self.player_elevation(sprite)
            can_enter_hole = current_elevation == 0 and self.tile_is_hole_or_void(x, y)
            target_surface_height = (
                self.player_surface_height(x, y)
                if current_elevation == 1
                else self.terrain_surface_height(x, y)
            )
            if not can_enter_hole and target_surface_height != current_elevation:
                return False

            for occupant in self.tiles.get((x, y), []):
                if occupant is sprite or occupant.name == "gem":
                    continue

                if isinstance(occupant, Player):
                    if self.player_elevation(occupant) == current_elevation:
                        return False
                    continue

                if current_elevation == 0 and getattr(occupant, "solid", False):
                    return False

            return True

        if self.is_raised_player_gate(x, y) or self.is_raised_player_lift(x, y) or self.is_raised_orange_wall(x, y):
            return False

        for occupant in self.tiles.get((x, y), []):
            if occupant is sprite:
                continue
            if getattr(occupant, "solid", False):
                return False

        return True

    def find_player(self) -> Player | None:
        for sprite in self.sprites:
            if isinstance(sprite, Player):
                return sprite
        return None
