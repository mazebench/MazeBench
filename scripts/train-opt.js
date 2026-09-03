#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { inspectLock, withGpuLock } = require("./train-opt-lock");
const store = require("./train-opt-store");
const master = require("./train-opt-master");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optDirFrom(flags) {
  return flags.dir ? path.resolve(String(flags.dir)) : store.defaultOptDir();
}

function git(args, cwd, extra = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", ...extra });
  if (result.status !== 0 && extra.throw !== false) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return (result.stdout || "").trim();
}

function overlayDirtyFiles(srcRoot, destRoot) {
  const porcelain = git(["status", "--porcelain", "-uall"], srcRoot, { throw: false });
  const copied = [];
  for (const line of porcelain.split(/\r?\n/).filter(Boolean)) {
    const raw = line.slice(3);
    const rel = raw.includes(" -> ") ? raw.split(" -> ").pop() : raw;
    if (!rel || rel.startsWith("outputs/") || rel.startsWith("node_modules/")) continue;
    const from = path.join(srcRoot, rel);
    if (!fs.existsSync(from) || fs.statSync(from).isDirectory()) continue;
    const to = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied.push(rel);
  }
  return copied;
}

function junction(src, dest) {
  if (fs.existsSync(dest)) return;
  fs.symlinkSync(src, dest, process.platform === "win32" ? "junction" : "dir");
}

function copyFallbackTree(srcRoot, dest) {
  const names = [
    "public",
    "scripts",
    "tests",
    "server",
    "shared",
    "games",
    "package.json",
    "package-lock.json",
    "server.js"
  ];
  for (const name of names) {
    const from = path.join(srcRoot, name);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(dest, name), { recursive: true, force: true });
  }
}

function createSlot(optDir, name, srcRoot) {
  const dest = path.join(optDir, "worktrees", name);
  if (fs.existsSync(dest)) {
    spawnSync("git", ["worktree", "remove", "--force", dest], { cwd: srcRoot, encoding: "utf8" });
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    git(["worktree", "add", "--detach", dest], srcRoot);
    overlayDirtyFiles(srcRoot, dest);
    master.overlayMasterFiles(srcRoot, dest);
  } catch (error) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    copyFallbackTree(srcRoot, dest);
    master.overlayMasterFiles(srcRoot, dest);
    fs.writeFileSync(path.join(dest, ".train-opt-copy-error.txt"), String(error.message || error));
  }
  const nmSrc = path.join(srcRoot, "node_modules");
  const nmDest = path.join(dest, "node_modules");
  if (fs.existsSync(nmSrc) && !fs.existsSync(nmDest)) junction(nmSrc, nmDest);
  fs.writeFileSync(
    path.join(dest, ".train-opt-slot.json"),
    `${JSON.stringify({ name, srcRoot, optDir, createdAt: new Date().toISOString() }, null, 2)}\n`
  );
  return dest;
}

function summarizeProfile(result) {
  const frames = Math.max(1, result.frames || 1);
  const readF32Count = store.profileCount(result.profile, "readF32");
  return {
    readF32Count,
    readF32PerFrame: readF32Count / frames,
    actCount: store.profileCount(result.profile, "collect.act"),
    envStepCount: store.profileCount(result.profile, "collect.envStep"),
    hotspots: store.hotspotRows(result.profile)
  };
}

function runVerify(cwd) {
  const tests = [
    ["node", ["tests/train-harness.test.js"]],
    ["node", ["tests/train-moves.test.js"]]
  ];
  const results = [];
  for (const [cmd, args] of tests) {
    const started = Date.now();
    const proc = spawnSync(cmd, args, { cwd, encoding: "utf8" });
    results.push({
      script: args[0],
      ok: proc.status === 0,
      ms: Date.now() - started,
      tail: String(proc.stdout || proc.stderr || "")
        .trim()
        .split(/\r?\n/)
        .slice(-4)
        .join(" | ")
    });
    if (proc.status !== 0) {
      return { ok: false, results };
    }
  }
  return { ok: true, results };
}

async function exclusiveBench(flags) {
  const optDir = optDirFrom(flags);
  const cwd = flags.cwd ? path.resolve(String(flags.cwd)) : process.cwd();
  const label = String(flags.label || "candidate");
  const envs = Math.max(1, num(flags.envs, 1));
  const steps = Math.max(1, num(flags.steps, 50));
  const verify = flags.verify !== "false" && flags.verify !== false;
  let testsOk = true;
  let tests = null;
  if (verify) {
    tests = runVerify(cwd);
    testsOk = tests.ok;
  }

  const { runNodeHarness } = require("./train-harness-node");
  const identity = store.gitIdentity(cwd);
  const locked = await withGpuLock(
    optDir,
    async ({ queueWaitMs }) => {
      const harness = await runNodeHarness({ envs, steps, seed: num(flags.seed, 1) });
      const counts = summarizeProfile(harness);
      return { harness, counts, queueWaitMs };
    },
    {
      timeoutMs: num(flags["lock-timeout-ms"], 300000),
      owner: { label, cwd, pid: process.pid }
    }
  );

  const entry = {
    id: store.newId(label === "baseline" ? "base" : "opt"),
    label,
    idea: flags.idea ? String(flags.idea) : "",
    exclusive: true,
    contended: locked.queueWaitMs > 25,
    fps: locked.harness.fps,
    frames: locked.harness.frames,
    seconds: locked.harness.seconds,
    adapter: locked.harness.adapter,
    losses: locked.harness.losses,
    testsOk,
    tests,
    queueWaitMs: locked.queueWaitMs,
    holdMs: locked.holdMs,
    readF32Count: locked.counts.readF32Count,
    readF32PerFrame: locked.counts.readF32PerFrame,
    actCount: locked.counts.actCount,
    envStepCount: locked.counts.envStepCount,
    hotspots: locked.counts.hotspots,
    iteration: flags.iteration != null ? num(flags.iteration, null) : null,
    slot: flags.slot != null ? num(flags.slot, null) : null,
    git: identity,
    cwd,
    createdAt: new Date().toISOString()
  };
  const status = store.appendEntry(optDir, entry);
  return { entry, status, optDir };
}

function printBench(result) {
  const { entry, status, optDir } = result;
  const delta = store.formatDelta(store.deltaPct(entry.fps, status.baselineFps));
  console.log(`exclusive fps: ${entry.fps.toFixed(1)}  vs baseline ${delta}`);
  console.log(`label: ${entry.label}  tests: ${entry.testsOk ? "pass" : "FAIL"}  queue: ${entry.queueWaitMs}ms  hold: ${entry.holdMs}ms`);
  console.log(`readF32/frame: ${Number(entry.readF32PerFrame || 0).toFixed(2)}  adapter: ${entry.adapter}`);
  console.log(`status: ${store.statusMdPath(optDir)}`);
}

function cmdStatus(flags) {
  const optDir = optDirFrom(flags);
  const status = store.writeStatus(optDir, { gpu: inspectLock(optDir) });
  console.log(store.renderStatusMd(status));
  return status;
}

function grokBin() {
  if (process.env.GROK_BIN) return process.env.GROK_BIN;
  const named = process.platform === "win32" ? "grok.exe" : "grok";
  const bundled = path.join(os.homedir(), ".grok", "bin", named);
  if (fs.existsSync(bundled)) return bundled;
  return "grok";
}

function implementerPrompt(spec) {
  return `You are a train-harness optimizer for MazeBenchEngine.

Goal: implement ONE speed optimization without changing training behavior.

Idea to implement (do this idea only, nothing else):
${spec.idea}

Label: ${spec.label}
Iteration: ${spec.iteration}
Slot: ${spec.slot}

You start from the current MASTER tree. It already includes every previously confirmed speedup. Stack this idea on top of that master — do not revert earlier wins.

Hard rules:
- Keep PPO math, action mask, env.step semantics, rewards, and observation layout identical.
- Edit only train files if possible: public/train-ppo-webgpu.js, public/train-env.js, public/train-profile.js, public/train-worker.js, scripts/train-harness-node.js, scripts/webgpu-node.js.
- Do not commit, push, merge, or restart server.js.
- Do not change tests to match a broken env.
- The orchestrator will copy your files into master only if tests pass and exclusive fps beats the current master.

Required steps (do these in order, do not wander):
1. Read only public/train-ppo-webgpu.js and scripts/train-harness-node.js. Do not read maze-engine.js, origin/main, or unrelated tests.
2. Implement the idea immediately (search_replace). Do not spend turns surveying.
3. Run: node tests/train-harness.test.js && node tests/train-moves.test.js
4. If tests fail, fix or revert. Do not bench a failing change.
5. Score with the exclusive GPU lock:
   node scripts/train-opt.js bench --label ${spec.label} --iteration ${spec.iteration} --slot ${spec.slot} --envs ${spec.envs} --steps ${spec.steps} --idea ${JSON.stringify(spec.idea)}

Return a short report: files changed, exclusive fps, readF32/frame, vs master.
`;
}

function surveyPrompt(spec) {
  return `Survey the MazeBench WebGPU PPO harness and propose ${spec.width} concrete, disjoint speed optimizations.

Read these with tools before answering:
- public/train-ppo-webgpu.js (especially readF32, actBatch, forwardBatch, update)
- scripts/train-harness-node.js
- outputs/train-opt/status.md if it exists
- any outputs/webgpu-train/profile-*.json

The comparable score is exclusive Dawn fps under a GPU lock (node scripts/train-opt.js bench). Parallel agents will implement ideas at once; benches serialize on the lock.

Propose ${spec.width} ideas that different agents can implement independently. Prefer hiding mapAsync, keeping tensors on GPU, batching, or reducing dispatches. Do not propose env-rule changes.

Return JSON with key ideas: array of ${spec.width} short strings.
`;
}

function spawnProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MAZEBENCH_TRAIN_OPT_DIR: options.optDir }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (options.onData) options.onData(String(chunk), "stdout");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (options.onData) options.onData(String(chunk), "stderr");
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: String(error) }));
  });
}

function slotDirFor(optDir, label, cwd) {
  if (cwd && fs.existsSync(path.join(cwd, "public", "train-ppo-webgpu.js"))) return cwd;
  const named = path.join(optDir, "worktrees", label);
  if (fs.existsSync(named)) return named;
  return cwd;
}

async function promoteBest(flags) {
  const optDir = optDirFrom(flags);
  const srcRoot = flags.cwd ? path.resolve(String(flags.cwd)) : store.mainRepoRoot();
  const minDelta = num(flags["min-delta"], 0.02);
  const iteration = flags.iteration != null ? num(flags.iteration, null) : null;
  const entries = store.readJsonl(store.jsonlPath(optDir));
  const masterFps = master.currentMasterFps(optDir);
  const picked = master.pickWinner(entries, {
    iteration,
    label: flags.label ? String(flags.label) : undefined,
    masterFps,
    minDelta
  });
  if (!picked.ok) {
    console.log(`master unchanged: ${picked.reason}`);
    store.writeStatus(optDir, { gpu: inspectLock(optDir) });
    return picked;
  }
  const fromDir = slotDirFor(optDir, picked.best.label, picked.best.cwd);
  const changed = master.changedTrainFiles(fromDir, srcRoot);
  if (!changed.length) {
    console.log(`master already has ${picked.best.label} files`);
    const current = master.readMaster(optDir) || {};
    master.writeMaster(optDir, {
      ...current,
      label: `master-${picked.best.label}`,
      from: picked.best.label,
      fps: picked.best.fps,
      idea: picked.best.idea,
      files: [],
      updatedAt: new Date().toISOString()
    });
    store.writeStatus(optDir, { gpu: inspectLock(optDir) });
    return { ok: true, skipped: true, best: picked.best, copied: [] };
  }
  const backup = master.backupTrainFiles(srcRoot, changed);
  const copied = master.copyTrainFiles(fromDir, srcRoot, changed);
  const tests = runVerify(srcRoot);
  if (!tests.ok) {
    master.restoreTrainFiles(srcRoot, backup);
    console.log(`reverted ${picked.best.label}: tests failed after integrate`);
    return { ok: false, reason: "tests failed after integrate", tests, best: picked.best };
  }
  const bench = await exclusiveBench({
    ...flags,
    label: `master-${picked.best.label}`,
    idea: `integrated ${picked.best.label}: ${picked.best.idea || ""}`,
    iteration: picked.best.iteration,
    slot: "master",
    cwd: srcRoot,
    verify: false
  });
  const prev = master.readMaster(optDir);
  const prevFps = Number.isFinite(masterFps) ? masterFps : prev && prev.fps;
  if (Number.isFinite(prevFps) && bench.entry.fps + 1e-9 < prevFps) {
    master.restoreTrainFiles(srcRoot, backup);
    console.log(
      `reverted ${picked.best.label}: integrate re-bench ${bench.entry.fps.toFixed(1)} fps is below previous master ${prevFps.toFixed(1)}`
    );
    store.writeStatus(optDir, { gpu: inspectLock(optDir) });
    return {
      ok: false,
      reason: `integrate re-bench ${bench.entry.fps.toFixed(1)} below master ${prevFps.toFixed(1)}`,
      tests,
      bench,
      best: picked.best
    };
  }
  const nextMaster = {
    label: `master-${picked.best.label}`,
    from: picked.best.label,
    fps: bench.entry.fps,
    idea: picked.best.idea,
    files: copied,
    candidateFps: picked.best.fps,
    history: [...((prev && prev.history) || []), prev ? { label: prev.label, fps: prev.fps, from: prev.from } : null].filter(
      Boolean
    ),
    updatedAt: new Date().toISOString()
  };
  master.writeMaster(optDir, nextMaster);
  store.writeStatus(optDir, { gpu: inspectLock(optDir) });
  console.log(`master <- ${picked.best.label}  ${bench.entry.fps.toFixed(1)} fps  files ${copied.join(", ")}`);
  return { ok: true, best: picked.best, copied, bench, master: nextMaster };
}

async function cmdRun(flags) {
  const optDir = optDirFrom(flags);
  const srcRoot = store.mainRepoRoot();
  const iterations = Math.max(1, Math.min(8, num(flags.iterations, 3)));
  const width = Math.max(1, Math.min(8, num(flags.width, 2)));
  const effort = String(flags.effort || "low");
  const envs = Math.max(1, num(flags.envs, 1));
  const steps = Math.max(1, num(flags.steps, 50));
  const ideasArg = flags.ideas ? String(flags.ideas).split("||").map((s) => s.trim()).filter(Boolean) : [];
  fs.mkdirSync(path.join(optDir, "prompts"), { recursive: true });

  if (!flags["skip-baseline"]) {
    console.log("recording exclusive baseline...");
    printBench(
      await exclusiveBench({
        ...flags,
        label: "baseline",
        idea: "unmodified harness",
        iteration: 0,
        slot: 0,
        cwd: srcRoot,
        verify: false
      })
    );
  }

  let ideas = ideasArg.slice();
  if (!ideas.length) {
    ideas = [
      "Overlap the remaining packed actBatch mapAsync with env.step using double staging buffers — do not change PPO math",
      "Move PPO update bias reductions onto the GPU so update() does not readF32 dH1/dH2 back to JS",
      "Keep the last-value forward on GPU and reuse the packed act buffer instead of an extra forwardBatch readback",
      "Fuse remaining matmul/bias/relu in update into fewer GPU dispatches (still identical Adam)",
      "Cache/reuse GPU bind groups and skip per-act uniform buffer create/destroy",
      "Write embeddings on GPU from a uint8 grid buffer to cut packBatch CPU and writeBuffer traffic"
    ];
    while (ideas.length < width) ideas.push(`Cut GPU queue submits and mapAsync in PPO collect/update without changing math (variant ${ideas.length + 1})`);
  }

  if (!master.readMaster(optDir)) {
    const seedFps = master.currentMasterFps(optDir);
    master.writeMaster(optDir, {
      label: "master-baseline",
      from: "baseline",
      fps: seedFps,
      files: [],
      history: [],
      updatedAt: new Date().toISOString()
    });
  }

  const runMeta = { iterations, width, envs, steps, state: "running", startedAt: new Date().toISOString() };
  store.writeRunState(optDir, { ...runMeta, iteration: 0 });
  store.writeStatus(optDir, { gpu: inspectLock(optDir), run: { ...runMeta, iteration: 0 } });

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    console.log(`\n=== iteration ${iteration}/${iterations} width ${width} ===`);
    store.writeRunState(optDir, { ...runMeta, iteration });
    store.writeStatus(optDir, { gpu: inspectLock(optDir), run: { ...runMeta, iteration } });
    const jobs = [];
    for (let slot = 0; slot < width; slot += 1) {
      const idea = ideas[((iteration - 1) * width + slot) % ideas.length];
      const label = `i${iteration}s${slot}`;
      const slotDir = createSlot(optDir, label, srcRoot);
      const prompt = implementerPrompt({ idea, label, iteration, slot, envs, steps });
      const promptFile = path.join(optDir, "prompts", `${label}.txt`);
      fs.writeFileSync(promptFile, prompt);
      const logFile = path.join(optDir, "prompts", `${label}.log`);
      console.log(`spawn ${label}: ${idea}`);
      jobs.push(
        spawnProcess(
          grokBin(),
          [
            "--prompt-file",
            promptFile,
            "--yolo",
            "--cwd",
            slotDir,
            "--max-turns",
            "20",
            "--effort",
            effort,
            "--no-subagents"
          ],
          {
          cwd: slotDir,
          optDir,
          onData: (chunk) => fs.appendFileSync(logFile, chunk)
        }).then((result) => {
          fs.appendFileSync(logFile, `\n[exit ${result.code}]\n`);
          console.log(`${label} exited ${result.code}`);
          return { label, idea, slotDir, ...result };
        })
      );
    }
    await Promise.all(jobs);
    console.log(`promoting confirmed winner of iteration ${iteration} into master...`);
    const promoted = await promoteBest({
      ...flags,
      iteration,
      cwd: srcRoot,
      envs,
      steps
    });
    if (promoted.ok && promoted.master) {
      runMeta.master = promoted.master.label;
      console.log(`next wave starts from ${promoted.master.label} at ${promoted.master.fps.toFixed(1)} fps`);
    } else {
      console.log(promoted.reason || "no promotion this iteration");
    }
    store.writeRunState(optDir, { ...runMeta, iteration });
    const status = store.writeStatus(optDir, { gpu: inspectLock(optDir), run: { ...runMeta, iteration } });
    console.log(store.renderStatusMd(status));
  }

  runMeta.state = "done";
  runMeta.finishedAt = new Date().toISOString();
  store.writeRunState(optDir, { ...runMeta, iteration: iterations });
  const finalStatus = store.writeStatus(optDir, { gpu: inspectLock(optDir), run: { ...runMeta, iteration: iterations } });
  console.log("run complete");
  console.log(store.renderStatusMd(finalStatus));
  return finalStatus;
}

function cmdWatch(flags) {
  const optDir = optDirFrom(flags);
  const file = store.statusJsonPath(optDir);
  let last = "";
  const tick = () => {
    store.writeStatus(optDir, { gpu: inspectLock(optDir) });
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(store.statusMdPath(optDir), "utf8");
    if (text !== last) {
      last = text;
      console.log(text);
      console.log("---");
    }
  };
  tick();
  const timer = setInterval(tick, num(flags.ms, 5000));
  if (flags.once) {
    clearInterval(timer);
    return;
  }
  return timer;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const cmd = flags._[0] || "status";
  if (cmd === "baseline") {
    const result = await exclusiveBench({ ...flags, label: "baseline", idea: flags.idea || "unmodified harness" });
    printBench(result);
  } else if (cmd === "bench") {
    const result = await exclusiveBench(flags);
    printBench(result);
  } else if (cmd === "status") {
    cmdStatus(flags);
  } else if (cmd === "watch") {
    cmdWatch(flags);
    if (flags.once) return;
    await new Promise(() => {});
  } else if (cmd === "run") {
    await cmdRun(flags);
  } else if (cmd === "promote") {
    const promoted = await promoteBest(flags);
    if (!promoted.ok) process.exitCode = 2;
  } else if (cmd === "lock") {
    console.log(JSON.stringify(inspectLock(optDirFrom(flags)), null, 2));
  } else {
    console.error("Usage: node scripts/train-opt.js <baseline|bench|status|watch|run|promote|lock> [flags]");
    process.exitCode = 1;
    return;
  }
  process.exit(0);
}

module.exports = {
  cmdStatus,
  createSlot,
  exclusiveBench,
  grokBin,
  implementerPrompt,
  overlayDirtyFiles,
  parseArgs,
  promoteBest,
  surveyPrompt
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
  });
}
