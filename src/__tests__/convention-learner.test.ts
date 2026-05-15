import { describe, expect, it } from "vitest";
import { learnConventions } from "../intelligence/convention-learner.js";

describe("learnConventions", () => {
  it("detects co-change patterns from repeated file pairs", () => {
    const entries = Array.from({ length: 4 }, (_, i) => ({
      id: `e${i}`,
      ts: new Date(Date.now() - (4 - i) * 60000).toISOString(),
      tool: "sync_local_diff",
      args_summary: { files: ["src/auth.ts", "src/auth.test.ts"] },
      result_summary: {},
    }));

    const conventions = learnConventions(entries);
    const coChange = conventions.find((c) => c.pattern === "co-change");
    expect(coChange).toBeDefined();
    expect(coChange?.observationCount).toBeGreaterThanOrEqual(3);
  });

  it("returns empty for insufficient data", () => {
    const entries = [
      {
        id: "e1",
        ts: "2026-04-30T10:00:00Z",
        tool: "sync_local_diff",
        args_summary: { files: ["a.ts"] },
        result_summary: {},
      },
    ];
    const conventions = learnConventions(entries);
    expect(conventions.filter((c) => c.pattern === "co-change")).toHaveLength(
      0
    );
  });

  it("returns empty for non-sync entries", () => {
    const entries = [
      {
        id: "e1",
        ts: "2026-04-30T10:00:00Z",
        tool: "get_function",
        args_summary: { key: "a" },
        result_summary: {},
      },
      {
        id: "e2",
        ts: "2026-04-30T10:01:00Z",
        tool: "get_callers",
        args_summary: { key: "b" },
        result_summary: {},
      },
    ];
    expect(learnConventions(entries)).toHaveLength(0);
  });

  it("detects rename patterns from content changes", () => {
    const entries = [
      {
        id: "e1",
        ts: "2026-04-30T10:00:00Z",
        tool: "sync_local_diff",
        args_summary: {
          files: [
            {
              path: "src/api.ts",
              content: "export function getData() { return fetch('/api'); }",
            },
          ],
        },
        result_summary: {},
      },
      {
        id: "e2",
        ts: "2026-04-30T10:01:00Z",
        tool: "sync_local_diff",
        args_summary: {
          files: [
            {
              path: "src/api.ts",
              content: "export function fetchData() { return fetch('/api'); }",
            },
          ],
        },
        result_summary: {},
      },
    ];

    const conventions = learnConventions(entries);
    const rename = conventions.find((c) => c.name.startsWith("Naming:"));
    if (rename) {
      expect(rename.pattern).toContain("fetch");
    }
  });
});
