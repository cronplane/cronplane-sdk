"""The report of `cronplane action validate --hub --json`, version 1: read as
data, never run."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import cast

#: The only version of the report this adapter reads.
VERSION = 1


class ReportError(Exception):
    """The report is not one this adapter reads."""


@dataclass(frozen=True)
class Problem:
    rule: str
    at: str
    message: str

    def __str__(self) -> str:
        return f"{self.at}: {self.message} ({self.rule})"


@dataclass(frozen=True)
class Report:
    #: The action's name and runtime; none when `action.yaml` is invalid.
    name: str | None
    runtime: str | None
    #: The versions to test, for the action's runtime.
    versions: tuple[str, ...]
    ok: bool
    problems: tuple[Problem, ...]
    #: The oldest Cronplane the action says it runs on (`0.1`), if it says one.
    requires_cronplane: str | None = None

    @classmethod
    def parse(cls, text: str) -> Report:
        try:
            fields = _fields(json.loads(text))
        except ValueError as e:
            raise ReportError(f"not JSON: {e}") from e
        if fields is None:
            raise ReportError("a JSON object is expected")
        if fields.get("version") != VERSION:
            raise ReportError(
                f"version {fields.get('version')!r}: this adapter reads version {VERSION}"
            )
        action = _fields(fields.get("action")) or {}
        versions = tuple(
            version
            for entry in _items(fields.get("matrix"))
            if (version := _text((_fields(entry) or {}).get("version"))) is not None
        )
        problems = tuple(
            Problem(
                _text(p.get("rule")) or "", _text(p.get("at")) or "", _text(p.get("message")) or ""
            )
            for p in (_fields(item) for item in _items(fields.get("problems")))
            if p is not None
        )
        return cls(
            _text(action.get("name")),
            _text(action.get("runtime")),
            versions,
            fields.get("ok") is True,
            problems,
            _text(action.get("requires_cronplane")),
        )


def _fields(value: object) -> dict[str, object] | None:
    """`value` when it is a JSON object."""
    if not isinstance(value, dict):
        return None
    # json.loads builds objects with string keys only.
    return cast("dict[str, object]", value)


def _items(value: object) -> list[object]:
    """`value` when it is a JSON array, else nothing."""
    return cast("list[object]", value) if isinstance(value, list) else []


def _text(value: object) -> str | None:
    return value if isinstance(value, str) else None
