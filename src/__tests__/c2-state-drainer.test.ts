import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { BatchAck, CloudResult } from "../cloud/client.js";
import { buildStateDrainers } from "../cloud/drainers/state.js";
import type { DrainerContext } from "../cloud/push-drainer.js";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initFactsSchema } from "../intelligence/facts-schema.js";

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
  calls: Array<{ repoId: string; state: unknown[]; drift: unknown[] }>;
} {
  const calls: Array<{ repoId: string; state: unknown[]; drift: unknown[] }> =
    [];
  const ok: CloudResult<BatchAck> = {
    ok: true,
    status: 200,
    data: { accepted: 0 },
  };
  const client = {
    async syncState(repoId: string, state: unknown[], drift: unknown[]) {
      calls.push({ repoId, state, drift });
      return ok;
    },
  } as unknown as DrainerContext["client"];
  return { client, calls };
}

async function seedFactsDb(
  unerrDir: string,
  notes: Array<Record<string, unknown>>
): Promise<void> {
  const cozoModule = await import("cozo-node");
  const Ctor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;
  const db = new (Ctor as new (engine: string, path: string) => CozoDb)(
    "sqlite",
    join(unerrDir, "facts.db")
  );
  await initFactsSchema(db);
  for (const n of notes) {
    await db.run(
      `?[note_id, kind, anchor_type, anchor_value, polarity, content, dedupe_key,
         reinforcement_count, contradiction_count, created_session_id,
         created_prompt_hash, created_at, last_seen_at, decay_score,
         conflict_group_id, supersedes_note_id, inactive, anchor_missing,
         anchor_missing_since] <-
        [[$note_id, "rul", $anchor_type, $anchor_value, "+", "c", "d", 0, 0,
          "s", "p", 0.0, $last_seen_at, 0.0, "", "", false, $anchor_missing,
          $anchor_missing_since]]
       :put notes {
         note_id => kind, anchor_type, anchor_value, polarity, content,
         dedupe_key, reinforcement_count, contradiction_count,
         created_session_id, created_prompt_hash, created_at, last_seen_at,
         decay_score, conflict_group_id, supersedes_note_id, inactive,
         anchor_missing, anchor_missing_since
       }`,
      n
    );
  }
  db.close?.();
}

function note(over: Record<string, unknown>): Record<string, unknown> {
  return {
    note_id: "n1",
    anchor_type: "f",
    anchor_value: "src/gone.ts",
    last_seen_at: 1000,
    anchor_missing: true,
    anchor_missing_since: 2000,
    ...over,
  };
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

describe("buildStateDrainers", () => {
  let unerrDir: string;

  beforeEach(async () => {
    unerrDir = await mkdtemp(join(tmpdir(), "unerr-c2-state-"));
  });

  it("returns no drainer when facts.db is missing", async () => {
    const { client } = stubClient();
    const { drainers } = await buildStateDrainers(ctx(unerrDir, client));
    expect(drainers).toHaveLength(0);
  });

  it("maps anchor_missing notes → anchor_lost drift, state[] empty", async () => {
    await seedFactsDb(unerrDir, [
      note({ note_id: "n1", anchor_missing: true, anchor_missing_since: 2000 }),
      note({
        note_id: "n2",
        anchor_missing: false,
        anchor_missing_since: 0,
        anchor_value: "src/present.ts",
      }),
    ]);
    const { client, calls } = stubClient();
    const { drainers, dispose } = await buildStateDrainers(
      ctx(unerrDir, client)
    );
    expect(drainers).toHaveLength(1);
    const d = req(drainers[0]);
    expect(d.key).toBe("state:drift");

    const batch = req(await d.read({}));
    expect(batch.rows).toHaveLength(1); // only the anchor_missing note
    const drift = batch.rows[0] as Record<string, unknown>;
    expect(drift).toMatchObject({
      anchor: "f:src/gone.ts",
      drift_kind: "anchor_lost",
      repo: REPO_ID,
      detected_at: new Date(2000).toISOString(),
    });
    expect(typeof drift.client_drift_id).toBe("string");
    expect(drift._watermark).toBeUndefined();
    expect(JSON.stringify(drift)).not.toContain(ABS_PATH);

    await d.push(batch.rows);
    // state[] empty, drift-only push, repoId still passed.
    expect(calls).toHaveLength(1);
    const call = req(calls[0]);
    expect(call.repoId).toBe(REPO_ID);
    expect(call.state).toEqual([]);
    expect(call.drift).toHaveLength(1);

    await dispose?.();
  });

  it("advances cursor by max anchor_missing_since and stops", async () => {
    await seedFactsDb(unerrDir, [
      note({ note_id: "n1", anchor_missing_since: 1000 }),
      note({ note_id: "n2", anchor_missing_since: 5000 }),
      note({ note_id: "n3", anchor_missing_since: 3000 }),
    ]);
    const { client } = stubClient();
    const { drainers, dispose } = await buildStateDrainers(
      ctx(unerrDir, client)
    );
    const d = req(drainers[0]);

    const batch = req(await d.read({}));
    expect(batch.rows).toHaveLength(3);
    expect(batch.next.lastId).toBe(5000);

    const done = await d.read(batch.next);
    expect(done).toBeNull();
    await dispose?.();
  });

  it("produces a stable client_drift_id across two builds", async () => {
    await seedFactsDb(unerrDir, [note({ note_id: "n-stable" })]);

    const { client: c1 } = stubClient();
    const b1 = await buildStateDrainers(ctx(unerrDir, c1));
    const r1 = req(await req(b1.drainers[0]).read({})).rows[0] as Record<
      string,
      unknown
    >;
    await b1.dispose?.();

    const { client: c2 } = stubClient();
    const b2 = await buildStateDrainers(ctx(unerrDir, c2));
    const r2 = req(await req(b2.drainers[0]).read({})).rows[0] as Record<
      string,
      unknown
    >;
    await b2.dispose?.();

    expect(r1.client_drift_id).toBe(r2.client_drift_id);
  });
});
