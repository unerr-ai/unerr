/**
 * TR-1 / TR-2: filter + pagination + listSessions + getActivityBuckets store
 * methods, plus the route surface that exposes them.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTimelineRoutes } from "../server/routes/timeline.js";
import { CozoTimelineStore, type TurnRow } from "../timeline/timeline-store.js";

let tempDir: string;
let store: CozoTimelineStore;

beforeEach(async () => {
  tempDir = join(
    tmpdir(),
    `unerr-tf-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

function turn(overrides: Partial<TurnRow> & { turn_id: string }): TurnRow {
  return {
    session_id: overrides.session_id ?? "s1",
    started_at: overrides.started_at ?? 1_000,
    ended_at: overrides.ended_at ?? 2_000,
    opened_by: overrides.opened_by ?? "first_call",
    closed_reason: overrides.closed_reason ?? "session_end",
    tool_count: overrides.tool_count ?? 3,
    file_count: overrides.file_count ?? 2,
    edit_count: overrides.edit_count ?? 1,
    title: overrides.title ?? "",
    outcome: overrides.outcome ?? "unknown",
    ...overrides,
  };
}

describe("listTurns — filters + pagination", () => {
  it("paginates via offset + limit", async () => {
    for (let i = 0; i < 7; i++) {
      await store.upsertTurn(
        turn({ turn_id: `t${i}`, started_at: 1000 + i * 1000 })
      );
    }
    const page1 = await store.listTurns({ limit: 3, offset: 0 });
    const page2 = await store.listTurns({ limit: 3, offset: 3 });
    const page3 = await store.listTurns({ limit: 3, offset: 6 });
    expect(page1.map((t) => t.turn_id)).toEqual(["t6", "t5", "t4"]);
    expect(page2.map((t) => t.turn_id)).toEqual(["t3", "t2", "t1"]);
    expect(page3.map((t) => t.turn_id)).toEqual(["t0"]);
  });

  it("filters by fromTs / toTs (inclusive)", async () => {
    await store.upsertTurn(turn({ turn_id: "a", started_at: 100 }));
    await store.upsertTurn(turn({ turn_id: "b", started_at: 500 }));
    await store.upsertTurn(turn({ turn_id: "c", started_at: 900 }));
    const within = await store.listTurns({ fromTs: 200, toTs: 800 });
    expect(within.map((t) => t.turn_id)).toEqual(["b"]);
  });

  it("filters by query — case-insensitive substring on title", async () => {
    await store.upsertTurn(
      turn({ turn_id: "a", title: "Refactor Auth Middleware" })
    );
    await store.upsertTurn(turn({ turn_id: "b", title: "Payments cleanup" }));
    await store.upsertTurn(turn({ turn_id: "c", title: "auth follow-up" }));
    const hits = await store.listTurns({ query: "auth" });
    expect(hits.map((t) => t.turn_id).sort()).toEqual(["a", "c"]);
  });

  it("query escapes regex metacharacters in the user input", async () => {
    await store.upsertTurn(
      turn({ turn_id: "a", title: "fix [bug] in handler" })
    );
    await store.upsertTurn(turn({ turn_id: "b", title: "fix bug" }));
    const hits = await store.listTurns({ query: "[bug]" });
    expect(hits.map((t) => t.turn_id)).toEqual(["a"]);
  });

  it("countTurns mirrors the same filter semantics", async () => {
    await store.upsertTurn(
      turn({ turn_id: "a", session_id: "s1", started_at: 100 })
    );
    await store.upsertTurn(
      turn({ turn_id: "b", session_id: "s1", started_at: 200 })
    );
    await store.upsertTurn(
      turn({ turn_id: "c", session_id: "s2", started_at: 150 })
    );
    expect(await store.countTurns({})).toBe(3);
    expect(await store.countTurns({ sessionId: "s1" })).toBe(2);
    expect(await store.countTurns({ fromTs: 110, toTs: 250 })).toBe(2);
  });
});

describe("listSessions", () => {
  it("aggregates per-session stats and orders by last_seen desc", async () => {
    await store.upsertTurn(
      turn({
        turn_id: "x1",
        session_id: "sa",
        started_at: 100,
        ended_at: 200,
        edit_count: 1,
        file_count: 2,
      })
    );
    await store.upsertTurn(
      turn({
        turn_id: "x2",
        session_id: "sa",
        started_at: 300,
        ended_at: 400,
        edit_count: 2,
        file_count: 3,
      })
    );
    await store.upsertTurn(
      turn({
        turn_id: "x3",
        session_id: "sb",
        started_at: 500,
        ended_at: 600,
        edit_count: 1,
        file_count: 1,
      })
    );
    const list = await store.listSessions();
    expect(list.map((s) => s.session_id)).toEqual(["sb", "sa"]);
    const sa = list.find((s) => s.session_id === "sa")!;
    expect(sa.turn_count).toBe(2);
    expect(sa.edit_count).toBe(3);
    expect(sa.first_seen).toBe(100);
    expect(sa.last_seen).toBe(400);
  });
});

describe("getActivityBuckets", () => {
  it("fills the requested range with zero days and counts turns per bucket", async () => {
    const day = 24 * 60 * 60_000;
    const t0 = day; // bucket-aligned for predictability
    await store.upsertTurn(
      turn({
        turn_id: "a",
        started_at: t0,
        ended_at: t0 + 5_000,
        edit_count: 1,
        tool_count: 4,
      })
    );
    await store.upsertTurn(
      turn({
        turn_id: "b",
        started_at: t0 + day + 1_000,
        ended_at: t0 + day + 5_000,
        edit_count: 3,
        tool_count: 7,
      })
    );
    const buckets = await store.getActivityBuckets({
      fromTs: t0,
      toTs: t0 + 3 * day,
      bucketMs: day,
    });
    expect(buckets).toHaveLength(4);
    expect(buckets[0]?.turns).toBe(1);
    expect(buckets[1]?.turns).toBe(1);
    expect(buckets[1]?.edits).toBe(3);
    expect(buckets[1]?.tools).toBe(7);
    expect(buckets[2]?.turns).toBe(0);
    expect(buckets[3]?.turns).toBe(0);
  });
});

describe("HTTP routes — pagination + sessions + heatmap", () => {
  it("GET /turns returns paginated envelope (total, returned, offset, limit)", async () => {
    for (let i = 0; i < 5; i++) {
      await store.upsertTurn(
        turn({ turn_id: `r${i}`, started_at: 1000 + i * 1000 })
      );
    }
    const app = createTimelineRoutes({ store });
    const res = await app.request("/turns?limit=2&offset=2");
    const body = (await res.json()) as {
      data: TurnRow[];
      total: number;
      returned: number;
      offset: number;
      limit: number;
    };
    expect(body.total).toBe(5);
    expect(body.returned).toBe(2);
    expect(body.offset).toBe(2);
    expect(body.limit).toBe(2);
    expect(body.data.map((t) => t.turn_id)).toEqual(["r2", "r1"]);
  });

  it("GET /turns?q= performs a substring search", async () => {
    await store.upsertTurn(turn({ turn_id: "a", title: "Auth refactor" }));
    await store.upsertTurn(turn({ turn_id: "b", title: "Payments" }));
    const app = createTimelineRoutes({ store });
    const res = await app.request("/turns?q=auth");
    const body = (await res.json()) as { data: TurnRow[]; total: number };
    expect(body.total).toBe(1);
    expect(body.data[0]?.turn_id).toBe("a");
  });

  it("GET /sessions returns the aggregated session list", async () => {
    await store.upsertTurn(
      turn({ turn_id: "x", session_id: "sa", started_at: 100, ended_at: 200 })
    );
    const app = createTimelineRoutes({ store });
    const res = await app.request("/sessions");
    const body = (await res.json()) as {
      data: Array<{ session_id: string; turn_count: number }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.session_id).toBe("sa");
    expect(body.data[0]?.turn_count).toBe(1);
  });

  it("GET /heatmap returns the requested number of buckets", async () => {
    const app = createTimelineRoutes({ store });
    const res = await app.request("/heatmap?days=7");
    const body = (await res.json()) as { data: Array<{ ts: number }> };
    expect(body.data.length).toBe(7);
  });
});
