/**
 * The plan of `cronplane test --plan --json`, version 1: the test flows of an
 * action and what they need. Read as data, never run.
 */

import { StepError } from "./errors.ts";

/** The only version of the plan this adapter reads. */
export const VERSION = 1;

/** The plan is not one this adapter reads. */
export class PlanError extends Error {
  override name = "PlanError";
}

/** What a test flow needs beside it. */
export const LEVELS = ["e2e", "integration"] as const;
export type Level = (typeof LEVELS)[number];

export interface Flow {
  readonly file: string;
  readonly level: Level;
  /** Its test values as written, by secret. */
  readonly secrets: readonly (readonly [string, string])[];
}

export interface Plan {
  /** The services its flows need, each once. */
  readonly services: readonly string[];
  readonly flows: readonly Flow[];
}

/** An action whose test flows are not read yet. */
export const NO_PLAN: Plan = { services: [], flows: [] };

export function parsePlan(text: string): Plan {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new PlanError(`not JSON: ${String(e)}`, { cause: e });
  }
  const fields = asObject(data);
  if (fields === undefined) {
    throw new PlanError("a JSON object is expected");
  }
  if (fields.get("version") !== VERSION) {
    throw new PlanError(`version ${JSON.stringify(fields.get("version"))}: this adapter reads version ${String(VERSION)}`);
  }
  const flows = asItems(fields.get("flows")).map((item): Flow => {
    const flow = asObject(item);
    const file = flow?.get("file");
    const level = LEVELS.find((known) => known === flow?.get("level"));
    if (typeof file !== "string" || level === undefined) {
      throw new PlanError(`a flow without a file or a level: ${JSON.stringify(item)}`);
    }
    const secrets = [...(asObject(flow?.get("secrets")) ?? new Map<string, unknown>())].flatMap(
      ([name, value]): (readonly [string, string])[] => (typeof value === "string" ? [[name, value]] : []),
    );
    return { file, level, secrets };
  });
  const services = asItems(fields.get("services")).filter((service) => typeof service === "string");
  return { services, flows };
}

/** The flows of `plan` of one level. */
export function flowsOf(plan: Plan, level: Level): readonly Flow[] {
  return plan.flows.filter((flow) => flow.level === level);
}

/**
 * The test values of the `integration` flows of `plan`, for the tests of the
 * language: each secret in uppercase. The address of a double is not known
 * before its flow runs: such a value is left out. Two values for one name
 * are an error.
 */
export function variables(plan: Plan): Record<string, string> {
  const values = new Map<string, string>();
  for (const flow of flowsOf(plan, "integration")) {
    for (const [secret, value] of flow.secrets) {
      const name = secret.toUpperCase();
      if (value.includes("${doubles.")) {
        continue;
      }
      if ((values.get(name) ?? value) !== value) {
        throw new StepError(
          `${flow.file}: test.secrets.${secret} has another value in another integration flow: the tests of the language read one ${name}`,
        );
      }
      values.set(name, value);
    }
  }
  return Object.fromEntries(values);
}

function asObject(value: unknown): Map<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? new Map(Object.entries(value)) : undefined;
}

function asItems(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
