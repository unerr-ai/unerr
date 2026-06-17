/**
 * Transcript materializer — persist agent transcript data into metrics.db.
 *
 * Reads from the existing agent-transcript readers (Claude JSONL, Cursor
 * SQLite) and writes to the `agent_transcripts` table. Called lazily:
 *   1. On prompt capture hook fire (background, non-blocking)
 *   2. On first logbook API access per session (query-time cache fill)
 *
 * The materializer is idempotent — UPSERT on (session_id, turn, role)
 * means re-running is safe and only overwrites with newer data.
 */

import { startupLog } from "../utils/startup-log.js";
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

export interface MaterializeOptions {
  unerrDir: string;
  repoCwd: string;
  sessionId: string;
  agent: string;
}

/**
 * Materialize agent transcripts for a session into metrics.db.
 * Returns the number of rows upserted (0 if nothing was available).
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
