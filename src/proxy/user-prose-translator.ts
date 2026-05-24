/**
 * Raw-signal → user-prose translator.
 *
 * unerr emits two parallel channels on every tool response:
 *
 *   1. `ur|<tag> …`  — LLM-facing signals (response-envelope.ts).
 *   2. `unerr » …`   — user-facing prose (this module + user-block-emitter).
 *
 * Same information, two channels: the LLM acts on the tag; the user reads
 * the prose. This module codifies the transformation rules so future
 * signals follow one discipline — plain English, no `ur|`, no anchor wire
 * format, no `fan_in` / `entity_key` jargon.
 *
 * The mapping is defined in `docs/identity-impact-redesign.md` §5
 * (cross-cutting rule — "jargon-free, transformed, not raw").
 *
 * Phase 1 contract: pure function, exhaustive switch. Not yet wired into
 * call sites — the master skill (T4.4) will consume it via the bridge.
 * Keep it small, side-effect-free, and synchronous so any caller can use
 * it from any context.
 *
 * See: docs/identity-impact-redesign.md §5 — the full mapping table.
 */

/** Wire-level tags emitted by unerr's response envelope (4-tag legend
 *  shipped 2026-05-24). Mirror of the wire tags named in
 *  `SIGNAL_PREFIX_LEGEND` (src/proxy/response-envelope.ts).
 *
 *  The fine-grained semantic tag (hlt, dft, skl, etc.) — present in the
 *  body context but collapsed for the wire — flows through the
 *  translator via `SignalPayload.subtype`. That keeps the translator's
 *  prose arms semantically rich without putting 14 distinct tags on the
 *  agent-facing wire. */
export type SignalTag = "act" | "ctx" | "rsk" | "fct";

/** Pre-consolidation semantic subtypes the translator still recognises
 *  for richer prose. Each subtype maps to exactly one wire-level
 *  SignalTag via `WIRE_TAG_ALIAS` (response-envelope.ts). */
export type SignalSubtype =
  | "hlt"
  | "skl"
  | "unl"
  | "pg"
  | "rsm"
  | "act"
  | "dft"
  | "ctx"
  | "hth"
  | "rsk"
  | "wrn"
  | "hst"
  | "fct"
  | "hnt";

/**
 * Carrier for tag-specific data the translator needs to interpolate.
 *
 * Every field is optional because emissions vary by tag; the translator
 * uses what's relevant for its tag and ignores the rest. Callers should
 * pass concrete values when known and omit fields they don't have —
 * never pass a placeholder string ("N", "<entity>") through this layer,
 * because the translator never gets a chance to re-resolve them.
 */
export interface SignalPayload {
  /** Pre-consolidation semantic subtype (e.g. "hlt" inside an `act`
   *  bucket, "dft" inside `ctx`). Lets the translator pick the rich
   *  prose template that matches what the emission *actually means*
   *  without re-parsing the body. Optional — if missing the translator
   *  falls back to a generic line for the bucket. */
  subtype?: SignalSubtype;
  /** Free-form trailing message after the tag (e.g. the body of
   *  `ur|fct [convention] <message>`). Used as a fallback when no
   *  structured field applies. */
  message?: string;
  /** Fact subtype for `ur|fct` — derived from the `[bracketed]`
   *  prefix in the wire message. Known subtypes: user_fed (an explicit
   *  user-stated rule), convention (auto-detected style), procedural,
   *  semantic, episodic. */
  factSubtype?: string;
  /** Verbatim quote from the user — only present when factSubtype is
   *  `user_fed`. The translator uses this directly because user words
   *  are the load-bearing thing on user-fed facts. */
  userQuote?: string;
  /** Convention or rule description — present when factSubtype is
   *  `convention` (or any other auto-detected style fact). */
  conventionText?: string;
  /** Entity name involved in the signal (e.g. the function being
   *  halted, the file that drifted). Optional — translator falls back
   *  to "this file" / "this entity" wording when missing. */
  entity?: string;
  /** Free-form reason — used by `hlt` (why we stopped) and `hth`
   *  (why the session is degraded). */
  reason?: string;
}

/**
 * Translate a single raw signal into the user-facing prose line that
 * belongs on the `unerr » …` channel.
 *
 *   - Returns the prose string when the tag is user-relevant.
 *   - Returns `null` when the tag is internal (LLM nudge only) and
 *     should never surface to the user — silent tags include `rsk`
 *     (used to gate skill invocation), `unl` (LLM-internal unlock
 *     announcement), `pg` (pagination cursor), and `hnt` by default
 *     (co-change suggestions are only surfaced when the caller has
 *     decided they're load-bearing to the user's question).
 *
 * The translator NEVER:
 *   - Emits the raw tag (`ur|`).
 *   - Emits internal field names (`fan_in`, `fan_out`, `anchor`,
 *     `entity_key`, `_meta`).
 *   - Emits placeholder syntax (`<entity>`, `:N`).
 *   - Emits hedge verbs (`Consider`, `Verify`, `Review`).
 *
 * If a payload is missing fields the translator falls back to a generic
 * phrasing — never to a placeholder.
 */
export function translateSignalToUserProse(
  tag: SignalTag,
  payload: SignalPayload = {}
): string | null {
  switch (tag) {
    case "act": {
      // act bucket covers hlt / skl / unl / pg / rsm / act. Only hlt is
      // user-relevant — the others are agent-facing imperatives whose
      // *result* is what the user sees (the master skill consolidates
      // any provenance into the end-of-turn Surface 3 receipt).
      if (payload.subtype === "hlt") {
        const where = payload.entity ? ` on ${payload.entity}` : "";
        return `unerr stopped me — looks like a retry loop${where}`;
      }
      return null;
    }

    case "ctx": {
      // ctx bucket covers dft / ctx / hth. Drift and health are
      // user-relevant; context-already-delivered is silent (an
      // efficiency signal, not a user-facing event).
      if (payload.subtype === "dft") {
        return "unerr noticed this file changed since I last touched it";
      }
      if (payload.subtype === "hth") {
        return "unerr suggests starting a new session — this one is getting long";
      }
      return null;
    }

    case "rsk": {
      // rsk bucket covers rsk / wrn / hst. Risk (blast radius) is
      // agent-facing; warnings about anti-patterns and prior-failure
      // history are user-relevant.
      if (payload.subtype === "wrn") {
        if (payload.conventionText) {
          return `unerr flagged a known issue here: ${payload.conventionText}`;
        }
        if (payload.message) {
          return `unerr flagged a known issue here: ${payload.message}`;
        }
        return "unerr flagged a known issue with this approach";
      }
      if (payload.subtype === "hst") {
        const where = payload.entity ? ` on ${payload.entity}` : "";
        return `unerr remembers earlier attempts${where} didn't work — checking those first`;
      }
      return null;
    }

    case "fct": {
      // fct bucket covers fct / hnt and the fact-type passthroughs.
      // User-fed facts and conventions are user-relevant; co-change
      // hints (hnt) are LLM-facing by default — silent unless the
      // caller upstream decided they're load-bearing.
      if (payload.subtype === "hnt") {
        return null;
      }
      const sub = payload.factSubtype ?? "";
      if (sub === "user_fed") {
        const quote = payload.userQuote ?? payload.message ?? "";
        if (quote.length > 0) {
          return `unerr reminded me you'd asked to ${quote}`;
        }
        return "unerr reminded me of a rule you'd asked me to keep";
      }
      if (sub === "convention") {
        const conv = payload.conventionText ?? payload.message ?? "";
        if (conv.length > 0) {
          return `unerr says this file follows ${conv}`;
        }
        return "unerr surfaced a project convention for this file";
      }
      if (payload.message && payload.message.length > 0) {
        return `unerr surfaced from earlier work: ${payload.message}`;
      }
      return "unerr surfaced a fact from earlier work on this codebase";
    }
  }
}

/** Convenience: every tag the translator knows about. Iteration order
 *  matches the legend block in response-envelope.ts so test failures
 *  are easy to map back to the source. Exported for the coverage test
 *  (which asserts every legend tag has a switch arm). */
export const KNOWN_SIGNAL_TAGS: readonly SignalTag[] = [
  "act",
  "ctx",
  "rsk",
  "fct",
] as const;
