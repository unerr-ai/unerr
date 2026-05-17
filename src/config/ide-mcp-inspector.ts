/**
 * IDE MCP config inspector — reads every supported IDE's MCP config file
 * in a given repo directory and returns a structured list of servers found.
 *
 * This is the "read" half of the router activation flow:
 *   inspector reads → activation plan → rewriter writes
 *
 * Supports all config formats in the agent registry:
 *   - mcp-json: `{ mcpServers: { ... } }`
 *   - settings-json: `{ mcp: { servers: { ... } } }`
 *   - copilot-json: `{ mcpServers: { ... } }` with type: "local"
 *   - continue-config: `{ mcpServers: [...] }` in config.json
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { AGENT_REGISTRY, type AgentDefinition } from "./agent-registry.js";
import type { McpConfig, McpServerEntry } from "./mcp-config-writer.js";

export interface DiscoveredServer {
  readonly name: string;
  readonly entry: McpServerEntry;
  readonly toolCount: number | null;
}

export interface IdeConfigResult {
  readonly agentId: string;
  readonly agentName: string;
  readonly configPath: string;
  readonly relativeConfigPath: string;
  readonly servers: readonly DiscoveredServer[];
  readonly isUnerrAlreadyRouter: boolean;
}

const UNERR_SERVER_KEY = "unerr";

function isUnerrRouterEntry(entry: McpServerEntry): boolean {
  return (
    entry.args?.includes("--mcp") === true ||
    entry.args?.includes("--mcp-router") === true
  );
}

function extractMcpJsonServers(
  raw: Record<string, unknown>,
): Record<string, McpServerEntry> | null {
  const servers = raw.mcpServers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    return servers as Record<string, McpServerEntry>;
  }
  return null;
}

function extractSettingsJsonServers(
  raw: Record<string, unknown>,
): Record<string, McpServerEntry> | null {
  const mcp = raw.mcp as Record<string, unknown> | undefined;
  if (!mcp) return null;
  const servers = mcp.servers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    return servers as Record<string, McpServerEntry>;
  }
  return null;
}

function extractContinueServers(
  raw: Record<string, unknown>,
): Record<string, McpServerEntry> | null {
  const arr = raw.mcpServers;
  if (!Array.isArray(arr)) return null;
  const result: Record<string, McpServerEntry> = {};
  for (const item of arr) {
    if (item && typeof item === "object" && "name" in item) {
      const name = (item as { name: string }).name;
      result[name] = item as McpServerEntry;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function extractServers(
  format: AgentDefinition["configFormat"],
  raw: Record<string, unknown>,
): Record<string, McpServerEntry> | null {
  switch (format) {
    case "mcp-json":
    case "copilot-json":
      return extractMcpJsonServers(raw);
    case "settings-json":
      return extractSettingsJsonServers(raw);
    case "continue-config":
      return extractContinueServers(raw);
    default:
      return extractMcpJsonServers(raw);
  }
}

function inspectOneAgent(
  cwd: string,
  agent: AgentDefinition,
): IdeConfigResult | null {
  if (agent.configScope === "global") return null;

  const configPath = join(cwd, agent.projectConfigPath);
  if (!existsSync(configPath)) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }

  const servers = extractServers(agent.configFormat, raw);
  if (!servers || Object.keys(servers).length === 0) return null;

  let isUnerrAlreadyRouter = false;
  const discovered: DiscoveredServer[] = [];

  for (const [name, entry] of Object.entries(servers)) {
    if (name === UNERR_SERVER_KEY && isUnerrRouterEntry(entry)) {
      isUnerrAlreadyRouter = true;
    }
    discovered.push({
      name,
      entry,
      toolCount: null,
    });
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    configPath,
    relativeConfigPath: agent.projectConfigPath,
    servers: discovered,
    isUnerrAlreadyRouter,
  };
}

/**
 * Inspect all project-scoped IDE MCP configs in the given repo directory.
 * Returns one `IdeConfigResult` per IDE that has a non-empty MCP config.
 */
export function inspectIdeMcpConfigs(cwd: string): readonly IdeConfigResult[] {
  const results: IdeConfigResult[] = [];
  for (const agent of AGENT_REGISTRY) {
    const result = inspectOneAgent(cwd, agent);
    if (result) results.push(result);
  }
  return results;
}

/**
 * Get the list of non-unerr server names across all IDE configs.
 * Used to build the activation plan.
 */
export function getNonUnerrServers(
  configs: readonly IdeConfigResult[],
): ReadonlyMap<string, { agentIds: string[]; entry: McpServerEntry }> {
  const map = new Map<
    string,
    { agentIds: string[]; entry: McpServerEntry }
  >();
  for (const config of configs) {
    for (const server of config.servers) {
      if (server.name === UNERR_SERVER_KEY) continue;
      const existing = map.get(server.name);
      if (existing) {
        existing.agentIds.push(config.agentId);
      } else {
        map.set(server.name, {
          agentIds: [config.agentId],
          entry: server.entry,
        });
      }
    }
  }
  return map;
}

// ── Cursor tool-cap detection ──────────────────────────────────────

/**
 * Known client tool caps. Cursor silently drops tools beyond its limit.
 * This cap is protocol-level — the MCP spec has no pagination for tools/list.
 */
const CLIENT_TOOL_CAPS: Readonly<Record<string, number>> = {
  cursor: 40,
};

export interface ToolCapAnalysis {
  readonly agentId: string;
  readonly agentName: string;
  readonly totalTools: number;
  readonly cap: number | null;
  readonly exceedsCap: boolean;
  readonly droppedCount: number;
  readonly droppedServers: readonly string[];
}

/**
 * Analyze tool counts per IDE config to detect cap violations.
 * For agents with known caps (e.g., Cursor = 40 tools), identifies
 * which servers' tools are being silently dropped.
 */
export function analyzeToolCaps(
  configs: readonly IdeConfigResult[],
): readonly ToolCapAnalysis[] {
  const results: ToolCapAnalysis[] = [];

  for (const config of configs) {
    const cap = CLIENT_TOOL_CAPS[config.agentId] ?? null;
    const totalTools = config.servers.reduce(
      (sum, s) => sum + (s.toolCount ?? estimateToolCount(s.name)),
      0,
    );

    if (cap === null) {
      results.push({
        agentId: config.agentId,
        agentName: config.agentName,
        totalTools,
        cap: null,
        exceedsCap: false,
        droppedCount: 0,
        droppedServers: [],
      });
      continue;
    }

    const exceedsCap = totalTools > cap;
    const droppedCount = exceedsCap ? totalTools - cap : 0;

    const droppedServers: string[] = [];
    if (exceedsCap) {
      let running = 0;
      for (const server of config.servers) {
        const count = server.toolCount ?? estimateToolCount(server.name);
        running += count;
        if (running > cap) {
          droppedServers.push(server.name);
        }
      }
    }

    results.push({
      agentId: config.agentId,
      agentName: config.agentName,
      totalTools,
      cap,
      exceedsCap,
      droppedCount,
      droppedServers,
    });
  }

  return results;
}

/**
 * Heuristic tool count estimate for servers we haven't connected to.
 * Based on common MCP server registries.
 */
function estimateToolCount(serverName: string): number {
  const KNOWN_ESTIMATES: Record<string, number> = {
    github: 18,
    postgres: 12,
    slack: 8,
    linear: 15,
    sentry: 10,
    supabase: 20,
    stripe: 14,
    firebase: 12,
    redis: 6,
    mongodb: 8,
    docker: 10,
    kubernetes: 15,
    vercel: 8,
    figma: 6,
    jira: 12,
    notion: 10,
    airtable: 8,
    datadog: 12,
    cloudflare: 10,
    aws: 20,
    gcp: 18,
  };

  const lower = serverName.toLowerCase();
  for (const [key, count] of Object.entries(KNOWN_ESTIMATES)) {
    if (lower.includes(key)) return count;
  }
  return 8;
}
