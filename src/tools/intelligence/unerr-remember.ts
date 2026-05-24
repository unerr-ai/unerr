/**
 * unerr_remember MCP Tool — User-fed fact persistence (Phase 2 Sprint 5a).
 *
 * Distinct from `record_fact` (agent-detected conventions): this tool captures
 * facts the *user* explicitly asserts via phrases like "remember this",
 * "from now on", "always", or direct assertion of a project rule. The host
 * agent recognises the user-intent and calls `unerr_remember` so the fact is
 * persisted with `source: "user_fed"`.
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
  /** Normalised statement the agent extracted from the user (≤ 280 chars). */
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
      echo_summary: string;
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
  const { content, source_quote, scope, subject, fact_type, applies_to } = args;
  const confidence = clampConfidence(args.confidence);

  if (!content || content.trim().length === 0) {
    throw new Error("content is required and cannot be empty");
  }
  if (content.length > 280) {
    throw new Error(
      `content exceeds 280 character limit (got ${content.length}). Shorten the fact.`
    );
  }
  if (!source_quote || source_quote.trim().length === 0) {
    throw new Error(
      "source_quote is required — pass the verbatim user statement that triggered this capture"
    );
  }
  if (
    !["procedural", "semantic", "negative", "convention"].includes(fact_type)
  ) {
    throw new Error(
      `fact_type must be one of: procedural, semantic, negative, convention (got "${fact_type}")`
    );
  }
  if (!scope || scope.trim().length === 0) {
    throw new Error("scope is required (file path, entity key, or 'project')");
  }
  if (!subject || subject.trim().length === 0) {
    throw new Error("subject is required (entity key, file, or topic name)");
  }

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
  const previewContent = `${trimmedContent.slice(0, 60)}${trimmedContent.length > 60 ? "..." : ""}`;
  const scopeText =
    scope.trim() === "project" ? "the whole project" : `\`${scope.trim()}\``;
  // Plain-English echo so any agent that relays this string to the user
  // reads naturally — no `[brackets]`, no `conf 0.85`, no `→`.
  const verb = deduplicated
    ? "reinforced an existing note"
    : "added a new note";
  const tail = ambiguity_flag
    ? ` — I'm only ${Math.round(confidence * 100)}% sure I got that right, please confirm or correct`
    : "";
  const echo_summary = `unerr ${verb} for ${scopeText}: "${previewContent}"${tail}`;

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
    echo_summary,
  };
}
