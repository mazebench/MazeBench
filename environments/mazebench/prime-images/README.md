# Prime runtime images

MazeBench uses two different private images so the evaluated agent never shares
a filesystem with the game implementation.

- `codex-agent.Dockerfile` contains only the pinned Codex harness binary and its
  small base runtime. Verifiers launches the evaluated agent in this image.
- `tool-runtime.Dockerfile` contains the MazeBench/Verifiers Python dependency
  closure, packaged Node.js, and the pinned Codex binary used only for the
  fail-closed `python_exec` Linux sandbox. The trusted MCP game server runs here.

The live MazeBench package is still uploaded for each run and reinstalled with
`--no-deps`, so ordinary source changes do not require rebuilding the large tool
image. A missing marker or required executable makes the launcher fall back to
the full cold installation path.

Build the private images from `environments/mazebench`:

```sh
prime images push mazebench-codex-agent:0.144.5-v3 \
  --context . --dockerfile prime-images/codex-agent.Dockerfile \
  --platform linux/amd64 --private

prime images push mazebench-tool-runtime:py313-codex-0.144.5-vf-b3b8f51-v3 \
  --context . --dockerfile prime-images/tool-runtime.Dockerfile \
  --platform linux/amd64 --private
```

The defaults can be overridden without editing source by setting
`MAZEBENCH_PRIME_CODEX_AGENT_IMAGE` and
`MAZEBENCH_PRIME_TOOL_RUNTIME_IMAGE` before starting MazeBench.
