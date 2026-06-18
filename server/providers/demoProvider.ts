import type {
  HopResult,
  MeasurementEvent,
  MeasurementResult,
  TraceMode,
  VisitorContext
} from "../../shared/types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function guessCountry(visitor?: VisitorContext) {
  if (visitor?.timeZone?.includes("Seoul") || visitor?.locale?.toLowerCase().includes("ko")) {
    return { city: "Seoul", country: "South Korea", asn: "Nearby eyeball network" };
  }

  if (visitor?.timeZone?.includes("Tokyo")) {
    return { city: "Tokyo", country: "Japan", asn: "Nearby eyeball network" };
  }

  return { city: "Nearest available city", country: "Estimated region", asn: "Nearby probe network" };
}

function sourceEstimate(origin: ReturnType<typeof guessCountry>) {
  const isSeoul = origin.country === "South Korea";

  return {
    city: origin.city,
    country: origin.country,
    latitude: isSeoul ? 37.57 : undefined,
    longitude: isSeoul ? 126.98 : undefined,
    locationConfidence: isSeoul ? "medium" as const : "low" as const,
    locationSource: isSeoul ? "source_probe" as const : "unknown" as const,
    locationPrecision: isSeoul ? "metro" as const : "unknown" as const,
    locationEvidence: ["demo source estimate"]
  };
}

function demoTargetAsn(target: string) {
  if (target.includes("google")) {
    return "AS15169";
  }

  if (target === "1.1.1.1") {
    return "AS13335";
  }

  return "AS8560";
}

function demoTargetIp(target: string) {
  return target === "1.1.1.1" ? "1.1.1.1" : "192.0.2.80";
}

function demoBaseLatency(target: string) {
  if (target === "1.1.1.1") {
    return 13;
  }

  if (target.includes("google")) {
    return 22;
  }

  return 31;
}

function demoHop(params: {
  asn: string;
  city?: string;
  country?: string;
  hostname: string;
  hopNumber: number;
  ip: string;
  jitterMs: number;
  packetLossPercent: number;
  rttMs: number;
  status: HopResult["status"];
  source?: ReturnType<typeof sourceEstimate>;
}): HopResult {
  return {
    hopNumber: params.hopNumber,
    asn: params.asn,
    hostname: params.hostname,
    ip: params.ip,
    city: params.city,
    country: params.country,
    ...params.source,
    rttMs: params.rttMs,
    jitterMs: params.jitterMs,
    packetLossPercent: params.packetLossPercent,
    status: params.status
  };
}

function buildDemoHops(target: string, mode: TraceMode, visitor?: VisitorContext): HopResult[] {
  const origin = guessCountry(visitor);
  const base = demoBaseLatency(target);
  const source = sourceEstimate(origin);

  return [
    demoHop({
      hopNumber: 1,
      asn: "AS???",
      hostname: "nearby-probe.local",
      ip: "10.18.0.1",
      source,
      rttMs: base,
      jitterMs: 2,
      packetLossPercent: 0,
      status: "ok"
    }),
    demoHop({
      hopNumber: 2,
      asn: "AS???",
      hostname: "edge-gateway.net",
      ip: "172.18.42.1",
      source,
      rttMs: base + 6,
      jitterMs: 3,
      packetLossPercent: 0,
      status: "ok"
    }),
    demoHop({
      hopNumber: 3,
      asn: "AS64512",
      hostname: "regional-exchange.net",
      ip: "203.0.113.14",
      source,
      rttMs: base + 18,
      jitterMs: 5,
      packetLossPercent: mode === "mtr" ? 1 : 0,
      status: "ok"
    }),
    demoHop({
      hopNumber: 4,
      asn: "AS3356",
      hostname: "transit-backbone.example",
      ip: "198.51.100.35",
      city: "Oceanic backbone",
      country: "Transit",
      rttMs: base + 48,
      jitterMs: 9,
      packetLossPercent: mode === "mtr" ? 2 : 0,
      status: "slow"
    }),
    demoHop({
      hopNumber: 5,
      asn: demoTargetAsn(target),
      hostname: `edge.${target}`,
      ip: demoTargetIp(target),
      city: "Destination edge",
      country: "Target network",
      rttMs: base + 58,
      jitterMs: 6,
      packetLossPercent: 0,
      status: "ok"
    })
  ];
}

export async function* runDemoMeasurement(params: {
  id: string;
  target: string;
  mode: TraceMode;
  visitor?: VisitorContext;
}): AsyncGenerator<MeasurementEvent> {
  const source = guessCountry(params.visitor);
  const startedAt = new Date().toISOString();
  const hops = buildDemoHops(params.target, params.mode, params.visitor);

  const initial: MeasurementResult = {
    id: params.id,
    mode: params.mode,
    target: params.target,
    status: "running",
    source: {
      provider: "demo",
      city: source.city,
      country: source.country,
      asn: source.asn,
      latitude: source.country === "South Korea" ? 37.57 : undefined,
      longitude: source.country === "South Korea" ? 126.98 : undefined,
      note: "Measured from a nearby network probe. Demo fallback is active because the live provider was unavailable."
    },
    hops: [],
    confidence: "medium",
    startedAt
  };

  yield { type: "measurement_started", payload: initial };

  for (const hop of hops) {
    await sleep(params.mode === "mtr" ? 520 : 680);
    yield { type: "hop_result", payload: hop };
  }

  if (params.mode === "mtr") {
    for (let round = 0; round < 4; round += 1) {
      await sleep(750);
      for (const hop of hops) {
        const drift = (round + hop.hopNumber) % 3;
        yield {
          type: "metric_update",
          payload: {
            hopNumber: hop.hopNumber,
            rttMs: Math.round((hop.rttMs ?? 20) + drift * 3),
            jitterMs: Math.round((hop.jitterMs ?? 2) + drift),
            packetLossPercent: hop.packetLossPercent ?? 0,
            status: hop.status
          }
        };
      }
    }
  }

  yield {
    type: "measurement_finished",
    payload: {
      ...initial,
      status: "finished",
      hops,
      finishedAt: new Date().toISOString()
    }
  };
}
