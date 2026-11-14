/**
 * The hosts a step may reach (`CRONPLANE_NETWORK_ALLOW`, one per line): the
 * only ones the action's `network: {allow: [...]}` names. The library refuses
 * any other before it connects. Code that opens its own connections is not
 * limited: a defence for honest code, not a confinement.
 */

import { canonical, type Canonical } from "./address.ts";
import { ActionError, EgressError } from "./errors.ts";

// eslint-disable-next-line security/detect-unsafe-regex -- the repetition is bounded (61): the time is linear in the label
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_NAME = 253;
const MAX_PORT = 65535;
const DIGITS = /^[0-9]+$/;

/** What a line of the list names. */
type Target =
  /** `api.hubapi.com`. */
  | { readonly kind: "name"; readonly name: string }
  /** `.my.salesforce.com`, from `*.my.salesforce.com`. */
  | { readonly kind: "under"; readonly suffix: string }
  | { readonly kind: "address"; readonly address: string };

/** A line of the list. */
interface Host {
  readonly target: Target;
  /** Undefined: any port. */
  readonly port: number | undefined;
}

function isName(name: string): boolean {
  return name.length <= MAX_NAME && name.split(".").every((label) => LABEL.test(label));
}

function allows(entry: Host, host: string, address: Canonical | undefined, port: number): boolean {
  if (entry.port !== undefined && entry.port !== port) {
    return false;
  }
  if (entry.target.kind === "address") {
    return address?.text === entry.target.address;
  }
  if (address !== undefined) {
    return false;
  }
  return entry.target.kind === "name" ? host === entry.target.name : host.endsWith(entry.target.suffix);
}

function portOf(text: string, line: string): number {
  const port = DIGITS.test(text) ? Number(text) : 0;
  if (port < 1 || port > MAX_PORT) {
    throw new ActionError(`host ${JSON.stringify(line)}: a port is a number from 1 to ${String(MAX_PORT)}`);
  }
  return port;
}

/** A line that starts with `[`: an IPv6 address, with an optional port. */
function bracketed(line: string): Host {
  const close = line.indexOf("]");
  const address = close === -1 ? undefined : canonical(line.slice(1, close));
  if (address?.family !== 6) {
    throw new ActionError(`host ${JSON.stringify(line)}: [ and ] hold an IPv6 address`);
  }
  const target: Target = { kind: "address", address: address.text };
  const after = line.slice(close + 1);
  if (after === "") {
    return { target, port: undefined };
  }
  if (!after.startsWith(":")) {
    throw new ActionError(`host ${JSON.stringify(line)}: after ], a port (":5432") or nothing`);
  }
  return { target, port: portOf(after.slice(1), line) };
}

function hostOf(line: string): Host {
  if (line.startsWith("[")) {
    return bracketed(line);
  }
  const whole = canonical(line);
  if (whole?.family === 6) {
    return { target: { kind: "address", address: whole.text }, port: undefined };
  }
  const colon = line.indexOf(":");
  const host = colon === -1 ? line : line.slice(0, colon);
  const port = colon === -1 ? undefined : portOf(line.slice(colon + 1), line);
  const address = canonical(host);
  if (address !== undefined) {
    return { target: { kind: "address", address: address.text }, port };
  }
  if (host.startsWith("*.") && isName(host.slice(2))) {
    return { target: { kind: "under", suffix: host.slice(1) }, port };
  }
  if (isName(host)) {
    return { target: { kind: "name", name: host }, port };
  }
  throw new ActionError(
    `host ${JSON.stringify(line)}: a name (api.example.com), a name under a domain (*.example.com) or an IP address, in lowercase, with an optional port (:5432)`,
  );
}

/** The only hosts the step reaches. */
export class AllowedHosts {
  private constructor(
    /** As Cronplane gives them. */
    readonly lines: readonly string[],
    private readonly hosts: readonly Host[],
  ) {}

  /**
   * `CRONPLANE_NETWORK_ALLOW`: unset is no list (any host); a line that is
   * not a host is an error, never a host ignored.
   */
  static parse(value: string | undefined): AllowedHosts | undefined {
    if (value === undefined) {
      return undefined;
    }
    const lines = value.split("\n");
    return new AllowedHosts(lines, lines.map(hostOf));
  }

  /**
   * Whether the list lets the step reach `host` on `port`. A name is
   * compared without its case nor a final dot, an address as an address.
   */
  allows(host: string, port: number): boolean {
    const lower = host.toLowerCase();
    const name = lower.endsWith(".") ? lower.slice(0, -1) : lower;
    const literal = name.startsWith("[") && name.endsWith("]") ? name.slice(1, -1) : name;
    const address = canonical(literal);
    return this.hosts.some((entry) => allows(entry, name, address, port));
  }

  /** `EgressError` when the list does not let the step reach `host` on `port`. */
  check(host: string, port: number): void {
    if (!this.allows(host, port)) {
      throw new EgressError(
        `${host}:${String(port)} is not one of the hosts this step may reach (${this.lines.join(", ")}): see network.allow of the action and of the step`,
      );
    }
  }
}
