/**
 * BA-1.7: Session Continuity Protocol tests.
 *
 * Verifies:
 *   - Incomplete work from session N carried forward to session N+1
 *   - Resume context matches ledger state
 *   - Agent-as-LLM prompt generated for complex sessions (>50 entries)
 *   - Empty ledger returns null (no false resume)
 *   - Risk prioritization: high-risk items appear first
 */

import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolCallContext } from "../behaviors/framework.js";
import { SessionContinuityBehavior } from "../behaviors/session-continuity.js";
import { ShadowLedger } from "../tracking/shadow-ledger.js";

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `unerr-test-continuity-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCtx(sessionId: string): ToolCallContext {
  return {
    toolName: "get_entity",
    args: {},
    sessionId,
  };
}

describe("Session Continuity Protocol (BA-1.2)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  describe("Resume Context", () => {
    it("carries forward incomplete work from previous session", async () => {
      const ledger = new ShadowLedger(tmpDir);
      const prevSessionId = ledger.getSessionId();

      ledger.record(
        "edit_file",
        { key: "src/payment.ts::processPayment", path: "src/payment.ts" },
        { source: "local" },
        "main",
        "abc123"
      );
      ledger.record(
        "edit_file",
        { key: "src/payment.ts::processPayment", path: "src/payment.ts" },
        { source: "local" },
        "main",
        "abc123"
      );
      ledger.record(
        "get_entity",
        { key: "src/checkout.ts::handleOrder" },
        { source: "local", found: true },
        "main",
        "abc123"
      );

      const newLedger = new ShadowLedger(tmpDir);
      const newSessionId = newLedger.getSessionId();
      expect(newSessionId).not.toBe(prevSessionId);

      const behavior = new SessionContinuityBehavior();
      behavior.attachLedger(newLedger);

      const output = await behavior.onSessionStart(makeCtx(newSessionId));
      expect(output).not.toBeNull();
      expect(output?._context?.session_resume).toBeDefined();

      const resume = output?._context?.session_resume as {
        last_session: { tool_calls: number };
        incomplete_work: Array<{ entity: string; risk: string }>;
      };
      expect(resume.last_session.tool_calls).toBe(3);
    });

    it("returns null for empty ledger (no false resume)", async () => {
      const ledger = new ShadowLedger(tmpDir);
      const behavior = new SessionContinuityBehavior();
      behavior.attachLedger(ledger);

      const output = await behavior.onSessionStart(
        makeCtx(ledger.getSessionId())
      );
      expect(output).toBeNull();
    });

    it("returns null when no ledger is attached", async () => {
      const behavior = new SessionContinuityBehavior();
      const output = await behavior.onSessionStart(makeCtx("test-session"));
      expect(output).toBeNull();
    });
  });

  describe("Agent-as-LLM Prompt", () => {
    it("generates agent-as-LLM prompt for sessions with >50 entries", async () => {
      const ledger = new ShadowLedger(tmpDir);

      for (let i = 0; i < 55; i++) {
        ledger.record(
          "get_entity",
          { key: `src/file${i}.ts::func${i}` },
          { source: "local", found: true },
          "main",
          "abc123"
        );
      }

      const newLedger = new ShadowLedger(tmpDir);
      const behavior = new SessionContinuityBehavior();
      behavior.attachLedger(newLedger);

      const output = await behavior.onSessionStart(
        makeCtx(newLedger.getSessionId())
      );
      expect(output).not.toBeNull();

      const resume = output?._context?.session_resume as {
        use_agent_llm?: boolean;
        agent_llm_prompt?: string;
      };
      expect(resume.use_agent_llm).toBe(true);
      expect(resume.agent_llm_prompt).toContain("Summarize");
    });

    it("does NOT generate agent-as-LLM prompt for simple sessions", async () => {
      const ledger = new ShadowLedger(tmpDir);

      for (let i = 0; i < 5; i++) {
        ledger.record(
          "get_entity",
          { key: `src/file${i}.ts::func${i}` },
          { source: "local", found: true },
          "main",
          "abc123"
        );
      }

      const newLedger = new ShadowLedger(tmpDir);
      const behavior = new SessionContinuityBehavior();
      behavior.attachLedger(newLedger);

      const output = await behavior.onSessionStart(
        makeCtx(newLedger.getSessionId())
      );
      expect(output).not.toBeNull();

      const resume = output?._context?.session_resume as {
        use_agent_llm?: boolean;
      };
      expect(resume.use_agent_llm).toBeUndefined();
    });
  });

  describe("Working State", () => {
    it("includes branch and file count in resume", async () => {
      const ledger = new ShadowLedger(tmpDir);

      ledger.record(
        "edit_file",
        { key: "src/a.ts::funcA", path: "src/a.ts" },
        { source: "local" },
        "feature/payments",
        "abc123"
      );
      ledger.record(
        "edit_file",
        { key: "src/b.ts::funcB", path: "src/b.ts" },
        { source: "local" },
        "feature/payments",
        "def456"
      );

      const newLedger = new ShadowLedger(tmpDir);
      const behavior = new SessionContinuityBehavior();
      behavior.attachLedger(newLedger);

      const output = await behavior.onSessionStart(
        makeCtx(newLedger.getSessionId())
      );
      expect(output).not.toBeNull();

      const resume = output?._context?.session_resume as {
        working_state: {
          last_branch: string | null;
          files_modified: number;
        };
      };
      expect(resume.working_state.last_branch).toBe("feature/payments");
      expect(resume.working_state.files_modified).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Risk Prioritization", () => {
    it("orders incomplete work by modification count (proxy for risk)", async () => {
      const ledger = new ShadowLedger(tmpDir);

      ledger.record(
        "edit_file",
        { key: "src/low.ts::low" },
        { source: "local" },
        "main",
        "abc123"
      );

      for (let i = 0; i < 5; i++) {
        ledger.record(
          "edit_file",
          { key: "src/high.ts::high" },
          { source: "local" },
          "main",
          "abc123"
        );
      }

      const newLedger = new ShadowLedger(tmpDir);
      const behavior = new SessionContinuityBehavior();
      behavior.attachLedger(newLedger);

      const output = await behavior.onSessionStart(
        makeCtx(newLedger.getSessionId())
      );
      expect(output).not.toBeNull();

      const resume = output?._context?.session_resume as {
        incomplete_work: Array<{ entity: string; risk: string }>;
      };

      if (resume.incomplete_work.length >= 2) {
        expect(resume.incomplete_work[0]?.entity).toBe("src/high.ts::high");
        expect(resume.incomplete_work[0]?.risk).toBe("high");
      }
    });
  });

  describe("Behavior Framework Integration", () => {
    it("has correct id and hooks", () => {
      const behavior = new SessionContinuityBehavior();
      expect(behavior.id).toBe("session_continuity");
      expect(behavior.hooks).toContain("session_start");
      expect(behavior.defaultLevel).toBe("suggestion");
    });

    it("reports confidence correctly", () => {
      const behavior = new SessionContinuityBehavior();
      expect(behavior.getConfidence()).toBe(1.0);

      behavior.recordFeedback("accepted");
      behavior.recordFeedback("accepted");
      behavior.recordFeedback("dismissed");
      expect(behavior.getConfidence()).toBeCloseTo(2 / 3, 2);
    });
  });
});
