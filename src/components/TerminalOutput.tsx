import { Terminal } from "lucide-react";
import type {
  HopResult,
  MeasurementResult,
  MeasurementStatus,
  TraceMode
} from "../../shared/types";

const MTR_REPORT_CYCLES = 16;

interface TerminalOutputProps {
  error?: string;
  hops: HopResult[];
  mode: TraceMode;
  result?: MeasurementResult;
  status: MeasurementStatus;
  target: string;
}

function formatRtt(value?: number) {
  return typeof value === "number" ? `${Math.round(value)} ms` : "*";
}

function formatLoss(value?: number) {
  return typeof value === "number" ? `${value.toFixed(value % 1 === 0 ? 0 : 1)}%` : "-";
}

function formatAsn(hop: HopResult) {
  return hop.asn || "AS???";
}

function formatMtrNumber(value?: number) {
  return typeof value === "number" ? String(Math.round(value)) : "0";
}

function formatHost(hop: HopResult) {
  if (hop.hostname && hop.ip && hop.hostname !== hop.ip) {
    return `${hop.hostname} (${hop.ip})`;
  }

  return hop.hostname || hop.ip || "*";
}

function traceoutLine(hop: HopResult) {
  const hopNo = String(hop.hopNumber).padStart(2, " ");
  const rtt = formatRtt(hop.rttMs).padStart(6, " ");
  const status = (hop.status === "ok" ? "ok" : hop.status).padEnd(7, " ");

  return `${hopNo}  ${rtt}  ${status}  ${formatHost(hop)}`;
}

function mtrCells(hop: HopResult) {
  return [
    String(hop.hopNumber),
    formatAsn(hop),
    formatHost(hop),
    formatLoss(hop.packetLossPercent),
    String(hop.sent ?? MTR_REPORT_CYCLES),
    formatMtrNumber(hop.lastMs ?? hop.rttMs),
    formatMtrNumber(hop.rttMs),
    formatMtrNumber(hop.bestMs ?? hop.rttMs),
    formatMtrNumber(hop.worstMs ?? hop.rttMs),
    formatMtrNumber(hop.jitterMs)
  ];
}

function providerName(result?: MeasurementResult) {
  if (result?.source.provider === "globalping") {
    return "Globalping API";
  }

  if (result?.source.provider === "demo") {
    return "Demo provider";
  }

  return "Measurement provider";
}

function commandForMode(mode: TraceMode, target: string) {
  return mode === "mtr" ? `mtr -rwc ${MTR_REPORT_CYCLES} -z ${target}` : `traceout ${target}`;
}

function commandLines(params: { mode: TraceMode; result?: MeasurementResult; target: string }) {
  const provider = providerName(params.result);
  const globalpingMtr = params.mode === "mtr" && params.result?.source.provider === "globalping";
  const providerLine = globalpingMtr ? `${provider} - API packet cap 16` : provider;
  const notices = globalpingMtr
    ? ["notice  Install-free MTR uses Globalping's 16-sample cap; higher-cycle local MTR requires a local agent"]
    : [];

  return [
    `$ ${commandForMode(params.mode, params.target)}`,
    `provider  ${providerLine}`,
    "notice  Not a direct trace from your device",
    "notice  Exact device-level traceroute requires a local agent",
    ...notices
  ];
}

function emptyOutputLine(error?: string) {
  return error ? `error  ${error}` : "no completed route output";
}

function traceoutLines(hops: HopResult[], hasResult: boolean, error?: string) {
  return hasResult ? hops.map((hop) => traceoutLine(hop)) : [emptyOutputLine(error)];
}

function TerminalCommandBlock({ lines }: { lines: string[] }) {
  return (
    <div className="terminal-command-block">
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  );
}

function MtrTable({ hops }: { hops: HopResult[] }) {
  return (
    <div className="terminal-mtr-table" role="table" aria-label="MTR result">
      <div className="terminal-mtr-row terminal-mtr-row--header" role="row">
        {["#", "AS", "HOST", "LOSS", "SNT", "LAST", "AVG", "BEST", "WRST", "STDEV"].map((label) => (
          <span key={label} className="terminal-mtr-cell" role="columnheader">
            {label}
          </span>
        ))}
      </div>

      {hops.map((hop) => (
        <div key={hop.hopNumber} className="terminal-mtr-row" role="row">
          {mtrCells(hop).map((cell, index) => (
            <span
              key={`${hop.hopNumber}-${index}`}
              className={[
                "terminal-mtr-cell",
                index === 2 ? "terminal-mtr-cell--host" : "",
                index >= 3 ? "terminal-mtr-cell--metric" : ""
              ].join(" ")}
              role="cell"
              title={index === 2 ? cell : undefined}
            >
              {cell}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

function MtrOutput(params: { commandLines: string[]; error?: string; hasResult: boolean; hops: HopResult[] }) {
  return (
    <div className="terminal-output terminal-scrollbar flex-1 overflow-auto p-4 pb-6 text-[12px] leading-5">
      <TerminalCommandBlock lines={params.commandLines} />
      {params.hasResult ? <MtrTable hops={params.hops} /> : <div className="terminal-empty-line">{emptyOutputLine(params.error)}</div>}
    </div>
  );
}

function TraceoutOutput(params: { commandLines: string[]; error?: string; hasResult: boolean; hops: HopResult[] }) {
  return (
    <pre className="terminal-output terminal-scrollbar flex-1 overflow-auto p-4 pb-6 text-[12px] leading-5">
      <code>
        {[...params.commandLines, "", "#     RTT  STATE    HOST", ...traceoutLines(params.hops, params.hasResult, params.error)].join("\n")}
      </code>
    </pre>
  );
}

export function TerminalOutput({ error, hops, mode, result, status, target }: TerminalOutputProps) {
  const hasResult = status === "finished" && hops.length > 0;
  const lines = commandLines({ mode, result, target });

  return (
    <aside className="terminal-panel flex min-h-0 flex-col overflow-hidden rounded-lg border">
      <div className="terminal-panel-header flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Terminal className="h-5 w-5 shrink-0 text-signal-cyan" aria-hidden="true" />
          <div className="min-w-0">
            <p className="terminal-eyebrow text-xs uppercase tracking-[0.26em]">
              {mode === "mtr" ? "MTR terminal" : "Traceout terminal"}
            </p>
          </div>
        </div>
        <span className="terminal-status rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em]">
          {status}
        </span>
      </div>

      {mode === "mtr" ? (
        <MtrOutput commandLines={lines} error={error} hasResult={hasResult} hops={hops} />
      ) : (
        <TraceoutOutput commandLines={lines} error={error} hasResult={hasResult} hops={hops} />
      )}
    </aside>
  );
}
