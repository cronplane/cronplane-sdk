"""The plan of `cronplane test --plan --json`, version 1: the test flows of an
action and what they need. Read as data, never run."""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import StrEnum
from typing import cast

from .errors import StepError

#: The only version of the plan this adapter reads.
VERSION = 1


class PlanError(Exception):
    """The plan is not one this adapter reads."""


class Level(StrEnum):
    """What a test flow needs beside it."""

    E2E = "e2e"
    INTEGRATION = "integration"


@dataclass(frozen=True)
class Flow:
    file: str
    level: Level
    #: Its test values as written, by secret.
    secrets: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class Plan:
    #: The services its flows need, each once.
    services: tuple[str, ...]
    flows: tuple[Flow, ...]

    @classmethod
    def parse(cls, text: str) -> Plan:
        try:
            fields = _fields(json.loads(text))
        except ValueError as e:
            raise PlanError(f"not JSON: {e}") from e
        if fields is None:
            raise PlanError("a JSON object is expected")
        if fields.get("version") != VERSION:
            raise PlanError(
                f"version {fields.get('version')!r}: this adapter reads version {VERSION}"
            )
        flows: list[Flow] = []
        for item in _items(fields.get("flows")):
            flow = _fields(item) or {}
            file, level = flow.get("file"), flow.get("level")
            if not isinstance(file, str) or level not in list(Level):
                raise PlanError(f"a flow without a file or a level: {item!r}")
            secrets = _fields(flow.get("secrets")) or {}
            flows.append(
                Flow(
                    file,
                    Level(level),
                    tuple(
                        (name, value) for name, value in secrets.items() if isinstance(value, str)
                    ),
                )
            )
        services = tuple(s for s in _items(fields.get("services")) if isinstance(s, str))
        return cls(services, tuple(flows))

    def of(self, level: Level) -> tuple[Flow, ...]:
        """Its flows of one level."""
        return tuple(flow for flow in self.flows if flow.level is level)

    def variables(self) -> dict[str, str]:
        """The test values of its `integration` flows, for the tests of the
        language: each secret in uppercase. The address of a double is not
        known before its flow runs: such a value is left out. Two values for
        one name are an error."""
        values: dict[str, str] = {}
        for flow in self.of(Level.INTEGRATION):
            for secret, value in flow.secrets:
                name = secret.upper()
                if "${doubles." in value:
                    continue
                if values.setdefault(name, value) != value:
                    raise StepError(
                        f"{flow.file}: test.secrets.{secret} has another value in another "
                        f"integration flow: the tests of the language read one {name}"
                    )
        return values


#: An action whose test flows are not read yet.
NO_PLAN = Plan((), ())


def _fields(value: object) -> dict[str, object] | None:
    """`value` when it is a JSON object."""
    if not isinstance(value, dict):
        return None
    # json.loads builds objects with string keys only.
    return cast("dict[str, object]", value)


def _items(value: object) -> list[object]:
    """`value` when it is a JSON array, else an empty one."""
    return cast("list[object]", value) if isinstance(value, list) else []
