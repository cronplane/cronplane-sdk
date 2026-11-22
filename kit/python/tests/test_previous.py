"""The version before of an action, found from the git tags of its repository."""

import shutil
import subprocess
from pathlib import Path

import pytest

from cronplane_kit.cli import KIT

PREVIOUS = KIT / "previous.sh"
GIT = shutil.which("git") or "/usr/bin/git"


def git(repository: Path, *args: str) -> None:
    identity = ["-c", "user.name=Author", "-c", "user.email=author@example.com"]
    subprocess.run([GIT, "-C", str(repository), *identity, *args], check=True, capture_output=True)


def release(repository: Path, content: str, *tags: str) -> None:
    """A commit whose `action.yaml` holds `content`, with these tags."""
    (repository / "action.yaml").write_text(content)
    git(repository, "add", "action.yaml")
    git(repository, "commit", "-q", "-m", content)
    for tag in tags:
        git(repository, "tag", tag)


@pytest.fixture
def repository(tmp_path: Path) -> Path:
    folder = tmp_path / "action"
    folder.mkdir()
    git(folder, "init", "-q", "--template=")
    return folder


def previous(repository: Path, dest: Path) -> list[str]:
    done = subprocess.run(
        [str(PREVIOUS), str(repository), str(dest)], capture_output=True, text=True, check=True
    )
    return done.stdout.splitlines()


def test_without_a_version_tag_there_is_no_version_before(repository: Path, tmp_path: Path) -> None:
    release(repository, "first", "nightly", "v1", "version-1.0.0")
    assert previous(repository, tmp_path / "before") == []
    assert not (tmp_path / "before").exists()


def test_a_commit_without_a_tag_is_checked_against_the_highest_version(
    repository: Path, tmp_path: Path
) -> None:
    release(repository, "1.9.0", "v1.9.0")
    release(repository, "1.10.0", "v1.10.0")
    release(repository, "next")
    before = tmp_path / "before"
    assert previous(repository, before) == ["--previous", str(before), "--from", "1.10.0"]
    assert (before / "action.yaml").read_text() == "1.10.0"


def test_a_tagged_commit_is_checked_against_the_version_under_its_own(
    repository: Path, tmp_path: Path
) -> None:
    release(repository, "1.4.2", "v1.4.2")
    release(repository, "2.0.0", "v2.0.0")
    before = tmp_path / "before"
    assert previous(repository, before) == [
        "--previous",
        str(before),
        "--from",
        "1.4.2",
        "--to",
        "2.0.0",
    ]
    assert (before / "action.yaml").read_text() == "1.4.2"


def test_the_first_version_has_no_version_before(repository: Path, tmp_path: Path) -> None:
    release(repository, "1.0.0", "v1.0.0")
    assert previous(repository, tmp_path / "before") == []


def test_a_version_of_another_branch_is_not_the_version_before(
    repository: Path, tmp_path: Path
) -> None:
    release(repository, "1.0.0", "v1.0.0")
    git(repository, "checkout", "-q", "-b", "other")
    release(repository, "9.0.0", "v9.0.0")
    git(repository, "checkout", "-q", "-")
    release(repository, "next")
    before = tmp_path / "before"
    assert previous(repository, before) == ["--previous", str(before), "--from", "1.0.0"]
