/**
 * Tier-2 host synthesis (.internal/reviewer-architecture.md §3, §5.1, §9.3, P4).
 *
 * Tier-1 findings are graph facts rendered as `ur|<tag>` verdicts (format.ts).
 * Tier-2 findings (`needsModel: true`) are NOT verdicts — they are *evidence
 * blocks* the host model elaborates on (fix-or-flag) before it finishes the
 * turn. unerr supplies the anchored evidence; the host model supplies the
 * judgment. The discipline (§9.3) is strict: the block carries ONLY unerr's
 * concrete evidence, and "no evidence block → no Tier-2 finding" — the model
 * never free-associates from a blind diff.
 *
 * The block is routed through the agent-as-LLM seam (`behaviors/agent-llm-bridge.ts`,
 * the formalized sub-prompt-injection pattern) so it is budgeted and its
 * follow-through is measurable (§12 risk #1: "will the host model act on it?").
 */

import { AgentLlmBridge } from "../behaviors/agent-llm-bridge.js";
import type { ReviewFinding } from "./types.js";

/** A routed Tier-2 evidence block plus the seam metadata that lets us measure it. */
export interface SynthesisBlock {
  /** The evidence-block text to inject into the host model's context. */
  text: string;
  /** Bridge injection id (for `recordFollowThrough`); null if the bridge dropped it. */
  injectionId: string | null;
  /** How many Tier-2 findings were folded into the block. */
  findingCount: number;
}

/** The Tier-2 (`needsModel`) findings from a gated set; Tier-1 findings are left for the verdict renderer. */
export function selectTier2Findings(
  findings: ReviewFinding[]
): ReviewFinding[] {
  return findings.filter((f) => f.needsModel);
}

/** Wire anchor (`f:path:line` / `e:key`) for one finding — matches the note-dsl anchor form. */
function anchorLabel(finding: ReviewFinding): string {
  const { kind, value, line } = finding.anchor;
  return line ? `${kind}:${value}:${line}` : `${kind}:${value}`;
}

/**
 * One finding rendered as evidence context (no template prefix — the bridge
 * adds that once). Hypothesis (title) + concrete evidence + suggested action,
 * so the model has unerr's facts and a starting point but makes its own call.
 */
export function formatEvidenceContext(finding: ReviewFinding): string {
  const lines = [
    `[${finding.checkerId} · ${finding.severity} · ${anchorLabel(finding)}] ${finding.title}`,
  ];
  for (const e of finding.evidence) lines.push(`  - ${e}`);
  lines.push(`  suggested: ${finding.action}`);
  return lines.join("\n");
}

/**
 * Route the Tier-2 findings through the agent-as-LLM bridge as a single
 * evidence block (one injection → one template prefix, budget-checked). Returns
 * `null` when there are no Tier-2 findings or the bridge drops the block over
 * budget — the caller then injects nothing (silence, never a guess: §9). The
 * block is capped so a sweeping edit cannot flood the channel; the overflow is
 * summarised, not dropped silently.
 */
export function routeSynthesis(
  bridge: AgentLlmBridge,
  findings: ReviewFinding[],
  cap = 3
): SynthesisBlock | null {
  const tier2 = selectTier2Findings(findings);
  if (tier2.length === 0) return null;

  const parts = tier2.slice(0, cap).map(formatEvidenceContext);
  if (tier2.length > cap) {
    parts.push(
      `(+${tier2.length - cap} more Tier-2 finding(s) — run \`unerr review\` for the full set)`
    );
  }

  const prompt = bridge.createPrompt("review_synthesis", parts.join("\n\n"));
  const text = bridge.inject(prompt);
  if (text.length === 0) return null; // over per-call budget → inject nothing

  return {
    text,
    injectionId: bridge.getLastInjectionId(),
    findingCount: tier2.length,
  };
}

/**
 * Convenience for callers without a persistent bridge (the standalone CLI, a
 * cold hook process): build the evidence block with an ephemeral bridge.
 * Follow-through is not tracked across calls, but the block still renders so the
 * host model gets the same evidence. Returns `""` when there is nothing to route.
 */
export function buildSynthesisBlock(
  findings: ReviewFinding[],
  cap = 3
): string {
  const block = routeSynthesis(new AgentLlmBridge(), findings, cap);
  return block?.text ?? "";
}
