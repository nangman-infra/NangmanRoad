import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichHopsWithGeo, measurementConfidence, resolveGeoProvider } from "./geoInference";

const originalGeoProvider = process.env.GEOIP_PROVIDER;
const originalIpApiUrl = process.env.IP_API_URL;

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

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
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
