"""Collect MazeBench rollouts and train PPO on the AMD GPU."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import time
from pathlib import Path
from typing import Any

from .device import DeviceInfo, resolve_device
from .encode import AUX_DIM, GRID_H, GRID_W
from .env import N_ACTIONS, RewardWeights, VecMazeEnv, repo_root_from
from .policy import build_policy
from .ppo import PPOConfig, compute_gae, ppo_update


@dataclass
class TrainConfig:
    level: str = "level_HxI"
    view: str = "top-diagonal"
    n_envs: int = 8
    num_steps: int = 128
    updates: int = 200
    max_actions: int = 256
    gem_weight: float = 1.0
    room_weight: float = 0.1
    push_weight: float = 0.05
    novelty_bonus: float = 0.01
    auto_quit: bool = True
    seed: int = 1
    out_dir: str = "outputs/local-train"


def _as_tensor(torch_mod: Any, data: Any, dtype: Any) -> Any:
    return torch_mod.tensor(data, dtype=dtype)


def save_checkpoint(
    path: Path,
    *,
    policy: Any,
    optimizer: Any,
    config: TrainConfig,
    update: int,
    metrics: dict[str, Any],
    device: DeviceInfo,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "update": update,
        "config": asdict(config),
        "metrics": metrics,
        "device_name": device.name,
        "torch_version": device.torch_version,
        "model": policy.state_dict(),
        "optimizer": optimizer.state_dict(),
    }
    import torch

    torch.save(payload, path)


def collect_rollout(
    torch_mod: Any,
    policy: Any,
    vec: VecMazeEnv,
    glyphs: list[list[list[int]]],
    aux: list[list[float]],
    masks: list[list[bool]],
    *,
    num_steps: int,
    device: Any,
) -> dict[str, Any]:
    policy.eval()
    storage = {
        "glyphs": [],
        "aux": [],
        "masks": [],
        "actions": [],
        "logp": [],
        "rewards": [],
        "dones": [],
        "values": [],
        "infos": [],
    }
    current_glyphs = glyphs
    current_aux = aux
    current_masks = masks
    with torch_mod.no_grad():
        for _step in range(num_steps):
            glyph_t = _as_tensor(torch_mod, current_glyphs, torch_mod.long).to(device)
            aux_t = _as_tensor(torch_mod, current_aux, torch_mod.float32).to(device)
            mask_t = _as_tensor(torch_mod, current_masks, torch_mod.bool).to(device)
            actions, logp, _entropy, values = policy.act(glyph_t, aux_t, mask_t)
            action_list = [int(item) for item in actions.detach().cpu().tolist()]
            next_glyphs, next_aux, next_masks, rewards, dones, infos = vec.step(action_list)
            storage["glyphs"].append(current_glyphs)
            storage["aux"].append(current_aux)
            storage["masks"].append(current_masks)
            storage["actions"].append(action_list)
            storage["logp"].append([float(item) for item in logp.detach().cpu().tolist()])
            storage["values"].append([float(item) for item in values.detach().cpu().tolist()])
            storage["rewards"].append(rewards)
            storage["dones"].append(dones)
            storage["infos"].append(infos)
            current_glyphs, current_aux, current_masks = next_glyphs, next_aux, next_masks
        glyph_t = _as_tensor(torch_mod, current_glyphs, torch_mod.long).to(device)
        aux_t = _as_tensor(torch_mod, current_aux, torch_mod.float32).to(device)
        mask_t = _as_tensor(torch_mod, current_masks, torch_mod.bool).to(device)
        _logits, last_values = policy(glyph_t, aux_t, mask_t)
        last_value_list = [float(item) for item in last_values.detach().cpu().tolist()]
    return {
        "storage": storage,
        "glyphs": current_glyphs,
        "aux": current_aux,
        "masks": current_masks,
        "last_values": last_value_list,
    }


def flatten_rollout(torch_mod: Any, storage: dict[str, Any], advantages: list[list[float]], returns: list[list[float]]) -> dict[str, Any]:
    glyphs = _as_tensor(torch_mod, storage["glyphs"], torch_mod.long).reshape(-1, GRID_H, GRID_W)
    aux = _as_tensor(torch_mod, storage["aux"], torch_mod.float32).reshape(-1, AUX_DIM)
    masks = _as_tensor(torch_mod, storage["masks"], torch_mod.bool).reshape(-1, N_ACTIONS)
    actions = _as_tensor(torch_mod, storage["actions"], torch_mod.long).reshape(-1)
    logp = _as_tensor(torch_mod, storage["logp"], torch_mod.float32).reshape(-1)
    adv = _as_tensor(torch_mod, advantages, torch_mod.float32).reshape(-1)
    ret = _as_tensor(torch_mod, returns, torch_mod.float32).reshape(-1)
    return {
        "glyphs": glyphs,
        "aux": aux,
        "masks": masks,
        "actions": actions,
        "logp": logp,
        "advantages": adv,
        "returns": ret,
    }


def rollout_metrics(storage: dict[str, Any]) -> dict[str, float]:
    rewards = storage["rewards"]
    dones = storage["dones"]
    infos = storage["infos"]
    n_envs = len(rewards[0]) if rewards else 0
    mean_reward = sum(sum(row) for row in rewards) / max(1, len(rewards) * n_envs)
    finished = [
        info
        for step_infos, step_dones in zip(infos, dones)
        for info, done in zip(step_infos, step_dones)
        if done
    ]
    if finished:
        gems = sum(int(info.get("gem_count") or 0) for info in finished) / len(finished)
        rooms = sum(int(info.get("rooms") or 0) for info in finished) / len(finished)
        episode_reward = sum(float(info.get("episode_reward") or 0) for info in finished) / len(finished)
    else:
        latest = infos[-1] if infos else []
        gems = sum(int(info.get("gem_count") or 0) for info in latest) / max(1, len(latest))
        rooms = sum(int(info.get("rooms") or 0) for info in latest) / max(1, len(latest))
        episode_reward = sum(float(info.get("episode_reward") or 0) for info in latest) / max(1, len(latest))
    return {
        "reward_mean": float(mean_reward),
        "episode_reward_mean": float(episode_reward),
        "gems_mean": float(gems),
        "rooms_mean": float(rooms),
        "episodes": float(len(finished)),
    }


def train(config: TrainConfig) -> dict[str, Any]:
    import torch

    device_info = resolve_device(require_gpu=True)
    torch.manual_seed(config.seed)
    if device_info.is_gpu:
        torch.cuda.manual_seed_all(config.seed)
    device = torch.device(device_info.torch_device)
    root = repo_root_from()
    out_dir = (root / config.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = out_dir / "metrics.jsonl"

    vec = VecMazeEnv(
        config.n_envs,
        repo_root=root,
        level_id=config.level,
        view=config.view,
        max_actions=config.max_actions,
        weights=RewardWeights(
            gems=config.gem_weight,
            rooms=config.room_weight,
            pushes=config.push_weight,
            novelty=config.novelty_bonus,
        ),
        auto_quit=config.auto_quit,
    )
    policy = build_policy(torch).to(device)
    optimizer = torch.optim.Adam(policy.parameters(), lr=PPOConfig().learning_rate)
    ppo_config = PPOConfig()
    glyphs, aux, masks = vec.reset()
    last_metrics: dict[str, Any] = {}
    started = time.perf_counter()

    try:
        for update in range(1, config.updates + 1):
            update_started = time.perf_counter()
            rollout = collect_rollout(
                torch,
                policy,
                vec,
                glyphs,
                aux,
                masks,
                num_steps=config.num_steps,
                device=device,
            )
            glyphs, aux, masks = rollout["glyphs"], rollout["aux"], rollout["masks"]
            advantages, returns = compute_gae(
                rollout["storage"]["rewards"],
                rollout["storage"]["values"],
                rollout["storage"]["dones"],
                rollout["last_values"],
                gamma=ppo_config.gamma,
                gae_lambda=ppo_config.gae_lambda,
            )
            policy.train()
            batch = flatten_rollout(torch, rollout["storage"], advantages, returns)
            losses = ppo_update(torch, policy, optimizer, batch, ppo_config, device)
            env_metrics = rollout_metrics(rollout["storage"])
            elapsed = time.perf_counter() - update_started
            frames = config.n_envs * config.num_steps
            allocated = int(torch.cuda.memory_allocated(device)) if device_info.is_gpu else 0
            last_metrics = {
                "update": update,
                "frames": frames,
                "fps": frames / max(elapsed, 1e-6),
                "seconds": elapsed,
                "device": device_info.torch_device,
                "device_name": device_info.name,
                "gpu_alloc_mib": allocated / (1024**2),
                **env_metrics,
                **losses,
            }
            with metrics_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(last_metrics) + "\n")
            save_checkpoint(
                out_dir / "latest.pt",
                policy=policy,
                optimizer=optimizer,
                config=config,
                update=update,
                metrics=last_metrics,
                device=device_info,
            )
            print(
                f"update {update}/{config.updates}  "
                f"reward={last_metrics['reward_mean']:.4f}  "
                f"gems={last_metrics['gems_mean']:.3f}  "
                f"rooms={last_metrics['rooms_mean']:.2f}  "
                f"fps={last_metrics['fps']:.1f}  "
                f"{device_info.name}",
                flush=True,
            )
    finally:
        vec.close()

    last_metrics["total_seconds"] = time.perf_counter() - started
    last_metrics["out_dir"] = str(out_dir)
    return last_metrics


def evaluate(
    checkpoint: Path,
    *,
    episodes: int = 4,
    max_actions: int | None = None,
    level: str | None = None,
) -> dict[str, Any]:
    import torch

    device_info = resolve_device(require_gpu=True)
    device = torch.device(device_info.torch_device)
    payload = torch.load(checkpoint, map_location=device)
    cfg = payload.get("config") or {}
    policy = build_policy(torch).to(device)
    policy.load_state_dict(payload["model"])
    policy.eval()
    root = repo_root_from()
    env = VecMazeEnv(
        1,
        repo_root=root,
        level_id=level or cfg.get("level") or "level_HxI",
        view=cfg.get("view") or "top-diagonal",
        max_actions=max_actions or int(cfg.get("max_actions") or 256),
        auto_quit=True,
    )
    results = []
    try:
        for _episode in range(episodes):
            glyphs, aux, masks = env.reset()
            total = 0.0
            last_info: dict[str, Any] = {}
            for _step in range(env.envs[0].max_actions):
                glyph_t = torch.tensor(glyphs, dtype=torch.long, device=device)
                aux_t = torch.tensor(aux, dtype=torch.float32, device=device)
                mask_t = torch.tensor(masks, dtype=torch.bool, device=device)
                with torch.no_grad():
                    logits, _value = policy(glyph_t, aux_t, mask_t)
                    action = int(torch.argmax(logits, dim=-1)[0].item())
                glyphs, aux, masks, rewards, dones, infos = env.step([action])
                total += rewards[0]
                last_info = infos[0]
                if dones[0]:
                    break
            results.append(
                {
                    "reward": total,
                    "gems": last_info.get("gem_count"),
                    "rooms": last_info.get("rooms"),
                    "reason": last_info.get("reason"),
                }
            )
    finally:
        env.close()
    return {
        "checkpoint": str(checkpoint),
        "device": device_info.name,
        "episodes": results,
        "gems_mean": sum(float(item["gems"] or 0) for item in results) / max(1, len(results)),
        "rooms_mean": sum(float(item["rooms"] or 0) for item in results) / max(1, len(results)),
    }
