/**
 * A step's directory as Cronplane prepares it, a local HTTP server, and the
 * cases of the contract every library for actions passes.
 */

import { expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server as NodeServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { Action, type Address, type JsonValue, type Resolve } from "../src/index.ts";
import { isObject, parse } from "../src/json.ts";

/** The folder `contract/` of the repository. */
export const CONTRACT = join(import.meta.dir, "..", "..", "contract");

/** A value of the contract's cases, read as the type a test expects of it. */
export class Case {
  constructor(readonly value: JsonValue) {}

  /** `contract/<name>/cases.json`. */
  static of(name: string): Case {
    return new Case(parse(readFileSync(join(CONTRACT, name, "cases.json"), "utf8")));
  }

  get(name: string): Case {
    return new Case(new Map(this.entries()).get(name) ?? null);
  }

  /** The properties of an object, in its order. */
  entries(): [string, JsonValue][] {
    return Object.entries(this.as(isObject, "an object"));
  }

  list(): Case[] {
    return this.as((value): value is JsonValue[] => Array.isArray(value), "a list").map((item) => new Case(item));
  }

  text(): string {
    return this.as((value) => typeof value === "string", "a string");
  }

  number(): number {
    return this.as((value) => typeof value === "number", "a number");
  }

  /** The name of the case, then the case: a row of `test.each`. */
  named(): [string, Case] {
    return [this.get("name").text(), this];
  }

  private as<T extends JsonValue>(is: (value: JsonValue) => value is T, what: string): T {
    if (!is(this.value)) {
      throw new TypeError(`${what} is expected in the contract, not ${JSON.stringify(this.value)}`);
    }
    return this.value;
  }
}

/** A new temporary directory. */
export function directory(): string {
  return mkdtempSync(join(tmpdir(), "step-"));
}

/** The lines of the gzip parts of `folder`, in the order of their names. */
export function partLines(folder: string): string[] {
  return readdirSync(folder)
    .filter((name) => name.startsWith("part-"))
    .sort()
    .flatMap((name) => gunzipSync(readFileSync(join(folder, name))).toString().split("\n").slice(0, -1));
}

/** The JSON values of the lines of the gzip parts of `folder`. */
export function partValues(folder: string): JsonValue[] {
  return partLines(folder).map(parse);
}

/** The files and variables Cronplane gives a step using an action. */
export class Step {
  readonly dir = directory();
  readonly env: Record<string, string> = {
    CRONPLANE_WITH: join(this.dir, "with.json"),
    CRONPLANE_OUTPUT: join(this.dir, "output.json"),
    CRONPLANE_MASK: join(this.dir, "mask"),
    CRONPLANE_INPUTS: join(this.dir, "inputs.json"),
    CRONPLANE_VERSION: "0.1.0",
  };

  constructor() {
    this.write("with.json", "{}");
    this.write("inputs.json", '{"build": {"tag": "v1"}}');
  }

  write(name: string, text: string): this {
    writeFileSync(join(this.dir, name), text);
    return this;
  }

  withInputs(values: Record<string, JsonValue>): this {
    return this.write("with.json", JSON.stringify(values));
  }

  action(): Action {
    return Action.fromEnvironment(this.env);
  }

  read(name: string): string {
    return readFileSync(join(this.dir, name), "utf8");
  }
}

/** A request the local server received. */
export interface Seen {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

/** Answers each path with what `routes` gives: status, headers, body. */
export class Server {
  readonly routes = new Map<string, readonly [number, Readonly<Record<string, string>>, string]>();
  readonly seen: Seen[] = [];
  private readonly server: NodeServer;

  private constructor(server: NodeServer) {
    this.server = server;
  }

  static async start(): Promise<Server> {
    const server = new Server(createServer());
    server.server.on("request", (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const path = request.url ?? "/";
        server.seen.push({ method: request.method ?? "", path, headers: request.headers, body: Buffer.concat(chunks).toString() });
        const [status, headers, body] = server.routes.get(path) ?? [404, {}, "not found"];
        response.writeHead(status, headers).end(body);
      });
    });
    await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
    return server;
  }

  get port(): number {
    const address = this.server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }

  url(path: string, host = "127.0.0.1"): string {
    return `http://${host}:${String(this.port)}${path}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => { resolve(); }));
  }
}

/** Resolves names from a table, without DNS. */
export function resolver(names: Readonly<Record<string, readonly string[]>>): Resolve {
  const table = new Map(Object.entries(names));
  return (host) =>
    Promise.resolve(
      (table.get(host) ?? []).map((address): Address => ({ address, family: address.includes(":") ? 6 : 4 })),
    );
}

/** Sends every connection to the local server, recording the checked address. */
export function toLocal(attempts: string[]): (address: Address) => Address {
  return (address) => {
    attempts.push(address.address);
    return { address: "127.0.0.1", family: 4 };
  };
}

/** Checks that `promise` fails with `expected` (a pattern of its message, an error, a class). */
export async function rejects(promise: Promise<unknown>, expected: RegExp | Error | (new (message: string) => Error)): Promise<void> {
  let failure: unknown = undefined;
  let failed = false;
  try {
    await promise;
  } catch (e) {
    failure = e;
    failed = true;
  }
  expect(() => {
    if (failed) {
      throw failure;
    }
  }).toThrow(expected);
}
