"use strict";

const fs = require("node:fs");
const path = require("node:path");

function lockDirFor(optDir) {
  return path.join(optDir, ".gpu-lock");
}

function ownerPathFor(lockDir) {
  return path.join(lockDir, "owner.json");
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(ownerPathFor(lockDir), "utf8"));
  } catch {
    return null;
  }
}

function writeOwner(lockDir, owner) {
  fs.writeFileSync(ownerPathFor(lockDir), `${JSON.stringify(owner, null, 2)}\n`);
}

function removeLock(lockDir) {
  fs.rmSync(lockDir, { recursive: true, force: true });
}

function stealIfStale(lockDir, staleMs) {
  if (!fs.existsSync(lockDir)) return false;
  const owner = readOwner(lockDir);
  if (!owner) {
    removeLock(lockDir);
    return true;
  }
  const beat = Number(owner.heartbeatAt || owner.startedAt || 0);
  const stale = Date.now() - beat > staleMs;
  const dead = !isPidAlive(owner.pid);
  if (stale || dead) {
    removeLock(lockDir);
    return true;
  }
  return false;
}

function tryAcquire(lockDir, meta) {
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return false;
  }
  writeOwner(lockDir, {
    pid: process.pid,
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
    ...meta
  });
  return true;
}

function inspectLock(optDir, staleMs = 20000) {
  const lockDir = lockDirFor(optDir);
  if (!fs.existsSync(lockDir)) return { locked: false, owner: null };
  const owner = readOwner(lockDir);
  return {
    locked: true,
    owner,
    alive: owner ? isPidAlive(owner.pid) : false,
    staleMs
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withGpuLock(optDir, fn, options = {}) {
  const lockDir = lockDirFor(optDir);
  const timeoutMs = options.timeoutMs ?? 300000;
  const staleMs = options.staleMs ?? 20000;
  const pollMs = options.pollMs ?? 50;
  const waitStarted = Date.now();
  fs.mkdirSync(optDir, { recursive: true });

  while (!tryAcquire(lockDir, options.owner || {})) {
    stealIfStale(lockDir, staleMs);
    if (Date.now() - waitStarted > timeoutMs) {
      const owner = readOwner(lockDir);
      const who = owner ? `pid ${owner.pid} label=${owner.label || "?"}` : "unknown";
      throw new Error(`GPU lock timeout after ${timeoutMs}ms (${who})`);
    }
    await sleep(pollMs);
  }

  const queueWaitMs = Date.now() - waitStarted;
  const holdStarted = Date.now();
  const beat = setInterval(() => {
    try {
      const owner = readOwner(lockDir);
      if (!owner || owner.pid !== process.pid) return;
      owner.heartbeatAt = Date.now();
      writeOwner(lockDir, owner);
    } catch {
      // lock vanished; bench still runs
    }
  }, Math.min(500, Math.max(100, staleMs / 4)));
  if (typeof beat.unref === "function") beat.unref();

  try {
    const result = await fn({ queueWaitMs, lockDir });
    return {
      ...result,
      exclusive: true,
      queueWaitMs,
      holdMs: Date.now() - holdStarted
    };
  } finally {
    clearInterval(beat);
    if (readOwner(lockDir)?.pid === process.pid) removeLock(lockDir);
  }
}

module.exports = {
  inspectLock,
  isPidAlive,
  lockDirFor,
  readOwner,
  stealIfStale,
  withGpuLock
};
