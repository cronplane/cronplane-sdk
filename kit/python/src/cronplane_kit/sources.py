"""Where the packages of an action come from: PyPI only, never a git repository."""

from __future__ import annotations

import tomllib
from pathlib import Path
from typing import cast

from .errors import StepError


def git_packages(lock: Path) -> list[str]:
    """The names of the packages of `uv.lock` taken from git."""
    try:
        data = tomllib.loads(lock.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise StepError(f"{lock.name}: {e}") from e
    found: list[str] = []
    for package in cast("list[object]", data.get("package", [])):
        fields = cast("dict[str, object]", package) if isinstance(package, dict) else {}
        source = fields.get("source")
        git = cast("dict[str, object]", source).get("git") if isinstance(source, dict) else None
        name = fields.get("name")
        if isinstance(git, str) and isinstance(name, str):
            found.append(name)
    return found


def check_sources(action: Path) -> None:
    """Fails with a `StepError` if a package of the action comes from git."""
    for name in git_packages(action / "uv.lock"):
        raise StepError(f"uv.lock: {name} comes from a git repository: take it from PyPI")
