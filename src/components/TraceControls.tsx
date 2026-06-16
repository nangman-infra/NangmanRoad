import { RotateCcw, Square, Zap } from "lucide-react";
import type { MeasurementStatus } from "../../shared/types";

interface TraceControlsProps {
  status: MeasurementStatus;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
}

export function TraceControls({ status, onStart, onStop, onReset }: TraceControlsProps) {
  const isBusy = status === "starting" || status === "running";

  return (
    <div className="flex h-12 gap-2">
      <button
        type="button"
        disabled={isBusy}
        onClick={onStart}
        className="inline-flex min-w-28 items-center justify-center gap-2 rounded-lg bg-signal-cyan px-4 text-sm font-bold text-deep-950 shadow-glow transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-55"
      >
        <Zap className="h-4 w-4" aria-hidden="true" />
        Start
      </button>
      <button
        type="button"
        disabled={!isBusy}
        onClick={onStop}
        aria-label="Stop measurement"
        title="Stop measurement"
        className="inline-flex aspect-square h-12 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white transition hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Square className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onReset}
        aria-label="Reset"
        title="Reset"
        className="inline-flex aspect-square h-12 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white transition hover:bg-white/12"
      >
        <RotateCcw className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
