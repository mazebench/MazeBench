import subprocess
import sys

from pathlib import Path
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

    def test_pid_liveness_probe_does_not_terminate_process(self):
        proc = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"]
        )
        try:
            self.assertTrue(mazebench_cli._pid_alive(proc.pid))
            with self.assertRaises(subprocess.TimeoutExpired):
                proc.wait(timeout=0.1)
        finally:
            if proc.poll() is None:
                proc.terminate()
            proc.wait(timeout=5)


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
