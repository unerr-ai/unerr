/**
 * Sprint 6 — failure-mining unit tests.
 *
 * Covers recurrence-grouping (>= N) and DSL-wire formatting. No external
 * fixtures; signals are constructed inline. Async tracker methods are mocked
 * with mockResolvedValue where exercised.
 */

import { describe, expect, it, vi } from "vitest";
import { parseNote } from "../intelligence/note-dsl.js";
import {
  DEFAULT_MIN_RECURRENCE,
  type FailureSignal,
  type LedgerEntryLike,
  mineFailures,
  signalsFromCircuitBreaker,
  signalsFromDrift,
  signalsFromLedger,
} from "../tracking/failure-mining.js";

function retry(entity: string, detail?: string): FailureSignal {
  return {
    kind: "repeated_retry",
    anchorType: "e",
    anchorValue: entity,
    detail,
  };
}

describe("mineFailures — recurrence grouping", () => {
  it("does not propose a note below the recurrence threshold", () => {
    const signals = [retry("Foo"), retry("Foo")]; // 2 < default 3
    expect(mineFailures(signals)).toEqual([]);
  });

  it("proposes a note once a failure recurs >= the default threshold", () => {
    const signals = [retry("Foo"), retry("Foo"), retry("Foo")]; // exactly 3
    const proposals = mineFailures(signals);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.occurrences).toBe(3);
    expect(proposals[0]?.failureKind).toBe("repeated_retry");
    expect(proposals[0]?.autoApplied).toBe(false);
  });

  it("respects a custom minRecurrence", () => {
    const signals = [retry("Foo"), retry("Foo")];
    expect(mineFailures(signals, { minRecurrence: 2 })).toHaveLength(1);
    expect(mineFailures(signals, { minRecurrence: 5 })).toEqual([]);
  });

  it("groups separately by anchor and counts each independently", () => {
    const signals = [
      retry("Foo"),
      retry("Foo"),
      retry("Foo"),
      retry("Bar"),
      retry("Bar"), // Bar only twice
    ];
    const proposals = mineFailures(signals);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.note.anchor_value).toBe("Foo");
  });

  it("keeps entity and file anchors with the same value distinct", () => {
    const signals: FailureSignal[] = [
      { kind: "repeated_retry", anchorType: "e", anchorValue: "x" },
      { kind: "repeated_retry", anchorType: "e", anchorValue: "x" },
      { kind: "repeated_retry", anchorType: "e", anchorValue: "x" },
      { kind: "repeated_retry", anchorType: "f", anchorValue: "x" },
      { kind: "repeated_retry", anchorType: "f", anchorValue: "x" },
      { kind: "repeated_retry", anchorType: "f", anchorValue: "x" },
    ];
    const proposals = mineFailures(signals);
    expect(proposals).toHaveLength(2);
    expect(proposals.map((p) => p.note.anchor_type).sort()).toEqual(["e", "f"]);
  });

  it("is deterministic and order-independent of input", () => {
    const a = mineFailures([
      retry("A"),
      retry("A"),
      retry("A"),
      retry("B"),
      retry("B"),
      retry("B"),
    ]);
    const b = mineFailures([
      retry("B"),
      retry("A"),
      retry("B"),
      retry("A"),
      retry("B"),
      retry("A"),
    ]);
    expect(a.map((p) => p.wire)).toEqual(b.map((p) => p.wire));
  });

  it("orders proposals by occurrence count, most-recurring first", () => {
    const signals = [
      retry("Low"),
      retry("Low"),
      retry("Low"),
      retry("High"),
      retry("High"),
      retry("High"),
      retry("High"),
      retry("High"),
    ];
    const proposals = mineFailures(signals);
    expect(proposals.map((p) => p.note.anchor_value)).toEqual(["High", "Low"]);
  });

  it("ignores malformed signals (missing anchor / bad anchorType)", () => {
    const signals = [
      {
        kind: "repeated_retry",
        anchorType: "e",
        anchorValue: "",
      } as FailureSignal,
      {
        kind: "repeated_retry",
        anchorType: "x" as "e",
        anchorValue: "Foo",
      } as FailureSignal,
      retry("Ok"),
      retry("Ok"),
      retry("Ok"),
    ];
    const proposals = mineFailures(signals);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.note.anchor_value).toBe("Ok");
  });
});

describe("mineFailures — DSL wire formatting", () => {
  it("emits a valid kind|anchor|polarity|content wire string", () => {
    const proposals = mineFailures([retry("Foo"), retry("Foo"), retry("Foo")]);
    const wire = proposals[0]?.wire ?? "";
    // First three '|' are field separators.
    const [kind, anchor, polarity] = wire.split("|");
    expect(kind).toBe("wrn");
    expect(anchor).toBe("e:Foo");
    expect(polarity).toBe("-");
    // Round-trips through the canonical parser without throwing.
    const parsed = parseNote(wire);
    expect(parsed.kind).toBe("wrn");
    expect(parsed.anchor_type).toBe("e");
    expect(parsed.anchor_value).toBe("Foo");
    expect(parsed.polarity).toBe("-");
    expect(parsed.content.length).toBeGreaterThan(0);
  });

  it("uses a file anchor for file-anchored failures", () => {
    const signals: FailureSignal[] = Array.from({ length: 3 }, () => ({
      kind: "drift_flag",
      anchorType: "f",
      anchorValue: "src/foo.ts",
    }));
    const wire = mineFailures(signals)[0]?.wire ?? "";
    expect(wire.startsWith("wrn|f:src/foo.ts|-|")).toBe(true);
    expect(() => parseNote(wire)).not.toThrow();
  });

  it("folds distinct details into the content, deduplicated", () => {
    const signals = [
      retry("Foo", "rule A"),
      retry("Foo", "rule A"), // duplicate detail
      retry("Foo", "rule B"),
    ];
    const content = mineFailures(signals)[0]?.note.content ?? "";
    expect(content).toContain("rule A");
    expect(content).toContain("rule B");
    // Deduped: "rule A" appears once.
    expect(content.match(/rule A/g)).toHaveLength(1);
  });

  it("phrases content per failure kind", () => {
    const cb = signalsFromCircuitBreaker(["Foo"]); // weight = default threshold
    const cbContent = mineFailures(cb)[0]?.note.content ?? "";
    expect(cbContent).toContain("circuit-breaker");

    const drift =
      mineFailures([
        { kind: "drift_flag", anchorType: "e", anchorValue: "Foo" },
        { kind: "drift_flag", anchorType: "e", anchorValue: "Foo" },
        { kind: "drift_flag", anchorType: "e", anchorValue: "Foo" },
      ])[0]?.note.content ?? "";
    expect(drift).toContain("drifted");
  });
});

describe("signal extractors", () => {
  const editTools = new Set(["sync_local_diff", "apply_edit"]);

  it("signalsFromLedger keeps only failing edit-tool entries with an anchor", () => {
    const entries: LedgerEntryLike[] = [
      // read-only tool — ignored even if it "failed"
      {
        tool: "search_code",
        result_summary: { error: "x" },
        args_summary: { entity: "A" },
      },
      // edit tool, no violation — ignored
      {
        tool: "sync_local_diff",
        result_summary: { had_violations: false },
        args_summary: { entity: "B" },
      },
      // edit tool, violation, entity anchor — kept
      {
        tool: "sync_local_diff",
        result_summary: { had_violations: true, error: "rule X" },
        args_summary: { entity: "C" },
      },
      // edit tool, failure via success:false, file anchor — kept
      {
        tool: "apply_edit",
        result_summary: { success: false },
        args_summary: { file_path: "src/d.ts" },
      },
      // edit tool, violation but no resolvable anchor — dropped
      {
        tool: "apply_edit",
        result_summary: { violations_count: 2 },
        args_summary: {},
      },
    ];
    const signals = signalsFromLedger(entries, editTools);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      kind: "repeated_retry",
      anchorType: "e",
      anchorValue: "C",
      detail: "rule X",
    });
    expect(signals[1]).toMatchObject({
      kind: "repeated_retry",
      anchorType: "f",
      anchorValue: "src/d.ts",
    });
  });

  it("signalsFromLedger feeds straight into a proposal when an edit repeats", () => {
    const entries: LedgerEntryLike[] = Array.from({ length: 3 }, () => ({
      tool: "sync_local_diff",
      result_summary: { had_violations: true },
      args_summary: { entity: "Hot" },
    }));
    const proposals = mineFailures(signalsFromLedger(entries, editTools));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.wire.startsWith("wrn|e:Hot|-|")).toBe(true);
  });

  it("signalsFromCircuitBreaker weights one halt to clear the threshold alone", () => {
    const signals = signalsFromCircuitBreaker(["Looped"]);
    expect(signals.length).toBe(DEFAULT_MIN_RECURRENCE);
    const proposals = mineFailures(signals);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.failureKind).toBe("circuit_breaker");
    expect(proposals[0]?.note.anchor_value).toBe("Looped");
  });

  it("signalsFromDrift expands drift_count into repeated occurrences", () => {
    const signals = signalsFromDrift([
      { key: "Drifted", drift_count: 3, reason: "body changed" },
      { name: "Once", drift_count: 1 },
      { file_path: "src/x.ts" }, // no key/name → file anchor, count defaults to 1
    ]);
    expect(signals.filter((s) => s.anchorValue === "Drifted")).toHaveLength(3);
    const proposals = mineFailures(signals);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.note.anchor_value).toBe("Drifted");
    expect(proposals[0]?.note.anchor_type).toBe("e");
  });

  it("works end-to-end against a mocked async drift source", async () => {
    // Mirror DriftTracker.getDriftSummary being async: mockResolvedValue.
    const fakeTracker = {
      getDriftedEntities: vi
        .fn()
        .mockResolvedValue([{ key: "Edrift", drift_count: 3 }]),
    };
    const entities = await fakeTracker.getDriftedEntities();
    const proposals = mineFailures(signalsFromDrift(entities));
    expect(fakeTracker.getDriftedEntities).toHaveBeenCalledOnce();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.failureKind).toBe("drift_flag");
  });
});
