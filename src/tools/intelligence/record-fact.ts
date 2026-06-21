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

import { hashEntityKey } from "../../cloud/drainers/envelope.js";
import { canSyncRecall } from "../../cloud/entitlements.js";
import { emit } from "../../events/enqueue.js";
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

  // L1 — mirror the durable fact write into the unified per-repo event store so
  // `unerrd` drains it to the cloud. HR-2: never put the raw scope (a path /
  // entity key) in `detail` — hash it to a 16-hex `anchor`. The full note prose
  // (`fact_text`) is a paid recall feature, so it ships ONLY when canSyncRecall;
  // the create/reinforce signal itself is unconditional. emit() is a fire-and-
  // forget no-op when no process context is configured, so it never throws.
  const anchor = hashEntityKey(input.scope);
  // Map the project fact_type onto the note model the cloud facts table uses: a
  // 'convention' fact is a convention note (kind "cnv"); everything else is a
  // plain fact (kind "fct"). Polarity: a 'negative' fact is a "don't" (-), all
  // others neutral (~). Only a create carries kind/polarity; reinforce just bumps.
  const factKind = input.fact_type === "convention" ? "cnv" : "fct";
  const factPolarity = input.fact_type === "negative" ? "-" : "~";
  emit({
    type: "fact",
    detail: {
      op: deduplicated ? "reinforce" : "create",
      client_fact_id: fact_id,
      ...(anchor ? { anchor } : {}),
      ...(deduplicated ? {} : { kind: factKind, polarity: factPolarity }),
      ...(canSyncRecall() ? { fact_text: input.content } : {}),
    },
    ...(sessionId ? { session_id: sessionId } : {}),
  });

  // No echo of the stored content on the wire — the agent already holds
  // `content` in its call args; echoing it back is pure token waste.
  return {
    fact_id,
    deduplicated,
  };
}
