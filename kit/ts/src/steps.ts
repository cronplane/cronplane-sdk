/**
 * The checks of a TypeScript action, in order, declared once: each step gives
 * the commands it runs. Building a command runs nothing (it may read the
 * action's files).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { StepError } from "./errors.ts";
import { checkSources } from "./sources.ts";

/** The steps, in the order they run; the same as the Python adapter's. */
export const STEPS = ["validate", "lockfile", "types", "cronplane", "lint", "tests", "audit", "licences", "flows"] as const;
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
}

export { StepError } from "./errors.ts";

/** The kit's own tools. */
function bin(ctx: Context, name: string): string {
  return join(ctx.kit, "ts", "node_modules", ".bin", name);
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
    exclude: [join(ctx.action, "node_modules")],
  };
  return [join(ctx.work, "tsconfig.json"), JSON.stringify(config)];
}

export type Build = (ctx: Context) => readonly Command[];

const builds: Readonly<Record<Step, Build>> = {
  validate: (ctx) => [{ argv: [ctx.cronplane, "action", "validate", ctx.action, "--hub", "--json"], cwd: ctx.action }],
  lockfile: (ctx) => [{ argv: ["bun", "install", "--frozen-lockfile"], cwd: ctx.action }],
  types: (ctx) => [{ argv: [bin(ctx, "tsc"), "--project", tsconfig(ctx)[0]], cwd: ctx.action, writes: [tsconfig(ctx)] }],
  // Asked to the library the lockfile step installed.
  cronplane: (ctx) => [{ argv: ["bun", join(ctx.kit, "ts", "src", "needs.ts"), ctx.action, ctx.requiresCronplane ?? ""], cwd: ctx.action }],
  lint: (ctx) => [
    {
      argv: [bin(ctx, "eslint"), "--config", join(ctx.kit, "ts", "rules", "eslint.config.js"), "."],
      cwd: ctx.action,
      env: { CRONPLANE_KIT_TSCONFIG: tsconfig(ctx)[0] },
      writes: [tsconfig(ctx)],
    },
  ],
  tests: (ctx) => {
    coverageFloor(ctx.action);
    return ctx.versions.map((version) => ({
      argv: ["mise", "exec", `bun@${version}`, "--", "bun", "test", "--coverage"],
      cwd: ctx.action,
    }));
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
  flows: (ctx) => {
    const directory = join(ctx.action, "tests", "flows");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a folder of the action checked
    if (!existsSync(directory)) {
      return [];
    }
    const secrets = join(directory, "secrets.env");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file of the action checked
    const extra = existsSync(secrets) ? ["--secret-file", secrets] : [];
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a folder of the action checked
    return readdirSync(directory)
      .filter((name) => name.endsWith(".yaml"))
      .sort()
      .map((name) => ({ argv: [ctx.cronplane, "run", join(directory, name), ...extra], cwd: ctx.action }));
  },
};

/** The commands of a step. */
export function build(step: Step, ctx: Context): readonly Command[] {
  return new Map(Object.entries(builds)).get(step)?.(ctx) ?? [];
}

/** The action's coverage threshold (`bunfig.toml`): required, it never goes down. */
export function coverageFloor(action: string): number {
  let config: unknown;
  try {
    config = Bun.TOML.parse(read(action, "bunfig.toml"));
  } catch (e) {
    throw new StepError(`bunfig.toml: ${String(e)}`, { cause: e });
  }
  const test = field(config, "test");
  const threshold = field(test, "coverageThreshold");
  const lines = typeof threshold === "number" ? threshold : field(threshold, "lines");
  if (typeof lines !== "number" || lines <= 0) {
    throw new StepError("bunfig.toml: [test] coverageThreshold is required (the coverage measured, which never goes down)");
  }
  return lines;
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
