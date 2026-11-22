# The kit

Checks a Cronplane action as the hub will, on the author's machine and in CI. The rules that do not depend on the language are in `cronplane action validate --hub --json`, declared once in Cronplane. The kit keeps what depends on the language: one adapter per language, written in that language.

## Checking a Python action

```sh
export CRONPLANE_BIN=/path/to/cronplane     # the cronplane that checks actions
uv run --project python cronplane-kit check path/to/action
uv run --project python cronplane-kit check path/to/action --version 3.13   # one entry of the matrix (a CI job)
uv run --project python cronplane-kit check path/to/action --step lint      # some steps only
uv run --project python cronplane-kit check path/to/action --services running   # the services listen already
uv run --project python cronplane-kit check path/to/action --previous path/to/v1 --from 1.4.2   # against the version before
```

The steps run in order. The first failure stops them and shows its output.

| Step | What it checks |
|---|---|
| `validate` | `cronplane action validate --hub --json`: the rules of the hub. Gives the Python versions to test (the matrix). |
| `lockfile` | Each dependency of `pyproject.toml` has an upper bound (`sqlalchemy>=2.1,<3`), so that a new lock never takes a new major unasked; `uv.lock` matches `pyproject.toml` (`uv lock --check`). |
| `format`, `lint` | ruff with the kit's rules (`python/src/cronplane_kit/rules/ruff.toml`, security rules `S` included), whatever the action configures. |
| `types` | pyright, strict, with the action's dependencies, on the newest version of the matrix. |
| `cronplane` | `requires.cronplane` of `action.yaml` names a Cronplane as new as the one the library installed needs (`REQUIRES_CRONPLANE`). `validate` already requires every hub action to name one. |
| `unit` | pytest on each version of the matrix, with the test tools the kit pins: the tests that need no service (`-m "not integration"`). `[tool.coverage.report] fail_under` is required: the coverage measured, which never goes down. It applies here, unless the action has an integration level: it then applies there, to what both steps covered. |
| `audit` | pip-audit on the locked dependencies: a known advisory on what the action installs at run time fails. The advisories of its development tools are said (`! audit: …`), they do not fail the check. |
| `licences` | The SBOM (Syft, SPDX) of what the action installs at run time, checked by grant against `licences/grant.yaml`. |
| `e2e` | `cronplane test --level e2e`: the test flows that need doubles only. An action has one test flow at least (`tests/flows/<name>.yaml` with a `test:` block). |
| `integration` | With the services the integration flows name: `docker compose -f tests/compose.yaml up -d --wait <services>`, then the tests of the language marked `integration` (what they cover is added to what `unit` covered, and the action's coverage threshold applies to the sum; without `unit` before it in the same check, every test runs here), then `cronplane test --level integration`, then `docker compose … down -v`, whatever failed. A service that does not start fails the step: a test is never skipped. |
| `regression` | With `--previous <folder of the version before>`: `cronplane action compare` lists what the contract changes and the lowest version number that may carry it, then `cronplane test --previous` runs the test flows of the version before against the action, with the services of the `tests/compose.yaml` of that version. A flow that `tests/retired.yaml` of the action sets apart does not run. `--from` is the number of the version before, `--to` the number of the version checked: a number too low for the changes of contract is refused. Without `--previous`, the step says `not provided`. `previous.sh <repository> <folder>` finds the version before from the git tags `vX.Y.Z` of the repository (the highest under the commit checked out, or under its own tag), checks it out in the folder and prints these arguments; the workflows of this repository call it. |

The levels say what they ran: `✓ e2e: 2 flows`, `✓ integration: 1 flow, services: postgres`, or `not provided` for a level the action has no flow of.

After the steps, the kit says the sheet of the action (`cronplane action sheet`): one line per check, in the sections the hub shows (tests, compatibility, analysis, network and secrets, examples), each `✓`, `✗`, not provided, not applicable or not run. It is said when every step was asked, and `--sheet <file>` keeps it as JSON (and says it for a part of the steps too). The kit gives it how each step ended and the coverage the tests of the newest version measured.

A test of the language that needs a service has the mark `integration` (`@pytest.mark.integration`, declared in `pyproject.toml`). Such a test without an integration flow is an error: nothing would start its service, and it would never run. It reads the test values of the integration flows in its environment, each secret in uppercase: `test.secrets.postgres_url` of a flow is `POSTGRES_URL`. Two flows that give two values to one name are an error. A value that holds the address of a double (`${doubles.<name>.url}`) is not given: it is not known before its flow runs.

`--services running` leaves the services alone: they listen already, the kit starts and stops nothing. For a machine without Docker; never on the hub.

## Checking a TypeScript action

```sh
export CRONPLANE_BIN=/path/to/cronplane
bun ts/src/cli.ts check path/to/action                  # every Bun version of the matrix (through mise)
bun ts/src/cli.ts check path/to/action --version 1.4    # one entry of the matrix (a CI job)
```

The same steps, for Bun: `lockfile` (each dependency of `package.json` with an upper bound: `^1.2.0`, `~1.2.0`, `>=0.1.1 <1.0.0`; then `bun install --frozen-lockfile`), `types` (tsc, strict, the kit's configuration over the action's files), `cronplane` (the same check of `requires.cronplane`, asked to the library the `lockfile` step installed), `lint` (ESLint `strictTypeChecked` and security rules, `ts/rules/eslint.config.js`), `unit` (`bun test --coverage` on each Bun version, through `mise exec bun@X`; `[test] coverageThreshold` in `bunfig.toml` is required), `audit` (`bun audit --production` fails on a known advisory; `bun audit` then says those of the development tools, without failing), `licences` (on a `--production` install of the lockfile), `e2e`, `integration` (the services, then the integration flows, then the stop of the services), `regression` (the same as for Python).

A test of the language that needs a service is in a file named `*.integration.test.ts`. Bun has no mark for it and does not add a coverage to another, so the two steps share the work this way: `unit` runs the other test files, without coverage; `integration` runs every test with coverage, under the threshold, with the test values of the integration flows in the environment. The tests that need no service run twice. An action without such a file keeps its threshold on `unit`. There is no `format` step: no formatter is decided for TypeScript.

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

`templates/python` and `templates/typescript`: an action complete and minimal (inputs, output, tests, a test flow, README, lockfile, coverage threshold), using the library of its language. Copy one, rename the action, keep the checks; both pass every step.

## Services

`fixtures/compose.yaml` is a model of the services an integration level uses (`postgres`, `mysql`, `mariadb`, `s3`, `mailpit`, `sftp`, `gitlab`): images with a tag and a digest, ports on 127.0.0.1, test credentials only. Copy the ones an action needs into its `tests/compose.yaml`, name them in `test.services` of its integration flows, and write their addresses in `test.secrets` (the model lists them). `cronplane test --plan` checks the file against what Cronplane allows there.

S3 is SeaweedFS: MinIO publishes no community image any more.

## In CI

`.github/workflows/action-python.yml` and `action-typescript.yml` are reusable workflows: one job reads the matrix (`validate --json`), then one job per version runs the adapter with `--version` and keeps the SBOM as an artifact. The caller pins the kit by commit and gives the image of `cronplane` by digest; no secret is used. Until Cronplane publishes that image, the checks run where a `cronplane` binary is at hand (`CRONPLANE_BIN`).

## Tools

`mise install` gives the versions the kit uses: uv, Bun, Syft, grant. The Python adapter pins ruff, pyright and pip-audit in its own lockfile, and the test tools (`steps.py`).

The kit audits all its own packages, development tools included: they are what it runs on the code of the actions. The check of `ts/` ignores one advisory, GHSA-fc5q-39xc-vjpf (picomatch 4.0.7, a slow match on a crafted pattern, no fixed version on 2026-11-18): picomatch comes with typescript-eslint, and the only pattern it gets there is the path of the kit's own `tsconfig.json`. Review it on 2026-12-18, and remove `--ignore` as soon as a fixed version exists.

Licence: Apache-2.0.
