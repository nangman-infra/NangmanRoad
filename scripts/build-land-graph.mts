// Builds public/data/land.json: the corridors an overland stretch of a route is drawn
// along. Fibre runs where roads and railways run, so the graph is Natural Earth's 1:10m
// roads and railroads (public domain), their vertices snapped to a coarse grid so that
// crossings join, plus every 100,000+ place, landing station and a sparse grid of
// waypoints where no road comes near, each tied to its nearest road over land.
//   1. download and convert (once):
//        npx mapshaper ne_10m_roads.shp -filter 'type != "Ferry Route"' -simplify 25% keep-shapes -o format=geojson precision=0.001 roads.json
//        npx mapshaper ne_10m_railroads.shp -simplify 25% keep-shapes -o format=geojson precision=0.001 rails.json
//   2. npx tsx scripts/build-land-graph.mts roads.json rails.json
import { readFileSync, writeFileSync } from "node:fs";
import { LandMask, haversineKm, type LatLng } from "../src/lib/cableRouting";

const root = new URL("../public/data/", import.meta.url);
const read = (file: string) => JSON.parse(readFileSync(file.startsWith("/") ? file : new URL(file, root), "utf8"));
const [roadsFile, railsFile] = process.argv.slice(2);

if (!roadsFile || !railsFile) {
  console.error("usage: npx tsx scripts/build-land-graph.mts roads.json rails.json");
  process.exit(1);
}

const mask = new LandMask(read("countries.json"));
// Vertices this close are one crossing.
const SNAP_DEGREES = Number(process.env.LAND_SNAP ?? 0.3);
// Ties from a place to the road network, and between places where no road comes.
const TIE_KM = 120;
const FALLBACK_EDGE_KM = 900;
const FALLBACK_NEIGHBOURS = 5;
const GRID_DEGREES = 3;
const GRID_CLEARANCE_KM = 300;
const SEA_CROSSING_KM = 60;
const CELL = 2;
const SKIP_TYPES = new Set(["Ferry Route", "Ferry, seasonal", "Track"]);

const started = Date.now();
const nodes: LatLng[] = [];
const index = new Map<string, number>();
const cells = new Map<string, number[]>();
const edges = new Map<string, number>();
const cellOf = (point: LatLng) => `${Math.floor(point[0] / CELL)},${Math.floor(point[1] / CELL)}`;

function node(point: LatLng) {
  const key = `${Math.round(point[0] / SNAP_DEGREES)},${Math.round(point[1] / SNAP_DEGREES)}`;
  let id = index.get(key);

  if (id === undefined) {
    id = nodes.push([Math.round(point[0] * 100) / 100, Math.round(point[1] * 100) / 100]) - 1;
    index.set(key, id);
    cells.set(cellOf(point), [...(cells.get(cellOf(point)) ?? []), id]);
  }

  return id;
}

function link(a: number, b: number) {
  if (a === b) return;
  const key = a < b ? `${a}-${b}` : `${b}-${a}`;
  if (!edges.has(key)) edges.set(key, Math.round(haversineKm(nodes[a], nodes[b])));
}

function around(point: LatLng, km: number) {
  const reach = Math.ceil(km / (CELL * 100)) + 1;
  const [row, column] = [Math.floor(point[0] / CELL), Math.floor(point[1] / CELL)];
  const ids: number[] = [];
  for (let r = row - reach; r <= row + reach; r += 1) for (let c = column - reach; c <= column + reach; c += 1) ids.push(...(cells.get(`${r},${c}`) ?? []));
  return ids;
}

// Roads and railways: every line becomes a run of edges between its snapped vertices.
for (const file of [roadsFile, railsFile]) {
  for (const feature of read(file).features as Array<{ properties?: { type?: string }; geometry?: { type: string; coordinates: number[][] | number[][][] } }>) {
    if (!feature.geometry || SKIP_TYPES.has(feature.properties?.type ?? "")) continue;
    const lines = feature.geometry.type === "LineString" ? [feature.geometry.coordinates as number[][]] : (feature.geometry.coordinates as number[][][]);

    for (const line of lines) {
      let previous: number | undefined;

      for (const [lng, lat] of line) {
        const id = node([lat, lng]);
        if (previous !== undefined) link(previous, id);
        previous = id;
      }
    }
  }
}

const roadNodes = nodes.length;
console.log(`${roadNodes} road and rail nodes, ${edges.size} edges, ${Math.round((Date.now() - started) / 1000)} s`);

// Places, stations and waypoints, each tied to the nearest road over land; where no road
// comes near, tied to each other the way the first version of this graph was.
const places: LatLng[] = [];
for (const city of read("cities.json").cities as Array<{ lat: number; lng: number }>) places.push([city.lat, city.lng]);
for (const [, lat, lng] of read("landings.json").landings as Array<[string, number, number]>) places.push([lat, lng]);
for (let lat = -58; lat <= 76; lat += GRID_DEGREES) for (let lng = -180; lng < 180; lng += GRID_DEGREES) {
  const point: LatLng = [lat, lng];
  if (mask.onLand(point) && !around(point, GRID_CLEARANCE_KM).some((id) => haversineKm(nodes[id], point) < GRID_CLEARANCE_KM)) places.push(point);
}

const placeIds: number[] = [];

for (const place of places) {
  const id = node(place);
  placeIds.push(id);
  const near = around(place, TIE_KM)
    .filter((other) => other !== id && other < roadNodes)
    .map((other) => ({ other, km: haversineKm(place, nodes[other]) }))
    .filter((entry) => entry.km <= TIE_KM)
    .sort((a, b) => a.km - b.km)
    .slice(0, 2);

  for (const { other } of near) {
    if (mask.waterAlong(place, nodes[other]).longestKm < SEA_CROSSING_KM) link(id, other);
  }
}

// The fallback ties between places, for islands and regions the road data leaves out.
const placeSet = new Set(placeIds);
const placeCells = new Map<string, number[]>();
for (const id of placeIds) placeCells.set(cellOf(nodes[id]), [...(placeCells.get(cellOf(nodes[id])) ?? []), id]);
const degree = new Map<number, number>();
for (const key of edges.keys()) for (const part of key.split("-")) degree.set(Number(part), (degree.get(Number(part)) ?? 0) + 1);

for (const id of placeIds) {
  if ((degree.get(id) ?? 0) >= 2) continue;
  const place = mask.placeAt(nodes[id]);
  const reach = Math.ceil(FALLBACK_EDGE_KM / (CELL * 100)) + 1;
  const [row, column] = [Math.floor(nodes[id][0] / CELL), Math.floor(nodes[id][1] / CELL)];
  const candidates: Array<{ other: number; km: number }> = [];
  for (let r = row - reach; r <= row + reach; r += 1) for (let c = column - reach; c <= column + reach; c += 1) for (const other of placeCells.get(`${r},${c}`) ?? []) {
    if (other !== id && placeSet.has(other)) candidates.push({ other, km: haversineKm(nodes[id], nodes[other]) });
  }
  let linked = 0;
  for (const { other, km } of candidates.filter((entry) => entry.km <= FALLBACK_EDGE_KM).sort((a, b) => a.km - b.km)) {
    if (linked >= FALLBACK_NEIGHBOURS) break;
    const otherPlace = mask.placeAt(nodes[other]);
    if (place && otherPlace && place.landmass !== otherPlace.landmass) continue;
    if (mask.waterAlong(nodes[id], nodes[other]).longestKm >= SEA_CROSSING_KM) continue;
    link(id, other);
    linked += 1;
  }
}

// Flat, to keep the file small: latitude and longitude pairs, then node index pairs. The
// lengths are recomputed on load.
const edgeList = [...edges.keys()].flatMap((key) => key.split("-").map(Number));
writeFileSync(
  new URL("land.json", root),
  JSON.stringify({
    _source: "Natural Earth 1:10m roads and railroads and populated places (public domain), TeleGeography landing points (CC BY-SA 4.0), joined by scripts/build-land-graph.mts",
    _format: "nodes: [lat, lng, lat, lng, ...]; edges: [from, to, from, to, ...] as node indices",
    nodes: nodes.flat(),
    edges: edgeList
  })
);
console.log(`wrote land.json: ${nodes.length} nodes (${roadNodes} on roads and rails), ${edgeList.length / 2} edges, ${Math.round((Date.now() - started) / 1000)} s`);
