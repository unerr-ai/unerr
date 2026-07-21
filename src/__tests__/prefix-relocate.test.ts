import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runUserPromptSubmitHook } from "../hooks/prompt-hooks.js";

/**
 * Prefix ordering — the per-prompt UserPromptSubmit block is always ordered
 * stable-head → boundary → volatile-tail so the cacheable leading bytes stay
 * byte-stable turn-to-turn. Isolated in a temp cwd so the one-shot nudge state
 * is fresh each run.
 */
// Computed key so biome's noDelete (static-member only) stays happy;
// `process.env.X = undefined` is wrong — it stores the string "undefined".
const SESSION = "UNERR_SESSION_ID";

describe("prefix ordering", () => {
  const BOUNDARY = "— unerr: per-turn context —";
  // Stable head line: the mark-intent one-shot (the Moment-1 recall nudge it
  // used to be died with the active-memory strip).
  const STABLE_HEAD = "record this turn's intent";
  let prevCwd: string;
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
    savedSession = process.env[SESSION];
    process.env[SESSION] = "relocate-test-session";
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (savedSession === undefined) delete process.env[SESSION];
    else process.env[SESSION] = savedSession;
  });

  it("stable mark-intent nudge leads, boundary present, volatile delegate line trails", () => {
    // Use a delegable prompt ("add tests …" → the `tests` class) so the
    // class-specific delegate line fires — that line is the VOLATILE per-prompt
    // nudge. (Since the decompose-delegate gate was broadened past build-intent,
    // a fix/refactor verb-cluster prompt now draws the STABLE decompose nudge,
    // not a volatile Path A line; the delegate line is the reliable volatile tail.)
    const ctx = readContext(
      runUserPromptSubmitHook(mk("add tests for the QueryRouter dispatch path"))
    );

    expect(ctx).toContain(BOUNDARY);
    expect(ctx).toContain(STABLE_HEAD);
    // The class-specific delegate line is the volatile per-prompt nudge.
    expect(ctx).toContain("ur|act delegate —");

    const headIdx = ctx.indexOf(STABLE_HEAD);
    const boundaryIdx = ctx.indexOf(BOUNDARY);
    const volatileIdx = ctx.indexOf("ur|act delegate —");
    // stable head before the boundary; volatile delegate line after it.
    expect(headIdx).toBeGreaterThanOrEqual(0);
    expect(headIdx).toBeLessThan(boundaryIdx);
    expect(volatileIdx).toBeGreaterThan(boundaryIdx);
  });
});
