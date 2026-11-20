"""Dependencies of an action: each with an upper bound."""

from pathlib import Path

import pytest

from cronplane_kit.bounds import check_bounds, unbounded
from cronplane_kit.cli import KIT
from cronplane_kit.errors import StepError
from cronplane_kit.steps import STEPS, Context, Step


def depends_on(action: Path, *dependencies: str) -> None:
    listed = ", ".join(f'"{d}"' for d in dependencies)
    (action / "pyproject.toml").write_text(
        f'[project]\nname = "demo"\nversion = "0.1.0"\ndependencies = [{listed}]\n'
    )


@pytest.mark.parametrize(
    "dependency",
    [
        "sqlalchemy>=2.1,<3",
        "psycopg[binary]>=3.3,<4",
        "ruamel.yaml<=0.19.9",
        "requests==2.32.5",
        "attrs==25.*",
        "click~=8.1",
        'tomli>=2,<3; python_version < "3.11"',
    ],
)
def test_a_bounded_dependency_passes(dependency: str) -> None:
    assert unbounded(dependency) is None


@pytest.mark.parametrize(
    ("dependency", "fixed"),
    [
        ("sqlalchemy>=2.1", "sqlalchemy>=2.1,<3"),
        ("cronplane-actions>=0.1", "cronplane-actions>=0.1,<0.2"),
        ("psycopg[binary]>3.3", "psycopg[binary]>3.3,<4"),
        ("httpx!=0.28.0,>=0.27", "httpx!=0.28.0,>=0.27,<0.28"),
        ("requests", "requests>=<version>,<<next major>>"),
    ],
)
def test_an_unbounded_dependency_says_what_to_write(dependency: str, fixed: str) -> None:
    assert unbounded(dependency) == fixed


def test_an_action_with_bounded_dependencies_passes(action: Path) -> None:
    depends_on(action, "cronplane-actions>=0.1,<1", "sqlalchemy>=2.1,<3")
    check_bounds(action)


def test_an_action_without_dependencies_passes(action: Path) -> None:
    (action / "pyproject.toml").write_text('[project]\nname = "demo"\n')
    check_bounds(action)


def test_each_unbounded_dependency_is_named(action: Path) -> None:
    depends_on(action, "cronplane-actions>=0.1,<1", "sqlalchemy>=2.1", "ruamel.yaml>=0.18")
    with pytest.raises(StepError) as raised:
        check_bounds(action)
    assert str(raised.value) == (
        "pyproject.toml: a dependency without an upper bound lets a new lock take a new major: "
        "sqlalchemy>=2.1 (write sqlalchemy>=2.1,<3); "
        "ruamel.yaml>=0.18 (write ruamel.yaml>=0.18,<0.19)"
    )


def test_the_lockfile_step_checks_the_bounds(action: Path, tmp_path: Path) -> None:
    depends_on(action, "sqlalchemy>=2.1")
    with pytest.raises(StepError, match=r"sqlalchemy>=2.1 \(write sqlalchemy>=2.1,<3\)"):
        STEPS[Step.LOCKFILE](Context(action, Path("/bin/cronplane"), KIT, tmp_path))


@pytest.mark.parametrize(
    ("content", "message"),
    [
        ("[project", r"pyproject\.toml"),
        ('[project]\ndependencies = "x"\n', "project.dependencies is a list"),
        ('[project]\ndependencies = ["not a requirement!"]\n', "'not a requirement!'"),
    ],
)
def test_a_bad_pyproject_says_so(action: Path, content: str, message: str) -> None:
    (action / "pyproject.toml").write_text(content)
    with pytest.raises(StepError, match=message):
        check_bounds(action)


def test_a_missing_pyproject_says_so(action: Path) -> None:
    (action / "pyproject.toml").unlink()
    with pytest.raises(StepError, match=r"pyproject\.toml"):
        check_bounds(action)
