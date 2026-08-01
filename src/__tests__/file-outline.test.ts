import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFileOutline,
  leanFileOutline,
} from "../tools/coding/file-outline.js";

function makeTmpDir(label: string): string {
  const dir = join(tmpdir(), `fo-${label}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("buildFileOutline", () => {
  it("extracts entities from TypeScript without graph", async () => {
    const dir = makeTmpDir("ts");
    writeFileSync(
      join(dir, "sample.ts"),
      "export function alpha(x: number): number {\n  return x + 1;\n}\n",
      "utf-8"
    );

    const o = await buildFileOutline({
      cwd: dir,
      filePathArg: "sample.ts",
      graph: null,
    });

    expect(o.total_lines).toBeGreaterThanOrEqual(3);
    expect(o.language).toBe("typescript");
    expect(o.entities.some((e) => e.name === "alpha")).toBe(true);
    expect(o.imports.length + o.exports.length).toBeGreaterThanOrEqual(1);
  });

  it("parses JSON config keys for small .json files", async () => {
    const dir = makeTmpDir("json");
    writeFileSync(
      join(dir, "cfg.json"),
      JSON.stringify({ foo: 1, bar: { nested: true } }),
      "utf-8"
    );

    const o = await buildFileOutline({
      cwd: dir,
      filePathArg: "cfg.json",
      graph: null,
    });

    expect(o.config_keys?.includes("foo")).toBe(true);
    expect(o.config_keys?.includes("bar")).toBe(true);
  });

  it("extracts a Go function without graph", async () => {
    const dir = makeTmpDir("go");
    writeFileSync(
      join(dir, "main.go"),
      "package main\n\nfunc goAlpha() int { return 1 }\n",
      "utf-8"
    );

    const o = await buildFileOutline({
      cwd: dir,
      filePathArg: "main.go",
      graph: null,
    });

    expect(o.language).toBe("go");
    expect(o.entities.some((e) => e.name === "goAlpha")).toBe(true);
  });

  it("extracts a Python function without graph", async () => {
    const dir = makeTmpDir("py");
    writeFileSync(
      join(dir, "mod.py"),
      "def py_alpha(n):\n    return n + 1\n",
      "utf-8"
    );

    const o = await buildFileOutline({
      cwd: dir,
      filePathArg: "mod.py",
      graph: null,
    });

    expect(o.language).toBe("python");
    expect(o.entities.some((e) => e.name === "py_alpha")).toBe(true);
  });

  it("lists markdown headings", async () => {
    const dir = makeTmpDir("md");
    writeFileSync(
      join(dir, "doc.md"),
      "# Title\n\n## Section\nbody\n",
      "utf-8"
    );

    const o = await buildFileOutline({
      cwd: dir,
      filePathArg: "doc.md",
      graph: null,
    });

    expect(o.headings?.some((h) => h.includes("Title"))).toBe(true);
  });

  // ─── New FRP-3 tests ──────────────────────────────────────────────────────

  it("marks exported entities with exported: true", async () => {
    const dir = makeTmpDir("exported");
    writeFileSync(
      join(dir, "lib.ts"),
      [
        "export function publicFn(): void {}",
        "function privateFn(): void {}",
        "export const PUBLIC_CONST = 1;",
        "const PRIVATE_CONST = 2;",
        "export class MyClass {}",
      ].join("\n"),
      "utf-8"
    );

    const o = await buildFileOutline({
      cwd: dir,
      filePathArg: "lib.ts",
      graph: null,
    });

    const publicFn = o.entities.find((e) => e.name === "publicFn");
    const privateFn = o.entities.find((e) => e.name === "privateFn");
    const myClass = o.entities.find((e) => e.name === "MyClass");

    expect(publicFn?.exported).toBe(true);
    expect(privateFn?.exported).toBe(false);
    expect(myClass?.exported).toBe(true);
  });

  it("provides token_estimate roughly proportional to file size", async () => {
    const dir = makeTmpDir("token-est");
    // Real-tokenizer counts (o200k_base) replace the old chars/4 heuristic, so
    // assert proportionality on realistic code rather than a fixed ratio: a
    // larger file must yield a larger estimate.
    const linesOf = (n: number) =>
      Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join(
        "\n"
      );
    writeFileSync(join(dir, "small.ts"), linesOf(10), "utf-8");
    writeFileSync(join(dir, "large.ts"), linesOf(40), "utf-8");

    const oSmall = await buildFileOutline({
      cwd: dir,
      filePathArg: "small.ts",
      graph: null,
    });
    const oLarge = await buildFileOutline({
      cwd: dir,
      filePathArg: "large.ts",
      graph: null,
    });

    expect(oSmall.token_estimate).toBeGreaterThan(0);
    expect(oLarge.token_estimate).toBeGreaterThan(oSmall.token_estimate);
    // 4x the content → ~4x the tokens (allow tokenizer slack).
    expect(oLarge.token_estimate).toBeGreaterThanOrEqual(
      oSmall.token_estimate * 3
    );
  });

  it("stable sort: entities with same start line sorted by name", async () => {
    const dir = makeTmpDir("sort");
    // Two entities at same line is unusual but can happen with type + const on same line
    // We'll simulate with a file where AST extracts multiple entities
    writeFileSync(
      join(dir, "multi.ts"),
      [
        "export function zebra(): void {}",
        "export function alpha(): void {}",
        "export function beta(): void {}",
      ].join("\n"),
      "utf-8"
    );

    const o = await buildFileOutline({
      cwd: dir,
      filePathArg: "multi.ts",
      graph: null,
    });

    // Entities should be sorted by start line first
    for (let i = 1; i < o.entities.length; i++) {
      const prev = o.entities[i - 1]!;
      const curr = o.entities[i]!;
      if (prev.lines[0] === curr.lines[0]) {
        // Same start line → alphabetical
        expect(prev.name.localeCompare(curr.name)).toBeLessThanOrEqual(0);
      } else {
        expect(prev.lines[0]).toBeLessThan(curr.lines[0]);
      }
    }
  });

  it("all entities have the exported field defined", async () => {
    const dir = makeTmpDir("exported-all");
    writeFileSync(
      join(dir, "mod.ts"),
      "export function a() {}\nfunction b() {}\nexport class C {}\n",
      "utf-8"
    );

    const o = await buildFileOutline({
      cwd: dir,
      filePathArg: "mod.ts",
      graph: null,
    });

    for (const entity of o.entities) {
      expect(typeof entity.exported).toBe("boolean");
    }
  });
});

describe("leanFileOutline (wire shape)", () => {
  // `file_read({outline:true})` has always served the lean shape and had a test
  // guarding it; the `file_outline` tool and its coding-tools wrapper served the
  // FULL FileOutlineOutput and had none. Since the pre-Read and pre-Glob nudges
  // name `file_outline("<path>")` by hand, the untested path was the one agents
  // actually hit. These assertions cover the shared shaper both now use.
  it("drops token_estimate, imports, and per-entity graph metadata", async () => {
    const dir = makeTmpDir("lean");
    writeFileSync(
      join(dir, "mod.ts"),
      [
        "import { foo } from './foo.js';",
        "export function alpha(): void {}",
        "export class Beta {}",
      ].join("\n"),
      "utf-8"
    );

    const full = await buildFileOutline({
      cwd: dir,
      filePathArg: "mod.ts",
      graph: null,
    });
    const lean = leanFileOutline(full);

    // The source object still carries them — only the wire shape is trimmed.
    expect(full.token_estimate).toBeGreaterThan(0);
    expect(Array.isArray(full.imports)).toBe(true);

    const wire = lean as unknown as Record<string, unknown>;
    expect(wire.token_estimate).toBeUndefined();
    expect(wire.imports).toBeUndefined();

    // Per-entity: exactly name / kind / lines.
    expect(lean.entities.length).toBeGreaterThan(0);
    for (const e of lean.entities) {
      expect(Object.keys(e).sort()).toEqual(["kind", "lines", "name"]);
    }

    // What the agent acts on survives.
    expect(lean.file_path).toBe(full.file_path);
    expect(lean.language).toBe(full.language);
    expect(lean.total_lines).toBe(full.total_lines);
    expect(lean.exports).toEqual(full.exports);
  });

  it("omits headings and config_keys entirely when empty rather than sending []", async () => {
    const dir = makeTmpDir("lean-empty");
    writeFileSync(join(dir, "plain.ts"), "export const x = 1;\n", "utf-8");

    const lean = leanFileOutline(
      await buildFileOutline({ cwd: dir, filePathArg: "plain.ts", graph: null })
    );

    // An empty array still costs brackets and a key name on every call.
    expect("headings" in lean).toBe(false);
    expect("config_keys" in lean).toBe(false);
  });

  it("keeps headings for markdown, where they are the outline", async () => {
    const dir = makeTmpDir("lean-md");
    writeFileSync(
      join(dir, "doc.md"),
      "# Title\n\n## Section\nbody\n",
      "utf-8"
    );

    const lean = leanFileOutline(
      await buildFileOutline({ cwd: dir, filePathArg: "doc.md", graph: null })
    );

    expect(lean.headings?.some((h) => h.includes("Title"))).toBe(true);
  });
});
