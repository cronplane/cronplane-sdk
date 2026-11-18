# The contract

The contract between the steps of a [Cronplane](https://github.com/cronplane/cronplane-ce) flow, as data: the cases every library for actions must pass. The contract itself is in Cronplane's `SPEC.md` (§18: streams, state and allowed hosts). The libraries (`python/` and `typescript/`) run its cases in their tests, so that a rule is declared once and both libraries agree.

## `schema/cases.json`: the schema of a record

A stream carries a `schema.json` whose `schema` is a JSON Schema of one record. The libraries check each record against it when they write it and when they read it. They read a subset of JSON Schema, the same in every language, and refuse a schema that uses anything else: a keyword is never ignored.

| Field | Content |
|---|---|
| `version` | The version of this file: 1. |
| `keywords` | The keywords a schema may use, each with what it means. |
| `annotations` | The keywords accepted and not checked. |
| `limits.depth` | The deepest schema accepted: a schema nested deeper is refused. |
| `schemas` | Schemas accepted, each with records that are `valid` and records that are `invalid`. |
| `refused` | Schemas refused, each with one flaw. |

The rules, beyond the meaning of each keyword:

- The schema of a record has `type: object`, alone.
- A keyword applies to the values of its type only (`minLength` to a string, `minimum` to a number), as in JSON Schema. A schema without `type` accepts any value.
- An `integer` is a number without a fraction (`1.0` is one). A boolean is never a number.
- An `enum` compares values as JSON does: `1` equals `1.0`, `true` does not equal `1`.
- A length is counted in Unicode code points.
- `format: date-time` is RFC 3339 with ASCII digits: a real date (leap years by the Gregorian rule, year `0000` included), an hour up to 23, minutes and seconds up to 59, a zone `Z` or `±hh:mm` up to `23:59`.

An invalid record lists **every** problem it has: `at`, the place of the value in the record as a JSON Pointer (RFC 6901, `""` for the record itself; a property missing is at the place it would have), and `keyword`, the keyword it breaks. A library reports the same set, in any order.

A refused schema has one problem: `at`, the place of the schema at fault within the schema, as a JSON Pointer, and `keyword`, the keyword at fault (`""` when the schema is not an object).

A library builds its own test of `limits.depth`: a schema nested that deep is accepted, one level deeper is refused.

## `network/cases.json`: the hosts a step may reach

A step with `network: {allow: [...]}` gets its hosts in `CRONPLANE_NETWORK_ALLOW`, one per line. The libraries refuse any other host before they connect.

| Field | Content |
|---|---|
| `version` | The version of this file: 1. |
| `variable` | The variable that carries the list. |
| `hosts.valid`, `hosts.invalid` | Lines the libraries read, and lines they refuse: a line they cannot read is an error, never a host ignored. |
| `lists` | Lists (`allow`), each with the hosts and ports it lets through (`allowed`) and those it stops (`refused`), as `[host, port]`. |

The rules:

- A host of the list is a name, a name under a domain (`*.example.com`: any name that ends with `.example.com`, never `example.com` itself) or an IP address, in lowercase, with an optional port. Without a port, any port.
- The host a step asks for is compared as a name: without its case nor a final dot. An address is compared as an address, whatever its writing; a name of the list never allows an address, nor an address a name.
- Without the variable, every host is allowed. A variable that is set carries one host at least: an empty one is an error.

## `streams/`: a stream as its files

`streams/golden/` is what a step `export` sends for the stream `contacts`: `streams/contacts/schema.json`, its records in two parts, and the records it rejected in `rejected/contacts/export/`. `streams/cases.json` says how it was written and how it reads.

| Field | Content |
|---|---|
| `limits` | A part is closed at `part_records` records or `part_bytes` bytes before compression, whichever comes first; a record is never larger than a part. |
| `write` | What the step gave (`stream`, `schema`, `key_properties`, `bookmark_properties`, `records`, with `max_rejected` rejected records allowed) and what a library writes from it: `schema_json`, the `lines` of its parts in order, and the `rejected_lines`. |
| `read` | What a library reads in `streams/golden/` for the stream `name`: its `parts`, its key and bookmark properties and its `records`, in order. |

The rules:

- A line is one JSON object in UTF-8, without spaces between its tokens, its properties in the order the step gave them, then a line feed. The cases hold no number with a fraction: languages write them differently, and a reader reads them all.
- `schema.json` is one line of the same form.
- A rejected line is `{"record": …, "reason": …}`, with `"key"` (the key properties the record has) when the stream has key properties. `reason` lists what the record breaks, each as `<place>: <keyword>` joined by `; `, in the order of the record: the properties missing first, then each property in the order the record holds them.
- The golden parts hold 3 records each, so that a reader meets several parts: a library does not have to write the same compressed bytes, only the same lines.

## Changing the cases

A case added is a rule both libraries must pass in the same commit. A case changed or removed changes the contract: say so in the commit, and in `SPEC.md`.

## `version/cases.json`: the version of Cronplane a library needs

A worker gives every step its version in `CRONPLANE_VERSION` (`0.1.0`). A library carries the oldest Cronplane it works with, a major and a minor (`0.1`), and refuses to start on an older one, or on another major.

| Field | Content |
|---|---|
| `version` | The version of this file: 1. |
| `variable` | The variable that carries the version of Cronplane. |
| `since` | Each part of the contract, with the minor of Cronplane it appeared in. |
| `accepted` | A version needed (`needs`) and a version of Cronplane it starts on. |
| `refused` | The same, with the `message` of the error; `cronplane: null` is a worker that does not give the variable. |
| `malformed` | Values of the variable that are not a version: each is refused. |

The rules:

- A version of Cronplane is `major.minor.patch`, three numbers; what follows a `-` or a `+` is not read.
- The library starts when the major is the same and the minor is the one needed or a later one. The patch is not compared.
- The version a library needs is the latest of `since` among the parts it implements: its tests check it.
- A part added to the contract enters `since` with the minor of Cronplane that brings it.

