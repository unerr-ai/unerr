import { describe, expect, it } from "vitest";
import { generateSessionResume } from "../proxy/session-resume.js";

const MOCK_ENTRIES = [
  {
    id: "e1",
    ts: "2026-04-30T10:00:00Z",
    tool: "get_function",
    args_summary: { key: "src/auth.ts::login" },
    result_summary: {},
    session_id: "s1",
    branch: "main",
    head_sha: "aaa",
  },
  {
    id: "e2",
    ts: "2026-04-30T10:01:00Z",
    tool: "sync_local_diff",
    args_summary: { files: ["src/auth.ts", "src/utils/token.ts"] },
    result_summary: {},
    session_id: "s1",
    branch: "main",
    head_sha: "bbb",
  },
  {
    id: "e3",
    ts: "2026-04-30T10:05:00Z",
    tool: "check_rules",
    args_summary: { key: "src/auth.ts" },
    result_summary: {},
    session_id: "s1",
    branch: "main",
    head_sha: "ccc",
  },
  {
    id: "e4",
    ts: "2026-04-30T10:10:00Z",
    tool: "get_callers",
    args_summary: { key: "src/auth.ts::login" },
    result_summary: {},
    session_id: "s1",
    branch: "main",
    head_sha: "ddd",
  },
  {
    id: "e5",
    ts: "2026-04-30T10:15:00Z",
    tool: "sync_local_diff",
    args_summary: { files: ["src/auth.ts"] },
    result_summary: { commit_sha: "fff" },
    session_id: "s1",
    branch: "feature/auth",
    head_sha: "eee",
  },
];

describe("generateSessionResume", () => {
  it("generates resume from shadow ledger entries", () => {
    const result = generateSessionResume(MOCK_ENTRIES);
    expect(result).not.toBeNull();
    expect(result?.summary).toContain("tool calls");
    expect(result?.filesModified).toContain("src/auth.ts");
    expect(result?.toolsUsed.sync_local_diff).toBe(2);
    expect(result?.toolsUsed.get_function).toBe(1);
  });

  it("detects last branch", () => {
    const result = generateSessionResume(MOCK_ENTRIES);
    expect(result?.lastBranch).toBe("feature/auth");
  });

  it("calculates session duration", () => {
    const result = generateSessionResume(MOCK_ENTRIES);
    expect(result?.sessionDurationMs).toBe(15 * 60 * 1000);
  });

  it("tracks incomplete entities (modified but not committed)", () => {
    const noCommitEntries = MOCK_ENTRIES.slice(0, 4);
    const result = generateSessionResume(noCommitEntries);
    expect(result?.incompleteEntities.length).toBeGreaterThan(0);
    expect(result?.incompleteEntities).toContain("src/auth.ts");
  });

  it("returns null for empty entries", () => {
    expect(generateSessionResume([])).toBeNull();
  });

  it("limits file list in summary", () => {
    const manyFiles = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
    const entries = [
      {
        id: "e1",
        ts: "2026-04-30T10:00:00Z",
        tool: "sync_local_diff",
        args_summary: { files: manyFiles },
        result_summary: {},
        session_id: "s1",
      },
    ];
    const result = generateSessionResume(entries);
    expect(result?.summary).toContain("+");
    expect(result?.filesModified.length).toBe(20);
  });
});
