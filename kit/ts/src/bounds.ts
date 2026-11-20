/**
 * Every package the action depends on has an upper bound in `package.json`: a
 * new lock never takes a new major without the author changing the range.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { StepError } from "./errors.ts";

// A version, or an x-range that names its major (`1`, `1.2.x`, `=v1.2.3-rc.1`).
const PINNED = /^=?v?\d+(\.(\d+|[xX*]))?(\.(\d+|[xX*]))?([-+][\w.+-]*)?$/;
const OPEN = new Set(["", "*", "x", "X", "latest"]);

function bounded(alternative: string): boolean {
  const range = alternative.trim();
  if (OPEN.has(range)) {
    return false;
  }
  return range.startsWith("^") || range.startsWith("~") || range.includes("<") || range.includes(" - ") || PINNED.test(range);
}

/** `undefined` when `range` has an upper bound, else what to write instead. */
export function unbounded(range: string): string | undefined {
  if (range.split("||").every(bounded)) {
    return undefined;
  }
  const lower = /^>=?\s*v?(\d[\w.+-]*)$/.exec(range.trim())?.[1];
  return lower === undefined ? "^<version>" : `^${lower}`;
}

/** Fails naming each dependency of `package.json` without an upper bound. */
export function checkBounds(action: string): void {
  let data: unknown;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file of the action checked
    data = JSON.parse(readFileSync(join(action, "package.json"), "utf8"));
  } catch (e) {
    throw new StepError(`package.json: ${String(e)}`, { cause: e });
  }
  const dependencies: unknown = typeof data === "object" && data !== null ? new Map<string, unknown>(Object.entries(data)).get("dependencies") : undefined;
  if (dependencies === undefined) {
    return;
  }
  if (typeof dependencies !== "object" || dependencies === null) {
    throw new StepError("package.json: dependencies is an object");
  }
  const found = Object.entries(dependencies).flatMap(([name, range]: [string, unknown]) => {
    const fixed = typeof range === "string" ? unbounded(range) : "^<version>";
    return fixed === undefined ? [] : [`${name}@${String(range)} (write ${fixed})`];
  });
  if (found.length > 0) {
    throw new StepError(`package.json: a dependency without an upper bound lets a new lock take a new major: ${found.join("; ")}`);
  }
}
