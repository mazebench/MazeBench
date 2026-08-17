# MazeBench

MazeBench is a long-horizon maze-navigation environment for reinforcement learning and evaluation with [Prime Intellect Verifiers](https://github.com/PrimeIntellect-ai/verifiers).

Models navigate a real JavaScript maze world one action at a time, preserve state across rooms, collect gems, discover new rooms, and push blocks. Every rollout produces deterministic rewards, metrics, and replay data from the same game engine used by the local MazeBench site.

> **Environment:** `mazebench/mazebench`
> **Native agent API:** `mazebench-tools` + the fixed game-only relay
> **Hosted compatibility:** Classic `MultiTurnEnv` adapter for Prime CLI 0.6.x
> **Default observation:** ASCII
> **Visibility:** Private

## Support status

| Capability | Hosted Training | Local evaluation |
| --- | --- | --- |
| ASCII observations | Supported | Supported |
| JSON object observations | Supported | Supported |
| Gem, room, and block rewards | Supported | Supported |
| Configurable start room, view, yaw, and action limit | Supported | Supported |
| State-novelty auto-quit | Supported | Supported |
| Replay state and per-action metadata | Supported | Supported |
| Perspective image observations | Not yet self-contained | Supported by the game-agent relay |
| Fixed game-agent model relay | Not part of Hosted Training | Supported |
| Shell, filesystem, subprocess, network, and Python tools | Not available | Not available |
| Built-in coding harnesses and swarm modes | Not available | Not available |

The package brings its own Node runtime for the JavaScript maze engine. Native v1
vision evaluations run the evaluator-owned Toolset in the version-matched stock
Playwright image; the environment package supplies the matching Playwright driver.
The classic Hosted Training adapter remains ASCII/JSON-only. Local game-agent runs
render vision on the trusted evaluator and return each frame as an MCP image result.

## The task

The local game-agent route receives observations through `start`, `observe`,
named action tools, and `action_sequence`. Hosted Training uses
the classic message adapter, where the model answers with one command. Both
routes apply actions to persistent game state and return the next observation.

The win condition is fixed at **100 unique gems** across the world. No harness,
observation mode, environment variable, or replay can lower that threshold.

### Commands

| Command | Effect |
| --- | --- |
| `up`, `down`, `left`, `right` | Move one screen-relative step. |
| `rotate camera up`, `rotate camera down`, `rotate camera left`, `rotate camera right` | Change the camera pitch or yaw. |
| `undo` | Undo the most recent movement. Collected-gem progress remains monotonic. |
| `reset` | Reset the current room to its entry state. Global score remains monotonic. |
| `go to level X Y` | Return to a previously visited room. |
| `quit` | End the rollout as a loss when quitting is enabled. |

The tool names match the commands: movement uses `up`, `down`, `left`, and
`right`; camera changes use `rotate_camera_up`, `rotate_camera_down`,
`rotate_camera_left`, and `rotate_camera_right`; recovery uses `undo` and
`reset`; and room navigation uses `go_to_level(x, y)`.

Movement remains screen-relative after camera rotation. `go to level` is restricted to rooms already present in `visited_levels`.

Every model-facing observation uses the same metadata contract: observation mode, current room and view, yaw, total gem count, the complete list of visited rooms, and terminal state. ASCII adds `level`, JSON adds `json_observation`, and vision adds an MCP PNG image. A blocked movement is never reported explicitly. If the player dies, the observation does report `player_dead`, a death message, and the only valid recovery commands. Board-state hashes, movement flags, push counters, and exact collected-gem IDs remain evaluator-only.

## Rewards

MazeBench exposes three independent deterministic reward signals:

| Reward | Default weight | Definition |
| --- | ---: | --- |
| `gem_score` | `1.0` | Unique gems collected. When `target_gems > 0`, this component is normalized to that target. |
| `room_exploration_score` | `0.1` | Newly visited rooms after the starting room. |
| `block_progress_score` | `0.05` | Novel block positions reached by pushing. Repeating the same positions does not farm reward. |

These are final rollout scores calculated from authoritative game state. Reward weights shape learning without changing the semantic win condition.

Evaluator-only metrics saved after the rollout include:

- `collected_gems`
- `visited_level_count`
- `block_pushes`
- `novel_block_positions`

## Install

Install the latest private Hub version while authenticated as an authorized Prime account:

```bash
prime env install mazebench/mazebench
```

Install a specific version for reproducibility:

```bash
prime env install mazebench/mazebench@0.1.18
```

## Evaluate with Prime Sandboxes

MazeBench uses the Verifiers v1 evaluator:

```bash
uv run eval mazebench-tools \
  -m openai/gpt-4.1-mini \
  -n 1 \
  -r 1 \
  --env.taskset.max-actions 40 \
  --env.agent.max-turns 160 \
  --env.agent.harness.id null \
  --env.agent.runtime.type prime \
  --push false \
  --rich false
```

Each task returns an ordinary Verifiers Toolset running on the evaluator. The
selected framework harness runs in its own sandbox and receives only that
Toolset through Verifiers' standard MCP wiring; MazeBench has no custom runtime,
installer, image, or port plumbing for the game server. Select the
observation surface independently with
`--env.taskset.observation-mode ascii`, `json`, or `vision`; add
`--env.taskset.omniscient true` only for omniscient JSON.

MazeBench does not implement or wrap a harness. Any framework harness that supports
MCP can consume the game Toolset; the harness remains responsible for its model
protocol and sampling behavior. Harnesses that expose agent shell or filesystem
capabilities must run in an approved isolated runtime. The direct native `mazebench`
taskset is retired because it bypasses the separate game server. The Hub environment
identifier remains available to the distinct Hosted Training workflow described below.

Complete game-only Prime Sandbox examples for the stock Pi, Claude Code, and
Codex harnesses live in `configs/eval/` at the repository root. Each one uses
the harness's `disabled_tools` contract to remove its standard tools and a
framework-only runtime network policy, leaving only the evaluator-owned game
MCP server and model interception route reachable. Run one from a checkout with:

```bash
uv run --project environments/mazebench eval \
  @ configs/eval/mazebench-codex-game-only.toml
```

Override `model`, taskset settings, sampling, or run limits on the command line
as usual. Keep the harness `disabled_tools` list, `runtime.vm = true`, and
`runtime.allow = []` intact for the game-only boundary.

The saved `results.jsonl` trace contains:

- `info.maze_actions` — normalized action records and per-action game status
- `info.maze_auto_quit` — novelty counts and percentage when auto-quit fires
- `info.maze_scorecard` — the final authoritative scorecard
- `info.maze_replay` — initial state, accepted actions, and final scorecard
- `rewards` — all three reward components
- `metrics` — gems, rooms, room state, and block progress

These scoring fields are evaluator output for the run owner. The model never
receives the scorecard. ASCII and vision observations omit explicit player
coordinates and elevation; JSON observations retain coordinates by design.

## Hosted Training

Choose an available model with:

```bash
prime train models
```

Minimal Hosted Training configuration:

```toml
name = "MazeBench"
model = "Qwen/Qwen3.5-0.8B"
max_steps = 100
batch_size = 512
rollouts_per_example = 16

[sampling]
max_tokens = 1024
temperature = 1.0

[[env]]
id = "mazebench/mazebench"

[env.args]
num_train_examples = 1
num_eval_examples = 1
observation_mode = "ascii"
start_level_id = "level_HxI"
max_actions = 256
game_won_gem_count = 100
gem_reward_weight = 1.0
room_reward_weight = 0.1
push_reward_weight = 0.05
allow_quit = false
auto_quit = true
auto_quit_threshold = 10.0
auto_quit_mode = "rolling"
auto_quit_window = 100
```

Launch it from a CPU machine; Prime hosts the training infrastructure:

```bash
prime train configs/rl/mazebench.toml
```

For long-horizon maze rollouts, keep `batch_size` divisible by `rollouts_per_example`. Start conservatively and inspect early reward distributions before increasing the run size.

### Monitor a training run

```bash
# Overall lifecycle status
prime train get <run-id>

# Orchestrator and environment-server health
prime train components <run-id>

# Latest completed training step
prime train progress <run-id>

# Reward and optimization metrics
prime train metrics <run-id>

# Live orchestrator logs
prime train logs <run-id> -f

# Environment-server logs
prime train logs <run-id> --env mazebench/0 -f

# Tokens and estimated cost
prime train usage <run-id>
```

A run is truly producing training work when `progress.latest_step` is non-null, metrics contain records, and token usage begins increasing. A `RUNNING` lifecycle status with zero tokens can still mean the infrastructure is starting or the environment is loading.

## Configuration reference

Prime CLI 0.6.x passes these settings under `[env.args]` to MazeBench's hosted compatibility adapter. The package also exports the same settings through its native v1 `MazeBenchConfig` for local v1 evaluation and future hosted taskset support.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `num_examples` | integer | `1` | Number of generated tasks. |
| `start_level_id` | string | `level_HxI` | Starting room used when `level_ids` is unset. |
| `level_ids` | string or list | `None` | Optional starting-room set. Accepts `HxI` or `level_HxI`. |
| `view` | string | `top-diagonal` | Initial ASCII camera view. |
| `yaw` | integer | `0` | Initial camera yaw. |
| `game_won_gem_count` | integer | `100` | Legacy compatibility field; normalized to the fixed global value `100`. |
| `gem_reward_weight` | number | `1.0` | Gem reward multiplier. |
| `room_reward_weight` | number | `0.1` | New-room reward multiplier. |
| `push_reward_weight` | number | `0.05` | Novel-block-position reward multiplier. |
| `max_actions` | integer or `None` | `256` | Maximum accepted MazeBench actions. `None` removes the action ceiling in v1 evaluations. |
| `unlimited` | boolean | `false` | Hosted-compatibility switch that removes the action ceiling. |
| `allow_quit` | boolean | `true` | Whether `quit` may end the rollout. |
| `auto_quit` | boolean | `false` | Stop the rollout when its percentage of globally novel board states reaches the configured threshold. |
| `auto_quit_threshold` | number | `10.0` | New-state percentage at or below which auto-quit fires. |
| `auto_quit_mode` | `cumulative` or `rolling` | `rolling` | Measure novelty across the whole rollout or a rolling action window. |
| `auto_quit_window` | integer | `100` | Rolling-mode action window. Rolling mode waits until this window is full. |
| `target_gems` | integer | `0` | Optional gem-score normalization target. `0` uses raw gem count. |
| `observation_mode` | `ascii`, `json`, or `vision` | `ascii` | Observation surface. Hosted Training supports `ascii` and `json`. |
| `omniscient` | boolean | `false` | JSON mode includes every object in the current room instead of only ASCII-visible objects. |
| `hide_names` | boolean | `false` | JSON mode replaces object names except `player` and `gem` with stable per-rollout letter IDs. |
| `repo_root` | string or null | `None` | Optional MazeBench runtime override. |
| `node_bin` | string | `node` | Node executable used by the JS bridge. |
| `timeout_seconds` | integer | `20` | Timeout for JS observation and scoring calls. |
| `vision_width` | integer | `512` | Experimental local vision-frame width. |
| `vision_height` | integer | `512` | Experimental local vision-frame height. |
| `vision_view` | string | `1` | Experimental vision radius: `1`–`26` rings or `world`. |
| `system_prompt` | string | packaged prompt | Optional instruction override. |

Player lifts are state-labeled in model observations: ASCII uses `>` on top
when lowered, `L` on top when raised, and `l` on lift sides; JSON uses
`player_lift_lowered`/`player_lift_raised`. Orange walls use `O` on top and `o`
on the sides (`o` is not a lowered state). Orange buttons are top-only surface
attachments rendered as `8`, with no side character. Pressing a button moves
each `orange_wall` down one elevation, reflected in its JSON coordinate.

Framework controls such as `max_turns`, token limits, sampling, batch size, and rollout count belong outside the taskset configuration.

The Agent Runner's **Unlimited** Prime option uses both layers: it sets the
MazeBench action ceiling to `None` and Verifiers' framework `max_turns` to
`None`. The rollout then ends only when the game ends, Auto-Quit fires, the
user stops it, an inference/runtime error occurs, or an external hosted runtime
timeout is reached.

Auto-quit uses the authoritative `board_state_hash` returned by the game
engine. A state is novel only on its first appearance in the entire rollout.
Cumulative mode includes the initial observation; rolling mode evaluates
action observations and waits for a full window. Warning countdowns are
conditional: they assume subsequent actions keep revisiting already observed
states. Reaching a new state raises the novelty rate and can move the cutoff
farther away.

## Experimental vision

Vision mode uses the same persistent game state, commands, stop conditions, rewards, and metrics as ASCII mode. Instead of an ASCII board, the model receives a short non-positional status message and a perspective PNG frame.

Vision renders in the evaluator-owned game Toolset. MazeBench provisions that
Toolset with the stock Playwright Python image and installs the matching driver
from the environment package:

```bash
uv run --project environments/mazebench eval mazebench-tools \
  -m openai/gpt-4.1-mini \
  -n 1 \
  -r 1 \
  --env.taskset.max-actions 8 \
  --env.agent.max-turns 32 \
  --env.taskset.observation-mode vision \
  --env.taskset.vision-width 512 \
  --env.taskset.vision-height 512 \
  --env.agent.harness.id null \
  --env.agent.runtime.type prime \
  --push false \
  --rich false
```

The resulting PNG is returned as ordinary MCP image content, so MazeBench does not need a vision-specific harness.

## Agent tooling

The former `mazebench_codex` direct taskset and local Codex, Claude Code, and
Kimi runners are retired because their subprocess, host, and repository-aware
paths cannot satisfy the benchmark isolation boundary. Use the Agent page or
`scripts/maze-prime-run.js` with the `mazebench-tools` taskset.

The local `/agent` page exposes the official Prime Agent CLI pinned to v0.7.0
through a MazeBench adapter. Prime Agent runs in a fresh disposable sandbox with its
native persistent IPython tool enabled. Built-in extensions, ambient skills,
context files, prompt templates, themes, and external network access are
disabled; the only evaluator integration is the isolated MazeBench MCP skill.
The task sent to the model contains no repository or checkpoint path.

The separate Codex harness uses its pinned
`disabled_tools = ["shell_tool"]` configuration. Its remaining bookkeeping
tools have no shell or host-filesystem path and it also runs in a fresh Prime
sandbox.
Only the evaluator-owned tool server can update trusted game state through
Verifiers' private per-rollout state channel. `Task.toolsets` constructs that
server directly in a stock Playwright Prime VM; the Node game is its child
process and never enters the agent sandbox. Verifiers connects it to the agent
harness as named controls: `start`, `observe`, movement, camera
rotation, recovery, level navigation, `quit`, and `action_sequence`. When
`python_tools` is enabled, the Toolset additionally owns one fresh zero-egress
Prime VM whose only persistent storage is that rollout's Python scratch
workspace.

Scoring is finalized after the model exits. The agent-facing server exposes no
generic single-action string multiplexer, scorecard, or filesystem operation.
The batch `action_sequence` route remains bounded to 1,000 items.

The approved path can be exercised from a full checkout with:

```bash
node scripts/maze-prime-run.js \
  --env-dir environments/mazebench \
  --out /tmp/mazebench-agent-run \
  --harness mazebench_prime_agent \
  --model openai/gpt-5 \
  --max-turns 40 \
  --tool-use read-only
```

## Runtime and reproducibility

The wheel bundles the JavaScript maze bridge, game engine, world map, levels, renderer source, images, and 3D assets. ASCII evaluation does not require a user-managed background server.

The Verifiers dependency is pinned to the revision used for validation. Prime Hosted Training 0.6.x currently resolves Hub environments through the classic `load_environment` contract, so MazeBench publishes a `MultiTurnEnv` adapter alongside its native v1 taskset. Both paths share the same JavaScript game engine, commands, reward definitions, metrics, and win condition.

Pin a specific MazeBench Hub version in important experiments, record the complete training config, and launch a new run when changing environment versions; publishing an update does not mutate an already-running training job.
