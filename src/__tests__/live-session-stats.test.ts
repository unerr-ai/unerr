/**
 * Live session sidecars — mid-session `unerr stats` (regression 6f).
 *
 * `accumulateSession` only runs at proxy shutdown, so a long-lived session
 * contributed nothing to ~/.unerr/stats.json and `unerr stats` printed
 * "No sessions recorded yet" while dozens of tool calls were live. The proxy
 * now writes a per-session sidecar (~/.unerr/stats-live/<sessionId>.json)
 * every stats tick; the reader merges fresh sidecars at display time.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type LiveSessionSnapshot,
  type UnifiedStats,
  clearLiveSessionSnapshot,
  loadLiveSessions,
  loadStats,
  mergeLiveSessions,
  writeLiveSessionSnapshot,
} from "../tracking/weekly-accumulator.js";

function snap(
  overrides: Partial<LiveSessionSnapshot> = {}
): LiveSessionSnapshot {
  return {
    sessionId: "sess-live-1",
    tokensSaved: 1200,
    toolCalls: 34,
    violationsCaught: 2,
    efficiency: 80,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("live session sidecars", () => {
  let fakeHome: string;
  let savedHome: string | undefined;
  let savedProfile: string | undefined;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "unerr-live-stats-"));
    savedHome = process.env.HOME;
    savedProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  });

  afterEach(() => {
    // Variable key (not a static `delete process.env.HOME`) satisfies biome's
    // noDelete + useLiteralKeys while still removing the key when it was unset.
    for (const [key, saved] of [
      ["HOME", savedHome],
      ["USERPROFILE", savedProfile],
    ] as const) {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("write → load round-trips a fresh snapshot", () => {
    writeLiveSessionSnapshot(snap());
    const live = loadLiveSessions();
    expect(live).toHaveLength(1);
    expect(live[0]!.sessionId).toBe("sess-live-1");
    expect(live[0]!.tokensSaved).toBe(1200);
    expect(live[0]!.toolCalls).toBe(34);
  });

  it("re-writing the same session replaces, not appends", () => {
    writeLiveSessionSnapshot(snap({ toolCalls: 10 }));
    writeLiveSessionSnapshot(snap({ toolCalls: 50 }));
    const live = loadLiveSessions();
    expect(live).toHaveLength(1);
    expect(live[0]!.toolCalls).toBe(50);
  });

  it("clearLiveSessionSnapshot removes the sidecar (shutdown handoff)", () => {
    writeLiveSessionSnapshot(snap());
    clearLiveSessionSnapshot("sess-live-1");
    expect(loadLiveSessions()).toHaveLength(0);
    // Clearing a never-written id must not throw
    clearLiveSessionSnapshot("no-such-session");
  });

  it("ignores and sweeps stale sidecars (crashed sessions)", () => {
    const staleTs = new Date(Date.now() - 60 * 60_000).toISOString();
    writeLiveSessionSnapshot(
      snap({ sessionId: "sess-stale", updatedAt: staleTs })
    );
    writeLiveSessionSnapshot(snap({ sessionId: "sess-fresh" }));

    const live = loadLiveSessions();
    expect(live).toHaveLength(1);
    expect(live[0]!.sessionId).toBe("sess-fresh");
    // Stale file was swept from disk
    const files = readdirSync(join(fakeHome, ".unerr", "stats-live"));
    expect(files).not.toContain("sess-stale.json");
  });

  it("returns [] when the sidecar dir does not exist", () => {
    expect(loadLiveSessions()).toEqual([]);
  });

  it("mergeLiveSessions folds live numbers into a display copy without mutating", () => {
    const persisted: UnifiedStats = loadStats(); // empty (fake HOME)
    const before = JSON.stringify(persisted);

    const merged = mergeLiveSessions(persisted, [snap()]);
    expect(merged.weekly.sessions).toBe(persisted.weekly.sessions + 1);
    expect(merged.weekly.tokensSaved).toBe(persisted.weekly.tokensSaved + 1200);
    expect(merged.weekly.toolCalls).toBe(persisted.weekly.toolCalls + 34);
    expect(merged.allTime.totalSessions).toBe(
      persisted.allTime.totalSessions + 1
    );
    expect(merged.allTime.totalTokensSaved).toBe(
      persisted.allTime.totalTokensSaved + 1200
    );
    // Source object untouched (display-only merge, never persisted)
    expect(JSON.stringify(persisted)).toBe(before);
  });

  it("mergeLiveSessions with no live sessions returns the input unchanged", () => {
    const persisted = loadStats();
    expect(mergeLiveSessions(persisted, [])).toBe(persisted);
  });
});
