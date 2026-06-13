/**
 * Sprint SC-B.5: the exit story — `stripSentinelLines` / `stripAnnotationsFromRepo`.
 *
 * Contract (§2.1.1): removing `@sem` sentinel lines leaves the file byte-
 * identical EXCEPT those lines; prose summaries are never touched; idempotent.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  stripAnnotationsFromRepo,
  stripSentinelLines,
} from "../intelligence/semantic/strip-annotations.js";

describe("stripSentinelLines (SC-B.5)", () => {
  it("removes a sentinel line from a multi-line doc block, keeps the prose", () => {
    const src = `/**
 * Validates a session token against the active key set.
 * @sem domain=auth role=gateway
 */
export function validateToken() {}
`;
    const { content, linesRemoved } = stripSentinelLines(src);
    expect(linesRemoved).toBe(1);
    expect(content).toBe(`/**
 * Validates a session token against the active key set.
 */
export function validateToken() {}
`);
    // The prose summary survives verbatim.
    expect(content).toContain(
      "Validates a session token against the active key set."
    );
    expect(content).not.toContain("@sem");
  });

  it("removes a // line-comment sentinel (Go/Rust/C style)", () => {
    const src = `// Reconciles ledger rows nightly.
// @sem domain=payments role=orchestrator
func reconcile() {}
`;
    const { content, linesRemoved } = stripSentinelLines(src);
    expect(linesRemoved).toBe(1);
    expect(content).toBe(`// Reconciles ledger rows nightly.
func reconcile() {}
`);
  });

  it("removes a # line-comment sentinel (Python) but never a #[ Rust attribute", () => {
    const src = `# Loads the config.
# @sem domain=config
#[derive(Debug)]
def load(): pass
`;
    const { content } = stripSentinelLines(src);
    expect(content).not.toContain("@sem");
    expect(content).toContain("#[derive(Debug)]");
  });

  it("preserves the block closer when the sentinel rides the closing line", () => {
    const src = "/** something @sem domain=auth */\nexport const x = 1;\n";
    // One-line self-contained block: removed entirely (nothing else load-bearing).
    expect(stripSentinelLines(src).content).toBe("export const x = 1;\n");

    const multi = "/**\n * prose @sem domain=auth */\nexport const y = 2;\n";
    const out = stripSentinelLines(multi).content;
    // The closer is kept so the following code is never commented out.
    expect(out).toBe("/**\n */\nexport const y = 2;\n");
    expect(out).toContain("export const y = 2;");
  });

  it("does NOT strip a code line that merely contains the token in a string", () => {
    const src = `const marker = "@sem domain=auth";\n`;
    expect(stripSentinelLines(src).content).toBe(src);
    expect(stripSentinelLines(src).linesRemoved).toBe(0);
  });

  it("requires the token to be followed by whitespace or EOL (no @semantic match)", () => {
    const src = "// @semantic note\nconst z = 1;\n";
    expect(stripSentinelLines(src).linesRemoved).toBe(0);
  });

  it("honors a custom sentinel token list", () => {
    const src = "// @ctx domain=auth\nconst a = 1;\n";
    expect(stripSentinelLines(src, ["@ctx"]).linesRemoved).toBe(1);
    // Default token does not match the custom one.
    expect(stripSentinelLines(src).linesRemoved).toBe(0);
  });

  it("is idempotent and a no-op on content with no sentinels", () => {
    const clean = "export function plain() {}\n";
    const once = stripSentinelLines(clean);
    expect(once.content).toBe(clean);
    expect(once.linesRemoved).toBe(0);
    const withSem = `// @sem domain=x\n${clean}`;
    const stripped = stripSentinelLines(withSem).content;
    expect(stripSentinelLines(stripped).linesRemoved).toBe(0);
  });

  it("empty token list is a no-op", () => {
    const src = "// @sem domain=auth\nconst q = 1;\n";
    expect(stripSentinelLines(src, []).content).toBe(src);
  });
});

describe("stripAnnotationsFromRepo (SC-B.5)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unerr-strip-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("strips across source files, skips excluded dirs and non-source files", () => {
    writeFileSync(
      join(dir, "a.ts"),
      "/**\n * Does a thing.\n * @sem domain=auth\n */\nexport const a = 1;\n"
    );
    writeFileSync(
      join(dir, "b.py"),
      "# A helper.\n# @sem domain=payments\ndef b(): pass\n"
    );
    // Non-source file with a sentinel-looking line — must be left alone.
    writeFileSync(join(dir, "notes.md"), "// @sem domain=auth\n");
    // Excluded dir — must not be walked.
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "pkg", "c.ts"),
      "// @sem domain=vendor\nexport const c = 1;\n"
    );

    const res = stripAnnotationsFromRepo(dir);
    expect(res.filesChanged).toBe(2);
    expect(res.linesRemoved).toBe(2);
    expect(res.changedFiles.sort()).toEqual(["a.ts", "b.py"]);

    expect(readFileSync(join(dir, "a.ts"), "utf8")).not.toContain("@sem");
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toContain("Does a thing.");
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toContain("@sem");
    expect(
      readFileSync(join(dir, "node_modules", "pkg", "c.ts"), "utf8")
    ).toContain("@sem");
  });

  it("is idempotent — a second sweep changes nothing", () => {
    writeFileSync(
      join(dir, "x.ts"),
      "// @sem domain=auth\nexport const x = 1;\n"
    );
    expect(stripAnnotationsFromRepo(dir).filesChanged).toBe(1);
    const second = stripAnnotationsFromRepo(dir);
    expect(second.filesChanged).toBe(0);
    expect(second.linesRemoved).toBe(0);
  });

  it("reports zero changes on a repo with no annotations", () => {
    writeFileSync(join(dir, "clean.ts"), "export const k = 1;\n");
    const res = stripAnnotationsFromRepo(dir);
    expect(res.filesScanned).toBe(1);
    expect(res.filesChanged).toBe(0);
  });

  it("leaves every non-sentinel byte identical", () => {
    const before = `/**\n * Important prose with chars: <>&"'.\n * @sem domain=auth role=gateway\n */\nexport function f(x: number) {\n  return x + 1; // @sem-looking but in code, not stripped\n}\n`;
    writeFileSync(join(dir, "f.ts"), before);
    stripAnnotationsFromRepo(dir);
    const after = readFileSync(join(dir, "f.ts"), "utf8");
    // Reconstruct the expectation: only the standalone sentinel comment line is gone.
    const expected = before
      .split("\n")
      .filter((l) => l.trim() !== "* @sem domain=auth role=gateway")
      .join("\n");
    expect(after).toBe(expected);
    // The trailing-comment "@sem-looking" on a code line is preserved.
    expect(after).toContain("return x + 1;");
  });
});
