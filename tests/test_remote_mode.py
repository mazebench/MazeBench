import json
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock

import mazebench_cli
from mazebench_cli import remote


def observation(board: str) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "structuredContent": {
                "observation_mode": "ascii",
                "level": board,
                "player_dead": False,
                "gem_count": 1,
                "visited_levels": ["level_HxI", "level_AxB"],
                "current_room": "level_HxI",
            }
        },
    }


class RemoteModeTests(TestCase):
    def _environment(self, root: str) -> dict[str, str]:
        return {
            **os.environ,
            "MAZEBENCH_RECORDS_ROOT": str(Path(root) / "records"),
        }

    def test_parses_bonjour_service_endpoint(self):
        output = (
            f"{mazebench_cli._host_service_name('123')}._mazebench._tcp.local. can be reached at "
            "Other-Mac.local.:7331 (interface 14)\n"
        )
        self.assertEqual(
            remote._parse_service_endpoint(output),
            ("Other-Mac.local", 7331),
        )

    @mock.patch.object(remote, "_endpoint", return_value="http://other:7331/123/lead")
    @mock.patch.object(remote, "_lan_rpc")
    def test_remote_login_writes_only_public_records(self, lan_rpc, endpoint):
        boards = iter(["START", "UP", "DOWN", "LEFT", "ROOM"])
        lan_rpc.side_effect = lambda _url, _request: observation(next(boards))
        inputs = [
            "pwd",
            "action up",
            "action sequence DL",
            "action room HxI",
            "action quit",
        ]

        with TemporaryDirectory() as tmpdir:
            with mock.patch.dict(os.environ, self._environment(tmpdir), clear=True):
                with mock.patch("builtins.input", side_effect=inputs):
                    with mock.patch("builtins.print") as print_output:
                        result = remote.login_mode("123", "fable")

                records_root = Path(tmpdir) / "records"
                directory = records_root / "fable"
                self.assertEqual(result, 0)
                self.assertEqual(
                    {path.name for path in directory.iterdir()},
                    {
                        "move_history",
                        "moves.txt",
                        "current_board.txt",
                        "current_state.json",
                    },
                )
                self.assertFalse((records_root / "computer").exists())
                self.assertEqual(
                    (directory / "moves.txt").read_text(),
                    "up\ndown\nleft\nroom HxI\n",
                )
                self.assertEqual(
                    {
                        path.name: path.read_text()
                        for path in (directory / "move_history").iterdir()
                    },
                    {
                        "move_0.txt": "START\n",
                        "move_1_up.txt": "UP\n",
                        "move_2_down.txt": "DOWN\n",
                        "move_3_left.txt": "LEFT\n",
                        "move_4_room_hxi.txt": "ROOM\n",
                    },
                )
                self.assertEqual(
                    json.loads((directory / "current_state.json").read_text()),
                    {
                        "died": False,
                        "gems": 1,
                        "rooms_available": ["HxI", "AxB"],
                    },
                )

        endpoint.assert_called_once_with("123")
        self.assertEqual(lan_rpc.call_count, 5)
        self.assertTrue(
            all(call.args[0] == "http://other:7331/123/lead" for call in lan_rpc.call_args_list)
        )
        print_output.assert_any_call(
            "lan: only `action <move>` is available", file=sys.stderr
        )

    @mock.patch.object(remote, "login_mode", return_value=0)
    def test_main_exposes_only_code_login_run(self, login_mode):
        self.assertEqual(remote.main(["123", "login", "fable"]), 0)
        login_mode.assert_called_once_with("123", "fable")

        with mock.patch("builtins.print") as print_output:
            self.assertEqual(remote.main(["123", "status"]), 1)
        print_output.assert_called_once_with(
            "lan: use `lan <pairing-code> login <run-name>`", file=sys.stderr
        )


class HostCommandTests(TestCase):
    @mock.patch.object(mazebench_cli, "run_lan_serve", return_value=0)
    @mock.patch.object(mazebench_cli, "_read_lan_state", return_value=None)
    def test_host_starts_text_only_restricted_bridge(self, _read_state, serve):
        result = mazebench_cli.run_host(["123"], {"level": "HxI"}, [])

        self.assertEqual(result, 0)
        serve.assert_called_once_with(
            [],
            {
                "level": "HxI",
                "token": "123",
                "name": mazebench_cli._host_service_name("123"),
                "mode": "text",
                "advertise": "true",
            },
            [],
        )

    def test_host_pairing_code_is_numeric(self):
        with self.assertRaisesRegex(mazebench_cli.CliError, "3 to 12 digits"):
            mazebench_cli.run_host(["abc"], {}, [])

    def test_text_lan_environment_remains_game_only(self):
        environment = mazebench_cli._lan_server_env(
            Path("/maze"),
            Path("/run"),
            "123",
            {"mode": "text"},
            [],
        )
        self.assertEqual(environment["MAZEBENCH_RESTRICTED_MODE"], "1")
        self.assertEqual(environment["MAZEBENCH_MODE"], "text")
        self.assertEqual(environment["MAZEBENCH_AUTO_RUN_TOOLS"], "1")
