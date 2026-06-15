/**
 * Local decision records (C5) — projection + auto-draft tests.
 *
 * Covers the stable id (UUIDv5, never random), marker → record projection with
 * an FSRS schedule, and the at-merge auto-draft (one paragraph, never blank).
 */

import { describe, expect, it } from "vitest";
import {
  type DecisionRecord,
  autoDraftAtMerge,
  decisionRecordFromMarker,
  decisionRecordId,
} from "../cloud/decision-record.js";
import { deterministicId } from "../cloud/event-id.js";
import { initialSchedule } from "../cloud/fsrs-schedule.js";
import type { MarkerRow } from "../timeline/timeline-store.js";

function marker(over: Partial<MarkerRow> = {}): MarkerRow {
  return {
    marker_id: "m1",
    type: "decision",
    text: "chose upsert over insert to keep the metric idempotent",
    session_id: "s1",
    turn_id: "t1",
    ts: 1_700_000_000_000,
    blocker_ref: "",
    file_path: "",
    ...over,
  };
}

describe("decisionRecordId", () => {
  it("is the deterministic UUIDv5 of the marker id (never random)", () => {
    expect(decisionRecordId({ marker_id: "m1" })).toBe(
      deterministicId("decision", "m1")
    );
  });

  it("is stable across calls and differs per marker", () => {
    expect(decisionRecordId({ marker_id: "m1" })).toBe(
      decisionRecordId({ marker_id: "m1" })
    );
    expect(decisionRecordId({ marker_id: "m1" })).not.toBe(
      decisionRecordId({ marker_id: "m2" })
    );
  });
});

describe("decisionRecordFromMarker", () => {
  it("keeps the full prose local and derives an FSRS schedule at the marker time", () => {
    const m = marker();
    const rec = decisionRecordFromMarker(m);
    expect(rec.id).toBe(decisionRecordId(m));
    expect(rec.body).toBe(m.text);
    expect(rec.recorded_at_ms).toBe(m.ts);
    expect(rec.session_id).toBe("s1");
    expect(rec.schedule).toEqual(initialSchedule(m.ts));
  });

  it("falls back to now() for a non-finite timestamp", () => {
    const before = Date.now();
    const rec = decisionRecordFromMarker(marker({ ts: Number.NaN }));
    expect(rec.recorded_at_ms).toBeGreaterThanOrEqual(before);
  });
});

describe("autoDraftAtMerge", () => {
  function record(over: Partial<DecisionRecord> = {}): DecisionRecord {
    const m = marker();
    return { ...decisionRecordFromMarker(m), ...over };
  }

  it("returns null when there are no decisions (no blank template)", () => {
    expect(autoDraftAtMerge([])).toBeNull();
  });

  it("drafts ONE paragraph from the newest decision, needing confirmation", () => {
    const older = record({ id: "a", body: "older choice", recorded_at_ms: 1 });
    const newer = record({ id: "b", body: "newest choice", recorded_at_ms: 2 });
    const draft = autoDraftAtMerge([older, newer]);
    expect(draft).not.toBeNull();
    expect(draft?.id).toBe("b");
    expect(draft?.summary).toBe("newest choice");
    expect(draft?.needs_confirmation).toBe(true);
  });

  it("returns null when the newest record has empty prose (never a blank form)", () => {
    expect(
      autoDraftAtMerge([record({ body: "   ", recorded_at_ms: 5 })])
    ).toBeNull();
  });
});
