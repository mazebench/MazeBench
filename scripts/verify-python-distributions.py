#!/usr/bin/env python3
"""Fail a release build when its wheel or sdist omits required payloads."""

from __future__ import annotations

import argparse
import tarfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Callable, Iterable


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


def verify_wheel(wheel_path: Path, expected_notice: bytes, expected_license: bytes) -> None:
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
            lambda name: name.endswith(f".dist-info/licenses/{LICENSE_NAME}")
            or name.endswith(f".dist-info/{LICENSE_NAME}"),
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
        if "License-Expression: MIT" not in metadata_text and "License: MIT" not in metadata_text:
            fail(f"{metadata} does not declare the MIT license")

        for vendor_name in VENDOR_FILES:
            expected_path = f"mazebench_cli/_runtime/vendor/{vendor_name}"
            exactly_one(
                names,
                lambda name, expected_path=expected_path: name == expected_path,
                f"bundled {vendor_name} in the wheel",
            )


def verify_sdist(sdist_path: Path, expected_notice: bytes, expected_license: bytes) -> None:
    with tarfile.open(sdist_path, "r:gz") as archive:
        members = archive.getmembers()
        names = safe_archive_names((member.name for member in members), sdist_path.name)
        member_by_name = {member.name: member for member in members}

        root_notice = exactly_one(
            names,
            lambda name: len(PurePosixPath(name).parts) == 2
            and name.endswith(f"/{NOTICE_NAME}"),
            "top-level third-party notice in the sdist",
        )
        root_license = exactly_one(
            names,
            lambda name: len(PurePosixPath(name).parts) == 2
            and name.endswith(f"/{LICENSE_NAME}"),
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
    print(
        "release archive verification passed: "
        f"{wheels[0].name}, {sdists[0].name}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
