/**
 * Token Estimation Engine — real BPE counting with a heuristic fallback.
 *
 * Primary path: `gpt-tokenizer` (o200k_base) — pure-JS, NO .wasm blob, so it
 * respects CLAUDE.md tarball rule #8 (the base64/packaged-binary scanner
 * heuristics that flagged 0.1.6). The bare `gpt-tokenizer` export resolves to
 * o200k_base in v3 (verified by probe). It is loaded lazily and synchronously
 * via `createRequire` the first time a count is needed, then cached, so the
 * public API stays synchronous (no async cascade) and boot pays nothing until
 * the first count — or until `warmTokenizer()` is called at proxy startup.
 *
 * Cross-model caveat: Claude's tokenizer is proprietary. o200k_base is exact
 * for GPT-4o/4.1/o-series and a cross-model APPROXIMATION for Claude
 * (~±5–10% on prose, wider on code/CJK) — still far better than the old
 * bytes/4-style heuristic.
 *
 * Fallback path (encoder unavailable / throws / input too large): a 4-rule
 * char heuristic.
 *   1. Whitespace is cheap (~0.25 tokens per whitespace char)
 *   2. Code tokens ≈ chars / 3.5 (identifiers split on boundaries)
 *   3. English prose ≈ chars / 4 (natural language words)
 *   4. JSON/structured ≈ chars / 3 (many delimiters = more tokens)
 */
import { createRequire } from "node:module";

// Lazy, cached real-counter handle.
//   undefined = not yet attempted, null = attempted and unavailable (heuristic).
let countFn: ((text: string) => number) | null | undefined;

function getCounter(): ((text: string) => number) | null {
  if (countFn !== undefined) return countFn;
  try {
    const require = createRequire(import.meta.url);
    const mod = require("gpt-tokenizer") as {
      countTokens?: (t: string) => number;
      default?: { countTokens?: (t: string) => number };
    };
    const fn = mod.countTokens ?? mod.default?.countTokens ?? null;
    countFn = typeof fn === "function" ? fn : null;
  } catch {
    countFn = null;
  }
  return countFn;
}

/**
 * Above this char length we skip BPE and use the heuristic, so a single large
 * response can't blow the <5ms budget. ~50k chars ≈ a large file read.
 */
const LARGE_INPUT_CHARS = 50_000;

/**
 * Warm the tokenizer at proxy startup so the first real token count doesn't pay
 * the one-time BPE-rank load (~2 MB JSON). Safe to call repeatedly; no-op if the
 * encoder is unavailable. Synchronous and cheap once cached.
 */
export function warmTokenizer(): void {
  const count = getCounter();
  try {
    count?.("warm");
  } catch {
    /* ignore — first real count will fall back to the heuristic */
  }
}

/** Diagnostic/test hook: true once the real tokenizer is active. */
export function isTokenizerReady(): boolean {
  return getCounter() !== null;
}

type ContentType = "code" | "prose" | "json" | "mixed";

const CHARS_PER_TOKEN: Record<ContentType, number> = {
  code: 3.5,
  prose: 4.0,
  json: 3.0,
  mixed: 3.7,
};

function detectContentType(text: string): ContentType {
  if (text.length === 0) return "mixed";

  const sample = text.slice(0, 2000);
  const lines = sample.split("\n");

  const trimmed = sample.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return "json";
  }

  const braceCount = (sample.match(/[{}()[\];=><]/g) ?? []).length;
  const wordCount = (sample.match(/\b\w+\b/g) ?? []).length;
  const codeIndicators = (
    sample.match(
      /\b(function|const|let|var|class|import|export|return|if|for|while|async|await|type|interface|def|fn)\b/g
    ) ?? []
  ).length;

  if (codeIndicators > 3 || braceCount > wordCount * 0.15) return "code";
  if (braceCount < 5 && lines.length < sample.length / 60) return "prose";
  return "mixed";
}

/**
 * Heuristic char-ratio token count — fallback when the real tokenizer is
 * unavailable or the input exceeds LARGE_INPUT_CHARS. Within ~10% for typical
 * code and prose.
 */
function heuristicTokenCount(text: string): number {
  const contentType = detectContentType(text);
  const ratio = CHARS_PER_TOKEN[contentType];

  const whitespaceCount = (text.match(/\s/g) ?? []).length;
  const nonWhitespaceCount = text.length - whitespaceCount;

  const whitespaceTokens = whitespaceCount * 0.25;
  const contentTokens = nonWhitespaceCount / ratio;

  return Math.ceil(whitespaceTokens + contentTokens);
}

/**
 * Estimate token count for a string. Uses the real BPE tokenizer
 * (gpt-tokenizer / o200k_base) when available and the input is within
 * LARGE_INPUT_CHARS; otherwise falls back to the char-ratio heuristic.
 */
export function estimateTokenCount(text: string): number {
  if (!text || text.length === 0) return 0;

  if (text.length <= LARGE_INPUT_CHARS) {
    const count = getCounter();
    if (count) {
      try {
        return count(text);
      } catch {
        // fall through to heuristic on any encoder error
      }
    }
  }

  return heuristicTokenCount(text);
}

/**
 * Estimate tokens for any value (string, object, array, etc.)
 */
export function estimateTokens(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return estimateTokenCount(text);
}
