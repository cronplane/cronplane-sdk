"""The hosts a step may reach: the cases every library for actions passes
(`contract/network/cases.json`), and where this library applies them."""

from __future__ import annotations

import ipaddress
import json
import re
from pathlib import Path
from typing import cast

import pytest

from cronplane_actions import (
    ActionError,
    AllowedHosts,
    Egress,
    EgressError,
    HttpClient,
    JsonValue,
    Network,
)
from cronplane_actions._network import is_loopback

from .conftest import Server, Step
from .test_http import resolver, to_local

_CASES = cast(
    "dict[str, JsonValue]",
    json.loads(
        (Path(__file__).parents[2] / "contract/network/cases.json").read_text(encoding="utf-8")
    ),
)
_HOSTS = cast("dict[str, list[str]]", _CASES["hosts"])
_LISTS = cast("list[dict[str, JsonValue]]", _CASES["lists"])


def _allow(*hosts: str) -> AllowedHosts:
    allowed = AllowedHosts.parse("\n".join(hosts))
    assert allowed is not None
    return allowed


def test_the_cases_are_those_of_the_version_this_library_reads() -> None:
    assert (_CASES["version"], _CASES["variable"]) == (1, "CRONPLANE_NETWORK_ALLOW")
    assert _HOSTS["valid"]
    assert _HOSTS["invalid"]
    assert _LISTS


@pytest.mark.parametrize("host", _HOSTS["valid"])
def test_a_host_of_the_contract_is_read(host: str) -> None:
    assert _allow(host).lines == (host,)


@pytest.mark.parametrize("host", _HOSTS["invalid"])
def test_a_line_that_is_not_a_host_is_an_error_never_a_host_ignored(host: str) -> None:
    with pytest.raises(ActionError, match=r"^host "):
        AllowedHosts.parse(f"api.example.com\n{host}")


@pytest.mark.parametrize("case", _LISTS, ids=lambda c: str(c["name"]))
def test_a_list_lets_through_its_hosts_and_stops_the_others(case: dict[str, JsonValue]) -> None:
    allowed = _allow(*cast("list[str]", case["allow"]))
    reached = cast("list[tuple[str, int]]", case["allowed"])
    stopped = cast("list[tuple[str, int]]", case["refused"])
    assert reached
    assert stopped
    for host, port in reached:
        assert allowed.allows(host, port), (host, port)
        allowed.check(host, port)
    for host, port in stopped:
        assert not allowed.allows(host, port), (host, port)
        with pytest.raises(EgressError):
            allowed.check(host, port)


def test_without_the_variable_every_host_is_allowed_and_an_empty_one_is_an_error() -> None:
    assert AllowedHosts.parse(None) is None
    with pytest.raises(ActionError, match="host ''"):
        AllowedHosts.parse("")


def test_a_refusal_names_the_host_and_the_list() -> None:
    with pytest.raises(EgressError) as refused:
        _allow("api.hubapi.com", "*.hubspot.com:443").check("evil.example.com", 443)
    assert str(refused.value) == (
        "evil.example.com:443 is not one of the hosts this step may reach "
        "(api.hubapi.com, *.hubspot.com:443): see network.allow of the action and of the step"
    )


def test_the_http_client_refuses_a_host_out_of_the_list_before_resolving(server: Server) -> None:
    server.routes["/item"] = (200, {}, b"ok")
    attempts: list[str] = []
    client = HttpClient(
        Egress.ANY,
        _allow(f"api.test:{server.port}"),
        plain=_allow("api.test"),
        resolve=resolver({"api.test": ["1.1.1.1"], "evil.test": ["2.2.2.2"]}),
        connect=to_local(server, attempts),
    )
    assert client.get(server.url("/item", host="api.test")).body == b"ok"
    with pytest.raises(EgressError, match=re.escape(f"evil.test:{server.port} is not one of")):
        client.get(server.url("/item", host="evil.test"))
    with pytest.raises(EgressError, match=re.escape("api.test:80 is not one of")):
        client.get("http://api.test/item")
    assert attempts == ["1.1.1.1"], "nothing resolved nor connected for a host refused"


def test_a_redirect_to_a_host_out_of_the_list_is_refused(server: Server) -> None:
    server.routes["/start"] = (302, {"location": f"http://evil.test:{server.port}/take"}, b"")
    attempts: list[str] = []
    client = HttpClient(
        Egress.ANY,
        _allow("api.test"),
        plain=_allow("api.test"),
        resolve=resolver({"api.test": ["1.1.1.1"], "evil.test": ["2.2.2.2"]}),
        connect=to_local(server, attempts),
    )
    with pytest.raises(EgressError, match=re.escape("evil.test")):
        client.get(server.url("/start", host="api.test"))
    assert [seen.path for seen in server.seen] == ["/start"]


def test_the_list_of_the_step_reaches_the_http_client_and_the_connections(step: Step) -> None:
    action = step.action()
    assert (action.http.allowed, action.network.allowed) == (None, None)
    step.env["CRONPLANE_NETWORK_ALLOW"] = "api.hubapi.com\ndb.acme.internal:5432"
    action = step.action()
    assert action.http.allowed is not None
    assert action.http.allowed.lines == ("api.hubapi.com", "db.acme.internal:5432")
    assert action.network.allowed == action.http.allowed
    step.env["CRONPLANE_NETWORK_ALLOW"] = "api.hubapi.com\nNot A Host"
    with pytest.raises(ActionError, match="host 'Not A Host'"):
        step.action()


def test_a_connection_goes_to_addresses_checked_for_the_list_and_the_worker() -> None:
    names = {"db.acme.internal": ["10.0.0.7"], "db.public.test": ["1.1.1.1", "10.0.0.5"]}
    own = Network(Egress.ANY, _allow("db.acme.internal:5432"), resolver(names))
    assert [str(a) for a in own.resolve("db.acme.internal", 5432)] == ["10.0.0.7"]
    with pytest.raises(EgressError, match=re.escape("db.acme.internal:5433 is not one of")):
        own.resolve("db.acme.internal", 5433)

    shared = Network(Egress.PUBLIC, None, resolver(names))
    with pytest.raises(EgressError, match=re.escape("db.public.test resolves to 10.0.0.5")):
        shared.resolve("db.public.test", 5432)
    assert Network(Egress.ANY, None, resolver(names)).resolve("db.public.test", 5432)
    public = Network(Egress.PUBLIC, None, resolver({"api.test": ["1.1.1.1", "2606:4700::1111"]}))
    assert [str(a) for a in public.resolve("api.test", 443)] == ["1.1.1.1", "2606:4700::1111"]


@pytest.mark.parametrize("address", ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"])
def test_an_address_of_this_machine_is_loopback(address: str) -> None:
    assert is_loopback(ipaddress.ip_address(address))


@pytest.mark.parametrize("address", ["10.0.0.1", "1.1.1.1", "169.254.169.254", "::ffff:10.0.0.1"])
def test_an_address_of_another_machine_is_not_loopback(address: str) -> None:
    assert not is_loopback(ipaddress.ip_address(address))


def test_the_http_client_sends_nothing_in_clear_out_of_this_machine(server: Server) -> None:
    server.routes["/item"] = (200, {}, b"ok")
    attempts: list[str] = []
    names = {"api.test": ["1.1.1.1"], "mixed.test": ["127.0.0.1", "1.1.1.1"], "local.test": ["::1"]}
    client = HttpClient(Egress.ANY, resolve=resolver(names), connect=to_local(server, attempts))
    for host in ("api.test", "mixed.test"):
        with pytest.raises(
            EgressError, match=re.escape(f"{host}:{server.port} is reached in clear")
        ):
            client.get(server.url("/item", host=host))
    assert attempts == [], "nothing connected for a host refused"
    assert client.get(server.url("/item", host="local.test")).body == b"ok"
    assert HttpClient(Egress.ANY).get(server.url("/item")).body == b"ok"


def test_a_step_names_the_hosts_it_reaches_in_clear(server: Server) -> None:
    server.routes["/item"] = (200, {}, b"ok")
    attempts: list[str] = []
    client = HttpClient(
        Egress.ANY,
        plain=_allow(f"api.test:{server.port}"),
        resolve=resolver({"api.test": ["1.1.1.1"], "other.test": ["2.2.2.2"]}),
        connect=to_local(server, attempts),
    )
    assert client.get(server.url("/item", host="api.test")).body == b"ok"
    with pytest.raises(EgressError, match=re.escape("other.test")):
        client.get(server.url("/item", host="other.test"))
    with pytest.raises(EgressError, match=re.escape("api.test:80 is reached in clear")):
        client.get("http://api.test/item")
    assert attempts == ["1.1.1.1"]


def test_the_hosts_in_clear_of_the_step_reach_the_http_and_smtp_clients(step: Step) -> None:
    action = step.action()
    assert (action.http.plain, action.smtp.plain, action.smtp.allowed) == (None, None, None)
    step.env["CRONPLANE_NETWORK_ALLOW"] = "relay.internal:25\napi.hubapi.com"
    step.env["CRONPLANE_NETWORK_PLAIN"] = "relay.internal:25"
    action = step.action()
    assert action.http.plain is not None
    assert action.http.plain.lines == ("relay.internal:25",)
    assert action.smtp.plain == action.http.plain
    assert action.smtp.allowed == action.http.allowed
    step.env["CRONPLANE_NETWORK_PLAIN"] = "Not A Host"
    with pytest.raises(ActionError, match="host 'Not A Host'"):
        step.action()
