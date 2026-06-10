/**
 * Signal Emission Dedup — gates `ur|<tag>` signal lines so the same fact is not
 * re-emitted on every tool call within a session.
 *
 * Why: `buildSignalPrefix` (response-envelope.ts) and `applyWireCap`
 * (wire-cap.ts) inject anti-drift signals into MCP tool response bodies. Many
 * of these — risk scores, project facts, hints — are *sticky knowledge*: true
 * for the whole session and never changing. Re-emitting them on every call
 * drowns the model in fluff and inflates token cost.
 *
 * Three signal classes:
 *   1. Critical / state-change (always emit): hlt, dft, hth — circuit-break,
 *      drift, session health. Re-emit because state has actually changed.
 *   2. Sticky knowledge (emit once or on content change): rsk, fct, hnt, hst,
 *      cnv, pro, sem, epi — surface once per (tag, entity), then again only
 *      if the content actually changes.
 *   3. Hard once-per-session: wrn — anti-pattern warnings stay relevant the
 *      whole session but the agent only needs to be told once.
 *   4. Drop entirely: ctx — "context already delivered" is itself noise; the
 *      session-dedup layer already gates the underlying context.
 *
 * Dedup key: `${tag}:${entityKey ?? "global"}:${valueHash}` for `on_change`
 * policy, `${tag}:${entityKey ?? "global"}` for `once_per_session` / `always`
 * (always still records but never blocks).
 *
 * Process-lifetime in-memory only (matches session-dedup.ts pattern). Bounded
 * to MAX_TRACKED to prevent unbounded growth in long-running daemons.
 */

const MAX_TRACKED = 5000;

export type DedupPolicy = "always" | "on_change" | "once_per_session" | "drop";

/**
 * Default policy by 3-char signal tag. See ur|<tag> legend in
 * response-envelope.ts (SIGNAL_PREFIX_LEGEND).
 */
export const DEFAULT_POLICY: Record<string, DedupPolicy> = {
  hlt: "always",
  dft: "always",
  hth: "always",
  rsk: "on_change",
  fct: "on_change",
  // `wrn` was once_per_session — that silenced ALL warnings after the first
  // `ur|wrn No dependencies` line, including content-distinct negative-fact
  // warnings ("Never mock CozoDB...", "anti-pattern in hooks...") that target
  // a different entity. on_change already suppresses *identical* (tag, scope,
  // content) repeats, which is the only thing once_per_session protected
  // against. Different scope or different content = genuinely new warning,
  // surface it.
  wrn: "on_change",
  hnt: "on_change",
  hst: "on_change",
  cnv: "on_change",
  pro: "on_change",
  sem: "on_change",
  epi: "on_change",
  // Comment-drift (Layer 8 §5.1) — on_change fires the staleness nudge once per
  // episode: stable message → emitted once, then suppressed until the prose is
  // re-stamped (clearing it) and a later edit re-drifts with a new message.
  cdr: "on_change",
  // Boundary-erosion (Layer 8 §6, SC-D.3) — on_change fires the low-purity
  // community nudge once per episode: the message carries the purity percent,
  // so it re-emits only when the community's purity vote actually shifts.
  ber: "on_change",
  ctx: "drop",
};

export interface SignalDedup {
  /** Returns true iff this signal should be emitted on the wire now. */
  shouldEmit: (
    tag: string,
    entityKey: string | null,
    content: string
  ) => boolean;
  /**
   * Peek-only variant of `shouldEmit`. Returns the same boolean but does NOT
   * record the emission. Used by upstream rankers (signal-scorer) to filter
   * out signals that would be dropped at the wire boundary, so rank slots
   * aren't wasted on already-suppressed content.
   */
  wouldEmit: (
    tag: string,
    entityKey: string | null,
    content: string
  ) => boolean;
  /** Force-reset the table (tests). */
  reset: () => void;
  /** Current entry count (tests / diagnostics). */
  size: () => number;
}

/**
 * djb2 — fast non-cryptographic hash for content fingerprinting.
 * Good enough to detect "same risk message as last time".
 */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

interface Entry {
  /** Last content hash seen for this (tag, entity). Used by on_change. */
  lastHash: string;
  /** Wall-clock ms of first emission — diagnostic only. */
  firstEmittedAt: number;
}

/**
 * N6 — per-tag session emission cap. Low-priority advisory tags (hint,
 * fact, convention, episodic) are noisy when each new entity legitimately
 * produces a different message — `on_change` lets them all through. The cap
 * adds a session-level ceiling: after N emissions of the same tag in this
 * session, further emissions are dropped regardless of content.
 *
 * Critical tags (hlt/dft/rsk/hth/wrn/hst) are NOT capped — those are
 * load-bearing and must always reach the agent.
 */
const TAG_SESSION_CAP: Record<string, number> = {
  hnt: 5,
  fct: 4,
  cnv: 4,
  pro: 4,
  sem: 4,
  epi: 4,
};

export function createSignalDedup(
  policyOverride: Record<string, DedupPolicy> = {}
): SignalDedup {
  const seen = new Map<string, Entry>();
  const policy = { ...DEFAULT_POLICY, ...policyOverride };
  const tagCounts = new Map<string, number>();

  function evictIfNeeded(): void {
    if (seen.size <= MAX_TRACKED) return;
    const target = Math.floor(MAX_TRACKED * 0.2);
    const iter = seen.keys();
    let removed = 0;
    while (removed < target) {
      const r = iter.next();
      if (r.done) break;
      seen.delete(r.value);
      removed++;
    }
  }

  function shouldEmit(
    tag: string,
    entityKey: string | null,
    content: string
  ): boolean {
    const p: DedupPolicy = policy[tag] ?? "on_change";
    if (p === "drop") return false;
    if (p === "always") return true;

    // N6 — session-level cap for advisory tags
    const cap = TAG_SESSION_CAP[tag];
    if (cap !== undefined && (tagCounts.get(tag) ?? 0) >= cap) {
      return false;
    }

    const k = `${tag}:${entityKey ?? "global"}`;
    const entry = seen.get(k);
    const contentHash = hash(content);

    if (!entry) {
      seen.set(k, { lastHash: contentHash, firstEmittedAt: Date.now() });
      evictIfNeeded();
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      return true;
    }

    if (p === "once_per_session") {
      return false;
    }

    // on_change — emit only if content actually changed.
    if (entry.lastHash !== contentHash) {
      entry.lastHash = contentHash;
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      return true;
    }
    return false;
  }

  function wouldEmit(
    tag: string,
    entityKey: string | null,
    content: string
  ): boolean {
    const p: DedupPolicy = policy[tag] ?? "on_change";
    if (p === "drop") return false;
    if (p === "always") return true;

    // N6 — session-cap check
    const cap = TAG_SESSION_CAP[tag];
    if (cap !== undefined && (tagCounts.get(tag) ?? 0) >= cap) return false;

    const k = `${tag}:${entityKey ?? "global"}`;
    const entry = seen.get(k);
    if (!entry) return true;
    if (p === "once_per_session") return false;
    return entry.lastHash !== hash(content);
  }

  function reset(): void {
    seen.clear();
    tagCounts.clear();
  }

  function size(): number {
    return seen.size;
  }

  return { shouldEmit, wouldEmit, reset, size };
}

/** Module-level singleton — most callers share one process-wide table. */
let _singleton: SignalDedup | null = null;
export function getSignalDedup(): SignalDedup {
  if (!_singleton) _singleton = createSignalDedup();
  return _singleton;
}

/** Test helper — clears the singleton between cases. */
export function resetSignalDedupSingleton(): void {
  _singleton = null;
}
