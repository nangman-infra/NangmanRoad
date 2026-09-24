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
  // Owners as the cable map lists them, comma-separated, and the stations the map lists
  // the cable as landing at, by name.
  properties?: { name?: string; owners?: string; landings?: string[] };
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
  // Every named landing station the stretch runs through, ends included. A chain hands
  // from one cable system to the next at a shared station, and those handovers sit in the
  // middle of a sea run - Matara on the way round Sri Lanka, Abu Talat at Suez - so the
  // ends alone leave most of the stations a leg touches with no name anywhere.
  via?: Array<{ name: string; at: LatLng }>;
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

// Two codes as one key, whichever way round they came: the sets below are written that way.
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Plain code-unit order, said out loud, because a bare sort() means something else for numbers.
const compareCode = (a: string, b: string) => (a < b ? -1 : Number(a > b));

export function operatorKey(name: string) {
  const words = name
    .toLowerCase()
    .replaceAll("&", " ")
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
  properties: { continent?: string; iso?: string; name?: string };
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: number[][][] | number[][][][] };
}

// What a point stands on. Landmass is the connected piece of land (Afro-Eurasia, the
// Americas, Honshu...): terrestrial fibre never leaves it, a cable is the only way off.
// Island is that piece as the coastline draws it, before a fixed link joins it to another.
export interface Place {
  continent: string;
  country: string;
  landmass: number;
  island: number;
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
// Natural Earth codes a few territories on their own while the landing list files their
// stations under the country that holds them ("Chai Wan, China"): a hop in Kowloon took Hong
// Kong's stations for foreign ones, reached only Tseung Kwan O over land, and got there by
// crossing the harbour on TKO Connect. On the coastline too they count as that country.
const TERRITORY_OF = new Map([
  ["HK", "CN"],
  ["PR", "US"],
  ["AX", "FI"]
]);

// Natural Earth gives France, Norway, Kosovo, Somaliland and a few others no two-letter code,
// "-99" for each: as one country, Hargeisa to Paris was a domestic leg drawn overland and Paris
// to Oslo never looked for a chain. Their names keep them apart.
function countryCode(properties: CountryFeature["properties"]) {
  return properties.iso === "-99" ? (properties.name ?? properties.iso) : (properties.iso ?? "");
}
// Bridges and tunnels the coastline knows nothing of. Each joins the pieces of land at its two
// ends into one, and terrestrial fibre crosses where the road does: without them Copenhagen's
// chains crossed the Belts on GlobalConnect's cables. A point at either end of each: the Great
// Belt, the Little Belt, the Øresund and Falster's bridges; the Seto-Ohashi and the Seikan
// Tunnel; the Confederation Bridge; the Menai Strait; the Öland Bridge. Not Kanmon: with Kyushu
// joined to Honshu, chains from Shanghai and Beijing to Osaka came ashore at Kitakyushu by way
// of Busan - the traces from both cities that show the way (September 2026) reach Japan through
// Tokyo or Hong Kong - and Tokyo to Seoul found no chain at all. Not Long Island to the Bronx
// either: New York's chains do cross the Sound on the Cross Sound Cable without it, but with it
// Bilbao's chain to Washington left MAREA for Grace Hopper and a walk down from Long Island,
// where Cogent's Bilbao router reaches Washington directly (September 2026).
const FIXED_LINKS: Array<[LatLng, LatLng]> = [
  [[55.64, 12.08], [55.4, 10.39]],
  [[55.4, 10.39], [55.49, 9.47]],
  [[55.68, 12.57], [55.6, 13]],
  [[55.23, 11.76], [54.77, 11.87]],
  [[34.66, 133.92], [34.34, 134.05]],
  [[40.82, 140.74], [41.77, 140.73]],
  [[46.24, -63.13], [46.09, -64.78]],
  [[53.3, -4.35], [53.2, -4.1]],
  [[56.88, 16.66], [56.66, 16.36]]
];

export class LandMask {
  private readonly rings: Ring[];
  // The pairs of islands a fixed link joins.
  private readonly links = new Set<string>();

  constructor(collection: { features: CountryFeature[] }) {
    const rings: Array<Omit<Ring, "place"> & { continent: string; country: string }> = [];

    for (const feature of collection.features) {
      const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates as number[][][]] : (feature.geometry.coordinates as number[][][][]);
      const iso = countryCode(feature.properties);

      for (const polygon of polygons) {
        // Outer ring only; lakes do not make a leg a sea crossing.
        const ring = polygon[0];
        const lngs = ring.map(([lng]) => lng);
        const lats = ring.map(([, lat]) => lat);

        rings.push({
          ring,
          box: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
          continent: feature.properties.continent ?? "",
          country: TERRITORY_OF.get(iso) ?? iso
        });
      }
    }

    // Rings that share a border vertex are one landmass; Natural Earth draws both sides of a
    // border with the same vertices.
    const parent = rings.map((_ring, index) => index);
    const find = (index: number): number => {
      if (parent[index] === index) return index;

      // Path compression: every node on the way up points at the root afterwards.
      parent[index] = find(parent[index]);

      return parent[index];
    };
    const owner = new Map<string, number>();

    rings.forEach(({ ring }, index) => {
      for (const [lng, lat] of ring) {
        const key = `${lng},${lat}`;
        const other = owner.get(key);

        if (other === undefined) owner.set(key, index);
        else if (find(other) !== find(index)) parent[find(index)] = find(other);
      }
    });

    this.rings = rings.map(({ ring, box, continent, country }, index) => ({ ring, box, place: { continent, country, landmass: find(index), island: find(index) } }));

    for (const [a, b] of FIXED_LINKS) {
      const [here, there] = [this.placeAt(a), this.placeAt(b)];
      const one = here?.landmass;
      const other = there?.landmass;

      if (here && there) this.links.add(pairKey(String(here.island), String(there.island)));

      for (const { place } of this.rings) {
        if (one !== undefined && other !== undefined && place.landmass === other) place.landmass = one;
      }
    }
  }

  // How a drawn overland path meets the sea and the borders: the longest stretch of open water
  // along it, carried from one stroke to the next, and how far it runs in each country.
  alongPath(path: LatLng[]) {
    const countryKm = new Map<string, number>();
    let run = 0;
    let longestKm = 0;

    for (let index = 1; index < path.length; index += 1) {
      const km = haversineKm(path[index - 1], path[index]);
      const samples = Math.max(1, Math.ceil(km / 10));

      for (const point of greatCircle(path[index - 1], path[index], samples).slice(1)) {
        const place = this.inside(point)?.place;

        if (place) countryKm.set(place.country, (countryKm.get(place.country) ?? 0) + km / samples);
        run = place ? 0 : run + km / samples;
        longestKm = Math.max(longestKm, run);
      }
    }

    return { longestKm, countryKm };
  }

  linked(one: number, other: number) {
    return this.links.has(pairKey(String(one), String(other)));
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
// Borders with no telecom link across them: Israel's with Lebanon and with Syria, Taiwan's
// with China - Kinmen sits a few kilometres off Xiamen, but no traffic transits that way -
// the fence round the US naval base at Guantanamo Bay, and Guyana's with Venezuela, which no
// road crosses either: Guyana's traffic leaves by its own cables, where chains to Georgetown
// had walked in from Venezuela's festoon. Natural Earth codes Taiwan CN-TW.
const NO_FIBRE_BORDERS = new Set(["IL|LB", "IL|SY", "CN|CN-TW", "CU|US", "GY|VE"]);
// Stations on ground held by a country other than the one the landing list files them under.
// Guantanamo Bay's cables, GTMO-1 and GTMO-PR, serve the naval base; filed under Cuba, they
// carried Havana's chains to Florida and Puerto Rico, where Cuba's traffic leaves on ALBA-1
// and ARIMAO.
const HELD_STATIONS = new Map([["Guantanamo Bay, Cuba", "US"]]);

function walkKey(a: number, b: number) {
  return `walk:${Math.min(a, b)}-${Math.max(a, b)}`;
}

function noLandRoute(a: Place, b: Place) {
  if (a.country === b.country) return false;
  if (SEA_ONLY_COUNTRIES.has(a.country) || SEA_ONLY_COUNTRIES.has(b.country)) return true;
  if (NO_FIBRE_BORDERS.has(pairKey(a.country, b.country))) return true;

  return NO_LAND_BETWEEN.has(pairKey(a.continent, b.continent));
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
  // A station the cable lists as one of its landings, sitting on the line's interior: the
  // line is drawn on through it to the next station (Tata TGN-Pacific passes Toyohashi on
  // its way to Emi), and a hop standing at it may board or leave the cable there.
  listed?: boolean;
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
// A hop this close to a station its cable lists but only passes through stands at that
// station, and boards there (Tata's Toyohashi routers, 0 km from Tata TGN-Pacific's
// Toyohashi station). Any farther and the station is just a point on the line: opened to
// every hop, Beverwijk drew Paris 436 km to Atlantic Crossing-1, and a Paris-Tallinn leg
// that had gone overland turned into a cable chain.
const AT_STATION_KM = 50;
// The grid cell a point falls in and the eight around it.
const NEIGHBOUR_CELLS = [-1, 0, 1].flatMap((dLat) => [-1, 0, 1].map((dLng) => [dLat, dLng] as const));
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
// A cable's run between two of its stations across a strait a fixed link spans, shorter than
// BRIDGE_KM, is no way through: the fibre crosses with the road. A chain took such a run to
// stitch walks between stations into a way round the bridge - New York to Marseille on the Cross
// Sound Cable, Miami to Malmö over the Great Belt and the Øresund on GlobalConnect's cables.
// Stations this close to the two ends of a link are on its two shores, whichever shore the
// coastline puts them on: it puts one of Klagshamn's on Zealand.
const LINK_END_KM = 30;
// A system at least this long reaches a piece of land from afar. An island where none lands
// has only its own links - Guernsey's, Jersey's, Bornholm's and the Isle of Man's, none over
// 550 km - and a chain passes through it only when a hop stands on it: London to Sao Paulo
// crossed to France on Guernsey's cables, and Warsaw's chains to the west hopped Bornholm.
// An island whose stations, and every station of every system landing there, are in one
// country is part of that country's own network all the same: Marajó, on the Norte Conectado
// river cables from Belém to Manaus.
const LONG_HAUL_KM = 1_000;
// Boarding or leaving a shorter system - a festoon, a strait's link, an island's own cable -
// costs this much on top of the distance, except in a country the leg starts or ends in, whose
// own links are its way in and out. Chains hopped such systems to shorten a walk: London's to
// Ukraine crossed to Norway and rode five North Sea and Baltic systems to Lithuania, where a
// Channel cable and the road is the way, and Asia's to Europe stitched the Maldives' own cables
// in between two long-haul systems that both pass them by.
const HANDOFF_KM = 200;
// Where an intercontinental system this long lands, carriers hand traffic from one system to
// another; where only regional systems do, a chain between two places both reached by such a
// system rides through without changing system. Brasilia to New York hopped Martinique and
// Saint Lucia on regional cables instead of taking GlobeNet by Bermuda. Where no chain keeps
// to that - Paramaribo meets the rest of the Caribbean only in Trinidad - the hand-off is made.
const INTERCONTINENTAL_KM = 5_000;
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
// Where only a cable can carry a leg, a chain walks at most the straight line; a leg no chain
// was found for gets a last try walking this share of it: Havana's traffic leaves Cuba on ALBA-1
// at Santiago de Cuba, the length of the island away, where production went through the fence of
// the Guantanamo Bay naval base.
const LAST_RESORT_WALK_SHARE = 1.5;
// How many times a chain that walks where the land cannot carry it is searched again without
// its walks. Where stations face each other across a strait on both sides - the Skagerrak, the
// Aegean islands, the Bahamas - each search finds the next pair. On a leg only a cable can carry
// the cheapest chain found is drawn when no search finds one that stays dry, so no such leg loses
// its chain - or a later one that crosses less water and walks no farther: Doha to a Dammam
// placed out in the Gulf walks 120 km of water off 2Africa, not 195 km from Al Khobar at the end
// of FALCON. One that walks farther is no better: from Singapore a later chain landed at Jeddah
// and walked 1,284 km across Arabia to cross 89 km of the Gulf rather than 195.
const WET_WALK_RETRIES = 24;
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
// Where land could carry a leg at least this long, a chain has that cable detour limit rather
// than the land's: from Copenhagen, Hong Kong is 10,300 km overland and 16,500 km round by
// Suez, and the traffic goes by sea. Shorter, the land usually wins - Mexico City to New York
// stays on land - and so it does within the Americas at any length, where a continent's own
// backbone runs its length: Vancouver to Miami goes overland, not round by Panama. So it does
// too for a leg to or from Russia that stays in Europe or Asia, on Russia's own backbone:
// Vladivostok to Bern went round by Japan and Suez, Mumbai to Moscow by the Black Sea's
// festoons. A Russian leg to Africa is not one of those - it goes to Europe by land and on by
// cable.
const LONG_LAND_LEG_KM = 4_000;
const LAND_CONTINENTS = new Set(["North America", "South America"]);
// A country no cable lands in, whose traffic crosses its land borders only: North Korea's goes to
// China Unicom at Dandong and to TransTeleCom at Khasan. A long leg to or from it keeps the
// land's budget: Mumbai to Pyongyang went round by Japan, Sakhalin and Vladivostok.
const LAND_ONLY_COUNTRIES = new Set(["KP"]);
// How far a European leg's overland way may run through Russia before it is a way through
// Russia. The corridors from Poland to the Baltic states cut across Kaliningrad for up to 200 km;
// Finland's way to the rest of Europe round by St Petersburg runs 450 km and more in Russia
// (measured on the city pairs of the decisions tests, September 2026).
const RUSSIA_TRANSIT_KM = 300;
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

// One search of the graph (decide): strict or not as INTERCONTINENTAL_KM has it, with or without
// the HANDOFF_KM surcharge, with the islands LONG_HAUL_KM closes open or not, and how far a chain
// may walk on a leg only a cable can carry, as a share of the straight line.
interface SearchPass {
  strict: boolean;
  surcharged: boolean;
  open: boolean;
  walkShare: number;
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
  // Each cable system's number, for the search state: which node, on which system.
  private readonly cableIds = new Map<string, number>();
  // Each cable system's length, all its lines together.
  private readonly cableKm = new Map<string, number>();
  // The pieces of land a long-haul system reaches, those an intercontinental one reaches, and
  // those whose stations and systems all stay in one country (LONG_HAUL_KM, INTERCONTINENTAL_KM).
  private readonly longHaul: Set<number>;
  private readonly intercontinental: Set<number>;
  private readonly domestic: Set<number>;
  // The systems shorter than LONG_HAUL_KM, by search number (HANDOFF_KM).
  private readonly shortSystems: Set<number>;
  // Each cable's owners, as operator keys, with the name the map gives them.
  private readonly owners = new Map<string, Array<{ key: string; name: string }>>();

  constructor(collection: { features: CableFeature[] }, mask?: LandMask, landings?: Landing[], land?: OverlandRouter) {
    this.mask = mask;
    this.land = land;
    // Which cables run through each interior vertex, and which stations each cable lists.
    const through = new Map<number, Set<string>>();
    const listed = new Map<string, Set<string>>();
    // Every line of every cable, vertex by vertex.
    const runs: Array<{ cable: string; ids: number[] }> = [];

    for (const feature of collection.features) {
      const ends: Array<{ id: number; line: number }> = [];
      const cells = new Map<string, Array<{ id: number; line: number }>>();
      const lines: Array<Array<{ id: number }>> = [];
      const cable = feature.properties?.name;

      if (cable && feature.properties?.landings) listed.set(cable, new Set(feature.properties.landings));
      if (cable) this.cableKm.set(cable, feature.geometry.coordinates.reduce((km, line) => km + pathKm(line.map(([lng, lat]): LatLng => [lat, lng])), this.cableKm.get(cable) ?? 0));

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
          else if (cable) through.set(id, (through.get(id) ?? new Set<string>()).add(cable));
          cells.set(gridKey(this.nodes[id], JOIN_CELL), [...(cells.get(gridKey(this.nodes[id], JOIN_CELL)) ?? []), entry]);

          if (previous !== undefined && previous !== id) {
            this.link(previous, id, true, undefined, feature.properties?.name);
          }

          if (previous !== id) ids.push({ id });
          previous = id;
        });

        lines.push(ids);
        if (cable && ids.length > 1) runs.push({ cable, ids: ids.map((entry) => entry.id) });
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
    this.nameListedStations(landings ?? [], through, listed);

    // A line's end is a station when an official landing point sits on it, or, failing
    // that, unless the same point is inside another line: then it is either a branching
    // unit at sea or a station a cable is drawn straight through (Busan sits inside a
    // Japan-China line), and the shore tells the two apart. A listed station on a line's
    // interior is not a station for the search at large, only a way on or off its cable for
    // a hop standing at it, but it needs its place for that.
    const byName = this.countryByName();

    this.nodes.forEach((node, id) => {
      const place = (node.end || node.listed) && mask ? mask.placeAt([node.lat, node.lng]) : undefined;
      node.landing = node.end && (node.name !== undefined || !node.interior || place !== undefined);

      if (node.landing || node.listed) {
        const country = byName.get(id);
        this.places.set(id, place && country && country !== place.country ? { ...place, country } : place);
      }
    });

    this.bridgeLandings();
    this.dropStraitRuns(runs);

    for (const [cable, ids] of this.cableEnds) {
      const countries = [...new Set(ids.flatMap((id) => (this.nodes[id].landing ? [this.places.get(id)?.country] : [])).filter((country): country is string => Boolean(country)))].sort(compareCode);
      const pair = countries.join("|");

      if (countries.length === 2 && NO_FIBRE_BORDERS.has(pair)) {
        this.closed.set(cable, pair);
      }
    }

    this.longHaul = this.landmassesReachedBy(LONG_HAUL_KM);
    this.intercontinental = this.landmassesReachedBy(INTERCONTINENTAL_KM);
    this.domestic = this.singleCountryLandmasses();
    this.shortSystems = this.systemsShorterThan(LONG_HAUL_KM);
  }

  private systemsShorterThan(km: number) {
    return new Set([...this.cableIds].filter(([cable]) => (this.cableKm.get(cable) ?? 0) < km).map(([, id]) => id));
  }

  // Cuts every run of a line between two consecutive stations that crosses a fixed link's strait
  // (LINK_END_KM) out of the graph.
  private dropStraitRuns(runs: Array<{ cable: string; ids: number[] }>) {
    const at = (id: number): LatLng => [this.nodes[id].lat, this.nodes[id].lng];
    const nearEnd = (id: number, end: LatLng) => haversineKm(at(id), end) <= LINK_END_KM;
    const acrossLink = (from: number, to: number, start: Place, end: Place) =>
      (start.island !== end.island && this.mask?.linked(start.island, end.island)) ||
      FIXED_LINKS.some(([one, other]) => (nearEnd(from, one) && nearEnd(to, other)) || (nearEnd(from, other) && nearEnd(to, one)));

    for (const { cable, ids } of runs) {
      let from = 0;
      let km = 0;

      for (let index = 1; index < ids.length; index += 1) {
        km += haversineKm(at(ids[index - 1]), at(ids[index]));
        const end = this.places.get(ids[index]);

        if (!end) continue;

        const start = this.places.get(ids[from]);

        if (start && km < BRIDGE_KM && acrossLink(ids[from], ids[index], start, end)) {
          for (let step = from + 1; step <= index; step += 1) this.unlink(ids[step - 1], ids[step], cable);
        }

        from = index;
        km = 0;
      }
    }
  }

  private unlink(a: number, b: number, cable: string) {
    this.nodes[a].edges = this.nodes[a].edges.filter((edge) => !(edge.sea && edge.cable === cable && edge.to === b));
    this.nodes[b].edges = this.nodes[b].edges.filter((edge) => !(edge.sea && edge.cable === cable && edge.to === a));
  }

  // The pieces of land where a system at least this long comes ashore.
  private landmassesReachedBy(minKm: number) {
    const reached = new Set<number>();

    for (const [id, place] of this.places) {
      if (place && this.nodes[id].edges.some((edge) => edge.sea && edge.cable !== undefined && (this.cableKm.get(edge.cable) ?? 0) >= minKm)) {
        reached.add(place.landmass);
      }
    }

    return reached;
  }

  // The pieces of land whose stations are all in one country, as are the stations of every
  // system that lands on them.
  private singleCountryLandmasses() {
    const landmassCountries = new Map<number, Set<string>>();
    const landmassCables = new Map<number, Set<string>>();
    const cableCountries = new Map<string, Set<string>>();

    for (const [id, place] of this.places) {
      if (!place) continue;

      landmassCountries.set(place.landmass, (landmassCountries.get(place.landmass) ?? new Set<string>()).add(place.country));

      for (const { sea, cable } of this.nodes[id].edges) {
        if (sea && cable) {
          landmassCables.set(place.landmass, (landmassCables.get(place.landmass) ?? new Set<string>()).add(cable));
          cableCountries.set(cable, (cableCountries.get(cable) ?? new Set<string>()).add(place.country));
        }
      }
    }

    const domestic = new Set<number>();

    for (const [landmass, cables] of landmassCables) {
      const [country = "", ...others] = landmassCountries.get(landmass) ?? [];
      const inCountry = (cable: string) => cableCountries.get(cable)?.size === 1 && cableCountries.get(cable)?.has(country) === true;

      if (others.length === 0 && [...cables].every(inCountry)) {
        domestic.add(landmass);
      }
    }

    return domestic;
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

  // Stations a cable lists as its landings but whose line only passes through them: the
  // nearest interior vertex of that cable within LANDING_MATCH_KM becomes a boarding point,
  // for a hop standing at it, named after the station. Only the cable's own list makes a passing line a landing; a
  // line drawn through another cable's station (Busan inside a Japan-China line) does not
  // land there, and that vertex stays a plain vertex.
  private nameListedStations(landings: Landing[], through: Map<number, Set<string>>, listed: Map<string, Set<string>>) {
    const cells = new Map<string, number[]>();

    for (const id of through.keys()) {
      if (!this.nodes[id].end) {
        const key = gridKey(this.nodes[id], 1);
        cells.set(key, [...(cells.get(key) ?? []), id]);
      }
    }

    for (const [name, lat, lng] of landings) {
      // Interior vertices within reach, nearest first: the first one each listing cable passes
      // through is where that cable lands at this station.
      const near = NEIGHBOUR_CELLS.flatMap(([dLat, dLng]) => cells.get(`${Math.floor(lat) + dLat},${Math.floor(lng) + dLng}`) ?? [])
        .map((id) => ({ id, km: haversineKm([lat, lng], [this.nodes[id].lat, this.nodes[id].lng]) }))
        .filter((entry) => entry.km <= LANDING_MATCH_KM)
        .sort((a, b) => a.km - b.km);
      const claimed = new Set<string>();

      for (const { id, km } of near) {
        const cables = [...(through.get(id) ?? [])].filter((cable) => !claimed.has(cable) && listed.get(cable)?.has(name));

        cables.forEach((cable) => claimed.add(cable));
        if (cables.length > 0) this.markListed(id, name, km);
      }
    }
  }

  private markListed(id: number, name: string, km: number) {
    const node = this.nodes[id];

    node.listed = true;

    if (km < (node.nameKm ?? Number.POSITIVE_INFINITY)) {
      node.name = name;
      node.nameKm = km;
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

    return new Map(named.map(({ id, country }) => [id, HELD_STATIONS.get(this.nodes[id].name ?? "") ?? codes.get(country)]));
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

    if (cable !== undefined && !this.cableIds.has(cable)) this.cableIds.set(cable, this.cableIds.size + 1);
    this.nodes[a].edges.push({ to: b, km, sea, cable });
    this.nodes[b].edges.push({ to: a, km, sea, cable });
  }

  // What it costs a hop to reach a landing station overland: the plain distance nearby, a
  // premium beyond that so a real sea route wins whenever one exists, nothing past a
  // continent's width.
  // What terrestrial fibre reaches from a hop: its own country's stations across the whole
  // piece of land (Los Angeles serves Miami), a neighbour's only nearby and over land
  // (Marseille serves Frankfurt; Shanghai does not serve Seoul across the Yellow Sea, nor
  // Myanmar across China). Within Europe borders are no barrier to terrestrial fibre and a
  // neighbour's stations serve as far as the land goes: Genoa serves Copenhagen, where Asia's
  // chains to Scandinavia went round by Bude, the Netherlands and Denmark's island cables.
  // Russia is not Europe here, though Natural Earth counts all of it as Europe, as far as the
  // Pacific. That reach is for a leg that leaves Europe or crosses to one of its islands; between
  // two places on the continent itself the land carries the leg, and a station a continent away
  // is no way off it (europeReach): Seville to Rome went round by Morocco and Marseille, Warsaw
  // to Tallinn on Kaliningrad's cables. Without the coastline, distance alone decides.
  private attachmentCost(point: LatLng, place: Place | undefined, id: number, europeReach = true) {
    const node = this.nodes[id];

    if (!node.landing && !(node.listed && haversineKm(point, [node.lat, node.lng]) <= AT_STATION_KM)) {
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

      const european = europeReach && place.continent === "Europe" && station.continent === "Europe" && place.country !== "RU" && station.country !== "RU";

      if (station.country !== place.country && (noLandRoute(place, station) || (!european && km > LANDING_RADIUS_KM) || !this.mask.overland(point, [node.lat, node.lng]))) {
        return undefined;
      }

      return { km, cost: km * (station.country === place.country ? LAND_PENALTY : FOREIGN_LAND_PENALTY) };
    }

    return { km, cost: km * LAND_PENALTY };
  }

  // The walks of a chain the land cannot carry: more open water on the straight line than a
  // bridge spans, and no corridor round it for the overland drawing to follow. With them the
  // most water one crosses, and whether the chain sailed past a station it could have walked
  // off dry to go and walk across the sea further on: Cincinnati to Nassau called at Nassau and
  // sailed on round Eleuthera, only for the sea it covered, then walked from Governors Harbour
  // to Andros - where production, finding no chain, drew the straight line.
  private wetWalks(from: LatLng, to: LatLng, toPlace: Place | undefined, ids: number[], sea: boolean[], europeReach: boolean) {
    const mask = this.mask;

    if (!mask || !this.land) {
      return undefined;
    }

    const at = (id: number): LatLng => [this.nodes[id].lat, this.nodes[id].lng];
    const water = (a: LatLng, b: LatLng) => {
      const km = mask.waterAlong(a, b).longestKm;

      return km >= SEA_CROSSING_KM && this.overland(a, b).length <= 2 ? km : 0;
    };
    const last = ids.length - 1;
    // Each walk with where it ends in the chain: the start walk at 0, the exit past the end.
    const walks = [
      { key: `start:${ids[0]}`, at: 0, km: water(from, at(ids[0])) },
      ...ids.slice(1).map((id, index) => ({ key: walkKey(ids[index], id), at: index + 1, km: sea[index + 1] ? 0 : water(at(ids[index]), at(id)) })),
      { key: `exit:${ids[last]}`, at: last + 1, km: water(at(ids[last]), to) }
    ].filter((walk) => walk.km > 0);

    if (walks.length === 0) {
      return undefined;
    }

    const lastWet = Math.max(...walks.map((walk) => walk.at));
    const dryExit = (id: number) => this.attachmentCost(to, toPlace, id, europeReach) !== undefined && water(at(id), to) === 0;

    const walked = haversineKm(from, at(ids[0])) + haversineKm(at(ids[last]), to) + ids.slice(1).reduce((sum, id, index) => sum + (sea[index + 1] ? 0 : haversineKm(at(ids[index]), at(id))), 0);

    // Asked only of a chain that would be kept: each station's exit walk may need a land path.
    return { keys: walks.map((walk) => walk.key), km: Math.max(...walks.map((walk) => walk.km)), walked, roundabout: () => ids.slice(0, Math.min(lastWet, last)).some(dryExit) };
  }

  // The piece of land a station stands on, unless one of the leg's hops stands on it too.
  private transitLandmass(id: number, from: Place | undefined, to: Place | undefined) {
    const landmass = this.places.get(id)?.landmass;

    return landmass === from?.landmass || landmass === to?.landmass ? undefined : landmass;
  }

  // Every landing station a hop can reach, dearest last. The whole reachable set goes into
  // the search: the right station for Seoul to Miami is Los Angeles, which no shortlist of
  // the stations nearest Miami would ever include.
  private landingsNear(point: LatLng, place: Place | undefined, europeReach = true) {
    return this.nodes
      .map((_node, id) => {
        const reach = this.attachmentCost(point, place, id, europeReach);

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
        const base = samples.at(-1)?.km ?? 0;

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
      let piece = pieces[0];

      samples.forEach((sample, index) => {
        if (index === 0) return;

        if (cuts.has(index)) {
          piece.path.push(sample.point);
          piece = { land: !piece.land, path: [sample.point] };
          pieces.push(piece);
        } else if (sample.vertex) {
          piece.path.push(sample.point);
        }
      });

      const kept = pieces.filter((piece) => piece.path.length > 1);
      // A station is a vertex of the line, so it lands in exactly the piece that kept it.
      const onPiece = (path: LatLng[]) => segment.via?.filter((station) => path.some((point) => point[0] === station.at[0] && point[1] === station.at[1]));

      return kept.map((piece, index) =>
        piece.land
          ? { path: piece.path, sea: false, cables: segment.cables, terrestrial: true, via: onPiece(piece.path) }
          : { path: piece.path, sea: true, cables: segment.cables, from: index === 0 ? segment.from : undefined, to: index === kept.length - 1 ? segment.to : undefined, via: onPiece(piece.path) }
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

    const landPath = landPossible ? this.overland(from, to) : [];
    const fallback: LegDecision = landPossible
      ? { kind: "land", path: landPath, evidence: [...why, { code: "no_chain_within", ratio: LAND_ALTERNATIVE_RATIO, rttMs: measured }, { code: "land_assumed" }] }
      : { kind: "unrouted", crossingKm: Math.round(water.longestKm), evidence: [...why, { code: "no_chain_found" }] };
    const owned = this.ownedCables(options.operators ?? []);
    // A cable between two countries whose border carries no transit is open to a leg
    // between those two countries and closed to every other.
    const legPair = fromPlace && toPlace ? pairKey(fromPlace.country, toPlace.country) : undefined;
    const inEurope = (place: Place | undefined) => place?.continent === "Europe" && place.country !== "RU";
    // The land carries a leg across a stretch of sea only where the land goes round it. A way that
    // crosses more open water than a bridge spans cuts straight across - Dortmund to Algiers was
    // drawn over the Mediterranean where production rode Blue and Med Cable - and within Europe
    // one through Russia between two other countries (RUSSIA_TRANSIT_KM) is no way either:
    // Helsinki to Marseille, which production drew on C-Lion1, went by land across the Baltic, and
    // round by St Petersburg once the ferries were out of the corridors. Such a leg is searched as
    // one only a cable can carry, the land drawn only when no chain is found. Without the
    // corridors there is only the straight line, which says nothing of where the land goes.
    const across = this.land && landPossible && !bridged ? this.mask?.alongPath(landPath) : undefined;
    const european = fromPlace?.continent === "Europe" && toPlace?.continent === "Europe" && fromPlace.country !== "RU" && toPlace.country !== "RU";
    const throughRussia = european && (across?.countryKm.get("RU") ?? 0) > RUSSIA_TRANSIT_KM;
    const landCarries = landPossible && !(across && (across.longestKm >= SEA_CROSSING_KM || throughRussia));
    const europeReach = !(landCarries && inEurope(fromPlace) && inEurope(toPlace));
    // Within Europe a chain changes system only at a station in a country the leg starts or ends
    // in. It still boards where the land took it and leaves where the land takes it on - Paris to
    // Helsinki boards C-Lion1 at Rostock, and Helsinki to Paris leaves it there - but a change on
    // a third country's shore is where the land would have carried the traffic instead: Frankfurt
    // to Stockholm changed at Hanko, Oslo to Frankfurt at Blaabjerg, Warsaw to Tallinn at Logi.
    // A chain that has left a system on such a shore walks on (the second plane of states).
    const withinEurope = landCarries && fromPlace?.continent === "Europe" && toPlace?.continent === "Europe";
    const starts = this.landingsNear(from, fromPlace, europeReach).slice(0, LANDING_CANDIDATES * 8);

    if (starts.length === 0) {
      return fallback;
    }

    // How far round a chain may go. Off the landmass any chain short of a wild detour beats
    // a line across open water; where land could carry the leg, only a chain close to the
    // straight line, and short enough for the latency measured, beats the land - unless the
    // leg is a long one that land rarely carries (LONG_LAND_LEG_KM).
    const russian = (fromPlace?.country === "RU" || toPlace?.country === "RU") && fromPlace?.continent !== "Africa" && toPlace?.continent !== "Africa";
    const landOnly = LAND_ONLY_COUNTRIES.has(fromPlace?.country ?? "") || LAND_ONLY_COUNTRIES.has(toPlace?.country ?? "");
    const landBudget = landCarries && (direct < LONG_LAND_LEG_KM || LAND_CONTINENTS.has(fromPlace?.continent ?? "") || russian || landOnly);
    let budget = landBudget ? direct * LAND_ALTERNATIVE_RATIO + LAND_ALTERNATIVE_SLACK_KM : direct * MAX_DETOUR_RATIO + MAX_DETOUR_SLACK_KM;

    if (landPossible && options.rttMs !== undefined && options.rttMs >= MIN_RTT_EVIDENCE_MS) {
      budget = Math.min(budget, options.rttMs * FIBRE_KM_PER_RTT_MS * RTT_SLACK);
    }

    // The search orders chains by cost, overland kilometres at a premium; the detour and
    // latency limits, and the share of the way at sea, are on the kilometres as travelled.
    // A search state is a node and the system the chain is riding there (0 when it is not on
    // one: at the start, or after a walk between stations). Two systems whose drawn lines
    // share a point at sea do not meet there - a cable is joined to another only in a landing
    // station - so the chain changes system only at a named station, never at such a point.
    // Keyed by node alone, a third of all cable legs changed system mid-ocean.
    const stride = this.cableIds.size + 1;
    const plane = this.nodes.length * stride;
    const nodeOf = (state: number) => Math.floor((state % plane) / stride);
    const cost = new Map<number, number>();
    const travelled = new Map<number, number>();
    const seaKm = new Map<number, number>();
    const cameFrom = new Map<number, number>();
    const cameBy = new Map<number, { sea: boolean; cable?: string }>();
    const heap = new MinHeap();
    let best: { node: number; cost: number } | undefined;
    // Between two places an intercontinental system reaches, the first pass keeps chains from
    // changing system on islands only regional systems reach; with no chain that way, a second
    // pass allows it (INTERCONTINENTAL_KM).
    const strictFirst = fromPlace && toPlace && this.intercontinental.has(fromPlace.landmass) && this.intercontinental.has(toPlace.landmass);
    // The hand-off surcharge first, and without it only when no chain was found with it, so that
    // it changes which chain is drawn and never whether one is.
    const plain: SearchPass = { strict: false, surcharged: false, open: false, walkShare: 1 };
    // Between South America and Asia or Oceania the traffic crosses North America by land and
    // the Pacific by cable - traces from Sao Paulo to Sydney, Singapore and Taipei, and back from
    // Sydney, Taipei and Manila, all run by Miami or New York and Los Angeles (September 2026). A
    // chain cannot walk across a continent between two of its systems, so the Caribbean coast to
    // Panama stands in for that crossing, and the preferences against regional systems sent these
    // legs round by Suez instead: the plain search draws them.
    const continents = new Set([fromPlace?.continent, toPlace?.continent]);
    const acrossPacific = continents.has("South America") && (continents.has("Asia") || continents.has("Oceania"));
    const withSurcharge: SearchPass[] = strictFirst ? [{ ...plain, strict: true, surcharged: true }, { ...plain, surcharged: true }, { ...plain, strict: true }] : [{ ...plain, surcharged: true }];
    const preferred = acrossPacific ? [] : withSurcharge;
    // Where land could carry the leg, the plain search alone says whether a chain beats it, as it
    // always has, and the others only choose which chain is drawn: each was one more chance to find
    // a chain, and the land lost legs it should keep - Warsaw to Tallinn on Kaliningrad's cables,
    // Riga to Brussels on seven festoons. Where only a cable can, the last passes are for a leg no
    // chain was found for: with the islands LONG_HAUL_KM closes open again (Rennes to Cardiff by
    // the Channel Islands, as production draws it), then walking further (LAST_RESORT_WALK_SHARE).
    const passes: SearchPass[] = landCarries
      ? [plain, ...preferred]
      : [...preferred, plain, { ...plain, open: true }, { ...plain, open: true, walkShare: LAST_RESORT_WALK_SHARE }];
    // The plain pass's chain on a leg land could carry, drawn when no preferred pass finds one.
    let decided: { best: { node: number; cost: number }; cameFrom: Map<number, number>; cameBy: Map<number, { sea: boolean; cable?: string }> } | undefined;
    // A chain that walks across open water no corridor goes round - from Gedser to Kolobrzeg,
    // Belgrade to Bari, across the Bristol Channel - loses that walk, and the pass that found it
    // runs again (WET_WALK_RETRIES); an earlier pass found nothing and would find nothing now.
    // The walks it may not take, and the chain to draw if none stays dry: the cheapest, or a
    // later one that crosses less water and walks no farther, with only its own states kept.
    const banned = new Set<string>();
    let kept: (NonNullable<typeof decided> & { km: number; walked: number }) | undefined;
    let retries = 0;
    const chainOf = (end: number) => {
      const states: number[] = [];

      for (let state: number | undefined = end; state !== undefined; state = cameFrom.get(state)) {
        states.push(state);
      }

      return states.reverse();
    };
    let index = 0;

    while (index < passes.length) {
      const { strict, surcharged, open, walkShare } = passes[index];
      const surcharge = surcharged ? HANDOFF_KM : 0;

      index += 1;

      // A pass that found its chain stops with states still queued.
      while (heap.size > 0) heap.pop();
      cost.clear();
      travelled.clear();
      seaKm.clear();
      cameFrom.clear();
      cameBy.clear();

      for (const start of starts.filter(({ id }) => !banned.has(`start:${id}`))) {
        const state = start.id * stride;

        cost.set(state, start.cost);
        travelled.set(state, start.km);
        seaKm.set(state, 0);
        heap.push(start.cost, state);
      }

      while (heap.size > 0) {
        const current = heap.pop();
        const node = nodeOf(current.node);
        const riding = current.node % stride;
        const walkingOn = current.node >= plane;
        const soFar = travelled.get(current.node) ?? 0;

        if (current.cost > (cost.get(current.node) ?? Number.POSITIVE_INFINITY) || soFar > budget) {
          continue;
        }

        if (current.cost > (best?.cost ?? Number.POSITIVE_INFINITY)) {
          break;
        }

        const exit = banned.has(`exit:${node}`) ? undefined : this.attachmentCost(to, toPlace, node, europeReach);
        // A regional system's station in one of the leg's own countries is that country's link.
        const stationCountry = this.places.get(node)?.country;
        const atEndpoint = stationCountry !== undefined && (stationCountry === fromPlace?.country || stationCountry === toPlace?.country);

        if (exit !== undefined) {
          const total = current.cost + exit.cost + (this.shortSystems.has(riding) && !atEndpoint ? surcharge : 0);
          const atSea = seaKm.get(current.node) ?? 0;

          // A chain that walks farther overland than the whole straight line is not a way
          // across the water; it is a way round it, along some coast's own cable. Where land
          // could carry the leg, a chain also has to be mostly sea to be worth more than the
          // land; off the landmass any crossing is the crossing there is, however short
          // (London to Karlsruhe crosses the Channel once, over a few dozen kilometres).
          if (
            soFar + exit.km <= budget &&
            soFar - atSea + exit.km <= direct * (landCarries ? MAX_WALK_SHARE : walkShare) &&
            atSea >= (landCarries ? direct * MIN_SEA_SHARE : 0) &&
            atSea >= water.longestKm * MIN_CROSSING_COVER &&
            (!best || total < best.cost)
          ) {
            best = { node: current.node, cost: total };
          }
        }

        // A station on a piece of land neither hop stands on: a way through only as
        // LONG_HAUL_KM allows and, on a strict pass where no intercontinental system lands,
        // only without a change of system.
        const island = this.transitLandmass(node, fromPlace, toPlace);

        if (!open && island !== undefined && !this.longHaul.has(island) && !this.domestic.has(island)) {
          continue;
        }

        const throughOnly = strict && island !== undefined && !this.intercontinental.has(island);

        for (const edge of this.nodes[node].edges) {
          if ((edge.cable && this.closed.has(edge.cable) && this.closed.get(edge.cable) !== legPair) || (!edge.sea && banned.has(walkKey(node, edge.to)))) {
            continue;
          }

          const system = edge.sea && edge.cable ? (this.cableIds.get(edge.cable) ?? 0) : 0;
          const handoff = !atEndpoint && system !== riding && (this.shortSystems.has(riding) || this.shortSystems.has(system)) ? surcharge : 0;
          const atSeaCost = edge.cable && owned.has(edge.cable) ? edge.km * OWNED_DISCOUNT : edge.km;
          const next = current.cost + handoff + (edge.sea ? atSeaCost : edge.km * BRIDGE_PENALTY);

          if (riding !== 0 && system !== 0 && system !== riding && this.nodes[node].name === undefined) {
            continue;
          }

          if (throughOnly && (system === 0 || system !== riding)) {
            continue;
          }

          const leaving = withinEurope && !atEndpoint && riding !== 0 && system !== riding;

          if ((leaving && system !== 0) || (walkingOn && system !== 0 && system !== riding)) {
            continue;
          }

          const state = (walkingOn || leaving ? plane : 0) + edge.to * stride + system;

          if (next < (cost.get(state) ?? Number.POSITIVE_INFINITY)) {
            cost.set(state, next);
            travelled.set(state, soFar + edge.km);
            seaKm.set(state, (seaKm.get(current.node) ?? 0) + (edge.sea ? edge.km : 0));
            cameFrom.set(state, current.node);
            cameBy.set(state, { sea: edge.sea, cable: edge.cable });
            heap.push(next, state);
          }
        }
      }

      const chain = best ? chainOf(best.node) : [];
      const wet = chain.length > 0 ? this.wetWalks(from, to, toPlace, chain.map(nodeOf), chain.map((state) => cameBy.get(state)?.sea ?? false), europeReach) : undefined;

      if (best && wet) {
        if (wet.km < (kept?.km ?? Number.POSITIVE_INFINITY) && wet.walked <= (kept?.walked ?? Number.POSITIVE_INFINITY) && !wet.roundabout()) {
          kept = {
            km: wet.km,
            walked: wet.walked,
            best,
            cameFrom: new Map(chain.slice(1).map((state, step) => [state, chain[step]])),
            cameBy: new Map(chain.map((state) => [state, cameBy.get(state) ?? { sea: false }]))
          };
        }

        best = undefined;

        if (retries < WET_WALK_RETRIES) {
          wet.keys.forEach((walk) => banned.add(walk));
          retries += 1;
          index -= 1;
          continue;
        }
      }

      if (landCarries && !decided) {
        if (!best) break;
        decided = { best, cameFrom: new Map(cameFrom), cameBy: new Map(cameBy) };
        best = undefined;
        continue;
      }

      if (best) break;
    }

    // Where the land carries the leg it is the way when every chain found walked across the sea.
    const keptChain = landCarries ? undefined : kept;
    const drawn = best ? undefined : (decided ?? keptChain);

    if (drawn) {
      best = drawn.best;
      cameFrom.clear();
      cameBy.clear();
      drawn.cameFrom.forEach((value, key) => cameFrom.set(key, value));
      drawn.cameBy.forEach((value, key) => cameBy.set(key, value));
    }

    if (!best) {
      return fallback;
    }

    const states = chainOf(best.node);
    const ids = states.map(nodeOf);
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
      const by = cameBy.get(states[index]) ?? { sea: false };
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

      const station = name(ids[index]);

      if (station) (current.via ??= []).push({ name: station, at: point });

      if (by.sea && by.cable) {
        ridden.set(by.cable, (ridden.get(by.cable) ?? 0) + haversineKm(at(ids[index - 1]), point));
      }
    }

    const lastId = ids.at(-1) ?? ids[0];

    if (current.sea) {
      close();
      current = { path: this.overland(at(lastId), to), sea: false, cables: [], from: name(lastId) };
    } else {
      current.path.push(...this.overland(at(lastId), to).slice(1));
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
