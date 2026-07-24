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
    "Max response tokens (default 400 = structural summary). Use 1500+ or include_body:true for full bodies.",
  default: 400,
} as const;

/**
 * Shared input-schema property for the reversible-cache retrieve side (T1.5).
 * Pagination-capable tools accept it to pull a withheld slice back from the
 * local cache instead of re-requesting the whole payload at a larger budget.
 */
export const CACHE_REF_PROP = {
  type: "string",
  description:
    "Hash from a prior `ur|cache-ref` marker — returns the withheld slice from local cache via offset/limit (~1ms) instead of recomputing. Recomputes on a cache miss.",
} as const;

/**
 * Shared input-schema property for cross-repo scope. `'repo'` (default) answers
 * from the current repo only; `'workspace'` fans the query out to the other
 * unerr repos on this machine and merges, each result labeled with its repo.
 * Pro/enterprise only — on free tier `'workspace'` degrades to the home repo
 * plus a one-line upgrade nudge (the call never errors).
 */
export const SCOPE_PROP = {
  type: "string",
  enum: ["repo", "workspace"],
  description:
    "'repo' (default, current repo) or 'workspace' (all your unerr repos, labeled by repo). Pro — free tier returns the current repo + an upgrade nudge.",
  default: "repo",
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
            "A symbol OR a task. A bare name/key ('handleRequest', 'QueryRouter.dispatch') returns ranked entity matches; a task phrase ('where is retry handled') returns a recon bundle (focus entities + callers + conventions). Lean index by default (signatures, line ranges, caller counts — no bodies); add include_body:true for bodies or file_read({entity:'<key>'}) for one entity.",
        },
        limit: {
          type: "number",
          description:
            "Max results in list mode (default 20); caps want:['callers','callees'] rows in detail mode (default 25)",
        },
        detail: {
          type: "boolean",
          description:
            "Resolve to the single best entity — profile (signature, ~15-line preview, fan-in/out, risk) instead of the default ranked list. include_body and want imply detail.",
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
        mode: {
          type: "string",
          enum: ["literal", "regex"],
          description:
            "Search mode used INSTEAD of grep/rg: 'literal' (exact string) or 'regex', across indexed files. `query` is the pattern; each match returns with ± `context` lines, no follow-up read. Omit for the default entity/recon search.",
        },
        context: {
          type: "number",
          description:
            "Content-search mode only: lines of surrounding context per match (default 2, max 6).",
        },
        scope: SCOPE_PROP,
        cache_ref: CACHE_REF_PROP,
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

  // unerr_context merged into search_code (2026-06): a task-shaped search_code
  // query re-targets to handleUnerrContextProxy in proxy.ts. The handler keeps
  // its full arg set (prompt/budget/response_format/digest/expand) and stays
  // callable by name (recall path + `unerr recon` CLI); it is just no longer an
  // advertised tools/list member. Removing it from SCHEMAS keeps the module-load
  // assertion (SCHEMAS keys == TIER_ENTRIES keys) satisfied.

  fetch_url: {
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Absolute URL of ONE page to fetch (http or https). Localhost is allowed without TLS upgrade. Use urls for several pages.",
        },
        urls: {
          type: "array",
          items: { type: "string" },
          maxItems: 10,
          description:
            "Up to 10 absolute URLs fetched in ONE call — parallel, passages BM25-ranked across all pages. After a web search, pass the result URLs here. url OR urls, never both.",
        },
        prompt: {
          type: "string",
          description:
            "Optional. When set AND extracted markdown > 8 KB, passages are re-ranked by BM25 relevance to this prompt (default top 20). In bulk mode it ranks across all pages.",
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
        cache_ref: CACHE_REF_PROP,
        token_budget: TOKEN_BUDGET_PROP,
      },
      // url XOR urls — enforced at runtime in runFetchUrlRequest (a JSON-schema
      // oneOf can't express "exactly one of two optional props" cleanly), so
      // neither is `required` here.
      required: [],
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
            "After a lean search_code index, drill down via entity:'<key>' to read the full body of the one entity you will edit.",
        },
        purpose: {
          type: "string",
          enum: ["explore", "reference"],
          description:
            "Read intent: 'explore' (default, budget-capped) or 'reference' (entity/offset only, tight budget).",
        },
        scope: SCOPE_PROP,
        cache_ref: CACHE_REF_PROP,
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

  file_edit: {
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file to change.",
        },
        old_string: {
          type: "string",
          description:
            "Edit mode: the exact string to find and replace. Must be unique in the file unless replace_all is true — add surrounding context to disambiguate.",
        },
        new_string: {
          type: "string",
          description: "Edit mode: the replacement string.",
        },
        replace_all: {
          type: "boolean",
          description:
            "Edit mode: replace every occurrence instead of just the first (default false).",
        },
        base_hash: {
          type: "string",
          description:
            "Staleness guard: the hash from the file_read / prior file_edit you based this on. Edit rejected if the file changed since.",
        },
        content: {
          type: "string",
          description:
            "Write mode: full file content. Creates (with parent dirs) or overwrites, preserving encoding + line ending. EITHER content OR old_string+new_string, not both.",
        },
      },
      required: ["file_path"],
    },
    annotations: {
      title: "Change File (edit or whole-file write)",
      readOnlyHint: false,
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
        include_text_occurrences: {
          type: "boolean",
          description:
            "Default false. Set true for a RENAME (direction:'callers' only): also returns word-boundary literal matches the call graph misses — a name in a test string, config key, or dynamic dispatch — reconcile these with the callers or the rename leaves them stale.",
          default: false,
        },
        scope: SCOPE_PROP,
        cache_ref: CACHE_REF_PROP,
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

  // unerr_track and unerr_remember have no schema entry: both removed.
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
      `tool-definitions.ts <> tool-descriptions.ts keys diverged.\n  Missing schema for: ${missingSchema.join(", ") || "(none)"}\n  Missing description for: ${missingDescription.join(", ") || "(none)"}`
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
