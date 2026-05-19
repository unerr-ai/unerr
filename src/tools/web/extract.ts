/**
 * Main-content extraction for fetched HTML.
 *
 * Pipeline: Defuddle (primary) → @mozilla/readability (fallback) → raw <body>.
 * jsdom/defuddle/readability are lazy-loaded so they don't bloat startup.
 */

export interface ExtractedContent {
  title: string;
  contentHtml: string;
  wordCount: number;
  byline?: string;
  excerpt?: string;
  lang?: string;
  extractor: "defuddle" | "readability" | "raw-body";
}

const MIN_USEFUL_CHARS = 200;

export async function extractMainContent(
  html: string,
  baseUrl: string
): Promise<ExtractedContent> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(html, { url: baseUrl });

  const defuddled = await tryDefuddle(dom);
  if (defuddled && stripTags(defuddled.contentHtml).length >= MIN_USEFUL_CHARS) {
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

async function tryDefuddle(
  dom: import("jsdom").JSDOM
): Promise<ExtractedContent | null> {
  try {
    const mod = (await import("defuddle")) as unknown as {
      default: new (
        doc: Document,
        opts?: { markdown?: boolean }
      ) => { parse(): { content: string | null; title?: string; description?: string; author?: string; wordCount?: number } };
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
