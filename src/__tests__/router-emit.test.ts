/**
 * L1 — router producer. Verifies `RouterTelemetryRecorder.append` also emits one
 * contract-shaped `router` event into the per-repo event store (so `unerrd`
 * drains routing telemetry to the cloud), and that the event's `detail` carries
 * ONLY allowed RouterEvent keys — no local-file-only fields (tokensSaved,
 * latencyMs, outcome, unlocks) leak onto the wire.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetEmitContextForTest, configureEmit } from "../events/enqueue.js";
import {
  PROXY_SEGMENT,
  readSegmentFrom,
  segmentPath,
} from "../events/event-store.js";
import { RouterTelemetryRecorder } from "../proxy/router-telemetry.js";

const ALLOWED_ROUTER_KEYS = new Set([
  "model_id",
  "policy",
  "reason",
  "score",
  "fallback_from",
]);

describe("L1 router producer — RouterTelemetryRecorder.append emits a router event", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "unerr-router-emit-"));
    configureEmit({
      repoRoot,
      segment: PROXY_SEGMENT,
      source: "unerr-cli@test",
    });
  });

  afterEach(() => {
    _resetEmitContextForTest();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("emits exactly one router event whose detail holds only allowed keys", async () => {
    const recorder = new RouterTelemetryRecorder(
      join(repoRoot, ".unerr"),
      "sess-1"
    );

    await recorder.append({
      toolName: "search_code",
      originalToolName: "search_code",
      server: "unerr",
      outcome: "soft_refused",
      wasMasked: true,
      tokensIn: 120,
      tokensSaved: 80,
      latencyMs: { total: 4 },
      unlocks: ["get_references"],
    });

    const slice = readSegmentFrom(segmentPath(repoRoot, PROXY_SEGMENT), 0);
    const routerEvents = slice.events.filter((e) => e.type === "router");

    expect(routerEvents).toHaveLength(1);

    const detail = (routerEvents[0] as { detail: Record<string, unknown> })
      .detail;

    // outcome maps to `reason`; nothing else fits an allowed key here.
    expect(detail.reason).toBe("soft_refused");

    // No local-file-only field leaked into the wire detail.
    for (const key of Object.keys(detail)) {
      expect(ALLOWED_ROUTER_KEYS.has(key)).toBe(true);
    }
    expect("tokensSaved" in detail).toBe(false);
    expect("latencyMs" in detail).toBe(false);
    expect("outcome" in detail).toBe(false);
    expect("unlocks" in detail).toBe(false);
  });
});
