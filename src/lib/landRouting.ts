// Overland routes drawn along populated corridors. A graph of places joined only over land
// (public/data/land.json, built by scripts/build-land-graph.mts): Natural Earth's 100,000+
// places, the landing stations, and a coarse grid of waypoints where neither is near, with
// an edge between two on one piece of land whose straight line never crosses more than a
// bridge's worth of water. Fibre runs where people and roads are, so a route through the
// graph is a better guess at a terrestrial path than a straight line across a bay - still
// a guess, and labelled as one.
import { haversineKm, MinHeap, type LandMask, type LatLng } from "./cableRouting";

// Flat arrays, as the builder writes them: latitude and longitude pairs, then pairs of
// node indices. Edge lengths are computed here.
export interface LandGraphData {
  nodes: number[];
  edges: number[];
}

// How far a hop or a station may be from the nearest corridor, and how many corridors it
// may join.
const ATTACH_KM = 400;
const ATTACH_COUNT = 4;
// Open water longer than this between a point and a corridor is more than a bridge spans.
const SEA_CROSSING_KM = 60;
// A corridor path much longer than the straight line is a gap in the graph, not a route.
const MAX_DETOUR_RATIO = 1.8;
const MAX_DETOUR_SLACK_KM = 100;
const CELL = 3;

export class LandGraph {
  private readonly nodes: LatLng[];
  private readonly adjacency: Array<Array<{ to: number; km: number }>>;
  private readonly cells = new Map<string, number[]>();

  constructor(data: LandGraphData, private readonly mask: LandMask) {
    this.nodes = Array.from({ length: data.nodes.length / 2 }, (_, id) => [data.nodes[id * 2], data.nodes[id * 2 + 1]] as LatLng);
    this.adjacency = this.nodes.map(() => []);

    for (let index = 0; index < data.edges.length; index += 2) {
      const [a, b] = [data.edges[index], data.edges[index + 1]];
      const km = haversineKm(this.nodes[a], this.nodes[b]);
      this.adjacency[a].push({ to: b, km });
      this.adjacency[b].push({ to: a, km });
    }

    this.nodes.forEach((node, id) => {
      const key = this.cell(node);
      this.cells.set(key, [...(this.cells.get(key) ?? []), id]);
    });
  }

  // The overland path between two points: through the corridors when both reach them and
  // the way round is not a long one, otherwise the straight line.
  path(from: LatLng, to: LatLng): LatLng[] {
    const direct = haversineKm(from, to);

    if (direct < 40) {
      return [from, to];
    }

    const starts = this.attach(from);
    const ends = new Map(this.attach(to).map((entry) => [entry.id, entry.km]));

    if (starts.length === 0 || ends.size === 0) {
      return [from, to];
    }

    const limit = direct * MAX_DETOUR_RATIO + MAX_DETOUR_SLACK_KM;
    const cost = new Map<number, number>();
    const cameFrom = new Map<number, number>();
    const heap = new MinHeap();
    let best: { id: number; total: number } | undefined;

    for (const start of starts) {
      cost.set(start.id, start.km);
      heap.push(start.km, start.id);
    }

    while (heap.size > 0) {
      const current = heap.pop();

      if (current.cost > (cost.get(current.node) ?? Number.POSITIVE_INFINITY) || current.cost > limit) {
        continue;
      }

      if (current.cost > (best?.total ?? Number.POSITIVE_INFINITY)) {
        break;
      }

      const exit = ends.get(current.node);

      if (exit !== undefined && current.cost + exit <= limit && (!best || current.cost + exit < best.total)) {
        best = { id: current.node, total: current.cost + exit };
      }

      for (const edge of this.adjacency[current.node]) {
        const next = current.cost + edge.km;

        if (next < (cost.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
          cost.set(edge.to, next);
          cameFrom.set(edge.to, current.node);
          heap.push(next, edge.to);
        }
      }
    }

    if (!best) {
      return [from, to];
    }

    const chain: LatLng[] = [];

    for (let id: number | undefined = best.id; id !== undefined; id = cameFrom.get(id)) {
      chain.push(this.nodes[id]);
    }

    return [from, ...chain.reverse(), to];
  }

  private cell(point: LatLng) {
    return `${Math.floor(point[0] / CELL)},${Math.floor(point[1] / CELL)}`;
  }

  private around(point: LatLng, km: number) {
    const reach = Math.ceil(km / (CELL * 100)) + 1;
    const [row, column] = [Math.floor(point[0] / CELL), Math.floor(point[1] / CELL)];
    const ids: number[] = [];

    for (let r = row - reach; r <= row + reach; r += 1) {
      for (let c = column - reach; c <= column + reach; c += 1) {
        ids.push(...(this.cells.get(`${r},${c}`) ?? []));
      }
    }

    return ids;
  }

  // The nearest corridors a point can join over land: on its piece of land, with no more
  // than a bridge's worth of water between.
  private attach(point: LatLng) {
    const place = this.mask.placeAt(point);
    const candidates = this.around(point, ATTACH_KM)
      .map((id) => ({ id, km: haversineKm(point, this.nodes[id]) }))
      .filter((entry) => entry.km <= ATTACH_KM)
      .sort((a, b) => a.km - b.km);
    const joined: Array<{ id: number; km: number }> = [];

    for (const candidate of candidates) {
      if (joined.length >= ATTACH_COUNT) break;

      const other = this.mask.placeAt(this.nodes[candidate.id]);

      if (place && other && other.landmass !== place.landmass) continue;
      if (this.mask.waterAlong(point, this.nodes[candidate.id]).longestKm >= SEA_CROSSING_KM) continue;

      joined.push(candidate);
    }

    return joined;
  }
}
