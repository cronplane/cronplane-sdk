/**
 * The checks of a TypeScript action, in order, declared once: each step gives
 * the commands it runs. Building a command runs nothing (it may read the
 * action's files).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { StepError } from "./errors.ts";
import { checkBounds } from "./bounds.ts";
import { flowsOf, type Level, type Plan, variables } from "./plan.ts";
import { checkSources } from "./sources.ts";

/** The steps, in the order they run; the same as the Python adapter's. */
export const STEPS = ["validate", "lockfile", "types", "cronplane", "lint", "prepare", "unit", "audit", "licences", "e2e", "integration", "regression"] as const;
export type Step = (typeof STEPS)[number];

/** A program and its arguments (never a shell line), its directory, the variables added. */
export interface Command {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Files written before it runs (their directory made): path and text. */
  readonly writes?: readonly (readonly [string, string])[];
  /** What its failure does: it stops the checks (`stop`, the default), or it is only said (`report`). */
  readonly onFailure?: "stop" | "report";
  /**
   * When it runs in its step: after the commands before it, while none failed
   * (`in order`, the default), or whatever failed (`always`: what stops the services).
   */
  readonly when?: "in order" | "always";
}

/** Who starts the services of the integration level: the kit (and it stops them), or they listen already. */
export const SERVICES = ["start", "running"] as const;
export type Services = (typeof SERVICES)[number];

/** The version before of the action. */
export interface Previous {
  /** Its folder, with its `tests/`. */
  readonly folder: string;
  /** Its number (`X.Y.Z`), when it is known. */
  readonly number?: string;
  /** The number of the version checked, when it has one. */
  readonly nextNumber?: string;
  /** Its test flows that run against the version checked. */
  readonly plan: Plan;
}

/** What tells `cronplane` the version before and the numbers that are known. */
export function before(previous: Previous): readonly string[] {
  return [
    "--previous",
    previous.folder,
    ...(previous.number === undefined ? [] : ["--from", previous.number]),
    ...(previous.nextNumber === undefined ? [] : ["--to", previous.nextNumber]),
  ];
}

export function show(command: Command): string {
  return command.argv.join(" ");
}

/** What the commands of one action need. */
export interface Context {
  readonly action: string;
  readonly cronplane: string;
  readonly kit: string;
  /** A directory of the check's own, for configurations, the production install and the SBOM. */
  readonly work: string;
  /** The Bun versions to test (from the report). */
  readonly versions: readonly string[];
  /** Where the SBOM of the licences step goes (else the work directory). */
  readonly sbom?: string;
  /** The oldest Cronplane the action says it runs on (from the report). */
  readonly requiresCronplane?: string;
  /** Its test flows (from `cronplane test --plan`). */
  readonly plan: Plan;
  readonly services: Services;
  /** The version before, for the regression step; none: the step runs nothing. */
  readonly previous?: Previous;
  /** Where the sheet of the action is kept as JSON; none: it is not kept. */
  readonly sheet?: string;
  /** Where how the steps ended is kept as JSON, for who writes the sheet itself. */
  readonly results?: string;
}

/** How a step ended, as the sheet reads it: `not_run` when the checks stopped before it, or it was not asked. */
export type Ended = "passed" | "failed" | "not_run";

export { StepError } from "./errors.ts";

/** One of the kit's own tools, run by Bun: a machine of the checks has no Node.js. */
function tool(ctx: Context, name: string): readonly [string, string] {
  return ["bun", join(ctx.kit, "ts", "node_modules", ".bin", name)];
}

const COMPILER_OPTIONS = {
  target: "ES2023",
  module: "Preserve",
  moduleResolution: "bundler",
  lib: ["ES2023"],
  types: ["bun"],
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  noPropertyAccessFromIndexSignature: true,
  noFallthroughCasesInSwitch: true,
  verbatimModuleSyntax: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
};

/** The kit's TypeScript configuration over the action's files, whatever its own says. */
function tsconfig(ctx: Context): readonly [string, string] {
  const config = {
    compilerOptions: { ...COMPILER_OPTIONS, typeRoots: [join(ctx.kit, "ts", "node_modules", "@types")] },
    include: [join(ctx.action, "**", "*.ts")],
    // `.cronplane`: the runs `cronplane run` keeps there.
    exclude: [join(ctx.action, "node_modules"), join(ctx.action, ".cronplane")],
  };
  return [join(ctx.work, "tsconfig.json"), JSON.stringify(config)];
}

export type Build = (ctx: Context) => readonly Command[];

function bunTest(ctx: Context, version: string, args: readonly string[], env: Readonly<Record<string, string>> = {}): Command {
  return { argv: ["mise", "exec", `bun@${version}`, "--", "bun", "test", ...args], cwd: ctx.action, env };
}

/** Where the tests of one version say what they covered, for the sheet. */
function coverageReport(ctx: Context, version: string): string {
  return join(ctx.work, `coverage-${version}`);
}

/** What makes `bun test` measure the coverage, say it, and keep it for the sheet. */
function measured(ctx: Context, version: string): readonly string[] {
  return ["--coverage", "--coverage-reporter=text", "--coverage-reporter=lcov", `--coverage-dir=${coverageReport(ctx, version)}`];
}

/** The lines the tests of the newest version covered, in percent; none before they ran. */
export function measuredCoverage(ctx: Context): number | undefined {
  const newest = [...ctx.versions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  if (newest === undefined) {
    return undefined;
  }
  let report: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file of the check's own directory
    report = readFileSync(join(coverageReport(ctx, newest), "lcov.info"), "utf8");
  } catch {
    return undefined;
  }
  const sum = (key: string): number =>
    report
      .split("\n")
      .filter((line) => line.startsWith(`${key}:`))
      .reduce((total, line) => total + Number(line.slice(key.length + 1)), 0);
  const found = sum("LF");
  return found > 0 ? Math.round((sum("LH") / found) * 10000) / 100 : undefined;
}

/** How each step ended and what the tests covered, as `cronplane action sheet --results` reads it (JSON). */
export function results(ctx: Context, ended: ReadonlyMap<Step, Ended>): string {
  const floor = readFloor(ctx.action);
  const coverage = floor instanceof StepError ? null : { measured: measuredCoverage(ctx) ?? null, threshold: Math.round(floor * 10000) / 100 };
  return JSON.stringify({ version: 1, steps: Object.fromEntries(STEPS.map((step) => [step, ended.get(step) ?? "not_run"])), coverage });
}

/** `cronplane action sheet`: one line per check, from how each step ended. */
export function sheet(ctx: Context, ended: ReadonlyMap<Step, Ended>): Command {
  const file = join(ctx.work, "results.json");
  return {
    argv: [
      ctx.cronplane,
      "action",
      "sheet",
      ctx.action,
      "--results",
      file,
      ...(ctx.previous === undefined ? [] : before(ctx.previous)),
      ...(ctx.sheet === undefined ? [] : ["--output", ctx.sheet]),
    ],
    cwd: ctx.action,
    writes: [[file, results(ctx, ended)]],
    // A line that failed ends it in error: the steps already said so.
    onFailure: "report",
  };
}

/** What Bun takes as a test file. */
const TEST_FILE = /[._](test|spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;
/** How a test of the language that needs a service of the integration level ends. */
const INTEGRATION_FILE = ".integration.test.ts";

/**
 * The test files of an action, as paths Bun runs (`./a/b.test.ts`), sorted:
 * those that need a service (`*.integration.test.ts`) apart from the others.
 */
export function testFiles(action: string): { readonly unit: readonly string[]; readonly integration: readonly string[] } {
  const found: string[] = [];
  const visit = (directory: string): void => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a folder of the action checked
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        visit(join(directory, entry.name));
      } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
        found.push(`./${relative(action, join(directory, entry.name))}`);
      }
    }
  };
  visit(action);
  found.sort();
  return {
    unit: found.filter((file) => !file.endsWith(INTEGRATION_FILE)),
    integration: found.filter((file) => file.endsWith(INTEGRATION_FILE)),
  };
}

/** The flows of one level; their runs are kept out of the action's folder, which the other steps read. */
function cronplaneTest(ctx: Context, level: Level): Command {
  return { argv: [ctx.cronplane, "test", ctx.action, "--level", level, "--runs-dir", join(ctx.work, "runs")], cwd: ctx.action };
}

const builds: Readonly<Record<Step, Build>> = {
  validate: (ctx) => [{ argv: [ctx.cronplane, "action", "validate", ctx.action, "--hub", "--json"], cwd: ctx.action }],
  lockfile: (ctx) => {
    checkBounds(ctx.action);
    return [{ argv: ["bun", "install", "--frozen-lockfile"], cwd: ctx.action }];
  },
  types: (ctx) => [{ argv: [...tool(ctx, "tsc"), "--project", tsconfig(ctx)[0]], cwd: ctx.action, writes: [tsconfig(ctx)] }],
  // Asked to the library the lockfile step installed.
  cronplane: (ctx) => [{ argv: ["bun", join(ctx.kit, "ts", "src", "needs.ts"), ctx.action, ctx.requiresCronplane ?? ""], cwd: ctx.action }],
  lint: (ctx) => [
    {
      argv: [...tool(ctx, "eslint"), "--config", join(ctx.kit, "ts", "rules", "eslint.config.js"), "."],
      cwd: ctx.action,
      env: { CRONPLANE_KIT_TSCONFIG: tsconfig(ctx)[0] },
      writes: [tsconfig(ctx)],
    },
  ],
  // Everything the tests take from the network, taken before them: no test runs.
  prepare: (ctx) => [
    { argv: ["bun", "install", "--frozen-lockfile"], cwd: ctx.action },
    ...ctx.versions.map((version) => ({ argv: ["mise", "exec", `bun@${version}`, "--", "bun", "--version"], cwd: ctx.action })),
  ],
  // The threshold of Bun applies where every test runs: here, unless some need a service.
  unit: (ctx) => {
    coverageFloor(ctx.action);
    const { unit, integration } = testFiles(ctx.action);
    if (integration.length === 0) {
      return ctx.versions.map((version) => bunTest(ctx, version, measured(ctx, version)));
    }
    if (flowsOf(ctx.plan, "integration").length === 0) {
      throw new StepError(
        `${integration[0] ?? ""} needs a service: an integration flow (tests/flows, level: integration) names it, or the test is never run`,
      );
    }
    return unit.length === 0 ? [] : ctx.versions.map((version) => bunTest(ctx, version, unit));
  },
  audit: (ctx) => {
    // `bun audit` knows the registry only.
    checkSources(ctx.action);
    return [
      // What the action installs at run time: a known advisory fails.
      { argv: ["bun", "audit", "--production"], cwd: ctx.action },
      // The development tools too: their advisories are said, they never fail the check.
      { argv: ["bun", "audit"], cwd: ctx.action, onFailure: "report" },
    ];
  },
  licences: (ctx) => {
    const production = join(ctx.work, "production");
    const copy = (name: string): readonly [string, string] => [join(production, name), read(ctx.action, name)];
    return [
      {
        argv: ["bun", "install", "--production", "--frozen-lockfile"],
        cwd: production,
        writes: [copy("package.json"), copy("bun.lock")],
      },
      {
        argv: [join(ctx.kit, "licences", "check.sh"), join(production, "node_modules"), ctx.action, ctx.sbom ?? join(ctx.work, "sbom.spdx.json")],
        cwd: ctx.action,
      },
    ];
  },
  e2e: (ctx) => {
    if (ctx.plan.flows.length === 0) {
      throw new StepError("an action has one test flow at least: tests/flows/<name>.yaml with a test: block");
    }
    return flowsOf(ctx.plan, "e2e").length === 0 ? [] : [cronplaneTest(ctx, "e2e")];
  },
  // A service that does not start fails the step: a test is never skipped.
  integration: (ctx) => {
    if (flowsOf(ctx.plan, "integration").length === 0) {
      return [];
    }
    // Bun does not add a coverage to another: every test runs again, under its threshold.
    const tests =
      testFiles(ctx.action).integration.length === 0
        ? []
        : ctx.versions.map((version) => bunTest(ctx, version, measured(ctx, version), variables(ctx.plan)));
    const flows = [...tests, cronplaneTest(ctx, "integration")];
    if (ctx.services === "running") {
      return flows;
    }
    const compose = ["docker", "compose", "-f", join(ctx.action, "tests", "compose.yaml")];
    return [
      { argv: [...compose, "up", "-d", "--wait", ...ctx.plan.services], cwd: ctx.action },
      ...flows,
      { argv: [...compose, "down", "-v"], cwd: ctx.action, when: "always" },
    ];
  },
  // The contracts first: a number too low for their changes stops before any flow runs.
  regression: (ctx) => {
    const previous = ctx.previous;
    if (previous === undefined) {
      return [];
    }
    const compare: Command = { argv: [ctx.cronplane, "action", "compare", ctx.action, ...before(previous)], cwd: ctx.action };
    if (previous.plan.flows.length === 0) {
      return [compare];
    }
    const flows: Command = {
      argv: [ctx.cronplane, "test", ctx.action, ...before(previous), "--runs-dir", join(ctx.work, "runs")],
      cwd: ctx.action,
    };
    if (ctx.services === "running" || previous.plan.services.length === 0) {
      return [compare, flows];
    }
    const compose = ["docker", "compose", "-f", join(previous.folder, "tests", "compose.yaml")];
    return [
      compare,
      { argv: [...compose, "up", "-d", "--wait", ...previous.plan.services], cwd: ctx.action },
      flows,
      { argv: [...compose, "down", "-v"], cwd: ctx.action, when: "always" },
    ];
  },
};

/** The commands of a step. */
export function build(step: Step, ctx: Context): readonly Command[] {
  return new Map(Object.entries(builds)).get(step)?.(ctx) ?? [];
}

/** The action's coverage threshold (`bunfig.toml`), or why it cannot be read. */
function readFloor(action: string): number | StepError {
  let config: unknown;
  try {
    config = Bun.TOML.parse(read(action, "bunfig.toml"));
  } catch (e) {
    return new StepError(`bunfig.toml: ${String(e)}`, { cause: e });
  }
  const test = field(config, "test");
  const threshold = field(test, "coverageThreshold");
  const lines = typeof threshold === "number" ? threshold : field(threshold, "lines");
  if (typeof lines !== "number" || lines <= 0) {
    return new StepError("bunfig.toml: [test] coverageThreshold is required (the coverage measured, which never goes down)");
  }
  return lines;
}

/** The action's coverage threshold (`bunfig.toml`): required, it never goes down. */
export function coverageFloor(action: string): number {
  const floor = readFloor(action);
  if (floor instanceof StepError) {
    throw floor;
  }
  return floor;
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? new Map(Object.entries(value)).get(name) : undefined;
}

function read(directory: string, name: string): string {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file of the action checked
    return readFileSync(join(directory, name), "utf8");
  } catch (e) {
    throw new StepError(`${name}: ${String(e)}`, { cause: e });
  }
}
