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

import { getUnerrCommand } from "../config/mcp-config-writer.js";
import { formatDriftNudge, isDriftCommand } from "../proxy/drift-detector.js";
import { readNudgeState, updateNudgeState } from "../proxy/nudge-state.js";
import { normalizeShellCommand } from "../proxy/shell-classifier.js";
import { recordDelegationHandoff } from "../tracking/delegation-handoff.js";
import { classifyCheckCommand } from "./check-tracker.js";
import {
  type HookHandler,
  passthrough,
  rewrite,
  runPostToolUseHook,
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
  if (
    n.startsWith("unerr exec") ||
    n.startsWith("npx unerr exec") ||
    /[/\\]unerr exec/.test(n)
  ) {
    return passthrough();
  }

  const bin = getUnerrCommand();

  if (/[\n"'`(){}$\\;<>|&!~*?]/.test(cmd)) {
    const b64 = Buffer.from(cmd, "utf-8").toString("base64");
    return rewrite({ command: `${bin} exec --b64 ${b64}` });
  }

  return rewrite({ command: `${bin} exec -- ${cmd}` });
};

/**
 * Read hook JSON from stdin, rewrite Bash command to run through `unerr exec`.
 * Returns JSON string for stdout, or passthrough response.
 */
export function runPreBashHook(stdinJson: string): string {
  return runPreToolUseHook(stdinJson, preBashHandler);
}

// ── Verification awareness (W4) — PostToolUse(Bash) ───────────────────────

/**
 * Agent-agnostic PostToolUse(Bash) handler for verification awareness (W4). A
 * command classified as a real check/test/build/typecheck runner
 * (`classifyCheckCommand`) stamps `check_cmd_last_ts` in nudge-state so the
 * Stop hook can tell whether this turn's edits were verified. Never throws —
 * any failure degrades to passthrough.
 *
 */
const postBashHandler: HookHandler = (normalized) => {
  try {
    const input = normalized.toolInput;
    const cmd =
      typeof input.command === "string"
        ? input.command
        : typeof input.shell_command === "string"
          ? (input.shell_command as string)
          : "";
    if (!cmd.trim()) return passthrough();

    const cwd = process.cwd();

    if (classifyCheckCommand(cmd)) {
      updateNudgeState(cwd, (s) => {
        s.check_cmd_count += 1;
        s.check_cmd_last_ts = Date.now();
      });
    }

    return passthrough();
  } catch {
    return passthrough();
  }
};

/**
 * Read hook JSON from stdin, classify the Bash command that just ran, and
 * record/nudge per {@link postBashHandler}. Returns JSON string for stdout.
 */
export function runPostBashHook(stdinJson: string): string {
  return runPostToolUseHook(stdinJson, postBashHandler);
}

/**
 * Drift nudge for shell hooks that CANNOT rewrite the command to `unerr exec`
 * (Cursor's `beforeShellExecution`, and by extension any agent whose shell hook
 * only returns allow/deny + a message). The payload is the flat
 * `{command, cwd, sandbox}` shape Cursor sends — NOT the PreToolUse
 * `{tool_name, tool_input}` shape the adapter runner expects — so this handler
 * parses + emits Cursor's native schema directly instead of going through
 * runPreToolUseHook. When the command is a code-nav drift (grep/sed/which on
 * code), it surfaces the unerr-tool redirect as `agent_message`, rate-limited
 * once per drift kind per session via the SAME nudge-state the exec-path nudge
 * uses (so a rewrite-capable host never double-nudges). Always allows the
 * command (fail-open) — the nudge is advisory, never a block.
 */
export function runPreShellHook(stdinJson: string): string {
  const allow = JSON.stringify({ permission: "allow" });
  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(stdinJson.trim()) as Record<string, unknown>;
  } catch {
    return allow;
  }

  const cmd =
    typeof payload?.command === "string"
      ? payload.command
      : typeof payload?.shell_command === "string"
        ? (payload.shell_command as string)
        : "";
  const n = normalizeShellCommand(cmd);
  if (
    !n ||
    n.startsWith("unerr exec") ||
    n.startsWith("npx unerr exec") ||
    /[/\\]unerr exec/.test(n)
  ) {
    return allow;
  }

  // Cross-agent delegation meter: Cursor / Copilot can't rewrite the command to
  // `unerr exec`, so a cheaper-model handoff (`cursor-agent -p -m …`,
  // `copilot … --model …`) surfaces here as the raw command. Record the
  // delegation savings family before the drift check (a handoff is never a drift
  // command, so it would otherwise fall straight through). Best-effort, no-op
  // when the command is not a handoff.
  recordDelegationHandoff(process.cwd(), cmd);

  const hint = isDriftCommand(cmd);
  if (!hint) return allow;

  const cwd = process.cwd();
  try {
    if (readNudgeState(cwd).tier1_emitted_kinds.includes(hint.kind)) {
      return allow;
    }
    updateNudgeState(cwd, (s) => {
      if (!s.tier1_emitted_kinds.includes(hint.kind)) {
        s.tier1_emitted_kinds.push(hint.kind);
      }
      s.drift_count += 1;
    });
  } catch {
    // nudge-state unavailable (read-only fs / first run) — still nudge once.
  }

  return JSON.stringify({
    permission: "allow",
    agent_message: formatDriftNudge(hint),
  });
}
