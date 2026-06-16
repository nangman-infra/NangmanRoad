import { CircleDot, Timer } from "lucide-react";
import type { HopResult, MeasurementStatus } from "../../shared/types";

interface HopTableProps {
  hops: HopResult[];
  status: MeasurementStatus;
}

function statusClass(status: HopResult["status"]) {
  if (status === "loss" || status === "timeout") {
    return "text-signal-coral";
  }

  if (status === "slow") {
    return "text-signal-amber";
  }

  return "text-signal-cyan";
}

export function HopTable({ hops, status }: HopTableProps) {
  return (
    <section className="theme-side-panel min-h-0 flex-1 rounded-lg border p-4 shadow-2xl shadow-black/10 backdrop-blur">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="theme-panel-eyebrow text-sm uppercase tracking-[0.2em]">Hops</p>
          <h2 className="theme-panel-title text-lg font-semibold">Route timeline</h2>
        </div>
        <Timer className="h-5 w-5 text-signal-cyan" aria-hidden="true" />
      </div>

      {hops.length === 0 ? (
        <div className="theme-empty-panel flex min-h-56 items-center justify-center rounded-lg border border-dashed px-4 text-center text-sm leading-6">
          {status === "starting" || status === "running"
            ? "Waiting for the first measured hop."
            : "Hop results will appear here after a measurement starts."}
        </div>
      ) : (
        <div className="no-scrollbar max-h-[280px] overflow-auto xl:max-h-[320px]">
          <table className="w-full table-fixed border-separate border-spacing-y-2 text-left text-sm">
            <thead className="text-xs uppercase tracking-[0.16em] text-cyan-100/45">
              <tr>
                <th className="w-12 px-2 py-1">#</th>
                <th className="px-2 py-1">Node</th>
                <th className="w-20 px-2 py-1">RTT</th>
                <th className="w-16 px-2 py-1">Loss</th>
              </tr>
            </thead>
            <tbody>
              {hops.map((hop) => (
                <tr key={hop.hopNumber} className="theme-hop-row rounded-lg">
                  <td className="theme-panel-title rounded-l-lg px-2 py-3 font-semibold">{hop.hopNumber}</td>
                  <td className="min-w-0 px-2 py-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <CircleDot className={`h-4 w-4 shrink-0 ${statusClass(hop.status)}`} />
                      <div className="min-w-0">
                        <p className="theme-panel-title truncate font-medium">{hop.hostname || hop.ip || "Unknown hop"}</p>
                        <p className="theme-panel-muted truncate text-xs">
                          {[hop.ip, hop.city, hop.country].filter(Boolean).join(" / ") || hop.status}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="theme-panel-muted px-2 py-3">{hop.rttMs ? `${hop.rttMs} ms` : "-"}</td>
                  <td className="theme-panel-muted rounded-r-lg px-2 py-3">
                    {hop.packetLossPercent !== undefined ? `${hop.packetLossPercent}%` : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
