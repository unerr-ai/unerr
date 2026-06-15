/**
 * Tests for the CLI-side cloud-push B-items (#9):
 *
 *  - B2-clip: the transcripts drainer reads the per-turn prose store
 *    (`agent_transcripts` in metrics.db) cursor-forward and ships each turn's
 *    `trace_text` code-stripped + clipped to ≤16 KB; raw code never reaches the
 *    wire (HR-2). `clipTranscriptText` is the unit-tested clip+strip helper.
 *  - B6: the personal-scope conventions guard skips `PUT /conventions` (no
 *    network call) for a personal-scoped token and returns `scope_unsupported`.
 *  - B7: `PushCursor.deadLetterTotal()` sums the dropped/rejected count the
 *    `unerr status` surface reads.
 *
 * Temp HOME (the success path writes ~/.unerr/team-conventions.json) so nothing
 * touches the real home dir.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => process.env.__TEST_HOME ?? actual.homedir(),
  };
});

import type { BatchAck, CloudClient, CloudResult } from "../cloud/client.js";
import {
  isPersonalScope,
  pushTeamConventions,
  readTeamConventions,
  scopeFromEntitlements,
} from "../cloud/conventions-sync.js";
import {
  TRANSCRIPTS_BATCH_CAP,
  TRANSCRIPT_TEXT_CAP,
  buildTranscriptDrainers,
  clipTranscriptText,
} from "../cloud/drainers/transcripts.js";
import { PushCursor } from "../cloud/push-cursor.js";
import type { DrainerContext } from "../cloud/push-drainer.js";

// ── shared helpers ────────────────────────────────────────────────

const REPO_ID = "repo-hash-abc";
const SOURCE = "unerr-cli@test";

/** A stub CloudClient capturing every ingestTranscripts batch. */
function transcriptStub(): {
  client: DrainerContext["client"];
  batches: unknown[][];
} {
  const batches: unknown[][] = [];
  const ok: CloudResult<BatchAck> = {
    ok: true,
    status: 200,
    data: { accepted: 0, rejected: 0 },
  };
  const client = {
    async ingestTranscripts(rows: unknown[]) {
      batches.push(rows);
      return ok;
    },
  } as unknown as DrainerContext["client"];
  return { client, batches };
}

function ctxFor(dir: string, client: DrainerContext["client"]): DrainerContext {
  return {
    repoPath: "/Users/dev/secret-project",
    unerrDir: dir,
    repoId: REPO_ID,
    client,
    source: SOURCE,
  };
}

/** Stand up a metrics.db with the agent_transcripts schema + the given rows. */
async function makeTranscriptsDb(
  unerrDir: string,
  rows: Array<Record<string, unknown>>
): Promise<void> {
  const DatabaseCtor = (await import("better-sqlite3")).default;
  const db = new DatabaseCtor(join(unerrDir, "metrics.db"));
  db.exec(`
    CREATE TABLE agent_transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      native_session_id TEXT,
      turn INTEGER NOT NULL,
      agent TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT,
      tools TEXT,
      files TEXT,
      model TEXT,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      ts TEXT NOT NULL,
      UNIQUE(session_id, turn, role)
    );
  `);
  const stmt = db.prepare(`
    INSERT INTO agent_transcripts
      (session_id, native_session_id, turn, agent, role, text, tools, files,
       model, tokens_input, tokens_output, ts)
    VALUES (@session_id, @native_session_id, @turn, @agent, @role, @text,
            @tools, @files, @model, @tokens_input, @tokens_output, @ts)
  `);
  for (const r of rows) stmt.run(r);
  db.close();
}

function transcriptRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: "sess-1",
    native_session_id: null,
    turn: 0,
    agent: "claude-code",
    role: "assistant",
    text: "reasoning prose",
    tools: null,
    files: null,
    model: "claude-opus-4-8",
    tokens_input: 100,
    tokens_output: 200,
    ts: new Date("2026-06-15T10:00:00.000Z").toISOString(),
    ...over,
  };
}

// ── B2-clip ───────────────────────────────────────────────────────

describe("B2-clip — clipTranscriptText (strip + ≤16 KB)", () => {
  it("strips embedded code before the wire (HR-2) and keeps prose", () => {
    const withCode =
      "reasoning prose\n```ts\nconst secret = 42;\n```\nmore prose";
    const clipped = clipTranscriptText(withCode);
    expect(clipped).not.toContain("const secret = 42");
    expect(clipped).toContain("reasoning prose");
    expect(clipped).toContain("more prose");
  });

  it("caps at 16 KB keeping the leading slice", () => {
    // Prose with spaces (no unbroken long-token run the stripper would redact),
    // so the only thing that bounds the length is the 16 KB clip.
    const huge = `head ${"ab cd ".repeat(TRANSCRIPT_TEXT_CAP)}TAILWORD`;
    expect(huge.length).toBeGreaterThan(TRANSCRIPT_TEXT_CAP);
    const clipped = clipTranscriptText(huge);
    expect(clipped.length).toBe(TRANSCRIPT_TEXT_CAP);
    expect(clipped).not.toContain("TAILWORD");
    expect(clipped.startsWith("head ")).toBe(true);
  });

  it("leaves a normal ~10 K transcript untouched (clip is a guard)", () => {
    // ~10 K chars of plain prose with no trailing whitespace on any line and no
    // unbroken long token — nothing the HR-2 stripper redacts, nothing the clip
    // trims, so it passes through byte-for-byte.
    const prose = `${"plain reasoning here.".repeat(450)}.`; // ~9.4 K chars
    expect(prose.length).toBeLessThan(TRANSCRIPT_TEXT_CAP);
    const clipped = clipTranscriptText(prose);
    expect(clipped).toBe(prose);
  });
});

describe("B2-clip — transcripts drainer real read path", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "b2-transcripts-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("registers no drainer when metrics.db is absent", async () => {
    const { client } = transcriptStub();
    const set = await buildTranscriptDrainers(ctxFor(dir, client));
    expect(set.drainers).toHaveLength(0);
  });

  it("reads agent_transcripts cursor-forward and maps each turn to the wire", async () => {
    await makeTranscriptsDb(dir, [
      transcriptRow({ turn: 0, role: "user", text: "user prompt" }),
      transcriptRow({ turn: 1, role: "assistant", text: "agent reasoning" }),
    ]);
    const { client, batches } = transcriptStub();
    const set = await buildTranscriptDrainers(ctxFor(dir, client));
    expect(set.drainers).toHaveLength(1);
    const drainer = set.drainers[0]!;

    const batch = await drainer.read({});
    expect(batch).not.toBeNull();
    expect(batch!.rows).toHaveLength(2);

    const rows = batch!.rows as Array<Record<string, unknown>>;
    const r0 = rows[0]!;
    const r1 = rows[1]!;
    expect(r0.speaker).toBe("user");
    expect(r0.trace_text).toBe("user prompt");
    expect(r1.speaker).toBe("agent");
    expect(r1.trace_text).toBe("agent reasoning");
    // Envelope fields present + top-level (not buried in detail).
    expect(r1.repo).toBe(REPO_ID);
    expect(r1.session_id).toBe("sess-1");
    expect(r1.turn).toBe(1);
    expect(r1.tokens_in).toBe(100);
    expect(r1.tokens_out).toBe(200);
    expect(typeof r1.event_id).toBe("string");

    // Cursor advanced to the highest id; a second read drains nothing.
    expect(batch!.next.lastId).toBe(2);
    expect(await drainer.read(batch!.next)).toBeNull();
    await set.dispose?.();
  });

  it("ships only the clipped+stripped trace_text — raw code never reaches the wire", async () => {
    const dirty = "explain\n```js\nconst apiKey='sk-LEAK';\n```\ndone";
    await makeTranscriptsDb(dir, [transcriptRow({ turn: 5, text: dirty })]);
    const { client } = transcriptStub();
    const set = await buildTranscriptDrainers(ctxFor(dir, client));
    const batch = await set.drainers[0]!.read({});
    const row = (batch!.rows as Array<Record<string, unknown>>)[0]!;
    expect(String(row.trace_text)).not.toContain("sk-LEAK");
    expect(String(row.trace_text)).toContain("explain");
    await set.dispose?.();
  });

  it("a >16 KB turn is clipped to ≤16 KB on the wire (accepted, not rejected whole)", async () => {
    // Plain prose with spaces (no unbroken long-token run, so the clip — not
    // the long-token stripper — is what bounds the length).
    const huge = "word ".repeat(TRANSCRIPT_TEXT_CAP); // ~80 K chars of prose
    expect(huge.length).toBeGreaterThan(TRANSCRIPT_TEXT_CAP);
    await makeTranscriptsDb(dir, [transcriptRow({ turn: 9, text: huge })]);
    const { client } = transcriptStub();
    const set = await buildTranscriptDrainers(ctxFor(dir, client));
    const batch = await set.drainers[0]!.read({});
    const row = (batch!.rows as Array<Record<string, unknown>>)[0]!;
    expect(String(row.trace_text).length).toBe(TRANSCRIPT_TEXT_CAP);
    await set.dispose?.();
  });

  it("skips a text-less row without stalling the cursor (system/tool rows)", async () => {
    await makeTranscriptsDb(dir, [
      transcriptRow({ turn: 0, role: "system", text: null }),
      transcriptRow({ turn: 1, role: "assistant", text: "real prose" }),
    ]);
    const { client } = transcriptStub();
    const set = await buildTranscriptDrainers(ctxFor(dir, client));
    const batch = await set.drainers[0]!.read({});
    // The null-text row is filtered; only the prose row ships, and the cursor
    // moves past BOTH rows (highest id = 2) so the next read is empty.
    expect(batch!.rows).toHaveLength(1);
    expect((batch!.rows[0] as Record<string, unknown>).trace_text).toBe(
      "real prose"
    );
    expect(batch!.next.lastId).toBe(2);
    expect(await set.drainers[0]!.read(batch!.next)).toBeNull();
    await set.dispose?.();
  });

  it("caps a batch at TRANSCRIPTS_BATCH_CAP rows", async () => {
    const many = Array.from({ length: TRANSCRIPTS_BATCH_CAP + 10 }, (_, i) =>
      transcriptRow({ turn: i, text: `turn ${i}` })
    );
    await makeTranscriptsDb(dir, many);
    const { client } = transcriptStub();
    const set = await buildTranscriptDrainers(ctxFor(dir, client));
    const batch = await set.drainers[0]!.read({});
    expect(batch!.rows.length).toBe(TRANSCRIPTS_BATCH_CAP);
    await set.dispose?.();
  });
});

// ── B6 — personal-scope conventions guard ─────────────────────────

describe("B6 — personal-scope conventions guard", () => {
  let tempHome: string;
  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "b6-home-"));
    process.env.__TEST_HOME = tempHome;
  });
  afterEach(() => {
    process.env.__TEST_HOME = undefined;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("isPersonalScope only flags 'personal'", () => {
    expect(isPersonalScope("personal")).toBe(true);
    expect(isPersonalScope("team")).toBe(false);
    expect(isPersonalScope(undefined)).toBe(false); // fail-open
  });

  it("scopeFromEntitlements reads scope or scope_type", () => {
    expect(scopeFromEntitlements({ scope: "personal" })).toBe("personal");
    expect(scopeFromEntitlements({ scope_type: "team" })).toBe("team");
    expect(scopeFromEntitlements({ plan: "free" })).toBeUndefined();
    expect(scopeFromEntitlements(null)).toBeUndefined();
  });

  it("skips the PUT with no network call for a personal scope", async () => {
    let called = false;
    const client = {
      async putConventions() {
        called = true;
        return { ok: true, status: 200, data: { version: 1 } };
      },
    } as unknown as CloudClient;

    const outcome = await pushTeamConventions(client, "# rules", {
      scope: "personal",
    });
    expect(outcome.result).toBe("scope_unsupported");
    expect(called).toBe(false);
  });

  it("performs the PUT and stores the doc for a team scope", async () => {
    const client = {
      async putConventions(content: string, version?: number) {
        expect(content).toBe("# team rules");
        expect(version).toBeUndefined();
        return { ok: true, status: 200, data: { version: 4 } };
      },
    } as unknown as CloudClient;

    const outcome = await pushTeamConventions(client, "# team rules", {
      scope: "team",
      now: Date.parse("2026-06-15T12:00:00.000Z"),
    });
    expect(outcome).toEqual({ result: "updated", version: 4 });
    const stored = readTeamConventions();
    expect(stored?.content).toBe("# team rules");
    expect(stored?.version).toBe(4);
  });

  it("maps a server 400 scope_unsupported to the same outcome (backstop)", async () => {
    const client = {
      async putConventions() {
        return {
          ok: false,
          status: 400,
          error: { code: "scope_unsupported", message: "personal" },
        };
      },
    } as unknown as CloudClient;
    const outcome = await pushTeamConventions(client, "# rules", {
      scope: undefined, // local scope unknown — server is the backstop
    });
    expect(outcome.result).toBe("scope_unsupported");
  });
});

// ── B7 — dead-letter visibility ───────────────────────────────────

describe("B7 — dead-letter visibility", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "b7-deadletter-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("deadLetterTotal sums dropped/rejected records across streams", async () => {
    const cursor = await PushCursor.open(dir);
    expect(cursor.deadLetterTotal()).toBe(0);
    cursor.addDeadLetters("transcripts", 3);
    cursor.addDeadLetters("events", 2);
    cursor.addDeadLetters("events", 0); // no-op
    expect(cursor.deadLetterTotal()).toBe(5);

    // Survives a save/reopen — the standing count is durable.
    await cursor.save();
    const reopened = await PushCursor.open(dir);
    expect(reopened.deadLetterTotal()).toBe(5);
  });
});
