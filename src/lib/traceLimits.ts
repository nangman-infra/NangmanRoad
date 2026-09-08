// How far the measurement provider will go before it gives up. Globalping's traceroute
// stops after 20 hops and its mtr after 30, and the API takes no option to raise either -
// the fields it accepts are the protocol, the port and the address family. A target further
// off than that is never probed at all: what comes back is every hop the trace did reach
// and then nothing, which is right as far as it goes and simply stops short of the target.
import type { HopResult, TraceMode } from "../../shared/types";

export const HOP_LIMIT = { traceroute: 20, mtr: 30 } as const;

// True when a trace spent its whole hop allowance without reaching the target. A silent
// tail does not rule this out and must not be read as the target refusing to answer: a hop
// that returns nothing is a router that did not send its own time-exceeded reply, and the
// target may still be several hops beyond it, unprobed. Either way the allowance is gone,
// and the deeper mode is the only thing left to try.
export function ranOutOfHops(hops: HopResult[], mode: TraceMode, reachedTarget?: boolean) {
  return reachedTarget === false && hops.length >= HOP_LIMIT[mode];
}
