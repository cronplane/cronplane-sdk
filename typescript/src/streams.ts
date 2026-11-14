/**
 * Streams of records between steps (the contract of Cronplane, version 1).
 *
 * A stream is a folder of the files a step sends: `schema.json`, then its
 * records, one JSON object per line, in gzip parts read in the order of their
 * names. A record that does not fit the schema is not passed on: it goes to
 * the rejected records of the step, and the step fails at the end when there
 * are more of them than it allows.
 */

import { once } from "node:events";
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream";
import { pipeline as piped } from "node:stream/promises";
import { createGunzip, createGzip, type Gzip } from "node:zlib";

import { RejectedError, StreamError } from "./errors.ts";
import { isMissing } from "./files.ts";
import { checked, isObject, type JsonValue, parse } from "./json.ts";
import { RecordSchema } from "./schema.ts";

/** The version of the contract this library reads and writes. */
export const VERSION = 1;
/** A part is closed at this number of records, or at `MAX_PART_BYTES`. */
export const MAX_PART_RECORDS = 100_000;
/** The size of a part before compression; a record is never larger. */
export const MAX_PART_BYTES = 64 << 20;

/** When a part is closed. */
export interface PartLimits {
  readonly records: number;
  readonly bytes: number;
}

const LIMITS: PartLimits = { records: MAX_PART_RECORDS, bytes: MAX_PART_BYTES };
const ENCODING = { format: "jsonl", compression: "gzip" } as const;
const STREAM = /^[a-z][a-z0-9_]{0,62}$/;
// A stream as a step reads it: alone, or after the step that produces it.
// eslint-disable-next-line security/detect-unsafe-regex -- the repetitions are bounded (62): the time is linear in the name
const CONSUMED = /^(?:[a-z][a-z0-9_-]{0,62}\.)?[a-z][a-z0-9_]{0,62}$/;
const PART = /^part-([0-9]{5})\.jsonl\.gz$/;
const SCHEMA_FILE = "schema.json";
const LINE_FEED = 0x0a;

/** A record of a stream. */
export type StreamRecord = Record<string, JsonValue>;

/** Whether the step already fails for another reason than its rejected records. */
export interface Closing {
  readonly failing?: boolean;
}

/** `value` as one line of a part. */
function line(value: JsonValue, what: string): Uint8Array {
  let text: string;
  try {
    text = JSON.stringify(checked(value));
  } catch (e) {
    throw new StreamError(`${what}: not a JSON value: ${String(e)}`, { cause: e });
  }
  return new TextEncoder().encode(`${text}\n`);
}

function partName(number: number): string {
  return `part-${String(number).padStart(5, "0")}.jsonl.gz`;
}

function names(value: JsonValue | undefined, field: string, where: string): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new StreamError(`${where}: ${field} is a list of property names`);
  }
  return value.map((name) => {
    if (typeof name !== "string") {
      throw new StreamError(`${where}: ${field} is a list of property names`);
    }
    return name;
  });
}

/** One gzip file being written. */
class Part {
  private readonly gzip: Gzip = createGzip();
  /** Settled when the file is whole on the disk, or cannot be. */
  private readonly finished: Promise<void>;

  constructor(path: string) {
    // Opened at once: a file that cannot be made fails here, not at the end.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a part of the folder of a stream
    const fd = openSync(path, "w");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the file opened above
    this.finished = piped(this.gzip, createWriteStream(path, { fd }));
    // `write` and `close` wait for the file and give its failure: here, it only must not be unhandled.
    this.finished.catch(() => undefined);
  }

  /** Takes `data`; waits while the disk is slower than the step. */
  async write(data: Uint8Array): Promise<void> {
    if (!this.gzip.write(data)) {
      await Promise.race([once(this.gzip, "drain"), this.finished]);
    }
  }

  async close(): Promise<void> {
    this.gzip.end();
    await this.finished;
  }
}

/**
 * Lines written to `part-00001.jsonl.gz`, `part-00002.jsonl.gz`… of a
 * folder, each part closed at the limits of the contract.
 */
class Parts {
  lines = 0;
  private number = 0;
  private records = 0;
  private bytes = 0;
  private part: Part | undefined;

  constructor(
    readonly folder: string,
    private readonly limits: PartLimits,
  ) {}

  async write(data: Uint8Array): Promise<void> {
    const full = this.records >= this.limits.records || this.bytes + data.length > this.limits.bytes;
    const part = this.part === undefined || full ? await this.next() : this.part;
    try {
      await part.write(data);
    } catch (e) {
      throw new StreamError(`${this.folder}: cannot be written: ${String(e)}`, { cause: e });
    }
    this.records += 1;
    this.bytes += data.length;
    this.lines += 1;
  }

  /** Closes the part being written and opens the one after it. */
  private async next(): Promise<Part> {
    await this.close();
    this.number += 1;
    this.records = 0;
    this.bytes = 0;
    const path = join(this.folder, partName(this.number));
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the folder of a stream, its name checked
      mkdirSync(this.folder, { recursive: true });
      this.part = new Part(path);
    } catch (e) {
      throw new StreamError(`${path}: cannot be written: ${String(e)}`, { cause: e });
    }
    return this.part;
  }

  async close(): Promise<void> {
    const part = this.part;
    if (part !== undefined) {
      this.part = undefined;
      try {
        await part.close();
      } catch (e) {
        throw new StreamError(`${this.folder}: cannot be written: ${String(e)}`, { cause: e });
      }
    }
  }
}

/**
 * The records a step refuses for a stream: `rejected/<stream>/<step>/`,
 * one line `{"record", "reason"}` each, with `"key"` when the stream has
 * key properties.
 */
class Rejected {
  private readonly parts: Parts;

  constructor(
    private readonly stream: string,
    readonly folder: string,
    private readonly keyProperties: readonly string[],
    private readonly maxRejected: number,
    private readonly limits: PartLimits,
  ) {
    this.parts = new Parts(folder, limits);
  }

  get count(): number {
    return this.parts.lines;
  }

  async add(record: JsonValue, reason: string): Promise<void> {
    const what = `stream ${this.stream}: a rejected record`;
    const entry: StreamRecord = { record, reason };
    if (this.keyProperties.length > 0 && isObject(record)) {
      const held = new Map(Object.entries(record));
      entry["key"] = Object.fromEntries(
        this.keyProperties.flatMap((name) => {
          const value = held.get(name);
          return value === undefined ? [] : [[name, value] as const];
        }),
      );
    }
    let data = line(entry, what);
    if (data.length > this.limits.bytes) {
      data = line({ record: null, reason: `${reason} (a record over ${String(this.limits.bytes)} bytes)` }, what);
    }
    await this.parts.write(data);
  }

  /**
   * Closes the files; `RejectedError` over the limit, unless the step
   * already fails for another reason.
   */
  async close(failing: boolean): Promise<void> {
    await this.parts.close();
    if (!failing && this.count > this.maxRejected) {
      throw new RejectedError(
        `stream ${this.stream}: ${String(this.count)} records rejected, ${String(this.maxRejected)} allowed (maxRejected): see ${this.folder} in the files of the step`,
      );
    }
  }
}

/**
 * Runs `body` with `stream`, then closes it: the step fails at the end when
 * it rejected too many records, unless `body` already failed.
 */
async function used<S extends { close(closing?: Closing): Promise<void> }, T>(
  stream: S,
  body: (stream: S) => T | Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await body(stream);
  } catch (e) {
    await stream.close({ failing: true });
    throw e;
  }
  await stream.close();
  return result;
}

/**
 * Writes the records of a stream the action produces. Give the work to
 * `use`: at its end, it closes the files and fails the step when more
 * records were rejected than `maxRejected`.
 */
export class StreamWriter {
  /** Made by `Streams.writer`. */
  constructor(
    readonly stream: string,
    readonly schema: RecordSchema,
    readonly keyProperties: readonly string[],
    readonly validate: boolean,
    private readonly limits: PartLimits,
    private readonly parts: Parts,
    private readonly refused: Rejected,
  ) {}

  /**
   * Adds `record` to the stream; a record that does not fit the schema is
   * rejected with what it breaks.
   */
  async write(record: Readonly<StreamRecord>): Promise<void> {
    if (this.validate) {
      const problems = this.schema.problems(record);
      if (problems.length > 0) {
        await this.reject(record, problems.join("; "));
        return;
      }
    }
    const data = line(record, `stream ${this.stream}: a record`);
    if (data.length > this.limits.bytes) {
      await this.reject(null, `a record of ${String(data.length)} bytes, over ${String(this.limits.bytes)}`);
      return;
    }
    await this.parts.write(data);
  }

  /** Keeps `record` out of the stream, with why, in the rejected records of the step. */
  reject(record: JsonValue, reason: string): Promise<void> {
    return this.refused.add(record, reason);
  }

  /** The records written so far. */
  get written(): number {
    return this.parts.lines;
  }

  /** The records rejected so far. */
  get rejected(): number {
    return this.refused.count;
  }

  /** Closes the files; `RejectedError` over `maxRejected`, unless the step is `failing`. */
  async close(closing: Closing = {}): Promise<void> {
    await this.parts.close();
    await this.refused.close(closing.failing === true);
  }

  /** Runs `body`, then closes the stream, whether `body` fails or not. */
  use<T>(body: (writer: this) => T | Promise<T>): Promise<T> {
    return used(this, body);
  }
}

/**
 * Reads the records of a stream the step consumes, in the order they were
 * written (`for await`). Give the work to `use`, as for `StreamWriter`.
 */
export class StreamReader implements AsyncIterable<StreamRecord> {
  /** Made by `Streams.reader`. */
  constructor(
    /** The name the step reads it under (`contacts`, `crm.contacts`). */
    readonly name: string,
    /** The name its producer gave it. */
    readonly stream: string,
    readonly schema: RecordSchema,
    readonly keyProperties: readonly string[],
    readonly bookmarkProperties: readonly string[],
    readonly validate: boolean,
    private readonly limits: PartLimits,
    private readonly files: readonly string[],
    private readonly refused: Rejected,
  ) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamRecord, void, undefined> {
    for (const path of this.files) {
      yield* this.records(path);
    }
  }

  private async *records(path: string): AsyncGenerator<StreamRecord, void, undefined> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let number = 0;
    for await (const data of lines(path, this.limits.bytes)) {
      number += 1;
      let record: JsonValue;
      try {
        record = parse(decoder.decode(data));
      } catch (e) {
        throw new StreamError(`${path}: line ${String(number)} is not JSON: ${String(e)}`, { cause: e });
      }
      if (!this.validate) {
        if (!isObject(record)) {
          throw new StreamError(`${path}: line ${String(number)} is not a JSON object`);
        }
        yield record;
        continue;
      }
      const problems = this.schema.problems(record);
      if (problems.length > 0 || !isObject(record)) {
        await this.reject(record, problems.join("; "));
      } else {
        yield record;
      }
    }
  }

  /**
   * Counts `record` as one the step refuses (not fitting the schema, or
   * refused by where it loads it), with why, in its rejected records.
   */
  reject(record: JsonValue, reason: string): Promise<void> {
    return this.refused.add(record, reason);
  }

  /** The records rejected so far. */
  get rejected(): number {
    return this.refused.count;
  }

  /** Closes the files; `RejectedError` over `maxRejected`, unless the step is `failing`. */
  close(closing: Closing = {}): Promise<void> {
    return this.refused.close(closing.failing === true);
  }

  /** Runs `body`, then closes the stream, whether `body` fails or not. */
  use<T>(body: (reader: this) => T | Promise<T>): Promise<T> {
    return used(this, body);
  }
}

/**
 * The lines of the gzip file `path`, each with its line feed, read a piece
 * at a time: the memory holds one line, never the file. `StreamError` for a
 * line over `maxBytes`, and for a file that cannot be read.
 */
async function* lines(path: string, maxBytes: number): AsyncGenerator<Uint8Array, void, undefined> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a part listed in the folder of the stream
  const source: AsyncIterable<Uint8Array> = pipeline(createReadStream(path), createGunzip(), () => {
    // The loop below gets the error of the file and of gzip.
  });
  let pieces: Uint8Array[] = [];
  let size = 0;
  let number = 1;
  const add = (piece: Uint8Array): void => {
    pieces.push(piece);
    size += piece.length;
    if (size > maxBytes) {
      throw new StreamError(`${path}: line ${String(number)} is over ${String(maxBytes)} bytes`);
    }
  };
  const take = (): Uint8Array => {
    const whole = pieces.length === 1 && pieces[0] !== undefined ? pieces[0] : Buffer.concat(pieces);
    pieces = [];
    size = 0;
    number += 1;
    return whole;
  };
  try {
    for await (const chunk of source) {
      let rest = chunk;
      for (let end = rest.indexOf(LINE_FEED); end !== -1; end = rest.indexOf(LINE_FEED)) {
        add(rest.subarray(0, end + 1));
        yield take();
        rest = rest.subarray(end + 1);
      }
      if (rest.length > 0) {
        add(rest);
      }
    }
  } catch (e) {
    if (e instanceof StreamError) {
      throw e;
    }
    throw new StreamError(`${path}: cannot be read: ${String(e)}`, { cause: e });
  }
  if (size > 0) {
    yield take();
  }
}

export interface WriterOptions {
  /** The properties that name a record, for the step that loads it. */
  readonly keyProperties?: readonly string[];
  /** The properties that say where the stream starts again. */
  readonly bookmarkProperties?: readonly string[];
  /** The number of rejected records the step accepts before it fails, at the end: 0 by default. */
  readonly maxRejected?: number;
  /** `false`: the records are not checked against the schema. */
  readonly validate?: boolean;
}

export type ReaderOptions = Pick<WriterOptions, "maxRejected" | "validate">;

/**
 * The streams of the step: those it produces (`streams.produces` of the
 * action) and those it consumes (`streams.consumes`).
 */
export class Streams {
  constructor(
    /** `$CRONPLANE_FILES`; none when the step sends files by `files.include`. */
    readonly files: string | undefined,
    /** `$CRONPLANE_NEEDED_FILES`. */
    readonly needed: string | undefined,
    /** `$CRONPLANE_STEP_ID`. */
    readonly step: string,
    /** When a part is closed: the limits of the contract (others in tests only). */
    private readonly limits: PartLimits = LIMITS,
  ) {}

  /**
   * Starts the stream `stream`: writes its `schema.json`, then takes its
   * records.
   */
  writer(stream: string, schema: JsonValue, options: WriterOptions = {}): StreamWriter {
    if (!STREAM.test(stream)) {
      throw new StreamError(`stream ${JSON.stringify(stream)} must match ^[a-z][a-z0-9_]{0,62}$`);
    }
    if (this.files === undefined) {
      throw new StreamError(
        "CRONPLANE_FILES is not set: an action that produces streams sends the files of $CRONPLANE_FILES (no files.include)",
      );
    }
    const recordSchema = RecordSchema.parse(schema);
    const folder = join(this.files, "streams", stream);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- under the path Cronplane gives, the name checked above
    if (existsSync(folder)) {
      throw new StreamError(`stream ${stream}: already written by this step`);
    }
    const keys = [...(options.keyProperties ?? [])];
    const described = line(
      {
        version: VERSION,
        stream,
        schema: recordSchema.source,
        key_properties: keys,
        bookmark_properties: [...(options.bookmarkProperties ?? [])],
        encoding: ENCODING,
      },
      `stream ${stream}: its schema`,
    );
    const refused = this.rejected(this.files, stream, keys, options.maxRejected ?? 0);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the folder checked above
      mkdirSync(folder, { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- in the folder checked above
      writeFileSync(join(folder, SCHEMA_FILE), described);
    } catch (e) {
      throw new StreamError(`${folder}: cannot be written: ${String(e)}`, { cause: e });
    }
    return new StreamWriter(
      stream,
      recordSchema,
      keys,
      options.validate ?? true,
      this.limits,
      new Parts(folder, this.limits),
      refused,
    );
  }

  /**
   * Opens the stream `name`, as `streams.consumes` writes it: `contacts`,
   * or `crm.contacts` after the step that produces it.
   */
  reader(name: string, options: ReaderOptions = {}): StreamReader {
    if (!CONSUMED.test(name)) {
      throw new StreamError(`stream ${JSON.stringify(name)}: a stream (contacts) or <step>.<stream>`);
    }
    if (this.needed === undefined) {
      throw new StreamError("CRONPLANE_NEEDED_FILES is not set: is this step run by Cronplane?");
    }
    const folder = join(this.needed, "streams", name);
    const where = join(folder, SCHEMA_FILE);
    const described = describedIn(where);
    const stream = described.get("stream");
    if (typeof stream !== "string" || !STREAM.test(stream)) {
      throw new StreamError(`${where}: stream is the name of a stream`);
    }
    const version = described.get("version");
    if (version !== VERSION) {
      throw new StreamError(
        `${where}: version ${JSON.stringify(version ?? null)}: this library reads version ${String(VERSION)}`,
      );
    }
    const encoding = described.get("encoding");
    if (!isEncoding(encoding)) {
      throw new StreamError(
        `${where}: encoding ${JSON.stringify(encoding ?? null)}: this library reads jsonl compressed with gzip`,
      );
    }
    const keys = names(described.get("key_properties"), "key_properties", where);
    const schema = RecordSchema.parse(described.get("schema") ?? null);
    const bookmarks = names(described.get("bookmark_properties"), "bookmark_properties", where);
    const files = partFiles(folder);
    if (this.files === undefined) {
      throw new StreamError(
        "CRONPLANE_FILES is not set: an action that reads streams sends its rejected records with the files of $CRONPLANE_FILES (no files.include)",
      );
    }
    return new StreamReader(
      name,
      stream,
      schema,
      keys,
      bookmarks,
      options.validate ?? true,
      this.limits,
      files,
      this.rejected(this.files, stream, keys, options.maxRejected ?? 0),
    );
  }

  private rejected(files: string, stream: string, keys: readonly string[], maxRejected: number): Rejected {
    if (!Number.isInteger(maxRejected) || maxRejected < 0) {
      throw new StreamError(`maxRejected is 0 or more, not ${String(maxRejected)}`);
    }
    return new Rejected(stream, join(files, "rejected", stream, this.step), keys, maxRejected, this.limits);
  }
}

/** Whether `value` is the encoding this library reads, and nothing more. */
function isEncoding(value: JsonValue | undefined): boolean {
  if (value === undefined || !isObject(value)) {
    return false;
  }
  const given = Object.entries(value);
  const expected = new Map<string, JsonValue>(Object.entries(ENCODING));
  return given.length === expected.size && given.every(([name, item]) => expected.get(name) === item);
}

/** `schema.json` of a stream, at `path`: its fields by name. */
function describedIn(path: string): ReadonlyMap<string, JsonValue> {
  let described: JsonValue;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- under the path Cronplane gives, the name checked
    described = parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (isMissing(e)) {
      throw new StreamError(
        `${path}: no such stream: is it in streams.consumes of the action, and produced by a step this step needs?`,
        { cause: e },
      );
    }
    throw new StreamError(`${path}: cannot be read: ${String(e)}`, { cause: e });
  }
  if (!isObject(described)) {
    throw new StreamError(`${path}: a JSON object is expected`);
  }
  return new Map(Object.entries(described));
}

/** The parts of the stream in `folder`, in order: numbered from 1, none missing. */
function partFiles(folder: string): readonly string[] {
  const numbers: number[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the folder of a stream, its name checked
  for (const entry of readdirSync(folder)) {
    if (entry === SCHEMA_FILE) {
      continue;
    }
    const digits = PART.exec(entry)?.[1];
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- an entry of the folder
    if (digits === undefined || !statSync(join(folder, entry)).isFile()) {
      throw new StreamError(`${join(folder, entry)}: not a file of a stream (schema.json, part-00001.jsonl.gz…)`);
    }
    numbers.push(Number(digits));
  }
  numbers.sort((a, b) => a - b);
  if (numbers.some((number, index) => number !== index + 1)) {
    throw new StreamError(`${folder}: its parts are numbered from 1, none missing`);
  }
  return numbers.map((number) => join(folder, partName(number)));
}
