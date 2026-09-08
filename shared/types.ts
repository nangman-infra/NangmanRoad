export type TraceMode = "traceroute" | "mtr";

export type MeasurementStatus =
  | "idle"
  | "starting"
  | "running"
  | "finished"
  | "error";

export type Confidence = "high" | "medium" | "low";

export type HopStatus = "pending" | "ok" | "slow" | "loss" | "timeout";

export type HopLocationSource =
  | "provider"
  | "reverse_dns"
  | "ixp"
  | "geoip"
  | "combined"
  | "rtt_neighbor"
  | "source_probe"
  | "unknown";

export type HopLocationPrecision = "exact" | "city" | "metro" | "country" | "unknown";

export interface VisitorContext {
  timeZone?: string;
  locale?: string;
}

export interface MeasurementSource {
  provider: "globalping" | "demo";
  probeId?: string;
  city?: string;
  country?: string;
  asn?: string;
  network?: string;
  latitude?: number;
  longitude?: number;
  note: string;
}

export interface HopResult {
  hopNumber: number;
  asn?: string;
  asName?: string;
  // The organisation behind the network, as PeeringDB records it.
  asOrg?: string;
  ip?: string;
  hostname?: string;
  city?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  locationConfidence?: Confidence;
  locationSource?: HopLocationSource;
  locationPrecision?: HopLocationPrecision;
  locationEvidence?: string[];
  rttMs?: number;
  sent?: number;
  lastMs?: number;
  bestMs?: number;
  worstMs?: number;
  jitterMs?: number;
  packetLossPercent?: number;
  status: HopStatus;
}

export interface MeasurementResult {
  id: string;
  mode: TraceMode;
  target: string;
  status: MeasurementStatus;
  source: MeasurementSource;
  hops: HopResult[];
  confidence: Confidence;
  startedAt: string;
  finishedAt?: string;
  // The address the probe resolved the target to, and whether any hop answered from it. A
  // trace that ends on some other router must not have the target's name pinned to it.
  targetIp?: string;
  reachedTarget?: boolean;
}

export type MeasurementEventType =
  | "measurement_started"
  | "hop_result"
  | "metric_update"
  | "measurement_finished"
  | "error";

export type MeasurementEvent =
  | {
      type: "measurement_started";
      payload: MeasurementResult;
    }
  | {
      type: "hop_result";
      payload: HopResult;
    }
  | {
      type: "metric_update";
      payload: {
        hopNumber: number;
        rttMs?: number;
        jitterMs?: number;
        packetLossPercent?: number;
        status: HopStatus;
      };
    }
  | {
      type: "measurement_finished";
      payload: MeasurementResult;
    }
  | {
      type: "error";
      payload: {
        message: string;
      };
    };

export interface CreateMeasurementRequest {
  target: string;
  mode: TraceMode;
  /** Probe location id from PROBE_LOCATIONS. Omitted or unknown falls back to the visitor hint. */
  from?: string;
  visitor?: VisitorContext;
}

export interface CreateMeasurementResponse {
  id: string;
  status: MeasurementStatus;
}
