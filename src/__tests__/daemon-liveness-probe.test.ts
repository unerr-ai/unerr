/**
 * Daemon liveness probe — mid-serve wedge recovery.
 *
 * `tryAdopt` only health-checks a proxy at adopt time; a proxy that wedges while
 * serving keeps its IPC handle + bridge connections, so the idle sweep (which
 * skips connected proxies) never touches it and it stays frozen (the pid-47377
 * case). probeLiveness /health-pings running proxies each sweep and recycles one
 * that fails LIVENESS_MAX_STRIKES consecutive probes. These lock the pure strike
 * transition: reset on success, recycle only after a streak (no false-kill on a
 * single transient miss).
 */
import { describe, expect, it } from "vitest";
import { nextLivenessState } from "../daemon/process-manager.js";

describe("nextLivenessState", () => {
  it("resets the strike count to 0 on a successful ping", () => {
    expect(nextLivenessState(0, true)).toEqual({ failures: 0, recycle: false });
    expect(nextLivenessState(1, true)).toEqual({ failures: 0, recycle: false });
  });

  it("does NOT recycle on a single failure (no false-kill on a transient miss)", () => {
    expect(nextLivenessState(0, false)).toEqual({
      failures: 1,
      recycle: false,
    });
  });

  it("recycles once consecutive failures reach the strike ceiling", () => {
    // 2 strikes (LIVENESS_MAX_STRIKES) → recycle.
    expect(nextLivenessState(1, false)).toEqual({ failures: 2, recycle: true });
  });

  it("a success between failures prevents recycling (streak must be consecutive)", () => {
    const afterFirstMiss = nextLivenessState(0, false);
    expect(afterFirstMiss.recycle).toBe(false);
    // healthy ping in between resets the streak...
    const afterRecovery = nextLivenessState(afterFirstMiss.failures, true);
    expect(afterRecovery).toEqual({ failures: 0, recycle: false });
    // ...so the next miss is only strike 1 again, not a recycle.
    expect(nextLivenessState(afterRecovery.failures, false)).toEqual({
      failures: 1,
      recycle: false,
    });
  });
});
