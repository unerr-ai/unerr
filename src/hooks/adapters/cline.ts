/**
 * Cline hook adapter (v3.36 IDE-Hooks protocol).
 *
 * Protocol (.clinerules/hooks/, VS Code, macOS/Linux):
 *   stdin:  { tool: "read_file", params: { path: "..." }, event: "PreToolUse"|"PostToolUse"|"UserPromptSubmit"|"TaskStart" }
 *   stdout (PreToolUse):
 *     - passthrough: {}
 *     - deny:        { cancel: true, reason: "..." }
 *     - nudge:       { contextModification: "..." }
 *   stdout (PostToolUse):
 *     - passthrough: {}
 *     - enrich:      { contextModification: "..." }
 *   stdout (UserPromptSubmit):
 *     - passthrough: {}
 *     - enrich:      { contextModification: "..." }
 *   stdout (TaskStart):
 *     - passthrough: {}
 *     - enrich:      { contextModification: "..." }
 *
 * v3.36 changes from earlier protocol:
 *   - cancel:true replaces allow:false for denying tool calls
 *   - contextModification replaces context for injecting agent context
 *   - PascalCase event names (PreToolUse, not pre_tool)
 *   - UserPromptSubmit + TaskStart events added
 *
 * Detection: Cline sends tool (snake_case) + params at root.
 * No input rewrite — cancel + contextModification only.
 */

import type {
  HookAdapter,
  HookResult,
  NormalizedPayload,
} from "../hook-runner.js";

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
    return (
      typeof payload.tool === "string" &&
      typeof payload.params === "object" &&
      payload.params !== null &&
      typeof payload.hook_event_name !== "string" &&
      typeof payload.hookType !== "string" &&
      typeof payload.toolName !== "string"
    );
  },

  normalize(payload: Record<string, unknown>): NormalizedPayload {
    const params = (payload.params ?? {}) as Record<string, unknown>;
    const clineTool = payload.tool as string;
    const toolName = CLINE_TOOL_MAP[clineTool] ?? clineTool;

    const toolInput: Record<string, unknown> = { ...params };
    if (toolInput.path && !toolInput.file_path) {
      toolInput.file_path = toolInput.path;
    }
    if (toolInput.regex && !toolInput.pattern) {
      toolInput.pattern = toolInput.regex;
    }

    let event: NormalizedPayload["event"];
    const clineEvent = payload.event as string | undefined;
    // v3.36 uses PascalCase; support legacy snake_case for backward compat
    if (clineEvent === "PreToolUse" || clineEvent === "pre_tool")
      event = "PreToolUse";
    else if (clineEvent === "PostToolUse" || clineEvent === "post_tool")
      event = "PostToolUse";
    else if (clineEvent === "UserPromptSubmit") event = "UserPromptSubmit";
    else if (clineEvent === "TaskStart") event = "SessionStart";

    return { raw: payload, toolInput, toolName, event };
  },

  formatPreToolUse(result: HookResult): string {
    if (result.action === "passthrough") return "{}";

    if (result.action === "deny") {
      return JSON.stringify({
        cancel: true,
        reason: result.message ?? "Blocked by unerr policy.",
      });
    }

    if (result.action === "nudge" && result.message) {
      return JSON.stringify({
        contextModification: result.message,
      });
    }

    if (result.action === "rewrite") {
      return JSON.stringify({
        contextModification:
          "Route this command through `unerr exec` for shell compression.",
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
      return JSON.stringify({ contextModification: result.message });
    }

    return "{}";
  },

  formatPromptSubmit(result: HookResult): string {
    if (result.action === "passthrough") return "{}";

    if (result.message) {
      return JSON.stringify({ contextModification: result.message });
    }

    return "{}";
  },

  formatSessionStart(result: HookResult): string {
    if (result.action === "passthrough") return "{}";

    if (result.message) {
      return JSON.stringify({ contextModification: result.message });
    }

    return "{}";
  },

  formatStop(_result: HookResult): string {
    return "{}";
  },
};
