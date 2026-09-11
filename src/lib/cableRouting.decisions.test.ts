import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CableGraph, LandMask, haversineKm, type LatLng } from "./cableRouting";
import { LandGraph } from "./landRouting";

// Where the router says a leg goes, over city pairs across every continent, against what
// is known of how traffic between those places actually travels. Change a rule and this
// says which pairs it turned - "land" is terrestrial fibre drawn along the corridors, "cable"
// a chain of submarine systems. Not every pair has one true answer: the ones here do.
const root = new URL("../../public/data/", import.meta.url);
const read = (file: string) => JSON.parse(readFileSync(new URL(file, root), "utf8"));
const mask = new LandMask(read("countries.json"));
const graph = new CableGraph(read("cables.json"), mask, read("landings.json").landings, new LandGraph(read("land.json"), mask));

const city: Record<string, LatLng> = {
  Seoul: [37.5665, 126.978],
  Busan: [35.1796, 129.0756],
  HongKong: [22.3193, 114.1694],
  Beijing: [39.9042, 116.4074],
  Shanghai: [31.23, 121.47],
  Tokyo: [35.6762, 139.6503],
  Toyohashi: [34.7692, 137.3915],
  Osaka: [34.6937, 135.5023],
  Fukuoka: [33.5902, 130.4017],
  Taipei: [25.03, 121.56],
  Singapore: [1.35, 103.82],
  Jakarta: [-6.2, 106.8],
  Mumbai: [19.08, 72.88],
  Dubai: [25.2, 55.27],
  LosAngeles: [34.05, -118.24],
  NewYork: [40.71, -74.01],
  Miami: [25.77, -80.19],
  Boston: [42.36, -71.06],
  Bogota: [4.71, -74.07],
  Panama: [8.98, -79.52],
  SaoPaulo: [-23.55, -46.63],
  London: [51.51, -0.13],
  Paris: [48.85, 2.35],
  Frankfurt: [50.11, 8.68],
  Marseille: [43.3, 5.37],
  Karlsruhe: [49.01, 8.4],
  Helsinki: [60.17, 24.94],
  Tallinn: [59.44, 24.75],
  Stockholm: [59.33, 18.07],
  Berlin: [52.52, 13.4],
  Moscow: [55.76, 37.62],
  Copenhagen: [55.68, 12.57],
  Malmo: [55.6, 13.0],
  Istanbul: [41.01, 28.98],
  Ankara: [39.93, 32.86],
  Sydney: [-33.87, 151.21],
  Perth: [-31.95, 115.86],
  CapeTown: [-33.92, 18.42],
  Cairo: [30.04, 31.24]
};

const expectations: Array<[keyof typeof city, keyof typeof city, "land" | "cable"]> = [
  // One country, one piece of land: terrestrial.
  ["Seoul", "Busan", "land"],
  ["Tokyo", "Osaka", "land"],
  ["LosAngeles", "NewYork", "land"],
  ["Boston", "Miami", "land"],
  ["Sydney", "Perth", "land"],
  ["Istanbul", "Ankara", "land"],
  ["Shanghai", "HongKong", "land"],
  ["Frankfurt", "Karlsruhe", "land"],
  // Neighbours whose straight line stays on land, or crosses no more than a bridge: terrestrial.
  ["Frankfurt", "Marseille", "land"],
  ["Berlin", "Moscow", "land"],
  ["Moscow", "Beijing", "land"],
  ["Copenhagen", "Malmo", "land"],
  // Off the landmass, or across a border no fibre crosses: a cable.
  ["Seoul", "Tokyo", "cable"],
  ["Busan", "Fukuoka", "cable"],
  ["Shanghai", "Taipei", "cable"],
  ["Singapore", "Jakarta", "cable"],
  ["Seoul", "HongKong", "cable"],
  ["Seoul", "Beijing", "cable"],
  ["Seoul", "Shanghai", "cable"],
  ["Panama", "Bogota", "cable"],
  ["Miami", "Bogota", "cable"],
  ["Miami", "SaoPaulo", "cable"],
  // Open water between neighbours on one landmass, with a cable across it: a cable.
  ["Helsinki", "Tallinn", "cable"],
  ["Stockholm", "Helsinki", "cable"],
  ["Paris", "London", "cable"],
  ["Mumbai", "Dubai", "cable"],
  // Long international legs that touch the sea: a cable.
  ["Beijing", "Singapore", "cable"],
  ["Seoul", "London", "cable"],
  ["Seoul", "Frankfurt", "cable"],
  ["Cairo", "CapeTown", "land"]
];

describe("leg decisions over the world's city pairs", () => {
  // A cable's line is drawn straight on through some of its own stations - Tata TGN-Pacific
  // passes Toyohashi on its way to Emi - and the cable's own list says it lands there. A
  // hop in Toyohashi boards it in Toyohashi, not after a walk to the line's end.
  it("boards a cable at a listed station its line only passes through", () => {
    const decision = graph.decide(city.Toyohashi, city.LosAngeles, { operators: ["Tata Communications"] });

    expect(decision.kind).toBe("cable");
    if (decision.kind !== "cable") return;

    expect(decision.cables).toContain("Tata TGN-Pacific");
    expect(decision.segments.find((segment) => segment.sea)?.from).toBe("Toyohashi, Japan");
  });

  it.each(expectations)("%s to %s goes by %s", (from, to, kind) => {
    expect(graph.decide(city[from], city[to]).kind).toBe(kind);
  });

  it("draws a routed leg's overland stretches along the corridors, not straight", () => {
    const decision = graph.decide(city.Seoul, city.Beijing);

    expect(decision.kind).toBe("cable");
    if (decision.kind !== "cable") return;
    // The walk from the Chinese landing to Beijing passes through inland places on the way.
    expect(decision.segments.at(-1)?.path.length).toBeGreaterThan(2);
    expect(decision.segments.at(-1)?.from).toBeTruthy();
  });

  it("draws a domestic land leg along the coast rather than across the sea", () => {
    const decision = graph.decide(city.Boston, city.Miami);

    expect(decision.kind).toBe("land");
    if (decision.kind !== "land") return;
    expect(decision.path.length).toBeGreaterThan(5);
    // Every point of the drawn path is on land, or within the coastline's leniency of it.
    expect(decision.path.every((point) => mask.placeAt(point) !== undefined)).toBe(true);
  });

  it("stays on a system that runs on by sea instead of walking between its stations", () => {
    // Without an owner to favour, the cheapest chain used to leave EAC-C2C at Taipei and
    // walk the length of Taiwan to board it again at Fangshan.
    const decision = graph.decide(city.Seoul, city.HongKong);

    expect(decision.kind).toBe("cable");
    if (decision.kind !== "cable") return;
    const walks = decision.segments.filter((segment) => !segment.sea && segment.from && segment.to);
    for (const walk of walks) {
      const walkKm = walk.path.reduce((sum, point, index, path) => (index === 0 ? 0 : sum + haversineKm(path[index - 1], point)), 0);
      expect(walkKm, `${walk.from} → ${walk.to}`).toBeLessThan(120);
    }
  });

  it("keeps a Korean international leg on cables all the way to the far coast", () => {
    const decision = graph.decide(city.Seoul, city.HongKong);

    expect(decision.kind).toBe("cable");
    if (decision.kind !== "cable") return;
    const last = decision.segments.at(-1);
    // It comes ashore in Hong Kong itself, not a neighbour, so the final walk is short.
    expect(last?.sea).toBe(false);
    expect(last?.from).toMatch(/China/);
    const walkKm = (last?.path ?? []).reduce((sum, point, index, path) => (index === 0 ? 0 : sum + haversineKm(path[index - 1], point)), 0);
    expect(walkKm).toBeLessThan(150);
  });
});
