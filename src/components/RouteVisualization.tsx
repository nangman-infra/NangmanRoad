import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import L from "leaflet";
import { Activity, RadioTower } from "lucide-react";
import type { HopResult, MeasurementSource, MeasurementStatus, TraceMode } from "../../shared/types";

interface RouteVisualizationProps {
  mode: TraceMode;
  status: MeasurementStatus;
  target: string;
  hops: HopResult[];
  source?: MeasurementSource;
  theme: "light" | "dark";
}

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

function markerColor(status: GeoPoint["status"]) {
  if (status === "loss" || status === "timeout") {
    return "#ff756c";
  }

  if (status === "slow") {
    return "#f6c65b";
  }

  if (status === "target") {
    return "#8f88ff";
  }

  return "#5ee7ff";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function formatHopCount(count?: number) {
  if (!count || count <= 0) {
    return "route point";
  }

  return `${count} hop${count > 1 ? "s" : ""}`;
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

  return `${hopNumbers.length > 1 ? "Mapped hops" : "Mapped hop"} ${ranges.join(", ")}`;
}

function formatMetricLabel(hop?: HopResult) {
  if (!hop) {
    return undefined;
  }

  const metrics = [
    typeof hop.rttMs === "number" ? `${Math.round(hop.rttMs)} ms avg` : undefined,
    typeof hop.packetLossPercent === "number" && hop.packetLossPercent > 0
      ? `${hop.packetLossPercent.toFixed(hop.packetLossPercent % 1 === 0 ? 0 : 1)}% loss`
      : undefined,
    hop.status !== "ok" ? hop.status : undefined
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

  if (normalized === "gb" || normalized.includes("united kingdom")) {
    return "UK";
  }

  if (normalized === "hong kong") {
    return "Hong Kong";
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
  return [source?.city, formatCountryLabel(source?.country)].filter(Boolean).join(", ") || "Nearby probe";
}

function formatEndpointTooltipLabel(place: RoutePlace) {
  if (!place.country || place.country === "Probe" || place.country === "Target") {
    return place.city;
  }

  return [place.city, place.country].filter(Boolean).join(" ");
}

function formatTransitLocationLabel(place?: RoutePlace) {
  if (!place) {
    return "Estimated network region";
  }

  const city = place.city?.trim();
  const country = place.country?.trim();

  if (city && country && city.toLowerCase() !== country.toLowerCase() && country.toLowerCase() !== "unknown") {
    return `${city}, ${country}`;
  }

  return city || country || "Estimated network region";
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
        name: "Private network",
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
    cityLabel || "Network region",
    country,
    uniquePlaces.reduce((sum, place) => sum + place.lat, 0) / uniquePlaces.length,
    uniquePlaces.reduce((sum, place) => sum + place.lng, 0) / uniquePlaces.length
  );
}

function sourcePlace(source?: MeasurementSource): RoutePlace {
  const location = sourceLocation(source);

  return makePlace(
    source?.city || "Nearby probe",
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
    const previous = groups[groups.length - 1];
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
    const existing = mergedGroups[mergedGroups.length - 1];

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
    return fallbackName || "Unknown network";
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

    const existingIndex = merged.findIndex((candidate) => candidate.role === "transit" && sameDisplayPoint(candidate, point));

    if (existingIndex === -1) {
      merged.push(point);
      return;
    }

    merged[existingIndex] = mergeTransitPoint(merged[existingIndex], point);
  });

  return merged;
}

function targetGeoHopFromHops(hops: HopResult[]) {
  return [...hops].reverse().find((hop) => placeFromCountryHop(hop));
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

function buildRoutePoints(params: {
  hops: HopResult[];
  target: string;
  source?: MeasurementSource;
}): GeoPoint[] {
  const start = sourcePlace(params.source);
  const end = targetPlaceFromHops(params.target, params.hops);
  const points: GeoPoint[] = [
    {
      ...start,
      label: formatEndpointTooltipLabel(start),
      role: "source",
      city: start.city,
      country: start.country,
      status: "source"
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
    const hop = group?.hops[group.hops.length - 1] ?? params.hops[Math.min(index, params.hops.length - 1)];
    const hopCount = group?.hops.length ?? 1;
    const asn = group?.asn ?? hop?.asn ?? "AS???";
    const metadata = asMetadata(asn);
    const asName = group?.asName ?? metadata?.name;
    const place = group?.place;
    const lat = place?.lat ?? start.lat;
    const lng = place?.lng ?? start.lng;
    const locationLabel = formatTransitLocationLabel(place);
    const asnLabel = group ? formatGroupAsnLabel(group, asn) : asn;
    const networkName = group ? formatGroupNetworkLabel(group, asName) : asName || "Unknown network";
    const hopNumberLabel = formatHopNumberLabel(group?.hops ?? (hop ? [hop] : []));
    const groupedHopCountLabel = hopCount > 1 ? formatHopCount(hopCount) : undefined;
    const metricLabel = formatMetricLabel(hop);

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
      status: group?.status ?? hop.status
    });
  });

  if (params.hops.length > 0 && end) {
    points.push({
      ...end,
      label: params.target,
      role: "target",
      city: end.city,
      country: end.country,
      status: "target"
    });
  }

  return mergeRepeatedDisplayPoints(points).map((point, index) => ({
    ...point,
    sequence: index + 1
  }));
}

function markerIcon(point: GeoPoint) {
  const color = markerColor(point.status);
  const visualSize = point.role === "transit" ? 30 : 72;
  const hitSize = point.role === "transit" ? 30 : 24;
  const anchorX = hitSize / 2;
  const anchorY = hitSize / 2;
  const label = point.role === "source" ? "SRC" : point.role === "target" ? "DST" : "";
  const towerIcon =
    point.role === "transit"
      ? `<svg class="packet-map-marker__tower" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="8.8" r="1.35" />
          <path d="M12 10.2V20" />
          <path d="M8.2 20H15.8" />
          <path d="M8.9 17.1L12 10.8L15.1 17.1" />
          <path d="M7.9 12.5C7.2 11.4 6.9 10.2 6.9 8.8C6.9 7.5 7.2 6.3 7.9 5.2" />
          <path d="M16.1 12.5C16.8 11.4 17.1 10.2 17.1 8.8C17.1 7.5 16.8 6.3 16.1 5.2" />
          <path d="M5.2 14.2C4.2 12.5 3.7 10.7 3.7 8.8C3.7 6.9 4.2 5.1 5.2 3.5" />
          <path d="M18.8 14.2C19.8 12.5 20.3 10.7 20.3 8.8C20.3 6.9 19.8 5.1 18.8 3.5" />
        </svg>`
      : "";

  return L.divIcon({
    className: `packet-map-marker-wrapper packet-map-marker-wrapper--${point.role}`,
    iconSize: [hitSize, hitSize],
    iconAnchor: [anchorX, anchorY],
    html: `
        <span class="packet-map-marker packet-map-marker--${point.role}" style="--marker-color:${color};--marker-visual-size:${visualSize}px">
          <span class="packet-map-marker__halo"></span>
          <span class="packet-map-marker__ring"></span>
          <span class="packet-map-marker__dot"></span>
          ${towerIcon}
          ${label ? `<span class="packet-map-marker__label">${label}</span>` : ""}
        </span>
    `
  });
}

function routeLatLngs(points: GeoPoint[]) {
  return points.map((point) => L.latLng(point.lat, point.lng));
}

function routeColors(theme: RouteVisualizationProps["theme"]) {
  return {
    casing: theme === "light" ? "#fbfdff" : "#d5f8ff",
    glow: theme === "light" ? "#dff7fc" : "#d4f8ff",
    line: theme === "light" ? "#68c8e2" : "#aeeaf5"
  };
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
  let fitTimeout = 0;
  const fitFrame = window.requestAnimationFrame(() => {
    fitRouteToBounds({ ...params, animate: true, markFitted: true });
    fitTimeout = window.setTimeout(() => {
      fitRouteToBounds({ ...params, animate: true, markFitted: true });
    }, 180);
  });

  return () => {
    window.cancelAnimationFrame(fitFrame);
    window.clearTimeout(fitTimeout);
  };
}

function scheduleSinglePointFit(params: {
  fittedRouteKeyRef: MutableRefObject<string>;
  latLng?: L.LatLng;
  map: L.Map;
  routeViewKey: string;
}) {
  const frame = window.requestAnimationFrame(() => {
    params.map.invalidateSize({ animate: false, pan: false });
    params.map.setView(params.latLng ?? L.latLng(24, 20), 3, { animate: true });
    params.fittedRouteKeyRef.current = params.routeViewKey;
  });

  return () => window.cancelAnimationFrame(frame);
}

function addRouteLines(params: {
  latLngs: L.LatLng[];
  layer: L.LayerGroup;
  theme: RouteVisualizationProps["theme"];
}) {
  const colors = routeColors(params.theme);

  L.polyline(params.latLngs, {
    color: colors.casing,
    weight: params.theme === "light" ? 3.2 : 2.8,
    opacity: params.theme === "light" ? 0.46 : 0.14,
    smoothFactor: 2,
    className: "packet-map-route-casing"
  }).addTo(params.layer);

  L.polyline(params.latLngs, {
    color: colors.glow,
    weight: params.theme === "light" ? 2.2 : 2,
    opacity: params.theme === "light" ? 0.08 : 0.1,
    smoothFactor: 2,
    className: "packet-map-route-shadow"
  }).addTo(params.layer);

  L.polyline(params.latLngs, {
    color: colors.line,
    weight: params.theme === "light" ? 1.55 : 1.5,
    opacity: params.theme === "light" ? 0.72 : 0.64,
    smoothFactor: 2,
    className: "packet-map-route"
  }).addTo(params.layer);
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
  let resizeTimeout = 0;
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
    window.clearTimeout(resizeTimeout);
    resizeTimeout = window.setTimeout(() => {
      map.invalidateSize({ animate: false, pan: false });
    }, 140);
  });

  resizeObserver.observe(container);

  return () => {
    window.clearTimeout(resizeTimeout);
    resizeObserver.disconnect();
  };
}

function tooltipHtml(point: GeoPoint) {
  const meta = point.subLabel ? `<div class="packet-map-tooltip__meta">${escapeHtml(point.subLabel)}</div>` : "";

  return `<div class="packet-map-tooltip__title">${escapeHtml(point.label)}</div>
         ${meta}
        `;
}

function addRouteMarkers(layer: L.LayerGroup, routePoints: GeoPoint[]) {
  routePoints.forEach((point) => {
    const marker = L.marker([point.lat, point.lng], {
      icon: markerIcon(point),
      keyboard: false,
      zIndexOffset: point.role === "target" ? 900 : point.role === "source" ? 800 : 100 + (point.sequence ?? 0)
    }).addTo(layer);

    marker.bindTooltip(tooltipHtml(point), {
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

export function RouteVisualization({ mode, status, target, hops, source, theme }: RouteVisualizationProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const fittedRouteKeyRef = useRef("");
  const routePoints = useMemo(
    () => displayRouteLongitudes(buildRoutePoints({ hops, target, source })),
    [hops, source, target]
  );
  const routeViewKey = useMemo(
    () =>
      routePoints
        .map((point) => `${point.role}:${point.lat.toFixed(4)},${point.lng.toFixed(4)}:${point.label}`)
        .join("|"),
    [routePoints]
  );
  const sourceLabel = formatSourceLabel(source);
  const sourceBadge = sourceLabel === "Nearby probe" ? "Measured from nearby network probe" : `Measured from ${sourceLabel} probe`;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
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

    L.control.zoom({ position: "bottomleft" }).addTo(map);
    L.control.attribution({ position: "bottomright", prefix: false }).addTo(map);

    let isApplyingMinimumView = false;

    const applyMinimumView = () => {
      if (isApplyingMinimumView) {
        return;
      }

      isApplyingMinimumView = true;
      map.setView(FLAT_MAP_CENTER, map.getMinZoom(), { animate: false });
      map.stop();

      window.setTimeout(() => {
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
  }, []);

  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    if (tileLayerRef.current) {
      return;
    }

    const tileUrl = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
    const attribution =
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

    const tileLayer = L.tileLayer(tileUrl, {
      subdomains: "abcd",
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
  }, []);

  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    let cancelFit: () => void = () => {};
    let cleanupResize: () => void = () => {};
    layerRef.current?.remove();

    const layer = L.layerGroup().addTo(map);
    layerRef.current = layer;
    const latLngs = routeLatLngs(routePoints);
    const focusLatLngs = routePoints.map((point) => L.latLng(point.lat, point.lng));
    const shouldFitRoute = routeViewKey !== fittedRouteKeyRef.current;

    if (latLngs.length > 1) {
      const focusBounds = L.latLngBounds(focusLatLngs.length > 1 ? focusLatLngs : latLngs);
      const span = routeSpan(focusBounds);

      addRouteLines({ latLngs, layer, theme });

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

    addRouteMarkers(layer, routePoints);

    return () => {
      cancelFit();
      cleanupResize();
      layer.remove();
    };
  }, [mode, routePoints, routeViewKey, theme]);

  return (
    <section className="theme-route-section route-map-panel relative flex min-h-0 flex-col overflow-hidden rounded-lg border backdrop-blur">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(94,231,255,0.09),transparent_36rem)]" />
      <div className="relative z-10 flex min-h-0 w-full flex-1 flex-col p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.22em] text-cyan-100/55">
              {mode === "traceout" ? "Live route map" : "MTR route map"}
            </p>
            <h2 className="mt-1 truncate text-xl font-semibold text-white">
              {target || "Waiting for a target"}
            </h2>
          </div>
          <div className="route-source-badge inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
            <RadioTower className="h-4 w-4 text-signal-cyan" aria-hidden="true" />
            {sourceBadge}
          </div>
        </div>

          <div className="theme-map-shell route-map-viewport relative overflow-hidden rounded-lg border">
            <div ref={containerRef} className="packet-map-canvas h-full w-full" aria-label="Live route map" />
            <div className="theme-map-vignette pointer-events-none absolute inset-0" />

          {hops.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
              <div className="theme-empty-card max-w-sm rounded-lg border p-5 backdrop-blur">
                <RadioTower className="mx-auto mb-4 h-10 w-10 text-signal-cyan" aria-hidden="true" />
                <p className="text-lg font-semibold text-white">Route data is not ready.</p>
                <p className="mt-2 text-sm leading-6 text-cyan-50/60">
                  Exact device-level traceroute requires a local agent. This install-free view uses nearby probes.
                </p>
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex items-center gap-2 text-sm text-cyan-50/65">
          <Activity className="h-4 w-4 text-signal-cyan" aria-hidden="true" />
          <span>
            {hops.length > 0
              ? `${hops.length} hops received. Map shows only reliable city or metro points; same-place hops are merged, and uncertain hops stay in terminal output.`
              : "Waiting for route data"}
          </span>
        </div>
      </div>
    </section>
  );
}
