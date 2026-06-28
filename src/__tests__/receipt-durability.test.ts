/**
 * Regression: the end-of-turn receipt must keep rendering after the cloud-drain
 * pipeline truncates `.unerr/events/proxy.jsonl` to 0 bytes (its post-send disk
 * reclaim). The receipt's all-time totals read durable counters; its per-turn /
 * per-session reads scan a durable mirror — both under `.unerr/state/`, which
 * the drain never touches. The cloud outbox (proxy.jsonl) still receives every
 * write, so cloud delivery is unaffected.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  truncateSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROXY_SEGMENT, segmentPath } from "../events/event-store.js";
import {
  type MetricsStore,
  closeMetricsStore,
  openMetricsStore,
} from "../tracking/metrics-store.js";
import { receiptMirrorPath } from "../tracking/receipt-mirror.js";

describe("receipt durability across cloud-drain truncation", () => {
  let repoRoot: string;
  let unerrDir: string;

  beforeEach(() => {
    repoRoot = join(
      os.tmpdir(),
      `unerr-receipt-dur-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    unerrDir = join(repoRoot, ".unerr");
    mkdirSync(unerrDir, { recursive: true });
  });

  afterEach(() => {
    closeMetricsStore(unerrDir);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** One of each receipt-relevant event: a token-flow saving, a hard-prevention
   *  behavior, and a reversible compression. Totals expected: tokens 900,
   *  hard-prevention 1, reversible 500. */
  function writeSampleEvents(s: MetricsStore): void {
    const now = Date.now();
    s.insertTokenFlow({
      ts: now,
      ts_iso: new Date(now).toISOString(),
      session_id: "sess-1",
      pid: 1,
      turn: 1,
      mechanism: "graph_query",
      tool: "search_code",
      tokens_without: 1000,
      tokens_with: 100,
      tokens_saved: 900,
      detail: null,
    });
    s.insertBehaviorEvent({
      ts: now,
      ts_iso: new Date(now).toISOString(),
      session_id: "sess-1",
      pid: 1,
      turn: 1,
      type: "cascade_guard",
      tool: "file_edit",
      entity_key: "src/x.ts",
      response_bytes: null,
      detail: null,
    });
    s.insertCompression({
      ts: now,
      ts_iso: new Date(now).toISOString(),
      command: "ls",
      category: "log_text",
      confidence: 0.9,
      raw_bytes: 1000,
      compressed_bytes: 100,
      saved_pct: 90,
      omni_fallback: 0,
      tee_file: null,
      fidelity_pass: 1,
      rerequest_saved_tokens: 500,
    });
  }

  it("totals + reads survive proxy.jsonl truncation; cloud outbox still got the events", () => {
    const s = openMetricsStore(unerrDir);
    writeSampleEvents(s);

    // The cloud outbox received the writes — dual-write did not remove the
    // proxy.jsonl append, so the drain pipeline still has rows to push.
    const proxyPath = segmentPath(repoRoot, PROXY_SEGMENT);
    expect(existsSync(proxyPath)).toBe(true);
    expect(readFileSync(proxyPath, "utf8").length).toBeGreaterThan(0);

    // Baseline — before any truncation.
    expect(s.tokenFlowTotal()).toBe(900);
    expect(s.hardPreventionTotal()).toBe(1);
    expect(s.reversibleSavedTotal()).toBe(500);
    expect(s.sessionTokensSaved("sess-1")).toBe(900);
    expect(s.allTokenFlow()).toHaveLength(1);
    expect(s.allBehaviorEvents()).toHaveLength(1);

    // Simulate the cloud drain: truncateDrainedLongLivedSegments zeroes the
    // long-lived proxy segment after a successful push.
    truncateSync(proxyPath, 0);
    expect(readFileSync(proxyPath, "utf8").length).toBe(0);

    // The durable mirror is untouched by the drain.
    expect(
      readFileSync(receiptMirrorPath(repoRoot), "utf8").length
    ).toBeGreaterThan(0);

    // All-time totals come from the durable counter file — still correct.
    expect(s.tokenFlowTotal()).toBe(900);
    expect(s.hardPreventionTotal()).toBe(1);
    expect(s.reversibleSavedTotal()).toBe(500);

    // Per-session + per-type reads scan the mirror — still present.
    expect(s.sessionTokensSaved("sess-1")).toBe(900);
    expect(s.allTokenFlow()).toHaveLength(1);
    expect(s.allBehaviorEvents()).toHaveLength(1);
  });

  it("counters persist across a store re-open after truncation (no reset, no double-count)", () => {
    const s1 = openMetricsStore(unerrDir);
    writeSampleEvents(s1);
    truncateSync(segmentPath(repoRoot, PROXY_SEGMENT), 0);
    // Drop the cached instance so the next open re-constructs the store, which
    // re-runs the constructor's seed step — it must NOT re-seed (counter file
    // exists) and must NOT reset.
    closeMetricsStore(unerrDir);

    const s2 = openMetricsStore(unerrDir);
    expect(s2.tokenFlowTotal()).toBe(900);
    expect(s2.hardPreventionTotal()).toBe(1);
    expect(s2.reversibleSavedTotal()).toBe(500);

    // A new event after the "restart" accumulates on top of the persisted total.
    const now = Date.now();
    s2.insertTokenFlow({
      ts: now,
      ts_iso: new Date(now).toISOString(),
      session_id: "sess-2",
      pid: 1,
      turn: 1,
      mechanism: "graph_query",
      tool: "search_code",
      tokens_without: 200,
      tokens_with: 50,
      tokens_saved: 150,
      detail: null,
    });
    expect(s2.tokenFlowTotal()).toBe(1050);
  });

  it("re-seeds the correct measured/modeled split from the durable mirror after a drain wiped the segments", () => {
    const s1 = openMetricsStore(unerrDir);
    const now = Date.now();
    // A measured saving and a MODELED (context_bundle) saving.
    s1.insertTokenFlow({
      ts: now,
      ts_iso: new Date(now).toISOString(),
      session_id: "sess-1",
      pid: 1,
      turn: 1,
      mechanism: "graph_query",
      tool: "search_code",
      tokens_without: 1000,
      tokens_with: 100,
      tokens_saved: 900,
      detail: null,
    });
    s1.insertTokenFlow({
      ts: now,
      ts_iso: new Date(now).toISOString(),
      session_id: "sess-1",
      pid: 1,
      turn: 1,
      mechanism: "context_bundle",
      tool: "unerr_context",
      tokens_without: 24000,
      tokens_with: 4000,
      tokens_saved: 20000,
      detail: null,
    });
    expect(s1.tokenFlowTotal()).toBe(900);
    expect(s1.modeledSavedTotal()).toBe(20000);

    // Cloud drain wipes the segments, THEN the counter file is deleted (a reset
    // / fresh-checkout scenario). The mirror is the only surviving source.
    truncateSync(segmentPath(repoRoot, PROXY_SEGMENT), 0);
    closeMetricsStore(unerrDir);
    rmSync(join(unerrDir, "state", "lifetime-counters.json"), { force: true });

    // Re-open: the constructor must re-seed from the durable mirror (NOT the
    // drained segments), reconstructing the exact measured/modeled split.
    const s2 = openMetricsStore(unerrDir);
    expect(s2.tokenFlowTotal()).toBe(900);
    expect(s2.modeledSavedTotal()).toBe(20000);
  });
});
