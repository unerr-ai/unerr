import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BatchAck, CloudClient, CloudResult } from "../cloud/client.js";
import { hashEntityKey } from "../cloud/drainers/envelope.js";
import { buildEventsDrainers } from "../cloud/drainers/events.js";
import type { DrainerContext } from "../cloud/push-drainer.js";

// The exact HR-2 denylist (mirror of envelope.ts) — no pushed detail key may match.
const DENYLIST = [
  "content",
  "code",
  "diff",
  "patch",
  "snippet",
  "source",
  "raw",
  "raw_text",
  "path",
  "file",
  "filename",
  "filepath",
  "dir",
  "directory",
  "entity",
  "entity_key",
  "command",
  "cmd",
  "prompt",
  "prompts",
  "text",
  "body",
  "message",
  "msg",
  "query",
  "input",
  "output",
  "completion",
  "transcript",
  "secret",
  "password",
  "credential",
  "token",
  "api_key",
  "email",
];

/** Build a metrics.db with the columns the events drainers read. */
function buildMetricsDb(dir: string): string {
  const dbPath = join(dir, "metrics.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE token_flow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, ts_iso TEXT,
      session_id TEXT, pid INTEGER, turn INTEGER, agent TEXT, mechanism TEXT,
      tool TEXT, tokens_without INTEGER, tokens_with INTEGER,
      tokens_saved INTEGER, detail TEXT
    );
    CREATE TABLE compression_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, ts_iso TEXT,
      command TEXT, category TEXT, confidence REAL, raw_bytes INTEGER,
      compressed_bytes INTEGER, saved_pct REAL, omni_fallback INTEGER,
      tee_file TEXT, original_tokens INTEGER, delivered_tokens INTEGER,
      mechanism TEXT, cache_hit INTEGER, event_kind TEXT
    );
    CREATE TABLE behavior_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, ts_iso TEXT,
      session_id TEXT, pid INTEGER, turn INTEGER, agent TEXT, type TEXT,
      tool TEXT, entity_key TEXT, response_bytes INTEGER, detail TEXT
    );
    CREATE TABLE file_read_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, ts_iso TEXT,
      file TEXT, mode TEXT, total_lines INTEGER, returned_lines INTEGER,
      saved_pct REAL, entity TEXT, token_estimate INTEGER
    );
    CREATE TABLE session_summaries (
      session_id TEXT PRIMARY KEY, written_at TEXT, started_at TEXT,
      ended_at TEXT, duration_ms INTEGER, tool_calls INTEGER, chains INTEGER,
      files_modified TEXT, entities_touched TEXT, tools_used TEXT,
      feature_areas TEXT, facts_recorded INTEGER, facts_surfaced TEXT,
      revert_count INTEGER, rot_score REAL, token_estimate INTEGER, branch TEXT
    );
    CREATE TABLE repo_activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_iso TEXT NOT NULL,
      session_id TEXT, native_session_id TEXT, turn INTEGER, agent TEXT,
      action TEXT NOT NULL, at TEXT NOT NULL, profile TEXT, tool_use_id TEXT
    );
  `);

  const raIso = "2026-06-15T11:00:00.000Z";
  db.prepare(
    `INSERT INTO repo_activity_events
     (ts, ts_iso, session_id, native_session_id, turn, agent, action, at, profile, tool_use_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    Date.parse(raIso),
    raIso,
    "sess_a",
    null,
    null,
    "claude-code",
    "started",
    raIso,
    JSON.stringify({
      entity_count: 1200,
      edge_count: 3400,
      file_count: 210,
      languages: ["typescript", "javascript"],
      convention_count: 14,
      fact_count: 7,
      drift_count: 2,
      top_domains: ["cloud", "intelligence"],
      indexed_at: raIso,
    }),
    null
  );

  const tfIso = "2026-06-15T10:00:00.000Z";
  db.prepare(
    `INSERT INTO token_flow_events
     (ts, ts_iso, session_id, pid, turn, agent, mechanism, tool, tokens_without, tokens_with, tokens_saved, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    1,
    tfIso,
    "sess_a",
    100,
    3,
    "claude-code",
    "graph",
    "search_code",
    5000,
    3160,
    1840,
    null
  );
  db.prepare(
    `INSERT INTO token_flow_events
     (ts, ts_iso, session_id, pid, turn, agent, mechanism, tool, tokens_without, tokens_with, tokens_saved, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    2,
    tfIso,
    "sess_a",
    100,
    4,
    "claude-code",
    "compress",
    null,
    2000,
    1500,
    500,
    null
  );

  db.prepare(
    `INSERT INTO compression_events
     (ts, ts_iso, command, category, confidence, raw_bytes, compressed_bytes, saved_pct, omni_fallback, tee_file, original_tokens, delivered_tokens, mechanism, cache_hit, event_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    3,
    tfIso,
    "git diff",
    "shell",
    0.9,
    10000,
    4000,
    60,
    0,
    "/tmp/x",
    900,
    400,
    "shell",
    1,
    "compress"
  );

  db.prepare(
    `INSERT INTO behavior_events
     (ts, ts_iso, session_id, pid, turn, agent, type, tool, entity_key, response_bytes, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    4,
    tfIso,
    "sess_a",
    100,
    5,
    "claude-code",
    "cascade_guard",
    "get_references",
    "src/foo.ts:bar",
    2048,
    null
  );

  db.prepare(
    `INSERT INTO file_read_events
     (ts, ts_iso, file, mode, total_lines, returned_lines, saved_pct, entity, token_estimate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    5,
    tfIso,
    "/Users/x/secret-path.ts",
    "explore",
    500,
    50,
    90,
    "secretEntity",
    1200
  );

  db.prepare(
    `INSERT INTO session_summaries
     (session_id, written_at, started_at, ended_at, duration_ms, tool_calls, chains, files_modified, entities_touched, tools_used, feature_areas, facts_recorded, facts_surfaced, revert_count, rot_score, token_estimate, branch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "sess_a",
    "2026-06-15T10:05:00.000Z",
    "2026-06-15T09:00:00.000Z",
    "2026-06-15T10:05:00.000Z",
    3900000,
    42,
    3,
    "[]",
    "[]",
    "{}",
    "[]",
    1,
    "[]",
    0,
    0.1,
    5000,
    "main"
  );

  db.close();
  return dbPath;
}

interface Pushed {
  key: string;
  rows: Array<Record<string, unknown>>;
}

/** Fake CloudClient whose ingestEvents records what was pushed and acks all. */
function fakeCtx(dir: string): { ctx: DrainerContext; pushes: Pushed[] } {
  const pushes: Pushed[] = [];
  const client = {
    ingestEvents(events: unknown[]): Promise<CloudResult<BatchAck>> {
      pushes.push({
        key: "events",
        rows: events as Array<Record<string, unknown>>,
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        data: { accepted: events.length, rejected: 0 },
      });
    },
  } as unknown as CloudClient;
  const ctx: DrainerContext = {
    repoPath: dir,
    unerrDir: dir,
    repoId: "repo_hash_abc",
    client,
    source: "unerr-cli@test",
  };
  return { ctx, pushes };
}

describe("c1 events drainer", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "c1-events-"));
    buildMetricsDb(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("opens six drainers with the registered cursor keys", async () => {
    const { ctx } = fakeCtx(dir);
    const set = await buildEventsDrainers(ctx);
    const keys = set.drainers.map((d) => d.key).sort();
    expect(keys).toEqual([
      "events:behavior",
      "events:compression",
      "events:file_read",
      "events:repo_activity",
      "events:session_summary",
      "events:token_flow",
    ]);
    set.dispose?.();
  });

  it("maps repo_activity rows with action, at, and the parsed profile", async () => {
    const { ctx } = fakeCtx(dir);
    const set = await buildEventsDrainers(ctx);
    const d = set.drainers.find((x) => x.key === "events:repo_activity")!;

    const batch = await d.read({});
    expect(batch).not.toBeNull();
    expect(batch!.rows).toHaveLength(1);
    expect(batch!.next.lastId).toBe(1);

    const r = batch!.rows[0] as Record<string, unknown>;
    expect(r.type).toBe("repo_activity");
    expect(r.repo).toBe("repo_hash_abc");
    expect(r.agent).toBe("claude-code");
    expect(r.ts).toBe("2026-06-15T11:00:00.000Z");
    expect(r.session_id).toBe("sess_a");
    const detail = r.detail as Record<string, unknown>;
    expect(detail.action).toBe("started");
    expect(detail.at).toBe("2026-06-15T11:00:00.000Z");
    expect(detail.profile).toEqual({
      entity_count: 1200,
      edge_count: 3400,
      file_count: 210,
      languages: ["typescript", "javascript"],
      convention_count: 14,
      fact_count: 7,
      drift_count: 2,
      top_domains: ["cloud", "intelligence"],
      indexed_at: "2026-06-15T11:00:00.000Z",
    });

    expect(await d.read({ lastId: 1 })).toBeNull();
    set.dispose?.();
  });

  it("repo_activity drainer is a no-op when the table is absent (legacy db)", async () => {
    const legacy = mkdtempSync(join(tmpdir(), "c1-events-legacy-"));
    try {
      const dbPath = join(legacy, "metrics.db");
      const db = new Database(dbPath);
      // A legacy db that predates repo_activity_events: it still has the older
      // tables (session_summaries' drainer prepares unconditionally), just not
      // the new one.
      db.exec(`CREATE TABLE token_flow_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, ts_iso TEXT,
        session_id TEXT, pid INTEGER, turn INTEGER, agent TEXT, mechanism TEXT,
        tool TEXT, tokens_without INTEGER, tokens_with INTEGER,
        tokens_saved INTEGER, detail TEXT
      );
      CREATE TABLE session_summaries (
        session_id TEXT PRIMARY KEY, written_at TEXT, started_at TEXT,
        ended_at TEXT, duration_ms INTEGER, tool_calls INTEGER, chains INTEGER,
        files_modified TEXT, entities_touched TEXT, tools_used TEXT,
        feature_areas TEXT, facts_recorded INTEGER, facts_surfaced TEXT,
        revert_count INTEGER, rot_score REAL, token_estimate INTEGER, branch TEXT
      );`);
      db.close();

      const { ctx } = fakeCtx(legacy);
      const set = await buildEventsDrainers(ctx);
      const d = set.drainers.find((x) => x.key === "events:repo_activity")!;
      // No-op read — never throws on the missing table.
      expect(await d.read({})).toBeNull();
      set.dispose?.();
    } finally {
      rmSync(legacy, { recursive: true, force: true });
    }
  });

  it("returns no drainers when metrics.db does not exist", async () => {
    const empty = mkdtempSync(join(tmpdir(), "c1-events-empty-"));
    try {
      const { ctx } = fakeCtx(empty);
      const set = await buildEventsDrainers(ctx);
      expect(set.drainers).toHaveLength(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("maps token_flow rows with correct type, detail, and advances cursor by max id", async () => {
    const { ctx } = fakeCtx(dir);
    const set = await buildEventsDrainers(ctx);
    const d = set.drainers.find((x) => x.key === "events:token_flow")!;

    const batch = await d.read({});
    expect(batch).not.toBeNull();
    expect(batch!.rows).toHaveLength(2);
    expect(batch!.next.lastId).toBe(2);

    const r0 = batch!.rows[0] as Record<string, unknown>;
    expect(r0.type).toBe("token_flow");
    expect(r0.repo).toBe("repo_hash_abc");
    expect(r0.agent).toBe("claude-code");
    expect(r0.ts).toBe("2026-06-15T10:00:00.000Z");
    expect(r0.session_id).toBe("sess_a");
    expect(r0.turn).toBe(3);
    expect(r0.detail).toEqual({
      mechanism: "graph",
      tool: "search_code",
      tokens_saved: 1840,
    });

    // Second push: cursor at lastId=2 → nothing pending.
    expect(await d.read({ lastId: 2 })).toBeNull();
    set.dispose?.();
  });

  it("maps compression rows and computes tokens_saved from token columns", async () => {
    const { ctx } = fakeCtx(dir);
    const set = await buildEventsDrainers(ctx);
    const d = set.drainers.find((x) => x.key === "events:compression")!;
    const batch = await d.read({});
    const r = batch!.rows[0] as Record<string, unknown>;
    expect(r.type).toBe("compression");
    const detail = r.detail as Record<string, unknown>;
    expect(detail.category).toBe("shell");
    expect(detail.cache_hit).toBe(true);
    expect(detail.tokens_saved).toBe(500); // 900 - 400
    expect(detail.raw_bytes).toBe(10000);
    set.dispose?.();
  });

  it("maps behavior rows with kind from the type column", async () => {
    const { ctx } = fakeCtx(dir);
    const set = await buildEventsDrainers(ctx);
    const d = set.drainers.find((x) => x.key === "events:behavior")!;
    const batch = await d.read({});
    const r = batch!.rows[0] as Record<string, unknown>;
    expect(r.type).toBe("behavior");
    // entity_key ("src/foo.ts:bar") is denylisted; the behavior mapper hashes
    // it to an opaque entity_id (C3 edge-classification path) so per-entity
    // rollups group without the real key/path leaving the machine.
    expect(r.detail).toEqual({
      kind: "cascade_guard",
      tool: "get_references",
      response_bytes: 2048,
      entity_id: hashEntityKey("src/foo.ts:bar"),
    });
    set.dispose?.();
  });

  it("never sends file/entity columns from file_read rows", async () => {
    const { ctx } = fakeCtx(dir);
    const set = await buildEventsDrainers(ctx);
    const d = set.drainers.find((x) => x.key === "events:file_read")!;
    const batch = await d.read({});
    const r = batch!.rows[0] as Record<string, unknown>;
    const detail = r.detail as Record<string, unknown>;
    expect(detail).toEqual({
      mode: "explore",
      total_lines: 500,
      returned_lines: 50,
      saved_pct: 90,
      token_estimate: 1200,
    });
    expect(JSON.stringify(r)).not.toContain("secret-path");
    expect(JSON.stringify(r)).not.toContain("secretEntity");
    set.dispose?.();
  });

  it("maps session_summary rows keyed by written_at and token_estimate→tokens_processed", async () => {
    const { ctx } = fakeCtx(dir);
    const set = await buildEventsDrainers(ctx);
    const d = set.drainers.find((x) => x.key === "events:session_summary")!;
    const batch = await d.read({});
    expect(batch).not.toBeNull();
    const r = batch!.rows[0] as Record<string, unknown>;
    expect(r.type).toBe("session_summary");
    expect(r.session_id).toBe("sess_a");
    expect(r.ts).toBe("2026-06-15T10:05:00.000Z");
    expect(r.detail).toEqual({
      duration_ms: 3900000,
      tool_calls: 42,
      tokens_processed: 5000,
    });
    // Cursor is epoch-ms of written_at; re-read past it → null.
    expect(batch!.next.lastId).toBe(Date.parse("2026-06-15T10:05:00.000Z"));
    expect(await d.read({ lastId: batch!.next.lastId })).toBeNull();
    set.dispose?.();
  });

  it("event_id is deterministic across two builds (same row → same id)", async () => {
    const { ctx: ctx1 } = fakeCtx(dir);
    const set1 = await buildEventsDrainers(ctx1);
    const b1 = await set1.drainers
      .find((x) => x.key === "events:token_flow")!
      .read({});
    set1.dispose?.();

    const { ctx: ctx2 } = fakeCtx(dir);
    const set2 = await buildEventsDrainers(ctx2);
    const b2 = await set2.drainers
      .find((x) => x.key === "events:token_flow")!
      .read({});
    set2.dispose?.();

    const id1 = (b1!.rows[0] as Record<string, unknown>).event_id;
    const id2 = (b2!.rows[0] as Record<string, unknown>).event_id;
    expect(id1).toBe(id2);
    expect(typeof id1).toBe("string");
    // Different rows → different ids.
    const idOther = (b1!.rows[1] as Record<string, unknown>).event_id;
    expect(id1).not.toBe(idOther);
  });

  it("push routes through ingestEvents and acks", async () => {
    const { ctx, pushes } = fakeCtx(dir);
    const set = await buildEventsDrainers(ctx);
    const d = set.drainers.find((x) => x.key === "events:token_flow")!;
    const batch = await d.read({});
    const res = await d.push(batch!.rows);
    expect(res.ok).toBe(true);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.rows).toHaveLength(2);
    set.dispose?.();
  });

  it("no pushed detail key matches the HR-2 denylist (all streams)", async () => {
    const { ctx } = fakeCtx(dir);
    const set = await buildEventsDrainers(ctx);
    for (const d of set.drainers) {
      const batch = await d.read({});
      if (!batch) continue;
      for (const row of batch.rows as Array<Record<string, unknown>>) {
        const detail = row.detail as Record<string, unknown>;
        for (const key of Object.keys(detail)) {
          expect(DENYLIST).not.toContain(key.toLowerCase());
        }
      }
    }
    set.dispose?.();
  });

  it("dispose closes the readonly db connection", async () => {
    const { ctx } = fakeCtx(dir);
    const set = await buildEventsDrainers(ctx);
    expect(set.dispose).toBeDefined();
    // After dispose, a read against the closed handle throws.
    set.dispose?.();
    const d = set.drainers.find((x) => x.key === "events:token_flow")!;
    await expect(d.read({})).rejects.toThrow();
  });
});
