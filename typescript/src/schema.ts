/**
 * The schema of a record (`schema` of a stream's `schema.json`): a subset
 * of JSON Schema, the same in every library for actions. A schema that uses
 * anything else is refused: a keyword is never ignored.
 */

import { SchemaError } from "./errors.ts";
import { isObject, type JsonValue } from "./json.ts";

/** The deepest schema accepted. */
export const MAX_DEPTH = 32;

/** The types a schema names, each with the values it holds. */
const TYPES: ReadonlyMap<string, (value: JsonValue) => boolean> = new Map([
  ["object", isObject],
  ["array", (value: JsonValue) => Array.isArray(value)],
  ["string", (value: JsonValue) => typeof value === "string"],
  ["integer", isInteger],
  ["number", (value: JsonValue) => typeof value === "number"],
  ["boolean", (value: JsonValue) => typeof value === "boolean"],
  ["null", (value: JsonValue) => value === null],
]);
/** The keywords checked. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "enum",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "format",
]);
/** Accepted and not checked. */
const ANNOTATIONS: ReadonlySet<string> = new Set(["$schema", "title", "description", "default", "examples"]);
// The optional groups hold no choice: the time is linear in the text.
const DATE_TIME =
  // eslint-disable-next-line security/detect-unsafe-regex
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:[Zz]|[+-]([0-9]{2}):([0-9]{2}))$/;
const DAYS: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const FEBRUARY = 2;

/**
 * What a record breaks: the place of the value in the record (a JSON
 * Pointer, `""` for the record itself) and the keyword it breaks.
 */
export class Problem {
  constructor(
    readonly at: string,
    readonly keyword: string,
  ) {}

  toString(): string {
    return `${this.at || "/"}: ${this.keyword}`;
  }
}

/** A schema, read once. */
interface Node {
  readonly types: ReadonlySet<string> | undefined;
  readonly properties: ReadonlyMap<string, Node>;
  readonly required: readonly string[];
  /** The schema of the properties not named; `false` refuses them. */
  readonly additional: Node | boolean;
  readonly items: Node | undefined;
  readonly minItems: number | undefined;
  readonly maxItems: number | undefined;
  readonly enum: readonly JsonValue[] | undefined;
  readonly minLength: number | undefined;
  readonly maxLength: number | undefined;
  readonly minimum: number | undefined;
  readonly maximum: number | undefined;
  readonly dateTime: boolean;
}

/** The keywords of one schema, by name. */
type Keywords = ReadonlyMap<string, JsonValue>;

function pointer(at: string, token: string): string {
  return `${at}/${token.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

/** A number without a fraction: `1.0` is one. */
function isInteger(value: JsonValue): boolean {
  return typeof value === "number" && Number.isInteger(value);
}

/** The length of `text` in Unicode code points. */
function codePoints(text: string): number {
  let count = 0;
  // A code point over U+FFFF takes two units of the string.
  for (let index = 0; index < text.length; index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1) {
    count += 1;
  }
  return count;
}

function isDateTime(text: string): boolean {
  const match = DATE_TIME.exec(text);
  if (match === null) {
    return false;
  }
  // A group that took no part in the match (the zone of `Z`) counts as 0.
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0, zoneHour = 0, zoneMinute = 0] = match
    .slice(1)
    .map((digits: string | undefined) => (digits === undefined ? 0 : Number(digits)));
  const days = DAYS.at(month - 1);
  if (month < 1 || days === undefined) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return (
    day >= 1 &&
    day <= days + (leap && month === FEBRUARY ? 1 : 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    zoneHour <= 23 &&
    zoneMinute <= 59
  );
}

/** A length or a number of items: an integer from 0. */
function count(keywords: Keywords, keyword: string, at: string): number | undefined {
  const value = keywords.get(keyword);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new SchemaError(at, keyword, "an integer from 0 is expected");
  }
  return value;
}

function bound(keywords: Keywords, keyword: string, at: string): number | undefined {
  const value = keywords.get(keyword);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number") {
    throw new SchemaError(at, keyword, "a number is expected");
  }
  return value;
}

function types(keywords: Keywords, at: string): ReadonlySet<string> | undefined {
  const value = keywords.get("type");
  if (value === undefined) {
    return undefined;
  }
  const found = new Set<string>();
  for (const name of Array.isArray(value) ? value : [value]) {
    if (typeof name !== "string" || !TYPES.has(name) || found.has(name)) {
      throw new SchemaError(at, "type", `one of ${[...TYPES.keys()].sort().join(", ")}, each once, is expected`);
    }
    found.add(name);
  }
  if (found.size === 0) {
    throw new SchemaError(at, "type", "one type at least is expected");
  }
  return found;
}

function required(keywords: Keywords, at: string): readonly string[] {
  const value = keywords.get("required");
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new SchemaError(at, "required", "a list of property names is expected");
  }
  const names: string[] = [];
  for (const name of value) {
    if (typeof name !== "string" || names.includes(name)) {
      throw new SchemaError(at, "required", "property names, each once, are expected");
    }
    names.push(name);
  }
  return names;
}

function allowed(keywords: Keywords, at: string): readonly JsonValue[] | undefined {
  const value = keywords.get("enum");
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new SchemaError(at, "enum", "a list of one value at least is expected");
  }
  if (value.some((item) => typeof item === "object" && item !== null)) {
    throw new SchemaError(at, "enum", "strings, numbers, booleans or null are expected");
  }
  return value;
}

function properties(keywords: Keywords, at: string, depth: number): ReadonlyMap<string, Node> {
  const declared = keywords.get("properties");
  if (declared === undefined) {
    return new Map();
  }
  if (!isObject(declared)) {
    throw new SchemaError(at, "properties", "an object of schemas is expected");
  }
  return new Map(
    Object.entries(declared).map(([name, sub]) => [name, node(sub, pointer(`${at}/properties`, name), depth + 1)]),
  );
}

function additional(keywords: Keywords, at: string, depth: number): Node | boolean {
  const other = keywords.get("additionalProperties") ?? true;
  if (typeof other === "boolean") {
    return other;
  }
  if (isObject(other)) {
    return node(other, `${at}/additionalProperties`, depth + 1);
  }
  throw new SchemaError(at, "additionalProperties", "a boolean or a schema is expected");
}

function items(keywords: Keywords, at: string, depth: number): Node | undefined {
  const value = keywords.get("items");
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new SchemaError(at, "items", "one schema is expected");
  }
  return node(value, `${at}/items`, depth + 1);
}

function node(schema: JsonValue, at: string, depth: number): Node {
  if (!isObject(schema)) {
    throw new SchemaError(at, "", "a schema is an object");
  }
  if (depth > MAX_DEPTH) {
    throw new SchemaError(at, "", `a schema is nested ${String(MAX_DEPTH)} levels deep at most`);
  }
  const keywords: Keywords = new Map(Object.entries(schema));
  for (const keyword of keywords.keys()) {
    if (!KEYWORDS.has(keyword) && !ANNOTATIONS.has(keyword)) {
      throw new SchemaError(at, keyword, "this keyword is not one the libraries for actions read");
    }
  }
  const format = keywords.get("format");
  if (format !== undefined && format !== "date-time") {
    throw new SchemaError(at, "format", "date-time is the only format read");
  }
  return {
    types: types(keywords, at),
    properties: properties(keywords, at, depth),
    required: required(keywords, at),
    additional: additional(keywords, at, depth),
    items: items(keywords, at, depth),
    minItems: count(keywords, "minItems", at),
    maxItems: count(keywords, "maxItems", at),
    enum: allowed(keywords, at),
    minLength: count(keywords, "minLength", at),
    maxLength: count(keywords, "maxLength", at),
    minimum: bound(keywords, "minimum", at),
    maximum: bound(keywords, "maximum", at),
    dateTime: format !== undefined,
  };
}

function checkObject(schema: Node, value: Readonly<Record<string, JsonValue>>, at: string, found: Problem[]): void {
  for (const name of schema.required) {
    if (!Object.hasOwn(value, name)) {
      found.push(new Problem(pointer(at, name), "required"));
    }
  }
  for (const [name, item] of Object.entries(value)) {
    const place = pointer(at, name);
    const declared = schema.properties.get(name);
    if (declared !== undefined) {
      check(declared, item, place, found);
    } else if (schema.additional === false) {
      found.push(new Problem(place, "additionalProperties"));
    } else if (schema.additional !== true) {
      check(schema.additional, item, place, found);
    }
  }
}

function checkArray(schema: Node, value: readonly JsonValue[], at: string, found: Problem[]): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    found.push(new Problem(at, "minItems"));
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    found.push(new Problem(at, "maxItems"));
  }
  const each = schema.items;
  if (each !== undefined) {
    value.forEach((item, index) => {
      check(each, item, `${at}/${String(index)}`, found);
    });
  }
}

function checkString(schema: Node, value: string, at: string, found: Problem[]): void {
  if (schema.minLength !== undefined || schema.maxLength !== undefined) {
    const length = codePoints(value);
    if (schema.minLength !== undefined && length < schema.minLength) {
      found.push(new Problem(at, "minLength"));
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      found.push(new Problem(at, "maxLength"));
    }
  }
  if (schema.dateTime && !isDateTime(value)) {
    found.push(new Problem(at, "format"));
  }
}

function check(schema: Node, value: JsonValue, at: string, found: Problem[]): void {
  if (schema.types !== undefined && ![...schema.types].some((name) => TYPES.get(name)?.(value) === true)) {
    found.push(new Problem(at, "type"));
  }
  // `===` compares two scalars as JSON does: 1 is 1.0, true is not 1.
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    found.push(new Problem(at, "enum"));
  }
  if (isObject(value)) {
    checkObject(schema, value, at, found);
  } else if (Array.isArray(value)) {
    checkArray(schema, value, at, found);
  } else if (typeof value === "string") {
    checkString(schema, value, at, found);
  } else if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      found.push(new Problem(at, "minimum"));
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      found.push(new Problem(at, "maximum"));
    }
  }
}

/** The schema of the records of a stream, read once and checked. */
export class RecordSchema {
  private constructor(
    /** As `schema.json` holds it. */
    readonly source: Readonly<Record<string, JsonValue>>,
    private readonly root: Node,
  ) {}

  /** Reads `schema`; `SchemaError` when it is not one the libraries read. */
  static parse(schema: JsonValue): RecordSchema {
    const root = node(schema, "", 1);
    if (!isObject(schema) || root.types?.size !== 1 || !root.types.has("object")) {
      throw new SchemaError("", "type", "the schema of a record has type: object");
    }
    return new RecordSchema(schema, root);
  }

  /** Every problem of `record`; none when it fits the schema. */
  problems(record: JsonValue): Problem[] {
    const found: Problem[] = [];
    check(this.root, record, "", found);
    return found;
  }
}
