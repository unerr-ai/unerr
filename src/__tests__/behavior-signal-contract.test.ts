/**
 * P0.2 — Behavior render contract (fault-3 fix).
 *
 * The audit found that behavior outputs using bespoke `_context` keys
 * (e.g. `session_resume`, `{halt, reason}`) render to NOTHING, because
 * `buildSignalPrefix` only knows a fixed allow-list of keys. This locks the
 * ONE generic shape behaviors must emit so their output reaches the agent:
 *
 *     _context: { signals: [{ type, content, action?, entity? }] }
 *
 * Any new behavior that emits this shape is guaranteed to produce a `ur|` line.
 * If this test ever fails, the renderer contract regressed — fix the renderer,
 * not the test.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { buildSignalPrefix } from "../proxy/response-envelope.js";
import { resetSignalDedupSingleton } from "../proxy/signal-dedup.js";

describe("behavior render contract — context.signals (P0.2)", () => {
  beforeEach(() => {
    resetSignalDedupSingleton();
  });

  it("renders a behavior-emitted signal into a ur| line", () => {
    const context = {
      signals: [
        {
          type: "risk",
          content: "PaymentGateway has 8 callers across 3 modules",
          action: "update them in this change",
          entity: "PaymentGateway",
        },
      ],
    };
    const prefix = buildSignalPrefix({}, context, null);
    expect(prefix).toContain("ur|");
    expect(prefix).toContain("PaymentGateway has 8 callers across 3 modules");
    expect(prefix).toContain("update them in this change");
  });

  it("renders multiple signals as multiple lines", () => {
    const context = {
      signals: [
        { type: "risk", content: "signal one", entity: "A" },
        { type: "fact", content: "signal two", entity: "B" },
      ],
    };
    const prefix = buildSignalPrefix({}, context, null);
    expect(prefix).toContain("signal one");
    expect(prefix).toContain("signal two");
    expect(prefix.trim().split("\n").length).toBeGreaterThanOrEqual(2);
  });

  it("skips signals with no content (no empty ur| lines)", () => {
    const context = { signals: [{ type: "risk", entity: "A" }] };
    const prefix = buildSignalPrefix({}, context, null);
    expect(prefix).toBe("");
  });

  it("renders nothing when there are no signals", () => {
    expect(buildSignalPrefix({}, {}, null)).toBe("");
    expect(buildSignalPrefix({}, undefined, null)).toBe("");
  });

  it("regression: bespoke _context keys still render nothing (why the contract exists)", () => {
    // The shape the retired session-continuity behavior emitted (P1.3) — kept as
    // a regression lock: it proves the audit finding (a bespoke _context key
    // renders to nothing) and why behaviors MUST use context.signals, not invent
    // keys. This is the exact unrenderability that left session-continuity dead.
    const sessionResumeShape = {
      session_resume: { summary: "prev", incomplete_work: ["x"] },
    };
    expect(buildSignalPrefix({}, sessionResumeShape, null)).toBe("");
    // loop-breaker's trip shape — same problem.
    const loopBreakerShape = { halt: true, reason: "4 failed attempts" };
    expect(buildSignalPrefix({}, loopBreakerShape, null)).toBe("");
  });
});
