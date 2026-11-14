# @cronplane/actions

Write [Cronplane](https://github.com/cronplane/cronplane-ce) actions in TypeScript, for Bun. The package has no dependency at run time, and ships its TypeScript sources: Bun runs them as they are. It supports Bun 1.2, 1.3 and 1.4: the CI tests each. `engines` in `package.json` gives the oldest only, because Bun does not read it; a newer minor is supported when the CI tests it, and Cronplane carries its image only then.

```ts
import { Action } from "@cronplane/actions";

const action = Action.fromEnvironment();

const url = action.inputs.string("url");
const hosts = action.inputs.items("hosts");

const token = (await action.http.postJson(url, { scope: "read" })).json();
action.mask(String(token)); // before the step can print it

action.outputs.set("count", hosts.length);
```

## What it gives

| API | Use |
|---|---|
| `Action.fromEnvironment()` | Reads what Cronplane gives the step, once. Throws `ActionError` when the step is not run as an action. |
| `action.inputs.string(name)`, `.integer`, `.boolean`, `.items`, `.entries`, `.has` | The values of the inputs, typed as `action.yaml` declares them (`$CRONPLANE_WITH`). `enum` reads as a string, `list` as items, `map` as entries (a `Map`). |
| `action.outputs.set(name, value)` | Writes the output (`$CRONPLANE_OUTPUT`) again, whole, at once. 1 MiB at most. Cronplane checks it against the `outputs:` of the action. |
| `action.secret(name)` | A secret: its variable, or its file (`delivery: file`). Cronplane masks it. |
| `action.mask(value)` | Hides a value the step gets while it runs (a token, a password it makes) in its log, error and output (`$CRONPLANE_MASK`). Call it before the value can be printed. Values shorter than 3 characters and encoded forms (base64, URL) are not masked. |
| `action.needed()`, `action.trigger()` | The outputs of the steps it needs; what started the run (`needs_trigger: true`). |
| `action.http` | An HTTP/1.1 client: `get`, `post`, `postJson`, `request`. |
| `action.streams.writer(stream, schema, …)`, `.reader(name)` | The streams of records the action produces and consumes (`streams:` of `action.yaml`). |
| `action.state` | Where the step starts again at its next run (`state: true`): `get`, `set`, `stream`, `setStream`. |
| `action.network.resolve(host, port)` | The checked addresses of a host, for a connection the HTTP client does not make (a database). |

## Streams

A stream passes records from a step to the steps that need it. The action declares them (`streams: {produces: [contacts], consumes: [companies]}`); Cronplane checks how the steps of a flow plug into each other when the flow is pushed.

```ts
const SCHEMA = {
  type: "object",
  properties: { id: { type: "integer" }, email: { type: "string" } },
  required: ["id", "email"],
};

await action.streams.writer("contacts", SCHEMA, { keyProperties: ["id"] }).use(async (contacts) => {
  for (const row of rows) {
    await contacts.write(row);
  }
});

// Or "crm.contacts", as consumes writes it.
await action.streams.reader("contacts").use(async (contacts) => {
  for await (const record of contacts) {
    await load(record);
  }
});
```

- **The schema** is a subset of JSON Schema, the same in every library for actions: `type`, `properties`, `required`, `additionalProperties`, `items`, `minItems`, `maxItems`, `enum`, `minLength`, `maxLength`, `minimum`, `maximum`, `format: date-time`, and the annotations `$schema`, `title`, `description`, `default`, `examples`. Any other keyword is refused with `SchemaError`: a keyword is never ignored. `RecordSchema.parse(schema).problems(record)` checks a record on its own.
- **A record that does not fit** is not passed on. It goes to the rejected records of the step (`rejected/<stream>/<step>/` in its files) with what it breaks (`/email: type`), and the step goes on. At the end of `use`, the stream is closed: it throws `RejectedError` when more records were rejected than `maxRejected` (0 by default), so the step fails, after it wrote every rejected record. Let the user of the action raise the limit with an input (`maxRejected: action.inputs.integer("max_rejected")`). `writer.reject(record, reason)` and `reader.reject(record, reason)` add the records the action refuses for its own reasons (an error of the API it loads them to).
- **`use` closes the stream** whether its function fails or not, and a failure of the function is the one the step fails with: its rejected records never hide it. Without `use`, call `close()` at the end, and `close({ failing: true })` when the step already fails. `using` is not offered: it cannot tell a block that fails from one that ends well.
- **The rejected records of a step that failed** stay readable: a step that declares streams sends its files whatever its end. `action.yaml` needs no `files: {on_failure: true}` for that.
- The checks are on when a stream is written and when it is read; `validate: false` turns them off.
- The files are those of the contract (`SPEC.md` §18.1 of Cronplane): `schema.json`, then `part-00001.jsonl.gz`… of one JSON object per line, a part closed at 100,000 records or 64 MiB. The action sends the files of `$CRONPLANE_FILES` (no `files.include`). A part is written and read a piece at a time: the memory holds one record, never a part. Numbers beyond 2^53 and numbers with a fraction are read as each language reads JSON: keep identifiers that large as text.

## State

With `state: true`, Cronplane keeps one JSON value for the step between runs, 32 KiB at most, when the whole run succeeds: where to start again, never data.

```ts
const since = action.state.stream("contacts")["cursor"];
…
action.state.setStream("contacts", { cursor: lastUpdatedAt });
```

`stream` and `setStream` keep one entry per stream (`{"version": 1, "streams": {…}}`); `get` and `set` read and write the whole value, of any form. A run that fails keeps nothing: the next run starts from the last state kept, so write records in a way that can be written twice (an upsert).

## Allowed hosts

With `network: {allow: [...]}`, the step gets the only hosts it may reach in `CRONPLANE_NETWORK_ALLOW`. `action.http` refuses any other with `EgressError`, before it resolves the name, and for each redirect. For a connection it does not make itself, ask for the addresses checked and connect to one of them:

```ts
const [address] = await action.network.resolve("db.acme.internal", 5432);
```

Code that opens its own connections is not limited by the list: the isolations of Cronplane do not enforce it yet.

## HTTP and SSRF

On a worker started with `--egress public` (a machine that runs the steps of several customers), steps get `CRONPLANE_EGRESS=public`. Then `action.http` refuses, with `EgressError`, every address that is not public: private, loopback, link-local (cloud metadata), shared (CGNAT), documentation, multicast, reserved, IPv6 outside global unicast, and IPv6 addresses carrying one of them (mapped, 6to4, NAT64).

- The name is resolved once. Every address is checked, and the connection goes to an address checked (the request's `lookup`), so a second resolution cannot change it (DNS rebinding).
- Each redirect is checked the same way. A redirect never goes from https to http, and credentials (`Authorization`, `Cookie`) go to the same origin only.
- TLS is verified against the name in the URL. `caFile` trusts the CA of a server instead of the system's. There is no option to skip verification.
- Each request has a timeout (30 s), a response limit (10 MiB) and at most 5 redirects. No proxy is used. Credentials in the URL are refused: pass them in a header.

The guard is a defence in depth with a clear message. The network rules of the worker are what forbids those addresses.

Without `CRONPLANE_EGRESS` (your own workers), every address is allowed.

## Development

The cases shared with the other libraries are in `../contract/`:

```sh
bun install
bun run check   # tsc, ESLint (strictTypeChecked, security), bun test with coverage, bun audit --production
bun audit       # the advisories of the development tools too: read them, they fail nothing
```

- `bun run check` is for Bun 1.4, which wrote `bun.lock`. Bun 1.2 and 1.3 cannot read that file, and they count the functions of a class another way: the CI runs `bun test` on them, without the lockfile nor the coverage threshold.
- TypeScript stays on 6.x: typescript-eslint does not support TypeScript 7 yet.
- `overrides` pins `minimatch` to 11, which fixes GHSA-g3hv-75wg-m249: ESLint's chain asks for 10.x, vulnerable.

Licence: Apache-2.0.

## The Cronplane it needs

The library `X.Y` is published with Cronplane `X.Y` and works with that Cronplane or a newer one of the same major version. `REQUIRES_CRONPLANE` is the oldest Cronplane it really works with (`0.1`). A worker gives its version in `CRONPLANE_VERSION`; `Action.fromEnvironment()` fails with a `VersionError` on an older Cronplane, on another major version, or when the worker does not say its version. Before `1.0`, a minor version of Cronplane may break the previous one.

An action written with the library says so in its `action.yaml`: `requires: {cronplane: ">=0.1"}`. Cronplane refuses the push of a flow that uses the action on an older Cronplane, and the kit checks that the action names at least what the library needs.
