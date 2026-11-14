/** Streams of records between steps: what a step writes, what the next reads. */

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  type JsonValue,
  RejectedError,
  SchemaError,
  StreamError,
  type StreamReader,
  type StreamRecord,
  Streams,
} from "../src/index.ts";
import { parse } from "../src/json.ts";
import { MAX_PART_BYTES, MAX_PART_RECORDS, type PartLimits } from "../src/streams.ts";
import { Case, CONTRACT, directory, partLines, partValues, rejects, Step } from "./helpers.ts";

const SCHEMA: JsonValue = {
  type: "object",
  properties: { id: { type: "integer" }, email: { type: "string" } },
  required: ["id", "email"],
};

let dir: string;
/** The streams of a step `export`, which sends the files of its directory. */
let producer: Streams;
/** The streams of a step `load`, which needs `export`. */
let consumer: Streams;
beforeEach(() => {
  dir = directory();
  producer = new Streams(join(dir, "export"), undefined, "export");
  consumer = new Streams(join(dir, "load"), join(dir, "export"), "load");
});

/** The folder of the stream `contacts` the step `export` sends. */
function sent(): string {
  return join(dir, "export", "streams", "contacts");
}

/** The step `export` sends `records` as the stream `contacts`, checked. */
function contacts(records: readonly StreamRecord[], maxRejected = 0, streams = producer): Promise<void> {
  return streams.writer("contacts", SCHEMA, { keyProperties: ["id"], maxRejected }).use(async (writer) => {
    for (const record of records) {
      await writer.write(record);
    }
  });
}

/** The step `export` sent `content` as the only part of the stream `contacts`. */
async function sentPart(content: Uint8Array): Promise<void> {
  await contacts([]);
  writeFileSync(join(sent(), "part-00001.jsonl.gz"), content);
}

async function read(reader: StreamReader): Promise<StreamRecord[]> {
  const records: StreamRecord[] = [];
  for await (const record of reader) {
    records.push(record);
  }
  return records;
}

function ids(records: readonly StreamRecord[]): JsonValue[] {
  return records.map((record) => record["id"] ?? null);
}

describe("a stream written and read", () => {
  test("a stream is its schema then its records, one per line", async () => {
    const writer = producer.writer("contacts", SCHEMA, { keyProperties: ["id"], bookmarkProperties: ["updated_at"] });
    await writer.use(async () => {
      await writer.write({ id: 1, email: "a@acme.test" });
      await writer.write({ id: 2, email: "é@acme.test", extra: null });
      expect([writer.written, writer.rejected]).toEqual([2, 0]);
    });
    expect(readdirSync(sent()).sort()).toEqual(["part-00001.jsonl.gz", "schema.json"]);
    expect(readFileSync(join(sent(), "schema.json"), "utf8")).toBe(
      '{"version":1,"stream":"contacts","schema":{"type":"object","properties":{"id":{"type":"integer"},"email":{"type":"string"}},"required":["id","email"]},' +
        '"key_properties":["id"],"bookmark_properties":["updated_at"],"encoding":{"format":"jsonl","compression":"gzip"}}\n',
    );
    expect(partLines(sent())).toEqual(['{"id":1,"email":"a@acme.test"}', '{"id":2,"email":"é@acme.test","extra":null}']);
    expect(existsSync(join(dir, "export", "rejected"))).toBe(false);

    const reader = consumer.reader("contacts");
    expect([reader.name, reader.stream, reader.keyProperties, reader.bookmarkProperties]).toEqual([
      "contacts",
      "contacts",
      ["id"],
      ["updated_at"],
    ]);
    const records = await reader.use(read);
    expect(records).toEqual([
      { id: 1, email: "a@acme.test" },
      { id: 2, email: "é@acme.test", extra: null },
    ]);
    expect(await read(reader)).toEqual(records);
  });

  test("the same records give the same files", async () => {
    const files: Buffer[] = [];
    for (const name of ["one", "two"]) {
      await contacts([{ id: 1, email: "a@acme.test" }], 0, new Streams(join(dir, name), undefined, "export"));
      files.push(readFileSync(join(dir, name, "streams", "contacts", "part-00001.jsonl.gz")));
    }
    expect(files[0]?.equals(files[1] ?? Buffer.of())).toBe(true);
  });

  test("a stream without records is its schema alone", async () => {
    await contacts([]);
    expect(readdirSync(sent())).toEqual(["schema.json"]);
    expect(await consumer.reader("contacts").use(read)).toEqual([]);
  });

  test("the work done with a stream gives its result", async () => {
    await contacts([{ id: 1, email: "a" }]);
    expect(await consumer.reader("contacts").use((reader) => reader.stream)).toBe("contacts");
    expect(await producer.writer("deals", { type: "object" }).use(() => 7)).toBe(7);
  });

  test("many records and long lines are read back whole, in order", async () => {
    const long = "é".repeat(40_000);
    const records = Array.from({ length: 5_000 }, (_, id) => ({ id, email: id % 1_000 === 0 ? long : `${String(id)}@acme.test`.repeat(8) }));
    await contacts(records);
    const reader = consumer.reader("contacts");
    let next = 0;
    for await (const record of reader) {
      if (record["id"] !== next || record["email"] !== records[next]?.email) {
        throw new Error(`record ${String(next)} is not read as written: ${JSON.stringify(record).slice(0, 100)}`);
      }
      next += 1;
    }
    expect([next, reader.rejected]).toEqual([5_000, 0]);
  });

  test("a step that stops reading early reads the stream again from its start", async () => {
    await contacts(Array.from({ length: 3_000 }, (_, id) => ({ id, email: "x".repeat(100) })));
    const reader = consumer.reader("contacts");
    for await (const record of reader) {
      expect(record["id"]).toBe(0);
      break;
    }
    expect((await read(reader)).length).toBe(3_000);
  });
});

describe("the parts of a stream", () => {
  function sending(limits: PartLimits): Streams {
    return new Streams(join(dir, "export"), undefined, "export", limits);
  }

  /** The number of records of each part of the stream `contacts`, in order. */
  function sizes(): number[] {
    return readdirSync(sent())
      .filter((name) => name !== "schema.json")
      .sort()
      .map((name) => gunzipSync(readFileSync(join(sent(), name))).toString().split("\n").length - 1);
  }

  test("a part is closed at its number of records", async () => {
    const writer = sending({ records: 2, bytes: MAX_PART_BYTES }).writer("contacts", { type: "object" });
    await writer.use(async () => {
      for (let n = 0; n < 5; n++) {
        await writer.write({ n });
      }
    });
    expect(readdirSync(sent()).sort()).toEqual(["part-00001.jsonl.gz", "part-00002.jsonl.gz", "part-00003.jsonl.gz", "schema.json"]);
    expect(sizes()).toEqual([2, 2, 1]);
    expect(partLines(sent())).toEqual(['{"n":0}', '{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}']);
    expect(writer.written).toBe(5);
    await writer.close();
  });

  test("a line starts a new part rather than pass the size of a part", async () => {
    // Each line is 9 bytes: two fill 18 of the 20 bytes, a third does not fit.
    const writer = sending({ records: 100, bytes: 20 }).writer("contacts", { type: "object" });
    await writer.use(async () => {
      for (let n = 10; n < 15; n++) {
        await writer.write({ a: n });
      }
    });
    expect(sizes()).toEqual([2, 2, 1]);
  });

  test("the parts of a stream are read in the order of their names", async () => {
    await contacts([]);
    for (const [number, numbers] of [[2, [3]], [1, [1, 2]], [3, []]] as const) {
      const text = numbers.map((id) => `${JSON.stringify({ id, email: "x" })}\n`).join("");
      writeFileSync(join(sent(), `part-0000${String(number)}.jsonl.gz`), gzipSync(text));
    }
    expect(ids(await consumer.reader("contacts").use(read))).toEqual([1, 2, 3]);
  });

  test("the folder of a stream holds its schema and its parts only", async () => {
    await contacts([{ id: 1, email: "a" }]);
    writeFileSync(join(sent(), "notes.txt"), "x");
    expect(() => consumer.reader("contacts")).toThrow(/notes\.txt: not a file of a stream/);
    rmSync(join(sent(), "notes.txt"));
    writeFileSync(join(sent(), "part-00003.jsonl.gz"), gzipSync(""));
    expect(() => consumer.reader("contacts")).toThrow(new StreamError(`${sent()}: its parts are numbered from 1, none missing`));
    renameSync(join(sent(), "part-00003.jsonl.gz"), join(sent(), "part-00002.jsonl.gz"));
    mkdirSync(join(sent(), "part-00003.jsonl.gz"));
    expect(() => consumer.reader("contacts")).toThrow(/part-00003\.jsonl\.gz: not a file of a stream/);
  });

  test("the last line of a part is read without its line feed", async () => {
    await sentPart(gzipSync('{"id":1,"email":"a"}\n{"id":2,"email":"b"}'));
    expect(ids(await consumer.reader("contacts").use(read))).toEqual([1, 2]);
  });

  test.each([
    ["a line that is not JSON", gzipSync('{"id": 1, "email": "a"}\n{not json\n'), /part-00001\.jsonl\.gz: line 2 is not JSON: /],
    ["a number that is not of JSON", gzipSync('{"id": NaN, "email": "a"}\n'), /line 1 is not JSON: /],
    ["an empty line", gzipSync('{"id": 1, "email": "a"}\n\n'), /line 2 is not JSON: /],
    ["a line that is not UTF-8", gzipSync(Buffer.from([0x22, 0xff, 0x22, 0x0a])), /line 1 is not JSON: /],
    ["a file that is not gzip", Buffer.from("not gzip"), /part-00001\.jsonl\.gz: cannot be read: /],
    ["a gzip file cut short", gzipSync('{"id": 1, "email": "a"}\n').subarray(0, -6), /part-00001\.jsonl\.gz: cannot be read: /],
  ])("%s fails the step", async (_what, content, problem) => {
    await sentPart(content);
    const reading = read(consumer.reader("contacts"));
    await rejects(reading, StreamError);
    await rejects(reading, problem);
  });

  test("a line that is not an object is rejected, or refused when unchecked", async () => {
    await sentPart(gzipSync("[1]\n"));
    const reader = consumer.reader("contacts", { maxRejected: 1 });
    expect(await reader.use(read)).toEqual([]);
    expect(reader.rejected).toBe(1);
    expect(partValues(join(dir, "load", "rejected", "contacts", "load"))).toEqual([{ record: [1], reason: "/: type" }]);
    const unchecked = new Streams(join(dir, "again"), consumer.needed, "load").reader("contacts", { validate: false });
    await rejects(read(unchecked), /line 1 is not a JSON object/);
  });

  test("a record larger than a part is rejected and never read", async () => {
    const small: PartLimits = { records: MAX_PART_RECORDS, bytes: 100 };
    const writer = sending(small).writer("contacts", { type: "object" }, { maxRejected: 2 });
    await writer.write({ id: 1 });
    await writer.write({ id: 2, text: "x".repeat(100) });
    await writer.reject({ id: 3, text: "y".repeat(100) }, "refused");
    await writer.close();
    expect([writer.written, writer.rejected]).toEqual([1, 2]);
    expect(partValues(join(dir, "export", "rejected", "contacts", "export"))).toEqual([
      { record: null, reason: "a record of 119 bytes, over 100" },
      { record: null, reason: "refused (a record over 100 bytes)" },
    ]);

    writeFileSync(join(sent(), "part-00001.jsonl.gz"), gzipSync(`{"id": 1}\n{"id": 2, "text": "${"x".repeat(100)}"}\n`));
    const reader = new Streams(join(dir, "load"), join(dir, "export"), "load", small).reader("contacts");
    const seen: JsonValue[] = [];
    const reading = (async () => {
      for await (const record of reader) {
        seen.push(record["id"] ?? null);
      }
    })();
    await rejects(reading, new StreamError(`${join(sent(), "part-00001.jsonl.gz")}: line 2 is over 100 bytes`));
    expect(seen).toEqual([1]);
  });

  test("a line longer than a part is refused before it is read whole", async () => {
    const limits: PartLimits = { records: MAX_PART_RECORDS, bytes: 50_000 };
    await sentPart(gzipSync(`{"id":1,"email":"a"}\n{"id":2,"email":"${"x".repeat(200_000)}`));
    const reader = new Streams(join(dir, "load"), join(dir, "export"), "load", limits).reader("contacts");
    await rejects(read(reader), /part-00001\.jsonl\.gz: line 2 is over 50000 bytes$/);
  });
});

describe("rejected records", () => {
  test("a record that does not fit is rejected and the step fails at the end", async () => {
    const rejected = join(dir, "export", "rejected", "contacts", "export");
    await rejects(
      contacts([{ id: 1, email: "a@acme.test" }, { id: "2", email: "b@acme.test" }, { email: 3 }, { id: 4, email: "d@acme.test" }]),
      new RejectedError(`stream contacts: 2 records rejected, 0 allowed (maxRejected): see ${rejected} in the files of the step`),
    );
    // The other records are written, and every rejected one kept.
    expect(partValues(sent())).toEqual([
      { id: 1, email: "a@acme.test" },
      { id: 4, email: "d@acme.test" },
    ]);
    expect(partLines(rejected)).toEqual([
      '{"record":{"id":"2","email":"b@acme.test"},"reason":"/id: type","key":{"id":"2"}}',
      '{"record":{"email":3},"reason":"/id: required; /email: type","key":{}}',
    ]);
  });

  test("a step allows some rejected records", async () => {
    const records = [{ id: 1, email: "a" }, { id: "2" }, { id: "3" }];
    await contacts(records, 2);
    await rejects(contacts(records, 1, new Streams(join(dir, "again"), undefined, "export")), /2 records rejected, 1 allowed/);
    for (const [maxRejected, shown] of [[-1, "-1"], [1.5, "1.5"], [Number.NaN, "NaN"]] as const) {
      expect(() => consumer.reader("contacts", { maxRejected })).toThrow(new StreamError(`maxRejected is 0 or more, not ${shown}`));
      expect(() => producer.writer("deals", SCHEMA, { maxRejected })).toThrow(`maxRejected is 0 or more, not ${shown}`);
    }
    expect(existsSync(join(dir, "export", "streams", "deals"))).toBe(false);
  });

  test("a reader rejects what does not fit and what the step refuses", async () => {
    const writer = producer.writer("contacts", SCHEMA, { keyProperties: ["id"], validate: false });
    await writer.use(async () => {
      await writer.write({ id: 1, email: "a@acme.test" });
      await writer.write({ id: 2 });
      await writer.write({ id: 3, email: "c@acme.test" });
    });
    const reader = consumer.reader("contacts");
    const records = await read(reader);
    expect(ids(records)).toEqual([1, 3]);
    await reader.reject(records[1] ?? null, "HubSpot: INVALID_EMAIL");
    expect(reader.rejected).toBe(2);
    await rejects(reader.close(), /^stream contacts: 2 records rejected, 0 allowed/);
    expect(partValues(join(dir, "load", "rejected", "contacts", "load"))).toEqual([
      { record: { id: 2 }, reason: "/email: required", key: { id: 2 } },
      { record: { id: 3, email: "c@acme.test" }, reason: "HubSpot: INVALID_EMAIL", key: { id: 3 } },
    ]);

    // As written, unchecked.
    const again = new Streams(join(dir, "again"), consumer.needed, "load").reader("contacts", { validate: false });
    expect(ids(await again.use(read))).toEqual([1, 2, 3]);
  });

  test("a failure of the step is not hidden by its rejected records", async () => {
    const failure = new Error("the step's own failure");
    const writing = producer.writer("contacts", SCHEMA).use(async (writer) => {
      await writer.write({ id: "bad" });
      throw failure;
    });
    await rejects(writing, failure);
    expect(partLines(join(dir, "export", "rejected", "contacts", "export")).length).toBe(1);

    const reading = consumer.reader("contacts").use(async (reader) => {
      await reader.reject({ id: 1 }, "refused");
      throw failure;
    });
    await rejects(reading, failure);
    expect(partLines(join(dir, "load", "rejected", "contacts", "load")).length).toBe(1);
  });

  test("a stream read under the name of its step keeps its own name", async () => {
    await new Streams(join(dir, "crm"), undefined, "crm").writer("contacts", SCHEMA).close();
    mkdirSync(join(dir, "needed", "streams"), { recursive: true });
    renameSync(join(dir, "crm", "streams", "contacts"), join(dir, "needed", "streams", "crm.contacts"));
    const reader = new Streams(join(dir, "merge"), join(dir, "needed"), "merge").reader("crm.contacts");
    expect([reader.name, reader.stream]).toEqual(["crm.contacts", "contacts"]);
    await reader.reject({ id: 1 }, "duplicate");
    await reader.close({ failing: true });
    expect(readdirSync(join(dir, "merge", "rejected", "contacts", "merge"))).toEqual(["part-00001.jsonl.gz"]);
  });

  test("a rejected record has the key properties it holds, null included", async () => {
    const writer = producer.writer("contacts", { type: "object" }, { keyProperties: ["id", "source", "__proto__"], maxRejected: 3 });
    await writer.use(async () => {
      await writer.reject({ id: null, name: "x" }, "no id");
      await writer.reject([1], "not a record");
      await writer.reject("text", "not a record");
    });
    expect(partLines(join(dir, "export", "rejected", "contacts", "export"))).toEqual([
      '{"record":{"id":null,"name":"x"},"reason":"no id","key":{"id":null}}',
      '{"record":[1],"reason":"not a record"}',
      '{"record":"text","reason":"not a record"}',
    ]);
  });
});

describe("what a stream needs", () => {
  test("a stream is named and declared as the contract says", async () => {
    for (const name of ["Contacts", "order-lines", "a/b", "..", "", "contacts\n"]) {
      expect(() => producer.writer(name, SCHEMA)).toThrow(new StreamError(`stream ${JSON.stringify(name)} must match ^[a-z][a-z0-9_]{0,62}$`));
      expect(() => consumer.reader(name)).toThrow(new StreamError(`stream ${JSON.stringify(name)}: a stream (contacts) or <step>.<stream>`));
    }
    expect(() => producer.writer("contacts", { type: "object", properties: { a: { pattern: "x" } } })).toThrow(SchemaError);
    // Nothing is written for a schema refused.
    expect(existsSync(join(dir, "export"))).toBe(false);
    await producer.writer("contacts", SCHEMA).close();
    expect(() => producer.writer("contacts", SCHEMA)).toThrow(new StreamError("stream contacts: already written by this step"));
  });

  test("a record that is not a JSON value fails the step", async () => {
    const writer = producer.writer("deals", { type: "object" });
    await rejects(writer.write({ n: Number.NaN }), new StreamError("stream deals: a record: not a JSON value: TypeError: not a JSON number: NaN"));
    const notJson: unknown[] = [undefined, new Date(0), () => 1];
    for (const value of notJson) {
      // A value the type of a record refuses, as code without types gives it.
      const record: StreamRecord = {};
      Object.assign(record, { n: value });
      await rejects(writer.write(record), /^stream deals: a record: not a JSON value: /);
    }
    await rejects(writer.reject({ n: Number.POSITIVE_INFINITY }, "refused"), /^stream deals: a rejected record: not a JSON value: /);
    await writer.close();
    expect([writer.written, writer.rejected]).toEqual([0, 0]);
  });

  test("a step without its directories is told what is missing", async () => {
    expect(() => new Streams(undefined, undefined, "s").writer("contacts", SCHEMA)).toThrow(/^CRONPLANE_FILES is not set.*produces streams/);
    expect(() => new Streams(dir, undefined, "s").reader("contacts")).toThrow(/^CRONPLANE_NEEDED_FILES is not set/);
    await contacts([]);
    expect(() => new Streams(undefined, join(dir, "export"), "s").reader("contacts")).toThrow(/^CRONPLANE_FILES is not set.*reads streams/);
    expect(() => new Streams(join(dir, "out"), join(dir, "export"), "s").reader("deals")).toThrow(
      /streams\/deals\/schema\.json: no such stream: is it in streams\.consumes/,
    );
  });

  /** The step `export` sent the stream `contacts`, then `change` was made to its `schema.json`. */
  async function described(change: (fields: Map<string, JsonValue>) => void): Promise<void> {
    rmSync(join(dir, "export"), { recursive: true, force: true });
    await contacts([]);
    const path = join(sent(), "schema.json");
    const fields = new Map(new Case(parse(readFileSync(path, "utf8"))).entries());
    change(fields);
    writeFileSync(path, JSON.stringify(Object.fromEntries(fields)));
  }

  const unread: [string, JsonValue, string][] = [
    ["version", 2, "version 2: this library reads version 1"],
    ["stream", "Bad Name", "stream is the name of a stream"],
    ["stream", null, "stream is the name of a stream"],
    ["encoding", { format: "parquet" }, 'encoding {"format":"parquet"}: this library reads jsonl compressed with gzip'],
    ["encoding", { format: "jsonl", compression: "zstd" }, 'encoding {"format":"jsonl","compression":"zstd"}: this library reads jsonl compressed with gzip'],
    ["encoding", { format: "jsonl", compression: "gzip", level: 9 }, 'encoding {"format":"jsonl","compression":"gzip","level":9}: this library reads jsonl compressed with gzip'],
    ["encoding", "gzip", 'encoding "gzip": this library reads jsonl compressed with gzip'],
    ["key_properties", "id", "key_properties is a list of property names"],
    ["bookmark_properties", [1], "bookmark_properties is a list of property names"],
  ];
  test.each(unread)("a schema.json with %s %j is not one this library reads", async (field, value, problem) => {
    await described((fields) => fields.set(field, value));
    expect(() => consumer.reader("contacts")).toThrow(StreamError);
    expect(() => consumer.reader("contacts")).toThrow(`${join(sent(), "schema.json")}: ${problem}`);
  });

  test("a schema.json without a field is refused, but for its lists of properties", async () => {
    await described((fields) => fields.delete("version"));
    expect(() => consumer.reader("contacts")).toThrow("version null: this library reads version 1");
    await described((fields) => fields.delete("encoding"));
    expect(() => consumer.reader("contacts")).toThrow("encoding null: this library reads jsonl compressed with gzip");
    await described((fields) => fields.delete("schema"));
    expect(() => consumer.reader("contacts")).toThrow(SchemaError);

    await described((fields) => {
      fields.delete("key_properties");
      fields.delete("bookmark_properties");
    });
    const reader = consumer.reader("contacts");
    expect([reader.keyProperties, reader.bookmarkProperties]).toEqual([[], []]);
    await reader.reject({ id: 1 }, "no key");
    await reader.close({ failing: true });
    expect(partValues(join(dir, "load", "rejected", "contacts", "load"))).toEqual([{ record: { id: 1 }, reason: "no key" }]);
  });

  test("a schema.json that is not the object of a stream is refused", async () => {
    await described((fields) => fields.set("schema", { type: "array" }));
    expect(() => consumer.reader("contacts")).toThrow(SchemaError);
    writeFileSync(join(sent(), "schema.json"), "[]");
    expect(() => consumer.reader("contacts")).toThrow(/schema\.json: a JSON object is expected/);
    writeFileSync(join(sent(), "schema.json"), "{not json");
    expect(() => consumer.reader("contacts")).toThrow(/schema\.json: cannot be read: /);
  });

  test("a step gets its streams from what Cronplane gives it", async () => {
    const step = new Step();
    const streams = step.action().streams;
    expect([streams.files, streams.needed, streams.step]).toEqual([undefined, undefined, ""]);
    step.env["CRONPLANE_FILES"] = join(step.dir, "files");
    step.env["CRONPLANE_NEEDED_FILES"] = join(step.dir, "needed_files");
    step.env["CRONPLANE_STEP_ID"] = "export";
    expect(step.action().streams.needed).toBe(join(step.dir, "needed_files"));
    const writer = step.action().streams.writer("contacts", SCHEMA);
    await writer.write({ id: "x" });
    await writer.close({ failing: true });
    expect(existsSync(join(step.dir, "files", "streams", "contacts", "schema.json"))).toBe(true);
    expect(readdirSync(join(step.dir, "files", "rejected", "contacts", "export"))).toEqual(["part-00001.jsonl.gz"]);
  });
});

describe("files that cannot be written", () => {
  test("a folder that cannot be made names its place", async () => {
    writeFileSync(join(dir, "files"), "a file where the directory goes");
    const blocked = new Streams(join(dir, "files"), undefined, "export");
    expect(() => blocked.writer("contacts", SCHEMA)).toThrow(/files\/streams\/contacts: cannot be written: /);

    const writer = producer.writer("contacts", SCHEMA);
    writeFileSync(join(dir, "export", "rejected"), "a file where the directory goes");
    await rejects(writer.write({ id: "bad" }), /rejected\/contacts\/export\/part-00001\.jsonl\.gz: cannot be written: /);
    mkdirSync(join(sent(), "part-00001.jsonl.gz"));
    await rejects(writer.write({ id: 1, email: "a" }), /streams\/contacts\/part-00001\.jsonl\.gz: cannot be written: /);
  });

  // /dev/full is a file of Linux that takes no byte: a disk that is full.
  test.skipIf(!existsSync("/dev/full"))("a disk that fails while a part is written names the folder", async () => {
    const writer = producer.writer("contacts", { type: "object" });
    symlinkSync("/dev/full", join(sent(), "part-00001.jsonl.gz"));
    await writer.write({ id: 1 });
    await rejects(writer.close(), StreamError);

    const large = producer.writer("deals", { type: "object" });
    symlinkSync("/dev/full", join(dir, "export", "streams", "deals", "part-00001.jsonl.gz"));
    const writing = (async () => {
      for (let id = 0; id < 100_000; id++) {
        await large.write({ id, text: String(Math.random()).repeat(50) });
      }
    })();
    await rejects(writing, /streams\/deals: cannot be written: .*ENOSPC/);
    await rejects(large.close(), /streams\/deals: cannot be written: .*ENOSPC/);
  });
});

describe("the streams of the contract", () => {
  const CASES = Case.of("streams");

  test("the limits of a part are those of the contract", () => {
    expect(CASES.get("version").value).toBe(1);
    expect(CASES.get("limits").value).toEqual({ part_records: MAX_PART_RECORDS, part_bytes: MAX_PART_BYTES });
  });

  test("a stream is written as the contract says", async () => {
    const c = CASES.get("write");
    const [step, stream] = [c.get("step").text(), c.get("stream").text()];
    const writer = new Streams(dir, undefined, step).writer(stream, c.get("schema").value, {
      keyProperties: c.get("key_properties").list().map((name) => name.text()),
      bookmarkProperties: c.get("bookmark_properties").list().map((name) => name.text()),
      maxRejected: c.get("max_rejected").number(),
    });
    await writer.use(async () => {
      for (const record of c.get("records").list()) {
        await writer.write(recordOf(record));
      }
    });
    const folder = join(dir, "streams", stream);
    const schemaJson = readFileSync(join(folder, "schema.json"), "utf8");
    expect(schemaJson).toBe(`${JSON.stringify(c.get("schema_json").value)}\n`);
    expect(partLines(folder)).toEqual(c.get("lines").list().map((line) => line.text()));
    expect(partLines(join(dir, "rejected", stream, step))).toEqual(c.get("rejected_lines").list().map((line) => line.text()));
  });

  function recordOf(record: Case): StreamRecord {
    return Object.fromEntries(record.entries());
  }

  test("the golden stream of the contract is read", async () => {
    const c = CASES.get("read");
    const golden = join(CONTRACT, "streams", c.get("folder").text());
    const reader = new Streams(dir, golden, "load").reader(c.get("name").text());
    expect(reader.stream).toBe(c.get("stream").text());
    expect(reader.keyProperties).toEqual(c.get("key_properties").list().map((name) => name.text()));
    expect(reader.bookmarkProperties).toEqual(c.get("bookmark_properties").list().map((name) => name.text()));
    const records = await reader.use(read);
    expect(records).toEqual(c.get("records").list().map(recordOf));
    expect(records.map((record) => JSON.stringify(record))).toEqual(c.get("records").list().map((record) => JSON.stringify(record.value)));
    const parts = readdirSync(join(golden, "streams", c.get("name").text())).filter((name) => name !== "schema.json");
    expect(parts.sort()).toEqual(c.get("parts").list().map((name) => name.text()));
  });
});
