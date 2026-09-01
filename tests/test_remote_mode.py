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

    def test_parses_newest_matching_bonjour_collision_first(self):
        name = mazebench_cli._host_service_name("123")
        output = (
            f"12:00:00 Add 3 15 local. _mazebench._tcp. {name}\n"
            f"12:00:00 Add 3 15 local. _mazebench._tcp. Unrelated\n"
            f"12:00:00 Add 2 15 local. _mazebench._tcp. {name} (2)\n"
        )
        self.assertEqual(
            remote._parse_matching_service_names(output, name),
            [f"{name} (2)", name],
        )

    @mock.patch.object(remote.shutil, "which", return_value="/usr/bin/dns-sd")
    @mock.patch.object(remote, "_command_output")
    def test_discovery_prefers_newest_bonjour_collision(self, command_output, _which):
        name = mazebench_cli._host_service_name("123")
        command_output.side_effect = [
            (
                f"12:00:00 Add 3 15 local. _mazebench._tcp. {name}\n"
                f"12:00:00 Add 2 15 local. _mazebench._tcp. {name} (2)\n"
            ),
            (
                f"{name} (2)._mazebench._tcp.local. can be reached at "
                "Zeno.local.:7332 (interface 15)\n"
            ),
        ]

        self.assertEqual(remote._discover_host("123"), ("Zeno.local", 7332))
        self.assertEqual(
            command_output.call_args_list[1].args[0],
            ["dns-sd", "-L", f"{name} (2)", "_mazebench._tcp", "local"],
        )

    @mock.patch.object(remote.shutil, "which", return_value="/usr/bin/dns-sd")
    @mock.patch.object(remote, "_command_output")
    def test_discovery_retries_when_bonjour_collision_is_delayed(
        self, command_output, _which
    ):
        name = mazebench_cli._host_service_name("123")
        command_output.side_effect = [
            f"12:00:00 Add 2 15 local. _mazebench._tcp. {name}\n",
            (
                f"12:00:01 Add 3 15 local. _mazebench._tcp. {name}\n"
                f"12:00:01 Add 2 15 local. _mazebench._tcp. {name} (2)\n"
            ),
            (
                f"{name} (2)._mazebench._tcp.local. can be reached at "
                "Zeno.local.:7332 (interface 15)\n"
            ),
        ]

        self.assertEqual(remote._discover_host("123"), ("Zeno.local", 7332))
        self.assertEqual(command_output.call_args_list[1].kwargs["timeout"], 2.0)

    @mock.patch.object(remote, "_discover_host", return_value=("Zeno.local", 7331))
    @mock.patch.object(
        remote.socket,
        "getaddrinfo",
        return_value=[
            (
                remote.socket.AF_INET,
                remote.socket.SOCK_STREAM,
                6,
                "",
                ("192.168.1.65", 7331),
            )
        ],
    )
    def test_endpoint_prefers_ipv4_for_bonjour_hosts(self, _getaddrinfo, _discover):
        self.assertEqual(
            remote._endpoint("123"),
            "http://192.168.1.65:7331/123/lead",
        )

    @mock.patch.object(remote, "_endpoint", return_value="http://other:7331/123/lead")
    @mock.patch.object(remote, "_lan_rpc")
    def test_remote_login_writes_only_public_records(self, lan_rpc, endpoint):
        boards = iter(["START", "UP", "DOWN", "LEFT", "ROOM"])
        lan_rpc.side_effect = lambda _url, _request, **_kwargs: observation(
            next(boards)
        )
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
        self.assertTrue(
            all(
                call.kwargs["headers"] == {"X-MazeBench-Run": "fable"}
                for call in lan_rpc.call_args_list
            )
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
    def test_host_state_directory_is_visible_under_records(self):
        with TemporaryDirectory() as tmpdir:
            environment = {
                **os.environ,
                "MAZEBENCH_RECORDS_ROOT": str(Path(tmpdir) / "records"),
            }
            environment.pop("MAZEBENCH_LAN_STATE_ROOT", None)
            with mock.patch.dict(os.environ, environment, clear=True):
                self.assertEqual(
                    mazebench_cli._lan_dir(),
                    Path(tmpdir) / "records" / "computer" / "host",
                )

    def test_legacy_hidden_host_directory_migrates_to_records(self):
        with TemporaryDirectory() as tmpdir:
            legacy_dir = Path(tmpdir) / "hidden" / "lan"
            legacy_dir.mkdir(parents=True)
            (legacy_dir / "session.json").write_text("{}\n")
            environment = {
                **os.environ,
                "MAZEBENCH_HOME": str(Path(tmpdir) / "hidden"),
                "MAZEBENCH_RECORDS_ROOT": str(Path(tmpdir) / "records"),
            }
            environment.pop("MAZEBENCH_LAN_STATE_ROOT", None)

            with mock.patch.dict(os.environ, environment, clear=True):
                self.assertEqual(mazebench_cli._migrate_legacy_host_dir(), "")

            visible_dir = Path(tmpdir) / "records" / "computer" / "host"
            self.assertEqual((visible_dir / "session.json").read_text(), "{}\n")
            self.assertFalse(legacy_dir.exists())

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
                "multi_run": "true",
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

    def test_host_process_detection_excludes_local_computer_servers(self):
        with TemporaryDirectory() as tmpdir:
            host_root = Path(tmpdir) / "records" / "computer" / "host"
            with mock.patch.object(mazebench_cli, "_lan_dir", return_value=host_root):
                self.assertTrue(
                    mazebench_cli._is_lan_host_process(
                        [
                            "node",
                            "/maze/scripts/maze-mcp-server.js",
                            "--http",
                            "--host",
                            "0.0.0.0",
                            "--port-file",
                            "/lost/state.json",
                        ]
                    )
                )
                self.assertTrue(
                    mazebench_cli._is_lan_host_process(
                        [
                            "node",
                            "/maze/scripts/maze-mcp-server.js",
                            "--http",
                            "--host",
                            "127.0.0.1",
                            "--port-file",
                            str(host_root / "fable" / "mcp-http.json"),
                        ]
                    )
                )
                self.assertFalse(
                    mazebench_cli._is_lan_host_process(
                        [
                            "node",
                            "/maze/scripts/maze-mcp-server.js",
                            "--http",
                            "--host",
                            "127.0.0.1",
                            "--port-file",
                            str(Path(tmpdir) / "records" / "computer" / "runs" / "mcp-http.json"),
                        ]
                    )
                )
                self.assertTrue(
                    mazebench_cli._is_lan_host_process(
                        [
                            "/usr/bin/dns-sd",
                            "-R",
                            "MazeBench-a665a4592042",
                            "_mazebench._tcp",
                            "local",
                            "7331",
                        ]
                    )
                )

    @mock.patch.object(mazebench_cli, "_clear_lan_state")
    @mock.patch.object(mazebench_cli, "_terminate_pid")
    @mock.patch.object(mazebench_cli, "_lan_host_process_pids", return_value=[11, 22, 33])
    @mock.patch.object(
        mazebench_cli,
        "_read_json_file",
        return_value={"url": "http://host:7332/123/lead"},
    )
    def test_stop_terminates_every_discovered_host_process(
        self, _read_json, _process_pids, terminate, clear_state
    ):
        self.assertEqual(mazebench_cli.run_lan_stop(), 0)
        self.assertEqual(
            terminate.call_args_list,
            [
                mock.call(11, timeout=1.0),
                mock.call(22, timeout=1.0),
                mock.call(33, timeout=1.0),
            ],
        )
        clear_state.assert_called_once_with()
