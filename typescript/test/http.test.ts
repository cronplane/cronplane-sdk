/** The HTTP client and its guard against SSRF on a shared worker. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer as createTcpServer } from "node:net";

import { AllowedHosts, Egress, EgressError, HttpClient, HttpError, isPublic } from "../src/index.ts";
import { followRedirect, lookupOf } from "../src/http.ts";
import { rejects, resolver, Server, toLocal } from "./helpers.ts";

describe("public addresses", () => {
  test.each([
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "100.100.100.200",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fd00:ec2::254",
    "fe80::1",
    "fe80::1%eth0",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "2002:a9fe:a9fe::1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::169.254.169.254",
    "2001:db8::1",
    "ff02::1",
    "not an address",
  ])("%s is not public", (address) => {
    expect(isPublic(address)).toBe(false);
  });

  test.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "64:ff9b::101:101", "::ffff:1.1.1.1", "2002:101:101::1"])(
    "%s is public",
    (address) => {
      expect(isPublic(address)).toBe(true);
    },
  );
});

describe("requests", () => {
  let server: Server;
  beforeEach(async () => {
    server = await Server.start();
  });
  afterEach(() => server.stop());

  test("any address on a worker of the customer", async () => {
    server.routes.set("/item", [200, { "content-type": "application/json", "x-id": "7" }, '{"n": 1}']);
    const response = await new HttpClient(Egress.Any).get(server.url("/item"), { accept: "application/json" });
    expect([response.status, response.json(), response.headers.get("x-id")]).toEqual([200, { n: 1 }, "7"]);
    expect(response.text()).toBe('{"n": 1}');
    expect(server.seen[0]?.headers["accept"]).toBe("application/json");
  });

  test("a private address is refused before connecting", async () => {
    await rejects(new HttpClient(Egress.Public).get(server.url("/item")), 
      new EgressError("127.0.0.1 resolves to 127.0.0.1, not a public address: this worker lets its steps reach public addresses only"),
    );
    await Bun.sleep(50);
    expect(server.seen).toEqual([]);
  });

  test("a name resolving to one private address among public ones is refused", async () => {
    const attempts: string[] = [];
    const client = new HttpClient(Egress.Public, {
      resolve: resolver({ "rebind.test": ["1.1.1.1", "10.0.0.5"] }),
      dial: toLocal(attempts),
    });
    await rejects(client.get(`http://rebind.test:${String(server.port)}/`), /10\.0\.0\.5/);
    expect(attempts).toEqual([]);
  });

  test("a redirect to the metadata address is checked again", async () => {
    server.routes.set("/start", [302, { location: "http://metadata.test/latest/" }, ""]);
    const attempts: string[] = [];
    const client = new HttpClient(Egress.Public, {
      plain: AllowedHosts.parse("api.test"),
      resolve: resolver({ "api.test": ["1.1.1.1"], "metadata.test": ["169.254.169.254"] }),
      dial: toLocal(attempts),
    });
    await rejects(client.get(`http://api.test:${String(server.port)}/start`), EgressError);
    expect(attempts).toEqual(["1.1.1.1"]);
  });

  test("credentials follow a redirect to the same origin only", async () => {
    server.routes.set("/here", [302, { location: "/end" }, ""]);
    server.routes.set("/away", [307, { location: `http://b.test:${String(server.port)}/end` }, ""]);
    server.routes.set("/end", [200, {}, "done"]);
    const client = new HttpClient(Egress.Any, { resolve: resolver({ "a.test": ["127.0.0.1"], "b.test": ["127.0.0.1"] }) });
    const secret = { authorization: "Bearer s3cr3t", cookie: "id=1", accept: "*/*" };
    expect((await client.get(`http://a.test:${String(server.port)}/here`, secret)).text()).toBe("done");
    expect(server.seen[1]?.headers["authorization"]).toBe("Bearer s3cr3t");
    await client.get(`http://a.test:${String(server.port)}/away`, secret);
    const kept = server.seen[3]?.headers;
    expect([kept?.["authorization"], kept?.["cookie"], kept?.["accept"]]).toEqual([undefined, undefined, "*/*"]);
  });

  test("a post redirected by 303 becomes a get without body", async () => {
    server.routes.set("/form", [303, { location: "/result" }, ""]);
    server.routes.set("/result", [200, {}, "ok"]);
    const response = await new HttpClient(Egress.Any).postJson(server.url("/form"), { a: 1 });
    expect(response.url).toBe(server.url("/result"));
    expect(server.seen.map(({ method, body }) => [method, body])).toEqual([["POST", '{"a":1}'], ["GET", ""]]);
  });

  test("a post sends its body", async () => {
    server.routes.set("/raw", [201, {}, ""]);
    const response = await new HttpClient(Egress.Any).post(server.url("/raw"), new TextEncoder().encode("payload"), { "x-a": "1" });
    expect([response.status, server.seen[0]?.body, server.seen[0]?.headers["x-a"]]).toEqual([201, "payload", "1"]);
  });

  test("redirects are limited", async () => {
    server.routes.set("/loop", [302, { location: "/loop" }, ""]);
    await rejects(new HttpClient(Egress.Any, { maxRedirects: 2 }).get(server.url("/loop")), /more than 2 redirects/);
    expect(server.seen.length).toBe(3);
  });

  test("a response over the limit is refused", async () => {
    server.routes.set("/big", [200, {}, "x".repeat(20)]);
    await rejects(new HttpClient(Egress.Any, { maxBody: 10 }).get(server.url("/big")), /over 10 bytes/);
    expect((await new HttpClient(Egress.Any, { maxBody: 20 }).get(server.url("/big"))).text()).toBe("x".repeat(20));
  });

  test("a response that is not JSON says so", async () => {
    server.routes.set("/text", [200, {}, "hello"]);
    const response = await new HttpClient(Egress.Any).get(server.url("/text"));
    expect(() => response.json()).toThrow(/the response is not JSON/);
  });

  test("TLS is verified against the name", async () => {
    const client = new HttpClient(Egress.Any, { resolve: resolver({ "api.test": ["127.0.0.1"] }) });
    await rejects(client.get(`https://api.test:${String(server.port)}/`), HttpError);
  });
});

describe("failures", () => {
  test.each([
    ["ftp://example.com/", /an http or https URL is expected/],
    ["https://user:pass@example.com/", /credentials in the URL/],
    ["http://example.com:99999/", /not a URL/],
  ])("%s is refused before resolving", async (url, message) => {
    const resolved: string[] = [];
    const client = new HttpClient(Egress.Any, {
      resolve: (host) => {
        resolved.push(host);
        return Promise.resolve([]);
      },
    });
    await rejects(client.get(url), message);
    expect(resolved).toEqual([]);
  });

  test("a name without address fails with its name", async () => {
    await rejects(new HttpClient(Egress.Any, { resolve: resolver({}) }).get("http://nowhere.test/"), 
      /resolves to no address/,
    );
    await rejects(new HttpClient(Egress.Any).get("http://nowhere.invalid/"), /the name does not resolve/);
  });

  test("a server closing without answer is an HTTP error", async () => {
    const tcp = createTcpServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    const address = tcp.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await rejects(new HttpClient(Egress.Any).get(`http://127.0.0.1:${String(port)}/`), /GET http:\/\/127\.0\.0\.1/);
    tcp.close();
  });

  test("a server that does not answer in time is an HTTP error", async () => {
    const tcp = createTcpServer(() => undefined);
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    const address = tcp.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await rejects(new HttpClient(Egress.Any, { timeout: 100 }).get(`http://127.0.0.1:${String(port)}/`), 
      /no answer within 100 ms/,
    );
    tcp.close();
  });

  test("a server that stops in the middle of its answer is an HTTP error", async () => {
    const tcp = createTcpServer((socket) => {
      socket.write("HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nhalf");
    });
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    const address = tcp.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await rejects(new HttpClient(Egress.Any, { timeout: 100 }).get(`http://127.0.0.1:${String(port)}/`), 
      /no answer within 100 ms/,
    );
    tcp.close();
  });
});

describe("redirects", () => {
  test("never from https to http", () => {
    const request = { method: "GET", url: "https://api.test/a", headers: {}, body: undefined };
    expect(() => followRedirect(request, "http://api.test/b", 302)).toThrow(/from https to http/);
    expect(followRedirect(request, "/b", 301).url).toBe("https://api.test/b");
  });

  test("a head redirected by 303 stays a head", () => {
    const request = { method: "HEAD", url: "http://api.test/a", headers: { "content-type": "text/plain" }, body: undefined };
    const followed = followRedirect(request, "/b", 303);
    expect([followed.method, followed.headers]).toEqual(["HEAD", {}]);
  });
});

describe("lookup", () => {
  test("gives the checked addresses in every form node:http asks for", () => {
    const answers: unknown[][] = [];
    const record = (...args: unknown[]): void => {
      answers.push(args);
    };
    const checked = [
      { address: "1.1.1.1", family: 4 as const },
      { address: "2606:4700:4700::1111", family: 6 as const },
    ];
    lookupOf("api.test", checked)("api.test", { all: true }, record);
    lookupOf("api.test", checked)("api.test", {}, record);
    lookupOf("api.test", [])("api.test", {}, record);
    expect(answers.slice(0, 2)).toEqual([[null, checked], [null, "1.1.1.1", 4]]);
    expect(answers[2]?.[0]).toEqual(new Error("api.test: no address"));
  });
});
