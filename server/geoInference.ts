import { readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { reverse } from "node:dns/promises";
import type {
  Confidence,
  HopLocationPrecision,
  HopLocationSource,
  HopResult,
  MeasurementSource
} from "../shared/types";
import { AIRPORT_CODES } from "./airportCodes";
import path from "node:path";
import {
  asnDigitsFromText,
  compactWhitespace,
  isAsciiDigit,
  isWhitespace,
  splitBySeparator
} from "./textParsing";

type GeoSource = Exclude<HopLocationSource, "source_probe" | "unknown" | "rtt_neighbor">;
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
  // What the network's own facility list says about this place; see peeringSupport.
  peering?: number;
}

// Where a network has documented a point of presence, from PeeringDB (facilities per
// AS, exported to peeringdbCities.json): a candidate city the network has a facility in
// is backed up, and a network with a few documented sites and none anywhere near the
// candidate is unlikely to be answering from there.
// PeeringDB's acceptable use policy allows its data for network troubleshooting but not
// passing it on in bulk, so the files built from it (`npm run data:refresh peeringdb`)
// live in server/data, outside the repository, and are read here when the server starts.
// Without them hop placement runs on the other evidence.
const PEERINGDB_DIR = process.env.PEERINGDB_DATA_DIR?.trim() || path.resolve(process.cwd(), "server/data");

function peeringDbFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path.join(PEERINGDB_DIR, file), "utf8")) as T;
  } catch {
    return fallback;
  }
}

const PEERING_SITES = peeringDbFile<Record<string, Array<[number, number, string, string]>>>("peeringdbCities.json", {});
const PEERING_NEAR_KM = 120;
const PEERING_FAR_KM = 400;
const PEERING_MIN_SITES = 3;

// Exchange points' peering LANs, from PeeringDB: an address inside one is a router port
// on that exchange, in that exchange's city - the surest placement there is short of the
// operator's own word in the router's name.
interface ExchangePrefix {
  start: number;
  end: number;
  prefix: string;
  name: string;
  city: string;
  country: string;
  latitude: number;
  longitude: number;
}

function ipv4ToInt(ip: string) {
  const octets = ip.split(".").map(Number);

  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? ((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]
    : undefined;
}

const EXCHANGE_PREFIXES: ExchangePrefix[] = peeringDbFile<{ prefixes: Array<[string, number, number, string, string, string]> }>("ixpPrefixes.json", { prefixes: [] }).prefixes
  .flatMap(([prefix, latitude, longitude, name, city, country]) => {
    const [base, bits] = prefix.split("/");
    const start = base.includes(".") ? ipv4ToInt(base) : undefined;

    return start === undefined || !city ? [] : [{ start, end: start + 2 ** (32 - Number(bits)) - 1, prefix, name, city, country, latitude, longitude }];
  })
  .sort((a, b) => a.start - b.start);

function exchangeFor(ip?: string): ExchangePrefix | undefined {
  const value = ip ? ipv4ToInt(ip) : undefined;

  if (value === undefined) {
    return undefined;
  }

  let low = 0;
  let high = EXCHANGE_PREFIXES.length - 1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const entry = EXCHANGE_PREFIXES[middle];

    if (value < entry.start) high = middle - 1;
    else if (value > entry.end) low = middle + 1;
    else return entry;
  }

  return undefined;
}

function exchangeCandidate(hop: HopResult): GeoCandidate | undefined {
  const exchange = exchangeFor(hop.ip);

  return exchange
    ? {
        city: exchange.city,
        country: exchange.country,
        latitude: exchange.latitude,
        longitude: exchange.longitude,
        confidence: "high",
        evidence: [`${hop.ip} is inside ${exchange.name}'s peering LAN (${exchange.prefix}), an exchange in ${exchange.city} (PeeringDB)`],
        precision: "city",
        source: "ixp"
      }
    : undefined;
}

// The network and the organisation behind an AS, as PeeringDB records them.
const NETWORKS = peeringDbFile<{ networks: Record<string, string[]> }>("asOrgs.json", { networks: {} }).networks;

// One line at startup saying whether the PeeringDB evidence is there.
export function peeringDbSummary() {
  const networks = Object.keys(PEERING_SITES).length;

  return networks > 0 ? `PeeringDB data: ${networks} networks with facilities, ${EXCHANGE_PREFIXES.length} exchange prefixes, ${Object.keys(NETWORKS).length} organisations` : `PeeringDB data not found in ${PEERINGDB_DIR}; hop placement runs without it (npm run data:refresh -- peeringdb)`;
}

function networkRecord(asn?: string) {
  const entry = asn ? NETWORKS[asn.replace(/^as/i, "")] : undefined;

  return entry ? { name: entry[0] || undefined, organisation: entry[1] || undefined } : undefined;
}

function peeringSupport(candidate: GeoCandidate, asn?: string): GeoCandidate {
  const sites = asn ? PEERING_SITES[asn.replace(/^as/i, "")] : undefined;

  if (!sites || sites.length === 0) {
    return candidate;
  }

  const nearest = sites
    .map(([latitude, longitude, city]) => ({ city, km: distanceKm(candidate, { latitude, longitude }) }))
    .sort((a, b) => a.km - b.km)[0];

  if (nearest.km <= PEERING_NEAR_KM) {
    return { ...candidate, peering: 10, evidence: [...candidate.evidence, `${asn} lists a facility in ${nearest.city} on PeeringDB`] };
  }

  if (sites.length >= PEERING_MIN_SITES && nearest.km > PEERING_FAR_KM) {
    return {
      ...candidate,
      peering: -12,
      evidence: [...candidate.evidence, `${asn} lists ${sites.length} facilities on PeeringDB and none within ${PEERING_FAR_KM} km of ${candidate.city}`]
    };
  }

  return candidate;
}

interface IpGeoRecord {
  database?: string;
  // RIPE IPmap's own confidence in its answer, and whether it rests on a measurement or a
  // geofeed rather than on reading the router's name.
  score?: number;
  measured?: boolean;
  asName?: string;
  asn?: string;
  city?: string;
  district?: string;
  regionName?: string;
  country?: string;
  hostname?: string;
  isp?: string;
  org?: string;
  hosting?: boolean;
  mobile?: boolean;
  proxy?: boolean;
  latitude?: number;
  longitude?: number;
}

const GEO_TIMEOUT_MS = Number(process.env.GEOIP_TIMEOUT_MS ?? 1_400);
const REVERSE_DNS_TIMEOUT_MS = Number(process.env.REVERSE_DNS_TIMEOUT_MS ?? 900);
const RTT_NEIGHBOR_TOLERANCE_MS = Number(process.env.RTT_NEIGHBOR_TOLERANCE_MS ?? 5);
const GEO_LOOKUP_CONCURRENCY = Number(process.env.GEO_LOOKUP_CONCURRENCY ?? 8);
// Light covers roughly 200 km per millisecond in fibre, so a millisecond of round-trip
// difference buys 100 km of one-way separation. Real long-haul paths measure a little under
// that, which leaves the constant deliberately generous.
const PATH_KM_PER_RTT_MS = Number(process.env.PATH_KM_PER_RTT_MS ?? 100);
// Slack for the padding a router adds generating its ICMP reply, which inflates that hop's RTT
// without moving the router. Measured routes put the useful window between 2,500 km (a real
// Tokyo hop answering 63 ms before Los Angeles) and 3,700 km (a Virginia registration address
// on a Los Angeles router, which has to stay catchable). Below that scale this check is blind:
// it settles which continent a hop is on, never which city inside one.
const PATH_RTT_SLACK_KM = Number(process.env.PATH_RTT_SLACK_KM ?? 3_000);
interface GeoCacheEntry {
  expiresAt: number;
  value: Promise<IpGeoRecord[]>;
}

// A backbone router does not move within a day, and the same routers show up on the way to
// most destinations, so a day of caching is what keeps the daily database budgets intact.
const GEO_CACHE_TTL_MS = Number(process.env.GEOIP_CACHE_TTL_MS ?? 24 * 60 * 60_000);
// An answer with a source missing (quota spent, timeout) is used now but not kept for the
// day: an hour later the missing database is asked again, so a bad hour does not decide a
// hop's evidence for the next 24.
const GEO_PARTIAL_CACHE_MS = Number(process.env.GEOIP_PARTIAL_CACHE_MS ?? 60 * 60_000);
const GEO_FAILURE_CACHE_MS = Number(process.env.GEOIP_FAILURE_CACHE_MS ?? 5 * 60_000);
const geoCache = new Map<string, GeoCacheEntry>();
const reverseCache = new Map<string, Promise<string | undefined>>();
// ponytail: one process-wide pause window; per-endpoint budgets only if this ever runs multi-instance.
let ipApiPausedUntil = 0;

export function resetGeoState() {
  geoCache.clear();
  reverseCache.clear();
  ipApiPausedUntil = 0;
  ipWhoIsPausedUntil = 0;
  ip2LocationPausedUntil = 0;
}

const cityHints: Array<GeoPoint & { aliases: string[]; domains?: string[] }> = [
  { city: "Seoul", country: "KR", latitude: 37.5665, longitude: 126.978, aliases: ["seoul", "sel", "icn"] },
  // Carrier site codes below (NTT "tokyjp", Equinix "eqxty", IIJ "osk", Telia "nyk"...) are the
  // ones verified against operator naming in bench/truth.json - nothing here is guessed.
  { city: "Tokyo", country: "JP", latitude: 35.6762, longitude: 139.6503, aliases: ["tokyo", "tyo", "nrt", "hnd", "jtha", "tokyjp", "eqxty"] },
  { city: "Osaka", country: "JP", latitude: 34.6937, longitude: 135.5023, aliases: ["osaka", "osa", "kix", "osk"] },
  { city: "Hong Kong", country: "HK", latitude: 22.3193, longitude: 114.1694, aliases: ["hongkong", "hong-kong", "hkg", "hkth"] },
  { city: "Taipei", country: "TW", latitude: 25.033, longitude: 121.5654, aliases: ["taipei", "tpe"] },
  { city: "Singapore", country: "SG", latitude: 1.3521, longitude: 103.8198, aliases: ["singapore", "sin", "sgp", "eqxsg"] },
  { city: "Sydney", country: "AU", latitude: -33.8688, longitude: 151.2093, aliases: ["sydney", "syd", "ksyd"] },
  { city: "Melbourne", country: "AU", latitude: -37.8136, longitude: 144.9631, aliases: ["melbourne", "mel"] },
  { city: "Frankfurt", country: "DE", latitude: 50.1109, longitude: 8.6821, aliases: ["frankfurt", "fra"] },
  // IONOS site codes for its Karlsruhe data centres (Rheinhafen, Baden-Airpark): 120 km from
  // Frankfurt, close enough to slip under the light-speed check, so the name has to say it.
  { city: "Karlsruhe", country: "DE", latitude: 49.0069, longitude: 8.4037, aliases: ["karlsruhe", "kae", "rhr", "bap"] },
  { city: "Amsterdam", country: "NL", latitude: 52.3676, longitude: 4.9041, aliases: ["amsterdam", "ams"] },
  { city: "London", country: "GB", latitude: 51.5072, longitude: -0.1276, aliases: ["london", "lon", "lhr", "lgw", "ulhc", "ldn", "londhx", "londpg"] },
  { city: "Paris", country: "FR", latitude: 48.8566, longitude: 2.3522, aliases: ["paris", "par", "cdg"] },
  { city: "Warsaw", country: "PL", latitude: 52.2297, longitude: 21.0122, aliases: ["warsaw", "waw"] },
  { city: "New York", country: "US", latitude: 40.7128, longitude: -74.006, aliases: ["newyork", "new-york", "nyc", "jfk", "ewr", "nyk"] },
  { city: "Newark", country: "US", latitude: 40.7357, longitude: -74.1724, aliases: ["newark", "nwrknj"] },
  { city: "Ashburn", country: "US", latitude: 39.0438, longitude: -77.4874, aliases: ["ashburn", "iad", "iad1"] },
  { city: "Chicago", country: "US", latitude: 41.8781, longitude: -87.6298, aliases: ["chicago", "chi", "ord", "chcgil", "eqxch"] },
  { city: "Dallas", country: "US", latitude: 32.7767, longitude: -96.797, aliases: ["dallas", "dfw", "dal", "dllstx"] },
  { city: "Los Angeles", country: "US", latitude: 34.0522, longitude: -118.2437, aliases: ["losangeles", "los-angeles", "lax", "lsanca"] },
  { city: "Miami", country: "US", latitude: 25.7617, longitude: -80.1918, aliases: ["miami", "miamfl"] },
  { city: "San Jose", country: "US", latitude: 37.3382, longitude: -121.8863, aliases: ["sanjose", "san-jose", "sjc", "snjsca"] },
  { city: "San Francisco", country: "US", latitude: 37.7749, longitude: -122.4194, aliases: ["sanfrancisco", "san-francisco", "sfo"] },
  { city: "Seattle", country: "US", latitude: 47.6062, longitude: -122.3321, aliases: ["seattle", "sea", "sttlwa", "drtsea"] },
  // Full city names the way backbone operators spell them into router names (Level 3
  // "Frankfurt1", Tata "pvu-paris", Telstra "sydney", Cogent "sofia"), which collide with
  // nothing, plus the site codes whose pattern is fixed across a carrier's whole network:
  // NTT's four letters of city and two of country (nycmny, frnkge), Arelion's three letters
  // (ffm, prs, hnk). Nothing three letters long that is also an airport elsewhere.
  { city: "Washington", country: "US", latitude: 38.9072, longitude: -77.0369, aliases: ["washington"] },
  { city: "Boston", country: "US", latitude: 42.3601, longitude: -71.0589, aliases: ["boston"] },
  { city: "Atlanta", country: "US", latitude: 33.749, longitude: -84.388, aliases: ["atlanta"] },
  { city: "Denver", country: "US", latitude: 39.7392, longitude: -104.9903, aliases: ["denver"] },
  { city: "Houston", country: "US", latitude: 29.7604, longitude: -95.3698, aliases: ["houston"] },
  { city: "Phoenix", country: "US", latitude: 33.4484, longitude: -112.074, aliases: ["phoenix"] },
  { city: "Philadelphia", country: "US", latitude: 39.9526, longitude: -75.1652, aliases: ["philadelphia"] },
  { city: "Toronto", country: "CA", latitude: 43.6532, longitude: -79.3832, aliases: ["toronto"] },
  { city: "Montreal", country: "CA", latitude: 45.5019, longitude: -73.5674, aliases: ["montreal"] },
  { city: "Vancouver", country: "CA", latitude: 49.2827, longitude: -123.1207, aliases: ["vancouver"] },
  { city: "Mexico City", country: "MX", latitude: 19.4326, longitude: -99.1332, aliases: ["mexico", "mexicocity"] },
  { city: "Sao Paulo", country: "BR", latitude: -23.5505, longitude: -46.6333, aliases: ["saopaulo", "sao-paulo"] },
  { city: "Rio de Janeiro", country: "BR", latitude: -22.9068, longitude: -43.1729, aliases: ["riodejaneiro", "rio-de-janeiro"] },
  { city: "Buenos Aires", country: "AR", latitude: -34.6037, longitude: -58.3816, aliases: ["buenosaires", "buenos-aires"] },
  { city: "Santiago", country: "CL", latitude: -33.4489, longitude: -70.6693, aliases: ["santiago"] },
  { city: "Bogota", country: "CO", latitude: 4.711, longitude: -74.0721, aliases: ["bogota"] },
  { city: "Lima", country: "PE", latitude: -12.0464, longitude: -77.0428, aliases: ["lima"] },
  { city: "Madrid", country: "ES", latitude: 40.4168, longitude: -3.7038, aliases: ["madrid"] },
  { city: "Barcelona", country: "ES", latitude: 41.3874, longitude: 2.1686, aliases: ["barcelona"] },
  { city: "Lisbon", country: "PT", latitude: 38.7223, longitude: -9.1393, aliases: ["lisbon", "lisboa"] },
  { city: "Marseille", country: "FR", latitude: 43.2965, longitude: 5.3698, aliases: ["marseille"] },
  { city: "Milan", country: "IT", latitude: 45.4642, longitude: 9.19, aliases: ["milan", "milano"] },
  { city: "Rome", country: "IT", latitude: 41.9028, longitude: 12.4964, aliases: ["rome", "roma"] },
  { city: "Zurich", country: "CH", latitude: 47.3769, longitude: 8.5417, aliases: ["zurich", "zuerich"] },
  { city: "Geneva", country: "CH", latitude: 46.2044, longitude: 6.1432, aliases: ["geneva", "geneve"] },
  { city: "Vienna", country: "AT", latitude: 48.2082, longitude: 16.3738, aliases: ["vienna", "wien"] },
  { city: "Munich", country: "DE", latitude: 48.1351, longitude: 11.582, aliases: ["munich", "muenchen"] },
  { city: "Hamburg", country: "DE", latitude: 53.5511, longitude: 9.9937, aliases: ["hamburg"] },
  { city: "Berlin", country: "DE", latitude: 52.52, longitude: 13.405, aliases: ["berlin"] },
  { city: "Dusseldorf", country: "DE", latitude: 51.2277, longitude: 6.7735, aliases: ["dusseldorf", "duesseldorf"] },
  { city: "Brussels", country: "BE", latitude: 50.8503, longitude: 4.3517, aliases: ["brussels", "bruxelles"] },
  { city: "Luxembourg", country: "LU", latitude: 49.6116, longitude: 6.1319, aliases: ["luxembourg"] },
  { city: "Dublin", country: "IE", latitude: 53.3498, longitude: -6.2603, aliases: ["dublin"] },
  { city: "Manchester", country: "GB", latitude: 53.4808, longitude: -2.2426, aliases: ["manchester"] },
  { city: "Stockholm", country: "SE", latitude: 59.3293, longitude: 18.0686, aliases: ["stockholm"] },
  { city: "Copenhagen", country: "DK", latitude: 55.6761, longitude: 12.5683, aliases: ["copenhagen", "kobenhavn"] },
  { city: "Oslo", country: "NO", latitude: 59.9139, longitude: 10.7522, aliases: ["oslo"] },
  { city: "Helsinki", country: "FI", latitude: 60.1699, longitude: 24.9384, aliases: ["helsinki"] },
  { city: "Prague", country: "CZ", latitude: 50.0755, longitude: 14.4378, aliases: ["prague", "praha"] },
  { city: "Budapest", country: "HU", latitude: 47.4979, longitude: 19.0402, aliases: ["budapest"] },
  { city: "Bucharest", country: "RO", latitude: 44.4268, longitude: 26.1025, aliases: ["bucharest", "bucuresti"] },
  { city: "Sofia", country: "BG", latitude: 42.6977, longitude: 23.3219, aliases: ["sofia"] },
  { city: "Athens", country: "GR", latitude: 37.9838, longitude: 23.7275, aliases: ["athens"] },
  { city: "Istanbul", country: "TR", latitude: 41.0082, longitude: 28.9784, aliases: ["istanbul"] },
  { city: "Moscow", country: "RU", latitude: 55.7558, longitude: 37.6173, aliases: ["moscow", "moskva"] },
  { city: "Kyiv", country: "UA", latitude: 50.4501, longitude: 30.5234, aliases: ["kyiv", "kiev"] },
  { city: "Dubai", country: "AE", latitude: 25.2048, longitude: 55.2708, aliases: ["dubai"] },
  { city: "Doha", country: "QA", latitude: 25.2854, longitude: 51.531, aliases: ["doha"] },
  { city: "Riyadh", country: "SA", latitude: 24.7136, longitude: 46.6753, aliases: ["riyadh"] },
  { city: "Tel Aviv", country: "IL", latitude: 32.0853, longitude: 34.7818, aliases: ["telaviv", "tel-aviv"] },
  { city: "Cairo", country: "EG", latitude: 30.0444, longitude: 31.2357, aliases: ["cairo"] },
  { city: "Johannesburg", country: "ZA", latitude: -26.2041, longitude: 28.0473, aliases: ["johannesburg"] },
  { city: "Cape Town", country: "ZA", latitude: -33.9249, longitude: 18.4241, aliases: ["capetown", "cape-town"] },
  { city: "Nairobi", country: "KE", latitude: -1.2921, longitude: 36.8219, aliases: ["nairobi"] },
  { city: "Lagos", country: "NG", latitude: 6.5244, longitude: 3.3792, aliases: ["lagos"] },
  { city: "Mumbai", country: "IN", latitude: 19.076, longitude: 72.8777, aliases: ["mumbai", "bombay"] },
  { city: "Chennai", country: "IN", latitude: 13.0827, longitude: 80.2707, aliases: ["chennai"] },
  { city: "New Delhi", country: "IN", latitude: 28.6139, longitude: 77.209, aliases: ["delhi", "newdelhi"] },
  { city: "Bangalore", country: "IN", latitude: 12.9716, longitude: 77.5946, aliases: ["bangalore", "bengaluru"] },
  { city: "Bangkok", country: "TH", latitude: 13.7563, longitude: 100.5018, aliases: ["bangkok"] },
  { city: "Kuala Lumpur", country: "MY", latitude: 3.139, longitude: 101.6869, aliases: ["kualalumpur", "kuala-lumpur"] },
  { city: "Jakarta", country: "ID", latitude: -6.2088, longitude: 106.8456, aliases: ["jakarta"] },
  { city: "Manila", country: "PH", latitude: 14.5995, longitude: 120.9842, aliases: ["manila"] },
  { city: "Hanoi", country: "VN", latitude: 21.0278, longitude: 105.8342, aliases: ["hanoi"] },
  { city: "Ho Chi Minh City", country: "VN", latitude: 10.8231, longitude: 106.6297, aliases: ["hochiminh", "saigon"] },
  { city: "Busan", country: "KR", latitude: 35.1796, longitude: 129.0756, aliases: ["busan", "pusan"] },
  { city: "Nagoya", country: "JP", latitude: 35.1815, longitude: 136.9066, aliases: ["nagoya"] },
  { city: "Fukuoka", country: "JP", latitude: 33.5902, longitude: 130.4017, aliases: ["fukuoka"] },
  { city: "Kaohsiung", country: "TW", latitude: 22.6273, longitude: 120.3014, aliases: ["kaohsiung"] },
  { city: "Perth", country: "AU", latitude: -31.9505, longitude: 115.8605, aliases: ["perth"] },
  { city: "Brisbane", country: "AU", latitude: -27.4698, longitude: 153.0251, aliases: ["brisbane"] },
  { city: "Adelaide", country: "AU", latitude: -34.9285, longitude: 138.6007, aliases: ["adelaide"] },
  { city: "Auckland", country: "NZ", latitude: -36.8509, longitude: 174.7645, aliases: ["auckland"] },
  // NTT names its routers with four letters of city and two of country, in its own domain.
  { city: "New York", country: "US", latitude: 40.7128, longitude: -74.006, aliases: ["nycmny"], domains: ["ntt.net"] },
  { city: "Ashburn", country: "US", latitude: 39.0438, longitude: -77.4874, aliases: ["ashbva", "asbnva"], domains: ["ntt.net"] },
  { city: "Frankfurt", country: "DE", latitude: 50.1109, longitude: 8.6821, aliases: ["frnkge"], domains: ["ntt.net"] },
  { city: "London", country: "GB", latitude: 51.5072, longitude: -0.1276, aliases: ["londen"], domains: ["ntt.net"] },
  { city: "Amsterdam", country: "NL", latitude: 52.3676, longitude: 4.9041, aliases: ["amstnl"], domains: ["ntt.net"] },
  { city: "Paris", country: "FR", latitude: 48.8566, longitude: 2.3522, aliases: ["parsfr"], domains: ["ntt.net"] },
  { city: "Singapore", country: "SG", latitude: 1.3521, longitude: 103.8198, aliases: ["sngpsi"], domains: ["ntt.net"] },
  { city: "Sydney", country: "AU", latitude: -33.8688, longitude: 151.2093, aliases: ["sydnau"], domains: ["ntt.net"] },
  { city: "Madrid", country: "ES", latitude: 40.4168, longitude: -3.7038, aliases: ["mdrdsp"], domains: ["ntt.net"] },
  { city: "Milan", country: "IT", latitude: 45.4642, longitude: 9.19, aliases: ["mlanit"], domains: ["ntt.net"] },
  // Arelion (Telia Carrier) names its routers with three letters, in its own domain; "sjo"
  // is its San Jose, not Costa Rica's airport, so the scope matters.
  { city: "Frankfurt", country: "DE", latitude: 50.1109, longitude: 8.6821, aliases: ["ffm"], domains: ["twelve99.net"] },
  { city: "Paris", country: "FR", latitude: 48.8566, longitude: 2.3522, aliases: ["prs"], domains: ["twelve99.net"] },
  { city: "Amsterdam", country: "NL", latitude: 52.3676, longitude: 4.9041, aliases: ["adm"], domains: ["twelve99.net"] },
  { city: "Singapore", country: "SG", latitude: 1.3521, longitude: 103.8198, aliases: ["sng"], domains: ["twelve99.net"] },
  { city: "Hong Kong", country: "HK", latitude: 22.3193, longitude: 114.1694, aliases: ["hnk"], domains: ["twelve99.net"] },
  { city: "Tokyo", country: "JP", latitude: 35.6762, longitude: 139.6503, aliases: ["tky"], domains: ["twelve99.net"] },
  { city: "Dallas", country: "US", latitude: 32.7767, longitude: -96.797, aliases: ["dls"], domains: ["twelve99.net"] },
  { city: "Ashburn", country: "US", latitude: 39.0438, longitude: -77.4874, aliases: ["ash"], domains: ["twelve99.net"] },
  { city: "San Jose", country: "US", latitude: 37.3382, longitude: -121.8863, aliases: ["sjo"], domains: ["twelve99.net"] }
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

  // Site suffixes come as digits plus one letter ("us-mia01a", "de-fra11b"); the letter has
  // to go first or the digits behind it never get stripped and the code stays hidden.
  if (endIndex - startIndex >= 2 && !isAsciiDigit(value[endIndex - 1]) && isAsciiDigit(value[endIndex - 2])) {
    endIndex -= 1;
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
  return (
    splitHostnameTokens(hostname.toLowerCase())
      // "osk008agr02" carries its city code in front of a numbered role. Split on the digit
      // runs as well, and keep the whole token so codes written as "dllstx14" still match.
      .flatMap((token) => [token, ...splitBySeparator(token, isAsciiDigit)])
      .map(removeLeadingTrailingDigits)
      .filter(Boolean)
  );
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

// National research and education networks name their routers after their own points of
// presence, so the name is the operator saying where the router stands. Every code below
// comes from a traceroute captured for this project or from CAIDA's published router
// naming conventions; none is guessed. A code counts only inside its own network's domain,
// so two and three letter codes can never leak into another operator's names, and the
// earliest code in a name wins because a router is named for its own site before the far
// end of the link it carries.
interface ResearchSite extends GeoPoint {
  network: string;
  domains: string[];
  // A whole token once digits are stripped: "csp2" is "csp".
  codes?: string[];
  // The start of a token: Jisc writes London as "londpg", "londtt", "londhx".
  prefixes?: string[];
  // The label right before the domain, where the network puts the site there: GARR's
  // "rs1-mi01-rl1-bo01.bo01.garr.net" is a Bologna router, whatever the link is called.
  labels?: string[];
}

const researchSites: ResearchSite[] = [
  { network: "Jisc (Janet)", domains: ["ja.net"], prefixes: ["lond"], city: "London", country: "GB", latitude: 51.5072, longitude: -0.1276 },
  { network: "Jisc (Janet)", domains: ["ja.net"], prefixes: ["manc"], city: "Manchester", country: "GB", latitude: 53.4808, longitude: -2.2426 },
  { network: "Jisc (Janet)", domains: ["ja.net"], prefixes: ["leed"], city: "Leeds", country: "GB", latitude: 53.79, longitude: -1.55 },
  { network: "Jisc (Janet)", domains: ["ja.net"], prefixes: ["camb"], city: "Cambridge", country: "GB", latitude: 52.2, longitude: 0.12 },
  { network: "Jisc (Janet)", domains: ["ja.net"], prefixes: ["live"], city: "Liverpool", country: "GB", latitude: 53.41, longitude: -2.96 },
  { network: "Jisc (Janet)", domains: ["ja.net"], prefixes: ["nott"], city: "Nottingham", country: "GB", latitude: 52.94, longitude: -1.17 },
  { network: "Jisc (Janet)", domains: ["ja.net"], prefixes: ["oxfo"], city: "Oxford", country: "GB", latitude: 51.75, longitude: -1.25 },
  { network: "Jisc (Janet)", domains: ["ja.net"], prefixes: ["read"], city: "Reading", country: "GB", latitude: 51.47, longitude: -0.98 },
  { network: "Jisc (Janet)", domains: ["ja.net"], prefixes: ["brad"], city: "Bradford", country: "GB", latitude: 53.79, longitude: -1.75 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bsp", "csp"], labels: ["pop-sp"], city: "Sao Paulo", country: "BR", latitude: -23.5505, longitude: -46.6333 },
  { network: "RNP", domains: ["rnp.br"], codes: ["brj", "crj"], labels: ["pop-rj"], city: "Rio de Janeiro", country: "BR", latitude: -22.9068, longitude: -43.1729 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bpr", "cpr"], labels: ["pop-pr"], city: "Curitiba", country: "BR", latitude: -25.42, longitude: -49.32 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bdf", "cdf"], labels: ["pop-df"], city: "Brasilia", country: "BR", latitude: -15.78, longitude: -47.92 },
  { network: "RNP", domains: ["rnp.br"], codes: ["brs", "crs"], labels: ["pop-rs"], city: "Porto Alegre", country: "BR", latitude: -30.05, longitude: -51.2 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bmg", "cmg"], labels: ["pop-mg"], city: "Belo Horizonte", country: "BR", latitude: -19.91, longitude: -43.92 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bba", "cba"], labels: ["pop-ba"], city: "Salvador", country: "BR", latitude: -12.97, longitude: -38.48 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bpe", "cpe"], labels: ["pop-pe"], city: "Recife", country: "BR", latitude: -8.06, longitude: -34.91 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bce", "cce"], labels: ["pop-ce"], city: "Fortaleza", country: "BR", latitude: -3.75, longitude: -38.58 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bsc", "csc"], labels: ["pop-sc"], city: "Florianopolis", country: "BR", latitude: -27.58, longitude: -48.52 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bpa", "cpa"], labels: ["pop-pa"], city: "Belem", country: "BR", latitude: -1.45, longitude: -48.48 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bam", "cam"], labels: ["pop-am"], city: "Manaus", country: "BR", latitude: -3.1, longitude: -60.0 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bes", "ces"], labels: ["pop-es"], city: "Vitoria", country: "BR", latitude: -20.33, longitude: -40.35 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bgo", "cgo"], labels: ["pop-go"], city: "Goiania", country: "BR", latitude: -16.72, longitude: -49.3 },
  { network: "RNP", domains: ["rnp.br"], codes: ["brn", "crn"], labels: ["pop-rn"], city: "Natal", country: "BR", latitude: -5.78, longitude: -35.24 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bpb", "cpb"], labels: ["pop-pb"], city: "Joao Pessoa", country: "BR", latitude: -7.1, longitude: -34.88 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bal", "cal"], labels: ["pop-al"], city: "Maceio", country: "BR", latitude: -9.62, longitude: -35.73 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bse", "cse"], labels: ["pop-se"], city: "Aracaju", country: "BR", latitude: -10.9, longitude: -37.12 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bpi", "cpi"], labels: ["pop-pi"], city: "Teresina", country: "BR", latitude: -5.09, longitude: -42.78 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bma", "cma"], labels: ["pop-ma"], city: "Sao Luis", country: "BR", latitude: -2.51, longitude: -44.27 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bmt", "cmt"], labels: ["pop-mt"], city: "Cuiaba", country: "BR", latitude: -15.57, longitude: -56.09 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bms", "cms"], labels: ["pop-ms"], city: "Campo Grande", country: "BR", latitude: -20.45, longitude: -54.62 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bto", "cto"], labels: ["pop-to"], city: "Palmas", country: "BR", latitude: -10.24, longitude: -48.29 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bro", "cro"], labels: ["pop-ro"], city: "Porto Velho", country: "BR", latitude: -8.75, longitude: -63.9 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bac", "cac"], labels: ["pop-ac"], city: "Rio Branco", country: "BR", latitude: -9.97, longitude: -67.8 },
  { network: "RNP", domains: ["rnp.br"], codes: ["brr", "crr"], labels: ["pop-rr"], city: "Boa Vista", country: "BR", latitude: 2.82, longitude: -60.67 },
  { network: "RNP", domains: ["rnp.br"], codes: ["bap", "cap"], labels: ["pop-ap"], city: "Macapa", country: "BR", latitude: 0.03, longitude: -51.05 },
  { network: "RNP", domains: ["rnp.br"], codes: ["cmia", "mia"], city: "Miami", country: "US", latitude: 25.7617, longitude: -80.1918 },
  { network: "IX.br", domains: ["ix.br"], codes: ["curitiba"], city: "Curitiba", country: "BR", latitude: -25.42, longitude: -49.32 },
  { network: "IX.br", domains: ["ix.br"], codes: ["saopaulo"], city: "Sao Paulo", country: "BR", latitude: -23.5505, longitude: -46.6333 },
  { network: "IX.br", domains: ["ix.br"], codes: ["riodejaneiro"], city: "Rio de Janeiro", country: "BR", latitude: -22.9068, longitude: -43.1729 },
  { network: "IX.br", domains: ["ix.br"], codes: ["portoalegre"], city: "Porto Alegre", country: "BR", latitude: -30.05, longitude: -51.2 },
  { network: "IX.br", domains: ["ix.br"], codes: ["belohorizonte"], city: "Belo Horizonte", country: "BR", latitude: -19.91, longitude: -43.92 },
  { network: "IX.br", domains: ["ix.br"], codes: ["brasilia"], city: "Brasilia", country: "BR", latitude: -15.78, longitude: -47.92 },
  { network: "IX.br", domains: ["ix.br"], codes: ["fortaleza"], city: "Fortaleza", country: "BR", latitude: -3.75, longitude: -38.58 },
  { network: "IX.br", domains: ["ix.br"], codes: ["recife"], city: "Recife", country: "BR", latitude: -8.06, longitude: -34.91 },
  { network: "IX.br", domains: ["ix.br"], codes: ["salvador"], city: "Salvador", country: "BR", latitude: -12.97, longitude: -38.48 },
  { network: "IX.br", domains: ["ix.br"], codes: ["florianopolis"], city: "Florianopolis", country: "BR", latitude: -27.58, longitude: -48.52 },
  { network: "IX.br", domains: ["ix.br"], codes: ["manaus"], city: "Manaus", country: "BR", latitude: -3.1, longitude: -60.0 },
  { network: "IX.br", domains: ["ix.br"], codes: ["belem"], city: "Belem", country: "BR", latitude: -1.45, longitude: -48.48 },
  { network: "IX.br", domains: ["ix.br"], codes: ["vitoria"], city: "Vitoria", country: "BR", latitude: -20.33, longitude: -40.35 },
  { network: "IX.br", domains: ["ix.br"], codes: ["goiania"], city: "Goiania", country: "BR", latitude: -16.72, longitude: -49.3 },
  { network: "IX.br", domains: ["ix.br"], codes: ["natal"], city: "Natal", country: "BR", latitude: -5.78, longitude: -35.24 },
  { network: "IX.br", domains: ["ix.br"], codes: ["maceio"], city: "Maceio", country: "BR", latitude: -9.62, longitude: -35.73 },
  { network: "IX.br", domains: ["ix.br"], codes: ["teresina"], city: "Teresina", country: "BR", latitude: -5.09, longitude: -42.78 },
  { network: "IX.br", domains: ["ix.br"], codes: ["cuiaba"], city: "Cuiaba", country: "BR", latitude: -15.57, longitude: -56.09 },
  { network: "TENET", domains: ["tenet.ac.za"], codes: ["cpt"], city: "Cape Town", country: "ZA", latitude: -33.9249, longitude: 18.4241 },
  { network: "TENET", domains: ["tenet.ac.za"], codes: ["jnb"], city: "Johannesburg", country: "ZA", latitude: -26.2041, longitude: 28.0473 },
  { network: "TENET", domains: ["tenet.ac.za"], codes: ["dur"], city: "Durban", country: "ZA", latitude: -29.86, longitude: 31.01 },
  { network: "GARR", domains: ["garr.net"], labels: ["mi"], city: "Milan", country: "IT", latitude: 45.4642, longitude: 9.19 },
  { network: "GARR", domains: ["garr.net"], labels: ["rm"], city: "Rome", country: "IT", latitude: 41.9028, longitude: 12.4964 },
  { network: "GARR", domains: ["garr.net"], labels: ["bo"], city: "Bologna", country: "IT", latitude: 44.5, longitude: 11.34 },
  { network: "GARR", domains: ["garr.net"], labels: ["to"], city: "Turin", country: "IT", latitude: 45.07, longitude: 7.67 },
  { network: "GARR", domains: ["garr.net"], labels: ["na"], city: "Naples", country: "IT", latitude: 40.84, longitude: 14.24 },
  { network: "GARR", domains: ["garr.net"], labels: ["fi"], city: "Florence", country: "IT", latitude: 43.78, longitude: 11.25 },
  { network: "GARR", domains: ["garr.net"], labels: ["ge"], city: "Genoa", country: "IT", latitude: 44.41, longitude: 8.93 },
  { network: "GARR", domains: ["garr.net"], labels: ["ba"], city: "Bari", country: "IT", latitude: 41.11, longitude: 16.87 },
  { network: "GARR", domains: ["garr.net"], labels: ["pa"], city: "Palermo", country: "IT", latitude: 38.13, longitude: 13.35 },
  { network: "GARR", domains: ["garr.net"], labels: ["ct"], city: "Catania", country: "IT", latitude: 37.5, longitude: 15.08 },
  { network: "GARR", domains: ["garr.net"], labels: ["ca"], city: "Cagliari", country: "IT", latitude: 39.22, longitude: 9.1 },
  { network: "GARR", domains: ["garr.net"], labels: ["ve"], city: "Venice", country: "IT", latitude: 45.44, longitude: 12.33 },
  { network: "GARR", domains: ["garr.net"], labels: ["ts"], city: "Trieste", country: "IT", latitude: 45.65, longitude: 13.8 },
  { network: "GARR", domains: ["garr.net"], labels: ["pi"], city: "Pisa", country: "IT", latitude: 43.72, longitude: 10.4 },
  { network: "GARR", domains: ["garr.net"], labels: ["pg"], city: "Perugia", country: "IT", latitude: 43.11, longitude: 12.39 },
  { network: "GARR", domains: ["garr.net"], labels: ["tn"], city: "Trento", country: "IT", latitude: 46.08, longitude: 11.12 },
  { network: "SWITCH", domains: ["switch.ch"], codes: ["swiez", "swiix"], city: "Zurich", country: "CH", latitude: 47.3769, longitude: 8.5417 },
  { network: "BelWue", domains: ["belwue.net"], codes: ["kar"], city: "Karlsruhe", country: "DE", latitude: 49.0, longitude: 8.4 },
  { network: "BelWue", domains: ["belwue.net"], codes: ["stu"], city: "Stuttgart", country: "DE", latitude: 48.78, longitude: 9.2 },
  { network: "BelWue", domains: ["belwue.net"], codes: ["hdlrz"], city: "Heidelberg", country: "DE", latitude: 49.42, longitude: 8.7 },
  { network: "GEANT", domains: ["geant.net"], codes: ["ath"], city: "Athens", country: "GR", latitude: 37.99, longitude: 23.73 },
  { network: "GEANT", domains: ["geant.net"], codes: ["lon"], city: "London", country: "GB", latitude: 51.5072, longitude: -0.1276 },
  { network: "GEANT", domains: ["geant.net"], codes: ["mil"], city: "Milan", country: "IT", latitude: 45.4642, longitude: 9.19 },
  { network: "GEANT", domains: ["geant.net"], codes: ["bra"], city: "Bratislava", country: "SK", latitude: 48.15, longitude: 17.12 },
  { network: "GEANT", domains: ["geant.net"], codes: ["bud"], city: "Budapest", country: "HU", latitude: 47.5, longitude: 19.08 },
  { network: "GEANT", domains: ["geant.net"], codes: ["gen"], city: "Geneva", country: "CH", latitude: 46.21, longitude: 6.14 },
  { network: "GEANT", domains: ["geant.net"], codes: ["par"], city: "Paris", country: "FR", latitude: 48.8566, longitude: 2.3522 },
  { network: "GEANT", domains: ["geant.net"], codes: ["poz"], city: "Poznan", country: "PL", latitude: 52.41, longitude: 16.9 },
  { network: "GEANT", domains: ["geant.net"], codes: ["pra"], city: "Prague", country: "CZ", latitude: 50.09, longitude: 14.42 },
  { network: "GEANT", domains: ["geant.net"], codes: ["dub"], city: "Dublin", country: "IE", latitude: 53.35, longitude: -6.26 },
  { network: "GEANT", domains: ["geant.net"], codes: ["ams"], city: "Amsterdam", country: "NL", latitude: 52.35, longitude: 4.91 },
  { network: "GEANT", domains: ["geant.net"], codes: ["fra"], city: "Frankfurt", country: "DE", latitude: 50.1, longitude: 8.68 },
  { network: "GEANT", domains: ["geant.net"], codes: ["vie"], city: "Vienna", country: "AT", latitude: 48.2, longitude: 16.36 },
  { network: "GEANT", domains: ["geant.net"], codes: ["mad"], city: "Madrid", country: "ES", latitude: 40.4, longitude: -3.69 },
  { network: "GEANT", domains: ["geant.net"], codes: ["lis"], city: "Lisbon", country: "PT", latitude: 38.72, longitude: -9.15 },
  { network: "GEANT", domains: ["geant.net"], codes: ["bru"], city: "Brussels", country: "BE", latitude: 50.84, longitude: 4.33 },
  { network: "GEANT", domains: ["geant.net"], codes: ["cop"], city: "Copenhagen", country: "DK", latitude: 55.6761, longitude: 12.5683 },
  { network: "GEANT", domains: ["geant.net"], codes: ["ham"], city: "Hamburg", country: "DE", latitude: 53.55, longitude: 10.0 },
  { network: "GEANT", domains: ["geant.net"], codes: ["mar"], city: "Marseille", country: "FR", latitude: 43.29, longitude: 5.37 },
  { network: "GEANT", domains: ["geant.net"], codes: ["zag"], city: "Zagreb", country: "HR", latitude: 45.8, longitude: 16.0 },
  { network: "GEANT", domains: ["geant.net"], codes: ["buc"], city: "Bucharest", country: "RO", latitude: 44.44, longitude: 26.1 },
  { network: "GEANT", domains: ["geant.net"], codes: ["sof"], city: "Sofia", country: "BG", latitude: 42.69, longitude: 23.31 },
  { network: "GEANT", domains: ["geant.net"], codes: ["tal"], city: "Tallinn", country: "EE", latitude: 59.43, longitude: 24.73 },
  { network: "GEANT", domains: ["geant.net"], codes: ["rig"], city: "Riga", country: "LV", latitude: 56.95, longitude: 24.1 },
  { network: "GEANT", domains: ["geant.net"], codes: ["vil"], city: "Vilnius", country: "LT", latitude: 54.68, longitude: 25.32 },
  { network: "GEANT", domains: ["geant.net"], codes: ["hel"], city: "Helsinki", country: "FI", latitude: 60.16, longitude: 24.93 },
  { network: "GEANT", domains: ["geant.net"], codes: ["osl"], city: "Oslo", country: "NO", latitude: 59.92, longitude: 10.75 },
  { network: "GEANT", domains: ["geant.net"], codes: ["sto"], city: "Stockholm", country: "SE", latitude: 59.32, longitude: 18.07 },
  { network: "GEANT", domains: ["geant.net"], codes: ["lju"], city: "Ljubljana", country: "SI", latitude: 46.06, longitude: 14.51 },
  { network: "GEANT", domains: ["geant.net"], codes: ["lux"], city: "Luxembourg", country: "LU", latitude: 49.61, longitude: 6.13 },
  { network: "GEANT", domains: ["geant.net"], codes: ["ist"], city: "Istanbul", country: "TR", latitude: 41.02, longitude: 28.97 },
  { network: "CANARIE", domains: ["canarie.ca"], codes: ["otwa"], city: "Ottawa", country: "CA", latitude: 45.42, longitude: -75.7 },
  { network: "CANARIE", domains: ["canarie.ca"], codes: ["vctr"], city: "Victoria", country: "CA", latitude: 48.43, longitude: -123.35 },
  { network: "CANARIE", domains: ["canarie.ca"], codes: ["wnpg"], city: "Winnipeg", country: "CA", latitude: 49.88, longitude: -97.17 },
  { network: "CANARIE", domains: ["canarie.ca"], codes: ["hlfx"], city: "Halifax", country: "CA", latitude: 44.65, longitude: -63.6 },
  { network: "CANARIE", domains: ["canarie.ca"], codes: ["clgr"], city: "Calgary", country: "CA", latitude: 51.08, longitude: -114.08 },
  { network: "DFN (X-WIN)", domains: ["dfn.de"], codes: ["ham"], city: "Hamburg", country: "DE", latitude: 53.55, longitude: 10.0 },
  { network: "DFN (X-WIN)", domains: ["dfn.de"], codes: ["lei"], city: "Leipzig", country: "DE", latitude: 51.34, longitude: 12.41 },
  { network: "DFN (X-WIN)", domains: ["dfn.de"], codes: ["che"], city: "Chemnitz", country: "DE", latitude: 50.83, longitude: 12.92 },
  { network: "DFN (X-WIN)", domains: ["dfn.de"], codes: ["dor"], city: "Dortmund", country: "DE", latitude: 51.53, longitude: 7.45 },
  { network: "DFN (X-WIN)", domains: ["dfn.de"], codes: ["wue"], city: "Wurzburg", country: "DE", latitude: 49.8, longitude: 9.95 },
  { network: "IX New Zealand", domains: ["ix.nz"], codes: ["akl"], city: "Auckland", country: "NZ", latitude: -36.8485, longitude: 174.7633 },
  // NORDUnet writes the country and its own city code in the label: "de-ffm.nordu.net".
  { network: "NORDUnet", domains: ["nordu.net"], labels: ["de-ffm"], city: "Frankfurt", country: "DE", latitude: 50.1, longitude: 8.68 },
  { network: "NORDUnet", domains: ["nordu.net"], labels: ["de-hmb"], city: "Hamburg", country: "DE", latitude: 53.55, longitude: 10.0 },
  { network: "NORDUnet", domains: ["nordu.net"], labels: ["uk-hex"], city: "London", country: "GB", latitude: 51.5072, longitude: -0.1276 },
  { network: "NORDUnet", domains: ["nordu.net"], labels: ["inex"], city: "Dublin", country: "IE", latitude: 53.35, longitude: -6.26 }
];

// The label immediately before the network's own domain, digits stripped.
function siteLabel(normalizedHost: string, domain: string) {
  const head = normalizedHost.slice(0, Math.max(0, normalizedHost.length - domain.length - 1));

  return removeLeadingTrailingDigits(head.split(".").at(-1) ?? "");
}

interface SiteOnDomain {
  site: ResearchSite;
  domain: string;
}

interface SiteMatch {
  site: ResearchSite;
  matched: string;
}

// The site written where the network always writes it.
function siteFromLabel(here: SiteOnDomain[], normalizedHost: string): SiteMatch | undefined {
  for (const { site, domain } of here) {
    const label = site.labels ? siteLabel(normalizedHost, domain) : "";

    if (label && site.labels?.includes(label)) {
      return { site, matched: label };
    }
  }

  return undefined;
}

// The earliest site code in the name: a router is named for its own site before the far
// end of the link it carries.
function siteFromCode(here: SiteOnDomain[], tokens: string[]): SiteMatch | undefined {
  for (const token of tokens) {
    for (const { site } of here) {
      if (site.codes?.includes(token) || site.prefixes?.some((prefix) => token.startsWith(prefix))) {
        return { site, matched: token };
      }
    }
  }

  return undefined;
}

// Operators that write the site's own IATA code in a fixed label, right before their
// suffix: "be2085.ccr41.mia03.atlas.cogentco.com" is Cogent's third Miami site, and
// "ae27-0.ier01.cph30.ntwk.msn.net" is Microsoft's in Copenhagen. Read from that position
// the code needs no database to confirm it, because the position is the operator's own
// convention - which is what keeps "ccr41" in the same name from being read as Concord.
const airportLabelDomains = ["atlas.cogentco.com", "ntwk.msn.net", "as7195.net"];

function inferCityFromAirportLabel(hostname: string, normalizedHost: string): GeoCandidate | undefined {
  const domain = airportLabelDomains.find((entry) => normalizedHost.endsWith(entry));

  if (!domain) {
    return undefined;
  }

  const label = siteLabel(normalizedHost, domain);
  const airport = label.length === 3 ? AIRPORT_CODES[label] : undefined;

  if (!airport) {
    return undefined;
  }

  return {
    city: airport.city,
    country: airport.country,
    latitude: airport.latitude,
    longitude: airport.longitude,
    confidence: "high",
    evidence: [`reverse DNS names the site "${label}" in ${hostname}, where this operator writes the airport code of the city (${airport.city})`],
    precision: "city",
    source: "reverse_dns"
  };
}

function inferCityFromResearchSite(hostname: string, normalizedHost: string, tokens: string[]): GeoCandidate | undefined {
  const here = researchSites
    .map((site) => ({ site, domain: site.domains.find((entry) => normalizedHost.endsWith(entry)) }))
    .filter((entry): entry is SiteOnDomain => entry.domain !== undefined);

  if (here.length === 0) {
    return undefined;
  }

  const match = siteFromLabel(here, normalizedHost) ?? siteFromCode(here, tokens);

  if (!match) {
    return undefined;
  }

  const { site, matched } = match;

  return {
    city: site.city,
    country: site.country,
    latitude: site.latitude,
    longitude: site.longitude,
    confidence: "high",
    evidence: [`reverse DNS matched "${matched}" in ${hostname}, ${site.network}'s own name for its ${site.city} site`],
    precision: "city",
    source: "reverse_dns"
  };
}

function inferCityFromHostname(hostname?: string): GeoCandidate | undefined {
  if (!hostname) {
    return undefined;
  }

  const normalizedHost = compactWhitespace(hostname.toLowerCase());
  const tokens = tokeniseHostname(hostname);
  const research = inferCityFromResearchSite(hostname, normalizedHost, tokens);

  if (research) {
    return research;
  }

  for (const city of cityHints) {
    // A carrier's site codes mean something only in that carrier's own names.
    if (city.domains && !city.domains.some((domain) => normalizedHost.endsWith(domain))) {
      continue;
    }

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

  // Last, the operator's own site label. The curated names above win first, so a hub keeps
  // the name a reader expects ("Dallas", not the airport's "Dallas-Fort Worth").
  return inferCityFromAirportLabel(hostname, normalizedHost);
}

function inferCitiesFromAirportCodes(hostname: string | undefined, corroborating: GeoCandidate[]): GeoCandidate[] {
  if (!hostname) {
    return [];
  }

  const candidates: GeoCandidate[] = [];
  const seen = new Set<string>();
  const tokens = tokeniseHostname(hostname);
  // Carriers that name routers "us-mia01a" put the country first. When the databases all
  // carry the operator's registration address instead, that prefix is the only thing left
  // saying which country the router actually stands in.
  const countryPrefix = tokens[0]?.length === 2 ? tokens[0] : undefined;

  for (const token of tokens) {
    if (token.length !== 3 || seen.has(token)) {
      continue;
    }

    seen.add(token);
    const airport = AIRPORT_CODES[token];

    if (!airport) {
      continue;
    }

    // Three-letter tokens collide constantly: "cpr1" in a Brazilian router name is an
    // interface label, not Casper, Wyoming. Require a GeoIP source, or the name's own
    // country prefix, to put the hop in the same country before treating the code as evidence.
    const corroborated =
      corroborating.some((candidate) => sameCountry(candidate.country, airport.country)) ||
      (countryPrefix !== undefined && sameCountry(countryPrefix, airport.country));

    if (!corroborated) {
      continue;
    }

    // Every three-letter token is a candidate, not an answer: "ccr41" and "lax2" look alike
    // to a tokenizer. The RTT check and the candidate scoring downstream settle which one
    // survives, so a hub is offered confidently and a regional field only tentatively.
    candidates.push({
      city: airport.city,
      country: airport.country,
      latitude: airport.latitude,
      longitude: airport.longitude,
      confidence: airport.major ? "high" : "medium",
      evidence: [`reverse DNS carries airport code "${token}" (${airport.city})`],
      precision: "city",
      source: "reverse_dns"
    });
  }

  return candidates;
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

function booleanFromIpApi(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function stringFromIpApi(data: Record<string, unknown>, key: string) {
  const value = data[key];

  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function headerNumber(response: Response, name: string) {
  const value = response.headers.get(name);

  if (value === null) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function noteIpApiRateLimit(response: Response) {
  const remaining = headerNumber(response, "x-rl");

  if (response.status !== 429 && remaining !== 0) {
    return;
  }

  const pauseSeconds = Math.max(headerNumber(response, "x-ttl") ?? 60, 1);

  ipApiPausedUntil = Date.now() + pauseSeconds * 1_000;
  console.warn(`ip-api rate limit reached. Pausing GeoIP lookups for ${pauseSeconds}s.`);
}

async function fetchIpApi(ip: string): Promise<IpGeoRecord | undefined> {
  const configuredUrl = process.env.IP_API_URL?.trim();

  if (!configuredUrl) {
    return undefined;
  }

  if (Date.now() < ipApiPausedUntil) {
    return undefined;
  }

  const timer = timeoutSignal(GEO_TIMEOUT_MS);

  try {
    const fields = [
      "status",
      "message",
      "country",
      "countryCode",
      "region",
      "regionName",
      "city",
      "district",
      "lat",
      "lon",
      "isp",
      "org",
      "as",
      "asname",
      "reverse",
      "query",
      "mobile",
      "proxy",
      "hosting"
    ].join(",");
    const url = new URL(configuredUrl);
    url.pathname = `${trimTrailingPathSlash(url.pathname)}/json/${encodeURIComponent(ip)}`;
    url.searchParams.set("fields", fields);

    const apiKey = process.env.IP_API_KEY?.trim();

    if (apiKey) {
      url.searchParams.set("key", apiKey);
    }

    const response = await fetch(url, {
      signal: timer.signal,
      headers: { accept: "application/json" }
    });

    noteIpApiRateLimit(response);

    if (!response.ok) {
      console.warn(`ip-api lookup failed for ${ip}. HTTP ${response.status}.`);
      return undefined;
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (data.status !== "success") {
      console.warn(`ip-api lookup rejected for ${ip}. ${stringFromIpApi(data, "message") ?? "No message returned."}`);
      return undefined;
    }

    const asText = typeof data.as === "string" ? data.as : undefined;

    return {
      database: "ip-api",
      asn: normalizeAsn(asText),
      asName: stringFromIpApi(data, "asname") ?? stripAsPrefix(asText),
      city: stringFromIpApi(data, "city"),
      district: stringFromIpApi(data, "district"),
      regionName: stringFromIpApi(data, "regionName"),
      country: countryFromIpApi(data),
      hostname: stringFromIpApi(data, "reverse"),
      isp: stringFromIpApi(data, "isp"),
      org: stringFromIpApi(data, "org"),
      hosting: booleanFromIpApi(data.hosting),
      mobile: booleanFromIpApi(data.mobile),
      proxy: booleanFromIpApi(data.proxy),
      latitude: finite(data.lat),
      longitude: finite(data.lon)
    };
  } catch (error) {
    console.warn(`ip-api lookup errored for ${ip}. ${error instanceof Error ? error.message : "Unknown error."}`);
    return undefined;
  } finally {
    timer.done();
  }
}

let ip2LocationPausedUntil = 0;

async function fetchIp2Location(ip: string): Promise<IpGeoRecord | undefined> {
  const key = process.env.IP2LOCATION_API_KEY?.trim();

  if (!key || Date.now() < ip2LocationPausedUntil) {
    return undefined;
  }

  const timer = timeoutSignal(GEO_TIMEOUT_MS);

  try {
    const url = new URL(process.env.IP2LOCATION_URL ?? "https://api.ip2location.io/");
    url.searchParams.set("key", key);
    url.searchParams.set("ip", ip);

    const response = await fetch(url, { signal: timer.signal, headers: { accept: "application/json" } });

    if (response.status === 429) {
      ip2LocationPausedUntil = Date.now() + 5 * 60_000;
      console.warn("ip2location rate limit reached. Pausing that source for 5 minutes.");
      return undefined;
    }

    if (!response.ok) {
      console.warn(`ip2location lookup failed for ${ip}. HTTP ${response.status}.`);
      return undefined;
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (data.error || !stringFromIpApi(data, "country_code")) {
      return undefined;
    }

    const asn = stringFromIpApi(data, "asn");

    return {
      database: "ip2location",
      asn: asn && Number(asn) > 0 ? `AS${asn}` : undefined,
      asName: stringFromIpApi(data, "as"),
      city: stringFromIpApi(data, "city_name"),
      regionName: stringFromIpApi(data, "region_name"),
      country: stringFromIpApi(data, "country_code"),
      proxy: typeof data.is_proxy === "boolean" ? data.is_proxy : undefined,
      latitude: finite(data.latitude),
      longitude: finite(data.longitude)
    };
  } catch (error) {
    console.warn(`ip2location lookup errored for ${ip}. ${error instanceof Error ? error.message : "Unknown error."}`);
    return undefined;
  } finally {
    timer.done();
  }
}

// RIPE IPmap: where RIPE's own measurements and router-name analysis put an address. An
// answer scored 20 and up rests on a reverse-DNS pattern or an active measurement; one
// scored 1 is only the world's population distribution, a guess, and is not taken.
const IPMAP_MIN_SCORE = 10;
let ipmapPausedUntil = 0;

async function fetchRipeIpmap(ip: string): Promise<IpGeoRecord | undefined> {
  if (process.env.RIPE_IPMAP === "off" || Date.now() < ipmapPausedUntil) {
    return undefined;
  }

  const timer = timeoutSignal(GEO_TIMEOUT_MS);

  try {
    const response = await fetch(`https://ipmap-api.ripe.net/v1/locate/${encodeURIComponent(ip)}/best`, {
      signal: timer.signal,
      headers: { accept: "application/json" }
    });

    if (response.status === 429) {
      ipmapPausedUntil = Date.now() + 60_000;
      console.warn("RIPE IPmap rate limit reached. Pausing that source for 60s.");
      return undefined;
    }

    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as { location?: Record<string, unknown> };
    const location = data.location;
    const score = finite(location?.score);

    if (!location || score === undefined || score < IPMAP_MIN_SCORE) {
      return undefined;
    }

    // What the answer rests on. A router-name pattern is IPmap's own reading of the name,
    // which this pipeline also does and does more carefully; an active measurement or an
    // operator's published geofeed is evidence of a different kind.
    const contributions = Object.keys((location.contributions as Record<string, unknown> | undefined) ?? {});
    const measured = contributions.some((kind) => kind !== "reverse-dns" && kind !== "worlds");

    return {
      database: "ripe-ipmap",
      city: (typeof location.cityNameAscii === "string" && location.cityNameAscii) || (typeof location.cityName === "string" ? location.cityName : undefined),
      country: typeof location.countryCodeAlpha2 === "string" ? location.countryCodeAlpha2 : undefined,
      latitude: finite(location.latitude),
      longitude: finite(location.longitude),
      score,
      measured
    };
  } catch (error) {
    console.warn(`RIPE IPmap lookup errored for ${ip}. ${error instanceof Error ? error.message : "Unknown error."}`);
    return undefined;
  } finally {
    timer.done();
  }
}

let ipWhoIsPausedUntil = 0;

async function fetchIpWhoIs(ip: string): Promise<IpGeoRecord | undefined> {
  if (process.env.GEOIP_SECONDARY === "none" || Date.now() < ipWhoIsPausedUntil) {
    return undefined;
  }

  const timer = timeoutSignal(GEO_TIMEOUT_MS);

  try {
    const url = new URL(`${process.env.IPWHOIS_URL ?? "https://ipwho.is"}/${encodeURIComponent(ip)}`);
    url.searchParams.set("fields", "success,message,city,region,country_code,latitude,longitude,connection");

    const response = await fetch(url, { signal: timer.signal, headers: { accept: "application/json" } });

    if (response.status === 429) {
      ipWhoIsPausedUntil = Date.now() + 60_000;
      console.warn("ipwho.is rate limit reached. Pausing the secondary GeoIP source for 60s.");
      return undefined;
    }

    if (!response.ok) {
      console.warn(`ipwho.is lookup failed for ${ip}. HTTP ${response.status}.`);
      return undefined;
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (data.success !== true) {
      return undefined;
    }

    const connection = data.connection && typeof data.connection === "object"
      ? (data.connection as Record<string, unknown>)
      : undefined;
    const asn = typeof connection?.asn === "number" && connection.asn > 0 ? `AS${connection.asn}` : undefined;

    return {
      database: "ipwho.is",
      asn,
      asName: typeof connection?.org === "string" ? connection.org : undefined,
      city: stringFromIpApi(data, "city"),
      regionName: stringFromIpApi(data, "region"),
      country: stringFromIpApi(data, "country_code"),
      isp: typeof connection?.isp === "string" ? connection.isp : undefined,
      latitude: finite(data.latitude),
      longitude: finite(data.longitude)
    };
  } catch (error) {
    console.warn(`ipwho.is lookup errored for ${ip}. ${error instanceof Error ? error.message : "Unknown error."}`);
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

// A cache of complete answers on disk, for the bench: the same three hundred addresses
// looked up on every run would burn the free tiers' quotas, and an answer that changes
// between runs would hide what a rule change did. Only answers every source gave are kept.
const persistentGeoFile = () => process.env.GEO_CACHE_FILE?.trim();
let persistentGeo: Map<string, IpGeoRecord[]> | undefined;

function loadPersistentGeo() {
  const file = persistentGeoFile();

  if (!file) return undefined;

  if (!persistentGeo) {
    try {
      persistentGeo = new Map(Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, IpGeoRecord[]>));
    } catch {
      persistentGeo = new Map();
    }
  }

  return persistentGeo;
}

function rememberGeo(ip: string, records: IpGeoRecord[]) {
  const file = persistentGeoFile();
  const store = loadPersistentGeo();

  if (!file || !store || store.has(ip)) return;

  store.set(ip, records);
  writeFileSync(file, JSON.stringify(Object.fromEntries([...store].sort(([a], [b]) => a.localeCompare(b))), null, 0));
}

async function lookupIpGeo(ip?: string): Promise<IpGeoRecord[]> {
  if (!isPublicIp(ip)) {
    return [];
  }

  const publicIp = ip;

  const now = Date.now();
  const cached = geoCache.get(publicIp);

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const stored = loadPersistentGeo()?.get(publicIp);

  if (stored) {
    geoCache.set(publicIp, { value: Promise.resolve(stored), expiresAt: Number.POSITIVE_INFINITY });
    return stored;
  }

  const provider = resolveGeoProvider();
  const value = (async () => {
    // Two independent databases, queried together. Neither is trusted on its own: a wrong
    // backbone answer is common, and agreement between unrelated sources is the signal.
    const [primary, secondary, tertiary, measured] = await Promise.all([
      provider === "none" ? undefined : provider === "ipinfo" ? fetchIpInfo(publicIp) : fetchIpApi(publicIp),
      fetchIpWhoIs(publicIp),
      fetchIp2Location(publicIp),
      fetchRipeIpmap(publicIp)
    ]);

    return [primary, secondary, tertiary, measured].filter((entry): entry is IpGeoRecord => Boolean(entry));
  })();

  geoCache.set(publicIp, { value, expiresAt: now + GEO_CACHE_TTL_MS });

  const record = await value;
  // IPmap is not a database: it has an answer for a minority of addresses, so its silence
  // is a complete answer, not a missing one.
  const expectedDatabases =
    (provider === "none" ? 0 : 1) + (process.env.GEOIP_SECONDARY === "none" ? 0 : 1) + (process.env.IP2LOCATION_API_KEY?.trim() ? 1 : 0);
  const databases = record.filter((entry) => entry.database !== "ripe-ipmap").length;

  if (record.length === 0) {
    // Retry eventually, but never on every poll of the same measurement: the provider is polled
    // about once a second, so re-fetching each unresolved hop turns one trace into hundreds of
    // outbound requests.
    geoCache.set(publicIp, { value, expiresAt: now + GEO_FAILURE_CACHE_MS });
  } else if (databases < expectedDatabases) {
    geoCache.set(publicIp, { value, expiresAt: now + GEO_PARTIAL_CACHE_MS });
  } else {
    rememberGeo(publicIp, record);
  }

  return record;
}

function geoCandidate(record?: IpGeoRecord): GeoCandidate | undefined {
  if (!record) {
    return undefined;
  }

  const city = record.city ?? record.district ?? record.regionName;

  if (
    !city ||
    !record.country ||
    typeof record.latitude !== "number" ||
    typeof record.longitude !== "number"
  ) {
    return undefined;
  }

  const evidence =
    record.database === "ripe-ipmap"
      ? [`RIPE IPmap places it in ${city} from ${record.measured ? "a measurement or the operator's geofeed" : "a router-name pattern"} (score ${Math.round(record.score ?? 0)})`]
      : [`GeoIP database match${record.database ? ` (${record.database})` : ""}`];

  if (record.asn && record.asName) {
    evidence.push(`${record.asn} ${record.asName}`);
  }

  if (record.isp && record.org && record.isp !== record.org) {
    evidence.push(`ISP ${record.isp}; org ${record.org}`);
  } else if (record.isp ?? record.org) {
    evidence.push(`network ${(record.isp ?? record.org) as string}`);
  }

  if (record.hosting) {
    evidence.push("hosting network hint");
  }

  if (record.proxy) {
    evidence.push("proxy network hint");
  }

  if (record.mobile) {
    evidence.push("mobile network hint");
  }

  return {
    city,
    country: record.country,
    latitude: record.latitude,
    longitude: record.longitude,
    confidence: record.database === "ripe-ipmap" && record.measured && (record.score ?? 0) >= 20 ? "high" : record.city ? "medium" : "low",
    evidence,
    precision: record.city || record.district ? "city" : "country",
    source: "geoip"
  };
}

const GEO_CONSENSUS_RADIUS_KM = 120;

function applyGeoConsensus(candidates: GeoCandidate[]): GeoCandidate[] {
  const databases = candidates.filter((candidate) => candidate.source === "geoip");

  if (databases.length < 2) {
    return candidates;
  }

  // Cluster the databases that put the hop in the same metro, then keep the biggest cluster.
  // A wrong answer for a backbone IP is usually one vendor's stale registration, so two
  // unrelated databases landing together is far stronger than any single verdict.
  const clusters = databases.reduce<GeoCandidate[][]>((groups, candidate) => {
    const group = groups.find((entry) => distanceKm(entry[0], candidate) < GEO_CONSENSUS_RADIUS_KM);

    if (group) {
      group.push(candidate);
    } else {
      groups.push([candidate]);
    }

    return groups;
  }, []);
  const winner = [...clusters].sort((a, b) => b.length - a.length)[0];

  if (winner.length < 2 || winner.length === databases.length) {
    return candidates;
  }

  const names = winner.map((candidate) => candidate.evidence[0]).join("; ");
  const agreed: GeoCandidate = {
    ...winner[0],
    confidence: "high",
    precision: winner[0].precision === "country" ? "metro" : winner[0].precision,
    evidence: [`${winner.length} of ${databases.length} GeoIP databases agree on ${winner[0].city}`, names]
  };

  // The outvoted database stays on the list, demoted. It never outranks the agreed answer,
  // but it is the only material left to move the hop to if the agreed answer turns out to sit
  // where the rest of the route says the packet cannot have been.
  const outvoted = databases
    .filter((candidate) => !winner.includes(candidate))
    .map<GeoCandidate>((candidate) => ({
      ...candidate,
      confidence: "low",
      evidence: [...candidate.evidence, `Outvoted by ${winner.length} databases agreeing on ${winner[0].city}`]
    }));

  return [...candidates.filter((candidate) => candidate.source !== "geoip"), agreed, ...outvoted];
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

    // Within a metro the two can still merge into one "combined" answer. Past that, a
    // database sitting 120+ km from the site the operator wrote into the router's name is
    // almost always the block's registration address, not the router - the name wins outright.
    return distanceKm(candidate, strongCandidate) >= 120;
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
    ixp: 22,
    combined: 18,
    reverse_dns: 14,
    provider: 12,
    geoip: 9
  };
  const precisionScore: Record<HopLocationPrecision, number> = {
    exact: 8,
    city: 6,
    metro: 4,
    country: 1,
    unknown: 0
  };

  return (
    confidenceScore[candidate.confidence] +
    sourceScore[candidate.source] +
    precisionScore[candidate.precision] +
    evidenceAgreementScore(candidate, candidates) +
    rttSupportScore(candidate, source, rttMs) +
    (candidate.peering ?? 0)
  );
}

// The winner is all a hop displays, but the runners-up are what make a contradicted hop
// recoverable instead of blank, so hand back the whole ordering.
function rankCandidates(candidates: GeoCandidate[], source?: GeoPoint, rttMs?: number, asn?: string): GeoCandidate[] {
  const saneCandidates = candidates
    .map(normalizeKnownDistrict)
    .map((candidate) => downgradeSameMetroPublicGeo(candidate, source, rttMs))
    .map((candidate) => peeringSupport(candidate, asn))
    .filter((candidate) => passesRttSanity(candidate, source, rttMs));

  const filteredCandidates = saneCandidates.filter((candidate) => !conflictsWithStrongEvidence(candidate, saneCandidates));

  if (filteredCandidates.length === 0) {
    return [];
  }

  const ranked = [...filteredCandidates].sort(
    (a, b) => candidateScore(b, filteredCandidates, source, rttMs) - candidateScore(a, filteredCandidates, source, rttMs)
  );

  const reverseCandidate = filteredCandidates.find((candidate) => candidate.source === "reverse_dns");
  const geo = filteredCandidates.find((candidate) => candidate.source === "geoip");

  if (reverseCandidate && geo) {
    const sameMetro = distanceKm(reverseCandidate, geo) < 90;
    const sameCity = reverseCandidate.city.toLowerCase() === geo.city.toLowerCase();

    if (sameMetro || sameCity) {
      const combined: GeoCandidate = {
        ...reverseCandidate,
        confidence: "high",
        evidence: [...reverseCandidate.evidence, ...geo.evidence],
        precision: reverseCandidate.precision,
        source: "combined"
      };

      return [combined, ...ranked.filter((candidate) => candidate !== reverseCandidate)];
    }
  }

  return ranked;
}

// Two databases naming the same place are one option, not two, so a rescue never retries a
// spot the route already rejected.
function distinctPlaces(candidates: GeoCandidate[]) {
  return candidates.filter(
    (candidate, index) => candidates.findIndex((other) => distanceKm(other, candidate) < 25) === index
  );
}

interface EnrichedHop {
  hop: HopResult;
  alternatives: GeoCandidate[];
}

async function enrichHop(hop: HopResult, source?: GeoPoint): Promise<EnrichedHop> {
  const reversedHostname = hop.hostname ? undefined : await reverseDns(hop.ip);
  const hostname = hop.hostname ?? reversedHostname;
  const hostnameCandidate = inferCityFromHostname(hostname);
  // ponytail: reverse DNS already names the city and the ASN is known, so skip the lookup.
  // Costs the "combined" corroboration bonus; buys headroom under the free 45/min budget.
  const geoRecords = await lookupIpGeo(hop.ip);
  const geoHostname = geoRecords.find((record) => record.hostname)?.hostname;
  const baseCandidates = [
    exchangeCandidate(hop),
    cityFromProvider(hop),
    hostnameCandidate,
    inferCityFromHostname(geoHostname),
    ...geoRecords.map(geoCandidate)
  ].filter((candidate): candidate is GeoCandidate => Boolean(candidate));
  const votedCandidates = applyGeoConsensus(baseCandidates);
  const candidates = [
    ...votedCandidates,
    ...inferCitiesFromAirportCodes(hostname, votedCandidates),
    ...inferCitiesFromAirportCodes(geoHostname, votedCandidates)
  ];
  const [location, ...runnersUp] = rankCandidates(candidates, source, hop.rttMs, hop.asn);

  const identity = {
    ...hop,
    hostname,
    asn: hop.asn ?? geoRecords.find((record) => record.asn)?.asn,
    asName: hop.asName ?? geoRecords.find((record) => record.asName)?.asName
  };

  if (!location) {
    return {
      alternatives: [],
      hop: {
        ...identity,
        locationConfidence: "low",
        locationSource: "unknown",
        locationPrecision: "unknown",
        locationEvidence: ["No reliable city-level evidence found"]
      }
    };
  }

  return {
    alternatives: distinctPlaces([location, ...runnersUp]).slice(1),
    hop: {
      ...identity,
      city: location.city,
      country: location.country,
      latitude: location.latitude,
      longitude: location.longitude,
      locationConfidence: location.confidence,
      locationSource: location.source,
      locationPrecision: location.precision,
      locationEvidence: location.evidence
    }
  };
}

function locatedPointFromHop(hop: HopResult): GeoPoint | undefined {
  if (
    typeof hop.latitude !== "number" ||
    !Number.isFinite(hop.latitude) ||
    typeof hop.longitude !== "number" ||
    !Number.isFinite(hop.longitude)
  ) {
    return undefined;
  }

  return {
    city: hop.city ?? "Unknown",
    country: hop.country ?? "Unknown",
    latitude: hop.latitude,
    longitude: hop.longitude
  };
}

function isWeakMapLocation(hop: HopResult) {
  if (hop.locationConfidence === "high" || hop.locationSource === "combined" || hop.locationSource === "reverse_dns") {
    return false;
  }

  return hop.locationSource === "geoip" || hop.locationSource === "provider";
}

function nearestLocatedHop(hops: HopResult[], startIndex: number, step: -1 | 1) {
  for (let index = startIndex; index >= 0 && index < hops.length; index += step) {
    const point = locatedPointFromHop(hops[index]);

    if (point) {
      return { hop: hops[index], point };
    }
  }

  return undefined;
}

function clearHopLocation(hop: HopResult, evidence: string): HopResult {
  return {
    ...hop,
    city: undefined,
    country: undefined,
    latitude: undefined,
    longitude: undefined,
    locationConfidence: "low",
    locationSource: "unknown",
    locationPrecision: "unknown",
    locationEvidence: [...(hop.locationEvidence ?? []), evidence]
  };
}

function stabilizeRouteLocations(hops: HopResult[]) {
  return hops.map((hop, index) => {
    const point = locatedPointFromHop(hop);

    if (!point || !isWeakMapLocation(hop)) {
      return hop;
    }

    const previous = nearestLocatedHop(hops, index - 1, -1);
    const next = nearestLocatedHop(hops, index + 1, 1);

    if (!previous || !next) {
      return hop;
    }

    const neighborDistance = distanceKm(previous.point, next.point);
    const previousDistance = distanceKm(previous.point, point);
    const nextDistance = distanceKm(next.point, point);
    const weakOutlierBetweenNearbyStrongPoints =
      neighborDistance < 260 &&
      previousDistance > 900 &&
      nextDistance > 900 &&
      (previous.hop.locationConfidence === "high" || next.hop.locationConfidence === "high");

    if (!weakOutlierBetweenNearbyStrongPoints) {
      return hop;
    }

    return clearHopLocation(
      hop,
      "Suppressed weak GeoIP point because adjacent reliable route points stay in the same metro area"
    );
  });
}

function hopRtt(hop: HopResult) {
  return typeof hop.rttMs === "number" && Number.isFinite(hop.rttMs) ? hop.rttMs : undefined;
}

interface PlacedHop {
  index: number;
  point: GeoPoint;
  latencyMs: number;
  hop: HopResult;
}

// A router can sit on its ICMP reply and inflate its own RTT, but nothing makes a reply come
// back sooner than propagation allows, and propagation only grows along the path. So the
// smallest RTT seen from a hop onward is the tightest honest ceiling on how far out that hop
// sits, and reading it that way strips the padding a slow router puts on its own number.
function pathLatencies(hops: HopResult[]) {
  const latency: number[] = [];
  let remainingMinimum = Number.POSITIVE_INFINITY;

  for (let index = hops.length - 1; index >= 0; index -= 1) {
    remainingMinimum = Math.min(remainingMinimum, hopRtt(hops[index]) ?? Number.POSITIVE_INFINITY);
    latency[index] = remainingMinimum;
  }

  return latency;
}

function placedHops(hops: HopResult[], latency = pathLatencies(hops)): PlacedHop[] {
  return hops.flatMap((hop, index) => {
    const point = locatedPointFromHop(hop);

    return point && Number.isFinite(latency[index])
      ? [{ index, point, latencyMs: latency[index], hop }]
      : [];
  });
}

// Every hop answers over the same path out of the probe, so the gap between two of them can
// only be as long as light covers in the extra latency. Databases disagreeing inside one
// backbone AS is what produces the impossible version: the same address block placed on three
// continents, crossing an ocean in four milliseconds.
// Between two hops the slack is wide, because their round trips are measured on different
// return paths and a router's reply can carry its own delay. From the probe itself there is
// no such excuse: nothing answers sooner than light allows from where the probe stands.
const ANCHOR_SLACK_KM = 120;

function outrunsLight(earlier: PlacedHop, later: PlacedHop) {
  const reachable = (later.latencyMs - earlier.latencyMs) * PATH_KM_PER_RTT_MS + PATH_RTT_SLACK_KM;

  return distanceKm(earlier.point, later.point) > reachable;
}

// Against the probe a hop is judged on its own round trip, not the smallest seen further
// along: an anycast address at the end answers from next door and would otherwise make
// every earlier hop look unreachable. A hop's own round trip can only be inflated, never
// short of propagation, so it stays an honest ceiling on the distance.
function farFromProbe(entry: PlacedHop, anchor: PlacedHop) {
  const own = hopRtt(entry.hop);

  return own !== undefined && distanceKm(anchor.point, entry.point) > own * PATH_KM_PER_RTT_MS + ANCHOR_SLACK_KM;
}

function contradict(a: PlacedHop, b: PlacedHop) {
  return a.index < b.index ? outrunsLight(a, b) : outrunsLight(b, a);
}

// The probe is the one place known for certain, at zero latency: every hop's round trip is
// measured from it, so a hop placed farther away than its own round trip allows light to
// travel is simply not there. That catches what no pair of hops can - the last hop of all,
// an anycast address answered from a nearer site than the one its registration names.
function anchorHop(source?: GeoPoint): PlacedHop | undefined {
  return source ? { index: -1, point: source, latencyMs: 0, hop: { hopNumber: 0, status: "ok" } } : undefined;
}

const CONFIDENCE_ORDER: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

function relocateHop(hop: HopResult, candidate: GeoCandidate): HopResult {
  return {
    ...hop,
    city: candidate.city,
    country: candidate.country,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    // A runner-up that survived the physics check is worth showing, but it lost the evidence
    // vote, so it never gets to claim the top confidence its own source would have given it.
    locationConfidence: candidate.confidence === "high" ? "medium" : candidate.confidence,
    locationSource: candidate.source,
    locationPrecision: candidate.precision,
    locationEvidence: [
      ...(hop.locationEvidence ?? []).filter((line) => line !== "No reliable city-level evidence found"),
      ...candidate.evidence,
      "Placed here instead: the next answer the databases offered that the rest of the route can actually reach"
    ]
  };
}

function dropImpossiblePlacements(hops: HopResult[], source?: GeoPoint): HopResult[] {
  let current = hops;
  const anchor = anchorHop(source);

  // A contradiction names a pair, not a culprit, so clear one hop per pass and re-measure:
  // dropping the worst offender usually settles the hops it was fighting with.
  const trusted = new Set<number>();

  for (let pass = 0; pass < hops.length; pass += 1) {
    const placed = placedHops(current).filter((entry) => !trusted.has(entry.index));
    const worst = placed
      .map((entry) => {
        const others = placed.filter((other) => other.index !== entry.index);
        const fromProbe = anchor !== undefined && farFromProbe(entry, anchor);

        return {
          entry,
          conflicts: others.filter((other) => contradict(entry, other)).length + (fromProbe ? 1 : 0),
          fromProbe,
          // Hops agreeing on a location back each other up, so a lone outlier goes first.
          support: others.filter((other) => distanceKm(entry.point, other.point) < GEO_CONSENSUS_RADIUS_KM).length,
          confidence: CONFIDENCE_ORDER[entry.hop.locationConfidence ?? "low"]
        };
      })
      .filter((candidate) => candidate.conflicts > 0)
      .sort((a, b) => b.conflicts - a.conflicts || a.support - b.support || a.confidence - b.confidence)[0];

    if (!worst) {
      return current;
    }

    // A site code the operator wrote into the router's own name outranks any latency argument.
    // Inside an MPLS tunnel every hop answers with the egress router's RTT, which makes a real
    // Miami look unreachable from Frankfurt; keep the named hop and take it out of the
    // argument rather than let it drag its neighbours down with it.
    if (worst.entry.hop.locationSource === "reverse_dns" || worst.entry.hop.locationSource === "combined" || worst.entry.hop.locationSource === "ixp") {
      trusted.add(worst.entry.index);
      continue;
    }

    current = current.map((hop, index) =>
      index === worst.entry.index
        ? clearHopLocation(
            hop,
            worst.fromProbe
              ? `Dropped ${hop.city ?? "this location"}: it answers in ${hopRtt(hop) ?? "?"} ms, too soon for light to have gone there and back from the probe; the address may be anycast, served from a nearer site`
              : `Dropped ${hop.city ?? "this location"} because the rest of the route answers too soon after it for light to cover the distance`
          )
        : hop
    );
  }

  return current;
}

// The databases usually offered more than one answer per address, and losing the top spot only
// rules out that one place. Asking has to wait until the route is consistent though: a hop that
// is itself about to be dropped must not get to veto someone else's second choice.
function restoreFromAlternatives(hops: HopResult[], alternatives: GeoCandidate[][], source?: GeoPoint): HopResult[] {
  const latency = pathLatencies(hops);
  const anchor = anchorHop(source);
  let current = hops;

  for (const [index, candidates] of alternatives.entries()) {
    if (candidates.length === 0 || locatedPointFromHop(current[index]) || !Number.isFinite(latency[index])) {
      continue;
    }

    const placed = placedHops(current, latency);
    const fit = candidates.find((candidate) => {
      const entry = { index, point: candidate, latencyMs: latency[index], hop: current[index] };

      return placed.every((other) => !contradict(entry, other)) && !(anchor && farFromProbe(entry, anchor));
    });

    if (!fit) {
      continue;
    }

    current = current.map((hop, position) => (position === index ? relocateHop(hop, fit) : hop));
  }

  return current;
}

function isCorroboratedLocation(hops: HopResult[], index: number) {
  const hop = hops[index];
  const point = locatedPointFromHop(hop);

  if (!point) {
    return false;
  }

  if (hop.locationSource !== "geoip") {
    return true;
  }

  // A lone GeoIP answer is the weakest evidence there is, and a wrong registration address
  // repeats identically across every IP in the same network. Agreement only counts when it
  // comes from a different network.
  return hops.some((other, otherIndex) => {
    if (otherIndex === index || other.asn === hop.asn) {
      return false;
    }

    const otherPoint = locatedPointFromHop(other);

    return Boolean(otherPoint) && distanceKm(point, otherPoint as GeoPoint) < 120;
  });
}

function isAnchorHop(hops: HopResult[], index: number) {
  const hop = hops[index];

  return (
    (hop.locationConfidence === "high" || hop.locationConfidence === "medium") &&
    hopRtt(hop) !== undefined &&
    isCorroboratedLocation(hops, index)
  );
}

function nearestAnchorHop(hops: HopResult[], startIndex: number, step: -1 | 1) {
  for (let index = startIndex; index >= 0 && index < hops.length; index += step) {
    if (isAnchorHop(hops, index)) {
      return hops[index];
    }
  }

  return undefined;
}

function fillFromRttNeighbors(hops: HopResult[], source?: GeoPoint): HopResult[] {
  const probe = anchorHop(source);

  return hops.map((hop, index) => {
    const rttMs = hopRtt(hop);

    if (locatedPointFromHop(hop) || !hop.ip || rttMs === undefined) {
      return hop;
    }

    // Latency to the probe is what bounds a hop's distance, so only an anchor answering at
    // practically the same latency can stand in for it. This claims an area, never a city.
    const anchor = [nearestAnchorHop(hops, index - 1, -1), nearestAnchorHop(hops, index + 1, 1)]
      .filter((candidate): candidate is HopResult => Boolean(candidate))
      .map((candidate) => ({ candidate, delta: Math.abs((hopRtt(candidate) as number) - rttMs) }))
      .filter((entry) => entry.delta <= RTT_NEIGHBOR_TOLERANCE_MS)
      .sort((a, b) => a.delta - b.delta)[0]?.candidate;

    const point = anchor ? locatedPointFromHop(anchor) : undefined;

    // The probe's own distance still bounds the hop. A router answering the probe in a
    // millisecond is not in the next city, however close in latency its neighbour is:
    // the first hops of a Milan probe answer at once and were inheriting Turin, the first
    // city named further along.
    if (!anchor || !point || (probe && farFromProbe({ index, point, latencyMs: rttMs, hop }, probe))) {
      return hop;
    }

    return {
      ...hop,
      city: anchor.city,
      country: anchor.country,
      latitude: anchor.latitude,
      longitude: anchor.longitude,
      locationConfidence: "low",
      locationSource: "rtt_neighbor",
      locationPrecision: "metro",
      locationEvidence: [
        ...(hop.locationEvidence ?? []).filter((line) => line !== "No reliable city-level evidence found"),
        `Answers in ${rttMs} ms like hop ${anchor.hopNumber} (${anchor.city ?? "anchor"}, ${hopRtt(anchor)} ms), so it shares that metro area; exact city unknown`
      ]
    };
  });
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

  const enrichedHops = await mapWithConcurrency(params.hops, GEO_LOOKUP_CONCURRENCY, (hop) =>
    enrichHop(hop, source)
  );

  return fillFromRttNeighbors(
    restoreFromAlternatives(
      dropImpossiblePlacements(stabilizeRouteLocations(enrichedHops.map((entry) => entry.hop)), source),
      enrichedHops.map((entry) => entry.alternatives),
      source
    ),
    source
  ).map((hop) => {
    const network = networkRecord(hop.asn);

    return network ? { ...hop, asName: hop.asName ?? network.name, asOrg: network.organisation } : hop;
  });
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
