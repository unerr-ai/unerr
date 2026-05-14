/**
 * Sprint 2 — SessionContext unit tests.
 *
 * Tests dedup logic for blast radius, conventions, risks, greeting,
 * and value counter threshold behavior.
 */

import { describe, expect, it } from "vitest";
import { SessionContext } from "../intelligence/session-context.js";
import type { SessionEvents } from "../proxy/session-stats.js";

function createEvents(overrides: Partial<SessionEvents> = {}): SessionEvents {
  return {
    conventionViolationsCaught: 0,
    chokepointWarningsIssued: 0,
    circularDepsDetected: 0,
    signaturePreservations: 0,
    deadCodeReferences: 0,
    aiEntitiesModified: 0,
    humanEntitiesModified: 0,
    mixedEntitiesModified: 0,
    ...overrides,
  };
}

describe("SessionContext", () => {
  // ── Blast radius dedup ──────────────────────────────────────────

  describe("shouldInjectBlastRadius", () => {
    it("returns true for first query of an entity", () => {
      const ctx = new SessionContext();
      expect(ctx.shouldInjectBlastRadius("fn1")).toBe(true);
    });

    it("returns false after entity has been queried", () => {
      const ctx = new SessionContext();
      ctx.recordQuery("fn1");
      expect(ctx.shouldInjectBlastRadius("fn1")).toBe(false);
    });

    it("different entities are independent", () => {
      const ctx = new SessionContext();
      ctx.recordQuery("fn1");
      expect(ctx.shouldInjectBlastRadius("fn2")).toBe(true);
    });
  });

  // ── Convention dedup ────────────────────────────────────────────

  describe("shouldInjectConvention", () => {
    it("returns true for unseen convention", () => {
      const ctx = new SessionContext();
      expect(ctx.shouldInjectConvention("pattern:p1")).toBe(true);
    });

    it("returns false after convention has been surfaced", () => {
      const ctx = new SessionContext();
      ctx.recordConventions(["pattern:p1"]);
      expect(ctx.shouldInjectConvention("pattern:p1")).toBe(false);
    });

    it("tracks multiple conventions independently", () => {
      const ctx = new SessionContext();
      ctx.recordConventions(["pattern:p1"]);
      expect(ctx.shouldInjectConvention("pattern:p2")).toBe(true);
    });
  });

  // ── Risk dedup ──────────────────────────────────────────────────

  describe("shouldInjectRisk", () => {
    it("returns true for unseen entity risk", () => {
      const ctx = new SessionContext();
      expect(ctx.shouldInjectRisk("fn1")).toBe(true);
    });

    it("returns false after risk has been surfaced", () => {
      const ctx = new SessionContext();
      ctx.recordRisk("fn1");
      expect(ctx.shouldInjectRisk("fn1")).toBe(false);
    });
  });

  // ── Session greeting ────────────────────────────────────────────

  describe("isFirstCall / markGreeted", () => {
    it("isFirstCall returns true initially", () => {
      const ctx = new SessionContext();
      expect(ctx.isFirstCall()).toBe(true);
    });

    it("isFirstCall returns false after markGreeted", () => {
      const ctx = new SessionContext();
      ctx.markGreeted();
      expect(ctx.isFirstCall()).toBe(false);
    });

    it("markGreeted is idempotent", () => {
      const ctx = new SessionContext();
      ctx.markGreeted();
      ctx.markGreeted();
      expect(ctx.isFirstCall()).toBe(false);
    });
  });

  // ── Tool call counter ───────────────────────────────────────────

  describe("recordToolCall / getToolCallCount", () => {
    it("starts at zero", () => {
      const ctx = new SessionContext();
      expect(ctx.getToolCallCount()).toBe(0);
    });

    it("increments on each call", () => {
      const ctx = new SessionContext();
      ctx.recordToolCall();
      ctx.recordToolCall();
      ctx.recordToolCall();
      expect(ctx.getToolCallCount()).toBe(3);
    });
  });

  // ── Value counter ───────────────────────────────────────────────

  describe("getValueCounter", () => {
    it("returns undefined when <=10 tool calls", () => {
      const ctx = new SessionContext();
      for (let i = 0; i < 10; i++) ctx.recordToolCall();
      const events = createEvents({ conventionViolationsCaught: 3 });
      expect(ctx.getValueCounter(events)).toBeUndefined();
    });

    it("returns undefined when caught events is 0", () => {
      const ctx = new SessionContext();
      for (let i = 0; i < 15; i++) ctx.recordToolCall();
      expect(ctx.getValueCounter(createEvents())).toBeUndefined();
    });

    it("returns undefined when caught events not divisible by 3", () => {
      const ctx = new SessionContext();
      for (let i = 0; i < 15; i++) ctx.recordToolCall();
      const events = createEvents({ conventionViolationsCaught: 2 });
      expect(ctx.getValueCounter(events)).toBeUndefined();
    });

    it("returns counter string when conditions are met", () => {
      const ctx = new SessionContext();
      for (let i = 0; i < 15; i++) ctx.recordToolCall();
      const events = createEvents({ conventionViolationsCaught: 3 });
      const counter = ctx.getValueCounter(events);
      expect(counter).toBe("(unerr has caught 3 issues this session)");
    });

    it("fires only once per threshold crossing", () => {
      const ctx = new SessionContext();
      for (let i = 0; i < 15; i++) ctx.recordToolCall();
      const events = createEvents({ conventionViolationsCaught: 3 });

      const first = ctx.getValueCounter(events);
      expect(first).toBeDefined();

      // Same count — should not fire again
      const second = ctx.getValueCounter(events);
      expect(second).toBeUndefined();

      // Advance to 6
      events.conventionViolationsCaught = 6;
      const third = ctx.getValueCounter(events);
      expect(third).toBeDefined();
      expect(third).toContain("6 issues");
    });

    it("counts across all event categories", () => {
      const ctx = new SessionContext();
      for (let i = 0; i < 15; i++) ctx.recordToolCall();
      // 1 + 1 + 1 = 3, divisible by 3
      const events = createEvents({
        conventionViolationsCaught: 1,
        chokepointWarningsIssued: 1,
        circularDepsDetected: 1,
      });
      const counter = ctx.getValueCounter(events);
      expect(counter).toBe("(unerr has caught 3 issues this session)");
    });
  });

  // ── Post-compaction recovery (Task 7.8) ─────────────────────────

  describe("entity history (post-compaction)", () => {
    it("records entity history on first call", () => {
      const ctx = new SessionContext();
      ctx.recordEntityHistory("fn1", 5, "high");
      expect(ctx.hasHistory("fn1")).toBe(true);
      const entry = ctx.getHistory("fn1");
      expect(entry?.blast_radius).toBe(5);
      expect(entry?.risk).toBe("high");
      expect(entry?.queriedAt).toBeDefined();
    });

    it("does not overwrite on subsequent calls", () => {
      const ctx = new SessionContext();
      ctx.recordEntityHistory("fn1", 5, "high");
      ctx.recordEntityHistory("fn1", 10, "low");
      const entry = ctx.getHistory("fn1");
      expect(entry?.blast_radius).toBe(5);
      expect(entry?.risk).toBe("high");
    });

    it("returns undefined for unqueried entity", () => {
      const ctx = new SessionContext();
      expect(ctx.hasHistory("fn1")).toBe(false);
      expect(ctx.getHistory("fn1")).toBeUndefined();
    });

    it("tracks multiple entities independently", () => {
      const ctx = new SessionContext();
      ctx.recordEntityHistory("fn1", 5, "high");
      ctx.recordEntityHistory("fn2", 0, "normal");
      expect(ctx.getHistory("fn1")?.blast_radius).toBe(5);
      expect(ctx.getHistory("fn2")?.blast_radius).toBe(0);
    });
  });

  // ── Diagnostics ─────────────────────────────────────────────────

  describe("diagnostics", () => {
    it("tracks entities queried count", () => {
      const ctx = new SessionContext();
      ctx.recordQuery("fn1");
      ctx.recordQuery("fn2");
      expect(ctx.entitiesQueried).toBe(2);
    });

    it("tracks conventions surfaced count", () => {
      const ctx = new SessionContext();
      ctx.recordConventions(["c1", "c2", "c3"]);
      expect(ctx.conventionsSurfaced).toBe(3);
    });

    it("tracks risks surfaced count", () => {
      const ctx = new SessionContext();
      ctx.recordRisk("fn1");
      ctx.recordRisk("fn2");
      expect(ctx.risksSurfaced).toBe(2);
    });

    it("deduplicates entities and conventions", () => {
      const ctx = new SessionContext();
      ctx.recordQuery("fn1");
      ctx.recordQuery("fn1");
      expect(ctx.entitiesQueried).toBe(1);

      ctx.recordConventions(["c1", "c1"]);
      expect(ctx.conventionsSurfaced).toBe(1);
    });
  });
});
