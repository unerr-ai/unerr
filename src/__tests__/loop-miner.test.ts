/**
 * ST-3a: Loop miner — file rereads + repeated search_code queries.
 */

import { describe, expect, it } from "vitest";
import {
  detectFileReadLoops,
  detectLoops,
  detectQueryLoops,
} from "../timeline/loop-miner.js";
import type { LedgerEntry } from "../tracking/shadow-ledger.js";

let idCounter = 0;
function entry(
  overrides: Partial<LedgerEntry> & {
    tool: string;
    ts: string;
    session_id?: string;
  },
): LedgerEntry {
  idCounter += 1;
  return {
    id: `e${idCounter}`,
    ts: overrides.ts,
    tool: overrides.tool,
    args_summary: overrides.args_summary ?? {},
    result_summary: overrides.result_summary ?? {},
    branch: "main",
    head_sha: "abc",
    session_id: overrides.session_id ?? "s1",
    correlation_id: overrides.correlation_id ?? null,
  };
}

const t = (offsetSec: number) =>
  new Date(Date.parse("2026-05-12T10:00:00Z") + offsetSec * 1000).toISOString();

describe("detectFileReadLoops", () => {
  it("flags ≥5 reads of the same file with no edit in between", () => {
    const entries: LedgerEntry[] = [
      entry({ tool: "file_read", args_summary: { file_path: "auth.ts" }, ts: t(0) }),
      entry({ tool: "file_read", args_summary: { file_path: "auth.ts" }, ts: t(10) }),
      entry({ tool: "file_read", args_summary: { file_path: "auth.ts" }, ts: t(30) }),
      entry({ tool: "file_read", args_summary: { file_path: "auth.ts" }, ts: t(60) }),
      entry({ tool: "file_read", args_summary: { file_path: "auth.ts" }, ts: t(90) }),
    ];
    const loops = detectFileReadLoops(entries);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({
      kind: "file_reread",
      file_path: "auth.ts",
      count: 5,
      session_id: "s1",
    });
  });

  it("an edit between reads resets the run", () => {
    const entries: LedgerEntry[] = [
      entry({ tool: "file_read", args_summary: { file_path: "a.ts" }, ts: t(0) }),
      entry({ tool: "file_read", args_summary: { file_path: "a.ts" }, ts: t(10) }),
      entry({ tool: "Edit", args_summary: { file_path: "a.ts" }, ts: t(20) }),
      entry({ tool: "file_read", args_summary: { file_path: "a.ts" }, ts: t(30) }),
      entry({ tool: "file_read", args_summary: { file_path: "a.ts" }, ts: t(40) }),
    ];
    expect(detectFileReadLoops(entries)).toEqual([]);
  });

  it("isolates loops per session", () => {
    const entries: LedgerEntry[] = [];
    for (let i = 0; i < 5; i++) {
      entries.push(
        entry({
          tool: "file_read",
          args_summary: { file_path: "a.ts" },
          ts: t(i * 10),
          session_id: "s1",
        }),
      );
      entries.push(
        entry({
          tool: "file_read",
          args_summary: { file_path: "a.ts" },
          ts: t(i * 10 + 1),
          session_id: "s2",
        }),
      );
    }
    const loops = detectFileReadLoops(entries);
    const sessions = new Set(loops.map((l) => l.session_id));
    expect(sessions).toEqual(new Set(["s1", "s2"]));
    expect(loops).toHaveLength(2);
  });

  it("ignores entries outside the time window", () => {
    const entries: LedgerEntry[] = [];
    for (let i = 0; i < 5; i++) {
      entries.push(
        entry({
          tool: "file_read",
          args_summary: { file_path: "a.ts" },
          ts: t(i * 10),
        }),
      );
    }
    // Force "now" to be far in the future
    const loops = detectFileReadLoops(entries, {
      nowMs: Date.parse(t(0)) + 30 * 60_000, // 30 min after
      readWindowMs: 60_000, // 1 min window
    });
    expect(loops).toEqual([]);
  });

  it("does not flag under the threshold", () => {
    const entries: LedgerEntry[] = [
      entry({ tool: "file_read", args_summary: { file_path: "a.ts" }, ts: t(0) }),
      entry({ tool: "file_read", args_summary: { file_path: "a.ts" }, ts: t(10) }),
      entry({ tool: "file_read", args_summary: { file_path: "a.ts" }, ts: t(20) }),
    ];
    expect(detectFileReadLoops(entries)).toEqual([]);
  });
});

describe("detectQueryLoops", () => {
  it("flags ≥3 same search_code queries", () => {
    const entries: LedgerEntry[] = [
      entry({ tool: "search_code", args_summary: { query: "validateToken" }, ts: t(0) }),
      entry({ tool: "search_code", args_summary: { query: "validateToken" }, ts: t(120) }),
      entry({ tool: "search_code", args_summary: { query: "validateToken" }, ts: t(300) }),
    ];
    const loops = detectQueryLoops(entries);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({
      kind: "search_repeat",
      query: "validateToken",
      count: 3,
    });
  });

  it("different queries don't merge", () => {
    const entries: LedgerEntry[] = [
      entry({ tool: "search_code", args_summary: { query: "a" }, ts: t(0) }),
      entry({ tool: "search_code", args_summary: { query: "b" }, ts: t(10) }),
      entry({ tool: "search_code", args_summary: { query: "a" }, ts: t(20) }),
      entry({ tool: "search_code", args_summary: { query: "b" }, ts: t(30) }),
    ];
    expect(detectQueryLoops(entries)).toEqual([]);
  });

  it("non-search_code entries are ignored", () => {
    const entries: LedgerEntry[] = [
      entry({ tool: "file_read", args_summary: { query: "foo" }, ts: t(0) }),
      entry({ tool: "file_read", args_summary: { query: "foo" }, ts: t(10) }),
      entry({ tool: "file_read", args_summary: { query: "foo" }, ts: t(20) }),
    ];
    expect(detectQueryLoops(entries)).toEqual([]);
  });
});

describe("detectLoops (union)", () => {
  it("returns both detections sorted by last_ts desc", () => {
    const entries: LedgerEntry[] = [
      entry({ tool: "file_read", args_summary: { file_path: "a.ts" }, ts: t(0) }),
      entry({ tool: "file_read", args_summary: { file_path: "a.ts" }, ts: t(10) }),
      entry({ tool: "file_read", args_summary: { file_path: "a.ts" }, ts: t(20) }),
      entry({ tool: "file_read", args_summary: { file_path: "a.ts" }, ts: t(30) }),
      entry({ tool: "file_read", args_summary: { file_path: "a.ts" }, ts: t(40) }),
      entry({ tool: "search_code", args_summary: { query: "X" }, ts: t(100) }),
      entry({ tool: "search_code", args_summary: { query: "X" }, ts: t(200) }),
      entry({ tool: "search_code", args_summary: { query: "X" }, ts: t(300) }),
    ];
    const loops = detectLoops(entries);
    expect(loops).toHaveLength(2);
    expect(loops[0]?.kind).toBe("search_repeat");
    expect(loops[1]?.kind).toBe("file_reread");
  });
});
