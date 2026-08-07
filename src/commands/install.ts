/**
 * `unerr install <agent>` — Install unerr for a specific AI coding agent.
 *
 * Following the Graphify pattern: explicit per-agent installation.
 * Each install writes the MCP config + installs intelligence skills.
 *
 * Examples:
 *   unerr install claude-code   → .mcp.json + .claude/skills/
 *   unerr install cursor        → .cursor/mcp.json + .cursor/rules/
 *   unerr install vscode        → .vscode/mcp.json + .github/copilot/
 *
 * All output to stderr (stdout is MCP-sacred).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import {
  RepoCapError,
  checkRegisterRepo,
  currentRepoLimit,
} from "../cloud/plan/index.js";
import {
  AGENT_REGISTRY,
  getAgent,
  normalizeAgentName,
} from "../config/agent-registry.js";
import {
  addAgentToolAllows,
  addDisallowedTools,
  getUnerrBinary,
  mergePreToolUseBashHook,
} from "../config/claude-settings-hooks.js";
import {
  generateCustomInstructions,
  writeInstructionFile,
} from "../config/instruction-writer.js";
import {
  generateConfigSnippet,
  isConfigured,
  writeMcpConfig,
} from "../config/mcp-config-writer.js";
import { ensureRepoConfig } from "../config/repo-bootstrap.js";
import { findRepo, listRepos } from "../daemon/registry.js";
import {
  gatherNotices,
  renderNoticesPlain,
} from "../notices/status-notices.js";
import { BUNDLED_SKILLS } from "../skills/local-pack.js";
import {
  removeInstalledSkills,
  resolveAndInstallSkills,
} from "../skills/resolver.js";
import { consolidatedDashboardUrl } from "../utils/deep-link.js";

export interface InstallResult {
  agent: string;
  mcpConfig: { path: string; action: "created" | "updated" | "skipped" };
  /** Number of stale `unerr-*` skills removed from disk before this install
   *  (post-27→7 consolidation cleanup). Zero on fresh installs. */
  skillsRemoved: number;
  skillsInstalled: number;
  hookInstalled: boolean;
  gitignoreUpdated: boolean;
  instructionsInjected: boolean;
  instructionPath: string;
  /** Number of legacy unerr `permissions.deny` entries (Read/Grep/Glob) stripped. */
  legacyDeniesRemoved: number;
  /** Number of unerr sub-agent tool grants added to `permissions.allow`
   *  (`.claude/settings.local.json`) so worker/junior sub-agents run unprompted. */
  agentToolAllowsAdded: number;
  repoRegistered?: boolean;
  /** True when `.unerr/config.json` did not exist yet and this install
   *  created it (headless installs used to leave the repo unbootable —
   *  see ensureRepoConfig). False when a valid config already existed. */
  configBootstrapped: boolean;
}

export function registerInstallCommand(program: Command): void {
  program
    .command("install [agent]")
    .description("Install unerr for a specific AI coding agent")
    .option("--force", "Overwrite existing configuration")
    .option("--show-skills", "Print skill content for manual installation")
    .option(
      "--show-instructions [agent]",
      "Print setup instructions for any AI coding agent"
    )
    .option(
      "--token <token>",
      "Connect non-interactively with a machine token (CI / headless)"
    )
    .action(
      async (
        agent?: string,
        opts?: {
          force?: boolean;
          showSkills?: boolean;
          showInstructions?: boolean | string;
          token?: string;
        }
      ) => {
        const cwd = process.cwd();

        // --show-instructions: print agent-specific or generic setup guide
        if (opts?.showInstructions !== undefined) {
          const targetAgent =
            typeof opts.showInstructions === "string"
              ? opts.showInstructions
              : (agent ?? "other");
          showSetupInstructions(normalizeAgentName(targetAgent));
          return;
        }

        // --show-skills: print skill content for manual copy
        if (opts?.showSkills) {
          await showSkillContent();
          return;
        }

        // No agent specified — show available agents
        if (!agent) {
          showAvailableAgents(cwd);
          return;
        }

        // Normalize agent name (allow "claude" as alias for "claude-code")
        const normalizedAgent = normalizeAgentName(agent);

        const agentDef = getAgent(normalizedAgent as any);
        if (!agentDef) {
          process.stderr.write(
            `\x1b[31m✗\x1b[0m Unknown agent: "${agent}"\n\n`
          );
          showAvailableAgents(cwd);
          return;
        }

        let result: InstallResult;
        try {
          result = await runInstall(cwd, normalizedAgent as any);
        } catch (err) {
          if (err instanceof RepoCapError) {
            // Free-tier repo cap hit — print the upgrade/free-slot guidance and
            // exit non-zero. No config was written (the check runs first).
            process.stderr.write(`\n  \x1b[31m✗\x1b[0m ${err.message}\n`);
            process.exitCode = 1;
            return;
          }
          throw err;
        }

        // Display results
        process.stderr.write("\n");
        process.stderr.write(
          `  \x1b[38;2;139;92;246m◆\x1b[0m \x1b[1munerr → ${agentDef.name}\x1b[0m\n`
        );
        process.stderr.write("\n");

        // Repo config bootstrap (must precede MCP config in output too — it's
        // what makes the daemon-spawned MCP server bootable at all).
        if (result.configBootstrapped) {
          process.stderr.write(
            "  \x1b[38;2;52;211;153m✓\x1b[0m .unerr/config.json created (repo now bootable headlessly)\n"
          );
        }

        // MCP config
        if (result.mcpConfig.action === "created") {
          process.stderr.write(
            `  \x1b[38;2;52;211;153m✓\x1b[0m MCP config created → ${result.mcpConfig.path}\n`
          );
        } else if (result.mcpConfig.action === "updated") {
          process.stderr.write(
            `  \x1b[38;2;52;211;153m✓\x1b[0m MCP config updated → ${result.mcpConfig.path}\n`
          );
        } else {
          process.stderr.write(
            `  \x1b[38;2;161;161;170m·\x1b[0m MCP config already present → ${result.mcpConfig.path}\n`
          );
        }

        // Skills
        if (result.skillsInstalled > 0) {
          process.stderr.write(
            `  \x1b[38;2;52;211;153m✓\x1b[0m ${result.skillsInstalled} intelligence skills installed\n`
          );
        }

        // Hook
        if (result.hookInstalled) {
          process.stderr.write(
            "  \x1b[38;2;52;211;153m✓\x1b[0m PreToolUse hook installed (graph-first navigation)\n"
          );
        }

        // Gitignore
        if (result.gitignoreUpdated) {
          process.stderr.write(
            "  \x1b[38;2;52;211;153m✓\x1b[0m .unerr added to .gitignore\n"
          );
        }

        // Instructions
        if (result.instructionsInjected) {
          process.stderr.write(
            `  \x1b[38;2;52;211;153m✓\x1b[0m Tool preferences → ${result.instructionPath}\n`
          );
        }

        // Strip legacy force-deny of Grep/Glob/Read (it diverted blocked
        // searches to bash; the redirecting pre-grep/pre-glob hooks send them
        // to search_code instead).
        if (result.legacyDeniesRemoved > 0) {
          process.stderr.write(
            "  \x1b[38;2;52;211;153m✓\x1b[0m Cleared legacy Grep/Glob force-deny (searches now route to search_code)\n"
          );
        }

        // Sub-agent tools pre-approved so worker/junior delegation runs unprompted.
        if (result.agentToolAllowsAdded > 0) {
          process.stderr.write(
            "  \x1b[38;2;52;211;153m✓\x1b[0m Sub-agent tools pre-approved → .claude/settings.local.json (worker/junior run without permission prompts)\n"
          );
        }

        // Cursor requires manual MCP server approval (CVE-2025-54136, Cursor 1.3+)
        if (normalizedAgent === "cursor") {
          process.stderr.write("\n");
          process.stderr.write(
            "  \x1b[38;2;251;191;36m⚠\x1b[0m Cursor requires one-time approval:\n"
          );
          process.stderr.write(
            '    Open \x1b[1mSettings → Tools & MCP\x1b[0m and toggle \x1b[1m"unerr"\x1b[0m on.\n'
          );
          process.stderr.write(
            "    \x1b[38;2;161;161;170m(Required since Cursor 1.3 — CVE-2025-54136)\x1b[0m\n"
          );
        }

        process.stderr.write("\n");
        process.stderr.write(
          `  \x1b[38;2;161;161;170mStart a new ${agentDef.name} chat session to begin using unerr.\x1b[0m\n`
        );
        process.stderr.write("\n");

        // Disclose auto-update once per machine (informed default-on): it ships
        // on, so the first setup names the behaviour + the off-switch, then the
        // `disclosed_at` flag keeps it from repeating. Best-effort, never blocks.
        try {
          const { discloseAutoUpdateOnce } = await import(
            "../update/disclosure.js"
          );
          const lines: string[] = [];
          if (discloseAutoUpdateOnce((l) => lines.push(l))) {
            process.stderr.write(
              `  \x1b[38;2;139;92;246m◆\x1b[0m \x1b[1m${lines[0]}\x1b[0m\n`
            );
            for (const l of lines.slice(1)) {
              process.stderr.write(`    \x1b[38;2;161;161;170m${l}\x1b[0m\n`);
            }
            process.stderr.write("\n");
          } else {
            // Already disclosed — keep the control discoverable with one resting
            // line reflecting the current policy + the exact change command.
            const { updatePolicy } = await import("../update/update-config.js");
            const mode = updatePolicy();
            const label =
              mode === "auto"
                ? "on"
                : mode === "notify"
                  ? "notify-only"
                  : "off";
            process.stderr.write(
              `  \x1b[38;2;161;161;170mAuto-update: ${label} · change it in the unerr dashboard → Settings\x1b[0m\n\n`
            );
          }
        } catch {
          /* disclosure is additive — never block install on it */
        }

        // Dashboard link + login/update notices
        process.stderr.write(
          `  \x1b[38;2;139;92;246m◆\x1b[0m Dashboard: ${consolidatedDashboardUrl()}\n`
        );
        const notices = renderNoticesPlain(gatherNotices());
        if (notices) process.stderr.write(`\n${notices}\n`);

        // No login required (OSS): `install` runs fully local. No
        // install-time login offer — `unerr login` is opt-in, for
        // `conventions` (the shared cloud document) only.
      }
    );
}

/**
 * Core install logic — writes MCP config + skills for a single agent.
 */
export async function runInstall(
  cwd: string,
  ide: Parameters<typeof writeMcpConfig>[1]
): Promise<InstallResult> {
  const agentDef = getAgent(ide);
  const agentName = agentDef?.name ?? ide;

  // 0. Free-tier repo cap — refuse a brand-new 2nd repo BEFORE writing any
  //    config, so a capped repo never gets a half-written .mcp.json. Adding
  //    another agent for an already-registered repo is always allowed.
  if (!findRepo(cwd)) {
    const verdict = checkRegisterRepo({
      limit: currentRepoLimit(),
      currentCount: listRepos().length,
    });
    if (!verdict.allowed) {
      throw new RepoCapError(verdict.message);
    }
  }

  // 0b. Ensure `.unerr/config.json` + `.unerr/settings.json` exist. Must run
  //     before the step-7 pre-warm block below (`ensureRepo`) — otherwise
  //     that pre-warm still spawns a daemon child that exits 1 for lack of
  //     config. This is what makes a headless install bootable at all.
  const { created: configBootstrapped } = await ensureRepoConfig(cwd);

  // 1. Write MCP config (project-level)
  const mcpConfig = writeMcpConfig(cwd, ide);

  // 2. Wipe stale `unerr-*` skills from disk, then install the current set.
  //    The consolidation (27→7) means any prior install left behind 20
  //    legacy SKILL.md files. removeInstalledSkills only touches the
  //    `unerr-*` namespace; user-authored skills are preserved (covered by
  //    src/__tests__/skill-install-idempotency.test.ts).
  let skillsRemoved = 0;
  let skillsInstalled = 0;
  try {
    skillsRemoved = removeInstalledSkills(ide, cwd);
  } catch {
    // Non-blocking — fall through and install regardless.
  }
  try {
    const result = await resolveAndInstallSkills({ ide, cwd });
    skillsInstalled = result.installed.length;
  } catch {
    // Non-blocking
  }

  // 2b. Write the model-pinned delegation sub-agent (Lever C). No-op unless the
  //     host supports an on-disk sub-agent (Claude Code); Codex delegates via
  //     `codex exec -m gpt-5.4-mini` and needs no file.
  try {
    const { writeSubagents } = await import("../skills/subagent-manager.js");
    writeSubagents(ide, cwd);
  } catch {
    // Non-blocking
  }

  // 3. Install hooks if supported: agent-specific hook registration
  let hookInstalled = false;
  if (agentDef?.hookSupport) {
    try {
      if (ide === "claude-code") {
        // Claude Code: PreToolUse/PostToolUse/UserPromptSubmit settings hooks.
        // (The legacy .claude/hooks/PostToolUse.sh shell hook is no longer
        // installed — Claude Code PostToolUse hooks receive JSON on stdin,
        // never a $TOOL_OUTPUT env var, so it was always a no-op. Real
        // compression rides `unerr hook post-bash` via settings.json.)
        const preTool = mergePreToolUseBashHook(cwd);
        hookInstalled =
          preTool.action === "merged" || preTool.action === "already_present";
      } else if (ide === "cursor") {
        // Cursor: hook config in .cursor/hooks.json (when supported)
        hookInstalled = installCursorHooks(cwd);
      } else if (ide === "windsurf") {
        // Windsurf: hook config in .windsurf/hooks.json + scripts in .windsurf/hooks/
        hookInstalled = installWindsurfHooks(cwd);
      } else if (ide === "cline") {
        // Cline: hook scripts in .clinerules/hooks/ (when supported)
        hookInstalled = installClineHooks(cwd);
      } else if (ide === "codex") {
        // Codex: hook registration in .codex/hooks.json (MCP stays in
        // .codex/config.toml). UserPromptSubmit carries the per-turn nudge
        // (incl. delegation); SessionStart the resume strip; Pre/PostToolUse
        // the Bash/apply_patch guards Codex's tool hooks can actually see.
        hookInstalled = installCodexHooks(cwd);
      }
    } catch {
      // Non-blocking
    }
  }

  // 4. Ensure .unerr is in .gitignore
  const gitignoreUpdated = ensureGitignore(cwd);

  // 5. Inject tool preferences into agent instruction file
  let instructionsInjected = false;
  let instructionPath = "";
  try {
    const instrResult = writeInstructionFile(cwd, ide);
    instructionsInjected =
      instrResult.action === "created" || instrResult.action === "updated";
    instructionPath = instrResult.path;
  } catch {
    // Non-blocking
  }

  // 6. Reconcile permissions.deny (Claude Code only): strip any legacy
  // unerr-added Grep/Glob/Read force-deny. unerr no longer denies at the
  // permission layer — the redirecting pre-grep/pre-glob hooks + instruction
  // steer to search_code; a blind deny only diverts blocked searches to bash.
  let legacyDeniesRemoved = 0;
  if (ide === "claude-code") {
    try {
      const deny = addDisallowedTools(cwd);
      legacyDeniesRemoved = deny.removed;
    } catch {
      // Non-blocking
    }
  }

  // 6b. Pre-approve unerr's sub-agent tool set (Claude Code only) in
  // `.claude/settings.local.json` so `unerr-worker` / `unerr-junior` sub-agents
  // don't prompt on every Bash/Read/Write/MCP call. The allow-list is inherited
  // by Task sub-agents; `--dangerously-skip-permissions` is not. On by default.
  let agentToolAllowsAdded = 0;
  if (ide === "claude-code") {
    try {
      agentToolAllowsAdded = addAgentToolAllows(cwd).added;
    } catch {
      // Non-blocking
    }
  }

  // 7. Best-effort, silent pre-warm: if the process manager is already running,
  //    register the repo and ask it to spin up the per-repo process so the next
  //    IDE connect is instant. If the manager isn't running, do nothing — the
  //    bridge auto-spawns it on first MCP connection via the spawn-lock.
  let repoRegistered = false;
  try {
    const { daemonSockPath, probeDaemon, ensureRepo } = await import(
      "../daemon/client.js"
    );
    const { addRepo } = await import("../daemon/registry.js");
    const sock = daemonSockPath();
    if (await probeDaemon(sock)) {
      if (!findRepo(cwd)) {
        addRepo(cwd, {}, { repoLimit: currentRepoLimit() });
        repoRegistered = true;
      }
      await ensureRepo(sock, cwd).catch(() => {});
    }
  } catch {
    // Non-blocking — IDE connection will register on demand.
  }

  return {
    agent: agentName,
    mcpConfig,
    skillsRemoved,
    skillsInstalled,
    hookInstalled,
    gitignoreUpdated,
    instructionsInjected,
    instructionPath,
    legacyDeniesRemoved,
    agentToolAllowsAdded,
    repoRegistered,
    configBootstrapped,
  };
}

/**
 * Display available agents with install status.
 */
function showAvailableAgents(cwd: string): void {
  process.stderr.write("\n");
  process.stderr.write(
    "  \x1b[38;2;139;92;246m◆\x1b[0m \x1b[1munerr install <agent>\x1b[0m\n"
  );
  process.stderr.write("\n");
  process.stderr.write(
    "  \x1b[38;2;161;161;170mInstall unerr intelligence for a specific AI coding agent.\x1b[0m\n"
  );
  process.stderr.write(
    "  \x1b[38;2;161;161;170mWrites MCP config + installs skills (project-level, never global).\x1b[0m\n"
  );
  process.stderr.write("\n");
  process.stderr.write(
    "  \x1b[38;2;161;161;170mAgent              Command                          Status\x1b[0m\n"
  );
  process.stderr.write(
    "  \x1b[2m─────────────────────────────────────────────────────────────────\x1b[0m\n"
  );

  for (const agent of AGENT_REGISTRY) {
    const installed = isConfigured(cwd, agent.id);
    const status = installed
      ? "\x1b[38;2;52;211;153m✓ installed\x1b[0m"
      : "\x1b[38;2;161;161;170m·\x1b[0m";
    const name = agent.name.padEnd(18);
    const cmd = `unerr install ${agent.id}`.padEnd(32);
    process.stderr.write(`  ${name} ${cmd} ${status}\n`);
  }

  process.stderr.write("\n");
  process.stderr.write(
    "  \x1b[38;2;161;161;170mExample:\x1b[0m unerr install claude-code\n"
  );
  process.stderr.write("\n");
}

/**
 * Print bundled skill content for manual installation into custom agents.
 */
async function showSkillContent(): Promise<void> {
  process.stderr.write("\n");
  process.stderr.write(
    "  \x1b[38;2;139;92;246m◆\x1b[0m \x1b[1munerr intelligence skills\x1b[0m\n"
  );
  process.stderr.write("\n");
  process.stderr.write(
    "  \x1b[38;2;161;161;170mCopy these into your agent's rules/prompts directory.\x1b[0m\n"
  );
  process.stderr.write(
    "  \x1b[38;2;161;161;170mThey teach the agent to use unerr's graph tools before reading files.\x1b[0m\n"
  );

  for (const skill of BUNDLED_SKILLS) {
    process.stderr.write("\n");
    process.stderr.write(
      `  \x1b[2m── ${skill.name} ──────────────────────────────────────────\x1b[0m\n`
    );
    process.stderr.write(
      `  \x1b[38;2;161;161;170m${skill.description}\x1b[0m\n\n`
    );
    // Print content with indentation
    for (const line of skill.content.split("\n")) {
      process.stderr.write(`  ${line}\n`);
    }
  }

  process.stderr.write("\n");
  process.stderr.write(
    "  \x1b[38;2;161;161;170mMCP config to add alongside skills:\x1b[0m\n\n"
  );
  process.stderr.write(
    `  ${generateConfigSnippet("cursor").split("\n").join("\n  ")}\n`
  );
  process.stderr.write("\n");
}

/**
 * Print detailed setup instructions for a specific agent or generic guide.
 */
function showSetupInstructions(agentName: string): void {
  const agentDef = getAgent(agentName as any);
  const w = (s: string) => process.stderr.write(s);

  w("\n");

  if (agentDef) {
    // Known agent — show agent-specific instructions
    w(
      `  \x1b[38;2;139;92;246m◆\x1b[0m \x1b[1mSetup instructions for ${agentDef.name}\x1b[0m\n\n`
    );

    // Step 1: MCP config
    w("  \x1b[1m1. MCP Configuration\x1b[0m\n");
    w(`     Add to ${agentDef.projectConfigPath}:\n\n`);
    w(
      `     ${generateConfigSnippet(agentDef.id).split("\n").join("\n     ")}\n\n`
    );

    // Step 2: Instruction file
    if (agentDef.instructionFilePath) {
      w("  \x1b[1m2. Tool Preferences\x1b[0m\n");
      w(
        `     ${generateCustomInstructions(agentDef.id).split("\n").join("\n     ")}\n\n`
      );
    }

    // Step 3: Auto install
    w(
      `  \x1b[1m${agentDef.instructionFilePath ? "3" : "2"}. Or run automatically:\x1b[0m\n`
    );
    w(`     unerr install ${agentDef.id}\n\n`);

    // Step 4: New chat session
    w(
      `  \x1b[38;2;161;161;170mStart a new ${agentDef.name} chat session to pick up changes.\x1b[0m\n`
    );
  } else {
    // Unknown/other agent — generic guide
    w(
      "  \x1b[38;2;139;92;246m◆\x1b[0m \x1b[1mManual setup for any AI coding agent\x1b[0m\n\n"
    );
    w(
      "  unerr works with any agent that supports MCP (Model Context Protocol).\n\n"
    );

    w("  \x1b[1mStep 1: MCP Server Configuration\x1b[0m\n");
    w("  \x1b[2m─────────────────────────────────\x1b[0m\n");
    w("  Add unerr as an MCP server in your agent's config file.\n");
    w("  The exact format depends on your agent:\n\n");
    w("  Standard JSON format (most agents):\n");
    w(`  ${generateConfigSnippet("cursor").split("\n").join("\n  ")}\n\n`);

    w("  \x1b[1mStep 2: Agent Instructions (Critical for Adoption)\x1b[0m\n");
    w("  \x1b[2m───────────────────────────────────────────────────\x1b[0m\n");
    w("  Add these instructions to your agent's instruction file\n");
    w("  (CLAUDE.md, AGENTS.md, .cursorrules, GEMINI.md, etc.):\n\n");
    w(`  ${generateCustomInstructions().split("\n").join("\n  ")}\n\n`);

    w("  \x1b[1mStep 3: Verify\x1b[0m\n");
    w("  \x1b[2m──────────────\x1b[0m\n");
    w("  In a new chat session, verify unerr tools are available.\n");
    w("  You should see tools like: search_code, file_read, get_references,\n");
    w("  file_outline, get_references.\n\n");

    w("  \x1b[1mStep 4: Start a new chat session\x1b[0m\n");
    w("  \x1b[2m────────────────────────────────\x1b[0m\n");
    w(
      "  unerr starts automatically when your agent first connects to its MCP server.\n"
    );
    w(
      "  Opening a new chat session reconnects to the MCP server — no full app restart needed.\n"
    );
    w("  No background service to install — no boot-time setup needed.\n");
  }

  w("\n");
}

// ── Cursor Hook Scripts ──────────────────────────────────────────────
// These are written to .cursor/hooks/ by installCursorHooks().
// Each reads JSON from stdin and dispatches to the appropriate unerr hook subcommand.

const CURSOR_PRE_TOOL_SCRIPT = `#!/bin/bash
# unerr preToolUse hook for Cursor
# Installed by: unerr install cursor | Removed by: unerr uninstall cursor
input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // empty')
case "$tool_name" in
  Read)  echo "$input" | unerr hook pre-read ;;
  Grep)  echo "$input" | unerr hook pre-grep ;;
  Glob)  echo "$input" | unerr hook pre-glob ;;
  Write) echo "$input" | unerr hook pre-write ;;
  Edit)  echo "$input" | unerr hook pre-edit ;;
  *)     echo '{"permission":"allow"}' ;;
esac
`;

const CURSOR_POST_TOOL_SCRIPT = `#!/bin/bash
# unerr postToolUse hook for Cursor
# Installed by: unerr install cursor | Removed by: unerr uninstall cursor
input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // empty')
case "$tool_name" in
  Read)  echo "$input" | unerr hook post-read ;;
  Grep)  echo "$input" | unerr hook post-grep ;;
  Glob)  echo "$input" | unerr hook post-glob ;;
  Write) echo "$input" | unerr hook post-write ;;
  Edit)  echo "$input" | unerr hook post-edit ;;
  *)     echo '{}' ;;
esac
`;

const CURSOR_PROMPT_SCRIPT = `#!/bin/bash
# unerr beforeSubmitPrompt hook for Cursor
# Installed by: unerr install cursor | Removed by: unerr uninstall cursor
cat | unerr hook prompt-submit
`;

const CURSOR_PRE_SHELL_SCRIPT = `#!/bin/bash
# unerr beforeShellExecution hook for Cursor
# Installed by: unerr install cursor | Removed by: unerr uninstall cursor
# Cursor's shell hook can't rewrite the command to \`unerr exec\` (no updated_input
# on beforeShellExecution), so unerr hook pre-shell surfaces the code-nav drift
# redirect (get_references/search_code/file_read) as agent_message and allows.
cat | unerr hook pre-shell
`;

/**
 * Install Cursor hook configuration in `.cursor/hooks.json`.
 * Registers unerr as a hook provider for PreToolUse events.
 * Idempotent — skips if already present.
 */
function installCursorHooks(cwd: string): boolean {
  const hooksJsonPath = join(cwd, ".cursor", "hooks.json");
  const hooksDir = join(cwd, ".cursor", "hooks");

  // Define our hook entries per Cursor's official format
  const unerrHooks: Record<
    string,
    Array<{ command: string; matcher?: string }>
  > = {
    preToolUse: [
      {
        command: ".cursor/hooks/unerr-pre-tool.sh",
        matcher: "Read|Grep|Glob|Write|Edit",
      },
    ],
    postToolUse: [
      {
        command: ".cursor/hooks/unerr-post-tool.sh",
        matcher: "Read|Grep|Glob|Write|Edit",
      },
    ],
    beforeSubmitPrompt: [{ command: ".cursor/hooks/unerr-prompt.sh" }],
    beforeShellExecution: [{ command: ".cursor/hooks/unerr-pre-shell.sh" }],
  };

  try {
    // Ensure directories exist
    if (!existsSync(hooksDir)) {
      mkdirSync(hooksDir, { recursive: true });
    }

    // Read or create hooks.json with correct Cursor format
    let config: { version: number; hooks: Record<string, unknown[]> } = {
      version: 1,
      hooks: {},
    };

    if (existsSync(hooksJsonPath)) {
      try {
        const existing = JSON.parse(
          readFileSync(hooksJsonPath, "utf-8")
        ) as typeof config;
        if (existing.version && existing.hooks) {
          config = existing;
        }
      } catch {
        // Corrupt file — overwrite with fresh config
      }
    }

    // Merge our hooks into each event, avoiding duplicates by command path
    for (const [event, entries] of Object.entries(unerrHooks)) {
      const existing = Array.isArray(config.hooks[event])
        ? (config.hooks[event] as Array<{ command?: string }>)
        : [];

      for (const entry of entries) {
        const alreadyPresent = existing.some(
          (h) => h.command === entry.command
        );
        if (!alreadyPresent) {
          existing.push(entry);
        }
      }

      config.hooks[event] = existing;
    }

    writeFileSync(hooksJsonPath, `${JSON.stringify(config, null, 2)}\n`);

    // Write hook scripts
    writeCursorHookScript(
      hooksDir,
      "unerr-pre-tool.sh",
      CURSOR_PRE_TOOL_SCRIPT
    );
    writeCursorHookScript(
      hooksDir,
      "unerr-post-tool.sh",
      CURSOR_POST_TOOL_SCRIPT
    );
    writeCursorHookScript(hooksDir, "unerr-prompt.sh", CURSOR_PROMPT_SCRIPT);
    writeCursorHookScript(
      hooksDir,
      "unerr-pre-shell.sh",
      CURSOR_PRE_SHELL_SCRIPT
    );

    return true;
  } catch {
    return false;
  }
}

/** Write a hook script file and make it executable. */
function writeCursorHookScript(
  dir: string,
  filename: string,
  content: string
): void {
  const scriptPath = join(dir, filename);
  writeFileSync(scriptPath, content, "utf-8");
  chmodSync(scriptPath, 0o755);
}

/**
 * Install Codex hook registration in `.codex/hooks.json` (MCP stays in
 * `.codex/config.toml`). Codex's hooks use the same
 * `hookSpecificOutput.additionalContext` contract as Claude Code, so the existing
 * `unerr hook <sub>` handlers — routed through the codex adapter — work unchanged.
 * We register only events Codex actually surfaces: UserPromptSubmit + SessionStart
 * (context injection — the delegation nudge and resume strip ride UserPromptSubmit)
 * and Pre/PostToolUse for Bash + apply_patch (Codex tool hooks do NOT see built-in
 * read/grep/glob). Idempotent — re-running merges without duplicating a command.
 */
export function installCodexHooks(cwd: string): boolean {
  const hooksJsonPath = join(cwd, ".codex", "hooks.json");
  const bin = getUnerrBinary();

  // Each event maps to a list of matcher-groups, each carrying a `hooks` array of
  // command handlers — the same shape as Claude Code's settings.json hooks. An
  // empty matcher matches every invocation of that event.
  const unerrHooks: Record<
    string,
    Array<{ matcher: string; command: string }>
  > = {
    UserPromptSubmit: [{ matcher: "", command: `${bin} hook prompt-submit` }],
    SessionStart: [{ matcher: "", command: `${bin} hook session-start` }],
    PreToolUse: [
      { matcher: "Bash", command: `${bin} hook pre-bash` },
      { matcher: "apply_patch", command: `${bin} hook pre-edit` },
    ],
    PostToolUse: [{ matcher: "apply_patch", command: `${bin} hook post-edit` }],
  };

  type Handler = { type: "command"; command: string };
  type MatcherGroup = { matcher?: string; hooks: Handler[] };

  try {
    mkdirSync(join(cwd, ".codex"), { recursive: true });

    let config: { hooks: Record<string, MatcherGroup[]> } = { hooks: {} };
    if (existsSync(hooksJsonPath)) {
      try {
        const existing = JSON.parse(
          readFileSync(hooksJsonPath, "utf-8")
        ) as typeof config;
        if (existing && typeof existing === "object" && existing.hooks) {
          config = existing;
        }
      } catch {
        // Corrupt file — overwrite with a fresh config.
      }
    }

    // Merge our matcher-groups in, deduping by command so re-running is a no-op
    // and user-authored hooks pointing at other commands are preserved.
    for (const [event, entries] of Object.entries(unerrHooks)) {
      const groups = Array.isArray(config.hooks[event])
        ? config.hooks[event]
        : [];
      for (const entry of entries) {
        const present = groups.some((g) =>
          (g.hooks ?? []).some((h) => h.command === entry.command)
        );
        if (!present) {
          groups.push({
            matcher: entry.matcher,
            hooks: [{ type: "command", command: entry.command }],
          });
        }
      }
      config.hooks[event] = groups;
    }

    writeFileSync(hooksJsonPath, `${JSON.stringify(config, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

// Windsurf hook scripts — receive Cascade event JSON on stdin and route to
// the unerr hook subcommand that already handles the equivalent event from
// Cursor/Claude Code. Keeping the bridge thin (one cat | unerr line) means
// behaviour changes flow through the CLI, not the on-disk scripts.
const WINDSURF_PRE_TOOL_SCRIPT = `#!/bin/bash
# unerr pre_mcp_tool_use hook for Windsurf Cascade
# Installed by: unerr install windsurf | Removed by: unerr uninstall windsurf
cat | unerr hook pre-tool
`;

const WINDSURF_POST_TOOL_SCRIPT = `#!/bin/bash
# unerr post_mcp_tool_use hook for Windsurf Cascade
# Installed by: unerr install windsurf | Removed by: unerr uninstall windsurf
cat | unerr hook post-tool
`;

const WINDSURF_PROMPT_SCRIPT = `#!/bin/bash
# unerr pre_user_prompt hook for Windsurf Cascade
# Installed by: unerr install windsurf | Removed by: unerr uninstall windsurf
cat | unerr hook prompt-submit
`;

const WINDSURF_PRE_SHELL_SCRIPT = `#!/bin/bash
# unerr pre_run_command hook for Windsurf Cascade
# Installed by: unerr install windsurf | Removed by: unerr uninstall windsurf
# Passthrough by design: Windsurf's pre_run_command communicates via EXIT CODE
# ONLY (0=allow, 2=block) — there is no advisory-message channel, so a non-blocking
# drift nudge is impossible without hostilely blocking the user's command. Drift
# coverage for Windsurf is the instruction-file rename row, not a runtime nudge.
cat > /dev/null
exit 0
`;

/**
 * Install Windsurf Cascade hook configuration in `.windsurf/hooks.json` plus
 * the four shell scripts under `.windsurf/hooks/`. Mirrors the Cursor wiring,
 * but uses Windsurf's snake_case event names (`pre_mcp_tool_use` etc.) per
 * the Cascade hook schema. Idempotent — re-running merges without duplicates.
 */
function installWindsurfHooks(cwd: string): boolean {
  const hooksJsonPath = join(cwd, ".windsurf", "hooks.json");
  const hooksDir = join(cwd, ".windsurf", "hooks");

  const unerrHooks: Record<
    string,
    Array<{ command: string; show_output?: boolean }>
  > = {
    pre_mcp_tool_use: [
      { command: ".windsurf/hooks/unerr-pre-tool.sh", show_output: false },
    ],
    post_mcp_tool_use: [
      { command: ".windsurf/hooks/unerr-post-tool.sh", show_output: false },
    ],
    pre_user_prompt: [
      { command: ".windsurf/hooks/unerr-prompt.sh", show_output: false },
    ],
    pre_run_command: [
      { command: ".windsurf/hooks/unerr-pre-shell.sh", show_output: false },
    ],
  };

  try {
    if (!existsSync(hooksDir)) {
      mkdirSync(hooksDir, { recursive: true });
    }

    let config: { hooks: Record<string, unknown[]> } = { hooks: {} };
    if (existsSync(hooksJsonPath)) {
      try {
        const existing = JSON.parse(
          readFileSync(hooksJsonPath, "utf-8")
        ) as Partial<typeof config>;
        if (existing.hooks && typeof existing.hooks === "object") {
          config = { hooks: existing.hooks };
        }
      } catch {
        // Corrupt file — overwrite with fresh config
      }
    }

    for (const [event, entries] of Object.entries(unerrHooks)) {
      const current = Array.isArray(config.hooks[event])
        ? (config.hooks[event] as Array<{ command?: string }>)
        : [];
      for (const entry of entries) {
        const alreadyPresent = current.some((h) => h.command === entry.command);
        if (!alreadyPresent) current.push(entry);
      }
      config.hooks[event] = current;
    }

    writeFileSync(hooksJsonPath, `${JSON.stringify(config, null, 2)}\n`);

    writeCursorHookScript(
      hooksDir,
      "unerr-pre-tool.sh",
      WINDSURF_PRE_TOOL_SCRIPT
    );
    writeCursorHookScript(
      hooksDir,
      "unerr-post-tool.sh",
      WINDSURF_POST_TOOL_SCRIPT
    );
    writeCursorHookScript(hooksDir, "unerr-prompt.sh", WINDSURF_PROMPT_SCRIPT);
    writeCursorHookScript(
      hooksDir,
      "unerr-pre-shell.sh",
      WINDSURF_PRE_SHELL_SCRIPT
    );

    return true;
  } catch {
    return false;
  }
}

/**
 * Install Cline hook scripts in `.clinerules/hooks/`.
 * Creates a pre-tool hook script that routes through unerr.
 * Idempotent — skips if already present.
 */
function installClineHooks(cwd: string): boolean {
  const hooksDir = join(cwd, ".clinerules", "hooks");
  const hookPath = join(hooksDir, "unerr-pre-tool.sh");

  if (existsSync(hookPath)) return true;

  try {
    if (!existsSync(hooksDir)) {
      mkdirSync(hooksDir, { recursive: true });
    }

    const hookContent = `#!/bin/bash
# unerr hook — graph-first tool navigation for Cline
# Installed by: unerr install cline
# Removed by: unerr uninstall cline
cat /dev/stdin | unerr hook pre-read
`;

    writeFileSync(hookPath, hookContent, "utf-8");
    chmodSync(hookPath, 0o755);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure .unerr is listed in .gitignore so artifacts don't get committed.
 * Only modifies .gitignore if it exists and doesn't already contain .unerr.
 */
function ensureGitignore(cwd: string): boolean {
  const gitignorePath = join(cwd, ".gitignore");
  if (!existsSync(gitignorePath)) return false;

  try {
    const content = readFileSync(gitignorePath, "utf-8");
    const lines = content.split("\n");

    // Check if .unerr is already ignored (exact line match)
    if (lines.some((l) => l.trim() === ".unerr" || l.trim() === ".unerr/")) {
      return false;
    }

    // Append .unerr entry
    const newline = content.endsWith("\n") ? "" : "\n";
    writeFileSync(
      gitignorePath,
      `${content}${newline}\n# unerr local artifacts\n.unerr\n`
    );
    return true;
  } catch {
    return false;
  }
}
