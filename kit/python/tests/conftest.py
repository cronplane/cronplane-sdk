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


@pytest.fixture
def action(tmp_path: Path) -> Path:
    folder = tmp_path / "demo"
    folder.mkdir()
    (folder / "pyproject.toml").write_text(PYPROJECT)
    (folder / "uv.lock").write_text("version = 1\n")
    return folder


@pytest.fixture
def cronplane(tmp_path: Path) -> Path:
    """Prints the report in `report.json` beside it, as `validate --json` does."""
    binary = tmp_path / "cronplane"
    (tmp_path / "report.json").write_text(report())
    binary.write_text(f'#!/bin/sh\ncat "{tmp_path / "report.json"}"\n')
    binary.chmod(0o755)
    return binary
