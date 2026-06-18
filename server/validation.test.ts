import { describe, expect, it } from "vitest";
import { normalizeMode, normalizeTarget } from "./validation";

describe("normalizeTarget", () => {
  it("accepts public domains and IP addresses", () => {
    expect(normalizeTarget(" Example.COM ")).toBe("example.com");
    expect(normalizeTarget("1.1.1.1")).toBe("1.1.1.1");
  });

  it("rejects URLs, shell characters, and reserved hosts", () => {
    expect(() => normalizeTarget("https://example.com")).toThrow("not a URL or command");
    expect(() => normalizeTarget("example.com; rm -rf /")).toThrow("not a URL or command");
    expect(() => normalizeTarget("localhost")).toThrow("valid domain or IP");
  });

  it("rejects private and documentation IP ranges", () => {
    expect(() => normalizeTarget("10.0.0.1")).toThrow("public domain or public IP");
    expect(() => normalizeTarget("192.0.2.10")).toThrow("public domain or public IP");
  });
});

describe("normalizeMode", () => {
  it("accepts supported measurement modes", () => {
    expect(normalizeMode("traceout")).toBe("traceout");
    expect(normalizeMode("mtr")).toBe("mtr");
  });

  it("rejects unsupported modes", () => {
    expect(() => normalizeMode("ping")).toThrow("traceout or mtr");
  });
});
