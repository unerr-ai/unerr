/**
 * Single source of the end-of-turn report — gathers the session event stream
 * once and renders it through `renderReceiptBlock`, the one shared renderer
 * behind BOTH close-out surfaces:
 *
 *   - the `unerr_turn_summary` MCP tool (`computeTurnSummaryLine`) — every
 *     agent pastes the returned lines verbatim;
 *   - the Stop hook (`renderStopReportLive`) — Claude Code surfaces them as a
 *     user-facing `systemMessage`.
 *
 * Both call `gatherReceiptInputs` → `renderReceiptBlock`, so the report is
 * byte-identical regardless of which agent is driving. There is no
 * agent-specific renderer and no second copy of the framing.
 *
 * Trigger model — turn-based, no session-end dependency. The Stop hook fires
 * per TURN and there is no reliable user-visible session-end signal across
 * agents, so the session recap is folded into the per-turn line periodically:
 * on every `RECAP_EVERY_N_TURNS`-th turn, or on a quiet turn (nothing notable
 * happened, so there is room to surface the wider session story).
 */

import { openMetricsStore } from "../tracking/metrics-store.js";
import {
  type NamedEvent,
  currentTurnSlice,
  eventBucket,
  readNamedEvents,
} from "../tracking/named-events.js";
import { computeRuntimeJoins } from "../tracking/runtime-joins.js";
import { extractReceiptAttribution } from "./receipt-attribution.js";
import {
  type ReceiptBlockInputs,
  renderReceiptBlock,
} from "./receipt-renderer.js";
import { renderSessionEconomyLineLive } from "./turn-footer.js";

/** Fold the session recap into the per-turn line every Nth turn. A constant to
 *  tune after dogfooding — every 3 turns keeps the recap present without
 *  repeating it on every line. */
export const RECAP_EVERY_N_TURNS = 3;

/** A recap turn folds in the session recap: either the cadence fired
 *  (`currentTurn` is a multiple of `RECAP_EVERY_N_TURNS`) or the turn was quiet
 *  (no token savings and no bucketed activity), leaving room for the wider
 *  story. Turn 0 (pre-first-prompt) is never a recap turn. */
export function isRecapTurn(currentTurn: number, quietTurn: boolean): boolean {
  if (quietTurn) return true;
  return currentTurn > 0 && currentTurn % RECAP_EVERY_N_TURNS === 0;
}

/** Distinct files the session's saved notes (`fact_stored_*`) landed in —
 *  drives the "(across N files)" anchor on the Remembered recap row. Counts
 *  only events that carry a concrete `file_path`; a project/workspace-anchored
 *  note (no file) is not double-counted as a file. */
function rememberedFileCount(events: readonly NamedEvent[]): number {
  const files = new Set<string>();
  for (const e of events) {
    if (!e.event_type.startsWith("fact_stored")) continue;
    if (e.file_path) files.add(e.file_path);
  }
  return files.size;
}

/**
 * Gather the inputs for one end-of-turn report from the on-disk event stream.
 * Pure read; best-effort throughout (the underlying readers swallow their own
 * IO errors and return honest-zero shapes), so this never throws.
 *
 * `opts.singleLine` selects the one-line fallback for surfaces without a
 * multi-line channel — the caller resolves it from an agent-registry
 * capability, never from an agent name.
 *
 * `opts.nativeSessionId` — when set, named events are fetched by native id
 * instead of session id. This correlates proxy-written edit events (one
 * session_id) with hook-written prompt-boundary events (a different
 * session_id) that share the same native_session_id, so
 * `latestPromptBoundaryTs` finds the boundary and every edit after it is
 * included in the receipt. Falls back to session_id when null/undefined
 * (legacy exec/CLI sessions that pre-date native id stamping).
 */
export function gatherReceiptInputs(
  unerrDir: string,
  sessionId: string,
  currentTurn: number,
  opts: { singleLine?: boolean; nativeSessionId?: string | null } = {}
): ReceiptBlockInputs {
  const data = renderSessionEconomyLineLive(unerrDir, sessionId, currentTurn);

  let turnEvents: ReturnType<typeof currentTurnSlice> = [];
  let runtimeJoins = computeRuntimeJoins([], sessionId, currentTurn);
  let attribution = extractReceiptAttribution([], currentTurn);
  let storedFiles = 0;
  try {
    // Prefer native_session_id correlation so proxy-written edits and
    // hook-written prompt-boundary events (different session_id spaces but
    // same native_session_id) are gathered into one stream. Falls back to
    // session_id for legacy rows without a native id.
    const namedFilter = opts.nativeSessionId
      ? { native_session_id: opts.nativeSessionId }
      : { session_id: sessionId };
    const events = readNamedEvents(unerrDir, namedFilter);
    runtimeJoins = computeRuntimeJoins(events, sessionId, currentTurn);
    attribution = extractReceiptAttribution(events, currentTurn);
    turnEvents = currentTurnSlice(events, currentTurn);
    storedFiles = rememberedFileCount(events);
  } catch {
    /* best effort — receipt falls through to the legacy single-liner */
  }

  // Quiet turn = nothing notable happened this turn: no token savings AND no
  // bucketed (Prevented/Remembered/Saved) event. Drives the recap fold-in.
  const turnHasContent =
    data.turn_tokens_saved > 0 ||
    data.turn_modeled_saved > 0 ||
    data.turn_highlights.some((h) => eventBucket(h.event_type) !== null);
  const recapTurn = isRecapTurn(currentTurn, !turnHasContent);

  // The whole session has unerr value to report iff it saved tokens, banked
  // headroom, or fired at least one bucketed event. When it has none, the
  // fallback line is suppressed (""), so the report renders to nothing and the
  // Stop hook emits no `systemMessage` — same honest-zero discipline the old
  // `formatStopReport` enforced.
  const sessionHasValue =
    data.total_tokens_saved > 0 ||
    data.total_modeled_saved > 0 ||
    data.headroom_compounded > 0 ||
    data.highlights.some((h) => eventBucket(h.event_type) !== null);

  // Lifetime (cross-session, per-repo) anchors — only computed/surfaced on a
  // recap turn (the recap block is the only consumer). Best-effort: a metrics
  // read failure leaves `lifetime` undefined, so the All-time line is simply
  // omitted (honest-zero) rather than the whole receipt failing.
  let lifetime: ReceiptBlockInputs["lifetime"];
  if (recapTurn) {
    try {
      const store = openMetricsStore(unerrDir);
      lifetime = {
        prevented: store.hardPreventionTotal(),
        tokensSaved: store.tokenFlowTotal() + store.reversibleSavedTotal(),
        modeledSaved: store.modeledSavedTotal(),
      };
    } catch {
      /* best effort — omit the All-time line on a metrics read failure */
    }
  }

  return {
    attribution,
    runtimeJoins,
    turnTokensSaved: data.turn_tokens_saved,
    turnModeledSaved: data.turn_modeled_saved,
    sessionTokensSaved: data.total_tokens_saved,
    sessionModeledSaved: data.total_modeled_saved,
    sessionHeadroom: data.headroom_compounded,
    turnEvents,
    fallbackLine: sessionHasValue ? data.line : "",
    recapTurn,
    sessionHighlights: data.highlights,
    rememberedFileCount: storedFiles,
    lifetime,
    singleLine: opts.singleLine,
  };
}

/**
 * Render the end-of-turn report lines — the single shared path. Both the MCP
 * tool and the Stop hook call this so their output is byte-identical.
 */
export function renderTurnReportLines(
  unerrDir: string,
  sessionId: string,
  currentTurn: number,
  opts: { singleLine?: boolean; nativeSessionId?: string | null } = {}
): string[] {
  return renderReceiptBlock(
    gatherReceiptInputs(unerrDir, sessionId, currentTurn, opts)
  );
}

/**
 * Live-render the end-of-turn report for the Stop-hook surface. Best-effort:
 * returns "" on any failure (the caller then emits no `systemMessage`).
 * Byte-identical to the `unerr_turn_summary` MCP paste — both go through
 * `renderTurnReportLines`.
 */
export function renderStopReportLive(
  unerrDir: string,
  sessionId: string,
  currentTurn: number,
  opts: { singleLine?: boolean; nativeSessionId?: string | null } = {}
): string {
  try {
    return renderTurnReportLines(unerrDir, sessionId, currentTurn, opts).join(
      "\n"
    );
  } catch {
    return "";
  }
}
