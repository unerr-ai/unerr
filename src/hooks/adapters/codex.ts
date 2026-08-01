/**
 * Codex hook adapter.
 *
 * Protocol (OpenAI Codex CLI hooks):
 *   stdin:  { hook_event_name: "PreToolUse"|"PostToolUse"|"SessionStart"|"UserPromptSubmit",
 *             tool_name: "apply_patch"|"Bash"|..., tool_input: {...} }
 *   stdout (PreToolUse):
 *     - passthrough: {}
 *     - deny:    { hookSpecificOutput: { hookEventName, permissionDecision: "deny", permissionDecisionReason } }
 *     - rewrite: { hookSpecificOutput: { hookEventName, permissionDecision: "allow", updatedInput } }
 *     - nudge:   { hookSpecificOutput: { hookEventName, permissionDecision: "allow", additionalContext } }
 *   stdout (PostToolUse/UserPromptSubmit/SessionStart):
 *     - enrich:  { hookSpecificOutput: { hookEventName, additionalContext } }
 *
 * Detection: Codex shares Claude Code's hookSpecificOutput shape, so detection
 *   keys ONLY on signals Claude Code never sends — `apply_patch` as a tool name,
 *   or `CODEX_SESSION_ID` in env. See {@link CODEX_DISTINCT_TOOLS}.
 *
 * Key limitation: PreToolUse only sees Bash, apply_patch, and MCP tools —
 *   NOT built-in read/grep. Read-routing is AGENTS.md advisory only.
 */

import type {
  HookAdapter,
  HookResult,
  NormalizedPayload,
} from "../hook-runner.js";

const CODEX_TOOL_MAP: Record<string, string> = {
  apply_patch: "Edit",
  Bash: "Bash",
  bash: "Bash",
};

/**
 * Tool names that only Codex sends. `Bash`/`bash` are in {@link CODEX_TOOL_MAP}
 * for normalization but are NOT detection signals: Claude Code sends
 * `tool_name: "Bash"` too, and matching on it routed every Claude Code Bash hook
 * through this adapter. That was invisible while both adapters emitted the same
 * `additionalContext` JSON, and became a silent no-op the moment a result type
 * existed in only one of them (PostToolUse `updatedToolOutput`).
 */
const CODEX_DISTINCT_TOOLS = new Set(["apply_patch"]);

export const codexAdapter: HookAdapter = {
  name: "codex",

  detect(payload: Record<string, unknown>): boolean {
    if (typeof payload.hook_event_name !== "string") return false;
    const toolName = payload.tool_name as string | undefined;
    if (toolName && CODEX_DISTINCT_TOOLS.has(toolName)) return true;
    // Same signal `detectAgent` uses (src/utils/detect.ts) and the one the agent
    // registry records as Codex's identifying env var.
    if (process.env.CODEX_SESSION_ID) return true;
    return false;
  },

  normalize(payload: Record<string, unknown>): NormalizedPayload {
    const toolInput = (payload.tool_input ?? payload.input ?? {}) as Record<
      string,
      unknown
    >;
    const rawToolName = (payload.tool_name ?? payload.toolName) as
      | string
      | undefined;
    const toolName = rawToolName
      ? (CODEX_TOOL_MAP[rawToolName] ?? rawToolName)
      : undefined;
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
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
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

  formatStop(_result: HookResult): string {
    return "{}";
  },
};
