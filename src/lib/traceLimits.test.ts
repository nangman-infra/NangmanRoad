import { describe, expect, it } from "vitest";
import { HOP_LIMIT, ranOutOfHops, targetIgnoredIcmp } from "./traceLimits";
import type { HopResult } from "../../shared/types";

const answered = (hopNumber: number): HopResult => ({ hopNumber, ip: `10.0.0.${hopNumber}`, status: "ok" });
const silent = (hopNumber: number): HopResult => ({ hopNumber, status: "timeout" });
const trace = (n: number, last = answered) => [...Array.from({ length: n - 1 }, (_, i) => answered(i + 1)), last(n)];

// The offer to measure again in the deeper mode is only worth making when the trace stopped
// for want of hops. A target that stays silent would stay silent 10 hops further on.
describe("telling a trace that ran out of hops from one whose target kept quiet", () => {
  it("says yes when the whole allowance was spent and the last hop still answered", () => {
    expect(ranOutOfHops(trace(HOP_LIMIT.traceroute), "traceroute", false)).toBe(true);
  });

  // A hop that returns nothing is a router that sent no time-exceeded reply of its own. The
  // target may still be several hops past it, never probed, so a silent tail is no reason to
  // withhold the deeper mode.
  it("says yes even when the last hops answered nothing, once the allowance is spent", () => {
    expect(ranOutOfHops(trace(HOP_LIMIT.traceroute, silent), "traceroute", false)).toBe(true);
  });

  it("says no while there were hops left to spend", () => {
    expect(ranOutOfHops(trace(HOP_LIMIT.traceroute - 1), "traceroute", false)).toBe(false);
  });

  it("says no once the target has been reached", () => {
    expect(ranOutOfHops(trace(HOP_LIMIT.traceroute), "traceroute", true)).toBe(false);
  });

  it("says no while the answer is not in yet", () => {
    expect(ranOutOfHops(trace(HOP_LIMIT.traceroute), "traceroute", undefined)).toBe(false);
  });

  it("holds mtr to its own, deeper allowance", () => {
    expect(ranOutOfHops(trace(HOP_LIMIT.traceroute), "mtr", false)).toBe(false);
    expect(ranOutOfHops(trace(HOP_LIMIT.mtr), "mtr", false)).toBe(true);
  });

  it("keeps mtr's allowance the deeper of the two, or there would be nothing to offer", () => {
    expect(HOP_LIMIT.mtr).toBeGreaterThan(HOP_LIMIT.traceroute);
  });
});

// The offer to knock on TCP 443 instead is for a target that ignored ICMP, not for a trace
// that ran out of road, and not for a TCP run that already failed.
describe("telling a target that ignored ICMP from everything else", () => {
  it("says yes when hops answered, the target did not, and hops were left", () => {
    expect(targetIgnoredIcmp(trace(14), "mtr", false, "icmp")).toBe(true);
  });

  it("leaves a trace that ran out of hops to the deeper-mode offer", () => {
    expect(targetIgnoredIcmp(trace(HOP_LIMIT.traceroute), "traceroute", false, "icmp")).toBe(false);
  });

  it("says no after a TCP run, once the target was reached, or before the answer is in", () => {
    expect(targetIgnoredIcmp(trace(14), "mtr", false, "tcp")).toBe(false);
    expect(targetIgnoredIcmp(trace(14), "mtr", true, "icmp")).toBe(false);
    expect(targetIgnoredIcmp(trace(14), "mtr", undefined, "icmp")).toBe(false);
    expect(targetIgnoredIcmp([], "mtr", false, "icmp")).toBe(false);
  });
});
