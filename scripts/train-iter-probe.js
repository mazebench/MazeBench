#!/usr/bin/env node
"use strict";

const { installWebGpu } = require("./webgpu-node");
const { loadTrainHarness } = require("./load-train-harness");
const { startPlayData } = require("./train-harness-node");
const { withGpuLock } = require("./train-opt-lock");
const store = require("./train-opt-store");

async function time(n, fn) {
  for (let i = 0; i < 10; i += 1) await fn();
  const t0 = performance.now();
  for (let i = 0; i < n; i += 1) await fn();
  const ms = performance.now() - t0;
  return { ms, us: (1000 * ms) / n, fps: (1000 * n) / ms };
}

async function main() {
  const gpu = await installWebGpu();
  const { TrainPpo } = loadTrainHarness();
  const ppo = new TrainPpo.WebGpuPpo();
  await ppo.init(1);
  const { playData, levelId } = startPlayData();
  const { TrainEnv } = loadTrainHarness();
  const { getGame, getLevel, getLevelState } = require("../server/app");
  const env = new TrainEnv.MazeTrainEnv({
    playCache: new Map([[levelId, playData]]),
    fetchPlayData: async (id) => getLevelState(getGame("maze"), getLevel(getGame("maze"), id)),
    startLevelId: levelId,
    maxActions: 256
  });
  await env.reset();
  const obs = env.snapshot({ moved: false });
  const scratch = ppo.scratchFor(1);
  ppo.packBatch([obs], scratch.xHost);
  ppo.device.queue.writeBuffer(scratch.x, 0, scratch.xHost);
  ppo.fillActInputs(scratch, [obs]);

  const bytes = ppo.bufferSize(13 * 4);
  const stagingA = ppo.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const stagingB = ppo.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const stagingC = ppo.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const tiny = ppo.device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const src = scratch.packed;

  const emptyPipeline = ppo.device.createComputePipeline({
    layout: "auto",
    compute: {
      module: ppo.device.createShaderModule({
        code: `@compute @workgroup_size(256) fn main() {}`
      }),
      entryPoint: "main"
    }
  });
  const emptyBind = emptyPipeline.getBindGroupLayout(0);
  await withGpuLock(store.defaultOptDir(), async () => {
    const n = 300;
    const empty = await time(n, async () => {
      const encoder = ppo.device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(emptyPipeline);
      pass.dispatchWorkgroups(1);
      pass.end();
      ppo.device.queue.submit([encoder.finish()]);
      await ppo.device.queue.onSubmittedWorkDone();
    });
    const fused = await time(n, async () => {
      const encoder = ppo.device.createCommandEncoder();
      ppo.encodeFusedAct(encoder, scratch, 1);
      ppo.device.queue.submit([encoder.finish()]);
      await ppo.device.queue.onSubmittedWorkDone();
    });
    const copyMap = await time(n, async () => {
      const encoder = ppo.device.createCommandEncoder();
      encoder.copyBufferToBuffer(src, 0, stagingA, 0, bytes);
      ppo.device.queue.submit([encoder.finish()]);
      await stagingA.mapAsync(GPUMapMode.READ);
      stagingA.unmap();
    });
    const fusedMap = await time(n, async () => {
      const encoder = ppo.device.createCommandEncoder();
      ppo.encodeFusedAct(encoder, scratch, 1);
      encoder.copyBufferToBuffer(src, 0, stagingA, 0, bytes);
      ppo.device.queue.submit([encoder.finish()]);
      await stagingA.mapAsync(GPUMapMode.READ);
      const mapped = new Float32Array(stagingA.getMappedRange());
      scratch.packedHost.set(mapped.subarray(0, 13));
      stagingA.unmap();
    });
    const fusedMapTiny = await time(n, async () => {
      const encoder = ppo.device.createCommandEncoder();
      ppo.encodeFusedAct(encoder, scratch, 1);
      encoder.copyBufferToBuffer(src, 0, tiny, 0, 16);
      ppo.device.queue.submit([encoder.finish()]);
      await tiny.mapAsync(GPUMapMode.READ);
      const mapped = new Float32Array(tiny.getMappedRange());
      scratch.packedHost[0] = mapped[0];
      tiny.unmap();
    });
    let ring = 0;
    const bufs = [stagingA, stagingB, stagingC];
    const fusedRing = await time(n, async () => {
      const staging = bufs[ring];
      ring = (ring + 1) % 3;
      const encoder = ppo.device.createCommandEncoder();
      ppo.encodeFusedAct(encoder, scratch, 1);
      encoder.copyBufferToBuffer(src, 0, staging, 0, bytes);
      ppo.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      staging.unmap();
    });
    const actBatch = await time(n, async () => {
      await ppo.actBatch([obs]);
    });
    const envStep = await time(n, async () => {
      await env.step(0);
    });

    function row(name, r) {
      console.log(`${name.padEnd(16)}  ${r.us.toFixed(1)} us/iter  ${r.fps.toFixed(0)} fps  (${r.ms.toFixed(1)} ms / ${n})`);
    }
    row("empty+wait", empty);
    row("fused+wait", fused);
    row("copy+map", copyMap);
    row("fused+map", fusedMap);
    row("fused+map 16B", fusedMapTiny);
    row("fused+ring3", fusedRing);
    row("actBatch", actBatch);
    row("env.step(0)", envStep);
  });
  process.exit(0);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
