/**
 * MCP handler for `unerr_turn_summary` — the close-out tool.
 *
 * Agents call this ONCE at the end of every coding turn. Returns the
 * session-cumulative economy line (savings + headroom) plus a structured
 * breakdown. The agent is contracted to include the `line` field
 * verbatim in its closing summary so the user sees what unerr did across
 * the whole conversation.
 *
 * This replaces the per-response footer that previously rode every MCP
 * tool reply — that was noisy and burned tokens on every call. The new
 * model is agent-pull, fires once, surfaces the cumulative number.
 */

import { dirname } from "node:path";
import { readNamedEvents } from "../tracking/named-events.js";
import {
  type RuntimeJoinCounts,
  computeRuntimeJoins,
} from "../tracking/runtime-joins.js";
import { updateNudgeState } from "./nudge-state.js";
import {
  type ReceiptAttribution,
  extractReceiptAttribution,
} from "./receipt-attribution.js";
import { renderReceiptBlock } from "./receipt-renderer.js";
import { renderSessionEconomyLineLive } from "./turn-footer.js";

export interface TurnSummaryResult {
  ok: true;
  /** The user-facing prose line — hybrid form `this turn: +… · session: …`.
   *  Include verbatim in the closing summary. */
  line: string;
  /** Total NamedEvents (compressions + behaviors) across the session. */
  total_events: number;
  /** Sum of tokens_saved across the session. */
  total_tokens_saved: number;
  /** Compounded turn-headroom — extra turns of room unerr bought. */
  headroom_compounded: number;
  /** Canonical turn index the per-turn slice was computed for. */
  current_turn: number;
  /** NamedEvents emitted DURING `current_turn` only. */
  turn_events: number;
  /** Tokens saved DURING `current_turn` only. */
  turn_tokens_saved: number;
  /** Where unerr helped THIS SESSION — event-type breakdown ordered by count desc.
   *  Token savings are one slice of value; this surfaces the wider picture
   *  (graph lookups served, drift caught, notes recalled, conventions applied,
   *  caller checks enforced …). Clients render their own framing. */
  highlights: Array<{ event_type: string; count: number; phrasing: string }>;
  /** Where unerr helped THIS TURN — same shape as `highlights` but
   *  filtered to `current_turn`. Empty when no events fired this turn. */
  turn_highlights: Array<{
    event_type: string;
    count: number;
    phrasing: string;
  }>;
  /** Fix L — cross-tier runtime joins for `current_turn`. When any
   *  count is non-zero, `line` is prefixed with the `⚡ unerr runtime:
   *  …` segment (the positioning artefact named in §12 — the first
   *  line no point tool can produce). Backwards-compatible: when all
   *  counts are zero, `line` is byte-identical to the legacy output. */
  runtime_joins: RuntimeJoinCounts;
  /** §10.7 — Surface 4 → Surface 3 merge. Per-turn provenance payload
   *  the receipt formatter (Task #133) consumes to render the
   *  attribution rows (`↳ applied your rule "…"`). Empty arrays when
   *  nothing fired this turn — receipt falls through to the legacy
   *  single-line `nothing to help with …` form. */
  attribution: ReceiptAttribution;
}

export interface TurnSummaryError {
  ok: false;
  error: string;
}

/**
 * Run the close-out summary. Returns the MCP tool-response envelope —
 * a JSON-stringified `TurnSummaryResult | TurnSummaryError` in the
 * `content[0].text` slot.
 */
export async function handleTurnSummaryProxy(
  unerrDir: string,
  sessionId: string,
  currentTurn: number
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  try {
    // Tier-2 accumulator: record compliance. The prompt-hook accumulator
    // compares this count against `turn_summary_required_count` to decide
    // whether to escalate. Done on success only — a failed call should not
    // count as compliance. Best-effort: nudge state is non-critical.
    try {
      const cwd = dirname(unerrDir);
      updateNudgeState(cwd, (s) => {
        s.turn_summary_emitted_count += 1;
        s.consecutive_receipt_misses = 0;
      });
    } catch {
      /* best effort — receipt itself still proceeds */
    }
    const data = renderSessionEconomyLineLive(unerrDir, sessionId, currentTurn);

    // Fix L — compute cross-tier joins from the same event stream and
    // splice the `⚡ unerr runtime: …` segment ahead of the existing
    // session economy line. Elided when all counts are zero so the
    // legacy paste contract is preserved byte-for-byte on join-free
    // turns.
    let runtimeJoins: RuntimeJoinCounts = {
      memory_to_graph: 0,
      graph_to_drift: 0,
      three_way: 0,
      entities: [],
    };
    let attribution: ReceiptAttribution = {
      recalls: [],
      captures: [],
      drift: [],
    };
    let blockLines: string[] = data.line ? [data.line] : [];
    try {
      const events = readNamedEvents(unerrDir, { session_id: sessionId });
      runtimeJoins = computeRuntimeJoins(events, sessionId, currentTurn);
      attribution = extractReceiptAttribution(events, currentTurn);
      blockLines = renderReceiptBlock({
        attribution,
        runtimeJoins,
        turnTokensSaved: data.turn_tokens_saved,
        sessionTokensSaved: data.total_tokens_saved,
        fallbackLine: data.line,
      });
    } catch {
      /* best effort — receipt falls through to legacy single-liner */
    }

    const result: TurnSummaryResult = {
      ok: true,
      line: blockLines.join("\n"),
      total_events: data.total_events,
      total_tokens_saved: data.total_tokens_saved,
      headroom_compounded: data.headroom_compounded,
      current_turn: data.current_turn,
      turn_events: data.turn_events,
      turn_tokens_saved: data.turn_tokens_saved,
      highlights: data.highlights,
      turn_highlights: data.turn_highlights,
      runtime_joins: runtimeJoins,
      attribution,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[unerr] unerr_turn_summary failed: ${msg}\n`);
    const result: TurnSummaryError = { ok: false, error: msg };
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: true,
    };
  }
}
