/// <reference lib="webworker" />
// The cable router in its own thread. Building the graph (30,000 vertices plus the
// coastline) and running a search per leg took hundreds of milliseconds on the main
// thread, right when a result was about to appear; here it never blocks a frame.
import { dataUrl } from "./mapData";
import { CableGraph, LandMask, type LatLng } from "./cableRouting";
import { LandGraph } from "./landRouting";

interface Request {
  id: number;
  from: LatLng;
  to: LatLng;
  // Growth in round-trip time across the leg, when both hops answered.
  rttMs?: number;
  // The networks at the leg's two ends, as the traceroute names them.
  operators?: string[];
}

let graphPromise: Promise<CableGraph> | undefined;

function graph() {
  graphPromise ??= Promise.all([
    fetch(dataUrl("cables")).then((response) => response.json()),
    fetch(dataUrl("countries")).then((response) => response.json()),
    fetch(dataUrl("landings")).then((response) => response.json()),
    fetch(dataUrl("land")).then((response) => response.json())
  ]).then(([cables, countries, landings, land]) => {
    const mask = new LandMask(countries);

    return new CableGraph(cables, mask, landings.landings, new LandGraph(land, mask));
  });

  return graphPromise;
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id, from, to, rttMs, operators } = event.data;

  try {
    const decision = (await graph()).decide(from, to, { rttMs, operators });
    self.postMessage({ id, decision });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};

// Build the graph as soon as the worker starts, ahead of the first leg.
void graph();
