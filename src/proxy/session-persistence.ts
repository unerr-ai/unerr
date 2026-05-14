/**
 * Session Persistence — cross-session continuity for --mcp mode.
 *
 * Layer 9 PI-4: On reconnect, loads the previous session's summary and
 * generates a targeted resume context that includes:
 *   - What was in progress (hot files, incomplete entities)
 *   - Relevant facts from facts.db for those hot files
 *   - Session metrics (duration, tools used, revert count)
 *
 * Staleness rule: sessions older than 24h are considered too stale.
 * The agent gets fresh fact recall but no session continuity context.
 *
 * Graceful degradation: if any step fails, returns null (no crash).
 */

import type { TemporalFact } from "../intelligence/temporal-facts.js";
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
  recalled_facts: Array<{
    fact_id: string;
    type: string;
    content: string;
    confidence: number;
    source: string;
  }>;
  decayed_since_last_session: Array<{
    fact_id: string;
    type: string;
    content: string;
    confidence: number;
  }>;
}

// ── Constants ────────────────────────────────────────────────────────

const STALENESS_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const WARM_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

// ── Public API ───────────────────────────────────────────────────────

/**
 * Generate a session resume payload from the last session's summary.
 * Integrates with facts.db if a fact store is available.
 *
 * Returns null if:
 *   - No prior session exists
 *   - Last session is older than 24h (too stale)
 *   - Any error occurs (graceful degradation)
 */
export async function generateSessionResumePayload(
  unerrDir: string,
  factStore?: {
    recallByScope(scope: string, minConf?: number): Promise<TemporalFact[]>;
    recallDecaying?(minConf: number, maxConf: number): Promise<TemporalFact[]>;
  } | null,
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

    const recalledFacts = await recallFactsForSession(lastSession, factStore);

    // Query facts that recently decayed below recall threshold
    let decayedFacts: Array<{
      fact_id: string;
      type: string;
      content: string;
      confidence: number;
    }> = [];
    if (factStore?.recallDecaying) {
      try {
        const decaying = await factStore.recallDecaying(0.05, 0.2);
        decayedFacts = decaying.slice(0, 5).map((f) => ({
          fact_id: f.fact_id,
          type: f.fact_type,
          content: f.content,
          confidence: Math.round(f.effective_confidence * 100) / 100,
        }));
      } catch {
        // Non-critical
      }
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
      recalled_facts: recalledFacts,
      decayed_since_last_session: decayedFacts,
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
      `${session.revert_count} revert(s) in last session — approach may need rethinking`,
    );
  }

  if (session.files_modified.length > 5) {
    parts.push(
      `Large change set (${session.files_modified.length} files) — verify consistency`,
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

/**
 * Recall facts relevant to the previous session's hot files.
 * Returns up to 5 facts with highest effective confidence.
 */
async function recallFactsForSession(
  session: SessionSummaryRecord,
  factStore?: {
    recallByScope(scope: string, minConf?: number): Promise<TemporalFact[]>;
  } | null,
): Promise<
  Array<{
    fact_id: string;
    type: string;
    content: string;
    confidence: number;
    source: string;
  }>
> {
  if (!factStore) return [];

  try {
    const allFacts: TemporalFact[] = [];

    for (const file of session.files_modified.slice(0, 5)) {
      const facts = await factStore.recallByScope(file);
      for (const f of facts) {
        if (!allFacts.some((existing) => existing.fact_id === f.fact_id)) {
          allFacts.push(f);
        }
      }
    }

    const projectFacts = await factStore.recallByScope("project");
    for (const f of projectFacts) {
      if (
        f.fact_type === "negative" &&
        !allFacts.some((existing) => existing.fact_id === f.fact_id)
      ) {
        allFacts.push(f);
      }
    }

    return allFacts
      .sort((a, b) => b.effective_confidence - a.effective_confidence)
      .slice(0, 5)
      .map((f) => ({
        fact_id: f.fact_id,
        type: f.fact_type,
        content: f.content,
        confidence: Math.round(f.effective_confidence * 100) / 100,
        source: f.source,
      }));
  } catch {
    return [];
  }
}

// ── Visible Resume Block ────────────────────────────────────────────

/**
 * Format session resume payload as a visible text block that agents will read.
 * This is prepended to the first tool response content so it's impossible to miss.
 * Keeps total output under 500 chars.
 */
export function formatSessionResumeBlock(
  payload: SessionResumePayload | null,
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
    `[unerr:session-resume] Previous session (${elapsed} ago): worked on ${filesStr}.`,
  );

  // High-confidence recalled facts
  const importantFacts = payload.recalled_facts
    .filter((f) => f.confidence >= 0.5)
    .slice(0, 3);
  for (const f of importantFacts) {
    const pct = Math.round(f.confidence * 100);
    parts.push(`▸ ${f.content} (${pct}%).`);
  }

  // Decayed facts warning
  if (payload.decayed_since_last_session.length > 0) {
    const n = payload.decayed_since_last_session.length;
    const subjects = payload.decayed_since_last_session
      .slice(0, 2)
      .map((f) => `"${f.content.slice(0, 40)}"`);
    parts.push(
      `⚠ ${n} fact(s) expired since last session: ${subjects.join(", ")}. Use record_fact to re-record if still relevant.`,
    );
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
  return result.length > 500 ? result.slice(0, 497) + "..." : result;
}

function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
