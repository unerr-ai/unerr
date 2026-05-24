/**
 * Universal soft-refuse builder.
 *
 * Returned when an agent calls a tier-2/3 tool whose unlock condition has
 * not yet fired. The shape is a valid MCP tool error: a single `text`
 * content block carrying a `ur|fct` line followed by structured key/value
 * pairs. Every known MCP client surfaces this as text to the model, so
 * the gateway works on Cursor / Cline / Codex / Windsurf identically to
 * Claude Code without depending on `tools/list_changed`.
 *
 * Text rules (per CLAUDE.md "Writing nudges and hints"):
 *   - Imperative verb + named tool.
 *   - No deictic pronouns ("this entity", "this file").
 *   - No hedge verbs (`consider`, `verify`, `check`, `may want to`).
 *   - Numbers, not placeholders.
 *   - Legend agreement: `ur|fct` is "fact — information for context" (the
 *     consolidated 4-tag set replaced legacy `hnt`/`unl` in 2026-05).
 *
 * The proxy wrapper at the MCP boundary stamps `isError: true` on the
 * wire frame when it sees `_meta.gate_status === "locked"`.
 */

import {
  type Condition,
  UNLOCK_CONDITIONS,
  describeCondition,
} from "./tool-tiers.js";

/**
 * Static recommendation table: per tier-2/3 tool, the tier-1 tool the
 * agent should call instead — paired with an example argument shape so
 * the refusal carries a directly-pastable next action.
 *
 * Reasoning per entry:
 *   - get_critical_nodes → search_code   (find target entity first)
 *   - get_cross_boundary_links → file_outline (see boundary from outline)
 *   - file_connections → file_outline    (start with the file's outline)
 *   - get_test_coverage → search_code    (locate target before coverage)
 *   - get_imports → file_outline         (imports already in outline)
 *   - get_conventions → file_read        (read a file to anchor style)
 *   - get_file → file_read               (use file_read with entity arg)
 *   - mark_intent / mark_decision / mark_blocker / mark_resolution →
 *       no tier-1 alternative; these are pure narrative markers that
 *       require ≥3 turns of real work first.
 *   - recall_facts → file_read           (file_read auto-injects facts)
 *   - record_fact → mark_decision        (decide first, then record)
 */
const TIER1_ALTERNATIVE: Readonly<
  Record<string, { tool: string; example: string }>
> = {
  get_critical_nodes: {
    tool: "search_code",
    example: 'search_code({query:"<symbol>"})',
  },
  get_cross_boundary_links: {
    tool: "file_outline",
    example: 'file_outline({file_path:"<path>"})',
  },
  file_connections: {
    tool: "file_outline",
    example: 'file_outline({file_path:"<path>"})',
  },
  get_test_coverage: {
    tool: "search_code",
    example: 'search_code({query:"<symbol>"})',
  },
  get_imports: {
    tool: "file_outline",
    example: 'file_outline({file_path:"<path>"})',
  },
  get_conventions: {
    tool: "file_read",
    example: 'file_read({file_path:"<path>"})',
  },
  get_file: {
    tool: "file_read",
    example: 'file_read({file_path:"<path>",entity:"<name>"})',
  },
  mark_intent: { tool: "file_read", example: "" },
  mark_decision: {
    tool: "mark_intent",
    example: 'mark_intent({intent:"<one sentence>"})',
  },
  mark_blocker: {
    tool: "mark_intent",
    example: 'mark_intent({intent:"<one sentence>"})',
  },
  mark_resolution: {
    tool: "mark_blocker",
    example: 'mark_blocker({blocker:"<obstacle>"})',
  },
  recall_facts: {
    tool: "file_read",
    example: 'file_read({file_path:"<path>"})',
  },
  record_fact: {
    tool: "mark_decision",
    example: 'mark_decision({decision:"<choice>"})',
  },
};

/**
 * Construction inputs gathered from `tool-tiers.ts` and `SessionState`
 * at the moment of the gate firing. Pure data — the builder has no
 * dependency on the live router.
 */
export interface SoftRefuseInputs {
  readonly toolName: string;
  /** Unlock policy AST — used to compose the human-readable trigger. */
  readonly condition: Condition;
}

/**
 * Shape consumed by `QueryRouter.execute` → `proxy.ts` boundary. The
 * router returns this as the `content` of a `ToolResult` and the proxy
 * stamps `isError: true` on the wire frame based on `gate_status`.
 */
export interface SoftRefuseResult {
  /** Single text block — matches MCP `CallToolResult` shape. */
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  /** Stable diagnostic fields the dashboard can read directly. */
  readonly _gate: {
    readonly status: "locked";
    readonly tool: string;
    readonly unlock_when: string;
    readonly alternative_tool: string;
  };
}

/**
 * Build the canonical soft-refuse text + diagnostic envelope for one
 * locked tier-2/3 tool. Pure, synchronous, allocation-bounded.
 */
export function buildSoftRefuse(inputs: SoftRefuseInputs): SoftRefuseResult {
  const { toolName, condition } = inputs;
  const alt = TIER1_ALTERNATIVE[toolName];
  if (!alt) {
    throw new Error(
      `buildSoftRefuse: no tier-1 alternative registered for "${toolName}". ` +
        `Add an entry to TIER1_ALTERNATIVE in soft-refuse.ts.`
    );
  }

  const unlockWhen = describeCondition(condition);
  const action = alt.example
    ? `call ${alt.example} first.`
    : `call ${alt.tool} first.`;

  const text =
    `ur|fct ${toolName} locked — ${action}\n` +
    `\n` +
    `_error: tool_locked\n` +
    `_unlock_when: ${unlockWhen}\n` +
    `_alternative: ${alt.example || alt.tool}`;

  return {
    content: [{ type: "text", text }],
    _gate: {
      status: "locked",
      tool: toolName,
      unlock_when: unlockWhen,
      alternative_tool: alt.tool,
    },
  };
}

/**
 * Convenience for callers that already have a tool name and want the
 * refusal without manually fetching the AST. Throws `UnknownToolError`
 * if the name is unknown to the tier registry.
 */
export function softRefuseFor(toolName: string): SoftRefuseResult {
  const condition = UNLOCK_CONDITIONS[toolName];
  if (!condition) {
    throw new Error(
      `softRefuseFor: tool "${toolName}" has no unlock policy. ` +
        `Tier-1 tools should never be gated; tier-2/3 must have an entry in UNLOCK_CONDITIONS.`
    );
  }
  return buildSoftRefuse({ toolName, condition });
}

/** Test-only inspection hook. */
export const _internal = { TIER1_ALTERNATIVE };

// ── Module-load consistency check ──────────────────────────────────────────
// Every tier-2/3 tool listed in UNLOCK_CONDITIONS must have a TIER1
// alternative entry. Fail loud at import if either invariant breaks.
{
  const policyKeys = new Set(Object.keys(UNLOCK_CONDITIONS));
  const altKeys = new Set(Object.keys(TIER1_ALTERNATIVE));
  const missing = [...policyKeys].filter((n) => !altKeys.has(n));
  const orphan = [...altKeys].filter((n) => !policyKeys.has(n));
  if (missing.length > 0 || orphan.length > 0) {
    throw new Error(
      "soft-refuse: TIER1_ALTERNATIVE out of sync with UNLOCK_CONDITIONS.\n" +
        `  Locked tools missing an alternative: ${missing.join(", ") || "(none)"}\n` +
        `  Alternatives for unknown tools: ${orphan.join(", ") || "(none)"}`
    );
  }
}
