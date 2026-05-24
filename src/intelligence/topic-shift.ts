/**
 * Topic-shift detection — Sprint C item 6, §11.6.
 *
 * `unerr_recall_for_prompt` returns `topic_shift: boolean`. Heuristic:
 * the agent's current prompt's likely anchors vs the last N=10 turns'
 * anchors. If Jaccard overlap < THRESHOLD, the user (or sub-task) has
 * pivoted — Surface 2 preface renders a topic-shift line.
 *
 * Pure module. The session-history table is read elsewhere; this just
 * does the math on the two anchor sets.
 *
 * Anchor representation is wire-format ("f:src/a.ts", "p:") — same
 * shape used by the recall handlers in notes-store.
 */

export const TOPIC_SHIFT_DEFAULT_WINDOW = 10;
export const TOPIC_SHIFT_DEFAULT_THRESHOLD = 0.2;

export interface TopicShiftInput {
  /** Anchors the current prompt likely touches. */
  current_anchors: readonly string[];
  /** Anchors seen over the recent window of turns, most recent last. */
  recent_anchors_by_turn: readonly (readonly string[])[];
  /** How many trailing turns count as "recent". Default 10. */
  window?: number;
  /** Jaccard overlap below which we flag a shift. Default 0.2. */
  threshold?: number;
}

export interface TopicShiftResult {
  /** True when overlap is below threshold AND a recent history exists. */
  topic_shift: boolean;
  /** Jaccard overlap between current and recent. 0 when either side is empty. */
  overlap: number;
  /** Why the flag fired (or didn't). For surface rendering & telemetry. */
  reason:
    | "no_recent_history"
    | "no_current_anchors"
    | "overlap_above_threshold"
    | "shift_below_threshold";
}

/** Compute Jaccard overlap between two anchor sets. 0 when either is empty. */
export function jaccardOverlap(
  a: readonly string[],
  b: readonly string[]
): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

/**
 * Detect topic shift. Returns the boolean flag + the overlap value so
 * callers can render telemetry without recomputing.
 */
export function detectTopicShift(input: TopicShiftInput): TopicShiftResult {
  const window = input.window ?? TOPIC_SHIFT_DEFAULT_WINDOW;
  const threshold = input.threshold ?? TOPIC_SHIFT_DEFAULT_THRESHOLD;

  if (input.current_anchors.length === 0) {
    return {
      topic_shift: false,
      overlap: 0,
      reason: "no_current_anchors",
    };
  }
  const trailing = input.recent_anchors_by_turn.slice(-window);
  const recentFlat = trailing.flat();
  if (recentFlat.length === 0) {
    return {
      topic_shift: false,
      overlap: 0,
      reason: "no_recent_history",
    };
  }
  const overlap = jaccardOverlap(input.current_anchors, recentFlat);
  if (overlap < threshold) {
    return {
      topic_shift: true,
      overlap,
      reason: "shift_below_threshold",
    };
  }
  return {
    topic_shift: false,
    overlap,
    reason: "overlap_above_threshold",
  };
}

// ── Session-level one-shot cache ─────────────────────────────────────
//
// `recallByPrompt` (notes-store) computes topic_shift but the value
// only reaches the agent when the tool itself is called. To make the
// signal reach the start-of-turn preface (Surface 2) regardless of
// whether the agent volunteered to call the recall tool, we stash the
// most recent topic_shift result in a session-keyed cache. The preface
// renderer drains it on the next turn (read-once). Cleared implicitly
// on process exit.

export interface PendingTopicShift {
  flag: boolean;
  overlap: number;
}

const PENDING_TOPIC_SHIFT = new Map<string, PendingTopicShift>();

/** Resolve the on-disk path for the cross-process topic-shift cache.
 *  Written by `setPendingTopicShift`, read+drained by the prompt-submit
 *  hook subprocess (which has no in-memory map). */
function pendingTopicShiftPath(): string {
  // Lazy require to avoid forcing node:path/node:fs on hot paths that
  // never call it.
  // biome-ignore lint/style/useNodejsImportProtocol: lazy require keeps cold-start cheap
  const { join } = require("node:path");
  return join(process.cwd(), ".unerr", "state", "topic-shift-pending.json");
}

/** Record the latest topic_shift result for a session. Overwrites any
 *  prior pending value. Called from the recall path (notes-store /
 *  prompt-hook). Persists to a flat file so the prompt-submit hook
 *  subprocess can drain the same signal. */
export function setPendingTopicShift(
  sessionId: string,
  shift: PendingTopicShift
): void {
  PENDING_TOPIC_SHIFT.set(sessionId, shift);
  try {
    // biome-ignore lint/style/useNodejsImportProtocol: lazy require
    const { mkdirSync, writeFileSync } = require("node:fs");
    // biome-ignore lint/style/useNodejsImportProtocol: lazy require
    const { dirname } = require("node:path");
    const path = pendingTopicShiftPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ session_id: sessionId, ...shift }),
      "utf-8"
    );
  } catch {
    /* best-effort cross-process mirror */
  }
}

/** Read and clear the pending topic_shift for a session. Returns null
 *  when no shift is pending. Drains both the in-memory map and the
 *  on-disk flat file. */
export function consumePendingTopicShift(
  sessionId: string
): PendingTopicShift | null {
  const v = PENDING_TOPIC_SHIFT.get(sessionId);
  if (v) {
    PENDING_TOPIC_SHIFT.delete(sessionId);
    try {
      // biome-ignore lint/style/useNodejsImportProtocol: lazy require
      const { unlinkSync } = require("node:fs");
      unlinkSync(pendingTopicShiftPath());
    } catch {
      /* file may already be gone */
    }
    return v;
  }
  // In-process miss — try the flat file for hook-subprocess drains.
  try {
    // biome-ignore lint/style/useNodejsImportProtocol: lazy require
    const { existsSync, readFileSync, unlinkSync } = require("node:fs");
    const path = pendingTopicShiftPath();
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as {
      session_id: string;
      flag: boolean;
      overlap: number;
    };
    unlinkSync(path);
    if (parsed.session_id !== sessionId) return null;
    return { flag: parsed.flag, overlap: parsed.overlap };
  } catch {
    return null;
  }
}

/** Subprocess-friendly drain that doesn't care which session_id wrote
 *  the value. Used by the prompt-submit hook, which has no session id
 *  of its own — the most recent shift wins. */
export function consumeAnyPendingTopicShift(): PendingTopicShift | null {
  try {
    // biome-ignore lint/style/useNodejsImportProtocol: lazy require
    const { existsSync, readFileSync, unlinkSync } = require("node:fs");
    const path = pendingTopicShiftPath();
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as { flag: boolean; overlap: number };
    unlinkSync(path);
    return { flag: parsed.flag, overlap: parsed.overlap };
  } catch {
    return null;
  }
}
