/**
 * Claude Code hook adapter.
 *
 * Protocol:
 *   stdin:  { tool_input: {...}, hook_event_name: "PreToolUse" | "PostToolUse" }
 *   stdout (PreToolUse):
 *     - passthrough: {}
 *     - nudge:   { hookSpecificOutput: { hookEventName, permissionDecision: "allow", systemMessage } }
 *     - rewrite: { hookSpecificOutput: { hookEventName, permissionDecision: "allow", updatedInput } }
 *   stdout (PostToolUse):
 *     - passthrough: {}
 *     - enrich:  { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }
 *   stdout (UserPromptSubmit):
 *     - passthrough: {}
 *     - enrich:  { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }
 */

import type {
  HookAdapter,
  HookResult,
  NormalizedPayload,
} from "../hook-runner.js";

export const claudeCodeAdapter: HookAdapter = {
  name: "claude-code",

  detect(payload: Record<string, unknown>): boolean {
    // Claude Code sends hook_event_name as a string field
    // Also serves as the default fallback — detect returns true broadly
    return (
      typeof payload.hook_event_name === "string" ||
      typeof payload.tool_input === "object" ||
      // Fallback: if no other adapter matched, Claude Code is default
      true
    );
  },

  normalize(payload: Record<string, unknown>): NormalizedPayload {
    const toolInput = (payload.tool_input ?? payload.input ?? {}) as Record<
      string,
      unknown
    >;
    const toolName = (payload.tool_name ?? payload.toolName) as
      | string
      | undefined;
    const eventName = payload.hook_event_name as string | undefined;

    let event: NormalizedPayload["event"];
    if (eventName === "PreToolUse") event = "PreToolUse";
    else if (eventName === "PostToolUse") event = "PostToolUse";
    else if (eventName === "UserPromptSubmit") event = "UserPromptSubmit";
    else if (eventName === "SessionStart") event = "SessionStart";

    return { raw: payload, toolInput, toolName, event };
  },

  formatPreToolUse(result: HookResult): string {
    if (result.action === "passthrough") return "{}";

    if (result.action === "deny") {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            result.message ?? "Blocked by unerr policy.",
        },
      });
    }

    if (result.action === "nudge" && result.message) {
      // systemMessage surfaces to the user only; additionalContext is the one
      // PreToolUse field Claude Code injects into the model's context. Emit both
      // so the agent acts on the nudge (e.g. the cascade guard), not just the user.
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          systemMessage: result.message,
          additionalContext: result.message,
        },
      });
    }

    if (result.action === "rewrite" && result.updatedInput) {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: result.updatedInput,
        },
      });
    }

    return "{}";
  },

  formatPostToolUse(result: HookResult): string {
    if (result.action === "passthrough") return "{}";

    // display = user-only channel: top-level systemMessage, never additionalContext.
    // Mirrors the Stop hook path so the diff is visible in the IDE sidebar
    // without re-billing on every cached turn.
    if (result.action === "display" && result.message) {
      return JSON.stringify({ systemMessage: result.message });
    }

    if (
      (result.action === "enrich" || result.action === "nudge") &&
      result.message
    ) {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: result.message,
        },
      });
    }

    return "{}";
  },

  formatPromptSubmit(result: HookResult): string {
    if (result.action === "passthrough") return "{}";

    if (result.message) {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: result.message,
        },
      });
    }

    return "{}";
  },

  formatSessionStart(result: HookResult): string {
    if (result.action === "passthrough") return "{}";

    if (result.message) {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: result.message,
        },
      });
    }

    return "{}";
  },

  formatStop(result: HookResult): string {
    if (result.action === "passthrough") return "{}";

    // Stop has no additionalContext channel — the close-out line is for the
    // user, so it rides top-level `systemMessage`. The economy line itself
    // must NEVER block: only the capped autonomous-mode verify gate in
    // stop-hooks.ts (action:"block", at most 2 per session, then it degrades
    // to a soft line) may force continuation here — every other Stop path on
    // this adapter stays a plain systemMessage.
    if (result.action === "block" && result.message) {
      return JSON.stringify({ decision: "block", reason: result.message });
    }

    if (
      (result.action === "enrich" || result.action === "nudge") &&
      result.message
    ) {
      return JSON.stringify({ systemMessage: result.message });
    }

    return "{}";
  },
};
