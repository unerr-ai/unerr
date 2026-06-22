import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../hooks/adapters/claude-code.js";
import { clineAdapter } from "../hooks/adapters/cline.js";
import { cursorAdapter } from "../hooks/adapters/cursor.js";
import {
  type HookResult,
  detectAdapter,
  enrich,
  nudge,
  passthrough,
  rewrite,
  runPostToolUseHook,
  runPreToolUseHook,
  runPromptSubmitHook,
} from "../hooks/hook-runner.js";

// ── Adapter Detection ────────────────────────────────────────────────

describe("detectAdapter", () => {
  it("detects Claude Code from hook_event_name", () => {
    const payload = {
      hook_event_name: "PreToolUse",
      tool_input: { command: "ls" },
    };
    expect(detectAdapter(payload).name).toBe("claude-code");
  });

  it("detects Cursor from tool_name + cwd", () => {
    const payload = {
      tool_name: "Read",
      tool_input: { file_path: "foo.ts" },
      cwd: "/project",
    };
    expect(detectAdapter(payload).name).toBe("cursor");
  });

  it("detects Cline from tool + params", () => {
    const payload = {
      tool: "read_file",
      params: { path: "foo.ts" },
      event: "pre_tool",
    };
    expect(detectAdapter(payload).name).toBe("cline");
  });

  it("defaults to Claude Code for unknown payloads", () => {
    expect(detectAdapter({}).name).toBe("claude-code");
  });
});

// ── Claude Code Adapter ──────────────────────────────────────────────

describe("claudeCodeAdapter", () => {
  it("normalizes tool input from tool_input", () => {
    const payload = {
      hook_event_name: "PreToolUse",
      tool_input: { command: "ls" },
    };
    const n = claudeCodeAdapter.normalize(payload);
    expect(n.toolInput).toEqual({ command: "ls" });
    expect(n.event).toBe("PreToolUse");
  });

  it("formats passthrough as {}", () => {
    expect(claudeCodeAdapter.formatPreToolUse(passthrough())).toBe("{}");
    expect(claudeCodeAdapter.formatPostToolUse(passthrough())).toBe("{}");
  });

  it("formats nudge with systemMessage + additionalContext", () => {
    const result = JSON.parse(
      claudeCodeAdapter.formatPreToolUse(nudge("Use search_code"))
    );
    expect(result.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(result.hookSpecificOutput.systemMessage).toBe("Use search_code");
    // additionalContext is the only PreToolUse field Claude Code injects into
    // the model's context — without it the agent never sees the nudge.
    expect(result.hookSpecificOutput.additionalContext).toBe("Use search_code");
  });

  it("formats rewrite with updatedInput", () => {
    const result = JSON.parse(
      claudeCodeAdapter.formatPreToolUse(
        rewrite({ command: "unerr exec -- ls" })
      )
    );
    expect(result.hookSpecificOutput.updatedInput).toEqual({
      command: "unerr exec -- ls",
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("formats PostToolUse enrich with additionalContext", () => {
    const result = JSON.parse(
      claudeCodeAdapter.formatPostToolUse(enrich("Try get_entity"))
    );
    expect(result.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(result.hookSpecificOutput.additionalContext).toBe("Try get_entity");
  });

  it("formats UserPromptSubmit with additionalContext", () => {
    const result = JSON.parse(
      claudeCodeAdapter.formatPromptSubmit(enrich("Use unerr tools"))
    );
    expect(result.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(result.hookSpecificOutput.additionalContext).toBe("Use unerr tools");
  });
});

// ── Cursor Adapter ───────────────────────────────────────────────────

describe("cursorAdapter", () => {
  it("detects Cursor payload", () => {
    expect(
      cursorAdapter.detect({
        tool_name: "Read",
        tool_input: {},
        cwd: "/project",
      })
    ).toBe(true);
    // Should NOT detect Claude Code
    expect(
      cursorAdapter.detect({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        cwd: "/project",
      })
    ).toBe(false);
  });

  it("normalizes tool input from tool_input field", () => {
    const payload = {
      tool_name: "Read",
      tool_input: { file_path: "foo.ts" },
      cwd: "/project",
    };
    const n = cursorAdapter.normalize(payload);
    expect(n.toolInput).toEqual({ file_path: "foo.ts" });
    expect(n.toolName).toBe("Read");
  });

  it("formats passthrough as { permission: allow }", () => {
    const result = JSON.parse(cursorAdapter.formatPreToolUse(passthrough()));
    expect(result.permission).toBe("allow");
  });

  it("formats nudge with agent_message", () => {
    const result = JSON.parse(
      cursorAdapter.formatPreToolUse(nudge("Use file_outline"))
    );
    expect(result.permission).toBe("allow");
    expect(result.agent_message).toBe("Use file_outline");
  });

  it("formats rewrite with updated_input", () => {
    const result = JSON.parse(
      cursorAdapter.formatPreToolUse(rewrite({ command: "unerr exec -- ls" }))
    );
    expect(result.permission).toBe("allow");
    expect(result.updated_input).toEqual({ command: "unerr exec -- ls" });
  });

  it("formats PostToolUse enrich with additional_context", () => {
    const result = JSON.parse(
      cursorAdapter.formatPostToolUse(enrich("Use search_code"))
    );
    expect(result.additional_context).toBe("Use search_code");
  });
});

// ── Cline Adapter ────────────────────────────────────────────────────

describe("clineAdapter", () => {
  it("detects Cline payload", () => {
    expect(
      clineAdapter.detect({ tool: "read_file", params: { path: "foo.ts" } })
    ).toBe(true);
    // Should NOT detect Claude Code
    expect(
      clineAdapter.detect({
        tool: "read_file",
        params: {},
        hook_event_name: "PreToolUse",
      })
    ).toBe(false);
  });

  it("normalizes tool names from Cline format", () => {
    const payload = {
      tool: "read_file",
      params: { path: "foo.ts" },
      event: "pre_tool",
    };
    const n = clineAdapter.normalize(payload);
    expect(n.toolName).toBe("Read");
    expect(n.toolInput.file_path).toBe("foo.ts");
    expect(n.event).toBe("PreToolUse");
  });

  it("normalizes search_files to Grep", () => {
    const payload = { tool: "search_files", params: { regex: "myFunc" } };
    const n = clineAdapter.normalize(payload);
    expect(n.toolName).toBe("Grep");
    expect(n.toolInput.pattern).toBe("myFunc");
  });

  it("formats passthrough as {}", () => {
    const result = clineAdapter.formatPreToolUse(passthrough());
    expect(result).toBe("{}");
  });

  it("formats nudge with contextModification (v3.36)", () => {
    const result = JSON.parse(
      clineAdapter.formatPreToolUse(nudge("Use graph tools"))
    );
    expect(result.contextModification).toBe("Use graph tools");
  });

  it("formats PostToolUse enrich with contextModification (v3.36)", () => {
    const result = JSON.parse(
      clineAdapter.formatPostToolUse(enrich("Try get_references"))
    );
    expect(result.contextModification).toBe("Try get_references");
  });

  it("maps post_tool event to PostToolUse", () => {
    const payload = {
      tool: "execute_command",
      params: { command: "ls" },
      event: "post_tool",
    };
    const n = clineAdapter.normalize(payload);
    expect(n.event).toBe("PostToolUse");
    expect(n.toolName).toBe("Bash");
  });
});

// ── Universal Runner ─────────────────────────────────────────────────

describe("runPreToolUseHook", () => {
  it("returns {} for empty stdin", () => {
    expect(runPreToolUseHook("", () => passthrough())).toBe("{}");
  });

  it("returns {} for invalid JSON", () => {
    expect(runPreToolUseHook("not json", () => passthrough())).toBe("{}");
  });

  it("routes Claude Code payload through handler and formats correctly", () => {
    const stdin = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_input: { file_path: "src/foo.ts" },
    });
    const result = JSON.parse(
      runPreToolUseHook(stdin, () => nudge("Use file_read"))
    );
    expect(result.hookSpecificOutput.systemMessage).toBe("Use file_read");
  });

  it("routes Cursor payload through handler and formats correctly", () => {
    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
      cwd: "/project",
    });
    const result = JSON.parse(
      runPreToolUseHook(stdin, () => nudge("Use file_read"))
    );
    expect(result.permission).toBe("allow");
    // Ambient injection (mark_intent + topic-shift) may prepend the
    // handler's nudge — assert the nudge survives in the joined message.
    expect(result.agent_message).toContain("Use file_read");
  });

  it("routes Cline payload through handler and formats correctly (v3.36)", () => {
    const stdin = JSON.stringify({
      tool: "read_file",
      params: { path: "src/foo.ts" },
      event: "pre_tool",
    });
    const result = JSON.parse(
      runPreToolUseHook(stdin, () => nudge("Use file_read"))
    );
    // v3.36 protocol: nudge → contextModification (ambient injection may prepend)
    expect(result.contextModification).toContain("Use file_read");
  });
});

describe("runPostToolUseHook", () => {
  it("routes Claude Code enrich correctly", () => {
    const stdin = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_input: { file_path: "src/foo.ts" },
    });
    const result = JSON.parse(
      runPostToolUseHook(stdin, () => enrich("Try get_references"))
    );
    expect(result.hookSpecificOutput.additionalContext).toBe(
      "Try get_references"
    );
  });

  it("routes Cursor enrich correctly", () => {
    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
      cwd: "/project",
    });
    const result = JSON.parse(
      runPostToolUseHook(stdin, () => enrich("Try get_references"))
    );
    expect(result.additional_context).toBe("Try get_references");
  });
});

describe("runPromptSubmitHook", () => {
  it("routes prompt submit for Claude Code", () => {
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "Add a new function to handle auth",
    });
    const result = JSON.parse(
      runPromptSubmitHook(stdin, () => enrich("Use unerr tools"))
    );
    expect(result.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(result.hookSpecificOutput.additionalContext).toBe("Use unerr tools");
  });

  // T3.2 — the default (claude-code) prompt-submit handler does NOT emit the
  // static tool roster / skill catalog: both duplicate the cached `CLAUDE.md`
  // tool-routing section + the installed `.claude/skills/` menu, so they are
  // suppressed for claude-code. The per-turn ur|act Path A line still rides.
  // (Runs in a fresh tmp cwd for a clean first-turn nudge-state.)
  it("default (claude-code) handler suppresses the static roster / catalog but still emits the Path A line", async () => {
    const { runUserPromptSubmitHook } = await import(
      "../hooks/prompt-hooks.js"
    );
    const dir = mkdtempSync(join(os.tmpdir(), "unerr-hook-runner-"));
    mkdirSync(join(dir, ".unerr", "state"), { recursive: true });
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      const stdin = JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        user_message: "fix the failing auth tests right now",
      });
      const result = JSON.parse(runUserPromptSubmitHook(stdin));
      const ctx = result.hookSpecificOutput.additionalContext ?? "";
      // Static tail suppressed for claude-code …
      expect(ctx).not.toContain("available skills");
      expect(ctx).not.toContain("[unerr] Prefer unerr MCP tools");
      // … per-turn Path A signal still fires (bug verbs → unerr-build-and-debug).
      expect(ctx).toContain("unerr-build-and-debug");
    } finally {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // T3.1 — Path A routes the matched cluster to a named skill in the
  // emitted ur|act line.
  it("default handler emits ur|act Path A line for matched verb clusters", async () => {
    const { runUserPromptSubmitHook } = await import(
      "../hooks/prompt-hooks.js"
    );
    // "optimize …" routes to unerr-using-unerr (the fix cluster → the
    // orchestrator's default edit workflow, 2026-06) and is NOT a delegable
    // class, so the Path A line fires (delegation, which is always-on, would
    // otherwise route a delegable task like "rename …" to unerr-delegate). This
    // test is about Path A routing, not delegation.
    const stdin = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      user_message: "optimize the QueryRouter dispatch hot path",
    });
    const result = JSON.parse(runUserPromptSubmitHook(stdin));
    const ctx = result.hookSpecificOutput.additionalContext ?? "";
    expect(ctx).toContain("ur|act unerr-using-unerr");
  });
});

// ── Result Constructors ──────────────────────────────────────────────

describe("result constructors", () => {
  it("passthrough creates correct shape", () => {
    expect(passthrough()).toEqual({ action: "passthrough" });
  });

  it("nudge creates correct shape", () => {
    expect(nudge("msg")).toEqual({ action: "nudge", message: "msg" });
  });

  it("rewrite creates correct shape", () => {
    expect(rewrite({ cmd: "x" })).toEqual({
      action: "rewrite",
      updatedInput: { cmd: "x" },
    });
  });

  it("enrich creates correct shape", () => {
    expect(enrich("ctx")).toEqual({ action: "enrich", message: "ctx" });
  });
});
