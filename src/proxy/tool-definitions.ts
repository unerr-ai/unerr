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

import {
  advertisedToolNames,
  getDescription,
  listToolNames,
} from "./tool-descriptions.js";

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
            "Entity name, partial name, or exact key (e.g., 'compress', 'handleRequest', 'QueryRouter.dispatch')",
        },
        limit: {
          type: "number",
          description:
            "Max results in list mode (default 20); caps want:['callers','callees'] rows in detail mode (default 25)",
        },
        detail: {
          type: "boolean",
          description:
            "Resolve query to the single best-matching entity and return its profile — signature + first ~15 lines, fan-in/out, risk level — instead of the ranked list. include_body and want imply detail.",
          default: false,
        },
        include_body: {
          type: "boolean",
          description:
            "Detail mode: include the full function/class body (default false — signature + ~15-line preview).",
          default: false,
        },
        want: {
          type: "array",
          items: {
            type: "string",
            enum: ["callers", "callees", "imports"],
          },
          description:
            "Detail mode extras attached in one call: 'callers'/'callees' (each capped by `limit`, with a *_total count) and 'imports' (the entity's file-level import list).",
        },
        kind: {
          type: "string",
          enum: ["function", "class", "type", "variable"],
          description: "Detail mode: optional entity kind filter.",
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

  unerr_context: {
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "What you are about to do, verbatim (e.g. 'add a retry to fetchUser'). Drives note recall, entity search, and the focus-entity blast radius.",
        },
        budget: {
          type: "integer",
          description:
            "Whole-bundle token budget (default 4000). Sections are kept by priority — focus bodies, callers, notes, conventions — and trimmed to fit.",
        },
        response_format: {
          type: "string",
          enum: ["concise", "detailed"],
          description:
            "Verbosity. 'detailed' (use right before an edit) inlines the 2–4 focus entities' verbatim source bodies with file:line ranges, so you skip the follow-up file_read. 'concise' (use when orienting a large sweep) returns names, signatures, and callers only. Defaults from task size server-side — set explicitly to override.",
        },
        digest: {
          type: "boolean",
          description:
            "Force the flat large-sweep digest render (entities grouped by file, callers collapsed to a count). Auto-enabled when the task classifies as a large sweep.",
        },
      },
      required: ["prompt"],
    },
    annotations: {
      title: "Recon Repo Context",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },

  fetch_url: {
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Absolute URL to fetch (http or https). Localhost is allowed without TLS upgrade.",
        },
        prompt: {
          type: "string",
          description:
            "Optional. When set AND extracted markdown > 8 KB, passages are re-ranked by BM25 relevance to this prompt (default top 20).",
        },
        offset: {
          type: "integer",
          description:
            "Passage index to start at for pagination (default 0). Pair with limit to walk long pages without re-fetching.",
        },
        limit: {
          type: "integer",
          description:
            "Maximum passages to return (default 30, max 300). Also acts as BM25 topK when prompt is set.",
        },
        token_budget: TOKEN_BUDGET_PROP,
      },
      required: ["url"],
    },
    annotations: {
      title: "Fetch Web Page (Markdown + BM25)",
      readOnlyHint: true,
      openWorldHint: true,
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

  // get_entity merged into search_code (2026-06): detail/include_body/want/kind
  // on search_code translate to the internal get_entity executor in
  // QueryRouter.execute(). De-advertised, dispatched by name only.

  get_references: {
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Entity key to find references for",
        },
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

  // ── unerr_track — session markers + facts (op-union) ───────────────────
  unerr_track: {
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: [
            "intent",
            "decision",
            "blocker",
            "resolution",
            "fact",
            "recall",
          ],
          description:
            "What to track. intent=task start (REQUIRED first on coding tasks); decision=deliberate choice; blocker=obstacle (returns marker_id); resolution=fix for a blocker; fact=record a project fact; recall=read stored facts for a scope.",
        },
        text: {
          type: "string",
          description:
            "Body for intent/decision/blocker, the fix for resolution, or the fact content for fact. ≤1400 chars.",
        },
        blocker_ref: {
          type: "string",
          description:
            "resolution only — the marker_id returned by the prior op:'blocker'.",
        },
        scope: {
          type: "string",
          description: "fact/recall — file path, entity key, or 'project'.",
        },
        target: {
          type: "string",
          description:
            "fact — the subject/entity the fact is about. blocker — optional file path where it surfaced.",
        },
        fact_type: {
          type: "string",
          enum: ["procedural", "semantic", "negative", "convention", "all"],
          description:
            "fact = procedural/semantic/negative/convention. recall = filter (or 'all').",
        },
        alternatives: {
          type: "array",
          items: { type: "string" },
          description:
            "decision only — up to 5 alternatives considered, each ≤80 chars.",
        },
      },
      required: ["op"],
    },
    annotations: {
      title: "Track session markers + facts",
      readOnlyHint: false,
      openWorldHint: false,
    },
  },

  // unerr_remember has no schema entry (removed 2026-06): it left the catalog
  // when its two write paths moved to hooks — user rules are captured at
  // UserPromptSubmit (remember-client.ts), agent notes ride the `unerr-save:`
  // Stop-hook sentinel (sentinel-persist.ts). Both clients dispatch it BY NAME
  // over UDS `tools/call`; the proxy's by-name switch matches it regardless of
  // catalog membership, and its payload union was always enforced at handler
  // dispatch, never by this schema table.
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
    (n) => !descriptionKeys.has(n)
  );
  if (missingSchema.length > 0 || missingDescription.length > 0) {
    throw new Error(
      `tool-definitions.ts <> tool-descriptions.ts keys diverged.\n` +
        `  Missing schema for: ${missingSchema.join(", ") || "(none)"}\n` +
        `  Missing description for: ${missingDescription.join(", ") || "(none)"}`
    );
  }
}

/**
 * The full set of tool definitions, sorted by name for deterministic output.
 * Built once at module load. Use `renderToolDefinition(name, state)` for any
 * non-active rendering — do not mutate this array.
 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = listToolNames().map(
  (name) => buildDefinition(name, SCHEMAS[name] as ToolSchema)
);

/**
 * The advertisement slice of {@link TOOL_DEFINITIONS} — every definition the
 * model SEES in `tools/list`, with demoted (hidden) tools dropped. This is the
 * validation/advertisement split: `TOOL_DEFINITIONS` stays complete so
 * `runBoundaryValidation` and the families registry keep every tool, while the
 * surface advertised to the model shrinks to the non-hidden set. The bridge's
 * offline catalog and any direct tools/list emission use THIS array.
 */
export const ADVERTISED_TOOL_DEFINITIONS: readonly ToolDefinition[] = (() => {
  const advertised = new Set(advertisedToolNames());
  return TOOL_DEFINITIONS.filter((d) => advertised.has(d.name));
})();

/**
 * Render a single tool definition in the requested description state. Used
 * by the gateway's masking pipeline (Sprint P0-3) when composing the
 * soft-refuse response or a locked-state `tools/list`.
 */
export function renderToolDefinition(
  name: string,
  state: "active" | "locked" | "unlocked"
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
