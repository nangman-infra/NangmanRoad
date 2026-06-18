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

  it("streams MTR metric updates before finishing", async () => {
    vi.useFakeTimers();

    const events = runDemoMeasurement({
      id: "demo-mtr",
      mode: "mtr",
      target: "1.1.1.1"
    });

    await events.next();

    for (let index = 0; index < 5; index += 1) {
      const hopEvent = events.next();
      await vi.advanceTimersByTimeAsync(520);
      await hopEvent;
    }

    const metricEvent = events.next();
    await vi.advanceTimersByTimeAsync(750);
    await expect(metricEvent).resolves.toMatchObject({
      value: {
        type: "metric_update",
        payload: {
          hopNumber: 1,
          packetLossPercent: 0
        }
      }
    });

    for (let index = 0; index < 4; index += 1) {
      await events.next();
    }

    for (let round = 0; round < 3; round += 1) {
      const nextRound = events.next();
      await vi.advanceTimersByTimeAsync(750);
      await nextRound;

      for (let index = 0; index < 4; index += 1) {
        await events.next();
      }
    }

    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: "measurement_finished",
        payload: {
          status: "finished"
        }
      }
    });
  });
});
