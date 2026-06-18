import { afterEach, describe, expect, it, vi } from "vitest";
import { applySecurityHeaders, corsOptions } from "./security";

function request(headers: Record<string, string | undefined> = {}) {
  return {
    get: vi.fn((name: string) => headers[name.toLowerCase()])
  } as unknown as Parameters<typeof applySecurityHeaders>[0];
}

function response() {
  const headers = new Map<string, string>();

  return {
    headers,
    locals: {} as Record<string, unknown>,
    setHeader: vi.fn((name: string, value: string) => {
      headers.set(name, value);
    })
  } as unknown as Parameters<typeof applySecurityHeaders>[1] & {
    headers: Map<string, string>;
    locals: Record<string, unknown>;
  };
}

function evaluateCors(headers: Record<string, string | undefined>) {
  return new Promise<unknown>((resolve, reject) => {
    corsOptions(request(headers), (error, options) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(options);
    });
  });
}

describe("corsOptions", () => {
  afterEach(() => {
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.NODE_ENV;
  });

  it("allows explicitly configured origins", async () => {
    process.env.ALLOWED_ORIGINS = "https://road.example.com";
    process.env.NODE_ENV = "production";

    await expect(evaluateCors({
      host: "nangman.example.com",
      origin: "https://road.example.com"
    })).resolves.toMatchObject({
      origin: "https://road.example.com"
    });
  });

  it("rejects unknown cross-origin callers in production", async () => {
    process.env.NODE_ENV = "production";

    await expect(evaluateCors({
      host: "nangman.example.com",
      origin: "https://attacker.example.com"
    })).resolves.toMatchObject({
      origin: false
    });
  });
});

describe("applySecurityHeaders", () => {
  afterEach(() => {
    delete process.env.ENABLE_HSTS;
  });

  it("sets CSP, isolation, and browser hardening headers", () => {
    const res = response();
    const next = vi.fn();

    applySecurityHeaders(request(), res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(typeof res.locals.cspNonce).toBe("string");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(res.headers.get("Content-Security-Policy")).toContain(`'nonce-${res.locals.cspNonce}'`);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
  });
});
