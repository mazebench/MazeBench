const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const boundaryOutput = execFileSync(
  "uv",
  [
    "run",
    "--project",
    path.join(root, "environments", "mazebench"),
    "python",
    path.join(root, "scripts", "maze-verify-prime-tools.py"),
    "--self-test"
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
);

assert.match(boundaryOutput, /native harness boundary ready/);
console.log("prime native harness boundary tests passed");
