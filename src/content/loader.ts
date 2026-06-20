/**
 * Content loader — the single read path for static prose surfaces (Lever B,
 * TOKEN_ECONOMICS_AND_SAVINGS §11.3 B4). Raw prose lives in
 * `instructions.json` / `skills.json`; the LLMLingua-compressed variants live in
 * the committed `compressed.json`. Both are bundled into `dist/cli.js`, so
 * loading never touches the filesystem and a missing compressed entry falls back
 * to raw rather than failing.
 *
 * `loadContent` returns the compressed text only when `UNERR_LLMLINGUA` is on AND
 * a non-empty compressed entry exists; otherwise the raw text — the A/B toggle.
 * The flag is read per call (cheap), so module-level consts that call this once
 * at import resolve against the flag state at process start.
 *
 * @sem domain=config role=content-loader
 */

import { isEnabled } from "../config/feature-flags.js";
import compressedData from "./compressed.json" with { type: "json" };
import { RAW_PROSE } from "./registry.js";

interface CompressedEntry {
  compressed: string;
  ratio: number;
  method: string;
}

const COMPRESSED = compressedData as Record<string, CompressedEntry>;

/**
 * Return the prose for `id` — compressed when `UNERR_LLMLINGUA` is on and a
 * compressed variant exists, else the raw source text. Throws on an unknown id
 * (a content-key typo is a build-time bug, never silently empty).
 *
 * @sem domain=config role=content-loader
 */
export function loadContent(id: string): string {
  const raw = RAW_PROSE[id];
  if (raw === undefined) {
    throw new Error(`loadContent: unknown content id "${id}"`);
  }
  if (isEnabled("UNERR_LLMLINGUA")) {
    const c = COMPRESSED[id];
    if (c && typeof c.compressed === "string" && c.compressed.length > 0) {
      return c.compressed;
    }
  }
  return raw;
}

/** The compressed-variant map (id → {compressed, ratio, method}); for the guard. */
export function compressedEntries(): Readonly<Record<string, CompressedEntry>> {
  return COMPRESSED;
}
