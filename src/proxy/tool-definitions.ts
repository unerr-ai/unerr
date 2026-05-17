/**
 * MCP tool definitions — the outbound surface unerr advertises in `tools/list`.
 *
 * This module owns *only* the JSON Schema and MCP annotations for each tool.
 * Description strings are owned by `tool-descriptions.ts` (the tier-aware
 * provider) and composed in here at module-load time. This separation:
 *
 *   - keeps token-budget enforcement in one place,
 *   - lets the dispatcher swap description states (active / locked / unlocked)
 *     without rebuilding the schema table,
 *   - makes the tier assignment for every tool grep-able from one file.
 *
 * Consumed by `proxy.ts` for MCP `tools/list` responses. Single source of
 * truth — there is no parallel emission path.
 */

import { getDescription, listToolNames } from "./tool-descriptions.js";

/**
 * Shared input-schema property for the `token_budget` knob. Every read-side
 * tool exposes it identically.
 */
export const TOKEN_BUDGET_PROP = {
	type: "integer",
	description:
		"Maximum tokens for this response (default: 400 — structural summary only). Pass include_body:true OR token_budget:1500+ to retrieve full bodies.",
	default: 400,
} as const;

interface ToolSchema {
	readonly inputSchema: {
		readonly type: "object";
		readonly properties: Record<string, unknown>;
		readonly required?: string[];
	};
	readonly annotations: {
		readonly title: string;
		readonly readOnlyHint: boolean;
		readonly openWorldHint: boolean;
	};
}

/**
 * JSON Schema + MCP annotations for each tool, keyed by tool name. Keys MUST
 * match the keys of `TIER_ENTRIES` in `tool-descriptions.ts` — module-load
 * validation below asserts this.
 */
const SCHEMAS: Readonly<Record<string, ToolSchema>> = {
	// ── Tier 1 ─────────────────────────────────────────────────────────────
	search_code: {
		inputSchema: {
			type: "object",
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

	file_outline: {
		inputSchema: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description: "File path relative to project root",
				},
				limit: {
					type: "number",
					description:
						"Max entities to return (default 30, max 100). Narrow with entity:<name> for huge files.",
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

	file_read: {
		inputSchema: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description: "File path relative to project root",
				},
				offset: { type: "number", description: "Start line (0-based)" },
				limit: { type: "number", description: "Number of lines to read" },
				entity: {
					type: "string",
					description:
						"Extract a specific function/class by name (avoids reading full file)",
				},
				purpose: {
					type: "string",
					enum: ["explore", "reference"],
					description:
						"Read intent: 'explore' (default, budget-capped) or 'reference' (entity/offset only, tight budget).",
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

	get_entity: {
		inputSchema: {
			type: "object",
			properties: {
				key: {
					type: "string",
					description:
						"Entity key (e.g., 'handleRequest', 'QueryRouter.dispatch', 'QueryRouter')",
				},
				entity_name: {
					type: "string",
					description:
						"Alias for `key`. If both are provided, `key` wins. Useful for natural-language names.",
				},
				kind: {
					type: "string",
					enum: ["function", "class", "type", "variable"],
					description: "Optional entity kind filter.",
				},
				include_body: {
					type: "boolean",
					description:
						"Include the full function/class body. Default false — returns signature + first ~15 lines.",
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

	get_references: {
		inputSchema: {
			type: "object",
			properties: {
				key: { type: "string", description: "Entity key to find references for" },
				entity_name: {
					type: "string",
					description: "Alias for `key`. If both are provided, `key` wins.",
				},
				direction: {
					type: "string",
					enum: ["callers", "callees"],
					description: "'callers' (default) or 'callees'.",
					default: "callers",
				},
				limit: {
					type: "number",
					description: "Max references to return (default 25).",
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

	// ── Tier 2 ─────────────────────────────────────────────────────────────
	get_critical_nodes: {
		inputSchema: {
			type: "object",
			properties: {
				top_n: {
					type: "number",
					description: "Number of critical nodes to return (default: 10)",
				},
				community_id: {
					type: "number",
					description: "Optional community ID to scope to a specific cluster",
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

	get_cross_boundary_links: {
		inputSchema: {
			type: "object",
			properties: {
				community_id: {
					type: "number",
					description: "Optional community ID to show links for a specific cluster",
				},
				from_path: {
					type: "string",
					description:
						"Directory prefix for one side of the edge (e.g. 'src/proxy'). Order does not matter.",
				},
				to_path: {
					type: "string",
					description:
						"Directory prefix for the other side (e.g. 'src/intelligence').",
				},
				top_n: {
					type: "number",
					description: "Number of links to return (default: 20)",
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

	file_connections: {
		inputSchema: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description: "File path relative to project root",
				},
				limit: {
					type: "number",
					description:
						"Max connections to return (default 20, max 100). Narrow file_path scope before bumping.",
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

	get_test_coverage: {
		inputSchema: {
			type: "object",
			properties: {
				key: {
					type: "string",
					description: "Entity key or name to find test coverage for",
				},
				entity_name: {
					type: "string",
					description: "Alias for `key`. If both are provided, `key` wins.",
				},
				include_transitive: {
					type: "boolean",
					description: "Include tests covering callers of this entity (default: true)",
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

	get_project_stats: {
		inputSchema: {
			type: "object",
			properties: { token_budget: TOKEN_BUDGET_PROP },
			required: [],
		},
		annotations: {
			title: "Get Project Stats",
			readOnlyHint: true,
			openWorldHint: false,
		},
	},

	get_imports: {
		inputSchema: {
			type: "object",
			properties: {
				file_path: { type: "string", description: "File path to get imports for" },
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

	get_conventions: {
		inputSchema: {
			type: "object",
			properties: { token_budget: TOKEN_BUDGET_PROP },
		},
		annotations: {
			title: "Get Code Conventions",
			readOnlyHint: true,
			openWorldHint: false,
		},
	},

	get_file: {
		inputSchema: {
			type: "object",
			properties: {
				key: { type: "string", description: "File path relative to project root" },
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

	// ── Tier 3 ─────────────────────────────────────────────────────────────
	mark_intent: {
		inputSchema: {
			type: "object",
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

	mark_decision: {
		inputSchema: {
			type: "object",
			properties: {
				text: {
					type: "string",
					description: "One short sentence describing the decision (≤140 chars).",
				},
				alternatives: {
					type: "array",
					items: { type: "string" },
					description: "Up to 5 alternatives considered. Each ≤80 chars.",
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

	mark_blocker: {
		inputSchema: {
			type: "object",
			properties: {
				text: {
					type: "string",
					description: "One short sentence describing the blocker (≤140 chars).",
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

	mark_resolution: {
		inputSchema: {
			type: "object",
			properties: {
				blocker_ref: {
					type: "string",
					description: "marker_id returned by the prior mark_blocker call.",
				},
				text: {
					type: "string",
					description: "One short sentence describing the resolution (≤140 chars).",
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

	recall_facts: {
		inputSchema: {
			type: "object",
			properties: {
				scope: {
					type: "string",
					description: "File path, entity key, or 'project' to recall facts for",
				},
				fact_type: {
					type: "string",
					enum: ["procedural", "semantic", "negative", "convention", "all"],
					description: "Filter by fact type (default: all).",
				},
				min_confidence: {
					type: "number",
					description: "Minimum effective confidence threshold (default: 0.3)",
				},
				limit: {
					type: "number",
					description: "Max facts to return (default 5, max 25).",
				},
				rotation: {
					type: "string",
					enum: ["decay", "none"],
					description:
						"Ranking mode. 'decay' (default) rotates top-N across calls; 'none' is static.",
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

	record_fact: {
		inputSchema: {
			type: "object",
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
						"procedural=how-to, semantic=architecture, negative=anti-pattern, convention=standard",
				},
				scope: {
					type: "string",
					description: "File path, entity key, or 'project' for project-wide facts",
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
};

/**
 * The MCP tool definition shape emitted in `tools/list`. The `description`
 * field is composed at module load from the active-state description in
 * `tool-descriptions.ts`. Renderers that need a different state (e.g. the
 * soft-refuse path) call `renderToolDefinition(name, state)` directly.
 */
export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: ToolSchema["inputSchema"];
	readonly annotations: ToolSchema["annotations"];
}

function buildDefinition(name: string, schema: ToolSchema): ToolDefinition {
	return {
		name,
		description: getDescription(name, "active"),
		inputSchema: schema.inputSchema,
		annotations: schema.annotations,
	};
}

// ── Module-load-time consistency check ─────────────────────────────────────
//
// Every tool listed in TIER_ENTRIES must have a schema here, and vice versa.
// A mismatch is a developer bug that should fail loud at import time.

{
	const schemaKeys = new Set(Object.keys(SCHEMAS));
	const descriptionKeys = new Set(listToolNames());
	const missingSchema = [...descriptionKeys].filter((n) => !schemaKeys.has(n));
	const missingDescription = [...schemaKeys].filter(
		(n) => !descriptionKeys.has(n),
	);
	if (missingSchema.length > 0 || missingDescription.length > 0) {
		throw new Error(
			`tool-definitions.ts <> tool-descriptions.ts keys diverged.\n` +
				`  Missing schema for: ${missingSchema.join(", ") || "(none)"}\n` +
				`  Missing description for: ${missingDescription.join(", ") || "(none)"}`,
		);
	}
}

/**
 * The full set of tool definitions, sorted by name for deterministic output.
 * Built once at module load. Use `renderToolDefinition(name, state)` for any
 * non-active rendering — do not mutate this array.
 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = listToolNames().map(
	(name) => buildDefinition(name, SCHEMAS[name] as ToolSchema),
);

/**
 * Render a single tool definition in the requested description state. Used
 * by the gateway's masking pipeline (Sprint P0-3) when composing the
 * soft-refuse response or a locked-state `tools/list`.
 */
export function renderToolDefinition(
	name: string,
	state: "active" | "locked" | "unlocked",
): ToolDefinition {
	const schema = SCHEMAS[name];
	if (!schema) {
		throw new Error(`Unknown tool: "${name}".`);
	}
	return {
		name,
		description: getDescription(name, state),
		inputSchema: schema.inputSchema,
		annotations: schema.annotations,
	};
}
