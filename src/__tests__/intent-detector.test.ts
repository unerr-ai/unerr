/**
 * ST-4: IntentDetector — Jaccard + marker-anchored stitch, dormant transitions,
 * IO orchestrator (runIntentStitch).
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSessionSummaries,
  jaccard,
  runIntentStitch,
  type SessionSummary,
  stitchIntents,
} from "../timeline/intent-detector.js";
import {
  CozoTimelineStore,
  type IntentRow,
  type MarkerRow,
  type TurnRow,
} from "../timeline/timeline-store.js";

function summary(
  session_id: string,
  files: string[],
  started_at: number,
  last_active_at?: number,
  intent_text?: string,
): SessionSummary {
  return {
    session_id,
    started_at,
    last_active_at: last_active_at ?? started_at,
    files: new Set(files),
    intent_text,
  };
}

describe("jaccard", () => {
  it("returns 0 for empty sets", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
  it("returns 1 for identical non-empty sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(1);
  });
  it("computes overlap correctly", () => {
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBeCloseTo(
      2 / 4,
    );
  });
});

describe("stitchIntents (pure)", () => {
  it("creates a fresh intent for the first session", () => {
    const sessions = [summary("s1", ["a.ts", "b.ts"], 1000)];
    const result = stitchIntents(sessions, [], [], { nowMs: 2000 });
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0]?.status).toBe("active");
    expect(result.attachments).toEqual([
      { intent_id: result.intents[0]?.intent_id, session_id: "s1" },
    ]);
  });

  it("attaches a new session via file-set Jaccard when overlap > threshold", () => {
    const sessions = [
      summary("s1", ["a.ts", "b.ts", "c.ts"], 1_000, 1_500),
      summary(
        "s2",
        ["a.ts", "b.ts", "c.ts", "d.ts"],
        2_000,
        2_500,
      ),
    ];
    const result = stitchIntents(sessions, [], [], { nowMs: 3000 });
    expect(result.intents).toHaveLength(1);
    expect(result.attachments.map((a) => a.session_id).sort()).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("creates a new intent when overlap < threshold", () => {
    const sessions = [
      summary("s1", ["a.ts", "b.ts"], 1_000, 1_500),
      summary("s2", ["x.ts", "y.ts"], 2_000, 2_500),
    ];
    const result = stitchIntents(sessions, [], [], { nowMs: 3_000 });
    expect(result.intents).toHaveLength(2);
  });

  it("creates a new intent when overlap is fresh but text marker differs", () => {
    const sessions = [
      summary("s1", ["a.ts", "b.ts", "c.ts"], 1_000, 1_500, "auth refactor"),
      summary(
        "s2",
        ["a.ts", "b.ts", "c.ts"],
        2_000,
        2_500,
        "payments cleanup",
      ),
    ];
    const result = stitchIntents(sessions, [], [], { nowMs: 3_000 });
    expect(result.intents).toHaveLength(2);
    const titles = result.intents.map((i) => i.title).sort();
    expect(titles).toEqual(["auth refactor", "payments cleanup"]);
  });

  it("transitions intents to dormant after inactivity", () => {
    const day = 24 * 60 * 60_000;
    const sessions = [summary("s1", ["a.ts"], 0, 1_000)];
    const r1 = stitchIntents(sessions, [], [], { nowMs: 30 * day });
    expect(r1.intents[0]?.status).toBe("dormant");
    expect(r1.dormantTransitions).toEqual([r1.intents[0]?.intent_id]);
  });

  it("does not re-attach a session that's already attached", () => {
    const sessions = [summary("s1", ["a.ts", "b.ts"], 1_000, 1_500)];
    const existing: IntentRow = {
      intent_id: "i1",
      title: "auth",
      started_at: 1_000,
      last_active_at: 1_500,
      file_set: JSON.stringify(["a.ts", "b.ts"]),
      file_set_hash: "h",
      status: "active",
      confidence: 0.5,
      source: "file_jaccard",
    };
    const result = stitchIntents(
      sessions,
      [existing],
      [{ intent_id: "i1", session_id: "s1" }],
      { nowMs: 2_000 },
    );
    expect(result.attachments).toEqual([]);
  });

  it("respects the freshness window — stale intents don't absorb new sessions", () => {
    const day = 24 * 60 * 60_000;
    const sessions = [
      summary("s1", ["a.ts", "b.ts", "c.ts"], 30 * day, 30 * day + 1_000),
    ];
    const existing: IntentRow = {
      intent_id: "i1",
      title: "old work",
      started_at: 0,
      last_active_at: 1_000,
      file_set: JSON.stringify(["a.ts", "b.ts", "c.ts"]),
      file_set_hash: "h",
      status: "active",
      confidence: 0.5,
      source: "file_jaccard",
    };
    const result = stitchIntents(sessions, [existing], [], {
      nowMs: 31 * day,
      freshnessMs: 14 * day,
    });
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.intent_id).not.toBe("i1");
  });
});

describe("buildSessionSummaries", () => {
  it("groups turns by session and picks first mark_intent", () => {
    const turns: TurnRow[] = [
      {
        turn_id: "t1",
        session_id: "s1",
        started_at: 1_000,
        ended_at: 1_500,
        opened_by: "first_call",
        closed_reason: "session_end",
        tool_count: 3,
        file_count: 2,
        edit_count: 0,
        title: "",
        outcome: "unknown",
      },
      {
        turn_id: "t2",
        session_id: "s1",
        started_at: 2_000,
        ended_at: 2_500,
        opened_by: "idle_gap",
        closed_reason: "idle_gap",
        tool_count: 4,
        file_count: 1,
        edit_count: 1,
        title: "",
        outcome: "unknown",
      },
    ];
    const markers: MarkerRow[] = [
      {
        marker_id: "m1",
        type: "mark_intent",
        text: "harden auth",
        session_id: "s1",
        turn_id: "t1",
        ts: 1_100,
        blocker_ref: "",
        file_path: "",
      },
    ];
    const summaries = buildSessionSummaries(
      turns,
      markers,
      new Map([["s1", new Set(["a.ts", "b.ts"])]]),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.intent_text).toBe("harden auth");
    expect(summaries[0]?.started_at).toBe(1_000);
    expect(summaries[0]?.last_active_at).toBe(2_500);
  });
});

describe("runIntentStitch (IO)", () => {
  let tempDir: string;
  let store: CozoTimelineStore;

  beforeEach(async () => {
    tempDir = join(
      tmpdir(),
      `unerr-istitch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  it("attaches two sessions touching the same files to one intent", async () => {
    const baseTs = Date.now();
    for (const sid of ["s1", "s2"]) {
      await store.upsertTurn({
        turn_id: `t-${sid}`,
        session_id: sid,
        started_at: baseTs,
        ended_at: baseTs + 1_000,
        opened_by: "first_call",
        closed_reason: "session_end",
        tool_count: 4,
        file_count: 3,
        edit_count: 1,
        title: "",
        outcome: "unknown",
      });
      await store.recordSessionFiles(sid, ["a.ts", "b.ts", "c.ts"]);
    }
    const r1 = await runIntentStitch(store);
    expect(r1.attached).toBe(2);

    const intents = await store.listIntents();
    expect(intents).toHaveLength(1);

    const sessions = await store.listIntentSessions(intents[0]!.intent_id);
    expect(sessions.sort()).toEqual(["s1", "s2"]);
  });

  it("is idempotent — re-running does not re-attach sessions", async () => {
    const baseTs = Date.now();
    await store.upsertTurn({
      turn_id: "tt",
      session_id: "s1",
      started_at: baseTs,
      ended_at: baseTs + 1_000,
      opened_by: "first_call",
      closed_reason: "session_end",
      tool_count: 1,
      file_count: 1,
      edit_count: 0,
      title: "",
      outcome: "unknown",
    });
    await store.recordSessionFiles("s1", ["a.ts"]);
    const r1 = await runIntentStitch(store);
    expect(r1.attached).toBe(1);
    const r2 = await runIntentStitch(store);
    expect(r2.attached).toBe(0);
  });
});
