import { isIP } from "node:net";
import { reverse } from "node:dns/promises";
import type {
  Confidence,
  HopLocationPrecision,
  HopLocationSource,
  HopResult,
  MeasurementSource
} from "../shared/types";
import {
  asnDigitsFromText,
  compactWhitespace,
  isAsciiDigit,
  isWhitespace,
  splitBySeparator
} from "./textParsing";

type GeoSource = Exclude<HopLocationSource, "source_probe" | "unknown">;
type GeoProvider = "none" | "ipinfo" | "ip-api";

interface GeoPoint {
  city: string;
  country: string;
  latitude: number;
  longitude: number;
}

interface GeoCandidate extends GeoPoint {
  confidence: Confidence;
  evidence: string[];
  precision: HopLocationPrecision;
  source: GeoSource;
}

interface IpGeoRecord {
  asName?: string;
  asn?: string;
  city?: string;
  country?: string;
  hostname?: string;
  latitude?: number;
  longitude?: number;
}

const GEO_TIMEOUT_MS = Number(process.env.GEOIP_TIMEOUT_MS ?? 1_400);
const REVERSE_DNS_TIMEOUT_MS = Number(process.env.REVERSE_DNS_TIMEOUT_MS ?? 900);
const geoCache = new Map<string, Promise<IpGeoRecord | undefined>>();
const reverseCache = new Map<string, Promise<string | undefined>>();

const cityHints: Array<GeoPoint & { aliases: string[] }> = [
  { city: "Seoul", country: "KR", latitude: 37.5665, longitude: 126.978, aliases: ["seoul", "sel", "icn"] },
  { city: "Tokyo", country: "JP", latitude: 35.6762, longitude: 139.6503, aliases: ["tokyo", "tyo", "nrt", "hnd", "jtha"] },
  { city: "Osaka", country: "JP", latitude: 34.6937, longitude: 135.5023, aliases: ["osaka", "osa", "kix"] },
  { city: "Hong Kong", country: "HK", latitude: 22.3193, longitude: 114.1694, aliases: ["hongkong", "hong-kong", "hkg", "hkth"] },
  { city: "Taipei", country: "TW", latitude: 25.033, longitude: 121.5654, aliases: ["taipei", "tpe"] },
  { city: "Singapore", country: "SG", latitude: 1.3521, longitude: 103.8198, aliases: ["singapore", "sin", "sgp"] },
  { city: "Sydney", country: "AU", latitude: -33.8688, longitude: 151.2093, aliases: ["sydney", "syd", "ksyd"] },
  { city: "Melbourne", country: "AU", latitude: -37.8136, longitude: 144.9631, aliases: ["melbourne", "mel"] },
  { city: "Frankfurt", country: "DE", latitude: 50.1109, longitude: 8.6821, aliases: ["frankfurt", "fra", "rhr", "kae"] },
  { city: "Amsterdam", country: "NL", latitude: 52.3676, longitude: 4.9041, aliases: ["amsterdam", "ams"] },
  { city: "London", country: "GB", latitude: 51.5072, longitude: -0.1276, aliases: ["london", "lon", "lhr", "lgw", "ulhc"] },
  { city: "Paris", country: "FR", latitude: 48.8566, longitude: 2.3522, aliases: ["paris", "par", "cdg"] },
  { city: "Warsaw", country: "PL", latitude: 52.2297, longitude: 21.0122, aliases: ["warsaw", "waw"] },
  { city: "New York", country: "US", latitude: 40.7128, longitude: -74.006, aliases: ["newyork", "new-york", "nyc", "jfk", "ewr"] },
  { city: "Ashburn", country: "US", latitude: 39.0438, longitude: -77.4874, aliases: ["ashburn", "iad", "iad1"] },
  { city: "Chicago", country: "US", latitude: 41.8781, longitude: -87.6298, aliases: ["chicago", "chi", "ord"] },
  { city: "Dallas", country: "US", latitude: 32.7767, longitude: -96.797, aliases: ["dallas", "dfw", "dal"] },
  { city: "Los Angeles", country: "US", latitude: 34.0522, longitude: -118.2437, aliases: ["losangeles", "los-angeles", "lax"] },
  { city: "San Jose", country: "US", latitude: 37.3382, longitude: -121.8863, aliases: ["sanjose", "san-jose", "sjc"] },
  { city: "San Francisco", country: "US", latitude: 37.7749, longitude: -122.4194, aliases: ["sanfrancisco", "san-francisco", "sfo"] },
  { city: "Seattle", country: "US", latitude: 47.6062, longitude: -122.3321, aliases: ["seattle", "sea"] }
];

const metroAreas: Array<GeoPoint & { key: string; cities: string[]; radiusKm: number; rttMs: number }> = [
  {
    key: "seoul-metro",
    city: "Seoul metro",
    country: "KR",
    latitude: 37.5665,
    longitude: 126.978,
    radiusKm: 85,
    rttMs: 28,
    cities: [
      "seoul",
      "incheon",
      "bucheon",
      "gimpo",
      "gwangmyeong",
      "anyang",
      "gwacheon",
      "gunpo",
      "uiwang",
      "suwon",
      "seongnam",
      "bundang",
      "hanam",
      "guri",
      "namyangju",
      "yongin",
      "goyang",
      "paju",
      "uijeongbu"
    ]
  },
  {
    key: "tokyo-metro",
    city: "Tokyo metro",
    country: "JP",
    latitude: 35.6762,
    longitude: 139.6503,
    radiusKm: 80,
    rttMs: 24,
    cities: ["tokyo", "yokohama", "kawasaki", "saitama", "chiba"]
  },
  {
    key: "hong-kong-metro",
    city: "Hong Kong",
    country: "HK",
    latitude: 22.3193,
    longitude: 114.1694,
    radiusKm: 45,
    rttMs: 18,
    cities: ["hong kong", "hongkong", "kowloon", "wan chai", "central", "tsuen wan", "new territories"]
  },
  {
    key: "frankfurt-metro",
    city: "Frankfurt metro",
    country: "DE",
    latitude: 50.1109,
    longitude: 8.6821,
    radiusKm: 95,
    rttMs: 24,
    cities: ["frankfurt", "karlsruhe", "rüsselsheim", "ruesselsheim", "offenbach", "mainz", "wiesbaden"]
  }
];

const cityDistrictAliases: Array<GeoPoint & { aliases: string[] }> = [
  {
    city: "Hong Kong",
    country: "HK",
    latitude: 22.3193,
    longitude: 114.1694,
    aliases: ["wan chai", "central", "kowloon", "tsuen wan", "new territories"]
  }
];

function timeoutSignal(ms: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);

  return {
    signal: controller.signal,
    done: () => clearTimeout(timeout)
  };
}

function isHostnameTokenSeparator(value: string) {
  return value === "." || value === "_" || value === "-" || isWhitespace(value) || value === "(" || value === ")";
}

function splitHostnameTokens(value: string) {
  return splitBySeparator(value, isHostnameTokenSeparator);
}

function normalizeAsn(value?: string) {
  if (!value) {
    return undefined;
  }

  const asnDigits = asnDigitsFromText(value);

  return asnDigits ? `AS${asnDigits}` : undefined;
}

function removeLeadingTrailingDigits(value: string) {
  let startIndex = 0;
  let endIndex = value.length;

  while (startIndex < endIndex && isAsciiDigit(value[startIndex])) {
    startIndex += 1;
  }

  while (endIndex > startIndex && isAsciiDigit(value[endIndex - 1])) {
    endIndex -= 1;
  }

  return value.slice(startIndex, endIndex);
}

function stripAsPrefix(value?: string) {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trimStart();

  if (!trimmed.toUpperCase().startsWith("AS")) {
    return value;
  }

  let endIndex = 2;

  while (endIndex < trimmed.length && isAsciiDigit(trimmed[endIndex])) {
    endIndex += 1;
  }

  if (endIndex === 2 || trimmed[endIndex] !== " ") {
    return value;
  }

  return trimmed.slice(endIndex).trimStart();
}

function trimTrailingPathSlash(value: string) {
  let endIndex = value.length;

  while (endIndex > 0 && value[endIndex - 1] === "/") {
    endIndex -= 1;
  }

  return value.slice(0, endIndex);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function ipv4Octets(ip: string) {
  const octets = ip.split(".").map(Number);

  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : undefined;
}

function isPublicIp(ip?: string): ip is string {
  if (!ip || isIP(ip) !== 4) {
    return false;
  }

  const octets = ipv4Octets(ip);

  if (!octets) {
    return false;
  }

  const [a, b, c] = octets;

  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function tokeniseHostname(hostname: string) {
  return splitHostnameTokens(hostname.toLowerCase()).map(removeLeadingTrailingDigits).filter(Boolean);
}

function aliasMatchesHostname(alias: string, normalizedHost: string, tokens: string[]) {
  const compactAlias = alias.replaceAll("-", "");
  const tokenMatch = tokens.some((token) => {
    if (token === alias || token === compactAlias) {
      return true;
    }

    return alias.length >= 4 && (token.endsWith(alias) || token.endsWith(compactAlias));
  });

  if (tokenMatch) {
    return true;
  }

  if (alias.length < 5) {
    return false;
  }

  return normalizedHost.includes(alias) || normalizedHost.includes(compactAlias);
}

function inferCityFromHostname(hostname?: string): GeoCandidate | undefined {
  if (!hostname) {
    return undefined;
  }

  const normalizedHost = compactWhitespace(hostname.toLowerCase());
  const tokens = tokeniseHostname(hostname);

  for (const city of cityHints) {
    const matchedAlias = city.aliases.find((alias) => aliasMatchesHostname(alias, normalizedHost, tokens));

    if (matchedAlias) {
      return {
        ...city,
        confidence: "high",
        evidence: [`reverse DNS matched "${matchedAlias}" in ${hostname}`],
        precision: "city",
        source: "reverse_dns"
      };
    }
  }

  return undefined;
}

function cityFromProvider(hop: HopResult): GeoCandidate | undefined {
  if (
    typeof hop.latitude === "number" &&
    Number.isFinite(hop.latitude) &&
    typeof hop.longitude === "number" &&
    Number.isFinite(hop.longitude) &&
    hop.city
  ) {
    return {
      city: hop.city,
      country: hop.country ?? "Unknown",
      latitude: hop.latitude,
      longitude: hop.longitude,
      confidence: "high",
      evidence: ["provider supplied hop coordinates"],
      precision: "city",
      source: "provider"
    };
  }

  if (!hop.city && !hop.country) {
    return undefined;
  }

  const city = cityHints.find((hint) => {
    const cityMatches = hop.city ? hint.city.toLowerCase() === hop.city.toLowerCase() : false;
    const countryMatches = hop.country ? hint.country.toLowerCase() === hop.country.toLowerCase() : true;

    return cityMatches && countryMatches;
  });

  if (!city) {
    return undefined;
  }

  return {
    ...city,
    confidence: "medium",
    evidence: ["provider supplied hop city/country"],
    precision: "city",
    source: "provider"
  };
}

async function reverseDns(ip?: string) {
  if (!isPublicIp(ip)) {
    return undefined;
  }

  const publicIp = ip;

  if (!reverseCache.has(publicIp)) {
    reverseCache.set(
      publicIp,
      Promise.race([
        reverse(publicIp).then((hosts) => hosts[0]),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), REVERSE_DNS_TIMEOUT_MS))
      ]).catch(() => undefined)
    );
  }

  return reverseCache.get(publicIp);
}

async function fetchIpInfo(ip: string): Promise<IpGeoRecord | undefined> {
  const token = process.env.IPINFO_TOKEN;

  if (!token) {
    return undefined;
  }

  const timer = timeoutSignal(GEO_TIMEOUT_MS);

  try {
    const response = await fetch(`https://ipinfo.io/${ip}/json?token=${encodeURIComponent(token)}`, {
      signal: timer.signal,
      headers: { accept: "application/json" }
    });

    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as Record<string, unknown>;
    const loc = typeof data.loc === "string" ? data.loc.split(",").map(Number) : [];
    const org = typeof data.org === "string" ? data.org : undefined;

    return {
      asn: normalizeAsn(org),
      asName: stripAsPrefix(org),
      city: typeof data.city === "string" ? data.city : undefined,
      country: typeof data.country === "string" ? data.country : undefined,
      hostname: typeof data.hostname === "string" ? data.hostname : undefined,
      latitude: Number.isFinite(loc[0]) ? loc[0] : undefined,
      longitude: Number.isFinite(loc[1]) ? loc[1] : undefined
    };
  } catch {
    return undefined;
  } finally {
    timer.done();
  }
}

function countryFromIpApi(data: Record<string, unknown>) {
  if (typeof data.countryCode === "string") {
    return data.countryCode;
  }

  if (typeof data.country === "string") {
    return data.country;
  }

  return undefined;
}

async function fetchIpApi(ip: string): Promise<IpGeoRecord | undefined> {
  const configuredUrl = process.env.IP_API_URL?.trim();

  if (!configuredUrl) {
    return undefined;
  }

  const timer = timeoutSignal(GEO_TIMEOUT_MS);

  try {
    const fields = "status,message,country,countryCode,city,lat,lon,as,asname,reverse,query";
    const url = new URL(configuredUrl);
    url.pathname = `${trimTrailingPathSlash(url.pathname)}/json/${encodeURIComponent(ip)}`;
    url.searchParams.set("fields", fields);

    const response = await fetch(url, {
      signal: timer.signal,
      headers: { accept: "application/json" }
    });

    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (data.status !== "success") {
      return undefined;
    }

    const asText = typeof data.as === "string" ? data.as : undefined;

    return {
      asn: normalizeAsn(asText),
      asName: typeof data.asname === "string" ? data.asname : stripAsPrefix(asText),
      city: typeof data.city === "string" ? data.city : undefined,
      country: countryFromIpApi(data),
      hostname: typeof data.reverse === "string" ? data.reverse : undefined,
      latitude: finite(data.lat),
      longitude: finite(data.lon)
    };
  } catch {
    return undefined;
  } finally {
    timer.done();
  }
}

export function resolveGeoProvider(env: NodeJS.ProcessEnv = process.env): GeoProvider {
  if (env.GEOIP_PROVIDER === "none" || env.GEOIP_PROVIDER === "ipinfo" || env.GEOIP_PROVIDER === "ip-api") {
    return env.GEOIP_PROVIDER;
  }

  return env.IPINFO_TOKEN ? "ipinfo" : "none";
}

async function lookupIpGeo(ip?: string) {
  if (!isPublicIp(ip)) {
    return undefined;
  }

  const publicIp = ip;

  if (!geoCache.has(publicIp)) {
    const provider = resolveGeoProvider();

    geoCache.set(
      publicIp,
      (async () => {
        if (provider === "none") {
          return undefined;
        }

        if (provider === "ipinfo") {
          return fetchIpInfo(publicIp);
        }

        return fetchIpApi(publicIp);
      })()
    );
  }

  return geoCache.get(publicIp);
}

function geoCandidate(record?: IpGeoRecord): GeoCandidate | undefined {
  if (
    !record?.city ||
    !record.country ||
    typeof record.latitude !== "number" ||
    typeof record.longitude !== "number"
  ) {
    return undefined;
  }

  return {
    city: record.city,
    country: record.country,
    latitude: record.latitude,
    longitude: record.longitude,
    confidence: "medium",
    evidence: ["IP GeoIP database match"],
    precision: "city",
    source: "geoip"
  };
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function distanceKm(a: Pick<GeoPoint, "latitude" | "longitude">, b: Pick<GeoPoint, "latitude" | "longitude">) {
  const earthRadiusKm = 6371;
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const value =
    Math.sin(deltaLat / 2) ** 2 +
    Math.sin(deltaLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * earthRadiusKm * Math.asin(Math.sqrt(value));
}

function normalizeCityName(city?: string) {
  return city
    ?.toLowerCase()
    .replaceAll(".", " ")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .trim();
}

function normalizeCountryName(country?: string) {
  const normalized = country?.toLowerCase().trim();

  if (!normalized) {
    return undefined;
  }

  if (normalized === "hk" || normalized === "hong kong") {
    return "hk";
  }

  if (normalized === "kr" || normalized === "south korea" || normalized === "korea" || normalized === "republic of korea") {
    return "kr";
  }

  if (normalized === "jp" || normalized === "japan") {
    return "jp";
  }

  if (normalized === "tw" || normalized === "taiwan") {
    return "tw";
  }

  if (normalized === "sg" || normalized === "singapore") {
    return "sg";
  }

  if (normalized === "us" || normalized === "usa" || normalized === "united states") {
    return "us";
  }

  if (normalized === "gb" || normalized === "uk" || normalized === "united kingdom") {
    return "gb";
  }

  if (normalized === "de" || normalized === "germany") {
    return "de";
  }

  if (normalized === "au" || normalized === "australia") {
    return "au";
  }

  return normalized;
}

function normalizeKnownDistrict(point: GeoCandidate): GeoCandidate {
  const city = normalizeCityName(point.city);
  const district = cityDistrictAliases.find((candidate) => {
    if (!sameCountry(point.country, candidate.country)) {
      return false;
    }

    return Boolean(city && candidate.aliases.includes(city));
  });

  if (!district) {
    return point;
  }

  return {
    ...point,
    city: district.city,
    country: district.country,
    latitude: district.latitude,
    longitude: district.longitude,
    precision: point.precision === "exact" ? "city" : point.precision,
    evidence: [...point.evidence, `${point.city} normalized to ${district.city} metro for route readability`]
  };
}

function sameCountry(a?: string, b?: string) {
  const normalizedA = normalizeCountryName(a);
  const normalizedB = normalizeCountryName(b);

  return Boolean(normalizedA && normalizedB && normalizedA === normalizedB);
}

function metroForPoint(point: Pick<GeoPoint, "city" | "country" | "latitude" | "longitude">) {
  const city = normalizeCityName(point.city);

  return metroAreas.find((metro) => {
    if (!sameCountry(point.country, metro.country)) {
      return false;
    }

    if (city && metro.cities.includes(city)) {
      return true;
    }

    return distanceKm(point, metro) <= metro.radiusKm;
  });
}

function downgradeSameMetroPublicGeo(candidate: GeoCandidate, source?: GeoPoint, rttMs?: number): GeoCandidate {
  if (
    (candidate.source !== "geoip" && candidate.source !== "provider") ||
    !source ||
    typeof rttMs !== "number" ||
    !Number.isFinite(rttMs)
  ) {
    return candidate;
  }

  const sourceMetro = metroForPoint(source);
  const candidateMetro = metroForPoint(candidate);
  const sameMetro = sourceMetro?.key !== undefined && sourceMetro.key === candidateMetro?.key;

  if (!sameMetro || rttMs > sourceMetro.rttMs) {
    return candidate;
  }

  return {
    ...candidate,
    city: sourceMetro.city,
    country: sourceMetro.country,
    latitude: sourceMetro.latitude,
    longitude: sourceMetro.longitude,
    confidence: "medium",
    precision: "metro",
    evidence: [
      ...candidate.evidence,
      `Public geolocation is inside the same low-latency ${sourceMetro.city}; downgraded to metro-level estimate`
    ]
  };
}

function sourcePoint(source?: MeasurementSource): GeoPoint | undefined {
  if (
    source?.city &&
    source.country &&
    typeof source.latitude === "number" &&
    Number.isFinite(source.latitude) &&
    typeof source.longitude === "number" &&
    Number.isFinite(source.longitude)
  ) {
    return {
      city: source.city,
      country: source.country,
      latitude: source.latitude,
      longitude: source.longitude
    };
  }

  return undefined;
}

function passesRttSanity(candidate: GeoCandidate, source?: GeoPoint, rttMs?: number) {
  if (!source || typeof rttMs !== "number" || !Number.isFinite(rttMs) || rttMs <= 0) {
    return true;
  }

  const distance = distanceKm(source, candidate);
  const maxPlausibleDistance = Math.max(900, rttMs * 145);

  return distance <= maxPlausibleDistance;
}

function strongCityEvidence(candidate: GeoCandidate) {
  return candidate.source === "reverse_dns" || candidate.source === "combined";
}

function weakPublicGeoEvidence(candidate: GeoCandidate) {
  return candidate.source === "geoip" || candidate.source === "provider";
}

function conflictsWithStrongEvidence(candidate: GeoCandidate, candidates: GeoCandidate[]) {
  if (!weakPublicGeoEvidence(candidate)) {
    return false;
  }

  return candidates.some((strongCandidate) => {
    if (!strongCityEvidence(strongCandidate)) {
      return false;
    }

    const sameMetro = distanceKm(candidate, strongCandidate) < 120;

    if (sameMetro) {
      return false;
    }

    return !sameCountry(candidate.country, strongCandidate.country) || distanceKm(candidate, strongCandidate) > 320;
  });
}

function evidenceAgreementScore(candidate: GeoCandidate, candidates: GeoCandidate[]) {
  return candidates.reduce((score, other) => {
    if (other === candidate) {
      return score;
    }

    const distance = distanceKm(candidate, other);

    if (distance < 90) {
      return score + 12;
    }

    if (sameCountry(candidate.country, other.country)) {
      return score + 4;
    }

    return score;
  }, 0);
}

function rttSupportScore(candidate: GeoCandidate, source?: GeoPoint, rttMs?: number) {
  if (!source || typeof rttMs !== "number" || !Number.isFinite(rttMs) || rttMs <= 0) {
    return 0;
  }

  const distance = distanceKm(source, candidate);

  if (distance < 120 && rttMs <= 12) {
    return 12;
  }

  if (distance < 900 && rttMs <= 28) {
    return 8;
  }

  if (distance < 2_800 && rttMs <= 75) {
    return 5;
  }

  return 0;
}

function candidateScore(candidate: GeoCandidate, candidates: GeoCandidate[], source?: GeoPoint, rttMs?: number) {
  const confidenceScore: Record<Confidence, number> = {
    high: 30,
    medium: 20,
    low: 10
  };
  const sourceScore: Record<GeoSource, number> = {
    combined: 18,
    reverse_dns: 14,
    provider: 12,
    geoip: 8
  };

  return confidenceScore[candidate.confidence] + sourceScore[candidate.source] + evidenceAgreementScore(candidate, candidates) + rttSupportScore(candidate, source, rttMs);
}

function chooseCandidate(candidates: GeoCandidate[], source?: GeoPoint, rttMs?: number): GeoCandidate | undefined {
  const saneCandidates = candidates
    .map(normalizeKnownDistrict)
    .map((candidate) => downgradeSameMetroPublicGeo(candidate, source, rttMs))
    .filter((candidate) => passesRttSanity(candidate, source, rttMs));

  const filteredCandidates = saneCandidates.filter((candidate) => !conflictsWithStrongEvidence(candidate, saneCandidates));

  if (filteredCandidates.length === 0) {
    return undefined;
  }

  const reverseCandidate = filteredCandidates.find((candidate) => candidate.source === "reverse_dns");
  const geo = filteredCandidates.find((candidate) => candidate.source === "geoip");

  if (reverseCandidate && geo) {
    const sameMetro = distanceKm(reverseCandidate, geo) < 90;
    const sameCity = reverseCandidate.city.toLowerCase() === geo.city.toLowerCase();

    if (sameMetro || sameCity) {
      return {
        ...reverseCandidate,
        confidence: "high",
        evidence: [...reverseCandidate.evidence, ...geo.evidence],
        precision: reverseCandidate.precision,
        source: "combined"
      };
    }
  }

  return [...filteredCandidates].sort((a, b) => candidateScore(b, filteredCandidates, source, rttMs) - candidateScore(a, filteredCandidates, source, rttMs))[0];
}

async function enrichHop(hop: HopResult, source?: GeoPoint): Promise<HopResult> {
  const reversedHostname = hop.hostname ? undefined : await reverseDns(hop.ip);
  const hostname = hop.hostname ?? reversedHostname;
  const geo = await lookupIpGeo(hop.ip);
  const candidates = [
    cityFromProvider(hop),
    inferCityFromHostname(hostname),
    inferCityFromHostname(geo?.hostname),
    geoCandidate(geo)
  ].filter((candidate): candidate is GeoCandidate => Boolean(candidate));
  const location = chooseCandidate(candidates, source, hop.rttMs);

  if (!location) {
    return {
      ...hop,
      hostname,
      asn: hop.asn ?? geo?.asn,
      asName: hop.asName ?? geo?.asName,
      locationConfidence: "low",
      locationSource: "unknown",
      locationPrecision: "unknown",
      locationEvidence: ["No reliable city-level evidence found"]
    };
  }

  return {
    ...hop,
    hostname,
    asn: hop.asn ?? geo?.asn,
    asName: hop.asName ?? geo?.asName,
    city: location.city,
    country: location.country,
    latitude: location.latitude,
    longitude: location.longitude,
    locationConfidence: location.confidence,
    locationSource: location.source,
    locationPrecision: location.precision,
    locationEvidence: location.evidence
  };
}

async function mapWithConcurrency<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>) {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(values[currentIndex]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker())
  );

  return results;
}

export async function enrichHopsWithGeo(params: {
  hops: HopResult[];
  source?: MeasurementSource;
}) {
  const source = sourcePoint(params.source);

  return mapWithConcurrency(params.hops, 4, (hop) => enrichHop(hop, source));
}

export function measurementConfidence(hops: HopResult[]): Confidence {
  const located = hops.filter((hop) => typeof hop.latitude === "number" && typeof hop.longitude === "number");

  if (located.length === 0) {
    return "low";
  }

  const ratio = located.length / Math.max(hops.length, 1);
  const highCount = located.filter((hop) => hop.locationConfidence === "high").length;

  if (ratio >= 0.58 && highCount >= Math.ceil(located.length * 0.45)) {
    return "high";
  }

  if (ratio >= 0.28) {
    return "medium";
  }

  return "low";
}
