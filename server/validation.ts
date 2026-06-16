import net from "node:net";
import type { TraceMode } from "../shared/types";

const DOMAIN_PATTERN =
  /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

const UNSAFE_TARGET_PATTERN = /[\s;&|<>`$\\'"()[\]{}]/;

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

  if (net.isIP(target) !== 0 || DOMAIN_PATTERN.test(target)) {
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
