/**
 * Which IP addresses are of the Internet. Strict on purpose: an address in
 * a range set apart by the IANA (private, loopback, link-local, shared,
 * documentation, benchmarking, multicast, reserved) is not public, and an
 * IPv6 address carrying an IPv4 one (mapped, 6to4, NAT64) is judged on it.
 */

import { isIPv4, isIPv6 } from "node:net";

/** A range: its first address and the length of its prefix. */
type Range = readonly [string, number];

/** IPv4 ranges that are not public (IANA special-purpose registry). */
const IPV4_RANGES: readonly Range[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** Within global unicast (2000::/3), the IPv6 ranges that are not public. */
const IPV6_RANGES: readonly Range[] = [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["3fff::", 20],
];

/** Ranges whose addresses carry an IPv4 address in their last 32 bits, or after 16 bits (6to4). */
const MAPPED: Range = ["::ffff:0:0", 96];
const NAT64: Range = ["64:ff9b::", 96];
const SIX_TO_FOUR: Range = ["2002::", 16];
const GLOBAL_UNICAST: Range = ["2000::", 3];

/** Whether `address` (IPv4 or IPv6, as text) is of the Internet; any other text is not. */
export function isPublic(address: string): boolean {
  if (isIPv4(address)) {
    const value = ipv4(address);
    return !IPV4_RANGES.some((range) => within(value, 32, range, ipv4));
  }
  if (!isIPv6(address)) {
    return false;
  }
  const value = ipv6(address.split("%")[0] ?? "");
  if (within(value, 128, MAPPED, ipv6) || within(value, 128, NAT64, ipv6)) {
    return isPublic(fromIpv4(value & 0xffff_ffffn));
  }
  if (within(value, 128, SIX_TO_FOUR, ipv6)) {
    return isPublic(fromIpv4((value >> 80n) & 0xffff_ffffn));
  }
  return within(value, 128, GLOBAL_UNICAST, ipv6) && !IPV6_RANGES.some((range) => within(value, 128, range, ipv6));
}

const LOOPBACK_V4: Range = ["127.0.0.0", 8];

/**
 * Whether `address` (IPv4 or IPv6, as text) is of this machine; an IPv6
 * address carrying an IPv4 one is judged on it. Any other text is not.
 */
export function isLoopback(address: string): boolean {
  if (isIPv4(address)) {
    return within(ipv4(address), 32, LOOPBACK_V4, ipv4);
  }
  if (!isIPv6(address)) {
    return false;
  }
  const value = ipv6(address.split("%")[0] ?? "");
  return within(value, 128, MAPPED, ipv6) ? isLoopback(fromIpv4(value & 0xffff_ffffn)) : value === 1n;
}

/** An address in one writing: every writing of the same address gives the same text. */
export interface Canonical {
  readonly family: 4 | 6;
  readonly text: string;
}

/** `text` as an address (IPv4 or IPv6) in one writing; undefined for any other text. */
export function canonical(text: string): Canonical | undefined {
  if (isIPv4(text)) {
    return { family: 4, text };
  }
  if (!isIPv6(text)) {
    return undefined;
  }
  const [groups = "", zone] = text.split("%");
  return { family: 6, text: `${ipv6(groups).toString(16)}${zone === undefined ? "" : `%${zone}`}` };
}

function within(value: bigint, bits: number, [first, prefix]: Range, parse: (text: string) => bigint): boolean {
  const shift = BigInt(bits - prefix);
  return value >> shift === parse(first) >> shift;
}

function ipv4(text: string): bigint {
  return text.split(".").reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);
}

function fromIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join(".");
}

/** An IPv6 address as a number; `node:net` said it is one. */
function ipv6(text: string): bigint {
  let groups = text;
  // A trailing dotted IPv4 address stands for the last two groups.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1] !== undefined && dotted[2] !== undefined) {
    const value = ipv4(dotted[2]);
    groups = `${dotted[1]}${(value >> 16n).toString(16)}:${(value & 0xffffn).toString(16)}`;
  }
  const [head = "", tail] = groups.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  const all = [...left, ...Array<string>(missing).fill("0"), ...right];
  return all.reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}
