/**
 * GitHub Copilot CLI hook adapter.
 *
 * Protocol (GitHub Copilot CLI hooks, config v1):
 *   stdin:  { hookType: "preToolUse"|"postToolUse"|"sessionStart"|"userPromptSubmitted",
 *             toolName: "Edit"|"Write"|"view"|"grep"|"glob"|"bash",
 *             toolArgs: {...}, hookVersion: 1 }
 *   stdout (preToolUse):
 *     - deny:    { permissionDecision: "deny", reason: "..." }
 *     - rewrite: { permissionDecision: "allow", modifiedArgs: {...} }
 *     - nudge:   { permissionDecision: "allow", additionalContext: "..." }
 *   stdout (postToolUse):
 *     - enrich:  { additionalContext: "..." }
 *     - rewrite: { modifiedResult: "..." }
 *   stdout (sessionStart):
 *     - enrich:  { additionalContext: "..." }
 *
 * Detection: Copilot CLI sends hookType (camelCase) + hookVersion (number).
 * Full-parity agent: deny + rewrite + inject (via postToolUse additionalContext).
 */

import type {
  HookAdapter,
  HookResult,
  NormalizedPayload,
} from "../hook-runner.js";

const COPILOT_TOOL_MAP: Record<string, string> = {
  view: "Read",
  grep: "Grep",
  glob: "Glob",
  bash: "Bash",
  Edit: "Edit",
  Write: "Write",
};

export const copilotCliAdapter: HookAdapter = {
  name: "github-copilot-cli",

  detect(payload: Record<string, unknown>): boolean {
    return (
      typeof payload.hookType === "string" &&
      typeof payload.hookVersion === "number"
    );
  },

  normalize(payload: Record<string, unknown>): NormalizedPayload {
    const toolArgs = (payload.toolArgs ?? payload.args ?? {}) as Record<
      string,
      unknown
    >;
    const rawToolName = payload.toolName as string | undefined;
    const toolName = rawToolName
      ? (COPILOT_TOOL_MAP[rawToolName] ?? rawToolName)
      : undefined;
    const hookType = payload.hookType as string | undefined;

    const toolInput: Record<string, unknown> = { ...toolArgs };
    if (toolInput.path && !toolInput.file_path) {
      toolInput.file_path = toolInput.path;
    }

    let event: NormalizedPayload["event"];
    if (hookType === "preToolUse") event = "PreToolUse";
    else if (hookType === "postToolUse") event = "PostToolUse";
    else if (hookType === "userPromptSubmitted") event = "UserPromptSubmit";
    else if (hookType === "sessionStart") event = "SessionStart";

    return { raw: payload, toolInput, toolName, event };
  },

  formatPreToolUse(result: HookResult): string {
    if (result.action === "passthrough") return "{}";

    if (result.action === "deny") {
      return JSON.stringify({
        permissionDecision: "deny",
        reason: result.message ?? "Blocked by unerr policy.",
      });
    }

    if (result.action === "nudge" && result.message) {
      return JSON.stringify({
        permissionDecision: "allow",
        additionalContext: result.message,
      });
    }

    if (result.action === "rewrite" && result.updatedInput) {
      return JSON.stringify({
        permissionDecision: "allow",
        modifiedArgs: result.updatedInput,
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
      return JSON.stringify({ additionalContext: result.message });
    }

    return "{}";
  },

  formatPromptSubmit(_result: HookResult): string {
    // userPromptSubmitted is read-only — cannot inject context.
    return "{}";
  },

  formatSessionStart(result: HookResult): string {
    if (result.action === "passthrough") return "{}";

    if (result.message) {
      return JSON.stringify({ additionalContext: result.message });
    }

    return "{}";
  },

  formatStop(_result: HookResult): string {
    return "{}";
  },
};
