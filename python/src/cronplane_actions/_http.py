"""An HTTP client for actions, on the standard library only.

On a worker that runs the steps of several customers
(`CRONPLANE_EGRESS=public`), it refuses every address that is not public
before it connects: the name is resolved once, every address it resolves to
is checked, and the connection goes to an address checked, so a second
resolution cannot change it (DNS rebinding). Each redirect is checked the
same way. TLS is verified against the name of the URL.
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import socket
import ssl
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TypeAlias
from urllib.parse import SplitResult, urljoin, urlsplit, urlunsplit

from ._errors import ActionError, EgressError, HttpError
from ._json import JsonValue, parse
from ._network import AllowedHosts, IpAddress

Resolve: TypeAlias = Callable[[str, int], Sequence[IpAddress]]
"""The addresses of a host name, for a port."""

Connect: TypeAlias = Callable[[IpAddress, int, float], socket.socket]
"""A TCP connection to an address and a port, within a timeout in seconds."""

_REDIRECTS = frozenset({301, 302, 303, 307, 308})
# A GET after them: 303 always, 301 and 302 after a POST (as browsers do).
_SEE_OTHER = 303
_MOVED = frozenset({301, 302})

# NAT64 (RFC 6052): the last 32 bits are an IPv4 address the gateway reaches.
_NAT64 = ipaddress.IPv6Network("64:ff9b::/96")

# Sent again to the same origin only.
_CREDENTIALS = frozenset({"authorization", "proxy-authorization", "cookie"})


class Egress(StrEnum):
    """The addresses the worker lets its steps reach."""

    ANY = "any"
    PUBLIC = "public"

    @classmethod
    def parse(cls, value: str | None) -> Egress:
        """`CRONPLANE_EGRESS`: unset is any; an unknown value is an error, never any."""
        if value is None:
            return cls.ANY
        try:
            return cls(value)
        except ValueError:
            known = ", ".join(e.value for e in cls)
            raise ActionError(f"CRONPLANE_EGRESS={value!r}: one of {known}, or unset") from None


def is_public(address: IpAddress) -> bool:
    """An address of the Internet: not private, loopback, link-local (cloud
    metadata), shared (CGNAT), multicast, reserved nor unspecified; an IPv6
    address carrying an IPv4 one (mapped, 6to4, NAT64) is judged on it."""
    if isinstance(address, ipaddress.IPv6Address):
        if address in _NAT64:
            return is_public(ipaddress.IPv4Address(int(address) & 0xFFFF_FFFF))
        carried = address.ipv4_mapped or address.sixtofour
        if carried is not None:
            return is_public(carried)
    return address.is_global and not address.is_multicast


def system_resolve(host: str, port: int) -> list[IpAddress]:
    """The addresses of `host`, in the order the system gives them."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise HttpError(f"{host}: the name does not resolve: {e}") from e
    addresses: list[IpAddress] = []
    for info in infos:
        address = ipaddress.ip_address(str(info[4][0]))
        if address not in addresses:
            addresses.append(address)
    return addresses


def system_connect(address: IpAddress, port: int, timeout: float) -> socket.socket:
    return socket.create_connection((str(address), port), timeout=timeout)


@dataclass(frozen=True)
class Response:
    """A response, read whole."""

    status: int
    #: Names in lower case; a repeated header holds its values joined by ", ".
    headers: Mapping[str, str]
    body: bytes
    #: The URL that answered, after redirects.
    url: str

    def text(self) -> str:
        """The body as UTF-8 text; a byte that is not UTF-8 reads as U+FFFD."""
        return self.body.decode("utf-8", errors="replace")

    def json(self) -> JsonValue:
        try:
            return parse(self.body)
        except ValueError as e:
            raise HttpError(f"{self.url}: the response is not JSON: {e}") from e


@dataclass(frozen=True)
class Request:
    method: str
    url: str
    headers: Mapping[str, str]
    body: bytes | None


@dataclass(frozen=True)
class HttpClient:
    """HTTP/1.1 requests within the worker's egress rule and the hosts the
    step may reach, redirects included. Each request has a
    timeout (per connection and read), a response size limit and a limit of
    redirects; no proxy is used."""

    egress: Egress
    #: The only hosts the step reaches; `None`: any host.
    allowed: AllowedHosts | None = None
    timeout: float = 30.0
    max_body: int = 10 << 20
    max_redirects: int = 5
    #: CA certificates to trust instead of the system's (a server with its own CA).
    ca_file: str | None = None
    resolve: Resolve = field(default=system_resolve, repr=False)
    connect: Connect = field(default=system_connect, repr=False)

    def get(self, url: str, *, headers: Mapping[str, str] | None = None) -> Response:
        return self.request("GET", url, headers=headers)

    def post(self, url: str, body: bytes, *, headers: Mapping[str, str] | None = None) -> Response:
        return self.request("POST", url, headers=headers, body=body)

    def post_json(
        self, url: str, value: JsonValue, *, headers: Mapping[str, str] | None = None
    ) -> Response:
        body = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
        sent = {"content-type": "application/json", **(headers or {})}
        return self.request("POST", url, headers=sent, body=body)

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        body: bytes | None = None,
    ) -> Response:
        current = Request(method.upper(), url, dict(headers or {}), body)
        for _ in range(self.max_redirects + 1):
            response = self._send(current)
            location = response.headers.get("location")
            if response.status not in _REDIRECTS or location is None:
                return response
            current = follow_redirect(current, location, response.status)
        raise HttpError(f"{url}: more than {self.max_redirects} redirects")

    def _send(self, request: Request) -> Response:
        parts = _target(request.url)
        host = parts.hostname or ""
        port = _port(parts)
        if self.allowed is not None:
            self.allowed.check(host, port)
        addresses = self.resolve(host, port)
        if not addresses:
            raise HttpError(f"{host}: the name resolves to no address")
        if self.egress is Egress.PUBLIC:
            for address in addresses:
                if not is_public(address):
                    raise EgressError(
                        f"{host} resolves to {address}, not a public address: this worker "
                        "lets its steps reach public addresses only"
                    )
        sock = self._open(addresses, host, port, parts.scheme)
        connection = (
            http.client.HTTPSConnection(host, port, timeout=self.timeout)
            if parts.scheme == "https"
            else http.client.HTTPConnection(host, port, timeout=self.timeout)
        )
        # The socket already goes to the address checked: no second resolution.
        connection.sock = sock
        path = urlunsplit(("", "", parts.path or "/", parts.query, ""))
        try:
            connection.request(request.method, path, body=request.body, headers=request.headers)
            answer = connection.getresponse()
            body = answer.read(self.max_body + 1)
        except (OSError, http.client.HTTPException) as e:
            raise HttpError(f"{request.method} {request.url}: {e}") from e
        finally:
            connection.close()
        if len(body) > self.max_body:
            raise HttpError(f"{request.url}: the response is over {self.max_body} bytes")
        headers: dict[str, str] = {}
        for name, value in answer.getheaders():
            key = name.lower()
            headers[key] = f"{headers[key]}, {value}" if key in headers else value
        return Response(answer.status, headers, body, request.url)

    def _open(
        self, addresses: Sequence[IpAddress], host: str, port: int, scheme: str
    ) -> socket.socket:
        failures: list[str] = []
        for address in addresses:
            try:
                sock = self.connect(address, port, self.timeout)
            except OSError as e:
                failures.append(f"{address}: {e}")
                continue
            if scheme != "https":
                return sock
            context = ssl.create_default_context(cafile=self.ca_file)
            try:
                return context.wrap_socket(sock, server_hostname=host)
            except OSError as e:
                sock.close()
                raise HttpError(f"{host}: TLS: {e}") from e
        raise HttpError(f"{host}:{port}: no connection ({'; '.join(failures)})")


def _target(url: str) -> SplitResult:
    """`url` split, when it is an absolute http(s) URL without credentials."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise HttpError(f"{url}: an http or https URL is expected")
    if not parts.hostname:
        raise HttpError(f"{url}: the URL has no host")
    if parts.username is not None or parts.password is not None:
        raise HttpError(f"{parts.hostname}: credentials in the URL: pass them in a header")
    return parts


def _port(parts: SplitResult) -> int:
    try:
        port = parts.port
    except ValueError as e:
        raise HttpError(f"{parts.geturl()}: {e}") from e
    if port is not None:
        return port
    return 443 if parts.scheme == "https" else 80


def follow_redirect(current: Request, location: str, status: int) -> Request:
    """The request a redirect asks for. It never goes from https to http;
    credentials go to the same origin only; 303, and 301 or 302 after a
    POST, become a GET without a body."""
    target = urljoin(current.url, location)
    old, new = urlsplit(current.url), _target(target)
    if old.scheme == "https" and new.scheme != "https":
        raise HttpError(f"{current.url}: redirected to {target}, from https to http")
    method, body = current.method, current.body
    headers = dict(current.headers)
    if status == _SEE_OTHER or (status in _MOVED and method == "POST"):
        method = "HEAD" if method == "HEAD" else "GET"
        body = None
        headers = {
            k: v for k, v in headers.items() if k.lower() not in ("content-type", "content-length")
        }
    if (old.scheme, old.hostname, _port(old)) != (new.scheme, new.hostname, _port(new)):
        headers = {k: v for k, v in headers.items() if k.lower() not in _CREDENTIALS}
    return Request(method, target, headers, body)
