import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRawTraceroute, parseResultHops, runGlobalpingMeasurement } from "./globalpingProvider";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.GLOBALPING_API_URL;
});

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

  it("normalizes ASN variants from structured provider data", () => {
    const hops = parseResultHops({
      hops: [
        {
          resolvedAddress: "203.0.113.10",
          asn: "AS???",
          stats: { avg: 10 }
        },
        {
          resolvedAddress: "203.0.113.11",
          network: { number: "15169", name: "Google" },
          stats: { avg: 11 }
        },
        {
          resolvedAddress: "203.0.113.12",
          as: { id: { value: "13335" }, name: "Cloudflare" },
          stats: { avg: 12 }
        }
      ]
    });

    expect(hops.map((hop) => hop.asn)).toEqual(["AS???", "AS15169", "AS13335"]);
  });

  it("marks private raw hops with unknown ASN", () => {
    const hops = parseRawTraceroute(`
      1 edge.local 10.0.0.1 1.0 ms
      2 gateway.local 172.20.0.1 2.0 ms
      3 lan.local 192.168.0.1 3.0 ms
      4 cgnat.local 100.64.0.1 4.0 ms
    `);

    expect(hops.map((hop) => hop.asn)).toEqual(["AS???", "AS???", "AS???", "AS???"]);
  });
});

describe("runGlobalpingMeasurement", () => {
  it("streams started, hop, and finished events from a completed provider response", async () => {
    vi.useFakeTimers();
    process.env.GLOBALPING_API_URL = "https://globalping.example.test/v1/measurements";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "provider-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "finished",
        results: [
          {
            probe: {
              id: "probe-seoul",
              city: "Seoul",
              country: "KR",
              asn: 12345,
              latitude: 37.57,
              longitude: 126.98
            },
            hops: [
              {
                resolvedAddress: "1.1.1.1",
                resolvedHostname: "one.one.one.one",
                stats: {
                  avg: 13.4,
                  loss: 0,
                  sent: 16
                },
                location: {
                  city: "Seoul",
                  country: "KR",
                  lat: 37.57,
                  lon: 126.98
                }
              }
            ]
          }
        ]
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const events = runGlobalpingMeasurement({
      id: "measurement-1",
      mode: "traceout",
      target: "1.1.1.1"
    });

    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: "measurement_started",
        payload: {
          status: "running",
          target: "1.1.1.1"
        }
      }
    });

    const hopEvent = events.next();
    await vi.advanceTimersByTimeAsync(1_250);
    await expect(hopEvent).resolves.toMatchObject({
      value: {
        type: "hop_result",
        payload: {
          hopNumber: 1,
          ip: "1.1.1.1",
          rttMs: 13,
          status: "ok"
        }
      }
    });
    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: "measurement_finished",
        payload: {
          confidence: "medium",
          status: "finished"
        }
      }
    });
    await expect(events.next()).resolves.toMatchObject({
      done: true
    });
  });

  it("retries MTR with TCP when ICMP is rejected by the provider", async () => {
    vi.useFakeTimers();
    process.env.GLOBALPING_API_URL = "https://globalping.example.test/v1/measurements";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "icmp-measurement" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "finished",
        results: [
          {
            result: {
              status: "failed",
              rawOutput: "Target contains private IP ranges and is not allowed with ICMP."
            }
          }
        ]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "tcp-measurement" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "finished",
        results: [
          {
            probe: {
              id: "probe-tokyo",
              city: "Tokyo",
              country: "JP",
              asn: "AS64500",
              latitude: 35.67,
              longitude: 139.65
            },
            hops: [
              {
                resolvedAddress: "8.8.8.8",
                resolvedHostname: "dns.google",
                stats: {
                  avg: 22.2,
                  loss: 0,
                  jAvg: 0.6,
                  sent: 16
                },
                location: {
                  city: "Tokyo",
                  country: "JP",
                  lat: 35.67,
                  lon: 139.65
                }
              }
            ]
          }
        ]
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const events = runGlobalpingMeasurement({
      id: "measurement-mtr",
      mode: "mtr",
      target: "8.8.8.8"
    });

    await events.next();

    const hopEvent = events.next();
    await vi.advanceTimersByTimeAsync(1_250);
    await vi.advanceTimersByTimeAsync(1_250);
    await expect(hopEvent).resolves.toMatchObject({
      value: {
        type: "hop_result",
        payload: {
          ip: "8.8.8.8",
          rttMs: 22
        }
      }
    });
    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: "metric_update",
        payload: {
          hopNumber: 1,
          jitterMs: 1,
          packetLossPercent: 0
        }
      }
    });
    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: "measurement_finished",
        payload: {
          status: "finished"
        }
      }
    });

    const createBodies = fetchMock.mock.calls
      .filter(([, init]) => init && typeof init === "object" && "body" in init)
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

    expect(createBodies.map((body) => body.measurementOptions.protocol)).toEqual(["ICMP", "TCP"]);
  });

  it("throws a sanitized provider error when a traceout measurement fails", async () => {
    vi.useFakeTimers();
    process.env.GLOBALPING_API_URL = "https://globalping.example.test/v1/measurements";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "traceout-measurement" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "finished",
        results: [
          {
            result: {
              status: "failed",
              rawOutput: "provider refused target"
            }
          }
        ]
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const events = runGlobalpingMeasurement({
      id: "measurement-failed",
      mode: "traceout",
      target: "example.com"
    });

    await events.next();
    const failed = expect(events.next()).rejects.toThrow("Globalping measurement failed. provider refused target");
    await vi.advanceTimersByTimeAsync(1_250);
    await failed;
  });

  it("throws when the provider create request fails", async () => {
    process.env.GLOBALPING_API_URL = "https://globalping.example.test/v1/measurements";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));

    const events = runGlobalpingMeasurement({
      id: "measurement-create-failed",
      mode: "traceout",
      target: "example.com"
    });

    await events.next();

    await expect(events.next()).rejects.toThrow("Globalping returned 503");
  });
});
