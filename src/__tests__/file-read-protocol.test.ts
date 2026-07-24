import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import {
  elideCommentLines,
  rankEntityMatches,
  runFileReadForRouter,
} from "../tools/coding/file-read-protocol.js";

function makeTmpDir(label: string): string {
  const dir = join(tmpdir(), `frp-${label}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("runFileReadForRouter", () => {
  it("returns full content for small files", async () => {
    const dir = makeTmpDir("small");
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n", "utf-8");

    const r = await runFileReadForRouter(
      { file_path: "a.txt" },
      { cwd: dir, graph: null }
    );
    expect(typeof r.content).toBe("string");
    expect((r.content as string).includes("1\tone")).toBe(true);
    expect(r._layer6_meta?.gated).toBeUndefined();
  });

  it("outline mode returns a lean structural view — stripped of per-entity risk/callers/imports", async () => {
    const dir = makeTmpDir("outline");
    writeFileSync(
      join(dir, "mod.ts"),
      [
        "import { foo } from './foo.js';",
        "export function alpha(): void {}",
        "export const beta = 1;",
      ].join("\n"),
      "utf-8"
    );

    const r = await runFileReadForRouter(
      { file_path: "mod.ts", outline: true },
      { cwd: dir, graph: null }
    );

    const c = r.content as Record<string, unknown>;
    expect(c.language).toBe("typescript");
    expect(typeof c.total_lines).toBe("number");
    expect(Array.isArray(c.exports)).toBe(true);

    const entities = c.entities as Array<Record<string, unknown>>;
    expect(entities.length).toBeGreaterThan(0);
    const alpha = entities.find((e) => e.name === "alpha");
    expect(alpha).toBeDefined();
    // Lean per-entity shape: exactly name / kind / lines, nothing else.
    expect(Object.keys(alpha as object).sort()).toEqual([
      "kind",
      "lines",
      "name",
    ]);
    expect(Array.isArray((alpha as { lines: unknown }).lines)).toBe(true);

    // Stripped fields are absent — top level (imports, token_estimate) and per
    // entity (risk, callers, drift, exported).
    expect(c.imports).toBeUndefined();
    expect(c.token_estimate).toBeUndefined();
    for (const e of entities) {
      expect(e.risk).toBeUndefined();
      expect(e.callers).toBeUndefined();
      expect(e.drift).toBeUndefined();
      expect(e.exported).toBeUndefined();
    }
    expect(r._layer6_meta?.format).toBe("json");
  });

  it("truncates files over budget to a plain footer — no JSON outline", async () => {
    const dir = makeTmpDir("gate");
    // .ts (not .log/.txt) — a plain large file, not the log-tail path.
    const lines = Array.from({ length: 205 }, () => "x").join("\n");
    writeFileSync(join(dir, "big.ts"), lines, "utf-8");

    const r = await runFileReadForRouter(
      { file_path: "big.ts" },
      { cwd: dir, graph: null }
    );

    // No more gate-to-outline: a large whole-file read stays plain content,
    // truncated to budgetLines, with a pointer footer.
    expect(typeof r.content).toBe("string");
    expect(r.content as string).toContain(
      "(file has 205 lines; use offset/limit for more, outline:true for structure)"
    );
    expect(r._layer6_meta?.format).toBe("json");
    expect(r._layer6_meta?.gated).toBeUndefined();
  });

  it("entity slice returns the EXACT span — no ±5 context, no footer", async () => {
    const dir = makeTmpDir("ctx");
    const prefix = Array.from(
      { length: 12 },
      (_, i) => `// line ${i + 1}`
    ).join("\n");
    writeFileSync(
      join(dir, "deep.ts"),
      `${prefix}\nexport function sliceFn(): number {\n  return 42;\n}\n`,
      "utf-8"
    );

    const r = await runFileReadForRouter(
      { file_path: "deep.ts", entity: "sliceFn" },
      { cwd: dir, graph: null }
    );

    const body = r.content as string;
    // The line immediately before the function (old ±5 padding) is gone.
    expect(body.includes("// line 12")).toBe(false);
    expect(body.includes("13\texport function sliceFn")).toBe(true);
    expect(body.includes("return 42")).toBe(true);
    // Entity mode drops the "(Showing lines...)" footer entirely.
    expect(body.includes("(Showing lines")).toBe(false);
    // graph: null → no resolved key → no callers block.
    expect(body.includes("callers (")).toBe(false);
  });

  it("targets entity by name using AST when graph is null", async () => {
    const dir = makeTmpDir("ent");
    writeFileSync(
      join(dir, "mod.ts"),
      "// head\nexport function targetFn(): void {\n  return;\n}\n",
      "utf-8"
    );

    const r = await runFileReadForRouter(
      { file_path: "mod.ts", entity: "targetFn" },
      { cwd: dir, graph: null }
    );

    expect(typeof r.content).toBe("string");
    expect((r.content as string).includes("targetFn")).toBe(true);
    // Entity mode has no "(Showing lines...)" footer any more — exact span only.
    expect((r.content as string).includes("Showing lines")).toBe(false);
  });

  it("entity mode resolved via the graph appends a callers block — file + name only, fan_in desc", async () => {
    const dir = makeTmpDir("callers");
    writeFileSync(
      join(dir, "svc.ts"),
      "// head\nexport function mainFn(): void {\n  return;\n}\n",
      "utf-8"
    );

    const fakeGraph = {
      async getEntitiesByFile() {
        return [
          {
            key: "e:mainFn",
            kind: "function",
            name: "mainFn",
            file_path: "svc.ts",
            start_line: 2,
            end_line: 4,
            signature: "()",
            body: "export function mainFn(): void {\n  return;\n}",
            fan_in: 2,
            fan_out: 0,
            risk_level: "normal",
            community: 1,
          },
        ];
      },
      async getCallersOf(key: string) {
        if (key !== "e:mainFn") return [];
        return [
          {
            key: "e:caller1",
            kind: "function",
            name: "callerOne",
            file_path: "src/a.ts",
            start_line: 1,
            end_line: 5,
            signature: "()",
            body: "",
            fan_in: 5,
            fan_out: 1,
            risk_level: "normal",
            community: 1,
          },
          {
            key: "e:caller2",
            kind: "function",
            name: "callerTwo",
            file_path: "src/b.ts",
            start_line: 1,
            end_line: 5,
            signature: "()",
            body: "",
            fan_in: 1,
            fan_out: 1,
            risk_level: "normal",
            community: 1,
          },
        ];
      },
    } as unknown as CozoGraphStore;

    const r = await runFileReadForRouter(
      { file_path: "svc.ts", entity: "mainFn" },
      { cwd: dir, graph: fakeGraph }
    );

    const body = r.content as string;
    expect(body).toContain("callers (2):");
    expect(body).toContain("  src/a.ts  callerOne");
    expect(body).toContain("  src/b.ts  callerTwo");
    // Ordered by fan_in desc: callerOne (5) before callerTwo (1).
    expect(body.indexOf("callerOne")).toBeLessThan(body.indexOf("callerTwo"));
    // No decoration — no match-type/score suffix on optimization.
    expect(r._layer6_meta?.optimization ?? "").not.toContain("· entity");
  });

  it("entity mode with zero callers prints callers (0): with no rows", async () => {
    const dir = makeTmpDir("callers-zero");
    writeFileSync(
      join(dir, "lonely.ts"),
      "// head\nexport function lonelyFn(): void {\n  return;\n}\n",
      "utf-8"
    );

    const fakeGraph = {
      async getEntitiesByFile() {
        return [
          {
            key: "e:lonelyFn",
            kind: "function",
            name: "lonelyFn",
            file_path: "lonely.ts",
            start_line: 2,
            end_line: 4,
            signature: "()",
            body: "export function lonelyFn(): void {\n  return;\n}",
            fan_in: 0,
            fan_out: 0,
            risk_level: "normal",
            community: 1,
          },
        ];
      },
      async getCallersOf() {
        return [];
      },
    } as unknown as CozoGraphStore;

    const r = await runFileReadForRouter(
      { file_path: "lonely.ts", entity: "lonelyFn" },
      { cwd: dir, graph: fakeGraph }
    );

    const body = r.content as string;
    expect(body).toContain("callers (0):");
    // No rows follow the header for a zero-caller entity.
    expect(body.endsWith("callers (0):")).toBe(true);
  });

  it("rejects binary files", async () => {
    const dir = makeTmpDir("bin");
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 0]));

    const r = await runFileReadForRouter(
      { file_path: "bin.dat" },
      { cwd: dir, graph: null }
    );

    expect(r.content && typeof r.content === "object").toBe(true);
    expect((r.content as { error?: string }).error).toMatch(/Binary/);
  });

  // ─── Token Budget Tests ─────────────────────────────────────────────────

  it("full-file budget controls truncation — never gates to an outline", async () => {
    const dir = makeTmpDir("budget-high");
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join(
      "\n"
    );
    writeFileSync(join(dir, "medium.ts"), lines, "utf-8");

    // budget=5000 → budgetLines = (5000*4)/80 = 250 < 300 lines → truncates
    const r = await runFileReadForRouter(
      { file_path: "medium.ts", token_budget: 5000 },
      { cwd: dir, graph: null }
    );
    expect(typeof r.content).toBe("string");
    expect(r._layer6_meta?.gated).toBeUndefined();
    expect(r.content as string).toContain(
      "(file has 300 lines; use offset/limit for more, outline:true for structure)"
    );

    // budget=30000 → budgetLines = (30000*4)/80 = 1500 ≥ 300 lines → whole file
    const r2 = await runFileReadForRouter(
      { file_path: "medium.ts", token_budget: 30000 },
      { cwd: dir, graph: null }
    );
    expect(typeof r2.content).toBe("string");
    expect(r2._layer6_meta?.gated).toBeUndefined();
    expect((r2.content as string).includes("file has")).toBe(false);
  });

  it("token budget constrains output line count", async () => {
    const dir = makeTmpDir("budget-cap");
    // 150 lines, each ~40 chars → fits in default budget but let's constrain
    const lines = Array.from(
      { length: 150 },
      (_, i) => `const x${i} = ${i}; // padding here for length`
    ).join("\n");
    writeFileSync(join(dir, "vars.ts"), lines, "utf-8");

    const r = await runFileReadForRouter(
      { file_path: "vars.ts", token_budget: 300 },
      { cwd: dir, graph: null }
    );

    // budget=300 → budgetLines = (300*4)/80 = 15
    // File has 150 lines, effLimit = min(15, 150) = 15
    const body = r.content as string;
    expect(body).toContain(
      "(file has 150 lines; use offset/limit for more, outline:true for structure)"
    );
    // Should only show ~15 lines
    const outputLines = body.split("\n").filter((l) => /^\d+\t/.test(l));
    expect(outputLines.length).toBeLessThanOrEqual(20); // some tolerance
  });

  it("default behavior: no token_budget → truncates to the 100-line default budget", async () => {
    const dir = makeTmpDir("default");
    // .ts (not .log/.txt) — a plain large file, not the log-tail path.
    const lines = Array.from({ length: 205 }, () => "x").join("\n");
    writeFileSync(join(dir, "big.ts"), lines, "utf-8");

    // Default token_budget=2000 → budgetLines=(2000*4)/80=100. File has 205
    // lines > 100 → truncates to 100 with the plain pointer footer.
    const r = await runFileReadForRouter(
      { file_path: "big.ts" },
      { cwd: dir, graph: null }
    );

    expect(typeof r.content).toBe("string");
    expect(r.content as string).toContain(
      "(file has 205 lines; use offset/limit for more, outline:true for structure)"
    );
  });

  // ─── Ranked Entity Matching Tests ───────────────────────────────────────

  it("case-insensitive match: 'CompressOutput' finds 'compressOutput'", async () => {
    const dir = makeTmpDir("case-ins");
    writeFileSync(
      join(dir, "fn.ts"),
      "// top\nexport function compressOutput(): string {\n  return '';\n}\n",
      "utf-8"
    );

    const r = await runFileReadForRouter(
      { file_path: "fn.ts", entity: "CompressOutput" },
      { cwd: dir, graph: null }
    );

    expect(typeof r.content).toBe("string");
    expect((r.content as string).includes("compressOutput")).toBe(true);
  });

  it("prefix match: 'compress' matches 'compressShellOutput'", async () => {
    const dir = makeTmpDir("prefix");
    writeFileSync(
      join(dir, "fn.ts"),
      "// filler\nexport function compressShellOutput(): string {\n  return '';\n}\n",
      "utf-8"
    );

    const r = await runFileReadForRouter(
      { file_path: "fn.ts", entity: "compress" },
      { cwd: dir, graph: null }
    );

    expect(typeof r.content).toBe("string");
    expect((r.content as string).includes("compressShellOutput")).toBe(true);
  });

  it("entity not found on large file: compact suggestions-only error, no outline dump", async () => {
    const dir = makeTmpDir("not-found");
    const filler = Array.from({ length: 210 }, (_, i) => `// line ${i}`).join(
      "\n"
    );
    writeFileSync(
      join(dir, "big.ts"),
      `${filler}\nexport function realFunction(): void {}\n`,
      "utf-8"
    );

    const r = await runFileReadForRouter(
      { file_path: "big.ts", entity: "nonExistentThing" },
      { cwd: dir, graph: null }
    );

    const c = r.content as Record<string, unknown>;
    expect(c.gated).toBe(true);
    expect(c.entity_search).toBeDefined();
    const search = c.entity_search as {
      matched: boolean;
      query: string;
      suggestions: string[];
    };
    expect(search.matched).toBe(false);
    expect(search.query).toBe("nonExistentThing");
    // Suggestions fall back to outline entity names so the retry is concrete
    expect(search.suggestions).toContain("realFunction");
    // The full outline (entities array, imports, exports) is withheld —
    // a miss used to cost ~3k tokens of outline dump
    expect(c.entities).toBeUndefined();
    expect(c.imports).toBeUndefined();
    expect(c.exports).toBeUndefined();
    expect(c._gate_reason).toContain("realFunction");
  });

  it("bare method name resolves the Class.method entity (method-suffix match)", async () => {
    const dir = makeTmpDir("method-suffix");
    const filler = Array.from({ length: 210 }, (_, i) => `// pad ${i}`).join(
      "\n"
    );
    writeFileSync(
      join(dir, "envelope.ts"),
      `${filler}\nexport class ResponseEnvelope {\n  maybeCompressContent(input: string): string {\n    return input;\n  }\n}\n`,
      "utf-8"
    );

    // AST extractor names the method "ResponseEnvelope.maybeCompressContent";
    // a bare-name query must still resolve it deterministically.
    const r = await runFileReadForRouter(
      { file_path: "envelope.ts", entity: "maybeCompressContent" },
      { cwd: dir, graph: null }
    );

    expect(typeof r.content).toBe("string");
    expect((r.content as string).includes("maybeCompressContent")).toBe(true);
  });

  it("provides tokens_estimate in _layer6_meta", async () => {
    const dir = makeTmpDir("tokens-est");
    writeFileSync(join(dir, "a.ts"), "const x = 1;\nconst y = 2;\n", "utf-8");

    const r = await runFileReadForRouter(
      { file_path: "a.ts" },
      { cwd: dir, graph: null }
    );

    expect(r._layer6_meta?.tokens_estimate).toBeGreaterThan(0);
    expect(r._layer6_meta?.tokens_estimate).toBeLessThan(100);
  });

  it("empty file returns empty content without error", async () => {
    const dir = makeTmpDir("empty");
    writeFileSync(join(dir, "empty.ts"), "", "utf-8");

    const r = await runFileReadForRouter(
      { file_path: "empty.ts" },
      { cwd: dir, graph: null }
    );

    // Empty file has totalLines=1 (one empty string from split), body may be empty
    // Should not throw or return error
    expect(r._layer6_meta?.format).toBe("json");
  });
});

describe("rankEntityMatches", () => {
  const entities = [
    { name: "compressShellOutput", start_line: 10, body: "function body" },
    { name: "compressOutput", start_line: 20, body: "function body" },
    { name: "decompressInput", start_line: 30, body: "function body" },
    { name: "CompressOutput", start_line: 40, body: "function body" },
  ];

  it("exact match scores 100", () => {
    const ranked = rankEntityMatches(entities, "compressOutput");
    expect(ranked[0]!.score).toBe(100);
    expect(ranked[0]!.entity.name).toBe("compressOutput");
    expect(ranked[0]!.matchType).toBe("exact");
  });

  it("case-insensitive match scores 90", () => {
    const ranked = rankEntityMatches(entities, "compressoutput");
    expect(ranked[0]!.score).toBe(90);
    expect(ranked[0]!.entity.name).toBe("compressOutput");
    expect(ranked[0]!.matchType).toBe("case_insensitive");
  });

  it("method-suffix match scores 95 (bare name vs Class.method)", () => {
    const ents = [
      {
        name: "ResponseEnvelope.maybeCompressContent",
        start_line: 10,
        body: "fn",
      },
      { name: "maybeCompressContentHelper", start_line: 30, body: "fn" },
    ];
    const ranked = rankEntityMatches(ents, "maybeCompressContent");
    expect(ranked[0]!.score).toBe(95);
    expect(ranked[0]!.entity.name).toBe(
      "ResponseEnvelope.maybeCompressContent"
    );
    expect(ranked[0]!.matchType).toBe("method_suffix");
  });

  it("case-insensitive method-suffix match scores 85", () => {
    const ents = [
      { name: "QueryRouter.dispatchTool", start_line: 5, body: "fn" },
    ];
    const ranked = rankEntityMatches(ents, "dispatchtool");
    expect(ranked[0]!.score).toBe(85);
    expect(ranked[0]!.matchType).toBe("method_suffix");
  });

  it("prefix match scores 80", () => {
    const ranked = rankEntityMatches(entities, "compress");
    expect(ranked[0]!.score).toBe(80);
    // Both compressShellOutput and compressOutput start with "compress"
    // Both get score 80, sort is stable (order depends on input array)
    expect(ranked[0]!.matchType).toBe("prefix");
  });

  it("camelCase segment match scores 70", () => {
    const ents = [
      { name: "compressShellOutput", start_line: 10, body: "fn" },
      { name: "handleInput", start_line: 20, body: "fn" },
    ];
    const ranked = rankEntityMatches(ents, "shell");
    expect(ranked[0]!.score).toBe(70);
    expect(ranked[0]!.entity.name).toBe("compressShellOutput");
    expect(ranked[0]!.matchType).toBe("camelCase_segment");
  });

  it("substring match scores between 40-60 based on specificity", () => {
    const ents = [{ name: "myHandlerForXyz", start_line: 10, body: "fn" }];
    // "handler" is not a camelCase segment of "myHandlerForXyz" (segments: my, handler, for, xyz)
    // Actually it IS a segment. Let's use a true substring that isn't a segment.
    const ents2 = [{ name: "handleAllRequests", start_line: 10, body: "fn" }];
    // "eAll" is a substring but not a segment
    const ranked = rankEntityMatches(ents2, "eAll");
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(40);
    expect(ranked[0]!.score).toBeLessThanOrEqual(60);
    expect(ranked[0]!.matchType).toBe("substring");
  });

  it("returns empty array when nothing matches", () => {
    const ranked = rankEntityMatches(entities, "zzzzNotHere");
    expect(ranked).toHaveLength(0);
  });
});

describe("elideCommentLines (SC-E.2)", () => {
  it("collapses line comments to a marker, preserves code + line count", () => {
    const input = [
      "// leading note",
      "function foo() {",
      "  # python-style comment",
      "  return 1;",
      "}",
    ];
    const { lines, elided } = elideCommentLines(input);
    expect(elided).toBe(2);
    expect(lines).toEqual(["…", "function foo() {", "  …", "  return 1;", "}"]);
    // Line count preserved → offset/limit numbering stays correct.
    expect(lines.length).toBe(input.length);
  });

  it("elides a multi-line block comment body, including a @sem line inside it", () => {
    const input = [
      "/**",
      " * Does a thing.",
      " * @sem domain=billing",
      " */",
      "export function bill() {}",
    ];
    const { lines } = elideCommentLines(input);
    // Markers preserve each line's indentation, so the ` * …` body lines map to
    // ` …` while the unindented `/**` opener maps to `…`. Every comment-only
    // line elides the same way — no sentinel line is kept verbatim.
    expect(lines).toEqual(["…", " …", " …", " …", "export function bill() {}"]);
  });

  it("elides a Python docstring block", () => {
    const input = [
      "def f():",
      '    """',
      "    Long docstring prose.",
      '    """',
      "    return 2",
    ];
    const { lines, elided } = elideCommentLines(input);
    expect(elided).toBe(3);
    expect(lines).toEqual([
      "def f():",
      "    …",
      "    …",
      "    …",
      "    return 2",
    ]);
  });

  it("never touches code, blank lines, or a shebang", () => {
    const input = ["#!/usr/bin/env node", "", "const a = 1; // trailing"];
    const { lines, elided } = elideCommentLines(input);
    // Shebang kept (#!), blank kept, code-with-trailing-comment kept verbatim
    // (not a comment-only line → fidelity wins).
    expect(elided).toBe(0);
    expect(lines).toEqual(input);
  });
});
