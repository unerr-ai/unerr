/**
 * Injection policy (Issue 6) — the ONE place that owns the cross-cutting
 * decisions every prompt-injection turn shares: the per-turn line cap, the
 * per-line char cap, the stable-head vs volatile-tail split, and the final
 * ordering with the boundary marker. Before this module those four rules were
 * inline in `promptSubmitHandler`; centralising them means a new injection or a
 * smarter ordering rule changes one function, not the hook body.
 *
 * Scope is deliberately narrow (CLAUDE.md §6 — no speculative complexity): the
 * grounded measurement is that per-turn injections are tail-appended =
 * cache-safe (note n-6f8pi16nna), so this is maintainability + one-place-to-
 * route work, not a savings lever. It owns assembly only — each hook still
 * parses its own tool input, runs its own graph query, and renders its own
 * line. The code-context gate (`isCodeContext`) and the session-keyed
 * one-shot state (`nudge-state.ts`) stay where they are; this module documents
 * them as the shared inputs callers feed in.
 *
 */

/** Marker that separates the cacheable stable head from the per-turn tail. */
export const PREFIX_VOLATILE_BOUNDARY = "— unerr: per-turn context —";

/**
 * Max `ur|act` lines injected per turn. Lines beyond the cap are dropped to
 * keep the model from being drowned in stacked nudges.
 */
export const MAX_ACT_LINES_PER_TURN = 5;

/**
 * Per-line char cap. Most agents drop or paraphrase oversize nudge payloads, so
 * the cap forces concision at write time (truncated with a `…` suffix) and the
 * directive reaches the model intact.
 */
export const MAX_NUDGE_LINE_CHARS = 800;

/**
 * One candidate injection line. `volatile` drives the prefix ordering: a line
 * whose text varies per prompt (e.g. the verb-specific Path A skill nudge) is
 * volatile and rides the per-turn tail; a fixed nudge template (byte-stable
 * turn-to-turn) is non-volatile and belongs in the cacheable head.
 */
export interface ActCandidate {
  readonly text: string | null;
  readonly volatile: boolean;
}

/** The assembled per-turn injection, split so the caller can record the head's
 *  prefix stability and decide whether anything is left to emit. */
export interface AssembledInjection {
  /** Cacheable leading bytes: fixed act templates + static roster/catalog. */
  readonly stableHead: string;
  /** Per-turn tail: resume/stitch, the verb-specific act lines. */
  readonly volatileTail: string;
  /** Final block, ordered head → boundary → tail. Empty when nothing to emit. */
  readonly ordered: string;
}

/** Cap a list to MAX_ACT_LINES_PER_TURN non-empty lines, truncating each to
 *  MAX_NUDGE_LINE_CHARS, and split into stable vs volatile text. */
function capAndSplit(candidates: ReadonlyArray<ActCandidate>): {
  stableActText: string;
  volatileActText: string;
} {
  const kept = candidates
    .filter(
      (c): c is { text: string; volatile: boolean } =>
        typeof c.text === "string" && c.text.length > 0
    )
    .slice(0, MAX_ACT_LINES_PER_TURN)
    .map((c) => ({
      text:
        c.text.length > MAX_NUDGE_LINE_CHARS
          ? `${c.text.slice(0, MAX_NUDGE_LINE_CHARS - 1)}…`
          : c.text,
      volatile: c.volatile,
    }));
  const stableActText = kept
    .filter((e) => !e.volatile)
    .map((e) => e.text)
    .join("\n");
  const volatileActText = kept
    .filter((e) => e.volatile)
    .map((e) => e.text)
    .join("\n");
  return { stableActText, volatileActText };
}

/**
 * Assemble the per-turn injection block. Applies the line cap + char cap, splits
 * act candidates into stable vs volatile lanes, folds the once-per-session
 * static tail (roster/catalog) into the stable head, joins the volatile
 * prefixes (stitch, topic-shift) ahead of the volatile act text, and orders the
 * whole thing head → boundary → tail so the cacheable leading bytes stay
 * byte-stable turn-to-turn. Pure: no I/O, no state writes — the caller records
 * prefix stability on `stableHead` and emits `ordered`.
 *
 * @param actCandidates  the per-turn `ur|act` lines, in priority order
 * @param staticTail     once-per-session roster/catalog (or "" when spent/skipped)
 * @param volatilePrefixes  per-turn volatile lines that precede the act tail
 *                          (e.g. cross-session stitch), in order
 */
export function assembleInjectionBlock(
  actCandidates: ReadonlyArray<ActCandidate>,
  staticTail: string,
  volatilePrefixes: ReadonlyArray<string>
): AssembledInjection {
  const { stableActText, volatileActText } = capAndSplit(actCandidates);
  const stableHead = [stableActText, staticTail]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
  const volatileTail = [...volatilePrefixes, volatileActText]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n");
  const ordered =
    volatileTail.length > 0
      ? stableHead.length > 0
        ? `${stableHead}\n\n${PREFIX_VOLATILE_BOUNDARY}\n${volatileTail}`
        : volatileTail
      : stableHead;
  return { stableHead, volatileTail, ordered };
}
