/**
 * Per-session turn-open detector for the user-prose channel.
 *
 * The MCP protocol has no native "user turn" boundary — a single user
 * message can spawn N tool calls before the agent stops. We approximate
 * a turn boundary as either (a) the first tool call we've ever seen for
 * a session, or (b) the first tool call after a quiescence gap of
 * `TURN_OPEN_GAP_MS` or more. That's the moment we render Surface 2's
 * preface; every other call falls inside the same turn and only renders
 * Surface 3's footer.
 *
 * Ambient-marker tracking (consecutive-zero collapse to `unerr · ⋯`)
 * lives in `ambient-marker.ts` and is composed with this module by the
 * `user-block-emitter.ts` caller — keep the two concerns separate so
 * each can be tested in isolation.
 *
 * State lives in a module-scoped Map keyed by sessionId. Safe for the
 * proxy's single-threaded JSON-RPC event loop; not designed for
 * multi-process sharing.
 */

/**
 * Quiescence window after which the next tool call is treated as a new
 * turn. IDE round-trip latency (LLM stream + MCP transit) commonly runs
 * 5–10 s between back-to-back tool calls, so anything below ~10 s
 * mis-classifies normal in-turn calls as turn-opens and re-renders the
 * preface every response. 15 s is comfortably above typical RTT and still
 * tight enough to mark a real user-driven pause.
 */
const TURN_OPEN_GAP_MS = 15_000;

interface SessionTurnState {
  /** Last tool-call timestamp (epoch ms). */
  lastCallTs: number;
}

const SESSIONS = new Map<string, SessionTurnState>();

export interface ToolCallNote {
  /** True on the first call of the session OR first call after a gap
   *  ≥ TURN_OPEN_GAP_MS — caller renders the start-of-turn preface. */
  isTurnOpen: boolean;
  /** True only on the very first tool call ever seen for this session.
   *  Used to drive the "starting fresh" preface branch which is
   *  decoupled from the (potentially already-incremented) tool-call
   *  index passed as turnIndex into the renderer. */
  isFirstCall: boolean;
}

/**
 * Note a tool call. Returns whether this call opens a new turn and
 * whether it is the first call ever in this session.
 *
 * `now` defaults to `Date.now()` and is parameterised for tests.
 */
export function noteToolCall(
  sessionId: string,
  now: number = Date.now()
): ToolCallNote {
  const existing = SESSIONS.get(sessionId);
  if (!existing) {
    SESSIONS.set(sessionId, { lastCallTs: now });
    return { isTurnOpen: true, isFirstCall: true };
  }
  const isTurnOpen = now - existing.lastCallTs >= TURN_OPEN_GAP_MS;
  existing.lastCallTs = now;
  return { isTurnOpen, isFirstCall: false };
}

/** Test-only: wipe all session state. */
export function resetTurnStateForTests(): void {
  SESSIONS.clear();
}

export function getTurnOpenGapMs(): number {
  return TURN_OPEN_GAP_MS;
}
