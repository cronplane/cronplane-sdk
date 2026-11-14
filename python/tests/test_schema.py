"""The schema of a record: the cases every library for actions passes
(`contract/schema/cases.json`), and what this library adds to them."""

from __future__ import annotations

import json
from pathlib import Path
from typing import cast

import pytest

from cronplane_actions import Problem, RecordSchema, SchemaError
from cronplane_actions._json import JsonValue
from cronplane_actions._schema import MAX_DEPTH

_CASES = cast(
    "dict[str, JsonValue]",
    json.loads(
        (Path(__file__).parents[2] / "contract/schema/cases.json").read_text(encoding="utf-8")
    ),
)


def _list(value: JsonValue) -> list[dict[str, JsonValue]]:
    return cast("list[dict[str, JsonValue]]", value)


_SCHEMAS = _list(_CASES["schemas"])
_REFUSED = _list(_CASES["refused"])


def _places(problems: list[Problem]) -> list[tuple[str, str]]:
    return sorted((p.at, p.keyword) for p in problems)


def test_the_cases_are_those_of_the_version_this_library_reads() -> None:
    assert _CASES["version"] == 1
    assert cast("dict[str, JsonValue]", _CASES["limits"])["depth"] == MAX_DEPTH
    assert _SCHEMAS
    assert _REFUSED


@pytest.mark.parametrize("case", _SCHEMAS, ids=lambda c: str(c["name"]))
def test_a_record_that_fits_its_schema_has_no_problem(case: dict[str, JsonValue]) -> None:
    schema = RecordSchema.parse(case["schema"])
    valid = cast("list[JsonValue]", case["valid"])
    assert valid
    for record in valid:
        assert schema.problems(record) == [], record


@pytest.mark.parametrize("case", _SCHEMAS, ids=lambda c: str(c["name"]))
def test_a_record_that_does_not_fit_lists_every_problem_at_its_place(
    case: dict[str, JsonValue],
) -> None:
    schema = RecordSchema.parse(case["schema"])
    invalid = _list(case["invalid"])
    assert invalid
    for entry in invalid:
        expected = sorted((str(p["at"]), str(p["keyword"])) for p in _list(entry["problems"]))
        assert _places(schema.problems(entry["record"])) == expected, entry["record"]


@pytest.mark.parametrize("case", _REFUSED, ids=lambda c: str(c["name"]))
def test_a_schema_out_of_the_subset_is_refused_at_its_place(case: dict[str, JsonValue]) -> None:
    with pytest.raises(SchemaError) as refused:
        RecordSchema.parse(case["schema"])
    assert (refused.value.at, refused.value.keyword) == (case["at"], case["keyword"])


# One valid use of each keyword the library reads.
_USES: dict[str, JsonValue] = {
    "type": "string",
    "properties": {"a": {}},
    "required": ["a"],
    "additionalProperties": False,
    "items": {},
    "minItems": 0,
    "maxItems": 1,
    "enum": ["a"],
    "minLength": 0,
    "maxLength": 1,
    "minimum": 0,
    "maximum": 1,
    "format": "date-time",
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "A",
    "description": "a",
    "default": None,
    "examples": [],
}


def test_every_keyword_of_the_contract_is_read_and_no_other() -> None:
    names = [
        *cast("dict[str, JsonValue]", _CASES["keywords"]),
        *_list_of_text(_CASES["annotations"]),
    ]
    assert sorted(_USES) == sorted(names)
    for keyword, value in _USES.items():
        RecordSchema.parse({"type": "object", "properties": {"a": {keyword: value}}})
    with pytest.raises(SchemaError) as unknown:
        RecordSchema.parse({"type": "object", "x-unknown": 1})
    assert (unknown.value.at, unknown.value.keyword) == ("", "x-unknown")
    assert "schema /: x-unknown: this keyword is not one" in str(unknown.value)


def _list_of_text(value: JsonValue) -> list[str]:
    return [str(item) for item in cast("list[JsonValue]", value)]


def _nested(levels: int) -> JsonValue:
    schema: JsonValue = {"type": "string"}
    for _ in range(levels - 1):
        schema = {"type": "object", "properties": {"a": schema}}
    return schema


def test_a_schema_is_nested_within_the_depth_of_the_contract() -> None:
    assert RecordSchema.parse(_nested(MAX_DEPTH)).problems({}) == []
    with pytest.raises(SchemaError) as refused:
        RecordSchema.parse(_nested(MAX_DEPTH + 1))
    assert refused.value.keyword == ""
    assert refused.value.at == "/properties/a" * MAX_DEPTH
    assert "nested 32 levels deep at most" in str(refused.value)


def test_a_problem_reads_as_its_place_and_its_keyword() -> None:
    schema = RecordSchema.parse({"type": "object", "required": ["id"]})
    assert [str(p) for p in schema.problems({})] == ["/id: required"]
    assert [str(p) for p in schema.problems([])] == ["/: type"]
    assert schema.source == {"type": "object", "required": ["id"]}
