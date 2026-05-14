/**
 * Intelligence Tools — wrappers around the QueryRouter's 15 MCP tools.
 *
 * These adapt the existing graph-backed tools so they can be used by the QueryEngine
 * (the LLM calls them during interactive sessions). The QueryRouter handles all the
 * local routing, drift injection, and rule evaluation internally.
 *
 * This is the key differentiator: no other coding assistant has pre-computed
 * code intelligence (conventions, blast radius, business context, health grades)
 * available as tools.
 */

import type { QueryRouter } from "../../intelligence/query-router.js";
import type { Tool, ToolContext, ToolOutput } from "../types.js";

// Leapfrog Sprint C: token_budget property shared across all local tools
const TOKEN_BUDGET_PROP = {
  type: "integer" as const,
  description:
    "Maximum tokens for this response (default: 400 — structural summary only). Pass include_body:true OR token_budget:1500+ to retrieve full bodies. Most fan-in/metadata questions fit in 400 tokens.",
  default: 400,
};

/** Tool definition metadata for each intelligence tool. */
const TOOL_DEFS: Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> = [
  {
    name: "get_entity",
    description:
      "Get any code entity (function, class, type, variable) by key — signature, metadata, callers, callees, risk level. Returns STRUCTURAL by default; pass include_body:true for full body.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Entity key (e.g., 'handleRequest', 'QueryRouter')",
        },
        kind: {
          type: "string",
          enum: ["function", "class", "type", "variable"],
          description: "Optional entity kind filter",
        },
        include_body: {
          type: "boolean",
          description:
            "Include full body. Default false — signature + first ~15 lines preview only.",
          default: false,
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: ["key"],
    },
  },
  {
    name: "get_file",
    description: "Get all entities defined in a file",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "File path relative to project root",
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: ["file_path"],
    },
  },
  {
    name: "get_references",
    description:
      "Find all callers or callees of a given entity. Direction 'callers' = who calls this (blast radius). Direction 'callees' = what this calls (dependencies).",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Entity key to find references for",
        },
        direction: {
          type: "string",
          enum: ["callers", "callees"],
          description: "Direction: 'callers' (default) or 'callees'",
        },
        limit: {
          type: "number",
          description: "Max references to return (default 25)",
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: ["key"],
    },
  },
  {
    name: "get_imports",
    description: "Get all imports for a file",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "File path" },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: ["file_path"],
    },
  },
  {
    name: "search_code",
    description:
      "Full-text search across all indexed code entities (functions, classes, variables). Returns matching entities with file paths and signatures.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results. Default: 20" },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: ["query"],
    },
  },
  // Disabled: get_rules — no rules are being detected/stored yet, always returns empty.
  // {
  //   name: "get_rules",
  //   inputSchema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" }, entity_key: { type: "string" }, token_budget: TOKEN_BUDGET_PROP }, },
  // },
  // Disabled: get_business_context — not properly wired, produces no useful data.
  // {
  //   name: "get_business_context",
  //   description: "Get entity business context — purpose, taxonomy, feature area, justification for why this code exists",
  //   inputSchema: { type: "object", properties: { key: { type: "string" }, token_budget: TOKEN_BUDGET_PROP }, required: ["key"] },
  // },
  {
    name: "get_conventions",
    description:
      "Get detected code conventions and patterns with adherence rates. Shows what patterns the team follows.",
    inputSchema: {
      type: "object",
      properties: {
        token_budget: TOKEN_BUDGET_PROP,
      },
    },
  },
  {
    name: "get_cross_boundary_links",
    description:
      "Find surprising cross-community connections — edges between entities in different structural communities, scored by inverse inter-community density. High surprise = unexpected architectural coupling.",
    inputSchema: {
      type: "object",
      properties: {
        community_id: {
          type: "number",
          description:
            "Optional: filter to connections involving this community ID",
        },
        top_n: {
          type: "number",
          description: "Max results. Default: 20",
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
    },
  },
  {
    name: "get_critical_nodes",
    description:
      "Find critical nodes — highest-degree entities (fan_in + fan_out) that are structural bottlenecks. Excludes file/module-level entities. Shows community membership for each node.",
    inputSchema: {
      type: "object",
      properties: {
        top_n: {
          type: "number",
          description: "Max results. Default: 10",
        },
        community_id: {
          type: "number",
          description: "Optional: filter to entities in this community",
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
    },
  },
  {
    name: "semantic_search",
    description:
      "Vector-based semantic search across the codebase. Finds conceptually similar code even with different naming.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        limit: { type: "number", description: "Max results. Default: 10" },
      },
      required: ["query"],
    },
  },
  {
    name: "find_similar",
    description:
      "Find entities similar to a given entity (by embedding distance)",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Entity key to find similar entities for",
        },
        limit: { type: "number", description: "Max results. Default: 10" },
      },
      required: ["key"],
    },
  },
  {
    name: "get_project_stats",
    description:
      "Get project-wide statistics: entity counts, risk distribution, convention adherence, health grade",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "file_connections",
    description:
      "Get connected files and contained entities for a file. Shows import relationships, co-change correlations, and file-level structure.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "File path relative to project root",
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: ["file_path"],
    },
  },
  {
    name: "get_test_coverage",
    description:
      "Find test functions that cover a source entity. Returns direct and transitive test coverage via 'tests' edges in the graph.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Source entity key to find test coverage for",
        },
        include_transitive: {
          type: "boolean",
          description:
            "Include tests that cover via intermediate calls (default: true)",
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: ["key"],
    },
  },
];

/**
 * Create intelligence Tool instances backed by a QueryRouter.
 * Each tool delegates to router.execute() which handles local routing,
 * drift injection, risk metadata, and rule evaluation.
 */
export function createIntelligenceTools(router: QueryRouter): Tool[] {
  return TOOL_DEFS.map((def) => ({
    ...def,
    isReadOnly: true,
    requiresPermission: false,
    async execute(
      args: Record<string, unknown>,
      _ctx: ToolContext,
    ): Promise<ToolOutput> {
      try {
        const result = await router.execute(def.name, args);
        return {
          content:
            typeof result.content === "string"
              ? result.content
              : (result.content as Record<string, unknown>),
          metadata: {
            source: result._meta.source,
            latency_ms: result._meta.latency_ms,
            entity_risk: result._meta.entity_risk,
            drift: result._meta.drift,
          },
        };
      } catch (err) {
        return {
          content: `Intelligence tool error (${def.name}): ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  }));
}
