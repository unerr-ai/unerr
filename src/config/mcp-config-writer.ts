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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  // Claude Code only (v2.1.121+): when true, every tool from this server loads
  // into the request's `tools` block at session start instead of being deferred
  // behind ToolSearch. We set it for claude-code so the unerr tools are present
  // in the cached prefix from turn 1 — loading a deferred tool mid-session
  // mutates the `tools` block (front of the cache prefix) and invalidates the
  // entire cached prefix, forcing a full re-write. Upfront load = one stable
  // prefix, cache reused across turns. Ignored by non-Claude agents.
  alwaysLoad?: boolean;
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

/** Build the `args` array for the MCP server entry. The coding-agent id is
 *  baked in at install time so the bridge can attribute every tool call
 *  from this entry to the named agent — works even when two IDEs share
 *  one daemon. */
function buildArgs(ide: IdeType): string[] {
  return ["--mcp", `--coding-agent=${ide}`];
}

function createUnerrServerEntry(ide: IdeType): McpServerEntry {
  return {
    type: "stdio",
    command: getUnerrCommand(),
    args: buildArgs(ide),
    // Pin unerr's tools into the upfront `tools` block for Claude Code so a
    // mid-session ToolSearch load never mutates the cache prefix (see
    // McpServerEntry.alwaysLoad). Only claude-code consumes this key (.mcp.json);
    // other agents write formats that ignore it.
    ...(ide === "claude-code" ? { alwaysLoad: true } : {}),
  };
}

function createCopilotServerEntry(ide: IdeType): McpServerEntry {
  return {
    type: "local",
    command: getUnerrCommand(),
    args: buildArgs(ide),
  };
}

/** True when an existing config entry matches both binary AND args exactly.
 *  Comparing args ensures that a re-install upgrades older entries that
 *  pre-date the `--coding-agent` flag. */
function entryMatches(
  current: McpServerEntry,
  desired: McpServerEntry
): boolean {
  if (current.command !== desired.command) return false;
  const a = current.args ?? [];
  const b = desired.args ?? [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
      return writeMcpJsonFormat(configPath, ide);
    case "settings-json":
      return writeSettingsJsonFormat(configPath, ide);
    case "copilot-json":
      return writeCopilotJsonFormat(configPath, ide);
    case "continue-config":
      return writeContinueFormat(configPath, ide);
    case "toml":
      return writeTomlFormat(configPath, ide);
    default:
      return writeMcpJsonFormat(configPath, ide);
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
    if (agent.configFormat === "toml") {
      return removeTomlConfig(configPath);
    }
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

    // If the config has no remaining servers and is project-scoped, delete the
    // file and prune the parent directory if empty. We own the file when no
    // other entries remain — global configs are co-owned and left in place.
    if (
      agent.configScope !== "global" &&
      isConfigEmpty(existing, agent.configFormat)
    ) {
      unlinkSync(configPath);
      tryRmdir(dirname(configPath));
    } else {
      writeFileSync(configPath, JSON.stringify(existing, null, 2), "utf-8");
    }
    return true;
  } catch {
    return false;
  }
}

/** True when the config has no MCP servers in the shape its format expects. */
function isConfigEmpty(
  config: Record<string, unknown>,
  format: McpConfigFormat
): boolean {
  if (format === "continue-config") {
    const servers = config.mcpServers;
    return Array.isArray(servers) && servers.length === 0;
  }
  if (format === "settings-json") {
    const servers = (
      config.mcp as { servers?: Record<string, unknown> } | undefined
    )?.servers;
    return !servers || Object.keys(servers).length === 0;
  }
  const servers = config.mcpServers as Record<string, unknown> | undefined;
  return !servers || Object.keys(servers).length === 0;
}

/** rmdir if empty; silent on ENOTEMPTY/ENOENT. */
function tryRmdir(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    /* dir not empty or already gone */
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
    if (agent.configFormat === "toml") {
      const content = readFileSync(configPath, "utf-8");
      return content.includes(`[mcp_servers.${UNERR_SERVER_KEY}]`);
    }
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

  const entry = createUnerrServerEntry(ide);

  switch (agent.configFormat) {
    case "settings-json":
      return JSON.stringify(
        { mcp: { servers: { [UNERR_SERVER_KEY]: entry } } },
        null,
        2
      );
    case "copilot-json": {
      const copilotEntry = createCopilotServerEntry(ide);
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
    case "toml":
      return buildTomlSection(entry);
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

function writeMcpJsonFormat(
  configPath: string,
  ide: IdeType
): {
  path: string;
  action: "created" | "updated" | "skipped";
} {
  if (existsSync(configPath)) {
    try {
      const existing = JSON.parse(
        readFileSync(configPath, "utf-8")
      ) as McpConfig;
      const current = existing.mcpServers?.[UNERR_SERVER_KEY];
      const desired = createUnerrServerEntry(ide);
      if (current && entryMatches(current, desired)) {
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
    mcpServers: { [UNERR_SERVER_KEY]: createUnerrServerEntry(ide) },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  return { path: configPath, action: "created" };
}

function writeSettingsJsonFormat(
  configPath: string,
  ide: IdeType
): {
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
      const desired = createUnerrServerEntry(ide);
      if (current && entryMatches(current, desired)) {
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
    mcp: { servers: { [UNERR_SERVER_KEY]: createUnerrServerEntry(ide) } },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  return { path: configPath, action: "created" };
}

function writeContinueFormat(
  configPath: string,
  ide: IdeType
): {
  path: string;
  action: "created" | "updated" | "skipped";
} {
  const entry = { name: UNERR_SERVER_KEY, ...createUnerrServerEntry(ide) };

  if (existsSync(configPath)) {
    try {
      const existing = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
      const servers = (existing.mcpServers ?? []) as Array<
        McpServerEntry & { name?: string }
      >;
      const idx = servers.findIndex((s) => s.name === UNERR_SERVER_KEY);
      if (idx >= 0 && entryMatches(servers[idx] as McpServerEntry, entry)) {
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

// ── TOML format (Codex) ──────────────────────────────────────────

/** Build the TOML section string for [mcp_servers.unerr]. */
function buildTomlSection(entry: McpServerEntry): string {
  const args = entry.args.map((a) => `"${a}"`).join(", ");
  return `[mcp_servers.${UNERR_SERVER_KEY}]\ntype = "stdio"\ncommand = "${entry.command}"\nargs = [${args}]`;
}

/** Remove the [mcp_servers.unerr] section from a TOML file. */
function removeTomlConfig(configPath: string): boolean {
  try {
    const content = readFileSync(configPath, "utf-8");
    const sectionHeader = `[mcp_servers.${UNERR_SERVER_KEY}]`;
    const idx = content.indexOf(sectionHeader);
    if (idx < 0) return false;

    // Find the end of this section (next [section] header or EOF)
    const afterHeader = idx + sectionHeader.length;
    const nextSection = content.indexOf("\n[", afterHeader);
    const end = nextSection >= 0 ? nextSection : content.length;

    const before = content.slice(0, idx).replace(/\n+$/, "");
    const after = content.slice(end);
    const updated = (before + after).trim();

    if (updated.length === 0) {
      unlinkSync(configPath);
      tryRmdir(dirname(configPath));
    } else {
      writeFileSync(configPath, `${updated}\n`, "utf-8");
    }
    return true;
  } catch {
    return false;
  }
}

function writeTomlFormat(
  configPath: string,
  ide: IdeType
): {
  path: string;
  action: "created" | "updated" | "skipped";
} {
  const entry = createUnerrServerEntry(ide);
  const section = buildTomlSection(entry);

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      const sectionHeader = `[mcp_servers.${UNERR_SERVER_KEY}]`;

      if (content.includes(sectionHeader)) {
        // Check if the existing section matches
        const idx = content.indexOf(sectionHeader);
        const afterHeader = idx + sectionHeader.length;
        const nextSection = content.indexOf("\n[", afterHeader);
        const end = nextSection >= 0 ? nextSection : content.length;
        const existingSection = content.slice(idx, end).trim();

        if (existingSection === section) {
          return { path: configPath, action: "skipped" };
        }

        // Replace existing section
        const before = content.slice(0, idx);
        const after = content.slice(end);
        writeFileSync(configPath, before + section + after, "utf-8");
        return { path: configPath, action: "updated" };
      }

      // Append the section
      const separator = content.endsWith("\n") ? "\n" : "\n\n";
      writeFileSync(configPath, `${content}${separator}${section}\n`, "utf-8");
      return { path: configPath, action: "updated" };
    } catch {
      return { path: configPath, action: "skipped" };
    }
  }

  writeFileSync(configPath, `${section}\n`, "utf-8");
  return { path: configPath, action: "created" };
}

function writeCopilotJsonFormat(
  configPath: string,
  ide: IdeType
): {
  path: string;
  action: "created" | "updated" | "skipped";
} {
  if (existsSync(configPath)) {
    try {
      const existing = JSON.parse(
        readFileSync(configPath, "utf-8")
      ) as McpConfig;
      const current = existing.mcpServers?.[UNERR_SERVER_KEY];
      const desired = createCopilotServerEntry(ide);
      if (current && entryMatches(current, desired)) {
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
    mcpServers: { [UNERR_SERVER_KEY]: createCopilotServerEntry(ide) },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  return { path: configPath, action: "created" };
}
