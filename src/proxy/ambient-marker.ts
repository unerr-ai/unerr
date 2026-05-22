/**
 * Ambient-marker counter — Sprint 3c of the four-surface presence model.
 *
 * Banner-blindness mitigation for in-chat surfaces (Surface 2 preface +
 * Surface 3 footer). After N consecutive zero-content turns, the
 * preface/footer collapses to the single ambient line `unerr · ⋯`. The
 * full lines come back the moment a turn produces real content again.
 *
 * Honest-zero on the dashboard is unaffected — only the in-chat
 * surfaces collapse. The dashboard always shows true counts.
 *
 * Pure in-memory state. Never persisted. Process-local. When the proxy
 * restarts, the counters reset to 0 — the next turn renders full content
 * regardless of how many quiet turns happened before the restart.
 *
 * Phase 1 contract: this module is purely additive. It is not consumed
 * by any existing code; only the new Surface 2/3 renderers (Sprints 3,
 * 4) call into it via `shouldUseAmbientMarker` + `noteTurnContent`.
 *
 * See: docs/open-cli/PERCEPTION_TO_PRESENCE.md §8 (cross-cutting
 * principles, "honest-zero with ambient marker"), §12 Sprint 3c.
 */

/** Threshold: after this many consecutive zero-content turns, collapse
 *  to the ambient marker. The next non-zero turn renders full content
 *  AND resets the counter back to 0. */
const ZERO_TURN_THRESHOLD = 3;

/** Per-session counter. Key: session_id. Value: current consecutive-zero
 *  turn count for that session. Bounded by typical session lifetime
 *  (sessions are minutes-to-hours, well under any memory concern). */
const counters = new Map<string, number>();

/**
 * Note the content state of the turn that just completed for a session.
 *
 *   hadContent = false → increment the consecutive-zero counter.
 *   hadContent = true  → reset the consecutive-zero counter to 0.
 *
 * Callers (turn-footer.ts, context-preface.ts) determine "had content"
 * by inspecting the lines they were about to render. A turn has content
 * when its preface block has at least one supplement OR its footer
 * block has at least one catch OR savings > 0 OR headroom > 0.
 *
 * Idempotent within a turn: callers may invoke this multiple times per
 * turn with the same `hadContent` value safely (the counter only
 * advances when transitioning from a content turn to a no-content turn
 * — see implementation note). Phase 1 keeps it simple: every call moves
 * the state, so callers must invoke exactly once per turn at the end
 * of rendering.
 */
export function noteTurnContent(sessionId: string, hadContent: boolean): void {
  if (hadContent) {
    counters.set(sessionId, 0);
    return;
  }
  const prev = counters.get(sessionId) ?? 0;
  counters.set(sessionId, prev + 1);
}

/**
 * Decide whether the in-chat surfaces should render the ambient marker
 * for this session's *next* turn.
 *
 * Pure inspection — does not mutate the counter. Call this before
 * rendering the preface/footer to decide whether to use the collapsed
 * `unerr · ⋯` form or the full block.
 *
 * Returns true once the consecutive-zero counter reaches the threshold
 * (default: 3). Stays true on subsequent calls until `noteTurnContent`
 * is called with `hadContent = true`, which resets the counter.
 */
export function shouldUseAmbientMarker(sessionId: string): boolean {
  return (counters.get(sessionId) ?? 0) >= ZERO_TURN_THRESHOLD;
}

/**
 * Read the raw consecutive-zero counter for a session. Used by tests
 * and by Sprint 12 telemetry (ambient-marker fallback rate).
 */
export function getConsecutiveZeroCount(sessionId: string): number {
  return counters.get(sessionId) ?? 0;
}

/** Test-only — reset the counter for a session. */
export function resetAmbientMarker(sessionId: string): void {
  counters.delete(sessionId);
}

/** Test-only — reset every counter. */
export function resetAllAmbientMarkers(): void {
  counters.clear();
}

/** Configurable threshold accessor for tests. The production value is
 *  fixed at 3 per the design doc; this getter exists so tests can
 *  assert behavior at the boundary. */
export function getZeroTurnThreshold(): number {
  return ZERO_TURN_THRESHOLD;
}
