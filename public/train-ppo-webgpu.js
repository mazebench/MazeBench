(() => {
  const GRID = 16;
  const CELL_TYPES = 24;
  const EMBED = 8;
  const AUX_DIM = 8;
  const INPUT = GRID * GRID * EMBED + AUX_DIM;
  const H1 = 256;
  const H2 = 128;
  const N_ACTIONS = 10;
  const OUT = N_ACTIONS + 1;
  // packed per env: action, logp, value, masked logits[N_ACTIONS]
  const PACKED = 3 + N_ACTIONS;

  const MATMUL_SHADER = /* wgsl */ `
struct Dims { M: u32, K: u32, N: u32, transposeA: u32, transposeB: u32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> A: array<f32>;
@group(0) @binding(1) var<storage, read> B: array<f32>;
@group(0) @binding(2) var<storage, read_write> C: array<f32>;
@group(0) @binding(3) var<uniform> dims: Dims;

fn aAt(m: u32, k: u32) -> f32 {
  if (dims.transposeA == 1u) {
    return A[k * dims.M + m];
  }
  return A[m * dims.K + k];
}

fn bAt(k: u32, n: u32) -> f32 {
  if (dims.transposeB == 1u) {
    return B[n * dims.K + k];
  }
  return B[k * dims.N + n];
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let m = gid.x;
  let n = gid.y;
  if (m >= dims.M || n >= dims.N) { return; }
  var acc = 0.0;
  for (var k: u32 = 0u; k < dims.K; k = k + 1u) {
    acc = acc + aAt(m, k) * bAt(k, n);
  }
  C[m * dims.N + n] = acc;
}
`;

  const BIAS_RELU_SHADER = /* wgsl */ `
struct Dims { rows: u32, cols: u32, relu: u32, pad: u32 }
@group(0) @binding(0) var<storage, read_write> values: array<f32>;
@group(0) @binding(1) var<storage, read> bias: array<f32>;
@group(0) @binding(2) var<uniform> dims: Dims;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  let count = dims.rows * dims.cols;
  if (i >= count) { return; }
  let col = i % dims.cols;
  var v = values[i] + bias[col];
  if (dims.relu == 1u && v < 0.0) { v = 0.0; }
  values[i] = v;
}
`;

  const RELU_MASK_SHADER = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> grad: array<f32>;
@group(0) @binding(1) var<storage, read> hidden: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&grad)) { return; }
  if (hidden[i] <= 0.0) { grad[i] = 0.0; }
}
`;

  const COLSUM_SHADER = /* wgsl */ `
struct Dims { rows: u32, cols: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<storage, read> matrix: array<f32>;
@group(0) @binding(1) var<storage, read_write> sums: array<f32>;
@group(0) @binding(2) var<uniform> dims: Dims;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = gid.x;
  if (c >= dims.cols) { return; }
  var acc = 0.0;
  for (var r: u32 = 0u; r < dims.rows; r = r + 1u) {
    acc = acc + matrix[r * dims.cols + c];
  }
  sums[c] = acc;
}
`;

  const ADAM_SHADER = /* wgsl */ `
struct Adam { lr: f32, beta1: f32, beta2: f32, eps: f32, t: f32, pad0: f32, pad1: f32, pad2: f32 }
@group(0) @binding(0) var<storage, read_write> param: array<f32>;
@group(0) @binding(1) var<storage, read> grad: array<f32>;
@group(0) @binding(2) var<storage, read_write> m: array<f32>;
@group(0) @binding(3) var<storage, read_write> v: array<f32>;
@group(0) @binding(4) var<uniform> adam: Adam;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&param)) { return; }
  let g = grad[i];
  let m1 = adam.beta1 * m[i] + (1.0 - adam.beta1) * g;
  let v1 = adam.beta2 * v[i] + (1.0 - adam.beta2) * g * g;
  m[i] = m1;
  v[i] = v1;
  let mhat = m1 / (1.0 - pow(adam.beta1, adam.t));
  let vhat = v1 / (1.0 - pow(adam.beta2, adam.t));
  param[i] = param[i] - adam.lr * mhat / (sqrt(vhat) + adam.eps);
}
`;

  const SAMPLE_SHADER = /* wgsl */ `
struct Dims { batch: u32, nActions: u32, outStride: u32, packedStride: u32 }
@group(0) @binding(0) var<storage, read> y: array<f32>;
@group(0) @binding(1) var<storage, read> mask: array<f32>;
@group(0) @binding(2) var<storage, read> u: array<f32>;
@group(0) @binding(3) var<storage, read_write> packed: array<f32>;
@group(0) @binding(4) var<uniform> dims: Dims;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let b = gid.x;
  if (b >= dims.batch) { return; }
  let nActions = dims.nActions;
  let yBase = b * dims.outStride;
  let maskBase = b * nActions;
  let packBase = b * dims.packedStride;
  var maxv = -1e30;
  for (var a: u32 = 0u; a < nActions; a = a + 1u) {
    var logit = y[yBase + a];
    if (mask[maskBase + a] == 0.0) { logit = -1e9; }
    packed[packBase + 3u + a] = logit;
    if (logit > maxv) { maxv = logit; }
  }
  var sum = 0.0;
  for (var a: u32 = 0u; a < nActions; a = a + 1u) {
    sum = sum + exp(packed[packBase + 3u + a] - maxv);
  }
  var cursor = u[b];
  var action = nActions - 1u;
  var chosen = false;
  var chosenProb = 0.0;
  for (var a: u32 = 0u; a < nActions; a = a + 1u) {
    let p = exp(packed[packBase + 3u + a] - maxv) / sum;
    cursor = cursor - p;
    if (!chosen && cursor <= 0.0) {
      action = a;
      chosenProb = p;
      chosen = true;
    }
  }
  if (!chosen) { chosenProb = exp(packed[packBase + 3u + action] - maxv) / sum; }
  packed[packBase + 0u] = f32(action);
  packed[packBase + 1u] = log(max(chosenProb, 1e-8));
  packed[packBase + 2u] = y[yBase + nActions];
}
`;

  const BIAS_PACK = H1 + H2 + OUT;
  const FUSED_ACT_SHADER = /* wgsl */ `
struct Dims { batch: u32, nActions: u32, outStride: u32, packedStride: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> W1: array<f32>;
@group(0) @binding(2) var<storage, read> W2: array<f32>;
@group(0) @binding(3) var<storage, read> W3: array<f32>;
@group(0) @binding(4) var<storage, read> bias: array<f32>;
@group(0) @binding(5) var<storage, read_write> packed: array<f32>;
@group(0) @binding(6) var<uniform> dims: Dims;

const INPUT = ${INPUT}u;
const H1 = ${H1}u;
const H2 = ${H2}u;
const OUT = ${OUT}u;

var<workgroup> h1s: array<f32, ${H1}>;
var<workgroup> h2s: array<f32, ${H2}>;
var<workgroup> ys: array<f32, 16>;

@compute @workgroup_size(${H1})
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let t = lid.x;

  var acc = 0.0;
  let xBase = b * INPUT;
  for (var k: u32 = 0u; k < INPUT; k = k + 1u) {
    acc = acc + x[xBase + k] * W1[k * H1 + t];
  }
  h1s[t] = max(acc + bias[t], 0.0);
  workgroupBarrier();

  if (t < H2) {
    var acc2 = 0.0;
    for (var k: u32 = 0u; k < H1; k = k + 1u) {
      acc2 = acc2 + h1s[k] * W2[k * H2 + t];
    }
    h2s[t] = max(acc2 + bias[H1 + t], 0.0);
  }
  workgroupBarrier();

  if (t < OUT) {
    var acc3 = 0.0;
    for (var k: u32 = 0u; k < H2; k = k + 1u) {
      acc3 = acc3 + h2s[k] * W3[k * OUT + t];
    }
    ys[t] = acc3 + bias[H1 + H2 + t];
  }
  workgroupBarrier();

  if (t != 0u) { return; }

  let nActions = dims.nActions;
  let maskBase = dims.batch * INPUT + b * nActions;
  let packBase = b * dims.packedStride;
  var maxv = -1e30;
  for (var a: u32 = 0u; a < nActions; a = a + 1u) {
    var logit = ys[a];
    if (x[maskBase + a] == 0.0) { logit = -1e9; }
    packed[packBase + 3u + a] = logit;
    if (logit > maxv) { maxv = logit; }
  }
  var sum = 0.0;
  for (var a: u32 = 0u; a < nActions; a = a + 1u) {
    sum = sum + exp(packed[packBase + 3u + a] - maxv);
  }
  var cursor = x[dims.batch * INPUT + dims.batch * nActions + b];
  var action = nActions - 1u;
  var chosen = false;
  var chosenProb = 0.0;
  for (var a: u32 = 0u; a < nActions; a = a + 1u) {
    let p = exp(packed[packBase + 3u + a] - maxv) / sum;
    cursor = cursor - p;
    if (!chosen && cursor <= 0.0) {
      action = a;
      chosenProb = p;
      chosen = true;
    }
  }
  if (!chosen) { chosenProb = exp(packed[packBase + 3u + action] - maxv) / sum; }
  packed[packBase + 0u] = f32(action);
  packed[packBase + 1u] = log(max(chosenProb, 1e-8));
  packed[packBase + 2u] = ys[nActions];
}
`;

  const ROLL_STRIDE = 5;
  const CELL_N = GRID * GRID;
  const ROLL_IN = CELL_N + AUX_DIM;
  const SALO_IN = ROLL_IN + CELL_N + CELL_N;
  const PEER_FLOATS = CELL_N + CELL_N;
  const ROLL_H = 32;
  // Rollout workgroup width. The policy net stays ROLL_H wide; the extra lanes
  // split every matmul column, the layer-1 diff scan, and the 256-cell bulk
  // loops, then combine through the pp scratch with a fixed reduce tree so the
  // result is identical on every run. 256 is the WebGPU baseline
  // maxComputeInvocationsPerWorkgroup, so the browser /train page always runs it.
  const ROLL_T = 256;
  const ROLL_LANES = ROLL_T / ROLL_H;
  const MAX_ACTORS = 64;
  const WORLD_W = 16;
  const WORLD_ROOMS = WORLD_W * WORLD_W;
  const ROOM_BIT_WORDS = 8;
  const B_OCC = 0;
  const B_TER = 256;
  const B_ACT = 512;
  const B_META = 640;
  const B_START_TER = 768;
  const B_START_ACT = 1024;
  const B_PREV_TER = 1280;
  const B_PREV_ACT = 1536;
  const B_GEM = 2048;
  const B_PUSH = B_GEM + WORLD_ROOMS * ROOM_BIT_WORDS;
  const B_SEEN = B_PUSH + WORLD_ROOMS * ROOM_BIT_WORDS;
  const BOARD_STRIDE = B_SEEN + WORLD_ROOMS * ROOM_BIT_WORDS;
  const WORLD_HEADER = WORLD_ROOMS;
  const ROOM_STRIDE = GRID * GRID * 2;
  const ROLL_W2 = ROLL_H * ROLL_H;
  const ROLL_W3 = ROLL_H * OUT;
  const PPO_SAMPLE_STRIDE = 8;
  function rollLayout(rin) {
    const w1 = rin * ROLL_H;
    return { rin, w1, w2: ROLL_W2, w3: ROLL_W3, wLen: w1 + ROLL_W2 + ROLL_W3 + ROLL_H + ROLL_H + OUT };
  }
  const VANILLA_LAYOUT = rollLayout(ROLL_IN);
  const SALO_LAYOUT = rollLayout(SALO_IN);
  const ROLL_W1 = VANILLA_LAYOUT.w1;
  const ROLL_W_LEN = VANILLA_LAYOUT.wLen;
  // Balanced fixed-shape reduce over the ROLL_LANES partial sums each lane
  // group leaves in pp[]; the tree shape never changes, so accumulation order
  // is deterministic.
  function ppReduceExpr(stride) {
    let terms = [];
    for (let i = 0; i < ROLL_LANES; i += 1) terms.push(i === 0 ? "pp[t]" : `pp[t + ${i * stride}u]`);
    while (terms.length > 1) {
      const next = [];
      for (let i = 0; i < terms.length; i += 2) next.push(`(${terms[i]} + ${terms[i + 1]})`);
      terms = next;
    }
    return terms[0];
  }
  function buildRollShader(salo, slopes) {
    const { rin, w1, w2, w3 } = salo ? SALO_LAYOUT : VANILLA_LAYOUT;
    const peerBind = salo
      ? `@group(0) @binding(7) var<storage, read> peer: array<f32>;
@group(0) @binding(8) var<storage, read> world: array<u32>;`
      : `@group(0) @binding(7) var<storage, read> world: array<u32>;`;
    // The peer visit/quality maps are constant for the whole rollout, so their
    // layer-1 contribution is a fixed bias. Hoist it out of the per-step loop
    // instead of re-streaming 512 inputs through the matmul every step.
    const peerLoad = "";
    const peerBiasDecl = salo ? `var<workgroup> peerBias: array<f32, ${ROLL_H}>;` : "";
    const peerBiasInit = salo
      ? `if (t < RH) {
  var pb = 0.0;
  for (var i: u32 = 0u; i < GRID * GRID; i = i + 1u) {
    pb = pb + peer[i] * rollW[(${ROLL_IN}u + i) * RH + t]
       + peer[GRID * GRID + i] * rollW[(${ROLL_IN + CELL_N}u + i) * RH + t];
  }
  peerBias[t] = pb;
  }`
      : "";
    const peerBiasAdd = salo ? `acc = acc + peerBias[t];` : "";
    // Layer-1 only has to stream the live observation now; the peer rows of W1
    // are folded into peerBias above.
    const rinLive = ROLL_IN;
    const saloReward = salo
      ? `if (dims.saloCoef != 0.0) {
        let idx = min(py * GRID + px, GRID * GRID - 1u);
        reward = reward + dims.saloCoef * peer[GRID * GRID + idx];
      }`
      : "";
    const liveDecl = salo ? `var<workgroup> liveScore: f32;` : "";
    const liveInit = salo ? `liveScore = 0.0;` : "";
    const liveAdd = salo ? `liveScore = liveScore + reward;` : "";
    const auxSalo = salo
      ? `xs[260u] = tanh(liveScore * 0.25);
      xs[262u] = tanh(dims.meanScore * 0.25);
      xs[263u] = tanh((dims.bestScore - liveScore) * 0.25);`
      : `xs[260u] = 0.0;
      xs[262u] = 0.0;
      xs[263u] = 0.0;`;
    return /* wgsl */ `
struct Dims {
  batch: u32,
  steps: u32,
  nActions: u32,
  maxActions: u32,
  gemWeight: f32,
  roomWeight: f32,
  pushWeight: f32,
  noveltyBonus: f32,
  deathPenalty: f32,
  saloCoef: f32,
  meanScore: f32,
  bestScore: f32,
}
@group(0) @binding(0) var<storage, read> rollW: array<f32>;
@group(0) @binding(1) var<storage, read_write> board: array<u32>;
@group(0) @binding(2) var<storage, read_write> head: array<u32>;
@group(0) @binding(3) var<storage, read_write> out: array<f32>;
@group(0) @binding(4) var<storage, read_write> grids: array<u32>;
@group(0) @binding(5) var<storage, read> forced: array<u32>;
@group(0) @binding(6) var<uniform> dims: Dims;
${peerBind}

const RH = ${ROLL_H}u;
const TN = ${ROLL_T}u;
const RIN = ${rin}u;
const OUT = ${OUT}u;
const GRID = ${GRID}u;
const N_ACTIONS = ${N_ACTIONS}u;
const STRIDE = ${ROLL_STRIDE}u;
const CHUNK = 9u;
const W1N = ${w1}u;
const W2N = ${w2}u;
const W3N = ${w3}u;
const B1 = W1N + W2N + W3N;
const B2 = B1 + RH;
const B3 = B2 + RH;
const BOARD_STRIDE = ${BOARD_STRIDE}u;
const B_OCC = ${B_OCC}u;
const B_TER = ${B_TER}u;
const B_META = ${B_META}u;
const B_START_TER = ${B_START_TER}u;
const B_START_OCC = ${B_START_ACT}u;
const B_PREV_TER = ${B_PREV_TER}u;
const B_GEM = ${B_GEM}u;
const B_PUSH = ${B_PUSH}u;
const B_SEEN = ${B_SEEN}u;
const WORLD_W = ${WORLD_W}u;
const WORLD_ROOMS = ${WORLD_ROOMS}u;
const WORLD_HEADER = ${WORLD_HEADER}u;
const ROOM_STRIDE = ${ROOM_STRIDE}u;

var<workgroup> xs: array<f32, ${rinLive}>;
// Incremental layer-1 state: the observation changes in only a handful of
// cells per step, so h1pre is carried across steps and patched with the diff
// instead of re-running the full ${rinLive}-input matmul every step.
var<workgroup> xsPrev: array<f32, ${rinLive}>;
var<workgroup> h1pre: array<f32, ${ROLL_H}>;
var<workgroup> dIdx: array<u32, 288>;
var<workgroup> dVal: array<f32, 288>;
var<workgroup> dCnt: array<u32, ${ROLL_H}>;
var<workgroup> pp: array<f32, ${ROLL_T}>;
var<workgroup> h1s: array<f32, ${ROLL_H}>;
var<workgroup> h2s: array<f32, ${ROLL_H}>;
var<workgroup> ys: array<f32, 16>;
var<workgroup> grid: array<u32, ${GRID * GRID}>;
var<workgroup> ground: array<u32, ${GRID * GRID}>;
var<workgroup> prevG: array<u32, ${GRID * GRID}>;
var<workgroup> rngState: u32;
var<workgroup> px: u32;
var<workgroup> py: u32;
var<workgroup> yaw: u32;
var<workgroup> pitch: u32;
var<workgroup> dead: u32;
var<workgroup> gemCount: u32;
var<workgroup> actionCount: u32;
var<workgroup> seen: array<u32, 8>;
var<workgroup> seenPush: array<u32, 8>;
var<workgroup> gemMask: array<u32, 8>;
var<workgroup> boardW: i32;
var<workgroup> boardH: i32;
var<workgroup> envBase: u32;
var<workgroup> buttonsOn: u32;
var<workgroup> feat: u32;
var<workgroup> prevPx: u32;
var<workgroup> prevPy: u32;
var<workgroup> prevDead: u32;
var<workgroup> prevGem: u32;
var<workgroup> pe: u32;
var<workgroup> prevPe: u32;
var<workgroup> startPe: u32;
var<workgroup> sX: i32;
var<workgroup> sY: i32;
var<workgroup> sE: u32;
var<workgroup> startPx: u32;
var<workgroup> startPy: u32;
var<workgroup> startDead: u32;
var<workgroup> startGem: u32;
var<workgroup> roomCol: u32;
var<workgroup> roomRow: u32;
var<workgroup> visited: array<u32, 8>;
var<workgroup> prevRoomCol: u32;
var<workgroup> prevRoomRow: u32;
var<workgroup> prevFeat: u32;
var<workgroup> prevW: i32;
var<workgroup> prevH: i32;
var<workgroup> startRoomCol: u32;
var<workgroup> startRoomRow: u32;
var<workgroup> actNow: u32;
var<workgroup> needStrip: u32;
var<workgroup> probNow: f32;
${liveDecl}
${peerBiasDecl}

fn lcg() -> f32 {
  rngState = rngState * 1664525u + 1013904223u;
  return f32(rngState >> 8u) / 16777216.0;
}
fn inBoard(x: i32, y: i32) -> bool { return x >= 0 && y >= 0 && x < boardW && y < boardH; }
fn cellAt(x: i32, y: i32) -> u32 {
  if (!inBoard(x, y)) { return 2u; }
  return grid[u32(y) * GRID + u32(x)];
}
fn groundAt(x: i32, y: i32) -> u32 {
  if (!inBoard(x, y)) { return 2u; }
  return ground[u32(y) * GRID + u32(x)] & 255u;
}
fn gRaw(x: i32, y: i32) -> u32 {
  if (!inBoard(x, y)) { return 2u; }
  return ground[u32(y) * GRID + u32(x)];
}
fn gRaised(x: i32, y: i32) -> bool {
  return ((gRaw(x, y) >> 16u) & 1u) != 0u;
}
fn gDir(x: i32, y: i32) -> u32 {
  return (gRaw(x, y) >> 8u) & 3u;
}
fn gSlopeElev(x: i32, y: i32) -> u32 {
  return (gRaw(x, y) >> 10u) & 15u;
}
fn gMask(x: i32, y: i32) -> u32 {
  return (gRaw(x, y) >> 17u) & 15u;
}
fn gBlocks(x: i32, y: i32, e: u32) -> bool {
  if (e >= 4u) { return false; }
  return ((gMask(x, y) >> e) & 1u) != 0u;
}
fn ctype(cell: u32) -> u32 { return cell & 255u; }
fn cgroup(cell: u32) -> u32 { return (cell >> 8u) & 255u; }
fn cdir(cell: u32) -> u32 { return (cell >> 16u) & 255u; }
fn cele(cell: u32) -> u32 { return cell >> 24u; }
fn pushable(cell: u32) -> bool {
  let t = ctype(cell);
  return t == 18u || t == 19u || t == 22u;
}
fn terrainEnterable(t: u32) -> bool {
  return t == 1u || t == 3u || t == 4u || t == 6u || t == 7u || t == 9u || t == 14u || t == 15u;
}
fn dirVec(dir: u32) -> vec2<i32> {
  if (dir == 0u) { return vec2<i32>(0, -1); }
  if (dir == 1u) { return vec2<i32>(0, 1); }
  if (dir == 2u) { return vec2<i32>(-1, 0); }
  return vec2<i32>(1, 0);
}
fn buttonsHeld() -> bool {
  var any = false;
  var held = true;
  for (var i: u32 = 0u; i < GRID * GRID; i = i + 1u) {
    if ((ground[i] & 255u) != 9u) { continue; }
    any = true;
    let t = ctype(grid[i]);
    if (t != 16u && t != 18u && t != 19u && t != 20u && t != 22u) { held = false; }
  }
  return any && held;
}
fn gateUp(x: i32, y: i32) -> bool {
  let pd = abs(i32(px) - x) + abs(i32(py) - y);
  if (pd == 1) { return true; }
  for (var i: u32 = 0u; i < GRID * GRID; i = i + 1u) {
    if (ctype(grid[i]) != 20u) { continue; }
    let cx = i32(i % GRID);
    let cy = i32(i / GRID);
    if (abs(cx - x) + abs(cy - y) == 1) { return true; }
  }
  return false;
}
fn blocking(cell: u32, x: i32, y: i32, asPlayer: bool) -> bool {
  let t = ctype(cell);
  if (t == 2u || t == 10u || t == 11u || t == 12u || t == 13u) { return true; }
  if (t == 8u) { return buttonsOn == 0u; }
  if (t == 6u) { return asPlayer && gateUp(x, y); }
  if (t == 7u) { return gRaised(x, y); }
  if (t == 20u && asPlayer) { return true; }
  if (t == 21u) { return false; }
  return false;
}
fn isSupportOcc(t: u32) -> bool {
  return t == 18u || t == 19u || t == 20u || t == 22u;
}
fn terrainSurface(x: i32, y: i32) -> i32 {
  let g = groundAt(x, y);
  if (g == 7u) { return select(0, 1, gRaised(x, y)); }
  if (g == 6u) { return select(0, 1, gateUp(x, y)); }
  if (g == 8u) { return select(0, 1, buttonsOn == 0u); }
  if (g == 1u || g == 3u || g == 4u || g == 9u) { return 0; }
  if (gMask(x, y) != 0u) {
    var surf = -1;
    for (var e: u32 = 0u; e < 4u; e = e + 1u) {
      if (gBlocks(x, y, e)) { continue; }
      if (e == 0u || gBlocks(x, y, e - 1u)) { surf = i32(e); }
    }
    if (surf >= 0) { return surf; }
  }
  if (g == 2u || g == 11u || g == 13u) { return 1; }
  return -1;
}
fn terrainBlocksAt(x: i32, y: i32, e: u32) -> bool {
  let g = groundAt(x, y);
  if (g == 1u || g == 3u || g == 4u || g == 9u || g == 0u || g == 5u) { return false; }
  if (g == 8u) { return buttonsOn == 0u && e == 0u; }
  if (g == 6u) { return gateUp(x, y) && e == 0u; }
  if (g == 7u) { return gRaised(x, y) && e == 0u; }
  let mask = gMask(x, y);
  if (mask != 0u) { return ((mask >> min(e, 3u)) & 1u) != 0u; }
  if (g == 2u || g == 10u || g == 11u || g == 12u || g == 13u) { return e == 0u; }
  if (g == 14u) { return e <= 1u; }
  if (g == 15u) {
    if (buttonsOn == 0u) { return e <= gSlopeElev(x, y) + 1u; }
    return e == gSlopeElev(x, y) || e == gSlopeElev(x, y) + 1u;
  }
  return false;
}
fn occBlocksAt(cell: u32, e: u32) -> bool {
  let t = ctype(cell);
  if (t == 16u && cele(cell) == e) { return true; }
  if (isSupportOcc(t) && cele(cell) == e) { return true; }
  return false;
}
fn canStandAt(x: i32, y: i32, e: u32) -> bool {
  if (terrainBlocksAt(x, y, e)) { return false; }
  let cell = cellAt(x, y);
  if (occBlocksAt(cell, e)) { return false; }
  if (i32(e) == terrainSurface(x, y)) { return true; }
  if (isSupportOcc(ctype(cell)) && cele(cell) + 1u == e) { return true; }
  return false;
}
fn vacatePlayer() {
  let i = py * GRID + px;
  if (ctype(grid[i]) == 16u) { grid[i] = ground[i]; }
}
fn occupyPlayer() {
  let i = py * GRID + px;
  let cell = grid[i];
  let t = ctype(cell);
  if (isSupportOcc(t) && cele(cell) != pe) { return; }
  if (t == 21u) { return; }
  grid[i] = 16u | (pe << 24u);
}
${slopes ? `fn tryIceSlope(dx: i32, dy: i32) -> i32 {
  sX = i32(px) + dx;
  sY = i32(py) + dy;
  if (!inBoard(sX, sY)) { return -1; }
  var g = groundAt(sX, sY);
  if (g != 14u && (g != 15u || buttonsOn == 0u)) { return -1; }
  var sd = dirVec(gDir(sX, sY));
  var se = gSlopeElev(sX, sY);
  if (!((sd.x == dx && sd.y == dy && pe == se) || (sd.x == -dx && sd.y == -dy && pe == se + 1u))) { return -1; }
  sE = pe;
  for (var hops: u32 = 0u; hops < GRID; hops = hops + 1u) {
    g = groundAt(sX, sY);
    if (g != 14u && (g != 15u || buttonsOn == 0u)) { break; }
    sd = dirVec(gDir(sX, sY));
    se = gSlopeElev(sX, sY);
    if (!((sd.x == dx && sd.y == dy && sE == se) || (sd.x == -dx && sd.y == -dy && sE == se + 1u))) { break; }
    sE = select(se, se + 1u, sd.x == dx && sd.y == dy);
    sX = sX + dx;
    sY = sY + dy;
    if (!inBoard(sX, sY)) { break; }
  }
  if (inBoard(sX, sY) && canStandAt(sX, sY, sE)) {
    vacatePlayer(); px = u32(sX); py = u32(sY); pe = sE; occupyPlayer(); return 1;
  }
  if (inBoard(sX, sY) && sE > 0u && canStandAt(sX, sY, 0u)) {
    vacatePlayer(); px = u32(sX); py = u32(sY); pe = 0u; occupyPlayer(); return 1;
  }
  if (inBoard(sX, sY) && (groundAt(sX, sY) == 0u || groundAt(sX, sY) == 5u)) {
    vacatePlayer(); px = u32(sX); py = u32(sY); dead = 1u; return 1;
  }
  g = groundAt(i32(px), i32(py));
  if (g != 4u && g != 11u) { return 0; }
  sX = i32(px); sY = i32(py); sE = 0u;
  for (var hops: u32 = 0u; hops < GRID; hops = hops + 1u) {
    let bx = sX - dx; let by = sY - dy;
    if (!inBoard(bx, by) || !canStandAt(bx, by, pe)) { break; }
    sX = bx; sY = by; sE = 1u;
    g = groundAt(bx, by);
    if (g != 4u && g != 11u) { break; }
  }
  if (sE == 0u) { return 0; }
  vacatePlayer(); px = u32(sX); py = u32(sY); occupyPlayer(); return 1;
}` : ""}
fn visit(x: u32, y: u32) -> f32 {
  let idx = min(y * GRID + x, GRID * GRID - 1u);
  let word = idx / 32u;
  let bit = 1u << (idx % 32u);
  if ((seen[word] & bit) != 0u) { return 0.0; }
  seen[word] = seen[word] | bit;
  return dims.noveltyBonus;
}
fn visitPush(x: u32, y: u32) -> f32 {
  let idx = min(y * GRID + x, GRID * GRID - 1u);
  let word = idx / 32u;
  let bit = 1u << (idx % 32u);
  if ((seenPush[word] & bit) != 0u) { return 0.0; }
  seenPush[word] = seenPush[word] | bit;
  return dims.pushWeight;
}
fn roomBitBase(bank: u32, col: u32, row: u32) -> u32 {
  let rid = min(row * WORLD_W + col, WORLD_ROOMS - 1u);
  return envBase + bank + rid * 8u;
}
fn saveRoomBits() {
  let gemBase = roomBitBase(B_GEM, roomCol, roomRow);
  let pushBase = roomBitBase(B_PUSH, roomCol, roomRow);
  let seenBase = roomBitBase(B_SEEN, roomCol, roomRow);
  for (var s: u32 = 0u; s < 8u; s = s + 1u) {
    board[gemBase + s] = gemMask[s];
    board[pushBase + s] = seenPush[s];
    board[seenBase + s] = seen[s];
  }
}
fn loadRoomBits(col: u32, row: u32) {
  let gemBase = roomBitBase(B_GEM, col, row);
  let pushBase = roomBitBase(B_PUSH, col, row);
  let seenBase = roomBitBase(B_SEEN, col, row);
  for (var s: u32 = 0u; s < 8u; s = s + 1u) {
    gemMask[s] = board[gemBase + s];
    seenPush[s] = board[pushBase + s];
    seen[s] = board[seenBase + s];
  }
}
fn stripCollectedGems() {
  for (var i: u32 = 0u; i < GRID * GRID; i = i + 1u) {
    if (ctype(grid[i]) != 17u) { continue; }
    let word = i / 32u;
    let bit = 1u << (i % 32u);
    if ((gemMask[word] & bit) != 0u) { grid[i] = ground[i]; }
  }
}
fn markGem(x: u32, y: u32) {
  let idx = min(y * GRID + x, GRID * GRID - 1u);
  let word = idx / 32u;
  let bit = 1u << (idx % 32u);
  gemMask[word] = gemMask[word] | bit;
}
fn slidePushed(x: u32, y: u32, dx: i32, dy: i32, packed: u32, pay: bool) -> f32 {
  var cx = i32(x);
  var cy = i32(y);
  if (groundAt(cx, cy) != 4u) {
    if (pay) { return visitPush(x, y); }
    return 0.0;
  }
  for (var hops: u32 = 0u; hops < GRID; hops = hops + 1u) {
    let nx = cx + dx;
    let ny = cy + dy;
    if (!inBoard(nx, ny)) { break; }
    let next = cellAt(nx, ny);
    let nt = ctype(next);
    if (nt == 16u || nt == 17u || nt == 20u || nt == 21u || pushable(next) || blocking(next, nx, ny, false)) { break; }
    if (nt == 0u || nt == 5u) {
      grid[u32(cy) * GRID + u32(cx)] = ground[u32(cy) * GRID + u32(cx)];
      if (pay) { return visitPush(u32(nx), u32(ny)); }
      return 0.0;
    }
    grid[u32(cy) * GRID + u32(cx)] = ground[u32(cy) * GRID + u32(cx)];
    grid[u32(ny) * GRID + u32(nx)] = packed;
    cx = nx;
    cy = ny;
    if (groundAt(nx, ny) != 4u) { break; }
  }
  if (pay) { return visitPush(u32(cx), u32(cy)); }
  return 0.0;
}
fn moveDelta(action: u32, yawNow: u32) -> vec2<i32> {
  var dx = 0; var dy = 0;
  if (action == 0u) { dy = -1; } else if (action == 1u) { dy = 1; } else if (action == 2u) { dx = -1; } else if (action == 3u) { dx = 1; }
  if (yawNow == 1u) { return vec2<i32>(dy, -dx); }
  if (yawNow == 2u) { return vec2<i32>(-dx, -dy); }
  if (yawNow == 3u) { return vec2<i32>(-dy, dx); }
  return vec2<i32>(dx, dy);
}
fn pushGroup(dx: i32, dy: i32, destX: i32, destY: i32) -> f32 {
  let seed = cellAt(destX, destY);
  let kind = ctype(seed);
  if (kind != 19u && kind != 20u) { return -1.0; }
  let group = cgroup(seed);
  var mx: array<i32, 32>;
  var my: array<i32, 32>;
  var n = 0u;
  if (group == 0u) { mx[0] = destX; my[0] = destY; n = 1u; }
  else {
    for (var y: i32 = 0; y < i32(GRID); y = y + 1) {
      for (var x: i32 = 0; x < i32(GRID); x = x + 1) {
        let c = cellAt(x, y);
        if (ctype(c) == kind && cgroup(c) == group) {
          if (n >= 32u) { return -1.0; }
          mx[n] = x; my[n] = y; n = n + 1u;
        }
      }
    }
  }
  if (n == 0u) { return -1.0; }
  for (var i: u32 = 0u; i < n; i = i + 1u) {
    let tx = mx[i] + dx; let ty = my[i] + dy;
    if (!inBoard(tx, ty)) { return -1.0; }
    let tcell = cellAt(tx, ty); let tt = ctype(tcell);
    let intoSelf = tt == kind && group != 0u && cgroup(tcell) == group;
    if (intoSelf || terrainEnterable(tt) || tt == 16u || tt == 0u || tt == 5u || tt == 17u || tt == 21u) { continue; }
    if (tt == 8u && buttonsOn == 1u) { continue; }
    return -1.0;
  }
  let packed = kind | (group << 8u) | (cele(seed) << 24u);
  for (var i: u32 = 0u; i < n; i = i + 1u) {
    grid[u32(my[i]) * GRID + u32(mx[i])] = ground[u32(my[i]) * GRID + u32(mx[i])];
  }
  ${slopes ? `var fallen = 0u;
  for (var i: u32 = 0u; i < n; i = i + 1u) {
    mx[i] = mx[i] + dx; my[i] = my[i] + dy;
    let tt = ctype(cellAt(mx[i], my[i]));
    if (kind != 20u && (tt == 0u || tt == 5u) && n == 1u) { fallen = 1u; continue; }
    if (kind == 20u && (tt == 0u || tt == 5u)) { continue; }
    if (kind == 20u && tt == 17u) { continue; }
    grid[u32(my[i]) * GRID + u32(mx[i])] = packed;
  }
  if (kind == 19u && fallen == 0u) {
    var allIce = true;
    for (var i: u32 = 0u; i < n; i = i + 1u) {
      if (groundAt(mx[i], my[i]) != 4u) { allIce = false; }
    }
    if (allIce) {
      for (var hops: u32 = 0u; hops < GRID; hops = hops + 1u) {
        var ok = true;
        for (var i: u32 = 0u; i < n; i = i + 1u) {
          let tx = mx[i] + dx; let ty = my[i] + dy;
          if (!inBoard(tx, ty)) { ok = false; break; }
          let tcell = cellAt(tx, ty); let tt = ctype(tcell);
          let intoSelf = tt == kind && group != 0u && cgroup(tcell) == group;
          if (intoSelf || terrainEnterable(tt) || tt == 16u || tt == 0u || tt == 5u || tt == 17u || tt == 21u) { continue; }
          if (tt == 8u && buttonsOn == 1u) { continue; }
          ok = false; break;
        }
        if (!ok) { break; }
        for (var i: u32 = 0u; i < n; i = i + 1u) {
          grid[u32(my[i]) * GRID + u32(mx[i])] = ground[u32(my[i]) * GRID + u32(mx[i])];
        }
        var anyIce = false;
        for (var i: u32 = 0u; i < n; i = i + 1u) {
          mx[i] = mx[i] + dx; my[i] = my[i] + dy;
          let tt = ctype(cellAt(mx[i], my[i]));
          if (n == 1u && (tt == 0u || tt == 5u)) { fallen = 1u; continue; }
          grid[u32(my[i]) * GRID + u32(mx[i])] = packed;
          if (groundAt(mx[i], my[i]) == 4u) { anyIce = true; }
        }
        if (fallen == 1u || !anyIce) { break; }
      }
    }
  }
  var pay = 0.0;
  for (var i: u32 = 0u; i < n; i = i + 1u) {
    if (kind == 19u) { pay = pay + visitPush(u32(mx[i]), u32(my[i])); }
  }
  return pay;` : `var pay = 0.0;
  for (var i: u32 = 0u; i < n; i = i + 1u) {
    let tx = u32(mx[i] + dx); let ty = u32(my[i] + dy);
    let tt = ctype(cellAt(i32(tx), i32(ty)));
    if (kind != 20u && (tt == 0u || tt == 5u)) { pay = pay + visitPush(tx, ty); continue; }
    if (kind == 20u && (tt == 0u || tt == 5u)) { continue; }
    if (kind == 20u && tt == 17u) { continue; }
    grid[ty * GRID + tx] = packed;
    if (kind == 19u) { pay = pay + visitPush(tx, ty); }
  }
  return pay;`}
}
fn snapshotPrev() {
  // The grid/ground copies are done cooperatively by every thread just before
  // stepEnv runs; only the scalar carry-over is left here.
  prevPx = px; prevPy = py; prevPe = pe; prevDead = dead; prevGem = gemCount;
  prevRoomCol = roomCol; prevRoomRow = roomRow;
  prevFeat = feat; prevW = boardW; prevH = boardH;
}
fn restorePrev() {
  saveRoomBits();
  // grid / ground were restored cooperatively before this call.
  px = prevPx; py = prevPy; pe = prevPe; dead = prevDead;
  roomCol = prevRoomCol; roomRow = prevRoomRow;
  feat = prevFeat; boardW = prevW; boardH = prevH;
  loadRoomBits(roomCol, roomRow);
  needStrip = 1u;
}
fn restoreStart() {
  // grid / ground were restored cooperatively before this call.
  px = startPx; py = startPy; pe = startPe; dead = startDead;
  roomCol = startRoomCol; roomRow = startRoomRow;
  needStrip = 1u;
  if (dead == 0u && px < GRID && py < GRID) { occupyPlayer(); }
}
fn loadRoom(col: u32, row: u32, ex: u32, ey: u32, nw: i32, nh: i32, roomFeat: u32) {
  saveRoomBits();
  let rid = row * WORLD_W + col;
  let src = WORLD_HEADER + rid * ROOM_STRIDE;
  for (var i: u32 = 0u; i < GRID * GRID; i = i + 1u) {
    grid[i] = world[src + i];
    ground[i] = world[src + GRID * GRID + i];
    if (ctype(grid[i]) == 16u) { grid[i] = ground[i]; }
  }
  roomCol = col;
  roomRow = row;
  boardW = nw;
  boardH = nh;
  feat = roomFeat;
  px = ex;
  py = ey;
  dead = 0u;
  loadRoomBits(col, row);
  stripCollectedGems();
  if (ex < GRID && ey < GRID) { occupyPlayer(); }
  startPx = ex; startPy = ey; startPe = pe; startDead = 0u;
  startGem = gemCount;
  startRoomCol = col; startRoomRow = row;
  for (var i: u32 = 0u; i < GRID * GRID; i = i + 1u) {
    board[envBase + B_START_OCC + i] = grid[i];
    board[envBase + B_START_TER + i] = ground[i];
  }
}
fn tryExit(dx: i32, dy: i32) -> f32 {
  var onEdge = false;
  if (dx < 0 && i32(px) == 0) { onEdge = true; }
  else if (dx > 0 && i32(px) == boardW - 1) { onEdge = true; }
  else if (dy < 0 && i32(py) == 0) { onEdge = true; }
  else if (dy > 0 && i32(py) == boardH - 1) { onEdge = true; }
  if (!onEdge) { return -1.0; }
  let nc = i32(roomCol) + dx;
  let nr = i32(roomRow) + dy;
  if (nc < 0 || nr < 0 || nc >= i32(WORLD_W) || nr >= i32(WORLD_W)) { return -1.0; }
  let rid = u32(nr) * WORLD_W + u32(nc);
  let info = world[rid];
  let nw = i32(info & 255u);
  let nh = i32((info >> 8u) & 255u);
  if (nw <= 0 || nh <= 0) { return -1.0; }
  var ex = i32(px);
  var ey = i32(py);
  if (dx < 0) { ex = nw - 1; } else if (dx > 0) { ex = 0; } else { if (ex > nw - 1) { ex = nw - 1; } }
  if (dy < 0) { ey = nh - 1; } else if (dy > 0) { ey = 0; } else { if (ey > nh - 1) { ey = nh - 1; } }
  loadRoom(u32(nc), u32(nr), u32(ex), u32(ey), nw, nh, (info >> 16u) & 255u);
  var pay = 0.0;
  let word = rid / 32u;
  let bit = 1u << (rid % 32u);
  if ((visited[word] & bit) == 0u) {
    visited[word] = visited[word] | bit;
    pay = pay + dims.roomWeight;
  }
  return pay;
}
fn moveClones(dx: i32, dy: i32) {
  if ((feat & 2u) == 0u) { return; }
  var seenG: u32 = 0u;
  for (var i: u32 = 0u; i < GRID * GRID; i = i + 1u) {
    if (ctype(grid[i]) != 20u) { continue; }
    let x = i32(i % GRID);
    let y = i32(i / GRID);
    let g = cgroup(grid[i]);
    if (g != 0u) {
      let bit = 1u << (g & 31u);
      if ((seenG & bit) != 0u) { continue; }
      seenG = seenG | bit;
    }
    let _pay = pushGroup(dx, dy, x, y);
  }
}
${slopes ? `fn punchVictim(sx: i32, sy: i32, dx: i32, dy: i32, packed: u32, isPlayer: bool) {
  var cx = sx;
  var cy = sy;
  for (var hops: u32 = 0u; hops < GRID; hops = hops + 1u) {
    let nx = cx + dx;
    let ny = cy + dy;
    if (!inBoard(nx, ny)) { break; }
    let nt = ctype(cellAt(nx, ny));
    let gt = groundAt(nx, ny);
    if (nt == 2u || nt == 10u || nt == 11u || nt == 12u || nt == 13u) { break; }
    if (pushable(cellAt(nx, ny)) || nt == 20u) { break; }
    if (gt == 0u || gt == 5u || nt == 0u || nt == 5u) {
      let lx = nx + dx;
      let ly = ny + dy;
      if (inBoard(lx, ly) && canStandAt(lx, ly, pe) && ctype(cellAt(lx, ly)) != 2u && !pushable(cellAt(lx, ly))) {
        cx = lx;
        cy = ly;
        continue;
      }
      if (isPlayer) { px = u32(nx); py = u32(ny); dead = 1u; }
      return;
    }
    if (blocking(cellAt(nx, ny), nx, ny, isPlayer) && nt != 21u && nt != 17u) { break; }
    cx = nx;
    cy = ny;
  }
  if (isPlayer) { px = u32(cx); py = u32(cy); occupyPlayer(); }
  else if (cx != sx || cy != sy) { grid[u32(cy) * GRID + u32(cx)] = packed; }
}
fn applyPunchers(didMove: u32) {
  if ((feat & 4u) == 0u) { return; }
  if (didMove == 0u || dead == 1u) { return; }
  for (var i: u32 = 0u; i < GRID * GRID; i = i + 1u) {
    let cell = grid[i];
    if (ctype(cell) != 21u) { continue; }
    let x = i32(i % GRID);
    let y = i32(i / GRID);
    if (i32(px) != x || i32(py) != y) { continue; }
    let d = dirVec(cdir(cell));
    punchVictim(x, y, d.x, d.y, 16u, true);
  }
}` : `fn applyPunchers(didMove: u32) {
  if ((feat & 4u) == 0u) { return; }
  for (var i: u32 = 0u; i < GRID * GRID; i = i + 1u) {
    let cell = grid[i];
    if (ctype(cell) != 21u) { continue; }
    let x = i32(i % GRID);
    let y = i32(i / GRID);
    let d = dirVec(cdir(cell));
    let hx = x + d.x; let hy = y + d.y;
    if (!inBoard(hx, hy)) { continue; }
    let hit = cellAt(hx, hy);
    let ht = ctype(hit);
    if (ht != 16u && !pushable(hit) && ht != 20u && ht != 19u) { continue; }
    let nx = hx + d.x; let ny = hy + d.y;
    if (!inBoard(nx, ny) || blocking(cellAt(nx, ny), nx, ny, ht == 16u)) { continue; }
    let behindT = ctype(cellAt(nx, ny));
    if (behindT != 1u && behindT != 3u && behindT != 4u && behindT != 9u && behindT != 0u && behindT != 5u) { continue; }
    if (ht == 16u) {
      vacatePlayer();
      if (behindT == 0u || behindT == 5u) { px = u32(nx); py = u32(ny); dead = 1u; }
      else { px = u32(nx); py = u32(ny); occupyPlayer(); }
    } else {
      grid[u32(hy) * GRID + u32(hx)] = ground[u32(hy) * GRID + u32(hx)];
      if (behindT != 0u && behindT != 5u) {
        grid[u32(ny) * GRID + u32(nx)] = hit;
        if (groundAt(nx, ny) == 4u) { let _slide = slidePushed(u32(nx), u32(ny), d.x, d.y, hit, false); }
      }
    }
  }
}`}
fn toggleLift() {
  if ((feat & 8u) == 0u) { return; }
  if (dead == 1u) { return; }
  if (groundAt(i32(px), i32(py)) != 7u) { return; }
  let i = py * GRID + px;
  let raised = ((ground[i] >> 16u) & 255u) != 0u;
  if (raised) {
    ground[i] = ground[i] & 4294901759u;
    if (pe > 0u) { pe = pe - 1u; }
  } else {
    ground[i] = ground[i] | (1u << 16u);
    pe = pe + 1u;
  }
}
fn stepEnv(action: u32) -> f32 {
  var reward = 0.0;
  var moved = 0u;
  if (action == 8u) {
    restorePrev();
    actionCount = actionCount + 1u;
    return 0.0;
  }
  if (action == 9u) {
    restoreStart();
    actionCount = actionCount + 1u;
    return 0.0;
  }
  if (dead == 1u) {
    actionCount = actionCount + 1u;
    return 0.0;
  }
  if (action >= 4u && action <= 7u) {
    if (action == 4u && pitch > 0u) { pitch = pitch - 1u; }
    if (action == 5u && pitch < 4u) { pitch = pitch + 1u; }
    if (action == 6u) { yaw = (yaw + 3u) % 4u; }
    if (action == 7u) { yaw = (yaw + 1u) % 4u; }
    actionCount = actionCount + 1u;
    return 0.0;
  }
  if (action <= 3u) {
    snapshotPrev();
    buttonsOn = select(0u, 1u, (feat & 1u) != 0u && buttonsHeld());
    let d = moveDelta(action, yaw);
    let exitPay = tryExit(d.x, d.y);
    if (exitPay >= 0.0) {
      reward = exitPay + visit(px, py);
      ${saloReward}
      actionCount = actionCount + 1u;
      return reward;
    }
    moveClones(d.x, d.y);
    var nx = i32(px) + d.x;
    var ny = i32(py) + d.y;
    var dest = cellAt(nx, ny);
    var destT = ctype(dest);
    let destE = cele(dest);
    ${slopes ? `let destG = groundAt(nx, ny);
    var slopeHit = -1;
    if (destG == 14u || destG == 15u) { slopeHit = tryIceSlope(d.x, d.y); }
    if (slopeHit >= 0) {
      if (slopeHit == 1) {
        moved = 1u;
        if (dead == 1u) { reward = dims.deathPenalty; }
      }
    } else {` : ""}
    if (pe == 0u && (destT == 0u || destT == 5u) && !canStandAt(nx, ny, pe)) {
      vacatePlayer();
      px = u32(nx); py = u32(ny);
      dead = 1u;
      reward = dims.deathPenalty;
      moved = 1u;
    } else if (destT == 17u && destE == pe && groundAt(nx, ny) != 4u) {
      vacatePlayer();
      px = u32(nx); py = u32(ny);
      occupyPlayer();
      gemCount = gemCount + 1u;
      markGem(px, py);
      reward = dims.gemWeight;
      moved = 1u;
    } else if (pushable(dest) && destE == pe) {
      let bx = nx + d.x; let by = ny + d.y;
      let behind = cellAt(bx, by); let behindT = ctype(behind);
      let destX = u32(nx); let destY = u32(ny);
      if (destT == 19u) {
        let pay = pushGroup(d.x, d.y, nx, ny);
        if (pay >= 0.0) {
          vacatePlayer();
          px = destX; py = destY;
          occupyPlayer();
          reward = pay; moved = 1u;
        }
      } else if (destT == 22u && behindT == 5u) {
        ground[u32(by) * GRID + u32(bx)] = 1u;
        grid[u32(by) * GRID + u32(bx)] = 1u;
        vacatePlayer();
        px = destX; py = destY;
        occupyPlayer();
        reward = visitPush(u32(bx), u32(by)); moved = 1u;
      } else if (behindT == 0u || (behindT == 5u && destT != 22u)) {
        vacatePlayer();
        px = destX; py = destY;
        occupyPlayer();
        reward = visitPush(u32(bx), u32(by)); moved = 1u;
      } else if (behindT == 21u) {
        ${slopes ? `vacatePlayer();
        px = destX; py = destY;
        occupyPlayer();
        reward = visitPush(u32(bx), u32(by)); moved = 1u;
        punchVictim(bx, by, dirVec(cdir(behind)).x, dirVec(cdir(behind)).y, dest, false);` : `grid[u32(by) * GRID + u32(bx)] = dest;
        vacatePlayer();
        px = destX; py = destY;
        occupyPlayer();
        reward = visitPush(u32(bx), u32(by)); moved = 1u;`}
      } else if (!blocking(behind, bx, by, false) && behindT != 17u && !pushable(behind)) {
        grid[u32(by) * GRID + u32(bx)] = dest;
        vacatePlayer();
        px = destX; py = destY;
        occupyPlayer();
        reward = slidePushed(u32(bx), u32(by), d.x, d.y, dest, true); moved = 1u;
      }
    } else if (canStandAt(nx, ny, pe) || destT == 21u) {
      vacatePlayer();
      var coverGem = destT == 17u;
      px = u32(nx); py = u32(ny);
      var slide = pe == 0u && groundAt(nx, ny) == 4u;
      while (slide) {
        let sx = i32(px) + d.x; let sy = i32(py) + d.y;
        let next = cellAt(sx, sy); let nt = ctype(next);
        if (blocking(next, sx, sy, true) || pushable(next) || nt == 5u || nt == 0u) { break; }
        if (coverGem) { grid[py * GRID + px] = 17u; coverGem = false; }
        else if (ctype(grid[py * GRID + px]) == 16u) { grid[py * GRID + px] = ground[py * GRID + px]; }
        coverGem = nt == 17u;
        px = u32(sx); py = u32(sy);
        if (groundAt(sx, sy) != 4u) { slide = false; }
      }
      if (coverGem) {
        gemCount = gemCount + 1u;
        markGem(px, py);
        reward = reward + dims.gemWeight;
      }
      occupyPlayer();
      moved = 1u;
    }
    ${slopes ? "}" : ""}
    applyPunchers(moved);
    if (moved == 1u) { toggleLift(); }
    if (moved == 1u) {
      reward = reward + visit(px, py);
      ${saloReward}
    }
  }
  actionCount = actionCount + 1u;
  return reward;
}

@compute @workgroup_size(${ROLL_T})
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let t = lid.x;
  if (b >= dims.batch) { return; }
  let base = b * BOARD_STRIDE;
  let headBase = b * 24u;
  for (var i: u32 = t; i < GRID * GRID; i = i + TN) {
    grid[i] = board[base + B_OCC + i];
    ground[i] = board[base + B_TER + i];
    prevG[i] = grid[i];
  }
  if (t < 8u) {
    seen[t] = head[headBase + 8u + t];
    seenPush[t] = head[headBase + 16u + t];
  }
  workgroupBarrier();
  if (t == 0u) {
    envBase = base;
    px = head[headBase + 0u];
    py = head[headBase + 1u];
    yaw = head[headBase + 2u];
    pitch = head[headBase + 3u];
    dead = head[headBase + 4u];
    gemCount = head[headBase + 5u];
    actionCount = head[headBase + 6u];
    rngState = head[headBase + 7u] * 747796405u + 2891336453u;
    boardW = i32(board[base + B_META + 2u]);
    boardH = i32(board[base + B_META + 3u]);
    feat = board[base + B_META + 4u];
    if (boardW <= 0) { boardW = i32(GRID); }
    if (boardH <= 0) { boardH = i32(GRID); }
    startPx = board[base + B_META + 5u];
    startPy = board[base + B_META + 6u];
    startDead = board[base + B_META + 7u];
    startGem = board[base + B_META + 8u];
    roomCol = board[base + B_META + 9u];
    roomRow = board[base + B_META + 10u];
    startRoomCol = board[base + B_META + 11u];
    startRoomRow = board[base + B_META + 12u];
    pe = board[base + B_META + 13u];
    startPe = board[base + B_META + 14u];
    for (var v: u32 = 0u; v < 8u; v = v + 1u) { visited[v] = board[base + B_META + 16u + v]; }
    loadRoomBits(roomCol, roomRow);
    prevPx = px; prevPy = py; prevPe = pe; prevDead = dead; prevGem = gemCount;
    prevRoomCol = roomCol; prevRoomRow = roomRow; prevFeat = feat; prevW = boardW; prevH = boardH;
    buttonsOn = select(0u, 1u, buttonsHeld());
    ${liveInit}
    let _ignore = visit(px, py);
  }
  ${peerBiasInit}
  workgroupBarrier();
  for (var step: u32 = 0u; step < dims.steps; step = step + 1u) {
    for (var i: u32 = t; i < GRID * GRID; i = i + TN) {
      var vis = grid[i] & 255u;
      if (dead == 0u && i == py * GRID + px) { vis = 16u; }
      xs[i] = f32(vis) / 23.0;
      ${peerLoad}
    }
    workgroupBarrier();
    if (t == 0u) {
      xs[256u] = f32(yaw) / 3.0;
      xs[257u] = f32(pitch) / 4.0;
      xs[258u] = f32(dead);
      xs[259u] = min(1.0, f32(gemCount) / 90.0);
      ${auxSalo}
      xs[261u] = min(1.0, f32(actionCount) / max(f32(dims.maxActions), 1.0));
    }
    workgroupBarrier();
    // Rebuild from scratch periodically so incremental rounding cannot drift.
    let fullL1 = (step % 64u) == 0u;
    let lo = t * CHUNK;
    let hi = min(lo + CHUNK, ${rinLive}u);
    if (fullL1) {
      // Each of the ${ROLL_LANES} lane groups streams an interleaved quarter
      // of the inputs for its column; the fixed pp reduce keeps the order
      // deterministic.
      let fcol = t & ${ROLL_H - 1}u;
      var facc = 0.0;
      for (var k: u32 = (t >> 5u) * 4u; k < ${rinLive}u; k = k + ${ROLL_LANES * 4}u) {
        facc = facc + xs[k] * rollW[k * RH + fcol] + xs[k + 1u] * rollW[(k + 1u) * RH + fcol] + xs[k + 2u] * rollW[(k + 2u) * RH + fcol] + xs[k + 3u] * rollW[(k + 3u) * RH + fcol];
      }
      pp[t] = facc;
      workgroupBarrier();
      if (t < RH) { h1pre[t] = ${ppReduceExpr(ROLL_H)}; }
      for (var k: u32 = lo; k < hi; k = k + 1u) { xsPrev[k] = xs[k]; }
    } else {
      // Each thread owns a fixed contiguous slice and writes into fixed slots,
      // so the accumulation order below is identical on every run.
      var n = 0u;
      for (var k: u32 = lo; k < hi; k = k + 1u) {
        let d = xs[k] - xsPrev[k];
        if (d != 0.0) {
          dIdx[lo + n] = k;
          dVal[lo + n] = d;
          n = n + 1u;
          xsPrev[k] = xs[k];
        }
      }
      if (t < RH) { dCnt[t] = n; }
      workgroupBarrier();
      // The scan splits the ${ROLL_H} diff chunks across the lane groups too.
      let scol = t & ${ROLL_H - 1}u;
      let c0 = (t >> 5u) * ${ROLL_H / ROLL_LANES}u;
      var dSum = 0.0;
      for (var c: u32 = c0; c < c0 + ${ROLL_H / ROLL_LANES}u; c = c + 1u) {
        let cbase = c * CHUNK;
        let cn = dCnt[c];
        for (var j: u32 = 0u; j < cn; j = j + 1u) {
          dSum = dSum + dVal[cbase + j] * rollW[dIdx[cbase + j] * RH + scol];
        }
      }
      pp[t] = dSum;
      workgroupBarrier();
      if (t < RH) { h1pre[t] = h1pre[t] + ${ppReduceExpr(ROLL_H)}; }
    }
    if (t < RH) {
      var acc = h1pre[t];
      ${peerBiasAdd}
      h1s[t] = max(acc + rollW[B1 + t], 0.0);
    }
    workgroupBarrier();
    // Layer 2: each lane group of ${ROLL_LANES} handles 4 of the 32 rows for
    // its column, then the fixed pp reduce combines the partials.
    let col2 = t & ${ROLL_H - 1}u;
    let k2 = (t >> 5u) * 4u;
    pp[t] = h1s[k2] * rollW[W1N + k2 * RH + col2] + h1s[k2 + 1u] * rollW[W1N + (k2 + 1u) * RH + col2] + h1s[k2 + 2u] * rollW[W1N + (k2 + 2u) * RH + col2] + h1s[k2 + 3u] * rollW[W1N + (k2 + 3u) * RH + col2];
    workgroupBarrier();
    if (t < RH) { h2s[t] = max(${ppReduceExpr(ROLL_H)} + rollW[B2 + t], 0.0); }
    workgroupBarrier();
    if (t < ${OUT * ROLL_LANES}u) {
      let col3 = t % OUT;
      let k3 = (t / OUT) * 4u;
      pp[t] = h2s[k3] * rollW[W1N + W2N + k3 * OUT + col3] + h2s[k3 + 1u] * rollW[W1N + W2N + (k3 + 1u) * OUT + col3] + h2s[k3 + 2u] * rollW[W1N + W2N + (k3 + 2u) * OUT + col3] + h2s[k3 + 3u] * rollW[W1N + W2N + (k3 + 3u) * OUT + col3];
    }
    workgroupBarrier();
    if (t < OUT) {
      ys[t] = ${ppReduceExpr(OUT)} + rollW[B3 + t];
    }
    workgroupBarrier();
    if (t == 0u) {
      var maxv = -1e30;
      var maskDead = dead == 1u;
      for (var a: u32 = 0u; a < N_ACTIONS; a = a + 1u) {
        var logit = ys[a];
        if (maskDead && a < 8u) { logit = -1e9; }
        if (logit > maxv) { maxv = logit; }
      }
      var sum = 0.0;
      var scores: array<f32, 10>;
      for (var a: u32 = 0u; a < N_ACTIONS; a = a + 1u) {
        var logit = ys[a];
        if (maskDead && a < 8u) { logit = -1e9; }
        scores[a] = exp(logit - maxv);
        sum = sum + scores[a];
      }
      var cursor = lcg();
      var action = forced[step * dims.batch + b];
      var chosenProb = 0.0;
      var chosen = false;
      if (action >= N_ACTIONS) {
        action = N_ACTIONS - 1u;
        for (var a: u32 = 0u; a < N_ACTIONS; a = a + 1u) {
          let p = scores[a] / sum;
          cursor = cursor - p;
          if (!chosen && cursor <= 0.0) { action = a; chosenProb = p; chosen = true; }
        }
        if (!chosen) { chosenProb = scores[action] / sum; }
      } else { chosenProb = scores[action] / max(sum, 1e-8); }
      actNow = action;
      probNow = chosenProb;
    }
    workgroupBarrier();
    // stepEnv only snapshots for a move action, and only while alive.
    if (actNow <= 3u && dead == 0u) {
      for (var i: u32 = t; i < GRID * GRID; i = i + TN) { prevG[i] = grid[i]; }
      if ((feat & 136u) != 0u) {
        for (var i: u32 = t; i < GRID * GRID; i = i + TN) { board[envBase + B_PREV_TER + i] = ground[i]; }
      }
    } else if (actNow == 8u) {
      for (var i: u32 = t; i < GRID * GRID; i = i + TN) { grid[i] = prevG[i]; }
      if ((feat & 136u) != 0u) {
        for (var i: u32 = t; i < GRID * GRID; i = i + TN) { ground[i] = board[envBase + B_PREV_TER + i]; }
      }
    } else if (actNow == 9u) {
      for (var i: u32 = t; i < GRID * GRID; i = i + TN) {
        grid[i] = board[envBase + B_START_OCC + i];
        ground[i] = board[envBase + B_START_TER + i];
      }
    }
    workgroupBarrier();
    if (t == 0u) {
      let action = actNow;
      let chosenProb = probNow;
      needStrip = 0u;
      let reward = stepEnv(action);
      ${liveAdd}
      let done = select(0.0, 1.0, actionCount >= dims.maxActions || gemCount >= 100u);
      let o = (step * dims.batch + b) * STRIDE;
      out[o] = f32(action);
      out[o + 1u] = log(max(chosenProb, 1e-8));
      out[o + 2u] = ys[N_ACTIONS];
      out[o + 3u] = reward;
      out[o + 4u] = done;
    }
    workgroupBarrier();
    if (needStrip == 1u) {
      for (var i: u32 = t; i < GRID * GRID; i = i + TN) {
        if (ctype(grid[i]) != 17u) { continue; }
        if ((gemMask[i / 32u] & (1u << (i % 32u))) != 0u) { grid[i] = ground[i]; }
      }
    }
    workgroupBarrier();
    // Consumers only ever read the low type byte, so pack four cells per word:
    // a quarter of the readback and a plain memcpy on the JS side.
    let gbase = (step * dims.batch + b) * (GRID * GRID / 4u);
    let playerCell = py * GRID + px;
    for (var w: u32 = t; w < GRID * GRID / 4u; w = w + TN) {
      var word = 0u;
      for (var q: u32 = 0u; q < 4u; q = q + 1u) {
        let i = w * 4u + q;
        var gcell = grid[i] & 255u;
        if (dead == 0u && i == playerCell) { gcell = 16u; }
        word = word | (gcell << (q * 8u));
      }
      grids[gbase + w] = word;
    }
    workgroupBarrier();
  }
  for (var i: u32 = t; i < GRID * GRID; i = i + TN) {
    board[base + B_OCC + i] = grid[i];
    board[base + B_TER + i] = ground[i];
  }
  if (t == 0u) {
    head[headBase + 0u] = px;
    head[headBase + 1u] = py;
    head[headBase + 2u] = yaw;
    head[headBase + 3u] = pitch;
    head[headBase + 4u] = dead;
    head[headBase + 5u] = gemCount;
    head[headBase + 6u] = actionCount;
    board[base + B_META + 2u] = u32(boardW);
    board[base + B_META + 3u] = u32(boardH);
    board[base + B_META + 4u] = feat;
    board[base + B_META + 5u] = startPx;
    board[base + B_META + 6u] = startPy;
    board[base + B_META + 7u] = startDead;
    board[base + B_META + 8u] = startGem;
    board[base + B_META + 9u] = roomCol;
    board[base + B_META + 10u] = roomRow;
    board[base + B_META + 11u] = startRoomCol;
    board[base + B_META + 12u] = startRoomRow;
    board[base + B_META + 13u] = pe;
    board[base + B_META + 14u] = startPe;
    for (var v: u32 = 0u; v < 8u; v = v + 1u) { board[base + B_META + 16u + v] = visited[v]; }
    saveRoomBits();
  }
  if (t < 8u) {
    head[headBase + 8u + t] = seen[t];
    head[headBase + 16u + t] = seenPush[t];
  }
}
`;
  }

  const ROLL_SHADER = buildRollShader(false, false);
  const ROLL_SHADER_SALO = buildRollShader(true, false);
  const ROLL_SHADER_SLOPE = buildRollShader(false, true);
  const ROLL_SHADER_SALO_SLOPE = buildRollShader(true, true);
  function buildPpoMegaShader(layout) {
    const { rin, w1, w2, w3 } = layout;
    return /* wgsl */ `
struct Dims {
  batch: u32,
  nActions: u32,
  clip: f32,
  valueCoef: f32,
  entropyCoef: f32,
  _0: f32,
  _1: f32,
  _2: f32,
}
@group(0) @binding(0) var<storage, read> rollW: array<f32>;
@group(0) @binding(1) var<storage, read> feats: array<f32>;
@group(0) @binding(2) var<storage, read> samples: array<f32>;
@group(0) @binding(3) var<storage, read_write> grad: array<f32>;
@group(0) @binding(4) var<storage, read_write> stats: array<f32>;
@group(0) @binding(5) var<uniform> dims: Dims;

const RH = ${ROLL_H}u;
const RIN = ${rin}u;
const OUT = ${OUT}u;
const NA = ${N_ACTIONS}u;
const W1N = ${w1}u;
const W2N = ${w2}u;
const W3N = ${w3}u;
const B1 = W1N + W2N + W3N;
const B2 = B1 + RH;
const B3 = B2 + RH;
const SSTR = ${PPO_SAMPLE_STRIDE}u;

var<workgroup> xs: array<f32, ${rin}>;
var<workgroup> h1s: array<f32, ${ROLL_H}>;
var<workgroup> h2s: array<f32, ${ROLL_H}>;
var<workgroup> ys: array<f32, 16>;
var<workgroup> dYs: array<f32, 16>;
var<workgroup> dh1s: array<f32, ${ROLL_H}>;
var<workgroup> dh2s: array<f32, ${ROLL_H}>;
var<workgroup> lossP: f32;
var<workgroup> lossV: f32;
var<workgroup> lossE: f32;

@compute @workgroup_size(${ROLL_H})
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
  let t = lid.x;
  var dW1: array<f32, ${rin}>;
  var dW2: array<f32, ${ROLL_H}>;
  var dW3: array<f32, ${OUT}>;
  var db1 = 0.0;
  var db2 = 0.0;
  var db3 = 0.0;
  for (var k: u32 = 0u; k < RIN; k = k + 1u) { dW1[k] = 0.0; }
  for (var k: u32 = 0u; k < RH; k = k + 1u) { dW2[k] = 0.0; }
  for (var k: u32 = 0u; k < OUT; k = k + 1u) { dW3[k] = 0.0; }
  if (t == 0u) {
    lossP = 0.0;
    lossV = 0.0;
    lossE = 0.0;
  }
  let B = dims.batch;
  let invB = 1.0 / max(f32(B), 1.0);
  workgroupBarrier();

  for (var i: u32 = 0u; i < B; i = i + 1u) {
    for (var k: u32 = t; k < RIN; k = k + RH) {
      xs[k] = feats[i * RIN + k];
    }
    workgroupBarrier();
    var acc = rollW[B1 + t];
    for (var k: u32 = 0u; k < RIN; k = k + 4u) {
      acc = acc
        + xs[k] * rollW[k * RH + t]
        + xs[k + 1u] * rollW[(k + 1u) * RH + t]
        + xs[k + 2u] * rollW[(k + 2u) * RH + t]
        + xs[k + 3u] * rollW[(k + 3u) * RH + t];
    }
    h1s[t] = max(acc, 0.0);
    workgroupBarrier();
    var acc2 = rollW[B2 + t];
    for (var k: u32 = 0u; k < RH; k = k + 4u) {
      acc2 = acc2
        + h1s[k] * rollW[W1N + k * RH + t]
        + h1s[k + 1u] * rollW[W1N + (k + 1u) * RH + t]
        + h1s[k + 2u] * rollW[W1N + (k + 2u) * RH + t]
        + h1s[k + 3u] * rollW[W1N + (k + 3u) * RH + t];
    }
    h2s[t] = max(acc2, 0.0);
    workgroupBarrier();
    if (t < OUT) {
      var acc3 = rollW[B3 + t];
      for (var k: u32 = 0u; k < RH; k = k + 4u) {
        acc3 = acc3
          + h2s[k] * rollW[W1N + W2N + k * OUT + t]
          + h2s[k + 1u] * rollW[W1N + W2N + (k + 1u) * OUT + t]
          + h2s[k + 2u] * rollW[W1N + W2N + (k + 2u) * OUT + t]
          + h2s[k + 3u] * rollW[W1N + W2N + (k + 3u) * OUT + t];
      }
      ys[t] = acc3;
    }
    workgroupBarrier();
    if (t == 0u) {
      let action = u32(samples[i * SSTR]);
      let oldLogp = samples[i * SSTR + 1u];
      let adv = samples[i * SSTR + 2u];
      let ret = samples[i * SSTR + 3u];
      let maskBits = u32(samples[i * SSTR + 4u]);
      var maxv = -1e30;
      for (var a: u32 = 0u; a < NA; a = a + 1u) {
        var logit = ys[a];
        if ((maskBits & (1u << a)) == 0u) { logit = -1e9; }
        if (logit > maxv) { maxv = logit; }
      }
      var sum = 0.0;
      var scores: array<f32, 10>;
      for (var a: u32 = 0u; a < NA; a = a + 1u) {
        var logit = ys[a];
        if ((maskBits & (1u << a)) == 0u) { logit = -1e9; }
        scores[a] = exp(logit - maxv);
        sum = sum + scores[a];
      }
      var entropy = 0.0;
      var probs: array<f32, 10>;
      for (var a: u32 = 0u; a < NA; a = a + 1u) {
        probs[a] = scores[a] / max(sum, 1e-8);
        entropy = entropy - probs[a] * log(max(probs[a], 1e-8));
      }
      let chosen = min(action, NA - 1u);
      let logp = log(max(probs[chosen], 1e-8));
      let logRatio = clamp(logp - oldLogp, -20.0, 20.0);
      let ratio = exp(logRatio);
      let unclipped = ratio * adv;
      let clippedRatio = clamp(ratio, 1.0 - dims.clip, 1.0 + dims.clip);
      let clipped = clippedRatio * adv;
      let takeUnclipped = unclipped <= clipped;
      lossP = lossP - min(unclipped, clipped);
      let diff = ys[NA] - ret;
      lossV = lossV + diff * diff;
      lossE = lossE + entropy;
      for (var a: u32 = 0u; a < NA; a = a + 1u) {
        var g = 0.0;
        if (takeUnclipped) {
          let ind = select(0.0, 1.0, a == chosen);
          g = -(ratio * adv) * (ind - probs[a]) * invB;
        }
        g = g + dims.entropyCoef * probs[a] * (log(max(probs[a], 1e-8)) + entropy) * invB;
        dYs[a] = g;
      }
      dYs[NA] = dims.valueCoef * 2.0 * diff * invB;
      for (var extra: u32 = NA + 1u; extra < 16u; extra = extra + 1u) { dYs[extra] = 0.0; }
    }
    workgroupBarrier();
    var g2 = 0.0;
    if (h2s[t] > 0.0) {
      for (var o: u32 = 0u; o < OUT; o = o + 1u) {
        g2 = g2 + rollW[W1N + W2N + t * OUT + o] * dYs[o];
      }
    }
    dh2s[t] = g2;
    workgroupBarrier();
    db2 = db2 + dh2s[t];
    for (var k: u32 = 0u; k < RH; k = k + 1u) {
      dW2[k] = dW2[k] + h1s[k] * dh2s[t];
    }
    for (var o: u32 = 0u; o < OUT; o = o + 1u) {
      dW3[o] = dW3[o] + h2s[t] * dYs[o];
    }
    if (t < OUT) { db3 = db3 + dYs[t]; }
    var g1 = 0.0;
    if (h1s[t] > 0.0) {
      for (var k: u32 = 0u; k < RH; k = k + 1u) {
        g1 = g1 + rollW[W1N + t * RH + k] * dh2s[k];
      }
    }
    dh1s[t] = g1;
    workgroupBarrier();
    db1 = db1 + dh1s[t];
    for (var k: u32 = 0u; k < RIN; k = k + 1u) {
      dW1[k] = dW1[k] + xs[k] * dh1s[t];
    }
    workgroupBarrier();
  }

  for (var k: u32 = 0u; k < RIN; k = k + 1u) {
    grad[k * RH + t] = dW1[k];
  }
  for (var k: u32 = 0u; k < RH; k = k + 1u) {
    grad[W1N + k * RH + t] = dW2[k];
  }
  for (var o: u32 = 0u; o < OUT; o = o + 1u) {
    grad[W1N + W2N + t * OUT + o] = dW3[o];
  }
  grad[B1 + t] = db1;
  grad[B2 + t] = db2;
  if (t < OUT) { grad[B3 + t] = db3; }
  if (t == 0u) {
    stats[0] = lossP * invB;
    stats[1] = lossV * invB;
    stats[2] = lossE * invB;
    stats[3] = f32(B);
  }
}
`;
  }
  const PPO_MEGA_SHADER = buildPpoMegaShader(VANILLA_LAYOUT);
  const PPO_MEGA_SHADER_SALO = buildPpoMegaShader(SALO_LAYOUT);

  function rootObject() {
    return typeof window !== "undefined" ? window : self;
  }

  function heInit(rng, fanIn, fanOut) {
    const scale = Math.sqrt(2 / fanIn);
    const data = new Float32Array(fanIn * fanOut);
    for (let i = 0; i < data.length; i += 1) data[i] = (rng() * 2 - 1) * scale;
    return data;
  }

  function mulberry32(seed) {
    let t = seed >>> 0;
    return () => {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function embedObservation(grid, aux, embedding, out) {
    const x = out || new Float32Array(INPUT);
    const n = GRID * GRID;
    for (let i = 0; i < n; i += 1) {
      const src = (grid[i] | 0) * 8;
      const offset = i * 8;
      x[offset] = embedding[src];
      x[offset + 1] = embedding[src + 1];
      x[offset + 2] = embedding[src + 2];
      x[offset + 3] = embedding[src + 3];
      x[offset + 4] = embedding[src + 4];
      x[offset + 5] = embedding[src + 5];
      x[offset + 6] = embedding[src + 6];
      x[offset + 7] = embedding[src + 7];
    }
    x.set(aux, n * 8);
    return x;
  }

  function softmax(logits, dest) {
    const exps = dest || new Float32Array(logits.length);
    let max = -Infinity;
    for (let i = 0; i < logits.length; i += 1) if (logits[i] > max) max = logits[i];
    let sum = 0;
    for (let i = 0; i < logits.length; i += 1) {
      exps[i] = Math.exp(logits[i] - max);
      sum += exps[i];
    }
    for (let i = 0; i < logits.length; i += 1) exps[i] /= sum;
    return exps;
  }

  function maskedLogits(logits, mask) {
    const out = new Float32Array(logits);
    for (let i = 0; i < out.length; i += 1) {
      if (mask && mask[i] === false) out[i] = -1e9;
    }
    return out;
  }

  function sampleAction(probs, rng) {
    let cursor = rng();
    for (let i = 0; i < probs.length; i += 1) {
      cursor -= probs[i];
      if (cursor <= 0) return i;
    }
    return probs.length - 1;
  }

  function sumColumns(matrix, rows, cols) {
    const sums = new Float32Array(cols);
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) sums[c] += matrix[r * cols + c];
    }
    return sums;
  }

  function computeGae(rewards, values, dones, lastValues, gamma, lam) {
    const tCount = rewards.length;
    const nEnvs = rewards[0].length;
    const advantages = Array.from({ length: tCount }, () => new Float32Array(nEnvs));
    const gae = new Float32Array(nEnvs);
    for (let t = tCount - 1; t >= 0; t -= 1) {
      for (let n = 0; n < nEnvs; n += 1) {
        const nextValue = t === tCount - 1 ? lastValues[n] : values[t + 1][n];
        const nonterminal = dones[t][n] ? 0 : 1;
        const delta = rewards[t][n] + gamma * nextValue * nonterminal - values[t][n];
        gae[n] = delta + gamma * lam * nonterminal * gae[n];
        advantages[t][n] = gae[n];
      }
    }
    const returns = advantages.map((row, t) => {
      const out = new Float32Array(nEnvs);
      for (let n = 0; n < nEnvs; n += 1) out[n] = row[n] + values[t][n];
      return out;
    });
    return { advantages, returns };
  }

  function packRollFeatures(grid, aux, dest, extra) {
    const x = dest || new Float32Array(extra ? SALO_IN : ROLL_IN);
    const cells = GRID * GRID;
    for (let i = 0; i < cells; i += 1) x[i] = ((Number(grid && grid[i] != null ? grid[i] : 0) | 0) & 255) / 23;
    for (let i = 0; i < AUX_DIM; i += 1) x[cells + i] = Number(aux && aux[i] != null ? aux[i] : 0);
    const visit = extra && extra.peerVisit;
    const quality = extra && extra.peerScore;
    const visitBase = cells + AUX_DIM;
    const scoreBase = visitBase + cells;
    if (x.length >= scoreBase + cells) {
      for (let i = 0; i < cells; i += 1) {
        x[visitBase + i] = visit ? Number(visit[i] || 0) : 0;
        x[scoreBase + i] = quality ? Number(quality[i] || 0) : 0;
      }
    }
    if (extra) {
      if (Number.isFinite(extra.ownScore)) x[cells + 4] = extra.ownScore;
      if (Number.isFinite(extra.meanScore)) x[cells + 6] = extra.meanScore;
      if (Number.isFinite(extra.bestGap)) x[cells + 7] = extra.bestGap;
    }
    return x;
  }

  function createSaloMemory() {
    return {
      visit: new Float32Array(GRID * GRID),
      quality: new Float32Array(GRID * GRID),
      meanScore: 0,
      bestScore: 0
    };
  }

  function updateSaloMemory(memory, storage, decay = 0.9) {
    const rewards = storage && storage.rewards;
    if (!memory || !rewards || !rewards.length || !rewards[0]) return memory;
    const nEnvs = rewards[0].length;
    const steps = rewards.length;
    const envReturn = new Float32Array(nEnvs);
    for (let t = 0; t < steps; t += 1) {
      for (let b = 0; b < nEnvs; b += 1) envReturn[b] += Number(rewards[t][b] || 0);
    }
    let mean = 0;
    let best = -Infinity;
    for (let b = 0; b < nEnvs; b += 1) {
      mean += envReturn[b];
      if (envReturn[b] > best) best = envReturn[b];
    }
    mean /= Math.max(1, nEnvs);
    let variance = 0;
    for (let b = 0; b < nEnvs; b += 1) variance += (envReturn[b] - mean) ** 2;
    const std = Math.sqrt(variance / Math.max(1, nEnvs)) + 1e-6;
    const cells = GRID * GRID;
    for (let i = 0; i < cells; i += 1) {
      memory.visit[i] *= decay;
      memory.quality[i] *= decay;
    }
    const observations = storage.observations || [];
    const scale = 1 / Math.max(1, nEnvs * steps);
    for (let t = 0; t < steps; t += 1) {
      const row = observations[t] || [];
      for (let b = 0; b < nEnvs; b += 1) {
        const grid = row[b] && row[b].grid;
        if (!grid) continue;
        const rel = (envReturn[b] - mean) / std;
        for (let i = 0; i < cells; i += 1) {
          if ((grid[i] | 0) !== 16) continue;
          memory.visit[i] += scale;
          memory.quality[i] += rel * scale;
          break;
        }
      }
    }
    let maxV = 1e-6;
    let maxQ = 1e-6;
    for (let i = 0; i < cells; i += 1) {
      if (memory.visit[i] > maxV) maxV = memory.visit[i];
      const abs = Math.abs(memory.quality[i]);
      if (abs > maxQ) maxQ = abs;
    }
    for (let i = 0; i < cells; i += 1) {
      memory.visit[i] = memory.visit[i] / maxV;
      memory.quality[i] = Math.max(-1, Math.min(1, memory.quality[i] / maxQ));
    }
    memory.meanScore = mean;
    memory.bestScore = Number.isFinite(best) ? best : 0;
    return memory;
  }

  function createRollPolicy(seed = 1, rin = ROLL_IN) {
    const rng = mulberry32(seed);
    const layout = rollLayout(rin);
    const weights = new Float32Array(layout.wLen);
    weights.set(heInit(rng, rin, ROLL_H), 0);
    weights.set(heInit(rng, ROLL_H, ROLL_H), layout.w1);
    weights.set(heInit(rng, ROLL_H, OUT), layout.w1 + layout.w2);
    return {
      weights,
      adam: { m: new Float32Array(weights.length), v: new Float32Array(weights.length), t: 0 }
    };
  }

  function compactForward(weights, x, mask) {
    const h1 = new Float32Array(ROLL_H);
    const h2 = new Float32Array(ROLL_H);
    const y = new Float32Array(OUT);
    const w2 = ROLL_W1;
    const w3 = ROLL_W1 + ROLL_W2;
    const b1 = w3 + ROLL_W3;
    const b2 = b1 + ROLL_H;
    const b3 = b2 + ROLL_H;
    for (let t = 0; t < ROLL_H; t += 1) {
      let acc = weights[b1 + t];
      for (let k = 0; k < ROLL_IN; k += 1) acc += x[k] * weights[k * ROLL_H + t];
      h1[t] = acc > 0 ? acc : 0;
    }
    for (let t = 0; t < ROLL_H; t += 1) {
      let acc = weights[b2 + t];
      for (let k = 0; k < ROLL_H; k += 1) acc += h1[k] * weights[w2 + k * ROLL_H + t];
      h2[t] = acc > 0 ? acc : 0;
    }
    for (let t = 0; t < OUT; t += 1) {
      let acc = weights[b3 + t];
      for (let k = 0; k < ROLL_H; k += 1) acc += h2[k] * weights[w3 + k * OUT + t];
      y[t] = acc;
    }
    const logits = maskedLogits(y.subarray(0, N_ACTIONS), mask);
    const probs = softmax(logits);
    let entropy = 0;
    for (let a = 0; a < N_ACTIONS; a += 1) entropy += -probs[a] * Math.log(Math.max(probs[a], 1e-8));
    return { h1, h2, y, logits, probs, entropy, value: y[N_ACTIONS] };
  }

  function compactBackward(weights, x, fwd, dY, grad) {
    const h1 = fwd.h1;
    const h2 = fwd.h2;
    const w2 = ROLL_W1;
    const w3 = ROLL_W1 + ROLL_W2;
    const b1 = w3 + ROLL_W3;
    const b2 = b1 + ROLL_H;
    const b3 = b2 + ROLL_H;
    const dh2 = new Float32Array(ROLL_H);
    const dh1 = new Float32Array(ROLL_H);
    for (let t = 0; t < OUT; t += 1) {
      const gy = dY[t];
      if (!gy) continue;
      grad[b3 + t] += gy;
      for (let k = 0; k < ROLL_H; k += 1) {
        grad[w3 + k * OUT + t] += h2[k] * gy;
        dh2[k] += weights[w3 + k * OUT + t] * gy;
      }
    }
    for (let t = 0; t < ROLL_H; t += 1) {
      if (h2[t] <= 0) dh2[t] = 0;
      const gy = dh2[t];
      if (!gy) continue;
      grad[b2 + t] += gy;
      for (let k = 0; k < ROLL_H; k += 1) {
        grad[w2 + k * ROLL_H + t] += h1[k] * gy;
        dh1[k] += weights[w2 + k * ROLL_H + t] * gy;
      }
    }
    for (let t = 0; t < ROLL_H; t += 1) {
      if (h1[t] <= 0) dh1[t] = 0;
      const gy = dh1[t];
      if (!gy) continue;
      grad[b1 + t] += gy;
      for (let k = 0; k < ROLL_IN; k += 1) grad[k * ROLL_H + t] += x[k] * gy;
    }
  }

  function adamOnHost(state, grad, lr) {
    const beta1 = 0.9;
    const beta2 = 0.999;
    const eps = 1e-8;
    state.adam.t += 1;
    const t = state.adam.t;
    const m = state.adam.m;
    const v = state.adam.v;
    const weights = state.weights;
    const bc1 = 1 - beta1 ** t;
    const bc2 = 1 - beta2 ** t;
    for (let i = 0; i < weights.length; i += 1) {
      const g = grad[i];
      m[i] = beta1 * m[i] + (1 - beta1) * g;
      v[i] = beta2 * v[i] + (1 - beta2) * g * g;
      weights[i] -= lr * (m[i] / bc1) / (Math.sqrt(v[i] / bc2) + eps);
    }
  }

  function compactPpoUpdate(state, batch, config = {}) {
    const B = batch.actions.length;
    const clip = config.clip == null ? 0.2 : config.clip;
    const valueCoef = config.valueCoef == null ? 0.5 : config.valueCoef;
    const entropyCoef = config.entropyCoef == null ? 0.01 : config.entropyCoef;
    const lr = config.lr == null ? 3e-4 : config.lr;
    const grad = new Float32Array(state.weights.length);
    const x = new Float32Array(ROLL_IN);
    let policyLoss = 0;
    let valueLoss = 0;
    let entropySum = 0;
    for (let i = 0; i < B; i += 1) {
      const obs = batch.observations[i];
      packRollFeatures(obs.grid, obs.aux, x);
      const fwd = compactForward(state.weights, x, obs.mask);
      entropySum += fwd.entropy;
      const action = batch.actions[i];
      const logp = Math.log(Math.max(fwd.probs[action], 1e-8));
      const logRatio = Math.max(-20, Math.min(20, logp - batch.logp[i]));
      const ratio = Math.exp(logRatio);
      const adv = batch.advantages[i];
      const unclipped = ratio * adv;
      const clippedRatio = Math.min(1 + clip, Math.max(1 - clip, ratio));
      const clipped = clippedRatio * adv;
      const takeUnclipped = unclipped <= clipped;
      policyLoss += -Math.min(unclipped, clipped);
      const diff = fwd.value - batch.returns[i];
      valueLoss += diff * diff;
      const dY = new Float32Array(OUT);
      if (takeUnclipped) {
        const scale = ratio * adv;
        for (let a = 0; a < N_ACTIONS; a += 1) {
          dY[a] = (-scale * ((a === action ? 1 : 0) - fwd.probs[a])) / B;
        }
      }
      for (let a = 0; a < N_ACTIONS; a += 1) {
        dY[a] += (entropyCoef * fwd.probs[a] * (Math.log(Math.max(fwd.probs[a], 1e-8)) + fwd.entropy)) / B;
      }
      dY[N_ACTIONS] = (valueCoef * 2 * diff) / B;
      compactBackward(state.weights, x, fwd, dY, grad);
    }
    adamOnHost(state, grad, lr);
    return {
      policyLoss: policyLoss / Math.max(1, B),
      valueLoss: valueLoss / Math.max(1, B),
      entropy: entropySum / Math.max(1, B)
    };
  }

  class WebGpuPpo {
    constructor(options = {}) {
      this.device = null;
      this.adapterName = "";
      this.pipelines = {};
      this.params = {};
      this.adamT = 0;
      this.embedding = null;
      this.rng = mulberry32(1);
      this.profiler = options.profiler || null;
      this.packedRead = options.packedRead != null ? options.packedRead : PACKED;
      this.scratch = new Map();
      this.staging = new Map();
      this.uniformCache = new Map();
      this.zeroHost = new Map();
    }

    span(name, fn) {
      if (!this.profiler) return fn();
      return this.profiler.span(name, fn);
    }

    async init(seed = 1) {
      if (!navigator.gpu) throw new Error("WebGPU is not available in this browser");
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw new Error("No WebGPU adapter");
      this.adapterName = adapter.info?.device || adapter.info?.description || "WebGPU adapter";
      this.device = await adapter.requestDevice({
        requiredLimits: {
          maxStorageBuffersPerShaderStage: Math.min(16, adapter.limits?.maxStorageBuffersPerShaderStage || 16)
        }
      });
      this.rng = mulberry32(seed);
      this.embedding = heInit(this.rng, CELL_TYPES, EMBED);
      this.params = {
        W1: this.paramBuffer(heInit(this.rng, INPUT, H1)),
        b1: this.paramBuffer(new Float32Array(H1)),
        W2: this.paramBuffer(heInit(this.rng, H1, H2)),
        b2: this.paramBuffer(new Float32Array(H2)),
        W3: this.paramBuffer(heInit(this.rng, H2, OUT)),
        b3: this.paramBuffer(new Float32Array(OUT))
      };
      this.pipelines.matmul = this.computePipeline(MATMUL_SHADER);
      this.pipelines.biasRelu = this.computePipeline(BIAS_RELU_SHADER);
      this.pipelines.reluMask = this.computePipeline(RELU_MASK_SHADER);
      this.pipelines.colsum = this.computePipeline(COLSUM_SHADER);
      this.pipelines.adam = this.computePipeline(ADAM_SHADER);
      this.pipelines.sample = this.computePipeline(SAMPLE_SHADER);
      this.pipelines.fusedAct = this.computePipeline(FUSED_ACT_SHADER);
      this.lazyPipeline("rollout", () => ROLL_SHADER);
      this.lazyPipeline("rolloutSalo", () => ROLL_SHADER_SALO);
      this.lazyPipeline("rolloutSlope", () => ROLL_SHADER_SLOPE);
      this.lazyPipeline("rolloutSaloSlope", () => ROLL_SHADER_SALO_SLOPE);
      this.pipelines.ppoMega = this.computePipeline(PPO_MEGA_SHADER);
      this.pipelines.ppoMegaSalo = this.computePipeline(PPO_MEGA_SHADER_SALO);
      const rollPolicy = createRollPolicy(seed + 17, ROLL_IN);
      const saloPolicy = createRollPolicy(seed + 19, SALO_IN);
      this.rollWHost = rollPolicy.weights;
      this.rollAdam = { t: 0 };
      this.rollParam = this.paramBuffer(this.rollWHost);
      this.rollParamSalo = this.paramBuffer(saloPolicy.weights);
      this.rollW = this.rollParam.buffer;
      this.rollWSalo = this.rollParamSalo.buffer;
      this.usingSalo = false;
      this.worldHost = new Uint32Array(WORLD_HEADER + WORLD_ROOMS * ROOM_STRIDE);
      this.worldBuffer = this.device.createBuffer({
        size: this.bufferSize(this.worldHost.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(this.worldBuffer, 0, this.worldHost);
      this.biasPack = this.empty(BIAS_PACK);
      await this.span("ppo.warmupMega", () => this.warmupPpoMega(false));
      await this.span("ppo.warmupMegaSalo", () => this.warmupPpoMega(true));
      await this.span("ppo.warmup", () =>
        this.forwardBatch([
          {
            grid: new Uint8Array(GRID * GRID),
            aux: new Float32Array(AUX_DIM),
            mask: Array(N_ACTIONS).fill(true)
          }
        ])
      );
      await this.span("ppo.warmupSample", () => this.warmupSample());
      return { adapter: this.adapterName };
    }

    scratchFor(batch) {
      let buffers = this.scratch.get(batch);
      if (buffers) return buffers;
      buffers = {
        x: this.empty(batch * INPUT + batch * N_ACTIONS + batch),
        h1: this.empty(batch * H1),
        h2: this.empty(batch * H2),
        y: this.empty(batch * OUT),
        dY: this.empty(batch * OUT),
        dH1: this.empty(batch * H1),
        dH2: this.empty(batch * H2),
        mask: this.empty(batch * N_ACTIONS),
        u: this.empty(batch),
        packed: this.empty(batch * PACKED),
        maskU: this.empty(batch * N_ACTIONS + batch),
        maskHost: new Float32Array(batch * N_ACTIONS),
        uHost: new Float32Array(batch),
        maskUHost: new Float32Array(batch * N_ACTIONS + batch),
        xHost: new Float32Array(batch * INPUT + batch * N_ACTIONS + batch),
        packedHost: new Float32Array(batch * PACKED),
        actsOut: []
      };
      this.scratch.set(batch, buffers);
      return buffers;
    }

    paramBuffer(data) {
      const buffer = this.device.createBuffer({
        size: this.bufferSize(data.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
      });
      this.device.queue.writeBuffer(buffer, 0, data);
      const zeros = new Float32Array(data.length);
      const m = this.storage(zeros);
      const v = this.storage(zeros);
      const grad = this.storage(zeros);
      return { buffer, m, v, grad, length: data.length, bytes: data.byteLength };
    }

    storage(data) {
      const buffer = this.device.createBuffer({
        size: this.bufferSize(data.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
      });
      if (data.byteLength) this.device.queue.writeBuffer(buffer, 0, data);
      return buffer;
    }

    bufferSize(bytes) {
      const size = Math.max(4, Number(bytes) >>> 0);
      if (size !== Number(bytes) && Number(bytes) > 0) {
        return Math.max(4, Math.ceil(Number(bytes) / 4) * 4);
      }
      return size;
    }

    empty(floats) {
      return this.device.createBuffer({
        size: this.bufferSize(floats * 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
      });
    }

    uniform(values) {
      const key = values.join(",");
      let buffer = this.uniformCache.get(key);
      if (buffer) return buffer;
      const data = new Uint32Array(values);
      buffer = this.device.createBuffer({
        size: this.bufferSize(data.byteLength),
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(buffer, 0, data);
      this.uniformCache.set(key, buffer);
      return buffer;
    }

    writeRolloutDims(fields) {
      if (!this.rollDimsBuffer) {
        this.rollDimsHost = new ArrayBuffer(48);
        this.rollDimsBuffer = this.device.createBuffer({
          size: 48,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
      }
      const u32 = new Uint32Array(this.rollDimsHost);
      const f32 = new Float32Array(this.rollDimsHost);
      u32[0] = fields.batch >>> 0;
      u32[1] = fields.steps >>> 0;
      u32[2] = fields.nActions >>> 0;
      u32[3] = fields.maxActions >>> 0;
      f32[4] = Number(fields.gemWeight);
      f32[5] = Number(fields.roomWeight);
      f32[6] = Number(fields.pushWeight);
      f32[7] = Number(fields.noveltyBonus);
      f32[8] = Number(fields.deathPenalty);
      f32[9] = Number(fields.saloCoef || 0);
      f32[10] = Number(fields.meanScore || 0);
      f32[11] = Number(fields.bestScore || 0);
      this.device.queue.writeBuffer(this.rollDimsBuffer, 0, this.rollDimsHost);
      return this.rollDimsBuffer;
    }

    lazyPipeline(name, source) {
      Object.defineProperty(this.pipelines, name, {
        configurable: true,
        enumerable: true,
        get: () => {
          const built = this.computePipeline(source());
          Object.defineProperty(this.pipelines, name, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: built
          });
          return built;
        }
      });
    }

    computePipeline(code) {
      const module = this.device.createShaderModule({ code });
      return this.device.createComputePipeline({
        layout: "auto",
        compute: { module, entryPoint: "main" }
      });
    }

    bind(pipeline, entries) {
      return this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: entries.map((buffer, index) => ({ binding: index, resource: { buffer } }))
      });
    }

    dispatch(pipeline, bindGroup, x, y = 1, encoder = null) {
      const owned = encoder == null;
      if (owned) encoder = this.device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(x, y);
      pass.end();
      if (owned) this.device.queue.submit([encoder.finish()]);
    }

    async readF32(buffer, floats, encoder = null, dest = null) {
      return this.span("ppo.readF32", async () => {
      const bytes = this.bufferSize(floats * 4);
      let staging = this.staging.get(bytes);
      if (!staging) {
        staging = this.device.createBuffer({
          size: bytes,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
        this.staging.set(bytes, staging);
      }
      if (encoder == null) encoder = this.device.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer, 0, staging, 0, bytes);
      this.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const mapped = new Float32Array(staging.getMappedRange());
      const data = dest && dest.length >= floats ? dest : new Float32Array(floats);
      if (data !== mapped) data.set(mapped.subarray(0, floats));
      staging.unmap();
      return data.length === floats ? data : data.subarray(0, floats);
      });
    }

    packBatch(observations, dest) {
      return this.span("ppo.packBatch", () => {
      const x = dest || new Float32Array(observations.length * INPUT);
      observations.forEach((obs, index) => {
        embedObservation(obs.grid, obs.aux, this.embedding, x.subarray(index * INPUT, (index + 1) * INPUT));
      });
      return x;
      });
    }

    matmul(A, B, C, M, K, N, transposeA = false, transposeB = false, encoder = null) {
      const dims = this.uniform([M, K, N, transposeA ? 1 : 0, transposeB ? 1 : 0, 0, 0, 0]);
      this.dispatch(
        this.pipelines.matmul,
        this.bind(this.pipelines.matmul, [A, B, C, dims]),
        Math.ceil(M / 8),
        Math.ceil(N / 8),
        encoder
      );
    }

    colsum(matrix, sums, rows, cols, encoder = null) {
      const dims = this.uniform([rows, cols, 0, 0]);
      this.dispatch(
        this.pipelines.colsum,
        this.bind(this.pipelines.colsum, [matrix, sums, dims]),
        Math.ceil(cols / 64),
        1,
        encoder
      );
    }

    biasRelu(values, bias, rows, cols, relu, encoder = null) {
      const dims = this.uniform([rows, cols, relu ? 1 : 0, 0]);
      this.dispatch(
        this.pipelines.biasRelu,
        this.bind(this.pipelines.biasRelu, [values, bias, dims]),
        Math.ceil((rows * cols) / 64),
        1,
        encoder
      );
    }

    encodeForward(encoder, scratch, batch) {
      this.matmul(scratch.x, this.params.W1.buffer, scratch.h1, batch, INPUT, H1, false, false, encoder);
      this.biasRelu(scratch.h1, this.params.b1.buffer, batch, H1, true, encoder);
      this.matmul(scratch.h1, this.params.W2.buffer, scratch.h2, batch, H1, H2, false, false, encoder);
      this.biasRelu(scratch.h2, this.params.b2.buffer, batch, H2, true, encoder);
      this.matmul(scratch.h2, this.params.W3.buffer, scratch.y, batch, H2, OUT, false, false, encoder);
      this.biasRelu(scratch.y, this.params.b3.buffer, batch, OUT, false, encoder);
    }

    encodeSample(encoder, scratch, batch) {
      const dims = this.uniform([batch, N_ACTIONS, OUT, PACKED]);
      this.dispatch(
        this.pipelines.sample,
        this.bind(this.pipelines.sample, [scratch.y, scratch.mask, scratch.u, scratch.packed, dims]),
        Math.ceil(batch / 64),
        1,
        encoder
      );
    }

    encodeFusedAct(encoder, scratch, batch) {
      if (!scratch.fusedActBind) {
        const dims = this.uniform([batch, N_ACTIONS, OUT, PACKED]);
        scratch.fusedActBind = this.bind(this.pipelines.fusedAct, [
          scratch.x,
          this.params.W1.buffer,
          this.params.W2.buffer,
          this.params.W3.buffer,
          this.biasPack,
          scratch.packed,
          dims
        ]);
      }
      this.dispatch(this.pipelines.fusedAct, scratch.fusedActBind, batch, 1, encoder);
    }

    fillActInputs(scratch, observations) {
      const batch = observations.length;
      const xHost = scratch.xHost;
      const maskBase = batch * INPUT;
      for (let i = 0; i < batch; i += 1) {
        const mask = observations[i].mask;
        const base = maskBase + i * N_ACTIONS;
        for (let a = 0; a < N_ACTIONS; a += 1) {
          xHost[base + a] = mask && mask[a] === false ? 0 : 1;
        }
        xHost[maskBase + batch * N_ACTIONS + i] = this.rng();
      }
    }

    unpackActs(_observations, packed, dest) {
      const acts = dest || [];
      const stride = packed.length >= PACKED ? PACKED : 4;
      let n = 0;
      for (let i = 0, o = 0; o + 3 <= packed.length; i += 1, o += stride) {
        const action = packed[o] | 0;
        let item = acts[i];
        if (!item) {
          item = {
            action: 0,
            logp: 0,
            value: 0,
            logits: new Float32Array(N_ACTIONS),
            probs: new Float32Array(N_ACTIONS)
          };
          acts[i] = item;
        }
        item.action = action;
        item.value = packed[o + 2];
        if (stride >= PACKED) {
          item.logits.set(packed.subarray(o + 3, o + 3 + N_ACTIONS));
          softmax(item.logits, item.probs);
          item.logp = Math.log(Math.max(item.probs[action], 1e-8));
        } else {
          item.logp = packed[o + 1];
        }
        n = i + 1;
      }
      acts.length = n;
      return acts;
    }

    async warmupSample() {
      const scratch = this.scratchFor(1);
      scratch.xHost.fill(0);
      scratch.xHost.fill(1, INPUT, INPUT + N_ACTIONS);
      scratch.xHost[INPUT + N_ACTIONS] = 0;
      this.device.queue.writeBuffer(scratch.x, 0, scratch.xHost);
      const encoder = this.device.createCommandEncoder();
      this.encodeFusedAct(encoder, scratch, 1);
      this.device.queue.submit([encoder.finish()]);
      await this.device.queue.onSubmittedWorkDone();
    }

    async forwardBatch(observations) {
      return this.span("ppo.forwardBatch", async () => {
      const batch = observations.length;
      const scratch = this.scratchFor(batch);
      const xHost = this.packBatch(observations, scratch.xHost);
      this.device.queue.writeBuffer(scratch.x, 0, xHost);
      const encoder = this.device.createCommandEncoder();
      this.span("ppo.matmulForward", () => {
        this.encodeForward(encoder, scratch, batch);
      });
      const out = await this.readF32(scratch.y, batch * OUT, encoder);
      return { out, xHost, scratch };
      });
    }

    decodeActions(observations, out) {
      return observations.map((obs, index) => {
        const offset = index * OUT;
        const logits = maskedLogits(out.subarray(offset, offset + N_ACTIONS), obs.mask);
        const probs = softmax(logits);
        const action = sampleAction(probs, this.rng);
        return {
          action,
          logp: Math.log(Math.max(probs[action], 1e-8)),
          value: out[offset + N_ACTIONS],
          logits,
          probs
        };
      });
    }

    act(observation) {
      return this.span("ppo.act", () => this.actBatch([observation]).then((acts) => acts[0]));
    }

    actBatch(observations) {
      return this.span("ppo.actBatch", async () => {
        const batch = observations.length;
        const scratch = this.scratchFor(batch);
        this.packBatch(observations, scratch.xHost);
        this.fillActInputs(scratch, observations);
        this.device.queue.writeBuffer(scratch.x, 0, scratch.xHost);
        const encoder = this.device.createCommandEncoder();
        this.span("ppo.matmulForward", () => {
          this.encodeFusedAct(encoder, scratch, batch);
        });
        const packedFloats = batch * this.packedRead;
        const dest = scratch.packedHost.length >= packedFloats ? scratch.packedHost : new Float32Array(packedFloats);
        const packed = await this.readF32(scratch.packed, packedFloats, encoder, dest);
        return this.unpackActs(observations, packed.length === packedFloats ? packed : packed.subarray(0, packedFloats), scratch.actsOut);
      });
    }

    async update(batch, config) {
      return this.span("ppo.update", async () => {
      const B = batch.actions.length;
      const { out, scratch } = await this.forwardBatch(batch.observations);
      const dY = new Float32Array(B * OUT);
      let policyLoss = 0;
      let valueLoss = 0;
      let entropy = 0;
      for (let i = 0; i < B; i += 1) {
        const logits = maskedLogits(out.subarray(i * OUT, i * OUT + N_ACTIONS), batch.observations[i].mask);
        const value = out[i * OUT + N_ACTIONS];
        const probs = softmax(logits);
        const action = batch.actions[i];
        const logp = Math.log(Math.max(probs[action], 1e-8));
        const ratio = Math.exp(Math.max(-20, Math.min(20, logp - batch.logp[i])));
        const adv = batch.advantages[i];
        const unclipped = ratio * adv;
        const clippedRatio = Math.min(1 + config.clip, Math.max(1 - config.clip, ratio));
        const clipped = clippedRatio * adv;
        const takeUnclipped = unclipped <= clipped;
        policyLoss += -Math.min(unclipped, clipped);
        const diff = value - batch.returns[i];
        valueLoss += diff * diff;
        let sampleEntropy = 0;
        for (let a = 0; a < N_ACTIONS; a += 1) {
          sampleEntropy += -probs[a] * Math.log(Math.max(probs[a], 1e-8));
        }
        entropy += sampleEntropy;
        const entropyCoef = config.entropyCoef == null ? 0.01 : config.entropyCoef;
        if (takeUnclipped) {
          const scale = ratio * adv;
          for (let a = 0; a < N_ACTIONS; a += 1) {
            const indicator = a === action ? 1 : 0;
            dY[i * OUT + a] = (-scale * (indicator - probs[a])) / B;
          }
        }
        for (let a = 0; a < N_ACTIONS; a += 1) {
          dY[i * OUT + a] +=
            (entropyCoef * probs[a] * (Math.log(Math.max(probs[a], 1e-8)) + sampleEntropy)) / B;
        }
        dY[i * OUT + N_ACTIONS] = (config.valueCoef * 2 * diff) / B;
      }

      this.device.queue.writeBuffer(scratch.dY, 0, dY);
      this.matmul(scratch.dY, this.params.W3.buffer, scratch.dH2, B, OUT, H2, false, true);
      this.dispatch(
        this.pipelines.reluMask,
        this.bind(this.pipelines.reluMask, [scratch.dH2, scratch.h2]),
        Math.ceil((B * H2) / 64)
      );
      this.matmul(scratch.dH2, this.params.W2.buffer, scratch.dH1, B, H2, H1, false, true);
      this.dispatch(
        this.pipelines.reluMask,
        this.bind(this.pipelines.reluMask, [scratch.dH1, scratch.h1]),
        Math.ceil((B * H1) / 64)
      );

      this.zero(this.params.W3.grad, this.params.W3.bytes);
      this.zero(this.params.W2.grad, this.params.W2.bytes);
      this.zero(this.params.W1.grad, this.params.W1.bytes);
      this.matmul(scratch.h2, scratch.dY, this.params.W3.grad, H2, B, OUT, true, false);
      this.matmul(scratch.h1, scratch.dH2, this.params.W2.grad, H1, B, H2, true, false);
      this.matmul(scratch.x, scratch.dH1, this.params.W1.grad, INPUT, B, H1, true, false);

      this.colsum(scratch.dY, this.params.b3.grad, B, OUT);
      this.colsum(scratch.dH2, this.params.b2.grad, B, H2);
      this.colsum(scratch.dH1, this.params.b1.grad, B, H1);

      this.adamT += 1;
      await this.span("ppo.adam", () => this.adamStep(config.lr));
      this.syncBiasPack();
      return {
        policyLoss: policyLoss / B,
        valueLoss: valueLoss / B,
        entropy: entropy / B
      };
      });
    }

    async updateRollout(batch, config) {
      return this.span("ppo.updateRollout", async () => {
        if (this.device && this.pipelines.ppoMega) return this.updateRolloutGpu(batch, config);
        if (!this.rollWHost) this.rollWHost = createRollPolicy(1).weights;
        if (!this.rollAdam || !this.rollAdam.m) {
          this.rollAdam = { m: new Float32Array(this.rollWHost.length), v: new Float32Array(this.rollWHost.length), t: 0 };
        }
        return compactPpoUpdate({ weights: this.rollWHost, adam: this.rollAdam }, batch, config);
      });
    }

    ppoScratch(batch, rin = ROLL_IN) {
      const key = `ppo:${batch}:${rin}`;
      let buffers = this.scratch.get(key);
      if (buffers) return buffers;
      buffers = {
        feats: this.empty(batch * rin),
        samples: this.empty(batch * PPO_SAMPLE_STRIDE),
        stats: this.empty(4),
        featsHost: new Float32Array(batch * rin),
        samplesHost: new Float32Array(batch * PPO_SAMPLE_STRIDE),
        rin
      };
      this.scratch.set(key, buffers);
      return buffers;
    }

    writePpoDims(fields) {
      if (!this.ppoDimsBuffer) {
        this.ppoDimsHost = new ArrayBuffer(32);
        this.ppoDimsBuffer = this.device.createBuffer({
          size: 32,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
      }
      const u32 = new Uint32Array(this.ppoDimsHost);
      const f32 = new Float32Array(this.ppoDimsHost);
      u32[0] = fields.batch >>> 0;
      u32[1] = fields.nActions >>> 0;
      f32[2] = Number(fields.clip);
      f32[3] = Number(fields.valueCoef);
      f32[4] = Number(fields.entropyCoef);
      f32[5] = 0;
      f32[6] = 0;
      f32[7] = 0;
      this.device.queue.writeBuffer(this.ppoDimsBuffer, 0, this.ppoDimsHost);
      return this.ppoDimsBuffer;
    }

    packPpoBatch(batch, scratch) {
      const B = batch.actions.length;
      const feats = scratch.featsHost;
      const samples = scratch.samplesHost;
      feats.fill(0);
      samples.fill(0);
      for (let i = 0; i < B; i += 1) {
        packRollFeatures(
          batch.observations[i].grid,
          batch.observations[i].aux,
          feats.subarray(i * ROLL_IN, (i + 1) * ROLL_IN),
          batch.observations[i]
        );
        const mask = batch.observations[i].mask;
        let bits = 0;
        for (let a = 0; a < N_ACTIONS; a += 1) {
          if (!mask || mask[a] !== false) bits |= 1 << a;
        }
        const o = i * PPO_SAMPLE_STRIDE;
        samples[o] = batch.actions[i];
        samples[o + 1] = batch.logp[i];
        samples[o + 2] = batch.advantages[i];
        samples[o + 3] = batch.returns[i];
        samples[o + 4] = bits;
      }
      this.device.queue.writeBuffer(scratch.feats, 0, feats);
      this.device.queue.writeBuffer(scratch.samples, 0, samples);
    }

    async warmupPpoMega(salo = false) {
      const param = salo ? this.rollParamSalo : this.rollParam;
      const pipeline = salo ? this.pipelines.ppoMegaSalo : this.pipelines.ppoMega;
      const weights = salo ? this.rollWSalo : this.rollW;
      const scratch = this.ppoScratch(1, salo ? SALO_IN : ROLL_IN);
      this.zero(param.grad, param.bytes);
      const dims = this.writePpoDims({
        batch: 1,
        nActions: N_ACTIONS,
        clip: 0.2,
        valueCoef: 0.5,
        entropyCoef: 0.01
      });
      this.dispatch(
        pipeline,
        this.bind(pipeline, [weights, scratch.feats, scratch.samples, param.grad, scratch.stats, dims]),
        1
      );
      await this.device.queue.onSubmittedWorkDone();
    }

    async adamRoll(lr, param = this.rollParam) {
      if (!param) return;
      if (!this.adamUniform) {
        this.adamUniform = this.device.createBuffer({
          size: 32,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this.adamHost = new Float32Array(8);
      }
      this.rollAdam.t = (this.rollAdam.t || 0) + 1;
      this.adamHost[0] = lr;
      this.adamHost[1] = 0.9;
      this.adamHost[2] = 0.999;
      this.adamHost[3] = 1e-8;
      this.adamHost[4] = this.rollAdam.t;
      this.device.queue.writeBuffer(this.adamUniform, 0, this.adamHost);
      this.dispatch(
        this.pipelines.adam,
        this.bind(this.pipelines.adam, [param.buffer, param.grad, param.m, param.v, this.adamUniform]),
        Math.ceil(param.length / 64)
      );
    }

    async readRollWeights() {
      if (!this.rollParam) return this.rollWHost;
      const data = await this.readF32(this.rollParam.buffer, this.rollParam.length);
      if (this.rollWHost) this.rollWHost.set(data);
      return data;
    }

    async updateRolloutGpu(batch, config = {}) {
      const B = batch.actions.length;
      if (!B) return { policyLoss: 0, valueLoss: 0, entropy: 0 };
      const clip = config.clip == null ? 0.2 : config.clip;
      const valueCoef = config.valueCoef == null ? 0.5 : config.valueCoef;
      const entropyCoef = config.entropyCoef == null ? 0.01 : config.entropyCoef;
      const lr = config.lr == null ? 3e-4 : config.lr;
      const salo = this.usingSalo;
      const rin = salo ? SALO_IN : ROLL_IN;
      const param = salo ? this.rollParamSalo : this.rollParam;
      const pipeline = salo ? this.pipelines.ppoMegaSalo : this.pipelines.ppoMega;
      const weights = salo ? this.rollWSalo : this.rollW;
      const scratch = this.ppoScratch(B, rin);
      this.packPpoBatch(batch, scratch);
      this.zero(param.grad, param.bytes);
      const dims = this.writePpoDims({
        batch: B,
        nActions: N_ACTIONS,
        clip,
        valueCoef,
        entropyCoef
      });
      const encoder = this.device.createCommandEncoder();
      this.dispatch(
        pipeline,
        this.bind(pipeline, [weights, scratch.feats, scratch.samples, param.grad, scratch.stats, dims]),
        1,
        1,
        encoder
      );
      this.device.queue.submit([encoder.finish()]);
      await this.adamRoll(lr, param);
      const stats = await this.readF32(scratch.stats, 4);
      return {
        policyLoss: stats[0],
        valueLoss: stats[1],
        entropy: stats[2]
      };
    }

    zero(buffer, bytes) {
      let zeros = this.zeroHost.get(bytes);
      if (!zeros) {
        zeros = new Float32Array(bytes / 4);
        this.zeroHost.set(bytes, zeros);
      }
      this.device.queue.writeBuffer(buffer, 0, zeros);
    }

    syncBiasPack() {
      const encoder = this.device.createCommandEncoder();
      encoder.copyBufferToBuffer(this.params.b1.buffer, 0, this.biasPack, 0, H1 * 4);
      encoder.copyBufferToBuffer(this.params.b2.buffer, 0, this.biasPack, H1 * 4, H2 * 4);
      encoder.copyBufferToBuffer(this.params.b3.buffer, 0, this.biasPack, (H1 + H2) * 4, OUT * 4);
      this.device.queue.submit([encoder.finish()]);
    }

    writeBoardCapture(host, b, cap) {
      const base = b * BOARD_STRIDE;
      const terrain = cap.terrain;
      const actors = cap.actors;
      const startTerrain = cap.startTerrain || terrain;
      const startActors = cap.startActors || actors;
      const prevTerrain = cap.prevTerrain || terrain;
      const prevActors = cap.prevActors || actors;
      if (terrain) {
        for (let i = 0; i < GRID * GRID; i += 1) host[base + B_TER + i] = terrain[i] | 0;
      } else if (cap.under) {
        for (let i = 0; i < GRID * GRID; i += 1) {
          host[base + B_OCC + i] = (cap.grid[i] | 0) | ((cap.groups && cap.groups[i] ? cap.groups[i] : 0) << 8);
          host[base + B_TER + i] = cap.under[i] | 0;
        }
      }
      if (cap.occ && cap.occ.length) {
        for (let i = 0; i < GRID * GRID; i += 1) host[base + B_OCC + i] = cap.occ[i] | 0;
      } else if (cap.grid) {
        for (let i = 0; i < GRID * GRID; i += 1) {
          host[base + B_OCC + i] = (cap.grid[i] | 0) | ((cap.groups && cap.groups[i] ? cap.groups[i] : 0) << 8);
        }
      }
      if (actors) {
        host.set(actors, base + B_ACT);
        for (let n = 0; n < (cap.nActors || 0); n += 1) {
          const meta = actors[n * 2];
          const pos = actors[n * 2 + 1];
          const kind = meta & 255;
          if (kind !== 21) continue;
          const dir = (meta >> 16) & 255;
          const x = pos & 255;
          const y = (pos >> 8) & 255;
          const idx = y * GRID + x;
          host[base + B_OCC + idx] = (host[base + B_OCC + idx] & 65535) | (dir << 16);
        }
      }
      const startGrid = cap.startGrid || cap.grid;
      if (startTerrain) host.set(startTerrain, base + B_START_TER);
      if (cap.startOcc && cap.startOcc.length) {
        for (let i = 0; i < GRID * GRID; i += 1) host[base + B_START_ACT + i] = cap.startOcc[i] | 0;
      } else if (startGrid) {
        for (let i = 0; i < GRID * GRID; i += 1) {
          host[base + B_START_ACT + i] = (startGrid[i] | 0) | ((cap.startGroups && cap.startGroups[i] ? cap.startGroups[i] : cap.groups && cap.groups[i] ? cap.groups[i] : 0) << 8);
        }
      } else if (startActors) host.set(startActors, base + B_START_ACT);
      if (prevTerrain) host.set(prevTerrain, base + B_PREV_TER);
      if (prevActors) host.set(prevActors, base + B_PREV_ACT);
      host[base + B_META] = cap.nActors || 0;
      host[base + B_META + 1] = cap.playerId == null ? 0xffffffff : cap.playerId;
      host[base + B_META + 2] = cap.width || GRID;
      host[base + B_META + 3] = cap.height || GRID;
      host[base + B_META + 4] = cap.flags || 0;
      host[base + B_META + 5] = cap.startPx == null ? cap.px || 0 : cap.startPx;
      host[base + B_META + 6] = cap.startPy == null ? cap.py || 0 : cap.startPy;
      host[base + B_META + 7] = cap.startDead ? 1 : 0;
      host[base + B_META + 8] = cap.startGemCount || 0;
      host[base + B_META + 9] = cap.roomCol || 0;
      host[base + B_META + 10] = cap.roomRow || 0;
      host[base + B_META + 11] = cap.startRoomCol == null ? cap.roomCol || 0 : cap.startRoomCol;
      host[base + B_META + 12] = cap.startRoomRow == null ? cap.roomRow || 0 : cap.startRoomRow;
      host[base + B_META + 13] = cap.pe || 0;
      host[base + B_META + 14] = cap.startPe == null ? cap.pe || 0 : cap.startPe;
      const visited = cap.visited || [];
      for (let v = 0; v < 8; v += 1) host[base + B_META + 16 + v] = visited[v] | 0;
      const bankN = WORLD_ROOMS * ROOM_BIT_WORDS;
      const rid = ((cap.roomRow || 0) * WORLD_W + (cap.roomCol || 0)) | 0;
      if (cap.gemMask && cap.gemMask.length) host.set(cap.gemMask.subarray(0, Math.min(cap.gemMask.length, bankN)), base + B_GEM);
      if (cap.pushMask && cap.pushMask.length) {
        host.set(cap.pushMask.subarray(0, Math.min(cap.pushMask.length, bankN)), base + B_PUSH);
      } else {
        const seenPush = cap.seenPush || [];
        for (let s = 0; s < ROOM_BIT_WORDS; s += 1) host[base + B_PUSH + rid * ROOM_BIT_WORDS + s] = seenPush[s] | 0;
      }
      if (cap.seenBank && cap.seenBank.length) {
        host.set(cap.seenBank.subarray(0, Math.min(cap.seenBank.length, bankN)), base + B_SEEN);
      } else {
        const seen = cap.seen || [];
        for (let s = 0; s < ROOM_BIT_WORDS; s += 1) host[base + B_SEEN + rid * ROOM_BIT_WORDS + s] = seen[s] | 0;
      }
    }

    rolloutScratch(batch, steps) {
      const key = `roll:${batch}:${steps}:engine`;
      let buffers = this.scratch.get(key);
      if (buffers) return buffers;
      const boardInts = batch * BOARD_STRIDE;
      buffers = {
        board: this.device.createBuffer({
          size: this.bufferSize(boardInts * 4),
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
        }),
        head: this.device.createBuffer({
          size: this.bufferSize(batch * 24 * 4),
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
        }),
        forced: this.device.createBuffer({
          size: this.bufferSize(batch * steps * 4),
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }),
        out: this.empty(batch * steps * ROLL_STRIDE),
        grids: this.device.createBuffer({
          size: this.bufferSize(batch * steps * GRID * GRID),
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
        }),
        boardHost: new Uint32Array(boardInts),
        headHost: new Uint32Array(batch * 24),
        forcedHost: new Uint32Array(batch * steps),
        outHost: new Float32Array(batch * steps * ROLL_STRIDE),
        gridHost: new Uint8Array(batch * steps * GRID * GRID),
        peer: this.empty(PEER_FLOATS),
        peerHost: new Float32Array(PEER_FLOATS)
      };
      this.scratch.set(key, buffers);
      return buffers;
    }

    async gpuRollout(captures, steps, options = {}) {
      return this.span("ppo.gpuRollout", async () => {
        const batch = captures.length;
        const scratch = this.rolloutScratch(batch, steps);
        const maxActions = options.maxActions || Math.max(steps + 32, 64);
        const gemWeight = options.gemWeight ?? 1;
        const roomWeight = options.roomWeight ?? 0.1;
        const pushWeight = options.pushWeight ?? 0.05;
        const noveltyBonus = options.noveltyBonus ?? 0.01;
        const deathPenalty = options.deathPenalty ?? -0.05;
        const saloCoef = options.saloCoef ?? 0;
        const meanScore = options.meanScore ?? 0;
        const bestScore = options.bestScore ?? 0;
        const salo = Number(saloCoef) !== 0;
        const cellCount = batch * GRID * GRID;
        scratch.boardHost.fill(0);
        for (let b = 0; b < batch; b += 1) {
          const cap = captures[b];
          this.writeBoardCapture(scratch.boardHost, b, cap);
          const h = b * 24;
          scratch.headHost[h] = cap.px | 0;
          scratch.headHost[h + 1] = cap.py | 0;
          scratch.headHost[h + 2] = cap.yaw | 0;
          scratch.headHost[h + 3] = cap.pitch | 0;
          scratch.headHost[h + 4] = cap.dead ? 1 : 0;
          scratch.headHost[h + 5] = cap.gemCount | 0;
          scratch.headHost[h + 6] = cap.actionCount | 0;
          scratch.headHost[h + 7] = (options.seed || 1) + b * 997;
          const seen = cap.seen || [];
          const seenPush = cap.seenPush || [];
          for (let s = 0; s < 8; s += 1) {
            scratch.headHost[h + 8 + s] = seen[s] | 0;
            scratch.headHost[h + 16 + s] = seenPush[s] | 0;
          }
        }
        scratch.forcedHost.fill(0xffffffff);
        const forced = options.actions;
        if (forced) {
          if (Array.isArray(forced[0])) {
            for (let t = 0; t < steps; t += 1) {
              for (let b = 0; b < batch; b += 1) {
                const value = forced[t] && forced[t][b];
                if (value != null && value >= 0 && value < N_ACTIONS) scratch.forcedHost[t * batch + b] = value;
              }
            }
          } else {
            for (let t = 0; t < Math.min(steps, forced.length); t += 1) {
              const value = forced[t];
              if (value != null && value >= 0 && value < N_ACTIONS) scratch.forcedHost[t] = value;
            }
          }
        }
        this.device.queue.writeBuffer(scratch.board, 0, scratch.boardHost);
        this.device.queue.writeBuffer(scratch.head, 0, scratch.headHost);
        this.device.queue.writeBuffer(scratch.forced, 0, scratch.forcedHost);
        scratch.peerHost.fill(0);
        if (options.peerVisit) scratch.peerHost.set(options.peerVisit, 0);
        if (options.peerScore) scratch.peerHost.set(options.peerScore, CELL_N);
        this.device.queue.writeBuffer(scratch.peer, 0, scratch.peerHost);
        const dims = this.writeRolloutDims({
          batch,
          steps,
          nActions: N_ACTIONS,
          maxActions,
          gemWeight,
          roomWeight,
          pushWeight,
          noveltyBonus,
          deathPenalty,
          saloCoef,
          meanScore,
          bestScore
        });
        this.usingSalo = salo;
        const needSlope =
          options.slopes === true || captures.some((cap) => ((cap && cap.flags) || 0) & (32 | 64 | 4));
        const rollPipe = salo
          ? needSlope
            ? this.pipelines.rolloutSaloSlope
            : this.pipelines.rolloutSalo
          : needSlope
            ? this.pipelines.rolloutSlope
            : this.pipelines.rollout;
        const encoder = this.device.createCommandEncoder();
        const rollBinds = [
          salo ? this.rollWSalo : this.rollW,
          scratch.board,
          scratch.head,
          scratch.out,
          scratch.grids,
          scratch.forced,
          dims
        ];
        if (salo) rollBinds.push(scratch.peer);
        const atlas = captures[0] && captures[0].worldAtlas;
        if (atlas && atlas.length) {
          if (atlas.length <= this.worldHost.length) this.worldHost.set(atlas);
          this.device.queue.writeBuffer(this.worldBuffer, 0, this.worldHost);
        }
        rollBinds.push(this.worldBuffer);
        this.dispatch(
          rollPipe,
          this.bind(rollPipe, rollBinds),
          batch,
          1,
          encoder
        );
        const packedFloats = batch * steps * ROLL_STRIDE;
        const gridCount = batch * steps * GRID * GRID;
        const gridWords = gridCount / 4;
        const packedBytes = this.bufferSize(packedFloats * 4);
        const gridBytes = this.bufferSize(gridCount);
        let packedStaging = this.staging.get(`roll-out:${packedBytes}`);
        if (!packedStaging) {
          packedStaging = this.device.createBuffer({
            size: packedBytes,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
          });
          this.staging.set(`roll-out:${packedBytes}`, packedStaging);
        }
        let gridStaging = this.staging.get(`roll-grid:${gridBytes}`);
        if (!gridStaging) {
          gridStaging = this.device.createBuffer({
            size: gridBytes,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
          });
          this.staging.set(`roll-grid:${gridBytes}`, gridStaging);
        }
        const headBytes = this.bufferSize(batch * 24 * 4);
        let headStaging = this.staging.get(`roll-head:${headBytes}`);
        if (!headStaging) {
          headStaging = this.device.createBuffer({
            size: headBytes,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
          });
          this.staging.set(`roll-head:${headBytes}`, headStaging);
        }
        const boardBytes = this.bufferSize(batch * BOARD_STRIDE * 4);
        let boardStaging = this.staging.get(`roll-board:${boardBytes}`);
        if (!boardStaging) {
          boardStaging = this.device.createBuffer({
            size: boardBytes,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
          });
          this.staging.set(`roll-board:${boardBytes}`, boardStaging);
        }
        encoder.copyBufferToBuffer(scratch.out, 0, packedStaging, 0, packedBytes);
        encoder.copyBufferToBuffer(scratch.grids, 0, gridStaging, 0, gridBytes);
        encoder.copyBufferToBuffer(scratch.head, 0, headStaging, 0, headBytes);
        encoder.copyBufferToBuffer(scratch.board, 0, boardStaging, 0, boardBytes);
        this.device.queue.submit([encoder.finish()]);
        await Promise.all([
          packedStaging.mapAsync(GPUMapMode.READ),
          gridStaging.mapAsync(GPUMapMode.READ),
          headStaging.mapAsync(GPUMapMode.READ),
          boardStaging.mapAsync(GPUMapMode.READ)
        ]);
        scratch.outHost.set(new Float32Array(packedStaging.getMappedRange()).subarray(0, packedFloats));
        scratch.gridHost.set(new Uint8Array(gridStaging.getMappedRange(), 0, gridWords * 4));
        scratch.headHost.set(new Uint32Array(headStaging.getMappedRange()).subarray(0, batch * 24));
        scratch.boardHost.set(new Uint32Array(boardStaging.getMappedRange()).subarray(0, batch * BOARD_STRIDE));
        packedStaging.unmap();
        gridStaging.unmap();
        headStaging.unmap();
        boardStaging.unmap();
        const packed = scratch.outHost;
        const actions = [];
        const logp = [];
        const values = [];
        const rewards = [];
        const dones = [];
        const grids = [];
        const cellN = GRID * GRID;
        for (let t = 0; t < steps; t += 1) {
          const aRow = [];
          const lRow = [];
          const vRow = [];
          const rRow = [];
          const dRow = [];
          const gRow = [];
          for (let b = 0; b < batch; b += 1) {
            const o = (t * batch + b) * ROLL_STRIDE;
            aRow.push(packed[o] | 0);
            lRow.push(packed[o + 1]);
            vRow.push(packed[o + 2]);
            rRow.push(packed[o + 3]);
            dRow.push(packed[o + 4] > 0.5);
            const src = (t * batch + b) * cellN;
            gRow.push(scratch.gridHost.slice(src, src + cellN));
          }
          actions.push(aRow);
          logp.push(lRow);
          values.push(vRow);
          rewards.push(rRow);
          dones.push(dRow);
          grids.push(gRow);
        }
        const nextCaptures = captures.map((cap, b) => {
          const h = b * 24;
          const base = b * BOARD_STRIDE;
          const lastGrid = grids[steps - 1] ? grids[steps - 1][b] : cap.grid;
          const seen = new Uint32Array(8);
          const seenPush = new Uint32Array(8);
          const groups = new Uint8Array(cellN);
          const occ = scratch.boardHost.slice(base + B_OCC, base + B_OCC + cellN);
          if (occ.length) {
            for (let i = 0; i < cellN; i += 1) groups[i] = (occ[i] >> 8) & 255;
          } else if (cap.groups) {
            groups.set(cap.groups);
          }
          for (let s = 0; s < 8; s += 1) {
            seen[s] = scratch.headHost[h + 8 + s];
            seenPush[s] = scratch.headHost[h + 16 + s];
          }
          const terrain = scratch.boardHost.slice(base + B_TER, base + B_TER + cellN);
          const actors = scratch.boardHost.slice(base + B_ACT, base + B_ACT + MAX_ACTORS * 2);
          const under = new Uint8Array(cellN);
          for (let i = 0; i < cellN; i += 1) under[i] = terrain[i] & 255;
          const startOcc = scratch.boardHost.slice(base + B_START_ACT, base + B_START_ACT + cellN);
          const startGrid = new Uint8Array(cellN);
          const startGroups = new Uint8Array(cellN);
          for (let i = 0; i < cellN; i += 1) {
            startGrid[i] = startOcc[i] & 255;
            startGroups[i] = (startOcc[i] >> 8) & 255;
          }
          const bankN = WORLD_ROOMS * ROOM_BIT_WORDS;
          return {
            grid: lastGrid,
            occ,
            pe: scratch.boardHost[base + B_META + 13] | 0,
            under,
            groups,
            terrain,
            actors,
            nActors: scratch.boardHost[base + B_META] | 0,
            playerId: scratch.boardHost[base + B_META + 1],
            width: scratch.boardHost[base + B_META + 2] | 0,
            height: scratch.boardHost[base + B_META + 3] | 0,
            flags: scratch.boardHost[base + B_META + 4] | 0,
            startTerrain: scratch.boardHost.slice(base + B_START_TER, base + B_START_TER + cellN),
            startActors: cap.startActors || (cap.actors && cap.actors.slice && cap.actors.slice()),
            startNActors: cap.startNActors || cap.nActors,
            startPlayerId: cap.startPlayerId,
            startGrid,
            startOcc,
            startGroups,
            startPx: scratch.boardHost[base + B_META + 5] | 0,
            startPy: scratch.boardHost[base + B_META + 6] | 0,
            startPe: scratch.boardHost[base + B_META + 14] | 0,
            startDead: (scratch.boardHost[base + B_META + 7] | 0) !== 0,
            startGemCount: scratch.boardHost[base + B_META + 8] | 0,
            roomCol: scratch.boardHost[base + B_META + 9] | 0,
            roomRow: scratch.boardHost[base + B_META + 10] | 0,
            startRoomCol: scratch.boardHost[base + B_META + 11] | 0,
            startRoomRow: scratch.boardHost[base + B_META + 12] | 0,
            visited: scratch.boardHost.slice(base + B_META + 16, base + B_META + 24),
            gemMask: scratch.boardHost.slice(base + B_GEM, base + B_GEM + bankN),
            pushMask: scratch.boardHost.slice(base + B_PUSH, base + B_PUSH + bankN),
            seenBank: scratch.boardHost.slice(base + B_SEEN, base + B_SEEN + bankN),
            worldAtlas: cap.worldAtlas,
            prevTerrain: scratch.boardHost.slice(base + B_PREV_TER, base + B_PREV_TER + cellN),
            prevActors: scratch.boardHost.slice(base + B_PREV_ACT, base + B_PREV_ACT + MAX_ACTORS * 2),
            px: scratch.headHost[h] | 0,
            py: scratch.headHost[h + 1] | 0,
            yaw: scratch.headHost[h + 2] | 0,
            pitch: scratch.headHost[h + 3] | 0,
            dead: (scratch.headHost[h + 4] | 0) !== 0,
            gemCount: scratch.headHost[h + 5] | 0,
            actionCount: scratch.headHost[h + 6] | 0,
            seen,
            seenPush,
            episodeReward: cap.episodeReward || 0
          };
        });
        return { actions, logp, values, rewards, dones, packed, grids, nextCaptures };
      });
    }

    async adamStep(lr) {
      if (!this.adamUniform) {
        this.adamUniform = this.device.createBuffer({
          size: 32,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this.adamHost = new Float32Array(8);
      }
      this.adamHost[0] = lr;
      this.adamHost[1] = 0.9;
      this.adamHost[2] = 0.999;
      this.adamHost[3] = 1e-8;
      this.adamHost[4] = this.adamT;
      this.device.queue.writeBuffer(this.adamUniform, 0, this.adamHost);
      for (const name of ["W1", "b1", "W2", "b2", "W3", "b3"]) {
        const p = this.params[name];
        this.dispatch(
          this.pipelines.adam,
          this.bind(this.pipelines.adam, [p.buffer, p.grad, p.m, p.v, this.adamUniform]),
          Math.ceil(p.length / 64)
        );
      }
    }
  }

  rootObject().TrainPpo = {
    AUX_DIM,
    CELL_TYPES,
    EMBED,
    GRID,
    H1,
    H2,
    INPUT,
    N_ACTIONS,
    OUT,
    PPO_SAMPLE_STRIDE,
    ROLL_H,
    ROLL_IN,
    SALO_IN,
    ROLL_W_LEN,
    ROLL_STRIDE,
    WebGpuPpo,
    compactForward,
    compactPpoUpdate,
    computeGae,
    createRollPolicy,
    createSaloMemory,
    updateSaloMemory,
    embedObservation,
    maskedLogits,
    packRollFeatures,
    sampleAction,
    softmax
  };
})();
