/**
 * The step's side of the contract with Cronplane: what a step using an
 * action gets (its inputs, secrets, the outputs of the steps it needs) and
 * what it gives back (its output, the values to mask).
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ActionError, InputError, OutputError, SecretError, StateError } from "./errors.ts";
import { isMissing, replace } from "./files.ts";
import { type Address, checkPublic, Egress, HttpClient, parseEgress, type Resolve, systemResolve } from "./http.ts";
import { isObject, type JsonValue, parse } from "./json.ts";
import { AllowedHosts } from "./network.ts";
import { State } from "./state.ts";
import { Streams } from "./streams.ts";
import { check, REQUIRED, VARIABLE } from "./version.ts";

/** An item of a `list` input, a value of a `map` input. */
export type Scalar = string | number | boolean;

/** The largest output Cronplane accepts. */
export const MAX_OUTPUT_BYTES = 1 << 20;

/** The environment the step gets. */
export type Environment = Readonly<Record<string, string | undefined>>;

// The names of variables, and of the files of `$CRONPLANE_SECRETS`.
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The values of the action's inputs, typed as `action.yaml` declares them. */
export class Inputs {
  constructor(readonly values: ReadonlyMap<string, JsonValue>) {}

  /** The step gives the input (an optional input without default may be missing). */
  has(name: string): boolean {
    return this.values.has(name);
  }

  /** A `string` or `enum` input. */
  string(name: string): string {
    const value = this.value(name);
    if (typeof value !== "string") {
      throw new InputError(`input ${name}: a string is expected, not ${kind(value)}`);
    }
    return value;
  }

  integer(name: string): number {
    const value = this.value(name);
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new InputError(`input ${name}: an integer is expected, not ${kind(value)}`);
    }
    return value;
  }

  boolean(name: string): boolean {
    const value = this.value(name);
    if (typeof value !== "boolean") {
      throw new InputError(`input ${name}: a boolean is expected, not ${kind(value)}`);
    }
    return value;
  }

  /** A `list` input: its items. */
  items(name: string): Scalar[] {
    const value = this.value(name);
    if (!Array.isArray(value)) {
      throw new InputError(`input ${name}: a list is expected, not ${kind(value)}`);
    }
    return value.map((item) => scalar(name, item));
  }

  /** A `map` input: its entries. */
  entries(name: string): Map<string, Scalar> {
    const value = this.value(name);
    if (!isObject(value)) {
      throw new InputError(`input ${name}: a map is expected, not ${kind(value)}`);
    }
    return new Map(Object.entries(value).map(([key, item]) => [key, scalar(name, item)]));
  }

  private value(name: string): JsonValue {
    const value = this.values.get(name);
    if (value === undefined) {
      throw new InputError(`input ${name}: not given to the step`);
    }
    return value;
  }
}

/**
 * The output of the step: each `set` writes the whole JSON object again, at
 * once, so the step never leaves half of it.
 */
export class Outputs {
  private values = new Map<string, JsonValue>();

  constructor(readonly path: string) {}

  set(name: string, value: JsonValue): void {
    const values = new Map(this.values).set(name, value);
    let text: string;
    try {
      text = JSON.stringify(Object.fromEntries(values), (_key, item: unknown) => {
        if (typeof item === "number" && !Number.isFinite(item)) {
          throw new TypeError(`not a JSON number: ${String(item)}`);
        }
        return item;
      });
    } catch (e) {
      throw new OutputError(`output ${name}: not a JSON value: ${String(e)}`, { cause: e });
    }
    const data = new TextEncoder().encode(text);
    if (data.length > MAX_OUTPUT_BYTES) {
      throw new OutputError(
        `output ${name}: the output would exceed ${String(MAX_OUTPUT_BYTES)} bytes: pass large data through files ($CRONPLANE_FILES), not outputs`,
      );
    }
    try {
      replace(this.path, data);
    } catch (e) {
      throw new OutputError(`${this.path}: cannot be written: ${String(e)}`, { cause: e });
    }
    this.values = values;
  }
}

/**
 * What the step may reach, for the connections the HTTP client does not
 * make (a database): the hosts of `network.allow`, and public addresses only
 * on a worker that runs the steps of several customers.
 */
export class Network {
  constructor(
    readonly egress: Egress,
    /** The only hosts the step reaches; undefined: any host. */
    readonly allowed: AllowedHosts | undefined,
    private readonly resolver: Resolve = systemResolve,
  ) {}

  /**
   * The addresses of `host` the step may connect to on `port`, each checked:
   * connect to one of them, not to the name again (a second resolution could
   * give another address). `EgressError` when the host is out of the list,
   * or an address is not public where it must be.
   */
  async resolve(host: string, port: number): Promise<readonly Address[]> {
    this.allowed?.check(host, port);
    const addresses = await this.resolver(host);
    if (this.egress === Egress.Public) {
      checkPublic(host, addresses);
    }
    return addresses;
  }
}

/** What Cronplane gives the step running the action, read once when it starts. */
export class Action {
  private constructor(
    readonly inputs: Inputs,
    readonly outputs: Outputs,
    readonly http: HttpClient,
    readonly network: Network,
    private readonly environment: ReadonlyMap<string, string>,
  ) {}

  /**
   * The action of this step; an `ActionError` when Cronplane does not run it as an
   * action, a `VersionError` when that Cronplane is older than the library needs.
   */
  static fromEnvironment(environment: Environment = process.env): Action {
    const env = new Map(
      Object.entries(environment).flatMap(([name, value]) => (value === undefined ? [] : [[name, value] as const])),
    );
    check(REQUIRED, env.get(VARIABLE));
    const values = readObject(path(env, "CRONPLANE_WITH"), "the values of the inputs");
    path(env, "CRONPLANE_MASK");
    const egress = parseEgress(env.get("CRONPLANE_EGRESS"));
    const allowed = AllowedHosts.parse(env.get("CRONPLANE_NETWORK_ALLOW"));
    return new Action(
      new Inputs(new Map(Object.entries(values))),
      new Outputs(path(env, "CRONPLANE_OUTPUT")),
      new HttpClient(egress, { allowed }),
      new Network(egress, allowed),
      env,
    );
  }

  /** The streams of records the step produces and consumes. */
  get streams(): Streams {
    return new Streams(
      given(this.environment, "CRONPLANE_FILES"),
      given(this.environment, "CRONPLANE_NEEDED_FILES"),
      this.environment.get("CRONPLANE_STEP_ID") ?? "",
    );
  }

  /** Where the step starts again; the action needs `state: true`. */
  get state(): State {
    const out = given(this.environment, "CRONPLANE_STATE_OUT");
    if (out === undefined) {
      throw new StateError("the state is not kept: the action needs `state: true`");
    }
    return new State(given(this.environment, "CRONPLANE_STATE"), out);
  }

  /**
   * A secret of the action: its variable, or its file in `$CRONPLANE_SECRETS`
   * (`delivery: file`). Cronplane already masks it in what the step prints.
   */
  secret(name: string): string {
    if (!SECRET_NAME.test(name)) {
      throw new SecretError(`${JSON.stringify(name)}: not the name of a secret`);
    }
    const variable = this.environment.get(name);
    if (variable !== undefined) {
      return variable;
    }
    const directory = this.environment.get("CRONPLANE_SECRETS");
    if (directory !== undefined) {
      try {
        // The name is checked above: a plain file name in the directory.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        return readFileSync(join(directory, name), "utf8");
      } catch (e) {
        if (!isMissing(e)) {
          throw new SecretError(`secret ${name}: cannot be read: ${String(e)}`, { cause: e });
        }
      }
    }
    throw new SecretError(`secret ${name}: not given to the step (is it in the action's secrets?)`);
  }

  /**
   * Hides `value` in the step's log, error and output: in the live view from
   * the next line the step prints, everywhere in the final log. Call it
   * before the value can be printed. Values shorter than 3 characters, and
   * encoded forms of a value (base64, URL), are not masked.
   */
  mask(value: string): void {
    if (value.trim() === "") {
      return;
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the path Cronplane gives
    appendFileSync(path(this.environment, "CRONPLANE_MASK"), `${value}\n`);
  }

  /** The outputs of the steps this step needs, by step id. */
  needed(): Record<string, JsonValue> {
    return readObject(path(this.environment, "CRONPLANE_INPUTS"), "the outputs of the needed steps");
  }

  /** What started the run; the action needs `needs_trigger: true`. */
  trigger(): Record<string, JsonValue> {
    if (!this.environment.has("CRONPLANE_TRIGGER")) {
      throw new ActionError("the trigger is not given: the action needs `needs_trigger: true`");
    }
    return readObject(path(this.environment, "CRONPLANE_TRIGGER"), "the trigger");
  }
}

/** The value of `variable`; undefined when it is not set, or empty. */
function given(env: ReadonlyMap<string, string>, variable: string): string | undefined {
  const value = env.get(variable);
  return value === "" ? undefined : value;
}

function path(env: ReadonlyMap<string, string>, variable: string): string {
  const value = given(env, variable);
  if (value === undefined) {
    throw new ActionError(`${variable} is not set: is this step run by Cronplane, as an action?`);
  }
  return value;
}

function readObject(file: string, what: string): Record<string, JsonValue> {
  let value: JsonValue;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path Cronplane gives
    value = parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ActionError(`${file}: ${what} cannot be read: ${String(e)}`, { cause: e });
  }
  if (!isObject(value)) {
    throw new ActionError(`${file}: a JSON object is expected`);
  }
  return value;
}

function scalar(name: string, value: JsonValue): Scalar {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  throw new InputError(`input ${name}: an item is a string, an integer or a boolean, not ${kind(value)}`);
}

function kind(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "a list";
  }
  switch (typeof value) {
    case "boolean":
      return "a boolean";
    case "number":
      return Number.isInteger(value) ? "an integer" : "a number";
    case "string":
      return "a string";
    default:
      return "a map";
  }
}
