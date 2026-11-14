# The kit

Checks a Cronplane action as the hub will, on the author's machine and in CI. The rules that do not depend on the language are in `cronplane action validate --hub --json`, declared once in Cronplane. The kit keeps what depends on the language: one adapter per language, written in that language.

## Checking a Python action

```sh
export CRONPLANE_BIN=/path/to/cronplane     # the cronplane that checks actions
uv run --project python cronplane-kit check path/to/action
uv run --project python cronplane-kit check path/to/action --version 3.13   # one entry of the matrix (a CI job)
uv run --project python cronplane-kit check path/to/action --step lint      # some steps only
```

The steps run in order. The first failure stops them and shows its output.

| Step | What it checks |
|---|---|
| `validate` | `cronplane action validate --hub --json`: the rules of the hub. Gives the Python versions to test (the matrix). |
| `lockfile` | `uv.lock` matches `pyproject.toml` (`uv lock --check`). |
| `format`, `lint` | ruff with the kit's rules (`python/src/cronplane_kit/rules/ruff.toml`, security rules `S` included), whatever the action configures. |
| `types` | pyright, strict, with the action's dependencies, on the newest version of the matrix. |
| `cronplane` | `requires.cronplane` of `action.yaml` names a Cronplane as new as the one the library installed needs (`REQUIRES_CRONPLANE`). `validate` already requires every hub action to name one. |
| `tests` | pytest with coverage on each version of the matrix, with the test tools the kit pins. `[tool.coverage.report] fail_under` is required: the coverage measured, which never goes down. |
| `audit` | pip-audit on the locked dependencies: a known advisory on what the action installs at run time fails. The advisories of its development tools are said (`! audit: …`), they do not fail the check. |
| `licences` | The SBOM (Syft, SPDX) of what the action installs at run time, checked by grant against `licences/grant.yaml`. |
| `flows` | `cronplane run` on each `tests/flows/*.yaml`, with `tests/flows/secrets.env` when there is one. |

## Checking a TypeScript action

```sh
export CRONPLANE_BIN=/path/to/cronplane
bun ts/src/cli.ts check path/to/action                  # every Bun version of the matrix (through mise)
bun ts/src/cli.ts check path/to/action --version 1.4    # one entry of the matrix (a CI job)
```

The same steps, for Bun: `lockfile` (`bun install --frozen-lockfile`), `types` (tsc, strict, the kit's configuration over the action's files), `cronplane` (the same check of `requires.cronplane`, asked to the library the `lockfile` step installed), `lint` (ESLint `strictTypeChecked` and security rules, `ts/rules/eslint.config.js`), `tests` (`bun test --coverage` on each Bun version, through `mise exec bun@X`; `[test] coverageThreshold` in `bunfig.toml` is required), `audit` (`bun audit --production` fails on a known advisory; `bun audit` then says those of the development tools, without failing), `licences` (on a `--production` install of the lockfile), `flows`. There is no `format` step: no formatter is decided for TypeScript.

## Licences

`licences/grant.yaml` is the policy (decided on 2026-11-14):

- allowed: permissive licences (MIT, BSD, Apache-2.0, ISC, PSF, Zlib, 0BSD, Unlicense, CC0) and weak copyleft (LGPL, MPL-2.0) for packages used unmodified, whose sources stay public;
- refused: GPL, AGPL, SSPL, and any licence unknown or missing.

An exception is a line of the action's `licence-exceptions.txt`, reviewed with the action:

```text
some-package  # why it is accepted, who reviewed it, when
```

The SBOM is kept: it is published with the version of the action.

## Packages from git

None: every package of an action comes from PyPI or npm, the libraries of Cronplane too (`cronplane-actions`, `@cronplane/actions`). The audit fails on a package taken from a git repository; in TypeScript it also fails on a package taken from a file or a URL.

## Templates

`templates/python` and `templates/typescript`: an action complete and minimal (inputs, output, tests, README, lockfile, coverage threshold), using the library of its language. Copy one, rename the action, keep the checks; both pass every step.

## Fixtures

`fixtures/compose.yaml`: the services an action's tests and flows talk to, one profile each (`postgres`, `mysql`, `mariadb`, `s3`, `mail`, `sftp`, `gitlab`), images pinned by digest, ports on 127.0.0.1, test credentials only. `fixtures/secrets.env` gives their addresses to `cronplane run --secret-file`.

```sh
docker compose -f fixtures/compose.yaml --profile postgres --profile s3 up -d --wait
```

S3 is SeaweedFS: MinIO publishes no community image any more.

## In CI

`.github/workflows/action-python.yml` and `action-typescript.yml` are reusable workflows: one job reads the matrix (`validate --json`), then one job per version runs the adapter with `--version` and keeps the SBOM as an artifact. The caller pins the kit by commit and gives the image of `cronplane` by digest; no secret is used. Until Cronplane publishes that image, the checks run where a `cronplane` binary is at hand (`CRONPLANE_BIN`).

## Tools

`mise install` gives the versions the kit uses: uv, Bun, Syft, grant. The Python adapter pins ruff, pyright and pip-audit in its own lockfile, and the test tools (`steps.py`).

The kit audits all its own packages, development tools included: they are what it runs on the code of the actions. The check of `ts/` ignores one advisory, GHSA-fc5q-39xc-vjpf (picomatch 4.0.7, a slow match on a crafted pattern, no fixed version on 2026-11-18): picomatch comes with typescript-eslint, and the only pattern it gets there is the path of the kit's own `tsconfig.json`. Review it on 2026-12-18, and remove `--ignore` as soon as a fixed version exists.

Licence: Apache-2.0.
