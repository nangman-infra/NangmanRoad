import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichHopsWithGeo, measurementConfidence, resetGeoState, resolveGeoProvider } from "./geoInference";

// These tests count the requests the providers make; RIPE IPmap is a live service and is
// switched off here, as it can be in production.
process.env.RIPE_IPMAP = "off";

const originalGeoProvider = process.env.GEOIP_PROVIDER;
const originalIpApiUrl = process.env.IP_API_URL;
const originalIpApiKey = process.env.IP_API_KEY;
const originalGeoSecondary = process.env.GEOIP_SECONDARY;

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

  if (originalGeoSecondary === undefined) {
    delete process.env.GEOIP_SECONDARY;
  } else {
    process.env.GEOIP_SECONDARY = originalGeoSecondary;
  }

  delete process.env.IP2LOCATION_API_KEY;
  delete process.env.IP2LOCATION_URL;
  delete process.env.IPWHOIS_URL;

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
    process.env.GEOIP_SECONDARY = "none";
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
    process.env.GEOIP_SECONDARY = "none";
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

  it("reads an IATA airport code out of reverse DNS once a source confirms the country", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://ip-api.test";
    process.env.GEOIP_SECONDARY = "none";

    // Right country, wrong city: exactly what a backbone IP looks like in a GeoIP database.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "success",
      countryCode: "US",
      country: "United States",
      city: "Ashburn",
      lat: 39.0438,
      lon: -77.4874,
      as: "AS174 Cogent"
    }))));

    const [hop] = await enrichHopsWithGeo({
      hops: [
        {
          hopNumber: 1,
          ip: "9.9.9.30",
          hostname: "be8472.ccr81.mia03.atlas.example.net",
          asn: "AS174",
          rttMs: 220,
          status: "ok"
        }
      ]
    });

    // "mia" is not in the hand-written city list, so only the airport dataset can place it.
    expect(hop).toMatchObject({ city: "Miami", locationSource: "reverse_dns" });
    expect(hop.locationEvidence?.join(" ")).toContain("airport code");
  });

  it("ignores an airport code that no source puts in the same country", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://ip-api.test";
    process.env.GEOIP_SECONDARY = "none";

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "success",
      countryCode: "BR",
      country: "Brazil",
      city: "Curitiba",
      lat: -25.5026,
      lon: -49.2908,
      as: "AS10881 RNP"
    }))));

    const [hop] = await enrichHopsWithGeo({
      hops: [
        {
          hopNumber: 1,
          // "cpr" is an interface label here, but the dataset knows it as Casper, Wyoming.
          hostname: "cpr1-csp2-tlb.bkb.example.br",
          ip: "9.9.9.32",
          asn: "AS10881",
          rttMs: 395,
          status: "ok"
        }
      ]
    });

    expect(hop.city).toBe("Curitiba");
    expect(hop.country).toBe("BR");
  });

  it("drops the outlier when two of three GeoIP databases agree", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://ip-api.test";
    process.env.IPWHOIS_URL = "https://ipwho.test";
    process.env.IP2LOCATION_URL = "https://ip2location.test/";
    process.env.IP2LOCATION_API_KEY = "test-key";
    delete process.env.GEOIP_SECONDARY;

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.includes("ipwho.test")) {
        return new Response(JSON.stringify({
          success: true, city: "Los Angeles", region: "California", country_code: "US",
          latitude: 34.0522, longitude: -118.2437, connection: { asn: 3257, org: "GTT", isp: "GTT" }
        }));
      }

      if (url.includes("ip2location.test")) {
        return new Response(JSON.stringify({
          country_code: "US", region_name: "California", city_name: "Los Angeles",
          latitude: 34.0526, longitude: -118.2439, asn: "3257", as: "GTT"
        }));
      }

      // The lone dissenter: a stale registration address in another country.
      return new Response(JSON.stringify({
        status: "success", countryCode: "GB", country: "United Kingdom", city: "London",
        lat: 51.5072, lon: -0.1276, as: "AS3257 GTT"
      }));
    }));

    const [hop] = await enrichHopsWithGeo({
      hops: [{ hopNumber: 1, ip: "9.9.9.40", asn: "AS3257", rttMs: 150, status: "ok" }]
    });

    expect(hop.city).toBe("Los Angeles");
    expect(hop.locationConfidence).toBe("high");
    expect(hop.locationEvidence?.join(" ")).toContain("2 of 3 GeoIP databases agree");
  });

  it("prefers the city two independent GeoIP sources agree on", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://ip-api.test";
    process.env.IPWHOIS_URL = "https://ipwho.test";
    delete process.env.GEOIP_SECONDARY;

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.includes("ipwho.test")) {
        return new Response(JSON.stringify({
          success: true,
          city: "Los Angeles",
          region: "California",
          country_code: "US",
          latitude: 34.0522,
          longitude: -118.2437,
          connection: { asn: 3257, org: "GTT", isp: "GTT" }
        }));
      }

      // The primary insists on London; the airport code and the second source both say LA.
      return new Response(JSON.stringify({
        status: "success",
        countryCode: "GB",
        country: "United Kingdom",
        city: "London",
        lat: 51.5072,
        lon: -0.1276,
        as: "AS3257 GTT"
      }));
    }));

    const [hop] = await enrichHopsWithGeo({
      hops: [
        {
          hopNumber: 1,
          ip: "9.9.9.31",
          hostname: "ae16.cr5-lax2.ip4.example.net",
          asn: "AS3257",
          rttMs: 150,
          status: "ok"
        }
      ]
    });

    expect(hop.city).toBe("Los Angeles");
    expect(hop.country).toBe("US");
  });

  it("logs and skips ip-api responses that are not successful", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.GEOIP_SECONDARY = "none";
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
    process.env.GEOIP_SECONDARY = "none";
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
    process.env.GEOIP_SECONDARY = "none";
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

  it("does not re-request an unresolved hop IP on every poll", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.GEOIP_SECONDARY = "none";
    process.env.IP_API_URL = "https://ip-api.test";
    delete process.env.IP_API_KEY;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "fail", message: "reserved range" })));
    vi.stubGlobal("fetch", fetchMock);

    const hop = { hopNumber: 1, ip: "9.9.9.20", hostname: "g.example.net", rttMs: 10, status: "ok" as const };

    await enrichHopsWithGeo({ hops: [hop] });
    await enrichHopsWithGeo({ hops: [hop] });
    await enrichHopsWithGeo({ hops: [hop] });

    expect(fetchMock).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("places an unlocated hop at a neighbour answering at the same latency", async () => {
    process.env.GEOIP_PROVIDER = "none";
    process.env.GEOIP_SECONDARY = "none";
    delete process.env.IP_API_URL;

    const hops = await enrichHopsWithGeo({
      hops: [
        {
          hopNumber: 1,
          ip: "203.0.113.9",
          city: "Seoul",
          country: "KR",
          latitude: 37.5665,
          longitude: 126.978,
          locationConfidence: "high",
          locationSource: "reverse_dns",
          rttMs: 32,
          status: "ok"
        },
        { hopNumber: 2, ip: "142.251.66.207", rttMs: 33, status: "ok" },
        { hopNumber: 3, ip: "142.251.66.208", rttMs: 210, status: "ok" },
        { hopNumber: 4, rttMs: undefined, status: "timeout" }
      ]
    });

    expect(hops[1]).toMatchObject({
      city: "Seoul",
      locationSource: "rtt_neighbor",
      locationPrecision: "metro",
      locationConfidence: "low"
    });
    expect(hops[1].locationEvidence?.join(" ")).toContain("shares that metro area");
    // 210 ms cannot be the same place as a 32 ms hop, and a hop with no reply has no identity.
    expect(hops[2].latitude).toBeUndefined();
    expect(hops[3].latitude).toBeUndefined();
  });

  it("adds the ip-api Pro key to GeoIP requests when configured", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.GEOIP_SECONDARY = "none";
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
    process.env.GEOIP_SECONDARY = "none";
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
    process.env.GEOIP_SECONDARY = "none";
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
    process.env.GEOIP_SECONDARY = "none";
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
    process.env.GEOIP_SECONDARY = "none";

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
    process.env.GEOIP_SECONDARY = "none";
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
    process.env.GEOIP_SECONDARY = "none";
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

  it("drops route points that no latency difference can reach", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.GEOIP_SECONDARY = "none";
    process.env.IP_API_URL = "https://geo.example.test";

    // One Telecom Italia Sparkle backbone segment as the databases actually answer it: every
    // address in the block gets its own continent, and the run crosses the Atlantic three
    // times inside 112 ms of RTT spread.
    const cities: Record<string, { city: string; countryCode: string; lat: number; lon: number }> = {
      "176.52.248.132": { city: "Madrid", countryCode: "ES", lat: 40.4168, lon: -3.7038 },
      "94.142.127.65": { city: "Madrid", countryCode: "ES", lat: 40.4168, lon: -3.7038 },
      "84.16.15.66": { city: "New York City", countryCode: "US", lat: 40.7128, lon: -74.006 },
      "94.142.99.176": { city: "Sao Paulo", countryCode: "BR", lat: -23.5505, lon: -46.6333 },
      "213.140.36.89": { city: "Madrid", countryCode: "ES", lat: 40.4168, lon: -3.7038 }
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const match = Object.keys(cities).find((ip) => String(input).includes(ip));
        const entry = match ? cities[match] : undefined;

        if (!entry) {
          return new Response(JSON.stringify({ status: "fail" }));
        }

        return new Response(
          JSON.stringify({
            status: "success",
            countryCode: entry.countryCode,
            country: entry.countryCode,
            city: entry.city,
            lat: entry.lat,
            lon: entry.lon,
            as: "AS6762 Telecom Italia Sparkle",
            asname: "SEABONE-NET"
          })
        );
      })
    );

    const hops = await enrichHopsWithGeo({
      hops: (
        [
          ["176.52.248.132", 387],
          ["94.142.127.65", 275],
          ["84.16.15.66", 279],
          ["94.142.99.176", 378],
          ["213.140.36.89", 387]
        ] as const
      ).map(([ip, rttMs], index) => ({
        hopNumber: index + 9,
        ip,
        hostname: `r${index}.example.net`,
        rttMs,
        status: "ok" as const
      }))
    });

    const placedCities = hops.map((hop) => hop.city);

    expect(placedCities).not.toContain("New York City");
    expect(placedCities).not.toContain("Sao Paulo");
    // The hops the databases agreed on survive; only the impossible detours are dropped.
    expect(placedCities.filter((city) => city === "Madrid")).toHaveLength(3);
  });

  it("moves a hop to an outvoted database when the majority picks an unreachable city", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://ipapi.example.test";
    process.env.IPWHOIS_URL = "https://ipwhois.example.test";
    process.env.IP2LOCATION_URL = "https://ip2location.example.test/";
    process.env.IP2LOCATION_API_KEY = "test-key";

    const MADRID = { city: "Madrid", country: "ES", lat: 40.4168, lon: -3.7038 };
    const PARIS = { city: "Paris", country: "FR", lat: 48.8566, lon: 2.3522 };
    const NEW_YORK = { city: "New York City", country: "US", lat: 40.7128, lon: -74.006 };
    const SAO_PAULO = { city: "Sao Paulo", country: "BR", lat: -23.5505, lon: -46.6333 };

    // 84.16.15.66 is the case that motivated this: two of three databases put a Telxius
    // backbone address in New York while the hops either side of it stay in Madrid.
    const answers: Record<string, [typeof MADRID, typeof MADRID, typeof MADRID]> = {
      "176.52.248.132": [MADRID, PARIS, MADRID],
      "94.142.127.65": [MADRID, MADRID, MADRID],
      "84.16.15.66": [MADRID, NEW_YORK, NEW_YORK],
      "170.79.213.109": [SAO_PAULO, SAO_PAULO, SAO_PAULO]
    };

    const pick = (url: string) => {
      const ip = Object.keys(answers).find((candidate) => url.includes(candidate));
      const index = url.includes("ipwhois") ? 1 : url.includes("ip2location") ? 2 : 0;

      return ip ? answers[ip][index] : undefined;
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        const place = pick(url);

        if (!place) {
          return new Response(JSON.stringify({ status: "fail", success: false }));
        }

        if (url.includes("ipwhois")) {
          return new Response(
            JSON.stringify({ success: true, city: place.city, country_code: place.country, latitude: place.lat, longitude: place.lon })
          );
        }

        if (url.includes("ip2location")) {
          return new Response(
            JSON.stringify({ country_code: place.country, city_name: place.city, latitude: place.lat, longitude: place.lon })
          );
        }

        return new Response(
          JSON.stringify({
            status: "success",
            countryCode: place.country,
            country: place.country,
            city: place.city,
            lat: place.lat,
            lon: place.lon,
            as: "AS12956 TELXIUS"
          })
        );
      })
    );

    const hops = await enrichHopsWithGeo({
      hops: (
        [
          ["176.52.248.132", 445],
          ["94.142.127.65", 271],
          ["84.16.15.66", 276],
          ["170.79.213.109", 435]
        ] as const
      ).map(([ip, rttMs], index) => ({
        hopNumber: index + 9,
        ip,
        hostname: `r${index}.example.net`,
        rttMs,
        status: "ok" as const
      }))
    });

    // The majority answer loses to the route: New York is unreachable 5 ms after Madrid.
    expect(hops[2].city).toBe("Madrid");
    const trail = hops[2].locationEvidence?.join(" ") ?? "";
    expect(trail).toContain("Dropped New York City");
    expect(trail).toContain("Placed here instead");
    // Relocation is a demotion, never a promotion.
    expect(hops[2].locationConfidence).not.toBe("high");
    // The hops that were never contradicted keep exactly what the databases said.
    expect(hops.map((hop) => hop.city)).toEqual(["Madrid", "Madrid", "Madrid", "Sao Paulo"]);
  });

  it("trusts the country and site code in a router's name over a registration address", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://ipapi.example.test";
    process.env.IPWHOIS_URL = "https://ipwhois.example.test";
    process.env.IP2LOCATION_URL = "https://ip2location.example.test/";
    process.env.IP2LOCATION_API_KEY = "test-key";

    // Liberty Global names its routers "us-mia01a" / "de-fra11b" but registers every block
    // in the Netherlands, so all three databases answer Schiphol for the whole run. The MPLS
    // tunnel also gives Miami and Frankfurt the same RTT, which used to get Miami erased.
    const SCHIPHOL = { city: "Schiphol-Rijk", country: "NL", lat: 52.2933, lon: 4.7566 };
    const FRANKFURT = { city: "Frankfurt am Main", country: "DE", lat: 50.1109, lon: 8.6821 };
    const byIp: Record<string, typeof SCHIPHOL> = {
      "84.116.133.114": SCHIPHOL,
      "84.116.130.106": SCHIPHOL,
      "84.116.137.174": SCHIPHOL,
      "212.227.117.208": FRANKFURT,
      "217.72.199.4": FRANKFURT
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        const place = Object.entries(byIp).find(([ip]) => url.includes(ip))?.[1];

        if (!place) {
          return new Response(JSON.stringify({ status: "fail", success: false }));
        }

        if (url.includes("ipwhois")) {
          return new Response(JSON.stringify({ success: true, city: place.city, country_code: place.country, latitude: place.lat, longitude: place.lon }));
        }

        if (url.includes("ip2location")) {
          return new Response(JSON.stringify({ country_code: place.country, city_name: place.city, latitude: place.lat, longitude: place.lon }));
        }

        return new Response(JSON.stringify({ status: "success", countryCode: place.country, country: place.country, city: place.city, lat: place.lat, lon: place.lon, as: "AS6830 LGI-UPC" }));
      })
    );

    const hops = await enrichHopsWithGeo({
      source: { provider: "globalping", city: "Suwon", country: "KR", latitude: 37.26, longitude: 127.03 } as never,
      hops: (
        [
          ["84.116.133.114", "us-mia01a-rd1-ae-4-0.aorta.net", 317],
          ["84.116.130.106", "de-fra11b-rc1-ae-20-0.aorta.net", 312],
          ["84.116.137.174", "de-fra02a-rb1-ae-1-0.aorta.net", 316],
          ["212.227.117.208", "lo-0-0.rc-a.bap.rhr.de.net.ionos.com", 298],
          ["217.72.199.4", "gmx.net", 300]
        ] as const
      ).map(([ip, hostname, rttMs], index) => ({ hopNumber: index + 14, ip, hostname, rttMs, status: "ok" as const }))
    });

    expect(hops[0].city).toBe("Miami");
    expect(hops[1].city).toMatch(/Frankfurt/);
    expect(hops[3].city).toBe("Karlsruhe");
    expect(hops.map((hop) => hop.city)).not.toContain("Schiphol-Rijk");
  });

  it("reads verified carrier site codes and treats AS0 as no ASN", async () => {
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.GEOIP_SECONDARY = "none";
    process.env.IP_API_URL = "https://geo.example.test";

    // The database answers Tokyo for an Osaka router (400 km off) with the reserved AS0 that
    // peering LANs get handed; the operator's own naming has to win, and AS0 must not be a hop
    // in the AS path.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) =>
        new Response(
          String(input).includes("210.130.16.25")
            ? JSON.stringify({ status: "success", countryCode: "JP", country: "JP", city: "Chiyoda City", lat: 35.694, lon: 139.7536, as: "AS0 LINX Peer" })
            : JSON.stringify({ status: "fail" })
        )
      )
    );

    const hops = await enrichHopsWithGeo({
      hops: (
        [
          ["210.130.16.25", "osk008agr02.iij.net", 253],
          ["206.148.24.67", "e3-9.ty-eqxty2-bb4.globalsecurelayer.com", 67],
          ["129.250.2.54", "ae-3.r24.miamfl02.us.bb.gin.ntt.net", 283],
          ["62.115.139.32", "nyk-bb5-link.ip.twelve99.net", 152]
        ] as const
      ).map(([ip, hostname, rttMs], index) => ({ hopNumber: index + 1, ip, hostname, rttMs, status: "ok" as const }))
    });

    expect(hops.map((hop) => hop.city)).toEqual(["Osaka", "Tokyo", "Miami", "New York"]);
    expect(hops[0].asn).toBeUndefined();
  });

  it("keeps a full answer for a day but re-asks within an hour when a source was missing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T09:00:00Z"));
    process.env.GEOIP_PROVIDER = "ip-api";
    process.env.IP_API_URL = "https://ipapi.example.test";
    process.env.IPWHOIS_URL = "https://ipwhois.example.test";

    // ipwho.is has spent its daily quota; ip-api still answers. Two sources are expected.
    let whoisQuotaSpent = true;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);

      if (url.includes("ipwhois")) {
        return whoisQuotaSpent
          ? new Response(JSON.stringify({ success: false, message: "Rate limit exceeded" }), { status: 429 })
          : new Response(JSON.stringify({ success: true, city: "Seoul", country_code: "KR", latitude: 37.5665, longitude: 126.978 }));
      }

      return new Response(JSON.stringify({ status: "success", countryCode: "KR", country: "KR", city: "Seoul", lat: 37.5665, lon: 126.978 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const ipApiCalls = () => fetchMock.mock.calls.filter((call) => String(call[0]).includes("ipapi")).length;
    // A real public address: documentation ranges like 203.0.113.0/24 are filtered before any lookup.
    const lookup = () => enrichHopsWithGeo({ hops: [{ hopNumber: 1, ip: "1.1.1.1", hostname: "r1.example.net", rttMs: 20, status: "ok" }] });

    await lookup();
    expect(ipApiCalls()).toBe(1);

    // Ten minutes later the partial answer is still served from cache.
    vi.setSystemTime(new Date("2026-09-05T09:10:00Z"));
    await lookup();
    expect(ipApiCalls()).toBe(1);

    // An hour on, it is asked again - and this time both sources answer.
    whoisQuotaSpent = false;
    vi.setSystemTime(new Date("2026-09-05T10:01:00Z"));
    await lookup();
    expect(ipApiCalls()).toBe(2);

    // That complete answer now holds for the rest of the day.
    vi.setSystemTime(new Date("2026-09-05T20:00:00Z"));
    await lookup();
    expect(ipApiCalls()).toBe(2);

    vi.useRealTimers();
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
