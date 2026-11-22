"""The checks of a Python action, in order, declared once: each step gives the
commands it runs. Building a command runs nothing."""

from __future__ import annotations

import sys
import tomllib
from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import cast

from .bounds import check_bounds
from .errors import StepError
from .plan import NO_PLAN, Level, Plan
from .sources import check_sources

#: What pytest ends with when no test is selected.
NO_TEST_COLLECTED = 5

#: The test tools every action runs with, whatever its own lockfile pins.
PYTEST = "pytest==9.2.0"
PYTEST_COV = "pytest-cov==7.1.0"

RULES = Path(__file__).parent / "rules"


class Step(StrEnum):
    """The steps, in the order they run."""

    VALIDATE = "validate"
    LOCKFILE = "lockfile"
    FORMAT = "format"
    LINT = "lint"
    TYPES = "types"
    CRONPLANE = "cronplane"
    UNIT = "unit"
    AUDIT = "audit"
    LICENCES = "licences"
    E2E = "e2e"
    INTEGRATION = "integration"
    REGRESSION = "regression"


class OnFailure(StrEnum):
    """What the failure of a command does."""

    #: It stops the checks.
    STOP = "stop"
    #: It is only said.
    REPORT = "report"


class When(StrEnum):
    """When a command of a step runs."""

    #: After the commands before it, while none failed.
    IN_ORDER = "in order"
    #: Whatever failed in its step: what stops the services.
    ALWAYS = "always"


class Services(StrEnum):
    """Who starts the services of the integration level."""

    #: The kit, with `docker compose`, and it stops them.
    START = "start"
    #: They listen already (`--services running`): the kit starts nothing.
    RUNNING = "running"


@dataclass(frozen=True)
class Command:
    """A program and its arguments (never a shell line), its directory and
    the variables added to the environment."""

    argv: Sequence[str]
    cwd: Path
    env: dict[str, str] = field(default_factory=dict[str, str])
    #: Files written before it runs: path and text.
    writes: tuple[tuple[Path, str], ...] = ()
    on_failure: OnFailure = OnFailure.STOP
    when: When = When.IN_ORDER
    #: The exit codes that are not a failure.
    passes: tuple[int, ...] = (0,)

    def __str__(self) -> str:
        return " ".join(self.argv)


@dataclass(frozen=True)
class Previous:
    """The version before of the action."""

    #: Its folder, with its `tests/`.
    folder: Path
    #: Its number (`X.Y.Z`), when it is known.
    number: str | None = None
    #: The number of the version checked, when it has one.
    next_number: str | None = None
    #: Its test flows that run against the version checked.
    plan: Plan = NO_PLAN

    def numbers(self) -> list[str]:
        """What tells `cronplane` the numbers that are known."""
        given = [("--from", self.number), ("--to", self.next_number)]
        return [word for flag, number in given if number is not None for word in (flag, number)]


@dataclass(frozen=True)
class Context:
    """What the commands of one action need."""

    action: Path
    cronplane: Path
    kit: Path
    #: A directory of the check's own, for environments, reports and the SBOM.
    work: Path
    #: The Python versions to test (from the report).
    versions: tuple[str, ...] = ()
    #: Where the SBOM of the licences step goes (else the work directory).
    sbom: Path | None = None
    #: The oldest Cronplane the action says it runs on (from the report).
    requires_cronplane: str | None = None
    #: Its test flows (from `cronplane test --plan`); none before it is read.
    plan: Plan = NO_PLAN
    services: Services = Services.START
    #: The version before, for the regression step; none: the step runs nothing.
    previous: Previous | None = None


def tool(name: str, *args: str) -> list[str]:
    """A tool the kit pins, from the kit's own environment."""
    return [sys.executable, "-m", name, *args]


def validate(ctx: Context) -> list[Command]:
    return [
        Command(
            [str(ctx.cronplane), "action", "validate", str(ctx.action), "--hub", "--json"],
            ctx.action,
        )
    ]


def lockfile(ctx: Context) -> list[Command]:
    """The lock matches `pyproject.toml`, whose dependencies each have an upper bound."""
    check_bounds(ctx.action)
    return [Command(["uv", "lock", "--check"], ctx.action)]


def format_(ctx: Context) -> list[Command]:
    return [
        Command(
            tool("ruff", "format", "--check", "--config", str(RULES / "ruff.toml"), "."), ctx.action
        )
    ]


def lint(ctx: Context) -> list[Command]:
    return [Command(tool("ruff", "check", "--config", str(RULES / "ruff.toml"), "."), ctx.action)]


def environment(ctx: Context, version: str) -> Path:
    """The environment of the action's dependencies for one Python version."""
    return ctx.work / f"env-{version}"


def types(ctx: Context) -> list[Command]:
    """pyright, strict, on the environment of the newest version tested."""
    version = _newest(ctx)
    env = environment(ctx, version)
    config = (
        '{"typeCheckingMode": "strict", '
        f'"pythonVersion": "{version}", "include": ["{ctx.action}"], '
        '"exclude": ["**/.venv", "**/node_modules"]}'
    )
    return [
        _sync(ctx, version),
        Command(
            tool(
                "pyright",
                "--project",
                str(ctx.work / "pyrightconfig.json"),
                "--pythonpath",
                str(env / "bin" / "python"),
            ),
            ctx.action,
            writes=((ctx.work / "pyrightconfig.json", config),),
        ),
    ]


def cronplane(ctx: Context) -> list[Command]:
    """`requires.cronplane` of the action names a Cronplane as new as the one
    its library needs: asked to the library installed, on the newest version
    tested."""
    version = _newest(ctx)
    python = environment(ctx, version) / "bin" / "python"
    program = Path(__file__).parent / "needs.py"
    return [
        _sync(ctx, version),
        Command([str(python), str(program), ctx.requires_cronplane or ""], ctx.action),
    ]


def coverage_data(ctx: Context, version: str) -> Path:
    """Where the tests of one version keep what they covered."""
    return ctx.work / f"coverage-{version}"


def _pytest(
    ctx: Context,
    version: str,
    *args: str,
    env: dict[str, str] | None = None,
    passes: tuple[int, ...] = (0,),
) -> Command:
    """pytest with coverage on one version, with the test tools the kit pins."""
    return Command(
        [
            "uv",
            "run",
            "--frozen",
            "--python",
            version,
            "--with",
            PYTEST,
            "--with",
            PYTEST_COV,
            "pytest",
            "--cov=.",
            "--cov-branch",
            "--cov-report=term-missing",
            *args,
        ],
        ctx.action,
        {
            **(env or {}),
            "UV_PROJECT_ENVIRONMENT": str(environment(ctx, version)),
            "COVERAGE_FILE": str(coverage_data(ctx, version)),
        },
        passes=passes,
    )


def unit(ctx: Context) -> list[Command]:
    """The tests that need no service (`-m "not integration"`), once per
    version. The action's coverage threshold (`fail_under`) applies here,
    unless the action has an integration level: it then applies there, to
    what both steps covered."""
    coverage_floor(ctx.action)
    alone = not ctx.plan.of(Level.INTEGRATION)
    marked = marked_tests(ctx.action) if alone else None
    if marked is not None:
        raise StepError(
            f"{marked} has a test marked integration: an integration flow (tests/flows, "
            "level: integration) names its service, or the test is never run"
        )
    floor = () if alone else ("--cov-fail-under=0",)
    commands: list[Command] = []
    for version in ctx.versions:
        commands.append(_sync(ctx, version))
        commands.append(_pytest(ctx, version, "-m", "not integration", *floor))
    return commands


def audit(ctx: Context) -> list[Command]:
    """pip-audit on the locked packages: a known advisory on what the action
    installs at run time fails; those of the development tools are only
    said. A package taken from git fails: pip-audit knows PyPI only."""
    check_sources(ctx.action)
    requirements = ctx.work / "requirements.txt"
    everything = ctx.work / "requirements-dev.txt"
    export = ["uv", "export", "--frozen", "--no-emit-project"]
    as_requirements = ["--format", "requirements-txt", "-o"]
    return [
        Command([*export, "--no-dev", *as_requirements, str(requirements)], ctx.action),
        Command(tool("pip_audit", "--strict", "-r", str(requirements)), ctx.action),
        Command([*export, *as_requirements, str(everything)], ctx.action),
        Command(
            tool("pip_audit", "--strict", "-r", str(everything)),
            ctx.action,
            on_failure=OnFailure.REPORT,
        ),
    ]


def licences(ctx: Context) -> list[Command]:
    """The licences of what the action installs at run time (no dev
    dependency), on the newest version tested."""
    installed = ctx.work / "env-run"
    return [
        Command(
            ["uv", "sync", "--frozen", "--no-dev", "--python", _newest(ctx)],
            ctx.action,
            {"UV_PROJECT_ENVIRONMENT": str(installed)},
        ),
        Command(
            [
                str(ctx.kit / "licences" / "check.sh"),
                str(installed),
                str(ctx.action),
                str(ctx.sbom or ctx.work / "sbom.spdx.json"),
            ],
            ctx.action,
        ),
    ]


def _cronplane_test(ctx: Context, level: Level) -> Command:
    """The flows of one level; their runs are kept out of the action's folder,
    which the other steps read."""
    runs = ["--runs-dir", str(ctx.work / "runs")]
    return Command(
        [str(ctx.cronplane), "test", str(ctx.action), "--level", level.value, *runs], ctx.action
    )


def marked_tests(action: Path) -> str | None:
    """The first Python file of the action, from its folder, that marks a test
    `integration`; none of an environment or a hidden folder."""
    for path in sorted(action.rglob("*.py")):
        inside = path.relative_to(action)
        if any(part.startswith(".") or part == "node_modules" for part in inside.parts):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if "mark.integration" in text:
            return str(inside)
    return None


def e2e(ctx: Context) -> list[Command]:
    """`cronplane test` on the flows that need doubles only. An action has
    one test flow at least."""
    if not ctx.plan.flows:
        raise StepError(
            "an action has one test flow at least: tests/flows/<name>.yaml with a test: block"
        )
    return [_cronplane_test(ctx, Level.E2E)] if ctx.plan.of(Level.E2E) else []


def integration(ctx: Context) -> list[Command]:
    """With the services of `tests/compose.yaml` the integration flows name:
    the tests of the language marked `integration`, with the test values of
    those flows in the environment, then the flows. What these tests cover
    is added to what the unit step covered, and the action's coverage
    threshold applies to the sum. Without the unit step before it in the same
    check, every test runs here. The services are stopped whatever fails. A
    service that does not start fails the step: a test is never skipped."""
    if not ctx.plan.of(Level.INTEGRATION):
        return []
    values = ctx.plan.variables()
    compose = ["docker", "compose", "-f", str(ctx.action / "tests" / "compose.yaml")]
    commands: list[Command] = []
    if ctx.services is Services.START:
        commands.append(Command([*compose, "up", "-d", "--wait", *ctx.plan.services], ctx.action))
    for version in ctx.versions:
        commands.append(_sync(ctx, version))
        if coverage_data(ctx, version).is_file():
            # An action may have integration flows and no marked test: the sum is still measured.
            marked = ("-m", "integration", "--cov-append")
            commands.append(
                _pytest(ctx, version, *marked, env=values, passes=(0, NO_TEST_COLLECTED))
            )
        else:
            commands.append(_pytest(ctx, version, env=values))
    commands.append(_cronplane_test(ctx, Level.INTEGRATION))
    if ctx.services is Services.START:
        commands.append(Command([*compose, "down", "-v"], ctx.action, when=When.ALWAYS))
    return commands


def regression(ctx: Context) -> list[Command]:
    """Against the version before: `cronplane action compare` lists what the
    contract changes and refuses a number too low for it, then the test
    flows of the version before run against the action, with the services
    of its own `tests/compose.yaml`."""
    previous = ctx.previous
    if previous is None:
        return []
    binary, action, before = str(ctx.cronplane), str(ctx.action), str(previous.folder)
    numbers = previous.numbers()
    commands = [
        Command([binary, "action", "compare", action, "--previous", before, *numbers], ctx.action)
    ]
    if not previous.plan.flows:
        return commands
    compose = ["docker", "compose", "-f", str(previous.folder / "tests" / "compose.yaml")]
    started = ctx.services is Services.START and bool(previous.plan.services)
    if started:
        commands.append(
            Command([*compose, "up", "-d", "--wait", *previous.plan.services], ctx.action)
        )
    runs = ["--runs-dir", str(ctx.work / "runs")]
    commands.append(
        Command([binary, "test", action, "--previous", before, *numbers, *runs], ctx.action)
    )
    if started:
        commands.append(Command([*compose, "down", "-v"], ctx.action, when=When.ALWAYS))
    return commands


STEPS = {
    Step.VALIDATE: validate,
    Step.LOCKFILE: lockfile,
    Step.FORMAT: format_,
    Step.LINT: lint,
    Step.TYPES: types,
    Step.CRONPLANE: cronplane,
    Step.UNIT: unit,
    Step.AUDIT: audit,
    Step.LICENCES: licences,
    Step.E2E: e2e,
    Step.INTEGRATION: integration,
    Step.REGRESSION: regression,
}


def coverage_floor(action: Path) -> float:
    """The action's coverage threshold: required, it never goes down."""
    try:
        project = tomllib.loads((action / "pyproject.toml").read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise StepError(f"pyproject.toml: {e}") from e
    report = _table(_table(_table(project).get("tool")).get("coverage")).get("report")
    floor = _table(report).get("fail_under")
    if not isinstance(floor, int | float) or isinstance(floor, bool) or floor <= 0:
        raise StepError(
            "pyproject.toml: [tool.coverage.report] fail_under is required "
            "(the coverage measured, which never goes down)"
        )
    return float(floor)


def _table(value: object) -> dict[str, object]:
    """`value` when it is a TOML table, else an empty one."""
    # tomllib builds tables with string keys only.
    return cast("dict[str, object]", value) if isinstance(value, dict) else {}


def _sync(ctx: Context, version: str) -> Command:
    return Command(
        ["uv", "sync", "--frozen", "--python", version],
        ctx.action,
        {"UV_PROJECT_ENVIRONMENT": str(environment(ctx, version))},
    )


def _newest(ctx: Context) -> str:
    if not ctx.versions:
        raise StepError("the report gives no Python version to test")
    try:
        return max(ctx.versions, key=lambda v: tuple(int(part) for part in v.split(".")))
    except ValueError as e:
        raise StepError(f"a version of the report is not a number: {e}") from e
