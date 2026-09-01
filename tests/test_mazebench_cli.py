from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock

import mazebench_cli


class CliCommandTests(TestCase):
    @mock.patch("builtins.print")
    @mock.patch.object(mazebench_cli, "resolve_root")
    def test_global_help_does_not_require_a_runtime(self, resolve_root, print_output):
        result = mazebench_cli.main(["--help"])

        self.assertEqual(result, 0)
        resolve_root.assert_not_called()
        print_output.assert_called_once_with(mazebench_cli.USAGE)

    @mock.patch.object(mazebench_cli, "run_ascii", return_value=23)
    @mock.patch.object(mazebench_cli, "resolve_root", return_value=Path("/maze"))
    def test_main_routes_ascii_flags(self, _resolve_root, run_ascii):
        result = mazebench_cli.main(["ascii", "--level", "level_CxD", "--once"])

        self.assertEqual(result, 23)
        run_ascii.assert_called_once_with(
            Path("/maze"), {}, ["--level", "level_CxD", "--once"]
        )

    @mock.patch.object(mazebench_cli, "_run", return_value=0)
    @mock.patch.object(mazebench_cli, "_require")
    @mock.patch.object(mazebench_cli, "_node_bin", return_value="node")
    def test_ascii_supports_existing_key_value_style(
        self, _node_bin, _require, run_command
    ):
        root = Path("/maze")

        result = mazebench_cli.run_ascii(
            root, {"level": "CxD", "view": "top"}, ["--once"]
        )

        self.assertEqual(result, 0)
        run_command.assert_called_once_with(
            [
                "node",
                str(root / "scripts" / "maze-terminal.js"),
                "--level",
                "CxD",
                "--view",
                "top",
                "--once",
            ],
            root,
        )

    @mock.patch.object(mazebench_cli, "run_json", return_value=29)
    @mock.patch.object(mazebench_cli, "resolve_root", return_value=Path("/maze"))
    def test_main_routes_json_flags(self, _resolve_root, run_json):
        result = mazebench_cli.main(["json", "--level", "CxD", "--omniscient"])

        self.assertEqual(result, 29)
        run_json.assert_called_once_with(
            Path("/maze"), {}, ["--level", "CxD", "--omniscient"]
        )

    @mock.patch.object(mazebench_cli, "run_lan", return_value=31)
    @mock.patch.object(mazebench_cli, "resolve_root")
    def test_main_routes_lan_without_requiring_a_runtime(self, resolve_root, run_lan):
        result = mazebench_cli.main(["lan", "observe", "url=http://bench.local/secret/lead"])

        self.assertEqual(result, 31)
        resolve_root.assert_not_called()
        run_lan.assert_called_once_with(
            ["observe"], {"url": "http://bench.local/secret/lead"}, []
        )

    def test_lan_sequence_supports_llm_friendly_move_strings(self):
        self.assertEqual(
            mazebench_cli._lan_sequence_from_tokens(["UURDDL"]),
            ["up", "up", "right", "down", "down", "left"],
        )
        self.assertEqual(
            mazebench_cli._lan_sequence_from_tokens(['["U", "rotate camera left"]']),
            ["up", "rotate camera left"],
        )

    @mock.patch.object(mazebench_cli, "_run", return_value=0)
    @mock.patch.object(mazebench_cli, "_require")
    @mock.patch.object(mazebench_cli, "_node_bin", return_value="node")
    def test_json_supports_literal_names_and_existing_key_value_style(
        self, _node_bin, _require, run_command
    ):
        root = Path("/maze")

        result = mazebench_cli.run_json(
            root,
            {"level": "CxD", "view": "top", "omniscient": "true"},
            [],
        )

        self.assertEqual(result, 0)
        run_command.assert_called_once_with(
            [
                "node",
                str(root / "scripts" / "maze-terminal.js"),
                "--json",
                "--level",
                "CxD",
                "--view",
                "top",
                "--omniscient",
            ],
            root,
        )

    @mock.patch.object(mazebench_cli, "_start_lan_advertiser", return_value=456)
    @mock.patch.object(mazebench_cli, "_wait_for_lan_port_file", return_value={"pid": 123, "port": 7331})
    @mock.patch.object(mazebench_cli, "_find_free_port", return_value=7331)
    @mock.patch.object(mazebench_cli, "_local_hostname", return_value="Bench-Mac.local")
    @mock.patch.object(mazebench_cli, "_lan_ipv4_addresses", return_value=["192.168.1.50"])
    @mock.patch.object(mazebench_cli, "_read_lan_state", return_value=None)
    @mock.patch.object(mazebench_cli, "resolve_root", return_value=Path("/maze"))
    @mock.patch.object(mazebench_cli, "_node_bin", return_value="node")
    @mock.patch.object(mazebench_cli, "_require")
    @mock.patch.object(mazebench_cli.subprocess, "Popen")
    def test_lan_serve_starts_restricted_json_http_bridge(
        self,
        popen,
        _require,
        _node_bin,
        _resolve_root,
        _read_lan_state,
        _lan_ipv4_addresses,
        _local_hostname,
        _find_free_port,
        _wait_for_lan_port_file,
        _start_lan_advertiser,
    ):
        proc = mock.Mock()
        proc.pid = 123
        popen.return_value = proc

        with TemporaryDirectory() as tmpdir:
            with mock.patch.object(mazebench_cli, "_lan_dir", return_value=Path(tmpdir)):
                result = mazebench_cli.run_lan_serve([], {"token": "secret"}, [])

        self.assertEqual(result, 0)
        command = popen.call_args.args[0]
        self.assertIn("--http", command)
        self.assertEqual(command[command.index("--host") + 1], "0.0.0.0")
        self.assertEqual(command[command.index("--port") + 1], "7331")
        env = popen.call_args.kwargs["env"]
        self.assertEqual(env["MAZEBENCH_RESTRICTED_MODE"], "1")
        self.assertEqual(env["MAZEBENCH_MODE"], "json")
        self.assertEqual(env["MAZEBENCH_AUTO_RUN_TOOLS"], "1")
        self.assertEqual(env["MAZEBENCH_MOVE_BUDGET"], "unlimited")

    @mock.patch.object(mazebench_cli, "_run", return_value=0)
    @mock.patch.object(mazebench_cli, "_require")
    def test_prime_eval_uses_the_native_framework_harness(self, _require, run_command):
        root = Path("/maze")

        result = mazebench_cli.run_prime(
            root,
            ["eval"],
            {"model": "openai/test", "max_turns": "3"},
            [],
        )

        self.assertEqual(result, 0)
        command = run_command.call_args.args[0]
        self.assertIn("mazebench-tools", command)
        self.assertEqual(
            command[command.index("--env.agent.harness.id") + 1],
            "null",
        )
        self.assertEqual(
            command[command.index("--env.agent.runtime.type") + 1], "prime"
        )
        self.assertNotIn("--env.taskset.tools.colocated", command)
        self.assertNotIn("--env.taskset.python-tools", command)
        with self.assertRaisesRegex(mazebench_cli.CliError, "replace the approved"):
            mazebench_cli.run_prime(root, ["eval"], {}, ["--harness.id", "bash"])
