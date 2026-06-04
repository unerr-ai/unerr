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
 * Static recommendation table: per gated tool, the tier-1 tool the agent
 * should call instead — paired with an example argument shape so the refusal
 * carries a directly-pastable next action.
 *
 * After the token-overhead catalog reduction, the only advertised gated tool
 * is `unerr_track` (every other previously-gated read/write left the catalog).
 * Its op:'intent' call is the first-action it carries, so the tier-1 fallback
 * is a file_read — read the code before tracking intent.
 *
 * Invariant (asserted at module load below): keys here MUST equal the keys of
 * UNLOCK_CONDITIONS in tool-tiers.ts.
 */
const TIER1_ALTERNATIVE: Readonly<
  Record<string, { tool: string; example: string }>
> = {
  unerr_track: { tool: "file_read", example: "" },
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
  /**
   * The refused call's own arguments. When present, the alternative
   * example's `<path>` / `<name>` / `<symbol>` / `<changed_symbol>`
   * placeholders are interpolated with the concrete values the agent
   * already supplied, so the refusal carries a verbatim-pastable next
   * action (CLAUDE.md nudge rule: numbers/nouns over placeholders).
   * Omitted → placeholders are left intact (still a valid template).
   */
  readonly args?: Record<string, unknown>;
}

/**
 * Pull the concrete `path` / `symbol` / `key` the agent already named in
 * the refused call, so the alternative example can be made pastable. A
 * value is only used as a `symbol` when it is NOT path-shaped — a
 * `get_file({key:"src/x.ts"})` refusal fills `<path>` from the key but
 * must leave `<name>` a placeholder (the agent never named a symbol).
 */
function refusalContext(args: Record<string, unknown> | undefined): {
  path?: string;
  symbol?: string;
  changedSymbol?: string;
} {
  if (!args) return {};
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  const looksPath = (s: string | undefined): boolean =>
    !!s && (s.includes("/") || /\.[a-z0-9]+$/i.test(s));

  const key = str(args.key);
  const path =
    str(args.file_path) ??
    str(args.path) ??
    str(args.filePath) ??
    str(args.from_path) ??
    str(args.to_path) ??
    (looksPath(key) ? key : undefined);
  const symbolNamed =
    str(args.entity) ?? str(args.name) ?? str(args.symbol) ?? str(args.query);
  // Only fall back to `key` for a symbol when the key is not a file path.
  const symbol = symbolNamed ?? (looksPath(key) ? undefined : key);
  const changedSymbol = symbolNamed ?? key ?? symbol;

  return {
    ...(path ? { path } : {}),
    ...(symbol ? { symbol } : {}),
    ...(changedSymbol ? { changedSymbol } : {}),
  };
}

/**
 * Substitute concrete values from the refused call into an alternative
 * example template. Placeholders with no available value are left intact
 * — better a partial template than a wrong interpolation.
 */
function fillExample(
  template: string,
  args: Record<string, unknown> | undefined
): string {
  const ctx = refusalContext(args);
  let out = template;
  if (ctx.path) out = out.split("<path>").join(ctx.path);
  if (ctx.symbol) {
    out = out.split("<symbol>").join(ctx.symbol).split("<name>").join(ctx.symbol);
  }
  if (ctx.changedSymbol) {
    out = out.split("<changed_symbol>").join(ctx.changedSymbol);
  }
  return out;
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
  const { toolName, condition, args } = inputs;
  const alt = TIER1_ALTERNATIVE[toolName];
  if (!alt) {
    throw new Error(
      `buildSoftRefuse: no tier-1 alternative registered for "${toolName}". ` +
        `Add an entry to TIER1_ALTERNATIVE in soft-refuse.ts.`
    );
  }

  const unlockWhen = describeCondition(condition);
  const example = fillExample(alt.example, args);
  const action = example ? `call ${example} first.` : `call ${alt.tool} first.`;

  const text =
    `ur|fct ${toolName} locked — ${action}\n` +
    `\n` +
    `_error: tool_locked\n` +
    `_unlock_when: ${unlockWhen}\n` +
    `_alternative: ${example || alt.tool}`;

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
export function softRefuseFor(
  toolName: string,
  args?: Record<string, unknown>
): SoftRefuseResult {
  const condition = UNLOCK_CONDITIONS[toolName];
  if (!condition) {
    throw new Error(
      `softRefuseFor: tool "${toolName}" has no unlock policy. ` +
        `Tier-1 tools should never be gated; tier-2/3 must have an entry in UNLOCK_CONDITIONS.`
    );
  }
  return buildSoftRefuse({ toolName, condition, args });
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
