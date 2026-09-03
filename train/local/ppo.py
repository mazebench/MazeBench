"""PPO update over MazeBench rollouts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import math


@dataclass
class PPOConfig:
    gamma: float = 0.99
    gae_lambda: float = 0.95
    clip_range: float = 0.2
    entropy_coef: float = 0.02
    value_coef: float = 0.5
    max_grad_norm: float = 0.5
    learning_rate: float = 3e-4
    epochs: int = 4
    minibatch_size: int = 512


def compute_gae(
    rewards: list[list[float]],
    values: list[list[float]],
    dones: list[list[bool]],
    last_values: list[float],
    *,
    gamma: float,
    gae_lambda: float,
) -> tuple[list[list[float]], list[list[float]]]:
    n_steps = len(rewards)
    n_envs = len(rewards[0]) if rewards else 0
    advantages = [[0.0] * n_envs for _ in range(n_steps)]
    gae = [0.0] * n_envs
    for step in range(n_steps - 1, -1, -1):
        next_values = last_values if step == n_steps - 1 else values[step + 1]
        for env_index in range(n_envs):
            nonterminal = 0.0 if dones[step][env_index] else 1.0
            delta = (
                rewards[step][env_index]
                + gamma * next_values[env_index] * nonterminal
                - values[step][env_index]
            )
            gae[env_index] = delta + gamma * gae_lambda * nonterminal * gae[env_index]
            advantages[step][env_index] = gae[env_index]
    returns = [
        [advantages[step][env_index] + values[step][env_index] for env_index in range(n_envs)]
        for step in range(n_steps)
    ]
    return advantages, returns


def ppo_update(
    torch_mod: Any,
    policy: Any,
    optimizer: Any,
    batch: dict[str, Any],
    config: PPOConfig,
    device: Any,
) -> dict[str, float]:
    glyphs = batch["glyphs"].to(device)
    aux = batch["aux"].to(device)
    masks = batch["masks"].to(device)
    actions = batch["actions"].to(device)
    old_logp = batch["logp"].to(device)
    advantages = batch["advantages"].to(device)
    returns = batch["returns"].to(device)

    n = actions.shape[0]
    if n == 0:
        return {"policy_loss": 0.0, "value_loss": 0.0, "entropy": 0.0}

    adv = advantages
    adv = (adv - adv.mean()) / (adv.std(unbiased=False) + 1e-8)
    indices = torch_mod.randperm(n, device=device)
    minibatch = max(1, min(config.minibatch_size, n))
    stats = {"policy_loss": 0.0, "value_loss": 0.0, "entropy": 0.0}
    n_minibatches = 0

    for _epoch in range(config.epochs):
        indices = torch_mod.randperm(n, device=device)
        for start in range(0, n, minibatch):
            mb = indices[start : start + minibatch]
            logp, entropy, value = policy.evaluate(
                glyphs[mb], aux[mb], masks[mb], actions[mb]
            )
            ratio = torch_mod.exp(logp - old_logp[mb])
            unclipped = ratio * adv[mb]
            clipped = ratio.clamp(1.0 - config.clip_range, 1.0 + config.clip_range) * adv[mb]
            policy_loss = -torch_mod.minimum(unclipped, clipped).mean()
            value_loss = torch_mod.nn.functional.mse_loss(value, returns[mb])
            loss = (
                policy_loss
                + config.value_coef * value_loss
                - config.entropy_coef * entropy.mean()
            )
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch_mod.nn.utils.clip_grad_norm_(policy.parameters(), config.max_grad_norm)
            optimizer.step()
            stats["policy_loss"] += float(policy_loss.detach().item())
            stats["value_loss"] += float(value_loss.detach().item())
            stats["entropy"] += float(entropy.mean().detach().item())
            n_minibatches += 1

    if n_minibatches:
        for key in stats:
            stats[key] /= n_minibatches
    stats["n"] = float(n)
    if math.isnan(stats["policy_loss"]):
        raise RuntimeError("PPO produced NaN policy loss")
    return stats
