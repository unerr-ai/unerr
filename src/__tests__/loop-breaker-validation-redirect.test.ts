/**
 * B1 + B2 integration test — loop redirect fires for repeated bad-arg calls
 * on file_path-keyed circuits.
 *
 * B1: LoopCircuitBreaker.onPreToolUse / onPostToolUse now fall back to
 *     ctx.filePath when ctx.entityKey is absent.
 * B2: proxy.ts fires behaviorDispatcher.firePostToolUse in the validation-
 *     failure branch before returning, so repeated bad-arg calls reach the
 *     loop detector.
 *
 * This test drives the REAL LoopCircuitBreaker (+ BehaviorDispatcher) with the
 * exact ctx shape B2 produces: entityKey=undefined, filePath from args.file_path.
 * DEFAULT_REDIRECT_THRESHOLD = 3.
 */

import { describe, expect, it } from "vitest";
import type { ToolCallContext } from "../behaviors/framework.js";
import { BehaviorDispatcher } from "../behaviors/framework.js";
import { LoopCircuitBreaker } from "../behaviors/loop-breaker.js";

// Matches DEFAULT_REDIRECT_THRESHOLD in loop-breaker.ts (not exported).
const REDIRECT_THRESHOLD = 3;

// A non-test file path so isTestFile() does not exempt it.
const FILE_PATH = "src/cache/redis-client.ts";

/** The ctx shape proxy.ts B2 builds after a validation failure. */
function makeValCtx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    toolName: "file_read",
    args: { file_path: FILE_PATH },
    sessionId: "test-session",
    entityKey: undefined,
    filePath: FILE_PATH,
    result: {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "missing required field: key",
            required: ["key"],
            details: "key must be a non-empty string",
          }),
        },
      ],
    },
    ...overrides,
  };
}

describe(`B1 — filePath fallback keys the circuit (redirectThreshold=${REDIRECT_THRESHOLD})`, () => {
  it("onPostToolUse returns null for the first (threshold-1) calls", async () => {
    const breaker = new LoopCircuitBreaker({
      maxAttemptsPerEntity: 5,
      redirectThreshold: REDIRECT_THRESHOLD,
    });

    for (let i = 0; i < REDIRECT_THRESHOLD - 1; i++) {
      const out = await breaker.onPostToolUse(makeValCtx());
      expect(out, `call ${i + 1} should be null`).toBeNull();
    }
  });

  it("onPostToolUse returns redirect (non-halting) on the threshold-th call", async () => {
    const breaker = new LoopCircuitBreaker({
      maxAttemptsPerEntity: 5,
      redirectThreshold: REDIRECT_THRESHOLD,
    });

    // Burn through the first (threshold-1) calls.
    for (let i = 0; i < REDIRECT_THRESHOLD - 1; i++) {
      await breaker.onPostToolUse(makeValCtx());
    }

    // threshold-th call: redirect fires.
    const out = await breaker.onPostToolUse(makeValCtx());

    expect(out).not.toBeNull();
    expect(out?.halt).toBe(false);

    // Circuit stays closed — redirect is non-halting.
    expect(breaker.getCircuitState(FILE_PATH)).toBe("closed");

    // _meta.circuit_breaker carries entity keyed on FILE_PATH (B1 fallback).
    const meta = out?._meta as {
      circuit_breaker?: { entity?: string; message?: string };
    };
    expect(meta?.circuit_breaker?.entity).toBe(FILE_PATH);
    expect(meta?.circuit_breaker?.message).toMatch(/^loop — /);
  });

  it("onPreToolUse also uses filePath fallback (circuit open after halt)", async () => {
    const breaker = new LoopCircuitBreaker({
      maxAttemptsPerEntity: 3,
      redirectThreshold: 1,
      cooldownMs: 60_000,
    });

    // Trip the circuit via onPostToolUse.
    for (let i = 0; i < 3; i++) {
      await breaker.onPostToolUse(makeValCtx());
    }
    expect(breaker.getCircuitState(FILE_PATH)).toBe("open");

    // onPreToolUse should block a new call on the same filePath.
    const preOut = await breaker.onPreToolUse(makeValCtx());
    expect(preOut?.halt).toBe(true);
    expect(preOut?._context).toMatchObject({ halt: true });
  });
});

describe("B2 — BehaviorDispatcher integrates LoopCircuitBreaker with validation-failure ctx", () => {
  it("first (threshold-1) calls return null from firePostToolUse", async () => {
    const dispatcher = new BehaviorDispatcher();
    dispatcher.register(
      new LoopCircuitBreaker({
        maxAttemptsPerEntity: 5,
        redirectThreshold: REDIRECT_THRESHOLD,
      })
    );

    for (let i = 0; i < REDIRECT_THRESHOLD - 1; i++) {
      const out = await dispatcher.firePostToolUse(makeValCtx());
      expect(out, `firePostToolUse call ${i + 1} should be null`).toBeNull();
    }
  });

  it("threshold-th call returns redirect with isError context preserved", async () => {
    const dispatcher = new BehaviorDispatcher();
    dispatcher.register(
      new LoopCircuitBreaker({
        maxAttemptsPerEntity: 5,
        redirectThreshold: REDIRECT_THRESHOLD,
      })
    );

    for (let i = 0; i < REDIRECT_THRESHOLD - 1; i++) {
      await dispatcher.firePostToolUse(makeValCtx());
    }

    // This simulates the redirect the proxy now folds into the isError:true response.
    const out = await dispatcher.firePostToolUse(makeValCtx());

    expect(out).not.toBeNull();
    expect(out?.halt).toBe(false);

    const meta = out?._meta as {
      circuit_breaker?: {
        entity?: string;
        message?: string;
        attempts?: number;
      };
    };
    // Entity is keyed on FILE_PATH via B1 fallback.
    expect(meta?.circuit_breaker?.entity).toBe(FILE_PATH);
    expect(meta?.circuit_breaker?.attempts).toBe(REDIRECT_THRESHOLD);

    // Redirect message follows nudge rules.
    const msg = meta?.circuit_breaker?.message ?? "";
    expect(msg).toMatch(/^loop — /);
    expect(msg).toContain(FILE_PATH);
    expect(msg).toMatch(/failed \d+×/);
    expect(msg).toMatch(/instead$/);
  });
});
