/**
 * Tier-3 universal wire cap — paginated delivery for MCP responses.
 *
 * Why: Claude Code, OpenAI Agents SDK, and other MCP clients all share one
 * connection per process; they don't expose whether the call originated from
 * the parent agent or a sub-agent. Sub-agent contexts are smaller and thrash
 * easily on uncapped responses (recall_facts ~3KB, file_outline ~6KB are
 * typical offenders). A universal cap with paginated retrieval keeps both
 * paths happy.
 *
 * Design principles:
 *   1. Agent narrows the query, not the budget. Hints prefer `limit:N`,
 *      `entity:<name>`, `fact_type:<T>` over bumping `token_budget`.
 *   2. token_budget bump is the escape hatch — reserved for cases where the
 *      agent genuinely needs the full payload (e.g. reading a complete
 *      function body to refactor it).
 *   3. State stays in the request. Cursor / offset / filter args travel with
 *      each call — no session pinning.
 *
 * Pipeline integration: called at the wire boundary in mcp-server.ts and
 * proxy.ts, AFTER buildSignalPrefix but BEFORE serialization.
 */

export interface WireCapResult {
  /** Possibly-truncated body — still the same JSON shape, smaller arrays. */
  body: unknown;
  /**
   * Single ur|<msg> hint line to prepend to the rendered body, telling the
   * agent what to do to retrieve the rest. null when no truncation occurred.
   */
  pageHint: string | null;
}

interface ToolCap {
  /** The wrapper field whose array we cap. Falls back to top-level array. */
  arrayKey?: string;
  /** Default visible-cap if the agent did not pass `limit`. */
  defaultLimit: number;
  /** Hard upper bound on what the agent can request via `limit`. */
  maxLimit: number;
  /** Argument name the agent passes to control page size. */
  cursorArg: string;
  /**
   * Optional filter hint appended to the pagination nudge. MUST be a
   * concrete arg=value pair the agent can paste verbatim — never a
   * placeholder like `fact_type:T` or `entity:<name>`. To suggest an enum,
   * pipe-separate the valid values (e.g. `fact_type:negative|convention`).
   * Omit if no concrete value is available — the page hint will gracefully
   * drop the filter half.
   */
  filterHint?: string;
}

const PER_TOOL_CAPS: Record<string, ToolCap> = {
  recall_facts: {
    arrayKey: "facts",
    defaultLimit: 5,
    maxLimit: 25,
    cursorArg: "limit",
    // Concrete enum the agent can paste verbatim. Narrows to anti-patterns,
    // which is the most common reason to re-call recall_facts after a
    // generic recall returns mixed types.
    filterHint: "fact_type:negative|convention|procedural|semantic",
  },
  get_references: {
    arrayKey: "references",
    defaultLimit: 10,
    maxLimit: 50,
    cursorArg: "limit",
  },
  search_code: {
    defaultLimit: 10,
    maxLimit: 50,
    cursorArg: "limit",
  },
  get_critical_nodes: {
    defaultLimit: 5,
    maxLimit: 50,
    cursorArg: "top_n",
  },
  get_cross_boundary_links: {
    defaultLimit: 5,
    maxLimit: 50,
    cursorArg: "top_n",
  },
  get_imports: {
    defaultLimit: 25,
    maxLimit: 100,
    cursorArg: "limit",
  },
  file_connections: {
    arrayKey: "connections",
    defaultLimit: 20,
    maxLimit: 100,
    cursorArg: "limit",
  },
  file_outline: {
    arrayKey: "entities",
    defaultLimit: 30,
    maxLimit: 100,
    cursorArg: "limit",
    // No filterHint: `entity:` requires a concrete name we cannot supply
    // statically. The caller should pick from the returned `entities[].name`
    // and re-call file_read with that exact value. A literal `entity:<name>`
    // hint trains the agent to paste the placeholder verbatim.
  },
};

/** Final safety net: even if a tool ignored its own cap, never let one
 * response exceed this many bytes on the wire. ~2K tokens. */
const HARD_BYTE_CAP = 8192;

/** Approximate bytes-per-token used to convert an agent's `token_budget`
 * arg into a byte cap. Conservative; modern BPE tokenizers average ~3.5–4
 * chars per token for English/code. */
const BYTES_PER_TOKEN = 4;

/** Upper bound on the byte cap reachable via `token_budget`, even if the
 * agent passes a very large value. Keeps a runaway client from blowing the
 * model context. ~16K tokens. */
const MAX_BYTE_CAP = 65536;

/**
 * Resolve the effective byte cap for this call. Defaults to HARD_BYTE_CAP;
 * agents can lift it (up to MAX_BYTE_CAP) by passing `token_budget:N` —
 * the documented escape hatch for full-payload reads (e.g. function bodies
 * for refactors). Anything <= the default keeps the default; we never
 * shrink below HARD_BYTE_CAP based on a small budget.
 */
function resolveByteCap(args: Record<string, unknown>): number {
  const tb = args.token_budget;
  if (typeof tb !== "number" || tb <= 0) return HARD_BYTE_CAP;
  const scaled = Math.floor(tb) * BYTES_PER_TOKEN;
  if (scaled <= HARD_BYTE_CAP) return HARD_BYTE_CAP;
  return Math.min(scaled, MAX_BYTE_CAP);
}

/**
 * Resolve effective limit from the agent's `args.limit` (clamped to maxLimit).
 * Returns the cap rule's `defaultLimit` when args.limit is missing/invalid.
 */
function resolveLimit(cap: ToolCap, argsLimit: unknown): number {
  if (typeof argsLimit !== "number" || argsLimit <= 0) return cap.defaultLimit;
  return Math.min(Math.floor(argsLimit), cap.maxLimit);
}

function buildPageHint(
  toolName: string,
  remaining: number,
  cursorArg: string,
  args: Record<string, unknown>,
  delivered: number,
  filterHint?: string,
): string {
  // Tight format: tag `pg` is one BPE token in modern tokenizers. Filter hint
  // is included only when narrowing actually helps. Legend in
  // SIGNAL_PREFIX_LEGEND / instruction-writer.ts already explains the pattern.
  //
  // Concrete cursor: surface the *next* offset/page so the caller can paste it
  // back. For offset-style cursors, next = (current offset) + (items delivered
  // this page). For page-style cursors, next = (current page) + 1.
  const filter = filterHint ? `/${filterHint}` : "";
  let nextCursor: number;
  if (cursorArg === "page") {
    const curPage =
      typeof args.page === "number" && args.page > 0 ? args.page : 1;
    nextCursor = curPage + 1;
  } else {
    const curOffset =
      typeof args.offset === "number" && args.offset >= 0 ? args.offset : 0;
    nextCursor = curOffset + delivered;
  }
  return `ur|pg ${toolName} +${remaining} — ${cursorArg}:${nextCursor}${filter}`;
}

/**
 * Apply the per-tool cap to the response body and produce a page hint when
 * truncation occurred. Pure: does not mutate the input.
 */
export function applyWireCap(
  toolName: string,
  rawBody: unknown,
  args: Record<string, unknown>,
): WireCapResult {
  const byteCap = resolveByteCap(args);
  const cap = PER_TOOL_CAPS[toolName];
  if (!cap) {
    // Tool not in the cap table — apply only the hard byte safety net.
    return enforceByteCap(toolName, rawBody, args, null, byteCap);
  }

  const limit = resolveLimit(cap, args[cap.cursorArg]);

  // Top-level array (e.g. search_code returns a uniform array directly).
  if (!cap.arrayKey && Array.isArray(rawBody)) {
    if (rawBody.length <= limit)
      return enforceByteCap(toolName, rawBody, args, null, byteCap);
    const total = rawBody.length;
    const sliced = rawBody.slice(0, limit);
    const hint = buildPageHint(
      toolName,
      total - limit,
      cap.cursorArg,
      args,
      sliced.length,
      cap.filterHint,
    );
    return enforceByteCap(toolName, sliced, args, hint, byteCap);
  }

  // Wrapper object pattern: {<arrayKey>: [...], ...rest}
  if (
    cap.arrayKey &&
    typeof rawBody === "object" &&
    rawBody !== null &&
    cap.arrayKey in rawBody
  ) {
    const obj = rawBody as Record<string, unknown>;
    const arr = obj[cap.arrayKey];
    if (Array.isArray(arr) && arr.length > limit) {
      // We're slicing here. Preserve the handler's `total` if it already
      // knew the true count (e.g. get_references: handler returns 25 items
      // but reports total:30 because it truncated upstream). Otherwise
      // fall back to arr.length.
      const handlerTotal =
        typeof obj.total === "number" && obj.total > arr.length
          ? obj.total
          : arr.length;
      const sliced = arr.slice(0, limit);
      const newBody: Record<string, unknown> = {
        ...obj,
        [cap.arrayKey]: sliced,
        total: handlerTotal,
        returned: sliced.length,
        more_available: handlerTotal - sliced.length,
        truncated: handlerTotal > sliced.length,
      };
      const hint = buildPageHint(
        toolName,
        handlerTotal - sliced.length,
        cap.cursorArg,
        args,
        sliced.length,
        cap.filterHint,
      );
      return enforceByteCap(toolName, newBody, args, hint, byteCap);
    }
    // The handler may have pre-sliced (e.g., recall_facts caps inside its
    // handler). Surface a page hint if `more_available` was already set.
    const moreAvailable = obj.more_available;
    if (typeof moreAvailable === "number" && moreAvailable > 0) {
      const deliveredCount = Array.isArray(arr) ? arr.length : 0;
      const hint = buildPageHint(
        toolName,
        moreAvailable,
        cap.cursorArg,
        args,
        deliveredCount,
        cap.filterHint,
      );
      return enforceByteCap(toolName, rawBody, args, hint, byteCap);
    }
    return enforceByteCap(toolName, rawBody, args, null, byteCap);
  }

  return enforceByteCap(toolName, rawBody, args, null, byteCap);
}

/**
 * Last line of defence: if the rendered body still blows past HARD_BYTE_CAP,
 * drop a `too_large` summary instead of streaming a context-overflowing payload.
 * The body and the page-hint string both name the *concrete* lever the caller
 * should pull next: a numeric token_budget that would have fit, the
 * entity/limit they already passed, and (when the call is already maximally
 * narrow) the recommendation to read in offset/limit chunks.
 */
function enforceByteCap(
  toolName: string,
  body: unknown,
  args: Record<string, unknown>,
  existingHint: string | null = null,
  byteCap: number = HARD_BYTE_CAP,
): WireCapResult {
  const serialized = typeof body === "string" ? body : JSON.stringify(body);
  if (serialized.length <= byteCap) {
    return { body, pageHint: existingHint };
  }

  // Compute the numeric token budget that would have fit this response. Round
  // up to the next 100 so the caller doesn't bounce off a fractional miss.
  const neededTokensRaw = Math.ceil(serialized.length / BYTES_PER_TOKEN);
  const neededTokens = Math.ceil(neededTokensRaw / 100) * 100;
  const cappedBudget = Math.min(neededTokens, MAX_BYTE_CAP / BYTES_PER_TOKEN);
  const requestedBudget =
    typeof args.token_budget === "number" && args.token_budget > 0
      ? Math.floor(args.token_budget)
      : null;
  const currentBudgetTokens = Math.floor(byteCap / BYTES_PER_TOKEN);

  // Was the caller already narrowed by entity/key/name? If so the only
  // remaining lever is token_budget (or splitting via offset/limit).
  const entityArg =
    (args.entity as string | undefined) ??
    (args.key as string | undefined) ??
    (args.name as string | undefined) ??
    null;
  const hasLimit = typeof args.limit === "number" && args.limit > 0;
  const hasOffset = typeof args.offset === "number" && args.offset >= 0;

  let hintTail: string;
  let reason: string;
  if (entityArg) {
    // Entity is already the narrowest selector. Don't tell the caller to
    // narrow further by entity — they did.
    reason = "entity_too_large";
    hintTail = `pass token_budget:${cappedBudget} or read in offset/limit chunks`;
  } else if (hasLimit || hasOffset) {
    // Already paginated; suggest a smaller window AND the budget bump.
    reason = "page_too_large";
    const suggestedLimit = hasLimit
      ? Math.max(
          1,
          Math.floor((args.limit as number) * (byteCap / serialized.length)),
        )
      : null;
    const limitHint = suggestedLimit
      ? `limit:${suggestedLimit}`
      : "smaller limit";
    hintTail = `${limitHint} or token_budget:${cappedBudget}`;
  } else if (byteCap > HARD_BYTE_CAP) {
    // Budget was already lifted but still overflowed — caller must narrow.
    reason = "narrow_required";
    hintTail = `narrow with entity:<name> or limit:<n> (token_budget=${currentBudgetTokens} already lifted)`;
  } else {
    reason = "too_large";
    hintTail = `narrow with entity:<name>/limit:<n> or token_budget:${cappedBudget}`;
  }

  const oversize: Record<string, unknown> = {
    status: "too_large",
    reason,
    bytes: serialized.length,
    cap_bytes: byteCap,
    needed_tokens: neededTokens,
    suggested_token_budget: cappedBudget,
    tool: toolName,
  };
  if (requestedBudget !== null) {
    oversize.requested_token_budget = requestedBudget;
  }
  if (entityArg) {
    oversize.entity = entityArg;
  }
  const overHint = `ur|pg ${toolName} ${serialized.length}B>${byteCap}B (≈${neededTokens}tok) — ${hintTail}`;
  return { body: oversize, pageHint: overHint };
}
