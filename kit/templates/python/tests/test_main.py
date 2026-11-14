"""The action, run as Cronplane runs it: its files and variables in a folder."""

import json
from pathlib import Path

import pytest

from main import greeting, main


def test_greeting() -> None:
    assert greeting("Ada", shout=False) == "hello Ada"
    assert greeting("Ada", shout=True) == "HELLO ADA"


def test_main_writes_the_greeting(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "with.json").write_text(json.dumps({"who": "Ada", "shout": False}))
    for name, file in [("WITH", "with.json"), ("OUTPUT", "output.json"), ("MASK", "mask")]:
        monkeypatch.setenv(f"CRONPLANE_{name}", str(tmp_path / file))
    main()
    assert json.loads((tmp_path / "output.json").read_text()) == {"greeting": "hello Ada"}
