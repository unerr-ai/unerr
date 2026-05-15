/**
 * Leapfrog Sprint B TEST: Correction detector.
 *
 * Tests the 6-phase correction detection pipeline against synthetic
 * shadow ledger data. Validates: error signal detection, correction pairing,
 * confidence scoring, false positive filtering, and deduplication.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectCorrections } from "../tracking/correction-detector.js";
import type { LedgerEntry } from "../tracking/shadow-ledger.js";

function createTempLedger(entries: LedgerEntry[]): string {
  const dir = join(
    tmpdir(),
    `unerr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "shadow.jsonl");
  const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
  writeFileSync(path, content, "utf-8");
  return path;
}

function makeLedgerEntry(
  overrides: Partial<LedgerEntry> & { tool: string }
): LedgerEntry {
  return {
    id: Math.random().toString(36).slice(2),
    ts: new Date().toISOString(),
    args_summary: {},
    result_summary: {},
    branch: "main",
    head_sha: "abc123",
    session_id: "session-1",
    correlation_id: null,
    ...overrides,
  };
}

describe("detectCorrections", () => {
  it("returns empty for nonexistent ledger", () => {
    const result = detectCorrections("/nonexistent/path.jsonl");
    expect(result).toEqual([]);
  });

  it("returns empty for empty ledger", () => {
    const path = createTempLedger([]);
    const result = detectCorrections(path);
    expect(result).toEqual([]);
  });

  it("detects a simple error→fix correction pair", () => {
    const now = Date.now();
    const entries: LedgerEntry[] = [
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now).toISOString(),
        args_summary: { key: "src/auth.ts:validateToken" },
        result_summary: { found: true },
      }),
      makeLedgerEntry({
        tool: "sync_local_diff",
        ts: new Date(now + 5000).toISOString(),
        args_summary: { file_path: "src/auth.ts" },
        result_summary: {},
      }),
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now + 15000).toISOString(),
        args_summary: { key: "src/auth.ts:validateToken" },
        result_summary: {
          error: "TypeError: Cannot read property 'userId' of null",
        },
      }),
    ];

    const path = createTempLedger(entries);
    const result = detectCorrections(path, { min_confidence: 0.4 });

    expect(result.length).toBeGreaterThanOrEqual(1);
    const correction = result.find(
      (c) => c.entity_key === "src/auth.ts:validateToken"
    );
    expect(correction).toBeDefined();
    expect(correction?.error_type).toBe("type_error");
    expect(correction?.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("assigns higher confidence when fix succeeded (no re-query within 5min)", () => {
    const now = Date.now();
    const entries: LedgerEntry[] = [
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now).toISOString(),
        args_summary: { key: "src/payment.ts:process" },
        result_summary: { found: true },
      }),
      makeLedgerEntry({
        tool: "sync_local_diff",
        ts: new Date(now + 5000).toISOString(),
        args_summary: {},
        result_summary: {},
      }),
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now + 20000).toISOString(),
        args_summary: { key: "src/payment.ts:process" },
        result_summary: { error: "TypeError: amount is not a number" },
      }),
      // No further re-query of this entity for 5+ minutes → fix succeeded
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now + 600_000).toISOString(),
        args_summary: { key: "src/other.ts:unrelated" },
        result_summary: { found: true },
      }),
    ];

    const path = createTempLedger(entries);
    const result = detectCorrections(path, { min_confidence: 0.4 });
    const correction = result.find(
      (c) => c.entity_key === "src/payment.ts:process"
    );
    expect(correction).toBeDefined();
    // Base 0.5 + fix success bonus 0.2 = at least 0.7
    expect(correction?.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("filters corrections below minimum confidence threshold", () => {
    const now = Date.now();
    const entries: LedgerEntry[] = [
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now).toISOString(),
        args_summary: { key: "src/utils.ts:helper" },
        result_summary: { found: true },
      }),
      makeLedgerEntry({
        tool: "sync_local_diff",
        ts: new Date(now + 5000).toISOString(),
        args_summary: {},
        result_summary: {},
      }),
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now + 15000).toISOString(),
        args_summary: { key: "src/utils.ts:helper" },
        result_summary: { error: "TypeError" },
      }),
      // Another re-query immediately → fix didn't succeed → lower confidence
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now + 25000).toISOString(),
        args_summary: { key: "src/utils.ts:helper" },
        result_summary: { error: "TypeError" },
      }),
    ];

    const path = createTempLedger(entries);
    const highThreshold = detectCorrections(path, { min_confidence: 0.9 });
    expect(highThreshold.length).toBe(0);
  });

  it("deduplicates patterns by entity_key + error_type", () => {
    const now = Date.now();
    const entries: LedgerEntry[] = [];

    // Create two identical error→fix pairs for the same entity
    for (let session = 0; session < 2; session++) {
      const offset = session * 100_000;
      entries.push(
        makeLedgerEntry({
          tool: "get_function",
          ts: new Date(now + offset).toISOString(),
          args_summary: { key: "src/db.ts:query" },
          result_summary: { found: true },
          session_id: `session-${session}`,
        }),
        makeLedgerEntry({
          tool: "sync_local_diff",
          ts: new Date(now + offset + 5000).toISOString(),
          args_summary: {},
          result_summary: {},
          session_id: `session-${session}`,
        }),
        makeLedgerEntry({
          tool: "get_function",
          ts: new Date(now + offset + 15000).toISOString(),
          args_summary: { key: "src/db.ts:query" },
          result_summary: { error: "TypeError: connection is undefined" },
          session_id: `session-${session}`,
        })
      );
    }

    const path = createTempLedger(entries);
    const result = detectCorrections(path, { min_confidence: 0.4 });

    // Should be deduplicated to a single pattern with occurrences=2
    const dbPatterns = result.filter((c) => c.entity_key === "src/db.ts:query");
    expect(dbPatterns.length).toBe(1);
    expect(dbPatterns[0]?.occurrences).toBe(2);
  });

  it("skips entries outside the correction window", () => {
    const now = Date.now();
    const entries: LedgerEntry[] = [
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now).toISOString(),
        args_summary: { key: "src/slow.ts:fn" },
        result_summary: { found: true },
      }),
      makeLedgerEntry({
        tool: "sync_local_diff",
        ts: new Date(now + 5000).toISOString(),
        args_summary: {},
        result_summary: {},
      }),
      // Re-query 5 minutes later — outside the 60s default window
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now + 300_000).toISOString(),
        args_summary: { key: "src/slow.ts:fn" },
        result_summary: { error: "TypeError" },
      }),
    ];

    const path = createTempLedger(entries);
    const result = detectCorrections(path);
    const slowPatterns = result.filter(
      (c) => c.entity_key === "src/slow.ts:fn"
    );
    expect(slowPatterns.length).toBe(0);
  });

  it("classifies different error types correctly", () => {
    const now = Date.now();
    const makeErrorPair = (
      key: string,
      errorMessage: string,
      offset: number
    ) => [
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now + offset).toISOString(),
        args_summary: { key },
        result_summary: { found: true },
      }),
      makeLedgerEntry({
        tool: "sync_local_diff",
        ts: new Date(now + offset + 3000).toISOString(),
        args_summary: {},
        result_summary: {},
      }),
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now + offset + 10000).toISOString(),
        args_summary: { key },
        result_summary: { error: errorMessage },
      }),
    ];

    const entries = [
      ...makeErrorPair("a", "TypeError: x is undefined", 0),
      ...makeErrorPair("b", "Cannot find module './missing'", 100_000),
      ...makeErrorPair(
        "c",
        "Property 'name' does not exist on type 'Foo'",
        200_000
      ),
      ...makeErrorPair("d", "Expected 2 arguments but got 1", 300_000),
    ];

    const path = createTempLedger(entries);
    const result = detectCorrections(path, { min_confidence: 0.4 });

    const types = new Map(result.map((c) => [c.entity_key, c.error_type]));
    expect(types.get("a")).toBe("type_error");
    expect(types.get("b")).toBe("import_error");
    expect(types.get("c")).toBe("missing_field");
    expect(types.get("d")).toBe("wrong_argument");
  });

  it("respects since_days filter", () => {
    const now = Date.now();
    const entries: LedgerEntry[] = [
      // 10 days ago — outside default 7-day window
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
        args_summary: { key: "src/old.ts:fn" },
        result_summary: { found: true },
      }),
      makeLedgerEntry({
        tool: "sync_local_diff",
        ts: new Date(now - 10 * 24 * 60 * 60 * 1000 + 5000).toISOString(),
        args_summary: {},
        result_summary: {},
      }),
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now - 10 * 24 * 60 * 60 * 1000 + 15000).toISOString(),
        args_summary: { key: "src/old.ts:fn" },
        result_summary: { error: "TypeError" },
      }),
    ];

    const path = createTempLedger(entries);

    // Default 7 days — should find nothing
    expect(detectCorrections(path, { min_confidence: 0.4 }).length).toBe(0);

    // 30 days — should find the pattern
    const result = detectCorrections(path, {
      since_days: 30,
      min_confidence: 0.4,
    });
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("returns patterns sorted by confidence descending", () => {
    const now = Date.now();
    const entries: LedgerEntry[] = [];

    // Pattern 1: high confidence (fix succeeded)
    entries.push(
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now).toISOString(),
        args_summary: { key: "high" },
        result_summary: { found: true },
        session_id: "s1",
      }),
      makeLedgerEntry({
        tool: "sync_local_diff",
        ts: new Date(now + 3000).toISOString(),
        args_summary: {},
        result_summary: {},
        session_id: "s1",
      }),
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now + 10000).toISOString(),
        args_summary: { key: "high" },
        result_summary: { error: "TypeError" },
        session_id: "s1",
      })
    );

    // Pattern 2: lower confidence (fix failed — another re-query)
    entries.push(
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now + 100_000).toISOString(),
        args_summary: { key: "low" },
        result_summary: { found: true },
        session_id: "s2",
      }),
      makeLedgerEntry({
        tool: "sync_local_diff",
        ts: new Date(now + 103_000).toISOString(),
        args_summary: {},
        result_summary: {},
        session_id: "s2",
      }),
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now + 110_000).toISOString(),
        args_summary: { key: "low" },
        result_summary: { error: "TypeError" },
        session_id: "s2",
      }),
      makeLedgerEntry({
        tool: "get_function",
        ts: new Date(now + 115_000).toISOString(),
        args_summary: { key: "low" },
        result_summary: { error: "TypeError" },
        session_id: "s2",
      })
    );

    const path = createTempLedger(entries);
    const result = detectCorrections(path, { min_confidence: 0.4 });

    if (result.length >= 2) {
      expect(result[0]?.confidence).toBeGreaterThanOrEqual(
        result[1]?.confidence as number
      );
    }
  });
});
