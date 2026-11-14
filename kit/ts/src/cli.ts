#!/usr/bin/env bun
/**
 * `cronplane-kit-ts check <action> [--version X] [--step S]`: the checks of a
 * TypeScript action, in order; the first failure stops them.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { describe, parseReport, type Report, ReportError } from "./report.ts";
import { type Runner, runner } from "./run.ts";
import { build, type Context, show, type Step, StepError, STEPS } from "./steps.ts";

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
  const context = { ...ctx, versions, ...(report.requiresCronplane === undefined ? {} : { requiresCronplane: report.requiresCronplane }) };
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
    for (const command of commands) {
      const outcome = run(command);
      if (outcome.code !== 0 && command.onFailure === "report") {
        say(`! ${step}: ${show(command)} (it does not fail the check)\n${outcome.output}`);
      } else if (outcome.code !== 0) {
        say(`✗ ${step}: ${show(command)}\n${outcome.output}`);
        return false;
      }
    }
    say(`✓ ${step}`);
  }
  return true;
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
  const usage = "usage: cronplane-kit-ts check <action> [--version X] [--step S]… [--sbom FILE]";
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { version: { type: "string" }, step: { type: "string", multiple: true }, sbom: { type: "string" }, help: { type: "boolean" } },
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
  const steps = values.step === undefined ? STEPS : STEPS.filter((step) => values.step?.includes(step));
  const work = mkdtempSync(join(tmpdir(), "cronplane-kit-"));
  try {
    const sbom = values.sbom === undefined ? {} : { sbom: resolve(values.sbom) };
    const ctx: Context = { action: resolve(folder), cronplane, kit: KIT, work, versions: [], ...sbom };
    return check(ctx, runner(environment), { steps, ...(values.version === undefined ? {} : { version: values.version }) }) ? 0 : 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exit(main(Bun.argv.slice(2), process.env));
}
