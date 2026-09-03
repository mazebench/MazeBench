"use strict";

let installed = null;

// Dawn-node compiles WGSL through FXC (no DXC in this build) while Chrome uses
// DXC, so a plain Dawn device runs the mega kernel far slower than the /train
// page does. These toggles strip the FXC-side robustness/validation overhead
// and land the bench within a few percent of measured browser throughput
// (403k vs 406k tps on the 4-env salo collect, RX 9070 XT), so they are on by
// default. MAZEBENCH_WEBGPU_SAFE=1 restores a plain device;
// MAZEBENCH_WEBGPU_FLAGS overrides everything (";"-separated so one flag can
// hold a comma list).
const FAST_TOGGLES = "allow_unsafe_apis,disable_robustness,skip_validation,disable_workgroup_init";

function defaultFlags() {
  if (process.env.MAZEBENCH_WEBGPU_FLAGS) {
    const sep = process.env.MAZEBENCH_WEBGPU_FLAGS.includes(";") ? ";" : ",";
    return process.env.MAZEBENCH_WEBGPU_FLAGS.split(sep).map((flag) => flag.trim()).filter(Boolean);
  }
  const flags = [];
  if (process.platform === "win32") flags.push("backend=d3d12");
  if (!process.env.MAZEBENCH_WEBGPU_SAFE) flags.push(`enable-dawn-features=${FAST_TOGGLES}`);
  return flags;
}

async function installWebGpu(flags = defaultFlags()) {
  if (installed) return installed;
  const { create, globals } = await import("webgpu");
  Object.assign(globalThis, globals);
  const gpu = create(flags);
  globalThis.window = globalThis.window || globalThis;
  globalThis.self = globalThis.self || globalThis;
  try {
    globalThis.navigator.gpu = gpu;
  } catch (_error) {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu }
    });
  }
  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    throw new Error(`No WebGPU adapter (flags=${flags.join(",") || "default"})`);
  }
  const info = adapter.info || {};
  installed = {
    gpu,
    adapter,
    info: {
      vendor: info.vendor || "",
      architecture: info.architecture || "",
      device: info.device || "",
      description: info.description || ""
    }
  };
  return installed;
}

function adapterLabel(info) {
  return [info.device, info.architecture, info.vendor, info.description].filter(Boolean).join(" · ");
}

module.exports = { adapterLabel, defaultFlags, installWebGpu };
