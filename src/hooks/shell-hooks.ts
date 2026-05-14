/**
 * Layer 6 Sprint FE-D — PreToolUse stdin/stdout bridge for Bash -> `unerr exec`.
 *
 * Uses the universal hook runner for multi-agent protocol support.
 * Claude Code, Cursor, and Cline all route through the same handler;
 * the adapter layer handles protocol differences.
 *
 * Commands are base64-encoded (`--b64`) to avoid shell re-parsing issues
 * with multi-line commands, nested quotes, and special characters.
 */

import { normalizeShellCommand } from "../proxy/shell-classifier.js";
import {
  type HookHandler,
  passthrough,
  rewrite,
  runPreToolUseHook,
} from "./hook-runner.js";

/**
 * Agent-agnostic Bash rewrite handler.
 * Rewrites shell commands to route through `unerr exec --b64 <base64>`.
 * Base64-encoding preserves quoting, newlines, and special characters
 * that would otherwise break when embedded in a shell command line.
 */
const preBashHandler: HookHandler = (normalized) => {
  const input = normalized.toolInput;
  const cmd =
    typeof input.command === "string"
      ? input.command
      : typeof input.shell_command === "string"
        ? (input.shell_command as string)
        : "";

  if (!normalizeShellCommand(cmd)) return passthrough();

  const n = normalizeShellCommand(cmd);
  if (n.startsWith("unerr exec") || n.startsWith("npx unerr exec")) {
    return passthrough();
  }

  // Base64-encode commands that contain characters unsafe for shell embedding:
  // newlines, quotes, parentheses, backticks, $, {, }, etc.
  // Simple commands (ls, git status) pass through as plain argv for readability.
  if (/[\n"'`(){}$\\;<>|&!~*?]/.test(cmd)) {
    const b64 = Buffer.from(cmd, "utf-8").toString("base64");
    return rewrite({ command: `unerr exec --b64 ${b64}` });
  }

  return rewrite({ command: `unerr exec -- ${cmd}` });
};

/**
 * Read hook JSON from stdin, rewrite Bash command to run through `unerr exec`.
 * Returns JSON string for stdout, or passthrough response.
 */
export function runPreBashHook(stdinJson: string): string {
  return runPreToolUseHook(stdinJson, preBashHandler);
}
