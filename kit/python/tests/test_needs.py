"""`requires.cronplane` of an action against the Cronplane its library needs."""

import sys
from types import ModuleType

import pytest

from cronplane_kit.needs import LIBRARY, main, needed, problem


@pytest.fixture
def library(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    """A library installed that needs Cronplane 0.3."""
    module = ModuleType(LIBRARY)
    setattr(module, "REQUIRES_CRONPLANE", "0.3")  # noqa: B010 # ModuleType declares no such attribute
    monkeypatch.setitem(sys.modules, LIBRARY, module)
    return module


@pytest.fixture
def no_library(monkeypatch: pytest.MonkeyPatch) -> None:
    # None in sys.modules: the import fails.
    monkeypatch.setitem(sys.modules, LIBRARY, None)


@pytest.mark.parametrize("declared", ["0.3", "0.4", "0.10", "1.0", "0.3.2"])
def test_a_cronplane_as_new_as_the_library_needs_passes(declared: str) -> None:
    assert problem(declared, "0.3") is None


@pytest.mark.parametrize("declared", ["0.2", "0.1.9", "0"])
def test_an_older_cronplane_fails(declared: str) -> None:
    assert problem(declared, "0.3") == (
        f"action.yaml: requires.cronplane says >={declared}: the library cronplane-actions "
        'needs Cronplane 0.3 or newer (write `requires: {cronplane: ">=0.3"}`)'
    )


def test_an_action_with_the_library_must_name_a_cronplane() -> None:
    assert problem("", "0.3") == (
        "action.yaml: requires.cronplane is missing: the library cronplane-actions needs "
        'Cronplane 0.3 or newer (write `requires: {cronplane: ">=0.3"}`)'
    )


def test_what_is_not_a_version_says_so() -> None:
    assert problem("x.y", "0.3") == "action.yaml: requires.cronplane: 'x.y' is not a version"


@pytest.mark.usefixtures("no_library")
def test_an_action_without_the_library_names_what_it_wants() -> None:
    assert needed() is None
    assert problem("", needed()) is None
    assert main(["needs.py"]) == 0


def test_the_library_installed_says_what_it_needs(library: ModuleType) -> None:
    assert needed() == "0.3"
    delattr(library, "REQUIRES_CRONPLANE")
    assert needed() is None


@pytest.mark.usefixtures("library")
def test_the_program_fails_with_the_problem(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["needs.py", "0.3"]) == 0
    assert main(["needs.py", "0.2"]) == 1
    assert "requires.cronplane says >=0.2" in capsys.readouterr().err
    assert main(["needs.py"]) == 1
