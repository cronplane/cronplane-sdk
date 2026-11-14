import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { checkSources, unregistered } from "../src/sources.ts";
import { build, StepError } from "../src/steps.ts";
import { action, context } from "./helpers.ts";

const FROM_GIT = "git+ssh://git@github.com/cronplane/cronplane-sdk.git#613b042";

function lock(folder: string, packages: Record<string, string>): void {
  const entries = Object.entries(packages).map(([name, spec]) => `    "${name}": ["${name}@${spec}", {}, "sha"],\n`);
  writeFileSync(join(folder, "bun.lock"), `{\n  "lockfileVersion": 1,\n  "packages": {\n${entries.join("")}  },\n}\n`);
}

test("only packages without a version come from elsewhere than the registry", () => {
  expect(unregistered(`{"packages": {"left-pad": ["left-pad@1.3.0"], "@cronplane/actions": ["@cronplane/actions@${FROM_GIT}"], "odd": [1]}}`)).toEqual([["@cronplane/actions", FROM_GIT]]);
  expect(unregistered('{"packages": {"y": ["z@1.0.0"]}}')).toEqual([["y", "z@1.0.0"]]);
  expect(unregistered("{}")).toEqual([]);
  expect(() => unregistered("{")).toThrow(StepError);
});

test("packages from the registry pass the audit", () => {
  const folder = action();
  lock(folder, { "@cronplane/actions": "0.1.0", "left-pad": "1.3.0", "@scope/x": "2.0.0" });
  expect(build("audit", context(folder)).map((command) => command.argv)).toEqual([["bun", "audit", "--production"], ["bun", "audit"]]);
});

test.each([
  ["left-pad", "github:someone/left-pad#abc"],
  ["@cronplane/actions", FROM_GIT],
  ["x", "https://example.com/x.tgz"],
])("%s from %s fails", (name, spec) => {
  const folder = action();
  lock(folder, { [name]: spec });
  expect(() => { checkSources(folder); }).toThrow(new StepError(`bun.lock: ${name} comes from ${spec}: take it from the registry`));
  expect(() => build("audit", context(folder))).toThrow(StepError);
});

test("a missing lockfile says so", () => {
  expect(() => { checkSources(join(action(), "missing")); }).toThrow(/bun\.lock/);
});
