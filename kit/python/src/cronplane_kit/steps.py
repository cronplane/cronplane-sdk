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
from .sources import check_sources

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
    TESTS = "tests"
    AUDIT = "audit"
    LICENCES = "licences"
    FLOWS = "flows"


class OnFailure(StrEnum):
    """What the failure of a command does."""

    #: It stops the checks.
    STOP = "stop"
    #: It is only said.
    REPORT = "report"


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

    def __str__(self) -> str:
        return " ".join(self.argv)


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


def tests(ctx: Context) -> list[Command]:
    """pytest with coverage, once per version; the action's threshold
    (`fail_under`) applies."""
    coverage_floor(ctx.action)
    commands: list[Command] = []
    for version in ctx.versions:
        commands.append(_sync(ctx, version))
        commands.append(
            Command(
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
                ],
                ctx.action,
                {"UV_PROJECT_ENVIRONMENT": str(environment(ctx, version))},
            )
        )
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


def flows(ctx: Context) -> list[Command]:
    """`cronplane run` on each flow of `tests/flows`, with its secrets file when there is one."""
    directory = ctx.action / "tests" / "flows"
    secrets = directory / "secrets.env"
    extra = ["--secret-file", str(secrets)] if secrets.is_file() else []
    return [
        Command([str(ctx.cronplane), "run", str(flow), *extra], ctx.action)
        for flow in sorted(directory.glob("*.yaml"))
    ]


STEPS = {
    Step.VALIDATE: validate,
    Step.LOCKFILE: lockfile,
    Step.FORMAT: format_,
    Step.LINT: lint,
    Step.TYPES: types,
    Step.CRONPLANE: cronplane,
    Step.TESTS: tests,
    Step.AUDIT: audit,
    Step.LICENCES: licences,
    Step.FLOWS: flows,
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
