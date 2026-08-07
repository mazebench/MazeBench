const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  preflightPythonSandbox,
  pythonSandboxCommand,
  runSandboxedPython
} = require("../scripts/maze-python-sandbox");

const root = path.resolve(__dirname, "..");
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "maze-python-test-scratch-"));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "maze-python-test-state-"));
const options = {
  scratchDir,
  stateDir,
  deniedPaths: [root, os.homedir()],
  codexBin: "codex",
  pythonBin: ""
};

try {
  const available = spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0;
  if (!available) {
    console.log("maze Python sandbox runtime test skipped: Codex CLI is not installed");
  } else {

  const command = pythonSandboxCommand({ ...options, timeoutSeconds: 5 });
  assert.equal(command.argv[0], "sandbox");
  assert(command.argv.includes("-P"));
  assert(command.argv.includes("mazebench_python"));
  assert(command.argv.includes("permissions.mazebench_python.network.enabled=false"));
  const filesystemPolicy = command.argv.find((value) => value.startsWith("permissions.mazebench_python.filesystem="));
  const canonicalScratch = fs.realpathSync(scratchDir);
  const canonicalRoot = fs.realpathSync(root);
  assert.match(filesystemPolicy, new RegExp(`${canonicalScratch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*write`));
  assert.match(filesystemPolicy, new RegExp(`${canonicalRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*deny`));
  assert.doesNotMatch(filesystemPolicy, new RegExp(`${canonicalRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*(?:read|write)`));
  const demotedCommand = pythonSandboxCommand({
    ...options,
    runUid: typeof process.getuid === "function" ? process.getuid() : 0,
    runGid: typeof process.getgid === "function" ? process.getgid() : 0
  });
  assert.equal(demotedCommand.config.runUid, typeof process.getuid === "function" ? process.getuid() : 0);
  assert.equal(demotedCommand.config.runGid, typeof process.getgid === "function" ? process.getgid() : 0);

  const preflight = preflightPythonSandbox(options);
  assert.equal(preflight.verified, true);
  assert.equal(preflight.checks.private_read.blocked, true);
  assert.equal(preflight.checks.host_temp_read.blocked, true);
  assert.equal(preflight.checks.symlink_read.blocked, true);
  assert.equal(preflight.checks.network.blocked, true);
  assert.equal(preflight.checks.subprocess.blocked, true);
  assert.equal(preflight.checks.scratch_write.allowed, true);

  const source = `
import json
import socket
import subprocess
from pathlib import Path

result = {}
repo_file = Path(${JSON.stringify(path.join(root, "package.json"))})
for name, target in [("repo", repo_file), ("repo_symlink", Path("repo-link"))]:
    try:
        if name == "repo_symlink":
            try:
                target.symlink_to(repo_file)
            except FileExistsError:
                pass
        target.read_text(encoding="utf-8")
    except PermissionError:
        result[name] = "blocked"
    except Exception as exc:
        result[name] = type(exc).__name__
    else:
        result[name] = "readable"
try:
    socket.create_connection(("127.0.0.1", 9), timeout=0.25)
except PermissionError:
    result["network"] = "blocked"
except Exception as exc:
    result["network"] = type(exc).__name__
else:
    result["network"] = "reachable"
try:
    subprocess.run(["/bin/sh", "-c", "echo escaped"], check=False)
except PermissionError:
    result["subprocess"] = "blocked"
except Exception as exc:
    result["subprocess"] = type(exc).__name__
else:
    result["subprocess"] = "launched"
Path("persistent.txt").write_text("ok", encoding="utf-8")
result["scratch"] = Path("persistent.txt").read_text(encoding="utf-8")
print(json.dumps(result, sort_keys=True))
`;
  const execution = runSandboxedPython(source, { ...options, timeoutSeconds: 5 });
  assert.equal(execution.exit_code, 0, execution.stderr);
  assert(Number.isFinite(execution.cpu_time_ms));
  assert(execution.cpu_time_ms >= 0);
  assert.doesNotMatch(execution.stderr, /MAZEBENCH_CPU_TIME_NS/);
  const result = JSON.parse(execution.stdout.trim());
  assert.deepEqual(result, {
    network: "blocked",
    repo: "blocked",
    repo_symlink: "blocked",
    scratch: "ok",
    subprocess: "blocked"
  });

  const cliExecution = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "maze-python-sandbox.js")],
    {
      encoding: "utf8",
      input: JSON.stringify({
        operation: "run",
        code: "from pathlib import Path\nprint(Path('persistent.txt').read_text())",
        timeout_seconds: 5,
        scratch_dir: scratchDir,
        state_dir: stateDir,
        denied_paths: [root, os.homedir()],
        codex_bin: "codex"
      })
    }
  );
  assert.equal(cliExecution.status, 0, cliExecution.stderr);
  const cliResult = JSON.parse(cliExecution.stdout);
  assert.equal(cliResult.exit_code, 0, cliResult.stderr);
  assert.equal(cliResult.stdout, "ok\n");

  console.log("maze Python sandbox tests passed");
  }
} finally {
  fs.rmSync(scratchDir, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
}
