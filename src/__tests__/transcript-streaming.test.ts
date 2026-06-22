/**
 * Claim-check transcript pipeline — the daemon-side streaming path that replaced
 * the synchronous hook read. Covers the four new units:
 *   - `streamJsonlFrom`: offset-correct, torn-line safe, cap-bounded, restart-on-shrink.
 *   - `transcript-claim`: enqueue → read → latest-per-session → age-based sweep.
 *   - end-to-end: claim → materialize → ingest drain delivers the rows.
 *   - `TranscriptOffsetStore`: persist + reload roundtrip.
 *   - `materializeClaimedTranscripts`: settle-gating, incremental emit, inode restart.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CloudClient } from "../cloud/client.js";
import { buildIngestDrainers } from "../cloud/drainers/ingest.js";
import { PushCursor } from "../cloud/push-cursor.js";
import { drainRepo } from "../cloud/push-drainer.js";
import { readSegmentFrom, segmentPath } from "../events/event-store.js";
import { claudeProjectDir } from "../tracking/agent-transcript/claude-jsonl.js";
import {
  type TranscriptClaim,
  enqueueTranscriptClaim,
  latestClaimPerSession,
  readPendingClaims,
  sweepStaleClaimFiles,
} from "../tracking/transcript-claim.js";
import { materializeClaimedTranscripts } from "../tracking/transcript-drainer.js";
import { TranscriptOffsetStore } from "../tracking/transcript-offsets.js";
import { streamJsonlFrom } from "../utils/jsonl-stream.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "unerr-transcript-stream-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("streamJsonlFrom", () => {
  it("reads complete lines from the head and reports the end offset", async () => {
    const f = join(tmp, "a.jsonl");
    const body = `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n`;
    writeFileSync(f, body);

    const slice = await streamJsonlFrom(f, 0);
    expect(slice.rows).toEqual([{ n: 1 }, { n: 2 }]);
    expect(slice.nextOffset).toBe(Buffer.byteLength(body));
    expect(slice.restarted).toBe(false);
  });

  it("reads only the bytes appended after a saved offset", async () => {
    const f = join(tmp, "b.jsonl");
    const first = `${JSON.stringify({ n: 1 })}\n`;
    writeFileSync(f, first);
    const a = await streamJsonlFrom(f, 0);
    expect(a.rows).toEqual([{ n: 1 }]);

    appendFileSync(f, `${JSON.stringify({ n: 2 })}\n`);
    const b = await streamJsonlFrom(f, a.nextOffset);
    expect(b.rows).toEqual([{ n: 2 }]); // not the already-read line 1
  });

  it("does not consume a torn trailing line (no newline yet)", async () => {
    const f = join(tmp, "c.jsonl");
    const complete = `${JSON.stringify({ n: 1 })}\n`;
    const partial = '{"n":2'; // mid-append, no newline
    writeFileSync(f, complete + partial);

    const slice = await streamJsonlFrom(f, 0);
    expect(slice.rows).toEqual([{ n: 1 }]);
    expect(slice.nextOffset).toBe(Buffer.byteLength(complete)); // stops at last \n

    // Finish the partial line; reading from the offset now yields it intact.
    appendFileSync(f, "}\n");
    const more = await streamJsonlFrom(f, slice.nextOffset);
    expect(more.rows).toEqual([{ n: 2 }]);
  });

  it("restarts from 0 when the file shrank below the offset", async () => {
    const f = join(tmp, "d.jsonl");
    writeFileSync(f, `${JSON.stringify({ n: 1 })}\n`);
    const slice = await streamJsonlFrom(f, 9_999);
    expect(slice.restarted).toBe(true);
    expect(slice.rows).toEqual([{ n: 1 }]);
  });

  it("caps the batch by row count and lands the offset at the boundary", async () => {
    const f = join(tmp, "e.jsonl");
    const l1 = `${JSON.stringify({ n: 1 })}\n`;
    const l2 = `${JSON.stringify({ n: 2 })}\n`;
    const l3 = `${JSON.stringify({ n: 3 })}\n`;
    writeFileSync(f, l1 + l2 + l3);

    const slice = await streamJsonlFrom(f, 0, { maxRows: 2 });
    expect(slice.rows).toEqual([{ n: 1 }, { n: 2 }]);
    expect(slice.nextOffset).toBe(Buffer.byteLength(l1 + l2));

    const rest = await streamJsonlFrom(f, slice.nextOffset, { maxRows: 2 });
    expect(rest.rows).toEqual([{ n: 3 }]);
  });

  it("always advances past an oversized lead line so the cursor never sticks", async () => {
    const f = join(tmp, "f.jsonl");
    const big = `${JSON.stringify({ s: "x".repeat(500) })}\n`;
    const small = `${JSON.stringify({ n: 2 })}\n`;
    writeFileSync(f, big + small);

    const slice = await streamJsonlFrom(f, 0, { maxBytes: 10 });
    expect(slice.rows).toHaveLength(1); // the lead line still came through
    expect(slice.nextOffset).toBe(Buffer.byteLength(big));
  });

  it("skips a corrupt line but still advances past it", async () => {
    const f = join(tmp, "g.jsonl");
    const good = `${JSON.stringify({ n: 1 })}\n`;
    const bad = "{not json\n";
    const good2 = `${JSON.stringify({ n: 3 })}\n`;
    writeFileSync(f, good + bad + good2);

    const slice = await streamJsonlFrom(f, 0);
    expect(slice.rows).toEqual([{ n: 1 }, { n: 3 }]);
    expect(slice.nextOffset).toBe(Buffer.byteLength(good + bad + good2));
  });

  it("returns an empty slice at the same offset for a missing file", async () => {
    const slice = await streamJsonlFrom(join(tmp, "nope.jsonl"), 42);
    expect(slice.rows).toEqual([]);
    expect(slice.nextOffset).toBe(42);
  });
});

describe("transcript-claim", () => {
  it("enqueues a pointer that read-back returns, with no transcript content", () => {
    const unerrDir = join(tmp, ".unerr");
    enqueueTranscriptClaim({
      unerrDir,
      repoCwd: tmp,
      sessionId: "sess-1",
      nativeSessionId: "nat-1",
      agent: "claude-code",
      turn: 4,
    });
    const claims = readPendingClaims(unerrDir);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      kind: "transcript",
      session_id: "sess-1",
      native_session_id: "nat-1",
      agent: "claude-code",
      repo_cwd: tmp,
      turn: 4,
    });
    expect(typeof claims[0]?.observed_at).toBe("number");
  });

  it("reduces to the most-recent claim per session", () => {
    const claims: TranscriptClaim[] = [
      {
        kind: "transcript",
        session_id: "s",
        native_session_id: null,
        agent: "x",
        repo_cwd: tmp,
        observed_at: 100,
      },
      {
        kind: "transcript",
        session_id: "s",
        native_session_id: null,
        agent: "x",
        repo_cwd: tmp,
        observed_at: 300,
      },
      {
        kind: "transcript",
        session_id: "t",
        native_session_id: null,
        agent: "x",
        repo_cwd: tmp,
        observed_at: 200,
      },
    ];
    const latest = latestClaimPerSession(claims);
    expect(latest).toHaveLength(2);
    expect(latest.find((c) => c.session_id === "s")?.observed_at).toBe(300);
  });

  it("sweeps an aged claim file but keeps a recent one (no pid-race data loss)", () => {
    const dir = join(tmp, ".unerr", "transcripts", "claims");
    mkdirSync(dir, { recursive: true });
    const aged = join(dir, "1.jsonl");
    const recent = join(dir, "2.jsonl");
    const claim = `${JSON.stringify({ kind: "transcript", session_id: "z", observed_at: 1 })}\n`;
    writeFileSync(aged, claim);
    writeFileSync(recent, claim);
    // Age `aged` an hour back; `recent` keeps its just-written mtime. A pid-based
    // sweep would have deleted BOTH (any dead hook pid) — the bug that lost a
    // session's final, not-yet-settled turns. Age-based keeps the recent one.
    const past = (Date.now() - 60 * 60_000) / 1000;
    utimesSync(aged, past, past);

    sweepStaleClaimFiles(join(tmp, ".unerr"));
    expect(existsSync(aged)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });
});

describe("TranscriptOffsetStore", () => {
  it("persists and reloads per-session offsets", async () => {
    const unerrDir = join(tmp, ".unerr");
    const store = await TranscriptOffsetStore.open(unerrDir);
    store.set("sess-1", { byteOffset: 1234, inode: 99, lastConvTurn: 7 });
    await store.save();

    const reopened = await TranscriptOffsetStore.open(unerrDir);
    expect(reopened.get("sess-1")).toEqual({
      byteOffset: 1234,
      inode: 99,
      lastConvTurn: 7,
    });

    reopened.forget("sess-1");
    expect(reopened.get("sess-1")).toBeUndefined();
  });

  it("starts empty for a missing/corrupt file", async () => {
    const store = await TranscriptOffsetStore.open(join(tmp, "absent"));
    expect(store.get("anything")).toBeUndefined();
  });
});

describe("materializeClaimedTranscripts (daemon drainer)", () => {
  const HOME = process.env.HOME;
  let repoCwd: string;
  let unerrDir: string;
  let projectDir: string;
  const native = "nat-abc";

  const userRec = (
    uuid: string,
    parent: string | null,
    text: string,
    ts: string
  ) =>
    `${JSON.stringify({ uuid, parentUuid: parent, type: "user", message: { role: "user", content: text }, timestamp: ts, sessionId: native })}\n`;
  const asstRec = (uuid: string, parent: string, text: string, ts: string) =>
    `${JSON.stringify({ uuid, parentUuid: parent, type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 }, model: "claude-opus" }, timestamp: ts, sessionId: native })}\n`;

  const ageFile = (path: string, msAgo: number) => {
    const t = (Date.now() - msAgo) / 1000;
    utimesSync(path, t, t);
  };

  const readTranscriptEvents = () => {
    const seg = segmentPath(repoCwd, "transcript");
    if (!existsSync(seg)) return [];
    return readSegmentFrom(seg, 0).events as Record<string, unknown>[];
  };

  beforeEach(() => {
    repoCwd = mkdtempSync(join(tmpdir(), "unerr-tr-repo-"));
    unerrDir = join(repoCwd, ".unerr");
    // Point the Claude project-dir resolver at a temp HOME.
    process.env.HOME = join(tmp, "home");
    projectDir = claudeProjectDir(repoCwd);
    mkdirSync(projectDir, { recursive: true });
    // Enable transcript reading for this repo.
    mkdirSync(unerrDir, { recursive: true });
    writeFileSync(
      join(unerrDir, "config.json"),
      JSON.stringify({ read_agent_transcripts: true })
    );
  });
  afterEach(() => {
    process.env.HOME = HOME;
    rmSync(repoCwd, { recursive: true, force: true });
  });

  it("skips a transcript whose file is not yet settled (recently written)", async () => {
    const f = join(projectDir, `${native}.jsonl`);
    writeFileSync(f, userRec("u1", null, "hi", "2026-06-21T00:00:00.000Z"));
    // mtime = now → inside the quiet window → must be skipped.
    enqueueTranscriptClaim({
      unerrDir,
      repoCwd,
      sessionId: "s1",
      nativeSessionId: native,
      agent: "claude-code",
    });

    const n = await materializeClaimedTranscripts({
      repoCwd,
      unerrDir,
      now: Date.now(),
    });
    expect(n).toBe(0);
    expect(readTranscriptEvents()).toHaveLength(0);
  });

  it("materializes a settled transcript into transcript events", async () => {
    const f = join(projectDir, `${native}.jsonl`);
    writeFileSync(
      f,
      userRec("u1", null, "wire it", "2026-06-21T00:00:00.000Z") +
        asstRec("a1", "u1", "done", "2026-06-21T00:00:05.000Z")
    );
    ageFile(f, 5 * 60_000); // 5 min old → settled
    enqueueTranscriptClaim({
      unerrDir,
      repoCwd,
      sessionId: "s1",
      nativeSessionId: native,
      agent: "claude-code",
    });

    const n = await materializeClaimedTranscripts({
      repoCwd,
      unerrDir,
      now: Date.now(),
    });
    expect(n).toBe(2);

    const events = readTranscriptEvents();
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === "transcript")).toBe(true);
    expect(events.every((e) => e.session_id === "s1")).toBe(true);
    const agent = events.find(
      (e) => (e.detail as Record<string, unknown>).speaker === "agent"
    );
    expect((agent?.detail as Record<string, unknown>).trace_text).toBe("done");
    expect((agent?.detail as Record<string, unknown>).tokens_out).toBe(50);
  });

  it("emits only newly-appended turns on the next pass (incremental offset)", async () => {
    const f = join(projectDir, `${native}.jsonl`);
    writeFileSync(
      f,
      userRec("u1", null, "first", "2026-06-21T00:00:00.000Z") +
        asstRec("a1", "u1", "reply one", "2026-06-21T00:00:05.000Z")
    );
    ageFile(f, 5 * 60_000);
    enqueueTranscriptClaim({
      unerrDir,
      repoCwd,
      sessionId: "s1",
      nativeSessionId: native,
      agent: "claude-code",
    });
    const first = await materializeClaimedTranscripts({
      repoCwd,
      unerrDir,
      now: Date.now(),
    });
    expect(first).toBe(2);

    // Append one more turn, re-age, re-claim, re-drain.
    appendFileSync(
      f,
      asstRec("a2", "u1", "reply two", "2026-06-21T00:01:00.000Z")
    );
    ageFile(f, 5 * 60_000);
    enqueueTranscriptClaim({
      unerrDir,
      repoCwd,
      sessionId: "s1",
      nativeSessionId: native,
      agent: "claude-code",
    });
    const second = await materializeClaimedTranscripts({
      repoCwd,
      unerrDir,
      now: Date.now(),
    });

    expect(second).toBe(1); // only the new turn, not a re-read of the whole file
    const newest = readTranscriptEvents().filter(
      (e) => (e.detail as Record<string, unknown>).trace_text === "reply two"
    );
    expect(newest).toHaveLength(1);
  });

  it("end-to-end: claim → materialize → ingest drain delivers the rows (coalesced, capped)", async () => {
    const f = join(projectDir, `${native}.jsonl`);
    writeFileSync(
      f,
      userRec("u1", null, "do the thing", "2026-06-21T00:00:00.000Z") +
        asstRec("a1", "u1", "did the thing", "2026-06-21T00:00:05.000Z")
    );
    ageFile(f, 5 * 60_000);
    enqueueTranscriptClaim({
      unerrDir,
      repoCwd,
      sessionId: "s1",
      nativeSessionId: native,
      agent: "claude-code",
    });
    await materializeClaimedTranscripts({ repoCwd, unerrDir, now: Date.now() });

    // Drain the event store exactly as the daemon does, with a capturing client.
    const posts: unknown[][] = [];
    const client = {
      ingest: async (rows: unknown[]) => {
        posts.push(rows);
        return {
          ok: true as const,
          data: { accepted: rows.length, results: [] },
        };
      },
    } as unknown as CloudClient;

    const set = await buildIngestDrainers({
      repoPath: repoCwd,
      unerrDir,
      repoId: "repo-xyz",
      client,
      source: "unerr-cli@test",
    });
    const cursor = await PushCursor.open(unerrDir);
    const outcomes = await drainRepo(cursor, set.drainers, {
      pushCombined: set.pushCombined,
      isEntitled: () => true,
    });

    const delivered = posts.flat() as Record<string, unknown>[];
    const transcripts = delivered.filter((r) => r.type === "transcript");
    expect(transcripts).toHaveLength(2);
    expect(transcripts.every((r) => r.session_id === "s1")).toBe(true);
    // repo id is stamped at drain time from the daemon's push context.
    expect(transcripts.every((r) => r.repo === "repo-xyz")).toBe(true);
    // Every POST honors the server's row + byte caps (no overload).
    for (const p of posts) {
      expect(p.length).toBeLessThanOrEqual(100);
      expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(
        256 * 1024
      );
    }
    expect(
      outcomes.some((o) => o.stream === "events:transcript" && o.pushed === 2)
    ).toBe(true);
  });
});
