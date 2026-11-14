"""Where the step starts again (`state: true` of the action): one JSON
value Cronplane keeps between runs, when the whole run succeeds. A cursor, a
last key: never data."""

from __future__ import annotations

import json
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from ._errors import StateError
from ._json import JsonValue, parse

#: The largest state Cronplane keeps.
MAX_STATE_BYTES: Final = 32 * 1024

#: The version of the object the library proposes: one entry per stream.
_VERSION: Final = 1


@dataclass(frozen=True)
class State:
    """The state kept for the step, and the one it writes for its next run."""

    #: `$CRONPLANE_STATE`; none at the first run, or after a reset.
    kept: Path | None
    #: `$CRONPLANE_STATE_OUT`.
    out: Path

    def get(self) -> JsonValue:
        """The state the last successful run kept; `None` when there is none."""
        if self.kept is None:
            return None
        return _read(self.kept)

    def set(self, value: JsonValue) -> None:
        """Writes the state of the next run, whole. Cronplane keeps it only if
        the whole run succeeds. `StateError` over 32 KiB."""
        try:
            data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
        except (TypeError, ValueError) as e:
            raise StateError(f"the state is not a JSON value: {e}") from e
        if len(data) > MAX_STATE_BYTES:
            raise StateError(
                f"the state is {len(data)} bytes, more than {MAX_STATE_BYTES}: "
                "keep where to start again, never data"
            )
        try:
            with tempfile.NamedTemporaryFile(
                dir=self.out.parent, prefix=".state-", delete=False
            ) as tmp:
                tmp.write(data)
            Path(tmp.name).replace(self.out)
        except OSError as e:
            raise StateError(f"{self.out}: cannot be written: {e}") from e

    def stream(self, name: str) -> dict[str, JsonValue]:
        """Where the stream `name` starts again, as the last successful run
        left it; empty when it kept nothing for it."""
        entry = _streams(self.get()).get(name)
        return dict(entry) if isinstance(entry, dict) else {}

    def set_stream(self, name: str, value: Mapping[str, JsonValue]) -> None:
        """Writes where the stream `name` starts again at the next run; the
        other streams keep what this run wrote for them, else what it read."""
        current = _read(self.out) if self.out.exists() else self.get()
        streams = _streams(current)
        streams[name] = dict(value)
        self.set({"version": _VERSION, "streams": streams})


def _read(path: Path) -> JsonValue:
    try:
        return parse(path.read_bytes())
    except (OSError, ValueError) as e:
        raise StateError(f"{path}: the state cannot be read: {e}") from e


def _streams(state: JsonValue) -> dict[str, JsonValue]:
    """The entries per stream of a state the library wrote; none in no state."""
    if state is None:
        return {}
    if not isinstance(state, dict) or state.get("version") != _VERSION:
        raise StateError(
            'the state is not one of this library ({"version": 1, "streams": {...}}): '
            "read it with get(), write it with set()"
        )
    streams = state.get("streams")
    if not isinstance(streams, dict):
        raise StateError('the state has no "streams" object')
    return dict(streams)
