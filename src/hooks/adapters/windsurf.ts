/**
 * Windsurf (Devin Desktop) hook adapter.
 *
 * Protocol (.windsurf/hooks.json, 12 events):
 *   Exit-code protocol: exit 0 = proceed, exit 2 = block (pre-hooks only).
 *   No input rewrite capability — only allow/deny.
 *   Events: pre_write_code, pre_read_code, pre_run_command,
 *     pre_mcp_tool_use, post_mcp_tool_use, pre_user_prompt,
 *     post_cascade_response, etc.
 *
 * Detection: Windsurf sends cascade_id or event_type starting with pre_/post_.
 * Deny+inject tier: no session-start hook, no rewrite.
 * Note recall rides .windsurf/rules/*.md always_on.
 */

import type {
  HookAdapter,
  HookResult,
  NormalizedPayload,
} from "../hook-runner.js";

const EVENT_MAP: Record<string, NormalizedPayload["event"]> = {
  pre_write_code: "PreToolUse",
  pre_read_code: "PreToolUse",
  pre_run_command: "PreToolUse",
  pre_mcp_tool_use: "PreToolUse",
  post_mcp_tool_use: "PostToolUse",
  post_read_code: "PostToolUse",
  post_write_code: "PostToolUse",
  pre_user_prompt: "UserPromptSubmit",
  post_cascade_response: "Stop",
};

const TOOL_MAP: Record<string, string> = {
  pre_write_code: "Edit",
  pre_read_code: "Read",
  pre_run_command: "Bash",
  post_write_code: "Edit",
  post_read_code: "Read",
};

export const windsurfAdapter: HookAdapter = {
  name: "windsurf",

  detect(payload: Record<string, unknown>): boolean {
    const eventType = payload.event_type as string | undefined;
    const hasWindsurfMarker =
      typeof payload.cascade_id === "string" ||
      typeof payload.windsurf_event === "string" ||
      (typeof eventType === "string" &&
        (eventType.startsWith("pre_") || eventType.startsWith("post_")));
    return (
      hasWindsurfMarker &&
      typeof payload.hook_event_name !== "string" &&
      typeof payload.hookType !== "string" &&
      typeof payload.tool_name !== "string"
    );
  },

  normalize(payload: Record<string, unknown>): NormalizedPayload {
    const eventType = (payload.event_type ??
      payload.windsurf_event ??
      "") as string;
    const event = EVENT_MAP[eventType];
    const toolName =
      TOOL_MAP[eventType] ?? (payload.mcp_tool as string | undefined);

    const toolInput: Record<string, unknown> = {};
    if (payload.file_path) toolInput.file_path = payload.file_path;
    if (payload.command) toolInput.command = payload.command;
    if (payload.content) toolInput.content = payload.content;
    if (payload.old_content) toolInput.old_string = payload.old_content;
    if (payload.new_content) toolInput.new_string = payload.new_content;

    return { raw: payload, toolInput, toolName, event };
  },

  formatPreToolUse(result: HookResult): string {
    if (result.action === "passthrough") return "{}";

    // Signal deny through a structured response — the hook script wrapper
    // translates _windsurf_exit:2 to process.exit(2).
    if (result.action === "deny") {
      return JSON.stringify({
        _windsurf_exit: 2,
        reason: result.message ?? "Blocked by unerr policy.",
      });
    }

    if (result.action === "nudge" && result.message) {
      return JSON.stringify({ _windsurf_stderr: result.message });
    }

    if (result.action === "rewrite") {
      return JSON.stringify({
        _windsurf_exit: 2,
        reason:
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
      return JSON.stringify({ _windsurf_stderr: result.message });
    }

    return "{}";
  },

  formatPromptSubmit(result: HookResult): string {
    if (result.action === "passthrough") return "{}";

    if (result.message) {
      return JSON.stringify({ _windsurf_stderr: result.message });
    }

    return "{}";
  },

  formatSessionStart(_result: HookResult): string {
    return "{}";
  },

  formatStop(result: HookResult): string {
    if (result.action === "passthrough") return "{}";

    if (
      (result.action === "enrich" || result.action === "nudge") &&
      result.message
    ) {
      return JSON.stringify({ _windsurf_stderr: result.message });
    }

    return "{}";
  },
};
