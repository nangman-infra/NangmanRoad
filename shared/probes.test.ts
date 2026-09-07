import { describe, expect, it } from "vitest";
import { PROBE_LOCATIONS, countryFlag, findProbeLocation } from "./probes";

describe("probe locations", () => {
  it("turns a country code into its flag", () => {
    expect(countryFlag("KR")).toBe("🇰🇷");
    expect(countryFlag("us")).toBe("🇺🇸");
  });

  it("finds a probe by id and nothing for anything else", () => {
    expect(findProbeLocation("seoul")?.city).toBe("Seoul");
    expect(findProbeLocation("nowhere")).toBeUndefined();
    expect(findProbeLocation(42)).toBeUndefined();
    expect(new Set(PROBE_LOCATIONS.map((probe) => probe.id)).size).toBe(PROBE_LOCATIONS.length);
  });
});
