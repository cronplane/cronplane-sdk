"""The step's side of the contract with Cronplane: what a step using an
action gets (its inputs, secrets, the outputs of the steps it needs) and what
it gives back (its output, the values to mask)."""

from __future__ import annotations

import json
import os
import re
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import TypeAlias

from ._errors import ActionError, EgressError, InputError, OutputError, SecretError, StateError
from ._http import Egress, HttpClient, Resolve, is_public, system_resolve
from ._json import JsonValue, parse
from ._network import AllowedHosts, IpAddress
from ._smtp import SmtpClient
from ._state import State
from ._streams import Streams
from ._version import REQUIRES_CRONPLANE, VARIABLE, Minor, check

Scalar: TypeAlias = str | int | bool
"""An item of a `list` input, a value of a `map` input."""

#: The largest output Cronplane accepts.
MAX_OUTPUT_BYTES = 1 << 20

# The names of variables, and of the files of `$CRONPLANE_SECRETS`.
_SECRET_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


@dataclass(frozen=True)
class Inputs:
    """The values of the action's inputs, typed as `action.yaml` declares them."""

    values: Mapping[str, JsonValue]

    def has(self, name: str) -> bool:
        """The step gives the input (an optional input without default may be missing)."""
        return name in self.values

    def string(self, name: str) -> str:
        """A `string` or `enum` input."""
        value = self._value(name)
        if not isinstance(value, str):
            raise InputError(f"input {name}: a string is expected, not {_kind(value)}")
        return value

    def integer(self, name: str) -> int:
        value = self._value(name)
        if isinstance(value, bool) or not isinstance(value, int):
            raise InputError(f"input {name}: an integer is expected, not {_kind(value)}")
        return value

    def boolean(self, name: str) -> bool:
        value = self._value(name)
        if not isinstance(value, bool):
            raise InputError(f"input {name}: a boolean is expected, not {_kind(value)}")
        return value

    def items(self, name: str) -> list[Scalar]:
        """A `list` input: its items."""
        value = self._value(name)
        if not isinstance(value, list):
            raise InputError(f"input {name}: a list is expected, not {_kind(value)}")
        return [_scalar(name, item) for item in value]

    def entries(self, name: str) -> dict[str, Scalar]:
        """A `map` input: its entries."""
        value = self._value(name)
        if not isinstance(value, dict):
            raise InputError(f"input {name}: a map is expected, not {_kind(value)}")
        return {key: _scalar(name, item) for key, item in value.items()}

    def _value(self, name: str) -> JsonValue:
        if name not in self.values:
            raise InputError(f"input {name}: not given to the step")
        return self.values[name]


@dataclass
class Outputs:
    """The output of the step: each `set` writes the whole JSON object again,
    at once, so the step never leaves half of it."""

    path: Path
    values: dict[str, JsonValue] = field(default_factory=dict[str, JsonValue])

    def set(self, name: str, value: JsonValue) -> None:
        values = {**self.values, name: value}
        try:
            text = json.dumps(values, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError) as e:
            raise OutputError(f"output {name}: not a JSON value: {e}") from e
        data = text.encode()
        if len(data) > MAX_OUTPUT_BYTES:
            raise OutputError(
                f"output {name}: the output would exceed {MAX_OUTPUT_BYTES} bytes: "
                "pass large data through files ($CRONPLANE_FILES), not outputs"
            )
        _replace(self.path, data)
        self.values = values


@dataclass(frozen=True)
class Network:
    """What the step may reach, for the connections the HTTP client does not
    make (a database): the hosts of `network.allow`, and public addresses
    only on a worker that runs the steps of several customers."""

    egress: Egress
    #: The only hosts the step reaches; `None`: any host.
    allowed: AllowedHosts | None
    resolver: Resolve = field(default=system_resolve, repr=False)

    def resolve(self, host: str, port: int) -> list[IpAddress]:
        """The addresses of `host` the step may connect to on `port`, each
        checked: connect to one of them, not to the name again (a second
        resolution could give another address). `EgressError` when the host
        is out of the list, or an address is not public where it must be."""
        if self.allowed is not None:
            self.allowed.check(host, port)
        addresses = list(self.resolver(host, port))
        if self.egress is Egress.PUBLIC:
            for address in addresses:
                if not is_public(address):
                    raise EgressError(
                        f"{host} resolves to {address}, not a public address: this worker "
                        "lets its steps reach public addresses only"
                    )
        return addresses


@dataclass(frozen=True)
class Action:
    """What Cronplane gives the step running the action, read once when it starts."""

    inputs: Inputs
    outputs: Outputs
    http: HttpClient
    smtp: SmtpClient
    network: Network
    environ: Mapping[str, str] = field(repr=False)

    @classmethod
    def from_environment(cls, environ: Mapping[str, str] | None = None) -> Action:
        """The action of this step; `ActionError` when Cronplane does not run it as an
        action, `VersionError` when that Cronplane is older than the library needs."""
        env = dict(os.environ if environ is None else environ)
        check(Minor.parse(REQUIRES_CRONPLANE), env.get(VARIABLE))
        with_file = _path(env, "CRONPLANE_WITH")
        try:
            values = parse(with_file.read_bytes())
        except (OSError, ValueError) as e:
            raise ActionError(f"{with_file}: the values of the inputs cannot be read: {e}") from e
        if not isinstance(values, dict):
            raise ActionError(f"{with_file}: a JSON object is expected")
        _path(env, "CRONPLANE_MASK")
        egress = Egress.parse(env.get("CRONPLANE_EGRESS"))
        allowed = AllowedHosts.parse(env.get("CRONPLANE_NETWORK_ALLOW"))
        plain = AllowedHosts.parse(env.get("CRONPLANE_NETWORK_PLAIN"))
        return cls(
            inputs=Inputs(values),
            outputs=Outputs(_path(env, "CRONPLANE_OUTPUT")),
            http=HttpClient(egress, allowed, plain),
            smtp=SmtpClient(egress, allowed, plain),
            network=Network(egress, allowed),
            environ=env,
        )

    @property
    def streams(self) -> Streams:
        """The streams of records the step produces and consumes."""
        files = self.environ.get("CRONPLANE_FILES")
        needed = self.environ.get("CRONPLANE_NEEDED_FILES")
        return Streams(
            Path(files) if files else None,
            Path(needed) if needed else None,
            self.environ.get("CRONPLANE_STEP_ID", ""),
        )

    @property
    def state(self) -> State:
        """Where the step starts again; the action needs `state: true`."""
        out = self.environ.get("CRONPLANE_STATE_OUT")
        if not out:
            raise StateError("the state is not kept: the action needs `state: true`")
        kept = self.environ.get("CRONPLANE_STATE")
        return State(Path(kept) if kept else None, Path(out))

    def secret(self, name: str) -> str:
        """A secret of the action: its variable, or its file in `$CRONPLANE_SECRETS`
        (`delivery: file`). Cronplane already masks it in what the step prints."""
        if not _SECRET_NAME.fullmatch(name):
            raise SecretError(f"{name!r}: not the name of a secret")
        if name in self.environ:
            return self.environ[name]
        directory = self.environ.get("CRONPLANE_SECRETS")
        if directory is not None:
            try:
                return (Path(directory) / name).read_text(encoding="utf-8")
            except FileNotFoundError:
                pass
            except OSError as e:
                raise SecretError(f"secret {name}: cannot be read: {e}") from e
        raise SecretError(f"secret {name}: not given to the step (is it in the action's secrets?)")

    def mask(self, value: str) -> None:
        """Hides `value` in the step's log, error and output: in the live view
        from the next line the step prints, everywhere in the final log. Call
        it before the value can be printed. Values shorter than 3 characters,
        and encoded forms of a value (base64, URL), are not masked."""
        if not value.strip():
            return
        with _path(self.environ, "CRONPLANE_MASK").open("a", encoding="utf-8") as f:
            f.write(f"{value}\n")

    def needed(self) -> dict[str, JsonValue]:
        """The outputs of the steps this step needs, by step id."""
        needed = _read_object(_path(self.environ, "CRONPLANE_INPUTS"))
        return needed

    def trigger(self) -> dict[str, JsonValue]:
        """What started the run; the action needs `needs_trigger: true`."""
        if "CRONPLANE_TRIGGER" not in self.environ:
            raise ActionError("the trigger is not given: the action needs `needs_trigger: true`")
        return _read_object(_path(self.environ, "CRONPLANE_TRIGGER"))


def _path(env: Mapping[str, str], variable: str) -> Path:
    value = env.get(variable)
    if not value:
        raise ActionError(f"{variable} is not set: is this step run by Cronplane, as an action?")
    return Path(value)


def _read_object(path: Path) -> dict[str, JsonValue]:
    try:
        value = parse(path.read_bytes())
    except (OSError, ValueError) as e:
        raise ActionError(f"{path}: cannot be read: {e}") from e
    if not isinstance(value, dict):
        raise ActionError(f"{path}: a JSON object is expected")
    return value


def _replace(path: Path, data: bytes) -> None:
    """Writes `data` to `path` through a temporary file of its directory, renamed over it."""
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".output-", delete=False) as tmp:
            tmp.write(data)
        Path(tmp.name).replace(path)
    except OSError as e:
        raise OutputError(f"{path}: cannot be written: {e}") from e


def _scalar(name: str, value: JsonValue) -> Scalar:
    if isinstance(value, str | int | bool):
        return value
    raise InputError(
        f"input {name}: an item is a string, an integer or a boolean, not {_kind(value)}"
    )


# `bool` before `int`: a boolean is an int in Python.
_KINDS: tuple[tuple[type, str], ...] = (
    (bool, "a boolean"),
    (int, "an integer"),
    (float, "a number"),
    (str, "a string"),
    (list, "a list"),
    (dict, "a map"),
)


def _kind(value: JsonValue) -> str:
    for kind, name in _KINDS:
        if isinstance(value, kind):
            return name
    return "null"
