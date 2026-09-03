"""Pick the discrete AMD GPU and refuse the iGPU."""

from __future__ import annotations

from dataclasses import dataclass
import time
from typing import Any


PREFERRED_NAME_MARKERS = ("9070",)
IGPU_MARKERS = ("radeon(tm) graphics", "radeon graphics", "amd radeon graphics")


@dataclass(frozen=True)
class DeviceInfo:
    kind: str
    index: int
    name: str
    torch_device: str
    vram_bytes: int
    torch_version: str
    hip_available: bool
    details: dict[str, Any]

    @property
    def is_gpu(self) -> bool:
        return self.kind == "cuda"


def _device_name(torch_mod: Any, index: int) -> str:
    try:
        return str(torch_mod.cuda.get_device_name(index))
    except Exception:
        return f"cuda:{index}"


def _is_igpu(name: str) -> bool:
    lowered = name.lower()
    return any(marker in lowered for marker in IGPU_MARKERS) and "9070" not in lowered and "7900" not in lowered


def _score_device(name: str, index: int) -> tuple[int, int]:
    lowered = name.lower()
    if any(marker in lowered for marker in PREFERRED_NAME_MARKERS):
        return (3, -index)
    if _is_igpu(name):
        return (0, -index)
    if "radeon" in lowered or "amd" in lowered:
        return (2, -index)
    return (1, -index)


def _vram_bytes(torch_mod: Any, index: int) -> int:
    try:
        props = torch_mod.cuda.get_device_properties(index)
        return int(getattr(props, "total_memory", 0) or 0)
    except Exception:
        return 0


def resolve_device(*, require_gpu: bool = False) -> DeviceInfo:
    try:
        import torch
    except ImportError as error:
        if require_gpu:
            raise RuntimeError(
                "PyTorch is not installed. Create .venv and run train/local/setup_windows_amd.ps1"
            ) from error
        return DeviceInfo(
            kind="cpu",
            index=-1,
            name="cpu",
            torch_device="cpu",
            vram_bytes=0,
            torch_version="",
            hip_available=False,
            details={"error": "torch_not_installed"},
        )

    hip = bool(getattr(torch.version, "hip", None))
    cuda = bool(torch.cuda.is_available())
    count = int(torch.cuda.device_count()) if cuda else 0
    devices = [
        {
            "index": index,
            "name": _device_name(torch, index),
            "vram_bytes": _vram_bytes(torch, index),
        }
        for index in range(count)
    ]
    ranked = sorted(devices, key=lambda item: _score_device(item["name"], item["index"]), reverse=True)
    chosen = next((item for item in ranked if not _is_igpu(item["name"])), None)

    if chosen is None:
        info = DeviceInfo(
            kind="cpu",
            index=-1,
            name="cpu",
            torch_device="cpu",
            vram_bytes=0,
            torch_version=str(torch.__version__),
            hip_available=hip,
            details={"cuda_available": cuda, "devices": devices, "reason": "no_discrete_gpu"},
        )
        if require_gpu:
            raise RuntimeError(
                "No discrete AMD GPU visible to PyTorch. "
                f"cuda.is_available={cuda} devices={devices}"
            )
        return info

    torch.cuda.set_device(chosen["index"])
    return DeviceInfo(
        kind="cuda",
        index=int(chosen["index"]),
        name=str(chosen["name"]),
        torch_device=f"cuda:{chosen['index']}",
        vram_bytes=int(chosen["vram_bytes"]),
        torch_version=str(torch.__version__),
        hip_available=hip,
        details={"cuda_available": cuda, "devices": devices},
    )


def benchmark_matmul(info: DeviceInfo, size: int = 2048) -> dict[str, float]:
    import torch

    device = torch.device(info.torch_device)
    torch.cuda.synchronize(device) if info.is_gpu else None
    matrix = torch.randn(size, size, device=device)
    # Warmup so compile/init is not the timed path.
    (matrix @ matrix).sum().item()
    if info.is_gpu:
        torch.cuda.synchronize(device)
    started = time.perf_counter()
    result = matrix @ matrix
    checksum = float(result.sum().item())
    if info.is_gpu:
        torch.cuda.synchronize(device)
    elapsed = time.perf_counter() - started
    allocated = 0
    if info.is_gpu:
        allocated = int(torch.cuda.memory_allocated(device))
    return {
        "seconds": elapsed,
        "checksum": checksum,
        "allocated_bytes": allocated,
        "size": size,
    }


def probe_text(info: DeviceInfo, bench: dict[str, float] | None = None) -> str:
    vram_gib = info.vram_bytes / (1024**3) if info.vram_bytes else 0.0
    lines = [
        f"device: {info.torch_device}",
        f"name: {info.name}",
        f"kind: {info.kind}",
        f"torch: {info.torch_version or 'not installed'}",
        f"hip: {info.hip_available}",
        f"vram_gib: {vram_gib:.2f}",
    ]
    extras = info.details.get("devices") if isinstance(info.details, dict) else None
    if extras:
        lines.append(f"visible_devices: {extras}")
    if bench:
        lines.append(
            f"matmul_{int(bench['size'])}: {bench['seconds']:.4f}s "
            f"alloc_mib={bench['allocated_bytes'] / (1024**2):.1f}"
        )
    return "\n".join(lines)
