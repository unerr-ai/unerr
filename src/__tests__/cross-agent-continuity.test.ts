/**
 * Cross-session marker continuity (T3.4).
 *
 * After a session emits mark_intent('foo') + mark_blocker('bar'), the NEXT
 * session's first prompt-submit hook must surface both ("picking up: foo" +
 * the open blocker line). The stitch reads the shadow ledger JSONL
 * synchronously and fires once per UNERR_SESSION_ID.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCrossSessionStitchLine,
  runUserPromptSubmitHook,
} from "../hooks/prompt-hooks.js";

// ── T3.4 — Cross-session marker stitching ───────────────────────────────────
// After a session emits mark_intent('foo') + mark_blocker('bar'), the
// NEXT session's first prompt-submit hook must surface both ("picking
// up: foo" + the open blocker line). Stitch reads the shadow ledger
// JSONL synchronously and fires once per UNERR_SESSION_ID.

describe("T3.4 — cross-session marker stitching", () => {
  let cwd: string;
  let originalCwd: string;
  let originalSessionId: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(os.tmpdir(), "unerr-stitch-"));
    mkdirSync(join(cwd, ".unerr", "state"), { recursive: true });
    mkdirSync(join(cwd, ".unerr", "ledger"), { recursive: true });
    originalCwd = process.cwd();
    originalSessionId = process.env.UNERR_SESSION_ID;
    process.env.UNERR_SESSION_ID = "sess-B";
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalSessionId === undefined) {
      Reflect.deleteProperty(process.env, "UNERR_SESSION_ID");
    } else {
      process.env.UNERR_SESSION_ID = originalSessionId;
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  it("surfaces last mark_intent + unresolved mark_blocker from prior session", () => {
    // Agent A's session writes both markers; resolution never lands.
    const ledger = [
      {
        id: "intent-1",
        ts: "2026-05-22T10:00:00.000Z",
        tool: "mark_intent",
        session_id: "sess-A",
        args_summary: { text: "foo" },
      },
      {
        id: "blocker-1",
        ts: "2026-05-22T10:05:00.000Z",
        tool: "mark_blocker",
        session_id: "sess-A",
        args_summary: { text: "bar" },
      },
    ];
    writeFileSync(
      join(cwd, ".unerr", "ledger", "shadow.jsonl"),
      `${ledger.map((e) => JSON.stringify(e)).join("\n")}\n`,
      "utf8"
    );

    // Agent B starts up with a different UNERR_SESSION_ID and submits
    // the first prompt. The stitch line should ride the response.
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "where were we yesterday on the router work",
    });
    const out = JSON.parse(runUserPromptSubmitHook(stdin)) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    const ctx = out.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain("picking up: foo");
    expect(ctx).toContain("bar");
  });

  it("does not surface markers from the current session", () => {
    writeFileSync(
      join(cwd, ".unerr", "ledger", "shadow.jsonl"),
      `${JSON.stringify({
        id: "intent-self",
        tool: "mark_intent",
        session_id: "sess-B", // matches process.env.UNERR_SESSION_ID
        args_summary: { text: "self-intent" },
      })}\n`,
      "utf8"
    );
    expect(buildCrossSessionStitchLine(cwd)).toBeNull();
  });

  it("fires once per session", () => {
    writeFileSync(
      join(cwd, ".unerr", "ledger", "shadow.jsonl"),
      `${JSON.stringify({
        id: "i1",
        tool: "mark_intent",
        session_id: "sess-A",
        args_summary: { text: "carry-over" },
      })}\n`,
      "utf8"
    );
    expect(buildCrossSessionStitchLine(cwd)).toContain("carry-over");
    expect(buildCrossSessionStitchLine(cwd)).toBeNull();
  });
});
