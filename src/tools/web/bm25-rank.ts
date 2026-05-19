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

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "of", "and", "or", "but", "in", "on", "at", "to", "for", "with", "by",
  "from", "up", "down", "out", "off", "over", "under", "as", "this", "that",
  "these", "those", "it", "its", "into", "if", "then", "do", "does", "did",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export async function rankPassagesByPrompt(
  passages: Passage[],
  opts: RankOptions
): Promise<Passage[]> {
  const prompt = opts.prompt?.trim();
  if (!prompt || passages.length === 0) return passages;
  const promptTokens = tokenize(prompt);
  if (promptTokens.length === 0) return passages;

  // @ts-expect-error -- wink-bm25-text-search ships no type declarations
  const mod = (await import("wink-bm25-text-search")) as unknown as {
    default: () => BM25Engine;
  };
  const engine = mod.default();
  engine.defineConfig({ fldWeights: { text: 1, heading: 2 } });
  engine.definePrepTasks([tokenize]);

  for (const p of passages) {
    engine.addDoc(
      { text: p.text, heading: p.heading ?? "" },
      String(p.index)
    );
  }
  engine.consolidate();

  const hits = engine.search(prompt) as Array<[string, number]>;
  if (hits.length === 0) return passages;

  const topK = Math.max(1, opts.topK ?? Math.min(20, passages.length));
  const ranked: Passage[] = [];
  const seen = new Set<number>();
  for (const [docId] of hits.slice(0, topK)) {
    const idx = Number(docId);
    const p = passages.find((x) => x.index === idx);
    if (p && !seen.has(idx)) {
      ranked.push(p);
      seen.add(idx);
    }
  }
  if (ranked.length === 0) return passages;
  return ranked;
}

interface BM25Engine {
  definePrepTasks(tasks: Array<(s: string) => string[]>): void;
  defineConfig(cfg: { fldWeights: Record<string, number> }): void;
  addDoc(doc: Record<string, string>, id: string): void;
  consolidate(): void;
  search(query: string): Array<[string, number]>;
}
