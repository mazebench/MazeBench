const http = require("http");
const fs = require("fs");
const { HOST, PORT, createRequestHandler } = require("./server/app");
const { browserHostForBind } = require("./server/network");

const server = http.createServer(createRequestHandler());

// If a state-file path is provided (the `mazebench` launcher sets it), record
// the pid + the actually-bound port/url once we're listening, and clear it on
// exit. `mazebench stop` / `status` read this file. Running `node server.js`
// directly (no env var) simply skips it.
const stateFile = process.env.MAZEBENCH_STATE_FILE || "";

function writeState(port, url) {
  if (!stateFile) return;
  try {
    fs.writeFileSync(
      stateFile,
      `${JSON.stringify({ pid: process.pid, host: HOST, port, url, started_at: new Date().toISOString() }, null, 2)}\n`
    );
  } catch (_error) {
    /* best effort — stop/status just won't find it */
  }
}

function clearState() {
  if (!stateFile) return;
  try {
    const current = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (current.pid === process.pid) fs.rmSync(stateFile, { force: true });
  } catch (_error) {
    /* file gone or unreadable — nothing to clean */
  }
}

// Try the preferred port; if it's taken, walk upward to the next free one so a
// stale/other server never blocks a launch. server.listen re-emits after an
// EADDRINUSE error, so we just retry with an incremented port.
let port = PORT;
let attemptsLeft = 20;

server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
    attemptsLeft -= 1;
    port += 1;
    setTimeout(() => server.listen(port, HOST), 60);
    return;
  }
  console.error(`MazeBench: could not start on ${HOST}:${port} — ${error.message}`);
  process.exit(1);
});

server.on("listening", () => {
  const url = `http://${browserHostForBind(HOST)}:${port}`;
  console.log(`MazeBench running at ${url}`);
  writeState(port, url);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearState();
    process.exit(0);
  });
}
process.on("exit", clearState);

server.listen(port, HOST);
