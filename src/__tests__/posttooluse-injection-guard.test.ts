import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPostGlobHook, runPostGrepHook } from "../hooks/navigation-hooks.js";

/**
 * §11.6 invariant 1 (.internal/archive/TOKEN_ECONOMICS_AND_SAVINGS.md) — no PostToolUse handler may
 * inject a content block on every tool call. Each extra per-call block consumes a
 * slot in Claude Code's content-block cache lookback and forces a prefix re-write
 * (the measured 45–53K cache bust). PostToolUse `enrich` is allowed ONLY behind a
 * once-per-session/per-file gate (`shouldEmitOnce`) or a master switch
 * (`isReviewEnabled`). This guard fails if a future edit re-adds an ungated block.
 */
// Computed key so biome's noDelete (static-member only) stays happy;
// `process.env.X = undefined` is wrong — it stores the string "undefined".
const SESSION = "UNERR_SESSION_ID";

describe("PostToolUse per-tool injection guard (§11.6)", () => {
  it("every post*Handler that enriches is gated by shouldEmitOnce or a master switch", () => {
    const navPath = fileURLToPath(
      new URL("../hooks/navigation-hooks.ts", import.meta.url)
    );
    const src = readFileSync(navPath, "utf8");

    // Discover handler bodies by slicing between consecutive `const post*Handler`
    // declarations — a new handler is checked automatically.
    const re = /const (post\w*Handler)\s*[:=]/g;
    const marks = [...src.matchAll(re)].map((m) => ({
      name: m[1] ?? "",
      idx: m.index ?? 0,
    }));
    expect(marks.length).toBeGreaterThan(0);

    const ungated: string[] = [];
    for (const [i, mark] of marks.entries()) {
      const start = mark.idx;
      const end = marks[i + 1]?.idx ?? src.length;
      const body = src.slice(start, end);
      if (!body.includes("enrich(")) continue;
      const gated =
        body.includes("shouldEmitOnce(") || body.includes("isReviewEnabled(");
      if (!gated) ungated.push(mark.name);
    }
    expect(
      ungated,
      `ungated per-tool PostToolUse injection: ${ungated.join(", ")}`
    ).toEqual([]);
  });

  describe("behavioral: grep/glob nudges fire once per session then gate", () => {
    let prevCwd: string;
    let savedSession: string | undefined;

    const readCtx = (out: string): string =>
      (
        JSON.parse(out) as {
          hookSpecificOutput?: { additionalContext?: string };
        }
      ).hookSpecificOutput?.additionalContext ?? "";

    beforeEach(() => {
      prevCwd = process.cwd();
      process.chdir(mkdtempSync(join(tmpdir(), "unerr-ptu-guard-")));
      savedSession = process.env[SESSION];
      process.env[SESSION] = "ptu-guard-session";
    });

    afterEach(() => {
      process.chdir(prevCwd);
      if (savedSession === undefined) delete process.env[SESSION];
      else process.env[SESSION] = savedSession;
    });

    it("Grep: first call enriches, second passes through", () => {
      const mk = (p: string) =>
        JSON.stringify({ tool_name: "Grep", tool_input: { pattern: p } });
      const first = readCtx(runPostGrepHook(mk("fooBar")));
      const second = readCtx(runPostGrepHook(mk("bazQux")));
      expect(first).toContain("get_references");
      expect(second).toBe("");
    });

    it("Glob: first call enriches, second passes through", () => {
      const mk = () =>
        JSON.stringify({ tool_name: "Glob", tool_input: { pattern: "*.ts" } });
      const first = readCtx(runPostGlobHook(mk()));
      const second = readCtx(runPostGlobHook(mk()));
      expect(first).toContain("file_outline");
      expect(second).toBe("");
    });
  });
});
