/** The files of a step: written whole, at once. */

import { renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Writes `data` to `file` through a temporary file of its directory, renamed
 * over it: a reader never sees half of it.
 */
export function replace(file: string, data: Uint8Array): void {
  const tmp = join(dirname(file), `.${basename(file)}.${String(process.pid)}.tmp`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- beside the path Cronplane gives
  writeFileSync(tmp, data, { flag: "wx" });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the path Cronplane gives
  renameSync(tmp, file);
}

/** Whether `e` is the error of a file that does not exist. */
export function isMissing(e: unknown): boolean {
  return e instanceof Error && "code" in e && e.code === "ENOENT";
}
