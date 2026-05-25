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
 * See: docs/open-cli/PERCEPTION_TO_PRESENCE.md §9.2 (preface),
 * §12 Sprint 4.
 */

import { consumePendingTopicShift } from "../intelligence/topic-shift.js";
import {
  type NamedEvent,
  countNamedEventsByType,
  getPhrasing,
  readNamedEvents,
} from "../tracking/named-events.js";
import {
  type LoadedNoteFields,
  isValidAnchorType,
  isValidKind,
  isValidPolarity,
  renderLoadedNoteLine,
} from "./loaded-note-line.js";
import { formatRelativeAge, topFileFromEvents } from "./turn-footer.js";

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
  /** Optional topic-shift signal for this turn. When `flag` is true the
   *  preface renders a "topic shift — prior context may be stale" line
   *  so the agent reads it before drafting. Populated by the live
   *  wrapper draining `consumePendingTopicShift(sessionId)`. */
  topicShift?: { flag: boolean; overlap: number };
  /** Top file touched this turn (highest NamedEvent count by file_path).
   *  When present, the preface names it explicitly — `primed <file>` —
   *  rather than the generic count. Computed by `topFileFromEvents`. */
  topFile?: string | null;
  /** Verbatim content of the most-recently-recalled note for this
   *  session. When present, the lead line names it in quotes —
   *  `loaded: "<content>" (you set <age>)`. This is the identifiable-
   *  victim lever: one named rule > N anonymous counts.
   *
   *  Legacy: callers that only have content + created_at pass these two;
   *  newer callers that have the full `StoredNote` pass `topNote` instead,
   *  which unlocks the rich `loaded a <kind> you wrote <when> for <anchor>`
   *  shape. When both are present, `topNote` wins. */
  topNoteContent?: string | null;
  /** `created_at` (ms epoch) of the recalled note, used to render the
   *  "(you set <age>)" suffix that proves cross-session continuity. */
  topNoteCreatedAt?: number | null;
  /** Full field set for the top recalled note. Drives the rich Surface 2
   *  line via `renderLoadedNoteLine` — kind label, anchor "for" clause,
   *  polarity badge, reinforcement badge, conflict marker, cold-start
   *  guided-empty-state. */
  topNote?: LoadedNoteFields | null;
  /** "Now" in ms epoch for relative-age formatting. Defaults to
   *  `Date.now()` when omitted; tests pass a fixed value. */
  nowMs?: number;
}

/** Token budget for the entire preface block (BPE estimate, char/4). */
const PREFACE_MAX_TOKENS = 80;

/** char/4 cheap token estimator — matches `token-estimator.ts` heuristic. */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
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
  const {
    turnIndex,
    events,
    steering = "",
    isFreshSession,
    topicShift,
    topFile,
    topNoteContent,
    topNoteCreatedAt,
    nowMs,
  } = inputs;

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

  if (topicShift?.flag) {
    // Topic-shift line rides FIRST because it tells the agent the recent
    // context is stale before they read the "loaded for this turn" hint.
    const pct = Math.round(topicShift.overlap * 100);
    lines.push(
      `topic shift — prior context may be stale (overlap ${pct}%); call unerr_recall_notes for fresh anchors`
    );
  }

  // Named-noun lead — the identifiable-victim lever. The rich path uses
  // `renderLoadedNoteLine` when callers pass the full `topNote` field set
  // (kind/anchor/polarity/reinforcement). When only the legacy
  // content+created_at pair is available, fall back to the prior format.
  // Either path: naming nothing > naming generics.
  const hasNamedFile =
    typeof topFile === "string" &&
    typeof topFile === "string" &&
    topFile.length > 0;
  const hasRichNote = inputs.topNote != null;
  const hasLegacyNote =
    typeof topNoteContent === "string" && topNoteContent.length > 0;

  if (hasRichNote || hasLegacyNote || hasNamedFile) {
    if (hasRichNote) {
      // Rich path: shared renderer covers all kinds, anchors, polarity,
      // reinforcement, anchor-missing, conflict, cold-start, AND folds in
      // `topFile` as the `· also primed …` tail when relevant.
      const rich = renderLoadedNoteLine({
        note: inputs.topNote ?? null,
        topFile: hasNamedFile ? topFile : null,
        nowMs,
      });
      if (rich) lines.push(rich);
    } else {
      // Legacy path: content + created_at only. Kept so callers that haven't
      // been updated to pass `topNote` still produce a useful line.
      const segments: string[] = [];
      if (hasLegacyNote) {
        let agePart = "";
        if (typeof topNoteCreatedAt === "number" && topNoteCreatedAt > 0) {
          agePart = ` (you set ${formatRelativeAge(topNoteCreatedAt, nowMs ?? Date.now())})`;
        }
        segments.push(`loaded: "${topNoteContent}"${agePart}`);
      }
      if (hasNamedFile) {
        segments.push(`primed ${topFile}`);
      }
      if (segments.length > 0) lines.push(segments.join(" · "));
    }
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
    const pendingShift = consumePendingTopicShift(sessionId);
    const topicShift = pendingShift
      ? { flag: pendingShift.flag, overlap: pendingShift.overlap }
      : undefined;

    const topFile = topFileFromEvents(turnEvents);

    // Identifiable-victim lever: name the verbatim recalled rule. The
    // first `fact_recalled` event of this turn carries the top fact's
    // content + created_at AND (when the emitter is the active-cognition
    // notes path) the richer kind/anchor/polarity/reinforcement fields
    // in its metadata — so we don't need a second store round-trip.
    let topNoteContent: string | null = null;
    let topNoteCreatedAt: number | null = null;
    let topNote: LoadedNoteFields | null = null;
    for (const ev of turnEvents) {
      if (ev.event_type !== "fact_recalled") continue;
      const content = ev.metadata?.top_content;
      const createdAt = ev.metadata?.top_created_at;
      if (typeof content === "string" && content.length > 0) {
        topNoteContent = content;
        topNoteCreatedAt =
          typeof createdAt === "number" && createdAt > 0 ? createdAt : null;
        // Rich-path fields — present only when the active-cognition notes
        // path emitted the event. Legacy temporal-facts callers omit them
        // and the renderer falls back to the content+created_at form.
        const kind = ev.metadata?.top_kind;
        const anchorType = ev.metadata?.top_anchor_type;
        const anchorValue = ev.metadata?.top_anchor_value;
        const polarity = ev.metadata?.top_polarity;
        if (
          isValidKind(kind) &&
          isValidAnchorType(anchorType) &&
          typeof anchorValue === "string" &&
          isValidPolarity(polarity)
        ) {
          topNote = {
            kind,
            anchor_type: anchorType,
            anchor_value: anchorValue,
            polarity,
            content,
            created_at: topNoteCreatedAt ?? 0,
            reinforcement_count:
              typeof ev.metadata?.top_reinforcement_count === "number"
                ? ev.metadata.top_reinforcement_count
                : 0,
            anchor_missing: ev.metadata?.top_anchor_missing === true,
            conflict_group_id:
              typeof ev.metadata?.top_conflict_group_id === "string"
                ? ev.metadata.top_conflict_group_id
                : "",
          };
        }
        break;
      }
    }

    return renderContextPreface({
      turnIndex,
      events: turnEvents,
      steering,
      isFreshSession,
      topicShift,
      topFile,
      topNoteContent,
      topNoteCreatedAt,
      topNote,
    });
  } catch {
    return ["nothing new to load this turn"];
  }
}
