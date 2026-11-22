"""A Python action as an author writes it, and a stand-in for `cronplane`."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

PYPROJECT = """\
[project]
name = "demo"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = []

[tool.coverage.report]
fail_under = 90
"""


def report(
    *,
    ok: bool = True,
    runtime: str = "python",
    versions: tuple[str, ...] = ("3.12",),
    requires_cronplane: str | None = None,
) -> str:
    """The JSON `cronplane action validate --hub --json` prints."""
    return json.dumps(
        {
            "version": 1,
            "action": {
                "name": "demo",
                "runtime": runtime,
                "requires_cronplane": requires_cronplane,
            },
            "matrix": [{"runtime": runtime, "version": v} for v in versions],
            "inputs": [],
            "ok": ok,
            "problems": []
            if ok
            else [{"rule": "readme", "at": "README.md", "message": "no README"}],
        }
    )


def plan(*flows: tuple[str, str, dict[str, str]], services: tuple[str, ...] = ()) -> str:
    """The JSON `cronplane test --plan --json` prints: a file, a level and the test
    values of each flow."""
    return json.dumps(
        {
            "version": 1,
            "services": list(services),
            "flows": [
                {"file": f"tests/flows/{file}", "name": file, "level": level, "secrets": secrets}
                for file, level, secrets in flows
            ],
        }
    )


@pytest.fixture
def action(tmp_path: Path) -> Path:
    folder = tmp_path / "demo"
    folder.mkdir()
    (folder / "pyproject.toml").write_text(PYPROJECT)
    (folder / "uv.lock").write_text("version = 1\n")
    return folder


@pytest.fixture
def cronplane(tmp_path: Path) -> Path:
    """Prints the report in `report.json` beside it, as `validate --json` does, and
    the plan in `plan.json` for `test … --plan`."""
    binary = tmp_path / "cronplane"
    (tmp_path / "report.json").write_text(report())
    (tmp_path / "plan.json").write_text(plan(("hello.yaml", "e2e", {})))
    binary.write_text(
        f'#!/bin/sh\n[ "$1" = test ] && [ "$3" = --plan ] && exec cat "{tmp_path / "plan.json"}"\n'
        f'cat "{tmp_path / "report.json"}"\n'
    )
    binary.chmod(0o755)
    return binary
