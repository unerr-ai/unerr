/**
 * Cursor hook adapter.
 *
 * Protocol (from official Cursor hooks documentation):
 *   stdin (preToolUse):  { tool_name: "Read", tool_input: { file_path: "..." }, tool_use_id: "abc", cwd: "/project", model: "..." }
 *   stdin (postToolUse): { tool_name: "Read", tool_input: {...}, tool_output: "...", tool_use_id: "abc", cwd: "/project", duration: 1234 }
 *   stdin (beforeSubmitPrompt): { prompt: "...", attachments: [...] }
 *
 *   stdout (preToolUse):
 *     - passthrough: { permission: "allow" }
 *     - nudge:       { permission: "allow", agent_message: "..." }
 *     - rewrite:     { permission: "allow", updated_input: { ... } }
 *   stdout (postToolUse):
 *     - passthrough: {}
 *     - enrich:      { additional_context: "..." }
 *   stdout (beforeSubmitPrompt):
 *     - always:      { continue: true }
 *
 * Detection: Cursor sends `tool_name` (snake_case) + `cwd` at root level,
 * without `hook_event_name` (which is Claude Code's marker).
 */

import type {
  HookAdapter,
  HookResult,
  NormalizedPayload,
} from "../hook-runner.js";

export const cursorAdapter: HookAdapter = {
  name: "cursor",

  detect(payload: Record<string, unknown>): boolean {
    // Cursor sends tool_name (snake_case) + cwd, without hook_event_name
    return (
      typeof payload.tool_name === "string" &&
      typeof payload.hook_event_name !== "string" &&
      typeof payload.cwd === "string"
    );
  },

  normalize(payload: Record<string, unknown>): NormalizedPayload {
    const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>;
    const toolName = payload.tool_name as string | undefined;

    // Cursor doesn't send explicit event type in a single field — infer from context:
    // postToolUse payloads include tool_output; preToolUse does not
    // beforeSubmitPrompt payloads include prompt
    let event: NormalizedPayload["event"];
    if (typeof payload.prompt === "string") {
      event = "UserPromptSubmit";
    } else if (
      typeof payload.tool_output === "string" ||
      payload.tool_output !== undefined
    ) {
      event = "PostToolUse";
    } else {
      event = "PreToolUse";
    }

    return { raw: payload, toolInput, toolName, event };
  },

  formatPreToolUse(result: HookResult): string {
    if (result.action === "passthrough") {
      return JSON.stringify({ permission: "allow" });
    }

    if (result.action === "deny") {
      return JSON.stringify({
        permission: "deny",
        agent_message: result.message ?? "Blocked by unerr policy.",
      });
    }

    if (result.action === "nudge" && result.message) {
      return JSON.stringify({
        permission: "allow",
        agent_message: result.message,
      });
    }

    if (result.action === "rewrite" && result.updatedInput) {
      return JSON.stringify({
        permission: "allow",
        updated_input: result.updatedInput,
      });
    }

    return JSON.stringify({ permission: "allow" });
  },

  formatPostToolUse(result: HookResult): string {
    if (result.action === "passthrough") {
      return "{}";
    }

    if (
      (result.action === "enrich" || result.action === "nudge") &&
      result.message
    ) {
      return JSON.stringify({
        additional_context: result.message,
      });
    }

    return "{}";
  },

  formatPromptSubmit(result: HookResult): string {
    // Cursor's beforeSubmitPrompt only supports:
    //   { continue: true|false, user_message: "..." }
    // user_message is shown to the USER in the client, not injected into agent context.
    // There is no agent_message or additionalContext field for this hook.
    // So we always continue — the prompt-submit nudge only works in Claude Code.
    if (result.action === "passthrough") {
      return JSON.stringify({ continue: true });
    }

    // Even with a message, we can't inject it into agent context via this hook.
    // The best we can do is show it to the user via user_message.
    if (result.message) {
      return JSON.stringify({
        continue: true,
        user_message: result.message,
      });
    }

    return JSON.stringify({ continue: true });
  },

  formatSessionStart(_result: HookResult): string {
    // Cursor has no SessionStart equivalent — the resume strip falls back
    // to first-tool-call injection via Surface 1 (`unerr » ` lines on the
    // first MCP response).
    return "{}";
  },
};
