/**
 * Session Persistence — cross-session continuity for --mcp mode.
 *
 * Layer 9 PI-4: On reconnect, loads the previous session's summary and
 * generates a targeted resume context that includes:
 *   - What was in progress (hot files, incomplete entities)
 *   - Carried-over blockers + last intent from timeline.db markers
 *   - Session metrics (duration, tools used, revert count)
 *
 * Staleness rule: sessions older than 24h are considered too stale.
 *
 * Graceful degradation: if any step fails, returns null (no crash).
 */

import type { MarkerRow } from "../timeline/timeline-store.js";
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
  /** Fix K — top-3 still-open blockers carried over from prior sessions.
   *  Surfaced in the resume block as the "5-minute first win" — user opens
   *  chat next morning and sees what they were stuck on. Optional because
   *  callers may not have a timelineStore handle (graceful degradation). */
  open_blockers?: Array<{
    marker_id: string;
    text: string;
    file_path: string;
    ts: number;
  }>;
  /** Fix K — top-3 most-recent `mark_intent` rows from the prior session.
   *  Anchors what the user was trying to do so the next turn's plan can
   *  cite it ("picking up: <verbatim intent>"). */
  last_intents?: Array<{
    marker_id: string;
    text: string;
    ts: number;
  }>;
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
    listMarkers(opts: {
      sessionId?: string;
      type?: string;
      limit?: number;
    }): Promise<MarkerRow[]>;
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

    // Fix K — open-blocker + last-intent injection. Both queries are
    // best-effort and silently no-op when the timelineStore handle is
    // missing or throws (e.g. timeline.db not yet initialised).
    let openBlockers: SessionResumePayload["open_blockers"] = [];
    let lastIntents: SessionResumePayload["last_intents"] = [];
    if (timelineStore) {
      try {
        const { getOpenThreads } = await import("../timeline/open-threads.js");
        const blockers = await getOpenThreads(
          timelineStore as Parameters<typeof getOpenThreads>[0],
          { limit: 50 }
        );
        openBlockers = blockers.slice(0, 3).map((b) => ({
          marker_id: b.marker_id,
          text: b.text,
          file_path: b.file_path,
          ts: b.ts,
        }));
      } catch {
        // Non-critical — resume block still renders without blockers.
      }
      try {
        const intentRows = await timelineStore.listMarkers({
          sessionId: lastSession.session_id,
          type: "mark_intent",
          limit: 3,
        });
        lastIntents = intentRows.map((m) => ({
          marker_id: m.marker_id,
          text: m.text,
          ts: m.ts,
        }));
      } catch {
        // Non-critical.
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
      open_blockers: openBlockers,
      last_intents: lastIntents,
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
 * Format session resume payload as a visible text block that agents will read.
 * This is prepended to the first tool response content so it's impossible to miss.
 * Keeps total output under 500 chars.
 */
export function formatSessionResumeBlock(
  payload: SessionResumePayload | null
): string {
  if (!payload) return "";

  const parts: string[] = [];

  // Elapsed time
  const endedMs = new Date(payload.previous_session.ended_at).getTime();
  const elapsedMs = Date.now() - endedMs;
  const elapsed = formatElapsed(elapsedMs);

  // Hot files
  const hotFiles = payload.continuity.hot_files.slice(0, 3);
  const filesStr = hotFiles.length > 0 ? hotFiles.join(", ") : "various files";
  parts.push(
    `[unerr:session-resume] Previous session (${elapsed} ago): worked on ${filesStr}.`
  );

  // Fix K — last intent first (narrative arc: what you were doing → what
  // stopped you → relevant rules). Single-line, ≤80 chars per marker spec.
  if (payload.last_intents && payload.last_intents.length > 0) {
    const intent = payload.last_intents[0];
    // Markers now store up to 1400 chars; the strip stays single-line, so
    // truncate to a title-length preview here.
    if (intent) parts.push(`▸ last intent: ${truncateForStrip(intent.text)}`);
  }

  // Fix K — open blockers carried over. The "5-minute first win" — user
  // opens chat next morning and sees what they were stuck on, with the
  // file anchor so they can jump straight back in.
  if (payload.open_blockers && payload.open_blockers.length > 0) {
    for (const b of payload.open_blockers.slice(0, 3)) {
      const anchor = b.file_path ? ` [${b.file_path}]` : "";
      parts.push(`▸ unresolved blocker: ${truncateForStrip(b.text)}${anchor}`);
    }
  }

  // P2.2 — broken callers: a signature changed last session but these call
  // sites were never updated. Names the exact file:entity to fix, so the next
  // turn can open them directly instead of rediscovering the breakage.
  if (payload.broken_callers && payload.broken_callers.length > 0) {
    for (const bc of payload.broken_callers.slice(0, 3)) {
      const sites = bc.callers.slice(0, 3).join(", ");
      const more =
        bc.callers.length > 3 ? ` (+${bc.callers.length - 3} more)` : "";
      parts.push(
        `▸ unfinished: changed ${bc.entity}, callers not updated: ${sites}${more}. call get_references({direction:'callers'}) on ${bc.entity}`
      );
    }
  }

  // Incomplete hint if meaningful
  if (
    payload.continuity.incomplete_hint &&
    payload.continuity.incomplete_hint !== "No specific continuity context"
  ) {
    parts.push(`▸ ${payload.continuity.incomplete_hint}`);
  }

  const result = parts.join("\n");
  // Truncate to 500 chars max
  return result.length > 500 ? `${result.slice(0, 497)}...` : result;
}

/**
 * Markers store up to 1400 chars (MARKER_TEXT_CAP) but the resume strip is a
 * single-line title rail — clip long marker text to a preview so one verbose
 * resolution can't dominate the strip.
 */
function truncateForStrip(text: string, max = 100): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
