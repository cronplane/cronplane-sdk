"""Runs the commands of the steps and says what failed."""

from __future__ import annotations

import subprocess
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from .steps import Command

#: Longest a command may run (a test matrix included).
TIMEOUT_SECONDS = 30 * 60


@dataclass(frozen=True)
class Outcome:
    command: Command
    code: int
    #: What the command printed (stdout and stderr), kept to show a failure.
    output: str

    @property
    def ok(self) -> bool:
        return self.code == 0


Runner = Callable[[Command], Outcome]


def runner(environ: Mapping[str, str]) -> Runner:
    """Runs a command with `environ` and the command's own variables. The
    kit's own environment (`VIRTUAL_ENV`) is not the action's."""
    base = {name: value for name, value in environ.items() if name != "VIRTUAL_ENV"}

    def run(command: Command) -> Outcome:
        for path, text in command.writes:
            path.write_text(text, encoding="utf-8")
        try:
            done = subprocess.run(  # noqa: S603 # a list of arguments the kit built, no shell
                list(command.argv),
                cwd=command.cwd,
                env={**base, **command.env},
                capture_output=True,
                text=True,
                timeout=TIMEOUT_SECONDS,
                check=False,
            )
        except FileNotFoundError as e:
            return Outcome(command, 127, f"{command.argv[0]}: not found ({e})")
        except subprocess.TimeoutExpired:
            return Outcome(command, 124, f"no end within {TIMEOUT_SECONDS} s")
        return Outcome(command, done.returncode, done.stdout + done.stderr)

    return run
