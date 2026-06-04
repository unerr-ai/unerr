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
  /** "budget" (no room left) or "error" (the runner threw). */
  readonly reason: "budget" | "error";
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

export interface ReconOptions {
  readonly prompt: string;
  readonly runner: ReconRunner;
  /** Whole-bundle token budget. Default 2000 — small enough to beat the fan-out. */
  readonly budget?: number;
  /** Token estimator. Default: JSON byte length / 4. */
  readonly countTokens?: TokenCounter;
  /** Max callers/callees pulled for the focus entity. Default 15. */
  readonly maxReferences?: number;
  /** Max search hits considered. Default 10. */
  readonly searchLimit?: number;
}

const DEFAULT_BUDGET = 2000;
const DEFAULT_MAX_REFERENCES = 15;
const DEFAULT_SEARCH_LIMIT = 10;

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
      longest.arr.length = keep;
    }
    shrunk = true;
  }
  return { data: clone, shrunk };
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
  } = opts;

  const terms = extractQueryTerms(prompt);
  const dropped: DroppedSection[] = [];

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
  const searchP =
    terms.length > 0
      ? safeRun(
          "search_code",
          { query: terms.join(" "), limit: searchLimit },
          "Entities"
        )
      : Promise.resolve(undefined);

  const [notes, conventions, search] = await Promise.all([
    notesP,
    conventionsP,
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

  add("unerr_recall_notes", "Anchored notes", 0, notes, notesEmpty);
  if (focus) {
    add(
      "get_references",
      `Callers of ${focus.name ?? focus.key}`,
      1,
      references,
      referencesEmpty
    );
  }
  add("search_code", "Entities", 2, search, searchEmpty);
  add("get_conventions", "Conventions", 3, conventions, conventionsEmpty);

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

/**
 * Render a recon bundle as compact, agent-readable text for the CLI stdout or
 * the MCP wire. Deterministic ordering; one labeled block per section.
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
  for (const s of bundle.sections) {
    lines.push("");
    lines.push(`## ${s.title}${s.shrunk ? " (trimmed)" : ""}`);
    lines.push(typeof s.data === "string" ? s.data : JSON.stringify(s.data));
  }
  if (bundle.dropped.length) {
    lines.push("");
    const budgetDrops = bundle.dropped.filter((d) => d.reason === "budget");
    if (budgetDrops.length) {
      lines.push(
        `omitted for budget (raise budget to include): ${budgetDrops
          .map((d) => d.title)
          .join(", ")}`
      );
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

/** Group search entities by file: `src/foo.ts: fooBar (function), baz (method)`. */
function groupEntitiesByFile(
  data: unknown
): Array<{ file: string; names: string[] }> {
  const map = new Map<string, string[]>();
  for (const e of asEntityArray(data) as Record<string, unknown>[]) {
    const file = (e.file_path as string) ?? (e.file as string) ?? "(unknown)";
    const name = (e.name as string) ?? (e.key as string) ?? "?";
    const kind = e.kind ? ` (${e.kind})` : "";
    const list = map.get(file) ?? [];
    list.push(`${name}${kind}`);
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
