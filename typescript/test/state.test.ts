/** Where a step starts again: the state Cronplane keeps between runs. */

import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { type JsonValue, MAX_STATE_BYTES, State, StateError } from "../src/index.ts";
import { parse } from "../src/json.ts";
import { Step } from "./helpers.ts";

/** A step of an action with `state: true`; `kept` is what its last successful run left. */
function stateful(kept?: string): Step {
  const step = new Step();
  step.env["CRONPLANE_STATE_OUT"] = join(step.dir, "state_out.json");
  if (kept !== undefined) {
    step.write("state.json", kept);
    step.env["CRONPLANE_STATE"] = join(step.dir, "state.json");
  }
  return step;
}

function written(step: Step): JsonValue {
  return parse(step.read("state_out.json"));
}

test("an action without state: true is told so", () => {
  expect(() => new Step().action().state).toThrow(new StateError("the state is not kept: the action needs `state: true`"));
});

test("a first run has no state and writes the next", () => {
  const step = stateful();
  const state = step.action().state;
  expect(state.get()).toBeNull();
  expect(state.stream("contacts")).toEqual({});
  state.set({ cursor: "2026-11-08T12:45:00+00:00" });
  expect(written(step)).toEqual({ cursor: "2026-11-08T12:45:00+00:00" });
  state.set(["é", 1]);
  expect(step.read("state_out.json")).toBe('["é",1]');
  expect(readdirSync(step.dir).filter((name) => name.startsWith("."))).toEqual([]);
});

test("the state kept is read as the last successful run left it", () => {
  const kept = { version: 1, streams: { contacts: { cursor: "a", last_key: 111 } } };
  const state = stateful(JSON.stringify(kept)).action().state;
  expect(state.stream("contacts")).toEqual({ cursor: "a", last_key: 111 });
  expect(state.stream("deals")).toEqual({});
  expect(state.get()).toEqual(kept);
});

test("each stream keeps its own entry", () => {
  const step = stateful('{"version": 1, "streams": {"contacts": {"cursor": "a"}, "deals": {"k": 1}}}');
  const state = step.action().state;
  state.setStream("contacts", { cursor: "b" });
  state.setStream("companies", { cursor: "c" });
  expect(written(step)).toEqual({
    version: 1,
    streams: { contacts: { cursor: "b" }, deals: { k: 1 }, companies: { cursor: "c" } },
  });
  // What the run read, until Cronplane keeps what it wrote.
  expect(state.stream("contacts")).toEqual({ cursor: "a" });
});

test("a stream named as a property of every object is kept as any other", () => {
  const step = stateful();
  const state = step.action().state;
  state.setStream("__proto__", { cursor: "a" });
  state.setStream("constructor", { cursor: "b" });
  expect(step.read("state_out.json")).toBe('{"version":1,"streams":{"__proto__":{"cursor":"a"},"constructor":{"cursor":"b"}}}');
  expect(state.stream("toString")).toEqual({});
});

test.each([
  ['{"cursor": "a"}', "the state is not one of this library"],
  ["[1]", "the state is not one of this library"],
  ['{"version": 2, "streams": {}}', "the state is not one of this library"],
  ['{"version": 1, "streams": []}', 'the state has no "streams" object'],
  ['{"version": 1}', 'the state has no "streams" object'],
])("the state %p of another form is not read per stream", (text, problem) => {
  expect(() => stateful(text).action().state.stream("contacts")).toThrow(problem);
  const step = stateful(text);
  expect(() => {
    step.action().state.setStream("contacts", {});
  }).toThrow(problem);
  expect(readdirSync(step.dir)).not.toContain("state_out.json");
});

test("a stream whose entry is not an object starts from nothing", () => {
  expect(stateful('{"version": 1, "streams": {"contacts": "text"}}').action().state.stream("contacts")).toEqual({});
});

test("a state too large or not JSON is refused and nothing written", () => {
  const step = stateful();
  const state = step.action().state;
  state.set({ cursor: 1 });
  expect(() => {
    state.set("x".repeat(MAX_STATE_BYTES));
  }).toThrow(new StateError("the state is 32770 bytes, more than 32768: keep where to start again, never data"));
  expect(() => {
    state.set("é".repeat(MAX_STATE_BYTES / 2));
  }).toThrow("the state is 32770 bytes");
  expect(() => {
    state.set(Number.NaN);
  }).toThrow("the state is not a JSON value: TypeError: not a JSON number: NaN");
  expect(written(step)).toEqual({ cursor: 1 });
  state.set("x".repeat(MAX_STATE_BYTES - 2));
  expect(step.read("state_out.json").length).toBe(MAX_STATE_BYTES);
});

test("a state that cannot be read or written names its file", () => {
  const step = stateful("{not json");
  expect(() => step.action().state.get()).toThrow(/state\.json: the state cannot be read: /);
  const missing = new State(undefined, join(step.dir, "gone", "state_out.json"));
  expect(() => {
    missing.set({});
  }).toThrow(/gone\/state_out\.json: cannot be written: /);
});
