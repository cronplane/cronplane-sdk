import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { KIT } from "../src/cli.ts";
import { build, coverageFloor, STEPS, StepError, testFiles } from "../src/steps.ts";
import { action, context, plan } from "./helpers.ts";

const argv = (step: (typeof STEPS)[number], folder: string): string[][] =>
  build(step, context(folder)).map((command) => [...command.argv]);

test("every step builds its commands in the action's folder", () => {
  const folder = action();
  for (const step of STEPS) {
    expect(build(step, context(folder)).every((command) => command.cwd.startsWith(join(folder, "..")))).toBe(true);
  }
});

test("validate asks for the hub rules as JSON", () => {
  const folder = action();
  expect(argv("validate", folder)).toEqual([["/bin/cronplane", "action", "validate", folder, "--hub", "--json"]]);
});

test("the rules are the kit's whatever the action configures", () => {
  const folder = action();
  const [types] = build("types", context(folder));
  expect(types?.argv).toEqual([join(KIT, "ts", "node_modules", ".bin", "tsc"), "--project", join(folder, "..", "work", "tsconfig.json")]);
  const written = JSON.parse(types?.writes?.[0]?.[1] ?? "{}") as { compilerOptions: { strict: boolean }; include: string[] };
  expect(written.compilerOptions.strict).toBe(true);
  expect(written.include).toEqual([join(folder, "**", "*.ts")]);
  const [lint] = build("lint", context(folder));
  expect(lint?.argv.slice(1, 3)).toEqual(["--config", join(KIT, "ts", "rules", "eslint.config.js")]);
  expect(lint?.env?.["CRONPLANE_KIT_TSCONFIG"]).toBe(join(folder, "..", "work", "tsconfig.json"));
});

/** What makes `bun test` of one version measure the coverage and keep it for the sheet. */
function measured(folder: string, version: string): string[] {
  return ["--coverage", "--coverage-reporter=text", "--coverage-reporter=lcov", `--coverage-dir=${join(folder, "..", "work", `coverage-${version}`)}`];
}

test("unit tests run once per Bun version of the matrix, and keep what they covered", () => {
  const folder = action();
  expect(argv("unit", folder)).toEqual([
    ["mise", "exec", "bun@1.3", "--", "bun", "test", ...measured(folder, "1.3")],
    ["mise", "exec", "bun@1.4", "--", "bun", "test", ...measured(folder, "1.4")],
  ]);
});

test("the tests that need a service run at the integration level, the others twice", () => {
  const folder = action();
  mkdirSync(join(folder, "src", "deep"), { recursive: true });
  mkdirSync(join(folder, "node_modules", "x"), { recursive: true });
  mkdirSync(join(folder, ".cache"));
  for (const file of ["b.test.ts", "src/a_spec.js", "src/deep/store.integration.test.ts", "src/helper.ts", "node_modules/x/y.test.ts", ".cache/z.test.ts"]) {
    writeFileSync(join(folder, file), "");
  }
  expect(testFiles(folder)).toEqual({ unit: ["./b.test.ts", "./src/a_spec.js"], integration: ["./src/deep/store.integration.test.ts"] });

  const flows = plan([["write.yaml", "integration", { postgres_url: "postgresql://x" }]], ["postgres"]);
  const ctx = context(folder, ["1.3", "1.4"], flows);
  expect(build("unit", ctx).map((command) => command.argv)).toEqual([
    ["mise", "exec", "bun@1.3", "--", "bun", "test", "./b.test.ts", "./src/a_spec.js"],
    ["mise", "exec", "bun@1.4", "--", "bun", "test", "./b.test.ts", "./src/a_spec.js"],
  ]);
  const [, first, second, third] = build("integration", ctx);
  expect([first?.argv, first?.env]).toEqual([["mise", "exec", "bun@1.3", "--", "bun", "test", ...measured(folder, "1.3")], { POSTGRES_URL: "postgresql://x" }]);
  expect(second?.argv.at(2)).toBe("bun@1.4");
  expect(third?.argv.slice(3, 5)).toEqual(["--level", "integration"]);

  expect(() => build("unit", context(folder))).toThrow(/store\.integration\.test\.ts needs a service/);
  rmSync(join(folder, "b.test.ts"));
  rmSync(join(folder, "src", "a_spec.js"));
  expect(build("unit", ctx)).toEqual([]);
});

test("the coverage threshold is required", () => {
  const folder = action();
  expect(coverageFloor(folder)).toBe(0.9);
  writeFileSync(join(folder, "bunfig.toml"), "[test]\ncoverageThreshold = 0.8\n");
  expect(coverageFloor(folder)).toBe(0.8);
  for (const text of ["[test]\n", "[test]\ncoverageThreshold = { lines = 0 }\n", "[test", ""]) {
    writeFileSync(join(folder, "bunfig.toml"), text);
    expect(() => coverageFloor(folder)).toThrow(StepError);
  }
  expect(() => coverageFloor(join(folder, "missing"))).toThrow(/bunfig\.toml/);
});

test("licences read a production install of the lockfile", () => {
  const folder = action();
  const [install, check] = build("licences", context(folder));
  const production = join(folder, "..", "work", "production");
  expect([install?.argv, install?.cwd]).toEqual([["bun", "install", "--production", "--frozen-lockfile"], production]);
  expect(install?.writes?.map(([path]) => path)).toEqual([join(production, "package.json"), join(production, "bun.lock")]);
  expect(check?.argv).toEqual([join(KIT, "licences", "check.sh"), join(production, "node_modules"), folder, join(folder, "..", "work", "sbom.spdx.json")]);
});

test("the SBOM goes where it is asked", () => {
  const folder = action();
  const [, check] = build("licences", { ...context(folder), sbom: "/kept/sbom.json" });
  expect(check?.argv.at(-1)).toBe("/kept/sbom.json");
});

test("the e2e level runs the flows that need doubles only", () => {
  const folder = action();
  expect(argv("e2e", folder)).toEqual([["/bin/cronplane", "test", folder, "--level", "e2e", "--runs-dir", join(folder, "..", "work", "runs")]]);
  const services = context(folder, ["1.4"], plan([["write.yaml", "integration"]], ["postgres"]));
  expect(build("e2e", services)).toEqual([]);
  expect(() => build("e2e", context(folder, ["1.4"], plan([])))).toThrow(/one test flow at least/);
});

test("the integration level runs between the start and the stop of its services", () => {
  const folder = action();
  expect(argv("integration", folder)).toEqual([]);
  const ctx = context(folder, ["1.4"], plan([["write.yaml", "integration"]], ["postgres", "cache"]));
  const compose = ["docker", "compose", "-f", join(folder, "tests", "compose.yaml")];
  const [up, flows, down] = build("integration", ctx);
  expect(up?.argv).toEqual([...compose, "up", "-d", "--wait", "postgres", "cache"]);
  expect(flows?.argv.slice(0, 5)).toEqual(["/bin/cronplane", "test", folder, "--level", "integration"]);
  expect([down?.argv, down?.when]).toEqual([[...compose, "down", "-v"], "always"]);
  expect(build("integration", { ...ctx, services: "running" })).toEqual(flows === undefined ? [] : [flows]);
});

test("the lockfile is checked by Bun in the action's folder", () => {
  expect(argv("lockfile", action())).toEqual([["bun", "install", "--frozen-lockfile"]]);
});

test("only an advisory on what the action installs at run time fails the audit", () => {
  const [runtime, everything] = build("audit", context(action()));
  expect([runtime?.argv, runtime?.onFailure]).toEqual([["bun", "audit", "--production"], undefined]);
  expect([everything?.argv, everything?.onFailure]).toEqual([["bun", "audit"], "report"]);
});
