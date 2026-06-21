/**
 * L1 — transcript producer. Verifies the transcript materializer mirrors each
 * persisted transcript row into the unified per-repo event store as one
 * contract-shaped `transcript` event: prose in `trace_text` (code-stripped
 * upstream), a short `speaker` label, and the turn's identity on the envelope.
 *
 * The materializer runs in a hook process where the proxy never installs the
 * ambient emit context — so this test asserts it emits via its OWN explicit
 * context (to the per-pid hook segment) with `configureEmit` NEVER called. The
 * metrics store and readers are mocked so no real transcript files are needed.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestEvent } from "@unerr-ai/contracts/ingest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deterministicId } from "../cloud/event-id.js";
import { _resetEmitContextForTest } from "../events/enqueue.js";
import { hookSegment, segmentPath } from "../events/event-store.js";

vi.mock("../tracking/agent-transcript/index.js", () => ({
  readAgentTranscriptsFlag: () => true,
  getTranscriptCapability: () => "jsonl",
  readClaudeTranscript: vi.fn(),
  readCursorTranscript: vi.fn(),
  readCursorStateVscdb: vi.fn(),
}));

const upsertAgentTranscript = vi.fn();
vi.mock("../tracking/metrics-store.js", () => ({
  openMetricsStore: () => ({
    getAgentTranscriptsForSession: () => [],
    upsertAgentTranscript,
  }),
}));

import { readClaudeTranscript } from "../tracking/agent-transcript/index.js";
import { materializeTranscripts } from "../tracking/transcript-materializer.js";

describe("L1 transcript producer — materializer emits a transcript event", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "unerr-transcript-emit-"));
    // Deliberately leave the ambient context UNconfigured — the materializer
    // must emit through its own explicit context, exactly as it does in the
    // hook process where the proxy's `configureEmit` never ran.
    _resetEmitContextForTest();
    upsertAgentTranscript.mockReset();
    vi.mocked(readClaudeTranscript).mockResolvedValue([
      {
        native_session_id: "claude-uuid-abc",
        turn_index: 3,
        started_ts: "2026-06-20T23:59:50.000Z",
        ended_ts: "2026-06-20T23:59:50.000Z",
        tokens_used: { input: 0, output: 0, cache_create: 0, cache_read: 0 },
        tools: [],
        files: [],
        model: null,
        role: "user",
        text: "wire the emit call",
      },
      {
        native_session_id: "claude-uuid-abc",
        turn_index: 4,
        started_ts: "2026-06-21T00:00:00.000Z",
        ended_ts: "2026-06-21T00:00:05.000Z",
        tokens_used: {
          input: 1200,
          output: 340,
          cache_create: 0,
          cache_read: 0,
        },
        tools: ["Edit", "Bash"],
        files: ["src/foo.ts"],
        model: "claude-opus",
        role: "assistant",
        text: "I will wire the emit call after the upsert.",
      },
    ]);
  });

  afterEach(() => {
    _resetEmitContextForTest();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** Read every `transcript` event from the per-pid hook segment. */
  function readTranscriptEvents(): Record<string, unknown>[] {
    const segment = segmentPath(repoRoot, hookSegment(process.pid));
    return readFileSync(segment, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type === "transcript");
  }

  it("emits prose, speaker, deterministic identity, and a conversational turn", async () => {
    const count = await materializeTranscripts({
      unerrDir: join(repoRoot, ".unerr"),
      repoCwd: repoRoot,
      sessionId: "abc123",
      agent: "claude-code",
    });

    expect(count).toBe(2);
    expect(upsertAgentTranscript).toHaveBeenCalledTimes(2);

    const events = readTranscriptEvents();
    expect(events).toHaveLength(2);

    const event = events.find(
      (e) => (e.detail as Record<string, unknown>).speaker === "agent"
    ) as Record<string, unknown>;
    const detail = event.detail as Record<string, unknown>;
    expect(detail.trace_text).toBe(
      "I will wire the emit call after the upsert."
    );
    expect(detail.tokens_in).toBe(1200);
    expect(detail.tokens_out).toBe(340);

    // Envelope identity (not in detail).
    expect(event.session_id).toBe("abc123");
    expect(event.native_session_id).toBe("claude-uuid-abc");
    // Conversational turn, NOT the raw message ordinal (4): the user message
    // (turn_index 3) opens turn 1; the assistant reply inherits it.
    expect(event.turn).toBe(1);

    // Deterministic identity so a re-emit collapses server-side rather than
    // duplicating: event_id from (session, message ordinal, speaker); ts is the
    // message's own start, not emit time.
    expect(event.event_id).toBe(
      deterministicId("transcript", "abc123", "4", "agent")
    );
    expect(event.ts).toBe("2026-06-21T00:00:00.000Z");

    // detail carries prose only — no raw code/diff/file fields.
    expect("files" in detail).toBe(false);
    expect("tools" in detail).toBe(false);
    expect("model" in detail).toBe(false);

    // Validate against the shared ingest contract.
    expect(IngestEvent.safeParse(event).success).toBe(true);
  });

  it("re-materializing the same turn re-emits identical event_id + ts (cloud dedup)", async () => {
    const opts = {
      unerrDir: join(repoRoot, ".unerr"),
      repoCwd: repoRoot,
      sessionId: "abc123",
      agent: "claude-code",
    };
    await materializeTranscripts(opts);
    await materializeTranscripts(opts);

    const events = readTranscriptEvents();
    // Two passes × two rows = four lines on the segment, but only two distinct
    // (event_id, ts) identities — the server's ReplacingMergeTree collapses each
    // pair into one row.
    expect(events.length).toBe(4);
    const identities = new Set(
      events.map((e) => `${String(e.event_id)}@${String(e.ts)}`)
    );
    expect(identities.size).toBe(2);
  });
});
