import { describe, expect, it, vi } from "vitest";
import type {
  BehaviorEvent,
  BehaviorEventInput,
} from "../tracking/behavior-events.js";
import {
  KIND_CATEGORY,
  type SavingsEventKind,
  delegationTierCounts,
  emitDelegationSavings,
  emitSavingsEvent,
} from "../tracking/savings-events.js";

describe("emitSavingsEvent (Issue 8 consolidated seam)", () => {
  it("writes ONE savings_event row carrying kind + mapped category in detail", () => {
    const record = vi.fn();
    const ok = emitSavingsEvent({ record }, "delegated_to_junior", {
      session_id: "s1",
      turn: 4,
      tokens_saved: 1200,
      model: "haiku",
      tier: "worker",
    });
    expect(ok).toBe(true);
    expect(record).toHaveBeenCalledTimes(1);
    const input = record.mock.calls[0]?.[0] as BehaviorEventInput;
    expect(input.type).toBe("savings_event");
    expect(input.turn).toBe(4);
    expect(input.detail).toMatchObject({
      kind: "delegated_to_junior",
      category: "savings",
      tokens_saved: 1200,
      model: "haiku",
      tier: "worker",
    });
  });

  it("maps the tool field out of detail onto the row", () => {
    const record = vi.fn();
    emitSavingsEvent({ record }, "search_code_context_inlined", {
      session_id: "s1",
      tool: "search_code",
      roundtrips_saved: 1,
    });
    const input = record.mock.calls[0]?.[0] as BehaviorEventInput;
    expect(input.tool).toBe("search_code");
    expect(input.detail).toMatchObject({ roundtrips_saved: 1 });
    // tool is NOT duplicated into detail.
    expect((input.detail as Record<string, unknown>).tool).toBeUndefined();
  });

  it("is a silent no-op for a null sink (missing writer never breaks a hot path)", () => {
    expect(
      emitSavingsEvent(null, "code_grep_unredirected", { session_id: "s" })
    ).toBe(false);
  });

  it("never throws when the sink throws", () => {
    const record = vi.fn(() => {
      throw new Error("db down");
    });
    expect(
      emitSavingsEvent({ record }, "bulk_edit_oneshot", { session_id: "s" })
    ).toBe(false);
  });

  it("every kind has exactly one category, in one of the four buckets", () => {
    const buckets = new Set(["savings", "prevention", "routing", "leak"]);
    for (const [kind, category] of Object.entries(KIND_CATEGORY)) {
      expect(buckets.has(category), `${kind} → ${category}`).toBe(true);
    }
  });

  it("categorizes representative kinds correctly", () => {
    const cases: Array<[SavingsEventKind, string]> = [
      ["bulk_edit_oneshot", "savings"],
      ["grep_redirected_to_search_code", "prevention"],
      ["harness_subagent_model", "routing"],
      ["code_grep_unredirected", "leak"],
    ];
    for (const [kind, category] of cases) {
      expect(KIND_CATEGORY[kind]).toBe(category);
    }
  });
});

describe("emitDelegationSavings — tier call-mix counter", () => {
  it("stamps the structured tier onto harness_subagent_model + delegated_to_junior", () => {
    const rows: BehaviorEventInput[] = [];
    const record = vi.fn((input: BehaviorEventInput) => rows.push(input));
    emitDelegationSavings(
      { record },
      {
        session_id: "s1",
        delegable_class: "tests",
        sweep: false,
        tier: "worker",
      }
    );
    const kinds = rows.map((r) => (r.detail as Record<string, unknown>).kind);
    expect(kinds).toContain("harness_subagent_model");
    expect(kinds).toContain("delegated_to_junior");
    for (const r of rows) {
      expect((r.detail as Record<string, unknown>).tier).toBe("worker");
    }
  });
});

describe("delegationTierCounts", () => {
  const savingsEvent = (kind: string, tier: string): BehaviorEvent =>
    ({
      id: 0,
      ts: "",
      session_id: "s1",
      pid: 0,
      turn: 0,
      agent: "claude-code",
      type: "savings_event",
      tool: null,
      entity_key: null,
      response_bytes: null,
      detail: { kind, tier },
    }) as BehaviorEvent;

  it("buckets harness_subagent_model rows by tier", () => {
    const counts = delegationTierCounts([
      savingsEvent("harness_subagent_model", "worker"),
      savingsEvent("harness_subagent_model", "junior"),
      savingsEvent("harness_subagent_model", "junior"),
    ]);
    expect(counts).toEqual({ junior: 2, worker: 1, architect: 0, other: 0 });
  });

  it("ignores non-savings_event rows and non-harness_subagent_model kinds", () => {
    const counts = delegationTierCounts([
      savingsEvent("delegated_to_junior", "worker"),
      {
        id: 0,
        ts: "",
        session_id: "s1",
        pid: 0,
        turn: 0,
        agent: "claude-code",
        type: "cascade_guard",
        tool: null,
        entity_key: null,
        response_bytes: null,
      } as BehaviorEvent,
    ]);
    expect(counts).toEqual({ junior: 0, worker: 0, architect: 0, other: 0 });
  });

  it("returns all-zero counts for an empty session", () => {
    expect(delegationTierCounts([])).toEqual({
      junior: 0,
      worker: 0,
      architect: 0,
      other: 0,
    });
  });
});
