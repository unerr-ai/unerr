/**
 * P4 — Tier-2 host synthesis (.internal/reviewer-architecture.md §3, §5.1, §9.3).
 *
 * Tier-2 findings are NOT verdicts — they are evidence blocks the host model
 * elaborates on (fix-or-flag), routed through the agent-as-LLM seam. These tests
 * pin: only `needsModel` findings are selected, the evidence context carries
 * unerr's concrete facts (anchor + title + evidence + suggested action), the
 * routed block is budgeted/capped, and "no Tier-2 finding → no block" (§9.3).
 */

import { describe, expect, it } from "vitest";
import { AgentLlmBridge } from "../behaviors/agent-llm-bridge.js";
import {
  buildSynthesisBlock,
  formatEvidenceContext,
  routeSynthesis,
  selectTier2Findings,
} from "../review/synthesis.js";
import type { ReviewFinding } from "../review/types.js";

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    checkerId: "intent_mismatch",
    tier: 2,
    severity: "medium",
    anchor: { kind: "e", value: "k_foo" },
    title: "diff added a field where the intent said rename",
    evidence: [
      "mark_intent: rename getUser→loadUser",
      "diff added field userV2",
    ],
    action: "rename the field instead of adding a parallel one",
    needsModel: true,
    ...over,
  };
}

describe("selectTier2Findings", () => {
  it("keeps only needsModel findings", () => {
    const t2 = finding();
    const t1 = finding({
      checkerId: "breaking_callers",
      tier: 1,
      needsModel: false,
    });
    expect(selectTier2Findings([t1, t2, t1])).toEqual([t2]);
  });

  it("returns empty when no finding needs the model", () => {
    expect(selectTier2Findings([finding({ needsModel: false })])).toEqual([]);
  });
});

describe("formatEvidenceContext", () => {
  it("renders anchor, title, every evidence line, and the suggested action", () => {
    const ctx = formatEvidenceContext(
      finding({ anchor: { kind: "f", value: "src/x.ts", line: 42 } })
    );
    expect(ctx).toContain("f:src/x.ts:42");
    expect(ctx).toContain("intent_mismatch · medium");
    expect(ctx).toContain("diff added a field where the intent said rename");
    expect(ctx).toContain("- mark_intent: rename getUser→loadUser");
    expect(ctx).toContain("- diff added field userV2");
    expect(ctx).toContain("suggested: rename the field instead");
  });
});

describe("routeSynthesis", () => {
  it("returns null when there are no Tier-2 findings", () => {
    const bridge = new AgentLlmBridge();
    expect(routeSynthesis(bridge, [finding({ needsModel: false })])).toBeNull();
  });

  it("routes one budgeted block through the bridge with the synthesis prefix", () => {
    const bridge = new AgentLlmBridge();
    const block = routeSynthesis(bridge, [finding()]);
    expect(block).not.toBeNull();
    expect(block?.findingCount).toBe(1);
    expect(block?.injectionId).toMatch(/^prompt-/);
    // The host-synthesis instruction (no free-association) leads the block.
    expect(block?.text).toContain("ONLY the evidence shown");
    // unerr's concrete evidence rides inside the block.
    expect(block?.text).toContain("diff added field userV2");
    // The bridge recorded the injection so follow-through is measurable.
    expect(bridge.getStats().totalInjected).toBe(1);
  });

  it("caps the visible findings and summarises the overflow", () => {
    const bridge = new AgentLlmBridge();
    const many = Array.from({ length: 5 }, (_, i) =>
      finding({ title: `t2 finding ${i}` })
    );
    const block = routeSynthesis(bridge, many, 3);
    expect(block?.findingCount).toBe(5);
    expect(block?.text).toContain("+2 more Tier-2 finding(s)");
  });

  it("returns null when the per-call prompt budget is already exhausted", () => {
    const bridge = new AgentLlmBridge();
    // Exhaust the 1000-token per-call budget with prior injections.
    const filler = bridge.createPrompt("loop_diagnosis", "x".repeat(4000));
    bridge.inject(filler);
    bridge.inject(filler);
    expect(routeSynthesis(bridge, [finding()])).toBeNull();
  });
});

describe("buildSynthesisBlock (ephemeral bridge)", () => {
  it("returns '' when there is nothing to route", () => {
    expect(buildSynthesisBlock([finding({ needsModel: false })])).toBe("");
  });

  it("returns the evidence-block text when a Tier-2 finding fired", () => {
    const text = buildSynthesisBlock([finding()]);
    expect(text).toContain("ONLY the evidence shown");
    expect(text).toContain("intent_mismatch");
  });
});
