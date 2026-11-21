/** The SMTP client: what it sends, and what it refuses to send in clear. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";

import {
  type Address,
  AllowedHosts,
  Egress,
  EgressError,
  type Message,
  SmtpClient,
  SmtpError,
  type SmtpOptions,
} from "../src/index.ts";
import { rejects, resolver } from "./helpers.ts";

/** A message a mailbox kept. */
interface Kept {
  readonly from: string;
  readonly to: readonly string[];
  readonly raw: string;
}

function between(text: string, open: string, close: string): string {
  return text.split(open)[1]?.split(close)[0] ?? "";
}

/** The text of the part of `type` of a message the client wrote. */
function partOf(raw: string, type: string): string {
  const body = raw.split(`Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`)[1] ?? "";
  return Buffer.from((body.split("\r\n--")[0] ?? "").replaceAll("\r\n", ""), "base64").toString("utf8");
}

/** The subject of a message the client wrote, its encoded words decoded. */
function subjectOf(raw: string): string {
  const header = between(raw, "Subject: ", "\r\nDate: ");
  return header
    .split("\r\n ")
    .map((word) => (word.startsWith("=?utf-8?B?") ? Buffer.from(between(word, "=?utf-8?B?", "?="), "base64").toString("utf8") : word))
    .join("");
}

function listening(server: NetServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

/**
 * A local SMTP server: in clear on `port`, in TLS from the first byte on
 * `tlsPort`. After `STARTTLS`, the connection is piped to a TLS server that
 * goes on with the same dialogue.
 */
class Mailbox {
  /** The extensions it announces after EHLO. */
  offers: string[] = [];
  /** The answer to each of these commands, in the place of the usual one. */
  readonly answers = new Map<string, string>();
  readonly commands: string[] = [];
  readonly messages: Kept[] = [];
  port = 0;
  tlsPort = 0;
  private upgradedPort = 0;
  private readonly servers: NetServer[] = [];
  private readonly sockets = new Set<Socket>();

  static async start(key: string, cert: string): Promise<Mailbox> {
    const box = new Mailbox();
    const clear = createServer((socket) => { box.serve(socket, true); });
    const tls = createTlsServer({ key, cert }, (socket) => { box.serve(socket, true); });
    const upgraded = createTlsServer({ key, cert }, (socket) => { box.serve(socket, false); });
    box.servers.push(clear, tls, upgraded);
    [box.port, box.tlsPort, box.upgradedPort] = await Promise.all([listening(clear), listening(tls), listening(upgraded)]);
    return box;
  }

  url(host = "127.0.0.1", credentials = ""): string {
    return `smtp://${credentials}${host}:${String(this.port)}`;
  }

  private serve(socket: Socket, greets: boolean): void {
    this.sockets.add(socket);
    socket.on("error", () => undefined);
    const say = (line: string): void => { socket.write(`${line}\r\n`); };
    let pending = "";
    let from = "";
    let to: string[] = [];
    let data: string[] | undefined;
    let login: string[] | undefined;
    const take = (line: string): void => {
      if (data !== undefined) {
        if (line === ".") {
          this.messages.push({ from, to, raw: data.join("\r\n") });
          data = undefined;
          say("250 kept");
        } else {
          data.push(line);
        }
        return;
      }
      if (login !== undefined) {
        login.push(Buffer.from(line, "base64").toString("utf8"));
        if (login.length === 2) {
          this.commands.push(`LOGIN ${login.join(" ")}`);
          login = undefined;
          say("235 ok");
        } else {
          say("334 UGFzc3dvcmQ6");
        }
        return;
      }
      const verb = (line.split(" ")[0] ?? "").toUpperCase();
      this.commands.push(verb);
      const forced = this.answers.get(verb);
      if (forced !== undefined) {
        if (forced === "close") {
          socket.destroy();
        } else if (forced !== "silence") {
          say(forced);
        }
      } else if (verb === "EHLO") {
        say(["250-local", ...this.offers.map((extension) => `250-${extension}`), "250 HELP"].join("\r\n"));
      } else if (verb === "STARTTLS") {
        say("220 go ahead");
        socket.removeAllListeners("data");
        const secure = connect(this.upgradedPort, "127.0.0.1");
        this.sockets.add(secure);
        secure.on("error", () => undefined);
        socket.pipe(secure).pipe(socket);
      } else if (verb === "AUTH" && line.split(" ")[1] === "PLAIN") {
        this.commands.push(`PLAIN ${Buffer.from(line.split(" ")[2] ?? "", "base64").toString("utf8").replaceAll("\0", " ").trim()}`);
        say("235 ok");
      } else if (verb === "AUTH") {
        login = [];
        say("334 VXNlcm5hbWU6");
      } else if (verb === "MAIL") {
        from = between(line, "<", ">");
        to = [];
        say("250 ok");
      } else if (verb === "RCPT") {
        to.push(between(line, "<", ">"));
        say("250 ok");
      } else if (verb === "DATA") {
        data = [];
        say("354 go");
      } else {
        say(verb === "QUIT" ? "221 bye" : "502 not implemented");
      }
    };
    socket.on("data", (chunk: Uint8Array) => {
      const lines = (pending + Buffer.from(chunk).toString("utf8")).split("\r\n");
      pending = lines.pop() ?? "";
      lines.forEach(take);
    });
    if (greets) {
      say(this.answers.get("GREETING") ?? "220 local");
    }
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await Promise.all(this.servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

const MESSAGE: Message = {
  sender: "flows@example.com",
  to: ["ops@example.com", "dev@example.com"],
  subject: "Taux mis à jour : les valeurs de l'été sont arrivées, à vérifier avant ce soir",
  text: "Le taux a changé.",
};

describe("the SMTP client", () => {
  let folder: string;
  let key: string;
  let cert: string;
  let box: Mailbox;

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), "smtp-"));
    const made = Bun.spawnSync([
      "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=relay.test",
      "-addext", "subjectAltName=DNS:relay.test", "-keyout", join(folder, "key.pem"), "-out", join(folder, "cert.pem"),
    ]);
    expect(made.exitCode).toBe(0);
    key = readFileSync(join(folder, "key.pem"), "utf8");
    cert = readFileSync(join(folder, "cert.pem"), "utf8");
  });
  afterAll(() => {
    rmSync(folder, { recursive: true });
  });
  beforeEach(async () => {
    box = await Mailbox.start(key, cert);
  });
  afterEach(() => box.stop());

  /** A client for which `relay.test` is another machine, connected to the mailbox. */
  const far = (options: SmtpOptions = {}, egress: Egress = Egress.Any): SmtpClient =>
    new SmtpClient(egress, {
      timeout: 2000,
      resolve: resolver({ "relay.test": ["203.0.113.5"], "inside.test": ["10.0.0.5"], "void.test": [] }),
      dial: (): Address => ({ address: "127.0.0.1", family: 4 }),
      ...options,
    });
  const near = (): SmtpClient => new SmtpClient(Egress.Any, { timeout: 2000 });

  test("a message goes to this machine in clear", async () => {
    await near().send(box.url(), { ...MESSAGE, html: "<p>Le taux a <b>changé</b>.</p>" });
    expect(box.commands).toEqual(["EHLO", "MAIL", "RCPT", "RCPT", "DATA", "QUIT"]);
    const [kept] = box.messages;
    expect([kept?.from, kept?.to]).toEqual(["flows@example.com", ["ops@example.com", "dev@example.com"]]);
    const raw = kept?.raw ?? "";
    expect(subjectOf(raw)).toBe(MESSAGE.subject);
    expect(raw).toContain("To: ops@example.com,\r\n dev@example.com\r\n");
    expect(raw).toMatch(/\r\nDate: \w{3}, \d{2} \w{3} \d{4} [\d:]{8} \+0000\r\nMessage-ID: <[0-9a-f-]{36}@example\.com>\r\n/);
    expect(raw).toContain("Content-Type: multipart/alternative;\r\n boundary=");
    expect([partOf(raw, "text/plain"), partOf(raw, "text/html")]).toEqual(["Le taux a changé.", "<p>Le taux a <b>changé</b>.</p>"]);
    expect(raw.split("\r\n").every((line) => line.length <= 78 && !line.startsWith("."))).toBe(true);
  });

  test("a message of text alone has one part and a subject as written", async () => {
    await near().send(box.url(), { ...MESSAGE, subject: "Rates", text: "x".repeat(200) });
    const raw = box.messages[0]?.raw ?? "";
    expect(raw).toContain("Subject: Rates\r\n");
    expect(raw).not.toContain("multipart");
    expect(partOf(raw, "text/plain")).toBe("x".repeat(200));
  });

  test("a message never leaves this machine in clear", async () => {
    await rejects(far().send(box.url("relay.test"), MESSAGE), new SmtpError(
      `relay.test:${String(box.port)} does not offer STARTTLS: what leaves this machine is encrypted, unless the step names the host in network.plain`,
    ));
    expect(box.commands).toEqual(["EHLO"]);
  });

  test("a server that offers STARTTLS gets the message and the password encrypted", async () => {
    box.offers = ["STARTTLS", "AUTH PLAIN LOGIN"];
    const client = far({ caFile: join(folder, "cert.pem") });
    await client.send(box.url("relay.test", "bot%40example.com:p%3Ass@"), MESSAGE);
    expect(box.commands).toEqual(["EHLO", "STARTTLS", "EHLO", "AUTH", "PLAIN bot@example.com p:ss", "MAIL", "RCPT", "RCPT", "DATA", "QUIT"]);
    expect(partOf(box.messages[0]?.raw ?? "", "text/plain")).toBe("Le taux a changé.");
  });

  test("the certificate of the server is verified", async () => {
    box.offers = ["STARTTLS"];
    await rejects(far().send(box.url("relay.test"), MESSAGE), /^relay\.test:\d+: Error: TLS: /);
    const other = far({ caFile: join(folder, "cert.pem"), resolve: resolver({ "other.test": ["203.0.113.6"] }) });
    await rejects(other.send(box.url("other.test"), MESSAGE), /^other\.test:\d+: Error: TLS: /);
    expect(box.commands).toEqual(["EHLO", "STARTTLS", "EHLO", "STARTTLS"]);
    expect(box.messages).toEqual([]);
  });

  test("a step names the server it reaches in clear", async () => {
    const plain = AllowedHosts.parse(`relay.test:${String(box.port)}`);
    await far({ plain }).send(box.url("relay.test"), MESSAGE);
    expect(box.messages.length).toBe(1);
    await rejects(far({ plain }).send(box.url("inside.test"), MESSAGE), /does not offer STARTTLS/);
  });

  test("smtps is TLS from the first byte", async () => {
    const url = `smtps://relay.test:${String(box.tlsPort)}`;
    await far({ caFile: join(folder, "cert.pem") }).send(url, MESSAGE);
    expect(box.commands).toEqual(["EHLO", "MAIL", "RCPT", "RCPT", "DATA", "QUIT"]);
    await rejects(far().send(url, MESSAGE), /^relay\.test:\d+: no connection \(203\.0\.113\.5: Error: TLS: /);
    await rejects(near().send(`smtps://127.0.0.1:${String(box.port)}`, MESSAGE), /no connection \(127\.0\.0\.1: Error: TLS: /);
    expect(box.messages.length).toBe(1);
  });

  test("the user of the URL logs in by LOGIN when the server offers it alone", async () => {
    box.offers = ["AUTH LOGIN"];
    await near().send(box.url("127.0.0.1", "bot:secret@"), MESSAGE);
    expect(box.commands.slice(0, 3)).toEqual(["EHLO", "AUTH", "LOGIN bot secret"]);
    expect(box.messages.length).toBe(1);
  });

  test("a login the server refuses or does not offer is an error that shows no password", async () => {
    await rejects(near().send(box.url("127.0.0.1", "bot:secret@"), MESSAGE), /^127\.0\.0\.1: the server offers no way to log in/);
    box.offers = ["AUTH PLAIN"];
    box.answers.set("AUTH", "535 bad credentials");
    await rejects(near().send(box.url("127.0.0.1", "bot:secret@"), MESSAGE), new SmtpError("AUTH PLAIN: the server answered 535 bad credentials"));
    expect(box.messages).toEqual([]);
  });

  test("the rules of the step and of the worker apply before any connection", async () => {
    const allowed = AllowedHosts.parse("smtp.example.com:587");
    await rejects(far({ allowed }).send(box.url("relay.test"), MESSAGE), /^relay\.test:\d+ is not one of the hosts/);
    await rejects(far({}, Egress.Public).send(box.url("inside.test"), MESSAGE), EgressError);
    await rejects(far().send(box.url("void.test"), MESSAGE), new SmtpError("void.test: the name resolves to no address"));
    expect(box.commands).toEqual([]);
  });

  test("a server that does not answer as expected is an error", async () => {
    const closed = createServer();
    const port = await listening(closed);
    await new Promise((resolve) => closed.close(resolve));
    await rejects(near().send(`smtp://127.0.0.1:${String(port)}`, MESSAGE), /^127\.0\.0\.1:\d+: no connection \(127\.0\.0\.1: /);

    box.answers.set("RCPT", "550 no such user");
    await rejects(near().send(box.url(), MESSAGE), new SmtpError("RCPT TO:<ops@example.com>: the server answered 550 no such user"));
    box.answers.set("RCPT", "hello there");
    await rejects(near().send(box.url(), MESSAGE), /^127\.0\.0\.1:\d+: Error: not an SMTP answer: "hello there"/);
    box.answers.set("RCPT", "close");
    await rejects(near().send(box.url(), MESSAGE), /^127\.0\.0\.1:\d+: Error: the server closed the connection/);
    box.answers.set("RCPT", "silence");
    const hasty = new SmtpClient(Egress.Any, { timeout: 100 });
    await rejects(hasty.send(box.url(), MESSAGE), /^127\.0\.0\.1:\d+: Error: no answer within 100 ms/);
    expect(box.messages).toEqual([]);
  });

  test.each([
    ["http://127.0.0.1", /starts with smtp:\/\/ or smtps:\/\//],
    ["not a url", /starts with smtp:\/\/ or smtps:\/\//],
    ["smtp://", /starts with smtp:\/\/ or smtps:\/\/|has no host/],
    ["smtp://bot:%zz@127.0.0.1", /is not percent-encoded/],
  ])("the URL %s is refused", async (url, why) => {
    await rejects(near().send(url, MESSAGE), why);
  });

  test("a message has a recipient, addresses and a subject of one line", async () => {
    await rejects(near().send(box.url(), { ...MESSAGE, to: [] }), /one recipient at least/);
    await rejects(near().send(box.url(), { ...MESSAGE, to: ["ops@example.com>\r\nRCPT TO:<all@example.com"] }), /is not an address/);
    await rejects(near().send(box.url(), { ...MESSAGE, sender: "flows" }), /"flows" is not an address/);
    await rejects(near().send(box.url(), { ...MESSAGE, subject: "Rates\r\nBcc: all@example.com" }), /not one line: its subject/);
    expect(box.commands).toEqual([]);
  });

  test("the default ports are those of submission", async () => {
    await rejects(near().send("smtp://127.0.0.1", MESSAGE), /^127\.0\.0\.1:587: /);
    await rejects(near().send("smtps://127.0.0.1", MESSAGE), /^127\.0\.0\.1:465: /);
  });
});
