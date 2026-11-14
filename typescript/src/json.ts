/** JSON values, typed: what `JSON.parse` returns, checked once. */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** The JSON value of `text`; a `SyntaxError` when it is not JSON. */
export function parse(text: string): JsonValue {
  // JSON.parse builds only JSON values: the check never fails here.
  return checked(JSON.parse(text));
}

/** `value` as a JSON value; a `TypeError` when it holds anything else. */
export function checked(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`not a JSON number: ${String(value)}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => checked(item));
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    // fromEntries defines own properties: a "__proto__" key stays data.
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, checked(item)]));
  }
  throw new TypeError(`not a JSON value: ${typeof value}`);
}

/** Whether `value` is a JSON object (not an array, not null). */
export function isObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
