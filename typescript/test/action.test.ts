/** Inputs, outputs, secrets and masked values: the contract with Cronplane. */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  Action,
  ActionError,
  Egress,
  InputError,
  type JsonValue,
  MAX_OUTPUT_BYTES,
  OutputError,
  SecretError,
} from "../src/index.ts";
import { Step } from "./helpers.ts";

describe("inputs", () => {
  test("read with the type action.yaml declares", () => {
    const inputs = new Step()
      .withInputs({ schema: "public", memory: 512, dry_run: true, tables: ["a", "b"], labels: { team: "data", tier: 2 } })
      .action().inputs;
    expect(inputs.string("schema")).toBe("public");
    expect(inputs.integer("memory")).toBe(512);
    expect(inputs.boolean("dry_run")).toBe(true);
    expect(inputs.items("tables")).toEqual(["a", "b"]);
    expect(inputs.entries("labels")).toEqual(new Map<string, string | number>([["team", "data"], ["tier", 2]]));
    expect(inputs.has("schema")).toBe(true);
    expect(inputs.has("missing")).toBe(false);
  });

  const wrong: [string, JsonValue, string][] = [
    ["string", 3, "input x: a string is expected, not an integer"],
    ["integer", true, "input x: an integer is expected, not a boolean"],
    ["integer", "3", "input x: an integer is expected, not a string"],
    ["integer", 1.5, "input x: an integer is expected, not a number"],
    ["boolean", "true", "input x: a boolean is expected, not a string"],
    ["items", "a", "input x: a list is expected, not a string"],
    ["items", [{ a: 1 }], "input x: an item is a string, an integer or a boolean, not a map"],
    ["entries", [1], "input x: a map is expected, not a list"],
    ["entries", { k: null }, "input x: an item is a string, an integer or a boolean, not null"],
  ];
  test.each(wrong)("%s of %p names the input and both types", (read, value, message) => {
    const inputs = new Step().withInputs({ x: value }).action().inputs;
    const readers = new Map<string, () => unknown>([
      ["string", () => inputs.string("x")],
      ["integer", () => inputs.integer("x")],
      ["boolean", () => inputs.boolean("x")],
      ["items", () => inputs.items("x")],
      ["entries", () => inputs.entries("x")],
    ]);
    expect(readers.get(read) ?? (() => undefined)).toThrow(new InputError(message));
  });

  test("a missing input is an error", () => {
    expect(() => new Step().action().inputs.string("schema")).toThrow(new InputError("input schema: not given to the step"));
  });
});

describe("outputs", () => {
  test("each output rewrites the whole object at once", () => {
    const step = new Step();
    const outputs = step.action().outputs;
    outputs.set("count", 3);
    outputs.set("files", ["a.sql"]);
    expect(JSON.parse(step.read("output.json"))).toEqual({ count: 3, files: ["a.sql"] });
    expect(readdirSync(step.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("an output not JSON or too large is refused and the file kept", () => {
    const step = new Step();
    const outputs = step.action().outputs;
    outputs.set("count", 3);
    expect(() => { outputs.set("ratio", Number.NaN); }).toThrow(OutputError);
    expect(() => { outputs.set("blob", "x".repeat(MAX_OUTPUT_BYTES)); }).toThrow(/pass large data through files/);
    expect(JSON.parse(step.read("output.json"))).toEqual({ count: 3 });
  });

  test("an output that cannot be written names the file", () => {
    const step = new Step();
    step.env["CRONPLANE_OUTPUT"] = join(step.dir, "gone", "output.json");
    expect(() => { step.action().outputs.set("count", 1); }).toThrow(/cannot be written/);
  });
});

describe("secrets and masked values", () => {
  test("a secret comes from its variable or its file", () => {
    const step = new Step();
    mkdirSync(join(step.dir, "secrets"));
    writeFileSync(join(step.dir, "secrets", "KEY"), "-----BEGIN-----\nAAAA\n");
    mkdirSync(join(step.dir, "secrets", "DIR"));
    Object.assign(step.env, { TOKEN: "t0k3n", CRONPLANE_SECRETS: join(step.dir, "secrets") });
    const action = step.action();
    expect(action.secret("TOKEN")).toBe("t0k3n");
    expect(action.secret("KEY")).toBe("-----BEGIN-----\nAAAA\n");
    expect(() => action.secret("OTHER")).toThrow(new SecretError("secret OTHER: not given to the step (is it in the action's secrets?)"));
    expect(() => action.secret("../KEY")).toThrow(/not the name of a secret/);
    expect(() => action.secret("DIR")).toThrow(/secret DIR: cannot be read/);
  });

  test("a masked value is added to the mask file and a blank one ignored", () => {
    const step = new Step();
    const action = step.action();
    action.mask("tok-123");
    action.mask("  ");
    action.mask("pass-456");
    expect(step.read("mask")).toBe("tok-123\npass-456\n");
  });
});

describe("the environment", () => {
  test("the outputs of the needed steps and the trigger", () => {
    const step = new Step();
    expect(step.action().needed()).toEqual({ build: { tag: "v1" } });
    expect(() => step.action().trigger()).toThrow(/needs_trigger: true/);
    step.write("trigger.json", '{"type": "manual"}').env["CRONPLANE_TRIGGER"] = join(step.dir, "trigger.json");
    expect(step.action().trigger()).toEqual({ type: "manual" });
  });

  test.each(["CRONPLANE_WITH", "CRONPLANE_OUTPUT", "CRONPLANE_MASK"])("without %s the step is not run as an action", (name) => {
    const step = new Step();
    const env: Record<string, string | undefined> = { ...step.env, [name]: undefined };
    expect(() => Action.fromEnvironment(env)).toThrow(new ActionError(`${name} is not set: is this step run by Cronplane, as an action?`));
  });

  test("inputs that are not an object are refused", () => {
    expect(() => new Step().write("with.json", "[1]").action()).toThrow(/a JSON object is expected/);
    expect(() => new Step().write("with.json", "{").action()).toThrow(/cannot be read/);
  });

  test("the worker's egress rule reaches the HTTP client", () => {
    const step = new Step();
    expect(step.action().http.egress).toBe(Egress.Any);
    step.env["CRONPLANE_EGRESS"] = "public";
    expect(step.action().http.egress).toBe(Egress.Public);
    step.env["CRONPLANE_EGRESS"] = "private";
    expect(() => step.action()).toThrow(new ActionError('CRONPLANE_EGRESS="private": one of any, public, or unset'));
  });

  test("the process environment is read by default", () => {
    const step = new Step();
    const saved = { ...process.env };
    Object.assign(process.env, step.env);
    try {
      expect(Action.fromEnvironment().inputs.values.size).toBe(0);
    } finally {
      for (const name of Object.keys(step.env)) {
        process.env[name] = saved[name];
      }
    }
  });
});
