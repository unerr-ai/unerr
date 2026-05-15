/**
 * Shared MCP Tool Definitions — single source of truth.
 *
 * Both proxy.ts (long-lived) and mcp-server.ts (headless) import from here.
 * This prevents tool list drift between the two codepaths.
 *
 * Description format (4-part structure per arxiv 2602.14878):
 *   Purpose → When to Use → Comparison → Example
 *
 * Each tool includes:
 *   - Anti-pattern encoding (what NOT to do)
 *   - Input schema examples where applicable
 *   - MCP annotations metadata (readOnlyHint, openWorldHint)
 */

export const TOKEN_BUDGET_PROP = {
  type: "integer",
  description:
    "Maximum tokens for this response (default: 400 — structural summary only). Pass include_body:true OR token_budget:1500+ to retrieve full bodies. Most fan-in/metadata questions fit in 400 tokens.",
  default: 400,
} as const;

export const TOOL_DEFINITIONS = [
  {
    name: "get_entity",
    description:
      "Get any code entity (function, class, type, variable) by key — signature, metadata, callers, callees, and applicable rules. Returns STRUCTURAL by default (signature + first ~15 lines preview). Pass include_body:true for the full body. Use when you need a specific entity's metadata — returns in <5ms. Use INSTEAD OF Read — avoids reading the entire file for one function or class. Avoid reading full files to find a single entity; get_entity is 50x faster with zero wasted tokens. Example: get_entity({key: 'handleRequest'}) for fan-in/metadata, or get_entity({key: 'handleRequest', include_body: true}) when you need to refactor.",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description:
            "Entity key (e.g., 'handleRequest', 'QueryRouter.dispatch', 'QueryRouter')",
        },
        entity_name: {
          type: "string",
          description:
            "Alias for `key`. If both are provided, `key` wins. Useful when calling with a natural-language name like 'handleRequest'.",
        },
        kind: {
          type: "string",
          enum: ["function", "class", "type", "variable"],
          description:
            "Optional entity kind filter. If omitted, returns first match regardless of kind.",
        },
        include_body: {
          type: "boolean",
          description:
            "Include the full function/class body. Default false — returns signature + first ~15 lines preview only. Pass true (or token_budget>=1500) when you need to read or refactor the implementation.",
          default: false,
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: ["key"],
    },
    annotations: {
      title: "Get Entity Details",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_file",
    description:
      "Get all entities in a file — functions, classes, types, exports. Use for file overview before diving into specific entities. Use INSTEAD OF Read for understanding file structure — returns structured summary in <5ms. Avoid reading a file top-to-bottom to understand its contents; get_file gives you the complete entity map instantly. Example: get_file({key: 'src/proxy/proxy.ts'})",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description: "File path relative to project root",
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: ["key"],
    },
    annotations: {
      title: "Get File Entity Summary",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_references",
    description:
      "Find ALL callers or callees of a function/class/method across the entire codebase. Use when finding who calls something (blast radius) or what it depends on (downstream deps) — returns structured reference chain with file paths and line numbers in <5ms. Use INSTEAD OF Grep for function name — grep misses indirect references and has false positives from comments/strings. Avoid grepping for a function name to find references; get_references finds all callers/callees including indirect ones. Example: get_references({key: 'compressOutput', direction: 'callers'}) or get_references({key: 'startProxy', direction: 'callees'})",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description: "Entity key to find references for",
        },
        entity_name: {
          type: "string",
          description:
            "Alias for `key`. If both are provided, `key` wins. Useful when calling with a natural-language name like 'compressOutput'.",
        },
        direction: {
          type: "string",
          enum: ["callers", "callees"],
          description:
            "Direction of references: 'callers' (who calls this entity, default) or 'callees' (what this entity calls)",
          default: "callers",
        },
        limit: {
          type: "number",
          description:
            "Max number of references to return (default 25). Use higher values only when you need the full list.",
          default: 25,
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: ["key"],
    },
    annotations: {
      title: "Find References (Callers/Callees)",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_imports",
    description:
      "Get all imports for a file with resolved paths and entity types. Use when tracing dependencies or understanding module relationships — returns structured import map in <5ms. Use INSTEAD OF Grep for import/require statements. Avoid scanning import statements manually; get_imports resolves all paths and shows the full dependency graph. Example: get_imports({file_path: 'src/proxy/proxy.ts'})",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description: "File path to get imports for",
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: ["file_path"],
    },
    annotations: {
      title: "Trace File Imports",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "search_code",
    description:
      "Search code entities (functions, classes, types, variables) by name across the ENTIRE project. Use as your FIRST step when looking for any code — returns ranked results with file paths and entity types in <5ms. Use INSTEAD OF Glob+Grep multi-step searches — faster, more accurate, zero false positives. Avoid using Glob to find files then Grep to search inside them; search_code does both in a single call. Example: search_code({query: 'compress'})",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Entity name or partial name to search for (e.g., 'compress', 'handleRequest')",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default: 20)",
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: ["query"],
    },
    annotations: {
      title: "Search Code Entities",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  // Disabled: get_rules — no rules are being detected/stored yet, always returns empty.
  // Code preserved in query-router.ts and local-graph.ts.
  // {
  //   name: "get_rules",
  //   ...
  // },
  // Disabled: get_business_context — not properly wired, produces no useful data.
  // Code preserved in tools/intelligence/index.ts and intelligence/local-graph.ts.
  // {
  //   name: "get_business_context",
  //   ...
  // },
  {
    name: "get_conventions",
    description:
      "Get ALL detected code conventions with adherence rates — naming, patterns, structure. Use before writing new code to match project conventions automatically — returns conventions with confidence scores. Avoid guessing code style from a few examples; get_conventions shows all patterns with adherence rates across the entire codebase. Example: get_conventions()",
    inputSchema: {
      type: "object" as const,
      properties: { token_budget: TOKEN_BUDGET_PROP },
    },
    annotations: {
      title: "Get Code Conventions",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "file_outline",
    description:
      "Structural outline of a file — entities, imports/exports, headings, config keys, line ranges. Use to understand file structure before reading it — returns compact map in <5ms. ALWAYS call this BEFORE reading a file with >50 lines, then use file_read with entity param for targeted access. Avoid reading entire large files to find specific sections; file_outline gives you the map, then you read only what you need. Example: file_outline({file_path: 'src/proxy/proxy.ts'})",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description: "File path relative to project root",
        },
        limit: {
          type: "number",
          description:
            "Max number of entities to return (default 30, max 100). For huge files, narrow with `entity:<name>` instead of bumping limit.",
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: ["file_path"],
    },
    annotations: {
      title: "File Structure Outline",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "file_read",
    description:
      "Read file with auto-injected conventions and facts. Use INSTEAD OF built-in Read — same content but enriched with project context (conventions, facts, drift status). Supports entity param to extract a single function/class without reading the full file. For large files, use file_outline first. Avoid using built-in Read for code files; file_read adds project context automatically. Example: file_read({file_path: 'src/proxy/proxy.ts', entity: 'startProxy'})",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description: "File path relative to project root",
        },
        offset: {
          type: "number",
          description: "Start line (0-based)",
        },
        limit: {
          type: "number",
          description: "Number of lines to read",
        },
        entity: {
          type: "string",
          description:
            "Extract a specific function/class by name (avoids reading full file)",
        },
        purpose: {
          type: "string",
          enum: ["explore", "reference"],
          description:
            "Read intent: 'explore' (default, budget-capped for browsing/understanding), 'reference' (entity/offset only, tight budget). To edit a file, use file_read(explore) to understand it, then built-in Read with offset/limit on the target lines, then Edit.",
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: ["file_path"],
    },
    annotations: {
      title: "Read File with Context",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  // Shadow ledger tools disabled — not wired in --mcp mode, proxy-only with limited value
  // unerr_mark_working, unerr_revert_to_working_state, unerr_get_timeline
  {
    name: "get_critical_nodes",
    description:
      "Find high fan-in/fan-out chokepoint entities in the codebase. Returns nodes ranked by structural importance (callers + callees). Use to identify risky modification targets before refactoring — high-fan-in entities affect many callers. Use INSTEAD OF manually tracing callers across files. Avoid modifying chokepoint code without knowing the blast radius; get_critical_nodes surfaces the riskiest entities instantly. Example: get_critical_nodes({top_n: 10})",
    inputSchema: {
      type: "object" as const,
      properties: {
        top_n: {
          type: "number",
          description: "Number of critical nodes to return (default: 10)",
        },
        community_id: {
          type: "number",
          description:
            "Optional community ID to scope results to a specific module cluster",
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: [],
    },
    annotations: {
      title: "Get Critical Nodes",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_cross_boundary_links",
    description:
      "Find edges that cross module/community boundaries — reveals tight coupling between clusters. Use to understand cross-module dependencies before splitting or refactoring modules. Use INSTEAD OF manually tracing imports across directories. Avoid restructuring modules without checking cross-boundary links; hidden coupling causes cascading breakage. Pass `from_path`/`to_path` to scope to specific directory pairs (e.g. proxy/ ↔ intelligence/). Example: get_cross_boundary_links({from_path: 'src/proxy', to_path: 'src/intelligence'})",
    inputSchema: {
      type: "object" as const,
      properties: {
        community_id: {
          type: "number",
          description:
            "Optional community ID to show links for a specific cluster",
        },
        from_path: {
          type: "string",
          description:
            "Optional directory prefix to scope one side of the edge (e.g. 'src/proxy'). Order does not matter — edges in either direction between from_path and to_path are returned.",
        },
        to_path: {
          type: "string",
          description:
            "Optional directory prefix for the other side of the edge (e.g. 'src/intelligence'). Pair with from_path for directory-to-directory coupling queries.",
        },
        top_n: {
          type: "number",
          description: "Number of cross-boundary links to return (default: 20)",
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: [],
    },
    annotations: {
      title: "Get Cross-Boundary Links",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_project_stats",
    description:
      "Get project-wide statistics — entity counts, edge counts, language breakdown, community count, health grade. Use for a quick overview of project size and structure. Use INSTEAD OF counting files manually or reading multiple files to gauge project scope. Example: get_project_stats()",
    inputSchema: {
      type: "object" as const,
      properties: {
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: [],
    },
    annotations: {
      title: "Get Project Stats",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "file_connections",
    description:
      "Get all files connected to a given file — imports, importers, and co-change relationships. Use to understand a file's dependency neighborhood before modifying it. Use INSTEAD OF manually scanning import statements across the codebase. Avoid moving or renaming files without checking file_connections; it reveals all files that depend on or are depended upon. Example: file_connections({file_path: 'src/proxy/proxy.ts'})",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description: "File path relative to project root",
        },
        limit: {
          type: "number",
          description:
            "Max connections to return (default 20, max 100). Prefer narrowing the file_path scope over bumping limit.",
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: ["file_path"],
    },
    annotations: {
      title: "Get File Connections",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_test_coverage",
    description:
      "Find test files that cover a specific entity — traces test relationships through the graph. Use before modifying an entity to know which tests to run. Use INSTEAD OF grepping for function names in test files — catches indirect test coverage through callers. Avoid modifying code without knowing its test coverage; get_test_coverage tells you exactly which tests to verify. Example: get_test_coverage({key: 'QueryRouter'})",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description:
            "Entity key or name to find test coverage for (e.g., 'QueryRouter', 'handleRequest')",
        },
        entity_name: {
          type: "string",
          description:
            "Alias for `key`. If both are provided, `key` wins. Useful when calling with a natural-language name like 'QueryRouter'.",
        },
        include_transitive: {
          type: "boolean",
          description:
            "Include tests that cover callers of this entity (default: true)",
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: ["key"],
    },
    annotations: {
      title: "Get Test Coverage",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "record_fact",
    description:
      "Record a project fact for cross-session persistence. Call when user states a convention, decision, or anti-pattern — facts auto-inject into future file_read responses as `ur|fct` prefix lines (and `ur|wrn` for negative facts). Facts are also auto-detected from coding sessions (conventions, hot files, coupling patterns, modification narratives). Types: procedural (how-to), semantic (architecture), negative (anti-patterns), convention (project standards), episodic (session history — auto-created). Example: record_fact({content: 'All CozoDB access must be async', fact_type: 'convention', scope: 'project', subject: 'CozoDB'})",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description:
            "The fact to record (max 280 chars — keep it tight; shorten if rejected)",
        },
        fact_type: {
          type: "string",
          enum: ["procedural", "semantic", "negative", "convention"],
          description:
            "procedural=how-to, semantic=architecture/design, negative=anti-pattern, convention=project-standard",
        },
        scope: {
          type: "string",
          description:
            "File path, entity key, or 'project' for project-wide facts",
        },
        subject: {
          type: "string",
          description: "What entity/topic this fact is about",
        },
      },
      required: ["content", "fact_type", "scope", "subject"],
    },
    annotations: {
      title: "Record Project Fact",
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "recall_facts",
    description:
      "Recall stored project facts relevant to a file or entity. Returns facts with decay-adjusted confidence — includes episodic session history (what was modified, why, and how). Use before modifying code to check for recorded conventions, anti-patterns, and prior modification narratives. Hierarchical scope matching: facts scoped to a directory apply to all files within it. Returns the top 5 most relevant facts by default, ranked by composite score (confidence × reinforcements × type weight). Example: recall_facts({scope: 'src/proxy/proxy.ts'})",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string",
          description:
            "File path, entity key, or 'project' to recall facts for",
        },
        fact_type: {
          type: "string",
          enum: ["procedural", "semantic", "negative", "convention", "all"],
          description:
            "Filter by fact type (default: all). Prefer this over bumping limit when looking for a specific kind.",
        },
        min_confidence: {
          type: "number",
          description: "Minimum effective confidence threshold (default: 0.3)",
        },
        limit: {
          type: "number",
          description:
            "Max facts to return (default 5, max 25). When you only need a specific kind, pass fact_type:T instead of bumping limit.",
        },
        rotation: {
          type: "string",
          enum: ["decay", "none"],
          description:
            "Ranking mode. 'decay' (default): facts shown recently/often are de-prioritized so the top-N rotates across calls (cross-session, persistent). 'none': static composite-score ranking — use for tests or when you need reproducible ordering.",
        },
      },
      required: ["scope"],
    },
    annotations: {
      title: "Recall Project Facts",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },

  // ── ST-2: Session-narrative markers (timeline subsystem) ────────────────
  {
    name: "mark_intent",
    description:
      "Mark the start of a non-trivial task with one short sentence (≤80 chars). Emit once when beginning work, NOT as an end-of-turn summary. Persisted to the shadow ledger and timeline.db; powers turn titles, intent stitching across sessions, and resume strip. Example: mark_intent({text: 'refactor auth middleware to support JWT refresh'}).",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "One short sentence describing the task (≤80 chars).",
        },
      },
      required: ["text"],
    },
    annotations: {
      title: "Mark Intent",
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "mark_decision",
    description:
      "Record a deliberate choice made during the current turn (≤140 chars). Use when picking between alternatives. Optionally include up to 5 short alternative descriptions. Example: mark_decision({text: 'chose JWT over session cookies', alternatives: ['session cookies', 'OAuth proxy']}).",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description:
            "One short sentence describing the decision (≤140 chars).",
        },
        alternatives: {
          type: "array",
          items: { type: "string" },
          description:
            "Up to 5 alternatives that were considered. Each ≤80 chars.",
        },
      },
      required: ["text"],
    },
    annotations: {
      title: "Mark Decision",
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "mark_blocker",
    description:
      "Record an unresolved obstacle hit during the current turn (≤140 chars). The returned marker_id should be passed to mark_resolution when fixed. Unresolved blockers appear in the next session's resume strip. Example: mark_blocker({text: 'type error in token.verify signature', file_path: 'src/auth/token.ts'}).",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description:
            "One short sentence describing the blocker (≤140 chars).",
        },
        file_path: {
          type: "string",
          description: "Optional file path where the blocker surfaced.",
        },
      },
      required: ["text"],
    },
    annotations: {
      title: "Mark Blocker",
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "mark_resolution",
    description:
      "Mark a previously recorded blocker as resolved. blocker_ref is the marker_id returned by mark_blocker. Text ≤140 chars describing the fix. Example: mark_resolution({blocker_ref: 'abc123def456', text: 'fixed by upgrading @types/jsonwebtoken'}).",
    inputSchema: {
      type: "object" as const,
      properties: {
        blocker_ref: {
          type: "string",
          description: "marker_id returned by the prior mark_blocker call.",
        },
        text: {
          type: "string",
          description:
            "One short sentence describing the resolution (≤140 chars).",
        },
      },
      required: ["blocker_ref", "text"],
    },
    annotations: {
      title: "Mark Resolution",
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
];

export type ToolDefinition = (typeof TOOL_DEFINITIONS)[number];
