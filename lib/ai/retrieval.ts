import { source } from "@/lib/source";

/**
 * Picks the docs pages most relevant to a user question and turns them into a
 * bounded context block for the model. Ranking is naive keyword overlap — good
 * enough for a small docs set and needs no embeddings or external index.
 *
 * @sem domain=docs-ai role=retrieval
 */

/** One ranked docs page plus the slice of text injected into the prompt. */
export interface RetrievedDoc {
  title: string;
  url: string;
  description: string;
  /** First chunk of processed markdown, capped per page. */
  snippet: string;
  score: number;
}

const TOP_K = 5;
const MAX_SNIPPET_CHARS = 1200;
const MAX_CONTEXT_CHARS = 8000;
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "how",
  "what",
  "why",
  "when",
  "do",
  "does",
  "can",
  "i",
  "you",
  "it",
  "this",
  "that",
  "my",
  "me",
]);

/** Lowercase word tokens with stop-words and 1-char noise removed. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Rank docs pages by keyword overlap with `query` and return the top matches,
 * each with a short text snippet. Reads processed markdown lazily and only for
 * the candidate pages we keep.
 *
 * @sem domain=docs-ai role=retrieval
 */
export async function retrieveDocs(query: string): Promise<RetrievedDoc[]> {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return [];

  const pages = source.getPages();

  // Score against title + description + url first (cheap, no markdown read).
  const ranked = pages
    .map((page) => {
      const haystack = `${page.data.title ?? ""} ${page.data.description ?? ""} ${page.url}`;
      const tokens = tokenize(haystack);
      let score = 0;
      for (const token of tokens) {
        if (queryTokens.has(token)) score += 1;
      }
      // Title matches count double.
      const titleTokens = tokenize(page.data.title ?? "");
      for (const token of titleTokens) {
        if (queryTokens.has(token)) score += 1;
      }
      return { page, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  const results: RetrievedDoc[] = [];
  let totalChars = 0;

  for (const { page, score } of ranked) {
    let snippet = "";
    try {
      const processed = await page.data.getText("processed");
      snippet = processed.slice(0, MAX_SNIPPET_CHARS).trim();
    } catch {
      // If processed text is unavailable, fall back to the description.
      snippet = (page.data.description ?? "").slice(0, MAX_SNIPPET_CHARS);
    }

    if (totalChars + snippet.length > MAX_CONTEXT_CHARS) {
      snippet = snippet.slice(0, Math.max(0, MAX_CONTEXT_CHARS - totalChars));
    }
    totalChars += snippet.length;

    results.push({
      title: page.data.title ?? page.url,
      url: page.url,
      description: page.data.description ?? "",
      snippet,
      score,
    });

    if (totalChars >= MAX_CONTEXT_CHARS) break;
  }

  return results;
}

/**
 * Format ranked docs into a system-prompt context block the model can cite.
 *
 * @sem domain=docs-ai role=retrieval
 */
export function buildContextBlock(docs: RetrievedDoc[]): string {
  if (docs.length === 0) {
    return "No matching docs pages were found for this question.";
  }
  return docs
    .map((doc, i) => {
      const head = `[${i + 1}] ${doc.title} — ${doc.url}`;
      const desc = doc.description ? `\n${doc.description}` : "";
      const body = doc.snippet ? `\n${doc.snippet}` : "";
      return `${head}${desc}${body}`;
    })
    .join("\n\n---\n\n");
}
