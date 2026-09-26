#!/usr/bin/env python3
"""Stage the exact upstream vendor sources pinned by the Android engine overlay."""
from __future__ import annotations

import hashlib
import io
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tarfile

HARNESS_COMMIT = "477b4f420553e8a52c2fbccc464d7561b239c443"
SOURCE_OVERRIDES = [
    {
        "package": "@deepseek-ai/cordis-plugin-group",
        "path": "vendor/group",
        "commit": "7bedce822f2c6b076df167dff46eecf81bbd5de4",
    },
    {
        "package": "@deepseek-ai/cordis-plugin-hmr",
        "path": "vendor/hmr",
        "commit": "183f08e9c6dde7e36cd2318eaee70b0da08fb35e",
    },
    {
        "package": "@deepseek-ai/cordis-plugin-include",
        "path": "vendor/include",
        "commit": "183f08e9c6dde7e36cd2318eaee70b0da08fb35e",
    },
    {
        "package": "@deepseek-ai/cordis-plugin-loader",
        "path": "vendor/loader",
        "commit": "183f08e9c6dde7e36cd2318eaee70b0da08fb35e",
    },
    {
        "package": "@deepseek-ai/cordis-plugin-timer",
        "path": "vendor/timer",
        "commit": "183f08e9c6dde7e36cd2318eaee70b0da08fb35e",
    },
]


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def git(repo: pathlib.Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=repo, text=True).strip()


def manifest_at(repo: pathlib.Path, commit: str, package_path: str) -> dict[str, object]:
    raw = subprocess.check_output(
        ["git", "show", f"{commit}:{package_path}/package.json"], cwd=repo
    )
    return json.loads(raw.decode("utf-8"))


def stage_archive(
    repo: pathlib.Path,
    commit: str,
    package_path: str,
    stage_root: pathlib.Path,
) -> list[dict[str, object]]:
    archive = subprocess.check_output(
        ["git", "archive", "--format=tar", commit, package_path], cwd=repo
    )
    target_root = stage_root / package_path.split("/")[-1]
    target_root.mkdir(parents=True, exist_ok=False)
    files: list[dict[str, object]] = []
    prefix = pathlib.PurePosixPath(package_path)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as source:
        for member in source.getmembers():
            name = pathlib.PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts:
                raise ValueError(f"unsafe path in pinned source archive: {member.name}")
            if member.isdir() and prefix.parts[: len(name.parts)] == name.parts and len(name.parts) < len(prefix.parts):
                continue
            if name.parts[: len(prefix.parts)] != prefix.parts:
                raise ValueError(f"unexpected path in pinned source archive: {member.name}")
            if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                raise ValueError(f"unsupported entry in pinned source archive: {member.name}")
            relative = pathlib.Path(*name.parts[len(prefix.parts) :])
            if not relative.parts:
                continue
            target = target_root / relative
            try:
                target.resolve(strict=False).relative_to(target_root.resolve())
            except ValueError as exc:
                raise ValueError(f"archive path escaped staging directory: {member.name}") from exc
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            extracted = source.extractfile(member)
            if extracted is None:
                raise ValueError(f"could not read pinned source file: {member.name}")
            payload = extracted.read()
            target.write_bytes(payload)
            os.chmod(target, stat.S_IMODE(member.mode))
            files.append({
                "path": (pathlib.PurePosixPath(package_path) / relative.as_posix()).as_posix(),
                "size": len(payload),
                "sha256": sha256(payload),
            })
    if not files:
        raise ValueError(f"pinned source archive is empty: {commit}:{package_path}")
    return sorted(files, key=lambda item: str(item["path"]))


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit(
            "usage: prepare-harness-vendor-overrides.py <harness-source-root> <engine-overlay.json> <report.json>"
        )
    repo, overlay_path, report_path = map(pathlib.Path, sys.argv[1:])
    repo = repo.resolve()
    overlay_path = overlay_path.resolve()
    report_path = report_path.resolve()
    commit = git(repo, "rev-parse", "HEAD")
    if commit != HARNESS_COMMIT:
        raise ValueError(f"unexpected Harness source commit: {commit}")
    overlay = json.loads(overlay_path.read_text(encoding="utf-8"))
    report_path.parent.mkdir(parents=True, exist_ok=True)
    stage_root = report_path.parent / "vendor-overrides-stage"
    shutil.rmtree(stage_root, ignore_errors=True)
    stage_root.mkdir(parents=True)

    staged: list[tuple[pathlib.Path, pathlib.Path]] = []
    overrides: list[dict[str, object]] = []
    try:
        for item in SOURCE_OVERRIDES:
            package_name = str(item["package"])
            package_path = str(item["path"])
            source_commit = str(item["commit"])
            expected_version = (overlay.get("packages") or {}).get(package_name)
            source_manifest = manifest_at(repo, source_commit, package_path)
            current_manifest = manifest_at(repo, HARNESS_COMMIT, package_path)
            if source_manifest.get("name") != package_name:
                raise ValueError(f"{source_commit}:{package_path} is not {package_name}")
            if source_manifest.get("version") != expected_version:
                raise ValueError(
                    f"overlay pins {package_name}@{expected_version}, but {source_commit} has "
                    f"{source_manifest.get('version')}"
                )
            if current_manifest.get("name") != package_name:
                raise ValueError(f"{HARNESS_COMMIT}:{package_path} is not {package_name}")

            staged_root = stage_root / pathlib.Path(package_path).name
            files = stage_archive(repo, source_commit, package_path, stage_root)
            staged.append((repo / package_path, staged_root))
            staged_manifest = json.loads((staged_root / "package.json").read_text(encoding="utf-8"))
            if staged_manifest.get("version") != expected_version:
                raise ValueError(f"staged source manifest changed for {package_name}")
            overrides.append({
                "package": package_name,
                "path": package_path,
                "version": expected_version,
                "sourceCommit": source_commit,
                "sourceTree": git(repo, "rev-parse", f"{source_commit}:{package_path}"),
                "sourceManifestSha256": sha256((staged_root / "package.json").read_bytes()),
                "currentCommitVersion": current_manifest.get("version"),
                "sourceFiles": files,
            })

        backups: list[tuple[pathlib.Path, pathlib.Path]] = []
        try:
            for target, staged_root in staged:
                backup = stage_root / (target.name + ".original")
                shutil.copytree(target, backup, symlinks=False)
                backups.append((target, backup))
                shutil.rmtree(target)
                shutil.copytree(staged_root, target, symlinks=False)
        except Exception:
            for target, backup in reversed(backups):
                if target.exists():
                    shutil.rmtree(target)
                shutil.copytree(backup, target, symlinks=False)
            raise

        report = {
            "repository": "https://github.com/deepseek-ai/deepseek-harness",
            "harnessSourceCommit": commit,
            "harnessSourceTree": git(repo, "rev-parse", "HEAD^{tree}"),
            "engineOverlaySha256": sha256(overlay_path.read_bytes()),
            "overrides": overrides,
        }
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"staged {len(overrides)} overlay-pinned Cordis packages from verified Harness commits")
    finally:
        shutil.rmtree(stage_root, ignore_errors=True)


if __name__ == "__main__":
    main()
