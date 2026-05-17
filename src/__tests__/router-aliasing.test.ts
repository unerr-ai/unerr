import { describe, it, expect } from "vitest";

import {
  defaultAlias,
  AliasRegistry,
  detectAliasCollisions,
  detectToolCollisions,
  createAliasRegistry,
  type AliasedTool,
  type ResolvedTool,
} from "../router/aliasing.js";
import type { CachedToolDefinition } from "../router/client/schema-cache.js";

// ── defaultAlias ─────────────────────────────────────────────────

describe("defaultAlias", () => {
  it("returns known aliases for well-known servers", () => {
    expect(defaultAlias("github")).toBe("gh");
    expect(defaultAlias("postgres")).toBe("pg");
    expect(defaultAlias("postgres-dev")).toBe("pg");
    expect(defaultAlias("slack")).toBe("slk");
    expect(defaultAlias("slack-mcp")).toBe("slk");
    expect(defaultAlias("linear")).toBe("lin");
    expect(defaultAlias("sentry")).toBe("snt");
    expect(defaultAlias("datadog")).toBe("dd");
    expect(defaultAlias("jira")).toBe("jra");
    expect(defaultAlias("notion")).toBe("ntn");
    expect(defaultAlias("figma")).toBe("fig");
    expect(defaultAlias("atlassian")).toBe("atl");
    expect(defaultAlias("kubernetes")).toBe("k8s");
    expect(defaultAlias("redis")).toBe("rds");
  });

  it("is case-insensitive", () => {
    expect(defaultAlias("GitHub")).toBe("gh");
    expect(defaultAlias("POSTGRES")).toBe("pg");
    expect(defaultAlias("Slack-MCP")).toBe("slk");
  });

  it("falls back to first 4 chars for unknown servers", () => {
    expect(defaultAlias("my-custom-server")).toBe("my-c");
    expect(defaultAlias("analytics")).toBe("anal");
    expect(defaultAlias("xyz")).toBe("xyz");
  });
});

// ── AliasRegistry ────────────────────────────────────────────────

describe("AliasRegistry", () => {
  function makeRegistry(): AliasRegistry {
    const aliases = new Map([
      ["github", "gh"],
      ["postgres", "pg"],
      ["slack", "slk"],
    ]);
    const registry = createAliasRegistry(aliases);

    registry.registerServer("github", [
      { name: "search", description: "Search GitHub repositories" },
      { name: "create_issue", description: "Create a GitHub issue" },
    ]);
    registry.registerServer("postgres", [
      { name: "query", description: "Run SQL query" },
      { name: "list_tables", description: "List database tables" },
    ]);
    registry.registerServer("slack", [
      { name: "search", description: "Search Slack messages" },
      { name: "send_message", description: "Send a Slack message" },
    ]);

    return registry;
  }

  // ── Outbound name rewriting ──────────────────────────────────

  it("rewrites tool names with alias prefix", () => {
    const registry = makeRegistry();
    expect(registry.rewriteName("github", "search")).toBe("gh_search");
    expect(registry.rewriteName("github", "create_issue")).toBe("gh_create_issue");
    expect(registry.rewriteName("postgres", "query")).toBe("pg_query");
    expect(registry.rewriteName("slack", "search")).toBe("slk_search");
  });

  it("returns undefined for unknown server/tool combos", () => {
    const registry = makeRegistry();
    expect(registry.rewriteName("unknown", "search")).toBeUndefined();
    expect(registry.rewriteName("github", "nonexistent")).toBeUndefined();
  });

  it("eliminates collisions — github::search and slack::search get different names", () => {
    const registry = makeRegistry();
    const ghSearch = registry.rewriteName("github", "search");
    const slkSearch = registry.rewriteName("slack", "search");
    expect(ghSearch).toBe("gh_search");
    expect(slkSearch).toBe("slk_search");
    expect(ghSearch).not.toBe(slkSearch);
  });

  // ── Inbound name resolution ──────────────────────────────────

  it("resolves prefixed names back to server + tool", () => {
    const registry = makeRegistry();
    expect(registry.resolve("gh_search")).toEqual({ serverId: "github", toolName: "search" });
    expect(registry.resolve("pg_query")).toEqual({ serverId: "postgres", toolName: "query" });
    expect(registry.resolve("slk_send_message")).toEqual({ serverId: "slack", toolName: "send_message" });
  });

  it("returns undefined for non-aliased tools", () => {
    const registry = makeRegistry();
    expect(registry.resolve("search")).toBeUndefined();
    expect(registry.resolve("file_read")).toBeUndefined();
    expect(registry.resolve("unknown_tool")).toBeUndefined();
  });

  // ── Roundtrip identity ───────────────────────────────────────

  it("outbound rewrite → inbound resolve = identity (roundtrip)", () => {
    const registry = makeRegistry();

    const testCases: [string, string][] = [
      ["github", "search"],
      ["github", "create_issue"],
      ["postgres", "query"],
      ["postgres", "list_tables"],
      ["slack", "search"],
      ["slack", "send_message"],
    ];

    for (const [serverId, toolName] of testCases) {
      const prefixed = registry.rewriteName(serverId, toolName);
      expect(prefixed).toBeDefined();

      const resolved = registry.resolve(prefixed!);
      expect(resolved).toBeDefined();
      expect(resolved!.serverId).toBe(serverId);
      expect(resolved!.toolName).toBe(toolName);
    }
  });

  // ── Description tagging ──────────────────────────────────────

  it("prepends server name to description", () => {
    const registry = makeRegistry();
    expect(registry.rewriteDescription("github", "Search repos")).toBe("[github] Search repos");
    expect(registry.rewriteDescription("postgres", "Run SQL")).toBe("[postgres] Run SQL");
  });

  it("handles empty/undefined descriptions", () => {
    const registry = makeRegistry();
    expect(registry.rewriteDescription("github", undefined)).toBe("[github]");
    expect(registry.rewriteDescription("github", "")).toBe("[github]");
  });

  // ── getAllTools ───────────────────────────────────────────────

  it("returns all aliased tools with correct structure", () => {
    const registry = makeRegistry();
    const tools = registry.getAllTools();
    expect(tools).toHaveLength(6);

    const ghSearch = tools.find((t) => t.prefixedName === "gh_search");
    expect(ghSearch).toBeDefined();
    expect(ghSearch!.originalName).toBe("search");
    expect(ghSearch!.serverId).toBe("github");
    expect(ghSearch!.description).toBe("[github] Search GitHub repositories");
  });

  it("toolCount matches total registered tools", () => {
    const registry = makeRegistry();
    expect(registry.toolCount).toBe(6);
  });

  // ── Alias lookups ────────────────────────────────────────────

  it("getAlias returns correct alias for server", () => {
    const registry = makeRegistry();
    expect(registry.getAlias("github")).toBe("gh");
    expect(registry.getAlias("postgres")).toBe("pg");
    expect(registry.getAlias("unknown")).toBeUndefined();
  });

  it("getServerForAlias returns correct server for alias", () => {
    const registry = makeRegistry();
    expect(registry.getServerForAlias("gh")).toBe("github");
    expect(registry.getServerForAlias("pg")).toBe("postgres");
    expect(registry.getServerForAlias("xx")).toBeUndefined();
  });

  it("isAliased distinguishes prefixed from unprefixed names", () => {
    const registry = makeRegistry();
    expect(registry.isAliased("gh_search")).toBe(true);
    expect(registry.isAliased("search")).toBe(false);
    expect(registry.isAliased("file_read")).toBe(false);
  });

  // ── registerFromSchemas ──────────────────────────────────────

  it("populates from schema cache snapshot", () => {
    const aliases = new Map([["github", "gh"], ["postgres", "pg"]]);
    const registry = createAliasRegistry(aliases);

    const schemas = new Map([
      ["github", {
        serverId: "github",
        tools: [{ name: "search", description: "Search" }],
        fetchedAt: Date.now(),
      }],
      ["postgres", {
        serverId: "postgres",
        tools: [{ name: "query", description: "Query" }],
        fetchedAt: Date.now(),
      }],
    ]);

    registry.registerFromSchemas(schemas);
    expect(registry.toolCount).toBe(2);
    expect(registry.resolve("gh_search")).toEqual({ serverId: "github", toolName: "search" });
    expect(registry.resolve("pg_query")).toEqual({ serverId: "postgres", toolName: "query" });
  });
});

// ── Collision detection ──────────────────────────────────────────

describe("detectAliasCollisions", () => {
  it("returns empty array when all aliases are unique", () => {
    const servers = [
      { name: "github", alias: "gh" },
      { name: "postgres", alias: "pg" },
      { name: "slack", alias: "slk" },
    ];
    expect(detectAliasCollisions(servers)).toHaveLength(0);
  });

  it("detects collision when two servers have same alias", () => {
    const servers = [
      { name: "postgres-dev", alias: "pg" },
      { name: "postgres-prod", alias: "pg" },
      { name: "github", alias: "gh" },
    ];
    const collisions = detectAliasCollisions(servers);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.prefixedName).toBe("pg_*");
    expect(collisions[0]!.servers).toContain("postgres-dev");
    expect(collisions[0]!.servers).toContain("postgres-prod");
  });

  it("detects multiple collisions", () => {
    const servers = [
      { name: "server-a", alias: "x" },
      { name: "server-b", alias: "x" },
      { name: "server-c", alias: "y" },
      { name: "server-d", alias: "y" },
    ];
    const collisions = detectAliasCollisions(servers);
    expect(collisions).toHaveLength(2);
  });

  it("returns empty for single server", () => {
    expect(detectAliasCollisions([{ name: "github", alias: "gh" }])).toHaveLength(0);
  });

  it("returns empty for empty array", () => {
    expect(detectAliasCollisions([])).toHaveLength(0);
  });
});

describe("detectToolCollisions", () => {
  it("detects tool-level collision when aliases conflict", () => {
    const serverTools = new Map<string, CachedToolDefinition[]>([
      ["postgres-dev", [{ name: "query" }]],
      ["postgres-prod", [{ name: "query" }]],
    ]);
    const aliases = new Map([
      ["postgres-dev", "pg"],
      ["postgres-prod", "pg"],
    ]);

    const collisions = detectToolCollisions(serverTools, aliases);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.prefixedName).toBe("pg_query");
    expect(collisions[0]!.servers).toContain("postgres-dev");
    expect(collisions[0]!.servers).toContain("postgres-prod");
  });

  it("returns no collisions when aliases are unique", () => {
    const serverTools = new Map<string, CachedToolDefinition[]>([
      ["github", [{ name: "search" }]],
      ["slack", [{ name: "search" }]],
    ]);
    const aliases = new Map([
      ["github", "gh"],
      ["slack", "slk"],
    ]);

    const collisions = detectToolCollisions(serverTools, aliases);
    expect(collisions).toHaveLength(0);
  });

  it("handles servers with no tools", () => {
    const serverTools = new Map<string, CachedToolDefinition[]>([
      ["github", []],
      ["slack", [{ name: "search" }]],
    ]);
    const aliases = new Map([["github", "gh"], ["slack", "slk"]]);

    const collisions = detectToolCollisions(serverTools, aliases);
    expect(collisions).toHaveLength(0);
  });
});
