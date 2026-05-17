/**
 * Namespace isolation & collision rewriting for proxied MCP servers.
 *
 * The aliasing system ensures every tool across N downstream MCP servers
 * has a globally unique name in the agent's context:
 *
 *   github::search  →  gh_search
 *   postgres::query →  pg_query
 *   slack::search   →  slk_search   (no collision with gh_search)
 *
 * Three operations:
 *   1. Outbound rewrite (tools/list response): `search` → `gh_search`
 *   2. Inbound resolve (tools/call request):   `gh_search` → serverId:"github", toolName:"search"
 *   3. Description tag: prepend `[github] ` to description for clarity
 *
 * Aliases are assigned at activation time, recorded in config.json,
 * and never auto-rewritten across sessions (agent muscle-memory preserved).
 */

import type { CachedToolDefinition, ServerSchemaEntry } from "./client/schema-cache.js";

const KNOWN_ALIASES: Readonly<Record<string, string>> = {
  github: "gh",
  postgres: "pg",
  "postgres-dev": "pg",
  "postgres-mcp": "pg",
  postgresql: "pg",
  slack: "slk",
  "slack-mcp": "slk",
  linear: "lin",
  "linear-mcp": "lin",
  sentry: "snt",
  "sentry-mcp": "snt",
  datadog: "dd",
  "datadog-mcp": "dd",
  jira: "jra",
  "jira-mcp": "jra",
  notion: "ntn",
  "notion-mcp": "ntn",
  confluence: "cnf",
  figma: "fig",
  "figma-mcp": "fig",
  supabase: "sup",
  firebase: "fb",
  stripe: "str",
  vercel: "vrc",
  atlassian: "atl",
  "atlassian-mcp": "atl",
  kubernetes: "k8s",
  "k8s-mcp": "k8s",
  docker: "dkr",
  "docker-mcp": "dkr",
  redis: "rds",
  "redis-mcp": "rds",
  mongodb: "mdb",
  "mongodb-mcp": "mdb",
  mysql: "sql",
  sqlite: "sql",
  elasticsearch: "els",
  grafana: "gfn",
  pagerduty: "pgd",
  twilio: "twl",
  sendgrid: "sgd",
  cloudflare: "cf",
  aws: "aws",
  gcp: "gcp",
  azure: "az",
};

export interface AliasedTool {
  readonly prefixedName: string;
  readonly originalName: string;
  readonly serverId: string;
  readonly description: string;
  readonly inputSchema?: unknown;
}

export interface ResolvedTool {
  readonly serverId: string;
  readonly toolName: string;
}

export interface AliasCollision {
  readonly prefixedName: string;
  readonly servers: readonly string[];
}

/**
 * Compute the default alias for a server name.
 * Uses the KNOWN_ALIASES lookup table for well-known servers,
 * falls back to first 4 chars of lowercased name.
 */
export function defaultAlias(serverName: string): string {
  return KNOWN_ALIASES[serverName.toLowerCase()] ?? serverName.toLowerCase().slice(0, 4);
}

/**
 * AliasRegistry holds the bidirectional mapping between prefixed tool names
 * and their (serverId, originalToolName) pairs. It is constructed from
 * the router config (persisted aliases) and the live schema cache.
 *
 * Immutability: Once built, the registry does not auto-mutate. A new
 * registry is created on schema cache invalidation or server restart.
 */
export class AliasRegistry {
  private readonly serverAliases: ReadonlyMap<string, string>;
  private readonly aliasToServer: ReadonlyMap<string, string>;
  private readonly prefixedToOriginal = new Map<string, ResolvedTool>();
  private readonly originalToPrefixed = new Map<string, string>();
  private readonly allTools: AliasedTool[] = [];

  constructor(serverAliases: ReadonlyMap<string, string>) {
    this.serverAliases = serverAliases;

    const reverse = new Map<string, string>();
    for (const [serverId, alias] of serverAliases) {
      reverse.set(alias, serverId);
    }
    this.aliasToServer = reverse;
  }

  /**
   * Register all tools from a server's schema.
   * Call this for each connected server after fetching tools/list.
   */
  registerServer(serverId: string, tools: readonly CachedToolDefinition[]): void {
    const alias = this.serverAliases.get(serverId);
    if (!alias) return;

    for (const tool of tools) {
      const prefixed = `${alias}_${tool.name}`;
      const description = `[${serverId}] ${tool.description ?? ""}`.trim();

      this.prefixedToOriginal.set(prefixed, {
        serverId,
        toolName: tool.name,
      });

      const compositeKey = `${serverId}::${tool.name}`;
      this.originalToPrefixed.set(compositeKey, prefixed);

      this.allTools.push({
        prefixedName: prefixed,
        originalName: tool.name,
        serverId,
        description,
        inputSchema: tool.inputSchema,
      });
    }
  }

  /**
   * Populate the registry from a schema cache snapshot.
   */
  registerFromSchemas(schemas: ReadonlyMap<string, ServerSchemaEntry>): void {
    for (const [serverId, entry] of schemas) {
      this.registerServer(serverId, entry.tools);
    }
  }

  // ── Outbound: tools/list response rewriting ──────────────────────

  /**
   * Rewrite a server's tool name to its prefixed form.
   * `search` on server `github` (alias `gh`) → `gh_search`
   */
  rewriteName(serverId: string, toolName: string): string | undefined {
    return this.originalToPrefixed.get(`${serverId}::${toolName}`);
  }

  /**
   * Rewrite a tool's description with server tag.
   * `"Search code"` → `"[github] Search code"`
   */
  rewriteDescription(serverId: string, description?: string): string {
    return `[${serverId}] ${description ?? ""}`.trim();
  }

  /**
   * Get all aliased tools for the outbound `tools/list` response.
   */
  getAllTools(): readonly AliasedTool[] {
    return this.allTools;
  }

  // ── Inbound: tools/call request resolution ───────────────────────

  /**
   * Resolve a prefixed tool name back to its server + original name.
   * `gh_search` → { serverId: "github", toolName: "search" }
   *
   * Returns undefined if the name is not a known aliased tool
   * (it may be a unerr-native tool or unknown).
   */
  resolve(prefixedName: string): ResolvedTool | undefined {
    return this.prefixedToOriginal.get(prefixedName);
  }

  /**
   * Check if a tool name is a known aliased tool.
   */
  isAliased(toolName: string): boolean {
    return this.prefixedToOriginal.has(toolName);
  }

  /**
   * Get the alias assigned to a server.
   */
  getAlias(serverId: string): string | undefined {
    return this.serverAliases.get(serverId);
  }

  /**
   * Get the server ID for an alias.
   */
  getServerForAlias(alias: string): string | undefined {
    return this.aliasToServer.get(alias);
  }

  /**
   * Get count of all registered aliased tools.
   */
  get toolCount(): number {
    return this.allTools.length;
  }

  /**
   * Get all server aliases.
   */
  get aliases(): ReadonlyMap<string, string> {
    return this.serverAliases;
  }
}

// ── Collision detection ──────────────────────────────────────────

/**
 * Detect alias collisions before activation.
 *
 * Two types of collisions:
 *   1. Alias-level: two servers have the same alias (e.g., user sets both to "pg")
 *   2. Tool-level: after prefixing, two tools have the same name
 *      (only possible if aliases collide — different aliases guarantee unique names)
 *
 * Returns an array of collisions. Empty array = safe to activate.
 */
export function detectAliasCollisions(
  servers: readonly { readonly name: string; readonly alias: string }[],
): readonly AliasCollision[] {
  const aliasToServers = new Map<string, string[]>();

  for (const server of servers) {
    const existing = aliasToServers.get(server.alias);
    if (existing) {
      existing.push(server.name);
    } else {
      aliasToServers.set(server.alias, [server.name]);
    }
  }

  const collisions: AliasCollision[] = [];
  for (const [alias, serverNames] of aliasToServers) {
    if (serverNames.length > 1) {
      collisions.push({
        prefixedName: `${alias}_*`,
        servers: serverNames,
      });
    }
  }

  return collisions;
}

/**
 * Detect tool-level collisions given actual tool schemas.
 * This catches the edge case where two different servers produce
 * the same prefixed tool name (only when aliases collide).
 */
export function detectToolCollisions(
  serverTools: ReadonlyMap<string, readonly CachedToolDefinition[]>,
  serverAliases: ReadonlyMap<string, string>,
): readonly AliasCollision[] {
  const nameToServers = new Map<string, string[]>();

  for (const [serverId, tools] of serverTools) {
    const alias = serverAliases.get(serverId);
    if (!alias) continue;

    for (const tool of tools) {
      const prefixed = `${alias}_${tool.name}`;
      const existing = nameToServers.get(prefixed);
      if (existing) {
        if (!existing.includes(serverId)) {
          existing.push(serverId);
        }
      } else {
        nameToServers.set(prefixed, [serverId]);
      }
    }
  }

  const collisions: AliasCollision[] = [];
  for (const [name, servers] of nameToServers) {
    if (servers.length > 1) {
      collisions.push({ prefixedName: name, servers });
    }
  }

  return collisions;
}

/**
 * Create an AliasRegistry from a server alias map (typically from RouterConfig).
 */
export function createAliasRegistry(
  serverAliases: ReadonlyMap<string, string>,
): AliasRegistry {
  return new AliasRegistry(serverAliases);
}
