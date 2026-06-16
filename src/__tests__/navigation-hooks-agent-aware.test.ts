import { beforeEach, describe, expect, it } from "vitest";
import { resetHookDedup } from "../hooks/hook-dedup.js";
import {
  runPostReadHook,
  runPreEditHook,
  runPreReadHook,
} from "../hooks/navigation-hooks.js";

// R4 (Sprint 2): the big instructional banners now emit in full ONCE per
// session (file-backed gate), terse thereafter. Reset the gate before every
// test so each case independently exercises the first-emission (full) text;
// the once-then-terse behavior has its own dedicated test below.
beforeEach(() => {
  resetHookDedup();
});

/**
 * Tests for agent-aware navigation hook behavior.
 *
 * Claude Code hooks detect via `hook_event_name` field.
 * Cursor hooks detect via `tool_name` + `cwd` fields (no hook_event_name).
 * Cline hooks detect via `tool` + `params` + `event` fields.
 *
 * The key behavioral difference: Read-before-Edit warnings are Claude Code only.
 */

// ── Helpers ──────────────────────────────────────────────────────────

function claudeCodePayload(toolInput: Record<string, unknown>) {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_input: toolInput,
  });
}

function cursorPayload(toolInput: Record<string, unknown>) {
  return JSON.stringify({
    tool_name: "Read",
    tool_input: toolInput,
    cwd: "/project",
  });
}

function clinePayload(path: string) {
  return JSON.stringify({
    tool: "read_file",
    params: { path },
    event: "pre_tool",
  });
}

// ── preReadHook: Claude Code ─────────────────────────────────────────

describe("preReadHook — Claude Code", () => {
  it("passthrough for targeted Read (offset/limit) — the pre-Edit pattern", () => {
    const result = JSON.parse(
      runPreReadHook(
        claudeCodePayload({ file_path: "src/foo.ts", offset: 10, limit: 20 })
      )
    );
    // Empty object = passthrough (no nudge, no deny)
    expect(result).toEqual({});
  });

  it("DENIES the first full-file CODE Read, redirecting to file_read + unerr_context", () => {
    const result = JSON.parse(
      runPreReadHook(claudeCodePayload({ file_path: "src/foo.ts" }))
    );
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    const reason = result.hookSpecificOutput?.permissionDecisionReason ?? "";
    // Deny is PRESERVED but reframed (B6): "wasteful" not "blocked"; escape is
    // re-calling Read when you genuinely need the WHOLE file, and edits route
    // through file_edit (no prior Read).
    expect(reason).toContain("full-file is wasteful");
    expect(reason).toContain("file_read");
    expect(reason).toContain("unerr_context");
    expect(reason).toContain("file_edit");
    // Never dead-ends a genuine whole-file read: re-calling Read proceeds.
    expect(reason).toContain("Re-call Read");
  });

  it("nudges (does not deny twice) on a repeat full-file Read of the same file", () => {
    const payload = claudeCodePayload({ file_path: "src/foo.ts" });
    const first = JSON.parse(runPreReadHook(payload));
    expect(first.hookSpecificOutput?.permissionDecision).toBe("deny");
    const second = JSON.parse(runPreReadHook(payload));
    // Repeat within the window → allow + systemMessage nudge, never a 2nd deny
    // (guards the #43189/#47565 double-deny retry loop).
    expect(second.hookSpecificOutput?.permissionDecision).not.toBe("deny");
    const msg = second.hookSpecificOutput?.systemMessage ?? "";
    expect(msg).toContain("file_read");
  });

  it("passthrough for non-code files (README.md) — built-in Read is sanctioned", () => {
    const result = JSON.parse(
      runPreReadHook(claudeCodePayload({ file_path: "README.md" }))
    );
    // Non-code files allow silently — file_read's graph value is code-specific.
    expect(result).toEqual({});
  });
});

// ── preReadHook: Non-Claude Code (Cursor) ────────────────────────────

describe("preReadHook — Cursor (non-Claude Code)", () => {
  it("DENIES first full-file CODE Read via permission/agent_message", () => {
    const result = JSON.parse(
      runPreReadHook(cursorPayload({ file_path: "src/foo.ts" }))
    );
    expect(result.permission).toBe("deny");
    const msg = result.agent_message ?? "";
    expect(msg).toContain("file_read");
    expect(msg).toContain("unerr_context");
    // Non-Claude Code agents get no Edit-gate clause (no read-before-edit gate).
    expect(msg).not.toContain("Edit gate");
  });

  it("passthrough for targeted Read (offset/limit) on every agent", () => {
    const result = JSON.parse(
      runPreReadHook(
        cursorPayload({ file_path: "src/foo.ts", offset: 10, limit: 20 })
      )
    );
    // Targeted reads are the legitimate pre-Edit pattern — allow silently.
    // Cursor's adapter renders passthrough as {permission:'allow'} (vs {} for
    // Claude Code); either way it carries no deny and no agent_message nudge.
    expect(result.permission).not.toBe("deny");
    expect(result.agent_message).toBeUndefined();
  });
});

// ── preEditHook: Claude Code ─────────────────────────────────────────

describe("preEditHook — Claude Code", () => {
  // Read-before-Edit nudges were REMOVED (B6): edits route through the
  // unerr-owned file_edit path, which needs no prior built-in Read. The
  // pre-edit nudge now only names the blast-radius next step. The banner no
  // longer mentions built-in Read at all.
  it("nudges get_references before edit, never mentions built-in Read", () => {
    const result = JSON.parse(
      runPreEditHook(
        claudeCodePayload({
          file_path: "src/foo.ts",
          old_string: "const x = 1",
          new_string: "const x = 2",
        })
      )
    );
    const msg = result.hookSpecificOutput?.systemMessage ?? "";
    expect(msg).toContain("get_references");
    expect(msg).toContain("src/foo.ts");
    expect(msg).not.toContain("CRITICAL: Edit REQUIRES built-in Read");
    expect(msg).not.toContain("built-in Read");
  });

  it("includes blast radius warning for signature changes", () => {
    const result = JSON.parse(
      runPreEditHook(
        claudeCodePayload({
          file_path: "src/foo.ts",
          old_string: "export function doSomething(x: number)",
          new_string: "export function doSomething(x: string)",
        })
      )
    );
    const msg = result.hookSpecificOutput?.systemMessage ?? "";
    expect(msg).toContain("function/class signature");
    expect(msg).toContain("get_references");
    expect(msg).not.toContain("CRITICAL: Edit REQUIRES built-in Read");
  });
});

// ── preEditHook: Non-Claude Code (Cursor) ────────────────────────────

describe("preEditHook — Cursor (non-Claude Code)", () => {
  it("does NOT include Read prerequisite warning", () => {
    const stdin = JSON.stringify({
      tool_name: "Edit",
      tool_input: {
        file_path: "src/foo.ts",
        old_string: "const x = 1",
        new_string: "const x = 2",
      },
      cwd: "/project",
    });
    const result = JSON.parse(runPreEditHook(stdin));
    // Cursor adapter uses `agent_message` at root level for pre-tool-use nudges
    const msg = result.agent_message ?? "";
    // Should NOT mention Edit requires Read
    expect(msg).not.toContain("CRITICAL: Edit REQUIRES built-in Read");
    expect(msg).not.toContain("file_read (MCP) does NOT satisfy this");
    // Should still mention get_references for blast radius
    expect(msg).toContain("get_references");
  });
});

// ── postReadHook: Claude Code vs Cursor ──────────────────────────────

describe("postReadHook — agent-aware enrichment", () => {
  beforeEach(() => {
    resetHookDedup();
  });

  it("Claude Code: mentions Edit workflow", () => {
    const result = JSON.parse(
      runPostReadHook(claudeCodePayload({ file_path: "src/post-read-cc.ts" }))
    );
    const msg = result.hookSpecificOutput?.additionalContext ?? "";
    expect(msg).toContain(
      "To change this file call file_edit (no built-in Read needed)"
    );
    expect(msg).toContain("file_read");
  });

  it("Cursor: generic file_read suggestion (no Edit mention)", () => {
    // Cursor postToolUse payload includes tool_output to distinguish from preToolUse
    // Use a unique file path to avoid dedup collision with the Claude Code test above
    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "src/post-read-cursor.ts" },
      tool_output: "file contents here",
      cwd: "/project",
    });
    const result = JSON.parse(runPostReadHook(stdin));
    // Cursor adapter uses `additional_context` at root level for post-tool-use enrichment
    const msg = result.additional_context ?? "";
    expect(msg).not.toContain("Edit needs built-in Read first");
    expect(msg).toContain("file_read");
  });
});
