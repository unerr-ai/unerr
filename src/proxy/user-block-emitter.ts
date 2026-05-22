/**
 * Surface 2/3/4 emitter — the production wire-up for the user-prose
 * channel introduced by `buildUserBlock()` in response-envelope.ts.
 *
 * Called from `proxy.ts` immediately after `buildSignalPrefix()` on
 * every tool response. Returns two pre-rendered strings the caller
 * splices into the final body text:
 *
 *   - `head`: preface + steering line (Surface 2 + Surface 4d steering),
 *     prepended ABOVE the tool body so the user reads it while the
 *     response is still streaming.
 *   - `tail`: end-of-turn footer (Surface 3), spliced AFTER the page
 *     hint but BEFORE the trailing `ur|<tag>` signal footer so the
 *     agent-signal block stays the last thing on the wire.
 *
 * All renderers are best-effort: any IO error returns the empty string
 * for that part rather than throwing. The response pipeline must never
 * be broken by this layer.
 */

import { isAbsolute } from "node:path";

import type { PendingConfirmationRegistry } from "../intelligence/pending-confirmations.js";
import type { TemporalFactStore } from "../intelligence/temporal-facts.js";
import { noteTurnContent, shouldUseAmbientMarker } from "./ambient-marker.js";
import { renderContextPrefaceLive } from "./context-preface.js";
import {
  type EnforcementCandidate,
  appliesToFor,
  factsApplyingTo,
} from "./enforcement-loop.js";
import { USER_BLOCK_AMBIENT, buildUserBlock } from "./response-envelope.js";
import { renderTurnFooterLive } from "./turn-footer.js";
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
  /** Optional fact-store for Surface 4d steering. Skipped when undefined. */
  factStore?: TemporalFactStore;
  /** Optional pending-confirmation registry. When set, any pending entry
   *  for this session is surfaced as a "please confirm" line in the
   *  preface so the user sees the question instead of the agent silently
   *  carrying an ambiguous note. */
  pendingConfirmations?: PendingConfirmationRegistry;
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
 * Lift a TemporalFact list into the EnforcementCandidate shape the
 * `factsApplyingTo` filter wants. The `applies_to` array on each
 * candidate is the union of `applies_to` targets across all evidence
 * entries on the fact, computed by `appliesToFor()`.
 */
function liftCandidates(
  facts: ReadonlyArray<Record<string, unknown> & { fact_id: string }>
): EnforcementCandidate[] {
  const out: EnforcementCandidate[] = [];
  for (const f of facts) {
    const evidence = Array.isArray(f.evidence) ? f.evidence : [];
    // TemporalFact's evidence field is structurally the EvidenceEntry list
    // appliesToFor expects; the cast is safe at the runtime contract.
    const targets = appliesToFor(
      evidence as Parameters<typeof appliesToFor>[0]
    );
    if (targets.length === 0) continue;
    out.push({
      fact: f as unknown as EnforcementCandidate["fact"],
      applies_to: targets,
    });
  }
  return out;
}

/**
 * Format one TemporalFact as the user-prose `steering` line that gets
 * appended to the Surface 2 preface. Plain text — no `ur|<tag>` prefix
 * (the agent-facing `ur|fct` line is a separate Surface 4d emission
 * that rides `buildSignalPrefix()` and is not produced here).
 */
function steeringTextFor(fact: {
  fact_type?: string;
  content: string;
}): string {
  const verb = fact.fact_type === "negative" ? "avoid" : "follow";
  return `${verb}: ${fact.content}`;
}

async function computeSteering(ctx: UserBlockContext): Promise<string> {
  if (!ctx.factStore || !ctx.filePath) return "";
  // Use only repo-relative paths for fact lookup — absolute paths blow
  // past the scope-hierarchy that recallForFile / appliesToFor expect.
  const relPath = isAbsolute(ctx.filePath)
    ? ctx.filePath.replace(/^.*?\.unerr\/?/, "")
    : ctx.filePath;
  try {
    const facts = await ctx.factStore.recallForFile(relPath, []);
    if (facts.length === 0) return "";
    const candidates = liftCandidates(
      facts as unknown as ReadonlyArray<
        Record<string, unknown> & { fact_id: string }
      >
    );
    if (candidates.length === 0) return "";
    const hits = factsApplyingTo(relPath, candidates);
    const top = hits[0];
    if (!top) return "";
    // Cap one fact per preface — §9.4d "over-surfacing" risk mitigation.
    return steeringTextFor(top);
  } catch {
    return "";
  }
}

/**
 * Render zero-or-more "please confirm" lines for unanswered captures.
 * Each pending entry becomes one prose line so the user can pattern-match
 * the verbatim preview against their original statement and reply
 * yes/no. Returns the empty array when there is no registry or no
 * pending entry for this session — the preface block is unaffected.
 */
function renderPendingConfirmations(ctx: UserBlockContext): string[] {
  if (!ctx.pendingConfirmations) return [];
  let entries: ReturnType<typeof ctx.pendingConfirmations.list>;
  try {
    entries = ctx.pendingConfirmations.list(ctx.sessionId);
  } catch {
    return [];
  }
  if (entries.length === 0) return [];
  // Cap at 2 per turn — three or more pending captures are vanishingly
  // rare and would push the preface past its token budget.
  const capped = entries.slice(0, 2);
  return capped.map(
    (e) =>
      `please confirm — should I remember: "${e.content_preview}"? (yes/no)`
  );
}

/**
 * Detect whether a rendered footer line carries real content or is the
 * honest-zero placeholder. The footer renderer emits an exact triple
 * of honest-zero substrings when nothing happened this turn — match on
 * that contract so the ambient-marker counter advances correctly.
 *
 * Kept here (rather than exported from turn-footer.ts) because it's a
 * detail of the emitter's contract with the renderer, not a renderer
 * property other callers need.
 */
function footerHasContent(footerLine: string): boolean {
  if (footerLine.length === 0) return false;
  return !(
    footerLine.includes("nothing to help with this turn") &&
    footerLine.includes("no token savings this turn") &&
    footerLine.includes("session length unchanged")
  );
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
  // `unerr · ⋯` line. The decision is read here BEFORE we render so
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
      const steering = await computeSteering(ctx);
      const prefaceLines = renderContextPrefaceLive(
        ctx.unerrDir,
        ctx.sessionId,
        ctx.toolCallCount,
        steering,
        isFirstCall
      );
      const pendingLines = renderPendingConfirmations(ctx);
      // Pending-confirmation prompt comes FIRST so the user sees the
      // question above any "loaded for this turn" line — answering it
      // unblocks the captured note.
      const allLines = [...pendingLines, ...prefaceLines];
      head = buildUserBlock(allLines);
      headHadContent =
        pendingLines.length > 0 || prefaceHasContent(prefaceLines);
    } catch {
      head = "";
    }
  }

  let tail = "";
  let tailHadContent = false;
  try {
    const footerLine = renderTurnFooterLive(
      ctx.unerrDir,
      ctx.sessionId,
      ctx.toolCallCount
    );
    if (footerLine.length > 0) {
      const block = buildUserBlock([footerLine]);
      // The tail is inserted mid-response — prepend a newline so it
      // doesn't collide with the page-hint block that runs before it.
      tail = block.length > 0 ? `\n${block.trimEnd()}` : "";
      tailHadContent = footerHasContent(footerLine);
    }
  } catch {
    tail = "";
  }

  noteTurnContent(ctx.sessionId, headHadContent || tailHadContent);
  return { head, tail };
}
