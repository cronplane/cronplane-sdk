"""Streams of records between steps (the contract of Cronplane, version 1).

A stream is a folder of the files a step sends: `schema.json`, then its
records, one JSON object per line, in gzip parts read in the order of their
names. A record that does not fit the schema is not passed on: it goes to
the rejected records of the step, and the step fails at the end when there
are more of them than it allows.
"""

from __future__ import annotations

import gzip
import json
import re
import zlib
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from types import TracebackType
from typing import Final, Self

from ._errors import RejectedError, StreamError
from ._json import JsonValue, parse
from ._schema import RecordSchema

#: The version of the contract this library reads and writes.
VERSION: Final = 1
#: A part is closed at this number of records, or at `MAX_PART_BYTES`.
MAX_PART_RECORDS: Final = 100_000
#: The size of a part before compression; a record is never larger.
MAX_PART_BYTES: Final = 64 << 20

_ENCODING: Final[Mapping[str, JsonValue]] = {"format": "jsonl", "compression": "gzip"}
_STREAM: Final = re.compile(r"[a-z][a-z0-9_]{0,62}")
# A stream as a step reads it: alone, or after the step that produces it.
_CONSUMED: Final = re.compile(r"(?:[a-z][a-z0-9_-]{0,62}\.)?[a-z][a-z0-9_]{0,62}")
_PART: Final = re.compile(r"part-([0-9]{5})\.jsonl\.gz")
_SCHEMA_FILE: Final = "schema.json"


def _line(value: JsonValue, what: str) -> bytes:
    """`value` as one line of a part."""
    try:
        text = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError) as e:
        raise StreamError(f"{what}: not a JSON value: {e}") from e
    return text.encode() + b"\n"


def _names(value: JsonValue, field_name: str, where: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or not all(isinstance(name, str) for name in value):
        raise StreamError(f"{where}: {field_name} is a list of property names")
    return tuple(str(name) for name in value)


@dataclass
class _Parts:
    """Lines written to `part-00001.jsonl.gz`, `part-00002.jsonl.gz`… of a
    folder, each part closed at the limits of the contract."""

    folder: Path
    max_records: int
    max_bytes: int
    lines: int = 0
    _number: int = 0
    _records: int = 0
    _bytes: int = 0
    _part: gzip.GzipFile | None = None

    def write(self, line: bytes) -> None:
        full = self._records >= self.max_records or self._bytes + len(line) > self.max_bytes
        part = self._part
        if part is None or full:
            part = self._next()
        try:
            part.write(line)
        except OSError as e:
            raise StreamError(f"{self.folder}: cannot be written: {e}") from e
        self._records += 1
        self._bytes += len(line)
        self.lines += 1

    def _next(self) -> gzip.GzipFile:
        """Closes the part being written and opens the one after it."""
        self.close()
        self._number += 1
        self._records = self._bytes = 0
        path = self.folder / f"part-{self._number:05d}.jsonl.gz"
        try:
            self.folder.mkdir(parents=True, exist_ok=True)
            # mtime=0: the same records give the same file.
            self._part = gzip.GzipFile(path, "wb", mtime=0)
        except OSError as e:
            raise StreamError(f"{path}: cannot be written: {e}") from e
        return self._part

    def close(self) -> None:
        if self._part is not None:
            part, self._part = self._part, None
            try:
                part.close()
            except OSError as e:
                raise StreamError(f"{self.folder}: cannot be written: {e}") from e


@dataclass
class _Rejected:
    """The records a step refuses for a stream: `rejected/<stream>/<step>/`,
    one line `{"record", "reason"}` each, with `"key"` when the stream has
    key properties."""

    stream: str
    folder: Path
    key_properties: tuple[str, ...]
    max_rejected: int
    _parts: _Parts = field(init=False)

    def __post_init__(self) -> None:
        self._parts = _Parts(self.folder, MAX_PART_RECORDS, MAX_PART_BYTES)

    @property
    def count(self) -> int:
        return self._parts.lines

    def add(self, record: JsonValue, reason: str) -> None:
        entry: dict[str, JsonValue] = {"record": record, "reason": reason}
        if self.key_properties and isinstance(record, dict):
            entry["key"] = {name: record[name] for name in self.key_properties if name in record}
        line = _line(entry, f"stream {self.stream}: a rejected record")
        if len(line) > MAX_PART_BYTES:
            line = _line(
                {"record": None, "reason": f"{reason} (a record over {MAX_PART_BYTES} bytes)"},
                f"stream {self.stream}: a rejected record",
            )
        self._parts.write(line)

    def close(self, *, failing: bool) -> None:
        """Closes the files; `RejectedError` over the limit, unless the step
        already fails for another reason."""
        self._parts.close()
        if not failing and self.count > self.max_rejected:
            raise RejectedError(
                f"stream {self.stream}: {self.count} records rejected, {self.max_rejected} "
                f"allowed (max_rejected): see {self.folder} in the files of the step"
            )


@dataclass
class StreamWriter:
    """Writes the records of a stream the action produces. Use it in a
    `with` block: leaving it closes the files and fails the step when more
    records were rejected than `max_rejected`."""

    stream: str
    schema: RecordSchema
    key_properties: tuple[str, ...]
    validate: bool
    _parts: _Parts
    _rejected: _Rejected

    def write(self, record: Mapping[str, JsonValue]) -> None:
        """Adds `record` to the stream; a record that does not fit the schema
        is rejected with what it breaks."""
        value: JsonValue = dict(record)
        if self.validate:
            problems = self.schema.problems(value)
            if problems:
                self.reject(value, "; ".join(str(p) for p in problems))
                return
        line = _line(value, f"stream {self.stream}: a record")
        if len(line) > MAX_PART_BYTES:
            self.reject(None, f"a record of {len(line)} bytes, over {MAX_PART_BYTES}")
            return
        self._parts.write(line)

    def reject(self, record: JsonValue, reason: str) -> None:
        """Keeps `record` out of the stream, with why, in the rejected records of the step."""
        self._rejected.add(record, reason)

    @property
    def written(self) -> int:
        """The records written so far."""
        return self._parts.lines

    @property
    def rejected(self) -> int:
        """The records rejected so far."""
        return self._rejected.count

    def close(self, *, failing: bool = False) -> None:
        self._parts.close()
        self._rejected.close(failing=failing)

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        kind: type[BaseException] | None,
        _error: BaseException | None,
        _trace: TracebackType | None,
    ) -> None:
        self.close(failing=kind is not None)


@dataclass
class StreamReader:
    """Reads the records of a stream the step consumes, in the order they
    were written. Use it in a `with` block, as `StreamWriter`."""

    #: The name the step reads it under (`contacts`, `crm.contacts`).
    name: str
    #: The name its producer gave it.
    stream: str
    schema: RecordSchema
    key_properties: tuple[str, ...]
    bookmark_properties: tuple[str, ...]
    validate: bool
    _files: tuple[Path, ...]
    _rejected: _Rejected

    def __iter__(self) -> Iterator[dict[str, JsonValue]]:
        for path in self._files:
            yield from self._records(path)

    def _records(self, path: Path) -> Iterator[dict[str, JsonValue]]:
        try:
            with gzip.open(path, "rb") as part:
                number = 0
                while line := part.readline(MAX_PART_BYTES + 1):
                    number += 1
                    if len(line) > MAX_PART_BYTES:
                        raise StreamError(f"{path}: line {number} is over {MAX_PART_BYTES} bytes")
                    try:
                        record = parse(line)
                    except ValueError as e:
                        raise StreamError(f"{path}: line {number} is not JSON: {e}") from e
                    if not self.validate:
                        if not isinstance(record, dict):
                            raise StreamError(f"{path}: line {number} is not a JSON object")
                        yield record
                        continue
                    problems = self.schema.problems(record)
                    if problems or not isinstance(record, dict):
                        self.reject(record, "; ".join(str(p) for p in problems))
                    else:
                        yield record
        except (OSError, EOFError, zlib.error) as e:
            raise StreamError(f"{path}: cannot be read: {e}") from e

    def reject(self, record: JsonValue, reason: str) -> None:
        """Counts `record` as one the step refuses (not fitting the schema, or
        refused by where it loads it), with why, in its rejected records."""
        self._rejected.add(record, reason)

    @property
    def rejected(self) -> int:
        """The records rejected so far."""
        return self._rejected.count

    def close(self, *, failing: bool = False) -> None:
        self._rejected.close(failing=failing)

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        kind: type[BaseException] | None,
        _error: BaseException | None,
        _trace: TracebackType | None,
    ) -> None:
        self.close(failing=kind is not None)


@dataclass(frozen=True)
class Streams:
    """The streams of the step: those it produces (`streams.produces` of the
    action) and those it consumes (`streams.consumes`)."""

    #: `$CRONPLANE_FILES`; none when the step sends files by `files.include`.
    files: Path | None
    #: `$CRONPLANE_NEEDED_FILES`.
    needed: Path | None
    #: `$CRONPLANE_STEP_ID`.
    step: str

    def writer(  # noqa: PLR0913 # each names one field of schema.json or one rule
        self,
        stream: str,
        schema: JsonValue,
        *,
        key_properties: Sequence[str] = (),
        bookmark_properties: Sequence[str] = (),
        max_rejected: int = 0,
        validate: bool = True,
    ) -> StreamWriter:
        """Starts the stream `stream`: writes its `schema.json`, then takes
        its records. `max_rejected` is the number of rejected records the
        step accepts before it fails, at the end."""
        if not _STREAM.fullmatch(stream):
            raise StreamError(f"stream {stream!r} must match ^[a-z][a-z0-9_]{{0,62}}$")
        if self.files is None:
            raise StreamError(
                "CRONPLANE_FILES is not set: an action that produces streams sends the files of "
                "$CRONPLANE_FILES (no files.include)"
            )
        record_schema = RecordSchema.parse(schema)
        folder = self.files / "streams" / stream
        if folder.exists():
            raise StreamError(f"stream {stream}: already written by this step")
        keys = tuple(key_properties)
        described: dict[str, JsonValue] = {
            "version": VERSION,
            "stream": stream,
            "schema": dict(record_schema.source),
            "key_properties": list(keys),
            "bookmark_properties": list(bookmark_properties),
            "encoding": dict(_ENCODING),
        }
        try:
            folder.mkdir(parents=True)
            (folder / _SCHEMA_FILE).write_bytes(_line(described, f"stream {stream}: its schema"))
        except OSError as e:
            raise StreamError(f"{folder}: cannot be written: {e}") from e
        return StreamWriter(
            stream,
            record_schema,
            keys,
            validate,
            _Parts(folder, MAX_PART_RECORDS, MAX_PART_BYTES),
            self._rejected(stream, keys, max_rejected),
        )

    def reader(self, name: str, *, max_rejected: int = 0, validate: bool = True) -> StreamReader:
        """Opens the stream `name`, as `streams.consumes` writes it: `contacts`,
        or `crm.contacts` after the step that produces it."""
        if not _CONSUMED.fullmatch(name):
            raise StreamError(f"stream {name!r}: a stream (contacts) or <step>.<stream>")
        if self.needed is None:
            raise StreamError("CRONPLANE_NEEDED_FILES is not set: is this step run by Cronplane?")
        folder = self.needed / "streams" / name
        described = _described(folder)
        stream = described.get("stream")
        if not isinstance(stream, str) or not _STREAM.fullmatch(stream):
            raise StreamError(f"{folder / _SCHEMA_FILE}: stream is the name of a stream")
        if described.get("version") != VERSION:
            raise StreamError(
                f"{folder / _SCHEMA_FILE}: version {described.get('version')!r}: this library "
                f"reads version {VERSION}"
            )
        if described.get("encoding") != _ENCODING:
            raise StreamError(
                f"{folder / _SCHEMA_FILE}: encoding {described.get('encoding')!r}: this library "
                "reads jsonl compressed with gzip"
            )
        where = str(folder / _SCHEMA_FILE)
        keys = _names(described.get("key_properties"), "key_properties", where)
        return StreamReader(
            name,
            stream,
            RecordSchema.parse(described.get("schema")),
            keys,
            _names(described.get("bookmark_properties"), "bookmark_properties", where),
            validate,
            _part_files(folder),
            self._rejected(stream, keys, max_rejected),
        )

    def _rejected(self, stream: str, keys: tuple[str, ...], max_rejected: int) -> _Rejected:
        if self.files is None:
            raise StreamError(
                "CRONPLANE_FILES is not set: an action that reads streams sends its rejected "
                "records with the files of $CRONPLANE_FILES (no files.include)"
            )
        if max_rejected < 0:
            raise StreamError(f"max_rejected is 0 or more, not {max_rejected}")
        return _Rejected(stream, self.files / "rejected" / stream / self.step, keys, max_rejected)


def _described(folder: Path) -> dict[str, JsonValue]:
    """`schema.json` of the stream in `folder`."""
    path = folder / _SCHEMA_FILE
    try:
        described = parse(path.read_bytes())
    except FileNotFoundError:
        raise StreamError(
            f"{path}: no such stream: is it in streams.consumes of the action, and produced by a "
            "step this step needs?"
        ) from None
    except (OSError, ValueError) as e:
        raise StreamError(f"{path}: cannot be read: {e}") from e
    if not isinstance(described, dict):
        raise StreamError(f"{path}: a JSON object is expected")
    return described


def _part_files(folder: Path) -> tuple[Path, ...]:
    """The parts of the stream in `folder`, in order: numbered from 1, none missing."""
    numbers: list[int] = []
    for entry in folder.iterdir():
        if entry.name == _SCHEMA_FILE:
            continue
        match = _PART.fullmatch(entry.name)
        if match is None or not entry.is_file():
            raise StreamError(
                f"{entry}: not a file of a stream (schema.json, part-00001.jsonl.gz…)"
            )
        numbers.append(int(match.group(1)))
    numbers.sort()
    if numbers != list(range(1, len(numbers) + 1)):
        raise StreamError(f"{folder}: its parts are numbered from 1, none missing")
    return tuple(folder / f"part-{number:05d}.jsonl.gz" for number in numbers)
