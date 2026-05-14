import { describe, expect, it } from "vitest";
import {
  detectAntiPatterns,
  detectInstableEntities,
} from "../intelligence/negative-knowledge.js";

describe("detectAntiPatterns", () => {
  it("detects modified-then-reverted pattern", () => {
    const entries = [
      {
        id: "target",
        ts: "2026-04-30T10:00:00Z",
        tool: "sync_local_diff",
        args_summary: { files: ["src/ok.ts"] },
        result_summary: {},
      },
      {
        id: "bad1",
        ts: "2026-04-30T10:01:00Z",
        tool: "sync_local_diff",
        args_summary: { files: ["src/bad.ts"] },
        result_summary: {},
      },
      {
        id: "bad2",
        ts: "2026-04-30T10:02:00Z",
        tool: "sync_local_diff",
        args_summary: { files: ["src/worse.ts"] },
        result_summary: {},
      },
      {
        id: "rewind",
        ts: "2026-04-30T10:05:00Z",
        tool: "revert_to_working_state",
        args_summary: {},
        result_summary: { rewind_target_id: "target" },
      },
    ];

    const corrections = detectAntiPatterns(entries, "rewind");
    expect(corrections.length).toBe(2);
    expect(corrections[0]?.entityKey).toBe("src/bad.ts");
    expect(corrections[0]?.pattern).toBe("modified-then-reverted");
    expect(corrections[1]?.entityKey).toBe("src/worse.ts");
  });

  it("returns empty when rewind not found", () => {
    const entries = [
      {
        id: "e1",
        ts: "2026-04-30T10:00:00Z",
        tool: "sync_local_diff",
        args_summary: { files: ["a.ts"] },
        result_summary: {},
      },
    ];
    expect(detectAntiPatterns(entries, "nonexistent")).toEqual([]);
  });

  it("returns empty when no target entry found", () => {
    const entries = [
      {
        id: "rewind",
        ts: "2026-04-30T10:00:00Z",
        tool: "revert_to_working_state",
        args_summary: {},
        result_summary: { rewind_target_id: "missing" },
      },
    ];
    expect(detectAntiPatterns(entries, "rewind")).toEqual([]);
  });
});

describe("detectInstableEntities", () => {
  it("detects entities modified 3+ times rapidly", () => {
    const now = Date.now();
    const entries = [
      {
        id: "e1",
        ts: new Date(now - 5 * 60000).toISOString(),
        tool: "sync_local_diff",
        args_summary: { files: ["src/flaky.ts"] },
        result_summary: {},
      },
      {
        id: "e2",
        ts: new Date(now - 3 * 60000).toISOString(),
        tool: "sync_local_diff",
        args_summary: { files: ["src/flaky.ts"] },
        result_summary: {},
      },
      {
        id: "e3",
        ts: new Date(now - 1 * 60000).toISOString(),
        tool: "sync_local_diff",
        args_summary: { files: ["src/flaky.ts"] },
        result_summary: {},
      },
    ];

    const corrections = detectInstableEntities(entries);
    expect(corrections.length).toBe(1);
    expect(corrections[0]?.entityKey).toBe("src/flaky.ts");
    expect(corrections[0]?.pattern).toBe("rapid-modification");
  });

  it("ignores stable entities", () => {
    const entries = [
      {
        id: "e1",
        ts: "2026-04-01T10:00:00Z",
        tool: "sync_local_diff",
        args_summary: { files: ["src/stable.ts"] },
        result_summary: {},
      },
      {
        id: "e2",
        ts: "2026-04-15T10:00:00Z",
        tool: "sync_local_diff",
        args_summary: { files: ["src/stable.ts"] },
        result_summary: {},
      },
    ];
    expect(detectInstableEntities(entries)).toEqual([]);
  });
});
