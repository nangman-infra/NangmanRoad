import { afterEach, describe, expect, it, vi } from "vitest";
import { rateLimit } from "./rateLimit";

function request(ip: string) {
  return {
    ip,
    socket: {}
  } as Parameters<typeof rateLimit>[0];
}

function response() {
  return {
    body: undefined as unknown,
    statusCode: undefined as number | undefined,
    json: vi.fn(function json(this: { body: unknown }, body: unknown) {
      this.body = body;
      return this;
    }),
    status: vi.fn(function status(this: { statusCode?: number }, statusCode: number) {
      this.statusCode = statusCode;
      return this;
    })
  } as unknown as Parameters<typeof rateLimit>[1] & { body?: unknown; statusCode?: number };
}

describe("rateLimit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests below the per-minute threshold", () => {
    const res = response();
    const next = vi.fn();

    rateLimit(request("203.0.113.10"), res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects repeated requests once the minute bucket is full", () => {
    const ip = "203.0.113.11";

    for (let index = 0; index < 8; index += 1) {
      rateLimit(request(ip), response(), vi.fn());
    }

    const res = response();
    const next = vi.fn();
    rateLimit(request(ip), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({
      error: "Too many measurement requests. Please wait a minute and try again."
    });
  });

  it("allows the same client again after the minute window resets", () => {
    vi.useFakeTimers();
    const ip = "203.0.113.12";

    for (let index = 0; index < 8; index += 1) {
      rateLimit(request(ip), response(), vi.fn());
    }

    vi.advanceTimersByTime(60_001);

    const res = response();
    const next = vi.fn();
    rateLimit(request(ip), res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
