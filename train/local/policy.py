"""Actor-critic over the ASCII glyph grid."""

from __future__ import annotations

from typing import Any

from .encode import AUX_DIM, GRID_H, GRID_W, VOCAB_SIZE
from .env import N_ACTIONS


class ActorCritic:
    """Thin wrapper so callers can import after torch is installed."""

    def __init__(self, module: Any) -> None:
        self.module = module

    def __getattr__(self, name: str) -> Any:
        return getattr(self.module, name)


def build_policy(
    torch_mod: Any,
    *,
    vocab_size: int = VOCAB_SIZE,
    n_actions: int = N_ACTIONS,
    aux_dim: int = AUX_DIM,
    embed_dim: int = 24,
):
    nn = torch_mod.nn

    class Policy(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.embed = nn.Embedding(vocab_size, embed_dim, padding_idx=0)
            self.conv = nn.Sequential(
                nn.Conv2d(embed_dim, 32, kernel_size=5, stride=2, padding=2),
                nn.ReLU(),
                nn.Conv2d(32, 64, kernel_size=3, stride=2, padding=1),
                nn.ReLU(),
                nn.Conv2d(64, 128, kernel_size=3, stride=2, padding=1),
                nn.ReLU(),
                nn.Conv2d(128, 128, kernel_size=3, stride=2, padding=1),
                nn.ReLU(),
            )
            conv_out = 128 * (GRID_H // 16) * (GRID_W // 16)
            self.aux = nn.Sequential(nn.Linear(aux_dim, 64), nn.ReLU())
            self.merge = nn.Sequential(nn.Linear(conv_out + 64, 256), nn.ReLU())
            self.actor = nn.Linear(256, n_actions)
            self.critic = nn.Linear(256, 1)

        def forward(self, glyphs, aux, action_mask=None):
            embedded = self.embed(glyphs).permute(0, 3, 1, 2)
            vision = self.conv(embedded).flatten(1)
            merged = self.merge(torch_mod.cat([vision, self.aux(aux)], dim=1))
            logits = self.actor(merged)
            if action_mask is not None:
                logits = logits.masked_fill(~action_mask, torch_mod.tensor(-1.0e9, dtype=logits.dtype, device=logits.device))
            value = self.critic(merged).squeeze(-1)
            return logits, value

        def act(self, glyphs, aux, action_mask, generator=None):
            logits, value = self.forward(glyphs, aux, action_mask)
            dist = torch_mod.distributions.Categorical(logits=logits)
            action = dist.sample()
            return action, dist.log_prob(action), dist.entropy(), value

        def evaluate(self, glyphs, aux, action_mask, actions):
            logits, value = self.forward(glyphs, aux, action_mask)
            dist = torch_mod.distributions.Categorical(logits=logits)
            return dist.log_prob(actions), dist.entropy(), value

    return Policy()
