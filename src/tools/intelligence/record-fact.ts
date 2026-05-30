/**
 * record_fact MCP Tool — Agent-as-LLM fact persistence.
 *
 * Layer 9: The host coding agent (Claude, GPT, etc.) calls this tool when
 * the user states a convention, decision, or anti-pattern. The agent IS
 * the LLM — no separate extraction model needed.
 *
 * This is the ONLY write operation --mcp performs on facts.db.
 * It's a single atomic insert — no lock contention risk.
 */

import type {
  CreateFactInput,
  TemporalFactStore,
} from "../../intelligence/temporal-facts.js";

export interface RecordFactArgs {
  content: string;
  fact_type: "procedural" | "semantic" | "negative" | "convention";
  scope: string;
  subject: string;
}

export interface RecordFactResult {
  fact_id: string;
  deduplicated: boolean;
}

/**
 * Execute the record_fact tool.
 * Validates input, deduplicates, and persists to facts.db.
 */
export async function executeRecordFact(
  args: RecordFactArgs,
  factStore: TemporalFactStore,
  sessionId: string
): Promise<RecordFactResult> {
  const { content, fact_type, scope, subject } = args;

  if (!content || content.trim().length === 0) {
    throw new Error("content is required and cannot be empty");
  }
  if (content.length > 1400) {
    throw new Error(
      `content is ${content.length} chars, exceeds 1400-char cap. Shorten to ≤1400 (1-3 sentences).`
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

  const input: CreateFactInput = {
    fact_type,
    scope: scope.trim(),
    subject: subject.trim(),
    content: content.trim(),
    source: "agent_explicit",
    base_confidence: 0.95,
  };

  const { fact_id, deduplicated } = await factStore.createFact(input);

  // No echo of the stored content on the wire — the agent already holds
  // `content` in its call args; echoing it back is pure token waste.
  return {
    fact_id,
    deduplicated,
  };
}
