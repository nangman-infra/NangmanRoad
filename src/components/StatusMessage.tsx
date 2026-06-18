import { AlertTriangle, CheckCircle2, Loader2, Sparkles } from "lucide-react";
import type { MeasurementStatus } from "../../shared/types";

type StatusMessageProps = Readonly<{
  status: MeasurementStatus;
  error?: string;
  hopCount: number;
}>;

export function StatusMessage({ status, error, hopCount }: StatusMessageProps) {
  if (error) {
    return (
      <div className="flex items-start gap-3 text-sm leading-6 text-signal-amber">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{error}</span>
      </div>
    );
  }

  if (status === "starting" || status === "running") {
    return (
      <div className="flex items-center gap-3 text-sm text-cyan-50/70">
        <Loader2 className="h-4 w-4 animate-spin text-signal-cyan" aria-hidden="true" />
        <span>Collecting route data from a nearby measurement probe.</span>
      </div>
    );
  }

  if (status === "finished") {
    return (
      <div className="flex items-center gap-3 text-sm text-cyan-50/70">
        <CheckCircle2 className="h-4 w-4 text-signal-cyan" aria-hidden="true" />
        <span>{hopCount} hops are ready for inspection.</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 text-sm text-cyan-50/62">
      <Sparkles className="h-4 w-4 text-signal-violet" aria-hidden="true" />
      <span>Install-free browser experience. Not a direct trace from your device.</span>
    </div>
  );
}
