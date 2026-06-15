import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { BatchAck, CloudResult } from "../cloud/client.js";
import { buildSessionsDrainers } from "../cloud/drainers/sessions.js";
import type { DrainerContext } from "../cloud/push-drainer.js";

const REPO_ID = "repo-hash-abc";
const SOURCE = "unerr-cli@test";
const ABS_PATH = "/Users/dev/secret-project/src/app.ts";

/** Assert a value is present (narrows `T | null | undefined` → `T`). */
function req<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("expected a value");
  return v;
}

/** A stub CloudClient that records every ingestSession call. */
function stubClient(): {
  client: DrainerContext["client"];
  sessions: unknown[];
} {
  const sessions: unknown[] = [];
  const ok: CloudResult<BatchAck> = {
    ok: true,
    status: 200,
    data: { accepted: 1 },
  };
  const client = {
    async ingestSession(session: unknown) {
      sessions.push(session);
      return ok;
    },
  } as unknown as DrainerContext["client"];
  return { client, sessions };
}

/** Stand up a metrics.db with a session_history table and the given rows. */
async function makeMetricsDb(
  unerrDir: string,
  rows: Array<Record<string, unknown>>
): Promise<void> {
  const DatabaseCtor = (await import("better-sqlite3")).default;
  const db = new DatabaseCtor(join(unerrDir, "metrics.db"));
  db.exec(`
    CREATE TABLE session_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      tool_calls INTEGER NOT NULL,
      tokens_saved INTEGER NOT NULL,
      tokens_processed INTEGER NOT NULL,
      efficiency REAL NOT NULL,
      model_id TEXT NOT NULL,
      entity_count INTEGER NOT NULL,
      agent_name TEXT,
      token_flow_summary TEXT
    );
  `);
  const stmt = db.prepare(`
    INSERT INTO session_history
      (session_id, started_at, ended_at, duration_ms, tool_calls, tokens_saved,
       tokens_processed, efficiency, model_id, entity_count, agent_name,
       token_flow_summary)
    VALUES (@session_id, @started_at, @ended_at, @duration_ms, @tool_calls,
            @tokens_saved, @tokens_processed, @efficiency, @model_id,
            @entity_count, @agent_name, @token_flow_summary)
  `);
  for (const r of rows) stmt.run(r);
  db.close();
}

function baseRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: "sess-1",
    started_at: new Date("2026-06-15T10:00:00.000Z").toISOString(),
    ended_at: new Date("2026-06-15T11:00:00.000Z").toISOString(),
    duration_ms: 3_600_000,
    tool_calls: 12,
    tokens_saved: 5000,
    tokens_processed: 9000,
    efficiency: 0.5,
    model_id: "claude-opus-4-8",
    entity_count: 7,
    agent_name: "claude-code",
    token_flow_summary: null,
    ...over,
  };
}

function ctx(unerrDir: string): DrainerContext {
  const { client } = stubClient();
  return {
    repoPath: ABS_PATH,
    unerrDir,
    repoId: REPO_ID,
    client,
    source: SOURCE,
  };
}

describe("buildSessionsDrainers", () => {
  let unerrDir: string;

  beforeEach(async () => {
    unerrDir = await mkdtemp(join(tmpdir(), "unerr-c2-sessions-"));
  });

  it("returns no drainer when metrics.db is missing", async () => {
    const { drainers } = await buildSessionsDrainers(ctx(unerrDir));
    expect(drainers).toHaveLength(0);
  });

  it("reads ONE session per batch and maps the wire shape", async () => {
    await makeMetricsDb(unerrDir, [baseRow({ session_id: "sess-1" })]);
    const { client, sessions } = stubClient();
    const { drainers, dispose } = await buildSessionsDrainers({
      ...ctx(unerrDir),
      client,
    });
    expect(drainers).toHaveLength(1);
    const d = req(drainers[0]);
    expect(d.key).toBe("sessions");

    const batch = req(await d.read({}));
    expect(batch.rows).toHaveLength(1);
    const session = batch.rows[0] as Record<string, unknown>;
    expect(session).toMatchObject({
      session_id: "sess-1",
      repo: REPO_ID,
      source: SOURCE,
      agent: "claude-code",
      model_id: "claude-opus-4-8",
      started_at: "2026-06-15T10:00:00.000Z",
      ended_at: "2026-06-15T11:00:00.000Z",
      tool_calls: 12,
      tokens_saved: 5000,
    });
    // No tokens_in/tokens_out (no source columns) and no raw path.
    expect(session.tokens_in).toBeUndefined();
    expect(session.tokens_out).toBeUndefined();
    expect(JSON.stringify(session)).not.toContain(ABS_PATH);

    await d.push(batch.rows);
    expect(sessions).toHaveLength(1);
    expect((sessions[0] as Record<string, unknown>).session_id).toBe("sess-1");

    dispose?.();
  });

  it("advances the cursor by row id and drains rows one at a time", async () => {
    await makeMetricsDb(unerrDir, [
      baseRow({ session_id: "sess-1" }),
      baseRow({ session_id: "sess-2" }),
      baseRow({ session_id: "sess-3" }),
    ]);
    const { drainers, dispose } = await buildSessionsDrainers(ctx(unerrDir));
    const d = req(drainers[0]);

    const first = req(await d.read({}));
    expect((first.rows[0] as Record<string, unknown>).session_id).toBe(
      "sess-1"
    );
    expect(first.next.lastId).toBe(1);

    const second = req(await d.read(first.next));
    expect((second.rows[0] as Record<string, unknown>).session_id).toBe(
      "sess-2"
    );
    expect(second.next.lastId).toBe(2);

    const third = req(await d.read(second.next));
    expect((third.rows[0] as Record<string, unknown>).session_id).toBe(
      "sess-3"
    );

    const done = await d.read(third.next);
    expect(done).toBeNull();

    dispose?.();
  });

  it("omits absent optional fields (no agent / open session)", async () => {
    await makeMetricsDb(unerrDir, [
      baseRow({
        session_id: "sess-open",
        agent_name: null,
        // open session: ended_at empty string → not a valid ISO → omitted.
        ended_at: "",
      }),
    ]);
    const { drainers, dispose } = await buildSessionsDrainers(ctx(unerrDir));
    const batch = req(await req(drainers[0]).read({}));
    const session = batch.rows[0] as Record<string, unknown>;
    expect(session.agent).toBeUndefined();
    expect(session.ended_at).toBeUndefined();
    expect(session.started_at).toBe("2026-06-15T10:00:00.000Z");
    dispose?.();
  });
});
