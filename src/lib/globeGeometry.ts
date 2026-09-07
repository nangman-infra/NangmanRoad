// Geometry for the globe's static layers - the cable lines and the city lights - computed
// once per page from the map data, ahead of time and away from the globe itself, so that
// opening the globe only uploads ready-made buffers instead of building them while the
// visitor waits. Uses three-globe's own lat/lng mapping, so the buffers land exactly where
// its getCoords would put them.
import { LandMask, haversineKm, type LatLng } from "./cableRouting";
import { loadMapData } from "./mapData";

export const GLOBE_RADIUS = 100;
// Above the land polygons (0.006): the coarse 1:110m coastline covers near-shore water in
// places, and a cable under it looked cut wherever the shore was drawn too generously.
export const CABLE_ALTITUDE = 0.008;
// Above the land polygons (0.006), below the route (0.014): lights sit on the ground, not
// under it.
export const CITY_ALTITUDE = 0.0095;
// A straight segment between two far-apart vertices is a chord through the sphere, and its
// middle sinks under the surface; long ones are resampled onto the surface this finely.
// Resampled in latitude and longitude, not along the great circle: the source draws its
// lines straight in those, and a branch that meets its trunk in the source meets the
// drawn trunk only if the drawn trunk keeps the source's straight run.
export const CABLE_STEP_DEGREES = 1;
// The source data does not always put a branching unit on its trunk, or the two lines of
// one cable at the same point of a landing station; without joins a cable looks cut at
// every such place once the globe is zoomed in. An end joins the nearest point of another
// line of the same cable when it is close, when that point is the other line's end (the
// same station), or - at sea, where a line can only be reaching its trunk - up to further.
const JOIN_NEAR_KM = 25;
const JOIN_END_KM = 60;
const JOIN_SEA_KM = 120;

export interface LineGeometry {
  positions: Float32Array;
  colors: Float32Array;
}

export interface LightGeometry {
  positions: Float32Array;
  sizes: Float32Array;
}

export interface CityGeometry {
  core: LightGeometry;
  halo: LightGeometry;
}

interface CableCollection {
  features: Array<{ properties: { color?: string }; geometry: { coordinates: number[][][] } }>;
}

interface City {
  lat: number;
  lng: number;
  // Thousands of people.
  pop: number;
}

export function toCartesian(lat: number, lng: number, altitude: number): [number, number, number] {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((90 - lng) * Math.PI) / 180;
  const r = GLOBE_RADIUS * (1 + altitude);

  return [r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta)];
}

// three's colour management reads vertex colours as linear; the palette is sRGB.
export function linearRgb(hex: string): [number, number, number] {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;

    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };

  return [channel(1), channel(3), channel(5)];
}

// Planar distance from a point to a segment, in km, with longitude scaled for the latitude,
// and the point of the segment nearest to it.
function segmentKm(point: LatLng, a: LatLng, b: LatLng): { km: number; at: LatLng } {
  const scale = Math.cos((point[0] * Math.PI) / 180);
  const ax = (a[1] - point[1]) * scale;
  const ay = a[0] - point[0];
  const bx = (b[1] - point[1]) * scale;
  const by = b[0] - point[0];
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;

  return { km: Math.hypot(ax + t * dx, ay + t * dy) * 111.2, at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
}

// Lines shorter than this are debris at any zoom the globe allows: a few kilometres of
// spur near a branching unit, invisible from afar and a stray tick up close.
const MIN_LINE_KM = 40;

interface Junction {
  line: number;
  end: LatLng;
  at: LatLng;
  km: number;
  isEnd: boolean;
}

// For every line end, the nearest point of another line of the same cable within reach.
function nearestJunctions(lines: LatLng[][]): Junction[] {
  const found: Junction[] = [];
  const reach = JOIN_SEA_KM / 111.2 + 0.5;

  lines.forEach((line, index) => {
    for (const end of [line[0], line.at(-1)]) {
      if (!end || Math.abs(end[1]) >= 179.9) continue;

      let nearest: { km: number; at: LatLng; isEnd: boolean } | undefined;

      lines.forEach((other, otherIndex) => {
        if (otherIndex === index) return;

        for (let position = 0; position < other.length; position += 1) {
          const vertex = other[position];

          // A segment counts when the end lies within reach of the segment's own bounds:
          // a trunk crossing an ocean in one stroke has no vertex anywhere near the branch
          // that meets it halfway.
          if (position > 0) {
            const previous = other[position - 1];

            if (
              end[0] >= Math.min(previous[0], vertex[0]) - reach &&
              end[0] <= Math.max(previous[0], vertex[0]) + reach &&
              end[1] >= Math.min(previous[1], vertex[1]) - reach &&
              end[1] <= Math.max(previous[1], vertex[1]) + reach
            ) {
              const candidate = segmentKm(end, previous, vertex);

              if (candidate.km > 0.01 && (!nearest || candidate.km < nearest.km)) {
                nearest = { ...candidate, isEnd: false };
              }
            }
          }

          if ((position === 0 || position === other.length - 1) && Math.abs(vertex[0] - end[0]) <= reach && Math.abs(vertex[1] - end[1]) <= reach) {
            const km = haversineKm(end, vertex);

            if (km > 0.01 && (!nearest || km <= nearest.km)) {
              nearest = { km, at: vertex, isEnd: true };
            }
          }
        }
      });

      if (nearest) found.push({ line: index, end, ...nearest });
    }
  });

  return found;
}

function lineKm(line: LatLng[]) {
  return line.reduce((sum, point, index) => (index === 0 ? sum : sum + haversineKm(line[index - 1], point)), 0);
}

// Which lines of a cable to draw, and the short segments that close the gaps between
// them. A line goes when it is debris, or when an end of it lies at sea with nothing of
// the cable to join; joins only run between lines that stay, and dropping a line can
// leave another with nothing to join, so it settles in rounds.
function cableLayout(lines: LatLng[][], mask: LandMask): { keep: Set<number>; joins: Array<[LatLng, LatLng]> } {
  const keep = new Set(lines.map((_line, index) => index).filter((index) => lineKm(lines[index]) >= MIN_LINE_KM));
  const junctions = nearestJunctions(lines);
  const coincident = (index: number, end: LatLng) =>
    lines.some((other, otherIndex) => otherIndex !== index && keep.has(otherIndex) && other.some((vertex) => Math.abs(vertex[0] - end[0]) < 0.001 && Math.abs(vertex[1] - end[1]) < 0.001));
  const onLine = (point: LatLng) => lines.findIndex((line, index) => keep.has(index) && line.some((vertex) => Math.abs(vertex[0] - point[0]) < 0.001 && Math.abs(vertex[1] - point[1]) < 0.001));

  for (let round = 0; round < 4; round += 1) {
    let changed = false;

    for (const index of [...keep]) {
      const line = lines[index];

      for (const end of [line[0], line.at(-1)]) {
        if (!end || Math.abs(end[1]) >= 179.9 || coincident(index, end)) continue;

        const junction = junctions.find((entry) => entry.line === index && entry.end === end);
        const target = junction ? onLine(junction.at) : -1;
        const joinable =
          junction !== undefined &&
          (target >= 0 || !junction.isEnd) &&
          keepsTarget(junction, lines, keep) &&
          (junction.km <= JOIN_NEAR_KM || (junction.isEnd && junction.km <= JOIN_END_KM) || (!mask.onLand(end) && junction.km <= JOIN_SEA_KM));

        if (!joinable && mask.placeAt(end) === undefined) {
          keep.delete(index);
          changed = true;
          break;
        }
      }
    }

    if (!changed) break;
  }

  const joins: Array<[LatLng, LatLng]> = [];

  for (const junction of junctions) {
    if (!keep.has(junction.line) || !keepsTarget(junction, lines, keep)) continue;

    const end = junction.end;
    const joinable = junction.km <= JOIN_NEAR_KM || (junction.isEnd && junction.km <= JOIN_END_KM) || (!mask.onLand(end) && junction.km <= JOIN_SEA_KM);

    if (joinable) joins.push([end, junction.at]);
  }

  return { keep, joins };
}

// Whether the line a junction lands on is still drawn.
function keepsTarget(junction: Junction, lines: LatLng[][], keep: Set<number>) {
  const reach = 0.02;

  return lines.some(
    (line, index) =>
      index !== junction.line &&
      keep.has(index) &&
      line.some((vertex, position) => {
        if (Math.abs(vertex[0] - junction.at[0]) < 0.001 && Math.abs(vertex[1] - junction.at[1]) < 0.001) return true;
        if (position === 0) return false;

        const previous = line[position - 1];

        return (
          junction.at[0] >= Math.min(previous[0], vertex[0]) - reach &&
          junction.at[0] <= Math.max(previous[0], vertex[0]) + reach &&
          junction.at[1] >= Math.min(previous[1], vertex[1]) - reach &&
          junction.at[1] <= Math.max(previous[1], vertex[1]) + reach &&
          segmentKm(junction.at, previous, vertex).km < 1
        );
      })
  );
}

// Points along the source's straight lat/lng run between two vertices, at most `step`
// degrees apart, so the run sits on the sphere instead of cutting through it.
export function straightRun(a: LatLng, b: LatLng, step: number): LatLng[] {
  const pieces = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / step));

  return Array.from({ length: pieces + 1 }, (_value, index) => {
    const t = index / pieces;

    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] as LatLng;
  });
}

function buildCables(collection: CableCollection, mask: LandMask): LineGeometry {
  const positions: number[] = [];
  const colors: number[] = [];

  for (const feature of collection.features) {
    const color = linearRgb(/^#[0-9a-f]{6}$/i.test(feature.properties.color ?? "") ? (feature.properties.color as string) : "#5ee7ff");
    const lines: LatLng[][] = feature.geometry.coordinates.map((line) => line.map(([lng, lat]) => [lat, lng]));
    const layout = cableLayout(lines, mask);

    for (const [from, to] of layout.joins) {
      positions.push(...toCartesian(from[0], from[1], CABLE_ALTITUDE), ...toCartesian(to[0], to[1], CABLE_ALTITUDE));
      colors.push(...color, ...color);
    }

    for (const [index, vertices] of lines.entries()) {
      if (!layout.keep.has(index)) continue;

      const curve = vertices.flatMap((vertex, index) => (index === 0 ? [vertex] : straightRun(vertices[index - 1], vertex, CABLE_STEP_DEGREES).slice(1)));
      let previous: [number, number, number] | undefined;

      for (const [lat, lng] of curve) {
        const point = toCartesian(lat, lng, CABLE_ALTITUDE);

        if (previous) {
          positions.push(...previous, ...point);
          colors.push(...color, ...color);
        }

        previous = point;
      }
    }
  }

  return { positions: new Float32Array(positions), colors: new Float32Array(colors) };
}

// Every populated place, a point sized by population; the million-plus cities also get a
// wide halo. Real places only - the density of Europe, India or the US east coast comes
// from the data, not from scattered fakes.
function buildCities(cities: City[]): CityGeometry {
  const core = { positions: [] as number[], sizes: [] as number[] };
  const halo = { positions: [] as number[], sizes: [] as number[] };

  for (const city of cities) {
    const size = 1.2 + 1.1 * Math.log10(Math.max(1, city.pop));
    const position = toCartesian(city.lat, city.lng, CITY_ALTITUDE);
    core.positions.push(...position);
    core.sizes.push(size);

    if (city.pop >= 1000) {
      halo.positions.push(...position);
      halo.sizes.push(size * 2.2);
    }
  }

  return {
    core: { positions: new Float32Array(core.positions), sizes: new Float32Array(core.sizes) },
    halo: { positions: new Float32Array(halo.positions), sizes: new Float32Array(halo.sizes) }
  };
}

let cablePromise: Promise<LineGeometry> | undefined;
let cityPromise: Promise<CityGeometry> | undefined;

export function cableGeometry() {
  cablePromise ??= Promise.all([loadMapData<CableCollection>("cables"), loadMapData<ConstructorParameters<typeof LandMask>[0]>("countries")]).then(
    ([cables, countries]) => buildCables(cables, new LandMask(countries))
  );

  return cablePromise;
}

export function cityGeometry() {
  cityPromise ??= loadMapData<{ cities: City[] }>("cities").then((collection) => buildCities(collection.cities));

  return cityPromise;
}
