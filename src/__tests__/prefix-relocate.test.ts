import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  // Stable head line: "bug" routes to the opt-in unerr-build-and-debug skill,
  // which is NOT installed by default, so Path A is suppressed and the fixed
  // omni-skill fallback line fires instead (byte-stable turn-to-turn).
  const STABLE_HEAD = "ur|act unerr-using-unerr —";
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
    const dir = mkdtempSync(join(tmpdir(), "unerr-relocate-"));
    process.chdir(dir);
    mkdirSync(join(dir, ".unerr", "ledger"), { recursive: true });
    savedSession = process.env[SESSION];
    process.env[SESSION] = "relocate-test-session";
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (savedSession === undefined) delete process.env[SESSION];
    else process.env[SESSION] = savedSession;
  });

  it("stable fallback line leads, boundary present, volatile stitch line trails", () => {
    // Seed a prior-session ledger entry so the cross-session stitch fires as
    // the VOLATILE per-prompt tail. A bug-fix prompt routes Path A to the
    // opt-in unerr-build-and-debug skill (not installed), so the fixed
    // omni-skill fallback line owns the STABLE head.
    writeFileSync(
      join(process.cwd(), ".unerr", "ledger", "shadow.jsonl"),
      `${JSON.stringify({
        id: "m1",
        tool: "mark_intent",
        session_id: "sess-prior",
        args_summary: { text: "wire the new router" },
      })}\n`,
      "utf8"
    );

    const ctx = readContext(
      runUserPromptSubmitHook(
        mk("fix the retry delay bug in the boot sequence")
      )
    );

    expect(ctx).toContain(BOUNDARY);
    expect(ctx).toContain(STABLE_HEAD);
    // The cross-session stitch line is the volatile per-prompt nudge.
    expect(ctx).toContain("ur|act picking up:");

    const headIdx = ctx.indexOf(STABLE_HEAD);
    const boundaryIdx = ctx.indexOf(BOUNDARY);
    const volatileIdx = ctx.indexOf("ur|act picking up:");
    // stable head before the boundary; volatile stitch line after it.
    expect(headIdx).toBeGreaterThanOrEqual(0);
    expect(headIdx).toBeLessThan(boundaryIdx);
    expect(volatileIdx).toBeGreaterThan(boundaryIdx);
  });
});
