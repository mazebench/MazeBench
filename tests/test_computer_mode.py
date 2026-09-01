import json
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock

from mazebench_cli import computer


class ComputerModeTests(TestCase):
    def _environment(self, root: str) -> dict[str, str]:
        return {
            **os.environ,
            "MAZEBENCH_RECORDS_ROOT": str(Path(root) / "records"),
            "MAZEBENCH_COMPUTER_STATE_ROOT": str(Path(root) / "state"),
        }

    def test_record_layout_has_no_agent_directory(self):
        with TemporaryDirectory() as tmpdir:
            with mock.patch.dict(os.environ, self._environment(tmpdir), clear=True):
                directory = computer._prepare_record_dir("09_01_fable_5_1")

                self.assertEqual(
                    {path.name for path in directory.iterdir()},
                    {
                        "move_history",
                        "moves.txt",
                        "current_board.txt",
                        "current_state.json",
                    },
                )
                self.assertFalse((directory / "agent_1").exists())

    @mock.patch.object(computer, "_pid_alive", return_value=True)
    def test_stopped_server_state_is_not_treated_as_live(self, _pid_alive):
        with TemporaryDirectory() as tmpdir:
            with mock.patch.dict(os.environ, self._environment(tmpdir), clear=True):
                computer._write_private_json(
                    computer._state_file("run_1"),
                    {
                        "pid": 123,
                        "url": "http://127.0.0.1:7331/token/lead",
                        "stopped_at": "2026-09-01T00:00:00-0600",
                    },
                )

                self.assertIsNone(computer._live_state("run_1"))
                _pid_alive.assert_not_called()

    @mock.patch.object(computer, "_stop_server")
    @mock.patch.object(computer, "_start_server", return_value=0)
    @mock.patch.object(computer, "_call", return_value=0)
    def test_login_mode_accepts_only_action_commands(
        self, call, start_server, stop_server
    ):
        inputs = [
            "ls",
            "action up",
            "action sequence UDLR",
            "action room HxI",
            "action rotate left",
            "action quit",
        ]
        with mock.patch("builtins.input", side_effect=inputs):
            with mock.patch("builtins.print") as print_output:
                result = computer.login_mode("09_01_fable_5_1")

        self.assertEqual(result, 0)
        start_server.assert_called_once_with("09_01_fable_5_1")
        stop_server.assert_called_once_with("09_01_fable_5_1")
        self.assertEqual(
            call.call_args_list,
            [
                mock.call(
                    "09_01_fable_5_1",
                    "game_action",
                    {"action": "up"},
                    record_action="up",
                ),
                mock.call(
                    "09_01_fable_5_1",
                    "game_action",
                    {"action": "up"},
                    record_action="up",
                ),
                mock.call(
                    "09_01_fable_5_1",
                    "game_action",
                    {"action": "down"},
                    record_action="down",
                ),
                mock.call(
                    "09_01_fable_5_1",
                    "game_action",
                    {"action": "left"},
                    record_action="left",
                ),
                mock.call(
                    "09_01_fable_5_1",
                    "game_action",
                    {"action": "right"},
                    record_action="right",
                ),
                mock.call(
                    "09_01_fable_5_1",
                    "game_action",
                    {"action": "go to level H I"},
                    record_action="go to level H I",
                ),
                mock.call(
                    "09_01_fable_5_1",
                    "game_action",
                    {"action": "rotate camera left"},
                    record_action="rotate camera left",
                ),
            ],
        )
        print_output.assert_any_call(
            "computer: only `action <move>` is available", file=sys.stderr
        )

    def test_sequence_accepts_only_compact_udlr_moves(self):
        self.assertEqual(
            computer._sequence_actions(["uDlR"]),
            ["up", "down", "left", "right"],
        )
        with self.assertRaisesRegex(computer.CliError, "only U, D, L, and R"):
            computer._sequence_actions(["UDX"])
        with self.assertRaisesRegex(computer.CliError, "action sequence"):
            computer._sequence_actions(["UD", "LR"])

    def test_room_action_uses_compact_room_name(self):
        self.assertEqual(
            computer._normalize_action(["room", "HxI"]),
            "go to level H I",
        )
        self.assertEqual(
            computer._normalize_action(["room", "hxi"]),
            "go to level H I",
        )
        with self.assertRaisesRegex(computer.CliError, "action room HxI"):
            computer._normalize_action(["room", "H-I"])
        with self.assertRaisesRegex(computer.CliError, "action room HxI"):
            computer._normalize_action(["go", "to", "level", "H", "I"])
        self.assertEqual(computer._move_label("go to level H I"), "room HxI")

    @mock.patch.object(computer, "_pid_alive", return_value=True)
    @mock.patch.object(
        computer,
        "_lan_rpc",
        return_value={
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "structuredContent": {
                    "level": "WWW\nWPW\nWWW",
                    "player_dead": False,
                    "gem_count": 0,
                    "visited_levels": ["level_HxI"],
                    "current_room": "level_HxI",
                }
            },
        },
    )
    def test_game_start_writes_move_zero_without_a_moves_line(
        self, _lan_rpc, _pid_alive
    ):
        with TemporaryDirectory() as tmpdir:
            with mock.patch.dict(os.environ, self._environment(tmpdir), clear=True):
                runtime_dir = Path(tmpdir) / "runtime"
                computer._write_private_json(
                    runtime_dir / "initial-status.json",
                    {"level": "START\nBOARD"},
                )
                computer._write_private_json(
                    computer._state_file("local_test"),
                    {
                        "pid": 123,
                        "url": "http://127.0.0.1:7331/token/lead",
                        "runtime_dir": str(runtime_dir),
                    },
                )

                computer._call("local_test", "game_start", record_start=True)
                directory = Path(tmpdir) / "records" / "local_test"

                self.assertEqual(
                    (directory / "move_history" / "move_0.txt").read_text(),
                    "START\nBOARD\n",
                )
                self.assertEqual((directory / "moves.txt").read_text(), "")

                (directory / "move_history" / "move_0.txt").write_text("original\n")
                computer._call("local_test", "game_observe", record_start=True)
                self.assertEqual(
                    (directory / "move_history" / "move_0.txt").read_text(),
                    "original\n",
                )

    @mock.patch.object(computer, "_pid_alive", return_value=True)
    @mock.patch.object(
        computer,
        "_lan_rpc",
        return_value={
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "structuredContent": {
                    "observation_mode": "ascii",
                    "level": "WWW\nWPW\nWWW",
                    "player_dead": False,
                    "gem_count": 2,
                    "visited_levels": ["level_HxI"],
                    "current_room": "level_HxI",
                }
            },
        },
    )
    def test_action_writes_run_scoped_records(self, lan_rpc, _pid_alive):
        with TemporaryDirectory() as tmpdir:
            with mock.patch.dict(os.environ, self._environment(tmpdir), clear=True):
                computer._write_private_json(
                    computer._state_file("local_test"),
                    {
                        "pid": 123,
                        "url": "http://127.0.0.1:7331/token/lead",
                    },
                )

                result = computer._call(
                    "local_test",
                    "game_action",
                    {"action": "up"},
                    record_action="up",
                )

                self.assertEqual(result, 0)
                directory = Path(tmpdir) / "records" / "local_test"
                self.assertEqual((directory / "moves.txt").read_text(), "up\n")
                self.assertEqual(
                    (directory / "move_history" / "move_1_up.txt").read_text(),
                    "WWW\nWPW\nWWW\n",
                )
                self.assertEqual(
                    json.loads((directory / "current_state.json").read_text()),
                    {
                        "died": False,
                        "gems": 2,
                        "rooms_available": ["HxI"],
                    },
                )
                self.assertFalse((directory / "agent_1").exists())
                self.assertEqual(
                    lan_rpc.call_args.args[1]["params"]["name"], "game_action"
                )

    @mock.patch.object(computer, "login_mode", return_value=0)
    def test_main_exposes_only_login(self, login_mode):
        self.assertEqual(computer.main(["login", "run_1"]), 0)
        login_mode.assert_called_once_with("run_1")

        with mock.patch("builtins.print") as print_output:
            self.assertEqual(computer.main(["start", "agent"]), 1)
        print_output.assert_called_once_with(
            "computer: use `computer login <run-name>`", file=sys.stderr
        )
