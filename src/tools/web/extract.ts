/**
 * Main-content extraction for fetched HTML.
 *
 * Pipeline: universal chrome pre-strip → host-rule shape → Defuddle
 * (primary) → @mozilla/readability (fallback) → raw <body>.
 * jsdom/defuddle/readability are lazy-loaded so they don't bloat startup.
 *
 * Universal pre-strip (applied to every page unless the host rule sets
 * `skipUniversalStrip:true`): drops the obvious semantic-chrome wrappers
 * (header/footer/nav/aside, plus common chrome class/id patterns) that
 * Defuddle would otherwise mistake for content. Two escape hatches:
 *   - skip nodes nested inside <main>/<article> (article-internal nav is
 *     content, e.g. doc-page in-article TOC)
 *   - skip nodes that wrap a main-content landmark (#main, #content, main,
 *     article, .markdown-body, .prose, .post-content)
 *
 * Per-host overrides (HostExtractorRule) apply AFTER the universal pass:
 *   - `removeSelectors`: dropped from the DOM before extraction
 *   - `contentSelectors`: replace the body with the first match before
 *     extraction (use sparingly — page layouts drift)
 *   - `prefer`: skip straight to a specific extractor instead of the chain
 *   - `skipUniversalStrip`: bypass the universal chrome pre-strip
 */

import type { HostExtractorRule } from "./post-process.js";

export interface ExtractedContent {
  title: string;
  contentHtml: string;
  wordCount: number;
  byline?: string;
  excerpt?: string;
  lang?: string;
  extractor: "defuddle" | "readability" | "raw-body";
}

/**
 * Open Graph / Dublin Core / article:* metadata pulled from raw HTML.
 * Surfaces in FetchUrlOk so agents can date docs, attribute authors, and
 * pick the right doc page when correlating across multiple sources. All
 * fields nullable: many pages omit them.
 */
export interface ExtractedMeta {
  published_at: string | null;
  author: string | null;
  og_type: string | null;
  site_name: string | null;
  favicon: string | null;
}

const MIN_USEFUL_CHARS = 200;

/**
 * Above this raw HTML size, skip jsdom+Defuddle entirely and use a regex
 * tag-strip. Rationale: a 5MB HTML blob pins jsdom for 15-30s walking the
 * CSS tree, even though the agent only ever consumes the paginated wire
 * response. Sync raw-body extraction runs in ~regex-strip time (≪1s) and
 * produces the same shape, so the agent still gets paginated passages.
 * Host rules with an explicit `prefer` override this — if a caller has
 * asked for defuddle/readability, they meant it.
 */
const LARGE_HTML_THRESHOLD = 2 * 1024 * 1024;

/**
 * Synchronous regex-based extractor. Strips scripts/styles/comments/tags
 * without instantiating a DOM. Used in two places: as the
 * extraction-timeout fallback in fetch-url-protocol, and as the
 * large-input short-circuit in `extractMainContent`. Exported so both
 * callers share one implementation (avoiding a circular import).
 */
export function rawBodyFromHtmlSync(html: string): ExtractedContent {
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? "";
  const words = stripped ? stripped.split(/\s+/).filter(Boolean) : [];
  return {
    extractor: "raw-body",
    title,
    contentHtml: `<div>${stripped.replace(/[&<>]/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"
    )}</div>`,
    byline: undefined,
    wordCount: words.length,
  };
}

/**
 * Generic semantic-chrome selectors. Modeled on Firecrawl's
 * `excludeNonMainTags` (apps/api/src/scraper/scrapeURL/lib/
 * removeUnwantedElements.ts) — the universal set that handles ~96% of the
 * web without per-host configuration.
 */
const UNIVERSAL_CHROME_SELECTORS: ReadonlyArray<string> = [
  "header",
  "footer",
  "nav",
  "aside",
  ".header",
  ".footer",
  ".sidebar",
  ".navbar",
  ".menu",
  ".navigation",
  ".breadcrumbs",
  ".cookie",
  ".modal",
  ".popup",
  ".overlay",
  ".ad",
  ".ads",
  ".advert",
  ".share",
  ".widget",
  ".lang-selector",
  ".language",
  ".social",
  ".social-media",
  "#header",
  "#footer",
  "#sidebar",
  "#nav",
  "#breadcrumbs",
  "#cookie",
];

/**
 * Selectors that protect a chrome-named element from removal when it
 * wraps actual content (rare but real — some sites stuff `<main>` inside
 * `<nav>` or `<aside>`).
 */
const FORCE_KEEP_SELECTORS: ReadonlyArray<string> = [
  "#content",
  "#main",
  "main",
  "article",
  ".markdown-body",
  ".prose",
  ".post-content",
];

export async function extractMainContent(
  html: string,
  baseUrl: string,
  hostRule?: HostExtractorRule
): Promise<ExtractedContent> {
  // Large-input short-circuit. Skip jsdom entirely when the page is huge
  // AND the caller hasn't explicitly asked for a specific extractor. Bounds
  // extraction work to regex-strip latency regardless of input size; the
  // downstream wire-cap paginates passages either way so the agent gets the
  // same shape.
  if (html.length > LARGE_HTML_THRESHOLD && !hostRule?.prefer) {
    return rawBodyFromHtmlSync(html);
  }

  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(html, { url: baseUrl });

  applyUniversalStrip(dom, hostRule?.skipUniversalStrip === true);
  if (hostRule) applyHostShape(dom, hostRule);

  if (hostRule?.prefer === "raw-body") {
    return rawBodyFallback(dom);
  }
  if (hostRule?.prefer === "readability") {
    const r = await tryReadability(dom);
    if (r && stripTags(r.contentHtml).length >= MIN_USEFUL_CHARS) return r;
    return rawBodyFallback(dom);
  }
  if (hostRule?.prefer === "defuddle") {
    const d = await tryDefuddle(dom);
    if (d && stripTags(d.contentHtml).length >= MIN_USEFUL_CHARS) return d;
    return rawBodyFallback(dom);
  }

  const defuddled = await tryDefuddle(dom);
  if (
    defuddled &&
    stripTags(defuddled.contentHtml).length >= MIN_USEFUL_CHARS
  ) {
    return defuddled;
  }

  const readabilityResult = await tryReadability(dom);
  if (
    readabilityResult &&
    stripTags(readabilityResult.contentHtml).length >= MIN_USEFUL_CHARS
  ) {
    return readabilityResult;
  }

  return rawBodyFallback(dom);
}

function applyUniversalStrip(dom: import("jsdom").JSDOM, skip: boolean): void {
  if (skip) return;
  const doc = dom.window.document;
  for (const sel of UNIVERSAL_CHROME_SELECTORS) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = doc.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const node of nodes) {
      if (!node.isConnected) continue;
      if (node.closest("main, article")) continue;
      if (FORCE_KEEP_SELECTORS.some((s) => node.querySelector(s))) continue;
      node.remove();
    }
  }
}

function applyHostShape(
  dom: import("jsdom").JSDOM,
  rule: HostExtractorRule
): void {
  const doc = dom.window.document;
  if (rule.removeSelectors?.length) {
    for (const sel of rule.removeSelectors) {
      try {
        for (const node of doc.querySelectorAll(sel)) node.remove();
      } catch {
        // ignore invalid selector — best-effort
      }
    }
  }
  if (rule.contentSelectors?.length) {
    for (const sel of rule.contentSelectors) {
      try {
        const match = doc.querySelector(sel);
        if (match && doc.body) {
          doc.body.innerHTML = match.outerHTML;
          break;
        }
      } catch {
        // ignore invalid selector
      }
    }
  }
}

// Defuddle noise instrumentation — counts every suppressed selector error
// via a process-wide sink (BehaviorEventWriter, wired in proxy.ts) and
// emits one summary line per distinct signature so users still know which
// nwsapi-rejected selector is firing.
export type DefuddleNoiseSink = (
  signature: string,
  firstOccurrence: boolean
) => void;
const seenDefuddleSignatures = new Set<string>();
let defuddleNoiseSink: DefuddleNoiseSink | null = null;

export function setDefuddleNoiseSink(sink: DefuddleNoiseSink | null): void {
  defuddleNoiseSink = sink;
}

/** Test-only: reset module state between cases. */
export function _resetDefuddleNoiseState(): void {
  seenDefuddleSignatures.clear();
  defuddleNoiseSink = null;
}

function defuddleSignatureFromParts(parts: unknown[]): string {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p instanceof Error) return p.message || String(p);
    if (
      p &&
      typeof p === "object" &&
      "message" in p &&
      typeof (p as { message: unknown }).message === "string"
    ) {
      return (p as { message: string }).message;
    }
  }
  return typeof parts[0] === "string" ? parts[0] : "unknown";
}

/**
 * Walk every stylesheet on the document and drop rules whose selector
 * nwsapi can't compile (Tailwind 4 arbitrary-value classes like
 * `:text-foreground *`, React Aria IDs like `#react-aria-:R...`,
 * malformed selectors like `:has(p+p)):not(:has(img)`). Defuddle's CSS
 * analysis would otherwise call `querySelectorAll(rule.selectorText)`
 * on each rule and trigger a SyntaxError per offender. We pre-validate
 * with `matches()` on a throwaway element so the bad rule is gone
 * before defuddle ever sees it. defuddle's *own* internal selectors
 * (the `:not(:has(p + p))` family) are out of scope here — those fire
 * inside defuddle's traversal regardless of stylesheet state and remain
 * covered by the noise counter below.
 */
function pruneUnparseableStyleRules(dom: import("jsdom").JSDOM): void {
  const doc = dom.window.document;
  const probe = doc.createElement("div");
  const sheets = doc.styleSheets;
  for (let s = 0; s < sheets.length; s++) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheets[s]?.cssRules ?? null;
    } catch {
      // cross-origin or otherwise inaccessible; skip
      continue;
    }
    if (!rules) continue;
    // Iterate backwards so deleteRule() doesn't shift remaining indices.
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i] as CSSRule & { selectorText?: string };
      const sel = rule?.selectorText;
      if (typeof sel !== "string" || sel.length === 0) continue;
      try {
        probe.matches(sel);
      } catch {
        try {
          (sheets[s] as CSSStyleSheet).deleteRule(i);
        } catch {
          /* read-only sheet — best effort, defuddle will still emit
             a single Error per offender which the counter absorbs */
        }
      }
    }
  }
}

async function tryDefuddle(
  dom: import("jsdom").JSDOM
): Promise<ExtractedContent | null> {
  // Two-layer noise control:
  //   1. pruneUnparseableStyleRules() — engine-level fix. Drops page
  //      stylesheet rules whose selectors nwsapi rejects, so defuddle's
  //      CSS analysis never asks jsdom to compile them. Eliminates the
  //      Tailwind 4 / React Aria SyntaxError stream at the source.
  //   2. console.error/log filter — covers what (1) can't: defuddle's
  //      *internal* selectors (e.g. `header:not(:has(p+p)):not(:has(img))`)
  //      that fire inside defuddle's own traversal regardless of input
  //      stylesheet state. Counted via the sink, summarized once per
  //      signature on stderr.
  pruneUnparseableStyleRules(dom);

  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  const isDefuddleNoise = (parts: unknown[]): boolean => {
    const head = typeof parts[0] === "string" ? parts[0] : "";
    return (
      head.startsWith("Defuddle") ||
      head.startsWith("Error: Could not parse CSS stylesheet")
    );
  };
  const handleNoise = (
    parts: unknown[],
    rawWriter: (...args: unknown[]) => void
  ): void => {
    const signature = defuddleSignatureFromParts(parts);
    const firstOccurrence = !seenDefuddleSignatures.has(signature);
    if (firstOccurrence) {
      seenDefuddleSignatures.add(signature);
      rawWriter(
        `[unerr] defuddle: ${signature} — suppressed (further occurrences counted only)`
      );
    }
    try {
      defuddleNoiseSink?.(signature, firstOccurrence);
    } catch {
      /* sink must never break extraction */
    }
  };
  console.error = (...parts: unknown[]) => {
    if (isDefuddleNoise(parts)) {
      handleNoise(parts, (...a) => originalConsoleError.apply(console, a));
      return;
    }
    originalConsoleError.apply(console, parts);
  };
  console.log = (...parts: unknown[]) => {
    if (isDefuddleNoise(parts)) {
      handleNoise(parts, (...a) => originalConsoleLog.apply(console, a));
      return;
    }
    originalConsoleLog.apply(console, parts);
  };

  try {
    const mod = (await import("defuddle")) as unknown as {
      default: new (
        doc: Document,
        opts?: { markdown?: boolean }
      ) => {
        parse(): {
          content: string | null;
          title?: string;
          description?: string;
          author?: string;
          wordCount?: number;
        };
      };
    };
    const DefuddleCtor = mod.default;
    const doc = dom.window.document as unknown as Document;
    const result = new DefuddleCtor(doc, { markdown: false }).parse();
    if (!result?.content) return null;
    return {
      title: result.title ?? "",
      contentHtml: result.content,
      wordCount: result.wordCount ?? wordCountOf(result.content),
      byline: result.author ?? undefined,
      excerpt: result.description ?? undefined,
      extractor: "defuddle",
    };
  } catch {
    return null;
  } finally {
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
  }
}

async function tryReadability(
  dom: import("jsdom").JSDOM
): Promise<ExtractedContent | null> {
  try {
    const mod = await import("@mozilla/readability");
    const doc = dom.window.document as unknown as Document;
    if (mod.isProbablyReaderable && !mod.isProbablyReaderable(doc)) {
      return null;
    }
    const article = new mod.Readability(
      doc
    ).parse() as ReadabilityArticle | null;
    if (!article?.content) return null;
    return {
      title: article.title ?? "",
      contentHtml: article.content,
      wordCount: wordCountOf(article.textContent ?? article.content),
      byline: article.byline ?? undefined,
      excerpt: article.excerpt ?? undefined,
      lang: article.lang ?? undefined,
      extractor: "readability",
    };
  } catch {
    return null;
  }
}

function rawBodyFallback(dom: import("jsdom").JSDOM): ExtractedContent {
  const doc = dom.window.document;
  for (const sel of ["script", "style", "noscript", "iframe", "svg"]) {
    for (const node of doc.querySelectorAll(sel)) node.remove();
  }
  const main =
    doc.querySelector("main") ??
    doc.querySelector("article") ??
    doc.body ??
    doc.documentElement;
  const html = main?.innerHTML ?? "";
  return {
    title: doc.title ?? "",
    contentHtml: html,
    wordCount: wordCountOf(main?.textContent ?? ""),
    extractor: "raw-body",
  };
}

/**
 * Pull OG / article / Dublin Core metadata out of raw HTML. Regex-based —
 * cheaper than re-traversing jsdom and tolerant of malformed pages that
 * still ship usable meta tags. Falls back through several sources per field
 * so a site that uses only one convention (article:author vs meta[name=author])
 * still surfaces. Favicon resolved against finalUrl so it's a usable absolute
 * URL for clients that want to render it.
 */
export function extractMeta(html: string, finalUrl: string): ExtractedMeta {
  const head = html.length > 16_384 ? html.slice(0, 16_384) : html;
  const meta = (
    selectors: ReadonlyArray<{ attr: string; key: string }>
  ): string | null => {
    for (const { attr, key } of selectors) {
      // <meta property="og:title" content="..."> AND <meta content="..." property="...">
      const re1 = new RegExp(
        `<meta[^>]+${attr}\\s*=\\s*["']${escapeRegExp(key)}["'][^>]*content\\s*=\\s*["']([^"']+)["']`,
        "i"
      );
      const m1 = head.match(re1);
      if (m1?.[1]) return decodeEntities(m1[1].trim());
      const re2 = new RegExp(
        `<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]*${attr}\\s*=\\s*["']${escapeRegExp(key)}["']`,
        "i"
      );
      const m2 = head.match(re2);
      if (m2?.[1]) return decodeEntities(m2[1].trim());
    }
    return null;
  };
  const published =
    meta([
      { attr: "property", key: "article:published_time" },
      { attr: "property", key: "og:article:published_time" },
      { attr: "name", key: "article:published_time" },
      { attr: "name", key: "DC.date.issued" },
      { attr: "name", key: "dc.date.issued" },
      { attr: "name", key: "pubdate" },
      { attr: "name", key: "date" },
      { attr: "itemprop", key: "datePublished" },
    ]) ?? extractTimeDatetime(head);
  const author = meta([
    { attr: "property", key: "article:author" },
    { attr: "name", key: "author" },
    { attr: "name", key: "DC.creator" },
    { attr: "name", key: "dc.creator" },
    { attr: "property", key: "og:article:author" },
  ]);
  const og_type = meta([{ attr: "property", key: "og:type" }]);
  const site_name = meta([
    { attr: "property", key: "og:site_name" },
    { attr: "name", key: "application-name" },
  ]);
  const faviconHref = extractFavicon(head);
  const favicon = faviconHref ? resolveUrl(faviconHref, finalUrl) : null;
  return { published_at: published, author, og_type, site_name, favicon };
}

function extractTimeDatetime(head: string): string | null {
  const m = head.match(
    /<time[^>]+(?:itemprop\s*=\s*["']datePublished["'][^>]+)?datetime\s*=\s*["']([^"']+)["']/i
  );
  return m?.[1]?.trim() ?? null;
}

function extractFavicon(head: string): string | null {
  const candidates = [
    /<link[^>]+rel\s*=\s*["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*href\s*=\s*["']([^"']+)["']/i,
    /<link[^>]+href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["'](?:icon|shortcut icon|apple-touch-icon)["']/i,
  ];
  for (const re of candidates) {
    const m = head.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

function wordCountOf(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

interface ReadabilityArticle {
  title: string | null;
  content: string | null;
  textContent: string | null;
  byline: string | null;
  excerpt: string | null;
  lang: string | null;
}
