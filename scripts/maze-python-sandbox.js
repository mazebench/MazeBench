#!/usr/bin/env node

// Run benchmark-authored Python inside Codex's native OS sandbox. The trusted
// MazeBench MCP server calls this module; evaluated agents never receive a
// shell or a host path. Only the run-scoped scratch directory is writable.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MAX_CODE_BYTES = 256_000;
const MAX_OUTPUT_BYTES = 256_000;
const MAX_TIMEOUT_SECONDS = 60;

const PYTHON_BOOTSTRAP = String.raw`
import os
import sys
import time
try:
    import resource
    cpu = int(sys.argv[1])
    memory = int(sys.argv[2]) * 1024 * 1024
    file_size = int(sys.argv[3]) * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
    if hasattr(resource, "RLIMIT_AS"):
        resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
    resource.setrlimit(resource.RLIMIT_FSIZE, (file_size, file_size))
except (ImportError, ValueError, OSError):
    pass
_workspace_root = os.path.realpath(os.getcwd())
_runtime_roots = tuple(
    os.path.realpath(entry)
    for entry in [sys.base_prefix, sys.exec_prefix, os.path.dirname(sys.executable), *sys.path]
    if entry
)
_safe_devices = {"/dev/null", "/dev/random", "/dev/urandom"}
def _inside(candidate, root):
    try:
        return os.path.commonpath([candidate, root]) == root
    except (OSError, ValueError):
        return False
def _allow_python_path(value):
    if isinstance(value, int):
        return value in {0, 1, 2}
    try:
        candidate = os.path.realpath(os.fsdecode(value))
    except (TypeError, ValueError, OSError):
        return False
    return candidate in _safe_devices or _inside(candidate, _workspace_root) or any(
        _inside(candidate, root) for root in _runtime_roots
    )
def _deny_process_escape(event, args):
    if event.startswith("subprocess.") or event.startswith("ctypes.") or event in {
        "os.exec", "os.fork", "os.forkpty", "os.posix_spawn", "os.spawn", "os.system", "pty.spawn"
    }:
        raise PermissionError("python_exec cannot launch external processes")
    if event == "open" and args and not _allow_python_path(args[0]):
        raise PermissionError("python_exec cannot access files outside its scratch workspace")
    if event in {
        "os.chdir", "os.chmod", "os.chown", "os.listdir", "os.mkdir", "os.remove", "os.rename",
        "os.replace", "os.rmdir", "os.scandir", "os.symlink", "os.truncate", "os.unlink", "os.utime",
        "glob.glob", "glob.glob/2"
    } and args and not _allow_python_path(args[0]):
        raise PermissionError("python_exec cannot access paths outside its scratch workspace")
    if event in {"os.link", "os.rename", "os.replace", "os.symlink"} and len(args) > 1 and not _allow_python_path(args[1]):
        raise PermissionError("python_exec cannot access paths outside its scratch workspace")
sys.addaudithook(_deny_process_escape)
sys.path.insert(0, os.getcwd())
source = sys.stdin.read()
scope = {"__name__": "__main__", "__file__": "<mazebench-python>"}
_mazebench_process_time_ns = time.process_time_ns
_mazebench_stderr_write = os.write
_mazebench_cpu_started_ns = _mazebench_process_time_ns()
try:
    exec(compile(source, "<mazebench-python>", "exec"), scope, scope)
finally:
    _mazebench_cpu_elapsed_ns = max(0, _mazebench_process_time_ns() - _mazebench_cpu_started_ns)
    try:
        _mazebench_stderr_write(2, f"\x1eMAZEBENCH_CPU_TIME_NS={_mazebench_cpu_elapsed_ns}\x1e".encode("ascii"))
    except OSError:
        pass
`.trim();

const CPU_TELEMETRY_PATTERN = /\u001eMAZEBENCH_CPU_TIME_NS=(\d+)\u001e/g;

function tomlString(value) {
  return JSON.stringify(String(value));
}

function inlinePermissionTable(entries) {
  return `{${Object.entries(entries)
    .map(([entry, access]) => `${tomlString(entry)}=${tomlString(access)}`)
    .join(",")}}`;
}

function resolvedExecutable(command, label) {
  const value = String(command || "").trim();
  if (!value) throw new Error(`${label} executable is required.`);
  if (value.includes(path.sep)) {
    const absolute = path.resolve(value);
    if (!fs.existsSync(absolute)) throw new Error(`${label} executable does not exist.`);
    return absolute;
  }
  const probe = spawnSync("which", [value], { encoding: "utf8" });
  const found = String(probe.stdout || "").trim().split(/\r?\n/, 1)[0];
  if (probe.status !== 0 || !found) throw new Error(`${label} executable was not found on PATH.`);
  return path.resolve(found);
}

function findPythonExecutable(requested = "") {
  const candidates = [requested, "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3", "python3"]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    try {
      return resolvedExecutable(candidate, "Python");
    } catch (_error) {
      // Try the next standalone interpreter.
    }
  }
  throw new Error("No standalone Python 3 interpreter is available for isolated tool use.");
}

function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function canonicalPath(candidate) {
  const absolute = path.resolve(String(candidate));
  try {
    return fs.realpathSync(absolute);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(canonicalPath(parent), path.basename(absolute));
  }
}

function runtimeReadRoots(pythonBin) {
  const roots = [];
  for (const candidate of [path.resolve(pythonBin), fs.realpathSync(pythonBin)]) {
    if (candidate.startsWith("/opt/homebrew/")) roots.push("/opt/homebrew");
    else if (candidate.startsWith("/usr/local/")) roots.push("/usr/local");
    else if (candidate.startsWith("/Library/Frameworks/")) roots.push("/Library/Frameworks");
    else if (!candidate.startsWith("/usr/") && !candidate.startsWith("/System/")) {
      roots.push(path.dirname(candidate));
    }
  }
  return [...new Set(roots)];
}

function normalizeSandboxOptions(options = {}) {
  let scratchDir = path.resolve(String(options.scratchDir || ""));
  let stateDir = path.resolve(String(options.stateDir || ""));
  if (!String(options.scratchDir || "").trim()) throw new Error("A Python scratch directory is required.");
  if (!String(options.stateDir || "").trim()) throw new Error("A Python sandbox state directory is required.");
  fs.mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  scratchDir = canonicalPath(scratchDir);
  stateDir = canonicalPath(stateDir);
  const deniedPaths = [...new Set((options.deniedPaths || []).map(canonicalPath))];
  if (deniedPaths.some((entry) => isWithin(scratchDir, entry))) {
    throw new Error("The Python scratch directory must not be inside a denied path.");
  }
  const codexBin = resolvedExecutable(options.codexBin || "codex", "Codex");
  const pythonBin = findPythonExecutable(options.pythonBin || "");
  const runUid = Number.isInteger(Number(options.runUid)) && Number(options.runUid) >= 0
    ? Number(options.runUid)
    : null;
  const runGid = Number.isInteger(Number(options.runGid)) && Number(options.runGid) >= 0
    ? Number(options.runGid)
    : null;
  if ((runUid === null) !== (runGid === null)) {
    throw new Error("Python sandbox runUid and runGid must be supplied together.");
  }
  if (deniedPaths.some((entry) => isWithin(pythonBin, entry))) {
    throw new Error("The Python interpreter must not be inside a denied path.");
  }
  fs.mkdirSync(path.join(scratchDir, ".tmp"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(stateDir, "codex-home"), { recursive: true, mode: 0o700 });
  if (runUid !== null && typeof process.getuid === "function" && process.getuid() === 0) {
    for (const directory of [scratchDir, path.join(scratchDir, ".tmp"), stateDir, path.join(stateDir, "codex-home")]) {
      fs.chownSync(directory, runUid, runGid);
    }
  }
  return { scratchDir, stateDir, deniedPaths, codexBin, pythonBin, runUid, runGid };
}

function sandboxEnvironment(config) {
  return {
    CODEX_HOME: path.join(config.stateDir, "codex-home"),
    HOME: config.scratchDir,
    TMPDIR: path.join(config.scratchDir, ".tmp"),
    PATH: [...new Set([
      path.dirname(config.codexBin),
      path.dirname(config.pythonBin),
      "/usr/bin",
      "/bin"
    ])].join(path.delimiter),
    LANG: "C",
    LC_ALL: "C",
    PYTHONIOENCODING: "utf-8",
    PYTHONDONTWRITEBYTECODE: "1"
  };
}

function pythonSandboxCommand(options = {}) {
  const config = normalizeSandboxOptions(options);
  const timeoutSeconds = Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Number(options.timeoutSeconds) || 10));
  const permissions = { ":minimal": "read" };
  for (const root of runtimeReadRoots(config.pythonBin)) permissions[root] = "read";
  permissions[config.scratchDir] = "write";
  // Avoid nested deny mounts (for example stateDir inside a denied runDir),
  // which Bubblewrap cannot construct after the parent has been masked.
  if (!config.deniedPaths.some((denied) => isWithin(config.stateDir, denied))) {
    permissions[config.stateDir] = "deny";
  }
  for (const denied of config.deniedPaths) permissions[denied] = "deny";
  return {
    config,
    argv: [
      "sandbox",
      "-C", config.scratchDir,
      "-P", "mazebench_python",
      "-c", `permissions.mazebench_python.filesystem=${inlinePermissionTable(permissions)}`,
      "-c", "permissions.mazebench_python.network.enabled=false",
      config.pythonBin,
      "-I",
      "-B",
      "-c", PYTHON_BOOTSTRAP,
      String(timeoutSeconds + 1),
      "1024",
      "32"
    ]
  };
}

function boundedText(value, limit = Math.floor(MAX_OUTPUT_BYTES / 2)) {
  const buffer = Buffer.from(String(value || ""), "utf8");
  if (buffer.length <= limit) return { text: buffer.toString("utf8"), truncated: false };
  return { text: buffer.subarray(0, limit).toString("utf8"), truncated: true };
}

function extractPythonTelemetry(value) {
  let cpuTimeNanoseconds = null;
  const stderr = String(value || "").replace(CPU_TELEMETRY_PATTERN, (_marker, nanoseconds) => {
    const parsed = Number(nanoseconds);
    if (Number.isFinite(parsed)) cpuTimeNanoseconds = Math.max(0, parsed);
    return "";
  });
  return {
    stderr,
    cpuTimeMs: cpuTimeNanoseconds === null ? null : cpuTimeNanoseconds / 1_000_000
  };
}

function runSandboxedPython(code, options = {}) {
  const source = String(code || "");
  if (!source.trim()) throw new Error("Python code is required.");
  if (Buffer.byteLength(source, "utf8") > MAX_CODE_BYTES) {
    throw new Error(`Python code exceeds ${MAX_CODE_BYTES} bytes.`);
  }
  const timeoutSeconds = Number(options.timeoutSeconds) || 10;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeout_seconds must be between 1 and ${MAX_TIMEOUT_SECONDS}.`);
  }
  const { config, argv } = pythonSandboxCommand({ ...options, timeoutSeconds });
  const result = spawnSync(config.codexBin, argv, {
    cwd: config.scratchDir,
    env: sandboxEnvironment(config),
    ...(config.runUid === null ? {} : { uid: config.runUid, gid: config.runGid }),
    input: source,
    encoding: "utf8",
    timeout: (timeoutSeconds + 5) * 1000,
    maxBuffer: MAX_OUTPUT_BYTES * 2,
    killSignal: "SIGKILL"
  });
  const stdout = boundedText(result.stdout);
  const telemetry = extractPythonTelemetry(result.stderr);
  const stderr = boundedText(telemetry.stderr);
  const timedOut = result.error?.code === "ETIMEDOUT";
  return {
    exit_code: Number.isInteger(result.status) ? result.status : null,
    stdout: stdout.text,
    stderr: stderr.text || (result.error && !timedOut ? String(result.error.message || result.error) : ""),
    cpu_time_ms: telemetry.cpuTimeMs,
    timed_out: timedOut,
    output_truncated: stdout.truncated || stderr.truncated || result.error?.code === "ENOBUFS"
  };
}

function preflightPythonSandbox(options = {}) {
  const config = normalizeSandboxOptions(options);
  const canaryPath = path.join(config.stateDir, "private-canary.txt");
  const hostCanaryPath = path.join(
    fs.existsSync("/tmp") ? "/tmp" : os.tmpdir(),
    `mazebench-host-canary-${process.pid}-${Date.now()}.txt`
  );
  const canary = Buffer.from(`${process.pid}:${Date.now()}:${os.hostname()}`).toString("base64url");
  fs.writeFileSync(canaryPath, `${canary}\n`, { mode: 0o600 });
  fs.writeFileSync(hostCanaryPath, `${canary}\n`, { mode: 0o600 });
  const symlinkPath = path.join(config.scratchDir, ".private-canary-link");
  try {
    fs.rmSync(symlinkPath, { force: true });
    fs.symlinkSync(canaryPath, symlinkPath);
  } catch (_error) {
    // Direct-read and network checks still fail closed on platforms that deny symlink creation.
  }
  const probe = String.raw`
import json
import socket
import subprocess
from pathlib import Path

result = {}
for name, target in [
    ("private_read", Path(${JSON.stringify(canaryPath)})),
    ("host_temp_read", Path(${JSON.stringify(hostCanaryPath)})),
    ("symlink_read", Path(${JSON.stringify(symlinkPath)})),
]:
    try:
        target.read_bytes()
    except PermissionError as exc:
        result[name] = {"blocked": True, "error": type(exc).__name__}
    except Exception as exc:
        result[name] = {"blocked": False, "error": type(exc).__name__}
    else:
        result[name] = {"blocked": False, "error": None}

try:
    socket.create_connection(("127.0.0.1", 9), timeout=0.25)
except PermissionError as exc:
    result["network"] = {"blocked": True, "error": type(exc).__name__}
except Exception as exc:
    result["network"] = {"blocked": False, "error": type(exc).__name__}
else:
    result["network"] = {"blocked": False, "error": None}

try:
    subprocess.run(["/bin/sh", "-c", "echo escaped"], check=False)
except PermissionError as exc:
    result["subprocess"] = {"blocked": True, "error": type(exc).__name__}
except Exception as exc:
    result["subprocess"] = {"blocked": False, "error": type(exc).__name__}
else:
    result["subprocess"] = {"blocked": False, "error": None}

target = Path("preflight-scratch.txt")
try:
    target.write_text("ok", encoding="utf-8")
    result["scratch_write"] = {"allowed": target.read_text(encoding="utf-8") == "ok"}
except Exception as exc:
    result["scratch_write"] = {"allowed": False, "error": type(exc).__name__}

print("MAZEBENCH_PREFLIGHT=" + json.dumps(result, sort_keys=True))
`;
  const execution = runSandboxedPython(probe, {
    ...config,
    timeoutSeconds: 5
  });
  const marker = "MAZEBENCH_PREFLIGHT=";
  const line = execution.stdout.split(/\r?\n/).find((entry) => entry.startsWith(marker));
  let report = null;
  try {
    report = line ? JSON.parse(line.slice(marker.length)) : null;
  } catch (_error) {
    report = null;
  }
  const passed = execution.exit_code === 0 &&
    report?.private_read?.blocked === true &&
    report?.host_temp_read?.blocked === true &&
    report?.symlink_read?.blocked === true &&
    report?.network?.blocked === true &&
    report?.subprocess?.blocked === true &&
    report?.scratch_write?.allowed === true;
  fs.rmSync(symlinkPath, { force: true });
  fs.rmSync(path.join(config.scratchDir, "preflight-scratch.txt"), { force: true });
  fs.rmSync(hostCanaryPath, { force: true });
  if (!passed) {
    throw new Error(
      "Tool isolation preflight failed; the run was not started. " +
      `exit=${execution.exit_code ?? "none"} report=${JSON.stringify(report)} stderr=${execution.stderr.trim()}`
    );
  }
  return {
    version: 1,
    verified: true,
    verified_at: new Date().toISOString(),
    checks: report
  };
}

function cliRequest(value) {
  const request = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const operation = String(request.operation || "");
  const options = {
    scratchDir: request.scratch_dir,
    stateDir: request.state_dir,
    deniedPaths: Array.isArray(request.denied_paths) ? request.denied_paths : [],
    codexBin: request.codex_bin || "codex",
    pythonBin: request.python_bin || "",
    runUid: request.run_uid,
    runGid: request.run_gid
  };
  if (operation === "preflight") {
    return preflightPythonSandbox(options);
  }
  if (operation === "run") {
    return runSandboxedPython(String(request.code || ""), {
      ...options,
      timeoutSeconds: Number(request.timeout_seconds) || 10
    });
  }
  throw new Error('operation must be "preflight" or "run".');
}

function runCli() {
  try {
    const source = fs.readFileSync(0, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_CODE_BYTES + 64 * 1024) {
      throw new Error("Python sandbox request is too large.");
    }
    const request = JSON.parse(source);
    process.stdout.write(`${JSON.stringify(cliRequest(request))}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  canonicalPath,
  cliRequest,
  findPythonExecutable,
  inlinePermissionTable,
  preflightPythonSandbox,
  pythonSandboxCommand,
  runSandboxedPython
};

if (require.main === module) runCli();
