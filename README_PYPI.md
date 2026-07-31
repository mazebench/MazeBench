# MazeBench

MazeBench is a local browser app for building and playing persistent 3D puzzle
worlds, then evaluating models against the same JavaScript engine.

## Install

Python 3.9+ and Node.js are required.

```bash
pip install mazebench
mazebench launch
```

This opens the Play, Build, and Agent modes. Run `mazebench --help` for other
commands.

Play directly in an ASCII terminal with arrow-key controls:

```bash
mazebench ascii
mazebench ascii --level CxD
```

Both `CxD` and the full `level_CxD` level ID are accepted.

Play interactively with the same controls while showing the structured JSON
observation a model receives, with literal object names and every room object
included:

```bash
mazebench json --level CxD --omniscient
```

Omit `--omniscient` to include only objects visible in the equivalent ASCII
view. Names are not hidden unless `--hide-names` is passed explicitly. JSON
arrays are kept on one line in the terminal. Pipe the output or pass `--once`
to print a single snapshot instead of starting an interactive session.

Agent runs require Prime Sandbox access. Verifiers runs its stock harness in
one sandbox and gives it four tools from the authoritative game server in a
second sandbox. Replay video requires a Chromium-family browser and `ffmpeg`.

[Website](https://mazebench.com) ·
[Source](https://github.com/mazebench/MazeBenchEngine)
