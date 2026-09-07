import { describe, expect, it } from "vitest";
import { NO_SPEED, segmentSpeed, speedColor } from "./latency";

describe("leg speed colour", () => {
  it("is green near the speed of light in fibre and red when a leg took far too long", () => {
    // 9,000 km in 90 ms round trip: 200,000 km/s before leniency.
    expect(speedColor(segmentSpeed(9_000, 90), "dark")).toBe("#2fd65e");
    // 9,000 km in 2,000 ms: 9,000 km/s, deep in the red.
    expect(speedColor(segmentSpeed(9_000, 2_000), "dark")).toMatch(/^#ff[5-9a-f]/);
  });

  it("judges a short leg leniently", () => {
    // 200 km in 4 ms is 100,000 km/s raw; leniency lifts it past the fibre limit.
    expect(segmentSpeed(200, 4)).toBeGreaterThan(210_000);
  });

  it("is neutral when the round trip did not grow", () => {
    expect(speedColor(segmentSpeed(500, 0), "dark")).toBe(NO_SPEED.dark);
    expect(speedColor(undefined, "light")).toBe(NO_SPEED.light);
  });
});
