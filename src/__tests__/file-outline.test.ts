import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFileOutline } from "../tools/coding/file-outline.js";

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
      "utf-8",
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
      "utf-8",
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
      "utf-8",
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
      "utf-8",
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
      "utf-8",
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
      "utf-8",
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
    const content = "x".repeat(400); // 400 chars → ~100 tokens at 4 chars/token
    writeFileSync(join(dir, "small.ts"), content, "utf-8");

    const o = await buildFileOutline({
      cwd: dir,
      filePathArg: "small.ts",
      graph: null,
    });

    // 400 chars / 4 chars_per_token = 100 tokens
    expect(o.token_estimate).toBe(100);
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
      "utf-8",
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
      "utf-8",
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
