import { getDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { describe, expect, it } from "vitest";
import { CONNECT_ATTEMPT_MS, widenConnectAttempts } from "./network";

describe("outbound connections", () => {
  it("waits longer for a handshake than the 250 ms default that cut off RIPE IPmap", () => {
    widenConnectAttempts();

    expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(CONNECT_ATTEMPT_MS);
    // RIPE IPmap answers a handshake from Seoul in about 330 ms.
    expect(CONNECT_ATTEMPT_MS).toBeGreaterThan(330);
  });
});
