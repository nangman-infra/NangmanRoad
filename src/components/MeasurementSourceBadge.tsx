import { MapPinned, RadioTower } from "lucide-react";
import type { MeasurementSource, MeasurementStatus } from "../../shared/types";

type MeasurementSourceBadgeProps = Readonly<{
  source?: MeasurementSource;
  status: MeasurementStatus;
}>;

export function MeasurementSourceBadge({ source, status }: MeasurementSourceBadgeProps) {
  const location = [source?.city, source?.country].filter(Boolean).join(", ");

  return (
    <div className="theme-side-panel flex max-w-full items-center gap-3 rounded-lg border px-4 py-3 text-sm">
      {source?.provider === "globalping" ? (
        <RadioTower className="h-5 w-5 shrink-0 text-signal-cyan" aria-hidden="true" />
      ) : (
        <MapPinned className="h-5 w-5 shrink-0 text-signal-amber" aria-hidden="true" />
      )}
      <div className="min-w-0">
        <p className="theme-panel-title truncate font-semibold">Measured from a nearby network probe</p>
        <p className="theme-panel-muted truncate text-xs">
          {location || (status === "idle" ? "Source appears after start" : "Selecting best source")}
        </p>
      </div>
    </div>
  );
}
