import { beforeEach, describe, expect, it } from "vitest";
import { resetHookDedup } from "../hooks/hook-dedup.js";
import {
  runPostReadHook,
  runPreEditHook,
  runPreReadHook,
} from "../hooks/navigation-hooks.js";

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
  it("passthrough for targeted Read (offset/limit)", () => {
    const result = JSON.parse(
      runPreReadHook(
        claudeCodePayload({ file_path: "src/foo.ts", offset: 10, limit: 20 })
      )
    );
    // Empty object = passthrough (no nudge)
    expect(result).toEqual({});
  });

  it("nudges for full-file Read (no offset/limit)", () => {
    const result = JSON.parse(
      runPreReadHook(claudeCodePayload({ file_path: "src/foo.ts" }))
    );
    const msg = result.hookSpecificOutput?.systemMessage ?? "";
    expect(msg).toContain("ONLY for the Edit workflow");
    expect(msg).toContain("offset/limit");
    expect(msg).toContain("file_read");
  });

  it("still nudges for non-code files (preRead has no isCodeFile gate)", () => {
    const result = JSON.parse(
      runPreReadHook(claudeCodePayload({ file_path: "README.md" }))
    );
    const msg = result.hookSpecificOutput?.systemMessage ?? "";
    expect(msg).toContain("file_read");
  });
});

// ── preReadHook: Non-Claude Code (Cursor) ────────────────────────────

describe("preReadHook — Cursor (non-Claude Code)", () => {
  it("nudges toward file_read (no Edit workflow mention)", () => {
    const result = JSON.parse(
      runPreReadHook(cursorPayload({ file_path: "src/foo.ts" }))
    );
    // Cursor adapter uses `agent_message` at root level for pre-tool-use nudges
    const msg = result.agent_message ?? "";
    // Should NOT mention Edit workflow or offset/limit requirement
    expect(msg).not.toContain("ONLY for the Edit workflow");
    // Should mention file_read as the preferred tool
    expect(msg).toContain("file_read");
  });

  it("still nudges even with offset/limit (Cursor doesn't need targeted Read)", () => {
    const result = JSON.parse(
      runPreReadHook(
        cursorPayload({ file_path: "src/foo.ts", offset: 10, limit: 20 })
      )
    );
    // Cursor adapter uses `agent_message` for pre-tool-use nudges
    const msg = result.agent_message ?? "";
    // Non-Claude Code: always nudge toward file_read, even with offset/limit
    expect(msg).toContain("file_read");
  });
});

// ── preEditHook: Claude Code ─────────────────────────────────────────

describe("preEditHook — Claude Code", () => {
  it("includes Read prerequisite warning", () => {
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
    expect(msg).toContain("CRITICAL: Edit REQUIRES built-in Read");
    expect(msg).toContain("file_read (MCP) does NOT satisfy this");
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
    expect(msg).toContain("CRITICAL: Edit REQUIRES built-in Read");
    expect(msg).toContain("function/class signature");
    expect(msg).toContain("get_references");
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
    expect(msg).toContain("Edit needs built-in Read first");
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
