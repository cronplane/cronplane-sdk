"""JSON values, typed: what `json.loads` returns, checked once."""

from __future__ import annotations

import json
from typing import TypeAlias, cast

JsonValue: TypeAlias = "str | int | float | bool | list[JsonValue] | dict[str, JsonValue] | None"


def parse(text: str | bytes) -> JsonValue:
    """The JSON value of `text`; `ValueError` when it is not JSON."""
    # json.loads builds only JSON values: `checked` never raises here.
    return checked(json.loads(text, parse_constant=_not_json))


def _not_json(constant: str) -> JsonValue:
    """`NaN` and `Infinity`: Python reads them, JSON has no such value."""
    raise ValueError(f"{constant} is not a JSON value")


def checked(value: object) -> JsonValue:
    """`value` as a JSON value; `TypeError` when it holds anything else."""
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, list):
        # A list, whatever its items: each is checked below.
        items = cast("list[object]", value)
        return [checked(item) for item in items]
    if isinstance(value, dict):
        # A dict, whatever its keys and values: each is checked below.
        entries = cast("dict[object, object]", value)
        result: dict[str, JsonValue] = {}
        for key, item in entries.items():
            if not isinstance(key, str):
                raise TypeError(f"a JSON object key is a string, not {key!r}")
            result[key] = checked(item)
        return result
    raise TypeError(f"not a JSON value: {type(value).__name__}")
