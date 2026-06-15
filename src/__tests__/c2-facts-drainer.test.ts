import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { BatchAck, CloudResult } from "../cloud/client.js";
import { buildFactsDrainers } from "../cloud/drainers/facts.js";
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
  pushed: unknown[][];
} {
  const pushed: unknown[][] = [];
  const ok: CloudResult<BatchAck> = {
    ok: true,
    status: 200,
    data: { accepted: 0 },
  };
  const client = {
    async syncFacts(facts: unknown[]) {
      pushed.push(facts);
      return ok;
    },
  } as unknown as DrainerContext["client"];
  return { client, pushed };
}

/** Open a real sqlite-backed cozo db at `<unerrDir>/facts.db`, init, seed. */
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
        [[$note_id, $kind, $anchor_type, $anchor_value, $polarity, $content,
          $dedupe_key, 0, 0, "s", "p", $created_at, $last_seen_at, 0.0, "", "",
          $inactive, false, 0.0]]
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
    kind: "rul",
    anchor_type: "f",
    anchor_value: "src/proxy/proxy.ts",
    polarity: "+",
    content: "always await db.run",
    dedupe_key: "d1",
    created_at: 1_700_000_000_000,
    last_seen_at: 1_700_000_001_000,
    inactive: false,
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

describe("buildFactsDrainers", () => {
  let unerrDir: string;

  beforeEach(async () => {
    unerrDir = await mkdtemp(join(tmpdir(), "unerr-c2-facts-"));
  });

  it("returns no drainer when facts.db is missing", async () => {
    const { client } = stubClient();
    const { drainers } = await buildFactsDrainers(ctx(unerrDir, client));
    expect(drainers).toHaveLength(0);
  });

  it("drains only ACTIVE notes and maps the FactCreate wire shape", async () => {
    await seedFactsDb(unerrDir, [
      note({ note_id: "n1", last_seen_at: 1000 }),
      note({
        note_id: "n2",
        inactive: true,
        content: "superseded",
        last_seen_at: 2000,
      }),
    ]);
    const { client, pushed } = stubClient();
    const { drainers, dispose } = await buildFactsDrainers(
      ctx(unerrDir, client)
    );
    expect(drainers).toHaveLength(1);
    const d = req(drainers[0]);
    expect(d.key).toBe("facts");

    const batch = req(await d.read({}));
    expect(batch.rows).toHaveLength(1); // inactive n2 excluded
    const fact = batch.rows[0] as Record<string, unknown>;
    expect(fact).toMatchObject({
      kind: "rul",
      anchor: "f:src/proxy/proxy.ts",
      polarity: "+",
      fact_text: "always await db.run",
      repo: REPO_ID,
    });
    expect(typeof fact.client_fact_id).toBe("string");
    expect(fact.created_at).toBe(new Date(1_700_000_000_000).toISOString());
    // The internal watermark field must not reach the wire.
    expect(fact._last_seen_at).toBeUndefined();
    // No raw absolute path anywhere in the row.
    expect(JSON.stringify(fact)).not.toContain(ABS_PATH);

    await d.push(batch.rows);
    expect(pushed).toHaveLength(1);

    await dispose?.();
  });

  it("advances the cursor by max last_seen_at watermark", async () => {
    await seedFactsDb(unerrDir, [
      note({ note_id: "n1", last_seen_at: 1000 }),
      note({ note_id: "n2", last_seen_at: 3000 }),
      note({ note_id: "n3", last_seen_at: 2000 }),
    ]);
    const { client } = stubClient();
    const { drainers, dispose } = await buildFactsDrainers(
      ctx(unerrDir, client)
    );
    const d = req(drainers[0]);

    const batch = req(await d.read({}));
    expect(batch.rows).toHaveLength(3);
    expect(batch.next.lastId).toBe(3000);

    // Re-reading past the watermark yields nothing.
    const done = await d.read(batch.next);
    expect(done).toBeNull();

    await dispose?.();
  });

  it("produces a stable client_fact_id across two builds (idempotent)", async () => {
    await seedFactsDb(unerrDir, [note({ note_id: "n-stable" })]);

    const { client: c1 } = stubClient();
    const b1 = await buildFactsDrainers(ctx(unerrDir, c1));
    const r1 = req(await req(b1.drainers[0]).read({})).rows[0] as Record<
      string,
      unknown
    >;
    await b1.dispose?.();

    const { client: c2 } = stubClient();
    const b2 = await buildFactsDrainers(ctx(unerrDir, c2));
    const r2 = req(await req(b2.drainers[0]).read({})).rows[0] as Record<
      string,
      unknown
    >;
    await b2.dispose?.();

    expect(r1.client_fact_id).toBe(r2.client_fact_id);
  });

  it("caps fact_text at 2 KB", async () => {
    const big = "x".repeat(5000);
    await seedFactsDb(unerrDir, [note({ note_id: "n-big", content: big })]);
    const { client } = stubClient();
    const { drainers, dispose } = await buildFactsDrainers(
      ctx(unerrDir, client)
    );
    const fact = req(await req(drainers[0]).read({})).rows[0] as Record<
      string,
      unknown
    >;
    expect((fact.fact_text as string).length).toBe(2048);
    await dispose?.();
  });
});
