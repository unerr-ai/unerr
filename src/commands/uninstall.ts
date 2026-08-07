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
  rmSync,
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
  removeAgentToolAllows,
  removeDisallowedTools,
  removePreToolUseBashHook,
} from "../config/claude-settings-hooks.js";
import { removeClaudeHook } from "../config/hook-installer.js";
import { removeInstructionSection } from "../config/instruction-writer.js";
import { removeMcpConfig } from "../config/mcp-config-writer.js";
import { removeInstalledSkills } from "../skills/resolver.js";
import { removeSubagents } from "../skills/subagent-manager.js";
import type { IdeType } from "../utils/detect.js";

// Upgrade-path sweep only — not a live surface. Marker the now-removed
// review-gate hook installer used (`review-gate-hooks.ts`).
const REVIEW_GATE_HOOK_MARKER = "# unerr-review-gate";

/**
 * Best-effort migration sweep: `unerr check-commit` (the git pre-commit/post-commit
 * gate command) no longer exists, so a hook installed by the old review-gate
 * installer would otherwise block every future commit. Delete the file when
 * it's entirely ours (only a shebang precedes the marker), or strip our
 * section when the user's hook has other content. Never throws.
 */
function sweepReviewGateHook(hookPath: string): void {
  if (!existsSync(hookPath)) return;
  try {
    const content = readFileSync(hookPath, "utf-8");
    if (
      !content.includes(REVIEW_GATE_HOOK_MARKER) &&
      !content.includes("unerr check-commit")
    ) {
      return; // not ours — leave it
    }
    const markerIdx = content.includes(REVIEW_GATE_HOOK_MARKER)
      ? content.indexOf(REVIEW_GATE_HOOK_MARKER)
      : content.indexOf("unerr check-commit");
    const before = content.slice(0, markerIdx).trimEnd();
    const beforeLines = before.split("\n").filter((l) => l.trim().length > 0);
    if (beforeLines.length <= 1 && (beforeLines[0]?.startsWith("#!") ?? true)) {
      unlinkSync(hookPath);
      return;
    }
    writeFileSync(hookPath, `${before}\n`, { mode: 0o755 });
  } catch {
    /* best effort */
  }
}

/** Remove any pre-commit/post-commit hook left by the removed review-gate installer. */
function sweepReviewGateHooks(projectRoot: string): void {
  sweepReviewGateHook(join(projectRoot, ".git", "hooks", "pre-commit"));
  sweepReviewGateHook(join(projectRoot, ".git", "hooks", "post-commit"));
}

interface UninstallResult {
  mcpRemoved: boolean;
  skillsRemoved: number;
  hookRemoved: boolean;
  settingsHookRemoved: boolean;
  instructionsRemoved: boolean;
  /** S8: Whether disallowed tool entries were removed. */
  disallowedToolsRemoved: boolean;
  /** Whether unerr's sub-agent tool grants were stripped from
   *  `.claude/settings.local.json` `permissions.allow`. */
  agentToolAllowsRemoved: boolean;
}

export function registerUninstallCommand(program: Command): void {
  program
    .command("uninstall [agent]")
    .description("Remove unerr configs and hooks from this project")
    .option(
      "--purge",
      "also delete this repo's .unerr/ data directory (indexed graph, facts, logs)"
    )
    .action(async (agent: string | undefined, opts: { purge?: boolean }) => {
      const cwd = process.cwd();

      if (agent) {
        const normalized = normalizeAgentName(agent);
        const agentDef = getAgent(normalized as IdeType);
        if (!agentDef) {
          process.stderr.write(`\x1b[31m✗\x1b[0m Unknown agent: "${agent}"\n`);
          return;
        }
        const result = runUninstall(cwd, normalized as IdeType);
        displayUninstallResult(agentDef.name, result);
      } else {
        runUninstallAll(cwd);
      }

      // Free the free-tier cap slot: stop the running child + drop the
      // registry row for this repo. Routes through the daemon "remove" RPC
      // when unerrd is up (stop-then-remove), else bare registry removal.
      await unregisterRepoFromPm(cwd);

      // Keep .unerr/ data by default — never destroy user data silently.
      // Only --purge deletes the indexed graph, facts, and logs.
      if (opts.purge) {
        purgeDataDir(cwd);
      }
    });
}

/**
 * Stop this repo's running unerr child and drop its registry row so the
 * free-tier cap slot is freed. Routes through unerrd's "remove" RPC (which
 * stops before unregistering) when the daemon is up; otherwise removes the
 * registry row directly.
 *
 */
async function unregisterRepoFromPm(cwd: string): Promise<void> {
  try {
    const { daemonSockPath, probeDaemon, sendRequest } = await import(
      "../daemon/client.js"
    );
    const sock = daemonSockPath();
    if (await probeDaemon(sock)) {
      try {
        await sendRequest(sock, { cmd: "remove", repo: cwd }, 5_000);
        return;
      } catch {
        // Daemon went away mid-request — fall back to bare removal below.
      }
    }
    const { removeRepo } = await import("../daemon/registry.js");
    if (removeRepo(cwd)) {
      // Daemon-down fallback: ship the `removed` repo_activity event ourselves.
      const { emitRepoRemoved } = await import("../cloud/sync/index.js");
      await emitRepoRemoved(cwd);
    }
  } catch {
    // Registry/daemon unavailable — uninstall still succeeds without it.
  }
}

/**
 * Delete the repo's `.unerr/` data directory. Only called under `--purge`,
 * never by default — the data dir holds the user's indexed graph, facts, and
 * logs, which uninstall preserves unless explicitly told to purge.
 */
function purgeDataDir(cwd: string): void {
  const dataDir = join(cwd, ".unerr");
  if (!existsSync(dataDir)) {
    process.stderr.write(
      "  \x1b[38;2;161;161;170m· No .unerr/ data dir to purge.\x1b[0m\n"
    );
    return;
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
    process.stderr.write(
      "  \x1b[38;2;52;211;153m✓\x1b[0m .unerr/ data directory purged.\n"
    );
  } catch (err) {
    process.stderr.write(
      `  \x1b[38;2;248;113;113m✗\x1b[0m Failed to purge .unerr/: ${(err as Error).message}\n`
    );
  }
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

  // 2b. Remove the delegation sub-agent files (Lever C, Claude Code only).
  if (ide === "claude-code") {
    try {
      removeSubagents(cwd);
    } catch {
      // Non-blocking
    }
    // Upgrade-path sweep only — not a live surface. Sweeps a stale reviewer
    // sub-agent file left by a prior install — the reviewer surface
    // (subagent-manager.ts REVIEWER_* scaffolding) was removed, so the path
    // is inlined here rather than imported.
    try {
      const reviewerPath = join(cwd, ".claude/agents/unerr-reviewer.md");
      if (existsSync(reviewerPath)) {
        rmSync(reviewerPath, { force: true });
      }
    } catch {
      // Non-blocking
    }
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
  } else if (ide === "codex") {
    hookRemoved = removeCodexHooks(cwd);
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

  // 6b: Strip unerr's sub-agent tool grants from settings.local.json (Claude
  // Code only) — revokes the unprompted shell + write grant install added.
  let agentToolAllowsRemoved = false;
  if (ide === "claude-code") {
    try {
      agentToolAllowsRemoved = removeAgentToolAllows(cwd);
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
    agentToolAllowsRemoved,
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
    !result.disallowedToolsRemoved &&
    !result.agentToolAllowsRemoved;

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
    if (result.agentToolAllowsRemoved) {
      process.stderr.write(
        "  \x1b[38;2;52;211;153m✓\x1b[0m Sub-agent tool grants removed from settings.local.json\n"
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

  // Review-gate git hooks are agent-independent (opt-in, shared) — sweep any
  // left by the now-removed review-gate installer regardless of which agents
  // were configured, so a stale hook never blocks a future commit.
  sweepReviewGateHooks(cwd);

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
 * Remove unerr hook entries from Codex's `.codex/hooks.json`. Strips matcher
 * groups whose command runs an `unerr hook` subcommand (so user-authored hooks
 * are preserved), drops any event left empty, and unlinks the file when no hook
 * remains. `.codex/config.toml` (MCP) is untouched. Symmetric to
 * `installCodexHooks`.
 */
export function removeCodexHooks(cwd: string): boolean {
  const hooksPath = join(cwd, ".codex", "hooks.json");
  if (!existsSync(hooksPath)) return false;

  const isUnerrHookCommand = (cmd: string): boolean =>
    /\bunerr\b/.test(cmd) && /\bhook\b/.test(cmd);

  try {
    const config = JSON.parse(readFileSync(hooksPath, "utf-8")) as {
      hooks?: Record<
        string,
        Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>
      >;
    };
    const hooks = config.hooks ?? {};
    let changed = false;

    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      const filtered = groups.filter(
        (g) => !(g.hooks ?? []).some((h) => isUnerrHookCommand(h.command ?? ""))
      );
      if (filtered.length !== groups.length) changed = true;
      if (filtered.length === 0) {
        delete hooks[event];
      } else {
        hooks[event] = filtered;
      }
    }

    if (!changed) return false;

    if (Object.keys(hooks).length === 0) {
      unlinkSync(hooksPath);
    } else {
      config.hooks = hooks;
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
