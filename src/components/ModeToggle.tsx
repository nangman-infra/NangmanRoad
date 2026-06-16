import type { TraceMode } from "../../shared/types";

interface ModeToggleProps {
  value: TraceMode;
  disabled: boolean;
  onChange: (mode: TraceMode) => void;
}

export function ModeToggle({ value, disabled, onChange }: ModeToggleProps) {
  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-cyan-50/75">Mode</span>
      <div className="grid h-12 grid-cols-2 rounded-lg border border-white/10 bg-white/[0.06] p-1">
        {(["traceout", "mtr"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            disabled={disabled}
            onClick={() => onChange(mode)}
            className={[
              "min-w-24 rounded-md px-4 text-sm font-semibold transition",
              value === mode
                ? "bg-signal-cyan text-deep-950 shadow-glow"
                : "text-cyan-50/70 hover:bg-white/10 hover:text-white",
              disabled ? "cursor-not-allowed opacity-60" : ""
            ].join(" ")}
          >
            {mode === "traceout" ? "Traceout" : "MTR"}
          </button>
        ))}
      </div>
    </div>
  );
}
