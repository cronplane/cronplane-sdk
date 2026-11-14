import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { KIT } from "../src/cli.ts";
import { build, coverageFloor, STEPS, StepError } from "../src/steps.ts";
import { action, context } from "./helpers.ts";

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

test("tests run once per Bun version of the matrix", () => {
  expect(argv("tests", action())).toEqual([
    ["mise", "exec", "bun@1.3", "--", "bun", "test", "--coverage"],
    ["mise", "exec", "bun@1.4", "--", "bun", "test", "--coverage"],
  ]);
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

test("flows run with their secrets file", () => {
  const folder = action();
  expect(argv("flows", folder)).toEqual([]);
  const flows = join(folder, "tests", "flows");
  mkdirSync(flows, { recursive: true });
  writeFileSync(join(flows, "b.yaml"), "");
  writeFileSync(join(flows, "a.yaml"), "");
  expect(argv("flows", folder).map((command) => command[2])).toEqual([join(flows, "a.yaml"), join(flows, "b.yaml")]);
  writeFileSync(join(flows, "secrets.env"), "TOKEN=x\n");
  expect(argv("flows", folder)[0]?.slice(-2)).toEqual(["--secret-file", join(flows, "secrets.env")]);
});

test("the lockfile is checked by Bun in the action's folder", () => {
  expect(argv("lockfile", action())).toEqual([["bun", "install", "--frozen-lockfile"]]);
});

test("only an advisory on what the action installs at run time fails the audit", () => {
  const [runtime, everything] = build("audit", context(action()));
  expect([runtime?.argv, runtime?.onFailure]).toEqual([["bun", "audit", "--production"], undefined]);
  expect([everything?.argv, everything?.onFailure]).toEqual([["bun", "audit"], "report"]);
});
