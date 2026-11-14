"""The hosts a step may reach (`CRONPLANE_NETWORK_ALLOW`, one per line): the
only ones the action's `network: {allow: [...]}` names. The library refuses
any other before it connects. Code that opens its own connections is not
limited: a defence for honest code, not a confinement."""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from typing import Final, TypeAlias

from ._errors import ActionError, EgressError

IpAddress: TypeAlias = ipaddress.IPv4Address | ipaddress.IPv6Address

_LABEL: Final = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
_MAX_NAME: Final = 253
_MAX_PORT: Final = 65535


def _is_name(name: str) -> bool:
    return len(name) <= _MAX_NAME and all(_LABEL.fullmatch(label) for label in name.split("."))


def _address(text: str) -> IpAddress | None:
    try:
        return ipaddress.ip_address(text)
    except ValueError:
        return None


@dataclass(frozen=True)
class _Host:
    """A line of the list. Exactly one of `name`, `under` and `address` is set."""

    #: `api.hubapi.com`.
    name: str | None = None
    #: `.my.salesforce.com`, from `*.my.salesforce.com`.
    under: str | None = None
    address: IpAddress | None = None
    #: None: any port.
    port: int | None = None

    def allows(self, host: str, address: IpAddress | None, port: int) -> bool:
        if self.port is not None and self.port != port:
            return False
        if self.address is not None:
            return address == self.address
        if address is not None:
            return False
        return host == self.name or (self.under is not None and host.endswith(self.under))


def _port(text: str, line: str) -> int:
    if not text.isascii() or not text.isdigit() or not 1 <= int(text) <= _MAX_PORT:
        raise ActionError(f"host {line!r}: a port is a number from 1 to {_MAX_PORT}")
    return int(text)


def _host(line: str) -> _Host:
    if line.startswith("["):
        inside, bracket, after = line[1:].partition("]")
        address = _address(inside)
        if not bracket or not isinstance(address, ipaddress.IPv6Address):
            raise ActionError(f"host {line!r}: [ and ] hold an IPv6 address")
        if not after:
            return _Host(address=address)
        if not after.startswith(":"):
            raise ActionError(f'host {line!r}: after ], a port (":5432") or nothing')
        return _Host(address=address, port=_port(after[1:], line))
    whole = _address(line)
    if isinstance(whole, ipaddress.IPv6Address):
        return _Host(address=whole)
    host, colon, port_text = line.partition(":")
    port = _port(port_text, line) if colon else None
    address = _address(host)
    if address is not None:
        return _Host(address=address, port=port)
    if host.startswith("*.") and _is_name(host[2:]):
        return _Host(under=host[1:], port=port)
    if _is_name(host):
        return _Host(name=host, port=port)
    raise ActionError(
        f"host {line!r}: a name (api.example.com), a name under a domain (*.example.com) or an "
        "IP address, in lowercase, with an optional port (:5432)"
    )


@dataclass(frozen=True)
class AllowedHosts:
    """The only hosts the step reaches."""

    #: As Cronplane gives them.
    lines: tuple[str, ...]
    _hosts: tuple[_Host, ...]

    @classmethod
    def parse(cls, value: str | None) -> AllowedHosts | None:
        """`CRONPLANE_NETWORK_ALLOW`: unset is no list (any host); a line that
        is not a host is an error, never a host ignored."""
        if value is None:
            return None
        lines = tuple(value.split("\n"))
        return cls(lines, tuple(_host(line) for line in lines))

    def allows(self, host: str, port: int) -> bool:
        """Whether the list lets the step reach `host` on `port`. A name is
        compared without its case nor a final dot, an address as an address."""
        name = host.lower().removesuffix(".")
        literal = name[1:-1] if name.startswith("[") and name.endswith("]") else name
        address = _address(literal)
        return any(entry.allows(name, address, port) for entry in self._hosts)

    def check(self, host: str, port: int) -> None:
        """`EgressError` when the list does not let the step reach `host` on `port`."""
        if not self.allows(host, port):
            raise EgressError(
                f"{host}:{port} is not one of the hosts this step may reach "
                f"({', '.join(self.lines)}): see network.allow of the action and of the step"
            )
