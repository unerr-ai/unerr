/**
 * Warm-restart session-id continuity — the merge-vs-fresh decision.
 *
 * A proxy restart mid-conversation (dev rebuild+restart, crash, idle bounce)
 * must CONTINUE under the previous session id so the prompt boundary and the
 * turn's tool events stay under one id and per-turn savings attribute
 * correctly. A genuinely new conversation (started after a long gap) must get
 * a fresh id so two conversations don't merge into one receipt.
 */

import { describe, expect, it } from "vitest";
import {
  type PreviousSessionSnapshot,
  SESSION_RESUME_ID_WINDOW_MS,
  resolveResumableSessionId,
} from "../proxy/session-stats.js";

function snap(
  partial: Partial<PreviousSessionSnapshot> = {}
): PreviousSessionSnapshot {
  return {
    toolCallsLocal: 5,
    violationsCaught: 0,
    sessionStartedAt: "2026-05-25T20:00:00.000Z",
    endedAt: "2026-05-25T20:10:00.000Z",
    durationMinutes: 10,
    sessionId: "abc123def456",
    ...partial,
  };
}

describe("resolveResumableSessionId", () => {
  const now = Date.parse("2026-05-25T20:10:00.000Z");

  it("returns null when there is no previous session", () => {
    expect(resolveResumableSessionId(null, now)).toBeNull();
  });

  it("returns null when the previous snapshot carries no session id", () => {
    expect(
      resolveResumableSessionId(snap({ sessionId: undefined }), now)
    ).toBeNull();
  });

  it("reuses the id when the previous session ended within the window", () => {
    // Ended 2 minutes ago — well inside the window.
    const recent = snap({ endedAt: new Date(now - 2 * 60_000).toISOString() });
    expect(resolveResumableSessionId(recent, now)).toBe("abc123def456");
  });

  it("reuses the id right at the window boundary", () => {
    const atEdge = snap({
      endedAt: new Date(now - SESSION_RESUME_ID_WINDOW_MS).toISOString(),
    });
    expect(resolveResumableSessionId(atEdge, now)).toBe("abc123def456");
  });

  it("mints fresh (null) when the gap exceeds the window — new conversation", () => {
    const stale = snap({
      endedAt: new Date(
        now - SESSION_RESUME_ID_WINDOW_MS - 1_000
      ).toISOString(),
    });
    expect(resolveResumableSessionId(stale, now)).toBeNull();
  });

  it("returns null on an unparseable endedAt rather than throwing", () => {
    expect(
      resolveResumableSessionId(snap({ endedAt: "not-a-date" }), now)
    ).toBeNull();
  });
});
