import net from "node:net";
import type { TraceMode } from "../shared/types";

const DOMAIN_PATTERN =
  /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

const UNSAFE_TARGET_PATTERN = /[\s;&|<>`$\\'"()[\]{}]/;
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
const blockedIpRanges = new net.BlockList();

blockedIpRanges.addSubnet("0.0.0.0", 8, "ipv4");
blockedIpRanges.addSubnet("10.0.0.0", 8, "ipv4");
blockedIpRanges.addSubnet("100.64.0.0", 10, "ipv4");
blockedIpRanges.addSubnet("127.0.0.0", 8, "ipv4");
blockedIpRanges.addSubnet("169.254.0.0", 16, "ipv4");
blockedIpRanges.addSubnet("172.16.0.0", 12, "ipv4");
blockedIpRanges.addSubnet("192.0.0.0", 24, "ipv4");
blockedIpRanges.addSubnet("192.0.2.0", 24, "ipv4");
blockedIpRanges.addSubnet("192.168.0.0", 16, "ipv4");
blockedIpRanges.addSubnet("198.18.0.0", 15, "ipv4");
blockedIpRanges.addSubnet("198.51.100.0", 24, "ipv4");
blockedIpRanges.addSubnet("203.0.113.0", 24, "ipv4");
blockedIpRanges.addSubnet("224.0.0.0", 4, "ipv4");
blockedIpRanges.addSubnet("240.0.0.0", 4, "ipv4");
blockedIpRanges.addAddress("255.255.255.255", "ipv4");
blockedIpRanges.addAddress("::", "ipv6");
blockedIpRanges.addAddress("::1", "ipv6");
blockedIpRanges.addSubnet("::ffff:0:0", 96, "ipv6");
blockedIpRanges.addSubnet("64:ff9b::", 96, "ipv6");
blockedIpRanges.addSubnet("100::", 64, "ipv6");
blockedIpRanges.addSubnet("2001:db8::", 32, "ipv6");
blockedIpRanges.addSubnet("fc00::", 7, "ipv6");
blockedIpRanges.addSubnet("fe80::", 10, "ipv6");
blockedIpRanges.addSubnet("ff00::", 8, "ipv6");

function isReservedDomain(target: string) {
  return RESERVED_DOMAINS.has(target) || RESERVED_DOMAIN_SUFFIXES.some((suffix) => target.endsWith(suffix));
}

function assertPublicIp(target: string) {
  const ipVersion = net.isIP(target);

  if (ipVersion === 0) {
    return;
  }

  const ipType = ipVersion === 4 ? "ipv4" : "ipv6";

  if (blockedIpRanges.check(target, ipType)) {
    throw new Error("Enter a public domain or public IP address.");
  }
}

export function normalizeTarget(input: unknown): string {
  if (typeof input !== "string") {
    throw new Error("Target must be a domain or IP address.");
  }

  const target = input.trim().toLowerCase();

  if (!target || target.length > 253) {
    throw new Error("Target must be between 1 and 253 characters.");
  }

  if (target.includes("://") || target.includes("/") || UNSAFE_TARGET_PATTERN.test(target)) {
    throw new Error("Enter only a domain or IP address, not a URL or command.");
  }

  if (net.isIP(target) !== 0) {
    assertPublicIp(target);
    return target;
  }

  if (DOMAIN_PATTERN.test(target)) {
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
