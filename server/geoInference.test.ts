import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichHopsWithGeo, resolveGeoProvider } from "./geoInference";

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
});
