import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CableGraph, LandMask, haversineKm } from "./cableRouting";

// The real cable and border sets, so the routes a visitor sees are the ones checked here.
const cables = JSON.parse(readFileSync(new URL("../../public/data/cables.json", import.meta.url), "utf8"));
const countries = JSON.parse(readFileSync(new URL("../../public/data/countries.json", import.meta.url), "utf8"));

describe("CableGraph on the bundled cable data", () => {
  const graph = new CableGraph(cables, new LandMask(countries));

  it("keeps a coast-to-coast US leg on land instead of sailing round Panama", () => {
    expect(graph.route([34.05, -118.24], [40.71, -74.01])).toBeUndefined();
  });

  it("still crosses the Sea of Japan by cable between two Asian hops", () => {
    expect(graph.route([37.57, 126.98], [35.68, 139.69])).toBeDefined();
  });

  it("enters the sea from a Korean station for a Seoul hop, not a Japanese one across the water", () => {
    const path = graph.route([37.57, 126.98], [34.05, -118.24]);
    const entry = path?.[1] as [number, number];

    expect(entry[1]).toBeLessThan(130);
    expect(entry[0]).toBeGreaterThan(33);
  });

  it("does not walk across a continent to reach a cable: Seoul to London enters the sea in Korea", () => {
    const path = graph.route([37.57, 126.98], [51.51, -0.13]);
    const entry = path?.[1] as [number, number];

    expect(haversineKm([37.57, 126.98], entry)).toBeLessThan(500);
    // ...and comes ashore in Britain, then goes overland to London.
    const exit = path?.at(-2) as [number, number];
    expect(haversineKm([51.51, -0.13], exit)).toBeLessThan(500);
  });

  it("names the cable systems a leg rides, in order", () => {
    const route = graph.routeWithCables([37.57, 126.98], [51.51, -0.13]);

    expect(route?.cables.length).toBeGreaterThanOrEqual(2);
    expect(route?.cables.every((name) => name.length > 0)).toBe(true);
    expect(new Set(route?.cables).size).toBe(route?.cables.length);
  });

  it("rides a cable across the Korea Strait even for a short leg", () => {
    expect(graph.route([37.57, 126.98], [33.59, 130.4])).toBeDefined();
  });

  it("keeps a domestic leg whose straight line clips the sea on land", () => {
    expect(graph.route([42.36, -71.06], [25.77, -80.19])).toBeUndefined();
    expect(graph.route([-33.87, 151.21], [-31.95, 115.86])).toBeUndefined();
  });

  it("places a city on a small island, and a coastal one, in their own country", () => {
    const mask = new LandMask(countries);

    // Singapore was missing from the 1:110m coastline the router first used.
    expect(mask.placeAt([1.35, 103.82])?.country).toBe("SG");
    expect(mask.placeAt([25.77, -80.19])?.country).toBe("US");
    expect(mask.placeAt([30, -40])).toBeUndefined();
  });

  it("takes Suwon to Miami across the Pacific by cable and then overland", () => {
    const path = graph.route([37.26, 127.03], [25.77, -80.19]);

    expect(path).toBeDefined();
    const landing = path?.at(-2) as [number, number];
    // The chain leaves the sea on the North American west coast, not in Florida.
    expect(landing[1]).toBeLessThan(-110);
    expect(landing[1]).toBeGreaterThan(-130);
    expect(landing[0]).toBeGreaterThan(30);
    // ...and the sea part is most of the journey.
    const seaKm = (path ?? []).slice(1, -1).reduce((sum, point, index, chain) => (index === 0 ? 0 : sum + haversineKm(chain[index - 1], point)), 0);
    expect(seaKm).toBeGreaterThan(7_000);
  });

  it("takes Seoul to Frankfurt by cable rather than a straight line over Siberia", () => {
    const path = graph.route([37.57, 126.98], [50.11, 8.68]);

    expect(path).toBeDefined();
    expect(path?.length).toBeGreaterThan(10);
  });

  it("keeps a European domestic leg straight", () => {
    expect(graph.route([50.11, 8.68], [49.01, 8.4])).toBeUndefined();
  });

  it("sends a Korean international leg by cable even where the straight line is mostly land", () => {
    // Seoul to Hong Kong: the same landmass, but South Korea's only land border carries no fibre.
    expect(graph.decide([37.5665, 126.978], [22.3193, 114.1694]).kind).toBe("cable");
  });

  it("keeps an international leg on land when its straight line never leaves land for long", () => {
    expect(graph.decide([52.52, 13.4], [55.76, 37.62]).kind).toBe("land"); // Berlin to Moscow
    expect(graph.decide([55.68, 12.57], [55.6, 13.0]).kind).toBe("land"); // Copenhagen to Malmö, a bridge
    expect(graph.decide([55.76, 37.62], [39.9, 116.4]).kind).toBe("land"); // Moscow to Beijing
  });

  it("crosses open water by cable between neighbours on one landmass", () => {
    expect(graph.decide([60.17, 24.94], [59.44, 24.75]).kind).toBe("cable"); // Helsinki to Tallinn
    expect(graph.decide([8.98, -79.52], [4.71, -74.07]).kind).not.toBe("land"); // Panama to Bogotá: the Darién Gap
  });

  it("cuts a routed leg into sea and land stretches that meet end to end", () => {
    const decision = graph.decide([37.26, 127.03], [25.77, -80.19]); // Suwon to Miami

    expect(decision.kind).toBe("cable");
    if (decision.kind !== "cable") return;
    const kinds = decision.segments.map((segment) => segment.sea);
    // Overland to a Korean station, across the Pacific, then overland from the west coast to Miami.
    expect(kinds[0]).toBe(false);
    expect(kinds).toContain(true);
    expect(kinds.at(-1)).toBe(false);
    expect(decision.segments.at(-1)?.path.at(-1)).toEqual([25.77, -80.19]);
    decision.segments.slice(1).forEach((segment, index) => {
      expect(segment.path[0]).toEqual(decision.segments[index].path.at(-1));
    });
    expect(decision.segments.some((segment) => segment.sea && segment.cables.length > 0)).toBe(true);
    // Overland stretches carry no cable name, unless they are a cable's own line crossing land.
    expect(decision.segments.filter((segment) => !segment.sea && !segment.terrestrial).every((segment) => segment.cables.length === 0)).toBe(true);
  });

  it("does not walk round the water along a neighbour's coastal cable", () => {
    // Cairo to Tel Aviv: the only chains found ride Israel's own coastal cable after a long
    // walk, and walk farther overland than the straight line is long.
    expect(graph.decide([30.04, 31.24], [32.08, 34.78]).kind).toBe("land");
  });

  it("cuts a chain where its cable crosses Egypt by land", () => {
    // Marseille to Mumbai rides a system whose line runs from the Mediterranean to the Red
    // Sea over Egypt; that part is terrestrial fibre and is drawn as land, under the cable's name.
    const decision = graph.decide([43.3, 5.37], [19.08, 72.88]);

    expect(decision.kind).toBe("cable");
    if (decision.kind !== "cable") return;
    const crossing = decision.segments.find((segment) => segment.terrestrial);

    expect(crossing).toBeDefined();
    expect(crossing?.cables.length).toBeGreaterThan(0);
    const [lat, lng] = crossing?.path[Math.floor((crossing.path.length - 1) / 2)] ?? [0, 0];
    expect(lat).toBeGreaterThan(27);
    expect(lat).toBeLessThan(32);
    expect(lng).toBeGreaterThan(29);
    expect(lng).toBeLessThan(34);
    const km = crossing?.path.reduce((sum, point, index, path) => (index === 0 ? 0 : sum + haversineKm(path[index - 1], point)), 0) ?? 0;
    expect(km).toBeGreaterThan(100);
    expect(km).toBeLessThan(500);
    // The sea runs on either side still carry their stations' names at the chain's ends.
    expect(decision.segments.filter((segment) => segment.sea).length).toBeGreaterThanOrEqual(2);
  });

  it("drops a chain that is too long for the latency measured where land could carry the leg", () => {
    // Barcelona to Genoa crosses the Gulf of Lion; a chain that needs more than the 12 ms
    // measured allows is not the way the packet went.
    expect(graph.decide([41.39, 2.17], [44.41, 8.93], { rttMs: 4 }).kind).toBe("land");
  });
});

// A chain hands from one cable system to the next at a station shared by both, and those
// handovers fall in the middle of a sea run. Reading only the run's two ends left most of
// the stations a leg actually touches with no name anywhere on the map.
describe("the stations a chain runs through", () => {
  const landings = JSON.parse(readFileSync(new URL("../../public/data/landings.json", import.meta.url), "utf8")).landings as Array<[string, number, number]>;
  const graph = new CableGraph(cables, new LandMask(countries), landings);
  const named = new Set(landings.map(([name]) => name));

  const stations = (from: [number, number], to: [number, number]) => {
    const decision = graph.decide(from, to);

    expect(decision.kind).toBe("cable");

    return decision.kind === "cable" ? decision.segments.flatMap((segment) => segment.via ?? []) : [];
  };

  it("names the Sri Lankan station a Europe-to-Asia leg rounds the island at", () => {
    expect(stations([50.11, 8.68], [1.29, 103.85]).map((station) => station.name)).toContain("Matara, Sri Lanka");
  });

  // Paris to Mumbai rides AAE-1 across Egypt. Frankfurt to Mumbai used to as well, but only by
  // changing systems three times at sea (south of Crete, and twice in the Bab-el-Mandeb); held
  // to stations it now leaves from Genoa on Blue, crosses Israel with it and takes FEA from
  // Aqaba, which is not this crossing.
  it("names the two Egyptian stations either side of the Suez land crossing", () => {
    const names = stations([48.85, 2.35], [19.08, 72.88]).map((station) => station.name);

    expect(names).toContain("Abu Talat, Egypt");
    expect(names).toContain("Zafarana, Egypt");
  });

  it("names the Brazilian hub a South Atlantic leg passes, which is neither of its ends", () => {
    const decision = graph.decide([-23.55, -46.63], [38.72, -9.14]);

    expect(decision.kind).toBe("cable");

    if (decision.kind !== "cable") return;

    const ends = decision.segments.flatMap((segment) => [segment.from, segment.to]);

    expect(decision.segments.flatMap((segment) => segment.via ?? []).map((station) => station.name)).toContain("Fortaleza, Brazil");
    expect(ends).not.toContain("Fortaleza, Brazil");
  });

  it("invents no station: every name comes from the landing point data", () => {
    for (const leg of [
      [[50.11, 8.68], [1.29, 103.85]],
      [[37.57, 126.98], [22.32, 114.17]],
      [[25.77, -80.19], [-34.6, -58.38]],
      [[35.68, 139.69], [-33.87, 151.21]]
    ] as Array<[[number, number], [number, number]]>) {
      for (const station of stations(...leg)) expect(named.has(station.name)).toBe(true);
    }
  });

  it("puts every station on the stretch that carries it, so its name lands on the line", () => {
    const decision = graph.decide([50.11, 8.68], [1.29, 103.85]);

    expect(decision.kind).toBe("cable");

    if (decision.kind !== "cable") return;

    for (const segment of decision.segments) {
      for (const station of segment.via ?? []) {
        expect(segment.path.some((point) => point[0] === station.at[0] && point[1] === station.at[1])).toBe(true);
      }
    }
  });
});
