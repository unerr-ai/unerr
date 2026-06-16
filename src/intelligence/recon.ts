/**
 * Recon composite — Sprint 1 (R1 + R2 + R3).
 *
 * The token-overhead research (`.internal/research/tool-call-token-overhead.md`)
 * found that unerr's cost vs no-unerr is dominated by *round-trip amplification*:
 * every separate tool call re-bills the whole accumulated prefix
 * (cache_read ≈ round-trips × prefix). The dominant lever is cutting the number
 * of round-trips, not the transport. A typical "before I edit X" turn fans out
 * into 4–5 sequential calls — recall_notes → search_code → get_references →
 * get_conventions (+ drift) — each one a separate model round-trip.
 *
 * `composeRecon` collapses that fan-out into ONE call. Given a prompt it runs
 * the discovery sequence *server-side* (or inside a single `unerr recon` CLI
 * subprocess), merges the results, dedupes, ranks by actionability, and trims
 * the bundle under a token budget. The agent pays for one request/response
 * instead of five — same information, ~one fifth the prefix re-billing.
 *
 * This module is deliberately pure: it never touches CozoDB, the proxy, or the
 * UDS socket. The caller injects a `runner(tool, args)` — in the proxy that is
 * `QueryRouter.executeLocal`, in the CLI it is a UDS round-trip, in tests it is
 * a fake. That keeps the orchestration logic (the intellectual core of R1–R3)
 * unit-testable in isolation.
 */

import { byImportanceDesc } from "./importance.js";
import {
  DEFAULT_MCP_SOURCE_TIMEOUT_MS,
  type GatewayRunner,
  type McpSourceSection,
  fetchMcpSources,
  parseWantEntries,
} from "./recon-mcp-sources.js";
import {
  type ShellRunner,
  fetchShellSources,
  parseShellWants,
} from "./recon-shell-sources.js";

/** Runs one underlying tool and returns its raw structured content. */
export type ReconRunner = (
  tool: string,
  args: Record<string, unknown>
) => Promise<unknown>;

/** Estimates the token cost of a piece of structured content. */
export type TokenCounter = (data: unknown) => number;

export interface ReconSection {
  /** The underlying tool/source that produced this section. */
  readonly tool: string;
  /** Short human label, e.g. "Callers of fooBar". */
  readonly title: string;
  /** Raw structured payload (already shrunk if it overflowed the budget). */
  readonly data: unknown;
  /** Estimated token cost of `data` as kept. */
  readonly tokens: number;
  /** Lower = more actionable; kept first when the budget is tight. */
  readonly priority: number;
  /** True when `data` was sliced down to fit the budget. */
  readonly shrunk: boolean;
}

export interface DroppedSection {
  readonly tool: string;
  readonly title: string;
  /**
   * Why the section is absent. Local sections: "budget" (no room left) or
   * "error" (the runner threw). External `want` sources add their own fates:
   * "timeout" (exceeded the per-source cap), "unknown_kind" (no plan for that
   * kind), "not_allowed" (a `shell:` command failed the read-only allowlist).
   * There is no "disabled" — external sources are only fetched when a downstream
   * gateway is actually present, never gated behind a toggle.
   */
  readonly reason:
    | "budget"
    | "error"
    | "timeout"
    | "unknown_kind"
    | "not_allowed";
}

export interface ReconBundle {
  readonly prompt: string;
  /** Salient terms extracted from the prompt and fed to search_code. */
  readonly terms: string[];
  /** The top entity recon locked onto, if search found one. */
  readonly focusKey: string | null;
  readonly focusName: string | null;
  readonly sections: ReconSection[];
  readonly dropped: DroppedSection[];
  readonly totalTokens: number;
  readonly budget: number;
  /** True when at least one section was dropped or shrunk for the budget. */
  readonly truncated: boolean;
}

/**
 * The exact follow-up call that re-fetches a section recon dropped for budget,
 * so the coverage footer is paste-ready instead of advisory. Returns null when
 * the only remedy is a wider budget (recall-only rings carry no direct re-fetch).
 * @sem domain=recon role=nudge
 */
function followUpFor(d: DroppedSection, bundle: ReconBundle): string | null {
  const terms = bundle.terms.join(" ").trim();
  const key = bundle.focusKey ?? bundle.focusName;
  switch (d.tool) {
    case "get_references":
      return key ? `get_references({key:'${key}', direction:'callers'})` : null;
    case "search_code":
      return terms ? `search_code({query:'${terms}'})` : null;
    case "focus_bodies":
      if (key) return `search_code({query:'${key}', include_body:true})`;
      return terms
        ? `search_code({query:'${terms}', include_body:true})`
        : null;
    case "get_conventions":
      return "file_read on the file you will edit (conventions auto-inject)";
    default:
      return null;
  }
}

export interface ReconOptions {
  readonly prompt: string;
  readonly runner: ReconRunner;
  /**
   * Whole-bundle token budget. Default 4000 — wide enough to inline the focus
   * entities' verbatim bodies (Phase 1) so the agent edits without a read
   * fan-out, still small enough that one recon beats 5 separate round-trips.
   * Bodies are capped to ~50% of this so callers/notes are never starved.
   */
  readonly budget?: number;
  /** Token estimator. Default: JSON byte length / 4. */
  readonly countTokens?: TokenCounter;
  /** Max callers/callees pulled for the focus entity. Default 15. */
  readonly maxReferences?: number;
  /** Max search hits considered. Default 10. */
  readonly searchLimit?: number;
  /**
   * Verbosity — Anthropic's canonical `response_format` knob. 'detailed' inlines
   * the focus entities' verbatim bodies (Phase 1, the edit path); 'concise' omits
   * them (orientation / large sweeps), saving the body fetches and their tokens.
   * Default 'detailed' — front-loading the edit is the common case.
   */
  readonly responseFormat?: "concise" | "detailed";
  /**
   * Agent-declared external sources (Option A) — closed-vocab tokens like
   * "postgres:orders" or "github:pr/45". `composeRecon` fans out to each through
   * the injected `mcpSources` gateway and folds the results in as the lowest-
   * priority sections (kept only after every code ring). The 'code' kind is
   * ignored here — it is served by the local rings. Parsed by `parseWantEntries`.
   */
  readonly want?: string[];
  /**
   * Speculative expansion (E2). When true and a focus entity with callers is
   * found, pre-inline the verbatim bodies of the top callers — the exact sites
   * the agent edits next when changing a signature — as a lowest-priority,
   * budget-trimmed ring. Absorbs the "update every caller" read fan-out the
   * blast-radius gate would otherwise force. Default false (off): the bodies are
   * only worth their tokens when the edit actually touches callers.
   */
  readonly expand?: boolean;
  /**
   * Downstream-MCP gateway for the `want` fan-out. Injected by the caller so
   * this module stays pure. Its mere PRESENCE is the capability signal — the
   * caller supplies it only when a real downstream gateway exists, and omits it
   * otherwise. There is no enable/disable toggle: when absent, the `want` fan-out
   * is simply not walked (it runs on the user's machine — nothing to flip).
   */
  readonly mcpSources?: {
    readonly runner: GatewayRunner;
    readonly timeoutMs?: number;
  };
  /**
   * Read-only shell executor for the `shell:<cmd>` want kind (E2). Same
   * presence-is-capability discipline as `mcpSources`: injected only when the
   * caller has a safe, allowlist-guarded executor. When absent, `shell:` wants
   * degrade to `dropped` and nothing runs. The module validates every command
   * (read-only git only, no metacharacters) before this runner sees it.
   */
  readonly shellSources?: {
    readonly runner: ShellRunner;
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
  };
}

const DEFAULT_BUDGET = 4000;
const DEFAULT_MAX_REFERENCES = 15;
const DEFAULT_SEARCH_LIMIT = 10;

/** Max focus entities whose verbatim bodies are inlined (Phase 1). */
const MAX_FOCUS_BODIES = 4;
/** Fraction of the whole-bundle budget the inlined bodies may claim. */
const FOCUS_BODY_BUDGET_FRACTION = 0.5;
/** Per-entity body token cap floor/ceiling (research: ~400–800 tok/entity). */
const MIN_BODY_TOKENS = 300;
const MAX_BODY_TOKENS = 800;
/** Max caller bodies pre-inlined by the speculative `expand` ring (E2). */
const EXPAND_MAX_CALLERS = 3;
/** Per-caller body token cap for the expand ring — tighter than focus bodies. */
const EXPAND_BODY_TOKENS = 400;
/**
 * Thin-bundle value floor (decision D6). When the non-body content (notes +
 * callers + entities + conventions) would total under this many tokens — the
 * new/sparse-repo case the audit saw return ~60 tokens — recon force-inlines
 * the top focus body even in 'concise' mode, so the tool never hands back a
 * near-empty bundle that teaches the agent it's useless.
 */
const THIN_BUNDLE_FLOOR_TOKENS = 300;

/**
 * Search width recon uses once the task classifies as a large sweep — wider than
 * the default so the digest captures the whole spread the agent must reason
 * about. Single source of truth: both `unerr recon` (CLI) and the warm
 * `unerr_context` MCP tool import this, so the two paths classify identically.
 */
export const SWEEP_SEARCH_LIMIT = 25;

/**
 * English + code stopwords that never help a code search. Kept small and
 * intent-focused — we strip filler verbs the prompt always has ("add",
 * "update", "fix") so the salient nouns (the entity/file names) dominate.
 */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "into",
  "from",
  "by",
  "at",
  "as",
  "is",
  "are",
  "be",
  "this",
  "that",
  "it",
  "its",
  "i",
  "we",
  "you",
  "do",
  "does",
  "can",
  "could",
  "should",
  "would",
  "will",
  "please",
  "lets",
  "let",
  "make",
  "made",
  "use",
  "using",
  "via",
  "then",
  "add",
  "added",
  "adding",
  "update",
  "updated",
  "fix",
  "fixed",
  "change",
  "changed",
  "implement",
  "create",
  "new",
  "safely",
  "safe",
  "also",
  "all",
  "their",
  "them",
  "so",
  "if",
  "when",
  "what",
  "how",
  "why",
  "where",
  "which",
  "callers",
  "caller",
  "code",
  "file",
  "files",
  "function",
  "method",
  "class",
]);

/**
 * Extract salient search terms from a free-text prompt. Keeps identifiers
 * (camelCase, snake_case, dotted paths, quoted strings) verbatim and drops
 * stopwords + sub-3-char noise. Order-preserving, deduped, capped.
 */
export function extractQueryTerms(prompt: string, max = 8): string[] {
  if (!prompt) return [];
  // Pull quoted spans and backticked code verbatim first — they're almost
  // always the literal symbol the user means.
  const verbatim: string[] = [];
  const quoteRe = /[`'"]([^`'"]{2,})[`'"]/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex drain
  while ((m = quoteRe.exec(prompt)) !== null) {
    const inner = m[1]?.trim();
    if (inner) verbatim.push(inner);
  }

  const tokens = prompt
    .replace(/[`'"]/g, " ")
    // Keep `-` so hyphenated file names (session-stats.ts) stay one token.
    .split(/[^A-Za-z0-9_./-]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  for (const v of verbatim) push(v);
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (STOPWORDS.has(t.toLowerCase())) continue;
    // Pure lowercase common words with no code shape are usually filler; keep
    // anything that looks like an identifier (has _, ., digit, or a capital).
    const looksLikeIdentifier = /[._A-Z0-9]/.test(t);
    if (!looksLikeIdentifier && t.length < 5) continue;
    push(t);
  }

  return out.slice(0, max);
}

/** Default token estimator — JSON byte length / 4 (BPE-ish). */
export function defaultCountTokens(data: unknown): number {
  if (data == null) return 0;
  const s = typeof data === "string" ? data : JSON.stringify(data);
  return Math.ceil(s.length / 4);
}

/**
 * Shape-tolerant extraction of the top entity from a search_code result.
 * Handles the raw array shape (`[{key,name,...}]`) and common envelope shapes
 * (`{entities|results|hits: [...]}`).
 */
export function pickTopEntity(
  searchResult: unknown
): { key: string; name: string | null } | null {
  const arr = asEntityArray(searchResult);
  if (!arr.length) return null;
  const top = arr[0] as Record<string, unknown>;
  const key =
    (top.key as string | undefined) ?? (top.entity_key as string | undefined);
  if (!key) return null;
  return { key, name: (top.name as string | undefined) ?? null };
}

/** Path looks like test scaffolding — deprioritized as a focus entity. */
const TEST_PATH_RE = /(?:^|\/)__tests__\/|\.test\.|\.spec\./;

/**
 * Rank search hits as focus-entity candidates for the blast-radius section.
 * `pickTopEntity` (kept for single-hit callers) takes row 0 blindly — under
 * flat relevance scores that row is usually a test block with ZERO callers,
 * so the callers section silently vanished from every bundle. Ranking:
 *   +2 the entity's file is named verbatim in the prompt (the agent told us
 *      exactly where it's working — that file's entities ARE the focus)
 *   -1 the entity lives in test scaffolding (tests call things; almost
 *      nothing calls tests, so they make degenerate blast-radius roots)
 * Ties keep search order. Sort is stable, so equal-scored rows stay ranked
 * by relevance.
 */
export function rankFocusEntities(
  searchResult: unknown,
  prompt: string
): Array<{ key: string; name: string | null }> {
  const arr = asEntityArray(searchResult);
  const scored: Array<{
    key: string;
    name: string | null;
    score: number;
  }> = [];
  for (const row of arr) {
    const o = row as Record<string, unknown>;
    const key =
      (o.key as string | undefined) ?? (o.entity_key as string | undefined);
    if (!key) continue;
    const filePath = (o.file_path as string | undefined) ?? "";
    let score = 0;
    if (filePath && prompt.includes(filePath)) score += 2;
    if (TEST_PATH_RE.test(filePath)) score -= 1;
    scored.push({
      key,
      name: (o.name as string | undefined) ?? null,
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ key, name }) => ({ key, name }));
}

function asEntityArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const field of ["entities", "results", "hits", "rows"]) {
      if (Array.isArray(o[field])) return o[field] as unknown[];
    }
  }
  return [];
}

/**
 * Drop entities from the search result whose verbatim body is already inlined as
 * a focus body, so the "Entities" overview never re-pays tokens for a row the
 * bundle already carries in full. Preserves the original container shape (bare
 * array or {entities|results|hits|rows} wrapper).
 * @sem domain=recon role=dedup
 */
function dedupeSearchAgainstBodies(
  search: unknown,
  focusBodies: FocusBody[] | undefined
): unknown {
  if (!focusBodies?.length) return search;
  const bodyKeys = new Set(
    focusBodies.map((b) => b.key).filter((k): k is string => !!k)
  );
  if (!bodyKeys.size) return search;
  const filterArr = (arr: unknown[]): unknown[] =>
    arr.filter((e) => {
      const k =
        e && typeof e === "object"
          ? (e as Record<string, unknown>).key
          : undefined;
      return typeof k !== "string" || !bodyKeys.has(k);
    });
  if (Array.isArray(search)) return filterArr(search);
  if (search && typeof search === "object") {
    const o = search as Record<string, unknown>;
    for (const field of ["entities", "results", "hits", "rows"]) {
      if (Array.isArray(o[field])) {
        return { ...o, [field]: filterArr(o[field] as unknown[]) };
      }
    }
  }
  return search;
}

/**
 * Greedily shrink list-bearing structured data until it fits `budget` tokens.
 * Repeatedly slices the longest array in the payload in half. Returns the
 * possibly-shrunk data and whether anything was cut. Never mutates the input.
 */
export function shrinkToBudget(
  data: unknown,
  budget: number,
  countTokens: TokenCounter
): { data: unknown; shrunk: boolean } {
  if (countTokens(data) <= budget) return { data, shrunk: false };

  // Deep clone via JSON so we never mutate the caller's object.
  let clone: unknown;
  try {
    clone = JSON.parse(JSON.stringify(data));
  } catch {
    return { data, shrunk: false };
  }

  let shrunk = false;
  // Bounded loop — each pass strictly shrinks the largest array, so it
  // terminates when every array is empty or the budget is met.
  for (let guard = 0; guard < 64; guard++) {
    if (countTokens(clone) <= budget) break;
    const longest = findLongestArray(clone);
    if (!longest || longest.arr.length === 0) break;
    const keep = Math.max(1, Math.floor(longest.arr.length / 2));
    if (keep >= longest.arr.length) {
      // Can't split further (length 1) — drop it entirely as a last resort.
      longest.arr.length = 0;
    } else {
      // T3.3: when the longest array holds graph entities, reorder it
      // highest-importance-first IN PLACE before dropping the tail, so the
      // survivors are the load-bearing hubs rather than a positional head.
      // Non-entity arrays keep their order (orderByImportanceInPlace no-ops).
      orderByImportanceInPlace(longest.arr);
      longest.arr.length = keep;
    }
    shrunk = true;
  }
  return { data: clone, shrunk };
}

/**
 * If `arr`'s elements carry graph-importance columns (`fan_in` / `fan_out` /
 * `risk_level`), reorder them highest-importance-first in place so a following
 * tail-drop keeps the hubs (T3.3). No-op when no element has those columns, so
 * arbitrary arrays (strings, conventions) keep their existing order.
 * Deterministic — ties break on the entity key.
 */
function orderByImportanceInPlace(arr: unknown[]): void {
  const hasSignal = arr.some((el) => {
    if (typeof el !== "object" || el === null) return false;
    const o = el as Record<string, unknown>;
    return (
      typeof o.fan_in === "number" ||
      typeof o.fan_out === "number" ||
      typeof o.risk_level === "string"
    );
  });
  if (!hasSignal) return;
  const ordered = byImportanceDesc(arr, (el) => {
    if (typeof el !== "object" || el === null) return {};
    const o = el as Record<string, unknown>;
    return {
      fan_in: typeof o.fan_in === "number" ? o.fan_in : undefined,
      fan_out: typeof o.fan_out === "number" ? o.fan_out : undefined,
      risk_level: typeof o.risk_level === "string" ? o.risk_level : undefined,
      key: typeof o.key === "string" ? o.key : undefined,
    };
  });
  for (let i = 0; i < ordered.length; i++) arr[i] = ordered[i];
}

/** Find the array with the most elements anywhere in a structured value. */
function findLongestArray(root: unknown): { arr: unknown[] } | null {
  let best: unknown[] | null = null;
  const stack: unknown[] = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      if (!best || cur.length > best.length) best = cur;
      for (const el of cur) if (el && typeof el === "object") stack.push(el);
    } else if (cur && typeof cur === "object") {
      for (const val of Object.values(cur as Record<string, unknown>)) {
        if (val && typeof val === "object") stack.push(val);
      }
    }
  }
  return best ? { arr: best } : null;
}

interface PlannedStep {
  tool: string;
  args: Record<string, unknown>;
  title: string;
  priority: number;
  /** Non-empty section predicate — drop quietly if the runner returned nothing. */
  isEmpty: (data: unknown) => boolean;
}

function notesEmpty(data: unknown): boolean {
  if (data == null) return true;
  if (Array.isArray(data)) return data.length === 0;
  const o = data as Record<string, unknown>;
  if (Array.isArray(o.notes)) return o.notes.length === 0;
  return false;
}

function searchEmpty(data: unknown): boolean {
  return asEntityArray(data).length === 0;
}

function referencesEmpty(data: unknown): boolean {
  if (data == null) return true;
  if (Array.isArray(data)) return data.length === 0;
  const o = data as Record<string, unknown>;
  if (Array.isArray(o.references)) return o.references.length === 0;
  return false;
}

function conventionsEmpty(data: unknown): boolean {
  if (data == null) return true;
  const o = data as Record<string, unknown>;
  const lists = [o.naming, o.import_direction, o.structure, o.other];
  return lists.every((l) => !Array.isArray(l) || l.length === 0);
}

/**
 * One inlined focus-entity source block. Carries the verbatim body the agent
 * is about to edit (the token-overhead audit found every recon call was chased
 * by 2–5 file_reads of these exact entities), plus the file:line range so the
 * read-suppression manifest (D5) can tell the agent NOT to re-read it.
 */
export interface FocusBody {
  readonly key: string | null;
  readonly name: string | null;
  readonly file: string | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
  /** Verbatim source (D4 — never paraphrased). May be a server-truncated slice. */
  readonly body: string;
  /** True when the runner truncated the body to the per-entity token cap. */
  readonly truncated: boolean;
}

function focusBodiesEmpty(data: unknown): boolean {
  return !Array.isArray(data) || data.length === 0;
}

/**
 * Dig the entity bearing a `body`/`body_preview` out of whatever envelope
 * `search_code({detail:true,include_body:true})` returned (raw entity object,
 * `{entity:{…}}`, or an `{entities|results|hits|rows:[…]}` list). Shape-tolerant
 * by house style — the runner shape differs between executeRaw and the fakes.
 */
function findEntityWithBody(raw: unknown): Record<string, unknown> | null {
  if (raw == null || typeof raw !== "object") return null;
  const direct = raw as Record<string, unknown>;
  const hasBody = (o: Record<string, unknown>): boolean =>
    typeof o.body === "string" || typeof o.body_preview === "string";
  if (hasBody(direct)) return direct;
  if (direct.entity && typeof direct.entity === "object") {
    const e = direct.entity as Record<string, unknown>;
    if (hasBody(e)) return e;
  }
  for (const el of asEntityArray(raw)) {
    if (
      el &&
      typeof el === "object" &&
      hasBody(el as Record<string, unknown>)
    ) {
      return el as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * Pull the top caller keys from a get_references result for the speculative
 * `expand` ring (E2). References shape: {references:[{key,name,...}], ...}.
 * @sem domain=recon role=expand
 */
function topCallerKeys(
  references: unknown,
  max: number
): Array<{ key: string; name: string | null }> {
  if (!references || typeof references !== "object") return [];
  const arr = (references as Record<string, unknown>).references;
  if (!Array.isArray(arr)) return [];
  const out: Array<{ key: string; name: string | null }> = [];
  for (const r of arr) {
    if (r && typeof r === "object") {
      const rec = r as Record<string, unknown>;
      if (typeof rec.key === "string") {
        out.push({
          key: rec.key,
          name: typeof rec.name === "string" ? rec.name : null,
        });
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

/** Parse one `search_code` detail result into a FocusBody, or null if it carried no source. */
function extractFocusBody(raw: unknown): FocusBody | null {
  const e = findEntityWithBody(raw);
  if (!e) return null;
  const body =
    typeof e.body === "string"
      ? e.body
      : typeof e.body_preview === "string"
        ? e.body_preview
        : "";
  if (!body.trim()) return null;
  return {
    key: (e.key as string) ?? (e.entity_key as string) ?? null,
    name: (e.name as string) ?? null,
    file: (e.file_path as string) ?? (e.file as string) ?? null,
    startLine: typeof e.start_line === "number" ? e.start_line : null,
    endLine: typeof e.end_line === "number" ? e.end_line : null,
    body,
    truncated: e._truncated != null || e._preview != null,
  };
}

/** Extract the `{tags:[…]}` (or bare array) shape the domain_tags runner returns. */
function domainTagsOf(data: unknown): Array<{ domain: string; count: number }> {
  if (data == null) return [];
  const raw = Array.isArray(data)
    ? data
    : Array.isArray((data as Record<string, unknown>).tags)
      ? ((data as Record<string, unknown>).tags as unknown[])
      : [];
  const out: Array<{ domain: string; count: number }> = [];
  for (const t of raw) {
    if (t == null || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    const domain = typeof o.domain === "string" ? o.domain : "";
    const count = Number(o.count ?? 0);
    if (domain === "") continue;
    out.push({ domain, count });
  }
  return out;
}

function domainTagsEmpty(data: unknown): boolean {
  return domainTagsOf(data).length === 0;
}

/**
 * Render the active domain-tag vocabulary as one compact "reuse before invent"
 * line: `auth (12), payments (8), graph-indexing (5)`. Empty → "" (caller skips
 * the section). Same line in both the full and digest renders — it's already flat.
 */
function formatDomainTags(data: unknown): string {
  const tags = domainTagsOf(data);
  if (!tags.length) return "";
  return `reuse before inventing a domain tag: ${tags
    .map((t) => `${t.domain} (${t.count})`)
    .join(", ")}`;
}

/**
 * §5.2 promotion threshold mirrored locally — recon stays pure (no
 * annotation-indexer import). A domain under this many entities is provisional.
 * Must equal `PROMOTION_THRESHOLD` in annotation-indexer.ts.
 */
const VOCAB_PROMOTION_THRESHOLD = 3;

/** Parse the `{canonical,provisional,merge}` shape the vocab_nudges runner returns. */
function vocabNudgesOf(data: unknown): {
  provisional: Array<{ domain: string; count: number }>;
  merge: Array<{
    from: string;
    fromCount: number;
    into: string;
    intoCount: number;
  }>;
} {
  const o = (data ?? {}) as Record<string, unknown>;
  const provisional: Array<{ domain: string; count: number }> = [];
  for (const t of Array.isArray(o.provisional) ? o.provisional : []) {
    if (t == null || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    const domain = typeof r.domain === "string" ? r.domain : "";
    if (domain === "") continue;
    provisional.push({ domain, count: Number(r.count ?? 0) });
  }
  const merge: Array<{
    from: string;
    fromCount: number;
    into: string;
    intoCount: number;
  }> = [];
  for (const m of Array.isArray(o.merge) ? o.merge : []) {
    if (m == null || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    const from = typeof r.from === "string" ? r.from : "";
    const into = typeof r.into === "string" ? r.into : "";
    if (from === "" || into === "") continue;
    merge.push({
      from,
      fromCount: Number(r.fromCount ?? 0),
      into,
      intoCount: Number(r.intoCount ?? 0),
    });
  }
  return { provisional, merge };
}

function vocabNudgesEmpty(data: unknown): boolean {
  const { provisional, merge } = vocabNudgesOf(data);
  return provisional.length === 0 && merge.length === 0;
}

/**
 * Render the vocabulary nudges (§5.2 / §6.4): near-duplicate consolidation
 * hints first (the actionable rename), then the provisional-tag list (under the
 * promotion threshold — promote by reuse or rename). Empty → "" (caller skips
 * the section). Flat already — same line in full and digest renders.
 */
function formatVocabNudges(data: unknown): string {
  const { provisional, merge } = vocabNudgesOf(data);
  const lines: string[] = [];
  if (merge.length) {
    lines.push(
      `domain tag sprawl — rename to consolidate: ${merge
        .map((m) => `${m.from} (${m.fromCount}) → ${m.into} (${m.intoCount})`)
        .join("; ")}`
    );
  }
  if (provisional.length) {
    lines.push(
      `provisional domain tags (under ${VOCAB_PROMOTION_THRESHOLD} entities — promote by reuse or rename): ${provisional
        .map((t) => `${t.domain} (${t.count})`)
        .join(", ")}`
    );
  }
  return lines.join("\n");
}

/**
 * Run the discovery sequence as one composite. Steps that throw are recorded
 * as dropped (reason "error") and never abort the bundle — recon degrades to
 * whatever it could gather, which is still strictly better than nothing.
 */
export async function composeRecon(opts: ReconOptions): Promise<ReconBundle> {
  const {
    prompt,
    runner,
    budget = DEFAULT_BUDGET,
    countTokens = defaultCountTokens,
    maxReferences = DEFAULT_MAX_REFERENCES,
    searchLimit = DEFAULT_SEARCH_LIMIT,
    responseFormat = "detailed",
    want,
    expand = false,
    mcpSources,
    shellSources,
  } = opts;

  const terms = extractQueryTerms(prompt);
  const dropped: DroppedSection[] = [];

  // Agent-declared external `want` fan-out, kicked off in parallel with the
  // local discovery so it adds no serial latency. It runs ONLY when the caller
  // injected a real `mcpSources` gateway — that presence IS the capability
  // signal, there is no toggle. With no gateway the fan-out is silently skipped.
  // Never throws, each source isolated. The 'code' kind is served by the local
  // rings, so it is filtered out here.
  const mcpSourcesP: Promise<McpSourceSection[]> = (async () => {
    if (!want || want.length === 0 || !mcpSources) return [];
    const entries = parseWantEntries(want).filter((e) => e.kind !== "code");
    if (entries.length === 0) return [];
    const result = await fetchMcpSources(entries, mcpSources.runner, {
      timeoutMs: mcpSources.timeoutMs ?? DEFAULT_MCP_SOURCE_TIMEOUT_MS,
    });
    for (const d of result.dropped) {
      dropped.push({ tool: "want_source", title: d.title, reason: d.reason });
    }
    return result.sections;
  })();

  // Read-only shell `want` fan-out (E2), same presence-is-capability discipline:
  // runs ONLY when a `shellSources` executor is injected. Each command is
  // validated (read-only git, no metacharacters) inside fetchShellSources before
  // the executor sees it, and isolated behind a per-command timeout + cap.
  const shellSourcesP: Promise<
    Awaited<ReturnType<typeof fetchShellSources>>["sections"]
  > = (async () => {
    if (!want || want.length === 0 || !shellSources) return [];
    const wants = parseShellWants(want);
    if (wants.length === 0) return [];
    const result = await fetchShellSources(wants, shellSources.runner, {
      ...(shellSources.timeoutMs !== undefined
        ? { timeoutMs: shellSources.timeoutMs }
        : {}),
      ...(shellSources.maxBytes !== undefined
        ? { maxBytes: shellSources.maxBytes }
        : {}),
    });
    for (const d of result.dropped) {
      dropped.push({ tool: "shell_source", title: d.title, reason: d.reason });
    }
    return result.sections;
  })();

  const safeRun = async (
    tool: string,
    args: Record<string, unknown>,
    title: string
  ): Promise<unknown | undefined> => {
    try {
      return await runner(tool, args);
    } catch {
      dropped.push({ tool, title, reason: "error" });
      return undefined;
    }
  };

  // Phase 1 — independent calls fire together: notes, conventions, and the
  // entity search. references depends on the search result, so it waits.
  const notesP = safeRun("unerr_recall_notes", { prompt }, "Anchored notes");
  const conventionsP = safeRun("get_conventions", {}, "Conventions");
  // Layer 8 §5.4 — the active domain-tag vocabulary ("reuse before invent").
  const domainTagsP = safeRun("domain_tags", {}, "Active domain tags");
  // Layer 8 §5.2 / §6.4 — vocabulary nudges (sprawl merge + provisional tags).
  const vocabNudgesP = safeRun("vocab_nudges", {}, "Vocabulary nudges");
  const searchP =
    terms.length > 0
      ? safeRun(
          "search_code",
          { query: terms.join(" "), limit: searchLimit },
          "Entities"
        )
      : Promise.resolve(undefined);

  const [notes, conventions, domainTags, vocabNudges, search] =
    await Promise.all([
      notesP,
      conventionsP,
      domainTagsP,
      vocabNudgesP,
      searchP,
    ]);

  // Phase 2 — lock onto a focus entity and pull its blast radius (depth-1).
  // Candidates are ranked (prompt-named file first, test scaffolding last)
  // and probed in order until one actually HAS callers — taking row 0
  // blindly meant a flat-scored test hit with zero callers silently dropped
  // the blast-radius section from every bundle.
  const MAX_FOCUS_PROBES = 3;
  const focusCandidates = rankFocusEntities(search, prompt);
  let focus: { key: string; name: string | null } | null = null;
  let references: unknown | undefined;
  for (const candidate of focusCandidates.slice(0, MAX_FOCUS_PROBES)) {
    const refs = await safeRun(
      "get_references",
      { key: candidate.key, direction: "callers", limit: maxReferences },
      `Callers of ${candidate.name ?? candidate.key}`
    );
    if (refs !== undefined && !referencesEmpty(refs)) {
      focus = candidate;
      references = refs;
      break;
    }
  }
  // No candidate had callers — keep the top-ranked one as the nominal focus
  // (section titles and task-size classification still want a name).
  if (!focus) focus = focusCandidates[0] ?? null;

  // Phase 2b — inline the verbatim source of the top focus entities the agent
  // is about to edit. The token-overhead audit found every recon call was
  // chased by 2–5 file_reads of these exact entities; carrying their bodies
  // collapses that read fan-out into this one call. Bodies are the bundle's
  // irreducible core — kept right after notes in the budget pass and given the
  // primacy render slot (lost-in-the-middle: Liu et al., TACL 2024). Each body
  // is capped so the set stays ≤ ~50% of the budget and never starves callers.
  // 'concise' callers (orientation / large sweeps) skip body inlining entirely —
  // no fetch, no section, no tokens. 'detailed' (default) front-loads the edit.
  // EXCEPT the thin-bundle floor (D6): when the non-body content is sparse
  // (new/sparse repo), 'concise' still inlines the single top body so the call
  // never returns a near-empty bundle. 'detailed' already carries bodies, so the
  // floor is moot there.
  const nonBodyFloorTokens =
    (notes !== undefined ? countTokens(notes) : 0) +
    (references !== undefined ? countTokens(references) : 0) +
    (search !== undefined ? countTokens(search) : 0) +
    (conventions !== undefined ? countTokens(conventions) : 0);
  const thinBundle = nonBodyFloorTokens < THIN_BUNDLE_FLOOR_TOKENS;
  const bodyTargets =
    responseFormat === "concise"
      ? thinBundle
        ? focusCandidates.slice(0, 1)
        : []
      : focusCandidates.slice(0, MAX_FOCUS_BODIES);
  let focusBodies: FocusBody[] | undefined;
  if (bodyTargets.length > 0) {
    const bodyBudget = Math.floor(budget * FOCUS_BODY_BUDGET_FRACTION);
    const perBodyCap = Math.min(
      MAX_BODY_TOKENS,
      Math.max(MIN_BODY_TOKENS, Math.floor(bodyBudget / bodyTargets.length))
    );
    const fetched = await Promise.all(
      bodyTargets.map((c) =>
        safeRun(
          "search_code",
          {
            query: c.key,
            detail: true,
            include_body: true,
            token_budget: perBodyCap,
          },
          `Source of ${c.name ?? c.key}`
        )
      )
    );
    const bodies: FocusBody[] = [];
    for (const raw of fetched) {
      const b = extractFocusBody(raw);
      if (b) bodies.push(b);
    }
    if (bodies.length > 0) focusBodies = bodies;
  }

  // Phase 2c — speculative `expand` ring (E2). When the caller asks for it and a
  // focus entity has callers, pre-inline the verbatim bodies of the top callers:
  // the exact sites the blast-radius gate forces the agent to open and edit next.
  // Carrying them now collapses that read fan-out into this one call. Skips any
  // caller already inlined as a focus body, and is budget-trimmed (lowest local
  // priority) so it never starves the irreducible core.
  let expandBodies: FocusBody[] | undefined;
  if (expand && references !== undefined) {
    const inlined = new Set((focusBodies ?? []).map((b) => b.key));
    const targets = topCallerKeys(references, EXPAND_MAX_CALLERS).filter(
      (c) => !inlined.has(c.key)
    );
    if (targets.length > 0) {
      const fetched = await Promise.all(
        targets.map((c) =>
          safeRun(
            "search_code",
            {
              query: c.key,
              detail: true,
              include_body: true,
              token_budget: EXPAND_BODY_TOKENS,
            },
            `Caller source of ${c.name ?? c.key}`
          )
        )
      );
      const bodies: FocusBody[] = [];
      for (const raw of fetched) {
        const b = extractFocusBody(raw);
        if (b) bodies.push(b);
      }
      if (bodies.length > 0) expandBodies = bodies;
    }
  }

  // Assemble candidate sections in priority order. Anchored notes (the user's
  // own rules) rank first; the focus entity's callers (blast radius — unerr's
  // core safe-change signal) next; then the raw search list and conventions.
  const candidates: Array<PlannedStep & { data: unknown }> = [];
  const add = (
    tool: string,
    title: string,
    priority: number,
    data: unknown | undefined,
    isEmpty: (d: unknown) => boolean
  ) => {
    if (data === undefined) return; // runner errored; already in `dropped`
    if (isEmpty(data)) return; // nothing worth a section
    candidates.push({ tool, title, priority, args: {}, data, isEmpty });
  };

  // Keep-priority (lower = kept first under budget pressure). Notes and focus
  // bodies are the irreducible core; callers next; the rest fills remaining
  // room. Note: this is the BUDGET order, NOT the render order — the renderer
  // re-sorts for the lost-in-the-middle U-curve (bodies first, notes last).
  add("unerr_recall_notes", "Anchored notes", 0, notes, notesEmpty);
  add("focus_bodies", "Focus source", 1, focusBodies, focusBodiesEmpty);
  if (focus) {
    add(
      "get_references",
      `Callers of ${focus.name ?? focus.key}`,
      2,
      references,
      referencesEmpty
    );
  }
  // Precision: an entity already inlined verbatim as a focus body is redundant
  // in the "Entities" overview — drop it so the bundle never double-pays.
  const dedupedSearch = dedupeSearchAgainstBodies(search, focusBodies);
  const dedupedSearchEmpty =
    searchEmpty || asEntityArray(dedupedSearch).length === 0;
  add("search_code", "Entities", 3, dedupedSearch, dedupedSearchEmpty);
  add("get_conventions", "Conventions", 4, conventions, conventionsEmpty);
  add("domain_tags", "Active domain tags", 5, domainTags, domainTagsEmpty);
  add("vocab_nudges", "Vocabulary nudges", 6, vocabNudges, vocabNudgesEmpty);
  // Speculative expand ring (E2) — lowest local priority (after every code ring,
  // before external want sources), trimmed first under budget pressure.
  add(
    "expand_callers",
    "Caller bodies (expand)",
    6.5,
    expandBodies,
    focusBodiesEmpty
  );

  // Fold in the external `want` sources (Phase 3). Each carries its own sinking
  // priority (>= MCP_SOURCE_BASE_PRIORITY = 7) so it is kept only after every
  // code ring, and is non-empty by construction (fetchMcpSources omits failures).
  for (const s of await mcpSourcesP) {
    candidates.push({
      tool: s.tool,
      title: s.title,
      priority: s.priority,
      args: {},
      data: s.data,
      isEmpty: () => false,
    });
  }

  // Read-only shell sources (E2) sink below every MCP source — git history is
  // context, the lowest-priority ring of all.
  for (const s of await shellSourcesP) {
    candidates.push({
      tool: s.tool,
      title: s.title,
      priority: s.priority,
      args: {},
      data: s.data,
      isEmpty: () => false,
    });
  }

  candidates.sort((a, b) => a.priority - b.priority);

  // Budget pass — keep sections by priority; shrink the one that straddles the
  // boundary; drop the rest as "budget".
  const sections: ReconSection[] = [];
  let spent = 0;
  let truncated = false;
  for (const c of candidates) {
    const remaining = budget - spent;
    if (remaining <= 0) {
      dropped.push({ tool: c.tool, title: c.title, reason: "budget" });
      truncated = true;
      continue;
    }
    const cost = countTokens(c.data);
    if (cost <= remaining) {
      sections.push({
        tool: c.tool,
        title: c.title,
        data: c.data,
        tokens: cost,
        priority: c.priority,
        shrunk: false,
      });
      spent += cost;
      continue;
    }
    // Straddles the boundary — try to shrink it into the remaining room.
    const { data: shrunkData, shrunk } = shrinkToBudget(
      c.data,
      remaining,
      countTokens
    );
    if (shrunk && !c.isEmpty(shrunkData)) {
      const shrunkCost = countTokens(shrunkData);
      sections.push({
        tool: c.tool,
        title: c.title,
        data: shrunkData,
        tokens: shrunkCost,
        priority: c.priority,
        shrunk: true,
      });
      spent += shrunkCost;
      truncated = true;
    } else {
      dropped.push({ tool: c.tool, title: c.title, reason: "budget" });
      truncated = true;
    }
  }

  return {
    prompt,
    terms,
    focusKey: focus?.key ?? null,
    focusName: focus?.name ?? null,
    sections,
    dropped,
    totalTokens: spent,
    budget,
    truncated,
  };
}

/** Format `file:start-end` for a focus body (best-effort when lines are unknown). */
function focusBodyRange(b: FocusBody): string {
  if (!b.file) return b.name ?? b.key ?? "?";
  if (b.startLine != null && b.endLine != null) {
    return `${b.file}:${b.startLine}-${b.endLine}`;
  }
  if (b.startLine != null) return `${b.file}:${b.startLine}`;
  return b.file;
}

/** Render the inlined focus-entity bodies — verbatim, fenced, file:line header. */
function formatFocusBodies(data: unknown): string {
  if (!Array.isArray(data)) return "";
  const out: string[] = [];
  for (const raw of data as FocusBody[]) {
    if (!raw || typeof raw.body !== "string" || !raw.body.trim()) continue;
    out.push(`### ${focusBodyRange(raw)}${raw.name ? ` — ${raw.name}` : ""}`);
    out.push("```");
    out.push(raw.body);
    out.push("```");
    if (raw.truncated) {
      const k = raw.key ?? raw.name ?? "";
      out.push(
        `↳ body truncated — full source: search_code({query:"${k}", include_body:true, token_budget:1500})`
      );
    }
  }
  return out.join("\n");
}

/**
 * D5 read-suppression manifest — the recency-slot line naming the exact
 * file:line ranges already inlined, so the agent does NOT spend a round-trip
 * re-reading them. Obeys the CLAUDE.md nudge rules: imperative, named tool,
 * numeric ranges, no deictics. Truncated bodies are excluded (they are partial,
 * so a re-read may be legitimate). Empty when no full bodies were inlined.
 */
function buildReadManifest(bundle: ReconBundle): string {
  // Both the focus bodies and the expand-ring caller bodies are inlined verbatim
  // with file:line headers — neither needs a re-read round-trip.
  const ranges = bundle.sections
    .filter((s) => s.tool === "focus_bodies" || s.tool === "expand_callers")
    .flatMap((s) => (Array.isArray(s.data) ? (s.data as FocusBody[]) : []))
    .filter((b) => b?.file && !b.truncated)
    .map((b) => focusBodyRange(b));
  if (!ranges.length) return "";
  return `ur|fct inlined above — do NOT call file_read/Read on: ${ranges.join(", ")}`;
}

/**
 * Display order for the lost-in-the-middle U-curve (Liu et al., TACL 2024):
 * focus bodies take the primacy slot, load-bearing notes the recency slot, and
 * low-salience material is buried in the middle. Decoupled from the budget
 * keep-priority (which keeps notes + bodies first). Lower = earlier.
 */
const RENDER_RANK: Readonly<Record<string, number>> = {
  focus_bodies: 0,
  expand_callers: 0.5,
  search_code: 1,
  get_references: 2,
  get_conventions: 3,
  domain_tags: 5,
  vocab_nudges: 6,
  unerr_recall_notes: 7,
};
/** Render position for a section tool; unknown (e.g. MCP sources) → mid-bundle. */
function renderRank(tool: string): number {
  return RENDER_RANK[tool] ?? 4;
}

/**
 * Render a recon bundle as compact, agent-readable text for the CLI stdout or
 * the MCP wire. Sections are emitted in salience order (focus bodies first,
 * anchored notes + the read-suppression manifest last) per the lost-in-the-
 * middle U-curve — distinct from the budget keep-priority on `bundle.sections`.
 */
export function renderReconText(bundle: ReconBundle): string {
  const lines: string[] = [];
  lines.push(
    `unerr recon — ${bundle.sections.length} sections, ~${bundle.totalTokens} tokens`
  );
  if (bundle.focusName || bundle.focusKey) {
    lines.push(`focus: ${bundle.focusName ?? bundle.focusKey}`);
  }
  if (bundle.terms.length) lines.push(`terms: ${bundle.terms.join(", ")}`);
  const ordered = [...bundle.sections].sort(
    (a, b) => renderRank(a.tool) - renderRank(b.tool)
  );
  for (const s of ordered) {
    lines.push("");
    lines.push(`## ${s.title}${s.shrunk ? " (trimmed)" : ""}`);
    if (s.tool === "focus_bodies" || s.tool === "expand_callers") {
      lines.push(formatFocusBodies(s.data));
      continue;
    }
    if (s.tool === "domain_tags") {
      lines.push(formatDomainTags(s.data));
      continue;
    }
    if (s.tool === "vocab_nudges") {
      lines.push(formatVocabNudges(s.data));
      continue;
    }
    lines.push(typeof s.data === "string" ? s.data : JSON.stringify(s.data));
  }
  const manifest = buildReadManifest(bundle);
  if (manifest) {
    lines.push("");
    lines.push(manifest);
  }
  if (bundle.dropped.length) {
    const budgetDrops = bundle.dropped.filter((d) => d.reason === "budget");
    if (budgetDrops.length) {
      lines.push("");
      lines.push(
        `omitted for budget — re-run with budget:${bundle.budget * 2} to include, or fetch directly:`
      );
      for (const d of budgetDrops) {
        const call = followUpFor(d, bundle);
        lines.push(call ? `  - ${d.title} → ${call}` : `  - ${d.title}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Count the entities recon's search turned up. Used by the size-gate (Sprint 3,
 * T3.1) to sharpen the task-size verdict with *actual* cardinality once recon
 * has run, and by the large-sweep router (Sprint 4, R6) to decide whether the
 * scan is broad enough to justify pushing it into a subagent.
 */
export function reconEntityCount(bundle: ReconBundle): number {
  const search = bundle.sections.find((s) => s.tool === "search_code");
  return search ? asEntityArray(search.data).length : 0;
}

/** Distinct file paths referenced anywhere in a search/references section. */
function entityFiles(data: unknown): string[] {
  const files = new Set<string>();
  for (const e of asEntityArray(data) as Record<string, unknown>[]) {
    const f = (e.file_path as string) ?? (e.file as string);
    if (f) files.add(f);
  }
  return [...files];
}

/**
 * Layer 8 §5.4: the domain-annotation suffix for one entity digest line —
 * `[domain/role — "summary"]`. Empty when the entity carries no annotation, so
 * an un-annotated line is identical to today.
 */
function formatEntityAnnotation(e: Record<string, unknown>): string {
  const domain = typeof e.domain === "string" ? e.domain : "";
  const role = typeof e.role === "string" ? e.role : "";
  const summary = typeof e.summary === "string" ? e.summary : "";
  if (!domain && !role && !summary) return "";
  const tag = [domain, role].filter(Boolean).join("/");
  const inner =
    tag && summary ? `${tag} — "${summary}"` : tag ? tag : `"${summary}"`;
  return ` [${inner}]`;
}

/** Group search entities by file: `src/foo.ts: fooBar (function), baz (method)`. */
function groupEntitiesByFile(
  data: unknown
): Array<{ file: string; names: string[] }> {
  const map = new Map<string, string[]>();
  for (const e of asEntityArray(data) as Record<string, unknown>[]) {
    const file = (e.file_path as string) ?? (e.file as string) ?? "(unknown)";
    const name = (e.name as string) ?? (e.key as string) ?? "?";
    const kind = e.kind ? ` (${e.kind})` : "";
    const annotation = formatEntityAnnotation(e);
    const list = map.get(file) ?? [];
    list.push(`${name}${kind}${annotation}`);
    map.set(file, list);
  }
  return [...map.entries()].map(([file, names]) => ({ file, names }));
}

/** Collapse a get_references section to `N callers across M files: a, b`. */
function summarizeReferences(data: unknown): {
  total: number;
  files: string[];
} {
  const o = (data ?? {}) as Record<string, unknown>;
  const refs = Array.isArray(o.references)
    ? (o.references as Record<string, unknown>[])
    : Array.isArray(data)
      ? (data as Record<string, unknown>[])
      : [];
  const total = typeof o.total === "number" ? o.total : refs.length;
  const files = [
    ...new Set(
      refs
        .map((r) => (r as Record<string, unknown>)?.file_path as string)
        .filter(Boolean)
    ),
  ];
  return { total, files };
}

/** One-line conventions summary: `naming: camelCase | imports: leaf→root`. */
function summarizeConventions(data: unknown): string {
  const o = (data ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  const summarize = (label: string, list: unknown) => {
    if (!Array.isArray(list) || list.length === 0) return;
    const heads = list.slice(0, 2).map((c) => {
      if (typeof c === "string") return c;
      const co = c as Record<string, unknown>;
      return String(
        co.summary ?? co.description ?? co.rule ?? co.name ?? JSON.stringify(co)
      );
    });
    parts.push(
      `${label}: ${heads.join("; ")}${list.length > 2 ? ` (+${list.length - 2})` : ""}`
    );
  };
  summarize("naming", o.naming);
  summarize("imports", o.import_direction);
  summarize("structure", o.structure);
  return parts.join(" | ");
}

/**
 * Render a recon bundle as an ultra-compact DIGEST — the return shape a
 * large-sweep subagent hands back to the main thread (Sprint 4, R6). Where
 * `renderReconText` prints each section's raw JSON, the digest collapses the
 * bulky lists to navigation-only summaries: search entities grouped by file
 * (name + kind, no bodies/scores), references to `N callers across M files`,
 * conventions to one line. Anchored notes (the user's load-bearing rules) are
 * kept verbatim — they're the one thing a sweep must not lose. The result is
 * flat in size as the number of files scanned grows, so a subagent that sweeps
 * 50 files returns roughly the same token count as one that sweeps 5.
 */
export function renderReconDigest(bundle: ReconBundle): string {
  const lines: string[] = [];
  const focus = bundle.focusName ?? bundle.focusKey;
  lines.push(
    `unerr recon digest — ${bundle.sections.length} sections, ~${bundle.totalTokens} tok${
      focus ? `, focus ${focus}` : ""
    }`
  );
  if (bundle.terms.length) lines.push(`terms: ${bundle.terms.join(", ")}`);

  for (const s of bundle.sections) {
    if (s.tool === "search_code") {
      const byFile = groupEntitiesByFile(s.data);
      if (!byFile.length) continue;
      const count = asEntityArray(s.data).length;
      lines.push("");
      lines.push(`## entities (${count})${s.shrunk ? " (trimmed)" : ""}`);
      for (const { file, names } of byFile) {
        lines.push(`${file}: ${names.join(", ")}`);
      }
    } else if (s.tool === "focus_bodies" || s.tool === "expand_callers") {
      // Digest stays flat-size: bodies collapse to their file:line ranges, not
      // full source. (In practice large sweeps run 'concise', so no bodies are
      // fetched — this branch only fires on an explicit digest+detailed call.)
      const bodies = Array.isArray(s.data) ? (s.data as FocusBody[]) : [];
      if (!bodies.length) continue;
      const label =
        s.tool === "expand_callers" ? "caller source" : "focus source";
      lines.push("");
      lines.push(`## ${label} (${bodies.length})`);
      for (const b of bodies) {
        lines.push(`${focusBodyRange(b)}${b.name ? ` ${b.name}` : ""}`);
      }
    } else if (s.tool === "get_references") {
      const { total, files } = summarizeReferences(s.data);
      lines.push("");
      lines.push(`## ${s.title}${s.shrunk ? " (trimmed)" : ""}`);
      lines.push(
        `${total} caller${total === 1 ? "" : "s"}${
          files.length
            ? ` across ${files.length} file${files.length === 1 ? "" : "s"}: ${files.join(", ")}`
            : ""
        }`
      );
    } else if (s.tool === "get_conventions") {
      const conv = summarizeConventions(s.data);
      if (!conv) continue;
      lines.push("");
      lines.push(`## conventions${s.shrunk ? " (trimmed)" : ""}`);
      lines.push(conv);
    } else if (s.tool === "domain_tags") {
      const tags = formatDomainTags(s.data);
      if (!tags) continue;
      lines.push("");
      lines.push(`## domain tags${s.shrunk ? " (trimmed)" : ""}`);
      lines.push(tags);
    } else if (s.tool === "vocab_nudges") {
      const nudges = formatVocabNudges(s.data);
      if (!nudges) continue;
      lines.push("");
      lines.push(`## vocabulary${s.shrunk ? " (trimmed)" : ""}`);
      lines.push(nudges);
    } else {
      // Anchored notes and any other section — keep verbatim; load-bearing.
      lines.push("");
      lines.push(`## ${s.title}${s.shrunk ? " (trimmed)" : ""}`);
      lines.push(typeof s.data === "string" ? s.data : JSON.stringify(s.data));
    }
  }

  if (bundle.dropped.length) {
    const budgetDrops = bundle.dropped.filter((d) => d.reason === "budget");
    if (budgetDrops.length) {
      lines.push("");
      lines.push(
        `omitted for budget: ${budgetDrops.map((d) => d.title).join(", ")}`
      );
    }
  }
  return lines.join("\n");
}

/** Distinct files across a bundle's search + references sections. */
export function reconFileSpread(bundle: ReconBundle): string[] {
  const files = new Set<string>();
  for (const s of bundle.sections) {
    if (s.tool === "search_code") {
      for (const f of entityFiles(s.data)) files.add(f);
    } else if (s.tool === "get_references") {
      for (const f of summarizeReferences(s.data).files) files.add(f);
    }
  }
  return [...files];
}

/** Verbatim-body sections (focus + expand ring) flattened to FocusBody rows. */
function bundleBodies(bundle: ReconBundle, tool: string): FocusBody[] {
  return bundle.sections
    .filter((s) => s.tool === tool)
    .flatMap((s) => (Array.isArray(s.data) ? (s.data as FocusBody[]) : []));
}

/**
 * E4 Layer A — emit-time MODELED savings for one recon bundle.
 *
 * The bundle is ONE round-trip that stands in for the discovery fan-out an agent
 * would otherwise run as N separate calls (search → references → a file_read per
 * focus body → conventions). The dominant cost of that fan-out is NOT the
 * section content — it is that every separate call re-bills the entire
 * accumulated context prefix (CLAUDE.md "Recon first"). So the modeled saving is
 * the re-paid prefix the single bundle avoids: `round_trips × prefix estimate`.
 *
 * This is the UPPER BOUND — a counterfactual that assumes the agent WOULD have
 * fetched every folded section separately. Layer B reconciles it post-hoc
 * against what the agent actually did next (re-fetch ⇒ miss, expand item used ⇒
 * confirmed avoided trip). The `delivered_*`/`expand_keys` arrays are Layer B's
 * input — they name exactly what this bundle put on the wire. Pure +
 * deterministic so it unit-tests against a hand-built bundle.
 * @sem domain=recon role=telemetry
 */
export interface BundleSavingsModel {
  /** Distinct rings folded into the bundle; each is one avoided tool call. */
  readonly sources_collapsed: number;
  /** Round-trips the single bundle call replaces: max(0, sources_collapsed−1). */
  readonly round_trips_modeled: number;
  /** Counterfactual cost if each source were fetched as its own call. */
  readonly original_tokens: number;
  /** Tokens actually put on the wire (the bundle). */
  readonly delivered_tokens: number;
  /** Tokens saved vs the fan-out: round_trips_modeled × prefix estimate. */
  readonly rerequest_saved_tokens: number;
  /** Verbatim focus bodies inlined — the file_reads the manifest suppresses. */
  readonly manifest_items: number;
  /** Speculative expand-ring caller bodies pre-inlined. */
  readonly expand_items: number;
  /** Delivered entity keys (search hits + focus bodies) — Layer B re-fetch input. */
  readonly delivered_entity_keys: string[];
  /** Delivered file paths — Layer B re-fetch input. */
  readonly delivered_files: string[];
  /** Expand-ring caller keys — Layer B confirmed-avoided-trip input. */
  readonly expand_keys: string[];
}

/**
 * Default per-call prefix estimate (tokens) for the Layer-A model when the
 * caller can't supply the live session figure. Deliberately conservative — a
 * modest mid-session accumulated prefix, NOT a peak — so the modeled upper bound
 * never over-claims. The credible number is Layer B's, not this.
 */
export const DEFAULT_PREFIX_TOKENS = 4000;

/**
 * Compute the Layer-A modeled savings + the Layer-B manifest for a bundle.
 * @sem domain=recon role=telemetry
 */
export function modelBundleSavings(
  bundle: ReconBundle,
  opts: { prefixTokens?: number } = {}
): BundleSavingsModel {
  const prefixTokens =
    typeof opts.prefixTokens === "number" && opts.prefixTokens > 0
      ? opts.prefixTokens
      : DEFAULT_PREFIX_TOKENS;
  const sources_collapsed = bundle.sections.length;
  const round_trips_modeled = Math.max(0, sources_collapsed - 1);
  const delivered_tokens = bundle.totalTokens;
  const rerequest_saved_tokens = round_trips_modeled * prefixTokens;
  const original_tokens = delivered_tokens + rerequest_saved_tokens;

  const focusBodies = bundleBodies(bundle, "focus_bodies");
  const expandBodies = bundleBodies(bundle, "expand_callers");
  // manifest_items mirrors buildReadManifest: only non-truncated, file-bearing
  // bodies are re-read-suppressed (a truncated slice may legitimately re-read).
  const manifest_items = focusBodies.filter(
    (b) => b?.file && !b.truncated
  ).length;

  const entityKeys = new Set<string>();
  for (const e of asEntityArray(
    bundle.sections.find((s) => s.tool === "search_code")?.data
  ) as Record<string, unknown>[]) {
    const k = typeof e.key === "string" ? e.key : "";
    if (k) entityKeys.add(k);
  }
  for (const b of focusBodies) if (b.key) entityKeys.add(b.key);

  const expand_keys = expandBodies
    .map((b) => b.key)
    .filter((k): k is string => !!k);

  return {
    sources_collapsed,
    round_trips_modeled,
    original_tokens,
    delivered_tokens,
    rerequest_saved_tokens,
    manifest_items,
    expand_items: expandBodies.length,
    delivered_entity_keys: [...entityKeys],
    delivered_files: reconFileSpread(bundle),
    expand_keys,
  };
}
