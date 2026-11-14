# cronplane-actions

Write [Cronplane](https://github.com/cronplane/cronplane-ce) actions in Python. The package has no dependency at run time.

```python
from cronplane_actions import Action

action = Action.from_environment()

url = action.inputs.string("url")
hosts = action.inputs.items("hosts")

token = action.http.post_json(url, {"scope": "read"}).json()
action.mask(token["value"])  # before the step can print it

action.outputs.set("count", len(hosts))
```

## What it gives

| API | Use |
|---|---|
| `Action.from_environment()` | Reads what Cronplane gives the step, once. Raises `ActionError` when the step is not run as an action. |
| `action.inputs.string(name)`, `.integer`, `.boolean`, `.items`, `.entries`, `.has` | The values of the inputs, typed as `action.yaml` declares them (`$CRONPLANE_WITH`). `enum` reads as a string, `list` as items, `map` as entries. |
| `action.outputs.set(name, value)` | Writes the output (`$CRONPLANE_OUTPUT`) again, whole, at once. 1 MiB at most. Cronplane checks it against the `outputs:` of the action. |
| `action.secret(name)` | A secret: its variable, or its file (`delivery: file`). Cronplane masks it. |
| `action.mask(value)` | Hides a value the step gets while it runs (a token, a password it makes) in its log, error and output (`$CRONPLANE_MASK`). Call it before the value can be printed. Values shorter than 3 characters and encoded forms (base64, URL) are not masked. |
| `action.needed()`, `action.trigger()` | The outputs of the steps it needs; what started the run (`needs_trigger: true`). |
| `action.http` | An HTTP/1.1 client: `get`, `post`, `post_json`, `request`. |
| `action.streams.writer(stream, schema, …)`, `.reader(name)` | The streams of records the action produces and consumes (`streams:` of `action.yaml`). |
| `action.state` | Where the step starts again at its next run (`state: true`): `get`, `set`, `stream`, `set_stream`. |
| `action.network.resolve(host, port)` | The checked addresses of a host, for a connection the HTTP client does not make (a database). |

## Streams

A stream passes records from a step to the steps that need it. The action declares them (`streams: {produces: [contacts], consumes: [companies]}`); Cronplane checks how the steps of a flow plug into each other when the flow is pushed.

```python
SCHEMA = {
    "type": "object",
    "properties": {"id": {"type": "integer"}, "email": {"type": "string"}},
    "required": ["id", "email"],
}

with action.streams.writer("contacts", SCHEMA, key_properties=["id"]) as contacts:
    for row in rows:
        contacts.write(row)

with action.streams.reader("contacts") as contacts:  # or "crm.contacts", as consumes writes it
    for record in contacts:
        load(record)
```

- **The schema** is a subset of JSON Schema, the same in every library for actions: `type`, `properties`, `required`, `additionalProperties`, `items`, `minItems`, `maxItems`, `enum`, `minLength`, `maxLength`, `minimum`, `maximum`, `format: date-time`, and the annotations `$schema`, `title`, `description`, `default`, `examples`. Any other keyword is refused with `SchemaError`: a keyword is never ignored. `RecordSchema.parse(schema).problems(record)` checks a record on its own.
- **A record that does not fit** is not passed on. It goes to the rejected records of the step (`rejected/<stream>/<step>/` in its files) with what it breaks (`/email: type`), and the step goes on. Leaving the `with` block raises `RejectedError` when more records were rejected than `max_rejected` (0 by default): the step fails, after it wrote every rejected record. Let the user of the action raise the limit with an input (`max_rejected=action.inputs.integer("max_rejected")`). `writer.reject(record, reason)` and `reader.reject(record, reason)` add the records the action refuses for its own reasons (an error of the API it loads them to).
- **The rejected records of a step that failed** stay readable: a step that declares streams sends its files whatever its end. `action.yaml` needs no `files: {on_failure: true}` for that.
- The checks are on when a stream is written and when it is read; `validate=False` turns them off.
- The files are those of the contract (`SPEC.md` §18.1 of Cronplane): `schema.json`, then `part-00001.jsonl.gz`… of one JSON object per line, a part closed at 100,000 records or 64 MiB. The action sends the files of `$CRONPLANE_FILES` (no `files.include`). Numbers beyond 2^53 and numbers with a fraction are read as each language reads JSON: keep identifiers that large as text.

## State

With `state: true`, Cronplane keeps one JSON value for the step between runs, 32 KiB at most, when the whole run succeeds: where to start again, never data.

```python
since = action.state.stream("contacts").get("cursor")
…
action.state.set_stream("contacts", {"cursor": last_updated_at})
```

`stream` and `set_stream` keep one entry per stream (`{"version": 1, "streams": {…}}`); `get` and `set` read and write the whole value, of any form. A run that fails keeps nothing: the next run starts from the last state kept, so write records in a way that can be written twice (an upsert).

## Allowed hosts

With `network: {allow: [...]}`, the step gets the only hosts it may reach in `CRONPLANE_NETWORK_ALLOW`. `action.http` refuses any other with `EgressError`, before it resolves the name, and for each redirect. For a connection it does not make itself, ask for the addresses checked and connect to one of them:

```python
address = action.network.resolve("db.acme.internal", 5432)[0]
```

Code that opens its own connections is not limited by the list: the isolations of Cronplane do not enforce it yet.

## HTTP and SSRF

On a worker started with `--egress public` (a machine that runs the steps of several customers), steps get `CRONPLANE_EGRESS=public`. Then `action.http` refuses, with `EgressError`, every address that is not public: private, loopback, link-local (cloud metadata), shared (CGNAT), multicast, reserved, and IPv6 addresses carrying one of them (mapped, 6to4, NAT64).

- The name is resolved once. Every address is checked, and the connection goes to an address checked, so a second resolution cannot change it (DNS rebinding).
- Each redirect is checked the same way. A redirect never goes from https to http, and credentials (`Authorization`, `Cookie`) go to the same origin only.
- TLS is verified against the name in the URL. `ca_file` trusts the CA of a server instead of the system's. There is no option to skip verification.
- Each request has a timeout (30 s), a response limit (10 MiB) and at most 5 redirects. No proxy is used. Credentials in the URL are refused: pass them in a header.

The guard is a defence in depth with a clear message. The network rules of the worker are what forbids those addresses.

Without `CRONPLANE_EGRESS` (your own workers), every address is allowed.

## Development

The cases shared with the other libraries are in `../contract/`:

```sh
uv sync
uv run ruff format --check && uv run ruff check
uv run pyright
uv run pytest
# What an action installs with the library: a known advisory fails.
uv export --locked --no-emit-project --no-dev --format requirements-txt > requirements.txt
uv run pip-audit --strict -r requirements.txt
# The development tools too: read their advisories, they fail nothing.
uv export --locked --no-emit-project --format requirements-txt > requirements-dev.txt
uv run pip-audit --strict -r requirements-dev.txt
```

Licence: Apache-2.0.

## The Cronplane it needs

The library `X.Y` is published with Cronplane `X.Y` and works with that Cronplane or a newer one of the same major version. `REQUIRES_CRONPLANE` is the oldest Cronplane it really works with (`0.1`). A worker gives its version in `CRONPLANE_VERSION`; `Action.from_environment()` fails with a `VersionError` on an older Cronplane, on another major version, or when the worker does not say its version. Before `1.0`, a minor version of Cronplane may break the previous one.

An action written with the library says so in its `action.yaml`: `requires: {cronplane: ">=0.1"}`. Cronplane refuses the push of a flow that uses the action on an older Cronplane, and the kit checks that the action names at least what the library needs.
