"""Checks that an action says, in `requires.cronplane`, a Cronplane as new as
the one its library needs. It runs as a program with the Python of the
action's environment, where `cronplane_actions` is installed: it imports
nothing of the kit.

    python needs.py <the oldest Cronplane action.yaml names, or nothing>
"""

from __future__ import annotations

import importlib
import sys

LIBRARY = "cronplane_actions"


def needed() -> str | None:
    """The Cronplane the library of the environment needs (`0.1`); none when
    the action does not use the library."""
    try:
        library = importlib.import_module(LIBRARY)
    except ImportError:
        return None
    version: object = getattr(library, "REQUIRES_CRONPLANE", None)
    return version if isinstance(version, str) else None


def numbers(version: str) -> tuple[int, ...]:
    """`0.1` as numbers; `ValueError` on anything else."""
    return tuple(int(part) for part in version.split("."))


def problem(declared: str, needs: str | None) -> str | None:
    """What is wrong with the Cronplane `action.yaml` names, if anything."""
    if needs is None:
        return None
    advice = f'write `requires: {{cronplane: ">={needs}"}}`'
    if not declared:
        return (
            f"action.yaml: requires.cronplane is missing: the library cronplane-actions needs "
            f"Cronplane {needs} or newer ({advice})"
        )
    try:
        older = numbers(declared)[:2] < numbers(needs)[:2]
    except ValueError:
        return f"action.yaml: requires.cronplane: {declared!r} is not a version"
    if older:
        return (
            f"action.yaml: requires.cronplane says >={declared}: the library cronplane-actions "
            f"needs Cronplane {needs} or newer ({advice})"
        )
    return None


def main(argv: list[str]) -> int:
    found = problem(argv[1] if len(argv) > 1 else "", needed())
    if found is not None:
        print(found, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main(sys.argv))
