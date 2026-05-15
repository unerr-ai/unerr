/**
 * `unerr uninstall [agent]` — removes generated configs, skills, hooks, and instructions.
 *
 * Two modes:
 *   - `unerr uninstall claude` — per-agent: reverts exactly what `unerr install claude` did
 *   - `unerr uninstall` (no args) — removes all agents' configs
 *
 * Does NOT remove:
 *   - .unerr/ data directory (user's indexed data)
 *   - .gitignore entries (shared across agents)
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import {
  AGENT_REGISTRY,
  getAgent,
  normalizeAgentName,
} from "../config/agent-registry.js";
import {
  removeDisallowedTools,
  removePreToolUseBashHook,
} from "../config/claude-settings-hooks.js";
import { removeClaudeHook } from "../config/hook-installer.js";
import { removeInstructionSection } from "../config/instruction-writer.js";
import { removeMcpConfig } from "../config/mcp-config-writer.js";
import { removeInstalledSkills } from "../skills/resolver.js";
import type { IdeType } from "../utils/detect.js";

interface UninstallResult {
  mcpRemoved: boolean;
  skillsRemoved: number;
  hookRemoved: boolean;
  settingsHookRemoved: boolean;
  instructionsRemoved: boolean;
  /** S8: Whether disallowed tool entries were removed. */
  disallowedToolsRemoved: boolean;
}

export function registerUninstallCommand(program: Command): void {
  program
    .command("uninstall [agent]")
    .description("Remove unerr configs and hooks from this project")
    .option(
      "--autostart",
      "Remove the platform auto-start service (launchd/systemd/schtasks)"
    )
    .action(
      async (agent: string | undefined, opts: { autostart?: boolean }) => {
        const cwd = process.cwd();

        if (opts.autostart) {
          try {
            const { uninstallForCurrentPlatform, removeSentinel } =
              await import("../daemon/autostart.js");
            const result = await uninstallForCurrentPlatform();
            removeSentinel();
            process.stderr.write(
              `\x1b[38;2;52;211;153m✓\x1b[0m Platform auto-start removed${result.error ? ` (note: ${result.error})` : ""}\n`
            );
          } catch (err) {
            process.stderr.write(
              `\x1b[38;2;248;113;113m✗\x1b[0m Failed to remove auto-start: ${(err as Error).message}\n`
            );
          }
          return;
        }

        if (agent) {
          const normalized = normalizeAgentName(agent);
          const agentDef = getAgent(normalized as IdeType);
          if (!agentDef) {
            process.stderr.write(
              `\x1b[31m✗\x1b[0m Unknown agent: "${agent}"\n`
            );
            return;
          }
          const result = runUninstall(cwd, normalized as IdeType);
          displayUninstallResult(agentDef.name, result);
        } else {
          runUninstallAll(cwd);
        }

        // Hint about autostart removal
        try {
          const { isAutostartInstalled } = await import(
            "../daemon/autostart.js"
          );
          if (isAutostartInstalled()) {
            process.stderr.write(
              "\n  \x1b[38;2;251;191;36m⚠\x1b[0m Platform auto-start is still active. Remove with: unerr uninstall --autostart\n\n"
            );
          }
        } catch {
          // Non-blocking
        }
      }
    );
}

/**
 * Uninstall unerr for a single agent — symmetric to runInstall().
 */
function runUninstall(cwd: string, ide: IdeType): UninstallResult {
  // 1. Remove MCP config
  const mcpRemoved = removeMcpConfig(cwd, ide);

  // 2. Remove skills
  let skillsRemoved = 0;
  try {
    skillsRemoved = removeInstalledSkills(ide, cwd);
  } catch {
    // Non-blocking
  }

  // 3. Remove hooks (agent-specific)
  let hookRemoved = false;
  let settingsHookRemoved = false;
  if (ide === "claude-code") {
    hookRemoved = removeClaudeHook(cwd);
    settingsHookRemoved = removePreToolUseBashHook(cwd);
  } else if (ide === "cursor") {
    hookRemoved = removeCursorHooks(cwd);
  } else if (ide === "cline") {
    hookRemoved = removeClineHooks(cwd);
  }

  // 4. Gitignore — NOT reverted (shared across agents, .unerr/ data preserved)

  // 5. Remove instructions
  let instructionsRemoved = false;
  try {
    instructionsRemoved = removeInstructionSection(cwd, ide);
  } catch {
    // Non-blocking
  }

  // 6. S8: Remove disallowed tool entries (Claude Code only)
  let disallowedToolsRemoved = false;
  if (ide === "claude-code") {
    try {
      disallowedToolsRemoved = removeDisallowedTools(cwd);
    } catch {
      // Non-blocking
    }
  }

  return {
    mcpRemoved,
    skillsRemoved,
    hookRemoved,
    settingsHookRemoved,
    instructionsRemoved,
    disallowedToolsRemoved,
  };
}

/**
 * Display per-agent uninstall results (matches install's ANSI style).
 */
function displayUninstallResult(
  agentName: string,
  result: UninstallResult
): void {
  process.stderr.write("\n");
  process.stderr.write(
    `  \x1b[38;2;139;92;246m◆\x1b[0m \x1b[1munerr ✗ ${agentName}\x1b[0m\n`
  );
  process.stderr.write("\n");

  const nothingRemoved =
    !result.mcpRemoved &&
    result.skillsRemoved === 0 &&
    !result.hookRemoved &&
    !result.settingsHookRemoved &&
    !result.instructionsRemoved &&
    !result.disallowedToolsRemoved;

  if (nothingRemoved) {
    process.stderr.write(
      "  \x1b[38;2;161;161;170m· Nothing to uninstall\x1b[0m\n"
    );
  } else {
    if (result.mcpRemoved) {
      process.stderr.write(
        "  \x1b[38;2;52;211;153m✓\x1b[0m MCP config removed\n"
      );
    }
    if (result.skillsRemoved > 0) {
      process.stderr.write(
        `  \x1b[38;2;52;211;153m✓\x1b[0m ${result.skillsRemoved} skills removed\n`
      );
    }
    if (result.hookRemoved) {
      process.stderr.write(
        "  \x1b[38;2;52;211;153m✓\x1b[0m PostToolUse hook removed\n"
      );
    }
    if (result.settingsHookRemoved) {
      process.stderr.write(
        "  \x1b[38;2;52;211;153m✓\x1b[0m PreToolUse settings hook removed\n"
      );
    }
    if (result.instructionsRemoved) {
      process.stderr.write(
        "  \x1b[38;2;52;211;153m✓\x1b[0m Tool preferences removed\n"
      );
    }
    if (result.disallowedToolsRemoved) {
      process.stderr.write(
        "  \x1b[38;2;52;211;153m✓\x1b[0m Disallowed tools restored\n"
      );
    }
  }

  process.stderr.write("\n");
  process.stderr.write(
    "  \x1b[38;2;161;161;170mData in .unerr/ preserved.\x1b[0m\n"
  );
  process.stderr.write("\n");
}

/**
 * Uninstall all agents — enhanced version of original behavior.
 */
function runUninstallAll(cwd: string): void {
  const results: string[] = [];

  for (const agent of AGENT_REGISTRY) {
    const r = runUninstall(cwd, agent.id as IdeType);
    if (r.mcpRemoved) results.push(`Removed MCP config for ${agent.id}`);
    if (r.skillsRemoved > 0)
      results.push(`Removed ${r.skillsRemoved} skills for ${agent.id}`);
    if (r.hookRemoved) results.push("Removed PostToolUse hook");
    if (r.settingsHookRemoved) results.push("Removed PreToolUse settings hook");
    if (r.instructionsRemoved)
      results.push(`Removed instructions for ${agent.id}`);
    if (r.disallowedToolsRemoved)
      results.push("Restored disallowed built-in tools");
  }

  if (results.length === 0) {
    process.stderr.write("[unerr] Nothing to uninstall — no configs found.\n");
  } else {
    for (const r of results) {
      process.stderr.write(`[unerr] ${r}\n`);
    }
    process.stderr.write(
      "[unerr] Uninstall complete. Data in .unerr/ preserved.\n"
    );
  }
}

/**
 * Remove unerr hook entries from Cursor's `.cursor/hooks.json`.
 */
function removeCursorHooks(cwd: string): boolean {
  const hooksPath = join(cwd, ".cursor", "hooks.json");
  if (!existsSync(hooksPath)) return false;

  try {
    const config = JSON.parse(readFileSync(hooksPath, "utf-8")) as Record<
      string,
      unknown
    >;
    if (!Array.isArray(config.hooks)) return false;

    const before = (config.hooks as unknown[]).length;
    config.hooks = (config.hooks as unknown[]).filter(
      (h) => (h as Record<string, unknown>)?.name !== "unerr-graph-tools"
    );
    if ((config.hooks as unknown[]).length === before) return false;

    if ((config.hooks as unknown[]).length === 0) {
      unlinkSync(hooksPath);
    } else {
      writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove unerr hook scripts from Cline's `.clinerules/hooks/`.
 */
function removeClineHooks(cwd: string): boolean {
  const hookPath = join(cwd, ".clinerules", "hooks", "unerr-pre-tool.sh");
  if (!existsSync(hookPath)) return false;

  try {
    unlinkSync(hookPath);
    return true;
  } catch {
    return false;
  }
}
