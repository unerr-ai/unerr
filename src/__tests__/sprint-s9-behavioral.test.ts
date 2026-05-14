/**
 * Sprint S9: Day 1 Behavioral Hooks — Tests
 *
 * S9.1: Circuit breaker fires after 4 retries on same entity
 * S9.2: Health-triggered circuit break (health < 0.3)
 * S9.3: Caught event counter increments
 * S9.4: Halt message format
 * S9.5: Convention violations wire into caught counter
 * S9.6: Caught counter feeds value counter (every 3rd event)
 */

import { beforeEach, describe, expect, it } from "vitest";
import { SessionContext } from "../intelligence/session-context.js";
import {
  type SessionEvents,
  createSessionEvents,
  totalCaughtEvents,
} from "../proxy/session-stats.js";
import {
  LedgerCircuitBreaker,
  formatHaltMessage,
} from "../tracking/circuit-breaker.js";

// ── S9.1: Circuit Breaker fires after 4 retries ───────────────────

describe("S9.1: Circuit Breaker — entity retry detection", () => {
  let breaker: LedgerCircuitBreaker;

  beforeEach(() => {
    breaker = new LedgerCircuitBreaker();
  });

  it("does not fire with fewer than 4 violation attempts", () => {
    breaker.recordAttempt("src/core.ts::processPayment", true);
    breaker.recordAttempt("src/core.ts::processPayment", true);
    breaker.recordAttempt("src/core.ts::processPayment", true);
    const result = breaker.check(["src/core.ts::processPayment"]);
    expect(result).toBeNull();
  });

  it("fires after 4 consecutive violation attempts", () => {
    const entity = "src/core.ts::processPayment";
    breaker.recordAttempt(entity, true);
    breaker.recordAttempt(entity, true);
    breaker.recordAttempt(entity, true);
    breaker.recordAttempt(entity, true);
    const result = breaker.check([entity]);
    expect(result).not.toBeNull();
    expect(result?.triggered).toBe(true);
    expect(result?.entity).toBe(entity);
    expect(result?.attempts).toBe(4);
  });

  it("does not fire if attempts have no violations", () => {
    const entity = "src/utils.ts::formatDate";
    breaker.recordAttempt(entity, false);
    breaker.recordAttempt(entity, false);
    breaker.recordAttempt(entity, false);
    breaker.recordAttempt(entity, false);
    const result = breaker.check([entity]);
    expect(result).toBeNull();
  });

  it("does not fire if violations are interspersed with successes", () => {
    const entity = "src/api.ts::handleRequest";
    breaker.recordAttempt(entity, true);
    breaker.recordAttempt(entity, true);
    breaker.recordAttempt(entity, false); // success breaks the streak
    breaker.recordAttempt(entity, true);
    breaker.recordAttempt(entity, true);
    const result = breaker.check([entity]);
    expect(result).toBeNull();
  });

  it("remains halted on subsequent checks", () => {
    const entity = "src/core.ts::processPayment";
    for (let i = 0; i < 4; i++) breaker.recordAttempt(entity, true);
    breaker.check([entity]); // trips it
    // Subsequent check should still show halted
    const result = breaker.check([entity]);
    expect(result).not.toBeNull();
    expect(result?.triggered).toBe(true);
  });

  it("resets correctly for a specific entity", () => {
    const entity = "src/core.ts::processPayment";
    for (let i = 0; i < 4; i++) breaker.recordAttempt(entity, true);
    breaker.check([entity]);
    breaker.reset(entity);
    expect(breaker.isHalted(entity)).toBe(false);
    const result = breaker.check([entity]);
    expect(result).toBeNull();
  });

  it("tracks multiple entities independently", () => {
    const entity1 = "src/a.ts::foo";
    const entity2 = "src/b.ts::bar";
    for (let i = 0; i < 4; i++) breaker.recordAttempt(entity1, true);
    breaker.recordAttempt(entity2, true);
    breaker.recordAttempt(entity2, true);

    const result1 = breaker.check([entity1]);
    const result2 = breaker.check([entity2]);
    expect(result1).not.toBeNull();
    expect(result2).toBeNull();
  });
});

// ── S9.3: Caught Event Counter ─────────────────────────────────────

describe("S9.3: Caught event counter", () => {
  it("increments convention violations", () => {
    const events = createSessionEvents();
    events.conventionViolationsCaught += 3;
    expect(totalCaughtEvents(events)).toBe(3);
  });

  it("increments chokepoint warnings", () => {
    const events = createSessionEvents();
    events.chokepointWarningsIssued += 2;
    expect(totalCaughtEvents(events)).toBe(2);
  });

  it("increments circular deps", () => {
    const events = createSessionEvents();
    events.circularDepsDetected += 1;
    expect(totalCaughtEvents(events)).toBe(1);
  });

  it("sums all caught categories", () => {
    const events = createSessionEvents();
    events.conventionViolationsCaught = 2;
    events.chokepointWarningsIssued = 3;
    events.circularDepsDetected = 1;
    events.signaturePreservations = 1;
    events.deadCodeReferences = 2;
    expect(totalCaughtEvents(events)).toBe(9);
  });
});

// ── S9.4: Halt Message Formatter ───────────────────────────────────

describe("S9.4: Halt message formatter", () => {
  it("includes entity name", () => {
    const msg = formatHaltMessage("src/core.ts::processPayment", 4);
    expect(msg).toContain("src/core.ts::processPayment");
  });

  it("includes attempt count", () => {
    const msg = formatHaltMessage("src/api.ts::handleAuth", 6);
    expect(msg).toContain("6 times");
  });

  it("starts with Stop", () => {
    const msg = formatHaltMessage("entity", 4);
    expect(msg).toMatch(/^Stop\./);
  });

  it("suggests different approach", () => {
    const msg = formatHaltMessage("entity", 5);
    expect(msg).toContain("different approach");
  });
});

// ── S9.6: Value Counter integration ────────────────────────────────

describe("S9.6: Value counter fires on caught events", () => {
  it("fires at every 3rd caught event after 10 tool calls", () => {
    const ctx = new SessionContext();
    const events = createSessionEvents();

    // Record 11 tool calls (value counter only fires after 10)
    for (let i = 0; i < 11; i++) ctx.recordToolCall();

    // 1st and 2nd caught event — no fire
    events.conventionViolationsCaught = 1;
    expect(ctx.getValueCounter(events)).toBeUndefined();
    events.conventionViolationsCaught = 2;
    expect(ctx.getValueCounter(events)).toBeUndefined();

    // 3rd caught event — fires
    events.conventionViolationsCaught = 3;
    const msg = ctx.getValueCounter(events);
    expect(msg).toContain("3 issues");
  });

  it("does not fire before 10 tool calls", () => {
    const ctx = new SessionContext();
    const events = createSessionEvents();
    for (let i = 0; i < 5; i++) ctx.recordToolCall();
    events.conventionViolationsCaught = 3;
    expect(ctx.getValueCounter(events)).toBeUndefined();
  });

  it("fires again at 6th caught event", () => {
    const ctx = new SessionContext();
    const events = createSessionEvents();
    for (let i = 0; i < 11; i++) ctx.recordToolCall();

    events.conventionViolationsCaught = 3;
    ctx.getValueCounter(events); // fires at 3
    events.conventionViolationsCaught = 4;
    expect(ctx.getValueCounter(events)).toBeUndefined();
    events.conventionViolationsCaught = 5;
    expect(ctx.getValueCounter(events)).toBeUndefined();
    events.conventionViolationsCaught = 6;
    const msg = ctx.getValueCounter(events);
    expect(msg).toContain("6 issues");
  });
});
