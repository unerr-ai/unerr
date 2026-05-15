/**
 * `unerr init` — auto-detect AI tools, install hooks, write MCP config.
 *
 * S6.2+S6.3: Combines tool detection, hook installation, and MCP config
 * writing into a single command. Idempotent — safe to run multiple times.
 *
 * All output to stderr (stdout is MCP-sacred).
 */

import type { Command } from "commander";
import { installClaudeHook } from "../config/hook-installer.js";
import { writeMcpConfig } from "../config/mcp-config-writer.js";
import { detectTools, formatDetectedTools } from "../config/tool-detector.js";

export interface InitResult {
  detectedTools: string[];
  hooksInstalled: string[];
  configsWritten: string[];
  skipped: string[];
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Auto-detect AI tools and configure unerr integration")
    .action(async () => {
      const cwd = process.cwd();
      const result = runInit(cwd);

      if (result.detectedTools.length === 0) {
        process.stderr.write(
          "[unerr] No AI tools detected. Create a .cursor/, .claude/, or .vscode/ directory first.\n"
        );
        process.stderr.write(
          "[unerr] Or run 'unerr' directly — it will start the MCP proxy on stdio.\n"
        );
        return;
      }

      process.stderr.write(
        `[unerr] Detected: ${result.detectedTools.join(", ")}\n`
      );

      for (const h of result.hooksInstalled) {
        process.stderr.write(`[unerr] ✓ ${h}\n`);
      }
      for (const c of result.configsWritten) {
        process.stderr.write(`[unerr] ✓ ${c}\n`);
      }
      for (const s of result.skipped) {
        process.stderr.write(`[unerr] · ${s}\n`);
      }

      process.stderr.write("[unerr] Init complete. Run 'unerr' to start.\n");
    });
}

/**
 * Core init logic — testable without Commander.
 */
export function runInit(cwd: string): InitResult {
  const tools = detectTools(cwd);
  const result: InitResult = {
    detectedTools: [],
    hooksInstalled: [],
    configsWritten: [],
    skipped: [],
  };

  for (const tool of tools) {
    const name = formatDetectedTools([tool]);
    result.detectedTools.push(name);

    // Install hook for Claude Code
    if (tool.ide === "claude-code") {
      const hookResult = installClaudeHook(cwd);
      if (hookResult.action === "installed") {
        result.hooksInstalled.push(
          `Installed Claude Code hook at ${hookResult.path}`
        );
      } else if (hookResult.action === "already_exists") {
        result.skipped.push("Claude Code hook already installed");
      }
    }

    // Write MCP config for all detected tools
    const configResult = writeMcpConfig(cwd, tool.ide);
    if (configResult.action === "created") {
      result.configsWritten.push(`Created MCP config at ${configResult.path}`);
    } else if (configResult.action === "updated") {
      result.configsWritten.push(
        `Added unerr to existing config at ${configResult.path}`
      );
    } else {
      result.skipped.push(`MCP config for ${name} already configured`);
    }
  }

  return result;
}
