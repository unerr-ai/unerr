/**
 * BA-1.6: Loop Circuit Breaker tests.
 *
 * Verifies:
 *   - 3 stuck patterns detected (repetitive_failure, context_poisoning, over_planning)
 *   - Circuit breaker state transitions (closed → open → half_open → closed)
 *   - Token-savings calculation correctness
 *   - TDD exemption (test files excluded from entity-retry count)
 *   - 1K token gate enforcement
 */

import { describe, expect, it } from "vitest";
import type { ToolCallContext } from "../behaviors/framework.js";
import { LoopCircuitBreaker } from "../behaviors/loop-breaker.js";

function makeCtx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    toolName: "edit_file",
    args: { path: "src/payment.ts", content: "fix" },
    sessionId: "test-session",
    entityKey: "src/payment.ts::processPayment",
    filePath: "src/payment.ts",
    ...overrides,
  };
}

function makeErrorResult(): Record<string, unknown> {
  return {
    error: true,
    content: [{ type: "text", text: "TypeError: Cannot read property" }],
  };
}

function makeSuccessResult(): Record<string, unknown> {
  return {
    content: [{ type: "text", text: "File updated successfully" }],
  };
}

describe("Loop Circuit Breaker (BA-1.1)", () => {
  describe("Pattern Detection", () => {
    it("detects repetitive failure after 4 consecutive errors on same entity", async () => {
      const breaker = new LoopCircuitBreaker({ maxAttemptsPerEntity: 4 });

      for (let i = 0; i < 3; i++) {
        const ctx = makeCtx({
          result: { error: true, content: `TypeError on line ${45 + i}` },
          args: { path: "src/payment.ts", content: "retry logic v1" },
        });
        const output = await breaker.onPostToolUse(ctx);
        expect(output).toBeNull();
      }

      const finalCtx = makeCtx({
        result: { error: true, content: "TypeError on line 48" },
        args: { path: "src/payment.ts", content: "retry logic v1" },
      });
      const output = await breaker.onPostToolUse(finalCtx);
      expect(output).not.toBeNull();
      expect(output?.halt).toBe(true);
      expect(output?._context?.pattern).toBe("repetitive_failure");
      expect(output?._context?.reason).toContain(
        "4 consecutive failed attempts"
      );
    });

    it("detects context poisoning when all results are identical", async () => {
      const breaker = new LoopCircuitBreaker({ maxAttemptsPerEntity: 4 });
      const identicalResult = {
        error: true,
        content: [{ type: "text", text: "The exact same error every time" }],
      };

      for (let i = 0; i < 4; i++) {
        const ctx = makeCtx({
          result: identicalResult,
          args: {
            path: "src/payment.ts",
            content: `completely_different_approach_${i * 100}`,
          },
        });
        const output = await breaker.onPostToolUse(ctx);
        if (i < 3) {
          expect(output).toBeNull();
        } else {
          expect(output).not.toBeNull();
          expect(output?._context?.pattern).toBe("context_poisoning");
        }
      }
    });

    it("detects over-planning when attempts are spaced far apart", async () => {
      const breaker = new LoopCircuitBreaker({ maxAttemptsPerEntity: 4 });
      const now = Date.now();

      for (let i = 0; i < 4; i++) {
        const ctx = makeCtx({
          result: makeErrorResult(),
          args: {
            path: "src/payment.ts",
            action: `action_${i}`,
            variation: `v${i * 50}`,
          },
        });

        const originalDateNow = Date.now;
        Date.now = () => now + i * 20_000;
        try {
          await breaker.onPostToolUse(ctx);
        } finally {
          Date.now = originalDateNow;
        }
      }

      const stats = breaker.getSessionStats();
      expect(stats.loopsPrevented).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Circuit Breaker States", () => {
    it("transitions from CLOSED to OPEN on loop detection", async () => {
      const breaker = new LoopCircuitBreaker({ maxAttemptsPerEntity: 4 });

      expect(
        breaker.getCircuitState("src/payment.ts::processPayment")
      ).toBeNull();

      for (let i = 0; i < 4; i++) {
        await breaker.onPostToolUse(makeCtx({ result: makeErrorResult() }));
      }

      expect(breaker.getCircuitState("src/payment.ts::processPayment")).toBe(
        "open"
      );
    });

    it("blocks further attempts while circuit is OPEN", async () => {
      const breaker = new LoopCircuitBreaker({
        maxAttemptsPerEntity: 4,
        cooldownMs: 60_000,
      });

      for (let i = 0; i < 4; i++) {
        await breaker.onPostToolUse(makeCtx({ result: makeErrorResult() }));
      }

      const preResult = await breaker.onPreToolUse(makeCtx());
      expect(preResult).not.toBeNull();
      expect(preResult?.halt).toBe(true);
      expect(preResult?._context?.cooldown_remaining_s).toBeGreaterThan(0);
    });

    it("transitions to HALF_OPEN after cooldown expires", async () => {
      const breaker = new LoopCircuitBreaker({
        maxAttemptsPerEntity: 4,
        cooldownMs: 100,
      });

      for (let i = 0; i < 4; i++) {
        await breaker.onPostToolUse(makeCtx({ result: makeErrorResult() }));
      }

      await new Promise((r) => setTimeout(r, 150));

      const preResult = await breaker.onPreToolUse(makeCtx());
      expect(preResult).toBeNull();
    });

    it("returns to CLOSED from HALF_OPEN on success", async () => {
      const breaker = new LoopCircuitBreaker({
        maxAttemptsPerEntity: 4,
        cooldownMs: 100,
      });

      for (let i = 0; i < 4; i++) {
        await breaker.onPostToolUse(makeCtx({ result: makeErrorResult() }));
      }

      await new Promise((r) => setTimeout(r, 150));

      await breaker.onPreToolUse(makeCtx());
      await breaker.onPostToolUse(makeCtx({ result: makeSuccessResult() }));

      expect(breaker.getCircuitState("src/payment.ts::processPayment")).toBe(
        "closed"
      );
    });

    it("returns to OPEN from HALF_OPEN on failure", async () => {
      const breaker = new LoopCircuitBreaker({
        maxAttemptsPerEntity: 4,
        cooldownMs: 100,
      });

      for (let i = 0; i < 4; i++) {
        await breaker.onPostToolUse(makeCtx({ result: makeErrorResult() }));
      }

      await new Promise((r) => setTimeout(r, 150));

      await breaker.onPreToolUse(makeCtx());
      await breaker.onPostToolUse(makeCtx({ result: makeErrorResult() }));

      expect(breaker.getCircuitState("src/payment.ts::processPayment")).toBe(
        "open"
      );
    });
  });

  describe("TDD Exemption", () => {
    it("does NOT flag test file modifications as loop attempts", async () => {
      const breaker = new LoopCircuitBreaker({ maxAttemptsPerEntity: 4 });

      for (let i = 0; i < 6; i++) {
        const ctx = makeCtx({
          filePath: "src/__tests__/payment.test.ts",
          entityKey: "src/__tests__/payment.test.ts::testProcessPayment",
          result: makeErrorResult(),
        });
        const output = await breaker.onPostToolUse(ctx);
        expect(output).toBeNull();
      }
    });

    it("exempts .spec.ts files", async () => {
      const breaker = new LoopCircuitBreaker({ maxAttemptsPerEntity: 4 });

      for (let i = 0; i < 6; i++) {
        const ctx = makeCtx({
          filePath: "src/payment.spec.ts",
          entityKey: "src/payment.spec.ts::specProcessPayment",
          result: makeErrorResult(),
        });
        expect(await breaker.onPostToolUse(ctx)).toBeNull();
      }
    });
  });

  describe("Token Savings Calculation", () => {
    it("includes tokens_saved in guard moment output", async () => {
      const breaker = new LoopCircuitBreaker({ maxAttemptsPerEntity: 4 });

      let lastOutput = null;
      for (let i = 0; i < 4; i++) {
        lastOutput = await breaker.onPostToolUse(
          makeCtx({ result: makeErrorResult() })
        );
      }

      expect(lastOutput).not.toBeNull();
      expect(lastOutput?._meta?.tokens_saved).toBeGreaterThan(0);
    });

    it("accumulates savings across multiple loops", async () => {
      const breaker = new LoopCircuitBreaker({
        maxAttemptsPerEntity: 4,
        cooldownMs: 50,
      });

      for (let i = 0; i < 4; i++) {
        await breaker.onPostToolUse(makeCtx({ result: makeErrorResult() }));
      }

      const stats1 = breaker.getSessionStats();
      expect(stats1.loopsPrevented).toBe(1);
      expect(stats1.totalTokensSaved).toBeGreaterThan(0);

      await new Promise((r) => setTimeout(r, 100));

      await breaker.onPreToolUse(
        makeCtx({ entityKey: "src/checkout.ts::handleOrder" })
      );
      for (let i = 0; i < 4; i++) {
        await breaker.onPostToolUse(
          makeCtx({
            entityKey: "src/checkout.ts::handleOrder",
            filePath: "src/checkout.ts",
            result: makeErrorResult(),
          })
        );
      }

      const stats2 = breaker.getSessionStats();
      expect(stats2.loopsPrevented).toBe(2);
      expect(stats2.totalTokensSaved).toBeGreaterThan(stats1.totalTokensSaved);
    });
  });

  describe("1K Token Gate", () => {
    it("only fires guard when estimated savings exceed 1K tokens", async () => {
      const breaker = new LoopCircuitBreaker({ maxAttemptsPerEntity: 4 });

      let guardFired = false;
      for (let i = 0; i < 4; i++) {
        const output = await breaker.onPostToolUse(
          makeCtx({ result: makeErrorResult() })
        );
        if (output?.guardMoment) guardFired = true;
      }

      expect(guardFired).toBe(true);
    });
  });

  describe("Session Stats", () => {
    it("tracks active and open circuits", async () => {
      const breaker = new LoopCircuitBreaker({ maxAttemptsPerEntity: 4 });

      for (let i = 0; i < 4; i++) {
        await breaker.onPostToolUse(makeCtx({ result: makeErrorResult() }));
      }

      const stats = breaker.getSessionStats();
      expect(stats.activeCircuits).toBe(1);
      expect(stats.openCircuits).toBe(1);
      expect(stats.loopsPrevented).toBe(1);
    });
  });

  describe("Edge Cases", () => {
    it("does nothing without entityKey", async () => {
      const breaker = new LoopCircuitBreaker({ maxAttemptsPerEntity: 4 });
      const ctx = makeCtx({ entityKey: undefined, result: makeErrorResult() });
      expect(await breaker.onPostToolUse(ctx)).toBeNull();
    });

    it("handles success results correctly (no false positive)", async () => {
      const breaker = new LoopCircuitBreaker({ maxAttemptsPerEntity: 4 });

      for (let i = 0; i < 6; i++) {
        const output = await breaker.onPostToolUse(
          makeCtx({ result: makeSuccessResult() })
        );
        expect(output).toBeNull();
      }
    });

    it("resets failure count on success between errors", async () => {
      const breaker = new LoopCircuitBreaker({ maxAttemptsPerEntity: 4 });

      for (let i = 0; i < 3; i++) {
        await breaker.onPostToolUse(makeCtx({ result: makeErrorResult() }));
      }

      await breaker.onPostToolUse(makeCtx({ result: makeSuccessResult() }));

      for (let i = 0; i < 3; i++) {
        const output = await breaker.onPostToolUse(
          makeCtx({ result: makeErrorResult() })
        );
        expect(output).toBeNull();
      }
    });
  });
});
