import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

// Node gives each address family 250 ms to finish its handshake and then abandons that
// attempt. The container has no IPv6, so a lookup falls back to IPv4 alone, and RIPE IPmap's
// server needs about 330 ms to shake hands from Seoul: every call to it failed with ETIMEDOUT
// in roughly 340 ms (9 ms for the unreachable IPv6, then the 250 ms cut-off), while curl on
// the same host fetched it in full. A second covers that handshake three times over, and a
// family that is simply unreachable still fails in milliseconds, so nothing waits for it.
export const CONNECT_ATTEMPT_MS = 1_000;

export function widenConnectAttempts() {
  setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_MS);
}
