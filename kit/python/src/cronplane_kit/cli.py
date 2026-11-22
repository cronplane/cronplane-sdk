"""`cronplane-kit check <action> [--version X] [--step S]`: the checks of a
Python action, in order; the first failure stops them."""

from __future__ import annotations

import argparse
import contextlib
import os
import sys
import tempfile
from collections.abc import Callable, Generator, Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path

from .plan import NO_PLAN, Level, Plan, PlanError
from .report import Report, ReportError
from .run import Outcome, Runner, runner
from .steps import (
    STEPS,
    Command,
    Context,
    Ended,
    OnFailure,
    Previous,
    Services,
    Step,
    StepError,
    When,
)
from .steps import results as steps_results
from .steps import sheet as steps_sheet

#: The kit's folder: `python/src/cronplane_kit/cli.py` is in it.
KIT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Config:
    """Read once, when the command starts."""

    cronplane: Path

    @classmethod
    def from_environment(cls, environ: Mapping[str, str]) -> Config:
        binary = environ.get("CRONPLANE_BIN")
        if not binary:
            raise SystemExit("CRONPLANE_BIN: the path of the cronplane binary that checks actions")
        return cls(Path(binary))


def check(
    ctx: Context,
    run: Runner,
    *,
    steps: Sequence[Step],
    version: str | None = None,
    say: Callable[[str], None] = print,
) -> bool:
    """Runs `steps` on the action of `ctx`; True when every one passed. The
    sheet of the action is said after every step was asked, or when its JSON
    is kept."""
    action = ctx.action
    report = _validate(ctx, run, say)
    if report is None:
        return False
    if report.runtime != "python":
        say(f"{action}: a {report.runtime} action: use the adapter of its language")
        return False
    if version is not None and version not in report.versions:
        say(f"--version {version}: not in the action's matrix ({', '.join(report.versions)})")
        return False
    versions = report.versions if version is None else (version,)
    plan = _plan(ctx, run, say) if _LEVELS.intersection(steps) else NO_PLAN
    if plan is None:
        return False
    previous = ctx.previous
    if previous is not None and Step.REGRESSION in steps:
        before = _plan(ctx, run, say, previous)
        if before is None:
            return False
        previous = replace(previous, plan=before)
    ctx = replace(
        ctx,
        versions=versions,
        requires_cronplane=report.requires_cronplane,
        plan=plan,
        previous=previous,
    )
    ended = _steps(ctx, run, steps, say)
    if ctx.results is not None:
        ctx.results.write_text(steps_results(ctx, ended), encoding="utf-8")
    if ctx.sheet is not None or set(steps) == set(Step):
        outcome = run(steps_sheet(ctx, ended))
        say(outcome.output.rstrip("\n"))
    return Ended.FAILED not in ended.values()


def _steps(
    ctx: Context, run: Runner, steps: Sequence[Step], say: Callable[[str], None]
) -> dict[Step, Ended]:
    """Runs `steps` in order, up to the first that fails or cannot be built;
    how each one ended."""
    ended = {Step.VALIDATE: Ended.PASSED}
    for step in steps:
        if step is Step.VALIDATE:
            continue
        try:
            commands = STEPS[step](ctx)
        except StepError as e:
            say(f"✗ {step}: {e}")
            ended[step] = Ended.FAILED
            break
        if not _run_step(step, commands, run, say):
            ended[step] = Ended.FAILED
            break
        ended[step] = Ended.PASSED
        say(f"✓ {step}{_count(step, ctx)}")
    return ended


def _count(step: Step, ctx: Context) -> str:
    """What a level ran, after its name: its flows, and its services."""
    if step is Step.REGRESSION:
        if ctx.previous is None:
            return ": not provided"
        flows = len(ctx.previous.plan.flows)
        return f": {flows} flow{'s' if flows != 1 else ''} of the version before"
    plan = ctx.plan
    level = {Step.E2E: Level.E2E, Step.INTEGRATION: Level.INTEGRATION}.get(step)
    if level is None:
        return ""
    flows = len(plan.of(level))
    if flows == 0:
        return ": not provided"
    services = f", services: {', '.join(plan.services)}" if level is Level.INTEGRATION else ""
    return f": {flows} flow{'s' if flows > 1 else ''}{services}"


def _run_step(
    step: Step, commands: Sequence[Command], run: Runner, say: Callable[[str], None]
) -> bool:
    """Runs the commands of a step up to the first that fails it; those that
    always run (what stops the services) run after it too."""
    failed = False
    for command in commands:
        if failed and command.when is not When.ALWAYS:
            continue
        outcome = run(command)
        if outcome.ok:
            continue
        if command.on_failure is OnFailure.REPORT:
            say(f"! {step}: {command} (it does not fail the check)\n{outcome.output}")
            continue
        say(f"✗ {step}: {command}\n{outcome.output}")
        failed = True
    return not failed


#: The steps that read the test flows of the action.
_LEVELS = frozenset({Step.UNIT, Step.E2E, Step.INTEGRATION})


def _plan(
    ctx: Context, run: Runner, say: Callable[[str], None], previous: Previous | None = None
) -> Plan | None:
    """The test flows of the action, or those of `previous` that run against it."""
    before = [] if previous is None else ["--previous", str(previous.folder), *previous.numbers()]
    command = Command(
        [str(ctx.cronplane), "test", str(ctx.action), "--plan", "--json", *before], ctx.action
    )
    outcome = run(command)
    if not outcome.ok:
        say(f"✗ test flows: {command}\n{outcome.output}")
        return None
    try:
        return Plan.parse(outcome.output)
    except PlanError as e:
        say(f"✗ test flows: the plan cannot be read: {e}\n{outcome.output}")
        return None


def _validate(ctx: Context, run: Runner, say: Callable[[str], None]) -> Report | None:
    outcome: Outcome = run(STEPS[Step.VALIDATE](ctx)[0])
    try:
        report = Report.parse(outcome.output)
    except ReportError as e:
        say(f"✗ validate: the report cannot be read: {e}\n{outcome.output}")
        return None
    if not report.ok:
        say("✗ validate:\n" + "\n".join(f"  {p}" for p in report.problems))
        return None
    say(f"✓ validate: {report.name}, Python {', '.join(report.versions)}")
    return report


@contextlib.contextmanager
def _work(kept: Path | None) -> Generator[str]:
    """The directory of the check's own: `kept`, made when it is not there, else
    one that ends with the check."""
    if kept is None:
        with tempfile.TemporaryDirectory(prefix="cronplane-kit-") as work:
            yield work
        return
    folder = kept.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    yield str(folder)


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="cronplane-kit", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    checking = commands.add_parser("check", help="check a Python action as the hub will")
    checking.add_argument("action", type=Path, help="the action's folder (action.yaml)")
    checking.add_argument("--version", help="one version of the matrix (a CI job), else all")
    checking.add_argument("--sbom", type=Path, help="keep the SBOM of the licences step there")
    checking.add_argument(
        "--step",
        action="append",
        choices=[s.value for s in Step],
        help="only these steps (repeatable)",
    )
    checking.add_argument(
        "--services",
        choices=[s.value for s in Services],
        default=Services.START.value,
        help="start: the kit starts the services of tests/compose.yaml and stops them; "
        "running: they listen already",
    )
    checking.add_argument(
        "--previous",
        type=Path,
        help="the folder of the version before: the regression step compares the contracts "
        "and runs its test flows against the action",
    )
    checking.add_argument(
        "--sheet", type=Path, help="keep the sheet of the action there (JSON), and say it"
    )
    checking.add_argument(
        "--results",
        type=Path,
        help="keep how each step ended there (JSON), for `cronplane action sheet --results`",
    )
    checking.add_argument(
        "--work",
        type=Path,
        help="keep the environments and what the tests covered there, from a check to the next",
    )
    checking.add_argument("--from", dest="number", help="the number of the version before (X.Y.Z)")
    checking.add_argument("--to", dest="next_number", help="the number of the version checked")
    args = parser.parse_args(argv)
    if args.previous is None and (args.number or args.next_number):
        parser.error("--from and --to are the numbers around --previous")
    config = Config.from_environment(os.environ)
    action = Path(args.action).resolve()
    steps = [Step(s) for s in args.step] if args.step else list(Step)
    with _work(args.work) as work:
        sbom = Path(args.sbom).resolve() if args.sbom else None
        ctx = Context(
            action=action,
            cronplane=config.cronplane,
            kit=KIT,
            work=Path(work),
            sbom=sbom,
            services=Services(args.services),
            sheet=Path(args.sheet).resolve() if args.sheet else None,
            results=Path(args.results).resolve() if args.results else None,
            previous=None
            if args.previous is None
            else Previous(Path(args.previous).resolve(), args.number, args.next_number),
        )
        ok = check(ctx, runner(os.environ), steps=steps, version=args.version)
    sys.exit(0 if ok else 1)
