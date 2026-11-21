/**
 * An SMTP client for actions, on Bun's `node:net` and `node:tls` only.
 *
 * It follows the same rules as the HTTP client: the hosts the step may
 * reach, public addresses only on a shared worker, and a connection to an
 * address checked. A message leaves this machine encrypted: `smtps://` (TLS
 * from the first byte) or `smtp://` with STARTTLS, which the server must
 * offer. In clear, it goes to this machine only, or to a host the step names
 * in `network.plain`.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";

import { ActionError, SmtpError } from "./errors.ts";
import { type Address, checkPublic, Egress, type Resolve, systemResolve } from "./http.ts";
import { type AllowedHosts, clearAllowed } from "./network.ts";

export interface SmtpOptions {
  /** The only hosts the step reaches; undefined: any host. */
  readonly allowed?: AllowedHosts | undefined;
  /** The hosts the step reaches in clear, beside this machine. */
  readonly plain?: AllowedHosts | undefined;
  /** Per connection and answer of the server, in milliseconds. */
  readonly timeout?: number;
  /** A file of CA certificates to trust instead of the system's. */
  readonly caFile?: string;
  readonly resolve?: Resolve;
  /** Where a connection to a checked address goes (tests only). */
  readonly dial?: (address: Address) => Address;
}

/** One message: its text, and an HTML alternative to it. */
export interface Message {
  readonly sender: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

interface Server {
  /** `smtps://`: TLS from the first byte. */
  readonly tls: boolean;
  readonly host: string;
  readonly port: number;
  readonly user: string | undefined;
  readonly password: string;
}

const PORTS: ReadonlyMap<string, number> = new Map([
  ["smtp:", 587],
  ["smtps:", 465],
]);
const ADDRESS = /^[^\s<>@]+@[^\s<>@]+$/;
const ASCII = /^[\x20-\x7e]*$/;
/** The bytes of UTF-8 one encoded word of a header carries: its line stays under 78 characters. */
const WORD_BYTES = 39;

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new SmtpError("the user or the password of the URL of the server is not percent-encoded");
  }
}

/** `url` split, when it is `smtp://` or `smtps://` with a host. The URL holds a password: no error shows it. */
function serverOf(url: string): Server {
  const parts = URL.parse(url);
  const port = parts === null ? undefined : PORTS.get(parts.protocol);
  if (parts === null || port === undefined) {
    throw new SmtpError("the URL of the server starts with smtp:// or smtps://");
  }
  if (parts.hostname === "") {
    throw new SmtpError("the URL of the server has no host");
  }
  return {
    tls: parts.protocol === "smtps:",
    host: parts.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: parts.port === "" ? port : Number(parts.port),
    user: parts.username === "" ? undefined : decoded(parts.username),
    password: decoded(parts.password),
  };
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** A header value: as it is when printable ASCII, else in encoded words of UTF-8. */
function headerValue(value: string): string {
  if (ASCII.test(value)) {
    return value;
  }
  const words: string[] = [];
  let word = "";
  for (const character of value) {
    if (Buffer.byteLength(word + character, "utf8") > WORD_BYTES) {
      words.push(word);
      word = "";
    }
    word += character;
  }
  words.push(word);
  return words.map((part) => `=?utf-8?B?${base64(part)}?=`).join("\r\n ");
}

function part(type: string, text: string): string {
  const lines = base64(text).match(/.{1,76}/g) ?? [];
  return `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${lines.join("\r\n")}\r\n`;
}

/** The message as sent after `DATA`, checked: no line of it starts with a dot. */
function encoded(message: Message): string {
  if (message.to.length === 0) {
    throw new SmtpError("a message has one recipient at least");
  }
  const wrong = [message.sender, ...message.to].find((address) => !ADDRESS.test(address));
  if (wrong !== undefined) {
    throw new SmtpError(`${JSON.stringify(wrong)} is not an address (name@domain)`);
  }
  if (/[\r\n]/.test(message.subject)) {
    throw new SmtpError("the message has a header that is not one line: its subject");
  }
  const domain = message.sender.slice(message.sender.indexOf("@") + 1);
  const headers = [
    `From: ${message.sender}`,
    `To: ${message.to.join(",\r\n ")}`,
    `Subject: ${headerValue(message.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
  ].join("\r\n");
  if (message.html === undefined) {
    return `${headers}\r\n${part("text/plain", message.text)}`;
  }
  const boundary = `=_${randomUUID()}`;
  return [
    `${headers}\r\nContent-Type: multipart/alternative;\r\n boundary="${boundary}"\r\n`,
    `--${boundary}\r\n${part("text/plain", message.text)}`,
    `--${boundary}\r\n${part("text/html", message.html)}`,
    `--${boundary}--\r\n`,
  ].join("\r\n");
}

/** `work`, or an error when it is not done after `ms` milliseconds: `what`, then the time. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let silence: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    silence = setTimeout(() => {
      reject(new Error(`${what} within ${String(ms)} ms`));
    }, ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(silence);
  }
}

/** An answer of the server: its code and its lines, without the code. */
interface Reply {
  readonly code: number;
  readonly lines: readonly string[];
}

/** The dialogue with a server over one socket: a command, then its answer, each within the timeout. */
class Session {
  private pending = "";
  private readonly lines: string[] = [];
  private ended: Error | undefined;
  private wake: (() => void) | undefined;

  constructor(
    readonly socket: Socket,
    private readonly timeout: number,
  ) {
    socket.on("data", this.onData);
    socket.on("error", this.onEnd);
    socket.on("close", this.onClose);
  }

  private readonly onData = (chunk: Uint8Array): void => {
    const parts = (this.pending + Buffer.from(chunk).toString("utf8")).split("\r\n");
    this.pending = parts.pop() ?? "";
    this.lines.push(...parts);
    this.wake?.();
  };

  private readonly onEnd = (e: Error): void => {
    this.ended = e;
    this.wake?.();
  };

  private readonly onClose = (): void => {
    this.onEnd(new Error("the server closed the connection"));
  };

  /** Stops reading the socket: what comes next is for the TLS session over it. */
  release(): Socket {
    this.socket.off("data", this.onData).off("error", this.onEnd).off("close", this.onClose);
    return this.socket;
  }

  private async line(): Promise<string> {
    for (;;) {
      const line = this.lines.shift();
      if (line !== undefined) {
        return line;
      }
      if (this.ended !== undefined) {
        throw this.ended;
      }
      await within(
        new Promise<void>((resolve) => {
          this.wake = resolve;
        }),
        this.timeout,
        "no answer",
      );
    }
  }

  async reply(): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.line();
      const code = Number(line.slice(0, 3));
      if (!/^[0-9]{3}[ -]/.test(`${line} `)) {
        throw new Error(`not an SMTP answer: ${JSON.stringify(line.slice(0, 80))}`);
      }
      lines.push(line.slice(4));
      if (line.charAt(3) !== "-") {
        return { code, lines };
      }
    }
  }

  /** Sends `command` and gives its answer when its code is one of `expected`; `said` names it in an error. */
  async command(command: string, expected: readonly number[], said: string = command): Promise<Reply> {
    this.socket.write(`${command}\r\n`);
    const reply = await this.reply();
    if (!expected.includes(reply.code)) {
      throw new SmtpError(`${said}: the server answered ${String(reply.code)} ${reply.lines.at(-1) ?? ""}`);
    }
    return reply;
  }

  /** `EHLO`, and the extensions the server offers, in upper case. */
  async hello(): Promise<readonly string[]> {
    const reply = await this.command("EHLO localhost", [250]);
    return reply.lines.slice(1).map((line) => line.toUpperCase());
  }
}

/**
 * Sends messages within the worker's egress rule and the hosts the step may
 * reach. Each exchange with the server has a timeout.
 */
export class SmtpClient {
  /** The only hosts the step reaches; undefined: any host. */
  readonly allowed: AllowedHosts | undefined;
  /** The hosts the step reaches in clear, beside this machine. */
  readonly plain: AllowedHosts | undefined;
  readonly timeout: number;
  private readonly ca: string | undefined;
  private readonly resolve: Resolve;
  private readonly dial: (address: Address) => Address;

  constructor(
    readonly egress: Egress,
    options: SmtpOptions = {},
  ) {
    this.allowed = options.allowed;
    this.plain = options.plain;
    this.timeout = options.timeout ?? 30_000;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file the action's code names
    this.ca = options.caFile === undefined ? undefined : readFileSync(options.caFile, "utf8");
    this.resolve = options.resolve ?? systemResolve;
    this.dial = options.dial ?? ((address) => address);
  }

  /**
   * Sends one message through the server at `url`
   * (`smtp://user:password@host:587`, `smtps://…:465`; a secret of the step).
   */
  async send(url: string, message: Message): Promise<void> {
    const server = serverOf(url);
    const data = encoded(message);
    this.allowed?.check(server.host, server.port);
    const addresses = await this.resolve(server.host);
    if (addresses.length === 0) {
      throw new SmtpError(`${server.host}: the name resolves to no address`);
    }
    if (this.egress === Egress.Public) {
      checkPublic(server.host, addresses);
    }
    const clear = clearAllowed(server.host, server.port, addresses.map(({ address }) => address), this.plain);
    const opened: Socket[] = [];
    try {
      const socket = await this.open(server, addresses);
      opened.push(socket);
      let session = new Session(socket, this.timeout);
      await session.reply();
      let offered = await session.hello();
      if (!server.tls && !clear) {
        if (!offered.includes("STARTTLS")) {
          throw new SmtpError(
            `${server.host}:${String(server.port)} does not offer STARTTLS: what leaves this machine is encrypted, unless the step names the host in network.plain`,
          );
        }
        await session.command("STARTTLS", [220]);
        const secure = await this.secured({ socket: session.release() }, server.host);
        opened.push(secure);
        session = new Session(secure, this.timeout);
        offered = await session.hello();
      }
      await login(session, server, offered);
      await session.command(`MAIL FROM:<${message.sender}>`, [250]);
      for (const recipient of message.to) {
        await session.command(`RCPT TO:<${recipient}>`, [250, 251]);
      }
      await session.command("DATA", [354]);
      await session.command(`${data}\r\n.`, [250], "the message");
      await session.command("QUIT", [221]);
    } catch (e) {
      if (e instanceof ActionError) {
        throw e;
      }
      throw new SmtpError(`${server.host}:${String(server.port)}: ${String(e)}`, { cause: e });
    } finally {
      for (const socket of opened) {
        socket.destroy();
      }
    }
  }

  /** A TLS session, verified against `host` (the host of the URL), within the timeout. */
  private async secured(to: { socket: Socket } | { host: string; port: number }, host: string): Promise<Socket> {
    const secure = tlsConnect({
      ...to,
      // An address is not a server name: the certificate is still compared with it.
      ...(isIP(host) === 0 ? { servername: host } : {}),
      checkServerIdentity: (_name, certificate) => checkServerIdentity(host, certificate),
      ...(this.ca === undefined ? {} : { ca: this.ca }),
    });
    try {
      await within(
        new Promise<void>((resolve, reject) => {
          secure.once("secureConnect", resolve);
          secure.once("error", reject);
        }),
        this.timeout,
        "no TLS session",
      );
      // Bun 1.2 says "connected" to a server that does not speak TLS: a session has a certificate.
      if (Object.keys(secure.getPeerCertificate()).length === 0) {
        throw new Error("the server showed no certificate");
      }
      return secure;
    } catch (e) {
      secure.destroy();
      throw new Error(`TLS: ${String(e)}`, { cause: e });
    }
  }

  private async connected(address: Address, port: number): Promise<Socket> {
    const socket = netConnect({ host: address.address, port, family: address.family });
    try {
      await within(
        new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("error", reject);
        }),
        this.timeout,
        "no connection",
      );
      return socket;
    } catch (e) {
      socket.destroy();
      throw e;
    }
  }

  /** A connection to the first address that answers, each one checked. */
  private async open(server: Server, addresses: readonly Address[]): Promise<Socket> {
    const failures: string[] = [];
    for (const checked of addresses) {
      const address = this.dial(checked);
      try {
        if (server.tls) {
          return await this.secured({ host: address.address, port: server.port }, server.host);
        }
        return await this.connected(address, server.port);
      } catch (e) {
        failures.push(`${checked.address}: ${String(e)}`);
      }
    }
    throw new SmtpError(`${server.host}:${String(server.port)}: no connection (${failures.join("; ")})`);
  }
}

/** Logs in with the user of the URL, by `PLAIN` or `LOGIN`; an error never shows what was sent. */
async function login(session: Session, server: Server, offered: readonly string[]): Promise<void> {
  if (server.user === undefined) {
    return;
  }
  const mechanisms = offered.find((line) => line.startsWith("AUTH "))?.split(" ") ?? [];
  if (mechanisms.includes("PLAIN")) {
    await session.command(`AUTH PLAIN ${base64(`\0${server.user}\0${server.password}`)}`, [235], "AUTH PLAIN");
  } else if (mechanisms.includes("LOGIN")) {
    await session.command("AUTH LOGIN", [334]);
    await session.command(base64(server.user), [334], "AUTH LOGIN (user)");
    await session.command(base64(server.password), [235], "AUTH LOGIN (password)");
  } else {
    throw new SmtpError(`${server.host}: the server offers no way to log in that this client knows (PLAIN, LOGIN)`);
  }
}
