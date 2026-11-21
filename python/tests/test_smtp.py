"""The SMTP client: what it sends, and what it refuses to send in clear."""

from __future__ import annotations

import base64
import contextlib
import email
import email.policy
import ipaddress
import re
import socket
import socketserver
import threading
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from email.message import EmailMessage

import pytest

from cronplane_actions import AllowedHosts, Egress, EgressError, SmtpClient, SmtpError
from cronplane_actions._network import IpAddress


@dataclass
class Mailbox:
    """A local SMTP server, in clear: what it offers and what it received."""

    port: int = 0
    #: The extensions it announces after EHLO.
    offers: list[str] = field(default_factory=list[str])
    #: The recipients it refuses.
    refused: set[str] = field(default_factory=set[str])
    commands: list[str] = field(default_factory=list[str])
    messages: list[tuple[str, list[str], EmailMessage]] = field(
        default_factory=list[tuple[str, list[str], EmailMessage]]
    )

    def url(self, host: str = "127.0.0.1", credentials: str = "") -> str:
        return f"smtp://{credentials}{host}:{self.port}"


@pytest.fixture
def mailbox() -> Iterator[Mailbox]:
    box = Mailbox()

    class Session(socketserver.StreamRequestHandler):
        def say(self, line: str) -> None:
            self.wfile.write(line.encode() + b"\r\n")

        def handle(self) -> None:
            # A client that refuses to go on closes the connection.
            with contextlib.suppress(ConnectionError):
                self.talk()

        def talk(self) -> None:
            self.say("220 local")
            sender, recipients = "", list[str]()
            while line := self.rfile.readline().decode(errors="replace").rstrip("\r\n"):
                verb = line.split(" ")[0].upper()
                box.commands.append(verb)
                if verb == "EHLO":
                    self.say("250-local")
                    for extension in box.offers:
                        self.say(f"250-{extension}")
                    self.say("250 HELP")
                elif verb == "STARTTLS":
                    self.say("220 go ahead")
                    return
                elif verb == "MAIL":
                    sender, recipients = line.partition("<")[2].partition(">")[0], []
                    self.say("250 ok")
                elif verb == "RCPT":
                    recipient = line.partition("<")[2].partition(">")[0]
                    if recipient in box.refused:
                        self.say("550 no such user")
                    else:
                        recipients.append(recipient)
                        self.say("250 ok")
                elif verb == "DATA":
                    self.say("354 go")
                    raw = b""
                    while (part := self.rfile.readline()) != b".\r\n":
                        raw += part
                    parsed = email.message_from_bytes(raw, policy=email.policy.default)
                    assert isinstance(parsed, EmailMessage)
                    box.messages.append((sender, recipients, parsed))
                    self.say("250 kept")
                elif verb == "QUIT":
                    self.say("221 bye")
                    return
                elif verb == "AUTH":
                    box.commands.append(base64.b64decode(line.split(" ")[2]).decode())
                    self.say("235 ok")

    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Session)
    box.port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield box
    server.shutdown()
    server.server_close()


def far(mailbox: Mailbox, **options: AllowedHosts | Egress) -> SmtpClient:
    """A client for which `relay.test` is another machine, connected to the mailbox."""

    def resolve(host: str, _port: int) -> Sequence[IpAddress]:
        names = {"relay.test": ["203.0.113.5"], "inside.test": ["10.0.0.5"], "void.test": []}
        return [ipaddress.ip_address(a) for a in names.get(host, ["127.0.0.1"])]

    def connect(_address: IpAddress, _port: int, timeout: float) -> socket.socket:
        return socket.create_connection(("127.0.0.1", mailbox.port), timeout=timeout)

    egress = options.get("egress", Egress.ANY)
    allowed, plain = options.get("allowed"), options.get("plain")
    assert isinstance(egress, Egress)
    assert not isinstance(allowed, Egress)
    assert not isinstance(plain, Egress)
    return SmtpClient(egress, allowed, plain, timeout=5, resolve=resolve, connect=connect)


def send(client: SmtpClient, url: str, **message: str | None) -> None:
    client.send(
        url,
        sender=message.get("sender") or "flows@example.com",
        to=["ops@example.com", "dev@example.com"],
        subject=message.get("subject") or "Taux mis à jour",
        text="Le taux a changé.",
        html=message.get("html"),
    )


def test_a_message_goes_to_this_machine_in_clear(mailbox: Mailbox) -> None:
    send(SmtpClient(Egress.ANY, timeout=5), mailbox.url(), html="<p>Le taux a <b>changé</b>.</p>")
    sender, recipients, message = mailbox.messages[0]
    assert (sender, recipients) == ("flows@example.com", ["ops@example.com", "dev@example.com"])
    assert (message["Subject"], message["To"]) == (
        "Taux mis à jour",
        "ops@example.com, dev@example.com",
    )
    assert message["Date"]
    assert message["Message-ID"]
    text, html = message.get_body(("plain",)), message.get_body(("html",))
    assert text is not None
    assert html is not None
    assert text.get_content().strip() == "Le taux a changé."
    assert "<b>changé</b>" in html.get_content()
    assert "STARTTLS" not in mailbox.commands


def test_a_message_never_leaves_this_machine_in_clear(mailbox: Mailbox) -> None:
    with pytest.raises(SmtpError, match=r"relay\.test:.* does not offer STARTTLS"):
        send(far(mailbox), mailbox.url("relay.test"))
    assert mailbox.commands == ["EHLO"], "nothing of the message was sent"


def test_a_server_that_offers_starttls_gets_the_message_encrypted_only(mailbox: Mailbox) -> None:
    mailbox.offers = ["STARTTLS"]
    with pytest.raises(SmtpError, match=re.escape("relay.test")):
        send(far(mailbox), mailbox.url("relay.test"))
    assert mailbox.commands == ["EHLO", "STARTTLS"]
    assert mailbox.messages == []


def test_a_step_names_the_server_it_reaches_in_clear(mailbox: Mailbox) -> None:
    plain = AllowedHosts.parse(f"relay.test:{mailbox.port}")
    assert plain is not None
    send(far(mailbox, plain=plain), mailbox.url("relay.test"))
    assert len(mailbox.messages) == 1
    with pytest.raises(SmtpError, match=re.escape("does not offer STARTTLS")):
        send(far(mailbox, plain=plain), mailbox.url("inside.test"))


def test_smtps_is_tls_from_the_first_byte(mailbox: Mailbox) -> None:
    with pytest.raises(SmtpError, match=re.escape("127.0.0.1: TLS")):
        send(SmtpClient(Egress.ANY, timeout=5), mailbox.url().replace("smtp://", "smtps://"))
    assert mailbox.messages == []


def test_the_credentials_of_the_url_log_the_step_in(mailbox: Mailbox) -> None:
    mailbox.offers = ["AUTH PLAIN"]
    send(SmtpClient(Egress.ANY, timeout=5), mailbox.url(credentials="bot%40example.com:p%3Ass@"))
    assert "\0bot@example.com\0p:ss" in mailbox.commands
    assert len(mailbox.messages) == 1


def test_the_rules_of_the_step_and_of_the_worker_apply_before_any_connection(
    mailbox: Mailbox,
) -> None:
    allowed = AllowedHosts.parse("smtp.example.com:587")
    assert allowed is not None
    with pytest.raises(EgressError, match=r"relay\.test:.* is not one of the hosts"):
        send(far(mailbox, allowed=allowed), mailbox.url("relay.test"))
    with pytest.raises(
        EgressError, match=re.escape("inside.test resolves to 10.0.0.5, not a public address")
    ):
        send(far(mailbox, egress=Egress.PUBLIC), mailbox.url("inside.test"))
    with pytest.raises(SmtpError, match=re.escape("void.test: the name resolves to no address")):
        send(far(mailbox), mailbox.url("void.test"))
    assert mailbox.commands == []


def test_a_server_that_does_not_answer_is_an_error() -> None:
    with socket.socket() as taken:
        taken.bind(("127.0.0.1", 0))
        port = taken.getsockname()[1]
    with pytest.raises(SmtpError, match=re.escape(f"127.0.0.1:{port}: no connection")):
        send(SmtpClient(Egress.ANY, timeout=5), f"smtp://127.0.0.1:{port}")


def test_a_refusal_of_the_server_is_an_error(mailbox: Mailbox) -> None:
    mailbox.refused = {"ops@example.com", "dev@example.com"}
    with pytest.raises(SmtpError, match=re.escape("no such user")):
        send(SmtpClient(Egress.ANY, timeout=5), mailbox.url())


@pytest.mark.parametrize(
    ("url", "why"),
    [
        ("http://127.0.0.1", "starts with smtp:// or smtps://"),
        ("smtp://", "has no host"),
        ("smtp://127.0.0.1:port", "127.0.0.1: "),
    ],
)
def test_the_url_of_the_server_is_smtp_or_smtps_with_a_host(url: str, why: str) -> None:
    with pytest.raises(SmtpError, match=re.escape(why)):
        send(SmtpClient(Egress.ANY), url)


def test_a_message_has_a_recipient_and_headers_of_one_line(mailbox: Mailbox) -> None:
    client = SmtpClient(Egress.ANY, timeout=5)
    with pytest.raises(SmtpError, match=re.escape("one recipient at least")):
        client.send(mailbox.url(), sender="a@example.com", to=[], subject="x", text="y")
    with pytest.raises(SmtpError, match=re.escape("a header that is not one line")):
        send(client, mailbox.url(), subject="Rates\nBcc: all@example.com")
    assert mailbox.commands == []


def test_the_default_ports_are_those_of_submission(mailbox: Mailbox) -> None:
    ports: list[int] = []

    def connect(_address: IpAddress, port: int, timeout: float) -> socket.socket:
        ports.append(port)
        return socket.create_connection(("127.0.0.1", mailbox.port), timeout=timeout)

    send(SmtpClient(Egress.ANY, timeout=5, connect=connect), "smtp://127.0.0.1")
    with pytest.raises(SmtpError, match=re.escape("TLS")):
        send(SmtpClient(Egress.ANY, timeout=5, connect=connect), "smtps://127.0.0.1")
    assert ports == [587, 465]
