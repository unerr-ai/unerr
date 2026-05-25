import { describe, expect, it } from "vitest";
import { resolveAnchorTurn } from "../ui/lib/timeline-filters.js";

// The integer-turn → hex-turn_id bridge (logbook-page-redesign §4.2): a
// Logbook turn chip deep-links with `?anchor_ts=<utc-ms>` and the Activity
// page resolves it to the activity moment (turn) that was live then, by
// timestamp containment over the loaded turns.

const turns = [
  { turn_id: "aaa", started_at: 1_000, ended_at: 2_000 },
  { turn_id: "bbb", started_at: 2_500, ended_at: 3_500 },
  { turn_id: "ccc", started_at: 4_000, ended_at: 5_000 },
];

describe("resolveAnchorTurn", () => {
  it("returns the turn whose [started_at, ended_at] contains the ts", () => {
    expect(resolveAnchorTurn(turns, 1_500)).toBe("aaa");
    expect(resolveAnchorTurn(turns, 3_000)).toBe("bbb");
    expect(resolveAnchorTurn(turns, 4_200)).toBe("ccc");
  });

  it("matches inclusive boundaries (start and end)", () => {
    expect(resolveAnchorTurn(turns, 1_000)).toBe("aaa");
    expect(resolveAnchorTurn(turns, 2_000)).toBe("aaa");
    expect(resolveAnchorTurn(turns, 5_000)).toBe("ccc");
  });

  it("falls back to the latest moment already begun when in a gap", () => {
    // 2_200 is between aaa.ended_at (2_000) and bbb.started_at (2_500):
    // no containment, so the latest turn begun by then is aaa.
    expect(resolveAnchorTurn(turns, 2_200)).toBe("aaa");
    // 3_800 is after bbb ended, before ccc started → bbb.
    expect(resolveAnchorTurn(turns, 3_800)).toBe("bbb");
    // After everything → the last turn.
    expect(resolveAnchorTurn(turns, 9_000)).toBe("ccc");
  });

  it("returns null before any moment began", () => {
    expect(resolveAnchorTurn(turns, 500)).toBeNull();
  });

  it("returns null for invalid input or empty turn list", () => {
    expect(resolveAnchorTurn(turns, Number.NaN)).toBeNull();
    expect(resolveAnchorTurn(turns, Number.POSITIVE_INFINITY)).toBeNull();
    expect(resolveAnchorTurn([], 1_500)).toBeNull();
  });
});
