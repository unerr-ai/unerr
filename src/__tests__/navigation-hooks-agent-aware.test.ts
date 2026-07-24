import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetHookDedup } from "../hooks/hook-dedup.js";
import {
  runPostReadHook,
  runPreEditHook,
  runPreReadHook,
} from "../hooks/navigation-hooks.js";
import { MIN_USEFUL_ENTITIES } from "../intelligence/graph-readiness.js";
import { updateNudgeState } from "../proxy/nudge-state.js";

// R4 (Sprint 2): the big instructional banners now emit in full ONCE per
// session (file-backed gate), terse thereafter. Reset the gate before every
// test so each case independently exercises the first-emission (full) text;
// the once-then-terse behavior has its own dedicated test below.
//
// The pre-Read/post-Read redirects under test only fire when
// `readGraphReadiness(process.cwd())` reports ready, so every test here runs
// inside a fresh graph-ready fixture (mirrors
// navigation-hooks-graph-readiness.test.ts).
let tmpDir: string;
let prevCwd: string;

beforeEach(() => {
  resetHookDedup();
  prevCwd = process.cwd();
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "unerr-nav-hooks-agent-aware-")
  );
  const unerrDir = path.join(tmpDir, ".unerr");
  fs.mkdirSync(path.join(unerrDir, "state"), { recursive: true });
  fs.writeFileSync(path.join(unerrDir, "config.json"), "{}");
  fs.writeFileSync(path.join(unerrDir, "graph.db"), "");
  fs.writeFileSync(
    path.join(unerrDir, "state", "graph-stats.json"),
    JSON.stringify({
      entities: MIN_USEFUL_ENTITIES + 500,
      edges: 10,
      rules: 1,
      indexedAt: new Date().toISOString(),
    })
  );
  // Pre-spend the ambient "mark_intent" one-shot (non-Claude-Code agents get
  // it drained into their first PreToolUse result — src/hooks/hook-runner.ts
  // buildAmbientPreInjection) so this fresh fixture doesn't pick up an
  // unrelated nudge the fixture didn't exist to trigger before.
  updateNudgeState(tmpDir, (s) => {
    s.mark_intent_emitted = true;
  });
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
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

  it("DENIES the first full-file CODE Read, redirecting to file_read + a task-shaped search_code", () => {
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
    expect(reason).toContain("search_code");
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
    expect(msg).toContain("search_code");
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
  // generic non-signature pre-edit nudge was ALSO removed (measured ~105
  // fires/5 sessions vs 1 get_references call) — a plain non-signature edit
  // is now a silent passthrough. Only the signature-change branch below still
  // nudges; the banner never mentions built-in Read at all.
  it("passes through a non-signature edit with no nudge", () => {
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
    expect(msg).toBe("");
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
    // Generic non-signature pre-edit nudge was removed — passthrough, no message.
    expect(msg).toBe("");
  });
});

// ── postReadHook: Claude Code vs Cursor ──────────────────────────────

describe("postReadHook — agent-aware enrichment", () => {
  beforeEach(() => {
    resetHookDedup();
  });

  it("Claude Code: read-pref nudge is cut — passthrough (already in the instruction file)", () => {
    const result = JSON.parse(
      runPostReadHook(claudeCodePayload({ file_path: "src/post-read-cc.ts" }))
    );
    const msg = result.hookSpecificOutput?.additionalContext ?? "";
    expect(msg).toBe("");
  });

  it("Cursor: read-pref nudge is cut — passthrough (already in the instruction file)", () => {
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
    expect(msg).toBe("");
  });
});
