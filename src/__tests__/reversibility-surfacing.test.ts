/**
 * Sprint U (surfacing) + S8 — reversibility savings reach the per-turn
 * `unerr »` economy line (TU.7), fidelity-honest (TU.9), with the one-line
 * mechanism breakdown (TU.8).
 *
 * Plus S8: `transcript_footprint_tokens` accumulates on compress rows.
 *
 * The dashboard `/reversibility` endpoint test was removed when the per-repo
 * dashboard HTTP server was deleted.
 *
 * All seeding goes through the real MetricsStore on a temp `.unerr` dir, so the
 * tests exercise the exact `compression_events` stream the surfaces read.
 */

import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendCompressionLog } from "../proxy/shell-compression-log.js";
import { renderSessionEconomyLineLive } from "../proxy/turn-footer.js";
import {
  closeMetricsStore,
  openMetricsStore,
} from "../tracking/metrics-store.js";

const SESSION = "sess-rev";

describe("reversibility surfacing — turn line + dashboard + footprint", () => {
  let root: string;
  let unerrDir: string;

  beforeEach(() => {
    // MetricsStore writes its JSONL store to dirname(unerrDir)/.unerr/events.
    // Nest unerrDir as `<uniqueRoot>/.unerr` so each test's repoRoot — and its
    // event store — is isolated; a bare tmp dir collapses repoRoot to the shared
    // os.tmpdir() and bleeds compression rows across tests.
    root = join(os.tmpdir(), `unerr-rev-${Date.now()}-${Math.random()}`);
    unerrDir = join(root, ".unerr");
    mkdirSync(unerrDir, { recursive: true });
  });

  afterEach(() => {
    closeMetricsStore(unerrDir);
    rmSync(root, { recursive: true, force: true });
  });

  /** Seed one user-prompt boundary so the per-turn slice resolves by timestamp. */
  function seedPromptBoundary(
    store: ReturnType<typeof openMetricsStore>,
    ts: number
  ) {
    store.insertBehaviorEvent({
      ts,
      ts_iso: new Date(ts).toISOString(),
      session_id: SESSION,
      pid: 1,
      turn: 1,
      type: "user_prompt_received",
      tool: null,
      entity_key: null,
      response_bytes: null,
      detail: JSON.stringify({ hash: "abc" }),
    });
  }

  /** Seed one retrieve row carrying rerequest_saved_tokens. */
  function seedRetrieve(
    store: ReturnType<typeof openMetricsStore>,
    ts: number,
    saved: number,
    fidelityPass: number | null
  ) {
    store.insertCompression({
      ts,
      ts_iso: new Date(ts).toISOString(),
      command: "search_code",
      category: "cache_retrieve",
      confidence: 1,
      raw_bytes: 100,
      compressed_bytes: 100,
      saved_pct: 0,
      omni_fallback: 0,
      tee_file: null,
      event_kind: "retrieve",
      cache_hit: 1,
      rerequest_saved_tokens: saved,
      fidelity_pass: fidelityPass,
      mechanism: "search_code",
    });
  }

  it("folds this-turn retrieve savings into the per-turn line total (TU.7)", () => {
    const store = openMetricsStore(unerrDir);
    const boundary = Date.now();
    seedPromptBoundary(store, boundary);
    // BEFORE the boundary — belongs to a prior turn, must NOT count this turn.
    seedRetrieve(store, boundary - 10_000, 5_000, 1);
    // AFTER the boundary — this turn.
    seedRetrieve(store, boundary + 1_000, 3_000, 1);
    seedRetrieve(store, boundary + 2_000, 2_000, 1);

    const d = renderSessionEconomyLineLive(unerrDir, SESSION, 1);
    // Only the two after-boundary rows count toward the turn: 3000 + 2000.
    expect(d.turn_tokens_saved).toBe(5_000);
    // Session cumulative includes all three fidelity-passing rows.
    expect(d.total_tokens_saved).toBe(10_000);
  });

  it("excludes fidelity-FAILED retrieve rows from the saving (TU.9)", () => {
    const store = openMetricsStore(unerrDir);
    const boundary = Date.now();
    seedPromptBoundary(store, boundary);
    seedRetrieve(store, boundary + 1_000, 4_000, 1); // counts
    seedRetrieve(store, boundary + 2_000, 9_999, 0); // fidelity FAILED — excluded
    seedRetrieve(store, boundary + 3_000, 1_000, null); // unprobed — lossless, counts

    expect(store.reversibleSavedSince(boundary)).toBe(5_000);
    expect(store.reversibleSavedTotal()).toBe(5_000);

    const d = renderSessionEconomyLineLive(unerrDir, SESSION, 1);
    expect(d.turn_tokens_saved).toBe(5_000);
  });

  it("renders the one-line mechanism breakdown when both compress and reuse contribute (TU.8)", () => {
    const store = openMetricsStore(unerrDir);
    const boundary = Date.now();
    seedPromptBoundary(store, boundary);
    // A token-flow compress event so turnTokensSaved has a compress portion.
    store.insertTokenFlow({
      ts: boundary + 500,
      ts_iso: new Date(boundary + 500).toISOString(),
      session_id: SESSION,
      pid: 1,
      turn: 1,
      mechanism: "shell",
      tool: "bash",
      tokens_without: 12_000,
      tokens_with: 4_000,
      tokens_saved: 8_000,
      detail: null,
    });
    seedRetrieve(store, boundary + 1_000, 2_000, 1);

    const d = renderSessionEconomyLineLive(unerrDir, SESSION, 1);
    // 8000 compress + 2000 reuse = 10000 total.
    expect(d.turn_tokens_saved).toBe(10_000);
    expect(d.line).toContain("compress");
    expect(d.line).toContain("reuse");
    // One line — no newline.
    expect(d.line).not.toContain("\n");
  });

  it("accumulates transcript_footprint_tokens across compress writes (S8)", () => {
    // appendCompressionLog opens openMetricsStore(join(cwd, ".unerr")); use a
    // dedicated isolated cwd whose `.unerr` is the store dir we read back.
    const cwd = join(
      os.tmpdir(),
      `unerr-rev-cwd-${Date.now()}-${Math.random()}`
    );
    const storeDir = join(cwd, ".unerr");
    mkdirSync(storeDir, { recursive: true });
    try {
      const store = openMetricsStore(storeDir);
      appendCompressionLog(cwd, {
        ts: new Date().toISOString(),
        command: "bash",
        category: "log_text",
        confidence: 1,
        rawBytes: 8_000,
        compressedBytes: 2_000,
        savedPct: 75,
        omniFallback: false,
        reversible: { delivered_tokens: 500, mechanism: "shell" },
      });
      appendCompressionLog(cwd, {
        ts: new Date().toISOString(),
        command: "bash",
        category: "log_text",
        confidence: 1,
        rawBytes: 8_000,
        compressedBytes: 2_000,
        savedPct: 75,
        omniFallback: false,
        reversible: { delivered_tokens: 300, mechanism: "shell" },
      });
      // Running cumulative: 500 then 500 + 300 = 800.
      expect(store.transcriptFootprintLatest()).toBe(800);
    } finally {
      closeMetricsStore(storeDir);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
