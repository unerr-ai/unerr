import { describe, expect, it } from "vitest";
import {
  parseBatchCallIntent,
  parseBulkEditIntent,
} from "../intelligence/delegation.js";
import type { BehaviorEventInput } from "../tracking/behavior-events.js";
import {
  emitBatchCallSavings,
  emitBulkEditSavings,
} from "../tracking/savings-events.js";

describe("parseBulkEditIntent (Issue 4a)", () => {
  it("parses a one-shot bulk edit with a file count", () => {
    expect(
      parseBulkEditIntent("bulk-edit oneshot 12: prettier --write")
    ).toEqual({ mode: "oneshot", files: 12 });
  });

  it("parses a cheap-loop bulk edit", () => {
    expect(
      parseBulkEditIntent("bulk-edit cheap-loop 8: per-file docstring sweep")
    ).toEqual({ mode: "cheap_loop", files: 8 });
  });

  it("defaults to oneshot when no mode word is present", () => {
    expect(parseBulkEditIntent("bulk-edit 5: codemod the imports")).toEqual({
      mode: "oneshot",
      files: 5,
    });
  });

  it("tolerates a missing count", () => {
    expect(parseBulkEditIntent("bulk edit oneshot: format all")).toEqual({
      mode: "oneshot",
      files: 0,
    });
  });

  it("returns null for a non-bulk-edit intent", () => {
    expect(
      parseBulkEditIntent("delegate tests sweep: add coverage")
    ).toBeNull();
    expect(parseBulkEditIntent("fix the boot path")).toBeNull();
    expect(parseBulkEditIntent("")).toBeNull();
  });
});

describe("parseBatchCallIntent (Issue 4b)", () => {
  it("parses N targets in one call", () => {
    expect(
      parseBatchCallIntent("batch-call 5: read 5 entities at once")
    ).toEqual({ targets: 5 });
  });

  it("returns null when fewer than 2 targets (no saving)", () => {
    expect(parseBatchCallIntent("batch-call 1: one read")).toBeNull();
  });

  it("returns null for a non-batch-call intent", () => {
    expect(parseBatchCallIntent("bulk-edit oneshot 3: x")).toBeNull();
    expect(parseBatchCallIntent("")).toBeNull();
  });
});

describe("emitBulkEditSavings / emitBatchCallSavings → behavior_event row", () => {
  function capture(): {
    sink: { record: (i: BehaviorEventInput) => void };
    rows: BehaviorEventInput[];
  } {
    const rows: BehaviorEventInput[] = [];
    return { sink: { record: (i) => rows.push(i) }, rows };
  }

  it("emits bulk_edit_oneshot with files_saved", () => {
    const { sink, rows } = capture();
    expect(
      emitBulkEditSavings(sink, {
        session_id: "s1",
        mode: "oneshot",
        files: 12,
      })
    ).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({
      kind: "bulk_edit_oneshot",
      category: "savings",
      files_saved: 12,
    });
  });

  it("emits bulk_edit_cheap_loop", () => {
    const { sink, rows } = capture();
    emitBulkEditSavings(sink, {
      session_id: "s1",
      mode: "cheap_loop",
      files: 0,
    });
    expect(rows[0]?.detail).toMatchObject({ kind: "bulk_edit_cheap_loop" });
    // files=0 ⇒ no files_saved key
    expect(rows[0]?.detail).not.toHaveProperty("files_saved");
  });

  it("emits batch_call_saved_roundtrips with N-1 round-trips saved", () => {
    const { sink, rows } = capture();
    emitBatchCallSavings(sink, { session_id: "s1", targets: 5 });
    expect(rows[0]?.detail).toMatchObject({
      kind: "batch_call_saved_roundtrips",
      category: "savings",
      roundtrips_saved: 4,
    });
  });

  it("is a silent no-op on a null sink", () => {
    expect(
      emitBulkEditSavings(null, { session_id: "s1", mode: "oneshot", files: 1 })
    ).toBe(false);
    expect(emitBatchCallSavings(null, { session_id: "s1", targets: 3 })).toBe(
      false
    );
  });
});
