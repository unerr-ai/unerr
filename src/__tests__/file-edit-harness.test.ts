/**
 * file_edit harness (edit + whole-file write modes) — edit-core primitives + tool contract.
 * Covers the guarantees that let unerr own the edit path without the host
 * agent's read gate: quote-tolerant matching, uniqueness, encoding + line-ending
 * preservation, and the base_hash staleness guard.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  contentHash,
  decodeFile,
  detectLineEnding,
  encodeFile,
  performReplace,
  quoteNormalize,
  renderEditDiff,
} from "../tools/coding/edit-core.js";
import { fileEditTool } from "../tools/coding/file-edit.js";
import type { ToolContext } from "../tools/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unerr-edit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const ctx = (): ToolContext => ({ cwd: dir });

describe("edit-core: hashing", () => {
  it("contentHash is stable across LF vs CRLF checkouts", () => {
    expect(contentHash("a\nb\nc")).toBe(contentHash("a\r\nb\r\nc"));
  });
  it("contentHash differs when content differs", () => {
    expect(contentHash("a\nb")).not.toBe(contentHash("a\nc"));
  });
});

describe("edit-core: encoding round-trips", () => {
  it("round-trips UTF-8 without BOM", () => {
    const buf = Buffer.from("hello\nworld", "utf8");
    const d = decodeFile(buf);
    expect(d.encoding).toBe("utf8");
    expect(d.hadBom).toBe(false);
    expect(encodeFile(d.text, d.encoding, d.hadBom).equals(buf)).toBe(true);
  });
  it("preserves a UTF-8 BOM", () => {
    const buf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("x", "utf8"),
    ]);
    const d = decodeFile(buf);
    expect(d.hadBom).toBe(true);
    expect(d.text).toBe("x");
    expect(encodeFile(d.text, d.encoding, d.hadBom).equals(buf)).toBe(true);
  });
  it("round-trips UTF-16LE with BOM", () => {
    const buf = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("hi", "utf16le"),
    ]);
    const d = decodeFile(buf);
    expect(d.encoding).toBe("utf16le");
    expect(d.text).toBe("hi");
    expect(encodeFile(d.text, d.encoding, d.hadBom).equals(buf)).toBe(true);
  });
  it("detects CRLF line endings", () => {
    expect(detectLineEnding("a\r\nb")).toBe("\r\n");
    expect(detectLineEnding("a\nb")).toBe("\n");
  });
});

describe("edit-core: quoteNormalize", () => {
  it("maps smart quotes/dashes 1:1 preserving length", () => {
    const s = "“hi” — it’s";
    const n = quoteNormalize(s);
    expect(n).toBe('"hi" - it\'s');
    expect(n.length).toBe(s.length);
  });
});

describe("edit-core: performReplace", () => {
  it("replaces a unique exact match", () => {
    const r = performReplace("a foo b", "foo", "bar", false);
    expect(r.ok && r.content).toBe("a bar b");
    expect(r.ok && r.replaced).toBe(1);
  });
  it("errors ambiguous when >1 match and not replace_all", () => {
    const r = performReplace("x x x", "x", "y", false);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("ambiguous");
    expect(!r.ok && r.count).toBe(3);
  });
  it("replace_all replaces every occurrence", () => {
    const r = performReplace("x x x", "x", "y", true);
    expect(r.ok && r.content).toBe("y y y");
    expect(r.ok && r.replaced).toBe(3);
  });
  it("errors not_found when absent", () => {
    const r = performReplace("abc", "zzz", "q", false);
    expect(!r.ok && r.code).toBe("not_found");
  });
  it("errors unchanged when old === new", () => {
    const r = performReplace("abc", "a", "a", false);
    expect(!r.ok && r.code).toBe("unchanged");
  });
  it("quote-normalized match preserves the file's original punctuation", () => {
    // file has smart quotes; agent's old_string uses straight quotes
    const r = performReplace("say “hi” now", '"hi"', '"bye"', false);
    expect(r.ok).toBe(true);
    expect(r.ok && r.normalized).toBe(true);
    // the replacement text is inserted verbatim; surrounding bytes untouched
    expect(r.ok && r.content).toBe('say "bye" now');
  });
});

describe("edit-core: renderEditDiff", () => {
  it("renders a unified hunk with -/+ lines", () => {
    const before = "line1\nfoo\nline3";
    const diff = renderEditDiff("f.ts", before, "foo", "bar", [6]);
    expect(diff).toContain("-foo");
    expect(diff).toContain("+bar");
    expect(diff).toContain("@@");
  });
});

describe("file_edit tool", () => {
  it("replaces and reports occurrence count, content stays out of result", async () => {
    const f = join(dir, "a.ts");
    writeFileSync(f, "const x = 1;\nconst y = 2;\n");
    const out = await fileEditTool.execute(
      { file_path: f, old_string: "const x = 1;", new_string: "const x = 42;" },
      ctx()
    );
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("Replaced 1 occurrence(s)");
    // the result carries the added/removed line counts
    expect(out.content).toContain("added 1 line(s), removed 1 line(s)");
    expect(out.metadata?.replaced).toBe(1);
    expect(readFileSync(f, "utf8")).toBe("const x = 42;\nconst y = 2;\n");
    // the diff must not leak into the model-facing result
    expect(String(out.content)).not.toContain("@@");
    // The per-edit reply echo was DROPPED — the user sees the change through the
    // deterministic end-of-turn "files changed" receipt instead. No echo hint.
    expect(out.content).not.toContain("ur|act");
    expect(String(out.content)).not.toContain("```diff");
    // edit_summary feeds that receipt: repo-relative path, counts, line ranges.
    const es = out.metadata?.edit_summary as {
      file: string;
      mode: string;
      added: number;
      removed: number;
      ranges: Array<{ start: number; end: number }>;
    };
    expect(es.mode).toBe("edit");
    expect(es.added).toBe(1);
    expect(es.removed).toBe(1);
    expect(es.ranges).toEqual([{ start: 1, end: 1 }]);
  });

  it("replace_all replaces every occurrence and reports the count", async () => {
    const f = join(dir, "all.ts");
    writeFileSync(f, "x\nx\nx\n");
    const out = await fileEditTool.execute(
      { file_path: f, old_string: "x", new_string: "y", replace_all: true },
      ctx()
    );
    expect(out.isError).toBeFalsy();
    expect(out.metadata?.replaced).toBe(3);
    expect(out.content).toContain("Replaced 3 occurrence(s)");
    expect(readFileSync(f, "utf8")).toBe("y\ny\ny\n");
  });

  it("preserves CRLF line endings", async () => {
    const f = join(dir, "crlf.ts");
    writeFileSync(f, "a\r\nfoo\r\nb\r\n");
    await fileEditTool.execute(
      { file_path: f, old_string: "foo", new_string: "bar" },
      ctx()
    );
    expect(readFileSync(f, "utf8")).toBe("a\r\nbar\r\nb\r\n");
  });

  it("rejects on base_hash mismatch (stale)", async () => {
    const f = join(dir, "s.ts");
    writeFileSync(f, "hello world");
    const out = await fileEditTool.execute(
      {
        file_path: f,
        old_string: "hello",
        new_string: "hi",
        base_hash: contentHash("different content"),
      },
      ctx()
    );
    expect(out.isError).toBe(true);
    expect(out.metadata?.error_code).toBe("stale");
    expect(readFileSync(f, "utf8")).toBe("hello world"); // untouched
  });

  it("accepts a matching base_hash", async () => {
    const f = join(dir, "m.ts");
    const body = "hello world";
    writeFileSync(f, body);
    const out = await fileEditTool.execute(
      {
        file_path: f,
        old_string: "hello",
        new_string: "hi",
        base_hash: contentHash(body),
      },
      ctx()
    );
    expect(out.isError).toBeFalsy();
    expect(readFileSync(f, "utf8")).toBe("hi world");
    expect(typeof out.metadata?.new_hash).toBe("string");
  });

  it("returns an ambiguous error without writing", async () => {
    const f = join(dir, "amb.ts");
    writeFileSync(f, "a a a");
    const out = await fileEditTool.execute(
      { file_path: f, old_string: "a", new_string: "b" },
      ctx()
    );
    expect(out.isError).toBe(true);
    expect(out.metadata?.error_code).toBe("ambiguous");
    expect(readFileSync(f, "utf8")).toBe("a a a");
  });
});

describe("file_edit tool — write mode (content)", () => {
  it("creates a new file (UTF-8 / LF)", async () => {
    const f = join(dir, "new.ts");
    const out = await fileEditTool.execute(
      { file_path: f, content: "line1\nline2\n" },
      ctx()
    );
    expect(out.content).toContain("Wrote");
    // a new file adds every line and removes none
    expect(out.content).toContain("added 3 line(s), removed 0 line(s)");
    // the per-edit echo was dropped — no echo hint in the result
    expect(out.content).not.toContain("ur|act");
    // edit_summary spans the whole new file for the end-of-turn receipt
    const es = out.metadata?.edit_summary as {
      mode: string;
      added: number;
      removed: number;
      ranges: Array<{ start: number; end: number }>;
    };
    expect(es.mode).toBe("create");
    expect(es.added).toBe(3);
    expect(es.removed).toBe(0);
    expect(es.ranges).toEqual([{ start: 1, end: 3 }]);
    expect(readFileSync(f, "utf8")).toBe("line1\nline2\n");
  });

  it("creates missing parent directories", async () => {
    const f = join(dir, "nested", "deep", "child.ts");
    const out = await fileEditTool.execute(
      { file_path: f, content: "ok\n" },
      ctx()
    );
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("Wrote");
    expect(readFileSync(f, "utf8")).toBe("ok\n");
  });

  it("preserves CRLF on overwrite", async () => {
    const f = join(dir, "over.ts");
    writeFileSync(f, "old\r\nbody\r\n");
    const out = await fileEditTool.execute(
      { file_path: f, content: "fresh\ncontent\n" },
      ctx()
    );
    expect(out.content).toContain("Overwrote");
    expect(readFileSync(f, "utf8")).toBe("fresh\r\ncontent\r\n");
  });
});

describe("file_edit tool — mode validation", () => {
  it("rejects when both content and old_string/new_string are supplied", async () => {
    const f = join(dir, "both.ts");
    writeFileSync(f, "alpha\n");
    const out = await fileEditTool.execute(
      {
        file_path: f,
        content: "whole\n",
        old_string: "alpha",
        new_string: "beta",
      },
      ctx()
    );
    expect(out.isError).toBe(true);
    expect(out.metadata?.error_code).toBe("mode_conflict");
    // File untouched.
    expect(readFileSync(f, "utf8")).toBe("alpha\n");
  });

  it("rejects when neither mode is supplied", async () => {
    const f = join(dir, "neither.ts");
    writeFileSync(f, "alpha\n");
    const out = await fileEditTool.execute({ file_path: f }, ctx());
    expect(out.isError).toBe(true);
    expect(out.metadata?.error_code).toBe("mode_missing");
    expect(readFileSync(f, "utf8")).toBe("alpha\n");
  });
});
