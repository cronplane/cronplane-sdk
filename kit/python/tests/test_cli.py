"""The checks of an action, in order, the first failure stopping them."""

import runpy
import sys
from pathlib import Path

import pytest

from cronplane_kit.cli import KIT, Config, check, main
from cronplane_kit.run import Outcome, runner
from cronplane_kit.steps import Command, Context, Step

from .conftest import report


class Fake:
    """Answers `validate` with `answer`, and fails the commands containing `failing`."""

    def __init__(self, answer: str, failing: str | None = None) -> None:
        self.answer, self.failing = answer, failing
        self.ran: list[str] = []

    def __call__(self, command: Command) -> Outcome:
        self.ran.append(str(command))
        if "validate" in command.argv:
            return Outcome(command, 0, self.answer)
        failed = self.failing is not None and self.failing in str(command)
        return Outcome(command, 1 if failed else 0, "boom" if failed else "")


def run_check(
    action: Path, fake: Fake, steps: list[Step], version: str | None = None
) -> tuple[bool, list[str]]:
    said: list[str] = []
    ctx = Context(action, Path("/bin/cronplane"), KIT, action.parent / "work")
    return check(ctx, fake, steps=steps, version=version, say=said.append), said


def test_the_steps_run_in_order_and_say_so(action: Path) -> None:
    fake = Fake(report(versions=("3.12", "3.13")))
    ok, said = run_check(action, fake, [Step.VALIDATE, Step.LOCKFILE, Step.TESTS])
    assert ok
    assert said == ["✓ validate: demo, Python 3.12, 3.13", "✓ lockfile", "✓ tests"]
    assert sum("pytest" in c.split() for c in fake.ran) == 2


def test_the_first_failure_stops_the_checks_with_its_output(action: Path) -> None:
    fake = Fake(report(), failing="ruff format")
    ok, said = run_check(action, fake, [Step.FORMAT, Step.LINT])
    assert not ok
    assert said[-1].startswith("✗ format: ")
    assert said[-1].endswith("\nboom")
    assert not any("ruff check" in c for c in fake.ran)


def test_an_advisory_on_a_development_tool_is_said_and_fails_nothing(action: Path) -> None:
    work = action.parent / "work"
    fake = Fake(report(), failing=f"-r {work / 'requirements-dev.txt'}")
    ok, said = run_check(action, fake, [Step.AUDIT, Step.LICENCES])
    assert ok
    assert said[1].startswith("! audit: ")
    assert said[1].endswith("(it does not fail the check)\nboom")
    assert said[2:] == ["✓ audit", "✓ licences"]


def test_an_advisory_on_what_the_action_installs_fails_the_audit(action: Path) -> None:
    work = action.parent / "work"
    fake = Fake(report(), failing=f"-r {work / 'requirements.txt'}")
    ok, said = run_check(action, fake, [Step.AUDIT])
    assert not ok
    assert said[-1].startswith("✗ audit: ")


def test_one_version_of_the_matrix_for_a_ci_job(action: Path) -> None:
    fake = Fake(report(versions=("3.12", "3.13")))
    ok, _ = run_check(action, fake, [Step.TESTS], version="3.13")
    assert ok
    assert sum("pytest" in c.split() for c in fake.ran) == 1
    ok, said = run_check(action, fake, [Step.TESTS], version="3.11")
    assert not ok
    assert said[-1] == "--version 3.11: not in the action's matrix (3.12, 3.13)"


@pytest.mark.parametrize(
    ("answer", "said"),
    [
        (report(ok=False), "✗ validate:\n  README.md: no README (readme)"),
        (report(runtime="typescript"), "a typescript action: use the adapter of its language"),
        ("not json", "✗ validate: the report cannot be read"),
    ],
)
def test_a_report_that_is_not_ok_stops_everything(action: Path, answer: str, said: str) -> None:
    fake = Fake(answer)
    ok, told = run_check(action, fake, list(Step))
    assert not ok
    assert said in told[-1]
    assert len(fake.ran) == 1


def test_a_step_that_cannot_be_built_says_why(action: Path) -> None:
    (action / "pyproject.toml").write_text("[project]\nname = 'demo'\n")
    ok, said = run_check(action, Fake(report()), [Step.TESTS])
    assert not ok
    assert "fail_under is required" in said[-1]


def test_the_runner_runs_a_program_never_a_shell(tmp_path: Path) -> None:
    run = runner({"PATH": "/usr/bin:/bin", "VIRTUAL_ENV": "/kit/.venv"})
    config = tmp_path / "written.json"
    assert run(Command(["sh", "-c", "echo ${VIRTUAL_ENV:-none}"], tmp_path)).output == "none\n"
    done = run(
        Command(["sh", "-c", "echo $X; cat written.json"], tmp_path, {"X": "1"}, ((config, "{}"),))
    )
    assert (done.ok, done.output) == (True, "1\n{}")
    assert run(Command(["no-such-program-x"], tmp_path)).code == 127
    assert run(Command(["sh", "-c", "exit 3"], tmp_path)).code == 3


def test_the_runner_stops_a_command_that_never_ends(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("cronplane_kit.run.TIMEOUT_SECONDS", 0.2)
    assert runner({"PATH": "/usr/bin:/bin"})(Command(["sleep", "5"], tmp_path)).code == 124


def test_the_command_line_checks_an_action_with_the_cronplane_given(
    action: Path,
    cronplane: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("CRONPLANE_BIN", str(cronplane))
    with pytest.raises(SystemExit) as done:
        main(["check", str(action), "--step", "validate"])
    assert done.value.code == 0
    assert "✓ validate: demo, Python 3.12" in capsys.readouterr().out
    monkeypatch.delenv("CRONPLANE_BIN")
    with pytest.raises(SystemExit, match="CRONPLANE_BIN"):
        Config.from_environment({})


def test_python_m_cronplane_kit_runs_the_command_line(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "argv", ["cronplane-kit", "--help"])
    with pytest.raises(SystemExit):
        runpy.run_module("cronplane_kit", run_name="__main__")
    assert "check" in capsys.readouterr().out


def test_the_cronplane_the_action_requires_goes_to_its_check(action: Path) -> None:
    fake = Fake(report(requires_cronplane="0.1"))
    ok, said = run_check(action, fake, [Step.CRONPLANE])
    assert ok
    assert said[-1] == "✓ cronplane"
    assert fake.ran[-1].endswith("needs.py 0.1")
