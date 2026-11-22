"""The checks of an action, in order, the first failure stopping them."""

import json
import runpy
import sys
from dataclasses import replace
from pathlib import Path

import pytest

from cronplane_kit.cli import KIT, Config, check, main
from cronplane_kit.run import Outcome, runner
from cronplane_kit.steps import Command, Context, Ended, Previous, Services, Step, sheet

from .conftest import plan, report


class Fake:
    """Answers `validate` with `answer`, `test --plan` with `flows` and
    `test --plan --previous` with `before`, and fails the commands containing
    `failing`."""

    def __init__(
        self,
        answer: str,
        failing: str | None = None,
        flows: str | None = None,
        before: str | None = None,
    ) -> None:
        self.answer, self.failing = answer, failing
        self.flows = plan(("hello.yaml", "e2e", {})) if flows is None else flows
        self.before = self.flows if before is None else before
        self.ran: list[str] = []

    def __call__(self, command: Command) -> Outcome:
        self.ran.append(str(command))
        if "validate" in command.argv:
            return Outcome(command, 0, self.answer)
        if "--plan" in command.argv and self.failing != "--plan":
            return Outcome(command, 0, self.before if "--previous" in command.argv else self.flows)
        failed = self.failing is not None and self.failing in str(command)
        return Outcome(command, 1 if failed else 0, "boom" if failed else "")


def run_check(
    action: Path,
    fake: Fake,
    steps: list[Step],
    version: str | None = None,
    services: Services = Services.START,
) -> tuple[bool, list[str]]:
    said: list[str] = []
    ctx = Context(action, Path("/bin/cronplane"), KIT, action.parent / "work", services=services)
    return check(ctx, fake, steps=steps, version=version, say=said.append), said


def run_regression(
    action: Path, fake: Fake, previous: Previous, services: Services = Services.START
) -> tuple[bool, list[str]]:
    """The regression step alone, against `previous`."""
    said: list[str] = []
    work = action.parent / "work"
    ctx = Context(action, Path("/bin/cronplane"), KIT, work, services=services, previous=previous)
    return check(ctx, fake, steps=[Step.REGRESSION], say=said.append), said


def test_the_steps_run_in_order_and_say_so(action: Path) -> None:
    fake = Fake(report(versions=("3.12", "3.13")))
    ok, said = run_check(action, fake, [Step.VALIDATE, Step.LOCKFILE, Step.UNIT])
    assert ok
    assert said == ["✓ validate: demo, Python 3.12, 3.13", "✓ lockfile", "✓ unit"]
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
    ok, _ = run_check(action, fake, [Step.UNIT], version="3.13")
    assert ok
    assert sum("pytest" in c.split() for c in fake.ran) == 1
    ok, said = run_check(action, fake, [Step.UNIT], version="3.11")
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
    ok, said = run_check(action, Fake(report()), [Step.UNIT])
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


def test_a_command_says_the_exit_codes_that_are_not_a_failure(tmp_path: Path) -> None:
    run = runner({"PATH": "/usr/bin:/bin"})
    assert not run(Command(["sh", "-c", "exit 5"], tmp_path)).ok
    assert run(Command(["sh", "-c", "exit 5"], tmp_path, passes=(0, 5))).ok
    assert not run(Command(["sh", "-c", "exit 1"], tmp_path, passes=(0, 5))).ok


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


WRITE = ("write.yaml", "integration", {"postgres_url": "postgresql://fixture@127.0.0.1/x"})


def test_each_level_says_what_it_ran(action: Path) -> None:
    flows = plan(("a.yaml", "e2e", {}), ("b.yaml", "e2e", {}), WRITE, services=("postgres",))
    fake = Fake(report(), flows=flows)
    ok, said = run_check(action, fake, [Step.E2E, Step.INTEGRATION])
    assert ok
    assert said[1:] == ["✓ e2e: 2 flows", "✓ integration: 1 flow, services: postgres"]
    ok, said = run_check(action, Fake(report()), [Step.E2E, Step.INTEGRATION])
    assert ok
    assert said[1:] == ["✓ e2e: 1 flow", "✓ integration: not provided"]


def test_an_action_without_test_flow_fails_its_levels(action: Path) -> None:
    ok, said = run_check(action, Fake(report(), flows=plan()), [Step.E2E])
    assert not ok
    assert "an action has one test flow at least" in said[-1]


@pytest.mark.parametrize(
    ("fake", "said"),
    [
        (Fake(report(), failing="--plan"), "✗ test flows: /bin/cronplane test"),
        (Fake(report(), flows="not json"), "✗ test flows: the plan cannot be read: not JSON"),
    ],
)
def test_test_flows_that_cannot_be_read_stop_the_levels(
    action: Path, fake: Fake, said: str
) -> None:
    ok, told = run_check(action, fake, [Step.LOCKFILE, Step.UNIT])
    assert not ok
    assert told[-1].startswith(said)
    assert not any("uv lock" in c for c in fake.ran), "nothing ran"


def test_the_services_are_stopped_whatever_fails(action: Path) -> None:
    flows = plan(WRITE, services=("postgres",))
    fake = Fake(report(), failing="up -d --wait", flows=flows)
    ok, said = run_check(action, fake, [Step.INTEGRATION])
    assert not ok
    assert said[-1].startswith("✗ integration: docker compose")
    assert not any("pytest" in c.split() for c in fake.ran), "no test without its service"
    assert fake.ran[-1].endswith("down -v")

    fake = Fake(report(), failing="--level integration", flows=flows)
    ok, said = run_check(action, fake, [Step.INTEGRATION])
    assert not ok
    assert fake.ran[-1].endswith("down -v")


def test_services_that_run_already_are_left_alone(action: Path) -> None:
    fake = Fake(report(), flows=plan(WRITE, services=("postgres",)))
    ok, _ = run_check(action, fake, [Step.INTEGRATION], services=Services.RUNNING)
    assert ok
    assert not any("compose" in c for c in fake.ran)
    assert any("--level integration" in c for c in fake.ran)


def test_the_command_line_takes_who_starts_the_services(
    action: Path, cronplane: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CRONPLANE_BIN", str(cronplane))
    with pytest.raises(SystemExit) as done:
        main(["check", str(action), "--step", "e2e", "--services", "running"])
    assert done.value.code == 0


def test_without_the_version_before_the_regression_step_says_it_is_not_provided(
    action: Path,
) -> None:
    fake = Fake(report())
    ok, said = run_check(action, fake, [Step.REGRESSION])
    assert ok
    assert said[-1] == "✓ regression: not provided"
    assert not any("compare" in c for c in fake.ran)


def test_the_regression_step_compares_the_contracts_then_runs_the_flows_of_the_version_before(
    action: Path, tmp_path: Path
) -> None:
    before = Previous(tmp_path / "v1", "1.4.2", "1.5.0")
    fake = Fake(report(), before=plan(WRITE, ("read.yaml", "e2e", {}), services=("postgres",)))
    ok, said = run_regression(action, fake, before)
    assert ok
    assert said[-1] == "✓ regression: 2 flows of the version before"
    numbers = f"--previous {tmp_path / 'v1'} --from 1.4.2 --to 1.5.0"
    compose = f"docker compose -f {tmp_path / 'v1' / 'tests' / 'compose.yaml'}"
    assert fake.ran[1:] == [
        f"/bin/cronplane test {action} --plan --json {numbers}",
        f"/bin/cronplane action compare {action} {numbers}",
        f"{compose} up -d --wait postgres",
        f"/bin/cronplane test {action} {numbers} --runs-dir {action.parent / 'work' / 'runs'}",
        f"{compose} down -v",
    ]


def test_a_number_too_low_for_the_contract_stops_before_any_flow_runs(
    action: Path, tmp_path: Path
) -> None:
    fake = Fake(report(), failing="action compare")
    ok, said = run_regression(action, fake, Previous(tmp_path / "v1"))
    assert not ok
    assert said[-1].startswith("✗ regression: /bin/cronplane action compare")
    assert fake.ran[-1].startswith("/bin/cronplane action compare")


def test_a_flow_of_the_version_before_that_fails_stops_its_services_too(
    action: Path, tmp_path: Path
) -> None:
    before = plan(WRITE, services=("postgres",))
    fake = Fake(report(), failing="--runs-dir", before=before)
    ok, said = run_regression(action, fake, Previous(tmp_path / "v1"))
    assert not ok
    assert said[-1].startswith(f"✗ regression: /bin/cronplane test {action} --previous")
    assert fake.ran[-1].endswith("down -v")


def test_a_version_before_without_a_flow_that_runs_only_compares_the_contracts(
    action: Path, tmp_path: Path
) -> None:
    fake = Fake(report(), before=plan())
    ok, said = run_regression(action, fake, Previous(tmp_path / "v1"))
    assert ok
    assert said[-1] == "✓ regression: 0 flows of the version before"
    assert fake.ran[-1] == f"/bin/cronplane action compare {action} --previous {tmp_path / 'v1'}"

    running = Fake(report(), before=plan(WRITE, services=("postgres",)))
    ok, _ = run_regression(action, running, Previous(tmp_path / "v1"), Services.RUNNING)
    assert ok
    assert not any("compose" in c.split() for c in running.ran)

    unread = Fake(report(), failing="--plan")
    ok, said = run_regression(action, unread, Previous(tmp_path / "v1"))
    assert not ok
    assert said[-1].startswith("✗ test flows: /bin/cronplane test")


def test_the_command_line_takes_the_version_before_and_its_numbers(
    action: Path, cronplane: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CRONPLANE_BIN", str(cronplane))
    (tmp_path / "plan.json").write_text(plan())
    before = ["--previous", str(tmp_path / "v1"), "--from", "1.4.2", "--to", "1.5.0"]
    with pytest.raises(SystemExit) as done:
        main(["check", str(action), "--step", "regression", *before])
    assert done.value.code == 0
    with pytest.raises(SystemExit) as refused:
        main(["check", str(action), "--step", "regression", "--from", "1.4.2"])
    assert refused.value.code == 2


def test_after_every_step_the_sheet_of_the_action_is_said(action: Path) -> None:
    fake = Fake(report())
    said: list[str] = []
    ctx = Context(action, Path("/bin/cronplane"), KIT, action.parent / "work")
    assert check(ctx, fake, steps=list(Step), say=said.append)
    results = action.parent / "work" / "results.json"
    assert fake.ran[-1] == f"/bin/cronplane action sheet {action} --results {results}"
    assert said[-2] == "✓ regression: not provided"

    part = Fake(report())
    assert check(ctx, part, steps=[Step.LINT], say=said.append)
    assert not any("action sheet" in c for c in part.ran), "a part of the steps gives no sheet"


def test_the_sheet_is_said_and_kept_even_when_a_step_failed(action: Path, tmp_path: Path) -> None:
    fake = Fake(report(), failing="ruff check")
    said: list[str] = []
    ctx = Context(
        action, Path("/bin/cronplane"), KIT, action.parent / "work", sheet=tmp_path / "sheet.json"
    )
    assert not check(ctx, fake, steps=[Step.FORMAT, Step.LINT, Step.UNIT], say=said.append)
    assert fake.ran[-1].endswith(f"--output {tmp_path / 'sheet.json'}")


def test_the_results_say_how_each_step_ended_and_what_was_covered(
    action: Path, tmp_path: Path
) -> None:
    work = tmp_path / "work"
    work.mkdir()
    before = Previous(tmp_path / "v1", "1.4.2", "1.5.0")
    ctx = Context(action, Path("/bin/cronplane"), KIT, work, ("3.12", "3.13"), previous=before)
    ended = {Step.VALIDATE: Ended.PASSED, Step.LOCKFILE: Ended.PASSED, Step.FORMAT: Ended.FAILED}
    command = sheet(ctx, ended)
    assert list(command.argv[4:]) == [
        "--results",
        str(work / "results.json"),
        "--previous",
        str(tmp_path / "v1"),
        "--from",
        "1.4.2",
        "--to",
        "1.5.0",
    ]
    ((path, text),) = command.writes
    results = json.loads(text)
    assert path == work / "results.json"
    assert results["version"] == 1
    assert set(results["steps"]) == {step.value for step in Step}
    assert results["steps"]["lockfile"] == "passed"
    assert results["steps"]["format"] == "failed"
    assert results["steps"]["unit"] == "not_run"
    assert results["coverage"] == {"measured": None, "threshold": 90.0}

    (work / "coverage-3.13.json").write_text('{"totals": {"percent_covered": 97.456}}')
    assert json.loads(sheet(ctx, ended).writes[0][1])["coverage"]["measured"] == 97.46
    (work / "coverage-3.13.json").write_text('{"totals": {"percent_covered": "high"}}')
    assert json.loads(sheet(ctx, ended).writes[0][1])["coverage"]["measured"] is None
    (work / "coverage-3.13.json").write_text("not json")
    assert json.loads(sheet(ctx, ended).writes[0][1])["coverage"]["measured"] is None

    (action / "pyproject.toml").write_text("[project]\nname = 'demo'\n")
    assert json.loads(sheet(replace(ctx, versions=()), ended).writes[0][1])["coverage"] is None


def test_the_command_line_keeps_the_sheet_where_it_is_asked(
    action: Path, cronplane: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CRONPLANE_BIN", str(cronplane))
    with pytest.raises(SystemExit) as done:
        main(["check", str(action), "--step", "e2e", "--sheet", str(tmp_path / "sheet.json")])
    assert done.value.code == 0


def test_the_results_and_the_work_of_a_check_are_kept_where_they_are_asked(
    action: Path, cronplane: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CRONPLANE_BIN", str(cronplane))
    kept, work = tmp_path / "results.json", tmp_path / "kept" / "work"
    with pytest.raises(SystemExit) as done:
        main(["check", str(action), "--step", "e2e", "--results", str(kept), "--work", str(work)])
    assert done.value.code == 0
    results = json.loads(kept.read_text())
    assert (results["steps"]["e2e"], results["steps"]["unit"]) == ("passed", "not_run")
    assert work.is_dir(), "it stays for the next check"
