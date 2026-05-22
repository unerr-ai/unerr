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

    return { raw: payload, toolInput, toolName, event };
  },

  formatPreToolUse(result: HookResult): string {
    if (result.action === "passthrough") return "{}";

    if (result.action === "nudge" && result.message) {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          systemMessage: result.message,
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
};
