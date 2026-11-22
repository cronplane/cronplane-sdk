"""An SMTP client for actions, on the standard library only.

It follows the same rules as the HTTP client: the hosts the step may reach,
public addresses only on a shared worker, and a connection to an address
checked. A message leaves this machine encrypted: `smtps://` (TLS from the
first byte) or `smtp://` with STARTTLS, which the server must offer. In
clear, it goes to this machine only, or to a host the step names in
`network.plain`.
"""

from __future__ import annotations

import smtplib
import socket
import ssl
from collections.abc import Sequence
from dataclasses import dataclass, field
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from urllib.parse import SplitResult, unquote, urlsplit

from ._errors import EgressError, SmtpError
from ._http import Connect, Egress, Resolve, is_public, system_connect, system_resolve
from ._network import AllowedHosts, IpAddress, is_loopback

_PORTS = {"smtp": 587, "smtps": 465}


@dataclass(frozen=True)
class _Server:
    scheme: str
    host: str
    port: int
    user: str | None
    password: str | None


def _server(url: str) -> _Server:
    """`url` split, when it is `smtp://` or `smtps://` with a host."""
    parts: SplitResult = urlsplit(url)
    default = _PORTS.get(parts.scheme)
    if default is None:
        raise SmtpError("the URL of the server starts with smtp:// or smtps://")
    if not parts.hostname:
        raise SmtpError("the URL of the server has no host")
    try:
        port = parts.port or default
    except ValueError as e:
        raise SmtpError(f"{parts.hostname}: {e}") from e
    user = unquote(parts.username) if parts.username is not None else None
    password = unquote(parts.password) if parts.password is not None else None
    return _Server(parts.scheme, parts.hostname, port, user, password)


class _Pinned(smtplib.SMTP):
    """An SMTP session over a socket that already goes to a checked address."""

    def __init__(self, sock: socket.socket, host: str, timeout: float) -> None:
        super().__init__(timeout=timeout)
        self._pinned = sock
        # STARTTLS checks the certificate against this name, and some Python
        # versions leave it empty when `connect` is a separate call.
        self._host = host

    def _get_socket(self, host: str, port: int, timeout: float) -> socket.socket:
        return self._pinned


@dataclass(frozen=True)
class SmtpClient:
    """Sends messages within the worker's egress rule and the hosts the step
    may reach. Each exchange with the server has a timeout."""

    egress: Egress
    #: The only hosts the step reaches; `None`: any host.
    allowed: AllowedHosts | None = None
    #: The hosts the step reaches in clear, beside this machine.
    plain: AllowedHosts | None = None
    timeout: float = 30.0
    #: CA certificates to trust instead of the system's (a server with its own CA).
    ca_file: str | None = None
    resolve: Resolve = field(default=system_resolve, repr=False)
    connect: Connect = field(default=system_connect, repr=False)

    def send(  # noqa: PLR0913 # the parts of a message, each named
        self,
        url: str,
        *,
        sender: str,
        to: Sequence[str],
        subject: str,
        text: str,
        html: str | None = None,
    ) -> None:
        """Sends one message through the server at `url`
        (`smtp://user:password@host:587`, `smtps://…:465`; a secret of the
        step). `text` is its body; `html`, an alternative to it."""
        server = _server(url)
        message = _message(sender, to, subject, text, html)
        addresses = self._checked(server)
        clear = server.scheme == "smtp" and self._clear(server, addresses)
        sock = self._open(addresses, server)
        session = _Pinned(sock, server.host, self.timeout)
        try:
            session.connect(server.host, server.port)
            if server.scheme == "smtp" and not clear:
                session.ehlo()
                if not session.has_extn("starttls"):
                    raise SmtpError(
                        f"{server.host}:{server.port} does not offer STARTTLS: what leaves "
                        "this machine is encrypted, unless the step names the host in "
                        "network.plain"
                    )
                session.starttls(context=ssl.create_default_context(cafile=self.ca_file))
            if server.user is not None:
                session.login(server.user, server.password or "")
            session.send_message(message, from_addr=sender, to_addrs=list(to))
        except (OSError, smtplib.SMTPException) as e:
            raise SmtpError(f"{server.host}:{server.port}: {e}") from e
        finally:
            session.close()

    def _checked(self, server: _Server) -> Sequence[IpAddress]:
        if self.allowed is not None:
            self.allowed.check(server.host, server.port)
        addresses = self.resolve(server.host, server.port)
        if not addresses:
            raise SmtpError(f"{server.host}: the name resolves to no address")
        if self.egress is Egress.PUBLIC:
            for address in addresses:
                if not is_public(address):
                    raise EgressError(
                        f"{server.host} resolves to {address}, not a public address: this "
                        "worker lets its steps reach public addresses only"
                    )
        return addresses

    def _clear(self, server: _Server, addresses: Sequence[IpAddress]) -> bool:
        """Whether the message may go in clear: to this machine, or to a host
        the step names."""
        if all(is_loopback(address) for address in addresses):
            return True
        return self.plain is not None and self.plain.allows(server.host, server.port)

    def _open(self, addresses: Sequence[IpAddress], server: _Server) -> socket.socket:
        failures: list[str] = []
        for address in addresses:
            try:
                sock = self.connect(address, server.port, self.timeout)
            except OSError as e:
                failures.append(f"{address}: {e}")
                continue
            if server.scheme != "smtps":
                return sock
            context = ssl.create_default_context(cafile=self.ca_file)
            try:
                return context.wrap_socket(sock, server_hostname=server.host)
            except OSError as e:
                sock.close()
                raise SmtpError(f"{server.host}: TLS: {e}") from e
        raise SmtpError(f"{server.host}:{server.port}: no connection ({'; '.join(failures)})")


def _message(
    sender: str, to: Sequence[str], subject: str, text: str, html: str | None
) -> EmailMessage:
    if not to:
        raise SmtpError("a message has one recipient at least")
    message = EmailMessage()
    try:
        message["From"] = sender
        message["To"] = ", ".join(to)
        message["Subject"] = subject
    except ValueError as e:
        raise SmtpError(f"the message has a header that is not one line: {e}") from e
    message["Date"] = formatdate()
    message["Message-ID"] = make_msgid()
    message.set_content(text)
    if html is not None:
        message.add_alternative(html, subtype="html")
    return message
