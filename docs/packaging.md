# Packaging the `mazebench` CLI

The `mazebench` command is defined by the repo-root [`pyproject.toml`](../pyproject.toml):

```toml
[project.scripts]
mazebench = "mazebench_cli:main"

[project.optional-dependencies]
prime = ["verifiers @ git+https://github.com/PrimeIntellect-ai/verifiers.git@main"]
```

The Python package (`mazebench_cli/`) is intentionally tiny — it has **no hard
Python dependencies**. It is a launcher that:

1. finds the repo root (`package.json` + `scripts/maze-bridge.js`, or
   `MAZEBENCH_REPO_ROOT`),
2. translates `key=value` arguments, and
3. execs the right tool: the repo's Node scripts for local play / replay, or
   `prime` / `uv` for the Prime Intellect path.

That design keeps `pip install` light, but it has one consequence worth stating
up front: **the CLI needs the repo's Node runtime present at run time.** Node.js
is required for every run; `ffmpeg` + a Chromium-family browser are required for
replay video.

## Mode A — install from a checkout (recommended, works today)

This is the fully-working path. Clone the repo, then editable-install:

```bash
uv pip install -e .            # or: pip install -e .
uv pip install -e ".[prime]"   # add the Verifiers integration
```

`mazebench` is now on your PATH and locates the checkout via the module's
location (or `MAZEBENCH_REPO_ROOT`), so it can find the Node scripts. This is
the right distribution mode for a dev tool like this.

To let teammates install straight from Git without cloning first:

```bash
pip install "mazebench @ git+https://github.com/mazebench/MazeBenchEngine.git"
```

Even then, set `MAZEBENCH_REPO_ROOT` (or run from a checkout) so the CLI can
reach the Node runtime — a bare Git install of just the Python package does not
ship `scripts/`, `server/`, or `public/`.

## Mode B — the self-contained PyPI wheel (implemented)

The published `mazebench` distribution bundles the whole Node site/runtime as
package data, so `pip install mazebench && mazebench launch` works without a
checkout. The pieces:

1. **Runtime staging** — `node scripts/build-python-runtime.js` copies
   `server.js`, `package.json`, `server/`, `public/`, `scripts/`,
   `games/maze/`, and the three.js vendor files (from `node_modules`) into
   `mazebench_cli/_runtime/` (gitignored). `server/app.js` falls back to the
   staged `vendor/` dir when `node_modules` is absent.
2. **Build** — `[tool.hatch.build.targets.wheel] artifacts` forces the staged
   (gitignored) runtime into the wheel/sdist. `python -m build` or `uv build`.
3. **Runtime resolution** — `mazebench_cli.resolve_root()` prefers a repo
   checkout; otherwise it materializes a writable workspace at
   `~/.mazebench/site` (override with `MAZEBENCH_HOME`) from the packaged
   runtime. Runtime code refreshes on version upgrades; user content
   (`games/draft-*`, master-world edits, `outputs/`, `data/`) is preserved.
4. **Launch** — `mazebench launch [port= host= open=]` runs `node server.js`
   from the resolved root and opens the browser.

### Publishing

`.github/workflows/publish.yml` builds and uploads on every GitHub Release
using PyPI **trusted publishing** (no stored tokens). One-time setup:

1. On PyPI: *Account → Publishing → Add a new pending publisher* with project
   `mazebench`, this repo, workflow `publish.yml`, environment `pypi`.
2. On GitHub: create an environment named `pypi` in the repo settings.
3. Release flow: bump `version` in `pyproject.toml`, publish a GitHub Release.

Manual fallback:

```bash
npm ci
node scripts/build-python-runtime.js
python -m build                # or: uv build
twine upload dist/*            # or: uv publish
```

Notes:

- The dist name is **`mazebench`** (both `mazebench` and `maze-bench` were
  free on PyPI as of 2026-07); the command is `mazebench` either way.
- **Python support**: `requires-python = ">=3.9"` with no upper bound — the
  CLI is a stdlib-only launcher, verified on 3.9 through 3.14 (CI smoke-tests
  the wheel on both ends of that range on every run).
- The `prime` extra depends on `verifiers>=0.1.14` from PyPI (the old direct
  Git URL would have been rejected by PyPI). Verifiers itself only supports
  Python `>=3.10,<3.14`, so the extra uses an environment marker: on other
  Pythons `pip install mazebench[prime]` still succeeds and simply skips
  verifiers — the prime path shells out to the `prime`/`uv` CLIs anyway, so
  nothing else changes.
- External prerequisites the wheel cannot bundle: **Node.js** (always),
  **ffmpeg + a Chromium-family browser** (replay videos), and **prime / uv**
  (the stock framework harness and game Toolset run in separate Prime
  Sandboxes). Local Codex, Claude, and Kimi coding-agent launch paths are retired.

## Note on the two `mazebench` packages

Don't confuse these:

- `mazebench_cli` (repo root) — the `mazebench` **command** described here.
- `environments/mazebench/` — the **Verifiers environment package** (also named
  `mazebench`) that `prime env install` / `uv run eval` consume. It has its own
  `pyproject.toml` and is published to the Prime Environments Hub, not PyPI.
