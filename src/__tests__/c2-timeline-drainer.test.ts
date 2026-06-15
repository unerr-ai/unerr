import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { BatchAck, CloudResult } from "../cloud/client.js";
import { buildTimelineDrainers } from "../cloud/drainers/timeline.js";
import type { DrainerContext } from "../cloud/push-drainer.js";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initTimelineSchema } from "../timeline/timeline-store.js";

const REPO_ID = "repo-hash-abc";
const SOURCE = "unerr-cli@test";
const ABS_PATH = "/Users/dev/secret-project/src/app.ts";

/** Assert a value is present (narrows `T | null | undefined` → `T`). */
function req<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("expected a value");
  return v;
}

function stubClient(): {
  client: DrainerContext["client"];
  pushed: unknown[][];
} {
  const pushed: unknown[][] = [];
  const ok: CloudResult<BatchAck> = {
    ok: true,
    status: 200,
    data: { accepted: 0 },
  };
  const client = {
    async syncTimeline(timeline: unknown[]) {
      pushed.push(timeline);
      return ok;
    },
  } as unknown as DrainerContext["client"];
  return { client, pushed };
}

async function openTimelineFile(unerrDir: string): Promise<CozoDb> {
  const cozoModule = await import("cozo-node");
  const Ctor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;
  const db = new (Ctor as new (engine: string, path: string) => CozoDb)(
    "sqlite",
    join(unerrDir, "timeline.db")
  );
  await initTimelineSchema(db);
  return db;
}

async function seedTurn(
  db: CozoDb,
  turn: Record<string, unknown>
): Promise<void> {
  await db.run(
    `?[turn_id, session_id, started_at, ended_at, opened_by, closed_reason, tool_count, file_count, edit_count, title, outcome] <-
       [[$turn_id, $session_id, $started_at, 0.0, "", "", $tool_count, $file_count, 0, $title, ""]]
     :put turns { turn_id => session_id, started_at, ended_at, opened_by, closed_reason, tool_count, file_count, edit_count, title, outcome }`,
    turn
  );
}

async function seedMarker(
  db: CozoDb,
  marker: Record<string, unknown>
): Promise<void> {
  await db.run(
    `?[marker_id, type, text, session_id, turn_id, ts, blocker_ref, file_path] <-
       [[$marker_id, $type, $text, $session_id, "", $ts, "", $file_path]]
     :put markers { marker_id => type, text, session_id, turn_id, ts, blocker_ref, file_path }`,
    marker
  );
}

function ctx(
  unerrDir: string,
  client: DrainerContext["client"]
): DrainerContext {
  return {
    repoPath: ABS_PATH,
    unerrDir,
    repoId: REPO_ID,
    client,
    source: SOURCE,
  };
}

function findDrainer(
  drainers: import("../cloud/push-drainer.js").StreamDrainer[],
  key: string
) {
  const d = drainers.find((x) => x.key === key);
  if (!d) throw new Error(`no drainer ${key}`);
  return d;
}

describe("buildTimelineDrainers", () => {
  let unerrDir: string;

  beforeEach(async () => {
    unerrDir = await mkdtemp(join(tmpdir(), "unerr-c2-timeline-"));
  });

  it("returns no drainers when timeline.db is missing", async () => {
    const { client } = stubClient();
    const { drainers } = await buildTimelineDrainers(ctx(unerrDir, client));
    expect(drainers).toHaveLength(0);
  });

  it("builds turns + markers drainers and maps the wire shapes", async () => {
    const db = await openTimelineFile(unerrDir);
    await seedTurn(db, {
      turn_id: "t1",
      session_id: "sess-1",
      started_at: 1000,
      tool_count: 4,
      file_count: 2,
      title: "fix the bug",
    });
    await seedMarker(db, {
      marker_id: "m1",
      type: "mark_blocker",
      text: "db lock contention",
      session_id: "sess-1",
      ts: 1500,
      file_path: ABS_PATH, // must NOT leak
    });
    db.close?.();

    const { client, pushed } = stubClient();
    const { drainers, dispose } = await buildTimelineDrainers(
      ctx(unerrDir, client)
    );
    expect(drainers.map((d) => d.key).sort()).toEqual([
      "timeline:markers",
      "timeline:turns",
    ]);

    const turns = findDrainer(drainers, "timeline:turns");
    const tb = req(await turns.read({}));
    const turn = tb.rows[0] as Record<string, unknown>;
    expect(turn).toMatchObject({
      session_id: "sess-1",
      kind: "turn",
      label: "fix the bug",
      repo: REPO_ID,
      ts: new Date(1000).toISOString(),
    });
    expect(typeof turn.client_entry_id).toBe("string");
    expect(turn._started_at).toBeUndefined();
    expect(tb.next.lastId).toBe(1000);

    const markers = findDrainer(drainers, "timeline:markers");
    const mb = req(await markers.read({}));
    const marker = mb.rows[0] as Record<string, unknown>;
    expect(marker).toMatchObject({
      session_id: "sess-1",
      kind: "blocker",
      label: "db lock contention",
      note_text: "db lock contention",
      repo: REPO_ID,
      ts: new Date(1500).toISOString(),
    });
    expect(marker._ts).toBeUndefined();
    // HR-2: marker.file_path is a path and must never appear.
    expect(JSON.stringify(marker)).not.toContain(ABS_PATH);
    expect(marker.file_path).toBeUndefined();

    await turns.push(tb.rows);
    await markers.push(mb.rows);
    expect(pushed).toHaveLength(2);

    await dispose?.();
  });

  it("maps marker type → kind and advances cursor by max ts", async () => {
    const db = await openTimelineFile(unerrDir);
    await seedMarker(db, {
      marker_id: "m1",
      type: "mark_intent",
      text: "add cloud push",
      session_id: "s",
      ts: 100,
      file_path: "",
    });
    await seedMarker(db, {
      marker_id: "m2",
      type: "mark_decision",
      text: "use postgres",
      session_id: "s",
      ts: 300,
      file_path: "",
    });
    await seedMarker(db, {
      marker_id: "m3",
      type: "something_else",
      text: "misc",
      session_id: "s",
      ts: 200,
      file_path: "",
    });
    db.close?.();

    const { client } = stubClient();
    const { drainers, dispose } = await buildTimelineDrainers(
      ctx(unerrDir, client)
    );
    const markers = findDrainer(drainers, "timeline:markers");
    const batch = req(await markers.read({}));
    const kinds = (batch.rows as Array<Record<string, unknown>>).map(
      (r) => r.kind
    );
    expect(kinds).toEqual(["intent", "marker", "decision"]); // ordered by ts
    expect(batch.next.lastId).toBe(300);

    const done = await markers.read(batch.next);
    expect(done).toBeNull();
    await dispose?.();
  });

  it("produces a stable client_entry_id across two builds", async () => {
    const db = await openTimelineFile(unerrDir);
    await seedTurn(db, {
      turn_id: "t-stable",
      session_id: "s",
      started_at: 500,
      tool_count: 1,
      file_count: 1,
      title: "x",
    });
    db.close?.();

    const { client: c1 } = stubClient();
    const b1 = await buildTimelineDrainers(ctx(unerrDir, c1));
    const r1 = req(await findDrainer(b1.drainers, "timeline:turns").read({}))
      .rows[0] as Record<string, unknown>;
    await b1.dispose?.();

    const { client: c2 } = stubClient();
    const b2 = await buildTimelineDrainers(ctx(unerrDir, c2));
    const r2 = req(await findDrainer(b2.drainers, "timeline:turns").read({}))
      .rows[0] as Record<string, unknown>;
    await b2.dispose?.();

    expect(r1.client_entry_id).toBe(r2.client_entry_id);
  });
});
