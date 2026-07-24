/**
 * Query-shape classifier — decides whether a `search_code` query is a bare
 * symbol lookup or a natural-language task, so the dispatcher can route a symbol
 * to the lean ranked-name search and a task to the recon composite (one richer
 * call instead of a search→read→search fan-out). Mirrors the hybrid keyword-vs-
 * semantic routing standard (Sourcegraph/deepset): keyword lookups stay on the
 * fast precise path, NL queries get the heavier semantic bundle.
 *
 */

export type QueryShape = "symbol" | "task";

export interface QueryShapeVerdict {
  readonly shape: QueryShape;
  /** One-line, human-readable justification for telemetry/debugging. */
  readonly reason: string;
}

/**
 * NL openers that signal a "find / understand / locate" ask phrased as prose
 * rather than a symbol name. A query starting with one of these is a task.
 */
const NL_OPENERS = new Set([
  // read-only / locate
  "explain",
  "what",
  "what's",
  "whats",
  "how",
  "why",
  "describe",
  "show",
  "summarize",
  "summarise",
  "tell",
  "where",
  "which",
  "who",
  "does",
  "do",
  "is",
  "are",
  "can",
  "list",
  "understand",
  "walk",
  "give",
  "find",
  "locate",
  // action verbs (task phrasing)
  "add",
  "fix",
  "implement",
  "build",
  "create",
  "refactor",
  "rename",
  "move",
  "update",
  "change",
  "remove",
  "delete",
  "handle",
  "route",
  "wire",
  "make",
  "support",
  "trace",
]);

/**
 * NL connective stopwords. A standalone occurrence of one between tokens marks
 * prose phrasing (e.g. "retry in the boot path"), not a multi-symbol lookup.
 */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "in",
  "of",
  "for",
  "on",
  "with",
  "that",
  "this",
  "from",
  "into",
  "and",
  "or",
  "as",
  "at",
  "by",
]);

const WS_RE = /\s+/;

/**
 * Strong identifier shape — camelCase / PascalCase, snake_case, a dotted member
 * path, or a file path with an extension. A plain lowercase English word does
 * NOT match (that ambiguity is what separates "authentication" from "fetchUser").
 */
function isStrongIdentifier(token: string): boolean {
  return (
    /[A-Za-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*/.test(token) || // camelCase/PascalCase
    /_[A-Za-z0-9]/.test(token) || // snake_case
    /[A-Za-z0-9_$]\.[A-Za-z_$]/.test(token) || // dotted member (Foo.bar)
    /\//.test(token) || // path
    /[A-Za-z0-9_]+\.[A-Za-z]{1,5}$/.test(token) // file.ext
  );
}

/**
 * Classify a search query as a bare symbol lookup vs a natural-language task.
 * Symbol → the lean ranked-name search path; task → the recon composite. Pure,
 * no I/O — unit-testable in isolation. Empty/whitespace defaults to `symbol`
 * (the lean path owns the empty-query error message).
 */
export function classifyQueryShape(query: string): QueryShapeVerdict {
  const q = (query ?? "").trim();
  if (q.length === 0) {
    return { shape: "symbol", reason: "empty query → lean path" };
  }

  // A question is always a task, regardless of token shape.
  if (q.includes("?")) {
    return { shape: "task", reason: "question mark → task" };
  }

  const words = q.split(WS_RE).filter(Boolean);

  // Single token — a symbol/keyword lookup, even a lone English word. The lean
  // ranked-name search handles one term best (and cheapest).
  if (words.length === 1) {
    return { shape: "symbol", reason: "single token → symbol lookup" };
  }

  const lowerWords = words.map((w) => w.toLowerCase());
  const opener = lowerWords[0] ?? "";

  // Prose opener (where/how/find/add/fix/…) → task.
  if (NL_OPENERS.has(opener)) {
    return { shape: "task", reason: `NL opener '${opener}' → task` };
  }

  // A connective stopword as a standalone token marks prose phrasing → task.
  if (lowerWords.some((w) => STOPWORDS.has(w))) {
    return { shape: "task", reason: "connective stopword → task phrasing" };
  }

  // Four-plus words with no identifier dominance reads as prose → task.
  if (words.length >= 4) {
    return { shape: "task", reason: "4+ words → NL phrase" };
  }

  // 2–3 words, no opener, no stopword: a multi-symbol lookup ("QueryRouter
  // execute") stays a symbol search; anything with a plain prose word
  // ("compressShellOutput callers") routes to recon.
  if (words.every((w) => isStrongIdentifier(w))) {
    return { shape: "symbol", reason: "all identifier-shaped tokens → symbol" };
  }

  return { shape: "task", reason: "mixed prose + symbol → task" };
}

/**
 * Whether a `search_code` call should escalate from the lean ranked-name search
 * to the recon composite (`unerr_context`). True ONLY for a task-shaped query
 * with no overriding intent. Each of these means "do NOT escalate":
 *   - a profile flag (`detail` / `include_body` / `want`) — resolve ONE entity;
 *   - `scope:'workspace'` — keep the lean federated search;
 *   - `mode:'literal'|'regex'` — an explicit content (grep) search, the OPPOSITE
 *     of recon; a multi-word grep pattern is task-shaped but must run as a file
 *     scan, not be silently re-targeted to an entity recon bundle.
 * Pure + side-effect-free so the routing rule is unit-testable apart from the
 * proxy dispatch.
 *
 */
export function shouldEscalateSearchCodeToRecon(
  args: Record<string, unknown>
): boolean {
  const hasProfileFlag =
    args.detail === true ||
    args.include_body === true ||
    (Array.isArray(args.want) && args.want.length > 0);
  if (hasProfileFlag) return false;
  if (args.scope === "workspace") return false;
  if (args.mode === "literal" || args.mode === "regex") return false;
  const q = typeof args.query === "string" ? args.query : "";
  return classifyQueryShape(q).shape === "task";
}
