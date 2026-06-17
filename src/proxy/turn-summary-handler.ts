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
import type { RuntimeJoinCounts } from "../tracking/runtime-joins.js";
import { updateNudgeState } from "./nudge-state.js";
import type { ReceiptAttribution } from "./receipt-attribution.js";
import { renderTurnReportLines } from "./turn-report.js";

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
 * Compute the close-out economy line for a session/turn — the multi-line
 * receipt block the agent pastes verbatim (MCP path) OR the Stop hook surfaces
 * as a user-facing systemMessage (hook path). Pure read of the on-disk event
 * stream; safe to call from a hook subprocess. Best-effort throughout: any
 * sub-failure degrades to the legacy single-line economy form, never throws.
 *
 * Shared by {@link handleTurnSummaryProxy} (MCP tool) and the Stop hook
 * (src/hooks/stop-hooks.ts) so both surfaces emit byte-identical text.
 */
export function computeTurnSummaryLine(
  unerrDir: string,
  sessionId: string,
  currentTurn: number
): string {
  // Single shared path — same renderer the Stop hook uses, so the MCP paste
  // and the hook systemMessage are byte-identical. `renderTurnReportLines`
  // gathers the event stream once, slices the turn, computes runtime joins +
  // attribution, decides the recap fold-in, and renders via
  // `renderReceiptBlock`. Best-effort throughout (never throws).
  return renderTurnReportLines(unerrDir, sessionId, currentTurn).join("\n");
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
    const line = computeTurnSummaryLine(unerrDir, sessionId, currentTurn);

    // Wire payload: the agent only ever pastes `line` (the close-out
    // contract). The full economy breakdown — events, savings, headroom,
    // highlights, runtime joins, attribution — is telemetry the dashboard
    // reads off disk (token_flow_events / behavior_events) via its own HTTP
    // routes; it must NOT ride the agent-facing wire. Same discipline as the
    // 2026-05-10 "Vanity Strip" on `_meta`. `line` already bakes in the
    // runtime-join prefix + receipt block, so nothing actionable is lost.
    // `TurnSummaryResult` (above) stays the internal/telemetry shape;
    // `runtimeJoins` + `attribution` are still consumed by renderReceiptBlock.
    const wire = { ok: true as const, line };
    return {
      content: [{ type: "text", text: JSON.stringify(wire) }],
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
