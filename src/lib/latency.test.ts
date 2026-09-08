import { describe, expect, it } from "vitest";
import { ENDPOINT, ENDPOINT_INK, NO_SPEED, segmentSpeed, speedColor } from "./latency";

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

// The globe leaves its two ends in plain black and white and puts the colour in the glow
// around them; the flat map marks them the plain way, in colour, and those colours must not
// be ones the speed scale can produce or an end would read as a verdict on a leg.
describe("the colours the route's two ends are marked in", () => {
  const themes = ["dark", "light"] as const;
  const scale = (theme: (typeof themes)[number]) => {
    const seen = new Set<string>([NO_SPEED[theme]]);

    for (let kmps = 0; kmps <= 260_000; kmps += 250) seen.add(speedColor(kmps, theme));

    return seen;
  };

  it.each(themes)("tells the start from the end in the %s theme", (theme) => {
    expect(ENDPOINT[theme].source).not.toBe(ENDPOINT[theme].target);
  });

  it.each(themes)("keeps both ends off the speed scale in the %s theme", (theme) => {
    const speeds = scale(theme);

    expect(speeds.has(ENDPOINT[theme].source)).toBe(false);
    expect(speeds.has(ENDPOINT[theme].target)).toBe(false);
  });

  it.each(themes)("gives the %s theme its own pair, not the other one's", (theme) => {
    const other = theme === "dark" ? "light" : "dark";

    expect(ENDPOINT[theme].source).not.toBe(ENDPOINT[other].source);
    expect(ENDPOINT[theme].target).not.toBe(ENDPOINT[other].target);
  });

  it("leaves the globe's own ends in plain black and white", () => {
    expect(ENDPOINT_INK.dark).toBe("#ffffff");
    expect(ENDPOINT_INK.light).toMatch(/^#[0-9a-f]{6}$/);
    expect(ENDPOINT_INK.dark).not.toBe(ENDPOINT_INK.light);
  });
});
