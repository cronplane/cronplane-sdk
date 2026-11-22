"""The plan of the test flows, as `cronplane test --plan --json` prints it."""

import json

import pytest

from cronplane_kit.plan import NO_PLAN, Level, Plan, PlanError

from .conftest import plan


def test_the_plan_gives_the_flows_of_each_level_and_their_services() -> None:
    read = Plan.parse(
        plan(
            ("read.yaml", "e2e", {"api": "${doubles.api.url}"}),
            ("write.yaml", "integration", {"postgres_url": "postgresql://x"}),
            services=("postgres",),
        )
    )
    assert read.services == ("postgres",)
    assert [f.file for f in read.of(Level.E2E)] == ["tests/flows/read.yaml"]
    assert [f.secrets for f in read.of(Level.INTEGRATION)] == [
        (("postgres_url", "postgresql://x"),)
    ]
    assert read.variables() == {"POSTGRES_URL": "postgresql://x"}
    assert (NO_PLAN.flows, NO_PLAN.variables()) == ((), {})


@pytest.mark.parametrize(
    ("text", "why"),
    [
        ("not json", "not JSON"),
        ("[]", "a JSON object is expected"),
        (json.dumps({"version": 2}), "version 2: this adapter reads version 1"),
        (
            json.dumps({"version": 1, "flows": [{"file": "a.yaml", "level": "unit"}]}),
            "a flow without",
        ),
        (json.dumps({"version": 1, "flows": [{"level": "e2e"}]}), "a flow without"),
    ],
)
def test_a_plan_of_another_shape_is_refused(text: str, why: str) -> None:
    with pytest.raises(PlanError, match=why):
        Plan.parse(text)


def test_what_is_not_text_in_a_plan_is_left_out() -> None:
    read = Plan.parse(
        json.dumps(
            {
                "version": 1,
                "services": ["postgres", 7],
                "flows": [{"file": "a.yaml", "level": "e2e", "secrets": {"a": "x", "b": 1}}],
            }
        )
    )
    assert read.services == ("postgres",)
    assert read.flows[0].secrets == (("a", "x"),)
