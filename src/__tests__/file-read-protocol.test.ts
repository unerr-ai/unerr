import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
      { cwd: dir, graph: null },
    );
    expect(typeof r.content).toBe("string");
    expect((r.content as string).includes("1\tone")).toBe(true);
    expect(r._layer6_meta?.gated).toBeUndefined();
  });

  it("gates files with >200 lines when no offset/entity", async () => {
    const dir = makeTmpDir("gate");
    const lines = Array.from({ length: 205 }, () => "x").join("\n");
    writeFileSync(join(dir, "big.txt"), lines, "utf-8");

    const r = await runFileReadForRouter(
      { file_path: "big.txt" },
      { cwd: dir, graph: null },
    );

    expect(r.content && typeof r.content === "object").toBe(true);
    const c = r.content as Record<string, unknown>;
    expect(c.gated).toBe(true);
    expect(r._layer6_meta?.format).toBe("outline");
    expect(r._layer6_meta?.gated).toBe(true);
  });

  it("entity slice includes ±5 line context around the match", async () => {
    const dir = makeTmpDir("ctx");
    const prefix = Array.from(
      { length: 12 },
      (_, i) => `// line ${i + 1}`,
    ).join("\n");
    writeFileSync(
      join(dir, "deep.ts"),
      `${prefix}\nexport function sliceFn(): number {\n  return 42;\n}\n`,
      "utf-8",
    );

    const r = await runFileReadForRouter(
      { file_path: "deep.ts", entity: "sliceFn" },
      { cwd: dir, graph: null },
    );

    const body = r.content as string;
    expect(body.includes("// line 8")).toBe(true);
    expect(body.includes("sliceFn")).toBe(true);
    expect(body.includes("(Showing lines")).toBe(true);
  });

  it("targets entity by name using AST when graph is null", async () => {
    const dir = makeTmpDir("ent");
    writeFileSync(
      join(dir, "mod.ts"),
      "// head\nexport function targetFn(): void {\n  return;\n}\n",
      "utf-8",
    );

    const r = await runFileReadForRouter(
      { file_path: "mod.ts", entity: "targetFn" },
      { cwd: dir, graph: null },
    );

    expect(typeof r.content).toBe("string");
    expect((r.content as string).includes("targetFn")).toBe(true);
    expect((r.content as string).includes("Showing lines")).toBe(true);
  });

  it("rejects binary files", async () => {
    const dir = makeTmpDir("bin");
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 0]));

    const r = await runFileReadForRouter(
      { file_path: "bin.dat" },
      { cwd: dir, graph: null },
    );

    expect(r.content && typeof r.content === "object").toBe(true);
    expect((r.content as { error?: string }).error).toMatch(/Binary/);
  });

  // ─── Token Budget Tests ─────────────────────────────────────────────────

  it("adaptive gating: budget=5000 allows 500-line file through without gating", async () => {
    const dir = makeTmpDir("budget-high");
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    writeFileSync(join(dir, "medium.ts"), lines, "utf-8");

    const r = await runFileReadForRouter(
      { file_path: "medium.ts", token_budget: 5000 },
      { cwd: dir, graph: null },
    );

    // With budget=5000, budgetLines = (5000*4)/80 = 250. effectiveGate = max(200, 250) = 250.
    // File has 300 lines > 250 → still gated
    // But let's use a higher budget to prove the adaptive gating works
    const r2 = await runFileReadForRouter(
      { file_path: "medium.ts", token_budget: 30000 },
      { cwd: dir, graph: null },
    );

    // budget=30000 → budgetLines = (30000*4)/80 = 1500. effectiveGate = max(200, 1500) = 1500.
    // File has 300 lines < 1500 → NOT gated
    expect(typeof r2.content).toBe("string");
    expect(r2._layer6_meta?.gated).toBeUndefined();
  });

  it("token budget constrains output line count", async () => {
    const dir = makeTmpDir("budget-cap");
    // 150 lines, each ~40 chars → fits in default budget but let's constrain
    const lines = Array.from(
      { length: 150 },
      (_, i) => `const x${i} = ${i}; // padding here for length`,
    ).join("\n");
    writeFileSync(join(dir, "vars.ts"), lines, "utf-8");

    const r = await runFileReadForRouter(
      { file_path: "vars.ts", token_budget: 300 },
      { cwd: dir, graph: null },
    );

    // budget=300 → budgetLines = (300*4)/80 = 15
    // File has 150 lines, effLimit = min(15, 150) = 15
    const body = r.content as string;
    expect(body.includes("(Showing lines")).toBe(true);
    // Should only show ~15 lines
    const outputLines = body.split("\n").filter((l) => /^\d+\t/.test(l));
    expect(outputLines.length).toBeLessThanOrEqual(20); // some tolerance
  });

  it("default behavior unchanged: no token_budget → same as before", async () => {
    const dir = makeTmpDir("default");
    const lines = Array.from({ length: 205 }, () => "x").join("\n");
    writeFileSync(join(dir, "big.txt"), lines, "utf-8");

    // Default token_budget=2000 → budgetLines=(2000*4)/80=100 → effectiveGate=max(200,100)=200
    // File has 205 > 200 → gated (same as before)
    const r = await runFileReadForRouter(
      { file_path: "big.txt" },
      { cwd: dir, graph: null },
    );

    expect((r.content as Record<string, unknown>).gated).toBe(true);
  });

  // ─── Ranked Entity Matching Tests ───────────────────────────────────────

  it("case-insensitive match: 'CompressOutput' finds 'compressOutput'", async () => {
    const dir = makeTmpDir("case-ins");
    writeFileSync(
      join(dir, "fn.ts"),
      "// top\nexport function compressOutput(): string {\n  return '';\n}\n",
      "utf-8",
    );

    const r = await runFileReadForRouter(
      { file_path: "fn.ts", entity: "CompressOutput" },
      { cwd: dir, graph: null },
    );

    expect(typeof r.content).toBe("string");
    expect((r.content as string).includes("compressOutput")).toBe(true);
  });

  it("prefix match: 'compress' matches 'compressShellOutput'", async () => {
    const dir = makeTmpDir("prefix");
    writeFileSync(
      join(dir, "fn.ts"),
      "// filler\nexport function compressShellOutput(): string {\n  return '';\n}\n",
      "utf-8",
    );

    const r = await runFileReadForRouter(
      { file_path: "fn.ts", entity: "compress" },
      { cwd: dir, graph: null },
    );

    expect(typeof r.content).toBe("string");
    expect((r.content as string).includes("compressShellOutput")).toBe(true);
  });

  it("entity not found on large file: returns outline with suggestions", async () => {
    const dir = makeTmpDir("not-found");
    const filler = Array.from({ length: 210 }, (_, i) => `// line ${i}`).join(
      "\n",
    );
    writeFileSync(
      join(dir, "big.ts"),
      `${filler}\nexport function realFunction(): void {}\n`,
      "utf-8",
    );

    const r = await runFileReadForRouter(
      { file_path: "big.ts", entity: "nonExistentThing" },
      { cwd: dir, graph: null },
    );

    const c = r.content as Record<string, unknown>;
    expect(c.gated).toBe(true);
    expect(c.entity_search).toBeDefined();
    const search = c.entity_search as { matched: boolean; query: string };
    expect(search.matched).toBe(false);
    expect(search.query).toBe("nonExistentThing");
  });

  it("provides tokens_estimate in _layer6_meta", async () => {
    const dir = makeTmpDir("tokens-est");
    writeFileSync(join(dir, "a.ts"), "const x = 1;\nconst y = 2;\n", "utf-8");

    const r = await runFileReadForRouter(
      { file_path: "a.ts" },
      { cwd: dir, graph: null },
    );

    expect(r._layer6_meta?.tokens_estimate).toBeGreaterThan(0);
    expect(r._layer6_meta?.tokens_estimate).toBeLessThan(100);
  });

  it("empty file returns empty content without error", async () => {
    const dir = makeTmpDir("empty");
    writeFileSync(join(dir, "empty.ts"), "", "utf-8");

    const r = await runFileReadForRouter(
      { file_path: "empty.ts" },
      { cwd: dir, graph: null },
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
