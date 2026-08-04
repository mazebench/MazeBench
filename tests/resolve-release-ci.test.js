"use strict";

const assert = require("assert");
const { selectSuccessfulCiRun } = require("../scripts/resolve-release-ci");

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function run(overrides = {}) {
  return {
    conclusion: "success",
    created_at: "2026-08-04T00:00:00Z",
    event: "push",
    head_branch: "main",
    head_sha: COMMIT,
    id: 101,
    name: "CI",
    status: "completed",
    updated_at: "2026-08-04T00:01:00Z",
    ...overrides
  };
}

assert.equal(selectSuccessfulCiRun([run()], COMMIT).id, 101);
assert.equal(
  selectSuccessfulCiRun([
    run({ id: 101 }),
    run({ id: 102, updated_at: "2026-08-04T00:02:00Z" })
  ], COMMIT).id,
  102
);

for (const invalid of [
  run({ conclusion: "failure" }),
  run({ event: "pull_request" }),
  run({ head_branch: "levelfix" }),
  run({ head_sha: "f".repeat(40) }),
  run({ name: "Publish to PyPI" }),
  run({ status: "in_progress" })
]) {
  assert.throws(
    () => selectSuccessfulCiRun([invalid], COMMIT),
    /No successful main CI run/
  );
}

assert.throws(
  () => selectSuccessfulCiRun([run()], "main"),
  /exact 40-character commit SHA/
);
assert.throws(
  () => selectSuccessfulCiRun([run({ id: "101" })], COMMIT),
  /invalid run ID/
);

console.log("resolve-release-ci: exact successful main artifact selected");
