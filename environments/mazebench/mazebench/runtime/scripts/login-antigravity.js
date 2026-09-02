#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { LOCAL_AGENT_IMAGE } = require("./local-agent-image");

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("Antigravity login needs an interactive terminal.");
}

const result = spawnSync(
  "docker",
  [
    "run", "--rm", "-it",
    "-e", "HOME=/home/pwuser",
    "-e", "SSH_CONNECTION=127.0.0.1 1 127.0.0.1 2",
    "-v", "mazebench-antigravity-auth:/home/pwuser/.gemini",
    "--entrypoint", "agy",
    LOCAL_AGENT_IMAGE
  ],
  { stdio: "inherit", env: process.env }
);

if (result.error) throw result.error;
process.exitCode = result.status || 0;
