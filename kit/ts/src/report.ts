/** The report of `cronplane action validate --hub --json`, version 1: read as data, never run. */

/** The only version of the report this adapter reads. */
export const VERSION = 1;

/** The report is not one this adapter reads. */
export class ReportError extends Error {
  override name = "ReportError";
}

export interface Problem {
  readonly rule: string;
  readonly at: string;
  readonly message: string;
}

export function describe(problem: Problem): string {
  return `${problem.at}: ${problem.message} (${problem.rule})`;
}

export interface Report {
  /** The action's name and runtime; undefined when `action.yaml` is invalid. */
  readonly name: string | undefined;
  readonly runtime: string | undefined;
  /** The versions to test, for the action's runtime. */
  readonly versions: readonly string[];
  readonly ok: boolean;
  readonly problems: readonly Problem[];
  /** The oldest Cronplane the action says it runs on (`0.1`), if it says one. */
  readonly requiresCronplane: string | undefined;
}

export function parseReport(text: string): Report {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new ReportError(`not JSON: ${String(e)}`, { cause: e });
  }
  const fields = asObject(data);
  if (fields === undefined) {
    throw new ReportError("a JSON object is expected");
  }
  if (fields.get("version") !== VERSION) {
    throw new ReportError(`version ${JSON.stringify(fields.get("version"))}: this adapter reads version ${String(VERSION)}`);
  }
  const action = asObject(fields.get("action")) ?? new Map<string, unknown>();
  return {
    name: asText(action.get("name")),
    runtime: asText(action.get("runtime")),
    versions: asItems(fields.get("matrix")).flatMap((entry) => {
      const version = asText(asObject(entry)?.get("version"));
      return version === undefined ? [] : [version];
    }),
    ok: fields.get("ok") === true,
    requiresCronplane: asText(action.get("requires_cronplane")),
    problems: asItems(fields.get("problems")).flatMap((item) => {
      const problem = asObject(item);
      return problem === undefined
        ? []
        : [{ rule: asText(problem.get("rule")) ?? "", at: asText(problem.get("at")) ?? "", message: asText(problem.get("message")) ?? "" }];
    }),
  };
}

function asObject(value: unknown): Map<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? new Map(Object.entries(value)) : undefined;
}

function asItems(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
