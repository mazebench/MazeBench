# Prime agent runtimes

MazeBench uses public Prime runtime images. Verifiers installs the selected
harness during setup, then applies the runtime's execution policy before the
evaluated agent starts.

The evaluator-owned Toolset stays outside the agent runtime, uses the public
`prime/prime/mazebench-playwright-python:v1.60.0-noble` VM image, and serves
only the named game controls. The Codex runtime is a deny-all Prime VM; its
version is pinned in the harness configuration rather than baked into a
MazeBench image.

`smoke.py` is retained for generic Prime runtime smoke checks.
