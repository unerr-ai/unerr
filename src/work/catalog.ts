/**
 * Work-mode tool catalog — the advertised `tools/list` payload is a CONSTANT.
 *
 * Same discipline as `src/proxy/catalog-lock.ts`, for the same reason: the tool
 * schemas an MCP server advertises sit at the front of the provider's cache
 * prefix, and prompt caching is exact-prefix. One changed byte in this block
 * re-bills every token after it as a cache WRITE. So the answer to `tools/list`
 * is a frozen module-level constant, never derived from runtime state.
 *
 * Two tripwires:
 *   - {@link MAX_WORK_TOOLS} is PINNED, not derived. Adding a sixth tool means
 *     editing the constant as well as the array, which is the point — a new
 *     tool must be a decision, never a side effect of adding a file.
 *   - {@link MAX_WORK_CATALOG_SERIALIZED_CHARS} bounds the serialized size.
 *     Claude Code defers an MCP server's schemas behind its tool-search bridge
 *     once they pass roughly 10% of the context window; a deferred schema loads
 *     MID-SESSION on first use, which is exactly the prefix mutation this file
 *     exists to prevent. The ceiling is checked by a build-time guard test, not
 *     at runtime — at runtime there is nothing useful to do about an oversized
 *     catalog except refuse to serve, which is worse than serving.
 *
 * Work mode advertises five tools and no graph tools. `search_code` and
 * `get_references` are pure call-graph surfaces: in a folder with no index they
 * would answer nothing while still billing their schemas on every turn.
 */

import { createHash } from "node:crypto";

/** MCP tool-definition shape, declared locally so this file pulls in no proxy state. */
export interface WorkToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  };
  readonly annotations?: Readonly<Record<string, unknown>>;
}

/**
 * The five tool names work mode serves, in wire order. Exported as a tuple so
 * a caller can switch on the union type instead of a bare string.
 */
export const WORK_TOOL_NAMES = [
  "fetch_url",
  "file_read",
  "file_edit",
  "find_files",
  "run_command",
] as const;

export type WorkToolName = (typeof WORK_TOOL_NAMES)[number];

/**
 * Number of tools work mode advertises. Pinned, not `WORK_TOOL_NAMES.length` —
 * a sixth tool has to be a deliberate edit here too.
 */
export const MAX_WORK_TOOLS = 5;

/**
 * Ceiling on `JSON.stringify(WORK_TOOL_DEFINITIONS).length`. Today: 5,841 chars
 * (~1,460 tokens), so ~22% room to retune the five descriptions.
 *
 * Well under the code-mode ceiling of 12,000, and an order of magnitude under
 * the point where a host defers an MCP server's schemas behind a tool-search
 * bridge and starts loading them mid-session. A tripwire, not a target: hitting
 * it means someone added surface, and that needs a decision rather than a
 * bumped constant.
 */
export const MAX_WORK_CATALOG_SERIALIZED_CHARS = 7_500;

const DEFINITIONS: readonly WorkToolDefinition[] = [
  {
    name: "fetch_url",
    description:
      "The ONLY web path in work mode — send every http/https read through fetch_url, never a browser, curl, or wget. Fetch one page (url) or up to 10 (urls:[...], parallel, ranked across pages, ONE roundtrip) and get DOM-extracted markdown passages back. Set prompt to rank passages by relevance to that prompt.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Absolute URL of ONE page to fetch (http or https). Use urls for several pages.",
        },
        urls: {
          type: "array",
          items: { type: "string" },
          maxItems: 10,
          description:
            "Up to 10 absolute URLs fetched in ONE call — parallel, passages ranked across all pages. url OR urls, never both.",
        },
        prompt: {
          type: "string",
          description:
            "Rank extracted passages by relevance to this prompt (applies once the page exceeds 8 KB of markdown).",
        },
        offset: {
          type: "integer",
          description:
            "Passage index to start at for pagination (default 0). Pair with limit to walk a long page without re-fetching.",
        },
        limit: {
          type: "integer",
          description:
            "Maximum passages to return (default 30, max 300). Also the topK when prompt is set.",
        },
        token_budget: {
          type: "integer",
          description: "Max response tokens (default 400).",
        },
      },
      required: [],
    },
    annotations: {
      title: "Fetch Web Page (Markdown, ranked)",
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "file_read",
    description:
      "Read a file as numbered lines: {file_path} = whole file, budget-capped; {file_path, offset, limit} = one line range. When a read is capped, the withheld remainder is cached and named on a ur|cache-ref line — pass that cache_ref with offset and limit to pull the rest instead of re-reading at a bigger budget.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "Path to the file, absolute or relative to the working folder.",
        },
        offset: {
          type: "number",
          description: "Start line, 0-based (default 0).",
        },
        limit: { type: "number", description: "Number of lines to read." },
        cache_ref: {
          type: "string",
          description:
            "Hash from a prior ur|cache-ref line — returns the withheld slice from the in-process cache. Pair with offset and limit (characters, not lines).",
        },
        token_budget: {
          type: "integer",
          description: "Max response tokens (default 2000).",
        },
      },
      required: ["file_path"],
    },
    annotations: {
      title: "Read File",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "file_edit",
    description:
      "Change a file. Pass old_string plus new_string for an exact replacement (must match once unless replace_all:true), or content to create or overwrite the whole file. Pass base_hash from the file_read or file_edit you based the change on and the edit is rejected if the file moved underneath you.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "Path to the file, absolute or relative to the working folder.",
        },
        old_string: {
          type: "string",
          description:
            "Edit mode: the exact text to replace. Add surrounding lines to make it unique.",
        },
        new_string: {
          type: "string",
          description: "Edit mode: the replacement text.",
        },
        replace_all: {
          type: "boolean",
          description:
            "Edit mode: replace every occurrence instead of the first (default false).",
        },
        base_hash: {
          type: "string",
          description:
            "Staleness guard: the hash returned by the read or edit this change is based on.",
        },
        content: {
          type: "string",
          description:
            "Write mode: full file content. Creates parent directories, preserves encoding and line ending. EITHER content OR old_string plus new_string, never both.",
        },
      },
      required: ["file_path"],
    },
    annotations: {
      title: "Change File",
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "find_files",
    description:
      "Find files under the working folder by name, by content, or both — no index, so it works on a folder opened seconds ago. Pass name for a filename glob ('*.md', 'notes/**/draft*'), content for text inside files, regex:true to read content as a regular expression. Skips node_modules, .git, and anything a .gitignore excludes.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Filename glob matched against the path relative to the working folder, e.g. '*.md' or 'docs/**/*.txt'.",
        },
        content: {
          type: "string",
          description:
            "Text to find inside files. Combine with name to search only matching files.",
        },
        regex: {
          type: "boolean",
          description:
            "Read content as a JavaScript regular expression instead of literal text (default false).",
        },
        case_sensitive: {
          type: "boolean",
          description: "Match content case-sensitively (default false).",
        },
        path: {
          type: "string",
          description:
            "Subfolder to search under, relative to the working folder (default: the whole folder).",
        },
        limit: {
          type: "number",
          description: "Maximum files reported (default 50, max 500).",
        },
        context: {
          type: "number",
          description:
            "Lines of surrounding context per content match (default 2, max 6).",
        },
      },
      required: [],
    },
    annotations: {
      title: "Find Files by Name or Content",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command and get its output back compressed to a token budget. The full untouched output is written to a tee file and its path is returned, so a truncated run is always recoverable with file_read. Use run_command for every shell run in work mode.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command line to run.",
        },
        cwd: {
          type: "string",
          description:
            "Directory to run in, relative to the working folder (default: the working folder).",
        },
        timeout_ms: {
          type: "integer",
          description:
            "Kill the command after this many milliseconds (default 120000, max 600000).",
        },
        token_budget: {
          type: "integer",
          description: "Token budget for the compressed output (default 2000).",
        },
      },
      required: ["command"],
    },
    annotations: {
      title: "Run Shell Command (compressed output)",
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
];

/** Deep-freeze so no caller can mutate the advertised answer in place. */
function freezeCatalog(
  tools: readonly WorkToolDefinition[]
): readonly WorkToolDefinition[] {
  for (const tool of tools) {
    Object.freeze(tool.inputSchema.properties);
    Object.freeze(tool.inputSchema);
    if (tool.annotations !== undefined) Object.freeze(tool.annotations);
    Object.freeze(tool);
  }
  return Object.freeze([...tools]);
}

/** The frozen catalog. This array IS the `tools/list` answer, byte for byte. */
export const WORK_TOOL_DEFINITIONS: readonly WorkToolDefinition[] =
  freezeCatalog(DEFINITIONS);

/** Serialized catalog — the guard test measures this against the ceiling. */
export const WORK_CATALOG_JSON: string = JSON.stringify(WORK_TOOL_DEFINITIONS);

/** Short content hash of the serialized catalog, logged once at startup. */
export const WORK_CATALOG_SHA256: string = createHash("sha256")
  .update(WORK_CATALOG_JSON, "utf8")
  .digest("hex")
  .slice(0, 16);

// ── Module-load consistency check ──────────────────────────────────────────
//
// The pinned count, the name tuple and the definition array must agree. A
// mismatch is a developer bug, so it fails loud at import time rather than
// serving a catalog nobody decided on.
{
  const definedNames = WORK_TOOL_DEFINITIONS.map((t) => t.name);
  if (WORK_TOOL_DEFINITIONS.length !== MAX_WORK_TOOLS) {
    throw new Error(
      `work catalog has ${WORK_TOOL_DEFINITIONS.length} tools but MAX_WORK_TOOLS is ${MAX_WORK_TOOLS} — update both or drop the new tool.`
    );
  }
  if (definedNames.join(",") !== WORK_TOOL_NAMES.join(",")) {
    throw new Error(
      `work catalog order diverged from WORK_TOOL_NAMES: [${definedNames.join(", ")}] != [${WORK_TOOL_NAMES.join(", ")}].`
    );
  }
}

/** True when `name` is one of the five advertised work tools. */
export function isWorkToolName(name: string): name is WorkToolName {
  return (WORK_TOOL_NAMES as readonly string[]).includes(name);
}
