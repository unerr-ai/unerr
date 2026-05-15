/**
 * unerr config verify — P5.6-ADV-04: Self-healing MCP configuration.
 * Checks and repairs MCP config for supported IDEs (VS Code, Cursor, etc.)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";

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

const IDE_CONFIG_PATHS: Record<string, string> = {
  vscode: path.join(os.homedir(), ".vscode", "settings.json"),
  cursor: path.join(os.homedir(), ".cursor", "mcp.json"),
  windsurf: path.join(os.homedir(), ".windsurf", "mcp.json"),
  "claude-code": path.join(
    os.homedir(),
    ".claude",
    "claude_desktop_config.json"
  ),
};

function loadConfig(): {
  repoId: string;
} | null {
  const configPath = path.join(process.cwd(), ".unerr", "config.json");
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
    repoId: string;
  };
}

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

    // Check if using local proxy correctly (direct binary or npx)
    if (
      unerrServer.command === "unerr" &&
      unerrServer.args?.includes("--mcp")
    ) {
      return { found: true, configured: true, issues, needsMigration: false };
    }

    // Legacy: npx @unerr/unerr format (needs migration to direct binary)
    if (
      unerrServer.command === "npx" &&
      (unerrServer.args?.includes("@unerr/unerr") ||
        unerrServer.args?.includes("@unerr/unerr-mcp"))
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

    if (mode === "standalone") {
      // Sprint 5.4: Standalone read-only MCP server
      const graphPath = resolveGraphPath();
      config.mcpServers.unerr = {
        command: "unerr",
        args: ["--mcp"],
        env: graphPath ? { UNERR_GRAPH_PATH: graphPath } : {},
      };
    } else {
      // Local proxy — direct binary
      config.mcpServers.unerr = {
        command: "unerr",
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

export function registerConfigVerifyCommand(program: Command) {
  const configCmd = program
    .command("config")
    .description("Manage unerr configuration");

  configCmd
    .command("verify")
    .description("Check and optionally repair MCP configuration for IDEs")
    .option("--silent", "Only output errors")
    .option("--repair", "Automatically repair misconfigured IDEs")
    .option(
      "--ide <ide>",
      "Check specific IDE (vscode, cursor, windsurf, claude-code)"
    )
    .option(
      "--mode <mode>",
      "Server mode: proxy (full) or standalone (read-only)",
      "proxy"
    )
    .action(
      async (opts: {
        silent?: boolean;
        repair?: boolean;
        ide?: string;
        mode?: string;
      }) => {
        const idesToCheck = opts.ide
          ? { [opts.ide]: IDE_CONFIG_PATHS[opts.ide] ?? "" }
          : IDE_CONFIG_PATHS;

        let allGood = true;

        for (const [ideName, configPath] of Object.entries(idesToCheck)) {
          if (!configPath) {
            if (!opts.silent) console.log(`  Unknown IDE: ${ideName}`);
            continue;
          }

          const result = checkIdeConfig(ideName, configPath);

          if (result.configured && result.issues.length === 0) {
            if (!opts.silent)
              console.log(`  ✓ ${ideName}: configured correctly`);
          } else {
            allGood = false;
            for (const issue of result.issues) {
              console.log(`  ✗ ${issue}`);
            }

            if (opts.repair) {
              const serverMode = (
                opts.mode === "standalone" ? "standalone" : "proxy"
              ) as McpServerMode;
              const repaired = repairIdeConfig(ideName, configPath, serverMode);
              if (repaired) {
                console.log(`  ✓ ${ideName}: repaired`);
              } else {
                console.log(`  ✗ ${ideName}: repair failed`);
              }
            }
          }
        }

        if (!allGood && !opts.repair) {
          console.log("\n  Run with --repair to fix issues automatically.");
        }

        if (allGood && !opts.silent) {
          console.log("\n  All IDE configurations look good!");
        }
      }
    );

  // Show MCP config for manual copy-paste
  configCmd
    .command("show")
    .description("Show MCP config snippet for an agent (for manual setup)")
    .argument("[agent]", "Agent name (e.g. cursor, claude-code, kiro) or 'all'")
    .action(async (agent?: string) => {
      const { generateConfigSnippet, getConfigInfo } = await import(
        "../config/mcp-config-writer.js"
      );
      const { AGENT_REGISTRY } = await import("../config/agent-registry.js");
      const { ideDisplayName } = await import("../utils/detect.js");

      if (!agent || agent === "all") {
        console.log("\n  Supported agents and their MCP config paths:\n");
        for (const a of AGENT_REGISTRY) {
          console.log(`    ${a.name.padEnd(22)} ${a.projectConfigPath}`);
        }
        console.log(
          "\n  Usage: unerr install <agent>\n  Example: unerr install kiro\n"
        );
        return;
      }

      const agentDef = AGENT_REGISTRY.find(
        (a) => a.id === agent || a.name.toLowerCase() === agent.toLowerCase()
      );
      if (!agentDef) {
        console.error(
          `  Unknown agent: ${agent}\n  Available: ${AGENT_REGISTRY.map((a) => a.id).join(", ")}`
        );
        process.exit(1);
      }

      const info = getConfigInfo(agentDef.id);
      const snippet = generateConfigSnippet(agentDef.id);

      console.log(`\n  ${agentDef.name} — ${agentDef.description}`);
      console.log(`  Config path: ${info?.path}\n`);
      console.log("  Add this to your config:\n");
      console.log(
        snippet
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")
      );
      console.log("");
    });

  // Git hooks sub-command
  configCmd
    .command("install-hooks")
    .description("Install git hooks for automatic MCP config verification")
    .action(async () => {
      const gitDir = path.join(process.cwd(), ".git");
      if (!fs.existsSync(gitDir)) {
        console.error("Not a git repository");
        process.exit(1);
      }

      const hooksDir = path.join(gitDir, "hooks");
      if (!fs.existsSync(hooksDir)) {
        fs.mkdirSync(hooksDir, { recursive: true });
      }

      const hookScript = `#!/bin/sh
# unerr auto-verify MCP config
if command -v unerr &> /dev/null; then
  unerr config verify --silent 2>/dev/null || true
fi
`;

      for (const hookName of ["post-checkout", "post-merge"]) {
        const hookPath = path.join(hooksDir, hookName);
        if (fs.existsSync(hookPath)) {
          const existing = fs.readFileSync(hookPath, "utf-8");
          if (existing.includes("unerr config verify")) {
            console.log(`  ✓ ${hookName}: already installed`);
            continue;
          }
          fs.appendFileSync(hookPath, `\n${hookScript}`);
        } else {
          fs.writeFileSync(hookPath, hookScript);
          fs.chmodSync(hookPath, "755");
        }
        console.log(`  ✓ ${hookName}: installed`);
      }
    });
}
