import { describe, expect, it } from "vitest";
import { CableGraph, greatCircle, haversineKm } from "./cableRouting";

// Two cables meeting at one landing station on a fictional island, plus a stray cable
// nowhere near either end of the leg.
const line = (points: Array<[number, number]>) => points.map(([lat, lng]) => [lng, lat]);
const collection = {
  features: [
    { geometry: { coordinates: [line([[35, 130], [33, 140], [30, 150], [25, 160]])] } },
    { geometry: { coordinates: [line([[25, 160], [22, 175], [24, -170], [30, -140], [34, -122]])] } },
    { geometry: { coordinates: [line([[-30, 20], [-35, 40]])] } }
  ]
};

describe("CableGraph", () => {
  it("routes an ocean leg through connected cables and back onto land at each end", () => {
    const graph = new CableGraph(collection);
    const path = graph.route([37.5, 127], [34, -118]);

    expect(path).toBeDefined();
    expect(path?.[0]).toEqual([37.5, 127]);
    expect(path?.at(-1)).toEqual([34, -118]);
    // The chain passes the shared landing at 25,160 - the only way from one cable to the next.
    expect(path?.some(([lat, lng]) => lat === 25 && lng === 160)).toBe(true);
  });

  it("crosses a continent by land after the cable when no cable reaches the far coast", () => {
    // A Pacific cable lands on the west coast; the destination is on the east coast with no
    // sea route between them. The chain should still exist: cable, then overland.
    const graph = new CableGraph({
      features: [
        { geometry: { coordinates: [line([[35, 130], [30, 150], [25, 175], [30, -150], [34, -122]])] } },
        { geometry: { coordinates: [line([[26, -80], [24, -75], [18, -66]])] } }
      ]
    });
    const path = graph.route([37.5, 127], [25.8, -80.2]);

    expect(path).toBeDefined();
    // Last cable vertex is the west-coast landing; the leg then jumps straight to Miami.
    expect(path?.at(-2)).toEqual([34, -122]);
    expect(path?.at(-1)).toEqual([25.8, -80.2]);
  });

  it("joins two systems over a short land bridge between their landing stations", () => {
    const graph = new CableGraph({
      features: [
        { geometry: { coordinates: [line([[9, -79.6], [5, -85], [0, -95]])] } },
        { geometry: { coordinates: [line([[9.4, -79.9], [15, -75], [20, -70]])] } }
      ]
    });
    const path = graph.route([-2, -96], [21, -69]);

    expect(path).toBeDefined();
    expect(path?.some(([lat, lng]) => lat === 9 && lng === -79.6)).toBe(true);
    expect(path?.some(([lat, lng]) => lat === 9.4 && lng === -79.9)).toBe(true);
  });

  it("leaves a short or landlocked leg straight", () => {
    const graph = new CableGraph(collection);

    expect(graph.route([50.1, 8.7], [49, 8.4])).toBeUndefined();
    expect(graph.route([37.5, 127], [-33, 25])).toBeUndefined();
  });

  it("samples a great circle that starts and ends on the endpoints", () => {
    const path = greatCircle([37.5, 127], [34, -118], 16);

    expect(path).toHaveLength(17);
    expect(haversineKm(path[0], [37.5, 127])).toBeLessThan(1);
    expect(haversineKm(path[16], [34, -118])).toBeLessThan(1);
  });
});
