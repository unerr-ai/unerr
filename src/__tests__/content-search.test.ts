import { describe, expect, it } from "vitest";
import {
  escapeRegExp,
  scanFilesForPattern,
} from "../intelligence/content-search.js";

const FILES = [
  {
    path: "src/a.ts",
    content: ["const retryCount = 3;", "function retry() {}", "// done"].join(
      "\n"
    ),
  },
  {
    path: "src/b.ts",
    content: ["export const X = 1;", "const y = retry();"].join("\n"),
  },
];

const BASE = {
  limit: 30,
  contextLines: 1,
  maxTotalBytes: 12_000,
  maxPerFile: 20,
} as const;

describe("scanFilesForPattern (Issue 2 content search)", () => {
  it("literal mode finds an exact substring across files with bounded context", () => {
    const r = scanFilesForPattern(FILES, {
      ...BASE,
      mode: "literal",
      query: "retry",
    });
    expect(r.match_count).toBe(3); // a.ts:1, a.ts:2, b.ts:2
    expect(r.files_scanned).toBe(2);
    const first = r.matches[0];
    expect(first).toBeDefined();
    expect(first).toMatchObject({ file_path: "src/a.ts", line: 1 });
    // context slice carries ± contextLines around the hit, not the whole file.
    expect(first?.context).toContain("retryCount");
    expect(first?.context).toContain("function retry");
    expect(r.truncated).toBe(false);
  });

  it("literal mode treats regex metacharacters as plain text", () => {
    const files = [{ path: "f.ts", content: "a.b = c;\naxb = d;" }];
    const r = scanFilesForPattern(files, {
      ...BASE,
      mode: "literal",
      query: "a.b",
    });
    // Only the literal 'a.b' line matches; 'axb' would match if '.' were a wildcard.
    expect(r.match_count).toBe(1);
    expect(r.matches[0]?.line).toBe(1);
  });

  it("regex mode honors the pattern", () => {
    const files = [{ path: "f.ts", content: "a.b = c;\naxb = d;" }];
    const r = scanFilesForPattern(files, {
      ...BASE,
      mode: "regex",
      query: "a.b",
    });
    // '.' is a wildcard → both lines match.
    expect(r.match_count).toBe(2);
  });

  it("returns an honest error for an invalid regex, never throws", () => {
    const r = scanFilesForPattern(FILES, {
      ...BASE,
      mode: "regex",
      query: "(unclosed",
    });
    expect(r.error).toMatch(/invalid regex/);
    expect(r.match_count).toBe(0);
  });

  it("caps total matches and marks truncated", () => {
    const big = {
      path: "big.ts",
      content: Array.from({ length: 50 }, () => "match here").join("\n"),
    };
    const r = scanFilesForPattern([big], {
      ...BASE,
      mode: "literal",
      query: "match",
      limit: 5,
    });
    expect(r.match_count).toBe(5);
    expect(r.truncated).toBe(true);
  });

  it("caps per-file matches", () => {
    const big = {
      path: "big.ts",
      content: Array.from({ length: 50 }, () => "hit").join("\n"),
    };
    const r = scanFilesForPattern([big], {
      ...BASE,
      mode: "literal",
      query: "hit",
      maxPerFile: 3,
    });
    expect(r.match_count).toBe(3);
  });

  it("caps total context bytes to avoid flooding context", () => {
    const wide = Array.from(
      { length: 100 },
      (_, i) => `line ${i} XHITX ${"z".repeat(100)}`
    ).join("\n");
    const r = scanFilesForPattern([{ path: "w.ts", content: wide }], {
      ...BASE,
      mode: "literal",
      query: "XHITX",
      maxTotalBytes: 500,
    });
    expect(r.truncated).toBe(true);
    // Far fewer than 100 matches because the byte cap stops collection early.
    expect(r.match_count).toBeLessThan(20);
  });

  it("empty query returns an error, not a scan", () => {
    const r = scanFilesForPattern(FILES, {
      ...BASE,
      mode: "literal",
      query: "",
    });
    expect(r.error).toMatch(/empty query/);
    expect(r.files_scanned).toBe(0);
  });

  it("escapeRegExp neutralizes metacharacters", () => {
    expect(escapeRegExp("a.b(c)")).toBe("a\\.b\\(c\\)");
  });
});
