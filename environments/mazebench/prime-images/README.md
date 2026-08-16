# Prime agent image

MazeBench uses a private image for the evaluated Codex agent. The evaluator-owned
Toolset stays outside that runtime and serves only the named game controls.

- `codex-agent.Dockerfile` contains only the pinned Codex harness binary and its
  small base runtime. Verifiers launches the evaluated agent in this image.

Build the private image from `environments/mazebench`:

```sh
prime images push mazebench-codex-agent:0.144.5-v3 \
  --context . --dockerfile prime-images/codex-agent.Dockerfile \
  --platform linux/amd64 --private
```

The default can be overridden without editing source by setting
`MAZEBENCH_PRIME_CODEX_AGENT_IMAGE` before starting MazeBench.
