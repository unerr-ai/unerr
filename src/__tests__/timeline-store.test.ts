/**
 * ST-1b: CozoTimelineStore — third CozoDB instance at `.unerr/timeline.db`.
 * Tests cover open/init, idempotence, and round-trip CRUD on turns.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CozoTimelineStore, type TurnRow } from "../timeline/timeline-store.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `unerr-tl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeTurn(overrides: Partial<TurnRow> = {}): TurnRow {
  return {
    turn_id: overrides.turn_id ?? "t1",
    session_id: overrides.session_id ?? "s1",
    started_at: overrides.started_at ?? 1000,
    ended_at: overrides.ended_at ?? 2000,
    opened_by: overrides.opened_by ?? "first_call",
    closed_reason: overrides.closed_reason ?? "session_end",
    tool_count: overrides.tool_count ?? 3,
    file_count: overrides.file_count ?? 2,
    edit_count: overrides.edit_count ?? 1,
    title: overrides.title ?? "",
    outcome: overrides.outcome ?? "unknown",
  };
}

describe("CozoTimelineStore", () => {
  it("creates .unerr/timeline.db on first call and reports isNew=true", async () => {
    const store = await CozoTimelineStore.create(tempDir);
    try {
      expect(store.isNew).toBe(true);
      expect(store.dbPath).toBe(join(tempDir, ".unerr", "timeline.db"));
      expect(existsSync(store.dbPath)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("second create on the same path reports isNew=false and schema-init is idempotent", async () => {
    const a = await CozoTimelineStore.create(tempDir);
    a.close();
    const b = await CozoTimelineStore.create(tempDir);
    try {
      expect(b.isNew).toBe(false);
    } finally {
      b.close();
    }
  });

  it("initialises all five expected relations", async () => {
    const store = await CozoTimelineStore.create(tempDir);
    try {
      const rels = await store.getDb().run("::relations");
      const names = new Set(rels.rows.map((r) => r[0] as string));
      for (const expected of [
        "turns",
        "intents",
        "intent_sessions",
        "derived_signals",
        "signal_reinforcement",
      ]) {
        expect(names.has(expected)).toBe(true);
      }
    } finally {
      store.close();
    }
  });

  it("round-trips a turn through upsertTurn → listTurns", async () => {
    const store = await CozoTimelineStore.create(tempDir);
    try {
      const turn = makeTurn({ title: "auth refactor" });
      await store.upsertTurn(turn);
      const list = await store.listTurns();
      expect(list).toHaveLength(1);
      expect(list[0]?.turn_id).toBe(turn.turn_id);
      expect(list[0]?.title).toBe("auth refactor");
      expect(list[0]?.opened_by).toBe("first_call");
    } finally {
      store.close();
    }
  });

  it("upsertTurn replaces an existing turn with the same id", async () => {
    const store = await CozoTimelineStore.create(tempDir);
    try {
      await store.upsertTurn(makeTurn({ title: "v1", tool_count: 1 }));
      await store.upsertTurn(makeTurn({ title: "v2", tool_count: 5 }));
      const list = await store.listTurns();
      expect(list).toHaveLength(1);
      expect(list[0]?.title).toBe("v2");
      expect(list[0]?.tool_count).toBe(5);
    } finally {
      store.close();
    }
  });

  it("listTurns filters by session and orders newest-first", async () => {
    const store = await CozoTimelineStore.create(tempDir);
    try {
      await store.upsertTurn(
        makeTurn({ turn_id: "t1", session_id: "a", started_at: 100 })
      );
      await store.upsertTurn(
        makeTurn({ turn_id: "t2", session_id: "a", started_at: 200 })
      );
      await store.upsertTurn(
        makeTurn({ turn_id: "t3", session_id: "b", started_at: 150 })
      );

      const inA = await store.listTurns({ sessionId: "a" });
      expect(inA.map((t) => t.turn_id)).toEqual(["t2", "t1"]);

      const all = await store.listTurns();
      expect(all.map((t) => t.turn_id)).toEqual(["t2", "t3", "t1"]);
    } finally {
      store.close();
    }
  });
});
