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

## Modes

- **Play** — explore the main world or a local world.
- **Build** — create and edit worlds stored on your machine.
- **Agent** — run isolated Prime Intellect Verifiers agents against the maze.

## Agent runs

The Agent page sends model turns through a fixed evaluator-side relay that
advertises exactly four game-control tools. The authoritative game and its MCP
server run in a separate, networkless Docker sandbox with no host mounts. The
model receives no shell, filesystem, subprocess, network, repository, hidden
state, or scoring capability. Replay video also requires a Chromium-family
browser and `ffmpeg`. Run `mazebench --help` for commands and options.

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
