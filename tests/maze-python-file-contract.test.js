const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-python-contract-run-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-python-contract-workspace-"));
const sandboxModulePath = require.resolve("../scripts/maze-python-sandbox");
const sandbox = require(sandboxModulePath);
let executedSource = "";

sandbox.preflightPythonSandbox = () => ({ ok: true });
sandbox.runSandboxedPython = (source) => {
  executedSource = String(source);
  return { exit_code: 0, stdout: "saved\n", stderr: "", timed_out: false };
};

process.env.MAZEBENCH_RUN_DIR = runDir;
process.env.MAZEBENCH_SESSION_FILE = path.join(runDir, "session.json");
process.env.MAZEBENCH_AGENT_WORKSPACE_DIR = workspace;
process.env.MAZEBENCH_MODE = "ascii";

try {
  const { callTool, syncObservationWorkspace } = require("../scripts/maze-mcp-server");
  const source = [
    "import json",
    "from pathlib import Path",
    "observation = json.loads(Path('observations/current.json').read_text())",
    "print(observation['observation_mode'])"
  ].join("\n");
  const result = callTool("python_exec", {
    code: source,
    script_path: "solvers/planner.py",
    timeout_seconds: 10
  });

  assert.equal(result.stdout, "saved\n");
  assert.equal(result.script_path, "solvers/planner.py");
  assert.equal(fs.readFileSync(path.join(workspace, "solvers", "planner.py"), "utf8"), source);
  assert.match(executedSource, /runpy\.run_path\("solvers\/planner\.py", run_name="__main__"\)/);

  assert.throws(
    () => callTool("python_exec", { code: "print('missing path')" }),
    /relative \.py file/
  );

  const bridge = syncObservationWorkspace({
    status: {
      current_room: "level_AxA",
      current_view: "front",
      yaw: 0,
      gem_count: 0,
      visited_levels: ["level_AxA"],
      level: "P G"
    }
  }, {});
  assert.equal(bridge.current_file, "observations/current.json");
  const current = JSON.parse(
    fs.readFileSync(path.join(workspace, "observations", "current.json"), "utf8")
  );
  assert.equal(current.observation_mode, "ascii");
  assert.equal(current.level, "P G");
  assert.equal(current.observation_revision, 0);

  for (const invalidPath of ["../escape.py", "/tmp/escape.py", "solver.txt", "nested\\escape.py"]) {
    assert.throws(
      () => callTool("python_exec", { code: "print('no')", script_path: invalidPath }),
      /relative \.py file/
    );
  }

  console.log("maze Python file contract tests passed");
} finally {
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
}
