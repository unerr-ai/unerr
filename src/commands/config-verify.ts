/**
 * Self-healing MCP configuration (P5.6-ADV-04).
 *
 * Exposes `checkIdeConfig` / `repairIdeConfig`, the logic that detects and
 * migrates stale IDE MCP configs to the local-proxy format. Called at boot by
 * `autoVerifyIdeConfigs()` in cli.ts, so repair happens automatically — there
 * is no separate `unerr config` command.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getUnerrCommand } from "../config/mcp-config-writer.js";

interface MCPConfig {
  mcpServers?: Record<
    string,
    {
      command?: string;
      args?: string[];
      url?: string;
      env?: Record<string, string>;
    }
  >;
}

/** Sprint 5.4: Server mode for MCP config generation. */
export type McpServerMode = "proxy" | "standalone";

export function checkIdeConfig(
  ideName: string,
  configPath: string
): {
  found: boolean;
  configured: boolean;
  issues: string[];
  needsMigration: boolean;
} {
  const issues: string[] = [];

  if (!fs.existsSync(configPath)) {
    return {
      found: false,
      configured: false,
      issues: [`${ideName} config not found at ${configPath}`],
      needsMigration: false,
    };
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as MCPConfig;

    if (!config.mcpServers) {
      issues.push(`${ideName}: No mcpServers section found`);
      return { found: true, configured: false, issues, needsMigration: false };
    }

    const unerrServer = config.mcpServers.unerr;
    if (!unerrServer) {
      issues.push(`${ideName}: No unerr MCP server configured`);
      return { found: true, configured: false, issues, needsMigration: false };
    }

    // Check if still pointing to remote URL (needs migration to local proxy)
    if (unerrServer.url && !unerrServer.command) {
      issues.push(
        `${ideName}: unerr MCP config points to remote URL — should use local proxy`
      );
      return { found: true, configured: true, issues, needsMigration: true };
    }

    // Check if using local proxy correctly (absolute path or bare "unerr")
    const cmd = unerrServer.command ?? "";
    if (
      (cmd === "unerr" || cmd.endsWith("/unerr") || cmd.endsWith("\\unerr")) &&
      unerrServer.args?.includes("--mcp")
    ) {
      return { found: true, configured: true, issues, needsMigration: false };
    }

    // Legacy: npx @unerr/unerr format (needs migration to direct binary)
    if (
      unerrServer.command === "npx" &&
      unerrServer.args?.includes("@unerr/unerr")
    ) {
      issues.push(
        `${ideName}: using npx with unpublished package — should use direct 'unerr' binary`
      );
      return { found: true, configured: true, issues, needsMigration: true };
    }

    issues.push(`${ideName}: unerr MCP config has unexpected format`);
    return { found: true, configured: true, issues, needsMigration: true };
  } catch {
    issues.push(`${ideName}: Failed to parse config at ${configPath}`);
    return { found: true, configured: false, issues, needsMigration: false };
  }
}

export function repairIdeConfig(
  ideName: string,
  configPath: string,
  mode: McpServerMode = "proxy"
): boolean {
  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let config: MCPConfig = {};
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      config = JSON.parse(raw) as MCPConfig;
    }

    if (!config.mcpServers) config.mcpServers = {};

    const unerrBin = getUnerrCommand();
    if (mode === "standalone") {
      const graphPath = resolveGraphPath();
      config.mcpServers.unerr = {
        command: unerrBin,
        args: ["--mcp"],
        env: graphPath ? { UNERR_GRAPH_PATH: graphPath } : {},
      };
    } else {
      config.mcpServers.unerr = {
        command: unerrBin,
        args: ["--mcp"],
      };
    }

    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sprint 5.4: Resolve the graph snapshot path.
 * Looks in the repo's .unerr/snapshots/ directory.
 */
function resolveGraphPath(): string | null {
  const snapshotsDir = path.join(process.cwd(), ".unerr", "snapshots");
  if (!fs.existsSync(snapshotsDir)) return null;

  const files = fs
    .readdirSync(snapshotsDir)
    .filter((f) => f.endsWith(".msgpack.gz") || f.endsWith(".msgpack"))
    .map((f) => ({
      name: f,
      path: path.join(snapshotsDir, f),
      mtime: fs.statSync(path.join(snapshotsDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return files[0]?.path ?? null;
}
