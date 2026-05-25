/**
 * ST-3b: Timeline HTTP routes — smoke test against the Hono app.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTimelineRoutes } from "../server/routes/timeline.js";
import { CozoTimelineStore } from "../timeline/timeline-store.js";
import type { LedgerEntry } from "../tracking/shadow-ledger.js";

let tempDir: string;
let store: CozoTimelineStore;

beforeEach(async () => {
  tempDir = join(
    tmpdir(),
    `unerr-rt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(join(tempDir, ".unerr"), { recursive: true });
  store = await CozoTimelineStore.create(tempDir);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function jsonOf(res: Response): Promise<unknown> {
  return await res.json();
}

describe("Timeline routes", () => {
  it("GET /health reports the db path", async () => {
    const app = createTimelineRoutes({ store });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await jsonOf(res)) as {
      data: { ok: boolean; db_path: string };
    };
    expect(body.data.ok).toBe(true);
    expect(body.data.db_path).toBe(store.dbPath);
  });

  it("GET /turns returns turns in newest-first order", async () => {
    await store.upsertTurn({
      turn_id: "t1",
      session_id: "s1",
      started_at: 100,
      ended_at: 200,
      opened_by: "first_call",
      closed_reason: "session_end",
      tool_count: 2,
      file_count: 1,
      edit_count: 0,
      title: "early",
      outcome: "unknown",
    });
    await store.upsertTurn({
      turn_id: "t2",
      session_id: "s1",
      started_at: 300,
      ended_at: 400,
      opened_by: "idle_gap",
      closed_reason: "idle_gap",
      tool_count: 5,
      file_count: 2,
      edit_count: 1,
      title: "late",
      outcome: "unknown",
    });
    const app = createTimelineRoutes({ store });
    const res = await app.request("/turns");
    const body = (await jsonOf(res)) as { data: Array<{ turn_id: string }> };
    expect(body.data.map((t) => t.turn_id)).toEqual(["t2", "t1"]);
  });

  it("GET /turns attaches each turn's originating prompt by timestamp (§5)", async () => {
    await store.upsertTurn({
      turn_id: "t1",
      session_id: "s1",
      started_at: 1000,
      ended_at: 2000,
      opened_by: "first_call",
      closed_reason: "session_end",
      tool_count: 2,
      file_count: 1,
      edit_count: 0,
      title: "early",
      outcome: "unknown",
    });
    await store.upsertTurn({
      turn_id: "t2",
      session_id: "s1",
      started_at: 3000,
      ended_at: 4000,
      opened_by: "idle_gap",
      closed_reason: "idle_gap",
      tool_count: 5,
      file_count: 2,
      edit_count: 1,
      title: "late",
      outcome: "unknown",
    });
    // The hook fires just before a turn opens, so prompt ts ≈ started_at:
    // 900 is just before t1; 2500 is in the gap before t2.
    const prompts = [
      {
        session_id: "s1",
        turn: 0,
        prompt: "fix the auth bug",
        length: 16,
        classified_as: "fix",
        ts: new Date(900).toISOString(),
      },
      {
        session_id: "s1",
        turn: 0,
        prompt: null, // content capture off — row exists, verbatim withheld
        length: 13,
        classified_as: "build",
        ts: new Date(2500).toISOString(),
      },
    ];
    const app = createTimelineRoutes({
      store,
      getPromptsForSession: (sid) => (sid === "s1" ? prompts : []),
    });
    const res = await app.request("/turns");
    const body = (await jsonOf(res)) as {
      data: Array<{
        turn_id: string;
        prompt: { prompt: string | null } | null;
      }>;
    };
    const byId = Object.fromEntries(
      body.data.map((t) => [t.turn_id, t.prompt])
    );
    expect(byId.t1?.prompt).toBe("fix the auth bug");
    // capture-off row still attaches (so the UI shows the enable hint), but
    // the verbatim text is null.
    expect(byId.t2).not.toBeNull();
    expect(byId.t2?.prompt).toBeNull();
  });

  it("GET /turns leaves prompt absent when no capture getter is wired", async () => {
    await store.upsertTurn({
      turn_id: "t1",
      session_id: "s1",
      started_at: 1000,
      ended_at: 2000,
      opened_by: "first_call",
      closed_reason: "session_end",
      tool_count: 1,
      file_count: 0,
      edit_count: 0,
      title: "early",
      outcome: "unknown",
    });
    const app = createTimelineRoutes({ store });
    const res = await app.request("/turns");
    const body = (await jsonOf(res)) as {
      data: Array<{ turn_id: string; prompt?: unknown }>;
    };
    expect(body.data[0]?.prompt ?? null).toBeNull();
  });

  it("GET /loops uses the ledger getter for live detection", async () => {
    const t = (offsetSec: number) =>
      new Date(
        Date.parse("2026-05-12T10:00:00Z") + offsetSec * 1000
      ).toISOString();
    let id = 0;
    const make = (tool: string, file: string, ts: string): LedgerEntry => {
      id += 1;
      return {
        id: `e${id}`,
        ts,
        tool,
        args_summary: { file_path: file },
        result_summary: {},
        branch: "main",
        head_sha: "x",
        session_id: "s1",
        correlation_id: null,
      };
    };
    const entries: LedgerEntry[] = [
      make("file_read", "a.ts", t(0)),
      make("file_read", "a.ts", t(10)),
      make("file_read", "a.ts", t(20)),
      make("file_read", "a.ts", t(30)),
      make("file_read", "a.ts", t(40)),
    ];
    const app = createTimelineRoutes({
      store,
      getRecentLedgerEntries: () => entries,
    });
    const res = await app.request("/loops");
    const body = (await jsonOf(res)) as { data: Array<{ kind: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.kind).toBe("file_reread");
  });

  it("GET /resume returns null when no recent turn exists", async () => {
    const app = createTimelineRoutes({ store });
    const res = await app.request("/resume");
    const body = (await jsonOf(res)) as { data: unknown };
    expect(body.data).toBeNull();
  });

  it("GET /resume surfaces dominant intent + open blockers for the latest fresh turn", async () => {
    const now = Date.now();
    await store.upsertTurn({
      turn_id: "tx",
      session_id: "sx",
      started_at: now - 60_000,
      ended_at: now - 30_000,
      opened_by: "first_call",
      closed_reason: "session_end",
      tool_count: 3,
      file_count: 1,
      edit_count: 0,
      title: "auth refactor",
      outcome: "unknown",
    });
    await store.insertMarker({
      marker_id: "i1",
      type: "mark_intent",
      text: "harden auth flow",
      session_id: "sx",
      turn_id: "tx",
      ts: now - 50_000,
      blocker_ref: "",
      file_path: "",
    });
    await store.insertMarker({
      marker_id: "b1",
      type: "mark_blocker",
      text: "type error in verify",
      session_id: "sx",
      turn_id: "tx",
      ts: now - 40_000,
      blocker_ref: "",
      file_path: "src/auth.ts",
    });

    const app = createTimelineRoutes({ store });
    const res = await app.request("/resume");
    const body = (await jsonOf(res)) as {
      data: {
        intent: string;
        open_threads: Array<{ text: string }>;
        session_id: string;
      };
    };
    expect(body.data.intent).toBe("harden auth flow");
    expect(body.data.session_id).toBe("sx");
    expect(body.data.open_threads.map((t) => t.text)).toContain(
      "type error in verify"
    );
  });
});
