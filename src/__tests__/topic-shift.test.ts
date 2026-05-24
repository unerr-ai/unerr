import { describe, expect, it } from "vitest";
import {
  TOPIC_SHIFT_DEFAULT_THRESHOLD,
  TOPIC_SHIFT_DEFAULT_WINDOW,
  detectTopicShift,
  jaccardOverlap,
} from "../intelligence/topic-shift.js";

describe("jaccardOverlap (C6)", () => {
  it("returns 0 when either side is empty", () => {
    expect(jaccardOverlap([], ["a"])).toBe(0);
    expect(jaccardOverlap(["a"], [])).toBe(0);
    expect(jaccardOverlap([], [])).toBe(0);
  });

  it("returns 1 when sets are identical", () => {
    expect(jaccardOverlap(["a", "b"], ["a", "b"])).toBe(1);
  });

  it("returns 0 when sets are disjoint", () => {
    expect(jaccardOverlap(["a"], ["b"])).toBe(0);
  });

  it("dedupes within each side before computing", () => {
    // {a,b} vs {a,c} → inter=1 union=3 → 1/3
    expect(jaccardOverlap(["a", "a", "b"], ["a", "c", "c"])).toBeCloseTo(
      1 / 3,
      5
    );
  });
});

describe("detectTopicShift (C6)", () => {
  it("no_current_anchors → no shift", () => {
    const r = detectTopicShift({
      current_anchors: [],
      recent_anchors_by_turn: [["f:src/a.ts"]],
    });
    expect(r.topic_shift).toBe(false);
    expect(r.reason).toBe("no_current_anchors");
  });

  it("no_recent_history → no shift (cold start)", () => {
    const r = detectTopicShift({
      current_anchors: ["f:src/a.ts"],
      recent_anchors_by_turn: [],
    });
    expect(r.topic_shift).toBe(false);
    expect(r.reason).toBe("no_recent_history");
  });

  it("high overlap → no shift", () => {
    const r = detectTopicShift({
      current_anchors: ["f:src/a.ts", "f:src/b.ts"],
      recent_anchors_by_turn: [["f:src/a.ts"], ["f:src/b.ts"], ["f:src/a.ts"]],
    });
    expect(r.topic_shift).toBe(false);
    expect(r.reason).toBe("overlap_above_threshold");
    expect(r.overlap).toBe(1);
  });

  it("low overlap (disjoint anchors) → shift", () => {
    const r = detectTopicShift({
      current_anchors: ["f:src/auth/login.ts"],
      recent_anchors_by_turn: [
        ["f:src/render/list.tsx"],
        ["f:src/render/item.tsx"],
        ["f:src/render/grid.tsx"],
      ],
    });
    expect(r.topic_shift).toBe(true);
    expect(r.reason).toBe("shift_below_threshold");
    expect(r.overlap).toBe(0);
  });

  it("only considers the trailing window of turns", () => {
    // 12 turns of foo, then current anchor 'bar'. Window=2 — only last 2 turns
    // (foo, foo) count → no overlap with bar → shift.
    const recent = Array.from({ length: 12 }, () => ["foo"]);
    const r = detectTopicShift({
      current_anchors: ["bar"],
      recent_anchors_by_turn: recent,
      window: 2,
    });
    expect(r.topic_shift).toBe(true);
  });

  it("respects custom threshold", () => {
    // overlap = 1/3 ≈ 0.33. With threshold 0.5, that's a shift.
    const r = detectTopicShift({
      current_anchors: ["a", "b"],
      recent_anchors_by_turn: [["a", "c"]],
      threshold: 0.5,
    });
    expect(r.topic_shift).toBe(true);
    expect(r.overlap).toBeCloseTo(1 / 3, 5);
  });

  it("defaults are documented and unchanged", () => {
    expect(TOPIC_SHIFT_DEFAULT_WINDOW).toBe(10);
    expect(TOPIC_SHIFT_DEFAULT_THRESHOLD).toBe(0.2);
  });
});
