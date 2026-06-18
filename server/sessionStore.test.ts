import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeasurementEvent } from "../shared/types";
import { runDemoMeasurement } from "./providers/demoProvider";
import { runGlobalpingMeasurement } from "./providers/globalpingProvider";
import { createSession, getSession, latestResult, subscribe } from "./sessionStore";

vi.mock("./providers/globalpingProvider", () => ({
  runGlobalpingMeasurement: vi.fn(async function* runGlobalpingMeasurement(params: { id: string; mode: "traceout" | "mtr"; target: string }) {
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
      mode: "traceout",
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

  it("falls back to demo measurement when the live provider fails", async () => {
    vi.mocked(runGlobalpingMeasurement).mockImplementationOnce(async function* runGlobalpingFailure() {
      throw new Error("provider unavailable");
    });
    vi.mocked(runDemoMeasurement).mockImplementationOnce(async function* runDemoFallback(params) {
      yield {
        type: "measurement_started",
        payload: {
          id: params.id,
          mode: params.mode,
          target: params.target,
          status: "running",
          source: {
            provider: "demo",
            note: "Measured from a nearby network probe. Demo fallback is active because the live provider was unavailable."
          },
          hops: [],
          confidence: "medium",
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
            provider: "demo",
            note: "Measured from a nearby network probe. Demo fallback is active because the live provider was unavailable."
          },
          hops: [],
          confidence: "medium",
          startedAt: "2026-06-18T00:00:00.000Z",
          finishedAt: "2026-06-18T00:00:01.000Z"
        }
      } satisfies MeasurementEvent;
    });

    const created = createSession({
      mode: "mtr",
      target: "example.com"
    });

    await vi.waitFor(() => {
      expect(latestResult(getSession(created.id)!)).toMatchObject({
        source: {
          provider: "demo"
        },
        status: "finished"
      });
    });

    expect(runDemoMeasurement).toHaveBeenCalledOnce();
  });

  it("publishes a safe error when both live and demo providers fail", async () => {
    vi.mocked(runGlobalpingMeasurement).mockImplementationOnce(async function* runGlobalpingFailure() {
      throw new Error("provider unavailable");
    });
    vi.mocked(runDemoMeasurement).mockImplementationOnce(async function* runDemoFailure() {
      throw new Error("demo unavailable");
    });

    const created = createSession({
      mode: "traceout",
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
  });
});
