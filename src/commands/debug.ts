/**
 * unerr debug — Diagnostics dump for support.
 *
 * Outputs: Node version, CLI version, OS, .unerr/ directory listing,
 * CozoDB file sizes, proxy PID status, credentials status (redacted),
 * git context, MCP config location, last 20 lines of proxy log.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { getCurrentBranch, getRemoteUrl } from "../utils/git.js";

const UNERR_DIR = join(homedir(), ".unerr");

export function registerDebugCommand(program: Command): void {
  program
    .command("debug")
    .description("Diagnostics dump for support")
    .action(async () => {
      const sections: string[] = [];

      // Header
      sections.push("=== unerr debug ===\n");

      // System info
      sections.push("## System");
      sections.push(`  Node:     ${process.version}`);
      sections.push(`  OS:       ${platform()} ${release()} ${arch()}`);
      sections.push("  CLI:      0.1.0");
      sections.push("");

      // Settings
      sections.push("## Settings");
      const settingsPath = join(UNERR_DIR, "settings.json");
      if (existsSync(settingsPath)) {
        try {
          const settings = JSON.parse(
            readFileSync(settingsPath, "utf-8")
          ) as Record<string, unknown>;
          for (const [key, value] of Object.entries(settings)) {
            if (key === "anthropicApiKey" && typeof value === "string") {
              sections.push(`  ${key}: ${value.slice(0, 8)}...`);
            } else {
              sections.push(`  ${key}: ${String(value)}`);
            }
          }
        } catch {
          sections.push("  (unreadable)");
        }
      } else {
        sections.push("  (not found)");
      }
      sections.push("");

      // Git context
      sections.push("## Git Context");
      const cwd = process.cwd();
      const remote = await getRemoteUrl(cwd);
      const branch = await getCurrentBranch(cwd);
      sections.push(`  Remote:   ${remote ?? "(none)"}`);
      sections.push(`  Branch:   ${branch ?? "(detached)"}`);
      sections.push("");

      // .unerr/config.json
      sections.push("## Project Config (.unerr/config.json)");
      const configPath = join(process.cwd(), ".unerr", "config.json");
      if (existsSync(configPath)) {
        try {
          const config = JSON.parse(
            readFileSync(configPath, "utf-8")
          ) as Record<string, unknown>;
          for (const [key, value] of Object.entries(config)) {
            sections.push(`  ${key}: ${String(value)}`);
          }
        } catch {
          sections.push("  (unreadable)");
        }
      } else {
        sections.push("  (not found)");
      }
      sections.push("");

      // Proxy PID
      sections.push("## Proxy Status");
      const pidPath = join(process.cwd(), ".unerr", "state", "proxy.pid");
      if (existsSync(pidPath)) {
        try {
          const pid = Number.parseInt(
            readFileSync(pidPath, "utf-8").trim(),
            10
          );
          let alive = false;
          try {
            process.kill(pid, 0);
            alive = true;
          } catch {
            /* not alive */
          }
          sections.push(`  PID:      ${pid} (${alive ? "RUNNING" : "STALE"})`);
        } catch {
          sections.push("  PID:      (unreadable)");
        }
      } else {
        sections.push("  PID:      (not running)");
      }
      sections.push("");

      // .unerr/ directory listing (repo-local)
      sections.push("## .unerr/ Directory (repo-local)");
      const localUnerrDir = join(process.cwd(), ".unerr");
      if (existsSync(localUnerrDir)) {
        listDir(localUnerrDir, "  ", sections, 0, 2);
      } else {
        sections.push("  (not found)");
      }
      sections.push("");

      // Snapshot sizes
      sections.push("## Snapshots");
      const snapshotsDir = join(localUnerrDir, "snapshots");
      if (existsSync(snapshotsDir)) {
        const files = readdirSync(snapshotsDir);
        if (files.length === 0) {
          sections.push("  (empty)");
        }
        for (const file of files) {
          const filePath = join(snapshotsDir, file);
          const stat = statSync(filePath);
          sections.push(`  ${file}: ${formatBytes(stat.size)}`);
        }
      } else {
        sections.push("  (no snapshots directory)");
      }
      sections.push("");

      // MCP config locations
      sections.push("## MCP Config Locations");
      const mcpLocations = [
        join(process.cwd(), ".cursor", "mcp.json"),
        join(process.cwd(), ".vscode", "mcp.json"),
        join(homedir(), ".claude", "claude_desktop_config.json"),
        join(
          homedir(),
          "Library",
          "Application Support",
          "Cursor",
          "User",
          "globalStorage",
          "cursor.mcp",
          "mcp.json"
        ),
      ];
      for (const loc of mcpLocations) {
        const exists = existsSync(loc);
        sections.push(
          `  ${exists ? "[x]" : "[ ]"} ${loc.replace(homedir(), "~")}`
        );
      }
      sections.push("");

      // Last 20 lines of proxy log
      sections.push("## Recent Log (last 20 lines)");
      const logsDir = join(process.cwd(), ".unerr", "logs");
      if (existsSync(logsDir)) {
        const logFiles = readdirSync(logsDir)
          .filter((f) => f.endsWith(".log"))
          .sort()
          .reverse();
        if (logFiles.length > 0 && logFiles[0]) {
          const logPath = join(logsDir, logFiles[0]);
          try {
            const content = readFileSync(logPath, "utf-8");
            const lines = content.split("\n").filter(Boolean);
            const last20 = lines.slice(-20);
            for (const line of last20) {
              sections.push(`  ${line}`);
            }
          } catch {
            sections.push("  (unreadable)");
          }
        } else {
          sections.push("  (no log files)");
        }
      } else {
        sections.push("  (no logs directory)");
      }

      // Output to stderr (stdout is reserved for MCP)
      console.error(sections.join("\n"));
    });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function listDir(
  dirPath: string,
  indent: string,
  out: string[],
  depth: number,
  maxDepth: number
): void {
  if (depth > maxDepth) return;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        out.push(`${indent}${entry.name}/`);
        listDir(
          join(dirPath, entry.name),
          `${indent}  `,
          out,
          depth + 1,
          maxDepth
        );
      } else {
        const size = formatBytes(statSync(join(dirPath, entry.name)).size);
        out.push(`${indent}${entry.name} (${size})`);
      }
    }
  } catch {
    out.push(`${indent}(permission denied)`);
  }
}
