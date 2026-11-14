"""The licence policy, on the SBOM of installed packages (needs Syft and grant: `mise install`)."""

import subprocess
from pathlib import Path

import pytest

from cronplane_kit.cli import KIT

CHECK = KIT / "licences" / "check.sh"


def installed(tmp_path: Path, licences: dict[str, str]) -> Path:
    """An environment with one package per licence, as uv installs them."""
    env = tmp_path / "env"
    site = env / "lib" / "python3.12" / "site-packages"
    for name, licence in licences.items():
        info = site / f"{name}-1.0.dist-info"
        info.mkdir(parents=True)
        (info / "METADATA").write_text(
            f"Metadata-Version: 2.4\nName: {name}\nVersion: 1.0\nLicense-Expression: {licence}\n"
        )
        (info / "RECORD").write_text(f"{name}/__init__.py,,\n")
    return env


def check(env: Path, action: Path) -> subprocess.CompletedProcess[str]:
    sbom = action / "sbom.json"
    return subprocess.run(
        [str(CHECK), str(env), str(action), str(sbom)], capture_output=True, text=True, check=False
    )


@pytest.fixture
def action(tmp_path: Path) -> Path:
    folder = tmp_path / "action"
    folder.mkdir()
    return folder


def test_permissive_and_weak_copyleft_pass_and_the_sbom_is_kept(
    tmp_path: Path, action: Path
) -> None:
    env = installed(
        tmp_path,
        {
            "mit": "MIT",
            "lgpl": "LGPL-3.0-or-later",
            "mpl": "MPL-2.0",
            "either": "Apache-2.0 OR BSD-3-Clause",
        },
    )
    done = check(env, action)
    assert done.returncode == 0, done.stdout + done.stderr
    assert '"spdxVersion"' in (action / "sbom.json").read_text()


@pytest.mark.parametrize("licence", ["GPL-3.0-only", "AGPL-3.0-or-later", "SSPL-1.0"])
def test_strong_copyleft_is_refused_naming_the_package(
    tmp_path: Path, action: Path, licence: str
) -> None:
    done = check(installed(tmp_path, {"viral": licence}), action)
    assert done.returncode == 1
    assert "viral" in done.stdout


def test_an_exception_needs_a_reason_and_a_plain_name(tmp_path: Path, action: Path) -> None:
    env = installed(tmp_path, {"viral": "GPL-3.0-only"})
    exceptions = action / "licence-exceptions.txt"
    exceptions.write_text("viral\n")
    assert "has no reason" in check(env, action).stderr
    exceptions.write_text('x"; rm  # sneaky\n')
    assert "is not a package name" in check(env, action).stderr
    exceptions.write_text(
        "# reviewed exceptions\n\nviral  # build tool only, reviewed 2026-11-14\n"
    )
    assert check(env, action).returncode == 0
