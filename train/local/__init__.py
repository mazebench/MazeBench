"""Local PPO training harness for the MazeBench engine."""

from .device import DeviceInfo, resolve_device

__all__ = ["DeviceInfo", "resolve_device"]
