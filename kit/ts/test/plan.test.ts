import { expect, test } from "bun:test";

import { StepError } from "../src/errors.ts";
import { flowsOf, NO_PLAN, parsePlan, PlanError, variables } from "../src/plan.ts";
import { plan } from "./helpers.ts";

test("the plan gives the flows of each level and their services", () => {
  const read = parsePlan(plan([["read.yaml", "e2e"], ["write.yaml", "integration"]], ["postgres"]));
  expect(read.services).toEqual(["postgres"]);
  expect(flowsOf(read, "e2e")).toEqual([{ file: "tests/flows/read.yaml", level: "e2e", secrets: [] }]);
  expect(flowsOf(read, "integration").map((flow) => flow.file)).toEqual(["tests/flows/write.yaml"]);
  expect(NO_PLAN).toEqual({ services: [], flows: [] });
});

test.each([
  ["not json", /not JSON/],
  ["[]", /a JSON object is expected/],
  [JSON.stringify({ version: 2 }), /version 2: this adapter reads version 1/],
  [JSON.stringify({ version: 1, flows: [{ file: "a.yaml", level: "unit" }] }), /a flow without a file or a level/],
  [JSON.stringify({ version: 1, flows: [{ level: "e2e" }] }), /a flow without a file or a level/],
  [JSON.stringify({ version: 1, flows: [3] }), /a flow without a file or a level/],
])("a plan of another shape is refused", (text, why) => {
  expect(() => parsePlan(text)).toThrow(PlanError);
  expect(() => parsePlan(text)).toThrow(why);
});

test("what is not text in the services is left out", () => {
  expect(parsePlan(JSON.stringify({ version: 1, services: ["postgres", 7] }))).toEqual({ services: ["postgres"], flows: [] });
});

test("the test values of the integration flows go to the tests of the language", () => {
  const write: readonly [string, string, Record<string, string>] = [
    "write.yaml",
    "integration",
    { postgres_url: "postgresql://x", api: "${doubles.api.url}/v1" },
  ];
  const read = parsePlan(plan([["read.yaml", "e2e", { token: "unused" }], write, ["same.yaml", "integration", { postgres_url: "postgresql://x" }]]));
  expect(variables(read)).toEqual({ POSTGRES_URL: "postgresql://x" });
  expect(variables(NO_PLAN)).toEqual({});
  const other = parsePlan(plan([write, ["other.yaml", "integration", { postgres_url: "postgresql://y" }]]));
  expect(() => variables(other)).toThrow(StepError);
  expect(() => variables(other)).toThrow(/other\.yaml: test\.secrets\.postgres_url has another value/);
  expect(parsePlan(JSON.stringify({ version: 1, flows: [{ file: "a.yaml", level: "e2e", secrets: { a: "x", b: 1 } }] })).flows[0]?.secrets).toEqual([["a", "x"]]);
});
