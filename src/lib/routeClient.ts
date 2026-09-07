// The main thread's handle on the cable router worker: one worker for the page, one
// promise per leg.
import type { LatLng, LegDecision } from "./cableRouting";

interface Reply {
  id: number;
  decision?: LegDecision;
  error?: string;
}

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (decision: LegDecision) => void; reject: (error: Error) => void }>();

function ensureWorker() {
  if (!worker) {
    worker = new Worker(new URL("./routeWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<Reply>) => {
      const { id, decision, error } = event.data;
      const waiter = pending.get(id);
      pending.delete(id);

      if (!waiter) return;
      if (error || !decision) waiter.reject(new Error(error ?? "Route worker sent no decision."));
      else waiter.resolve(decision);
    };
    worker.onerror = () => {
      for (const waiter of pending.values()) waiter.reject(new Error("Route worker failed."));
      pending.clear();
    };
  }

  return worker;
}

// Starts the worker and its graph build now, so the first leg does not wait for them.
export function warmRouter() {
  try {
    ensureWorker();
  } catch {
    // No worker support: legs fall back to great circles.
  }
}

// What a leg rides - land, a chain of cables, or a straight line across water no chain
// was found for. Without worker support every leg is land.
export function routeLeg(from: LatLng, to: LatLng, rttMs?: number, operators?: string[]): Promise<LegDecision> {
  return new Promise((resolve, reject) => {
    let target: Worker;

    try {
      target = ensureWorker();
    } catch {
      resolve({ kind: "land", path: [from, to], evidence: [{ code: "no_worker" }] });
      return;
    }

    const id = (sequence += 1);
    pending.set(id, { resolve, reject });
    target.postMessage({ id, from, to, rttMs, operators });
  });
}
