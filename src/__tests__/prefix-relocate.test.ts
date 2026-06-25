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
  const MOMENT1 = "anchored-note recall already ran";
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

  it("stable Moment-1 nudge leads, boundary present, volatile Path A line trails", () => {
    // Use a `fix`-cluster prompt (→ the always-on unerr-using-unerr, installed)
    // that is neither delegable nor build-intent, so it yields a VOLATILE Path A
    // line. A build/bug prompt now draws the stable build-decompose nudge instead.
    const ctx = readContext(
      runUserPromptSubmitHook(mk("optimize the QueryRouter dispatch hot path"))
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
});
