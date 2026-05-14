/**
 * Pre-strategy redaction — runs BEFORE classification so every strategy
 * sees normalized input. Strips boilerplate that survives ANSI strip and
 * has no semantic value to a coding agent.
 *
 * Token wins are small per-rule but stack across every shell call:
 * absolute home paths → ~, long hashes → <sha>, ISO timestamps → <ts>,
 * surviving CSI/OSC cursor codes that the basic ANSI strip missed.
 */

import { homedir } from "node:os";

export interface RedactRule {
  pattern: RegExp;
  replacement: string;
}

const HOME = (() => {
  try {
    return homedir();
  } catch {
    return "";
  }
})();

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Built-in redactors. Order matters — longer/more-specific patterns first.
 */
const BUILTIN_RULES: RedactRule[] = [
  // Home directory → ~ (only the literal home, not arbitrary user paths)
  ...(HOME
    ? [{ pattern: new RegExp(escapeRegex(HOME), "g"), replacement: "~" }]
    : []),

  // ISO timestamps — keep the date but compress time portion
  // 2026-05-13T14:32:01.123Z → <ts>
  {
    pattern:
      /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
    replacement: "<ts>",
  },

  // Long full-line UUIDs
  {
    pattern:
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    replacement: "<uuid>",
  },

  // 40-char or 64-char hex digests (sha1/sha256) — keep first 7
  {
    pattern: /\b([0-9a-f]{7})[0-9a-f]{33,57}\b/gi,
    replacement: "$1…",
  },

  // Surviving CSI cursor movement / scroll region codes that the basic
  // ANSI stripper missed (rare but real on Windows-style output)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control codes by design
  { pattern: /\x1b\][^\x07\x1b]*\x1b?\\?/g, replacement: "" },

  // npm/pip progress carriage returns that don't survive ANSI strip cleanly
  { pattern: /\r(?!\n)/g, replacement: "\n" },
];

/**
 * Apply default + user redactors to raw output. Idempotent. Cheap.
 */
export function redactOutput(raw: string, extra?: RedactRule[]): string {
  if (!raw) return raw;
  let s = raw;
  for (const r of BUILTIN_RULES) {
    s = s.replace(r.pattern, r.replacement);
  }
  if (extra && extra.length > 0) {
    for (const r of extra) {
      s = s.replace(r.pattern, r.replacement);
    }
  }
  return s;
}

/**
 * Expose builtin rules so the filter-DSL loader (R3) can merge user
 * rules with the same shape.
 */
export function getBuiltinRedactRules(): readonly RedactRule[] {
  return BUILTIN_RULES;
}
