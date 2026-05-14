/**
 * ST-3a: Open threads — mark_blocker entries without a matching mark_resolution.
 */

import { describe, expect, it } from "vitest";
import { computeOpenThreads } from "../timeline/open-threads.js";
import type { MarkerRow } from "../timeline/timeline-store.js";

function blocker(id: string, text: string, ts = 0): MarkerRow {
  return {
    marker_id: id,
    type: "mark_blocker",
    text,
    session_id: "s1",
    turn_id: "t1",
    ts,
    blocker_ref: "",
    file_path: "",
  };
}

function resolution(refId: string, ts = 0): MarkerRow {
  return {
    marker_id: `res-${refId}`,
    type: "mark_resolution",
    text: `resolved ${refId}`,
    session_id: "s1",
    turn_id: "t1",
    ts,
    blocker_ref: refId,
    file_path: "",
  };
}

describe("computeOpenThreads", () => {
  it("returns all blockers when no resolutions exist", () => {
    const open = computeOpenThreads([
      blocker("b1", "type error", 100),
      blocker("b2", "auth flow stuck", 200),
    ]);
    expect(open.map((t) => t.marker_id)).toEqual(["b2", "b1"]); // newest first
  });

  it("filters out blockers with a matching resolution", () => {
    const open = computeOpenThreads([
      blocker("b1", "type error", 100),
      blocker("b2", "auth flow stuck", 200),
      resolution("b1", 150),
    ]);
    expect(open).toHaveLength(1);
    expect(open[0]?.marker_id).toBe("b2");
  });

  it("returns empty when all blockers resolved", () => {
    const open = computeOpenThreads([
      blocker("b1", "x", 100),
      blocker("b2", "y", 200),
      resolution("b1", 300),
      resolution("b2", 400),
    ]);
    expect(open).toEqual([]);
  });

  it("ignores non-blocker / non-resolution markers", () => {
    const open = computeOpenThreads([
      {
        marker_id: "i1",
        type: "mark_intent",
        text: "refactor",
        session_id: "s1",
        turn_id: "t1",
        ts: 50,
        blocker_ref: "",
        file_path: "",
      },
      blocker("b1", "stuck", 100),
    ]);
    expect(open).toHaveLength(1);
    expect(open[0]?.marker_id).toBe("b1");
  });

  it("a resolution without blocker_ref does not silence any blocker", () => {
    const open = computeOpenThreads([
      blocker("b1", "x", 100),
      {
        marker_id: "r1",
        type: "mark_resolution",
        text: "?",
        session_id: "s1",
        turn_id: "t1",
        ts: 200,
        blocker_ref: "",
        file_path: "",
      },
    ]);
    expect(open).toHaveLength(1);
  });
});
