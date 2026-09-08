import Globe, { type GlobeInstance } from "globe.gl";
import { AdditiveBlending, BufferGeometry, CanvasTexture, Color, Float32BufferAttribute, Mesh, MeshBasicMaterial, NormalBlending, type PerspectiveCamera, PlaneGeometry, Points, ShaderMaterial, Vector3 } from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { useEffect, useRef, useState } from "react";
import { haversineKm, type LatLng, type LegEvidence } from "../lib/cableRouting";
import { currentLanguage, t as translateNow, useLang } from "../lib/i18n";
import { LABEL_ALTITUDE, RING_ALTITUDE, SURFACE_ALTITUDE, cableGeometry, cityGeometry, typefaceText, type LightGeometry } from "../lib/globeGeometry";
import { ENDPOINT_INK, lighten, speedColor } from "../lib/latency";
import { legLabel } from "../lib/legLabel";
import { loadMapData } from "../lib/mapData";

export interface GlobePoint {
  lat: number;
  lng: number;
  label: string;
  // A landing station is where an inferred cable chain comes ashore: named, not measured.
  // An unreached target is a name on the last router that answered, and no point of its own.
  // A waypoint is the city a sea stretch passes off, read from the map alone.
  role: "source" | "transit" | "target" | "landing" | "unreached" | "waypoint";
  // The city a hop was placed in, when it was placed in one.
  city?: string;
  // Where the name sits against its dot, chosen so names near each other do not overlap.
  orientation?: LabelOrientation;
  // The marker's full caption and metrics, shown on hover.
  title?: string;
  meta?: string;
  // Round-trip time measured at this point, when a hop here answered.
  rttMs?: number;
  // Speed of the leg that arrives here, km/s; colours the ring.
  kmps?: number;
  // The networks answering here, as the traceroute names them.
  operators?: string[];
}

// One drawn stretch between two measured hops. A routed leg is cut wherever it leaves the
// sea for the land or the other way round, so each stretch says what it is.
export interface GlobeLeg {
  path: LatLng[];
  // Index of the route point this stretch leads to; the stretches of one hop leg share it.
  hop: number;
  // Along submarine cables, overland between a landing and a hop, or a straight line.
  kind: "sea" | "land" | "direct";
  // True when the stretch was inferred (a cable chain and its overland ends), not measured.
  inferred: boolean;
  // The cable systems a sea stretch rides, in order.
  cables?: string[];
  // The landing stations at the stretch's ends, where known.
  from?: string;
  to?: string;
  // Every named landing station the stretch runs through, ends included.
  via?: Array<{ name: string; at: LatLng }>;
  // A straight line that has to cross water, drawn so because no cable chain was found.
  crossing?: boolean;
  // Why the leg was decided the way it was.
  evidence?: LegEvidence[];
  // How fast the packet crossed the hop leg, km/s; colours every stretch of it.
  kmps?: number;
}

type Theme = "light" | "dark";
type LabelOrientation = "bottom" | "top" | "right";

type GlobeViewProps = Readonly<{
  points: GlobePoint[];
  legs: GlobeLeg[];
  theme: Theme;
  cables: boolean;
  // False while the flat map is in front: the globe keeps its place and its size, draws
  // nothing, and comes back without being rebuilt.
  shown: boolean;
}>;

type PathKind = "aura" | "rim" | "glow" | "route";

interface GlobePath {
  kind: PathKind;
  name?: string;
  meta?: string;
  why?: string;
  speed?: string;
  kmps?: number;
  // Dash and gap as a share of the line, and the time one pass along it takes.
  dash: { length: number; gap: number; animateMs: number };
  // [lat, lng, altitude] - the altitude keeps route lines above cables and borders.
  points: Array<[number, number, number]>;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);

const tip = (title: string, meta?: string, why?: string, speed?: string) =>
  `<div class="globe-tip"><div class="globe-tip__title">${escapeHtml(title)}</div>${meta ? `<div class="globe-tip__meta">${escapeHtml(meta)}</div>` : ""}${why ? `<div class="globe-tip__why">${escapeHtml(why)}</div>` : ""}${speed ? `<div class="globe-tip__speed">${escapeHtml(speed)}</div>` : ""}</div>`;

// The route, the hop rings, the names and the cables all sit at SURFACE_ALTITUDE, so none
// of them can slide away from another, or from the coast under them, as the globe turns.
const ROUTE_ALTITUDE = SURFACE_ALTITUDE;
// The globe opens over the probe at this height, and that is as far out as it goes.
const MAX_ALTITUDE = 1.3;
// Screen-space cable width, so the cables keep their weight at any zoom. The cables are
// context on both maps: faint, under the route.
const CABLE_WIDTH_PX = 1.05;
// The route is screen-space lines, widths in px: a wide faint aura that stays solid, and
// over it the packets - the body of the line and a thin white-hot core, both dashed,
// their dashes streaming from the probe to the far end the way the first version's did.
// By day a dark rim under each dash gives it an edge on the pale map; by night the rim
// is invisible and the aura and the body glow additively instead.
const STROKE: Record<PathKind, number> = { aura: 9, rim: 5, glow: 3.4, route: 1.2 };
// Drawn after everything else that is see-through. The lines write no depth, so a land
// cap drawn later would paint straight over them - the route used to dip under continents.
const ROUTE_RENDER_ORDER = 10;

const PALETTE = {
  dark: {
    globe: "#0b1729",
    land: "rgba(30, 47, 78, 0.97)",
    border: "rgba(168, 218, 255, 0.5)",
    atmosphere: "#6cc8ff",
    glow: "rgba(94, 231, 255, 0.16)",
    // Context, not subject: faint enough that the route and the lights stay in front.
    cableOpacity: 0.24,
    label: "rgba(224, 246, 255, 0.9)",
    landing: "rgba(188, 214, 236, 0.62)",
    waypoint: "rgba(170, 196, 220, 0.46)"
  },
  light: {
    globe: "#dbe9f4",
    land: "rgba(255, 255, 255, 0.97)",
    border: "rgba(14, 165, 233, 0.42)",
    atmosphere: "#7dd3fc",
    glow: "rgba(14, 165, 233, 0.18)",
    cableOpacity: 0.34,
    label: "rgba(15, 23, 42, 0.88)",
    landing: "rgba(51, 65, 85, 0.66)",
    waypoint: "rgba(71, 85, 105, 0.5)"
  }
} as const;

// Shaped once per page for the globe; the fetch itself is shared with the map and router.
let countriesPromise: Promise<object[]> | undefined;

function loadCountries() {
  countriesPromise ??= loadMapData<{ features: object[] }>("countries").then((collection) => collection.features);

  return countriesPromise;
}

// The cities, with their names, for saying which one a sea stretch passes off.
interface NamedCity {
  n: string;
  lat: number;
  lng: number;
  // Thousands of people.
  pop: number;
}

let citiesPromise: Promise<NamedCity[]> | undefined;

function loadCities() {
  citiesPromise ??= loadMapData<{ cities: NamedCity[] }>("cities").then((collection) => collection.cities.filter((city) => city.n && city.pop >= WAYPOINT_MIN_POP));

  return citiesPromise;
}

// Antarctica's ring wraps the pole, and its cap, triangulated flat, breaks into holes; it
// keeps its coastline and goes without a cap.
const isAntarctica = (feature: object) => (feature as { properties?: { continent?: string } }).properties?.continent === "Antarctica";

// Twinkling points of light - city lights on the surface, stars on a far sphere - as one
// GPU point cloud each. Every point has its own phase, so they never blink in step, and
// the size follows the camera distance so a city stays a pinprick, not a blob, up close.
const TWINKLE_VERTEX = `
attribute float phase;
attribute float size;
uniform float time;
uniform float pixelRatio;
uniform float wave;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float weight = clamp(size / 7.0, 0.0, 1.0);
  float depth = wave * (0.55 + 0.45 * weight);
  float tw = 1.0 - depth * 0.5 * (1.0 + sin(time * (0.7 + phase * 0.9) + phase * 6.28318));
  vAlpha = tw * (0.72 + 0.28 * weight);
  // Grows as the camera comes closer, but only so far: up close a city stays a point of
  // light, not a blob the size of a province.
  float px = size * pixelRatio * (0.85 + 0.3 * tw) * (320.0 / -mv.z);
  gl_PointSize = min(px, size * pixelRatio * 2.0);
  gl_Position = projectionMatrix * mv;
}`;

const TWINKLE_FRAGMENT = `
uniform vec3 color;
uniform float strength;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  if (d > 0.5) discard;
  float glow = smoothstep(0.5, 0.0, d);
  float hot = smoothstep(0.24, 0.0, d);
  gl_FragColor = vec4(color, (glow * glow * 0.7 + hot * 0.75) * vAlpha * strength);
}`;

const REDUCED_MOTION = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

// A seeded sequence for the twinkle phases and the star field: the same sky every time
// the globe opens, and nothing secret rides on it.
function seededRandom(seed: number) {
  let state = seed;

  return () => {
    state = (state * 16807) % 2147483647;

    return state / 2147483647;
  };
}

function twinklePoints(buffers: LightGeometry, options: { color: string; wave: number; strength: number }) {
  const geometry = new BufferGeometry();
  const random = seededRandom(11);
  geometry.setAttribute("position", new Float32BufferAttribute(buffers.positions, 3));
  geometry.setAttribute("size", new Float32BufferAttribute(buffers.sizes, 1));
  geometry.setAttribute("phase", new Float32BufferAttribute(Float32Array.from({ length: buffers.sizes.length }, () => random()), 1));

  const material = new ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      pixelRatio: { value: Math.min(2, globalThis.devicePixelRatio || 1) },
      wave: { value: REDUCED_MOTION ? 0 : options.wave },
      strength: { value: options.strength },
      color: { value: new Color(options.color) }
    },
    vertexShader: TWINKLE_VERTEX,
    fragmentShader: TWINKLE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending
  });

  const points = new Points(geometry, material);
  points.raycast = () => {};

  return points;
}

// Stars live in the scene, not on a backdrop, so they wheel past as the globe turns or is
// dragged. Seeded, so the sky is the same every time the globe opens.
function starField(radius: number) {
  const random = seededRandom(7);
  const positions: number[] = [];
  const sizes: number[] = [];

  for (let index = 0; index < 1900; index += 1) {
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    const bright = random() < 0.14;

    positions.push(radius * Math.sin(phi) * Math.cos(theta), radius * Math.sin(phi) * Math.sin(theta), radius * Math.cos(phi));
    sizes.push((bright ? 12 : 6) + random() * 5);
  }

  return twinklePoints({ positions: new Float32Array(positions), sizes: new Float32Array(sizes) }, { color: "#eef4ff", wave: 0.3, strength: 1 });
}

// City lights the way the night side looks from orbit: a warm-white point per city, sized
// by population, and a soft amber halo on the million-plus ones. Additive, so clusters
// glow. Drawn after the land caps whatever the sort order: the lights never write depth,
// so a cap painted later would cover them and they would seem to shine from underground.
function cityLights(buffers: { core: LightGeometry; halo: LightGeometry }) {
  const cities = twinklePoints(buffers.core, { color: "#fff3dc", wave: 0.35, strength: 0.9 });
  const halo = twinklePoints(buffers.halo, { color: "#ffb75a", wave: 0.25, strength: 0.22 });
  halo.renderOrder = 2;
  cities.renderOrder = 3;

  return { cities, halo };
}

// Every cable as one line object: one draw call for the whole set, and nothing for the
// pointer to test against. Thousands of tube meshes were what made the globe stutter.
function cableLines(buffers: { positions: Float32Array; colors: Float32Array }, opacity: number) {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(buffers.positions);
  geometry.setColors(buffers.colors);

  const material = new LineMaterial({ vertexColors: true, linewidth: CABLE_WIDTH_PX, transparent: true, opacity, depthWrite: false });
  const lines = new LineSegments2(geometry, material);
  lines.raycast = () => {};

  return lines;
}



// The route the way it was first drawn: a soft glow under a thin core whose dashes stream
// from the probe to the far end - the packets - all in the colour of the leg's speed, so a
// fast leg burns green and a slow one red. Hovering a leg names it.
// A cable chain has a vertex every degree or so and a corridor one every few kilometres;
// for a glowing line a vertex every half degree keeps their shape and costs a fraction.
// Ends always kept, but never twice: a zero-length segment gives a fat line no direction
// to lay its width along.
const PATH_SPACING_DEGREES = 0.4;

function thinned(path: LatLng[]): LatLng[] {
  const kept: LatLng[] = [];

  path.forEach((point, index) => {
    const last = kept.at(-1);
    const apart = last ? Math.hypot(point[0] - last[0], point[1] - last[1]) : Infinity;

    if (apart === 0) return;

    if (index === 0 || index === path.length - 1 || apart >= PATH_SPACING_DEGREES) {
      kept.push(point);
    }
  });

  return kept;
}

// The packets tell land from sea at a glance: overland they run as fine, close dots,
// at sea as long dashes - the same sizes on every stretch, whatever its length, since
// three-globe measures dashes as a share of the line. Each pattern moves one step per
// cycle, so a short stretch does not flicker and a long one does not crawl.
// One step of the pattern a second or so: a stream, not a strobe (a tenth of that was
// tried and read as flicker).
const DASH_KM = {
  land: { dash: 45, gap: 45, cycleMs: 900 },
  sea: { dash: 260, gap: 170, cycleMs: 1700 }
} as const;
const SOLID_DASH = { length: 1, gap: 0.0001, animateMs: 0 };

const pathKm = (path: LatLng[]) => path.reduce((sum, point, index) => (index === 0 ? 0 : sum + haversineKm(path[index - 1], point)), 0);

function dashFor(leg: GlobeLeg, km: number) {
  const pattern = leg.kind === "sea" || (leg.kind === "direct" && leg.crossing) ? DASH_KM.sea : DASH_KM.land;
  const period = pattern.dash + pattern.gap;

  // Shorter than one pattern: a single dash is the whole stretch.
  if (km < period) return SOLID_DASH;

  return { length: pattern.dash / km, gap: pattern.gap / km, animateMs: (km / period) * pattern.cycleMs };
}

function routePaths(legs: GlobeLeg[]): GlobePath[] {
  return legs.flatMap((leg) => {
    const { title, meta, why, speed } = legLabel(leg);
    const path = thinned(leg.path);
    const points = path.map(([lat, lng]) => [lat, lng, ROUTE_ALTITUDE] as [number, number, number]);
    const dash = dashFor(leg, pathKm(path));

    return [
      { kind: "aura" as const, name: title, meta, why, speed, kmps: leg.kmps, points, dash: SOLID_DASH },
      { kind: "rim" as const, name: title, meta, why, speed, kmps: leg.kmps, points, dash },
      { kind: "glow" as const, name: title, meta, why, speed, kmps: leg.kmps, points, dash },
      { kind: "route" as const, name: title, meta, why, speed, kmps: leg.kmps, points, dash }
    ];
  });
}

// The stations an inferred chain touches, as points to name: where every sea stretch
// begins and ends, and every station it runs through on the way, each station once.
function landingPoints(legs: GlobeLeg[]): GlobePoint[] {
  const stations = new Map<string, GlobePoint>();

  for (const leg of legs) {
    // Where the chain hands from one system to the next it does so at a station in the
    // middle of the run, and where a cable's own line crosses land the run is cut there,
    // so a stretch drawn as land can still touch one. Both carry a name worth writing.
    const ends: Array<[string | undefined, LatLng | undefined]> = leg.kind === "sea" ? [[leg.from, leg.path[0]], [leg.to, leg.path.at(-1)]] : [];
    const passed: Array<[string | undefined, LatLng | undefined]> = (leg.via ?? []).map((station) => [station.name, station.at]);

    for (const [name, point] of [...ends, ...passed]) {
      if (!name || !point || stations.has(name)) continue;

      stations.set(name, {
        lat: point[0],
        lng: point[1],
        role: "landing",
        label: name.split(",")[0].trim(),
        title: translateNow("point.landing"),
        meta: translateNow("point.landingMeta", { name, cables: leg.cables?.join(" → ") ?? "" })
      });
    }
  }

  return [...stations.values()];
}

// Which city a sea stretch passes off - read from the map, never from a measurement, and
// said so on hover. Only cities of half a million or more, within an hour's drive of the
// line, one every few hundred kilometres, and never on top of a hop or a station.
const WAYPOINT_MIN_POP = 500;
const WAYPOINT_REACH_KM = 60;
const WAYPOINT_SPACING_KM = 350;
const WAYPOINT_CLEAR_KM = 120;
const WAYPOINT_STEP_KM = 40;
const CITY_CELL_DEGREES = 1;

function cityIndex(cities: NamedCity[]) {
  const cells = new Map<string, NamedCity[]>();

  for (const city of cities) {
    const key = `${Math.floor(city.lat / CITY_CELL_DEGREES)},${Math.floor(city.lng / CITY_CELL_DEGREES)}`;

    cells.set(key, [...(cells.get(key) ?? []), city]);
  }

  return (point: LatLng) => {
    const [row, column] = [Math.floor(point[0] / CITY_CELL_DEGREES), Math.floor(point[1] / CITY_CELL_DEGREES)];
    const near: NamedCity[] = [];

    for (let r = row - 1; r <= row + 1; r += 1) for (let c = column - 1; c <= column + 1; c += 1) near.push(...(cells.get(`${r},${c}`) ?? []));

    return near;
  };
}

function waypoints(legs: GlobeLeg[], cities: NamedCity[], taken: GlobePoint[]): GlobePoint[] {
  if (cities.length === 0) return [];

  const near = cityIndex(cities);
  const picked: GlobePoint[] = [];
  const clear = (city: NamedCity) => taken.every((point) => haversineKm([point.lat, point.lng], [city.lat, city.lng]) >= WAYPOINT_CLEAR_KM) && picked.every((point) => point.label !== city.n);

  for (const leg of legs) {
    if (leg.kind !== "sea") continue;

    let along = 0;
    let lastKm = Number.NEGATIVE_INFINITY;

    for (let index = 1; index < leg.path.length; index += 1) {
      const [a, b] = [leg.path[index - 1], leg.path[index]];
      const km = haversineKm(a, b);
      const steps = Math.max(1, Math.ceil(km / WAYPOINT_STEP_KM));

      for (let step = 0; step < steps; step += 1) {
        const at = along + (km * step) / steps;

        if (at - lastKm < WAYPOINT_SPACING_KM) continue;

        const point: LatLng = [a[0] + ((b[0] - a[0]) * step) / steps, a[1] + ((b[1] - a[1]) * step) / steps];
        let best: { city: NamedCity; km: number } | undefined;

        for (const city of near(point)) {
          const distance = haversineKm(point, [city.lat, city.lng]);

          if (distance <= WAYPOINT_REACH_KM && (!best || city.pop > best.city.pop) && clear(city)) best = { city, km: distance };
        }

        if (!best) continue;

        picked.push({
          lat: best.city.lat,
          lng: best.city.lng,
          role: "waypoint",
          label: best.city.n,
          title: translateNow("point.waypoint", { name: best.city.n }),
          meta: translateNow("point.waypointMeta", { name: best.city.n, km: Math.max(1, Math.round(best.km)) })
        });
        lastKm = at;
      }

      along += km;
    }
  }

  return picked;
}

// The mark at each end of the route is a plain dot in the page's black and white, like every
// hop; what sets it apart is the light around it. A bright thing seen through a lens does not
// end at its edge - it blooms, cold and close in, with a faint warm rim further out where the
// glass bends the long wavelengths hardest. That is what this draws. The middle is left empty
// so the dot is never covered, and the globe's own ring layer cannot do it: those are
// hairlines, and no number of hairlines makes a glow.
const HALO_STOPS: Record<Theme, Array<[number, string]>> = {
  dark: [
    [0, "rgba(255,255,255,0)"],
    [0.14, "rgba(255,255,255,0)"],
    [0.21, "rgba(236,248,255,0.5)"],
    [0.35, "rgba(150,205,255,0.32)"],
    [0.55, "rgba(186,172,255,0.19)"],
    [0.75, "rgba(255,206,180,0.1)"],
    [1, "rgba(255,255,255,0)"]
  ],
  // On a pale map a glow cannot be added to the light already there, so the day halo is
  // painted over it instead, deeper and more of it, or nothing of it would show.
  light: [
    [0, "rgba(255,255,255,0)"],
    [0.14, "rgba(255,255,255,0)"],
    [0.21, "rgba(190,228,255,0.82)"],
    [0.35, "rgba(104,170,230,0.5)"],
    [0.55, "rgba(138,122,212,0.3)"],
    [0.75, "rgba(232,158,122,0.18)"],
    [1, "rgba(255,255,255,0)"]
  ]
};

const HALO_TEXTURE_PIXELS = 256;
// Wide enough to read as light around the mark, not as a second mark.
const HALO_SPAN = 9;

function haloMaterial(theme: Theme) {
  const canvas = document.createElement("canvas");

  canvas.width = HALO_TEXTURE_PIXELS;
  canvas.height = HALO_TEXTURE_PIXELS;

  const context = canvas.getContext("2d");
  const middle = HALO_TEXTURE_PIXELS / 2;

  if (context) {
    const bloom = context.createRadialGradient(middle, middle, 0, middle, middle, middle);

    for (const [stop, colour] of HALO_STOPS[theme]) bloom.addColorStop(stop, colour);

    context.fillStyle = bloom;
    context.fillRect(0, 0, HALO_TEXTURE_PIXELS, HALO_TEXTURE_PIXELS);
  }

  return new MeshBasicMaterial({
    map: new CanvasTexture(canvas),
    transparent: true,
    depthWrite: false,
    // By night the glow adds to the sky behind it; by day it is paint on a white page.
    blending: theme === "dark" ? AdditiveBlending : NormalBlending
  });
}

// The glow lies flat on the map rather than square to the eye. A card held to the eye sinks
// its far edge under the surface as soon as the globe turns - with 4.5 of half-width over
// 0.32 of clearance, four degrees is enough - and the depth test cuts the sunk half away.
// That was the tear on a turned globe. A card laid tangent to the sphere cannot sink into it
// at any angle: every point of a plane touching a sphere from outside is further from the
// centre than the point it touches. It foreshortens with the name beside it, which
// three-globe lays flat too, and it turns its back once the point rounds the far side.
// A plane faces along +Z; turning that to the point's own upright lays it on the map.
const PLANE_FACE = new Vector3(0, 0, 1);
const haloNormal = new Vector3();

// Where the route starts and where it ends are the two things a visitor looks for first,
// and until now both wore the same white dot as every hop between them - the arrival sat
// on the last hop that answered and was indistinguishable from it. So the ends get their
// own colour, and a mark half again as wide as a hop's.
const DOT_RADIUS: Record<GlobePoint["role"], number> = {
  source: 0.45,
  target: 0.45,
  transit: 0.3,
  landing: 0.14,
  waypoint: 0.1,
  // The target never answered: its name goes on the last hop that did, and an arrival mark
  // there would claim the packet got somewhere it was never seen to reach.
  unreached: 0
};

const ENDS = new Set<GlobePoint["role"]>(["source", "target"]);

// A name's footprint on the globe: about six tenths of the size per letter, one size
// tall, below its dot, above it or to its right.
const LABEL_SIZE = { hop: 0.92, landing: 0.72, waypoint: 0.64 } as const;
const NEVER_DROPPED = new Set<GlobePoint["role"]>(["source", "target", "unreached"]);

// A name is written in degrees of the globe, so on the way in it would grow with the globe
// and the same handful would fill the screen. Scaling it down as the camera comes closer
// keeps every name the same size to read, and shrinks what it covers of the map, so the
// names that had nowhere to go at arm's length appear as the view closes in.
function labelScaleFor(altitude: number) {
  // How much of the globe the camera can see, as an angle: that is what a name competes
  // for room in. It shrinks fast on the way in - a third of the world at arm's length,
  // a few degrees up close - so a name written in degrees has to shrink with it.
  const span = (height: number) => Math.acos(1 / (1 + Math.max(0.002, height)));

  return Math.max(0.05, Math.min(1, span(altitude) / span(MAX_ALTITUDE)));
}

function labelSize(point: GlobePoint, scale = 1) {
  const base = point.role === "waypoint" ? LABEL_SIZE.waypoint : point.role === "landing" ? LABEL_SIZE.landing : LABEL_SIZE.hop;

  return base * scale;
}
const ORIENTATIONS: LabelOrientation[] = ["bottom", "top", "right"];

function labelBox(point: GlobePoint, scale: number) {
  const size = labelSize(point, scale);
  const stretch = 1 / Math.max(0.2, Math.cos((point.lat * Math.PI) / 180));
  const width = (0.62 * typefaceText(point.label).length + 0.6) * size * stretch;

  switch (point.orientation ?? "bottom") {
    case "top":
      return { west: point.lng - width / 2, east: point.lng + width / 2, south: point.lat - size * 0.4, north: point.lat + size * 1.7 };
    case "right":
      return { west: point.lng - size * 0.4 * stretch, east: point.lng + width, south: point.lat - size * 0.7, north: point.lat + size * 0.9 };
    default:
      return { west: point.lng - width / 2, east: point.lng + width / 2, south: point.lat - size * 1.7, north: point.lat + size * 0.4 };
  }
}

function labelsCollide(a: GlobePoint, b: GlobePoint, scale: number) {
  const [p, q] = [labelBox(a, scale), labelBox(b, scale)];

  return p.west < q.east && q.west < p.east && p.south < q.north && q.south < p.north;
}

// Names are placed in turn, and whichever goes down first takes the side it likes. Where a
// hop sits a degree below another, the first name hangs across the second and the second has
// nowhere left to go, though moving the first one up would have left room for both - the
// target of an IONOS route covered Karlsruhe exactly so. So a name that will not fit gets
// one more chance: each name already in its way is offered its other sides, and the first
// move that clears both is taken. One step back, no further.
function makeRoom(placed: GlobePoint[], candidate: GlobePoint, scale: number) {
  const clearOf = (entry: GlobePoint, ignore: GlobePoint) =>
    placed.every((other) => other === ignore || !labelsCollide(entry, other, scale));

  for (const blocker of placed.filter((other) => labelsCollide(candidate, other, scale))) {
    for (const orientation of ORIENTATIONS.filter((side) => side !== blocker.orientation)) {
      const shifted = { ...blocker, orientation };
      const room = clearOf(shifted, blocker)
        ? ORIENTATIONS.map((side) => ({ ...candidate, orientation: side })).find(
            (option) => clearOf(option, blocker) && !labelsCollide(option, shifted, scale)
          )
        : undefined;

      if (room) {
        placed[placed.indexOf(blocker)] = shifted;

        return room;
      }
    }
  }

  return undefined;
}

// Names on the globe: the two ends always, then every hop placed in a city, then the
// landing stations. A name goes below its dot, or above it, or to its right - whichever
// keeps it off the names already placed; one with no clear side is left out, so hops that
// cluster keep one name between them instead of a pile. The two ends are never left out:
// a target answering from the probe's own city takes the side the probe's name does not.
function pickLabels(points: GlobePoint[], legs: GlobeLeg[], cities: NamedCity[], scale = 1): GlobePoint[] {
  const placed: GlobePoint[] = [];
  const landings = landingPoints(legs);
  const candidates = [
    ...points.filter((point) => point.role === "source" || point.role === "target"),
    ...points.filter((point) => point.role === "unreached"),
    ...points.filter((point) => point.role === "transit" && point.city),
    ...landings,
    ...waypoints(legs, cities, [...points, ...landings])
  ];
  const clear = (candidate: GlobePoint) => placed.every((other) => !labelsCollide(candidate, other, scale));

  for (const candidate of candidates) {
    const fit = ORIENTATIONS.map((orientation) => ({ ...candidate, orientation })).find((option) => clear(option));
    const room = fit ?? makeRoom(placed, candidate, scale);

    if (room) {
      placed.push(room);
    } else if (NEVER_DROPPED.has(candidate.role)) {
      const taken = new Set(placed.filter((other) => labelsCollide(candidate, other, scale)).map((other) => other.orientation ?? "bottom"));

      placed.push({ ...candidate, orientation: ORIENTATIONS.find((orientation) => !taken.has(orientation)) ?? "right" });
    }
  }

  return placed;
}

// Where the globe opens and stays: over the probe, as far out as the globe ever goes. The
// visitor turns it from there.
function sourceView(points: GlobePoint[]) {
  const source = points.find((point) => point.role === "source") ?? points[0];

  return { lat: source.lat, lng: source.lng, altitude: MAX_ALTITUDE };
}

// Stand-ins for every layer, kept for the life of the globe and out of sight inside the
// sphere. A material that is never disposed keeps its compiled shader alive: without
// these, each new route disposed the previous one's materials, three.js dropped the
// shaders nothing used any more, and the next frame compiled them all again - a stall of
// a few hundred milliseconds on every hop while the visitor waited, and at the reveal.
const STAND_IN_ALTITUDE = -0.05;
const STAND_IN_POINT: GlobePoint = { lat: -89, lng: 0, role: "transit", label: "·" };
const STAND_IN_RUN: Array<[number, number, number]> = [[-89, 0, STAND_IN_ALTITUDE], [-89, 1, STAND_IN_ALTITUDE]];
const STAND_IN_PATHS: GlobePath[] = [
  { kind: "aura", points: STAND_IN_RUN, dash: SOLID_DASH },
  { kind: "rim", points: STAND_IN_RUN, dash: SOLID_DASH },
  { kind: "glow", points: STAND_IN_RUN, dash: SOLID_DASH },
  { kind: "route", points: STAND_IN_RUN, dash: SOLID_DASH }
];

// One globe for the whole page. It owns a WebGL context, its borders, lights and cables
// take a moment to build, and its shaders take a moment to compile - so it is built once,
// at page load, and the view only borrows it. Opening the globe then costs a resize, not
// a construction.
interface Session {
  globe: GlobeInstance;
  host: HTMLDivElement;
  ready: Promise<void>;
  lights: { stars: Points; cities?: Points; halo?: Points };
  cables?: LineSegments2;
  cities: NamedCity[];
  showCables: boolean;
  theme: Theme;
  attached: boolean;
  shown: boolean;
  framed: boolean;
  // What the globe currently shows, so the same route is never rebuilt twice.
  routeKey: string;
  // The route on show, kept so the names can be picked again at another zoom.
  route?: { points: GlobePoint[]; legs: GlobeLeg[] };
  labelScale: number;
  lastAltitude: number;
  steadySince: number;
  // One glow material per theme, kept for the life of the page: the texture is drawn on a
  // canvas, and building it again on every route or every theme flip is work for nothing.
  halos: Partial<Record<Theme, MeshBasicMaterial>>;
}

let session: Session | undefined;
let sessionFailure: string | undefined;

export function warmGlobe(): Session | undefined {
  if (session || sessionFailure) {
    return session;
  }

  try {
    session = createSession();
  } catch (error) {
    sessionFailure = error instanceof Error ? error.message : "WebGL is not available in this browser.";
  }

  return session;
}

// Resolves once the globe has everything it needs to appear whole; immediately when there
// is no WebGL, so nothing waits on a globe that will never come.
export function globeReady(): Promise<void> {
  return warmGlobe()?.ready ?? Promise.resolve();
}

function createSession(): Session {
  const host = document.createElement("div");
  host.className = "globe-canvas";
  const globe = new Globe(host, { animateIn: false, rendererConfig: { antialias: true, alpha: true } });
  // A Retina screen renders the globe four times over; one and a half times is sharp
  // enough for lines and lights, and the first full-size frames come far cheaper.
  globe.renderer().setPixelRatio(Math.min(1.5, globalThis.devicePixelRatio || 1));

  globe
    .backgroundColor("rgba(0,0,0,0)")
    .showAtmosphere(true)
    .atmosphereAltitude(0.21)
    // Thin, and without side walls: a wall nobody sees still cost a draw call per country
    // every frame, and tall ones hid cables and lights near the horizon.
    .polygonAltitude(0.0015)
    .polygonSideColor(() => "")
    // The caps are flat triangles on a round globe; at the default five degrees a triangle
    // across Siberia sagged below the sphere in the middle and the dark globe showed
    // through as a jagged hole. At a degree and a half they hug the surface everywhere.
    .polygonCapCurvatureResolution(1.5)
    // Route glow and the streaming route core share the path layer.
    .pathPoints("points")
    .pathPointLat((point: [number, number, number]) => point[0])
    .pathPointLng((point: [number, number, number]) => point[1])
    .pathPointAlt((point: [number, number, number]) => point[2])
    .pathStroke((path: object) => STROKE[(path as GlobePath).kind])
    // Coarser tubes and no morphing between routes: both were building geometry, or
    // tweening it every frame, right when a result was about to appear.
    .pathResolution(3)
    .pathTransitionDuration(0)
    .labelsTransitionDuration(0)
    .ringsData([])
    // Every layer is drawn as a dashed line, because a dashed fat line has no round end
    // caps - and it was the caps of neighbouring segments, overlapping at every vertex and
    // adding up, that put a bright bead on each one. The aura's single dash is the whole
    // line, so it stays solid; the glow and the core carry the packets, and the stream
    // shows on any colour because between dashes the line drops back to the faint aura.
    .pathDashLength((path: object) => (path as GlobePath).dash.length)
    .pathDashGap((path: object) => (path as GlobePath).dash.gap)
    .pathDashAnimateTime((path: object) => (path as GlobePath).dash.animateMs)
    .pathLabel((path: object) => {
      const entry = path as GlobePath;

      return entry.name ? tip(entry.name, entry.meta ?? "", entry.why, entry.speed) : "";
    })
    .labelLabel((point: object) => {
      const entry = point as GlobePoint;

      return tip(entry.title ?? entry.label, entry.meta);
    })
    // Hops pulse.
    .ringAltitude((point: object) => (point === STAND_IN_POINT ? STAND_IN_ALTITUDE : RING_ALTITUDE))
    .ringMaxRadius((point: object) => (ENDS.has((point as GlobePoint).role) ? 2.6 : 1.7))
    .ringPropagationSpeed(1.1)
    .ringRepeatPeriod(1500)
    // The glow behind the two ends. Its size follows the names', so it keeps its place beside
    // the mark instead of swelling into the map as the visitor comes in.
    // A plane of its own each time, never one shared between them: the layer disposes the
    // geometry of every object it drops, and a shared one would be pulled out from under
    // the marks still using it. Four vertices apiece is nothing to pay for that.
    .customThreeObject(() => new Mesh(new PlaneGeometry(1, 1), session?.halos[session.theme]))
    .customThreeObjectUpdate((object: object, datum: object) => {
      const halo = object as Mesh;
      const point = datum as GlobePoint;
      // At the mark's own height, not the surface's: a hair of difference between them shows
      // as the glow sliding off the dot once the camera is close.
      const { x, y, z } = globe.getCoords(point.lat, point.lng, LABEL_ALTITUDE);

      halo.position.set(x, y, z);
      halo.quaternion.setFromUnitVectors(PLANE_FACE, haloNormal.set(x, y, z).normalize());
      halo.scale.setScalar(HALO_SPAN * (session?.labelScale ?? 1));
    })
    .labelAltitude((point: object) => (point === STAND_IN_POINT ? STAND_IN_ALTITUDE : LABEL_ALTITUDE))
    // Hops in full size; the landing stations a chain comes ashore at smaller and fainter,
    // named but never mistaken for a measured point.
    .labelSize((point: object) => labelSize(point as GlobePoint, session?.labelScale ?? 1))
    .labelDotOrientation((point: object) => (point as GlobePoint).orientation ?? "bottom")
    .labelDotRadius((point: object) => {
      const radius = DOT_RADIUS[(point as GlobePoint).role];

      // The dot is written in degrees like the name, so it shrinks with it; otherwise a
      // place mark swells into a blob that covers the coast it is meant to point at.
      return radius * (session?.labelScale ?? 1);
    })
    // Glyph outlines are triangulated on the main thread; two segments per curve is
    // smooth at this size and far cheaper than the default three.
    .labelResolution(2)
    .labelText((point: object) => typefaceText((point as GlobePoint).label))
    // Parked: a tiny canvas until a view borrows it.
    .width(2)
    .height(2);

  const controls = globe.controls();
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.45;
  controls.enableDamping = true;
  controls.maxDistance = globe.getGlobeRadius() * (1 + MAX_ALTITUDE);

  const stars = starField(Math.min(1500, (globe.camera() as PerspectiveCamera).far * 0.9));
  globe.scene().add(stars);

  const current: Session = {
    globe,
    host,
    ready: Promise.resolve(),
    lights: { stars },
    halos: {},
    cities: [],
    showCables: true,
    theme: "dark",
    attached: false,
    shown: false,
    framed: false,
    routeKey: "",
    labelScale: 1,
    lastAltitude: Number.NaN,
    steadySince: 0
  };

  globe.pathsData(STAND_IN_PATHS).ringsData([STAND_IN_POINT]).labelsData([STAND_IN_POINT]);

  // A handle for poking at the globe from the console, on request only.
  if (globalThis.location?.hash === "#globe-debug") {
    (globalThis as { __globe?: GlobeInstance }).__globe = globe;
    (globalThis as { __globeSession?: Session }).__globeSession = current;
  }

  const started = performance.now();
  const tick = () => {
    if (current.attached && current.shown) {
      neon(current);
      fitLabels(current);

      if (!REDUCED_MOTION) {
        const time = (performance.now() - started) / 1000;

        for (const layer of Object.values(current.lights)) {
          if (layer) (layer.material as ShaderMaterial).uniforms.time.value = time;
        }
      }
    }

    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const borders = loadCountries().then((features) => {
    globe.polygonsData(features);
  });
  const lights = cityGeometry().then((buffers) => {
    const layers = cityLights(buffers);
    globe.scene().add(layers.halo, layers.cities);
    current.lights = { ...current.lights, ...layers };
    applyPalette(current);
  });
  const names = loadCities().then((list) => {
    current.cities = list;
  });
  const wires = cableGeometry().then((buffers) => {
    const lines = cableLines(buffers, PALETTE[current.theme].cableOpacity);
    lines.visible = current.showCables;
    current.cables = lines;
    globe.scene().add(lines);
  });

  current.ready = Promise.all([borders, lights, wires, names])
    .catch(() => undefined)
    // A beat for the buffers to upload. Not animation frames: a tab in the background gets
    // none, and the result must not wait on a frame that only comes when the visitor is back.
    .then(() => new Promise<void>((resolve) => setTimeout(resolve, 60)))
    .then(() => {
      // Warmed: the stand-ins have had their frames and their shaders are compiled. Until
      // a view shows the globe there is nothing to draw - and drawing it anyway, some
      // hundreds of draw calls a frame for a two-pixel canvas, was taking most of the
      // page's main thread while the visitor waited on the probe.
      setTimeout(() => {
        if (!current.shown) globe.pauseAnimation();
      }, 400);
    });

  applyPalette(current);

  return current;
}

// The route's lines come with plain alpha blending, and a line over land is paint, not
// light. In the dark the aura and the glow are blended additively - they brighten whatever
// is under them, the way a neon tube lights its surroundings - and no layer writes depth,
// so the three never cut into each other. The line objects are built a beat after the
// data is set, so this runs every frame and only touches a material that is not yet right.
function neon(current: Session) {
  const additive = current.theme === "dark";
  const entries = current.globe.pathsData() as Array<GlobePath & { __threeObjPath?: { children: Array<{ material?: LineMaterial; renderOrder: number }> } }>;
  // The width of a screen-space line is measured against the canvas it is drawn on;
  // three-globe hands its lines the window's size instead, so on a canvas smaller than
  // the window the route drew thinner than set and the pointer had to be within a pixel
  // or two of it to be told what it was.
  const [width, height] = [current.globe.width(), current.globe.height()];

  for (const entry of entries) {
    const line = entry.__threeObjPath?.children[0];
    const material = line?.material;
    const blending = additive && entry.kind !== "route" ? AdditiveBlending : NormalBlending;

    if (line && material && (material.blending !== blending || material.depthWrite || !material.transparent || line.renderOrder !== ROUTE_RENDER_ORDER)) {
      material.blending = blending;
      material.depthWrite = false;
      material.transparent = true;
      line.renderOrder = ROUTE_RENDER_ORDER;
    }

    if (material && width > 2 && (material.resolution.x !== width || material.resolution.y !== height)) {
      material.resolution.set(width, height);
    }
  }
}

// The language is part of the key: the hover texts are built with the route.
// Names are re-picked in steps, and only once the view has come to rest: laying out a name
// builds its glyphs, and doing that on every turn of the wheel would cost frames while the
// visitor is still moving.
const LABEL_SCALE_STEPS = 8;
const LABEL_SETTLE_MS = 140;

function fitLabels(current: Session) {
  if (!current.route) {
    return;
  }

  const altitude = current.globe.camera().position.length() / current.globe.getGlobeRadius() - 1;
  const now = performance.now();

  if (Math.abs(altitude - current.lastAltitude) > 0.0005) {
    current.lastAltitude = altitude;
    current.steadySince = now;

    return;
  }

  const scale = Math.round(labelScaleFor(altitude) * LABEL_SCALE_STEPS) / LABEL_SCALE_STEPS;

  if (scale === current.labelScale || now - current.steadySince < LABEL_SETTLE_MS) {
    return;
  }

  current.labelScale = scale;
  current.globe.labelsData([STAND_IN_POINT, ...pickLabels(current.route.points, current.route.legs, current.cities, scale)]);
  showHalos(current);
}

// The glows, redrawn. Handing the layer a fresh array rebuilds them, which is how a
// change of theme reaches their material and a change of zoom reaches their size.
function showHalos(current: Session) {
  current.halos[current.theme] ??= haloMaterial(current.theme);
  current.globe.customLayerData((current.route?.points ?? []).filter((point) => ENDS.has(point.role)));
}

function routeKey(points: GlobePoint[], legs: GlobeLeg[]) {
  return `${currentLanguage()}#${points.map((point) => `${point.lat},${point.lng},${point.role},${point.kmps ?? "-"}`).join("|")}#${legs.map((leg) => `${leg.path.length}:${leg.kmps ?? "-"}`).join("|")}`;
}

// Puts a route on the globe - paths, pulsing rings, labels - whether or not a view is
// showing it. Called ahead of the result while the visitor is still waiting on the probe,
// so the reveal has nothing left to build, and again by the view, which then finds the
// work already done.
export function presentRoute(points: GlobePoint[], legs: GlobeLeg[]) {
  const current = warmGlobe();

  if (!current) {
    return;
  }

  const key = routeKey(points, legs);

  if (key === current.routeKey) {
    return;
  }

  current.routeKey = key;
  current.route = { points, legs };
  current.globe.pathsData([...STAND_IN_PATHS, ...routePaths(legs)]);
  current.globe
    .ringsData([STAND_IN_POINT, ...points.filter((point) => point.role !== "unreached")])
    .labelsData([STAND_IN_POINT, ...pickLabels(points, legs, current.cities, current.labelScale)]);
  showHalos(current);
  current.globe.controls().autoRotate = points.length === 0;
}

function applyPalette(current: Session) {
  const { globe, theme } = current;
  const palette = PALETTE[theme];

  showHalos(current);
  const material = globe.globeMaterial() as { color?: { set(value: string): void } };
  material.color?.set(palette.globe);

  globe
    .atmosphereColor(palette.atmosphere)
    .polygonCapColor((feature: object) => (isAntarctica(feature) ? "rgba(0,0,0,0)" : palette.land))
    .polygonStrokeColor(() => palette.border)
    .pathColor((path: object) => {
      const entry = path as GlobePath;
      const color = speedColor(entry.kmps, theme);

      // By night: a faint wide aura, the body at near full strength, and a core pulled most
      // of the way to white, a tube that burns brightest in the middle. By day nothing can
      // glow (light on white is white), so each dash is the speed's own colour at full
      // strength on a dark rim, with a white core, over a pale halo: sharp on the pale map,
      // and the halo alone shows between dashes, so the stream reads.
      if (entry.kind === "aura") return theme === "dark" ? `${color}38` : `${lighten(color, 0.6)}8c`;
      if (entry.kind === "rim") return theme === "dark" ? "#00000000" : "rgba(15, 23, 42, 0.55)";
      if (entry.kind === "glow") return theme === "dark" ? `${color}cc` : color;

      // A leg without a speed keeps the legend's grey; pulled to white it read as a verdict.
      return lighten(color, entry.kmps === undefined ? 0.12 : theme === "dark" ? 0.55 : 0.8);
    })
    .ringColor((point: object) => {
      const entry = point as GlobePoint;
      // An end's pulse is as plain as its mark; the colour around it comes from the glow.
      const color = ENDS.has(entry.role) ? ENDPOINT_INK[theme] : speedColor(entry.kmps, theme);

      return (t: number) => `${color}${Math.round((1 - t) * 200).toString(16).padStart(2, "0")}`;
    })
    .labelColor((point: object) => {
      const role = (point as GlobePoint).role;

      if (role === "waypoint") return palette.waypoint;
      if (role === "landing") return palette.landing;

      // The ends and the target that never answered are written in the page's plain ink, a
      // shade cleaner than a hop's; what sets an end apart is its size and the pulse around
      // it, not a colour of its own. The unreached target keeps the ink but no dot and no
      // ring: its name is parked on the last hop that did answer, and a mark there would put
      // the destination at an address nothing was seen to reach.
      return ENDS.has(role) || role === "unreached" ? ENDPOINT_INK[theme] : palette.label;
    });

  if (current.cables) {
    current.cables.material.opacity = palette.cableOpacity;
  }

  // Stars and city lights are a night-time thing; the day globe does without them.
  for (const layer of Object.values(current.lights)) {
    if (layer) layer.visible = theme === "dark";
  }
}

export default function GlobeView({ points, legs, theme, cables, shown }: GlobeViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The hover texts are built with the route, so a change of language rebuilds it.
  const { lang } = useLang();
  const [failure, setFailure] = useState<string | undefined>();
  // The globe stays invisible until borders, lights and cables are all in place, then
  // fades in as one picture instead of assembling itself in front of the visitor.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    const current = warmGlobe();

    if (!container) {
      return;
    }

    if (!current) {
      setFailure(sessionFailure);
      return;
    }

    container.appendChild(current.host);
    current.attached = true;

    const resize = () => {
      const { clientWidth: width, clientHeight: height } = container;
      current.globe.width(width).height(height);
      current.cables?.material.resolution.set(width, height);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    let cancelled = false;
    current.ready.then(() => {
      if (!cancelled) {
        resize();
        setReady(true);
      }
    });

    return () => {
      cancelled = true;
      observer.disconnect();
      current.attached = false;
      current.shown = false;
      current.framed = false;
      current.globe.pauseAnimation();

      if (current.host.parentNode === container) {
        current.host.remove();
      }

      current.globe.width(2).height(2);
    };
  }, []);

  useEffect(() => {
    if (session) {
      session.theme = theme;
      applyPalette(session);
    }
  }, [theme]);

  // Behind the flat map the globe draws nothing; in front, it draws again. It is never
  // taken out of the page: putting the canvas back and sizing it again cost a second or
  // two of stall every time the view was switched.
  useEffect(() => {
    if (session) {
      session.shown = shown;

      if (shown) session.globe.resumeAnimation();
      else session.globe.pauseAnimation();
    }
  }, [shown]);

  useEffect(() => {
    if (session) {
      session.showCables = cables;

      if (session.cables) {
        session.cables.visible = cables;
      }
    }
  }, [cables]);

  useEffect(() => {
    const current = session;

    if (!current) {
      return;
    }

    presentRoute(points, legs);

    // Opens over the probe - instantly, the globe is still faded out - and stays there;
    // the visitor turns the globe along the route themselves.
    if (points.length > 0 && !current.framed) {
      current.globe.pointOfView(sourceView(points), 0);
      current.framed = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, legs, lang]);

  return (
    <div className="globe-shell" style={shown ? undefined : { visibility: "hidden" }}>
      <div ref={containerRef} className={ready ? "globe-host globe-host--ready" : "globe-host"} aria-label="3D route globe" />
      {failure ? <div className="globe-fallback">{translateNow("map.globeUnavailable", { reason: failure })}</div> : null}
      <div className="globe-credits">
        Borders and cities: Natural Earth &middot; Submarine cables &copy;{" "}
        <a href="https://www.submarinecablemap.com" rel="noreferrer">TeleGeography</a> (CC BY-SA 4.0) &middot; Nangman Road uses
        IP2Location.io <a href="https://www.ip2location.io" rel="noreferrer">IP geolocation</a> web service.
      </div>
    </div>
  );
}
