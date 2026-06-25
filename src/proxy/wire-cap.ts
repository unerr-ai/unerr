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

import { rankChunksByQuery } from "../intelligence/chunk-ranker.js";
import { byImportanceDesc } from "../intelligence/importance.js";
import { estimateTokenCount } from "../intelligence/token-estimator.js";
import { toWireTag } from "./response-envelope.js";
import { buildCacheMarker } from "./reversible-cache.js";
import { getSharedReversibleCache } from "./shared-cache.js";
import type { ReversibleCompressionFields } from "./shell-compression-log.js";

export interface WireCapResult {
  /** Possibly-truncated body — still the same JSON shape, smaller arrays. */
  body: unknown;
  /**
   * Single ur|<msg> hint line to prepend to the rendered body, telling the
   * agent what to do to retrieve the rest. null when no truncation occurred.
   */
  pageHint: string | null;
  /**
   * §4 reversible-compression metrics for this cap event (T1.3/T3.2/T7.4).
   * Undefined when nothing was dropped (pristine pass-through). The production
   * call sites (query-router / proxy) forward this to `appendCompressionLog`;
   * tests and other callers can ignore it (optional field, destructure-safe).
   */
  metrics?: ReversibleCompressionFields;
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
  fetch_url: {
    arrayKey: "passages",
    defaultLimit: 30,
    maxLimit: 300,
    cursorArg: "limit",
  },
};

/** Final safety net: even if a tool ignored its own cap, never let one
 * response exceed this many BPE tokens on the wire. `token_budget` and this cap
 * are both counted in real tokens (estimateTokenCount) — the same metric — so a
 * suggested budget always clears the cap on retry. */
const HARD_TOKEN_CAP = 2048;

/** Upper bound on the token cap reachable via `token_budget`, even if the agent
 * passes a very large value. Keeps a runaway client from blowing the model
 * context (~64K tokens; frontier models routinely run with 1–3M context
 * windows). */
const MAX_TOKEN_CAP = 65_536;

/** Higher bound when the caller signals `purpose:'explore'` — exploration reads
 * (browsing a long page, scanning a large entity) tolerate larger payloads than
 * reference reads (~128K tokens). */
const MAX_TOKEN_CAP_EXPLORE = 131_072;

/**
 * Resolve the effective token cap for this call. Defaults to HARD_TOKEN_CAP;
 * agents can lift it (up to MAX_TOKEN_CAP, or MAX_TOKEN_CAP_EXPLORE when
 * `purpose:'explore'` is set) by passing `token_budget:N` — the documented
 * escape hatch for full-payload reads (e.g. function bodies for refactors,
 * long-form research pages). `token_budget` is counted in real BPE tokens, the
 * SAME metric enforceTokenCap measures, so the suggested budget clears the cap
 * on retry. Anything <= the default keeps the default; we never shrink below
 * HARD_TOKEN_CAP based on a small budget.
 */
function resolveTokenCap(args: Record<string, unknown>): number {
  const tb = args.token_budget;
  if (typeof tb !== "number" || tb <= 0) return HARD_TOKEN_CAP;
  const purpose =
    typeof args.purpose === "string" ? args.purpose.trim() : undefined;
  const upper = purpose === "explore" ? MAX_TOKEN_CAP_EXPLORE : MAX_TOKEN_CAP;
  const scaled = Math.floor(tb);
  if (scaled <= HARD_TOKEN_CAP) return HARD_TOKEN_CAP;
  return Math.min(scaled, upper);
}

/**
 * Resolve effective limit from the agent's `args.limit` (clamped to maxLimit).
 * Returns the cap rule's `defaultLimit` when args.limit is missing/invalid.
 */
function resolveLimit(cap: ToolCap, argsLimit: unknown): number {
  if (typeof argsLimit !== "number" || argsLimit <= 0) return cap.defaultLimit;
  return Math.min(Math.floor(argsLimit), cap.maxLimit);
}

/**
 * Internal tool names that left the MCP catalog → the agent-callable surface
 * that reaches them. A pagination hint naming a tool the agent cannot call is
 * noise it can't act on (hint rule: pasteable verbatim). `recall_facts` is
 * reached via `unerr_track({op:'recall'})`, which forwards `limit`.
 */
const HINT_SURFACE: Readonly<Record<string, string>> = {
  recall_facts: "unerr_track op:'recall'",
};

function buildPageHint(
  toolName: string,
  remaining: number,
  cursorArg: string,
  args: Record<string, unknown>,
  delivered: number,
  filterHint?: string
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
  const surface = HINT_SURFACE[toolName] ?? toolName;
  return `ur|${toWireTag("pg")} ${surface} +${remaining} — ${cursorArg}:${nextCursor}${filter}`;
}

/**
 * Tools whose capped arrays carry graph entities (each element has `fan_in` /
 * `fan_out` / `risk_level` / `key` columns). Only these get importance ordering
 * (T3.2) and query-relevance ordering (T7.4) before the positional slice —
 * non-entity payloads (fetch_url passages, recall facts) keep their existing
 * order (T3.5: importance applies only where wire elements map to entities).
 */
const ENTITY_ARRAY_TOOLS: Readonly<Record<string, true>> = {
  search_code: true,
  get_references: true,
  get_critical_nodes: true,
  file_connections: true,
};

/** Extract the importance fields from a wire array element, tolerating any shape. */
function entityImportanceFields(item: unknown): {
  fan_in?: number;
  fan_out?: number;
  risk_level?: string;
  key?: string;
} {
  if (typeof item !== "object" || item === null) return {};
  const o = item as Record<string, unknown>;
  return {
    fan_in: typeof o.fan_in === "number" ? o.fan_in : undefined,
    fan_out: typeof o.fan_out === "number" ? o.fan_out : undefined,
    risk_level: typeof o.risk_level === "string" ? o.risk_level : undefined,
    key: typeof o.key === "string" ? o.key : undefined,
  };
}

/** Concatenated text of an entity row, scored lexically against the query. */
function entityChunkText(item: unknown): string {
  if (typeof item !== "object" || item === null) return "";
  const o = item as Record<string, unknown>;
  return [o.name, o.signature, o.summary, o.file_path, o.body]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
}

/**
 * Result of reordering an entity array before the positional slice: the
 * reordered array and which signal ordered it (for the §4 `ranking_key`).
 * When the tool's elements are not graph entities, returns the input untouched
 * with `ranking_key: 'positional'` so the metrics row stays honest.
 */
interface RankedArray {
  ordered: unknown[];
  ranking_key: "query" | "importance" | "positional";
}

/**
 * Order an entity array so the survivors of a positional slice are the most
 * load-bearing / most on-query items. Query relevance leads when a non-blank
 * `prompt`/`query` arg is present (T7.4); graph importance is the fallback
 * (T3.2). Deterministic: same input → same order (both ranker and importance
 * sort break ties stably). Non-entity tools are left untouched.
 */
function rankEntityArray(
  toolName: string,
  arr: unknown[],
  args: Record<string, unknown>
): RankedArray {
  if (!ENTITY_ARRAY_TOOLS[toolName] || arr.length <= 1) {
    return { ordered: arr, ranking_key: "positional" };
  }

  const queryArg =
    typeof args.prompt === "string" && args.prompt.trim().length > 0
      ? args.prompt.trim()
      : typeof args.query === "string" && args.query.trim().length > 0
        ? args.query.trim()
        : null;

  if (queryArg) {
    const ranked = rankChunksByQuery(
      arr.map((item) => ({ text: entityChunkText(item) })),
      queryArg
    );
    // rankChunksByQuery returns one entry per input index; reorder by it.
    const ordered = ranked.map((r) => arr[r.index]);
    return { ordered, ranking_key: "query" };
  }

  const ordered = byImportanceDesc(arr, entityImportanceFields);
  return { ordered, ranking_key: "importance" };
}

/**
 * Count how many of the dropped items were lower-importance than every kept
 * item — the §4 `dropped_low_importance` signal. After importance ordering the
 * dropped tail is exactly the low-importance items, so this is `dropped.length`
 * whenever any item carried a non-zero importance signal. Returns 0 when no
 * element had graph columns (nothing to attribute to importance).
 */
function countDroppedLowImportance(dropped: unknown[]): number {
  let withSignal = 0;
  for (const d of dropped) {
    const f = entityImportanceFields(d);
    if (
      (typeof f.fan_in === "number" && f.fan_in > 0) ||
      (typeof f.fan_out === "number" && f.fan_out > 0) ||
      f.risk_level !== undefined
    ) {
      withSignal++;
    }
  }
  return withSignal;
}

/**
 * Assemble the §4 ordering metrics for one array slice. `ranking_key` records
 * which signal ordered the survivors; `dropped_low_importance` counts the
 * low-`fan_in` items the importance pass dropped; `query_relevance_pruned`
 * counts the items query relevance dropped (only set when a real query ordered
 * the array). Returns undefined when the order was positional with nothing
 * graph-attributable, so a non-entity slice leaves these columns null.
 */
function buildSliceMetrics(
  ranking_key: "query" | "importance" | "positional",
  droppedLow: number
): ReversibleCompressionFields {
  const fields: ReversibleCompressionFields = { ranking_key };
  if (ranking_key === "importance") {
    fields.survivors_by_importance = true;
    fields.dropped_low_importance = droppedLow;
  } else if (ranking_key === "query") {
    fields.query_relevance_pruned = droppedLow;
  }
  return fields;
}

/**
 * Apply the per-tool cap to the response body and produce a page hint when
 * truncation occurred. Pure: does not mutate the input.
 */
export function applyWireCap(
  toolName: string,
  rawBody: unknown,
  args: Record<string, unknown>
): WireCapResult {
  const tokenCap = resolveTokenCap(args);
  const cap = PER_TOOL_CAPS[toolName];
  if (!cap) {
    // Tool not in the cap table — apply only the hard byte safety net.
    return enforceTokenCap(toolName, rawBody, args, null, tokenCap);
  }

  const limit = resolveLimit(cap, args[cap.cursorArg]);

  // Top-level array (e.g. search_code returns a uniform array directly).
  if (!cap.arrayKey && Array.isArray(rawBody)) {
    if (rawBody.length <= limit)
      return enforceTokenCap(toolName, rawBody, args, null, tokenCap);
    const total = rawBody.length;
    // T3.2/T7.4: order entity rows by query relevance (when a query is present)
    // or graph importance before the positional slice, so the dropped tail is
    // the least load-bearing items. Non-entity tools keep positional order.
    const { ordered, ranking_key } = rankEntityArray(toolName, rawBody, args);
    const sliced = ordered.slice(0, limit);
    const droppedLow = countDroppedLowImportance(ordered.slice(limit));
    const hint = buildPageHint(
      toolName,
      total - limit,
      cap.cursorArg,
      args,
      sliced.length,
      cap.filterHint
    );
    const capped = enforceTokenCap(toolName, sliced, args, hint, tokenCap);
    capped.metrics = {
      ...capped.metrics,
      ...buildSliceMetrics(ranking_key, droppedLow),
    };
    return capped;
  }

  // Wrapper object pattern: {<arrayKey>: [...], ...rest}
  if (
    cap.arrayKey &&
    typeof rawBody === "object" &&
    rawBody !== null &&
    cap.arrayKey in rawBody
  ) {
    const obj = rawBody as Record<string, unknown>;
    const rawArr = obj[cap.arrayKey];
    if (!Array.isArray(rawArr)) {
      return enforceTokenCap(toolName, rawBody, args, null, tokenCap);
    }
    const arrayKey = cap.arrayKey;

    // T3.2/T7.4: reorder entity rows by query relevance / graph importance
    // before the positional slice so the kept prefix is the most load-bearing
    // items. Non-entity wrappers (fetch_url passages, recall facts) are
    // untouched (`ranking_key:'positional'`).
    const { ordered: arr, ranking_key } = rankEntityArray(
      toolName,
      rawArr,
      args
    );

    // True item count = what's in `arr` plus whatever the handler already
    // truncated upstream (it tells us via `total` or `more_available`).
    const handlerTotal =
      typeof obj.total === "number" && obj.total > arr.length
        ? obj.total
        : arr.length;
    const beyondArray = Math.max(
      handlerTotal - arr.length,
      typeof obj.more_available === "number" ? obj.more_available : 0
    );
    const trueTotal = arr.length + beyondArray;

    // Build a wrapper body carrying the first `n` array items plus pagination
    // bookkeeping. Doubles as the cost function for the byte-fitting search.
    const buildBody = (n: number): Record<string, unknown> => {
      const slice = arr.slice(0, n);
      return {
        ...obj,
        [arrayKey]: slice,
        total: trueTotal,
        more_available: trueTotal - slice.length,
        truncated: trueTotal > slice.length,
      };
    };

    // Two caps compose: the COUNT cap (`limit`) and the BYTE cap. Shrink to the
    // largest prefix satisfying BOTH. Without the byte-fit step, an
    // array-wrapper response (e.g. fetch_url passages) that fit the count cap
    // but blew the byte cap was dropped wholesale by enforceTokenCap into a
    // too_large summary — forcing the agent to reason out a retry. Returning as
    // many items as fit, plus a page hint, lets it consume what arrived and
    // page the rest via the cursor arg.
    const countCap = Math.min(arr.length, limit);
    const fitCount = fittingPrefixCount(
      (n) => estimateTokenCount(JSON.stringify(buildBody(n))),
      countCap,
      tokenCap
    );
    // Always deliver at least one item when any exist — a single oversized item
    // can't be split here, and enforceTokenCap surfaces the token_budget escape
    // hatch for that case.
    const delivered = arr.length === 0 ? 0 : Math.max(1, fitCount);

    // Nothing truncated by count, bytes, or upstream → pristine pass-through.
    if (delivered >= arr.length && beyondArray === 0) {
      return enforceTokenCap(toolName, rawBody, args, null, tokenCap);
    }

    const moreAvailable = trueTotal - delivered;
    const hint =
      moreAvailable > 0
        ? buildPageHint(
            toolName,
            moreAvailable,
            cap.cursorArg,
            args,
            delivered,
            cap.filterHint
          )
        : null;
    const droppedLow = countDroppedLowImportance(arr.slice(delivered));
    const capped = enforceTokenCap(
      toolName,
      buildBody(delivered),
      args,
      hint,
      tokenCap
    );
    capped.metrics = {
      ...capped.metrics,
      ...buildSliceMetrics(ranking_key, droppedLow),
    };
    return capped;
  }

  return enforceTokenCap(toolName, rawBody, args, null, tokenCap);
}

/**
 * Binary-search the largest prefix length n in [0, maxCount] whose serialized
 * body fits within tokenCap. `cost(n)` returns the serialized BPE token count of
 * the body built from the first n items and must be monotonically
 * non-decreasing in n. Returns 0 when even a single item overflows — callers may
 * still choose to deliver 1 and let enforceTokenCap's token_budget hint handle it.
 */
function fittingPrefixCount(
  cost: (n: number) => number,
  maxCount: number,
  tokenCap: number
): number {
  if (maxCount <= 0) return 0;
  if (cost(maxCount) <= tokenCap) return maxCount;
  let lo = 0;
  let hi = maxCount;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cost(mid) <= tokenCap) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/**
 * Last line of defence: if the rendered body still blows past HARD_TOKEN_CAP,
 * drop a `too_large` summary instead of streaming a context-overflowing payload.
 * The body and the page-hint string both name the *concrete* lever the caller
 * should pull next: a numeric token_budget that would have fit, the
 * entity/limit they already passed, and (when the call is already maximally
 * narrow) the recommendation to read in offset/limit chunks.
 */
function enforceTokenCap(
  toolName: string,
  body: unknown,
  args: Record<string, unknown>,
  existingHint: string | null = null,
  tokenCap: number = HARD_TOKEN_CAP
): WireCapResult {
  const serialized = typeof body === "string" ? body : JSON.stringify(body);
  // Fast path: a string of L UTF-16 units holds at most L BPE tokens (every
  // token is ≥1 char), so length <= tokenCap guarantees a fit without paying for
  // tokenization — the common small-response case.
  if (serialized.length <= tokenCap) {
    return { body, pageHint: existingHint };
  }
  const tokens = estimateTokenCount(serialized);
  if (tokens <= tokenCap) {
    return { body, pageHint: existingHint };
  }

  // The cap and `token_budget` are both real BPE tokens (estimateTokenCount), so
  // the suggested budget — this response's token count rounded up to the next
  // 100 — clears the cap on retry by construction. (The prior byte-based cap
  // counted token_budget × 4 bytes while the suggestion was BPE-token-based; for
  // code at ~4.1 bytes/token the suggestion's byte cap stayed below the payload,
  // so retrying it failed identically and re-suggested the same value — a loop.)
  const neededTokens = Math.ceil(tokens / 100) * 100;
  const purposeArg =
    typeof args.purpose === "string" ? args.purpose.trim() : undefined;
  const upperCap =
    purposeArg === "explore" ? MAX_TOKEN_CAP_EXPLORE : MAX_TOKEN_CAP;
  const cappedBudget = Math.min(neededTokens, upperCap);
  const requestedBudget =
    typeof args.token_budget === "number" && args.token_budget > 0
      ? Math.floor(args.token_budget)
      : null;

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
  const isFetchUrl = toolName === "fetch_url";
  const promptArg =
    typeof args.prompt === "string" && args.prompt.trim().length > 0
      ? (args.prompt as string)
      : null;
  if (entityArg) {
    // Entity is already the narrowest selector. Don't tell the caller to
    // narrow further by entity — they did.
    reason = "entity_too_large";
    hintTail = `pass token_budget:${cappedBudget} or read in offset/limit chunks`;
  } else if (hasLimit || hasOffset) {
    // Already paginated; suggest a smaller window AND the budget bump. Shrink
    // the limit in proportion to how far the token count overran the cap.
    reason = "page_too_large";
    const suggestedLimit = hasLimit
      ? Math.max(1, Math.floor((args.limit as number) * (tokenCap / tokens)))
      : null;
    const limitHint = suggestedLimit
      ? `limit:${suggestedLimit}`
      : "smaller limit";
    hintTail = `${limitHint} or token_budget:${cappedBudget}`;
  } else if (isFetchUrl) {
    // fetch_url's narrowing lever is *not* `entity:` — it's `prompt:<words>`
    // (BM25 re-ranks passages by relevance) plus offset/limit pagination.
    // Surface paste-ready values so the agent doesn't need to interpret the
    // hint before retrying.
    reason = "page_too_large";
    const limitGuess = Math.max(5, Math.floor((30 * tokenCap) / tokens));
    hintTail = promptArg
      ? `limit:${limitGuess} (prompt already set — BM25-ranked) or token_budget:${cappedBudget}`
      : `pass prompt:<keywords> to BM25-rank passages, or limit:${limitGuess}, or token_budget:${cappedBudget}`;
  } else if (tokenCap > HARD_TOKEN_CAP) {
    // Budget was already lifted but still overflowed — caller must narrow.
    reason = "narrow_required";
    hintTail = `narrow with entity:<name> or limit:<n> (token_budget=${tokenCap} already lifted)`;
  } else {
    reason = "too_large";
    hintTail = `narrow with entity:<name>/limit:<n> or token_budget:${cappedBudget}`;
  }

  // T1.3/T1.4: cache the full original keyed by content hash so the agent can
  // pull back ONLY the slice it needs (O(slice)) via a cache_ref retrieval,
  // instead of re-requesting the whole payload at a larger token_budget and
  // re-paying every token. The cache_ref marker REPLACES the silent drop on
  // this path only — the existing too_large body + token-budget hint stay, so
  // a cache miss still falls back to today's recompute behavior.
  const cacheRef = getSharedReversibleCache().put(serialized, {
    file: typeof args.file_path === "string" ? args.file_path : undefined,
  });

  const oversize: Record<string, unknown> = {
    status: "too_large",
    reason,
    bytes: serialized.length,
    tokens,
    cap_tokens: tokenCap,
    needed_tokens: neededTokens,
    suggested_token_budget: cappedBudget,
    tool: toolName,
    cache_ref: cacheRef,
  };
  if (requestedBudget !== null) {
    oversize.requested_token_budget = requestedBudget;
  }
  if (entityArg) {
    oversize.entity = entityArg;
  }
  // Cache-ref marker: the reversible-retrieval next-action (concrete numbers,
  // named tool, imperative — obeys the nudge-writing rules; buildCacheMarker
  // owns the wording so it stays byte-stable for identical input).
  const cacheMarker = buildCacheMarker({
    hash: cacheRef,
    droppedBytes: serialized.length,
  });
  const overHint = `ur|${toWireTag("pg")} ${toolName} ${tokens}tok>${tokenCap}tok — ${hintTail}\n${cacheMarker}`;
  // The cached original is the whole payload; the slice the agent retrieves is
  // what it actually pays for on the follow-up. Record this as a `compress`
  // event carrying the cache_ref so a later `retrieve` row pairs back to it.
  const metrics: ReversibleCompressionFields = {
    event_kind: "compress",
    mechanism: "wire_cap",
    cache_ref: cacheRef,
    original_tokens: tokens,
    delivered_tokens: estimateTokenCount(JSON.stringify(oversize)),
  };
  return { body: oversize, pageHint: overHint, metrics };
}
