/**
 * Cline hook adapter.
 *
 * Protocol (Cline extension hooks):
 *   stdin:  { tool: "read_file", params: { path: "..." }, event: "pre_tool" | "post_tool" }
 *   stdout (PreToolUse):
 *     - passthrough: { allow: true }
 *     - nudge:       { allow: true, context: "..." }
 *     - deny:        { allow: false, reason: "..." }  (not used by unerr — never block)
 *   stdout (PostToolUse):
 *     - passthrough: {}
 *     - enrich:      { context: "..." }
 *   stdout (UserPromptSubmit):
 *     - passthrough: {}
 *     - enrich:      { context: "..." }
 *
 * Detection: Cline sends `tool` (lowercase, snake_case tool name) + `params` at root.
 */

import type {
  HookAdapter,
  HookResult,
  NormalizedPayload,
} from "../hook-runner.js";

/** Map Cline tool names to normalized tool names. */
const CLINE_TOOL_MAP: Record<string, string> = {
  read_file: "Read",
  write_to_file: "Write",
  replace_in_file: "Edit",
  search_files: "Grep",
  list_files: "Glob",
  execute_command: "Bash",
};

export const clineAdapter: HookAdapter = {
  name: "cline",

  detect(payload: Record<string, unknown>): boolean {
    // Cline sends `tool` (string) + `params` (object) at root
    // Distinguish from Claude Code (has hook_event_name) and Cursor (has toolName)
    return (
      typeof payload.tool === "string" &&
      typeof payload.params === "object" &&
      payload.params !== null &&
      typeof payload.hook_event_name !== "string" &&
      typeof payload.toolName !== "string"
    );
  },

  normalize(payload: Record<string, unknown>): NormalizedPayload {
    const params = (payload.params ?? {}) as Record<string, unknown>;
    const clineTool = payload.tool as string;
    const toolName = CLINE_TOOL_MAP[clineTool] ?? clineTool;

    // Normalize Cline's param names to match our expectations
    const toolInput: Record<string, unknown> = { ...params };
    // Cline uses `path` instead of `file_path`
    if (toolInput.path && !toolInput.file_path) {
      toolInput.file_path = toolInput.path;
    }
    // Cline uses `regex` instead of `pattern`
    if (toolInput.regex && !toolInput.pattern) {
      toolInput.pattern = toolInput.regex;
    }
    // Cline uses `command` for execute_command
    // (already matches our expected format)

    // Map Cline event names
    let event: NormalizedPayload["event"];
    const clineEvent = payload.event as string | undefined;
    if (clineEvent === "pre_tool") event = "PreToolUse";
    else if (clineEvent === "post_tool") event = "PostToolUse";

    return { raw: payload, toolInput, toolName, event };
  },

  formatPreToolUse(result: HookResult): string {
    if (result.action === "passthrough") {
      return JSON.stringify({ allow: true });
    }

    if (result.action === "nudge" && result.message) {
      return JSON.stringify({
        allow: true,
        context: result.message,
      });
    }

    if (result.action === "rewrite" && result.updatedInput) {
      // Cline doesn't support input rewriting directly — allow with context
      return JSON.stringify({
        allow: true,
        context: "Suggested rewrite: use unerr exec for this command.",
      });
    }

    return JSON.stringify({ allow: true });
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

  formatPromptSubmit(result: HookResult): string {
    if (result.action === "passthrough") return "{}";

    if (result.message) {
      return JSON.stringify({ context: result.message });
    }

    return "{}";
  },
};
