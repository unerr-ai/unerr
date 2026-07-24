/**
 * User-rule directive detector (Phase-2 Sprint 7, T7.8; Phase 3 active-memory
 * strip).
 *
 * A user-stated rule ("remember…", "from now on…", "always…", "never…") is a
 * durable instruction. Rather than capturing it into a separate memory store
 * over UDS, the UserPromptSubmit hook (prompt-hooks.ts) uses `detectUserRule`
 * to detect the directive and injects a nudge telling the agent to write the
 * rule verbatim into the repo's own instruction file (CLAUDE.md / AGENTS.md)
 * — the only durable home an agent reads on every future turn. This module
 * only classifies the prompt; it performs no I/O and never throws.
 */

/**
 * Explicit memory-directive detector. Intentionally TIGHT: it matches only the
 * unambiguous "store this as a durable rule" phrasings, NOT every imperative.
 * Bare "don't break the tests" / "always run the suite" inside a coding request
 * must NOT trip a capture — only a clear directive-to-remember does. Returns the
 * verbatim prompt (the quote we persist) when a directive fires, else `null`.
 */
export function detectUserRule(prompt: string): string | null {
  const trimmed = prompt.trim();
  if (trimmed.length < 8) return null;
  // A question is asking, not stating a durable rule; a "let's"/"lets" opener
  // is a collaborative suggestion (e.g. "lets go through each instruction"),
  // not a directive-to-remember — both are cheap, high-value excludes before
  // the directive regex runs at all.
  if (trimmed.endsWith("?")) return null;
  if (/^(let'?s)\b/i.test(trimmed)) return null;
  // Anchored, explicit directives only. Each requires a remember-intent marker,
  // not just an imperative verb. The "remember" branch excludes "I remember"
  // (a first-person recollection, not a request) via negative lookbehind.
  const DIRECTIVE =
    /\b(?<!i\s)(?<!i'm\s)(?<!i'll\s)(?<!i've\s)(?<!i'd\s)remember(?:\s+(?:that|this|to))?\b|\bfrom now on\b|\bgoing forward\b|\bfrom here on(?:\s+out)?\b|\bas a (?:hard\s+)?rule\b|\brule:|\bmake sure to (?:always|never)\b|\bplease (?:always|never)\b|\balways make sure\b|\bnever(?:\s+ever)?\b/i;
  if (!DIRECTIVE.test(trimmed)) return null;
  return trimmed;
}
