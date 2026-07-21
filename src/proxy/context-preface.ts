/**
 * Context Preface — Surface 2 of the four-surface presence model.
 *
 * Renders a 1–3 line user-prose preface at the *start* of every turn,
 * summarizing what context was loaded into the agent's working memory
 * for this turn:
 *
 *   - facts loaded  (temporal-facts auto-injected this session)
 *   - supplements   (drift overlays, outlines, recalls)
 *   - steering      (active `ur|<tag>` translated to user prose)
 *
 * Lives in `content[].text` of the first tool response of a turn, via
 * the `buildUserBlock()` channel from Sprint 3a. The agent is instructed
 * (FORBIDDEN row in `instruction-writer.ts`) to not echo or act on
 * these lines — they are telemetry for the human, not signals for the
 * model.
 *
 * Phase 1 contract — additive only. This module:
 *   - reads named events via the Sprint 1 projection (`readNamedEvents`);
 *   - reads nothing else (no temporal-facts write, no drift-tracker
 *     write, no signal-queue mutation);
 *   - never modifies any existing row, writer, or reader.
 *
 * Anatomy of the preface (1–3 lines, ≤80 tokens):
 *
 *   unerr » context: <N> facts loaded
 *           <M> supplements (<summary>)
 *           steering: <one-line ur|tag translation>
 *
 * Honest-zero rendering:
 *   - No facts loaded AND no supplements AND no steering →
 *     `nothing new to load this turn` (single line).
 *
 * Cross-client rendering: plain text only — no ANSI codes, no markdown
 * blockquotes, no emoji.
 *
 * See: .internal/PERCEPTION_TO_PRESENCE.md §9.2 (preface),
 * §12 Sprint 4.
 */

import { estimateTokenCount } from "../intelligence/token-estimator.js";
import {
  type NamedEvent,
  countNamedEventsByType,
  getPhrasing,
  readNamedEvents,
} from "../tracking/named-events.js";
import { topFileFromEvents } from "./turn-footer.js";

/** Inputs the preface renderer needs. Pure data; no IO inside `render*`. */
export interface ContextPrefaceInputs {
  /** Index of the current turn (0-based). Used to filter named-events
   *  whose `turn` field matches; ALSO used (legacy) as the fresh-session
   *  signal when `isFreshSession` is not supplied. In production the
   *  emitter passes the real tool-call index here and sets
   *  `isFreshSession` independently — see `renderContextPrefaceLive`. */
  turnIndex: number;
  /** NamedEvents emitted in *this* turn so far (start-of-turn preamble). */
  events: NamedEvent[];
  /** Optional one-line user-prose translation of the active `ur|<tag>`
   *  signal for this turn. Empty string means no steering line. The
   *  caller composes this from the signal-scorer pipeline; Phase 1
   *  callers pass `""`. */
  steering?: string;
  /** True when this is the very first tool call in the session. The
   *  emitter derives this from `turn-state.noteToolCall().isFirstCall`
   *  so the fresh-session branch fires regardless of the (already
   *  incremented) `turnIndex` value used for event filtering. When
   *  unset, the renderer falls back to `turnIndex === 0` for
   *  backward-compat with direct callers (tests). */
  isFreshSession?: boolean;
  /** Top file touched this turn (highest NamedEvent count by file_path).
   *  When present, the preface names it explicitly — `primed <file>` —
   *  rather than the generic count. Computed by `topFileFromEvents`. */
  topFile?: string | null;
  /** "Now" in ms epoch — reserved for future relative-time rendering.
   *  Defaults to `Date.now()` when omitted. */
  nowMs?: number;
}

/** Token budget for the entire preface block (BPE estimate, char/4). */
const PREFACE_MAX_TOKENS = 80;

/** Real BPE token count via the central estimator (heuristic fallback >50k chars). */
function approxTokens(s: string): number {
  return estimateTokenCount(s);
}

/**
 * Named-event types that count as "facts loaded into context this turn"
 * for preface purposes. Includes recall hits and stored facts that were
 * applied during preamble.
 */
const FACT_LOADED_TYPES: ReadonlySet<string> = new Set([
  "fact_recalled",
  "convention_applied",
  "cross_session_resume",
]);

/**
 * Named-event types that count as "supplements" — extra context unerr
 * injected (drift overlay, outline, cascade warning) on top of the raw
 * file content the agent asked for.
 */
const SUPPLEMENT_TYPES: ReadonlySet<string> = new Set([
  "full_read_avoided",
  "cascade_warning_consumed",
  "stale_edit_prevented",
  "caller_check_enforced",
  "cache_hit",
]);

/**
 * Summarize a slice of NamedEvents (already filtered to one bucket —
 * facts or supplements) into a comma-separated phrase. Empty events →
 * empty string.
 *
 *   [fact_recalled, fact_recalled] → "2 facts recalled"
 *   [full_read_avoided, cascade_warning_consumed]
 *     → "1 file read, 1 cascade warning"
 */
export function summarizePrefaceEvents(events: NamedEvent[]): string {
  if (events.length === 0) return "";
  const counts = countNamedEventsByType(events);
  const parts: string[] = [];
  for (const [eventType, count] of Object.entries(counts).sort(
    (a, b) => b[1] - a[1]
  )) {
    const { object, plural } = getPhrasing(eventType);
    parts.push(`${count} ${count === 1 ? object : plural}`);
  }
  return parts.join(", ");
}

/**
 * Render the preface lines from precomputed inputs. Pure function — no
 * IO. The data-fetch wrapper below (`renderContextPrefaceLive`) is the
 * one Sprint 4 actually wires into `buildUserBlock()` at the start of a
 * turn.
 *
 * Returns an array of lines suitable for `buildUserBlock(lines)`:
 *   - The first line is prefixed automatically by `buildUserBlock` with
 *     `unerr » `; this function returns the bare lines (no prefix).
 *   - Continuation lines are indented under the prefix by
 *     `buildUserBlock`; this function returns them un-indented.
 *
 * Honest-zero: when there is nothing to say, returns a single line
 * `"nothing new to load this turn"` so the caller renders
 * `unerr » nothing new to load this turn`.
 */
export function renderContextPreface(inputs: ContextPrefaceInputs): string[] {
  const { turnIndex, events, steering = "", isFreshSession, topFile } = inputs;

  const factEvents = events.filter((e) => FACT_LOADED_TYPES.has(e.event_type));
  const supplementEvents = events.filter((e) =>
    SUPPLEMENT_TYPES.has(e.event_type)
  );

  const factsSummary = summarizePrefaceEvents(factEvents);
  const supplementsSummary = summarizePrefaceEvents(supplementEvents);
  const steeringTrimmed = steering.trim();

  // Explicit `isFreshSession=true` wins; otherwise fall back to the
  // legacy `turnIndex === 0` heuristic so direct test callers that don't
  // pass the flag continue to render the fresh-session line.
  const freshSession =
    isFreshSession === true ||
    (isFreshSession === undefined && turnIndex === 0);

  const lines: string[] = [];

  // Named-noun lead — the identifiable-victim lever: name the actual file
  // primed this turn rather than a generic count.
  const hasNamedFile =
    typeof topFile === "string" &&
    typeof topFile === "string" &&
    topFile.length > 0;

  if (hasNamedFile) {
    lines.push(`primed ${topFile}`);
  } else if (freshSession || factsSummary.length > 0) {
    lines.push(
      factsSummary.length > 0
        ? `loaded for this turn: ${factsSummary}`
        : "starting fresh — nothing loaded yet"
    );
  }

  if (supplementsSummary.length > 0) {
    lines.push(`also added: ${supplementsSummary}`);
  }
  if (steeringTrimmed.length > 0) {
    lines.push(`reminder: ${steeringTrimmed}`);
  }

  if (lines.length === 0) {
    return ["nothing new to load this turn"];
  }

  // Token-budget guard: if the assembled block blows past 80 tokens,
  // drop from the tail (steering first, then supplements). The first
  // line — facts loaded — is the most informative.
  while (
    lines.length > 1 &&
    approxTokens(lines.join(" ")) > PREFACE_MAX_TOKENS
  ) {
    lines.pop();
  }

  return lines;
}

/**
 * Read the data needed for this turn's preface and render it. Returns
 * the array of lines ready for `buildUserBlock(lines)`. On any IO error
 * returns the honest-zero single-line fallback so the response pipeline
 * is never broken.
 */
export function renderContextPrefaceLive(
  unerrDir: string,
  sessionId: string,
  turnIndex: number,
  steering = "",
  isFreshSession = false
): string[] {
  try {
    const allEvents = readNamedEvents(unerrDir, { session_id: sessionId });
    const turnEvents = allEvents.filter((e) => e.turn === turnIndex);
    const topFile = topFileFromEvents(turnEvents);

    return renderContextPreface({
      turnIndex,
      events: turnEvents,
      steering,
      isFreshSession,
      topFile,
    });
  } catch {
    return ["nothing new to load this turn"];
  }
}
