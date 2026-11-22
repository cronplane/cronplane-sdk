import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { check, KIT, main } from "../src/cli.ts";
import { type Outcome, runner } from "../src/run.ts";
import { type Command, type Ended, measuredCoverage, type Previous, type Services, sheet, show, type Step, STEPS } from "../src/steps.ts";
import { NO_PLAN } from "../src/plan.ts";
import { action, context, plan, report } from "./helpers.ts";

/**
 * Answers `validate` with `answer`, `test --plan` with `flows` and `test --plan --previous` with
 * `before`, and fails the commands containing `failing`.
 */
function fake(
  answer: string,
  failing?: string | RegExp,
  flows: string = plan(),
  before: string = flows,
): { run: (command: Command) => Outcome; ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    run: (command) => {
      ran.push(show(command));
      if (command.argv.includes("validate")) {
        return { code: 0, output: answer };
      }
      if (command.argv.includes("--plan") && failing !== "--plan") {
        return { code: 0, output: command.argv.includes("--previous") ? before : flows };
      }
      const failed = failing !== undefined && (typeof failing === "string" ? show(command).includes(failing) : failing.test(show(command)));
      return { code: failed ? 1 : 0, output: failed ? "boom" : "" };
    },
  };
}

function runCheck(
  answer: string,
  steps: readonly Step[],
  options: { failing?: string | RegExp; version?: string; flows?: string; services?: Services; previous?: Previous; before?: string } = {},
) {
  const said: string[] = [];
  const runs = fake(answer, options.failing, options.flows, options.before);
  const ctx = {
    ...context(action(), []),
    services: options.services ?? "start",
    ...(options.previous === undefined ? {} : { previous: options.previous }),
  };
  const ok = check(ctx, runs.run, {
    steps,
    ...(options.version === undefined ? {} : { version: options.version }),
    say: (line) => said.push(line),
  });
  return { ok, said, ran: runs.ran, action: ctx.action, work: ctx.work };
}

test("the steps run in order and say so", () => {
  const { ok, said, ran } = runCheck(report({ versions: ["1.3", "1.4"] }), ["validate", "lockfile", "unit"]);
  expect(ok).toBe(true);
  expect(said).toEqual(["✓ validate: demo, Bun 1.3, 1.4", "✓ lockfile", "✓ unit"]);
  expect(ran.filter((command) => command.includes("bun test")).length).toBe(2);
});

test("the first failure stops the checks with its output", () => {
  const { ok, said, ran } = runCheck(report(), ["types", "lint"], { failing: "tsc" });
  expect(ok).toBe(false);
  expect(said.at(-1)).toMatch(/^✗ types: .*tsc[^]*\nboom$/);
  expect(ran.some((command) => command.includes("eslint"))).toBe(false);
});

test("an advisory on a development tool is said and fails nothing", () => {
  const { ok, said } = runCheck(report(), ["audit", "lockfile"], { failing: /^bun audit$/ });
  expect(ok).toBe(true);
  expect(said.slice(1)).toEqual(["! audit: bun audit (it does not fail the check)\nboom", "✓ audit", "✓ lockfile"]);
});

test("an advisory on what the action installs fails the audit", () => {
  const { ok, said } = runCheck(report(), ["audit"], { failing: "bun audit --production" });
  expect(ok).toBe(false);
  expect(said.at(-1)).toMatch(/^✗ audit: bun audit --production\nboom$/);
});

test("one version of the matrix for a CI job", () => {
  const one = runCheck(report({ versions: ["1.3", "1.4"] }), ["unit"], { version: "1.4" });
  expect(one.ran.filter((command) => command.includes("bun test")).map((command) => command.split(" --coverage")[0])).toEqual(["mise exec bun@1.4 -- bun test"]);
  const other = runCheck(report({ versions: ["1.3", "1.4"] }), ["unit"], { version: "1.1" });
  expect([other.ok, other.said.at(-1)]).toEqual([false, "--version 1.1: not in the action's matrix (1.3, 1.4)"]);
});

test.each([
  [report({ ok: false }), "✗ validate:\n  README.md: no README (readme)"],
  [report({ runtime: "python" }), "a python action: use the adapter of its language"],
  ["not json", "✗ validate: the report cannot be read"],
])("a report that is not ok stops everything", (answer, said) => {
  const { ok, said: told, ran } = runCheck(answer, STEPS);
  expect(ok).toBe(false);
  expect(told.at(-1)).toContain(said);
  expect(ran.length).toBe(1);
});

test("a step that cannot be built says why", () => {
  const said: string[] = [];
  const folder = action();
  writeFileSync(join(folder, "bunfig.toml"), "[test]\n");
  expect(check(context(folder, []), fake(report()).run, { steps: ["unit"], say: (line) => said.push(line) })).toBe(false);
  expect(said.at(-1)).toContain("coverageThreshold is required");
});

test("the runner runs a program, never a shell, and stops one that never ends", () => {
  const folder = action();
  const run = runner({ PATH: "/usr/bin:/bin" });
  const written = join(folder, "..", "work", "deep", "x.json");
  expect(run({ argv: ["sh", "-c", "echo $X; cat " + written], cwd: folder, env: { X: "1" }, writes: [[written, "{}"]] })).toEqual({ code: 0, output: "1\n{}" });
  expect(run({ argv: ["no-such-program-x"], cwd: folder }).code).toBe(127);
  expect(run({ argv: ["sh", "-c", "exit 3"], cwd: folder }).code).toBe(3);
  expect(runner({ PATH: "/usr/bin:/bin" }, 200)({ argv: ["sleep", "5"], cwd: folder }).code).toBe(124);
});

test("the command line checks an action with the cronplane given", () => {
  const folder = action();
  const cronplane = join(folder, "..", "cronplane");
  writeFileSync(join(folder, "..", "report.json"), report());
  writeFileSync(join(folder, "..", "plan.json"), plan());
  writeFileSync(
    cronplane,
    `#!/bin/sh\n[ "$1" = test ] && [ "$3" = --plan ] && exec cat "${join(folder, "..", "plan.json")}"\ncat "${join(folder, "..", "report.json")}"\n`,
  );
  chmodSync(cronplane, 0o755);
  const environment = { PATH: process.env["PATH"], CRONPLANE_BIN: cronplane };
  expect(main(["check", folder, "--step", "validate"], environment)).toBe(0);
  expect(main(["check", folder, "--step", "validate", "--version", "1.1"], environment)).toBe(1);
  expect(main(["check", folder, "--step", "nope"], environment)).toBe(2);
  expect(main(["check", folder, "--step", "e2e", "--services", "running"], environment)).toBe(0);
  expect(main(["check", folder, "--step", "e2e", "--services", "later"], environment)).toBe(2);
  expect(main(["check", folder, "--step", "e2e", "--sheet", join(folder, "..", "sheet.json")], environment)).toBe(0);
  const before = ["--previous", join(folder, "..", "v1"), "--from", "1.4.2", "--to", "1.5.0"];
  expect(main(["check", folder, "--step", "regression", ...before], environment)).toBe(0);
  expect(main(["check", folder, "--step", "regression", "--previous", join(folder, "..", "v1")], environment)).toBe(0);
  expect(main(["check", folder, "--step", "regression", "--from", "1.4.2"], environment)).toBe(2);
  expect(main(["check", folder], { PATH: process.env["PATH"] })).toBe(2);
  expect(main(["help"], environment)).toBe(2);
  expect(main(["--help"], environment)).toBe(0);
  expect(KIT.endsWith("kit")).toBe(true);
});

const WRITE: readonly [string, string] = ["write.yaml", "integration"];

test("each level says what it ran", () => {
  const flows = plan([["a.yaml", "e2e"], ["b.yaml", "e2e"], WRITE], ["postgres"]);
  const both = runCheck(report(), ["e2e", "integration"], { flows });
  expect([both.ok, both.said.slice(1)]).toEqual([true, ["✓ e2e: 2 flows", "✓ integration: 1 flow, services: postgres"]]);
  const one = runCheck(report(), ["e2e", "integration"]);
  expect([one.ok, one.said.slice(1)]).toEqual([true, ["✓ e2e: 1 flow", "✓ integration: not provided"]]);
});

test("an action without test flow fails its levels", () => {
  const { ok, said } = runCheck(report(), ["e2e"], { flows: plan([]) });
  expect(ok).toBe(false);
  expect(said.at(-1)).toContain("an action has one test flow at least");
});

test.each([
  [{ failing: "--plan" }, "✗ test flows: /bin/cronplane test"],
  [{ flows: "not json" }, "✗ test flows: the plan cannot be read: not JSON"],
])("test flows that cannot be read stop the levels", (options, said) => {
  const { ok, said: told, ran } = runCheck(report(), ["lockfile", "e2e"], options);
  expect(ok).toBe(false);
  expect(told.at(-1)?.startsWith(said)).toBe(true);
  expect(ran.some((command) => command.includes("bun install"))).toBe(false);
});

test("the services are stopped whatever fails", () => {
  const flows = plan([WRITE], ["postgres"]);
  const start = runCheck(report(), ["integration"], { flows, failing: "up -d --wait" });
  expect(start.ok).toBe(false);
  expect(start.said.at(-1)?.startsWith("✗ integration: docker compose")).toBe(true);
  expect(start.ran.some((command) => command.includes("--level integration"))).toBe(false);
  expect(start.ran.at(-1)?.endsWith("down -v")).toBe(true);
  const flow = runCheck(report(), ["integration"], { flows, failing: "--level integration" });
  expect([flow.ok, flow.ran.at(-1)?.endsWith("down -v")]).toEqual([false, true]);
});

test("services that run already are left alone", () => {
  const { ok, ran } = runCheck(report(), ["integration"], { flows: plan([WRITE], ["postgres"]), services: "running" });
  expect(ok).toBe(true);
  expect(ran.some((command) => command.includes("compose"))).toBe(false);
  expect(ran.some((command) => command.includes("--level integration"))).toBe(true);
});

test("without the version before, the regression step says it is not provided", () => {
  const { ok, said, ran } = runCheck(report(), ["regression"]);
  expect([ok, said.at(-1)]).toEqual([true, "✓ regression: not provided"]);
  expect(ran.some((command) => command.includes("compare"))).toBe(false);
});

const V1: Previous = { folder: "/src/v1", plan: NO_PLAN };

test("the regression step compares the contracts, then runs the flows of the version before", () => {
  const previous = { ...V1, number: "1.4.2", nextNumber: "1.5.0" };
  const before = plan([WRITE, ["read.yaml", "e2e"]], ["postgres"]);
  const { ok, said, ran, action: folder, work } = runCheck(report(), ["regression"], { previous, before });
  expect([ok, said.at(-1)]).toEqual([true, "✓ regression: 2 flows of the version before"]);
  const numbers = "--previous /src/v1 --from 1.4.2 --to 1.5.0";
  const compose = "docker compose -f /src/v1/tests/compose.yaml";
  expect(ran.slice(1)).toEqual([
    `/bin/cronplane test ${folder} --plan --json ${numbers}`,
    `/bin/cronplane action compare ${folder} ${numbers}`,
    `${compose} up -d --wait postgres`,
    `/bin/cronplane test ${folder} ${numbers} --runs-dir ${join(work, "runs")}`,
    `${compose} down -v`,
  ]);
});

test("a number too low for the contract stops before any flow runs", () => {
  const { ok, said, ran } = runCheck(report(), ["regression"], { previous: V1, failing: "action compare" });
  expect(ok).toBe(false);
  expect(said.at(-1)?.startsWith("✗ regression: /bin/cronplane action compare")).toBe(true);
  expect(ran.at(-1)?.startsWith("/bin/cronplane action compare")).toBe(true);
});

test("a flow of the version before that fails stops its services too", () => {
  const before = plan([WRITE], ["postgres"]);
  const { ok, said, ran } = runCheck(report(), ["regression"], { previous: V1, before, failing: "--runs-dir" });
  expect(ok).toBe(false);
  expect(said.at(-1)).toContain("✗ regression: /bin/cronplane test");
  expect(ran.at(-1)?.endsWith("down -v")).toBe(true);
});

test("a version before without a flow that runs only compares the contracts", () => {
  const none = runCheck(report(), ["regression"], { previous: V1, before: plan([]) });
  expect([none.ok, none.said.at(-1)]).toEqual([true, "✓ regression: 0 flows of the version before"]);
  expect(none.ran.at(-1)).toBe(`/bin/cronplane action compare ${none.action} --previous /src/v1`);

  const before = plan([WRITE], ["postgres"]);
  const running = runCheck(report(), ["regression"], { previous: V1, before, services: "running" });
  expect([running.ok, running.said.at(-1)]).toEqual([true, "✓ regression: 1 flow of the version before"]);
  expect(running.ran.some((command) => command.includes("compose"))).toBe(false);
  const doubles = runCheck(report(), ["regression"], { previous: V1, before: plan([["read.yaml", "e2e"]]) });
  expect(doubles.ran.some((command) => command.includes("compose"))).toBe(false);

  const unread = runCheck(report(), ["regression"], { previous: V1, failing: "--plan" });
  expect(unread.ok).toBe(false);
  expect(unread.said.at(-1)?.startsWith("✗ test flows: /bin/cronplane test")).toBe(true);
});

test("after every step, the sheet of the action is said", () => {
  const whole = runCheck(report(), STEPS);
  expect(whole.ok).toBe(true);
  expect(whole.ran.at(-1)).toBe(`/bin/cronplane action sheet ${whole.action} --results ${join(whole.work, "results.json")}`);
  expect(whole.said.at(-2)).toBe("✓ regression: not provided");
  const part = runCheck(report(), ["lint"]);
  expect(part.ran.some((command) => command.includes("action sheet"))).toBe(false);
});

test("the sheet is said and kept even when a step failed", () => {
  const folder = action();
  const said: string[] = [];
  const runs = fake(report(), "eslint");
  const ctx = { ...context(folder, []), sheet: "/kept/sheet.json" };
  expect(check(ctx, runs.run, { steps: ["types", "lint", "unit"], say: (line) => said.push(line) })).toBe(false);
  expect(runs.ran.at(-1)?.endsWith("--output /kept/sheet.json")).toBe(true);
});

test("the results say how each step ended and what was covered", () => {
  const folder = action();
  const ctx = { ...context(folder), previous: { ...V1, number: "1.4.2", nextNumber: "1.5.0" } };
  const ended = new Map<Step, Ended>([["validate", "passed"], ["lockfile", "passed"], ["types", "failed"]]);
  const command = sheet(ctx, ended);
  const file = join(ctx.work, "results.json");
  expect(command.argv.slice(4)).toEqual(["--results", file, "--previous", "/src/v1", "--from", "1.4.2", "--to", "1.5.0"]);
  expect(command.onFailure).toBe("report");
  const results = (text: string | undefined): unknown => JSON.parse(text ?? "");
  expect(command.writes?.[0]?.[0]).toBe(file);
  expect(results(command.writes?.[0]?.[1])).toEqual({
    version: 1,
    steps: { ...Object.fromEntries(STEPS.map((step) => [step, "not_run"])), validate: "passed", lockfile: "passed", types: "failed" },
    coverage: { measured: null, threshold: 90 },
  });

  const lcov = join(ctx.work, "coverage-1.4");
  mkdirSync(lcov, { recursive: true });
  writeFileSync(join(lcov, "lcov.info"), "SF:a.ts\nLF:30\nLH:29\nend_of_record\nSF:b.ts\nLF:10\nLH:10\nend_of_record\n");
  expect(measuredCoverage(ctx)).toBe(97.5);
  writeFileSync(join(lcov, "lcov.info"), "TN:\n");
  expect(measuredCoverage(ctx)).toBeUndefined();
  expect(measuredCoverage({ ...ctx, versions: [] })).toBeUndefined();

  writeFileSync(join(folder, "bunfig.toml"), "[test]\n");
  expect(results(sheet(ctx, ended).writes?.[0]?.[1])).toMatchObject({ coverage: null });
});
