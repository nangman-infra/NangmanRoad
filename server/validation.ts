import net from "node:net";
import type { TraceMode } from "../shared/types";
import {
  isAsciiAlpha,
  isAsciiAlphaNumeric,
  isAsciiDigit,
  isWhitespaceOrControl
} from "./textParsing";

const UNSAFE_TARGET_CHARACTERS = new Set([";", "&", "|", "<", ">", "`", "$", "\\", "'", "\"", "(", ")", "[", "]", "{", "}"]);
const RESERVED_DOMAIN_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".lan",
  ".home",
  ".internal",
  ".test",
  ".example",
  ".invalid"
];
const RESERVED_DOMAINS = new Set(["localhost", "localdomain"]);
const BLOCKED_IPV4_CIDRS: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32]
];
const blockedIpv6Ranges = new net.BlockList();

blockedIpv6Ranges.addAddress("::", "ipv6");
blockedIpv6Ranges.addAddress("::1", "ipv6");
blockedIpv6Ranges.addSubnet("::ffff:0:0", 96, "ipv6");
blockedIpv6Ranges.addSubnet("64:ff9b::", 96, "ipv6");
blockedIpv6Ranges.addSubnet("100::", 64, "ipv6");
blockedIpv6Ranges.addSubnet("2001:db8::", 32, "ipv6");
blockedIpv6Ranges.addSubnet("fc00::", 7, "ipv6");
blockedIpv6Ranges.addSubnet("fe80::", 10, "ipv6");
blockedIpv6Ranges.addSubnet("ff00::", 8, "ipv6");

function isReservedDomain(target: string) {
  return RESERVED_DOMAINS.has(target) || RESERVED_DOMAIN_SUFFIXES.some((suffix) => target.endsWith(suffix));
}

function hasUnsafeTargetCharacter(target: string) {
  for (const character of target) {
    if (UNSAFE_TARGET_CHARACTERS.has(character) || isWhitespaceOrControl(character)) {
      return true;
    }
  }

  return false;
}

function isValidDomainLabel(label: string) {
  if (label.length === 0 || label.length > 63) {
    return false;
  }

  if (!isAsciiAlphaNumeric(label[0]) || !isAsciiAlphaNumeric(label[label.length - 1])) {
    return false;
  }

  for (const character of label) {
    if (!isAsciiAlphaNumeric(character) && character !== "-") {
      return false;
    }
  }

  return true;
}

function isValidDomain(target: string) {
  const labels = target.split(".");
  const tld = labels.at(-1);

  if (labels.length < 2 || !tld || tld.length < 2 || tld.length > 63) {
    return false;
  }

  for (const character of tld) {
    if (!isAsciiAlpha(character)) {
      return false;
    }
  }

  return labels.every(isValidDomainLabel);
}

function ipv4ToNumber(ip: string) {
  const octets = ip.split(".").map(Number);

  if (octets.length !== 4 || !octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    return undefined;
  }

  return octets.reduce((value, octet) => value * 256 + octet, 0);
}

function isBlockedIpv4(target: string) {
  const targetNumber = ipv4ToNumber(target);

  if (targetNumber === undefined) {
    return true;
  }

  return BLOCKED_IPV4_CIDRS.some(([base, prefix]) => {
    const baseNumber = ipv4ToNumber(base);
    const blockSize = 2 ** (32 - prefix);

    return baseNumber !== undefined && Math.floor(targetNumber / blockSize) === Math.floor(baseNumber / blockSize);
  });
}

function assertPublicIp(target: string) {
  const ipVersion = net.isIP(target);

  if (ipVersion === 0) {
    return;
  }

  const blocked = ipVersion === 4 ? isBlockedIpv4(target) : blockedIpv6Ranges.check(target, "ipv6");

  if (blocked) {
    throw new Error("Enter a public domain or public IP address.");
  }
}

export function normalizeTarget(input: unknown): string {
  if (typeof input !== "string") {
    throw new TypeError("Target must be a domain or IP address.");
  }

  const target = input.trim().toLowerCase();

  if (!target || target.length > 253) {
    throw new Error("Target must be between 1 and 253 characters.");
  }

  if (target.includes("://") || target.includes("/") || hasUnsafeTargetCharacter(target)) {
    throw new Error("Enter only a domain or IP address, not a URL or command.");
  }

  if (net.isIP(target) !== 0) {
    assertPublicIp(target);
    return target;
  }

  if (isValidDomain(target)) {
    if (isReservedDomain(target)) {
      throw new Error("Enter a public domain or public IP address.");
    }

    return target;
  }

  throw new Error("Enter a valid domain or IP address.");
}

export function normalizeMode(input: unknown): TraceMode {
  if (input === "traceout" || input === "mtr") {
    return input;
  }

  throw new Error("Mode must be traceout or mtr.");
}
