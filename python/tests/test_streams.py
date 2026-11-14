"""Streams of records between steps: what a step writes, what the next reads."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import pytest

from cronplane_actions import JsonValue, RejectedError, SchemaError, StreamError, Streams
from cronplane_actions._streams import (
    MAX_PART_BYTES,
    MAX_PART_RECORDS,
    _Parts,  # pyright: ignore[reportPrivateUsage]
)

from .conftest import Step

SCHEMA: JsonValue = {
    "type": "object",
    "properties": {"id": {"type": "integer"}, "email": {"type": "string"}},
    "required": ["id", "email"],
}


def _lines(path: Path) -> list[JsonValue]:
    with gzip.open(path, "rt", encoding="utf-8") as part:
        return [json.loads(line) for line in part]


@pytest.fixture
def producer(tmp_path: Path) -> Streams:
    """The streams of a step `export`, which sends the files of its directory."""
    return Streams(tmp_path / "export" / "files", None, "export")


@pytest.fixture
def consumer(tmp_path: Path) -> Streams:
    """The streams of a step `load`, which needs `export`."""
    return Streams(tmp_path / "load" / "files", tmp_path / "export" / "files", "load")


def _contacts(
    producer: Streams, records: list[dict[str, JsonValue]], max_rejected: int = 0
) -> None:
    with producer.writer(
        "contacts", SCHEMA, key_properties=["id"], max_rejected=max_rejected
    ) as writer:
        for record in records:
            writer.write(record)


def test_a_stream_is_its_schema_then_its_records_one_per_line(
    producer: Streams, consumer: Streams
) -> None:
    with producer.writer(
        "contacts", SCHEMA, key_properties=["id"], bookmark_properties=["updated_at"]
    ) as writer:
        writer.write({"id": 1, "email": "a@acme.test"})
        writer.write({"id": 2, "email": "é@acme.test", "extra": None})
        assert (writer.written, writer.rejected) == (2, 0)
    assert producer.files is not None
    folder = producer.files / "streams" / "contacts"
    assert sorted(p.name for p in folder.iterdir()) == ["part-00001.jsonl.gz", "schema.json"]
    assert json.loads((folder / "schema.json").read_text()) == {
        "version": 1,
        "stream": "contacts",
        "schema": SCHEMA,
        "key_properties": ["id"],
        "bookmark_properties": ["updated_at"],
        "encoding": {"format": "jsonl", "compression": "gzip"},
    }
    raw = gzip.decompress((folder / "part-00001.jsonl.gz").read_bytes()).decode()
    assert raw == ('{"id":1,"email":"a@acme.test"}\n{"id":2,"email":"é@acme.test","extra":null}\n')
    assert not (producer.files / "rejected").exists()

    with consumer.reader("contacts") as reader:
        assert (reader.name, reader.stream) == ("contacts", "contacts")
        assert (reader.key_properties, reader.bookmark_properties) == (("id",), ("updated_at",))
        assert list(reader) == [
            {"id": 1, "email": "a@acme.test"},
            {"id": 2, "email": "é@acme.test", "extra": None},
        ]


def test_the_same_records_give_the_same_files(tmp_path: Path) -> None:
    files: list[bytes] = []
    for name in ("one", "two"):
        streams = Streams(tmp_path / name, None, "export")
        with streams.writer("contacts", SCHEMA) as writer:
            writer.write({"id": 1, "email": "a@acme.test"})
        files.append((tmp_path / name / "streams/contacts/part-00001.jsonl.gz").read_bytes())
    assert files[0] == files[1]


def test_a_stream_without_records_is_its_schema_alone(producer: Streams, consumer: Streams) -> None:
    _contacts(producer, [])
    assert producer.files is not None
    assert [p.name for p in (producer.files / "streams/contacts").iterdir()] == ["schema.json"]
    with consumer.reader("contacts") as reader:
        assert list(reader) == []


def test_a_part_is_closed_at_its_number_of_records_or_its_size(tmp_path: Path) -> None:
    by_records = _Parts(tmp_path / "records", 2, MAX_PART_BYTES)
    for n in range(5):
        by_records.write(f"{n}\n".encode())
    by_records.close()
    assert sorted(p.name for p in (tmp_path / "records").iterdir()) == [
        "part-00001.jsonl.gz",
        "part-00002.jsonl.gz",
        "part-00003.jsonl.gz",
    ]
    assert _lines(tmp_path / "records/part-00002.jsonl.gz") == [2, 3]
    assert by_records.lines == 5

    by_size = _Parts(tmp_path / "size", 100, 10)
    for line in (b"12345\n", b"1234\n", b"123456789\n", b"1\n"):
        by_size.write(line)
    by_size.close()
    by_size.close()
    assert [len(_lines(p)) for p in sorted((tmp_path / "size").iterdir())] == [1, 1, 1, 1], (
        "a line starts a new part rather than pass the size"
    )


def test_the_parts_of_a_stream_are_read_in_the_order_of_their_names(
    producer: Streams, consumer: Streams
) -> None:
    _contacts(producer, [])
    assert producer.files is not None
    folder = producer.files / "streams/contacts"
    for number, ids in ((2, [3]), (1, [1, 2]), (3, [])):
        with gzip.open(folder / f"part-{number:05d}.jsonl.gz", "wt") as part:
            part.writelines(json.dumps({"id": n, "email": "x"}) + "\n" for n in ids)
    with consumer.reader("contacts") as reader:
        assert [record["id"] for record in reader] == [1, 2, 3]


def test_a_record_that_does_not_fit_is_rejected_and_the_step_fails_at_the_end(
    producer: Streams,
) -> None:
    with pytest.raises(RejectedError) as failed:
        _contacts(
            producer,
            [
                {"id": 1, "email": "a@acme.test"},
                {"id": "2", "email": "b@acme.test"},
                {"email": 3},
                {"id": 4, "email": "d@acme.test"},
            ],
        )
    assert producer.files is not None
    rejected = producer.files / "rejected/contacts/export"
    assert str(failed.value) == (
        f"stream contacts: 2 records rejected, 0 allowed (max_rejected): see {rejected} "
        "in the files of the step"
    )
    assert _lines(producer.files / "streams/contacts/part-00001.jsonl.gz") == [
        {"id": 1, "email": "a@acme.test"},
        {"id": 4, "email": "d@acme.test"},
    ], "the other records are written, and every rejected one kept"
    assert _lines(rejected / "part-00001.jsonl.gz") == [
        {"record": {"id": "2", "email": "b@acme.test"}, "reason": "/id: type", "key": {"id": "2"}},
        {"record": {"email": 3}, "reason": "/id: required; /email: type", "key": {}},
    ]


def test_a_step_allows_some_rejected_records(producer: Streams, consumer: Streams) -> None:
    records: list[dict[str, JsonValue]] = [{"id": 1, "email": "a"}, {"id": "2"}, {"id": "3"}]
    _contacts(producer, records, max_rejected=2)
    assert producer.files is not None
    stricter = Streams(producer.files.parent / "again", None, "export")
    with pytest.raises(RejectedError, match="2 records rejected, 1 allowed"):
        _contacts(stricter, records, max_rejected=1)
    with pytest.raises(StreamError, match="max_rejected is 0 or more, not -1"):
        consumer.reader("contacts", max_rejected=-1)


def test_a_reader_rejects_what_does_not_fit_and_what_the_step_refuses(
    producer: Streams, consumer: Streams
) -> None:
    with producer.writer("contacts", SCHEMA, key_properties=["id"], validate=False) as writer:
        writer.write({"id": 1, "email": "a@acme.test"})
        writer.write({"id": 2})
        writer.write({"id": 3, "email": "c@acme.test"})
    reader = consumer.reader("contacts")
    read = list(reader)
    assert [record["id"] for record in read] == [1, 3]
    reader.reject(read[1], "HubSpot: INVALID_EMAIL")
    assert reader.rejected == 2
    with pytest.raises(RejectedError, match="stream contacts: 2 records rejected, 0 allowed"):
        reader.close()
    assert consumer.files is not None
    assert _lines(consumer.files / "rejected/contacts/load/part-00001.jsonl.gz") == [
        {"record": {"id": 2}, "reason": "/email: required", "key": {"id": 2}},
        {
            "record": {"id": 3, "email": "c@acme.test"},
            "reason": "HubSpot: INVALID_EMAIL",
            "key": {"id": 3},
        },
    ]

    again = Streams(consumer.files.parent / "again", consumer.needed, "load")
    with again.reader("contacts", validate=False) as reader:
        assert [record["id"] for record in reader] == [1, 2, 3], "as written, unchecked"


def _fails_after_a_rejected_record(streams: Streams) -> None:
    with streams.writer("contacts", SCHEMA) as writer:
        writer.write({"id": "bad"})
        raise KeyError("the step's own failure")


def test_a_failure_of_the_step_is_not_hidden_by_its_rejected_records(producer: Streams) -> None:
    with pytest.raises(KeyError, match="the step's own failure"):
        _fails_after_a_rejected_record(producer)
    assert producer.files is not None
    assert (producer.files / "rejected/contacts/export/part-00001.jsonl.gz").is_file()


def test_a_stream_read_under_the_name_of_its_step_keeps_its_own_name(tmp_path: Path) -> None:
    Streams(tmp_path / "crm", None, "crm").writer("contacts", SCHEMA).close()
    needed = tmp_path / "needed"
    (needed / "streams").mkdir(parents=True)
    (tmp_path / "crm/streams/contacts").rename(needed / "streams/crm.contacts")
    reader = Streams(tmp_path / "merge", needed, "merge").reader("crm.contacts")
    assert (reader.name, reader.stream) == ("crm.contacts", "contacts")
    reader.reject({"id": 1}, "duplicate")
    reader.close(failing=True)
    assert (tmp_path / "merge/rejected/contacts/merge/part-00001.jsonl.gz").is_file()


def test_a_stream_is_named_and_declared_as_the_contract_says(
    producer: Streams, consumer: Streams
) -> None:
    for name in ("Contacts", "order-lines", "a/b", "..", ""):
        with pytest.raises(StreamError, match="must match"):
            producer.writer(name, SCHEMA)
        with pytest.raises(StreamError, match=r"a stream \(contacts\) or <step>.<stream>"):
            consumer.reader(name)
    with pytest.raises(SchemaError):
        producer.writer("contacts", {"type": "object", "properties": {"a": {"pattern": "x"}}})
    assert producer.files is not None
    assert not producer.files.exists(), "nothing written for a schema refused"
    producer.writer("contacts", SCHEMA).close()
    with pytest.raises(StreamError, match="stream contacts: already written by this step"):
        producer.writer("contacts", SCHEMA)
    with pytest.raises(StreamError, match="a record: not a JSON value"):
        producer.writer("deals", {"type": "object"}).write({"n": float("nan")})


def test_a_step_without_its_directories_is_told_what_is_missing(tmp_path: Path) -> None:
    with pytest.raises(StreamError, match=r"CRONPLANE_FILES is not set.*produces streams"):
        Streams(None, None, "s").writer("contacts", SCHEMA)
    with pytest.raises(StreamError, match="CRONPLANE_NEEDED_FILES is not set"):
        Streams(tmp_path, None, "s").reader("contacts")
    Streams(tmp_path / "files", None, "export").writer("contacts", SCHEMA).close()
    with pytest.raises(StreamError, match=r"CRONPLANE_FILES is not set.*reads streams"):
        Streams(None, tmp_path / "files", "s").reader("contacts")
    with pytest.raises(StreamError, match=r"no such stream: is it in streams\.consumes"):
        Streams(tmp_path / "out", tmp_path / "files", "s").reader("deals")


def _schema_json(producer: Streams, **changes: JsonValue) -> None:
    assert producer.files is not None
    path = producer.files / "streams/contacts/schema.json"
    described = json.loads(path.read_text())
    described.update(changes)
    path.write_text(json.dumps(described))


@pytest.mark.parametrize(
    ("changes", "problem"),
    [
        ({"version": 2}, "version 2: this library reads version 1"),
        ({"stream": "Bad Name"}, "stream is the name of a stream"),
        ({"stream": None}, "stream is the name of a stream"),
        ({"encoding": {"format": "parquet"}}, "this library reads jsonl compressed with gzip"),
        ({"key_properties": "id"}, "key_properties is a list of property names"),
        ({"bookmark_properties": [1]}, "bookmark_properties is a list of property names"),
    ],
)
def test_a_schema_json_this_library_does_not_read_is_refused(
    producer: Streams, consumer: Streams, changes: dict[str, JsonValue], problem: str
) -> None:
    _contacts(producer, [])
    _schema_json(producer, **changes)
    with pytest.raises(StreamError, match=problem):
        consumer.reader("contacts")


def test_a_schema_json_without_its_lists_has_no_key_and_a_bad_schema_is_refused(
    producer: Streams, consumer: Streams
) -> None:
    _contacts(producer, [])
    assert producer.files is not None
    path = producer.files / "streams/contacts/schema.json"
    described = json.loads(path.read_text())
    del described["key_properties"], described["bookmark_properties"]
    path.write_text(json.dumps(described))
    reader = consumer.reader("contacts")
    assert (reader.key_properties, reader.bookmark_properties) == ((), ())
    reader.reject({"id": 1}, "no key")
    reader.close(failing=True)
    assert consumer.files is not None
    assert _lines(consumer.files / "rejected/contacts/load/part-00001.jsonl.gz") == [
        {"record": {"id": 1}, "reason": "no key"}
    ]

    _schema_json(producer, schema={"type": "array"})
    with pytest.raises(SchemaError):
        consumer.reader("contacts")
    path.write_text("[]")
    with pytest.raises(StreamError, match="a JSON object is expected"):
        consumer.reader("contacts")
    path.write_text("{not json")
    with pytest.raises(StreamError, match=r"schema\.json: cannot be read"):
        consumer.reader("contacts")


def test_the_folder_of_a_stream_holds_its_schema_and_its_parts_only(
    producer: Streams, consumer: Streams
) -> None:
    _contacts(producer, [{"id": 1, "email": "a"}])
    assert producer.files is not None
    folder = producer.files / "streams/contacts"
    (folder / "notes.txt").write_text("x")
    with pytest.raises(StreamError, match=r"notes\.txt: not a file of a stream"):
        consumer.reader("contacts")
    (folder / "notes.txt").unlink()
    (folder / "part-00003.jsonl.gz").write_bytes(gzip.compress(b""))
    with pytest.raises(StreamError, match="its parts are numbered from 1, none missing"):
        consumer.reader("contacts")
    (folder / "part-00003.jsonl.gz").rename(folder / "part-00002.jsonl.gz")
    (folder / "part-00003.jsonl.gz").mkdir()
    with pytest.raises(StreamError, match=r"part-00003\.jsonl\.gz: not a file of a stream"):
        consumer.reader("contacts")


@pytest.mark.parametrize(
    ("content", "problem"),
    [
        (gzip.compress(b'{"id": 1, "email": "a"}\n{not json\n'), "line 2 is not JSON"),
        (gzip.compress(b'{"id": NaN, "email": "a"}\n'), "line 1 is not JSON: NaN is not a JSON"),
        (b"not gzip", "cannot be read"),
        (gzip.compress(b'{"id": 1, "email": "a"}\n')[:-6], "cannot be read"),
    ],
)
def test_a_part_that_is_not_lines_of_json_in_gzip_fails_the_step(
    producer: Streams, consumer: Streams, content: bytes, problem: str
) -> None:
    _contacts(producer, [])
    assert producer.files is not None
    (producer.files / "streams/contacts/part-00001.jsonl.gz").write_bytes(content)
    with pytest.raises(StreamError, match=problem):
        list(consumer.reader("contacts"))


def test_a_line_that_is_not_an_object_is_rejected_or_refused_unchecked(
    producer: Streams, consumer: Streams
) -> None:
    _contacts(producer, [])
    assert producer.files is not None
    (producer.files / "streams/contacts/part-00001.jsonl.gz").write_bytes(gzip.compress(b"[1]\n"))
    reader = consumer.reader("contacts", max_rejected=1)
    assert list(reader) == []
    assert reader.rejected == 1
    reader.close()
    assert consumer.files is not None
    with pytest.raises(StreamError, match="line 1 is not a JSON object"):
        list(
            Streams(consumer.files / "x", consumer.needed, "load").reader(
                "contacts", validate=False
            )
        )


def test_a_step_gets_its_streams_from_what_cronplane_gives_it(step: Step) -> None:
    streams = step.action().streams
    assert (streams.files, streams.needed, streams.step) == (None, None, "")
    step.env |= {
        "CRONPLANE_FILES": str(step.dir / "files"),
        "CRONPLANE_NEEDED_FILES": str(step.dir / "needed_files"),
        "CRONPLANE_STEP_ID": "export",
    }
    writer = step.action().streams.writer("contacts", SCHEMA)
    writer.write({"id": "x"})
    writer.close(failing=True)
    assert (step.dir / "files/streams/contacts/schema.json").is_file()
    assert (step.dir / "files/rejected/contacts/export/part-00001.jsonl.gz").is_file()


def test_a_record_larger_than_a_part_is_rejected_and_never_read(
    producer: Streams, consumer: Streams, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("cronplane_actions._streams.MAX_PART_BYTES", 100)
    writer = producer.writer("contacts", {"type": "object"}, max_rejected=2)
    writer.write({"id": 1})
    writer.write({"id": 2, "text": "x" * 100})
    writer.reject({"id": 3, "text": "y" * 100}, "refused")
    writer.close()
    assert (writer.written, writer.rejected) == (1, 2)
    assert producer.files is not None
    rejected = producer.files / "rejected/contacts/export"
    assert [line for part in sorted(rejected.iterdir()) for line in _lines(part)] == [
        {"record": None, "reason": "a record of 119 bytes, over 100"},
        {"record": None, "reason": "refused (a record over 100 bytes)"},
    ]

    part = producer.files / "streams/contacts/part-00001.jsonl.gz"
    part.write_bytes(gzip.compress(b'{"id": 1}\n{"id": 2, "text": "' + b"x" * 100 + b'"}\n'))
    with pytest.raises(StreamError, match="line 2 is over 100 bytes"):
        list(consumer.reader("contacts"))


def test_files_that_cannot_be_written_name_their_place(tmp_path: Path) -> None:
    (tmp_path / "files").write_text("a file where the directory goes")
    with pytest.raises(StreamError, match=r"streams/contacts: cannot be written"):
        Streams(tmp_path / "files", None, "export").writer("contacts", SCHEMA)

    blocked = _Parts(tmp_path / "files" / "parts", 10, 10)
    with pytest.raises(StreamError, match=r"part-00001\.jsonl\.gz: cannot be written"):
        blocked.write(b"1\n")


class _Broken(gzip.GzipFile):
    """A part whose disk is full."""

    def write(self, data: object) -> int:
        raise OSError("no space left")

    def close(self) -> None:
        raise OSError("no space left")


def test_a_disk_that_fails_while_a_part_is_written_names_the_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("cronplane_actions._streams.gzip.GzipFile", _Broken)
    parts = _Parts(tmp_path / "parts", 10, 10)
    with pytest.raises(StreamError, match="parts: cannot be written: no space left"):
        parts.write(b"1\n")
    with pytest.raises(StreamError, match="parts: cannot be written: no space left"):
        parts.close()


_CONTRACT = Path(__file__).parents[2] / "contract/streams"
_CASES = json.loads((_CONTRACT / "cases.json").read_text(encoding="utf-8"))


def _raw_lines(folder: Path) -> list[str]:
    parts = sorted(p for p in folder.iterdir() if p.name.startswith("part-"))
    return [line for p in parts for line in gzip.decompress(p.read_bytes()).decode().splitlines()]


def test_the_limits_of_a_part_are_those_of_the_contract() -> None:
    assert _CASES["version"] == 1
    assert _CASES["limits"] == {"part_records": MAX_PART_RECORDS, "part_bytes": MAX_PART_BYTES}


def test_a_stream_is_written_as_the_contract_says(tmp_path: Path) -> None:
    case = _CASES["write"]
    streams = Streams(tmp_path, None, case["step"])
    with streams.writer(
        case["stream"],
        case["schema"],
        key_properties=case["key_properties"],
        bookmark_properties=case["bookmark_properties"],
        max_rejected=case["max_rejected"],
    ) as writer:
        for record in case["records"]:
            writer.write(record)
    folder = tmp_path / "streams" / case["stream"]
    assert json.loads((folder / "schema.json").read_text(encoding="utf-8")) == case["schema_json"]
    assert (folder / "schema.json").read_bytes().endswith(b"}\n")
    assert _raw_lines(folder) == case["lines"]
    rejected = tmp_path / "rejected" / case["stream"] / case["step"]
    assert _raw_lines(rejected) == case["rejected_lines"]


def test_the_golden_stream_of_the_contract_is_read(tmp_path: Path) -> None:
    case = _CASES["read"]
    streams = Streams(tmp_path, _CONTRACT / case["folder"], "load")
    with streams.reader(case["name"]) as reader:
        assert reader.stream == case["stream"]
        assert list(reader.key_properties) == case["key_properties"]
        assert list(reader.bookmark_properties) == case["bookmark_properties"]
        assert list(reader) == case["records"]
    folder = _CONTRACT / case["folder"] / "streams" / case["name"]
    assert sorted(p.name for p in folder.iterdir() if p.name != "schema.json") == case["parts"]
