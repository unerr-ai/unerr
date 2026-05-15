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
  message: string;
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
  if (content.length > 280) {
    throw new Error(
      `content exceeds 280 character limit (got ${content.length}). Shorten the fact.`
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

  const factId = await factStore.createFact(input);

  const isDeduplicated = factId !== undefined && content.trim() !== "";
  const message = `Recorded: "${content.trim().slice(0, 60)}${content.trim().length > 60 ? "..." : ""}" [${fact_type}] → ${scope}`;

  return {
    fact_id: factId,
    message,
    deduplicated: false,
  };
}
