import { describe, expect, it, vi } from "vitest";
import type { BehaviorEventInput } from "../tracking/behavior-events.js";
import {
  KIND_CATEGORY,
  type SavingsEventKind,
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
