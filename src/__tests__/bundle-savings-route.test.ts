/**
 * GET /api/token-flow/bundle-savings — Layer B realized reconciliation route.
 *
 * Seeds a temp metrics.db with a `context_bundle` token_flow_event (the Layer-A
 * modeled bundle), a confirming caller-aware edit (`cascade_guard`
 * behavior_event), and a re-read (`file_read` token_flow_event), then asserts the
 * route reconciles them into the credible realized number. Exercises the DB-read
 * glue end-to-end (readTokenFlowEvents + readBehaviorEvents → reconcileBundleSavings).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTokenFlowRoutes } from "../server/routes/token-flow.js";
import {
  closeMetricsStore,
  openMetricsStore,
} from "../tracking/metrics-store.js";

let root: string;
let unerrDir: string;
let app: ReturnType<typeof createTokenFlowRoutes>;

async function fetchJson(path: string) {
  const res = await app.fetch(new Request(`http://localhost${path}`));
  return {
    status: res.status,
    data: ((await res.json()) as { data: Record<string, unknown> }).data,
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "unerr-bs-"));
  unerrDir = join(root, ".unerr");
  const store = openMetricsStore(unerrDir);

  // The modeled bundle: 2 round-trips, 8000 tokens, delivered entities a + b.
  store.insertTokenFlow({
    ts: Date.parse("2026-06-16T00:00:01.000Z"),
    ts_iso: "2026-06-16T00:00:01.000Z",
    session_id: "s1",
    pid: 1,
    turn: 1,
    mechanism: "context_bundle",
    tool: "unerr_context",
    tokens_without: 12000,
    tokens_with: 4000,
    tokens_saved: 8000,
    detail: JSON.stringify({
      round_trips_modeled: 2,
      delivered_entity_keys: ["a", "b"],
      delivered_files: ["src/foo.ts"],
      expand_keys: [],
    }),
  });

  // A caller-aware edit of delivered entity `a` with no preceding re-read →
  // one CONFIRMED saved round-trip.
  store.insertBehaviorEvent({
    ts: Date.parse("2026-06-16T00:00:02.000Z"),
    ts_iso: "2026-06-16T00:00:02.000Z",
    session_id: "s1",
    pid: 1,
    turn: 2,
    type: "cascade_guard",
    tool: null,
    entity_key: "a",
    response_bytes: null,
    detail: null,
  });

  // A re-read of delivered file src/foo.ts → a claw-back (miss).
  store.insertTokenFlow({
    ts: Date.parse("2026-06-16T00:00:03.000Z"),
    ts_iso: "2026-06-16T00:00:03.000Z",
    session_id: "s1",
    pid: 1,
    turn: 3,
    mechanism: "file_read",
    tool: "file_read",
    tokens_without: 900,
    tokens_with: 300,
    tokens_saved: 600,
    detail: JSON.stringify({ file_path: "src/foo.ts" }),
  });

  app = createTokenFlowRoutes({ unerrDir, getTokenFlowWriter: () => null });
});

afterAll(() => {
  closeMetricsStore(unerrDir);
  rmSync(root, { recursive: true, force: true });
});

describe("GET /bundle-savings", () => {
  it("reconciles the modeled bundle into a realized number", async () => {
    const { status, data } = await fetchJson("/bundle-savings");
    expect(status).toBe(200);
    expect(data.bundles).toBe(1);
    expect(data.modeled_tokens_saved).toBe(8000);
    // 1 of 2 modeled round-trips confirmed → 8000 × 1/2.
    expect(data.realized_tokens_saved).toBe(4000);
    expect(data.realization_ratio).toBeCloseTo(0.5);
  });

  it("surfaces the folded reconciliation summary (hit rate clawed back by the re-read)", async () => {
    const { data } = await fetchJson("/bundle-savings");
    const summary = data.summary as Record<string, number>;
    expect(summary.confirmed_round_trips_saved).toBe(1);
    // 3 delivered items (a, b, src/foo.ts); src/foo.ts re-read → 2/3 hit.
    expect(summary.delivered_items).toBe(3);
    expect(summary.refetched_items).toBe(1);
    expect(summary.bundle_hit_rate).toBeCloseTo(2 / 3);
  });

  it("honors the from_ts/to_ts window (excludes the bundle when out of range)", async () => {
    const { data } = await fetchJson(
      "/bundle-savings?from_ts=2027-01-01T00:00:00.000Z"
    );
    expect(data.bundles).toBe(0);
    expect(data.realized_tokens_saved).toBe(0);
    expect(data.realization_ratio).toBe(0);
  });
});
