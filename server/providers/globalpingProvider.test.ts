import { describe, expect, it } from "vitest";
import { parseRawTraceroute, parseResultHops } from "./globalpingProvider";

describe("parseRawTraceroute", () => {
  it("parses traceroute-style raw hop output", () => {
    const hops = parseRawTraceroute(`
      1 AS15169 edge.google.com 142.250.206.14 20.2 ms 22.7 ms 21.1 ms
      2 * * *
    `);

    expect(hops).toHaveLength(2);
    expect(hops[0]).toMatchObject({
      asn: "AS15169",
      hostname: "edge.google.com",
      hopNumber: 1,
      ip: "142.250.206.14",
      rttMs: 21,
      status: "ok"
    });
    expect(hops[1]).toMatchObject({
      hopNumber: 2,
      packetLossPercent: 100,
      status: "loss"
    });
  });

  it("parses MTR-style loss and jitter metrics", () => {
    const hops = parseRawTraceroute("1 AS13335 one.one.one.one 1.1.1.1 0.0% 0 16 14.6 15.2 0.7");

    expect(hops[0]).toMatchObject({
      asn: "AS13335",
      hostname: "one.one.one.one",
      hopNumber: 1,
      ip: "1.1.1.1",
      jitterMs: 1,
      packetLossPercent: 0,
      rttMs: 15,
      sent: 16,
      status: "ok"
    });
  });
});

describe("parseResultHops", () => {
  it("parses structured hop statistics from provider results", () => {
    const hops = parseResultHops({
      hops: [
        {
          resolvedAddress: "1.1.1.1",
          resolvedHostname: "one.one.one.one",
          stats: {
            avg: 14.4,
            loss: 0,
            jAvg: 1.6,
            sent: 16,
            best: 12.2,
            worst: 18.7
          },
          location: {
            city: "Sydney",
            country: "AU",
            lat: -33.86,
            lon: 151.2
          },
          network: {
            asn: 13335,
            name: "Cloudflare"
          }
        }
      ]
    });

    expect(hops[0]).toMatchObject({
      asn: "AS13335",
      asName: "Cloudflare",
      bestMs: 12.2,
      city: "Sydney",
      country: "AU",
      hostname: "one.one.one.one",
      ip: "1.1.1.1",
      jitterMs: 2,
      packetLossPercent: 0,
      rttMs: 14,
      sent: 16,
      status: "ok",
      worstMs: 18.7
    });
  });

  it("falls back between alternate packet-loss fields", () => {
    const hops = parseResultHops({
      result: [
        {
          hop: 3,
          ip: "203.0.113.7",
          packetLoss: 75
        }
      ]
    });

    expect(hops[0]).toMatchObject({
      hopNumber: 3,
      ip: "203.0.113.7",
      packetLossPercent: 75,
      status: "loss"
    });
  });
});
