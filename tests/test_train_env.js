const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "train-env.js"), "utf8");
const sandbox = { window: {}, self: {} };
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.runInNewContext(source, sandbox);

const { screenMoveVector, encodeAux, AUX_DIM, N_ACTIONS, ACTIONS } = sandbox.TrainEnv;
assert.equal(N_ACTIONS, 10);
assert.equal(ACTIONS.length, 10);
assert.equal(screenMoveVector("U", 0).dx, 0);
assert.equal(screenMoveVector("U", 0).dy, -1);
assert.equal(screenMoveVector("U", 2).dx, 0);
assert.equal(screenMoveVector("U", 2).dy, 1);
const aux = encodeAux(
  {
    yaw: 3,
    pitch: 4,
    playerDead: true,
    gemCount: 9,
    visited: ["a", "b"],
    actionCount: 64,
    novelPushCount: 10,
    moved: true
  },
  128
);
assert.equal(aux.length, AUX_DIM);
assert.equal(aux[2], 1);
assert.equal(aux[7], 1);

const profileSource = fs.readFileSync(path.join(__dirname, "..", "public", "train-profile.js"), "utf8");
const profileSandbox = { window: {}, self: {}, performance: { now: () => 1 } };
profileSandbox.window = profileSandbox;
profileSandbox.self = profileSandbox;
let t = 0;
profileSandbox.performance.now = () => {
  t += 5;
  return t;
};
vm.runInNewContext(profileSource, profileSandbox);
const profiler = profileSandbox.TrainProfile.createProfiler();
profiler.begin("root");
profiler.begin("child");
profiler.end();
profiler.end();
const rows = profiler.report();
assert.equal(rows[0].path, "root");
assert.ok(rows.some((row) => row.path === "root/child"));

const ppoSource = fs.readFileSync(path.join(__dirname, "..", "public", "train-ppo-webgpu.js"), "utf8");
const ppoSandbox = { window: {}, self: {}, navigator: {} };
ppoSandbox.window = ppoSandbox;
ppoSandbox.self = ppoSandbox;
vm.runInNewContext(ppoSource, ppoSandbox);
const { computeGae, softmax, maskedLogits } = ppoSandbox.TrainPpo;
const probs = softmax(new Float32Array([1, 1, 1, 1]));
assert.ok(Math.abs(probs.reduce((sum, value) => sum + value, 0) - 1) < 1e-5);
const masked = maskedLogits(new Float32Array([0, 0, 0]), [true, false, true]);
assert.equal(masked[1], -1e9);
const gae = computeGae([[0.1, 0]], [[0, 0]], [[false, true]], [0, 0], 0.99, 0.95);
assert.equal(gae.advantages.length, 1);

const { createLocalTrainStore } = require("../server/train-local");
const os = require("node:os");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-webgpu-train-"));
const store = createLocalTrainStore(dir);
const run = store.createRun({ name: "test", adapter: "webgpu" });
assert.match(run.id, /^webgpu-/);
store.appendJsonl(run.id, "episodes.jsonl", { reward: 0.2, gems: 0 });
store.appendJsonl(run.id, "metrics.jsonl", { rewardMean: 0.4, fps: 120, gemsMean: 1.5, entropy: 2.2 });
store.appendJsonl(run.id, "metrics.jsonl", { rewardMean: 0.9, fps: 80, gemsMean: 2, entropy: 2.1 });
const loaded = store.getRun(run.id);
assert.equal(loaded.episodes.length, 1);
assert.equal(loaded.episodes[0].reward, 0.2);
const listed = store.listRuns();
assert.equal(listed[0].bestReward, 0.9);
assert.equal(listed[0].lastFps, 80);
assert.equal(listed[0].lastGems, 2);
fs.rmSync(dir, { recursive: true, force: true });

console.log("train env/ppo/store tests passed");
