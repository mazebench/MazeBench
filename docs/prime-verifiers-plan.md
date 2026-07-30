# Prime Verifiers Integration Notes

## What Prime Expects

Prime Intellect Verifiers environments are installable Python packages. Each environment package needs a `pyproject.toml`, a README, and an importable `load_environment()` function that returns a Verifiers environment.

The repo-level `uv add verifiers && prime lab setup --skip-install` command failed because `uv add` only works inside a Python project. For a repo without `pyproject.toml`, use either:

```bash
prime lab setup
```

or the explicit two-step version:

```bash
uv init
uv add verifiers
prime lab setup --skip-install
```

In this repo, `prime lab setup` successfully initialized the Python project and installed `verifiers`, then hit a Prime-side 404 while downloading some starter config files. The important local pieces are now present: `pyproject.toml`, `uv.lock`, `.venv`, `.prime/skills`, `configs/endpoints.toml`, and `environments/mazebench`.

## Current Project Shape

The web game is Node/browser-first. The canonical rules surface appears to be:

- `public/maze-engine.js`: movement, collision, solved-state, elevation, push, ice, holes, gates, lifts.
- `public/maze-solver.js`: A* solver over the JS engine.
- `server/maze-levels.js`: converts text level files and parser metadata into browser play data.
- `games/maze/levels/*.txt`: current level corpus.
- `games/maze/level_parsing.json` and `games/maze/world_parsing.json`: token and world-size metadata.

The Python `games/maze/player.py` implementation is useful but currently behind the web engine: it does not model every newer browser token/type. Treat the JS engine as canonical until a shared runtime is extracted.

## Current Benchmark Architecture

The JavaScript engine remains the source of truth. Local model evaluations use
the `mazebench-tools` taskset and a fixed evaluator-side relay that advertises
only `game_start`, `game_observe`, `game_action`, and
`game_action_sequence`. Each rollout starts an independent networkless Docker
container for the authoritative Node tool server. The container has no host
mounts; the model receives only sanitized tool schemas and results.

The direct native `mazebench` taskset and arbitrary coding harnesses are
retired. Hosted Training still uses the separate classic `load_environment()`
adapter because the model is remote and receives messages rather than a host
agent runtime.

Before publishing to the Environments Hub:
   - Ensure `environments/mazebench/pyproject.toml` includes all package files and data.
   - Run `prime env install mazebench`.
   - Run the certified local game-relay smoke tests.
   - Update the package version.
   - Push with `prime env push --path ./environments/mazebench --visibility PUBLIC` or `PRIVATE`.

## Publication Checklist

- `README.md` explains task format, arguments, metrics, and dataset source.
- `load_environment()` is cheap to import and all expensive loading happens lazily.
- Dependencies are listed in `[project.dependencies]`; do not rely on `[tool.uv.sources]` for Hub installs.
- Rewards accept alternate valid paths, not only the solver's reference path.
- Terminal runner and verifier share the same ASCII renderer.
- JS and Python/OpenEnv simulators have parity tests for each token class before large-scale evals.

## Tool-server direction

The Python evaluator owns lifecycle, sanitization, and scoring while the actual
game runtime stays Node. Game commands remain strings inside the bounded
`game_action` and `game_action_sequence` tools, keeping the model-facing
capability set fixed even as the maze command vocabulary evolves.

For the first isometric ASCII pass, each visible tile is a 4x4 character block. Camera pitch has five positions:

```text
top:          4 top rows, 0 side rows
top-diagonal: 3 top rows, 1 side row
diagonal:     2 top rows, 2 side rows
side-diagonal:1 top row,  3 side rows
side:         0 top rows, 4 side rows
```

Objects use explicit `top/side` glyph pairs, so the ASCII renderer can keep
every visible object distinct even when the set is larger than the alphabet.
The repo-local terminal runner and packaged mazebench runtime use the same
glyph contract.
Player lifts use `>` on top when lowered, `L` on top when raised, and `l` on
their sides. Orange walls use `O` on top and `o` on their sides, where `o` is a
face character rather than a lowered-state sprite. Orange buttons are top-only
surface attachments rendered as `8`, with no side face. Pressing a button moves
the wall geometry down one elevation, with only the top face remaining visible
when the lowered volume overlaps supporting terrain.
For example, floor uses `A/a` and renders from top-down through side view as:

```text
AAAA
AAAA
AAAA
AAAA

AAAA
AAAA
AAAA
aaaa

AAAA
AAAA
aaaa
aaaa

AAAA
aaaa
aaaa
aaaa

aaaa
aaaa
aaaa
aaaa
```

The terminal prototype at `scripts/maze-terminal.js` is a local testbed for rendering and one-shot replay. Its `--json` output uses the same structured, model-facing observation contract as agent runners; `--solve` can explicitly add a JS solver reference. Initial ASCII state and the stateful Verifiers tool contract are backed by `scripts/maze-bridge.js`, a JSON-lines Node process that keeps room state, camera state, visited rooms, and monotonic unique gem IDs alive for the rollout.

## Sources

- Prime Verifiers README: https://github.com/PrimeIntellect-ai/verifiers
- Verifiers environments guide: https://docs.primeintellect.ai/verifiers/environments
- BYO Harness guide: https://docs.primeintellect.ai/verifiers/byo-harness
- Environments Hub create/upload guide: https://docs.primeintellect.ai/tutorials-environments/create
- Evaluation guide: https://docs.primeintellect.ai/tutorials-environments/evaluating
