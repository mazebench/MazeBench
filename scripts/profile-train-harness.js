#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT_DIR = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const options = { envs: 1, steps: [1], timeoutMs: 300000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--envs") options.envs = Math.max(1, Number(next()) || 1);
    else if (arg === "--steps") {
      options.steps = String(next() || "1")
        .split(",")
        .map((value) => Math.max(1, Number(value) || 1));
    } else if (arg === "--timeout-ms") options.timeoutMs = Math.max(1000, Number(next()) || 180000);
  }
  return options;
}

function pick(profile, path) {
  return profile.find((row) => row.path === path) || null;
}

function summarize(result, steps, envs) {
  const profile = result.profile || [];
  const ms = (path) => pick(profile, path)?.inclusiveMs || 0;
  const count = (path) => pick(profile, path)?.count || 0;
  const collectMs = ms("collect");
  const updateMs = ms("ppo.update");
  const actMs = ms("collect/collect.act");
  const envMs = ms("collect/collect.envStep/env.step");
  const readMs = profile
    .filter((row) => row.path.endsWith("ppo.readF32") && row.depth > 0)
    .reduce((sum, row) => sum + row.exclusiveMs, 0);
  const frames = envs * steps;
  const finite =
    Number.isFinite(result.metrics?.policyLoss) &&
    Number.isFinite(result.metrics?.valueLoss) &&
    Number.isFinite(result.metrics?.entropy);
  return {
    steps,
    frames,
    ok: Boolean(finite && result.metrics?.frames === frames),
    seconds: Number(result.metrics?.seconds || 0),
    fps: Number(result.metrics?.fps || 0),
    initMs: ms("ppo.init"),
    collectMs,
    updateMs,
    actMs,
    envMs,
    readMs,
    actCount: count("collect/collect.act"),
    envCount: count("collect/collect.envStep/env.step") || count("env.step"),
    policyLoss: result.metrics?.policyLoss,
    valueLoss: result.metrics?.valueLoss,
    entropy: result.metrics?.entropy,
    adapter: result.metrics?.adapter
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    server.on("error", reject);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function launchBrowser(chromium) {
  const attempts = [
    { channel: "msedge" },
    { channel: "chrome" },
    { executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" },
    { executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
    {}
  ];
  const args = [
    "--enable-unsafe-webgpu",
    "--enable-webgpu-developer-features",
    "--ignore-gpu-blocklist",
    "--disable-gpu-sandbox"
  ];
  let lastError = null;
  for (const headed of [true, false]) {
    for (const attempt of attempts) {
      if (attempt.executablePath && !fs.existsSync(attempt.executablePath)) continue;
      try {
        return await chromium.launch({
          ...attempt,
          args,
          headless: headed ? false : true
        });
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError || new Error("Could not launch Chrome/Edge");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { createRequestHandler } = require(path.join(ROOT_DIR, "server", "app"));
  const server = http.createServer(createRequestHandler());
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  const playwrightCore = path.join(ROOT_DIR, "node_modules", "playwright-core");
  if (!fs.existsSync(playwrightCore)) {
    throw new Error("playwright-core is not installed");
  }
  const { chromium } = await import(pathToFileURL(path.join(playwrightCore, "index.mjs")).href);
  const browser = await launchBrowser(chromium);
  const page = await browser.newPage();
  page.setDefaultTimeout(options.timeoutMs);
  try {
    await page.goto(`${origin}/train`, { waitUntil: "domcontentloaded" });
    const gpuOk = await page.evaluate(() => Boolean(navigator.gpu));
    if (!gpuOk) throw new Error("navigator.gpu is missing");

    const outDir = path.join(ROOT_DIR, "outputs", "webgpu-train");
    fs.mkdirSync(outDir, { recursive: true });
    const summaries = [];

    for (const steps of options.steps) {
      const maxActions = Math.max(steps + 32, 64);
      const timeoutMs = Math.max(options.timeoutMs, 15000 + steps * 250);
      process.stdout.write(`\n=== ${options.envs} env × ${steps} step ===\n`);
      const result = await page.evaluate(async ({ envs, steps, maxActions, timeoutMs }) => {
        const boot = await fetch("/api/train/local/bootstrap").then((response) => {
          if (!response.ok) throw new Error("bootstrap failed");
          return response.json();
        });
        return await new Promise((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error("profile timed out")), timeoutMs);
          const worker = new Worker("/train-worker.js");
          worker.onmessage = (event) => {
            const message = event.data || {};
            if (message.type === "profile") {
              window.clearTimeout(timer);
              worker.terminate();
              resolve(message);
            }
            if (message.type === "error") {
              window.clearTimeout(timer);
              worker.terminate();
              reject(new Error(message.error || "worker error"));
            }
          };
          worker.onerror = (error) => {
            window.clearTimeout(timer);
            reject(new Error(error.message || "worker failed"));
          };
          worker.postMessage({
            type: "profile",
            config: {
              levelId: boot.environment.default_level_id,
              nEnvs: envs,
              numSteps: steps,
              updates: 1,
              maxActions,
              gemWeight: 1,
              roomWeight: 0.1,
              pushWeight: 0.05,
              noveltyBonus: 0.01,
              seed: 1
            },
            startPlayData: boot.playData
          });
        });
      }, { envs: options.envs, steps, maxActions, timeoutMs });

      const summary = summarize(result, steps, options.envs);
      if (!summary.ok) {
        throw new Error(
          `${steps}-step harness failed: frames=${result.metrics?.frames} expected=${summary.frames} losses=${summary.policyLoss}/${summary.valueLoss}`
        );
      }
      summaries.push({ steps, summary, profileText: result.profileText, result });
      fs.writeFileSync(
        path.join(outDir, `profile-${steps}step.json`),
        `${JSON.stringify(result, null, 2)}\n`
      );
      console.log(`adapter: ${summary.adapter}`);
      console.log(
        `ok frames=${summary.frames} seconds=${summary.seconds.toFixed(3)} fps=${summary.fps.toFixed(1)} ` +
          `policyLoss=${Number(summary.policyLoss).toFixed(4)} entropy=${Number(summary.entropy).toFixed(3)}`
      );
      console.log("");
      console.log(result.profileText);
    }

    const jsonPath = path.join(outDir, "profile-last.json");
    fs.writeFileSync(jsonPath, `${JSON.stringify(summaries.map((item) => item.summary), null, 2)}\n`);
    if (summaries.length > 1) {
      console.log("\n=== scaling ===");
      console.log(
        "steps  frames  seconds   fps  collect_ms  update_ms  act_ms  env_ms  read_ms"
      );
      summaries.forEach(({ summary }) => {
        console.log(
          `${String(summary.steps).padStart(5)}  ${String(summary.frames).padStart(6)}  ${summary.seconds
            .toFixed(3)
            .padStart(7)}  ${summary.fps.toFixed(1).padStart(5)}  ${summary.collectMs
            .toFixed(1)
            .padStart(10)}  ${summary.updateMs.toFixed(1).padStart(9)}  ${summary.actMs
            .toFixed(1)
            .padStart(6)}  ${summary.envMs.toFixed(1).padStart(6)}  ${summary.readMs.toFixed(1).padStart(7)}`
        );
      });
    }
    console.log(`\nwrote ${jsonPath}`);
  } finally {
    await browser.close().catch(() => {});
    await closeServer(server);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
