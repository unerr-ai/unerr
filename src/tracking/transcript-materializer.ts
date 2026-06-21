/**
 * Transcript materializer — persist agent transcript rows and push each to the
 * cloud as a `transcript` event.
 *
 * Reads from the existing agent-transcript readers (Claude JSONL, Cursor
 * SQLite), writes each row to the local transcript cache, and `enqueue`s one
 * `transcript` event per row to the per-repo event store so `unerrd` drains it
 * to the cloud. Called at turn-end (Stop hook) and on prompt capture — both run
 * in a hook process, so the emit uses an explicit context, not the proxy's
 * ambient one. Idempotent: UPSERT on (session_id, turn, role) makes re-running
 * safe; the per-row `event_id` makes the cloud push deduplicate.
 */

import { deterministicId } from "../cloud/event-id.js";
import { type EmitContext, enqueue } from "../events/enqueue.js";
import { hookSegment } from "../events/event-store.js";
import { startupLog } from "../utils/startup-log.js";
import { UNERR_VERSION } from "../version.js";
import {
  getTranscriptCapability,
  readAgentTranscriptsFlag,
  readClaudeTranscript,
  readCursorStateVscdb,
  readCursorTranscript,
} from "./agent-transcript/index.js";
import { openMetricsStore } from "./metrics-store.js";

// Matches the transcripts wire cap (`TRANSCRIPT_TEXT_CAP` = 16 KB in
// src/cloud/drainers/transcripts.ts). Storing up to the wire cap means the
// transcript push stream's final clip (B2-clip) is the only place prose is
// trimmed — the store does not silently lose prose below the wire limit first.
const TEXT_LIMIT = 16_384;

function truncate(
  s: string | null | undefined,
  limit = TEXT_LIMIT
): string | null {
  if (!s) return null;
  return s.length > limit ? `${s.slice(0, limit)}...` : s;
}

// Contract `speaker` is a short role label ("agent"|"user"|"tool"). Map the
// row's transcript role onto it: an assistant turn is the AI model ("agent"),
// a system turn is closest to tool output fed back ("tool"), a user turn stays.
function speakerForRole(role: "user" | "assistant" | "system"): string {
  if (role === "assistant") return "agent";
  if (role === "system") return "tool";
  return "user";
}

// Lean cap for the emitted trace prose. The contract clips at TRACE_MAX_TRACE_TEXT
// (16 KB) server-side; keep the wire body small here so a bulk turn never rides.
const TRACE_TEXT_EMIT_LIMIT = 4_096;

export interface MaterializeOptions {
  unerrDir: string;
  repoCwd: string;
  sessionId: string;
  agent: string;
}

/**
 * Materialize agent transcripts for a session into the local cache and push each
 * row to the cloud. Returns the number of rows upserted (0 if nothing available).
 *
 * Best-effort: never throws. Failures are logged and swallowed so the
 * caller (hook or API handler) is never blocked.
 */
export async function materializeTranscripts(
  opts: MaterializeOptions
): Promise<number> {
  try {
    if (!readAgentTranscriptsFlag(opts.repoCwd)) return 0;

    const cap = getTranscriptCapability(opts.agent);
    if (!cap) return 0;

    const store = openMetricsStore(opts.unerrDir);

    // Incremental high-water mark (replaces the old once-per-session guard).
    // Re-materialize from the LAST already-stored turn forward, not from zero:
    // the boundary turn may have grown since the previous pass (its final
    // assistant message extends as the agent streams), and turns past it are
    // new. The UPSERT on (session_id, turn, role) makes re-writing the boundary
    // turn idempotent. A fresh session has highWater = -1 → materialize all.
    const existing = store.getAgentTranscriptsForSession(opts.sessionId);
    let highWater = -1;
    for (const r of existing) {
      if (r.turn > highWater) highWater = r.turn;
    }

    let turns =
      cap === "jsonl"
        ? await readClaudeTranscript({ repoCwd: opts.repoCwd })
        : await readCursorTranscript({ repoCwd: opts.repoCwd });

    // For Cursor, also read the richer state.vscdb chat store which
    // carries per-message prompts, tool calls, files, and token counts.
    if (cap === "sqlite") {
      const vscdbTurns = await readCursorStateVscdb({
        repoCwd: opts.repoCwd,
      });
      if (vscdbTurns.length > 0) {
        // Prefer vscdb data (richer per-message content) over telemetry
        // summaries. If both returned data, use vscdb.
        turns = vscdbTurns;
      }
    }

    if (turns.length === 0) return 0;

    // This runs in the hook process, where the proxy never installs the ambient
    // emit context — so the zero-arg `emit()` would silently no-op. Build an
    // explicit context and `enqueue` to this process's own per-pid hook segment
    // (never the proxy's, preserving one-writer-per-segment). repo / branch /
    // commit are stamped at drain from the daemon's push context.
    const ctx: EmitContext = {
      repoRoot: opts.repoCwd,
      segment: hookSegment(process.pid),
      source: `unerr-cli@${UNERR_VERSION}`,
      agent: opts.agent,
    };

    // `turn_index` is a global message ordinal (one row per message), so for a
    // long session it runs into the thousands — useless as a turn on the wire.
    // Map each message's turn_index to a conversational turn that increments on
    // every user message (assistant/tool messages inherit the current turn).
    // Built over the FULL turn list so the numbering is stable across the
    // per-turn incremental re-materialize. The row key + event_id keep using the
    // unique turn_index; only the envelope `turn` carries this readable number.
    const convTurn = new Map<number, number>();
    {
      let cur = 0;
      for (const r of [...turns].sort((a, b) => a.turn_index - b.turn_index)) {
        if (r.role === "user") cur++;
        convTurn.set(r.turn_index, cur);
      }
    }

    let count = 0;
    for (const t of turns) {
      // Skip turns strictly below the boundary — already fully materialized.
      // Re-upsert the boundary turn (==) and append everything above it.
      if (t.turn_index < highWater) continue;
      store.upsertAgentTranscript({
        session_id: opts.sessionId,
        native_session_id: t.native_session_id,
        turn: t.turn_index,
        agent: opts.agent,
        role: t.role,
        text: truncate(t.text),
        tools: t.tools.length > 0 ? JSON.stringify(t.tools) : null,
        files: t.files.length > 0 ? JSON.stringify(t.files) : null,
        model: t.model,
        tokens_input: t.tokens_used.input,
        tokens_output: t.tokens_used.output,
        ts: t.started_ts ?? new Date().toISOString(),
      });
      count++;

      // L1 — mirror the persisted transcript row into the unified per-repo event
      // store so `unerrd` drains it to the cloud. One transcript event per row.
      // trace_text carries the turn's prose only (tool-call payloads / thinking
      // blocks are already excluded upstream); raw file contents / code never
      // ride. enqueue is fire-and-forget; the daemon drains the hook segment.
      // event_id + ts are DETERMINISTIC: the same (session, message, speaker)
      // re-emitted across passes produces an identical row, so the cloud's
      // ReplacingMergeTree (sort key includes ts + event_id) collapses the
      // re-emit instead of writing a near-duplicate. ts is the message's own
      // time, not emit time, so it is stable across re-materialize.
      const speaker = speakerForRole(t.role);
      enqueue(ctx, {
        type: "transcript",
        event_id: deterministicId(
          "transcript",
          opts.sessionId,
          String(t.turn_index),
          speaker
        ),
        ...(t.started_ts ? { ts: t.started_ts } : {}),
        detail: {
          speaker,
          ...(t.text
            ? { trace_text: t.text.slice(0, TRACE_TEXT_EMIT_LIMIT) }
            : {}),
          ...(t.tokens_used.input > 0
            ? { tokens_in: t.tokens_used.input }
            : {}),
          ...(t.tokens_used.output > 0
            ? { tokens_out: t.tokens_used.output }
            : {}),
        },
        session_id: opts.sessionId,
        native_session_id: t.native_session_id,
        turn: convTurn.get(t.turn_index) ?? t.turn_index,
      });
    }
    return count;
  } catch (err) {
    startupLog.warn(
      `transcript-materializer: failed for session ${opts.sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return 0;
  }
}
