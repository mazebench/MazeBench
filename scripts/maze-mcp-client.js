#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const args = process.argv.slice(2);
  const allowLanIndex = args.indexOf("--allow-lan");
  const allowLan = allowLanIndex >= 0;
  if (allowLan) args.splice(allowLanIndex, 1);
  const [urlValue, requestPath, ...extra] = args;
  if (!urlValue || !requestPath || extra.length) {
    throw new Error("Usage: node scripts/maze-mcp-client.js [--allow-lan] <mcp-http-url> <request.json>");
  }

  const url = new URL(urlValue);
  const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (url.protocol !== "http:" || (!allowLan && !localHosts.has(url.hostname))) {
    throw new Error(
      allowLan
        ? "MCP URL must use HTTP."
        : "MCP URL must use container-local HTTP."
    );
  }
  const request = JSON.parse(fs.readFileSync(path.resolve(requestPath), "utf8"));
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  });
  const payload = JSON.parse(await response.text());
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (!response.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
