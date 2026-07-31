#!/usr/bin/env python3
"""Fail a release build when its wheel or sdist omits required payloads."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from collections.abc import Iterable
from pathlib import Path, PurePosixPath
from typing import Callable

ROOT = Path(__file__).resolve().parents[1]
NOTICE_NAME = "THIRD_PARTY_NOTICES.md"
LICENSE_NAME = "LICENSE"
VENDOR_FILES = (
    "BufferGeometryUtils.js",
    "GLTFLoader.js",
    "SkeletonUtils.js",
    "three.core.js",
    "three.module.js",
)
NOTICE_MARKERS = (
    "## Three.js",
    "Copyright © 2010-2026 three.js authors",
    "## Lucide Icons",
    "ISC License",
    "Copyright (c) 2013-present Cole Bemis",
)
ENVIRONMENT_ROOT = ROOT / "environments" / "mazebench"
AGENT_ENVIRONMENT_MARKERS = (
    "pyproject.toml",
    "uv.lock",
    "mazebench/mazebench.py",
    "mazebench/runtime/scripts/maze-mcp-client.js",
    "mazebench/runtime/scripts/maze-mcp-server.js",
    "mazebench_tools/__init__.py",
)


def fail(message: str) -> None:
    raise SystemExit(f"release archive verification failed: {message}")


def safe_archive_names(names: Iterable[str], archive_name: str) -> tuple[str, ...]:
    checked = tuple(names)
    for name in checked:
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts:
            fail(f"{archive_name} contains unsafe path {name!r}")
    return checked


def exactly_one(
    names: Iterable[str],
    predicate: Callable[[str], bool],
    description: str,
) -> str:
    matches = [name for name in names if predicate(name)]
    if len(matches) != 1:
        fail(f"expected one {description}, found {matches!r}")
    return matches[0]


def require_notice(notice: bytes, expected: bytes, location: str) -> None:
    if notice != expected:
        fail(f"{location} does not match the repository {NOTICE_NAME}")
    text = notice.decode("utf-8")
    missing = [marker for marker in NOTICE_MARKERS if marker not in text]
    if missing:
        fail(f"{location} is missing notice markers {missing!r}")


def require_agent_environment(names: Iterable[str], prefix: str) -> None:
    available = set(names)
    expected = []
    for directory, directory_names, file_names in os.walk(ENVIRONMENT_ROOT):
        directory_names[:] = [
            name
            for name in directory_names
            if not name.startswith(".") and name != "__pycache__"
        ]
        for name in file_names:
            if not name.startswith(".") and not name.endswith(".pyc"):
                expected.append(
                    (Path(directory) / name).relative_to(ENVIRONMENT_ROOT).as_posix()
                )
    missing = [
        relative for relative in expected if f"{prefix}/{relative}" not in available
    ]
    if missing:
        fail(f"packaged Agent environment is missing {missing!r}")
    if any(".venv" in PurePosixPath(name).parts for name in available):
        fail("packaged Agent environment contains .venv")


def verify_wheel(
    wheel_path: Path, expected_notice: bytes, expected_license: bytes
) -> None:
    with zipfile.ZipFile(wheel_path) as archive:
        names = safe_archive_names(archive.namelist(), wheel_path.name)

        package_notice = exactly_one(
            names,
            lambda name: name == f"mazebench_cli/{NOTICE_NAME}",
            "package-level third-party notice in the wheel",
        )
        runtime_notice = exactly_one(
            names,
            lambda name: name == f"mazebench_cli/_runtime/{NOTICE_NAME}",
            "runtime third-party notice in the wheel",
        )
        runtime_license = exactly_one(
            names,
            lambda name: name == f"mazebench_cli/_runtime/{LICENSE_NAME}",
            "runtime MazeBench license in the wheel",
        )
        metadata_license = exactly_one(
            names,
            lambda name: (
                name.endswith(f".dist-info/licenses/{LICENSE_NAME}")
                or name.endswith(f".dist-info/{LICENSE_NAME}")
            ),
            "distribution metadata license in the wheel",
        )
        metadata = exactly_one(
            names,
            lambda name: name.endswith(".dist-info/METADATA"),
            "METADATA file in the wheel",
        )

        require_notice(archive.read(package_notice), expected_notice, package_notice)
        require_notice(archive.read(runtime_notice), expected_notice, runtime_notice)
        if archive.read(runtime_license) != expected_license:
            fail(f"{runtime_license} does not match the repository {LICENSE_NAME}")
        if archive.read(metadata_license) != expected_license:
            fail(f"{metadata_license} does not match the repository {LICENSE_NAME}")

        metadata_text = archive.read(metadata).decode("utf-8")
        if (
            "License-Expression: MIT" not in metadata_text
            and "License: MIT" not in metadata_text
        ):
            fail(f"{metadata} does not declare the MIT license")

        for vendor_name in VENDOR_FILES:
            expected_path = f"mazebench_cli/_runtime/vendor/{vendor_name}"
            exactly_one(
                names,
                lambda name, expected_path=expected_path: name == expected_path,
                f"bundled {vendor_name} in the wheel",
            )

        require_agent_environment(
            names, "mazebench_cli/_runtime/environments/mazebench"
        )


def verify_sdist(
    sdist_path: Path, expected_notice: bytes, expected_license: bytes
) -> None:
    with tarfile.open(sdist_path, "r:gz") as archive:
        members = archive.getmembers()
        names = safe_archive_names((member.name for member in members), sdist_path.name)
        member_by_name = {member.name: member for member in members}

        root_notice = exactly_one(
            names,
            lambda name: (
                len(PurePosixPath(name).parts) == 2 and name.endswith(f"/{NOTICE_NAME}")
            ),
            "top-level third-party notice in the sdist",
        )
        root_license = exactly_one(
            names,
            lambda name: (
                len(PurePosixPath(name).parts) == 2
                and name.endswith(f"/{LICENSE_NAME}")
            ),
            "top-level MazeBench license in the sdist",
        )
        runtime_notice = exactly_one(
            names,
            lambda name: name.endswith(f"/mazebench_cli/_runtime/{NOTICE_NAME}"),
            "runtime third-party notice in the sdist",
        )
        runtime_license = exactly_one(
            names,
            lambda name: name.endswith(f"/mazebench_cli/_runtime/{LICENSE_NAME}"),
            "runtime MazeBench license in the sdist",
        )

        def read(name: str) -> bytes:
            extracted = archive.extractfile(member_by_name[name])
            if extracted is None:
                fail(f"{name} is not a regular file")
            return extracted.read()

        require_notice(read(root_notice), expected_notice, root_notice)
        require_notice(read(runtime_notice), expected_notice, runtime_notice)
        if read(root_license) != expected_license:
            fail(f"{root_license} does not match the repository {LICENSE_NAME}")
        if read(runtime_license) != expected_license:
            fail(f"{runtime_license} does not match the repository {LICENSE_NAME}")

        for vendor_name in VENDOR_FILES:
            suffix = f"/mazebench_cli/_runtime/vendor/{vendor_name}"
            exactly_one(
                names,
                lambda name, suffix=suffix: name.endswith(suffix),
                f"bundled {vendor_name} in the sdist",
            )

        environment_prefix = exactly_one(
            names,
            lambda name: name.endswith(
                "/mazebench_cli/_runtime/environments/mazebench/pyproject.toml"
            ),
            "Agent environment project in the sdist",
        ).removesuffix("/pyproject.toml")
        require_agent_environment(names, environment_prefix)


def smoke_wheel_agent_command(wheel_path: Path) -> None:
    """Exercise the installed Agent route without contacting a provider."""

    with tempfile.TemporaryDirectory(prefix="mazebench-wheel-smoke-") as temporary:
        root = Path(temporary)
        installed = root / "site-packages"
        with zipfile.ZipFile(wheel_path) as archive:
            safe_archive_names(archive.namelist(), wheel_path.name)
            archive.extractall(installed)

        fake_bin = root / "bin"
        fake_bin.mkdir()
        cwd_path = root / "uv-cwd.txt"
        argv_path = root / "uv-argv.txt"
        fake_uv = fake_bin / "uv"
        fake_uv.write_text(
            "#!/bin/sh\n"
            'printf \'%s\\n\' "$PWD" > "$MAZEBENCH_SMOKE_CWD"\n'
            'printf \'%s\\n\' "$@" > "$MAZEBENCH_SMOKE_ARGV"\n',
            encoding="utf-8",
        )
        fake_uv.chmod(0o755)

        code = (
            "import sys; "
            "sys.path.insert(0, sys.argv[1]); "
            "import mazebench_cli; "
            "raise SystemExit(mazebench_cli.main(['prime', 'eval', "
            "'model=openai/smoke', 'n=1', 'r=1', 'max_turns=1']))"
        )
        environment = os.environ.copy()
        environment.pop("MAZEBENCH_REPO_ROOT", None)
        environment.update(
            {
                "MAZEBENCH_HOME": str(root / "home"),
                "MAZEBENCH_SMOKE_CWD": str(cwd_path),
                "MAZEBENCH_SMOKE_ARGV": str(argv_path),
                "PATH": f"{fake_bin}{os.pathsep}{environment.get('PATH', '')}",
            }
        )
        result = subprocess.run(
            [sys.executable, "-I", "-c", code, str(installed)],
            cwd=root,
            env=environment,
            capture_output=True,
            check=False,
            text=True,
        )
        if result.returncode != 0:
            fail(
                "wheel-installed Agent command failed: "
                f"{(result.stderr or result.stdout).strip()}"
            )

        environment_dir = root / "home" / "site" / "environments" / "mazebench"
        command_cwd = Path(cwd_path.read_text(encoding="utf-8").strip())
        if command_cwd.resolve() != environment_dir.resolve():
            fail(f"Agent command used the wrong environment: {str(command_cwd)!r}")
        argv = argv_path.read_text(encoding="utf-8").splitlines()
        required_arguments = (
            "mazebench-tools",
            "--env.agent.harness.id",
            "null",
            "--env.agent.runtime.type",
            "prime",
        )
        if any(argument not in argv for argument in required_arguments):
            fail(f"Agent command is incomplete: {argv!r}")
        if not all(
            (environment_dir / marker).is_file() for marker in AGENT_ENVIRONMENT_MARKERS
        ):
            fail("materialized Agent environment is incomplete")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("dist_dir", nargs="?", default="dist", type=Path)
    options = parser.parse_args()
    dist_dir = options.dist_dir.resolve()

    wheels = sorted(dist_dir.glob("mazebench-*.whl"))
    sdists = sorted(dist_dir.glob("mazebench-*.tar.gz"))
    if len(wheels) != 1 or len(sdists) != 1:
        fail(
            f"expected exactly one wheel and one sdist in {dist_dir}; "
            f"found wheels={wheels!r}, sdists={sdists!r}"
        )

    expected_notice = (ROOT / NOTICE_NAME).read_bytes()
    expected_license = (ROOT / LICENSE_NAME).read_bytes()
    verify_wheel(wheels[0], expected_notice, expected_license)
    verify_sdist(sdists[0], expected_notice, expected_license)
    smoke_wheel_agent_command(wheels[0])
    print(f"release archive verification passed: {wheels[0].name}, {sdists[0].name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
