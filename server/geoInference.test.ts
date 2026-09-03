import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichHopsWithGeo, measurementConfidence, resetGeoState, resolveGeoProvider } from "./geoInference";

const originalGeoProvider = process.env.GEOIP_PROVIDER;
const originalIpApiUrl = process.env.IP_API_URL;
const originalIpApiKey = process.env.IP_API_KEY;

afterEach(() => {
  if (originalGeoProvider === undefined) {
    delete process.env.GEOIP_PROVIDER;
  } else {
    process.env.GEOIP_PROVIDER = originalGeoProvider;
  }

  if (originalIpApiUrl === undefined) {
    delete process.env.IP_API_URL;
  } else {
    process.env.IP_API_URL = originalIpApiUrl;
  }

  if (originalIpApiKey === undefined) {
    delete process.env.IP_API_KEY;
  } else {
    process.env.IP_API_KEY = originalIpApiKey;
  }

  resetGeoState();
  vi.unstubAllGlobals();
});

describe("resolveGeoProvider", () => {
  it("does not fall back to cleartext GeoIP by default", () => {
    expect(resolveGeoProvider({})).toBe("none");
  });

  it("uses HTTPS ipinfo when a token is available", () => {
    expect(resolveGeoProvider({ IPINFO_TOKEN: "token" })).toBe("ipinfo");
  });

  it("honors explicit provider configuration", () => {
    expect(resolveGeoProvider({ GEOIP_PROVIDER: "ip-api" })).toBe("ip-api");
    expect(resolveGeoProvider({ GEOIP_PROVIDER: "none", IPINFO_TOKEN: "token" })).toBe("none");
  });
});

describe("enrichHopsWithGeo", () => {
  it("uses configured GeoIP data without overriding stronger provider coordinates", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://geo.example.test";

    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({
      status: "success",
      countryCode: "JP",
      country: "Japan",
      city: "Tokyo",
      lat: 35.6762,
      lon: 139.6503,
      as: "AS15169 Google LLC",
      asname: "Google LLC",
      reverse: "edge.example.net"
    })));
    vi.stubGlobal("fetch", fetchMock);

    const [hop] = await enrichHopsWithGeo({
      hops: [
        {
          hopNumber: 1,
          ip: "8.8.4.4",
          hostname: "edge.example.net",
          rttMs: 22,
          city: "Seoul",
          country: "KR",
          latitude: 37.57,
          longitude: 126.98,
          status: "ok"
        }
      ]
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(hop).toMatchObject({
      asn: "AS15169",
      asName: "Google LLC",
      city: "Seoul",
      country: "KR",
      locationConfidence: "high",
      locationSource: "provider"
    });
  });

  it("stops spending requests after ip-api reports the free-tier limit", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://ip-api.test";
    delete process.env.IP_API_KEY;

    const fetchMock = vi.fn(
      async () => new Response("", { status: 429, headers: { "x-rl": "0", "x-ttl": "45" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    await enrichHopsWithGeo({
      hops: [{ hopNumber: 1, ip: "9.9.9.9", hostname: "a.example.net", rttMs: 10, status: "ok" }]
    });

    expect(fetchMock).toHaveBeenCalledOnce();

    await enrichHopsWithGeo({
      hops: [{ hopNumber: 2, ip: "9.9.9.10", hostname: "b.example.net", rttMs: 12, status: "ok" }]
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("skips the GeoIP lookup when reverse DNS already names the city", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://ip-api.test";
    delete process.env.IP_API_KEY;

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "fail" })));
    vi.stubGlobal("fetch", fetchMock);

    const [hop] = await enrichHopsWithGeo({
      hops: [
        {
          hopNumber: 1,
          ip: "9.9.9.11",
          hostname: "ae-1.r02.icn01.example.net",
          asn: "AS3356",
          rttMs: 14,
          status: "ok"
        }
      ]
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(hop).toMatchObject({ city: "Seoul", locationSource: "reverse_dns" });
  });

  it("logs and skips ip-api responses that are not successful", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://ip-api.test";
    delete process.env.IP_API_KEY;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "fail", message: "private range" })))
    );

    const [hop] = await enrichHopsWithGeo({
      hops: [{ hopNumber: 1, ip: "9.9.9.12", hostname: "c.example.net", rttMs: 10, status: "ok" }]
    });

    expect(hop.locationSource).toBe("unknown");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("private range"));
    warn.mockRestore();
  });

  it("logs and skips when the ip-api request throws", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://ip-api.test";
    delete process.env.IP_API_KEY;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("socket hang up");
    }));

    const [hop] = await enrichHopsWithGeo({
      hops: [{ hopNumber: 1, ip: "9.9.9.13", hostname: "d.example.net", rttMs: 10, status: "ok" }]
    });

    expect(hop.locationSource).toBe("unknown");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("socket hang up"));
    warn.mockRestore();
  });

  it("looks up a repeated hop IP once and ignores non-numeric rate limit headers", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://ip-api.test";
    delete process.env.IP_API_KEY;

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: "success",
      countryCode: "DE",
      city: "Frankfurt",
      lat: 50.1109,
      lon: 8.6821,
      as: "AS3320 Deutsche Telekom"
    }), { headers: { "x-rl": "n/a", "x-ttl": "n/a" } }));
    vi.stubGlobal("fetch", fetchMock);

    const hops = await enrichHopsWithGeo({
      hops: [
        { hopNumber: 1, ip: "9.9.9.14", hostname: "e.example.net", rttMs: 10, status: "ok" },
        { hopNumber: 2, ip: "9.9.9.14", hostname: "f.example.net", rttMs: 11, status: "ok" }
      ]
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(hops.map((hop) => hop.city)).toEqual(["Frankfurt", "Frankfurt"]);
  });

  it("adds the ip-api Pro key to GeoIP requests when configured", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://pro.ip-api.com";
    process.env.IP_API_KEY = "secret-pro-key";

    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({
      status: "success",
      countryCode: "US",
      country: "United States",
      city: "Los Angeles",
      lat: 34.0522,
      lon: -118.2437,
      as: "AS13335 Cloudflare",
      asname: "Cloudflare"
    })));
    vi.stubGlobal("fetch", fetchMock);

    await enrichHopsWithGeo({
      hops: [
        {
          hopNumber: 1,
          ip: "1.1.1.1",
          rttMs: 120,
          status: "ok"
        }
      ]
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));

    expect(url.origin).toBe("https://pro.ip-api.com");
    expect(url.pathname).toBe("/json/1.1.1.1");
    expect(url.searchParams.get("key")).toBe("secret-pro-key");
    expect(url.searchParams.get("fields")).toContain("asname");
    expect(url.searchParams.get("fields")).toContain("regionName");
    expect(url.searchParams.get("fields")).toContain("district");
    expect(url.searchParams.get("fields")).toContain("isp");
    expect(url.searchParams.get("fields")).toContain("org");
    expect(url.searchParams.get("fields")).toContain("hosting");
    expect(url.searchParams.get("fields")).toContain("proxy");
  });

  it("normalizes district-level Hong Kong GeoIP results to a readable metro point", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://geo.example.test";

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "success",
      countryCode: "HK",
      country: "Hong Kong",
      regionName: "Wan Chai",
      city: "Wan Chai",
      district: "Wan Chai",
      lat: 22.2797,
      lon: 114.1717,
      as: "AS4637 Telstra Global",
      asname: "Telstra Global",
      isp: "Telstra Global",
      org: "Telstra Global",
      hosting: true,
      proxy: false
    }))));

    const [hop] = await enrichHopsWithGeo({
      source: {
        provider: "globalping",
        city: "Seoul",
        country: "KR",
        latitude: 37.57,
        longitude: 126.98,
        note: "Measured from a nearby network probe."
      },
      hops: [
        {
          hopNumber: 4,
          ip: "93.184.216.34",
          rttMs: 32,
          status: "ok"
        }
      ]
    });

    expect(hop).toMatchObject({
      asn: "AS4637",
      asName: "Telstra Global",
      city: "Hong Kong",
      country: "HK",
      locationSource: "geoip",
      locationPrecision: "city"
    });
    expect(hop.locationEvidence).toContain("Wan Chai normalized to Hong Kong metro for route readability");
  });

  it("combines hostname and GeoIP evidence when both point to the same city", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://geo.example.test";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: "success",
      countryCode: "JP",
      city: "Tokyo",
      lat: 35.6762,
      lon: 139.6503,
      as: "AS15169 Google LLC",
      asname: "Google LLC"
    })));
    vi.stubGlobal("fetch", fetchMock);

    const [hop] = await enrichHopsWithGeo({
      hops: [
        {
          hopNumber: 1,
          ip: "8.8.8.8",
          hostname: "nrt-edge.example.net",
          rttMs: 18,
          status: "ok"
        }
      ]
    });

    expect(hop).toMatchObject({
      city: "Tokyo",
      country: "JP",
      locationConfidence: "high",
      locationSource: "combined"
    });
  });

  it.each([
    {
      city: "Seoul",
      country: "KR",
      ip: "8.8.4.4",
      latitude: 37.57,
      longitude: 126.98,
      rttMs: 8,
      expectedCity: "Seoul metro"
    },
    {
      city: "Tokyo",
      country: "JP",
      ip: "9.9.9.9",
      latitude: 35.6762,
      longitude: 139.6503,
      rttMs: 20,
      expectedCity: "Tokyo"
    },
    {
      city: "Hong Kong",
      country: "HK",
      ip: "1.0.0.1",
      latitude: 22.3193,
      longitude: 114.1694,
      rttMs: 60,
      expectedCity: "Hong Kong"
    }
  ])("uses RTT support when ranking $city provider evidence", async (candidate) => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://geo.example.test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "success",
      countryCode: "DE",
      city: "Frankfurt",
      lat: 50.1109,
      lon: 8.6821
    }))));

    const [hop] = await enrichHopsWithGeo({
      source: {
        provider: "globalping",
        city: "Seoul",
        country: "KR",
        latitude: 37.57,
        longitude: 126.98,
        note: "Measured from a nearby network probe."
      },
      hops: [
        {
          hopNumber: 1,
          ip: candidate.ip,
          city: candidate.city,
          country: candidate.country,
          latitude: candidate.latitude,
          longitude: candidate.longitude,
          rttMs: candidate.rttMs,
          status: "ok"
        }
      ]
    });

    expect(hop).toMatchObject({
      city: candidate.expectedCity,
      country: candidate.country,
      locationSource: "provider"
    });
  });

  it("marks unresolved private hops as low-confidence unknown locations", async () => {
    process.env.GEOIP_PROVIDER = "none";

    const [hop] = await enrichHopsWithGeo({
      hops: [
        {
          hopNumber: 1,
          ip: "10.0.0.1",
          status: "timeout"
        }
      ]
    });

    expect(hop).toMatchObject({
      hopNumber: 1,
      locationConfidence: "low",
      locationPrecision: "unknown",
      locationSource: "unknown",
      status: "timeout"
    });
  });

  it("does not query GeoIP for private or reserved address ranges", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://geo.example.test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const hops = await enrichHopsWithGeo({
      hops: [
        "0.0.0.1",
        "10.0.0.1",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.1.1",
        "172.16.0.1",
        "192.0.2.1",
        "192.168.0.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1"
      ].map((ip, index) => ({
        hopNumber: index + 1,
        ip,
        status: "timeout" as const
      }))
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(hops.every((hop) => hop.locationSource === "unknown")).toBe(true);
  });

  it("suppresses weak GeoIP outliers between nearby reliable route points", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://geo.example.test";

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "success",
      countryCode: "US",
      country: "United States",
      regionName: "California",
      city: "Los Angeles",
      lat: 34.0522,
      lon: -118.2437,
      as: "AS64500 Example Network",
      asname: "Example Network"
    }))));

    const hops = await enrichHopsWithGeo({
      hops: [
        {
          hopNumber: 1,
          ip: "10.0.0.1",
          city: "Seoul",
          country: "KR",
          latitude: 37.5665,
          longitude: 126.978,
          rttMs: 2,
          status: "ok"
        },
        {
          hopNumber: 2,
          ip: "44.44.44.44",
          rttMs: 80,
          status: "ok"
        },
        {
          hopNumber: 3,
          ip: "10.0.0.2",
          city: "Seoul",
          country: "KR",
          latitude: 37.5651,
          longitude: 126.9895,
          rttMs: 3,
          status: "ok"
        }
      ]
    });

    expect(hops[1]).toMatchObject({
      hopNumber: 2,
      locationConfidence: "low",
      locationPrecision: "unknown",
      locationSource: "unknown"
    });
    expect(hops[1].city).toBeUndefined();
    expect(hops[1].locationEvidence).toContain(
      "Suppressed weak GeoIP point because adjacent reliable route points stay in the same metro area"
    );
  });
});

describe("measurementConfidence", () => {
  it("returns high when enough located hops have high confidence", () => {
    expect(measurementConfidence([
      {
        hopNumber: 1,
        latitude: 37.57,
        longitude: 126.98,
        locationConfidence: "high",
        status: "ok"
      },
      {
        hopNumber: 2,
        latitude: 35.68,
        longitude: 139.65,
        locationConfidence: "high",
        status: "ok"
      }
    ])).toBe("high");
  });

  it("returns low when no hops have coordinates", () => {
    expect(measurementConfidence([
      {
        hopNumber: 1,
        status: "timeout"
      }
    ])).toBe("low");
  });

  it("returns low when too few hops have coordinates", () => {
    expect(measurementConfidence([
      {
        hopNumber: 1,
        latitude: 37.57,
        longitude: 126.98,
        locationConfidence: "medium",
        status: "ok"
      },
      { hopNumber: 2, status: "timeout" },
      { hopNumber: 3, status: "timeout" },
      { hopNumber: 4, status: "timeout" },
      { hopNumber: 5, status: "timeout" }
    ])).toBe("low");
  });
});
