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

import {
  existsSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
import { loadSettings } from "../config/settings.js";
import { DEFAULT_SENTINEL_TOKENS } from "../intelligence/semantic/docstring-extractor.js";
import { stripAnnotationsFromRepo } from "../intelligence/semantic/strip-annotations.js";
import { removeInstalledSkills } from "../skills/resolver.js";
import { uninstallReviewGateHooks } from "../tracking/review-gate-hooks.js";
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
      "--strip-annotations",
      "also remove @sem sentinel lines from source comments repo-wide (prose summaries are kept)"
    )
    .action(
      async (
        agent: string | undefined,
        opts: { stripAnnotations?: boolean }
      ) => {
        const cwd = process.cwd();

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

        if (opts.stripAnnotations) {
          stripAnnotationsAndReport(cwd);
        }
      }
    );
}

/**
 * Layer 8 §2.1.1 exit story — strip `@sem` sentinel lines from source comments
 * repo-wide. Sentinel tokens come from `comments.sentinel` (default `@sem`);
 * prose summaries are preserved. Idempotent: a clean repo reports 0 changes.
 */
function stripAnnotationsAndReport(cwd: string): void {
  let tokens = DEFAULT_SENTINEL_TOKENS;
  try {
    const configured = loadSettings(cwd).comments.sentinel;
    if (configured.length > 0) tokens = configured;
  } catch {
    tokens = DEFAULT_SENTINEL_TOKENS;
  }
  const { filesChanged, linesRemoved } = stripAnnotationsFromRepo(cwd, tokens);
  if (filesChanged === 0) {
    process.stderr.write(
      "\x1b[32m✓\x1b[0m No @sem sentinel lines found — nothing to strip.\n"
    );
    return;
  }
  process.stderr.write(
    `\x1b[32m✓\x1b[0m Stripped ${linesRemoved} @sem sentinel line${
      linesRemoved === 1 ? "" : "s"
    } from ${filesChanged} file${
      filesChanged === 1 ? "" : "s"
    } (prose summaries kept; review the diff with \`git diff\`).\n`
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
  } else if (ide === "windsurf") {
    hookRemoved = removeWindsurfHooks(cwd);
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

  // 7. Prune now-empty agent directories the install created. `rmdirSync`
  // refuses to remove non-empty dirs, so user-authored files are safe.
  pruneAgentDirs(cwd, ide);

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
 * Best-effort prune of empty parent directories for a single agent.
 * Touches only paths the install would have created. `rmdirSync` errors
 * silently when a directory still holds user files, so this is safe to
 * run across every agent without coordination.
 */
function pruneAgentDirs(cwd: string, ide: IdeType): void {
  const agent = AGENT_REGISTRY.find((a) => a.id === ide);
  if (!agent) return;

  const candidates = new Set<string>();
  // Parent of the project-scoped MCP config (global configs are co-owned).
  if (agent.configScope !== "global") {
    candidates.add(dirname(join(cwd, agent.projectConfigPath)));
  }
  // Parent of the instruction file (e.g., .agents/rules/, .windsurf/rules/).
  if (agent.instructionFilePath) {
    candidates.add(dirname(join(cwd, agent.instructionFilePath)));
  }
  // The agent's own marker directories (e.g., .antigravity, .agents).
  for (const marker of agent.dirMarkers ?? []) {
    candidates.add(join(cwd, marker));
  }

  // Walk inside-out: skills/rules first, then the agent root.
  const ordered = [...candidates].sort((a, b) => b.length - a.length);
  for (const path of ordered) {
    if (path === cwd) continue;
    try {
      rmdirSync(path);
    } catch {
      /* dir not empty (user files inside) or already gone */
    }
  }
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

  // Review-gate git hooks are agent-independent (opt-in, shared) — remove them
  // on a full uninstall regardless of which agents were configured.
  uninstallReviewGateHooks(cwd);

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
 * Remove unerr hook entries from Windsurf Cascade's `.windsurf/hooks.json`
 * and delete the four `.windsurf/hooks/unerr-*.sh` scripts. Symmetric to
 * `installWindsurfHooks`. Empty `hooks.json` is unlinked; the `hooks/` dir
 * is removed only when empty (other user scripts stay put).
 */
function removeWindsurfHooks(cwd: string): boolean {
  const hooksJsonPath = join(cwd, ".windsurf", "hooks.json");
  const hooksDir = join(cwd, ".windsurf", "hooks");
  let changed = false;

  // Strip unerr entries out of hooks.json. Match by command path so
  // user-authored hooks pointing at other scripts are preserved.
  if (existsSync(hooksJsonPath)) {
    try {
      const config = JSON.parse(readFileSync(hooksJsonPath, "utf-8")) as {
        hooks?: Record<string, Array<{ command?: string }>>;
      };
      const hooks = config.hooks ?? {};
      let anyChanged = false;
      for (const [event, entries] of Object.entries(hooks)) {
        if (!Array.isArray(entries)) continue;
        const filtered = entries.filter(
          (h) => !(h.command ?? "").includes(".windsurf/hooks/unerr-")
        );
        if (filtered.length !== entries.length) {
          anyChanged = true;
          if (filtered.length === 0) {
            delete hooks[event];
          } else {
            hooks[event] = filtered;
          }
        }
      }
      if (anyChanged) {
        changed = true;
        if (Object.keys(hooks).length === 0) {
          unlinkSync(hooksJsonPath);
        } else {
          writeFileSync(
            hooksJsonPath,
            `${JSON.stringify({ hooks }, null, 2)}\n`
          );
        }
      }
    } catch {
      /* corrupt or missing — fall through to script cleanup */
    }
  }

  // Drop the four unerr hook scripts. Other user scripts in the same dir
  // are left untouched.
  for (const name of [
    "unerr-pre-tool.sh",
    "unerr-post-tool.sh",
    "unerr-prompt.sh",
    "unerr-pre-shell.sh",
  ]) {
    const p = join(hooksDir, name);
    if (existsSync(p)) {
      try {
        unlinkSync(p);
        changed = true;
      } catch {
        /* best-effort */
      }
    }
  }

  // Prune the hooks/ dir when empty.
  try {
    rmdirSync(hooksDir);
  } catch {
    /* dir not empty or already gone */
  }

  return changed;
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
