/** Runs the commands of the steps and says what failed. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Command } from "./steps.ts";

/** Longest a command may run (a test matrix included), in milliseconds. */
export const TIMEOUT = 30 * 60 * 1000;

export interface Outcome {
  readonly code: number;
  /** What the command printed (stdout and stderr), kept to show a failure. */
  readonly output: string;
}

export type Runner = (command: Command) => Outcome;

/** Runs a command with `environment` and the command's own variables. */
export function runner(environment: Readonly<Record<string, string | undefined>>, timeout = TIMEOUT): Runner {
  return (command) => {
    for (const [path, text] of command.writes ?? []) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- in the check's own directory
      mkdirSync(dirname(path), { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- in the check's own directory
      writeFileSync(path, text);
    }
    const [program = "", ...args] = command.argv;
    try {
      const done = Bun.spawnSync([program, ...args], {
        cwd: command.cwd,
        env: { ...environment, ...command.env },
        stdout: "pipe",
        stderr: "pipe",
        timeout,
      });
      if (done.exitedDueToTimeout === true) {
        return { code: 124, output: `no end within ${String(timeout / 1000)} s` };
      }
      return { code: done.exitCode, output: done.stdout.toString() + done.stderr.toString() };
    } catch (e) {
      return { code: 127, output: `${program}: not found (${String(e)})` };
    }
  };
}
