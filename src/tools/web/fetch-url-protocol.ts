/**
 * fetch_url runtime: fetch HTML → extract main content → markdown → passages →
 * telemetry. Returns a wire-cap-shaped body with a `passages` array so
 * applyWireCap can paginate via offset/limit and FU-3 can BM25-rank in place.
 */

import { loadSettings } from "../../config/settings.js";
import { rankPassagesByPrompt } from "./bm25-rank.js";
import {
  bumpCacheHit,
  hashHtml,
  lookupFetchCache,
  storeFetchCache,
  summarizeMarkdownDiff,
} from "./diff-cache.js";
import { extractMainContent } from "./extract.js";
import { htmlToMarkdown } from "./markdown.js";
import { splitMarkdownIntoPassages } from "./passage-split.js";
import { postProcessMarkdown } from "./post-process.js";
import {
  renderWithPlaywright,
  shouldUsePlaywright,
} from "./spa-render.js";
import { recordFetchUrlTelemetry } from "./telemetry.js";

export interface FetchUrlArgs {
  url: string;
  prompt?: string;
  offset?: number;
  limit?: number;
  token_budget?: number;
}

export interface FetchUrlResult {
  url: string;
  final_url: string;
  status: number;
  title: string;
  extractor: "defuddle" | "readability" | "raw-body" | "cache";
  word_count: number;
  raw_bytes: number;
  extracted_bytes: number;
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
}

export interface FetchUrlContext {
  cwd: string;
  abortSignal?: AbortSignal;
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const BM25_GATE_BYTES = 8 * 1024;
const BM25_DEFAULT_TOPK = 20;

function shouldRank(args: FetchUrlArgs, markdown: string): boolean {
  if (!args.prompt || args.prompt.trim().length === 0) return false;
  return Buffer.byteLength(markdown, "utf-8") > BM25_GATE_BYTES;
}

export async function runFetchUrl(
  args: FetchUrlArgs,
  ctx: FetchUrlContext
): Promise<FetchUrlResult> {
  if (!args.url || typeof args.url !== "string") {
    throw new Error("fetch_url requires a string `url` argument");
  }
  const url = upgradeToHttps(args.url);
  const started = Date.now();

  const fetched = await fetchHtml(url, ctx.abortSignal);
  const contentHash = hashHtml(fetched.html);
  const cache = lookupFetchCache(ctx.cwd, fetched.finalUrl);

  let markdown: string;
  let title: string;
  let extractor: FetchUrlResult["extractor"];
  let wordCount: number;
  let cacheHit = false;
  let diff: FetchUrlResult["diff"];

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
    bumpCacheHit(ctx.cwd, fetched.finalUrl);
  } else {
    let extracted = await extractMainContent(fetched.html, fetched.finalUrl);
    const settings = safeLoadSettings(ctx.cwd);
    if (
      shouldUsePlaywright({
        config: settings?.fetchUrl,
        extractor: extracted.extractor,
        wordCount: extracted.wordCount,
      }) &&
      settings
    ) {
      const rendered = await renderWithPlaywright(
        fetched.finalUrl,
        settings.fetchUrl
      );
      if (rendered) {
        fetched.html = rendered.html;
        fetched.finalUrl = rendered.finalUrl;
        fetched.status = rendered.status;
        extracted = await extractMainContent(rendered.html, rendered.finalUrl);
      }
    }
    const rawMarkdown = await htmlToMarkdown(extracted.contentHtml);
    markdown = postProcessMarkdown(rawMarkdown, { url: fetched.finalUrl });
    title = extracted.title;
    extractor = extracted.extractor;
    wordCount = extracted.wordCount;
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
    });
  }

  const allPassages = splitMarkdownIntoPassages(markdown);

  const ranked = shouldRank(args, markdown)
    ? await rankPassagesByPrompt(allPassages, {
        prompt: args.prompt ?? "",
        topK: args.limit ?? BM25_DEFAULT_TOPK,
      })
    : allPassages;

  const offset = Math.max(0, args.offset ?? 0);
  const sliced = offset > 0 ? ranked.slice(offset) : ranked;

  const rawBytes = byteLength(fetched.html);
  const compressedBytes = byteLength(markdown);

  recordFetchUrlTelemetry(ctx.cwd, {
    url: fetched.finalUrl,
    rawBytes,
    compressedBytes,
    durationMs: Date.now() - started,
    extractor: extractor === "cache" ? "raw-body" : extractor,
    cacheHit,
  });

  return {
    url: args.url,
    final_url: fetched.finalUrl,
    status: fetched.status,
    title,
    extractor,
    word_count: wordCount,
    cache_hit: cacheHit,
    diff,
    raw_bytes: rawBytes,
    extracted_bytes: compressedBytes,
    compression_ratio:
      rawBytes > 0
        ? Math.round((1 - compressedBytes / rawBytes) * 100) / 100
        : 0,
    passages: sliced.map((p) => ({
      index: p.index,
      heading: p.heading,
      text: p.text,
      start_line: p.startLine,
    })),
    total: allPassages.length,
  };
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

async function fetchHtml(
  url: string,
  abortSignal?: AbortSignal
): Promise<FetchedHtml> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const signal = abortSignal
    ? composeSignals(controller.signal, abortSignal)
    : controller.signal;
  try {
    const res = await fetch(url, {
      signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "unerr-fetch-url/1.0 (+https://unerr.dev) Mozilla/5.0 compatible",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("html") && !contentType.includes("xml")) {
      throw new Error(
        `fetch_url expected HTML response, got content-type: ${contentType || "unknown"}`
      );
    }
    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      return capHtml({
        html: text,
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
    const html = new TextDecoder("utf-8", { fatal: false }).decode(merged);
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

function safeLoadSettings(
  cwd: string
): ReturnType<typeof loadSettings> | null {
  try {
    return loadSettings(cwd);
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
