import { beforeEach, describe, expect, it } from "vitest";
import { resetHookDedup } from "../hooks/hook-dedup.js";
import {
  runPostWebSearchHook,
  runPreWebFetchHook,
} from "../hooks/web-hooks.js";

/**
 * Tests for the WebFetch → fetch_url redirect hook.
 *
 * The single agent-agnostic handler returns a `deny` HookResult; each
 * adapter renders it in its own wire format:
 *   - Claude Code → { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason } }
 *   - Cursor      → { permission: "deny", agent_message }
 *   - Cline       → { cancel: true, reason } (v3.36 IDE-Hooks)
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
  it("denies via Cline's cancel:true/reason channel (v3.36)", () => {
    const url = "https://example.com/cline-deny";
    const result = JSON.parse(runPreWebFetchHook(clinePayload({ url })));
    expect(result.cancel).toBe(true);
    expect(result.reason).toContain("fetch_url");
    expect(result.reason).toContain(url);
  });
});

// ── Post-WebSearch bulk-fetch nudge ──────────────────────────────────

function webSearchPayload(query: string, toolResponse: unknown): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "WebSearch",
    tool_input: { query },
    tool_response: toolResponse,
  });
}

describe("postWebSearchHook — bulk fetch_url nudge", () => {
  it("nudges fetch_url({urls:[...]}) with every result URL after a search", () => {
    const result = JSON.parse(
      runPostWebSearchHook(
        webSearchPayload("cozodb datalog recursion", {
          results: [
            { title: "A", url: "https://a.example.com/docs" },
            { title: "B", url: "https://b.example.com/guide" },
            { title: "C", url: "https://c.example.com/ref" },
          ],
        })
      )
    );
    const ctx = result.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("fetch_url({urls:[");
    expect(ctx).toContain("https://a.example.com/docs");
    expect(ctx).toContain("https://b.example.com/guide");
    expect(ctx).toContain("https://c.example.com/ref");
    // Carries the query through to BM25 ranking.
    expect(ctx).toContain('prompt:"cozodb datalog recursion"');
  });

  it("parses URLs out of a formatted-string tool_response", () => {
    const text =
      "1. Alpha — https://a.example.com/x\n2. Beta — https://b.example.com/y";
    const result = JSON.parse(
      runPostWebSearchHook(webSearchPayload("topic", text))
    );
    const ctx = result.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("https://a.example.com/x");
    expect(ctx).toContain("https://b.example.com/y");
  });

  it("stays silent (passthrough) when fewer than two URLs are found", () => {
    const result = JSON.parse(
      runPostWebSearchHook(
        webSearchPayload("single", {
          results: [{ title: "Only", url: "https://only.example.com" }],
        })
      )
    );
    expect(result).toEqual({});
  });

  it("does not re-nudge the same query within the dedup window", () => {
    const payload = webSearchPayload("repeat query", {
      results: [
        { url: "https://a.example.com" },
        { url: "https://b.example.com" },
      ],
    });
    const first = JSON.parse(runPostWebSearchHook(payload));
    expect(first.hookSpecificOutput.additionalContext).toContain("fetch_url");
    const second = JSON.parse(runPostWebSearchHook(payload));
    expect(second).toEqual({});
  });

  it("caps the suggested URL list at maxBatchUrls", () => {
    const results = Array.from({ length: 15 }, (_, i) => ({
      url: `https://r${i}.example.com/page`,
    }));
    const result = JSON.parse(
      runPostWebSearchHook(webSearchPayload("many", { results }))
    );
    const ctx = result.hookSpecificOutput.additionalContext as string;
    const matches = ctx.match(/https:\/\/r\d+\.example\.com/g) ?? [];
    expect(matches.length).toBe(10);
  });
});
