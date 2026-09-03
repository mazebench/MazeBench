#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadBrowserScript } = require("./helpers/browser-module-loader");

loadBrowserScript("public/train-chart.js");
const chart = globalThis.TrainChart;
assert.ok(chart, "TrainChart should load");

function approx(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !≈ ${expected}`);
}

{
  const scale = chart.niceScale([0.05, 0.05, 0.05]);
  assert.ok(scale.min < 0.05, "constant reward must not sit on the axis");
  assert.ok(scale.max > 0.05);
  assert.ok(scale.max - scale.min < 0.5, `tiny reward should not blow up to 0–1, got ${scale.min}..${scale.max}`);
  assert.ok(scale.ticks.length >= 2);
}

{
  const scale = chart.niceScale([0, 0, 0]);
  assert.ok(scale.max > scale.min);
  assert.ok(scale.ticks.includes(0) || scale.min <= 0);
}

{
  const scale = chart.niceScale([172000, 175000, 180000, 178000]);
  assert.ok(scale.min > 50000, `fps auto y must not pin to 0, got min=${scale.min}`);
  assert.ok(scale.max >= 180000);
  scale.ticks.forEach((tick, index) => {
    if (index) approx(tick - scale.ticks[index - 1], scale.step, 1e-3);
  });
}

{
  const pinned = chart.niceScale([0, 0.2, 0.4], { pinZero: true });
  assert.equal(pinned.min, 0);
}

{
  const scale = chart.niceScale([-0.2, 0.1, 0.3]);
  assert.ok(scale.min < 0);
  assert.ok(scale.max > 0.3);
}

{
  const ticks = chart.chooseXTicks(239, 200);
  assert.equal(ticks[0], 0);
  assert.equal(ticks[ticks.length - 1], 239);
  assert.ok(ticks.length <= 8, `too many x ticks: ${ticks}`);
  for (let i = 1; i < ticks.length; i += 1) assert.ok(ticks[i] > ticks[i - 1]);
}

{
  const ticks = chart.chooseXTicks(10000, 220);
  assert.equal(ticks[0], 0);
  assert.equal(ticks[ticks.length - 1], 10000);
  assert.ok(ticks.length <= 10, `too many x ticks: ${ticks}`);
}

{
  const ticks = chart.chooseXTicks(0, 200);
  assert.deepEqual(ticks, [0]);
}

{
  assert.equal(chart.chooseXMax(10, 199), 10);
  assert.equal(chart.chooseXMax(0, 199), 0);
  assert.equal(chart.chooseXMax(250, 199), 250);
  assert.equal(chart.chooseXMax(4, null), 4);
}

{
  assert.equal(chart.bucketStride(8, 16), 1);
  assert.equal(chart.bucketStride(40, 16), 4);
  assert.equal(chart.bucketStride(45, 16), 4);
}

{
  const values = Array.from({ length: 100 }, (_, i) => i);
  const points = chart.downsampleStable(values, 10);
  assert.equal(points[0].x, 0);
  assert.equal(points[0].y, 0);
  assert.equal(points[points.length - 1].x, 99);
  assert.equal(points[points.length - 1].y, 99);
  assert.ok(points.length <= 12, `downsample should merge 100 → ~10, got ${points.length}`);
  const bucket = points.find((point) => point.x > 0 && point.x < 99);
  assert.ok(bucket, "merged buckets should exist");
  approx(bucket.y, bucket.x, 1);
}

{
  const points = chart.downsampleStable([2, 4, 6, 8], 2);
  assert.equal(points[0].x, 0);
  assert.equal(points[0].y, 2);
  assert.equal(points[points.length - 1].x, 3);
  assert.equal(points[points.length - 1].y, 8);
  const merged = points.filter((point) => point.x !== 0 && point.x !== 3);
  assert.ok(merged.some((point) => Math.abs(point.y - 3) < 1e-9));
  assert.ok(merged.some((point) => Math.abs(point.y - 7) < 1e-9));
}

{
  const points = chart.downsampleStable([1, 2, 3], 10);
  assert.deepEqual(points, [
    { x: 0, y: 1 },
    { x: 1, y: 2 },
    { x: 2, y: 3 }
  ]);
}

{
  const short = Array.from({ length: 40 }, (_, i) => Math.sin(i / 3));
  const grown = short.concat(Array.from({ length: 5 }, (_, i) => Math.sin((40 + i) / 3)));
  assert.equal(chart.bucketStride(short.length, 16), chart.bucketStride(grown.length, 16));
  const before = chart.downsampleStable(short, 16);
  const after = chart.downsampleStable(grown, 16);
  const closedBefore = before.filter((point) => point.x !== 0 && point.x !== short.length - 1);
  const closedAfter = after.filter((point) => point.x !== 0 && point.x < short.length - 0.5);
  assert.deepEqual(closedAfter, closedBefore, "complete buckets must not move when new samples arrive");
}

{
  const first = chart.advanceScale([0.05, 0.06, 0.04]);
  const same = chart.advanceScale([0.05, 0.055, 0.048], {}, first);
  assert.equal(same.scale.min, first.scale.min);
  assert.equal(same.scale.max, first.scale.max);
  const grown = chart.advanceScale([0.05, 4], {}, first);
  assert.ok(grown.scale.max > first.scale.max);
}

{
  assert.equal(chart.formatTick(0, 1), "0");
  assert.equal(chart.formatTick(185199, 1000).endsWith("k"), true);
  assert.match(chart.formatTick(0.05, 0.01), /^0\.0?5$/);
  assert.equal(chart.formatTick(2, 1), "2");
}

{
  const n = chart.niceNum(12, true);
  assert.ok([10, 20].includes(n), `niceNum 12 -> ${n}`);
}

{
  const trainJs = fs.readFileSync(path.join(__dirname, "..", "public", "train.js"), "utf8");
  assert.doesNotMatch(trainJs, /history\.reward\.length > 240/);
  assert.doesNotMatch(trainJs, /plannedUpdates \|\| 0\) - 1/);
  assert.match(trainJs, /chartView\.schedule/);
}

console.log("train-chart tests passed");
