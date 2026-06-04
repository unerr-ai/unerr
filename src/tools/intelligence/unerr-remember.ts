/**
 * unerr_remember write engine — user-fed fact persistence (Phase 2 Sprint 5a).
 *
 * NOT a catalog tool since 2026-06: the model is never taught to call it.
 * Its callers are the two hook clients, which dispatch it BY NAME over UDS
 * `tools/call` — `remember-client.ts` (UserPromptSubmit auto-capture of
 * "remember this" / "from now on" / "always" directives) and
 * `sentinel-persist.ts` (Stop-hook `unerr-save:` scrape, note path).
 *
 * Distinct from `record_fact` (agent-detected conventions): this engine
 * captures facts the *user* explicitly asserts, persisted with
 * `source: "user_fed"`.
 *
 * Confidence floor: captures below 0.5 confidence are rejected (the agent
 * should re-ask the user or skip). Captures between 0.5 and <0.7 are stored
 * but flagged with `ambiguity_flag: true` so the next surface (Sprint 6) can
 * prompt the user for confirmation.
 *
 * Storage shape (additive, no schema change): the user's verbatim quote and
 * the optional `applies_to` paths ride along inside the first EvidenceEntry
 * blob via `recordUserFedFact()`.
 */

import type { PendingConfirmationRegistry } from "../../intelligence/pending-confirmations.js";
import type {
  FactType,
  TemporalFactStore,
} from "../../intelligence/temporal-facts.js";
import type { BehaviorEventWriter } from "../../tracking/behavior-events.js";

/** Below this floor, the capture is abandoned and nothing is written. */
export const REMEMBER_CONFIDENCE_FLOOR = 0.5;
/** Below this threshold (but ≥ floor), the capture is flagged as ambiguous. */
export const REMEMBER_AMBIGUITY_THRESHOLD = 0.7;

export interface UnerrRememberArgs {
  /** Normalised statement the agent extracted from the user (≤ 1400 chars; keep terse). */
  content: string;
  /** Verbatim user quote that drove this capture (used for provenance). */
  source_quote: string;
  /** Scope: file path, entity key, or the literal string `project`. */
  scope: string;
  /** Subject: entity key, file, or topic name. */
  subject: string;
  /** Fact category. */
  fact_type: FactType;
  /** Agent's confidence in the capture, in [0, 1]. */
  confidence: number;
  /** Optional paths/entities this fact governs (for retrieval-time matching). */
  applies_to?: string[];
}

export type UnerrRememberResult =
  | {
      stored: true;
      fact_id: string;
      deduplicated: boolean;
      ambiguity_flag: boolean;
      confidence: number;
    }
  | {
      stored: false;
      reason: "confidence_too_low";
      confidence: number;
      message: string;
    };

function clampConfidence(c: number): number {
  if (Number.isNaN(c)) return 0;
  if (c < 0) return 0;
  if (c > 1) return 1;
  return c;
}

/**
 * Derive a compact subject/topic from the fact content when the caller didn't
 * pass one explicitly. Takes the first clause (up to the first sentence break)
 * and caps it at 60 chars — enough to anchor retrieval without forcing the
 * agent through a "subject is required" round-trip. Never throws; worst case it
 * returns the trimmed content prefix.
 */
function deriveSubjectFromContent(content: string): string {
  const trimmed = content.trim();
  const firstClause = (trimmed.split(/[.!?\n]/, 1)[0] ?? "").trim();
  const basis = firstClause.length > 0 ? firstClause : trimmed;
  return basis.length > 60 ? `${basis.slice(0, 57).trimEnd()}…` : basis;
}

/**
 * Execute the unerr_remember tool. Returns either a stored receipt with
 * `ambiguity_flag` (Sprint 6 input) or an abandoned-capture record that
 * emits a `fact_capture_abandoned` behaviour event.
 */
export async function executeUnerrRemember(
  args: UnerrRememberArgs,
  factStore: TemporalFactStore,
  sessionId: string,
  turn: number,
  behaviorEvents?: BehaviorEventWriter,
  pendingConfirmations?: PendingConfirmationRegistry
): Promise<UnerrRememberResult> {
  const content = typeof args.content === "string" ? args.content : "";
  const confidence = clampConfidence(args.confidence);
  const applies_to = args.applies_to;

  // `content` is the ONLY hard requirement — it is the fact itself, and there is
  // nothing to store without it. Every other field is DEFAULTED rather than
  // rejected: each validation error we throw forces the calling agent through
  // another reasoning round-trip (read error → infer the missing arg → re-call),
  // which costs more tokens than just inferring a sensible value here. So we
  // store on the first call and only reject a genuinely empty/oversized fact or
  // an EXPLICIT invalid fact_type.
  if (!content || content.trim().length === 0) {
    throw new Error("content is required and cannot be empty");
  }
  if (content.length > 1400) {
    throw new Error(
      `content is ${content.length} chars, exceeds 1400-char cap. Shorten to ≤1400 (1-3 sentences).`
    );
  }

  // fact_type → default "semantic" (the broadest durable-knowledge bucket).
  // Only an EXPLICIT invalid value is rejected; omission is not an error.
  const VALID_FACT_TYPES: FactType[] = [
    "procedural",
    "semantic",
    "negative",
    "convention",
  ];
  const explicitFactType =
    typeof args.fact_type === "string" ? args.fact_type.trim() : "";
  if (
    explicitFactType &&
    !VALID_FACT_TYPES.includes(explicitFactType as FactType)
  ) {
    throw new Error(
      `fact_type must be one of: procedural, semantic, negative, convention (got "${args.fact_type}")`
    );
  }
  const fact_type: FactType = (explicitFactType || "semantic") as FactType;

  // scope → default "project" (the safest, broadest anchor).
  const scope =
    typeof args.scope === "string" && args.scope.trim().length > 0
      ? args.scope.trim()
      : "project";

  // subject → derive a compact topic from the content's first clause.
  const subject =
    typeof args.subject === "string" && args.subject.trim().length > 0
      ? args.subject.trim()
      : deriveSubjectFromContent(content);

  // source_quote → default to the content itself when no verbatim user quote
  // was passed (provenance degrades gracefully; never a hard error).
  const source_quote =
    typeof args.source_quote === "string" && args.source_quote.trim().length > 0
      ? args.source_quote.trim()
      : content.trim();

  if (confidence < REMEMBER_CONFIDENCE_FLOOR) {
    behaviorEvents?.record({
      session_id: sessionId,
      turn,
      type: "fact_capture_abandoned",
      tool: "unerr_remember",
      entity_key: subject.trim(),
      response_bytes: null,
      detail: {
        confidence,
        fact_type,
        scope: scope.trim(),
        reason: "confidence_too_low",
      },
    });
    return {
      stored: false,
      reason: "confidence_too_low",
      confidence,
      message: `Capture abandoned: confidence ${confidence.toFixed(2)} < floor ${REMEMBER_CONFIDENCE_FLOOR}. Re-ask the user or skip.`,
    };
  }

  const trimmedAppliesTo = (applies_to ?? [])
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const { fact_id, deduplicated } = await factStore.recordUserFedFact({
    content: content.trim(),
    fact_type,
    scope: scope.trim(),
    subject: subject.trim(),
    source_quote: source_quote.trim(),
    applies_to: trimmedAppliesTo.length > 0 ? trimmedAppliesTo : undefined,
    base_confidence: confidence,
  });

  const ambiguity_flag = confidence < REMEMBER_AMBIGUITY_THRESHOLD;
  const trimmedContent = content.trim();
  // No echo of the stored content on the wire — the agent already has `content`
  // in its own call args, so echoing it back is pure token waste. `ambiguity_flag`
  // is the only action signal the agent needs (true → confirm the capture).

  if (ambiguity_flag && pendingConfirmations) {
    pendingConfirmations.register({
      fact_id,
      session_id: sessionId,
      subject: subject.trim(),
      scope: scope.trim(),
      content: trimmedContent,
      confidence,
      turn,
    });
  } else if (!ambiguity_flag && pendingConfirmations) {
    pendingConfirmations.resolve(fact_id);
  }

  behaviorEvents?.record({
    session_id: sessionId,
    turn,
    type: "fact_stored_user_fed",
    tool: "unerr_remember",
    entity_key: subject.trim(),
    response_bytes: null,
    detail: {
      fact_id,
      fact_type,
      scope: scope.trim(),
      confidence,
      deduplicated,
      ambiguity_flag,
      content: content.trim(),
      source_quote: source_quote.trim(),
    },
  });

  return {
    stored: true,
    fact_id,
    deduplicated,
    ambiguity_flag,
    confidence,
  };
}
