import type {
  HopResult,
  MeasurementEvent,
  MeasurementResult,
  TraceMode,
  VisitorContext
} from "../../shared/types";
import { PROBE_LOCATIONS, findProbeLocation } from "../../shared/probes";
import { enrichHopsWithGeo, measurementConfidence } from "../geoInference";
import {
  asnDigitsFromText,
  isAsciiDigit,
  isDecimalToken,
  isDigitsOnly,
  isWhitespace,
  splitWhitespace
} from "../textParsing";

const DEFAULT_API_URL = "https://api.globalping.io/v1/measurements";
const PROVIDER_TIMEOUT_MS = 42_000;
const POLL_INTERVAL_MS = 1_250;
// Probes in the same city sit on different networks, and the network decides the path: a
// cloud probe rides a private backbone that answers nothing, a home-ISP probe crosses the
// public internet router by router. Asking a few and keeping the most talkative path costs
// no extra wall time because Globalping runs them in parallel.
const PROBE_CANDIDATES = Number(process.env.GLOBALPING_PROBE_CANDIDATES ?? 3);
// Globalping meters tests per hour per source address, and the whole site shares one. Every
// measurement asks the same number of probes regardless - a thinner result is not a fair
// trade for a fuller budget - so the only thing read back is when the hour resets, to tell a
// visitor who hits the wall how long to wait.
let limitResetAt: number | undefined;
let limitRemaining: number | undefined;
let limitTotal: number | undefined;

export function resetGlobalpingState() {
  limitResetAt = undefined;
  limitRemaining = undefined;
  limitTotal = undefined;
}

// What is left of this hour's measurements. The headers on our own calls say so, but only
// once one has been made, so this asks the provider outright: it publishes the count for the
// caller's address at /limits, which is the same allowance our measurements spend.
export async function globalpingBudget() {
  const base = (process.env.GLOBALPING_API_URL ?? DEFAULT_API_URL).replace(/\/measurements\/?$/, "");
  const token = process.env.GLOBALPING_TOKEN?.trim();
  const asked = await fetch(`${base}/limits`, {
    headers: token ? { accept: "application/json", authorization: `Bearer ${token}` } : { accept: "application/json" },
    signal: AbortSignal.timeout(4_000)
  })
    .then((response) => (response.ok ? (response.json() as Promise<unknown>) : undefined))
    .catch(() => undefined);
  const create = (asked as { rateLimit?: { measurements?: { create?: Record<string, number> } } } | undefined)?.rateLimit?.measurements
    ?.create;

  if (create && typeof create.remaining === "number") {
    return { remaining: create.remaining, total: create.limit, resetsInSeconds: create.reset };
  }

  // Failing that, whatever the last measurement's own headers said.
  return {
    remaining: limitRemaining,
    total: limitTotal,
    resetsInSeconds: limitResetAt === undefined ? undefined : Math.max(0, Math.round((limitResetAt - Date.now()) / 1_000))
  };
}

function headerNumber(response: Response, name: string) {
  const raw = response.headers.get(name);
  const value = raw === null ? Number.NaN : Number(raw);

  return Number.isFinite(value) ? value : undefined;
}

function noteRateLimit(response: Response) {
  const resetSeconds = headerNumber(response, "x-ratelimit-reset");

  if (resetSeconds !== undefined) {
    limitResetAt = Date.now() + resetSeconds * 1_000;
  }

  limitRemaining = headerNumber(response, "x-ratelimit-remaining") ?? limitRemaining;
  limitTotal = headerNumber(response, "x-ratelimit-limit") ?? limitTotal;
}

function minutesUntilReset() {
  return limitResetAt === undefined ? 60 : Math.max(1, Math.ceil((limitResetAt - Date.now()) / 60_000));
}
const GLOBALPING_MAX_MTR_PACKETS = 16;
const GLOBALPING_MTR_PROTOCOLS = ["ICMP", "TCP"] as const;

type GlobalpingProtocol = (typeof GLOBALPING_MTR_PROTOCOLS)[number];

interface GlobalpingMeasurementParams {
  id: string;
  target: string;
  mode: TraceMode;
  from?: string;
  visitor?: VisitorContext;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function locationMagic(visitor?: VisitorContext) {
  const timeZone = visitor?.timeZone ?? "";
  const locale = visitor?.locale ?? "";

  if (timeZone.includes("Seoul") || locale.toLowerCase().includes("ko")) {
    return "South Korea";
  }

  if (timeZone.includes("Tokyo")) {
    return "Japan";
  }

  if (timeZone.includes("Singapore")) {
    return "Singapore";
  }

  if (timeZone.includes("Los_Angeles")) {
    return "California";
  }

  if (timeZone.includes("New_York")) {
    return "New York";
  }

  return "World";
}

function requestLocations(measurement: GlobalpingMeasurementParams) {
  const probe = findProbeLocation(measurement.from);

  if (!probe) {
    return [{ magic: locationMagic(measurement.visitor) }];
  }

  // A city pins the pool to a few probes that often share one cloud backbone. Where the
  // selector lists a single city for the country, the whole country is the pool instead: a
  // home-ISP probe in the next town crosses the public internet router by router, and the
  // result names the city it actually ran from. Structured fields either way, so the
  // provider cannot fuzzy-match the pick somewhere else.
  const citiesInCountry = PROBE_LOCATIONS.filter((entry) => entry.country === probe.country).length;

  return citiesInCountry > 1 ? [{ city: probe.city, country: probe.country }] : [{ country: probe.country }];
}

function headers() {
  const token = process.env.GLOBALPING_TOKEN;
  const result: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json"
  };

  if (token) {
    result.authorization = `Bearer ${token}`;
  }

  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.endsWith("%") ? value.slice(0, -1) : value;
    const parsed = Number(normalized);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function pickNumber(source: unknown, keys: string[]): number | undefined {
  const record = asRecord(source);

  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = finiteNumber(record[key]);

    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function pickString(source: unknown, keys: string[]): string | undefined {
  const record = asRecord(source);

  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function normalizeAsn(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return `AS${Math.trunc(value)}`;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return undefined;
    }

    if (trimmed.toUpperCase() === "AS???") {
      return "AS???";
    }

    const asDigits = asnDigitsFromText(trimmed);

    if (asDigits) {
      return `AS${asDigits}`;
    }

    if (isDigitsOnly(trimmed, 10) && Number(trimmed) > 0) {
      return `AS${trimmed}`;
    }
  }

  const record = asRecord(value);

  if (record) {
    return normalizeAsn(record.asn ?? record.number ?? record.id ?? record.value);
  }

  return undefined;
}

function isPrivateIp(ip?: string) {
  if (!ip) {
    return false;
  }

  const octets = ip.split(".").map(Number);

  if (octets.length !== 4 || !octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    return false;
  }

  const [a, b] = octets;

  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function inferAsn(ip?: string, hostname?: string) {
  const host = hostname?.toLowerCase() ?? "";

  if (isPrivateIp(ip)) {
    return "AS???";
  }

  if (
    host.includes("google") ||
    host.includes("1e100.net") ||
    ip?.startsWith("142.250.") ||
    ip?.startsWith("142.251.") ||
    ip?.startsWith("108.170.") ||
    ip?.startsWith("72.14.") ||
    ip?.startsWith("192.178.")
  ) {
    return "AS15169";
  }

  if (host.includes("cloudflare") || ip === "1.1.1.1" || ip?.startsWith("172.64.")) {
    return "AS13335";
  }

  if (
    host.includes("ionos") ||
    host.includes("1and1") ||
    host.includes("oneandone") ||
    ip?.startsWith("212.227.") ||
    ip?.startsWith("82.165.")
  ) {
    return "AS8560";
  }

  if (host.includes("telstraglobal.net") || ip?.startsWith("202.84.")) {
    return "AS4637";
  }

  return undefined;
}

function getAsn(entry: unknown, ip?: string, hostname?: string) {
  const value = asRecord(entry);
  const network = asRecord(value?.network);
  const asInfo = asRecord(value?.as) ?? asRecord(value?.autonomousSystem);
  const candidates = [
    value?.asn,
    value?.as,
    value?.asNumber,
    value?.autonomousSystem,
    value?.resolvedAsn,
    value?.resolvedASN,
    network?.asn,
    network?.number,
    asInfo?.asn,
    asInfo?.number,
    asInfo?.id
  ];

  for (const candidate of candidates) {
    const asn = normalizeAsn(candidate);

    if (asn) {
      return asn;
    }
  }

  return inferAsn(ip, hostname);
}

function getAsName(entry: unknown) {
  const value = asRecord(entry);
  const network = asRecord(value?.network);
  const asInfo = asRecord(value?.as) ?? asRecord(value?.autonomousSystem);

  return pickString(value, ["asName", "networkName", "autonomousSystemName", "owner"]) ??
    pickString(network, ["name", "description", "owner"]) ??
    pickString(asInfo, ["name", "description", "owner"]);
}

function getHopLocation(entry: unknown) {
  const value = asRecord(entry);
  const location =
    asRecord(value?.location) ??
    asRecord(value?.geo) ??
    asRecord(value?.geoip) ??
    asRecord(value?.geolocation);

  return {
    city: pickString(value, ["city", "resolvedCity"]) ?? pickString(location, ["city", "name"]),
    country:
      pickString(value, ["country", "countryCode", "resolvedCountry"]) ??
      pickString(location, ["country", "countryCode", "country_code"]),
    latitude:
      pickNumber(value, ["latitude", "lat"]) ??
      pickNumber(location, ["latitude", "lat"]),
    longitude:
      pickNumber(value, ["longitude", "lon", "lng"]) ??
      pickNumber(location, ["longitude", "lon", "lng"])
  };
}

function getRttMs(entry: unknown): number | undefined {
  const value = asRecord(entry);

  if (!value) {
    return undefined;
  }

  const stats = asRecord(value.stats);
  const timings = Array.isArray(value.timings) ? value.timings : [];
  const timingRtts = timings
    .map((timing) => asRecord(timing)?.rtt)
    .filter((rtt): rtt is number => typeof rtt === "number" && Number.isFinite(rtt));
  const timingAverage =
    timingRtts.length > 0
      ? timingRtts.reduce((sum, rtt) => sum + rtt, 0) / timingRtts.length
      : undefined;
  const timingMinimum = timingRtts.length > 0 ? Math.min(...timingRtts) : undefined;
  // The smallest round trip seen: queueing and a router's own delay in replying only ever
  // add to a round trip, so the minimum is the closest measure of propagation - what
  // places a hop and what a leg's speed is read from. The averages are the fallback.
  const candidates = [
    stats?.min,
    value.min,
    value.best,
    timingMinimum,
    value.rtt,
    value.avg,
    value.mean,
    value.latency,
    value.last,
    stats?.avg,
    timingAverage
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.round(candidate);
    }
  }

  return undefined;
}

function resultRecord(payload: unknown) {
  const outer = asRecord(payload);

  if (!outer) {
    return undefined;
  }

  return asRecord(outer.result) ?? outer;
}

function statsJitterMs(stats?: Record<string, unknown>) {
  if (typeof stats?.jAvg === "number") {
    return Math.round(stats.jAvg);
  }

  if (typeof stats?.stDev === "number") {
    return Math.round(stats.stDev);
  }

  return pickNumber(stats, ["jitter", "jitterAvg", "stdev", "stddev"]);
}

function packetLossFromResult(value: Record<string, unknown>) {
  if (typeof value.loss === "number") {
    return value.loss;
  }

  if (typeof value.packetLoss === "number") {
    return value.packetLoss;
  }

  return undefined;
}

function resultFailureMessage(payload: unknown) {
  const result = resultRecord(payload);
  const status = pickString(result, ["status"]);

  if (status !== "failed") {
    return undefined;
  }

  return (
    pickString(result, ["rawOutput", "error", "message"]) ??
    "The measurement provider returned a failed result."
  );
}

function shouldRetryMtrWithTcp(message: string) {
  const normalized = message.toLowerCase();

  return normalized.includes("private ip ranges") || normalized.includes("not allowed");
}

function normalizeStatus(rttMs?: number, loss?: number): HopResult["status"] {
  if (loss && loss >= 50) {
    return "loss";
  }

  if (rttMs === undefined) {
    return "timeout";
  }

  if (rttMs > 120) {
    return "slow";
  }

  return "ok";
}

function decimalEndIndex(value: string, startIndex: number) {
  let endIndex = startIndex;
  let decimalPoints = 0;

  while (endIndex < value.length) {
    const character = value[endIndex];

    if (isAsciiDigit(character)) {
      endIndex += 1;
      continue;
    }

    if (character === "." && decimalPoints === 0) {
      decimalPoints += 1;
      endIndex += 1;
      continue;
    }

    break;
  }

  return endIndex;
}

function whitespaceEndIndex(value: string, startIndex: number) {
  let endIndex = startIndex;

  while (endIndex < value.length && isWhitespace(value[endIndex])) {
    endIndex += 1;
  }

  return endIndex;
}

function hasMillisecondsUnitAt(value: string, index: number) {
  return value[index]?.toLowerCase() === "m" && value[index + 1]?.toLowerCase() === "s";
}

function rttValues(rawHop: string) {
  const values: number[] = [];
  let cursor = 0;

  while (cursor < rawHop.length) {
    if (!isAsciiDigit(rawHop[cursor])) {
      cursor += 1;
      continue;
    }

    const endIndex = decimalEndIndex(rawHop, cursor);
    const unitIndex = whitespaceEndIndex(rawHop, endIndex);

    if (hasMillisecondsUnitAt(rawHop, unitIndex)) {
      values.push(Number(rawHop.slice(cursor, endIndex)));
    }

    cursor = endIndex;
  }

  return values;
}

// The smallest of a hop's tries, for the reason given at getRttMs.
function minimumRtt(values: number[]) {
  if (values.length === 0) {
    return undefined;
  }

  return Math.round(Math.min(...values));
}

function parseMtrMetrics(tokens: string[]) {
  const lossIndex = tokens.findIndex((token) => token.endsWith("%") && isDecimalToken(token.slice(0, -1)));

  if (lossIndex < 0) {
    return {};
  }

  const dropped = finiteNumber(tokens[lossIndex + 1]);
  const received = finiteNumber(tokens[lossIndex + 2]);
  const sent = dropped !== undefined && received !== undefined
    ? dropped + received
    : finiteNumber(tokens[lossIndex + 1]);

  return {
    avgRtt: finiteNumber(tokens[lossIndex + 3]),
    jitterMs: finiteNumber(tokens[lossIndex + 5]) ?? finiteNumber(tokens[lossIndex + 4]),
    loss: finiteNumber(tokens[lossIndex]),
    sent
  };
}

function parseHopLine(line: string) {
  let index = 0;

  while (index < line.length && isAsciiDigit(line[index])) {
    index += 1;
  }

  if (index === 0) {
    return undefined;
  }

  const hopNumber = Number(line.slice(0, index));

  if (line[index] === "." || line[index] === ")") {
    index += 1;
  }

  if (index >= line.length || !isWhitespace(line[index])) {
    return undefined;
  }

  while (index < line.length && isWhitespace(line[index])) {
    index += 1;
  }

  const rest = line.slice(index);

  return rest ? { hopNumber, rest } : undefined;
}

function possibleIpv4EndIndex(value: string, startIndex: number) {
  let endIndex = startIndex;

  while (endIndex < value.length && (isAsciiDigit(value[endIndex]) || value[endIndex] === ".")) {
    endIndex += 1;
  }

  return endIndex;
}

function isValidIpv4Candidate(candidate: string) {
  const octets = candidate.split(".");

  return (
    octets.length === 4 &&
    octets.every((octet) => isDigitsOnly(octet, 3) && Number(octet) >= 0 && Number(octet) <= 255)
  );
}

function findIpv4(value: string) {
  let cursor = 0;

  while (cursor < value.length) {
    if (!isAsciiDigit(value[cursor])) {
      cursor += 1;
      continue;
    }

    const endIndex = possibleIpv4EndIndex(value, cursor);
    const candidate = value.slice(cursor, endIndex);

    if (isValidIpv4Candidate(candidate)) {
      return candidate;
    }

    cursor = endIndex;
  }

  return undefined;
}

function rawHopHostname(tokens: string[], waitingForReply: boolean) {
  const firstHostToken = tokens[0];

  if (waitingForReply || !firstHostToken || firstHostToken === "*" || firstHostToken === "???") {
    return undefined;
  }

  return firstHostToken;
}

function parseRawHop(line: string): HopResult | undefined {
  const hopLine = parseHopLine(line);

  if (!hopLine) {
    return undefined;
  }

  const { hopNumber, rest } = hopLine;
  const tokens = splitWhitespace(rest);
  const asnFromToken = normalizeAsn(tokens[0]);

  if (asnFromToken) {
    tokens.shift();
  }

  const waitingForReply = rest.includes("(waiting for reply)") || tokens.filter((token) => token === "*").length >= 2;
  const ip = findIpv4(rest);
  const metrics = parseMtrMetrics(tokens);
  const tries = rttValues(rest);
  const rttMs = metrics.avgRtt === undefined ? minimumRtt(tries) : Math.round(metrics.avgRtt);
  const hostname = rawHopHostname(tokens, waitingForReply);
  const loss = metrics.loss ?? (waitingForReply || rest.includes("*") ? 100 : 0);
  const lastTry = tries.at(-1);

  return {
    hopNumber,
    asn: asnFromToken ?? inferAsn(ip, hostname),
    hostname,
    ip,
    rttMs,
    sent: metrics.sent ? Math.trunc(metrics.sent) : undefined,
    lastMs: lastTry === undefined ? rttMs : Math.round(lastTry),
    bestMs: tries.length > 0 ? rttMs : undefined,
    worstMs: tries.length > 0 ? Math.round(Math.max(...tries)) : undefined,
    jitterMs: metrics.jitterMs === undefined ? undefined : Math.round(metrics.jitterMs),
    packetLossPercent: loss,
    status: normalizeStatus(rttMs, loss)
  };
}

export function parseRawTraceroute(raw: string): HopResult[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseRawHop)
    .filter((hop): hop is HopResult => Boolean(hop));
}

export function parseResultHops(payload: unknown): HopResult[] {
  const outer = asRecord(payload) ?? {};
  const result = resultRecord(payload) ?? outer;
  const rawOutput = result.rawOutput;
  const structuredHops = result.hops;

  if (Array.isArray(structuredHops) && structuredHops.length > 0) {
    return structuredHops.map((entry, index) => {
      const value = asRecord(entry) ?? {};
      const stats = asRecord(value.stats);
      const ip = pickString(value, ["resolvedAddress", "ip", "address"]);
      const hostname = pickString(value, ["resolvedHostname", "hostname", "host", "name"]);
      const location = getHopLocation(value);
      const rttMs = getRttMs(value);
      const loss = finiteNumber(stats?.loss);
      const jitterMs = statsJitterMs(stats);

      return {
        hopNumber: index + 1,
        asn: getAsn(value, ip, hostname),
        asName: getAsName(value),
        ip,
        hostname,
        city: location.city,
        country: location.country,
        latitude: location.latitude,
        longitude: location.longitude,
        rttMs,
        sent: pickNumber(stats, ["sent", "snt", "total", "count", "packets"]),
        lastMs: pickNumber(stats, ["last", "lastRtt", "current"]),
        bestMs: pickNumber(stats, ["best", "min", "minimum"]),
        worstMs: pickNumber(stats, ["worst", "max", "maximum"]),
        jitterMs,
        packetLossPercent: loss,
        status: normalizeStatus(rttMs, loss)
      } satisfies HopResult;
    });
  }

  if (Array.isArray(result.result)) {
    return result.result.map((entry, index) => {
      const value = asRecord(entry) ?? {};
      const ip = pickString(value, ["ip", "resolvedAddress", "address"]);
      const hostname = pickString(value, ["hostname", "resolvedHostname", "host", "name"]);
      const location = getHopLocation(value);
      const rttMs = getRttMs(value);
      const loss = packetLossFromResult(value);

      return {
        hopNumber: typeof value.hop === "number" ? value.hop : index + 1,
        asn: getAsn(value, ip, hostname),
        asName: getAsName(value),
        ip,
        hostname,
        city: location.city,
        country: location.country,
        latitude: location.latitude,
        longitude: location.longitude,
        rttMs,
        sent: pickNumber(value, ["sent", "snt", "total", "count", "packets"]),
        lastMs: pickNumber(value, ["last", "lastRtt", "current"]),
        bestMs: pickNumber(value, ["best", "min", "minimum"]),
        worstMs: pickNumber(value, ["worst", "max", "maximum"]),
        jitterMs: pickNumber(value, ["jitter", "jAvg", "stDev", "stdev", "stddev"]),
        packetLossPercent: loss,
        status: normalizeStatus(rttMs, loss)
      } satisfies HopResult;
    });
  }

  if (typeof rawOutput === "string") {
    const parsedRaw = parseRawTraceroute(rawOutput);

    if (parsedRaw.length > 0) {
      return parsedRaw;
    }
  }

  return [];
}

function extractSource(payload: unknown) {
  const value = asRecord(payload) ?? {};
  const probe = asRecord(value.probe);

  return {
    provider: "globalping" as const,
    probeId: typeof probe?.id === "string" ? probe.id : undefined,
    city: typeof probe?.city === "string" ? probe.city : undefined,
    country: typeof probe?.country === "string" ? probe.country : undefined,
    asn: normalizeAsn(probe?.asn),
    network: typeof probe?.network === "string" ? probe.network : undefined,
    latitude: typeof probe?.latitude === "number" ? probe.latitude : undefined,
    longitude: typeof probe?.longitude === "number" ? probe.longitude : undefined,
    note: "Measured from a nearby network probe. Not a direct trace from your device."
  };
}

function protocolsForMode(mode: TraceMode): readonly GlobalpingProtocol[] {
  return mode === "mtr" ? GLOBALPING_MTR_PROTOCOLS : ["ICMP"];
}

function measurementOptions(mode: TraceMode, protocol: GlobalpingProtocol) {
  if (mode !== "mtr") {
    return { protocol: "ICMP" };
  }

  return {
    protocol,
    packets: GLOBALPING_MAX_MTR_PACKETS
  };
}

async function createProviderMeasurement(params: {
  apiUrl: string;
  controller: AbortController;
  measurement: GlobalpingMeasurementParams;
  protocol: GlobalpingProtocol;
}) {
  const createResponse = await fetch(params.apiUrl, {
    method: "POST",
    headers: headers(),
    signal: params.controller.signal,
    body: JSON.stringify({
      // Globalping names its two measurements the same words this app does.
      type: params.measurement.mode,
      target: params.measurement.target,
      locations: requestLocations(params.measurement),
      limit: PROBE_CANDIDATES,
      measurementOptions: measurementOptions(params.measurement.mode, params.protocol)
    })
  });

  noteRateLimit(createResponse);

  if (createResponse.status === 429) {
    throw new Error(`Globalping hourly limit reached; resets in ${minutesUntilReset()} min`);
  }

  if (!createResponse.ok) {
    throw new Error(`Globalping returned ${createResponse.status}`);
  }

  const created = (await createResponse.json()) as { id?: string };

  if (!created.id) {
    throw new Error("Globalping did not return a measurement id.");
  }

  return created.id;
}

async function pollProviderMeasurement(apiUrl: string, providerId: string, controller: AbortController) {
  const pollResponse = await fetch(`${apiUrl}/${providerId}`, {
    headers: headers(),
    signal: controller.signal
  });

  if (!pollResponse.ok) {
    throw new Error(`Globalping poll returned ${pollResponse.status}`);
  }

  return (await pollResponse.json()) as Record<string, unknown>;
}

function providerResults(payload: Record<string, unknown>) {
  return Array.isArray(payload.results) ? payload.results : [];
}

// The path that shows the most routers is the one worth drawing. Counted before enrichment,
// so a long run of same-city hops can beat a shorter path with more distinct places.
// ponytail: cheap proxy; count distinct places instead if this picks the wrong probe often.
function richestProviderResult(payload: Record<string, unknown>) {
  let best: { result: unknown; index: number; answered: number } | undefined;

  providerResults(payload).forEach((result, index) => {
    if (resultFailureMessage(result)) {
      return;
    }

    const answered = parseResultHops(result).filter((hop) => hop.ip).length;

    if (!best || answered > best.answered) {
      best = { result, index, answered };
    }
  });

  return best;
}

// One probe failing is noise when the others answered; only a unanimous failure is an error.
function everyResultFailed(payload: Record<string, unknown>) {
  const messages = providerResults(payload).map((result) => resultFailureMessage(result));

  return messages.length > 0 && messages.every(Boolean) ? messages[0] : undefined;
}

function nextRetryProtocolIndex(params: {
  failureMessage: string;
  mode: TraceMode;
  protocolIndex: number;
  protocols: readonly GlobalpingProtocol[];
}) {
  const canRetry =
    params.mode === "mtr" &&
    params.protocols[params.protocolIndex] === "ICMP" &&
    shouldRetryMtrWithTcp(params.failureMessage) &&
    params.protocolIndex + 1 < params.protocols.length;

  return canRetry ? params.protocolIndex + 1 : undefined;
}

// With several probes in flight the first to finish must not end the measurement, so this
// waits for the provider to close it or for every probe to reach a terminal state.
function providerFinished(payload: Record<string, unknown>) {
  if (payload.status === "finished" || payload.status === "completed") {
    return true;
  }

  const results = providerResults(payload);

  return (
    results.length > 0 &&
    results.every((result) => {
      const status = pickString(resultRecord(result), ["status"]);

      return status === "finished" || status === "failed" || status === "offline";
    })
  );
}

// The probe reports what it resolved the target to; the header line of the raw output carries
// the same address for older payloads.
function targetAddress(payload: unknown) {
  const result = resultRecord(payload);
  const resolved = result ? pickString(result, ["resolvedAddress"]) : undefined;

  if (resolved) {
    return resolved;
  }

  const rawOutput = result ? pickString(result, ["rawOutput"]) : undefined;
  const header = rawOutput?.split("\n")[0] ?? "";
  const match = /\((\d{1,3}(?:\.\d{1,3}){3})\)/.exec(header);

  return match?.[1];
}

function applyProviderResult(currentResult: MeasurementResult, firstResult: unknown, hops: HopResult[]) {
  const source = extractSource(firstResult);
  const targetIp = targetAddress(firstResult);

  return {
    ...currentResult,
    source,
    hops,
    confidence: measurementConfidence(hops),
    targetIp,
    reachedTarget: targetIp ? hops.some((hop) => hop.ip === targetIp) : undefined
  };
}

function* newHopEvents(hops: HopResult[], emittedHopCount: number): Generator<MeasurementEvent> {
  for (const hop of hops.slice(emittedHopCount)) {
    yield { type: "hop_result", payload: hop };
  }
}

function* metricUpdateEvents(hops: HopResult[]): Generator<MeasurementEvent> {
  for (const hop of hops) {
    yield {
      type: "metric_update",
      payload: {
        hopNumber: hop.hopNumber,
        rttMs: hop.rttMs,
        jitterMs: hop.jitterMs,
        packetLossPercent: hop.packetLossPercent,
        status: hop.status
      }
    };
  }
}

export async function* runGlobalpingMeasurement(params: GlobalpingMeasurementParams): AsyncGenerator<MeasurementEvent> {
  const apiUrl = process.env.GLOBALPING_API_URL ?? DEFAULT_API_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const startedAt = new Date().toISOString();
    let currentResult: MeasurementResult = {
      id: params.id,
      mode: params.mode,
      target: params.target,
      status: "running",
      source: {
        provider: "globalping",
        note: "Measured from a nearby network probe. Not a direct trace from your device."
      },
      hops: [],
      confidence: "high",
      startedAt
    };

    yield { type: "measurement_started", payload: currentResult };

    const deadline = Date.now() + PROVIDER_TIMEOUT_MS;
    let emittedHopCount = 0;
    let streamedIndex: number | undefined;
    const protocols = protocolsForMode(params.mode);
    let protocolIndex = 0;
    let providerId = await createProviderMeasurement({
      apiUrl,
      controller,
      measurement: params,
      protocol: protocols[protocolIndex]
    });

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);

      const pollPayload = await pollProviderMeasurement(apiUrl, providerId, controller);
      const failureMessage = everyResultFailed(pollPayload);

      if (failureMessage) {
        const retryProtocolIndex = nextRetryProtocolIndex({
          failureMessage,
          mode: params.mode,
          protocolIndex,
          protocols
        });

        if (retryProtocolIndex !== undefined) {
          protocolIndex = retryProtocolIndex;
          emittedHopCount = 0;
          streamedIndex = undefined;
          providerId = await createProviderMeasurement({
            apiUrl,
            controller,
            measurement: params,
            protocol: protocols[protocolIndex]
          });
          continue;
        }

        throw new Error(`Globalping measurement failed. ${failureMessage}`);
      }

      const best = richestProviderResult(pollPayload);

      if (!best) {
        continue;
      }

      // A different probe pulling ahead mid-flight replaces what was streamed; resending from
      // hop 1 keeps the client's list consistent with the probe the result now names.
      if (best.index !== streamedIndex) {
        streamedIndex = best.index;
        emittedHopCount = 0;
      }

      const hops = await enrichHopsWithGeo({
        hops: parseResultHops(best.result),
        source: extractSource(best.result)
      });

      currentResult = applyProviderResult(currentResult, best.result, hops);

      yield* newHopEvents(hops, emittedHopCount);

      emittedHopCount = Math.max(emittedHopCount, hops.length);

      if (params.mode === "mtr") {
        yield* metricUpdateEvents(hops);
      }

      if (providerFinished(pollPayload)) {
        currentResult = {
          ...currentResult,
          status: "finished",
          finishedAt: new Date().toISOString()
        };
        yield { type: "measurement_finished", payload: currentResult };
        return;
      }
    }

    throw new Error("Globalping measurement timed out.");
  } finally {
    clearTimeout(timeout);
  }
}
