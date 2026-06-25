import { describe, expect, it } from "vitest";
import {
  MAX_SCAN_FILE_BYTES,
  type ScanAccumulator,
  compilePattern,
  escapeRegExp,
  scanFileInto,
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
    expect(r.matches.length).toBe(3); // a.ts:1, a.ts:2, b.ts:2
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
    expect(r.matches.length).toBe(1);
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
    expect(r.matches.length).toBe(2);
  });

  it("returns an honest error for an invalid regex, never throws", () => {
    const r = scanFilesForPattern(FILES, {
      ...BASE,
      mode: "regex",
      query: "(unclosed",
    });
    expect(r.error).toMatch(/invalid regex/);
    expect(r.matches.length).toBe(0);
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
    expect(r.matches.length).toBe(5);
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
    expect(r.matches.length).toBe(3);
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
    expect(r.matches.length).toBeLessThan(20);
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

describe("streaming scan helpers (latency fix — early-exit)", () => {
  it("compilePattern returns a regex for valid input, error for invalid/empty", () => {
    const ok = compilePattern("literal", "a.b");
    expect("re" in ok && ok.re.test("a.b")).toBe(true);
    expect(compilePattern("regex", "(unclosed")).toMatchObject({
      error: expect.stringMatching(/invalid regex/),
    });
    expect(compilePattern("literal", "")).toMatchObject({
      error: expect.stringMatching(/empty query/),
    });
  });

  it("scanFileInto returns false at the GLOBAL cap so the caller stops reading", () => {
    const c = compilePattern("literal", "hit");
    if (!("re" in c)) throw new Error("expected a compiled regex");
    const acc: ScanAccumulator = {
      matches: [],
      totalBytes: 0,
      truncated: false,
    };
    const opts = {
      mode: "literal" as const,
      query: "hit",
      limit: 2,
      contextLines: 0,
      maxTotalBytes: 12_000,
      maxPerFile: 20,
    };
    // First file has 5 hits but limit is 2 → cap hit mid-file → returns false.
    const cont = scanFileInto(
      c.re,
      "a.ts",
      Array.from({ length: 5 }, () => "hit").join("\n"),
      opts,
      acc
    );
    expect(cont).toBe(false); // signal: stop the whole scan (no more files read)
    expect(acc.matches).toHaveLength(2);
    expect(acc.truncated).toBe(true);
  });

  it("scanFileInto keeps going (returns true) when only the per-file cap is hit", () => {
    const c = compilePattern("literal", "hit");
    if (!("re" in c)) throw new Error("expected a compiled regex");
    const acc: ScanAccumulator = {
      matches: [],
      totalBytes: 0,
      truncated: false,
    };
    const cont = scanFileInto(
      c.re,
      "a.ts",
      Array.from({ length: 5 }, () => "hit").join("\n"),
      {
        mode: "literal",
        query: "hit",
        limit: 30,
        contextLines: 0,
        maxTotalBytes: 12_000,
        maxPerFile: 2, // per-file cap, NOT a global cap
      },
      acc
    );
    expect(cont).toBe(true); // per-file cap → still read the next file
    expect(acc.matches).toHaveLength(2);
    expect(acc.truncated).toBe(false);
  });

  it("MAX_SCAN_FILE_BYTES is a sane multi-hundred-KB ceiling", () => {
    expect(MAX_SCAN_FILE_BYTES).toBeGreaterThan(500_000);
  });
});
