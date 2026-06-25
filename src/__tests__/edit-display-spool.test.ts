/**
 * Tests for the edit-display spool (SPOOL piece) and the postEditHandlerAsync
 * diff-display path (PRINTER + CHANNEL pieces).
 *
 * Assertions:
 *   (a) A successful file_edit writes a capped diff entry to
 *       .unerr/state/edit-display.jsonl and NOT to .unerr/events/.
 *   (b) postEditHandlerAsync for mcp__unerr__file_edit returns a top-level
 *       systemMessage (and NO additionalContext) containing the colorized diff.
 *   (c) The native Edit tool path (non-mcp__unerr__file_edit) is unchanged —
 *       falls through to the co-change enrich path, not systemMessage.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPostEditHookAsync } from "../hooks/navigation-hooks.js";
import { consumeSpooledDiff, fileEditTool } from "../tools/coding/file-edit.js";
import type { ToolContext } from "../tools/types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unerr-spool-"));
  // Ensure .unerr/state exists so the spool path resolves cleanly.
  mkdirSync(join(dir, ".unerr", "state"), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ctx = (): ToolContext => ({ cwd: dir });

// ── (a) SPOOL: file_edit writes to .unerr/state/edit-display.jsonl ──────────

describe("edit-display spool — targeted edit mode", () => {
  it("writes a diff entry to .unerr/state/edit-display.jsonl after a successful edit", async () => {
    // VITEST env normally skips spooling — clear it to exercise the real path.
    const vitestEnv = process.env.VITEST;
    // biome-ignore lint/performance/noDelete: must unset the env var — assigning undefined would set it to the string "undefined"
    delete process.env.VITEST;

    try {
      const f = join(dir, "target.ts");
      writeFileSync(f, "const x = 1;\n");
      await fileEditTool.execute(
        {
          file_path: f,
          old_string: "const x = 1;",
          new_string: "const x = 2;",
        },
        ctx()
      );

      const spoolPath = join(dir, ".unerr", "state", "edit-display.jsonl");
      expect(existsSync(spoolPath)).toBe(true);

      const lines = readFileSync(spoolPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(lines.length).toBeGreaterThan(0);

      const entry = JSON.parse(lines[lines.length - 1]!) as {
        ts: string;
        file: string;
        diff: string;
      };
      expect(entry.file).toBe(f);
      expect(entry.diff).toContain("@@");
      expect(entry.diff).toContain("-const x = 1;");
      expect(entry.diff).toContain("+const x = 2;");
    } finally {
      process.env.VITEST = vitestEnv;
    }
  });

  it("does NOT write to .unerr/events/", async () => {
    const vitestEnv = process.env.VITEST;
    // biome-ignore lint/performance/noDelete: must unset the env var — assigning undefined would set it to the string "undefined"
    delete process.env.VITEST;

    try {
      const f = join(dir, "target2.ts");
      writeFileSync(f, "const a = 1;\n");
      await fileEditTool.execute(
        {
          file_path: f,
          old_string: "const a = 1;",
          new_string: "const a = 9;",
        },
        ctx()
      );

      const eventsDir = join(dir, ".unerr", "events");
      // events dir may not exist, or may exist but contain no spool file
      if (existsSync(eventsDir)) {
        const spoolInEvents = join(eventsDir, "edit-display.jsonl");
        expect(existsSync(spoolInEvents)).toBe(false);
      } else {
        // events dir not created at all — spool correctly went to state/
        expect(true).toBe(true);
      }
    } finally {
      process.env.VITEST = vitestEnv;
    }
  });

  it("caps the spool at 50 entries", async () => {
    // Write 55 entries directly to the spool.
    const spoolPath = join(dir, ".unerr", "state", "edit-display.jsonl");
    const f = join(dir, "cap.ts");
    const entries = Array.from({ length: 55 }, (_, i) =>
      JSON.stringify({
        ts: new Date().toISOString(),
        file: f,
        diff: `diff-${i}`,
      })
    );
    writeFileSync(spoolPath, entries.join("\n") + "\n", "utf-8");

    // Now do one real edit to trigger the cap logic.
    const vitestEnv = process.env.VITEST;
    // biome-ignore lint/performance/noDelete: must unset the env var — assigning undefined would set it to the string "undefined"
    delete process.env.VITEST;
    try {
      writeFileSync(f, "const z = 0;\n");
      await fileEditTool.execute(
        {
          file_path: f,
          old_string: "const z = 0;",
          new_string: "const z = 1;",
        },
        ctx()
      );

      const lines = readFileSync(spoolPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      // Should be capped at 50 (55 old entries trimmed to 49, then 1 new appended)
      expect(lines.length).toBeLessThanOrEqual(50);
    } finally {
      process.env.VITEST = vitestEnv;
    }
  });
});

describe("edit-display spool — whole-file write mode", () => {
  it("writes a preview entry to .unerr/state/edit-display.jsonl", async () => {
    const vitestEnv = process.env.VITEST;
    // biome-ignore lint/performance/noDelete: must unset the env var — assigning undefined would set it to the string "undefined"
    delete process.env.VITEST;

    try {
      const f = join(dir, "new.ts");
      const content = Array.from(
        { length: 20 },
        (_, i) => `line${i + 1};`
      ).join("\n");
      await fileEditTool.execute({ file_path: f, content }, ctx());

      const spoolPath = join(dir, ".unerr", "state", "edit-display.jsonl");
      expect(existsSync(spoolPath)).toBe(true);

      const lines = readFileSync(spoolPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      const entry = JSON.parse(lines[lines.length - 1]!) as {
        file: string;
        diff: string;
      };
      expect(entry.file).toBe(f);
      // Preview diff has at most 10 added lines (exclude the +++ header)
      const addedLines = entry.diff
        .split("\n")
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
      expect(addedLines.length).toBeLessThanOrEqual(10);
    } finally {
      process.env.VITEST = vitestEnv;
    }
  });
});

// ── consumeSpooledDiff ───────────────────────────────────────────────────────

describe("consumeSpooledDiff", () => {
  it("returns null when spool does not exist", () => {
    expect(consumeSpooledDiff(dir, "/some/file.ts")).toBeNull();
  });

  it("returns the diff and removes the entry", () => {
    const spoolPath = join(dir, ".unerr", "state", "edit-display.jsonl");
    const f = join(dir, "x.ts");
    writeFileSync(
      spoolPath,
      JSON.stringify({ ts: "t", file: f, diff: "the-diff" }) + "\n",
      "utf-8"
    );

    const result = consumeSpooledDiff(dir, f);
    expect(result).toBe("the-diff");

    // Entry has been consumed (file is now empty or missing the entry).
    const remaining = readFileSync(spoolPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(remaining.every((l) => !l.includes(f))).toBe(true);
  });

  it("matches a relative lookup against an absolute spool key (the common agent case)", () => {
    // The proxy stores the absolute path; the post-edit hook passes the raw
    // tool_input.file_path which agents commonly pass as repo-relative.
    const spoolPath = join(dir, ".unerr", "state", "edit-display.jsonl");
    const absFile = join(dir, "src", "foo.ts");
    writeFileSync(
      spoolPath,
      JSON.stringify({ ts: "t", file: absFile, diff: "abs-diff" }) + "\n",
      "utf-8"
    );

    // Lookup with a relative path — resolve(cwd, "src/foo.ts") === absFile
    const result = consumeSpooledDiff(dir, "src/foo.ts");
    expect(result).toBe("abs-diff");

    // Entry has been consumed.
    const remaining = readFileSync(spoolPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(remaining.every((l) => !l.includes("abs-diff"))).toBe(true);
  });

  it("returns null when no entry matches the file", () => {
    const spoolPath = join(dir, ".unerr", "state", "edit-display.jsonl");
    writeFileSync(
      spoolPath,
      JSON.stringify({ ts: "t", file: "/other/file.ts", diff: "d" }) + "\n",
      "utf-8"
    );
    expect(consumeSpooledDiff(dir, join(dir, "x.ts"))).toBeNull();
  });
});

// ── (b) + (c) PRINTER + CHANNEL: postEditHandlerAsync ────────────────────────

describe("postEditHandlerAsync via runPostEditHookAsync", () => {
  it("(b) mcp__unerr__file_edit with a spooled diff → systemMessage, no additionalContext", async () => {
    // Pre-seed a spool entry.
    const f = join(dir, "foo.ts");
    const spoolPath = join(dir, ".unerr", "state", "edit-display.jsonl");
    writeFileSync(
      spoolPath,
      JSON.stringify({
        ts: "t",
        file: f,
        diff: `--- ${f}\n+++ ${f}\n@@ -1,1 +1,1 @@\n-old\n+new`,
      }) + "\n",
      "utf-8"
    );

    // Simulate cwd = dir so consumeSpooledDiff finds the spool.
    const origCwd = process.cwd;
    process.cwd = () => dir;
    try {
      const stdin = JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "mcp__unerr__file_edit",
        tool_input: { file_path: f, old_string: "old", new_string: "new" },
      });
      const out = JSON.parse(await runPostEditHookAsync(stdin));

      // Must emit top-level systemMessage.
      expect(out.systemMessage).toBeDefined();
      expect(typeof out.systemMessage).toBe("string");
      // Must NOT emit additionalContext.
      expect(out.hookSpecificOutput?.additionalContext).toBeUndefined();
      expect(out.additionalContext).toBeUndefined();
      // Colorized diff contains the lines.
      expect(out.systemMessage).toContain("old");
      expect(out.systemMessage).toContain("new");
    } finally {
      process.cwd = origCwd;
    }
  });

  it("(c) native Edit tool → enrich path (additionalContext), no systemMessage at top level", async () => {
    const f = join(dir, "bar.ts");
    writeFileSync(f, "const b = 1;\n");

    const origCwd = process.cwd;
    process.cwd = () => dir;
    try {
      const stdin = JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: f,
          old_string: "const b = 1;",
          new_string: "const b = 2;",
        },
      });
      const out = JSON.parse(await runPostEditHookAsync(stdin));

      // Native Edit path: either passthrough ({}) or enrich (hookSpecificOutput.additionalContext).
      // It must NOT emit a top-level systemMessage.
      expect(out.systemMessage).toBeUndefined();
    } finally {
      process.cwd = origCwd;
    }
  });
});
