import { lazy, startTransition, Suspense, type MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { Activity, Cable, RadioTower, SearchX } from "lucide-react";

import { greatCircle, haversineKm as tupleKm, type LatLng, type LegDecision, type LegEvidence } from "../lib/cableRouting";
import { t, useLang } from "../lib/i18n";
import { routeLeg } from "../lib/routeClient";
import { NO_SPEED, lighten, segmentSpeed, speedColor, speedGradient } from "../lib/latency";
import { legLabel } from "../lib/legLabel";
import { loadMapData } from "../lib/mapData";
import type { GlobeLeg, GlobePoint } from "./GlobeView";

// three.js and the globe renderer only load when someone opens the 3D view.
const GlobeView = lazy(() => import("./GlobeView"));

type RouteView = "2d" | "3d";
type PathMode = "cable" | "direct";

// One leg per pair of consecutive placed hops. A sea leg rides the most plausible cable chain
// between the nearest landing stations when the graph allows it; anything else is the great
// circle. Only the two hops of a leg are measured, and the note under the map says so.
function pathKm(path: LatLng[]) {
  return path.reduce((sum, point, index) => (index === 0 ? sum : sum + tupleKm(path[index - 1], point)), 0);
}

// Routing a leg along the cables is the dear part of drawing a route, and it runs in a
// worker; each leg's geometry is then kept for the page, keyed by its ends, so a route
// that grows hop by hop only routes the new leg and the same route drawn twice routes
// nothing. Direct legs need no routing at all.
// One hop leg's drawn shape: a single straight stretch, or the stretches of a routed leg
// - along cables at sea, overland between landings and hops - in order.
type LegStretch = Pick<GlobeLeg, "path" | "kind" | "inferred" | "cables" | "crossing" | "from" | "to" | "evidence">;

interface LegShape {
  stretches: LegStretch[];
}

const legShapes = new Map<string, LegShape>();

// The growth in round-trip time across a leg, when both of its hops answered. The probe
// itself sits at 0 ms.
function rttGrowth(start: GlobePoint, end: GlobePoint) {
  const startRtt = start.role === "source" ? 0 : start.rttMs;

  return startRtt === undefined || end.rttMs === undefined ? undefined : end.rttMs - startRtt;
}

// The networks at a leg's two ends, for the router: a carrier rides the cables it owns.
function legOperators(start: GlobePoint, end: GlobePoint) {
  return uniqueValues([...(start.operators ?? []), ...(end.operators ?? [])]);
}

function legKey(from: LatLng, to: LatLng, mode: PathMode, rttMs?: number, operators: string[] = []) {
  return `${mode}|${from[0]},${from[1]}|${to[0]},${to[1]}|${rttMs === undefined ? "-" : Math.round(rttMs)}|${operators.join(",")}`;
}

// A straight stretch, or a land stretch along the corridors the router drew it through.
const straight = (from: LatLng, to: LatLng, crossing = false, path?: LatLng[], evidence?: LegEvidence[]): LegShape => ({
  stretches: [{ path: path && path.length > 2 ? path : greatCircle(from, to), kind: "direct", inferred: false, crossing, evidence }]
});

function cachedShape(from: LatLng, to: LatLng, mode: PathMode, rttMs?: number, operators: string[] = []): LegShape | undefined {
  const key = legKey(from, to, mode, rttMs, operators);

  if (mode === "direct" && !legShapes.has(key)) {
    legShapes.set(key, straight(from, to, false, undefined, [{ code: "straight_by_choice" }]));
  }

  return legShapes.get(key);
}

async function resolveShape(from: LatLng, to: LatLng, mode: PathMode, rttMs?: number, operators: string[] = []): Promise<LegShape> {
  const cached = cachedShape(from, to, mode, rttMs, operators);

  if (cached) {
    return cached;
  }

  const decision = await routeLeg(from, to, rttMs, operators).catch((): LegDecision => ({ kind: "land", path: [from, to], evidence: [{ code: "worker_failed" }] }));
  const shape: LegShape =
    decision.kind === "cable"
      ? {
          stretches: decision.segments.map((segment) => ({
            path: segment.path,
            kind: segment.sea ? "sea" : "land",
            inferred: true,
            cables: segment.cables.length > 0 ? segment.cables : undefined,
            from: segment.from,
            to: segment.to,
            evidence: decision.evidence
          }))
        }
      : straight(from, to, decision.kind === "unrouted", decision.kind === "land" ? decision.path : undefined, decision.evidence);
  legShapes.set(legKey(from, to, mode, rttMs, operators), shape);

  return shape;
}

// The stretches of one hop leg as drawn legs, all at the leg's speed: its whole drawn
// length over the growth in round-trip time between its two hops. A hop that never
// answered leaves the leg unmeasured.
function legsOf(shape: LegShape, start: GlobePoint, end: GlobePoint, hop: number): GlobeLeg[] {
  const rttMs = rttGrowth(start, end);
  const km = shape.stretches.reduce((sum, stretch) => sum + pathKm(stretch.path), 0);
  const kmps = rttMs === undefined ? undefined : segmentSpeed(km, rttMs);

  return shape.stretches.map((stretch) => ({ ...stretch, hop, kmps }));
}

// The legs when every one of them is already known, else nothing.
// The hops a route runs through: the marker for a target that never answered sits on the
// last hop and is no stop of its own.
const routeStops = (points: GlobePoint[]) => points.filter((point) => point.role !== "unreached");

function legsFromCache(allPoints: GlobePoint[], mode: PathMode): GlobeLeg[] | undefined {
  const points = routeStops(allPoints);
  const legs: GlobeLeg[] = [];

  for (let index = 1; index < points.length; index += 1) {
    const [start, end] = [points[index - 1], points[index]];
    const shape = cachedShape([start.lat, start.lng], [end.lat, end.lng], mode, rttGrowth(start, end), legOperators(start, end));

    if (!shape) return undefined;

    legs.push(...legsOf(shape, start, end, index));
  }

  return legs;
}

async function resolveLegs(allPoints: GlobePoint[], mode: PathMode): Promise<GlobeLeg[]> {
  const points = routeStops(allPoints);
  const shapes = await Promise.all(
    points.slice(1).map((end, index) => {
      const start = points[index];

      return resolveShape([start.lat, start.lng], [end.lat, end.lng], mode, rttGrowth(start, end), legOperators(start, end));
    })
  );

  return shapes.flatMap((shape, index) => legsOf(shape, points[index], points[index + 1], index + 1));
}

// A target that never answered: its name goes on the last router that did, marked so,
// and nothing is drawn to a place nobody measured.
interface Unreached {
  target: string;
  hop: number;
}

function unreachedTarget(params: { hops: HopResult[]; target: string; reachedTarget?: boolean }): Unreached | undefined {
  if (params.reachedTarget !== false || params.hops.length === 0) return undefined;

  const lastAnswer = [...params.hops].reverse().find((hop) => hop.ip);

  return { target: params.target, hop: lastAnswer?.hopNumber ?? params.hops.length };
}

// The globe's view of a route point: the city as its label, the full caption on hover.
function toGlobePoints(points: GeoPoint[], unreached?: Unreached): GlobePoint[] {
  const globePoints: GlobePoint[] = points.map((point) => ({
    lat: point.lat,
    lng: point.lng,
    role: point.role,
    label: point.city ?? point.label,
    city: point.city,
    title: point.label,
    meta: point.subLabel,
    rttMs: point.rttMs,
    operators: point.operators
  }));
  const last = globePoints[globePoints.length - 1];

  if (unreached && last) {
    globePoints.push({
      lat: last.lat,
      lng: last.lng,
      role: "unreached",
      label: unreached.target,
      title: t("point.unreached"),
      meta: t("point.unreachedMeta", { target: unreached.target, n: unreached.hop })
    });
  }

  return globePoints;
}

// Each point carries the speed of the hop leg that reaches it, for the globe's rings.
function withLegSpeeds(points: GlobePoint[], legs: GlobeLeg[]): GlobePoint[] {
  return points.map((point, index) => ({ ...point, kmps: index > 0 ? legs.find((leg) => leg.hop === index)?.kmps : undefined }));
}

// Routes the legs of a trace and puts them on the globe ahead of the map, while the
// visitor is still waiting on the probe, so that showing the result is a paint and not a
// computation.
export async function prepareRouteLegs(params: { hops: HopResult[]; target: string; source?: MeasurementSource; reachedTarget?: boolean; pathMode?: PathMode }) {
  const points = toGlobePoints(buildRoutePoints(params), unreachedTarget(params));
  const legs = await resolveLegs(points, params.pathMode ?? readPathMode());
  const { presentRoute } = await import("./GlobeView");

  presentRoute(withLegSpeeds(points, legs), legs);
}

function readPathMode(): PathMode {
  return readPreference("nangman.route-path", "cable") === "direct" ? "direct" : "cable";
}

function readPreference(key: string, fallback: string) {
  try {
    return globalThis.localStorage?.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePreference(key: string, value: string) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // A private window or blocked storage just loses the convenience.
  }
}

const loadCableGeoJson = () => loadMapData<GeoJSON.GeoJsonObject>("cables");

// A single glowing packet that rides the drawn route end to end and loops. Its position is
// interpolated in layer pixels every frame, so it sits exactly on the polyline at any zoom.
function animatePacket(params: { map: L.Map; layer: L.LayerGroup; parts: L.LatLng[][] }) {
  const start = params.parts[0]?.[0];

  if (!start || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return () => {};
  }

  const packetMarker = (ghost: number) =>
    L.marker(start, {
      icon: L.divIcon({
        className: "packet-map-packet-wrap",
        html: `<span class="packet-map-packet${ghost ? " packet-map-packet--ghost" : ""}" style="opacity:${1 - ghost * 0.32}"></span>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      }),
      interactive: false,
      keyboard: false,
      zIndexOffset: 950 - ghost
    }).addTo(params.layer);
  // The lead packet and two fading ghosts a little way behind it.
  const markers = [0, 1, 2].map(packetMarker);
  const GHOST_SPACING = 0.014;
  const SPEED_PX_PER_S = 230;
  // On arrival the packet sends a ripple out from the destination and fades; then a new
  // one sets off from the source.
  const ARRIVAL_MS = 950;
  const MIN_LAP_MS = 2_800;
  const MAX_LAP_MS = 14_000;
  // Progress is a share of the whole path, not a pixel count: zooming changes how many
  // pixels the route is, and a pixel count would put the packet somewhere else each time.
  let progress = 0;
  let arrivedAt: number | undefined;
  let last = globalThis.performance.now();
  let frame = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const fade = (opacity: number) => {
    for (const marker of markers) {
      const element = marker.getElement();

      if (element) {
        element.style.opacity = String(opacity);
      }
    }
  };

  const ripple = (at: L.LatLng) => {
    const wave = L.marker(at, {
      icon: L.divIcon({
        className: "packet-map-ripple-wrap",
        html: '<span class="packet-map-ripple"></span><span class="packet-map-ripple packet-map-ripple--late"></span>',
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      }),
      interactive: false,
      keyboard: false,
      zIndexOffset: 940
    }).addTo(params.layer);
    const timer = setTimeout(() => {
      wave.remove();
      timers.delete(timer);
    }, 1400);
    timers.add(timer);
  };

  const step = (now: number) => {
    const elapsed = now - last;
    last = now;
    // Segments run part by part; between two parts the packet simply reappears at the
    // opposite map edge, which is what crossing the antimeridian looks like on a flat map.
    const segments = params.parts.flatMap((part) => {
      const pixels = part.map((latLng) => params.map.latLngToLayerPoint(latLng));

      return pixels.slice(1).map((pixel, index) => ({ from: pixels[index], to: pixel, length: pixel.distanceTo(pixels[index]) }));
    });
    const total = segments.reduce((sum, segment) => sum + segment.length, 0);

    if (total > 0) {
      const lapMs = Math.min(MAX_LAP_MS, Math.max(MIN_LAP_MS, (total / SPEED_PX_PER_S) * 1000));

      const place = (share: number) => {
        let remaining = Math.max(0, share) * total;
        let index = 0;

        while (index < segments.length - 1 && remaining > segments[index].length) {
          remaining -= segments[index].length;
          index += 1;
        }

        const { from, to, length } = segments[index];
        const t = length > 0 ? remaining / length : 0;

        return params.map.layerPointToLatLng(L.point(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t));
      };

      if (arrivedAt === undefined) {
        progress = Math.min(1, progress + elapsed / lapMs);

        if (progress >= 1) {
          arrivedAt = now;
          ripple(place(1));
          fade(0);
        }
      } else if (now - arrivedAt >= ARRIVAL_MS) {
        arrivedAt = undefined;
        progress = 0;
        fade(1);
      }

      markers.forEach((marker, ghost) => marker.setLatLng(place(progress - ghost * GHOST_SPACING)));
    }

    frame = globalThis.requestAnimationFrame(step);
  };

  frame = globalThis.requestAnimationFrame(step);

  return () => {
    globalThis.cancelAnimationFrame(frame);
    timers.forEach((timer) => clearTimeout(timer));
    markers.forEach((marker) => marker.remove());
  };
}
import type { HopResult, MeasurementResult, MeasurementSource, MeasurementStatus, TraceMode } from "../../shared/types";

type RouteVisualizationProps = Readonly<{
  mode: TraceMode;
  status: MeasurementStatus;
  target: string;
  hops: HopResult[];
  source?: MeasurementSource;
  theme: "light" | "dark";
  error?: string;
  reachedTarget?: boolean;
}>;

interface GeoPoint {
  lat: number;
  lng: number;
  label: string;
  role: "source" | "transit" | "target";
  status: HopResult["status"] | "source" | "target";
  asn?: string;
  city?: string;
  country?: string;
  hopCount?: number;
  sequence?: number;
  subLabel?: string;
  // Round-trip time measured at this point, when a hop here answered.
  rttMs?: number;
  // The networks answering here, as the traceroute names them.
  operators?: string[];
}

interface RoutePlace {
  city: string;
  country: string;
  key: string;
  lat: number;
  lng: number;
  confidence?: HopResult["locationConfidence"];
  evidence?: string[];
  precision?: HopResult["locationPrecision"];
  source?: HopResult["locationSource"];
}

interface AsRouteGroup {
  asn: string;
  asName?: string;
  asCountry?: string;
  place?: RoutePlace;
  places: RoutePlace[];
  hops: HopResult[];
  status: HopResult["status"];
}

interface AsMetadata {
  name: string;
  country: string;
}

// The probe keeps the brand colour; every other point takes the colour of the leg that
// reaches it, so a hop is coloured the same on the map and on the globe.
function markerColor(point: GeoPoint, kmps: number | undefined, theme: RouteVisualizationProps["theme"]) {
  if (point.role === "source") {
    return "#5ee7ff";
  }

  return speedColor(kmps, theme);
}

function formatHopCount(count?: number) {
  if (!count || count <= 0) {
    return t("point.routePoint");
  }

  return t(count > 1 ? "point.hops" : "point.hop", { n: count });
}

function formatHopNumberLabel(hops: HopResult[]) {
  const hopNumbers = [...new Set(hops.map((hop) => hop.hopNumber).filter((hopNumber) => hopNumber > 0))].sort(
    (a, b) => a - b
  );

  if (hopNumbers.length === 0) {
    return undefined;
  }

  const ranges: string[] = [];
  let rangeStart = hopNumbers[0];
  let previous = hopNumbers[0];

  hopNumbers.slice(1).forEach((hopNumber) => {
    if (hopNumber === previous + 1) {
      previous = hopNumber;
      return;
    }

    ranges.push(rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`);
    rangeStart = hopNumber;
    previous = hopNumber;
  });

  ranges.push(rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`);

  return t(hopNumbers.length > 1 ? "point.mappedHops" : "point.mappedHop", { ranges: ranges.join(", ") });
}

function markerRoleLabel(role: GeoPoint["role"]) {
  if (role === "source") {
    return "SRC";
  }

  if (role === "target") {
    return "DST";
  }

  return undefined;
}

function formatPacketLossMetric(hop: HopResult) {
  if (typeof hop.packetLossPercent === "number" && hop.packetLossPercent > 0) {
    const precision = hop.packetLossPercent % 1 === 0 ? 0 : 1;

    return t("point.loss", { n: hop.packetLossPercent.toFixed(precision) });
  }

  return undefined;
}

function formatStatusMetric(status: HopResult["status"]) {
  if (status === "ok") {
    return undefined;
  }

  return status;
}

function formatMetricLabel(hop?: HopResult) {
  if (!hop) {
    return undefined;
  }

  const metrics = [
    typeof hop.rttMs === "number" ? `${Math.round(hop.rttMs)} ms` : undefined,
    formatPacketLossMetric(hop),
    formatStatusMetric(hop.status)
  ].filter(Boolean);

  return metrics.join(" · ") || undefined;
}

function countryLocation(country?: string): Pick<GeoPoint, "lat" | "lng"> {
  const normalized = country?.toLowerCase() ?? "";

  if (normalized === "kr" || normalized.includes("korea")) {
    return { lat: 37.57, lng: 126.98 };
  }

  if (normalized === "jp" || normalized.includes("japan")) {
    return { lat: 35.68, lng: 139.76 };
  }

  if (normalized === "sg" || normalized.includes("singapore")) {
    return { lat: 1.35, lng: 103.82 };
  }

  if (normalized === "us" || normalized.includes("united states")) {
    return { lat: 39.82, lng: -98.58 };
  }

  if (normalized === "de" || normalized.includes("germany")) {
    return { lat: 51.16, lng: 10.45 };
  }

  if (normalized === "gb" || normalized.includes("united kingdom")) {
    return { lat: 55.37, lng: -3.44 };
  }

  if (normalized === "au" || normalized.includes("australia")) {
    return { lat: -25.27, lng: 133.77 };
  }

  if (normalized === "hk" || normalized.includes("hong kong")) {
    return { lat: 22.3193, lng: 114.1694 };
  }

  if (normalized === "cn" || normalized.includes("china")) {
    return { lat: 35.86, lng: 104.2 };
  }

  if (normalized === "fr" || normalized.includes("france")) {
    return { lat: 46.23, lng: 2.21 };
  }

  if (normalized === "nl" || normalized.includes("netherlands")) {
    return { lat: 52.13, lng: 5.29 };
  }

  if (normalized === "ca" || normalized.includes("canada")) {
    return { lat: 56.13, lng: -106.35 };
  }

  return { lat: 25, lng: 20 };
}

function sourceLocation(source?: MeasurementSource): Pick<GeoPoint, "lat" | "lng"> {
  if (typeof source?.latitude === "number" && typeof source?.longitude === "number") {
    return { lat: source.latitude, lng: source.longitude };
  }

  return countryLocation(source?.country);
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

  if (normalized === "hk" || normalized === "hong kong") {
    return "Hong Kong";
  }

  if (normalized === "gb" || normalized.includes("united kingdom")) {
    return "UK";
  }

  if (normalized === "germany") {
    return "DE";
  }

  if (normalized === "australia") {
    return "AU";
  }

  return country;
}

function formatSourceLabel(source?: MeasurementSource) {
  return [source?.city, formatCountryLabel(source?.country)].filter(Boolean).join(", ") || t("point.nearbyProbe");
}

function formatEndpointTooltipLabel(place: RoutePlace) {
  if (!place.country || place.country === "Probe" || place.country === "Target") {
    return place.city;
  }

  return [place.city, place.country].filter(Boolean).join(" ");
}

function formatTransitLocationLabel(place?: RoutePlace) {
  if (!place) {
    return t("point.estimatedRegion");
  }

  const city = place.city?.trim();
  const country = place.country?.trim();

  if (city && country && city.toLowerCase() !== country.toLowerCase() && country.toLowerCase() !== "unknown") {
    return `${city}, ${country}`;
  }

  return city || country || t("point.estimatedRegion");
}

function makePlace(
  city: string,
  country: string,
  lat: number,
  lng: number,
  meta?: Pick<RoutePlace, "confidence" | "evidence" | "precision" | "source">
): RoutePlace {
  return {
    city,
    country,
    key: `${city.toLowerCase()}:${country.toLowerCase()}`,
    lat,
    lng,
    ...meta
  };
}

function asMetadata(asn?: string): AsMetadata | undefined {
  switch (asn) {
    case "AS15169":
      return {
        name: "Google LLC",
        country: "US"
      };
    case "AS13335":
      return {
        name: "Cloudflare",
        country: "US"
      };
    case "AS4637":
      return {
        name: "Telstra Global",
        country: "AU"
      };
    case "AS63473":
      return {
        name: "HostHatch",
        country: "US"
      };
    case "AS8560":
      return {
        name: "IONOS SE",
        country: "DE"
      };
    case "AS3356":
      return {
        name: "Lumen",
        country: "US"
      };
    case "AS64512":
      return {
        name: t("point.privateNetwork"),
        country: "Private"
      };
    case "AS9318":
      return {
        name: "SK Broadband",
        country: "KR"
      };
    default:
      return undefined;
  }
}

function combinePlaces(places: RoutePlace[]): RoutePlace | undefined {
  const uniquePlaces = [...new Map(places.map((place) => [place.key, place])).values()];

  if (uniquePlaces.length === 0) {
    return undefined;
  }

  if (uniquePlaces.length === 1) {
    return uniquePlaces[0];
  }

  const country = uniquePlaces[0].country;
  const cityLabel = uniquePlaces
    .map((place) => place.city)
    .filter(Boolean)
    .slice(0, 2)
    .join(" / ");

  return makePlace(
    cityLabel || t("point.region"),
    country,
    uniquePlaces.reduce((sum, place) => sum + place.lat, 0) / uniquePlaces.length,
    uniquePlaces.reduce((sum, place) => sum + place.lng, 0) / uniquePlaces.length
  );
}

function sourcePlace(source?: MeasurementSource): RoutePlace {
  const location = sourceLocation(source);

  return makePlace(
    source?.city || t("point.nearbyProbe"),
    formatCountryLabel(source?.country) || source?.country || "Probe",
    location.lat,
    location.lng
  );
}

function placeFromCountryHop(hop: HopResult): RoutePlace | undefined {
  if (
    typeof hop.latitude !== "number" ||
    !Number.isFinite(hop.latitude) ||
    typeof hop.longitude !== "number" ||
    !Number.isFinite(hop.longitude)
  ) {
    return undefined;
  }

  return makePlace(
    hop.city || hop.hostname || hop.ip || "Network",
    formatCountryLabel(hop.country) || hop.country || "Unknown",
    hop.latitude,
    hop.longitude,
    {
      confidence: hop.locationConfidence,
      evidence: hop.locationEvidence,
      precision: hop.locationPrecision,
      source: hop.locationSource
    }
  );
}

function inferHopPlace(params: {
  hop: HopResult;
  hopIndex: number;
  source?: MeasurementSource;
  target: string;
}): RoutePlace | undefined {
  const explicitPlace = placeFromCountryHop(params.hop);

  if (explicitPlace) {
    return explicitPlace;
  }

  return undefined;
}

function statusRank(status: HopResult["status"]) {
  const ranks: Record<HopResult["status"], number> = {
    pending: 0,
    ok: 1,
    slow: 2,
    loss: 3,
    timeout: 4
  };

  return ranks[status];
}

function strongerStatus(current: HopResult["status"], next: HopResult["status"]) {
  return statusRank(next) > statusRank(current) ? next : current;
}

function groupHopsByAsPlace(params: {
  hops: HopResult[];
  source?: MeasurementSource;
  target: string;
}): AsRouteGroup[] {
  return params.hops.reduce<AsRouteGroup[]>((groups, hop, index) => {
    const asn = hop.asn || "AS???";
    const metadata = asMetadata(asn);
    const asName = metadata?.name ?? hop.asName;
    const place = inferHopPlace({
      hop,
      hopIndex: index + 1,
      source: params.source,
      target: params.target
    });
    const groupCountry = place?.country ?? metadata?.country ?? "unknown";
    const groupLocationKey = place?.key ?? groupCountry;
    const groupKey = `${asn}:${groupLocationKey}`;
    const previous = groups.at(-1);
    const previousCountry = previous?.place?.country ?? previous?.asCountry ?? "unknown";
    const previousLocationKey = previous?.place?.key ?? previousCountry;
    const previousKey = previous ? `${previous.asn}:${previousLocationKey}` : undefined;

    if (previous && previousKey === groupKey) {
      previous.hops.push(hop);
      if (place && !previous.places.some((candidate) => candidate.key === place.key)) {
        previous.places.push(place);
        previous.place = combinePlaces(previous.places);
      }
      previous.status = strongerStatus(previous.status, hop.status);
      return groups;
    }

    groups.push({
      asn,
      asName,
      asCountry: metadata?.country,
      place,
      places: place ? [place] : [],
      hops: [hop],
      status: hop.status
    });

    return groups;
  }, []);
}

function shouldRenderGroup(group: AsRouteGroup) {
  if (group.asn === "AS???") {
    return false;
  }

  return Boolean(group.place);
}

function sampleGroups(groups: AsRouteGroup[], maxCount: number) {
  if (groups.length <= maxCount) {
    return groups;
  }

  return Array.from({ length: maxCount }, (_value, index) => {
    const sourceIndex = Math.round((index / (maxCount - 1)) * (groups.length - 1));

    return groups[sourceIndex];
  });
}

function routeGroupKey(group: AsRouteGroup) {
  return group.place?.key ?? `${group.asn}:unknown`;
}

function mergeRepeatedRouteGroups(groups: AsRouteGroup[]) {
  const mergedGroups: AsRouteGroup[] = [];

  groups.forEach((group) => {
    const key = routeGroupKey(group);
    const existing = mergedGroups.at(-1);

    if (!existing || routeGroupKey(existing) !== key) {
      const groupCopy = {
        ...group,
        hops: [...group.hops],
        places: [...group.places]
      };

      mergedGroups.push(groupCopy);
      return;
    }

    existing.hops.push(...group.hops);
    group.places.forEach((place) => {
      if (!existing.places.some((candidate) => candidate.key === place.key)) {
        existing.places.push(place);
      }
    });
    existing.place = combinePlaces(existing.places) ?? existing.place;
    existing.status = group.hops.reduce((status, hop) => strongerStatus(status, hop.status), existing.status);
  });

  return mergedGroups;
}

function uniqueValues(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function formatGroupAsnLabel(group: AsRouteGroup, fallbackAsn: string) {
  const asns = uniqueValues(group.hops.map((hop) => hop.asn)).filter((asn) => asn !== "AS???");

  if (asns.length === 0) {
    return fallbackAsn;
  }

  if (asns.length <= 2) {
    return asns.join(" / ");
  }

  return `${asns[0]} +${asns.length - 1} AS`;
}

function formatGroupNetworkLabel(group: AsRouteGroup, fallbackName?: string) {
  const names = uniqueValues(
    group.hops.map((hop) => {
      const metadata = asMetadata(hop.asn);

      return metadata?.name ?? hop.asName;
    })
  );

  if (names.length === 0) {
    return fallbackName || t("point.unknownNetwork");
  }

  if (names.length <= 2) {
    return names.join(" / ");
  }

  return `${names[0]} +${names.length - 1} networks`;
}

function samePlace(a: RoutePlace, b: RoutePlace) {
  return Math.abs(a.lat - b.lat) < 0.08 && Math.abs(a.lng - b.lng) < 0.08;
}

function sameDisplayPlace(a: RoutePlace, b: RoutePlace) {
  return samePlace(a, b) || Math.hypot(a.lat - b.lat, a.lng - b.lng) < 0.7;
}

function sameDisplayPoint(a: GeoPoint, b: GeoPoint) {
  return Math.abs(a.lat - b.lat) < 0.08 && Math.abs(a.lng - b.lng) < 0.08
    ? true
    : Math.hypot(a.lat - b.lat, a.lng - b.lng) < 0.7;
}

function mergeTransitPoint(existing: GeoPoint, next: GeoPoint) {
  const hopCount = (existing.hopCount ?? 1) + (next.hopCount ?? 1);
  const status =
    existing.status !== "source" && existing.status !== "target" && next.status !== "source" && next.status !== "target"
      ? strongerStatus(existing.status, next.status)
      : existing.status;

  return {
    ...existing,
    hopCount,
    status,
    subLabel: [existing.subLabel, next.subLabel].filter(Boolean).join(" · ")
  };
}

function mergeRepeatedDisplayPoints(points: GeoPoint[]) {
  const merged: GeoPoint[] = [];

  points.forEach((point) => {
    if (point.role !== "transit") {
      merged.push(point);
      return;
    }

    const previous = merged.at(-1);

    if (previous?.role !== "transit" || !sameDisplayPoint(previous, point)) {
      merged.push(point);
      return;
    }

    merged[merged.length - 1] = mergeTransitPoint(previous, point);
  });

  return merged;
}

// A trace that stops on an answering router at the hop limit may have run out of TTL; one
// that trails off into silence reached a network that drops probes. Only the second can be
// asserted - every measured "hit the limit" so far was a firewall at hop 19-20 too, and MTR's
// 30 hops found nothing past it - so the wording states what was seen, not a cause.
function routeNote(hops: HopResult[], mode: TraceMode, reachedTarget?: boolean, inferredSeaLegs = false) {
  const base = t("note.base", { n: hops.length }) + (inferredSeaLegs ? t("note.inferred") : "");

  if (reachedTarget !== false) {
    return base;
  }

  const hopLimit = mode === "mtr" ? 30 : 20;
  const lastAnswer = [...hops].reverse().find((hop) => hop.ip);
  const ranOutOfHops = hops.length >= hopLimit && Boolean(hops.at(-1)?.ip);
  const reason = ranOutOfHops
    ? t("note.hopLimit", { n: hopLimit }) + (mode === "mtr" ? "" : t("note.hopLimitMtr"))
    : t("note.noAnswer", { after: lastAnswer ? t("note.afterHop", { n: lastAnswer.hopNumber }) : "" });

  return base + t("note.notReached", { reason });
}

function targetGeoHopFromHops(hops: HopResult[]) {
  return [...hops].reverse().find((hop) => placeFromCountryHop(hop));
}

function lastHopForGroup(group: AsRouteGroup | undefined, hops: HopResult[], index: number) {
  return group?.hops.at(-1) ?? hops[Math.min(index, hops.length - 1)];
}

function targetPlaceFromHops(target: string, hops: HopResult[]): RoutePlace | undefined {
  const targetHop = targetGeoHopFromHops(hops);
  const place = targetHop ? placeFromCountryHop(targetHop) : undefined;

  if (!place) {
    return undefined;
  }

  return makePlace(target, "Target", place.lat, place.lng, {
    confidence: place.confidence,
    evidence: place.evidence,
    precision: place.precision,
    source: place.source
  });
}

function haversineKm(a: GeoPoint, b: GeoPoint) {
  const earthRadiusKm = 6371;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));

  return 2 * earthRadiusKm * Math.asin(Math.sqrt(value));
}

function formatAsPath(hops: HopResult[]) {
  const path: string[] = [];

  for (const hop of hops) {
    const asn = hop.asn;

    if (!asn || asn === "AS???" || asn === path.at(-1)) {
      continue;
    }

    path.push(asn);
  }

  return path;
}

function routeSummary(points: GeoPoint[], hops: HopResult[], legs: GlobeLeg[]) {
  const distanceKm = points.reduce(
    (total, point, index) => (index === 0 ? 0 : total + haversineKm(points[index - 1], point)),
    0
  );
  // Length of what is actually drawn: cable chains where a leg was inferred, straight lines
  // elsewhere. Longer than the straight line between hops whenever a cable goes round a coast.
  const drawnKm = legs.reduce((total, leg) => total + pathKm(leg.path), 0);
  // How much of the drawn path runs under the sea along cables, how much is a straight line
  // across water no chain was found for, and the rest is over land.
  const seaKm = legs.reduce((total, leg) => total + (leg.kind === "sea" ? pathKm(leg.path) : 0), 0);
  const unresolvedKm = legs.reduce((total, leg) => total + (leg.kind === "direct" && leg.crossing ? pathKm(leg.path) : 0), 0);
  const finalRttMs = [...hops].reverse().find((hop) => typeof hop.rttMs === "number")?.rttMs;
  // Round trip over the straight line between hops against the last measured latency, the
  // same way a network engineer sanity-checks a route: anything near light speed means the
  // hops are placed closer together than the packet really travelled.
  const speedKmPerSecond =
    distanceKm > 0 && finalRttMs ? Math.round((distanceKm * 2) / (finalRttMs / 1000)) : undefined;

  // Every cable system the drawn path rides, in order, once each.
  const cables = [...new Set(legs.flatMap((leg) => leg.cables ?? []))];

  return {
    asPath: formatAsPath(hops),
    distanceKm: Math.round(distanceKm),
    pathKm: Math.round(drawnKm),
    seaKm: Math.round(seaKm),
    landKm: Math.round(drawnKm - seaKm - unresolvedKm),
    unresolvedKm: Math.round(unresolvedKm),
    speedKmPerSecond,
    cables
  };
}

function buildRoutePoints(params: {
  hops: HopResult[];
  target: string;
  source?: MeasurementSource;
  reachedTarget?: boolean;
}): GeoPoint[] {
  const start = sourcePlace(params.source);
  // When no hop answered from the target's address, the last router that did is just the
  // last router: it is drawn as an ordinary hop, never with the target's name on it.
  const end = params.reachedTarget === false ? undefined : targetPlaceFromHops(params.target, params.hops);
  const points: GeoPoint[] = [
    {
      ...start,
      label: formatEndpointTooltipLabel(start),
      role: "source",
      city: start.city,
      country: start.country,
      status: "source",
      operators: params.source?.network ? [params.source.network] : undefined
    }
  ];

  const asGroups = sampleGroups(
    mergeRepeatedRouteGroups(
      groupHopsByAsPlace({ hops: params.hops, source: params.source, target: params.target })
        .filter(shouldRenderGroup)
        .filter((group) => {
          if (!group.place) {
            return false;
          }

          const overlapsSource = sameDisplayPlace(group.place, start);
          const overlapsTarget = Boolean(end && sameDisplayPlace(group.place, end));

          return !overlapsSource && !overlapsTarget;
        })
    ),
    12
  );
  const effectiveTransitCount = asGroups.length;

  Array.from({ length: effectiveTransitCount }, (_value, index) => {
    const group = asGroups[index];
    const hop = lastHopForGroup(group, params.hops, index);
    const hopCount = group?.hops.length ?? 1;
    const asn = group?.asn ?? hop?.asn ?? "AS???";
    const metadata = asMetadata(asn);
    const asName = group?.asName ?? metadata?.name;
    const place = group?.place;
    const lat = place?.lat ?? start.lat;
    const lng = place?.lng ?? start.lng;
    const locationLabel = formatTransitLocationLabel(place);
    const asnLabel = group ? formatGroupAsnLabel(group, asn) : asn;
    const networkName = group ? formatGroupNetworkLabel(group, asName) : asName || t("point.unknownNetwork");
    const hopNumberLabel = formatHopNumberLabel(group?.hops ?? (hop ? [hop] : []));
    const groupedHopCountLabel = hopCount > 1 ? formatHopCount(hopCount) : undefined;
    const metricLabel = formatMetricLabel(hop);
    const rtts = (group?.hops ?? (hop ? [hop] : [])).map((entry) => entry.rttMs).filter((value): value is number => typeof value === "number");

    points.push({
      lat,
      lng,
      label: `${asnLabel} · ${networkName} · ${locationLabel}`,
      role: "transit",
      asn,
      city: place?.city,
      country: place?.country,
      hopCount,
      subLabel: [hopNumberLabel, groupedHopCountLabel, metricLabel].filter(Boolean).join(" · "),
      status: group?.status ?? hop.status,
      // The same hop the metric label describes, so colour and caption never disagree.
      rttMs: hop?.rttMs ?? (rtts.length > 0 ? Math.min(...rtts) : undefined),
      operators: uniqueValues(
        [...(group?.hops ?? (hop ? [hop] : [])).flatMap((entry) => [entry.asName, entry.asOrg]), asName].filter((name): name is string => Boolean(name))
      )
    });
  });

  if (params.hops.length > 0 && end) {
    points.push({
      ...end,
      label: params.target,
      role: "target",
      city: end.city,
      country: end.country,
      status: "target",
      rttMs: [...params.hops].reverse().find((entry) => typeof entry.rttMs === "number")?.rttMs,
      operators: uniqueValues([...params.hops].reverse().slice(0, 3).flatMap((entry) => [entry.asName, entry.asOrg]).filter((name): name is string => Boolean(name)))
    });
  }

  return mergeRepeatedDisplayPoints(points).map((point, index) => ({
    ...point,
    sequence: index + 1
  }));
}

function appendTowerIcon(parent: HTMLElement) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "packet-map-marker__tower");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");

  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "8.8");
  circle.setAttribute("r", "1.35");
  svg.append(circle);

  [
    "M12 10.2V20",
    "M8.2 20H15.8",
    "M8.9 17.1L12 10.8L15.1 17.1",
    "M7.9 12.5C7.2 11.4 6.9 10.2 6.9 8.8C6.9 7.5 7.2 6.3 7.9 5.2",
    "M16.1 12.5C16.8 11.4 17.1 10.2 17.1 8.8C17.1 7.5 16.8 6.3 16.1 5.2",
    "M5.2 14.2C4.2 12.5 3.7 10.7 3.7 8.8C3.7 6.9 4.2 5.1 5.2 3.5",
    "M18.8 14.2C19.8 12.5 20.3 10.7 20.3 8.8C20.3 6.9 19.8 5.1 18.8 3.5"
  ].forEach((pathData) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    svg.append(path);
  });

  parent.append(svg);
}

function markerElement(point: GeoPoint, color: string, visualSize: number) {
  const marker = document.createElement("span");
  marker.className = `packet-map-marker packet-map-marker--${point.role}`;
  marker.style.setProperty("--marker-color", color);
  marker.style.setProperty("--marker-visual-size", `${visualSize}px`);

  ["halo", "ring", "dot"].forEach((part) => {
    const child = document.createElement("span");
    child.className = `packet-map-marker__${part}`;
    marker.append(child);
  });

  if (point.role === "transit") {
    appendTowerIcon(marker);
  }

  const label = markerRoleLabel(point.role);

  if (label) {
    const labelElement = document.createElement("span");
    labelElement.className = "packet-map-marker__label";
    labelElement.textContent = label;
    marker.append(labelElement);
  }

  return marker;
}

function markerIcon(point: GeoPoint, kmps: number | undefined, theme: RouteVisualizationProps["theme"]) {
  const color = markerColor(point, kmps, theme);
  const visualSize = point.role === "transit" ? 30 : 72;
  const hitSize = point.role === "transit" ? 30 : 24;
  const anchorX = hitSize / 2;
  const anchorY = hitSize / 2;

  return L.divIcon({
    className: `packet-map-marker-wrapper packet-map-marker-wrapper--${point.role}`,
    iconSize: [hitSize, hitSize],
    iconAnchor: [anchorX, anchorY],
    html: markerElement(point, color, visualSize)
  });
}

function routeLatLngs(points: GeoPoint[]) {
  return points.map((point) => L.latLng(point.lat, point.lng));
}

// The flat map cannot wrap, so a leg that crosses the antimeridian is drawn the short way
// round in two pieces - one ending at the map's edge, one resuming on the other side -
// instead of the long way across the whole map. A Seoul-to-Miami hop crossed the Pacific.
function routeParts(points: Array<{ lat: number; lng: number }>): L.LatLng[][] {
  const parts: L.LatLng[][] = [];
  let current: L.LatLng[] = [];

  points.forEach((point, index) => {
    if (index > 0) {
      const previous = points[index - 1];
      const delta = point.lng - previous.lng;

      if (Math.abs(delta) > 180) {
        const edge = delta > 0 ? -180 : 180;
        const shifted = point.lng + (delta > 0 ? -360 : 360);
        const share = (edge - previous.lng) / (shifted - previous.lng);
        const crossingLat = previous.lat + (point.lat - previous.lat) * share;

        current.push(L.latLng(crossingLat, edge));
        parts.push(current);
        current = [L.latLng(crossingLat, -edge)];
      }
    }

    current.push(L.latLng(point.lat, point.lng));
  });
  parts.push(current);

  return parts.filter((part) => part.length > 1);
}

// The white casing under the route on the light map, so it reads over the pale basemap.
function routeColors(theme: RouteVisualizationProps["theme"]) {
  return { casing: theme === "light" ? "#ffffff" : "#d5f8ff" };
}

function routeSpan(bounds: L.LatLngBounds) {
  return Math.max(
    Math.abs(bounds.getEast() - bounds.getWest()),
    Math.abs(bounds.getNorth() - bounds.getSouth())
  );
}

function maxRouteZoom(span: number) {
  if (span > 80) {
    return 3.75;
  }

  if (span > 55) {
    return 4.15;
  }

  return span > 28 ? 4.85 : 6.25;
}

function fitRouteToBounds(params: {
  animate: boolean;
  bounds: L.LatLngBounds;
  fittedRouteKeyRef: MutableRefObject<string>;
  map: L.Map;
  markFitted: boolean;
  routeSpan: number;
  routeViewKey: string;
}) {
  params.map.invalidateSize({ animate: false, pan: false });
  params.map.fitBounds(params.bounds.pad(params.routeSpan > 55 ? 0.12 : 0.2), {
    animate: params.animate,
    duration: params.animate ? 0.55 : 0,
    maxZoom: maxRouteZoom(params.routeSpan),
    paddingTopLeft: [110, 118],
    paddingBottomRight: [110, 112]
  });

  if (params.markFitted) {
    params.fittedRouteKeyRef.current = params.routeViewKey;
  }
}

function scheduleRouteFit(params: {
  bounds: L.LatLngBounds;
  fittedRouteKeyRef: MutableRefObject<string>;
  map: L.Map;
  routeSpan: number;
  routeViewKey: string;
}) {
  let fitTimeout: ReturnType<typeof setTimeout> | undefined;
  const fitFrame = globalThis.requestAnimationFrame(() => {
    fitRouteToBounds({ ...params, animate: true, markFitted: true });
    fitTimeout = globalThis.setTimeout(() => {
      fitRouteToBounds({ ...params, animate: true, markFitted: true });
    }, 180);
  });

  return () => {
    globalThis.cancelAnimationFrame(fitFrame);
    if (fitTimeout !== undefined) {
      globalThis.clearTimeout(fitTimeout);
    }
  };
}

function scheduleSinglePointFit(params: {
  fittedRouteKeyRef: MutableRefObject<string>;
  latLng?: L.LatLng;
  map: L.Map;
  routeViewKey: string;
}) {
  const frame = globalThis.requestAnimationFrame(() => {
    params.map.invalidateSize({ animate: false, pan: false });
    params.map.setView(params.latLng ?? L.latLng(24, 20), 3, { animate: true });
    params.fittedRouteKeyRef.current = params.routeViewKey;
  });

  return () => globalThis.cancelAnimationFrame(frame);
}

function addRouteLines(params: {
  parts: L.LatLng[][];
  legs: GlobeLeg[];
  layer: L.LayerGroup;
  theme: RouteVisualizationProps["theme"];
}) {
  const colors = routeColors(params.theme);
  const light = params.theme === "light";

  // A white casing under everything on the light map, so the route reads over the basemap.
  if (light) {
    L.polyline(params.parts, { color: colors.casing, weight: 4.5, opacity: 0.9, smoothFactor: 2, className: "packet-map-route-casing" }).addTo(params.layer);
  }

  // Neon, leg by leg in the colour of the leg's speed: a wide soft bloom, a tighter one,
  // a solid core and a thin near-white filament down the middle.
  for (const leg of params.legs) {
    const legParts = routeParts(leg.path.map(([lat, lng]) => ({ lat, lng })));

    if (legParts.length === 0) {
      continue;
    }

    // Unknown speed is the legend's grey, on both maps, never a colour that reads as a verdict.
    const color = speedColor(leg.kmps, params.theme);
    const layers: Array<[number, number, string, string]> = [
      [8, light ? 0.18 : 0.26, color, "packet-map-route-bloom"],
      [3.4, light ? 0.36 : 0.55, color, "packet-map-route-bloom"],
      [1.4, 1, color, "packet-map-route"],
      // A leg without a speed keeps the legend's grey; pulled to white it read as a verdict.
      [0.7, 1, lighten(color, leg.kmps === undefined ? 0.15 : 0.65), "packet-map-route-filament"]
    ];

    for (const [weight, opacity, stroke, className] of layers) {
      L.polyline(legParts, { color: stroke, weight, opacity, smoothFactor: 2, className }).addTo(params.layer);
    }
  }
}

// A wide invisible line over each leg, so hovering the route says what it is: a sea leg
// inferred along named cables, or a direct line between two measured hops.
function addLegTooltips(params: { legs: GlobeLeg[]; layer: L.LayerGroup }) {
  for (const leg of params.legs) {
    const parts = routeParts(leg.path.map(([lat, lng]) => ({ lat, lng })));

    if (parts.length === 0) {
      continue;
    }

    const { title, meta, why, speed } = legLabel(leg);
    const content = document.createElement("div");
    const heading = document.createElement("div");
    heading.className = "packet-map-tooltip__title";
    heading.textContent = title;
    const detail = document.createElement("div");
    detail.className = "packet-map-tooltip__meta";
    detail.textContent = meta;
    content.append(heading, detail);

    if (why) {
      const reason = document.createElement("div");
      reason.className = "packet-map-tooltip__why";
      reason.textContent = why;
      content.append(reason);
    }

    const pace = document.createElement("div");
    pace.className = "packet-map-tooltip__speed";
    pace.textContent = speed;
    content.append(pace);

    L.polyline(parts, { weight: 14, opacity: 0, className: "packet-map-route-hit" })
      .bindTooltip(content, { sticky: true, className: "packet-map-tooltip packet-map-tooltip--cable" })
      .addTo(params.layer);
  }
}

function setMinimumZoom(map: L.Map, width: number) {
  const nextMinZoom = minimumWorldZoom(width);
  const isAtMinimumZoom = map.getZoom() <= map.getMinZoom() + 0.01;

  map.setMinZoom(nextMinZoom);

  if (isAtMinimumZoom || map.getZoom() < nextMinZoom) {
    map.setView(FLAT_MAP_CENTER, nextMinZoom, { animate: false });
    map.stop();
  }
}

function observeRouteResize(container: HTMLDivElement, map: L.Map) {
  let resizeTimeout: ReturnType<typeof setTimeout> | undefined;
  let observedSize = {
    height: container.clientHeight,
    width: container.clientWidth
  };

  setMinimumZoom(map, observedSize.width);

  if (typeof ResizeObserver === "undefined") {
    return () => undefined;
  }

  const resizeObserver = new ResizeObserver((entries) => {
    const nextSize = entries[0]?.contentRect;

    if (!nextSize) {
      return;
    }

    const widthDelta = Math.abs(nextSize.width - observedSize.width);
    const heightDelta = Math.abs(nextSize.height - observedSize.height);

    if (widthDelta < 1 && heightDelta < 1) {
      return;
    }

    observedSize = {
      height: nextSize.height,
      width: nextSize.width
    };

    setMinimumZoom(map, nextSize.width);
    if (resizeTimeout !== undefined) {
      globalThis.clearTimeout(resizeTimeout);
    }
    resizeTimeout = globalThis.setTimeout(() => {
      map.invalidateSize({ animate: false, pan: false });
    }, 140);
  });

  resizeObserver.observe(container);

  return () => {
    if (resizeTimeout !== undefined) {
      globalThis.clearTimeout(resizeTimeout);
    }
    resizeObserver.disconnect();
  };
}

function tooltipContent(point: GeoPoint) {
  const wrapper = document.createElement("div");
  const title = document.createElement("div");
  title.className = "packet-map-tooltip__title";
  title.textContent = point.label;
  wrapper.append(title);

  if (point.subLabel) {
    const meta = document.createElement("div");
    meta.className = "packet-map-tooltip__meta";
    meta.textContent = point.subLabel;
    wrapper.append(meta);
  }

  return wrapper;
}

function addRouteMarkers(layer: L.LayerGroup, routePoints: GeoPoint[], legs: GlobeLeg[], theme: RouteVisualizationProps["theme"], unreached?: Unreached) {
  const last = routePoints[routePoints.length - 1];

  if (unreached && last) {
    const badge = document.createElement("span");
    badge.className = "packet-map-unreached";
    badge.textContent = `${unreached.target} · ${t("point.unreachedShort")}`;

    L.marker([last.lat, last.lng], { icon: L.divIcon({ className: "packet-map-unreached-wrapper", html: badge, iconSize: [0, 0], iconAnchor: [0, 0] }), keyboard: false, zIndexOffset: 950, interactive: true })
      .bindTooltip(`${t("point.unreached")}: ${t("point.unreachedMeta", { target: unreached.target, n: unreached.hop })}`, { direction: "top", offset: [0, -6], opacity: 0.95, className: "packet-map-tooltip" })
      .addTo(layer);
  }

  routePoints.forEach((point, index) => {
    const baseZIndex = 100 + (point.sequence ?? 0);
    let zIndexOffset = baseZIndex;

    if (point.role === "target") {
      zIndexOffset = 900;
    } else if (point.role === "source") {
      zIndexOffset = 800;
    }

    const marker = L.marker([point.lat, point.lng], {
      icon: markerIcon(point, index > 0 ? legs[index - 1]?.kmps : undefined, theme),
      keyboard: false,
      zIndexOffset
    }).addTo(layer);

    marker.bindTooltip(tooltipContent(point), {
      direction: "top",
      offset: [0, point.role === "transit" ? -10 : -18],
      opacity: 0.95,
      className: "packet-map-tooltip"
    });
  });
}

const FLAT_MAP_WEST = -180;
const FLAT_MAP_EAST = 180;
const FLAT_MAP_CENTER = L.latLng(0, 8);
const flatMapBounds = L.latLngBounds([-84, FLAT_MAP_WEST], [84, FLAT_MAP_EAST]);

function minimumWorldZoom(width: number) {
  const safeWidth = Math.max(width, 320);

  return Math.max(1.2, Math.log2(safeWidth / 256) - 0.025);
}

function flatMapLongitude(lng: number) {
  if (!Number.isFinite(lng)) {
    return 0;
  }

  let nextLng = ((lng + 180) % 360) - 180;

  if (nextLng < -180) {
    nextLng += 360;
  }

  return nextLng;
}

function displayRouteLongitudes(points: GeoPoint[]) {
  return points.map((point) => ({
    ...point,
    lng: flatMapLongitude(point.lng)
  }));
}

export function RouteVisualization({ mode, status, target, hops, source, theme, error, reachedTarget }: RouteVisualizationProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Labels are built in the page's language; a change rebuilds them.
  const { lang } = useLang();
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const fittedRouteKeyRef = useRef("");
  // A failed lookup has no probe coordinates either, and the fallbacks would drop a lone
  // "source" pin off the Gulf of Guinea. Draw nothing rather than a place nobody measured from.
  const routePoints = useMemo(
    () =>
      error && hops.length === 0
        ? []
        : displayRouteLongitudes(buildRoutePoints({ hops, target, source, reachedTarget })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [error, hops, source, target, reachedTarget, lang]
  );
  const globePoints = useMemo(
    () => (error && hops.length === 0 ? [] : toGlobePoints(buildRoutePoints({ hops, target, source, reachedTarget }), unreachedTarget({ hops, target, reachedTarget }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [error, hops, source, target, reachedTarget, lang]
  );
  // The route details fold away on a phone, where they would cover half the map.
  const [hudOpen, setHudOpen] = useState(false);
  const [view, setView] = useState<RouteView>("3d");
  const previousStatus = useRef(status);
  const [cables, setCables] = useState(() => readPreference("nangman.route-cables", "on") === "on");
  const [pathMode, setPathMode] = useState<PathMode>(readPathMode);

  useEffect(() => {
    writePreference("nangman.route-path", pathMode);
  }, [pathMode]);

  // Legs come straight from the cache when the route was prepared during the wait, and
  // from the router worker otherwise - never computed on this thread.
  const [routeLegs, setRouteLegs] = useState<GlobeLeg[]>(() => legsFromCache(globePoints, pathMode) ?? []);

  useEffect(() => {
    const cached = legsFromCache(globePoints, pathMode);

    if (cached) {
      setRouteLegs(cached);
      return;
    }

    let cancelled = false;

    resolveLegs(globePoints, pathMode).then((legs) => {
      if (!cancelled) {
        setRouteLegs(legs);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [globePoints, pathMode]);
  const hasInferredLegs = pathMode === "cable" && routeLegs.some((leg) => leg.inferred);

  // Every new search opens on the globe; the flat map stays one click away. A transition,
  // so the globe's code loading never swaps the map for a loading message.
  useEffect(() => {
    const started = status === "starting" || status === "running";
    const wasStarted = previousStatus.current === "starting" || previousStatus.current === "running";

    if (started && !wasStarted) {
      startTransition(() => setView("3d"));
    }

    previousStatus.current = status;
  }, [status]);

  // Fetch the globe's code and data while the visitor is still typing, so that when the
  // first hops arrive the globe is already on hand.
  useEffect(() => {
    const warm = () => {
      // The globe is built now, in idle time - renderer, borders, lights, cables - so
      // opening it later costs a resize, not a construction.
      void import("./GlobeView").then((module) => module.warmGlobe());
    };
    const idle = (globalThis as { requestIdleCallback?: (callback: () => void) => number }).requestIdleCallback;
    const handle = idle ? idle(warm) : setTimeout(warm, 1200);

    return () => {
      if (idle) (globalThis as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback?.(handle as number);
      else clearTimeout(handle as ReturnType<typeof setTimeout>);
    };
  }, []);

  useEffect(() => {
    writePreference("nangman.route-cables", cables ? "on" : "off");
  }, [cables]);

  const routeViewKey = useMemo(
    () =>
      routePoints
        .map((point) => `${point.role}:${point.lat.toFixed(4)},${point.lng.toFixed(4)}:${point.label}`)
        .join("|"),
    [routePoints]
  );
  const summary = useMemo(() => routeSummary(routePoints, hops, routeLegs), [hops, routePoints, routeLegs]);
  // Each point carries the speed of the leg that reaches it, for the globe's rings.
  const globePointsWithSpeed = useMemo(() => withLegSpeeds(globePoints, routeLegs), [globePoints, routeLegs]);
  const sourcePlaceLabel = [source?.city, formatCountryLabel(source?.country)].filter(Boolean).join(", ");
  const sourceBadge = sourcePlaceLabel
    ? t("map.measuredFrom", { place: `${sourcePlaceLabel}${source?.network ? ` · ${source.network}` : ""}` })
    : t("map.measuredNearby");

  // The flat map is built the first time it is looked at, not under the globe on every
  // result, and is kept afterwards.
  const [mapWanted, setMapWanted] = useState(view === "2d");

  useEffect(() => {
    if (view === "2d") {
      setMapWanted(true);
    }
  }, [view]);

  useEffect(() => {
    if (!mapWanted || !containerRef.current || mapRef.current) {
      return;
    }

    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: false,
      worldCopyJump: false,
      bounceAtZoomLimits: false,
      minZoom: 0,
      maxZoom: 12,
      zoomSnap: 0.5,
      zoomDelta: 0.75,
      wheelPxPerZoomLevel: 58,
      wheelDebounceTime: 28,
      zoomAnimation: true,
      zoomAnimationThreshold: 4,
      markerZoomAnimation: true,
      fadeAnimation: true,
      easeLinearity: 0.22,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      touchZoom: true,
      dragging: true,
      inertia: true,
      inertiaDeceleration: 4800,
      inertiaMaxSpeed: 620,
      maxBounds: flatMapBounds,
      maxBoundsViscosity: 1
    }).setView(FLAT_MAP_CENTER, 3);

    L.control.zoom({ position: "topleft" }).addTo(map);
    L.control.attribution({ position: "bottomright", prefix: false }).addTo(map);

    let isApplyingMinimumView = false;

    const applyMinimumView = () => {
      if (isApplyingMinimumView) {
        return;
      }

      isApplyingMinimumView = true;
      map.setView(FLAT_MAP_CENTER, map.getMinZoom(), { animate: false });
      map.stop();

      globalThis.setTimeout(() => {
        isApplyingMinimumView = false;
      }, 0);
    };

    const syncMinimumZoomInteraction = () => {
      if (isApplyingMinimumView) {
        return;
      }

      if (map.getZoom() <= map.getMinZoom() + 0.01) {
        const center = map.getCenter();

        if (Math.abs(center.lat - FLAT_MAP_CENTER.lat) > 0.01 || Math.abs(center.lng - FLAT_MAP_CENTER.lng) > 0.01) {
          applyMinimumView();
        }

        map.dragging.disable();
        return;
      }

      map.dragging.enable();
    };

    const preventZoomPastMinimum = (event: WheelEvent) => {
      if (event.deltaY <= 0 || map.getZoom() > map.getMinZoom() + 0.01) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const center = map.getCenter();

      if (Math.abs(center.lat - FLAT_MAP_CENTER.lat) > 0.01 || Math.abs(center.lng - FLAT_MAP_CENTER.lng) > 0.01) {
        applyMinimumView();
      }
    };

    containerRef.current.addEventListener("wheel", preventZoomPastMinimum, { passive: false });
    map.on("zoomend", syncMinimumZoomInteraction);
    map.on("moveend", syncMinimumZoomInteraction);
    syncMinimumZoomInteraction();

    mapRef.current = map;

    return () => {
      containerRef.current?.removeEventListener("wheel", preventZoomPastMinimum);
      map.off("zoomend", syncMinimumZoomInteraction);
      map.off("moveend", syncMinimumZoomInteraction);
      map.remove();
      mapRef.current = null;
    };
  }, [mapWanted]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    if (tileLayerRef.current) {
      return;
    }

    // CARTO watermarks unauthenticated raster tiles. Without a key the map still works,
    // so this stays optional instead of failing the render.
    const cartoApiKey = import.meta.env.VITE_CARTO_API_KEY?.trim();
    const tileUrl = `https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png${cartoApiKey ? `?key=${encodeURIComponent(cartoApiKey)}` : ""}`;
    // IP2Location's free plan requires this sentence, worded as they publish it, somewhere
    // visible. The credit bar is where the map's other mandatory attributions already sit, so
    // the hop data gets credited next to the tiles it is drawn on.
    const attribution = [
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      '&copy; <a href="https://carto.com/attributions">CARTO</a>',
      'Submarine cables &copy; <a href="https://www.submarinecablemap.com">TeleGeography</a> (CC BY-SA 4.0)',
      'Nangman Road uses IP2Location.io <a href="https://www.ip2location.io">IP geolocation</a> web service.'
    ].join(" &middot; ");

    const tileLayer = L.tileLayer(tileUrl, {
      maxZoom: 20,
      noWrap: true,
      bounds: flatMapBounds,
      opacity: 1,
      updateWhenZooming: true,
      updateWhenIdle: false,
      updateInterval: 32,
      keepBuffer: 4,
      attribution
    }).addTo(map);

    tileLayerRef.current = tileLayer;

    return () => {
      tileLayer.remove();
      if (tileLayerRef.current === tileLayer) {
        tileLayerRef.current = null;
      }
    };
  }, [mapWanted]);

  // Declared after the map is created: an effect runs in declaration order, and this one
  // needs the map to exist on its first pass.
  // Submarine cables sit under the route as context. The packet's own path is still drawn only
  // between measured points; the cables show what it had to ride to cross an ocean.
  useEffect(() => {
    const map = mapRef.current;

    if (!map || !cables) {
      return;
    }

    let cancelled = false;
    let layer: L.GeoJSON | undefined;
    let renderer: L.Canvas | undefined;
    const pane = map.getPane("cables") ?? map.createPane("cables");
    pane.style.zIndex = "350";

    loadCableGeoJson()
      .then((collection) => {
        if (cancelled) {
          return;
        }

        // Canvas, not SVG: the cable set is tens of thousands of vertices, and that many
        // DOM paths make every pan and zoom stutter. The renderer is a path option in Leaflet.
        renderer = L.canvas({ pane: "cables" });
        layer = L.geoJSON(collection, {
          pane: "cables",
          onEachFeature: (feature, cableLayer) => {
            if (typeof feature.properties?.name === "string") {
              cableLayer.bindTooltip(feature.properties.name, { sticky: true, className: "packet-map-tooltip packet-map-tooltip--cable" });
            }
          },
          style: (feature) => ({
            renderer,
            color: typeof feature?.properties?.color === "string" ? feature.properties.color : "#7dd3fc",
            // Context, not subject: faint enough that the route stays the brightest thing.
            weight: 0.9,
            opacity: theme === "light" ? 0.22 : 0.17,
            lineCap: "round"
          })
        }).addTo(map);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      layer?.remove();
      // The canvas renderer is a map layer of its own; left behind, every toggle stacks another.
      renderer?.remove();
    };
  }, [cables, mapWanted, theme]);


  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    let cancelFit: () => void = () => {};
    let cleanupResize: () => void = () => {};
    let cancelPacket: () => void = () => {};
    layerRef.current?.remove();

    const layer = L.layerGroup().addTo(map);
    layerRef.current = layer;
    const latLngs = routeLatLngs(routePoints);
    const focusLatLngs = routePoints.map((point) => L.latLng(point.lat, point.lng));
    const shouldFitRoute = routeViewKey !== fittedRouteKeyRef.current;

    if (latLngs.length > 1) {
      const focusBounds = L.latLngBounds(focusLatLngs.length > 1 ? focusLatLngs : latLngs);
      const span = routeSpan(focusBounds);

      // The drawn line follows the legs (cable chains or great circles), not straight
      // Mercator segments between the pins.
      const parts = routeParts(
        routeLegs.flatMap((leg, index) => (index === 0 ? leg.path : leg.path.slice(1))).map(([lat, lng]) => ({ lat, lng }))
      );

      addRouteLines({ parts, legs: routeLegs, layer, theme });
      addLegTooltips({ legs: routeLegs, layer });
      cancelPacket = animatePacket({ map, layer, parts });

      if (shouldFitRoute) {
        cancelFit = scheduleRouteFit({
          bounds: focusBounds,
          fittedRouteKeyRef,
          map,
          routeSpan: span,
          routeViewKey
        });
      }

      if (containerRef.current) {
        cleanupResize = observeRouteResize(containerRef.current, map);
      }
    } else if (shouldFitRoute) {
      cancelFit = scheduleSinglePointFit({
        fittedRouteKeyRef,
        latLng: latLngs[0],
        map,
        routeViewKey
      });
    }

    addRouteMarkers(layer, routePoints, routeLegs, theme, unreachedTarget({ hops, target, reachedTarget }));

    return () => {
      cancelFit();
      cleanupResize();
      cancelPacket();
      layer.remove();
    };
  }, [mapWanted, mode, routePoints, routeLegs, routeViewKey, theme]);

  return (
    <section className="theme-route-section route-map-panel relative flex min-h-0 flex-col overflow-hidden rounded-lg border">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(94,231,255,0.09),transparent_36rem)]" />
      <div className="relative z-10 flex min-h-0 w-full flex-1 flex-col p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.22em] text-cyan-100/55">
              {mode === "traceout" ? t("map.title.traceout") : t("map.title.mtr")}
            </p>
            <h2 className="mt-1 truncate text-xl font-semibold text-white">
              {target || t("map.waitingTarget")}
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="theme-mode-toggle route-view-toggle grid grid-cols-2 rounded-full border p-1 backdrop-blur" role="group" aria-label={t("map.viewAria")}>
              {(["2d", "3d"] as const).map((next) => (
                <button
                  key={next}
                  type="button"
                  onClick={() => startTransition(() => setView(next))}
                  aria-pressed={view === next}
                  className={["theme-mode-button rounded-full px-3 text-xs font-semibold transition", view === next ? "theme-mode-button-active" : ""].join(" ")}
                >
                  {next === "2d" ? "2D" : "3D"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setCables((current) => !current)}
              aria-pressed={cables}
              className={["route-layer-toggle inline-flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs font-semibold transition", cables ? "route-layer-toggle-active" : ""].join(" ")}
            >
              <Cable className="h-3.5 w-3.5" aria-hidden="true" />
              {t("map.cables")}
            </button>
            <div className="theme-mode-toggle route-view-toggle route-path-toggle grid grid-cols-2 rounded-full border p-1 backdrop-blur" role="group" aria-label={t("map.drawingAria")}>
              {(["cable", "direct"] as const).map((next) => (
                <button
                  key={next}
                  type="button"
                  onClick={() => setPathMode(next)}
                  aria-pressed={pathMode === next}
                  className={["theme-mode-button rounded-full px-3 text-xs font-semibold transition", pathMode === next ? "theme-mode-button-active" : ""].join(" ")}
                >
                  {next === "cable" ? t("map.pathCable") : t("map.pathDirect")}
                </button>
              ))}
            </div>
            <div className="route-source-badge inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
              <RadioTower className="h-4 w-4 text-signal-cyan" aria-hidden="true" />
              {sourceBadge}
            </div>
          </div>
        </div>

          <div className="theme-map-shell route-map-viewport relative overflow-hidden rounded-lg border">
            {/* Under the globe the flat map is kept, not shown: hidden, its tiles, glowing
                lines and moving packet cost the browser nothing while the globe draws. */}
            <div
              ref={containerRef}
              className="packet-map-canvas h-full w-full"
              style={view === "3d" ? { visibility: "hidden" } : undefined}
              aria-label={t("map.title.traceout")}
            />
            <div className="theme-map-vignette pointer-events-none absolute inset-0" />
            {/* Mounted once and kept through view switches: taking the globe's canvas out
                of the page and putting it back cost a second or two of stall each time. */}
            <Suspense fallback={view === "3d" ? <div className="globe-shell globe-loading">{t("map.loadingGlobe")}</div> : null}>
              <GlobeView points={globePointsWithSpeed} legs={routeLegs} theme={theme} cables={cables} shown={view === "3d"} />
            </Suspense>

            {hops.length > 0 ? (
              <aside className={["route-hud", hudOpen ? "" : "route-hud--collapsed"].join(" ")} aria-label={t("hud.aria")}>
                <button type="button" className="route-hud__toggle" aria-expanded={hudOpen} onClick={() => setHudOpen((open) => !open)}>
                  {hudOpen ? t("hud.hide") : t("hud.details")}
                </button>
                <p className="route-hud__note">{routeNote(hops, mode, reachedTarget, hasInferredLegs)}</p>
                <div className="route-legend route-hud__legend">
                  <span className="route-legend__item route-legend__scale">
                    <span className="route-legend__scale-title">{t("hud.latency")}</span>
                    <span>{t("hud.slow")}</span>
                    <span className="route-legend__bar" style={{ background: speedGradient(theme) }} aria-hidden="true" />
                    <span>{t("hud.fast")}</span>
                    <span className="route-legend__swatch-item">
                      <span className="route-legend__swatch" style={{ background: NO_SPEED[theme] }} aria-hidden="true" />
                      {t("hud.notMeasurable")}
                    </span>
                  </span>
                </div>
                {summary.distanceKm > 0 ? (
                  <div className="route-summary route-hud__summary">
                    <span>
                      <span className="route-summary-label">{t("hud.straight")}</span> {summary.distanceKm.toLocaleString()} km
                    </span>
                    {summary.pathKm > summary.distanceKm ? (
                      <span>
                        <span className="route-summary-label">{t("hud.drawn")}</span> {summary.pathKm.toLocaleString()} km
                      </span>
                    ) : null}
                    {summary.seaKm > 0 ? (
                      <span>
                        <span className="route-summary-label">{t("hud.undersea")}</span> {summary.seaKm.toLocaleString()} km
                      </span>
                    ) : null}
                    {summary.seaKm > 0 ? (
                      <span>
                        <span className="route-summary-label">{t("hud.overland")}</span> {summary.landKm.toLocaleString()} km
                      </span>
                    ) : null}
                    {summary.unresolvedKm > 0 ? (
                      <span>
                        <span className="route-summary-label">{t("hud.unresolved")}</span> {summary.unresolvedKm.toLocaleString()} km
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </aside>
            ) : null}

          {hops.length === 0 && error ? (
            <div className="pointer-events-none absolute inset-0 z-[1020] flex items-center justify-center bg-[rgba(5,8,18,0.55)] p-6 text-center backdrop-blur-sm">
              <div className="theme-empty-card max-w-sm rounded-lg border p-5 backdrop-blur">
                <SearchX className="mx-auto mb-4 h-10 w-10 text-signal-amber" aria-hidden="true" />
                <p className="text-lg font-semibold text-white">{t("map.noRoute")}</p>
                <p className="mt-2 text-sm leading-6 text-cyan-50/60">{error}</p>
              </div>
            </div>
          ) : null}

          {hops.length === 0 && !error ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
              <div className="theme-empty-card max-w-sm rounded-lg border p-5 backdrop-blur">
                <RadioTower className="mx-auto mb-4 h-10 w-10 text-signal-cyan" aria-hidden="true" />
                <p className="text-lg font-semibold text-white">{t("map.notReady")}</p>
                <p className="mt-2 text-sm leading-6 text-cyan-50/60">{t("map.notReadyDetail")}</p>
              </div>
            </div>
          ) : null}
        </div>

        {hops.length === 0 ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-cyan-50/65">
            <Activity className="h-4 w-4 text-signal-cyan" aria-hidden="true" />
            <span>{error ?? t("map.waitingData")}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
