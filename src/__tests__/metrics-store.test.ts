import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeMetricsStore,
  openMetricsStore,
} from "../tracking/metrics-store.js";

describe("MetricsStore", () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    // The store derives repoRoot = dirname(unerrDir) and writes its JSONL
    // event store under `<repoRoot>/.unerr/events`. Pass a `.unerr` dir under a
    // unique parent so each test's repoRoot — and therefore its event store —
    // is isolated. (A bare tmpdir path would collapse every test's repoRoot to
    // os.tmpdir(), sharing one event store and inflating read counts.)
    root = join(os.tmpdir(), `unerr-metrics-${Date.now()}-${Math.random()}`);
    dir = join(root, ".unerr");
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    closeMetricsStore(dir);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not create metrics.db (telemetry is JSONL now) and open is idempotent", () => {
    openMetricsStore(dir);
    // rev-3 cutover: telemetry + the transcript cache are JSONL under
    // .unerr/events/ — opening the store no longer creates a SQLite metrics.db.
    expect(existsSync(join(dir, "metrics.db"))).toBe(false);
    // Re-opening returns the same instance (no error)
    expect(openMetricsStore(dir)).toBe(openMetricsStore(dir));
  });

  it("ignores a leftover legacy metrics.db and round-trips via JSONL", async () => {
    // metrics.db (SQLite) is retired: telemetry is JSONL under .unerr/events.
    // A stale metrics.db left by an old version must be tolerated — the store
    // never opens it, and inserts still round-trip through the JSONL path. We
    // create the legacy file with node:sqlite (the only SQLite driver now) just
    // to prove its mere presence does not break open / insert / read.
    const { DatabaseSync: Database } = await import("node:sqlite");
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
      CREATE TABLE file_read_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        ts_iso TEXT NOT NULL,
        file TEXT NOT NULL,
        mode TEXT NOT NULL,
        total_lines INTEGER NOT NULL,
        returned_lines INTEGER NOT NULL,
        saved_pct REAL NOT NULL,
        entity TEXT,
        token_estimate INTEGER
      );
    `);
    legacy.close();

    // Opening MUST succeed and ignore the legacy file entirely.
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

    // A file-read insert carrying session_id must round-trip through JSONL.
    s.insertFileRead({
      ts: Date.now(),
      ts_iso: new Date().toISOString(),
      session_id: "legacy",
      file: "src/foo.ts",
      mode: "outline",
      total_lines: 500,
      returned_lines: 30,
      saved_pct: 94,
      entity: null,
      token_estimate: 200,
    });
    const reads = s.fileReadsSince(0);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.file).toBe("src/foo.ts");
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

  it("routes a modeled mechanism (context_bundle) to modeledSavedTotal, not tokenFlowTotal", () => {
    const s = openMetricsStore(dir);
    const base = {
      ts: Date.now(),
      ts_iso: new Date().toISOString(),
      session_id: "mod-1",
      pid: 1,
      turn: 1,
      tool: null,
      tokens_without: 0,
      tokens_with: 0,
      detail: null,
    };
    // A measured graph_query saving feeds the headline counter.
    s.insertTokenFlow({ ...base, mechanism: "graph_query", tokens_saved: 900 });
    // A modeled context_bundle saving feeds ONLY the modeled counter.
    s.insertTokenFlow({
      ...base,
      mechanism: "context_bundle",
      tokens_saved: 20000,
    });
    expect(s.tokenFlowTotal()).toBe(900);
    expect(s.modeledSavedTotal()).toBe(20000);
    // The per-session sum (used by the session footer) still includes both —
    // the split only governs which durable counter the saving lands in.
    expect(s.sessionTokensSaved("mod-1")).toBe(20900);
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
