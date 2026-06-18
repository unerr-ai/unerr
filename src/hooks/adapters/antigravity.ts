/**
 * Google Antigravity hook adapter.
 *
 * Protocol (.agents/hooks.json):
 *   stdin:  { event: "PreToolUse"|"PostToolUse", tool: "write_to_file"|..., args: {...} }
 *   stdout (PreToolUse):
 *     - allow: { "decision": "allow" }
 *     - deny:  { "decision": "deny", "reason": "..." }
 *     - ask:   { "decision": "ask", "reason": "..." }
 *   stdout (PostToolUse):
 *     - enrich: { "context": "..." }
 *
 * IMPORTANT: JSON-stdout protocol for decisions, NOT exit codes.
 * No input rewrite — only allow/deny/ask.
 * No session-start/prompt hook — note recall rides always-on rules.
 */

import type {
  HookAdapter,
  HookResult,
  NormalizedPayload,
} from "../hook-runner.js";

const ANTIGRAVITY_TOOL_MAP: Record<string, string> = {
  write_to_file: "Write",
  replace_file_content: "Edit",
  view_file: "Read",
  run_command: "Bash",
  search_files: "Grep",
  list_directory: "Glob",
};

export const antigravityAdapter: HookAdapter = {
  name: "antigravity",

  detect(payload: Record<string, unknown>): boolean {
    const event = payload.event as string | undefined;
    return (
      typeof event === "string" &&
      (event === "PreToolUse" || event === "PostToolUse") &&
      typeof payload.tool === "string" &&
      typeof payload.args === "object" &&
      payload.args !== null &&
      typeof payload.hook_event_name !== "string" &&
      typeof payload.hookType !== "string" &&
      typeof payload.cwd !== "string"
    );
  },

  normalize(payload: Record<string, unknown>): NormalizedPayload {
    const args = (payload.args ?? {}) as Record<string, unknown>;
    const rawTool = payload.tool as string;
    const toolName = ANTIGRAVITY_TOOL_MAP[rawTool] ?? rawTool;

    const toolInput: Record<string, unknown> = { ...args };
    if (toolInput.path && !toolInput.file_path) {
      toolInput.file_path = toolInput.path;
    }
    if (toolInput.file && !toolInput.file_path) {
      toolInput.file_path = toolInput.file;
    }

    const event = payload.event as string;
    let hookEvent: NormalizedPayload["event"];
    if (event === "PreToolUse") hookEvent = "PreToolUse";
    else if (event === "PostToolUse") hookEvent = "PostToolUse";

    return { raw: payload, toolInput, toolName, event: hookEvent };
  },

  formatPreToolUse(result: HookResult): string {
    if (result.action === "passthrough") {
      return JSON.stringify({ decision: "allow" });
    }

    if (result.action === "deny") {
      return JSON.stringify({
        decision: "deny",
        reason: result.message ?? "Blocked by unerr policy.",
      });
    }

    if (result.action === "nudge" && result.message) {
      return JSON.stringify({
        decision: "allow",
        context: result.message,
      });
    }

    if (result.action === "rewrite") {
      return JSON.stringify({
        decision: "deny",
        reason:
          result.message ??
          "Route this command through `unerr exec` for shell compression.",
      });
    }

    return JSON.stringify({ decision: "allow" });
  },

  formatPostToolUse(result: HookResult): string {
    if (result.action === "passthrough") return "{}";

    if (
      (result.action === "enrich" || result.action === "nudge") &&
      result.message
    ) {
      return JSON.stringify({ context: result.message });
    }

    return "{}";
  },

  formatPromptSubmit(_result: HookResult): string {
    return "{}";
  },

  formatSessionStart(_result: HookResult): string {
    return "{}";
  },

  formatStop(_result: HookResult): string {
    return "{}";
  },
};
