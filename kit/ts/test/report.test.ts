import { expect, test } from "bun:test";

import { describe, parseReport, ReportError } from "../src/report.ts";
import { report } from "./helpers.ts";

test("the matrix and the problems are read", () => {
  const read = parseReport(report({ versions: ["1.3", "1.4"] }));
  expect([read.name, read.runtime, read.versions, read.ok]).toEqual(["demo", "typescript", ["1.3", "1.4"], true]);
  const failed = parseReport(report({ ok: false }));
  expect(failed.problems).toEqual([{ rule: "readme", at: "README.md", message: "no README" }]);
  expect(failed.problems.map(describe)).toEqual(["README.md: no README (readme)"]);
});

test("the Cronplane the action requires is read", () => {
  expect(parseReport(report({ requiresCronplane: "0.1" })).requiresCronplane).toBe("0.1");
  expect(parseReport(report()).requiresCronplane).toBeUndefined();
});

test("an invalid action has no name", () => {
  const read = parseReport('{"version": 1, "action": null, "matrix": [1], "ok": false, "problems": [{"rule": "definition"}, 2]}');
  expect([read.name, read.runtime, read.versions, read.problems]).toEqual([undefined, undefined, [], [{ rule: "definition", at: "", message: "" }]]);
});

test.each([
  ["{", /not JSON/],
  ["[]", /a JSON object is expected/],
  ['{"version": 2}', /version 2: this adapter reads version 1/],
])("%s is refused", (text, message) => {
  expect(() => parseReport(text)).toThrow(message);
  expect(() => parseReport(text)).toThrow(ReportError);
});
