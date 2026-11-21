/**
 * The hosts a step may reach: the cases every library for actions passes
 * (`contract/network/cases.json`), and where this library applies them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ActionError, AllowedHosts, Egress, EgressError, HttpClient, isLoopback, Network } from "../src/index.ts";
import { Case, rejects, resolver, Server, Step, toLocal } from "./helpers.ts";

const CASES = Case.of("network");
const VALID = CASES.get("hosts").get("valid").list().map((host) => host.text());
const INVALID = CASES.get("hosts").get("invalid").list().map((host) => host.text());
const LISTS = CASES.get("lists").list();

function allow(...hosts: string[]): AllowedHosts {
  const allowed = AllowedHosts.parse(hosts.join("\n"));
  if (allowed === undefined) {
    throw new Error("a list is expected");
  }
  return allowed;
}

/** The `[host, port]` pairs of a list of the contract. */
function pairs(list: Case): [string, number][] {
  return list.list().map((pair) => {
    const [host, port] = pair.list();
    return [host?.text() ?? "", port?.number() ?? 0];
  });
}

test("the cases are those of the version this library reads", () => {
  expect([CASES.get("version").value, CASES.get("variable").value]).toEqual([1, "CRONPLANE_NETWORK_ALLOW"]);
  expect(VALID.length).toBeGreaterThan(0);
  expect(INVALID.length).toBeGreaterThan(0);
  expect(LISTS.length).toBeGreaterThan(0);
});

describe("the hosts of the contract", () => {
  test.each(VALID)("%p is read", (host) => {
    expect(allow(host).lines).toEqual([host]);
  });

  test.each(INVALID)("%p is not a host: an error, never a host ignored", (host) => {
    expect(() => AllowedHosts.parse(`api.example.com\n${host}`)).toThrow(ActionError);
    expect(() => AllowedHosts.parse(`api.example.com\n${host}`)).toThrow(`host ${JSON.stringify(host)}: `);
  });

  test.each(LISTS.map((c) => c.named()))("%s", (_name, c) => {
    const allowed = allow(...c.get("allow").list().map((host) => host.text()));
    const reached = pairs(c.get("allowed"));
    const stopped = pairs(c.get("refused"));
    expect(reached.length).toBeGreaterThan(0);
    expect(stopped.length).toBeGreaterThan(0);
    for (const [host, port] of reached) {
      expect([host, port, allowed.allows(host, port)]).toEqual([host, port, true]);
      allowed.check(host, port);
    }
    for (const [host, port] of stopped) {
      expect([host, port, allowed.allows(host, port)]).toEqual([host, port, false]);
      expect(() => {
        allowed.check(host, port);
      }).toThrow(EgressError);
    }
  });
});

test("without the variable every host is allowed, and an empty one is an error", () => {
  expect(AllowedHosts.parse(undefined)).toBeUndefined();
  expect(() => AllowedHosts.parse("")).toThrow('host "": a name (api.example.com)');
});

test("a line that is not a host says what is expected", () => {
  const messages: [string, string][] = [
    ["example.com:pg", 'host "example.com:pg": a port is a number from 1 to 65535'],
    ["[2001:db8::1]:65536", 'host "[2001:db8::1]:65536": a port is a number from 1 to 65535'],
    ["[10.0.0.7]:5432", 'host "[10.0.0.7]:5432": [ and ] hold an IPv6 address'],
    ["[2001:db8::1]5432", 'host "[2001:db8::1]5432": after ], a port (":5432") or nothing'],
    [
      "API.hubapi.com",
      'host "API.hubapi.com": a name (api.example.com), a name under a domain (*.example.com) or an IP address, in lowercase, with an optional port (:5432)',
    ],
  ];
  for (const [line, message] of messages) {
    expect(() => AllowedHosts.parse(line)).toThrow(new ActionError(message));
  }
});

test("an address of the list is one address, whatever its writing, its family and its zone", () => {
  const allowed = allow("[::ffff:10.0.0.7]:5432", "fe80::1%eth0", "[2001:DB8::1]");
  expect(allowed.allows("::ffff:a00:7", 5432)).toBe(true);
  expect(allowed.allows("10.0.0.7", 5432)).toBe(false);
  expect(allowed.allows("FE80:0::1%eth0", 22)).toBe(true);
  expect(allowed.allows("fe80::1%eth1", 22)).toBe(false);
  expect(allowed.allows("fe80::1", 22)).toBe(false);
  expect(allowed.allows("2001:db8::1.", 443)).toBe(true);
  expect(allow("a".repeat(63)).allows("A".repeat(63), 1)).toBe(true);
  expect(() => allow("a".repeat(64))).toThrow(ActionError);
  expect(() => allow(`${"a.".repeat(126)}ab`)).toThrow(ActionError);
});

test("a name under a domain never allows an address that ends as the domain", () => {
  const allowed = allow("*.0.7");
  expect(allowed.allows("10.0.0.7", 443)).toBe(false);
  expect(allowed.allows("x.0.7", 443)).toBe(true);
});

test("a refusal names the host and the list", () => {
  expect(() => {
    allow("api.hubapi.com", "*.hubspot.com:443").check("evil.example.com", 443);
  }).toThrow(
    new EgressError(
      "evil.example.com:443 is not one of the hosts this step may reach (api.hubapi.com, *.hubspot.com:443): see network.allow of the action and of the step",
    ),
  );
});

describe("the HTTP client", () => {
  let server: Server;
  const names = { "api.test": ["1.1.1.1"], "evil.test": ["2.2.2.2"] };
  beforeEach(async () => {
    server = await Server.start();
  });
  afterEach(() => server.stop());

  test("a host out of the list is refused before resolving", async () => {
    server.routes.set("/item", [200, {}, "ok"]);
    const attempts: string[] = [];
    const resolved: string[] = [];
    const client = new HttpClient(Egress.Any, {
      allowed: allow(`api.test:${String(server.port)}`),
      plain: allow("api.test"),
      resolve: (host) => {
        resolved.push(host);
        return resolver(names)(host);
      },
      dial: toLocal(attempts),
    });
    expect((await client.get(server.url("/item", "api.test"))).text()).toBe("ok");
    await rejects(client.get(server.url("/item", "evil.test")), new EgressError(
      `evil.test:${String(server.port)} is not one of the hosts this step may reach (api.test:${String(server.port)}): see network.allow of the action and of the step`,
    ));
    await rejects(client.get("http://api.test/item"), /^api\.test:80 is not one of/);
    await rejects(client.get("https://api.test/item"), /^api\.test:443 is not one of/);
    expect([resolved, attempts]).toEqual([["api.test"], ["1.1.1.1"]]);
  });

  test("a redirect to a host out of the list is refused", async () => {
    server.routes.set("/start", [302, { location: `http://evil.test:${String(server.port)}/take` }, ""]);
    const client = new HttpClient(Egress.Any, {
      allowed: allow("api.test"),
      plain: allow("api.test"),
      resolve: resolver(names),
      dial: toLocal([]),
    });
    await rejects(client.get(server.url("/start", "api.test")), /^evil\.test:\d+ is not one of/);
    expect(server.seen.map((seen) => seen.path)).toEqual(["/start"]);
  });

  test("an address of the list is reached in any writing of the URL", async () => {
    server.routes.set("/item", [200, {}, "ok"]);
    const client = new HttpClient(Egress.Any, { allowed: allow("127.0.0.1", "::1") });
    expect((await client.get(server.url("/item"))).text()).toBe("ok");
    await rejects(client.get(server.url("/item", "127.0.0.2")), EgressError);
    // The list lets the address through: the failure is of the connection (the server listens on IPv4 only).
    await rejects(client.get(server.url("/item", "[0:0::1]")), /^GET http:\/\/\[0:0::1\]:\d+\/item: /);
  });
});

test("the list of the step reaches the HTTP client and the connections", () => {
  const step = new Step();
  expect([step.action().http.allowed, step.action().network.allowed]).toEqual([undefined, undefined]);
  step.env["CRONPLANE_NETWORK_ALLOW"] = "api.hubapi.com\ndb.acme.internal:5432";
  const action = step.action();
  expect(action.http.allowed?.lines).toEqual(["api.hubapi.com", "db.acme.internal:5432"]);
  expect(action.network.allowed).toBe(action.http.allowed);
  step.env["CRONPLANE_NETWORK_ALLOW"] = "api.hubapi.com\nNot A Host";
  expect(() => step.action()).toThrow('host "Not A Host": ');
});

test("a connection goes to addresses checked for the list and the worker", async () => {
  const names = { "db.acme.internal": ["10.0.0.7"], "db.public.test": ["1.1.1.1", "10.0.0.5"] };
  const own = new Network(Egress.Any, allow("db.acme.internal:5432"), resolver(names));
  expect(await own.resolve("db.acme.internal", 5432)).toEqual([{ address: "10.0.0.7", family: 4 }]);
  await rejects(own.resolve("db.acme.internal", 5433), /^db\.acme\.internal:5433 is not one of/);

  const shared = new Network(Egress.Public, undefined, resolver(names));
  await rejects(shared.resolve("db.public.test", 5432), new EgressError(
    "db.public.test resolves to 10.0.0.5, not a public address: this worker lets its steps reach public addresses only",
  ));
  expect((await new Network(Egress.Any, undefined, resolver(names)).resolve("db.public.test", 5432)).length).toBe(2);
  const open = new Network(Egress.Public, undefined, resolver({ "api.test": ["1.1.1.1", "2606:4700::1111"] }));
  expect((await open.resolve("api.test", 443)).map(({ address }) => address)).toEqual(["1.1.1.1", "2606:4700::1111"]);
  expect(await new Network(Egress.Any, undefined).resolve("127.0.0.1", 80)).toEqual([{ address: "127.0.0.1", family: 4 }]);
});

describe("what goes in clear", () => {
  let server: Server;
  beforeEach(async () => {
    server = await Server.start();
  });
  afterEach(() => server.stop());

  test.each(["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"])("%s is of this machine", (address) => {
    expect(isLoopback(address)).toBe(true);
  });

  test.each(["10.0.0.1", "1.1.1.1", "169.254.169.254", "::ffff:10.0.0.1", "::2", "localhost"])(
    "%s is not of this machine",
    (address) => {
      expect(isLoopback(address)).toBe(false);
    },
  );

  test("the HTTP client sends nothing in clear out of this machine", async () => {
    server.routes.set("/item", [200, {}, "ok"]);
    const attempts: string[] = [];
    const client = new HttpClient(Egress.Any, {
      resolve: resolver({ "api.test": ["1.1.1.1"], "mixed.test": ["127.0.0.1", "1.1.1.1"], "local.test": ["127.0.0.1"] }),
      dial: toLocal(attempts),
    });
    for (const host of ["api.test", "mixed.test"]) {
      await rejects(client.get(server.url("/item", host)), new EgressError(
        `${host}:${String(server.port)} is reached in clear: what leaves this machine is encrypted (https, STARTTLS), unless the step names the host in network.plain`,
      ));
    }
    expect(attempts).toEqual([]);
    expect((await client.get(server.url("/item", "local.test"))).text()).toBe("ok");
    expect((await new HttpClient(Egress.Any).get(server.url("/item"))).text()).toBe("ok");
  });

  test("a step names the hosts it reaches in clear", async () => {
    server.routes.set("/item", [200, {}, "ok"]);
    const attempts: string[] = [];
    const client = new HttpClient(Egress.Any, {
      plain: allow(`api.test:${String(server.port)}`),
      resolve: resolver({ "api.test": ["1.1.1.1"], "other.test": ["2.2.2.2"] }),
      dial: toLocal(attempts),
    });
    expect((await client.get(server.url("/item", "api.test"))).text()).toBe("ok");
    await rejects(client.get(server.url("/item", "other.test")), /^other\.test:\d+ is reached in clear/);
    await rejects(client.get("http://api.test/item"), /^api\.test:80 is reached in clear/);
    expect(attempts).toEqual(["1.1.1.1"]);
  });

  test("the hosts in clear of the step reach the HTTP and SMTP clients", () => {
    const step = new Step();
    let action = step.action();
    expect([action.http.plain, action.smtp.plain, action.smtp.allowed]).toEqual([undefined, undefined, undefined]);
    step.env["CRONPLANE_NETWORK_ALLOW"] = "relay.internal:25\napi.hubapi.com";
    step.env["CRONPLANE_NETWORK_PLAIN"] = "relay.internal:25";
    action = step.action();
    expect(action.http.plain?.lines).toEqual(["relay.internal:25"]);
    expect(action.smtp.plain).toBe(action.http.plain);
    expect(action.smtp.allowed).toBe(action.http.allowed);
    step.env["CRONPLANE_NETWORK_PLAIN"] = "Not A Host";
    expect(() => step.action()).toThrow(/host "Not A Host"/);
  });
});
