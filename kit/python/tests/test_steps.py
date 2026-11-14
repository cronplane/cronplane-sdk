"""The commands of each step: built, never run here."""

import sys
from dataclasses import replace
from pathlib import Path

import pytest

from cronplane_kit.cli import KIT
from cronplane_kit.steps import (
    PYTEST,
    PYTEST_COV,
    STEPS,
    Context,
    OnFailure,
    Step,
    StepError,
    coverage_floor,
)


@pytest.fixture
def ctx(action: Path, tmp_path: Path) -> Context:
    return Context(action, Path("/bin/cronplane"), KIT, tmp_path / "work", ("3.12", "3.13"))


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


def test_tests_run_once_per_version_with_the_kits_tools(ctx: Context) -> None:
    commands = STEPS[Step.TESTS](ctx)
    runs = [c for c in commands if "pytest" in c.argv]
    assert [c.argv[c.argv.index("--python") + 1] for c in runs] == ["3.12", "3.13"]
    assert all(PYTEST in c.argv and PYTEST_COV in c.argv for c in runs)
    assert [c.env["UV_PROJECT_ENVIRONMENT"].rsplit("-", 1)[1] for c in runs] == ["3.12", "3.13"]


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


def test_flows_run_with_their_secrets_file(ctx: Context) -> None:
    assert argv(ctx, Step.FLOWS) == []
    flows = ctx.action / "tests" / "flows"
    flows.mkdir(parents=True)
    (flows / "b.yaml").write_text("")
    (flows / "a.yaml").write_text("")
    assert [c[2] for c in argv(ctx, Step.FLOWS)] == [str(flows / "a.yaml"), str(flows / "b.yaml")]
    (flows / "secrets.env").write_text("TOKEN=x\n")
    assert argv(ctx, Step.FLOWS)[0][-2:] == ["--secret-file", str(flows / "secrets.env")]


@pytest.mark.parametrize(
    ("versions", "message"), [((), "no Python version"), (("3.x",), "not a number")]
)
def test_a_matrix_without_usable_version_stops_the_types(
    ctx: Context, versions: tuple[str, ...], message: str
) -> None:
    with pytest.raises(StepError, match=message):
        STEPS[Step.TYPES](Context(ctx.action, ctx.cronplane, ctx.kit, ctx.work, versions))
