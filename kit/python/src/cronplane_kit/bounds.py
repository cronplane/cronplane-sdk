"""Every package the action depends on has an upper bound in `pyproject.toml`:
a new lock never takes a new major without the author changing the bound."""

from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Final, cast

from packaging.requirements import InvalidRequirement, Requirement
from packaging.version import Version

from .errors import StepError

#: The operators that keep a requirement under a version.
BOUNDING: Final = frozenset({"<", "<=", "==", "===", "~="})


def _next_major(lower: str) -> str:
    """The bound that keeps a requirement in the major of `lower` (0.x: its minor)."""
    # A specifier other than === holds a valid version.
    version = Version(lower)
    if version.major == 0:
        return f"0.{version.minor + 1}"
    return str(version.major + 1)


def unbounded(dependency: str) -> str | None:
    """`None` when `dependency` has an upper bound, else what to write instead."""
    try:
        requirement = Requirement(dependency)
    except InvalidRequirement as e:
        raise StepError(f"pyproject.toml: {dependency!r}: {e}") from e
    specifiers = list(requirement.specifier)
    if any(s.operator in BOUNDING for s in specifiers):
        return None
    lower = next((s.version for s in specifiers if s.operator in {">=", ">"}), None)
    name = requirement.name
    if lower is None:
        return f"{name}>=<version>,<<next major>>"
    return f"{dependency.strip()},<{_next_major(lower)}"


def check_bounds(action: Path) -> None:
    """Fails with a `StepError` naming each dependency without an upper bound."""
    try:
        project = tomllib.loads((action / "pyproject.toml").read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise StepError(f"pyproject.toml: {e}") from e
    table = project.get("project")
    fields = cast("dict[str, object]", table) if isinstance(table, dict) else {}
    dependencies: object = fields.get("dependencies", [])
    if not isinstance(dependencies, list):
        raise StepError("pyproject.toml: project.dependencies is a list")
    found = [
        f"{dependency} (write {fixed})"
        for dependency in cast("list[object]", dependencies)
        if isinstance(dependency, str) and (fixed := unbounded(dependency)) is not None
    ]
    if found:
        raise StepError(
            "pyproject.toml: a dependency without an upper bound lets a new lock take a new "
            f"major: {'; '.join(found)}"
        )
