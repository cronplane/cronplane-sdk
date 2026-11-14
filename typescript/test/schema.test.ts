/**
 * The schema of a record: the cases every library for actions passes
 * (`contract/schema/cases.json`), and what this library adds to them.
 */

import { describe, expect, test } from "bun:test";

import { type JsonValue, type Problem, RecordSchema, SchemaError } from "../src/index.ts";
import { MAX_DEPTH } from "../src/schema.ts";
import { Case } from "./helpers.ts";

const CASES = Case.of("schema");
const SCHEMAS = CASES.get("schemas").list();
const REFUSED = CASES.get("refused").list();

/** A schema that uses each keyword and annotation this library reads, alone and well. */
const READ: Readonly<Record<string, JsonValue>> = {
  type: "string",
  properties: { a: {} },
  required: ["a"],
  additionalProperties: false,
  items: {},
  minItems: 0,
  maxItems: 1,
  enum: ["a", 1, true, null],
  minLength: 0,
  maxLength: 1,
  minimum: -1.5,
  maximum: 1.5,
  format: "date-time",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "A title",
  description: "A description",
  default: { any: ["value"] },
  examples: [1],
};

function places(problems: readonly Problem[]): string[] {
  return problems.map(({ at, keyword }) => `${keyword} at ${JSON.stringify(at)}`).sort();
}

function refusal(schema: JsonValue): SchemaError {
  try {
    RecordSchema.parse(schema);
  } catch (e) {
    if (e instanceof SchemaError) {
      return e;
    }
  }
  throw new Error(`the schema is not refused with a SchemaError: ${JSON.stringify(schema)}`);
}

/** A record whose property `a` has `schema`. */
function holding(schema: JsonValue): JsonValue {
  return { type: "object", properties: { a: schema } };
}

function nested(levels: number): JsonValue {
  let schema: JsonValue = { type: "string" };
  for (let level = 1; level < levels; level++) {
    schema = holding(schema);
  }
  return schema;
}

test("the cases are those of the version this library reads", () => {
  expect(CASES.get("version").value).toBe(1);
  expect(CASES.get("limits").get("depth").value).toBe(MAX_DEPTH);
  expect(SCHEMAS.length).toBeGreaterThan(0);
  expect(REFUSED.length).toBeGreaterThan(0);
});

describe("the schemas of the contract", () => {
  test.each(SCHEMAS.map((c) => c.named()))("%s: a record that fits has no problem", (_name, c) => {
    const schema = RecordSchema.parse(c.get("schema").value);
    const valid = c.get("valid").list();
    expect(valid.length).toBeGreaterThan(0);
    for (const record of valid) {
      expect([JSON.stringify(record.value), places(schema.problems(record.value))]).toEqual([JSON.stringify(record.value), []]);
    }
  });

  test.each(SCHEMAS.map((c) => c.named()))("%s: a record that does not fit lists every problem at its place", (_name, c) => {
    const schema = RecordSchema.parse(c.get("schema").value);
    const invalid = c.get("invalid").list();
    expect(invalid.length).toBeGreaterThan(0);
    for (const entry of invalid) {
      const record = entry.get("record").value;
      const expected = entry.get("problems").list().map((p) => `${p.get("keyword").text()} at ${JSON.stringify(p.get("at").text())}`);
      expect([JSON.stringify(record), places(schema.problems(record))]).toEqual([JSON.stringify(record), expected.sort()]);
    }
  });

  test.each(REFUSED.map((c) => c.named()))("%s: the schema is refused at its place", (_name, c) => {
    const refused = refusal(c.get("schema").value);
    expect([refused.at, refused.keyword]).toEqual([c.get("at").text(), c.get("keyword").text()]);
  });
});

test("every keyword of the contract is read, and no other", () => {
  const contract = [
    ...CASES.get("keywords").entries().map(([keyword]) => keyword),
    ...CASES.get("annotations").list().map((name) => name.text()),
  ];
  expect(Object.keys(READ).sort()).toEqual(contract.sort());
  for (const [keyword, value] of Object.entries(READ)) {
    const schema = holding(Object.fromEntries([[keyword, value]]));
    expect<JsonValue>([keyword, RecordSchema.parse(schema).source]).toEqual([keyword, schema]);
  }
  const unknown = refusal({ type: "object", "x-unknown": 1 });
  expect([unknown.at, unknown.keyword]).toEqual(["", "x-unknown"]);
  expect(unknown.message).toBe("schema /: x-unknown: this keyword is not one the libraries for actions read");
  expect(refusal(holding({ pattern: "x" })).message).toBe(
    "schema /properties/a: pattern: this keyword is not one the libraries for actions read",
  );
});

test("a schema is nested within the depth of the contract", () => {
  expect(RecordSchema.parse(nested(MAX_DEPTH)).problems({})).toEqual([]);
  const refused = refusal(nested(MAX_DEPTH + 1));
  expect([refused.keyword, refused.at]).toEqual(["", "/properties/a".repeat(MAX_DEPTH)]);
  expect(refused.message).toContain("nested 32 levels deep at most");
});

test("a refusal says what is expected", () => {
  const messages: [JsonValue, string][] = [
    [[], "schema /: a schema is an object"],
    [{ type: "object", properties: { a: { type: "text" } } }, "schema /properties/a: type: one of array, boolean, integer, null, number, object, string, each once, is expected"],
    [{ type: "object", properties: { "a/b~c": { type: [] } } }, "schema /properties/a~1b~0c: type: one type at least is expected"],
    [{ type: "object", required: "id" }, "schema /: required: a list of property names is expected"],
    [{ type: "object", required: ["id", "id"] }, "schema /: required: property names, each once, are expected"],
    [{ type: "object", properties: [] }, "schema /: properties: an object of schemas is expected"],
    [{ type: "object", additionalProperties: 1 }, "schema /: additionalProperties: a boolean or a schema is expected"],
    [holding({ items: [] }), "schema /properties/a: items: one schema is expected"],
    [holding({ items: { minItems: -1 } }), "schema /properties/a/items: minItems: an integer from 0 is expected"],
    [holding({ maxLength: 1.5 }), "schema /properties/a: maxLength: an integer from 0 is expected"],
    [holding({ minimum: "1" }), "schema /properties/a: minimum: a number is expected"],
    [holding({ enum: [] }), "schema /properties/a: enum: a list of one value at least is expected"],
    [holding({ enum: [[1]] }), "schema /properties/a: enum: strings, numbers, booleans or null are expected"],
    [holding({ format: "date" }), "schema /properties/a: format: date-time is the only format read"],
    [{ type: "array" }, "schema /: type: the schema of a record has type: object"],
  ];
  for (const [schema, message] of messages) {
    expect(refusal(schema).message).toBe(message);
  }
});

test("a problem reads as its place and its keyword", () => {
  const schema = RecordSchema.parse({ type: "object", required: ["id"] });
  expect(schema.problems({}).map(String)).toEqual(["/id: required"]);
  expect(schema.problems([]).map(String)).toEqual(["/: type"]);
  expect(schema.source).toEqual({ type: "object", required: ["id"] });
});

test("the problems of a record come in its order: the properties missing, then each property it holds", () => {
  const schema = RecordSchema.parse({
    type: "object",
    properties: { id: { type: "integer" }, email: { type: "string", minLength: 3 }, tags: { type: "array", items: { type: "string" } } },
    required: ["id", "email"],
    additionalProperties: false,
  });
  expect(schema.problems({ tags: ["a", 1], other: 1, email: "x" }).map(String)).toEqual([
    "/id: required",
    "/tags/1: type",
    "/other: additionalProperties",
    "/email: minLength",
  ]);
});
