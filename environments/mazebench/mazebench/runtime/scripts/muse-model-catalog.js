#!/usr/bin/env node

const { spawn } = require("node:child_process");

const child = spawn(process.env.MAZEBENCH_MUSE_BIN || "muse", [
  "serve", "--no-session-log", "--disable-shell", "--disable-write",
  "--sandbox-network", "restricted"
], {
  env: { ...process.env, MUSE_LOGIN: "0", MUSE_NO_AUTO_UPDATE: "1", NO_COLOR: "1", CI: "1" },
  stdio: ["pipe", "pipe", "pipe"]
});
let buffer = "";
let settled = false;
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const finish = (payload, code = 0) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (child.exitCode == null) child.kill("SIGTERM");
  process.exitCode = code;
};
const timer = setTimeout(() => finish({ error: "Muse Code model catalog timed out." }, 1), 10_000);
child.once("error", (error) => finish({ error: error.message }, 1));
child.stderr.on("data", () => {});
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    let message;
    try { message = JSON.parse(line); } catch (_error) { continue; }
    if (message.id === 1 && message.result) {
      send({ jsonrpc: "2.0", method: "initialized", params: {} });
      send({ jsonrpc: "2.0", id: 2, method: "model/list", params: {} });
    } else if (message.id === 1 && message.error) {
      finish({ error: String(message.error.message || "Muse Code initialization failed.") }, 1);
    } else if (message.id === 2 && message.result) {
      finish(message.result);
    } else if (message.id === 2 && message.error) {
      finish({ error: String(message.error.message || "Muse Code model catalog failed.") }, 1);
    }
  }
});
send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mazebench", version: "1" } }
});
