// How far the measurement provider will go before it gives up. Globalping's traceroute
// stops after 20 hops and its mtr after 30, and the API takes no option to raise either -
// the fields it accepts are the protocol, the port and the address family. A target further
// off than that is never probed at all: what comes back is every hop the trace did reach
// and then nothing, which is right as far as it goes and simply stops short of the target.
import type { HopResult, TraceMode, TraceProtocol } from "../../shared/types";

export const HOP_LIMIT = { traceroute: 20, mtr: 30 } as const;

// True when a trace spent its whole hop allowance without reaching the target. A silent
// tail does not rule this out and must not be read as the target refusing to answer: a hop
// that returns nothing is a router that did not send its own time-exceeded reply, and the
// target may still be several hops beyond it, unprobed. Either way the allowance is gone,
// and the deeper mode is the only thing left to try.
export function ranOutOfHops(hops: HopResult[], mode: TraceMode, reachedTarget?: boolean) {
  return reachedTarget === false && hops.length >= HOP_LIMIT[mode];
}

// True when the routers answered but the target never did, with hops still to spare: the
// target's network drops ICMP, as hosting networks commonly do, and only a TCP probe to a
// port the target listens on will get an answer from the target itself. Not offered when
// the allowance ran out (the deeper mode comes first) or after a TCP run (nothing left).
export function targetIgnoredIcmp(hops: HopResult[], mode: TraceMode, reachedTarget: boolean | undefined, protocol: TraceProtocol) {
  return protocol === "icmp" && reachedTarget === false && hops.length > 0 && !ranOutOfHops(hops, mode, reachedTarget);
}
