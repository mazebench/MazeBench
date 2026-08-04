"use strict";

const fs = require("fs");
const { execFileSync } = require("child_process");

function selectSuccessfulCiRun(runs, commit) {
  const normalizedCommit = String(commit || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalizedCommit)) {
    throw new Error("Release CI resolver requires an exact 40-character commit SHA.");
  }

  const matches = (Array.isArray(runs) ? runs : [])
    .filter((run) => (
      String(run?.head_sha || "").toLowerCase() === normalizedCommit &&
      run?.head_branch === "main" &&
      run?.name === "CI" &&
      run?.event === "push" &&
      run?.status === "completed" &&
      run?.conclusion === "success"
    ))
    .sort((left, right) => (
      new Date(right.updated_at || right.created_at || 0) -
      new Date(left.updated_at || left.created_at || 0)
    ));

  if (!matches.length) {
    throw new Error(
      `No successful main CI run produced release artifacts for ${normalizedCommit}.`
    );
  }
  if (!Number.isSafeInteger(matches[0].id) || matches[0].id <= 0) {
    throw new Error("The successful CI run has an invalid run ID.");
  }
  return matches[0];
}

async function resolveReleaseCiRun({
  apiUrl = process.env.GITHUB_API_URL || "https://api.github.com",
  commit,
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GITHUB_TOKEN
} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repository || ""))) {
    throw new Error("GITHUB_REPOSITORY must be an owner/repository pair.");
  }
  if (!token) throw new Error("GITHUB_TOKEN is required to read CI artifacts.");

  const url = new URL(`/repos/${repository}/actions/runs`, apiUrl);
  url.searchParams.set("head_sha", commit);
  url.searchParams.set("event", "push");
  url.searchParams.set("status", "completed");
  url.searchParams.set("per_page", "100");
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28"
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    throw new Error(`GitHub CI lookup returned HTTP ${response.status}.`);
  }
  const payload = await response.json();
  return selectSuccessfulCiRun(payload.workflow_runs, commit);
}

async function main() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8"
  }).trim();
  const run = await resolveReleaseCiRun({ commit });
  if (!process.env.GITHUB_OUTPUT) {
    throw new Error("GITHUB_OUTPUT is required to publish the verified run ID.");
  }
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${run.id}\n`, "utf8");
  console.log(`Using verified CI run ${run.id} for ${commit}.`);
}

module.exports = {
  resolveReleaseCiRun,
  selectSuccessfulCiRun
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
