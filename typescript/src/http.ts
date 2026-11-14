/**
 * An HTTP client for actions, on Bun's `node:http` and `node:https` only.
 *
 * It refuses a host out of those the step may reach
 * (`CRONPLANE_NETWORK_ALLOW`) before it resolves its name.
 *
 * On a worker that runs the steps of several customers
 * (`CRONPLANE_EGRESS=public`), it refuses every address that is not public
 * before it connects: the name is resolved once, every address it resolves
 * to is checked, and the connection goes to an address checked (the
 * request's `lookup` gives it), so a second resolution cannot change it
 * (DNS rebinding). Each redirect is checked the same way. TLS is verified
 * against the name of the URL.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";

import { isPublic } from "./address.ts";
import { ActionError, EgressError, HttpError } from "./errors.ts";
import { type JsonValue, parse } from "./json.ts";
import type { AllowedHosts } from "./network.ts";

/** The addresses the worker lets its steps reach. */
export const Egress = { Any: "any", Public: "public" } as const;
export type Egress = (typeof Egress)[keyof typeof Egress];

/** `CRONPLANE_EGRESS`: unset is any; an unknown value is an error, never any. */
export function parseEgress(value: string | undefined): Egress {
  if (value === undefined) {
    return Egress.Any;
  }
  const found = Object.values(Egress).find((egress) => egress === value);
  if (found === undefined) {
    const known = Object.values(Egress).join(", ");
    throw new ActionError(`CRONPLANE_EGRESS=${JSON.stringify(value)}: one of ${known}, or unset`);
  }
  return found;
}

/** An address and its family, as `node:dns` gives them. */
export interface Address {
  readonly address: string;
  readonly family: 4 | 6;
}

/** The addresses of a host name. */
export type Resolve = (host: string) => Promise<readonly Address[]>;

export async function systemResolve(host: string): Promise<readonly Address[]> {
  try {
    const found = await dnsLookup(host, { all: true, order: "verbatim" });
    return found.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
  } catch (e) {
    throw new HttpError(`${host}: the name does not resolve: ${String(e)}`, { cause: e });
  }
}

/** `EgressError` when an address of `host` is not public. */
export function checkPublic(host: string, addresses: readonly Address[]): void {
  const refused = addresses.find(({ address }) => !isPublic(address));
  if (refused !== undefined) {
    throw new EgressError(
      `${host} resolves to ${refused.address}, not a public address: this worker lets its steps reach public addresses only`,
    );
  }
}

/** A response, read whole. */
export class Response {
  constructor(
    readonly status: number,
    /** Names in lower case; a repeated header holds its values joined by ", ". */
    readonly headers: ReadonlyMap<string, string>,
    readonly body: Uint8Array,
    /** The URL that answered, after redirects. */
    readonly url: string,
  ) {}

  /** The body as UTF-8 text; a byte that is not UTF-8 reads as U+FFFD. */
  text(): string {
    return new TextDecoder().decode(this.body);
  }

  json(): JsonValue {
    try {
      return parse(this.text());
    } catch (e) {
      throw new HttpError(`${this.url}: the response is not JSON: ${String(e)}`, { cause: e });
    }
  }
}

export interface HttpOptions {
  /** The only hosts the step reaches; undefined: any host. */
  readonly allowed?: AllowedHosts | undefined;
  /** Per connection and read, in milliseconds. */
  readonly timeout?: number;
  readonly maxBody?: number;
  readonly maxRedirects?: number;
  /** A file of CA certificates to trust instead of the system's. */
  readonly caFile?: string;
  readonly resolve?: Resolve;
  /** Where a connection to a checked address goes (tests only). */
  readonly dial?: (address: Address) => Address;
}

export interface Request {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | undefined;
}

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
// A GET after them: 303 always, 301 and 302 after a POST (as browsers do).
const SEE_OTHER = 303;
const MOVED: ReadonlySet<number> = new Set([301, 302]);
// Sent again to the same origin only.
const CREDENTIALS: ReadonlySet<string> = new Set(["authorization", "proxy-authorization", "cookie"]);

/**
 * HTTP/1.1 requests within the worker's egress rule and the hosts the step
 * may reach, redirects included. Each request has a timeout, a response size
 * limit and a limit of redirects; no proxy is used.
 */
export class HttpClient {
  /** The only hosts the step reaches; undefined: any host. */
  readonly allowed: AllowedHosts | undefined;
  readonly timeout: number;
  readonly maxBody: number;
  readonly maxRedirects: number;
  private readonly ca: string | undefined;
  private readonly resolve: Resolve;
  private readonly dial: (address: Address) => Address;

  constructor(
    readonly egress: Egress,
    options: HttpOptions = {},
  ) {
    this.allowed = options.allowed;
    this.timeout = options.timeout ?? 30_000;
    this.maxBody = options.maxBody ?? 10 << 20;
    this.maxRedirects = options.maxRedirects ?? 5;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file the action's code names
    this.ca = options.caFile === undefined ? undefined : readFileSync(options.caFile, "utf8");
    this.resolve = options.resolve ?? systemResolve;
    this.dial = options.dial ?? ((address) => address);
  }

  get(url: string, headers: Readonly<Record<string, string>> = {}): Promise<Response> {
    return this.request("GET", url, { headers });
  }

  post(url: string, body: Uint8Array, headers: Readonly<Record<string, string>> = {}): Promise<Response> {
    return this.request("POST", url, { headers, body });
  }

  postJson(url: string, value: JsonValue, headers: Readonly<Record<string, string>> = {}): Promise<Response> {
    const body = new TextEncoder().encode(JSON.stringify(value));
    return this.request("POST", url, { headers: { "content-type": "application/json", ...headers }, body });
  }

  async request(
    method: string,
    url: string,
    options: { readonly headers?: Readonly<Record<string, string>>; readonly body?: Uint8Array } = {},
  ): Promise<Response> {
    let current: Request = { method: method.toUpperCase(), url, headers: { ...options.headers }, body: options.body };
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      const response = await this.send(current);
      const location = response.headers.get("location");
      if (!REDIRECTS.has(response.status) || location === undefined) {
        return response;
      }
      current = followRedirect(current, location, response.status);
    }
    throw new HttpError(`${url}: more than ${String(this.maxRedirects)} redirects`);
  }

  private async send(request: Request): Promise<Response> {
    const target = parseTarget(request.url);
    const host = target.hostname.replace(/^\[(.*)\]$/, "$1");
    this.allowed?.check(host, target.port === "" ? defaultPort(target) : Number(target.port));
    const addresses = await this.resolve(host);
    if (addresses.length === 0) {
      throw new HttpError(`${host}: the name resolves to no address`);
    }
    if (this.egress === Egress.Public) {
      checkPublic(host, addresses);
    }
    // The connection goes to the addresses checked: no second resolution.
    const lookup = lookupOf(host, addresses.map((address) => this.dial(address)));
    return new Promise<Response>((resolve, reject) => {
      // A timer of this client: not every Bun version gives the `timeout` of node:http.
      let silence: ReturnType<typeof setTimeout> | undefined;
      const fail = (e: unknown): void => {
        clearTimeout(silence);
        reject(e instanceof HttpError ? e : new HttpError(`${request.method} ${request.url}: ${String(e)}`, { cause: e }));
      };
      const heard = (): void => {
        clearTimeout(silence);
        silence = setTimeout(() => {
          fail(new HttpError(`${request.method} ${request.url}: no answer within ${String(this.timeout)} ms`));
          sent.destroy();
        }, this.timeout);
      };
      const sent = (target.protocol === "https:" ? https : http).request(
        {
          method: request.method,
          host,
          port: target.port === "" ? undefined : Number(target.port),
          path: `${target.pathname}${target.search}`,
          headers: request.headers,
          lookup,
          servername: host,
          ...(this.ca === undefined ? {} : { ca: this.ca }),
          agent: false,
        },
        (answer) => {
          const chunks: Uint8Array[] = [];
          let size = 0;
          heard();
          answer.on("data", (chunk: Uint8Array) => {
            heard();
            size += chunk.length;
            if (size > this.maxBody) {
              answer.destroy(new HttpError(`${request.url}: the response is over ${String(this.maxBody)} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          answer.on("error", fail);
          answer.on("end", () => {
            clearTimeout(silence);
            resolve(new Response(answer.statusCode ?? 0, headersOf(answer.headers), Buffer.concat(chunks), request.url));
          });
        },
      );
      sent.on("error", fail);
      sent.end(request.body);
      heard();
    });
  }
}

/** A `lookup` for `node:http` that gives `addresses` and never resolves `host` again. */
export function lookupOf(host: string, addresses: readonly Address[]): LookupFunction {
  return (_hostname, options, callback) => {
    const first = addresses[0];
    if (options.all === true) {
      callback(null, addresses.map(({ address, family }) => ({ address, family })));
    } else if (first !== undefined) {
      callback(null, first.address, first.family);
    } else {
      callback(new Error(`${host}: no address`), "", 4);
    }
  };
}

function headersOf(received: http.IncomingHttpHeaders): ReadonlyMap<string, string> {
  // Node gives the names in lower case and joins repeated values, but for set-cookie.
  return new Map(
    Object.entries(received).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value] as const],
    ),
  );
}

/**
 * `url` parsed, when it is an absolute http(s) URL without credentials. The
 * URL parser refuses an http(s) URL without a host.
 */
function parseTarget(url: string): URL {
  let target: URL;
  try {
    target = new URL(url);
  } catch (e) {
    throw new HttpError(`${url}: not a URL`, { cause: e });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new HttpError(`${url}: an http or https URL is expected`);
  }
  if (target.username !== "" || target.password !== "") {
    throw new HttpError(`${target.hostname}: credentials in the URL: pass them in a header`);
  }
  return target;
}

/** The port of an http(s) URL that names none. */
function defaultPort(target: URL): number {
  return target.protocol === "https:" ? 443 : 80;
}

/**
 * The request a redirect asks for. It never goes from https to http;
 * credentials go to the same origin only; 303, and 301 or 302 after a POST,
 * become a GET without a body.
 */
export function followRedirect(current: Request, location: string, status: number): Request {
  const before = parseTarget(current.url);
  const target = parseTarget(new URL(location, current.url).href);
  if (before.protocol === "https:" && target.protocol !== "https:") {
    throw new HttpError(`${current.url}: redirected to ${target.href}, from https to http`);
  }
  let { method, body } = current;
  let headers = Object.entries(current.headers);
  if (status === SEE_OTHER || (MOVED.has(status) && method === "POST")) {
    method = method === "HEAD" ? "HEAD" : "GET";
    body = undefined;
    headers = headers.filter(([name]) => !["content-type", "content-length"].includes(name.toLowerCase()));
  }
  if (before.origin !== target.origin) {
    headers = headers.filter(([name]) => !CREDENTIALS.has(name.toLowerCase()));
  }
  return { method, url: target.href, headers: Object.fromEntries(headers), body };
}
