/**
 * MCP handler for `unerr_surface2_line` — the Surface 2 line renderer.
 *
 * Fix B (surface-reliability): the hook used to inject a ~1200-char
 * directive describing how to render Surface 2 prose. That directive
 * mostly got truncated, paraphrased, or dropped — agent compliance ran
 * ~30%. The hybrid model collapses the hook to a single imperative
 * (`call unerr_surface2_line({}) FIRST, paste verbatim`) and moves the
 * rendering into this server-side tool. Three reinforcement properties
 * stack: hook trigger + tool attention (every MCP call is a heavy
 * commitment) + echo-only output (no prose to mis-paraphrase).
 *
 * Returns:
 *   - `{ line }` — the bare Surface 2 line, no `unerr »` prefix (caller
 *     adds the prefix when echoing).
 *   - `{ line: "", suppressed_reason: "no_recall" }` — agent has not
 *     called `unerr_recall_notes` this turn yet.
 *   - `{ line: "", suppressed_reason: "nothing_loaded" }` — recall ran
 *     but produced no surfaceable note + no primed file.
 */

import type { BehaviorEventWriter } from "../tracking/behavior-events.js";
import { readNamedEvents } from "../tracking/named-events.js";
import {
  type LoadedNoteFields,
  isValidAnchorType,
  isValidKind,
  isValidPolarity,
  renderLoadedNoteLine,
} from "./loaded-note-line.js";
import { updateNudgeState } from "./nudge-state.js";
import { topFileFromEvents } from "./turn-footer.js";

export interface Surface2LineResult {
  ok: true;
  /** The bare Surface 2 line (no `unerr »` prefix). May be empty when
   *  `suppressed_reason` is set. */
  line: string;
  /** Non-empty when the tool intentionally returned no line. */
  suppressed_reason?: "no_recall" | "nothing_loaded";
  /** Echo-only hint — caller MUST paste `line` verbatim into its first
   *  user-facing response prefixed with `unerr » `. */
  echo_only: true;
}

export interface Surface2LineError {
  ok: false;
  error: string;
}

/** Walk this turn's NamedEvents for the latest `fact_recalled` and
 *  reconstruct the `LoadedNoteFields` shape the renderer expects. */
function extractTopNoteFromEvents(
  events: ReturnType<typeof readNamedEvents>
): { topNote: LoadedNoteFields | null; topFile: string | null } {
  const topFile = topFileFromEvents(events);
  let topNote: LoadedNoteFields | null = null;

  for (const ev of events) {
    if (ev.event_type !== "fact_recalled") continue;
    const content = ev.metadata?.top_content;
    if (typeof content !== "string" || content.length === 0) continue;
    const kind = ev.metadata?.top_kind;
    const anchorType = ev.metadata?.top_anchor_type;
    const anchorValue = ev.metadata?.top_anchor_value;
    const polarity = ev.metadata?.top_polarity;
    if (
      !isValidKind(kind) ||
      !isValidAnchorType(anchorType) ||
      typeof anchorValue !== "string" ||
      !isValidPolarity(polarity)
    ) {
      continue;
    }
    const createdAt = ev.metadata?.top_created_at;
    topNote = {
      kind,
      anchor_type: anchorType,
      anchor_value: anchorValue,
      polarity,
      content,
      created_at: typeof createdAt === "number" ? createdAt : 0,
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
    break;
  }

  return { topNote, topFile };
}

/**
 * Run the Surface 2 renderer for the current session/turn. Best-effort —
 * any read failure returns `nothing_loaded` so the agent's first
 * response degrades to silence (the legitimate empty state) instead of
 * showing an error.
 */
export async function handleSurface2LineProxy(
  unerrDir: string,
  sessionId: string,
  currentTurn: number,
  cwdForState: string,
  behaviorEvents?: BehaviorEventWriter | null
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  try {
    try {
      updateNudgeState(cwdForState, (s) => {
        s.surface2_called_count += 1;
        s.consecutive_surface2_misses = 0;
      });
    } catch {
      /* best effort — emission still proceeds */
    }
    if (behaviorEvents) {
      try {
        behaviorEvents.record({
          session_id: sessionId,
          turn: currentTurn,
          type: "surface2_emitted",
          tool: "unerr_surface2_line",
          entity_key: null,
          response_bytes: null,
        });
      } catch {
        /* best effort — telemetry only */
      }
    }

    const allEvents = readNamedEvents(unerrDir, { session_id: sessionId });
    const turnEvents = allEvents.filter((e) => e.turn === currentTurn);

    const hasRecall = turnEvents.some(
      (e) => e.event_type === "fact_recalled"
    );
    if (!hasRecall) {
      const result: Surface2LineResult = {
        ok: true,
        line: "",
        suppressed_reason: "no_recall",
        echo_only: true,
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    const { topNote, topFile } = extractTopNoteFromEvents(turnEvents);
    const line = renderLoadedNoteLine({
      note: topNote,
      topFile,
      nowMs: Date.now(),
    });

    if (line === null || line.length === 0) {
      const result: Surface2LineResult = {
        ok: true,
        line: "",
        suppressed_reason: "nothing_loaded",
        echo_only: true,
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    const result: Surface2LineResult = {
      ok: true,
      line,
      echo_only: true,
    };
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[unerr] unerr_surface2_line failed: ${msg}\n`);
    const result: Surface2LineError = { ok: false, error: msg };
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: true,
    };
  }
}
