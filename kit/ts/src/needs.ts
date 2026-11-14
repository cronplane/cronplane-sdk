/**
 * Checks that an action says, in `requires.cronplane`, a Cronplane as new as
 * the one its library needs. It runs as a program, after the action's
 * packages are installed:
 *
 *     bun needs.ts <action> <the oldest Cronplane action.yaml names, or nothing>
 */

const LIBRARY = "@cronplane/actions";

/** The Cronplane the library installed in `action` needs (`0.1`); undefined when the action does not use the library. */
export async function needed(action: string): Promise<string | undefined> {
  let path: string;
  try {
    path = Bun.resolveSync(LIBRARY, action);
  } catch {
    return undefined;
  }
  const library: unknown = await import(path);
  const version: unknown = typeof library === "object" && library !== null ? new Map<string, unknown>(Object.entries(library)).get("REQUIRES_CRONPLANE") : undefined;
  return typeof version === "string" ? version : undefined;
}

/** `0.1` as numbers; undefined for anything else. */
function numbers(version: string): readonly number[] | undefined {
  const parts = version.split(".");
  return parts.every((part) => /^[0-9]+$/.test(part)) ? parts.map(Number) : undefined;
}

/** What is wrong with the Cronplane `action.yaml` names, if anything. */
export function problem(declared: string, needs: string | undefined): string | undefined {
  if (needs === undefined) {
    return undefined;
  }
  const advice = `write \`requires: {cronplane: ">=${needs}"}\``;
  if (declared === "") {
    return `action.yaml: requires.cronplane is missing: the library ${LIBRARY} needs Cronplane ${needs} or newer (${advice})`;
  }
  const [says, wants] = [numbers(declared), numbers(needs)];
  if (says === undefined || wants === undefined) {
    return `action.yaml: requires.cronplane: ${JSON.stringify(declared)} is not a version`;
  }
  const [major = 0, minor = 0] = says;
  const [neededMajor = 0, neededMinor = 0] = wants;
  if (major < neededMajor || (major === neededMajor && minor < neededMinor)) {
    return `action.yaml: requires.cronplane says >=${declared}: the library ${LIBRARY} needs Cronplane ${needs} or newer (${advice})`;
  }
  return undefined;
}

/** The program; the exit code it ends with. */
export async function main(argv: readonly string[], say: (line: string) => void): Promise<number> {
  const [action = ".", declared = ""] = argv;
  const found = problem(declared, await needed(action));
  if (found !== undefined) {
    say(found);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2), console.error));
}
