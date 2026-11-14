"""Where a step starts again: the state Cronplane keeps between runs."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from cronplane_actions import MAX_STATE_BYTES, State, StateError

from .conftest import Step


@pytest.fixture
def stateful(step: Step) -> Step:
    step.env["CRONPLANE_STATE_OUT"] = str(step.dir / "state_out.json")
    return step


def _kept(step: Step, text: str) -> None:
    (step.dir / "state.json").write_text(text)
    step.env["CRONPLANE_STATE"] = str(step.dir / "state.json")


def _written(step: Step) -> object:
    return json.loads((step.dir / "state_out.json").read_text())


def test_an_action_without_state_true_is_told_so(step: Step) -> None:
    with pytest.raises(StateError, match="the action needs `state: true`"):
        _ = step.action().state


def test_a_first_run_has_no_state_and_writes_the_next(stateful: Step) -> None:
    state = stateful.action().state
    assert state.get() is None
    assert state.stream("contacts") == {}
    state.set({"cursor": "2026-11-08T12:45:00+00:00"})
    assert _written(stateful) == {"cursor": "2026-11-08T12:45:00+00:00"}
    state.set(["é", 1])
    assert _written(stateful) == ["é", 1], "written whole each time"
    assert not list(stateful.dir.glob(".state-*")), "no temporary file left"


def test_the_state_kept_is_read_as_the_last_successful_run_left_it(stateful: Step) -> None:
    _kept(stateful, '{"version": 1, "streams": {"contacts": {"cursor": "a", "last_key": 111}}}')
    state = stateful.action().state
    assert state.stream("contacts") == {"cursor": "a", "last_key": 111}
    assert state.stream("deals") == {}
    assert state.get() == {"version": 1, "streams": {"contacts": {"cursor": "a", "last_key": 111}}}


def test_each_stream_keeps_its_own_entry(stateful: Step) -> None:
    _kept(stateful, '{"version": 1, "streams": {"contacts": {"cursor": "a"}, "deals": {"k": 1}}}')
    state = stateful.action().state
    state.set_stream("contacts", {"cursor": "b"})
    state.set_stream("companies", {"cursor": "c"})
    assert _written(stateful) == {
        "version": 1,
        "streams": {"contacts": {"cursor": "b"}, "deals": {"k": 1}, "companies": {"cursor": "c"}},
    }
    assert state.stream("contacts") == {"cursor": "a"}, (
        "what the run read, until Cronplane keeps it"
    )


def test_a_state_of_another_form_is_not_read_per_stream(stateful: Step) -> None:
    for text, problem in [
        ('{"cursor": "a"}', "not one of this library"),
        ("[1]", "not one of this library"),
        ('{"version": 2, "streams": {}}', "not one of this library"),
        ('{"version": 1, "streams": []}', 'no "streams" object'),
    ]:
        _kept(stateful, text)
        with pytest.raises(StateError, match=problem):
            stateful.action().state.stream("contacts")
        with pytest.raises(StateError, match=problem):
            stateful.action().state.set_stream("contacts", {})
    _kept(stateful, '{"version": 1, "streams": {"contacts": "text"}}')
    assert stateful.action().state.stream("contacts") == {}


def test_a_state_too_large_or_not_json_is_refused_and_nothing_written(stateful: Step) -> None:
    state = stateful.action().state
    state.set({"cursor": 1})
    with pytest.raises(StateError, match="more than 32768: keep where to start again, never data"):
        state.set("x" * MAX_STATE_BYTES)
    with pytest.raises(StateError, match="not a JSON value"):
        state.set(float("nan"))
    assert _written(stateful) == {"cursor": 1}
    state.set("x" * (MAX_STATE_BYTES - 2))


def test_a_state_that_cannot_be_read_or_written_names_its_file(stateful: Step) -> None:
    _kept(stateful, "{not json")
    with pytest.raises(StateError, match=r"state\.json: the state cannot be read"):
        stateful.action().state.get()
    missing = State(None, Path(stateful.dir / "gone" / "state_out.json"))
    with pytest.raises(StateError, match=r"state_out\.json: cannot be written"):
        missing.set({})
