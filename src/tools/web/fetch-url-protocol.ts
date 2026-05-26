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
  bumpCacheHit,
  hashHtml,
  lookupFetchCache,
  storeFetchCache,
  storeNegativeFetchCache,
  summarizeMarkdownDiff,
} from "./diff-cache.js";
import {
  type ExtractedMeta,
  extractMainContent,
  extractMeta,
  rawBodyFromHtmlSync,
} from "./extract.js";
import { htmlToMarkdown } from "./markdown.js";
import { splitMarkdownIntoPassages } from "./passage-split.js";
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
  /**
   * When true, skip the stale-while-revalidate shortcut even if a fresh cache
   * entry exists. Use this when the caller knows the page changed and wants
   * an authoritative re-fetch. Negative-cache short-circuit is still honored
   * (a host that was blocked stays blocked until its negative TTL elapses).
   */
  refresh?: boolean;
}

export interface FetchUrlOk {
  result_status: "ok";
  url: string;
  final_url: string;
  status: number;
  title: string;
  /**
   * OG / article:* / dc:* metadata pulled from raw HTML. Null when the
   * source doesn't ship the corresponding tag (most static pages omit
   * article:published_time; many sites have no og:site_name). Use for
   * agent-side dating, cross-doc correlation, and provenance display.
   */
  published_at: string | null;
  author: string | null;
  og_type: string | null;
  site_name: string | null;
  favicon: string | null;
  extractor: "defuddle" | "readability" | "raw-body" | "cache";
  word_count: number;
  raw_bytes: number;
  extracted_bytes: number;
  /** Real BPE token count of the raw page (estimateTokens, heuristic >50k chars). */
  raw_tokens: number;
  /** Real BPE token count of the extracted markdown delivered. */
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
  /**
   * Per-call quality signals. The agent inspects this to decide whether a
   * retry-with-prompt would help (low `word_count` + `playwright_rescued:false`
   * usually means "page is short, no point retrying") and the dashboard
   * surfaces aggregate stats. All fields are non-undefined so the schema
   * is stable across calls.
   */
  quality: {
    playwright_rescued: boolean;
    bm25_ranked: boolean;
    rule_applied: string | null;
    /**
     * True when extracted_bytes ≥ raw_bytes — i.e. extraction recovered
     * more text than the meaningful-bytes measurement counted. Happens on
     * SPAs that hydrate content from JSON script tags Defuddle can read but
     * the byte counter can't tell apart from sidecar payloads. The reported
     * `compression_ratio` is clamped to 0 in this case so it doesn't mislead;
     * the flag tells the agent the metric was unreliable for this page.
     */
    inflated: boolean;
  };
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
  reason: "http_status" | "deadline_exceeded";
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

export type FetchUrlResult = FetchUrlOk | FetchUrlBlocked | FetchUrlHttpError;

export interface FetchUrlContext {
  cwd: string;
  abortSignal?: AbortSignal;
}

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const BM25_GATE_BYTES = 8 * 1024;
const BM25_DEFAULT_TOPK = 20;

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

function isRetryableFetchError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  const msg = e.message ?? "";
  return (
    msg.includes("ENOTFOUND") ||
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
): Promise<FetchUrlResult> {
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
  // post-redirect rule wins for extractor + cache + playwright decisions.
  const initialRule = lookupHostRule(url);

  // Stale-while-revalidate + negative-cache short-circuit. Try the cache
  // BEFORE the network when the host rule hasn't opted out (`bypassCache`).
  // A `fresh` row younger than FRESH_TTL_MS replaces the network call
  // entirely; a `negative` row replays the prior blocked verdict instead of
  // re-hammering a host we already know is gated.
  if (!initialRule?.behavior?.bypassCache) {
    const early = lookupFetchCache(ctx.cwd, url);
    if (early.hit && early.prior) {
      if (early.negative) {
        return makeBlockedResultFromCache(args.url, url, early.prior);
      }
      if (early.fresh && !args.refresh) {
        bumpCacheHit(ctx.cwd, url);
        return makeFreshHitResult(args, url, early.prior);
      }
    }
  }

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
      });
      const blockedTitle = extractTitleFromHtml(fetched.html);
      storeNegativeFetchCache(
        ctx.cwd,
        url,
        initialChallenge.kind,
        blockedTitle
      );
      if (fetched.finalUrl !== url) {
        storeNegativeFetchCache(
          ctx.cwd,
          fetched.finalUrl,
          initialChallenge.kind,
          blockedTitle
        );
      }
      return makeBlockedResult(args.url, fetched, initialChallenge);
    }
  }

  const contentHash = hashHtml(fetched.html);
  const cache = hostRule?.behavior?.bypassCache
    ? { hit: false, prior: null, fresh: false, negative: false }
    : lookupFetchCache(ctx.cwd, fetched.finalUrl);

  let markdown: string;
  let title: string;
  let extractor: FetchUrlOk["extractor"];
  let wordCount: number;
  let cacheHit = false;
  let diff: FetchUrlOk["diff"];
  let meta: ExtractedMeta;

  if (cache.hit && cache.prior && cache.prior.content_hash === contentHash) {
    markdown = cache.prior.markdown;
    title = cache.prior.title;
    extractor = "cache";
    wordCount = markdown.trim().split(/\s+/).filter(Boolean).length;
    cacheHit = true;
    diff = {
      unchanged: true,
      changed_regions: 0,
      added_lines: 0,
      removed_lines: 0,
    };
    meta = {
      published_at: cache.prior.published_at,
      author: cache.prior.author,
      og_type: cache.prior.og_type,
      site_name: cache.prior.site_name,
      favicon: cache.prior.favicon,
    };
    bumpCacheHit(ctx.cwd, fetched.finalUrl);
  } else {
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
    if (cache.prior) {
      const summary = summarizeMarkdownDiff(cache.prior.markdown, markdown);
      diff = {
        unchanged: summary.unchanged,
        changed_regions: summary.changedRegions,
        added_lines: summary.addedLines,
        removed_lines: summary.removedLines,
      };
    }
    storeFetchCache(ctx.cwd, {
      url: fetched.finalUrl,
      content_hash: contentHash,
      markdown,
      title,
      extractor,
      raw_bytes: Buffer.byteLength(fetched.html, "utf-8"),
      compressed_bytes: Buffer.byteLength(markdown, "utf-8"),
      fetched_at: Date.now(),
      published_at: meta.published_at,
      author: meta.author,
      og_type: meta.og_type,
      site_name: meta.site_name,
      favicon: meta.favicon,
    });
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
  const sliced = offset > 0 ? ranked.slice(offset) : ranked;

  const rawBytes = meaningfulHtmlBytes(fetched.html);
  const compressedBytes = byteLength(markdown);

  recordFetchUrlTelemetry(ctx.cwd, {
    url: fetched.finalUrl,
    rawBytes,
    compressedBytes,
    durationMs: Date.now() - started,
    extractor: extractor === "cache" ? "raw-body" : extractor,
    cacheHit,
    playwrightRescued,
    bm25Ranked,
    wordCount,
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
  };
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

function makeBlockedResultFromCache(
  requestedUrl: string,
  finalUrl: string,
  prior: { title: string; blocked_reason: string | null }
): FetchUrlBlocked {
  const kind = (prior.blocked_reason ?? "cloudflare") as
    | "cloudflare"
    | "hcaptcha"
    | "perimeterx";
  return {
    result_status: "blocked",
    url: requestedUrl,
    final_url: finalUrl,
    status: 0,
    reason: "anti_bot_challenge",
    detected: kind,
    title: prior.title,
    suggestion:
      "host returned a blocked status within the last 30 minutes — retry later or fetch via an authenticated session",
  };
}

function makeFreshHitResult(
  args: FetchUrlArgs,
  finalUrl: string,
  prior: {
    title: string;
    markdown: string;
    raw_bytes: number;
    compressed_bytes: number;
    published_at: string | null;
    author: string | null;
    og_type: string | null;
    site_name: string | null;
    favicon: string | null;
  }
): FetchUrlOk {
  const passages = splitMarkdownIntoPassages(prior.markdown).map((p) => ({
    index: p.index,
    heading: p.heading,
    text: p.text,
    start_line: p.startLine,
  }));
  const offset = Math.max(0, args.offset ?? 0);
  const sliced = offset > 0 ? passages.slice(offset) : passages;
  const wordCount = prior.markdown.trim().split(/\s+/).filter(Boolean).length;
  return {
    result_status: "ok",
    url: args.url,
    final_url: finalUrl,
    status: 200,
    title: prior.title,
    published_at: prior.published_at,
    author: prior.author,
    og_type: prior.og_type,
    site_name: prior.site_name,
    favicon: prior.favicon,
    extractor: "cache",
    word_count: wordCount,
    cache_hit: true,
    diff: {
      unchanged: true,
      changed_regions: 0,
      added_lines: 0,
      removed_lines: 0,
    },
    raw_bytes: prior.raw_bytes,
    extracted_bytes: prior.compressed_bytes,
    // Raw HTML isn't persisted in the cache, so the raw side falls back to the
    // byte/4 heuristic; the delivered markdown is tokenized for real.
    raw_tokens: Math.ceil(prior.raw_bytes / 4),
    extracted_tokens: estimateTokens(prior.markdown),
    compression_ratio:
      prior.raw_bytes > 0
        ? Math.round((1 - prior.compressed_bytes / prior.raw_bytes) * 100) / 100
        : 0,
    passages: sliced,
    total: passages.length,
    quality: {
      playwright_rescued: false,
      bm25_ranked: false,
      rule_applied: null,
      inflated: false,
    },
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
  return "https://" + url.slice(7);
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
 * Drive the network fetch with exponential per-attempt timeouts capped by a
 * total wall-clock deadline. First attempt waits up to `baseTimeoutMs`; each
 * subsequent attempt doubles, clamped by remaining budget. When the total
 * deadline hits we throw `FetchDeadlineExceededError` so the agent gets a
 * structured "host unreachable" signal instead of a generic tool failure.
 *
 * Retryable failures: AbortError (per-attempt timeout fired), TimeoutError,
 * common transient network errors (ENOTFOUND, ECONNRESET, ETIMEDOUT, etc.).
 * Non-retryable: content-type mismatch (real failure, won't change on retry),
 * caller-driven abort, anything else.
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
    try {
      return await fetchHtmlOnce(url, opts, perAttemptMs);
    } catch (e) {
      lastError = e;
      if (opts.abortSignal?.aborted) throw e;
      if (!isRetryableFetchError(e)) throw e;
      attempt++;
      // No artificial sleep — the next attempt's larger timeout IS the
      // backoff. A failed 15s attempt followed by a 30s attempt is already
      // 45s of breathing room for a flaky upstream.
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
