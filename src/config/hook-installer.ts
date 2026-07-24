/**
 * Hook Installer — removes the legacy Claude Code PostToolUse shell hook.
 *
 * R.4 installed .claude/hooks/PostToolUse.sh to pipe command output through
 * `unerr compress-output`. It was dead weight: Claude Code PostToolUse hooks
 * receive JSON on stdin and never set a $TOOL_OUTPUT env var, so the script
 * always saw an empty string and did nothing. Real compression rides the
 * settings.json hook `unerr hook post-bash` instead. This module no longer
 * installs the shell hook — it only sweeps it from existing users' repos on
 * `unerr uninstall`.
 */

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Remove the legacy PostToolUse.sh hook, if present.
 */
export function removeClaudeHook(cwd: string): boolean {
  const hookPath = join(cwd, ".claude", "hooks", "PostToolUse.sh");
  if (!existsSync(hookPath)) return false;

  try {
    unlinkSync(hookPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the Claude hook is installed.
 */
export function isClaudeHookInstalled(cwd: string): boolean {
  return existsSync(join(cwd, ".claude", "hooks", "PostToolUse.sh"));
}
