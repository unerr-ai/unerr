/**
 * MCP Config Writer — generates per-agent MCP config with unerr server configuration.
 *
 * Registry-driven: uses agent-registry.ts to determine config path and format.
 * Idempotent — never overwrites user customizations, only adds/merges unerr entry.
 *
 * Supported formats:
 *   - mcp-json: { mcpServers: { unerr: { ... } } }
 *   - settings-json: { "mcp": { "servers": { unerr: { ... } } } } (Gemini CLI)
 *   - continue-config: { mcpServers: [{ name: "unerr", ... }] } (Continue.dev)
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { IdeType } from "../utils/detect.js";
import {
  AGENT_REGISTRY,
  type AgentDefinition,
  type McpConfigFormat,
  getAgent,
} from "./agent-registry.js";

export interface McpServerEntry {
  type?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

const UNERR_SERVER_KEY = "unerr";

/**
 * Resolve the absolute path to the `unerr` binary at install time.
 *
 * IDEs spawn MCP servers as child processes that do NOT inherit the user's
 * interactive shell profile (no ~/.zshrc, ~/.bashrc). On macOS, GUI apps
 * launched from Dock/Spotlight get a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
 * Using a bare "unerr" command would silently fail for nvm/fnm/pnpm/volta users.
 *
 * Resolution order:
 * 1. process.argv[1] — the script currently running (works for global installs)
 * 2. `which unerr` / `where unerr` — PATH lookup at install time
 * 3. "unerr" — bare name as last resort
 */
function resolveUnerrCommand(): string {
  const entryScript = process.argv[1];
  if (entryScript && existsSync(entryScript)) {
    const base = basename(entryScript);
    if (base === "unerr" || base.startsWith("unerr.")) {
      return entryScript;
    }
  }

  const whichCmd = process.platform === "win32" ? "where unerr" : "which unerr";
  try {
    const resolved = execSync(whichCmd, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .trim()
      .split(/\r?\n/)[0]; // `where` on Windows may return multiple lines
    if (resolved && existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // not found — fall through
  }

  return "unerr";
}

let _resolvedCommand: string | undefined;
export function getUnerrCommand(): string {
  if (_resolvedCommand === undefined) {
    _resolvedCommand = resolveUnerrCommand();
  }
  return _resolvedCommand;
}

function createUnerrServerEntry(): McpServerEntry {
  return {
    type: "stdio",
    command: getUnerrCommand(),
    args: ["--mcp"],
  };
}

function createCopilotServerEntry(): McpServerEntry {
  return {
    type: "local",
    command: getUnerrCommand(),
    args: ["--mcp"],
  };
}

/**
 * Write MCP config for a detected agent.
 * Idempotent: if config exists with unerr entry, skips.
 * If config exists without unerr entry, merges without overwriting.
 */
export function writeMcpConfig(
  cwd: string,
  ide: IdeType
): { path: string; action: "created" | "updated" | "skipped" } {
  const agent = getAgent(ide);
  if (!agent) {
    return { path: "", action: "skipped" };
  }

  const configPath =
    agent.configScope === "global"
      ? join(homedir(), agent.projectConfigPath)
      : join(cwd, agent.projectConfigPath);
  const dir = dirname(configPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  switch (agent.configFormat) {
    case "mcp-json":
      return writeMcpJsonFormat(configPath);
    case "settings-json":
      return writeSettingsJsonFormat(configPath);
    case "copilot-json":
      return writeCopilotJsonFormat(configPath);
    case "continue-config":
      return writeContinueFormat(configPath);
    default:
      return writeMcpJsonFormat(configPath);
  }
}

/**
 * Write config for ALL detected agents at once.
 */
export function writeAllMcpConfigs(
  cwd: string,
  agents: IdeType[]
): Array<{
  ide: IdeType;
  path: string;
  action: "created" | "updated" | "skipped";
}> {
  return agents.map((ide) => {
    const result = writeMcpConfig(cwd, ide);
    return { ide, ...result };
  });
}

/**
 * Remove unerr entry from MCP config.
 */
export function removeMcpConfig(cwd: string, ide: IdeType): boolean {
  const agent = getAgent(ide);
  if (!agent) return false;

  const configPath =
    agent.configScope === "global"
      ? join(homedir(), agent.projectConfigPath)
      : join(cwd, agent.projectConfigPath);
  if (!existsSync(configPath)) return false;

  try {
    const existing = JSON.parse(readFileSync(configPath, "utf-8"));
    if (agent.configFormat === "continue-config") {
      if (!Array.isArray(existing.mcpServers)) return false;
      existing.mcpServers = existing.mcpServers.filter(
        (s: { name?: string }) => s.name !== UNERR_SERVER_KEY
      );
    } else if (agent.configFormat === "settings-json") {
      if (!existing.mcp?.servers?.[UNERR_SERVER_KEY]) return false;
      delete existing.mcp.servers[UNERR_SERVER_KEY];
    } else if (agent.configFormat === "copilot-json") {
      if (!existing.mcpServers?.[UNERR_SERVER_KEY]) return false;
      delete existing.mcpServers[UNERR_SERVER_KEY];
    } else {
      if (!existing.mcpServers?.[UNERR_SERVER_KEY]) return false;
      delete existing.mcpServers[UNERR_SERVER_KEY];
    }
    writeFileSync(configPath, JSON.stringify(existing, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if unerr is already configured for an IDE.
 */
export function isConfigured(cwd: string, ide: IdeType): boolean {
  const agent = getAgent(ide);
  if (!agent) return false;

  const configPath =
    agent.configScope === "global"
      ? join(homedir(), agent.projectConfigPath)
      : join(cwd, agent.projectConfigPath);
  if (!existsSync(configPath)) return false;

  try {
    const existing = JSON.parse(readFileSync(configPath, "utf-8"));
    if (agent.configFormat === "continue-config") {
      return (
        Array.isArray(existing.mcpServers) &&
        existing.mcpServers.some(
          (s: { name?: string }) => s.name === UNERR_SERVER_KEY
        )
      );
    }
    if (agent.configFormat === "settings-json") {
      return !!existing.mcp?.servers?.[UNERR_SERVER_KEY];
    }
    if (agent.configFormat === "copilot-json") {
      return !!existing.mcpServers?.[UNERR_SERVER_KEY];
    }
    return !!existing.mcpServers?.[UNERR_SERVER_KEY];
  } catch {
    return false;
  }
}

/**
 * Generate the MCP config JSON string for manual copy-paste.
 * Useful for agents that can't be auto-configured.
 */
export function generateConfigSnippet(ide: IdeType): string {
  const agent = getAgent(ide);
  if (!agent) return "";

  const entry = createUnerrServerEntry();

  switch (agent.configFormat) {
    case "settings-json":
      return JSON.stringify(
        { mcp: { servers: { [UNERR_SERVER_KEY]: entry } } },
        null,
        2
      );
    case "copilot-json": {
      const copilotEntry = createCopilotServerEntry();
      return JSON.stringify(
        { mcpServers: { [UNERR_SERVER_KEY]: copilotEntry } },
        null,
        2
      );
    }
    case "continue-config":
      return JSON.stringify(
        { mcpServers: [{ name: UNERR_SERVER_KEY, ...entry }] },
        null,
        2
      );
    default:
      return JSON.stringify(
        { mcpServers: { [UNERR_SERVER_KEY]: entry } },
        null,
        2
      );
  }
}

/**
 * Get config info for display purposes.
 */
export function getConfigInfo(
  ide: IdeType
): { path: string; format: string } | null {
  const agent = getAgent(ide);
  if (!agent) return null;
  return {
    path: agent.projectConfigPath,
    format: agent.configFormat,
  };
}

// ── Format-specific writers ─────────────────────────────────────

function writeMcpJsonFormat(configPath: string): {
  path: string;
  action: "created" | "updated" | "skipped";
} {
  if (existsSync(configPath)) {
    try {
      const existing = JSON.parse(
        readFileSync(configPath, "utf-8")
      ) as McpConfig;
      const current = existing.mcpServers?.[UNERR_SERVER_KEY];
      const desired = createUnerrServerEntry();
      if (current && current.command === desired.command) {
        return { path: configPath, action: "skipped" };
      }
      existing.mcpServers = existing.mcpServers ?? {};
      existing.mcpServers[UNERR_SERVER_KEY] = desired;
      writeFileSync(configPath, JSON.stringify(existing, null, 2), "utf-8");
      return { path: configPath, action: "updated" };
    } catch {
      return { path: configPath, action: "skipped" };
    }
  }

  const config: McpConfig = {
    mcpServers: { [UNERR_SERVER_KEY]: createUnerrServerEntry() },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  return { path: configPath, action: "created" };
}

function writeSettingsJsonFormat(configPath: string): {
  path: string;
  action: "created" | "updated" | "skipped";
} {
  if (existsSync(configPath)) {
    try {
      const existing = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
      const mcp = (existing.mcp ?? {}) as Record<string, unknown>;
      const servers = (mcp.servers ?? {}) as Record<string, McpServerEntry>;
      const current = servers[UNERR_SERVER_KEY];
      const desired = createUnerrServerEntry();
      if (current && current.command === desired.command) {
        return { path: configPath, action: "skipped" };
      }
      servers[UNERR_SERVER_KEY] = desired;
      mcp.servers = servers;
      existing.mcp = mcp;
      writeFileSync(configPath, JSON.stringify(existing, null, 2), "utf-8");
      return { path: configPath, action: "updated" };
    } catch {
      return { path: configPath, action: "skipped" };
    }
  }

  const config = {
    mcp: { servers: { [UNERR_SERVER_KEY]: createUnerrServerEntry() } },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  return { path: configPath, action: "created" };
}

function writeContinueFormat(configPath: string): {
  path: string;
  action: "created" | "updated" | "skipped";
} {
  const entry = { name: UNERR_SERVER_KEY, ...createUnerrServerEntry() };

  if (existsSync(configPath)) {
    try {
      const existing = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
      const servers = (existing.mcpServers ?? []) as Array<{
        name?: string;
        command?: string;
      }>;
      const idx = servers.findIndex((s) => s.name === UNERR_SERVER_KEY);
      if (idx >= 0 && servers[idx]?.command === entry.command) {
        return { path: configPath, action: "skipped" };
      }
      if (idx >= 0) {
        servers[idx] = entry;
      } else {
        servers.push(entry);
      }
      existing.mcpServers = servers;
      writeFileSync(configPath, JSON.stringify(existing, null, 2), "utf-8");
      return { path: configPath, action: "updated" };
    } catch {
      return { path: configPath, action: "skipped" };
    }
  }

  const config = { mcpServers: [entry] };
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  return { path: configPath, action: "created" };
}

function writeCopilotJsonFormat(configPath: string): {
  path: string;
  action: "created" | "updated" | "skipped";
} {
  if (existsSync(configPath)) {
    try {
      const existing = JSON.parse(
        readFileSync(configPath, "utf-8")
      ) as McpConfig;
      const current = existing.mcpServers?.[UNERR_SERVER_KEY];
      const desired = createCopilotServerEntry();
      if (current && current.command === desired.command) {
        return { path: configPath, action: "skipped" };
      }
      existing.mcpServers = existing.mcpServers ?? {};
      existing.mcpServers[UNERR_SERVER_KEY] = desired;
      writeFileSync(configPath, JSON.stringify(existing, null, 2), "utf-8");
      return { path: configPath, action: "updated" };
    } catch {
      return { path: configPath, action: "skipped" };
    }
  }

  const config: McpConfig = {
    mcpServers: { [UNERR_SERVER_KEY]: createCopilotServerEntry() },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  return { path: configPath, action: "created" };
}
