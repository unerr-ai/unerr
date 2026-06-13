import { beforeEach, describe, expect, it } from "vitest";
import { resetHookDedup } from "../hooks/hook-dedup.js";
import { runPreWebFetchHook } from "../hooks/web-hooks.js";

/**
 * Tests for the WebFetch → fetch_url redirect hook.
 *
 * The single agent-agnostic handler returns a `deny` HookResult; each
 * adapter renders it in its own wire format:
 *   - Claude Code → { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason } }
 *   - Cursor      → { permission: "deny", agent_message }
 *   - Cline       → { allow: false, reason }
 *
 * Deny-once: the first call per URL denies; repeats within the dedup
 * window fall back to a nudge (avoids the 10× retry loop documented in
 * navigation-hooks).
 */

// ── Payload builders (mirror navigation-hooks-agent-aware.test.ts) ────

function claudeCodePayload(toolInput: Record<string, unknown>) {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "WebFetch",
    tool_input: toolInput,
  });
}

function cursorPayload(toolInput: Record<string, unknown>) {
  return JSON.stringify({
    tool_name: "WebFetch",
    tool_input: toolInput,
    cwd: "/project",
  });
}

function clinePayload(params: Record<string, unknown>) {
  return JSON.stringify({
    tool: "WebFetch",
    params,
    event: "pre_tool",
  });
}

beforeEach(() => {
  resetHookDedup();
});

// ── Claude Code ──────────────────────────────────────────────────────

describe("preWebFetchHook — Claude Code", () => {
  it("denies the first WebFetch and redirects to fetch_url with the real URL", () => {
    const url = "https://example.com/cc-deny";
    const result = JSON.parse(
      runPreWebFetchHook(claudeCodePayload({ url, prompt: "find the API key" }))
    );
    expect(result.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason = result.hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toContain("fetch_url");
    expect(reason).toContain(url);
    // Short prompt is carried through to fetch_url's BM25 ranking.
    expect(reason).toContain('prompt:"find the API key"');
  });

  it("nudges (does not deny) on a repeat of the same URL within the window", () => {
    const url = "https://example.com/cc-repeat";
    runPreWebFetchHook(claudeCodePayload({ url })); // first → deny
    const second = JSON.parse(runPreWebFetchHook(claudeCodePayload({ url })));
    // Repeat → allow + systemMessage nudge, never a second deny.
    expect(second.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(second.hookSpecificOutput.systemMessage).toContain("fetch_url");
  });

  it("passthrough when there is no URL to redirect", () => {
    const result = JSON.parse(
      runPreWebFetchHook(claudeCodePayload({ prompt: "no url here" }))
    );
    expect(result).toEqual({});
  });

  it("omits a long prompt from the inlined suggestion", () => {
    const url = "https://example.com/cc-longprompt";
    const longPrompt = "x".repeat(300);
    const result = JSON.parse(
      runPreWebFetchHook(claudeCodePayload({ url, prompt: longPrompt }))
    );
    const reason = result.hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).not.toContain(longPrompt);
    expect(reason).toContain("<your extraction intent>");
  });
});

// ── Cursor ───────────────────────────────────────────────────────────

describe("preWebFetchHook — Cursor", () => {
  it("denies via Cursor's permission/agent_message channel", () => {
    const url = "https://example.com/cursor-deny";
    const result = JSON.parse(runPreWebFetchHook(cursorPayload({ url })));
    expect(result.permission).toBe("deny");
    expect(result.agent_message).toContain("fetch_url");
    expect(result.agent_message).toContain(url);
  });
});

// ── Cline ────────────────────────────────────────────────────────────

describe("preWebFetchHook — Cline", () => {
  it("denies via Cline's allow:false/reason channel", () => {
    const url = "https://example.com/cline-deny";
    const result = JSON.parse(runPreWebFetchHook(clinePayload({ url })));
    expect(result.allow).toBe(false);
    expect(result.reason).toContain("fetch_url");
    expect(result.reason).toContain(url);
  });
});
