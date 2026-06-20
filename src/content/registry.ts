/**
 * Content registry — the single enumeration of every static prose surface that
 * the Lever B pipeline (TOKEN_ECONOMICS_AND_SAVINGS §11.3) knows about, with one
 * `compress` flag each. The compress build step and the CI guard both iterate
 * this list, so "what is compressible" is defined in exactly one place.
 *
 * Two classes:
 *   - Compressible prose (`compress:true`) — the contract-teaching block and the
 *     skill bodies, whose raw text lives in `instructions.json` / `skills.json`.
 *   - Excluded surfaces (`compress:false`) — every tool description, read live
 *     from `TIER_ENTRIES` (still the single source in `tool-descriptions.ts`,
 *     never copied). They are listed here only so the guard can prove the
 *     compressor never touched them (the §7 hard exclusion).
 *
 * @sem domain=config role=content-registry
 */

import { TIER_ENTRIES } from "../proxy/tool-descriptions.js";
import instructionsRaw from "./instructions.json" with { type: "json" };
import skillsRaw from "./skills.json" with { type: "json" };

/** One static prose surface plus whether the compressor may process it. */
export interface ContentEntry {
  /** Stable id — also the key in `compressed.json` and the `loadContent` arg. */
  readonly id: string;
  /** Verbatim source prose. */
  readonly raw: string;
  /** When false the compressor MUST skip it (tool descriptions + protocol text). */
  readonly compress: boolean;
}

/** Raw prose for the compressible ids, merged from the two source JSON files. */
export const RAW_PROSE: Record<string, string> = {
  ...(instructionsRaw as Record<string, string>),
  ...(skillsRaw as Record<string, string>),
};

/**
 * Enumerate every content surface — compressible prose first, then the
 * `compress:false` tool descriptions read live from `TIER_ENTRIES`. The build
 * step compresses the `compress:true` entries; the guard asserts none of the
 * `compress:false` ids was compressed.
 *
 * @sem domain=config role=content-registry
 */
export function allContentEntries(): ContentEntry[] {
  const out: ContentEntry[] = [];
  for (const [id, raw] of Object.entries(RAW_PROSE)) {
    out.push({ id, raw, compress: true });
  }
  for (const [name, entry] of Object.entries(TIER_ENTRIES)) {
    out.push({ id: `tool:${name}:active`, raw: entry.active, compress: false });
    if (entry.tier !== 1) {
      out.push({
        id: `tool:${name}:locked`,
        raw: entry.locked,
        compress: false,
      });
      if (entry.unlocked) {
        out.push({
          id: `tool:${name}:unlocked`,
          raw: entry.unlocked,
          compress: false,
        });
      }
    }
  }
  return out;
}

/** Just the ids the compressor is allowed to process (compress:true). */
export function compressibleIds(): string[] {
  return Object.keys(RAW_PROSE);
}
