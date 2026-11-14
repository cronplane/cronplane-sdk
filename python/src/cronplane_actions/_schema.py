"""The schema of a record (`schema` of a stream's `schema.json`): a subset
of JSON Schema, the same in every library for actions. A schema that uses
anything else is refused: a keyword is never ignored."""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Final

from ._errors import SchemaError
from ._json import JsonValue

#: The deepest schema accepted.
MAX_DEPTH: Final = 32

_TYPES: Final = frozenset({"object", "array", "string", "integer", "number", "boolean", "null"})
#: Accepted and not checked.
_ANNOTATIONS: Final = frozenset({"$schema", "title", "description", "default", "examples"})
_DATE_TIME: Final = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?"
    r"(?:[Zz]|[+-]([0-9]{2}):([0-9]{2}))"
)
_DAYS: Final = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
_FEBRUARY: Final = 2


@dataclass(frozen=True)
class Problem:
    """What a record breaks: the place of the value in the record (a JSON
    Pointer, `""` for the record itself) and the keyword it breaks."""

    at: str
    keyword: str

    def __str__(self) -> str:
        return f"{self.at or '/'}: {self.keyword}"


@dataclass(frozen=True)
class _Node:
    """A schema, read once."""

    types: frozenset[str] | None = None
    properties: Mapping[str, _Node] | None = None
    required: tuple[str, ...] = ()
    #: The schema of the properties not named; `False` refuses them.
    additional: _Node | bool = True
    items: _Node | None = None
    min_items: int | None = None
    max_items: int | None = None
    enum: tuple[JsonValue, ...] | None = None
    min_length: int | None = None
    max_length: int | None = None
    minimum: int | float | None = None
    maximum: int | float | None = None
    date_time: bool = False


def _pointer(at: str, token: str) -> str:
    return f"{at}/{token.replace('~', '~0').replace('/', '~1')}"


def _is_number(value: JsonValue) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _is_integer(value: JsonValue) -> bool:
    if isinstance(value, bool):
        return False
    return isinstance(value, int) or (isinstance(value, float) and value.is_integer())


_IS: Final[Mapping[str, Callable[[JsonValue], bool]]] = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "integer": _is_integer,
    "number": _is_number,
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def _same(a: JsonValue, b: JsonValue) -> bool:
    """Whether two scalars are equal as JSON values: `1` is `1.0`, `True` is not `1`."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    return a == b


def _is_date_time(text: str) -> bool:
    match = _DATE_TIME.fullmatch(text)
    if match is None:
        return False
    year, month, day, hour, minute, second = (int(match.group(i)) for i in range(1, 7))
    if not 1 <= month <= len(_DAYS):
        return False
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    days = _DAYS[month - 1] + (1 if leap and month == _FEBRUARY else 0)
    zone_hour, zone_minute = (int(match.group(i) or 0) for i in (7, 8))
    return (
        1 <= day <= days
        and hour <= 23  # noqa: PLR2004
        and minute <= 59  # noqa: PLR2004
        and second <= 59  # noqa: PLR2004
        and zone_hour <= 23  # noqa: PLR2004
        and zone_minute <= 59  # noqa: PLR2004
    )


def _refuse(at: str, keyword: str, why: str) -> SchemaError:
    return SchemaError(at, keyword, why)


def _count(schema: Mapping[str, JsonValue], keyword: str, at: str) -> int | None:
    """A length or a number of items: an integer from 0."""
    if keyword not in schema:
        return None
    value = schema[keyword]
    if not _is_integer(value) or not isinstance(value, int | float) or value < 0:
        raise _refuse(at, keyword, "an integer from 0 is expected")
    return int(value)


def _bound(schema: Mapping[str, JsonValue], keyword: str, at: str) -> int | float | None:
    if keyword not in schema:
        return None
    value = schema[keyword]
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise _refuse(at, keyword, "a number is expected")
    return value


def _types(value: JsonValue, at: str) -> frozenset[str]:
    names = value if isinstance(value, list) else [value]
    found: set[str] = set()
    for name in names:
        if not isinstance(name, str) or name not in _TYPES or name in found:
            raise _refuse(at, "type", f"one of {', '.join(sorted(_TYPES))}, each once, is expected")
        found.add(name)
    if not found:
        raise _refuse(at, "type", "one type at least is expected")
    return frozenset(found)


def _required(value: JsonValue, at: str) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise _refuse(at, "required", "a list of property names is expected")
    names: list[str] = []
    for name in value:
        if not isinstance(name, str) or name in names:
            raise _refuse(at, "required", "property names, each once, are expected")
        names.append(name)
    return tuple(names)


def _enum(value: JsonValue, at: str) -> tuple[JsonValue, ...]:
    if not isinstance(value, list) or not value:
        raise _refuse(at, "enum", "a list of one value at least is expected")
    if any(isinstance(item, list | dict) for item in value):
        raise _refuse(at, "enum", "strings, numbers, booleans or null are expected")
    return tuple(value)


def _properties(schema: Mapping[str, JsonValue], at: str, depth: int) -> dict[str, _Node] | None:
    if "properties" not in schema:
        return None
    declared = schema["properties"]
    if not isinstance(declared, dict):
        raise _refuse(at, "properties", "an object of schemas is expected")
    return {
        name: _node(sub, _pointer(f"{at}/properties", name), depth + 1)
        for name, sub in declared.items()
    }


def _additional(schema: Mapping[str, JsonValue], at: str, depth: int) -> _Node | bool:
    other = schema.get("additionalProperties", True)
    if isinstance(other, bool):
        return other
    if isinstance(other, dict):
        return _node(other, f"{at}/additionalProperties", depth + 1)
    raise _refuse(at, "additionalProperties", "a boolean or a schema is expected")


def _items(schema: Mapping[str, JsonValue], at: str, depth: int) -> _Node | None:
    if "items" not in schema:
        return None
    if not isinstance(schema["items"], dict):
        raise _refuse(at, "items", "one schema is expected")
    return _node(schema["items"], f"{at}/items", depth + 1)


def _node(schema: JsonValue, at: str, depth: int) -> _Node:
    if not isinstance(schema, dict):
        raise _refuse(at, "", "a schema is an object")
    if depth > MAX_DEPTH:
        raise _refuse(at, "", f"a schema is nested {MAX_DEPTH} levels deep at most")
    known = {
        "type", "properties", "required", "additionalProperties", "items", "minItems", "maxItems",
        "enum", "minLength", "maxLength", "minimum", "maximum", "format",
    }  # fmt: skip
    for keyword in schema:
        if keyword not in known and keyword not in _ANNOTATIONS:
            raise _refuse(at, keyword, "this keyword is not one the libraries for actions read")

    if "format" in schema and schema["format"] != "date-time":
        raise _refuse(at, "format", "date-time is the only format read")

    return _Node(
        types=_types(schema["type"], at) if "type" in schema else None,
        properties=_properties(schema, at, depth),
        required=_required(schema["required"], at) if "required" in schema else (),
        additional=_additional(schema, at, depth),
        items=_items(schema, at, depth),
        min_items=_count(schema, "minItems", at),
        max_items=_count(schema, "maxItems", at),
        enum=_enum(schema["enum"], at) if "enum" in schema else None,
        min_length=_count(schema, "minLength", at),
        max_length=_count(schema, "maxLength", at),
        minimum=_bound(schema, "minimum", at),
        maximum=_bound(schema, "maximum", at),
        date_time="format" in schema,
    )


def _check_object(node: _Node, value: dict[str, JsonValue], at: str, found: list[Problem]) -> None:
    found.extend(
        Problem(_pointer(at, name), "required") for name in node.required if name not in value
    )
    properties = node.properties or {}
    for name, item in value.items():
        place = _pointer(at, name)
        if name in properties:
            _check(properties[name], item, place, found)
        elif node.additional is False:
            found.append(Problem(place, "additionalProperties"))
        elif isinstance(node.additional, _Node):
            _check(node.additional, item, place, found)


def _check_array(node: _Node, value: list[JsonValue], at: str, found: list[Problem]) -> None:
    if node.min_items is not None and len(value) < node.min_items:
        found.append(Problem(at, "minItems"))
    if node.max_items is not None and len(value) > node.max_items:
        found.append(Problem(at, "maxItems"))
    if node.items is not None:
        for index, item in enumerate(value):
            _check(node.items, item, f"{at}/{index}", found)


def _check_string(node: _Node, value: str, at: str, found: list[Problem]) -> None:
    if node.min_length is not None and len(value) < node.min_length:
        found.append(Problem(at, "minLength"))
    if node.max_length is not None and len(value) > node.max_length:
        found.append(Problem(at, "maxLength"))
    if node.date_time and not _is_date_time(value):
        found.append(Problem(at, "format"))


def _check(node: _Node, value: JsonValue, at: str, found: list[Problem]) -> None:
    if node.types is not None and not any(_IS[name](value) for name in node.types):
        found.append(Problem(at, "type"))
    if node.enum is not None and not any(_same(value, allowed) for allowed in node.enum):
        found.append(Problem(at, "enum"))
    if isinstance(value, dict):
        _check_object(node, value, at, found)
    elif isinstance(value, list):
        _check_array(node, value, at, found)
    elif isinstance(value, str):
        _check_string(node, value, at, found)
    elif not isinstance(value, bool) and isinstance(value, int | float):
        if node.minimum is not None and value < node.minimum:
            found.append(Problem(at, "minimum"))
        if node.maximum is not None and value > node.maximum:
            found.append(Problem(at, "maximum"))


@dataclass(frozen=True)
class RecordSchema:
    """The schema of the records of a stream, read once and checked."""

    #: As `schema.json` holds it.
    source: Mapping[str, JsonValue]
    _root: _Node

    @classmethod
    def parse(cls, schema: JsonValue) -> RecordSchema:
        """Reads `schema`; `SchemaError` when it is not one the libraries read."""
        root = _node(schema, "", 1)
        if not isinstance(schema, dict) or root.types != frozenset({"object"}):
            raise _refuse("", "type", "the schema of a record has type: object")
        return cls(schema, root)

    def problems(self, record: JsonValue) -> list[Problem]:
        """Every problem of `record`; none when it fits the schema."""
        found: list[Problem] = []
        _check(self._root, record, "", found)
        return found
