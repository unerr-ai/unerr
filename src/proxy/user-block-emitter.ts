/**
 * User-block emitter — the production wire-up for the user-prose
 * channel introduced by `buildUserBlock()` in response-envelope.ts.
 *
 * Called from `proxy.ts` immediately after `buildSignalPrefix()` on
 * every tool response. Returns two pre-rendered strings the caller
 * splices into the final body text:
 *
 *   - `head`: the Surface 2 context preface (plus the resume strip on a
 *     resumed session's first turn), prepended ABOVE the tool body so
 *     the user reads it while the response is still streaming.
 *   - `tail`: end-of-turn placeholder; the Surface 3 receipt itself is
 *     rendered by `unerr_turn_summary` and pasted by the agent, not
 *     spliced here. (§10.7: Surface 4 inline attribution rows were
 *     merged into that receipt.)
 *
 * All renderers are best-effort: any IO error returns the empty string
 * for that part rather than throwing. The response pipeline must never
 * be broken by this layer.
 */

import type { PendingConfirmationRegistry } from "../intelligence/pending-confirmations.js";
import type { BehaviorEventWriter } from "../tracking/behavior-events.js";
import { noteTurnContent, shouldUseAmbientMarker } from "./ambient-marker.js";
import { renderContextPrefaceLive } from "./context-preface.js";
import { USER_BLOCK_AMBIENT, buildUserBlock } from "./response-envelope.js";
import {
  formatSessionResumeBlock,
  generateSessionResumePayload,
} from "./session-persistence.js";
import { noteToolCall } from "./turn-state.js";

export interface UserBlockContext {
  /** Absolute `.unerr/` directory (where metrics.db + facts.db live). */
  unerrDir: string;
  /** Stable session identifier from `shadowLedger.getSessionId()`. */
  sessionId: string;
  /** Per-session tool-call count from `router.sessionContext.getToolCallCount()`. */
  toolCallCount: number;
  /** Repo-relative or absolute path the call touched; null when N/A. */
  filePath: string | null;
  /** Optional pending-confirmation registry. When set, any pending entry
   *  for this session is surfaced as a "please confirm" line in the
   *  preface so the user sees the question instead of the agent silently
   *  carrying an ambiguous note. */
  pendingConfirmations?: PendingConfirmationRegistry;
  /** True when the proxy was resumed from a prior session. The resume
   *  strip is spliced onto userBlock.head on the FIRST call of the
   *  session — once per process. Pulled from `stats.isResumedSession`. */
  isResumedSession?: boolean;
  /** Fix K — optional timeline store handle. When set, the resume strip
   *  pulls top-3 open blockers and top-3 most-recent mark_intent rows
   *  from the prior session. When undefined, the resume block renders
   *  without those lines (graceful degradation). */
  timelineStore?: Parameters<typeof generateSessionResumePayload>[1];
  /** Fix K — optional behavior-event writer. When set and the resume
   *  strip emits ≥1 carried-over blocker, a `resume_blockers_surfaced`
   *  event is recorded for the dashboard compliance ribbon. */
  behaviorEvents?: BehaviorEventWriter;
  /** Override Date.now() — tests only. */
  now?: number;
}

export interface UserBlockEmission {
  /** Block to prepend ABOVE the tool body. Includes trailing blank line. */
  head: string;
  /** Block to splice between page-hint and signal footer. Includes leading newline. */
  tail: string;
}

/**
 * Per-session emit-once guard for the resume strip. Keyed by sessionId
 * so multiple concurrent sessions on the same process never collide;
 * cleared implicitly when the process exits. The strip is large
 * (≤500 chars) and only useful on the very first response of a resumed
 * session — re-emitting it would just dilute later signals.
 */
const RESUME_STRIP_EMITTED = new Set<string>();

/**
 * Build the resume strip for the first response of a resumed session.
 * Returns the empty string when there is no prior session, when this
 * session isn't a resume, or when the strip has already been emitted
 * once for this sessionId.
 */
async function buildResumeStrip(ctx: UserBlockContext): Promise<string> {
  if (!ctx.isResumedSession) return "";
  if (RESUME_STRIP_EMITTED.has(ctx.sessionId)) return "";
  try {
    const payload = await generateSessionResumePayload(
      ctx.unerrDir,
      ctx.timelineStore
    );
    if (!payload) {
      RESUME_STRIP_EMITTED.add(ctx.sessionId);
      return "";
    }
    const block = formatSessionResumeBlock(payload);
    if (block.length > 0) {
      RESUME_STRIP_EMITTED.add(ctx.sessionId);
      // Fix K — record the magic-moment telemetry when ≥1 blocker
      // carried over. Best-effort: never block the response on the write.
      const blockerCount = payload.open_blockers?.length ?? 0;
      if (blockerCount > 0 && ctx.behaviorEvents) {
        try {
          ctx.behaviorEvents.record({
            session_id: ctx.sessionId,
            type: "resume_blockers_surfaced",
            tool: null,
            entity_key: null,
            response_bytes: null,
            // L2 capture-site fix: carry the blocker texts so the Logbook can
            // name them ("Resumed your open blocker: …") instead of rendering
            // the default-phrasing "recorded thing" fall-through. Capped to the
            // top 3 (matching the resume strip) + truncated for the detail bag.
            detail: {
              count: blockerCount,
              blockers: (payload.open_blockers ?? []).slice(0, 3).map((b) => ({
                text: b.text.slice(0, 200),
                file_path: b.file_path,
              })),
              retrieved: (payload.open_blockers ?? []).slice(0, 3).map((b) => ({
                kind: "resume_blocker",
                ...(b.file_path ? { anchor: b.file_path } : {}),
              })),
              returned_count: Math.min(blockerCount, 3),
              used: true,
            },
          });
        } catch {
          /* never break the response on telemetry failure */
        }
      }
    }
    return block;
  } catch {
    return "";
  }
}

/**
 * Detect whether a rendered preface carries real content. The renderer
 * emits exactly `["nothing new to load this turn"]` when there is
 * nothing to report on a non-first turn — that string is the honest-zero
 * marker. Any other line set (including the "starting fresh" first-turn
 * line) counts as content.
 */
function prefaceHasContent(prefaceLines: readonly string[]): boolean {
  if (prefaceLines.length === 0) return false;
  if (
    prefaceLines.length === 1 &&
    prefaceLines[0] === "nothing new to load this turn"
  ) {
    return false;
  }
  return true;
}

/**
 * Build the head + tail blocks for a single tool response.
 *
 * Caller pattern (proxy.ts):
 *
 *     const block = await buildUserBlockForResponse({...});
 *     const finalText = block.head + bodyText + bodyEnd + pageBlock
 *                     + block.tail + signalFooterBlock;
 */
export async function buildUserBlockForResponse(
  ctx: UserBlockContext
): Promise<UserBlockEmission> {
  const { isTurnOpen, isFirstCall } = noteToolCall(ctx.sessionId, ctx.now);

  // Ambient-marker fallback: after ≥ZERO_TURN_THRESHOLD consecutive
  // zero-content turns the in-chat surfaces collapse to a single
  // `unerr » ⋯` line. The decision is read here BEFORE we render so
  // the threshold check sees the prior-turn counter, not this turn's.
  if (shouldUseAmbientMarker(ctx.sessionId)) {
    const marker = `${USER_BLOCK_AMBIENT}\n\n`;
    // Note that this turn produced no real content either — keep the
    // counter advancing so the ambient state is sticky until a content
    // turn breaks it.
    noteTurnContent(ctx.sessionId, false);
    return { head: "", tail: `\n${marker.trimEnd()}` };
  }

  let head = "";
  let headHadContent = false;
  if (isTurnOpen) {
    try {
      const prefaceLines = renderContextPrefaceLive(
        ctx.unerrDir,
        ctx.sessionId,
        ctx.toolCallCount,
        "",
        isFirstCall
      );
      // §10.7 — inline attribution removed; all provenance now consolidated
      // into the end-of-turn Surface 3 receipt rendered by
      // `unerr_turn_summary`.
      const baseHead = buildUserBlock(prefaceLines);
      // Resume strip: prepend ABOVE everything else on the first response
      // of a resumed session. It is its own self-formatted block (already
      // includes `[unerr:session-resume]` prefix and bullets) — keep it
      // outside `buildUserBlock` so its existing structure is preserved.
      const resumeStrip = await buildResumeStrip(ctx);
      const resumeBlock = resumeStrip ? `${resumeStrip}\n\n` : "";
      head = resumeBlock + baseHead;
      headHadContent =
        resumeStrip.length > 0 || prefaceHasContent(prefaceLines);
    } catch {
      head = "";
    }
  }

  // Surface 3 (end-of-turn economy line) no longer auto-attaches to
  // every tool response — that was noisy and burned tokens on every
  // call. Agents now fetch the same data once via `unerr_turn_summary`
  // and include the rendered line verbatim in their closing message.
  const tail = "";

  noteTurnContent(ctx.sessionId, headHadContent);
  return { head, tail };
}
