import { expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { check, KIT, main } from "../src/cli.ts";
import { type Outcome, runner } from "../src/run.ts";
import { type Command, type Services, show, type Step, STEPS } from "../src/steps.ts";
import { action, context, plan, report } from "./helpers.ts";

/** Answers `validate` with `answer` and `test --plan` with `flows`, and fails the commands containing `failing`. */
function fake(answer: string, failing?: string | RegExp, flows: string = plan()): { run: (command: Command) => Outcome; ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    run: (command) => {
      ran.push(show(command));
      if (command.argv.includes("validate")) {
        return { code: 0, output: answer };
      }
      if (command.argv.includes("--plan") && failing !== "--plan") {
        return { code: 0, output: flows };
      }
      const failed = failing !== undefined && (typeof failing === "string" ? show(command).includes(failing) : failing.test(show(command)));
      return { code: failed ? 1 : 0, output: failed ? "boom" : "" };
    },
  };
}

function runCheck(
  answer: string,
  steps: readonly Step[],
  options: { failing?: string | RegExp; version?: string; flows?: string; services?: Services } = {},
) {
  const said: string[] = [];
  const runs = fake(answer, options.failing, options.flows);
  const ok = check({ ...context(action(), []), services: options.services ?? "start" }, runs.run, {
    steps,
    ...(options.version === undefined ? {} : { version: options.version }),
    say: (line) => said.push(line),
  });
  return { ok, said, ran: runs.ran };
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
  expect(one.ran.filter((command) => command.includes("bun test"))).toEqual(["mise exec bun@1.4 -- bun test --coverage"]);
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
