import { expect, test } from "bun:test";

import { greeting } from "./greeting.ts";

test("greeting", () => {
  expect(greeting("Ada", false)).toBe("hello Ada");
  expect(greeting("Ada", true)).toBe("HELLO ADA");
});
