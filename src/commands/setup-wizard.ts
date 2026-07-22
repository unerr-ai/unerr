/**
 * Setup Wizard — first-run project initialization.
 *
 * Generates a repo ID, writes .unerr/config.json, installs skills.
 * All output goes to stderr (stdout is MCP-sacred).
 *
 * unerr operates as an MCP proxy where the calling agent (Claude Code,
 * Cursor, etc.) provides the LLM.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { generateRepoId } from "../config/repo-bootstrap.js";

export type WizardResult =
  | { action: "setup"; repoId: string }
  | { action: "exit" };

/** @deprecated Use runSetup() directly. Kept for backward compat. */
export const promptLocalOrExit = runSetup;

/** @deprecated Use runSetup() directly. Kept for backward compat. */
export const enterLocalModeSetup = runSetup;

/**
 * First-run project setup. Generates repo ID, writes config, installs skills.
 */
export async function runSetup(cwd?: string): Promise<WizardResult> {
  const projectDir = cwd ?? process.cwd();

  clack.intro("unerr");
  clack.log.step("Project Setup");

  // Generate repo ID from git remote or cwd
  const repoId = await generateRepoId(projectDir);

  // Write config files
  const configDir = join(projectDir, ".unerr");
  mkdirSync(configDir, { recursive: true });

  const configPath = join(configDir, "config.json");
  const settingsPath = join(configDir, "settings.json");

  writeFileSync(configPath, `${JSON.stringify({ repoId }, null, 2)}\n`);

  // Write/merge settings.json
  let existingSettings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      existingSettings = JSON.parse(
        readFileSync(settingsPath, "utf-8")
      ) as Record<string, unknown>;
    } catch {
      // Ignore parse errors
    }
  }
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ ...existingSettings }, null, 2)}\n`
  );

  // Install skills from bundled pack
  let skillCount = 0;
  let detectedIde = "unknown";
  try {
    const { detectIde } = await import("../utils/detect.js");
    const { resolveAndInstallSkills } = await import("../skills/resolver.js");
    const ide = await detectIde(projectDir);
    detectedIde = ide;
    const result = await resolveAndInstallSkills({ ide, cwd: projectDir });
    skillCount = result.installed.length;
    if (skillCount > 0) {
      clack.log.success(
        `🧠 ${skillCount} intelligence skills installed — your AI agent will now use graph tools before reading files`
      );
    }
  } catch {
    // Non-blocking — skills can self-heal on first boot
  }

  // Write MCP config for detected IDE only (project-level, never global)
  // Users add other agents manually via: unerr install <agent>
  let mcpConfigAction = "";
  try {
    const { writeMcpConfig } = await import("../config/mcp-config-writer.js");
    const mcpResult = writeMcpConfig(projectDir, detectedIde as any);
    if (mcpResult.action === "created") {
      mcpConfigAction = `MCP config written → ${mcpResult.path}`;
      clack.log.success(
        `🔌 MCP server registered for ${detectedIde} — AI agent will auto-connect to unerr intelligence`
      );
    } else if (mcpResult.action === "updated") {
      mcpConfigAction = `MCP config updated → ${mcpResult.path}`;
      clack.log.success(
        `🔌 MCP config updated for ${detectedIde} — unerr intelligence now wired in`
      );
    }
  } catch {
    // Non-blocking — MCP config can be written manually
  }

  // Summary
  const summaryLines = [
    `Mode:   MCP intelligence proxy (${detectedIde} detected)`,
    `Skills: ${skillCount} agent skills installed`,
  ];
  if (mcpConfigAction) {
    summaryLines.push(`MCP:    ${mcpConfigAction}`);
  }
  summaryLines.push("Config: .unerr/config.json");
  summaryLines.push("");
  summaryLines.push(
    "Your AI agent now has: blast radius, community detection,"
  );
  summaryLines.push("convention enforcement, and <5ms graph queries.");

  // Disclose auto-update once per machine (informed default-on) — shares the
  // `disclosed_at` flag with `unerr install`, so whichever onboarding path runs
  // first shows it and the other stays quiet. Best-effort, never blocks setup.
  try {
    const { discloseAutoUpdateOnce } = await import("../update/disclosure.js");
    const lines: string[] = [];
    if (discloseAutoUpdateOnce((l) => lines.push(l))) {
      summaryLines.push("");
      summaryLines.push(...lines);
    }
  } catch {
    // Non-blocking — disclosure can show on the next setup instead.
  }

  clack.note(summaryLines.join("\n"), "✅ Intelligence layer configured");
  clack.outro("🚀 Starting intelligence engine...");

  return { action: "setup", repoId };
}
