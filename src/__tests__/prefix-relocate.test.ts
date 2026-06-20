import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runUserPromptSubmitHook } from "../hooks/prompt-hooks.js";

/**
 * Lever A (UNERR_PREFIX_RELOCATE) — the per-prompt UserPromptSubmit block must be
 * ordered stable-head → boundary → volatile-tail when the flag is on, and stay
 * byte-identical to the legacy order when it is off. Isolated in a temp cwd so the
 * one-shot nudge state is fresh each run.
 */
// Computed keys so biome's noDelete (static-member only) stays happy;
// `process.env.X = undefined` is wrong — it stores the string "undefined".
const RELOCATE = "UNERR_PREFIX_RELOCATE";
const SESSION = "UNERR_SESSION_ID";

describe("prefix relocate (Lever A)", () => {
  const BOUNDARY = "— unerr: per-turn context —";
  const MOMENT1 = "anchored-note recall already ran";
  let prevCwd: string;
  let savedFlag: string | undefined;
  let savedSession: string | undefined;

  const mk = (msg: string) =>
    JSON.stringify({ hook_event_name: "UserPromptSubmit", user_message: msg });

  function readContext(out: string): string {
    const parsed = JSON.parse(out) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    return parsed.hookSpecificOutput?.additionalContext ?? "";
  }

  beforeEach(() => {
    prevCwd = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), "unerr-relocate-")));
    savedFlag = process.env[RELOCATE];
    savedSession = process.env[SESSION];
    process.env[SESSION] = "relocate-test-session";
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (savedFlag === undefined) delete process.env[RELOCATE];
    else process.env[RELOCATE] = savedFlag;
    if (savedSession === undefined) delete process.env[SESSION];
    else process.env[SESSION] = savedSession;
  });

  it("flag ON: stable Moment-1 nudge leads, boundary present, volatile Path A line trails", () => {
    process.env[RELOCATE] = "1";
    const ctx = readContext(
      runUserPromptSubmitHook(
        mk("refactor the proxy boot sequence to add a retry")
      )
    );

    expect(ctx).toContain(BOUNDARY);
    expect(ctx).toContain(MOMENT1);
    // The Path A verb-cluster line is the volatile per-prompt nudge.
    expect(ctx).toContain("Path A matched verb cluster");

    const headIdx = ctx.indexOf(MOMENT1);
    const boundaryIdx = ctx.indexOf(BOUNDARY);
    const volatileIdx = ctx.indexOf("Path A matched verb cluster");
    // stable head before the boundary; volatile Path A line after it.
    expect(headIdx).toBeGreaterThanOrEqual(0);
    expect(headIdx).toBeLessThan(boundaryIdx);
    expect(volatileIdx).toBeGreaterThan(boundaryIdx);
  });

  it("flag OFF: no boundary marker (legacy concatenation)", () => {
    delete process.env[RELOCATE];
    const ctx = readContext(
      runUserPromptSubmitHook(
        mk("refactor the proxy boot sequence to add a retry")
      )
    );
    expect(ctx).not.toContain(BOUNDARY);
    // Same content still present, just not split.
    expect(ctx).toContain(MOMENT1);
    expect(ctx).toContain("Path A matched verb cluster");
  });
});
