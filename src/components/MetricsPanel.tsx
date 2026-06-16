import { Gauge, ShieldCheck, Waves } from "lucide-react";
import type {
  HopResult,
  MeasurementResult,
  MeasurementStatus,
  TraceMode
} from "../../shared/types";

interface MetricsPanelProps {
  result?: MeasurementResult;
  hops: HopResult[];
  mode: TraceMode;
  status: MeasurementStatus;
}

function average(values: number[]) {
  if (values.length === 0) {
    return undefined;
  }

  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function MetricsPanel({ result, hops, mode, status }: MetricsPanelProps) {
  const rtts = hops.map((hop) => hop.rttMs).filter((value): value is number => typeof value === "number");
  const losses = hops
    .map((hop) => hop.packetLossPercent)
    .filter((value): value is number => typeof value === "number");
  const avgRtt = average(rtts);
  const avgLoss = average(losses);

  return (
    <section className="theme-side-panel rounded-lg border p-4 shadow-2xl shadow-black/10 backdrop-blur">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="theme-panel-eyebrow text-sm uppercase tracking-[0.2em]">Signal</p>
          <h2 className="theme-panel-title text-lg font-semibold">Measurement state</h2>
        </div>
        <Gauge className="h-5 w-5 text-signal-cyan" aria-hidden="true" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Metric label="Mode" value={mode === "traceout" ? "Traceout" : "MTR"} />
        <Metric label="Status" value={status} />
        <Metric label="Avg RTT" value={avgRtt ? `${avgRtt} ms` : "-"} />
        <Metric label="Avg loss" value={avgLoss !== undefined ? `${avgLoss}%` : "-"} />
      </div>

      <div className="theme-inner-panel mt-4 rounded-lg border p-3">
        <div className="theme-panel-title mb-2 flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4 text-signal-cyan" aria-hidden="true" />
          Honest source
        </div>
        <p className="theme-panel-muted text-sm leading-6">
          {result?.source.note ??
            "Measured from a nearby network probe. Exact device-level traceroute requires a local agent."}
        </p>
      </div>

      <div className="theme-panel-eyebrow mt-4 flex items-center gap-2 text-xs uppercase tracking-[0.18em]">
        <Waves className="h-4 w-4" aria-hidden="true" />
        {result?.confidence ? `${result.confidence} confidence` : "confidence appears after start"}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="theme-inner-panel rounded-lg border p-3">
      <p className="theme-panel-eyebrow text-xs uppercase tracking-[0.16em]">{label}</p>
      <p className="theme-panel-title mt-2 truncate text-lg font-semibold capitalize">{value}</p>
    </div>
  );
}
