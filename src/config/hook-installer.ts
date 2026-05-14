/**
 * Hook Installer — installs CLI hooks for Claude Code PostToolUse.
 *
 * R.4: Generates .claude/hooks/PostToolUse.sh that pipes command output
 * through `unerr compress-output` for graph-aware compression.
 *
 * The hook intercepts tool output, compresses it, and returns the compressed
 * version to the agent — reducing context window usage by 60-90%.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const HOOK_CONTENT = `#!/bin/bash
# unerr PostToolUse hook — graph-aware output compression
# Installed by: unerr init
# Removes: unerr uninstall

# Only compress large outputs (>2KB)
if [ \${#TOOL_OUTPUT} -gt 2048 ]; then
  echo "$TOOL_OUTPUT" | unerr compress-output
else
  echo "$TOOL_OUTPUT"
fi
`;

export interface HookInstallResult {
  path: string;
  action: "installed" | "already_exists" | "failed";
}

/**
 * Install the PostToolUse hook for Claude Code.
 */
export function installClaudeHook(cwd: string): HookInstallResult {
  const hooksDir = join(cwd, ".claude", "hooks");
  const hookPath = join(hooksDir, "PostToolUse.sh");

  if (existsSync(hookPath)) {
    return { path: hookPath, action: "already_exists" };
  }

  try {
    if (!existsSync(hooksDir)) {
      mkdirSync(hooksDir, { recursive: true });
    }

    writeFileSync(hookPath, HOOK_CONTENT, "utf-8");
    chmodSync(hookPath, 0o755);

    return { path: hookPath, action: "installed" };
  } catch {
    return { path: hookPath, action: "failed" };
  }
}

/**
 * Remove the PostToolUse hook.
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
