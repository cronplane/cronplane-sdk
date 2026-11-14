/**
 * Where the step starts again (`state: true` of the action): one JSON value
 * Cronplane keeps between runs, when the whole run succeeds. A cursor, a
 * last key: never data.
 */

import { existsSync, readFileSync } from "node:fs";

import { StateError } from "./errors.ts";
import { replace } from "./files.ts";
import { checked, isObject, type JsonValue, parse } from "./json.ts";

/** The largest state Cronplane keeps. */
export const MAX_STATE_BYTES = 32 * 1024;

/** The version of the object the library proposes: one entry per stream. */
const VERSION = 1;

/** The state kept for the step, and the one it writes for its next run. */
export class State {
  constructor(
    /** `$CRONPLANE_STATE`; none at the first run, or after a reset. */
    readonly kept: string | undefined,
    /** `$CRONPLANE_STATE_OUT`. */
    readonly out: string,
  ) {}

  /** The state the last successful run kept; `null` when there is none. */
  get(): JsonValue {
    return this.kept === undefined ? null : read(this.kept);
  }

  /**
   * Writes the state of the next run, whole. Cronplane keeps it only if the
   * whole run succeeds. `StateError` over 32 KiB.
   */
  set(value: JsonValue): void {
    let text: string;
    try {
      text = JSON.stringify(checked(value));
    } catch (e) {
      throw new StateError(`the state is not a JSON value: ${String(e)}`, { cause: e });
    }
    const data = new TextEncoder().encode(text);
    if (data.length > MAX_STATE_BYTES) {
      throw new StateError(
        `the state is ${String(data.length)} bytes, more than ${String(MAX_STATE_BYTES)}: keep where to start again, never data`,
      );
    }
    try {
      replace(this.out, data);
    } catch (e) {
      throw new StateError(`${this.out}: cannot be written: ${String(e)}`, { cause: e });
    }
  }

  /**
   * Where the stream `name` starts again, as the last successful run left
   * it; empty when it kept nothing for it.
   */
  stream(name: string): Record<string, JsonValue> {
    const entry = streams(this.get()).get(name);
    return entry !== undefined && isObject(entry) ? { ...entry } : {};
  }

  /**
   * Writes where the stream `name` starts again at the next run; the other
   * streams keep what this run wrote for them, else what it read.
   */
  setStream(name: string, value: Readonly<Record<string, JsonValue>>): void {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the path Cronplane gives
    const current = existsSync(this.out) ? read(this.out) : this.get();
    const entries = new Map(streams(current)).set(name, { ...value });
    // fromEntries defines own properties: a stream named "__proto__" stays data.
    this.set({ version: VERSION, streams: Object.fromEntries(entries) });
  }
}

function read(path: string): JsonValue {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path Cronplane gives
    return parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new StateError(`${path}: the state cannot be read: ${String(e)}`, { cause: e });
  }
}

/** The entries per stream of a state the library wrote; none in no state. */
function streams(state: JsonValue): ReadonlyMap<string, JsonValue> {
  if (state === null) {
    return new Map();
  }
  if (!isObject(state) || state["version"] !== VERSION) {
    throw new StateError(
      'the state is not one of this library ({"version": 1, "streams": {...}}): read it with get(), write it with set()',
    );
  }
  const entries = state["streams"];
  if (entries === undefined || !isObject(entries)) {
    throw new StateError('the state has no "streams" object');
  }
  return new Map(Object.entries(entries));
}
