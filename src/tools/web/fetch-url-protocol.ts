/**
 * fetch_url runtime: fetch HTML → extract main content → markdown → passages →
 * telemetry. Returns a wire-cap-shaped body with a `passages` array so
 * applyWireCap can paginate via offset/limit and FU-3 can BM25-rank in place.
 */

import { type FetchUrlConfig, loadSettings } from "../../config/settings.js";
import { estimateTokens } from "../../intelligence/token-estimator.js";
import { type ChallengeDetection, detectChallenge } from "./anti-bot.js";
import { rankPassagesByPrompt } from "./bm25-rank.js";
import { safeCompressionRatio } from "./compression-ratio.js";
import {
  type ExtractedMeta,
  extractMainContent,
  extractMeta,
  rawBodyFromHtmlSync,
} from "./extract.js";
import { htmlToMarkdown } from "./markdown.js";
import { type Passage, splitMarkdownIntoPassages } from "./passage-split.js";
import {
  type HostRule,
  lookupHostRule,
  postProcessMarkdown,
} from "./post-process.js";
import { renderWithPlaywright, shouldUsePlaywright } from "./spa-render.js";
import { recordFetchUrlTelemetry } from "./telemetry.js";

export interface FetchUrlArgs {
  url: string;
  prompt?: string;
  offset?: number;
  limit?: number;
  token_budget?: number;
}

/** Internal shape — includes all fields used by batch aggregation and telemetry. */
export interface FetchUrlOkInternal {
  result_status: "ok";
  url: string;
  final_url: string;
  status: number;
  title: string;
  published_at: string | null;
  author: string | null;
  og_type: string | null;
  site_name: string | null;
  favicon: string | null;
  extractor: "defuddle" | "readability" | "raw-body";
  word_count: number;
  raw_bytes: number;
  extracted_bytes: number;
  raw_tokens: number;
  extracted_tokens: number;
  compression_ratio: number;
  cache_hit: boolean;
  diff?: {
    unchanged: boolean;
    changed_regions: number;
    added_lines: number;
    removed_lines: number;
  };
  passages: Array<{
    index: number;
    heading: string | null;
    text: string;
    start_line: number;
  }>;
  total: number;
  quality: {
    playwright_rescued: boolean;
    bm25_ranked: boolean;
    rule_applied: string | null;
    inflated: boolean;
  };
}

/** Wire shape returned to the agent — diagnostic keys stripped. */
export interface FetchUrlOk {
  result_status: "ok";
  final_url: string;
  title: string;
  /**
   * OG / article:* / dc:* metadata pulled from raw HTML. Present ONLY when
   * the source ships the corresponding tag — omitted (not `null`) when
   * absent, so a page without provenance costs zero wire bytes. Use for
   * agent-side dating, cross-doc correlation, and provenance display.
   */
  published_at?: string;
  author?: string;
  site_name?: string;
  word_count: number;
  passages: Array<{
    index: number;
    heading: string | null;
    text: string;
  }>;
  /** Total passages available; `> passages.length` signals more via offset. */
  total: number;
}

export interface FetchUrlBlocked {
  result_status: "blocked";
  url: string;
  final_url: string;
  status: number;
  reason: "anti_bot_challenge";
  detected: "cloudflare" | "hcaptcha" | "perimeterx";
  title: string;
  suggestion: string;
}

export interface FetchUrlHttpError {
  result_status: "http_error";
  url: string;
  final_url: string;
  status: number;
  reason: "http_status" | "deadline_exceeded" | "dns_not_found";
  suggestion: string;
  /**
   * Present only on `deadline_exceeded`. Counts the number of fetch
   * attempts spent before giving up so the agent can tell "host is slow"
   * (many short attempts) from "host hung once" (one long attempt).
   */
  attempts?: number;
  /** Total wall-clock time spent before declaring deadline-exceeded. */
  elapsed_ms?: number;
}

/** Internal result type — includes diagnostic fields used by batch aggregation. */
export type FetchUrlResultInternal =
  | FetchUrlOkInternal
  | FetchUrlBlocked
  | FetchUrlHttpError;

/** Public wire result type — diagnostic fields stripped. */
export type FetchUrlResult = FetchUrlOk | FetchUrlBlocked | FetchUrlHttpError;

export interface FetchUrlContext {
  cwd: string;
  abortSignal?: AbortSignal;
  /**
   * Number of URLs in the batch this fetch belongs to, set by
   * `runFetchUrlBatch`. Threaded into telemetry so each per-page compression
   * row records its `batch_size`. A plain single fetch leaves this undefined
   * (recorded as no batch). Additive — the 21 single-URL callers omit it and
   * `runFetchUrl`'s behavior is unchanged when it is absent.
   */
  batchSize?: number;
}

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const BM25_GATE_BYTES = 8 * 1024;
const BM25_DEFAULT_TOPK = 20;
/** Default passage window for a bulk fetch when the caller passes no `limit`.
 *  Matches the wire-cap `fetch_url` defaultLimit so a batch's first page of
 *  merged passages clears the byte cap without a paginate-and-retry hop. */
const BATCH_DEFAULT_LIMIT = 30;

/**
 * Tunable limits for the fetch_url pipeline. Exported as a mutable object
 * so tests can shrink the deadlines to keep the suite fast; production code
 * never reads from anywhere else, so changes here propagate everywhere.
 *
 *   baseTimeoutMs    — first attempt's per-fetch timeout; doubles each retry
 *   totalDeadlineMs  — hard wall-clock cap across ALL fetch attempts; on
 *                      exceed we abort and return a typed deadline_exceeded
 *                      http_error to the caller
 *   extractionTimeoutMs — cap on jsdom+Defuddle+Turndown so a 5MB blob
 *                         can't pin the daemon; on exceed we fall back to a
 *                         regex tag-strip raw-body extraction
 */
export const FETCH_PROTOCOL_LIMITS = {
  baseTimeoutMs: 15_000,
  totalDeadlineMs: 120_000,
  extractionTimeoutMs: 30_000,
  /** Bulk fetch: most URLs accepted per `fetch_url({urls:[...]})` call. Extra
   *  URLs past this are dropped at the tool surface with a clear error. */
  maxBatchUrls: 10,
  /** Bulk fetch: how many per-URL fetches run at once. The rest queue. */
  batchConcurrency: 5,
  /** Bulk fetch: overall wall-clock cap across the whole batch. A URL not
   *  finished by then is recorded as a deadline failure and the batch returns
   *  whatever completed (per-URL `baseTimeoutMs` still applies underneath). */
  batchDeadlineMs: 30_000,
};

/**
 * Thrown by `fetchHtml` when retry budget runs out. Caller (`runFetchUrl`)
 * catches it and turns it into a typed `deadline_exceeded` http_error so the
 * agent sees a structured "host is unreachable" signal instead of a generic
 * tool-failure message.
 */
class FetchDeadlineExceededError extends Error {
  constructor(
    public elapsedMs: number,
    public attempts: number,
    public lastError: unknown
  ) {
    super(
      `fetch_url exceeded total deadline of ${Math.round(elapsedMs / 1000)}s after ${attempts} attempt(s) — host may be slow or unreachable`
    );
    this.name = "FetchDeadlineExceededError";
  }
}

/**
 * Thrown internally by `withTimeout` when an extraction stage runs over its
 * cap. Caller catches it and falls back to a sync regex tag-strip so the
 * call still returns a useful (if structurally weaker) result instead of
 * pinning the daemon on a runaway jsdom parse.
 */
class ExtractionTimeoutError extends Error {
  constructor(
    public stage: string,
    public timeoutMs: number
  ) {
    super(
      `extraction stage "${stage}" exceeded ${timeoutMs}ms — falling back to raw-body`
    );
    this.name = "ExtractionTimeoutError";
  }
}

/**
 * Thrown by `fetchHtml` when DNS lookup returns NXDOMAIN (ENOTFOUND). The
 * domain does not resolve — a permanent failure that no retry can change —
 * so we fail within the first attempt instead of burning the 2-minute
 * deadline. Caller (`runFetchUrl`) turns it into a typed `dns_not_found`
 * http_error. (EAI_AGAIN — a transient resolver failure — stays retryable.)
 */
class DnsNotFoundError extends Error {
  constructor(
    public url: string,
    cause: unknown
  ) {
    super(
      `fetch_url DNS lookup found no record for ${url} (ENOTFOUND) — the domain does not resolve`,
      { cause }
    );
    this.name = "DnsNotFoundError";
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stage: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ExtractionTimeoutError(stage, timeoutMs));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Walk an error's `cause` chain for the first Node errno code. undici's
 * fetch() throws `TypeError: fetch failed` with the real network error
 * (getaddrinfo ENOTFOUND, ECONNRESET, …) buried in `cause` — the top-level
 * message alone never names the errno, so any classifier that only sniffs
 * `e.message` misroutes every network failure into its generic bucket.
 */
function fetchErrorCode(e: unknown): string | null {
  let current: unknown = e;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string") return code;
    const msg = current.message ?? "";
    // Some wrappers stringify the errno into the message instead of
    // setting `code` — recognize the two codes we branch on.
    if (msg.includes("ENOTFOUND")) return "ENOTFOUND";
    if (msg.includes("EAI_AGAIN")) return "EAI_AGAIN";
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function isRetryableFetchError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  // ENOTFOUND is NXDOMAIN — a permanent answer, not a transient fault.
  // Retrying re-asks the resolver the same question (observed as a 108k-
  // attempt tight loop against a non-existent domain). fetchHtml fails
  // fast on it before this classifier runs; the guard here is the
  // backstop for any other caller.
  if (fetchErrorCode(e) === "ENOTFOUND") return false;
  const msg = e.message ?? "";
  return (
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("EAI_AGAIN") ||
    msg.includes("fetch failed")
  );
}

function shouldRank(args: FetchUrlArgs, markdown: string): boolean {
  if (!args.prompt || args.prompt.trim().length === 0) return false;
  return Buffer.byteLength(markdown, "utf-8") > BM25_GATE_BYTES;
}

export async function runFetchUrl(
  args: FetchUrlArgs,
  ctx: FetchUrlContext
): Promise<FetchUrlResultInternal> {
  if (!args.url || typeof args.url !== "string") {
    throw new Error(
      'fetch_url requires a string `url` argument — call again with url:"https://example.com/path"'
    );
  }
  const url = upgradeToHttps(args.url);
  const started = Date.now();
  const settings = safeLoadSettings(ctx.cwd);
  let playwrightRescued = false;
  let bm25Ranked = false;

  // Look up the host rule against the requested URL so behavior overrides
  // (acceptLanguage) can apply on the first request. After the fetch we
  // re-resolve against final_url in case redirects landed elsewhere — the
  // post-redirect rule wins for extractor + playwright decisions.
  const initialRule = lookupHostRule(url);

  let fetched: FetchedHtml;
  try {
    fetched = await fetchHtml(url, {
      abortSignal: ctx.abortSignal,
      acceptLanguage:
        initialRule?.behavior?.acceptLanguage ??
        settings?.fetchUrl.acceptLanguage,
    });
  } catch (e) {
    if (e instanceof FetchDeadlineExceededError) {
      return makeDeadlineExceededResult(args.url, url, e);
    }
    if (e instanceof DnsNotFoundError) {
      return makeDnsNotFoundResult(args.url, url);
    }
    throw e;
  }

  if (fetched.status >= 400) {
    return makeHttpErrorResult(args.url, fetched);
  }

  const hostRule: HostRule | null =
    lookupHostRule(fetched.finalUrl) ?? initialRule;

  const initialChallenge = detectChallenge(fetched.html);
  if (initialChallenge) {
    const rescued = await tryPlaywrightRescue(
      fetched,
      settings?.fetchUrl,
      initialChallenge
    );
    if (rescued) {
      fetched.html = rescued.html;
      fetched.finalUrl = rescued.finalUrl;
      fetched.status = rescued.status;
      playwrightRescued = true;
    } else {
      recordFetchUrlTelemetry(ctx.cwd, {
        url: fetched.finalUrl,
        rawBytes: byteLength(fetched.html),
        compressedBytes: 0,
        durationMs: Date.now() - started,
        extractor: "raw-body",
        cacheHit: false,
        blocked: initialChallenge.kind,
        batchSize: ctx.batchSize,
      });
      return makeBlockedResult(args.url, fetched, initialChallenge);
    }
  }

  let markdown: string;
  let title: string;
  let extractor: FetchUrlOkInternal["extractor"];
  let wordCount: number;
  const cacheHit = false;
  const diff: FetchUrlOkInternal["diff"] = undefined;
  let meta: ExtractedMeta;

  {
    let extracted = await extractWithTimeout(
      fetched.html,
      fetched.finalUrl,
      hostRule?.extractor
    );
    const forcePlaywright =
      hostRule?.behavior?.forcePlaywright === true &&
      settings?.fetchUrl.playwright.enabled === true;
    const usePlaywright =
      forcePlaywright ||
      shouldUsePlaywright({
        config: settings?.fetchUrl,
        extractor: extracted.extractor,
        wordCount: extracted.wordCount,
        rawHtml: fetched.html,
        rawBytes: byteLength(fetched.html),
        extractedBytes: byteLength(extracted.contentHtml),
      });
    if (usePlaywright && settings) {
      const rendered = await renderWithPlaywright(
        fetched.finalUrl,
        settings.fetchUrl
      );
      if (rendered) {
        fetched.html = rendered.html;
        fetched.finalUrl = rendered.finalUrl;
        fetched.status = rendered.status;
        extracted = await extractWithTimeout(
          rendered.html,
          rendered.finalUrl,
          hostRule?.extractor
        );
        playwrightRescued = true;
      }
    }
    const rawMarkdown = await markdownWithTimeout(
      extracted.contentHtml,
      fetched.finalUrl
    );
    markdown = postProcessMarkdown(rawMarkdown, { url: fetched.finalUrl });
    title = extracted.title;
    extractor = extracted.extractor;
    wordCount = extracted.wordCount;
    meta = extractMeta(fetched.html, fetched.finalUrl);
    // Author from OG/article tags wins; if absent, fall back to whatever
    // Defuddle/Readability detected as the byline. Most newsroom-style sites
    // ship article:author and most blogs ship readability-detectable bylines —
    // the union catches both.
    if (!meta.author && extracted.byline) {
      meta = { ...meta, author: extracted.byline };
    }
  }

  const allPassages = splitMarkdownIntoPassages(markdown);

  let ranked: typeof allPassages = allPassages;
  if (shouldRank(args, markdown)) {
    ranked = await rankPassagesByPrompt(allPassages, {
      prompt: args.prompt ?? "",
      topK: args.limit ?? BM25_DEFAULT_TOPK,
    });
    bm25Ranked = ranked !== allPassages;
  }

  const offset = Math.max(0, args.offset ?? 0);
  const afterOffset = offset > 0 ? ranked.slice(offset) : ranked;
  // Apply `limit` post-slice, unconditionally. BM25 ranking already truncates
  // to topK, but when ranking is skipped (no prompt, or the page is too small
  // to rank) `ranked` is the FULL passage list — so without this slice a
  // `limit:N` call returns the whole page, which then trips the byte cap and
  // forces the agent through a paginate-and-retry round-trip. Slicing here means
  // limit:N returns N passages on the first call. `total` stays the full count
  // so the agent can still page through the remainder via `offset`.
  const limit =
    typeof args.limit === "number" && args.limit > 0
      ? Math.floor(args.limit)
      : BM25_DEFAULT_TOPK;
  const sliced = afterOffset.slice(0, limit);

  const rawBytes = meaningfulHtmlBytes(fetched.html);
  const compressedBytes = byteLength(markdown);
  // The savings metric must reflect what the agent RECEIVES, not the full
  // extracted corpus. On docs-framework pages (Mintlify) the markdown balloons
  // to multi-MB of embedded doc-tree, dwarfing the script-stripped HTML and
  // recording a false 4–5× "inflation" in compression_events — yet the agent
  // only ever gets `sliced` (limit/topK passages, further trimmed by wire-cap).
  // Record delivered bytes here; the result's extracted_bytes/compression_ratio
  // below keep the full-markdown extraction view.
  const deliveredBytes = sliced.reduce((n, p) => n + byteLength(p.text), 0);

  recordFetchUrlTelemetry(ctx.cwd, {
    url: fetched.finalUrl,
    rawBytes,
    compressedBytes: deliveredBytes,
    durationMs: Date.now() - started,
    extractor,
    cacheHit,
    playwrightRescued,
    bm25Ranked,
    wordCount,
    batchSize: ctx.batchSize,
  });

  return {
    result_status: "ok",
    url: args.url,
    final_url: fetched.finalUrl,
    status: fetched.status,
    title,
    published_at: meta.published_at,
    author: meta.author,
    og_type: meta.og_type,
    site_name: meta.site_name,
    favicon: meta.favicon,
    extractor,
    word_count: wordCount,
    cache_hit: cacheHit,
    diff,
    raw_bytes: rawBytes,
    extracted_bytes: compressedBytes,
    raw_tokens: estimateTokens(fetched.html),
    extracted_tokens: estimateTokens(markdown),
    compression_ratio: safeCompressionRatio(rawBytes, compressedBytes),
    passages: sliced.map((p) => ({
      index: p.index,
      heading: p.heading,
      text: p.text,
      start_line: p.startLine,
    })),
    total: allPassages.length,
    quality: {
      playwright_rescued: playwrightRescued,
      bm25_ranked: bm25Ranked,
      rule_applied: hostRule?.host ?? null,
      inflated: rawBytes > 0 && compressedBytes >= rawBytes,
    },
  } satisfies FetchUrlOkInternal;
}

// ── Bulk (multi-URL) fetch ────────────────────────────────────────────
//
// runFetchUrlBatch is a WRAPPER over runFetchUrl: it fetches N URLs in
// parallel (bounded concurrency + an overall deadline), BM25-ranks the
// passages ACROSS all pages so the strongest survive and weak pages drop
// out, and returns one payload in a single tool roundtrip. runFetchUrl's
// signature is unchanged — single-URL callers are untouched.

/** One per-URL row in a batch result: what was fetched and how it went. */
export interface FetchUrlBatchSource {
  source_index: number;
  url: string;
  final_url: string;
  status: number;
  result_status: "ok" | "blocked" | "http_error";
  title: string;
  word_count?: number;
  /** Failure reason for blocked / http_error sources; absent on ok. */
  error?: string;
}

/** A passage in a batch result, carrying provenance back to its source page. */
export interface FetchUrlBatchPassage {
  /** Post-rank ordinal in the merged list — drives wire-cap pagination. */
  index: number;
  source_index: number;
  source_url: string;
  heading: string | null;
  text: string;
}

export interface FetchUrlBatchOk {
  result_status: "ok";
  sources: FetchUrlBatchSource[];
  /** Globally BM25-ranked across all OK pages (or round-robin by source when
   *  no prompt), then paginated by offset/limit. */
  passages: FetchUrlBatchPassage[];
  total: number;
  more_available: number;
  truncated: boolean;
  fetched: number;
  ok: number;
  failed: number;
}

export interface FetchUrlBatchError {
  result_status: "batch_error";
  /** Every URL's failure row, so the agent sees why each one failed. */
  sources: FetchUrlBatchSource[];
  fetched: number;
  ok: 0;
  failed: number;
  suggestion: string;
}

export type FetchUrlBatchResult = FetchUrlBatchOk | FetchUrlBatchError;

/** A passage tagged with its origin page, so cross-page ranking can keep
 *  provenance while reusing the same BM25 ranker the single path uses. */
interface SourcedPassage extends Passage {
  sourceIndex: number;
  sourceUrl: string;
}

/** Sentinel for a per-URL fetch that threw or blew the batch deadline. */
interface BatchFetchFailure {
  result_status: "batch_failed";
  error: string;
}

/** Race a fetch against the remaining batch deadline. Resolves to a typed
 *  failure sentinel on timeout instead of rejecting, so one slow host never
 *  sinks the batch. The underlying fetch keeps its own per-attempt timeout. */
function raceBatchDeadline(
  p: Promise<FetchUrlResultInternal>,
  ms: number
): Promise<FetchUrlResultInternal | BatchFetchFailure> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({
        result_status: "batch_failed",
        error: "batch_deadline_exceeded",
      });
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
    p.then(
      (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** Run per-URL fetches with a bounded worker pool and an overall deadline.
 *  Returns one slot per input URL, in input order: either the FetchUrlResult
 *  or a BatchFetchFailure. Never rejects. */
async function runBatchFetches(
  urls: string[],
  perPageShared: Omit<FetchUrlArgs, "url">,
  ctx: FetchUrlContext,
  concurrency: number,
  deadlineMs: number
): Promise<Array<FetchUrlResultInternal | BatchFetchFailure>> {
  const deadline = Date.now() + deadlineMs;
  const out = new Array<FetchUrlResultInternal | BatchFetchFailure>(
    urls.length
  );
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= urls.length) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        out[i] = {
          result_status: "batch_failed",
          error: "batch_deadline_exceeded",
        };
        continue;
      }
      try {
        out[i] = await raceBatchDeadline(
          runFetchUrl({ url: urls[i] as string, ...perPageShared }, ctx),
          remaining
        );
      } catch (e) {
        out[i] = {
          result_status: "batch_failed",
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
  };
  const pool = Math.min(Math.max(1, concurrency), urls.length || 1);
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return out;
}

/** Interleave passages by source (round-robin) so no single page dominates
 *  the head of the merged list when there is no prompt to rank by. */
function interleaveBySource(passages: SourcedPassage[]): SourcedPassage[] {
  if (passages.length === 0) return passages;
  const bySource = new Map<number, SourcedPassage[]>();
  for (const p of passages) {
    const arr = bySource.get(p.sourceIndex);
    if (arr) arr.push(p);
    else bySource.set(p.sourceIndex, [p]);
  }
  const queues = [...bySource.values()];
  const out: SourcedPassage[] = [];
  let drained = false;
  while (!drained) {
    drained = true;
    for (const q of queues) {
      const next = q.shift();
      if (next) {
        out.push(next);
        drained = false;
      }
    }
  }
  return out;
}

/**
 * Fetch many URLs in one call. See the block comment above for the contract.
 *
 * @param urls    Result URLs to fetch (deduped + capped at maxBatchUrls here).
 * @param shared  prompt/offset/limit/token_budget applied to the batch.
 * @param ctx     fetch context (cwd + abort); batchSize is set per-page here.
 */
export async function runFetchUrlBatch(
  urls: string[],
  shared: Omit<FetchUrlArgs, "url">,
  ctx: FetchUrlContext
): Promise<FetchUrlBatchResult> {
  const query =
    typeof shared.prompt === "string" && shared.prompt.trim().length > 0
      ? shared.prompt.trim()
      : null;

  // 1. Normalize — dedupe (first-seen order preserved), cap at maxBatchUrls.
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    if (typeof u !== "string") continue;
    const trimmed = u.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    deduped.push(trimmed);
    if (deduped.length >= FETCH_PROTOCOL_LIMITS.maxBatchUrls) break;
  }

  // 2. Parallel fetch. Per-page args carry prompt (per-page pre-rank) +
  //    token_budget, but NOT offset/limit — pagination is applied once,
  //    globally, over the merged passages below. batchSize threads into
  //    each page's telemetry row.
  const perPageShared: Omit<FetchUrlArgs, "url"> = {
    prompt: shared.prompt,
    token_budget: shared.token_budget,
  };
  const perPageCtx: FetchUrlContext = { ...ctx, batchSize: deduped.length };
  const settled = await runBatchFetches(
    deduped,
    perPageShared,
    perPageCtx,
    FETCH_PROTOCOL_LIMITS.batchConcurrency,
    FETCH_PROTOCOL_LIMITS.batchDeadlineMs
  );

  // 3. Partition into per-source rows + collect OK pages' passages, tagged
  //    with a globally-unique index so cross-page BM25 dedup is correct.
  const sources: FetchUrlBatchSource[] = [];
  const merged: SourcedPassage[] = [];
  let okCount = 0;
  let globalIndex = 0;

  deduped.forEach((url, sourceIndex) => {
    const r = settled[sourceIndex];
    if (r && r.result_status === "ok") {
      okCount++;
      sources.push({
        source_index: sourceIndex,
        url: r.url,
        final_url: r.final_url,
        status: r.status,
        result_status: "ok",
        title: r.title,
        word_count: r.word_count,
      });
      for (const p of r.passages) {
        merged.push({
          index: globalIndex++,
          heading: p.heading,
          text: p.text,
          startLine: p.start_line,
          sourceIndex,
          sourceUrl: r.final_url,
        });
      }
    } else if (r && r.result_status === "blocked") {
      sources.push({
        source_index: sourceIndex,
        url: r.url,
        final_url: r.final_url,
        status: r.status,
        result_status: "blocked",
        title: r.title,
        error: `anti_bot_challenge:${r.detected}`,
      });
    } else if (r && r.result_status === "http_error") {
      sources.push({
        source_index: sourceIndex,
        url: r.url,
        final_url: r.final_url,
        status: r.status,
        result_status: "http_error",
        title: "",
        error: r.status ? `${r.reason}:${r.status}` : r.reason,
      });
    } else {
      sources.push({
        source_index: sourceIndex,
        url,
        final_url: url,
        status: 0,
        result_status: "http_error",
        title: "",
        error: r && "error" in r ? r.error : "fetch_failed",
      });
    }
  });

  // 4. All-fail → aggregate error (no passages to return).
  if (okCount === 0) {
    return {
      result_status: "batch_error",
      sources,
      fetched: deduped.length,
      ok: 0,
      failed: deduped.length,
      suggestion:
        deduped.length === 0
          ? "fetch_url({urls:[...]}) requires at least one URL"
          : "every URL failed — retry one with fetch_url({url:...}) to see its error, or check connectivity",
    };
  }

  // 5. Cross-page rank. With a prompt and enough combined text, BM25-rank the
  //    merged passages globally so the strongest across ALL pages win and weak
  //    pages drop out. Otherwise interleave by source so no page dominates.
  let ordered: SourcedPassage[];
  const combinedBytes = Buffer.byteLength(
    merged.map((p) => p.text).join("\n"),
    "utf-8"
  );
  if (query && combinedBytes > BM25_GATE_BYTES && merged.length > 0) {
    ordered = (await rankPassagesByPrompt(merged, {
      prompt: query,
      topK: merged.length,
    })) as SourcedPassage[];
  } else {
    ordered = interleaveBySource(merged);
  }

  // 6. Paginate the merged list. `total` stays the full ranked count so the
  //    agent can page the remainder; wire-cap re-slices `passages` by byte
  //    budget exactly as it does for a single fetch.
  const offset = Math.max(0, shared.offset ?? 0);
  const limit =
    typeof shared.limit === "number" && shared.limit > 0
      ? Math.floor(shared.limit)
      : BATCH_DEFAULT_LIMIT;
  const total = ordered.length;
  const window = (offset > 0 ? ordered.slice(offset) : ordered).slice(0, limit);
  const returned = window.length;
  const moreAvailable = Math.max(0, total - offset - returned);

  const passages: FetchUrlBatchPassage[] = window.map((p, i) => ({
    index: offset + i,
    source_index: p.sourceIndex,
    source_url: p.sourceUrl,
    heading: p.heading,
    text: p.text,
  }));

  return {
    result_status: "ok",
    sources,
    passages,
    total,
    more_available: moreAvailable,
    truncated: moreAvailable > 0,
    fetched: deduped.length,
    ok: okCount,
    failed: deduped.length - okCount,
  };
}

/**
 * A fetch_url request that failed argument validation before any network work.
 * Returned (never thrown) so the agent sees a concrete, paste-ready fix in the
 * tool body instead of an opaque tool failure. Mirrors the `batch_error` shape
 * (status + suggestion) so one body contract covers every fetch_url failure.
 *
 */
export interface FetchUrlInvalidRequest {
  result_status: "invalid_request";
  error: string;
  suggestion: string;
}

function invalidFetchRequest(
  error: string,
  suggestion: string
): FetchUrlInvalidRequest {
  return { result_status: "invalid_request", error, suggestion };
}

/**
 * Strips diagnostic keys from a single-URL ok result before it reaches the
 * agent. Internal computation (batch aggregation, telemetry) reads the full
 * FetchUrlOkInternal shape; this helper is applied only at the public
 * dispatch boundary in runFetchUrlRequest, after all internal use.
 */
function stripFetchUrlWireNoise(r: FetchUrlOkInternal): FetchUrlOk {
  return {
    result_status: r.result_status,
    final_url: r.final_url,
    title: r.title,
    // Provenance only when the source actually shipped it — three `:null`
    // fields on every fetch are pure billed noise. `quality` (playwright/
    // inflated diagnostics) is dropped entirely: it is the fetch analogue of
    // a confidence score the agent never acts on. Both stay on the internal
    // shape for batch aggregation + telemetry; this is the wire boundary.
    ...(r.published_at != null ? { published_at: r.published_at } : {}),
    ...(r.author != null ? { author: r.author } : {}),
    ...(r.site_name != null ? { site_name: r.site_name } : {}),
    word_count: r.word_count,
    passages: r.passages.map((p) => ({
      index: p.index,
      heading: p.heading,
      text: p.text,
    })),
    total: r.total,
  };
}

/**
 * The single live entry point for the `fetch_url` tool: validate the `url` XOR
 * `urls` request shape, then route to the single-page or bulk fetcher. This is
 * the ONE place that decides single-vs-bulk — the QueryRouter `fetch_url` case
 * calls only this, so there is no second copy of the routing/validation logic.
 *
 */
export async function runFetchUrlRequest(
  args: FetchUrlArgs & { urls?: unknown },
  ctx: FetchUrlContext
): Promise<FetchUrlResult | FetchUrlBatchResult | FetchUrlInvalidRequest> {
  const rawUrls = Array.isArray(args.urls) ? args.urls : null;
  const hasUrl = typeof args.url === "string" && args.url.trim().length > 0;
  const shared: Omit<FetchUrlArgs, "url"> = {
    prompt: args.prompt,
    offset: args.offset,
    limit: args.limit,
    token_budget: args.token_budget,
  };

  // Bulk mode — `urls:[...]`. Fan out N pages in one roundtrip, BM25-ranked
  // across all of them. Validation errors return a typed body (no throw).
  if (rawUrls !== null) {
    if (hasUrl) {
      return invalidFetchRequest(
        "fetch_url accepts either url (single page) or urls (bulk), not both.",
        'Pass one: url:"https://..." for a single page, or urls:["https://a","https://b"] for several in one call.'
      );
    }
    const urls = rawUrls.filter(
      (u): u is string => typeof u === "string" && u.trim().length > 0
    );
    if (urls.length === 0) {
      return invalidFetchRequest(
        "fetch_url urls must be a non-empty array of URL strings.",
        'Example: urls:["https://a","https://b"].'
      );
    }
    if (urls.length > FETCH_PROTOCOL_LIMITS.maxBatchUrls) {
      return invalidFetchRequest(
        `fetch_url urls accepts at most ${FETCH_PROTOCOL_LIMITS.maxBatchUrls} URLs (got ${urls.length}).`,
        `Split into ${Math.ceil(
          urls.length / FETCH_PROTOCOL_LIMITS.maxBatchUrls
        )} calls of at most ${FETCH_PROTOCOL_LIMITS.maxBatchUrls} URLs each.`
      );
    }
    return runFetchUrlBatch(urls, shared, ctx);
  }

  // Single mode — `url:"..."`.
  if (!hasUrl) {
    return invalidFetchRequest(
      "fetch_url requires a url or urls argument.",
      'Pass url:"https://..." for one page, or urls:[...] for several in one roundtrip.'
    );
  }
  const result = await runFetchUrl({ url: args.url, ...shared }, ctx);
  if (result.result_status === "ok") return stripFetchUrlWireNoise(result);
  return result;
}

export { safeCompressionRatio } from "./compression-ratio.js";

/**
 * Run jsdom+Defuddle extraction with a hard timeout. A 5MB blob can pin
 * jsdom for 30-120s; without this cap, the daemon stops responding to
 * subsequent MCP calls. On timeout we fall back to a synchronous regex
 * tag-strip so the caller still gets useful text — just structurally
 * weaker than what Defuddle would have produced.
 *
 * Note: jsdom has no abort hook, so the leaked work continues in the
 * background until garbage-collected. Acceptable for the edge case; the
 * far worse alternative is blocking every other tool call for two minutes.
 */
async function extractWithTimeout(
  html: string,
  baseUrl: string,
  hostRule: import("./post-process.js").HostExtractorRule | undefined
): Promise<import("./extract.js").ExtractedContent> {
  try {
    return await withTimeout(
      extractMainContent(html, baseUrl, hostRule),
      FETCH_PROTOCOL_LIMITS.extractionTimeoutMs,
      "extract"
    );
  } catch (e) {
    if (e instanceof ExtractionTimeoutError) {
      return rawBodyFromHtmlSync(html);
    }
    throw e;
  }
}

/**
 * Run Turndown markdown conversion with a hard timeout. Cheap on small
 * inputs but quadratic on pathological HTML (deeply nested lists, etc).
 * On timeout we return a tag-stripped plain-text approximation so the
 * pipeline still produces output.
 */
async function markdownWithTimeout(
  html: string,
  baseUrl: string
): Promise<string> {
  try {
    return await withTimeout(
      htmlToMarkdown(html, baseUrl),
      FETCH_PROTOCOL_LIMITS.extractionTimeoutMs,
      "markdown"
    );
  } catch (e) {
    if (e instanceof ExtractionTimeoutError) {
      return html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    throw e;
  }
}

function makeDeadlineExceededResult(
  requestedUrl: string,
  attemptedUrl: string,
  err: FetchDeadlineExceededError
): FetchUrlHttpError {
  return {
    result_status: "http_error",
    url: requestedUrl,
    final_url: attemptedUrl,
    status: 0,
    reason: "deadline_exceeded",
    suggestion:
      "host did not respond within the 2-minute deadline after exponential retries — host is likely down or rate-limiting; skip this URL or retry much later",
    attempts: err.attempts,
    elapsed_ms: err.elapsedMs,
  };
}

function makeDnsNotFoundResult(
  requestedUrl: string,
  attemptedUrl: string
): FetchUrlHttpError {
  return {
    result_status: "http_error",
    url: requestedUrl,
    final_url: attemptedUrl,
    status: 0,
    reason: "dns_not_found",
    suggestion: `DNS found no record for the host in ${attemptedUrl} (NXDOMAIN) — the domain does not resolve and retrying cannot change that; correct the hostname or skip this URL`,
  };
}

function extractTitleFromHtml(html: string): string {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match?.[1]?.trim() ?? "";
}

function makeBlockedResult(
  requestedUrl: string,
  fetched: FetchedHtml,
  detection: ChallengeDetection
): FetchUrlBlocked {
  return {
    result_status: "blocked",
    url: requestedUrl,
    final_url: fetched.finalUrl,
    status: fetched.status,
    reason: "anti_bot_challenge",
    detected: detection.kind,
    title: extractTitleFromHtml(fetched.html),
    suggestion: detection.suggestion,
  };
}

function makeHttpErrorResult(
  requestedUrl: string,
  fetched: FetchedHtml
): FetchUrlHttpError {
  const status = fetched.status;
  let suggestion: string;
  if (status === 404) {
    suggestion =
      "URL not found — verify the path; the page may have moved or been deleted";
  } else if (status === 401 || status === 403) {
    suggestion =
      "host requires authentication — fetch via an authenticated session or skip this URL";
  } else if (status === 429) {
    suggestion =
      "rate-limited by the host — wait before retrying, or fetch fewer URLs from this host per session";
  } else if (status >= 500 && status < 600) {
    suggestion =
      "host returned a server error — retry later; if the failure persists the host is likely down";
  } else {
    suggestion = `host returned HTTP ${status} — verify the URL and retry, or skip this URL`;
  }
  return {
    result_status: "http_error",
    url: requestedUrl,
    final_url: fetched.finalUrl,
    status,
    reason: "http_status",
    suggestion,
  };
}

async function tryPlaywrightRescue(
  fetched: FetchedHtml,
  config: FetchUrlConfig | undefined,
  detection: ChallengeDetection
): Promise<{ html: string; finalUrl: string; status: number } | null> {
  if (!config?.playwright?.enabled) return null;
  const rendered = await renderWithPlaywright(fetched.finalUrl, config);
  if (!rendered) return null;
  const stillBlocked = detectChallenge(rendered.html);
  if (stillBlocked && stillBlocked.kind === detection.kind) return null;
  return rendered;
}

function upgradeToHttps(url: string): string {
  if (!url.startsWith("http://")) return url;
  try {
    const host = new URL(url).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return url;
    }
  } catch {
    return url;
  }
  return `https://${url.slice(7)}`;
}

interface FetchedHtml {
  html: string;
  finalUrl: string;
  status: number;
  contentType: string;
}

interface FetchHtmlOptions {
  abortSignal?: AbortSignal;
  acceptLanguage?: string;
}

/**
 * Extra grace over a single attempt's per-attempt timeout before the hard
 * wall-clock race trips. Gives fetchHtmlOnce's own AbortController first chance
 * to end the request and surface its real error; the hard race is the backstop
 * for the case that abort CANNOT — a stalled DNS/connect syscall (getaddrinfo
 * runs in the libuv threadpool and is not interruptible mid-flight).
 */
const ATTEMPT_HARD_GRACE_MS = 500;

/** Thrown by {@link raceAttempt} when a single fetch attempt blew its hard
 *  wall-clock ceiling — i.e. the AbortController fired but the underlying
 *  request did not unwind. Treated as a retryable timeout by the fetchHtml
 *  loop, so the total deadline (checked each iteration) still bounds the call. */
class AttemptStalledError extends Error {
  constructor(public timeoutMs: number) {
    super(
      `fetch attempt exceeded ${Math.round(timeoutMs / 1000)}s hard ceiling — abort did not interrupt the request`
    );
    this.name = "AttemptStalledError";
  }
}

/**
 * Hard wall-clock ceiling on a single in-flight fetch attempt.
 *
 * fetchHtml checks `totalDeadlineMs` only BETWEEN attempts, so a single
 * `fetch()` whose AbortController fails to interrupt a stalled DNS/connect
 * syscall can blow far past the ceiling (observed ~960s against an unreachable
 * host in an offline sandbox). Racing the attempt against `ms` guarantees
 * control returns to the loop, which then re-checks the total deadline and
 * fails with a typed `FetchDeadlineExceededError`. The abandoned request settles
 * whenever the syscall finally returns; the timer is `unref`'d + cleared so it
 * never keeps the process alive nor leaks.
 */
async function raceAttempt<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AttemptStalledError(ms)), ms);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Drive the network fetch with exponential per-attempt timeouts capped by a
 * total wall-clock deadline. First attempt waits up to `baseTimeoutMs`; each
 * subsequent attempt doubles, clamped by remaining budget. When the total
 * deadline hits we throw `FetchDeadlineExceededError` so the agent gets a
 * structured "host unreachable" signal instead of a generic tool failure.
 *
 * Retryable failures: AbortError (per-attempt timeout fired), TimeoutError,
 * common transient network errors (ECONNRESET, ETIMEDOUT, EAI_AGAIN, etc.).
 * Non-retryable: ENOTFOUND (NXDOMAIN is a permanent answer — throws
 * `DnsNotFoundError` on the first attempt), content-type mismatch (real
 * failure, won't change on retry), caller-driven abort, anything else.
 *
 * Pacing: an attempt that burned its full per-attempt timeout needs no extra
 * sleep — the next attempt's doubled timeout is the backoff. But an attempt
 * that failed FAST (connection refused/reset in milliseconds) must not loop
 * tightly until the deadline; it sleeps an exponential backoff (250ms·2^n,
 * clamped to its unused attempt slot) before retrying.
 *
 * 4xx/5xx responses are NOT thrown — they come back as `FetchedHtml.status`
 * and bubble out of `runFetchUrl` as a typed `http_status` error. Retrying
 * a 5xx server-side won't help unless the agent waits, which is its choice.
 */
async function fetchHtml(
  url: string,
  opts: FetchHtmlOptions = {}
): Promise<FetchedHtml> {
  const startedAt = Date.now();
  let attempt = 0;
  let lastError: unknown = null;
  while (true) {
    if (opts.abortSignal?.aborted) {
      throw new Error("fetch_url aborted by caller");
    }
    const elapsed = Date.now() - startedAt;
    const remaining = FETCH_PROTOCOL_LIMITS.totalDeadlineMs - elapsed;
    if (remaining <= 0) {
      throw new FetchDeadlineExceededError(elapsed, attempt, lastError);
    }
    const perAttemptMs = Math.min(
      FETCH_PROTOCOL_LIMITS.baseTimeoutMs * 2 ** attempt,
      remaining
    );
    const attemptStartedAt = Date.now();
    try {
      // Hard-race the attempt so a syscall that ignores its AbortController
      // cannot exceed the per-attempt slot — this is what makes totalDeadlineMs
      // actually hold when abort fails to interrupt a stalled DNS/connect.
      return await raceAttempt(
        fetchHtmlOnce(url, opts, perAttemptMs),
        perAttemptMs + ATTEMPT_HARD_GRACE_MS
      );
    } catch (e) {
      lastError = e;
      if (opts.abortSignal?.aborted) throw e;
      // NXDOMAIN is permanent — fail in milliseconds with a typed error
      // instead of re-asking the resolver until the 2-minute deadline
      // (observed: 108k attempts/120s against a non-existent domain).
      if (fetchErrorCode(e) === "ENOTFOUND") {
        throw new DnsNotFoundError(url, e);
      }
      // A stalled attempt (abort ignored) is a retryable timeout — the total
      // deadline re-check at the top of the loop bounds the overall call.
      const stalled = e instanceof AttemptStalledError;
      if (!stalled && !isRetryableFetchError(e)) throw e;
      // A timeout-bound failure consumed its whole attempt slot — the next
      // attempt's doubled timeout IS the backoff, no sleep needed. A FAST
      // failure (connection refused/reset in ms) would otherwise tight-loop;
      // sleep an exponential backoff clamped to the slot it didn't use.
      const attemptElapsed = Date.now() - attemptStartedAt;
      const unusedSlotMs = perAttemptMs - attemptElapsed;
      if (!stalled && unusedSlotMs > 0) {
        const backoffMs = Math.min(250 * 2 ** attempt, unusedSlotMs);
        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
      }
      attempt++;
    }
  }
}

async function fetchHtmlOnce(
  url: string,
  opts: FetchHtmlOptions,
  timeoutMs: number
): Promise<FetchedHtml> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = opts.abortSignal
    ? composeSignals(controller.signal, opts.abortSignal)
    : controller.signal;
  try {
    const res = await fetch(url, {
      signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "unerr-fetch-url/1.0 (+https://unerr.dev) Mozilla/5.0 compatible",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": opts.acceptLanguage ?? "en-US,en;q=0.9",
      },
    });
    const contentType = res.headers.get("content-type") ?? "";
    // Only enforce the HTML content-type guard on successful responses. A 4xx
    // / 5xx error page often comes back as text/plain or JSON — let the
    // typed http_error path surface that with status code intact instead of
    // hiding it behind a generic content-type throw.
    if (
      res.status < 400 &&
      !contentType.includes("html") &&
      !contentType.includes("xml")
    ) {
      throw new Error(
        `fetch_url got non-HTML content-type "${contentType || "unknown"}" from ${url} — use a different tool for this content type (file_read for local files; the Bash tool with curl for raw JSON/binary), or pass a different url that returns HTML`
      );
    }
    const reader = res.body?.getReader();
    if (!reader) {
      const buf = new Uint8Array(await res.arrayBuffer());
      const html = decodeHtmlBytes(buf, contentType);
      return capHtml({
        html,
        finalUrl: res.url,
        status: res.status,
        contentType,
      });
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_HTML_BYTES) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    const merged = concatBytes(chunks);
    const html = decodeHtmlBytes(merged, contentType);
    return capHtml({
      html,
      finalUrl: res.url,
      status: res.status,
      contentType,
    });
  } finally {
    clearTimeout(timer);
  }
}

function capHtml(fetched: FetchedHtml): FetchedHtml {
  if (fetched.html.length > MAX_HTML_BYTES) {
    return { ...fetched, html: fetched.html.slice(0, MAX_HTML_BYTES) };
  }
  return fetched;
}

function composeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  else {
    a.addEventListener("abort", onAbort, { once: true });
    b.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

/**
 * Measure "meaningful content bytes" for compression-ratio reporting.
 * Strips inline executable `<script>`, `<style>`, HTML comments, and runs of
 * whitespace — the bytes a markdown extractor will discard anyway. SSR data
 * containers (Next.js `__NEXT_DATA__`, Nuxt `__NUXT__`, `__NEXT_F`, any
 * `<script type="application/json">` or `type="application/ld+json">`) are
 * KEPT because Defuddle/Readability recover content from them — stripping
 * them before measuring makes raw_bytes artificially small and produces
 * negative (inflated) compression_ratios on SPAs that hydrate content from
 * script-tag JSON. Used for the `raw_bytes` and compression-ratio fields in
 * the response envelope and telemetry — NOT for the upstream MAX_HTML_BYTES
 * cap.
 */
function meaningfulHtmlBytes(html: string): number {
  const stripped = html
    .replace(SCRIPT_BLOCK_RE, (full, attrs: string) =>
      isSsrDataScript(attrs) ? full : ""
    )
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ");
  return Buffer.byteLength(stripped, "utf-8");
}

const SCRIPT_BLOCK_RE = /<script\b([^>]*)>[\s\S]*?<\/script>/gi;

/**
 * True when a `<script>` opening tag's attrs identify it as a server-side
 * data container rather than executable JS. The framework-specific id list
 * covers the common SSR layouts; the `type="application/json"` /
 * `application/ld+json` check is the generic fallback. Case-insensitive
 * because frameworks sometimes ship attrs as `ID=` etc.
 */
function isSsrDataScript(attrs: string): boolean {
  const a = attrs.toLowerCase();
  if (
    /id\s*=\s*["']?(__next_data__|__next_f|__nuxt__|__nuxt_data__|__remix_context__|__sapper__|__svelte_kit_payload__|serverside-data|__apollo_state__|server-data|__static_data__)["']?/i.test(
      a
    )
  ) {
    return true;
  }
  if (/type\s*=\s*["']application\/(json|ld\+json)["']/i.test(a)) {
    return true;
  }
  return false;
}

function safeLoadSettings(cwd: string): ReturnType<typeof loadSettings> | null {
  try {
    return loadSettings(cwd);
  } catch {
    return null;
  }
}

/**
 * Decode HTML bytes with charset detection. Priority: Content-Type header
 * charset → `<meta charset>` in first 2KB → utf8 fallback. Without this,
 * non-utf8 pages (legacy European iso-8859-1, CJK gb2312/shift_jis/big5) come
 * back mojibake because the TextDecoder silently substitutes replacement
 * characters. Modeled on Firecrawl's engines/fetch charset chain. Encodings
 * not recognized by Node's built-in TextDecoder fall back to utf-8 — better
 * than throwing on an exotic charset.
 */
export function decodeHtmlBytes(
  bytes: Uint8Array,
  contentType: string
): string {
  const fromHeader = parseCharsetFromContentType(contentType);
  if (fromHeader) {
    const decoded = tryDecode(bytes, fromHeader);
    if (decoded !== null) return decoded;
  }
  // Sniff first 2KB as ASCII to find a <meta charset=...> declaration. The
  // declaration itself is always ASCII-safe so a utf-8 decode of the head is
  // sufficient to read it.
  const head = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(0, Math.min(bytes.byteLength, 2048))
  );
  const fromMeta = parseCharsetFromMetaHead(head);
  if (fromMeta) {
    const decoded = tryDecode(bytes, fromMeta);
    if (decoded !== null) return decoded;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function parseCharsetFromContentType(contentType: string): string | null {
  const match = contentType.match(/charset\s*=\s*"?([\w-]+)"?/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function parseCharsetFromMetaHead(head: string): string | null {
  const meta5 = head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i);
  if (meta5?.[1]) return meta5[1].toLowerCase();
  const meta4 = head.match(
    /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i
  );
  return meta4?.[1]?.toLowerCase() ?? null;
}

function tryDecode(bytes: Uint8Array, charset: string): string | null {
  const normalized = charset.toLowerCase();
  if (
    normalized === "utf-8" ||
    normalized === "utf8" ||
    normalized === "us-ascii" ||
    normalized === "ascii"
  ) {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
  try {
    return new TextDecoder(normalized, { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
