/**
 * Prompt-aware BM25 passage ranking.
 *
 * Gated on payload size: when the joined passage text would exceed the wire
 * cap budget, we re-rank passages by relevance to the caller's prompt and
 * return the top-k. Lexical BM25 (wink-bm25-text-search) — no embeddings.
 *
 * Empty prompt → returns passages in original order, untouched.
 */

import type { Passage } from "./passage-split.js";

export interface RankOptions {
  prompt: string;
  topK?: number;
}

const MIN_RANKABLE_TEXT_CHARS = 150;
const MAX_LINK_DENSITY = 0.4;
const HEADING_WEIGHT = 1.2;
const TEXT_WEIGHT = 1.0;
const MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\([^)]+\)/g;
const BM25_MIN_CORPUS_SIZE = 3;

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "of",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "by",
  "from",
  "up",
  "down",
  "out",
  "off",
  "over",
  "under",
  "as",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "into",
  "if",
  "then",
  "do",
  "does",
  "did",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function linkDensity(text: string): number {
  if (text.length === 0) return 0;
  const links = text.match(MARKDOWN_LINK_PATTERN);
  if (!links) return 0;
  const linkBytes = links.reduce((sum, link) => sum + link.length, 0);
  return linkBytes / text.length;
}

function isProseCandidate(passage: Passage): boolean {
  if (passage.text.length < MIN_RANKABLE_TEXT_CHARS) return false;
  if (linkDensity(passage.text) > MAX_LINK_DENSITY) return false;
  return true;
}

export async function rankPassagesByPrompt(
  passages: Passage[],
  opts: RankOptions
): Promise<Passage[]> {
  const prompt = opts.prompt?.trim();
  if (!prompt || passages.length === 0) return passages;
  const promptTokens = tokenize(prompt);
  if (promptTokens.length === 0) return passages;

  const prose = passages.filter(isProseCandidate);
  const candidates = prose.length > 0 ? prose : passages;
  const topK = Math.max(1, opts.topK ?? Math.min(20, candidates.length));

  if (candidates.length < BM25_MIN_CORPUS_SIZE) {
    return candidates.slice(0, topK);
  }

  // @ts-expect-error -- wink-bm25-text-search ships no type declarations
  const mod = (await import("wink-bm25-text-search")) as unknown as {
    default: () => BM25Engine;
  };
  const engine = mod.default();
  engine.defineConfig({
    fldWeights: { text: TEXT_WEIGHT, heading: HEADING_WEIGHT },
  });
  engine.definePrepTasks([tokenize]);

  for (const p of candidates) {
    engine.addDoc({ text: p.text, heading: p.heading ?? "" }, String(p.index));
  }
  engine.consolidate();

  const hits = engine.search(prompt) as Array<[string, number]>;
  // When BM25 returns no hits (rare-term prompt on a heavily-nav page),
  // return the prose-filtered candidates rather than the original passage
  // list — keeps chrome out even when ranking is uninformative.
  if (hits.length === 0) return candidates.slice(0, topK);

  const ranked: Passage[] = [];
  const seen = new Set<number>();
  for (const [docId] of hits.slice(0, topK)) {
    const idx = Number(docId);
    const p = candidates.find((x) => x.index === idx);
    if (p && !seen.has(idx)) {
      ranked.push(p);
      seen.add(idx);
    }
  }
  if (ranked.length === 0) return candidates.slice(0, topK);
  return ranked;
}

interface BM25Engine {
  definePrepTasks(tasks: Array<(s: string) => string[]>): void;
  defineConfig(cfg: { fldWeights: Record<string, number> }): void;
  addDoc(doc: Record<string, string>, id: string): void;
  consolidate(): void;
  search(query: string): Array<[string, number]>;
}
