"""The version of Cronplane the library needs: the cases every library for
actions passes (`contract/version/cases.json`), and where this library applies
them."""

from __future__ import annotations

import json
from pathlib import Path
from typing import cast

import pytest

from cronplane_actions import REQUIRES_CRONPLANE, JsonValue, VersionError
from cronplane_actions._version import VARIABLE, Minor, check

from .conftest import Step

_CASES = cast(
    "dict[str, JsonValue]",
    json.loads(
        (Path(__file__).parents[2] / "contract/version/cases.json").read_text(encoding="utf-8")
    ),
)
_SINCE = cast("dict[str, str]", _CASES["since"])
_ACCEPTED = cast("list[dict[str, str]]", _CASES["accepted"])
_REFUSED = cast("list[dict[str, str | None]]", _CASES["refused"])
_MALFORMED = cast("list[str]", _CASES["malformed"])

#: The parts of the contract this library implements.
IMPLEMENTED = ("schema", "streams", "state", "network")


def test_the_cases_are_those_of_the_version_this_library_reads() -> None:
    assert (_CASES["version"], _CASES["variable"]) == (1, VARIABLE)
    assert _ACCEPTED
    assert _REFUSED
    assert _MALFORMED


def test_the_library_needs_the_cronplane_of_the_latest_part_it_implements() -> None:
    assert sorted(_SINCE) == sorted(IMPLEMENTED)
    latest = max(Minor.parse(_SINCE[part]) for part in IMPLEMENTED)
    assert str(latest) == REQUIRES_CRONPLANE


@pytest.mark.parametrize("case", _ACCEPTED, ids=lambda case: case["name"])
def test_a_cronplane_of_the_contract_is_accepted(case: dict[str, str]) -> None:
    check(Minor.parse(case["needs"]), case["cronplane"])


@pytest.mark.parametrize("case", _REFUSED, ids=lambda case: case["name"])
def test_a_cronplane_of_the_contract_is_refused(case: dict[str, str | None]) -> None:
    with pytest.raises(VersionError) as error:
        check(Minor.parse(case["needs"] or ""), case["cronplane"])
    assert str(error.value) == case["message"]


@pytest.mark.parametrize("value", _MALFORMED)
def test_a_value_that_is_not_a_version_is_refused(value: str) -> None:
    with pytest.raises(VersionError, match=r"CRONPLANE_VERSION: .* is not a version of Cronplane"):
        check(Minor.parse("0.1"), value)


@pytest.mark.parametrize("text", ["", "1", "1.2.3", "01.2", "a.b"])
def test_a_minor_is_two_numbers(text: str) -> None:
    with pytest.raises(ValueError, match="not a minor version"):
        Minor.parse(text)


def test_the_action_starts_on_the_cronplane_it_needs(step: Step) -> None:
    step.env[VARIABLE] = f"{REQUIRES_CRONPLANE}.0"
    assert step.action().inputs.values == {}


def test_the_action_does_not_start_on_an_older_cronplane(step: Step) -> None:
    step.env[VARIABLE] = "0.0.9"
    with pytest.raises(VersionError, match=r"needs Cronplane 0\.1 or newer: this is Cronplane 0"):
        step.action()


def test_the_action_does_not_start_when_the_worker_does_not_say_its_version(step: Step) -> None:
    del step.env[VARIABLE]
    with pytest.raises(VersionError, match="the worker does not say its version"):
        step.action()
