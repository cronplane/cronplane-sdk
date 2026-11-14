import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { check } from "../src/cli.ts";
import { main, needed, problem } from "../src/needs.ts";
import { build } from "../src/steps.ts";
import { action, context, report } from "./helpers.ts";

/** An action whose library installed exports `exported`. */
function withLibrary(exported: string): string {
  const folder = action();
  const library = join(folder, "node_modules", "@cronplane", "actions");
  mkdirSync(library, { recursive: true });
  writeFileSync(join(library, "package.json"), '{"name": "@cronplane/actions", "type": "module", "exports": {".": "./index.ts"}}');
  writeFileSync(join(library, "index.ts"), `${exported}\n`);
  return folder;
}

test.each(["0.3", "0.4", "0.10", "1.0", "0.3.2"])("requires >=%s passes for a library that needs 0.3", (declared) => {
  expect(problem(declared, "0.3")).toBeUndefined();
});

test.each(["0.2", "0.1.9", "0"])("requires >=%s fails for a library that needs 0.3", (declared) => {
  expect(problem(declared, "0.3")).toBe(
    `action.yaml: requires.cronplane says >=${declared}: the library @cronplane/actions needs Cronplane 0.3 or newer (write \`requires: {cronplane: ">=0.3"}\`)`,
  );
});

test("an action with the library must name a Cronplane", () => {
  expect(problem("", "0.3")).toBe(
    'action.yaml: requires.cronplane is missing: the library @cronplane/actions needs Cronplane 0.3 or newer (write `requires: {cronplane: ">=0.3"}`)',
  );
});

test("what is not a version says so", () => {
  expect(problem("x.y", "0.3")).toBe('action.yaml: requires.cronplane: "x.y" is not a version');
});

test("an action without the library names what it wants", async () => {
  const folder = action();
  expect(await needed(folder)).toBeUndefined();
  expect(problem("", undefined)).toBeUndefined();
  expect(await main([folder], () => undefined)).toBe(0);
});

test("the library installed says what it needs", async () => {
  expect(await needed(withLibrary('export const REQUIRES_CRONPLANE = "0.3";'))).toBe("0.3");
  expect(await needed(withLibrary("export const OTHER = 1;"))).toBeUndefined();
});

test("the program fails with the problem", async () => {
  const folder = withLibrary('export const REQUIRES_CRONPLANE = "0.3";');
  const said: string[] = [];
  expect(await main([folder, "0.3"], (line) => said.push(line))).toBe(0);
  expect(await main([folder, "0.2"], (line) => said.push(line))).toBe(1);
  expect(await main([folder], (line) => said.push(line))).toBe(1);
  expect(said.map((line) => line.split(": the library")[0])).toEqual(["action.yaml: requires.cronplane says >=0.2", "action.yaml: requires.cronplane is missing"]);
});

test("the Cronplane the action requires goes to its check", () => {
  const folder = action();
  const [ask] = build("cronplane", { ...context(folder), requiresCronplane: "0.1" });
  expect(ask?.argv.slice(1)).toEqual([join(context(folder).kit, "ts", "src", "needs.ts"), folder, "0.1"]);
  expect(build("cronplane", context(folder))[0]?.argv.at(-1)).toBe("");
  const ran: string[] = [];
  const ok = check(context(folder, []), (command) => {
    ran.push(command.argv.join(" "));
    return { code: 0, output: report({ requiresCronplane: "0.1" }) };
  }, { steps: ["cronplane"], say: () => undefined });
  expect(ok).toBe(true);
  expect(ran.at(-1)?.endsWith(`${folder} 0.1`)).toBe(true);
});
