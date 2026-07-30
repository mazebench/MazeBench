# Codex Repository Instructions

These instructions apply to the entire MazeBenchEngine repository.

## Absolute isolation for benchmark agent runs

Benchmark agents must never be able to inspect MazeBenchEngine or any other repository. Treat repository or host-file access by the evaluated agent as cheating and as a run-launch failure, not as a supported tools mode.

- This rule applies to every agent run and every launch variant, including local, subscription, container, host, vision, text, tools-on, tools-off, offline, omniscient, hidden-name, swarm, worker, clone, continuation, and branch runs. Do not add mode-specific exceptions.
- Keep the trusted runner and game-control server separate from the evaluated agent. The runner may load the environment, but the evaluated model and every process or tool it can invoke must receive only the intended game observations and game-control interfaces.
- Never give the evaluated agent a repository working directory, repository mount, `--add-dir`, readable or writable repository root, host shell, unrestricted command execution, host filesystem search/read tool, repository-aware coding tool, repository MCP resource, or repository path in its prompt or environment.
- A tools-enabled benchmark may expose explicitly approved game-control tools and an explicitly approved, fail-closed computation tool whose only writable or persistent storage is the fresh run-scoped workspace below. The existing `python_exec` contract is the reference boundary: no host or repository files, no subprocesses, no network, bounded resources, and a launch-time isolation preflight. `offline`, `mode=vision`, `omniscient=false`, or a workspace-write sandbox alone do not provide repository isolation and must never be treated as if they do.
- Block access to source code, level definitions, world maps, solver code, tests, fixtures, hidden-state assets, scorecards, session files, run outputs, logs, prior-run artifacts, and sibling repositories. Do not allow indirect access through child processes, workers, clones, inherited file descriptors, symlinks, environment variables, or helper services.
- Give each evaluated agent a fresh, empty, run-scoped workspace containing no copied or linked repository content. Keep any agent-created notes or artifacts there only when the benchmark explicitly permits them.
- Launchers must fail closed before starting a run if the requested configuration, sandbox, tool set, working directory, mount set, or environment would expose repository or host files. Never silently launch with broader access.
- When changing agent launch code, preserve this boundary with automated tests that assert the evaluated agent cannot read repository or host files, launch subprocesses, use the network, or invoke host shell/file tools. A run that crosses this boundary is invalid even if it never changes game state.

## Branch-first development

- Do not commit or push ordinary work directly to `main` unless the user explicitly overrides this rule.
- Start work from the current `origin/main` on a focused `codex/<task>` branch.
- Commit and push the branch, run the relevant tests, and open a pull request for the user to review.
- Do not merge the pull request until the user says the branch is approved. After approval, enable auto-merge against the exact reviewed head SHA once the required PR smoke check is queued. For ordinary changes, hand off as soon as GitHub accepts auto-merge; report the PR as queued rather than merged until GitHub confirms it, and do not synchronously poll the duplicate full `main` CI. Releases, deployments, migrations, failing checks, and explicit user requests to monitor through completion still require synchronous verification.
- GitHub automatically deletes merged remote branches. At the start of the next repository task, confirm any queued merge completed, then remove its clean local topic branch and dedicated worktree and prune stale tracking references. Never delete `main`, a branch with an open pull request, a dirty worktree, or a branch containing unmerged work.
- Treat a branch as empty when it has no commits ahead of current `origin/main`. If an empty branch has no open pull request, delete it from `origin` and locally immediately; do not open or merge an empty pull request just to remove it.
- A branch push, pull request, or merge does not by itself authorize a package release.

## Explicit release gate

After an approved change is merged to `main` and CI is green, explicitly ask whether the user wants a new PyPI release. Include the proposed next version in the question and briefly state why the change warrants that version bump.

For an ordinary auto-merged handoff, defer this release question until the next repository task confirms that `main` CI is green; do not keep the prior task open solely to wait for the release gate. Never defer it during an explicitly requested release or deployment workflow.

Do not create a release tag, publish a GitHub Release, manually dispatch the PyPI workflow, or upload to PyPI until the user answers yes.

When the user approves the proposed release, that approval authorizes Codex to complete the release workflow without asking at every intermediate step:

1. Create a focused `codex/release-<version>` branch from current `origin/main`.
2. Update every root-package version source, including `[project].version` in `pyproject.toml` and `mazebench_cli.__version__`, and check for any other synchronized version references.
3. Build the packaged runtime, wheel, and source distribution; run the Node tests and supported Python wheel smoke tests.
4. Push the release branch, merge it after its checks pass, and verify `main` is green.
5. Create the repository's customary GitHub tag/release for that version. Unless the user requests a stable release, follow the existing alpha prerelease convention.
6. Monitor the `Publish to PyPI` workflow through completion and verify that the exact version is available from PyPI.

PyPI versions are immutable. If publishing partially succeeds, inspect PyPI before retrying and never attempt to upload different artifacts under the same version.

## Prime Environment Hub releases

The Prime environment under `environments/mazebench` has its own version and release lifecycle; it is not tied automatically to the root PyPI package version.

- Propose a Prime environment version bump only when the environment package, bundled runtime, behavior, packaging, or dependencies changed. Dependency-only changes count.
- Documentation-only or root-CLI-only changes do not require a Prime environment bump.
- When a Prime bump is warranted, include it in the post-merge release question alongside the PyPI proposal.
- After approval, update the environment package version and the version pin in `configs/rl/mazebench.toml`, push the environment, monitor the Hub action, and verify it reaches `SUCCESS`.

## MazeJam promotion

MazeJam consumes MazeBenchEngine assets but deploys independently through Cloudflare Pages. If an approved engine change alters assets consumed by MazeJam, mention that in the post-merge handoff and ask whether to synchronize and deploy MazeJam. Do not assume that a PyPI or Prime release also authorizes a site deployment.
