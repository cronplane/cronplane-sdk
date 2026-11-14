"""Inputs, outputs, secrets and masked values: the contract with Cronplane."""

from __future__ import annotations

import re

import pytest

from cronplane_actions import (
    MAX_OUTPUT_BYTES,
    Action,
    ActionError,
    Egress,
    InputError,
    JsonValue,
    OutputError,
    SecretError,
)

from .conftest import Step


def test_inputs_read_with_the_type_action_yaml_declares(step: Step) -> None:
    inputs = (
        step.with_inputs(
            {
                "schema": "public",
                "memory": 512,
                "dry_run": True,
                "tables": ["a", "b"],
                "labels": {"team": "data", "tier": 2},
            }
        )
        .action()
        .inputs
    )
    assert inputs.string("schema") == "public"
    assert inputs.integer("memory") == 512
    assert inputs.boolean("dry_run") is True
    assert inputs.items("tables") == ["a", "b"]
    assert inputs.entries("labels") == {"team": "data", "tier": 2}
    assert inputs.has("schema")
    assert not inputs.has("missing")


@pytest.mark.parametrize(
    ("read", "value", "message"),
    [
        ("string", 3, "input x: a string is expected, not an integer"),
        ("integer", True, "input x: an integer is expected, not a boolean"),
        ("integer", "3", "input x: an integer is expected, not a string"),
        ("boolean", "true", "input x: a boolean is expected, not a string"),
        ("items", "a", "input x: a list is expected, not a string"),
        ("items", [{"a": 1}], "input x: an item is a string, an integer or a boolean, not a map"),
        ("entries", [1], "input x: a map is expected, not a list"),
        ("entries", {"k": None}, "input x: an item is a string, an integer or a boolean, not null"),
        ("string", 1.5, "input x: a string is expected, not a number"),
    ],
)
def test_an_input_of_another_type_names_the_input_and_both_types(
    step: Step, read: str, value: JsonValue, message: str
) -> None:
    inputs = step.with_inputs({"x": value}).action().inputs
    with pytest.raises(InputError, match=f"^{message}$"):
        getattr(inputs, read)("x")


def test_a_missing_input_is_an_error(step: Step) -> None:
    with pytest.raises(InputError, match="input schema: not given to the step"):
        step.action().inputs.string("schema")


def test_each_output_rewrites_the_whole_object_at_once(step: Step) -> None:
    outputs = step.action().outputs
    outputs.set("count", 3)
    outputs.set("files", ["a.sql"])
    assert step.output == {"count": 3, "files": ["a.sql"]}
    assert sorted(p.name for p in step.dir.iterdir() if p.name.startswith(".output-")) == []


def test_an_output_not_json_or_too_large_is_refused_and_the_file_kept(step: Step) -> None:
    outputs = step.action().outputs
    outputs.set("count", 3)
    with pytest.raises(OutputError, match="output ratio: not a JSON value"):
        outputs.set("ratio", float("nan"))
    with pytest.raises(OutputError, match="pass large data through files"):
        outputs.set("blob", "x" * MAX_OUTPUT_BYTES)
    assert step.output == {"count": 3}


def test_a_secret_comes_from_its_variable_or_its_file(step: Step) -> None:
    secrets = step.dir / "secrets"
    secrets.mkdir()
    (secrets / "KEY").write_text("-----BEGIN-----\nAAAA\n")
    step.env |= {"TOKEN": "t0k3n", "CRONPLANE_SECRETS": str(secrets)}
    action = step.action()
    assert action.secret("TOKEN") == "t0k3n"
    assert action.secret("KEY") == "-----BEGIN-----\nAAAA\n"
    with pytest.raises(SecretError, match="secret OTHER: not given to the step"):
        action.secret("OTHER")
    with pytest.raises(SecretError, match="not the name of a secret"):
        action.secret("../KEY")


def test_a_masked_value_is_added_to_the_mask_file_and_a_blank_one_ignored(step: Step) -> None:
    action = step.action()
    action.mask("tok-123")
    action.mask("  ")
    action.mask("pass-456")
    assert step.masked == ["tok-123", "pass-456"]


def test_the_outputs_of_the_needed_steps_and_the_trigger(step: Step) -> None:
    assert step.action().needed() == {"build": {"tag": "v1"}}
    with pytest.raises(ActionError, match="needs_trigger: true"):
        step.action().trigger()
    (step.dir / "trigger.json").write_text('{"type": "manual"}')
    step.env["CRONPLANE_TRIGGER"] = str(step.dir / "trigger.json")
    assert step.action().trigger() == {"type": "manual"}


@pytest.mark.parametrize("missing", ["CRONPLANE_WITH", "CRONPLANE_OUTPUT", "CRONPLANE_MASK"])
def test_a_step_not_run_as_an_action_is_told_so(step: Step, missing: str) -> None:
    del step.env[missing]
    with pytest.raises(ActionError, match=f"{missing} is not set"):
        step.action()


def test_inputs_that_are_not_an_object_are_refused(step: Step) -> None:
    (step.dir / "with.json").write_text("[1]")
    with pytest.raises(ActionError, match="a JSON object is expected"):
        step.action()
    (step.dir / "with.json").write_text("{")
    with pytest.raises(ActionError, match="cannot be read"):
        step.action()


def test_the_worker_egress_rule_reaches_the_http_client(step: Step) -> None:
    assert step.action().http.egress is Egress.ANY
    step.env["CRONPLANE_EGRESS"] = "public"
    assert step.action().http.egress is Egress.PUBLIC
    step.env["CRONPLANE_EGRESS"] = "private"
    with pytest.raises(ActionError, match="one of any, public, or unset"):
        step.action()


def test_from_environment_reads_the_process_environment(
    step: Step, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name, value in step.env.items():
        monkeypatch.setenv(name, value)
    assert Action.from_environment().inputs.values == {}


def test_files_that_cannot_be_read_or_written_name_the_file(step: Step) -> None:
    (step.dir / "inputs.json").write_text("[]")
    with pytest.raises(ActionError, match=re.escape("inputs.json: a JSON object is expected")):
        step.action().needed()
    (step.dir / "inputs.json").unlink()
    with pytest.raises(ActionError, match=re.escape("inputs.json: cannot be read")):
        step.action().needed()
    step.env["CRONPLANE_OUTPUT"] = str(step.dir / "gone" / "output.json")
    with pytest.raises(OutputError, match="cannot be written"):
        step.action().outputs.set("count", 1)
    (step.dir / "secrets" / "KEY").mkdir(parents=True)
    step.env["CRONPLANE_SECRETS"] = str(step.dir / "secrets")
    with pytest.raises(SecretError, match="secret KEY: cannot be read"):
        step.action().secret("KEY")
    del step.env["CRONPLANE_SECRETS"]
    with pytest.raises(SecretError, match="secret KEY: not given to the step"):
        step.action().secret("KEY")
