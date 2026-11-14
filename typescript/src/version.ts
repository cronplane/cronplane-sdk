/**
 * The version of Cronplane this library needs, and the check of the version
 * the worker announces (`contract/version/cases.json`).
 */

import { VersionError } from "./errors.ts";

/** The variable that carries the version of Cronplane running the step. */
export const VARIABLE = "CRONPLANE_VERSION";

const NEEDED = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
// What follows a `-` or a `+` is not read.
const ANNOUNCED = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:$|[-+])/;

/** A minor version of Cronplane: `0.1`. */
export class Minor {
  constructor(
    readonly major: number,
    readonly minor: number,
  ) {}

  /** `0.1`; `undefined` for anything else. */
  static parse(text: string): Minor | undefined {
    return Minor.from(NEEDED.exec(text));
  }

  /** The minor of a version of Cronplane (`0.1.4`, `0.2.0-rc.1`); `undefined` for anything else. */
  static of(version: string): Minor | undefined {
    return Minor.from(ANNOUNCED.exec(version));
  }

  private static from(found: RegExpExecArray | null): Minor | undefined {
    const [major, minor] = [found?.[1], found?.[2]];
    return major === undefined || minor === undefined ? undefined : new Minor(Number(major), Number(minor));
  }

  isBefore(other: Minor): boolean {
    return this.major < other.major || (this.major === other.major && this.minor < other.minor);
  }

  toString(): string {
    return `${String(this.major)}.${String(this.minor)}`;
  }
}

/** Throws a `VersionError` unless the Cronplane that runs the step is `needs` or a later minor of the same major. */
export function check(needs: Minor, announced: string | undefined): void {
  if (announced === undefined) {
    throw new VersionError(`this action needs Cronplane ${needs.toString()} or newer: the worker does not say its version (${VARIABLE})`);
  }
  const running = Minor.of(announced);
  if (running === undefined) {
    throw new VersionError(`${VARIABLE}: ${JSON.stringify(announced)} is not a version of Cronplane`);
  }
  if (running.major > needs.major) {
    throw new VersionError(`this action needs Cronplane ${String(needs.major)}.x, from ${needs.toString()}: this is Cronplane ${announced}`);
  }
  if (running.isBefore(needs)) {
    throw new VersionError(`this action needs Cronplane ${needs.toString()} or newer: this is Cronplane ${announced}`);
  }
}

/** The oldest Cronplane this library works with. */
export const REQUIRED = new Minor(0, 1);

/** The oldest Cronplane this library works with, as text: a major and a minor. */
export const REQUIRES_CRONPLANE = REQUIRED.toString();
