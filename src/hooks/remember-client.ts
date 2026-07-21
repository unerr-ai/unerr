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
  // Anchored, explicit directives only. Each requires a remember-intent marker,
  // not just an imperative verb.
  const DIRECTIVE =
    /(^|\b)(remember(?:\s+(?:that|this|to))?|from now on|going forward|from here on(?:\s+out)?|as a (?:hard\s+)?rule|make sure to (?:always|never)|please always|please never|always make sure|never (?:ever )?)\b/i;
  if (!DIRECTIVE.test(trimmed)) return null;
  return trimmed;
}
