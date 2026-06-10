import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeMetricsStore,
  openMetricsStore,
} from "../tracking/metrics-store.js";

describe("MetricsStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(os.tmpdir(), `unerr-metrics-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    closeMetricsStore(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates metrics.db on first open and is idempotent", () => {
    openMetricsStore(dir);
    expect(existsSync(join(dir, "metrics.db"))).toBe(true);
    // Re-opening returns the same instance (no error)
    expect(openMetricsStore(dir)).toBe(openMetricsStore(dir));
  });

  it("upgrades a legacy DB (no `agent` column) without crashing", async () => {
    // Reproduce the failure mode reported by the user: an existing
    // metrics.db created before the `agent` column shipped. The SCHEMA
    // can't create the agent index until reconcileAdditiveColumns has
    // added the column to the legacy table — ordering bug must not
    // resurface.
    const Database = (await import("better-sqlite3")).default;
    const dbPath = join(dir, "metrics.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE token_flow_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        ts_iso TEXT NOT NULL,
        session_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        turn INTEGER NOT NULL,
        mechanism TEXT NOT NULL,
        tool TEXT,
        tokens_without INTEGER NOT NULL,
        tokens_with INTEGER NOT NULL,
        tokens_saved INTEGER NOT NULL,
        detail TEXT
      );
      CREATE TABLE behavior_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        ts_iso TEXT NOT NULL,
        session_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        turn INTEGER NOT NULL,
        type TEXT NOT NULL,
        tool TEXT,
        entity_key TEXT,
        response_bytes INTEGER,
        detail TEXT
      );
    `);
    legacy.close();

    // Opening MUST succeed — adds the agent column and the index that
    // depends on it.
    const s = openMetricsStore(dir);
    s.insertTokenFlow({
      ts: Date.now(),
      ts_iso: new Date().toISOString(),
      session_id: "legacy",
      pid: 1,
      turn: 1,
      mechanism: "graph_query",
      tool: "search_code",
      tokens_without: 100,
      tokens_with: 10,
      tokens_saved: 90,
      detail: null,
    });
    const rows = s.tokenFlowBySession("legacy");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent).toBe("unknown");
  });

  it("inserts + reads compression events with monotonic id", () => {
    const s = openMetricsStore(dir);
    const id1 = s.insertCompression({
      ts: Date.now(),
      ts_iso: new Date().toISOString(),
      command: "ls",
      category: "log_text",
      confidence: 0.9,
      raw_bytes: 1024,
      compressed_bytes: 512,
      saved_pct: 50,
      omni_fallback: 0,
      tee_file: null,
    });
    const id2 = s.insertCompression({
      ts: Date.now() + 1,
      ts_iso: new Date().toISOString(),
      command: "ps",
      category: "tabular",
      confidence: 0.95,
      raw_bytes: 2048,
      compressed_bytes: 256,
      saved_pct: 87.5,
      omni_fallback: 0,
      tee_file: ".unerr/tee/foo.txt",
    });
    expect(id2).toBeGreaterThan(id1);

    const recent = s.recentCompression(10);
    expect(recent).toHaveLength(2);
    // ORDER BY id DESC — newest first
    expect(recent[0]?.command).toBe("ps");
    expect(recent[1]?.command).toBe("ls");
  });

  it("supports id > lastSeen polling for compression", () => {
    const s = openMetricsStore(dir);
    for (let i = 0; i < 3; i++) {
      s.insertCompression({
        ts: Date.now() + i,
        ts_iso: new Date().toISOString(),
        command: `cmd-${i}`,
        category: "log_text",
        confidence: 0.9,
        raw_bytes: 100,
        compressed_bytes: 50,
        saved_pct: 50,
        omni_fallback: 0,
        tee_file: null,
      });
    }
    const all = s.compressionSince(0);
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.command)).toEqual(["cmd-0", "cmd-1", "cmd-2"]);

    const afterFirst = s.compressionSince(all[0]!.id);
    expect(afterFirst).toHaveLength(2);
    expect(afterFirst[0]?.command).toBe("cmd-1");
  });

  it("inserts + reads file_read events", () => {
    const s = openMetricsStore(dir);
    s.insertFileRead({
      ts: Date.now(),
      ts_iso: new Date().toISOString(),
      file: "src/foo.ts",
      mode: "outline",
      total_lines: 500,
      returned_lines: 30,
      saved_pct: 94,
      entity: null,
      token_estimate: 200,
    });
    const all = s.fileReadsSince(0);
    expect(all).toHaveLength(1);
    expect(all[0]?.file).toBe("src/foo.ts");
    expect(all[0]?.mode).toBe("outline");
  });

  it("inserts + reads token_flow events; filters by session", () => {
    const s = openMetricsStore(dir);
    s.insertTokenFlow({
      ts: Date.now(),
      ts_iso: new Date().toISOString(),
      session_id: "s-1",
      pid: 1234,
      turn: 1,
      mechanism: "graph_query",
      tool: "search_code",
      tokens_without: 1000,
      tokens_with: 200,
      tokens_saved: 800,
      detail: JSON.stringify({ query: "foo" }),
    });
    s.insertTokenFlow({
      ts: Date.now() + 1,
      ts_iso: new Date().toISOString(),
      session_id: "s-2",
      pid: 1234,
      turn: 1,
      mechanism: "shell_compression",
      tool: null,
      tokens_without: 5000,
      tokens_with: 500,
      tokens_saved: 4500,
      detail: null,
    });
    expect(s.allTokenFlow()).toHaveLength(2);
    expect(s.tokenFlowBySession("s-1")).toHaveLength(1);
    expect(s.tokenFlowBySession("s-2")[0]?.mechanism).toBe("shell_compression");
  });

  it("sums tokens_saved per session (authoritative cumulative)", () => {
    const s = openMetricsStore(dir);
    const base = {
      ts: Date.now(),
      ts_iso: new Date().toISOString(),
      pid: 1234,
      turn: 0,
      mechanism: "shell_compression",
      tool: null,
      tokens_without: 0,
      tokens_with: 0,
      detail: null,
    };
    s.insertTokenFlow({ ...base, session_id: "sum-a", tokens_saved: 800 });
    s.insertTokenFlow({ ...base, session_id: "sum-a", tokens_saved: 4500 });
    s.insertTokenFlow({ ...base, session_id: "sum-b", tokens_saved: 100 });
    expect(s.sessionTokensSaved("sum-a")).toBe(5300);
    expect(s.sessionTokensSaved("sum-b")).toBe(100);
    expect(s.sessionTokensSaved("missing")).toBe(0);
  });

  it("upserts session_history (one row per session_id)", () => {
    const s = openMetricsStore(dir);
    s.upsertSessionHistory({
      session_id: "s-1",
      started_at: "2026-05-12T10:00:00Z",
      ended_at: "2026-05-12T10:30:00Z",
      duration_ms: 1_800_000,
      tool_calls: 50,
      tokens_saved: 12000,
      tokens_processed: 50000,
      efficiency: 24,
      model_id: "claude-opus-4-7",
      entity_count: 30,
      agent_name: "claude-code",
      token_flow_summary: null,
    });
    // Second upsert for the same session_id should update, not append.
    s.upsertSessionHistory({
      session_id: "s-1",
      started_at: "2026-05-12T10:00:00Z",
      ended_at: "2026-05-12T11:00:00Z",
      duration_ms: 3_600_000,
      tool_calls: 80,
      tokens_saved: 20000,
      tokens_processed: 80000,
      efficiency: 25,
      model_id: "claude-opus-4-7",
      entity_count: 45,
      agent_name: "claude-code",
      token_flow_summary: JSON.stringify({ top_mechanism: "graph_query" }),
    });
    const all = s.allSessionHistory();
    expect(all).toHaveLength(1);
    expect(all[0]?.tool_calls).toBe(80);
    expect(all[0]?.duration_ms).toBe(3_600_000);
  });

  it("upserts session_summary and reads by id", () => {
    const s = openMetricsStore(dir);
    s.upsertSessionSummary({
      session_id: "sum-1",
      written_at: "2026-05-12T10:30:00Z",
      started_at: "2026-05-12T10:00:00Z",
      ended_at: "2026-05-12T10:30:00Z",
      duration_ms: 1_800_000,
      tool_calls: 50,
      chains: 5,
      files_modified: JSON.stringify(["a.ts", "b.ts"]),
      entities_touched: JSON.stringify(["fooFn", "barClass"]),
      tools_used: JSON.stringify({ search_code: 10, file_read: 20 }),
      feature_areas: JSON.stringify(["intelligence"]),
      facts_recorded: 2,
      facts_surfaced: JSON.stringify(["f-1"]),
      revert_count: 0,
      rot_score: 0.1,
      token_estimate: 50000,
      branch: "main",
    });
    const r = s.sessionSummary("sum-1");
    expect(r?.session_id).toBe("sum-1");
    expect(r?.chains).toBe(5);
    expect(JSON.parse(r!.files_modified)).toEqual(["a.ts", "b.ts"]);

    expect(s.sessionSummary("never-existed")).toBeNull();
  });

  it("reset() empties tables and resets autoincrement", () => {
    const s = openMetricsStore(dir);
    s.insertCompression({
      ts: Date.now(),
      ts_iso: new Date().toISOString(),
      command: "x",
      category: "log_text",
      confidence: 1,
      raw_bytes: 1,
      compressed_bytes: 1,
      saved_pct: 0,
      omni_fallback: 0,
      tee_file: null,
    });
    s.reset();
    expect(s.recentCompression(10)).toEqual([]);
    const firstAfterReset = s.insertCompression({
      ts: Date.now(),
      ts_iso: new Date().toISOString(),
      command: "y",
      category: "log_text",
      confidence: 1,
      raw_bytes: 1,
      compressed_bytes: 1,
      saved_pct: 0,
      omni_fallback: 0,
      tee_file: null,
    });
    expect(firstAfterReset).toBe(1);
  });
});
