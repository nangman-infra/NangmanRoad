// Routes a leg of the packet's path along the submarine cable network. The measurement only
// proves the two ends of a leg; what lies between them at sea is an inference, and every
// caller labels it as one. The cable set is a graph of vertices joined by the cables that
// pass through them, plus two kinds of land: short terrestrial bridges between landing
// stations (Panama, Suez, the Malay peninsula - where one cable system hands to the next
// over land), and the overland run from a hop to a landing station, which may be a whole
// continent (Seoul to Miami rides a Pacific cable to Los Angeles and crosses the US by
// fibre). A sea leg is the cheapest chain hop -> landing -> cables/bridges -> landing ->
// hop, kept only when it is mostly at sea and not a wild detour.

export type LatLng = [number, number];

interface CableFeature {
  // Owners as the cable map lists them, comma-separated.
  properties?: { name?: string; owners?: string };
  geometry: { coordinates: number[][][] };
}

// One stretch of a routed leg: along submarine cables, or overland between a hop and a
// landing station or between two stations.
export interface RouteSegment {
  path: LatLng[];
  sea: boolean;
  // The cable systems this stretch rides, in order; none overland.
  cables: string[];
  // The landing stations at its ends, where the ends are stations with a name.
  from?: string;
  to?: string;
  // A land part of a cable's own line: the system crosses an isthmus or reaches a station
  // some way inland, and the packet is on terrestrial fibre for this part.
  terrestrial?: boolean;
}

// An official landing point: name, latitude, longitude.
export type Landing = [string, number, number];

export interface CableRoute {
  path: LatLng[];
  // Every cable system the leg rides, in order.
  cables: string[];
  segments: RouteSegment[];
}

// What the leg between two hops rides, by the evidence there is: terrestrial fibre, a
// chain of cables, or - when it has to cross water and no chain was found within reach -
// nothing the map can name, so it is drawn straight and says so.
// Why a leg was decided the way it was: one code per reason, worded by the page in its
// own language.
export type LegEvidence =
  | { code: "off_coastline" | "different_landmass" | "closed_border" | "same_country" | "stays_on_land" | "short_bridge" | "land_assumed" | "no_chain_found" | "cheapest_chain" | "worker_failed" | "no_worker" | "straight_by_choice" }
  | { code: "open_water" | "bridged_water"; km: number }
  | { code: "no_chain_within"; ratio: number; rttMs?: number }
  | { code: "owner"; operator: string; cables: string[] }
  | { code: "fits_rtt"; rttMs: number };

export type LegDecision = ({ kind: "land"; path: LatLng[] } | { kind: "unrouted"; crossingKm: number } | ({ kind: "cable" } & CableRoute)) & {
  evidence: LegEvidence[];
};

// Draws the overland stretches: a corridor graph, or nothing, in which case they are straight.
export interface OverlandRouter {
  path(from: LatLng, to: LatLng): LatLng[];
}

export interface LegOptions {
  // Growth in round-trip time between the leg's two hops, when both answered: a bound on
  // how far the packet can have travelled.
  rttMs?: number;
  // The networks the leg's two hops belong to, as the traceroute names them: a carrier
  // rides the cables it owns.
  operators?: string[];
}

// Company names as the traceroute writes them ("Telstra Global", "Level 3 Parent, LLC")
// and as the cable map writes them ("Telstra", "Lumen"), reduced to what they share.
const LEGAL_WORDS = new Set([
  "inc", "ltd", "llc", "co", "corp", "corporation", "company", "plc", "sa", "ag", "se", "gmbh", "bv", "nv", "the", "of", "and",
  "limited", "group", "holdings", "international", "parent", "networks", "network", "services", "global", "communications",
  "communication", "telecommunications", "technologies", "technology"
]);
const OPERATOR_ALIASES: Record<string, string> = {
  "level 3": "lumen",
  centurylink: "lumen",
  "korea telecom": "kt",
  telia: "arelion",
  "telia carrier": "arelion",
  "verizon business": "verizon",
  "orange business": "orange",
  "singapore telecommunications": "singtel",
  "telecom italia sparkle": "sparkle",
  "hgc": "hgc",
  "at t": "at&t"
};

export function operatorKey(name: string) {
  const words = name
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((word) => word && !LEGAL_WORDS.has(word));
  const key = words.join(" ");

  return OPERATOR_ALIASES[key] ?? key;
}

function sameOperator(a: string, b: string) {
  return a === b || (a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b));
}

// A carrier's own cable costs less in the search: when two chains are close, the one on
// the cable the operator at the leg's end owns is the one it rides.
const OWNED_DISCOUNT = 0.7;

interface CountryFeature {
  properties: { continent?: string; iso?: string };
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: number[][][] | number[][][][] };
}

// What a point stands on. Landmass is the connected piece of land (Afro-Eurasia, the
// Americas, Honshu...): terrestrial fibre never leaves it, a cable is the only way off.
export interface Place {
  continent: string;
  country: string;
  landmass: number;
}

interface Ring {
  ring: number[][];
  box: [number, number, number, number];
  place: Place;
}

const KM_PER_DEGREE = 111.2;
// A coastal city or a small island the 1:110m coastline leaves out (Singapore, Hong Kong)
// belongs to the nearest shore this close.
const NEAR_SHORE_KM = 80;
const NEAR_SHORE_DEGREES = 1;

export class LandMask {
  private readonly rings: Ring[];

  constructor(collection: { features: CountryFeature[] }) {
    const rings: Array<Omit<Ring, "place"> & { continent: string; country: string }> = [];

    for (const feature of collection.features) {
      const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates as number[][][]] : (feature.geometry.coordinates as number[][][][]);

      for (const polygon of polygons) {
        // Outer ring only; lakes do not make a leg a sea crossing.
        const ring = polygon[0];
        const lngs = ring.map(([lng]) => lng);
        const lats = ring.map(([, lat]) => lat);

        rings.push({
          ring,
          box: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
          continent: feature.properties.continent ?? "",
          country: feature.properties.iso ?? ""
        });
      }
    }

    // Rings that share a border vertex are one landmass; Natural Earth draws both sides of a
    // border with the same vertices.
    const parent = rings.map((_ring, index) => index);
    const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])));
    const owner = new Map<string, number>();

    rings.forEach(({ ring }, index) => {
      for (const [lng, lat] of ring) {
        const key = `${lng},${lat}`;
        const other = owner.get(key);

        if (other === undefined) owner.set(key, index);
        else if (find(other) !== find(index)) parent[find(index)] = find(other);
      }
    });

    this.rings = rings.map(({ ring, box, continent, country }, index) => ({ ring, box, place: { continent, country, landmass: find(index) } }));
  }

  private inside([lat, lng]: LatLng) {
    return this.rings.find(({ box, ring }) => lng >= box[0] && lng <= box[2] && lat >= box[1] && lat <= box[3] && insideRing(lng, lat, ring));
  }

  placeAt(point: LatLng): Place | undefined {
    const inside = this.inside(point);

    if (inside) {
      return inside.place;
    }

    const [lat, lng] = point;

    const scale = Math.cos(radians(lat));
    let nearest: { km: number; place: Place } | undefined;

    for (const { box, ring, place } of this.rings) {
      if (lng < box[0] - NEAR_SHORE_DEGREES || lng > box[2] + NEAR_SHORE_DEGREES || lat < box[1] - NEAR_SHORE_DEGREES || lat > box[3] + NEAR_SHORE_DEGREES) {
        continue;
      }

      for (let index = 1; index < ring.length; index += 1) {
        const km = segmentKm(lng, lat, ring[index - 1], ring[index], scale);

        if (km <= NEAR_SHORE_KM && (!nearest || km < nearest.km)) {
          nearest = { km, place };
        }
      }
    }

    return nearest?.place;
  }

  // Inside a land polygon proper, with no nearest-shore leniency.
  onLand(point: LatLng) {
    return this.inside(point) !== undefined;
  }

  // Whether the straight line between two places runs mostly over land. The ends are left
  // out: the 1:110m coastline puts many a coastal station a few kilometres out to sea.
  overland(a: LatLng, b: LatLng) {
    const samples = greatCircle(a, b, 12).slice(1, -1);

    return samples.filter((point) => this.inside(point) !== undefined).length >= samples.length * OVERLAND_SHARE;
  }

  // Open water along the straight line between two places, sampled every ten kilometres or
  // so: the longest stretch, which a bridge or a tunnel would have to span for the leg to
  // stay terrestrial, and the total. The coarse coastline puts many a coastal city a few
  // kilometres out to sea; that shows as a stretch far shorter than any real crossing.
  waterAlong(a: LatLng, b: LatLng) {
    const km = haversineKm(a, b);
    const samples = Math.min(600, Math.max(4, Math.ceil(km / 10)));
    const step = km / samples;
    let longestKm = 0;
    let totalKm = 0;
    let run = 0;

    greatCircle(a, b, samples)
      .forEach((point) => {
        if (this.inside(point) === undefined) {
          run += step;
          totalKm += step;
          longestKm = Math.max(longestKm, run);
        } else {
          run = 0;
        }
      });

    return { longestKm, totalKm };
  }
}

function insideRing(x: number, y: number, ring: number[][]) {
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];

    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}

// Nearest point of a segment to a point, and the planar distance to it in km.
function nearestOnSegment(point: LatLng, a: LatLng, b: LatLng): { km: number; at: LatLng } {
  const scale = Math.cos(radians(point[0]));
  const ax = (a[1] - point[1]) * scale;
  const ay = a[0] - point[0];
  const dx = (b[1] - point[1]) * scale - ax;
  const dy = b[0] - point[0] - ay;
  const length = dx * dx + dy * dy;
  const t = length > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;

  return { km: Math.hypot(ax + t * dx, ay + t * dy) * KM_PER_DEGREE, at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
}

// Planar distance from a point to a segment, in km, with longitude scaled for the latitude.
function segmentKm(px: number, py: number, [ax, ay]: number[], [bx, by]: number[], scale: number) {
  const dx = (bx - ax) * scale;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * scale * dx + (py - ay) * dy) / length));

  return Math.hypot((px - ax) * scale - t * dx, py - ay - t * dy) * KM_PER_DEGREE;
}

// Above this share of the straight line on land, a same-continent leg is overland.
const OVERLAND_SHARE = 0.6;
// Where the land is one piece but terrestrial fibre still cannot pass. Countries whose
// every international link is submarine: South Korea's only land border is North Korea's,
// and no fibre crosses it. Continents joined by land no fibre crosses: the Darién Gap
// between the Americas has neither road nor cable. A leg across one of these is a cable.
const SEA_ONLY_COUNTRIES = new Set(["KR"]);
const NO_LAND_BETWEEN = new Set(["North America|South America"]);
// Borders with no telecom link across them: Israel's with Lebanon and with Syria, and
// Taiwan's with China - Kinmen sits a few kilometres off Xiamen, but no traffic transits
// that way. Natural Earth codes Taiwan CN-TW.
const NO_FIBRE_BORDERS = new Set(["IL|LB", "IL|SY", "CN|CN-TW"]);

function noLandRoute(a: Place, b: Place) {
  if (a.country === b.country) return false;
  if (SEA_ONLY_COUNTRIES.has(a.country) || SEA_ONLY_COUNTRIES.has(b.country)) return true;
  if (NO_FIBRE_BORDERS.has([a.country, b.country].sort().join("|"))) return true;

  return NO_LAND_BETWEEN.has([a.continent, b.continent].sort().join("|"));
}

// Open water longer than this along the straight line is more than a bridge or a tunnel
// spans: the leg is a cable, or goes round.
const SEA_CROSSING_KM = 60;
// Where land could carry the leg, a chain wins only if it is not far off the straight line.
const LAND_ALTERNATIVE_RATIO = 1.6;
const LAND_ALTERNATIVE_SLACK_KM = 300;
// Light in fibre covers about 102 km for every millisecond of round trip. A chain longer
// than the latency between the leg's two hops allows - with a margin for queueing and for
// a return path that differs - is not the way the packet went.
const FIBRE_KM_PER_RTT_MS = 102;
const RTT_SLACK = 1.3;
const MIN_RTT_EVIDENCE_MS = 2;

interface Node {
  lat: number;
  lng: number;
  // A line's end: a landing station, unless the same place is also inside a line (then it
  // is a branching unit at sea, where a branch meets its trunk).
  end: boolean;
  interior: boolean;
  landing: boolean;
  // The official landing station this end is, when one lies within LANDING_MATCH_KM.
  name?: string;
  nameKm?: number;
  edges: Array<{ to: number; km: number; sea: boolean; cable?: string }>;
}

const EARTH_RADIUS_KM = 6371;
// Vertices this close are one place: branching units and shared landing stations line up
// only approximately in the source data.
const SNAP_DEGREES = 0.04;
// A hop's city is rarely the landing station itself; Seoul is 330 km from Busan's cables,
// Frankfurt 800 km from Marseille's.
const LANDING_RADIUS_KM = 900;
// An official landing point this close to a line's end names that end.
const LANDING_MATCH_KM = 30;
const LANDING_CANDIDATES = 16;
// A branch whose end lies this close to another line of the same cable meets it there; the
// source data does not always put the branching unit exactly on the trunk.
const JOIN_KM = 25;
// Beyond that radius a landing is still reachable over land, up to a continent away, but at
// a premium so a real sea route wins whenever one exists.
const LAND_REACH_KM = 4_800;
// Long-haul terrestrial fibre is as real as a cable, but where a cable runs on to the
// far hop's own coast the packet stays on it rather than coming ashore early and going
// the rest of the way overland: every overland kilometre costs this much more in the
// search. Only the search's preference; the detour and latency limits are on real distance.
const LAND_PENALTY = 1.5;
// Walking into a neighbour's station costs more still: a packet for Hong Kong lands in
// Hong Kong, not in Taiwan to finish by road, whenever a cable reaches it - even a cable
// that takes the long way round the island.
const FOREIGN_LAND_PENALTY = 3;
// Landing stations this close on different systems are joined by terrestrial fibre. Any
// farther and a chain could hop between systems by walking, which a real route does not.
const BRIDGE_KM = 250;
// Walking between two stations costs more than the approach to the first or the exit
// from the last: a crossing between systems is the exception (Egypt, the Kra isthmus),
// while a packet on a system that itself runs on to the next station by sea stays on it
// - at the old price a chain left EAC-C2C at Taipei and walked the length of Taiwan to
// board it again, and left a cable on Malaysia's west coast to walk to Singapore.
const BRIDGE_PENALTY = 3;
// A cable's own line crosses land in places - Egypt between the Mediterranean and the Red
// Sea, the Kra isthmus, a station some way inland - and there the packet is on terrestrial
// fibre. Every sea run is cut wherever its line stays on land for longer than this, so the
// map draws that part as land; anything shorter is the coastline's own fuzz.
const LAND_RUN_KM = 20;
const LAND_SAMPLE_KM = 5;
// A chain has to be mostly sea to count as a cable route, and its sea part has to cover
// the water the straight line crosses; otherwise the leg is overland.
const MIN_SEA_SHARE = 0.3;
// ...and where land could carry the leg, a chain may walk at most this share of the
// straight line: one that walks nearly the whole way to ride a few kilometres of cable
// (Cairo to Tel Aviv over Sinai and the Taba-Aqaba cable) is a walk with a detour, not a
// cable route.
const MAX_WALK_SHARE = 0.5;
const MIN_CROSSING_COVER = 0.8;
// Below this a leg is drawn straight: a bridge or a tunnel carries it, not a cable system.
const MIN_SEA_LEG_KM = 150;
// Above this an international leg goes by cable even where land fibre could carry it:
// Beijing to Singapore is a cable, Frankfurt to Marseille is not.
const LONG_LEG_KM = 2_500;
// A cable chain longer than this multiple of the direct line is not the way the packet went.
// Real cable routes run well over twice the great circle when the straight line crosses a
// continent: Seoul to London is 8,900 km as the crow flies over Siberia and some 21,000 km
// round India and through Suez, 2.4 times - so the limit sits above that.
const MAX_DETOUR_RATIO = 2.8;
const MAX_DETOUR_SLACK_KM = 500;
// A cable counts as ridden when the chain follows it this far, or this much of its sea run.
const MIN_RIDDEN_KM = 150;
const MIN_RIDDEN_SHARE = 0.05;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

// Coarse grid cells, so joining branches and bridging stations stay linear in their number.
const JOIN_CELL = 0.5;
const BRIDGE_CELL = 4;

const gridKey = (point: { lat: number; lng: number }, cell: number) => `${Math.floor(point.lat / cell)},${Math.floor(point.lng / cell)}`;

function* neighbours<T>(cells: Map<string, T[]>, point: { lat: number; lng: number }, cell: number) {
  const row = Math.floor(point.lat / cell);
  const column = Math.floor(point.lng / cell);

  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      yield* cells.get(`${row + dr},${column + dc}`) ?? [];
    }
  }
}

function pathKm(path: LatLng[]) {
  return path.reduce((sum, point, index) => (index === 0 ? sum : sum + haversineKm(path[index - 1], point)), 0);
}

export function haversineKm(a: LatLng, b: LatLng) {
  const dLat = radians(b[0] - a[0]);
  const dLng = radians(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[0])) * Math.cos(radians(b[0])) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

// Points along the shortest surface path between two places, for legs drawn direct.
export function greatCircle(a: LatLng, b: LatLng, samples = 32): LatLng[] {
  const toVector = ([lat, lng]: LatLng) => {
    const phi = radians(lat);
    const lambda = radians(lng);

    return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
  };
  const [x1, y1, z1] = toVector(a);
  const [x2, y2, z2] = toVector(b);
  const omega = Math.acos(Math.min(1, Math.max(-1, x1 * x2 + y1 * y2 + z1 * z2)));

  if (omega < 1e-6) {
    return [a, b];
  }

  return Array.from({ length: samples + 1 }, (_value, index) => {
    const t = index / samples;
    const wa = Math.sin((1 - t) * omega) / Math.sin(omega);
    const wb = Math.sin(t * omega) / Math.sin(omega);
    const x = wa * x1 + wb * x2;
    const y = wa * y1 + wb * y2;
    const z = wa * z1 + wb * z2;

    return [(Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI, (Math.atan2(y, x) * 180) / Math.PI];
  });
}

export class MinHeap {
  private items: Array<{ cost: number; node: number }> = [];

  get size() {
    return this.items.length;
  }

  push(cost: number, node: number) {
    this.items.push({ cost, node });
    let index = this.items.length - 1;

    while (index > 0) {
      const parent = (index - 1) >> 1;

      if (this.items[parent].cost <= this.items[index].cost) {
        break;
      }

      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
      index = parent;
    }
  }

  pop() {
    const top = this.items[0];
    const last = this.items.pop();

    if (last && this.items.length > 0) {
      this.items[0] = last;
      let index = 0;

      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;

        if (left < this.items.length && this.items[left].cost < this.items[smallest].cost) smallest = left;
        if (right < this.items.length && this.items[right].cost < this.items[smallest].cost) smallest = right;
        if (smallest === index) break;

        [this.items[smallest], this.items[index]] = [this.items[index], this.items[smallest]];
        index = smallest;
      }
    }

    return top;
  }
}

export class CableGraph {
  private readonly nodes: Node[] = [];
  private readonly index = new Map<string, number>();
  private readonly mask?: LandMask;
  // What each landing station stands on, looked up once.
  private readonly places = new Map<number, Place | undefined>();

  private readonly land?: OverlandRouter;
  // Cables that only join two countries across a border no fibre crosses (Kinmen to
  // Xiamen): they carry those two countries' own traffic and nothing passing through.
  private readonly closed = new Map<string, string>();
  private readonly cableEnds = new Map<string, number[]>();
  // Each cable's owners, as operator keys, with the name the map gives them.
  private readonly owners = new Map<string, Array<{ key: string; name: string }>>();

  constructor(collection: { features: CableFeature[] }, mask?: LandMask, landings?: Landing[], land?: OverlandRouter) {
    this.mask = mask;
    this.land = land;
    for (const feature of collection.features) {
      const ends: Array<{ id: number; line: number }> = [];
      const cells = new Map<string, Array<{ id: number; line: number }>>();
      const lines: Array<Array<{ id: number }>> = [];

      feature.geometry.coordinates.forEach((line, lineIndex) => {
        let previous: number | undefined;
        const ids: Array<{ id: number }> = [];

        line.forEach(([lng, lat], position) => {
          // A line's ends are stations or branching units, except where the source split a
          // cable at the antimeridian: those ends are mid-ocean, and the two halves meet there.
          const end = (position === 0 || position === line.length - 1) && Math.abs(lng) < 179.9;
          const id = this.node(lat, lng, end);
          const entry = { id, line: lineIndex };

          if (end) ends.push(entry);
          cells.set(gridKey(this.nodes[id], JOIN_CELL), [...(cells.get(gridKey(this.nodes[id], JOIN_CELL)) ?? []), entry]);

          if (previous !== undefined && previous !== id) {
            this.link(previous, id, true, undefined, feature.properties?.name);
          }

          if (previous !== id) ids.push({ id });
          previous = id;
        });

        lines.push(ids);
      });

      this.joinBranches(ends, cells, lines, feature.properties?.name);

      if (feature.properties?.name) {
        this.cableEnds.set(feature.properties.name, ends.map((entry) => entry.id));

        if (feature.properties.owners) {
          this.owners.set(
            feature.properties.name,
            feature.properties.owners.split(",").map((owner) => owner.trim()).filter(Boolean).map((name) => ({ key: operatorKey(name), name }))
          );
        }
      }
    }

    this.nameLandings(landings ?? []);

    // A line's end is a station when an official landing point sits on it, or, failing
    // that, unless the same point is inside another line: then it is either a branching
    // unit at sea or a station a cable is drawn straight through (Busan sits inside a
    // Japan-China line), and the shore tells the two apart.
    const byName = this.countryByName();

    this.nodes.forEach((node, id) => {
      const place = node.end && mask ? mask.placeAt([node.lat, node.lng]) : undefined;
      node.landing = node.end && (node.name !== undefined || !node.interior || place !== undefined);

      if (node.landing) {
        const country = byName.get(id);
        this.places.set(id, place && country && country !== place.country ? { ...place, country } : place);
      }
    });

    this.bridgeLandings();

    for (const [cable, ids] of this.cableEnds) {
      const countries = [...new Set(ids.flatMap((id) => (this.nodes[id].landing ? [this.places.get(id)?.country] : [])).filter((country): country is string => Boolean(country)))].sort();
      const pair = countries.join("|");

      if (countries.length === 2 && NO_FIBRE_BORDERS.has(pair)) {
        this.closed.set(cable, pair);
      }
    }
  }

  // The official landing points, each matched to the nearest line end within reach: the
  // station's name for the labels, and the surest sign that an end is a station at all.
  private nameLandings(landings: Landing[]) {
    const ends = new Map<string, number[]>();

    this.nodes.forEach((node, id) => {
      if (node.end) {
        const key = gridKey(node, 1);
        ends.set(key, [...(ends.get(key) ?? []), id]);
      }
    });

    for (const [name, lat, lng] of landings) {
      let best: { id: number; km: number } | undefined;

      for (let dLat = -1; dLat <= 1; dLat += 1) {
        for (let dLng = -1; dLng <= 1; dLng += 1) {
          for (const id of ends.get(`${Math.floor(lat) + dLat},${Math.floor(lng) + dLng}`) ?? []) {
            const km = haversineKm([lat, lng], [this.nodes[id].lat, this.nodes[id].lng]);

            if (km <= LANDING_MATCH_KM && (!best || km < best.km)) {
              best = { id, km };
            }
          }
        }
      }

      if (best && best.km < (this.nodes[best.id].nameKm ?? Number.POSITIVE_INFINITY)) {
        this.nodes[best.id].name = name;
        this.nodes[best.id].nameKm = best.km;
      }
    }
  }

  // The country a landing's name gives it ("Jinhu Township, Taiwan"), as the code the
  // coastline uses for that country's other landings. The coarse coastline puts a station
  // on a small island (Kinmen) on the nearest mainland shore, in the wrong country; the
  // name knows better. Each name country maps to whatever code most of its landings get.
  private countryByName() {
    const votes = new Map<string, Map<string, number>>();
    const named: Array<{ id: number; country: string }> = [];

    this.nodes.forEach((node, id) => {
      const country = node.name?.split(", ").at(-1);

      if (!country || !this.mask) return;

      named.push({ id, country });
      const code = this.mask.placeAt([node.lat, node.lng])?.country;

      if (code) {
        const tally = votes.get(country) ?? new Map<string, number>();
        tally.set(code, (tally.get(code) ?? 0) + 1);
        votes.set(country, tally);
      }
    });

    const codes = new Map<string, string>();

    for (const [country, tally] of votes) {
      codes.set(country, [...tally].sort((a, b) => b[1] - a[1])[0][0]);
    }

    return new Map(named.map(({ id, country }) => [id, codes.get(country)]));
  }

  // The cables any of these operators owns, with the owner's name as the map writes it.
  private ownedCables(operators: string[]) {
    const keys = operators.map(operatorKey).filter((key) => key.length >= 2);
    const owned = new Map<string, string>();

    if (keys.length === 0) return owned;

    for (const [cable, cableOwners] of this.owners) {
      const owner = cableOwners.find((entry) => keys.some((key) => sameOperator(key, entry.key)));

      if (owner) owned.set(cable, owner.name);
    }

    return owned;
  }

  // How an overland stretch is drawn: along the corridors when there are any, else straight.
  private overland(from: LatLng, to: LatLng): LatLng[] {
    return this.land?.path(from, to) ?? [from, to];
  }

  // Terrestrial fibre stays on one piece of land; without the coastline, distance decides.
  private byLand(place: Place | undefined, id: number) {
    const other = this.places.get(id);

    return !place || !this.mask || other?.landmass === place.landmass;
  }

  // A branch end that does not sit exactly on its trunk still meets it: link it to the
  // nearest vertex of another line of the same cable within JOIN_KM - or, when the trunk
  // crosses an ocean in one stroke with no vertex anywhere near, to the nearest point of
  // the trunk's segment, which becomes a node of its own.
  private joinBranches(
    ends: Array<{ id: number; line: number }>,
    cells: Map<string, Array<{ id: number; line: number }>>,
    lines: Array<Array<{ id: number }>>,
    cable?: string
  ) {
    for (const end of ends) {
      const node = this.nodes[end.id];
      let nearest: { id: number; km: number } | undefined;

      for (const other of neighbours(cells, node, JOIN_CELL)) {
        if (other.line === end.line || other.id === end.id) continue;

        const km = haversineKm([node.lat, node.lng], [this.nodes[other.id].lat, this.nodes[other.id].lng]);

        if (km <= JOIN_KM && (!nearest || km < nearest.km)) {
          nearest = { id: other.id, km };
        }
      }

      if (!nearest) {
        const point: LatLng = [node.lat, node.lng];
        let best: { a: number; b: number; at: LatLng; km: number } | undefined;

        lines.forEach((line, index) => {
          if (index === end.line) return;

          for (let position = 1; position < line.length; position += 1) {
            const a = this.nodes[line[position - 1].id];
            const b = this.nodes[line[position].id];
            const reach = JOIN_KM / 111.2 + 0.1;

            if (
              point[0] < Math.min(a.lat, b.lat) - reach ||
              point[0] > Math.max(a.lat, b.lat) + reach ||
              point[1] < Math.min(a.lng, b.lng) - reach ||
              point[1] > Math.max(a.lng, b.lng) + reach
            ) {
              continue;
            }

            const { km, at } = nearestOnSegment(point, [a.lat, a.lng], [b.lat, b.lng]);

            if (km <= JOIN_KM && (!best || km < best.km)) {
              best = { a: line[position - 1].id, b: line[position].id, at, km };
            }
          }
        });

        if (best) {
          const junction = this.node(best.at[0], best.at[1], false);
          this.link(junction, best.a, true, undefined, cable);
          this.link(junction, best.b, true, undefined, cable);
          nearest = { id: junction, km: best.km };
        }
      }

      if (nearest && !node.edges.some((edge) => edge.to === nearest?.id)) {
        this.link(end.id, nearest.id, true, undefined, cable);
        node.interior ||= this.nodes[nearest.id].interior;
      }
    }
  }

  // Terrestrial bridges: every pair of landing stations within BRIDGE_KM, bucketed by a
  // coarse grid so the pass stays linear in the number of stations.
  private bridgeLandings() {
    const buckets = new Map<string, Array<{ id: number }>>();
    const landings = this.nodes.flatMap((node, id) => (node.landing ? [id] : []));

    for (const id of landings) {
      const key = gridKey(this.nodes[id], BRIDGE_CELL);
      buckets.set(key, [...(buckets.get(key) ?? []), { id }]);
    }

    for (const id of landings) {
      const node = this.nodes[id];

      for (const { id: other } of neighbours(buckets, node, BRIDGE_CELL)) {
        if (other <= id) continue;

        const km = haversineKm([node.lat, node.lng], [this.nodes[other].lat, this.nodes[other].lng]);

        const [here, there] = [this.places.get(id), this.places.get(other)];

        // ...on one piece of land, and never across a border no fibre crosses.
        if (km <= BRIDGE_KM && this.byLand(here, other) && !(here && there && noLandRoute(here, there)) && !node.edges.some((edge) => edge.to === other)) {
          this.link(id, other, false, km);
        }
      }
    }
  }

  get nodeCount() {
    return this.nodes.length;
  }

  private node(lat: number, lng: number, end: boolean) {
    // +180 and -180 are the same meridian; without this a transpacific cable is two graphs.
    if (lng >= 180) lng -= 360;

    const key = `${Math.round(lat / SNAP_DEGREES)},${Math.round(lng / SNAP_DEGREES)}`;
    let id = this.index.get(key);

    if (id === undefined) {
      id = this.nodes.push({ lat, lng, end: false, interior: false, landing: false, edges: [] }) - 1;
      this.index.set(key, id);
    }

    if (end) this.nodes[id].end = true;
    else this.nodes[id].interior = true;

    return id;
  }

  private link(a: number, b: number, sea: boolean, cost?: number, cable?: string) {
    const km = cost ?? haversineKm([this.nodes[a].lat, this.nodes[a].lng], [this.nodes[b].lat, this.nodes[b].lng]);
    this.nodes[a].edges.push({ to: b, km, sea, cable });
    this.nodes[b].edges.push({ to: a, km, sea, cable });
  }

  // What it costs a hop to reach a landing station overland: the plain distance nearby, a
  // premium beyond that so a real sea route wins whenever one exists, nothing past a
  // continent's width.
  // What terrestrial fibre reaches from a hop: its own country's stations across the whole
  // piece of land (Los Angeles serves Miami), a neighbour's only nearby and over land
  // (Marseille serves Frankfurt; Shanghai does not serve Seoul across the Yellow Sea, nor
  // Myanmar across China). Without the coastline, distance alone decides.
  private attachmentCost(point: LatLng, place: Place | undefined, id: number) {
    const node = this.nodes[id];

    if (!node.landing) {
      return undefined;
    }

    const km = haversineKm(point, [node.lat, node.lng]);

    if (km > LAND_REACH_KM) {
      return undefined;
    }

    if (this.mask && place) {
      const station = this.places.get(id);

      if (station?.landmass !== place.landmass) {
        return undefined;
      }

      if (station.country !== place.country && (km > LANDING_RADIUS_KM || noLandRoute(place, station) || !this.mask.overland(point, [node.lat, node.lng]))) {
        return undefined;
      }

      return { km, cost: km * (station.country === place.country ? LAND_PENALTY : FOREIGN_LAND_PENALTY) };
    }

    return { km, cost: km * LAND_PENALTY };
  }

  // Every landing station a hop can reach, dearest last. The whole reachable set goes into
  // the search: the right station for Seoul to Miami is Los Angeles, which no shortlist of
  // the stations nearest Miami would ever include.
  private landingsNear(point: LatLng, place: Place | undefined) {
    return this.nodes
      .map((_node, id) => {
        const reach = this.attachmentCost(point, place, id);

        return { id, km: reach?.km ?? Number.POSITIVE_INFINITY, cost: reach?.cost ?? Number.POSITIVE_INFINITY };
      })
      .filter((entry) => Number.isFinite(entry.km))
      .sort((a, b) => a.km - b.km);
  }

  // The cable chain for one leg, or undefined when the leg is drawn straight.
  route(from: LatLng, to: LatLng): LatLng[] | undefined {
    return this.routeWithCables(from, to)?.path;
  }

  routeWithCables(from: LatLng, to: LatLng, options: LegOptions = {}): CableRoute | undefined {
    const decision = this.decide(from, to, options);

    return decision.kind === "cable" ? decision : undefined;
  }

  // Land, cable, or neither, by the evidence there is. Terrestrial fibre never leaves a
  // piece of land and never crosses a border that carries none, so a leg off its landmass
  // or across such a border is a cable. On one piece of land a domestic leg is terrestrial
  // (Los Angeles to New York), and so is an international one whose straight line never
  // leaves land for longer than a bridge or a tunnel spans (Frankfurt to Marseille,
  // Copenhagen to Malmö). One that crosses open water (Seoul to Hong Kong, Helsinki to
  // Tallinn) is a cable when a chain exists that is not a long way round and fits the
  // latency measured; so is a long international leg that touches water at all (Beijing to
  // Singapore). Failing that, it is terrestrial after all.
  // Every sea run cut where its line stays on land for LAND_RUN_KM or more: the parts on
  // land keep the cable's name and are drawn as land.
  private cutAtLand(segments: RouteSegment[]): RouteSegment[] {
    const mask = this.mask;

    if (!mask) return segments;

    return segments.flatMap((segment) => {
      if (!segment.sea || segment.path.length < 2) return [segment];

      // The line sampled every few kilometres, each sample knowing whether it is a vertex
      // of the line and how far along it lies.
      const samples: Array<{ point: LatLng; land: boolean; vertex: boolean; km: number }> = [{ point: segment.path[0], land: mask.onLand(segment.path[0]), vertex: true, km: 0 }];

      for (let index = 1; index < segment.path.length; index += 1) {
        const [a, b] = [segment.path[index - 1], segment.path[index]];
        const km = haversineKm(a, b);
        const steps = Math.max(1, Math.ceil(km / LAND_SAMPLE_KM));
        const points = greatCircle(a, b, steps);
        const base = samples[samples.length - 1].km;

        points.slice(1).forEach((point, step) => {
          // The line's own vertex, exactly, where the samples reach it: the stretches must
          // meet end to end.
          const vertex = step === points.length - 2;

          samples.push({ point: vertex ? b : point, land: mask.onLand(point), vertex, km: base + (km * (step + 1)) / steps });
        });
      }

      // The land runs long enough to count, as [first, last] sample indices.
      const cuts = new Set<number>();

      for (let start = 0; start < samples.length; ) {
        if (!samples[start].land) {
          start += 1;
          continue;
        }

        let end = start;

        while (end + 1 < samples.length && samples[end + 1].land) end += 1;

        if (samples[end].km - samples[start].km >= LAND_RUN_KM) {
          if (start > 0) cuts.add(start);
          if (end < samples.length - 1) cuts.add(end);
        }

        start = end + 1;
      }

      if (cuts.size === 0) return [segment];

      // Walk the samples, starting a new piece at every cut; a piece keeps the line's own
      // vertices and the cut points at its ends.
      const pieces: Array<{ land: boolean; path: LatLng[] }> = [{ land: samples[0].land && (cuts.has(0) || [...cuts][0] > 0 && samples.slice(0, [...cuts][0] + 1).every((sample) => sample.land)), path: [samples[0].point] }];

      samples.forEach((sample, index) => {
        if (index === 0) return;

        const piece = pieces[pieces.length - 1];

        if (cuts.has(index)) {
          piece.path.push(sample.point);
          pieces.push({ land: !piece.land, path: [sample.point] });
        } else if (sample.vertex) {
          piece.path.push(sample.point);
        }
      });

      const kept = pieces.filter((piece) => piece.path.length > 1);

      return kept.map((piece, index) =>
        piece.land
          ? { path: piece.path, sea: false, cables: segment.cables, terrestrial: true }
          : { path: piece.path, sea: true, cables: segment.cables, from: index === 0 ? segment.from : undefined, to: index === kept.length - 1 ? segment.to : undefined }
      );
    });
  }

  decide(from: LatLng, to: LatLng, options: LegOptions = {}): LegDecision {
    const direct = haversineKm(from, to);
    const fromPlace = this.mask?.placeAt(from);
    const toPlace = this.mask?.placeAt(to);
    const water = this.mask?.waterAlong(from, to) ?? { longestKm: direct < MIN_SEA_LEG_KM ? 0 : direct, totalKm: direct };
    const landPossible =
      this.mask !== undefined && fromPlace !== undefined && toPlace !== undefined && fromPlace.landmass === toPlace.landmass && !noLandRoute(fromPlace, toPlace);
    const bridged = water.longestKm < SEA_CROSSING_KM;
    const why: LegEvidence[] = [];
    const measured = options.rttMs !== undefined && options.rttMs >= MIN_RTT_EVIDENCE_MS ? Math.round(options.rttMs) : undefined;

    if (this.mask && (!fromPlace || !toPlace)) why.push({ code: "off_coastline" });
    else if (fromPlace && toPlace && fromPlace.landmass !== toPlace.landmass) why.push({ code: "different_landmass" });
    else if (fromPlace && toPlace && noLandRoute(fromPlace, toPlace)) why.push({ code: "closed_border" });

    if (water.longestKm >= SEA_CROSSING_KM) why.push({ code: "open_water", km: Math.round(water.longestKm) });

    if (landPossible) {
      const domestic = fromPlace?.country === toPlace?.country;

      if (domestic) {
        return { kind: "land", path: this.overland(from, to), evidence: [{ code: "same_country" }] };
      }

      if (bridged && (direct < LONG_LEG_KM || water.totalKm < SEA_CROSSING_KM)) {
        return {
          kind: "land",
          path: this.overland(from, to),
          evidence: [water.longestKm > 0 ? { code: "bridged_water", km: Math.round(water.longestKm) } : { code: "stays_on_land" }]
        };
      }
    } else if (direct < MIN_SEA_LEG_KM && bridged) {
      return { kind: "land", path: this.overland(from, to), evidence: [...why, { code: "short_bridge" }] };
    }

    const fallback: LegDecision = landPossible
      ? { kind: "land", path: this.overland(from, to), evidence: [...why, { code: "no_chain_within", ratio: LAND_ALTERNATIVE_RATIO, rttMs: measured }, { code: "land_assumed" }] }
      : { kind: "unrouted", crossingKm: Math.round(water.longestKm), evidence: [...why, { code: "no_chain_found" }] };
    const owned = this.ownedCables(options.operators ?? []);
    // A cable between two countries whose border carries no transit is open to a leg
    // between those two countries and closed to every other.
    const legPair = fromPlace && toPlace ? [fromPlace.country, toPlace.country].sort().join("|") : undefined;
    const starts = this.landingsNear(from, fromPlace).slice(0, LANDING_CANDIDATES * 8);

    if (starts.length === 0) {
      return fallback;
    }

    // How far round a chain may go. Off the landmass any chain short of a wild detour beats
    // a line across open water; where land could carry the leg, only a chain close to the
    // straight line, and short enough for the latency measured, beats the land.
    let budget = landPossible ? direct * LAND_ALTERNATIVE_RATIO + LAND_ALTERNATIVE_SLACK_KM : direct * MAX_DETOUR_RATIO + MAX_DETOUR_SLACK_KM;

    if (landPossible && options.rttMs !== undefined && options.rttMs >= MIN_RTT_EVIDENCE_MS) {
      budget = Math.min(budget, options.rttMs * FIBRE_KM_PER_RTT_MS * RTT_SLACK);
    }

    // The search orders chains by cost, overland kilometres at a premium; the detour and
    // latency limits, and the share of the way at sea, are on the kilometres as travelled.
    const cost = new Map<number, number>();
    const travelled = new Map<number, number>();
    const seaKm = new Map<number, number>();
    const cameFrom = new Map<number, number>();
    const cameBy = new Map<number, { sea: boolean; cable?: string }>();
    const heap = new MinHeap();
    let best: { node: number; cost: number } | undefined;

    for (const start of starts) {
      cost.set(start.id, start.cost);
      travelled.set(start.id, start.km);
      seaKm.set(start.id, 0);
      heap.push(start.cost, start.id);
    }

    while (heap.size > 0) {
      const current = heap.pop();
      const soFar = travelled.get(current.node) ?? 0;

      if (current.cost > (cost.get(current.node) ?? Number.POSITIVE_INFINITY) || soFar > budget) {
        continue;
      }

      if (current.cost > (best?.cost ?? Number.POSITIVE_INFINITY)) {
        break;
      }

      const exit = this.attachmentCost(to, toPlace, current.node);

      if (exit !== undefined) {
        const total = current.cost + exit.cost;
        const atSea = seaKm.get(current.node) ?? 0;

        // A chain that walks farther overland than the whole straight line is not a way
        // across the water; it is a way round it, along some coast's own cable. Where land
        // could carry the leg, a chain also has to be mostly sea to be worth more than the
        // land; off the landmass any crossing is the crossing there is, however short
        // (London to Karlsruhe crosses the Channel once, over a few dozen kilometres).
        if (
          soFar + exit.km <= budget &&
          soFar - atSea + exit.km <= direct * (landPossible ? MAX_WALK_SHARE : 1) &&
          atSea >= (landPossible ? direct * MIN_SEA_SHARE : 0) &&
          atSea >= water.longestKm * MIN_CROSSING_COVER &&
          (!best || total < best.cost)
        ) {
          best = { node: current.node, cost: total };
        }
      }

      for (const edge of this.nodes[current.node].edges) {
        if (edge.cable && this.closed.has(edge.cable) && this.closed.get(edge.cable) !== legPair) {
          continue;
        }

        const next = current.cost + (edge.sea ? (edge.cable && owned.has(edge.cable) ? edge.km * OWNED_DISCOUNT : edge.km) : edge.km * BRIDGE_PENALTY);

        if (next < (cost.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
          cost.set(edge.to, next);
          travelled.set(edge.to, soFar + edge.km);
          seaKm.set(edge.to, (seaKm.get(current.node) ?? 0) + (edge.sea ? edge.km : 0));
          cameFrom.set(edge.to, current.node);
          cameBy.set(edge.to, { sea: edge.sea, cable: edge.cable });
          heap.push(next, edge.to);
        }
      }
    }

    if (!best) {
      return fallback;
    }

    const ids: number[] = [];

    for (let node: number | undefined = best.node; node !== undefined; node = cameFrom.get(node)) {
      ids.push(node);
    }

    ids.reverse();
    const at = (id: number): LatLng => [this.nodes[id].lat, this.nodes[id].lng];

    // The chain cut where it leaves the sea for the land and back: the overland approach
    // from the hop to the first station, every run of cable, every terrestrial bridge
    // between stations, and the overland exit to the far hop. Each sea run names the
    // systems it really rides: where two run the same corridor the search hops between
    // them at shared stations for a few kilometres, which is a quirk of the search, not a
    // route, so a system counts only past a fair share of the run.
    const segments: RouteSegment[] = [];
    const name = (id: number | undefined) => (id === undefined ? undefined : this.nodes[id].name);
    let current: RouteSegment = { path: this.overland(from, at(ids[0])), sea: false, cables: [] };
    let endId: number | undefined = ids[0];
    let ridden = new Map<string, number>();
    const close = () => {
      const km = pathKm(current.path);

      if (km > 0.5) {
        const atSea = [...ridden.values()].reduce((sum, value) => sum + value, 0);
        current.cables = [...ridden].filter(([, value]) => value >= Math.min(MIN_RIDDEN_KM, atSea * MIN_RIDDEN_SHARE)).map(([cable]) => cable);
        current.to = name(endId);
        segments.push(current);
      }

      ridden = new Map();
    };

    for (let index = 1; index < ids.length; index += 1) {
      const by = cameBy.get(ids[index]) ?? { sea: false };
      const point = at(ids[index]);

      if (by.sea !== current.sea) {
        close();
        current = { path: by.sea ? [at(ids[index - 1]), point] : this.overland(at(ids[index - 1]), point), sea: by.sea, cables: [], from: name(ids[index - 1]) };
      } else if (by.sea) {
        current.path.push(point);
      } else {
        current.path.push(...this.overland(at(ids[index - 1]), point).slice(1));
      }

      endId = ids[index];

      if (by.sea && by.cable) {
        ridden.set(by.cable, (ridden.get(by.cable) ?? 0) + haversineKm(at(ids[index - 1]), point));
      }
    }

    if (current.sea) {
      close();
      current = { path: this.overland(at(ids[ids.length - 1]), to), sea: false, cables: [], from: name(ids[ids.length - 1]) };
    } else {
      current.path.push(...this.overland(at(ids[ids.length - 1]), to).slice(1));
    }

    endId = undefined;
    close();

    const cut = this.cutAtLand(segments);
    const path = cut.flatMap((segment, index) => (index === 0 ? segment.path : segment.path.slice(1)));
    const cables = [...new Set(segments.flatMap((segment) => segment.cables))];
    const ownedRidden = cables.filter((cable) => owned.has(cable));
    const evidence: LegEvidence[] = [
      ...why,
      ownedRidden.length > 0 ? { code: "owner", operator: owned.get(ownedRidden[0]) ?? "", cables: ownedRidden } : { code: "cheapest_chain" },
      ...(landPossible && measured !== undefined ? [{ code: "fits_rtt" as const, rttMs: measured }] : [])
    ];

    return { kind: "cable", path, cables, segments: cut, evidence };
  }
}
