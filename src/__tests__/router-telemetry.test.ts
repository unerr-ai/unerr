/**
 * Sprint P0-5 — Router Telemetry Foundation tests.
 *
 * Covers:
 *   1. RouterTelemetryRecorder: JSONL append, session summary, readAll
 *   2. Token savings calculator: BPE-accurate delta
 *   3. CallLatencyTracker: phase timing
 *   4. Session metrics aggregator: groupBySession, aggregateSession
 *   5. JSONL rotation: daily rotate + 7-day retention purge
 *   6. Integration: 100 synthetic calls → metrics.jsonl → aggregate → summary
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  aggregateSession,
  groupBySession,
  readAllSessionMetrics,
} from "../proxy/router-session-metrics.js";
import {
  CallLatencyTracker,
  type RouterTelemetryRecord,
  RouterTelemetryRecorder,
  calculateTokenSavings,
} from "../proxy/router-telemetry.js";

let tempDir: string;

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `unerr-telemetry-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeRecord(
  overrides: Partial<Omit<RouterTelemetryRecord, "v">> = {}
): Omit<RouterTelemetryRecord, "v" | "ts" | "sessionId"> {
  return {
    toolName: overrides.toolName ?? "search_code",
    originalToolName: overrides.originalToolName ?? "search_code",
    server: overrides.server ?? "unerr",
    outcome: overrides.outcome ?? "executed",
    wasMasked: overrides.wasMasked ?? false,
    tokensIn: overrides.tokensIn ?? 25,
    tokensSaved: overrides.tokensSaved ?? 10,
    latencyMs: overrides.latencyMs ?? { total: 3 },
    unlocks: overrides.unlocks ?? undefined,
  };
}

beforeEach(() => {
  tempDir = makeTempDir();
});

afterEach(() => {
  // temp dirs cleaned by OS
});

// ── Token savings calculator ─────────────────────────────────────

describe("calculateTokenSavings", () => {
  it("computes positive savings when full > delivered", () => {
    const result = calculateTokenSavings({
      fullDescription:
        "Search code entities by name across the entire project graph with fuzzy matching support",
      deliveredDescription: "Search code entities by name",
    });
    expect(result.tokensSaved).toBeGreaterThan(0);
    expect(result.tokensIn).toBeGreaterThan(0);
  });

  it("returns zero savings when full === delivered", () => {
    const desc = "Short description";
    const result = calculateTokenSavings({
      fullDescription: desc,
      deliveredDescription: desc,
    });
    expect(result.tokensSaved).toBe(0);
  });

  it("clamps savings to zero when delivered > full", () => {
    const result = calculateTokenSavings({
      fullDescription: "Short",
      deliveredDescription: "A much longer delivered description than the full",
    });
    expect(result.tokensSaved).toBe(0);
  });
});

// ── CallLatencyTracker ───────────────────────────────────────────

describe("CallLatencyTracker", () => {
  it("tracks total latency", () => {
    const tracker = new CallLatencyTracker();
    const result = tracker.finish();
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.classify).toBeUndefined();
    expect(result.forward).toBeUndefined();
  });

  it("tracks classify + forward phases", () => {
    const tracker = new CallLatencyTracker();
    tracker.markClassifyDone();
    tracker.markForwardDone();
    const result = tracker.finish();
    expect(result.classify).toBeDefined();
    expect(result.classify).toBeGreaterThanOrEqual(0);
    expect(result.forward).toBeDefined();
    expect(result.forward).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeGreaterThanOrEqual(0);
  });
});

// ── RouterTelemetryRecorder ──────────────────────────────────────

describe("RouterTelemetryRecorder", () => {
  it("appends a record to metrics.jsonl", async () => {
    const recorder = new RouterTelemetryRecorder(tempDir, "sess-1");
    await recorder.append(makeRecord());

    const records = await recorder.readAll();
    expect(records).toHaveLength(1);
    expect(records[0]!.v).toBe(1);
    expect(records[0]!.sessionId).toBe("sess-1");
    expect(records[0]!.toolName).toBe("search_code");
  });

  it("appends multiple records sequentially", async () => {
    const recorder = new RouterTelemetryRecorder(tempDir, "sess-2");
    await recorder.append(makeRecord({ toolName: "file_read" }));
    await recorder.append(makeRecord({ toolName: "get_entity" }));
    await recorder.append(makeRecord({ toolName: "file_outline" }));

    const records = await recorder.readAll();
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.toolName)).toEqual([
      "file_read",
      "get_entity",
      "file_outline",
    ]);
  });

  it("readAll returns empty array when no file exists", async () => {
    const recorder = new RouterTelemetryRecorder(tempDir, "sess-x");
    const records = await recorder.readAll();
    expect(records).toHaveLength(0);
  });

  it("records unlock events", async () => {
    const recorder = new RouterTelemetryRecorder(tempDir, "sess-3");
    await recorder.append(
      makeRecord({
        unlocks: ["get_critical_nodes", "get_imports"],
      })
    );

    const records = await recorder.readAll();
    expect(records[0]!.unlocks).toEqual(["get_critical_nodes", "get_imports"]);
  });

  it("tracks in-memory session summary correctly", async () => {
    const recorder = new RouterTelemetryRecorder(tempDir, "sess-4");

    await recorder.append(makeRecord({ tokensSaved: 10, tokensIn: 25 }));
    await recorder.append(
      makeRecord({ outcome: "soft_refused", tokensSaved: 0, tokensIn: 0 })
    );
    await recorder.append(
      makeRecord({
        tokensSaved: 20,
        tokensIn: 30,
        unlocks: ["get_imports"],
      })
    );

    const summary = recorder.getSessionSummary();
    expect(summary.sessionId).toBe("sess-4");
    expect(summary.totalCalls).toBe(3);
    expect(summary.totalTokensSaved).toBe(30);
    expect(summary.totalTokensIn).toBe(55);
    expect(summary.softRefuseCount).toBe(1);
    expect(summary.unlockCount).toBe(1);
    expect(summary.efficiency).toBeGreaterThan(0);
  });

  it("swallows write errors via onError callback", async () => {
    const recorder = new RouterTelemetryRecorder("/nonexistent/path", "sess-5");
    let captured: unknown = null;
    await recorder.append(makeRecord(), (err) => {
      captured = err;
    });
    expect(captured).not.toBeNull();
    expect(recorder.getSessionSummary().totalCalls).toBe(1);
  });
});

// ── Session metrics aggregator ───────────────────────────────────

describe("aggregateSession", () => {
  it("returns null for empty records", () => {
    expect(aggregateSession([])).toBeNull();
  });

  it("aggregates a set of records into a summary", () => {
    const records: RouterTelemetryRecord[] = [
      {
        v: 1,
        ts: "2026-05-17T10:00:00Z",
        sessionId: "sess-a",
        toolName: "search_code",
        originalToolName: "search_code",
        server: "unerr",
        outcome: "executed",
        wasMasked: false,
        tokensIn: 25,
        tokensSaved: 10,
        latencyMs: { total: 3 },
      },
      {
        v: 1,
        ts: "2026-05-17T10:01:00Z",
        sessionId: "sess-a",
        toolName: "file_read",
        originalToolName: "file_read",
        server: "unerr",
        outcome: "executed",
        wasMasked: false,
        tokensIn: 30,
        tokensSaved: 15,
        latencyMs: { total: 5 },
      },
      {
        v: 1,
        ts: "2026-05-17T10:02:00Z",
        sessionId: "sess-a",
        toolName: "get_imports",
        originalToolName: "get_imports",
        server: "unerr",
        outcome: "soft_refused",
        wasMasked: true,
        tokensIn: 0,
        tokensSaved: 0,
        latencyMs: { classify: 1, total: 1 },
      },
    ];

    const summary = aggregateSession(records)!;
    expect(summary.sessionId).toBe("sess-a");
    expect(summary.totalCalls).toBe(3);
    expect(summary.totalTokensSaved).toBe(25);
    expect(summary.totalTokensIn).toBe(55);
    expect(summary.softRefuseCount).toBe(1);
    expect(summary.outcomeBreakdown.executed).toBe(2);
    expect(summary.outcomeBreakdown.softRefused).toBe(1);
    expect(summary.avgLatencyMs).toBe(3);
    expect(summary.topTools).toHaveLength(3);
    expect(summary.topTools[0]!.count).toBe(1);
  });
});

describe("groupBySession", () => {
  it("groups records by sessionId", () => {
    const records: RouterTelemetryRecord[] = [
      {
        v: 1,
        ts: "2026-05-17T10:00:00Z",
        sessionId: "sess-a",
        toolName: "search_code",
        originalToolName: "search_code",
        server: "unerr",
        outcome: "executed",
        wasMasked: false,
        tokensIn: 25,
        tokensSaved: 10,
        latencyMs: { total: 3 },
      },
      {
        v: 1,
        ts: "2026-05-17T11:00:00Z",
        sessionId: "sess-b",
        toolName: "file_read",
        originalToolName: "file_read",
        server: "unerr",
        outcome: "executed",
        wasMasked: false,
        tokensIn: 30,
        tokensSaved: 15,
        latencyMs: { total: 5 },
      },
      {
        v: 1,
        ts: "2026-05-17T10:30:00Z",
        sessionId: "sess-a",
        toolName: "get_entity",
        originalToolName: "get_entity",
        server: "unerr",
        outcome: "executed",
        wasMasked: false,
        tokensIn: 20,
        tokensSaved: 5,
        latencyMs: { total: 2 },
      },
    ];

    const grouped = groupBySession(records);
    expect(grouped.size).toBe(2);
    expect(grouped.get("sess-a")).toHaveLength(2);
    expect(grouped.get("sess-b")).toHaveLength(1);
  });
});

// ── JSONL rotation ───────────────────────────────────────────────

describe("JSONL rotation", () => {
  it("does not rotate a same-day file", async () => {
    const recorder = new RouterTelemetryRecorder(tempDir, "sess-rot-1");
    await recorder.append(makeRecord());

    await recorder.rotate();

    const records = await recorder.readAll();
    expect(records).toHaveLength(1);
  });
});

// ── 100-call integration test ────────────────────────────────────

describe("100-call integration: record → readAll → aggregate", () => {
  it("drives 100 synthetic calls and verifies roundtrip", async () => {
    const recorder = new RouterTelemetryRecorder(tempDir, "sess-100");

    const tools = [
      "search_code",
      "file_read",
      "get_entity",
      "file_outline",
      "get_references",
    ];

    for (let i = 0; i < 100; i++) {
      const tool = tools[i % tools.length]!;
      const isSoftRefuse = i % 20 === 0;
      const hasUnlock = i === 15 || i === 45;

      await recorder.append(
        makeRecord({
          toolName: tool,
          outcome: isSoftRefuse ? "soft_refused" : "executed",
          tokensIn: isSoftRefuse ? 0 : 25,
          tokensSaved: isSoftRefuse ? 0 : 10,
          latencyMs: { total: 2 + (i % 5) },
          unlocks: hasUnlock ? ["get_critical_nodes"] : undefined,
        })
      );
    }

    const allRecords = await recorder.readAll();
    expect(allRecords).toHaveLength(100);

    const summary = recorder.getSessionSummary();
    expect(summary.totalCalls).toBe(100);
    expect(summary.softRefuseCount).toBe(5);
    expect(summary.unlockCount).toBe(2);
    expect(summary.totalTokensSaved).toBe(95 * 10);
    expect(summary.totalTokensIn).toBe(95 * 25);

    const grouped = groupBySession(allRecords);
    expect(grouped.size).toBe(1);

    const sessionSummary = aggregateSession(allRecords)!;
    expect(sessionSummary.totalCalls).toBe(100);
    expect(sessionSummary.topTools.length).toBeLessThanOrEqual(10);
    expect(sessionSummary.outcomeBreakdown.executed).toBe(95);
    expect(sessionSummary.outcomeBreakdown.softRefused).toBe(5);
    expect(sessionSummary.avgLatencyMs).toBeGreaterThan(0);
  });
});

// ── readAllSessionMetrics from disk ──────────────────────────────

describe("readAllSessionMetrics", () => {
  it("reads current metrics.jsonl and produces summaries", async () => {
    const recorder = new RouterTelemetryRecorder(tempDir, "sess-disk-1");
    await recorder.append(makeRecord({ toolName: "search_code" }));
    await recorder.append(makeRecord({ toolName: "file_read" }));

    const recorder2 = new RouterTelemetryRecorder(tempDir, "sess-disk-2");
    await recorder2.append(makeRecord({ toolName: "get_entity" }));

    const summaries = await readAllSessionMetrics(tempDir);
    expect(summaries.length).toBe(2);
    const ids = summaries.map((s) => s.sessionId);
    expect(ids).toContain("sess-disk-1");
    expect(ids).toContain("sess-disk-2");
  });

  it("returns empty when no metrics exist", async () => {
    const summaries = await readAllSessionMetrics(tempDir);
    expect(summaries).toHaveLength(0);
  });
});
