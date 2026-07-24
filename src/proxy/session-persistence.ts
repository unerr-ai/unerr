/**
 * Session Persistence — cross-session continuity for --mcp mode.
 *
 * Layer 9 PI-4: On reconnect, loads the previous session's summary and
 * generates a targeted resume context that includes:
 *   - What was in progress (hot files, incomplete entities)
 *   - Files touched last session, read from timeline.db's session_files
 *     table (independent of the removed journal/marker subsystem)
 *   - Session metrics (duration, tools used, revert count)
 *
 * Staleness rule: sessions older than 24h are considered too stale.
 *
 * Graceful degradation: if any step fails, returns null (no crash).
 */

import { basename } from "node:path";
import type { SessionSummaryRecord } from "../tracking/session-summary-writer.js";

// ── Types ────────────────────────────────────────────────────────────

export interface SessionResumePayload {
  session_resumed: true;
  previous_session: {
    session_id: string;
    duration_ms: number;
    tool_calls: number;
    chains: number;
    files_modified: string[];
    entities_touched: string[];
    tools_used: Record<string, number>;
    feature_areas: string[];
    revert_count: number;
    facts_recorded: number;
    branch: string;
    ended_at: string;
  };
  continuity: {
    hot_files: string[];
    incomplete_hint: string;
    staleness: "fresh" | "warm";
  };
  /** Files touched last session, read from timeline.db's `session_files`
   *  table (populated per-turn, independent of the removed marker
   *  subsystem). Empty when no timelineStore handle is supplied or the
   *  read fails — the resume strip then omits the "Modified…" clause. */
  modified_files?: string[];
  /** P2.2 — entities whose signature changed last session but whose callers
   *  were never updated, reconciled at the prior session's end by
   *  IncompleteWorkDetector and persisted to incomplete-work.json. Surfaced
   *  here so the next session opens knowing exactly which call sites still
   *  need updating. Optional + best-effort (empty when the file is absent). */
  broken_callers?: Array<{
    entity: string;
    callers: string[];
  }>;
}

// ── Constants ────────────────────────────────────────────────────────

const STALENESS_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const WARM_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

// ── Public API ───────────────────────────────────────────────────────

/**
 * Generate a session resume payload from the last session's summary.
 *
 * Returns null if:
 *   - No prior session exists
 *   - Last session is older than 24h (too stale)
 *   - Any error occurs (graceful degradation)
 */
export async function generateSessionResumePayload(
  unerrDir: string,
  timelineStore?: {
    getSessionFiles(sessionId: string): Promise<string[]>;
  } | null
): Promise<SessionResumePayload | null> {
  try {
    const { readLastSession } = await import(
      "../tracking/session-summary-writer.js"
    );
    const lastSession = readLastSession(unerrDir);
    if (!lastSession) return null;

    const endedAt = new Date(lastSession.ended_at).getTime();
    const elapsed = Date.now() - endedAt;

    if (elapsed > STALENESS_THRESHOLD_MS) return null;

    const staleness: "fresh" | "warm" =
      elapsed < WARM_THRESHOLD_MS ? "fresh" : "warm";

    const hotFiles = computeHotFiles(lastSession);
    const incompleteHint = generateIncompleteHint(lastSession);

    // Modified files — read from timeline.db's `session_files` table
    // (recorded per-turn, independent of the removed marker subsystem).
    // Best-effort: a missing timelineStore handle or a read failure
    // degrades to an empty list — the resume strip then omits the
    // "Modified…" clause — never throws.
    let modifiedFiles: SessionResumePayload["modified_files"] = [];
    if (timelineStore) {
      try {
        modifiedFiles = await timelineStore.getSessionFiles(
          lastSession.session_id
        );
      } catch {
        // Non-critical — resume block still renders without the file list.
      }
    }

    // P2.2 — broken callers reconciled at the prior session's end. Best-effort:
    // a missing / unreadable incomplete-work.json yields no flags, never throws.
    let brokenCallers: SessionResumePayload["broken_callers"] = [];
    try {
      const { IncompleteWorkDetector } = await import(
        "../behaviors/incomplete-work.js"
      );
      brokenCallers = IncompleteWorkDetector.readPersistedItems(unerrDir)
        .filter((i) => i.type === "broken_callers" && i.entity)
        .slice(0, 3)
        .map((i) => ({ entity: i.entity!, callers: i.remaining ?? [] }));
    } catch {
      // Non-critical — resume block still renders without broken-caller flags.
    }

    return {
      session_resumed: true,
      previous_session: {
        session_id: lastSession.session_id,
        duration_ms: lastSession.duration_ms,
        tool_calls: lastSession.tool_calls,
        chains: lastSession.chains,
        files_modified: lastSession.files_modified.slice(0, 10),
        entities_touched: lastSession.entities_touched.slice(0, 10),
        tools_used: lastSession.tools_used,
        feature_areas: lastSession.feature_areas,
        revert_count: lastSession.revert_count,
        facts_recorded: lastSession.facts_recorded,
        branch: lastSession.branch,
        ended_at: lastSession.ended_at,
      },
      continuity: {
        hot_files: hotFiles,
        incomplete_hint: incompleteHint,
        staleness,
      },
      modified_files: modifiedFiles,
      broken_callers: brokenCallers,
    };
  } catch {
    return null;
  }
}

// ── Internal Helpers ─────────────────────────────────────────────────

/**
 * Compute the "hot files" — files most likely to be worked on again.
 * Prioritizes files that appeared most frequently in tool calls.
 */
function computeHotFiles(session: SessionSummaryRecord): string[] {
  return session.files_modified.slice(0, 5);
}

/**
 * Generate a human-readable hint about what was incomplete.
 */
function generateIncompleteHint(session: SessionSummaryRecord): string {
  const parts: string[] = [];

  if (session.revert_count > 0) {
    parts.push(
      `${session.revert_count} revert(s) in last session — approach may need rethinking`
    );
  }

  if (session.files_modified.length > 5) {
    parts.push(
      `Large change set (${session.files_modified.length} files) — verify consistency`
    );
  }

  const highUseTools = Object.entries(session.tools_used)
    .filter(([_, count]) => count > 10)
    .map(([tool]) => tool);
  if (highUseTools.length > 0) {
    parts.push(`Heavy usage: ${highUseTools.join(", ")}`);
  }

  if (parts.length === 0) {
    return session.files_modified.length > 0
      ? `Continuing work on ${session.files_modified.slice(0, 3).join(", ")}`
      : "No specific continuity context";
  }

  return parts.join(". ");
}

// ── Visible Resume Block ────────────────────────────────────────────

/**
 * Format session resume payload as a compact continuity block agents will
 * read: tool-call count + duration, up to 3 modified-file basenames, the
 * branch, and two safety signals the prior session's end reconciled — the
 * incomplete-work hint and any callers left un-updated after a signature
 * change (`broken_callers`). All derived from tracked session data and
 * graph analysis, never from an agent-emitted marker. Prepended to the
 * first tool response content so it's impossible to miss. Capped at 500 chars.
 */
export function formatSessionResumeBlock(
  payload: SessionResumePayload | null
): string {
  if (!payload) return "";

  const { tool_calls, duration_ms, branch } = payload.previous_session;
  const parts: string[] = [
    `Last session: ${tool_calls} tool calls over ${formatDuration(duration_ms)}`,
  ];

  // Modified files — degrades gracefully to omitting this clause when
  // session_files was empty or unavailable (no timelineStore handle, or
  // the read failed).
  const files = payload.modified_files ?? [];
  if (files.length > 0) {
    const basenames = files.map((f) => basename(f));
    const shown = basenames.slice(0, 3).join(", ");
    const more = basenames.length > 3 ? ` (+${basenames.length - 3} more)` : "";
    parts.push(`Modified ${basenames.length} file(s): ${shown}${more}`);
  }

  if (branch) {
    parts.push(`Branch: ${branch}`);
  }

  // Continuity signals reconciled at the prior session's end — event- and
  // graph-derived, independent of the removed marker subsystem. Rendered
  // after the stats so the actionable "callers still to update" reads last.
  const hint = payload.continuity?.incomplete_hint;
  if (hint && hint !== "No specific continuity context") {
    parts.push(hint);
  }

  const broken = payload.broken_callers ?? [];
  if (broken.length > 0) {
    const shown = broken
      .slice(0, 2)
      .map((b) => {
        const name = b.entity.split("::").pop() ?? b.entity;
        const n = b.callers.length;
        return `${name} (${n} caller${n === 1 ? "" : "s"})`;
      })
      .join(", ");
    parts.push(`Callers still to update: ${shown}`);
  }

  const result = `${parts.join(". ")}.`;
  // Truncate to 500 chars max
  return result.length > 500 ? `${result.slice(0, 497)}...` : result;
}

/** Formats a duration in milliseconds as "<minutes>m <seconds>s". */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}
