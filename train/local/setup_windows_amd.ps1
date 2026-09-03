# Install AMD ROCm 7.2.1 + PyTorch into the repo .venv (Python 3.12, RX 9070 XT).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $Root "package.json"))) {
    $Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}
Set-Location $Root
$Python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
    python -m venv .venv
}
& $Python -m pip install --upgrade pip
$Base = "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1"
& $Python -m pip install --no-cache-dir `
    "$Base/rocm_sdk_core-7.2.1-py3-none-win_amd64.whl" `
    "$Base/rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl" `
    "$Base/rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl" `
    "$Base/rocm-7.2.1.tar.gz"
& $Python -m pip install --no-cache-dir --no-deps "$Base/torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl"
& $Python -m pip install --no-cache-dir filelock fsspec jinja2 networkx sympy typing-extensions numpy setuptools
& $Python -m train.local probe
