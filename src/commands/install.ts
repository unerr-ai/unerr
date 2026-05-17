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
  AGENT_REGISTRY,
  getAgent,
  normalizeAgentName,
} from "../config/agent-registry.js";
import {
  addDisallowedTools,
  mergePreToolUseBashHook,
} from "../config/claude-settings-hooks.js";
import { installClaudeHook } from "../config/hook-installer.js";
import {
  generateCustomInstructions,
  writeInstructionFile,
} from "../config/instruction-writer.js";
import {
  generateConfigSnippet,
  isConfigured,
  writeMcpConfig,
} from "../config/mcp-config-writer.js";
import { BUNDLED_SKILLS } from "../skills/local-pack.js";
import { resolveAndInstallSkills } from "../skills/resolver.js";

export interface InstallResult {
  agent: string;
  mcpConfig: { path: string; action: "created" | "updated" | "skipped" };
  skillsInstalled: number;
  hookInstalled: boolean;
  gitignoreUpdated: boolean;
  instructionsInjected: boolean;
  instructionPath: string;
  /** S8: Number of built-in tools denied via --force-tools. */
  toolsDenied: number;
  repoRegistered?: boolean;
}

export function registerInstallCommand(program: Command): void {
  program
    .command("install [agent]")
    .description("Install unerr for a specific AI coding agent")
    .option("--force", "Overwrite existing configuration")
    .option(
      "--no-force-tools",
      "Keep built-in Read/Grep/Glob enabled (Claude Code only, default: denied)"
    )
    .option("--show-skills", "Print skill content for manual installation")
    .option(
      "--show-instructions [agent]",
      "Print setup instructions for any AI coding agent"
    )
    .action(
      async (
        agent?: string,
        opts?: {
          force?: boolean;
          forceTools?: boolean;
          showSkills?: boolean;
          showInstructions?: boolean | string;
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

        const result = await runInstall(cwd, normalizedAgent as any, {
          forceTools: opts?.forceTools,
        });

        // Display results
        process.stderr.write("\n");
        process.stderr.write(
          `  \x1b[38;2;139;92;246m◆\x1b[0m \x1b[1munerr → ${agentDef.name}\x1b[0m\n`
        );
        process.stderr.write("\n");

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

        // S8: Disallowed tools (default-on for Claude Code)
        if (result.toolsDenied > 0) {
          process.stderr.write(
            "  \x1b[38;2;52;211;153m✓\x1b[0m Built-in Read/Grep/Glob denied (use --no-force-tools to keep)\n"
          );
        }

        // Cursor requires manual MCP server approval (CVE-2025-54136, Cursor 1.3+)
        if (normalizedAgent === "cursor") {
          process.stderr.write("\n");
          process.stderr.write(
            "  \x1b[38;2;251;191;36m⚠\x1b[0m Cursor requires one-time approval:\n"
          );
          process.stderr.write(
            "    Open \x1b[1mSettings → Tools & MCP\x1b[0m and toggle \x1b[1m\"unerr\"\x1b[0m on.\n"
          );
          process.stderr.write(
            "    \x1b[38;2;161;161;170m(Required since Cursor 1.3 — CVE-2025-54136)\x1b[0m\n"
          );
        }

        process.stderr.write("\n");
        process.stderr.write(
          "  \x1b[38;2;161;161;170mRun \x1b[0munerr\x1b[38;2;161;161;170m to start the intelligence engine.\x1b[0m\n"
        );
        process.stderr.write("\n");
      }
    );
}

/**
 * Core install logic — writes MCP config + skills for a single agent.
 */
export async function runInstall(
  cwd: string,
  ide: Parameters<typeof writeMcpConfig>[1],
  opts?: { forceTools?: boolean }
): Promise<InstallResult> {
  const agentDef = getAgent(ide);
  const agentName = agentDef?.name ?? ide;

  // 1. Write MCP config (project-level)
  const mcpConfig = writeMcpConfig(cwd, ide);

  // 2. Install skills into agent-specific directory
  let skillsInstalled = 0;
  try {
    const result = await resolveAndInstallSkills({ ide, cwd });
    skillsInstalled = result.installed.length;
  } catch {
    // Non-blocking
  }

  // 3. Install hooks if supported: agent-specific hook registration
  let hookInstalled = false;
  if (agentDef?.hookSupport) {
    try {
      if (ide === "claude-code") {
        // Claude Code: PostToolUse shell hook + PreToolUse/PostToolUse/UserPromptSubmit settings hooks
        const hookResult = installClaudeHook(cwd);
        const preTool = mergePreToolUseBashHook(cwd);
        hookInstalled =
          hookResult.action === "installed" ||
          preTool.action === "merged" ||
          preTool.action === "already_present";
      } else if (ide === "cursor") {
        // Cursor: hook config in .cursor/hooks.json (when supported)
        hookInstalled = installCursorHooks(cwd);
      } else if (ide === "windsurf") {
        // Windsurf: hook config in .windsurf/hooks.json + scripts in .windsurf/hooks/
        hookInstalled = installWindsurfHooks(cwd);
      } else if (ide === "cline") {
        // Cline: hook scripts in .clinerules/hooks/ (when supported)
        hookInstalled = installClineHooks(cwd);
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

  // 6. S8: Deny built-in tools (Claude Code only, default-on)
  // --no-force-tools opts out; otherwise always deny Read/Grep/Glob
  let toolsDenied = 0;
  const shouldDenyTools = opts?.forceTools !== false && ide === "claude-code";
  if (shouldDenyTools) {
    try {
      const deny = addDisallowedTools(cwd);
      toolsDenied = deny.added;
    } catch {
      // Non-blocking
    }
  }

  // 7. Daemon autostart is opt-in. Surface the command the user must run
  // explicitly to register a boot-time launch unit. Auto-installing a
  // launchd / systemd / scheduled-task entry from `unerr install` is the
  // exact pattern AV/EDR scanners flag as persistence, so this is gated
  // behind `unerr daemon enable-autostart`.
  try {
    const { isAutostartInstalled } = await import("../daemon/autostart.js");
    if (!isAutostartInstalled()) {
      process.stderr.write(
        "\x1b[38;2;34;211;238m▸\x1b[0m To launch unerrd at login, run \x1b[1munerr daemon enable-autostart\x1b[0m.\n"
      );
    }
  } catch {
    // Non-blocking — autostart hint is informational only.
  }

  // 8. Register repo with daemon supervisor and start the per-repo process (only if unerrd is running)
  let repoRegistered = false;
  try {
    const { daemonSockPath, probeDaemon, ensureRepo } = await import(
      "../daemon/client.js"
    );
    const { addRepo, findRepo } = await import("../daemon/registry.js");
    const sock = daemonSockPath();
    const daemonRunning = await probeDaemon(sock);

    if (daemonRunning) {
      if (!findRepo(cwd)) {
        addRepo(cwd, {});
        repoRegistered = true;
        process.stderr.write(
          "\x1b[38;2;52;211;153m✓\x1b[0m Registered repo with unerrd.\n"
        );
      }
      // Ask the daemon to start the per-repo process
      try {
        await ensureRepo(sock, cwd);
        process.stderr.write(
          "\x1b[38;2;52;211;153m✓\x1b[0m unerr process started via daemon.\n"
        );
      } catch {
        process.stderr.write(
          "\x1b[38;2;251;191;36m⚠\x1b[0m Repo registered but process did not start. It will start on next IDE connection.\n"
        );
      }
    } else {
      process.stderr.write(
        "\x1b[38;2;34;211;238m▸\x1b[0m Daemon not running. To use daemon mode: \x1b[1munerr daemon initialize\x1b[0m\n" +
          "  For standalone mode: run \x1b[1munerr\x1b[0m in this directory.\n"
      );
    }
  } catch {
    // Non-blocking — user can register later
  }

  return {
    agent: agentName,
    mcpConfig,
    skillsInstalled,
    hookInstalled,
    gitignoreUpdated,
    instructionsInjected,
    instructionPath,
    toolsDenied,
    repoRegistered,
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

    // Step 4: Restart
    w(
      `  \x1b[38;2;161;161;170mRestart ${agentDef.name} to pick up changes.\x1b[0m\n`
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
    w("  After restarting your agent, verify unerr tools are available.\n");
    w("  You should see tools like: get_callers, search_code, file_read,\n");
    w("  file_outline, get_imports, get_callees.\n\n");

    w("  \x1b[1mStep 4: Start unerr\x1b[0m\n");
    w("  \x1b[2m────────────────────\x1b[0m\n");
    w(
      "  Run \x1b[1munerr\x1b[0m in your project root to start the intelligence engine.\n"
    );
    w("  The MCP server will be available at \x1b[1munerr --mcp\x1b[0m.\n");
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
# For v1, just allow — shell compression routes through PreToolUse/Bash/exec pipeline
cat > /dev/null
echo '{"permission":"allow"}'
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
# Shell compression routes through PreToolUse/Bash/exec — passthrough here.
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
      const { mkdirSync } = require("node:fs");
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
