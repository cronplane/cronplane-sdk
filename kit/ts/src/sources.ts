/** Where the packages of an action come from: the registry only. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { StepError } from "./errors.ts";

/** The packages of a `bun.lock` that do not come from the registry: name and where from. */
export function unregistered(lock: string): readonly (readonly [string, string])[] {
  let data: unknown;
  try {
    // bun.lock is JSON with trailing commas.
    data = JSON.parse(lock.replace(/,(\s*[}\]])/g, "$1"));
  } catch (e) {
    throw new StepError(`bun.lock: ${String(e)}`, { cause: e });
  }
  const packages: unknown = typeof data === "object" && data !== null ? new Map<string, unknown>(Object.entries(data)).get("packages") : undefined;
  if (typeof packages !== "object" || packages === null) {
    return [];
  }
  return Object.entries(packages).flatMap(([name, entry]: [string, unknown]) => {
    const first: unknown = Array.isArray(entry) ? entry[0] : undefined;
    if (typeof first !== "string") {
      return [];
    }
    // An entry starts with `<name>@`: what follows says where it comes from.
    const spec = first.startsWith(`${name}@`) ? first.slice(name.length + 1) : first;
    // A version: from the registry.
    return /^\d/.test(spec) ? [] : [[name, spec] as const];
  });
}

/** Fails if a package of the action does not come from the registry. */
export function checkSources(action: string): void {
  let lock: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file of the action checked
    lock = readFileSync(join(action, "bun.lock"), "utf8");
  } catch (e) {
    throw new StepError(`bun.lock: ${String(e)}`, { cause: e });
  }
  for (const [name, spec] of unregistered(lock)) {
    throw new StepError(`bun.lock: ${name} comes from ${spec}: take it from the registry`);
  }
}
