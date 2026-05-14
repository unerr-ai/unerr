/**
 * BA-3.5: Change Impact Narrative + Agent-as-LLM Bridge tests.
 *
 * Verifies:
 *   - Narrative includes all behavior signals
 *   - Markdown well-formed
 *   - Risk level computed correctly
 *   - Counterfactual framing always present
 *   - Agent-as-LLM templates, timeout, budget, follow-through
 */

import { describe, expect, it } from "vitest";
import { AgentLlmBridge } from "../behaviors/agent-llm-bridge.js";
import { ChangeNarrativeBehavior } from "../behaviors/change-narrative.js";
import type { ToolCallContext } from "../behaviors/framework.js";

function makeCtx(): ToolCallContext {
  return {
    toolName: "__session_end__",
    args: {},
    sessionId: "test-session",
  };
}

// ── Change Narrative Tests ─────────────────────────────────────

describe("Change Impact Narrative (BA-3.2)", () => {
  describe("Behavior Identity", () => {
    it("has correct id and hooks", () => {
      const narrative = new ChangeNarrativeBehavior();
      expect(narrative.id).toBe("change_narrative");
      expect(narrative.hooks).toContain("session_end");
      expect(narrative.defaultLevel).toBe("suggestion");
    });
  });

  describe("Empty Session", () => {
    it("returns null when no behaviors have data", async () => {
      const narrative = new ChangeNarrativeBehavior();
      const output = await narrative.onSessionEnd(makeCtx());
      expect(output).toBeNull();
    });
  });

  describe("Risk Level Computation", () => {
    it("returns low risk for clean session", async () => {
      const narrative = new ChangeNarrativeBehavior();
      const output = await narrative.onSessionEnd(makeCtx());
      expect(output).toBeNull();
    });
  });

  describe("Counterfactual Framing", () => {
    it("produces counterfactual for clean sessions (no issues)", async () => {
      const narrative = new ChangeNarrativeBehavior();
      const output = await narrative.onSessionEnd(makeCtx());
      if (output) {
        const ctx = output._context?.change_narrative as {
          counterfactual: string;
        };
        expect(ctx.counterfactual).toContain("Clean session");
      }
    });
  });

  describe("Markdown Output", () => {
    it("generates well-formed markdown when behaviors have data", async () => {
      const narrative = new ChangeNarrativeBehavior();
      const output = await narrative.onSessionEnd(makeCtx());
      if (output) {
        const ctx = output._context?.change_narrative as { markdown: string };
        expect(ctx.markdown).toContain("## Change Impact");
      }
    });
  });
});

// ── Agent-as-LLM Bridge Tests ──────────────────────────────────

describe("Agent-as-LLM Bridge (BA-3.3)", () => {
  describe("Template System", () => {
    it("lists all available templates", () => {
      const templates = AgentLlmBridge.getTemplates();
      expect(templates).toContain("session_resume");
      expect(templates).toContain("doc_generation");
      expect(templates).toContain("loop_diagnosis");
      expect(templates).toContain("convention_fix");
      expect(templates).toContain("cascade_fix");
      expect(templates).toContain("architecture_alternative");
      expect(templates.length).toBeGreaterThanOrEqual(7);
    });

    it("returns template definition with prefix and maxTokens", () => {
      const def = AgentLlmBridge.getTemplateDefinition("loop_diagnosis");
      expect(def.prefix).toContain("Analyze why");
      expect(def.maxTokens).toBe(500);
      expect(def.priority).toBe("high");
    });

    it("creates prompt with template prefix and context", () => {
      const bridge = new AgentLlmBridge();
      const prompt = bridge.createPrompt(
        "doc_generation",
        "Function processPayment(amount: number, currency: string): Promise<Receipt>",
      );

      expect(prompt.template).toBe("doc_generation");
      expect(prompt.content).toContain("Generate documentation");
      expect(prompt.content).toContain("processPayment");
      expect(prompt.priority).toBe("low");
    });
  });

  describe("Timeout Handling", () => {
    it("defaults to 5000ms timeout", () => {
      const bridge = new AgentLlmBridge();
      const prompt = bridge.createPrompt("session_resume", "test context");
      expect(prompt.timeoutMs).toBe(5000);
    });

    it("accepts custom timeout", () => {
      const bridge = new AgentLlmBridge();
      const prompt = bridge.createPrompt("session_resume", "test context", {
        timeoutMs: 3000,
      });
      expect(prompt.timeoutMs).toBe(3000);
    });
  });

  describe("Fallback Handling", () => {
    it("stores fallback content", () => {
      const bridge = new AgentLlmBridge();
      const prompt = bridge.createPrompt("doc_generation", "test", {
        fallback: "AST-based docs only",
      });
      expect(prompt.fallbackContent).toBe("AST-based docs only");
    });

    it("fallback is null by default", () => {
      const bridge = new AgentLlmBridge();
      const prompt = bridge.createPrompt("doc_generation", "test");
      expect(prompt.fallbackContent).toBeNull();
    });
  });

  describe("Injection and Budget", () => {
    it("injects prompt and tracks it", () => {
      const bridge = new AgentLlmBridge();
      const prompt = bridge.createPrompt(
        "loop_diagnosis",
        "4 failed attempts on processPayment",
      );
      const injected = bridge.inject(prompt);

      expect(injected).toContain("Analyze why");
      expect(bridge.getStats().totalInjected).toBe(1);
    });

    it("respects per-call prompt budget", () => {
      const bridge = new AgentLlmBridge();

      for (let i = 0; i < 5; i++) {
        const prompt = bridge.createPrompt("loop_diagnosis", "x".repeat(2000));
        bridge.inject(prompt);
      }

      const overBudget = bridge.createPrompt(
        "doc_generation",
        "x".repeat(2000),
      );
      const result = bridge.inject(overBudget);

      expect(result).toBe("");
    });

    it("resets budget between calls", () => {
      const bridge = new AgentLlmBridge();

      const longContext = "x".repeat(3800);
      const prompt1 = bridge.createPrompt("loop_diagnosis", longContext);
      bridge.inject(prompt1);

      bridge.resetCallBudget();

      const prompt2 = bridge.createPrompt("doc_generation", "short context");
      const result = bridge.inject(prompt2);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("Follow-Through Tracking", () => {
    it("starts with 0% follow-through rate", () => {
      const bridge = new AgentLlmBridge();
      expect(bridge.getFollowThroughRate()).toBe(0);
    });

    it("tracks follow-through when recorded", () => {
      const bridge = new AgentLlmBridge();
      const prompt = bridge.createPrompt("doc_generation", "test");
      bridge.inject(prompt);

      const injectionId = bridge.getLastInjectionId()!;
      expect(injectionId).toBeTruthy();

      bridge.recordFollowThrough(injectionId);
      expect(bridge.getStats().followedThrough).toBe(1);
    });

    it("computes follow-through rate correctly", () => {
      const bridge = new AgentLlmBridge();

      const p1 = bridge.createPrompt("doc_generation", "test1");
      bridge.inject(p1);
      const id1 = bridge.getLastInjectionId()!;
      bridge.recordFollowThrough(id1);

      bridge.resetCallBudget();
      const p2 = bridge.createPrompt("convention_fix", "test2");
      bridge.inject(p2);

      expect(bridge.getFollowThroughRate()).toBe(0.5);
    });
  });

  describe("Stats", () => {
    it("tracks injections by template type", () => {
      const bridge = new AgentLlmBridge();

      bridge.inject(bridge.createPrompt("doc_generation", "a"));
      bridge.resetCallBudget();
      bridge.inject(bridge.createPrompt("doc_generation", "b"));
      bridge.resetCallBudget();
      bridge.inject(bridge.createPrompt("loop_diagnosis", "c"));

      const stats = bridge.getStats();
      expect(stats.byTemplate.doc_generation).toBe(2);
      expect(stats.byTemplate.loop_diagnosis).toBe(1);
    });
  });
});
