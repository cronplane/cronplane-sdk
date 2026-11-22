"""The commands of each step: built, never run here."""

import sys
from dataclasses import replace
from pathlib import Path

import pytest

from cronplane_kit.cli import KIT
from cronplane_kit.plan import Flow, Level, Plan
from cronplane_kit.steps import (
    PYTEST,
    PYTEST_COV,
    STEPS,
    Context,
    OnFailure,
    Services,
    Step,
    StepError,
    When,
    coverage_data,
    coverage_floor,
    marked_tests,
)

READ = Flow("tests/flows/read.yaml", Level.E2E, (("api", "${doubles.api.url}/v1"),))
WRITE = Flow(
    "tests/flows/write.yaml",
    Level.INTEGRATION,
    (("postgres_url", "postgresql://fixture@127.0.0.1:55432/x"), ("api", "${doubles.api.url}")),
)


@pytest.fixture
def ctx(action: Path, tmp_path: Path) -> Context:
    return Context(
        action,
        Path("/bin/cronplane"),
        KIT,
        tmp_path / "work",
        ("3.12", "3.13"),
        plan=Plan(("postgres",), (READ, WRITE)),
    )


def argv(ctx: Context, step: Step) -> list[list[str]]:
    return [list(c.argv) for c in STEPS[step](ctx)]


def test_every_step_builds_its_commands(ctx: Context) -> None:
    assert set(STEPS) == set(Step)
    for step in Step:
        assert all(c.cwd == ctx.action for c in STEPS[step](ctx)), step


def test_validate_asks_for_the_hub_rules_as_json(ctx: Context) -> None:
    assert argv(ctx, Step.VALIDATE) == [
        ["/bin/cronplane", "action", "validate", str(ctx.action), "--hub", "--json"]
    ]


def test_the_rules_are_the_kits_whatever_the_action_configures(ctx: Context) -> None:
    for step in (Step.FORMAT, Step.LINT):
        (command,) = argv(ctx, step)
        assert command[:3] == [sys.executable, "-m", "ruff"]
        assert command[command.index("--config") + 1].endswith("rules/ruff.toml")
    sync, pyright = STEPS[Step.TYPES](ctx)
    assert sync.env["UV_PROJECT_ENVIRONMENT"].endswith("env-3.13"), "the newest version"
    (path, config) = pyright.writes[0]
    assert path == ctx.work / "pyrightconfig.json"
    assert '"typeCheckingMode": "strict"' in config
    assert '"pythonVersion": "3.13"' in config


def test_unit_tests_run_once_per_version_with_the_kits_tools(ctx: Context) -> None:
    commands = STEPS[Step.UNIT](ctx)
    runs = [c for c in commands if "pytest" in c.argv]
    assert [c.argv[c.argv.index("--python") + 1] for c in runs] == ["3.12", "3.13"]
    assert all(PYTEST in c.argv and PYTEST_COV in c.argv for c in runs)
    assert [c.env["UV_PROJECT_ENVIRONMENT"].rsplit("-", 1)[1] for c in runs] == ["3.12", "3.13"]
    assert all(c.argv[c.argv.index("-m") + 1] == "not integration" for c in runs)


def test_the_coverage_threshold_applies_where_every_test_runs(ctx: Context) -> None:
    def pytests(step: Step, context: Context) -> list[list[str]]:
        return [list(c.argv) for c in STEPS[step](context) if "pytest" in c.argv]

    assert all("--cov-fail-under=0" in run for run in pytests(Step.UNIT, ctx))
    for run in pytests(Step.INTEGRATION, ctx):
        assert "--cov-fail-under=0" not in run
        assert "-m" not in run, "without the unit step before, every test runs here"
    alone = replace(ctx, plan=Plan((), (READ,)))
    assert all("--cov-fail-under=0" not in run for run in pytests(Step.UNIT, alone))
    assert STEPS[Step.INTEGRATION](alone) == []


def test_the_marked_tests_add_what_they_cover_to_what_the_unit_step_covered(ctx: Context) -> None:
    ctx.work.mkdir()
    coverage_data(ctx, "3.12").write_text("")
    earlier, alone = (c for c in STEPS[Step.INTEGRATION](ctx) if "pytest" in c.argv)
    assert list(earlier.argv)[-3:] == ["-m", "integration", "--cov-append"]
    assert earlier.passes == (0, 5), "no marked test: the sum is still measured"
    assert "--cov-append" not in alone.argv, "3.13 has no unit run: every test runs"
    assert alone.passes == (0,)
    (unit_run,) = (
        c for c in STEPS[Step.UNIT](replace(ctx, versions=("3.12",))) if "pytest" in c.argv
    )
    assert (
        unit_run.env["COVERAGE_FILE"]
        == earlier.env["COVERAGE_FILE"]
        == str(coverage_data(ctx, "3.12"))
    )


def test_a_test_marked_integration_has_an_integration_flow_or_is_an_error(ctx: Context) -> None:
    tests = ctx.action / "tests"
    (tests / ".venv").mkdir(parents=True)
    (tests / ".venv" / "lib.py").write_text("@pytest.mark.integration\n")
    (tests / "broken.py").write_bytes(b"\xff\xfe")
    (tests / "test_api.py").write_text("def test_parse(): ...\n")
    alone = replace(ctx, plan=Plan((), (READ,)))
    assert marked_tests(ctx.action) is None
    assert STEPS[Step.UNIT](alone)
    (tests / "test_store.py").write_text("@pytest.mark.integration\ndef test_x(): ...\n")
    assert marked_tests(ctx.action) == "tests/test_store.py"
    with pytest.raises(StepError, match=r"tests/test_store\.py has a test marked integration"):
        STEPS[Step.UNIT](alone)
    assert STEPS[Step.UNIT](ctx), "its integration flow names the service"


def test_the_e2e_level_runs_the_flows_that_need_doubles_only(ctx: Context) -> None:
    runs = ["--runs-dir", str(ctx.work / "runs")]
    assert argv(ctx, Step.E2E) == [
        ["/bin/cronplane", "test", str(ctx.action), "--level", "e2e", *runs]
    ]
    assert argv(replace(ctx, plan=Plan(("postgres",), (WRITE,))), Step.E2E) == []
    with pytest.raises(StepError, match="one test flow at least"):
        STEPS[Step.E2E](replace(ctx, plan=Plan((), ())))


def test_the_integration_level_runs_between_the_start_and_the_stop_of_its_services(
    ctx: Context,
) -> None:
    commands = STEPS[Step.INTEGRATION](ctx)
    compose = ["docker", "compose", "-f", str(ctx.action / "tests" / "compose.yaml")]
    assert list(commands[0].argv) == [*compose, "up", "-d", "--wait", "postgres"]
    assert (list(commands[-1].argv), commands[-1].when) == ([*compose, "down", "-v"], When.ALWAYS)
    assert list(commands[-2].argv)[3:5] == ["--level", "integration"]
    runs = [c for c in commands if "pytest" in c.argv]
    assert [c.env["POSTGRES_URL"] for c in runs] == ["postgresql://fixture@127.0.0.1:55432/x"] * 2
    assert all("API" not in c.env for c in runs), "the address of a double is not known yet"

    running = STEPS[Step.INTEGRATION](replace(ctx, services=Services.RUNNING))
    assert not any("compose" in c.argv for c in running)
    assert len(running) == len(commands) - 2


def test_two_values_for_one_secret_of_the_integration_flows_are_an_error(ctx: Context) -> None:
    other = Flow("tests/flows/other.yaml", Level.INTEGRATION, (("postgres_url", "postgresql://y"),))
    with pytest.raises(
        StepError, match=r"other\.yaml: test\.secrets\.postgres_url has another value"
    ):
        STEPS[Step.INTEGRATION](replace(ctx, plan=Plan(("postgres",), (WRITE, other))))
    same = Flow("tests/flows/same.yaml", Level.INTEGRATION, WRITE.secrets)
    assert STEPS[Step.INTEGRATION](replace(ctx, plan=Plan(("postgres",), (WRITE, same))))


def test_the_coverage_threshold_is_required(action: Path) -> None:
    assert coverage_floor(action) == 90.0
    (action / "pyproject.toml").write_text("[project]\nname = 'demo'\n")
    with pytest.raises(StepError, match="fail_under is required"):
        coverage_floor(action)
    (action / "pyproject.toml").write_text("[tool.coverage.report]\nfail_under = true\n")
    with pytest.raises(StepError, match="fail_under is required"):
        coverage_floor(action)
    (action / "pyproject.toml").write_text("[project")
    with pytest.raises(StepError, match=r"pyproject\.toml"):
        coverage_floor(action)


def test_the_library_installed_says_the_cronplane_the_action_must_require(ctx: Context) -> None:
    sync, ask = STEPS[Step.CRONPLANE](replace(ctx, requires_cronplane="0.1"))
    assert sync.env == {"UV_PROJECT_ENVIRONMENT": str(ctx.work / "env-3.13")}
    assert list(ask.argv) == [
        str(ctx.work / "env-3.13" / "bin" / "python"),
        str(KIT / "python" / "src" / "cronplane_kit" / "needs.py"),
        "0.1",
    ]
    assert ask.cwd == ctx.action
    _, silent = STEPS[Step.CRONPLANE](ctx)
    assert silent.argv[-1] == ""


def test_only_an_advisory_on_what_the_action_installs_at_run_time_fails_the_audit(
    ctx: Context,
) -> None:
    export, audit, export_all, audit_all = STEPS[Step.AUDIT](ctx)
    assert "--no-emit-project" in export.argv
    assert "--no-dev" in export.argv
    assert list(audit.argv[-2:]) == ["-r", str(ctx.work / "requirements.txt")]
    assert audit.on_failure is OnFailure.STOP
    assert "--no-dev" not in export_all.argv
    assert export_all.on_failure is OnFailure.STOP
    assert list(audit_all.argv[-2:]) == ["-r", str(ctx.work / "requirements-dev.txt")]
    assert audit_all.on_failure is OnFailure.REPORT


def test_the_licences_read_what_the_lock_installs(ctx: Context) -> None:
    sync, check = STEPS[Step.LICENCES](ctx)
    assert "--no-dev" in sync.argv
    assert sync.env["UV_PROJECT_ENVIRONMENT"] == str(ctx.work / "env-run")
    assert list(check.argv) == [
        str(KIT / "licences" / "check.sh"),
        str(ctx.work / "env-run"),
        str(ctx.action),
        str(ctx.work / "sbom.spdx.json"),
    ]


def test_the_sbom_goes_where_it_is_asked(ctx: Context, tmp_path: Path) -> None:
    kept = Context(
        ctx.action, ctx.cronplane, ctx.kit, ctx.work, ctx.versions, tmp_path / "kept.json"
    )
    _, check = STEPS[Step.LICENCES](kept)
    assert check.argv[-1] == str(tmp_path / "kept.json")


@pytest.mark.parametrize(
    ("versions", "message"), [((), "no Python version"), (("3.x",), "not a number")]
)
def test_a_matrix_without_usable_version_stops_the_types(
    ctx: Context, versions: tuple[str, ...], message: str
) -> None:
    with pytest.raises(StepError, match=message):
        STEPS[Step.TYPES](Context(ctx.action, ctx.cronplane, ctx.kit, ctx.work, versions))


def test_prepare_takes_from_the_network_what_the_tests_need_and_runs_none(ctx: Context) -> None:
    commands = STEPS[Step.PREPARE](ctx)
    assert [c.argv[1] for c in commands] == ["sync", "run", "sync", "run"]
    tools = [c for c in commands if c.argv[1] == "run"]
    assert all(list(c.argv[-2:]) == ["pytest", "--version"] for c in tools), "no test runs"
    assert all(PYTEST in c.argv and PYTEST_COV in c.argv for c in tools)
    assert [c.env["UV_PROJECT_ENVIRONMENT"].rsplit("-", 1)[1] for c in tools] == ["3.12", "3.13"]
    assert list(Step).index(Step.PREPARE) < list(Step).index(Step.UNIT)
