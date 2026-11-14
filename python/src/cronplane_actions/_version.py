"""The version of Cronplane this library needs, and the check of the version
the worker announces (`contract/version/cases.json`)."""

from __future__ import annotations

import re
from dataclasses import dataclass

from ._errors import VersionError

#: The oldest Cronplane this library works with: a major and a minor.
REQUIRES_CRONPLANE = "0.1"

#: The variable that carries the version of Cronplane running the step.
VARIABLE = "CRONPLANE_VERSION"

_NEEDED = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", re.ASCII)
# What follows a `-` or a `+` is not read.
_ANNOUNCED = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\Z|[-+])", re.ASCII)


@dataclass(frozen=True, order=True)
class Minor:
    """A minor version of Cronplane: `0.1`."""

    major: int
    minor: int

    @classmethod
    def parse(cls, text: str) -> Minor:
        """`0.1`; `ValueError` on anything else."""
        found = _NEEDED.fullmatch(text)
        if found is None:
            raise ValueError(f"{text!r} is not a minor version of Cronplane")
        return cls(int(found.group(1)), int(found.group(2)))

    @classmethod
    def of(cls, version: str) -> Minor:
        """The minor of a version of Cronplane (`0.1.4`, `0.2.0-rc.1`); `ValueError`
        on anything else."""
        found = _ANNOUNCED.match(version)
        if found is None:
            raise ValueError(f"{version!r} is not a version of Cronplane")
        return cls(int(found.group(1)), int(found.group(2)))

    def __str__(self) -> str:
        return f"{self.major}.{self.minor}"


def check(needs: Minor, announced: str | None) -> None:
    """`VersionError` unless the Cronplane that runs the step is `needs` or a
    later minor of the same major."""
    if announced is None:
        raise VersionError(
            f"this action needs Cronplane {needs} or newer: the worker does not say its "
            f"version ({VARIABLE})"
        )
    try:
        running = Minor.of(announced)
    except ValueError as e:
        raise VersionError(f"{VARIABLE}: {e}") from e
    if running.major > needs.major:
        raise VersionError(
            f"this action needs Cronplane {needs.major}.x, from {needs}: "
            f"this is Cronplane {announced}"
        )
    if running < needs:
        raise VersionError(
            f"this action needs Cronplane {needs} or newer: this is Cronplane {announced}"
        )
