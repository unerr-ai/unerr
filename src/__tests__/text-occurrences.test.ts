/**
 * findTextOccurrences — the rename-safety literal sweep behind get_references'
 * `include_text_occurrences` (P3). It must find a symbol baked into a string /
 * config / comment that a callers-only graph cannot see, while obeying the
 * word-boundary + case-sensitive contract so `userId` never flags `getUserId`
 * and never double-reports a file the call graph already covers.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findTextOccurrences } from "../intelligence/text-occurrences.js";

describe("findTextOccurrences — word-boundary literal sweep", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unerr-textocc-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (rel: string, body: string) => {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  };

  it("finds the name inside a string literal and a config key", () => {
    write("fixtures.ts", 'const route = "compressShellOutput";\n');
    write("config.json", '{\n  "compressShellOutput": true\n}\n');

    const r = findTextOccurrences(dir, "compressShellOutput", new Set());
    expect(r.total).toBe(2);
    expect(r.matches.map((m) => m.file).sort()).toEqual([
      "config.json",
      "fixtures.ts",
    ]);
  });

  it("is whole-word: does not flag a superstring (getUserId for userId)", () => {
    write("a.ts", "const x = getUserId();\nconst userId = 1;\n");

    const r = findTextOccurrences(dir, "userId", new Set());
    expect(r.total).toBe(1);
    expect(r.matches[0]?.line).toBe(2);
  });

  it("is case-sensitive: UserId does not match userId", () => {
    write("a.ts", "const UserId = 1;\n");
    const r = findTextOccurrences(dir, "userId", new Set());
    expect(r.total).toBe(0);
  });

  it("excludes files the call graph already covers", () => {
    write("caller.ts", "foo();\n");
    write("fixture.ts", 'const s = "foo";\n');

    const r = findTextOccurrences(dir, "foo", new Set(["caller.ts"]));
    expect(r.total).toBe(1);
    expect(r.matches[0]?.file).toBe("fixture.ts");
  });

  it("skips node_modules and binary/non-text files", () => {
    write("node_modules/pkg/index.js", 'const x = "target";\n');
    write("image.png", "target binary blob target\n");
    write("real.ts", 'const x = "target";\n');

    const r = findTextOccurrences(dir, "target", new Set());
    expect(r.total).toBe(1);
    expect(r.matches[0]?.file).toBe("real.ts");
  });

  it("reports truncation past the cap but keeps the true total", () => {
    const lines = Array.from({ length: 30 }, () => 'x = "tok"').join("\n");
    write("many.ts", lines);

    const r = findTextOccurrences(dir, "tok", new Set(), 25);
    expect(r.total).toBe(30);
    expect(r.matches.length).toBe(25);
    expect(r.truncated).toBe(true);
  });

  it("returns empty for an empty name rather than matching everything", () => {
    write("a.ts", "anything\n");
    expect(findTextOccurrences(dir, "", new Set()).total).toBe(0);
  });
});
