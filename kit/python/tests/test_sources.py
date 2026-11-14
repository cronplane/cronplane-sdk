"""Packages of an action: none from a git repository."""

from pathlib import Path

import pytest

from cronplane_kit.cli import KIT
from cronplane_kit.errors import StepError
from cronplane_kit.sources import check_sources
from cronplane_kit.steps import STEPS, Context, Step

REGISTRY = '{ registry = "https://pypi.org/simple" }'


def lock(action: Path, *packages: tuple[str, str]) -> None:
    entries = "".join(
        f'[[package]]\nname = "{name}"\nversion = "1.0"\nsource = {source}\n\n'
        for name, source in packages
    )
    (action / "uv.lock").write_text("version = 1\n\n" + entries)


def git(url: str) -> str:
    return f'{{ git = "{url}" }}'


def test_packages_from_pypi_pass(action: Path) -> None:
    lock(action, ("cronplane-actions", REGISTRY), ("requests", REGISTRY))
    check_sources(action)


@pytest.mark.parametrize(
    ("name", "url"),
    [
        ("requests", "https://github.com/psf/requests.git"),
        ("cronplane-actions", "ssh://git@github.com/cronplane/cronplane-sdk.git?rev=abc#abc"),
    ],
    ids=["another package", "a library of Cronplane"],
)
def test_a_git_dependency_fails(action: Path, name: str, url: str) -> None:
    lock(action, ("x", REGISTRY), (name, git(url)))
    with pytest.raises(StepError, match=f"{name} comes from a git repository"):
        check_sources(action)


def test_a_git_dependency_fails_the_audit(action: Path, tmp_path: Path) -> None:
    lock(action, ("requests", git("https://github.com/psf/requests.git")))
    with pytest.raises(StepError, match="requests comes from a git repository"):
        STEPS[Step.AUDIT](Context(action, Path("/bin/cronplane"), KIT, tmp_path))


def test_an_unreadable_lock_says_so(action: Path) -> None:
    (action / "uv.lock").write_text("[[package")
    with pytest.raises(StepError, match=r"uv\.lock"):
        check_sources(action)
