/**
 * The version of Cronplane the library needs: the cases every library for
 * actions passes (`contract/version/cases.json`), and where this library
 * applies them.
 */

import { describe, expect, test } from "bun:test";

import { REQUIRES_CRONPLANE, VersionError } from "../src/index.ts";
import { check, Minor, VARIABLE } from "../src/version.ts";
import { Case, Step } from "./helpers.ts";

const CASES = Case.of("version");
const SINCE = new Map(CASES.get("since").entries().map(([part, since]) => [part, new Case(since).text()]));
const ACCEPTED = CASES.get("accepted").list();
const REFUSED = CASES.get("refused").list();
const MALFORMED = CASES.get("malformed").list().map((value) => value.text());

/** The parts of the contract this library implements. */
const IMPLEMENTED = ["schema", "streams", "state", "network"];

function minor(text: string): Minor {
  const parsed = Minor.parse(text);
  if (parsed === undefined) {
    throw new Error(`${text} is not a minor version`);
  }
  return parsed;
}

test("the cases are those of the version this library reads", () => {
  expect([CASES.get("version").value, CASES.get("variable").value]).toEqual([1, VARIABLE]);
  expect(ACCEPTED.length).toBeGreaterThan(0);
  expect(REFUSED.length).toBeGreaterThan(0);
  expect(MALFORMED.length).toBeGreaterThan(0);
});

test("the library needs the Cronplane of the latest part it implements", () => {
  expect([...SINCE.keys()].sort()).toEqual([...IMPLEMENTED].sort());
  const latest = IMPLEMENTED.map((part) => minor(SINCE.get(part) ?? "")).reduce((a, b) => (a.isBefore(b) ? b : a));
  expect(latest.toString()).toBe(REQUIRES_CRONPLANE);
});

describe("the versions of the contract", () => {
  test.each(ACCEPTED.map((c) => c.named()))("accepted: %s", (_name, c) => {
    expect(() => { check(minor(c.get("needs").text()), c.get("cronplane").text()); }).not.toThrow();
  });

  test.each(REFUSED.map((c) => c.named()))("refused: %s", (_name, c) => {
    const announced = c.get("cronplane").value;
    expect(() => { check(minor(c.get("needs").text()), typeof announced === "string" ? announced : undefined); }).toThrow(
      new VersionError(c.get("message").text()),
    );
  });

  test.each(MALFORMED)("%j is not a version", (value) => {
    expect(() => { check(minor("0.1"), value); }).toThrow(new VersionError(`CRONPLANE_VERSION: ${JSON.stringify(value)} is not a version of Cronplane`));
  });
});

test.each(["", "1", "1.2.3", "01.2", "a.b"])("%j is not a minor", (text) => {
  expect(Minor.parse(text)).toBeUndefined();
});

test("the action starts on the Cronplane it needs", () => {
  const step = new Step();
  step.env[VARIABLE] = `${REQUIRES_CRONPLANE}.0`;
  expect(step.action().inputs.values.size).toBe(0);
});

test("the action does not start on an older Cronplane", () => {
  const step = new Step();
  step.env[VARIABLE] = "0.0.9";
  expect(() => step.action()).toThrow(new VersionError("this action needs Cronplane 0.1 or newer: this is Cronplane 0.0.9"));
});

test("the action does not start when the worker does not say its version", () => {
  const step = new Step();
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the variable the test removes
  delete step.env[VARIABLE];
  expect(() => step.action()).toThrow(/the worker does not say its version/);
});
