# Prime agent runtimes

MazeBench uses stock Prime runtime images. Verifiers installs the selected
harness during setup, then applies the runtime's execution policy before the
evaluated agent starts.

The evaluator-owned Toolset stays outside the agent runtime and serves only the
named game controls. The Codex runtime is a deny-all Prime VM; its version is
pinned in the harness configuration rather than baked into a MazeBench image.

`smoke.py` is retained for generic Prime runtime smoke checks.
