import { expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { checkBounds, unbounded } from "../src/bounds.ts";
import { build, StepError } from "../src/steps.ts";
import { action, context } from "./helpers.ts";

function dependsOn(folder: string, dependencies: unknown): void {
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "demo", dependencies }));
}

test.each(["^0.1.1", "~1.4.0", "1.2.3", "=v1.2.3-rc.1", "1", "1.x", "2.1.*", ">=1.2 <2", "1.0.0 - 1.9.0", "^1 || ^2"])("%s has an upper bound", (range) => {
  expect(unbounded(range)).toBeUndefined();
});

test.each([
  [">=1.2.0", "^1.2.0"],
  ["> 0.3", "^0.3"],
  ["*", "^<version>"],
  ["latest", "^<version>"],
  ["", "^<version>"],
  ["^1 || >=2", "^<version>"],
])("%s says what to write: %s", (range, fixed) => {
  expect(unbounded(range)).toBe(fixed);
});

test("an action with bounded dependencies, or none, passes", () => {
  const folder = action();
  checkBounds(folder);
  dependsOn(folder, { "@cronplane/actions": "^0.1.1", zod: "~4.1.0" });
  checkBounds(folder);
});

test("each unbounded dependency is named, and the lockfile step stops", () => {
  const folder = action();
  dependsOn(folder, { "@cronplane/actions": "^0.1.1", zod: ">=4.1.0", left: "*", odd: 3 });
  const message = "package.json: a dependency without an upper bound lets a new lock take a new major: zod@>=4.1.0 (write ^4.1.0); left@* (write ^<version>); odd@3 (write ^<version>)";
  expect(() => { checkBounds(folder); }).toThrow(new StepError(message));
  expect(() => build("lockfile", context(folder))).toThrow(new StepError(message));
});

test("a bad or missing package.json says so", () => {
  const folder = action();
  dependsOn(folder, "x");
  expect(() => { checkBounds(folder); }).toThrow(new StepError("package.json: dependencies is an object"));
  writeFileSync(join(folder, "package.json"), "{");
  expect(() => { checkBounds(folder); }).toThrow(StepError);
  unlinkSync(join(folder, "package.json"));
  expect(() => { checkBounds(folder); }).toThrow(StepError);
});
