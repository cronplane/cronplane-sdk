#!/usr/bin/env bun
/**
 * `cronplane-kit-ts check <action> [--version X] [--step S] [--services running] [--previous FOLDER]`:
 * the checks of a TypeScript action, in order; the first failure stops them.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { flowsOf, NO_PLAN, parsePlan, type Plan, PlanError } from "./plan.ts";
import { describe, parseReport, type Report, ReportError } from "./report.ts";
import { type Runner, runner } from "./run.ts";
import { before, build, type Command, type Context, type Previous, SERVICES, show, type Step, StepError, STEPS } from "./steps.ts";

/** The kit's folder: `ts/src/cli.ts` is in it. */
export const KIT = resolve(dirname(import.meta.dir), "..");

export interface Options {
  readonly steps: readonly Step[];
  readonly version?: string;
  readonly say?: (line: string) => void;
}

/** Runs the steps on the action of `ctx`; true when every one passed. */
export function check(ctx: Context, run: Runner, options: Options): boolean {
  const say = options.say ?? ((line: string) => { console.log(line); });
  const report = validate(ctx, run, say);
  if (report === undefined) {
    return false;
  }
  if (report.runtime !== "typescript") {
    say(`${ctx.action}: a ${String(report.runtime)} action: use the adapter of its language`);
    return false;
  }
  let versions = report.versions;
  if (options.version !== undefined) {
    if (!versions.includes(options.version)) {
      say(`--version ${options.version}: not in the action's matrix (${versions.join(", ")})`);
      return false;
    }
    versions = [options.version];
  }
  const plan = options.steps.some((step) => LEVEL_STEPS.includes(step)) ? readPlan(ctx, run, say) : NO_PLAN;
  if (plan === undefined) {
    return false;
  }
  let previous = ctx.previous;
  if (previous !== undefined && options.steps.includes("regression")) {
    const flows = readPlan(ctx, run, say, previous);
    if (flows === undefined) {
      return false;
    }
    previous = { ...previous, plan: flows };
  }
  const context: Context = {
    ...ctx,
    versions,
    plan,
    ...(report.requiresCronplane === undefined ? {} : { requiresCronplane: report.requiresCronplane }),
    ...(previous === undefined ? {} : { previous }),
  };
  for (const step of options.steps.filter((s) => s !== "validate")) {
    let commands;
    try {
      commands = build(step, context);
    } catch (e) {
      if (!(e instanceof StepError)) {
        throw e;
      }
      say(`✗ ${step}: ${e.message}`);
      return false;
    }
    if (!runStep(step, commands, run, say)) {
      return false;
    }
    say(`✓ ${step}${count(step, context)}`);
  }
  return true;
}

/** What a level ran, after its name: its flows, and its services. */
function count(step: Step, ctx: Context): string {
  if (step === "regression") {
    if (ctx.previous === undefined) {
      return ": not provided";
    }
    const flows = ctx.previous.plan.flows.length;
    return `: ${String(flows)} flow${flows === 1 ? "" : "s"} of the version before`;
  }
  if (step !== "e2e" && step !== "integration") {
    return "";
  }
  const plan = ctx.plan;
  const flows = flowsOf(plan, step).length;
  if (flows === 0) {
    return ": not provided";
  }
  const services = step === "integration" ? `, services: ${plan.services.join(", ")}` : "";
  return `: ${String(flows)} flow${flows > 1 ? "s" : ""}${services}`;
}

/**
 * Runs the commands of a step up to the first that fails it; those that
 * always run (what stops the services) run after it too.
 */
function runStep(step: Step, commands: readonly Command[], run: Runner, say: (line: string) => void): boolean {
  let failed = false;
  for (const command of commands) {
    if (failed && command.when !== "always") {
      continue;
    }
    const outcome = run(command);
    if (outcome.code !== 0 && command.onFailure === "report") {
      say(`! ${step}: ${show(command)} (it does not fail the check)\n${outcome.output}`);
    } else if (outcome.code !== 0) {
      say(`✗ ${step}: ${show(command)}\n${outcome.output}`);
      failed = true;
    }
  }
  return !failed;
}

/** The steps that read the test flows of the action. */
const LEVEL_STEPS: readonly Step[] = ["e2e", "integration"];

/** The test flows of the action, or those of `previous` that run against it. */
function readPlan(ctx: Context, run: Runner, say: (line: string) => void, previous?: Previous): Plan | undefined {
  const command: Command = {
    argv: [ctx.cronplane, "test", ctx.action, "--plan", "--json", ...(previous === undefined ? [] : before(previous))],
    cwd: ctx.action,
  };
  const outcome = run(command);
  if (outcome.code !== 0) {
    say(`✗ test flows: ${show(command)}\n${outcome.output}`);
    return undefined;
  }
  try {
    return parsePlan(outcome.output);
  } catch (e) {
    if (!(e instanceof PlanError)) {
      throw e;
    }
    say(`✗ test flows: the plan cannot be read: ${e.message}\n${outcome.output}`);
    return undefined;
  }
}

function validate(ctx: Context, run: Runner, say: (line: string) => void): Report | undefined {
  const [command] = build("validate", ctx);
  const outcome = run(command ?? { argv: [], cwd: ctx.action });
  let report: Report;
  try {
    report = parseReport(outcome.output);
  } catch (e) {
    if (!(e instanceof ReportError)) {
      throw e;
    }
    say(`✗ validate: the report cannot be read: ${e.message}\n${outcome.output}`);
    return undefined;
  }
  if (!report.ok) {
    say(`✗ validate:\n${report.problems.map((p) => `  ${describe(p)}`).join("\n")}`);
    return undefined;
  }
  say(`✓ validate: ${String(report.name)}, Bun ${report.versions.join(", ")}`);
  return report;
}

/** The command line; the exit code it ends with. */
export function main(argv: readonly string[], environment: Readonly<Record<string, string | undefined>>): number {
  const usage =
    "usage: cronplane-kit-ts check <action> [--version X] [--step S]… [--sbom FILE] [--services start|running] [--previous FOLDER [--from X.Y.Z] [--to X.Y.Z]]";
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      version: { type: "string" },
      step: { type: "string", multiple: true },
      sbom: { type: "string" },
      services: { type: "string" },
      previous: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      help: { type: "boolean" },
    },
  });
  const [command, folder] = positionals;
  if (values.help === true || command !== "check" || folder === undefined) {
    console.log(usage);
    return values.help === true ? 0 : 2;
  }
  const cronplane = environment["CRONPLANE_BIN"];
  if (cronplane === undefined || cronplane === "") {
    console.error("CRONPLANE_BIN: the path of the cronplane binary that checks actions");
    return 2;
  }
  const known: readonly string[] = STEPS;
  const unknown = (values.step ?? []).filter((step) => !known.includes(step));
  if (unknown.length > 0) {
    console.error(`--step ${unknown.join(", ")}: one of ${STEPS.join(", ")}`);
    return 2;
  }
  const services = SERVICES.find((known) => known === (values.services ?? "start"));
  if (services === undefined) {
    console.error(`--services ${String(values.services)}: one of ${SERVICES.join(", ")}`);
    return 2;
  }
  if (values.previous === undefined && (values.from !== undefined || values.to !== undefined)) {
    console.error("--from and --to are the numbers around --previous");
    return 2;
  }
  const previous: { previous?: Previous } =
    values.previous === undefined
      ? {}
      : {
          previous: {
            folder: resolve(values.previous),
            plan: NO_PLAN,
            ...(values.from === undefined ? {} : { number: values.from }),
            ...(values.to === undefined ? {} : { nextNumber: values.to }),
          },
        };
  const steps = values.step === undefined ? STEPS : STEPS.filter((step) => values.step?.includes(step));
  const work = mkdtempSync(join(tmpdir(), "cronplane-kit-"));
  try {
    const sbom = values.sbom === undefined ? {} : { sbom: resolve(values.sbom) };
    const ctx: Context = { action: resolve(folder), cronplane, kit: KIT, work, versions: [], plan: NO_PLAN, services, ...sbom, ...previous };
    return check(ctx, runner(environment), { steps, ...(values.version === undefined ? {} : { version: values.version }) }) ? 0 : 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exit(main(Bun.argv.slice(2), process.env));
}
