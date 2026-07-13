import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ── What this file proves ──────────────────────────────────────────────
// Large-graph write-stall mitigation for the drift coalescer: on a very
// large graph (150MB+, 40k+ entities) a single `processFiles` write can
// exceed 60s and stall the shared CozoDB write path. `drainDrift()` itself
// is a closure defined INSIDE `startProxy` (captures _driftTracker,
// graphHolder, branchContext, etc.), so it is not exportable or callable
// without standing up the whole proxy. The throttle decision is a pure
// function of (last write duration, cooldown deadline, now) —
// `shouldThrottleDrift()` — so testing it directly covers the gating logic;
// the wiring into `drainDrift` (duration measurement, cooldown scheduling,
// the throttle log line) is locked by a source guard below.

import {
  DRIFT_COOLDOWN_MS,
  DRIFT_SLOW_WRITE_MS,
  shouldThrottleDrift,
} from "../proxy/proxy.js";

describe("DRIFT_SLOW_WRITE_MS / DRIFT_COOLDOWN_MS", () => {
  it("slow-write threshold is 5s", () => {
    expect(DRIFT_SLOW_WRITE_MS).toBe(5_000);
  });

  it("cooldown window is 30s", () => {
    expect(DRIFT_COOLDOWN_MS).toBe(30_000);
  });
});

describe("shouldThrottleDrift", () => {
  it("does not throttle when the last write was fast, even inside a cooldown window", () => {
    expect(shouldThrottleDrift(1_000, Date.now() + 10_000, Date.now())).toBe(
      false
    );
  });

  it("does not throttle when the last write was slow but the cooldown has already elapsed", () => {
    const now = Date.now();
    expect(shouldThrottleDrift(10_000, now - 1, now)).toBe(false);
  });

  it("throttles when the last write was slow and now is still inside the cooldown window", () => {
    const now = Date.now();
    expect(shouldThrottleDrift(10_000, now + 10_000, now)).toBe(true);
  });

  it("treats the slow-write threshold as exclusive (exactly DRIFT_SLOW_WRITE_MS does not throttle)", () => {
    const now = Date.now();
    expect(shouldThrottleDrift(DRIFT_SLOW_WRITE_MS, now + 10_000, now)).toBe(
      false
    );
  });
});

// Source guard for the un-unit-testable closure wiring: `drainDrift` must
// measure the write duration, gate on `shouldThrottleDrift`, log the throttle,
// and re-arm the cooldown after a slow write. Reading the source is the only
// way to lock this without standing up the proxy.
describe("drainDrift throttle wiring", () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const proxySrc = readFileSync(
    join(thisDir, "..", "proxy", "proxy.ts"),
    "utf-8"
  );

  it("gates the drain on shouldThrottleDrift before setting driftBusy", () => {
    const throttleIdx = proxySrc.indexOf(
      "if (shouldThrottleDrift(driftLastWriteMs, driftCooldownUntil))"
    );
    const busyIdx = proxySrc.indexOf("driftBusy = true;");
    expect(throttleIdx).toBeGreaterThan(-1);
    expect(busyIdx).toBeGreaterThan(-1);
    expect(throttleIdx).toBeLessThan(busyIdx);
  });

  it("logs a throttle warning when a drain is skipped", () => {
    expect(proxySrc).toContain(
      "⚠ [watcher] drift throttled (last write ${driftLastWriteMs}ms, cooling down)"
    );
  });

  it("re-arms the cooldown after a slow processFiles write", () => {
    expect(proxySrc).toMatch(
      /driftLastWriteMs = Date\.now\(\) - driftWriteStartedAt;\s*\n\s*if \(driftLastWriteMs > DRIFT_SLOW_WRITE_MS\) \{\s*\n\s*driftCooldownUntil = Date\.now\(\) \+ DRIFT_COOLDOWN_MS;/
    );
  });

  it("does not drop queued paths while throttled (pendingDriftPaths is not cleared before the throttle check)", () => {
    const throttleIdx = proxySrc.indexOf(
      "if (shouldThrottleDrift(driftLastWriteMs, driftCooldownUntil))"
    );
    const clearIdx = proxySrc.indexOf("pendingDriftPaths.clear();");
    expect(throttleIdx).toBeLessThan(clearIdx);
  });
});
