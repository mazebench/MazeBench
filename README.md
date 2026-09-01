# MazeBench

MazeBench is a local browser app for building and playing persistent 3D puzzle
worlds, then evaluating models in the same JavaScript engine.

## Quick start

Install from PyPI (Python 3.9+ and Node.js are required):

```bash
pip install mazebench
mazebench launch
```

Or run from a source checkout:

```bash
npm ci
npm run dev
```

The site opens at `http://localhost:3000`.

## Silent local computer controls

Install the checkout as an editable tool, then enter a named run:

```bash
uv tool install --editable . --force
computer login 09_01_fable_5_1
```

This opens a narrow, venv-like prompt. It is not a shell: only `action` is
accepted.

```text
(09_01_fable_5_1) action up
(09_01_fable_5_1) action down
(09_01_fable_5_1) action sequence UDLRDLLDLDR
(09_01_fable_5_1) action room HxI
(09_01_fable_5_1) action undo
(09_01_fable_5_1) action rotate up
(09_01_fable_5_1) action quit
```

Successful actions are silent. Each action appends one normalized line to
`~/records/<run>/moves.txt` and writes its resulting observation to
`move_history/move_<number>_<action>.txt`. Each move file contains only the
ASCII board—no JSON or metadata. The starting board is saved once as
`move_history/move_0.txt` without adding a line to `moves.txt`.
`current_board.txt` always holds the latest
ASCII board, while `current_state.json` contains only `died`, `gems`, and
`rooms_available`. Private server bookkeeping stays under the hidden
`~/records/.computer/` directory. `action quit` stops the local server and
leaves the mode without recording a quit move. A compact `action sequence`
accepts only `U`, `D`, `L`, and `R`, and records every step separately.
Previously visited rooms use compact names such as `HxI`; enter one with
`action room HxI`.

## Modes

- **Play** — explore the main world or a local world.
- **Build** — create and edit worlds stored on your machine.
- **Agent** — run isolated Prime Intellect Verifiers agents against the maze.

## Agent runs

The Agent page runs the stock Verifiers harness in an isolated Prime Sandbox.
MazeBench contributes a task-owned Toolset on the evaluator, which advertises
only the named game controls. The model
receives no shell, filesystem, subprocess, network, repository, hidden state,
or scoring capability. Replay video also requires a Chromium-family browser
and `ffmpeg`. Run `mazebench --help` for commands and options.

For Prime Intellect Verifiers:

```bash
pip install "mazebench[prime]"
mazebench prime install
mazebench prime eval model=openai/gpt-5-nano n=1 r=1
```

## Development

```bash
npm ci
npm test
```

Further documentation:

- [Prime environment](environments/mazebench/README.md)
- [Maze level format](docs/maze-level-format.md)
- [Python packaging](docs/packaging.md)

## License

[MIT](LICENSE)
