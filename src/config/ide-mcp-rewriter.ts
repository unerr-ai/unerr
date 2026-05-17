/**
 * IDE MCP config rewriter — replaces all MCP server entries in an IDE
 * config file with a single unerr gateway endpoint.
 *
 * This is the "write" half of the router activation flow:
 *   inspector reads → activation plan → rewriter writes
 *
 * Idempotent: if the config already has unerr as the sole endpoint
 * with `--mcp` args, this is a no-op.
 *
 * The rewriter preserves any non-mcpServers keys in the config file
 * (e.g., VS Code editor settings, Continue model configs).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { getUnerrCommand, type McpConfig, type McpServerEntry } from "./mcp-config-writer.js";
import type { AgentDefinition } from "./agent-registry.js";

const UNERR_SERVER_KEY = "unerr";

function createRouterEntry(): McpServerEntry {
  return {
    type: "stdio",
    command: getUnerrCommand(),
    args: ["--mcp"],
  };
}

/**
 * Rewrite an mcp-json format config to contain only the unerr gateway.
 * Returns true if the file was modified, false if already correct.
 */
function rewriteMcpJson(configPath: string): boolean {
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      raw = {};
    }
  }

  const existing = raw.mcpServers as Record<string, McpServerEntry> | undefined;
  const desired = createRouterEntry();

  if (
    existing &&
    Object.keys(existing).length === 1 &&
    existing[UNERR_SERVER_KEY]?.command === desired.command &&
    JSON.stringify(existing[UNERR_SERVER_KEY]?.args) === JSON.stringify(desired.args)
  ) {
    return false;
  }

  raw.mcpServers = { [UNERR_SERVER_KEY]: desired };
  writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf-8");
  return true;
}

/**
 * Rewrite a settings-json format config (VS Code style).
 * Preserves all non-MCP settings.
 */
function rewriteSettingsJson(configPath: string): boolean {
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      raw = {};
    }
  }

  const mcp = (raw.mcp ?? {}) as Record<string, unknown>;
  const servers = mcp.servers as Record<string, McpServerEntry> | undefined;
  const desired = createRouterEntry();

  if (
    servers &&
    Object.keys(servers).length === 1 &&
    servers[UNERR_SERVER_KEY]?.command === desired.command &&
    JSON.stringify(servers[UNERR_SERVER_KEY]?.args) === JSON.stringify(desired.args)
  ) {
    return false;
  }

  mcp.servers = { [UNERR_SERVER_KEY]: desired };
  raw.mcp = mcp;
  writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf-8");
  return true;
}

/**
 * Rewrite a copilot-json format config.
 */
function rewriteCopilotJson(configPath: string): boolean {
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      raw = {};
    }
  }

  const desired: McpServerEntry = {
    type: "local",
    command: getUnerrCommand(),
    args: ["--mcp"],
  };

  const existing = raw.mcpServers as Record<string, McpServerEntry> | undefined;
  if (
    existing &&
    Object.keys(existing).length === 1 &&
    existing[UNERR_SERVER_KEY]?.command === desired.command
  ) {
    return false;
  }

  raw.mcpServers = { [UNERR_SERVER_KEY]: desired };
  writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf-8");
  return true;
}

/**
 * Rewrite a Continue config to use only the unerr gateway.
 * Preserves non-MCP settings (models, providers, etc.).
 */
function rewriteContinueConfig(configPath: string): boolean {
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      raw = {};
    }
  }

  const desired = createRouterEntry();
  const arr = raw.mcpServers as unknown[] | undefined;

  if (
    Array.isArray(arr) &&
    arr.length === 1 &&
    (arr[0] as Record<string, unknown>)?.name === UNERR_SERVER_KEY
  ) {
    return false;
  }

  raw.mcpServers = [{ name: UNERR_SERVER_KEY, ...desired }];
  writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf-8");
  return true;
}

/**
 * Rewrite an IDE config file to use the unerr gateway as the sole MCP endpoint.
 * Format is determined by the agent definition.
 * Returns true if the file was actually modified.
 */
export function rewriteIdeConfig(
  configPath: string,
  format: AgentDefinition["configFormat"],
): boolean {
  switch (format) {
    case "mcp-json":
      return rewriteMcpJson(configPath);
    case "settings-json":
      return rewriteSettingsJson(configPath);
    case "copilot-json":
      return rewriteCopilotJson(configPath);
    case "continue-config":
      return rewriteContinueConfig(configPath);
    default:
      return rewriteMcpJson(configPath);
  }
}
