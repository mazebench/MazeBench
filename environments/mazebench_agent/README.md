# MazeBench Agent (retired)

This legacy taskset is intentionally disabled. It placed the MazeBench runtime
and hidden game state inside the evaluated coding agent's sandbox, violating the
benchmark's isolation boundary.

Use the canonical `mazebench-tools` taskset from `environments/mazebench`.
That taskset keeps the game and scoring evaluator-owned, gives the agent only an
external tool connection, and exposes sanitized game actions instead of shell or
filesystem access.

Use `scripts/maze-prime-run.js` through the Agent page for the approved,
game-tools-only launch path.
