from pathlib import Path
from unittest import TestCase, mock

from train.local.encode import AUX_DIM, GRID_H, GRID_W, VOCAB_SIZE, encode_ascii, encode_aux
from train.local.env import RewardWeights, action_command, action_mask_from, step_reward
import mazebench_cli


class EncodeTests(TestCase):
    def test_ascii_grid_is_fixed_size(self):
        grid = encode_ascii("PG\nWW")
        self.assertEqual(len(grid), GRID_H)
        self.assertEqual(len(grid[0]), GRID_W)
        self.assertGreater(grid[0][0], 0)
        self.assertGreater(grid[0][1], 0)
        self.assertEqual(grid[0][2], 0)
        self.assertGreater(grid[1][0], 0)
        self.assertLess(max(max(row) for row in grid), VOCAB_SIZE)

    def test_aux_features_are_fixed_width(self):
        aux = encode_aux(
            {
                "current_view": "side",
                "yaw": 3,
                "gem_count": 9,
                "visited_levels": ["level_HxI", "level_IxI"],
                "action_count": 128,
                "novel_push_count": 10,
                "player_dead": True,
            },
            max_actions=256,
        )
        self.assertEqual(len(aux), AUX_DIM)
        self.assertEqual(aux[4], 1.0)
        self.assertEqual(aux[8], 1.0)
        self.assertEqual(aux[9], 1.0)


class RewardTests(TestCase):
    def test_delta_rewards_match_official_weights(self):
        prev = {
            "gem_count": 0,
            "visited_levels": ["level_HxI"],
            "novel_push_count": 0,
            "board_state_hash": "aaa",
            "player_dead": False,
            "action": "move",
        }
        curr = {
            "gem_count": 1,
            "visited_levels": ["level_HxI", "level_IxI"],
            "novel_push_count": 2,
            "board_state_hash": "bbb",
            "player_dead": False,
            "action": "move",
        }
        seen = {"aaa"}
        reward, parts = step_reward(prev, curr, seen, RewardWeights())
        self.assertEqual(parts["gems"], 1.0)
        self.assertEqual(parts["rooms"], 1.0)
        self.assertEqual(parts["pushes"], 2.0)
        self.assertEqual(parts["novel"], 1.0)
        self.assertAlmostEqual(reward, 1.0 + 0.1 + 0.1 + 0.01)

    def test_camera_rotation_is_not_novel(self):
        prev = {
            "gem_count": 0,
            "visited_levels": ["level_HxI"],
            "novel_push_count": 0,
            "board_state_hash": "aaa",
            "player_dead": False,
        }
        curr = {
            "gem_count": 0,
            "visited_levels": ["level_HxI"],
            "novel_push_count": 0,
            "board_state_hash": "ccc",
            "player_dead": False,
            "action": "rotate_camera",
        }
        seen = {"aaa"}
        reward, parts = step_reward(prev, curr, seen, RewardWeights())
        self.assertEqual(parts["novel"], 0.0)
        self.assertEqual(reward, 0.0)
        self.assertIn("ccc", seen)

    def test_dead_mask_only_allows_undo_and_reset(self):
        mask = action_mask_from({"player_dead": True})
        self.assertEqual(mask, [False] * 8 + [True, True])
        self.assertEqual(action_command(0), {"command": "move", "direction": "up"})
        self.assertEqual(action_command(8), {"command": "undo"})


class BridgeEnvTests(TestCase):
    def test_reset_and_move_change_hash(self):
        from train.local.env import MazeEnv

        env = MazeEnv(max_actions=8, auto_quit=False)
        try:
            glyphs, aux, mask, info = env.reset()
            self.assertEqual(len(glyphs), GRID_H)
            self.assertEqual(len(aux), AUX_DIM)
            self.assertTrue(all(mask))
            before = env.snapshot.get("board_state_hash")
            _glyphs, _aux, _mask, reward, done, after_info = env.step(0)
            self.assertIsInstance(reward, float)
            self.assertIn(after_info["reason"], ("", "max_actions", "auto_quit", "win", "quit"))
            self.assertNotEqual(env.snapshot.get("board_state_hash"), before)
            self.assertFalse(done)
        finally:
            env.close()


class CliRoutingTests(TestCase):
    @mock.patch.object(mazebench_cli, "run_train_local", return_value=9)
    @mock.patch.object(mazebench_cli, "resolve_root", return_value=Path("/maze"))
    def test_main_routes_train_local(self, _resolve_root, run_train_local):
        result = mazebench_cli.main(["train-local", "probe"])
        self.assertEqual(result, 9)
        run_train_local.assert_called_once_with(Path("/maze"), ["probe"])
