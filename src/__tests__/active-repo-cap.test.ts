/**
 * `lastActiveRepo` — the pure MRU-selection helper in warm-start.ts. It used
 * to back the free-tier single-active autostart restriction, which is gone
 * now that the repo limit is unlimited on every plan (no unerr-operated
 * server sits in that data path). The helper itself is still a generic
 * "most recently active repo" utility, so it stays covered directly.
 */

import { describe, expect, it } from "vitest";
import type { RepoEntry } from "../daemon/protocol.js";
import { lastActiveRepo } from "../daemon/warm-start.js";

function entry(path: string, lastActivity: string | null): RepoEntry {
  return {
    path,
    addedAt: "2026-01-01T00:00:00.000Z",
    lastStarted: null,
    lastActivity,
    idleTimeout: 1800,
    label: path.split("/").pop() ?? path,
    settings: {},
  };
}

describe("lastActiveRepo", () => {
  it("picks max(lastActivity ?? lastStarted ?? addedAt)", () => {
    const repos = [
      entry("/r/old", "2026-01-02T00:00:00.000Z"),
      entry("/r/newest", "2026-06-01T00:00:00.000Z"),
      entry("/r/mid", "2026-03-01T00:00:00.000Z"),
    ];
    expect(lastActiveRepo(repos)?.path).toBe("/r/newest");
    expect(lastActiveRepo([])).toBeNull();
  });
});
