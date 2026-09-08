import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeasurementEvent } from "../shared/types";
import { runDemoMeasurement } from "./providers/demoProvider";
import { runGlobalpingMeasurement } from "./providers/globalpingProvider";
import { createSession, getSession, latestResult, subscribe } from "./sessionStore";

vi.mock("./providers/globalpingProvider", () => ({
  runGlobalpingMeasurement: vi.fn(async function* runGlobalpingMeasurement(params: { id: string; mode: "traceroute" | "mtr"; target: string }) {
    yield {
      type: "measurement_started",
      payload: {
        id: params.id,
        mode: params.mode,
        target: params.target,
        status: "running",
        source: {
          provider: "globalping",
          note: "Measured from a nearby network probe. Not a direct trace from your device."
        },
        hops: [],
        confidence: "high",
        startedAt: "2026-06-18T00:00:00.000Z"
      }
    } satisfies MeasurementEvent;
    yield {
      type: "measurement_finished",
      payload: {
        id: params.id,
        mode: params.mode,
        target: params.target,
        status: "finished",
        source: {
          provider: "globalping",
          note: "Measured from a nearby network probe. Not a direct trace from your device."
        },
        hops: [
          {
            hopNumber: 1,
            ip: "1.1.1.1",
            rttMs: 13,
            status: "ok"
          }
        ],
        confidence: "high",
        startedAt: "2026-06-18T00:00:00.000Z",
        finishedAt: "2026-06-18T00:00:01.000Z"
      }
    } satisfies MeasurementEvent;
  })
}));

vi.mock("./providers/demoProvider", () => ({
  runDemoMeasurement: vi.fn(async function* runDemoMeasurement() {
    yield {
      type: "error",
      payload: {
        message: "Demo provider should not run in this test."
      }
    } satisfies MeasurementEvent;
  })
}));

afterEach(() => {
  delete process.env.MEASUREMENT_PROVIDER;
  vi.clearAllMocks();
});

describe("sessionStore", () => {
  it("creates a session, stores measurement events, and replays them to subscribers", async () => {
    const created = createSession({
      mode: "traceroute",
      target: "1.1.1.1"
    });

    await vi.waitFor(() => {
      expect(latestResult(getSession(created.id)!)).toMatchObject({
        status: "finished",
        target: "1.1.1.1"
      });
    });

    const session = getSession(created.id);
    expect(session).toBeDefined();
    expect(created.status).toBe("starting");

    const listener = vi.fn();
    const unsubscribe = subscribe(session!, listener);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(latestResult(session!)).toMatchObject({
      hops: [
        {
          ip: "1.1.1.1",
          status: "ok"
        }
      ],
      status: "finished"
    });

    unsubscribe();
  });

  it("reports a name that does not resolve instead of inventing a route for it", async () => {
    vi.mocked(runGlobalpingMeasurement).mockImplementationOnce(async function* runGlobalpingFailure() {
      throw new Error("Globalping measurement failed. queryA ENOTFOUND nope.example");
    });

    const created = createSession({
      mode: "traceroute",
      target: "nope.example"
    });

    await vi.waitFor(() => {
      expect(getSession(created.id)?.status).toBe("error");
    });

    const session = getSession(created.id)!;
    const listener = vi.fn();
    subscribe(session, listener);

    expect(listener).toHaveBeenCalledWith({
      type: "error",
      payload: {
        message: "No DNS record found for nope.example. Check the spelling, or enter an IP address."
      }
    });
    // The demo provider fabricates hops out of RFC 5737 documentation addresses. A failed
    // lookup must never reach it, or the visitor gets a route no packet ever took.
    expect(runDemoMeasurement).not.toHaveBeenCalled();
  });

  it("reports a provider outage without falling back to invented hops", async () => {
    vi.mocked(runGlobalpingMeasurement).mockImplementationOnce(async function* runGlobalpingFailure() {
      throw new Error("Globalping returned 503");
    });

    const created = createSession({
      mode: "traceroute",
      target: "example.com"
    });

    await vi.waitFor(() => {
      expect(getSession(created.id)?.status).toBe("error");
    });

    const session = getSession(created.id)!;
    const listener = vi.fn();
    subscribe(session, listener);

    expect(listener).toHaveBeenCalledWith({
      type: "error",
      payload: {
        message: "Measurement is temporarily unavailable. Please try again later."
      }
    });
    expect(runDemoMeasurement).not.toHaveBeenCalled();
  });

  it("still serves demo data when the operator asks for it explicitly", async () => {
    process.env.MEASUREMENT_PROVIDER = "demo";
    vi.mocked(runDemoMeasurement).mockImplementationOnce(async function* runDemoFailure() {
      throw new Error("demo unavailable");
    });

    const created = createSession({
      mode: "traceroute",
      target: "example.com"
    });

    await vi.waitFor(() => {
      expect(getSession(created.id)?.status).toBe("error");
    });

    expect(runDemoMeasurement).toHaveBeenCalledOnce();
    expect(runGlobalpingMeasurement).not.toHaveBeenCalled();
  });
});
