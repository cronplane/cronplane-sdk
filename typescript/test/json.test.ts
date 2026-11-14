/** JSON values, checked once. */

import { expect, test } from "bun:test";

import { checked, parse } from "../src/json.ts";

test("only JSON values pass", () => {
  expect(parse('{"a": [1, 2.5, true, null, "x"]}')).toEqual({ a: [1, 2.5, true, null, "x"] });
  expect(() => checked(Number.POSITIVE_INFINITY)).toThrow(new TypeError("not a JSON number: Infinity"));
  expect(() => checked([new Date(0)])).toThrow(new TypeError("not a JSON value: object"));
  expect(() => checked({ f: () => 1 })).toThrow(new TypeError("not a JSON value: function"));
});
