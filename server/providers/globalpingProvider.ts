import type {
  HopResult,
  MeasurementEvent,
  MeasurementResult,
  TraceMode,
  VisitorContext
} from "../../shared/types";
import { enrichHopsWithGeo, measurementConfidence } from "../geoInference";

const DEFAULT_API_URL = "https://api.globalping.io/v1/measurements";
const PROVIDER_TIMEOUT_MS = 42_000;
const POLL_INTERVAL_MS = 1_250;
const GLOBALPING_MAX_MTR_PACKETS = 16;
const GLOBALPING_MTR_PROTOCOLS = ["ICMP", "TCP"] as const;

type GlobalpingProtocol = (typeof GLOBALPING_MTR_PROTOCOLS)[number];

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
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace("%", ""));

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

    if (/^AS\?\?\?$/i.test(trimmed)) {
      return "AS???";
    }

    const asMatch = trimmed.match(/\bAS\s*(\d+)\b/i);

    if (asMatch) {
      return `AS${asMatch[1]}`;
    }

    if (/^\d{1,10}$/.test(trimmed)) {
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

  const octets = ip.split(".").map((part) => Number(part));

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
  if (!entry || typeof entry !== "object") {
    return undefined;
  }

  const value = entry as Record<string, unknown>;
  const stats = value.stats as Record<string, unknown> | undefined;
  const timings = Array.isArray(value.timings) ? value.timings : [];
  const timingRtts = timings
    .map((timing) => (timing as Record<string, unknown>).rtt)
    .filter((rtt): rtt is number => typeof rtt === "number" && Number.isFinite(rtt));
  const timingAverage =
    timingRtts.length > 0
      ? timingRtts.reduce((sum, rtt) => sum + rtt, 0) / timingRtts.length
      : undefined;
  const candidates = [
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

function parseRawTraceroute(raw: string): HopResult[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): HopResult | undefined => {
      const hopMatch = line.match(/^(\d+)[.)]?\s+(.+)$/);

      if (!hopMatch) {
        return undefined;
      }

      const hopNumber = Number(hopMatch[1]);
      const rest = hopMatch[2];
      const tokens = rest.split(/\s+/).filter(Boolean);
      let asn = normalizeAsn(tokens[0]);

      if (asn) {
        tokens.shift();
      }

      const waitingForReply = rest.includes("(waiting for reply)") || /\*\s+\*/.test(rest);
      const ipMatch = rest.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
      const rttMatches = [...rest.matchAll(/(\d+(?:\.\d+)?)\s*ms/g)].map((match) => Number(match[1]));
      const lossIndex = tokens.findIndex((token) => /^\d+(?:\.\d+)?%$/.test(token));
      const mtrLoss = lossIndex >= 0 ? finiteNumber(tokens[lossIndex]) : undefined;
      const dropped = lossIndex >= 0 ? finiteNumber(tokens[lossIndex + 1]) : undefined;
      const received = lossIndex >= 0 ? finiteNumber(tokens[lossIndex + 2]) : undefined;
      const avgFromMtr = lossIndex >= 0 ? finiteNumber(tokens[lossIndex + 3]) : undefined;
      const stDevFromMtr = lossIndex >= 0 ? finiteNumber(tokens[lossIndex + 4]) : undefined;
      const jAvgFromMtr = lossIndex >= 0 ? finiteNumber(tokens[lossIndex + 5]) : undefined;
      const sent =
        dropped !== undefined && received !== undefined
          ? dropped + received
          : lossIndex >= 0
            ? finiteNumber(tokens[lossIndex + 1])
            : undefined;
      const avgRtt =
        avgFromMtr !== undefined
          ? Math.round(avgFromMtr)
          : rttMatches.length > 0
            ? Math.round(rttMatches.reduce((sum, value) => sum + value, 0) / rttMatches.length)
            : undefined;
      const firstHostToken = tokens[0];
      const hostname =
        !waitingForReply && firstHostToken && firstHostToken !== "*" && firstHostToken !== "???"
          ? firstHostToken
          : undefined;
      const loss = mtrLoss ?? (waitingForReply || rest.includes("*") ? 100 : 0);
      const ip = ipMatch?.[1];
      asn = asn ?? inferAsn(ip, hostname);

      const hop: HopResult = {
        hopNumber,
        asn,
        hostname,
        ip,
        rttMs: avgRtt,
        sent: sent ? Math.trunc(sent) : undefined,
        lastMs: avgRtt,
        bestMs: undefined,
        worstMs: undefined,
        jitterMs:
          jAvgFromMtr !== undefined
            ? Math.round(jAvgFromMtr)
            : stDevFromMtr !== undefined
              ? Math.round(stDevFromMtr)
              : undefined,
        packetLossPercent: loss,
        status: normalizeStatus(avgRtt, loss)
      };

      return hop;
    })
    .filter((hop): hop is HopResult => Boolean(hop));
}

function parseResultHops(payload: unknown): HopResult[] {
  const outer = payload as Record<string, unknown>;
  const result = resultRecord(payload) ?? outer;
  const rawOutput = result.rawOutput;
  const structuredHops = result.hops;

  if (Array.isArray(structuredHops) && structuredHops.length > 0) {
    return structuredHops.map((entry, index) => {
      const value = entry as Record<string, unknown>;
      const stats = value.stats as Record<string, unknown> | undefined;
      const ip = pickString(value, ["resolvedAddress", "ip", "address"]);
      const hostname = pickString(value, ["resolvedHostname", "hostname", "host", "name"]);
      const location = getHopLocation(value);
      const rttMs = getRttMs(value);
      const loss = finiteNumber(stats?.loss);
      const jitterMs =
        typeof stats?.jAvg === "number"
          ? Math.round(stats.jAvg)
          : typeof stats?.stDev === "number"
            ? Math.round(stats.stDev)
            : pickNumber(stats, ["jitter", "jitterAvg", "stdev", "stddev"]);

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
      const value = entry as Record<string, unknown>;
      const ip = pickString(value, ["ip", "resolvedAddress", "address"]);
      const hostname = pickString(value, ["hostname", "resolvedHostname", "host", "name"]);
      const location = getHopLocation(value);
      const rttMs = getRttMs(value);
      const loss =
        typeof value.loss === "number"
          ? value.loss
          : typeof value.packetLoss === "number"
            ? value.packetLoss
            : undefined;

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
  const value = payload as Record<string, unknown>;
  const probe = value.probe as Record<string, unknown> | undefined;

  return {
    provider: "globalping" as const,
    probeId: typeof probe?.id === "string" ? probe.id : undefined,
    city: typeof probe?.city === "string" ? probe.city : undefined,
    country: typeof probe?.country === "string" ? probe.country : undefined,
    asn: normalizeAsn(probe?.asn),
    latitude: typeof probe?.latitude === "number" ? probe.latitude : undefined,
    longitude: typeof probe?.longitude === "number" ? probe.longitude : undefined,
    note: "Measured from a nearby network probe. Not a direct trace from your device."
  };
}

export async function* runGlobalpingMeasurement(params: {
  id: string;
  target: string;
  mode: TraceMode;
  visitor?: VisitorContext;
}): AsyncGenerator<MeasurementEvent> {
  const apiUrl = process.env.GLOBALPING_API_URL ?? DEFAULT_API_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  const measurementType = params.mode === "traceout" ? "traceroute" : "mtr";
  const buildMeasurementOptions = (protocol: GlobalpingProtocol) =>
    params.mode === "mtr"
      ? {
          protocol,
          packets: GLOBALPING_MAX_MTR_PACKETS
        }
      : {
          protocol: "ICMP"
        };
  const createProviderMeasurement = async (protocol: GlobalpingProtocol) => {
    const createResponse = await fetch(apiUrl, {
      method: "POST",
      headers: headers(),
      signal: controller.signal,
      body: JSON.stringify({
        type: measurementType,
        target: params.target,
        locations: [{ magic: locationMagic(params.visitor) }],
        limit: 1,
        measurementOptions: buildMeasurementOptions(protocol)
      })
    });

    if (!createResponse.ok) {
      throw new Error(`Globalping returned ${createResponse.status}`);
    }

    const created = (await createResponse.json()) as { id?: string };

    if (!created.id) {
      throw new Error("Globalping did not return a measurement id.");
    }

    return created.id;
  };

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
    const protocols = params.mode === "mtr" ? GLOBALPING_MTR_PROTOCOLS : (["ICMP"] as const);
    let protocolIndex = 0;
    let providerId = await createProviderMeasurement(protocols[protocolIndex]);

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);

      const pollResponse = await fetch(`${apiUrl}/${providerId}`, {
        headers: headers(),
        signal: controller.signal
      });

      if (!pollResponse.ok) {
        throw new Error(`Globalping poll returned ${pollResponse.status}`);
      }

      const pollPayload = (await pollResponse.json()) as Record<string, unknown>;
      const results = Array.isArray(pollPayload.results) ? pollPayload.results : [];
      const firstResult = results[0];

      if (!firstResult) {
        continue;
      }

      const failureMessage = resultFailureMessage(firstResult);

      if (failureMessage) {
        const canRetryWithTcp =
          params.mode === "mtr" &&
          protocols[protocolIndex] === "ICMP" &&
          shouldRetryMtrWithTcp(failureMessage) &&
          protocolIndex + 1 < protocols.length;

        if (canRetryWithTcp) {
          protocolIndex += 1;
          emittedHopCount = 0;
          providerId = await createProviderMeasurement(protocols[protocolIndex]);
          continue;
        }

        throw new Error(`Globalping measurement failed. ${failureMessage}`);
      }

      const source = extractSource(firstResult);
      const hops = await enrichHopsWithGeo({
        hops: parseResultHops(firstResult),
        source
      });

      currentResult = {
        ...currentResult,
        source,
        hops,
        confidence: measurementConfidence(hops)
      };

      for (const hop of hops.slice(emittedHopCount)) {
        yield { type: "hop_result", payload: hop };
      }

      emittedHopCount = Math.max(emittedHopCount, hops.length);

      if (params.mode === "mtr") {
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

      if (pollPayload.status === "finished" || pollPayload.status === "completed" || hops.length > 0) {
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
