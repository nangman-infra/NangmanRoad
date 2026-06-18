import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Map as MapIcon, Moon, Sun, Terminal } from "lucide-react";
import type {
  HopResult,
  MeasurementEvent,
  MeasurementResult,
  MeasurementStatus,
  TraceMode
} from "../shared/types";
import { createMeasurement, openMeasurementEvents } from "./api";
import { AppShell, type JourneyState, type ThemeMode } from "./components/AppShell";
import { RouteVisualization } from "./components/RouteVisualization";
import { TerminalOutput } from "./components/TerminalOutput";

const initialTarget = "";
const themeStorageKey = "nangman-road-theme";
const minimumJourneyDurationMs = 1900;

function NetworkMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label="Network route"
    >
      <path
        d="M8.3 6.8H15.7L19.4 12L15.7 17.2H8.3L4.6 12Z"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.72"
      />
      <path
        d="M8.3 6.8L12 12L15.7 6.8M8.3 17.2L12 12L15.7 17.2"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.46"
      />
      <circle cx="12" cy="12" r="1.75" fill="currentColor" />
      <circle cx="8.3" cy="6.8" r="1.15" fill="currentColor" opacity="0.72" />
      <circle cx="15.7" cy="6.8" r="1.15" fill="currentColor" opacity="0.72" />
      <circle cx="19.4" cy="12" r="1.15" fill="currentColor" opacity="0.72" />
      <circle cx="15.7" cy="17.2" r="1.15" fill="currentColor" opacity="0.72" />
      <circle cx="8.3" cy="17.2" r="1.15" fill="currentColor" opacity="0.72" />
      <circle cx="4.6" cy="12" r="1.15" fill="currentColor" opacity="0.72" />
    </svg>
  );
}

function TunnelSubmitMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`submit-globe-mark ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="submit-globe-outline" cx="12" cy="12" r="8.1" />
      <path className="submit-globe-line" d="M4.25 12H19.75" />
      <path className="submit-globe-line submit-globe-line-soft" d="M5.95 8.05H18.05" />
      <path className="submit-globe-line submit-globe-line-soft" d="M5.95 15.95H18.05" />
      <path className="submit-globe-meridian" d="M12 3.9C14.25 6.15 15.35 8.85 15.35 12S14.25 17.85 12 20.1" />
      <path className="submit-globe-meridian" d="M12 3.9C9.75 6.15 8.65 8.85 8.65 12S9.75 17.85 12 20.1" />
    </svg>
  );
}

function upsertHop(hops: HopResult[], next: HopResult) {
  const existingIndex = hops.findIndex((hop) => hop.hopNumber === next.hopNumber);

  if (existingIndex === -1) {
    return [...hops, next].sort((a, b) => a.hopNumber - b.hopNumber);
  }

  return hops.map((hop, index) => (index === existingIndex ? { ...hop, ...next } : hop));
}

function storedTheme(): ThemeMode {
  try {
    return window.localStorage.getItem(themeStorageKey) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function persistTheme(theme: ThemeMode) {
  try {
    window.localStorage.setItem(themeStorageKey, theme);
  } catch {
    // Keep the UI usable when storage is disabled by the browser.
  }
}

function metricHopUpdate(hop: HopResult, event: Extract<MeasurementEvent, { type: "metric_update" }>) {
  return hop.hopNumber === event.payload.hopNumber ? { ...hop, ...event.payload } : hop;
}

function isBusyStatus(status: MeasurementStatus) {
  return status === "starting" || status === "running";
}

function journeyStateFor(params: {
  hasSearched: boolean;
  isBusy: boolean;
  isJourneyLaunching: boolean;
  shouldShowResult: boolean;
}): JourneyState {
  if (!params.hasSearched) {
    return "idle";
  }

  return !params.shouldShowResult || params.isBusy || params.isJourneyLaunching ? "launch" : "settled";
}

export function App() {
  const [target, setTarget] = useState(initialTarget);
  const [mode, setMode] = useState<TraceMode>("traceout");
  const [status, setStatus] = useState<MeasurementStatus>("idle");
  const [result, setResult] = useState<MeasurementResult | undefined>();
  const [hops, setHops] = useState<HopResult[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [hasSearched, setHasSearched] = useState(false);
  const [isJourneyLaunching, setIsJourneyLaunching] = useState(false);
  const [resultView, setResultView] = useState<"map" | "terminal">("map");
  const [theme, setTheme] = useState<ThemeMode>(storedTheme);
  const closeEventsRef = useRef<(() => void) | undefined>();
  const journeyStartedAtRef = useRef(0);
  const journeyReleaseTimerRef = useRef<number | undefined>();

  useEffect(() => {
    persistTheme(theme);
  }, [theme]);

  useEffect(
    () => () => {
      closeEventsRef.current?.();

      if (journeyReleaseTimerRef.current !== undefined) {
        window.clearTimeout(journeyReleaseTimerRef.current);
      }
    },
    []
  );

  const latestResult = useMemo(() => {
    if (!result) {
      return undefined;
    }

    return {
      ...result,
      hops
    };
  }, [hops, result]);

  function handleEvent(event: MeasurementEvent) {
    switch (event.type) {
      case "measurement_started":
        setResult(event.payload);
        setHops(event.payload.hops);
        setStatus("running");
        break;
      case "hop_result":
        setHops((current) => upsertHop(current, event.payload));
        break;
      case "metric_update":
        setHops((current) => current.map((hop) => metricHopUpdate(hop, event)));
        break;
      case "measurement_finished":
        setResult(event.payload);
        setHops(event.payload.hops);
        setStatus("finished");
        releaseJourneyAfterMinimum();
        closeEventsRef.current?.();
        break;
      case "error":
        setError(event.payload.message);
        setStatus("error");
        releaseJourneyAfterMinimum();
        break;
    }
  }

  function releaseJourneyAfterMinimum() {
    if (journeyReleaseTimerRef.current !== undefined) {
      window.clearTimeout(journeyReleaseTimerRef.current);
    }

    const elapsed = window.performance.now() - journeyStartedAtRef.current;
    const delay = Math.max(0, minimumJourneyDurationMs - elapsed);

    journeyReleaseTimerRef.current = window.setTimeout(() => {
      setIsJourneyLaunching(false);
      journeyReleaseTimerRef.current = undefined;
    }, delay);
  }

  async function start() {
    if (!target.trim()) {
      setError("Enter a domain or IP address.");
      return;
    }

    closeEventsRef.current?.();

    if (journeyReleaseTimerRef.current !== undefined) {
      window.clearTimeout(journeyReleaseTimerRef.current);
      journeyReleaseTimerRef.current = undefined;
    }

    setError(undefined);
    setHasSearched(true);
    setIsJourneyLaunching(true);
    journeyStartedAtRef.current = window.performance.now();
    setResultView("map");
    setStatus("starting");
    setHops([]);
    setResult(undefined);

    try {
      const measurement = await createMeasurement({
        target,
        mode,
        visitor: {
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          locale: navigator.language
        }
      });

      closeEventsRef.current = openMeasurementEvents(
        measurement.id,
        handleEvent,
        (message) => {
          setError(message);
          setIsJourneyLaunching(false);
          setStatus((current) => (current === "finished" ? current : "error"));
        }
      );
    } catch (caught) {
      setStatus("error");
      releaseJourneyAfterMinimum();
      setError(caught instanceof Error ? caught.message : "Unable to start measurement.");
    }
  }

  function reset() {
    closeEventsRef.current?.();
    closeEventsRef.current = undefined;

    if (journeyReleaseTimerRef.current !== undefined) {
      window.clearTimeout(journeyReleaseTimerRef.current);
      journeyReleaseTimerRef.current = undefined;
    }

    setStatus("idle");
    setHasSearched(false);
    setIsJourneyLaunching(false);
    setResultView("map");
    setResult(undefined);
    setHops([]);
    setError(undefined);
  }

  const isBusy = isBusyStatus(status);
  const shouldShowResult = hasSearched && (status === "finished" || status === "error");
  const shouldDisplayResult = shouldShowResult && !isJourneyLaunching;
  const journeyState = journeyStateFor({
    hasSearched,
    isBusy,
    isJourneyLaunching,
    shouldShowResult
  });

  return (
    <AppShell journeyState={journeyState} theme={theme}>
      <main
        className={[
          "mx-auto flex min-h-screen w-full flex-col",
          shouldDisplayResult
            ? "max-w-[1880px] px-3 py-3 sm:px-4 lg:px-5 2xl:px-6"
            : "max-w-6xl px-4 py-5 sm:px-6 lg:px-8"
        ].join(" ")}
      >
        {!hasSearched ? (
          <section className="flex flex-1 flex-col items-center justify-center pb-20">
            <div className="theme-eyebrow mb-10 flex items-center gap-3">
              <NetworkMark className="theme-network-mark h-5 w-5" />
              <span className="text-xs uppercase tracking-[0.34em]">Network route search</span>
            </div>
            <h1 className="theme-title text-center text-5xl font-semibold tracking-normal sm:text-7xl">
              Nangman Road
            </h1>
            <SearchForm
              target={target}
              mode={mode}
              error={error}
              disabled={isBusy}
              onTargetChange={setTarget}
              onModeChange={setMode}
              onSubmit={start}
            />
          </section>
        ) : !shouldDisplayResult ? (
          <JourneyLaunchStage
            hopCount={hops.length}
            mode={mode}
            sourceLabel={latestResult?.source ? formatSourceLabel(latestResult.source) : undefined}
            target={target}
          />
        ) : (
          <section className="route-result-shell flex min-h-[calc(100dvh-1.5rem)] flex-col">
            <header className="result-topbar mb-3 flex items-center justify-between">
              <button
                type="button"
                onClick={reset}
                className="theme-brand-link inline-flex items-center gap-2 text-lg font-semibold transition hover:text-signal-cyan"
              >
                <NetworkMark className="theme-network-mark h-4 w-4" />
                Nangman Road
              </button>
              <button
                type="button"
                onClick={() => setResultView((current) => (current === "map" ? "terminal" : "map"))}
                className="result-view-toggle inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold"
              >
                {resultView === "map" ? (
                  <>
                    <Terminal className="h-4 w-4" aria-hidden="true" />
                    Terminal result
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </>
                ) : (
                  <>
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    <MapIcon className="h-4 w-4" aria-hidden="true" />
                    Route map
                  </>
                )}
              </button>
            </header>

            <div className="result-stage flex min-h-0 flex-1">
              {resultView === "map" ? (
                <RouteVisualization
                  mode={mode}
                  status={status}
                  target={target}
                  hops={hops}
                  source={latestResult?.source}
                  theme={theme}
                />
              ) : (
                <TerminalOutput
                  error={error}
                  hops={hops}
                  mode={mode}
                  result={latestResult}
                  status={status}
                  target={target}
                />
              )}
            </div>
          </section>
        )}
      </main>
      <ThemeToggle theme={theme} onChange={setTheme} />
    </AppShell>
  );
}

function formatCountryLabel(country?: string) {
  const normalized = country?.toLowerCase() ?? "";

  if (normalized === "kr" || normalized.includes("korea")) {
    return "KR";
  }

  if (normalized === "jp" || normalized.includes("japan")) {
    return "JP";
  }

  if (normalized === "us" || normalized.includes("united states")) {
    return "US";
  }

  if (normalized === "gb" || normalized.includes("united kingdom")) {
    return "UK";
  }

  return country;
}

function formatSourceLabel(source: MeasurementResult["source"]) {
  return [source.city, formatCountryLabel(source.country)].filter(Boolean).join(", ") || "nearby network probe";
}

function JourneyLaunchStage({
  hopCount,
  mode,
  sourceLabel,
  target
}: {
  hopCount: number;
  mode: TraceMode;
  sourceLabel?: string;
  target: string;
}) {
  const sourceCopy =
    sourceLabel && sourceLabel !== "nearby network probe"
      ? `Measured from ${sourceLabel} probe`
      : "Selecting a nearby network probe";

  return (
    <section className="journey-launch-stage flex flex-1 items-center justify-center">
      <div className="journey-scan-lockup" aria-live="polite">
        <div className="journey-launch-copy">
          <p className="text-xs uppercase tracking-[0.26em]">
            {mode === "mtr" ? "Monitoring route" : "Tracing route"}
          </p>
          <h2 className="mt-3 text-2xl font-semibold sm:text-3xl">{target}</h2>
          <p className="mt-3 text-sm">{sourceCopy}</p>
          <p className="journey-launch-status mt-2 text-xs">
            {hopCount > 0 ? `${hopCount} hops received. Preparing final view.` : "Searching the route."}
          </p>
        </div>
      </div>
    </section>
  );
}

interface SearchFormProps {
  target: string;
  mode: TraceMode;
  disabled: boolean;
  compact?: boolean;
  error?: string;
  onTargetChange: (value: string) => void;
  onModeChange: (mode: TraceMode) => void;
  onSubmit: () => void;
}

function SearchForm({
  target,
  mode,
  disabled,
  compact = false,
  error,
  onTargetChange,
  onModeChange,
  onSubmit
}: SearchFormProps) {
  const [isInputFocused, setIsInputFocused] = useState(false);
  const canSubmit = target.trim().length > 0 && !disabled;

  return (
    <form
      className={compact ? "mt-0 w-full" : "mt-9 w-full max-w-2xl"}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div
        className={[
          "theme-search-box flex items-center gap-3 rounded-full border shadow-2xl shadow-black/25 backdrop-blur-xl transition",
          compact ? "h-12 px-4" : "h-16 px-5"
        ].join(" ")}
        onMouseDown={() => setIsInputFocused(true)}
        onTouchStart={() => setIsInputFocused(true)}
      >
        <span
          className={compact ? "h-9 w-9 shrink-0" : "h-10 w-10 shrink-0 sm:h-11 sm:w-11"}
          aria-hidden="true"
        />
        <input
          value={target}
          disabled={disabled}
          onBlur={() => setIsInputFocused(false)}
          onChange={(event) => onTargetChange(event.target.value)}
          onClick={() => setIsInputFocused(true)}
          onFocus={() => setIsInputFocused(true)}
          placeholder={isInputFocused ? "" : "Search domain or IP"}
          className="theme-search-input min-w-0 flex-1 bg-transparent text-center text-base disabled:cursor-not-allowed sm:text-lg"
        />
        <button
          type="submit"
          disabled={!canSubmit}
          aria-label="Start route search"
          className={[
            "theme-search-submit inline-flex shrink-0 items-center justify-center rounded-full transition disabled:cursor-default disabled:opacity-90",
            canSubmit ? "cursor-pointer" : "cursor-default",
            compact ? "h-9 w-9" : "h-10 w-10 sm:h-11 sm:w-11"
          ].join(" ")}
        >
          <TunnelSubmitMark className={compact ? "h-6 w-6" : "h-7 w-7"} />
        </button>
      </div>

      <div className={`theme-mode-toggle mx-auto grid w-full max-w-xs grid-cols-2 rounded-full border p-1 backdrop-blur ${compact ? "mt-3 h-10" : "mt-5 h-11"}`}>
        {(["traceout", "mtr"] as const).map((nextMode) => (
          <button
            key={nextMode}
            type="button"
            disabled={disabled}
            onClick={() => onModeChange(nextMode)}
            className={[
              "theme-mode-button rounded-full text-sm font-semibold transition",
              mode === nextMode ? "theme-mode-button-active" : "",
              disabled ? "cursor-not-allowed opacity-60" : ""
            ].join(" ")}
          >
            {nextMode === "traceout" ? "Traceout" : "MTR"}
          </button>
        ))}
      </div>

      {error ? <p className="mt-4 text-center text-sm text-signal-amber">{error}</p> : null}
    </form>
  );
}

function ThemeToggle({
  theme,
  onChange
}: {
  theme: ThemeMode;
  onChange: (theme: ThemeMode) => void;
}) {
  return (
    <div className="theme-toggle fixed bottom-5 right-5 z-50 grid grid-cols-2 rounded-full border p-1 shadow-2xl backdrop-blur">
      <button
        type="button"
        aria-label="Day mode"
        title="Day mode"
        onClick={() => onChange("light")}
        className={[
          "theme-toggle-button inline-flex h-10 w-10 items-center justify-center rounded-full transition",
          theme === "light" ? "theme-toggle-button-active" : ""
        ].join(" ")}
      >
        <Sun className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Night mode"
        title="Night mode"
        onClick={() => onChange("dark")}
        className={[
          "theme-toggle-button inline-flex h-10 w-10 items-center justify-center rounded-full transition",
          theme === "dark" ? "theme-toggle-button-active" : ""
        ].join(" ")}
      >
        <Moon className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
