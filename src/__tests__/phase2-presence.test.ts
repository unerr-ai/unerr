/**
 * Phase 2 — User-fed memory, ambiguity, attribution, enforcement.
 *
 * Pure (IO-free) tests for the Phase 2 modules:
 *   - unerr-remember.ts (Sprint 5a)
 *   - pending-confirmations.ts (Sprint 6)
 *   - attribution-panel.ts (Sprint 7)
 *   - enforcement-loop.ts (Sprint 8)
 *
 * The TemporalFactStore-backed integration path is exercised by the
 * Phase 1 tests (temporal-facts.test.ts) — these specs cover the new
 * additive logic without touching the disk-backed store.
 */

import { describe, expect, it, vi } from "vitest";
import { PendingConfirmationRegistry } from "../intelligence/pending-confirmations.js";
import type { TemporalFact } from "../intelligence/temporal-facts.js";
import {
  type FactProvenance,
  eventsWithAttribution,
  renderAttributionBlock,
  renderFactAttribution,
  renderFactAttributionBlock,
} from "../proxy/attribution-panel.js";
import {
  appliesToFor,
  factsApplyingTo,
  renderEnforcedFactPrefix,
} from "../proxy/enforcement-loop.js";
import {
  REMEMBER_AMBIGUITY_THRESHOLD,
  REMEMBER_CONFIDENCE_FLOOR,
  executeUnerrRemember,
} from "../tools/intelligence/unerr-remember.js";
import type { BehaviorEvent } from "../tracking/behavior-events.js";
import type { NamedEvent } from "../tracking/named-events.js";

// ── Shared fixtures ──────────────────────────────────────────────────

function makeFact(overrides: Partial<TemporalFact> = {}): TemporalFact {
  return {
    fact_id: overrides.fact_id ?? "f1",
    fact_type: overrides.fact_type ?? "procedural",
    scope: overrides.scope ?? "project",
    subject: overrides.subject ?? "project",
    content: overrides.content ?? "always use Foo for Bar",
    base_confidence: overrides.base_confidence ?? 0.95,
    effective_confidence: overrides.effective_confidence ?? 0.95,
    reinforcement_count: overrides.reinforcement_count ?? 0,
    created_at: overrides.created_at ?? Date.now(),
    last_reinforced_at: overrides.last_reinforced_at ?? Date.now(),
    last_contradicted_at: overrides.last_contradicted_at ?? 0,
    source: overrides.source ?? "user_fed",
  };
}

function makeProvenance(
  overrides: Partial<FactProvenance> = {}
): FactProvenance {
  return {
    fact_id: "f1",
    content: "always use Foo for Bar",
    source: "user_fed",
    created_at: "2026-05-21T10:00:00Z",
    source_quote: "from now on, always use Foo for Bar",
    subject: "project",
    scope: "project",
    ...overrides,
  };
}

// ── unerr_remember (Sprint 5a) ───────────────────────────────────────

describe("unerr_remember (executeUnerrRemember)", () => {
  function makeStubStore(): {
    recordUserFedFact: ReturnType<typeof vi.fn>;
    createFact: ReturnType<typeof vi.fn>;
  } {
    return {
      recordUserFedFact: vi
        .fn()
        .mockResolvedValue({ fact_id: "f-stored", deduplicated: false }),
      createFact: vi
        .fn()
        .mockResolvedValue({ fact_id: "f-stored", deduplicated: false }),
    };
  }

  function makeStubEvents(): {
    record: ReturnType<typeof vi.fn>;
  } {
    return { record: vi.fn() };
  }

  it("abandons capture below the confidence floor and emits event", async () => {
    const store = makeStubStore();
    const events = makeStubEvents();
    const res = await executeUnerrRemember(
      {
        content: "always use Foo",
        source_quote: "remember: always use Foo",
        scope: "project",
        subject: "project",
        fact_type: "procedural",
        confidence: REMEMBER_CONFIDENCE_FLOOR - 0.1,
      },
      // biome-ignore lint/suspicious/noExplicitAny: stub double for store
      store as any,
      "s1",
      3,
      // biome-ignore lint/suspicious/noExplicitAny: stub double for events
      events as any
    );
    expect(res.stored).toBe(false);
    if (!res.stored) {
      expect(res.reason).toBe("confidence_too_low");
    }
    expect(store.recordUserFedFact).not.toHaveBeenCalled();
    expect(events.record).toHaveBeenCalledTimes(1);
    expect(events.record.mock.calls[0]?.[0].type).toBe(
      "fact_capture_abandoned"
    );
  });

  it("stores with ambiguity_flag when 0.5 ≤ confidence < 0.7", async () => {
    const store = makeStubStore();
    const events = makeStubEvents();
    const res = await executeUnerrRemember(
      {
        content: "co-locate tests with code",
        source_quote: "we tend to co-locate tests with the code",
        scope: "project",
        subject: "project",
        fact_type: "convention",
        confidence: 0.6,
      },
      // biome-ignore lint/suspicious/noExplicitAny: stub
      store as any,
      "s1",
      3,
      // biome-ignore lint/suspicious/noExplicitAny: stub
      events as any
    );
    expect(res.stored).toBe(true);
    if (res.stored) {
      expect(res.ambiguity_flag).toBe(true);
      expect(res.confidence).toBeCloseTo(0.6);
      expect(res.echo_summary).toContain("please confirm");
    }
  });

  it("stores cleanly when confidence ≥ threshold", async () => {
    const store = makeStubStore();
    const events = makeStubEvents();
    const res = await executeUnerrRemember(
      {
        content: "always use Foo",
        source_quote: "from now on, always use Foo",
        scope: "project",
        subject: "project",
        fact_type: "procedural",
        confidence: REMEMBER_AMBIGUITY_THRESHOLD + 0.05,
      },
      // biome-ignore lint/suspicious/noExplicitAny: stub
      store as any,
      "s1",
      3,
      // biome-ignore lint/suspicious/noExplicitAny: stub
      events as any
    );
    expect(res.stored).toBe(true);
    if (res.stored) {
      expect(res.ambiguity_flag).toBe(false);
      expect(res.echo_summary).not.toContain("needs confirmation");
    }
    // A clean store emits exactly one fact_stored_user_fed behavior event.
    expect(events.record).toHaveBeenCalledTimes(1);
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: "fact_stored_user_fed" })
    );
  });

  it("registers a pending confirmation when ambiguous and clears it when confident", async () => {
    const store = makeStubStore();
    const events = makeStubEvents();
    const registry = new PendingConfirmationRegistry(null);
    // Ambiguous capture → registered.
    store.recordUserFedFact.mockResolvedValueOnce({
      fact_id: "f-amb",
      deduplicated: false,
    });
    await executeUnerrRemember(
      {
        content: "tests live next to code",
        source_quote: "I think tests should live next to code",
        scope: "project",
        subject: "project",
        fact_type: "convention",
        confidence: 0.6,
      },
      // biome-ignore lint/suspicious/noExplicitAny: stub
      store as any,
      "s1",
      1,
      // biome-ignore lint/suspicious/noExplicitAny: stub
      events as any,
      registry
    );
    expect(registry.isPending("f-amb")).toBe(true);

    // Confident reinforcement of same fact_id → registry cleared.
    store.recordUserFedFact.mockResolvedValueOnce({
      fact_id: "f-amb",
      deduplicated: true,
    });
    await executeUnerrRemember(
      {
        content: "tests live next to code",
        source_quote: "yes — tests live next to code",
        scope: "project",
        subject: "project",
        fact_type: "convention",
        confidence: 0.9,
      },
      // biome-ignore lint/suspicious/noExplicitAny: stub
      store as any,
      "s1",
      2,
      // biome-ignore lint/suspicious/noExplicitAny: stub
      events as any,
      registry
    );
    expect(registry.isPending("f-amb")).toBe(false);
  });

  it("rejects empty content / missing source_quote / bad fact_type / empty scope", async () => {
    const store = makeStubStore();
    const events = makeStubEvents();
    const baseArgs = {
      content: "x",
      source_quote: "y",
      scope: "s",
      subject: "t",
      fact_type: "procedural" as const,
      confidence: 0.9,
    };
    await expect(
      executeUnerrRemember(
        { ...baseArgs, content: "" },
        // biome-ignore lint/suspicious/noExplicitAny: stub
        store as any,
        "s1",
        0,
        // biome-ignore lint/suspicious/noExplicitAny: stub
        events as any
      )
    ).rejects.toThrow(/content/);
    await expect(
      executeUnerrRemember(
        { ...baseArgs, source_quote: "" },
        // biome-ignore lint/suspicious/noExplicitAny: stub
        store as any,
        "s1",
        0,
        // biome-ignore lint/suspicious/noExplicitAny: stub
        events as any
      )
    ).rejects.toThrow(/source_quote/);
    await expect(
      executeUnerrRemember(
        // biome-ignore lint/suspicious/noExplicitAny: deliberate bad input
        { ...baseArgs, fact_type: "nope" as any },
        // biome-ignore lint/suspicious/noExplicitAny: stub
        store as any,
        "s1",
        0,
        // biome-ignore lint/suspicious/noExplicitAny: stub
        events as any
      )
    ).rejects.toThrow(/fact_type/);
    await expect(
      executeUnerrRemember(
        { ...baseArgs, scope: "" },
        // biome-ignore lint/suspicious/noExplicitAny: stub
        store as any,
        "s1",
        0,
        // biome-ignore lint/suspicious/noExplicitAny: stub
        events as any
      )
    ).rejects.toThrow(/scope/);
  });
});

// ── pending-confirmations (Sprint 6) ─────────────────────────────────

describe("PendingConfirmationRegistry", () => {
  function makeEventsSink(): {
    record: ReturnType<typeof vi.fn>;
    sessionId: string;
    list: BehaviorEvent[];
  } {
    return {
      record: vi.fn(),
      sessionId: "s1",
      list: [],
    };
  }

  it("registers and resolves entries by fact_id", () => {
    const reg = new PendingConfirmationRegistry(null);
    reg.register({
      fact_id: "f1",
      session_id: "s1",
      subject: "project",
      scope: "project",
      content: "x",
      confidence: 0.6,
      turn: 1,
    });
    expect(reg.isPending("f1")).toBe(true);
    const resolved = reg.resolve("f1");
    expect(resolved?.fact_id).toBe("f1");
    expect(reg.isPending("f1")).toBe(false);
    expect(reg.resolve("f1")).toBeUndefined();
  });

  it("filters list() by session", () => {
    const reg = new PendingConfirmationRegistry(null);
    reg.register({
      fact_id: "fA",
      session_id: "sA",
      subject: "x",
      scope: "p",
      content: "c",
      confidence: 0.6,
      turn: 1,
    });
    reg.register({
      fact_id: "fB",
      session_id: "sB",
      subject: "x",
      scope: "p",
      content: "c",
      confidence: 0.6,
      turn: 1,
    });
    expect(reg.list().length).toBe(2);
    expect(reg.list("sA").map((e) => e.fact_id)).toEqual(["fA"]);
  });

  it("sweep emits confirmation_expired for expired entries only", () => {
    const events = makeEventsSink();
    let now = 1_000_000;
    const reg = new PendingConfirmationRegistry(
      // biome-ignore lint/suspicious/noExplicitAny: stub
      events as any,
      { ttlMs: 100, now: () => now }
    );
    reg.register({
      fact_id: "fresh",
      session_id: "s1",
      subject: "x",
      scope: "p",
      content: "c",
      confidence: 0.6,
      turn: 1,
    });
    reg.register({
      fact_id: "stale",
      session_id: "s1",
      subject: "x",
      scope: "p",
      content: "c",
      confidence: 0.6,
      turn: 1,
    });
    // Advance so "stale" is expired but "fresh" is re-registered after.
    now += 50;
    reg.register({
      fact_id: "fresh",
      session_id: "s1",
      subject: "x",
      scope: "p",
      content: "c",
      confidence: 0.6,
      turn: 2,
    });
    now += 75; // 125 ms from start: "stale" expired; "fresh" (50ms remaining +100 -75 = …) not.
    const expired = reg.sweep();
    expect(expired.map((e) => e.fact_id)).toEqual(["stale"]);
    expect(events.record).toHaveBeenCalledTimes(1);
    const arg = events.record.mock.calls[0]?.[0];
    expect(arg.type).toBe("confirmation_expired");
    expect(arg.entity_key).toBe("x");
    expect(reg.isPending("stale")).toBe(false);
    expect(reg.isPending("fresh")).toBe(true);
  });

  it("re-registering refreshes the expiry", () => {
    let now = 0;
    const reg = new PendingConfirmationRegistry(null, {
      ttlMs: 100,
      now: () => now,
    });
    reg.register({
      fact_id: "f",
      session_id: "s",
      subject: "x",
      scope: "p",
      content: "c",
      confidence: 0.6,
      turn: 1,
    });
    now = 90;
    reg.register({
      fact_id: "f",
      session_id: "s",
      subject: "x",
      scope: "p",
      content: "c",
      confidence: 0.6,
      turn: 2,
    });
    now = 150; // first expiry would have hit at 100; refreshed expiry is 190.
    expect(reg.sweep()).toEqual([]);
    expect(reg.isPending("f")).toBe(true);
  });
});

// ── attribution-panel (Sprint 7) ─────────────────────────────────────

describe("attribution-panel", () => {
  it("quotes the user verbatim for user_fed facts", () => {
    const row = renderFactAttribution(
      makeProvenance({
        source: "user_fed",
        source_quote: "from now on, always use Foo for Bar",
      })
    );
    expect(row.head.startsWith("user → ")).toBe(true);
    expect(row.detail).toContain('said: "from now on, always use Foo for Bar"');
    expect(row.where).toBe("scope: project");
  });

  it("names the detector for auto-detected facts", () => {
    const row = renderFactAttribution(
      makeProvenance({ source: "convention_detector", source_quote: undefined })
    );
    expect(row.head.startsWith("convention detector → ")).toBe(true);
    expect(row.detail).toBe("via convention detector");
  });

  it("truncates long content in the head", () => {
    const longContent = "a".repeat(120);
    const row = renderFactAttribution(makeProvenance({ content: longContent }));
    expect(row.head.length).toBeLessThanOrEqual(80);
    expect(row.head.endsWith("…")).toBe(true);
  });

  it("renderAttributionBlock returns one line per row", () => {
    const lines = renderFactAttributionBlock([
      makeProvenance({ fact_id: "a", content: "rule A" }),
      makeProvenance({
        fact_id: "b",
        content: "rule B",
        source: "convention_detector",
        source_quote: undefined,
      }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^attribution: /);
    expect(lines[1]).toMatch(/^attribution: /);
  });

  it("renderAttributionBlock is empty when input is empty", () => {
    expect(renderAttributionBlock([])).toEqual([]);
  });

  it("eventsWithAttribution filters out non-fact events", () => {
    const events: NamedEvent[] = [
      {
        event_type: "fact_stored_user_fed",
        verb: "stored",
        object: "user-asserted fact",
        agent: "claude-code",
        file_path: null,
        entity_key: null,
        session_id: "s1",
        turn: 1,
        ts: new Date().toISOString(),
        metadata: {},
      },
      {
        event_type: "cache_hit",
        verb: "served",
        object: "cache hit",
        agent: "claude-code",
        file_path: null,
        entity_key: null,
        session_id: "s1",
        turn: 1,
        ts: new Date().toISOString(),
        metadata: {},
      },
    ];
    const filtered = eventsWithAttribution(events);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.event_type).toBe("fact_stored_user_fed");
  });
});

// ── enforcement-loop (Sprint 8) ──────────────────────────────────────

describe("enforcement-loop", () => {
  it("appliesToFor merges across evidence entries", () => {
    const merged = appliesToFor([
      {
        session_id: "s",
        action: "created",
        timestamp: 1,
        applies_to: ["src/a.ts", "src/b.ts"],
      },
      {
        session_id: "s",
        action: "reinforced",
        timestamp: 2,
        applies_to: ["src/b.ts", "src/c.ts"],
      },
    ]);
    expect(new Set(merged)).toEqual(
      new Set(["src/a.ts", "src/b.ts", "src/c.ts"])
    );
  });

  it("returns [] when evidence has no applies_to entries", () => {
    const merged = appliesToFor([
      { session_id: "s", action: "created", timestamp: 1 },
    ]);
    expect(merged).toEqual([]);
  });

  it("factsApplyingTo matches exact paths", () => {
    const hits = factsApplyingTo("src/foo.ts", [
      { fact: makeFact({ fact_id: "f1" }), applies_to: ["src/foo.ts"] },
      { fact: makeFact({ fact_id: "f2" }), applies_to: ["src/bar.ts"] },
    ]);
    expect(hits.map((f) => f.fact_id)).toEqual(["f1"]);
  });

  it("factsApplyingTo matches directory prefixes", () => {
    const hits = factsApplyingTo("src/foo/bar.ts", [
      { fact: makeFact({ fact_id: "f1" }), applies_to: ["src/foo"] },
      { fact: makeFact({ fact_id: "f2" }), applies_to: ["src/baz"] },
    ]);
    expect(hits.map((f) => f.fact_id)).toEqual(["f1"]);
  });

  it("factsApplyingTo matches /* glob (single-level)", () => {
    const hits = factsApplyingTo("src/foo/bar.ts", [
      { fact: makeFact({ fact_id: "f1" }), applies_to: ["src/foo/*"] },
      { fact: makeFact({ fact_id: "f2" }), applies_to: ["src/foo/baz/*"] },
    ]);
    expect(hits.map((f) => f.fact_id)).toEqual(["f1"]);
  });

  it("factsApplyingTo matches /** glob (recursive)", () => {
    const hits = factsApplyingTo("src/foo/baz/x.ts", [
      { fact: makeFact({ fact_id: "f1" }), applies_to: ["src/foo/**"] },
      { fact: makeFact({ fact_id: "f2" }), applies_to: ["src/other/**"] },
    ]);
    expect(hits.map((f) => f.fact_id)).toEqual(["f1"]);
  });

  it("factsApplyingTo skips entries with empty applies_to", () => {
    const hits = factsApplyingTo("src/foo.ts", [
      { fact: makeFact({ fact_id: "f1" }), applies_to: [] },
      { fact: makeFact({ fact_id: "f2" }), applies_to: ["src/foo.ts"] },
    ]);
    expect(hits.map((f) => f.fact_id)).toEqual(["f2"]);
  });

  it("renderEnforcedFactPrefix uses 'avoid:' for negative, 'follow:' otherwise", () => {
    expect(
      renderEnforcedFactPrefix(
        makeFact({ fact_type: "negative", content: "never X" })
      )
    ).toBe("ur|fct [negative] avoid: never X");
    expect(
      renderEnforcedFactPrefix(
        makeFact({ fact_type: "convention", content: "tests next to code" })
      )
    ).toBe("ur|fct [convention] follow: tests next to code");
    expect(
      renderEnforcedFactPrefix(
        makeFact({ fact_type: "procedural", content: "run pnpm typecheck" })
      )
    ).toBe("ur|fct [procedural] follow: run pnpm typecheck");
    expect(
      renderEnforcedFactPrefix(
        makeFact({ fact_type: "semantic", content: "X is canonical Y" })
      )
    ).toBe("ur|fct [semantic] follow: X is canonical Y");
  });
});
