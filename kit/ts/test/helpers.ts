/** A TypeScript action as an author writes it, and the report of `validate`. */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KIT } from "../src/cli.ts";
import type { Context } from "../src/steps.ts";

export function report(options: { ok?: boolean; runtime?: string; versions?: readonly string[]; requiresCronplane?: string } = {}): string {
  const { ok = true, runtime = "typescript", versions = ["1.4"], requiresCronplane = null } = options;
  return JSON.stringify({
    version: 1,
    action: { name: "demo", runtime, requires_cronplane: requiresCronplane },
    matrix: versions.map((version) => ({ runtime, version })),
    inputs: [],
    ok,
    problems: ok ? [] : [{ rule: "readme", at: "README.md", message: "no README" }],
  });
}

/** An action folder with its package files and a coverage threshold. */
export function action(): string {
  const folder = join(mkdtempSync(join(tmpdir(), "kit-")), "demo");
  mkdirSync(folder);
  writeFileSync(join(folder, "package.json"), '{"name": "demo"}');
  writeFileSync(join(folder, "bun.lock"), '{\n  "lockfileVersion": 1,\n  "packages": {},\n}\n');
  writeFileSync(join(folder, "bunfig.toml"), "[test]\ncoverageThreshold = { lines = 0.9 }\n");
  return folder;
}

export function context(folder: string, versions: readonly string[] = ["1.3", "1.4"]): Context {
  return { action: folder, cronplane: "/bin/cronplane", kit: KIT, work: join(folder, "..", "work"), versions };
}
