"""The HTTP client and its guard against SSRF on a shared worker."""

from __future__ import annotations

import ipaddress
import re
import socket
from collections.abc import Sequence

import pytest

from cronplane_actions import Egress, EgressError, HttpClient, HttpError, is_public
from cronplane_actions._http import IpAddress, Request, follow_redirect

from .conftest import Server


@pytest.mark.parametrize(
    "address",
    [
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "127.0.0.1",
        "169.254.169.254",  # cloud metadata
        "100.100.100.200",  # CGNAT, a cloud's metadata
        "0.0.0.0",  # noqa: S104 # the address under test, never bound
        "224.0.0.1",
        "::1",
        "fd00:ec2::254",  # cloud metadata over IPv6
        "fe80::1",
        "::ffff:127.0.0.1",  # IPv4-mapped
        "2002:a9fe:a9fe::1",  # 6to4 carrying 169.254.169.254
        "64:ff9b::a9fe:a9fe",  # NAT64 carrying 169.254.169.254
        "ff02::1",
    ],
)
def test_an_address_out_of_the_internet_is_not_public(address: str) -> None:
    assert not is_public(ipaddress.ip_address(address))


@pytest.mark.parametrize("address", ["1.1.1.1", "2606:4700:4700::1111", "64:ff9b::101:101"])
def test_an_address_of_the_internet_is_public(address: str) -> None:
    assert is_public(ipaddress.ip_address(address))


def resolver(names: dict[str, list[str]]):  # noqa: ANN201 # a function of the HttpClient's type
    def resolve(host: str, _port: int) -> Sequence[IpAddress]:
        return [ipaddress.ip_address(a) for a in names.get(host, [])]

    return resolve


def to_local(server: Server, attempts: list[str]):  # noqa: ANN201
    """Connects every checked address to the local server, recording it."""

    def connect(address: IpAddress, _port: int, timeout: float) -> socket.socket:
        attempts.append(str(address))
        return socket.create_connection(("127.0.0.1", server.port), timeout=timeout)

    return connect


def test_any_address_on_a_worker_of_the_customer(server: Server) -> None:
    server.routes["/item"] = (200, {"content-type": "application/json", "x-id": "7"}, b'{"n": 1}')
    response = HttpClient(Egress.ANY).get(
        server.url("/item"), headers={"accept": "application/json"}
    )
    assert (response.status, response.json(), response.headers["x-id"]) == (200, {"n": 1}, "7")
    assert response.text() == '{"n": 1}'
    assert server.seen[0].headers["accept"] == "application/json"


def test_a_private_address_is_refused_before_connecting(server: Server) -> None:
    with pytest.raises(EgressError, match=re.escape("127.0.0.1, not a public address")):
        HttpClient(Egress.PUBLIC).get(server.url("/item"))
    assert server.seen == []


def test_a_name_resolving_to_one_private_address_among_public_ones_is_refused(
    server: Server,
) -> None:
    attempts: list[str] = []
    client = HttpClient(
        Egress.PUBLIC,
        resolve=resolver({"rebind.test": ["1.1.1.1", "10.0.0.5"]}),
        connect=to_local(server, attempts),
    )
    with pytest.raises(EgressError, match=re.escape("10.0.0.5")):
        client.get("http://rebind.test/")
    assert attempts == []


def test_a_redirect_to_the_metadata_address_is_checked_again(server: Server) -> None:
    server.routes["/start"] = (302, {"location": "http://metadata.test/latest/"}, b"")
    attempts: list[str] = []
    client = HttpClient(
        Egress.PUBLIC,
        resolve=resolver({"api.test": ["1.1.1.1"], "metadata.test": ["169.254.169.254"]}),
        connect=to_local(server, attempts),
    )
    with pytest.raises(EgressError, match=re.escape("169.254.169.254")):
        client.get("http://api.test/start")
    assert attempts == ["1.1.1.1"], "connected to the checked address only"


def test_credentials_follow_a_redirect_to_the_same_origin_only(server: Server) -> None:
    server.routes["/here"] = (302, {"location": "/end"}, b"")
    server.routes["/away"] = (307, {"location": f"http://b.test:{server.port}/end"}, b"")
    server.routes["/end"] = (200, {}, b"done")
    client = HttpClient(
        Egress.ANY,
        resolve=resolver({"a.test": ["127.0.0.1"], "b.test": ["127.0.0.1"]}),
    )
    secret = {"authorization": "Bearer s3cr3t", "cookie": "id=1", "accept": "*/*"}
    assert client.get(f"http://a.test:{server.port}/here", headers=secret).text() == "done"
    assert server.seen[1].headers["authorization"] == "Bearer s3cr3t"
    client.get(f"http://a.test:{server.port}/away", headers=secret)
    kept = server.seen[3].headers
    assert ("authorization" in kept, "cookie" in kept, kept["accept"]) == (False, False, "*/*")


def test_a_post_redirected_by_303_becomes_a_get_without_body(server: Server) -> None:
    server.routes["/form"] = (303, {"location": "/result"}, b"")
    server.routes["/result"] = (200, {}, b"ok")
    response = HttpClient(Egress.ANY).post_json(server.url("/form"), {"a": 1})
    assert response.url == server.url("/result")
    assert [(s.method, s.body) for s in server.seen] == [("POST", b'{"a": 1}'), ("GET", b"")]


def test_redirects_are_limited(server: Server) -> None:
    server.routes["/loop"] = (302, {"location": "/loop"}, b"")
    with pytest.raises(HttpError, match="more than 2 redirects"):
        HttpClient(Egress.ANY, max_redirects=2).get(server.url("/loop"))
    assert len(server.seen) == 3


def test_a_response_over_the_limit_is_refused(server: Server) -> None:
    server.routes["/big"] = (200, {}, b"x" * 20)
    with pytest.raises(HttpError, match="over 10 bytes"):
        HttpClient(Egress.ANY, max_body=10).get(server.url("/big"))
    assert HttpClient(Egress.ANY, max_body=20).get(server.url("/big")).body == b"x" * 20


def test_a_response_that_is_not_json_says_so(server: Server) -> None:
    server.routes["/text"] = (200, {}, b"hello")
    with pytest.raises(HttpError, match="the response is not JSON"):
        HttpClient(Egress.ANY).get(server.url("/text")).json()


def test_a_post_sends_its_body(server: Server) -> None:
    server.routes["/raw"] = (201, {}, b"")
    response = HttpClient(Egress.ANY).post(server.url("/raw"), b"payload", headers={"x-a": "1"})
    assert (response.status, server.seen[0].body, server.seen[0].headers["x-a"]) == (
        201,
        b"payload",
        "1",
    )


@pytest.mark.parametrize(
    ("url", "message"),
    [
        ("ftp://example.com/", "an http or https URL is expected"),
        ("http:///path", "the URL has no host"),
        ("https://user:pass@example.com/", "credentials in the URL"),
        ("http://example.com:99999/", "out of range"),
    ],
)
def test_an_unusable_url_is_refused_before_resolving(url: str, message: str) -> None:
    resolved: list[str] = []

    def resolve(host: str, _port: int) -> Sequence[IpAddress]:
        resolved.append(host)
        return []

    with pytest.raises(HttpError, match=message):
        HttpClient(Egress.ANY, resolve=resolve).get(url)
    assert resolved == []


def test_a_name_without_address_or_connection_fails_with_its_name(server: Server) -> None:
    with pytest.raises(HttpError, match="resolves to no address"):
        HttpClient(Egress.ANY, resolve=resolver({})).get("http://nowhere.test/")
    with pytest.raises(HttpError, match="the name does not resolve"):
        HttpClient(Egress.ANY).get("http://nowhere.invalid/")

    def refuse(_address: IpAddress, _port: int, _timeout: float) -> socket.socket:
        raise ConnectionRefusedError("refused")

    client = HttpClient(Egress.ANY, resolve=resolver({"down.test": ["127.0.0.1"]}), connect=refuse)
    with pytest.raises(HttpError, match=r"down.test:80: no connection \(127.0.0.1: refused\)"):
        client.get("http://down.test/")


def test_tls_is_verified_against_the_name(server: Server) -> None:
    server.routes["/"] = (200, {}, b"plain")
    client = HttpClient(Egress.ANY, resolve=resolver({"api.test": ["127.0.0.1"]}))
    with pytest.raises(HttpError, match=re.escape("api.test: TLS")):
        client.get(f"https://api.test:{server.port}/")


def test_a_redirect_never_goes_from_https_to_http() -> None:
    request = Request("GET", "https://api.test/a", {}, None)
    with pytest.raises(HttpError, match="from https to http"):
        follow_redirect(request, "http://api.test/b", 302)
    assert follow_redirect(request, "/b", 301).url == "https://api.test/b"


def test_a_head_redirected_by_303_stays_a_head() -> None:
    request = Request("HEAD", "http://api.test/a", {"content-type": "text/plain"}, None)
    followed = follow_redirect(request, "/b", 303)
    assert (followed.method, followed.headers) == ("HEAD", {})


def test_a_server_closing_without_answer_is_an_http_error() -> None:
    listener = socket.create_server(("127.0.0.1", 0))
    port = listener.getsockname()[1]

    def hang_up(_address: IpAddress, _port: int, timeout: float) -> socket.socket:
        client = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        accepted, _ = listener.accept()
        accepted.close()
        return client

    client = HttpClient(Egress.ANY, resolve=resolver({"api.test": ["127.0.0.1"]}), connect=hang_up)
    with pytest.raises(HttpError, match=re.escape("GET http://api.test/")):
        client.get("http://api.test/")
    listener.close()
