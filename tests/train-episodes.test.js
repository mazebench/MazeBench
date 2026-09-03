#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "train.js"), "utf8");
assert.match(source, /function keepBestEpisodes/);
assert.doesNotMatch(source, /length > 80/);

const start = source.indexOf("function episodeReward");
const end = source.indexOf("function topEpisodes");
assert.ok(start >= 0 && end > start);
const sandbox = {};
vm.runInNewContext(`${source.slice(start, end)}\nthis.episodeReward = episodeReward;\nthis.keepBestEpisodes = keepBestEpisodes;`, sandbox);

function ep(reward) {
  return { reward, levelId: `r${reward}` };
}

{
  const list = [];
  for (let i = 0; i < 6; i += 1) {
    const placed = sandbox.keepBestEpisodes(list, ep(i * 0.1), 6);
    assert.equal(placed.changed, true);
  }
  assert.equal(list.length, 6);
}

{
  const list = [ep(4), ep(3), ep(2), ep(1.5), ep(1), ep(0.8)];
  const skipped = sandbox.keepBestEpisodes(list, ep(0.5), 6);
  assert.equal(skipped.changed, false);
  assert.equal(skipped.index, -1);
  assert.deepEqual(
    list.map((item) => item.reward),
    [4, 3, 2, 1.5, 1, 0.8]
  );
}

{
  const list = [ep(4), ep(3), ep(2), ep(1.5), ep(1), ep(0.8)];
  const tied = sandbox.keepBestEpisodes(list, ep(0.8), 6);
  assert.equal(tied.changed, false, "equal score must not kick out an incumbent");
  assert.equal(list[5].levelId, "r0.8");
}

{
  const list = [ep(4), ep(3), ep(2), ep(1.5), ep(1), ep(0.8)];
  const placed = sandbox.keepBestEpisodes(list, ep(2.5), 6);
  assert.equal(placed.changed, true);
  assert.equal(placed.index, 5);
  assert.equal(list[5].reward, 2.5);
  assert.ok(list.some((item) => item.reward === 4));
  assert.ok(!list.some((item) => item.reward === 0.8));
}

console.log("train-episodes tests passed");
