import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BatchAck, CloudClient, CloudResult } from "../cloud/client.js";
import { hashEntityKey } from "../cloud/drainers/envelope.js";
import { buildEventsDrainers } from "../cloud/drainers/events.js";
import type { DrainerContext } from "../cloud/push-drainer.js";

// The HR-2 denylist mirror — no pushed detail key may match.
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

/** A metrics.db with only the behavior_events table the C3 path reads. */
function buildBehaviorDb(dir: string): void {
  const dbPath = join(dir, "metrics.db");
  const db = new Database(dbPath);
  // buildEventsDrainers prepares a SELECT for ALL five tables eagerly, so every
  // table must exist even though this test only drains the behavior one.
  db.exec(`
    CREATE TABLE behavior_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, ts_iso TEXT,
      session_id TEXT, pid INTEGER, turn INTEGER, agent TEXT, type TEXT,
      tool TEXT, entity_key TEXT, response_bytes INTEGER, detail TEXT
    );
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
  `);
  const iso = "2026-06-15T10:00:00.000Z";
  const ins = db.prepare(
    `INSERT INTO behavior_events
     (ts, ts_iso, session_id, pid, turn, agent, type, tool, entity_key, response_bytes, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // 1) decision_event classification
  ins.run(
    1,
    iso,
    "sess_a",
    100,
    1,
    "claude-code",
    "decision_classified",
    null,
    null,
    null,
    JSON.stringify({
      direction: "collab",
      task_type: "refactor",
      alternatives_count: 3,
      stakes: "high",
      // a real-key field that MUST be dropped (not in the allow-list)
      rationale: "should never reach the wire",
    })
  );

  // 2) edit_event classification — carries a real entity_key (denylisted)
  ins.run(
    2,
    iso,
    "sess_a",
    100,
    2,
    "claude-code",
    "edit_classified",
    "Edit",
    "src/proxy/proxy.ts:startProxy",
    2048,
    JSON.stringify({
      agent_authored: true,
      lines_added: 12,
      lines_removed: 4,
      reviewed_before_apply: false,
    })
  );

  // 3) task_completion classification
  ins.run(
    3,
    iso,
    "sess_a",
    100,
    3,
    "claude-code",
    "task_completed",
    null,
    null,
    null,
    JSON.stringify({
      task_type: "bugfix",
      iterations: 5,
      outcome: "merged",
      accepted_without_edit: false,
    })
  );

  // 4) line_survival_rollup classification (wire+drainer plumbed; producer stubbed)
  ins.run(
    4,
    iso,
    "sess_a",
    100,
    4,
    "unerr-cli",
    "line_survival_rollup",
    null,
    "src/intelligence/local-graph.ts:CozoGraphStore",
    null,
    JSON.stringify({
      authored_by: "ai",
      cohort_days: 30,
      lines_authored: 800,
      lines_still_present: 640,
    })
  );

  // 5) a plain behavior event with NO C3 detail — must emit only base fields
  ins.run(
    5,
    iso,
    "sess_a",
    100,
    5,
    "claude-code",
    "cascade_guard",
    "get_references",
    "src/foo.ts:bar",
    1024,
    null
  );

  db.close();
}

interface Pushed {
  rows: Array<Record<string, unknown>>;
}

function fakeCtx(dir: string): { ctx: DrainerContext; pushes: Pushed[] } {
  const pushes: Pushed[] = [];
  const client = {
    ingestEvents(events: unknown[]): Promise<CloudResult<BatchAck>> {
      pushes.push({ rows: events as Array<Record<string, unknown>> });
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
  } as unknown as DrainerContext;
  return { ctx, pushes };
}

async function drainBehavior(
  ctx: DrainerContext
): Promise<Array<Record<string, unknown>>> {
  const { drainers, dispose } = await buildEventsDrainers(ctx);
  const drainer = drainers.find((d) => d.key === "events:behavior");
  if (!drainer) throw new Error("no behavior drainer");
  const batch = await drainer.read({ lastId: 0 });
  dispose?.();
  return (batch?.rows ?? []) as Array<Record<string, unknown>>;
}

describe("c3 edge classification (behavior detail tail)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "c3-class-"));
    buildBehaviorDb(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("surfaces decision_event fields and drops un-listed detail keys", async () => {
    const { ctx } = fakeCtx(dir);
    const rows = await drainBehavior(ctx);
    const d = rows[0]?.detail as Record<string, unknown>;
    expect(d.direction).toBe("collab");
    expect(d.task_type).toBe("refactor");
    expect(d.alternatives_count).toBe(3);
    expect(d.stakes).toBe("high");
    // allow-list only — the free-form rationale must NOT ride along
    expect(d.rationale).toBeUndefined();
  });

  it("surfaces edit_event counts and hashes entity_key to entity_id", async () => {
    const { ctx } = fakeCtx(dir);
    const rows = await drainBehavior(ctx);
    const d = rows[1]?.detail as Record<string, unknown>;
    expect(d.agent_authored).toBe(true);
    expect(d.lines_added).toBe(12);
    expect(d.lines_removed).toBe(4);
    expect(d.reviewed_before_apply).toBe(false);
    // entity_key never on the wire; the hashed opaque id does, and is stable.
    expect(d.entity_key).toBeUndefined();
    expect(d.entity_id).toBe(hashEntityKey("src/proxy/proxy.ts:startProxy"));
    expect(typeof d.entity_id).toBe("string");
    expect((d.entity_id as string).length).toBe(16);
  });

  it("surfaces task_completion fields", async () => {
    const { ctx } = fakeCtx(dir);
    const rows = await drainBehavior(ctx);
    const d = rows[2]?.detail as Record<string, unknown>;
    expect(d.task_type).toBe("bugfix");
    expect(d.iterations).toBe(5);
    expect(d.outcome).toBe("merged");
    expect(d.accepted_without_edit).toBe(false);
  });

  it("surfaces line_survival_rollup fields (plumbing path)", async () => {
    const { ctx } = fakeCtx(dir);
    const rows = await drainBehavior(ctx);
    const d = rows[3]?.detail as Record<string, unknown>;
    expect(d.authored_by).toBe("ai");
    expect(d.cohort_days).toBe(30);
    expect(d.lines_authored).toBe(800);
    expect(d.lines_still_present).toBe(640);
  });

  it("emits only base fields for a behavior row with no C3 detail", async () => {
    const { ctx } = fakeCtx(dir);
    const rows = await drainBehavior(ctx);
    const d = rows[4]?.detail as Record<string, unknown>;
    expect(d.kind).toBe("cascade_guard");
    expect(d.tool).toBe("get_references");
    expect(d.response_bytes).toBe(1024);
    // entity_key hashed even on a plain row (powers per-entity rollups)
    expect(d.entity_id).toBe(hashEntityKey("src/foo.ts:bar"));
    // no C3 classification keys present
    expect(d.direction).toBeUndefined();
    expect(d.outcome).toBeUndefined();
  });

  it("every pushed detail key clears the HR-2 denylist", async () => {
    const { ctx } = fakeCtx(dir);
    const rows = await drainBehavior(ctx);
    for (const row of rows) {
      const d = row.detail as Record<string, unknown>;
      for (const key of Object.keys(d)) {
        expect(DENYLIST).not.toContain(key.toLowerCase());
      }
    }
  });

  it("schema_version is the current additive events bump 1-0-4", async () => {
    const { ctx } = fakeCtx(dir);
    const rows = await drainBehavior(ctx);
    expect(rows[0]?.schema_version).toBe("1-0-4");
  });

  it("hashEntityKey is deterministic and omits empty keys", () => {
    const key = "src/a.ts:fn";
    const expected = createHash("sha256")
      .update(key)
      .digest("hex")
      .slice(0, 16);
    expect(hashEntityKey(key)).toBe(expected);
    expect(hashEntityKey(null)).toBeUndefined();
    expect(hashEntityKey("")).toBeUndefined();
    expect(hashEntityKey(undefined)).toBeUndefined();
  });
});
