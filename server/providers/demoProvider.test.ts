import { afterEach, describe, expect, it, vi } from "vitest";
import { runDemoMeasurement } from "./demoProvider";

describe("runDemoMeasurement", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams honest demo measurement events with target-specific hops", async () => {
    vi.useFakeTimers();

    const events = runDemoMeasurement({
      id: "demo-1",
      mode: "traceout",
      target: "1.1.1.1",
      visitor: { locale: "ko-KR", timeZone: "Asia/Seoul" }
    });

    const started = await events.next();
    expect(started.value).toMatchObject({
      type: "measurement_started",
      payload: {
        confidence: "medium",
        source: {
          city: "Seoul",
          provider: "demo"
        },
        status: "running"
      }
    });

    const firstHop = events.next();
    await vi.advanceTimersByTimeAsync(680);
    expect((await firstHop).value).toMatchObject({
      type: "hop_result",
      payload: {
        hopNumber: 1,
        rttMs: 13,
        status: "ok"
      }
    });
  });

  it("keeps target-specific base latency for google and generic destinations", async () => {
    vi.useFakeTimers();

    const googleEvents = runDemoMeasurement({
      id: "demo-google",
      mode: "traceout",
      target: "google.com"
    });
    await googleEvents.next();
    const googleFirstHop = googleEvents.next();
    await vi.advanceTimersByTimeAsync(680);

    expect((await googleFirstHop).value).toMatchObject({
      type: "hop_result",
      payload: {
        rttMs: 22
      }
    });

    const genericEvents = runDemoMeasurement({
      id: "demo-generic",
      mode: "traceout",
      target: "example.com"
    });
    await genericEvents.next();
    const genericFirstHop = genericEvents.next();
    await vi.advanceTimersByTimeAsync(680);

    expect((await genericFirstHop).value).toMatchObject({
      type: "hop_result",
      payload: {
        rttMs: 31
      }
    });
  });
});
