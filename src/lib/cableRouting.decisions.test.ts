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
  Cairo: [30.04, 31.24],
  Vancouver: [49.28, -123.12],
  MexicoCity: [19.43, -99.13],
  Havana: [23.11, -82.37],
  Paramaribo: [5.85, -55.2],
  SanJose: [9.93, -84.08],
  Brasilia: [-15.79, -47.88],
  Manaus: [-3.12, -60.02],
  Vladivostok: [43.12, 131.89],
  Bern: [46.95, 7.45],
  Seville: [37.39, -5.98],
  Rome: [41.9, 12.5],
  Kyiv: [50.45, 30.52],
  Kingston: [17.97, -76.79],
  Warsaw: [52.23, 21.01],
  Oslo: [59.91, 10.75],
  Pyongyang: [39.03, 125.75],
  Chicago: [41.88, -87.63],
  Rennes: [48.11, -1.68],
  Cardiff: [51.48, -3.18],
  Georgetown: [6.8, -58.16],
  Adelaide: [-34.93, 138.6],
  Hargeisa: [9.56, 44.06],
  Doha: [25.24, 51.5],
  Cincinnati: [39.1, -84.52],
  Nassau: [25.05, -77.4],
  // Where an IP database has put Dammam: out in the Gulf, 80 km off the Saudi shore.
  DammamAtSea: [27.91, 49.76]
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
  // Islands a bridge or a tunnel joins to the land beside them: terrestrial.
  ["Paris", "Copenhagen", "land"],
  ["Frankfurt", "Copenhagen", "land"],
  // A long leg within the Americas, on the continent's own backbone: terrestrial.
  ["Vancouver", "Miami", "land"],
  ["MexicoCity", "NewYork", "land"],
  // Neighbours whose straight line stays on land, or crosses no more than a bridge: terrestrial.
  ["Frankfurt", "Marseille", "land"],
  ["Berlin", "Moscow", "land"],
  ["Moscow", "Beijing", "land"],
  ["Copenhagen", "Malmo", "land"],
  // Russia's own backbone carries a long leg that stays in Europe or Asia: terrestrial.
  ["Vladivostok", "Bern", "land"],
  ["Mumbai", "Moscow", "land"],
  ["Warsaw", "Tallinn", "land"],
  ["Frankfurt", "Stockholm", "land"],
  ["Oslo", "Frankfurt", "land"],
  ["Mumbai", "Pyongyang", "land"],
  // Two places on the European continent, with the sea only off to one side: terrestrial.
  ["Seville", "Rome", "land"],
  // Off the landmass, or across a border no fibre crosses: a cable.
  ["Seoul", "Tokyo", "cable"],
  ["Tokyo", "Seoul", "cable"],
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

  // London to Sao Paulo crossed to France on Guernsey's own cables, and Hong Kong to London
  // crossed the harbour by sea before boarding, to reach a station Kowloon took for foreign.
  // The legs of a real trace, with its operators.
  it("keeps a chain off an island's own cables and Hong Kong's harbour", () => {
    const atlantic = graph.decide(city.London, city.SaoPaulo, { rttMs: 144, operators: ["Telstra Global", "Telefonica Global Solutions"] });
    const asia = graph.decide(city.HongKong, city.London, { rttMs: 171, operators: ["Telstra Global"] });

    expect(atlantic.kind).toBe("cable");
    expect(asia.kind).toBe("cable");
    if (atlantic.kind !== "cable" || asia.kind !== "cable") return;
    expect(atlantic.cables.filter((cable) => /Guernsey|Channel Islands/.test(cable))).toEqual([]);
    expect(asia.cables).not.toContain("TKO Connect");
  });

  it("takes a long leg on intercontinental systems rather than island to island", () => {
    // Brasilia to New York hopped Martinique and Saint Lucia on regional cables.
    const decision = graph.decide(city.Brasilia, city.NewYork);

    expect(decision.kind).toBe("cable");
    if (decision.kind !== "cable") return;
    expect(decision.cables.filter((cable) => /Kanawa|Southern Caribbean Fiber/.test(cable))).toEqual([]);
  });

  it("hands off on a regional island when no other chain reaches the far hop", () => {
    // Every system from Paramaribo meets the rest of the Caribbean in Trinidad.
    expect(graph.decide(city.Paramaribo, city.SanJose).kind).toBe("cable");
  });

  it("lands a leg from China on Japan's own coast rather than by way of Korea", () => {
    for (const from of [city.Shanghai, city.Beijing]) {
      const decision = graph.decide(from, city.Osaka);

      expect(decision.kind).toBe("cable");
      if (decision.kind !== "cable") return;
      expect(decision.segments.flatMap((segment) => [segment.from, segment.to, ...(segment.via ?? []).map((station) => station.name)])).not.toContain("Busan, South Korea");
    }
  });

  it("crosses a strait a bridge spans with the road, not on the cable beside it", () => {
    const local = /GlobalConnect 3|GlobalConnect 6|GlobalConnect Denmark-Sweden|GlobalConnect Aurora|Danica North|Scandinavian Ring|Denmark-Sweden 1[78]/;

    for (const [from, to] of [[city.Miami, city.Malmo], [city.Malmo, city.Miami], [city.Miami, city.Marseille]]) {
      const decision = graph.decide(from, to);

      expect(decision.kind).toBe("cable");
      if (decision.kind !== "cable") return;
      expect(decision.cables.filter((cable) => local.test(cable))).toEqual([]);
    }
  });

  it("crosses the Channel and takes the road to Ukraine, not five festoons to the Baltic", () => {
    const decision = graph.decide(city.London, city.Kyiv);

    expect(decision.kind).toBe("cable");
    if (decision.kind !== "cable") return;
    expect(decision.cables.filter((cable) => /Tampnet|Norfest|Kattegat|Energinet|NordBalt/.test(cable))).toEqual([]);
  });

  it("passes the Maldives on a long-haul system instead of stitching their own cables", () => {
    const decision = graph.decide(city.Seoul, city.Frankfurt);

    expect(decision.kind).toBe("cable");
    if (decision.kind !== "cable") return;
    expect(decision.cables).not.toContain("Dhiraagu Cable Network");
  });

  it("still takes a country's own regional system out of it", () => {
    // Cuba's ALBA-1 is the way to Jamaica, whatever it costs to board.
    const decision = graph.decide(city.Havana, city.Kingston);

    expect(decision.kind).toBe("cable");
    if (decision.kind !== "cable") return;
    expect(decision.cables).toContain("ALBA-1");
  });

  it("keeps Cuba's traffic off the Guantanamo Bay base's cables", () => {
    const decision = graph.decide(city.Havana, city.NewYork);

    expect(decision.kind).toBe("cable");
    if (decision.kind !== "cable") return;
    expect(decision.cables.filter((cable) => cable.startsWith("GTMO"))).toEqual([]);
  });

  it("passes through an island whose cables all stay in its own country", () => {
    // Marajó's river cables carry Belém's traffic up the Amazon to Manaus.
    const decision = graph.decide(city.Havana, city.Manaus);

    expect(decision.kind).toBe("cable");
    if (decision.kind !== "cable") return;
    expect(decision.cables.some((cable) => cable.startsWith("Norte Conectado"))).toBe(true);
  });

  it("changes system within Europe only in the leg's own countries, boarding where the land took it", () => {
    // Paris to Helsinki walks to Rostock and boards C-Lion1 there; a change at Hanko would not do.
    const decision = graph.decide(city.Paris, city.Helsinki);

    expect(decision.kind).toBe("cable");
    if (decision.kind !== "cable") return;
    expect(decision.cables).toEqual(["C-Lion1"]);
  });

  it("walks further as a last try before leaving a leg only a cable can carry unrouted", () => {
    // Chicago's traffic reaches Cuba by Florida, Jamaica and ALBA-1, not the Guantanamo base.
    const decision = graph.decide(city.Chicago, city.Havana);

    expect(decision.kind).toBe("cable");
    if (decision.kind !== "cable") return;
    expect(decision.cables).toContain("ALBA-1");
    expect(decision.cables.filter((cable) => cable.startsWith("GTMO"))).toEqual([]);
  });

  it("crosses the Pacific between South America and Oceania, not Suez", () => {
    // Traces from Sao Paulo to Sydney run by Ashburn and Los Angeles.
    const decision = graph.decide(city.Brasilia, city.Adelaide);

    expect(decision.kind).toBe("cable");
    if (decision.kind !== "cable") return;
    expect(decision.segments.flatMap((segment) => [segment.from, segment.to, ...(segment.via ?? []).map((station) => station.name)])).not.toContain("Zafarana, Egypt");
  });

  it("enters Guyana on its own cables, not across the Venezuelan border", () => {
    const decision = graph.decide(city.Miami, city.Georgetown);

    expect(decision.kind).toBe("cable");
    if (decision.kind !== "cable") return;
    expect(decision.cables).not.toContain("Venezuelan Festoon");
  });

  it("opens the islands again for a leg no other chain carries", () => {
    expect(graph.decide(city.Rennes, city.Cardiff).kind).toBe("cable");
  });

  it("keeps apart the countries Natural Earth leaves without a code", () => {
    // France, Norway and Somaliland all came as "-99": Hargeisa to Paris was a domestic leg
    // drawn overland, and Paris to Oslo never looked past the land.
    for (const [from, to] of [[city.Hargeisa, city.Paris], [city.Paris, city.Oslo]]) {
      expect(graph.decide(from, to).evidence.map((item) => item.code)).not.toContain("same_country");
    }
  });

  it("takes Finland's and Estonia's traffic across the Baltic by cable, not overland round it", () => {
    // Helsinki to Marseille was drawn overland along the Baltic ferries' line, and without it
    // round by St Petersburg; Tallinn to Oslo straight across the sea.
    const decision = graph.decide(city.Helsinki, city.Marseille);

    expect(graph.decide(city.Tallinn, city.Oslo).kind).toBe("cable");
    expect(decision.kind).toBe("cable");
    if (decision.kind !== "cable") return;
    expect(decision.cables).toContain("C-Lion1");
  });

  it("walks only where the land goes, never across open water between stations", () => {
    // Miami to Warsaw walked from Gedser to Kolobrzeg across the Baltic, Seville to Istanbul
    // from Estepona to Ceuta, Sao Paulo to Paris from Sines to a point out at sea.
    for (const [from, to] of [[city.Miami, city.Warsaw], [city.Seville, city.Istanbul], [city.SaoPaulo, city.Paris]]) {
      const decision = graph.decide(from, to);

      expect(decision.kind).toBe("cable");
      if (decision.kind !== "cable") return;
      const strokes = decision.segments.filter((segment) => !segment.sea).flatMap((segment) => segment.path.slice(1).map((point, index) => [segment.path[index], point]));
      expect(strokes.map(([a, b]) => mask.waterAlong(a, b).longestKm).filter((km) => km >= 60)).toEqual([]);
    }
  });

  it("draws the chain across the least water when all walk across the sea, and none that went round the far shore", () => {
    const wettest = (from: LatLng, to: LatLng) => {
      const decision = graph.decide(from, to);
      const strokes = decision.kind === "cable" ? decision.segments.filter((segment) => !segment.sea).flatMap((segment) => segment.path.slice(1).map((point, index) => [segment.path[index], point])) : [];

      return Math.max(0, ...strokes.map(([a, b]) => mask.waterAlong(a, b).longestKm));
    };

    // Every way to a point out at sea walks across water; the cheapest walked 195 km from Al
    // Khobar where production walked 130. Cincinnati to Nassau sailed past Nassau round Eleuthera
    // and walked from Governors Harbour to Andros; production drew the straight line.
    expect(wettest(city.Doha, city.DammamAtSea)).toBeLessThan(130);
    expect(graph.decide(city.Cincinnati, city.Nassau).kind).toBe("unrouted");
  });

  it("draws no corridor along a ferry's line across the Baltic", () => {
    // Natural Earth draws the ferries from Rostock, Swinoujscie and Gdynia as roads.
    const land = new LandGraph(read("land.json"), mask);

    expect(mask.alongPath(land.path(city.Helsinki, city.Berlin)).longestKm).toBeLessThan(60);
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
