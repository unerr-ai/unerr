/**
 * Sprint P2-2: Intent-mask soft-refuse builder.
 *
 * When an agent calls a tool belonging to a masked family, this module
 * builds the structured refusal message. Different from the tier-based
 * `soft-refuse.ts` — this tells the agent WHY the family is masked
 * (current intent looks like X) and HOW to override (unmask command).
 *
 * Text rules (per CLAUDE.md "Writing nudges and hints"):
 *   - Imperative verb + named tool.
 *   - No deictic pronouns.
 *   - No hedge verbs.
 *   - Numbers, not placeholders.
 */

export interface IntentMaskRefuseResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly _gate: {
    readonly status: "intent_masked";
    readonly tool: string;
    readonly family: string;
    readonly dominant_intent: string;
    readonly override_command: string;
  };
}

export interface IntentMaskRefuseInput {
  readonly toolName: string;
  readonly maskedFamily: string;
  readonly dominantFamilies: readonly string[];
  readonly dominantReasons: readonly string[];
}

/**
 * Build the refusal response for an intent-masked tool call.
 * Pure, synchronous, no side effects.
 */
export function buildIntentMaskRefuse(
  input: IntentMaskRefuseInput
): IntentMaskRefuseResult {
  const { toolName, maskedFamily, dominantFamilies, dominantReasons } = input;

  const dominantLabel =
    dominantFamilies.length > 0 ? dominantFamilies.join(", ") : "unknown";

  const reasonStr =
    dominantReasons.length > 0
      ? dominantReasons[0]!
      : "no strong signal for this family";

  const overrideCmd = `unerr router unmask ${maskedFamily}`;

  const text = `ur|fct ${toolName} hidden — current intent: ${dominantLabel} work (${reasonStr}). Run \`${overrideCmd}\` to override.\n\n_error: intent_masked\n_family: ${maskedFamily}\n_dominant_intent: ${dominantLabel}\n_override: ${overrideCmd}`;

  return {
    content: [{ type: "text", text }],
    _gate: {
      status: "intent_masked",
      tool: toolName,
      family: maskedFamily,
      dominant_intent: dominantLabel,
      override_command: overrideCmd,
    },
  };
}
