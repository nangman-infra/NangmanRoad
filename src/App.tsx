import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, ExternalLink, Mail, Map as MapIcon, Moon, Sun, Terminal, Users } from "lucide-react";
import type {
  HopResult,
  MeasurementEvent,
  MeasurementResult,
  MeasurementStatus,
  TraceMode
} from "../shared/types";
import { PROBE_LOCATIONS, countryFlag } from "../shared/probes";
import { createMeasurement, openMeasurementEvents } from "./api";
import { AppShell, type JourneyState, type ThemeMode } from "./components/AppShell";
import { RouteVisualization, prepareRouteLegs } from "./components/RouteVisualization";
import { warmRouter } from "./lib/routeClient";
import { TerminalOutput } from "./components/TerminalOutput";
import { LANG_STORAGE_KEY, LangContext, detectLang, setCurrentLang, t, type Lang } from "./lib/i18n";

const initialTarget = "";
const CONTACT_EMAIL = "heishooni@gmail.com";
const TEAM_SITE = "https://nangman.cloud";
const themeStorageKey = "nangman-road-theme";
const minimumJourneyDurationMs = 1900;

function NetworkMark({ className = "" }: Readonly<{ className?: string }>) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
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

function TunnelSubmitMark({ className = "" }: Readonly<{ className?: string }>) {
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
    return globalThis.localStorage.getItem(themeStorageKey) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function persistTheme(theme: ThemeMode) {
  try {
    globalThis.localStorage.setItem(themeStorageKey, theme);
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
  const [probe, setProbe] = useState("auto");
  const [status, setStatus] = useState<MeasurementStatus>("idle");
  const [result, setResult] = useState<MeasurementResult | undefined>();
  const [hops, setHops] = useState<HopResult[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [hasSearched, setHasSearched] = useState(false);
  const [isJourneyLaunching, setIsJourneyLaunching] = useState(false);
  const [resultView, setResultView] = useState<"map" | "terminal">("map");
  // The globe is built at page load and the result waits for it: a longer wait on the
  // probe screen, never a stutter when the map appears. A globe that cannot be built
  // (no WebGL) or takes too long stops holding the result up.
  const [globeReady, setGlobeReady] = useState(false);

  useEffect(() => {
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        setGlobeReady(true);
      }
    };
    const timer = setTimeout(settle, 20_000);
    warmRouter();

    import("./components/GlobeView")
      .then((module) => module.globeReady())
      .then(settle, settle);

    return () => clearTimeout(timer);
  }, []);
  const [theme, setTheme] = useState<ThemeMode>(storedTheme);
  // Set for the plain functions before anything renders in it, then kept in state so the
  // page re-renders in the new language.
  const [lang, setLangState] = useState<Lang>(() => {
    const initial = detectLang();

    setCurrentLang(initial);

    return initial;
  });
  const setLang = (next: Lang) => {
    setCurrentLang(next);
    setLangState(next);

    try {
      globalThis.localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      // Storage disabled: the choice lasts for the visit.
    }
  };

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const closeEventsRef = useRef<(() => void) | undefined>();
  const journeyStartedAtRef = useRef(0);
  const journeyReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>();

  useEffect(() => {
    persistTheme(theme);
  }, [theme]);

  useEffect(
    () => () => {
      closeEventsRef.current?.();

      if (journeyReleaseTimerRef.current !== undefined) {
        globalThis.clearTimeout(journeyReleaseTimerRef.current);
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
      globalThis.clearTimeout(journeyReleaseTimerRef.current);
    }

    const elapsed = globalThis.performance.now() - journeyStartedAtRef.current;
    const delay = Math.max(0, minimumJourneyDurationMs - elapsed);

    journeyReleaseTimerRef.current = globalThis.setTimeout(() => {
      setIsJourneyLaunching(false);
      journeyReleaseTimerRef.current = undefined;
    }, delay);
  }

  // A probe named here re-measures the same target from it, as the result's own control does.
  async function start(from?: string) {
    if (!target.trim()) {
      setError(t("search.empty"));
      return;
    }

    const origin = from ?? probe;

    if (from) {
      setProbe(from);
    }

    closeEventsRef.current?.();

    if (journeyReleaseTimerRef.current !== undefined) {
      globalThis.clearTimeout(journeyReleaseTimerRef.current);
      journeyReleaseTimerRef.current = undefined;
    }

    setError(undefined);
    setHasSearched(true);
    setIsJourneyLaunching(true);
    journeyStartedAtRef.current = globalThis.performance.now();
    setResultView("map");
    setStatus("starting");
    setHops([]);
    setResult(undefined);

    try {
      const measurement = await createMeasurement({
        target,
        mode,
        from: origin === "auto" ? undefined : origin,
        visitor: {
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          locale: navigator.language
        }
      });

      closeEventsRef.current = openMeasurementEvents(
        measurement.id,
        handleEvent,
        (message) => {
          // The server closes the stream right after reporting why a measurement failed, so a
          // disconnect that follows a real error is the expected end of it, not a new problem.
          // Overwriting the reason with "the stream disconnected" loses the one useful message.
          setError((current) => current ?? message);
          setIsJourneyLaunching(false);
          setStatus((current) => (current === "finished" ? current : "error"));
        }
      );
    } catch (error_) {
      setStatus("error");
      releaseJourneyAfterMinimum();
      setError(error_ instanceof Error ? error_.message : t("search.startFailed"));
    }
  }

  function reset() {
    closeEventsRef.current?.();
    closeEventsRef.current = undefined;

    if (journeyReleaseTimerRef.current !== undefined) {
      globalThis.clearTimeout(journeyReleaseTimerRef.current);
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
  // The final route is routed and placed on the globe before the result is shown, so the
  // reveal itself builds nothing; earlier hops are routed as they arrive.
  const [routePrepared, setRoutePrepared] = useState(false);
  const shouldShowResult = hasSearched && ((status === "finished" && routePrepared) || status === "error") && globeReady;

  useEffect(() => {
    if (hops.length === 0 || (status !== "running" && status !== "finished")) {
      return;
    }

    let stale = false;

    if (status === "finished") {
      setRoutePrepared(false);
    }

    prepareRouteLegs({ hops, target, source: latestResult?.source, reachedTarget: latestResult?.reachedTarget })
      .catch(() => undefined)
      .then(() => {
        if (!stale && status === "finished") {
          setRoutePrepared(true);
        }
      });

    return () => {
      stale = true;
    };
  }, [hops, status, target, latestResult]);
  const shouldDisplayResult = shouldShowResult && !isJourneyLaunching;
  const journeyState = journeyStateFor({
    hasSearched,
    isBusy,
    isJourneyLaunching,
    shouldShowResult
  });
  const mainClassName = [
    "mx-auto flex min-h-screen w-full flex-col",
    shouldDisplayResult
      ? "max-w-[1880px] px-3 py-3 sm:px-4 lg:px-5 2xl:px-6"
      : "max-w-6xl px-4 py-5 sm:px-6 lg:px-8"
  ].join(" ");
  let pageContent = (
    <section className="flex flex-1 flex-col items-center justify-center pb-20">
      <div className="theme-eyebrow mb-10 flex items-center gap-3">
        <NetworkMark className="theme-network-mark h-5 w-5" />
        <span className="text-xs uppercase tracking-[0.34em]">{t("search.eyebrow")}</span>
      </div>
      <h1 className="theme-title text-center text-5xl font-semibold tracking-normal sm:text-7xl">
        Nangman Road
      </h1>
      <SearchForm
        target={target}
        mode={mode}
        probe={probe}
        error={error}
        disabled={isBusy}
        onTargetChange={setTarget}
        onModeChange={setMode}
        onProbeChange={setProbe}
        onSubmit={start}
      />
    </section>
  );

  if (shouldDisplayResult) {
    pageContent = (
      <section className="route-result-shell flex min-h-[calc(100dvh-1.5rem)] flex-col">
        <header className="result-topbar mb-3 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={reset}
            className="theme-brand-link inline-flex items-center gap-2 text-lg font-semibold transition hover:text-signal-cyan"
          >
            <NetworkMark className="theme-network-mark h-4 w-4" />
            Nangman Road
          </button>
          <label className="result-rerun inline-flex items-center gap-2 text-xs">
            <span className="theme-probe-caption hidden uppercase tracking-[0.2em] sm:inline">{t("header.rerun")}</span>
            <select
              value={probe}
              disabled={isBusy}
              aria-label={t("header.rerun")}
              onChange={(event) => void start(event.target.value)}
              className="result-view-toggle rounded-full border px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="auto">{t("search.nearest")}</option>
              {PROBE_LOCATIONS.map((location) => (
                <option key={location.id} value={location.id}>
                  {countryFlag(location.country)} {location.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setResultView((current) => (current === "map" ? "terminal" : "map"))}
            className="result-view-toggle inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold"
          >
            {resultView === "map" ? (
              <>
                <Terminal className="h-4 w-4" aria-hidden="true" />
                {t("header.terminal")}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </>
            ) : (
              <>
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                <MapIcon className="h-4 w-4" aria-hidden="true" />
                {t("header.map")}
              </>
            )}
          </button>
        </header>

        <div className="result-stage flex min-h-0 flex-1">
          {resultView === "map" ? (
            <RouteVisualization
              reachedTarget={latestResult?.reachedTarget}
              mode={mode}
              status={status}
              target={target}
              hops={hops}
              source={latestResult?.source}
              theme={theme}
              error={error}
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
    );
  } else if (hasSearched) {
    pageContent = (
      <JourneyLaunchStage
        hopCount={hops.length}
        mode={mode}
        sourceLabel={latestResult?.source ? formatSourceLabel(latestResult.source) : undefined}
        target={target}
      />
    );
  }

  return (
    <LangContext.Provider value={{ lang, setLang }}>
      <AppShell journeyState={journeyState} theme={theme}>
        <main className={mainClassName}>{pageContent}</main>
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-2">
          <CornerPopovers />
          <button
            type="button"
            aria-label={t("lang.toggle")}
            title={t("lang.toggle")}
            onClick={() => setLang(lang === "ko" ? "en" : "ko")}
            className="theme-toggle theme-toggle-button inline-flex h-12 items-center justify-center rounded-full border px-4 text-sm font-semibold shadow-2xl backdrop-blur"
          >
            {lang === "ko" ? "KR" : "EN"}
          </button>
          <ThemeToggle theme={theme} onChange={setTheme} />
        </div>
      </AppShell>
    </LangContext.Provider>
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
  const place = [source.city, formatCountryLabel(source.country)].filter(Boolean).join(", ");

  return place ? `${place}${source.network ? ` · ${source.network}` : ""}` : undefined;
}

function JourneyLaunchStage({
  hopCount,
  mode,
  sourceLabel,
  target
}: Readonly<{
  hopCount: number;
  mode: TraceMode;
  sourceLabel?: string;
  target: string;
}>) {
  const sourceCopy = sourceLabel ? t("launch.measuredFrom", { probe: sourceLabel }) : t("launch.selecting");

  return (
    <section className="journey-launch-stage flex flex-1 items-center justify-center">
      <div className="journey-scan-lockup" aria-live="polite">
        <div className="journey-launch-copy">
          <p className="text-xs uppercase tracking-[0.26em]">
            {mode === "mtr" ? t("launch.monitoring") : t("launch.tracing")}
          </p>
          <h2 className="mt-3 text-2xl font-semibold sm:text-3xl">{target}</h2>
          <p className="mt-3 text-sm">{sourceCopy}</p>
          <p className="journey-launch-status mt-2 text-xs">
            {hopCount > 0 ? t("launch.received", { n: hopCount }) : t("launch.searching")}
          </p>
        </div>
      </div>
    </section>
  );
}

type SearchFormProps = Readonly<{
  target: string;
  mode: TraceMode;
  probe: string;
  disabled: boolean;
  compact?: boolean;
  error?: string;
  onTargetChange: (value: string) => void;
  onModeChange: (mode: TraceMode) => void;
  onProbeChange: (probe: string) => void;
  onSubmit: () => void;
}>;

function SearchForm({
  target,
  mode,
  probe,
  disabled,
  compact = false,
  error,
  onTargetChange,
  onModeChange,
  onProbeChange,
  onSubmit
}: Readonly<SearchFormProps>) {
  const [isInputFocused, setIsInputFocused] = useState(false);
  // The option list is an OS popup outside the page, so picking an entry delivers no
  // mousemove and :hover stays stuck on until the pointer is nudged. Dropping pointer
  // events for that one moment makes the browser re-run hit testing immediately.
  const [isProbeHoverStale, setIsProbeHoverStale] = useState(false);
  const canSubmit = target.trim().length > 0 && !disabled;
  useEffect(() => {
    if (!isProbeHoverStale) {
      return;
    }

    const clear = () => setIsProbeHoverStale(false);

    window.addEventListener("mousemove", clear, { once: true });
    window.addEventListener("pointerdown", clear, { once: true });

    return () => {
      window.removeEventListener("mousemove", clear);
      window.removeEventListener("pointerdown", clear);
    };
  }, [isProbeHoverStale]);

  const selectedProbe = PROBE_LOCATIONS.find((location) => location.id === probe);
  const probeLabel = selectedProbe
    ? `${countryFlag(selectedProbe.country)} ${selectedProbe.label}`
    : t("search.nearest");

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
          placeholder={isInputFocused ? "" : t("search.placeholder")}
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

      <div
        className={[
          "theme-probe-row mx-auto flex items-baseline justify-center gap-2",
          compact ? "mt-2.5" : "mt-4",
          disabled ? "opacity-50" : ""
        ].join(" ")}
      >
        <span className="theme-probe-caption text-[10px] uppercase leading-none tracking-[0.28em]">
          {t("search.measuringFrom")}
        </span>
        <span
          className={[
            "theme-probe-control relative inline-flex items-center gap-1.5",
            isProbeHoverStale ? "pointer-events-none" : ""
          ].join(" ")}
        >
          <span className="theme-probe-value text-xs leading-none">{probeLabel}</span>
          <ChevronDown className="theme-probe-chevron h-3 w-3 shrink-0" aria-hidden="true" />
          {/* The native select stays a real select for keyboard and mobile, just invisible:
              its own box would size to the longest option and strand the chevron. */}
          <select
            value={probe}
            disabled={disabled}
            aria-label={t("search.probeAria")}
            onChange={(event) => {
              onProbeChange(event.target.value);
              setIsProbeHoverStale(true);
            }}
            className={[
              "absolute inset-0 h-full w-full opacity-0",
              disabled ? "cursor-not-allowed" : "cursor-pointer"
            ].join(" ")}
          >
            <option value="auto">{t("search.nearest")}</option>
            {PROBE_LOCATIONS.map((location) => (
              <option key={location.id} value={location.id}>
                {countryFlag(location.country)} {location.label}
              </option>
            ))}
          </select>
        </span>
      </div>

      {error ? <p className="mt-4 text-center text-sm text-signal-amber">{error}</p> : null}
    </form>
  );
}

// Two small cards in the corner: how to reach the maker, and the team's site. Each opens
// on its button and closes on a click anywhere else or Escape.
function CornerPopovers() {
  const [open, setOpen] = useState<"team" | "mail" | undefined>();
  const [copied, setCopied] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !barRef.current?.contains(event.target as Node)) setOpen(undefined);
    };

    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);

    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const toggle = (which: "team" | "mail") => {
    setCopied(false);
    setOpen((current) => (current === which ? undefined : which));
  };
  const copy = () => {
    navigator.clipboard?.writeText(CONTACT_EMAIL).then(() => setCopied(true), () => setCopied(false));
  };

  return (
    <div ref={barRef} className="relative flex items-center gap-2">
      <button
        type="button"
        aria-label={t("team.button")}
        title={t("team.button")}
        aria-expanded={open === "team"}
        onClick={() => toggle("team")}
        className={["theme-toggle theme-toggle-button inline-flex h-12 w-12 items-center justify-center rounded-full border shadow-2xl backdrop-blur", open === "team" ? "theme-toggle-button-active" : ""].join(" ")}
      >
        <Users className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={t("contact.button")}
        title={t("contact.button")}
        aria-expanded={open === "mail"}
        onClick={() => toggle("mail")}
        className={["theme-toggle theme-toggle-button inline-flex h-12 w-12 items-center justify-center rounded-full border shadow-2xl backdrop-blur", open === "mail" ? "theme-toggle-button-active" : ""].join(" ")}
      >
        <Mail className="h-4 w-4" aria-hidden="true" />
      </button>
      {open ? (
        <div className="corner-popover" role="dialog" aria-label={open === "mail" ? t("contact.title") : t("team.title")}>
          <p className="corner-popover__title">{open === "mail" ? t("contact.title") : t("team.title")}</p>
          {open === "mail" ? (
            <div className="corner-popover__row">
              <a className="corner-popover__link" href={`mailto:${CONTACT_EMAIL}`}>
                {CONTACT_EMAIL}
              </a>
              <button type="button" className="corner-popover__action" onClick={copy}>
                {copied ? t("contact.copied") : t("contact.copy")}
              </button>
            </div>
          ) : (
            <a className="corner-popover__link corner-popover__row" href={TEAM_SITE} target="_blank" rel="noreferrer">
              {t("team.open")}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ThemeToggle({
  theme,
  onChange
}: Readonly<{
  theme: ThemeMode;
  onChange: (theme: ThemeMode) => void;
}>) {
  return (
    <div className="theme-toggle grid grid-cols-2 rounded-full border p-1 shadow-2xl backdrop-blur">
      <button
        type="button"
        aria-label={t("theme.day")}
        title={t("theme.day")}
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
        aria-label={t("theme.night")}
        title={t("theme.night")}
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
