"""The report of `validate --hub --json`, read as data."""

import pytest

from cronplane_kit.report import Problem, Report, ReportError

from .conftest import report


def test_the_matrix_and_the_problems_are_read() -> None:
    read = Report.parse(report(versions=("3.12", "3.13")))
    assert (read.name, read.runtime, read.versions, read.ok) == (
        "demo",
        "python",
        ("3.12", "3.13"),
        True,
    )
    failed = Report.parse(report(ok=False))
    assert failed.problems == (Problem("readme", "README.md", "no README"),)
    assert str(failed.problems[0]) == "README.md: no README (readme)"


def test_the_cronplane_the_action_requires_is_read() -> None:
    assert Report.parse(report(requires_cronplane="0.1")).requires_cronplane == "0.1"
    assert Report.parse(report()).requires_cronplane is None


def test_an_invalid_action_has_no_name() -> None:
    invalid = (
        '{"version": 1, "action": null, "matrix": [], "ok": false, '
        '"problems": [{"rule": "definition"}]}'
    )
    read = Report.parse(invalid)
    assert (read.name, read.runtime, read.problems) == (
        None,
        None,
        (Problem("definition", "", ""),),
    )


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("{", "not JSON"),
        ("[]", "a JSON object is expected"),
        ('{"version": 2}', "version 2: this adapter reads version 1"),
    ],
)
def test_another_report_is_refused(text: str, message: str) -> None:
    with pytest.raises(ReportError, match=message):
        Report.parse(text)
