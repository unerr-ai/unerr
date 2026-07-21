/**
 * Prefix / KV-cache stability — deterministic ordering helpers (Sprint 2,
 * T2.2 + T2.3-helper of the reversible-compression plan).
 *
 * Provider prompt caches need an EXACT prefix match: one differing token near
 * the start busts the cached (≈10× cheaper) input tokens. So every block unerr
 * injects into the agent's context must be byte-stable for identical inputs
 * across turns, and the static (cacheable) region must precede the volatile
 * (per-turn) region.
 *
 * This module is the pure ordering contract those guarantees rest on. It is the
 * canonical encoding of the total order documented in
 * `.internal/roadmap/S2_PREFIX_AUDIT.md` (§3). Wired live from
 * `conventions-client.ts` (conventions) and `response-envelope.ts`
 * (`ur|<tag>` lines).
 *
 * HARD CONTRACT (enforced by `prefix-order.test.ts`):
 *   - Pure: no I/O, no clock (`Date`/`Date.now`), no `Math.random`, no module
 *     state. Same input → same output, every call.
 *   - All sorts are non-mutating (operate on a copy) and total (no equal-key
 *     pair is left in input order — every comparison falls through to a stable
 *     final tiebreaker), so a shuffled input yields the one canonical order.
 *   - No float, clock, or random field is ever used as an order key.
 */

/** A `ur|<tag>` signal line, ordered by fixed priority bucket then body text. */
export interface OrderableTag {
  /** Wire tag (`act` | `ctx` | `rsk` | `fct`) or any other / generic. */
  tag: string;
  /** The signal body text (the part after `ur|<tag> `). */
  body: string;
}

/** A detected convention, ordered by file path → name (NOT by adherence). */
export interface OrderableConvention {
  name: string;
  /** Structural key; either `file_path` or `path` may carry it. */
  file_path?: string;
  path?: string;
}

/** A block in the injected prefix, partitioned into stable vs volatile. */
export interface PrefixBlock {
  /** Block category, e.g. `legend` | `conventions` | `notes` | `counts`. */
  kind: string;
  /** Rendered text of the block. */
  text: string;
  /** Explicit volatility flag; wins over field/kind heuristics when set. */
  volatile?: boolean;
  /** Optional per-turn fields carried with the block (clock/count detection). */
  fields?: Record<string, unknown>;
}

/**
 * Fixed priority buckets for `ur|<tag>` lines, most-actionable first. Mirrors
 * the 14→4 consolidation in `response-envelope.ts` (act/ctx/rsk/fct). Any tag
 * not listed (the generic `ur|` line, test fixtures) sorts last.
 */
const TAG_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  act: 0,
  ctx: 1,
  rsk: 2,
  fct: 3,
});
const TAG_PRIORITY_FALLBACK = 4;

/** Kinds that are inherently per-turn and belong in the volatile region. */
const VOLATILE_KINDS: ReadonlySet<string> = new Set([
  "notes",
  "counts",
  "telemetry",
]);

/**
 * Field names that signal a per-turn / non-deterministic value. A block that
 * carries any of these is volatile — it must never sit in the cacheable region.
 * Kept lowercase; matching is case-insensitive on the field name.
 */
const VOLATILE_FIELD_NAMES: ReadonlySet<string> = new Set([
  "timestamp",
  "latency_ms",
  "latency",
  "runid",
  "run_id",
  "count",
  "ts",
  "now",
  "random",
]);

/** Byte-wise ascending string compare (locale-independent, deterministic). */
function cmpStr(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Deterministic total order for `ur|<tag>` lines: fixed priority bucket
 * (act → ctx → rsk → fct → generic) then body text. Putting the highest
 * priority first makes the downstream `MAX_SIGNAL_LINES` cap keep the same
 * highest-priority lines for the same input every turn. Non-mutating.
 */
export function orderTags<T extends OrderableTag>(tags: readonly T[]): T[] {
  return [...tags].sort((a, b) => {
    const ra = TAG_PRIORITY[a.tag] ?? TAG_PRIORITY_FALLBACK;
    const rb = TAG_PRIORITY[b.tag] ?? TAG_PRIORITY_FALLBACK;
    if (ra !== rb) return ra - rb;
    const byBody = cmpStr(a.body, b.body);
    if (byBody !== 0) return byBody;
    // Total-order fallback: tag string itself, so unknown tags with equal
    // bodies still sort deterministically.
    return cmpStr(a.tag, b.tag);
  });
}

/**
 * Deterministic total order for detected conventions: file path → name. The
 * `adherence_rate` float is deliberately NOT an order key (it re-computes on
 * re-index and would bust the prefix). Upstream may still pick top-N by
 * adherence; this fixes the emitted byte order. Non-mutating.
 */
export function orderConventions<T extends OrderableConvention>(
  convs: readonly T[]
): T[] {
  return [...convs].sort((a, b) => {
    const pa = a.file_path ?? a.path ?? "";
    const pb = b.file_path ?? b.path ?? "";
    const byPath = cmpStr(pa, pb);
    if (byPath !== 0) return byPath;
    return cmpStr(a.name, b.name);
  });
}

/** True when a block carries any per-turn (clock/count/run) field. */
function hasVolatileField(block: PrefixBlock): boolean {
  if (!block.fields) return false;
  for (const key of Object.keys(block.fields)) {
    if (VOLATILE_FIELD_NAMES.has(key.toLowerCase())) return true;
  }
  return false;
}

/** True when a block must sit in the volatile (per-turn) region. */
function isVolatileBlock(block: PrefixBlock): boolean {
  if (block.volatile === true) return true;
  if (VOLATILE_KINDS.has(block.kind)) return true;
  return hasVolatileField(block);
}

/**
 * Partition injected blocks into the stable (cacheable, emitted first) region
 * and the volatile (per-turn, append-only) region. Returns stable-first; each
 * side preserves the caller's relative order (the within-side canonical order
 * is the job of `orderTags`/`orderConventions`). Pure: no clock,
 * no I/O, no mutation of the input.
 *
 * Invariant the test pins: no block carrying a clock/run/count field (or marked
 * volatile, or of a per-turn kind) ever lands in the stable partition.
 */
export function splitStableVolatile(blocks: readonly PrefixBlock[]): {
  stable: PrefixBlock[];
  volatile: PrefixBlock[];
} {
  const stable: PrefixBlock[] = [];
  const volatile: PrefixBlock[] = [];
  for (const block of blocks) {
    if (isVolatileBlock(block)) volatile.push(block);
    else stable.push(block);
  }
  return { stable, volatile };
}
